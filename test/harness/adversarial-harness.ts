/**
 * Shared wiring for the adversarial / agent-loop harness: config builders, a
 * mock sandbox, a scriptable escalation reviewer, and an audit-log reader.
 *
 * These let a test drive a real session — the real `generateText` loop, and
 * (in the e2e file) the real session factory, Sandbox and MCP relays — with a
 * scripted model, then assert the protecting control from the audit log, from
 * what the model was shown, and from the side effects an attack would have
 * produced on disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { Sandbox } from '../../src/sandbox/index.js';
import type { EscalationRequest, Session } from '../../src/session/types.js';
import { isDispatchingAuditEntry } from '../../src/types/audit.js';

/** An audit outcome record (the write-ahead `dispatching` record is filtered out). */
export interface AuditOutcome {
  readonly toolName: string;
  readonly serverName: string;
  readonly status: string;
  readonly decisionStatus: string;
  readonly rule: string;
  readonly reason: string;
  readonly escalationResult?: 'approved' | 'denied';
  readonly autoApproved?: boolean;
  readonly arguments: Record<string, unknown>;
}

interface RawAuditEntry {
  toolName?: unknown;
  serverName?: unknown;
  result?: { status?: unknown };
  policyDecision?: { status?: unknown; rule?: unknown; reason?: unknown };
  escalationResult?: unknown;
  autoApproved?: unknown;
  arguments?: unknown;
}

/** A field as a string, or '' when it is absent or not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads the audit log's outcome records (empty when the file is absent/empty). */
export function readAuditOutcomes(path: string): AuditOutcome[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => JSON.parse(line) as RawAuditEntry)
    .filter((entry) => !isDispatchingAuditEntry(entry))
    .map((entry) => ({
      toolName: str(entry.toolName),
      serverName: str(entry.serverName),
      status: str(entry.result?.status),
      decisionStatus: str(entry.policyDecision?.status),
      rule: str(entry.policyDecision?.rule),
      reason: str(entry.policyDecision?.reason),
      escalationResult:
        entry.escalationResult === 'approved' || entry.escalationResult === 'denied'
          ? entry.escalationResult
          : undefined,
      autoApproved: entry.autoApproved === true ? true : undefined,
      arguments: (entry.arguments as Record<string, unknown> | undefined) ?? {},
    }));
}

/**
 * The last audit outcome for a tool, or undefined. With `path`, only an
 * outcome whose `path` argument is exactly that value matches, so a probe
 * never picks up an earlier probe's record for the same tool.
 */
export function lastAuditFor(
  outcomes: readonly AuditOutcome[],
  toolName: string,
  path?: string,
): AuditOutcome | undefined {
  for (let i = outcomes.length - 1; i >= 0; i--) {
    const outcome = outcomes[i];
    if (outcome.toolName !== toolName) continue;
    if (path !== undefined && outcome.arguments.path !== path) continue;
    return outcome;
  }
  return undefined;
}

/** Overrides for {@link buildHarnessConfig}. */
export interface HarnessConfigOptions {
  readonly allowedDirectory: string;
  readonly generatedDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  readonly mcpServers?: IronCurtainConfig['mcpServers'];
  readonly protectedPaths?: string[];
  readonly escalationTimeoutSeconds?: number;
  readonly budget?: Partial<{
    maxTotalTokens: number | null;
    maxSteps: number | null;
    maxSessionSeconds: number | null;
    maxEstimatedCostUsd: number | null;
    warnThresholdPercent: number;
  }>;
  readonly autoCompact?: Partial<{
    enabled: boolean;
    thresholdTokens: number;
    keepRecentMessages: number;
    summaryModelId: string;
  }>;
  readonly autoApprove?: { enabled: boolean; modelId: string };
  /** The global memory kill switch (`memory.enabled`); off by default. */
  readonly memoryEnabled?: boolean;
}

/**
 * Builds an `IronCurtainConfig` for a harness-driven `AgentSession`. The shape
 * mirrors test/agent-session-budget.test.ts: nullable budget fields default to
 * "disabled" so a test opts into exactly the limit it exercises.
 */
export function buildHarnessConfig(options: HarnessConfigOptions): IronCurtainConfig {
  const agentModelId = 'anthropic:claude-sonnet-4-6';
  return {
    auditLogPath: options.auditLogPath,
    allowedDirectory: options.allowedDirectory,
    mcpServers: options.mcpServers ?? {},
    protectedPaths: options.protectedPaths ?? [],
    generatedDir: options.generatedDir,
    escalationDir: options.escalationDir,
    constitutionPath: `${options.generatedDir}/constitution.md`,
    agentModelId,
    escalationTimeoutSeconds: options.escalationTimeoutSeconds ?? 30,
    userConfig: {
      agentModelId,
      policyModelId: agentModelId,
      anthropicApiKey: 'test-api-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: options.escalationTimeoutSeconds ?? 30,
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: 200,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
        ...options.budget,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
        ...options.autoCompact,
      },
      autoApprove: options.autoApprove ?? { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: options.memoryEnabled ?? false, llmBaseUrl: undefined, llmApiKey: undefined },
      serverCredentials: {},
    },
  } as unknown as IronCurtainConfig;
}

/**
 * A mock `Sandbox` whose `executeCode` runs `handler` (default: a canned
 * success). Used by the hermetic agent-loop tests, which exercise the loop,
 * not real tool execution.
 */
export function createMockSandbox(
  handler: (code: string) => Promise<{ result: unknown; logs: string[] }> = async () => ({
    result: 'ok',
    logs: [],
  }),
): Sandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    getHelpData: vi.fn().mockReturnValue({
      serverDescriptions: { filesystem: 'Read, write, search, and manage files and directories' },
      toolsByServer: { filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }] },
    }),
    executeCode: vi.fn(handler),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Sandbox;
}

/**
 * Starts a fresh agent conversation on a builtin session, so one probe's
 * history and loop-detector state never carry into the next. Fails loudly
 * when the session cannot rotate (the method is optional on `Session`).
 */
export function rotateConversation(session: Session): void {
  if (!session.rotateAgentConversationId) throw new Error('this session cannot rotate its agent conversation');
  session.rotateAgentConversationId();
}

/** How the harness's reviewer answers one escalation. */
export type ReviewDecision = 'approved' | 'denied';

/** One escalation the reviewer saw, and how it answered. */
export interface EscalationReview {
  readonly request: EscalationRequest;
  readonly decision: ReviewDecision;
}

export interface EscalationReviewer {
  /** The `onEscalation` handler to give the session. */
  readonly onEscalation: (request: EscalationRequest) => void;
  /** Every escalation reviewed so far, oldest first. */
  readonly reviews: EscalationReview[];
  /** Failures to resolve an escalation (each one would otherwise hang the call until its timeout). */
  readonly errors: unknown[];
  /**
   * Sets how the next escalations are answered. `decide` runs inside the
   * approval wait, after the policy check and before the decision is
   * written, so a test can also act there (e.g. swap a symlink to race the
   * post-approval re-check). The default denies everything.
   */
  setDecider(decide: (request: EscalationRequest) => ReviewDecision): void;
  /** Restores the deny-everything default and forgets the recorded reviews and errors. */
  reset(): void;
}

const denyAll = (): ReviewDecision => 'denied';

/**
 * Plays the human reviewer for a harness session. By default every
 * escalation is denied, as a reviewer rejecting the agent's attempt would.
 * The session is read lazily so the handler can be passed to the factory
 * that creates it.
 */
export function createEscalationReviewer(getSession: () => Session | undefined): EscalationReviewer {
  const reviews: EscalationReview[] = [];
  const errors: unknown[] = [];
  let decide: (request: EscalationRequest) => ReviewDecision = denyAll;

  const resolveOne = async (request: EscalationRequest): Promise<void> => {
    const session = getSession();
    if (!session) throw new Error(`escalation ${request.escalationId} arrived before the session existed`);
    let decision: ReviewDecision;
    try {
      decision = decide(request);
    } catch (error) {
      // A failing decider is recorded, and the call is denied rather than
      // left waiting for its timeout.
      errors.push(error);
      decision = 'denied';
    }
    reviews.push({ request, decision });
    await session.resolveEscalation(request.escalationId, decision);
  };

  return {
    reviews,
    errors,
    onEscalation: (request) => {
      resolveOne(request).catch((error: unknown) => errors.push(error));
    },
    setDecider(next): void {
      decide = next;
    },
    reset(): void {
      decide = denyAll;
      reviews.length = 0;
      errors.length = 0;
    },
  };
}
