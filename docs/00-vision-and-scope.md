# 00 — Vision and Scope

## The problem

People who read widely lose track of their own coverage. Not the *material* —
that is findable — but the shape of what they have and have not engaged with:
which ideas keep recurring across unrelated sources, which were met once and
never returned to, which they believe they understand because they have read
about them four times without ever having to produce an explanation.

Search engines and note apps do not solve this, because neither has a record of
what *you* consumed. Search knows the world's documents; your notes know what you
bothered to write down. Neither knows that you read six papers touching
identity resolution over eleven months and never once wrote a line about it.

## What cognis is

A durable, provenance-carrying record of consumed material, resolved to stable
concepts, with:

- **Coverage tracking** — how many independent sources, over what time span, at
  what depth of engagement, for each concept.
- **Retention testing** — periodic retrieval practice, scheduled by a memory
  model that is fit on actual graded outcomes.
- **Coverage-frontier suggestions** — what you have repeatedly brushed against
  but never covered directly, sourced from citation graphs and structural gaps
  rather than similarity.
- **Legible views** — neighborhood, taxonomy, and timeline, none of which is a
  global node hairball.

## What cognis is not

| Not | Because |
|---|---|
| A summarizer | Summaries are generated knowledge. cognis stores your material and points at it. Extractive quotation with citations is fine; abstractive replacement of the source is not. |
| A note-taking app | Notes are user-authored and welcome as annotations, but composing prose is not the product. |
| A chatbot over your documents | RAG-over-my-files is a solved commodity and answers the wrong question. cognis is about coverage and retention, not retrieval Q&A. |
| A read-later queue | Queues measure intake. cognis measures what stuck. |
| A recommender | Suggestions are gap reports with stated reasons, never an engagement-optimized feed. |

## The falsifiable success test

At six months of real use, cognis must answer these without the user doing any
manual bookkeeping:

1. Which concepts have I met from ≥3 independent sources but never covered
   directly (no source where the concept is primary)?
2. Which concepts did I demonstrably understand once and have since failed to
   recall?
3. Which two clusters of my reading have never been bridged by a single source?
4. For anything I read this week, had I covered it before, and how well did that
   coverage hold up?
5. What did I read in March that I have not touched since, ranked by how much
   of it I would now fail to recall?

If, at six months, the system cannot answer these — or can only answer them with
numbers we do not trust (see [12-evaluation.md](12-evaluation.md)) — the
analytics layer has failed regardless of how good the graph view looks.

## The design tensions, stated up front

These do not get resolved once; they are re-checked at every design decision.

### Generation is required, but knowledge must not be generated

Quiz items and disambiguation decisions require a language model. The resolution
is a boundary, not an exception:

> Model output may **point at**, **select from**, **structure**, or **question**
> corpus content. It may never **become** corpus content.

Quiz items are derived and disposable. Quiz *outcomes* are attested. A concept's
identity comes from an external vocabulary, not from a model's naming. Every
generated artifact carries the model and prompt version that produced it and can
be deleted wholesale. See [ADR-0002](adr/0002-attested-vs-derived.md).

### Measurement can damage the thing it measures

A green "87% retained" badge manufactures exactly the illusion of fluency that
the learning-science literature warns about — the feeling of knowing produced by
familiarity rather than retrieval. cognis therefore never displays a retention
figure as a standalone verdict. Every such number appears with the evidence it
rests on (when you last actually recalled it, at what interval, from how many
sources) and with the model's own calibration. Where the evidence is thin, the
UI asks a question instead of showing a score. See
[05-retention-engine.md](05-retention-engine.md) § Honest presentation.

### Similarity is the wrong objective for breadth

Nearest-neighbour suggestion drifts toward what the user already knows. The
suggestion engine is therefore ordered to prefer non-generated structural
evidence (citation graphs, coverage gaps) over embedding similarity, and carries
an explicit diversity constraint. See
[06-suggestion-engine.md](06-suggestion-engine.md).

## Context: the intended client

The first consumer is a mobile app with a built-in reader that captures
articles, documents and research papers, quizzes the user, suggests adjacent
topics, and renders knowledge views. That client is **context, not scope** —
this repository is the cognis core: schema, pipelines, engines and the API
contract. The core must be usable by a different client without modification,
which is why [10-api-contract.md](10-api-contract.md) exists.

One consequence is load-bearing: the reader's dwell/scroll telemetry is the
objective engagement-depth signal the retention model wants, and no other
capture path provides it. The core therefore models engagement depth as a
first-class, optional, multi-source field rather than assuming any one client.
