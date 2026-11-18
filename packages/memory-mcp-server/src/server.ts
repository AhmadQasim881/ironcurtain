/**
 * MCP server definition and tool registration.
 * Registers all 7 memory tools (`registerTool`) with their input schemas from the
 * design spec, their behaviour hints (annotations) and, for memory_recall, the
 * schema of its structured result.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CallControls, MemoryEngine, ProgressUpdate } from './engine.js';
import { FORMAT_MODES } from './retrieval/formatting.js';
import { DEFAULT_EXPAND_PASSAGES, MAX_EXPAND_PASSAGES, MAX_SOURCE_LENGTH } from './tools/validation.js';
import { FORGET_QUERY_LIMIT, FORGET_QUERY_MAX_DISTANCE } from './storage/constants.js';
import { handleStore } from './tools/store.js';
import { handleIngest } from './tools/ingest.js';
import { handleRecall } from './tools/recall.js';
import { handleExpand } from './tools/expand.js';
import { handleContext } from './tools/context.js';
import { handleForget } from './tools/forget.js';
import { handleInspect } from './tools/inspect.js';
import { TOOL_DESCRIPTIONS } from './prompts.js';
import { SERVER_VERSION } from './version.js';

export function createServer(engine: MemoryEngine): McpServer {
  const server = new McpServer({
    name: 'memory',
    version: SERVER_VERSION,
  });

  registerTools(server, engine);

  return server;
}

/** What the SDK hands a tool callback besides its arguments. */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The controls for an engine call, from its MCP request: the request's abort signal (the
 * client cancelled it, or went away), and, when the client asked for progress (its
 * request carries a progress token), a reporter that sends `notifications/progress`.
 * Progress also keeps IronCurtain's relay, which resets its call deadline on each report,
 * from cutting off a long ingest that is still advancing.
 */
function callControls(extra: ToolExtra): CallControls {
  const progressToken = extra._meta?.progressToken;
  const onProgress =
    progressToken === undefined
      ? undefined
      : (update: ProgressUpdate): void => {
          extra
            .sendNotification({ method: 'notifications/progress', params: { ...update, progressToken } })
            .catch(() => {
              /* the client is gone; the call's own result reports that */
            });
        };
  return { signal: extra.signal, ...(onProgress ? { onProgress } : {}) };
}

/** The memory tools, by name. */
type MemoryToolName = keyof typeof TOOL_DESCRIPTIONS;

/**
 * What each tool does to the memory store, for MCP clients that show or gate tool
 * calls by it (tool annotations: hints, which bind no client). Only memory_context,
 * memory_expand and memory_inspect leave the store as it was; a briefing does not
 * count as an access (engine-impl.ts, buildContext). A recall counts as an access of
 * what it returns, which holds those memories against decay and raises their rank:
 * an update, but no destructive one. A store or ingest can merge into an existing
 * memory, and the maintenance it starts consolidates, decays and compacts memories;
 * a forget deletes. None of these is idempotent. No tool reaches beyond the memory
 * store (a closed world; the LLM some of them call processes their text and is not
 * acted on). IronCurtain's relay forwards none of this: its own policy classifies the
 * memory tools (trusted-server-policy.ts).
 */
export const TOOL_ANNOTATIONS = {
  memory_store: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  memory_ingest: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  memory_recall: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_expand: { readOnlyHint: true, openWorldHint: false },
  memory_context: { readOnlyHint: true, openWorldHint: false },
  memory_forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  memory_inspect: { readOnlyHint: true, openWorldHint: false },
} as const satisfies Record<MemoryToolName, ToolAnnotations>;

/**
 * The structured result of memory_recall (its `structuredContent`), which repeats the
 * recall metadata of the text in machine-readable form (tools/recall.ts). The SDK checks
 * every successful result against it; an error result carries none.
 */
const RECALL_OUTPUT_SCHEMA = {
  memories_used: z.number().int().nonnegative().describe('How many memories the result draws on.'),
  total_matches: z
    .number()
    .int()
    .nonnegative()
    .describe('How many candidate memories the search found, before relevance filtering and the token budget.'),
  expanded: z.boolean().describe('True when the result includes a source passage.'),
  expanded_segment_ids: z
    .array(z.string())
    .describe('The source segments whose passages the result includes (empty when none).'),
  source_segment_ids: z
    .array(z.string())
    .describe('The source segment of every recalled fact that has one: the ids memory_expand takes.'),
};

/** A text tool result, or the error result for what `run` threw. */
async function textResult(run: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await run() }] };
  } catch (err) {
    return errorResult(err);
  }
}

function errorResult(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: formatError(err) }], isError: true };
}

function registerTools(server: McpServer, engine: MemoryEngine): void {
  server.registerTool(
    'memory_store',
    {
      title: 'Store a memory',
      description: TOOL_DESCRIPTIONS.memory_store,
      inputSchema: {
        content: z
          .string()
          .describe('The memory content. Should be a single fact, observation, decision, or preference.'),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags for filtering (e.g., 'preference', 'project:foo', 'person:alice')."),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Importance 0-1. Higher values resist decay; values above 0.8 are stored as 0.8. Default: 0.5.'),
      },
      annotations: TOOL_ANNOTATIONS.memory_store,
    },
    (args) => textResult(() => handleStore(engine, args)),
  );

  server.registerTool(
    'memory_ingest',
    {
      title: 'Ingest text into memory',
      description: TOOL_DESCRIPTIONS.memory_ingest,
      inputSchema: {
        content: z
          .string()
          .describe(
            'Raw blob to decompose: a conversation transcript, document, or session summary. At most 200 KB; ' +
              'split larger content into several ingests.',
          ),
        source: z
          .string()
          .optional()
          .describe(
            "A label for where the blob came from, e.g. 'document', 'conversation'. Stored on each fact as " +
              `its source (at most ${MAX_SOURCE_LENGTH} characters). Which session wrote the facts is recorded ` +
              'separately by the server.',
          ),
        mode: z
          .enum(['conversation', 'document'])
          .optional()
          .describe(
            "'conversation' (default): STRICT — only DURABLE facts explicitly stated, no inference. " +
              "'document': broader — DURABLE facts with reasonable inference allowed. " +
              'Both modes keep stable preferences/identity/project facts/decisions and skip ' +
              'ephemeral task chatter. Use document for conversation transcripts.',
          ),
        tags: z.array(z.string()).optional().describe('Optional seed tags applied to EVERY extracted fact.'),
        importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'SEED importance 0-1, used as the fallback when the extraction model does not emit a ' +
              'per-fact importance. Default: 0.5. Per-fact importance (when the model provides it) wins. ' +
              'Any importance above 0.8 is stored as 0.8.',
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe('If true, run extraction and RETURN the facts WITHOUT writing anything. Default: false.'),
        on_extraction_failure: z
          .enum(['degrade', 'skip', 'error'])
          .optional()
          .describe(
            'How to handle a chunk/call that yields no facts (no LLM, LLM error, or unparseable). ' +
              "'degrade' (default): store the blob as a single memory (product behavior). " +
              "'skip': write nothing, return ingested 0. 'error': throw, so a bulk driver can retry.",
          ),
        as_of: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'Backdate: stamp created_at/last_accessed_at of every extracted fact to this time ' +
              '(epoch ms or ISO 8601) instead of now. For ingesting historical exports. ' +
              'Must not be more than 5 minutes in the future.',
          ),
      },
      annotations: TOOL_ANNOTATIONS.memory_ingest,
    },
    (args, extra) => textResult(() => handleIngest(engine, args, callControls(extra))),
  );

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall memories',
      description: TOOL_DESCRIPTIONS.memory_recall,
      inputSchema: {
        query: z.string().describe('Natural language query describing what you want to remember.'),
        token_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum approximate tokens in the response. Default: 800.'),
        tags: z.array(z.string()).optional().describe('Only search memories with ALL of these tags.'),
        format: z
          .enum(FORMAT_MODES)
          .optional()
          .describe(
            "'summary': compressed narrative (default). 'list': bullet points. 'raw': full JSON objects. 'answer': directly answer the query from memories (requires LLM, falls back to list).",
          ),
        expand: z
          .enum(['none', 'auto', 'parent'])
          .optional()
          .describe(
            "'auto' (default): return the relevant source passage when several matched facts share a source " +
              "(e.g. a contract's clauses). 'none': strictly pinpoint facts. 'parent': force the source passage for every match.",
          ),
        max_expand_passages: z
          .number()
          .int()
          .positive()
          .max(MAX_EXPAND_PASSAGES)
          .optional()
          .describe(
            `Maximum source passages to return across the whole result (1-${MAX_EXPAND_PASSAGES}). Default: 2.`,
          ),
      },
      outputSchema: RECALL_OUTPUT_SCHEMA,
      annotations: TOOL_ANNOTATIONS.memory_recall,
    },
    async (args, extra) => {
      try {
        const result = await handleRecall(engine, args, callControls(extra));
        // Surface the recall metadata (segment handles) as structured content so
        // MCP callers can drive the memory_expand follow-up loop in every format;
        // the text carries the same handles as [src:<id>] markers.
        return {
          content: [{ type: 'text', text: result.text }],
          structuredContent: {
            memories_used: result.memories_used,
            total_matches: result.total_matches,
            expanded: result.expanded,
            expanded_segment_ids: result.expanded_segment_ids,
            source_segment_ids: result.source_segment_ids,
          },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'memory_expand',
    {
      title: 'Read a memory source',
      description: TOOL_DESCRIPTIONS.memory_expand,
      inputSchema: {
        segment_id: z
          .string()
          .describe(
            'A source segment id from a prior recall or briefing: the id in a [src:<id>] marker, ' +
              "one of source_segment_ids / expanded_segment_ids, or a raw result's segment_id.",
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Optional: return the passages of the source most relevant to this query, best first. ' +
              'Omit it to read the source from its start, in source order.',
          ),
        max_passages: z
          .number()
          .int()
          .positive()
          .max(MAX_EXPAND_PASSAGES)
          .optional()
          .describe(
            `How many passages to return (1-${MAX_EXPAND_PASSAGES}). Default: ${DEFAULT_EXPAND_PASSAGES}. ` +
              'The line after the passages says how many the source has.',
          ),
      },
      annotations: TOOL_ANNOTATIONS.memory_expand,
    },
    (args) => textResult(() => handleExpand(engine, args)),
  );

  server.registerTool(
    'memory_context',
    {
      title: 'Session briefing from memory',
      description: TOOL_DESCRIPTIONS.memory_context,
      inputSchema: {
        task: z
          .string()
          .optional()
          .describe(
            'Brief description of the current task or session purpose. Helps retrieve the most relevant memories.',
          ),
        token_budget: z.number().int().positive().optional().describe('Maximum tokens for the briefing. Default: 800.'),
      },
      annotations: TOOL_ANNOTATIONS.memory_context,
    },
    (args, extra) => textResult(() => handleContext(engine, args, callControls(extra))),
  );

  server.registerTool(
    'memory_forget',
    {
      title: 'Forget memories',
      description: TOOL_DESCRIPTIONS.memory_forget,
      // Criteria combine with AND: a memory is forgotten only when it matches every
      // supplied criterion, so adding one narrows the deletion (engine-impl.ts).
      inputSchema: {
        ids: z
          .array(z.string())
          .optional()
          .describe('Only these memory IDs. With other criteria, only those of these IDs that also match them.'),
        tags: z.array(z.string()).optional().describe('Only memories that have ALL of these tags.'),
        query: z
          .string()
          .optional()
          .describe(
            `Only memories that closely match this query (cosine distance below ${FORGET_QUERY_MAX_DISTANCE}); ` +
              `at most the ${FORGET_QUERY_LIMIT} closest per call. Weak matches are never forgotten: ` +
              'preview with dry_run, and forget anything else by ids.',
          ),
        before: z.string().optional().describe('Only memories created before this ISO 8601 timestamp.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true to delete with tags, query or before, even when ids are also given. ' +
              'Not needed for ids alone or for dry_run. Default: false.',
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'If true, return what would be forgotten without deleting anything (confirm not needed). Default: false.',
          ),
      },
      annotations: TOOL_ANNOTATIONS.memory_forget,
    },
    (args) => textResult(() => handleForget(engine, args)),
  );

  server.registerTool(
    'memory_inspect',
    {
      title: 'Inspect memory',
      description: TOOL_DESCRIPTIONS.memory_inspect,
      inputSchema: {
        view: z
          .enum(['stats', 'recent', 'important', 'tags', 'export'])
          .optional()
          .describe(
            "'stats': namespace statistics. 'recent': last N stored. 'important': highest importance. 'tags': tag frequency. " +
              "'export': JSONL of memories, oldest first, decayed and compacted ones included.",
          ),
        ids: z.array(z.string()).optional().describe('Inspect specific memories by ID.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max items for recent/important/tags (default 20) and export (default 100) views.'),
      },
      annotations: TOOL_ANNOTATIONS.memory_inspect,
    },
    (args) => textResult(() => handleInspect(engine, args)),
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return 'An unexpected error occurred';
}
