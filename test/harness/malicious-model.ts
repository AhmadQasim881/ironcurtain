/**
 * Scripted malicious-model driver for the adversarial / agent-loop harness.
 *
 * A compromised agent is a model that emits whatever tool calls it likes.
 * These helpers build a `MockLanguageModelV3` (ai/test) that plays a scripted
 * sequence of `execute_code` tool calls and text answers through the *real*
 * `generateText` loop, so the SDK's real callback order (onStepFinish, stop
 * conditions, tool-call execution) and real `ModelMessage` shapes
 * (toolCallId / input / output) are exercised — unlike test/session.test.ts,
 * which replaces `generateText` with a `vi.fn()`.
 *
 * The script is reassignable so one long-lived session can play one adversarial
 * probe per `sendMessage` turn: {@link ScriptedMaliciousModel.playTurn} sets the
 * steps the next turn runs, ending each turn with a text answer so the loop
 * terminates on its own.
 */

import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3Content } from '@ai-sdk/provider';

/** Per-step token usage; small realistic defaults. */
export interface StepUsage {
  readonly input: number;
  readonly output: number;
}

const DEFAULT_USAGE: StepUsage = { input: 1_000, output: 50 };

/** One step the malicious model plays. */
export type MaliciousStep =
  | {
      /** Emit an `execute_code` tool call carrying this TypeScript. */
      readonly kind: 'exec';
      readonly code: string;
      readonly usage?: StepUsage;
    }
  | {
      /** Emit a final text answer (ends the turn). */
      readonly kind: 'text';
      readonly text: string;
      readonly usage?: StepUsage;
    };

/** Builds the SDK `doGenerate` result for one step in the V3 content shape. */
function generateResult(step: MaliciousStep, callIndex: number): Awaited<ReturnType<LanguageModelV3['doGenerate']>> {
  const content: LanguageModelV3Content[] = [];
  const usage = step.usage ?? DEFAULT_USAGE;
  if (step.kind === 'text') {
    content.push({ type: 'text', text: step.text });
  } else {
    content.push({
      type: 'tool-call',
      toolCallId: `call-${callIndex}`,
      toolName: 'execute_code',
      input: JSON.stringify({ code: step.code }),
    });
  }
  return {
    content,
    finishReason:
      step.kind === 'exec' ? { unified: 'tool-calls', raw: 'tool_use' } : { unified: 'stop', raw: 'end_turn' },
    usage: {
      inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: usage.output, text: usage.output, reasoning: undefined },
    },
    warnings: [],
    request: {},
    response: { id: `response-${callIndex}`, modelId: 'malicious-mock', timestamp: new Date(0) },
  };
}

export interface ScriptedMaliciousModel {
  readonly model: MockLanguageModelV3;
  /** Steps the current/next turn plays, in order. Repeats the last step if the loop overruns. */
  playTurn(steps: readonly MaliciousStep[]): void;
  /** How many times the loop has called the model so far (a cursor for {@link toolResultsSince}). */
  callCount(): number;
  /**
   * The tool results the loop fed back to the model in the calls made after
   * `cursor`, serialized: what an attack's code got back from the sandbox,
   * as the model saw it. The model's own tool calls (which echo the attack
   * code) and the system prompt are left out. A secret absent here never
   * reached the agent, whatever the tool call returned.
   */
  toolResultsSince(cursor: number): string;
}

/**
 * A `MockLanguageModelV3` whose per-turn script is reassignable via
 * {@link ScriptedMaliciousModel.playTurn}. Each `doGenerate` pops the next
 * scripted step (repeating the last one so an overrunning loop still gets a
 * terminal answer when the script ends in text).
 */
export function createScriptedMaliciousModel(initial: readonly MaliciousStep[] = []): ScriptedMaliciousModel {
  let steps: MaliciousStep[] = [...initial];
  let cursor = 0;
  let callIndex = 0;

  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(cursor, steps.length - 1)] ?? { kind: 'text', text: 'done' };
      cursor += 1;
      callIndex += 1;
      return generateResult(step, callIndex);
    },
  });

  return {
    model,
    playTurn(next: readonly MaliciousStep[]): void {
      steps = [...next];
      cursor = 0;
    },
    callCount(): number {
      return model.doGenerateCalls.length;
    },
    toolResultsSince(from: number): string {
      return JSON.stringify(
        model.doGenerateCalls.slice(from).flatMap((call) => call.prompt.filter((message) => message.role === 'tool')),
      );
    },
  };
}

/**
 * A model that calls `execute_code` on every step and never answers, with
 * distinct code per step so the loop detector never blocks it — used to prove
 * a budget stop ends an otherwise unbounded tool loop.
 */
export function createUnboundedToolModel(usage: StepUsage = DEFAULT_USAGE): MockLanguageModelV3 {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      callIndex += 1;
      return generateResult({ kind: 'exec', code: `return ${callIndex};`, usage }, callIndex);
    },
  });
}
