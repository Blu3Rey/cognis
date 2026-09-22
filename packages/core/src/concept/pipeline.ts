/**
 * The linking pipeline.
 *
 *   chunk -> spot -> generate candidates -> disambiguate -> anchor or NIL
 *         -> write mentions -> apply user overrides
 *
 * See docs/04-concept-identity.md. Every step after spotting is scoped by
 * `producer_version`, so a relink is a bounded delete-and-recompute that never
 * touches an attested row and never moves a concept id.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { VocabularyClient, ConceptCandidate } from '../ports/vocabulary.js';
import type { Linker, SpottedMention, LinkDecision } from '../ports/linker.js';
import type { Ulid } from '../types.js';
import { ulid } from '../ids.js';
import { spotMentions, SPOTTER_VERSION } from './spotter.js';
import type { SpotOptions } from './spotter.js';
import { loadOverrides, applyOverrides, resolveConceptId } from './overrides.js';
import { withEgress, isSourcePrivate } from '../privacy/egress.js';
import { redactText } from '../privacy/redact.js';

export const LINKER_PIPELINE_VERSION = `spotter-${SPOTTER_VERSION}/pipeline-1.0.0`;

export interface LinkOptions extends SpotOptions {
  /** Candidates retrieved per surface form. */
  candidatesPerForm?: number;
  /**
   * Below this confidence a decision becomes NIL rather than an anchor.
   * Over-eager anchoring is how a graph fills with wrong nodes, and a wrong
   * anchor is much harder to notice than a missing one.
   */
  minConfidence?: number;
  /** Create `local:` concepts for NIL decisions. */
  createLocalConcepts?: boolean;
}

export interface LinkReport {
  documentVersionId: Ulid;
  /** True when the source is private, so nothing was sent anywhere. */
  skippedPrivate: boolean;
  chunksProcessed: number;
  spotted: number;
  anchored: number;
  nil: number;
  localCreated: number;
  mentionsWritten: number;
  overrides: { removed: number; forced: number; remapped: number };
}

async function ensureConcept(
  db: SqlDriver,
  clock: Clock,
  candidate: ConceptCandidate,
): Promise<void> {
  await db.run(
    `INSERT INTO concept (id, scheme, label, description, aliases_json, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       label = excluded.label,
       description = excluded.description,
       aliases_json = excluded.aliases_json`,
    [
      candidate.id, candidate.scheme, candidate.label, candidate.description,
      JSON.stringify(candidate.aliases), clock.now(),
    ],
  );
}

/** Stable key for a local concept, so the same term does not fork every run. */
export function localKeyFor(surfaceForm: string): string {
  const normalised = surfaceForm
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `local:${normalised}`;
}

async function ensureLocalConcept(
  db: SqlDriver,
  clock: Clock,
  surfaceForm: string,
): Promise<string> {
  const id = localKeyFor(surfaceForm);
  await db.run(
    `INSERT INTO concept (id, scheme, label, description, aliases_json, resolved_at)
     VALUES (?, 'local', ?, NULL, NULL, ?)
     ON CONFLICT (id) DO NOTHING`,
    [id, surfaceForm, clock.now()],
  );
  return id;
}

/** Link one document version. */
export async function linkDocument(
  db: SqlDriver,
  clock: Clock,
  vocabulary: VocabularyClient,
  linker: Linker,
  documentVersionId: Ulid,
  opts: LinkOptions = {},
): Promise<LinkReport> {
  const candidatesPerForm = opts.candidatesPerForm ?? 8;
  const minConfidence = opts.minConfidence ?? 0.55;
  const createLocal = opts.createLocalConcepts ?? true;

  const owner = await db.get<{ source_id: string; title: string | null }>(
    `SELECT dv.source_id AS source_id, s.title AS title
       FROM document_version dv JOIN source s ON s.id = dv.source_id
      WHERE dv.id = ?`,
    [documentVersionId],
  );
  if (!owner) throw new Error(`no such document version: ${documentVersionId}`);

  const emptyReport: LinkReport = {
    documentVersionId, skippedPrivate: true, chunksProcessed: 0, spotted: 0,
    anchored: 0, nil: 0, localCreated: 0, mentionsWritten: 0,
    overrides: { removed: 0, forced: 0, remapped: 0 },
  };

  // A private source is never assembled into a request. Linking degrades
  // gracefully and visibly rather than leaking (docs/09 § rule 2 and 6).
  if (await isSourcePrivate(db, owner.source_id)) return emptyReport;

  const chunks = await db.all<{
    id: string; text: string; section_path: string | null; start_char: number;
  }>(
    `SELECT id, text, section_path, start_char FROM chunk
      WHERE document_version_id = ? ORDER BY ordinal`,
    [documentVersionId],
  );
  const titleRow = { title: owner.title };

  const report: LinkReport = {
    documentVersionId,
    skippedPrivate: false,
    chunksProcessed: 0,
    spotted: 0,
    anchored: 0,
    nil: 0,
    localCreated: 0,
    mentionsWritten: 0,
    overrides: { removed: 0, forced: 0, remapped: 0 },
  };

  // Candidate generation happens outside the write transaction: it is network
  // I/O and must not hold a database lock.
  const perChunk: { chunkId: string; decisions: LinkDecision[] }[] = [];
  const candidateById = new Map<string, ConceptCandidate>();

  for (const chunk of chunks) {
    report.chunksProcessed++;
    const spots = spotMentions(chunk.text, opts);
    report.spotted += spots.length;
    if (spots.length === 0) continue;

    const mentions: SpottedMention[] = [];
    for (const spot of spots) {
      const candidates = await vocabulary.search(spot.surfaceForm, candidatesPerForm);
      for (const c of candidates) candidateById.set(c.id, c);
      mentions.push({
        surfaceForm: spot.surfaceForm,
        // Offsets are absolute in the document version, not chunk-relative:
        // evidence spans and citation anchoring depend on it.
        startChar: chunk.start_char + spot.startChar,
        endChar: chunk.start_char + spot.endChar,
        candidates,
      });
    }

    const redacted = redactText(chunk.text);
    const request = {
      chunkId: chunk.id,
      chunkText: redacted.value,
      sectionPath: chunk.section_path,
      documentTitle: titleRow.title,
      mentions,
    };

    const decisions = await withEgress(
      db, clock,
      {
        destination: 'model_proxy',
        purpose: 'link',
        sourceIds: [owner.source_id],
        bytesSent: JSON.stringify(request).length,
        redactions: redacted.redactions,
      },
      () => linker.disambiguate(request),
    );
    perChunk.push({ chunkId: chunk.id, decisions });
  }

  const overrides = await loadOverrides(db);

  await db.transaction(async () => {
    // Scoped rebuild of this document's mentions.
    await db.run(
      `DELETE FROM mention WHERE chunk_id IN
         (SELECT id FROM chunk WHERE document_version_id = ?)`,
      [documentVersionId],
    );

    for (const { chunkId, decisions } of perChunk) {
      for (const d of decisions) {
        let conceptId: string | null = null;

        if (d.conceptId && d.confidence >= minConfidence) {
          const candidate = candidateById.get(d.conceptId);
          if (candidate) {
            await ensureConcept(db, clock, candidate);
            conceptId = candidate.id;
            report.anchored++;
          }
        }

        if (!conceptId) {
          report.nil++;
          if (!createLocal) continue;
          const before = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM concept WHERE id = ?',
            [localKeyFor(d.surfaceForm)],
          );
          conceptId = await ensureLocalConcept(db, clock, d.surfaceForm);
          if ((before?.n ?? 0) === 0) report.localCreated++;
        }

        // Respect an existing merge at write time, so a relink lands on the
        // canonical concept rather than resurrecting a merged-away id.
        conceptId = resolveConceptId(overrides.merges, conceptId);

        await db.run(
          `INSERT INTO mention
             (id, chunk_id, concept_id, start_char, end_char, surface_form,
              confidence, is_primary, producer_version, model_id, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (chunk_id, concept_id, start_char, end_char) DO NOTHING`,
          [
            ulid(clock.nowMs()), chunkId, conceptId, d.startChar, d.endChar,
            d.surfaceForm, Math.max(0, Math.min(1, d.confidence)),
            d.isPrimary ? 1 : 0, LINKER_PIPELINE_VERSION,
            linker.modelId, linker.promptVersion,
          ],
        );
        report.mentionsWritten++;
      }
    }

    report.overrides = await applyOverrides(
      db, overrides, LINKER_PIPELINE_VERSION, () => ulid(clock.nowMs()),
    );
  });

  return report;
}

/** Link every document version. A relink is this, run again. */
export async function linkAll(
  db: SqlDriver,
  clock: Clock,
  vocabulary: VocabularyClient,
  linker: Linker,
  opts: LinkOptions = {},
): Promise<LinkReport[]> {
  // Private sources are excluded at the query, so a relink can never pick one
  // up even if a future call site forgets to check.
  const docs = await db.all<{ id: string }>(
    `SELECT dv.id AS id FROM document_version dv
       JOIN source s ON s.id = dv.source_id
      WHERE COALESCE(s.is_private, 0) = 0
      ORDER BY dv.id`,
  );
  const reports: LinkReport[] = [];
  for (const d of docs) {
    reports.push(await linkDocument(db, clock, vocabulary, linker, d.id, opts));
  }
  return reports;
}

/**
 * Import vocabulary hierarchy edges for the concepts in the corpus.
 *
 * This is what gives the taxonomy view a real hierarchy for free: no
 * clustering heuristic, no model, just the vocabulary's own relations.
 */
export async function importHierarchy(
  db: SqlDriver,
  clock: Clock,
  vocabulary: VocabularyClient,
): Promise<{ edges: number; ancestorsAdded: number }> {
  const concepts = await db.all<{ id: string }>(
    `SELECT id FROM concept WHERE scheme <> 'local' ORDER BY id`,
  );
  if (concepts.length === 0) return { edges: 0, ancestorsAdded: 0 };

  const { edges, concepts: nodes } = await vocabulary.hierarchy(
    concepts.map((c) => c.id),
  );
  let written = 0;
  let ancestors = 0;

  await db.transaction(async () => {
    // Materialise ancestors the user has never read about. They carry no
    // coverage row, so the taxonomy view renders them as holes — which is the
    // point of the view, not a side effect (docs/07 § View 2).
    for (const node of nodes) {
      const existing = await db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM concept WHERE id = ?', [node.id],
      );
      if ((existing?.n ?? 0) === 0) ancestors++;
      await ensureConcept(db, clock, node);
    }

    for (const e of edges) {
      await db.run(
        `INSERT INTO edge
           (id, from_concept, to_concept, relation, provenance, weight, producer_version)
         VALUES (?, ?, ?, ?, 'vocabulary', 1.0, ?)
         ON CONFLICT (from_concept, to_concept, relation, provenance) DO NOTHING`,
        [ulid(), e.from, e.to, e.relation, LINKER_PIPELINE_VERSION],
      );
      written++;
    }
  });

  return { edges: written, ancestorsAdded: ancestors };
}
