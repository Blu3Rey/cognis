# 0009 — Derive source identity from its natural key

**Status:** Accepted

## Context

Source rows were keyed by a ULID minted at capture time. That is fine on one
device and wrong across two.

Two devices that read the same article each mint their own id for it. When
they sync, both rows arrive at the other device, and both claim the same
`canonical_url` — which carries a unique index, because a source is supposed
to be one thing. The insert fails. In the implementation as first written the
failure was swallowed by the deferred-row path, so sync reported success while
one device's copy quietly failed to land.

This is not an edge case. Two devices reading the same article is the ordinary
reason someone wants sync.

The same problem had already been solved one level up: [ADR-0005](0005-external-concept-vocabulary.md)
anchors concept identity to an external vocabulary precisely so that
independently-derived records converge without reconciliation.

## Decision

A source's id is derived from its natural key, in order of stability:

| Key | Basis | Id shape |
|---|---|---|
| DOI | `doi` | `s-doi-<hash>` |
| canonical URL | `url` | `s-url-<hash>` |
| content hash | `content` | `s-cnt-<hash>` |
| none | `random` | `s-loc-<ulid>` |

Two devices canonicalising the same URL arrive at the same id with no
coordination. A source with no natural key keeps a random id, which is
correct: two file imports on two devices genuinely are two things, and merging
them would destroy the distinction.

Sync additionally reconciles on the natural key, for the one case deterministic
ids do not cover: a source captured by URL on one device and by DOI on another
gets ids from different bases. The local id wins and incoming references are
rewritten.

Other attested rows keep ULIDs. An ingestion event, an annotation, a review
and a reading session are all *events on a device*, and two devices recording
their own reading of one article really are two events — exactly what the
union merge rule preserves.

## Consequences

- Sync converges on sources without reconciliation in the common case.
- Source ids are self-describing: the prefix says which basis was used, which
  makes a surprising merge debuggable.
- Ids are no longer time-sortable. Nothing depended on that for sources;
  `first_seen_at` carries the ordering.
- Changing the basis changes the id, so a source that gains a DOI after capture
  keeps its URL-derived id. The natural-key reconciliation covers the resulting
  mismatch across devices.
- A hash is computed per capture. Negligible next to extraction.

## Alternatives considered

**Reconcile purely at merge time.** Keep ULIDs and remap references whenever a
natural key matches. Works, but every device carries a permanent remapping
burden and the reconciliation runs on every pull rather than never.

**Make `canonical_url` the primary key.** Simplest possible, but sources
legitimately have no URL, URLs change, and every foreign key in the schema
would carry a long mutable string.

**Drop the unique index and allow duplicates.** Would have made the symptom go
away and the product wrong: coverage counts distinct sources, so duplicates
would inflate every number the system reports.
