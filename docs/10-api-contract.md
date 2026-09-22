# 10 — Core API Contract

The surface `@cognis/core` exposes. The mobile client is the first consumer; the
contract is deliberately client-agnostic so a second client (CLI, desktop, web)
needs no core changes.

Types are TypeScript sketches, not final signatures. The contract that matters is
the *shape*: view-scoped payloads, explicit provenance, no unbounded graph
queries.

## Capture

```typescript
capture(input: {
  kind: 'url' | 'pdf' | 'text' | 'doi';
  payload: string;                 // URL, file path, raw text, or DOI
  capturePath: CapturePath;
  occurredAt: string;
}): Promise<{
  sourceId: string;
  ingestionEventId: string;
  priorCoverage: PriorCoverage | null;   // available immediately when the source is known
}>
```

`capture` returns as soon as the attested rows are written. Everything else is
queued. `priorCoverage` is the *have I seen this before* answer the user gets at
share time — the most immediately satisfying thing cognis does.

```typescript
type PriorCoverage = {
  seenBefore: boolean;
  previousEvents: { occurredAt: string; engagement: Engagement | null }[];
  relatedConcepts: { conceptId: string; label: string; distinctSources: number }[];
  novelty: number | null;          // null until embedding completes
  noveltyModelId: string | null;
};
```

```typescript
recordEngagement(ingestionEventId: string, level: Engagement, source: EngagementSource): Promise<void>
recordReadingSession(ingestionEventId: string, telemetry: ReadingTelemetry): Promise<void>
annotate(documentVersionId: string, a: AnnotationInput): Promise<{ annotationId: string }>
```

## Pipeline control

```typescript
enqueue(stage: Stage, scope: { sourceIds?: string[]; all?: boolean }): Promise<JobId>
jobStatus(id: JobId): Promise<JobStatus>
rebuild(stage: Stage, fromVersion: string): Promise<JobId>   // see docs/02 § Rebuild semantics
```

`rebuild` always re-applies user overrides. That is part of the contract, not an
implementation detail, and it is covered by a test that a rebuild cannot pass
without.

## Coverage queries

These are the success-test queries from [00](00-vision-and-scope.md), promoted to
first-class API calls because they are the product.

```typescript
coverageFor(conceptId: string): Promise<Coverage>

uncoveredButRecurring(opts: {
  minDistinctSources: number;      // default 3
  maxPrimarySources: number;       // default 0
  limit: number;
}): Promise<ConceptGap[]>

bridgeGaps(opts: { limit: number }): Promise<{ clusterA: ConceptRef[]; clusterB: ConceptRef[]; strength: number }[]>

decayedCoverage(opts: {
  notContactedSinceDays: number;
  limit: number;
}): Promise<{ concept: ConceptRef; coverage: Coverage; retention: RetentionEvidence }[]>

searchCorpus(q: string, opts?: { semantic?: boolean; limit?: number }): Promise<SearchHit[]>
```

```typescript
type Coverage = {
  conceptId: string;
  distinctSources: number;
  primarySources: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  temporalSpreadDays: number;
  maxEngagement: Engagement | null;
  contactCount: number;
  hasUserAnnotation: boolean;
};
```

Note what `Coverage` does not have: a score. Collapsing it to one number is a
presentation decision, made where the inputs can be shown alongside
([05](05-retention-engine.md) § Honest presentation).

## Retention

```typescript
dueItems(opts: { limit: number; at?: string }): Promise<ReviewCard[]>

submitReview(input: {
  quizItemId: string;
  answerText: string;
  selfRating?: 1 | 2 | 3 | 4;
  presentedAt: string;
  answeredAt: string;
}): Promise<ReviewResult>

overrideGrade(reviewId: string, rating: 1 | 2 | 3 | 4, note?: string): Promise<void>

retentionEvidence(conceptId: string): Promise<RetentionEvidence>
calibration(opts?: { bins?: number }): Promise<CalibrationReport>
```

```typescript
type RetentionEvidence = {
  conceptId: string;
  reviewCount: number;
  lastSuccessfulRecallAt: string | null;
  longestSuccessfulIntervalDays: number | null;
  recentOutcomes: { at: string; rating: number; intervalDays: number }[];
  modelledRecall: number | null;      // null when evidence is insufficient
  evidenceSufficient: boolean;        // false ⇒ the client MUST NOT render a score
};

type CalibrationReport = {
  bins: { predicted: number; observed: number; n: number }[];
  overallBrier: number;
  asOf: string;
};
```

`evidenceSufficient` is the mechanism that keeps honest presentation from being a
guideline the UI can forget. When it is false, `modelledRecall` is null and there
is nothing for the client to render a score from — the constraint is expressed in
the types rather than in a style guide.

`calibration` exists so the system can show how well its own predictions have
performed. A retention engine that cannot report its reliability is asking for
trust it has not earned.

## Suggestions

```typescript
suggestions(opts: {
  limit: number;
  kinds?: SuggestionKind[];
  maxFromLargestCluster?: number;    // diversity cap; defaults enforced in core
}): Promise<Suggestion[]>

dismissSuggestion(id: string, reason?: 'not_interested' | 'already_known' | 'not_now'): Promise<void>
```

```typescript
type Suggestion = {
  id: string;
  kind: 'citation_gap' | 'coverage_gap' | 'bridge' | 'neighbour';
  target: { conceptId?: string; externalRef?: string; title?: string };
  reason: SuggestionReason;    // structured evidence; the client renders the sentence
  score: number;
  expiresAt: string;
};
```

The reason is structured, never prose ([06](06-suggestion-engine.md)). A client
that wants a sentence composes one from the evidence; the core does not ship
generated text.

## Views

View queries return **view-shaped, bounded payloads**. There is no
`getWholeGraph()`, by design ([07](07-graph-views.md)).

```typescript
neighbourhood(conceptId: string, opts: {
  hops: 1 | 2;
  maxNodes: number;                  // core clamps to the rendering budget
  minEdgeWeight?: number;
  provenances?: EdgeProvenance[];
}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; layout?: LayoutHint[] }>

taxonomy(rootConceptId: string | null, opts: {
  depth: number;
  includeUncovered: boolean;         // the holes are the point
}): Promise<TaxonomyNode[]>

timeline(opts: {
  from: string; to: string;
  conceptIds?: string[];
  granularity: 'day' | 'week' | 'month';
}): Promise<TimelineRow[]>
```

`GraphEdge` carries `provenance` so the client can style a vocabulary claim
differently from a co-occurrence statistic. Rendering them identically would
present a derived correlation as an asserted fact.

## Privacy controls

```typescript
setSourcePrivate(sourceId: string, isPrivate: boolean): Promise<void>
egressLog(opts: { from?: string; limit: number }): Promise<EgressEntry[]>
exportAll(opts: { format: 'sqlite' | 'jsonl'; destination: string }): Promise<{ path: string }>
deleteSource(sourceId: string): Promise<{ deletedRows: Record<string, number> }>
deleteConceptHistory(conceptId: string): Promise<{ deletedRows: Record<string, number> }>
```

`deleteSource` returns what it deleted. Deletion that cannot be verified is
deletion the user has to take on faith.

## Contract rules

1. **No endpoint returns model-generated prose as content.** Questions and
   grader rationales are the only generated strings that cross the boundary, and
   both are labelled as derived.
2. **Every derived payload carries its provenance** — producer version, model id
   where applicable — so a client can show where a claim came from.
3. **Graph queries are bounded.** Every traversal takes an explicit cap and core
   clamps it. There is no path to an unbounded query.
4. **Attested writes never fail because of a pipeline problem.** `capture`
   succeeds if the row was written, regardless of what happens downstream.
5. **Anything that can run offline, does.** Network is required only for the
   stages named in [09](09-privacy-and-security.md) § egress.
