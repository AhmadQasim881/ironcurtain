/**
 * Re-exports the memory system prompt builder from the memory MCP server package.
 *
 * This thin wrapper centralizes the import so that persona-prompt.ts and
 * session/index.ts don't need to know the package export path.
 */

export { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';

/** Every memory tool, by its raw MCP name. */
const MEMORY_TOOL_NAMES = [
  'memory_context',
  'memory_store',
  'memory_ingest',
  'memory_recall',
  'memory_expand',
  'memory_forget',
  'memory_inspect',
] as const;

/**
 * Rewrites raw MCP tool names (memory_context, memory_store, …) to the
 * Code Mode namespace-aliased format (memory.context, memory.store, …), the
 * names an agent calls them by in every IronCurtain session (builtin and
 * Docker agents alike reach the memory server through Code Mode).
 */
export function adaptMemoryToolNames(prompt: string): string {
  return MEMORY_TOOL_NAMES.reduce(
    (text, name) => text.replaceAll(name, `memory.${name.slice('memory_'.length)}`),
    prompt,
  );
}
