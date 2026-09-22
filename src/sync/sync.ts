/**
 * Sync orchestration.
 *
 * Push: collect dirty attested rows, encrypt them as one batch, hand the
 * ciphertext to the relay. Pull: fetch batches, decrypt, merge row by row.
 *
 * Only attested rows travel. Derived data is recomputed on the receiving
 * device — cheaper than shipping float32 vectors over a phone connection, and
 * the reason the attested/derived split exists (ADR-0002).
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { SyncRelay } from '../ports/sync-relay.js';
import type { SyncCipher, SyncKeyset } from './crypto.js';
import { mergeRow, SYNCED_TABLES, APPLY_ORDER } from './merge.js';
import type { Row } from './merge.js';
import { ulid } from '../ids.js';

export const SYNC_PROTOCOL_VERSION = 1;

export interface SyncPayload {
  v: number;
  deviceId: string;
  createdAt: string;
  /** table name -> rows */
  rows: Record<string, Row[]>;
}

export interface PushReport {
  pushed: number;
  cursor: string | null;
  tables: Record<string, number>;
}

export interface PullReport {
  batches: number;
  applied: number;
  merged: number;
  deferred: number;
  skippedOwn: number;
  cursor: string | null;
}

async function ensureSyncState(
  db: SqlDriver,
  clock: Clock,
): Promise<{ deviceId: string; pullCursor: string | null; keyset: SyncKeyset | null }> {
  const row = await db.get<{
    device_id: string; pull_cursor: string | null; keyset_json: string | null;
  }>('SELECT device_id, pull_cursor, keyset_json FROM sync_state WHERE id = 1');

  if (row) {
    return {
      deviceId: row.device_id,
      pullCursor: row.pull_cursor,
      keyset: row.keyset_json ? (JSON.parse(row.keyset_json) as SyncKeyset) : null,
    };
  }

  const deviceId = ulid(clock.nowMs());
  await db.run(
    'INSERT INTO sync_state (id, device_id, pull_cursor) VALUES (1, ?, NULL)',
    [deviceId],
  );
  return { deviceId, pullCursor: null, keyset: null };
}

export async function saveKeyset(
  db: SqlDriver,
  clock: Clock,
  keyset: SyncKeyset,
): Promise<void> {
  await ensureSyncState(db, clock);
  await db.run('UPDATE sync_state SET keyset_json = ? WHERE id = 1', [
    JSON.stringify(keyset),
  ]);
}

export async function loadKeyset(db: SqlDriver): Promise<SyncKeyset | null> {
  const row = await db.get<{ keyset_json: string | null }>(
    'SELECT keyset_json FROM sync_state WHERE id = 1',
  );
  return row?.keyset_json ? (JSON.parse(row.keyset_json) as SyncKeyset) : null;
}

export async function deviceId(db: SqlDriver, clock: Clock): Promise<string> {
  return (await ensureSyncState(db, clock)).deviceId;
}

/** Push dirty attested rows as one encrypted batch. */
export async function push(
  db: SqlDriver,
  clock: Clock,
  relay: SyncRelay,
  cipher: SyncCipher,
): Promise<PushReport> {
  const state = await ensureSyncState(db, clock);

  const dirty = await db.all<{ table_name: string; row_id: string }>(
    'SELECT table_name, row_id FROM sync_dirty ORDER BY marked_at, table_name, row_id',
  );
  if (dirty.length === 0) {
    return { pushed: 0, cursor: null, tables: {} };
  }

  const byTable = new Map<string, string[]>();
  for (const d of dirty) {
    const list = byTable.get(d.table_name) ?? [];
    list.push(d.row_id);
    byTable.set(d.table_name, list);
  }

  const rows: Record<string, Row[]> = {};
  const tables: Record<string, number> = {};

  for (const spec of SYNCED_TABLES) {
    const ids = byTable.get(spec.name);
    if (!ids?.length) continue;
    const placeholders = ids.map(() => '?').join(', ');
    const fetched = await db.all<Row>(
      `SELECT * FROM ${spec.name} WHERE ${spec.key} IN (${placeholders})`,
      ids,
    );
    if (fetched.length > 0) {
      rows[spec.name] = fetched;
      tables[spec.name] = fetched.length;
    }
  }

  const total = Object.values(tables).reduce((a, b) => a + b, 0);
  if (total === 0) {
    await db.run('DELETE FROM sync_dirty');
    return { pushed: 0, cursor: null, tables: {} };
  }

  const payload: SyncPayload = {
    v: SYNC_PROTOCOL_VERSION,
    deviceId: state.deviceId,
    createdAt: clock.now(),
    rows,
  };
  const envelope = await cipher.encrypt(JSON.stringify(payload));
  const { cursor } = await relay.push(state.deviceId, envelope);

  await db.transaction(async () => {
    // Clear only what was actually sent. A row dirtied while the push was in
    // flight stays queued for the next one.
    for (const [table, ids] of byTable) {
      const placeholders = ids.map(() => '?').join(', ');
      await db.run(
        `DELETE FROM sync_dirty WHERE table_name = ? AND row_id IN (${placeholders})`,
        [table, ...ids],
      );
    }
    await db.run('UPDATE sync_state SET last_push_at = ? WHERE id = 1', [clock.now()]);
  });

  return { pushed: total, cursor, tables };
}

/** Pull and merge batches from other devices. */
export async function pull(
  db: SqlDriver,
  clock: Clock,
  relay: SyncRelay,
  cipher: SyncCipher,
  opts: { limit?: number } = {},
): Promise<PullReport> {
  const state = await ensureSyncState(db, clock);
  const batches = await relay.pull(state.pullCursor, opts.limit ?? 100);

  const report: PullReport = {
    batches: 0, applied: 0, merged: 0, deferred: 0, skippedOwn: 0,
    cursor: state.pullCursor,
  };
  if (batches.length === 0) return report;

  for (const batch of batches) {
    report.cursor = batch.cursor;

    if (batch.deviceId === state.deviceId) {
      report.skippedOwn++;
      continue;
    }

    const payload = JSON.parse(await cipher.decrypt(batch.envelope)) as SyncPayload;
    if (payload.v !== SYNC_PROTOCOL_VERSION) {
      throw new Error(
        `sync payload version ${payload.v}; this build speaks ${SYNC_PROTOCOL_VERSION}`,
      );
    }
    report.batches++;

    await db.transaction(async () => {
      const appliedHere: { table: string; id: string }[] = [];

      /**
       * Incoming source id -> local source id.
       *
       * Deterministic source ids mean this is almost always empty. It covers
       * the one case they do not: a source captured by URL on one device and
       * by DOI on another gets ids from different bases. The natural key still
       * identifies them as the same thing, so the local id wins and incoming
       * references are rewritten rather than colliding on the unique index.
       */
      const sourceRemap = new Map<string, string>();

      for (const incoming of payload.rows['source'] ?? []) {
        const incomingId = incoming['id'];
        if (typeof incomingId !== 'string') continue;
        const mine = await db.get<Row>('SELECT * FROM source WHERE id = ?', [incomingId]);
        if (mine) continue;

        const byKey = await db.get<Row>(
          `SELECT * FROM source
            WHERE (? IS NOT NULL AND doi = ?)
               OR (? IS NOT NULL AND canonical_url = ?)
            LIMIT 1`,
          [
            incoming['doi'] ?? null, incoming['doi'] ?? null,
            incoming['canonical_url'] ?? null, incoming['canonical_url'] ?? null,
          ],
        );
        if (byKey && typeof byKey['id'] === 'string' && byKey['id'] !== incomingId) {
          sourceRemap.set(incomingId, byKey['id']);
        }
      }

      for (const table of APPLY_ORDER) {
        const incoming = payload.rows[table];
        if (!incoming?.length) continue;
        const spec = SYNCED_TABLES.find((s) => s.name === table);
        if (!spec) continue;

        for (const original of incoming) {
          let theirs = original;

          // Rewrite references to a source this device knows under another id.
          if (table === 'source' && typeof theirs['id'] === 'string') {
            const local = sourceRemap.get(theirs['id']);
            if (local) theirs = { ...theirs, id: local };
          } else if (typeof theirs['source_id'] === 'string') {
            const local = sourceRemap.get(theirs['source_id']);
            if (local) theirs = { ...theirs, source_id: local };
          }

          const id = theirs[spec.key];
          if (typeof id !== 'string') continue;

          const mine = await db.get<Row>(
            `SELECT * FROM ${table} WHERE ${spec.key} = ?`, [id],
          );

          const row = mine ? mergeRow(table, mine, theirs) : theirs;
          const cols = Object.keys(row);
          const placeholders = cols.map(() => '?').join(', ');
          const values = cols.map((c) => row[c] ?? null);

          try {
            await db.run(
              `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT (${spec.key}) DO UPDATE SET ${
                 cols.filter((c) => c !== spec.key)
                     .map((c) => `${c} = excluded.${c}`).join(', ')
               }`,
              values,
            );
            if (mine) report.merged++;
            else report.applied++;
            appliedHere.push({ table, id });
          } catch {
            // A foreign key the receiving device does not hold yet — an
            // annotation whose document_version has not been extracted here.
            // Deferred rather than dropped: it arrives again on the next pull
            // once extraction has run.
            report.deferred++;
          }
        }
      }

      // Applying a pull fires the dirty triggers, which would push these rows
      // straight back out. Clear them so devices do not echo each other
      // forever.
      for (const a of appliedHere) {
        await db.run('DELETE FROM sync_dirty WHERE table_name = ? AND row_id = ?', [
          a.table, a.id,
        ]);
      }
    });
  }

  await db.run(
    'UPDATE sync_state SET pull_cursor = ?, last_pull_at = ? WHERE id = 1',
    [report.cursor, clock.now()],
  );

  return report;
}

/**
 * Deferred rows are re-delivered by resetting the cursor behind them. Callers
 * do this after running the pipeline, so annotations whose document versions
 * now exist can land.
 */
export async function resetPullCursor(
  db: SqlDriver,
  cursor: string | null,
): Promise<void> {
  await db.run('UPDATE sync_state SET pull_cursor = ? WHERE id = 1', [cursor]);
}
