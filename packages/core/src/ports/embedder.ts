/**
 * Embedder port.
 *
 * The device supplies a real sentence-embedding model via ONNX; tests supply a
 * deterministic stub. Core never imports either directly.
 *
 * `modelId` is part of the contract rather than an afterthought: vectors from
 * different models are not comparable, and every stored vector and novelty
 * score records the model that produced it so the two can never be silently
 * mixed (docs/08-llm-integration.md § Embeddings).
 */

export interface Embedder {
  /** Stable identifier, e.g. "minilm-l6-v2@1". Stored with every vector. */
  readonly modelId: string;
  /** Vector dimensionality. */
  readonly dim: number;
  /** Embed a batch. Returns L2-normalised vectors, one per input, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
