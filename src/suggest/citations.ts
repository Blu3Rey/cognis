/**
 * Citation graph ingest and convergent-reference detection.
 *
 * The flagship signal: *five papers you have read all cite this one, and you
 * have never opened it* is a fact, not a guess, and it is exactly the blind
 * spot a reader cannot see unaided (docs/06 § Candidate sources).
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { ScholarGraph } from '../ports/scholar-graph.js';
import { logEgress } from '../privacy/egress.js';

export const CITATION_PIPELINE_VERSION = '1.0.0';

export interface CitationIngestReport {
  sourcesProcessed: number;
  worksRecorded: number;
  citationsRecorded: number;
  failures: { doi: string; reason: string }[];
}

async function upsertWork(
  db: SqlDriver,
  clock: Clock,
  doi: string,
  meta: {
    title?: string | null; authors?: string[]; publishedYear?: number | null;
    openAccess?: boolean; citedByCount?: number | null; sourceId?: string | null;
  } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO work
       (doi, title, authors_json, published_year, open_access, cited_by_count,
        source_id, fetched_at, producer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (doi) DO UPDATE SET
       title = COALESCE(excluded.title, work.title),
       authors_json = COALESCE(excluded.authors_json, work.authors_json),
       published_year = COALESCE(excluded.published_year, work.published_year),
       open_access = MAX(excluded.open_access, work.open_access),
       cited_by_count = COALESCE(excluded.cited_by_count, work.cited_by_count),
       source_id = COALESCE(excluded.source_id, work.source_id),
       fetched_at = excluded.fetched_at`,
    [
      doi, meta.title ?? null,
      meta.authors ? JSON.stringify(meta.authors) : null,
      meta.publishedYear ?? null,
      meta.openAccess ? 1 : 0,
      meta.citedByCount ?? null,
      meta.sourceId ?? null,
      clock.now(), CITATION_PIPELINE_VERSION,
    ],
  );
}

/**
 * Fetch references for every corpus source that has a DOI.
 *
 * Network work happens outside the write transaction. A DOI that fails to
 * resolve is recorded as a failure rather than dropped, so a metadata outage
 * is visible instead of silently shrinking the graph.
 */
export async function ingestCitations(
  db: SqlDriver,
  clock: Clock,
  scholar: ScholarGraph,
  opts: { limit?: number } = {},
): Promise<CitationIngestReport> {
  // A DOI is a small disclosure, but it is still a statement about what the
  // user reads, so a private source's DOI does not leave either.
  const sources = await db.all<{ id: string; doi: string }>(
    `SELECT id, doi FROM source AS s
      WHERE doi IS NOT NULL AND COALESCE(s.is_private, 0) = 0
      ORDER BY id LIMIT ?`,
    [opts.limit ?? 500],
  );

  const report: CitationIngestReport = {
    sourcesProcessed: 0,
    worksRecorded: 0,
    citationsRecorded: 0,
    failures: [],
  };

  const fetched: {
    doi: string; sourceId: string;
    meta: Awaited<ReturnType<ScholarGraph['metadata']>>;
    refs: string[];
  }[] = [];

  if (sources.length > 0) {
    await logEgress(db, clock, {
      destination: 'scholar_graph',
      purpose: 'metadata',
      sourceIds: sources.map((s) => s.id),
      bytesSent: sources.reduce((n, s) => n + s.doi.length, 0),
    });
  }

  for (const s of sources) {
    try {
      const meta = await scholar.metadata(s.doi);
      const refs = await scholar.references(s.doi);
      fetched.push({ doi: s.doi, sourceId: s.id, meta, refs });
      report.sourcesProcessed++;
    } catch (err) {
      report.failures.push({
        doi: s.doi,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Reference metadata is fetched separately so a cited work carries a title
  // and reachability, which the ranking needs.
  const referenced = new Set<string>();
  for (const f of fetched) for (const r of f.refs) referenced.add(r);

  const refMeta = new Map<string, Awaited<ReturnType<ScholarGraph['metadata']>>>();
  for (const doi of referenced) {
    try {
      refMeta.set(doi, await scholar.metadata(doi));
    } catch {
      refMeta.set(doi, null);
    }
  }

  await db.transaction(async () => {
    for (const f of fetched) {
      await upsertWork(db, clock, f.doi, {
        title: f.meta?.title ?? null,
        ...(f.meta?.authors ? { authors: f.meta.authors } : {}),
        publishedYear: f.meta?.publishedYear ?? null,
        openAccess: f.meta?.openAccess ?? false,
        citedByCount: f.meta?.citedByCount ?? null,
        sourceId: f.sourceId,
      });
      report.worksRecorded++;

      for (const ref of f.refs) {
        if (ref === f.doi) continue;
        const m = refMeta.get(ref) ?? null;
        await upsertWork(db, clock, ref, {
          title: m?.title ?? null,
          ...(m?.authors ? { authors: m.authors } : {}),
          publishedYear: m?.publishedYear ?? null,
          openAccess: m?.openAccess ?? false,
          citedByCount: m?.citedByCount ?? null,
        });
        await db.run(
          `INSERT INTO citation (from_doi, to_doi, producer_version)
           VALUES (?, ?, ?) ON CONFLICT (from_doi, to_doi) DO NOTHING`,
          [f.doi, ref, CITATION_PIPELINE_VERSION],
        );
        report.citationsRecorded++;
      }
    }

    // Link works the user already holds, so a previously-cited work that later
    // enters the corpus stops being suggested.
    await db.run(
      `UPDATE work SET source_id = (
         SELECT s.id FROM source s WHERE s.doi = work.doi
       ) WHERE source_id IS NULL AND EXISTS (
         SELECT 1 FROM source s WHERE s.doi = work.doi
       )`,
    );
  });

  return report;
}

export interface ConvergentReference {
  doi: string;
  title: string | null;
  publishedYear: number | null;
  openAccess: boolean;
  citedByCount: number | null;
  /** Corpus sources that cite it. The evidence to tap through to. */
  citingSourceIds: string[];
  citingCount: number;
}

/**
 * Works cited by several corpus sources that the user has never opened.
 *
 * `minCiting` defaults to 2 rather than 1 because a single citation is an
 * author's choice; several independent sources converging on one work is a
 * statement about the field.
 */
export async function convergentReferences(
  db: SqlDriver,
  opts: { minCiting?: number; limit?: number } = {},
): Promise<ConvergentReference[]> {
  const minCiting = opts.minCiting ?? 2;
  const limit = opts.limit ?? 25;

  const rows = await db.all<{
    doi: string; title: string | null; published_year: number | null;
    open_access: number; cited_by_count: number | null; citing_count: number;
  }>(
    `SELECT w.doi, w.title, w.published_year, w.open_access, w.cited_by_count,
            COUNT(DISTINCT c.from_doi) AS citing_count
       FROM citation c
       JOIN work w ON w.doi = c.to_doi
       JOIN work fw ON fw.doi = c.from_doi
      WHERE w.source_id IS NULL          -- not in the corpus: that is the gap
        AND fw.source_id IS NOT NULL     -- cited BY something the user read
      GROUP BY w.doi
     HAVING COUNT(DISTINCT c.from_doi) >= ?
      ORDER BY citing_count DESC, w.cited_by_count DESC
      LIMIT ?`,
    [minCiting, limit],
  );

  const out: ConvergentReference[] = [];
  for (const r of rows) {
    const citing = await db.all<{ source_id: string }>(
      `SELECT DISTINCT fw.source_id AS source_id
         FROM citation c JOIN work fw ON fw.doi = c.from_doi
        WHERE c.to_doi = ? AND fw.source_id IS NOT NULL`,
      [r.doi],
    );
    out.push({
      doi: r.doi,
      title: r.title,
      publishedYear: r.published_year,
      openAccess: r.open_access === 1,
      citedByCount: r.cited_by_count,
      citingSourceIds: citing.map((c) => c.source_id),
      citingCount: r.citing_count,
    });
  }
  return out;
}
