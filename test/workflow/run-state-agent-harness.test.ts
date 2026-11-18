/**
 * `ironcurtain workflow run-state` runs one state on that state's own agent
 * harness (`dockerAgent`), resolved like the orchestrator does, and `--mode`
 * still overrides the workflow's mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStateDefinition, WorkflowDefinition } from '../../src/workflow/types.js';
import type { SessionMode } from '../../src/session/types.js';
import { resolveRunStateMode, runRunState } from '../../src/workflow/run-state-command.js';

const seen = vi.hoisted(() => ({ modes: [] as unknown[] }));

vi.mock('../../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflow/cli-support.js')>();
  return {
    ...actual,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    createWorkflowSessionFactory: () => async (options: { mode: unknown }) => {
      seen.modes.push(options.mode);
      return {
        getInfo: () => ({ id: 'run-state-session', status: 'ready', turnCount: 0, createdAt: '' }),
        sendMessage: async () => 'done\n```\nagent_status:\n  completed: true\n  verdict: approved\n  notes: ok\n```',
        close: async () => undefined,
      };
    },
  };
});

// Docker-mode runs capture container logs with `docker logs`; there is no
// container here.
vi.mock('../../src/workflow/run-state-debug-capture.js', () => ({
  resolveCapturePaths: () => ({
    containerLogsPath: '/nonexistent/container-logs.txt',
    claudeLogsDir: '/nonexistent/claude-session-logs',
    claudeProjectsSrc: '/nonexistent/projects',
    containerName: 'ironcurtain-none',
  }),
  captureContainerLogs: async () => undefined,
  captureConversationLogs: () => undefined,
}));

const reviewer: AgentStateDefinition = {
  type: 'agent',
  description: 'Reviews the change',
  persona: 'global',
  prompt: 'Review it.',
  inputs: [],
  outputs: ['review'],
  dockerAgent: 'codex',
  transitions: [{ to: 'done' }],
};

const def: WorkflowDefinition = {
  name: 'run-state-harness',
  description: 'Coder and reviewer on different harnesses',
  initial: 'coder',
  settings: { mode: 'docker' },
  states: {
    coder: {
      type: 'agent',
      description: 'Writes the change',
      persona: 'global',
      prompt: 'Write it.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'reviewer' }],
    },
    reviewer,
    done: { type: 'terminal', description: 'Done' },
  },
};

describe('resolveRunStateMode', () => {
  it("uses the state's harness, else the workflow's, and honours --mode", () => {
    const coder = def.states.coder as AgentStateDefinition;
    const docker = (agent: string): SessionMode => ({ kind: 'docker', agent }) as SessionMode;
    expect(resolveRunStateMode(def, reviewer, undefined)).toEqual(docker('codex'));
    expect(resolveRunStateMode(def, coder, undefined)).toEqual(docker('claude-code'));
    expect(
      resolveRunStateMode({ ...def, settings: { mode: 'docker', dockerAgent: 'goose' } }, coder, undefined),
    ).toEqual(docker('goose'));
    expect(resolveRunStateMode(def, reviewer, 'builtin')).toEqual({ kind: 'builtin' });
  });
});

describe('workflow run-state agent harness', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-run-state-harness-')));
    seen.modes.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the session for the state's own harness", async () => {
    mkdirSync(join(root, 'defs'));
    mkdirSync(join(root, 'artifacts'));
    const defPath = join(root, 'defs', 'workflow.yaml');
    // run-state resolves a YAML manifest path; JSON is valid YAML.
    writeFileSync(defPath, JSON.stringify(def));

    await runRunState([
      defPath,
      'reviewer',
      '--artifacts',
      join(root, 'artifacts'),
      '--output',
      join(root, 'out'),
      '--task',
      'review the change',
      '--no-lint',
    ]);

    expect(seen.modes).toEqual([{ kind: 'docker', agent: 'codex' }]);
  });
});
