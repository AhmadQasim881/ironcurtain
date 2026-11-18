# Design: General-Purpose Memory MCP Server

**Status (2026-11-14):** Implemented (`packages/memory-mcp-server/`); the migration from the per-persona memory.md file is complete, and that file is no longer created. The default model pins are still placeholders, so until they are recorded the server refuses its models and `memory_store` and `memory_recall` fail with `MODEL_UNPINNED` (see Model Provenance and Storage).

**Date:** 2026-03-11
**Supersedes:** [`archive/memory-mcp-server.md`](./archive/memory-mcp-server.md) (original design using `@modelcontextprotocol/server-memory`)
**See also:** `per-persona-memory-optin.md` for the per-persona / per-job opt-in gate that controls whether the memory MCP server is mounted for a given session.

## 1. Problem Statement

LLM agents need persistent memory across sessions. Current approaches — flat markdown files injected into system prompts, or knowledge graph servers with substring-only search — fail at scale. As memories accumulate into the tens of thousands, agents need:

- **Semantic retrieval**: find relevant memories even when query and memory share no keywords
- **Token efficiency**: return compressed, relevant context rather than raw memory dumps
- **Graceful scaling**: retrieval quality and latency should not degrade as memory grows
- **Automatic maintenance**: unused memories should fade without manual curation

### Goals

- Build a **standalone, general-purpose Memory MCP Server** publishable as an independent npm package
- Store potentially hundreds of thousands of memories per namespace
- Return **pre-summarized, token-budget-aware** context blocks (not raw data)
- Run **entirely locally** — no cloud dependencies required (cloud LLM optional for quality)
- **Graceful LLM integration** — cheap LLM (Haiku via OpenAI-compatible API) enables summarization, contradiction detection, and compaction; extractive fallback when unavailable
- Clean MCP tool API that any agent can learn from tool descriptions alone

### Non-Goals (v1)

- Memory type classification (episodic/semantic/procedural) — adds classification errors for marginal value
- Hierarchical summary trees (RAPTOR-style) — incremental tree maintenance is an unsolved engineering problem
- Cross-namespace search
- Multi-modal memories (images, audio)

## 2. Research Summary

### Existing Approaches Evaluated

| System | Approach | Verdict |
|--------|----------|---------|
| `@modelcontextprotocol/server-memory` | Knowledge graph, JSONL, substring search | Simple but no semantic search, no summarization, no forgetting. Full `read_graph` returns everything. |
| Mem0 | Cloud-hosted semantic memory | Cloud dependency violates local-first constraint |
| MemGPT / Letta | Tiered memory with page-in/page-out | Complex OS-inspired model, requires constant LLM calls |
| Zep / Graphiti | Temporal knowledge graph | Graph maintenance burden, requires external services |
| LangMem | Semantic + procedural memory | Tied to LangChain ecosystem |
| Google Always On Memory Agent | LLM-reads-and-writes structured files | Elegant but no semantic search, no scaling strategy |
| SimpleMem (2026 paper) | Semantic compression via LLM | Outperforms Mem0/MemGPT through better compression alone — validates that compression > infrastructure |

### Key Research Findings

1. **SimpleMem outperforms complex systems** through better compression, not better infrastructure. Validates retrieval-time summarization over elaborate storage schemes.

2. **Claude Code's flat markdown + keyword search works for millions of users.** This is the baseline to beat. Any proposal must demonstrably improve on it.

3. **Local embedding models are viable but imperfect.** `all-MiniLM-L6-v2` (384-dim, 23MB quantized) offers the best quality/size tradeoff. Worse than cloud models on short fragments, but sufficient for memory retrieval.

4. **Forgetting is dangerous and usually premature.** At 10-50 memories/day, hitting 100K takes years. Over-engineering forgetting for a problem that won't exist for years is a classic trap.

5. **FTS5 + vector search hybrid** catches what either misses alone. Keyword search finds "ECONNREFUSED" that embeddings miss; embeddings find "credential recovery" when you search "password reset."

6. **Background processes are unreliable in MCP servers.** stdio-transport servers start and stop with their client. Schedulers may never fire. All maintenance must run inline or on explicit trigger.

7. **LLM-assisted compression is the biggest quality lever.** SimpleMem's results show that better compression — not better infrastructure — drives the largest improvements. A cheap LLM call at retrieval time to compress 20 memories into a coherent narrative is worth more than any amount of indexing sophistication.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    MCP Client (Agent)                     │
│                                                          │
│  memory_store  memory_recall  memory_context             │
│  memory_forget  memory_inspect                           │
└─────────────────────┬────────────────────────────────────┘
                      │  MCP Protocol (stdio or SSE)
                      ▼
┌──────────────────────────────────────────────────────────┐
│                  Memory MCP Server                        │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────┐    │
│  │   Tool   │  │ Embedding │  │ Retrieval Pipeline │    │
│  │  Router  │  │  Engine   │  │  (search + score + │    │
│  │          │  │  (ONNX)   │  │   summarize)       │    │
│  └────┬─────┘  └─────┬─────┘  └──────────┬─────────┘    │
│       │              │                    │              │
│       │              │              ┌─────┴──────┐      │
│       │              │              │ LLM Client │      │
│       │              │              │ (OpenAI-   │      │
│       │              │              │ compatible)│      │
│       │              │              └─────┬──────┘      │
│       ▼              ▼                    ▼              │
│  ┌──────────────────────────────────────────────────┐    │
│  │               SQLite Database                     │    │
│  │  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │    │
│  │  │ memories │  │ vec_memories│  │ memories_fts │ │    │
│  │  │ (rows +  │  │ (384-dim   │  │ (FTS5 full-  │ │    │
│  │  │ metadata)│  │  vectors)  │  │  text index) │ │    │
│  │  └──────────┘  └────────────┘  └──────────────┘ │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼ (when LLM configured)
                    ┌───────────────────┐
                    │ OpenAI-Compatible │
                    │ API Endpoint      │
                    │ (Anthropic/Ollama/│
                    │  OpenRouter/etc.) │
                    └───────────────────┘
```

### Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Storage | SQLite via `better-sqlite3` | Battle-tested, single-file, full SQL, WAL mode for concurrent reads |
| Vector search | `sqlite-vec` extension | Loads into SQLite, no separate process, brute-force KNN viable to 500K |
| Full-text search | SQLite FTS5 | Built into SQLite, BM25 ranking, zero additional deps |
| Embeddings | `all-MiniLM-L6-v2` via `@huggingface/transformers` | 384-dim, 23MB quantized, ~10ms/embedding, Apache 2.0 |
| LLM | OpenAI-compatible API, default Haiku | Cheap (~$0.25/M input), fast, good at summarization and classification |
| LLM client | `openai` npm package | De facto standard for OpenAI-compatible APIs; works with Anthropic, Ollama, OpenRouter, vLLM, etc. |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP server SDK |

**Total production dependencies: 6 packages.** The `openai` package adds the LLM client; all LLM features degrade gracefully if no endpoint is configured.

All three independent design proposals converged on the storage stack. SQLite + sqlite-vec + FTS5 + local MiniLM embeddings is the right foundation. The LLM client adds the compression quality that SimpleMem's research shows is the biggest lever.

## 4. LLM Client

The memory server uses a cheap, fast LLM for four operations: **retrieval-time summarization**, **contradiction detection on store**, **smart duplicate resolution**, and **memory compaction**. All four degrade gracefully to non-LLM fallbacks when no endpoint is configured.

### OpenAI-Compatible API

The LLM client uses the `openai` npm package, which is the de facto standard for OpenAI-compatible APIs. This means any provider works: Anthropic (via their OpenAI-compatible endpoint), Ollama, OpenRouter, vLLM, LiteLLM, etc.

```typescript
import OpenAI from 'openai';

let llmClient: OpenAI | null = null;

function getLLMClient(): OpenAI | null {
  if (!config.llmApiKey && !config.llmBaseUrl) return null;

  if (!llmClient) {
    llmClient = new OpenAI({
      apiKey: config.llmApiKey ?? 'not-needed',  // Ollama doesn't need a key
      baseURL: config.llmBaseUrl ?? 'https://api.anthropic.com/v1/',
    });
  }
  return llmClient;
}

async function llmComplete(
  systemPrompt: string,
  userPrompt: string,
  opts?: { maxTokens?: number }
): Promise<string | null> {
  const client = getLLMClient();
  if (!client) return null;  // graceful fallback

  try {
    const response = await client.chat.completions.create({
      model: config.llmModel ?? 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: opts?.maxTokens ?? 300,
      temperature: 0,
    });
    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    // Log error, return null — LLM failure should never break core functionality
    console.error('[memory-server] LLM call failed:', err);
    return null;
  }
}
```

### Where the LLM is Used

| Operation | LLM Role | Fallback Without LLM |
|-----------|----------|---------------------|
| `memory_recall` (summary format) | Abstractive summarization of retrieved memories into coherent narrative | Extractive clustering (lead sentence + related facts) |
| `memory_context` | Abstractive briefing from multiple memory sources | Structured bullet-point list |
| `memory_store` (contradiction check) | Judge whether new memory contradicts existing similar memory | Skip contradiction check; store both |
| `memory_store` (smart dedup) | Judge whether borderline-similar memories (cosine 0.85-0.95) are truly duplicates | Only deduplicate at cosine > 0.95 threshold |
| Compaction (maintenance) | Summarize group of decayed memories into consolidated summary | Extractive compaction (top-N by importance, concatenated) |

### Cost Analysis

Using Haiku ($0.25/M input, $1.25/M output):

| Operation | Input tokens | Output tokens | Cost per call |
|-----------|-------------|---------------|---------------|
| Summarize 20 memories for recall | ~2,000 | ~200 | ~$0.00075 |
| Contradiction check on store | ~200 | ~50 | ~$0.00011 |
| Smart dedup judgment | ~200 | ~30 | ~$0.00009 |
| Compact 20 decayed memories | ~2,000 | ~150 | ~$0.00069 |
| Session briefing (memory_context) | ~3,000 | ~300 | ~$0.00113 |

At 10 recalls/day + 20 stores/day + 1 briefing/day: **~$0.01/day**. Negligible.

## 5. Storage Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  namespace TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  tags TEXT,                    -- JSON array of strings
  importance REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0, higher = resists decay
  created_at INTEGER NOT NULL,           -- Unix timestamp ms
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  is_compacted INTEGER NOT NULL DEFAULT 0,  -- 1 if this is a compacted summary
  compacted_from TEXT,         -- JSON array of memory IDs that were compacted into this
  source TEXT,                 -- optional: what session/context created this
  metadata TEXT                -- JSON blob for extensibility
);

CREATE INDEX idx_memories_namespace ON memories(namespace);
CREATE INDEX idx_memories_created ON memories(namespace, created_at);
CREATE INDEX idx_memories_importance ON memories(namespace, importance DESC);
CREATE INDEX idx_memories_accessed ON memories(namespace, last_accessed_at);

-- Vector index for semantic search
CREATE VIRTUAL TABLE vec_memories USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- Full-text search for keyword matching
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid,
  tokenize='porter unicode61'
);
```

### Storage Path

Configurable via environment variable:

```
MEMORY_DB_PATH=/path/to/memory.db
```

Default: `~/.local/share/memory-mcp/default.db`

Namespace isolation is handled by the `namespace` column within a single database. For stronger isolation (separate personas), run separate server instances with different `MEMORY_DB_PATH` values.

## 5. MCP Tool API

Five tools. Each has a clear, distinct purpose.

### 5.1 `memory_store` — Store a new memory

```typescript
{
  name: "memory_store",
  description: "Store a memory for later retrieval. Memories are automatically embedded for semantic search. Store atomic facts — one idea per memory.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The memory content. Should be a single fact, observation, decision, or preference."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for filtering (e.g., 'preference', 'project:foo', 'person:alice')."
      },
      importance: {
        type: "number",
        minimum: 0, maximum: 1,
        description: "Importance 0-1. Higher values resist decay. Default: 0.5."
      }
    },
    required: ["content"]
  }
}
```

**Behavior:**
1. Compute embedding via local ONNX model
2. Find similar memories (top-5 by cosine similarity)
3. **Exact duplicates** (cosine > 0.95): update existing memory's `updated_at` and merge tags instead of creating duplicate
4. **Borderline similar** (cosine 0.85-0.95): if LLM available, ask it to judge duplicate vs. distinct vs. contradiction (see Section 8). Without LLM, treat as distinct and store both.
5. **Contradiction detected**: if LLM judges new memory contradicts existing one, update the existing memory's content to the new value and log the superseded content in metadata. Return the existing ID with a `contradiction_resolved: true` flag.
6. Insert into `memories`, `vec_memories`, and `memories_fts`
7. Return memory ID (and any dedup/contradiction info)

**Inline maintenance:** On every Nth store (configurable, default N=50), run an amortized maintenance pass: check 100 random memories for decay, compact decayed clusters. No background process needed.

### 5.2 `memory_recall` — Retrieve relevant memories

```typescript
{
  name: "memory_recall",
  description: "Recall memories relevant to a query. Returns a pre-summarized context block optimized for your context window. Uses hybrid semantic + keyword search.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language query describing what you want to remember."
      },
      token_budget: {
        type: "integer",
        description: "Maximum approximate tokens in the response. Default: 500."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Only search memories with ALL of these tags."
      },
      format: {
        type: "string",
        enum: ["summary", "list", "raw"],
        description: "'summary': compressed narrative (default). 'list': bullet points. 'raw': full JSON objects."
      }
    },
    required: ["query"]
  }
}
```

**Retrieval pipeline** (see Section 6 for details):
1. Embed query → vector KNN search (top-K candidates)
2. FTS5 keyword search (additional candidates)
3. Merge and deduplicate candidates (cosine > 0.95 = duplicate)
4. Composite scoring: similarity + recency + importance + access patterns
5. Token-budget selection: greedily pack by score until budget filled
6. Format per requested format
7. Update `last_accessed_at` and `access_count` for returned memories (reinforcement). Only an explicit `memory_recall` counts: a memory shown in a `memory_context` briefing is not counted as accessed (WP-67), so a note that once made the briefing cannot keep itself alive and ranked by being shown at the start of every session.

### 5.3 `memory_context` — Session-start briefing

```typescript
{
  name: "memory_context",
  description: "Get a pre-summarized briefing of relevant memories for starting a new session. Call this at the beginning of each session to recall prior context.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Brief description of the current task or session purpose. Helps retrieve the most relevant memories."
      },
      token_budget: {
        type: "integer",
        description: "Maximum tokens for the briefing. Default: 800."
      }
    }
  }
}
```

**Behavior:**
1. If `task` is provided: run `memory_recall` with task as query (budget: 60% of total)
2. Always include: most recently stored memories (budget: 20% of total)
3. Always include: highest-importance memories (budget: 20% of total)
4. Deduplicate across the three result sets
5. Format as a structured briefing:

```
## Memory Briefing

### Relevant to Current Task
- [2026-03-10] User prefers integration tests over mocks (importance: 0.8)
- [2026-03-09] IronCurtain session resume feature was completed

### Recent
- [2026-03-11] Started investigating Docker agent memory leak

### Key Facts
- User is a security expert building an agent runtime
- Project uses ESM modules with strict TypeScript
```

This is the most impactful single tool — it gives the agent continuity across sessions with one call.

### 5.4 `memory_forget` — Remove memories

```typescript
{
  name: "memory_forget",
  description: "Forget specific memories by ID, tag, or query match.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Specific memory IDs to forget."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Forget all memories with ALL of these tags."
      },
      query: {
        type: "string",
        description: "Forget memories matching this query (top-10 matches, requires confirm=true)."
      },
      before: {
        type: "string",
        description: "Forget memories created before this ISO 8601 timestamp."
      },
      confirm: {
        type: "boolean",
        description: "Must be true for query-based or bulk deletion. Default: false."
      },
      dry_run: {
        type: "boolean",
        description: "If true, return what would be forgotten without actually deleting. Default: false."
      }
    }
  }
}
```

`dry_run` mode lets the agent preview deletions before committing — a safety mechanism against irreversible data loss.

**Selection semantics (as implemented).** The criteria are an **intersection**: a memory is forgotten only when it matches every criterion supplied (`ids` AND `tags` AND `before` AND `query`), so adding a criterion only ever narrows a deletion. Empty arrays count as not supplied, and a call with no effective criterion is refused rather than selecting the whole namespace.

- `tags` — the memory has all of the listed tags.
- `before` — the memory was created strictly before the timestamp.
- `query` — the memory lies within cosine distance 0.35 of the (query-prefixed) query embedding (with the default BGE model, memories that state what the query names measure about 0.18–0.36 and unrelated ones 0.39 and up). Of the memories that match every criterion, at most the 10 closest are forgotten per call; weak matches are never forgotten. The distance cut-off and the other criteria are applied in one exact selection, so a tagged match is found even behind many closer untagged memories. The match is topical rather than exact ("the user lives in Lisbon" also matches "The user lives in Berlin", 0.25), which is why `dry_run` comes first.
- A selection is capped (10 for a query, 1000 otherwise); the reply then says it was truncated, which means more memories match, and the caller runs the call again.

**Confirmation.** `dry_run: true` deletes nothing and never needs `confirm`. Deleting by any bulk criterion (`tags`, `query` or `before`) needs `confirm: true`, even when `ids` are also given; deleting by `ids` alone does not. The tool handler answers an unconfirmed bulk call with guidance, and the engine refuses it as well.

**Deletion.** Rows, their vectors and their FTS entries are deleted in one transaction. vec0 accepts only one `IN (...)` constraint on its key column per statement, so the vector delete scopes the ids through a single subquery (`memory_id IN (SELECT id FROM memories WHERE namespace = ? AND id IN (...))`).

**Forgetting removes the text, not just the row (WP-93).** In the same transaction (`forgetMemoryRows`), the source segments a forgotten `memory_ingest` fact was extracted from are deleted, even when other facts of those sources still reference them: a segment is the raw chunk, the forgotten fact's text included, and that text cannot be cut out of it (facts are paraphrases, not spans). A memory links to one segment (`segment_id`), but the same fact can come from several chunks (an edited document ingested again, or two documents stating it) and be merged into one memory; every merge (the store-time merge of an ingested fact and consolidation's merges) records the other chunks in the survivor's `metadata.source_segments`, and they are deleted with it. Their other facts are unlinked and keep their own text; they lose only the source context (`memory_expand` reports the segment as not found and recall no longer expands it). A compaction summary holds the text of the memories it replaced: forgetting the summary deletes them, and forgetting one of them deletes the summary (its other memories are released, still decayed, for the next compaction pass to summarize again). Entries holding a forgotten memory's text (compared as store-time dedup compares texts) are also removed from other memories' superseded histories. Before, a forgotten fact's source stayed on disk and a default recall returned it through the fact's siblings.

### 5.5 `memory_inspect` — View stats and memories

```typescript
{
  name: "memory_inspect",
  description: "View memory statistics or inspect specific memories.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        enum: ["stats", "recent", "important", "tags"],
        description: "'stats': namespace statistics. 'recent': last N stored. 'important': highest importance. 'tags': tag frequency."
      },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Inspect specific memories by ID."
      },
      limit: {
        type: "integer",
        description: "Max items for recent/important/tags views. Default: 20."
      }
    }
  }
}
```

## 6. Retrieval Pipeline

The retrieval pipeline is the core differentiator. Instead of returning raw memories, the server pre-processes results into compact, token-budget-aware context blocks.

### Stage 1: Candidate Generation (Hybrid Search)

Run two searches in parallel and merge results:

```typescript
function getCandidates(query: string, queryEmbedding: Float32Array, tags?: string[]): Memory[] {
  // Vector search: top-K by cosine similarity
  const vectorResults = db.prepare(`
    SELECT m.*, vec_distance_cosine(v.embedding, ?) as distance
    FROM vec_memories v
    JOIN memories m ON m.id = v.memory_id
    WHERE m.namespace = ?
    ORDER BY distance ASC
    LIMIT ?
  `).all(queryEmbedding, namespace, K);

  // FTS5 search: BM25-ranked keyword matches
  const ftsResults = db.prepare(`
    SELECT m.*, rank as bm25_score
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ? AND m.namespace = ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery(query), namespace, K);

  // Merge with Reciprocal Rank Fusion (RRF)
  return reciprocalRankFusion(vectorResults, ftsResults);
}
```

**Reciprocal Rank Fusion (RRF)** is a simple, effective method to merge ranked lists from different retrieval systems without needing to normalize scores:

```typescript
function reciprocalRankFusion(
  vectorResults: Memory[],
  ftsResults: Memory[],
  k: number = 60
): ScoredMemory[] {
  const scores = new Map<string, number>();

  vectorResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });
  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });

  // Sort by combined RRF score
  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id, score]) => ({ ...memoriesById.get(id)!, rrfScore: score }));
}
```

> **As implemented (WP-93): candidate generation** (`vectorSearch` and `ftsSearch` in `storage/queries.ts`).
>
> - **Live memories only.** Both channels return only memories with `importance > 0 AND is_compacted = 0`. A decayed memory (importance 0) or a compacted original stays in the table for compaction and `memory_inspect`, but never reaches recall, store-time dedup, consolidation's pairing or source expansion. Before, decayed memories still came back through keyword search, and compacted originals that kept a vector came back through both channels. Because importance 0 now means "decayed" and nothing else, the write path stores an agent's importance 0 as 0.01 (`MIN_STORED_IMPORTANCE`).
> - **KNN, not a full scan.** The vector channel (and store-time dedup, and consolidation's pairing) uses a sqlite-vec KNN query (`embedding MATCH ? AND k = ?`) instead of computing `vec_distance_cosine` for every row through a join and sorting: at 50,000 memories about 25–45 ms instead of 0.3–0.6 s per query. vec0 measures L2 distance; the stored embeddings are L2-normalized, so the L2 order is the cosine order and the cosine distance is L2²/2, and the callers' thresholds keep their meaning. There is no schema change.
> - **Exact despite the filter.** `vec_memories` holds every namespace's vectors and nothing else, so the KNN picks its k neighbours before the namespace and liveness (or, for consolidation, `consolidated = 1`) conditions apply. When fewer than the requested number pass, the query is repeated with a four times larger k until enough pass or every vector has been returned; past sqlite-vec's limit of k = 4096 it falls back to the exact scan. A matching memory outside the k nearest vectors is farther than all of them, so the result equals filter-then-limit.
> - **Tag scope inside the search.** `memory_recall`'s `tags` are applied inside both channels, before their limits, with one `json_each` condition per tag (a JSON array's string elements, as `parseTags` reads them). The vector channel then scans exactly the tagged memories (`vec_distance_cosine` over that subset). Before, `tags` filtered the top 50 candidates of each channel afterwards, so a tagged memory behind 50 closer untagged ones was never found.
> - Maintenance keeps the KNN index to live memories: decay and compaction remove a memory's vector, and each maintenance pass removes any vector a non-live memory still has (rows written before this change).

> **As implemented (WP-130): the keyword query in any script** (`sanitizeFtsQuery` in `storage/queries.ts`). The query is NFKC-normalized; letters of every script, combining marks, digits and `_` make up its words, and everything else separates them. Each word, and each pair of neighbouring words as a phrase, is quoted, so no word is read as an FTS5 operator. Before, an ASCII-only `\w` filter turned 'café' into 'caf', 'Zürich' into 'Z' OR 'rich' (which matched an unrelated note) and '東京' into nothing, so names and places outside English lost the keyword channel and fell back to the English-only embedding model. The `porter unicode61` tokenizer is unchanged (changing its options would mean rebuilding the index): it folds case and diacritics in the index and in the query alike, so 'café' and 'cafe' find each other. It does not fold compatibility forms, so a word NFKC changes (full-width letters and digits, ligatures) is searched as typed too. It splits text only at separators, so CJK text written without spaces is one token per run; finding a word inside such a run needs a trigram index (not done).

### Stage 2: Composite Scoring

After RRF merge, apply domain-specific scoring:

```typescript
function scoreMemory(memory: ScoredMemory, now: number): number {
  const ageHours = (now - memory.created_at) / 3600000;
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;

  // Recency: exponential decay with 30-day half-life
  const recencyScore = Math.exp(-0.001 * ageHours);

  // Access pattern: recently/frequently accessed memories are boosted
  const accessScore = Math.exp(-0.002 * accessAgeHours)
    * Math.min(memory.access_count / 10, 1.0);

  // Combine RRF relevance with metadata signals
  return (
    0.55 * memory.rrfScore +
    0.20 * recencyScore +
    0.10 * memory.importance +
    0.15 * accessScore
  );
}
```

Note: these weights are initial defaults, not empirically derived. They should be configurable and tuned with real usage data.

### Stage 3: Deduplication

Remove near-duplicate memories before formatting:

```typescript
function deduplicate(memories: ScoredMemory[]): ScoredMemory[] {
  const kept: ScoredMemory[] = [];
  for (const mem of memories) {
    const isDuplicate = kept.some(
      k => cosineSimilarity(k.embedding, mem.embedding) > 0.95
    );
    if (!isDuplicate) {
      kept.push(mem);
    }
  }
  return kept;
}
```

### Stage 4: Token Budget Packing

Greedily select memories by score until the budget is filled:

```typescript
function packToBudget(ranked: ScoredMemory[], budget: number): ScoredMemory[] {
  const selected: ScoredMemory[] = [];
  let usedTokens = 0;

  for (const mem of ranked) {
    const tokens = estimateTokens(mem.content); // ~4 chars per token heuristic
    if (usedTokens + tokens > budget) continue; // skip, try smaller memories
    selected.push(mem);
    usedTokens += tokens;
  }

  return selected;
}
```

Note: we use `continue` (skip) rather than `break` so that smaller memories further down the ranked list can still fill remaining budget.

### Stage 5: Formatting

**`summary` format (default):** Two strategies, chosen based on LLM availability:

**With LLM (abstractive summarization):** Pass all selected memories to the LLM with a compression prompt. This produces a coherent narrative that captures the key facts, resolves redundancies, and fits within the token budget. This is the single biggest quality improvement over extractive approaches — validated by SimpleMem's research showing compression quality is the dominant factor.

```typescript
async function formatAsSummaryWithLLM(
  memories: ScoredMemory[],
  query: string,
  tokenBudget: number,
): Promise<string> {
  const memoriesText = memories
    .map((m, i) => `[${i + 1}] (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  const result = await llmComplete(
    `You are a memory compression assistant. Summarize the following memories into a concise, ` +
    `information-dense response relevant to the query. Preserve specific details (names, dates, ` +
    `numbers, exact preferences). Do not add information not present in the memories. ` +
    `Target approximately ${tokenBudget} tokens.`,
    `Query: ${query}\n\nMemories:\n${memoriesText}`,
    { maxTokens: tokenBudget },
  );

  // Fall back to extractive if LLM fails
  return result ?? formatAsSummaryExtractive(memories);
}
```

**Without LLM (extractive fallback):** Cluster selected memories by embedding proximity, then format each cluster as a paragraph with the most relevant memory as the lead sentence:

```typescript
function formatAsSummaryExtractive(memories: ScoredMemory[]): string {
  const clusters = clusterByEmbeddingSimilarity(memories, threshold: 0.80);

  return clusters.map(cluster => {
    if (cluster.length === 1) return cluster[0].content;
    const lead = cluster[0].content;
    const extras = cluster.slice(1)
      .map(m => m.content)
      .filter(c => !lead.includes(c));
    return extras.length > 0
      ? `${lead} (Related: ${extras.join('; ')})`
      : lead;
  }).join('\n\n');
}
```

**`list` format:** One bullet per memory, most relevant first, with date and importance (no LLM needed):
```
- [2026-03-10] User prefers dark mode in all applications (importance: 0.8)
- [2026-03-08] Project deadline moved to March 20th (importance: 0.9)
(+12 more memories available)
```

**`raw` format:** JSON array of full memory objects for programmatic use.

## 7. Duplicate Detection and Contradiction Resolution on Store

> **As implemented.** The store path never calls the LLM, and the original three-tier design below was replaced by a store-time merge plus a deferred, batched consolidation pass (`storage/consolidation.ts`):
>
> - **Store time.** A new memory is merged into an existing one only when both state the same fact in the same words: a neighbour within cosine distance 0.05 whose normalized text (Unicode NFC, case-folded, whitespace collapsed, trailing full stops and exclamation marks dropped; word order and all other characters kept) equals the new text. NFC rather than NFKC: compatibility folding changes meaning (NFKC turns "10⁶" into "106", and two long sentences differing only there measure 0.046). The stored text and vector are kept; tags are unioned, importance takes the maximum, a missing source is filled in, and `as_of` timestamps and the ingest segment are reconciled. Embedding distance alone is not enough: with the default model, "The production database password rotates every 30 days" vs the same sentence about staging (0.0498) and "prefers TypeScript over Python" vs its reverse (0.0095) measure under 0.05. Every other pair is stored as a new, unconsolidated memory.
> - **Consolidation.** Each unconsolidated memory is paired with its five nearest **consolidated** memories (filtered in SQL before the limit, so the batch itself cannot crowd an older fact out) within distance 0.3, and with close memories of the same batch. Near-identical pairs are judged too. The LLM's judgments are applied in pair order (a pair answered inconsistently counts as distinct). A survivor map records which row absorbed each deleted row, so a pair whose existing row was already merged away is applied to the row it now lives in; pairs whose new row is gone, or whose sides resolve to one row, are skipped, and both rows are re-read before each change; a pair is skipped unless both rows are still live and still hold the texts that were judged (or, for a survivor, the text this pass last wrote), so a row another writer changed while the LLM was judging is left alone. Because every pair was judged against the existing text as it was before any change, a judgment is applied only while the survivor still states that fact (the row itself, or a row that absorbed it as a duplicate): after a correction replaced a survivor's text, older judgments about that text are skipped rather than, for example, deleting a "duplicate" of a text that is gone. A duplicate keeps the survivor's text and merges tags, source, segment, importance and timestamps into it. A contradiction keeps the newest fact: when the new row is at least as recent as the fact the survivor states, its text, vector, source, segment and first-seen time (`created_at`) replace the survivor's, so a later pass still knows how recent the current text is; when it is older (for example backdated with `as_of`), the survivor keeps its text. Either way the losing text is appended to `metadata.superseded`, a chronological array of at most five `{content, at}` entries, and tags are unioned. Only changes actually written are counted.
>
> The rest of this section is the original design and is kept for context.

When storing a new memory, the server performs a three-tier similarity check to prevent duplicates and resolve contradictions:

```typescript
async function storeMemory(content: string, opts: StoreOptions): Promise<StoreResult> {
  const embedding = await embed(content);

  // Find similar memories
  const similar = db.prepare(`
    SELECT m.id, m.content, m.tags, m.importance,
           vec_distance_cosine(v.embedding, ?) as distance
    FROM vec_memories v
    JOIN memories m ON m.id = v.memory_id
    WHERE m.namespace = ?
    ORDER BY distance ASC
    LIMIT 5
  `).all(embedding, namespace);

  // Tier 1: Exact duplicates (cosine > 0.95) — merge without LLM
  const exactDup = similar.find(s => (1 - s.distance) > 0.95);
  if (exactDup) {
    const mergedTags = mergeTags(JSON.parse(exactDup.tags ?? '[]'), opts.tags ?? []);
    db.prepare(`
      UPDATE memories
      SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
      WHERE id = ?
    `).run(Date.now(), JSON.stringify(mergedTags), opts.importance ?? 0.5, exactDup.id);
    return { id: exactDup.id, action: 'merged_duplicate' };
  }

  // Tier 2: Borderline similar (cosine 0.85-0.95) — use LLM to judge
  const borderline = similar.filter(s => {
    const sim = 1 - s.distance;
    return sim > 0.85 && sim <= 0.95;
  });

  if (borderline.length > 0) {
    const judgment = await judgeWithLLM(content, borderline[0]);

    if (judgment === 'duplicate') {
      const mergedTags = mergeTags(JSON.parse(borderline[0].tags ?? '[]'), opts.tags ?? []);
      db.prepare(`
        UPDATE memories
        SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
        WHERE id = ?
      `).run(Date.now(), JSON.stringify(mergedTags), opts.importance ?? 0.5, borderline[0].id);
      return { id: borderline[0].id, action: 'merged_duplicate' };
    }

    if (judgment === 'contradiction') {
      // New memory supersedes old — update content, archive old in metadata
      const oldContent = borderline[0].content;
      db.prepare(`
        UPDATE memories
        SET content = ?, updated_at = ?,
            importance = MAX(importance, ?),
            metadata = json_set(COALESCE(metadata, '{}'), '$.superseded', ?)
        WHERE id = ?
      `).run(content, Date.now(), opts.importance ?? 0.5,
             JSON.stringify({ content: oldContent, at: Date.now() }),
             borderline[0].id);

      // Update the embedding to match the new content
      db.prepare(`UPDATE vec_memories SET embedding = ? WHERE memory_id = ?`)
        .run(embedding, borderline[0].id);

      return { id: borderline[0].id, action: 'contradiction_resolved' };
    }
    // judgment === 'distinct' — fall through to insert
  }

  // Tier 3: No match — insert new memory
  const id = generateId();
  // ... insert into memories, vec_memories, memories_fts ...
  return { id, action: 'created' };
}
```

### LLM Judgment for Borderline Cases

```typescript
async function judgeWithLLM(
  newContent: string,
  existing: { content: string },
): Promise<'duplicate' | 'contradiction' | 'distinct'> {
  const result = await llmComplete(
    `You judge whether two memories are duplicates, contradictions, or distinct facts.\n` +
    `Reply with exactly one word: "duplicate", "contradiction", or "distinct".\n` +
    `- "duplicate": they express the same fact, possibly worded differently\n` +
    `- "contradiction": they express conflicting facts about the same topic (the new one supersedes the old)\n` +
    `- "distinct": they are about different topics or complementary facts`,
    `Existing memory: ${existing.content}\nNew memory: ${newContent}`,
    { maxTokens: 10 },
  );

  const normalized = result?.trim().toLowerCase();
  if (normalized === 'duplicate' || normalized === 'contradiction') return normalized;
  return 'distinct'; // default to storing both if LLM unavailable or response unclear
}
```

When no LLM is configured, `judgeWithLLM` returns `'distinct'` (via the `llmComplete` → `null` path), and the server falls back to the cosine > 0.95 threshold only. This is safe: the worst case is some redundancy, which deduplication at retrieval time handles.

## 8. Decay and Maintenance

### Design Principle: No Background Processes

MCP servers (especially stdio-transport) start and stop with their client. Background schedulers are unreliable. All maintenance runs **inline**, amortized across regular operations.

### Amortized Maintenance

On every Nth `memory_store` call (default N=50), the server runs a maintenance pass with two phases: **decay** and **compaction**.

```typescript
let storeCounter = 0;

async function maybeRunMaintenance(): Promise<void> {
  storeCounter++;
  if (storeCounter < MAINTENANCE_INTERVAL) return;
  storeCounter = 0;

  const now = Date.now();

  // Phase 1: Decay — sample random memories and check vitality
  const sample = db.prepare(`
    SELECT id, content, importance, created_at, last_accessed_at, access_count
    FROM memories
    WHERE namespace = ? AND importance > 0
    ORDER BY RANDOM()
    LIMIT 100
  `).all(namespace);

  const decayed: MemoryRow[] = [];
  for (const mem of sample) {
    const vitality = computeVitality(mem, now);
    if (vitality < DECAY_THRESHOLD) {
      decayed.push(mem);
      // Remove from vector index (no longer retrieved) but keep the row
      db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(mem.id);
      db.prepare(`UPDATE memories SET importance = 0 WHERE id = ?`).run(mem.id);
    }
  }

  // Phase 2: Compaction — consolidate decayed memories into summaries
  await maybeCompact();
}
```

### Compaction: "Forget Leaves, Keep Summaries"

Inspired by the hierarchical proposal's best idea: when individual memories decay, their information is preserved in a consolidated summary. This mirrors human memory — specific details fade, but the understanding persists.

Compaction runs during maintenance when enough decayed memories have accumulated:

```typescript
async function maybeCompact(): Promise<void> {
  // Find decayed memories that haven't been compacted yet
  const decayedMemories = db.prepare(`
    SELECT id, content, tags, created_at
    FROM memories
    WHERE namespace = ? AND importance = 0 AND is_compacted = 0
    ORDER BY created_at ASC
    LIMIT 200
  `).all(namespace);

  if (decayedMemories.length < COMPACTION_MIN_GROUP) return; // default: 10

  // Cluster decayed memories by embedding similarity
  const clusters = clusterByEmbeddingSimilarity(decayedMemories, threshold: 0.70);

  for (const cluster of clusters) {
    if (cluster.length < 3) continue; // too small to compact

    const summary = await compactCluster(cluster);
    if (!summary) continue; // LLM failed, skip this cluster

    // Create compacted summary memory
    const summaryEmbedding = await embed(summary);
    const summaryId = generateId();
    const clusterIds = cluster.map(m => m.id);
    const mergedTags = [...new Set(cluster.flatMap(m => JSON.parse(m.tags ?? '[]')))];

    db.prepare(`
      INSERT INTO memories (id, namespace, content, tags, importance, created_at,
        updated_at, last_accessed_at, is_compacted, compacted_from, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'compaction')
    `).run(summaryId, namespace, summary, JSON.stringify(mergedTags),
           0.6, // compacted summaries start at moderate importance
           Date.now(), Date.now(), Date.now(),
           JSON.stringify(clusterIds));

    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`)
      .run(summaryId, summaryEmbedding);

    // Mark source memories as compacted (soft-delete)
    for (const mem of cluster) {
      db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = ?`).run(mem.id);
    }
  }
}

async function compactCluster(memories: MemoryRow[]): Promise<string | null> {
  const memoriesText = memories
    .map(m => `- (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  // Try LLM-based abstractive compaction first
  const llmSummary = await llmComplete(
    `You are a memory compaction assistant. Consolidate the following related memories ` +
    `into a single concise summary that preserves all key facts, specific details ` +
    `(names, dates, numbers), and actionable information. The summary should be ` +
    `self-contained and useful without access to the original memories.`,
    `Memories to consolidate:\n${memoriesText}`,
    { maxTokens: 200 },
  );

  if (llmSummary) return llmSummary;

  // Extractive fallback: take the top-3 most representative memories
  return extractiveCompact(memories);
}

function extractiveCompact(memories: MemoryRow[]): string {
  const sorted = memories.sort((a, b) =>
    (b.access_count ?? 0) - (a.access_count ?? 0)
  );
  const dateRange = `${new Date(Math.min(...memories.map(m => m.created_at))).toISOString().slice(0, 10)}` +
    ` to ${new Date(Math.max(...memories.map(m => m.created_at))).toISOString().slice(0, 10)}`;

  return `[Consolidated ${memories.length} memories, ${dateRange}] ` +
    sorted.slice(0, 3).map(m => m.content).join('. ');
}
```

The key property: **information is never truly lost at compaction time.** The decayed source memories remain in the database (with `is_compacted = 1`) but are excluded from vector search. The compacted summary takes their place in retrieval. If the original details are ever needed, they can be recovered via `memory_inspect` with specific IDs (stored in `compacted_from`).

> **As implemented (WP-93).** The design above could never compact anything: decay deleted the vectors that compaction then clustered on, so every decayed memory formed a cluster of one and was skipped. Decay still removes the vector (the KNN index holds live memories only), and `runCompaction` embeds the decayed texts itself (at most 200 per pass; an in-process cache, keyed by a hash of the model, its precision and the text, keeps later passes from embedding again the decayed memories that joined no cluster). **(FU-05)** The 200 are not always the oldest: each pass reads the 200 after the position where the previous pass of the namespace stopped (a `(created_at, id)` cursor in `schema_meta`, `compaction_cursor:<namespace>`), and goes on from the oldest when fewer remain. Reading only the oldest 200 stalled compaction for good once they were memories that never cluster (they stay decayed and uncompacted), and newer decayed memories, which recall no longer returns, were never summarized. A cluster's summary is inserted and the cluster marked compacted in one transaction, and only while every memory of the cluster is unchanged (still there, still decayed and not compacted, same text): a memory forgotten while the LLM wrote the summary must not live on in it, and an overlapping maintenance pass must not summarize the cluster twice. Compacted originals lose any vector they still had and are excluded from keyword search as well (see Stage 1). After compaction, each maintenance pass removes the vectors of memories that are not live and deletes the `memory_ingest` source segments that no live memory references any more (their facts were merged away, decayed or compacted), unlinking decayed and compacted memories from them first. Forgetting keeps a summary and its originals together (§5.4 Deletion): forgetting the summary deletes the originals it lists in `compacted_from`, and forgetting an original deletes its summary and releases the summary's other originals (`is_compacted = 0`, still decayed), so the next pass summarizes them again without the forgotten text.

### Vitality Computation

```typescript
function computeVitality(memory: MemoryRow, now: number): number {
  const ageHours = (now - memory.created_at) / 3600000;

  // Half-life proportional to importance: high importance = slower decay
  // importance=1.0 → 180-day half-life, importance=0.1 → 18-day half-life
  const halfLifeHours = memory.importance * 180 * 24;
  const baseDecay = Math.pow(0.5, ageHours / halfLifeHours);

  // Access reinforcement: each access extends effective lifetime
  const reinforcement = Math.min(memory.access_count * 0.03, 0.4);

  // Recency of last access
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;
  const accessRecency = Math.exp(-accessAgeHours / (60 * 24)); // 60-day characteristic time

  return Math.min(1.0, baseDecay + reinforcement * accessRecency);
}
```

As implemented, both ages are clamped at zero (`Math.max(0, now - …)`), here and in the recall composite score: a future timestamp (clock skew, or a row stored before `as_of` was bounded to at most five minutes ahead) counts as "now" rather than as a negative age that would never decay and would outrank every current memory.

### Explicit Maintenance via `memory_inspect`

The `memory_inspect` tool with `view: "stats"` also triggers a full maintenance pass, giving users a manual trigger:

```json
{
  "total_memories": 12847,
  "active_memories": 10432,
  "decayed_memories": 2415,
  "oldest_memory": "2025-06-15T10:30:00Z",
  "newest_memory": "2026-03-11T14:22:00Z",
  "storage_bytes": 48230400,
  "top_tags": [
    { "tag": "preference", "count": 342 },
    { "tag": "project:ironcurtain", "count": 1205 }
  ]
}
```

## 9. Embedding Strategy

### Model: `all-MiniLM-L6-v2`

| Property | Value |
|----------|-------|
| Dimensions | 384 |
| Size (ONNX, q8) | ~23 MB |
| Inference | ~5-15ms per embedding |
| Max input tokens | 256 |
| License | Apache 2.0 |

```typescript
import { pipeline } from '@huggingface/transformers';

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
    });
  }
  return embedder;
}

async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}
```

### Model Provenance and Storage

The snippet above is the original design. The server now loads its models (the embedding model, `Xenova/bge-base-en-v1.5`, and the re-ranking cross-encoder, `Xenova/ms-marco-MiniLM-L-6-v2`, both `q8`) only through a verified model store (`src/models/`):

- **Pins.** `PINNED_MODELS` (`src/models/manifest.ts`) names, for each model and dtype, a full 40-character commit SHA of its Hugging Face repository and the SHA-256 and size of every file the server reads (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`). A model or dtype without a complete pin is never downloaded or loaded (`MODEL_UNPINNED`). Until the pins are recorded (`scripts/pin-models.ts`, which needs network access) the entries carry the placeholder `UNVERIFIED`, which fails safe. `MEMORY_MODEL_MANIFEST` (an absolute path to `{ "models": [ ... ] }`) adds or replaces pins per model, for standalone users who pin another model.
- **Store.** Files live in `<modelsDir>/<owner>/<name>/<revision>/<path>`, outside `node_modules`: `MEMORY_MODELS_DIR` (IronCurtain passes `~/.ironcurtain/models`), else `$XDG_CACHE_HOME/memory-mcp/models`. A download streams from `https://huggingface.co/<repo>/resolve/<revision>/<path>` into a temporary file, is capped at the pinned size, aborted when it stalls, hashed as it streams and renamed into place (read-only) only when size and SHA-256 match.
- **Every load.** Before transformers.js (and its native ONNX runtime) is imported, each pinned file is checked again: a regular file (not a symlink) inside the store, of the pinned size and SHA-256. A mismatch is refused (`MODEL_INTEGRITY`) and not replaced silently; `--prefetch-models` is the explicit repair. transformers.js then loads the verified directory by path with remote loading off, its file cache off, its cache and local-model paths pointed at the store and a fetch that refuses every request (`src/models/transformers-env.ts`).
- **Offline.** `MEMORY_MODELS_OFFLINE=true` (IronCurtain: `memory.offlineModels`) forbids downloads; a missing model is `MODEL_NOT_CACHED`, with an error that says how to prefetch. `memory-mcp-server --prefetch-models` downloads and verifies the configured models (ignoring the offline flag) and `--verify-models` checks them without network access; both print a JSON report (IronCurtain: `ironcurtain memory prefetch`, and the Memory section of `ironcurtain doctor`).

### Embedding Model Upgrade Path

Embeddings are tied to the model that produced them. If the model changes, existing vectors become incompatible. The schema stores the model identifier:

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Stores: embedding_model, embedding_dimensions, schema_version
```

On startup, if the configured model differs from the stored model, the server logs a warning. A `memory_inspect` operation with `view: "stats"` reports the mismatch. Re-embedding can be triggered via an explicit management operation (deferred to v2).

> **As implemented (WP-94):** a warning was not enough (a model of another size broke every insert, one of the same size silently mixed vector spaces), so the server now refuses to open a database whose stored vectors come from another model or have another size (`initDatabase` in `storage/database.ts`; two names of one model, such as `Xenova/` and `BAAI/bge-base-en-v1.5`, count as the same). A database without vectors is switched to the configured model. The vector index is sized from the model (`embedding/models.ts`, or `MEMORY_EMBEDDING_DIMENSIONS`), and the embedder rejects vectors of another size. Re-embedding is still not implemented.

### Scalability

| Memory count | Vector search (384-dim, brute-force) | Total DB size estimate |
|-------------|--------------------------------------|----------------------|
| 1,000 | <5ms | ~3 MB |
| 10,000 | <15ms | ~25 MB |
| 50,000 | ~30ms | ~120 MB |
| 100,000 | ~50ms | ~250 MB |

At realistic accumulation rates (10-50 memories/day), reaching 100K takes 5-25 years. Brute-force vector search is viable for the foreseeable future. If needed, sqlite-vec supports binary quantization for 32x storage reduction and ~10x search speedup.

As implemented (WP-93), with the shipped 768-dimension model a brute-force vec0 KNN query takes about 25–45 ms at 50,000 memories (it reads every vector, about 150 MB); the join-and-sort scan it replaced took 0.3–0.6 s. Store-time dedup, recall and consolidation's pairing each run one per memory or query.

## 10. Configuration

All configuration via environment variables (MCP convention):

| Variable | Default | Description |
|----------|---------|-------------|
| **Storage** | | |
| `MEMORY_DB_PATH` | `~/.local/share/memory-mcp/default.db` | SQLite database path |
| `MEMORY_NAMESPACE` | `default` | Default namespace |
| **Embeddings** | | |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID |
| `MEMORY_EMBEDDING_DTYPE` | `q8` | Quantization level |
| **Model store** (§9, Model Provenance and Storage) | | |
| `MEMORY_MODELS_DIR` | `$XDG_CACHE_HOME/memory-mcp/models` | Absolute directory of the verified model files |
| `MEMORY_MODELS_OFFLINE` | `false` | Never download models; a missing model is an error |
| `MEMORY_MODEL_MANIFEST` | (none) | Absolute path of a manifest that adds or replaces model pins |
| **LLM** | | |
| `MEMORY_LLM_BASE_URL` | `https://api.anthropic.com/v1/` | OpenAI-compatible API endpoint |
| `MEMORY_LLM_API_KEY` | (none) | API key for the LLM endpoint |
| `MEMORY_LLM_MODEL` | `claude-haiku-4-5-20251001` | Model name for LLM calls |
| **Maintenance** | | |
| `MEMORY_DECAY_THRESHOLD` | `0.05` | Vitality below which memories are decayed |
| `MEMORY_MAINTENANCE_INTERVAL` | `50` | Store operations between maintenance passes |
| `MEMORY_COMPACTION_MIN_GROUP` | `10` | Minimum decayed memories before compaction triggers |
| **Retrieval** | | |
| `MEMORY_DEFAULT_TOKEN_BUDGET` | `500` | Default token budget for recall |

When `MEMORY_LLM_API_KEY` is not set, all LLM features are disabled and the server uses extractive fallbacks. This is the only configuration needed to go from "basic" to "enhanced" mode.

### MCP Client Configuration Examples

**With Anthropic (recommended default):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db",
        "MEMORY_LLM_API_KEY": "${ANTHROPIC_API_KEY}",
        "MEMORY_LLM_BASE_URL": "https://api.anthropic.com/v1/"
      }
    }
  }
}
```

**With Ollama (fully local):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db",
        "MEMORY_LLM_BASE_URL": "http://localhost:11434/v1",
        "MEMORY_LLM_MODEL": "llama3.2:3b"
      }
    }
  }
}
```

**Without LLM (extractive only):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db"
      }
    }
  }
}
```

## 11. Integration with IronCurtain

### Dynamic Injection in `buildSessionConfig()`

```typescript
if (config.userConfig.memory?.enabled !== false) {
  const dbPath = resolveMemoryDbPath({
    persona: opts.persona,
    jobId: opts.jobId,
  });

  mkdirSync(dirname(dbPath), { recursive: true });

  const memoryEnv: Record<string, string> = {
    MEMORY_DB_PATH: dbPath,
    MEMORY_NAMESPACE: opts.persona ?? opts.jobId ?? 'default',
  };

  // Pass through LLM config if available (from user config or env)
  const llmKey = config.userConfig.memory?.llmApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (llmKey) {
    memoryEnv.MEMORY_LLM_BASE_URL = config.userConfig.memory?.llmBaseUrl
      ?? 'https://api.anthropic.com/v1/';
    memoryEnv.MEMORY_LLM_MODEL = config.userConfig.memory?.llmModel
      ?? 'claude-haiku-4-5-20251001';
  }

  sessionConfig.mcpServers['memory'] = {
    command: 'npx',
    args: ['-y', '@ironcurtain/memory-mcp-server'],
    env: memoryEnv,
    description: 'Persistent memory with semantic search',
    sandbox: false,
  };

  // The key itself is a per-server credential, not part of the config:
  // the config is serialized into the memory relay's MCP_SERVERS_CONFIG,
  // while SERVER_CREDENTIALS reaches that relay alone, which scrubs it and
  // sets MEMORY_LLM_API_KEY in the memory server's environment only.
  if (llmKey) {
    sessionConfig.userConfig = {
      ...sessionConfig.userConfig,
      serverCredentials: { ...sessionConfig.userConfig.serverCredentials, memory: { MEMORY_LLM_API_KEY: llmKey } },
    };
  }
}
```

As implemented (`buildMemoryServerConfig()` and `buildMemoryServerCredentials()` in `src/memory/memory-annotations.ts`), the key never appears in the memory server's config, so no other relay or backend can read it.

> **As implemented (WP-67): which key goes where** (`src/memory/memory-llm.ts`). The memory server sends its key as a bearer token to whatever base URL it has, so a key reaches only the service it belongs to:
>
> - `memory.llmApiKey` goes to `memory.llmBaseUrl`, or, without one, to the Anthropic route below (no longer to the OpenAI client's default `api.openai.com`).
> - Without `memory.llmApiKey`, the Anthropic API key is used only on the Anthropic route: `https://api.anthropic.com/v1/`, or, when an Anthropic base URL is configured (`ANTHROPIC_BASE_URL` / `anthropicBaseUrl`, e.g. a LiteLLM gateway whose virtual key is the "Anthropic key"), the `/v1/` endpoint under that root (an explicit `/v1` root is kept). The default memory URL is derived the same way. A `memory.llmBaseUrl` on any other origin gets no key (a local Ollama needs none; another provider needs `memory.llmApiKey`), and the session log says the key was withheld. With a gateway configured, the key is not sent to `api.anthropic.com` either: it belongs to the gateway.
> - `memory.llmBaseUrl` must be `https://`, or `http://` to this machine only (`localhost`, `127.0.0.0/8`, `[::1]`); the user config schema rejects anything else when the config is loaded, and the builder refuses to put a key on a plain-http connection to another host.
>
> The server is also told who it writes for: `MEMORY_WRITER_KIND` (`interactive` for a session a person drives, `cron` for a scheduled job, `workflow` for a workflow state) and `MEMORY_SESSION_ID` (IronCurtain's session id). See "Trust model" below.
>
> **As implemented (WP-96).** An unattended writer is also given its review scope, `MEMORY_WRITER_SCOPE`: `job:<id>` for a cron job, `workflow:<run id>` for a workflow state (`cronMemoryScope` / `workflowMemoryScope` in `memory-annotations.ts`). `buildMemoryServerConfig` refuses a cron or workflow writer without one and an interactive writer with one. The server falls back to `session:<id>` (or the kind) when a host gives none. See "Review quarantine" below.
>
> **As implemented (FU-05).** The quarantine is the memory server's work, so `buildMemoryServerConfig` also refuses a cron or workflow writer when the installed `@provos/memory-mcp-server` predates it, instead of starting a server that would ignore `MEMORY_WRITER_SCOPE` and file the run's memories among the ones interactive sessions read (the published 0.2.1, or a checkout whose workspace package was not rebuilt). It tells by resolving the package's `./admin` export, which shipped with the quarantine (`memoryServerHasReviewQuarantine` in `src/memory/memory-server-exports.ts`), and its error says to update or rebuild the server. Interactive writers are not affected; `ironcurtain doctor` reports the condition under Memory (`Memory review quarantine`).

### Namespace Resolution

```typescript
function resolveMemoryDbPath(opts: { persona?: string; jobId?: string }): string {
  if (opts.persona) {
    return resolve(getPersonaDir(createPersonaName(opts.persona)), 'memory.db');
  }
  if (opts.jobId) {
    return resolve(getJobDir(opts.jobId), 'memory.db');
  }
  return resolve(getIronCurtainHome(), 'memory', 'default.db');
}
```

### Persona System Prompt Update

Replace memory.md injection with a lightweight pointer:

```typescript
export function buildPersonaSystemPromptAugmentation(
  persona: PersonaDefinition,
): string {
  return `
## Persona: ${persona.name}

${persona.description}

## Persistent Memory

You have access to a persistent memory server ("memory") with semantic search.

At the **start** of each session:
- Call \`memory_context\` with a brief description of the current task to get a briefing of relevant memories.

During the session, when you learn something worth remembering:
- Use \`memory_store\` to save facts, preferences, decisions, or observations.
- Use descriptive tags (e.g., "preference", "project:name", "person:name").
- Keep memories **atomic** — one fact per memory.

To find specific memories during the session:
- Use \`memory_recall\` with a natural language query.
`.trim();
}
```

### Cron Job Memory

When a cron job runs under a persona, it uses the **persona's** memory namespace (not a separate job namespace). The persona is the persistent identity; the cron job is just a trigger. Job-specific ephemeral state uses `workspace/last-run.md` as before.

Because unattended runs share the namespace with sessions a person drives, every memory records who wrote it (WP-67): the server stamps `metadata.writer = { kind, session_id }` from `MEMORY_WRITER_KIND` / `MEMORY_SESSION_ID` on every row it inserts (store and ingest). The values come from IronCurtain's environment, never from tool arguments (`source` stays the caller's own label). There is no schema change: the existing `metadata` JSON column holds it, and rows written before have no writer. When consolidation replaces a row's text with a newer contradicting fact, the writer moves with the text, and the replaced text keeps its own writer in `metadata.superseded`. `memory_inspect` lists show the writer; raw recalls include it. An unattended writer's record also carries its review scope (`scope`, WP-96).

#### Review quarantine (WP-96)

What an unattended run (cron job, workflow state) writes waits for review before sessions a person drives see it (`packages/memory-mcp-server/src/utils/review.ts`):

- **Marking.** A row an unattended writer inserts gets `metadata.pending_review = <writer scope>` (store, ingest, and a compaction summary of pending rows). No schema change.
- **Visibility.** Every read an agent's tool call reaches (briefing, recall in every format, `memory_expand`, every `memory_inspect` view including counts and tags, the `memory_forget` selection and preview) sees the reviewed rows and only the pending rows of the server's own scope. So a cron job's later runs see what its earlier runs wrote; interactive sessions, other jobs and workflows do not. The filter is applied inside the candidate searches, before their limits, in the KNN and in the exact scan of a tag-scoped recall alike (`SearchOptions.scope` in `queries.ts`). A segment is readable only through a row the reader may see that is also live (`getLiveSegmentsByIds` with the reader's scope): a decayed visible row and a live hidden one do not make it readable. A malformed marker hides the row from every reader.
- **No merging across groups, and pending rows frozen (FU-05).** A pending row is never merged into, nor merged into another row, until it is approved. The full review payload is bound to an approval receipt; the admin API checks that receipt under its write transaction before release. Before, a later run of the same scope could change a listed row in between: store-time dedup merged an identical fact into it (unioning tags, repointing it to a richer source passage), and consolidation's contradiction outcome replaced its text, vector and writer with a newer row's. So store-time dedup merges only a reviewed writer's fact, and only into reviewed rows (an unattended writer's identical fact becomes a new pending row), and consolidation pairs reviewed rows only (`vectorSearchConsolidated` returns reviewed rows, and the rows are re-checked before a judgment is applied): pending rows are marked consolidated without being judged, so a pending memory's text never reaches the judge's prompt either, where it could steer the judgments of reviewed pairs. Compaction clusters stay within one group and write a new row (the summary of pending rows waits for review under their scope); it never changes a row's text. An ingest reuses an existing source segment of the same text (WP-94's content-hash reuse for retried ingests) only when memories of its own group alone link to it, so one group's review reject or forget never purges another group's source, and `segments_created` reveals nothing about sources the writer may not read. So an unattended run can neither change a reviewed memory nor hide its text in one.
- **Approval.** `ironcurtain memory <persona|job> review` and `show <id>` display the complete releasable payload as terminal-safe JSON: text, tags, source label, metadata and the entire source segment. Strings are quoted and escaped, so literal backslashes remain distinguishable from control characters; no field is truncated. Each pending row gets an `<id>@<digest>` receipt, bound to its namespace and full payload. `review approve <id>@<digest>...` re-reads those exact snapshots in one IMMEDIATE transaction and refuses changed rows before removing their markers, recording `metadata.reviewed_at` and resetting `consolidated`. The next maintenance pass then judges approved rows against the reviewed memories. Bare ids and `approve --all` are refused; batching requires the explicitly displayed receipts, so unseen rows do not join an approval. `review reject <id>...` still deletes pending rows after the forget snapshot. JSON review/show views include the full snapshot and receipt too. Rows written before WP-96 carry no marker and stay visible.

### Server Allowlist

The `"memory"` server is always included when memory is enabled, regardless of persona server allowlist — same treatment as `"filesystem"`.

### Policy Treatment

> **As implemented (WP-67).** The memory server is a *trusted server* (`buildTrustedServerSet`, verified by its exact command line): it has no annotations and no compiled rules, and the policy engine judges its calls per tool instead (`src/trusted-process/trusted-server-policy.ts`), on the raw arguments the server receives:
>
> | Call | Decision |
> | --- | --- |
> | `memory_store`, `memory_recall`, `memory_context`, `memory_expand`, `memory_inspect` | allow (`trusted-server`) |
> | `memory_forget` with `dry_run: true`, or with `ids` only (at most 10) | allow |
> | `memory_forget` that deletes by `tags`, `query` or `before`, or names more than 10 `ids` (`MEMORY_FORGET_ESCALATE_IDS`; an `ids` that is not a list counts too) | escalate, human-only (`memory-bulk-forget-escalate`) |
> | `memory_ingest` with more than 10,000 characters of content (also for `dry_run`, which still sends the blob to the LLM) | escalate, human-only (`memory-large-ingest-escalate`) |
> | any other tool | deny (`trusted-server-unknown-tool`) |
>
> The escalations are human-only: the auto-approver and the approval whitelist anchor on resource arguments, and these calls have none, so only a person reading the arguments can judge them; an unattended run with no escalation route is denied. In the pipeline a trusted server's escalation uses an empty annotation (no paths to capture or expose as roots).
>
> The id bound exists because `memory_inspect` lists every id and a deletion by ids needs no `confirm`: without it one call could delete 100 memories (the server maximum) and a handful of calls a whole namespace, with no human asked. The policy judges only own properties of the arguments, as JSON serialization sends only those to the server.
>
> The server adds its own guard: before a bulk deletion removes anything, and before the first deletion of each server run (one per session, ids included), it writes a private (0600) `VACUUM INTO` snapshot next to the database (`<db>.forget-snapshot-<timestamp>.db`, the 5 newest kept per database) and names it in its reply; if the snapshot cannot be written, nothing is deleted. A run of small id deletions (each within the bound) is therefore still allowed call by call, but the session's first snapshot holds every memory that existed before it, and later id deletions of the same run take no further snapshot, so they cannot rotate older ones out. Two servers sharing a database claim snapshot names with an exclusive create, so neither writes or removes the other's file. A snapshot keeps the forgotten memories until it is deleted.

The original plan (superseded) was hardcoded annotations with all args `none` and a blanket `allow-memory-operations` rule.

### Trust model (WP-67)

Memory carries text from earlier sessions into later ones, and some of those sessions run unattended or read untrusted content, so one injected session could otherwise plant a note that every later session of the persona loads as context. Besides provenance (Cron Job Memory) and the per-tool policy above:

- **Framing.** Every tool result that carries stored text (`memory_context`, `memory_recall` in every format, `memory_expand`, `memory_inspect`, the `memory_forget` dry-run preview) is wrapped in a notice that the notes were written by earlier agent sessions and are data, not instructions, inside `<memory_notes>` tags; tag openers (and look-alikes) in stored text are escaped so a note cannot close the frame, also when zero-width characters or combining marks follow the `<` or the slash. `raw` recalls stay JSON: `{ "notice": ..., "memories": [...] }`. Every prompt of the memory LLM that shows it several stored memories at once (recall summary and answer, the consolidation judge, compaction) says the same and escapes the stored text inside its tags, so one planted memory cannot steer what the model does with the others; compaction records an instruction found in a memory only as a stored note. This is a prompt-level mitigation only.
- **Prompts.** The system prompt and the Docker `CLAUDE.md` seed load the briefing once at session start (no longer "MANDATORY", no longer before every user message), say that memories are data that cannot override the user or grant permissions, no longer tell the agent to keep the memory system from the user, and forbid storing secrets.
- **Ranking.** Agent-chosen importance (and importance an extraction model gives a fact) is capped at 0.8, and a briefing does not count as an access (Section 5.2).
- **Secrets.** `memory_store` rejects content or tags that look like a secret value (provider API keys and tokens, bearer tokens, private keys, passwords in URLs or written as assignments, card numbers, SSNs); `memory_ingest` removes them from the blob before extraction, and the engine removes any that reach its write path. The auto-save prompt masks secrets in the conversation it replays.
- **Quarantine and review (WP-96).** What unattended runs write waits for review and reaches interactive sessions only once approved (see "Review quarantine" under Cron Job Memory); `ironcurtain memory <persona|job> list|search|show|forget|export|import|stats|review` lets the user read, curate, back up and approve the store without an agent. It works in the namespace the target's sessions use: a persona's name, or the `memoryNamespace` its persona.json records after `persona rename` (or a trash restore under another name), so a renamed persona's memories are reviewed and imported where its sessions read them; a persona whose persona.json cannot be used is refused. It shares the command with `ironcurtain memory prefetch` (WP-95): `prefetch` in the place of the persona or job always means that command, and a persona or job of that name is written `persona:prefetch` / `job:prefetch`.

## 12. Package Structure and Monorepo Strategy

### Why npm Workspaces

The memory server is an **independent, separately-publishable package** that lives inside the IronCurtain monorepo using npm workspaces. This gives us:

- **Single repo, single CI** — no git submodule ceremony, no `--recurse-submodules`, no version-pinning-by-SHA
- **Independent publishing** — `cd packages/memory-mcp-server && npm publish` publishes it standalone; external users install it with `npx @ironcurtain/memory-mcp-server` without pulling IronCurtain
- **Zero coupling** — the memory server has no imports from IronCurtain; IronCurtain references it only by package name in its MCP server config
- **Develop in tandem** — changes to both packages in a single PR, single `npm install`, workspace linking handles the rest
- **Easy extraction** — if the memory server gets its own contributor community, the `packages/memory-mcp-server/` directory can be moved to a separate repo with full git history via `git filter-branch` or `git subtree split`

### Root `package.json` Changes

```jsonc
// Add to the root package.json:
{
  "workspaces": ["packages/*"],
  // ... existing fields unchanged ...
}
```

npm workspaces hoists shared dependencies to the root `node_modules/` and symlinks workspace packages. The memory server's `devDependencies` (vitest, typescript) are shared with IronCurtain's existing tooling.

### Repository Layout

```
ironcurtain/
├── package.json                 # Root — adds "workspaces": ["packages/*"]
├── package-lock.json            # Single lockfile for the entire monorepo
├── src/                         # IronCurtain source (unchanged)
├── test/                        # IronCurtain tests (unchanged)
├── packages/
│   └── memory-mcp-server/
│       ├── package.json         # Independent package: @ironcurtain/memory-mcp-server
│       ├── tsconfig.json        # Extends root tsconfig or standalone
│       ├── README.md            # Standalone docs for npm
│       ├── src/
│       │   ├── index.ts                 # Entry point (stdio transport)
│       │   ├── server.ts                # MCP server definition, tool registration
│       │   ├── tools/
│       │   │   ├── store.ts             # memory_store (dedup + contradiction)
│       │   │   ├── recall.ts            # memory_recall (LLM summarization)
│       │   │   ├── context.ts           # memory_context (session briefing)
│       │   │   ├── forget.ts            # memory_forget (dry_run)
│       │   │   └── inspect.ts           # memory_inspect
│       │   ├── retrieval/
│       │   │   ├── pipeline.ts          # Retrieval pipeline orchestration
│       │   │   ├── scoring.ts           # RRF + composite scoring
│       │   │   ├── dedup.ts             # Deduplication + contradiction detection
│       │   │   └── formatting.ts        # Extractive + LLM abstractive formatters
│       │   ├── storage/
│       │   │   ├── database.ts          # SQLite + extensions setup, migrations
│       │   │   ├── queries.ts           # SQL query builders
│       │   │   ├── maintenance.ts       # Amortized decay + compaction
│       │   │   └── compaction.ts        # LLM-assisted memory consolidation
│       │   ├── llm/
│       │   │   └── client.ts            # OpenAI-compatible LLM client
│       │   ├── embedding/
│       │   │   └── embedder.ts          # Transformers.js ONNX embedding engine
│       │   └── config.ts               # Environment variable parsing
│       └── test/
│           ├── store.test.ts            # Dedup + contradiction tests
│           ├── recall.test.ts           # LLM summarization tests
│           ├── context.test.ts
│           ├── retrieval-pipeline.test.ts
│           ├── maintenance.test.ts
│           ├── compaction.test.ts
│           └── llm-client.test.ts       # Mock LLM endpoint tests
```

### Memory Server `package.json`

```jsonc
{
  "name": "@ironcurtain/memory-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "description": "Persistent memory MCP server with semantic search, LLM summarization, and automatic compaction",
  "license": "Apache-2.0",
  "bin": {
    "memory-mcp-server": "./dist/index.js"
  },
  "files": ["dist/"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "better-sqlite3": "^11.x",
    "sqlite-vec": "^0.1.x",
    "@huggingface/transformers": "^3.x",
    "openai": "^4.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^2.x",
    "@types/better-sqlite3": "^7.x"
  }
}
```

### Build and Test Integration

Root-level npm scripts run across workspaces:

```jsonc
// Root package.json scripts additions:
{
  "scripts": {
    // Existing scripts unchanged...
    "build:all": "npm run build --workspaces",
    "test:all": "npm test --workspaces"
  }
}
```

CI runs `npm test --workspaces` to test both IronCurtain and the memory server. The memory server's tests are fully independent — they don't import anything from IronCurtain.

### How IronCurtain References the Memory Server

IronCurtain does **not** add the memory server as a dependency. Instead, it spawns it as a child process via `npx` (same as any MCP server), using the published package name:

```typescript
// In buildSessionConfig() — uses the published npm package, not a workspace import
sessionConfig.mcpServers['memory'] = {
  command: 'npx',
  args: ['-y', '@ironcurtain/memory-mcp-server'],
  env: memoryEnv,
  // ...
};
```

During local development, `npx` resolves to the workspace-linked package automatically. In production, it pulls from npm. This means the memory server is consumed identically whether developing locally or installed by end users — no special workspace-aware code paths.

## 13. Migration from Existing Memory Systems

### From `@modelcontextprotocol/server-memory` (JSONL knowledge graph)

The server supports importing from the JSONL format:

```typescript
// memory_inspect with special import parameter (or standalone CLI)
// Reads entities + observations from JSONL, creates flat memories with tags derived from entity types
```

### Export

`memory_inspect` with `view: "export"` returns all memories as JSONL for backup or migration:

```jsonl
{"id":"abc123","content":"User prefers dark mode","tags":["preference"],"importance":0.8,"created_at":1710100000000}
```

This provides a migration path both into and out of the system. No lock-in.

> **As implemented (WP-96).** The complete export is host-side: `ironcurtain memory <persona|job> export [--output <file>]` (the package's `./admin` export, `src/admin.ts`) writes a header line, every source segment, then every memory of the namespace (decayed and compacted ones included) with its metadata and its vector (base64 float32, when it has one), read with keyset paging from one read transaction. `import <file>` loads such a file into a persona or job (all or nothing; existing ids are kept; vectors are reused when the file's embedding model is the database's and they have the size of its vector index, otherwise the memory is embedded for the database's model and vector size (WP-94) with the model a memory server would load: from the verified store in `~/.ironcurtain/models`, never downloaded under `memory.offlineModels` (`ImportOptions.modelStore`); secret values are removed as on every write). The admin API opens an existing database without DDL and refuses another schema version instead of upgrading it (a memory server migrates it in place first, WP-94), writes imported segments with the content hash ingests find them by, never runs maintenance, and deletes (`forget`, `review reject`) after the forget snapshot through `forgetMemoryRows`, the path `memory_forget` takes: the source segments, compaction's copies and the superseded copies of the text go with the rows. The agent's `memory_inspect` export view now returns at most `limit` memories (default 100), oldest first, decayed and compacted ones included, and only those the reader may see.

## 14. What Beats the Baseline

The baseline is Claude Code's flat markdown files with keyword search. This design beats it by:

1. **Semantic search**: "What does the user think about testing?" finds "integration tests must hit a real database, not mocks" — no shared keywords.
2. **LLM-compressed retrieval**: Retrieved memories are summarized into coherent narratives by Haiku, producing information-dense context blocks that preserve key details while minimizing token usage. SimpleMem's research shows this compression quality is the single biggest lever.
3. **Hybrid search**: FTS5 keyword matching catches what embeddings miss (error codes, exact phrases), and vice versa.
4. **Intelligent deduplication + contradiction resolution**: Near-duplicates are merged; contradicting facts are automatically resolved (new supersedes old, with audit trail).
5. **Session-start briefing**: `memory_context` gives agents continuity with a single tool call, organized by relevance to the current task.
6. **Automatic compaction**: Old, unused memories are consolidated into LLM-generated summaries — details fade but understanding persists, keeping the active memory set lean.
7. **Graceful degradation**: Without an LLM key, everything still works via extractive fallbacks. The LLM is a quality multiplier, not a hard dependency.

## 15. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Local embedding quality insufficient for short fragments | FTS5 hybrid search compensates; configurable model allows upgrades |
| `sqlite-vec` or `better-sqlite3` native compilation fails | Provide prebuilt binaries; fallback to `node:sqlite` (Node 22+) when available |
| ONNX model download on first run (~135 MB for both models) | Pinned commits and SHA-256-verified files in a store outside `node_modules` (`~/.ironcurtain/models` under IronCurtain); `--prefetch-models` ahead of time; offline mode refuses downloads (§9, Model Provenance and Storage) |
| Embedding model lock-in (re-embedding on upgrade) | Store model ID in metadata; re-embedding as v2 management operation |
| LLM summarization hallucination (fabricated facts in summaries) | Original memories preserved in DB; compacted sources tracked in `compacted_from`; extractive fallback always available |
| LLM API unavailability or latency spikes | All LLM calls are non-blocking with fallbacks; server never fails due to LLM issues. As implemented (WP-94): every call has a deadline covering its single retry (60 s for extraction and maintenance, 20 s for summary/answer recalls, which then fall back to extractive or list output) and is aborted when its MCP request is cancelled |
| LLM cost accumulation | Haiku is cheap (~$0.01/day at normal usage); calls are few and small; no LLM on hot paths without user intent. As implemented (WP-94): the calls bypass IronCurtain's metering, so each server process has its own call and token budget (`MEMORY_LLM_MAX_CALLS`, `MEMORY_LLM_MAX_TOKENS`), an ingest is capped at 200 KB and 200 facts, and summary/answer completions at 2,000 tokens |
| Contradiction detection false positives | Default to `'distinct'` when uncertain; superseded content archived in metadata (reversible) |
| Premature decay of important memories | High importance = long half-life; access reinforcement; dry_run on forget; compaction preserves summaries |
| Concurrent writes from multiple sessions | SQLite WAL mode handles this; single-writer per MCP instance is the norm. As implemented (WP-94): every session of a persona runs its own server on the persona's database, so schema upgrades run under `BEGIN IMMEDIATE` after a backup (one server upgrades, the others find it done), and maintenance passes take a lease row in `schema_meta` (renewed while the pass runs), run in the background rather than inside the tool call that triggered them, and skip the startup pass when another server ran one in the last 10 minutes |

## 16. Future Extensions (v2+)

Listed in rough priority order:

1. **Memory types** — optional episodic/semantic/procedural classification, only if data shows type-based filtering improves retrieval
2. **Drill-down navigation** — two-level retrieval: compacted summaries first, then original memories on demand
3. **Re-embedding on model upgrade** — management operation to re-embed all memories with a new model
4. **Cross-namespace search** — controlled search across namespaces with permission model
5. **Streaming retrieval** — for large recalls, stream results as they are scored
6. **Retrieval quality metrics** — instrumentation to measure and improve retrieval relevance over time
7. **Hierarchical summarization** — RAPTOR-style multi-level tree, only if two-level (raw + compacted) proves insufficient

## 17. Implementation Plan

### PR 1: Core MCP Server (standalone package)

1. Set up npm workspaces: add `"workspaces": ["packages/*"]` to root `package.json`, create `packages/memory-mcp-server/` with its own `package.json` and `tsconfig.json`
2. SQLite schema + migrations (`better-sqlite3` + `sqlite-vec` + FTS5)
3. Embedding engine (`@huggingface/transformers`, lazy-loaded)
4. OpenAI-compatible LLM client with graceful fallback (`openai` package)
5. `memory_store` with three-tier duplicate detection + LLM contradiction resolution
6. `memory_recall` with full hybrid retrieval pipeline + LLM abstractive summarization
7. `memory_inspect` with stats view
8. Tests (mock LLM endpoint for deterministic testing)

### PR 2: Session Briefing + Maintenance

1. `memory_context` tool (LLM-enhanced session briefing)
2. `memory_forget` with dry_run
3. Amortized maintenance (inline decay + LLM-assisted compaction)
4. Export/import (JSONL)
5. Tests

### PR 3: IronCurtain Integration

1. Config schema (`memory.enabled`, `memory.llmApiKey`, `memory.llmBaseUrl`, `memory.llmModel` in user config)
2. `resolveMemoryDbPath()` namespace resolution
3. Dynamic server injection in `buildSessionConfig()` with LLM config passthrough
4. Server allowlist update (always include `"memory"`)
5. Policy annotations + compiled rules
6. System prompt updates (persona + cron)
7. Tests

### PR 4: Polish + Publish

1. README with usage examples for multiple MCP clients and LLM providers
2. npm publish as `@ironcurtain/memory-mcp-server` (or similar)
3. Config editor integration (memory toggle + LLM endpoint config)
4. Migration guide from `@modelcontextprotocol/server-memory`

## Appendix A: Design Process

This design was produced through a structured multi-agent process:

1. **Three independent proposals** explored different angles:
   - **Semantic memory** (embedding-based vector search + retrieval-time summarization)
   - **Cognitive-inspired memory** (episodic/semantic/procedural types, ACT-R forgetting curves, consolidation)
   - **Hierarchical memory** (RAPTOR-inspired tree with progressive summarization)

2. **A devil's advocate** researched failure modes, critiqued all three proposals, and identified:
   - What actually works in production (SimpleMem, Claude Code's flat files, Google's Always On Memory Agent)
   - Common pitfalls (over-engineering forgetting, requiring LLM for core functionality, unreliable background processes)
   - The minimum viable baseline that any proposal must beat

3. **Convergence points** across all proposals (SQLite + sqlite-vec + FTS5 + local embeddings, token-budget-aware retrieval, composite scoring, extractive summarization default) formed the foundation.

4. **Best-of-breed selection** combined Proposal 1's clean API and retrieval-time focus with Proposal 2's `memory_context` tool and hybrid retrieval, stripped to minimum complexity as recommended by the critique.

Full proposals and critique are archived at:
- `/tmp/proposal-semantic.md`
- `/tmp/proposal-cognitive.md`
- `/tmp/proposal-hierarchical.md`
- `/tmp/critique-framework.md`
- `/tmp/critique-review.md`
