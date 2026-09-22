/**
 * ULID generation.
 *
 * Chosen over UUIDv4 because ids are generated offline on-device and must sort
 * by creation time: the attested tables are append-only logs, and a sortable
 * primary key makes range scans over "what did I capture last month" an index
 * seek rather than a table scan.
 *
 * Layout: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32, 26 characters.
 */

/** Crockford base32: no I, L, O or U, to avoid transcription ambiguity. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 281474976710655; // 2^48 - 1

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  let out = '';
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % ENCODING_LEN] + out;
    t = Math.floor(t / ENCODING_LEN);
  }
  return out;
}

function randomBytes(): number[] {
  const buf = new Uint8Array(RANDOM_LEN);
  // Web Crypto rather than node:crypto: the same call works in Node and in a
  // React Native runtime, and core must not depend on Node built-ins.
  globalThis.crypto.getRandomValues(buf);
  // Map each byte into the 32-char alphabet range.
  return Array.from(buf, (b) => b % ENCODING_LEN);
}

/**
 * Increment the random component in place, for monotonicity within a
 * millisecond. Two ULIDs minted in the same millisecond still sort in
 * generation order.
 */
function incrementRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i] ?? 0;
    if (v < ENCODING_LEN - 1) {
      next[i] = v + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed all 80 bits within one millisecond: astronomically unlikely,
  // but re-seeding is the only correct response.
  return randomBytes();
}

/** Generate a ULID. Monotonic within a millisecond. */
export function ulid(now: number = Date.now()): string {
  const time = Math.floor(now);
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = randomBytes();
  }
  const random = lastRandom.map((v) => ENCODING[v]).join('');
  return encodeTime(time) + random;
}

/** Extract the millisecond timestamp a ULID encodes. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`not a ULID: ${id}`);
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i] as string);
    t = t * ENCODING_LEN + idx;
  }
  return t;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}
