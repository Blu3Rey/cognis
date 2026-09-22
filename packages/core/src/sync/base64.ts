/**
 * Base64 without Buffer or atob/btoa.
 *
 * Core runs in Node and in a React Native runtime; `Buffer` is Node-only and
 * `atob`/`btoa` are deprecated in Node and inconsistently polyfilled in RN.
 * A few lines of arithmetic avoids the whole question.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : ALPHABET[c & 0x3f];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  // Padding is stripped by this filter along with whitespace, so the output
  // length follows from the remaining character count alone. Subtracting the
  // padding count as well would truncate — and would do so only when the
  // input length is not a multiple of three, which is the kind of bug that
  // passes most tests and corrupts the rest.
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!;
    const b = LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = LOOKUP[clean.charCodeAt(i + 2)]!;
    const d = LOOKUP[clean.charCodeAt(i + 3)]!;
    if (p < out.length) out[p++] = (a << 2) | (b >> 4);
    if (p < out.length) out[p++] = ((b & 0x0f) << 4) | (c >> 2);
    if (p < out.length) out[p++] = ((c & 0x03) << 6) | d;
  }
  return out;
}
