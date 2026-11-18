/**
 * Policy-evaluated MITM egress: the virtual `network` server.
 *
 * The MITM proxy (src/docker/mitm-proxy.ts) decides statically which
 * destinations the agent container reaches: configured LLM providers and
 * package registries take their dedicated, filtered paths. With the opt-in
 * `egressPolicy.enabled` (see docs/designs/mitm-egress-policy.md), every
 * other destination is decided here instead, by the session's policy engine,
 * as a call to the virtual tool `network/request`:
 *
 *   { method: 'CONNECT', host, port }        a tunnel, judged at host:port
 *   { method: 'GET', host, port, path }      a request the proxy can read
 *                                            (plain HTTP), judged per path
 *
 * The `network` server has no backend and no tool an agent can call: it is
 * never registered with the coordinator's tool map, so `execute_code` cannot
 * reach it. It is a policy namespace. Its annotation gives `host` the
 * `egress-host` role (URL category), so compiled `domains` conditions,
 * wildcards included, and the structural domain gate judge it like any other
 * destination.
 *
 * Rules, in evaluation order (first match per role wins):
 *   1. the compiled policy's own rules (a constitution, or a hand-written
 *      policy directory, may allow, escalate or deny `network` requests);
 *   2. `network-egress-allowed-hosts`: allow the hosts the user listed in
 *      `egressPolicy.allowedHosts` (`*`, `*.example.com`, `host`);
 *   3. `network-egress-escalate`: escalate everything else to a human
 *      (`humanOnly`: never the auto-approver, never a whitelist pattern,
 *      never "approve all").
 *
 * Escalate-once: the proxy remembers a human's decision for `host:port`
 * (an approval becomes a passthrough approval, exactly as an approved
 * `add_proxy_domain` does) and passes it back as `prior`. A later request to
 * the same `host:port` that policy escalates is settled by that decision
 * without asking again. A prior decision never overrides a policy allow or
 * deny: it only discharges an escalation, like the approval whitelist.
 *
 * Before policy runs, the destination is screened structurally: only ports
 * 443 and 80 are admitted (the passthrough ports), and the host must be a
 * name `validateDomain` accepts (no IP literals, no localhost, no local or
 * metadata-scoped names). Every decision, structural refusals included, is
 * written to the session audit log as one `network/request` entry.
 *
 * With taint escalation enabled (`taint-policy.ts`, opt-in
 * `taintEscalation`), an admitted destination is a dispatched taint source
 * (`network/request` is one by default; `taintEscalation.tools` can
 * reclassify it): content from it reaches the agent without an MCP call,
 * like an approved `add_proxy_domain`. Its audit entry says `taint.source`
 * and the session is tainted before the decision is returned, so before the
 * proxy opens anything. A refused destination taints nothing.
 *
 * Nothing here takes the coordinator's call mutex: a decision touches no
 * read-modify-write cache (no approval whitelist, no circuit breaker, no
 * server context; the taint mark is synchronous and monotonic), the policy
 * evaluation is synchronous, and the proxy relays the tunnel or the response
 * only after the decision returned, so no streamed transfer ever holds a
 * coordinator lock.
 */

import { v4 as uuidv4 } from 'uuid';
import type { CompiledRule, StoredToolAnnotation, StoredToolAnnotationsFile } from '../pipeline/types.js';
import type { PolicyDecision, ToolCallRequest } from '../types/mcp.js';
import { HUMAN_APPROVAL_REASON, HUMAN_DENIAL_REASON, type AuditEntry } from '../types/audit.js';
import type { AuditLog } from './audit-log.js';
import type { PolicyEngine } from './policy-engine.js';
import type { SessionTaint } from './taint-policy.js';
import { ALLOWED_PASSTHROUGH_PORTS, formatPassthroughTarget, validateDomain } from '../docker/proxy-tools.js';
import { canonicalEgressHostPattern, EGRESS_HOST_PATTERN_RULE } from '../net/egress-host-pattern.js';
import {
  buildAuditEntry,
  hasHumanEscalationChannel,
  waitForHumanDecision,
  type EscalationWaitRunner,
  type HumanDecisionOutcome,
  type HumanEscalationChannel,
} from './tool-call-pipeline.js';
import { isAuditLogUnavailableError } from './audit-log.js';

// ---------------------------------------------------------------------------
// The virtual server
// ---------------------------------------------------------------------------

/** Reserved name of the virtual egress server (see RESERVED_SERVER_NAMES). */
export const EGRESS_SERVER_NAME = 'network';

/** The one tool of the virtual egress server. */
export const EGRESS_TOOL_NAME = 'request';

/** Opt-in configuration (`egressPolicy` in config.json, enabled). */
export interface EgressPolicyOptions {
  /** Host patterns admitted without a human (`*`, `*.example.com`, `host`). */
  readonly allowedHosts: readonly string[];
}

/** One destination the MITM proxy asks about. */
export interface EgressRequest {
  /** `CONNECT` for a tunnel (judged at host:port); the HTTP method of a request the proxy can read. */
  readonly method: string;
  /** Canonical destination host as the proxy parsed it. */
  readonly host: string;
  readonly port: number;
  /** Origin-form path and query of a readable request; absent for a tunnel. */
  readonly path?: string;
  /** The human decision the proxy already holds for `host:port` (escalate-once). */
  readonly prior?: 'approved' | 'denied';
}

/**
 * Who settled an egress request: a policy rule or structural check
 * (`policy`), an earlier human decision for the same host and port
 * (`prior`), a human just now (`human`), or nobody (`unanswered`: timeout,
 * cancellation, no escalation channel, too many pending approvals, a failed
 * wait). The proxy remembers only `human` decisions.
 */
export type EgressSettlement = 'policy' | 'prior' | 'human' | 'unanswered';

/** The answer to one {@link EgressRequest}. Already audited when returned. */
export interface EgressDecision {
  readonly allowed: boolean;
  readonly settledBy: EgressSettlement;
  readonly rule: string;
  readonly reason: string;
}

/**
 * The narrow seam the MITM proxy uses to reach the session's coordinator.
 * `ToolCallCoordinator.authorizeEgress` implements it; a rejection means the
 * coordinator could not decide (closed, audit log lost) and the proxy must
 * refuse.
 */
export interface EgressAuthorizer {
  authorizeEgress(request: EgressRequest): Promise<EgressDecision>;
}

const egressRequestInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    method: { type: 'string', description: 'CONNECT for a tunnel, otherwise the HTTP method of the request' },
    host: { type: 'string', description: 'Destination host' },
    port: { type: 'integer', description: 'Destination port' },
    path: { type: 'string', description: 'Path and query of a request the proxy can read' },
  },
  required: ['method', 'host', 'port'],
};

/** Hardcoded annotation of `network/request` (not LLM-generated, like the proxy tools). */
export const egressAnnotations: StoredToolAnnotation[] = [
  {
    toolName: EGRESS_TOOL_NAME,
    serverName: EGRESS_SERVER_NAME,
    comment:
      'Network egress from the agent container through the MITM proxy; evaluated by the proxy, never called by an agent',
    args: {
      method: ['none'],
      host: ['egress-host'],
      port: ['none'],
      path: ['none'],
    },
    inputSchema: egressRequestInputSchema,
  },
];

/** Rule admitting `egressPolicy.allowedHosts`. */
export const EGRESS_ALLOWED_HOSTS_RULE = 'network-egress-allowed-hosts';

/** The fallback rule: every other destination escalates to a human. */
export const EGRESS_ESCALATE_RULE = 'network-egress-escalate';

/**
 * The hardcoded egress rules for `options`, appended after the compiled
 * policy's own rules: an allow for the configured host patterns (when there
 * are any), then the human-only escalation that catches everything else.
 *
 * @throws Error when a pattern is not an acceptable egress host pattern
 *   (the config schema refuses those before a session starts).
 */
export function buildEgressPolicyRules(options: EgressPolicyOptions): CompiledRule[] {
  const allowed = new Set<string>();
  for (const pattern of options.allowedHosts) {
    const canonical = canonicalEgressHostPattern(pattern);
    if (canonical === undefined) {
      throw new Error(`egressPolicy.allowedHosts entry "${pattern}" ${EGRESS_HOST_PATTERN_RULE}`);
    }
    allowed.add(canonical);
  }
  const rules: CompiledRule[] = [];
  if (allowed.size > 0) {
    rules.push({
      name: EGRESS_ALLOWED_HOSTS_RULE,
      description: 'Network destinations listed in egressPolicy.allowedHosts',
      principle: 'User-configured egress allowlist',
      if: {
        server: [EGRESS_SERVER_NAME],
        tool: [EGRESS_TOOL_NAME],
        domains: { roles: ['egress-host'], allowed: [...allowed] },
      },
      then: 'allow',
      reason: 'The destination host matches egressPolicy.allowedHosts in the user configuration',
    });
  }
  rules.push({
    name: EGRESS_ESCALATE_RULE,
    description: 'Every other network destination requires human approval, once per host and port',
    principle: 'Human oversight',
    if: { server: [EGRESS_SERVER_NAME], tool: [EGRESS_TOOL_NAME] },
    then: 'escalate',
    reason: 'Reaching a network destination that no egress rule allows requires human approval',
    // Admitting a destination opens an uninspected passthrough tunnel, the
    // same decision as an approved add_proxy_domain: never delegated.
    humanOnly: true,
  });
  return rules;
}

/**
 * A shallow clone of `src` with the virtual `network` server's annotation in
 * place (the server name is reserved, so overwriting the slot is always
 * correct). Per-server tool arrays are shared by reference.
 */
export function mergeEgressAnnotations(src: StoredToolAnnotationsFile): StoredToolAnnotationsFile {
  return {
    ...src,
    servers: {
      ...src.servers,
      [EGRESS_SERVER_NAME]: { inputHash: 'hardcoded', tools: egressAnnotations },
    },
  };
}

// ---------------------------------------------------------------------------
// Structural screen
// ---------------------------------------------------------------------------

/** Structural refusal: the port is not one a passthrough approval can name. */
export const EGRESS_PORT_RULE = 'egress-port-not-allowed';

/** Structural refusal: the host is not an internet host name (IP literal, local or metadata name, ...). */
export const EGRESS_DESTINATION_RULE = 'egress-destination-not-allowed';

/** Structural refusal: the request itself is malformed (never produced by the proxy). */
export const EGRESS_MALFORMED_RULE = 'egress-request-malformed';

/** Refusal: too many egress escalations are already waiting for a human. */
export const EGRESS_ESCALATION_LIMIT_RULE = 'egress-escalation-limit';

/** How many egress escalations may wait for a human at once, per coordinator. */
export const MAX_PENDING_EGRESS_ESCALATIONS = 8;

const HTTP_METHOD = /^[A-Za-z]{1,32}$/u;

/** A structural refusal: the rule that refused and why. */
export interface EgressRefusal {
  readonly rule: string;
  readonly reason: string;
}

/**
 * The checks every destination passes before policy sees it: the port is
 * 443 or 80, the host is a canonical name `validateDomain` accepts (so an
 * approval for it can be stored and revoked like any passthrough approval),
 * and the method and path have the shape the proxy produces. Returns the
 * refusal, or undefined when policy may evaluate the request.
 */
export function screenEgressDestination(request: EgressRequest): EgressRefusal | undefined {
  if (typeof request.method !== 'string' || !HTTP_METHOD.test(request.method)) {
    return { rule: EGRESS_MALFORMED_RULE, reason: 'The request method is not an HTTP method' };
  }
  if (request.path !== undefined && (typeof request.path !== 'string' || !request.path.startsWith('/'))) {
    return { rule: EGRESS_MALFORMED_RULE, reason: 'The request path is not an origin-form path' };
  }
  if (!Number.isInteger(request.port) || !ALLOWED_PASSTHROUGH_PORTS.has(request.port)) {
    return {
      rule: EGRESS_PORT_RULE,
      reason: `Port ${String(request.port)} is not admitted for network egress (only ${[...ALLOWED_PASSTHROUGH_PORTS].join(' and ')})`,
    };
  }
  if (typeof request.host !== 'string' || request.host !== request.host.toLowerCase()) {
    return { rule: EGRESS_DESTINATION_RULE, reason: 'The destination host is not in canonical form' };
  }
  try {
    validateDomain(request.host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rule: EGRESS_DESTINATION_RULE, reason: `${message}: network egress admits internet host names only` };
  }
  return undefined;
}

/** The `network/request` arguments for `request`: what policy evaluates, the audit records and a human sees. */
export function egressArguments(request: EgressRequest): Record<string, unknown> {
  return {
    method: request.method,
    host: request.host,
    port: request.port,
    ...(request.path === undefined ? {} : { path: request.path }),
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Bounded admission for egress escalations waiting on a human. */
export interface EgressEscalationSlots {
  /** Take a slot; false when every slot is in use. */
  tryAcquire(): boolean;
  /** Return a slot taken with `tryAcquire`. */
  release(): void;
}

/** Slots for at most `max` concurrent egress escalations. */
export function createEgressEscalationSlots(max: number = MAX_PENDING_EGRESS_ESCALATIONS): EgressEscalationSlots {
  let inUse = 0;
  return {
    tryAcquire(): boolean {
      if (inUse >= max) return false;
      inUse += 1;
      return true;
    },
    release(): void {
      inUse = Math.max(0, inUse - 1);
    },
  };
}

/** What {@link decideEgress} needs from the coordinator. */
export interface EgressDecisionDeps {
  /** The engine of the policy active when the request was admitted. */
  readonly policyEngine: PolicyEngine;
  readonly auditLog: AuditLog;
  /** Persona stamped on the audit entry (workflow runs). */
  readonly persona?: string;
  /** How a human is reached: the coordinator's in-process handler or escalation directory. */
  readonly channel: HumanEscalationChannel;
  /** Registers the human wait so coordinator teardown and policy swaps cancel it. */
  readonly runEscalationWait: EscalationWaitRunner;
  readonly escalationSlots: EgressEscalationSlots;
  /**
   * The session's taint state when taint escalation is enabled; undefined
   * otherwise (no audit entry then carries taint facts). An admitted
   * destination that it classifies as a source taints the session.
   */
  readonly taint?: SessionTaint;
}

/**
 * Decides one egress request and writes its audit entry: the structural
 * screen, then the policy engine, then (for an escalation) the earlier human
 * decision for the same host and port or a new human decision through the
 * coordinator's normal escalation channel. Returns the decision, already
 * audited. An admitted destination that `deps.taint` classifies as a taint
 * source is recorded as one (`taint.source`) and taints the session before
 * the decision is returned.
 *
 * @throws {AuditLogUnavailableError} when the audit log cannot be written;
 *   the coordinator latches it and the proxy refuses the request.
 */
export async function decideEgress(request: EgressRequest, deps: EgressDecisionDeps): Promise<EgressDecision> {
  // Fail closed before anything else: no decision may go unaudited, and a
  // human must never be asked about a request whose answer cannot be recorded.
  deps.auditLog.assertWritable();
  const startedAt = Date.now();
  const args = egressArguments(request);
  const toolRequest: ToolCallRequest = {
    requestId: uuidv4(),
    serverName: EGRESS_SERVER_NAME,
    toolName: EGRESS_TOOL_NAME,
    arguments: args,
    timestamp: new Date().toISOString(),
  };

  // Taint escalation: admitting the destination dispatches a taint source
  // (by default), like an approved add_proxy_domain. Undefined when taint
  // escalation is disabled or `network/request` is reclassified.
  const sourceTaint =
    deps.taint?.classify(EGRESS_SERVER_NAME, EGRESS_TOOL_NAME).source === true ? deps.taint : undefined;

  const settle = (
    settledBy: EgressSettlement,
    decision: PolicyDecision,
    escalationResult?: AuditEntry['escalationResult'],
  ): EgressDecision => {
    const allowed = decision.status === 'allow';
    const taint = allowed ? sourceTaint : undefined;
    deps.auditLog.log(
      buildAuditEntry(
        toolRequest,
        args,
        decision,
        allowed ? { status: 'success' } : { status: 'denied', error: decision.reason },
        Date.now() - startedAt,
        // Omitted from the entry when undefined.
        { escalationResult, persona: deps.persona, taint: taint ? { source: true } : undefined },
      ),
    );
    if (taint) {
      // After the record that a resume replays, before the proxy can open
      // the destination: nothing from it reaches the agent untainted.
      taint.markTainted({
        via: `${EGRESS_SERVER_NAME}/${EGRESS_TOOL_NAME}`,
        requestId: toolRequest.requestId,
        timestamp: toolRequest.timestamp,
      });
    }
    return { allowed, settledBy, rule: decision.rule, reason: decision.reason };
  };

  const refusal = screenEgressDestination(request);
  if (refusal !== undefined) {
    return settle('policy', { status: 'deny', rule: refusal.rule, reason: refusal.reason });
  }

  const evaluation = deps.policyEngine.evaluate(toolRequest);
  if (evaluation.decision !== 'escalate') {
    return settle('policy', { status: evaluation.decision, rule: evaluation.rule, reason: evaluation.reason });
  }

  // Escalate-once: an earlier human decision for this host and port settles
  // the escalation without asking again (it never overrides allow or deny).
  const target = formatPassthroughTarget(request.host, request.port);
  if (request.prior === 'approved') {
    return settle(
      'prior',
      { status: 'allow', rule: evaluation.rule, reason: `Approved earlier in this session for ${target}` },
      'approved',
    );
  }
  if (request.prior === 'denied') {
    return settle(
      'prior',
      { status: 'deny', rule: evaluation.rule, reason: `Denied earlier in this session for ${target}` },
      'denied',
    );
  }

  if (!hasHumanEscalationChannel(deps.channel)) {
    return settle(
      'unanswered',
      { status: 'deny', rule: evaluation.rule, reason: `${evaluation.reason} (no escalation handler)` },
      'denied',
    );
  }
  if (!deps.escalationSlots.tryAcquire()) {
    // Not remembered: the request may escalate again once approvals clear.
    return settle('unanswered', {
      status: 'deny',
      rule: EGRESS_ESCALATION_LIMIT_RULE,
      reason: `Too many network approvals are already waiting for a human (limit ${MAX_PENDING_EGRESS_ESCALATIONS})`,
    });
  }

  let outcome: HumanDecisionOutcome;
  try {
    outcome = await deps.runEscalationWait((cancelSignal) =>
      waitForHumanDecision(
        deps.channel,
        {
          escalationId: uuidv4(),
          request: toolRequest,
          // The scope of an approval is stated whatever rule escalated: the
          // proxy records an approval for this host and port.
          reason: `${evaluation.reason} (approving admits ${target} for the rest of this session)`,
          humanOnly: true,
          persona: deps.persona,
        },
        cancelSignal,
      ),
    );
  } catch (err) {
    if (isAuditLogUnavailableError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return settle(
      'unanswered',
      { status: 'deny', rule: evaluation.rule, reason: `Escalation wait failed: ${message}` },
      'denied',
    );
  } finally {
    deps.escalationSlots.release();
  }

  if (outcome.kind === 'aborted') {
    const { reason } = outcome;
    const text =
      reason.kind === 'timed-out' ? `Escalation timed out: ${reason.detail}` : `Escalation cancelled: ${reason.detail}`;
    return settle('unanswered', { status: 'deny', rule: evaluation.rule, reason: text }, reason.kind);
  }
  // The pipeline's reasons for a human decision: `ironcurtain audit report`
  // tells a human denial from the other denials by its reason.
  if (outcome.response.decision === 'approved') {
    return settle('human', { status: 'allow', rule: evaluation.rule, reason: HUMAN_APPROVAL_REASON }, 'approved');
  }
  return settle('human', { status: 'deny', rule: evaluation.rule, reason: HUMAN_DENIAL_REASON }, 'denied');
}
