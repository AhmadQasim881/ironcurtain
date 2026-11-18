/**
 * The agent's justification for each running `execute_code` chain.
 *
 * `execute_code` takes an optional `justification`: the agent's own words on
 * why the code needs the actions it takes. When one of the chain's tool calls
 * escalates, the human reviewer sees that text, labelled as written by the
 * agent. It is untrusted display text and nothing else reads it: the policy
 * engine, the approval whitelist and the auto-approver never see it.
 *
 * Several chains can run at once over one sandbox (parallel tool calls from
 * the model, workflow lanes sharing a container), and a tool call reaching
 * the coordinator does not say which chain issued it. So a justification is
 * attributed only while exactly one chain runs; with none or several, a call
 * gets none rather than a justification another chain wrote. The coordinator
 * reads it when a call enters (`ToolCallCoordinator.handleToolCall`), while
 * the chain that issued the call is still running.
 */

import { normalizeAgentJustification } from '../trusted-process/escalation-context.js';

/** Description of the `execute_code` `justification` input, shared by the builtin and Docker tools. */
export const EXECUTE_CODE_JUSTIFICATION_DESCRIPTION =
  'Optional. One or two sentences on why this code needs the actions it takes. If a tool call ' +
  'needs human approval, the reviewer sees this text labelled as written by you. It never grants ' +
  'approval by itself.';

/** Tracks the justification of every running chain (see the module comment). */
export class ChainJustifications {
  private readonly running = new Map<number, string | undefined>();
  private nextId = 0;

  /**
   * Registers a chain that is starting, with its justification (bounded and
   * trimmed; anything that is not a non-empty string counts as none).
   * Returns the function that unregisters it when the chain ends.
   */
  begin(justification: unknown): () => void {
    const id = ++this.nextId;
    this.running.set(id, normalizeAgentJustification(justification));
    return () => {
      this.running.delete(id);
    };
  }

  /** The justification of the only running chain; undefined when none or several run. */
  current(): string | undefined {
    if (this.running.size !== 1) return undefined;
    const [only] = this.running.values();
    return only;
  }

  /** Number of chains running now (tests, diagnostics). */
  get size(): number {
    return this.running.size;
  }
}
