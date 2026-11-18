# CLAUDE.md — memory-mcp-server

Persistent memory MCP server (7 tools) with semantic search, LLM summarization, automatic compaction, atomic-fact ingestion (`memory_ingest`), and parent-context retrieval (`memory_expand` / recall expansion).

## Commands

- `npm run build` — TypeScript compilation to `dist/`
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end integration tests (spawns real server, needs `.env`)
- `npm run benchmark` — run LoCoMo retrieval benchmarks (verbose)
- `npm run benchmark:json` — benchmark with JSON output
- `npm start` — start the MCP server (stdio transport)
- `npm run pin-models` — record the pinned revisions and SHA-256 hashes of the default models (maintainers)
- `memory-mcp-server --prefetch-models` / `--verify-models` — fill or check the verified model store (JSON report on stdout; exit 0, 1, or 2 for usage errors)
- `memory-mcp-server backups [--db <path>]` / `restore <copy> [--db <path>]` — list and restore the database copies kept next to the database (stop the sessions using it first)

Single test file: `npx vitest run test/scoring.test.ts`
Single test by name: `npx vitest run -t "merges results"`

## Architecture

```
src/
├── index.ts              Entry point (stdio transport, config, shutdown; hands other command lines to cli.ts / models/cli.ts)
├── cli.ts                `backups` / `restore` maintenance commands
├── admin.ts              Host-side administration of one database (the `./admin` export behind `ironcurtain memory <persona|job> ...`)
├── version.ts            Package version reported to MCP clients (read from package.json)
├── engine.ts             MemoryEngine interface (public API surface)
├── engine-impl.ts        Wires storage, retrieval, embedding, LLM subsystems
├── server.ts             MCP tool registration via registerTool (7 tools, with titles, TOOL_ANNOTATIONS and an output schema for memory_recall)
├── config.ts             Env-based configuration (all MEMORY_* vars; invalid values refuse to start)
├── types.ts              Shared types (Memory, StoreResult, IngestResult, RecallResult, ExpandResult, ExpandMode, etc.)
├── prompts.ts            Exportable system prompts and tool descriptions
├── storage/
│   ├── database.ts       SQLite schema (SCHEMA_VERSION 5): memories (+ segment_id FK), segments (off-index source chunks), vec_memories, memories_fts (FTS5). In-place MIGRATIONS; forget snapshots (VACUUM INTO, newest 5 kept); openExistingDatabase for admin reads
│   ├── queries.ts        Data access: insert, search (vector KNN + FTS), delete, stats; segment helpers (materializeSegment, getSegmentsByIds, getLiveSegmentsByIds, adoptRicherPendingSegment, purgeSegments, deleteSegmentsWithoutLiveFacts, forgetMemoryRows)
│   ├── extraction.ts     LLM atomic-fact extraction (chunkBlob, extractFacts) + splitToPassages for expansion
│   ├── constants.ts      Embedding dimensions, dedup thresholds
│   ├── maintenance.ts    Consolidation → decay → compaction → clean-up, under a mutex and a lease row in schema_meta
│   ├── compaction.ts     Clustering + summarization of decayed memories (LLM, or extractive without one)
│   └── consolidation.ts  Deferred batch dedup/contradiction detection at store time
├── retrieval/
│   ├── pipeline.ts       Full recall flow (steps below)
│   ├── scoring.ts        Score-based hybrid fusion, composite scoring, relevance filter, reranker filter, budget packing
│   ├── expansion.ts      Post-dedup parent re-expansion (NOT the ranker): group kept facts by segment, split-and-rank source passages, hybrid budget pack. Shared by recall (limit 1/segment) and memory_expand.
│   ├── reranker.ts       Cross-encoder re-ranking (ms-marco-MiniLM, raw logits)
│   ├── dedup.ts          Embedding-based deduplication
│   └── formatting.ts     Output: summary (LLM), list (bullets), raw (JSON)
├── embedding/
│   ├── embedder.ts       BGE model with asymmetric query prefixes, lazy singleton
│   └── models.ts         Known models: vector dimensions, aliases, query prefixes
├── models/
│   ├── cli.ts            --prefetch-models / --verify-models (JSON report)
│   ├── manifest.ts       Pinned revisions and file hashes (built-in pins; MEMORY_MODEL_MANIFEST replaces them per model)
│   ├── model-store.ts    The verified model store and the only code that downloads models
│   └── transformers-env.ts  transformers.js reads models only from the store
├── llm/
│   └── client.ts         OpenAI-compatible client, judgment helpers (single + batch)
├── tools/
│   ├── store.ts          memory_store — persist one pre-formed fact with tags, importance
│   ├── ingest.ts         memory_ingest — LLM-decompose a raw blob into many atomic facts (mode, dry_run, as_of, on_extraction_failure)
│   ├── recall.ts         memory_recall — semantic query with token budget, expand mode, structured output (structuredContent carries source_segment_ids, the ids memory_expand takes)
│   ├── expand.ts         memory_expand — at most max_passages (default 3, at most 20) passages of a source segment: the most relevant to a query, best first, or the start of the source in source order; followed by a "[passages i-j of n ...]" line (ExpandResult.total_passages)
│   ├── context.ts        memory_context — session briefing (does not count as access)
│   ├── forget.ts         memory_forget — intersecting criteria (ids AND tags AND before AND query), dry_run, confirm for tags/query/before
│   ├── inspect.ts        memory_inspect — stats, recent, tags, export
│   └── validation.ts     Input validation (content 10K, query 2K, budget 50K, ingest content 200 KB (MAX_INGEST_CONTENT_BYTES), source 256 chars (MAX_SOURCE_LENGTH), importance capped at 0.8, stored minimum 0.01)
└── utils/
    ├── tags.ts           JSON tag parsing
    ├── clustering.ts     Single-linkage clustering by embedding similarity
    ├── content-hash.ts   Content hashes of segments
    ├── dates.ts          Defensive date rendering
    ├── fact-text.ts      Normalized fact text for store-time dedup
    ├── secrets.ts        Secret detection: memory_store rejects secrets, ingest removes them
    ├── framing.ts        Untrusted-data framing of every memory-bearing tool output
    ├── provenance.ts     metadata.writer (MEMORY_WRITER_KIND, MEMORY_SESSION_ID)
    ├── review.ts         Review quarantine for unattended writers (MEMORY_WRITER_SCOPE)
    └── source-markers.ts [src:<segment id>] markers in recall and briefing output
```

## Retrieval Pipeline (`retrieval/pipeline.ts`)

1. **Embed query** — BGE asymmetric prefix for retrieval-optimized embedding
2. **Hybrid search** — sqlite-vec KNN (`embedding MATCH ? AND k = ?`, L2 on normalized embeddings, so cosine distance = L2²/2; 50 candidates, distance < 0.9; k widened until enough rows pass the filters) + FTS5 (50 keywords; the query keeps the letters of every script and quotes each word). Both channels return live memories only (importance > 0, not compacted). With `tags`, both apply the tag condition before their limits, so tagged memories are found however many untagged ones rank higher
3. **Score-based fusion** — Weaviate-style relativeScoreFusion: min-max normalize vector similarity and BM25 scores, blend with alpha weighting (default 0.5)
4. _(no separate tag filter: tags scope step 2)_
5. **Composite scoring** — Weighted: fusion relevance (0.65) + recency (0.15) + importance (0.1) + access (0.1). Fusion score already incorporates vector + BM25 magnitudes
6. **Relevance gating** — Drop fusion score < 5% of max
7. **Cross-encoder re-ranking** — ms-marco-MiniLM-L-6-v2 via `AutoModelForSequenceClassification` (raw logits, NOT pipeline API which squashes to 1.0). Try/catch falls back gracefully
8. **Re-ranker filter** — Relative gap (5 logit points from best, `RERANKER_SCORE_GAP`), min 5 results
9. **Dedup** — Embedding cosine similarity
   9b. **Parent re-expansion** (`retrieval/expansion.ts`, `expand:'auto'|'parent'` only) — POST-dedup, NOT part of the candidate ranker. Group kept facts by `segment_id`, fetch only segments a live memory references, by primary key (off-index), embed and rank their passages lazily (stopping at `max_expand_passages`) against the step-1 query embedding, then hybrid-pack: reserve budget so the single top source passage is guaranteed (top facts never evicted), supplementary passages ride leftover budget up to `max_expand_passages`. `expand:'none'` is a byte-for-byte facts-only pack. Never touches the candidate set, fusion/composite/rerank scores, or selection order.
10. **Token budget packing** — Greedy skip (not break), then format (folded into step 9b for the expansion modes; plain `packToBudget` for `expand:'none'`)

## Key Design Decisions

- **Hybrid search over vector-only**: FTS keyword matches are most valuable precisely when vector search is uncertain. Always include both — score-based fusion handles the merge.
- **Score-based fusion over rank-based (RRF)**: Pure RRF discards score magnitudes and compresses into a tiny range (~0.009-0.033), making relevance filtering ineffective. Weaviate-style relativeScoreFusion preserves normalized score magnitudes in [0,1], giving the relevance gate real discriminating power.
- **Relative reranker threshold**: ms-marco is trained on web search, so conversational content often gets negative logits even when relevant. Absolute threshold=0 cuts too aggressively. Use gap-from-best instead.
- **Raw logits, not pipeline API**: The HuggingFace `pipeline('text-classification', ...)` applies softmax on single-output cross-encoders, squashing scores to always 1.0. Must use `AutoModelForSequenceClassification` directly.
- **Promise-cached model loading**: Both embedder and reranker cache the loading promise (not the resolved value) to prevent concurrent `recall()` calls from racing and loading the model twice.
- **Graceful LLM degradation**: System works without LLM — formatting falls back to list mode, consolidation marks everything consolidated, and compaction writes extractive summaries.
- **Bounded LLM spend**: every LLM call has a deadline (`MEMORY_LLM_TIMEOUT_MS`, `MEMORY_LLM_FORMAT_TIMEOUT_MS` for recall formatting) and the process has a call and token budget (`MEMORY_LLM_MAX_CALLS`, `MEMORY_LLM_MAX_TOKENS`); past it, features fall back as without an LLM.

## Storage

- **SQLite** with `better-sqlite3` (synchronous API, transactions)
- **sqlite-vec** extension for vector nearest-neighbor search (KNN on L2 over normalized embeddings; cosine distance = L2²/2; 768-dim for the default model)
- **FTS5** for keyword search with BM25 ranking
- **`segments` table** — source chunks `memory_ingest` decomposes facts from. OFF the retrieval index by construction: never embedded, never in `vec_memories`/`memories_fts`; fetched only by primary key during recall-time parent expansion ("index fine, return coarse"). Each ingested fact's `segment_id` is a FK to `segments`; `memory_store` rows keep `segment_id = NULL`. A segment is written when the first fact links to it (`PendingSegment` / `materializeSegment`), not one per chunk up front; `adoptRicherPendingSegment` repoints an ingest-merge survivor to the richer parent. Forgetting a fact deletes its source segment (sibling facts are unlinked) and removes the forgotten text from `metadata.superseded` histories.
- **`SCHEMA_VERSION = 5`** (`storage/database.ts`). An older released schema (3 or 4) is upgraded **in place** by the ordered, additive `MIGRATIONS`, after a backup and under `BEGIN IMMEDIATE`. Only pre-v3, unstamped legacy, unparseable or half-created schemas are still backed up and rebuilt. A NEWER stamp **fails closed** so an older binary never touches a DB it can't understand. A stored embedding model or vector size that differs from the configured one refuses the open (no silent re-embedding).
- **Forget snapshots**: before a bulk deletion (and before the first deletion of each server run) the database is copied to `<db>.forget-snapshot-<timestamp>.db` (`0600`, newest 5 kept); a snapshot keeps forgotten data until it ages out.
- **Maintenance pipeline**: consolidation (batch LLM dedup and contradiction detection; new memories are paired with consolidated ones and close batch memories; the newest fact wins a contradiction and the replaced text is kept in `metadata.superseded`, last 5 entries), decay (vitality sampling), compaction (cluster + summarize; re-embeds decayed texts; the summary is written atomically only if the cluster is unchanged), then clean-up (prune non-live vectors, sweep segments with no live fact). A maintenance mutex and a lease row in `schema_meta` keep two processes from running it at once.
- Dedup at store: only identical normalized text (within cosine 0.05) is merged immediately, keeping the stored text; everything within 0.3 is deferred to consolidation with LLM judgment. Importance 0 is stored as 0.01 (`MIN_STORED_IMPORTANCE`).

## Configuration

All config via environment variables (prefix `MEMORY_`):

- `MEMORY_NAMESPACE` — isolation namespace (default: `default`)
- `MEMORY_DB_PATH` — SQLite database path
- `MEMORY_EMBEDDING_MODEL`, `MEMORY_EMBEDDING_DTYPE`, `MEMORY_EMBEDDING_DIMENSIONS` — embedding model (default: `Xenova/bge-base-en-v1.5`, `q8`, dimensions from the model); a custom model needs a pin in a manifest file
- `MEMORY_RERANKER_ENABLED` — cross-encoder toggle (default: `true`)
- `MEMORY_RERANKER_MODEL` — reranker model (default: `Xenova/ms-marco-MiniLM-L-6-v2`)
- `MEMORY_MODELS_DIR` (absolute; default `$XDG_CACHE_HOME/memory-mcp/models`), `MEMORY_MODELS_OFFLINE` (never download), `MEMORY_MODEL_MANIFEST` (absolute path to replacement pins) — the verified model store. IronCurtain passes `MEMORY_MODELS_DIR=~/.ironcurtain/models` and never `MEMORY_MODEL_MANIFEST`.
- `MEMORY_LLM_MODEL`, `MEMORY_LLM_BASE_URL`, `MEMORY_LLM_API_KEY` — LLM for summarization
- `MEMORY_LLM_TIMEOUT_MS` (60000), `MEMORY_LLM_FORMAT_TIMEOUT_MS` (20000), `MEMORY_LLM_MAX_CALLS` (500), `MEMORY_LLM_MAX_TOKENS` (1000000) — LLM deadlines and per-process budget
- `MEMORY_WRITER_KIND` (`interactive`, `cron`, `workflow`), `MEMORY_SESSION_ID`, `MEMORY_WRITER_SCOPE` — writer provenance and the review scope of unattended writers (IronCurtain sets them per session)
- `MEMORY_DEFAULT_TOKEN_BUDGET` — default recall budget (default: 800)

## Testing

- **Unit tests**: Vitest, in-memory SQLite, mocked LLM/embedder where needed
- **E2E tests**: Spawn real server via `StdioClientTransport`, exercise full MCP protocol
- **Real-model suites**: the test globalSetup (`test/setup/test-models.global.ts`) builds a model store and manifest from the local transformers cache
- **Timeout**: 30s (E2E tests need model loading time)
- **Temp dirs**: `/tmp/memory-test-*` created/cleaned per test
- **Test helpers**: `makeMemory()`, `makeScored()`, `randomEmbedding()` — defined in each test file

## Benchmark

LoCoMo benchmark (`benchmark/`) evaluates retrieval quality:

- Ingests multi-session conversations, asks factual questions, measures evidence recall/precision
- Run: `cd benchmark && uv run locomo run --conversation-limit 1 --question-limit 20 --reader-provider anthropic`
- Results in `benchmark/results/<timestamp>/`
- Key metrics: evidence recall (are relevant memories retrieved?), evidence precision (what fraction of retrieved memories are relevant?)

Host review approval uses `MemoryReviewReceipt` (`id` plus SHA-256 digest), never bare ids or approve-all. Review/show prints the entire quoted releasable payload; `admin.ts` re-reads and compares it in the IMMEDIATE write transaction before release. Recall bookkeeping does not invalidate a receipt, but any text-bearing payload change does (RV-08).
