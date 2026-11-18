/**
 * Agent harness (Docker agent adapter) selection for workflow states.
 *
 * A Docker-mode agent state runs on `states.<id>.dockerAgent`, else
 * `settings.dockerAgent`, else `claude-code`. Both fields are validated
 * against `DOCKER_AGENTS` (validate.ts), so an unknown harness fails at load
 * time, not when the first state starts.
 *
 * Under `sharedContainer: true` the harness belongs to the container scope,
 * not to the state: a scope's bundle is one container built from one
 * harness image, and every state in the scope borrows it. Validation rejects
 * a scope whose agent states resolve to different harnesses; a scope with
 * no agent state (containerized deterministic states only) takes the
 * workflow default. The orchestrator mints each scope's bundle with
 * {@link resolveScopeDockerAgent}, and the run-state command and the
 * per-state session mode use {@link resolveStateDockerAgent}, so the
 * validator and every runtime read site share one resolution.
 */

import type { AgentId } from '../docker/agent-adapter.js';
import type { DockerAgent } from '../config/user-config.js';
import type { AgentStateDefinition, WorkflowDefinition, WorkflowSettings } from './types.js';
import { DEFAULT_CONTAINER_SCOPE } from './types.js';

/** Harness used when neither the state nor `settings.dockerAgent` names one. */
export const DEFAULT_DOCKER_AGENT: DockerAgent = 'claude-code';

/** The harness a Docker-mode agent state runs on. */
export function resolveStateDockerAgent(
  state: Pick<AgentStateDefinition, 'dockerAgent'>,
  settings: WorkflowSettings | undefined,
): DockerAgent {
  return state.dockerAgent ?? settings?.dockerAgent ?? DEFAULT_DOCKER_AGENT;
}

/**
 * The harnesses the agent states of `scope` resolve to, each with the states
 * that use it (in definition order). More than one entry means the scope
 * mixes harnesses, which shared-container mode cannot run.
 */
export function collectScopeDockerAgents(
  definition: WorkflowDefinition,
  scope: string,
): ReadonlyMap<DockerAgent, readonly string[]> {
  const byAgent = new Map<DockerAgent, string[]>();
  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.type !== 'agent') continue;
    if ((state.containerScope ?? DEFAULT_CONTAINER_SCOPE) !== scope) continue;
    const agent = resolveStateDockerAgent(state, definition.settings);
    const states = byAgent.get(agent);
    if (states) states.push(stateId);
    else byAgent.set(agent, [stateId]);
  }
  return byAgent;
}

/** One-line description of a scope's harnesses, e.g. `claude-code (coder), codex (reviewer)`. */
export function describeScopeDockerAgents(byAgent: ReadonlyMap<DockerAgent, readonly string[]>): string {
  return [...byAgent].map(([agent, states]) => `${agent} (${states.join(', ')})`).join(', ');
}

/**
 * The harness of the shared-container bundle for `scope`: the one harness
 * its agent states share, or the workflow default when the scope has no
 * agent state. Throws when the scope mixes harnesses (validation rejects
 * such a definition; this keeps a definition that bypassed it from minting
 * a container that cannot run some of its states).
 */
export function resolveScopeDockerAgent(definition: WorkflowDefinition, scope: string): DockerAgent {
  const byAgent = collectScopeDockerAgents(definition, scope);
  if (byAgent.size > 1) {
    throw new Error(
      `Container scope "${scope}" mixes agent harnesses: ${describeScopeDockerAgents(byAgent)}. ` +
        'A shared-container scope runs one harness; give the other states their own containerScope.',
    );
  }
  const first = byAgent.keys().next();
  return first.done === true ? (definition.settings?.dockerAgent ?? DEFAULT_DOCKER_AGENT) : first.value;
}

/** The adapter registry key for a harness name. */
export function toAgentId(agent: DockerAgent): AgentId {
  return agent as AgentId;
}
