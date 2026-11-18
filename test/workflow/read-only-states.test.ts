/**
 * Read-only agent states (`workspaceAccess: read-only`, WP-131): validation,
 * the scope/state helpers, the host-side preparation of their output
 * directories, the prompts that tell the agent how to write, and the bundled
 * design-and-code reviewer that uses them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateDefinition, WorkflowValidationError } from '../../src/workflow/validate.js';
import { parseDefinitionFile } from '../../src/workflow/discovery.js';
import {
  isReadOnlyAgentState,
  outputWritablePaths,
  readOnlyWorkspaceForScope,
  readOnlyWorkspaceForState,
} from '../../src/workflow/workspace-access.js';
import { prepareWritableOutputDirs } from '../../src/workflow/artifacts.js';
import {
  artifactRepromptReadOnly,
  buildAgentCommand,
  buildArtifactReprompt,
} from '../../src/workflow/prompt-builder.js';
import type {
  AgentStateDefinition,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowSettings,
} from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** plan -> implement -> review (-> implement | done), with optional per-state overrides. */
function reviewLoop(
  settings: Record<string, unknown>,
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const agent = (id: string, outputs: string[], transitions: unknown[]) => ({
    type: 'agent',
    description: id,
    persona: 'global',
    prompt: `You are the ${id} agent.`,
    inputs: [],
    outputs,
    transitions,
    ...overrides[id],
  });
  return {
    name: 'review-loop',
    description: 'test',
    initial: 'plan',
    settings,
    states: {
      plan: agent('plan', ['plan'], [{ to: 'implement' }]),
      implement: agent('implement', [], [{ to: 'review' }]),
      review: agent(
        'review',
        ['reviews'],
        [
          { to: 'done', when: { verdict: 'approved' } },
          { to: 'implement', when: { verdict: 'rejected' } },
        ],
      ),
      done: { type: 'terminal', description: 'done' },
    },
  };
}

const DOCKER = { mode: 'docker', dockerAgent: 'claude-code' };
const SHARED = { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true };

function validationIssues(def: Record<string, unknown>): readonly string[] {
  try {
    validateDefinition(def);
  } catch (err) {
    if (err instanceof WorkflowValidationError) return err.issues;
    throw err;
  }
  return [];
}

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'Some task',
    artifacts: {},
    round: 1,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

function reviewer(overrides: Partial<AgentStateDefinition> = {}): AgentStateDefinition {
  return {
    type: 'agent',
    description: 'Reviews',
    persona: 'global',
    prompt: 'Review the code.',
    inputs: [],
    outputs: ['reviews'],
    transitions: [{ to: 'done' }],
    workspaceAccess: 'read-only',
    ...overrides,
  };
}

function definitionWith(state: AgentStateDefinition, settings: WorkflowSettings): WorkflowDefinition {
  return {
    name: 'prompt-test',
    description: 'test',
    initial: 'review',
    settings,
    states: { review: state, done: { type: 'terminal', description: 'done' } },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateDefinition: workspaceAccess', () => {
  it('accepts a read-only reviewer with per-state containers and in builtin mode', () => {
    for (const settings of [DOCKER, { mode: 'builtin' }]) {
      const parsed = validateDefinition(reviewLoop(settings, { review: { workspaceAccess: 'read-only' } }));
      expect(parsed.states.review).toMatchObject({ workspaceAccess: 'read-only' });
    }
  });

  it('accepts an explicit read-write state', () => {
    expect(validationIssues(reviewLoop(DOCKER, { implement: { workspaceAccess: 'read-write' } }))).toEqual([]);
  });

  it('rejects an unknown access value', () => {
    expect(validationIssues(reviewLoop(DOCKER, { review: { workspaceAccess: 'readonly' } }))).toEqual([
      expect.stringContaining('states.review.workspaceAccess'),
    ]);
  });

  it('rejects workspaceAccess on a state that is not an agent', () => {
    const def = reviewLoop(DOCKER);
    (def.states as Record<string, Record<string, unknown>>).done.workspaceAccess = 'read-only';
    expect(validationIssues(def)).toEqual([
      expect.stringContaining('has "workspaceAccess" but that field is only valid on agent states'),
    ]);
  });

  it('rejects output names a read-only state could not be confined to', () => {
    for (const output of ['../escape', 'a//b', './x', 'a\\b']) {
      const issues = validationIssues(
        reviewLoop(DOCKER, { review: { workspaceAccess: 'read-only', outputs: [output] } }),
      );
      expect(issues, output).toEqual([expect.stringContaining('is not a plain relative path')]);
    }
    // Nested plain names are fine.
    expect(
      validationIssues(reviewLoop(DOCKER, { review: { workspaceAccess: 'read-only', outputs: ['reviews/final'] } })),
    ).toEqual([]);
  });

  it('rejects read-only on fan-out segment members', () => {
    const def = {
      name: 'fan',
      description: 'test',
      initial: 'workers',
      settings: { mode: 'builtin', workers: 2 },
      states: {
        workers: {
          type: 'deterministic',
          description: 'fan-out driver',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['critic'],
          transitions: [{ to: 'done' }],
        },
        critic: {
          type: 'agent',
          description: 'lane critic',
          persona: 'global',
          prompt: 'Critique.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          workspaceAccess: 'read-only',
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    };
    expect(validationIssues(def)).toContainEqual(
      expect.stringContaining('State "critic" sets workspaceAccess: read-only but is a fan-out segment member'),
    );
  });

  it('rejects read-only and read-write agent states in one shared container scope', () => {
    const issues = validationIssues(reviewLoop(SHARED, { review: { workspaceAccess: 'read-only' } }));
    expect(issues).toEqual([
      expect.stringContaining(
        'containerScope "primary" mixes read-only states (review) and read-write states (plan, implement)',
      ),
    ]);
  });

  it('accepts a read-only reviewer in its own shared container scope', () => {
    const def = reviewLoop(SHARED, { review: { workspaceAccess: 'read-only', containerScope: 'review' } });
    expect(validationIssues(def)).toEqual([]);
  });

  it('rejects a containerized result file in a read-only scope', () => {
    const def = reviewLoop(SHARED, { review: { workspaceAccess: 'read-only', containerScope: 'review' } });
    const states = def.states as Record<string, unknown>;
    (states.plan as Record<string, unknown>).transitions = [{ to: 'lint' }];
    states.lint = {
      type: 'deterministic',
      description: 'lint',
      run: [['true']],
      container: true,
      containerScope: 'review',
      resultFile: '.workflow/lint/result.json',
      transitions: [{ to: 'implement' }],
    };
    expect(validationIssues(def)).toEqual([
      expect.stringContaining('State "lint" declares resultFile but runs in containerScope "review"'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scope / state helpers
// ---------------------------------------------------------------------------

describe('workspace access helpers', () => {
  it('gives a read-only state its output directories and a read-write one nothing', () => {
    const def = validateDefinition(reviewLoop(DOCKER, { review: { workspaceAccess: 'read-only' } }));
    const review = def.states.review as AgentStateDefinition;
    const implement = def.states.implement as AgentStateDefinition;
    expect(isReadOnlyAgentState(review)).toBe(true);
    expect(isReadOnlyAgentState(implement)).toBe(false);
    expect(readOnlyWorkspaceForState(review)?.writablePaths).toEqual(['.workflow/reviews']);
    expect(readOnlyWorkspaceForState(implement)).toBeUndefined();
    // A read-only state without outputs may write nothing at all.
    expect(readOnlyWorkspaceForState({ ...review, outputs: [] })?.writablePaths).toEqual([]);
  });

  it('makes a scope read-only from its agent states, with the union of their outputs', () => {
    const def = validateDefinition(
      reviewLoop(SHARED, {
        plan: { workspaceAccess: 'read-only', containerScope: 'readers' },
        review: { workspaceAccess: 'read-only', containerScope: 'readers' },
      }),
    );
    expect(readOnlyWorkspaceForScope(def, 'readers')?.writablePaths).toEqual(['.workflow/plan', '.workflow/reviews']);
    expect(readOnlyWorkspaceForScope(def, 'primary')).toBeUndefined();
    expect(readOnlyWorkspaceForScope(def, 'unused')).toBeUndefined();
  });

  it('fails closed on a scope that mixes access (validation refuses it)', () => {
    const def = reviewLoop(SHARED, { review: { workspaceAccess: 'read-only' } }) as unknown as WorkflowDefinition;
    expect(readOnlyWorkspaceForScope(def, 'primary')?.writablePaths).toEqual(['.workflow/plan', '.workflow/reviews']);
  });

  it('maps output names to .workflow directories', () => {
    expect(outputWritablePaths(['a', 'b/c'])).toEqual(['.workflow/a', '.workflow/b/c']);
  });
});

// ---------------------------------------------------------------------------
// Host-side output directories
// ---------------------------------------------------------------------------

describe('prepareWritableOutputDirs', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ro-outputs-')));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('creates missing output directories, nested names included', () => {
    expect(prepareWritableOutputDirs(workspace, ['.workflow/reviews', '.workflow/a/b'])).toEqual([]);
    expect(lstatSync(join(workspace, '.workflow', 'reviews')).isDirectory()).toBe(true);
    expect(lstatSync(join(workspace, '.workflow', 'a', 'b')).isDirectory()).toBe(true);
  });

  it('keeps an existing output directory and its files', () => {
    mkdirSync(join(workspace, '.workflow', 'reviews'), { recursive: true });
    writeFileSync(join(workspace, '.workflow', 'reviews', 'review.md'), 'previous');
    expect(prepareWritableOutputDirs(workspace, ['.workflow/reviews'])).toEqual([]);
    expect(readdirSync(join(workspace, '.workflow', 'reviews'))).toEqual(['review.md']);
  });

  it('moves a planted symlink aside instead of following it', () => {
    // An earlier read-write state pointed the reviewer's output at the code.
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, '.workflow'));
    symlinkSync(join(workspace, 'src'), join(workspace, '.workflow', 'reviews'));

    const warnings = prepareWritableOutputDirs(workspace, ['.workflow/reviews']);

    expect(warnings).toEqual([expect.stringContaining('was not a real directory; moved it aside')]);
    expect(lstatSync(join(workspace, '.workflow', 'reviews')).isDirectory()).toBe(true);
    expect(readdirSync(join(workspace, 'src'))).toEqual([]);
  });

  it('replaces a symlinked .workflow root too', () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ro-elsewhere-')));
    try {
      symlinkSync(elsewhere, join(workspace, '.workflow'));
      const warnings = prepareWritableOutputDirs(workspace, ['.workflow/reviews']);
      expect(warnings).toHaveLength(1);
      expect(lstatSync(join(workspace, '.workflow')).isDirectory()).toBe(true);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('read-only prompts', () => {
  it('tells a Docker reviewer that the workspace is read-only and how to write its outputs', () => {
    const state = reviewer();
    const prompt = buildAgentCommand('review', state, makeContext(), definitionWith(state, { mode: 'docker' }));
    expect(prompt).toContain('## Read-only workspace');
    expect(prompt).toContain('- `.workflow/reviews/`');
    expect(prompt).toContain('filesystem.write_file');
    expect(prompt).toContain('execute_code');
  });

  it('tells a builtin reviewer only what it may change', () => {
    const state = reviewer();
    const prompt = buildAgentCommand('review', state, makeContext(), definitionWith(state, { mode: 'builtin' }));
    expect(prompt).toContain('## Read-only workspace');
    expect(prompt).not.toContain('execute_code');
  });

  it('says nothing about it for a read-write state', () => {
    const state = reviewer({ workspaceAccess: undefined });
    const prompt = buildAgentCommand('review', state, makeContext(), definitionWith(state, {}));
    expect(prompt).not.toContain('Read-only workspace');
  });

  it('repeats the restriction on a continued re-visit', () => {
    const state = reviewer({ freshSession: false });
    const prompt = buildAgentCommand(
      'review',
      state,
      makeContext({ visitCounts: { review: 2 } }),
      definitionWith(state, { mode: 'docker' }),
    );
    expect(prompt).toContain('Your workspace is still read-only');
  });

  it('repeats how to write in the missing-artifact reprompt', () => {
    const state = reviewer();
    const docker = buildArtifactReprompt(
      ['reviews'],
      state.transitions,
      undefined,
      artifactRepromptReadOnly(state, definitionWith(state, { mode: 'docker' })),
    );
    expect(docker).toContain('filesystem.write_file');
    expect(buildArtifactReprompt(['reviews'], state.transitions, undefined, undefined)).not.toContain('read-only');
    expect(artifactRepromptReadOnly(reviewer({ workspaceAccess: 'read-write' }), definitionWith(state, {}))).toBe(
      undefined,
    );
  });

  // A read-only state still commits its result with `workflow.commit`
  // (WP-133): that call writes nothing into the workspace, and the prompts
  // carry both instructions without one contradicting the other.
  describe('with the workflow.commit protocol', () => {
    const commit = { invocationId: 'inv-ro-1' };

    it('keeps the commit instructions and forbids only git commits on a first visit', () => {
      const state = reviewer();
      const prompt = buildAgentCommand('review', state, makeContext(), definitionWith(state, { mode: 'docker' }), {
        commit,
      });
      const readOnlySection = prompt.split('\n\n---\n\n').find((section) => section.startsWith('## Read-only'));
      expect(readOnlySection).toContain('make git commits');
      expect(readOnlySection).not.toMatch(/\bcommit anything\b/);
      expect(prompt).toContain('workflow.commit({');
      expect(prompt).toContain('"inv-ro-1"');
    });

    it('repeats the restriction and carries the commit instructions on a continued re-visit', () => {
      const state = reviewer({ freshSession: false });
      const prompt = buildAgentCommand(
        'review',
        state,
        makeContext({ visitCounts: { review: 2 } }),
        definitionWith(state, { mode: 'docker' }),
        { commit },
      );
      expect(prompt).toContain('Your workspace is still read-only');
      expect(prompt).toContain('workflow.commit({');
      expect(prompt).toContain('"inv-ro-1"');
    });

    it('gives the missing-artifact reprompt both the read-only note and the commit state', () => {
      const state = reviewer();
      const readOnly = artifactRepromptReadOnly(state, definitionWith(state, { mode: 'docker' }));
      const uncommitted = buildArtifactReprompt(
        ['reviews'],
        state.transitions,
        { ...commit, committed: false },
        readOnly,
      );
      expect(uncommitted).toContain('Your workspace is read-only.');
      expect(uncommitted).toContain('filesystem.write_file');
      expect(uncommitted).toContain('"inv-ro-1"');
      const committed = buildArtifactReprompt(['reviews'], state.transitions, { ...commit, committed: true }, readOnly);
      expect(committed).toContain('Your workspace is read-only.');
      expect(committed).toContain('already committed its verdict');
    });
  });
});

// ---------------------------------------------------------------------------
// Bundled workflow
// ---------------------------------------------------------------------------

describe('design-and-code reviewer', () => {
  it('runs the review state read-only and every other agent state read-write', () => {
    const manifest = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows', 'design-and-code', 'workflow.yaml');
    const def = validateDefinition(parseDefinitionFile(manifest));
    const access = Object.fromEntries(
      Object.entries(def.states)
        .filter(([, state]) => state.type === 'agent')
        .map(([id, state]) => [id, isReadOnlyAgentState(state)]),
    );
    expect(access).toEqual({ plan: false, design: false, implement: false, review: true });
    expect(readOnlyWorkspaceForState(def.states.review as AgentStateDefinition)?.writablePaths).toEqual([
      '.workflow/reviews',
    ]);
  });
});
