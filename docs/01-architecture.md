# 01 — Architecture

## Shape

cognis is **local-first**. The device holds the authoritative copy of the corpus
in SQLite. A backend exists for three jobs the device cannot do well — proxying
model calls, fetching external graph data, and relaying encrypted sync — and for
nothing else. The backend is never required for the app to function offline.

```
┌─────────────────────────── DEVICE (source of truth) ───────────────────────────┐
│                                                                                │
│  Capture          Core engine (@cognis/core)            Views                  │
│  ┌──────────┐     ┌──────────────────────────┐     ┌───────────────────────┐   │
│  │ share    │     │ extraction               │     │ neighborhood graph    │   │
│  │ sheet    ├────►│ chunking                 │◄────┤ taxonomy tree         │   │
│  │ reader   │     │ embedding (on-device)    │     │ coverage timeline     │   │
│  │ file/PDF │     │ novelty scoring          │     │ review session        │   │
│  │ import   │     │ coverage rollup          │     │ suggestion inbox      │   │
│  └──────────┘     │ scheduler (FSRS)         │     └───────────────────────┘   │
│                   │ suggestion ranking       │                                 │
│                   └───────────┬──────────────┘                                 │
│                               │                                                │
│                   ┌───────────▼──────────────┐                                 │
│                   │ SQLite + sqlite-vec      │  attested ∥ derived             │
│                   └───────────┬──────────────┘                                 │
└───────────────────────────────┼────────────────────────────────────────────────┘
                                │ explicit, auditable egress only
                   ┌────────────▼─────────────┐
                   │ BACKEND (stateless)      │
                   │  • model proxy           │──► Claude API
                   │  • scholarly graph proxy │──► OpenAlex / Crossref / Wikidata
                   │  • push scheduling       │──► APNs / FCM
                   │  • E2E sync relay        │──► opaque ciphertext blobs
                   └──────────────────────────┘
```

### Why the device is authoritative

The corpus is a behavioural record of everything the user reads and how well
they understand it. Centralising that by default is a poor trade for a product
whose value does not require a server. Local-first also makes the offline reader
trivially correct and makes deletion mean something. See
[ADR-0004](adr/0004-local-first-sqlite.md).

### Why there is a backend at all

1. **API keys cannot ship in a mobile binary.** A client-side Anthropic key is
   extractable from any installed app and becomes an open-ended bill. All model
   calls are proxied. This is non-negotiable.
2. **Scholarly APIs need pooled, polite access** — shared rate limits, a contact
   mail header, and caching. A million clients hitting Crossref directly is both
   rude and slow.
3. **Push notifications require a server-side schedule.** The retention engine
   computes due times on-device, but delivery needs APNs/FCM.
4. **Sync between a user's devices** needs a relay. It relays ciphertext it
   cannot read.

The backend stores no plaintext corpus content. It is a proxy with a queue.

## Components

### `@cognis/core` — the domain package

Platform-agnostic TypeScript. Contains the schema and migrations, the ingestion
state machine, chunking, coverage rollup, the FSRS wrapper, suggestion ranking,
and all provenance bookkeeping. Depends on a storage interface, not on a
specific SQLite binding, so it runs in the app, in the backend, and in tests
under Node.

Everything in this package must be **deterministic given its inputs and its
declared version**. Non-determinism (model calls, network) lives behind
injected ports.

### Ports (injected, never imported directly by core)

| Port | Contract | Device impl | Test impl |
|---|---|---|---|
| `Storage` | SQL + vector search | sqlite-vec | in-memory SQLite |
| `Embedder` | `text[] → Float32Array[]`, carries `model_id` | on-device ONNX | deterministic hash stub |
| `Linker` | `chunk + candidates → mention[]` | backend proxy → Claude | fixture replay |
| `ItemWriter` | `source spans → quiz items` | backend proxy → Claude | fixture replay |
| `Grader` | `answer + source span → grade` | backend proxy → Claude | fixture replay |
| `ScholarGraph` | DOI → references, citations, topics | backend proxy → OpenAlex | fixture replay |
| `Clock` | now | system | injectable fake |

`Clock` is a port because every retention test needs to run against controlled
time. Never call `Date.now()` inside core.

### Pipelines

Ingestion is a state machine per source, resumable and idempotent at every step:

```
captured → extracted → chunked → embedded → linked → rolled-up → itemised
```

Each transition writes derived rows stamped with its producer version, and each
is independently re-runnable. Re-running a stage deletes that stage's output for
the affected source and recomputes it; it never mutates attested rows. Stages
after `embedded` are deferred: they run on charge+wifi or on demand, because
they cost money and battery.

## Stack

The recommendation, with the reasoning and the alternatives in
[ADR-0003](adr/0003-stack-selection.md):

| Layer | Choice |
|---|---|
| Shared core | TypeScript, no runtime framework |
| Mobile app | React Native; a native module for the reader WebView and telemetry |
| Device storage | SQLite via a JSI binding, plus `sqlite-vec` for ANN search |
| On-device embeddings | a small sentence embedding model exported to ONNX |
| Backend | TypeScript on Node or Bun; stateless; Postgres only for sync blobs and job state |
| Model access | Anthropic TypeScript SDK, server-side only |

The single strongest argument for TypeScript throughout is that the coverage
rollup, the scheduler and the ranking logic are the same code on device, on the
server, and in the evaluation harness. Forking that logic across two languages
is how the numbers start disagreeing.

**This is a revisitable decision.** If the reader's telemetry or PDF handling
demands deep native work, Kotlin Multiplatform becomes competitive; if the
concept-linking research loop dominates, a Python backend does. Nothing in the
schema or the API contract depends on the choice.

## Data flow: one article, end to end

1. User shares a URL. The client writes an **attested** `source` (canonicalised
   URL) and an `ingestion_event` with timestamp and capture path. Nothing else
   has happened yet, and this record survives every later failure.
2. Extraction produces a `document_version`: cleaned text, content hash,
   extractor version. If the source changes later, a new version is appended;
   old versions are never edited, because annotations anchor to them.
3. Chunking and on-device embedding. **Novelty is computed at this point** —
   `1 − max cosine similarity` against the existing corpus — and stored on the
   ingestion event. It is cheap, needs no model call, and is one of the more
   interesting numbers the system produces.
4. Concept linking (deferred, costs money): candidate spotting, candidate
   generation against external vocabularies, LLM disambiguation, `mention` rows
   with evidence spans. See [04-concept-identity.md](04-concept-identity.md).
5. Coverage rollup recomputes affected `coverage` rows.
6. Item generation writes quiz items bound to source spans, and the scheduler
   gives each a first due time.
7. Reading telemetry (if the reader was used) lands as `reading_session` rows
   and updates engagement depth.

Steps 4–6 are batchable and are deliberately run overnight at half price. See
[08-llm-integration.md](08-llm-integration.md) § Cost.

## Failure posture

- **Extraction fails** (paywall, bot wall, JS-only page): the source and the
  ingestion event still exist, marked `extraction_failed` with a reason. The
  user's record of having encountered the thing is attested and must never be
  lost because a parser lost.
- **A model call is declined or errors**: the stage is marked failed with a
  reason and retried on the next pass. Never drop the source; never silently
  fall back to a worse pipeline without recording that it happened.
- **Offline**: everything except linking, item generation and grading works.
  Reviews taken offline queue their outcomes; the scheduler runs locally.
- **A derived rebuild is interrupted**: producer-versioned rows make this safe —
  rebuild deletes by `(stage, producer_version, source_id)` and re-runs.
