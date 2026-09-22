/**
 * Wiring core's ports to real implementations.
 *
 * Every command goes through `openCognis`, so embedder selection, the offline
 * rule and the "which adapter am I actually using" question are answered in
 * one place rather than per command.
 */

import { Cognis, NodeSqliteDriver, HashEmbedder, systemClock } from '@cognis/core';
import type { Embedder } from '@cognis/core';
import { TransformersEmbedder, DEFAULT_MODEL, DEFAULT_DIM } from './adapters/transformers-embedder.js';
import type { PipelineFactory } from './adapters/transformers-embedder.js';
import { resolvePaths, ensurePaths } from './config.js';
import type { Paths } from './config.js';
import { warn } from './output.js';

export type EmbedderChoice = 'transformers' | 'hash' | 'none';

export interface OpenOptions {
  /** Which embedder to wire. Defaults to transformers. */
  embedder?: EmbedderChoice;
  model?: string;
  dim?: number;
  /** Never reach the network for weights. */
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. */
  pipelineFactory?: PipelineFactory;
}

export interface CliContext {
  cognis: Cognis;
  paths: Paths;
  embedderKind: EmbedderChoice;
  embedder: Embedder | null;
  close(): Promise<void>;
}

export function buildEmbedder(
  paths: Paths,
  opts: OpenOptions,
): { embedder: Embedder | null; kind: EmbedderChoice } {
  const choice = opts.embedder ?? 'transformers';

  if (choice === 'none') return { embedder: null, kind: 'none' };

  if (choice === 'hash') {
    // Lexical, not semantic. Useful for exercising the pipeline offline; it is
    // announced loudly because novelty and search computed with it mean
    // something different from the real thing, and mixing the two in one
    // corpus would corrupt both.
    return { embedder: new HashEmbedder(), kind: 'hash' };
  }

  return {
    embedder: new TransformersEmbedder({
      model: opts.model ?? DEFAULT_MODEL,
      dim: opts.dim ?? DEFAULT_DIM,
      cacheDir: paths.modelDir,
      allowRemote: !opts.offline,
      ...(opts.pipelineFactory ? { pipelineFactory: opts.pipelineFactory } : {}),
    }),
    kind: 'transformers',
  };
}

export async function openCognis(opts: OpenOptions = {}): Promise<CliContext> {
  const paths = resolvePaths(opts.env);
  await ensurePaths(paths);

  const { embedder, kind } = buildEmbedder(paths, opts);

  const cognis = new Cognis({
    db: new NodeSqliteDriver({ location: paths.dbPath }),
    clock: systemClock,
    ...(embedder ? { embedder } : {}),
  });
  await cognis.migrate();

  if (kind === 'hash') {
    warn(
      'using the lexical fallback embedder: novelty and search will reflect ' +
        'word overlap, not meaning',
    );
  }

  return {
    cognis,
    paths,
    embedderKind: kind,
    embedder,
    close: () => cognis.close(),
  };
}

/**
 * Guard against mixing embedding models in one corpus.
 *
 * Vectors from different models are not comparable, so a corpus embedded with
 * the lexical fallback and then extended with a real model would produce
 * silently meaningless novelty scores and search results.
 */
export async function assertEmbedderConsistent(ctx: CliContext): Promise<void> {
  if (!ctx.embedder) return;
  const rows = await ctx.cognis.db.all<{ model_id: string; n: number }>(
    'SELECT model_id, COUNT(*) AS n FROM embedding_meta GROUP BY model_id',
  );
  const others = rows.filter((r) => r.model_id !== ctx.embedder!.modelId);
  if (others.length === 0) return;

  const summary = others.map((o) => `${o.model_id} (${o.n} vectors)`).join(', ');
  throw new Error(
    `this corpus already holds vectors from a different model: ${summary}\n` +
      `You are about to add vectors from ${ctx.embedder.modelId}, which are not ` +
      `comparable with them.\n` +
      `Either switch back to the original model, or re-embed everything with:\n` +
      `  cognis reindex --all`,
  );
}
