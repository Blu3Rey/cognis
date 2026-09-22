# cognis

A personal knowledge management system that **stores and organizes what you have
read — it never generates knowledge on your behalf.**

cognis keeps a durable, provenance-carrying record of the material you consume,
resolves that material to stable concepts, tracks how thoroughly and how recently
you have covered each one, and tests whether you still understand it.

## The one-sentence scope

> cognis answers questions about *your own coverage* that no search engine can
> answer, because only cognis knows what you actually read, when, how deeply, and
> whether you could still explain it a month later.

The design target is a question like:

> *"Which concepts have I encountered from three or more independent sources but
> never written about, never been quizzed on, and not seen in four months?"*

If a feature does not help answer a question of that shape, it is out of scope.

## Invariants

These are architectural constraints, not aspirations. Each is enforced in the
schema and in review.

1. **Never generate knowledge.** No model-authored text ever becomes a node,
   an edge, or corpus content. See [ADR-0002](docs/adr/0002-attested-vs-derived.md).
2. **Every record is either attested or derived.** Attested records are what
   actually happened and are append-only. Derived records are recomputable and
   are always deletable and rebuildable from attested records alone.
3. **Concept identity is external.** Concepts are anchored to stable public
   identifiers wherever possible, so re-running extraction with a new model
   changes the *evidence*, never the *identity*. See [ADR-0005](docs/adr/0005-external-concept-vocabulary.md).
4. **No metric is presented as a verdict.** Retention estimates are shown with
   their evidence and their calibration, never as a bare score. See
   [docs/05-retention-engine.md](docs/05-retention-engine.md).
5. **The user's corpus is the user's.** Local-first storage, an explicit and
   auditable egress boundary, full export, real deletion. See
   [docs/09-privacy-and-security.md](docs/09-privacy-and-security.md).

## Documentation

| Doc | Covers |
|---|---|
| [00-vision-and-scope.md](docs/00-vision-and-scope.md) | What cognis is and is not; the falsifiable success test |
| [01-architecture.md](docs/01-architecture.md) | Components, data flow, stack, deployment |
| [02-data-model.md](docs/02-data-model.md) | Full schema, attested/derived split, provenance |
| [03-ingestion.md](docs/03-ingestion.md) | Capture paths, extraction, telemetry, dedup |
| [04-concept-identity.md](docs/04-concept-identity.md) | Entity linking, drift control, user corrections |
| [05-retention-engine.md](docs/05-retention-engine.md) | Quizzing, scheduling, grading, honest metrics |
| [06-suggestion-engine.md](docs/06-suggestion-engine.md) | Citation graph, coverage gaps, anti-filter-bubble |
| [07-graph-views.md](docs/07-graph-views.md) | Neighborhood, taxonomy, and timeline views |
| [08-llm-integration.md](docs/08-llm-integration.md) | Models, prompts, caching, batching, cost |
| [09-privacy-and-security.md](docs/09-privacy-and-security.md) | Threat model, egress boundary, keys, deletion |
| [10-api-contract.md](docs/10-api-contract.md) | The surface the mobile client consumes |
| [11-roadmap.md](docs/11-roadmap.md) | Milestones and build order |
| [12-evaluation.md](docs/12-evaluation.md) | How we know any of this works |
| [adr/](docs/adr/) | Architecture decision records |

## Status

**M0 complete, M1 complete** in core. See
[11-roadmap.md](docs/11-roadmap.md) for what each milestone covers.

| M0 item | State |
|---|---|
| Schema, migrations, core package, injected ports | done |
| Capture → `source` + `ingestion_event` | done |
| URL canonicalisation, DOI resolution, dedup | done |
| Export (JSONL) and verified deletion | done |
| Extraction *storage* path and failure recording | done |
| Extraction *implementation* (Readability, PDF text layer) | client-side, not started |
| Encryption at rest | not started |
| Minimal list UI | client-side, not started |

| M1 item | State |
|---|---|
| Chunking with section paths | done |
| Embedding behind an injected port; `model_id` per vector | done |
| Novelty at ingest and the prior-coverage card | done |
| Semantic and literal search | done |
| Re-embed as a scoped rebuild | done |
| ONNX embedder | device-side, not started |
| `sqlite-vec` ANN index | device-side; portable brute-force scan in place |

| M2 item | State |
|---|---|
| Candidate spotting (proper nouns, acronyms, definitions, n-grams) | done |
| Vocabulary candidate generation behind a port | done |
| Disambiguation behind a port, with `is_primary` | done |
| Local concepts and consolidation proposals | done |
| User merge / split / reject, re-applied after every rebuild | done |
| Coverage rollup and `uncoveredButRecurring` | done |
| Taxonomy tree from vocabulary hierarchy | done |
| Linking eval harness (precision, recall, NIL, identity stability) | done |
| **≥200-mention labelled eval set** | **seed set only — see [eval/README.md](eval/README.md)** |
| Wikidata client; model-backed linker | **done in the CLI** — see [packages/cli](packages/cli) |

| M3 item | State |
|---|---|
| Item generation with evidence spans and a groundedness gate | done |
| Grading with rubric points; raw answers stored verbatim | done |
| FSRS scheduler, pinned and versioned; predictions stored per review | done |
| Daily-budget session assembly with interleaving | done |
| Calibration report, with excluded reviews disclosed | done |
| Honest presentation enforced via `evidenceSufficient` | done |
| Memory state rebuildable by replaying the review log | done |
| Notification *delivery* (APNs/FCM) | client/backend-side; core computes due times |
| Model-backed item writer and grader | backend-side, not started |

| M4 item | State |
|---|---|
| Citation-graph ingest for DOI sources | done |
| Convergent-reference detection | done |
| Structural gaps: mentioned-never-primary, bridges, taxonomy holes | done |
| Ranking with diversity cap and serendipity slot | done |
| Structured reasons, rendered client-side | done |
| Embedding neighbours as last-resort fallback | done |
| Expiry, dismissal, nothing auto-ingested | done |
| Crossref / OpenAlex client | backend-side, not started |

| M5 item | State |
|---|---|
| Telemetry ingestion with plausibility guards | done |
| Telemetry-derived engagement levels | done |
| Engagement prior feeding the scheduler (a **hypothesis**) | done |
| Counterfactual harness for the falsification test | done |
| `synthesis` item type, gated on two or more sources | done |
| Neighbourhood (ego) graph view | done |
| In-app reader / WebView | client-side, not started |
| **The falsification result itself** | **needs real telemetry — see below** |

| M6 item | State |
|---|---|
| End-to-end encrypted sync (AES-256-GCM) | done |
| Trigger-based change tracking for attested rows | done |
| Order-independent merge rules; convergence tested | done |
| Deterministic source identity ([ADR-0009](docs/adr/0009-deterministic-source-identity.md)) | done |
| Derived data recomputed, never synced | done |
| Passphrase-loss warning, stated plainly | done |
| Argon2id key derivation | **portable fallback is PBKDF2 — see [docs/09](docs/09-privacy-and-security.md)** |
| Relay service; key enrolment UX | client/backend-side, not started |

| Privacy enforcement | State |
|---|---|
| Private sources excluded from every model call | done |
| Sensitive domains auto-marked private at capture | done |
| Egress logged before the request, user-readable | done |
| Credential and secret redaction before egress | done (best-effort, documented) |
| `setSourcePrivate`, `egressLog`, `egressSummary` | done |

Extraction and the UI are client concerns: core defines the ports and owns the
state machine, and the client supplies the WebView extractor. See
[ADR-0003](docs/adr/0003-stack-selection.md).

## Packages

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | The library: schema, pipelines, engines, API contract. Zero runtime dependencies beyond a pinned scheduler. |
| [`packages/cli`](packages/cli) | A real client that gets actual reading through the actual pipeline, and the scripting surface for the evaluations. |

## Development

```bash
npm install
npm run check              # both packages: typecheck, build, test

npm run check -w @cognis/core
npm run check -w @cognis/cli
```

CI runs the same on every push ([.github/workflows/check.yml](.github/workflows/check.yml)).

### Try it

```bash
npm run build -w @cognis/cli
COGNIS_HOME=/tmp/try node packages/cli/dist/src/bin.js ingest https://example.com/article
COGNIS_HOME=/tmp/try node packages/cli/dist/src/bin.js search "something you read"
```

See [packages/cli/README.md](packages/cli/README.md) for enabling real semantic
embeddings, which need one optional dependency.

Requires Node ≥ 22.5 (the tests use the built-in `node:sqlite` and
`node:test`). The core package has exactly one runtime dependency, `ts-fsrs`,
pinned per [ADR-0006](docs/adr/0006-fsrs-scheduling.md) — reproducing years of
spaced-repetition parameter fitting badly is not a saving. The CLI's heavier
dependencies are confined to its own package, which is why the repo is a
workspace.

```
packages/core/src/
  types.ts          domain types, attested/derived split
  ids.ts            ULID
  ports/            SqlDriver, Clock — injected, never imported concretely
  adapters/         node:sqlite driver (dev/test; device uses a JSI binding)
  db/               schema migrations and the forward-only runner
  canonical/        URL, DOI and content-hash normalisation
  capture/          the attested write path, prior coverage, deletion
  chunk/            structural chunking with heading breadcrumbs
  embed/            vector storage, the embed pipeline, novelty
  concept/          spotting, linking, overrides, consolidation
  coverage/         the rollup and the gap queries
  eval/             the linking evaluation harness
  retention/        scheduling, items, grading, calibration, evidence
  suggest/          citation graph, structural gaps, ranking
  reader/           telemetry guards, engagement derivation, the prior
  graph/            bounded neighbourhood queries
  sync/             E2E crypto, change tracking, merge rules
  privacy/          egress chokepoint, domain classification, redaction
  search/           semantic and literal search
  export/           JSONL export/import and the table manifest
  core.ts           the facade from docs/10-api-contract.md

packages/cli/src/
  adapters/         real fetching, Readability extraction, transformers.js,
                    Wikidata vocabulary, Claude linker
  commands/         ingest, index, reporting, doctor
  bin.ts            entry point
```

## Two things to fix before this is used for real

1. **Key derivation is PBKDF2, not Argon2id.** It is the strongest KDF Web
   Crypto offers, it is behind a port, and the deviation is documented — but
   it is a deviation from what [docs/09](docs/09-privacy-and-security.md)
   specifies, and it is the only thing protecting a synced corpus.
2. **Encryption at rest** on the device is still not wired up (open since M0).
   It needs the device SQLite adapter, not core changes.

Plus the two measurements below.

## Two open measurements

Both are built and neither has been run against real data. They are the two
places where this project could still turn out to be wrong, so they are listed
here rather than buried:

1. **Linker precision** (M2). The harness is `packages/core/src/eval/linking.ts`
   and the real linker now exists (`cognis link`), but the labelled set it
   grades against does not. See [eval/README.md](eval/README.md). Everything
   downstream inherits linking quality — coverage numbers, quiz targets,
   suggestion gaps. **This is the most valuable thing left to do.**
2. **Whether reading telemetry helps** (M5). The harness is
   `src/eval/engagement.ts` and runs a counterfactual replay of the review log
   with and without the engagement prior. The prior's multipliers are a
   starting guess, not an established result. If real data says it does not
   improve calibration, the honest response is to neutralise it and shrink the
   reader's scope — which ADR-0007 already anticipates.

Running either against simulated data produces a number that reflects the
simulation, not reality. Both harnesses say so.

Start with [00-vision-and-scope.md](docs/00-vision-and-scope.md), then
[11-roadmap.md](docs/11-roadmap.md).
