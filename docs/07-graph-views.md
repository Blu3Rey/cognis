# 07 — Graph and Tree Views

## The trap

The global force-directed graph is the signature feature of every PKM and is
useless in all of them. It photographs beautifully, becomes an unreadable hairball
past a few hundred nodes, and is opened twice: once on install, once when showing
someone the app. On a phone it is also a battery-burning physics simulation
rendering a picture nobody can act on.

cognis therefore has **no global graph view**. "Show me everything" is an
explicit non-feature. Three bounded views replace it.

## View 1 — Neighbourhood (ego graph)

The default graph surface. Focused on one concept:

- 2 hops maximum, hard node cap around 150, edges filtered by weight
- edges styled by `provenance`: vocabulary, citation, co-occurrence, user-linked
  are visually distinct, because "Wikidata says this is a subclass" and "these
  co-occurred in your reading" are different claims and must not look alike
- node size encodes *your* coverage, not global importance
- uncovered neighbours are rendered as outlines — the visible coverage frontier,
  and the point of contact with the suggestion engine

Layout is computed once and cached, not simulated live. At this size a phone can
run a short force pass on a worker thread; beyond it, precompute.

## View 2 — Taxonomy tree

The most useful view, and nearly free: because concepts are anchored to external
vocabularies ([04](04-concept-identity.md)), a real hierarchy already exists —
Wikidata `subclass of` / `instance of`, MeSH tree numbers, ACM CCS. No clustering
heuristic required and no model involved.

- collapsible, virtualised, scales to the whole corpus
- each node shows coverage: distinct sources, primary sources, last contact
- empty children are visible — the taxonomy holes signal from
  [06](06-suggestion-engine.md), rendered

Trees are legible on a phone in a way graphs are not: scrollable, searchable,
stable between sessions, and directly answerable ("what have I covered under
this?"). This should be the default knowledge view.

## View 3 — Coverage timeline

What was covered when, and how it held up. Probably the most-used view, and the
one that makes the psychological layer visible without turning it into a score.

- horizontal time axis, one row per concept or concept group
- ingestion events as marks, sized by engagement depth
- review outcomes as marks, coloured by result
- gaps drawn plainly — the spacing of encounters is the thing worth seeing
- the honest-presentation rules from [05](05-retention-engine.md) apply in full:
  no bare retention scores, no "mastered" badge without a long-interval success

## Rendering budget (mobile)

| Constraint | Value |
|---|---|
| Max rendered nodes | ~150 (neighbourhood), virtualised (tree) |
| Layout | precomputed and cached; no continuous simulation |
| Interaction target | 60fps pan/zoom; re-layout only on focus change |
| Text | labels only above a zoom threshold; collision-culled |
| Data | queries return view-shaped payloads, never the whole graph ([10](10-api-contract.md)) |

## What these views are for

Each view answers a question from the success test:

| View | Question |
|---|---|
| Neighbourhood | What surrounds this concept that I have not covered? |
| Taxonomy | What is the shape of what I know, and where are the holes? |
| Timeline | What did I cover when, and has it held? |

A view that does not answer one of those does not ship.
