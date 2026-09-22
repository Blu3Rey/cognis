/**
 * Sync relay port.
 *
 * The relay stores opaque blobs and orders them. It cannot read them, and the
 * interface gives it nothing it could read: a batch is an envelope plus the
 * minimum metadata needed to sequence it (ADR-0004).
 */

import type { Envelope } from '../sync/crypto.js';

export interface RelayBatch {
  /** Relay-assigned, monotonically increasing. The pull cursor. */
  cursor: string;
  /** Which device produced it, so a device can skip its own batches. */
  deviceId: string;
  envelope: Envelope;
}

export interface SyncRelay {
  /** Store a batch. Returns the assigned cursor. */
  push(deviceId: string, envelope: Envelope): Promise<{ cursor: string }>;
  /** Batches after `since`, oldest first. */
  pull(since: string | null, limit: number): Promise<RelayBatch[]>;
}
