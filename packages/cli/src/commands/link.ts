/**
 * `cognis link` — resolve concepts and roll up coverage.
 *
 * This is the first command that spends money, so it reports what it spent and
 * refuses to touch a private source. It is also the command whose output
 * nobody should trust until the linker's precision has been measured against a
 * labelled set (docs/12 §2) — which is what `cognis eval link` is for, once
 * that set exists.
 */

import type { Cognis, LinkReport } from '@cognis/core';
import type { LinkerUsage } from '../adapters/claude-linker.js';
import { estimateCost } from '../adapters/claude-linker.js';

export interface LinkRunReport {
  documents: number;
  linked: number;
  skippedPrivate: number;
  failed: { documentVersionId: string; reason: string }[];
  mentions: number;
  anchored: number;
  nil: number;
  localConcepts: number;
  concepts: number;
  cost: ReturnType<typeof estimateCost>;
}

export async function linkCorpus(
  cognis: Cognis,
  usage: LinkerUsage[],
  opts: { all?: boolean; limit?: number } = {},
): Promise<LinkRunReport> {
  // Documents with no mentions yet, unless --all. Private sources are excluded
  // in SQL rather than by a check the caller could forget (docs/09).
  const docs = await cognis.db.all<{ id: string }>(
    `SELECT dv.id AS id
       FROM document_version dv
       JOIN source s ON s.id = dv.source_id
      WHERE COALESCE(s.is_private, 0) = 0
        AND (? = 1 OR NOT EXISTS (
              SELECT 1 FROM mention m
                JOIN chunk c ON c.id = m.chunk_id
               WHERE c.document_version_id = dv.id
            ))
      ORDER BY dv.id
      LIMIT ?`,
    [opts.all ? 1 : 0, opts.limit ?? 500],
  );

  const report: LinkRunReport = {
    documents: docs.length,
    linked: 0, skippedPrivate: 0, failed: [],
    mentions: 0, anchored: 0, nil: 0, localConcepts: 0, concepts: 0,
    cost: estimateCost([]),
  };

  for (const doc of docs) {
    try {
      const result: LinkReport = await cognis.linkDocument(doc.id);
      if (result.skippedPrivate) {
        report.skippedPrivate++;
        continue;
      }
      report.linked++;
      report.mentions += result.mentionsWritten;
      report.anchored += result.anchored;
      report.nil += result.nil;
      report.localConcepts += result.localCreated;
    } catch (err) {
      report.failed.push({
        documentVersionId: doc.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (report.linked > 0) {
    await cognis.importHierarchy();
    await cognis.rollupCoverage();
    await cognis.buildCooccurrence();
  }

  const conceptCount = await cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM concept',
  );
  report.concepts = conceptCount?.n ?? 0;
  report.cost = estimateCost(usage);
  return report;
}

export interface GapRow {
  conceptId: string;
  label: string;
  distinctSources: number;
  primarySources: number;
  temporalSpreadDays: number;
  lastContactAt: string | null;
}

/** The flagship query, as a command: what keeps coming up that you never read about. */
export async function coverageGaps(
  cognis: Cognis,
  opts: { minSources?: number; limit?: number; includeLocal?: boolean } = {},
): Promise<GapRow[]> {
  const gaps = await cognis.uncoveredButRecurring({
    minDistinctSources: opts.minSources ?? 2,
    maxPrimarySources: 0,
    limit: opts.limit ?? 25,
    includeLocal: opts.includeLocal ?? false,
  });
  return gaps.map((g) => ({
    conceptId: g.conceptId,
    label: g.label,
    distinctSources: g.distinctSources,
    primarySources: g.primarySources,
    temporalSpreadDays: g.temporalSpreadDays,
    lastContactAt: g.lastContactAt,
  }));
}

export interface ConceptRow {
  conceptId: string;
  label: string;
  scheme: string;
  distinctSources: number;
  primarySources: number;
  lastContactAt: string | null;
}

export async function topConcepts(
  cognis: Cognis,
  limit: number,
): Promise<ConceptRow[]> {
  const rows = await cognis.db.all<{
    concept_id: string; label: string; scheme: string;
    distinct_sources: number; primary_sources: number; last_contact_at: string | null;
  }>(
    `SELECT cv.concept_id, c.label, c.scheme, cv.distinct_sources,
            cv.primary_sources, cv.last_contact_at
       FROM coverage cv JOIN concept c ON c.id = cv.concept_id
      ORDER BY cv.primary_sources DESC, cv.distinct_sources DESC, c.label
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    conceptId: r.concept_id,
    label: r.label,
    scheme: r.scheme,
    distinctSources: r.distinct_sources,
    primarySources: r.primary_sources,
    lastContactAt: r.last_contact_at,
  }));
}
