/**
 * Pure-data memory enablement helper.
 *
 * Combines the signals that determine whether the memory MCP server is
 * mounted for a session: the global kill switch
 * (`userConfig.memory.enabled`), whether the session borrows a workflow
 * shared-container bundle, the per-persona opt-in, and the per-job
 * opt-in. The helper is the SINGLE point where these signals are
 * combined; all runtime sites call it.
 *
 * This file is intentionally pure-data: it imports types only, no
 * runtime modules from `src/persona/`. The loader-aware variant (which
 * needs `loadPersona`) lives in `src/persona/memory-gate.ts` to avoid
 * a `memory/ -> persona/ -> memory/` import cycle.
 */

// Type-only imports: no runtime edge, no cycle risk.
import type { PersonaDefinition } from '../persona/types.js';
import type { JobDefinition } from '../cron/types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

/**
 * Inputs to the memory-enablement decision. All scope fields optional;
 * absence is significant (e.g., no persona AND no job means a default
 * session, which never gets memory).
 */
export interface MemoryGateInputs {
  /** Loaded persona definition, or undefined for non-persona sessions. */
  readonly persona?: PersonaDefinition;
  /** Loaded job definition, or undefined for non-cron sessions. */
  readonly job?: JobDefinition;
  /** Resolved user config (always present at the call sites). */
  readonly userConfig: ResolvedUserConfig;
  /**
   * True when the session borrows a workflow shared-container bundle
   * (`SessionOptions.workflow.infrastructure`). The workflow's
   * infrastructure factory fixed that bundle's MCP servers when it minted
   * it, so a memory server added to the session's own config would never
   * run, and the factory never starts one: every persona in the scope
   * shares the bundle's coordinator, so a bundle-wide memory server would
   * give them all one persona's database. Memory is therefore off, and no
   * prompt or CLAUDE.md tells the agent to call a tool that does not
   * exist. See docs/designs/per-persona-memory-optin.md §1.2.
   */
  readonly borrowedBundle?: boolean;
}

/**
 * Decides whether the memory MCP server is enabled for this session.
 *
 * Precedence (most-restrictive wins):
 *   1. Global kill switch: userConfig.memory.enabled === false -> off.
 *   2. Borrowed workflow shared-container bundle -> off (it runs no
 *      memory server; see `MemoryGateInputs.borrowedBundle`).
 *   3. Scope: no persona AND no job -> off (default sessions are stateless).
 *   4. Per-persona: persona.memory.enabled === false -> off.
 *   5. Per-job:     job.memory.enabled === false -> off.
 *   6. Otherwise: on.
 */
export function isMemoryEnabledFor(inputs: MemoryGateInputs): boolean {
  if (!inputs.userConfig.memory.enabled) return false;
  if (inputs.borrowedBundle === true) return false;
  if (!inputs.persona && !inputs.job) return false;
  if (inputs.persona?.memory?.enabled === false) return false;
  if (inputs.job?.memory?.enabled === false) return false;
  return true;
}
