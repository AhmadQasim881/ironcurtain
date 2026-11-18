/**
 * Harness resolution shared by the validator, the orchestrator (bundle mint
 * and per-state session mode) and `workflow run-state`.
 */

import { describe, it, expect } from 'vitest';
import {
  collectScopeDockerAgents,
  resolveScopeDockerAgent,
  resolveStateDockerAgent,
} from '../../src/workflow/agent-harness.js';
import type { WorkflowDefinition, WorkflowStateDefinition } from '../../src/workflow/types.js';
import { DOCKER_AGENTS } from '../../src/config/user-config.js';
import { listAgents, registerBuiltinAdapters } from '../../src/docker/agent-registry.js';

function agent(extra: Partial<Extract<WorkflowStateDefinition, { type: 'agent' }>> = {}): WorkflowStateDefinition {
  return {
    type: 'agent',
    description: 'agent',
    persona: 'global',
    prompt: 'p',
    inputs: [],
    outputs: [],
    transitions: [{ to: 'done' }],
    ...extra,
  };
}

function definition(
  settings: WorkflowDefinition['settings'],
  states: Record<string, WorkflowStateDefinition>,
): WorkflowDefinition {
  return {
    name: 'harness',
    description: 'harness resolution',
    initial: Object.keys(states)[0],
    settings,
    states: { ...states, done: { type: 'terminal', description: 'Done' } },
  };
}

describe('resolveStateDockerAgent', () => {
  it('prefers the state, then settings.dockerAgent, then claude-code', () => {
    expect(resolveStateDockerAgent({ dockerAgent: 'codex' }, { dockerAgent: 'goose' })).toBe('codex');
    expect(resolveStateDockerAgent({}, { dockerAgent: 'goose' })).toBe('goose');
    expect(resolveStateDockerAgent({}, undefined)).toBe('claude-code');
  });
});

describe('resolveScopeDockerAgent', () => {
  it("returns the one harness a scope's agent states share", () => {
    const def = definition(
      { mode: 'docker', sharedContainer: true },
      {
        coder: agent(),
        reviewer: agent({ dockerAgent: 'codex', containerScope: 'review' }),
        second_reviewer: agent({ dockerAgent: 'codex', containerScope: 'review' }),
      },
    );
    expect(resolveScopeDockerAgent(def, 'primary')).toBe('claude-code');
    expect(resolveScopeDockerAgent(def, 'review')).toBe('codex');
    expect([...collectScopeDockerAgents(def, 'review')]).toEqual([['codex', ['reviewer', 'second_reviewer']]]);
  });

  it('gives a scope without agent states (deterministic only) the workflow default', () => {
    const def = definition(
      { mode: 'docker', sharedContainer: true, dockerAgent: 'goose' },
      {
        coder: agent({ dockerAgent: 'goose' }),
        check: {
          type: 'deterministic',
          description: 'check',
          container: true,
          containerScope: 'checks',
          run: [['true']],
          transitions: [{ to: 'done' }],
        },
      },
    );
    expect(resolveScopeDockerAgent(def, 'checks')).toBe('goose');
  });

  it('refuses a scope that mixes harnesses rather than minting a container some states cannot run in', () => {
    const def = definition(
      { mode: 'docker', sharedContainer: true },
      { coder: agent(), reviewer: agent({ dockerAgent: 'codex' }) },
    );
    expect(() => resolveScopeDockerAgent(def, 'primary')).toThrow(
      'Container scope "primary" mixes agent harnesses: claude-code (coder), codex (reviewer)',
    );
  });
});

describe('DOCKER_AGENTS', () => {
  it('names exactly the adapters registerBuiltinAdapters() provides', async () => {
    // The validator checks harness names against this static list because
    // the registry is filled lazily; the two must not drift.
    await registerBuiltinAdapters();
    expect(
      listAgents()
        .map((adapter) => adapter.id as string)
        .sort(),
    ).toEqual([...DOCKER_AGENTS].sort());
  });
});
