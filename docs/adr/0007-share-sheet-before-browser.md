# 0007 — Share sheet before the built-in reader

**Status:** Accepted

## Context

The product vision includes a built-in browser that extracts and analyses what
the user reads. It is the most engineering-expensive component in the plan —
paywalls, JS-rendered pages, bot walls, PDF rendering, and per-platform WebView
differences are an open-ended long tail — and it is easy to start with because it
feels like the core of the product.

It is not the core. A share extension captures from Safari, Chrome, PDF readers,
mail and social apps — everywhere the user already reads, including the places
an in-app browser will never reach — for a fraction of the effort.

## Decision

Ship the share sheet in M0 as the primary capture path. Defer the reader to M5.

The reader is justified by exactly one capability the share sheet cannot provide:
**reading telemetry** — dwell time, scroll depth, scroll reversals, revisits —
which is the objective engagement-depth signal and the ingestion variable with the
strongest claim to predicting durable retention.

So: the reader exists to *measure* reading, not to *enable* it. It is built when
the retention engine is ready to consume what it measures, which is after M3.

## Consequences

- Capture works everywhere from the first milestone, including from apps an
  in-app browser could not open.
- The extraction long tail is met gradually, with failures recorded rather than
  fought ([03](../03-ingestion.md)).
- Engagement depth is user-asserted until M5 and telemetry-derived after. The
  schema carries `engagement_source` from the start so the two are never
  conflated in a later model fit.
- Cost: the user leaves the app to read, so no reading-time features until M5.
- Cost: no telemetry means the early retention model relies on self-reported
  engagement, which is weaker.

## Alternatives considered

**Reader first.** Better demo, worse capture coverage, months of extraction work
before a single useful coverage query exists. Highest risk of spending the
project's runway on a WebView.

**Reader only, no share sheet.** Caps ingestion at what the in-app browser can
open, which excludes most of where people actually read.

**Neither — manual paste only.** Friction high enough that the corpus never grows
to where the analytics become interesting.

## Note

M5 has a real falsification condition: if telemetry-derived engagement does not
measurably improve scheduler calibration over the self-reported baseline, the
reader's justification is gone and its scope should shrink accordingly. That is a
finding worth having, not a failure.
