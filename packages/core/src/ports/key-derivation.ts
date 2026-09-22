/**
 * Key derivation port.
 *
 * docs/09-privacy-and-security.md specifies a MEMORY-HARD KDF, and Web Crypto
 * does not offer one: PBKDF2 is all that is portably available, and PBKDF2 is
 * compute-hard but not memory-hard, which makes it markedly cheaper to attack
 * with GPUs or ASICs.
 *
 * So this is a port, and the deviation is explicit rather than quiet. The
 * bundled PBKDF2 implementation is the portable fallback; a device build
 * should inject Argon2id (via a native module or WASM) and gets a materially
 * stronger passphrase guarantee for doing so.
 *
 * `id` is recorded in the keyset so a corpus encrypted under one KDF can be
 * recognised — and re-wrapped — rather than silently failing to open.
 */

export interface KdfParams {
  /** Identifier recorded with the keyset, e.g. "pbkdf2-sha256" or "argon2id". */
  id: string;
  /** Implementation-specific cost parameters, recorded verbatim. */
  cost: Record<string, number | string>;
}

export interface KeyDerivation {
  readonly params: KdfParams;
  /** Derive a 256-bit key from a passphrase and salt. */
  derive(passphrase: string, salt: Uint8Array): Promise<Uint8Array>;
}
