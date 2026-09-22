# 11 — Roadmap

## The ordering principle

cognis is three products stacked: a capture pipeline, a semantic graph, and a
learning-science analytics engine. The third is worthless until the first has run
for months, because it needs longitudinal data that only accrues in real time and
cannot be backfilled.

So the early milestones have one job: **earn the data, reliably, cheaply, and in
a form that survives every later change of mind about models.**

Two ordering choices are deliberate and worth defending:

- **Quizzing (M3) ships before the reader (M5).** Quizzing is the only feature
  that *generates* data the rest of the system consumes; the reader mostly
  duplicates capture the share sheet already handles. The reader's unique
  contribution is telemetry, which is only worth having once something consumes
  it. See [ADR-0007](adr/0007-share-sheet-before-browser.md).
- **The graph view ships late and small.** It is the most demoed and least used
  feature in this product category. The taxonomy tree in M2 delivers most of its
  real value at a fraction of the cost.

## M0 — Skeleton and attested core

**Goal:** never lose a reading event again. No AI at all.

- Schema, migrations, `@cognis/core` package skeleton, injected ports
- Share-sheet capture → `source` + `ingestion_event`
- Extraction (HTML via Readability in a WebView; PDF text layer)
- URL canonicalisation, DOI resolution, dedup
- Local SQLite, encrypted at rest
- Full export (SQLite + JSONL) and verified deletion
- A minimal list UI: what I captured, when

**Done when:** a month of real capture round-trips through export and re-import
with zero attested rows lost, including from failed extractions.

**Why first:** everything downstream is recomputable; this is not.

## M1 — Chunking, embeddings, novelty

**Goal:** the first genuinely useful signal, with no model spend.

- Chunking with section paths; `document_version` versioning
- On-device embeddings via ONNX; `sqlite-vec`; `model_id` recorded per vector
- **Novelty at ingest** and the prior-coverage card at share time
- Semantic search over the corpus
- Re-embed as a scoped rebuild (exercise the rebuild machinery early)

**Done when:** sharing an article immediately answers *have I seen this before,
and what does it resemble?* — offline.

## M2 — Concept identity and coverage

**Goal:** the knowledge layer, with stable identity.

- Candidate spotting and vocabulary candidate generation (Wikidata first)
- Disambiguation via the model proxy, batched, with `is_primary`
- Local concepts, consolidation proposals, user merge/split/reject
- Coverage rollup; the `uncoveredButRecurring` query
- **Taxonomy tree view** — the hierarchy comes free from external anchoring
- Labelled eval set (≥200 mentions) and a linking precision/recall report

**Done when:** `uncoveredButRecurring` returns results the user recognises as
real blind spots, and a relink with a different model leaves node identity intact.

**Risk:** this is the hardest milestone. Budget for linking quality to need two
or three iterations, and do not proceed to M3 on a linker whose precision has not
been measured.

## M3 — Retention engine

**Goal:** start the flywheel. This is where cognis becomes itself.

- Item generation (`free_recall` and `cloze` first) with evidence spans
- Grading with rubric points and stored raw answers
- FSRS-family scheduler, pinned and versioned; prediction stored per review
- Daily-budget session assembly with interleaving
- Notification scheduling (core infrastructure, not polish)
- Calibration report from day one
- Honest-presentation rules enforced via `evidenceSufficient`

**Done when:** the user has answered 100 items across ≥6 weeks and the
calibration report is populated — the first moment any retention claim is
defensible.

## M4 — Suggestions

**Goal:** the coverage frontier, cheaply.

- Citation-graph ingest for DOI sources (references, cited-by, co-citation)
- Convergent-reference detection
- Structural gaps: mentioned-never-primary, bridges, taxonomy holes
- Ranking with diversity cap and serendipity slot
- Structured reasons rendered client-side
- Embedding neighbours only as fallback

**Done when:** a slate of ten suggestions contains at least three the user calls
non-obvious, and none is a near-duplicate of something already covered.

## M5 — Reader and telemetry

**Goal:** the engagement-depth signal.

- In-app reader with extraction at load
- Dwell/scroll/reversal telemetry with idle and plausibility guards
- Telemetry-derived engagement levels feeding the retention model
- `synthesis` item type, now that multi-source coverage exists
- Neighbourhood graph view

**Done when:** telemetry-derived engagement measurably improves scheduler
calibration versus the default-only baseline. If it does not, that is a real and
publishable finding about the whole premise, and the reader's scope should shrink.

## M6 — Sync and multi-device

- E2E-encrypted sync; union merge for attested rows
- Key setup and recovery UX, with the honest warning about passphrase loss
- Conflict handling for derived data (recompute rather than merge)

## Deliberately deferred

| Thing | Why |
|---|---|
| Global graph view | Unreadable past a few hundred nodes; the tree does the job |
| Stored summaries | Violates the central invariant |
| Chat over the corpus | Commodity; answers the wrong question |
| Social / sharing | Different product, much heavier privacy surface |
| Web and desktop clients | The API contract already permits them; no rush |
| Multi-user or team features | Would change the threat model completely |

## Standing risks

| Risk | Severity | Response |
|---|---|---|
| Concept linking quality is too low to trust | fatal | Measure from M2; do not build on an unmeasured linker |
| User stops answering quiz items | fatal to the analytics | Small budgets, high-value item types, no backlog punishment |
| Extraction long tail eats the schedule | high | Share sheet first; failures are recorded, not fought |
| Model costs exceed willingness to pay | high | Batch everything deferrable; measure early ([08](08-llm-integration.md)) |
| Scope creep into a note-taking app | high | The non-goals in [00](00-vision-and-scope.md) are the defence |
| Graph view consumes a milestone for a screenshot | medium | Bounded views only |
