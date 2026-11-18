# Annotation Batching for Large MCP Servers

**Status (2026-11-14):** Implemented: `annotate-tools` sends a server's tools to the model in batches of `ANNOTATION_BATCH_SIZE` (25) (`src/pipeline/tool-annotator.ts`).

## Problem

The tool annotator (`src/pipeline/tool-annotator.ts`) sends all of a server's tools in a single LLM call. This breaks for servers with 100+ tools because:

1. **Output token limit**: `DEFAULT_MAX_TOKENS = 8192` in `generate-with-repair.ts`. Each tool annotation runs 100-200 tokens of output (toolName, comment, sideEffects, args with roles). A 100-tool server needs ~15,000-20,000 output tokens.
2. **Input prompt bloat**: Tool schemas (name + description + full JSON inputSchema) can be 200-500 tokens each. 100 tools = 20,000-50,000 input tokens just for tool descriptions, plus the system prompt, role descriptions, and JSON Schema hint.
3. **Repair loop amplification**: On validation failure, the full failed output is appended to the conversation as an assistant turn, roughly doubling the context per retry.

## Overview

Split tool lists into fixed-size batches before calling the LLM. Each batch produces a partial annotation set. Results are concatenated into the final per-server annotation array. The batching is internal to `annotateTools()` -- callers in `annotate.ts` see no change.

## Key Design Decisions

1. **Fixed batch size of 25 tools, not adaptive.** Adaptive sizing (based on schema complexity) adds complexity for marginal benefit. 25 tools at ~150 tokens each = ~3,750 output tokens, well within the 8,192 limit even with structural overhead. If a tool has an unusually large schema, the prompt is bigger but the output size is bounded by the number of tools, not schema size. The batch size is a module-level constant, easy to tune.

2. **No change to `maxOutputTokens`.** The current 8,192 default is sufficient for 25 tools. Increasing it would waste quota on smaller batches and wouldn't fix the root cause (unbounded tool count). If needed, callers can already pass `maxOutputTokens` to `generateObjectWithRepair()`.

3. **Per-batch Zod schema with only the batch's tool names.** `buildAnnotationsResponseSchema()` already takes the `tools` array and uses `z.enum(toolNames)`. Passing only the batch's tools naturally scopes the enum. The missing-args superRefine validator also works correctly because it only checks tools in the provided array.

4. **Same system prompt per batch, varying only the tool list.** The annotation prompt instructions (role definitions, examples, conditional roles guidance) are identical across batches. Only the tool descriptions block and the final "Return annotations for ALL N tools" line change. `buildAnnotationPrompt()` already handles this -- just pass the batch's tools.

5. **Simple concatenation, no deduplication.** Each batch contains disjoint tools (partitioned, not overlapping). Results are concatenated. The existing post-annotation check (missing tools validation) catches any tools dropped by the LLM.

6. **Per-server caching preserved, with per-tool reuse below it.** The `inputHash` in `annotate.ts` is computed over `(serverName, JSON.stringify(tools), prompt)`. The prompt is built from all tools, so adding/removing a single tool invalidates the whole-server cache. Since WP-88 that no longer re-annotates every tool: each annotation records `annotationKey`, the sha256 of the tool's name, description and input schema plus the server's prompt and role-registry version (`computeToolAnnotationKey` / `annotationPromptVersion` in `tool-annotator.ts`). `annotateServerTools` reuses the roles and comment of every previous annotation (the reviewed package entry first, then the user's own entry; the other way round when the user's entry is pinned) whose key matches the live tool and which still passes the response schema, and batches only the remaining tools. In practice the LLM classifies each tool from its own schema and description (see "Prompt Considerations"), so a tool that did not change keeps its reviewed roles and a refresh produces a review diff of only the changed tools (`annotate-tools --diff`). The description is part of the key, so a change of meaning without a schema change (e.g. "now also accepts local paths") still re-annotates the tool. Annotation calls use temperature 0.

7. **Batching is internal to `annotateTools()`.** The function signature does not change. Callers pass all tools; the function decides whether to batch. This keeps the `annotate.ts` orchestration layer clean. (Since WP-88 the batching lives in `annotateServerTools()`, which `annotate.ts` calls with the previous annotations it may reuse; `annotateTools()` is a wrapper without them.)

## Interface Changes

### `tool-annotator.ts`

```typescript
/** Default number of tools per LLM call. */
const ANNOTATION_BATCH_SIZE = 25;

/**
 * Splits an array into chunks of at most `size` elements.
 * Returns the original array (wrapped) if it fits in one chunk.
 */
function chunk<T>(items: T[], size: number): T[][];
```

No new public types or exports. The `annotateTools()` signature is unchanged:

```typescript
export async function annotateTools(
  serverName: string,
  tools: MCPToolSchema[],
  llm: LanguageModel,
  onProgress?: (message: string) => void,
): Promise<StoredToolAnnotation[]>;
```

### `generate-with-repair.ts`

No changes.

### `annotate.ts`

No changes. The per-server loop, caching, and artifact construction remain identical.

## Implementation

The change is confined to `annotateTools()` in `tool-annotator.ts`:

```typescript
export async function annotateTools(
  serverName: string,
  tools: MCPToolSchema[],
  llm: LanguageModel,
  onProgress?: (message: string) => void,
): Promise<StoredToolAnnotation[]> {
  if (tools.length === 0) return [];

  const batches = chunk(tools, ANNOTATION_BATCH_SIZE);
  const allAnnotations: StoredToolAnnotation[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    if (batches.length > 1) {
      onProgress?.(`Batch ${i + 1}/${batches.length} (${batch.length} tools)`);
    }

    const schema = buildAnnotationsResponseSchema(serverName, batch);
    const prompt = buildAnnotationPrompt(serverName, batch);

    const { output } = await generateObjectWithRepair({
      model: llm,
      schema,
      prompt,
      onProgress: batches.length > 1
        ? (msg) => onProgress?.(`Batch ${i + 1}/${batches.length}: ${msg}`)
        : onProgress,
    });

    const batchAnnotations: StoredToolAnnotation[] = output.annotations.map(
      (a) => ({ ...a, serverName }),
    );

    allAnnotations.push(...batchAnnotations);
  }

  // Validate all input tools are represented across all batches
  const annotatedNames = new Set(allAnnotations.map((a) => a.toolName));
  const missingTools = tools.filter((t) => !annotatedNames.has(t.name));
  if (missingTools.length > 0) {
    const names = missingTools.map((t) => t.name).join(', ');
    throw new Error(`Annotation incomplete: missing tools: ${names}`);
  }

  return allAnnotations;
}
```

### Behavior for Small Servers

When `tools.length <= ANNOTATION_BATCH_SIZE`, `chunk()` returns a single batch. The code path is identical to today except for one extra array wrap/unwrap. The "Batch 1/1" progress message is suppressed by the `batches.length > 1` guard.

### Error Handling

If any batch fails (LLM error, repair exhaustion, schema validation, or output truncated even under the larger retry cap), the error propagates immediately. There is no partial-result recovery within a server -- the entire server annotation fails. This is appropriate because:
- Annotations are developer-facing, cached aggressively, and rerun manually.
- Partial annotations would fail the heuristic validator anyway (missing tools).
- The cache ensures previously successful servers are not re-annotated on retry.

Across servers, `annotate-tools --all` catches the failure (`updateAnnotationOverlay` in `annotation-overlay.ts`): the failed server keeps the annotations in effect for it, the other servers are still annotated, the overlay is written after each server, and the run exits 1 naming the failed servers. A server that lists a tool twice fails before any LLM call.

### Prompt Considerations

The per-batch prompt includes only the batch's tools but the full role description block and examples. This means each batch's LLM call has the same instruction quality. The "Return annotations for ALL N tools" line naturally reflects the batch size since `buildAnnotationPrompt()` uses `tools.length`.

One subtlety: the LLM sees only a subset of the server's tools per batch, so it cannot reason about tool relationships (e.g., "this tool is the read counterpart of that write tool"). In practice, annotation is per-tool -- sideEffects and argument roles are determined from each tool's own schema and description, not by comparison to siblings. If cross-tool reasoning ever becomes important, batches could overlap, but that is not needed now.

## Testing Strategy

1. **Unit test `chunk()`**: empty array, array smaller than batch size, exact multiple, non-exact multiple.
2. **Unit test `annotateTools()` with mocked LLM**: verify that a 50-tool input produces two LLM calls with 25 tools each, and that results are correctly merged. Mock `generateObjectWithRepair` at the module level.
3. **Unit test single-batch path**: verify that a 10-tool input produces exactly one LLM call (no regression).
4. **Unit test error propagation**: verify that a failure in batch 2 of 3 throws without returning partial results.

No integration test changes needed -- the existing annotation pipeline tests use small tool sets that fit in a single batch.

## Future Considerations

- **Parallelism**: Batches could run concurrently with `Promise.all()` for faster annotation of very large servers. Not worth doing now -- sequential execution is simpler, rate-limit friendly, and annotation is a rare developer task. If added later, the `onProgress` callback would need batch-aware multiplexing.
- **Adaptive batch sizing**: If we encounter tools with extremely large schemas (>1000 tokens each), we could estimate input token count and reduce batch size. Not needed until we see it in practice.
- **Per-batch caching**: superseded by the per-tool cache (decision 6), which needs no stable batch assignment: unchanged tools are reused individually and only the new and changed tools are batched.
