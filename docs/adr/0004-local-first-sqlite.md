# 0004 — Local-first SQLite as source of truth

**Status:** Accepted

## Context

The corpus records everything the user reads, how long they spent, what they
highlighted, and what they could not recall. It is a more intimate dataset than
browser history.

Meanwhile, nothing the product does at its core requires a server: capture,
extraction, embedding, novelty, coverage, search, scheduling and the views are
all local computations over local data.

## Decision

The device holds the authoritative copy, in SQLite with `sqlite-vec` for vector
search, encrypted at rest. The backend is a stateless proxy for model calls,
scholarly metadata, push scheduling and encrypted sync relay. It stores no
plaintext corpus content.

Sync, when it exists, is end-to-end encrypted; the relay handles ciphertext it
cannot read. Attested rows merge by union — two devices that each recorded a
reading event both happened.

## Consequences

- Offline works by default rather than as a feature.
- Deletion is real: the data was never anywhere else.
- Compelled disclosure against the backend yields ciphertext and job state.
- The privacy story is structural rather than a policy promise.
- Cost: cross-device sync is harder, and losing a passphrase means losing sync
  history. This must be stated plainly at setup rather than softened with a
  recovery path that reintroduces server-side access.
- Cost: no server-side analytics over the corpus, so evaluation runs on the
  developer's own corpus or on explicitly donated data.
- Cost: migrations must be safe on devices that skip several versions.
- SQLite on mobile imposes real limits — keep vector search ANN-indexed, keep
  rollups incremental, and never load the graph into memory.

## Alternatives considered

**Server-authoritative with a thin client.** Easier sync, easier analytics,
easier ops. Rejected: it centralises the most sensitive dataset the product
touches for benefits the product does not need, and it makes offline a
retrofit.

**Local-first with plaintext server backup.** All of the exposure, most of the
convenience. If the server can read it, the threat model is the server's.

**Local-only, no sync at all.** Simplest and most private, but a knowledge system
that does not survive a lost phone is a knowledge system people will not trust
with years of reading. E2E sync is the compromise that keeps the property that
matters.
