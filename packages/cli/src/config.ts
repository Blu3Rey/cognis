/**
 * Where the CLI keeps things.
 *
 * One directory, overridable, so a throwaway corpus for experimenting is
 * `COGNIS_HOME=/tmp/try cognis …` and does not touch the real one.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface Paths {
  home: string;
  dbPath: string;
  modelDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env['COGNIS_HOME'] ?? join(homedir(), '.cognis');
  return {
    home,
    dbPath: env['COGNIS_DB'] ?? join(home, 'corpus.db'),
    modelDir: env['COGNIS_MODELS'] ?? join(home, 'models'),
  };
}

export async function ensurePaths(paths: Paths): Promise<void> {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.modelDir, { recursive: true });
}
