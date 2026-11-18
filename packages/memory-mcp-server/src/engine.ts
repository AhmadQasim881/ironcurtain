/**
 * Engine interface that the MCP tool handlers call.
 * The actual implementation (engine-impl.ts) wires together
 * storage, retrieval, embedding, and LLM modules.
 */

import type {
  StoreResult,
  IngestResult,
  RecallOptions,
  RecallResult,
  ContextOptions,
  ForgetOptions,
  ForgetResult,
  InspectOptions,
  Memory,
  MemoryStats,
  ExpandResult,
} from './types.js';

export interface StoreOptions {
  tags?: string[];
  importance?: number;
  /** Provenance stamped on the row. The insert path already supports `source`. */
  source?: string;
  /**
   * Epoch ms. When set, stamps created_at/updated_at/last_accessed_at to this
   * value at insert time (the `as_of` backdate mechanism). Absent ⇒ Date.now().
   */
  createdAt?: number;
}

export interface IngestOptions {
  source?: string;
  mode?: 'conversation' | 'document';
  tags?: string[];
  /** SEED importance; per-fact importance from extraction overrides it. */
  importance?: number;
  dry_run?: boolean;
  /** Normalized to epoch ms by the handler before reaching the engine. */
  as_of?: number;
  /** How to handle a chunk/call that yields no facts. Default 'degrade'. */
  on_extraction_failure?: 'degrade' | 'skip' | 'error';
}

/** One progress report of a long call (an MCP `notifications/progress`). */
export interface ProgressUpdate {
  /** Steps done so far; increases with every report. */
  progress: number;
  /** Steps in all, when known. */
  total?: number;
  /** A content-free description of the step. */
  message?: string;
}

/**
 * Per-call controls a tool handler passes along with a call that may take long (one
 * that calls the LLM). They come from the MCP request, never from tool arguments.
 */
export interface CallControls {
  /**
   * Aborted when the MCP client cancels the request (or disconnects): LLM calls in
   * flight return at once, and an ingest stops before its next chunk or write.
   */
  signal?: AbortSignal;
  /** Called as an ingest advances, so the client can tell a long ingest from a hung one. */
  onProgress?: (update: ProgressUpdate) => void;
}

export interface MemoryEngine {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  ingest(content: string, opts: IngestOptions, controls?: CallControls): Promise<IngestResult>;
  recall(opts: RecallOptions, controls?: CallControls): Promise<RecallResult>;
  context(opts: ContextOptions, controls?: CallControls): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  /**
   * Fetch passages of a source segment on demand (the agentic "I got a headline,
   * give me THIS fact's parent" follow-up, §9.4). With a `query`, all passages are
   * ranked and the most relevant come back, best first; with none, the segment's
   * first passages in source order. At most `maxPassages` (default 3) either way;
   * the result says how many passages the segment has.
   */
  expand(segmentId: string, query?: string, maxPassages?: number): Promise<ExpandResult>;
  close(): void;
}
