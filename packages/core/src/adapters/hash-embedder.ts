/**
 * Deterministic hashing embedder — development and tests only.
 *
 * Projects token hashes into a fixed-width space with sub-linear term
 * weighting and L2 normalisation. It is not a semantic model: it captures
 * lexical overlap, nothing more. It exists so that the pipeline, the novelty
 * arithmetic and the search ranking can be tested without shipping model
 * weights, and so tests are fully deterministic.
 *
 * A real deployment injects an ONNX sentence-embedding model instead. Nothing
 * in core distinguishes them.
 */

import type { Embedder } from '../ports/embedder.js';
import { l2Normalise } from '../embed/vectors.js';

/** FNV-1a, 32-bit. Stable across runs and platforms. */
function hash32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

export interface HashEmbedderOptions {
  dim?: number;
  modelId?: string;
}

export class HashEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;

  constructor(opts: HashEmbedderOptions = {}) {
    this.dim = opts.dim ?? 128;
    this.modelId = opts.modelId ?? `hash-embedder-v1@${this.dim}`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.#embedOne(t));
  }

  #embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const counts = new Map<string, number>();
    for (const token of tokenise(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts) {
      // Two hashes per token, with opposing signs, to reduce collision bias.
      const a = hash32(token) % this.dim;
      const b = hash32(token, 0x9e3779b1) % this.dim;
      const weight = 1 + Math.log(count);
      v[a] = v[a]! + weight;
      v[b] = v[b]! - weight * 0.5;
    }
    return l2Normalise(v);
  }
}
