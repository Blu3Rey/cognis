# @cognis/cli

A real client for `@cognis/core`. Its job is to get **actual reading through
the actual pipeline**, so that the fixtures the core test suite runs against
stop being the only thing the code has ever seen.

It is also the scripting surface for the two evaluations that are still unrun
(linker precision, and whether reading telemetry helps).

## Quick start

```bash
npm install
npm run build -w @cognis/cli

# Check the setup before trusting it
node packages/cli/dist/src/bin.js doctor

# Ingest something you actually read
node packages/cli/dist/src/bin.js ingest https://example.com/an-article

# Then ask it things
node packages/cli/dist/src/bin.js search "spaced repetition"
node packages/cli/dist/src/bin.js stats
node packages/cli/dist/src/bin.js list
```

Data lives in `~/.cognis` by default. Set `COGNIS_HOME` to keep a throwaway
corpus somewhere else while experimenting.

## Embeddings

Real semantic embeddings need `@huggingface/transformers`, which is an
**optional** dependency:

```bash
npm install @huggingface/transformers -w @cognis/cli
```

It is optional because `onnxruntime-node`'s postinstall downloads native
binaries, and that fails in sandboxes, offline machines and several CI images.
The adapter therefore uses the **WASM backend**, which is slower and works
everywhere.

Model weights (~23MB for `Xenova/all-MiniLM-L6-v2`) are fetched once into
`~/.cognis/models` and read from disk thereafter. `--offline` forbids fetching
entirely, for a machine with no access to huggingface.co.

Without the package, `--embedder hash` falls back to core's lexical embedder.
**That fallback is not semantic**: two articles making the same point in
different words score as *novel*, which is the opposite of what novelty is
for. The CLI says so on every run rather than letting you forget.

### Never mix models in one corpus

Vectors from different embedding models are not comparable. Ingesting with one
model into a corpus embedded with another is refused, with the remedy:

```bash
cognis reindex --all
```

`cognis doctor` also reports this, and `cognis stats` shows the vector count
per model.

## Commands

| | |
|---|---|
| `ingest <url\|file>...` | Fetch, extract, store, index |
| `index [--all]` | Chunk and embed whatever is pending |
| `reindex --all` | Re-chunk and re-embed everything |
| `list [--limit N]` | Recent captures |
| `show <sourceId>` | Everything known about one source |
| `search <query> [--literal]` | Semantic or substring search |
| `stats` | Corpus summary |
| `doctor` | Verify the setup |
| `privacy log` | Everything that has left this device |
| `privacy set <id> --private\|--public` | Exclude a source from egress |
| `privacy check <url>` | How a URL would be classified |
| `export <path>` / `import <path>` | Full JSONL round-trip |

Every read command takes `--json`.

## Extraction

Mozilla Readability over a linkedom DOM — the same algorithm Firefox Reader
View uses, which is what a mobile WebView would run.

Extraction failure is a **first-class outcome**, not an error: a paywalled or
JS-only page keeps its `source` and `ingestion_event` rows and is marked
`extraction_failed` with a reason. The user still read the thing. Re-running
`ingest` later retries it.

A fetched page yielding under 50 words is treated as a consent wall rather
than an article, because storing a cookie banner as an article is a defect
(`docs/12` §1). Local files you deliberately point at have no such floor.

PDFs are not implemented yet.

## What is verified, and what is not

| | |
|---|---|
| Extraction | **Verified end to end**, including against consent walls, JS shells and chrome-heavy pages |
| Fetching, capture, novelty, search, privacy, export | **Verified end to end** through the real binary against a real HTTP server and real SQLite |
| Embedder plumbing — batching, dimension checks, ordering, errors | **Verified** against an injected pipeline |
| **The real model actually loading** | **Not verified.** `huggingface.co` is blocked in the environment this was built in, at the CONNECT level. Run `cognis doctor` on a machine with access — it loads the model and embeds a probe string. |

That last row is the honest gap. The code is written and its surroundings are
tested; the weights have never been downloaded by this code.
