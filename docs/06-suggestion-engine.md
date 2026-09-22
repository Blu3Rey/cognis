# 06 — Suggestion Engine

## The objective is coverage, not similarity

Nearest-neighbour suggestion over the user's own corpus recommends what most
resembles what they already have. Applied for a year, it builds a filter bubble
of one — a sad outcome for a system whose stated purpose is breadth across
"diverse, adjacent, and intersecting topics".

So the ranking objective is **the coverage frontier**: material that is
connected to what the user has read, and that they have demonstrably not covered.
Similarity is a weak proxy for that and is used last.

## Candidate sources, in priority order

### 1. Citation graph (non-generated ground truth)

For any source with a DOI, the reference list and the cited-by set are
authoritative statements about adjacency, made by domain experts, requiring zero
model calls.

| Signal | Meaning | Strength |
|---|---|---|
| Uncovered reference | A paper you read cites this; you never opened it | very strong |
| Co-citation | Repeatedly cited alongside papers you read | strong |
| Convergent reference | Cited by ≥3 separate sources in your corpus | strongest available |
| Cited-by | Newer work building on what you read | good for currency |
| Shared author | Same authors, different paper | moderate |

Convergent references are the flagship signal: *five papers you have read all
cite this one, and you have never opened it* is a fact, not a guess, and it is
precisely the blind spot a reader cannot see unaided.

### 2. Structural gaps in the user's own corpus

Computed from `mention` and `coverage`, no network and no model:

- **Mentioned but never primary** — concepts with mentions from ≥N distinct
  sources but zero sources where `is_primary` is true. The user keeps brushing
  against it and has never read anything *about* it. This is the single most
  valuable query in the system and the one the success test names first.
- **Bridge gaps** — pairs of well-covered concept clusters with no source
  touching both. Interdisciplinary material that would connect them is high
  value and is exactly what similarity search will never surface.
- **Decayed coverage** — well-covered once, no contact in a long time, and
  failing reviews. A re-read suggestion, pointing at material already held.
- **Taxonomy holes** — from vocabulary hierarchy: siblings and parents of
  well-covered concepts with no coverage at all.

### 3. Embedding neighbours (last resort)

Used only to fill a slate when the structural signals are thin, and always with
a diversity penalty. Never the default.

## Ranking

```
score = w_evid · evidence_strength      // convergent citation > co-citation > similarity
      + w_gap  · coverage_gap           // how uncovered is this, really
      + w_reach· reachability           // can the user actually get and read it
      − w_red  · redundancy             // overlap with what is already covered
      − w_rep  · recent_suggestion_penalty
```

Then apply two constraints before presenting:

- **Diversity.** Maximal-marginal-relevance selection over the slate, plus a hard
  cap on how many suggestions may come from the user's largest concept cluster.
  Without this, the top of the ranking is always the user's dominant interest.
- **A serendipity slot.** One item per slate sampled from outside the top
  clusters, drawn from structural evidence rather than randomness — a bridge
  candidate or a taxonomy sibling. Labelled as such, so the user knows why an
  unusual item is there.

`reachability` matters more than it sounds: an unobtainable paywalled monograph
is a bad suggestion however well-connected, and open-access availability is
resolvable from the same metadata APIs the citation graph comes from.

## Every suggestion carries a reason, and the reason is structured

`suggestion.reason_json` holds evidence, not prose:

```json
{
  "kind": "citation_gap",
  "evidence": {
    "citing_sources": ["src_01H…", "src_01H…", "src_01H…"],
    "citing_count": 3,
    "your_coverage": { "distinct_sources": 0, "primary_sources": 0 },
    "related_concepts": ["wd:Q2539", "wd:Q11660"]
  }
}
```

The client renders this into a sentence. The reason is *derived from records*,
not written by a model, which keeps suggestions inside the project's central
invariant and — more practically — makes them verifiable. A user can tap through
to the three papers that cite it.

## Guardrails

These are product rules with teeth, not preferences:

1. **Nothing is auto-ingested.** A suggestion is a report; acting on it is always
   an explicit user action.
2. **Suggestions expire.** `expires_at` is enforced and dismissed suggestions are
   not resurrected. There is no accumulating recommendation history, and no
   engagement-optimised feed, because there is no engagement objective.
3. **No optimisation for time-in-app.** The ranking has no click-through or
   session-length term, and must not acquire one. The objective is coverage of
   the frontier; a suggestion the user reads and finds unremarkable is a fine
   outcome, and a suggestion that keeps them scrolling is not a goal.
4. **Dismissal is respected and is data.** `not_interested` is an attested
   assertion that suppresses the concept and its close neighbours.
5. **The cluster cap is not tunable upward by engagement.** If an experiment
   shows that relaxing diversity raises usage, that is not a reason to relax it.

## Slate composition in practice

A slate is rebuilt on demand and replaces the previous one; only dismissals
persist. Concretely:

| Constraint | Implementation |
|---|---|
| Diversity cap | at most `floor(limit × 0.4)` items from the largest concept cluster, enforced during selection |
| Serendipity slot | one item drawn from outside the top clusters, preferring a bridge or taxonomy hole over randomness |
| Similarity as fallback | `neighbour` candidates are generated only when structural signals did not fill the slate, and carry a redundancy penalty equal to their similarity so they cannot outrank a citation or coverage gap |
| Expiry | enforced on read; an expired slate simply disappears |
| Dismissal | suppresses that target in every future slate |

Clusters are connected components over the concept co-occurrence graph, which
also means a bridge candidate is unbridged by construction rather than by
threshold.

## Cost

The citation-graph path is free of model calls: metadata APIs plus SQL. The
structural-gap path is pure SQL over local data. Only the presentation layer
might involve a model, and it should not — the reason is rendered from structured
evidence by the client. This makes the highest-value suggestion signals the
cheapest ones to run, which is a rare and welcome alignment.
