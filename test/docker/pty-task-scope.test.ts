/**
 * PTY sessions and task scopes (`--task-scoped`, WP-119).
 *
 * `ironcurtain start --pty` (and so every mux tab) builds its session config
 * through `buildSessionConfig`, which validates and enforces the task scope.
 * A fresh PTY session passes the scope its CLI entry compiled; a resumed one
 * (mux `/resume`, `start --pty --resume`) must keep the scope recorded in its
 * session metadata and never take one from the caller, or a resume would
 * silently run unscoped (or under another task's scope).
 *
 * Docker is mocked out and `buildSessionConfig` stops each attempt right
 * after recording what it was asked to enforce. A resume whose metadata
 * cannot be read never reaches it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';

const state = vi.hoisted<{ seen: Array<{ resumeSessionId?: string; taskPolicyDir?: string }> }>(() => ({
  seen: [],
}));

const STOP = 'stopped after buildSessionConfig';

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
  buildSessionConfig: (
    _config: unknown,
    _effectiveSessionId: string,
    _sessionId: string,
    opts: { resumeSessionId?: string; taskPolicyDir?: string },
  ) => {
    state.seen.push({ resumeSessionId: opts.resumeSessionId, taskPolicyDir: opts.taskPolicyDir });
    throw new Error(STOP);
  },
}));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: vi.fn(),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
  attachDockerDesktopAgentEgressNetwork: vi.fn(),
}));

import { runPtySession } from '../../src/docker/pty-session.js';

const SESSION_ID = 'pty-task-scope-session';

describe('PTY sessions keep their task scope', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pty-task-scope-')));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    state.seen = [];
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.IRONCURTAIN_HOME = originalHome;
    else delete process.env.IRONCURTAIN_HOME;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** A resumable PTY session on disk whose metadata records `taskPolicyDir` (if given). */
  function writeResumableSession(taskPolicyDir: string | undefined): void {
    const sessionDir = join(home, 'sessions', SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session-state.json'),
      JSON.stringify({
        sessionId: SESSION_ID,
        status: 'user-exit',
        exitCode: 0,
        lastActivity: new Date().toISOString(),
        workspacePath: workspace,
        agent: 'claude-code',
        label: 'task-scoped tab',
        resumable: true,
      }),
    );
    writeFileSync(
      join(sessionDir, 'session-metadata.json'),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        workspacePath: workspace,
        ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
      }),
    );
  }

  const config = { protectedPaths: [], userConfig: { modelProviders: { default: 'native' } } } as never;
  const mode = { kind: 'docker', agent: 'claude-code' } as never;

  it('passes the task scope its CLI entry prepared to a new session', async () => {
    const scope = join(home, 'task-policies', 'a'.repeat(64));
    await expect(runPtySession({ config, mode, workspacePath: workspace, taskPolicyDir: scope })).rejects.toThrow(STOP);
    expect(state.seen).toEqual([{ resumeSessionId: undefined, taskPolicyDir: scope }]);
  });

  it('resumes under the task scope recorded in the session metadata, never the caller’s', async () => {
    const recorded = join(home, 'task-policies', 'b'.repeat(64));
    writeResumableSession(recorded);

    await expect(
      runPtySession({
        config,
        mode,
        resumeSessionId: SESSION_ID,
        taskPolicyDir: join(home, 'task-policies', 'c'.repeat(64)),
      }),
    ).rejects.toThrow(STOP);

    expect(state.seen).toEqual([{ resumeSessionId: SESSION_ID, taskPolicyDir: recorded }]);
  });

  it('refuses to resume when the session metadata cannot be read, rather than resuming unscoped', async () => {
    writeResumableSession(join(home, 'task-policies', 'd'.repeat(64)));
    // A write cut short: the task scope it records cannot be restored.
    const metadataPath = join(home, 'sessions', SESSION_ID, 'session-metadata.json');
    writeFileSync(metadataPath, `{"createdAt":"2026-11-14T00:00:00.000Z","taskPolicyDir":"${home}/task-pol`);

    await expect(runPtySession({ config, mode, resumeSessionId: SESSION_ID })).rejects.toMatchObject({
      code: 'SESSION_INIT_FAILED',
      message: expect.stringContaining(metadataPath),
    });

    expect(state.seen).toEqual([]);
  });

  it('resumes an unscoped session unscoped, whatever the caller passes', async () => {
    writeResumableSession(undefined);

    await expect(
      runPtySession({
        config,
        mode,
        resumeSessionId: SESSION_ID,
        taskPolicyDir: join(home, 'task-policies', 'c'.repeat(64)),
      }),
    ).rejects.toThrow(STOP);

    expect(state.seen).toEqual([{ resumeSessionId: SESSION_ID, taskPolicyDir: undefined }]);
  });
});
