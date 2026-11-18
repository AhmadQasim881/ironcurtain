// src/logger.ts
//
// The process has one `console` object and one set of module-level
// logging functions, but several holders may need a log file at once: a
// long-lived daemon (`ironcurtain daemon`, `ironcurtain bot`) and every
// session it runs, or the parallel lanes of a workflow. Each holder takes a
// *claim* with `setup()` and gives it back with `release(claim)`:
//
// - Claims stack. Releasing one never touches another, so a session that
//   closes cannot end the daemon's log or a concurrent session's log. The
//   console hijack is installed by the first claim and removed when the last
//   one is released.
// - Each line goes to one claim. Code running inside `runWithClaim(claim,
//   fn)` -- including everything that work schedules asynchronously
//   (AsyncLocalStorage) -- writes to that claim's file. Anything else writes
//   to the process's own log when a process-wide claim exists (a daemon's,
//   see `LoggerOptions.processWide`), else to the newest live claim, as the
//   single-claimant logger always did. Sessions bind their claim around
//   their own work (initialization, turns, close), so concurrent sessions
//   each keep their own log and the daemon keeps everything else.
// - A console call can never throw into its caller: arguments are formatted
//   like Node's console does (Errors with their stack, circular objects,
//   BigInt), and any failure there is swallowed.
//
// `teardown()` drops every claim at once. It is for process exit and test
// isolation only; a session or daemon gives back its own claim instead.
//
// A claim may rotate its file by size (`LoggerOptions.rotation`): the
// long-lived logs of the daemon and the Signal bot do, a session's own log
// does not (it is removed with its session directory). Rotation is decided
// per claim, on the path that claim writes, right before a line is appended,
// so it follows whichever file is active however claims stack.

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatWithOptions, type InspectOptions } from 'node:util';
import { PRIVATE_DIR_MODE, appendPrivateLog } from './observability/private-log-file.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Size-based rotation of a claim's log file. */
export interface LogRotationOptions {
  /**
   * The file is rotated before a line would take it past this many bytes:
   * `<file>` becomes `<file>.1`, `<file>.1` becomes `<file>.2`, and so on.
   */
  readonly maxBytes: number;
  /** Rotated copies kept (`<file>.1` .. `<file>.<maxFiles>`); older ones are dropped. At least 1. */
  readonly maxFiles: number;
}

export interface LoggerOptions {
  readonly logFilePath: string;
  /**
   * The process's own log: a daemon's or the Signal bot's, which runs
   * sessions of its own. Lines no claim is bound to go here even while
   * newer claims (sessions) exist; without such a claim they go to the
   * newest one. Default false.
   */
  readonly processWide?: boolean;
  /** Rotate the file by size (see {@link LogRotationOptions}). Default: never rotated. */
  readonly rotation?: LogRotationOptions;
}

/**
 * One holder's claim on the logger, returned by {@link setup}. Hand it back
 * with {@link release}; bind work to it with {@link runWithClaim}.
 */
export interface LoggerClaim {
  /** The file this claim's lines are written to. */
  readonly logFilePath: string;
}

class Claim implements LoggerClaim {
  released = false;
  /**
   * Bytes in the file as far as this claim knows (undefined until the first
   * line is written). Only kept for a rotating claim; it saves a stat() per
   * line, and the file is stat()ed again before it is actually rotated.
   */
  knownSize: number | undefined;

  constructor(
    readonly logFilePath: string,
    readonly processWide: boolean,
    readonly rotation: LogRotationOptions | undefined,
  ) {}
}

// --- Module state ---

/** Live claims, oldest first (see currentClaim for which one an unbound line goes to). */
const claims: Claim[] = [];

/** The claim the current asynchronous context writes to (see runWithClaim). */
const boundClaim = new AsyncLocalStorage<Claim>();

/** Saved originals for restoration once the last claim is released. */
let originalConsole: {
  log: typeof console.log;
  error: typeof console.error;
  warn: typeof console.warn;
  debug: typeof console.debug;
} | null = null;

// --- Lifecycle ---

/**
 * Claims the logger for `options.logFilePath` (its directory is created
 * owner-only when missing) and returns the claim. Lines from
 * `runWithClaim(claim, ...)` go to its file; so do lines no claim is bound
 * to, while it is the newest claim (or the newest process-wide one).
 */
export function setup(options: LoggerOptions): LoggerClaim {
  // Fail before anything is claimed: a holder whose setup() threw has no
  // claim to release.
  mkdirSync(dirname(options.logFilePath), { recursive: true, mode: PRIVATE_DIR_MODE });

  const previous = claims.at(-1);
  const claim = new Claim(options.logFilePath, options.processWide === true, validRotation(options.rotation));
  claims.push(claim);
  if (originalConsole === null) hijackConsole();

  if (previous === undefined) {
    writeTo(claim, 'info', 'Logger initialized');
  } else if (previous.logFilePath !== claim.logFilePath) {
    writeTo(claim, 'info', 'Logger retargeted');
  }
  return claim;
}

/**
 * Gives back a claim taken with {@link setup}. Other claims are unaffected,
 * and lines that no claim is bound to go where the remaining claims say.
 * Once no claim is left the console is restored. Idempotent; `undefined` is
 * a no-op.
 */
export function release(claim: LoggerClaim | undefined): void {
  if (!(claim instanceof Claim) || claim.released) return;
  claim.released = true;
  const index = claims.indexOf(claim);
  if (index !== -1) claims.splice(index, 1);
  if (claims.length === 0) restoreConsole();
}

/**
 * Drops every claim and restores the console. For process exit and test
 * isolation only: a session or a daemon releases its own claim instead, so
 * it never ends another holder's log.
 */
export function teardown(): void {
  for (const claim of claims) claim.released = true;
  claims.length = 0;
  restoreConsole();
}

/** True while at least one claim is live. */
export function isActive(): boolean {
  return claims.length > 0;
}

/**
 * Runs `fn` with `claim` bound to its asynchronous context: every line
 * written by `fn`, and by whatever it starts (promises, timers, child
 * processes and connections it opens), goes to the claim's file, whichever
 * claim is newest. Two kinds of callbacks run without the binding: those
 * of a connection a server accepts (its events carry no async context) and
 * those isolated-vm makes into the host; code that serves them binds
 * itself (see code-mode-proxy.ts, code-mode-chain.ts). Once the claim is
 * released, its lines go where unbound lines go. `undefined` runs `fn`
 * unchanged.
 */
export function runWithClaim<T>(claim: LoggerClaim | undefined, fn: () => T): T {
  if (!(claim instanceof Claim)) return fn();
  return boundClaim.run(claim, fn);
}

// --- Logging functions ---

export function debug(message: string): void {
  writeEntry('debug', message);
}

export function info(message: string): void {
  writeEntry('info', message);
}

export function warn(message: string): void {
  writeEntry('warn', message);
}

export function error(message: string): void {
  writeEntry('error', message);
}

// --- Internal helpers ---

const LEVEL_PAD: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/**
 * The claim a line written now belongs to: the live claim bound to the
 * current async context, else the newest process-wide claim, else the
 * newest claim. Undefined when nothing is claimed.
 */
function currentClaim(): Claim | undefined {
  const bound = boundClaim.getStore();
  if (bound !== undefined && !bound.released) return bound;
  for (let index = claims.length - 1; index >= 0; index--) {
    if (claims[index].processWide) return claims[index];
  }
  return claims.at(-1);
}

function writeEntry(level: LogLevel, message: string): void {
  const claim = currentClaim();
  if (claim === undefined) return; // no-op when nothing is claimed
  writeTo(claim, level, message);
}

function writeTo(claim: Claim, level: LogLevel, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${LEVEL_PAD[level]} ${message}\n`;
  const bytes = claim.rotation === undefined ? 0 : Buffer.byteLength(line);
  if (claim.rotation !== undefined) {
    try {
      rotateBeforeWrite(claim, claim.rotation, bytes);
    } catch {
      // A rotation that fails (the directory became read-only, say) must not
      // cost the line: it is appended to the current file, and the size is
      // read again before the next attempt.
      claim.knownSize = undefined;
    }
  }
  try {
    // Created owner-only (0600): the log records what the session did.
    appendPrivateLog(claim.logFilePath, line);
    if (claim.knownSize !== undefined) claim.knownSize += bytes;
  } catch {
    // Cannot log if the file is gone or disk is full.
    // Swallow to avoid crashing the agent over a logging failure.
    claim.knownSize = undefined;
  }
}

/** The rotation options when they are usable, else none (a logger option never throws). */
function validRotation(rotation: LogRotationOptions | undefined): LogRotationOptions | undefined {
  if (rotation === undefined) return undefined;
  const { maxBytes, maxFiles } = rotation;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    return undefined;
  }
  return { maxBytes, maxFiles };
}

/** Size of `path` in bytes; 0 when it does not exist. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Rotates the claim's file when appending `incoming` bytes would take it
 * past `maxBytes`: `<file>.<n-1>` -> `<file>.<n>` ... `<file>` -> `<file>.1`,
 * dropping what was `<file>.<maxFiles>`. The size is re-read before rotating,
 * so a file another writer already rotated or truncated is not rotated twice.
 * A file that is empty is never rotated (a single line larger than `maxBytes`
 * is written whole).
 */
function rotateBeforeWrite(claim: Claim, rotation: LogRotationOptions, incoming: number): void {
  const path = claim.logFilePath;
  claim.knownSize ??= fileSize(path);
  if (claim.knownSize === 0 || claim.knownSize + incoming <= rotation.maxBytes) return;
  claim.knownSize = fileSize(path);
  if (claim.knownSize === 0 || claim.knownSize + incoming <= rotation.maxBytes) return;
  for (let index = rotation.maxFiles - 1; index >= 1; index--) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`);
    } catch {
      // Not there yet (fewer rotations so far), or not ours to move.
    }
  }
  renameSync(path, `${path}.1`);
  claim.knownSize = 0;
}

function hijackConsole(): void {
  originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };
  // Intercept console methods -- redirect to the log file.
  console.log = (...args: unknown[]) => {
    writeConsoleEntry('info', 'console.log', args);
  };
  console.error = (...args: unknown[]) => {
    writeConsoleEntry('error', 'console.error', args);
  };
  console.warn = (...args: unknown[]) => {
    writeConsoleEntry('warn', 'console.warn', args);
  };
  console.debug = (...args: unknown[]) => {
    writeConsoleEntry('debug', 'console.debug', args);
  };
}

function restoreConsole(): void {
  if (originalConsole === null) return;
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
  originalConsole = null;
}

/**
 * The console replacements. Any code -- a dependency included -- may call
 * console.* with anything, so this never throws into its caller.
 */
function writeConsoleEntry(level: LogLevel, source: string, args: readonly unknown[]): void {
  try {
    writeEntry(level, `[${source}] ${formatConsoleArgs(args)}`);
  } catch {
    // A log line is never worth an exception in the code that logged it.
  }
}

/**
 * Bounds for console arguments: objects on one line, four levels deep
 * (Node's console uses two), with util.inspect's own caps on array and
 * string length.
 */
const CONSOLE_INSPECT_OPTIONS: InspectOptions = { depth: 4, breakLength: Infinity };

/**
 * Formats console.* arguments the way Node's console does (util.format:
 * `%s`-style placeholders, Errors with their stack, circular references and
 * BigInt rendered rather than thrown on). Falls back to String() per
 * argument should inspection itself fail (a throwing custom inspector).
 * Exported for tests.
 */
export function formatConsoleArgs(args: readonly unknown[]): string {
  try {
    return formatWithOptions(CONSOLE_INSPECT_OPTIONS, ...args);
  } catch {
    return args.map(safeString).join(' ');
  }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'string' ? value : String(value);
  } catch {
    // Objects without a usable toString (Object.create(null), a throwing
    // Symbol.toPrimitive) still get a placeholder rather than an exception.
    return '[unprintable value]';
  }
}
