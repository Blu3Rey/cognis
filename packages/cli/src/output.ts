/**
 * Terminal output.
 *
 * Colour only when the stream is a TTY, so piping to a file or another program
 * produces clean text. `--json` on every read command exists for the same
 * reason: the CLI is also a scripting surface for the evaluations.
 */

const isTty = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const wrap = (code: string) => (s: string) => (isTty ? `\u001b[${code}m${s}\u001b[0m` : s);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  process.stdout.write(`${green('✓')} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow('!')} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${red('✗')} ${message}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Left-aligned key/value block, for `show` and `stats`. */
export function pairs(entries: [string, string | number | null][]): void {
  const width = Math.max(...entries.map(([k]) => k.length));
  for (const [k, v] of entries) {
    process.stdout.write(`  ${dim(k.padEnd(width))}  ${v ?? dim('—')}\n`);
  }
}

export function table(
  headers: string[],
  rows: (string | number | null)[][],
): void {
  if (rows.length === 0) {
    info(dim('  (nothing)'));
    return;
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  process.stdout.write(
    '  ' + headers.map((h, i) => dim(h.padEnd(widths[i]!))).join('  ') + '\n',
  );
  for (const row of rows) {
    process.stdout.write(
      '  ' + row.map((c, i) => String(c ?? '').padEnd(widths[i]!)).join('  ') + '\n',
    );
  }
}

/** Truncate for display without cutting mid-word where avoidable. */
export function ellipsis(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…';
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  const day = 86_400_000;
  if (diff < 0) return 'in the future';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  if (diff < 365 * day) return `${Math.round(diff / (30 * day))}mo ago`;
  return `${(diff / (365 * day)).toFixed(1)}y ago`;
}

/**
 * A single status line that redraws in place.
 *
 * Long-running commands are network- and model-bound, and a terminal that says
 * nothing for fifteen minutes reads as a hang — the user kills the run and
 * throws the work away. Progress goes to stderr so `--json` on stdout stays
 * machine-readable, and falls back to nothing when stderr is not a TTY, so a
 * log file does not fill with redraws.
 */
export function progressLine(): {
  update(message: string): void;
  clear(): void;
} {
  const tty = process.stderr.isTTY === true && !process.env['NO_COLOR'];
  let width = 0;

  return {
    update(message: string): void {
      if (!tty) return;
      const columns = process.stderr.columns ?? 80;
      const text = message.length > columns - 1
        ? `${message.slice(0, columns - 2)}…`
        : message;
      process.stderr.write(`\r${text}${' '.repeat(Math.max(0, width - text.length))}`);
      width = text.length;
    },
    clear(): void {
      if (!tty || width === 0) return;
      process.stderr.write(`\r${' '.repeat(width)}\r`);
      width = 0;
    },
  };
}
