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

**M0 in progress** — the attested core is implemented and tested. See
[11-roadmap.md](docs/11-roadmap.md) for what M0 covers and what comes next.

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

Extraction and the UI are client concerns: core defines the ports and owns the
state machine, and the client supplies the WebView extractor. See
[ADR-0003](docs/adr/0003-stack-selection.md).

## Development

```bash
npm install
npm run check      # typecheck + build + test
```

Requires Node ≥ 22.5 (the tests use the built-in `node:sqlite` and
`node:test`). The core package itself has **zero runtime dependencies** —
deliberate, since it must also run inside a mobile JS runtime.

```
src/
  types.ts          domain types, attested/derived split
  ids.ts            ULID
  ports/            SqlDriver, Clock — injected, never imported concretely
  adapters/         node:sqlite driver (dev/test; device uses a JSI binding)
  db/               schema migrations and the forward-only runner
  canonical/        URL, DOI and content-hash normalisation
  capture/          the attested write path, prior coverage, deletion
  export/           JSONL export/import and the table manifest
  core.ts           the facade from docs/10-api-contract.md
```

Start with [00-vision-and-scope.md](docs/00-vision-and-scope.md), then
[11-roadmap.md](docs/11-roadmap.md).
