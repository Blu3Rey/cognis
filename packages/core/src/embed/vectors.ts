/**
 * Vector helpers: serialisation and similarity.
 *
 * Vectors are stored as little-endian float32 blobs. Explicit byte handling
 * rather than a Float32Array view over the row buffer, because a SQLite blob
 * is not guaranteed to be aligned for a direct typed-array view.
 */

export function toBlob(v: Float32Array): Uint8Array {
  const out = new Uint8Array(v.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, true);
  return out;
}

export function fromBlob(blob: Uint8Array, dim: number): Float32Array {
  if (blob.byteLength !== dim * 4) {
    throw new Error(`vector blob is ${blob.byteLength} bytes, expected ${dim * 4}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function l2Normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/**
 * Cosine similarity. Assumes both vectors are L2-normalised, which the
 * Embedder contract guarantees, so this is a plain dot product.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // Floating-point drift can push a normalised dot product just outside
  // [-1, 1]; clamping keeps novelty inside its CHECK constraint.
  return Math.max(-1, Math.min(1, dot));
}
