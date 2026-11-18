/**
 * The coordinator-owned `workflow_commit` virtual tool.
 *
 * A workflow agent state reports its result by calling this tool (in Code
 * Mode: `workflow.commit({ invocation, verdict, notes, handoff })`) instead of
 * ending its final message with a YAML status block. Prose can be cut short
 * by the provider stack (a turn that lost its tool call comes back as an
 * ordinary `end_turn`), so the final text cannot tell a finished state from
 * a truncated one; a recorded call can. A turn that ends without an accepted
 * call has not committed, and the orchestrator continues or replaces the
 * executor instead of guessing (see docs/designs/workflow-abort-handoff.md).
 *
 * The coordinator owns the tool. It exists only on a coordinator constructed
 * with a {@link WorkflowCommitHandler}: the coordinator registers it, the
 * policy engine evaluates it under the hardcoded allow rule below, the audit
 * log records every call, and the pipeline dispatches it in-process to the
 * handler (the workflow orchestrator's commit channel for the bundle or
 * session the coordinator serves). Nothing reaches a backend server.
 *
 * Every commit names the invocation it commits (`invocation`, the id the
 * orchestrator put into that state's instructions). The handler accepts it
 * only while that invocation is open and has not committed yet, so a commit
 * quoting the id an agent was given cannot land on another state, a later
 * visit of the same state, another fan-out lane or a turn that already
 * ended. (The id is readable by code inside the same container, through the
 * agent's transcript; see `src/workflow/workflow-commit.ts`.)
 *
 * Only `src/pipeline/types.js` types are imported here (type-only), so this
 * module stays on the live runtime side of the layering rule.
 */

import type {
  CompiledPolicyFile,
  CompiledRule,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Reserved virtual server that carries the tool (see `RESERVED_SERVER_NAMES`). */
export const WORKFLOW_COMMIT_SERVER = 'workflow';

/** Tool name on {@link WORKFLOW_COMMIT_SERVER}. */
export const WORKFLOW_COMMIT_TOOL = 'workflow_commit';

/**
 * What the agent calls in Code Mode. The sandbox strips the redundant
 * `workflow_` prefix from `workflow.workflow_commit` (`toCallableName`).
 */
export const WORKFLOW_COMMIT_CALLABLE = 'workflow.commit';

/** Description of the virtual server in the sandbox's help listing and the agent's orientation. */
export const WORKFLOW_COMMIT_SERVER_DESCRIPTION =
  'Workflow state control: commit the result of your current workflow state';

/**
 * Upper bounds, in characters, on the arguments. The verdict routes the
 * workflow and is shown on one line; the notes and the handoff are passed to
 * the next state, which keeps at most 32 KiB of either.
 */
export const WORKFLOW_COMMIT_LIMITS = {
  invocation: 128,
  verdict: 200,
  notes: 16_384,
  handoff: 65_536,
} as const;

// ---------------------------------------------------------------------------
// Tool definition, annotation and policy rule (hardcoded)
// ---------------------------------------------------------------------------

const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    invocation: {
      type: 'string',
      description: 'The invocation id given in your current instructions. It identifies the state you are committing.',
    },
    verdict: {
      type: 'string',
      description:
        'Your outcome, on one line. When your instructions list valid verdicts, it must be exactly one of them: ' +
        'it decides what the workflow does next.',
    },
    notes: {
      type: 'string',
      description: 'A brief summary of what you did, passed to the next state.',
    },
    handoff: {
      type: 'string',
      description:
        'Everything the next state should receive from you as your output (for example a directive or findings). ' +
        'Recorded with the commit, so it survives a final message that is cut short. When omitted, your final ' +
        'message is passed on instead.',
    },
  },
  required: ['invocation', 'verdict'],
  additionalProperties: false,
};

/** MCP-style definition of the tool, registered by the coordinator. */
export const workflowCommitToolDefinition = {
  name: WORKFLOW_COMMIT_TOOL,
  description:
    "Commit the result of your current workflow state. Call it once, as your last action, when the state's work " +
    'is complete. Until an accepted call, the state has not committed: ending your turn without it does not finish ' +
    'the state. The first accepted commit is final.',
  inputSchema,
} as const;

/** Annotation for the policy engine: no argument names a resource. */
export const workflowCommitAnnotations: StoredToolAnnotation[] = [
  {
    toolName: WORKFLOW_COMMIT_TOOL,
    serverName: WORKFLOW_COMMIT_SERVER,
    comment: 'Report the result of the current workflow state to the orchestrator',
    args: {
      invocation: ['none'],
      verdict: ['none'],
      notes: ['none'],
      handoff: ['none'],
    },
    inputSchema,
  },
];

/**
 * Hardcoded rule, placed ahead of compiled rules so no persona policy can
 * shadow it. The coordinator gives it to a task scope (`--task-scoped`) too:
 * a task compile never names the `workflow` server.
 */
export const workflowCommitPolicyRules: CompiledRule[] = [
  {
    name: 'workflow-commit-allow',
    description: 'Committing a workflow state result only reports it to the workflow orchestrator',
    principle: 'Least privilege',
    if: { server: [WORKFLOW_COMMIT_SERVER], tool: [WORKFLOW_COMMIT_TOOL] },
    then: 'allow',
    reason: 'Reports the state result to the workflow orchestrator; no effect outside IronCurtain',
  },
];

/** Annotations with the virtual `workflow` server added (a shallow copy; the input is not modified). */
export function withWorkflowCommitAnnotations(src: StoredToolAnnotationsFile): StoredToolAnnotationsFile {
  return {
    ...src,
    servers: {
      ...src.servers,
      [WORKFLOW_COMMIT_SERVER]: { inputHash: 'hardcoded', tools: workflowCommitAnnotations },
    },
  };
}

/** A compiled policy with the workflow_commit rule prepended (a shallow copy; the input is not modified). */
export function withWorkflowCommitRules(policy: CompiledPolicyFile): CompiledPolicyFile {
  return { ...policy, rules: [...workflowCommitPolicyRules, ...policy.rules] };
}

// ---------------------------------------------------------------------------
// Handler contract
// ---------------------------------------------------------------------------

/** A validated `workflow_commit` call. Strings are trimmed; empty optional fields are absent. */
export interface WorkflowCommitRequest {
  readonly invocation: string;
  readonly verdict: string;
  readonly notes?: string;
  readonly handoff?: string;
}

/** The handler's answer. `message` / `reason` is the text the agent receives. */
export type WorkflowCommitOutcome =
  { readonly accepted: true; readonly message: string } | { readonly accepted: false; readonly reason: string };

/**
 * In-process target of a coordinator's `workflow_commit` calls: the workflow
 * orchestrator's commit channel for the bundle (shared-container mode) or
 * the session (one container or sandbox per state) the coordinator serves.
 */
export interface WorkflowCommitHandler {
  /**
   * Called once by the coordinator that registered `workflow_commit` for its
   * agent. The orchestrator asks an agent to commit through the tool only
   * after this, so it never instructs an agent to call a tool its catalog
   * does not have.
   */
  attach(): void;
  /** Records or refuses one commit. Must not throw. */
  commit(request: WorkflowCommitRequest): WorkflowCommitOutcome;
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

type CommitField = keyof typeof WORKFLOW_COMMIT_LIMITS;

/** Problem with one field, or the trimmed value (undefined when an optional field is absent or empty). */
function checkField(
  args: Record<string, unknown>,
  field: CommitField,
  required: boolean,
): { readonly error: string } | { readonly value: string | undefined } {
  const raw = args[field];
  if (raw === undefined || raw === null) {
    return required ? { error: `Missing required argument "${field}"` } : { value: undefined };
  }
  if (typeof raw !== 'string') return { error: `Argument "${field}" must be a string` };
  const value = raw.trim();
  if (value.length === 0) {
    return required ? { error: `Argument "${field}" must not be empty` } : { value: undefined };
  }
  const limit = WORKFLOW_COMMIT_LIMITS[field];
  if (value.length > limit) {
    return { error: `Argument "${field}" is too long (${value.length} characters; at most ${limit})` };
  }
  return { value };
}

/**
 * Parses and bounds the arguments of a `workflow_commit` call. The pipeline
 * runs it before policy evaluation, so a malformed commit is denied and
 * audited as `invalid-arguments` and never reaches the handler.
 */
export function parseWorkflowCommitArguments(
  args: Record<string, unknown>,
): { readonly ok: true; readonly request: WorkflowCommitRequest } | { readonly ok: false; readonly error: string } {
  const invocation = checkField(args, 'invocation', true);
  if ('error' in invocation) return { ok: false, error: invocation.error };
  const verdict = checkField(args, 'verdict', true);
  if ('error' in verdict) return { ok: false, error: verdict.error };
  const notes = checkField(args, 'notes', false);
  if ('error' in notes) return { ok: false, error: notes.error };
  const handoff = checkField(args, 'handoff', false);
  if ('error' in handoff) return { ok: false, error: handoff.error };

  const invocationId = invocation.value ?? '';
  const verdictValue = verdict.value ?? '';
  // Ids are minted by the orchestrator (UUIDs); anything else cannot name an
  // open invocation and is refused here rather than echoed back.
  if (!/^[A-Za-z0-9-]+$/.test(invocationId)) {
    return { ok: false, error: 'Argument "invocation" is not an invocation id' };
  }
  // The verdict routes the workflow and is printed on one line: no control
  // characters (line breaks included).
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(verdictValue)) {
    return { ok: false, error: 'Argument "verdict" must be a single line without control characters' };
  }

  return {
    ok: true,
    request: {
      invocation: invocationId,
      verdict: verdictValue,
      ...(notes.value !== undefined ? { notes: notes.value } : {}),
      ...(handoff.value !== undefined ? { handoff: handoff.value } : {}),
    },
  };
}
