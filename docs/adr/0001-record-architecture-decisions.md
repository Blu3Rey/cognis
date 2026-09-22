# 0001 — Record architecture decisions

**Status:** Accepted

## Context

cognis makes several decisions that are cheap now and very expensive later: how
concept identity works, what is stored where, what may be generated. Re-litigating
them from memory in six months, without the reasoning, produces either paralysis
or silent drift.

## Decision

Record decisions that are expensive to reverse as ADRs in `docs/adr/`. An ADR
states the context that forced the decision, the decision, its consequences
including the bad ones, and the alternatives that lost and why.

Reversing a decision is a new ADR superseding the old one. ADRs are not edited
after acceptance except to mark them superseded — the record of what was believed
at the time is the point.

## Consequences

- A decision that cannot be written up in a page is probably not understood yet.
- Design docs describe the current state; ADRs explain how it got there.

## Alternatives considered

**Comments in code.** Invisible until you are already in the file, and lost in
refactors.

**A wiki.** Drifts out of sync with the repository and is not reviewable in a
diff.
