# 04 — Concept Identity

This is the hardest problem in cognis and the one most likely to sink it.

## The problem

"Track concepts covered" requires that the same idea, named differently across
three sources, resolves to one node — and that the node does not drift when
extraction is re-run next year with a different model. That is entity resolution
over a growing corpus with a non-deterministic extractor.

The naive approach — ask a model to list the key concepts in each document —
fails in a specific, compounding way:

- The same idea returns as "spaced repetition", "spacing effect", "distributed
  practice" and "the spacing phenomenon" across four documents, producing four
  nodes.
- Re-running with a newer model renames half the existing nodes, and the graph
  the user has been building for a year silently reorganises.
- Nothing is checkable: there is no ground truth for "was this the right node?",
  so quality can never be measured or improved.

## The decision: identity is external

Concepts are anchored to public, stable identifiers. The model's job is
**linking** — choosing among candidate entities — not **naming**. Linking is a
classification task with a finite candidate set, which means it is checkable,
measurable, and improvable. See [ADR-0005](adr/0005-external-concept-vocabulary.md).

| Vocabulary | Scheme | Use for |
|---|---|---|
| Wikidata | `wd:Q…` | general concepts, people, organisations, technologies |
| MeSH | `mesh:D…` | biomedical |
| OpenAlex topics | `openalex:T…` | research-paper subject areas |
| ACM CCS | `acm:…` | computing subfields |
| local | `local:<ulid>` | genuinely novel or too-specific concepts |

Wikidata is the default backbone: broad, multilingual, has stable QIDs, carries
`subclass of` / `instance of` relations that give the taxonomy view a real
hierarchy for free, and has an open API. Domain vocabularies take precedence
inside their domain, where they are far better curated.

## The linking pipeline

```
chunk ──► 1. spot candidates ──► 2. generate candidate entities
                                          │
                                          ▼
                              3. disambiguate (model, with context)
                                          │
                        ┌─────────────────┴──────────────────┐
                        ▼                                    ▼
            4a. anchor to external id              4b. NIL → local concept
                        │                                    │
                        └──────────► 5. write mention ◄──────┘
                                          │
                                          ▼
                              6. apply user overrides
```

**1. Spot candidates.** Surface forms worth linking. Cheap signals first:
capitalised phrases, noun chunks, terms in publisher-supplied keyword lists,
glossary/definition patterns, and terms that recur across the document. A model
pass helps on prose-heavy sources but is not the only path.

**2. Generate candidate entities.** For each surface form, retrieve up to ~10
candidates from the vocabularies via search and alias lookup. This is a plain
API call, no model. Empty candidate set → straight to NIL handling.

**3. Disambiguate.** One model call per chunk (not per mention — batching
mentions within a chunk shares the context and cuts cost substantially). Input:
the chunk text, the surface forms, and their candidates with descriptions.
Output, via strict tool use or structured output: for each surface form, the
chosen candidate id or `NIL`, a confidence, and an `is_primary` flag.

`is_primary` — *is this source actually about this concept, or does it merely
mention it?* — is the field that makes coverage meaningful. Without it, a passing
reference to Bayes' theorem in a blog post counts the same as a textbook chapter
on it, and every coverage number becomes noise.

**4. Anchor or NIL.** A confident match above threshold anchors. Below threshold,
or no candidates: create a `local:` concept keyed by a normalised label plus an
embedding centroid of its mentions. Local concepts are a queue, not a resting
place — a periodic job retries anchoring as vocabularies grow and as more
mentions accumulate to disambiguate with.

**5. Write mentions** with evidence spans, confidence, producer version, model id
and prompt version.

**6. Apply user overrides.** Non-optional, every time. See below.

## Local concept merging

Local concepts accumulate duplicates by construction. A periodic consolidation
pass proposes merges when *both* hold:

- label similarity after normalisation (case, plurals, hyphenation, acronym
  expansion) is high, **and**
- the mention-embedding centroids are close.

Two guards matter. Proposals above a high threshold auto-merge; anything in the
uncertain band is **proposed to the user and never applied silently**, because a
wrong auto-merge is much more damaging than a duplicate — a duplicate is visible
and fixable, a wrong merge destroys the distinction invisibly. And merges are
recorded as `user_assertion` rows when the user confirms them, so they survive
rebuilds.

## Drift control

This is the payoff of external anchoring.

| Change | What moves |
|---|---|
| New linker model | mentions are recomputed; **concept ids are unchanged** |
| New prompt version | mentions recomputed; ids unchanged |
| New embedding model | vectors recomputed; local-concept merges re-proposed; anchored ids unchanged |
| Vocabulary updates upstream | labels/descriptions refresh; ids stable (Wikidata QIDs are stable; redirects are followed and recorded in `promoted_from`) |

A relink is a scoped rebuild: delete mentions for the old `producer_version`,
recompute, re-apply overrides, recompute coverage. The user's graph does not
reorganise, because its nodes were never the model's to name.

**Every relink must be evaluated before it is adopted.** A held-out labelled set
(see [12-evaluation.md](12-evaluation.md)) is run against the new linker version
and compared to the current one. A relink that lowers precision does not ship,
however much better the new model is at everything else.

## User corrections are sacred

Users will correct the graph: *these two are the same thing*, *this link is
wrong*, *this source is actually about X*. Each becomes a `user_assertion` row
(attested), and the override layer is re-applied after every rebuild:

```
mention_reject  → suppress that (chunk, concept) link permanently
mention_add     → force a link the linker missed
concept_merge   → canonicalise B to A, rewrite mention targets at read time
concept_split   → block a merge, keep both, remember why
known_already   → seed memory state; exempt from early scheduling
```

Rebuilds re-apply these unconditionally. A rebuild that drops a user's merge
teaches the user their corrections do not stick, and they will stop making them —
which costs the system its single best source of high-quality labels.

## Cost shape

Linking is the dominant recurring model cost: one call per chunk, on every
source, and again on every relink. Three levers, in order of impact:

1. **Batch API** for all non-interactive linking — half price, and linking is
   never latency-sensitive.
2. **Prompt caching** on the stable instruction prefix and the vocabulary
   description block, which is identical across every call in a run.
3. **Fewer, larger calls** — all surface forms in a chunk in one request.

Concrete numbers in [08-llm-integration.md](08-llm-integration.md) § Cost.
