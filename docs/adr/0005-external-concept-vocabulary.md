# 0005 — Anchor concept identity to external vocabularies

**Status:** Accepted

## Context

Tracking "concepts covered" requires that the same idea, named differently across
sources, resolves to one node, and that the node does not drift when extraction
is re-run with a different model.

Letting a model name concepts fails in a compounding way: synonyms become
separate nodes; re-running with a new model renames existing nodes and silently
reorganises a graph the user has built over a year; and there is no ground truth,
so quality can never be measured or improved.

## Decision

Concepts are anchored to stable public identifiers — Wikidata QIDs by default,
domain vocabularies (MeSH, OpenAlex topics, ACM CCS) inside their domains. The
model's job is **linking** (choosing among retrieved candidates), never
**naming**.

Concepts that genuinely have no external anchor become `local:` nodes, held in a
queue for later anchoring, with a consolidation pass that auto-merges only above
a high confidence threshold and otherwise asks the user.

## Consequences

- **Identity survives model change.** A relink recomputes evidence; node ids do
  not move. This is the property the whole design rests on.
- **Linking is measurable.** Choosing among candidates has a correct answer, so
  precision and recall can be computed against a labelled set and regressions
  can be caught ([12](../12-evaluation.md)).
- **The taxonomy view comes free.** Wikidata `subclass of` / `instance of` and
  MeSH tree numbers give a real hierarchy with no clustering heuristic and no
  model involvement.
- **Cross-source merging works**, because three sources using three different
  surface forms link to one QID.
- Cost: candidate generation needs vocabulary API access and caching.
- Cost: coverage is uneven — Wikidata is thin on very new or very niche technical
  concepts, so the `local:` path is load-bearing, not an edge case.
- Cost: vocabulary drift (merged or deleted QIDs) needs handling, including
  following redirects and recording the move.

## Alternatives considered

**Model-named concepts with embedding-based dedup.** The obvious approach and
the one most systems take. Rejected: identity drifts on every model change, and
nothing is measurable.

**User-maintained tags.** Zero infrastructure, and it is the thing people already
fail to keep consistent. It also cannot support cross-source coverage, which is
the product.

**Pure embedding clusters as concepts.** No stable identity, no labels, no
hierarchy, and clusters reshuffle whenever the embedding model changes.

**A single vocabulary only (Wikidata).** Simpler, but materially worse in
biomedical and computing domains where curated vocabularies are far better.
Multi-scheme costs a prefix on the id and is worth it.
