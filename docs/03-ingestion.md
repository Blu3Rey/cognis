# 03 — Ingestion

Ingestion's job is to earn the data everything else depends on, reliably and
cheaply, without ever losing the attested fact that the user encountered
something.

## Capture paths, in order of priority

### 1. Share sheet (build first)

A share extension that accepts a URL, a PDF, or selected text. It works from
Safari, Chrome, a PDF reader, a mail client, a social app — everywhere the user
already reads. It costs a fraction of the reader's effort and covers most real
ingestion.

The extension does the minimum and returns: write `source` + `ingestion_event`,
enqueue extraction, dismiss. It must complete in well under a second and must
never block on the network. Share extensions run under tight memory limits and
are killed without ceremony; anything heavier belongs in the main app's
background queue.

### 2. File import

PDFs, EPUBs, and plain text from the files app. Local extraction, no network.
For PDFs, prefer the embedded text layer; fall back to OCR only on user request,
because on-device OCR of a 300-page book is a battery event.

### 3. Built-in reader (build last, for one specific reason)

The reader is the most expensive capture path to build — paywalls, JS-rendered
pages, bot walls, and PDF rendering are a long tail of misery — and it duplicates
ingestion the share sheet already handles.

**Its one irreplaceable contribution is telemetry.** Dwell time, scroll depth,
scroll reversals and re-visits are the objective engagement-depth signal, and
engagement depth is the ingestion variable with the strongest claim to predicting
durable retention. No other capture path can produce it.

So: the reader exists to *measure* reading, not to *enable* it. Build it when the
retention engine is ready to consume what it measures, not before. See
[ADR-0007](adr/0007-share-sheet-before-browser.md).

### 4. Backfill import

Pocket/Instapaper/Zotero/browser-history import, marked `capture_path='backfill'`
with a coarse timestamp. Backfilled events must be distinguishable from live
ones, because their engagement and timing data are untrustworthy and would
poison the retention model if mixed in. Backfill seeds coverage; it never seeds
memory state.

## Extraction

| Input | Approach |
|---|---|
| HTML article | Readability-style main-content extraction, run inside the WebView after load so JS-rendered content is present |
| PDF (text layer) | Structured text with page and position, preserved for citation anchoring |
| PDF (scanned) | OCR on explicit request only |
| Research paper | Extraction *plus* metadata resolution (below) — this path is much richer |
| EPUB | Chapter-wise, spine order preserved |
| Selected text | Stored verbatim as its own source with a `parent_url` |

Extraction is versioned (`document_version.producer_version`) and re-runnable. A
better extractor ships as a version bump and a background re-extract, which
appends new `document_version` rows; annotations stay anchored to the version
they were made against.

**Failure is a first-class outcome.** Paywalled, blocked, or unparseable sources
keep their `source` and `ingestion_event` rows with
`status='extraction_failed'` and a reason. The user still read the thing. The
record of that must not depend on a parser's success.

### Research papers are a privileged path

Given a DOI, arXiv id, PMID, or a matchable title, resolve metadata against
Crossref / OpenAlex / Semantic Scholar and store:

- authoritative title, authors, venue, publication date
- **the reference list** — the single most valuable structured input in the whole
  system, and entirely non-generated
- citation counts and cited-by, for suggestion ranking
- publisher-assigned subject/topic terms, which seed concept linking for free

This is why `source.kind='paper'` is distinguished. The citation graph is free
ground truth about adjacency, and it powers the suggestion engine without a
single model call. See [06-suggestion-engine.md](06-suggestion-engine.md).

## Deduplication and identity

Canonicalise before insert, in this order:

1. Strip tracking parameters (`utm_*`, `fbclid`, `gclid`, session ids) and
   fragments; lowercase host; drop `www.`; resolve redirect chains to the final
   URL; apply `rel=canonical` when present.
2. Resolve to a DOI if one is discoverable — a DOI outranks any URL, and
   collapses the publisher page, the PDF, the arXiv preprint and the mirror into
   one source.
3. Hash the extracted text. A matching `text_hash` under a different URL is a
   syndication duplicate: link it as an alias rather than creating a second
   source.

**Re-encountering a source is not a duplicate — it is the signal.** A second
`ingestion_event` against an existing source is exactly what coverage and
spacing are made of. Never dedupe events.

## Engagement depth

Levels, ordered by the processing depth they imply:

| Level | Meaning | How it is established |
|---|---|---|
| `skim` | Opened, partially scrolled | telemetry, or default |
| `read` | Substantially consumed | telemetry: active time ≈ plausible reading time *and* scroll ≥ 80% |
| `annotate` | Highlighted or noted | an `annotation` row exists |
| `apply` | Used it for something | user-asserted |
| `teach` | Explained it to someone | user-asserted |

Telemetry can establish `skim` and `read`. `annotate` is established by evidence.
`apply` and `teach` can only be asserted by the user — one tap, and worth asking
for, because they are the strongest available predictors of durable retention and
the cheapest data the system will ever collect.

`engagement_source` records which mechanism set the value, so a model fit later
can weight telemetry-derived and self-reported levels differently. A phone left
open on an article is a known failure mode for dwell-time: cap active time at a
plausible reading rate, require screen-on and foreground, and discard sessions
with no scroll events.

## Novelty at ingest

Computed during chunking, before any paid model call:

```
novelty(document) = 1 − max over chunks c of ( max cosine(c, corpus) )
```

Stored on the ingestion event with the embedding model id — novelty from
different embedders is not comparable, and mixing them silently is a subtle way
to corrupt a year of data.

This is cheap, private, needs no network, and directly answers "have I seen this
before, and how close was it?" It is also the input to the `prior coverage`
display at capture time: the user shares an article and immediately sees *you
have covered this from two other sources, most recently in March*.

## Scheduling and cost control

| Stage | When |
|---|---|
| capture, extraction | immediately, foreground |
| chunk, embed, novelty | immediately, background, on-device |
| link, itemise | deferred: charging + unmetered network, batched overnight |
| coverage rollup | after linking, incremental |

Deferring the paid stages is not only a cost decision — the Batch API halves the
price for exactly this kind of non-latency-sensitive work. See
[08-llm-integration.md](08-llm-integration.md).
