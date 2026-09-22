/**
 * The Web Crypto surface cognis core depends on.
 *
 * Declared explicitly rather than pulling in the DOM lib, which would also
 * assert that `window`, `document` and several hundred browser APIs exist —
 * none of which are available in a React Native runtime or in Node, and any of
 * which would then typecheck happily and fail at run time.
 *
 * This file doubles as documentation: it is the complete list of platform
 * cryptography core requires a host to provide.
 */

interface CognisCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
}

type CognisBufferSource = ArrayBuffer | ArrayBufferView;

interface CognisSubtleCrypto {
  digest(algorithm: string, data: CognisBufferSource): Promise<ArrayBuffer>;
  importKey(
    format: 'raw',
    keyData: CognisBufferSource,
    algorithm: string | { name: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CognisCryptoKey>;
  deriveBits(
    algorithm: { name: string; salt: CognisBufferSource; iterations: number; hash: string },
    baseKey: CognisCryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
  encrypt(
    algorithm: { name: string; iv: CognisBufferSource },
    key: CognisCryptoKey,
    data: CognisBufferSource,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: { name: string; iv: CognisBufferSource },
    key: CognisCryptoKey,
    data: CognisBufferSource,
  ): Promise<ArrayBuffer>;
}

interface CognisCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  readonly subtle: CognisSubtleCrypto;
}

declare global {
  // eslint-disable-next-line no-var
  var crypto: CognisCrypto;
}

export {};
