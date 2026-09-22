/**
 * Content hashing.
 *
 * Uses Web Crypto rather than node:crypto so the same code runs in Node and in
 * a React Native runtime. Async as a consequence, which is fine — every caller
 * is already async.
 */

const HEX = '0123456789abcdef';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) {
    out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
  }
  return out;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/** SHA-256 of raw bytes, lowercase hex. */
export async function sha256Bytes(input: Uint8Array): Promise<string> {
  const view = new Uint8Array(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
  return toHex(digest);
}

/**
 * Hash of extracted text for syndication detection.
 *
 * Normalises whitespace and case before hashing so that the same article
 * republished with different formatting collapses to one hash. This is
 * deliberately more aggressive than `sha256` over raw text: it is answering
 * "is this the same writing?", not "are these the same bytes?".
 */
export async function textFingerprint(text: string): Promise<string> {
  const normalised = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(normalised);
}
