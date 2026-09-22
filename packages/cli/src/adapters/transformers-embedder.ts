/**
 * Real semantic embeddings via transformers.js.
 *
 * This is the adapter that makes novelty and search mean something. The
 * fixture `HashEmbedder` in core is lexical: two articles making the same
 * point in different words score as NOVEL, which is the opposite of what
 * novelty is for. A sentence-embedding model fixes that, and nothing else in
 * cognis changes — it satisfies the same `Embedder` port.
 *
 * Three deliberate choices:
 *
 *  - **WASM backend.** `onnxruntime-node` needs native binaries fetched by a
 *    postinstall script, which fails in sandboxes, offline machines and
 *    several CI images. WASM is slower and works everywhere.
 *  - **Local model directory first.** Weights are read from disk if present
 *    and only fetched when they are not, so a corpus can be re-embedded with
 *    no network at all.
 *  - **Injectable loader.** The pipeline factory is a constructor argument, so
 *    batching, pooling, dimension checks and error handling are testable
 *    without downloading 23MB of weights.
 */

import type { Embedder } from '@cognis/core';

/** Sentence embeddings, 384 dimensions, ~23MB quantised. A sane default. */
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DIM = 384;

/** The shape transformers.js returns from a feature-extraction pipeline. */
export interface EmbeddingTensor {
  data: Float32Array | number[];
  dims: number[];
}

export type FeatureExtractor = (
  texts: readonly string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<EmbeddingTensor>;

export type PipelineFactory = (opts: {
  model: string;
  cacheDir: string;
  allowRemote: boolean;
}) => Promise<FeatureExtractor>;

export class EmbedderUnavailableError extends Error {
  constructor(message: string, readonly remedy: string) {
    super(`${message}\n\n${remedy}`);
    this.name = 'EmbedderUnavailableError';
  }
}

export interface TransformersEmbedderOptions {
  model?: string;
  dim?: number;
  /** Where weights live. Populated on first use, then read from disk. */
  cacheDir: string;
  /** Allow downloading weights. False makes the embedder strictly offline. */
  allowRemote?: boolean;
  /** Texts per forward pass. WASM is memory-bound, so this stays modest. */
  batchSize?: number;
  /** Injected in tests; defaults to the real transformers.js loader. */
  pipelineFactory?: PipelineFactory;
}

/**
 * The default loader.
 *
 * Imported dynamically so the CLI still starts when the optional dependency
 * is absent — which is the normal case in CI, and the case this whole
 * environment is in.
 */
export const defaultPipelineFactory: PipelineFactory = async ({
  model, cacheDir, allowRemote,
}) => {
  let transformers: typeof import('@huggingface/transformers');
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    throw new EmbedderUnavailableError(
      `@huggingface/transformers is not installed (${
        err instanceof Error ? err.message : String(err)
      })`,
      'Install it with:\n  npm install @huggingface/transformers -w @cognis/cli\n\n' +
        'Until then, `--embedder hash` uses the lexical fallback, which is fine ' +
        'for exercising the pipeline but not for judging novelty or search.',
    );
  }

  const { env, pipeline } = transformers;
  // Native onnxruntime is the thing that will not install; WASM always works.
  env.backends.onnx.backend = 'wasm';
  env.cacheDir = cacheDir;
  env.localModelPath = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = allowRemote;

  const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
  return (texts, opts) =>
    extractor(texts as string[], opts) as unknown as Promise<EmbeddingTensor>;
};

export class TransformersEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;
  readonly #cacheDir: string;
  readonly #allowRemote: boolean;
  readonly #batchSize: number;
  readonly #factory: PipelineFactory;
  #extractor: FeatureExtractor | null = null;

  constructor(opts: TransformersEmbedderOptions) {
    const model = opts.model ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? DEFAULT_DIM;
    // The model id is stored with every vector, and vectors from different
    // models are not comparable. Including the dimension makes a mismatch
    // visible in the data rather than only in a crash.
    this.modelId = `${model}@${this.dim}`;
    this.#cacheDir = opts.cacheDir;
    this.#allowRemote = opts.allowRemote ?? true;
    this.#batchSize = opts.batchSize ?? 16;
    this.#factory = opts.pipelineFactory ?? defaultPipelineFactory;
  }

  /** Load the model. Called lazily, but exposed so `cognis doctor` can probe. */
  async load(): Promise<void> {
    if (this.#extractor) return;
    try {
      this.#extractor = await this.#factory({
        model: this.modelId.split('@')[0]!,
        cacheDir: this.#cacheDir,
        allowRemote: this.#allowRemote,
      });
    } catch (err) {
      if (err instanceof EmbedderUnavailableError) throw err;
      throw new EmbedderUnavailableError(
        `could not load ${this.modelId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        `Weights are read from ${this.#cacheDir} and downloaded there on first use.\n` +
          'If this machine has no access to huggingface.co, fetch them elsewhere and\n' +
          'copy the model directory across, then re-run with --offline.',
      );
    }
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.load();
    const extractor = this.#extractor!;

    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.#batchSize) {
      const batch = texts.slice(i, i + this.#batchSize);
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });

      const produced = tensor.dims[0] ?? 0;
      const dim = tensor.dims[1] ?? 0;
      if (produced !== batch.length) {
        throw new Error(
          `embedder returned ${produced} vectors for ${batch.length} inputs`,
        );
      }
      if (dim !== this.dim) {
        // Silently accepting a different dimension would corrupt every stored
        // vector's comparability with the ones already in the corpus.
        throw new Error(
          `model produced ${dim}-dimensional vectors but this embedder is ` +
            `configured for ${this.dim}; re-embed with --dim ${dim} or pick another model`,
        );
      }

      const data = tensor.data instanceof Float32Array
        ? tensor.data
        : Float32Array.from(tensor.data);
      for (let j = 0; j < batch.length; j++) {
        out.push(data.slice(j * dim, (j + 1) * dim));
      }
    }
    return out;
  }
}
