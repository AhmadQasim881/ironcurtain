/**
 * Multi-turn LLM repair for schema validation failures.
 *
 * Calls `generateText` and validates the response against a Zod schema.
 * On validation failure, feeds the error back to the LLM in a multi-turn
 * conversation so it can fix its output. Up to maxRepairAttempts retries.
 *
 * A response that stopped at its output-token cap (finish reason "length")
 * is not a schema error and is never sent back for repair: asking again
 * under the same cap would truncate it again. It is requested once more with
 * a larger cap ({@link generateWithinOutputCap}); when that is truncated too,
 * the call fails with {@link OutputTruncatedError}.
 *
 * Does NOT use Output.object / structured output because Anthropic's API
 * rejects several JSON Schema constructs that Zod legitimately produces
 * (propertyNames from z.record, oneOf from z.discriminatedUnion).  Instead
 * we rely on prompt instructions for JSON formatting and Zod for validation.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { generateText } from 'ai';
import type { z } from 'zod';

export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Output-token cap of the one retry after a response stopped at its cap.
 * Every pipeline call starts below it (256 to 16384 tokens).
 */
export const TRUNCATION_RETRY_MAX_TOKENS = 32768;

/** Discriminant `code` of {@link OutputTruncatedError}. */
export const OUTPUT_TRUNCATED = 'OUTPUT_TRUNCATED';

/**
 * The model's response did not fit its output-token cap, also after one
 * retry with {@link TRUNCATION_RETRY_MAX_TOKENS}. Reported as itself rather
 * than as the JSON or schema error the cut-off text would cause. Callers in
 * other modules match it by `code`, not `instanceof`.
 */
export class OutputTruncatedError extends Error {
  readonly code = OUTPUT_TRUNCATED;

  constructor(readonly maxOutputTokens: number) {
    super(
      `LLM output truncated at ${maxOutputTokens} tokens: the response did not fit the output-token limit, ` +
        'also after one retry with a larger limit',
    );
    this.name = 'OutputTruncatedError';
  }
}

/** A response and the output-token cap it was produced under. */
export interface CappedResponse<R> {
  readonly result: R;
  readonly maxOutputTokens: number;
}

/**
 * Sends one LLM request, `request(cap)`, under `maxOutputTokens`. When the
 * response stops at the cap (finish reason "length"), the request is sent
 * once more under {@link TRUNCATION_RETRY_MAX_TOKENS}; a second truncation,
 * or a truncation under a cap that is already at least that large, throws
 * {@link OutputTruncatedError}.
 *
 * Returns the cap the response was produced under: a caller that sends a
 * follow-up turn for the same output (a schema repair) starts it there, so
 * an output that needed the larger cap is not cut off again by the smaller.
 */
export async function generateWithinOutputCap<R extends { readonly finishReason: string }>(
  request: (maxOutputTokens: number) => PromiseLike<R>,
  maxOutputTokens: number,
  onProgress?: (message: string) => void,
): Promise<CappedResponse<R>> {
  const result = await request(maxOutputTokens);
  if (result.finishReason !== 'length') return { result, maxOutputTokens };
  if (maxOutputTokens >= TRUNCATION_RETRY_MAX_TOKENS) throw new OutputTruncatedError(maxOutputTokens);

  onProgress?.(`Output truncated at ${maxOutputTokens} tokens; retrying with ${TRUNCATION_RETRY_MAX_TOKENS}...`);
  const retry = await request(TRUNCATION_RETRY_MAX_TOKENS);
  if (retry.finishReason === 'length') throw new OutputTruncatedError(TRUNCATION_RETRY_MAX_TOKENS);
  return { result: retry, maxOutputTokens: TRUNCATION_RETRY_MAX_TOKENS };
}

/** Converts a Zod schema to a JSON Schema string for inclusion in prompts. */
export function schemaToPromptHint(schema: z.ZodType): string {
  try {
    const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any' });
    return `\n\nYour response must be a JSON object matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
  } catch {
    // Some schemas (e.g. with transforms) can't be converted to JSON Schema
    return '\n\nReturn your response as valid JSON.';
  }
}

/**
 * Extracts a JSON object or array from LLM text that may include
 * markdown fences or surrounding prose.
 */
export function extractJson(text: string): string {
  // Try markdown code block first
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlock) return codeBlock[1].trim();

  // Find the outermost { ... } or [ ... ]
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  if (objStart === -1 && arrStart === -1) return text;

  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = text.lastIndexOf(closeChar);
  if (end === -1) return text;

  return text.slice(start, end + 1);
}

/**
 * Extracts and validates JSON from LLM text output against a Zod schema.
 * Handles markdown fences, surrounding prose, and schema validation.
 *
 * Exported for reuse by callers that manage their own message history
 * but need the same extraction+validation logic.
 */
export function parseJsonWithSchema<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  const json: unknown = JSON.parse(extractJson(text));
  return schema.parse(json);
}

interface GenerateObjectWithRepairOptions<T extends z.ZodType> {
  model: LanguageModel;
  schema: T;
  system?: string | SystemModelMessage;
  prompt: string;
  maxRepairAttempts?: number;
  maxOutputTokens?: number;
  /** Sampling temperature; the provider's default when absent. */
  temperature?: number;
  onProgress?: (message: string) => void;
}

export async function generateObjectWithRepair<T extends z.ZodType>({
  model,
  schema,
  system,
  prompt,
  maxRepairAttempts = 2,
  maxOutputTokens = DEFAULT_MAX_TOKENS,
  temperature,
  onProgress,
}: GenerateObjectWithRepairOptions<T>): Promise<{ output: z.infer<T>; repairAttempts: number }> {
  const promptWithSchema = prompt + schemaToPromptHint(schema);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: promptWithSchema },
  ];
  // Raised for the rest of the exchange once a response needed the larger cap.
  let outputCap = maxOutputTokens;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    if (attempt > 0) {
      onProgress?.(`Schema repair ${attempt}/${maxRepairAttempts}...`);
    }

    const { result, maxOutputTokens: usedCap } = await generateWithinOutputCap(
      (cap) =>
        system
          ? generateText({ model, system, messages, maxOutputTokens: cap, temperature })
          : generateText({ model, messages, maxOutputTokens: cap, temperature }),
      outputCap,
      onProgress,
    );
    outputCap = usedCap;

    const text = result.text;

    try {
      const parsed = parseJsonWithSchema(text, schema);
      return { output: parsed, repairAttempts: attempt };
    } catch (error) {
      if (attempt === maxRepairAttempts) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      messages.push(
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `Your response failed schema validation:\n${errorMessage}\n\nPlease fix the errors and return valid JSON matching the schema.`,
        },
      );
    }
  }

  // Should never reach here due to the throw in the loop
  throw new Error('generateObjectWithRepair: exhausted all repair attempts');
}
