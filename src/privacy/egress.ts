/**
 * The egress chokepoint.
 *
 * docs/09-privacy-and-security.md makes two commitments this module exists to
 * keep:
 *
 *   1. "Every egress is logged, attested, and visible to the user."
 *   2. "Marking a source private excludes it from all egress permanently."
 *
 * And one about where the check belongs: "Private-flag and denylist checks in
 * the transport layer, not the caller — a new call site must not be able to
 * forget them."
 *
 * So enforcement is layered. Content-gathering queries exclude private sources
 * (`privateSourceFilter`), so private material is never assembled into a
 * request in the first place; and every port call that leaves the device goes
 * through `withEgress`, which refuses if a private source slipped through and
 * writes the log row BEFORE the request rather than after — a log written
 * afterwards is missing exactly the entries that matter, the ones where the
 * request crashed.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { EgressDestination, EgressPurpose, Ulid } from '../types.js';
import { ulid } from '../ids.js';
import type { Redaction } from './redact.js';

export class PrivateSourceError extends Error {
  constructor(readonly sourceIds: readonly string[]) {
    super(
      `refusing egress: ${sourceIds.length} source(s) are marked private ` +
        `(${sourceIds.slice(0, 3).join(', ')}${sourceIds.length > 3 ? ', …' : ''})`,
    );
    this.name = 'PrivateSourceError';
  }
}

/**
 * SQL fragment excluding private sources.
 *
 * Every query that gathers content destined for a model must include it. It is
 * a single exported constant so an audit is a grep rather than a reading of
 * every query.
 */
export const EXCLUDE_PRIVATE_SQL = 'COALESCE(s.is_private, 0) = 0';

export async function privateSourceIds(
  db: SqlDriver,
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM source WHERE id IN (${placeholders}) AND is_private = 1`,
    candidates,
  );
  return rows.map((r) => r.id);
}

export async function isSourcePrivate(db: SqlDriver, sourceId: string): Promise<boolean> {
  const row = await db.get<{ is_private: number }>(
    'SELECT is_private FROM source WHERE id = ?', [sourceId],
  );
  return row?.is_private === 1;
}

export interface EgressRequest {
  destination: EgressDestination;
  purpose: EgressPurpose;
  sourceIds: readonly string[];
  /** Payload size, for the user-visible log. */
  bytesSent: number;
  redactions?: readonly Redaction[];
}

export async function logEgress(
  db: SqlDriver,
  clock: Clock,
  req: EgressRequest,
): Promise<Ulid> {
  const id = ulid(clock.nowMs());
  await db.run(
    `INSERT INTO egress_log
       (id, occurred_at, destination, purpose, source_ids, bytes_sent, redactions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id, clock.now(), req.destination, req.purpose,
      JSON.stringify([...req.sourceIds]), Math.max(0, Math.round(req.bytesSent)),
      req.redactions?.length ? JSON.stringify(req.redactions) : null,
    ],
  );
  return id;
}

/**
 * Run `fn` as an egress: refuse if any source is private, log it, then call.
 *
 * The log is written before the request. A request that then fails still
 * appears in the log, which is the honest record — the user's question is
 * "what left this device", and an attempt that reached the network counts.
 */
export async function withEgress<T>(
  db: SqlDriver,
  clock: Clock,
  req: EgressRequest,
  fn: () => Promise<T>,
): Promise<T> {
  const blocked = await privateSourceIds(db, req.sourceIds);
  if (blocked.length > 0) throw new PrivateSourceError(blocked);

  await logEgress(db, clock, req);
  return fn();
}

export interface EgressEntry {
  id: string;
  occurredAt: string;
  destination: EgressDestination;
  purpose: EgressPurpose;
  sourceIds: string[];
  bytesSent: number;
  redactions: Redaction[] | null;
}

/** The user-visible log. docs/09 requires this be renderable in settings. */
export async function readEgressLog(
  db: SqlDriver,
  opts: { from?: string; limit?: number } = {},
): Promise<EgressEntry[]> {
  const rows = await db.all<{
    id: string; occurred_at: string; destination: string; purpose: string;
    source_ids: string; bytes_sent: number; redactions: string | null;
  }>(
    `SELECT * FROM egress_log
      WHERE (? IS NULL OR occurred_at >= ?)
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
    [opts.from ?? null, opts.from ?? '', opts.limit ?? 100],
  );

  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    destination: r.destination as EgressDestination,
    purpose: r.purpose as EgressPurpose,
    sourceIds: JSON.parse(r.source_ids) as string[],
    bytesSent: r.bytes_sent,
    redactions: r.redactions ? (JSON.parse(r.redactions) as Redaction[]) : null,
  }));
}

/** Aggregate view: what has left, by destination and purpose. */
export async function egressSummary(
  db: SqlDriver,
): Promise<{ destination: string; purpose: string; calls: number; bytes: number }[]> {
  return db.all<{ destination: string; purpose: string; calls: number; bytes: number }>(
    `SELECT destination, purpose, COUNT(*) AS calls, SUM(bytes_sent) AS bytes
       FROM egress_log GROUP BY destination, purpose ORDER BY bytes DESC`,
  );
}
