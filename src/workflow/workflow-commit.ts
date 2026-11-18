/**
 * Orchestrator side of the coordinator-owned `workflow_commit` tool.
 *
 * One {@link WorkflowCommitChannel} serves one coordinator: a shared
 * container bundle's (every state that borrows the bundle commits through
 * it) or a per-state session's. The coordinator calls `attach()` once it has
 * registered the tool for its agent, and from then on hands every
 * `workflow_commit` call to `commit()`.
 *
 * The orchestrator opens one invocation per agent-state invocation and puts
 * its id into the state's instructions. A commit is accepted only while the
 * invocation it names is open and has not committed, and only with a verdict
 * the state routes on (when the state has a closed verdict set), so it is
 * tied to exactly one invocation: a drained fan-out lane, a previous visit of
 * the state or a turn that already ended cannot commit another invocation's
 * result by quoting the id it was given, and an error never reveals another
 * invocation's id. The id is not a secret from code that shares the agent's
 * container: the agent CLI's transcript, which carries every prompt, is
 * readable there, so a process left running in a shared container or a
 * sibling fan-out lane could quote it. Such code is already inside the
 * bundle's trust boundary (it can rewrite the agent's files and
 * transcript), so the binding guards against stale and misdirected commits,
 * not against it. The orchestrator reads the commit after each turn: none
 * means the state has not committed (see `executeAgentState`).
 *
 * See `src/trusted-process/workflow-commit-tool.ts` for the tool itself.
 */

import { randomUUID } from 'node:crypto';
import type {
  WorkflowCommitHandler,
  WorkflowCommitOutcome,
  WorkflowCommitRequest,
} from '../trusted-process/workflow-commit-tool.js';
import { WORKFLOW_COMMIT_CALLABLE } from '../trusted-process/workflow-commit-tool.js';

/** An accepted commit. Optional fields the agent left out or empty are null. */
export interface WorkflowCommit {
  readonly invocationId: string;
  readonly verdict: string;
  readonly notes: string | null;
  readonly handoff: string | null;
  /** ISO timestamp at which the commit was accepted. */
  readonly committedAt: string;
}

/** What one open invocation accepts. */
export interface WorkflowCommitInvocationSpec {
  /** The agent state the invocation runs (shown in the agent's confirmation). */
  readonly stateId: string;
  /**
   * The verdicts the state routes on (`getValidVerdicts`); a commit with any
   * other verdict is refused with the list. Undefined accepts any verdict
   * (unconditional or guard-only routing).
   */
  readonly validVerdicts?: ReadonlySet<string>;
}

/** One open agent-state invocation, as the orchestrator holds it. */
export interface WorkflowCommitInvocation {
  /** The id the agent quotes in `workflow_commit` (a UUID). */
  readonly id: string;
  /** The accepted commit, or undefined while the invocation has not committed. */
  committed(): WorkflowCommit | undefined;
  /** Ends the invocation: later commits naming it are refused. Idempotent. */
  close(): void;
}

interface InvocationRecord {
  readonly spec: WorkflowCommitInvocationSpec;
  commit?: WorkflowCommit;
}

/** Most verdicts listed back to an agent whose verdict was refused. */
const MAX_LISTED_VERDICTS = 20;

export class WorkflowCommitChannel implements WorkflowCommitHandler {
  private attached = false;
  private readonly invocations = new Map<string, InvocationRecord>();

  /** True once a coordinator has registered `workflow_commit` for this channel's agent. */
  get isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  /** Opens an invocation with a fresh, unguessable id. */
  open(spec: WorkflowCommitInvocationSpec): WorkflowCommitInvocation {
    const id = randomUUID();
    const record: InvocationRecord = { spec };
    this.invocations.set(id, record);
    return {
      id,
      committed: () => record.commit,
      close: () => {
        if (this.invocations.get(id) === record) this.invocations.delete(id);
      },
    };
  }

  /** Number of invocations currently open (diagnostics, tests). */
  get openInvocationCount(): number {
    return this.invocations.size;
  }

  commit(request: WorkflowCommitRequest): WorkflowCommitOutcome {
    const record = this.invocations.get(request.invocation);
    if (!record) {
      // Never name the invocation that IS open: a stale caller (a drained
      // lane, a previous visit) must not learn the current id.
      return {
        accepted: false,
        reason:
          'Nothing was committed: no open workflow state invocation has this id. It may belong to a state ' +
          'that has already finished. Use the invocation id from your most recent workflow instructions.',
      };
    }
    if (record.commit) {
      return {
        accepted: false,
        reason:
          `This state has already committed verdict "${record.commit.verdict}"; the first commit is final. ` +
          'Finish your turn without calling it again.',
      };
    }
    const { validVerdicts } = record.spec;
    if (validVerdicts && !validVerdicts.has(request.verdict)) {
      const valid = [...validVerdicts].slice(0, MAX_LISTED_VERDICTS).map((verdict) => `"${verdict}"`);
      return {
        accepted: false,
        reason:
          `Nothing was committed: "${request.verdict}" is not a verdict this state routes on. ` +
          `Call ${WORKFLOW_COMMIT_CALLABLE} again with exactly one of: ${valid.join(', ')}.`,
      };
    }
    record.commit = {
      invocationId: request.invocation,
      verdict: request.verdict,
      notes: request.notes ?? null,
      handoff: request.handoff ?? null,
      committedAt: new Date().toISOString(),
    };
    return {
      accepted: true,
      message:
        `Committed verdict "${request.verdict}" for workflow state "${record.spec.stateId}". ` +
        'The state result is recorded; finish your turn now.',
    };
  }
}
