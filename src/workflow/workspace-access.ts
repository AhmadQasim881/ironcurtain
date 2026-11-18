/**
 * Read-only agent states (`workspaceAccess: read-only`): which sessions and
 * container scopes run on a read-only workspace, and which workspace
 * directories they may still write. Shared by the orchestrator and the
 * `workflow run-state` debug command so both apply the same confinement. See
 * `src/types/read-only-workspace.ts` for how it is enforced.
 */

import { createReadOnlyWorkspace, type ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import {
  DEFAULT_CONTAINER_SCOPE,
  WORKFLOW_ARTIFACT_DIR,
  type AgentStateDefinition,
  type WorkflowDefinition,
  type WorkflowStateDefinition,
} from './types.js';

/** True for an agent state that declares `workspaceAccess: read-only`. */
export function isReadOnlyAgentState(state: WorkflowStateDefinition): boolean {
  return state.type === 'agent' && state.workspaceAccess === 'read-only';
}

/**
 * The workspace-relative directories (`.workflow/<output>`) of `outputs`: the
 * only places a read-only state may write.
 */
export function outputWritablePaths(outputs: readonly string[]): string[] {
  return outputs.map((output) => `${WORKFLOW_ARTIFACT_DIR}/${output}`);
}

/**
 * The read-only workspace of an agent state, or `undefined` for a read-write
 * state: its writable directories are the state's declared outputs. A session
 * that builds its own environment (builtin, per-state container) runs on it;
 * in shared-container mode the scope's bundle carries the scope's
 * ({@link readOnlyWorkspaceForScope}).
 */
export function readOnlyWorkspaceForState(state: AgentStateDefinition): ReadOnlyWorkspace | undefined {
  if (!isReadOnlyAgentState(state)) return undefined;
  return createReadOnlyWorkspace(outputWritablePaths(state.outputs));
}

/**
 * The read-only workspace of a shared-container scope's bundle, or
 * `undefined` for a read-write scope. A bundle's container and coordinator
 * serve every agent state of the scope, so the scope is read-only when any of
 * its agent states is (validation requires all of them to agree; failing
 * closed here keeps a definition that bypassed it read-only), and its
 * writable directories are the outputs of all of them.
 */
export function readOnlyWorkspaceForScope(
  definition: WorkflowDefinition,
  scope: string,
): ReadOnlyWorkspace | undefined {
  const scopeStates = Object.values(definition.states).filter(
    (state): state is AgentStateDefinition =>
      state.type === 'agent' && (state.containerScope ?? DEFAULT_CONTAINER_SCOPE) === scope,
  );
  if (!scopeStates.some(isReadOnlyAgentState)) return undefined;
  return createReadOnlyWorkspace(scopeStates.flatMap((state) => outputWritablePaths(state.outputs)));
}
