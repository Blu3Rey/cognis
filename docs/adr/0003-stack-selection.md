# 0003 — TypeScript core shared across app, backend and evals

**Status:** Accepted

## Context

cognis has non-trivial domain logic — coverage rollup, memory scheduling,
suggestion ranking — that must run in three places: on the device (offline), on
the backend (batch jobs), and in the evaluation harness (regression tests).

If that logic is implemented twice in two languages, the implementations diverge,
and the first symptom is the device and the server disagreeing about a user's
coverage numbers with no way to tell which is right.

## Decision

A single TypeScript package, `@cognis/core`, holds the schema, migrations, and
all domain logic, with platform specifics behind injected ports. It runs in the
React Native app, in the Node/Bun backend, and under Node in tests.

| Layer | Choice |
|---|---|
| Shared core | TypeScript |
| Mobile | React Native + a native module for the reader and telemetry |
| Storage | SQLite via a JSI binding + `sqlite-vec` |
| Embeddings | small sentence-embedding model via ONNX, on-device |
| Backend | TypeScript, stateless |
| Model access | Anthropic TypeScript SDK, server-side only ([0008](0008-model-access-via-backend-proxy.md)) |

Core must be deterministic given its inputs and its declared version. Time and
network are ports, never ambient — in particular, nothing in core calls
`Date.now()`, because every retention test needs controlled time.

## Consequences

- One implementation of the logic whose correctness the product depends on.
- The evaluation harness exercises the same code the device runs.
- React Native's WebView ecosystem is mature, which matters for the reader.
- Cost: on-device ML in the JS ecosystem is less pleasant than on the JVM or in
  Swift, and the embedding path will need a native module.
- Cost: heavy numeric work on the JS thread needs care; batch operations belong
  in workers or in SQL.

## Alternatives considered

**Kotlin Multiplatform.** Genuinely good for shared logic with native
performance, and stronger for on-device ML. Loses on iOS developer experience for
a small team and on the reader/WebView story. Becomes the right answer if native
reader work dominates the schedule — revisit at M5.

**Native Swift + Kotlin apps, Python backend.** Best per-platform quality and the
best ML ecosystem, at the cost of implementing the domain logic three times. The
divergence risk is exactly what this decision exists to avoid.

**Python backend with thin clients.** Good for the concept-linking research loop,
but it puts the core logic on the server, which contradicts local-first
([0004](0004-local-first-sqlite.md)).

## Notes

Nothing in the schema ([02](../02-data-model.md)) or the API contract
([10](../10-api-contract.md)) depends on this choice. A reversal costs an
implementation, not a redesign.
