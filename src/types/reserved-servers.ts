import { MEMORY_SERVER_NAME } from '../memory/memory-server-name.js';

/**
 * Server names reserved for internal use that cannot be used in
 * mcp-servers.json. These are virtual MCP servers registered in-process
 * rather than spawned from `mcp-servers.json`:
 *
 * - `proxy`: the domain-management tools (`add_proxy_domain`, ...,
 *   `src/docker/proxy-tools.ts`).
 * - `network`: the policy namespace of MITM egress decisions
 *   (`network/request`, see `trusted-process/egress-policy.ts`). It has no
 *   tools an agent can call; a user server under this name would share its
 *   annotations and rules.
 * - `workflow`: the coordinator-owned `workflow_commit` tool
 *   (`src/trusted-process/workflow-commit-tool.ts`).
 *
 * Typed as `ReadonlySet` so importers cannot weaken the reserved-name
 * enforcement in `src/config/mcp-servers-overlay.ts` or the server-filter
 * pass in `src/trusted-process/policy-roots.ts` by mutating the shared global.
 */
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(['proxy', 'network', 'workflow']);

/**
 * Server names a session adds to its own server set, which no
 * mcp-servers.json (the package's or the user's) may define: the memory
 * server (`MEMORY_SERVER_NAME`, `src/memory/memory-server-name.ts`), added to
 * persona and cron job sessions (`src/memory/memory-annotations.ts`).
 * Sessions trust a server of that name that has the exact command they build,
 * bypassing policy, and refuse to start with any other definition, so a
 * configured entry could only break sessions or be trusted.
 *
 * Kept apart from {@link RESERVED_SERVER_NAMES} on purpose: those are
 * virtual in-process servers, which `extractRequiredServers` strips from the
 * spawn set and the coordinator assumes have no backend. These are real
 * servers that are spawned.
 */
export const SESSION_INJECTED_SERVER_NAMES: ReadonlySet<string> = new Set([MEMORY_SERVER_NAME]);
