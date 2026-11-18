/**
 * Control socket for live daemon communication.
 *
 * The daemon listens on a Unix domain socket at ~/.ironcurtain/daemon.sock and
 * CLI commands forward job commands to it. {@link sendControlRequest} reports
 * one of three outcomes:
 *   - `unreachable`: nothing accepted the connection (no socket file, a stale
 *     socket, or no connection within the connect timeout). Only this outcome
 *     lets a CLI command fall back to running locally, and only while it holds
 *     the daemon lock (see daemon-lock.ts).
 *   - `response`: the daemon answered.
 *   - `failed`: a daemon accepted the connection but no valid response came
 *     back (connection dropped, malformed or oversized reply, response
 *     timeout). The daemon may still be acting on the request, so callers
 *     report the failure and never repeat the work locally.
 *
 * Protocol: newline-delimited JSON. A request is one JSON line of at most
 * {@link MAX_CONTROL_REQUEST_BYTES} bytes, validated against a strict schema;
 * the daemon answers with one JSON line and closes the connection. `run-job`
 * is accept-then-poll: the daemon replies {@link RunJobAccepted} at once and
 * the client polls `run-job-status` until the run ends, so no socket timeout
 * bounds how long a run may take.
 *
 * Access control: Node has no SO_PEERCRED, so the filesystem is the access
 * control. The server makes the socket's directory owner-only (0700), binds at
 * a temporary name, chmods the socket to 0600 and renames it into place: the
 * socket never exists with umask-derived permissions, and a starting daemon
 * never unlinks another daemon's live socket.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { getDaemonSocketPath } from '../config/paths.js';
import * as logger from '../logger.js';
import { JOB_ID_PATTERN, SLUG_PATTERN } from '../types/slug.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { BudgetCostSource } from '../session/types.js';

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

const jobIdField = z.string().regex(JOB_ID_PATTERN, 'must be a job id');

/** The policy a `refresh-lists` request re-resolves the dynamic lists of. */
export interface RefreshListsTargetDto {
  readonly kind: 'persona' | 'job';
  /** Persona name or job id. */
  readonly name: string;
}

/** Re-resolves the dynamic lists of a persona's or a cron job's policy. */
export interface RefreshListsRequest {
  readonly target: RefreshListsTargetDto;
  /** Refresh only this list (its name in the compiled policy). */
  readonly list?: string;
  /** Resolve data-backed lists through their MCP servers (default true). */
  readonly withMcp?: boolean;
}

/**
 * What a `recompile-job` wrote (its reply data): the servers the job's new
 * policy has no rules for, because they failed to compile, so the job's
 * calls to their tools are denied until a compile succeeds. Empty when every
 * server compiled.
 */
export interface RecompileJobResultDto {
  readonly failedServers: readonly string[];
}

/** What a `refresh-lists` request did. */
export interface RefreshListsResultDto {
  readonly target: string;
  /** Directory the merged dynamic-lists.json was written to. */
  readonly outputDir: string;
  /** Lists re-resolved. */
  readonly refreshed: readonly string[];
  /** Data-backed lists skipped because MCP access was off. */
  readonly skipped: readonly string[];
}

/**
 * Every request the daemon accepts. Unknown commands, unknown fields and
 * malformed values are rejected before anything is dispatched. (There is no
 * `add-job`: the add-job wizard writes the job itself, and the daemon never
 * takes a whole job definition from a socket client.)
 */
const controlRequestSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('ping') }),
  z.strictObject({ command: z.literal('status') }),
  z.strictObject({ command: z.literal('list-jobs') }),
  z.strictObject({ command: z.literal('remove-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('enable-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('disable-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('recompile-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('reload-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('run-job'), jobId: jobIdField }),
  z.strictObject({ command: z.literal('run-job-status'), runId: z.uuid() }),
  // Persona names and job ids are both slugs; the refresh checks the name again.
  z.strictObject({
    command: z.literal('refresh-lists'),
    target: z.strictObject({
      kind: z.enum(['persona', 'job']),
      name: z.string().regex(SLUG_PATTERN, 'must be a persona name or job id'),
    }),
    list: z.string().min(1).optional(),
    withMcp: z.boolean().optional(),
  }),
]);

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(
  controlRequestSchema.options.map((option) => option.shape.command.value),
);

/** Commands the CLI can send to the daemon. */
export type ControlRequest = z.infer<typeof controlRequestSchema>;

/** Successful response from the daemon. */
export interface ControlResponseOk {
  readonly ok: true;
  readonly data?: unknown;
}

/** Error response from the daemon. */
export interface ControlResponseError {
  readonly ok: false;
  readonly error: string;
}

export type ControlResponse = ControlResponseOk | ControlResponseError;

const controlResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** `run-job` reply: the daemon has taken the run; poll `run-job-status` with `runId`. */
export interface RunJobAccepted {
  readonly accepted: true;
  readonly jobId: string;
  readonly runId: string;
}

/** `run-job-status` reply for a run the daemon accepted. */
export type RunJobStatus =
  | { readonly state: 'running'; readonly jobId: string }
  | { readonly state: 'completed'; readonly jobId: string; readonly record: RunRecord }
  | { readonly state: 'failed'; readonly jobId: string; readonly error: string };

// ---------------------------------------------------------------------------
// Request handler interface (implemented by the daemon)
// ---------------------------------------------------------------------------

/**
 * The daemon's web UI: not enabled (no `--web-ui`), enabled but not listening
 * yet (the control socket comes up first, then Signal, then the web UI),
 * listening, or failed to start.
 */
export type DaemonWebUiState = 'disabled' | 'starting' | 'listening' | 'unavailable';

/** A job whose most recent runs ended in errors. */
export interface FailingJobStatus {
  readonly jobId: string;
  readonly name: string;
  /** Runs in a row, newest first, that ended in an error (capped, see countConsecutiveFailures). */
  readonly consecutiveFailures: number;
}

/** Status snapshot returned by the daemon. */
export interface DaemonStatus {
  readonly uptimeSeconds: number;
  /** `failing`: jobs whose latest run ended in an error. */
  readonly jobs: { total: number; enabled: number; running: number; failing: number };
  /** The failing jobs, longest failure streak first. */
  readonly failingJobs: readonly FailingJobStatus[];
  readonly signalConnected: boolean;
  readonly nextFireTime: Date | null;
  /** Absent from daemons that predate it. */
  readonly webUi?: DaemonWebUiState;
}

/**
 * JSON-serialized form of DaemonStatus (Date → ISO string). The failure
 * fields are optional so a newer CLI can read an older daemon's reply.
 */
export interface DaemonStatusDto {
  readonly uptimeSeconds: number;
  readonly jobs: { total: number; enabled: number; running: number; failing?: number };
  readonly failingJobs?: readonly FailingJobStatus[];
  readonly signalConnected: boolean;
  readonly nextFireTime: string | null;
  readonly webUi?: DaemonWebUiState;
}

/** A manual run the daemon has started (see ControlRequestHandler.startJobRun). */
export interface JobRunStart {
  /**
   * Settles when the run ends. Every outcome, failures included, resolves
   * with the run's record; a rejection means the run ended without one.
   */
  readonly completion: Promise<RunRecord>;
}

/** One job as `list-jobs` reports it. */
export interface JobListEntry {
  job: JobDefinition;
  nextRun: Date | undefined;
  lastRun: RunRecord | undefined;
  /** True from the moment a run is reserved (before its git sync and session start) until its record is written. */
  isRunning: boolean;
  /** A scheduled run waits for a free run slot (`cron.maxConcurrentRuns`). Absent from older daemons. */
  isQueued?: boolean;
  /** Runs in a row, newest first, that ended in an error; 0 when the latest did not. */
  consecutiveFailures: number;
}

export interface ControlRequestHandler {
  getStatus(): DaemonStatus;
  removeJob(jobId: string): Promise<void>;
  enableJob(jobId: string): Promise<void>;
  disableJob(jobId: string): Promise<void>;
  /** Compiles the job's policy, then reloads the job; resolves with the servers the policy left out. */
  recompileJob(jobId: string): Promise<RecompileJobResultDto>;
  /**
   * Re-resolves a persona's or a job's dynamic lists (refresh-lists), with
   * MCP resolution mediated by the security kernel as for compile-policy.
   */
  refreshLists(request: RefreshListsRequest): Promise<RefreshListsResultDto>;
  reloadJob(jobId: string): Promise<void>;
  /**
   * Starts a manual run and returns without waiting for it (the control
   * socket's accept-then-poll `run-job`, and the web UI's `jobs.run`). The
   * job is reserved before this returns; when no run starts it throws
   * synchronously (JOB_ALREADY_RUNNING while a run of the job is still in
   * progress, see isJobAlreadyRunningError; JOB_NOT_FOUND for an unknown
   * job), so the caller reports that instead of "accepted".
   */
  startJobRun(jobId: string): JobRunStart;
  /**
   * Starts a manual run and waits for it, resolving with its record (the
   * CLI's local fallback when no daemon is running). Rejects with
   * JOB_ALREADY_RUNNING while a run of the job is still in progress.
   */
  runJobNow(jobId: string): Promise<RunRecord>;
  listJobs(): JobListEntry[];
}

// ---------------------------------------------------------------------------
// Line framing (shared by server and client)
// ---------------------------------------------------------------------------

type LineReadResult =
  { readonly kind: 'pending' } | { readonly kind: 'line'; readonly line: string } | { readonly kind: 'overflow' };

/**
 * Collects bytes up to the first newline, holding at most `maxBytes` of line
 * content. Buffers are joined before decoding, so a multi-byte UTF-8 character
 * split across chunks survives.
 */
class LineReader {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): LineReadResult {
    const newline = chunk.indexOf(0x0a);
    const contentBytes = newline === -1 ? chunk.length : newline;
    if (this.size + contentBytes > this.maxBytes) return { kind: 'overflow' };
    if (newline === -1) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return { kind: 'pending' };
    }
    this.chunks.push(chunk.subarray(0, newline));
    const line = Buffer.concat(this.chunks).toString('utf8');
    this.chunks = [];
    this.size = 0;
    return { kind: 'line', line };
  }
}

// ---------------------------------------------------------------------------
// Server (daemon-side)
// ---------------------------------------------------------------------------

/** Longest request line the server buffers; a longer one closes that connection (1 MiB). */
export const MAX_CONTROL_REQUEST_BYTES = 1024 * 1024;

/** Idle limit while a connection's request line is still incomplete. */
const DEFAULT_REQUEST_IDLE_TIMEOUT_MS = 30_000;

/** How long the start-up probe waits for an existing socket to accept. */
const LIVENESS_PROBE_TIMEOUT_MS = 2_000;

/** A finished manual run stays pollable this long (and at most this many are kept). */
const FINISHED_RUN_RETENTION_MS = 60 * 60_000;
const MAX_FINISHED_RUNS = 100;

export interface ControlSocketServerOptions {
  /** Idle limit before a connection's request line is complete (default 30 s). */
  readonly requestIdleTimeoutMs?: number;
  /** Longest accepted request line in bytes (default {@link MAX_CONTROL_REQUEST_BYTES}). */
  readonly maxRequestBytes?: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface TrackedRun {
  status: RunJobStatus;
  finishedAtMs: number | undefined;
}

export class ControlSocketServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly handler: ControlRequestHandler;
  private readonly requestIdleTimeoutMs: number;
  private readonly maxRequestBytes: number;
  /** The socket inode this server put at `socketPath`; stop() removes only that one. */
  private socketIdentity: FileIdentity | null = null;
  private readonly connections = new Set<Socket>();
  /** Manual runs accepted over `run-job`, by run id. */
  private readonly runs = new Map<string, TrackedRun>();

  constructor(handler: ControlRequestHandler, socketPath?: string, options: ControlSocketServerOptions = {}) {
    this.handler = handler;
    this.socketPath = socketPath ?? getDaemonSocketPath();
    this.requestIdleTimeoutMs = options.requestIdleTimeoutMs ?? DEFAULT_REQUEST_IDLE_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_CONTROL_REQUEST_BYTES;
  }

  /**
   * Starts listening. Fails (and leaves nothing behind) when the socket's
   * directory cannot be made owner-only, when another daemon is listening on
   * the path, or when the socket cannot be bound.
   */
  async start(): Promise<void> {
    if (this.server) throw new Error('Control socket is already listening');

    ensurePrivateDirectory(dirname(this.socketPath));

    // The daemon lock keeps a second daemon of this version out; this probe
    // also refuses to replace the socket of a daemon that predates the lock.
    if (await isSocketAccepting(this.socketPath)) {
      throw new Error(`Another daemon is already listening on ${this.socketPath}. Stop it first.`);
    }

    const tempPath = temporarySocketPath(this.socketPath);
    const server = createServer((socket) => this.onConnection(socket));
    try {
      await listen(server, tempPath);
      chmodSync(tempPath, 0o600);
      const identity = fileIdentity(lstatSync(tempPath));
      // rename(2) atomically replaces a stale socket (or other leftover file)
      // at the final path; a live one was refused above.
      renameSync(tempPath, this.socketPath);
      this.socketIdentity = identity;
    } catch (err) {
      await closeServer(server);
      unlinkIfPresent(tempPath);
      throw err;
    }

    server.on('error', (err) => {
      logger.error(`[ControlSocket] Server error: ${err.message}`);
    });
    this.server = server;
    logger.info(`[ControlSocket] Listening on ${this.socketPath}`);
  }

  /** Stops the server, drops open connections and removes its socket file. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    const closed = closeServer(server);
    // An in-flight request (a long recompile) would hold close() open. Its
    // client sees a dropped connection, which it reports as a failure and
    // never as "no daemon".
    for (const socket of this.connections) socket.destroy();
    await closed;
    this.removeOwnSocketFile();
  }

  private removeOwnSocketFile(): void {
    const identity = this.socketIdentity;
    this.socketIdentity = null;
    if (!identity) return;
    try {
      // Never unlink a socket some other process has since put at the path.
      if (!sameFile(fileIdentity(lstatSync(this.socketPath)), identity)) return;
      unlinkSync(this.socketPath);
    } catch {
      // Already gone.
    }
  }

  private onConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));

    const reader = new LineReader(this.maxRequestBytes);
    let dispatched = false;

    socket.on('data', (chunk: Buffer) => {
      if (dispatched) return;
      const result = reader.push(chunk);
      if (result.kind === 'pending') return;
      if (result.kind === 'overflow') {
        logger.warn(`[ControlSocket] Request line over ${this.maxRequestBytes} bytes; closing the connection`);
        socket.destroy();
        return;
      }
      dispatched = true;
      // The request is complete: the idle timeout guarded only its arrival.
      // The handler may take as long as it needs (a policy recompile can take
      // many minutes) without the connection being cut off under the client.
      socket.setTimeout(0);
      void this.handleRequest(result.line, socket);
    });

    socket.on('error', (err) => {
      logger.warn(`[ControlSocket] Connection error: ${err.message}`);
    });

    socket.setTimeout(this.requestIdleTimeoutMs, () => {
      socket.destroy();
    });
  }

  private async handleRequest(line: string, socket: Socket): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.sendResponse(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    const parsed = controlRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendResponse(socket, { ok: false, error: describeInvalidRequest(raw, parsed.error) });
      return;
    }

    try {
      const response = await this.dispatch(parsed.data);
      this.sendResponse(socket, response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(socket, { ok: false, error: message });
    }
  }

  private async dispatch(request: ControlRequest): Promise<ControlResponse> {
    switch (request.command) {
      case 'ping':
        return { ok: true, data: { status: 'running' } };

      case 'status': {
        const status = this.handler.getStatus();
        return {
          ok: true,
          data: {
            ...status,
            nextFireTime: status.nextFireTime?.toISOString() ?? null,
          },
        };
      }

      case 'remove-job':
        await this.handler.removeJob(request.jobId);
        return { ok: true };

      case 'enable-job':
        await this.handler.enableJob(request.jobId);
        return { ok: true };

      case 'disable-job':
        await this.handler.disableJob(request.jobId);
        return { ok: true };

      case 'recompile-job':
        return { ok: true, data: await this.handler.recompileJob(request.jobId) };

      case 'refresh-lists': {
        const result = await this.handler.refreshLists({
          target: request.target,
          ...(request.list !== undefined ? { list: request.list } : {}),
          ...(request.withMcp !== undefined ? { withMcp: request.withMcp } : {}),
        });
        return { ok: true, data: result };
      }

      case 'reload-job':
        await this.handler.reloadJob(request.jobId);
        return { ok: true };

      case 'run-job': {
        // Throws (an error response) when the run cannot start.
        const { completion } = this.handler.startJobRun(request.jobId);
        const runId = randomUUID();
        this.trackRun(runId, request.jobId, completion);
        const accepted: RunJobAccepted = { accepted: true, jobId: request.jobId, runId };
        return { ok: true, data: accepted };
      }

      case 'run-job-status': {
        const run = this.runs.get(request.runId);
        if (!run) return { ok: false, error: `Unknown run: ${request.runId}` };
        return { ok: true, data: run.status };
      }

      case 'list-jobs': {
        const jobs = this.handler.listJobs();
        // Serialize dates for JSON transport
        const serialized = jobs.map((j) => ({
          ...j,
          nextRun: j.nextRun?.toISOString() ?? null,
        }));
        return { ok: true, data: serialized };
      }
    }
  }

  private trackRun(runId: string, jobId: string, completion: Promise<RunRecord>): void {
    const run: TrackedRun = { status: { state: 'running', jobId }, finishedAtMs: undefined };
    this.runs.set(runId, run);
    this.pruneFinishedRuns();
    completion.then(
      (record) => {
        run.status = { state: 'completed', jobId, record };
        run.finishedAtMs = Date.now();
        this.pruneFinishedRuns();
      },
      (err: unknown) => {
        run.status = { state: 'failed', jobId, error: err instanceof Error ? err.message : String(err) };
        run.finishedAtMs = Date.now();
        this.pruneFinishedRuns();
      },
    );
  }

  /** Forgets finished runs past their retention; running runs are always kept. */
  private pruneFinishedRuns(): void {
    const cutoff = Date.now() - FINISHED_RUN_RETENTION_MS;
    const finished: Array<[string, number]> = [];
    for (const [runId, run] of this.runs) {
      if (run.finishedAtMs === undefined) continue;
      if (run.finishedAtMs < cutoff) this.runs.delete(runId);
      else finished.push([runId, run.finishedAtMs]);
    }
    if (finished.length <= MAX_FINISHED_RUNS) return;
    finished.sort((a, b) => a[1] - b[1]);
    for (const [runId] of finished.slice(0, finished.length - MAX_FINISHED_RUNS)) this.runs.delete(runId);
  }

  private sendResponse(socket: Socket, response: ControlResponse): void {
    // The client may be gone (it disconnected, or stop() dropped it); the
    // handler's work is done either way.
    if (socket.destroyed) return;
    socket.end(JSON.stringify(response) + '\n');
  }
}

/** A short, safe description of a request the schema rejected. */
function describeInvalidRequest(raw: unknown, error: z.ZodError): string {
  if (raw !== null && typeof raw === 'object' && 'command' in raw) {
    const command = raw.command;
    if (typeof command === 'string' && !KNOWN_COMMANDS.has(command)) {
      return `Unknown command: ${JSON.stringify(command.slice(0, 64))}`;
    }
  }
  const details = error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return `Invalid request: ${details}`;
}

/**
 * Makes `dir` (created when missing) an owner-only directory before the socket
 * is bound in it. `mkdir`'s mode never tightens an existing directory, and an
 * IronCurtain home made by an older version, by hand or by a test can be
 * group- or world-accessible; with the directory private, nobody else can
 * reach the socket even in the instant before it is chmodded.
 */
function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = statSync(dir);
  const uid = process.getuid?.();
  if (!before.isDirectory() || (uid !== undefined && before.uid !== uid)) {
    throw new Error(`Refusing to bind the control socket: ${dir} must be a directory owned by the current user`);
  }
  if ((before.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    logger.warn(`[ControlSocket] Restricted ${dir} to its owner (mode 0700)`);
  }
  if ((statSync(dir).mode & 0o077) !== 0) {
    throw new Error(`Refusing to bind the control socket: ${dir} is still accessible to other users`);
  }
}

/**
 * Where the socket is bound before it is renamed into place: a dot and random
 * hex in the same directory, no longer than the final name (for `daemon.sock`
 * exactly as long). A socket path is capped at 104 bytes on macOS and 108 on
 * Linux, so a longer temporary name could fail to bind for a home whose
 * `daemon.sock` fits.
 */
function temporarySocketPath(socketPath: string): string {
  const hexLength = Math.max(8, basename(socketPath).length - 1);
  const hex = randomBytes(Math.ceil(hexLength / 2))
    .toString('hex')
    .slice(0, hexLength);
  return join(dirname(socketPath), `.${hex}`);
}

/** Whether something is listening on `path` (a timeout counts as alive, to be safe). */
function isSocketAccepting(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const conn = createConnection(path);
    const done = (alive: boolean): void => {
      clearTimeout(timer);
      conn.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(true), LIVENESS_PROBE_TIMEOUT_MS);
    conn.once('connect', () => done(true));
    conn.once('error', () => done(false));
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(path, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Not there.
  }
}

function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// ---------------------------------------------------------------------------
// Client (CLI-side)
// ---------------------------------------------------------------------------

/**
 * Outcome of one control request; see the module comment. Only `unreachable`
 * means no daemon took the request.
 */
export type ControlRequestResult =
  | { readonly kind: 'response'; readonly response: ControlResponse }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export interface ControlRequestOptions {
  /** Defaults to the daemon socket in the IronCurtain home. */
  readonly socketPath?: string;
  /** How long to wait for the connection itself (default 2 s). */
  readonly connectTimeoutMs?: number;
  /** How long to wait for the reply once connected (default depends on the command). */
  readonly responseTimeoutMs?: number;
}

/** Timeout for connecting to the daemon socket (ms). */
const CONNECT_TIMEOUT_MS = 2_000;

/** Reply timeout once connected, unless the command needs longer. */
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

const RESPONSE_TIMEOUT_MS: Partial<Record<ControlRequest['command'], number>> = {
  // Removing a job first ends its active run's session.
  'remove-job': 5 * 60_000,
  // A policy compilation makes LLM calls and can take many minutes.
  'recompile-job': 60 * 60_000,
};

/** Largest reply the client buffers (a long job list stays far below this). */
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Sends one request to the running daemon. Never rejects: the result says
 * whether a daemon answered, was not there at all, or took the connection and
 * then failed to answer.
 */
export function sendControlRequest(
  request: ControlRequest,
  options: ControlRequestOptions = {},
): Promise<ControlRequestResult> {
  const path = options.socketPath ?? getDaemonSocketPath();
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseTimeoutMs =
    options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS[request.command] ?? DEFAULT_RESPONSE_TIMEOUT_MS;

  return new Promise<ControlRequestResult>((resolve) => {
    const socket = createConnection({ path });
    const reader = new LineReader(MAX_CONTROL_RESPONSE_BYTES);
    let connected = false;
    let settled = false;

    const finish = (result: ControlRequestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      resolve(result);
    };

    // Only the connection attempt is bounded by this timer: once a daemon has
    // the request, giving up must never look like "no daemon".
    const connectTimer = setTimeout(() => {
      finish({ kind: 'unreachable', reason: `no connection to ${path} within ${connectTimeoutMs} ms` });
    }, connectTimeoutMs);

    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.setTimeout(responseTimeoutMs, () => {
        finish({
          kind: 'failed',
          reason: `the daemon accepted the request but did not answer within ${formatSeconds(responseTimeoutMs)}`,
        });
      });
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      const result = reader.push(chunk);
      if (result.kind === 'pending') return;
      if (result.kind === 'overflow') {
        finish({ kind: 'failed', reason: 'the daemon sent an oversized response' });
        return;
      }
      finish(parseControlResponse(result.line));
    });

    // A dropped connection before a full reply line is a failure of a daemon
    // that had the request; without these the promise would never settle.
    socket.once('end', () => {
      finish({ kind: 'failed', reason: 'the daemon closed the connection without answering' });
    });
    socket.once('close', () => {
      finish({ kind: 'failed', reason: 'the connection to the daemon closed without an answer' });
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        finish({ kind: 'unreachable', reason: `no daemon is listening on ${path} (${err.code})` });
        return;
      }
      finish({
        kind: 'failed',
        reason: connected
          ? `connection to the daemon failed: ${err.message}`
          : `cannot connect to ${path}: ${err.message}`,
      });
    });
  });
}

function parseControlResponse(line: string): ControlRequestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: 'failed', reason: 'the daemon sent a response that is not JSON' };
  }
  const parsed = controlResponseSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'failed', reason: 'the daemon sent a malformed response' };
  return { kind: 'response', response: parsed.data };
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/**
 * Checks if a daemon is currently running and responsive.
 * Returns true only if the daemon answers a ping.
 */
export async function isDaemonRunning(socketPath?: string): Promise<boolean> {
  const result = await sendControlRequest({ command: 'ping' }, { socketPath });
  return result.kind === 'response' && result.response.ok;
}

const daemonWebUiStatusSchema = z.object({
  webUi: z.enum(['disabled', 'starting', 'listening', 'unavailable']),
});

/**
 * Reads the web UI state from a `status` reply; `undefined` for an error
 * reply or a daemon that does not report it.
 */
export function parseDaemonWebUiState(response: ControlResponse): DaemonWebUiState | undefined {
  if (!response.ok) return undefined;
  const parsed = daemonWebUiStatusSchema.safeParse(response.data);
  return parsed.success ? parsed.data.webUi : undefined;
}

// ---------------------------------------------------------------------------
// Accept-then-poll `run-job` (client side)
// ---------------------------------------------------------------------------

const runJobAcceptedSchema = z.object({ accepted: z.literal(true), jobId: z.string(), runId: z.uuid() });

/** Reads the `run-job` reply; `undefined` when it is not an acceptance. */
export function parseRunJobAccepted(data: unknown): RunJobAccepted | undefined {
  const parsed = runJobAcceptedSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

const recompileJobResultSchema = z.object({ failedServers: z.array(z.string()) });

/**
 * Reads the `recompile-job` reply; `undefined` when it carries none (a daemon
 * from before the reply named the servers that failed).
 */
export function parseRecompileJobResult(data: unknown): RecompileJobResultDto | undefined {
  const parsed = recompileJobResultSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** The parts of a finished run's record the CLI reports. */
export interface DaemonRunSummary {
  readonly notices?: readonly string[];
  readonly outcome: { readonly kind: string };
  readonly budget: {
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
    /** Where the cost comes from (`RunRecord.budget.costSource`); `unknown` is shown as "unknown". */
    readonly costSource?: BudgetCostSource;
  };
}

const BUDGET_COST_SOURCES = [
  'observed',
  'reported',
  'partial',
  'unknown',
] as const satisfies readonly BudgetCostSource[];

const runJobStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({
    state: z.literal('completed'),
    record: z.object({
      notices: z.array(z.string()).optional(),
      outcome: z.object({ kind: z.string() }),
      budget: z.object({
        elapsedSeconds: z.number(),
        estimatedCostUsd: z.number(),
        // A source this CLI does not know is dropped rather than failing the whole reply.
        costSource: z.enum(BUDGET_COST_SOURCES).optional().catch(undefined),
      }),
    }),
  }),
  z.object({ state: z.literal('failed'), error: z.string() }),
]);

/** How waiting for a run the daemon accepted ended. */
export type DaemonRunWaitResult =
  | { readonly kind: 'completed'; readonly record: DaemonRunSummary }
  /** The run ended without a run record; `error` is the daemon's reason. */
  | { readonly kind: 'failed'; readonly error: string }
  /** No status could be obtained (daemon gone, unknown run, bad reply). The run may still be going. */
  | { readonly kind: 'lost'; readonly reason: string };

export interface WaitForDaemonJobRunOptions {
  readonly socketPath?: string;
  /** Delay before each status request (default 1 s). */
  readonly pollIntervalMs?: number;
}

const RUN_POLL_INTERVAL_MS = 1_000;

/**
 * Polls `run-job-status` until the daemon reports the run finished. Has no
 * overall deadline: a run is bounded by its own budget, and the caller can
 * stop waiting at any time without affecting the run.
 */
export async function waitForDaemonJobRun(
  runId: string,
  options: WaitForDaemonJobRunOptions = {},
): Promise<DaemonRunWaitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;
  for (;;) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    const result = await sendControlRequest({ command: 'run-job-status', runId }, { socketPath: options.socketPath });
    if (result.kind !== 'response') return { kind: 'lost', reason: result.reason };
    if (!result.response.ok) return { kind: 'lost', reason: result.response.error };
    const status = runJobStatusSchema.safeParse(result.response.data);
    if (!status.success) return { kind: 'lost', reason: 'the daemon sent a malformed run status' };
    if (status.data.state === 'completed') return { kind: 'completed', record: status.data.record };
    if (status.data.state === 'failed') return { kind: 'failed', error: status.data.error };
  }
}
