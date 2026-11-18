/**
 * Fake PipelineModels for the pipeline runner tests.
 *
 * Two flavours:
 *  - `createFakePipelineModels(responses)`: one canned response per phase,
 *    replayed for every call (the Phase 0 golden harness, described below).
 *  - `createScriptedPipelineModels(script)`: per-phase reply SEQUENCES (values,
 *    thrown errors, tool calls, or functions of the call) plus a record of
 *    every call, for repair loops, failures and multi-run cache tests. An
 *    optional second script drives a separate verifier model.
 *    `createThrowingPipelineModels()` fails every call.
 *
 * Provides a deterministic, content-routing fake LanguageModelV3 that replays
 * canned responses for the policy-compilation call graph WITHOUT any network or
 * real LLM. The fake routes on the system prompt (and, for the system-less list
 * resolver, on the absence of a system prompt) so it is robust to internal
 * phase reordering — it does NOT depend on a positional response queue.
 *
 * Injected via `new PipelineRunner(fakeModels)` — no production change required.
 *
 * Call graph replayed (single-server, no cache, no prefilter, verify passes
 * in round 1, no discarded scenarios):
 *   1. ConstitutionCompilerSession.compile()  -> system "You are compiling a security policy"
 *   2. resolveViaLlm() (per knowledge list)   -> no system prompt
 *   3. generateScenarios() (single batch)     -> system "You are generating test scenarios"
 *   4. PolicyVerifierSession.judgeRound()      -> system "You are a security policy verifier"
 */

import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content } from '@ai-sdk/provider';
import { NoOpCacheStrategy, type PromptCacheStrategy } from '../../src/session/prompt-cache.js';
import type { PipelineModels } from '../../src/pipeline/pipeline-runner.js';

/** Canned responses keyed by pipeline phase. Each value is the bare JSON object the LLM "returns". */
export interface CannedResponses {
  /** Response for the constitution compiler (rules + listDefinitions). */
  readonly compile: unknown;
  /** Response for each knowledge-list resolution ({ values: [...] }). */
  readonly listResolution: unknown;
  /** Response for the scenario generator ({ scenarios: [...] }). */
  readonly scenarios: unknown;
  /** Response for the verifier judge ({ analysis, pass, failureAttributions, additionalScenarios }). */
  readonly judge: unknown;
}

/** Marks a scripted reply as cut off at the output-token cap (see {@link truncatedReply}). */
const TRUNCATED = Symbol('truncated');

/** A scripted reply that is cut off at the output-token cap. */
interface TruncatedReply {
  readonly [TRUNCATED]: string;
}

/**
 * A reply the model cut off at its output-token cap: `text` is returned
 * verbatim (typically JSON that stops mid-way) with finish reason "length".
 */
export function truncatedReply(text: string): TruncatedReply {
  return { [TRUNCATED]: text };
}

function isTruncatedReply(reply: unknown): reply is TruncatedReply {
  return typeof reply === 'object' && reply !== null && TRUNCATED in reply;
}

/** Builds a mock V3 generate result with the correct finishReason/usage shapes. */
function mockV3Result(responseJson: unknown) {
  const truncated = isTruncatedReply(responseJson);
  return {
    content: [{ type: 'text' as const, text: truncated ? responseJson[TRUNCATED] : JSON.stringify(responseJson) }],
    finishReason: truncated
      ? { unified: 'length' as const, raw: 'max_tokens' }
      : { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
    request: {},
    response: { id: 'fake-id', modelId: 'fake-model', timestamp: new Date(0) },
  };
}

/** Extracts the system-prompt text from V3 call options (system may be string or message). */
function systemTextOf(options: LanguageModelV3CallOptions): string {
  const sys: unknown = (options as { system?: unknown }).system;
  if (typeof sys === 'string') return sys;
  // The Vercel AI SDK passes `system` into the prompt as a system-role message.
  for (const msg of options.prompt) {
    if (msg.role === 'system') {
      // System message content is a plain string in V3 prompt format.
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }
  }
  return '';
}

/**
 * Creates a content-routing fake base LLM. Returns the canned response that
 * matches the phase implied by the system prompt. Throws on any unrecognized
 * call so a changed/extra LLM call surfaces loudly instead of silently passing.
 */
export function createRoutingFakeBaseLlm(responses: CannedResponses): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const system = systemTextOf(options);

      if (system.includes('You are compiling a security policy')) {
        return mockV3Result(responses.compile);
      }
      if (system.includes('You are generating test scenarios')) {
        return mockV3Result(responses.scenarios);
      }
      if (system.includes('You are a security policy verifier')) {
        return mockV3Result(responses.judge);
      }
      // The knowledge-based list resolver issues a generateText call with NO
      // system prompt — its user message carries the generationPrompt.
      if (system === '') {
        return mockV3Result(responses.listResolution);
      }

      throw new Error(`Fake LLM: unrecognized call. System prompt prefix: ${JSON.stringify(system.slice(0, 120))}`);
    },
  });
}

/** Identity cache strategy: the system prompt passes through unchanged as a string. */
const identityCacheStrategy: PromptCacheStrategy = new NoOpCacheStrategy();

// ---------------------------------------------------------------------------
// Per-phase scripted sequences (multi-run, repair and failure-path tests)
// ---------------------------------------------------------------------------

/**
 * The pipeline phase a fake LLM call belongs to, recognized from the system
 * prompt and the latest user message.
 */
export type FakeLlmPhase =
  /** Server pre-filter (one call per server). */
  | 'prefilter'
  /** Initial ConstitutionCompilerSession.compile(). */
  | 'compile'
  /** Point-fix repair; the reply is a patch: { reasoning, operations, listDefinitions? }. */
  | 'repair'
  /** Full-recompile fallback ("REPAIR INSTRUCTIONS"); the reply is a full rule set. */
  | 'recompile'
  /** Rule-check feedback ("RULE VALIDATION REPAIR"); the reply is a full rule set. */
  | 'validationRepair'
  /** A schema-repair retry turn of any phase ("Your response failed schema validation"). */
  | 'schemaRetry'
  /** Knowledge-list resolution (no system prompt). */
  | 'listResolution'
  /**
   * Data-backed (MCP) list resolution: a tool-use loop over mediated MCP tools.
   * Reply with fakeToolCall / fakeText, or a plain value for the final text,
   * e.g. { values: [...] }.
   */
  | 'mcpListResolution'
  /** Scenario generation. */
  | 'scenarios'
  /** Replacements for structurally discarded scenarios. */
  | 'scenarioRepair'
  /** PolicyVerifierSession.judgeRound(). */
  | 'judge';

/** One recorded fake LLM call. */
export interface FakeLlmCall {
  readonly phase: FakeLlmPhase;
  /** 0-based index of this call among the calls of its phase. */
  readonly indexInPhase: number;
  readonly system: string;
  /** Text of the latest user message (for the pre-filter: the text it judges). */
  readonly userText: string;
  /** The output-token cap of the call. */
  readonly maxOutputTokens?: number;
  /** The sampling temperature of the call, when one was set. */
  readonly temperature?: number;
  /** Names of the tools the call offered the model (tool-use phases only). */
  readonly offeredTools: string[];
}

/**
 * A scripted reply. A plain value is the JSON object the model returns; an
 * `Error` is thrown (an LLM or network failure); {@link truncatedReply} is
 * text cut off at the output cap; `fakeToolCall` / `fakeText` replies are
 * returned as they are; a function receives the call and returns
 * any of these, or throws.
 */
export type FakeReply = unknown;

const RAW_REPLY = Symbol('fake raw model output');

/** Model output returned as it is, instead of as a JSON text. */
interface FakeRawReply {
  readonly [RAW_REPLY]: {
    readonly content: LanguageModelV3Content[];
    readonly finishReason: { readonly unified: 'stop' | 'tool-calls'; readonly raw: string };
  };
}

function isRawReply(reply: unknown): reply is FakeRawReply {
  return typeof reply === 'object' && reply !== null && RAW_REPLY in reply;
}

let toolCallCounter = 0;

/** A reply in which the model calls `toolName` with `input` (for tool-use phases such as mcpListResolution). */
export function fakeToolCall(toolName: string, input: Record<string, unknown>): FakeRawReply {
  toolCallCounter++;
  return {
    [RAW_REPLY]: {
      content: [
        { type: 'tool-call', toolCallId: `fake-call-${toolCallCounter}`, toolName, input: JSON.stringify(input) },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    },
  };
}

/** A reply in which the model answers with plain `text`. */
export function fakeText(text: string): FakeRawReply {
  return { [RAW_REPLY]: { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' } } };
}

function mockRawResult(reply: FakeRawReply) {
  const { content, finishReason } = reply[RAW_REPLY];
  return { ...mockV3Result(null), content, finishReason };
}

/**
 * Replies per phase. Each phase's replies are consumed in order and the LAST
 * one repeats once the sequence is exhausted, so "the judge always rejects" is
 * a one-element sequence. A call to a phase with no script throws loudly.
 */
export type FakePhaseScript = Partial<Record<FakeLlmPhase, readonly FakeReply[]>>;

/** Fake models plus the record of every call made through them (including calls that threw). */
export interface ScriptedPipelineModels {
  readonly models: PipelineModels;
  /** Calls to the policy model (and the pre-filter). */
  readonly calls: FakeLlmCall[];
  /** Calls to the separate verifier model; always empty without a verifier script. */
  readonly verifierCalls: FakeLlmCall[];
}

/** Options for {@link createScriptedPipelineModels}. */
export interface ScriptedPipelineOptions {
  /**
   * Script of a separate verifier model (PipelineModels.verifier), which then
   * receives the scenario-generation, scenario-repair and judge calls.
   */
  readonly verifierScript?: FakePhaseScript;
  /** Model ID the verifier reports (recorded in verified commits). Default 'fake:verifier'. */
  readonly verifierModelId?: string;
}

/** Text of the latest user message in V3 call options. */
function latestUserTextOf(options: LanguageModelV3CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const msg = options.prompt[i];
    if (msg.role !== 'user') continue;
    return msg.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

function classifyFakeCall(system: string, userText: string): FakeLlmPhase {
  if (system.includes('You are evaluating whether an input text is relevant')) return 'prefilter';
  if (system.includes('You compile a list of values from data returned by read-only tools')) {
    return 'mcpListResolution';
  }
  if (userText.startsWith('Your response failed schema validation')) return 'schemaRetry';
  if (system.includes('You are compiling a')) {
    if (userText.includes('## POINT-FIX REPAIR')) return 'repair';
    if (userText.includes('## REPAIR INSTRUCTIONS')) return 'recompile';
    if (userText.includes('## RULE VALIDATION REPAIR')) return 'validationRepair';
    return 'compile';
  }
  if (system.includes('You are generating test scenarios')) {
    return userText.includes('were discarded because they conflict with structural invariants')
      ? 'scenarioRepair'
      : 'scenarios';
  }
  if (system.includes('You are a security policy verifier')) return 'judge';
  if (system === '') return 'listResolution';
  throw new Error(`Fake LLM: unrecognized call. System prompt prefix: ${JSON.stringify(system.slice(0, 120))}`);
}

/** A fake model that answers every call from `script` and records it in `calls`. */
function createScriptedLlm(script: FakePhaseScript, calls: FakeLlmCall[], label: string): MockLanguageModelV3 {
  const perPhase = new Map<FakeLlmPhase, number>();
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const system = systemTextOf(options);
      const userText = latestUserTextOf(options);
      const phase = classifyFakeCall(system, userText);
      const indexInPhase = perPhase.get(phase) ?? 0;
      perPhase.set(phase, indexInPhase + 1);
      const call: FakeLlmCall = {
        phase,
        indexInPhase,
        system,
        userText,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        offeredTools: (options.tools ?? []).map((t) => t.name),
      };
      calls.push(call);

      const replies = script[phase];
      if (!replies || replies.length === 0) {
        throw new Error(`Fake ${label}: no scripted reply for phase "${phase}" (call ${indexInPhase}).`);
      }
      let reply: unknown = replies[Math.min(indexInPhase, replies.length - 1)];
      if (typeof reply === 'function') reply = (reply as (c: FakeLlmCall) => unknown)(call);
      if (reply instanceof Error) throw reply;
      return isRawReply(reply) ? mockRawResult(reply) : mockV3Result(reply);
    },
  });
}

/**
 * Creates fake PipelineModels driven by per-phase reply sequences. The same
 * fake serves the policy model and the pre-filter model, and records every
 * call in `calls`. With `options.verifierScript`, a second fake becomes the
 * separate verifier model and records its calls in `verifierCalls`.
 */
export function createScriptedPipelineModels(
  script: FakePhaseScript,
  logPath: string,
  options: ScriptedPipelineOptions = {},
): ScriptedPipelineModels {
  const calls: FakeLlmCall[] = [];
  const verifierCalls: FakeLlmCall[] = [];
  const baseLlm = createScriptedLlm(script, calls, 'LLM');
  const models: PipelineModels = { baseLlm, cacheStrategy: identityCacheStrategy, logPath, prefilterModel: baseLlm };
  if (!options.verifierScript) return { models, calls, verifierCalls };
  return {
    models: {
      ...models,
      verifier: {
        baseLlm: createScriptedLlm(options.verifierScript, verifierCalls, 'verifier LLM'),
        cacheStrategy: identityCacheStrategy,
        modelId: options.verifierModelId ?? 'fake:verifier',
      },
    },
    calls,
    verifierCalls,
  };
}

/**
 * Fake PipelineModels whose every call throws (an LLM that is down). Used to
 * prove a run makes no LLM call at all, or how it behaves when every call fails.
 */
export function createThrowingPipelineModels(logPath: string): ScriptedPipelineModels {
  const fail = (call: FakeLlmCall): never => {
    throw new Error(`Fake LLM: unavailable (${call.phase} call ${call.indexInPhase})`);
  };
  const phases: FakeLlmPhase[] = [
    'prefilter',
    'compile',
    'repair',
    'recompile',
    'validationRepair',
    'schemaRetry',
    'listResolution',
    'mcpListResolution',
    'scenarios',
    'scenarioRepair',
    'judge',
  ];
  return createScriptedPipelineModels(Object.fromEntries(phases.map((p) => [p, [fail]])), logPath);
}

/**
 * Builds a complete fake PipelineModels. The prefilter model is the same routing
 * fake but is never exercised when the golden run passes `prefilterText: undefined`.
 */
export function createFakePipelineModels(responses: CannedResponses, logPath: string): PipelineModels {
  const baseLlm = createRoutingFakeBaseLlm(responses);
  return {
    baseLlm,
    cacheStrategy: identityCacheStrategy,
    logPath,
    // Never called in the golden run (prefilterText undefined). Provided for type
    // completeness; cast through unknown because MockLanguageModelV3 is a V3 model
    // and the prefilter field is typed as the wrapped `LanguageModel`.
    prefilterModel: baseLlm,
  };
}
