# 0006 — Use an existing DSR scheduler, at item scope only

**Status:** Accepted

## Context

cognis needs to decide when to re-test the user on a concept. Spaced-repetition
scheduling is a well-studied problem with mature open-source implementations in
the DSR family (difficulty / stability / retrievability), fit on very large
review datasets.

Two temptations to resist. The first is writing a scheduler, which means
reproducing years of parameter fitting badly. The second is scheduling at
*concept* scope — modelling "how well do you know Bayesian inference" as a single
memory state — which is appealing in the UI and unsupported by the data: the
model is fit on discrete item-level retrieval outcomes, and a concept is not an
item.

## Decision

Use an existing, pinned implementation from the FSRS line. Scheduling operates
at **item scope** only.

Concept-level figures are aggregates over that concept's item states, presented
as a summary of evidence — *3 of 4 items recalled; longest successful interval 21
days* — never as an independently modelled quantity.

Integration requirements:

- `scheduler`, `scheduler_version` and `params_hash` stored on every memory state
- `predicted_recall` stored on every review at presentation time
- memory state is **derived**: recomputable from the review log, which is what
  makes a parameter refit or a scheduler change safe
- the continuous grader score maps to the scheduler's discrete rating through
  versioned, stored thresholds, not a constant in the code
- target retention is a user-visible setting, defaulting around 0.9

## Consequences

- The retention model rests on real fitted parameters rather than a hand-rolled
  curve.
- Storing predictions makes calibration measurable, which is the gate for
  displaying any retention figure at all ([12](../12-evaluation.md) §5).
- A scheduler upgrade is a rebuild from the review log, not a migration.
- Cost: the UI cannot show a single confident "you know this concept" number.
  That is a real product constraint and, given the illusion-of-fluency risk in
  [05](../05-retention-engine.md), the right one.
- Cost: a dependency on an external implementation, mitigated by pinning and by
  the fact that state is recomputable.

## Alternatives considered

**SM-2.** Simpler and well understood, but materially less accurate and without
an explicit retrievability estimate — and retrievability is exactly what the
honest-presentation rules need.

**Write our own model fit on the user's own data.** Interesting much later, when
there is a review corpus; useless at the start, when there is none. Nothing
prevents it: the review log is attested and complete.

**Half-life regression.** Reasonable alternative with a similar shape. FSRS wins
on maturity and available implementations. The port abstraction means swapping is
a rebuild rather than a redesign.

**Concept-scope scheduling.** Rejected as fabricated precision: it would invent a
parameter no review directly measures.
