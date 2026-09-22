/**
 * Clock port.
 *
 * Time is injected rather than ambient because every retention and spacing
 * test needs controlled time. Nothing in core may call `Date.now()` directly —
 * see docs/01-architecture.md § Ports.
 */

import type { Timestamp } from '../types.js';

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
  /** ISO-8601 UTC timestamp. */
  now(): Timestamp;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  now: () => new Date().toISOString(),
};

/** Test clock with explicit control over the passage of time. */
export class FakeClock implements Clock {
  #ms: number;

  constructor(start: Timestamp | number = 0) {
    this.#ms = typeof start === 'number' ? start : Date.parse(start);
  }

  nowMs(): number {
    return this.#ms;
  }

  now(): Timestamp {
    return new Date(this.#ms).toISOString();
  }

  advanceMs(ms: number): void {
    this.#ms += ms;
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }

  set(at: Timestamp | number): void {
    this.#ms = typeof at === 'number' ? at : Date.parse(at);
  }
}
