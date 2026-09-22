# 09 — Privacy and Security

## Threat model

The cognis database is a longitudinal record of everything its user reads,
how long they spent on it, what they highlighted, what they could not remember,
and — through the concept graph — what they are currently interested in and how
their interests have changed over years.

That is a more intimate dataset than a browser history, because it carries
comprehension and intent, not just URLs. Treat the whole corpus as sensitive by
default. The design consequences:

| Adversary | Concern | Mitigation |
|---|---|---|
| Lost or stolen device | Full corpus readable | OS-level encryption + app-level DB encryption, key in the secure enclave / keystore |
| cognis backend operator | Could read corpus if it passed through | Backend never stores plaintext corpus; sync is end-to-end encrypted |
| Model provider | Sees content sent for linking/grading | Explicit, logged, minimised, and switchable off per source |
| Network observer | Sees what is being read | TLS; metadata proxying for scholarly lookups |
| Another app on device | Reads the DB file | Sandboxed storage, no world-readable exports |
| Legal compulsion against the backend | Nothing useful to hand over | The backend holds only ciphertext and job state, by design |

## Local-first, with an explicit egress boundary

The device is authoritative ([ADR-0004](adr/0004-local-first-sqlite.md)). Content
leaves it in exactly three cases, and never any other:

| Egress | What leaves | Avoidable? |
|---|---|---|
| Concept linking | Chunk text + candidate list | Yes — per-source, or globally at the cost of the feature |
| Item generation / grading | Source spans; the user's answer | Yes — same |
| Scholarly metadata | A DOI or a normalised title | Largely: batched and proxied so the provider sees the backend, not a user |

Sync moves ciphertext only and is not an egress of content.

### Rules

1. **Every egress is logged, attested, and visible to the user.** The
   `egress_log` table ([02](02-data-model.md)) records what was sent, where, why,
   how much, and what was redacted. A settings screen renders it. Users of a
   system that reads over their shoulder are entitled to an accurate account of
   where that reading went — and writing the log to an attested table means the
   engineering cannot quietly drift away from the stated boundary.
2. **Per-source private flag.** Marking a source private excludes it from all
   egress permanently. It is still ingested, chunked, embedded on-device, counted
   in coverage and searchable — it simply never gets linked or quizzed by a
   remote model. The degradation is graceful and visible.
3. **Domain denylist, on by default.** Banking, health portals, webmail,
   internal corporate hosts, and anything behind an authenticated session that
   looks transactional are auto-marked private. The default posture for an
   unrecognised authenticated page is private, not public.
4. **Redaction before egress.** Strip credentials and session tokens from URLs,
   drop `Authorization`-bearing context, and remove obvious PII patterns from
   chunk text. Record what was stripped in `egress_log.redactions`.
5. **Minimise.** Send the chunk, not the document. Send the span, not the source.
   Send a DOI, not a reading timestamp.
6. **A local-only mode must exist and must work.** On-device embeddings, novelty,
   coverage, search, timeline and taxonomy views all function with zero network.
   Linking falls back to vocabulary lookup without disambiguation; quizzing is
   limited to user-authored items. The product is diminished but coherent — the
   privacy-maximal configuration is a supported configuration, not a broken one.

## Sync

End-to-end encrypted, or absent. There is no middle option in which the server
can read the corpus.

- Content key derived from a user passphrase, held in the device keystore; the
  passphrase never leaves the device.

  **Known deviation.** The portable implementation uses PBKDF2-SHA256 at
  600,000 iterations, because that is the strongest KDF Web Crypto offers and
  core must run in a mobile JS runtime. PBKDF2 is compute-hard but **not**
  memory-hard, which makes it materially cheaper to attack with GPUs or ASICs
  than Argon2id. Key derivation is therefore a port: a device build should
  inject Argon2id via a native module or WASM, and the KDF identifier is
  recorded in the keyset so a corpus encrypted under one can be recognised and
  re-wrapped rather than silently failing to open. Until that is done, the
  passphrase strength requirement is correspondingly higher.
- Content encryption is AES-256-GCM, which is authenticated: a tampered blob
  fails to decrypt rather than decrypting to plausible garbage.
- The relay stores opaque blobs plus the minimum metadata needed to order them.
- Conflict resolution is last-writer-wins per row for derived data (recomputable
  anyway) and **union for attested data** — two devices that each recorded a
  reading event both happened, and neither may overwrite the other.
- Losing the passphrase means losing the sync history. Say so plainly at setup
  rather than adding a recovery path that reintroduces server-side access.

## Keys and credentials

- **No provider API key ever ships in the app binary.** Keys in a mobile app are
  extractable from any installed copy; assume anything in the binary is public.
  All model calls go through the backend proxy ([01](01-architecture.md)).
- The proxy authenticates the user, enforces per-user quotas, and is the only
  component holding provider credentials.
- Quotas are a security control, not only a billing one: a compromised client
  otherwise becomes an open-ended bill.

## Data rights

- **Export** — complete, documented, open: the SQLite file plus a JSON Lines dump
  with a published schema. Attested records export losslessly. Export must be
  able to run offline and must not require the backend.
- **Delete** — deleting a source cascades to every derived row that referenced it,
  and concepts left with zero mentions are garbage-collected. Deletion is real
  deletion, not a flag.
- **Delete a concept's history** — removes mentions, memory state and reviews for
  that concept, leaving the sources intact.
- **Account deletion** removes backend state entirely; the local corpus survives
  because it was never the backend's.
- **No telemetry by default.** If product analytics are ever added, they are
  opt-in, aggregate, and may never include source URLs, concept ids, titles or
  review content.

## Content and copyright

Extracted text is stored for the user's own retrieval. cognis does not publish or
share corpus content, and there is no social or sharing surface in this design.
If one is ever added, it must share *coverage facts and citations*, never stored
article text.

## Security checklist for implementation

- [ ] DB encrypted at rest; key in secure enclave / Android keystore
- [ ] No provider credentials in the client binary or in any client-side config
- [ ] Certificate validation enforced; no TLS bypass in any build configuration
- [ ] Egress log written **before** the request, not after
- [ ] Private-flag and denylist checks in the transport layer, not the caller —
      a new call site must not be able to forget them
- [ ] Redaction unit-tested against a fixture corpus of URLs with credentials
- [ ] Export verified to round-trip on a fresh install
- [ ] Deletion verified to leave no orphaned chunks, vectors, mentions or reviews
