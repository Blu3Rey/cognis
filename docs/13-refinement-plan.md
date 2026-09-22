# 13 — Refinement plan

A survey of the codebase as of the CLI landing, with a prioritised plan. Every
finding below cites evidence from the code rather than a general principle.

## The thing to say first

**None of this is the project's biggest risk.** The linker's precision is still
unmeasured, no real corpus has been through the pipeline, and two evaluation
harnesses have never been run against real data. Polishing the code while that
is true optimises the wrong thing: some of the abstractions below will turn out
to be wrong once real reading goes through the system, and refactoring them now
means refactoring them twice.

The plan is therefore sequenced so that **cheap, high-certainty work lands
first**, and the large structural changes wait until real usage has told us
which shapes are actually wrong. Phase 0 is not part of the refinement — it is
the reminder that it comes first.

## Where the code stands

| | Lines | Files |
|---|---|---|
| `packages/core/src` | 10,669 | 76 |
| `packages/core/test` | 4,278 | 33 |
| `packages/cli/src` | 2,489 | 15 |
| `packages/cli/test` | 996 | 5 |
| `docs` | 2,786 | 23 |

220 tests, typecheck clean under `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes`. Two runtime dependencies in core (`ts-fsrs`), a
handful in the CLI.

The shape is sound. What follows is about the seams.

---

## A. Correctness — fix now, cheap and real

### A1. Cost reporting is wrong for any non-default model

`estimateCost()` hardcodes Claude Opus 5 rates, but the CLI exposes
`--linker-model`. Pointing the linker at Sonnet 5 reports a cost 2.5× too high.

**Fix:** take the model id, keep a small rate table, and refuse to guess for an
unknown model rather than silently using Opus rates.
*Effort: 30 minutes. Value: high — a wrong money number is worse than none.*

### A2. `applyOverrides` requires a transaction it cannot enforce

It performs four writes and documents "runs inside the caller's transaction",
but nothing checks. A future caller that forgets gets a partial override
application — the exact failure mode `docs/04` calls sacred.

**Fix:** either open a savepoint internally (the driver already supports nested
transactions) or take a branded `TransactionHandle` so the type system carries
the requirement.
*Effort: 1 hour. Value: high — it protects the invariant most costly to break.*

### A3. Ten `catch {}` blocks, mixed intent

Some are deliberate and documented (cache miss, unparseable URL). Others
swallow anything — `wikidata-vocabulary.ts` treats a cache write failure and a
programming error identically.

**Fix:** a one-line `ignore(reason)` helper so every swallow states why, and an
audit that converts the ones that should not be silent.
*Effort: 1 hour. Value: medium.*

### A4. `parseArgs` mis-handles values starting with `-`

`--limit -5` sets `limit` to boolean `true` and pushes `-5` into positionals.
No current command takes a negative argument, so this is latent rather than
live — but it is user-facing input parsing with **no direct test at all**.

**Fix:** treat the token after a known value-taking flag as a value regardless
of its first character, and add a test file for `args.ts`.
*Effort: 1 hour. Value: medium.*

---

## B. Duplication — the dangerous kind and the harmless kind

### B1. `centroid()` is byte-identical in two files

`concept/consolidate.ts` and `suggest/neighbours.ts` contain the same 20-line
function, character for character, including the SQL. A fix to one silently
leaves the other wrong.

**Fix:** extract to `embed/centroid.ts`.
*Effort: 20 minutes. Value: high — this is the cheapest real win in the list.*

### B2. Six different `normalise()` functions

`canonical/doi.ts`, `concept/spotter.ts`, `concept/consolidate.ts`,
`adapters/fixture-vocabulary.ts`, `adapters/rule-linker.ts` and
`cli/adapters/extractor.ts` each define a private `normalise`. **They are not
the same function** — some lowercase, some strip punctuation, one does
morphological flattening, one collapses whitespace only.

This is worse than the identical duplication above, because a reader who has
seen one assumes they all behave alike. Two of them feed concept identity.

**Fix:** a `text/normalise.ts` exporting explicitly named variants —
`foldCase`, `collapseWhitespace`, `stripPunctuation`, `singularise` — composed
at each call site so the behaviour is visible where it is used.
*Effort: 2 hours. Value: high — it removes a genuine correctness trap.*

### B3. `tokenise()` twice, `count` helpers three times

Same treatment, lower stakes.

---

## C. The SQL boundary — the biggest maintainability lever

**84 inline anonymous row types across 75 raw SQL call sites.** Every column
name is a string literal with no connection to the schema. Renaming
`ingestion_event.engagement` today means finding every occurrence by grep and
hoping; nothing fails at compile time, and most failures surface at runtime in
one of 75 places.

This is the single largest source of future breakage, and it is invisible right
now because the schema has been stable and one person wrote all of it.

**Options, in increasing weight:**

1. **A column-name registry.** `const SOURCE = { id: 'id', canonicalUrl:
   'canonical_url', … } as const`, used in template strings. Cheap, ugly,
   catches renames.
2. **Row types derived from one schema declaration**, with the migration SQL
   generated from it. Removes the drift between DDL and TypeScript entirely.
3. **A typed query helper** — a tagged template that knows table shapes.
   Powerful, and a large surface to maintain for a project this size.

**Recommendation: (2).** The schema is already declared once in migrations; a
single typed declaration that emits both the DDL and the row types eliminates a
whole class of bug and is a day's work. Do **not** build (3) — a hand-rolled
query builder is a project of its own, and the SQL here is legible and worth
keeping visible.

*Effort: 1 day. Value: highest long-term. Sequence: after real usage settles
the schema.*

---

## D. Performance — currently fine, will not stay fine

Nothing here matters at 100 documents. All of it matters at 10,000, and none of
it has ever been measured.

| Finding | Location | Cost at scale |
|---|---|---|
| 9 per-row `INSERT` loops | rollup, pipeline, citations, rank, structural, items, overrides, embed | one round trip per row |
| Coverage rollup deletes and rebuilds the whole table | `coverage/rollup.ts` | O(corpus) on every link |
| `uncoveredButRecurring` runs a query per gap | `coverage/queries.ts` | N+1 |
| `neighbourCandidates` computes a centroid per target | `suggest/neighbours.ts` | up to 220 queries per slate |
| `scanVectors` is a linear scan | `embed/store.ts` | documented; needs sqlite-vec |

**Fix:** batch inserts via multi-row `VALUES` or a reused prepared statement;
fold the N+1s into joins; memoise centroids within a run.

**Prerequisite: a benchmark.** There is currently no test that runs the
pipeline over a large corpus, so any optimisation would be unmeasured. Write
`bench/` with a synthetic 10k-document corpus first, then optimise what it
shows — not what this table guesses.
*Effort: 1 day for the benchmark, 1 day for the fixes. Value: high, but not yet.*

---

## E. Structure — the god objects

### E1. `Cognis` has 73 methods across 760 lines

It is the largest file in the project and grows with every milestone. It is
still *coherent* — it is pure delegation — but it is the kind of file nobody
reads, and the API contract it implements is now a flat list of 73 unrelated
operations.

**Fix:** namespace it by concern, keeping delegation:

```ts
cognis.capture.ingest(...)      cognis.concepts.link(...)
cognis.retention.due(...)       cognis.privacy.egressLog(...)
cognis.suggest.generate(...)    cognis.sync.push(...)
```

This is a breaking change to the API contract, so it wants doing **once**, and
`docs/10` updated with it. *Effort: half a day.*

### E2. `index.ts` exports 110 symbols

Everything internal is public, which means everything is frozen. The intended
public surface is perhaps 30 of those.

**Fix:** a small curated barrel plus deep imports (`@cognis/core/eval`) for
advanced use. Requires `exports` map work in `package.json`.
*Effort: 2 hours.*

### E3. `main.ts` is a 460-line switch with a 123-line case

**Fix:** a command registry — one module per command exposing
`{ name, describe, flags, run }`, with help generated from it rather than
hand-maintained. The help text and the actual flags can currently drift, and
have.
*Effort: half a day. Value: high for the CLI's growth rate.*

---

## F. Conventions and tooling

### F1. No linter, no formatter, no editorconfig

Style has held only because one author wrote everything in one voice. A second
contributor, or a six-month gap, ends that.

**Fix:** ESLint with `@typescript-eslint` (strict + type-checked), Prettier,
`.editorconfig`, all wired into `npm run check` and CI. Rules worth enforcing
specifically for this codebase: no floating promises, no misused promises,
consistent type imports, exhaustive switch checks.
*Effort: 2 hours. Value: high — it is the cheapest durable quality floor.*

### F2. Nine `*_VERSION = '1.0.0'` constants with no bump rule

Every derived pipeline stamps its output with a producer version, which is the
mechanism that makes rebuilds scoped. Nothing says when to bump one, and none
has ever been bumped — including when the spotter changed materially in M2.

**That is a live correctness gap**, not a style one: the n-gram spotter change
altered every mention it produced, and existing rows kept the old version.

**Fix:** a single `PRODUCER_VERSIONS` registry, a documented rule ("bump when
the output for unchanged input would differ"), and a test that fails when a
producer's output changes without its version changing — a golden-file test
over a fixture corpus.
*Effort: half a day. Value: high.*

### F3. `...(x ? { y } : {})` appears 14 times

A symptom of `exactOptionalPropertyTypes`, which is worth keeping. A tiny
`optional({ y })` helper removes the noise without weakening the setting.
*Effort: 30 minutes.*

### F4. No CHANGELOG, no CONTRIBUTING

Both matter the moment anyone else touches this, and the ADRs already carry the
"why" a CONTRIBUTING would point at.

---

## G. Test strategy

220 tests is good coverage of behaviour. Three gaps:

### G1. The public surface exceeds what is pinned

~35 exported functions have no test that names them. Most are covered
indirectly through the facade — `semanticSearch` via `cognis.search`, for
instance — so this is not "untested code". It does mean the *public contract*
of those functions is not pinned: an internal refactor can change them freely
while the facade test still passes.

Genuinely untested, with no indirect coverage: `staleCoverage`,
`anomalousItems`, `dueCountOn`, and all of `args.ts`.

### G2. No property-based tests where they would pay

Three invariants are stated in the design and checked only by example:

- `mergeRow` commutativity (sync convergence depends on it)
- chunk offsets always resolving to real spans (evidence anchoring depends on it)
- export/import round-trip over arbitrary corpora

Each is a natural property test. `fast-check` would cover far more ground than
the fixtures do. The base64 test already works this way — every length 0–128 —
and that is exactly the test that caught a real bug.

### G3. No scale test

Nothing demonstrates the system works at a realistic corpus size. See D.

---

## H. Documentation

Mostly healthy — 23 documents, all links resolve, ADRs current. Two items:

- One stale path in `README.md` (`src/eval/engagement.ts`, now under `packages/core/`).
- The only automated docs↔code guard is the export-manifest check. The
  API-contract drift that was found manually could be caught the same way: a
  test asserting every method named in `docs/10` exists on `Cognis`.

---

## Sequencing

**Phase 0 — before any of this.** Run the corpus. Ingest real reading, build
the labelled linking set, run the two evaluations. The refinement below is
worth more after that, and some of it will change shape because of it.

**Phase 1 — a day, no structural risk.** A1–A4, B1–B3, F1, F3, H. Bug fixes,
deduplication, linting, docs. All independently valuable, none of it constrains
later work.

**Phase 2 — two days, once the schema has settled.** F2 (producer versions and
the golden-file test), G1 and G2 (pin the public surface, add property tests),
E3 (CLI command registry).

**Phase 3 — a week, once real usage has shaped the design.** C (schema as one
declaration), D (benchmark then optimise), E1 and E2 (facade namespacing, curated
exports). These are the changes that are expensive to get wrong, and cheaper to
do once.

## Explicit non-goals

- **A query builder or ORM.** The SQL is legible and worth keeping visible.
- **Dependency injection framework.** The port pattern already does this job.
- **100% coverage.** Coverage is not the gap; pinned contracts are.
- **Splitting core into more packages.** Two is right for now.
- **Abstracting the adapters further.** The ports are the abstraction; a second
  layer would be ceremony.
