/**
 * Read-only commands: list, show, search, stats, doctor.
 *
 * Every one of these is available as `--json` because the CLI is also the
 * scripting surface for the evaluations, and because a human-readable table is
 * a bad interchange format.
 */

import type { Cognis } from '@cognis/core';

export interface CorpusStats {
  sources: number;
  events: number;
  documents: number;
  words: number;
  chunks: number;
  vectorsByModel: { modelId: string; vectors: number }[];
  concepts: number;
  mentions: number;
  privateSources: number;
  failedExtractions: number;
  egressCalls: number;
  egressBytes: number;
  firstCapture: string | null;
  lastCapture: string | null;
}

export async function corpusStats(cognis: Cognis): Promise<CorpusStats> {
  const one = async (sql: string): Promise<number> =>
    (await cognis.db.get<{ n: number }>(sql))?.n ?? 0;

  const vectors = await cognis.db.all<{ model_id: string; n: number }>(
    'SELECT model_id, COUNT(*) AS n FROM embedding_meta GROUP BY model_id ORDER BY n DESC',
  );
  const span = await cognis.db.get<{ first: string | null; last: string | null }>(
    'SELECT MIN(occurred_at) AS first, MAX(occurred_at) AS last FROM ingestion_event',
  );
  const egress = await cognis.db.get<{ calls: number; bytes: number }>(
    'SELECT COUNT(*) AS calls, COALESCE(SUM(bytes_sent), 0) AS bytes FROM egress_log',
  );

  return {
    sources: await one('SELECT COUNT(*) AS n FROM source'),
    events: await one('SELECT COUNT(*) AS n FROM ingestion_event'),
    documents: await one('SELECT COUNT(*) AS n FROM document_version'),
    words: await one('SELECT COALESCE(SUM(word_count), 0) AS n FROM document_version'),
    chunks: await one('SELECT COUNT(*) AS n FROM chunk'),
    vectorsByModel: vectors.map((v) => ({ modelId: v.model_id, vectors: v.n })),
    concepts: await one('SELECT COUNT(*) AS n FROM concept'),
    mentions: await one('SELECT COUNT(*) AS n FROM mention'),
    privateSources: await one('SELECT COUNT(*) AS n FROM source WHERE is_private = 1'),
    failedExtractions: await one(
      `SELECT COUNT(*) AS n FROM ingestion_event WHERE status = 'extraction_failed'`,
    ),
    egressCalls: egress?.calls ?? 0,
    egressBytes: egress?.bytes ?? 0,
    firstCapture: span?.first ?? null,
    lastCapture: span?.last ?? null,
  };
}

export interface SourceDetail {
  id: string;
  title: string | null;
  canonicalUrl: string | null;
  doi: string | null;
  kind: string;
  isPrivate: boolean;
  firstSeenAt: string;
  events: { occurredAt: string; capturePath: string; engagement: string | null; status: string; statusReason: string | null; novelty: number | null }[];
  documents: { id: string; wordCount: number; extractedAt: string; chunks: number }[];
  concepts: { conceptId: string; label: string; isPrimary: boolean }[];
}

export async function sourceDetail(
  cognis: Cognis,
  sourceId: string,
): Promise<SourceDetail | null> {
  const source = await cognis.getSource(sourceId);
  if (!source) return null;

  const events = await cognis.db.all<{
    occurred_at: string; capture_path: string; engagement: string | null;
    status: string; status_reason: string | null; novelty: number | null;
  }>(
    `SELECT occurred_at, capture_path, engagement, status, status_reason, novelty
       FROM ingestion_event WHERE source_id = ? ORDER BY occurred_at DESC`,
    [sourceId],
  );

  const documents = await cognis.db.all<{
    id: string; word_count: number; extracted_at: string; chunks: number;
  }>(
    `SELECT dv.id, dv.word_count, dv.extracted_at,
            (SELECT COUNT(*) FROM chunk c WHERE c.document_version_id = dv.id) AS chunks
       FROM document_version dv WHERE dv.source_id = ? ORDER BY dv.extracted_at DESC`,
    [sourceId],
  );

  const concepts = await cognis.db.all<{
    concept_id: string; label: string; is_primary: number;
  }>(
    `SELECT DISTINCT m.concept_id, c.label, MAX(m.is_primary) AS is_primary
       FROM mention m
       JOIN concept c ON c.id = m.concept_id
       JOIN chunk ch ON ch.id = m.chunk_id
       JOIN document_version dv ON dv.id = ch.document_version_id
      WHERE dv.source_id = ?
      GROUP BY m.concept_id
      ORDER BY is_primary DESC, c.label`,
    [sourceId],
  );

  return {
    id: source.id,
    title: source.title,
    canonicalUrl: source.canonicalUrl,
    doi: source.doi,
    kind: source.kind,
    isPrivate: source.isPrivate,
    firstSeenAt: source.firstSeenAt,
    events: events.map((e) => ({
      occurredAt: e.occurred_at,
      capturePath: e.capture_path,
      engagement: e.engagement,
      status: e.status,
      statusReason: e.status_reason,
      novelty: e.novelty,
    })),
    documents: documents.map((d) => ({
      id: d.id, wordCount: d.word_count, extractedAt: d.extracted_at, chunks: d.chunks,
    })),
    concepts: concepts.map((c) => ({
      conceptId: c.concept_id, label: c.label, isPrimary: c.is_primary === 1,
    })),
  };
}

export interface RecentRow {
  sourceId: string;
  title: string | null;
  url: string | null;
  occurredAt: string;
  status: string;
  engagement: string | null;
  novelty: number | null;
  isPrivate: boolean;
}

export async function recentCaptures(
  cognis: Cognis,
  limit: number,
): Promise<RecentRow[]> {
  const rows = await cognis.db.all<{
    source_id: string; title: string | null; canonical_url: string | null;
    occurred_at: string; status: string; engagement: string | null;
    novelty: number | null; is_private: number;
  }>(
    `SELECT e.source_id, s.title, s.canonical_url, e.occurred_at, e.status,
            e.engagement, e.novelty, s.is_private
       FROM ingestion_event e
       JOIN source s ON s.id = e.source_id
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    sourceId: r.source_id,
    title: r.title,
    url: r.canonical_url,
    occurredAt: r.occurred_at,
    status: r.status,
    engagement: r.engagement,
    novelty: r.novelty,
    isPrivate: r.is_private === 1,
  }));
}

export interface DoctorReport {
  checks: { name: string; ok: boolean; detail: string }[];
  ok: boolean;
}

/**
 * `cognis doctor` — answer "is this actually going to work" before the user
 * discovers otherwise halfway through ingesting a hundred articles.
 */
export async function doctor(
  cognis: Cognis,
  opts: { dbPath: string; modelDir: string; embedderKind: string },
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [];

  checks.push({
    name: 'database',
    ok: true,
    detail: opts.dbPath,
  });

  const migrations = await cognis.db.all<{ id: string }>(
    'SELECT id FROM schema_migration ORDER BY id',
  );
  checks.push({
    name: 'migrations',
    ok: migrations.length > 0,
    detail: `${migrations.length} applied (latest ${migrations[migrations.length - 1]?.id ?? 'none'})`,
  });

  if (!cognis.embedder) {
    checks.push({ name: 'embedder', ok: false, detail: 'none configured' });
  } else {
    let ok = true;
    let detail = `${cognis.embedder.modelId} (${opts.embedderKind})`;
    try {
      const [v] = await cognis.embedder.embed(['probe']);
      if (!v || v.length !== cognis.embedder.dim) {
        ok = false;
        detail += ` — returned ${v?.length ?? 0} dims, expected ${cognis.embedder.dim}`;
      } else {
        detail += ' — loaded and producing vectors';
      }
    } catch (err) {
      ok = false;
      detail += ` — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
    checks.push({ name: 'embedder', ok, detail });
  }

  const models = await cognis.db.all<{ model_id: string; n: number }>(
    'SELECT model_id, COUNT(*) AS n FROM embedding_meta GROUP BY model_id',
  );
  checks.push({
    name: 'vector consistency',
    ok: models.length <= 1,
    detail: models.length === 0
      ? 'no vectors yet'
      : models.length === 1
        ? `all ${models[0]!.n} vectors from ${models[0]!.model_id}`
        : `MIXED MODELS: ${models.map((m) => `${m.model_id} (${m.n})`).join(', ')} — ` +
          'novelty and search across these are meaningless; run `cognis reindex --all`',
  });

  return { checks, ok: checks.every((c) => c.ok) };
}
