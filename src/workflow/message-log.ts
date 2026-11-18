import { appendFileSync, constants as fsConstants, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { open as openFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TransientFailureKind } from '../docker/agent-adapter.js';
import type { TerminalWorkflowPhase } from './terminal-phase.js';
import type { WorkflowBudget } from './resource-budget.js';

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

interface BaseEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
}

/** Declares that a newly-started attempt will emit a terminal phase barrier. */
interface RunStartedControlEntry extends BaseEntry {
  readonly type: 'run_started';
  readonly resourceBudget?: WorkflowBudget;
}

/**
 * Internal attempt boundary. It deliberately is not part of MessageLogEntry:
 * callers reading the public message history should not have to understand
 * workflow-control records.
 */
interface RunResumedControlEntry extends BaseEntry {
  readonly type: 'run_resumed';
  readonly resourceBudget?: WorkflowBudget;
  readonly useCurrentBudget?: boolean;
  readonly originalBudgetUnknown?: boolean;
  /** mtime of the checkpoint being resumed, used to reject stale terminal data. */
  readonly checkpointMtimeMs?: number;
  /** Exact digest of the checkpoint being resumed (preferred over mtimes). */
  readonly checkpointFingerprint?: string;
}

/** Durable ordering barrier written after the terminal checkpoint attempt. */
interface RunTerminalControlEntry extends BaseEntry {
  readonly type: 'run_terminal';
  readonly phase: TerminalWorkflowPhase;
}

export interface AgentSentEntry extends BaseEntry {
  readonly type: 'agent_sent';
  readonly role: string;
  readonly message: string;
}

export interface AgentReceivedEntry extends BaseEntry {
  readonly type: 'agent_received';
  readonly role: string;
  readonly message: string;
  readonly verdict: string | null;
  readonly confidence: string | null;
}

/**
 * Why the orchestrator sent an agent another turn. `missing_commit`: under
 * the commit-tool protocol the turn ended without an accepted
 * `workflow_commit` call, so the state had not committed.
 */
export type AgentRetryReason =
  | 'missing_status_block'
  | 'malformed_status_block'
  | 'missing_commit'
  | 'missing_artifacts'
  | 'invalid_verdict'
  | 'upstream_stall';

export interface AgentRetryEntry extends BaseEntry {
  readonly type: 'agent_retry';
  readonly role: string;
  readonly reason: AgentRetryReason;
  readonly details: string;
  readonly retryMessage: string;
}

export interface GateRaisedEntry extends BaseEntry {
  readonly type: 'gate_raised';
  /** Per-raise gate id (`HumanGateRequest.gateId`); absent on logs written before per-raise ids existed. */
  readonly gateId?: string;
  readonly acceptedEvents: readonly string[];
}

export interface GateResolvedEntry extends BaseEntry {
  readonly type: 'gate_resolved';
  /** Id of the raise the decision was validated against; absent on legacy logs. */
  readonly gateId?: string;
  readonly event: string;
  readonly prompt: string | null;
  /**
   * Channel the decider declared (`web-ui`, `cli`, `signal`, or `rpc` for an
   * undeclared JSON-RPC caller); absent on legacy logs. Declared, not
   * authenticated: every daemon client shares one bearer token.
   */
  readonly resolvedBy?: string;
}

/**
 * A policy-escalated tool call raised to the workflow's human route, and
 * how it ended. One `raised` entry per escalation, followed by exactly one
 * of `approved` / `denied` / `expired` (timeout or cancellation).
 */
export interface ToolCallEscalationEntry extends BaseEntry {
  readonly type: 'tool_call_escalation';
  readonly escalationId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly reason: string;
  readonly outcome: 'raised' | 'approved' | 'denied' | 'expired';
}

export interface ErrorEntry extends BaseEntry {
  readonly type: 'error';
  readonly error: string;
  readonly context?: string;
}

/**
 * `ErrorEntry.context` of a failed checkpoint save. The run carries on after
 * one (only a later resume is affected), so readers that infer how a run
 * ended from its log do not count it as the run failing.
 */
export const CHECKPOINT_SAVE_ERROR_CONTEXT = 'checkpoint save';

/**
 * `ErrorEntry.context` of a host-mount privilege finding: setuid/setgid or
 * root-owned files an agent left in its container's host mounts (see
 * `docker/host-mount-privilege-scan.ts`), recorded after a turn and when a
 * bundle is torn down. A warning for the user, not a failure of the run.
 */
export const HOST_MOUNT_SCAN_ERROR_CONTEXT = 'host-mount privilege scan';

export interface StateTransitionEntry extends BaseEntry {
  readonly type: 'state_transition';
  readonly from: string;
  readonly event: string;
}

export interface FanOutJoinEntry extends BaseEntry {
  readonly type: 'fanout_join';
  readonly fanOutState: string;
  readonly workers: number;
  readonly verdict: string | null;
  readonly duplicateRate?: number;
  readonly duplicateCount?: number;
  readonly uniqueCandidates?: number;
  readonly candidateCount?: number;
  readonly children: readonly { readonly index: number; readonly status: string }[];
}

/**
 * Emitted when the adapter detected upstream quota exhaustion and the
 * orchestrator halted the run instead of retrying. `resetAt` is the
 * ISO-formatted provider-advertised reset time when the adapter could
 * parse one; absent when the provider did not supply a machine-readable
 * timestamp. `rawMessage` preserves the original provider/CLI text for
 * humans inspecting the log.
 */
export interface QuotaExhaustedEntry extends BaseEntry {
  readonly type: 'quota_exhausted';
  readonly role: string;
  readonly resetAt?: string;
  readonly rawMessage: string;
}

/**
 * Emitted when the orchestrator halted the run on
 * `AgentResponse.transientFailure`. `rawMessage` preserves the original
 * envelope/stdout for humans inspecting the log.
 */
export interface TransientFailureEntry extends BaseEntry {
  readonly type: 'transient_failure';
  readonly role: string;
  readonly kind: TransientFailureKind;
  readonly rawMessage: string;
}

/** Discriminated union of all log entry types. */
export type MessageLogEntry =
  | AgentSentEntry
  | AgentReceivedEntry
  | AgentRetryEntry
  | GateRaisedEntry
  | GateResolvedEntry
  | ToolCallEscalationEntry
  | ErrorEntry
  | StateTransitionEntry
  | FanOutJoinEntry
  | QuotaExhaustedEntry
  | TransientFailureEntry;

type MessageLogRecord = MessageLogEntry | RunStartedControlEntry | RunResumedControlEntry | RunTerminalControlEntry;

const CONTROL_RECORD_TYPES: ReadonlySet<string> = new Set(['run_started', 'run_resumed', 'run_terminal']);

// ---------------------------------------------------------------------------
// Paged (reverse) reading
// ---------------------------------------------------------------------------

/** An entry together with the location of its JSONL line in the log file. */
export interface LocatedMessageLogEntry {
  readonly entry: MessageLogEntry;
  /** Byte offset of the first byte of the entry's line. */
  readonly offset: number;
  /** Byte length of the line, excluding its trailing newline. */
  readonly length: number;
}

export interface MessageLogPageOptions {
  /** Only entries whose `ts` is strictly less than this ISO-8601 string are returned. */
  readonly before?: string;
  /** Maximum number of entries on the page (at least 1). */
  readonly limit: number;
  /**
   * Byte budget for the page: the summed {@link measure} of its entries (by
   * default the lengths of their JSONL lines). The first entry is always
   * included, so one oversized entry still produces a one-entry page rather
   * than an empty one.
   */
  readonly maxBytes: number;
  /**
   * Budget for the raw JSONL bytes of the page's candidate entries (those
   * older than `before`) that the reader parses; the page counts as full once
   * it is spent. Bounds the work per page when `measure` counts entries
   * smaller than their lines. Default: unlimited.
   */
  readonly maxScanBytes?: number;
  /** An entry's cost against `maxBytes`, given its parsed form and its line length. */
  readonly measure?: (entry: MessageLogEntry, lineBytes: number) => number;
}

export interface MessageLogPage {
  /** Newest first by `ts` (stable for equal timestamps). */
  readonly entries: readonly LocatedMessageLogEntry[];
  /**
   * True when an entry whose `ts` is strictly older than the page's oldest
   * `ts` exists further back in the log, so a request with
   * `before = entries.at(-1).ts` returns more.
   */
  readonly hasMore: boolean;
}

/** Bytes read per step while scanning the log backwards. */
const PAGE_READ_CHUNK_BYTES = 64 * 1024;
/** A single JSONL line longer than this is skipped by the page reader instead of being buffered. */
const MAX_SCANNED_LINE_BYTES = 16 * 1024 * 1024;
/**
 * Entries a full page still takes because they share its oldest timestamp
 * (see {@link MessageLog.readPage}); also bounded by twice the page budgets.
 */
const MAX_PAGE_OVERFLOW_ENTRIES = 64;
const NEWLINE = 0x0a;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Parses one JSONL line into a public entry; control records and malformed lines yield undefined. */
function parseEntryLine(line: Buffer): MessageLogEntry | undefined {
  if (line.length === 0) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const type = (record as { type?: unknown }).type;
  if (typeof type !== 'string' || CONTROL_RECORD_TYPES.has(type)) return undefined;
  const ts = (record as { ts?: unknown }).ts;
  if (typeof ts !== 'string') return undefined;
  return record as MessageLogEntry;
}

/** Fills `buffer` from `position`; regular files answer in one read, but the loop keeps it exact. */
async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, position + filled);
    if (bytesRead === 0) throw new Error(`message log shrank while it was being read (at byte ${position + filled})`);
    filled += bytesRead;
  }
}

/**
 * Visits the log's lines from the last to the first without loading the whole
 * file: the file is read backwards in fixed-size chunks and the partial line
 * at the front of each chunk is carried into the next, older chunk. A line
 * longer than {@link MAX_SCANNED_LINE_BYTES} is skipped rather than buffered.
 * `visit` receives each line (without its newline) and the line's byte offset;
 * scanning stops as soon as `shouldStop()` is true.
 */
async function scanLinesBackward(
  handle: FileHandle,
  size: number,
  visit: (line: Buffer, offset: number) => void,
  shouldStop: () => boolean,
): Promise<void> {
  let position = size;
  // The pieces of a line whose end (newline included) lies in a chunk that has
  // already been processed, newest piece first; they are joined once, when
  // the line's start is found, so a long line costs O(length) to assemble.
  // Empty at EOF: the final line may lack a newline.
  let tailParts: Buffer[] = [];
  let tailBytes = 0;
  let tailDropped = false;

  const emit = (segment: Buffer, offset: number): void => {
    if (!tailDropped) {
      visit(tailParts.length === 0 ? segment : Buffer.concat([segment, ...tailParts.reverse()]), offset);
    }
    tailParts = [];
    tailBytes = 0;
    tailDropped = false;
  };

  while (position > 0 && !shouldStop()) {
    const chunkStart = Math.max(0, position - PAGE_READ_CHUNK_BYTES);
    const chunk = Buffer.alloc(position - chunkStart);
    await readExactly(handle, chunk, chunkStart);
    position = chunkStart;

    let end = chunk.length;
    let newline = chunk.lastIndexOf(NEWLINE, end - 1);
    while (newline >= 0 && !shouldStop()) {
      emit(chunk.subarray(newline + 1, end), chunkStart + newline + 1);
      end = newline;
      // A negative offset would count from the end of the buffer.
      newline = end > 0 ? chunk.lastIndexOf(NEWLINE, end - 1) : -1;
    }
    if (shouldStop()) return;
    if (chunkStart === 0) {
      // The remaining bytes are the first line of the file.
      emit(chunk.subarray(0, end), 0);
    } else if (!tailDropped) {
      if (tailBytes + end > MAX_SCANNED_LINE_BYTES) {
        tailDropped = true;
        tailParts = [];
        tailBytes = 0;
      } else {
        tailParts.push(chunk.subarray(0, end));
        tailBytes += end;
      }
    }
  }
}

/**
 * Opens the log for reading without blocking (a FIFO at the path must not
 * stall the daemon) and returns the handle with the file's size, or undefined
 * when there is no log or the path is not a regular file.
 */
async function openLogForReading(path: string): Promise<{ handle: FileHandle; size: number } | undefined> {
  let handle: FileHandle;
  try {
    handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.isFile()) return { handle, size: stats.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return undefined;
}

function compareLocatedDesc(a: LocatedMessageLogEntry, b: LocatedMessageLogEntry): number {
  if (a.entry.ts === b.entry.ts) return 0;
  return a.entry.ts < b.entry.ts ? 1 : -1;
}

// ---------------------------------------------------------------------------
// MessageLog
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL log for workflow message tracing.
 * Each line is a self-contained JSON object for easy grep/jq inspection.
 */
export class MessageLog {
  constructor(private readonly logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  /** Append a single entry as a JSON line. */
  append(entry: MessageLogEntry): void {
    this.appendRecord(entry);
  }

  /** Declare the terminal-barrier protocol immediately before a new actor starts. */
  appendRunStarted(entry: Omit<RunStartedControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_started' });
  }

  /** Append an internal boundary immediately before a resumed actor starts. */
  appendRunResumed(entry: Omit<RunResumedControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_resumed' });
  }

  /** Append the authoritative terminal phase after terminal persistence. */
  appendRunTerminal(entry: Omit<RunTerminalControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_terminal' });
  }

  /** Read and parse all entries. Skips blank and malformed lines. */
  readAll(): MessageLogEntry[] {
    if (!existsSync(this.logPath)) {
      return [];
    }
    const content = readFileSync(this.logPath, 'utf-8');
    const entries: MessageLogEntry[] = [];
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as MessageLogRecord;
        if (record.type !== 'run_started' && record.type !== 'run_resumed' && record.type !== 'run_terminal') {
          entries.push(record);
        }
      } catch {
        // Skip malformed lines (e.g., truncated writes from crashes)
      }
    }
    return entries;
  }

  /**
   * Reads one page of entries, newest first, without loading the whole log.
   *
   * The file is scanned backwards from its end (see `scanLinesBackward`), so
   * the first page costs O(page), not O(log); an older page also reads, but
   * does not keep, the lines newer than its cursor. Entries are appended in
   * time order by the orchestrator (`logBase()` stamps `ts` at append time),
   * so the scan can stop once the page is full and one strictly older entry
   * has been seen (`hasMore`).
   *
   * The page is full at `limit` entries, at `maxBytes` of measured entries or
   * at `maxScanBytes` of candidate lines, whichever comes first; the first
   * entry is always taken. Once full, the page still takes entries that sort
   * at or after its oldest timestamp (a tie, or an entry appended across a
   * clock step), up to {@link MAX_PAGE_OVERFLOW_ENTRIES} and twice the
   * budgets: the next page asks for entries strictly older than that
   * timestamp, so it would never return them. The page is sorted by `ts` so
   * small inversions render in time order. Blank, malformed and control lines
   * are skipped as in {@link readAll}. A missing log (or a path that is not a
   * regular file) yields an empty page.
   */
  async readPage(options: MessageLogPageOptions): Promise<MessageLogPage> {
    const limit = Math.max(1, Math.floor(options.limit));
    const maxBytes = Math.max(0, options.maxBytes);
    const maxScanBytes = Math.max(0, options.maxScanBytes ?? Number.POSITIVE_INFINITY);
    const measure = options.measure ?? ((_entry: MessageLogEntry, lineBytes: number) => lineBytes);
    const before = options.before;

    const opened = await openLogForReading(this.logPath);
    if (opened === undefined) return { entries: [], hasMore: false };
    const { handle, size } = opened;
    try {
      const entries: LocatedMessageLogEntry[] = [];
      let bytes = 0;
      let scanned = 0;
      let oldestTs = '';
      let full = false;
      let overflow = 0;
      let hasMore = false;
      let stop = false;

      const take = (entry: MessageLogEntry, offset: number, length: number, cost: number): void => {
        entries.push({ entry, offset, length });
        bytes += cost;
        if (entries.length === 1 || entry.ts < oldestTs) oldestTs = entry.ts;
      };

      await scanLinesBackward(
        handle,
        size,
        (line, offset) => {
          const entry = parseEntryLine(line);
          if (entry === undefined) return;
          if (before !== undefined && !(entry.ts < before)) return;
          scanned += line.length;
          let cost: number | undefined;
          if (!full) {
            cost = measure(entry, line.length);
            const fits = entries.length < limit && bytes + cost <= maxBytes && scanned <= maxScanBytes;
            if (entries.length === 0 || fits) {
              take(entry, offset, line.length, cost);
              return;
            }
            full = true;
          }
          // The page is full. Only a strictly older entry is "more": the next
          // cursor (`before` = the page's oldest ts) returns it.
          if (entry.ts < oldestTs) {
            hasMore = true;
            stop = true;
            return;
          }
          // A tie with the page's oldest entry (or one newer than it): no
          // later page can return it, so it stays on this one while the
          // overflow allowance lasts.
          cost ??= measure(entry, line.length);
          if (overflow < MAX_PAGE_OVERFLOW_ENTRIES && bytes + cost <= 2 * maxBytes && scanned <= 2 * maxScanBytes) {
            overflow++;
            take(entry, offset, line.length, cost);
            return;
          }
          // Out of allowance: whatever is further back is reachable only as "more".
          hasMore = true;
          stop = true;
        },
        () => stop,
      );

      entries.sort(compareLocatedDesc);
      return { entries, hasMore };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads the single entry whose line occupies exactly `[offset, offset +
   * length)` in the log (a location from {@link readPage}). The range must be
   * delimited by newlines (or the file's start/end) and parse as a public
   * entry; anything else, including a `length` above `maxBytes`, yields
   * undefined. The log is append-only, so locations stay valid.
   */
  async readEntryAt(offset: number, length: number, maxBytes: number): Promise<MessageLogEntry | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
    if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) return undefined;

    const opened = await openLogForReading(this.logPath);
    if (opened === undefined) return undefined;
    const { handle, size } = opened;
    try {
      if (offset + length > size) return undefined;
      // Read one byte of context on each side (when present) to confirm the
      // range is a whole line.
      const start = offset > 0 ? offset - 1 : 0;
      const end = offset + length < size ? offset + length + 1 : offset + length;
      const buffer = Buffer.alloc(end - start);
      await readExactly(handle, buffer, start);
      if (offset > 0 && buffer[0] !== NEWLINE) return undefined;
      if (offset + length < size && buffer[buffer.length - 1] !== NEWLINE) return undefined;
      const line = buffer.subarray(offset - start, offset - start + length);
      if (line.includes(NEWLINE)) return undefined;
      return parseEntryLine(line);
    } finally {
      await handle.close();
    }
  }

  private appendRecord(entry: MessageLogRecord): void {
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
  }
}
