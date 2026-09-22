/**
 * JSON Lines export and import.
 *
 * The export format is deliberately dull: a header line, then one JSON object
 * per row tagged with its table. It is diffable, streamable, greppable, and
 * readable without cognis — which is the point of a data-rights export
 * (docs/09-privacy-and-security.md § Data rights).
 *
 * Round-tripping this export is the M0 completion criterion, so the import
 * side verifies row counts rather than trusting them.
 */

import type { SqlDriver, SqlValue } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import { EXPORT_ORDER, TABLES } from './tables.js';
import type { TableSpec } from './tables.js';

export const EXPORT_FORMAT_VERSION = 1;

export interface ExportHeader {
  format: 'cognis-jsonl';
  version: number;
  exportedAt: string;
  tables: { name: string; attested: boolean; rows: number }[];
}

export interface ExportRow {
  t: string;
  r: Record<string, SqlValue>;
}

async function countRows(db: SqlDriver, table: string): Promise<number> {
  const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/**
 * Stream the whole database as JSONL.
 *
 * Yields line by line so a large corpus never has to be materialised in
 * memory — export must work on a phone with a year of reading in it.
 */
export async function* exportJsonl(
  db: SqlDriver,
  clock: Clock,
): AsyncGenerator<string> {
  const header: ExportHeader = {
    format: 'cognis-jsonl',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: clock.now(),
    tables: [],
  };
  for (const spec of EXPORT_ORDER) {
    header.tables.push({
      name: spec.name,
      attested: spec.attested,
      rows: await countRows(db, spec.name),
    });
  }
  yield JSON.stringify(header);

  for (const spec of EXPORT_ORDER) {
    const cols = spec.columns.join(', ');
    // Ordered by primary key so two exports of the same database are
    // byte-identical, which makes the export diffable and testable.
    const rows = await db.all<Record<string, SqlValue>>(
      `SELECT ${cols} FROM ${spec.name} ORDER BY id`,
    );
    for (const r of rows) {
      const line: ExportRow = { t: spec.name, r };
      yield JSON.stringify(line);
    }
  }
}

/** Collect the export into a single string. Convenience for small corpora. */
export async function exportJsonlString(
  db: SqlDriver,
  clock: Clock,
): Promise<string> {
  const parts: string[] = [];
  for await (const line of exportJsonl(db, clock)) parts.push(line);
  return parts.join('\n') + '\n';
}

export interface ImportReport {
  header: ExportHeader;
  imported: Record<string, number>;
  /** Tables whose imported count differs from the header's claim. */
  mismatches: { table: string; expected: number; actual: number }[];
}

const TABLE_BY_NAME = new Map<string, TableSpec>(TABLES.map((t) => [t.name, t]));

/**
 * Import a JSONL export into an empty, migrated database.
 *
 * Verifies against the header's row counts and reports mismatches rather than
 * failing silently: a round-trip that loses rows must be loud.
 */
export async function importJsonl(
  db: SqlDriver,
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<ImportReport> {
  let header: ExportHeader | null = null;
  const imported: Record<string, number> = {};

  await db.transaction(async () => {
    for await (const raw of lines as AsyncIterable<string>) {
      const line = raw.trim();
      if (!line) continue;

      const parsed: unknown = JSON.parse(line);

      if (!header) {
        const h = parsed as ExportHeader;
        if (h.format !== 'cognis-jsonl') {
          throw new Error(`not a cognis export: format=${String(h.format)}`);
        }
        if (h.version !== EXPORT_FORMAT_VERSION) {
          throw new Error(
            `unsupported export version ${h.version}; this build reads ${EXPORT_FORMAT_VERSION}`,
          );
        }
        header = h;
        continue;
      }

      const { t, r } = parsed as ExportRow;
      const spec = TABLE_BY_NAME.get(t);
      if (!spec) throw new Error(`unknown table in export: ${t}`);

      const cols = spec.columns;
      const placeholders = cols.map(() => '?').join(', ');
      const values = cols.map((c) => r[c] ?? null);
      await db.run(
        `INSERT INTO ${spec.name} (${cols.join(', ')}) VALUES (${placeholders})`,
        values,
      );
      imported[t] = (imported[t] ?? 0) + 1;
    }
  });

  if (!header) throw new Error('empty export: no header line');
  const h: ExportHeader = header;

  const mismatches: ImportReport['mismatches'] = [];
  for (const claim of h.tables) {
    const actual = imported[claim.name] ?? 0;
    if (actual !== claim.rows) {
      mismatches.push({ table: claim.name, expected: claim.rows, actual });
    }
  }

  return { header: h, imported, mismatches };
}

/** Split a JSONL string into lines, for callers that hold it in memory. */
export function* linesOf(text: string): Generator<string> {
  for (const line of text.split('\n')) {
    if (line.trim()) yield line;
  }
}

/**
 * Assert the export manifest covers every table in the database.
 *
 * Guards against the failure mode where a later migration adds a table and the
 * export quietly stops being complete.
 */
export async function assertManifestCoversSchema(db: SqlDriver): Promise<void> {
  const rows = await db.all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name <> 'schema_migration'`,
  );
  const known = new Set(TABLES.map((t) => t.name));
  const missing = rows.map((r) => r.name).filter((n) => !known.has(n));
  if (missing.length > 0) {
    throw new Error(
      `export manifest is missing tables: ${missing.join(', ')}. ` +
        `Add them to src/export/tables.ts or the export is incomplete.`,
    );
  }
}
