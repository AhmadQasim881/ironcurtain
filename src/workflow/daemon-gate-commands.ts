/**
 * Non-interactive, machine-readable CLI surface for driving gated workflows on
 * a running daemon: `run` / `resume` / `status` / `await` / `gate` /
 * `escalation` / `show`.
 *
 * These commands talk to the daemon's existing WebSocket JSON-RPC interface via
 * the leaf {@link DaemonClient}; they never import the orchestrator/manager
 * runtime. An autonomous agent uses them as run-to-completion tool calls:
 *
 *   run -> await -> (show -> gate -> await | escalation -> await)* -> terminal
 *
 * `await` stops at two kinds of decision point: a human gate
 * (`phase:'waiting_human'`, resolved with `gate`) and a tool call that policy
 * escalated inside an agent state (`phase:'escalation'`, resolved with
 * `escalation --approve|--deny`).
 *
 * Output convention: a single newline-terminated JSON object to **stdout** when
 * `--json` is set (the agent parses stdout), on every path: success, RPC
 * errors, usage errors, a lost daemon connection and unexpected failures;
 * human-readable text to **stderr**, with every control character shown as a
 * visible escape. Exit codes are derived from the authoritative workflow
 * `phase`, never from a lifecycle event name (a gate-ABORT fires a `completed`
 * event but reports `phase:'aborted'`). The caller sets `process.exitCode`
 * rather than calling `process.exit()`, so a slow pipe reader still receives
 * the whole output.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveWorkflowPath } from './discovery.js';
import { isWorkspaceValidationError, validateWorkspacePath } from '../session/workspace-validation.js';
import { expandTilde } from '../types/argument-roles.js';
import {
  createDaemonClient,
  type DaemonClient,
  type DaemonCloseInfo,
  type DaemonEvent,
  type RpcResult,
} from '../daemon-client/daemon-client.js';
import {
  parseDaemonWebUiState,
  sendControlRequest,
  type ControlRequestResult,
  type DaemonWebUiState,
} from '../daemon/control-socket.js';
import { parseArgsResult, type ParseArgsResult, type ParseArgsOptions } from './cli-shared.js';
import type { MethodName, WorkflowDetailDto, WorkflowEscalationDto } from '../web-ui/web-ui-types.js';
import { isSafeWorkflowId, type HumanGateRequestDto } from './types.js';
import { isTerminalWorkflowPhase } from './terminal-phase.js';
import { toDisplayText, toTerminalSafeJson } from '../terminal/display-sanitize.js';

// ---------------------------------------------------------------------------
// Exit codes (stable contract for shell-only agents)
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_USAGE = 2;
/** Terminal failure phase: `failed` or `aborted`. */
const EXIT_TERMINAL_FAILURE = 3;
/** `await` timed out before a decision point or terminal. */
const EXIT_AWAIT_TIMEOUT = 4;
/** Generic operational failure (RPC error, no daemon, etc.). */
const EXIT_ERROR = 1;

const DEFAULT_AWAIT_TIMEOUT_SEC = 600;
/**
 * The longest delay a Node.js timer supports (2^31 - 1 ms, about 24.8 days).
 * A longer `setTimeout` fires after 1 ms, so `await --timeout` is capped here.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ENSURE_DAEMON_TIMEOUT_MS = 15_000;
const ENSURE_DAEMON_POLL_INTERVAL_MS = 250;
/** A live daemon answers a control-socket status request at once; this only bounds a hung one. */
const ENSURE_DAEMON_PROBE_TIMEOUT_MS = 5_000;

// CLI-level error strings (not daemon RPC `ErrorCode`s).
/** The daemon connection dropped while the command was waiting or a request was in flight. */
const DAEMON_DISCONNECTED = 'DAEMON_DISCONNECTED';
/** A request failed in transport while the connection stayed up (it timed out, for example). */
const DAEMON_REQUEST_FAILED = 'DAEMON_REQUEST_FAILED';
/**
 * The command itself failed unexpectedly (a bug); reported instead of a stack
 * trace. Distinct from the daemon's own `INTERNAL_ERROR` RPC code.
 */
const CLI_INTERNAL_ERROR = 'CLI_INTERNAL_ERROR';
const INVALID_USAGE = 'INVALID_USAGE';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

interface OutputMode {
  readonly json: boolean;
}

/**
 * Emits a machine-readable JSON object to stdout (when `--json`). Characters
 * a terminal acts on that `JSON.stringify` leaves raw (C1 controls, bidi and
 * other format characters) are written as `\u` escapes; the parsed value is
 * unchanged.
 */
function emitJson(mode: OutputMode, obj: Record<string, unknown>): void {
  if (mode.json) {
    process.stdout.write(`${toTerminalSafeJson(obj)}\n`);
  }
}

/**
 * Emits human-readable text to stderr (never stdout). The text carries
 * daemon-, workflow- and agent-derived values (state names, error messages,
 * artifact content), so every control and invisible format character is
 * shown as a visible escape; line feeds and tabs are kept.
 */
function emitText(message: string): void {
  process.stderr.write(`${toDisplayText(message, { multiline: true })}\n`);
}

/** Prints a CLI-level error in both channels and returns the exit code. */
function fail(mode: OutputMode, error: string, extra: Record<string, unknown> = {}, exitCode = EXIT_ERROR): number {
  emitJson(mode, { ok: false, error, ...extra });
  emitText(formatErrorText(error, extra));
  return exitCode;
}

/** A usage error under the output contract: `INVALID_USAGE` JSON when `--json`, exit {@link EXIT_USAGE}. */
function usageError(mode: OutputMode, message: string, usage: string): number {
  return fail(mode, INVALID_USAGE, { message, usage }, EXIT_USAGE);
}

/**
 * Refuses a workflow id that is not one safe path segment (`../x`, `a/b`)
 * before anything is sent. The daemon refuses it as well; this gives the
 * caller a usage error without a round trip. Returns the exit code, or
 * undefined when the id is fine.
 */
function rejectUnsafeWorkflowId(mode: OutputMode, workflowId: string): number | undefined {
  if (isSafeWorkflowId(workflowId)) return undefined;
  return fail(
    mode,
    'INVALID_PARAMS',
    { message: `Invalid workflow ID ${JSON.stringify(workflowId)}: use 1-128 letters, digits, "_" or "-"` },
    EXIT_USAGE,
  );
}

function formatErrorText(error: string, extra: Record<string, unknown>): string {
  const message = typeof extra.message === 'string' ? extra.message : undefined;
  const lines = [message ? `Error: ${error}: ${message}` : `Error: ${error}`];
  if (typeof extra.hint === 'string') lines.push(extra.hint);
  if (typeof extra.usage === 'string') lines.push(extra.usage);
  return lines.join('\n');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Argument parsing (under the stdout/exit-code contract)
// ---------------------------------------------------------------------------

type ParsedGateArgs = Extract<ParseArgsResult, { readonly ok: true }>;

type GateArgs =
  | {
      readonly ok: true;
      readonly mode: OutputMode;
      readonly values: ParsedGateArgs['values'];
      readonly positionals: ParsedGateArgs['positionals'];
    }
  | { readonly ok: false; readonly exitCode: number };

/**
 * Picks the output channel when strict parsing FAILS, before {@link OutputMode}
 * can be read from parsed values. A typo'd flag must still honor the caller's
 * `--json` choice so the failure lands on the right channel (machine JSON on
 * stdout vs human stderr).
 *
 * Uses a NON-strict re-parse — which never throws on the offending flag that
 * triggered this path — rather than a literal `args.includes('--json')`. The
 * loose parse still lets a known value-taking option consume its argument, so
 * `--workspace --json` does NOT enable JSON mode (here `--json` is the
 * workspace value, not a flag) and `--json=...` forms are handled. Falls back
 * to a literal scan only if the loose parse itself cannot run.
 */
function detectOutputMode(args: string[], options: ParseArgsOptions): OutputMode {
  try {
    const { values } = parseArgs({ args, options, strict: false, allowPositionals: true });
    return { json: values.json === true };
  } catch {
    return { json: args.includes('--json') };
  }
}

/**
 * Parses a daemon-gate subcommand's args under this module's output contract.
 *
 * On an unknown/typo'd flag or a missing option value, reports a structured
 * `INVALID_USAGE` (JSON on stdout when `--json`, human text on stderr) and exits
 * {@link EXIT_USAGE} — rather than the bare stderr `process.exit(1)` that
 * {@link parseArgsStrict} would do, which an agent driving the CLI cannot parse.
 */
function parseGateArgs(args: string[], options: ParseArgsOptions): GateArgs {
  const result = parseArgsResult({ args, options, allowPositionals: true });
  if (!result.ok) {
    const mode = detectOutputMode(args, options);
    return {
      ok: false,
      exitCode: fail(
        mode,
        INVALID_USAGE,
        { message: result.message, hint: 'Run with --help to see available options.' },
        EXIT_USAGE,
      ),
    };
  }
  return {
    ok: true,
    mode: { json: result.values.json === true },
    values: result.values,
    positionals: result.positionals,
  };
}

// ---------------------------------------------------------------------------
// Status projection (shared by `status` and `await`)
// ---------------------------------------------------------------------------

/**
 * The orchestrator's phases plus the agent-facing `escalation` phase: a
 * `running` workflow whose agent is blocked inside a tool call that policy
 * escalated. The orchestrator keeps reporting `running` (the machine is in
 * an agent state); this projection surfaces the decision point so an agent
 * driving the CLI knows input is required, exactly as for a gate.
 */
type WorkflowPhase = WorkflowDetailDto['phase'] | 'escalation';

/**
 * The stable machine-readable status object emitted by `status` and `await`.
 *
 * `ok: true` reports that the STATUS QUERY succeeded, NOT that the workflow
 * outcome was favorable: a `failed`/`aborted` workflow is still reported with
 * `ok: true`. Agents branch on `phase` (and the process exit code from
 * {@link exitCodeForPhase}), never on this `ok`.
 */
interface StatusProjection {
  readonly ok: true;
  readonly workflowId: string;
  readonly phase: WorkflowPhase;
  readonly currentState: string;
  readonly round: number;
  readonly gate?: HumanGateRequestDto;
  /** Pending tool-call escalations; present only when `phase === 'escalation'`. */
  readonly escalations?: readonly WorkflowEscalationDto[];
}

/** The agent-facing phase for a `workflows.get` DTO (see {@link WorkflowPhase}). */
function phaseOf(detail: WorkflowDetailDto): WorkflowPhase {
  if (detail.phase === 'running' && detail.escalations !== undefined && detail.escalations.length > 0) {
    return 'escalation';
  }
  return detail.phase;
}

/**
 * An escalation as the deciding agent sees it: without the workflow agent's
 * `agentJustification`. That text is written by the agent whose call is
 * being decided and is meant for a human reviewer; like the auto-approver,
 * an agent that decides escalations never reads it (a persuasive or
 * injected justification must not reach a model making the decision).
 */
function forDecidingAgent(escalation: WorkflowEscalationDto): WorkflowEscalationDto {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { agentJustification, ...rest } = escalation;
  return rest;
}

/** Projects a `workflows.get` DTO into the stable status shape. */
function projectStatus(detail: WorkflowDetailDto): StatusProjection {
  const phase = phaseOf(detail);
  return {
    ok: true,
    workflowId: detail.workflowId,
    phase,
    currentState: detail.currentState,
    round: detail.round,
    ...(detail.phase === 'waiting_human' && detail.gate ? { gate: detail.gate } : {}),
    ...(phase === 'escalation' && detail.escalations ? { escalations: detail.escalations.map(forDecidingAgent) } : {}),
  };
}

/** Exit code derived from the authoritative phase (never an event name). */
function exitCodeForPhase(phase: WorkflowPhase): number {
  switch (phase) {
    case 'waiting_human':
    case 'escalation':
    case 'completed':
      return EXIT_OK;
    case 'failed':
    case 'aborted':
    case 'interrupted':
      // `interrupted` is the disk-fallback state for a run stranded by a daemon
      // restart with no live orchestrator: a stuck workflow is a failure, not a
      // success, so it shares the terminal-failure exit code.
      return EXIT_TERMINAL_FAILURE;
    default:
      // `running`: not a resting point for this projection, but surfaced as a
      // non-failure so the agent re-issues `await`.
      return EXIT_OK;
  }
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

/**
 * Outcome of a single attempt to discover + connect to a running daemon.
 *
 * `no-endpoint` means discovery found no `web-ui.json` (no daemon configured);
 * `connect-failed` means an endpoint existed but a connection could not be
 * established (stale state file from a crashed daemon, or the daemon is down).
 * These are distinguished so the non-`--ensure-daemon` path can preserve the
 * historical `DAEMON_NOT_RUNNING` vs `DAEMON_CONNECT_FAILED` error strings.
 */
type ConnectAttempt =
  | { readonly kind: 'connected'; readonly client: DaemonClient }
  | { readonly kind: 'no-endpoint' }
  | { readonly kind: 'connect-failed'; readonly message: string };

/**
 * Performs ONE discover + create + connect cycle. On any failure the half-open
 * client is closed so no attempt leaks a socket. Readiness here means a daemon
 * actually ANSWERED a connect — never merely "the state file exists" (a crashed
 * daemon leaves a stale `web-ui.json` that discovery would otherwise accept).
 */
async function attemptConnect(): Promise<ConnectAttempt> {
  let client: DaemonClient;
  try {
    client = createDaemonClient();
  } catch (err) {
    // Cross-module catch: branch on the `code` discriminant rather than only
    // `instanceof` (per CLAUDE.md), so this stays robust if the error crosses a
    // module boundary that defeats `instanceof`.
    if (isDaemonNotRunning(err)) return { kind: 'no-endpoint' };
    throw err;
  }

  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => {});
    return { kind: 'connect-failed', message: err instanceof Error ? err.message : String(err) };
  }

  return { kind: 'connected', client };
}

/**
 * Returns a connected {@link DaemonClient}, ensuring a daemon exists first when
 * `--ensure-daemon` is set. Returns `undefined` (after printing an error) when
 * no daemon can be reached.
 *
 * Control flow:
 *  1. Attempt a real connect to an existing daemon; on success, return it.
 *  2. If that fails and `ensureDaemon` is set, ask the daemon control socket
 *     whether a daemon is already running. If one is, never start a second
 *     one: wait for its web UI when it reports one still starting, otherwise
 *     report `DAEMON_WITHOUT_WEB_UI` (started without `--web-ui`, or its web
 *     UI is down). With no daemon, spawn a detached daemon ONCE. Either wait
 *     polls by RE-ATTEMPTING connect (not by polling discovery — a stale state
 *     file would make discovery a false positive) until a connect succeeds or
 *     `ENSURE_DAEMON_TIMEOUT_MS` elapses.
 *  3. If that fails and `ensureDaemon` is NOT set, report the historical error:
 *     `DAEMON_NOT_RUNNING` (no endpoint) or `DAEMON_CONNECT_FAILED` (endpoint
 *     present but unreachable).
 */
async function openClient(mode: OutputMode, ensureDaemon: boolean): Promise<DaemonClient | undefined> {
  const initial = await attemptConnect();
  if (initial.kind === 'connected') return initial.client;

  if (ensureDaemon) {
    const ensured = await ensureDaemonRunning();
    if (ensured.kind === 'connected') return ensured.client;
    if (ensured.kind === 'running-without-web-ui') {
      fail(mode, 'DAEMON_WITHOUT_WEB_UI', {
        hint:
          `An IronCurtain daemon is already running, but its web UI is not reachable (${ensured.reason}). ` +
          'Only one daemon may run; restart it with: ironcurtain daemon --web-ui',
      });
      return undefined;
    }
    fail(mode, 'DAEMON_START_TIMEOUT', {
      hint: `Timed out waiting for a daemon to come up after ${ENSURE_DAEMON_TIMEOUT_MS}ms`,
    });
    return undefined;
  }

  if (initial.kind === 'no-endpoint') {
    fail(mode, 'DAEMON_NOT_RUNNING', { hint: 'Start the daemon with: ironcurtain daemon --web-ui' });
    return undefined;
  }

  fail(mode, 'DAEMON_CONNECT_FAILED', { message: initial.message });
  return undefined;
}

/** Discriminant check for the "no daemon running" error (no `instanceof`). */
function isDaemonNotRunning(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'DAEMON_NOT_RUNNING';
}

/** Outcome of {@link ensureDaemonRunning}. */
type EnsureDaemonResult =
  | { readonly kind: 'connected'; readonly client: DaemonClient }
  /**
   * A daemon took the control-socket connection, so none was spawned, and it
   * has no web UI to wait for; `reason` says why, for the hint.
   */
  | { readonly kind: 'running-without-web-ui'; readonly reason: string }
  | { readonly kind: 'timeout' };

/** Why a daemon that took the control-socket connection has no web UI to wait for. */
function withoutWebUiReason(probe: ControlRequestResult, webUi: DaemonWebUiState | undefined): string {
  if (probe.kind !== 'response') return 'it did not answer on its control socket';
  if (webUi === 'disabled') return 'it was started without --web-ui';
  if (webUi === 'unavailable') return 'its web UI failed to start; see the daemon log';
  return 'was it started without --web-ui?';
}

/**
 * Spawns a detached `ironcurtain daemon --web-ui` ONCE, then polls by
 * re-attempting a real connect until one succeeds or a bounded timeout elapses.
 * Arg-array spawn — no shell string concatenation (CLAUDE.md Safe Coding).
 *
 * It first asks the daemon control socket for the daemon's status and spawns
 * nothing when a daemon takes the connection, even one that does not answer:
 * only one daemon may run per IronCurtain home (a second one would run every
 * cron job again), and the daemon singleton lock would make the spawned one
 * exit anyway. A daemon that reports its web UI as still starting (it binds
 * the control socket before it starts Signal and the web UI, so a concurrent
 * `--ensure-daemon`, or one racing a daemon start, sees this) is waited for
 * like a spawned one; any other daemon ends in `running-without-web-ui` at once.
 *
 * `process.execArgv` is prepended so a loader-based invocation survives into the
 * detached child. Under the documented dev entry `tsx src/cli.ts ...`,
 * `execPath` is `node` and `argv[1]` is `cli.ts` — which bare `node` cannot
 * execute — so without the loader flags (`--import tsx/esm`, `--loader`, etc.)
 * the spawned daemon would exit silently and `--ensure-daemon` would just time
 * out with `DAEMON_START_TIMEOUT`. For the installed binary `execArgv` is empty,
 * so this is a no-op on the production path.
 *
 * Polling on connect (rather than discovery) is what makes readiness real: a
 * stale `web-ui.json` left by a crashed daemon would make `discoverDaemon()`
 * return immediately, but its socket will not accept a connection.
 */
async function ensureDaemonRunning(): Promise<EnsureDaemonResult> {
  const probe = await sendControlRequest({ command: 'status' }, { responseTimeoutMs: ENSURE_DAEMON_PROBE_TIMEOUT_MS });
  if (probe.kind !== 'unreachable') {
    const webUi = probe.kind === 'response' ? parseDaemonWebUiState(probe.response) : undefined;
    if (webUi === 'starting' || webUi === 'listening') return waitForWebUi();
    return { kind: 'running-without-web-ui', reason: withoutWebUiReason(probe, webUi) };
  }

  const cliEntry = process.argv[1];
  if (!cliEntry) return { kind: 'timeout' };

  const child = spawn(process.execPath, [...process.execArgv, cliEntry, 'daemon', '--web-ui'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return waitForWebUi();
}

/** Re-attempts a real connect until one succeeds or `ENSURE_DAEMON_TIMEOUT_MS` elapses. */
async function waitForWebUi(): Promise<EnsureDaemonResult> {
  const deadline = Date.now() + ENSURE_DAEMON_TIMEOUT_MS;
  for (;;) {
    const attempt = await attemptConnect();
    if (attempt.kind === 'connected') return { kind: 'connected', client: attempt.client };
    if (Date.now() >= deadline) return { kind: 'timeout' };
    await delay(ENSURE_DAEMON_POLL_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What a command reports when its exchange with the daemon fails in transport
 * (the connection dropped, a request timed out) or unexpectedly.
 */
interface FailureReport {
  /** Identifies the request in the error JSON (`workflowId`, `gateId`, ...). */
  readonly ids: Record<string, unknown>;
  /**
   * True when the request changes daemon state (`run`, `resume`, `gate`): a
   * lost reply leaves its effect unknown, which the report says (`effect:
   * 'unknown'`), and the hint must say how to find out before retrying.
   */
  readonly mutates: boolean;
  /**
   * The next step for the agent or user after a transport failure; for a
   * command that {@link mutates}, after any failure. (A read-only command that
   * fails in its own code gets {@link INTERNAL_ERROR_HINT} instead.)
   */
  readonly hint: string;
}

/**
 * A daemon request failed in transport: the reply never arrived because the
 * connection dropped or the request timed out. Distinguishes these from RPC
 * errors (`{ok:false}` replies) and from bugs in the command.
 */
class DaemonTransportError extends Error {
  readonly code = 'DAEMON_TRANSPORT_ERROR' as const;
}

/** {@link DaemonClient.call} with transport failures surfaced as {@link DaemonTransportError}. */
async function rpc<T>(
  client: DaemonClient,
  method: MethodName,
  params: Record<string, unknown>,
): Promise<RpcResult<T>> {
  try {
    return await client.call<T>(method, params);
  } catch (err) {
    throw new DaemonTransportError(errorMessage(err), { cause: err });
  }
}

/**
 * Opens a daemon client (honoring `--ensure-daemon`), runs `fn` with it, and
 * guarantees the socket is closed. Collapses the open/guard/try-finally-close
 * scaffold that every gate subcommand would otherwise repeat, so a handler can
 * no longer forget the `if (!client)` guard or the `.catch()` on close.
 *
 * Whatever `fn` throws is reported under the output contract, never as a
 * stack trace: `DAEMON_DISCONNECTED` when the connection dropped,
 * `DAEMON_REQUEST_FAILED` for another transport failure, `CLI_INTERNAL_ERROR`
 * otherwise, each with `report`'s ids and hint, and exit {@link EXIT_ERROR}.
 *
 * Returns {@link EXIT_ERROR} when no daemon can be reached — {@link openClient}
 * has already reported the specific error on the right channel by then.
 */
async function withDaemonClient(
  mode: OutputMode,
  ensureDaemon: boolean,
  report: FailureReport,
  fn: (client: DaemonClient) => Promise<number>,
): Promise<number> {
  const client = await openClient(mode, ensureDaemon);
  if (!client) return EXIT_ERROR;
  // Registered before `fn` runs, so a drop is known by the time the rejected
  // call (or the interrupted `await`) reaches the catch below.
  let disconnect: DaemonCloseInfo | undefined;
  const unsubscribeClose = client.onClose((info) => {
    disconnect = info;
  });
  try {
    return await fn(client);
  } catch (err) {
    return reportFailure(mode, err, disconnect, report);
  } finally {
    unsubscribeClose();
    await client.close().catch(() => {});
  }
}

/**
 * Hint for a read-only command that failed in its own code (`CLI_INTERNAL_ERROR`):
 * typically a reply it cannot handle, from a daemon of another version.
 */
const INTERNAL_ERROR_HINT =
  "Nothing was changed. The command could not handle the daemon's reply (a bug, or a CLI and a daemon " +
  'from different versions), so retrying against the same daemon will fail the same way.';

function reportFailure(
  mode: OutputMode,
  err: unknown,
  disconnect: DaemonCloseInfo | undefined,
  report: FailureReport,
): number {
  const transport = err instanceof DaemonTransportError;
  const error = transport ? (disconnect ? DAEMON_DISCONNECTED : DAEMON_REQUEST_FAILED) : CLI_INTERNAL_ERROR;
  const message = transport && disconnect ? disconnect.reason : errorMessage(err);
  // A mutating command keeps its effect-unknown hint whatever failed: the
  // request may have been applied first. A read-only command that failed in
  // its own code reached the daemon fine, so "retry once it is reachable" (or
  // "the connection was lost") would send the agent into a pointless loop.
  const hint = transport || report.mutates ? report.hint : INTERNAL_ERROR_HINT;
  return fail(mode, error, {
    ...report.ids,
    message,
    ...(report.mutates ? { effect: 'unknown' } : {}),
    hint,
  });
}

/** The command an agent runs to learn a workflow's current phase and gate. */
function statusCommand(workflowId: string): string {
  return `ironcurtain workflow status ${workflowId} --json`;
}

/** Hint for a command that only reads daemon state: retrying is safe. */
const RETRY_HINT = 'Nothing was changed. Retry once the daemon is reachable.';

// ---------------------------------------------------------------------------
// RPC error mapping
// ---------------------------------------------------------------------------

/** Reports an `{ok:false}` RPC result and returns the chosen exit code. */
function reportRpcError(mode: OutputMode, result: Extract<RpcResult<unknown>, { ok: false }>): number {
  const extra: Record<string, unknown> = { message: result.message };
  // LINT_FAILED carries structured diagnostics under `error.data.diagnostics`.
  if (result.code === 'LINT_FAILED') {
    const diagnostics = extractDiagnostics(result.data);
    if (diagnostics) extra.diagnostics = diagnostics;
  }
  return fail(mode, result.code, extra);
}

function extractDiagnostics(data: unknown): unknown[] | undefined {
  if (data !== null && typeof data === 'object' && 'diagnostics' in data) {
    const diagnostics: unknown = data.diagnostics;
    if (Array.isArray(diagnostics)) return diagnostics as unknown[];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `workflow run`
// ---------------------------------------------------------------------------

const RUN_USAGE =
  'Usage: ironcurtain workflow run <name-or-path> "task" [--workspace <path>] [--json] [--ensure-daemon]';

async function runRun(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    workspace: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const definitionRef = positionals[0];
  const taskDescription = positionals[1];
  if (!definitionRef || !taskDescription) {
    return usageError(mode, 'A workflow name or path and a task description are required', RUN_USAGE);
  }

  // Resolve the definition path client-side: the daemon does not resolve names.
  const definitionPath = resolveWorkflowPath(definitionRef);
  if (!definitionPath) {
    return fail(mode, 'WORKFLOW_DEFINITION_NOT_FOUND', {
      ref: definitionRef,
      hint: "Run 'ironcurtain workflow list' to see available workflows.",
    });
  }

  // Validate the workspace client-side BEFORE connecting to the daemon, so an
  // invalid --workspace fails fast without spawning or connecting it. This is
  // the validator the daemon's orchestrator re-applies authoritatively with
  // its full protected-path list; the fixed roots it always checks (home
  // directory, IronCurtain home, package configuration) are enough for an
  // early, structured error here. The canonical path is what gets sent.
  let workspacePath: string | undefined;
  if (typeof values.workspace === 'string') {
    const requestedPath = resolve(expandTilde(values.workspace));
    try {
      workspacePath = validateWorkspacePath(values.workspace, []);
    } catch (err) {
      if (isWorkspaceValidationError(err) && err.code === 'WORKSPACE_UNSAFE') {
        return fail(mode, 'WORKSPACE_UNSAFE', { path: requestedPath, message: err.message });
      }
      // Any other failure — ENOENT (incl. a racy delete after a check), not a
      // directory, EACCES, ELOOP, etc. — means the path is unusable as a
      // workspace. Return the structured error instead of throwing.
      return fail(mode, 'WORKSPACE_NOT_DIRECTORY', { path: requestedPath });
    }
  }

  const report: FailureReport = {
    ids: { definitionPath },
    mutates: true,
    hint:
      'The daemon may have started the workflow before the reply was lost. Look for the run (the daemon ' +
      "web UI, or 'ironcurtain workflow inspect <IRONCURTAIN_HOME>/workflow-runs') before starting it again.",
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    const params: Record<string, unknown> = { definitionPath, taskDescription };
    if (workspacePath !== undefined) params.workspacePath = workspacePath;

    const result = await rpc<{ workflowId: string }>(client, 'workflows.start', params);
    if (!result.ok) return reportRpcError(mode, result);

    const { workflowId } = result.payload;
    emitJson(mode, { ok: true, workflowId, phase: 'running' });
    emitText(`Started workflow ${workflowId} (use: ironcurtain workflow await ${workflowId})`);
    return EXIT_OK;
  });
}

// ---------------------------------------------------------------------------
// `workflow resume`
// ---------------------------------------------------------------------------

const RESUME_USAGE =
  'Usage: ironcurtain workflow resume <workflowId|existingBaseDir> [--workflow-id <id>] [--trust] [--json] [--ensure-daemon]';

async function runResume(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    'workflow-id': { type: 'string' },
    trust: { type: 'boolean' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const target = positionals[0];
  if (!target || positionals.length !== 1) {
    return usageError(mode, 'Exactly one workflow id or base directory is required', RESUME_USAGE);
  }

  const params: Record<string, unknown> = {};
  let targetExists = false;
  try {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (stat) {
      targetExists = true;
      if (!stat.isDirectory()) {
        return fail(mode, 'INVALID_PARAMS', { message: `Path is not a directory: ${resolve(target)}` }, EXIT_USAGE);
      }
      params.baseDir = resolve(target);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      mode,
      'INVALID_PARAMS',
      { message: `Cannot inspect resume target ${resolve(target)}: ${message}` },
      EXIT_USAGE,
    );
  }

  const selectedId = values['workflow-id'];
  if (targetExists) {
    if (typeof selectedId === 'string') {
      const rejected = rejectUnsafeWorkflowId(mode, selectedId);
      if (rejected !== undefined) return rejected;
      params.workflowId = selectedId;
    }
    // Importing a run from another directory: its definition may run
    // commands on this host, which the daemon refuses unless trusted.
    if (values.trust === true) params.trust = true;
  } else {
    if (selectedId !== undefined) {
      return fail(mode, 'INVALID_PARAMS', { message: '--workflow-id requires an existing base directory' }, EXIT_USAGE);
    }
    if (values.trust === true) {
      return fail(
        mode,
        'INVALID_PARAMS',
        { message: '--trust applies only to an existing base directory' },
        EXIT_USAGE,
      );
    }
    const rejected = rejectUnsafeWorkflowId(mode, target);
    if (rejected !== undefined) return rejected;
    params.workflowId = target;
  }

  const resumedId = typeof params.workflowId === 'string' ? params.workflowId : undefined;
  const report: FailureReport = {
    ids: resumedId !== undefined ? { workflowId: resumedId } : { baseDir: params.baseDir },
    mutates: true,
    hint:
      'The daemon may have accepted the resume before the reply was lost. ' +
      (resumedId !== undefined
        ? `Check with '${statusCommand(resumedId)}' before resuming again.`
        : 'Check the run before resuming again.'),
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    const result = await rpc<{ accepted: true; workflowId: string }>(client, 'workflows.resume', params);
    if (!result.ok) return reportRpcError(mode, result);

    const { workflowId } = result.payload;
    emitJson(mode, { ok: true, workflowId, phase: 'running' });
    emitText(`Resumed workflow ${workflowId} (use: ironcurtain workflow await ${workflowId})`);
    return EXIT_OK;
  });
}

// ---------------------------------------------------------------------------
// `workflow status`
// ---------------------------------------------------------------------------

async function runStatus(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    return usageError(
      mode,
      'A workflow id is required',
      'Usage: ironcurtain workflow status <workflowId> [--json] [--ensure-daemon]',
    );
  }
  const rejected = rejectUnsafeWorkflowId(mode, workflowId);
  if (rejected !== undefined) return rejected;

  const report: FailureReport = { ids: { workflowId }, mutates: false, hint: RETRY_HINT };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    const result = await rpc<WorkflowDetailDto>(client, 'workflows.get', { workflowId });
    if (!result.ok) return reportRpcError(mode, result);
    return emitStatus(mode, result.payload);
  });
}

/** Emits a status projection and returns the phase-derived exit code. */
function emitStatus(mode: OutputMode, detail: WorkflowDetailDto): number {
  const projection = projectStatus(detail);
  // Rendered before anything is written: a failure here must not follow a
  // JSON object already on stdout with a second (error) object.
  const text = formatStatusText(projection);
  emitJson(mode, { ...projection });
  emitText(text);
  return exitCodeForPhase(projection.phase);
}

function formatStatusText(p: StatusProjection): string {
  if (p.phase === 'waiting_human' && p.gate) {
    // The gate id is what `workflow gate --gate-id` must quote, so text mode shows it too.
    return `Workflow ${p.workflowId} is waiting at gate "${p.gate.stateName}" (gate id: ${p.gate.gateId}; events: ${p.gate.acceptedEvents.join(', ')}; artifacts: ${p.gate.presentedArtifacts.join(', ') || 'none'})`;
  }
  if (p.phase === 'escalation' && p.escalations) {
    // Tool names, reasons and whitelist descriptions quote the agent's call:
    // render them inert for the terminal. `--json` carries them verbatim.
    const lines = p.escalations.map((e) => {
      const candidates = (e.whitelistCandidates ?? [])
        .map((c, index) => `[${index}] ${toDisplayText(c.description, { maxLength: 200 })}`)
        .join('; ');
      const whitelist = candidates ? ` (whitelist candidates for --whitelist: ${candidates})` : '';
      return `  ${toDisplayText(e.escalationId)}: ${toDisplayText(`${e.serverName}/${e.toolName}`)} - ${toDisplayText(e.reason, { maxLength: 300 })}${whitelist}`;
    });
    // Approvals must name the escalation; spell out the id when there is one.
    const idHint = p.escalations.length === 1 ? toDisplayText(p.escalations[0].escalationId) : '<id>';
    return [
      `Workflow ${p.workflowId} is waiting for a tool-call approval in state "${toDisplayText(p.currentState)}":`,
      ...lines,
      `Resolve with: ironcurtain workflow escalation ${p.workflowId} --escalation-id ${idHint} --approve|--deny`,
    ].join('\n');
  }
  return `Workflow ${p.workflowId} phase: ${p.phase} (state: ${p.currentState})`;
}

// ---------------------------------------------------------------------------
// `workflow await`
// ---------------------------------------------------------------------------

const AWAIT_USAGE = 'Usage: ironcurtain workflow await <workflowId> [--timeout <sec>] [--json] [--ensure-daemon]';

async function runAwait(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    timeout: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    return usageError(mode, 'A workflow id is required', AWAIT_USAGE);
  }
  const rejectedId = rejectUnsafeWorkflowId(mode, workflowId);
  if (rejectedId !== undefined) return rejectedId;

  const timeoutSec = parseTimeout(values.timeout);
  if (timeoutSec === undefined) {
    return usageError(mode, '--timeout must be a positive number of seconds', AWAIT_USAGE);
  }
  // Capped at the longest timer Node supports (about 24.8 days): a longer
  // delay would fire after 1 ms and turn `await` into a busy retry loop.
  const timeoutMs = Math.min(Math.ceil(timeoutSec * 1000), MAX_TIMER_DELAY_MS);

  const report: FailureReport = {
    ids: { workflowId },
    mutates: false,
    hint:
      'The daemon stopped answering (the connection dropped or a request timed out) before the workflow ' +
      'reached a decision point (a gate or a tool-call escalation) or a terminal state; that says nothing ' +
      `about the run itself. Check it with '${statusCommand(workflowId)}': a run stranded by a daemon ` +
      `restart reports phase 'interrupted' and can be continued with 'ironcurtain workflow resume ${workflowId}'.`,
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, (client) =>
    awaitDecisionPoint(client, mode, workflowId, timeoutMs),
  );
}

/**
 * Blocks until the workflow reaches a decision point (a gate, `waiting_human`,
 * or a pending tool-call escalation, `escalation`) or a terminal, then makes
 * one authoritative `workflows.get` and reports/branches on its `phase`.
 *
 * Resolution triggers: the initial `get` already at a decision point or
 * terminal; a `workflow.gate_raised` or `workflow.escalation_raised` event;
 * or a terminal *event* (`workflow.completed` / `workflow.failed`). The event
 * name is never trusted: `workflow.failed` represents both `failed` and
 * `aborted`, and an escalation may have expired by the time we look, so the
 * follow-up `get` is authoritative.
 *
 * The wait also ends when the daemon connection drops: a daemon that exits or
 * restarts sends no further events and there is no call in flight to reject,
 * so without that the wait would sit out the whole timeout and then misreport
 * the drop as a timeout. The drop is thrown as a {@link DaemonTransportError},
 * which {@link withDaemonClient} reports as `DAEMON_DISCONNECTED` (exit 1).
 */
async function awaitDecisionPoint(
  client: DaemonClient,
  mode: OutputMode,
  workflowId: string,
  timeoutMs: number,
): Promise<number> {
  const settled = createSettlePromise();
  // The timeout timer and the close listener reject `settled.promise`. The
  // early-return branches below (initial get errored, or already at a resting
  // phase) return WITHOUT awaiting it, so a rejection during a slow initial
  // get would go unhandled. Attach a no-op catch as a permanent handler; the
  // explicit `await settled.promise` further down still observes the rejection.
  void settled.promise.catch(() => {});

  // Subscribe BEFORE the initial get so we never miss an event that fires in
  // the window between the get returning and the subscription attaching.
  const unsubscribeEvent = client.onEvent((event) => {
    if (eventTargetsWorkflow(event, workflowId) && isResolvingEvent(event.event)) {
      settled.resolve();
    }
  });
  const unsubscribeClose = client.onClose((info) => {
    settled.reject(new DaemonTransportError(info.reason));
  });

  const timer = setTimeout(() => settled.reject(new AwaitTimeoutError()), timeoutMs);

  try {
    // Race-closer: a gate/escalation/terminal reached before subscription is caught here.
    const initial = await rpc<WorkflowDetailDto>(client, 'workflows.get', { workflowId });
    if (!initial.ok) return reportRpcError(mode, initial);
    if (isRestingPhase(phaseOf(initial.payload))) {
      return emitStatus(mode, initial.payload);
    }

    await settled.promise;

    const authoritative = await rpc<WorkflowDetailDto>(client, 'workflows.get', { workflowId });
    if (!authoritative.ok) return reportRpcError(mode, authoritative);
    return emitStatus(mode, authoritative.payload);
  } catch (err) {
    if (err instanceof AwaitTimeoutError) {
      // No `phase`: the run was not at a resting point when the wait began,
      // and nothing is known about it since.
      const timeoutSec = timeoutMs / 1000;
      emitJson(mode, {
        ok: false,
        error: 'AWAIT_TIMEOUT',
        workflowId,
        timeoutSec,
        hint: `The workflow keeps running. Run 'ironcurtain workflow await ${workflowId}' again, or check it with '${statusCommand(workflowId)}'.`,
      });
      emitText(
        `Workflow ${workflowId} did not reach a decision point (a gate or a tool-call escalation) or a terminal ` +
          `state within ${timeoutSec}s; it keeps running.`,
      );
      return EXIT_AWAIT_TIMEOUT;
    }
    // Disconnects and failed requests are reported by withDaemonClient.
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribeEvent();
    unsubscribeClose();
  }
}

/**
 * A phase at which `await` stops: a gate, any terminal, or `interrupted`.
 *
 * `interrupted` is the on-disk fallback synthesized after a daemon restart for a
 * run whose checkpoint exists but has no live orchestrator. No further lifecycle
 * event will ever fire for it, so `await` must resolve immediately rather than
 * block for the full timeout waiting on an event that will never come.
 */
function isRestingPhase(phase: WorkflowPhase): boolean {
  return (
    phase === 'waiting_human' || phase === 'escalation' || phase === 'interrupted' || isTerminalWorkflowPhase(phase)
  );
}

function isResolvingEvent(eventName: string): boolean {
  return (
    eventName === 'workflow.gate_raised' ||
    eventName === 'workflow.escalation_raised' ||
    eventName === 'workflow.completed' ||
    eventName === 'workflow.failed'
  );
}

function eventTargetsWorkflow(event: DaemonEvent, workflowId: string): boolean {
  const payload = event.payload;
  return (
    payload !== null && typeof payload === 'object' && (payload as { workflowId?: unknown }).workflowId === workflowId
  );
}

class AwaitTimeoutError extends Error {}

interface SettlePromise {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

function createSettlePromise(): SettlePromise {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function parseTimeout(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_AWAIT_TIMEOUT_SEC;
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// `workflow gate`
// ---------------------------------------------------------------------------

const GATE_EVENTS = ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'] as const;
type GateEvent = (typeof GATE_EVENTS)[number];

function isGateEvent(value: unknown): value is GateEvent {
  return typeof value === 'string' && (GATE_EVENTS as readonly string[]).includes(value);
}

/** Events whose semantics require non-empty operator feedback. */
function requiresPrompt(event: GateEvent): boolean {
  return event === 'FORCE_REVISION' || event === 'REPLAN';
}

const GATE_USAGE =
  'Usage: ironcurtain workflow gate <workflowId> --gate-id <gateId> --event <EVENT> [--prompt <text>] [--json] [--ensure-daemon]';

/**
 * `workflow gate`: resolves the gate a run is waiting at.
 *
 * The decision is bound to one raise: `--gate-id` must be the `gate.gateId`
 * that `workflow await`/`status` reported. Every visit of a gate has its own
 * id, so a decision copied from an earlier visit (or another gate) is refused
 * by the daemon with `GATE_MISMATCH`, and an event the gate does not route is
 * refused with `EVENT_NOT_ACCEPTED`; in both cases the run keeps waiting and
 * the agent should re-read the gate. The call declares `resolvedBy: 'cli'`
 * so the message log distinguishes this path from a browser decision.
 */
async function runGate(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    'gate-id': { type: 'string' },
    event: { type: 'string' },
    prompt: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    return usageError(mode, 'A workflow id is required', GATE_USAGE);
  }
  const rejectedId = rejectUnsafeWorkflowId(mode, workflowId);
  if (rejectedId !== undefined) return rejectedId;

  const gateId = values['gate-id'];
  if (typeof gateId !== 'string' || gateId.length === 0) {
    return fail(
      mode,
      'INVALID_PARAMS',
      {
        message: '--gate-id is required',
        hint: "Pass the gate.gateId reported by 'workflow await' or 'workflow status' for the gate you reviewed.",
      },
      EXIT_USAGE,
    );
  }

  const event = values.event;
  if (!isGateEvent(event)) {
    return fail(mode, 'INVALID_EVENT', { hint: `--event must be one of: ${GATE_EVENTS.join(', ')}` }, EXIT_USAGE);
  }

  const prompt = typeof values.prompt === 'string' ? values.prompt : undefined;
  // Local fast-fail (the daemon re-validates and is authoritative).
  if (requiresPrompt(event) && (prompt === undefined || prompt.trim().length === 0)) {
    return fail(mode, 'INVALID_PARAMS', { message: `Feedback is required for ${event} events` }, EXIT_USAGE);
  }

  // A reply lost after the decision was sent leaves it unknown whether the
  // daemon applied it; deciding again blind could act on the next gate.
  const report: FailureReport = {
    ids: { workflowId, gateId, event },
    mutates: true,
    hint:
      'The decision may already have been applied. Before deciding again, run ' +
      `'${statusCommand(workflowId)}': if the run is no longer waiting at gate ${gateId}, that gate has ` +
      'been resolved; decide only on the gate it reports now.',
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    const params: Record<string, unknown> = { workflowId, gateId, event, resolvedBy: 'cli' };
    if (prompt !== undefined) params.prompt = prompt;

    const result = await rpc(client, 'workflows.resolveGate', params);
    if (!result.ok) return reportRpcError(mode, result);

    emitJson(mode, { ok: true, workflowId, gateId, event });
    emitText(`Resolved gate ${gateId} for ${workflowId} with ${event}`);
    return EXIT_OK;
  });
}

// ---------------------------------------------------------------------------
// `workflow escalation`
// ---------------------------------------------------------------------------

const ESCALATION_USAGE =
  'Usage: ironcurtain workflow escalation <workflowId> (--approve --escalation-id <id> [--whitelist <n>] | --deny [--escalation-id <id>]) [--json] [--ensure-daemon]';

/**
 * Resolves a tool-call escalation that `status`/`await` reported under
 * `phase:'escalation'`. `--approve` always needs `--escalation-id`: the
 * approval must bind to the call that was reviewed, not to whichever
 * escalation is pending when the command lands (the reviewed one may have
 * expired and the agent raised another). `--deny` may omit it when exactly
 * one escalation is pending. The daemon re-validates both rules.
 */
async function runEscalation(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    approve: { type: 'boolean' },
    deny: { type: 'boolean' },
    'escalation-id': { type: 'string' },
    whitelist: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    return usageError(mode, 'A workflow id is required', ESCALATION_USAGE);
  }
  const rejectedId = rejectUnsafeWorkflowId(mode, workflowId);
  if (rejectedId !== undefined) return rejectedId;

  const approve = values.approve === true;
  const deny = values.deny === true;
  if (approve === deny) {
    return fail(mode, 'INVALID_PARAMS', { message: 'Pass exactly one of --approve or --deny' }, EXIT_USAGE);
  }
  const decision = approve ? 'approved' : 'denied';

  let whitelistSelection: number | undefined;
  if (values.whitelist !== undefined) {
    const raw =
      typeof values.whitelist === 'string' && /^\d+$/.test(values.whitelist) ? Number(values.whitelist) : Number.NaN;
    if (!Number.isSafeInteger(raw)) {
      return fail(
        mode,
        'INVALID_PARAMS',
        { message: '--whitelist must be a non-negative whitelist candidate index' },
        EXIT_USAGE,
      );
    }
    if (!approve) {
      return fail(mode, 'INVALID_PARAMS', { message: '--whitelist only applies with --approve' }, EXIT_USAGE);
    }
    whitelistSelection = raw;
  }

  const escalationId = typeof values['escalation-id'] === 'string' ? values['escalation-id'] : undefined;
  if (approve && (escalationId === undefined || escalationId === '')) {
    return fail(
      mode,
      'INVALID_PARAMS',
      { message: '--approve requires --escalation-id <id> (as listed by status) so it approves the call you reviewed' },
      EXIT_USAGE,
    );
  }

  // A reply lost after the decision was sent leaves it unknown whether the
  // daemon applied it; deciding again blind could act on another escalation.
  const report: FailureReport = {
    ids: { workflowId, ...(escalationId !== undefined ? { escalationId } : {}), decision },
    mutates: true,
    hint:
      'The decision may already have been applied. Before deciding again, run ' +
      `'${statusCommand(workflowId)}': if ${escalationId !== undefined ? `escalation ${escalationId}` : 'the escalation'} ` +
      'is no longer listed, it has been resolved or has expired; decide only on the escalations it reports now.',
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    const params: Record<string, unknown> = { workflowId, decision };
    if (escalationId !== undefined) params.escalationId = escalationId;
    if (whitelistSelection !== undefined) params.whitelistSelection = whitelistSelection;

    const result = await rpc<{ escalationId: string; decision: string }>(client, 'workflows.resolveEscalation', params);
    if (!result.ok) return reportRpcError(mode, result);

    emitJson(mode, { ok: true, workflowId, escalationId: result.payload.escalationId, decision });
    emitText(`Resolved escalation ${result.payload.escalationId} for ${workflowId}: ${decision}`);
    return EXIT_OK;
  });
}

// ---------------------------------------------------------------------------
// `workflow show`
// ---------------------------------------------------------------------------

/** `workflows.artifacts` payload: names and sizes only (see `ArtifactContentDto`). */
interface ArtifactListing {
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly truncated: boolean;
}

/** `workflows.artifactFile` payload (see `FileContentResponseDto`). */
interface ArtifactFileContent {
  readonly content?: string;
  readonly language?: string;
  readonly binary?: boolean;
  readonly error?: string;
}

/**
 * UTF-8 bytes of file text `workflow show` inlines before listing the
 * remaining files as `omitted`. Each file is fetched separately (the daemon
 * caps a file at 1 MiB), so neither the daemon's reply nor this process's
 * output grows with the size of the artifact; `--file <path>` reads one file.
 * The budget is charged with the text actually returned, not the listed size:
 * an agent can grow a file between the listing and the fetch, and every
 * invalid UTF-8 byte comes back as a three-byte U+FFFD.
 */
const SHOW_CONTENT_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Per-file errors after which no other file of the artifact can be read
 * either; `workflow show` stops on these and reports them as the command's
 * error. Any other per-file error (the file was removed or replaced since the
 * listing, its reply was too large, ...) is recorded on that file's entry.
 */
const SHOW_FATAL_FILE_ERRORS: ReadonlySet<string> = new Set(['WORKFLOW_NOT_FOUND', 'ARTIFACT_NOT_FOUND']);

/** Human-readable body for one fetched file (text mode). */
function describeFileContent(file: ArtifactFileContent): string {
  if (file.content !== undefined) return file.content;
  if (file.binary) return '[binary file]';
  return `[${file.error ?? 'unavailable'}]`;
}

const SHOW_USAGE =
  'Usage: ironcurtain workflow show <workflowId> --artifact <name> [--file <path>] [--json] [--ensure-daemon]';

async function runShow(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    artifact: { type: 'string' },
    file: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  const artifactName = values.artifact;
  const filePath = values.file;
  if (!workflowId || typeof artifactName !== 'string' || (filePath !== undefined && typeof filePath !== 'string')) {
    return usageError(mode, 'A workflow id and --artifact <name> are required', SHOW_USAGE);
  }
  const rejectedId = rejectUnsafeWorkflowId(mode, workflowId);
  if (rejectedId !== undefined) return rejectedId;

  // In --json mode the content is in the JSON object on stdout; repeating it
  // on stderr doubled the output and put the raw artifact on the terminal, so
  // stderr gets only a one-line summary, written after the JSON.
  const showText = (message: string): void => {
    if (!mode.json) emitText(message);
  };

  const report: FailureReport = {
    ids: { workflowId, artifactName, ...(typeof filePath === 'string' ? { path: filePath } : {}) },
    mutates: false,
    hint: RETRY_HINT,
  };
  return withDaemonClient(mode, values['ensure-daemon'] === true, report, async (client) => {
    if (typeof filePath === 'string') {
      const result = await rpc<ArtifactFileContent>(client, 'workflows.artifactFile', {
        workflowId,
        artifactName,
        path: filePath,
      });
      if (!result.ok) return reportRpcError(mode, result);
      showText(`--- ${filePath} ---`);
      showText(describeFileContent(result.payload));
      emitJson(mode, { ok: true, path: filePath, ...result.payload });
      if (mode.json) emitText(`Artifact ${artifactName}: ${filePath}; content is in the JSON output.`);
      return EXIT_OK;
    }

    const listing = await rpc<ArtifactListing>(client, 'workflows.artifacts', { workflowId, artifactName });
    if (!listing.ok) return reportRpcError(mode, listing);

    // Fetch files one at a time until the inline budget is spent; the rest are
    // listed with their sizes so the agent can `--file` the ones it wants.
    const files: Record<string, unknown>[] = [];
    let remaining = SHOW_CONTENT_BUDGET_BYTES;
    let omitted = 0;
    const omit = (file: { readonly path: string; readonly size: number }): void => {
      files.push({ path: file.path, size: file.size, omitted: true });
      omitted += 1;
      showText(`--- ${file.path} (${file.size} bytes; omitted, read it with --file ${file.path}) ---`);
    };
    for (const file of listing.payload.files) {
      if (file.size > remaining) {
        omit(file);
        continue;
      }
      const content = await rpc<ArtifactFileContent>(client, 'workflows.artifactFile', {
        workflowId,
        artifactName,
        path: file.path,
      });
      if (!content.ok) {
        if (SHOW_FATAL_FILE_ERRORS.has(content.code)) return reportRpcError(mode, content);
        files.push({ path: file.path, size: file.size, error: content.message, errorCode: content.code });
        showText(`--- ${file.path} (${file.size} bytes) ---`);
        showText(`[${content.code}: ${content.message}]`);
        continue;
      }
      // Charge the text actually returned (see SHOW_CONTENT_BUDGET_BYTES); a
      // file whose text no longer fits is omitted like one listed too large.
      const inlineBytes = Buffer.byteLength(content.payload.content ?? '', 'utf8');
      if (inlineBytes > remaining) {
        omit(file);
        continue;
      }
      remaining -= inlineBytes;
      files.push({ path: file.path, size: file.size, ...content.payload });
      showText(`--- ${file.path} (${file.size} bytes) ---`);
      showText(describeFileContent(content.payload));
    }
    if (listing.payload.truncated) {
      showText(`(listing truncated: the artifact has more files than the daemon lists in one call)`);
    }
    // Rendered before anything is written to stdout, so a failure here is one
    // error object instead of following a success object.
    const omittedNote = omitted > 0 ? `, ${omitted} omitted (read them with --file <path>)` : '';
    const truncatedNote = listing.payload.truncated ? '; listing truncated' : '';
    const summary = `Artifact ${artifactName}: ${files.length} file(s)${omittedNote}${truncatedNote}; content is in the JSON output.`;
    emitJson(mode, { ok: true, files, truncated: listing.payload.truncated });
    if (mode.json) emitText(summary);
    return EXIT_OK;
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The output mode when only the raw arguments are known (for errors outside a subcommand's own parse). */
function looseOutputMode(args: string[]): OutputMode {
  return detectOutputMode(args, { json: { type: 'boolean' } });
}

/**
 * Routes a daemon-backed gate subcommand. Returns the process exit code; the
 * caller (`workflow-command.ts`) sets it as `process.exitCode` and lets the
 * process exit once the output has been flushed. Never throws: an unexpected
 * failure is reported as `CLI_INTERNAL_ERROR` under the output contract.
 */
export async function runDaemonGateCommand(subcommand: string, args: string[]): Promise<number> {
  try {
    switch (subcommand) {
      case 'run':
        return await runRun(args);
      case 'resume':
        return await runResume(args);
      case 'status':
        return await runStatus(args);
      case 'await':
        return await runAwait(args);
      case 'gate':
        return await runGate(args);
      case 'escalation':
        return await runEscalation(args);
      case 'show':
        return await runShow(args);
      default:
        return fail(
          looseOutputMode(args),
          INVALID_USAGE,
          { message: `Unknown daemon-backed workflow subcommand: ${subcommand}` },
          EXIT_USAGE,
        );
    }
  } catch (err) {
    return fail(looseOutputMode(args), CLI_INTERNAL_ERROR, { message: errorMessage(err) });
  }
}
