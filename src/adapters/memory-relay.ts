/**
 * In-memory sync relay — development and tests.
 *
 * Production is a small service storing ciphertext and job state, nothing
 * else. Both implementations see exactly the same thing: a blob they cannot
 * open and an ordering.
 */

import type { SyncRelay, RelayBatch } from '../ports/sync-relay.js';
import type { Envelope } from '../sync/crypto.js';

export class MemoryRelay implements SyncRelay {
  #batches: RelayBatch[] = [];
  #next = 0;

  async push(deviceId: string, envelope: Envelope): Promise<{ cursor: string }> {
    const cursor = String(++this.#next).padStart(12, '0');
    this.#batches.push({ cursor, deviceId, envelope });
    return { cursor };
  }

  async pull(since: string | null, limit: number): Promise<RelayBatch[]> {
    return this.#batches
      .filter((b) => since === null || b.cursor > since)
      .slice(0, limit);
  }

  /** Test helper: what the relay actually holds. */
  get stored(): readonly RelayBatch[] {
    return this.#batches;
  }
}
