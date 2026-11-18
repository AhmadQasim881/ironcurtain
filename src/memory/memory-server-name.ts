/**
 * The memory MCP server's name, in a module with no imports and no side
 * effects, so the policy engine can name the server without resolving the
 * memory server package (which `memory-annotations.ts` does on import).
 */

export const MEMORY_SERVER_NAME = 'memory';
