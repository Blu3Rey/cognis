/**
 * End-to-end encryption for sync.
 *
 * The relay stores opaque blobs and can never read them (ADR-0004). There is
 * no middle option in which the server can read the corpus, so there is no
 * server-side key, no escrow, and no recovery path — losing the passphrase
 * means losing the sync history, and `describeRecovery()` below says so in the
 * words the setup screen should use.
 *
 * AES-256-GCM via Web Crypto, which is authenticated: a tampered blob fails to
 * decrypt rather than decrypting to garbage.
 */

import type { KeyDerivation, KdfParams } from '../ports/key-derivation.js';
import { toBase64, fromBase64 } from './base64.js';

export const ENVELOPE_VERSION = 1;
const KEY_BITS = 256;
const NONCE_BYTES = 12;
export const SALT_BYTES = 16;

/**
 * OWASP's PBKDF2-SHA256 guidance at time of writing. High, because this is
 * the fallback and the passphrase is the only thing protecting the corpus.
 */
export const PBKDF2_ITERATIONS = 600_000;

/** Portable fallback KDF. See the port's note on memory-hardness. */
export class Pbkdf2KeyDerivation implements KeyDerivation {
  readonly params: KdfParams;

  constructor(iterations: number = PBKDF2_ITERATIONS) {
    this.params = {
      id: 'pbkdf2-sha256',
      cost: { iterations },
    };
  }

  async derive(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto.subtle;
    const material = await subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: this.params.cost['iterations'] as number,
        hash: 'SHA-256',
      },
      material,
      KEY_BITS,
    );
    return new Uint8Array(bits);
  }
}

/** Local, non-secret sync parameters. The salt is stored; the key never is. */
export interface SyncKeyset {
  version: number;
  salt: string;
  kdf: KdfParams;
  /**
   * Random, stable identifier for the keyset. Lets a device tell "wrong
   * passphrase" from "different corpus" without trying to decrypt anything.
   */
  keysetId: string;
}

export function newKeyset(kdf: KeyDerivation): SyncKeyset {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const idBytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(idBytes);
  return {
    version: ENVELOPE_VERSION,
    salt: toBase64(salt),
    kdf: kdf.params,
    keysetId: toBase64(idBytes),
  };
}

export interface Envelope {
  v: number;
  alg: 'AES-GCM';
  keysetId: string;
  nonce: string;
  ct: string;
}

export class SyncCipher {
  #key: Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>> | null = null;

  private constructor(
    readonly keyset: SyncKeyset,
    private readonly rawKey: Uint8Array,
  ) {}

  static async open(
    keyset: SyncKeyset,
    kdf: KeyDerivation,
    passphrase: string,
  ): Promise<SyncCipher> {
    if (kdf.params.id !== keyset.kdf.id) {
      throw new Error(
        `keyset was created with ${keyset.kdf.id} but ${kdf.params.id} was supplied; ` +
          're-wrap the corpus before switching key derivation',
      );
    }
    const raw = await kdf.derive(passphrase, fromBase64(keyset.salt));
    return new SyncCipher(keyset, raw);
  }

  async #cryptoKey(): Promise<Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>> {
    if (!this.#key) {
      this.#key = await globalThis.crypto.subtle.importKey(
        'raw',
        this.rawKey,
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
      );
    }
    return this.#key;
  }

  async encrypt(plaintext: string): Promise<Envelope> {
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      await this.#cryptoKey(),
      new TextEncoder().encode(plaintext),
    );
    return {
      v: ENVELOPE_VERSION,
      alg: 'AES-GCM',
      keysetId: this.keyset.keysetId,
      nonce: toBase64(nonce),
      ct: toBase64(new Uint8Array(ct)),
    };
  }

  async decrypt(env: Envelope): Promise<string> {
    if (env.v !== ENVELOPE_VERSION) {
      throw new Error(`unsupported envelope version ${env.v}`);
    }
    if (env.keysetId !== this.keyset.keysetId) {
      // A different corpus, not a wrong passphrase. Worth distinguishing:
      // the remedies are completely different.
      throw new Error('envelope belongs to a different keyset');
    }
    let plain: ArrayBuffer;
    try {
      plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(env.nonce) },
        await this.#cryptoKey(),
        fromBase64(env.ct),
      );
    } catch {
      // AES-GCM is authenticated, so this is either the wrong key or a
      // tampered blob. Both mean: do not trust this data.
      throw new Error('decryption failed: wrong passphrase or tampered payload');
    }
    return new TextDecoder().decode(plain);
  }
}

/**
 * The passphrase-loss warning, in the words the setup screen should use.
 *
 * ADR-0004 says to state this plainly rather than adding a recovery path that
 * reintroduces server-side access. Keeping the text here rather than in the
 * client means it cannot be quietly softened in a design review.
 */
export function describeRecovery(): string {
  return [
    'Your passphrase is the only key to your synced data.',
    'It never leaves this device, and we cannot read your data or reset it.',
    'If you lose the passphrase, the synced history cannot be recovered — not by you, not by us.',
    'The copy on this device is unaffected: sync is a backup of an encrypted archive, not the archive itself.',
  ].join('\n');
}
