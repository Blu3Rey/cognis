# Linking evaluation

`docs/12-evaluation.md` §2 makes this the gate for M2: **precision is the
primary metric, and no relink ships that lowers it**, however much better the
new model is at everything else. A wrong link corrupts coverage for every
downstream query and does so invisibly.

## What exists now

- **The harness** — `src/eval/linking.ts`. Computes linking precision, recall,
  F1, NIL accuracy, `is_primary` accuracy, spotter recall loss, and identity
  stability across model changes. Every disagreement is listed individually,
  because the error list is where the actual work is.
- **A seed set** — `test/fixtures/gold.ts`. Four documents, six labelled
  mentions, two of them genuine NILs.

## What the seed set is not

It is **not** the evaluation the gate refers to, and it must not be treated as
one. It exists to prove the harness measures what it claims: that a spurious
anchor shows up as a false positive, that a linker which anchors nothing scores
zero recall rather than zero errors, and that concept ids do not move across a
model change.

Real ground truth has to be labelled by hand against a real corpus. Inventing
it would produce an eval that measures nothing while looking like it measures
something — which is worse than having none, because the number gets believed.

## Building the real set

The gate needs **≥200 hand-labelled mentions across ≥20 documents**, drawn from
the reading mix the system will actually see. Deliberately include the hard
cases, because an eval made only of easy ones reports a precision the product
will not reproduce:

| Hard case | Why it belongs |
|---|---|
| Ambiguous acronyms (`NLP`, `PCA`, `ML`) | one surface form, several real concepts |
| Common-word surface forms ("attention", "transformer", "memory") | the vocabulary will offer plausible wrong answers |
| Near-synonyms that must **not** merge | e.g. precision vs. accuracy |
| Genuine NILs | new or niche terms with no vocabulary entry; over-eager anchoring is the main failure mode |
| One concept named three ways across three sources | the cross-source merging that justifies external anchoring |
| A source that merely mentions a concept, next to one that is about it | `is_primary` is what makes coverage meaningful |

### Procedure

1. Pick documents from the real corpus, spanning its actual topic mix.
2. For each, label every mention worth linking: surface form, character
   offsets, the correct concept id (or `null` for NIL), and `isPrimary`.
3. Use the real vocabulary's ids (`wd:Q…`), not invented ones.
4. Record *why* a hard case is hard in the `note` field. A year later that note
   is the difference between fixing the linker and re-deriving the problem.
5. Keep the set in this directory, versioned, alongside the results it produced.

### Running it

```ts
import { runLinkingEval, formatReport } from '@cognis/core';

const report = await runLinkingEval(GOLD, vocabulary, linker);
console.log(formatReport(report));
```

### Regression discipline

Re-run on every change to the linker prompt, the candidate generator, the
model, or the effort setting. Store each result with the version it measured:
an evaluation whose history is lost cannot show regression, which is most of its
value.

**Identity stability** deserves separate attention. It should be essentially
100% for externally anchored concepts, and any drift is a bug in anchoring
rather than a model-quality issue — it means the architectural bet in
[ADR-0005](../docs/adr/0005-external-concept-vocabulary.md) is not holding.
