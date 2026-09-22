# 05 — Retention Engine

## Why this feature is load-bearing

Retention models are fit on **retrieval outcomes**: the learner was asked, at a
known interval, and succeeded or failed. Exposure metadata — timestamps, source
counts, reading time, quality ratings — is not that, and the inference from
exposure to retention is exactly the one the literature does not support.

Quizzing supplies the missing variable. It is therefore not an optional feature
bolted onto a PKM; it is the component that makes every retention claim in the
product legitimate. Without it, cognis may still report *exposure* (last contact,
coverage breadth, spacing of encounters) — but it may not call that retention,
and the schema deliberately makes the distinction hard to blur.

## Item types

Ordered by how much they actually test comprehension:

| Kind | Prompt shape | Tests | Cost |
|---|---|---|---|
| `cloze` | Passage with a term removed | recognition | cheap, weak |
| `free_recall` | "State the core claim of X and the evidence given for it" | recall + articulation | moderate |
| `application` | "Which of these situations does X apply to, and why?" | transfer | expensive |
| `synthesis` | "Two sources you read treat X differently — how?" | integration | expensive, highest value |

`synthesis` items are only possible once a concept has ≥2 primary sources, and
they are the item type no other product can generate, because no other product
knows what else the user read. They are the strongest argument for the whole
architecture and should be weighted accordingly once coverage allows.

**A known generation failure to design against:** items produced from a single
chunk tend to be answerable from that chunk's surface wording, testing recognition
of phrasing rather than understanding. Two mitigations, both cheap: generate from
a wider context window than the item quizzes on, and prefer items whose rubric
points draw on spans from more than one chunk or more than one source.

Every item stores `evidence_json` — the exact spans that justify it. An item
whose answer cannot be located in the corpus is not a hard item, it is a defect,
and it fails generation-time validation.

## Scheduling

Use an existing, well-tested spaced-repetition scheduler in the DSR family
(difficulty / stability / retrievability) rather than reimplementing one. Anki's
FSRS line is the reference implementation with open-source ports.

Requirements on the integration:

- **Pin the version and store it.** `memory_state.scheduler_version` and
  `params_hash` record which implementation and which parameter vector produced
  each due date, so a parameter refit is auditable and reversible.
- **Refit is a rebuild.** Memory state is derived; it can be recomputed from the
  `review` log at any time. This is what makes it safe to change schedulers.
- **Store the prediction.** `review.predicted_recall` is written at presentation
  time. Without it, calibration can never be measured, and an uncalibrated
  retention model is exactly the astrology this design is trying to avoid.
- **Target retention is a user-visible setting**, defaulting around 0.9. It is
  the single knob that trades review volume against forgetting.

### Item scope vs concept scope

Scheduling operates at **item** scope, where the model is valid. Concept-level
figures are an aggregate over that concept's items, and are presented as a
summary of evidence — *3 of 4 items recalled; longest successful interval 21
days* — never as an independent modelled quantity. Inventing a concept-level
stability parameter that no review directly measures would be fabricating
precision.

### Session assembly

Given the set of due items, build a session that respects three constraints:

1. **A daily budget.** Overdue backlogs are how spaced-repetition products die.
   Cap items per day; when the backlog exceeds the cap, prioritise by
   (predicted-recall-nearest-threshold × coverage importance), not by age.
2. **Interleave.** Mix concepts within a session rather than blocking by topic —
   interleaving produces worse in-session performance and better retention, and
   the system should optimise for the latter.
3. **Respect the spacing.** Reviews delivered when convenient rather than when
   due destroy the effect being measured *and* corrupt the interval data. This
   is why notification scheduling is core infrastructure, not polish.

## Grading

Free-text answers are graded against the item's rubric points, each of which
carries a citation into the corpus.

```
grade(answer, item) → {
  score:    0..1,
  points:   [{ point_id, met: bool, evidence_span }],
  rationale_for_user: string   // shown, never stored as corpus
}
```

Rules:

- **Store the user's raw answer verbatim, always.** It is attested. The grade is
  a judgment that may be re-run with a better model or a revised rubric; the
  answer is the evidence and must never be overwritten by a normalised version.
- **Store rubric version and model id** on every grade.
- **Let the user override the grade.** Disagreement is signal — a cluster of
  overrides on one rubric points at a bad item, and `user_grade_override` is the
  cheapest quality feedback available.
- **Map to a rating band, and store the thresholds.** The scheduler wants a
  discrete rating; the grader produces a continuous score. The mapping is
  configuration, versioned with the scheduler parameters, not a magic constant
  buried in code.
- **Self-rating is collected alongside**, because the gap between what the user
  thinks they knew and what they could actually produce is the most direct
  measurement of illusion of fluency the system can make. Where the two diverge
  persistently, that is worth surfacing.

## Honest presentation

The hard constraint from [00-vision-and-scope.md](00-vision-and-scope.md): a
retention figure shown as a verdict manufactures the illusion of competence that
the underlying science warns about. A green "87% retained" badge is worse than
showing nothing, because it licenses the user to stop.

Rules for any surface that displays retention:

1. **Never a bare number.** Always with its evidence: when last successfully
   recalled, at what interval, from how many sources, how many items.
2. **No "mastered" state without a long-interval success.** A concept may not be
   presented as durably known unless it has been successfully recalled at an
   interval that actually demonstrates durability. Repeated short-interval
   successes demonstrate nothing.
3. **Where evidence is thin, ask instead of scoring.** With one or zero reviews,
   the honest display is a question — *when did you last use this?* — not a
   confident estimate.
4. **Surface calibration.** Show, somewhere the user can find it, how the
   model's predictions have actually performed. A retention engine that cannot
   show its own reliability is asking for trust it has not earned.
5. **Name exposure as exposure.** Anything computed without retrieval outcomes
   is labelled exposure or last-contact, never retention. This distinction is
   enforced in the schema and must survive into the UI vocabulary.

## Failure modes to design against

| Failure | Mitigation |
|---|---|
| User abandons quizzing around item 40 | Small daily budgets; synthesis items that feel worth answering; never punish a missed day with a backlog wall |
| Cramming clusters reviews | Enforce minimum intervals; flag and down-weight sessions whose spacing collapsed |
| Grader is systematically lenient | Track override rate; sample-audit against held-out human grades ([12](12-evaluation.md)) |
| Items test wording, not understanding | Wider generation context; prefer multi-span rubrics; retire items with anomalous pass rates |
| Backfilled sources flood the scheduler | Backfill seeds coverage only, never memory state ([03](03-ingestion.md)) |
| Notifications become nagging | One scheduled delivery per day, user-set time, silent when the queue is empty |
