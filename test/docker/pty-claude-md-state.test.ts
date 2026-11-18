/**
 * PTY-mode regression tests for seeding CLAUDE.md into the conversation-state
 * dir, which is the agent's read-write `~/.claude/` mount.
 *
 * A resumed PTY session reuses `<sessionDir>/claude-state`, so whatever the
 * agent left at `CLAUDE.md` in the earlier run is still there when the host
 * seeds it again. The host must replace that entry, never write through it,
 * create its target, or block on it.
 *
 * Docker is mocked out. The adapter offers no PTY command, so each attempt
 * stops with a scripted error right after the CLAUDE.md step and runs the
 * ordinary teardown. `buildSessionConfig` reports a memory-enabled persona
 * session and the real `buildDockerClaudeMd` builds the content.
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';

const state = vi.hoisted<{ infrastructure: unknown; memoryEnabled: boolean }>(() => ({
  infrastructure: undefined,
  memoryEnabled: true,
}));

vi.mock('ora', () => ({
  default: () => ({
    isSpinning: true,
    start() {
      return this;
    },
    fail() {},
    succeed() {},
  }),
}));

vi.mock('../../src/session/index.js', () => ({
  // Like the real one, creates the session directory (the session claims it).
  buildSessionConfig: (config: unknown, sessionId: string) => {
    mkdirSync(`${process.env.IRONCURTAIN_HOME}/sessions/${sessionId}`, { recursive: true });
    return {
      config,
      sandboxDir: `/tmp/${sessionId}/sandbox`,
      escalationDir: `/tmp/${sessionId}/escalations`,
      systemPromptAugmentation: '',
      resolvedSkills: [],
      memoryEnabled: state.memoryEnabled,
      hostModelNotices: [],
    };
  },
}));

vi.mock('../../src/session/session-metadata.js', () => ({
  loadSessionMetadata: vi.fn(),
  updateSessionMetadata: vi.fn(),
}));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: async () => state.infrastructure,
  activateNestedDockerWorkload: vi.fn(),
  attachDockerDesktopAgentEgressNetwork: vi.fn(),
  resolveNestedDockerAgentWiring: () => ({ appleNestedDaemon: undefined, env: {}, namedVolumeMounts: [] }),
  resolveNestedDockerOuterAgentImage: (_infra: unknown, image: string) => image,
  buildAgentUidRemap: () => ({}),
  buildDockerDesktopTransportCreateLimits: () => ({}),
  buildDockerAgentTrustedCreateOptions: () => undefined,
  buildUdsSocketMounts: () => [],
  buildDockerWorkloadEgressMounts: () => [],
  dockerWorkloadEgressNetworkAccess: () => 'offline',
  stopDockerWorkloadEgress: async () => {},
  createLedgeredAgentContainer: vi.fn(),
  dockerWorkloadSessionMetadata: vi.fn(),
  removeBundleRuntimeRoot: vi.fn(),
  selectOuterContainerResources: () => ({ memoryMb: undefined, cpus: undefined }),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
}));

vi.mock('../../src/docker/container-lifecycle.js', () => ({
  destroyBundleOuterResources: async () => {},
}));

import { runPtySession } from '../../src/docker/pty-session.js';

const PERSONA = 'researcher';
const PERSONA_LINE = `You are operating as the "${PERSONA}" persona.`;
const NO_PTY_COMMAND = /does not support PTY mode/u;

describe('PTY start seeds CLAUDE.md without following agent-planted entries', () => {
  let root: string;
  let stateDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pty-claude-md-'));
    stateDir = join(root, 'session', 'claude-state');
    mkdirSync(stateDir, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(root, 'home');
    state.memoryEnabled = true;
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.IRONCURTAIN_HOME = originalHome;
    else delete process.env.IRONCURTAIN_HOME;
    state.infrastructure = undefined;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function claudeMd(): string {
    return join(stateDir, 'CLAUDE.md');
  }

  /** Start a PTY session whose bundle mounts `stateDir`; it stops right after the CLAUDE.md step. */
  async function startPty(adapterId = 'claude-code'): Promise<void> {
    state.infrastructure = {
      docker: {},
      proxy: { stop: async () => {} },
      mitmProxy: { stop: async () => {} },
      useTcp: false,
      runtimeKind: 'docker',
      setTokenSessionId: () => {},
      beginCaptureSession: () => {},
      // No buildPtyCommand: the attempt fails with NO_PTY_COMMAND after seeding.
      adapter: { id: adapterId, displayName: 'Test agent' },
      fakeKeys: new Map(),
      orientationDir: join(root, 'orientation'),
      socketsDir: join(root, 'sockets'),
      systemPrompt: 'You are a test agent.',
      image: 'ironcurtain-test:latest',
      mitmAddr: { socketPath: join(root, 'mitm.sock') },
      conversationStateDir: stateDir,
      conversationStateConfig: undefined,
    };
    await runPtySession({
      config: { userConfig: { modelProviders: { default: 'native' } } } as never,
      mode: { kind: 'docker', agent: adapterId as never },
      persona: PERSONA,
      workspacePath: root,
    });
  }

  function expectSeededRegularFile(): void {
    expect(lstatSync(claudeMd()).isFile()).toBe(true);
    expect(readFileSync(claudeMd(), 'utf8').startsWith(PERSONA_LINE)).toBe(true);
  }

  it('replaces an absolute symlink and leaves its target untouched', async () => {
    const victim = join(root, 'home-dir', '.bashrc');
    mkdirSync(join(root, 'home-dir'));
    writeFileSync(victim, 'export PATH=/usr/bin\n');
    symlinkSync(victim, claudeMd());

    await expect(startPty()).rejects.toThrow(NO_PTY_COMMAND);

    expect(readFileSync(victim, 'utf8')).toBe('export PATH=/usr/bin\n');
    expectSeededRegularFile();
  });

  it('replaces a relative symlink that resolves against the host session dir', async () => {
    // claude-state is <root>/session/claude-state, so ../audit.jsonl is the session's audit log.
    const auditLog = join(root, 'session', 'audit.jsonl');
    writeFileSync(auditLog, '{"decision":"allow"}\n');
    symlinkSync('../audit.jsonl', claudeMd());

    await expect(startPty()).rejects.toThrow(NO_PTY_COMMAND);

    expect(readFileSync(auditLog, 'utf8')).toBe('{"decision":"allow"}\n');
    expectSeededRegularFile();
  });

  it('replaces a dangling symlink without creating its target', async () => {
    const target = join(root, 'created-by-host');
    symlinkSync(target, claudeMd());

    await expect(startPty()).rejects.toThrow(NO_PTY_COMMAND);

    expect(existsSync(target)).toBe(false);
    expectSeededRegularFile();
  });

  it('replaces a FIFO without opening it', async () => {
    execFileSync('mkfifo', [claudeMd()]);
    // Keep a non-blocking read end open so a regressed writer would complete
    // (leaving bytes in the pipe) instead of blocking this worker forever.
    const reader = openSync(claudeMd(), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      await expect(startPty()).rejects.toThrow(NO_PTY_COMMAND);
      let pending = 0;
      try {
        pending = readSync(reader, Buffer.alloc(64 * 1024), 0, 64 * 1024, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      }
      expect(pending).toBe(0);
    } finally {
      closeSync(reader);
    }
    expectSeededRegularFile();
  });

  it('fails the start on a directory at CLAUDE.md and leaves it intact', async () => {
    mkdirSync(join(claudeMd(), 'agent-data'), { recursive: true });

    await expect(startPty()).rejects.toThrow(/directory occupies/u);

    expect(lstatSync(join(claudeMd(), 'agent-data')).isDirectory()).toBe(true);
  });

  it('does not seed a non-Claude adapter and only unlinks a planted link', async () => {
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, claudeMd());

    await expect(startPty('codex')).rejects.toThrow(NO_PTY_COMMAND);

    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(lstatSync(claudeMd(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('memory off: unlinks a planted link without touching its target', async () => {
    state.memoryEnabled = false;
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, claudeMd());

    await expect(startPty()).rejects.toThrow(NO_PTY_COMMAND);

    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
    expect(lstatSync(claudeMd(), { throwIfNoEntry: false })).toBeUndefined();
  });
});
