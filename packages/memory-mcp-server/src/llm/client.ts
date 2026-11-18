import OpenAI from 'openai';
import type { MemoryConfig } from '../config.js';
import { STORED_MEMORIES_ARE_DATA_RULE, escapeTagOpeners } from '../utils/framing.js';

/**
 * Describe an LLM error as a CONTENT-FREE shape for logging.
 *
 * The OpenAI SDK error embeds the request body (= the prompt, which for
 * `memory_ingest` is raw sensitive content) and/or the response body in its
 * `.message`, so we log ONLY the error name, the numeric status, and the short
 * enum-like `code` (e.g. "invalid_api_key") — never the message, the request, or
 * the response. Used by every llmComplete caller (extraction, compaction,
 * consolidation), so the guarantee holds package-wide.
 */
function describeLlmError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.name];
    const withFields = err as { status?: unknown; code?: unknown };
    if (typeof withFields.status === 'number') parts.push(`status=${withFields.status}`);
    // `code` is a short enum-like string (e.g. "invalid_api_key") or a number —
    // content-free either way. Bound the string length as a defensive guard
    // against a pathological SDK that stuffs response content into it.
    const code = withFields.code;
    if (typeof code === 'number') parts.push(`code=${code}`);
    else if (typeof code === 'string' && code.length > 0 && code.length <= 40) parts.push(`code=${code}`);
    return parts.join(' ');
  }
  // Non-Error throw: report only its primitive type, never its serialized value.
  return `non-error throw (${typeof err})`;
}

let llmClient: OpenAI | null = null;
let clientConfig: { baseUrl: string | null; apiKey: string | null } | null = null;

/**
 * Attempts per LLM call beyond the first. The SDK default (two retries, each with a
 * 600 s timeout) let one call outlive the MCP request that made it many times over.
 */
const LLM_MAX_RETRIES = 1;

/** Completion limit when the caller names none. */
const DEFAULT_MAX_TOKENS = 300;

/** How far past a call's deadline the SDK's per-attempt timeout is set (see llmComplete). */
const ATTEMPT_TIMEOUT_SLACK_MS = 1000;

/**
 * Get or lazily create the OpenAI-compatible LLM client.
 * Returns null when no LLM is configured (graceful degradation).
 */
export function getLLMClient(config: MemoryConfig): OpenAI | null {
  if (config.llmApiKey === null && config.llmBaseUrl === null) return null;

  // Re-create client if config changed
  if (llmClient && clientConfig?.baseUrl === config.llmBaseUrl && clientConfig.apiKey === config.llmApiKey) {
    return llmClient;
  }

  llmClient = new OpenAI({
    apiKey: config.llmApiKey ?? 'not-needed',
    baseURL: config.llmBaseUrl ?? undefined,
    // Every call passes its own deadline (llmComplete); these are the fallbacks.
    timeout: config.llmTimeoutMs,
    maxRetries: LLM_MAX_RETRIES,
  });
  clientConfig = { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey };

  return llmClient;
}

export interface LlmCompleteOptions {
  maxTokens?: number;
  /**
   * Deadline for the whole call, its retry included (default `config.llmTimeoutMs`).
   * When it passes, the call returns null and the caller uses its non-LLM fallback.
   */
  timeoutMs?: number;
  /** Aborted when the MCP request this call serves is cancelled: the call returns null at once. */
  signal?: AbortSignal;
}

// ---------- Per-process LLM budget ----------
//
// The server calls the LLM with the user's key, outside IronCurtain's own LLM metering
// and session budgets, so it bounds its own spend: at most `config.llmMaxCalls` calls
// and `config.llmMaxTokens` tokens per process (one process serves one session). A call
// reserves its prompt (estimated at ~4 characters per token) plus its completion limit
// before it is sent; the provider's reported usage replaces the reservation when the call
// succeeds, and a failed or timed-out call keeps it (the provider may have done the work).
// A call that does not fit is not sent: llmComplete returns null, which every caller
// already treats as "no LLM" (extractive or list output, degraded ingest, maintenance
// without LLM judgment).

export interface LlmSpend {
  /** Calls sent (or about to be sent). */
  calls: number;
  /** Tokens reserved or reported for those calls. */
  tokens: number;
  /** Calls refused because they did not fit the budget. */
  refused: number;
}

const spend: LlmSpend = { calls: 0, tokens: 0, refused: 0 };

/** What this process has spent on the LLM so far. */
export function getLlmSpend(): Readonly<LlmSpend> {
  return { ...spend };
}

/** Forget the spend so far (tests). */
export function resetLlmSpend(): void {
  spend.calls = 0;
  spend.tokens = 0;
  spend.refused = 0;
}

/** Tokens a call may use: its prompt, estimated at ~4 characters per token, plus its completion limit. */
function reservedTokens(systemPrompt: string, userPrompt: string, maxTokens: number): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4) + maxTokens;
}

/** Reserve one call of `tokens` tokens, or refuse it (and say so once) when it does not fit. */
function reserveBudget(config: MemoryConfig, tokens: number): boolean {
  if (spend.calls + 1 <= config.llmMaxCalls && spend.tokens + tokens <= config.llmMaxTokens) {
    spend.calls += 1;
    spend.tokens += tokens;
    return true;
  }
  if (spend.refused === 0) {
    console.error(
      `[memory-server] LLM budget of this server process used up (${spend.calls} of ${config.llmMaxCalls} calls, ` +
        `${spend.tokens} of ${config.llmMaxTokens} tokens): LLM features fall back to their non-LLM behaviour ` +
        'until the server restarts.',
    );
  }
  spend.refused += 1;
  return false;
}

/** Replace a successful call's reservation with the tokens the provider reports, when it reports them. */
function recordUsage(reserved: number, usage: { total_tokens?: number } | undefined): void {
  const reported = usage?.total_tokens;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
    spend.tokens += reported - reserved;
  }
}

// ---------- Deadline ----------

const ABORTED = Symbol('aborted');

/**
 * The request's result, or ABORTED as soon as `signal` aborts, whatever the request is
 * waiting for. The SDK only checks its signal between steps: a retry's back-off (which
 * honours a server's Retry-After, however long) cannot be interrupted, so the race, not
 * the SDK, enforces the deadline. A request that loses the race is aborted through the
 * same signal; its late rejection is swallowed.
 */
async function settleBefore<T>(request: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  request.catch(() => undefined);
  if (signal.aborted) return ABORTED;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Send a system + user prompt to the configured LLM.
 * Returns null when no LLM is configured, the per-process budget is used up, the
 * deadline passes, the caller's signal aborts, or the call fails (graceful fallback).
 */
export async function llmComplete(
  config: MemoryConfig,
  systemPrompt: string,
  userPrompt: string,
  opts?: LlmCompleteOptions,
): Promise<string | null> {
  const client = getLLMClient(config);
  if (!client) return null;
  const callerSignal = opts?.signal;
  if (callerSignal?.aborted) return null;

  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const reserved = reservedTokens(systemPrompt, userPrompt, maxTokens);
  if (!reserveBudget(config, reserved)) return null;

  const timeoutMs = opts?.timeoutMs ?? config.llmTimeoutMs;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => {
    deadline.abort();
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const request = client.chat.completions.create(
      {
        model: config.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      },
      // The SDK's own per-attempt timeout is set past the deadline, so the deadline always
      // ends a hung call (no retry after it); a retry happens only after a quick failure.
      { signal: deadline.signal, timeout: timeoutMs + ATTEMPT_TIMEOUT_SLACK_MS, maxRetries: LLM_MAX_RETRIES },
    );
    const response = await settleBefore(request, deadline.signal);
    if (response === ABORTED) {
      console.error(
        callerSignal?.aborted
          ? '[memory-server] LLM call cancelled with its request'
          : `[memory-server] LLM call timed out after ${timeoutMs} ms`,
      );
      return null;
    }
    recordUsage(reserved, response.usage);
    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    // PII-safe: log a content-free error shape only — the SDK error can embed the
    // prompt/response body, which for memory_ingest is raw sensitive content.
    console.error('[memory-server] LLM call failed:', describeLlmError(err));
    return null;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Judge whether two memories are duplicates, contradictions, or distinct.
 * Returns 'distinct' as default when LLM is unavailable or unclear.
 */
export async function judgeMemoryRelation(
  config: MemoryConfig,
  newContent: string,
  existingContent: string,
): Promise<'duplicate' | 'contradiction' | 'distinct'> {
  const result = await llmComplete(
    config,
    `You judge whether two memories are duplicates, contradictions, or distinct facts.\n` +
      `The existing memory is provided within <existing_memory> tags and the new memory within <new_memory> tags.\n` +
      `Reply with exactly one word: "duplicate", "contradiction", or "distinct".\n` +
      `- "duplicate": they express the same fact, possibly worded differently\n` +
      `- "contradiction": they express conflicting facts about the same topic (the new one supersedes the old)\n` +
      `- "distinct": they are about different topics or complementary facts`,
    `<existing_memory>\n${existingContent}\n</existing_memory>\n<new_memory>\n${newContent}\n</new_memory>`,
    { maxTokens: 10 },
  );

  const normalized = result?.trim().toLowerCase();
  if (normalized === 'duplicate' || normalized === 'contradiction') return normalized;
  return 'distinct';
}

// ---------- Batch judgment ----------

/** A pair of memories to be judged. */
export interface CandidatePair {
  newId: string;
  newContent: string;
  existingId: string;
  existingContent: string;
}

export type PairRelation = 'duplicate' | 'contradiction' | 'distinct';

export interface BatchJudgment {
  pairIndex: number;
  relation: PairRelation;
}

const MAX_PAIRS_PER_CALL = 20;

/**
 * Judge multiple memory pairs in a single LLM call.
 * Returns a judgment for each pair. On LLM failure, defaults all to 'distinct'.
 */
export async function batchJudgeMemoryRelations(
  config: MemoryConfig,
  pairs: CandidatePair[],
): Promise<BatchJudgment[]> {
  const allJudgments: BatchJudgment[] = [];
  let globalOffset = 0;

  for (let i = 0; i < pairs.length; i += MAX_PAIRS_PER_CALL) {
    const batch = pairs.slice(i, i + MAX_PAIRS_PER_CALL);
    const judgments = await judgeBatch(config, batch, globalOffset);
    allJudgments.push(...judgments);
    globalOffset += batch.length;
  }

  return allJudgments;
}

/**
 * The pairs of one judge call, each memory inside its own tags. Tag openers in the
 * stored text are escaped, so a memory cannot close its `<new>` or `<pair>` and pose
 * as further pairs or as instructions about the other pairs of the batch.
 */
export function buildJudgePairsText(batch: readonly CandidatePair[]): string {
  return batch
    .map(
      (pair, i) =>
        `<pair index="${i}">\n` +
        `<existing>${escapeTagOpeners(pair.existingContent)}</existing>\n` +
        `<new>${escapeTagOpeners(pair.newContent)}</new>\n` +
        `</pair>`,
    )
    .join('\n');
}

async function judgeBatch(config: MemoryConfig, batch: CandidatePair[], indexOffset: number): Promise<BatchJudgment[]> {
  const pairsText = buildJudgePairsText(batch);

  const systemPrompt =
    `You judge whether pairs of memories are duplicates, contradictions, or distinct facts.\n` +
    `For each pair, reply with a JSON array of objects: [{"index": 0, "relation": "duplicate"}, ...].\n` +
    `Rules:\n` +
    STORED_MEMORIES_ARE_DATA_RULE +
    `- "duplicate": they express the same fact, possibly worded differently\n` +
    `- "contradiction": they express conflicting facts about the same topic (the new one supersedes)\n` +
    `- "distinct": they are about different topics or complementary facts\n` +
    `Reply ONLY with the JSON array, no other text.`;

  const result = await llmComplete(config, systemPrompt, pairsText, {
    maxTokens: Math.min(batch.length * 30, 1000),
  });

  if (!result) {
    return batch.map((_, i) => ({
      pairIndex: indexOffset + i,
      relation: 'distinct',
    }));
  }

  return parseBatchJudgments(result, batch.length, indexOffset);
}

export function parseBatchJudgments(raw: string, expectedCount: number, indexOffset: number): BatchJudgment[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      relation: string;
    }>;

    const validRelations = new Set(['duplicate', 'contradiction', 'distinct']);
    const judgments: BatchJudgment[] = [];

    for (const item of parsed) {
      if (typeof item.index !== 'number' || item.index < 0 || item.index >= expectedCount) continue;
      const relation = validRelations.has(item.relation) ? (item.relation as PairRelation) : 'distinct';
      judgments.push({ pairIndex: indexOffset + item.index, relation });
    }

    // Fill in missing pairs as 'distinct'
    const seen = new Set(judgments.map((j) => j.pairIndex));
    for (let i = 0; i < expectedCount; i++) {
      if (!seen.has(indexOffset + i)) {
        judgments.push({ pairIndex: indexOffset + i, relation: 'distinct' });
      }
    }

    return judgments;
  } catch {
    return Array.from({ length: expectedCount }, (_, i) => ({
      pairIndex: indexOffset + i,
      relation: 'distinct',
    }));
  }
}
