# 0002 — Split all records into attested and derived

**Status:** Accepted

## Context

cognis's stated purpose is to store and organise what the user consumed and
never to generate knowledge on their behalf. Stated as a principle, that erodes:
a summary field appears because it is convenient, model output starts being read
in place of sources, and within a year the corpus is half-fabricated with no way
to tell which half.

At the same time, the product genuinely requires generation — quiz items must be
composed, disambiguation requires judgment — so a blanket ban is not
implementable.

## Decision

Every record is exactly one of:

- **Attested** — this happened. User actions, capture events, device telemetry,
  user-authored annotations, review outcomes, user corrections. Append-only.
  Corrections are new rows, never overwrites.
- **Derived** — this was computed. Extracted text, chunks, embeddings, concepts,
  mentions, coverage, quiz items, memory state, suggestions. Carries
  `producer`, `producer_version`, `model_id`, `prompt_version`, `computed_at`.
  Freely deletable and rebuildable.

The invariant: **any derived table can be dropped entirely and rebuilt from
attested tables plus external data.** If it cannot, it is misclassified.

Two corollaries that are easy to get wrong and are therefore stated explicitly:

1. **Quiz outcomes are attested although quiz items are derived.** Reviews
   snapshot the prompt text and target concept so item regeneration never
   orphans history.
2. **User corrections to derived data are attested**, and are re-applied as an
   override layer after every rebuild.

## Consequences

- Model churn is a rebuild, not a migration crisis.
- Backup priorities are obvious: attested is irreplaceable, derived is a cache.
- Deletion is clean, because derived rows are all reachable from their sources.
- The "never generate" rule becomes checkable in review: *which class is this,
  and can it be rebuilt?*
- Costs some denormalisation (review snapshots) and the discipline of stamping
  every derived row with its producer.
- The rebuild path must re-apply user overrides. Forgetting this is a data-loss
  bug, and it needs a test that a rebuild cannot pass without.

## Alternatives considered

**One table class with an `is_generated` flag.** Too weak. It does not force
rebuildability, and flags get set wrong and then ignored.

**Never store generated content at all.** Would make quizzing impossible.
Generation is fine; generated content entering the *corpus* is not.

**Event sourcing throughout.** The attested tables already are an event log for
the part that needs it. Full event sourcing of derived state would add
significant machinery for state that is deliberately disposable.
