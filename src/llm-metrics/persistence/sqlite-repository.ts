import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import {
  STATISTICS_IDENTIFIER_MAX_LENGTH,
  STATISTICS_IDENTIFIER_PATTERN,
  StatisticsLimitError,
} from '../query-contract.js';
import type { LlmExchangeCompleted } from '../types.js';
import { createRateLimitedLog, projectLogSink, type LlmMetricsLogSink, type RateLimitedLog } from './health-log.js';
import {
  LlmMetricsRepositoryUnavailableError,
  type LlmDeleteBeforeOptions,
  type LlmDeleteBeforeResult,
  type LlmDimensionCount,
  type LlmExchangeScanQuery,
  type LlmMetricsReadRepository,
  type LlmMetricsRepository,
  type LlmMetricsRepositoryHealth,
  type LlmMetricsRepositoryState,
  type LlmMetricsReaderState,
  type LlmSessionTotalsQuery,
  type LlmSessionUsageTotalsResult,
  type LlmStatisticsAggregateQuery,
  type LlmStatisticsDimension,
  type LlmStatisticsDistributionQuery,
  type LlmStatisticsDistributionResult,
  type LlmStatisticsPartition,
  type StoredLlmExchange,
} from './repository.js';
import type {
  SqliteDeleteChunkResult,
  SqliteDeleteLeaseResult,
  SqliteInsertResult,
  SqliteReaderWorkerData,
  SqliteReaderWorkerRequest,
  SqliteWriterWorkerData,
  SqliteWorkerRequest,
  SqliteWorkerResponse,
} from './sqlite-worker.js';
import { isPermanentStorageError, type LlmMetricsStorageErrorCode } from './storage-errors.js';

const DEFAULT_MAX_QUEUED_RECORDS = 2_000;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 5 * 60 * 1_000;
const DEFAULT_BUSY_RETRY_DELAY_MS = 500;
/** Keeps exponential backoff arithmetic finite; the configured maximum bounds the delay itself. */
const MAX_RESTART_BACKOFF_EXPONENT = 30;
/** A busy batch's requeue delay doubles per attempt, up to 16 times its base. */
const MAX_BUSY_RETRY_BACKOFF_EXPONENT = 4;
/** Write attempts per record, across busy requeues and writers lost mid-batch, before it is dropped. */
const MAX_RECORD_WRITE_ATTEMPTS = 5;
const HEALTH_LOG_INTERVAL_MS = 60_000;
const MAX_INVALID_REASONS = 32;
const MAX_INVALID_REASON_LENGTH = 120;
const OTHER_INVALID_REASON = 'other';
const DEFAULT_DELETE_CHUNK_SIZE = 250;
const DEFAULT_DELETE_MAX_ROWS = 10_000;
const DEFAULT_DELETE_MAX_DURATION_MS = 5_000;
const DEFAULT_MAINTENANCE_LEASE_MS = 30_000;
const MAX_DELETE_CHUNK_SIZE = 1_000;
const MAX_DELETE_ROWS = 100_000;
const MIN_DELETE_DURATION_MS = 10;
const MAX_DELETE_DURATION_MS = 30_000;
const MIN_MAINTENANCE_LEASE_MS = 100;
const MAX_MAINTENANCE_LEASE_MS = 60_000;
const MAINTENANCE_RELEASE_TIMEOUT_MS = 1_000;
const DELETE_LEASE_NAME = 'llm-exchanges-delete';
const MAX_ERROR_LENGTH = 500;
const MAX_PENDING_WORKER_REQUESTS = 64;

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker;
type WorkerResult = Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
type WriterRequestWithoutId =
  Exclude<SqliteWorkerRequest, SqliteReaderWorkerRequest> extends infer Request
    ? Request extends { readonly id: number }
      ? Omit<Request, 'id'>
      : never
    : never;
type ReaderRequestWithoutId = SqliteReaderWorkerRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

interface PendingRequest {
  readonly resolve: (value: WorkerResult) => void;
  readonly reject: (error: Error) => void;
}

interface QueuedExchange {
  readonly exchange: LlmExchangeCompleted;
  readonly bytes: number;
  /** Failed write attempts so far: busy batches and batches lost with their worker. */
  readonly attempts: number;
}

/** A batch sent to the writer. Exactly one outcome settles it: written, requeued, or dropped. */
interface InFlightBatch {
  readonly items: readonly QueuedExchange[];
  readonly bytes: number;
  settled: boolean;
}

interface ActiveDelete {
  callerSettled: boolean;
  outstandingRequests: number;
}

/** A writer request the worker answered with an error, with the worker's storage classification. */
class WriterRequestError extends Error {
  constructor(
    message: string,
    readonly code: LlmMetricsStorageErrorCode | undefined,
  ) {
    super(message);
    this.name = 'WriterRequestError';
  }
}

export interface SqliteLlmMetricsRepositoryOptions {
  readonly databasePath: string;
  readonly processRunId?: string;
  readonly maxQueuedRecords?: number;
  readonly maxQueuedBytes?: number;
  readonly maxRecordBytes?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly checkpointIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  /**
   * Deadline for each writer request: one insert batch, checkpoint, or
   * maintenance step. A worker that misses it is treated as wedged and replaced.
   */
  readonly writeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /** First writer restart delay; it doubles per consecutive failure up to `maxRestartDelayMs`. */
  readonly restartDelayMs?: number;
  readonly maxRestartDelayMs?: number;
  /** First requeue delay for a batch that met SQLITE_BUSY; it doubles per attempt. */
  readonly busyRetryDelayMs?: number;
  /** Health log test seam; production logs through the project logger. */
  readonly logSink?: LlmMetricsLogSink;
  /** Writer test seam; production callers should use the default worker implementation. */
  readonly workerFactory?: WorkerFactory;
  /** Reader test seam; production callers should use the default worker implementation. */
  readonly readWorkerFactory?: WorkerFactory;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid ${name}`);
  return result;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown LLM metrics persistence error';
  return message.replace(/[\r\n\t]+/g, ' ').substring(0, MAX_ERROR_LENGTH);
}

function workerUrl(): URL {
  // Source runs boot through the .mjs entry shim, which registers the
  // .js -> .ts specifier remap hook itself; compiled runs load the .js worker.
  return import.meta.url.endsWith('.ts')
    ? new URL('./sqlite-worker-entry.mjs', import.meta.url)
    : new URL('./sqlite-worker.js', import.meta.url);
}

/**
 * Default worker spawn. Exported so tests that wrap the factory (to count or
 * fault-inject spawns) delegate here instead of re-implementing the spawn and
 * silently drifting from the flags production actually uses.
 */
export function defaultWorkerFactory(url: URL, options: WorkerOptions): Worker {
  // The entry shim loads .ts sources via native type stripping; the flag is
  // a no-op on the supported Node lines (24, 26), which strip types by
  // default. The explicit execArgv also keeps the worker self-contained: it
  // never inherits the parent's tsx loader hooks, which a worker cannot rely
  // on, so the shim registers its own remap hook.
  if (url.pathname.endsWith('.mjs')) {
    return new Worker(url, { ...options, execArgv: ['--experimental-strip-types'] });
  }
  return new Worker(url, options);
}

function estimateBytes(exchange: LlmExchangeCompleted): number {
  try {
    return Buffer.byteLength(JSON.stringify(exchange), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface ParsedInsertResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly rejected: ReadonlyMap<string, number>;
  readonly rejectedTotal: number;
}

/** The worker is trusted code, but its answers still cross a message boundary: check their shape and arithmetic. */
function parseInsertResult(value: unknown, batchSize: number): ParsedInsertResult {
  const invalid = (): never => {
    throw new Error('Invalid insert response from LLM metrics worker');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const { inserted, duplicates, rejected } = value as Partial<Record<keyof SqliteInsertResult, unknown>>;
  if (!isCount(inserted) || !isCount(duplicates)) return invalid();
  if (typeof rejected !== 'object' || rejected === null || Array.isArray(rejected)) return invalid();
  const reasons = new Map<string, number>();
  let rejectedTotal = 0;
  for (const [reason, count] of Object.entries(rejected)) {
    if (!isCount(count) || count === 0) return invalid();
    reasons.set(reason, count);
    rejectedTotal += count;
  }
  if (inserted + duplicates + rejectedTotal !== batchSize) return invalid();
  return { inserted, duplicates, rejected: reasons, rejectedTotal };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read methods shared by the full repository and the reader-only handle. */
async function readSnapshotMaxSequence(reader: SqliteReadWorkerClient): Promise<number> {
  const value = await reader.request({ kind: 'snapshotMaxSequence' });
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid snapshot response from LLM metrics worker');
  }
  return value;
}

async function readScan(
  reader: SqliteReadWorkerClient,
  query: LlmExchangeScanQuery,
): Promise<readonly StoredLlmExchange[]> {
  const value = await reader.request({ kind: 'scan', query });
  if (!Array.isArray(value)) throw new Error('Invalid scan response from LLM metrics worker');
  return value as readonly StoredLlmExchange[];
}

async function readDimensionValues(
  reader: SqliteReadWorkerClient,
  dimension: LlmStatisticsDimension,
  query: Omit<LlmExchangeScanQuery, 'cursor'>,
): Promise<readonly LlmDimensionCount[]> {
  const value = await reader.request({ kind: 'dimensionValues', dimension, query });
  if (!Array.isArray(value)) throw new Error('Invalid dimension response from LLM metrics worker');
  return value as readonly LlmDimensionCount[];
}

async function readAggregate(
  reader: SqliteReadWorkerClient,
  query: LlmStatisticsAggregateQuery,
): Promise<readonly LlmStatisticsPartition[]> {
  const value = await reader.request({ kind: 'aggregate', query });
  if (
    !Array.isArray(value) ||
    !value.every(
      (partition: unknown) =>
        isRecord(partition) &&
        Array.isArray(partition.dimensions) &&
        Array.isArray(partition.measures) &&
        partition.measures.length === query.measures.length &&
        typeof partition.eligibleCount === 'number',
    )
  ) {
    throw new Error('Invalid aggregate response from LLM metrics worker');
  }
  return value as readonly LlmStatisticsPartition[];
}

async function readDistribution(
  reader: SqliteReadWorkerClient,
  query: LlmStatisticsDistributionQuery,
): Promise<LlmStatisticsDistributionResult> {
  const value: unknown = await reader.request({ kind: 'distribution', query });
  if (!isRecord(value) || !Array.isArray(value.bins) || typeof value.sampleCount !== 'number') {
    throw new Error('Invalid distribution response from LLM metrics worker');
  }
  return value as unknown as LlmStatisticsDistributionResult;
}

async function readSessionTotals(
  reader: SqliteReadWorkerClient,
  query: LlmSessionTotalsQuery,
): Promise<LlmSessionUsageTotalsResult> {
  const value: unknown = await reader.request({ kind: 'sessionTotals', query });
  if (!isRecord(value) || typeof value.exchanges !== 'number' || typeof value.tokenTotalsLowerBound !== 'boolean') {
    throw new Error('Invalid session totals response from LLM metrics worker');
  }
  return value as unknown as LlmSessionUsageTotalsResult;
}

const READ_TIMEOUT_MESSAGE = 'LLM metrics reader request timed out';

class SqliteReadWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  /**
   * Posted request IDs in the order the worker serves them: it runs one
   * request at a time, first in, first out. Only the head is being worked on,
   * so only its deadline runs. A request queued behind a long aggregation is
   * not timed out for waiting (which would also abort the aggregation and
   * every other queued request with it).
   */
  private readonly served: number[] = [];
  private headDeadline: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private nextRequestId = 1;
  private admittedRequests = 0;
  private ready = false;
  private closed = false;
  private state: LlmMetricsReaderState = 'idle';
  private lastError: string | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly workerFactory: WorkerFactory,
    private readonly startupTimeoutMs: number,
    private readonly requestTimeoutMs: number,
  ) {}

  async request(request: ReaderRequestWithoutId): Promise<WorkerResult> {
    if (this.closed) throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed');
    if (this.admittedRequests >= MAX_PENDING_WORKER_REQUESTS) {
      throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader request limit reached');
    }
    this.admittedRequests++;
    try {
      await this.ensureReady();
      const worker = this.worker;
      if (worker === null || !this.ready) {
        throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is unavailable');
      }

      const id = this.nextRequestId++;
      return await new Promise<WorkerResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ ...request, id } satisfies SqliteReaderWorkerRequest);
        } catch (error) {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error('Failed to send LLM metrics reader request'));
          return;
        }
        this.served.push(id);
        if (this.served.length === 1) this.armHeadDeadline(worker);
      });
    } finally {
      this.admittedRequests--;
    }
  }

  /** Start the deadline of the request the worker is now serving, if any. */
  private armHeadDeadline(worker: Worker): void {
    if (this.headDeadline !== null) clearTimeout(this.headDeadline);
    this.headDeadline = null;
    if (this.served.length === 0) return;
    const deadline = setTimeout(() => {
      if (this.headDeadline !== deadline) return;
      this.headDeadline = null;
      this.fail(worker, this.unavailable(new Error(READ_TIMEOUT_MESSAGE)));
    }, this.requestTimeoutMs);
    deadline.unref();
    this.headDeadline = deadline;
  }

  /** A request was answered: when it was the head, the next one is now being served. */
  private markAnswered(worker: Worker, id: number): void {
    const index = this.served.indexOf(id);
    if (index < 0) return;
    this.served.splice(index, 1);
    if (index === 0) this.armHeadDeadline(worker);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.state = 'closed';
    const worker = this.worker;
    if (worker === null) return Promise.resolve();
    this.detach(worker, new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed'));
    return worker.terminate().then(() => undefined);
  }

  health(): { readonly state: LlmMetricsReaderState; readonly lastError: string | null } {
    return { state: this.state, lastError: this.lastError };
  }

  private ensureReady(): Promise<void> {
    if (this.ready && this.worker !== null) return Promise.resolve();
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed');
    this.state = 'starting';
    const workerData: SqliteReaderWorkerData = { role: 'reader', databasePath: this.databasePath };
    let worker: Worker;
    try {
      worker = this.workerFactory(workerUrl(), { workerData });
    } catch (error) {
      const failure = this.unavailable(error);
      this.state = 'unavailable';
      this.lastError = sanitizeError(failure);
      throw failure;
    }
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    worker.on('message', (message: unknown) => this.onMessage(worker, message));
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', (code) => {
      if (!this.closed) this.fail(worker, new Error(`LLM metrics reader exited with code ${code}`));
    });
    const timeoutMessage = 'LLM metrics reader startup timed out';
    try {
      await withTimeout(ready, this.startupTimeoutMs, timeoutMessage);
    } catch (error) {
      const failure = this.unavailable(error);
      this.fail(worker, failure);
      throw failure;
    }
  }

  private onMessage(worker: Worker, message: unknown): void {
    if (worker !== this.worker) return;
    if (typeof message !== 'object' || message === null || !('kind' in message)) {
      this.fail(worker, new Error('Invalid response from LLM metrics reader'));
      return;
    }
    const response = message as SqliteWorkerResponse;
    if (response.kind === 'ready') {
      if (!Number.isSafeInteger(response.schemaVersion) || response.schemaVersion < 1) {
        this.fail(worker, new Error('Invalid schema response from LLM metrics reader'));
        return;
      }
      this.ready = true;
      this.state = 'ready';
      this.lastError = null;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (response.kind === 'error' && response.id === undefined) {
      this.fail(worker, new Error(response.message));
      return;
    }
    const id = response.id;
    if (id === undefined) {
      this.fail(worker, new Error('LLM metrics reader response is missing a request ID'));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    if (response.kind === 'error' && response.category !== 'invalid_request' && response.category !== 'limit') {
      this.fail(worker, new Error(response.message));
      return;
    }
    this.pending.delete(id);
    this.markAnswered(worker, id);
    if (response.kind === 'error') {
      // A rejected or over-limit query leaves the reader healthy.
      pending.reject(
        response.category === 'limit' && response.limit !== undefined
          ? new StatisticsLimitError(response.limit.name, response.limit.maximum, response.message)
          : new Error(response.message),
      );
    } else {
      pending.resolve(response.value);
    }
  }

  private fail(worker: Worker, error: unknown): void {
    if (worker !== this.worker) return;
    this.detach(worker, error);
    void worker.terminate();
  }

  private detach(worker: Worker, error: unknown): void {
    if (worker !== this.worker) return;
    const failure = this.unavailable(error);
    this.worker = null;
    this.ready = false;
    if (this.headDeadline !== null) clearTimeout(this.headDeadline);
    this.headDeadline = null;
    this.served.length = 0;
    if (!this.closed) {
      this.state = 'unavailable';
      this.lastError = sanitizeError(failure);
    }
    this.rejectReady?.(failure);
    this.resolveReady = null;
    this.rejectReady = null;
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
  }

  private unavailable(error: unknown): LlmMetricsRepositoryUnavailableError {
    if (error instanceof LlmMetricsRepositoryUnavailableError) return error;
    return new LlmMetricsRepositoryUnavailableError(sanitizeError(error));
  }
}

/**
 * Main-thread half of the SQLite repository. All SQLite work runs in a worker;
 * enqueue is bounded, synchronous in-memory work and deliberately fail-open.
 *
 * The writer worker is supervised. When it exits, throws, cannot start, or
 * misses a per-request deadline, the repository enters `restarting`: the
 * bounded queue keeps accepting, the unacknowledged batch goes back to its
 * head (inserts are idempotent by exchange id), and a replacement worker
 * starts after an exponential backoff (1 s doubling to 5 min). Each worker
 * re-runs the full startup: migrations, the schema compatibility check, and
 * the process-run start marker, under the same process run so its checkpoint
 * counters stay monotonic. Persistence latches `disabled` only for failures no
 * restart can repair: an incompatible schema, a corrupt database, or a
 * permission error. State transitions are logged, rate-limited.
 */
export class SqliteLlmMetricsRepository implements LlmMetricsRepository {
  private readonly reader: SqliteReadWorkerClient;
  private readonly workerFactory: WorkerFactory;
  private readonly workerData: SqliteWriterWorkerData;
  private readonly healthLog: RateLimitedLog;
  private readonly queue: QueuedExchange[] = [];
  private readonly inFlight = new Set<InFlightBatch>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly invalidByReason = new Map<string, number>();
  private readonly maxQueuedRecords: number;
  private readonly maxQueuedBytes: number;
  private readonly maxRecordBytes: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly checkpointIntervalMs: number;
  private readonly writeTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly busyRetryDelayMs: number;
  private readonly firstStartup: Promise<void>;
  private resolveFirstStartup: (() => void) | null = null;
  private worker: Worker | null = null;
  private writerReady = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  /** Set by a busy batch: the next scheduled flush waits this long instead of the flush interval. */
  private retryDelayMs: number | null = null;
  private activeFlush: Promise<void> | null = null;
  private activeClose: Promise<void> | null = null;
  private activeDelete: ActiveDelete | null = null;
  private nextRequestId = 1;
  /** Consecutive writer failures; reset once a worker answers a request. */
  private restartAttempt = 0;
  private writerRestarts = 0;
  private state: LlmMetricsRepositoryState = 'starting';
  private schemaVersion: number | null = null;
  private observed = 0;
  private finalized = 0;
  private enqueued = 0;
  private persisted = 0;
  private duplicates = 0;
  private dropped = 0;
  private queuedBytes = 0;
  private inFlightRecords = 0;
  private inFlightBytes = 0;
  private lastError: string | null = null;
  private closing = false;

  private constructor(options: SqliteLlmMetricsRepositoryOptions) {
    if (options.databasePath.length === 0) throw new Error('databasePath is required');
    this.maxQueuedRecords = positiveInteger(options.maxQueuedRecords, DEFAULT_MAX_QUEUED_RECORDS, 'maxQueuedRecords');
    this.maxQueuedBytes = positiveInteger(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, 'maxQueuedBytes');
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes');
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 'batchSize');
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 'flushIntervalMs');
    this.checkpointIntervalMs = positiveInteger(
      options.checkpointIntervalMs,
      DEFAULT_CHECKPOINT_INTERVAL_MS,
      'checkpointIntervalMs',
    );
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs');
    this.writeTimeoutMs = positiveInteger(options.writeTimeoutMs, DEFAULT_WRITE_TIMEOUT_MS, 'writeTimeoutMs');
    this.readTimeoutMs = positiveInteger(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs');
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');
    this.restartDelayMs = positiveInteger(options.restartDelayMs, DEFAULT_RESTART_DELAY_MS, 'restartDelayMs');
    this.maxRestartDelayMs = positiveInteger(
      options.maxRestartDelayMs,
      Math.max(DEFAULT_MAX_RESTART_DELAY_MS, this.restartDelayMs),
      'maxRestartDelayMs',
    );
    if (this.maxRestartDelayMs < this.restartDelayMs) throw new Error('maxRestartDelayMs must cover restartDelayMs');
    this.busyRetryDelayMs = positiveInteger(options.busyRetryDelayMs, DEFAULT_BUSY_RETRY_DELAY_MS, 'busyRetryDelayMs');
    const processRunId = options.processRunId ?? randomUUID();
    if (processRunId.length > STATISTICS_IDENTIFIER_MAX_LENGTH || !STATISTICS_IDENTIFIER_PATTERN.test(processRunId)) {
      throw new Error('Invalid processRunId');
    }

    this.healthLog = createRateLimitedLog({
      intervalMs: HEALTH_LOG_INTERVAL_MS,
      sink: options.logSink ?? projectLogSink,
    });
    this.reader = new SqliteReadWorkerClient(
      options.databasePath,
      options.readWorkerFactory ?? defaultWorkerFactory,
      this.startupTimeoutMs,
      this.readTimeoutMs,
    );

    this.firstStartup = new Promise<void>((resolve) => {
      this.resolveFirstStartup = resolve;
    });
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.workerData = {
      role: 'writer',
      databasePath: options.databasePath,
      processRunId,
      startedAtMs: Date.now(),
    };
    this.spawnWriter();
  }

  /**
   * Resolves once the first writer is ready, has failed and is restarting, or
   * has latched persistence off. Opening never throws for storage failures;
   * health reports them.
   */
  static async open(options: SqliteLlmMetricsRepositoryOptions): Promise<SqliteLlmMetricsRepository> {
    const repository = new SqliteLlmMetricsRepository(options);
    await repository.firstStartup;
    return repository;
  }

  enqueue(exchange: LlmExchangeCompleted): boolean {
    this.observed++;
    this.finalized++;
    if (!this.acceptingWrites()) {
      this.dropped++;
      return false;
    }

    const bytes = estimateBytes(exchange);
    const totalRecords = this.queue.length + this.inFlightRecords;
    const totalBytes = this.queuedBytes + this.inFlightBytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > this.maxRecordBytes ||
      totalRecords >= this.maxQueuedRecords ||
      totalBytes + bytes > this.maxQueuedBytes
    ) {
      this.dropped++;
      return false;
    }

    this.queue.push({ exchange, bytes, attempts: 0 });
    this.queuedBytes += bytes;
    this.enqueued++;
    // While the writer restarts the queue only accumulates; readiness flushes it.
    if (this.writerAvailable()) this.scheduleFlush();
    return true;
  }

  /**
   * Drains the queue batch by batch; each batch has its own request deadline.
   * A drain that is already running may be past its last queue check (it ends
   * by awaiting a checkpoint), so it does not cover records enqueued since:
   * they would wait for the next scheduled flush, or be dropped by close. A
   * call made during a drain therefore waits for it, then drains whatever is
   * still queued.
   */
  async flush(): Promise<void> {
    const running = this.activeFlush;
    if (running !== null) {
      await running;
      // A drain started meanwhile began after this call, so it covers this caller's records too.
      if (this.activeFlush !== null) return this.activeFlush;
      if (this.queue.length === 0) return;
    }
    this.clearFlushTimer();
    this.activeFlush = this.drainQueue()
      .catch((error: unknown) => this.markDegraded(error))
      .finally(() => {
        this.activeFlush = null;
        const retryDelayMs = this.retryDelayMs;
        this.retryDelayMs = null;
        if (this.queue.length > 0 && this.writerAvailable()) this.scheduleFlush(retryDelayMs ?? this.flushIntervalMs);
      });
    return this.activeFlush;
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    this.activeClose ??= this.performClose();
    return this.activeClose;
  }

  private async performClose(): Promise<void> {
    const startedAt = performance.now();
    this.closing = true;
    const readerClose = this.reader.close().catch(() => undefined);
    this.clearFlushTimer();
    this.clearRestartTimer();
    this.clearCheckpointTimer();
    this.retryDelayMs = null;
    try {
      await withTimeout(
        (async () => {
          await this.flush();
          if (!this.writerAvailable()) return;
          await this.request({
            kind: 'close',
            cleanEndedAtMs: Date.now(),
            observed: this.observed,
            finalized: this.finalized,
            enqueued: this.enqueued,
          });
        })(),
        this.closeTimeoutMs,
        'LLM metrics worker close timed out',
      );
    } catch (error) {
      this.lastError = sanitizeError(error);
      this.healthLog.emit('close', 'warn', `[llm-metrics] Statistics writer did not close cleanly: ${this.lastError}`);
    }
    // Whatever was not written by now is lost with this process.
    this.dropUnwritten();
    const remainingCloseMs = Math.max(1, Math.floor(this.closeTimeoutMs - (performance.now() - startedAt)));
    await withTimeout(readerClose, remainingCloseMs, 'LLM metrics reader close timed out').catch(() => undefined);
    this.rejectPending(new LlmMetricsRepositoryUnavailableError('LLM metrics repository closed'));
    const worker = this.worker;
    this.detachWriter();
    if (worker !== null) void worker.terminate();
    this.state = 'closed';
    this.settleFirstStartup();
  }

  health(): LlmMetricsRepositoryHealth {
    const readerHealth = this.reader.health();
    return {
      state: this.state,
      schemaVersion: this.schemaVersion,
      observed: this.observed,
      finalized: this.finalized,
      enqueued: this.enqueued,
      persisted: this.persisted,
      duplicates: this.duplicates,
      dropped: this.dropped,
      queuedRecords: this.queue.length + this.inFlightRecords,
      queuedBytes: this.queuedBytes + this.inFlightBytes,
      lastError: this.lastError,
      writerRestarts: this.writerRestarts,
      invalidByReason: Object.freeze(Object.fromEntries(this.invalidByReason)),
      readerState: readerHealth.state,
      readerLastError: readerHealth.lastError,
    };
  }

  snapshotMaxSequence(): Promise<number> {
    return readSnapshotMaxSequence(this.reader);
  }

  scan(query: LlmExchangeScanQuery): Promise<readonly StoredLlmExchange[]> {
    return readScan(this.reader, query);
  }

  dimensionValues(
    dimension: LlmStatisticsDimension,
    query: Omit<LlmExchangeScanQuery, 'cursor'>,
  ): Promise<readonly LlmDimensionCount[]> {
    return readDimensionValues(this.reader, dimension, query);
  }

  aggregate(query: LlmStatisticsAggregateQuery): Promise<readonly LlmStatisticsPartition[]> {
    return readAggregate(this.reader, query);
  }

  distribution(query: LlmStatisticsDistributionQuery): Promise<LlmStatisticsDistributionResult> {
    return readDistribution(this.reader, query);
  }

  sessionTotals(query: LlmSessionTotalsQuery): Promise<LlmSessionUsageTotalsResult> {
    return readSessionTotals(this.reader, query);
  }

  async deleteBefore(cutoffMs: number, options: LlmDeleteBeforeOptions = {}): Promise<LlmDeleteBeforeResult> {
    this.assertWriterAvailable();
    if (this.closing) throw new LlmMetricsRepositoryUnavailableError('LLM metrics repository is closing');
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error('Invalid delete cutoff');
    const snapshotMaxSequence =
      options.snapshotMaxSequence === undefined
        ? undefined
        : boundedInteger(options.snapshotMaxSequence, 0, 0, Number.MAX_SAFE_INTEGER, 'delete snapshotMaxSequence');

    const chunkSize = boundedInteger(
      options.chunkSize,
      DEFAULT_DELETE_CHUNK_SIZE,
      1,
      MAX_DELETE_CHUNK_SIZE,
      'delete chunkSize',
    );
    const maxRows = boundedInteger(options.maxRows, DEFAULT_DELETE_MAX_ROWS, 1, MAX_DELETE_ROWS, 'delete maxRows');
    const maxDurationMs = boundedInteger(
      options.maxDurationMs,
      DEFAULT_DELETE_MAX_DURATION_MS,
      MIN_DELETE_DURATION_MS,
      MAX_DELETE_DURATION_MS,
      'delete maxDurationMs',
    );
    const leaseDurationMs = boundedInteger(
      options.leaseDurationMs,
      DEFAULT_MAINTENANCE_LEASE_MS,
      MIN_MAINTENANCE_LEASE_MS,
      MAX_MAINTENANCE_LEASE_MS,
      'delete leaseDurationMs',
    );
    if (leaseDurationMs < maxDurationMs) throw new Error('delete leaseDurationMs must cover maxDurationMs');

    if (this.activeDelete !== null) {
      return Promise.resolve({
        status: 'busy',
        cutoffMs,
        snapshotMaxSequence: null,
        deletedCount: 0,
        chunksProcessed: 0,
      });
    }

    const activity: ActiveDelete = { callerSettled: false, outstandingRequests: 0 };
    this.activeDelete = activity;
    return this.performDeleteBefore(
      cutoffMs,
      snapshotMaxSequence,
      chunkSize,
      maxRows,
      maxDurationMs,
      leaseDurationMs,
      activity,
    )
      .catch((error: unknown) => {
        this.markDegraded(error);
        throw error;
      })
      .finally(() => {
        activity.callerSettled = true;
        this.maybeClearActiveDelete(activity);
      });
  }

  private async performDeleteBefore(
    cutoffMs: number,
    requestedSnapshotMaxSequence: number | undefined,
    chunkSize: number,
    maxRows: number,
    maxDurationMs: number,
    leaseDurationMs: number,
    activity: ActiveDelete,
  ): Promise<LlmDeleteBeforeResult> {
    const startedAt = performance.now();
    const release = { needed: false, detached: false };
    try {
      const leaseTimeoutMessage = 'LLM metrics retention lease acquisition timed out';
      let leaseValue: WorkerResult;
      try {
        leaseValue = await this.boundedMaintenanceRequest(
          activity,
          {
            kind: 'beginDeleteBefore',
            leaseName: DELETE_LEASE_NAME,
            cutoffMs,
            snapshotMaxSequence: requestedSnapshotMaxSequence,
            leaseDurationMs,
          },
          maxDurationMs,
          leaseTimeoutMessage,
        );
      } catch (error) {
        if (error instanceof Error && error.message === leaseTimeoutMessage) {
          release.needed = true;
          release.detached = true;
        }
        throw error;
      }
      if (!this.isDeleteLeaseResult(leaseValue)) {
        throw new Error('Invalid retention lease response from LLM metrics worker');
      }
      if (!leaseValue.acquired) {
        return {
          status: 'busy',
          cutoffMs,
          snapshotMaxSequence: null,
          deletedCount: 0,
          chunksProcessed: 0,
        };
      }
      release.needed = true;
      const snapshotMaxSequence = leaseValue.snapshotMaxSequence;
      if (snapshotMaxSequence === null || snapshotMaxSequence === 0) {
        return {
          status: 'complete',
          cutoffMs,
          snapshotMaxSequence,
          deletedCount: 0,
          chunksProcessed: 0,
        };
      }

      let deletedCount = 0;
      let chunksProcessed = 0;
      while (deletedCount < maxRows) {
        const remainingDurationMs = Math.floor(maxDurationMs - (performance.now() - startedAt));
        if (remainingDurationMs < 1) {
          return {
            status: 'partial',
            cutoffMs,
            snapshotMaxSequence,
            deletedCount,
            chunksProcessed,
          };
        }

        const chunkTimeoutMessage = 'LLM metrics retention chunk timed out';
        let chunkValue: WorkerResult;
        try {
          chunkValue = await this.boundedMaintenanceRequest(
            activity,
            {
              kind: 'deleteBeforeChunk',
              leaseName: DELETE_LEASE_NAME,
              cutoffMs,
              snapshotMaxSequence,
              chunkSize: Math.min(chunkSize, maxRows - deletedCount),
              leaseDurationMs,
            },
            remainingDurationMs,
            chunkTimeoutMessage,
          );
        } catch (error) {
          if (error instanceof Error && error.message === chunkTimeoutMessage) release.detached = true;
          throw error;
        }
        if (!this.isDeleteChunkResult(chunkValue)) {
          throw new Error('Invalid retention chunk response from LLM metrics worker');
        }
        deletedCount += chunkValue.deleted;
        chunksProcessed++;
        if (!chunkValue.hasMore) {
          return {
            status: 'complete',
            cutoffMs,
            snapshotMaxSequence,
            deletedCount,
            chunksProcessed,
          };
        }
        if (deletedCount >= maxRows) break;
        await yieldToEventLoop();
      }

      return {
        status: 'partial',
        cutoffMs,
        snapshotMaxSequence,
        deletedCount,
        chunksProcessed,
      };
    } finally {
      // A writer lost meanwhile cannot release the lease; it expires on its
      // own, and a restarted writer of this process run may take it again.
      if (release.needed && this.writerAvailable()) {
        const cleanup = this.boundedMaintenanceRequest(
          activity,
          { kind: 'releaseMaintenanceLease', leaseName: DELETE_LEASE_NAME },
          MAINTENANCE_RELEASE_TIMEOUT_MS,
          'LLM metrics retention lease release timed out',
        ).catch((error: unknown) => this.markDegraded(error));
        if (release.detached) void cleanup;
        else await cleanup;
      }
    }
  }

  private async boundedMaintenanceRequest(
    activity: ActiveDelete,
    request: WriterRequestWithoutId,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<WorkerResult> {
    const underlying = this.trackMaintenanceRequest(activity, this.request(request));
    const result = await withTimeout(underlying, timeoutMs, timeoutMessage);
    this.markReady();
    return result;
  }

  private trackMaintenanceRequest(activity: ActiveDelete, request: Promise<WorkerResult>): Promise<WorkerResult> {
    activity.outstandingRequests++;
    void request.then(
      () => this.settleMaintenanceRequest(activity),
      () => this.settleMaintenanceRequest(activity),
    );
    return request;
  }

  private settleMaintenanceRequest(activity: ActiveDelete): void {
    activity.outstandingRequests = Math.max(0, activity.outstandingRequests - 1);
    this.maybeClearActiveDelete(activity);
  }

  private maybeClearActiveDelete(activity: ActiveDelete): void {
    if (this.activeDelete === activity && activity.callerSettled && activity.outstandingRequests === 0) {
      this.activeDelete = null;
    }
  }

  private isDeleteLeaseResult(value: WorkerResult): value is SqliteDeleteLeaseResult {
    return (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      'acquired' in value &&
      typeof value.acquired === 'boolean' &&
      'snapshotMaxSequence' in value &&
      (value.snapshotMaxSequence === null ||
        (typeof value.snapshotMaxSequence === 'number' &&
          Number.isSafeInteger(value.snapshotMaxSequence) &&
          value.snapshotMaxSequence >= 0))
    );
  }

  private isDeleteChunkResult(value: WorkerResult): value is SqliteDeleteChunkResult {
    return (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      'deleted' in value &&
      typeof value.deleted === 'number' &&
      Number.isSafeInteger(value.deleted) &&
      value.deleted >= 0 &&
      'hasMore' in value &&
      typeof value.hasMore === 'boolean'
    );
  }

  /** Records are queued while the writer starts, runs, or restarts; never once it is latched off or closing. */
  private acceptingWrites(): boolean {
    return (
      !this.closing &&
      (this.state === 'starting' || this.state === 'ready' || this.state === 'degraded' || this.state === 'restarting')
    );
  }

  /** A ready worker is attached and can take requests. */
  private writerAvailable(): boolean {
    return this.worker !== null && this.writerReady && (this.state === 'ready' || this.state === 'degraded');
  }

  private assertWriterAvailable(): void {
    if (!this.writerAvailable()) {
      throw new LlmMetricsRepositoryUnavailableError(this.lastError ?? undefined);
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && this.writerAvailable()) {
      const batch = this.takeBatch();
      try {
        const value = await this.request({
          kind: 'insert',
          exchanges: batch.items.map((item) => item.exchange),
        });
        const result = parseInsertResult(value, batch.items.length);
        if (this.settleBatch(batch)) this.recordInsertResult(result);
      } catch (error) {
        // A lost writer requeued the batch, a latched or closing repository
        // dropped it; either way it has been accounted for already.
        if (batch.settled) break;
        if (error instanceof WriterRequestError && error.code === 'busy') {
          // Busy beyond the worker's own bounded retries: back to the head,
          // retried after a backoff, still inside the queue bounds.
          const attempt = Math.max(...batch.items.map((item) => item.attempts)) + 1;
          this.requeueBatch(batch);
          this.retryDelayMs = this.busyRetryDelayMs * 2 ** Math.min(attempt - 1, MAX_BUSY_RETRY_BACKOFF_EXPONENT);
          this.markDegraded(error);
          break;
        }
        this.dropBatch(batch);
        this.markDegraded(error);
      }
    }
    await this.checkpoint();
  }

  private recordInsertResult(result: ParsedInsertResult): void {
    this.persisted += result.inserted;
    this.duplicates += result.duplicates;
    if (result.rejectedTotal === 0) {
      this.markReady();
      return;
    }
    this.dropped += result.rejectedTotal;
    const reasons: string[] = [];
    for (const [reason, count] of result.rejected) {
      this.countInvalid(reason, count);
      reasons.push(`${reason} (${count})`);
    }
    const summary = `Dropped ${result.rejectedTotal} invalid statistics record(s): ${reasons.join('; ')}`;
    this.markDegraded(new Error(summary), false);
    this.healthLog.emit('invalid', 'warn', `[llm-metrics] ${this.lastError ?? summary}`);
  }

  private countInvalid(reason: string, count: number): void {
    const bounded = reason.substring(0, MAX_INVALID_REASON_LENGTH);
    const key =
      this.invalidByReason.has(bounded) || this.invalidByReason.size < MAX_INVALID_REASONS - 1
        ? bounded
        : OTHER_INVALID_REASON;
    this.invalidByReason.set(key, (this.invalidByReason.get(key) ?? 0) + count);
  }

  private takeBatch(): InFlightBatch {
    const items = this.queue.splice(0, this.batchSize);
    const bytes = items.reduce((total, item) => total + item.bytes, 0);
    this.queuedBytes -= bytes;
    this.inFlightRecords += items.length;
    this.inFlightBytes += bytes;
    const batch: InFlightBatch = { items, bytes, settled: false };
    this.inFlight.add(batch);
    return batch;
  }

  /** Marks the batch's single outcome; false when another path already settled it. */
  private settleBatch(batch: InFlightBatch): boolean {
    if (batch.settled) return false;
    batch.settled = true;
    this.inFlight.delete(batch);
    this.inFlightRecords = Math.max(0, this.inFlightRecords - batch.items.length);
    this.inFlightBytes = Math.max(0, this.inFlightBytes - batch.bytes);
    return true;
  }

  private dropBatch(batch: InFlightBatch): void {
    if (this.settleBatch(batch)) this.dropped += batch.items.length;
  }

  /**
   * Returns a batch to the head of the queue. Its records already count
   * toward the queue bounds, so requeueing cannot grow the queue; a record
   * that has used up its write attempts is dropped instead.
   */
  private requeueBatch(batch: InFlightBatch): void {
    if (!this.settleBatch(batch)) return;
    const retry: QueuedExchange[] = [];
    let exhausted = 0;
    for (const item of batch.items) {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_RECORD_WRITE_ATTEMPTS) exhausted++;
      else retry.push({ ...item, attempts });
    }
    this.queue.unshift(...retry);
    this.queuedBytes += retry.reduce((total, item) => total + item.bytes, 0);
    if (exhausted > 0) {
      this.dropped += exhausted;
      this.healthLog.emit(
        'exhausted',
        'warn',
        `[llm-metrics] Dropped ${exhausted} statistics record(s) after ${MAX_RECORD_WRITE_ATTEMPTS} failed write attempts`,
      );
    }
  }

  /** Drops everything not yet written: the queue and any unacknowledged batch. */
  private dropUnwritten(): void {
    for (const batch of [...this.inFlight]) this.dropBatch(batch);
    this.dropped += this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private scheduleFlush(delayMs = this.flushIntervalMs): void {
    if (this.flushTimer !== null || this.activeFlush !== null || this.closing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private ensureCheckpointTimer(): void {
    if (this.checkpointTimer !== null || this.closing) return;
    this.checkpointTimer = setInterval(() => void this.checkpoint(), this.checkpointIntervalMs);
    this.checkpointTimer.unref();
  }

  private clearCheckpointTimer(): void {
    if (this.checkpointTimer !== null) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async checkpoint(): Promise<void> {
    if (!this.writerAvailable()) return;
    try {
      await this.request({
        kind: 'checkpoint',
        observed: this.observed,
        finalized: this.finalized,
        enqueued: this.enqueued,
        checkpointAtMs: Date.now(),
      });
    } catch (error) {
      this.markDegraded(error);
    }
  }

  /**
   * Sends one request to the current writer with its own deadline. A worker
   * that misses the deadline is treated as wedged and replaced; this request
   * is rejected through that failure path.
   */
  private request(request: WriterRequestWithoutId): Promise<WorkerResult> {
    const worker = this.worker;
    if (worker === null || !this.writerAvailable()) {
      return Promise.reject(new LlmMetricsRepositoryUnavailableError(this.lastError ?? undefined));
    }
    if (this.pending.size >= MAX_PENDING_WORKER_REQUESTS) {
      return Promise.reject(new LlmMetricsRepositoryUnavailableError('LLM metrics worker request limit reached'));
    }
    const id = this.nextRequestId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.onWriterFailure(worker, new Error(`LLM metrics worker ${request.kind} request timed out`));
      }, this.writeTimeoutMs);
      deadline.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      });
      try {
        worker.postMessage({ ...request, id } satisfies SqliteWorkerRequest);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error instanceof Error ? error : new Error('Failed to send LLM metrics worker request'));
      }
    });
  }

  private spawnWriter(): void {
    let worker: Worker;
    try {
      worker = this.workerFactory(workerUrl(), { workerData: this.workerData });
    } catch (error) {
      this.scheduleRestart(error);
      return;
    }
    this.worker = worker;
    this.writerReady = false;
    worker.on('message', (message: unknown) => this.onWorkerMessage(worker, message));
    worker.on('error', (error) => this.onWriterFailure(worker, error));
    worker.on('exit', (code) => this.onWriterFailure(worker, new Error(`LLM metrics worker exited with code ${code}`)));
    this.startupTimer = setTimeout(
      () => this.onWriterFailure(worker, new Error('LLM metrics worker startup timed out')),
      this.startupTimeoutMs,
    );
    this.startupTimer.unref();
  }

  private onWorkerMessage(worker: Worker, message: unknown): void {
    if (worker !== this.worker) return;
    if (typeof message !== 'object' || message === null || !('kind' in message)) {
      this.onWriterFailure(worker, new Error('Invalid response from LLM metrics worker'));
      return;
    }
    const response = message as SqliteWorkerResponse;
    if (response.kind === 'ready') {
      this.onWriterReady(worker, response.schemaVersion);
      return;
    }
    if (response.kind === 'error' && response.id === undefined) {
      // Startup failed; the worker exits after reporting it.
      this.onWriterFailure(worker, new Error(response.message), response.code);
      return;
    }
    const id = response.id;
    if (id === undefined) {
      this.onWriterFailure(worker, new Error('LLM metrics worker response is missing a request ID'));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    // A worker that answers requests is healthy again.
    this.restartAttempt = 0;
    if (response.kind === 'error') {
      const error = new WriterRequestError(response.message, response.code);
      pending.reject(error);
      if (isPermanentStorageError(response.code)) this.disable(error);
      return;
    }
    pending.resolve(response.value);
  }

  private onWriterReady(worker: Worker, schemaVersion: unknown): void {
    // A replacement that finishes starting during close is terminated with it.
    if (this.writerReady || this.closing) return;
    if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      this.onWriterFailure(worker, new Error('Invalid schema response from LLM metrics worker'));
      return;
    }
    this.clearStartupTimer();
    this.writerReady = true;
    this.schemaVersion = schemaVersion;
    this.transition('ready');
    this.ensureCheckpointTimer();
    this.settleFirstStartup();
    if (this.queue.length > 0) this.scheduleFlush(0);
  }

  /**
   * The current writer exited, threw, could not start, or missed a deadline.
   * Its unacknowledged batch goes back to the queue (inserts are idempotent by
   * exchange id) and a replacement is scheduled, unless the failure is one no
   * restart can repair.
   */
  private onWriterFailure(worker: Worker, error: unknown, code?: LlmMetricsStorageErrorCode): void {
    if (worker !== this.worker) return;
    if (isPermanentStorageError(code) && !this.closing) {
      this.disable(error);
      return;
    }
    this.detachWriter();
    for (const batch of [...this.inFlight].reverse()) this.requeueBatch(batch);
    this.rejectPending(new LlmMetricsRepositoryUnavailableError(sanitizeError(error)));
    void worker.terminate();
    if (this.closing || this.state === 'closed' || this.state === 'disabled') return;
    this.scheduleRestart(error);
  }

  private scheduleRestart(error: unknown): void {
    const exponent = Math.min(this.restartAttempt, MAX_RESTART_BACKOFF_EXPONENT);
    const delayMs = Math.min(this.restartDelayMs * 2 ** exponent, this.maxRestartDelayMs);
    this.restartAttempt++;
    this.transition('restarting', error, delayMs);
    this.settleFirstStartup();
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closing || this.state !== 'restarting') return;
      this.writerRestarts++;
      this.spawnWriter();
    }, delayMs);
    this.restartTimer.unref();
  }

  private detachWriter(): void {
    this.worker = null;
    this.writerReady = false;
    this.clearStartupTimer();
  }

  /** Latches persistence off for a failure no restart can repair. */
  private disable(error: unknown): void {
    if (this.state === 'closed' || this.state === 'disabled') return;
    const worker = this.worker;
    this.detachWriter();
    this.clearRestartTimer();
    this.clearFlushTimer();
    this.clearCheckpointTimer();
    this.retryDelayMs = null;
    this.transition('disabled', error);
    this.dropUnwritten();
    this.rejectPending(new LlmMetricsRepositoryUnavailableError(this.lastError ?? undefined));
    this.settleFirstStartup();
    if (worker !== null) void worker.terminate();
  }

  private markReady(): void {
    if (this.state === 'degraded') this.transition('ready');
  }

  /** A failed operation on a running writer; ignored while the writer is restarting, latched, or closed. */
  private markDegraded(error: unknown, log = true): void {
    if (this.state !== 'ready' && this.state !== 'degraded') return;
    this.transition('degraded', error, undefined, log);
  }

  private transition(next: LlmMetricsRepositoryState, error?: unknown, restartDelayMs?: number, log = true): void {
    const previous = this.state;
    this.state = next;
    if (error !== undefined) this.lastError = sanitizeError(error);
    else if (next === 'ready') this.lastError = null;
    if (!log) return;
    const reason = this.lastError ?? 'unknown error';
    if (next === 'restarting') {
      this.healthLog.emit(
        'restarting',
        'warn',
        `[llm-metrics] Statistics writer unavailable (${reason}); restarting it in ${restartDelayMs ?? 0} ms, ` +
          'queued records are kept within the queue bounds',
      );
    } else if (next === 'disabled') {
      this.healthLog.emit('disabled', 'error', `[llm-metrics] Statistics persistence disabled: ${reason}`);
    } else if (next === 'degraded' && previous === 'ready') {
      this.healthLog.emit('degraded', 'warn', `[llm-metrics] Statistics writer degraded: ${reason}`);
    } else if (next === 'ready' && previous === 'restarting') {
      this.healthLog.emit(
        'recovered',
        'info',
        `[llm-metrics] Statistics writer running again after ${this.writerRestarts} restart(s)`,
      );
    } else if (next === 'ready' && previous === 'degraded') {
      this.healthLog.emit('recovered', 'info', '[llm-metrics] Statistics writer recovered');
    }
  }

  private settleFirstStartup(): void {
    this.resolveFirstStartup?.();
    this.resolveFirstStartup = null;
  }

  private rejectPending(error: Error): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) request.reject(error);
  }
}

export async function openSqliteLlmMetricsRepository(
  options: SqliteLlmMetricsRepositoryOptions,
): Promise<SqliteLlmMetricsRepository> {
  return SqliteLlmMetricsRepository.open(options);
}

export interface SqliteLlmMetricsReaderOptions {
  readonly databasePath: string;
  readonly startupTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  /** Reader test seam; production callers should use the default worker implementation. */
  readonly readWorkerFactory?: WorkerFactory;
}

/** A read-only statistics handle that never writes (no writer worker, no process-run marker). */
export interface SqliteLlmMetricsReader extends LlmMetricsReadRepository {
  close(): Promise<void>;
}

/**
 * Open only the reader worker, for local read paths such as
 * `ironcurtain statistics summary`. The worker starts lazily on first read
 * and opens the database read-only.
 */
export function openSqliteLlmMetricsReader(options: SqliteLlmMetricsReaderOptions): SqliteLlmMetricsReader {
  if (options.databasePath.length === 0) throw new Error('databasePath is required');
  const reader = new SqliteReadWorkerClient(
    options.databasePath,
    options.readWorkerFactory ?? defaultWorkerFactory,
    positiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs'),
    positiveInteger(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs'),
  );
  return Object.freeze({
    // This handle has no writer: report one that never started or restarted.
    health: (): LlmMetricsRepositoryHealth => {
      const readerHealth = reader.health();
      return {
        state: 'disabled',
        schemaVersion: null,
        observed: 0,
        finalized: 0,
        enqueued: 0,
        persisted: 0,
        duplicates: 0,
        dropped: 0,
        queuedRecords: 0,
        queuedBytes: 0,
        lastError: null,
        writerRestarts: 0,
        invalidByReason: Object.freeze({}),
        readerState: readerHealth.state,
        readerLastError: readerHealth.lastError,
      };
    },
    snapshotMaxSequence: () => readSnapshotMaxSequence(reader),
    scan: (query: LlmExchangeScanQuery) => readScan(reader, query),
    dimensionValues: (dimension: LlmStatisticsDimension, query: Omit<LlmExchangeScanQuery, 'cursor'>) =>
      readDimensionValues(reader, dimension, query),
    aggregate: (query: LlmStatisticsAggregateQuery) => readAggregate(reader, query),
    distribution: (query: LlmStatisticsDistributionQuery) => readDistribution(reader, query),
    sessionTotals: (query: LlmSessionTotalsQuery) => readSessionTotals(reader, query),
    close: () => reader.close(),
  });
}
