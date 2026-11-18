/**
 * Command-layer integration test for the agent-driven workflow gate CLI.
 *
 * Sibling to `agent-gate-loop.integration.test.ts`, which drives the RPC
 * contract through `DaemonClient` directly. This file instead drives the REAL
 * CLI entry point `runDaemonGateCommand(subcommand, args)` against a live daemon
 * WS surface, so the LOAD-BEARING command code is exercised end-to-end:
 *   - arg parsing (`--json`, `--event`, `--prompt`, `--artifact`)
 *   - `projectStatus` / `exitCodeForPhase` (exit code derives from the
 *     authoritative `phase`, NOT a lifecycle event name)
 *   - RPC error mapping and local fast-fail validation
 *   - stdout (machine JSON) vs stderr (human text) separation
 *
 * Hermetic: no LLM key, no Docker. The fixture runs in `builtin` mode and the
 * `WorkflowManager.sessionFactoryOverride` DI seam supplies an artifact-writing
 * stub session, so the pre-gate `agent` state resolves instantly and writes the
 * `draft` artifact.
 *
 * Daemon discovery: `runDaemonGateCommand` calls `discoverDaemon()` internally,
 * which reads `getWebUiStatePath()` (`$IRONCURTAIN_HOME/web-ui.json`). We point
 * `IRONCURTAIN_HOME` at a fresh temp dir per test and write a `web-ui.json` that
 * matches the daemon's `writeWebUiState` shape, so the command finds OUR server
 * and never touches the real `~/.ironcurtain`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebUiServer, type WebUiServerOptions } from '../../src/web-ui/web-ui-server.js';
import { WorkflowManager } from '../../src/workflow/workflow-manager.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { getWebUiStatePath } from '../../src/config/paths.js';
import type { ControlRequestHandler } from '../../src/daemon/control-socket.js';
import { runDaemonGateCommand } from '../../src/workflow/daemon-gate-commands.js';
import { createArtifactAwareSession, approvedResponse } from './test-helpers.js';
import type { Session, SessionOptions } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { startFakeDaemon, workflowDetail, type FakeDaemon, type FakeDaemonHandler } from '../helpers/fake-daemon-ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'test-gate-smoke', 'workflow.yaml');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    refreshLists: vi.fn(),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    startJobRun: vi.fn(),
    runJobNow: vi.fn().mockResolvedValue({}),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

interface Harness {
  readonly server: WebUiServer;
  readonly manager: WorkflowManager;
  readonly baseDir: string;
  readonly home: string;
}

let harness: Harness | undefined;
let fakeDaemon: FakeDaemon | undefined;
let originalHome: string | undefined;
/** Chunks captured from `process.stdout.write` while a command runs. */
const stdoutChunks: string[] = [];
let restoreStdout: (() => void) | undefined;

/**
 * Boots the full stack, points `IRONCURTAIN_HOME` at a fresh temp dir, and
 * writes a `web-ui.json` (matching the daemon's `writeWebUiState` shape) so
 * `discoverDaemon()` resolves to OUR server. The stub session factory writes
 * the `draft` artifact and returns an approved status block on every visit, so
 * `produce` resolves instantly and `FORCE_REVISION` can loop back.
 */
async function boot(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-home-'));
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;

  const baseDir = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-'));

  const sessionFactoryOverride: (opts: SessionOptions) => Promise<Session> = () =>
    Promise.resolve(
      createArtifactAwareSession(
        // Generous supply: one per `produce` visit (initial + each FORCE_REVISION loop).
        Array.from({ length: 8 }, () => ({ text: approvedResponse(), artifacts: ['draft'] })),
        baseDir,
      ),
    );

  const opts: WebUiServerOptions = {
    port: 0,
    host: '127.0.0.1',
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    maxConcurrentWebSessions: 3,
  };
  const server = new WebUiServer(opts);
  await server.start();

  const manager = new WorkflowManager({
    eventBus: server.getEventBus(),
    baseDirOverride: baseDir,
    sessionFactoryOverride,
  });
  server.setWorkflowManager(manager);

  // Write discovery state in the daemon's exact shape so the command finds us.
  writeFileSync(
    getWebUiStatePath(),
    JSON.stringify({ port: server.getPort(), host: '127.0.0.1', token: server.getAuthToken() }) + '\n',
    { mode: 0o600 },
  );

  return { server, manager, baseDir, home };
}

/**
 * Starts a scripted fake daemon (see `test/helpers/fake-daemon-ws.ts`) and
 * points discovery at it, for drops, lost replies and payloads the real
 * daemon cannot be made to produce on demand.
 */
async function bootFake(handler: FakeDaemonHandler): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon(handler);
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = daemon.home;
  fakeDaemon = daemon;
  return daemon;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Runs a CLI subcommand against the live server while capturing stdout. Returns
 * the exit code and the parsed single-line JSON object the command emitted (the
 * `--json` contract is one newline-terminated JSON object on stdout).
 */
async function runCommand(
  subcommand: string,
  args: string[],
): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string }> {
  stdoutChunks.length = 0;
  const exitCode = await runDaemonGateCommand(subcommand, args);
  const stdout = stdoutChunks.join('');
  const trimmed = stdout.trim();
  const json = trimmed.length > 0 ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
  return { exitCode, json, stdout };
}

/** `runCommand` that also returns what the command wrote to stderr (its human text channel). */
async function runCommandWithText(
  subcommand: string,
  args: string[],
): Promise<{ exitCode: number; json: Record<string, unknown>; stderr: string }> {
  const stderrChunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  try {
    const { exitCode, json } = await runCommand(subcommand, args);
    return { exitCode, json, stderr: stderrChunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

beforeEach(() => {
  // Capture stdout so we can assert the machine JSON and prove human text does
  // NOT leak onto stdout. stderr is left alone (human channel). The original
  // `write` is restored verbatim in `afterEach` to avoid the `any`-typed
  // overload that `mockRestore` re-derives.
  stdoutChunks.length = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  restoreStdout = () => {
    process.stdout.write = original;
  };
});

afterEach(async () => {
  restoreStdout?.();
  restoreStdout = undefined;

  if (fakeDaemon) {
    await fakeDaemon.close();
    fakeDaemon = undefined;
  }

  if (harness) {
    await harness.server.stop().catch(() => {});
    rmSync(harness.baseDir, { recursive: true, force: true });
    rmSync(harness.home, { recursive: true, force: true });
    harness = undefined;
  }

  if (originalHome === undefined) {
    delete process.env.IRONCURTAIN_HOME;
  } else {
    process.env.IRONCURTAIN_HOME = originalHome;
  }
  originalHome = undefined;
});

/** The per-raise gate id a `status`/`await` projection reports. */
function gateIdOf(json: Record<string, unknown>): string {
  const gate = json.gate as { gateId?: unknown } | undefined;
  if (typeof gate?.gateId !== 'string') throw new Error(`no gate id in ${JSON.stringify(json)}`);
  return gate.gateId;
}

/**
 * Drives a fresh workflow to its gate via the CLI: `run` then a single `await`.
 * Returns the workflow id and the gate id once `await` reports
 * `phase:'waiting_human'` (the id is what `gate --gate-id` must quote). A
 * single `await` is sufficient: the command blocks server-side until the gate
 * is raised (its internal `awaitDecisionPoint` subscribes before the initial
 * get and resolves on the `gate_raised` event), so there is no retry loop here.
 */
async function startAndAwaitGate(): Promise<{ workflowId: string; gateId: string }> {
  const run = await runCommand('run', [FIXTURE_PATH, 'Draft and review a thing', '--json']);
  expect(run.exitCode).toBe(0);
  expect(run.json.ok).toBe(true);
  const workflowId = run.json.workflowId as string;
  expect(typeof workflowId).toBe('string');

  const awaited = await runCommand('await', [workflowId, '--json']);
  expect(awaited.exitCode).toBe(0);
  expect(awaited.json.phase).toBe('waiting_human');
  return { workflowId, gateId: gateIdOf(awaited.json) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemon gate commands (command-layer integration)', () => {
  it('run resolves a relative --workspace path before sending workflows.start', async () => {
    harness = await boot();
    const cwd = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-cwd-'));
    const workspace = join(cwd, 'workspace');
    mkdirSync(workspace);
    const originalCwd = process.cwd();
    try {
      process.chdir(cwd);

      const run = await runCommand('run', [
        FIXTURE_PATH,
        'Draft from relative workspace',
        '--workspace',
        'workspace',
        '--json',
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.json.ok).toBe(true);
      const workflowId = run.json.workflowId as WorkflowId;
      const detail = harness.manager.getOrchestrator().getDetail(workflowId);

      // The workspace is validated and canonicalized (e.g. /var -> /private/var on macOS).
      expect(detail?.workspacePath).toBe(realpathSync(resolve('workspace')));
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('run rejects a --workspace that is not a directory before connecting', async () => {
    // No daemon is booted: the workspace check runs client-side BEFORE openClient,
    // so a bad --workspace must surface WORKSPACE_NOT_DIRECTORY (the fail-fast
    // ordering), not a daemon-connect error. FIXTURE_PATH is an existing file.
    const notADir = FIXTURE_PATH;
    const rejected = await runCommand('run', [
      FIXTURE_PATH,
      'Draft with a bad workspace',
      '--workspace',
      notADir,
      '--json',
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json.ok).toBe(false);
    expect(rejected.json.error).toBe('WORKSPACE_NOT_DIRECTORY');
    expect(rejected.json.path).toBe(resolve(notADir));

    // A non-existent path makes statSync throw (ENOENT); the validation must
    // catch it and still return the structured error, not crash the CLI.
    const missing = join(tmpdir(), 'ic-gate-cmd-missing-dir-xyz');
    const gone = await runCommand('run', [
      FIXTURE_PATH,
      'Draft with a missing workspace',
      '--workspace',
      missing,
      '--json',
    ]);
    expect(gone.exitCode).toBe(1);
    expect(gone.json.ok).toBe(false);
    expect(gone.json.error).toBe('WORKSPACE_NOT_DIRECTORY');
    expect(gone.json.path).toBe(resolve(missing));
  });

  it('run rejects an unsafe --workspace (home directory and its ancestors) before connecting', async () => {
    // No daemon is booted: the same validator `start -w` uses runs client-side.
    const fakeRoot = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-home-'));
    const fakeHome = join(fakeRoot, 'home', 'alice');
    mkdirSync(join(fakeHome, '.ironcurtain'), { recursive: true });
    const savedHome = process.env.HOME;
    const savedIcHome = process.env.IRONCURTAIN_HOME;
    process.env.HOME = fakeHome;
    delete process.env.IRONCURTAIN_HOME;
    try {
      for (const workspace of ['~', join(fakeRoot, 'home'), join(fakeHome, '.ironcurtain')]) {
        const rejected = await runCommand('run', [
          FIXTURE_PATH,
          'Unsafe workspace',
          '--workspace',
          workspace,
          '--json',
        ]);
        expect(rejected.exitCode).toBe(1);
        expect(rejected.json.ok).toBe(false);
        expect(rejected.json.error).toBe('WORKSPACE_UNSAFE');
        expect(typeof rejected.json.message).toBe('string');
      }
      const tilde = await runCommand('run', [FIXTURE_PATH, 'Unsafe workspace', '--workspace', '~', '--json']);
      expect(tilde.json.path).toBe(fakeHome);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedIcHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedIcHome;
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('run -> await(gate) -> show -> APPROVE -> await(completed)', async () => {
    harness = await boot();

    // (1) run: absolute fixture path resolves via resolveWorkflowPath.
    const run = await runCommand('run', [FIXTURE_PATH, 'Draft and review a thing', '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.json.ok).toBe(true);
    const workflowId = run.json.workflowId as string;
    expect(typeof workflowId).toBe('string');
    // The human-readable summary lives on stderr, never stdout: stdout is a
    // single JSON object.
    expect(run.stdout.trim().split('\n')).toHaveLength(1);

    // (2) await to gate: machine-readable gate visibility.
    const atGate = await runCommand('await', [workflowId, '--json']);
    expect(atGate.exitCode).toBe(0);
    expect(atGate.json.phase).toBe('waiting_human');
    const gate = atGate.json.gate as { stateName: string; presentedArtifacts: string[]; acceptedEvents: string[] };
    expect(gate.stateName).toBe('review');
    expect(gate.presentedArtifacts).toContain('draft');
    expect(gate.acceptedEvents).toEqual(expect.arrayContaining(['APPROVE', 'FORCE_REVISION', 'ABORT']));

    // (3) show: artifact content round-trips through the command layer.
    const show = await runCommand('show', [workflowId, '--artifact', 'draft', '--json']);
    expect(show.exitCode).toBe(0);
    expect(show.json.ok).toBe(true);
    const files = show.json.files as { path: string; content: string }[];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].content).toContain('content for draft');

    // (4) gate APPROVE, bound to the raise `await` reported, then await to terminal completed.
    const gateId = gateIdOf(atGate.json);
    const approve = await runCommand('gate', [workflowId, '--gate-id', gateId, '--event', 'APPROVE', '--json']);
    expect(approve.exitCode).toBe(0);
    expect(approve.json.ok).toBe(true);
    expect(approve.json.event).toBe('APPROVE');
    expect(approve.json.gateId).toBe(gateId);

    const done = await runCommand('await', [workflowId, '--json']);
    expect(done.exitCode).toBe(0);
    expect(done.json.phase).toBe('completed');
  }, 30_000);

  it('gate ABORT -> failed terminal event lets await report phase:aborted with exit 3', async () => {
    harness = await boot();

    const { workflowId, gateId } = await startAndAwaitGate();

    // A gate-ABORT routes to the `aborted` terminal and emits the terminal
    // `workflow.failed` event. The `await` follow-up `workflows.get` remains
    // authoritative: phase is `aborted`, and the exit code derives from that.
    const abort = await runCommand('gate', [workflowId, '--gate-id', gateId, '--event', 'ABORT', '--json']);
    expect(abort.exitCode).toBe(0);
    expect(abort.json.ok).toBe(true);

    const terminal = await runCommand('await', [workflowId, '--json']);
    expect(terminal.json.phase).toBe('aborted');
    // The critical assertion: exit 3 (EXIT_TERMINAL_FAILURE) from the phase,
    // `workflow.failed` represents both failed and aborted terminal phases.
    expect(terminal.exitCode).toBe(3);
  }, 30_000);

  it('show fetches artifact files one by one within its inline budget; --file reads an omitted one', async () => {
    harness = await boot();
    const { workflowId } = await startAndAwaitGate();
    const workspace = harness.manager.getOrchestrator().getDetail(workflowId as WorkflowId)?.workspacePath;
    expect(workspace).toBeDefined();
    const draftDir = join(workspace ?? '', '.workflow', 'draft');
    // 5 x 1 MB: more than the 4 MiB `show` inlines, and far more than one
    // daemon reply used to carry before the socket was closed.
    for (let i = 0; i < 5; i++) writeFileSync(join(draftDir, `part-${i}.txt`), Buffer.alloc(1_000_000, 0x61 + i));

    // The text channel (stderr) echoes every inlined file; keep it out of the test output.
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => true;
    try {
      const show = await runCommand('show', [workflowId, '--artifact', 'draft', '--json']);
      expect(show.exitCode).toBe(0);
      expect(show.json).toMatchObject({ ok: true, truncated: false });
      const files = show.json.files as { path: string; size: number; content?: string; omitted?: boolean }[];
      expect(files.map((f) => f.path)).toEqual([
        'draft.md',
        'part-0.txt',
        'part-1.txt',
        'part-2.txt',
        'part-3.txt',
        'part-4.txt',
      ]);
      expect(files[0].content).toContain('content for draft');
      const inlined = files.filter((f) => typeof f.content === 'string');
      expect(inlined.reduce((sum, f) => sum + f.size, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
      const omitted = files.filter((f) => f.omitted === true);
      expect(omitted.map((f) => f.path)).toEqual(['part-4.txt']);
      expect(omitted[0].content).toBeUndefined();

      const one = await runCommand('show', [workflowId, '--artifact', 'draft', '--file', 'part-4.txt', '--json']);
      expect(one.exitCode).toBe(0);
      expect(one.json).toMatchObject({ ok: true, path: 'part-4.txt', language: 'text' });
      expect(one.json.content).toBe('e'.repeat(1_000_000));

      const missing = await runCommand('show', [workflowId, '--artifact', 'draft', '--file', 'nope.txt', '--json']);
      expect(missing.exitCode).toBe(1);
      expect(missing.json).toMatchObject({ ok: false, error: 'INVALID_PARAMS', message: 'File not found' });
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  }, 30_000);

  it('show charges its inline budget with the text returned, not the listed size', async () => {
    harness = await boot();
    const { workflowId } = await startAndAwaitGate();
    const workspace = harness.manager.getOrchestrator().getDetail(workflowId as WorkflowId)?.workspacePath;
    expect(workspace).toBeDefined();
    const draftDir = join(workspace ?? '', '.workflow', 'draft');
    // Listed at 1 MB each, but every 0xff byte comes back as a three-byte
    // U+FFFD: charging listed sizes would inline four of them (~12 MB).
    for (let i = 0; i < 4; i++) writeFileSync(join(draftDir, `part-${i}.txt`), Buffer.alloc(1_000_000, 0xff));

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => true;
    try {
      const show = await runCommand('show', [workflowId, '--artifact', 'draft', '--json']);
      expect(show.exitCode).toBe(0);
      const files = show.json.files as { path: string; size: number; content?: string; omitted?: boolean }[];
      const inlinedBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content ?? '', 'utf8'), 0);
      expect(inlinedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(files.find((f) => f.path === 'part-0.txt')?.content).toBe('�'.repeat(1_000_000));
      expect(files.filter((f) => f.omitted === true).map((f) => f.path)).toEqual([
        'part-1.txt',
        'part-2.txt',
        'part-3.txt',
      ]);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  }, 30_000);

  it('resume routes through the daemon and rejects standalone-only flags', async () => {
    harness = await boot();
    const { workflowId, gateId } = await startAndAwaitGate();

    const active = await runCommand('resume', [workflowId, '--json']);
    expect(active.exitCode).toBe(1);
    expect(active.json.error).toBe('WORKFLOW_ALREADY_ACTIVE');

    await runCommand('gate', [workflowId, '--gate-id', gateId, '--event', 'ABORT', '--json']);
    await runCommand('await', [workflowId, '--json']);
    const resumed = await runCommand('resume', [workflowId, '--json']);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.json).toMatchObject({ ok: true, workflowId, phase: 'running' });

    const invalid = await runCommand('resume', [workflowId, '--model', 'anthropic:test', '--json']);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.json.error).toBe('INVALID_USAGE');
  }, 30_000);

  it('resume reports an unreadable path instead of treating it as a workflow ID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ic-resume-target-'));
    const loop = join(dir, 'loop');
    symlinkSync('loop', loop);
    try {
      const result = await runCommand('resume', [loop, '--json']);
      expect(result.exitCode).toBe(2);
      expect(result.json.error).toBe('INVALID_PARAMS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate FORCE_REVISION with no --prompt fast-fails locally: exit 2, INVALID_PARAMS', async () => {
    harness = await boot();

    // Local fast-fail happens BEFORE any RPC, so no workflow needs to exist.
    const bad = await runCommand('gate', [
      'some-workflow-id',
      '--gate-id',
      'some-gate-id',
      '--event',
      'FORCE_REVISION',
      '--json',
    ]);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_PARAMS');
  }, 30_000);

  it('gate without --gate-id fast-fails locally: exit 2, INVALID_PARAMS', async () => {
    // The decision must name the raise it was made against; without it no
    // RPC is sent, so no daemon is needed.
    const bad = await runCommand('gate', ['some-workflow-id', '--event', 'APPROVE', '--json']);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_PARAMS');
    expect(String(bad.json.message)).toContain('--gate-id');
  });

  it('gate with a stale --gate-id is refused with GATE_MISMATCH and the run keeps waiting at the current gate', async () => {
    harness = await boot();
    const { workflowId, gateId: visit1 } = await startAndAwaitGate();

    // FORCE_REVISION loops back to `produce`; `review` is raised again under a new id.
    const revise = await runCommand('gate', [
      workflowId,
      '--gate-id',
      visit1,
      '--event',
      'FORCE_REVISION',
      '--prompt',
      'tighten it',
      '--json',
    ]);
    expect(revise.exitCode).toBe(0);

    const second = await runCommand('await', [workflowId, '--json']);
    expect(second.json.phase).toBe('waiting_human');
    const visit2 = gateIdOf(second.json);
    expect(visit2).not.toBe(visit1);

    // An approval copied from the first visit must not land on the second.
    const stale = await runCommand('gate', [workflowId, '--gate-id', visit1, '--event', 'APPROVE', '--json']);
    expect(stale.exitCode).toBe(1);
    expect(stale.json.ok).toBe(false);
    expect(stale.json.error).toBe('GATE_MISMATCH');
    // The refusal does not hand out the live id: the agent has to re-read the gate.
    expect(String(stale.json.message)).not.toContain(visit2);

    const still = await runCommandWithText('status', [workflowId, '--json']);
    expect(still.json.phase).toBe('waiting_human');
    expect(gateIdOf(still.json)).toBe(visit2);
    // Text mode shows the id `gate --gate-id` must quote, too.
    expect(still.stderr).toContain(`gate id: ${visit2}`);

    const approve = await runCommand('gate', [workflowId, '--gate-id', visit2, '--event', 'APPROVE', '--json']);
    expect(approve.exitCode).toBe(0);
    const done = await runCommand('await', [workflowId, '--json']);
    expect(done.json.phase).toBe('completed');
  }, 30_000);

  it('gate with an event the gate does not accept is refused with EVENT_NOT_ACCEPTED', async () => {
    harness = await boot();
    const { workflowId, gateId } = await startAndAwaitGate();

    // The fixture's `review` gate transitions on APPROVE / FORCE_REVISION / ABORT only.
    const replan = await runCommand('gate', [
      workflowId,
      '--gate-id',
      gateId,
      '--event',
      'REPLAN',
      '--prompt',
      'start over',
      '--json',
    ]);
    expect(replan.exitCode).toBe(1);
    expect(replan.json.ok).toBe(false);
    expect(replan.json.error).toBe('EVENT_NOT_ACCEPTED');

    const still = await runCommand('status', [workflowId, '--json']);
    expect(still.json.phase).toBe('waiting_human');
    expect(gateIdOf(still.json)).toBe(gateId);
  }, 30_000);

  it('gate with unknown --event fast-fails locally: exit 2, INVALID_EVENT', async () => {
    harness = await boot();

    const bad = await runCommand('gate', [
      'some-workflow-id',
      '--gate-id',
      'some-gate-id',
      '--event',
      'BOGUS',
      '--json',
    ]);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_EVENT');
  }, 30_000);

  it('unknown flag honors the JSON/exit-code contract instead of a bare exit 1', async () => {
    // A typo'd flag is caught during arg parsing — BEFORE any daemon connect —
    // so no server is booted. The failure must NOT escape the contract via a
    // stderr-only `process.exit(1)`: with `--json` it is a single structured
    // JSON object on stdout with the usage exit code (2), so an agent driving
    // the CLI can parse it.
    const bad = await runCommand('run', [FIXTURE_PATH, 'Draft a thing', '--jsno', '--json']);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_USAGE');
    expect(typeof bad.json.message).toBe('string');

    // Without `--json` the failure stays off stdout entirely (human stderr only),
    // and the exit code is still the usage code (2), never the generic 1.
    const quiet = await runCommand('status', ['some-id', '--bogus']);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.stdout.trim()).toBe('');
  });

  it('does not treat a `--json` consumed as an option value as the JSON flag', async () => {
    // Edge case: `--json` is the VALUE of the value-taking `--workspace` option,
    // not a flag. When a later bad flag (`--bogus`) makes strict parsing fail,
    // the channel must be chosen by a real parse — NOT a literal scan that would
    // see `--json` in argv and wrongly emit machine JSON to stdout. The caller
    // never requested JSON mode, so the failure stays on stderr (stdout empty),
    // still with the usage exit code.
    const masked = await runCommand('run', [FIXTURE_PATH, 'Draft a thing', '--workspace', '--json', '--bogus']);
    expect(masked.exitCode).toBe(2);
    expect(masked.stdout.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Transport failures, usage errors and terminal-safe text (WP-52)
// ---------------------------------------------------------------------------

const ESC = '\u001b';
/** Raw terminal controls that must never reach the terminal from agent-derived text. */
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u001b\u0007\u009b\u202e\r]/u;

/** Replies `running` to every status query and refuses everything else. */
const runningDaemon: FakeDaemonHandler = (request) =>
  request.method === 'workflows.get'
    ? { payload: workflowDetail(String(request.params.workflowId), 'running') }
    : { error: { code: 'METHOD_NOT_FOUND', message: request.method } };

describe('daemon gate commands: disconnects, usage errors and terminal-safe output', () => {
  it('await exits 1 with DAEMON_DISCONNECTED as soon as the daemon dies mid-wait', async () => {
    const daemon = await bootFake(runningDaemon);
    const started = Date.now();
    const pending = runCommand('await', ['wf-1', '--timeout', '60', '--json']);

    await daemon.waitForRequests(1);
    await delay(100);
    daemon.dropConnections();
    const result = await pending;

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: 'DAEMON_DISCONNECTED', workflowId: 'wf-1' });
    // Not a timeout, and no made-up phase: the agent is sent to `status`.
    expect(result.json.phase).toBeUndefined();
    expect(String(result.json.hint)).toContain('ironcurtain workflow status wf-1 --json');
    expect(String(result.json.hint)).toContain('interrupted');
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('await reports DAEMON_DISCONNECTED when the drop interrupts its status query', async () => {
    await bootFake((request) => (request.method === 'workflows.get' ? 'drop' : runningDaemon(request)));

    const result = await runCommand('await', ['wf-1', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: 'DAEMON_DISCONNECTED', workflowId: 'wf-1' });
  });

  it('await caps a --timeout beyond the timer limit instead of timing out at once', async () => {
    const daemon = await bootFake(runningDaemon);
    let settled = false;
    const pending = runCommand('await', ['wf-1', '--timeout', '99999999', '--json']).finally(() => {
      settled = true;
    });

    await daemon.waitForRequests(1);
    // An unclamped delay above 2^31-1 ms fires after 1 ms (AWAIT_TIMEOUT at once).
    await delay(500);
    expect(settled).toBe(false);

    daemon.dropConnections();
    const result = await pending;
    expect(result.json.error).toBe('DAEMON_DISCONNECTED');
  });

  it('AWAIT_TIMEOUT exits 4 and reports no phase it does not know', async () => {
    await bootFake(runningDaemon);

    const result = await runCommand('await', ['wf-1', '--timeout', '0.2', '--json']);

    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({ ok: false, error: 'AWAIT_TIMEOUT', workflowId: 'wf-1', timeoutSec: 0.2 });
    expect(result.json).not.toHaveProperty('phase');
  });

  it('await resolves on a gate event and reports the authoritative phase', async () => {
    let phase = 'running';
    const daemon = await bootFake((request) =>
      request.method === 'workflows.get'
        ? { payload: workflowDetail('wf-1', phase) }
        : { error: { code: 'METHOD_NOT_FOUND', message: request.method } },
    );
    const pending = runCommand('await', ['wf-1', '--json']);
    await daemon.waitForRequests(1);
    phase = 'failed';
    daemon.pushEvent('workflow.failed', { workflowId: 'wf-1' });

    const result = await pending;
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({ ok: true, workflowId: 'wf-1', phase: 'failed' });
  });

  it('gate reports a lost reply as DAEMON_DISCONNECTED with an unknown effect and a status-first hint', async () => {
    await bootFake((request) => (request.method === 'workflows.resolveGate' ? 'drop' : runningDaemon(request)));

    const result = await runCommand('gate', ['wf-1', '--gate-id', 'g-1', '--event', 'APPROVE', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      error: 'DAEMON_DISCONNECTED',
      workflowId: 'wf-1',
      gateId: 'g-1',
      event: 'APPROVE',
      effect: 'unknown',
    });
    expect(String(result.json.hint)).toContain('may already have been applied');
    expect(String(result.json.hint)).toContain('ironcurtain workflow status wf-1 --json');
    // stdout is still exactly one JSON object.
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('escalation reports a lost reply as DAEMON_DISCONNECTED with an unknown effect and a status-first hint', async () => {
    await bootFake((request) => (request.method === 'workflows.resolveEscalation' ? 'drop' : runningDaemon(request)));

    const result = await runCommand('escalation', ['wf-1', '--approve', '--escalation-id', 'esc-1', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      error: 'DAEMON_DISCONNECTED',
      workflowId: 'wf-1',
      escalationId: 'esc-1',
      decision: 'approved',
      effect: 'unknown',
    });
    expect(String(result.json.hint)).toContain('may already have been applied');
    expect(String(result.json.hint)).toContain('ironcurtain workflow status wf-1 --json');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('an unexpected failure is one CLI_INTERNAL_ERROR object, not a stack trace', async () => {
    // A malformed reply (no `files`) makes the command itself throw.
    await bootFake((request) => (request.method === 'workflows.artifacts' ? { payload: {} } : 'drop'));

    const result = await runCommand('show', ['wf-1', '--artifact', 'spec', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.json).toMatchObject({ ok: false, error: 'CLI_INTERNAL_ERROR', workflowId: 'wf-1' });
    // The daemon answered: a read-only command must not be told to retry once
    // the daemon is reachable (it would fail the same way, in a loop).
    expect(result.json).not.toHaveProperty('effect');
    expect(String(result.json.hint)).toContain('retrying against the same daemon will fail the same way');
    expect(String(result.json.hint)).not.toContain('Retry once the daemon is reachable');
  });

  it('await reports a reply it cannot handle as CLI_INTERNAL_ERROR, not as a lost connection', async () => {
    // A gate whose acceptedEvents is not a list (a daemon of another version).
    await bootFake((request) =>
      request.method === 'workflows.get'
        ? {
            payload: workflowDetail('wf-1', 'waiting_human', {
              gate: { gateId: 'g-1', workflowId: 'wf-1', stateName: 'review', acceptedEvents: 'APPROVE' },
            }),
          }
        : { error: { code: 'METHOD_NOT_FOUND', message: request.method } },
    );

    const result = await runCommand('await', ['wf-1', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.json).toMatchObject({ ok: false, error: 'CLI_INTERNAL_ERROR', workflowId: 'wf-1' });
    expect(String(result.json.hint)).toContain('Nothing was changed');
    expect(String(result.json.hint)).not.toContain('stopped answering');
  });

  it('a mutating command that fails on the reply keeps effect unknown and its check-first hint', async () => {
    // `workflows.start` accepted, but the reply carries no payload to read the id from.
    await bootFake((request) =>
      request.method === 'workflows.start'
        ? { payload: null }
        : { error: { code: 'METHOD_NOT_FOUND', message: request.method } },
    );

    const result = await runCommand('run', [FIXTURE_PATH, 'task', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.json).toMatchObject({ ok: false, error: 'CLI_INTERNAL_ERROR', effect: 'unknown' });
    expect(String(result.json.hint)).toContain('may have started the workflow');
  });

  it('read-only commands report a lost reply as safe to retry', async () => {
    await bootFake(() => 'drop');

    const status = await runCommand('status', ['wf-1', '--json']);
    expect(status.exitCode).toBe(1);
    expect(status.json).toMatchObject({ ok: false, error: 'DAEMON_DISCONNECTED', workflowId: 'wf-1' });
    expect(status.json).not.toHaveProperty('effect');

    const show = await runCommand('show', ['wf-1', '--artifact', 'spec', '--json']);
    expect(show.json).toMatchObject({ ok: false, error: 'DAEMON_DISCONNECTED', artifactName: 'spec' });
  });

  it.each([
    ['await', ['--json']],
    ['await', ['wf-1', '--timeout', 'soon', '--json']],
    ['await', ['wf-1', '--timeout', '0', '--json']],
    ['status', ['--json']],
    ['gate', ['--json']],
    ['show', ['wf-1', '--json']],
    ['run', ['--json']],
    ['resume', ['--json']],
    ['escalation', ['--deny', '--json']],
  ])('%s %j is an INVALID_USAGE JSON error with exit 2', async (subcommand, args) => {
    const result = await runCommandWithText(subcommand, args);

    expect(result.exitCode).toBe(2);
    expect(result.json).toMatchObject({ ok: false, error: 'INVALID_USAGE' });
    expect(String(result.json.usage)).toContain(`ironcurtain workflow ${subcommand}`);
    expect(result.stderr).toContain('Usage: ironcurtain workflow');
  });

  it('a usage error without --json keeps stdout empty', async () => {
    const result = await runCommandWithText('await', []);
    expect(result.exitCode).toBe(2);
    expect(result.json).toEqual({});
    expect(result.stderr).toContain('INVALID_USAGE');
  });

  it('show prints artifact control characters as visible escapes, and only once', async () => {
    const content = `# Verdict: FAIL${ESC}[1A${ESC}[2K# Verdict: PASS\n${ESC}]52;c;cm0gLXJmIH4K\u0007\u009b31m\u202etxt.exe\ttab\r\nend`;
    const path = `spec${ESC}[31m.md`;
    const size = Buffer.byteLength(content, 'utf8');
    await bootFake((request) => {
      if (request.method === 'workflows.artifacts') return { payload: { files: [{ path, size }], truncated: false } };
      if (request.method === 'workflows.artifactFile' && request.params.path === path) {
        return { payload: { content, language: 'markdown' } };
      }
      return { error: { code: 'METHOD_NOT_FOUND', message: request.method } };
    });

    const text = await runCommandWithText('show', ['wf-1', '--artifact', 'spec']);
    expect(text.exitCode).toBe(0);
    expect(text.json).toEqual({});
    expect(text.stderr).toContain(`--- spec\\u001b[31m.md (${size} bytes) ---`);
    expect(text.stderr).toContain('# Verdict: FAIL\\u001b[1A\\u001b[2K# Verdict: PASS\n');
    expect(text.stderr).toContain('\\u001b]52;c;cm0gLXJmIH4K\\u0007\\u009b31m\\u202etxt.exe\ttab\nend');
    expect(text.stderr).not.toMatch(RAW_CONTROL);

    const json = await runCommandWithText('show', ['wf-1', '--artifact', 'spec', '--json']);
    expect(json.exitCode).toBe(0);
    const files = json.json.files as Array<{ path: string; content: string }>;
    // The JSON value is the exact content; its text carries the controls as escapes.
    expect(files[0].path).toBe(path);
    expect(files[0].content).toBe(content);
    expect(stdoutChunks.join('')).not.toMatch(RAW_CONTROL);
    // stderr gets a one-line summary, not the content a second time.
    expect(json.stderr).toContain('Artifact spec: 1 file(s); content is in the JSON output.');
    expect(json.stderr).not.toContain('Verdict');
    expect(json.stderr).not.toMatch(RAW_CONTROL);

    // The same holds for a single file read with --file.
    const one = await runCommandWithText('show', ['wf-1', '--artifact', 'spec', '--file', path, '--json']);
    expect(one.exitCode).toBe(0);
    expect(one.json).toMatchObject({ ok: true, path, content });
    expect(stdoutChunks.join('')).not.toMatch(RAW_CONTROL);
    expect(one.stderr).not.toContain('Verdict');
    expect(one.stderr).not.toMatch(RAW_CONTROL);
  });

  it('status text escapes agent- and definition-derived names', async () => {
    await bootFake((request) =>
      request.method === 'workflows.get'
        ? {
            payload: workflowDetail('wf-1', 'waiting_human', {
              gate: {
                gateId: 'g-1',
                workflowId: 'wf-1',
                stateName: `review${ESC}]0;owned\u0007`,
                acceptedEvents: ['APPROVE'],
                presentedArtifacts: [`spec${ESC}[2J`],
                summary: `Waiting (error: ${ESC}[31mboom)`,
              },
            }),
          }
        : { error: { code: 'METHOD_NOT_FOUND', message: request.method } },
    );

    const result = await runCommandWithText('status', ['wf-1']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('gate "review\\u001b]0;owned\\u0007"');
    expect(result.stderr).toContain('artifacts: spec\\u001b[2J');
    expect(result.stderr).not.toMatch(RAW_CONTROL);
  });
});
