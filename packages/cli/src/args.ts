/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulling in a framework: the surface is small, and a
 * CLI whose job is to exercise a zero-dependency core should not itself grow a
 * dependency tree for flag parsing.
 */

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags.set(arg.slice(1), true);
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: positionals[0] ?? null,
    subcommand: positionals[1] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}

export function flagString(
  flags: Map<string, string | boolean>,
  name: string,
): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true || flags.get(name) === 'true';
}

export function flagNumber(
  flags: Map<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const raw = flagString(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return n;
}
