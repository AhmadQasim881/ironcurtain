# Memory MCP Server

A persistent memory server for LLM agents using the [Model Context Protocol](https://modelcontextprotocol.io/). Provides semantic search, optional LLM summarization, and automatic maintenance — all backed by a single SQLite file.

> **Database upgrades.** The on-disk schema is version `5`. A database written by an older released schema (3 or 4) is upgraded **in place** on startup, after the server writes a backup copy next to it; only older, unstamped or damaged schemas are still backed up and rebuilt from scratch. If the backup cannot be written, startup fails closed and the original database is left untouched. A database written by a **newer** schema also fails closed (the server refuses to open it), and so does a database whose stored embedding model or vector size differs from the configured one. `memory-mcp-server backups` lists the copies and `memory-mcp-server restore` restores one (see [Maintenance commands](#maintenance-commands)).

## Why Another Memory Server?

Most memory MCP servers fall into two camps: minimal and infrastructure-heavy. The official `@modelcontextprotocol/server-memory` stores a knowledge graph in a JSON file with substring search only — useful, but limited as memories grow. Mem0, Hindsight, and doobidoo offer semantic search and smart features, but require Python runtimes, Docker containers, or external databases (PostgreSQL, Qdrant, Neo4j).

This server fills a specific gap: **a TypeScript MCP server with semantic search, LLM summarization, and automatic maintenance that runs from a single SQLite file with zero external dependencies.**

- **Single command, single file** — `npx` to start, one `.db` file to back up. SQLite + sqlite-vec + FTS5 handle storage, vector search, and keyword search in-process.
- **Works without an LLM, improves with one** — Extractive retrieval, identical-text dedup, and bullet-point formatting work out of the box. Adding a cheap LLM endpoint (Haiku, Ollama, etc.) enables abstractive summarization, direct question answering, contradiction detection, smarter consolidation, and atomic-fact extraction from raw blobs (`memory_ingest`).
- **Atomic-fact decomposition** — `memory_ingest` takes a raw conversation, document, or session summary and uses an LLM to break it into many durable, atomic-fact memories, each individually retrievable — instead of forcing the agent to call `memory_store` once per fact.
- **Parent-context retrieval ("index fine, return coarse")** — facts are indexed at fine grain, but recall can return the query-ranked source passage a cluster of facts came from (e.g. a contract clause), so the agent gets the surrounding detail, not just thin headlines.
- **Token-budget-aware responses** — Instead of dumping raw memories into your context window, the server summarizes and packs results to fit a specified token budget. The `memory_context` tool provides a structured session-start briefing — a capability unique to this server.

For a detailed competitive analysis covering 11 memory systems, see [docs/designs/memory-server-comparison.md](../../docs/designs/memory-server-comparison.md).

## Features

- **Score-based hybrid fusion** — vector similarity (BGE-base) + FTS5 BM25 keyword search, merged via Weaviate-style relativeScoreFusion with min-max normalized scores blended by alpha weighting. Unlike pure rank-based fusion (used by Letta, Zep, mind-mem, LangChain), score-based fusion retains the discriminating power of both retrieval signals — an approach validated by production search engines (Weaviate, Elasticsearch, Qdrant) and research (Bruch et al. 2023)
- **Cross-encoder reranking** — ms-marco-MiniLM re-ranks candidates using raw logits with relative gap filtering, improving precision without aggressive cutoffs
- **Composite scoring** — fusion relevance (incorporating vector + BM25 magnitudes) blended with recency, importance, and access pattern signals
- **Atomic-fact decomposition** — `memory_ingest` decomposes a raw blob (conversation, document, session summary) into many durable atomic-fact memories via an LLM, each with its own importance; `mode="conversation"` extracts only explicitly stated facts while `mode="document"` allows reasonable inference
- **Parent-context retrieval ("index fine, return coarse")** — source chunks live in a `segments` table kept OFF the retrieval index; each ingested fact links to its segment, and recall can return the query-ranked source passage when several matched facts share a parent. `memory_expand` fetches a parent passage on demand for the agentic "got a headline → read its source" follow-up
- **Token-budget-aware retrieval** — returns pre-summarized context blocks sized to fit your context window
- **Direct question answering** — `format="answer"` synthesizes across retrieved memories to answer questions directly, without a separate reader LLM
- **SQLite-native, zero external dependencies** — embeddings and reranking run locally in-process; no Postgres, Neo4j, Redis, or Docker required. One `.db` file to back up
- **Works without an LLM, improves with one** — extractive retrieval and bullet-point formatting work out of the box; adding a cheap LLM (Haiku, Ollama) enables abstractive summarization, direct answers, and contradiction detection
- **Automatic maintenance** — unused memories decay over time; related memories compact into summaries via three-phase pipeline (consolidation, decay, compaction)
- **Namespace isolation** — multiple agents or projects share one database without cross-contamination

## Quick Start

### Configure in Claude Desktop / MCP client

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@provos/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.local/share/memory-mcp/default.db"
      }
    }
  }
}
```

### With an LLM (recommended)

Adding an LLM enables summarization, direct question answering (`format="answer"`), and contradiction detection. The LLM client uses the OpenAI SDK, so `MEMORY_LLM_BASE_URL` must point to an OpenAI-compatible endpoint.

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@provos/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.local/share/memory-mcp/default.db",
        "MEMORY_LLM_API_KEY": "your-api-key",
        "MEMORY_LLM_BASE_URL": "https://openrouter.ai/api/v1",
        "MEMORY_LLM_MODEL": "anthropic/claude-haiku-4-5-20251001"
      }
    }
  }
}
```

### With Ollama (fully local)

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@provos/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.local/share/memory-mcp/default.db",
        "MEMORY_LLM_BASE_URL": "http://localhost:11434/v1",
        "MEMORY_LLM_MODEL": "llama3.2:3b"
      }
    }
  }
}
```

## Tools

Each tool carries MCP tool annotations for clients that show or gate calls by them: `memory_context`, `memory_expand` and `memory_inspect` are read-only; `memory_store`, `memory_ingest` and `memory_forget` may change or delete existing memories (store and ingest can merge into one and start maintenance); `memory_recall` updates access statistics only. No tool reaches beyond the memory store.

### memory_store

Store a memory for later retrieval. Memories are automatically embedded for semantic search.

```
content    (string, required)   — The memory content. Store one fact per call.
tags       (string[], optional) — For filtering, e.g. ["preference", "project:foo"]
importance (number, optional)   — 0-1 scale, controls decay resistance. Default 0.5; capped at 0.8.
```

Content or tags that contain a secret value (an API key, token, password and the like) are refused.

### memory_ingest

Decompose a raw blob (conversation, document, or session summary) into many atomic, durable memories via an LLM. Where `memory_store` persists one pre-formed fact, `memory_ingest` extracts many facts from one input — each with its own importance — and links them to the source segment they came from (so recall can later return that source passage).

```
content              (string, required)   — Raw blob to decompose (at most 200 KB)
source               (string, optional)   — A label stored on each fact, e.g. "session:abc" (at most 256 characters;
                                            a label, not verified provenance)
mode                 (string, optional)   — "conversation" (default, strict explicit-only) or
                                            "document" (allows reasonable inference; better for transcripts)
tags                 (string[], optional) — Seed tags applied to EVERY extracted fact
importance           (number, optional)   — 0-1 SEED importance; per-fact importance from the model wins. Default 0.5.
dry_run              (boolean, optional)  — Run extraction and return the proposed facts WITHOUT writing. Default false.
                                            (Still calls the LLM; only skips persistence.)
on_extraction_failure (string, optional)  — When a chunk yields no facts: "degrade" (default — store the
                                            blob as a single memory), "skip" (write nothing), or "error" (throw)
as_of                (number|string, opt) — Backdate facts to this time (epoch ms or ISO 8601) instead of now;
                                            must not be more than 5 minutes in the future
```

An ingest keeps at most 200 facts. A result cut short carries `truncated` and `dropped_chunks`, and the tool text tells the agent to ingest the rest separately. Secret values are removed from the extracted facts. A long ingest sends progress notifications when the client asks for them (a progress token in the request), which keeps a waiting client's request alive.

Example (preview a decomposition without writing):

```
memory_ingest({ content: "...session transcript...", mode: "document", dry_run: true })
→ Dry run — nothing written. 3 fact(s) proposed:
  1. User prefers TypeScript over Python (importance: 0.7)
  2. Project "foo" deploys via GitHub Actions (importance: 0.6)
  3. ...
```

### memory_recall

Retrieve memories relevant to a query. Returns formatted results within a token budget.

```
query              (string, required)   — Natural language query
token_budget       (integer, optional)  — Max tokens in response. Default 800.
tags               (string[], optional) — Only memories with ALL these tags (they scope candidate generation, so
                                          tagged memories are found however many untagged ones rank higher)
format             (string, optional)   — "summary" (default), "list", "raw", or "answer"
expand             (string, optional)   — "auto" (default), "none", or "parent" — see below
max_expand_passages (integer, optional) — Max source passages returned across the result. Default 2.
```

**Format modes:**

- `summary` — LLM-generated briefing (falls back to extractive clusters without LLM). This default makes an LLM call on every recall when an LLM is configured.
- `list` — Bullet list with dates and importance scores
- `raw` — JSON `{ notice, memories }` with all metadata
- `answer` — LLM answers the query directly by synthesizing across retrieved memories (falls back to `list` without LLM)

**Expand modes (parent-context retrieval):**

- `auto` (default) — when several matched facts share the same source segment (e.g. a contract's clauses), return that segment's query-ranked source passage alongside the facts
- `none` — strictly pinpoint facts, no source passages
- `parent` — force the source passage for every matched fact that has one

Every memory-bearing tool output is framed as untrusted notes written by earlier sessions (a notice and `<memory_notes>` tags), since memories can carry text from web pages, email or unattended runs. Facts extracted from ingested text carry `[src:<segment id>]` markers in recall and briefing output (the `summary` and `answer` formats end with a sources line); `memory_expand` takes that id.

Alongside the human-readable text, `memory_recall` returns `structuredContent` with `memories_used`, `total_matches`, `expanded` (whether any source passage was returned), `expanded_segment_ids`, and `source_segment_ids` (the source of every recalled fact) — the segment ids an agent can feed to `memory_expand` to drill into a source. The tool declares these fields in its output schema.

### memory_expand

Fetch the source passage(s) a recalled fact was extracted from, given a `segment_id` surfaced by a prior `memory_recall` (in `expanded_segment_ids`, or a `raw` result's `segment_id`). This is the agentic "I got a headline, give me THIS fact's parent" follow-up.

```
segment_id   (string, required)   — A source segment id from a prior recall
query        (string, optional)   — Return the passages most relevant to this query, best first;
                                    omit it to read the source from its start, in source order
max_passages (integer, optional)  — How many passages to return (1-20). Default 3.
```

The passages are followed by a line that says which of the source's passages they are, e.g. `[passages 1-3 of 20 of this source, in source order; pass a query to get the passages most relevant to it, or raise max_passages (at most 20) to read further]`, or `[passages 1-3 of 3: the whole source, ...]` when nothing was left out.

### memory_context

Get a session briefing of relevant memories. Call at the start of each conversation. A briefing does not count as access, so it does not protect the memories it shows from decay.

```
task         (string, optional)   — Brief description of the current task
token_budget (integer, optional)  — Max tokens for briefing. Default 800.
```

### memory_forget

Remove memories by ID, tag, query match, or timestamp. All given criteria must match (ids AND tags AND before AND query), so adding one narrows a deletion.

```
ids     (string[], optional)  — Only these IDs
tags    (string[], optional)  — Only memories with ALL these tags
query   (string, optional)    — Only memories that closely match (cosine distance < 0.35); at most the 10 closest per call
before  (string, optional)    — Only memories created before this ISO 8601 time
confirm (boolean, optional)   — Required to delete by tags, query or before, even with ids; not needed for ids alone or dry_run
dry_run (boolean, optional)   — Preview what would be deleted; no confirm needed. Default false.
```

Capped results (1000 memories, or 10 for a query) are reported as truncated, so run the call again. Before deleting, the server saves a snapshot of the database next to it (`<db>.forget-snapshot-<timestamp>.db`, owner-only, newest 5 kept) and names it in the reply; a snapshot keeps the forgotten data until it ages out. Forgetting an ingested fact also deletes its source passage (other facts from that source keep their text but lose expansion) and removes the forgotten text from superseded histories.

### memory_inspect

View memory statistics or inspect specific memories.

```
view  (string, optional)    — "stats" (default), "recent", "important", "tags", "export"
ids   (string[], optional)  — Inspect specific memories by ID
limit (integer, optional)   — Max items returned. Default 20 (100 for "export").
```

The `export` view returns at most `limit` rows, decayed and compacted memories included; a complete export is a host-side task (`ironcurtain memory <persona> export`, or the package's `./admin` API).

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  MCP Client                      │
│            (Claude, Cursor, etc.)                │
└──────────────┬───────────────────────────────────┘
               │ stdio (JSON-RPC)
┌──────────────▼───────────────────────────────────┐
│  MCP Server (server.ts)                          │
│  Tool handlers: store, ingest, recall, expand,   │
│                 context, forget, inspect         │
└──────────────┬───────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│  Engine (engine-impl.ts)                         │
│  Wires together all subsystems                   │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─────────────┐  ┌──────────────────────────┐   │
│  │  Embedder   │  │   Retrieval Pipeline     │   │
│  │ BGE-base    │  │  Vector KNN + FTS5 BM25  │   │
│  │  (local)    │  │  → Score-based fusion     │   │
│  └─────────────┘  │  → Composite scoring     │   │
│  ┌─────────────┐  │  → Cross-encoder rerank  │   │
│  │  Reranker   │  │  → Dedup by embedding    │   │
│  │ ms-marco    │  │  → Token budget packing  │   │
│  │  (local)    │  │  → Format (answer/       │   │
│  └─────────────┘  │     summary/list/raw)    │   │
│  ┌─────────────┐  └──────────────────────────┘   │
│  │  LLM Client │                                 │
│  │  (optional) │  ┌──────────────────────────┐   │
│  │  Haiku etc. │  │   Maintenance            │   │
│  └─────────────┘  │  Phase 0: Consolidation  │   │
│                   │    (batch LLM dedup)     │   │
│                   │  Phase 1: Vitality decay │   │
│                   │  Phase 2: Compaction     │   │
│                   └──────────────────────────┘   │
├──────────────────────────────────────────────────┤
│  SQLite (WAL mode)                               │
│  ┌────────────┬──────────────┬────────────────┐  │
│  │  memories   │ vec_memories │  memories_fts  │  │
│  │  (rows)     │ (768-dim)   │  (BM25 index)  │  │
│  ├────────────┴──────────────┴────────────────┤  │
│  │  segments (source chunks, OFF the index —   │  │
│  │  never embedded, never in vec/FTS)          │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

The `segments` table holds the raw source chunks that `memory_ingest` decomposes. It is deliberately kept **off the retrieval index** — segments are never embedded and never appear in `vec_memories` or `memories_fts`; they are fetched only by primary key during recall-time parent expansion. Each ingested fact carries a `segment_id` foreign key back to its source ("index fine, return coarse").

### Store path

1. Embed content locally (~5ms)
2. Merge, without an LLM, only the same fact in the same words (a neighbour under cosine distance 0.05 whose normalized text is equal); every other close pair is stored and judged during consolidation. A writer whose memories wait for review never merges (see Writers and review)
3. Insert with `consolidated = false`
4. Every N stores (default 50), run maintenance which includes batch consolidation

`memory_ingest` reuses this store path per extracted fact, with an extra step in front: the raw blob is chunked, each chunk is sent to the LLM for atomic-fact extraction, a chunk's `segments` row is written when the first of its facts is stored, and every fact from that chunk is stored with its `segment_id` set. (`memory_store` never sets `segment_id`, so its rows stay un-parented.) If extraction yields no facts, `on_extraction_failure` decides whether to degrade to a single-blob store, skip, or throw.

### Retrieval pipeline

1. **Candidate generation** — parallel vector KNN (50 candidates) + FTS5 BM25 search (50 candidates, Porter stemming, bigram phrases), live memories only; a `tags` filter applies inside both searches
2. **Score-based fusion** — Weaviate-style relativeScoreFusion: min-max normalize vector similarity and BM25 scores independently to [0,1], then blend with alpha weighting (default 0.5). Candidates from only one source get only that source's weighted contribution
3. _(tags were applied in step 1)_
4. **Composite scoring** — fusion relevance (0.65) + recency (0.15) + importance (0.1) + access patterns (0.1). The fusion score already encodes vector + BM25 magnitudes
5. **Relevance gating** — drop candidates with fusion score < 5% of max
6. **Cross-encoder reranking** — ms-marco-MiniLM-L-6-v2 re-scores candidates; relative gap filter (5 logit points from best)
7. **Deduplication** — remove near-duplicates by embedding cosine similarity
8. **Parent expansion + token budget packing** — for `expand="none"` this is a plain greedy budget pack of the kept facts (skip, not break). For `expand="auto"`/`"parent"` a post-dedup step (NOT part of the candidate ranker — it never touches the candidate set, scores, or selection order) groups the kept facts by `segment_id`, fetches each shared segment by primary key, splits-and-ranks its passages against the query embedding, and reserves budget so the single top source passage is guaranteed; additional passages ride leftover budget up to `max_expand_passages`
9. **Formatting** — `answer` (LLM synthesis), `summary` (LLM briefing), `list` (bullets), or `raw` (JSON)

### Maintenance (amortized, no background processes)

- **Consolidation** — pairs new (unconsolidated) memories with consolidated ones and with close memories of the same batch (memories waiting for review are not paired), and makes one batched LLM call to classify duplicates/contradictions/distinct. The newest fact wins a contradiction; the replaced text is kept in `metadata.superseded` (last 5 entries). Also runs on server startup to handle leftovers from previous sessions.
- **Decay** — samples memories and checks vitality (half-life proportional to importance, boosted by access frequency). Below-threshold memories decay.
- **Compaction** — clusters decayed memories and summarizes them (via LLM, or extractively without one), preserving originals as soft-deleted references. A pass reads at most 200 decayed memories, going on after the ones the previous pass read (and from the oldest again at the end), so decayed memories that never cluster do not keep newer ones from being summarized.
- **Clean-up** — removes vectors of memories that are no longer live and source segments no live fact references.

Maintenance runs under a lock, so two server processes on one database never run it at once.

### Graceful LLM degradation

Every LLM-enhanced feature has an extractive fallback:

| Feature                 | With LLM                             | Without LLM                                |
| ----------------------- | ------------------------------------ | ------------------------------------------ |
| Recall formatting       | Abstractive summary or direct answer | Extractive bullet list                     |
| Dedup on store          | Identical-text merging only          | Same (LLM dedup deferred to consolidation) |
| Consolidation           | Batch LLM judgment                   | Mark all as consolidated                   |
| Compaction              | LLM-generated summaries              | Extractive summaries                       |
| Contradiction detection | LLM classification                   | Identical-text merging only                |

LLM calls are bounded: each has a deadline, and a server process stops calling the LLM after `MEMORY_LLM_MAX_CALLS` calls or `MEMORY_LLM_MAX_TOKENS` tokens (until it restarts), falling back as without an LLM.

## Configuration

All settings are controlled via environment variables:

| Variable                          | Default                                | Description                                                                                                                                |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MEMORY_DB_PATH`                  | `~/.local/share/memory-mcp/default.db` | SQLite database path                                                                                                                       |
| `MEMORY_NAMESPACE`                | `default`                              | Namespace for memory isolation                                                                                                             |
| `MEMORY_EMBEDDING_MODEL`          | `Xenova/bge-base-en-v1.5`              | HuggingFace embedding model (a custom one needs a pin in `MEMORY_MODEL_MANIFEST`; changing it on a database with vectors refuses to start) |
| `MEMORY_EMBEDDING_DTYPE`          | `q8`                                   | Model quantization (q8, fp16, fp32)                                                                                                        |
| `MEMORY_EMBEDDING_DIMENSIONS`     | _(from the model)_                     | Vector size of the embedding model                                                                                                         |
| `MEMORY_MODELS_DIR`               | `$XDG_CACHE_HOME/memory-mcp/models`    | Verified model store (absolute path)                                                                                                       |
| `MEMORY_MODELS_OFFLINE`           | `false`                                | Never download models; a missing model is an error                                                                                         |
| `MEMORY_MODEL_MANIFEST`           | _(built-in pins)_                      | Absolute path to replacement pins: `{"models":[{repo,dtype,revision,files:[{path,sha256,size}]}]}`                                         |
| `MEMORY_RERANKER_ENABLED`         | `true`                                 | Enable cross-encoder reranking                                                                                                             |
| `MEMORY_RERANKER_MODEL`           | `Xenova/ms-marco-MiniLM-L-6-v2`        | HuggingFace reranker model                                                                                                                 |
| `MEMORY_LLM_API_KEY`              | _(none)_                               | API key for LLM (enables enhanced features)                                                                                                |
| `MEMORY_LLM_BASE_URL`             | _(none)_                               | OpenAI-compatible endpoint (must support `/v1/chat/completions`)                                                                           |
| `MEMORY_LLM_MODEL`                | `claude-haiku-4-5-20251001`            | LLM model name                                                                                                                             |
| `MEMORY_LLM_TIMEOUT_MS`           | `60000`                                | Deadline of one LLM call (extraction, maintenance)                                                                                         |
| `MEMORY_LLM_FORMAT_TIMEOUT_MS`    | `20000`                                | Deadline of the recall/briefing formatting call (then extractive)                                                                          |
| `MEMORY_LLM_MAX_CALLS`            | `500`                                  | LLM calls per server process                                                                                                               |
| `MEMORY_LLM_MAX_TOKENS`           | `1000000`                              | LLM tokens per server process                                                                                                              |
| `MEMORY_WRITER_KIND`              | _(none)_                               | Who writes: `interactive`, `cron` or `workflow` (stored as `metadata.writer`)                                                              |
| `MEMORY_SESSION_ID`               | _(none)_                               | The writing session's id (with `MEMORY_WRITER_KIND`)                                                                                       |
| `MEMORY_WRITER_SCOPE`             | `session:<id>`, else the kind          | Review scope of unattended writers (cron, workflow)                                                                                        |
| `MEMORY_DEFAULT_TOKEN_BUDGET`     | `800`                                  | Default token budget for recall                                                                                                            |
| `MEMORY_MAINTENANCE_INTERVAL`     | `50`                                   | Stores between maintenance passes                                                                                                          |
| `MEMORY_DECAY_THRESHOLD`          | `0.05`                                 | Vitality below which memories decay                                                                                                        |
| `MEMORY_COMPACTION_MIN_GROUP`     | `10`                                   | Min decayed memories before compaction                                                                                                     |
| `MEMORY_CONSOLIDATION_BATCH_SIZE` | `50`                                   | Max memories per consolidation pass                                                                                                        |

Invalid values refuse to start.

### Models

The embedding model (BGE-base, about 110 MB at `q8`) and the re-ranker are downloaded from Hugging Face on first use into `MEMORY_MODELS_DIR`. Only pinned revisions and files are downloaded, and every file is checked against its SHA-256 hash when it is installed and before every load. `memory-mcp-server --prefetch-models` downloads (if missing) and verifies them ahead of time, and `--verify-models` checks the installed files; both print a JSON report (exit 0, 1, or 2 for a usage error). With `MEMORY_MODELS_OFFLINE=true` the server never downloads. Maintainers record new pins with `npm run pin-models`; a build whose default pins are still the `UNVERIFIED` placeholders refuses those models (`MODEL_UNPINNED`), so `memory_store` and `memory_recall` fail and re-ranking is skipped.

### Writers and review

When `MEMORY_WRITER_KIND` is set, each memory records who wrote it (`metadata.writer`). Memories written by unattended writers (`cron`, `workflow`) wait for review: interactive sessions do not see them, nor their source passages, until they are approved; later runs of the same job (or later states of the same workflow run) do see them. Pending and reviewed memories never merge, and a pending memory is not merged with anything until it is approved: store-time dedup and consolidation leave it as it was written (a later run of the same scope that stores the same fact again adds a new pending memory), so approving it releases exactly what the review showed. Approval queues it for consolidation against the reviewed memories. IronCurtain reviews them with `ironcurtain memory <persona|job> review` or `show`: both print every releasable field as quoted JSON and an `<id>@<digest>` receipt. Pass the displayed receipts to `ironcurtain memory <persona|job> review approve <id>@<digest>...`. The admin API checks those snapshots under its write transaction, refusing any changed row. Bare ids and `approve --all` are refused so hidden or newly added rows cannot be released.

## Maintenance commands

```bash
memory-mcp-server backups [--db <path>]          # list the copies kept next to the database
memory-mcp-server restore <copy> [--db <path>]   # restore the database from one of them
```

Stop the sessions that use the database first. A restore first saves the current database as `<db>.before-restore-<time>.db`, so it can be undone. For IronCurtain the database is `~/.ironcurtain/personas/<name>/memory.db`.

## Agent Integration

The package exports system prompts and tool descriptions for integrating the memory server with LLM agents:

```typescript
import { MEMORY_SYSTEM_PROMPT } from '@provos/memory-mcp-server/prompts';

// Append to your agent's system prompt
const systemPrompt = basePrompt + '\n\n' + MEMORY_SYSTEM_PROMPT;
```

For custom setups, use the configurable builder:

```typescript
import { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';

const prompt = buildMemorySystemPrompt({
  persona: 'Research Assistant',
  additionalInstructions: 'Always tag paper references with "paper:<title>".',
});
```

The `TOOL_DESCRIPTIONS` export provides enhanced descriptions used in tool registration:

```typescript
import { TOOL_DESCRIPTIONS } from '@provos/memory-mcp-server/prompts';
// TOOL_DESCRIPTIONS.memory_store, .memory_recall, .memory_context, etc.
```

## Development

```bash
npm install
npm run build          # TypeScript compilation
npm test               # Run unit tests
npm run test:e2e       # Run end-to-end tests (spawns real server)
npm run lint           # ESLint
npm run format         # Prettier
npm run benchmark      # Run retrieval quality benchmark
```

## License

Apache-2.0
