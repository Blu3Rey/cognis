/**
 * Quiz item generation and its groundedness gate.
 *
 * docs/05: "An item whose answer cannot be located in the corpus is not a hard
 * item, it is a defect." Groundedness is checkable automatically, so it gates
 * generation — a defective item never reaches the user.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type {
  ItemWriter, EvidenceSpan, GeneratedItem, RubricPoint,
} from '../ports/item-writer.js';
import type { Ulid } from '../types.js';
import { ulid } from '../ids.js';

export const ITEM_PIPELINE_VERSION = '1.0.0';

export interface GenerateItemsOptions {
  kinds?: readonly ('free_recall' | 'cloze' | 'application' | 'synthesis')[];
  maxItemsPerConcept?: number;
  /** Evidence spans gathered per concept. */
  maxEvidence?: number;
  /** Require evidence from this many distinct sources before generating. */
  minDistinctSources?: number;
}

export interface GenerateItemsReport {
  conceptsConsidered: number;
  conceptsSkipped: number;
  itemsGenerated: number;
  itemsRejected: number;
  rejections: { conceptId: string; reason: string }[];
}

/** Gather the spans that justify asking about a concept. */
export async function evidenceFor(
  db: SqlDriver,
  conceptId: string,
  limit: number,
): Promise<EvidenceSpan[]> {
  const rows = await db.all<{
    source_id: string; document_version_id: string; chunk_id: string;
    start_char: number; end_char: number; text: string; title: string | null;
  }>(
    `SELECT dv.source_id, dv.id AS document_version_id, c.id AS chunk_id,
            c.start_char, c.end_char, c.text, s.title
       FROM mention m
       JOIN chunk c ON c.id = m.chunk_id
       JOIN document_version dv ON dv.id = c.document_version_id
       JOIN source s ON s.id = dv.source_id
      WHERE m.concept_id = ?
      ORDER BY m.is_primary DESC, m.confidence DESC, c.id
      LIMIT ?`,
    [conceptId, limit],
  );
  return rows.map((r) => ({
    sourceId: r.source_id,
    documentVersionId: r.document_version_id,
    chunkId: r.chunk_id,
    startChar: r.start_char,
    endChar: r.end_char,
    text: r.text,
    sourceTitle: r.title,
  }));
}

export interface GroundednessResult {
  grounded: boolean;
  problems: string[];
}

/**
 * Validate that every rubric point is locatable in the corpus.
 *
 * Checks the citation resolves to a real document version, that the span is
 * within bounds and non-empty, and that the cited text is not vacuous. An item
 * failing any of these is rejected before storage.
 */
export async function validateGroundedness(
  db: SqlDriver,
  item: GeneratedItem,
): Promise<GroundednessResult> {
  const problems: string[] = [];

  if (item.expectedPoints.length === 0) {
    problems.push('no rubric points: nothing to grade against');
  }
  if (item.evidence.length === 0) {
    problems.push('no evidence spans');
  }

  for (const point of item.expectedPoints) {
    const doc = await db.get<{ text: string }>(
      'SELECT text FROM document_version WHERE id = ?',
      [point.citation.documentVersionId],
    );
    if (!doc) {
      problems.push(`point ${point.id}: cites unknown document version`);
      continue;
    }
    const { startChar, endChar } = point.citation;
    if (startChar < 0 || endChar > doc.text.length || endChar <= startChar) {
      problems.push(
        `point ${point.id}: citation [${startChar},${endChar}) is out of bounds ` +
          `for a ${doc.text.length}-character document`,
      );
      continue;
    }
    if (!doc.text.slice(startChar, endChar).trim()) {
      problems.push(`point ${point.id}: citation resolves to whitespace`);
    }
  }

  return { grounded: problems.length === 0, problems };
}

/** Generate and store items for one concept. */
export async function generateItemsForConcept(
  db: SqlDriver,
  clock: Clock,
  writer: ItemWriter,
  conceptId: string,
  opts: GenerateItemsOptions = {},
): Promise<{ generated: number; rejected: { reason: string }[] }> {
  // `synthesis` is included by default from M5: it needs two or more primary
  // sources, which the writer checks, and it is the item type no other product
  // can generate because no other product knows what else the user read.
  const kinds = opts.kinds ?? (['free_recall', 'cloze', 'synthesis'] as const);
  const maxItems = opts.maxItemsPerConcept ?? 3;
  const maxEvidence = opts.maxEvidence ?? 8;

  const concept = await db.get<{ label: string }>(
    'SELECT label FROM concept WHERE id = ?', [conceptId],
  );
  if (!concept) return { generated: 0, rejected: [{ reason: 'unknown concept' }] };

  const evidence = await evidenceFor(db, conceptId, maxEvidence);
  if (evidence.length === 0) {
    return { generated: 0, rejected: [{ reason: 'no evidence' }] };
  }

  const items = await writer.generate({
    conceptId,
    conceptLabel: concept.label,
    evidence,
    kinds,
    maxItems,
  });

  const rejected: { reason: string }[] = [];
  let generated = 0;

  for (const item of items) {
    const check = await validateGroundedness(db, item);
    if (!check.grounded) {
      rejected.push({ reason: check.problems.join('; ') });
      continue;
    }
    await db.run(
      `INSERT INTO quiz_item
         (id, concept_id, kind, prompt, expected_points_json, evidence_json,
          difficulty_hint, producer_version, model_id, prompt_version, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(clock.nowMs()), conceptId, item.kind, item.prompt,
        JSON.stringify(item.expectedPoints), JSON.stringify(item.evidence),
        item.difficultyHint ?? null, ITEM_PIPELINE_VERSION,
        writer.modelId, writer.promptVersion, clock.now(),
      ],
    );
    generated++;
  }

  return { generated, rejected };
}

/**
 * Generate items for concepts that have coverage and none yet.
 *
 * Prefers concepts the corpus actually covers: generating items for a concept
 * met once in passing produces questions the user has no basis to answer,
 * which is the fastest way to make them abandon reviewing.
 */
export async function generateItems(
  db: SqlDriver,
  clock: Clock,
  writer: ItemWriter,
  opts: GenerateItemsOptions = {},
): Promise<GenerateItemsReport> {
  const minSources = opts.minDistinctSources ?? 1;

  const concepts = await db.all<{ concept_id: string }>(
    `SELECT cv.concept_id
       FROM coverage cv
      WHERE cv.distinct_sources >= ?
        AND NOT EXISTS (
          SELECT 1 FROM quiz_item qi
           WHERE qi.concept_id = cv.concept_id AND qi.retired_at IS NULL
        )
      ORDER BY cv.primary_sources DESC, cv.distinct_sources DESC`,
    [minSources],
  );

  const report: GenerateItemsReport = {
    conceptsConsidered: concepts.length,
    conceptsSkipped: 0,
    itemsGenerated: 0,
    itemsRejected: 0,
    rejections: [],
  };

  for (const c of concepts) {
    const res = await generateItemsForConcept(db, clock, writer, c.concept_id, opts);
    report.itemsGenerated += res.generated;
    report.itemsRejected += res.rejected.length;
    if (res.generated === 0) report.conceptsSkipped++;
    for (const r of res.rejected) {
      report.rejections.push({ conceptId: c.concept_id, reason: r.reason });
    }
  }

  return report;
}

/** Retire an item. Soft, because reviews reference it. */
export async function retireItem(
  db: SqlDriver,
  clock: Clock,
  itemId: Ulid,
  reason: string,
): Promise<void> {
  await db.run(
    'UPDATE quiz_item SET retired_at = ?, retired_reason = ? WHERE id = ?',
    [clock.now(), reason, itemId],
  );
}

export function parseRubric(json: string): RubricPoint[] {
  return JSON.parse(json) as RubricPoint[];
}

export function parseEvidence(json: string): EvidenceSpan[] {
  return JSON.parse(json) as EvidenceSpan[];
}
