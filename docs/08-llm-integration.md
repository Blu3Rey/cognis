# 08 — Model Integration

Where a language model is used, what it is allowed to do, and what it costs.

## Where models are used — and where they are not

| Stage | Model? | Why |
|---|---|---|
| HTML/PDF extraction | **No** | Readability-style parsing and PDF text layers are better, free, deterministic, offline |
| Chunking | **No** | Structural rules over headings and paragraphs |
| Embeddings | On-device | Privacy, cost, offline; see *Embeddings* below |
| Novelty scoring | **No** | Cosine distance |
| Candidate generation | **No** | Vocabulary search APIs |
| **Concept disambiguation** | Yes | Genuine judgment over a finite candidate set |
| **Quiz item generation** | Yes | Requires composing a question from source spans |
| **Answer grading** | Yes | Judging a free-text answer against a rubric |
| Suggestion ranking | **No** | Citation graph plus SQL; reasons render from structured evidence |
| Suggestion prose | **No** | The client renders `reason_json`; a model would only add plausible-sounding noise |

Roughly two thirds of the pipeline has no model in it. That is deliberate: every
stage that can be done deterministically is, which cuts cost, removes a network
dependency, and keeps generated content confined to three well-fenced places.

## The generation boundary, restated as code

```
model output may:  select from candidates
                   structure existing text
                   pose a question about the corpus
                   judge an answer against the corpus

model output may NOT: become a concept's name or description
                      become stored summary text
                      become an edge asserted as fact
                      replace or paraphrase source content
```

Enforced by the schema ([02](02-data-model.md)): there is no column for a model
to write prose into that is treated as corpus. `quiz_item.prompt` is a question
and is derived and disposable; `concept.label` comes from the vocabulary.

## Model selection

Default to **`claude-opus-5`** for all three model stages. Linking and grading
are judgment tasks where an error compounds — a wrong link corrupts coverage for
every downstream query, and a lenient grader corrupts the retention model's
training signal indefinitely.

Current pricing, for a deliberate cost decision rather than a reflex:

| Model | Model ID | Input $/MTok | Output $/MTok |
|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | $5.00 | $25.00 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2.00 | $10.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 | $5.00 |

If bulk linking cost becomes the binding constraint, a cheaper model for the
*high-confidence* candidate subset — with an escalation to `claude-opus-5`
whenever candidates are close or confidence is low — is the right shape for a
cascade. Do not build it speculatively: measure first
([12](12-evaluation.md) has the harness), and note that a cascade forfeits prompt
cache reuse across its models, which claws back part of the saving.

### Request configuration

```typescript
// Shared defaults for every cognis model call.
const BASE = {
  model: "claude-opus-5",
  // Adaptive thinking; budget_tokens is rejected (400) on this model.
  thinking: { type: "adaptive" as const },
  // Refusal fallbacks: arbitrary web content will occasionally be declined,
  // and an ingestion pipeline must not stall on it.
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};
```

Effort per stage (`output_config.effort`, default `high`):

| Stage | Effort | Reasoning |
|---|---|---|
| Disambiguation | `low`–`medium` | Bounded choice over a candidate list; measure before raising |
| Item generation | `high` | Quality of items determines the value of every review |
| Grading | `medium`–`high` | Consistency matters more than depth; hold it fixed once tuned |

Effort is tuned per stage against the eval set, never globally by feel.

## Structured output and citations — a real constraint

Two features cognis wants for the same call are incompatible:

- **Structured output** (`output_config.format`) gives schema-valid JSON.
- **Citations** (`citations: {enabled: true}` on document blocks) makes the model
  return `char_location` / `page_location` spans into the source — exactly the
  provenance that keeps generated items auditable.

Sending both returns a 400.

**Resolution — two passes:**

1. *Grounding pass.* Document blocks with `citations: {enabled: true}`, free-form
   output. Returns claims with cited spans.
2. *Structuring pass.* Feed pass 1's output into a cheap call with
   `output_config.format` to produce the `quiz_item` record. No document blocks,
   so no conflict, and the input is small.

Strict tool use (`strict: true` on a tool definition) is a different mechanism
from `output_config.format` and may well combine with citations in a single call.
**Verify this against the API before relying on it** — if it works, it collapses
two passes into one for the highest-volume paid stage, which is worth an hour of
testing early.

For structured passes, use the SDK's parse helper rather than hand-parsing:

```typescript
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const LinkDecision = z.object({
  decisions: z.array(z.object({
    surface_form: z.string(),
    concept_id: z.string().nullable(),   // null = NIL
    confidence: z.number(),
    is_primary: z.boolean(),
  })),
});

const res = await client.messages.parse({
  ...BASE,
  max_tokens: 4000,
  output_config: { effort: "low", format: zodOutputFormat(LinkDecision) },
  system: [{ type: "text", text: LINKER_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: renderChunkAndCandidates(chunk, candidates) }],
});

if (res.stop_reason === "refusal") {
  return markStageFailed(chunk.id, "linker_refusal", res.stop_details?.category);
}
const decisions = res.parsed_output?.decisions ?? [];
```

## Prompt caching

Caching is a prefix match over `tools` → `system` → `messages`, so stable content
goes first and volatile content last.

For cognis the cacheable prefix is substantial and identical across every call in
a run: the linker instructions, the output contract, and the vocabulary
description block. Place `cache_control` at the end of that prefix; keep the
chunk, its candidates and any timestamps after it.

Two rules that are easy to violate and expensive to miss:

- **Nothing volatile in the prefix.** A timestamp, a request id, or
  non-deterministic key ordering in a serialised candidate list silently
  invalidates the cache on every call.
- **Verify, don't assume.** Log `usage.cache_read_input_tokens`. If it is zero
  across repeated calls with the same prefix, something is invalidating it, and
  the whole caching design is doing nothing.

## Batching

Linking and item generation are never latency-sensitive: they run deferred, on
charge and unmetered network. The Message Batches API processes them
asynchronously at **50% of standard price**, which is the single largest cost
lever in the system.

Operational notes: results come back in arbitrary order and must be keyed by
`custom_id` (use the chunk or source id), a batch may take up to 24 hours, and
each result carries its own success/error status that has to be handled per item
rather than per batch.

Grading stays interactive and unbatched — the user is waiting.

## Cost model

Worked estimate for one 2,500-word article (~3,300 tokens), 8 chunks:

| Stage | Input tokens | Output tokens |
|---|---|---|
| Linking (8 chunk calls) | ~14,800 | ~2,000 |
| Item generation (2 calls) | ~5,000 | ~1,500 |
| **Per article** | **~20,000** | **~3,500** |

At Opus 5 list price: `20,000 × $5/1M = $0.100` input, `3,500 × $25/1M = $0.088`
output → **≈ $0.19 per article**, or **≈ $0.09 batched**.

| Usage | Full price | Batched |
|---|---|---|
| 100 articles/month | ~$19 | ~$9 |
| 30 articles/month | ~$5.70 | ~$2.80 |
| Full relink of a 1,000-source corpus | ~$124 | ~$62 |

Grading adds roughly `$0.014` per review (≈1,200 in / 300 out), so 50 reviews a
month is under a dollar.

Three things follow:

1. **Batching is not optional** at these volumes — it halves the dominant cost.
2. **A full relink is a budgeted operation**, not something to trigger casually
   on every model release. Relink when the eval shows a real quality gain
   ([04](04-concept-identity.md) § Drift control).
3. **A heavy user costs real money.** Anyone planning to ship this to other
   people needs the unit economics settled before the pricing page, not after.

These are estimates. Measure with `messages.count_tokens` against real ingested
documents before committing to any of them — never with a third-party tokeniser,
which will not match.

## Embeddings

Deliberately decoupled from the text-model choice, behind the `Embedder` port
([01](01-architecture.md)):

- **On-device by default** — a small sentence-embedding model via ONNX. Keeps the
  corpus local, works offline, costs nothing per document, and makes novelty
  scoring free at ingest.
- **`model_id` is stored with every vector.** Vectors from different models are
  not comparable, and silently mixing them corrupts novelty and similarity
  across the whole corpus.
- **Re-embedding is a scoped rebuild**, which is why `document_version.text` is
  kept permanently.
- Chunking strategy will affect retrieval quality more than the choice of
  embedding model; spend the tuning effort there.

## Reliability

| Failure | Handling |
|---|---|
| `stop_reason: "refusal"` | Server-side fallbacks enabled by default; if it still refuses, mark the stage failed with the category, keep the attested rows, surface nothing alarming to the user |
| Rate limit / 5xx | SDK retries, then re-queue for the next deferred pass |
| Malformed structured output | `parsed_output` is null on failure — guard it; one retry, then fail the stage |
| Batch item error | Handled per `custom_id`; the batch is not failed wholesale |
| Model deprecated | Model id is stored on every derived row, so affected rows are identifiable and rebuildable by version |

The invariant across all of these: **a model failure never destroys an attested
record.** The user read the thing; the pipeline's trouble is the pipeline's.
