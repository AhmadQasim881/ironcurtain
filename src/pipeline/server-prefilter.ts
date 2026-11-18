/**
 * Haiku-based server pre-filter for policy compilation.
 *
 * Uses a cheap classification model (Haiku) to determine whether each
 * MCP server can be skipped before invoking the expensive compilation
 * model. If the input text (constitution, task description, or persona
 * definition) has no specific guidance for a server, that server is
 * skipped and default-deny handles all its tools.
 *
 * Decisions are cached per server (`servers/<name>/prefilter-decision.json`
 * in the compile's output directory), keyed by a hash of everything the
 * model sees and the model itself: an unchanged rerun makes no pre-filter
 * call and cannot flip a decision. Failed calls are not cached.
 */

import type { LanguageModel } from 'ai';
import pLimit from 'p-limit';
import { z } from 'zod';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import { generateObjectWithRepair, schemaToPromptHint } from './generate-with-repair.js';
import type { ConstitutionKind } from './pipeline-runner.js';
import { loadExistingArtifact, writeArtifact } from './pipeline-shared.js';
import { serverArtifactDir } from './server-artifacts.js';
import type { ToolAnnotation } from './types.js';

/** Cap concurrent pre-filter LLM calls to avoid rate-limit bursts. */
const PREFILTER_CONCURRENCY = 5;

/** Per-server file holding the last pre-filter decision and the hash of its inputs. */
export const PREFILTER_DECISION_FILE = 'prefilter-decision.json';

/**
 * Part of every pre-filter cache key: bump it to re-evaluate every cached
 * decision when the meaning of a decision changes without its prompt text.
 */
const PREFILTER_CACHE_EPOCH = 1;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const serverRelevanceSchema = z.object({
  skip: z
    .boolean()
    .describe(
      "true if the input text contains no specific guidance that would require or allow any of this server's tools. When in doubt, set to false.",
    ),
  reason: z.string().describe('Brief explanation of why the server is or is not relevant to the input text'),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the pre-filter for a single server. */
export interface PrefilterDecision {
  readonly serverName: string;
  readonly skip: boolean;
  readonly reason: string;
  /** True when the decision was read from the cache instead of asking the model. */
  readonly cached?: boolean;
}

/** Where and under which model identity {@link prefilterServers} caches its decisions. */
export interface PrefilterCacheOptions {
  /** The compile's output directory; decisions go to `servers/<name>/prefilter-decision.json`. */
  readonly outputDir: string;
  /** Identity of the pre-filter model, part of the cache key (e.g. "anthropic:claude-haiku-4-5"). */
  readonly modelId: string;
  /** Ignore cached decisions and ask the model again (the fresh decisions are still stored). */
  readonly refresh?: boolean;
}

/** On-disk shape of {@link PREFILTER_DECISION_FILE}. */
interface StoredPrefilterDecision {
  readonly inputHash: string;
  readonly skip: boolean;
  readonly reason: string;
  readonly decidedAt: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrefilterPrompt(
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  kind: ConstitutionKind,
): string {
  const toolList = tools.map((t) => `- ${t.toolName}: ${t.comment}`).join('\n');

  const taskFraming =
    kind === 'constitution'
      ? `Based ONLY on the user guidance below, determine whether ANY of this server's tools would be specifically allowed or granted special permissions.

The user guidance is relevant to this server if it:
- Mentions the server by name
- Mentions capabilities that map to this server's tools (e.g., "read files" maps to a filesystem server, "search GitHub issues" maps to a GitHub server)
- Grants permissions for operations this server provides

The user guidance is NOT relevant if it:
- Contains no mention of this server's domain of functionality
- Only contains general principles that don't translate to specific allow rules for this server's tools

If the user guidance contains no specific permissions for this server, the server can be safely skipped — a default-deny policy will handle all its tools.`
      : `Based ONLY on the task description below, determine whether accomplishing this task would require ANY of this server's tools.

The task is relevant to this server if it:
- Describes work that directly requires this server's capabilities (e.g., "analyze CSV files" requires filesystem tools, "check open PRs" requires GitHub tools)
- References data, resources, or operations that this server provides access to

The task is NOT relevant to this server if it:
- Describes work entirely outside this server's domain of functionality
- Makes no reference to resources or operations this server provides

If the task does not require any of this server's tools, the server can be safely skipped — a default-deny policy will handle all its tools.`;

  return `You are evaluating whether an input text is relevant to a specific MCP server's tools.

## Server: "${serverName}"

### Available tools:
${toolList}

## Task

${taskFraming}

**Important: When in doubt, set skip to false.** It is better to compile rules unnecessarily than to skip a server that needs them.

Respond with a JSON object: { "skip": boolean, "reason": string }`;
}

// ---------------------------------------------------------------------------
// Decision cache
// ---------------------------------------------------------------------------

/**
 * Cache key of one server's pre-filter decision: the text the model judges,
 * the server's tools (as annotated), the prompt and response schema it is
 * given, and the model. Any change asks the model again.
 */
export function computePrefilterHash(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  kind: ConstitutionKind,
  modelId: string,
): string {
  return canonicalDigest({
    epoch: PREFILTER_CACHE_EPOCH,
    text,
    serverName,
    tools,
    kind,
    modelId,
    system: buildPrefilterPrompt(serverName, tools, kind),
    schema: schemaToPromptHint(serverRelevanceSchema),
  });
}

/** The cached decision for `serverName` when it was made from the inputs hashed to `inputHash`. */
function loadCachedDecision(outputDir: string, serverName: string, inputHash: string): PrefilterDecision | undefined {
  let stored: Partial<StoredPrefilterDecision> | undefined;
  try {
    stored = loadExistingArtifact<Partial<StoredPrefilterDecision>>(
      serverArtifactDir(outputDir, serverName),
      PREFILTER_DECISION_FILE,
    );
  } catch {
    return undefined; // a server name that cannot name a directory has no cache
  }
  if (
    !stored ||
    stored.inputHash !== inputHash ||
    typeof stored.skip !== 'boolean' ||
    typeof stored.reason !== 'string'
  ) {
    return undefined;
  }
  return { serverName, skip: stored.skip, reason: stored.reason, cached: true };
}

/** Stores a decision the model made. Best effort: a failed write only costs a call next time. */
function storeDecision(outputDir: string, decision: PrefilterDecision, inputHash: string): void {
  try {
    writeArtifact(serverArtifactDir(outputDir, decision.serverName), PREFILTER_DECISION_FILE, {
      inputHash,
      skip: decision.skip,
      reason: decision.reason,
      decidedAt: new Date().toISOString(),
    } satisfies StoredPrefilterDecision);
  } catch {
    // Not cached; the next run asks the model again.
  }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/** Asks the model about one server. Throws when the call or its response fails. */
async function classifyServer(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  model: LanguageModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision> {
  const { output } = await generateObjectWithRepair({
    model,
    schema: serverRelevanceSchema,
    system: buildPrefilterPrompt(serverName, tools, kind),
    prompt: text || '(no guidance provided)',
    maxRepairAttempts: 1,
    maxOutputTokens: 256,
  });
  return { serverName, skip: output.skip, reason: output.reason };
}

/** The fail-open decision for a server whose pre-filter call failed. */
function failOpenDecision(serverName: string, err: unknown): PrefilterDecision {
  const message = err instanceof Error ? err.message : String(err);
  return {
    serverName,
    skip: false,
    reason: `Pre-filter error (proceeding with compilation): ${message}`,
  };
}

/**
 * Determines whether a server can be skipped during policy compilation.
 *
 * Errors are caught internally and result in skip: false (fail-open).
 */
export async function checkServerRelevance(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  model: LanguageModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision> {
  try {
    return await classifyServer(text, serverName, tools, model, kind);
  } catch (err) {
    return failOpenDecision(serverName, err);
  }
}

/**
 * Runs the pre-filter for all servers concurrently.
 *
 * Short-circuits when text is empty/whitespace (returns skip: true
 * for all servers without making any LLM calls).
 *
 * With `cache`, a server whose decision was cached for the same inputs (see
 * {@link computePrefilterHash}) is answered from the cache, and every
 * decision the model makes is stored. Fail-open decisions after an error are
 * never stored, so the next run asks again.
 */
export async function prefilterServers(
  text: string,
  servers: Array<[string, ReadonlyArray<ToolAnnotation>]>,
  model: LanguageModel,
  kind: ConstitutionKind,
  cache?: PrefilterCacheOptions,
): Promise<PrefilterDecision[]> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return servers.map(([serverName]) => ({
      serverName,
      skip: true,
      reason: 'No input text provided — all servers skipped by default',
    }));
  }
  const limit = pLimit(PREFILTER_CONCURRENCY);
  return Promise.all(
    servers.map(([serverName, tools]) =>
      limit(async (): Promise<PrefilterDecision> => {
        if (!cache) return checkServerRelevance(trimmed, serverName, tools, model, kind);

        const inputHash = computePrefilterHash(trimmed, serverName, tools, kind, cache.modelId);
        const cached = cache.refresh ? undefined : loadCachedDecision(cache.outputDir, serverName, inputHash);
        if (cached) return cached;

        let decision: PrefilterDecision;
        try {
          decision = await classifyServer(trimmed, serverName, tools, model, kind);
        } catch (err) {
          return failOpenDecision(serverName, err);
        }
        storeDecision(cache.outputDir, decision, inputHash);
        return decision;
      }),
    ),
  );
}
