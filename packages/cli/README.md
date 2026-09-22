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

## Concept linking

`cognis link` resolves surface forms to Wikidata concepts using Claude, then
rolls up coverage. **This is the first command that spends money**, so:

```bash
# See what it would do, send nothing, spend nothing
cognis link --dry-run

# Then, when you're ready
cognis link
```

It reports token usage and an estimated cost after every run, and refuses to
send a private source anywhere.

Credentials come from `ANTHROPIC_API_KEY`, or from an `ant auth login` profile.

Three things the adapter is deliberate about:

- **It cannot invent an identifier.** Any concept id the model returns that was
  not in the candidate list is discarded. A hallucinated QID would enter the
  graph as a real node and be nearly impossible to spot later.
- **A refusal degrades to NIL.** A corpus is arbitrary web text, and one chunk
  tripping a classifier must not abort a document. Server-side fallbacks are on
  by default; a refusal that survives them links that chunk as NIL.
- **The prompt caches.** Instructions and the output contract are byte-identical
  on every call and carry the cache breakpoint; the passage and its candidates
  come after it. Linking is the dominant recurring cost.

### The number you should not trust yet

`cognis link` prints a warning, and it means it: **the linker's precision has
never been measured.** Coverage counts, `gaps`, quiz targets and suggestions
all inherit linking quality, and `docs/12` §2 makes precision the gate for
building on any of it.

The harness exists (`runLinkingEval` in core). The labelled set does not — see
[eval/README.md](../../eval/README.md). That is step 4, and it is the most
valuable thing left to do.

### Batching

`docs/08` leans on the Batches API for a 50% discount, and this adapter does
not use it. Batching needs a core-level change: the `Linker` port is
request/response and the pipeline calls it per chunk, so batch submission would
mean collecting every request first, submitting, and resolving afterwards.
Worth doing before linking a large corpus; not worth guessing at before the
precision gate is passed. Note also that `fallbacks` is rejected on the Batches
API, so a batch path has to handle refusals itself.

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
| `link [--all] [--dry-run]` | Resolve concepts, roll up coverage |
| `concepts [--limit N]` | What the corpus is about |
| `gaps [--min-sources N]` | Met from several sources, never covered directly |
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
| Wikidata client — URL construction, parsing, hierarchy walk, caching, politeness | **Verified** against recorded API payloads |
| Claude linker — id validation, refusal handling, cache placement, offsets, cost | **Verified** against a stub client |
| **The real embedding model loading** | **Not verified.** `huggingface.co` is blocked at the CONNECT level in the environment this was built in. `cognis doctor` checks it on a machine with access. |
| **The real Wikidata API** | **Not verified.** `wikidata.org` is blocked in the same environment. |
| **The real Claude API accepting this request shape** | **Not verified.** No API key here. `cognis link --dry-run` costs nothing; the first real `cognis link` is the test. |

That last row is the honest gap. The code is written and its surroundings are
tested; the weights have never been downloaded by this code.
