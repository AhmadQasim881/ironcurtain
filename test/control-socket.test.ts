import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ControlSocketServer,
  MAX_CONTROL_REQUEST_BYTES,
  isDaemonRunning,
  parseRecompileJobResult,
  parseRunJobAccepted,
  sendControlRequest,
  waitForDaemonJobRun,
  type ControlRequestHandler,
  type ControlRequestResult,
  type ControlResponse,
  type DaemonStatus,
  type DaemonStatusDto,
  type JobListEntry,
  type JobRunStart,
  type RecompileJobResultDto,
  type RefreshListsRequest,
  type RefreshListsResultDto,
  type RunJobStatus,
} from '../src/daemon/control-socket.js';
import { JobAlreadyRunningError, type JobDefinition, type RunRecord } from '../src/cron/types.js';
import type { JobId } from '../src/cron/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestSocketPath(dir: string): string {
  return resolve(dir, 'test-daemon.sock');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  let rejectFn: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function createMockHandler(): ControlRequestHandler & {
  calls: Array<{ method: string; args: unknown[] }>;
  mockListJobs: JobListEntry[];
  mockRunRecord: RunRecord;
  /** What recompileJob resolves with (the servers the recompiled policy left out). */
  mockRecompileResult: RecompileJobResultDto;
  /** When set, startJobRun hands out this completion instead of an already-finished run. */
  nextRunCompletion: Promise<RunRecord> | undefined;
} {
  const handler = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    mockListJobs: [] as JobListEntry[],
    mockRunRecord: {
      startedAt: '2026-03-05T09:00:00Z',
      completedAt: '2026-03-05T09:01:00Z',
      outcome: { kind: 'success' as const },
      budget: { totalTokens: 1000, stepCount: 5, elapsedSeconds: 60, estimatedCostUsd: 0.05 },
      summary: 'Test run completed.',
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
    } as RunRecord,
    mockRecompileResult: { failedServers: [] } as RecompileJobResultDto,
    nextRunCompletion: undefined as Promise<RunRecord> | undefined,
    getStatus(): DaemonStatus {
      handler.calls.push({ method: 'getStatus', args: [] });
      return {
        uptimeSeconds: 120,
        jobs: { total: 2, enabled: 1, running: 0, failing: 1 },
        failingJobs: [{ jobId: 'broken-job', name: 'Broken', consecutiveFailures: 3 }],
        signalConnected: true,
        nextFireTime: new Date('2026-03-05T10:00:00Z'),
      };
    },
    async removeJob(jobId: string) {
      handler.calls.push({ method: 'removeJob', args: [jobId] });
    },
    async enableJob(jobId: string) {
      handler.calls.push({ method: 'enableJob', args: [jobId] });
    },
    async disableJob(jobId: string) {
      handler.calls.push({ method: 'disableJob', args: [jobId] });
    },
    async recompileJob(jobId: string): Promise<RecompileJobResultDto> {
      handler.calls.push({ method: 'recompileJob', args: [jobId] });
      return handler.mockRecompileResult;
    },
    async refreshLists(request: RefreshListsRequest): Promise<RefreshListsResultDto> {
      handler.calls.push({ method: 'refreshLists', args: [request] });
      return {
        target: `${request.target.kind} "${request.target.name}"`,
        outputDir: '/out',
        refreshed: ['repos'],
        skipped: [],
      };
    },
    async reloadJob(jobId: string) {
      handler.calls.push({ method: 'reloadJob', args: [jobId] });
    },
    startJobRun(jobId: string): JobRunStart {
      handler.calls.push({ method: 'startJobRun', args: [jobId] });
      return { completion: handler.nextRunCompletion ?? Promise.resolve(handler.mockRunRecord) };
    },
    async runJobNow(jobId: string): Promise<RunRecord> {
      handler.calls.push({ method: 'runJobNow', args: [jobId] });
      return handler.mockRunRecord;
    },
    listJobs() {
      handler.calls.push({ method: 'listJobs', args: [] });
      return handler.mockListJobs;
    },
  };
  return handler;
}

function createTestJob(id: string = 'test-job'): JobDefinition {
  return {
    id: id as JobId,
    name: 'Test Job',
    schedule: '0 9 * * *',
    taskDescription: 'Do the thing',
    taskConstitution: 'Allow doing the thing',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

/** The daemon's response; fails the test for an unreachable or failed exchange. */
function responseOf(result: ControlRequestResult): ControlResponse {
  if (result.kind !== 'response') throw new Error(`expected a response, got ${result.kind}: ${result.reason}`);
  return result.response;
}

function okData(result: ControlRequestResult): unknown {
  const response = responseOf(result);
  if (!response.ok) throw new Error(`expected ok, got error: ${response.error}`);
  return response.data;
}

function errorOf(result: ControlRequestResult): string {
  const response = responseOf(result);
  if (response.ok) throw new Error('expected an error response');
  return response.error;
}

function startRawServer(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  return new Promise((res, rej) => {
    const server = createServer((socket) => {
      socket.on('error', () => {}); // ECONNRESET when a client gives up
      onConnection(socket);
      // Keep reading so the client's FIN is seen and close() can complete.
      if (socket.listenerCount('data') === 0) socket.resume();
    });
    server.once('error', rej);
    server.listen(path, () => res(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

/**
 * Leaves a socket file nobody listens on, as a crashed daemon does (its
 * connect fails with ECONNREFUSED).
 */
async function makeStaleSocket(path: string): Promise<void> {
  const bindPath = `${path}.stale-bind`;
  const server = await startRawServer(bindPath, (socket) => socket.destroy());
  renameSync(bindPath, path);
  await closeServer(server); // removes only the (already moved) bind path
  expect(lstatSync(path).isSocket()).toBe(true);
}

interface RawClient {
  readonly socket: Socket;
  /** Everything the server sent, once the connection has closed. */
  readonly received: Promise<string>;
}

function connectRaw(path: string): Promise<RawClient> {
  return new Promise((res, rej) => {
    const socket = createConnection(path);
    let data = '';
    const received = new Promise<string>((done) => {
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      socket.on('close', () => done(data));
    });
    socket.once('connect', () => {
      // EPIPE/ECONNRESET once the server has closed the connection.
      socket.on('error', () => {});
      res({ socket, received });
    });
    socket.once('error', rej);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlSocketServer', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlSocketServer;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
    server = new ControlSocketServer(handler, socketPath);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and stops cleanly', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);

    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('responds to ping', async () => {
    await server.start();
    const result = await sendControlRequest({ command: 'ping' }, { socketPath });
    expect(okData(result)).toEqual({ status: 'running' });
  });

  it('stop is idempotent', async () => {
    await server.start();
    await server.stop();
    await server.stop(); // should not throw
  });

  it('stop is safe when never started', async () => {
    await server.stop(); // should not throw
  });

  it('creates the socket 0600 in a directory it makes owner-only, leaving no temporary file', async () => {
    const dir = resolve(tmpDir, 'home');
    mkdirSync(dir);
    chmodSync(dir, 0o755); // an IronCurtain home made before homes were private
    const path = resolve(dir, 'daemon.sock');
    const homeServer = new ControlSocketServer(handler, path);
    await homeServer.start();
    try {
      const socketStats = lstatSync(path);
      expect(socketStats.isSocket()).toBe(true);
      expect(socketStats.mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readdirSync(dir)).toEqual(['daemon.sock']);
      expect(okData(await sendControlRequest({ command: 'ping' }, { socketPath: path }))).toEqual({
        status: 'running',
      });
    } finally {
      await homeServer.stop();
    }
  });

  it('refuses to start while another server is listening on the path and leaves it reachable', async () => {
    await server.start();
    const second = new ControlSocketServer(createMockHandler(), socketPath);
    await expect(second.start()).rejects.toThrow(/already listening/);
    expect(await isDaemonRunning(socketPath)).toBe(true);
    await second.stop();
    expect(existsSync(socketPath)).toBe(true);
  });

  it('replaces a stale socket left by a crashed daemon', async () => {
    await makeStaleSocket(socketPath);
    await server.start();
    expect(await isDaemonRunning(socketPath)).toBe(true);
  });

  it('removes stale socket file and starts successfully', async () => {
    // Create a stale socket file (just a regular file, no one listening)
    writeFileSync(socketPath, 'stale');
    expect(existsSync(socketPath)).toBe(true);

    await server.start();
    expect(await isDaemonRunning(socketPath)).toBe(true);
  });

  it('binds a socket path close to the sun_path limit (the temporary name is no longer)', async () => {
    // 100 bytes fits macOS (104) and Linux (108); a longer temporary bind
    // name (for example "<path>.<8 hex>.tmp") would not.
    const prefix = resolve(tmpDir, 'p');
    const suffix = '/daemon.sock';
    const padding = 100 - prefix.length - suffix.length;
    if (padding < 1) return; // the temporary directory itself is too long here
    const dir = prefix + 'x'.repeat(padding);
    mkdirSync(dir);
    const path = dir + suffix;
    expect(Buffer.byteLength(path)).toBe(100);

    const nearLimit = new ControlSocketServer(handler, path);
    await nearLimit.start();
    try {
      expect(await isDaemonRunning(path)).toBe(true);
      expect(readdirSync(dir)).toEqual(['daemon.sock']);
    } finally {
      await nearLimit.stop();
    }
  });

  it('fails to start when the socket path cannot be taken, leaving nothing behind', async () => {
    mkdirSync(socketPath);
    await expect(server.start()).rejects.toThrow();
    expect(readdirSync(tmpDir)).toEqual(['test-daemon.sock']);
    expect(lstatSync(socketPath).isDirectory()).toBe(true);
  });

  it('stop() leaves a socket that another server has since put at the path', async () => {
    await server.start();
    // Something else replaces the file (the daemon lock normally prevents this).
    const otherBind = `${socketPath}.other`;
    const other = await startRawServer(otherBind, (socket) => socket.end('{"ok":true}\n'));
    renameSync(otherBind, socketPath);
    try {
      await server.stop();
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(responseOf(await sendControlRequest({ command: 'ping' }, { socketPath })).ok).toBe(true);
    } finally {
      await closeServer(other);
    }
  });
});

describe('isDaemonRunning', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no socket file exists', async () => {
    const result = await isDaemonRunning(socketPath);
    expect(result).toBe(false);
  });

  it('returns true when daemon is running', async () => {
    const handler = createMockHandler();
    const server = new ControlSocketServer(handler, socketPath);
    await server.start();

    try {
      const result = await isDaemonRunning(socketPath);
      expect(result).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('sendControlRequest', () => {
  let tmpDir: string;
  let socketPath: string;
  const servers: Array<{ stop(): Promise<void> }> = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function rawServer(onConnection: (socket: Socket) => void): Promise<void> {
    const server = await startRawServer(socketPath, onConnection);
    servers.push({ stop: () => closeServer(server) });
  }

  it('is unreachable when no socket file exists', async () => {
    const result = await sendControlRequest({ command: 'ping' }, { socketPath });
    expect(result.kind).toBe('unreachable');
  });

  it('is unreachable when only a stale socket file is left', async () => {
    await makeStaleSocket(socketPath);
    const result = await sendControlRequest({ command: 'ping' }, { socketPath });
    expect(result.kind).toBe('unreachable');
  });

  it('returns the response of a handler slower than the 2 s connect timeout', async () => {
    const handler = createMockHandler();
    handler.recompileJob = async () => {
      await delay(2_500);
      return { failedServers: [] };
    };
    const server = new ControlSocketServer(handler, socketPath);
    await server.start();
    servers.push(server);

    const startedAt = Date.now();
    const result = await sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, { socketPath });
    expect(result).toEqual({ kind: 'response', response: { ok: true, data: { failedServers: [] } } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_400);
  });

  it('reports a connection the daemon drops after taking the request as a failure, not as unreachable', async () => {
    await rawServer((socket) => socket.once('data', () => socket.destroy()));
    const result = await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath });
    // FIN or ECONNRESET, depending on timing; either way a failure, never "no daemon".
    expect(result.kind).toBe('failed');
  });

  it('reports a daemon that closes its end without answering as a failure', async () => {
    await rawServer((socket) => socket.once('data', () => socket.end()));
    const result = await sendControlRequest({ command: 'ping' }, { socketPath });
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/without answering/) });
  });

  it('reports a malformed response as a failure', async () => {
    await rawServer((socket) => socket.once('data', () => socket.end('not json\n')));
    expect((await sendControlRequest({ command: 'ping' }, { socketPath })).kind).toBe('failed');
  });

  it('reports a daemon that takes the request and never answers as a failure once the response timeout passes', async () => {
    await rawServer(() => {
      // Accept the connection, never answer.
    });
    const result = await sendControlRequest({ command: 'ping' }, { socketPath, responseTimeoutMs: 200 });
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/did not answer/) });
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const reply = Buffer.from(JSON.stringify({ ok: true, data: 'naïve café ✓' }) + '\n', 'utf8');
    const split = reply.indexOf(Buffer.from('✓', 'utf8')) + 1; // inside the 3-byte sequence
    await rawServer((socket) =>
      socket.once('data', () => {
        socket.write(reply.subarray(0, split));
        setTimeout(() => socket.end(reply.subarray(split)), 20);
      }),
    );
    expect(okData(await sendControlRequest({ command: 'ping' }, { socketPath }))).toBe('naïve café ✓');
  });
});

describe('Control socket commands', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlSocketServer;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
    server = new ControlSocketServer(handler, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards status and serializes Date to ISO string', async () => {
    const result = await sendControlRequest({ command: 'status' }, { socketPath });
    expect(handler.calls).toEqual([{ method: 'getStatus', args: [] }]);

    const data = okData(result) as DaemonStatusDto;
    expect(data.uptimeSeconds).toBe(120);
    expect(data.jobs).toEqual({ total: 2, enabled: 1, running: 0, failing: 1 });
    expect(data.failingJobs).toEqual([{ jobId: 'broken-job', name: 'Broken', consecutiveFailures: 3 }]);
    expect(data.signalConnected).toBe(true);
    expect(data.nextFireTime).toBe('2026-03-05T10:00:00.000Z');
  });

  it('forwards remove-job to handler', async () => {
    const result = await sendControlRequest({ command: 'remove-job', jobId: 'my-job' }, { socketPath });
    expect(responseOf(result).ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'removeJob', args: ['my-job'] }]);
  });

  it('forwards enable-job to handler', async () => {
    const result = await sendControlRequest({ command: 'enable-job', jobId: 'my-job' }, { socketPath });
    expect(responseOf(result).ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'enableJob', args: ['my-job'] }]);
  });

  it('forwards disable-job to handler', async () => {
    const result = await sendControlRequest({ command: 'disable-job', jobId: 'my-job' }, { socketPath });
    expect(responseOf(result).ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'disableJob', args: ['my-job'] }]);
  });

  it('forwards recompile-job to handler and replies with the servers the policy left out', async () => {
    handler.mockRecompileResult = { failedServers: ['git'] };
    const result = await sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, { socketPath });
    expect(okData(result)).toEqual({ failedServers: ['git'] });
    expect(handler.calls).toEqual([{ method: 'recompileJob', args: ['my-job'] }]);
  });

  it('reads the recompile-job reply, and nothing from one without it or with another shape', () => {
    expect(parseRecompileJobResult({ failedServers: ['git', 'fetch'] })).toEqual({ failedServers: ['git', 'fetch'] });
    expect(parseRecompileJobResult({ failedServers: [] })).toEqual({ failedServers: [] });
    // A daemon from before the reply named the servers that failed sends no data.
    expect(parseRecompileJobResult(undefined)).toBeUndefined();
    expect(parseRecompileJobResult({ failedServers: [1] })).toBeUndefined();
    expect(parseRecompileJobResult({ failedServers: 'git' })).toBeUndefined();
  });

  it('forwards refresh-lists to handler and returns what it refreshed', async () => {
    const result = await sendControlRequest(
      { command: 'refresh-lists', target: { kind: 'persona', name: 'research' }, list: 'repos', withMcp: false },
      { socketPath },
    );
    expect(handler.calls).toEqual([
      {
        method: 'refreshLists',
        args: [{ target: { kind: 'persona', name: 'research' }, list: 'repos', withMcp: false }],
      },
    ]);
    expect((okData(result) as RefreshListsResultDto).refreshed).toEqual(['repos']);
  });

  it('forwards reload-job to handler', async () => {
    const result = await sendControlRequest({ command: 'reload-job', jobId: 'my-job' }, { socketPath });
    expect(responseOf(result).ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'reloadJob', args: ['my-job'] }]);
  });

  it('accepts run-job at once and reports the run through run-job-status', async () => {
    const run = deferred<RunRecord>();
    handler.nextRunCompletion = run.promise;

    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    expect(accepted).toMatchObject({ accepted: true, jobId: 'my-job' });
    expect(handler.calls).toEqual([{ method: 'startJobRun', args: ['my-job'] }]);
    const runId = accepted?.runId ?? '';

    const running = okData(await sendControlRequest({ command: 'run-job-status', runId }, { socketPath }));
    expect(running).toEqual({ state: 'running', jobId: 'my-job' } satisfies RunJobStatus);

    run.resolve(handler.mockRunRecord);
    await delay(0);
    const completed = okData(await sendControlRequest({ command: 'run-job-status', runId }, { socketPath }));
    expect(completed).toEqual({ state: 'completed', jobId: 'my-job', record: handler.mockRunRecord });
  });

  it('reports a run that fails after it was accepted', async () => {
    const run = deferred<RunRecord>();
    handler.nextRunCompletion = run.promise;
    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    run.reject(new Error('session could not start'));
    await delay(0);
    const status = okData(
      await sendControlRequest({ command: 'run-job-status', runId: accepted?.runId ?? '' }, { socketPath }),
    );
    expect(status).toEqual({ state: 'failed', jobId: 'my-job', error: 'session could not start' });
  });

  it('does not accept a run that cannot start', async () => {
    handler.startJobRun = () => {
      throw new Error('Job not found: missing-job');
    };
    const result = await sendControlRequest({ command: 'run-job', jobId: 'missing-job' }, { socketPath });
    expect(errorOf(result)).toBe('Job not found: missing-job');
  });

  it('rejects run-job-status for an unknown run', async () => {
    const result = await sendControlRequest(
      { command: 'run-job-status', runId: '00000000-0000-4000-8000-000000000000' },
      { socketPath },
    );
    expect(errorOf(result)).toMatch(/Unknown run/);
  });

  it('waitForDaemonJobRun polls until the accepted run finishes', async () => {
    const run = deferred<RunRecord>();
    handler.nextRunCompletion = run.promise;
    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    setTimeout(() => run.resolve(handler.mockRunRecord), 150);
    const result = await waitForDaemonJobRun(accepted?.runId ?? '', { socketPath, pollIntervalMs: 20 });
    expect(result).toEqual({
      kind: 'completed',
      record: { outcome: { kind: 'success' }, budget: { elapsedSeconds: 60, estimatedCostUsd: 0.05 } },
    });
  });

  it('waitForDaemonJobRun keeps where the cost came from, so the CLI can say "unknown"', async () => {
    const unknownCost: RunRecord = {
      ...handler.mockRunRecord,
      budget: { ...handler.mockRunRecord.budget, estimatedCostUsd: 0, costSource: 'unknown' },
    };
    handler.nextRunCompletion = Promise.resolve(unknownCost);
    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    const result = await waitForDaemonJobRun(accepted?.runId ?? '', { socketPath, pollIntervalMs: 20 });
    expect(result.kind === 'completed' ? result.record.budget : undefined).toEqual({
      elapsedSeconds: 60,
      estimatedCostUsd: 0,
      costSource: 'unknown',
    });
  });

  it('waitForDaemonJobRun drops a cost source it does not know instead of losing the run', async () => {
    const future = {
      ...handler.mockRunRecord,
      budget: { ...handler.mockRunRecord.budget, costSource: 'from-the-future' },
    } as unknown as RunRecord;
    handler.nextRunCompletion = Promise.resolve(future);
    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    const result = await waitForDaemonJobRun(accepted?.runId ?? '', { socketPath, pollIntervalMs: 20 });
    expect(result.kind).toBe('completed');
    expect(result.kind === 'completed' ? result.record.budget.costSource : 'not completed').toBeUndefined();
  });

  it('waitForDaemonJobRun reports a lost daemon instead of a result', async () => {
    handler.nextRunCompletion = new Promise<RunRecord>(() => {});
    const accepted = parseRunJobAccepted(
      okData(await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath })),
    );
    await server.stop();
    const result = await waitForDaemonJobRun(accepted?.runId ?? '', { socketPath, pollIntervalMs: 20 });
    expect(result.kind).toBe('lost');
  });

  it('forwards list-jobs and returns serialized data', async () => {
    handler.mockListJobs = [
      {
        job: createTestJob(),
        nextRun: new Date('2026-03-05T09:00:00Z'),
        lastRun: undefined,
        isRunning: false,
        consecutiveFailures: 2,
      },
    ];

    const data = okData(await sendControlRequest({ command: 'list-jobs' }, { socketPath })) as unknown[];
    expect(data).toHaveLength(1);

    const entry = data[0] as Record<string, unknown>;
    expect((entry.job as JobDefinition).id).toBe('test-job');
    expect(entry.nextRun).toBe('2026-03-05T09:00:00.000Z');
    expect(entry.isRunning).toBe(false);
    expect(entry.consecutiveFailures).toBe(2);
  });

  it('returns the refusal when run-job finds the job already running', async () => {
    handler.startJobRun = (jobId: string) => {
      throw new JobAlreadyRunningError(jobId);
    };

    const result = await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, { socketPath });
    expect(errorOf(result)).toBe('Job "my-job" is already running (its session is starting)');
  });

  it('returns error response when handler throws', async () => {
    // Override the handler to throw
    handler.removeJob = async () => {
      throw new Error('Job not found: nonexistent');
    };

    const result = await sendControlRequest({ command: 'remove-job', jobId: 'nonexistent' }, { socketPath });
    expect(errorOf(result)).toBe('Job not found: nonexistent');
  });

  it('handles multiple sequential requests', async () => {
    const r1 = await sendControlRequest({ command: 'enable-job', jobId: 'job-1' }, { socketPath });
    const r2 = await sendControlRequest({ command: 'disable-job', jobId: 'job-2' }, { socketPath });
    const r3 = await sendControlRequest({ command: 'ping' }, { socketPath });

    expect(responseOf(r1).ok).toBe(true);
    expect(responseOf(r2).ok).toBe(true);
    expect(responseOf(r3).ok).toBe(true);
    expect(handler.calls).toHaveLength(2);
    expect(handler.calls[0]).toEqual({ method: 'enableJob', args: ['job-1'] });
    expect(handler.calls[1]).toEqual({ method: 'disableJob', args: ['job-2'] });
  });
});

describe('Control socket request validation', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlSocketServer;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
    server = new ControlSocketServer(handler, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function sendLine(line: string): Promise<ControlResponse> {
    const client = await connectRaw(socketPath);
    client.socket.write(line + '\n');
    const received = await client.received;
    return JSON.parse(received.trim()) as ControlResponse;
  }

  it('rejects a line that is not JSON', async () => {
    expect(await sendLine('{"command":')).toEqual({ ok: false, error: 'Invalid JSON' });
  });

  it('rejects the removed add-job command without touching the handler', async () => {
    const response = await sendLine(JSON.stringify({ command: 'add-job', job: createTestJob() }));
    expect(response).toEqual({ ok: false, error: 'Unknown command: "add-job"' });
    expect(handler.calls).toEqual([]);
  });

  it('rejects a job id that is not a job slug', async () => {
    const response = await sendLine(JSON.stringify({ command: 'remove-job', jobId: '../../etc' }));
    expect(response).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid request: jobId/) });
    expect(handler.calls).toEqual([]);
  });

  it('rejects unknown fields and wrongly typed values', async () => {
    expect(await sendLine(JSON.stringify({ command: 'ping', extra: true }))).toMatchObject({ ok: false });
    expect(await sendLine(JSON.stringify({ command: 'enable-job', jobId: 7 }))).toMatchObject({ ok: false });
    expect(await sendLine(JSON.stringify({ command: 'run-job-status', runId: 'not-a-uuid' }))).toMatchObject({
      ok: false,
    });
    expect(await sendLine(JSON.stringify(['ping']))).toMatchObject({ ok: false });
    expect(handler.calls).toEqual([]);
  });

  it('rejects a malformed refresh-lists request without calling the handler', async () => {
    for (const request of [
      { command: 'refresh-lists' },
      { command: 'refresh-lists', target: { kind: 'global', name: 'x' } },
      { command: 'refresh-lists', target: { kind: 'persona', name: '' } },
      { command: 'refresh-lists', target: { kind: 'job', name: '../../etc' } },
      { command: 'refresh-lists', target: { kind: 'job', name: 'nightly', extra: true } },
      { command: 'refresh-lists', target: { kind: 'job', name: 'nightly' }, list: '' },
      { command: 'refresh-lists', target: { kind: 'job', name: 'nightly' }, withMcp: 'yes' },
    ]) {
      expect(await sendLine(JSON.stringify(request)), JSON.stringify(request)).toMatchObject({ ok: false });
    }
    expect(handler.calls).toEqual([]);
  });
});

describe('Control socket framing and timeouts', () => {
  let tmpDir: string;
  let socketPath: string;
  let handler: ReturnType<typeof createMockHandler>;
  const servers: ControlSocketServer[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startServer(options?: ConstructorParameters<typeof ControlSocketServer>[2]): Promise<void> {
    const server = new ControlSocketServer(handler, socketPath, options);
    await server.start();
    servers.push(server);
  }

  it('closes only the connection whose request line passes 1 MiB without a newline', async () => {
    handler.recompileJob = async () => {
      await delay(300);
      return { failedServers: [] };
    };
    await startServer();

    const inFlight = sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, { socketPath });
    const flood = await connectRaw(socketPath);
    flood.socket.write(Buffer.alloc(MAX_CONTROL_REQUEST_BYTES + 1, 0x61));

    expect(await flood.received).toBe(''); // closed by the server, no reply
    expect(await inFlight).toEqual({ kind: 'response', response: { ok: true, data: { failedServers: [] } } });
    expect(await isDaemonRunning(socketPath)).toBe(true);
  });

  it('reads a request line of exactly the maximum size', async () => {
    await startServer();
    const prefix = '{"command":"ping","pad":"';
    const suffix = '"}';
    const line = prefix + 'a'.repeat(MAX_CONTROL_REQUEST_BYTES - prefix.length - suffix.length) + suffix;
    expect(Buffer.byteLength(line)).toBe(MAX_CONTROL_REQUEST_BYTES);

    const client = await connectRaw(socketPath);
    client.socket.write(line + '\n');
    const response = JSON.parse((await client.received).trim()) as ControlResponse;
    // Read and parsed in full (then rejected for its unknown field), not cut off.
    expect(response).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid request/) });
  });

  it('keeps a dispatched request alive past the request idle timeout', async () => {
    handler.recompileJob = async () => {
      await delay(400);
      return { failedServers: [] };
    };
    await startServer({ requestIdleTimeoutMs: 100 });
    const result = await sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, { socketPath });
    expect(result).toEqual({ kind: 'response', response: { ok: true, data: { failedServers: [] } } });
  });

  it('closes a connection whose request line never completes', async () => {
    await startServer({ requestIdleTimeoutMs: 100 });
    const client = await connectRaw(socketPath);
    client.socket.write('{"command":');
    expect(await client.received).toBe(''); // closed by the server, never answered
    expect(handler.calls).toEqual([]);
  });

  it('stop() drops in-flight requests, and their clients see a failure rather than no daemon', async () => {
    const started = deferred<undefined>();
    handler.recompileJob = () => {
      started.resolve(undefined);
      return new Promise<RecompileJobResultDto>(() => {});
    };
    await startServer();
    const pending = sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, { socketPath });
    await started.promise;
    await servers[0].stop();
    expect((await pending).kind).toBe('failed');
  });
});
