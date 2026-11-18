/**
 * Tool Call Pipeline -- The core security evaluation logic.
 *
 * Owns the full tool-call policy pipeline: argument validation,
 * annotation-driven normalization, policy evaluation, the opt-in outbound
 * content assessment (assessment.ts), escalation (file-IPC and in-process),
 * auto-approval, circuit breaking, whitelist matching, roots expansion,
 * dispatch, and audit logging.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import {
  PolicyEngine,
  UNRESOLVABLE_PATH_DENY_RESULT,
  destinationGateMayHaveEscalated,
  evaluatedArguments,
  extractAnnotatedPaths,
  reasonForAutoApprover,
} from './policy-engine.js';
import { describeGitRemoteDestination, resolveUrlForDomainCheck, type DomainCheckTarget } from './domain-utils.js';
import { requiresPerCallApproval, withLocalGitSourceReads, type EvaluationView } from './git-structural-rules.js';
import { isPathResolutionError, resolveRealPath } from '../types/argument-roles.js';
import { AuditLog } from './audit-log.js';
import { prepareToolArgs, rewriteResultContent, rewriteStructuredContent } from './path-utils.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { annotateSandboxViolation, type ResolvedSandboxConfig } from './sandbox-integration.js';
import type { ToolCallRequest, PolicyDecision } from '../types/mcp.js';
import {
  AUDIT_STATUS_DISPATCHING,
  HUMAN_APPROVAL_REASON,
  HUMAN_DENIAL_REASON,
  ROOTS_RACE_RETRY_ERROR_PREFIX,
  type AuditEntry,
  type AuditTaintFacts,
  type ContentAssessmentRecord,
} from '../types/audit.js';
import {
  TAINT_CONTEXT_KEY,
  describeTaintEvent,
  evaluateWithTaint,
  sinkTaint,
  type SessionTaint,
} from './taint-policy.js';
import { applyContentAssessment, type ContentAssessor } from './assessment.js';
import type { ClientState } from './mcp-client-manager.js';
import {
  ALLOWED_DIRECTORIES_TOOL,
  RULE_APPROVED_PATH_CHANGED,
  RULE_ROOTS_VERIFICATION_FAILED,
  addRootsToClient,
  captureApprovedPaths,
  describeRootsVerificationFailure,
  findChangedApprovedPaths,
  isReadOnlyAnnotation,
  isRootsRaceResult,
  selectRootsToAdd,
  verifyBackendRoots,
  type ApprovedPath,
} from './roots-expansion.js';
import { RULE_ROOT_NOT_EXPOSABLE, rootExposureRefusal } from './roots-confinement.js';
import * as logger from '../logger.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import {
  autoApprove,
  extractArgsForAutoApprove,
  readUserContext,
  type ApproverExtractionContext,
  type UserContext,
} from './auto-approver.js';
import {
  buildEscalationReviewContext,
  isTrustedUserContextSource,
  type EscalationReviewContext,
} from './escalation-context.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { type ServerContextMap, updateServerContext, formatServerContext } from './server-context.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { ARGUMENT_BUDGET_DENY_RESULT, hasBoundedArgumentStructure, isArgumentBudgetError } from './argument-budget.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { StoredToolAnnotation, ToolAnnotation } from '../pipeline/types.js';
import {
  directoryCandidateIndex,
  extractWhitelistCandidates,
  type ApprovalWhitelist,
  type WhitelistCandidateIpc,
  type WhitelistContext,
  type WhitelistPattern,
} from './approval-whitelist.js';
import {
  handleVirtualProxyTool,
  qualifyPassthroughTarget,
  validateProxyToolArguments,
  type ControlApiClient,
} from '../docker/proxy-tools.js';
import {
  WORKFLOW_COMMIT_SERVER,
  parseWorkflowCommitArguments,
  type WorkflowCommitHandler,
} from './workflow-commit-tool.js';
import {
  ERROR_PREFIX_DENIED,
  ERROR_PREFIX_ESCALATION_REQUIRED,
  ERROR_PREFIX_ESCALATION_DENIED,
  ERROR_PREFIX_UNKNOWN_ARGS,
  ERROR_PREFIX_UNANNOTATED_ARGS,
  ERROR_PREFIX_MISSING_ANNOTATION,
} from './error-prefixes.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_BACKEND_CALL_TIMEOUT_MS,
  DEFAULT_ESCALATION_TIMEOUT_SECONDS,
  maxTotalBackendCallMs,
  relayCallTimeoutMs,
} from './call-timeouts.js';
import {
  callerCancellationSignal,
  describeCallerCancellation,
  escalationAbortReason,
  escalationDeadlineSignal,
  isEscalationWithdrawnError,
  readEscalationAbortReason,
  settleBeforeAbort,
  sleepUnlessAborted,
  type EscalationAbortReason,
  type HandlerRace,
} from './escalation-wait.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxiedTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The escalation request file (`request-<id>.json`) the approval front-ends
 * read. The review context fields are documented on `EscalationReviewContext`:
 * the trusted user message and the untrusted agent justification, each
 * present only when there is one.
 */
interface EscalationFileRequest extends EscalationReviewContext {
  escalationId: string;
  /**
   * When the request was raised (ISO 8601). Several escalations of one
   * session can wait at once (the call mutex is released during the wait);
   * the watcher surfaces them oldest first by this time.
   */
  createdAt: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Readonly<Record<string, string>>;
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: readonly WhitelistCandidateIpc[];
  /** Set when the call must be decided by a human one at a time (see `EvaluationResult.humanOnly`). */
  humanOnly?: true;
}

/** Re-exported from `mcp-client-manager.ts` for call-sites that import it from here. */
export type { ClientState } from './mcp-client-manager.js';

/**
 * Delay before retrying a tool call that returned "access denied" immediately
 * after roots expansion. The filesystem server needs time to async-validate
 * (fs.realpath, fs.stat) the new roots after receiving the rootsListChanged
 * notification. Only reached for servers whose effective roots cannot be
 * read back (see `expandApprovedRoots`); a verified refresh has no race.
 * Exported for test access.
 */
export const ROOTS_RACE_RETRY_DELAY_MS = 200;

/**
 * Audit rule of a call its caller cancelled (`CallToolDeps.signal`) before it
 * was dispatched: the Code Mode script that made it had already ended, so an
 * approval that arrived afterwards is recorded but not acted on.
 */
export const RULE_CALL_CANCELLED = 'call-cancelled';

/**
 * How long the roots verification after an approved escalation may take for
 * a server confined to its roots (`confineToRoots`, the filesystem server).
 * Its relay does not just notify it: it restarts it under an OS sandbox
 * profile that exposes the new roots (srt, then the server, then the MCP
 * handshake), which takes longer than a plain refresh. Other servers keep
 * `ROOTS_REFRESH_TIMEOUT_MS`. A server that is not back in time fails
 * verification like any other, and its connection is dropped.
 */
export const CONFINED_ROOTS_VERIFY_TIMEOUT_MS = 30_000;

/** True when the server's disposition says it runs confined to its MCP roots. */
function isRootsConfined(config: ResolvedSandboxConfig | undefined): boolean {
  return config?.sandboxed === true && config.config.confineToRoots === true;
}

/** Outcome of {@link expandApprovedRoots}. */
type RootsExpansionResult =
  /** `raceRetryAllowed`: roots were applied but not read back, so one roots-race retry is allowed. */
  | { readonly kind: 'ok'; readonly raceRetryAllowed: boolean }
  /** The backend's roots could not be verified; the connection was dropped. */
  | { readonly kind: 'failed'; readonly reason: string }
  /** A confined server cannot be given a root the call needs; nothing was sent. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Adds the roots an approved call needs (see `selectRootsToAdd` in
 * `roots-expansion.ts`) and, when the server reports its effective allowed
 * directories, verifies them after the refresh. On any verification failure
 * the server's connection is dropped: its containment no longer matches what
 * IronCurtain approved, so no further call may reach it.
 *
 * A server confined to its roots is restarted by its relay with an OS
 * profile for the new roots; verification then reads the restarted
 * server's allowed directories and gets {@link CONFINED_ROOTS_VERIFY_TIMEOUT_MS}.
 * A directory its profile can never expose (see `rootExposureRefusal` in
 * `roots-confinement.ts`: one that lies in or contains the IronCurtain home
 * or a credential store, or contains the home directory or a temporary
 * directory) refuses the call before any root is added, instead of letting
 * the server fail it at the OS level.
 *
 * `beforeRootsUpdate` runs immediately before the first root is sent: the
 * roots update acts on the backend on behalf of the call, so the call's
 * write-ahead audit record goes first. If it throws (the audit log cannot
 * be written), no root is added.
 */
async function expandApprovedRoots(
  serverName: string,
  approvedPaths: readonly ApprovedPath[],
  deps: CallToolDeps,
  beforeRootsUpdate: () => void,
): Promise<RootsExpansionResult> {
  const state = deps.clientStates.get(serverName);
  if (!state) return { kind: 'ok', raceRetryAllowed: false };

  const directories = selectRootsToAdd({
    approvedPaths,
    existingRoots: state.roots,
    allowedDirectory: deps.allowedDirectory,
  });
  if (directories.length === 0) return { kind: 'ok', raceRetryAllowed: false };

  const confined = isRootsConfined(deps.resolvedSandboxConfigs.get(serverName));
  if (confined) {
    const refused = directories.flatMap((directory) => {
      const why = rootExposureRefusal(directory);
      return why === undefined ? [] : [`${directory} (${why})`];
    });
    if (refused.length > 0) {
      return {
        kind: 'refused',
        reason:
          `Server "${serverName}" is confined to its roots by the OS sandbox and cannot be given access to ` +
          `${refused.join(', ')}. The call was not executed.`,
      };
    }
  }

  beforeRootsUpdate();
  const refresh = await addRootsToClient(state, directories);
  if (refresh === 'failed') {
    return dropClientConnection(serverName, state, deps, 'the roots update could not be sent to the server');
  }

  if (!serverReportsAllowedDirectories(deps.toolMap, serverName)) {
    // The server cannot report its effective roots, so there is nothing to
    // compare against; keep the legacy roots-race retry for it.
    return { kind: 'ok', raceRetryAllowed: refresh === 'added' };
  }

  const verification = await verifyBackendRoots(
    state.client,
    state.roots,
    directories,
    confined ? { timeoutMs: CONFINED_ROOTS_VERIFY_TIMEOUT_MS } : {},
  );
  if (verification.status === 'verified') return { kind: 'ok', raceRetryAllowed: false };
  return dropClientConnection(serverName, state, deps, describeRootsVerificationFailure(verification));
}

/** True when `serverName` exposes `list_allowed_directories` (server-filesystem does). */
function serverReportsAllowedDirectories(toolMap: Map<string, ProxiedTool>, serverName: string): boolean {
  for (const tool of toolMap.values()) {
    if (tool.serverName === serverName && tool.name === ALLOWED_DIRECTORIES_TOOL) return true;
  }
  return false;
}

/**
 * Removes the server's client state so every later call is refused with
 * "no client connection", and closes the client, which ends the relay
 * subprocess and the backend behind it.
 */
async function dropClientConnection(
  serverName: string,
  state: ClientState,
  deps: CallToolDeps,
  cause: string,
): Promise<RootsExpansionResult> {
  if (deps.clientStates.get(serverName) === state) {
    deps.clientStates.delete(serverName);
  }
  const reason = `Roots verification failed for server "${serverName}": ${cause}. The connection to the server was closed.`;
  logger.warn(`[roots] ${reason}`);
  try {
    await state.client.close();
  } catch {
    // Best effort: the state is already detached, so no call can reach it.
  }
  return { kind: 'failed', reason };
}

const ESCALATION_POLL_INTERVAL_MS = 500;

/** Auto-approve trusted input older than this is rejected as stale. */
const TRUSTED_INPUT_STALENESS_MS = 120_000;

/**
 * Returns true when a user context is safe to act on for auto-approval.
 *
 * For PTY sessions (isPtySession=true):
 *   - source must be 'mux-trusted-input' (set by the trusted mux layer)
 *   - timestamp must be present, valid, not in the future, and within
 *     TRUSTED_INPUT_STALENESS_MS of `now`
 *
 * For non-PTY sessions:
 *   - source is not checked (no mux layer in the path)
 *   - a missing or invalid timestamp does not prevent trust; a valid stale
 *     timestamp still prevents trust. Both session types now stamp every
 *     context they write (source `session-direct`, ISO timestamp), so a
 *     user message authorizes auto-approval for TRUSTED_INPUT_STALENESS_MS
 *     after it was sent; a context without a timestamp can only come from
 *     an older writer.
 *
 * `isPtySession` is the coordinator's own configuration
 * (`ToolCallCoordinatorOptions.isPtySession`, from `IronCurtainConfig`),
 * never an environment variable: the coordinator runs in the session
 * process, whose environment says nothing about the session mode.
 *
 * @param context - The user context parsed from user-context.json
 * @param isPtySession - Whether this is a PTY interactive session
 * @param now - Current time in ms; defaults to Date.now() (injectable for tests)
 */
export function isUserContextTrusted(context: UserContext, isPtySession: boolean, now: number = Date.now()): boolean {
  if (!isTrustedUserContextSource(context, isPtySession)) return false;

  let stale = isPtySession; // non-PTY sessions don't require timestamps
  if (context.timestamp !== undefined) {
    const tsMs = new Date(context.timestamp).getTime();
    if (!Number.isNaN(tsMs)) {
      const ageMs = now - tsMs;
      stale = ageMs > TRUSTED_INPUT_STALENESS_MS || ageMs < 0;
    }
  }
  return !stale;
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * Removes both escalation IPC files. Request is deleted first so the
 * session side sees "request gone + response exists" as normal
 * approval-in-progress rather than an expiry.
 */
function cleanupEscalationFiles(requestPath: string, responsePath: string): void {
  tryUnlink(requestPath);
  tryUnlink(responsePath);
}

/** Parsed escalation response with optional whitelist selection. */
interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

/**
 * Reads and parses the escalation response file if it exists.
 * Returns the response data, or undefined if the file is not present.
 */
function readEscalationResponse(responsePath: string): EscalationResponseData | undefined {
  if (!existsSync(responsePath)) return undefined;
  const raw = JSON.parse(readFileSync(responsePath, 'utf-8')) as Record<string, unknown>;

  // Fail-closed: anything other than an explicit 'approved' or 'denied'
  // string (typos, missing field, null, etc.) must collapse to denied.
  // Treating unrecognized values as approval would silently fail-open
  // on any malformed escalation response.
  if (raw.decision !== 'approved' && raw.decision !== 'denied') {
    return { decision: 'denied' };
  }

  // Validate whitelistSelection: must be an integer if present, discard otherwise
  let whitelistSelection: number | undefined;
  if (typeof raw.whitelistSelection === 'number' && Number.isInteger(raw.whitelistSelection)) {
    whitelistSelection = raw.whitelistSelection;
  }

  return {
    decision: raw.decision,
    ...(whitelistSelection !== undefined ? { whitelistSelection } : {}),
  };
}

/** Outcome of a file-IPC escalation wait. */
type FileEscalationOutcome =
  | { readonly kind: 'response'; readonly response: EscalationResponseData }
  | { readonly kind: 'aborted'; readonly reason: EscalationAbortReason };

/**
 * Waits for a human decision via file-based IPC.
 *
 * Writes a request file to the escalation directory, then polls for a
 * response file. The session process (on the other side) detects the
 * request, surfaces it to the user, and writes the response.
 *
 * The wait ends when a response arrives or when `signal` aborts (the
 * configured escalation timeout, or a cancellation from the coordinator).
 * Both files are removed on the way out, so the session side sees
 * "request gone, no response" and reports the escalation as expired.
 */
async function waitForEscalationDecision(
  escalationDir: string,
  request: EscalationFileRequest,
  signal: AbortSignal,
): Promise<FileEscalationOutcome> {
  const requestPath = resolve(escalationDir, `request-${request.escalationId}.json`);
  const responsePath = resolve(escalationDir, `response-${request.escalationId}.json`);

  atomicWriteJsonSync(requestPath, request);

  while (!signal.aborted) {
    const response = readEscalationResponse(responsePath);
    if (response) {
      cleanupEscalationFiles(requestPath, responsePath);
      return { kind: 'response', response };
    }
    await sleepUnlessAborted(ESCALATION_POLL_INTERVAL_MS, signal);
  }

  // Final check -- a decision may have landed between the last poll and
  // the abort; a real human decision always wins over the deadline.
  const lateResponse = readEscalationResponse(responsePath);
  cleanupEscalationFiles(requestPath, responsePath);
  if (lateResponse) return { kind: 'response', response: lateResponse };
  return {
    kind: 'aborted',
    reason: readEscalationAbortReason(signal) ?? escalationAbortReason('cancelled', 'escalation wait aborted'),
  };
}

/**
 * Where a human decision on an escalation comes from. The in-process handler
 * supersedes the file-IPC directory when both are set.
 */
export interface HumanEscalationChannel {
  /** In-process handler (workflow bundles, tests). */
  readonly onEscalation?: InProcessEscalationFn;
  /** File-IPC escalation directory; the session on the other side writes the response file. */
  readonly escalationDir?: string;
  /** How long a decision is waited for; defaults to `DEFAULT_ESCALATION_TIMEOUT_SECONDS`. */
  readonly escalationTimeoutMs?: number;
}

/** True when `channel` can reach a human at all (an empty directory name reaches nobody). */
export function hasHumanEscalationChannel(channel: HumanEscalationChannel): boolean {
  return typeof channel.onEscalation === 'function' || (channel.escalationDir ?? '') !== '';
}

/** One escalation as a human is asked to decide it. */
export interface HumanEscalation {
  readonly escalationId: string;
  /** The call as the human sees it (its transport arguments). */
  readonly request: ToolCallRequest;
  /** Reason shown to the human approver. */
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  /** Decided by a human one escalation at a time (see `EscalationDetails.humanOnly`). */
  readonly humanOnly: boolean;
  /** Persona active in the coordinator when the call was evaluated (workflow runs). */
  readonly persona?: string;
  /**
   * What the reviewer sees besides the call (`EscalationReviewContext`): the
   * human's last message (trusted) and the agent's justification
   * (untrusted, display only). Handed to the in-process handler and written
   * to the request file; omitted when there is none.
   */
  readonly reviewContext?: EscalationReviewContext;
}

/** How a human escalation wait ended: a decision, or no decision (timeout, cancellation, withdrawal). */
export type HumanDecisionOutcome =
  | { readonly kind: 'human'; readonly response: InProcessEscalation }
  | { readonly kind: 'aborted'; readonly reason: EscalationAbortReason };

/**
 * Asks a human to decide one escalation and waits for the answer, through
 * the in-process handler when the channel has one and through file IPC
 * otherwise. The wait ends at the configured escalation timeout or when
 * `cancelSignal` aborts (coordinator teardown, policy swap), whichever comes
 * first; both end it as `aborted` with a typed reason, never as a denial. A
 * handler that rejects with `EscalationWithdrawnError` ends it as a
 * cancellation; any other handler rejection propagates. A channel that can
 * reach nobody ends it as `aborted` at once (callers check
 * {@link hasHumanEscalationChannel} first and deny without asking).
 *
 * Shared by the tool-call pipeline (after the auto-approver declined) and
 * the MITM egress gate (`egress-policy.ts`), so both reach the human the
 * same way and are cancelled the same way.
 */
export async function waitForHumanDecision(
  channel: HumanEscalationChannel,
  escalation: HumanEscalation,
  cancelSignal: AbortSignal,
): Promise<HumanDecisionOutcome> {
  // A cancellation that landed before the wait (during auto-approval, or
  // a quiesce already in progress) ends it before any human is asked.
  const earlyAbort = readEscalationAbortReason(cancelSignal);
  if (earlyAbort) return { kind: 'aborted', reason: earlyAbort };

  const timeoutMs = channel.escalationTimeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;
  const deadline = escalationDeadlineSignal(cancelSignal, timeoutMs);
  const { request, humanOnly } = escalation;
  const candidates =
    escalation.whitelistCandidates !== undefined && escalation.whitelistCandidates.length > 0
      ? escalation.whitelistCandidates
      : undefined;
  try {
    if (channel.onEscalation) {
      // In-process path: the handler's promise is raced against the
      // deadline signal, which the handler also receives so it can
      // withdraw its prompt when the wait ends without it. A handler
      // that knows nobody will decide any more rejects with
      // EscalationWithdrawnError: a cancellation, not a denial.
      let settled: HandlerRace<InProcessEscalation>;
      try {
        settled = await settleBeforeAbort(
          channel.onEscalation(
            {
              requestId: request.requestId,
              serverName: request.serverName,
              toolName: request.toolName,
              arguments: request.arguments,
              timestamp: request.timestamp,
            },
            escalation.reason,
            escalation.context,
            candidates,
            {
              ...escalation.reviewContext,
              humanOnly,
              escalationId: escalation.escalationId,
              persona: escalation.persona,
              signal: deadline.signal,
            },
          ),
          deadline.signal,
        );
      } catch (err) {
        if (isEscalationWithdrawnError(err)) {
          return { kind: 'aborted', reason: escalationAbortReason('cancelled', err.message) };
        }
        throw err;
      }
      if (settled.settled) return { kind: 'human', response: settled.value };
    } else if (channel.escalationDir !== undefined) {
      // File-IPC path: the session on the other side of the
      // escalation directory writes the response file.
      const outcome = await waitForEscalationDecision(
        channel.escalationDir,
        {
          ...escalation.reviewContext,
          escalationId: escalation.escalationId,
          createdAt: new Date().toISOString(),
          serverName: request.serverName,
          toolName: request.toolName,
          arguments: request.arguments,
          reason: escalation.reason,
          context: escalation.context,
          whitelistCandidates: candidates,
          ...(humanOnly ? { humanOnly: true as const } : {}),
        },
        deadline.signal,
      );
      if (outcome.kind === 'response') return { kind: 'human', response: outcome.response };
      return { kind: 'aborted', reason: outcome.reason };
    }
    return {
      kind: 'aborted',
      reason: readEscalationAbortReason(deadline.signal) ?? escalationAbortReason('cancelled', 'no decision'),
    };
  } finally {
    deadline.dispose();
  }
}

/** Extracts concatenated text from MCP content blocks. */
export function extractTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
    .map((c: Record<string, unknown>) => c.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Returns the JSON-Schema primitive type name for a JavaScript value,
 * or `undefined` for values that don't map to a single JSON-Schema
 * primitive (e.g. functions, symbols). Distinguishes `array` and
 * `null` from `object` the way JSON Schema does.
 */
function jsonSchemaTypeOf(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  return undefined;
}

/**
 * Returns `true` when `value` is compatible with the JSON-Schema
 * primitive `expected`. Only single-level primitive matching -- we
 * don't recurse into nested object/array shapes; that's the MCP
 * server's job.
 *
 * `integer` accepts finite whole numbers; `number` accepts any finite
 * number. All other expected types must match exactly.
 */
function matchesJsonSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
    case 'null':
    case 'array':
    case 'object':
      return jsonSchemaTypeOf(value) === expected;
    default:
      // Unknown or composite types (e.g., string-array in schema) are
      // out of scope for this primitive type-check. Treat as pass so
      // we don't reject calls whose schema uses richer constructs.
      return true;
  }
}

/**
 * Validates tool call arguments against the tool's `inputSchema`.
 * Returns `null` if valid, or an error message describing the first
 * problem encountered.
 *
 * Checks performed (in order):
 *   1. Unknown argument names — any key not declared in
 *      `properties` fails with a listing of valid keys.
 *   2. Primitive type mismatch — for each provided argument whose
 *      schema has a `type` string, the JS value's JSON-Schema
 *      primitive type must match. Does not recurse into object/array
 *      element shapes.
 *
 * Skips validation in two cases:
 *   - The schema has no `properties` object (nothing to check against).
 *   - `additionalProperties` is truthy (explicit opt-out).
 *
 * NOTE: This is stricter than plain JSON Schema, which treats a
 * missing `additionalProperties` as equivalent to `true`. Here we
 * treat it as forbidding unknown keys so typos in tool arguments
 * fail fast instead of silently passing through to the MCP server.
 * Servers that genuinely accept extra keys must declare
 * `additionalProperties: true` explicitly.
 */
export function validateToolArguments(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): string | null {
  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object') return null;
  if (inputSchema.additionalProperties) return null;

  const props = properties as Record<string, unknown>;
  const validKeys = new Set(Object.keys(props));
  const unknownKeys = Object.keys(args).filter((k) => !validKeys.has(k));
  if (unknownKeys.length > 0) {
    const unknownList = unknownKeys.map((k) => `"${k}"`).join(', ');
    const validList = [...validKeys]
      .sort()
      .map((k) => `"${k}"`)
      .join(', ');
    return `${ERROR_PREFIX_UNKNOWN_ARGS} ${unknownList}. Valid parameters are: ${validList}`;
  }

  // Primitive type check: for each provided arg whose schema declares
  // a primitive `type`, verify the argument's runtime type matches.
  // This catches the "agent passed an object where a string was
  // required" case before path normalization stringifies the object
  // into a meaningless sandbox-escape message.
  for (const key of Object.keys(args)) {
    const propSchema = props[key];
    if (!propSchema || typeof propSchema !== 'object') continue;
    const expected = (propSchema as Record<string, unknown>).type;
    if (typeof expected !== 'string') continue;
    if (!matchesJsonSchemaType(args[key], expected)) {
      const received = jsonSchemaTypeOf(args[key]) ?? typeof args[key];
      const article = /^[aeiou]/i.test(expected) ? 'an' : 'a';
      return `Argument "${key}" must be ${article} ${expected} (got ${received}).`;
    }
  }

  return null;
}

/**
 * Returns the argument keys of a call that the tool's stored annotation does
 * not classify (all of them when there is no stored annotation).
 *
 * The policy engine, the approval whitelist, the auto-approver and path
 * normalization only see annotated arguments, so a value under any other
 * key would reach the MCP server unchecked. `validateToolArguments` cannot
 * catch this: it checks keys against the server's live schema, which is
 * exactly where a server release adds or renames arguments (git-mcp-server
 * 2.15 renamed git_clone's destination from `localPath` to `path`), and it
 * skips the check entirely for schemas without `properties` or with
 * `additionalProperties`.
 */
export function findUnannotatedArguments(
  args: Record<string, unknown>,
  stored: StoredToolAnnotation | undefined,
): string[] {
  const annotated = stored?.args ?? {};
  return Object.keys(args).filter((key) => !Object.hasOwn(annotated, key));
}

/** At most this many unannotated keys are named in a denial reason. */
const MAX_LISTED_UNANNOTATED_KEYS = 10;

/**
 * Builds the denial reason for {@link findUnannotatedArguments} hits. The keys
 * come from the agent: each is quoted, rendered terminal-safe and capped, and
 * only the first few are listed (the audit entry keeps the full arguments).
 */
function unannotatedArgumentsReason(serverName: string, toolName: string, keys: readonly string[]): string {
  const listed = keys
    .slice(0, MAX_LISTED_UNANNOTATED_KEYS)
    .map((k) => toDisplayText(JSON.stringify(k), { maxLength: 80 }));
  const more = keys.length - listed.length;
  const list = more > 0 ? `${listed.join(', ')} (and ${more} more)` : listed.join(', ');
  return (
    `${ERROR_PREFIX_UNANNOTATED_ARGS} ${list} for ${serverName}__${toolName}. ` +
    `IronCurtain's tool annotations do not classify these arguments, so policy cannot evaluate them; ` +
    `the server's tool schema has probably changed. ` +
    `Run 'ironcurtain annotate-tools --server ${serverName}' to update the annotations.`
  );
}

/**
 * The git MCP server's sentinel for its session working directory: its tools
 * default `path` to '.', and it resolves exactly '.' to the directory set by
 * git_set_working_dir (any other relative path resolves against the server
 * process's own working directory).
 */
const GIT_SESSION_DIR_SENTINEL = '.';

/**
 * True when a git call leaves its repository path to the git server's
 * session working directory: `path` absent, not a string, blank, or the
 * server's '.' sentinel. The pipeline substitutes the tracked working
 * directory for such calls, so policy and the server see the same path.
 */
export function usesGitSessionWorkingDir(args: Record<string, unknown>): boolean {
  const value = Object.hasOwn(args, 'path') ? args.path : undefined;
  return typeof value !== 'string' || value.trim() === '' || value === GIT_SESSION_DIR_SENTINEL;
}

/**
 * Splits a coordinator tool key of the form `server__tool` into its
 * component parts. Falls back to `('unknown', key)` when the key has
 * no separator (e.g. a raw tool name passed from an unregistered
 * caller). Used for audit-log attribution on unknown-tool rejections.
 */
export function splitToolKey(key: string): [server: string, tool: string] {
  const sep = key.indexOf('__');
  if (sep < 0) return ['unknown', key];
  return [key.slice(0, sep), key.slice(sep + 2)];
}

/** Builds a lookup map from tool name to ProxiedTool for routing. */
export function buildToolMap(allTools: ProxiedTool[]): Map<string, ProxiedTool> {
  const toolMap = new Map<string, ProxiedTool>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }
  return toolMap;
}

/**
 * Asserts that no two tools share the same bare name across servers.
 *
 * The relay's `CallTool` handler (in `mcp-proxy-server.ts`) routes by
 * bare tool name via `toolMap`, which is last-write-wins on
 * collisions. When `SERVER_FILTER` is set, only one backend is loaded
 * and the check is trivially satisfied; multi-backend modes (e.g. the
 * pipeline's list resolver) must not load two servers that expose the
 * same tool name, or calls would silently route to the wrong backend.
 *
 * Throws with a descriptive message listing each duplicate tool and
 * the servers that exposed it. Safe in single-server mode: no work.
 */
export function assertUniqueToolNames(allTools: readonly ProxiedTool[]): void {
  const byName = new Map<string, string[]>();
  for (const tool of allTools) {
    const owners = byName.get(tool.name);
    if (owners) {
      owners.push(tool.serverName);
    } else {
      byName.set(tool.name, [tool.serverName]);
    }
  }
  const collisions = [...byName.entries()].filter(([, owners]) => owners.length > 1);
  if (collisions.length === 0) return;
  const details = collisions.map(([name, owners]) => `  "${name}" exposed by: ${owners.join(', ')}`).join('\n');
  throw new Error(
    'Relay subprocess cannot load multiple backends that expose the same tool name. ' +
      'The CallTool handler routes by bare tool name, so collisions would route to ' +
      'the wrong backend. Either set SERVER_FILTER to load a single server, or ' +
      'resolve the collisions at the backend layer.\n' +
      `Duplicate tool names:\n${details}`,
  );
}

/**
 * The audit `sandboxed` stamp for a server's sandbox disposition:
 *
 * - `true`: the server runs inside an OS sandbox;
 * - `false`: the server asked for an OS sandbox but runs without one
 *   (sandbox-runtime unavailable, `sandboxPolicy: "warn"`);
 * - `undefined` (field omitted): the server opted out with
 *   `"sandbox": false`, or its disposition is unknown.
 *
 * Never `true` unless the disposition says the server is sandboxed, so the
 * audit log cannot claim containment that is not there.
 */
export function auditSandboxStamp(config: ResolvedSandboxConfig | undefined): boolean | undefined {
  if (config === undefined) return undefined;
  if (config.sandboxed) return true;
  return config.reason === 'platform-unavailable' ? false : undefined;
}

/**
 * Creates an audit entry and logs it. Extracted so the audit shape
 * construction is testable independently.
 */
export function buildAuditEntry(
  request: ToolCallRequest,
  argsForTransport: Record<string, unknown>,
  policyDecision: PolicyDecision,
  result: AuditEntry['result'],
  durationMs: number,
  options: {
    escalationResult?: AuditEntry['escalationResult'];
    /** See {@link auditSandboxStamp}: `false` is recorded, `undefined` is omitted. */
    sandboxed?: boolean;
    autoApproved?: boolean;
    whitelistApproved?: boolean;
    whitelistPatternId?: string;
    persona?: string;
    /** Taint facts (taint escalation enabled only); omitted from the entry when undefined. */
    taint?: AuditTaintFacts;
    /** The call's outbound content assessment, when one ran. */
    contentAssessment?: ContentAssessmentRecord;
  },
): AuditEntry {
  return {
    timestamp: request.timestamp,
    requestId: request.requestId,
    serverName: request.serverName,
    toolName: request.toolName,
    arguments: argsForTransport,
    policyDecision,
    escalationResult: options.escalationResult,
    result,
    durationMs,
    sandboxed: options.sandboxed,
    autoApproved: options.autoApproved || undefined,
    whitelistApproved: options.whitelistApproved || undefined,
    whitelistPatternId: options.whitelistPatternId,
    persona: options.persona,
    ...(options.taint !== undefined ? { taint: options.taint } : {}),
    ...(options.contentAssessment !== undefined ? { contentAssessment: options.contentAssessment } : {}),
  };
}

/**
 * The whitelist candidate a human approval is reported under
 * (`HumanApprovalEvent.pattern`): the directory-wide candidate for a call
 * with paths, since the first (exact) candidate binds each path to the
 * approved value itself, which the approval history never stores; the
 * exact candidate for a call without paths (its constraints are
 * destinations and identifiers). Undefined when the escalation offers
 * neither: no candidate at all, or a path whose directory-wide grant the
 * whitelist refuses (the filesystem root, the home directory and its
 * ancestors, credential and startup directories).
 */
function approvalHistoryCandidate(
  patterns: readonly Omit<WhitelistPattern, 'id'>[],
  ipcs: readonly WhitelistCandidateIpc[],
): Omit<WhitelistPattern, 'id'> | undefined {
  const directory = directoryCandidateIndex(ipcs);
  if (directory !== undefined) return patterns.at(directory);
  const exact = patterns.at(0);
  return exact?.constraints.every((c) => c.kind !== 'path') === true ? exact : undefined;
}

/**
 * Hands a human approval to `deps.onHumanApproval`. The approval history is
 * advisory, so a failure there is logged and never reaches the call.
 */
function reportHumanApproval(deps: CallToolDeps, approval: HumanApprovalEvent): void {
  if (deps.onHumanApproval === undefined) return;
  try {
    deps.onHumanApproval(approval);
  } catch (err) {
    logger.warn(
      `[approval-history] could not record a human approval: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Backend dispatch outcome
// ---------------------------------------------------------------------------

/** A settled promise: the value it produced, or the error it threw. */
type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * Runs a backend call and captures its outcome instead of letting it
 * throw. The pipeline wraps only the backend call itself in this, so an
 * audit-log failure raised while recording the outcome propagates to the
 * coordinator as what it is, instead of being caught by a backend
 * `try/catch` and misreported (and re-audited) as a backend error.
 */
async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// MCP tool call response shape
// ---------------------------------------------------------------------------

/** MCP tool call response shape returned by handleCallTool. */
export interface ToolCallResponse {
  content: unknown;
  isError?: boolean;
  /**
   * The backend's `structuredContent`, when it sent one (paths rewritten like
   * `content` in Docker mode). The Code Mode bridge decides whether the agent
   * sees it (`sandbox/structured-results.ts`).
   */
  structuredContent?: unknown;
  /**
   * Internal-only: the realized PolicyDecision from this call. Not part
   * of the MCP protocol; the field is present on the JS object but the
   * MCP SDK serializes only `content` and `isError` over stdio.
   * Used by the coordinator's `handleStructuredToolCall` to surface the
   * full decision trace to in-process callers.
   */
  _policyDecision?: PolicyDecision;
  [key: string]: unknown;
}

/**
 * In-process escalation callback. When set on `CallToolDeps`, the
 * coordinator-driven code path invokes this instead of the file-IPC
 * `waitForEscalationDecision` flow.
 *
 * Callers must resolve to `'approved'` or `'denied'` and may optionally
 * indicate a whitelist pattern to persist (`whitelistSelection`).
 */
export interface InProcessEscalation {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

/**
 * Facts about an escalation that the approval front-end needs beyond the
 * request itself, including the reviewer context (`EscalationReviewContext`):
 * the human's last message (trusted) and the agent's justification
 * (untrusted, display only).
 */
export interface EscalationDetails extends EscalationReviewContext {
  /**
   * The call must be decided by a human one escalation at a time (see
   * `EvaluationResult.humanOnly`): the auto-approver was not consulted, no
   * whitelist candidate is offered, and bulk approval must skip it.
   */
  readonly humanOnly: boolean;
}

/**
 * Per-escalation details handed to an in-process handler alongside the
 * request. `signal` aborts (with an {@link EscalationAbortReason}) when the
 * pipeline stops waiting: the configured escalation timeout elapsed, or the
 * coordinator cancelled the wait for teardown or a policy swap. A handler
 * that shows UI should listen and withdraw its prompt; its eventual return
 * value is ignored after the abort.
 */
export interface InProcessEscalationDetails extends EscalationDetails {
  readonly escalationId: string;
  /** Persona active in the coordinator when the call was evaluated (workflow runs). */
  readonly persona?: string;
  readonly signal: AbortSignal;
}

export type InProcessEscalationFn = (
  request: ToolCallRequest,
  reason: string,
  context: Readonly<Record<string, string>> | undefined,
  whitelistCandidates: readonly WhitelistCandidateIpc[] | undefined,
  details: InProcessEscalationDetails,
) => Promise<InProcessEscalation>;

/**
 * Runs an escalation wait outside the coordinator's call mutex. The runner
 * supplies a cancellation signal that the coordinator aborts when it must
 * stop waiting (close, policy hot-swap); the wait must honour it.
 */
export type EscalationWaitRunner = <T>(wait: (cancelSignal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * A human's approval of an escalated call, as reported to
 * `CallToolDeps.onHumanApproval`.
 */
export interface HumanApprovalEvent {
  readonly serverName: string;
  readonly toolName: string;
  /** Rule that escalated the call (`EvaluationResult.rule`). */
  readonly rule: string;
  /**
   * The pattern the approval covers: the approval whitelist's candidate for
   * the call, generalized to directories, destinations and identifiers (the
   * directory-wide candidate when the call has paths, never the exact one).
   * It carries no raw argument values.
   */
  readonly pattern: Omit<WhitelistPattern, 'id'>;
}

/** Dependencies injected into handleCallTool for testability. */
export interface CallToolDeps {
  toolMap: Map<string, ProxiedTool>;
  policyEngine: PolicyEngine;
  auditLog: AuditLog;
  circuitBreaker: CallCircuitBreaker;
  clientStates: Map<string, ClientState>;
  resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  allowedDirectory: string | undefined;
  escalationDir: string | undefined;
  autoApproveModel: LanguageModelV3 | null;
  /**
   * The session's outbound content assessor, set only when the user enabled
   * the assessment (`contentAssessment.enabled`). Without it an allow that
   * requires the assessment (an `assess` rule) is a plain allow.
   */
  contentAssessor?: ContentAssessor;
  serverContextMap: ServerContextMap;
  /** Ephemeral approval whitelist for this session. */
  whitelist: ApprovalWhitelist;
  /** Control API client for virtual proxy tools. Only set in virtual-only mode. */
  controlApiClient?: ControlApiClient | null;
  /**
   * Target of the coordinator-owned `workflow_commit` tool (server
   * `workflow`). Set only by a coordinator that offers the tool; see
   * `workflow-commit-tool.ts`.
   */
  workflowCommit?: WorkflowCommitHandler;
  /**
   * Optional in-process escalation handler. When set, supersedes the
   * file-IPC escalation path. Used by the coordinator when callers
   * provide a direct callback (e.g., integration tests).
   */
  onEscalation?: InProcessEscalationFn;
  /**
   * Optional trusted-user message for auto-approval context. When set,
   * bypasses the file-based `readUserContext` lookup and feeds this
   * directly to the auto-approver. Used by the coordinator when the
   * in-process caller knows the user's last message.
   */
  autoApproveUserMessage?: string;
  /**
   * The agent's justification for the `execute_code` chain that issued this
   * call (the coordinator reads it when the call enters; see
   * `ToolCallCoordinator.setAgentJustificationProvider`). UNTRUSTED: it is
   * shown to a human reviewer, labelled as the agent's, and nothing else
   * reads it -- not the policy engine, the whitelist or the auto-approver.
   */
  agentJustification?: string;
  /**
   * Whether this session is a PTY (mux / web terminal) session. The file-IPC
   * user context is then trusted for auto-approval only when the trusted
   * host front-end wrote it (`source: 'mux-trusted-input'`) with a fresh
   * timestamp (see `isUserContextTrusted`). Comes from
   * `IronCurtainConfig.isPtySession` through the coordinator; defaults to
   * false (a non-PTY session).
   */
  isPtySession?: boolean;
  /**
   * Optional wrapper used by ToolCallCoordinator to release its call
   * mutex while a policy escalation waits on auto-approval or a human.
   * Direct pipeline callers omit this and keep legacy in-function
   * behavior.
   */
  runEscalationWait?: EscalationWaitRunner;
  /**
   * Persona to stamp onto every audit entry emitted by this call.
   * Supplied by the coordinator from its `currentPersona` field (set by
   * `loadPolicy`). `undefined` for single-session modes that never call
   * `loadPolicy`.
   */
  persona?: string;
  /**
   * Lane (agent stream) this call came from, used to key the circuit
   * breaker's per-lane window. Host-assigned by the Code Mode proxy per
   * agent connection and threaded through the coordinator; `undefined`
   * for callers without one (they share the breaker's default lane).
   */
  lane?: string;
  /**
   * How long an escalated call waits for a decision (file IPC or
   * in-process handler) before it is denied as timed out. Comes from the
   * user's `escalationTimeoutSeconds`; defaults to 300 s when omitted.
   */
  escalationTimeoutMs?: number;
  /**
   * Bound for one backend tool call. The relay enforces it against the
   * real server; the parent waits `relayCallTimeoutMs()` for the relay.
   * Defaults to `DEFAULT_BACKEND_CALL_TIMEOUT_MS` when omitted.
   */
  backendCallTimeoutMs?: number;
  /**
   * The caller's cancellation signal (`ToolCallOptions.signal` on the
   * coordinator): it aborts when nobody waits for the call any more. Checked
   * before a human is asked, again once an approval wait is over and before
   * every dispatch; it also ends a pending escalation wait (audited as
   * `cancelled`, request file removed) and cancels a backend call in flight.
   */
  signal?: AbortSignal;
  /**
   * The session's taint state (sequence-aware policy, see
   * `taint-policy.ts`), owned by the coordinator. Absent when taint
   * escalation is disabled: the pipeline then tracks nothing and records no
   * taint facts. Present: dispatching a taint source taints the session, and
   * a sink call in a tainted session that policy does not deny is decided by
   * a human only.
   */
  taint?: SessionTaint;
  /**
   * Told about each escalation a human approved, once the approved paths
   * passed the post-approval check and before the call acts on a backend.
   * The coordinator records it in the host-side approval history, where
   * repeated approvals of one pattern become proposed constitution
   * amendments (`src/audit/approval-history.ts`). Never called for
   * auto-approver or whitelist approvals, nor for an escalation that offers
   * no generalized whitelist candidate (human-only, which covers taint sinks
   * and content the outbound assessment flagged; per-call; one whose values
   * cannot be generalized; or a path whose directory-wide candidate the
   * whitelist refuses). Whatever it throws is logged and ignored: the
   * history is advisory and never changes the call's outcome.
   */
  onHumanApproval?: (approval: HumanApprovalEvent) => void;
}

/**
 * The escalation reason shown to the human approver: the policy reason plus,
 * for each git remote argument, where it really connects
 * (`origin -> github.com/owner/repo`), resolved the way the policy engine
 * resolves it. The arguments name only the remote, which says nothing about
 * where a push or fetch goes. `args` are the arguments the engine evaluated,
 * so an omitted remote shows as `origin`. The agent-facing denial text and
 * the audit keep the policy reason.
 */
function reasonForApprover(
  reason: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  allowedDirectory: string | undefined,
): string {
  const remotes = extractAnnotatedPaths(args, annotation, ['git-remote-url']);
  if (remotes.length === 0) return reason;
  const destinations = remotes.map((value) => {
    let target: DomainCheckTarget;
    try {
      target = resolveUrlForDomainCheck(value, 'git-remote-url', args, { allowedDirectory });
    } catch {
      target = { status: 'unverifiable', reason: 'the destination could not be resolved', domains: [] };
    }
    return describeGitRemoteDestination(value, target);
  });
  return `${reason} (git remote: ${destinations.join('; ')})`;
}

/**
 * The resource arguments the auto-approver sees and anchors (see
 * extractArgsForAutoApprove), taken from the call as the engine evaluated
 * it. That includes the synthetic read-path argument the engine adds for a
 * git remote argument that names a local repository
 * (withLocalGitSourceReads), canonicalized like every other path argument.
 * The engine escalates a read of a local clone source on that argument, so
 * the human's message has to name the path git will open; built from the
 * agent's arguments alone, the escalated read would have no argument to
 * anchor and the anchor check would pass without it.
 *
 * Returns null when that view cannot be built. The engine denies such a
 * call before it can escalate, so null only ever sends a call to the human.
 */
function approverArguments(
  evaluatedArgs: Record<string, unknown>,
  annotation: ToolAnnotation,
  context: ApproverExtractionContext,
): ReturnType<typeof extractArgsForAutoApprove> | null {
  let view: EvaluationView;
  try {
    view = withLocalGitSourceReads(evaluatedArgs, annotation);
  } catch {
    return null;
  }
  const args: Record<string, unknown> = { ...view.args };
  for (const name of Object.keys(view.annotation.args)) {
    if (Object.hasOwn(annotation.args, name)) continue;
    // A synthetic argument: its value is the path (or paths) git opens, in
    // the spelling the agent gave. Show and anchor the canonical path the
    // engine judged, as for the agent's own path arguments.
    const value = args[name];
    try {
      if (typeof value === 'string') args[name] = resolveRealPath(value);
      else if (Array.isArray(value)) {
        args[name] = value.map((item: unknown) => (typeof item === 'string' ? resolveRealPath(item) : item));
      }
    } catch {
      return null;
    }
  }
  return extractArgsForAutoApprove(args, view.annotation, context);
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Optional caller-provided request identity. Structured callers
 * (e.g. `ToolCallCoordinator.handleStructuredToolCall`) have their
 * own `requestId`/`timestamp` on the inbound request; passing them
 * through here preserves correlation between caller-side tracing
 * and the audit entries emitted by this pipeline.
 *
 * When omitted, `handleCallTool` synthesizes both fields internally
 * (the low-level UTCP path has no externally-assigned request id).
 */
export interface RequestContext {
  readonly requestId: string;
  readonly timestamp: string;
}

/**
 * Handles a single tool call request: policy evaluation, escalation,
 * circuit breaker check, and forwarding to the real MCP server.
 *
 * This is the core security logic -- the single source of truth for
 * the policy evaluation pipeline.
 *
 * Audit contract (fail closed). The audit log is checked before any work
 * starts, and every call that is about to act on a backend gets a
 * write-ahead `dispatching` record before its first side effect (an
 * approved escalation's roots update, the backend call, or a virtual proxy
 * tool), followed by its outcome record. An audit log that cannot be
 * written therefore refuses the call -- including the very first call
 * whose append fails -- instead of letting it run unaudited. Audit failures
 * propagate as `AuditLogUnavailableError` (code `AUDIT_LOG_UNAVAILABLE`);
 * the coordinator latches them and stops admitting tool calls.
 *
 * Cancellation contract. When `deps.signal` has aborted, nothing acts on the
 * call any more: it is not escalated, a pending escalation wait ends as
 * `cancelled` (request file removed), an approval that lands afterwards is
 * audited but not acted on (`call-cancelled`), and a backend call in flight
 * is cancelled.
 *
 * @param requestContext - optional caller-provided requestId/timestamp
 *        so structured callers keep correlation with audit entries.
 *        When omitted, both are generated internally.
 * @throws {AuditLogUnavailableError} when the audit log is unwritable.
 */
export async function handleCallTool(
  toolName: string,
  rawArgs: Record<string, unknown>,
  deps: CallToolDeps,
  requestContext?: RequestContext,
): Promise<ToolCallResponse> {
  // Fail closed before anything else: a latched or closed audit log
  // refuses the call outright. No branch below may run unaudited, and
  // a deny-path audit write would only rethrow the same error later --
  // after a human may already have been asked to approve the call.
  deps.auditLog.assertWritable();

  // Use the caller's requestId/timestamp when supplied so structured
  // callers can correlate their tracing with the audit entries we
  // emit. Low-level callers (e.g. UTCP) leave `requestContext` unset
  // and we synthesize fresh values below.
  const callerRequestId = requestContext?.requestId ?? uuidv4();
  const callerTimestamp = requestContext?.timestamp ?? new Date().toISOString();

  const toolInfo = deps.toolMap.get(toolName);

  function denyAdmission(rule: string, reason: string, auditArgs: Record<string, unknown>): ToolCallResponse {
    const [serverName, name] = toolInfo ? [toolInfo.serverName, toolInfo.name] : splitToolKey(toolName);
    const policyDecision: PolicyDecision = { status: 'deny', rule, reason };
    deps.auditLog.log({
      timestamp: callerTimestamp,
      requestId: callerRequestId,
      serverName,
      toolName: name,
      arguments: auditArgs,
      policyDecision,
      result: { status: 'denied', error: reason },
      durationMs: 0,
      persona: deps.persona,
    });
    return {
      content: [{ type: 'text', text: reason }],
      isError: true,
      _policyDecision: policyDecision,
    };
  }

  // Keep the decision and request identity in the audit without traversing
  // the rejected argument tree again to redact or serialize it.
  if (!hasBoundedArgumentStructure(rawArgs)) {
    return denyAdmission(ARGUMENT_BUDGET_DENY_RESULT.rule, ARGUMENT_BUDGET_DENY_RESULT.reason, {});
  }
  if (!toolInfo) return denyAdmission('unknown-tool', `Unknown tool: ${toolName}`, rawArgs);

  // Annotation-driven normalization: split into transport vs policy args.
  // Trusted servers skip annotation lookup and prepareToolArgs -- use raw args directly
  // (their per-tool policy then judges exactly the arguments the server receives).
  let annotation: ToolAnnotation | undefined;
  try {
    annotation = deps.policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name, rawArgs);
  } catch (err) {
    if (!isArgumentBudgetError(err)) throw err;
    return denyAdmission(ARGUMENT_BUDGET_DENY_RESULT.rule, ARGUMENT_BUDGET_DENY_RESULT.reason, rawArgs);
  }
  const isTrusted = !annotation && deps.policyEngine.isTrustedServer(toolInfo.serverName);

  if (!annotation && !isTrusted) {
    const reason = `${ERROR_PREFIX_MISSING_ANNOTATION} ${toolInfo.serverName}__${toolInfo.name}. Re-run 'ironcurtain annotate-tools' to update.`;
    // Security invariant: every tool call outcome is audited.
    deps.auditLog.log({
      timestamp: callerTimestamp,
      requestId: callerRequestId,
      serverName: toolInfo.serverName,
      toolName: toolInfo.name,
      arguments: rawArgs,
      policyDecision: { status: 'deny', rule: 'missing-annotation', reason },
      result: { status: 'denied', error: reason },
      durationMs: 0,
      persona: deps.persona,
    });
    return {
      content: [{ type: 'text', text: reason }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'missing-annotation', reason },
    };
  }

  // Validate argument names against the tool's schema.
  // Skip for trusted servers (check directly, not via isTrusted which also requires missing annotation).
  if (!deps.policyEngine.isTrustedServer(toolInfo.serverName)) {
    const validationError = validateToolArguments(rawArgs, toolInfo.inputSchema);
    if (validationError) {
      deps.auditLog.log({
        timestamp: callerTimestamp,
        requestId: callerRequestId,
        serverName: toolInfo.serverName,
        toolName: toolInfo.name,
        arguments: rawArgs,
        policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: validationError },
        result: { status: 'denied', error: validationError },
        durationMs: 0,
        persona: deps.persona,
      });
      return {
        content: [{ type: 'text', text: validationError }],
        isError: true,
        _policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: validationError },
      };
    }

    // Every argument must be classified by the stored annotation, whatever
    // the live schema accepts (validateToolArguments checks the live schema
    // and skips permissive ones). An unclassified argument would reach the
    // server without any protected-path, containment, domain or list check,
    // invisible to the whitelist and the auto-approver. Fail closed.
    const unannotated = findUnannotatedArguments(
      rawArgs,
      deps.policyEngine.getStoredAnnotation(toolInfo.serverName, toolInfo.name),
    );
    if (unannotated.length > 0) {
      const reason = unannotatedArgumentsReason(toolInfo.serverName, toolInfo.name, unannotated);
      deps.auditLog.log({
        timestamp: callerTimestamp,
        requestId: callerRequestId,
        serverName: toolInfo.serverName,
        toolName: toolInfo.name,
        arguments: rawArgs,
        policyDecision: { status: 'deny', rule: 'unannotated-arguments', reason },
        result: { status: 'denied', error: reason },
        durationMs: 0,
        persona: deps.persona,
      });
      return {
        content: [{ type: 'text', text: reason }],
        isError: true,
        _policyDecision: { status: 'deny', rule: 'unannotated-arguments', reason },
      };
    }

    // The virtual proxy server validates its domain argument here, before
    // policy evaluation, so neither the policy engine, the auto-approver nor
    // a human reviewer ever sees a passthrough target the MITM proxy would
    // reject anyway (`parsePassthroughTarget`: IP literals in any IPv4
    // spelling, wildcards, localhost, *.docker.internal, local and metadata
    // names, malformed text, a port other than 443 or 80). The handler
    // re-validates at dispatch as defence in depth.
    if (toolInfo.serverName === 'proxy') {
      const proxyArgError = validateProxyToolArguments(toolInfo.name, rawArgs);
      if (proxyArgError !== null) {
        deps.auditLog.log({
          timestamp: callerTimestamp,
          requestId: callerRequestId,
          serverName: toolInfo.serverName,
          toolName: toolInfo.name,
          arguments: rawArgs,
          policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: proxyArgError },
          result: { status: 'denied', error: proxyArgError },
          durationMs: 0,
          persona: deps.persona,
        });
        return {
          content: [{ type: 'text', text: proxyArgError }],
          isError: true,
          _policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: proxyArgError },
        };
      }
    }

    // A workflow commit is bounded and checked (required fields, sizes, a
    // one-line verdict) before policy evaluation, like the proxy tools: a
    // malformed commit is denied here and never reaches the orchestrator.
    if (toolInfo.serverName === WORKFLOW_COMMIT_SERVER) {
      const parsedCommit = parseWorkflowCommitArguments(rawArgs);
      if (!parsedCommit.ok) {
        deps.auditLog.log({
          timestamp: callerTimestamp,
          requestId: callerRequestId,
          serverName: toolInfo.serverName,
          toolName: toolInfo.name,
          arguments: rawArgs,
          policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: parsedCommit.error },
          result: { status: 'denied', error: parsedCommit.error },
          durationMs: 0,
          persona: deps.persona,
        });
        return {
          content: [{ type: 'text', text: parsedCommit.error }],
          isError: true,
          _policyDecision: { status: 'deny', rule: 'invalid-arguments', reason: parsedCommit.error },
        };
      }
    }
  }

  let argsForTransport: Record<string, unknown>;
  let argsForPolicy: Record<string, unknown>;

  if (isTrusted) {
    // Trusted server with no annotation: use raw args for both transport and policy
    argsForTransport = rawArgs;
    argsForPolicy = rawArgs;
  } else {
    // annotation is guaranteed non-null here: we returned early if both are falsy
    const resolvedAnnotation = annotation as ToolAnnotation;

    // Enrich git tool args with the locally tracked working directory when
    // the agent omits `path`, leaves it blank, or passes '.'. The git MCP
    // server resolves all of these to its session working directory (set via
    // git_set_working_dir), which may lie outside the sandbox; the policy
    // engine needs that explicit path to resolve sandbox containment and the
    // default remote URL for domain-based policy rules. Resolving '.' against
    // the sandbox instead would let policy evaluate a different directory
    // than git acts on. The tracked directory is sent to both policy and
    // transport, so they see the same path.
    // The serverContextMap mirrors the git server's session working
    // directory from successful git_set_working_dir calls (cleared by
    // git_clear_working_dir), avoiding an RPC.
    let effectiveRawArgs = rawArgs;
    if (toolInfo.serverName === 'git' && 'path' in resolvedAnnotation.args && usesGitSessionWorkingDir(rawArgs)) {
      const gitWorkDir = deps.serverContextMap.get('git')?.workingDirectory;
      if (!gitWorkDir) {
        const errorMsg =
          'Git server has no working directory set. Pass an explicit path or call git_set_working_dir first.';
        deps.auditLog.log(
          buildAuditEntry(
            {
              requestId: callerRequestId,
              serverName: toolInfo.serverName,
              toolName: toolInfo.name,
              arguments: rawArgs,
              timestamp: callerTimestamp,
            },
            rawArgs,
            { status: 'deny', rule: 'git-path-enrichment-failed', reason: errorMsg },
            { status: 'denied', error: errorMsg },
            0,
            { persona: deps.persona },
          ),
        );
        return {
          content: [{ type: 'text', text: `Error: ${errorMsg}` }],
          isError: true,
          _policyDecision: { status: 'deny', rule: 'git-path-enrichment-failed', reason: errorMsg },
        };
      }
      effectiveRawArgs = { ...rawArgs, path: gitWorkDir };
    }

    // A passthrough approval is scoped to one host AND one port (443 unless
    // the agent names 80). Make the port explicit before policy sees the
    // call, so the human reviewing the escalation and the approval whitelist
    // both see exactly the scope that will be granted (`example.com:443`),
    // and a whitelist entry for `example.com:443` can never also admit a
    // later `example.com:80` request. The value already passed
    // `validateProxyToolArguments` above, and the proxy tool handler parses
    // the same qualified value.
    if (
      toolInfo.serverName === 'proxy' &&
      (toolInfo.name === 'add_proxy_domain' || toolInfo.name === 'remove_proxy_domain') &&
      typeof effectiveRawArgs['domain'] === 'string'
    ) {
      effectiveRawArgs = { ...effectiveRawArgs, domain: qualifyPassthroughTarget(effectiveRawArgs['domain']) };
    }

    try {
      ({ argsForTransport, argsForPolicy } = prepareToolArgs(
        effectiveRawArgs,
        resolvedAnnotation,
        deps.allowedDirectory,
        CONTAINER_WORKSPACE_DIR,
      ));
    } catch (err) {
      // Path canonicalization fails closed (resolveRealPath throws when no
      // ancestor of a path argument resolves). Deny and audit, like the
      // other pre-evaluation denials, instead of rejecting unaudited.
      if (!isPathResolutionError(err) && !isArgumentBudgetError(err)) throw err;
      const { rule, reason } = isArgumentBudgetError(err) ? ARGUMENT_BUDGET_DENY_RESULT : UNRESOLVABLE_PATH_DENY_RESULT;
      deps.auditLog.log(
        buildAuditEntry(
          {
            requestId: callerRequestId,
            serverName: toolInfo.serverName,
            toolName: toolInfo.name,
            arguments: rawArgs,
            timestamp: callerTimestamp,
          },
          rawArgs,
          { status: 'deny', rule, reason },
          { status: 'denied', error: reason },
          0,
          { persona: deps.persona },
        ),
      );
      return {
        content: [{ type: 'text', text: `${ERROR_PREFIX_DENIED} ${reason}` }],
        isError: true,
        _policyDecision: { status: 'deny', rule, reason },
      };
    }
  }

  const request: ToolCallRequest = {
    requestId: callerRequestId,
    serverName: toolInfo.serverName,
    toolName: toolInfo.name,
    arguments: argsForPolicy,
    timestamp: callerTimestamp,
  };

  const policyEvaluation = deps.policyEngine.evaluate(request, {
    gitWorkingDirectory: deps.serverContextMap.get('git')?.workingDirectory,
  });

  // Outbound content assessment (opt-in). It looks at what the call sends
  // out, in the form the transport sends it, when the policy allowed the
  // call subject to it or escalated the call (a delegate could otherwise
  // approve content nobody read). Content that does not pass, and an
  // assessment that fails, turn the call into a human-only escalation; a
  // pass leaves the decision as it is. The verdict is recorded on every
  // audit entry of the call.
  const contentAssessment = deps.contentAssessor
    ? await deps.contentAssessor.assessCall(
        policyEvaluation,
        annotation,
        argsForTransport,
        toolInfo.serverName,
        toolInfo.name,
      )
    : undefined;
  const assessedEvaluation =
    contentAssessment === undefined ? policyEvaluation : applyContentAssessment(policyEvaluation, contentAssessment);

  // Sequence-aware (taint) policy, when enabled: in a session that has read
  // untrusted content, a sink call that policy does not deny is decided by a
  // human only (no whitelist, no auto-approver, no bulk approval). Applied
  // before anything else looks at the decision, and after the content
  // assessment: the assessment may wait on its model, and the session's
  // taint is read once that wait is over, so a taint source dispatched in
  // the meantime (a MITM egress decision takes no call mutex) still gates
  // this call. The assessment never needs the taint: a call the taint
  // escalation would gate is assessed on the policy's own allow (an allow
  // carrying outbound content always requires the assessment) or escalation.
  const taintCall = {
    serverName: toolInfo.serverName,
    toolName: toolInfo.name,
    trustedServer: deps.policyEngine.isTrustedServer(toolInfo.serverName),
  };
  const taintedEvaluation = evaluateWithTaint(deps.taint, assessedEvaluation, taintCall);
  const evaluation = taintedEvaluation.evaluation;
  // The sink facts for the call's audit records. Also set when the session
  // becomes tainted while the auto-approver decides this call (see
  // waitForDecision).
  let taintSinkFacts = taintedEvaluation.sinkFacts;
  // A taint source taints the session once it is dispatched (see logWriteAhead).
  const taintSource = deps.taint?.classify(toolInfo.serverName, toolInfo.name).source === true;
  let taintSourceDispatched = false;

  const policyDecision: PolicyDecision = {
    status: evaluation.decision,
    rule: evaluation.rule,
    reason: evaluation.reason,
  };

  let escalationResult: AuditEntry['escalationResult'];
  let autoApproved = false;
  let whitelistApproved = false;
  let whitelistPatternId: string | undefined;
  let rootsRaceRetryAllowed = false;

  const serverSandboxConfig = deps.resolvedSandboxConfigs.get(toolInfo.serverName);
  const serverIsSandboxed = serverSandboxConfig?.sandboxed === true;
  const sandboxStamp = auditSandboxStamp(serverSandboxConfig);

  /** The call's taint facts for its audit records (taint escalation enabled only). */
  function auditTaintFacts(): AuditTaintFacts | undefined {
    if (!taintSourceDispatched) return taintSinkFacts;
    return { ...taintSinkFacts, source: true };
  }

  function logAudit(
    result: AuditEntry['result'],
    durationMs: number,
    overrideEscalation?: AuditEntry['escalationResult'],
  ): void {
    const entry = buildAuditEntry(request, argsForTransport, policyDecision, result, durationMs, {
      escalationResult: overrideEscalation ?? escalationResult,
      sandboxed: sandboxStamp,
      autoApproved,
      whitelistApproved: whitelistApproved || undefined,
      whitelistPatternId,
      persona: deps.persona,
      taint: auditTaintFacts(),
      contentAssessment,
    });
    deps.auditLog.log(entry);
  }

  /**
   * Appends the call's write-ahead `dispatching` record, at most once,
   * immediately before the first thing the trusted process does to a
   * backend on the call's behalf: an approved escalation's roots update,
   * the backend call itself, or a virtual proxy tool. It carries the
   * realized allow decision (including any approval). If the audit log
   * cannot take it, this throws and nothing reaches the backend -- that
   * covers the first failing append, not only the calls after it.
   *
   * For a taint source this is also where the session becomes tainted: the
   * record (and every later one of the call) says `taint.source`, which is
   * what a resume replays, and the flag is set before the backend can
   * return anything to the agent.
   */
  let writeAheadLogged = false;
  function logWriteAhead(): void {
    if (writeAheadLogged) return;
    if (taintSource) taintSourceDispatched = true;
    logAudit({ status: AUDIT_STATUS_DISPATCHING }, 0);
    writeAheadLogged = true;
    if (taintSource) {
      deps.taint?.markTainted({
        via: `${request.serverName}/${request.toolName}`,
        requestId: request.requestId,
        timestamp: request.timestamp,
      });
    }
  }

  /**
   * Denies an escalated call after it was approved: the approval stands
   * in the audit entry, the outcome is a policy denial under `rule`.
   * Also used at T0 (see `denyUnresolvablePath`), before any approval,
   * when the entry carries no escalation result.
   */
  function denyAfterApproval(rule: string, reason: string): ToolCallResponse {
    policyDecision.status = 'deny';
    policyDecision.rule = rule;
    policyDecision.reason = reason;
    logAudit({ status: 'denied', error: reason }, 0);
    return {
      content: [{ type: 'text', text: `${ERROR_PREFIX_DENIED} ${reason}` }],
      isError: true,
      _policyDecision: { ...policyDecision },
    };
  }

  /**
   * Handles an error thrown while roots expansion canonicalizes paths
   * (T0 capture, T1 re-check, root selection). A PathResolutionError
   * (resolveRealPath could not canonicalize anything) denies the call
   * with an audit entry, like the unresolvable-path deny before
   * evaluation; any other error is re-thrown.
   */
  function denyUnresolvablePath(err: unknown): ToolCallResponse {
    if (!isPathResolutionError(err)) throw err;
    const { rule, reason } = UNRESOLVABLE_PATH_DENY_RESULT;
    return denyAfterApproval(rule, reason);
  }

  /**
   * Denies a call its caller has cancelled (`deps.signal`) before anything
   * acts on it: no human is asked, no root is widened and nothing reaches the
   * backend. An approval already given stays in the audit entry; the outcome
   * is a denial under `call-cancelled`. Undefined while the call is wanted.
   */
  function refuseCancelledCall(): ToolCallResponse | undefined {
    const signal = deps.signal;
    if (signal?.aborted !== true) return undefined;
    return denyAfterApproval(
      RULE_CALL_CANCELLED,
      `Tool call cancelled before it was dispatched: ${describeCallerCancellation(signal.reason)}. The call was not executed.`,
    );
  }

  // A call nobody waits for any more is not escalated or dispatched. A
  // policy denial keeps its own reason.
  if (evaluation.decision !== 'deny') {
    const cancelled = refuseCancelledCall();
    if (cancelled) return cancelled;
  }

  if (evaluation.decision === 'escalate') {
    // Every server but a trusted one has an annotation here (missing-annotation
    // returned early above). A trusted server's escalation (a bulk memory_forget
    // or a large memory_ingest, see trusted-server-policy.ts) concerns a tool with
    // no resource arguments, so it is handled with an empty annotation: no path to
    // capture or turn into a root, nothing for a whitelist pattern to constrain.
    // Those escalations are human-only, so neither the whitelist nor the
    // auto-approver is consulted either.
    const resolvedAnnotation: ToolAnnotation = annotation ?? {
      toolName: toolInfo.name,
      serverName: toolInfo.serverName,
      comment: 'Trusted server tool (no annotation)',
      args: {},
    };

    // T0: the canonical form of every path argument as the policy engine
    // just evaluated it, plus the root each escalated path would need.
    // Captured before the whitelist, the auto-approver or a human sees the
    // call, so an approval covers exactly these paths.
    let approvedPaths: ApprovedPath[];
    try {
      approvedPaths = captureApprovedPaths({
        args: argsForPolicy,
        annotation: resolvedAnnotation,
        escalatedRoles: evaluation.escalatedRoles,
        allowedDirectory: deps.allowedDirectory,
      });
    } catch (err) {
      return denyUnresolvablePath(err);
    }

    // Whitelist pattern the human selected, added after the T1 check.
    let selectedWhitelistPattern: Parameters<ApprovalWhitelist['add']>[0] | undefined;
    // The pattern a human approval covers (the generalized whitelist
    // candidate, whether or not the human chose to whitelist it), reported to
    // the approval history after the T1 check. Undefined for every other kind
    // of approval.
    let humanApprovedPattern: Omit<WhitelistPattern, 'id'> | undefined;

    // A human-only escalation (add_proxy_domain opening a passthrough tunnel;
    // structural-nested-argument-escalate, an argument holding a nested
    // object or array whose inner values neither a pattern nor the approver
    // sees) is decided by a human and nothing else: no whitelist pattern can
    // discharge it, none is offered, the auto-approver is not consulted, and
    // the request tells the front-end to keep it out of "approve all".
    const humanOnly = evaluation.humanOnly === true;

    // The whitelist and the approver see the call as the engine evaluated
    // it (an omitted git remote is `origin`). A pattern can discharge the
    // escalation only if it constrains every role that escalated it.
    const evaluatedArgs = evaluatedArguments(toolInfo.serverName, toolInfo.name, argsForPolicy, resolvedAnnotation);
    const whitelistContext: WhitelistContext = {
      escalatedRoles: evaluation.escalatedRoles,
      allowedDirectory: deps.allowedDirectory,
    };

    // A structural git escalation (a write inside `.git`, a repository whose
    // config or layout host git must not act on unseen) names state the
    // agent can change right after an approval, so no pattern may discharge
    // it and none is offered: every such call is approved on its own. Unlike
    // a human-only escalation it may still be auto-approved, one call at a
    // time.
    const perCallApproval = requiresPerCallApproval(evaluation);
    const whitelistable = !humanOnly && !perCallApproval;

    if (whitelistable) {
      const whitelistMatch = deps.whitelist.match(
        toolInfo.serverName,
        toolInfo.name,
        evaluatedArgs,
        resolvedAnnotation,
        whitelistContext,
      );
      if (whitelistMatch.matched) {
        whitelistApproved = true;
        whitelistPatternId = whitelistMatch.patternId;
        escalationResult = 'approved';
        policyDecision.status = 'allow';
        policyDecision.reason = `Whitelist-approved: ${whitelistMatch.pattern.description}`;
      }
    }

    if (!whitelistApproved) {
      // Escalation routing: in-process callback supersedes file-IPC.
      // If neither is configured, auto-deny with a descriptive error.
      const hasInProcess = typeof deps.onEscalation === 'function';
      if (!hasInProcess && !deps.escalationDir) {
        logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
        // No escalation handler is available, so the outcome is a
        // denial -- not a runtime error. Stamp the returned decision
        // as `deny` so the coordinator's status classifier sees it
        // correctly.
        return {
          content: [
            {
              type: 'text',
              text: `${ERROR_PREFIX_ESCALATION_REQUIRED} ${evaluation.reason}. Action denied (no escalation handler).`,
            },
          ],
          isError: true,
          _policyDecision: { ...policyDecision, status: 'deny' },
        };
      }

      const escalationId = uuidv4();

      // Capture the whitelist candidates and server context while the
      // coordinator's call mutex is still held. The potentially slow
      // auto-approval / human wait below can then run outside that mutex.
      // A human-only or per-call escalation offers no candidate: an
      // /approve+ on it is a plain approval.
      const { patterns: candidatePatterns, ipcs: candidateIpcs }: ReturnType<typeof extractWhitelistCandidates> =
        whitelistable
          ? extractWhitelistCandidates(
              toolInfo.serverName,
              toolInfo.name,
              evaluatedArgs,
              resolvedAnnotation,
              whitelistContext,
              escalationId,
              evaluation.reason,
            )
          : { patterns: [], ipcs: [] };
      // A taint escalation also tells the human what tainted the session.
      const serverContext = formatServerContext(deps.serverContextMap, toolInfo.serverName);
      const escalationContext = taintSinkFacts?.taintedBy
        ? { ...serverContext, [TAINT_CONTEXT_KEY]: describeTaintEvent(taintSinkFacts.taintedBy) }
        : serverContext;
      const approverReason = reasonForApprover(
        evaluation.reason,
        evaluatedArgs,
        resolvedAnnotation,
        deps.allowedDirectory,
      );

      const escalationTimeoutMs = deps.escalationTimeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;

      type DecisionOutcome =
        | { readonly kind: 'auto-approved'; readonly reason: string }
        | { readonly kind: 'human'; readonly response: InProcessEscalation }
        /** Nobody decided before the deadline, or the coordinator withdrew the wait. */
        | { readonly kind: 'aborted'; readonly reason: EscalationAbortReason };

      /**
       * `cancelSignal` comes from the coordinator (teardown / policy swap);
       * the configured escalation timeout is layered on top here so both
       * the file-IPC wait and an in-process handler see one deadline.
       */
      const waitForDecision = async (cancelSignal: AbortSignal): Promise<DecisionOutcome> => {
        // Try auto-approve before falling through to human escalation.
        // Prefer the caller-provided `autoApproveUserMessage` when set;
        // otherwise fall back to the file-IPC user context. A human-only
        // escalation skips the approver altogether. A wait that is already
        // cancelled skips it too; one cancelled mid-request aborts the
        // model call (the approver then reports `escalate`).
        if (deps.autoApproveModel && !humanOnly && !cancelSignal.aborted) {
          const userMessage =
            deps.autoApproveUserMessage ??
            (deps.escalationDir ? readUserContext(deps.escalationDir)?.userMessage : undefined);

          if (userMessage !== undefined && userMessage !== '') {
            // When using the file-IPC context, validate trust metadata
            // (source for PTY sessions, staleness). Direct callers bypass
            // this check (they establish trust out-of-band).
            let trusted = true;
            if (deps.autoApproveUserMessage === undefined && deps.escalationDir) {
              const ctx = readUserContext(deps.escalationDir);
              trusted = ctx !== null && isUserContextTrusted(ctx, deps.isPtySession === true);
            }

            // The approver gets structured data only: the rule, a reason
            // with no agent-derived text, and the arguments as the engine
            // evaluated them (a local git source's path included), with URL
            // roles reduced to the validated hostnames they connect to (a
            // named remote shows its destination, not its name alone).
            // A named remote anchors only through its host when the domain
            // gate escalated the call, or may have (a per-call git
            // escalation names a call the gate escalated too).
            const approverArgs = trusted
              ? approverArguments(evaluatedArgs, resolvedAnnotation, {
                  escalatedRoles: evaluation.escalatedRoles,
                  destinationGate: destinationGateMayHaveEscalated(evaluation),
                  allowedDirectory: deps.allowedDirectory,
                })
              : null;

            if (approverArgs !== null) {
              const autoResult = await autoApprove(
                {
                  userMessage,
                  toolName: `${toolInfo.serverName}/${toolInfo.name}`,
                  rule: evaluation.rule,
                  escalationReason: reasonForAutoApprover(evaluation),
                  arguments: approverArgs,
                },
                deps.autoApproveModel,
                { abortSignal: cancelSignal },
              );

              if (autoResult.decision === 'approve') {
                // The call mutex is released while the approver decides,
                // so another call may have dispatched a taint source in the
                // meantime (taint escalation enabled). A sink that the taint
                // now gates needs a human, and the approver's decision
                // predates the taint: the call is withdrawn (audited as
                // cancelled), and calling it again asks a human.
                const lateTaint = sinkTaint(deps.taint, taintCall);
                if (lateTaint !== undefined) {
                  taintSinkFacts = { sink: true, taintedBy: lateTaint };
                  return {
                    kind: 'aborted',
                    reason: escalationAbortReason(
                      'cancelled',
                      `the session read content from an untrusted source (${lateTaint.via}) while the ` +
                        'auto-approver decided, so only a human may approve this call; call it again to ask one',
                    ),
                  };
                }
                return { kind: 'auto-approved', reason: autoResult.reasoning };
              }
            }
          }
        }

        // Nobody approved on the human's behalf: ask the human. One of the
        // two channels is guaranteed to exist: we returned early above when
        // both `onEscalation` and `escalationDir` were unset.
        //
        // What the human reviewer sees besides the call: their own last
        // message (trusted, read like the auto-approver reads it) and the
        // agent's justification (untrusted, display only). Read only now,
        // for the human route: the auto-approver above never sees the
        // justification.
        const reviewContext = buildEscalationReviewContext(
          {
            inProcessMessage: deps.autoApproveUserMessage,
            escalationDir: deps.escalationDir,
            isPtySession: deps.isPtySession === true,
          },
          deps.agentJustification,
        );
        return waitForHumanDecision(
          { onEscalation: deps.onEscalation, escalationDir: deps.escalationDir, escalationTimeoutMs },
          {
            escalationId,
            request: {
              requestId: request.requestId,
              serverName: request.serverName,
              toolName: request.toolName,
              arguments: argsForTransport,
              timestamp: request.timestamp,
            },
            reason: approverReason,
            context: escalationContext,
            whitelistCandidates: candidateIpcs,
            humanOnly,
            persona: deps.persona,
            reviewContext,
          },
          cancelSignal,
        );
      };

      // If `waitForDecision` throws (e.g. a faulty `onEscalation` hook),
      // the error propagates out of `handleCallTool` and the coordinator's
      // `runEscalationWait` finally reacquires+releases the call mutex while
      // `leaveToolCall` returns the admission slot -- no leaked mutex/slot.
      // We now ALSO write one audit line for the attempted call before
      // re-raising, so a thrown hook no longer leaves the escalation
      // unaudited. The catch fires ONLY on a throw, so it never overlaps
      // the settled-decision audit below (no double-audit), and it
      // re-raises the original error to preserve the exception contract
      // callers depend on (the `runEscalationWait` finally + `leaveToolCall`
      // still run).
      // Direct pipeline callers (no coordinator) get a signal that only the
      // escalation timeout -- or their own cancellation signal -- can fire.
      // The caller's cancellation joins the coordinator's: a call whose
      // script has ended is withdrawn like one cancelled for teardown (the
      // request file is removed, an in-process handler's signal aborts).
      const runWait: EscalationWaitRunner = deps.runEscalationWait ?? ((wait) => wait(new AbortController().signal));
      const callerCancel = deps.signal === undefined ? undefined : callerCancellationSignal(deps.signal);
      const waitForDecisionOrCancel = (cancelSignal: AbortSignal): Promise<DecisionOutcome> =>
        waitForDecision(callerCancel ? AbortSignal.any([cancelSignal, callerCancel.signal]) : cancelSignal);
      let waitResult: DecisionOutcome;
      try {
        waitResult = await runWait(waitForDecisionOrCancel);
      } catch (escalationError) {
        const escalationErrorText =
          escalationError instanceof Error ? escalationError.message : String(escalationError);
        const reason = `Escalation wait failed: ${escalationErrorText}`;
        // Align the outer `policyDecision` (the object `logAudit` closes
        // over) with the denied outcome we are auditing, mirroring the
        // settled-denied branch below.
        policyDecision.status = 'deny';
        policyDecision.reason = reason;
        logAudit({ status: 'denied', error: reason }, 0, 'denied');
        throw escalationError;
      } finally {
        callerCancel?.dispose();
      }

      if (waitResult.kind === 'aborted') {
        // Not a human denial: the audit entry says the wait timed out or
        // was cancelled, and the agent is told the same so it does not
        // conclude the operator refused.
        const { reason: abort } = waitResult;
        const reason =
          abort.kind === 'timed-out'
            ? `Escalation timed out: ${abort.detail}`
            : `Escalation cancelled: ${abort.detail}`;
        const abortedDecision: PolicyDecision = { status: 'deny', rule: policyDecision.rule, reason };
        policyDecision.status = abortedDecision.status;
        policyDecision.reason = abortedDecision.reason;
        logAudit({ status: 'denied', error: reason }, 0, abort.kind);
        return {
          content: [{ type: 'text', text: `${ERROR_PREFIX_ESCALATION_DENIED} ${evaluation.reason} (${reason})` }],
          isError: true,
          _policyDecision: abortedDecision,
        };
      }

      if (waitResult.kind === 'auto-approved') {
        autoApproved = true;
        escalationResult = 'approved';
        policyDecision.status = 'allow';
        policyDecision.reason = `Auto-approved: ${waitResult.reason}`;
      } else {
        const { response } = waitResult;
        if (response.decision === 'denied') {
          const deniedDecision: PolicyDecision = {
            status: 'deny',
            rule: policyDecision.rule,
            reason: HUMAN_DENIAL_REASON,
          };
          // Align the outer `policyDecision` (the object `logAudit`
          // closes over) with the decision we return to the caller so
          // the audit entry and the returned PolicyDecision agree.
          policyDecision.status = deniedDecision.status;
          policyDecision.reason = deniedDecision.reason;
          logAudit({ status: 'denied', error: deniedDecision.reason }, 0, 'denied');
          return {
            content: [{ type: 'text', text: `${ERROR_PREFIX_ESCALATION_DENIED} ${evaluation.reason}` }],
            isError: true,
            _policyDecision: deniedDecision,
          };
        }

        escalationResult = 'approved';
        policyDecision.status = 'allow';
        policyDecision.reason = HUMAN_APPROVAL_REASON;
        humanApprovedPattern = approvalHistoryCandidate(candidatePatterns, candidateIpcs);

        // Handle whitelist selection from the response. For in-process
        // callers, the candidates are supplied directly; for file-IPC
        // callers, they are looked up from the pending cache. The pattern
        // is added only once the post-approval path check below passes.
        if (response.whitelistSelection !== undefined) {
          if (response.whitelistSelection >= 0 && response.whitelistSelection < candidatePatterns.length) {
            selectedWhitelistPattern = candidatePatterns[response.whitelistSelection];
          }
        }
      }
    }

    // The approval is in, but its caller may have stopped waiting while the
    // human decided (the script timed out or was cancelled, and the agent was
    // told it failed): such an approval is recorded and not acted on -- no
    // root is widened, no whitelist pattern kept, nothing dispatched. A
    // response that landed just as the wait was withdrawn reaches this point.
    const cancelledAfterApproval = refuseCancelledCall();
    if (cancelledAfterApproval) return cancelledAfterApproval;

    // T1: the approval wait is over. If any approved path no longer
    // resolves to the path the policy engine evaluated (e.g. a directory
    // component was swapped for a symlink after the policy check or while
    // the approver decided), the call is no longer the one that was
    // approved: deny it, add no root and keep no whitelist pattern.
    let changedPaths: ApprovedPath[];
    try {
      changedPaths = findChangedApprovedPaths(approvedPaths, deps.allowedDirectory);
    } catch (err) {
      return denyUnresolvablePath(err);
    }
    if (changedPaths.length > 0) {
      const changed = changedPaths.map((p) => p.value).join(', ');
      return denyAfterApproval(
        RULE_APPROVED_PATH_CHANGED,
        `Approved path(s) changed after the policy check and now resolve elsewhere: ${changed}. The call was not executed.`,
      );
    }
    if (selectedWhitelistPattern !== undefined) {
      deps.whitelist.add(selectedWhitelistPattern);
    }
    if (humanApprovedPattern !== undefined) {
      reportHumanApproval(deps, {
        serverName: toolInfo.serverName,
        toolName: toolInfo.name,
        rule: evaluation.rule,
        pattern: humanApprovedPattern,
      });
    }

    // Roots for the escalated paths only, from their T0 canonical forms.
    // Root selection canonicalizes the sandbox and the IronCurtain home
    // before any root is sent, so an unresolvable path denies with no
    // root added. Widening the server's roots is itself a side effect on
    // the backend, so the write-ahead record precedes it: an audit log
    // that broke while this call waited for its approval refuses the call
    // before any root is added (the audit error is not a path error, so
    // `denyUnresolvablePath` re-throws it).
    let rootsExpansion: RootsExpansionResult;
    try {
      rootsExpansion = await expandApprovedRoots(toolInfo.serverName, approvedPaths, deps, logWriteAhead);
    } catch (err) {
      return denyUnresolvablePath(err);
    }
    if (rootsExpansion.kind === 'failed') {
      return denyAfterApproval(RULE_ROOTS_VERIFICATION_FAILED, rootsExpansion.reason);
    }
    if (rootsExpansion.kind === 'refused') {
      return denyAfterApproval(RULE_ROOT_NOT_EXPOSABLE, rootsExpansion.reason);
    }
    rootsRaceRetryAllowed = rootsExpansion.raceRetryAllowed;
  }

  if (evaluation.decision === 'deny') {
    logAudit({ status: 'denied', error: evaluation.reason }, 0);
    return {
      content: [{ type: 'text', text: `${ERROR_PREFIX_DENIED} ${evaluation.reason}` }],
      isError: true,
      _policyDecision: { ...policyDecision },
    };
  }

  // Circuit breaker: deny if the same tool+args is called too many times.
  // Key is server-qualified so two backends that happen to expose tools
  // with the same bare name do not share a rate-limit bucket. The window
  // is kept per lane, so concurrent fan-out lanes making the same call do
  // not trip each other (the breaker bounds their total separately).
  const circuitBreakerKey = `${toolInfo.serverName}__${toolInfo.name}`;
  const cbVerdict = deps.circuitBreaker.check(circuitBreakerKey, argsForTransport, deps.lane);
  if (!cbVerdict.allowed) {
    logAudit({ status: 'denied', error: cbVerdict.reason }, 0);
    return {
      content: [{ type: 'text', text: cbVerdict.reason }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'circuit-breaker', reason: cbVerdict.reason },
    };
  }

  // Virtual proxy tools: handle locally, no backend forwarding
  const controlApiClient = deps.controlApiClient;
  if (toolInfo.serverName === 'proxy' && controlApiClient) {
    const cancelled = refuseCancelledCall();
    if (cancelled) return cancelled;
    // Write-ahead record: the realized allow decision is on disk before
    // the side effect. An unwritable audit log throws here and the tool
    // never runs; the coordinator then stops admitting calls.
    logWriteAhead();
    const startTime = Date.now();
    const outcome = await settle(() => handleVirtualProxyTool(toolInfo.name, argsForTransport, controlApiClient));
    if (!outcome.ok) {
      const errorMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
        _policyDecision: { ...policyDecision },
      };
    }
    logAudit({ status: 'success' }, Date.now() - startTime);
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      _policyDecision: { ...policyDecision },
    };
  }

  // The coordinator-owned workflow_commit tool: handed to the orchestrator's
  // commit channel in-process, never to a backend. A refused commit (an
  // invocation that is not open, a second commit, a verdict the state does
  // not route on) is an error result the agent can act on.
  const workflowCommit = deps.workflowCommit;
  if (toolInfo.serverName === WORKFLOW_COMMIT_SERVER && workflowCommit) {
    // Recording a commit routes the workflow, so a call whose script was
    // cancelled (the agent was told it failed) records nothing, exactly like
    // a backend call or a virtual proxy tool.
    const cancelled = refuseCancelledCall();
    if (cancelled) return cancelled;
    // The arguments passed this check before policy evaluation; repeating it
    // here keeps the handler's input typed and bounded.
    const parsedCommit = parseWorkflowCommitArguments(argsForTransport);
    logWriteAhead();
    const startTime = Date.now();
    let commitOutcome: ReturnType<WorkflowCommitHandler['commit']>;
    try {
      commitOutcome = parsedCommit.ok
        ? workflowCommit.commit(parsedCommit.request)
        : { accepted: false, reason: parsedCommit.error };
    } catch (err) {
      commitOutcome = { accepted: false, reason: `Commit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!commitOutcome.accepted) {
      logAudit({ status: 'error', error: commitOutcome.reason }, Date.now() - startTime);
      return {
        content: [{ type: 'text', text: commitOutcome.reason }],
        isError: true,
        _policyDecision: { ...policyDecision },
      };
    }
    logAudit({ status: 'success' }, Date.now() - startTime);
    return {
      content: [{ type: 'text', text: commitOutcome.message }],
      _policyDecision: { ...policyDecision },
    };
  }

  // Policy allows -- forward to the real MCP server with transport args
  const clientState = deps.clientStates.get(toolInfo.serverName);
  if (!clientState) {
    const err = `Internal error: no client connection for server "${toolInfo.serverName}"`;
    logAudit({ status: 'denied', error: err }, 0);
    return {
      content: [{ type: 'text', text: err }],
      isError: true,
      _policyDecision: { status: 'deny', rule: 'no-client-connection', reason: err },
    };
  }
  const client = clientState.client;

  // CompatibilityCallToolResultSchema accepts the legacy `toolResult` response format
  // (protocol version 2024-10-07). Output schema validation is intentionally
  // bypassed by the permissiveJsonSchemaValidator injected at Client construction time.
  const callToolArgs = { name: toolInfo.name, arguments: argsForTransport };
  // The relay bounds the backend call with `backendCallTimeoutMs` and
  // resets on progress (up to an absolute ceiling); the parent waits a
  // little longer on both so the relay's deadline fires first.
  // `onprogress` makes the SDK attach a progress token, which the relay
  // uses to forward backend progress back here and keep this timer alive
  // while a long tool keeps reporting.
  const backendCallTimeoutMs = deps.backendCallTimeoutMs ?? DEFAULT_BACKEND_CALL_TIMEOUT_MS;
  // The caller's cancellation signal also cancels the call in flight: the
  // SDK rejects at once and sends `notifications/cancelled`, which the relay
  // forwards to the backend.
  const callToolOpts = {
    timeout: relayCallTimeoutMs(backendCallTimeoutMs),
    resetTimeoutOnProgress: true,
    maxTotalTimeout: relayCallTimeoutMs(maxTotalBackendCallMs(backendCallTimeoutMs)),
    onprogress: () => {},
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
  const dispatch = () => client.callTool(callToolArgs, CompatibilityCallToolResultSchema, callToolOpts);

  // Last check before the backend sees the call (the roots update of an
  // approved escalation, or the wait for the call mutex, may have outlasted
  // the script that made it).
  const cancelledBeforeDispatch = refuseCancelledCall();
  if (cancelledBeforeDispatch) return cancelledBeforeDispatch;

  // Write-ahead record: the realized allow decision (including any
  // escalation approval) is on disk before the backend sees the call. If
  // the audit log cannot take it, this throws and nothing is dispatched.
  // Already written when an approved escalation widened the roots above.
  logWriteAhead();
  const startTime = Date.now();

  // Only the backend call is settled here. Audit writes stay outside it so
  // an audit failure is never caught and re-audited as a backend error.
  let outcome = await settle(dispatch);

  // Race condition mitigation: after an unverified roots expansion the
  // server has been notified but may not have finished async-validating
  // the new roots (fs.realpath, fs.stat). Retry once after a short delay.
  // Read-only calls also retry on per-file denials inside a successful
  // result (read_multiple_files reports those without isError).
  const readOnlyCall = annotation !== undefined && isReadOnlyAnnotation(annotation);
  if (outcome.ok && rootsRaceRetryAllowed && isRootsRaceResult(outcome.value, readOnlyCall)) {
    const initialError = extractTextFromContent(outcome.value.content) ?? 'access denied (roots race)';
    // Written before the retry, so it doubles as the retry's write-ahead
    // record: an unwritable audit log throws here and no second dispatch
    // happens.
    logAudit({ status: 'error', error: `${ROOTS_RACE_RETRY_ERROR_PREFIX} ${initialError}` }, Date.now() - startTime);
    await new Promise((r) => setTimeout(r, ROOTS_RACE_RETRY_DELAY_MS));
    // A caller that stopped waiting meanwhile gets no second dispatch; the
    // first attempt's result stands.
    if (deps.signal?.aborted !== true) outcome = await settle(dispatch);
  }

  if (!outcome.ok) {
    const rawError = extractMcpErrorMessage(outcome.error);
    const errorMessage = annotateSandboxViolation(rawError, serverIsSandboxed);
    logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
    const errorContent = [{ type: 'text', text: `Error: ${errorMessage}` }];
    return {
      content: deps.allowedDirectory
        ? rewriteResultContent(errorContent, deps.allowedDirectory, CONTAINER_WORKSPACE_DIR)
        : errorContent,
      isError: true,
      _policyDecision: { ...policyDecision },
    };
  }
  const result = outcome.value;

  // Reverse-rewrite host sandbox paths to container workspace paths in results
  const rewrittenContent = deps.allowedDirectory
    ? rewriteResultContent(result.content, deps.allowedDirectory, CONTAINER_WORKSPACE_DIR)
    : result.content;
  const structured = structuredContentOf(result.structuredContent, deps.allowedDirectory);

  if (result.isError) {
    const errorText = extractTextFromContent(rewrittenContent) ?? 'Unknown tool error';
    const errorMessage = annotateSandboxViolation(errorText, serverIsSandboxed);
    logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
    return {
      content: rewrittenContent,
      ...structured,
      isError: true,
      _policyDecision: { ...policyDecision },
    };
  }

  logAudit({ status: 'success' }, Date.now() - startTime);
  // The server-context mirror (git working directory etc.) is updated only
  // once the success is on disk, so an audit failure leaves no state that
  // the audit log does not account for.
  updateServerContext(deps.serverContextMap, toolInfo.serverName, toolInfo.name, argsForTransport);
  return { content: rewrittenContent, ...structured, _policyDecision: { ...policyDecision } };
}

/**
 * The backend result's `structuredContent`, as a spread for the response: absent
 * when the backend sent none. In Docker mode its host sandbox paths are rewritten
 * to container paths like the content's; a value that cannot be rewritten is
 * dropped, never forwarded with host paths.
 */
function structuredContentOf(value: unknown, allowedDirectory: string | undefined): { structuredContent?: unknown } {
  if (value === undefined) return {};
  if (!allowedDirectory) return { structuredContent: value };
  try {
    return { structuredContent: rewriteStructuredContent(value, allowedDirectory, CONTAINER_WORKSPACE_DIR) };
  } catch {
    return {};
  }
}
