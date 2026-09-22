# 12 — Evaluation

A PKM that reports numbers nobody has validated is worse than one that reports
none, because the numbers get believed. This document defines what has to be
measured, against what, before each component is allowed to influence what the
user sees.

## Principle

Every component that produces a number the user acts on must have a held-out
evaluation that can fail. "It looks right in testing" is not an evaluation for
concept linking, quiz quality, or retention prediction.

## 1. Extraction

**Set:** 50 URLs frozen at project start, chosen to be nasty — paywalls, JS-only
rendering, infinite scroll, AMP, PDFs behind redirects, syndicated duplicates,
non-English, a long-form academic PDF, a scanned PDF.

**Metrics:** proportion yielding usable main content; proportion where the
extracted text loses a section present in the original; proportion of failures
correctly marked `extraction_failed` rather than silently producing junk.

**Gate:** a silent junk extraction is worse than a clean failure, and is counted
as a defect, not a miss.

## 2. Concept linking — the one that matters most

**Set:** ≥200 mentions hand-labelled across ≥20 documents spanning the user's
actual reading mix, with deliberate hard cases: ambiguous acronyms, a concept
with a common-word surface form, near-synonyms that must *not* merge, genuine
NILs, and a concept named differently in three sources.

**Metrics:**

| Metric | Why |
|---|---|
| Linking precision | A wrong link corrupts coverage for every downstream query |
| Linking recall | A missed link makes coverage under-report |
| NIL accuracy | Over-eager anchoring is how the graph fills with wrong nodes |
| `is_primary` accuracy | Coverage is meaningless if mentions and primaries blur |
| **Identity stability** | Re-run with a different model: what fraction of concept ids are unchanged? |

Identity stability is the one that validates the core architectural bet
([ADR-0005](adr/0005-external-concept-vocabulary.md)). Target: essentially 100%
for externally anchored concepts. Any drift there is a bug in anchoring, not a
model quality issue.

**Gate:** precision is the primary metric, and no relink ships that lowers it,
however much better the new model is elsewhere. Re-run this eval on every change
to the linker prompt, the candidate generator, the model, or the effort setting.

## 3. Quiz item quality

**Metrics:**

| Metric | Method | Target |
|---|---|---|
| Groundedness | Is the answer locatable in the cited spans? | ~100%; failures are defects, checked at generation |
| Surface-form leakage | Can it be answered by pattern-matching the chunk without understanding? | low; sample-audited |
| User-rated usefulness | Thumbs on a sample | tracked over time, not optimised |
| Retirement rate | Items retired for anomalous pass rates | a rising rate means generation regressed |

Groundedness is checkable automatically and should gate generation: an item whose
rubric points cannot be located in the corpus never reaches the user.

## 4. Grading

**Set:** ~100 real user answers, graded by hand, held out.

**Metrics:** agreement with human grades; systematic bias (the failure mode is
leniency, which silently inflates the retention model); stability — the same
answer graded twice should not land in different rating bands.

**Live signal:** `user_grade_override` rate, per rubric and overall. A cluster of
overrides on one item is a bad item; a global rise means the grader drifted.

## 5. Scheduler calibration — the honest-metrics gate

Every review stores the model's `predicted_recall` at presentation time. That
makes calibration directly measurable:

- Bin predictions (e.g. ten bins), compare predicted against observed success.
- Report a reliability diagram plus a Brier score.
- Track it over time, per parameter version.

**This is the gate for the entire retention feature.** Until there is enough data
for a populated calibration report, the UI shows exposure and evidence — last
contact, coverage, recent outcomes — and not a modelled retention figure. That is
what `RetentionEvidence.evidenceSufficient` enforces in the API
([10](10-api-contract.md)).

A well-calibrated model that is only modestly accurate is useful and honest. A
confident, badly-calibrated one is the failure mode this whole design exists to
avoid.

## 6. Suggestions

**Metrics:**

| Metric | Method |
|---|---|
| Non-obviousness | User marks each suggestion obvious / non-obvious |
| Redundancy rate | Proportion already covered; should be near zero |
| Cluster concentration | Proportion from the largest cluster; the diversity cap must hold |
| Acted-on rate | Tracked, **explicitly not optimised** |

Acted-on rate is diagnostic only. Optimising it converts the suggestion engine
into an engagement feed, which [06](06-suggestion-engine.md) forbids.

## 7. Cost

Measure with `messages.count_tokens` against real ingested documents, per stage,
per version:

- tokens and dollars per article, per review, per full relink
- cache hit rate (`usage.cache_read_input_tokens`) — a zero here means the
  caching design is doing nothing and nobody noticed
- batch share of total spend

The estimates in [08](08-llm-integration.md) are estimates until this runs.

## 8. The product test

The one that overrides all the others. At six months of real use, can the system
answer the five questions in [00](00-vision-and-scope.md) § The falsifiable
success test — with numbers the above evaluations say are trustworthy?

A secondary signal worth watching honestly: does the user still answer quiz item
number 40? The analytics layer's fatal risk is not technical.

## Regression discipline

| Change | Re-run |
|---|---|
| Linker model / prompt / effort | §2 in full; ship only on precision parity or better |
| Embedding model | §2 identity stability, novelty distribution sanity |
| Item generation prompt | §3, plus groundedness gate |
| Grader rubric or model | §4, and reset the override-rate baseline |
| Scheduler params | §5 recomputed from the review log over the full history |
| Ranking weights | §6 on a fixed slate |

Store eval results in-repo with the version they measured. An evaluation whose
history is lost cannot show regression, which is most of its value.
