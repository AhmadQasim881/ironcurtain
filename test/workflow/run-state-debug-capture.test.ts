import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  captureContainerLogs,
  captureConversationLogs,
  resolveCapturePaths,
  type RunStateCapturePaths,
} from '../../src/workflow/run-state-debug-capture.js';
import { runRunState } from '../../src/workflow/run-state-command.js';
import { getSessionDir } from '../../src/config/paths.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { AgentConversationId, BundleId, Session, SessionId } from '../../src/session/types.js';
import { DockerAgentSession } from '../../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { createAppleContainerManager } from '../../src/docker/apple-container-manager.js';
import { createDockerManager, type ExecFileFn } from '../../src/docker/docker-manager.js';
import type { SpawnFn } from '../../src/docker/spawn-with-idle-timeout.js';
import type { ContainerRuntime } from '../../src/docker/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';

/** The session `workflow run-state` gets from its (mocked) session factory. */
const scripted = vi.hoisted(() => ({ session: undefined as Session | undefined }));

vi.mock('../../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflow/cli-support.js')>();
  return {
    ...actual,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    createWorkflowSessionFactory: () => async () => {
      if (scripted.session === undefined) throw new Error('no session scripted');
      return scripted.session;
    },
  };
});

describe('resolveCapturePaths', () => {
  // A canonical UUIDv4 with hyphens at the standard offsets.
  const bundleId = '12345678-90ab-4cde-8123-456789abcdef' as BundleId;
  const outputDir = '/tmp/some-output-dir';

  it('places container-logs.txt and claude-session-logs/ under outputDir', () => {
    const paths = resolveCapturePaths(bundleId, outputDir);
    expect(paths.containerLogsPath).toBe(resolve(outputDir, 'container-logs.txt'));
    expect(paths.claudeLogsDir).toBe(resolve(outputDir, 'claude-session-logs'));
  });

  it('points claudeProjectsSrc at the bind-mounted projects/ tree under the session dir', () => {
    const paths = resolveCapturePaths(bundleId, outputDir);
    expect(paths.claudeProjectsSrc).toBe(resolve(getSessionDir(bundleId), 'claude-state', 'projects'));
  });

  it('does not collide between different sessions sharing an outputDir', () => {
    const a = resolveCapturePaths(bundleId, outputDir);
    const b = resolveCapturePaths('fedcba98-7654-4321-8000-000000000000' as BundleId, outputDir);
    // Same outputDir => same destination paths (per-run isolation comes from
    // the caller picking distinct outputDirs); but the source projects dir
    // must differ across sessions.
    expect(a.claudeProjectsSrc).not.toBe(b.claudeProjectsSrc);
  });
});

describe('captureConversationLogs', () => {
  function makePaths(
    srcRel: string | null,
    destRel: string,
  ): { dir: string; paths: ReturnType<typeof resolveCapturePaths> } {
    const dir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-cclogs-'));
    const claudeProjectsSrc = srcRel === null ? resolve(dir, '__missing__') : resolve(dir, srcRel);
    const claudeLogsDir = resolve(dir, destRel);
    return {
      dir,
      paths: {
        containerLogsPath: resolve(dir, 'unused.txt'),
        claudeLogsDir,
        claudeProjectsSrc,
      },
    };
  }

  it('skips when the source projects dir does not exist (no destination created)', () => {
    const { dir, paths } = makePaths(null, 'claude-session-logs');
    try {
      captureConversationLogs(paths);
      expect(() => mkdirSync(paths.claudeLogsDir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when the source projects dir is empty (no destination created)', () => {
    const { dir, paths } = makePaths('projects', 'claude-session-logs');
    mkdirSync(paths.claudeProjectsSrc, { recursive: true });
    try {
      captureConversationLogs(paths);
      // Destination must NOT exist; mkdirSync would otherwise throw EEXIST.
      expect(() => mkdirSync(paths.claudeLogsDir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies tree when source contains at least one file', () => {
    const { dir, paths } = makePaths('projects', 'claude-session-logs');
    mkdirSync(paths.claudeProjectsSrc, { recursive: true });
    writeFileSync(resolve(paths.claudeProjectsSrc, 'a.jsonl'), 'line\n', 'utf-8');
    try {
      captureConversationLogs(paths);
      // After successful copy, the destination exists; trying to mkdir it throws.
      expect(() => mkdirSync(paths.claudeLogsDir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Container logs (WP-134, WFC-29): through the session's own runtime and the
// container's real id, not a hard-coded `docker logs <guessed name>`.
// ---------------------------------------------------------------------------

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions | undefined;
}

/**
 * `SpawnFn` fake whose children write the scripted stdout and stderr, then
 * exit with `code`. `onSpawn` runs when a child is spawned.
 */
function scriptedSpawn(
  script: { readonly stdout?: string; readonly stderr?: string; readonly code?: number },
  onSpawn?: () => void,
): { readonly spawn: SpawnFn; readonly calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    onSpawn?.();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;
    setImmediate(() => {
      if (script.stdout !== undefined) stdout.write(script.stdout);
      if (script.stderr !== undefined) stderr.write(script.stderr);
      setImmediate(() => child.emit('close', script.code ?? 0, null));
    });
    return child;
  };
  return { spawn, calls };
}

/** Container CLI calls never go through execFile here. */
const unexpectedExec: ExecFileFn = async (cmd, args) => {
  throw new Error(`unexpected execFile: ${cmd} ${args.join(' ')}`);
};
const available = async () => ({ available: true as const });

/** A Docker agent session over `runtime`, as `workflow run-state` gets one (not initialized: no turn is run). */
function agentSession(runtime: ContainerRuntime, containerId: string, runtimeKind: string): DockerAgentSession {
  return new DockerAgentSession({
    config: { userConfig: { resourceBudget: {} } } as unknown as IronCurtainConfig,
    sessionId: 'run-state-capture-test' as SessionId,
    agentConversationId: '00000000-1111-2222-3333-444444444444' as AgentConversationId,
    infra: { docker: runtime, containerId, runtimeKind, systemPrompt: '' } as unknown as DockerInfrastructure,
    ownsInfra: false,
  });
}

describe('captureContainerLogs', () => {
  let dir: string;
  let paths: RunStateCapturePaths;
  let stderrText: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ironcurtain-container-logs-'));
    paths = resolveCapturePaths('run-state-capture-test' as BundleId, dir);
    stderrText = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrText += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures an Apple runtime session's container log by the container's real id", async () => {
    const spawned = scriptedSpawn({ stdout: 'entrypoint: ready\n', stderr: 'socat: listening\n' });
    const runtime = createAppleContainerManager(unexpectedExec, available, { spawn: spawned.spawn });

    await captureContainerLogs(agentSession(runtime, 'apple-ctr-7f3e9a', 'apple-container'), paths);

    expect(spawned.calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([['container', 'logs', 'apple-ctr-7f3e9a']]);
    expect(readFileSync(paths.containerLogsPath, 'utf8')).toBe('entrypoint: ready\nsocat: listening\n');
    expect(stderrText).toBe('');
  });

  it("captures a Docker session's container log through its captured endpoint", async () => {
    const spawned = scriptedSpawn({ stdout: 'docker entrypoint\n' });
    const runtime = createDockerManager(unexpectedExec, available, {
      endpoint: { host: 'unix:///captured.sock' },
      spawn: spawned.spawn,
    });

    await captureContainerLogs(agentSession(runtime, 'c0ffee1234', 'docker'), paths);

    expect(spawned.calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ['docker', '--host', 'unix:///captured.sock', 'logs', 'c0ffee1234'],
    ]);
    expect(spawned.calls[0].options?.env?.DOCKER_HOST).toBe('unix:///captured.sock');
    expect(readFileSync(paths.containerLogsPath, 'utf8')).toBe('docker entrypoint\n');
  });

  it('keeps what was streamed and reports a failed read with control characters escaped', async () => {
    const spawned = scriptedSpawn({ stdout: 'partial\n', stderr: '\u001b[2Jboom', code: 1 });
    const runtime = createAppleContainerManager(unexpectedExec, available, { spawn: spawned.spawn });

    await captureContainerLogs(agentSession(runtime, 'apple-ctr', 'apple-container'), paths);

    expect(readFileSync(paths.containerLogsPath, 'utf8')).toBe('partial\n\u001b[2Jboom');
    expect(stderrText).toContain(
      '[run-state] container log capture failed: container logs exited with code 1: \\u001b[2Jboom',
    );
    expect(stderrText.includes('\u001b')).toBe(false);
  });

  it('reports a runtime that cannot stream logs', async () => {
    const runtime = { supportsImageSnapshots: false } as unknown as ContainerRuntime;

    await captureContainerLogs(agentSession(runtime, 'ctr', 'apple-container'), paths);

    expect(stderrText).toContain('the apple-container container runtime cannot stream container logs');
    expect(readFileSync(paths.containerLogsPath, 'utf8')).toBe('');
  });

  it('writes no log file for a session without a container', async () => {
    await captureContainerLogs({}, paths);

    expect(existsSync(paths.containerLogsPath)).toBe(false);
    expect(stderrText).toContain('this session has no container to capture logs from');
  });
});

describe('workflow run-state container log capture', () => {
  const definition: WorkflowDefinition = {
    name: 'run-state-logs',
    description: 'One agent state',
    initial: 'draft',
    states: {
      draft: {
        type: 'agent',
        description: 'Writes a draft',
        persona: 'global',
        prompt: 'Write a draft.',
        inputs: [],
        outputs: ['draft'],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-run-state-logs-')));
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home'));
  });

  afterEach(() => {
    scripted.session = undefined;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures the Apple runtime container log through the session before closing it', async () => {
    const events: string[] = [];
    const spawned = scriptedSpawn({ stdout: 'apple container log\n' }, () => events.push('logs'));
    const runtime = createAppleContainerManager(unexpectedExec, available, { spawn: spawned.spawn });
    const session = agentSession(runtime, 'apple-ctr-run-state', 'apple-container');
    session.sendMessage = async () =>
      'done\n```\nagent_status:\n  completed: true\n  verdict: approved\n  notes: ok\n```';
    const close = session.close.bind(session);
    session.close = async () => {
      events.push('close');
      await close();
    };
    scripted.session = session;

    const defPath = join(root, 'workflow.yaml');
    const artifacts = join(root, 'artifacts');
    const out = join(root, 'out');
    mkdirSync(artifacts);
    // run-state resolves a YAML manifest path; JSON is valid YAML.
    writeFileSync(defPath, JSON.stringify(definition));

    await runRunState([
      defPath,
      'draft',
      '--artifacts',
      artifacts,
      '--output',
      out,
      '--task',
      'write a draft',
      '--mode',
      'docker',
      '--no-lint',
    ]);

    expect(spawned.calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ['container', 'logs', 'apple-ctr-run-state'],
    ]);
    expect(readFileSync(join(out, 'container-logs.txt'), 'utf8')).toBe('apple container log\n');
    // Captured while the container still existed.
    expect(events).toEqual(['logs', 'close']);
  });
});
