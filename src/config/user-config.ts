/**
 * User configuration file management.
 *
 * Loads, validates, and provides defaults for ~/.ironcurtain/config.json.
 * All fields are optional in the file; missing fields use defaults.
 * Environment variables override config file values.
 */

import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { PRIVATE_FILE_MODE, writePrivateFileAtomicSync } from '../util/atomic-write.js';
import { withFileLockSync } from '../util/file-lock.js';
import { getIronCurtainHome, getUserConfigPath } from './paths.js';
import { EXTENDED_CREDENTIAL_STORE_IDS, isAcceptedExtraProtectedPath } from './credential-stores.js';
import type { ExtendedCredentialStoreId } from './credential-stores.js';
import { KNOWN_PROVIDER_IDS, nearMissProviderPrefix, parseModelId } from './model-id.js';
import {
  GLM_DEFAULT_MODEL,
  getGatewayDefinition,
  getProviderEditorDescriptors,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_FLASH_MODEL,
  OPENROUTER_DEFAULT_MAP,
  providerDefaultMap,
} from './provider-definitions.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import { canonicalEgressHostPattern, EGRESS_HOST_PATTERN_RULE } from '../net/egress-host-pattern.js';
import { memoryLlmBaseUrlProblem } from '../memory/memory-llm.js';
import { closestMatch } from '../utils/edit-distance.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { findUnknownKeys } from './unknown-config-keys.js';
import type { ModelPricingOverrides } from '../llm-metrics/pricing.js';
import { TAINT_TOOL_CLASSES, TAINT_TOOL_KEY_PATTERN, type TaintToolClass } from '../types/taint.js';
import {
  dockerWorkloadRequestedSchema,
  resolveDockerWorkloadConfig,
  type DockerWorkloadRequestedConfig,
  type ResolvedDockerWorkloadConfig,
} from '../docker-workload/config.js';
import {
  SANDBOX_POLICIES,
  defaultSandboxPolicy,
  readSandboxPolicyEnv,
  type SandboxAvailabilityPolicy,
} from './sandbox-policy.js';
import { SIGNAL_DEFAULT_IMAGE } from '../signal/signal-image.js';
import { AGENT_CLI_VERSION_OVERRIDE_PATTERN, type AgentCliVersionOverrides } from '../docker/agent-cli-version.js';

export const USER_CONFIG_DEFAULTS = {
  agentModelId: 'anthropic:claude-sonnet-4-6',
  policyModelId: 'anthropic:claude-sonnet-4-6',
  prefilterModelId: 'anthropic:claude-haiku-4-5',
  escalationTimeoutSeconds: 300,
  resourceBudget: {
    maxTotalTokens: 1_000_000,
    maxSteps: 200,
    maxSessionSeconds: 1800,
    maxEstimatedCostUsd: 5.0,
    warnThresholdPercent: 80,
  },
  autoCompact: {
    enabled: true,
    thresholdTokens: 160_000,
    keepRecentMessages: 10,
    summaryModelId: 'anthropic:claude-haiku-4-5',
  },
  autoApprove: {
    enabled: false,
    modelId: 'anthropic:claude-haiku-4-5',
  },
  auditRedaction: {
    enabled: true,
  },
  observability: {
    /**
     * What a session's LLM interaction logs record: sizes, timings and token
     * counts, never prompt or response text. See LLM_INTERACTION_LOG_MODES.
     */
    llmInteractionLog: 'metadata',
  },
  contentAssessment: {
    /** Opt-in: check the outbound content of calls allowed subject to assessment (`assess` rules) and of escalated calls. */
    enabled: false,
    /** Separate opt-in: also ask a cheap model whether content that passed is intelligible. */
    llmCheck: false,
    llmModelId: 'anthropic:claude-haiku-4-5',
  },
  preferredMode: 'container',
  dockerResources: {
    /** Memory ceiling in MB; null means "do not pass --memory". */
    memoryMb: 8192,
    /** CPU ceiling (fractional ok); null means "do not pass --cpus". */
    cpus: 4,
    /**
     * cgroup process ceiling (`--pids-limit`); null means "do not pass the
     * flag". Bounds fork bombs per container; Node toolchains count every
     * thread, so the default leaves room for parallel test runners and builds.
     */
    pidsLimit: 4096,
  },
  /**
   * Workflow agent environments alive at once in one process (the daemon,
   * or one CLI workflow run): a shared-container bundle counts once however
   * many agents run in it, every other workflow agent session counts once.
   * Further ones wait for a free slot. See src/workflow/agent-slot-pool.ts.
   */
  maxConcurrentAgentSessions: 4,
  snapshot: {
    enabled: true,
    maxAgeDays: 7,
    sweepIntervalHours: 24,
    /**
     * Per-snapshot size cap in bytes (the container's full filesystem, which
     * is what a flattened snapshot exports); null means no cap. A free-space
     * check runs before every commit regardless.
     */
    maxBytes: null,
  },
  statistics: {
    enabled: true,
    retentionDays: 90,
  },
} as const;

export const ESCALATION_TIMEOUT_MIN = 30;
export const ESCALATION_TIMEOUT_MAX = 600;

/** Upper bound for `maxConcurrentAgentSessions`: well past what one host's Docker networks and RAM sustain. */
export const MAX_CONCURRENT_AGENT_SESSIONS_LIMIT = 64;

export const resourceBudgetFieldsSchema = z.object({
  maxTotalTokens: z.number().int().positive().nullable().optional(),
  maxSteps: z.number().int().positive().nullable().optional(),
  maxSessionSeconds: z.number().positive().nullable().optional(),
  maxEstimatedCostUsd: z.number().positive().nullable().optional(),
  warnThresholdPercent: z.number().min(1).max(99).optional(),
});

/**
 * One `resourceBudget.modelPricing` entry: list prices in USD per million
 * tokens for host-side cost estimates (see src/llm-metrics/pricing.ts).
 * Omitted cache rates default to the full input rate for reads and to
 * 1.25x / 2x input for 5-minute / 1-hour cache writes.
 */
const modelPricingOverrideSchema = z
  .object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cacheReadPerMillion: z.number().nonnegative().optional(),
    cacheWrite5mPerMillion: z.number().nonnegative().optional(),
    cacheWrite1hPerMillion: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * Per-model price overrides keyed by model id. Keys are normalized like the
 * built-in table, so "anthropic:claude-opus-5-5" and "claude-opus-5-5" name
 * the same model. Only the user config file carries it: workflow settings
 * and the web UI limits editor use `resourceBudgetFieldsSchema`, which does
 * not include prices.
 */
const modelPricingOverridesSchema = z.record(z.string().min(1), modelPricingOverrideSchema);

const resourceBudgetSchema = resourceBudgetFieldsSchema
  .extend({ modelPricing: modelPricingOverridesSchema.optional() })
  .optional();

/** Smallest accepted `dockerResources.pidsLimit`: an agent needs its shell, the CLI and a few helpers. */
export const DOCKER_MIN_PIDS_LIMIT = 16;

/**
 * Docker container resource ceilings. All fields are independently nullable:
 *   - `number` = pass `--memory <N>m` / `--cpus <N>` / `--pids-limit <N>`
 *                (memory and cpus subject to clamping)
 *   - `null`   = explicitly no limit, do not emit the flag
 *   - missing  = fall through to USER_CONFIG_DEFAULTS.dockerResources
 *
 * Memory is bounded below at 6 MB (Docker's own minimum); CPUs is bounded
 * below at 0.01 (Docker's own minimum); the pids ceiling at
 * `DOCKER_MIN_PIDS_LIMIT`. Upper bounds for memory and cpus are enforced at
 * runtime by `clampDockerResources()` against the host's actual capacity.
 */
const dockerResourcesSchema = z
  .object({
    memoryMb: z.number().int().min(6).nullable().optional(),
    cpus: z.number().min(0.01).nullable().optional(),
    pidsLimit: z.number().int().min(DOCKER_MIN_PIDS_LIMIT).nullable().optional(),
  })
  .optional();

/**
 * Shared scaffold for the two model-ID validators below. Both accept strings
 * that `parseModelId()` handles, and both reject a prefix that is a near miss
 * of a provider name ("anthropc:claude-x", "opnai:gpt-5", "Google:gemini"),
 * naming the provider it resembles: `parseModelId()` would otherwise route
 * such an ID to the default provider as an opaque model name, and the mistake
 * would surface only as a provider error mid-session. Strict mode additionally
 * rejects every other value where a colon is present but the prefix is not a
 * known provider.
 */
function createModelIdSchema(options: { readonly strict: boolean; readonly message: string }): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .superRefine((val, ctx) => {
      const nearMiss = nearMissProviderPrefix(val);
      if (nearMiss !== undefined) {
        const prefix = val.slice(0, val.indexOf(':'));
        ctx.addIssue({
          code: 'custom',
          message:
            `Unknown model provider "${prefix}" in "${val}": did you mean "${nearMiss}"? ` +
            `Known providers: ${KNOWN_PROVIDER_IDS.join(', ')}.`,
        });
        return;
      }
      if (!isAcceptedModelId(val, options.strict)) ctx.addIssue({ code: 'custom', message: options.message });
    });
}

function isAcceptedModelId(val: string, strict: boolean): boolean {
  // Reject malformed colon shapes ":tag" and "name:" — these otherwise
  // slip through parseModelId's unknown-prefix fallthrough as opaque IDs.
  if (val.startsWith(':') || val.endsWith(':')) return false;
  try {
    const { modelId } = parseModelId(val);
    return !(strict && val.includes(':') && val === modelId);
  } catch {
    return false;
  }
}

/**
 * Strict model ID validator for `~/.ironcurtain/config.json`. A colon-prefixed
 * value must name a known provider; bare names are accepted.
 */
export const qualifiedModelId = createModelIdSchema({
  strict: true,
  message:
    'Model ID must be "model-name" or "provider:model-name" ' + 'where provider is one of: anthropic, google, openai',
});

/**
 * Looser model ID validator for workflow YAML. Additionally accepts
 * Ollama-style "name:tag" identifiers (e.g. `glm-5.1:cloud`) reached via
 * an upstream gateway like ANTHROPIC_BASE_URL.
 */
export const looseModelId = createModelIdSchema({
  strict: false,
  message:
    'Model ID must be "model-name", "provider:model-name" ' +
    '(provider: anthropic, google, openai), or an Ollama-style "name:tag" bare model ID',
});

const autoCompactSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdTokens: z.number().int().positive().optional(),
    keepRecentMessages: z.number().int().positive().optional(),
    summaryModelId: qualifiedModelId.optional(),
  })
  .optional();

const autoApproveSchema = z
  .object({
    enabled: z.boolean().optional(),
    modelId: qualifiedModelId.optional(),
  })
  .optional();

const auditRedactionSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();

/**
 * Values of `observability.llmInteractionLog`, what a session records about
 * each call to an LLM it makes itself (the builtin agent, the auto-approver)
 * in `llm-interactions.jsonl` and `auto-approve-llm.jsonl`:
 *   - 'off':      nothing; the log files are not created.
 *   - 'metadata': timing, token usage, finish reason, message counts, sizes
 *                 and error classes; no prompt, response or error text.
 *   - 'full':     the prompts and responses as well, passed through the audit
 *                 redactor first unless `auditRedaction.enabled` is false.
 */
export const LLM_INTERACTION_LOG_MODES = ['off', 'metadata', 'full'] as const;
export type LlmInteractionLogMode = (typeof LLM_INTERACTION_LOG_MODES)[number];

const observabilitySchema = z
  .object({
    llmInteractionLog: z.enum(LLM_INTERACTION_LOG_MODES).optional(),
  })
  .optional();

/**
 * Outbound content assessment (src/trusted-process/assessment.ts). Both
 * checks are opt-in: `enabled` turns on the deterministic checks for the
 * outbound content of calls an `assess` rule allows and of escalated calls;
 * `llmCheck` additionally runs the intelligibility check with `llmModelId`
 * and only takes effect when `enabled` is true. Strict, so a misspelled key
 * fails loudly instead of leaving the checks off.
 */
const contentAssessmentSchema = z
  .object({
    enabled: z.boolean().optional(),
    llmCheck: z.boolean().optional(),
    llmModelId: qualifiedModelId.optional(),
  })
  .strict()
  .optional();

const memorySchema = z
  .object({
    enabled: z.boolean().optional(),
    autoSave: z.boolean().optional(),
    // https, or plain http to this machine only: the memory server sends memory
    // content (and any key) to this endpoint (see src/memory/memory-llm.ts).
    llmBaseUrl: z
      .url()
      .superRefine((url, ctx) => {
        const problem = memoryLlmBaseUrlProblem(url);
        if (problem !== undefined) ctx.addIssue({ code: 'custom', message: `memory.llmBaseUrl ${problem}` });
      })
      .optional(),
    llmApiKey: z.string().min(1).optional(),
    // Never let the memory server download its models: they must already be in
    // ~/.ironcurtain/models (`ironcurtain memory prefetch` fills it).
    offlineModels: z.boolean().optional(),
  })
  .optional();

/**
 * Trajectory-capture config (MITM HTTP exchange recording). Opt-in
 * only; absent in USER_CONFIG_DEFAULTS so the `?? false` in the
 * resolver is authoritative. See
 * docs/designs/mitm-token-trajectory-capture.md §10.
 */
const captureSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();

/** Content-free MITM usage statistics. Local persistence is enabled by default. */
const statisticsSchema = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().positive().nullable().optional(),
  })
  .optional();

const snapshotSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().positive().nullable().optional(),
    sweepIntervalHours: z.number().positive().optional(),
    maxBytes: z.number().int().positive().nullable().optional(),
  })
  .optional();

/**
 * Daemon cron scheduling. `maxConcurrentRuns`: most job runs the scheduler
 * starts at once (null or absent: no limit); a scheduled run beyond it
 * waits for a run to finish. `catchUpMissedRuns`: run a job once when the
 * daemon notices it missed a fire time (the machine slept, the daemon was
 * blocked); off by default, as in standard cron.
 */
const cronSchema = z
  .object({
    maxConcurrentRuns: z.number().int().positive().nullable().optional(),
    catchUpMissedRuns: z.boolean().optional(),
  })
  .optional();

/** Resolved `cron` settings (see the schema). */
export interface ResolvedCronConfig {
  /** Null means no limit. */
  readonly maxConcurrentRuns: number | null;
  readonly catchUpMissedRuns: boolean;
}

/** Defaults of the `cron` settings: no run limit, missed runs are not caught up. */
export const CRON_CONFIG_DEFAULTS: ResolvedCronConfig = { maxConcurrentRuns: null, catchUpMissedRuns: false };

const agentCliVersionOverride = z
  .string()
  .regex(
    AGENT_CLI_VERSION_OVERRIDE_PATTERN,
    'must be "latest" or an exact version such as 2.1.292 (a prerelease suffix like -beta.1 is allowed)',
  );

/**
 * Agent CLI version overrides. Absent (the default): each Docker agent image
 * installs the CLI version its Dockerfile pins, the version qualified with
 * this IronCurtain release. An exact version or `latest` builds the image with
 * that CLI instead; see `src/docker/agent-cli-version.ts`.
 */
const agentCliVersionsSchema = z
  .object({
    'claude-code': agentCliVersionOverride.optional(),
    codex: agentCliVersionOverride.optional(),
  })
  .strict()
  .optional();

/**
 * Persona lifecycle. `trashRetentionDays`: how long a soft-deleted persona
 * (a web UI delete, or the persona a forced `persona trash restore`
 * replaced) stays in `~/.ironcurtain/.persona-trash/` before it is purged,
 * workspace and memory included; null keeps entries until they are purged
 * by hand (`ironcurtain persona trash purge`). Expired entries are purged
 * whenever a persona is moved to the trash, and by
 * `ironcurtain persona trash purge --expired`.
 */
const personasSchema = z
  .object({
    trashRetentionDays: z.number().int().positive().nullable().optional(),
  })
  .optional();

/** Resolved `personas` settings (see the schema). */
export interface ResolvedPersonasConfig {
  /** Null means entries are kept until purged by hand. */
  readonly trashRetentionDays: number | null;
}

/** Defaults of the `personas` settings: trash entries are kept for 30 days. */
export const PERSONAS_CONFIG_DEFAULTS: ResolvedPersonasConfig = { trashRetentionDays: 30 };

/** Longest `retention.autoPruneIntervalHours`: a year. */
export const MAX_AUTO_PRUNE_INTERVAL_HOURS = 24 * 366;

/** Smallest `retention.logs.maxBytes`: 64 KiB, so a rotation never runs every few lines. */
export const MIN_LOG_ROTATION_BYTES = 64 * 1024;

/** Most rotated log files `retention.logs.maxFiles` may keep. */
export const MAX_LOG_ROTATION_FILES = 20;

/**
 * What `ironcurtain prune` (and, with `autoPrune`, the daemon) removes from
 * the IronCurtain home. Every limit takes null for "keep forever". See
 * `src/maintenance/prune.ts` and docs/designs/retention-and-prune.md.
 *
 * - `sessions` / `workflowRuns`: `maxAgeDays` removes a session directory or
 *   workflow run directory inactive for longer; `maxBytes` then removes the
 *   oldest ones while the category is larger. Live sessions and runs, a
 *   directory holding a workspace something else still uses, and anything
 *   active within the last day (whatever the limits) are never removed.
 * - `jobRuns.maxRecords`: run records kept per cron job (the newest ones).
 * - `dependencyCaches.maxUnusedDays`: a shared workflow dependency base not
 *   used for longer is removed (rebuilt on the next run that needs it).
 * - `logs`: size-based rotation of the daemon's and the Signal bot's own logs
 *   (`maxBytes` per file, `maxFiles` rotated copies kept); on by default.
 * - `autoPrune`: the daemon prunes at start and every
 *   `autoPruneIntervalHours`. Off by default: without it nothing is removed
 *   until `ironcurtain prune` is run.
 */
const retentionAgeSchema = z.number().positive().nullable().optional();
const retentionBytesSchema = z.number().int().positive().nullable().optional();
const retentionSchema = z
  .object({
    autoPrune: z.boolean().optional(),
    autoPruneIntervalHours: z.number().positive().max(MAX_AUTO_PRUNE_INTERVAL_HOURS).optional(),
    sessions: z.object({ maxAgeDays: retentionAgeSchema, maxBytes: retentionBytesSchema }).optional(),
    workflowRuns: z.object({ maxAgeDays: retentionAgeSchema, maxBytes: retentionBytesSchema }).optional(),
    jobRuns: z.object({ maxRecords: z.number().int().positive().nullable().optional() }).optional(),
    dependencyCaches: z.object({ maxUnusedDays: retentionAgeSchema }).optional(),
    logs: z
      .object({
        maxBytes: z.number().int().min(MIN_LOG_ROTATION_BYTES).nullable().optional(),
        maxFiles: z.number().int().min(1).max(MAX_LOG_ROTATION_FILES).optional(),
      })
      .optional(),
  })
  .optional();

/** Age and size limits of one pruned category (null: no limit). */
export interface ResolvedRetentionLimits {
  readonly maxAgeDays: number | null;
  readonly maxBytes: number | null;
}

/** Resolved `retention` settings (see the schema). */
export interface ResolvedRetentionConfig {
  readonly autoPrune: boolean;
  readonly autoPruneIntervalHours: number;
  readonly sessions: ResolvedRetentionLimits;
  readonly workflowRuns: ResolvedRetentionLimits;
  readonly jobRuns: { readonly maxRecords: number | null };
  readonly dependencyCaches: { readonly maxUnusedDays: number | null };
  readonly logs: { readonly maxBytes: number | null; readonly maxFiles: number };
}

/**
 * Defaults of the `retention` settings: sessions and workflow runs inactive
 * for 30 days, the newest 200 run records per job, dependency caches unused
 * for 14 days; daemon logs rotate at 10 MiB keeping 3 copies. Nothing is
 * pruned automatically unless `autoPrune` is set.
 */
export const RETENTION_CONFIG_DEFAULTS: ResolvedRetentionConfig = {
  autoPrune: false,
  autoPruneIntervalHours: 24,
  sessions: { maxAgeDays: 30, maxBytes: null },
  workflowRuns: { maxAgeDays: 30, maxBytes: null },
  jobRuns: { maxRecords: 200 },
  dependencyCaches: { maxUnusedDays: 14 },
  logs: { maxBytes: 10 * 1024 * 1024, maxFiles: 3 },
};

/** `value` unless it is undefined (null is kept: it means "no limit"). */
function orDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** Resolves the `retention` section of a parsed config against {@link RETENTION_CONFIG_DEFAULTS}. */
export function resolveRetentionConfig(input: z.infer<typeof retentionSchema>): ResolvedRetentionConfig {
  const defaults = RETENTION_CONFIG_DEFAULTS;
  return {
    autoPrune: input?.autoPrune ?? defaults.autoPrune,
    autoPruneIntervalHours: input?.autoPruneIntervalHours ?? defaults.autoPruneIntervalHours,
    sessions: {
      maxAgeDays: orDefault(input?.sessions?.maxAgeDays, defaults.sessions.maxAgeDays),
      maxBytes: orDefault(input?.sessions?.maxBytes, defaults.sessions.maxBytes),
    },
    workflowRuns: {
      maxAgeDays: orDefault(input?.workflowRuns?.maxAgeDays, defaults.workflowRuns.maxAgeDays),
      maxBytes: orDefault(input?.workflowRuns?.maxBytes, defaults.workflowRuns.maxBytes),
    },
    jobRuns: { maxRecords: orDefault(input?.jobRuns?.maxRecords, defaults.jobRuns.maxRecords) },
    dependencyCaches: {
      maxUnusedDays: orDefault(input?.dependencyCaches?.maxUnusedDays, defaults.dependencyCaches.maxUnusedDays),
    },
    logs: {
      maxBytes: orDefault(input?.logs?.maxBytes, defaults.logs.maxBytes),
      maxFiles: input?.logs?.maxFiles ?? defaults.logs.maxFiles,
    },
  };
}

export const WEB_SEARCH_PROVIDERS = ['brave', 'tavily', 'serpapi'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/** Human-readable labels for web search providers. */
export const WEB_SEARCH_PROVIDER_LABELS: Readonly<Record<WebSearchProvider, string>> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  serpapi: 'SerpAPI',
};

/** Signup URLs for web search providers. */
export const WEB_SEARCH_PROVIDER_URLS: Readonly<Record<WebSearchProvider, string>> = {
  brave: 'https://brave.com/search/api/',
  tavily: 'https://tavily.com/',
  serpapi: 'https://serpapi.com/',
};

const webSearchSchema = z
  .object({
    provider: z.enum(WEB_SEARCH_PROVIDERS).optional(),
    brave: z.object({ apiKey: z.string().min(1) }).optional(),
    tavily: z.object({ apiKey: z.string().min(1) }).optional(),
    serpapi: z.object({ apiKey: z.string().min(1) }).optional(),
  })
  .optional();

/**
 * Fetch MCP server settings. `allowPrivateNetworks` (default false) lets
 * `http_fetch` reach private and loopback destinations that the requested,
 * policy-evaluated URL names literally (a private IP literal or `localhost`).
 * Either way, link-local/metadata destinations and names whose DNS answers
 * are private stay blocked, and a redirect never moves a fetch to another
 * origin (see src/servers/guarded-fetch.ts). Deliberately absent from
 * USER_CONFIG_DEFAULTS so it is never backfilled into the file.
 */
const fetchSchema = z
  .object({
    allowPrivateNetworks: z.boolean().optional(),
  })
  .optional();

/**
 * What policy loaders do with a compiled policy whose provenance says it may
 * be stale (built by another policy-compiler epoch or for other policy-engine
 * semantics, against other tool annotations, or by a version that recorded no
 * provenance; see src/policy-artifacts/provenance.ts): `warn` (default) prints
 * a warning and uses it, `refuse` fails session start and policy hot-swaps.
 */
export const POLICY_ON_STALE_MODES = ['warn', 'refuse'] as const;
export type PolicyOnStale = (typeof POLICY_ON_STALE_MODES)[number];

/**
 * Compiled-policy settings. Strict so a misspelled key fails loudly instead
 * of silently keeping the default. Deliberately absent from
 * USER_CONFIG_DEFAULTS so it is never backfilled into the file.
 */
const policySchema = z
  .object({
    onStale: z.enum(POLICY_ON_STALE_MODES).optional(),
  })
  .strict()
  .optional();

/**
 * Sequence-aware (taint) escalation, opt-in. Once the agent has read content
 * other people wrote (a taint source), every call to an outbound tool (a
 * taint sink: send, post, push, share) needs a human for the rest of the
 * session. `tools` reclassifies tools: `"server/tool"` or `"server/*"` ->
 * `source` | `sink` | `both` | `none`. Strict, so a misspelled field is an
 * error rather than a protection silently left off. Deliberately not in
 * USER_CONFIG_DEFAULTS: absent means disabled, nothing is backfilled. See
 * docs/designs/sequence-aware-policy.md for the default classification.
 */
const taintEscalationSchema = z
  .object({
    enabled: z.boolean().optional(),
    tools: z
      .record(
        z.string().regex(TAINT_TOOL_KEY_PATTERN, 'Keys must be "server/tool" or "server/*"'),
        z.enum(TAINT_TOOL_CLASSES),
      )
      .optional(),
  })
  .strict()
  .optional();

/**
 * Policy-evaluated MITM egress (opt-in, default off; see
 * docs/designs/mitm-egress-policy.md). When `enabled`, the MITM proxy asks
 * the session's policy engine about every destination that is not a
 * configured LLM provider or package registry: a CONNECT tunnel at host:port,
 * a plain-HTTP request at path granularity. Hosts matching `allowedHosts`
 * ("*", "*.example.com", "registry.example.com") are admitted; any other
 * host escalates to a human once per host and port. Every decision is
 * audited. Only ports 443 and 80 are admitted, and IP-literal destinations
 * never are. Supersedes the deprecated IRONCURTAIN_MITM_ALLOW_ALL_HOSTS
 * variable, which is ignored while this is enabled. Strict, so a misspelled
 * key fails loudly instead of silently leaving egress unevaluated.
 * Deliberately absent from USER_CONFIG_DEFAULTS so it is never backfilled.
 */
const egressPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => canonicalEgressHostPattern(value) !== undefined, EGRESS_HOST_PATTERN_RULE),
      )
      .optional(),
  })
  .strict()
  .optional();

const packageInstallSchema = z
  .object({
    enabled: z.boolean().optional(),
    quarantineDays: z.number().int().min(0).optional(),
    allowedPackages: z.array(z.string().min(1)).optional(),
    deniedPackages: z.array(z.string().min(1)).optional(),
  })
  .optional();

/**
 * Host credential stores agents can never read or write (protected paths).
 * The core stores IronCurtain itself uses are always protected and cannot be
 * listed in `disabledStores`; see src/config/credential-stores.ts. Strict so a
 * misspelled key fails loudly instead of silently dropping protection.
 */
const credentialProtectionSchema = z
  .object({
    extraPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            isAcceptedExtraProtectedPath,
            'must be an absolute path or start with ~/ (relative paths are rejected)',
          ),
      )
      .optional(),
    disabledStores: z.array(z.enum(EXTENDED_CREDENTIAL_STORE_IDS)).optional(),
  })
  .strict()
  .optional();

const signalContainerSchema = z
  .object({
    /**
     * The authenticated TLS bridge image: a locally built default, or a published
     * `<repository>@sha256:<digest>` (what
     * `setup-signal --update-image` records) or a tag, which is used only as
     * already present locally (see src/signal/signal-image.ts).
     */
    image: z.string().min(1).optional(),
    port: z.number().int().min(1024).max(65535).optional(),
  })
  .optional();

const signalSchema = z
  .object({
    botNumber: z
      .string()
      .regex(/^\+\d{7,15}$/, 'Must be E.164 format: +<country><number>')
      .optional(),
    recipientNumber: z
      .string()
      .regex(/^\+\d{7,15}$/, 'Must be E.164 format: +<country><number>')
      .optional(),
    recipientIdentityKey: z.string().min(1).optional(),
    /** Account UUID signal-cli lists for the stored identity key (captured at setup). */
    recipientUuid: z.string().min(1).max(128).optional(),
    container: signalContainerSchema,
    maxConcurrentSessions: z.number().int().min(1).max(10).optional(),
  })
  .optional();

/**
 * Zod schema for validating user config. All fields optional.
 * Validates types and constraints without applying defaults --
 * defaults are merged separately so we can distinguish "missing" from "present".
 */
export const GOOSE_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
/** Goose provider — structurally identical to ProviderId from model-provider.ts. */
export type GooseProvider = (typeof GOOSE_PROVIDERS)[number];

export const DOCKER_AGENTS = ['claude-code', 'goose', 'codex'] as const;
export type DockerAgent = (typeof DOCKER_AGENTS)[number];

export const SESSION_MODES = ['container', 'builtin'] as const;
export type SessionModeKind = (typeof SESSION_MODES)[number];

const preferredModeSchema = z.preprocess((value) => (value === 'docker' ? 'container' : value), z.enum(SESSION_MODES));

/**
 * Container runtime backend for Container mode sessions. 'auto'
 * prefers the Apple container runtime when its preflight passes
 * (Apple silicon, macOS 26+, container CLI >= 1.0 with services
 * running) and falls back to Docker otherwise. The
 * IRONCURTAIN_CONTAINER_RUNTIME env var overrides this setting.
 * See docs/designs/apple-container-runtime.md.
 */
export const CONTAINER_RUNTIMES = ['auto', 'docker', 'apple-container'] as const;
export type ContainerRuntimeSetting = (typeof CONTAINER_RUNTIMES)[number];

// --- OpenRouter provider-profile registry (see docs/designs/openrouter-integration.md §6) ---

/** OpenRouter host (single host serving all three agent wire formats). */
export const OPENROUTER_HOST = getGatewayDefinition('openrouter').host;
/** Claude Code `ANTHROPIC_BASE_URL` when routing through OpenRouter. */
export const OPENROUTER_BASE_URL = getGatewayDefinition('openrouter').baseUrls({ type: 'openrouter' }).messages;
/** Codex/Goose `base_url` when routing through OpenRouter. */
export const OPENROUTER_API_V1 = getGatewayDefinition('openrouter').baseUrls({ type: 'openrouter' }).responses;
/** Default GLM slug used when no per-agent / glob mapping resolves (D2). */
export const DEFAULT_GLM_SLUG = OPENROUTER_DEFAULT_MODEL;
export const DEFAULT_GLM_FLASH_SLUG = OPENROUTER_FLASH_MODEL;

/** The implicit, always-present profile name. Reserved: users may not define it. */
export const NATIVE_PROFILE_NAME = 'native';

/**
 * Out-of-box glob→slug mapping applied when an openrouter profile omits
 * `modelMap`. Maps the canonical Anthropic tiers to GLM (D3 quickstart). An
 * explicit `modelMap: []` is preserved and disables glob mapping (per-agent
 * only mode).
 */
export const DEFAULT_MODEL_MAP = OPENROUTER_DEFAULT_MAP;

/** A single ordered glob→slug mapping rule. First match wins. */
const modelMapRuleSchema = z.object({
  /** Glob matched (case-insensitively) against the REQUESTED model id. `*` = any run of chars. */
  match: z.string().min(1),
  /** Provider model ID to route to, e.g. "z-ai/glm-5.3-flash". */
  model: z.string().min(1),
});

/** Provider-preference passthrough for cache pinning (OpenRouter `provider` body field). */
const providerPreferenceSchema = z
  .object({
    /** Ordered provider slugs to try, e.g. ["z-ai"]. */
    order: z.array(z.string().min(1)).optional(),
    /** Restrict routing to exactly these provider slugs. */
    only: z.array(z.string().min(1)).optional(),
    /** Allow OpenRouter to fall back to other providers. Default true. */
    allowFallbacks: z.boolean().optional(),
  })
  .optional();

/** An openrouter-type profile: EXACTLY v2's `openrouter` section fields, sans `enabled`. */
const openrouterProfileSchema = z.object({
  type: z.literal('openrouter'),
  /** OpenRouter API key (sk-or-v1-...). Env OPENROUTER_API_KEY takes precedence. Sensitive. */
  apiKey: z.string().min(1).optional(),
  /** Ordered glob→slug rules; first match wins. */
  modelMap: z.array(modelMapRuleSchema).optional(),
  /** Per-agent model override. WINS over modelMap for that agent (D1 precedence). */
  perAgent: z
    .object({
      'claude-code': z.string().min(1).optional(),
      goose: z.string().min(1).optional(),
      codex: z.string().min(1).optional(),
    })
    .optional(),
  /** Provider-preference passthrough (cache pinning). */
  providerPreference: providerPreferenceSchema,
  /** Inject a stable top-level session_id for GLM cache affinity. Default true. */
  sessionAffinity: z.boolean().optional(),
});

const zaiProfileSchema = z.object({
  type: z.literal('zai'),
  apiKey: z.string().min(1).optional(),
  plan: z.enum(['api', 'coding']).optional(),
  model: z.string().min(1).optional(),
  modelMap: z.array(modelMapRuleSchema).optional(),
  perAgent: openrouterProfileSchema.shape.perAgent,
});

export const HOST_MODEL_ROLES = [
  'agent',
  'policy',
  'prefilter',
  'summary',
  'autoApprove',
  'contentAssessment',
] as const;
export type HostModelRole = (typeof HOST_MODEL_ROLES)[number];

/** The config fields that hold each host role's model ID. */
export type HostRoleModelFields = Pick<
  ResolvedUserConfig,
  'agentModelId' | 'policyModelId' | 'prefilterModelId' | 'autoCompact' | 'autoApprove' | 'contentAssessment'
>;

/**
 * The model ID a host role requests: its own field of the resolved config
 * (for `contentAssessment`, the intelligibility check's `llmModelId`, at its
 * default when a hand-built config has no `contentAssessment` section).
 */
export function hostRoleModelId(config: HostRoleModelFields, role: HostModelRole): string {
  switch (role) {
    case 'agent':
      return config.agentModelId;
    case 'policy':
      return config.policyModelId;
    case 'prefilter':
      return config.prefilterModelId;
    case 'summary':
      return config.autoCompact.summaryModelId;
    case 'autoApprove':
      return config.autoApprove.modelId;
    case 'contentAssessment':
      return config.contentAssessment?.llmModelId ?? USER_CONFIG_DEFAULTS.contentAssessment.llmModelId;
  }
}
const hostModelProfilesSchema = z.partialRecord(z.enum(HOST_MODEL_ROLES), z.string().min(1));

/** A native-type profile: today's canonical Anthropic/OpenAI/ChatGPT routing. No fields. */
const nativeProfileSchema = z.object({ type: z.literal('native') });

/** v1 profile union. New provider types extend this discriminator (§16). */
export const providerProfileSchema = z.discriminatedUnion('type', [
  nativeProfileSchema,
  openrouterProfileSchema,
  zaiProfileSchema,
]);

const modelProvidersSchema = z
  .object({
    /**
     * Name of the profile used when no per-session choice is made. Must name
     * an existing profile or "native". Absent => "native".
     */
    default: z.string().min(1).optional(),
    /** User-named profiles. A profile named "native" is REJECTED (reserved). */
    profiles: z
      .record(z.string().min(1), providerProfileSchema)
      .refine((p) => !(NATIVE_PROFILE_NAME in p), {
        message: `"${NATIVE_PROFILE_NAME}" is a reserved profile name and cannot be redefined.`,
      })
      .optional(),
  })
  // `default`, when present, must resolve to an existing profile or the reserved native name.
  .refine((mp) => mp.default === undefined || mp.default === NATIVE_PROFILE_NAME || !!mp.profiles?.[mp.default], {
    message: 'modelProviders.default must name a configured profile or "native".',
    path: ['default'],
  })
  .optional();

export const userConfigSchema = z
  .object({
    /**
     * The first-start wizard's completion marker (see setup-state.ts): `true`
     * once the wizard completed, `false` in a config.json any other command
     * created. Absent in files written before the marker existed. Not a
     * setting: deliberately not in USER_CONFIG_DEFAULTS (backfilling would
     * decide for a pre-marker file whether its wizard ran) and not part of
     * the resolved config.
     */
    setupCompleted: z.boolean().optional(),
    agentModelId: qualifiedModelId.optional(),
    policyModelId: qualifiedModelId.optional(),
    /**
     * Model for the policy compile's verification oracle: it generates the
     * test scenarios and judges the compiled rules. Absent: the policy model
     * does both. Deliberately not in USER_CONFIG_DEFAULTS, so it keeps
     * following policyModelId until set.
     */
    policyVerifierModelId: qualifiedModelId.optional(),
    prefilterModelId: qualifiedModelId.optional(),
    anthropicApiKey: z.string().min(1, 'anthropicApiKey must be non-empty').optional(),
    googleApiKey: z.string().min(1, 'googleApiKey must be non-empty').optional(),
    openaiApiKey: z.string().min(1, 'openaiApiKey must be non-empty').optional(),
    anthropicBaseUrl: z.url().optional(),
    openaiBaseUrl: z.url().optional(),
    googleBaseUrl: z.url().optional(),
    escalationTimeoutSeconds: z
      .number()
      .int('escalationTimeoutSeconds must be an integer')
      .min(ESCALATION_TIMEOUT_MIN, `escalationTimeoutSeconds must be at least ${ESCALATION_TIMEOUT_MIN}`)
      .max(ESCALATION_TIMEOUT_MAX, `escalationTimeoutSeconds must be at most ${ESCALATION_TIMEOUT_MAX}`)
      .optional(),
    resourceBudget: resourceBudgetSchema,
    autoCompact: autoCompactSchema,
    autoApprove: autoApproveSchema,
    auditRedaction: auditRedactionSchema,
    observability: observabilitySchema,
    taintEscalation: taintEscalationSchema,
    contentAssessment: contentAssessmentSchema,
    webSearch: webSearchSchema,
    fetch: fetchSchema,
    policy: policySchema,
    egressPolicy: egressPolicySchema,
    modelProviders: modelProvidersSchema,
    hostModelProfiles: hostModelProfilesSchema.optional(),
    serverCredentials: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
    signal: signalSchema,
    memory: memorySchema,
    gooseProvider: z.enum(GOOSE_PROVIDERS).optional(),
    gooseModel: z.string().min(1).optional(),
    preferredDockerAgent: z.enum(DOCKER_AGENTS).optional(),
    preferredMode: preferredModeSchema.optional(),
    containerRuntime: z.enum(CONTAINER_RUNTIMES).optional(),
    /**
     * What happens to an MCP server that asks for an OS sandbox when
     * sandbox-runtime cannot provide one. Absent = platform default
     * ("enforce" on Linux/macOS). Deliberately not in USER_CONFIG_DEFAULTS:
     * backfilling would freeze a platform-dependent default into the file.
     */
    sandboxPolicy: z.enum(SANDBOX_POLICIES).optional(),
    packageInstall: packageInstallSchema,
    credentialProtection: credentialProtectionSchema,
    /**
     * Passwordless sudo for the agent inside its Docker container. Absent =
     * on (today's behavior; package installs such as `sudo apt-get install`
     * go through the registry proxy). `false` starts the agent without any
     * root step: `--security-opt no-new-privileges`, none of the SETUID,
     * SETGID, CHOWN, FOWNER, DAC_OVERRIDE (or AUDIT_WRITE) capabilities, and
     * numeric agent identities (see `src/docker/agent-privileges.ts`).
     * Deliberately not in USER_CONFIG_DEFAULTS: backfilling `true` would
     * freeze today's default into every config file, and changing the Linux
     * default is an open owner decision.
     */
    agentSudo: z.boolean().optional(),
    /**
     * Agent CLI versions for the Docker agent images, overriding the pins
     * (`"claude-code"`, `"codex"`: an exact version or `"latest"`). The value
     * is passed to the image build as the Dockerfile's version build arg and
     * is part of the image build hash, so changing it rebuilds the image.
     * `"latest"` resolves when the image is built: `ironcurtain images rebuild`
     * picks up a newer release. A CLI outside the range qualified with this
     * release is logged as a warning at session start. Deliberately not in
     * USER_CONFIG_DEFAULTS: absent means "use the pin of this release".
     */
    agentCliVersions: agentCliVersionsSchema,
    dockerResources: dockerResourcesSchema,
    maxConcurrentAgentSessions: z
      .number()
      .int('maxConcurrentAgentSessions must be an integer')
      .min(1, 'maxConcurrentAgentSessions must be at least 1')
      .max(
        MAX_CONCURRENT_AGENT_SESSIONS_LIMIT,
        `maxConcurrentAgentSessions must be at most ${MAX_CONCURRENT_AGENT_SESSIONS_LIMIT}`,
      )
      .optional(),
    capture: captureSchema,
    statistics: statisticsSchema,
    snapshot: snapshotSchema,
    cron: cronSchema,
    personas: personasSchema,
    retention: retentionSchema,
    dockerWorkload: dockerWorkloadRequestedSchema.optional(),
  })
  .superRefine((config, ctx) => {
    for (const [role, name] of Object.entries(config.hostModelProfiles ?? {})) {
      if (
        name !== NATIVE_PROFILE_NAME &&
        !Object.prototype.hasOwnProperty.call(config.modelProviders?.profiles ?? {}, name)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['hostModelProfiles', role],
          message: `Unknown host model provider profile "${name}".`,
        });
      }
    }
  });

/** Parsed config from ~/.ironcurtain/config.json. All fields optional. */
export type UserConfig = z.infer<typeof userConfigSchema>;

/** Resolved resource budget with all fields present. */
export interface ResolvedResourceBudgetConfig {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
  readonly warnThresholdPercent: number;
}

/** Resource budget input exactly as saved, for provenance-aware workflow resolution. */
export function loadRequestedResourceBudgetConfig(): Partial<ResolvedResourceBudgetConfig> {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return {};
  const requested = parseAndValidateConfig(readFileSync(configPath, 'utf-8'), configPath).validated.resourceBudget;
  if (!requested) return {};
  // Limits only: model prices are not a per-run limit.
  const limits: Partial<ResolvedResourceBudgetConfig> = {};
  for (const key of Object.keys(USER_CONFIG_DEFAULTS.resourceBudget) as (keyof ResolvedResourceBudgetConfig)[]) {
    if (requested[key] !== undefined) Object.assign(limits, { [key]: requested[key] });
  }
  return limits;
}

/** Resolved auto-compaction config with all fields present. */
export interface ResolvedAutoCompactConfig {
  readonly enabled: boolean;
  readonly thresholdTokens: number;
  readonly keepRecentMessages: number;
  readonly summaryModelId: string;
}

/** Resolved auto-approve config with all fields present. */
export interface ResolvedAutoApproveConfig {
  readonly enabled: boolean;
  readonly modelId: string;
}

/** Resolved audit redaction config with all fields present. */
export interface ResolvedAuditRedactionConfig {
  readonly enabled: boolean;
}

/** Resolved observability config with all fields present. */
export interface ResolvedObservabilityConfig {
  /** What session LLM interaction logs record (see LLM_INTERACTION_LOG_MODES). */
  readonly llmInteractionLog: LlmInteractionLogMode;
}

/**
 * The effective `observability.llmInteractionLog`. A configuration built by
 * hand (tests, embedders) may omit `observability`; it gets the default.
 */
export function resolveLlmInteractionLogMode(userConfig: {
  readonly observability?: ResolvedObservabilityConfig;
}): LlmInteractionLogMode {
  return userConfig.observability?.llmInteractionLog ?? USER_CONFIG_DEFAULTS.observability.llmInteractionLog;
}

/** Resolved taint escalation config (`taintEscalation`). */
export interface ResolvedTaintEscalationConfig {
  readonly enabled: boolean;
  /** Per-tool / per-server classes replacing the defaults (`server/tool` or `server/*`). */
  readonly tools: Readonly<Record<string, TaintToolClass>>;
}

/** Resolved outbound content assessment config with all fields present. */
export interface ResolvedContentAssessmentConfig {
  /** The deterministic checks run (opt-in). */
  readonly enabled: boolean;
  /** The intelligibility check runs too (separate opt-in; only when `enabled`). */
  readonly llmCheck: boolean;
  readonly llmModelId: string;
}

/** Resolved memory config with all fields present. */
export interface ResolvedMemoryConfig {
  readonly enabled: boolean;
  readonly autoSave: boolean;
  readonly llmBaseUrl: string | undefined;
  readonly llmApiKey: string | undefined;
  /**
   * The memory server never downloads models (MEMORY_MODELS_OFFLINE); a model
   * missing from ~/.ironcurtain/models is an error. Default false: missing
   * pinned models are downloaded on first use and verified.
   */
  readonly offlineModels: boolean;
}

/** Resolved `credentialProtection`: user additions to and opt-outs from the protected credential stores. */
export interface ResolvedCredentialProtectionConfig {
  /** Extra protected paths as written in config (absolute or `~/...`). */
  readonly extraPaths: readonly string[];
  /** Extended (non-core) credential stores the user chose not to protect. */
  readonly disabledStores: readonly ExtendedCredentialStoreId[];
}

/** Resolved package installation config with all fields present. */
export interface ResolvedPackageInstallConfig {
  readonly enabled: boolean;
  readonly quarantineDays: number;
  readonly allowedPackages: readonly string[];
  readonly deniedPackages: readonly string[];
}

/**
 * Resolved Docker container resource ceilings.
 *
 * `null` is a deliberate "no limit" signal: callers must omit the
 * corresponding `--memory` / `--cpus` flag, matching the existing pattern
 * in `docker-manager.ts:buildCreateArgs()`.
 *
 * These are the user-configured ceilings BEFORE clamping. The runtime
 * clamp (`clampDockerResources()` in `src/docker/resource-limits.ts`) lowers
 * either value to fit the host's actual capacity; nulls pass through
 * unchanged.
 */
export interface ResolvedDockerResourcesConfig {
  readonly memoryMb: number | null;
  readonly cpus: number | null;
  /** cgroup pids ceiling for agent containers; null = no `--pids-limit`. Not clamped. */
  readonly pidsLimit: number | null;
}

export interface ResolvedSnapshotConfig {
  readonly enabled: boolean;
  readonly maxAgeDays: number | null;
  readonly sweepIntervalHours: number;
  /** Largest container (bytes) a snapshot is committed for; null means no cap. */
  readonly maxBytes: number | null;
}

/** Resolved web search config with all fields present. */
export interface ResolvedWebSearchConfig {
  readonly provider: WebSearchProvider | null;
  readonly brave: { readonly apiKey: string } | null;
  readonly tavily: { readonly apiKey: string } | null;
  readonly serpapi: { readonly apiKey: string } | null;
}

/**
 * Resolved openrouter profile = v2's ResolvedOpenRouterConfig fields, minus
 * `enabled` (enablement is now "the active profile's type is openrouter").
 * See docs/designs/openrouter-integration.md §6.
 */
export interface ResolvedOpenRouterProfile {
  readonly type: 'openrouter';
  /** '' when unset (neither OPENROUTER_API_KEY env nor profile.apiKey). */
  readonly apiKey: string;
  readonly modelMap: readonly { readonly match: string; readonly model: string }[];
  /**
   * True iff the on-disk profile OMITTED `modelMap` (so `modelMap` above holds
   * the materialized `DEFAULT_MODEL_MAP`). Serializers use this to re-persist an
   * omitted map — preserving "track the defaults" intent across edit round-trips.
   * An explicit `modelMap: []` (per-agent-only mode) is `false`, not default.
   */
  readonly usesDefaultMap: boolean;
  readonly perAgent: Readonly<Record<DockerAgent, string | undefined>>;
  readonly providerPreference:
    | { readonly order?: readonly string[]; readonly only?: readonly string[]; readonly allowFallbacks?: boolean }
    | undefined;
  readonly sessionAffinity: boolean;
}

/** Resolved native profile: today's canonical routing. No fields. */
export interface ResolvedNativeProfile {
  readonly type: 'native';
}

/** The resolved active profile the whole OpenRouter feature reads (§7–§11). */
export interface ResolvedZaiProfile {
  readonly type: 'zai';
  readonly apiKey: string;
  readonly plan: 'api' | 'coding';
  readonly model: string;
  readonly modelMap: readonly { readonly match: string; readonly model: string }[];
  readonly usesDefaultMap: boolean;
  readonly perAgent: Readonly<Record<DockerAgent, string | undefined>>;
}

export type ResolvedProviderProfile = ResolvedNativeProfile | ResolvedOpenRouterProfile | ResolvedZaiProfile;

/**
 * Resolved provider-profile registry. `profiles` ALWAYS includes the implicit
 * `native` profile; `default` is a resolved name ('native' when unset).
 */
export interface ResolvedModelProvidersConfig {
  readonly default: string;
  readonly profiles: Readonly<Record<string, ResolvedProviderProfile>>;
}

/** Resolved `egressPolicy` (see `egressPolicySchema`). */
export interface ResolvedEgressPolicyConfig {
  readonly enabled: boolean;
  /** Canonical host patterns admitted without asking a human. */
  readonly allowedHosts: readonly string[];
}

/** Validated, defaults-applied configuration. All fields present. */
export interface ResolvedUserConfig {
  readonly agentModelId: string;
  readonly policyModelId: string;
  /**
   * Separate model for the policy compile's scenario generation and verifier
   * judge (`policyVerifierModelId`). Undefined: the policy model does both.
   * Optional so hand-built configs (tests, embedders) need not carry it.
   */
  readonly policyVerifierModelId?: string;
  readonly prefilterModelId: string;
  readonly anthropicApiKey: string;
  readonly googleApiKey: string;
  readonly openaiApiKey: string;
  readonly anthropicBaseUrl: string;
  readonly openaiBaseUrl: string;
  readonly googleBaseUrl: string;
  readonly escalationTimeoutSeconds: number;
  readonly resourceBudget: ResolvedResourceBudgetConfig;
  /**
   * Model price overrides from config.json `resourceBudget.modelPricing`.
   * Always set by `loadUserConfig()`; optional in the type so hand-built
   * configs (tests, embedders) need not carry it. Absent means none.
   */
  readonly modelPricingOverrides?: ModelPricingOverrides;
  readonly autoCompact: ResolvedAutoCompactConfig;
  readonly autoApprove: ResolvedAutoApproveConfig;
  readonly auditRedaction: ResolvedAuditRedactionConfig;
  /**
   * Session log settings. Always set by `loadUserConfig()`; optional in the
   * type so hand-built configs (tests, embedders) need not carry it. Read the
   * log mode through `resolveLlmInteractionLogMode()`, which applies the
   * default when it is absent.
   */
  readonly observability?: ResolvedObservabilityConfig;
  /**
   * Sequence-aware (taint) escalation. Always set by `loadUserConfig()`
   * (disabled unless the config file enables it); optional in the type so
   * hand-built configs (tests, embedders) need not carry it, and readers
   * must treat an absent value as disabled.
   */
  readonly taintEscalation?: ResolvedTaintEscalationConfig;
  /**
   * Outbound content assessment. Always set by `loadUserConfig()`; optional
   * in the type so hand-built configs (tests, embedders) need not carry it,
   * and readers must treat an absent value as disabled.
   */
  readonly contentAssessment?: ResolvedContentAssessmentConfig;
  readonly memory: ResolvedMemoryConfig;
  readonly webSearch: ResolvedWebSearchConfig;
  /**
   * Fetch MCP server settings. Always set by `loadUserConfig()`; optional in
   * the type so hand-built configs (tests, embedders) need not carry it, and
   * readers must treat an absent value as `allowPrivateNetworks: false`.
   */
  readonly fetch?: { readonly allowPrivateNetworks: boolean };
  /**
   * Compiled-policy settings. Always set by `loadUserConfig()`; optional in
   * the type so hand-built configs (tests, embedders) need not carry it, and
   * readers must treat an absent value as `onStale: 'warn'`.
   */
  readonly policy?: { readonly onStale: PolicyOnStale };
  /**
   * Policy-evaluated MITM egress (opt-in). Always set by `loadUserConfig()`,
   * with `allowedHosts` canonicalized (lowercase, no trailing dot); optional
   * in the type so hand-built configs (tests, embedders) need not carry it,
   * and readers must treat an absent value as disabled.
   */
  readonly egressPolicy?: ResolvedEgressPolicyConfig;
  /**
   * OpenRouter provider-profile registry. The `profiles` record always
   * includes the implicit `native` profile; `default` is 'native' when unset.
   * See docs/designs/openrouter-integration.md §6.
   */
  readonly modelProviders: ResolvedModelProvidersConfig;
  readonly hostModelProfiles?: Readonly<Partial<Record<HostModelRole, string>>>;
  readonly serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Signal transport config. Null when Signal is not set up. */
  readonly signal: import('../signal/signal-config.js').ResolvedSignalConfig | null;
  /** Goose LLM provider. */
  readonly gooseProvider: GooseProvider;
  /** Goose model identifier. */
  readonly gooseModel: string;
  /** Preferred Docker agent for auto-detection. */
  readonly preferredDockerAgent: DockerAgent;
  /** Preferred session mode: 'container' (default) or 'builtin'. */
  readonly preferredMode: SessionModeKind;
  /** Container runtime backend: 'auto' (default), 'docker', or 'apple-container'. */
  readonly containerRuntime: ContainerRuntimeSetting;
  /**
   * Effective OS-sandbox availability policy: IRONCURTAIN_SANDBOX_POLICY /
   * SANDBOX_POLICY env override, else the config file, else the platform
   * default. See `sandbox-policy.ts`.
   */
  readonly sandboxPolicy: SandboxAvailabilityPolicy;
  /** Package installation proxy configuration. */
  readonly packageInstall: ResolvedPackageInstallConfig;
  /** Protected host credential stores: user additions and extended-store opt-outs. */
  readonly credentialProtection: ResolvedCredentialProtectionConfig;
  /**
   * Passwordless sudo for container agents (default true). False drops the
   * file-privilege capabilities and sets no-new-privileges; see
   * `planAgentContainerPrivileges` in `src/docker/agent-privileges.ts`.
   */
  readonly agentSudo: boolean;
  /**
   * Agent CLI version overrides (`agentCliVersions`); an absent key builds the
   * pinned version. Always set by `loadUserConfig()`; optional in the type so
   * hand-built configs (tests, embedders) need not carry it.
   */
  readonly agentCliVersions?: AgentCliVersionOverrides;
  /** Docker container resource ceilings (pre-clamp). */
  readonly dockerResources: ResolvedDockerResourcesConfig;
  /**
   * Cap on concurrent workflow agent environments (shared-container
   * bundles and per-state agent sessions) in one process; further ones
   * queue. Always set by `loadUserConfig()`; optional in the type so
   * hand-built configs (tests, embedders) need not carry it, and readers
   * must treat an absent value as `USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions`.
   */
  readonly maxConcurrentAgentSessions?: number;
  /** Workflow container snapshot retention and global enablement. */
  readonly snapshot: ResolvedSnapshotConfig;
  /** Opt-in nested Docker authority; normal loads always resolve absent config to `{ enabled: false }`. */
  readonly dockerWorkload?: ResolvedDockerWorkloadConfig;
  /**
   * Trajectory-capture config. Optional — absent from
   * USER_CONFIG_DEFAULTS so the `?? false` at the session-factory
   * resolution point is authoritative. See
   * docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly capture?: { readonly enabled: boolean };
  /** Content-free local LLM usage statistics. */
  readonly statistics: { readonly enabled: boolean; readonly retentionDays: number | null };
  /**
   * Daemon cron scheduling. Always set by `loadUserConfig()`; optional in the
   * type so hand-built configs (tests, embedders) need not carry it, and
   * readers treat an absent value as {@link CRON_CONFIG_DEFAULTS}.
   */
  readonly cron?: ResolvedCronConfig;
  /**
   * Persona lifecycle (trash retention). Always set by `loadUserConfig()`;
   * optional in the type so hand-built configs need not carry it, and
   * readers treat an absent value as {@link PERSONAS_CONFIG_DEFAULTS}.
   */
  readonly personas?: ResolvedPersonasConfig;
  /**
   * Retention of sessions, workflow runs, job run records, dependency caches
   * and daemon logs. Always set by `loadUserConfig()`; optional in the type
   * so hand-built configs need not carry it, and readers treat an absent
   * value as {@link RETENTION_CONFIG_DEFAULTS}.
   */
  readonly retention?: ResolvedRetentionConfig;
}

/** Fields that must never be backfilled into the config file. */
const SENSITIVE_FIELDS = new Set([
  'anthropicApiKey',
  'googleApiKey',
  'openaiApiKey',
  'serverCredentials',
  'webSearch',
  'modelProviders', // Each openrouter profile may carry an sk-or-v1- API key
  'signal', // Contains phone numbers and identity key fingerprints
]);

/** Owner-only read/write permissions for the config file (may contain API keys). */
const CONFIG_FILE_MODE = PRIVATE_FILE_MODE;

/**
 * The single writer of config.json. The replacement is atomic and owner-only
 * ({@link writePrivateFileAtomicSync}): a crash or a full disk leaves either
 * the old or the new file, never an empty or partial one, the file is 0600
 * whatever the umask, and a symlinked config.json (dotfile managers) stays a
 * symlink. When `previous` (the bytes being replaced) is given and differs
 * from `content`, it is first kept as `config.json.bak`, also owner-only, so
 * the version before the latest write can be restored by hand.
 *
 * Callers hold the config lock ({@link withConfigLock}) and derived `content`
 * from the file as read under that lock.
 */
function writeConfigFile(configPath: string, content: string, previous?: string): void {
  if (previous !== undefined && previous !== content) {
    writePrivateFileAtomicSync(configBackupPath(configPath), previous, CONFIG_FILE_MODE);
  }
  writePrivateFileAtomicSync(configPath, content, CONFIG_FILE_MODE);
}

/** The previous version of config.json, kept by every rewrite: `config.json.bak` beside it. */
function configBackupPath(configPath: string): string {
  return `${configPath}.bak`;
}

/**
 * Runs a read-modify-write of config.json under the cross-process
 * `config.json.lock` (see `../util/file-lock.ts`), so the daemon, the CLI and
 * any process that backfills on load apply their changes one after another
 * instead of each writing back a version the other has not seen. Creates the
 * IronCurtain home (0700) if needed, since the lock file lives there.
 */
function withConfigLock<T>(configPath: string, fn: () => T): T {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  return withFileLockSync(configPath, fn);
}

/** The text of config.json, or undefined when there is no such file. */
function readConfigText(configPath: string): string | undefined {
  try {
    return readFileSync(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Parses config text into a plain object; undefined when it is not one (load reports that). */
function tryParseConfigObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses the existing config.json for an update, refusing anything but a JSON
 * object, as {@link loadUserConfig} does. An update built on an empty base
 * instead would silently drop every setting the unreadable file holds (API
 * keys, server credentials, model providers, the Signal identity).
 */
function parseConfigForUpdate(raw: string, configPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${configPath}: ${message}. Nothing was saved; fix or remove the file first.`, {
      cause: err,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Invalid config in ${configPath}: expected a JSON object. Nothing was saved; fix or remove the file first.`,
    );
  }
  return parsed;
}

/**
 * Default config file content (anthropicApiKey intentionally omitted). It
 * records that the first-start wizard has not run (`setupCompleted: false`):
 * a command other than the wizard creates this file (see setup-state.ts).
 */
const DEFAULT_CONFIG_CONTENT =
  JSON.stringify(
    {
      setupCompleted: false,
      agentModelId: USER_CONFIG_DEFAULTS.agentModelId,
      policyModelId: USER_CONFIG_DEFAULTS.policyModelId,
      prefilterModelId: USER_CONFIG_DEFAULTS.prefilterModelId,
      escalationTimeoutSeconds: USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
      auditRedaction: USER_CONFIG_DEFAULTS.auditRedaction,
      observability: USER_CONFIG_DEFAULTS.observability,
      contentAssessment: USER_CONFIG_DEFAULTS.contentAssessment,
      preferredMode: USER_CONFIG_DEFAULTS.preferredMode,
      dockerResources: USER_CONFIG_DEFAULTS.dockerResources,
      maxConcurrentAgentSessions: USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions,
      snapshot: USER_CONFIG_DEFAULTS.snapshot,
      statistics: USER_CONFIG_DEFAULTS.statistics,
    },
    null,
    2,
  ) + '\n';

/**
 * Loads user configuration from ~/.ironcurtain/config.json.
 *
 * Default behavior:
 * 1. If file does not exist: create with defaults (first-start setup marked
 *    as not run, see setup-state.ts), log to stderr
 * 2. If file exists: parse JSON, validate with Zod, backfill missing fields, merge with defaults
 * 3. Apply env var overrides (ANTHROPIC_API_KEY overrides anthropicApiKey)
 * 4. Return ResolvedUserConfig with all fields present
 *
 * With `readOnly: true`: never creates or writes the config file.
 * Returns defaults merged with env overrides if the file does not exist.
 * Skips backfilling and the dockerWorkload migration.
 *
 * Either way, every field the schema does not recognize, at any depth, is
 * reported on stderr (once per process) and otherwise ignored: a mistyped
 * `resourceBudget.maxStep` would else leave the default step limit in force
 * without a word. See {@link findUnknownUserConfigFields}.
 *
 * Creating the file, backfilling defaults and the dockerWorkload migration are
 * the only writes a load makes, and each is a locked read-modify-write like
 * {@link saveUserConfig}: it re-reads the file under the config lock and
 * changes only what is still missing there, so a load in one process never
 * rolls back a save another process has just made.
 *
 * @throws Error on invalid JSON or schema validation failure
 */
export function loadUserConfig(options?: { readOnly?: boolean }): ResolvedUserConfig {
  const configPath = getUserConfigPath();
  if (options?.readOnly) {
    // Read-only mode: return defaults if file doesn't exist, never write to disk
    if (!existsSync(configPath)) {
      return applyEnvOverrides(mergeWithDefaults({}));
    }
    const { validated } = parseAndValidateConfig(readFileSync(configPath, 'utf-8'), configPath);
    return applyEnvOverrides(mergeWithDefaults(validated));
  }
  let raw = readOrCreateConfigFile(configPath);
  raw = backfillMissingFields(configPath, raw);
  const { parsed, validated } = parseAndValidateConfig(raw, configPath);
  migrateRequestedDockerWorkloadConfig(configPath, parsed, validated);
  return applyEnvOverrides(mergeWithDefaults(validated));
}

/**
 * Read the validated requested nested-Docker block without applying defaults,
 * backfilling, environment overrides, or creating the config file. Settings
 * surfaces use this to preserve an explicit network preference while the
 * resolved disabled value remains authority-free `{ enabled: false }`.
 */
export function loadRequestedDockerWorkloadConfig(): DockerWorkloadRequestedConfig | undefined {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return undefined;
  return parseAndValidateConfig(readFileSync(configPath, 'utf-8'), configPath).validated.dockerWorkload;
}

/**
 * Read the validated `sandboxPolicy` saved in config.json, without the
 * IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY override or the platform
 * default, and without creating or backfilling the file. `undefined` when
 * the file or the field is absent. Settings surfaces use this so that the
 * value an environment variable currently forces can still be saved.
 */
export function loadSavedSandboxPolicy(): SandboxAvailabilityPolicy | undefined {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return undefined;
  return parseAndValidateConfig(readFileSync(configPath, 'utf-8'), configPath).validated.sandboxPolicy;
}

/**
 * Read the validated `signal.container` block saved in config.json (image
 * and port), without defaults and without creating or backfilling the file.
 * `undefined` when the file or the block is absent. `setup-signal` uses it to
 * keep the user's image pin and port, which the resolved config drops while
 * Signal is not fully set up.
 */
export function loadSavedSignalContainerConfig(): { readonly image?: string; readonly port?: number } | undefined {
  const configPath = getUserConfigPath();
  if (!existsSync(configPath)) return undefined;
  return parseAndValidateConfig(readFileSync(configPath, 'utf-8'), configPath).validated.signal?.container;
}

/**
 * Persist the canonical three-state nested-Docker request after a successful
 * normal load. Read-only loads deliberately skip this helper. Validation runs
 * first, so unsupported legacy intent is reported instead of rewritten. The
 * rewrite re-reads and re-validates the file under the config lock and only
 * replaces the dockerWorkload block of what is there now.
 */
function migrateRequestedDockerWorkloadConfig(configPath: string, parsed: unknown, validated: UserConfig): void {
  if (!needsDockerWorkloadMigration(parsed, validated)) return;

  const migrated = withConfigLock(configPath, () => {
    const current = readConfigText(configPath);
    const fileContent = current === undefined ? undefined : tryParseConfigObject(current);
    if (fileContent === undefined) return false;
    const result = userConfigSchema.safeParse(fileContent);
    if (!result.success || !needsDockerWorkloadMigration(fileContent, result.data)) return false;
    const updated = { ...fileContent, dockerWorkload: result.data.dockerWorkload };
    writeConfigFile(configPath, JSON.stringify(updated, null, 2) + '\n', current);
    return true;
  });
  if (migrated) process.stderr.write('Migrated config field: dockerWorkload\n');
}

/** True when the file's dockerWorkload block differs from its validated, canonical form. */
function needsDockerWorkloadMigration(parsed: unknown, validated: UserConfig): boolean {
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'dockerWorkload')) return false;
  return JSON.stringify(parsed['dockerWorkload']) !== JSON.stringify(validated.dockerWorkload);
}

/**
 * Detects fields present in USER_CONFIG_DEFAULTS but missing from the file,
 * writes them back with default values, and logs what was added.
 * Returns raw unchanged on parse failure (validation catches this later).
 *
 * The write re-reads the file under the config lock and adds the defaults
 * still missing from what is there now, so a save another process made after
 * `raw` was read is kept rather than replaced by this load's older view.
 * Returns the text the load should continue with.
 */
function backfillMissingFields(configPath: string, raw: string): string {
  const parsed = tryParseConfigObject(raw);
  if (parsed === undefined || computeMissingDefaults(parsed) === null) return raw;

  return withConfigLock(configPath, () => {
    const current = readConfigText(configPath);
    if (current === undefined) return raw;
    const fileContent = tryParseConfigObject(current);
    if (fileContent === undefined) return current;
    const patch = computeMissingDefaults(fileContent);
    if (patch === null) return current;

    const updated = applyPatchToFileContent(fileContent, patch);
    const newRaw = JSON.stringify(updated, null, 2) + '\n';
    writeConfigFile(configPath, newRaw, current);
    process.stderr.write(`Backfilled config fields: ${describeAddedFields(patch, fileContent)}\n`);
    return newRaw;
  });
}

/**
 * Computes a patch of default values for fields missing from the config file.
 * Skips sensitive fields. One level deep for nested objects.
 * Returns null when nothing is missing.
 */
function computeMissingDefaults(fileContent: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(USER_CONFIG_DEFAULTS)) {
    if (SENSITIVE_FIELDS.has(key)) continue;

    if (!(key in fileContent)) {
      patch[key] = defaultValue;
      continue;
    }

    // For nested objects, check for missing sub-fields one level deep
    if (!isPlainObject(defaultValue) || !isPlainObject(fileContent[key])) continue;

    const existing = fileContent[key];
    const subPatch: Record<string, unknown> = {};
    for (const [subKey, subDefault] of Object.entries(defaultValue)) {
      if (!(subKey in existing)) {
        subPatch[subKey] = subDefault;
      }
    }
    if (Object.keys(subPatch).length > 0) {
      patch[key] = subPatch;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Merges a patch of missing defaults into the file content.
 * Preserves all user values; only adds missing fields.
 */
function applyPatchToFileContent(
  fileContent: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...fileContent };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (key in result && isPlainObject(result[key])) {
      const existing = result[key];
      result[key] = { ...existing, ...(patchValue as Record<string, unknown>) };
    } else {
      result[key] = patchValue;
    }
  }
  return result;
}

/**
 * Produces a human-readable list of added fields for the log message.
 * Sub-field patches (partial nested objects) are listed as "parent.child".
 * Whole new top-level objects are listed by their key name alone; when the
 * file did have that section but none of the keys in it is one the schema
 * knows (every one a typo, say), the entry says so, since every setting the
 * user meant to make there is now at its default.
 */
function describeAddedFields(patch: Record<string, unknown>, fileContent: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const defaultValue = (USER_CONFIG_DEFAULTS as Record<string, unknown>)[key];
    const isSubFieldPatch =
      isPlainObject(value) &&
      isPlainObject(defaultValue) &&
      Object.keys(value).length < Object.keys(defaultValue).length;

    if (isSubFieldPatch) {
      for (const subKey of Object.keys(value)) {
        fields.push(`${key}.${subKey}`);
      }
      continue;
    }
    const unrecognized = unrecognizedSectionKeys(key, fileContent[key]);
    fields.push(
      unrecognized === undefined
        ? key
        : `${key} (none of its keys is recognized: ${unrecognized.map((name) => JSON.stringify(name)).join(', ')})`,
    );
  }
  return toDisplayText(fields.join(', '));
}

/**
 * The keys of a non-empty `section` object when the schema recognizes none of
 * them, else undefined.
 */
function unrecognizedSectionKeys(key: string, section: unknown): string[] | undefined {
  if (!isPlainObject(section)) return undefined;
  const keys = Object.keys(section);
  if (keys.length === 0) return undefined;
  const unrecognized = findUnknownKeys(userConfigSchema, { [key]: section })
    .filter((entry) => entry.path.length === 2)
    .map((entry) => String(entry.path[1]));
  return unrecognized.length === keys.length ? unrecognized : undefined;
}

/**
 * Reads the config file, creating it with defaults if it does not exist.
 * Creation happens under the config lock and only if the file is still
 * missing there, so two first runs cannot replace each other's file.
 */
function readOrCreateConfigFile(configPath: string): string {
  const existing = readConfigText(configPath);
  if (existing !== undefined) {
    warnInsecurePermissions(configPath);
    return existing;
  }
  return withConfigLock(configPath, () => {
    const current = readConfigText(configPath);
    if (current !== undefined) return current;
    writeConfigFile(configPath, DEFAULT_CONFIG_CONTENT);
    process.stderr.write(`Created default config at ${configPath}\n`);
    return DEFAULT_CONFIG_CONTENT;
  });
}

/**
 * Warns if the config file is group- or world-readable.
 * Config files may contain API keys and server credentials.
 */
function warnInsecurePermissions(configPath: string): void {
  try {
    const stats = statSync(configPath);
    // Check for group (0o040) or other (0o004) read bits
    if (stats.mode & 0o044) {
      process.stderr.write(
        `Warning: ${configPath} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 ${configPath}\n`,
      );
    }
  } catch {
    /* ignore stat failures */
  }
}

/**
 * Parses raw JSON string. Throws a descriptive error on invalid JSON.
 */
function parseConfigJson(raw: string, configPath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${configPath}: ${message}`, { cause: err });
  }
}

/** A config field the schema does not recognize, as {@link findUnknownUserConfigFields} reports it. */
export interface UnknownConfigField {
  /** Dotted path of the field, e.g. `resourceBudget.maxStep` or `modelProviders.profiles["glm-5.2"].apikey`. */
  readonly field: string;
  /** Path of a known field the name is a near miss of, e.g. `resourceBudget.maxSteps`. */
  readonly suggestion?: string;
}

/**
 * Every field in a parsed config.json that {@link userConfigSchema} does not
 * recognize, at any depth, with the known field each one most likely meant.
 * Nested sections are plain `z.object()`s, which strip unknown keys instead
 * of rejecting them, so without this a typo such as `resourceBudget.maxStep`
 * or `dockerResources.memoryMB` silently leaves the default limit in force.
 */
export function findUnknownUserConfigFields(parsed: unknown): UnknownConfigField[] {
  return findUnknownKeys(userConfigSchema, parsed).map(({ path, knownKeys }) => {
    const name = String(path[path.length - 1]);
    const suggestion = suggestKnownKey(name, knownKeys);
    return {
      field: formatFieldPath(path),
      ...(suggestion !== undefined ? { suggestion: formatFieldPath([...path.slice(0, -1), suggestion]) } : {}),
    };
  });
}

/** The known key `name` most plausibly misspells (case-insensitive, edit distance scaled to its length). */
function suggestKnownKey(name: string, knownKeys: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  const maxDistance = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  const byLower = new Map(knownKeys.map((key) => [key.toLowerCase(), key]));
  const match = closestMatch(lower, byLower.keys(), maxDistance);
  return match === undefined ? undefined : byLower.get(match);
}

/** `a.b[0]["key with.dots"]`: plain identifiers dotted, anything else JSON-quoted in brackets. */
function formatFieldPath(path: readonly (string | number)[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$-]*$/u.test(segment)) out += out === '' ? segment : `.${segment}`;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** Unknown-field warnings this process has printed, keyed by config path and field. */
const reportedUnknownFields = new Set<string>();

/**
 * Warns on stderr about every field of the parsed config the schema does not
 * recognize, at any depth, naming the known field it is a near miss of. Such
 * fields are ignored (and kept in the file). Runs in every load mode; each
 * field is reported once per process, because long-lived processes (the
 * daemon, the web UI's config handlers) re-load the config on every request.
 */
function warnUnknownFields(parsed: unknown, configPath: string): void {
  for (const { field, suggestion } of findUnknownUserConfigFields(parsed)) {
    const key = `${configPath}\0${field}`;
    if (reportedUnknownFields.has(key)) continue;
    reportedUnknownFields.add(key);
    const hint = suggestion === undefined ? 'it is ignored' : `it is ignored; did you mean "${suggestion}"?`;
    process.stderr.write(toDisplayText(`Warning: unknown field "${field}" in ${configPath} (${hint})`) + '\n');
  }
}

/** Parses config.json text, reports its unknown fields, and validates it. */
function parseAndValidateConfig(raw: string, configPath: string): { parsed: unknown; validated: UserConfig } {
  const parsed = parseConfigJson(raw, configPath);
  warnUnknownFields(parsed, configPath);
  return { parsed, validated: validateConfig(parsed, configPath) };
}

/**
 * Validates parsed config against the Zod schema.
 * Throws a descriptive error listing invalid fields.
 */
function validateConfig(parsed: unknown, configPath: string): UserConfig {
  const result = userConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }
  return result.data;
}

function normalizeLegacyPreferredMode(config: Record<string, unknown>): Record<string, unknown> {
  if (config['preferredMode'] !== 'docker') return config;
  return { ...config, preferredMode: 'container' };
}

/**
 * Resolves `egressPolicy`: disabled unless `enabled` is true, patterns in
 * their canonical spelling, duplicates removed. The schema already refused
 * any pattern that does not canonicalize.
 */
function resolveEgressPolicy(config: UserConfig['egressPolicy']): ResolvedEgressPolicyConfig {
  const allowedHosts = new Set<string>();
  for (const pattern of config?.allowedHosts ?? []) {
    const canonical = canonicalEgressHostPattern(pattern);
    if (canonical !== undefined) allowedHosts.add(canonical);
  }
  return { enabled: config?.enabled === true, allowedHosts: [...allowedHosts] };
}

/**
 * Merges validated (partial) config with defaults.
 * API key fields default to empty string when not provided.
 */
function mergeWithDefaults(config: UserConfig): ResolvedUserConfig {
  const budgetDefaults = USER_CONFIG_DEFAULTS.resourceBudget;
  const compactDefaults = USER_CONFIG_DEFAULTS.autoCompact;
  const approveDefaults = USER_CONFIG_DEFAULTS.autoApprove;
  const redactionDefaults = USER_CONFIG_DEFAULTS.auditRedaction;
  const b = config.resourceBudget;
  const c = config.autoCompact;
  const a = config.autoApprove;
  const r = config.auditRedaction;
  // Resolve the ordinary container envelope once. Nested Docker inherits its
  // numeric memory, CPU and PID values as the bundle's aggregate envelope;
  // `null` is deliberately not inherited because unlimited ordinary-container
  // settings are not safe private-VM defaults.
  const resolvedDockerResources: ResolvedDockerResourcesConfig = {
    memoryMb:
      config.dockerResources?.memoryMb === undefined
        ? USER_CONFIG_DEFAULTS.dockerResources.memoryMb
        : config.dockerResources.memoryMb,
    cpus:
      config.dockerResources?.cpus === undefined
        ? USER_CONFIG_DEFAULTS.dockerResources.cpus
        : config.dockerResources.cpus,
    pidsLimit:
      config.dockerResources?.pidsLimit === undefined
        ? USER_CONFIG_DEFAULTS.dockerResources.pidsLimit
        : config.dockerResources.pidsLimit,
  };
  return {
    agentModelId: config.agentModelId ?? USER_CONFIG_DEFAULTS.agentModelId,
    policyModelId: config.policyModelId ?? USER_CONFIG_DEFAULTS.policyModelId,
    policyVerifierModelId: config.policyVerifierModelId,
    prefilterModelId: config.prefilterModelId ?? USER_CONFIG_DEFAULTS.prefilterModelId,
    anthropicApiKey: config.anthropicApiKey ?? '',
    googleApiKey: config.googleApiKey ?? '',
    openaiApiKey: config.openaiApiKey ?? '',
    anthropicBaseUrl: config.anthropicBaseUrl ?? '',
    openaiBaseUrl: config.openaiBaseUrl ?? '',
    googleBaseUrl: config.googleBaseUrl ?? '',
    escalationTimeoutSeconds: config.escalationTimeoutSeconds ?? USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
    resourceBudget: {
      // Nullable fields: null means "disabled", undefined means "use default".
      // Must use !== undefined (not ??) so explicit null is preserved.
      maxTotalTokens: b?.maxTotalTokens !== undefined ? b.maxTotalTokens : budgetDefaults.maxTotalTokens,
      maxSteps: b?.maxSteps !== undefined ? b.maxSteps : budgetDefaults.maxSteps,
      maxSessionSeconds: b?.maxSessionSeconds !== undefined ? b.maxSessionSeconds : budgetDefaults.maxSessionSeconds,
      maxEstimatedCostUsd:
        b?.maxEstimatedCostUsd !== undefined ? b.maxEstimatedCostUsd : budgetDefaults.maxEstimatedCostUsd,
      warnThresholdPercent: b?.warnThresholdPercent ?? budgetDefaults.warnThresholdPercent,
    },
    modelPricingOverrides: b?.modelPricing ?? {},
    autoCompact: {
      enabled: c?.enabled ?? compactDefaults.enabled,
      thresholdTokens: c?.thresholdTokens ?? compactDefaults.thresholdTokens,
      keepRecentMessages: c?.keepRecentMessages ?? compactDefaults.keepRecentMessages,
      summaryModelId: c?.summaryModelId ?? compactDefaults.summaryModelId,
    },
    autoApprove: {
      enabled: a?.enabled ?? approveDefaults.enabled,
      modelId: a?.modelId ?? approveDefaults.modelId,
    },
    auditRedaction: {
      enabled: r?.enabled ?? redactionDefaults.enabled,
    },
    observability: {
      llmInteractionLog:
        config.observability?.llmInteractionLog ?? USER_CONFIG_DEFAULTS.observability.llmInteractionLog,
    },
    taintEscalation: {
      enabled: config.taintEscalation?.enabled ?? false,
      tools: config.taintEscalation?.tools ?? {},
    },
    contentAssessment: {
      enabled: config.contentAssessment?.enabled ?? USER_CONFIG_DEFAULTS.contentAssessment.enabled,
      llmCheck: config.contentAssessment?.llmCheck ?? USER_CONFIG_DEFAULTS.contentAssessment.llmCheck,
      llmModelId: config.contentAssessment?.llmModelId ?? USER_CONFIG_DEFAULTS.contentAssessment.llmModelId,
    },
    memory: {
      enabled: config.memory?.enabled ?? true,
      autoSave: config.memory?.autoSave ?? true,
      llmBaseUrl: config.memory?.llmBaseUrl,
      llmApiKey: config.memory?.llmApiKey,
      offlineModels: config.memory?.offlineModels ?? false,
    },
    webSearch: {
      provider: config.webSearch?.provider ?? null,
      brave: config.webSearch?.brave ?? null,
      tavily: config.webSearch?.tavily ?? null,
      serpapi: config.webSearch?.serpapi ?? null,
    },
    fetch: {
      allowPrivateNetworks: config.fetch?.allowPrivateNetworks ?? false,
    },
    policy: {
      onStale: config.policy?.onStale ?? 'warn',
    },
    egressPolicy: resolveEgressPolicy(config.egressPolicy),
    modelProviders: resolveModelProviders(config.modelProviders),
    hostModelProfiles: config.hostModelProfiles,
    serverCredentials: config.serverCredentials ?? {},
    signal: resolveSignalFromUserConfig(config),
    gooseProvider: config.gooseProvider ?? 'anthropic',
    gooseModel: config.gooseModel ?? 'claude-sonnet-4-20250514',
    preferredDockerAgent: config.preferredDockerAgent ?? 'claude-code',
    preferredMode: config.preferredMode ?? USER_CONFIG_DEFAULTS.preferredMode,
    containerRuntime: config.containerRuntime ?? 'auto',
    sandboxPolicy: config.sandboxPolicy ?? defaultSandboxPolicy(),
    packageInstall: {
      enabled: config.packageInstall?.enabled ?? true,
      quarantineDays: config.packageInstall?.quarantineDays ?? 2,
      allowedPackages: config.packageInstall?.allowedPackages ?? [],
      deniedPackages: config.packageInstall?.deniedPackages ?? [],
    },
    credentialProtection: {
      extraPaths: config.credentialProtection?.extraPaths ?? [],
      disabledStores: config.credentialProtection?.disabledStores ?? [],
    },
    agentSudo: config.agentSudo ?? true,
    agentCliVersions: { ...config.agentCliVersions },
    dockerResources: resolvedDockerResources,
    maxConcurrentAgentSessions: config.maxConcurrentAgentSessions ?? USER_CONFIG_DEFAULTS.maxConcurrentAgentSessions,
    snapshot: {
      enabled: config.snapshot?.enabled ?? USER_CONFIG_DEFAULTS.snapshot.enabled,
      maxAgeDays:
        config.snapshot?.maxAgeDays !== undefined
          ? config.snapshot.maxAgeDays
          : USER_CONFIG_DEFAULTS.snapshot.maxAgeDays,
      sweepIntervalHours: config.snapshot?.sweepIntervalHours ?? USER_CONFIG_DEFAULTS.snapshot.sweepIntervalHours,
      maxBytes:
        config.snapshot?.maxBytes !== undefined ? config.snapshot.maxBytes : USER_CONFIG_DEFAULTS.snapshot.maxBytes,
    },
    dockerWorkload: resolveDockerWorkloadConfig(config.dockerWorkload, {
      memoryMb: resolvedDockerResources.memoryMb ?? undefined,
      cpus: resolvedDockerResources.cpus ?? undefined,
      pidsLimit: resolvedDockerResources.pidsLimit ?? undefined,
    }),
    // Capture is left undefined unless the user explicitly set
    // `capture.enabled` in the config file. The session-factory
    // resolver applies the `?? false` default (§10).
    ...(config.capture?.enabled !== undefined ? { capture: { enabled: config.capture.enabled } } : {}),
    statistics: {
      enabled: config.statistics?.enabled ?? USER_CONFIG_DEFAULTS.statistics.enabled,
      retentionDays:
        config.statistics?.retentionDays !== undefined
          ? config.statistics.retentionDays
          : USER_CONFIG_DEFAULTS.statistics.retentionDays,
    },
    cron: {
      maxConcurrentRuns: config.cron?.maxConcurrentRuns ?? CRON_CONFIG_DEFAULTS.maxConcurrentRuns,
      catchUpMissedRuns: config.cron?.catchUpMissedRuns ?? CRON_CONFIG_DEFAULTS.catchUpMissedRuns,
    },
    personas: {
      // `null` (keep until purged by hand) is a value, not an absence.
      trashRetentionDays:
        config.personas?.trashRetentionDays !== undefined
          ? config.personas.trashRetentionDays
          : PERSONAS_CONFIG_DEFAULTS.trashRetentionDays,
    },
    retention: resolveRetentionConfig(config.retention),
  };
}

/** A single validated openrouter profile as parsed from config. */
type OpenrouterProfileInput = Extract<z.infer<typeof providerProfileSchema>, { type: 'openrouter' }>;

/**
 * Resolves one openrouter profile's fields to a ResolvedOpenRouterProfile.
 * `apiKey` is resolved to `profile.apiKey ?? ''` here; the OPENROUTER_API_KEY
 * env override is layered on for EVERY openrouter profile in applyEnvOverrides().
 * An explicit `modelMap: []` is preserved (uses `??`, not `||`).
 */
function resolveOpenrouterProfile(profile: OpenrouterProfileInput): ResolvedOpenRouterProfile {
  const perAgentInput = profile.perAgent ?? {};
  const perAgent = Object.fromEntries(DOCKER_AGENTS.map((agent) => [agent, perAgentInput[agent]])) as Record<
    DockerAgent,
    string | undefined
  >;
  return {
    type: 'openrouter',
    apiKey: profile.apiKey ?? '',
    modelMap: profile.modelMap ?? DEFAULT_MODEL_MAP,
    // An explicit `modelMap: []` is per-agent-only mode, distinct from omission:
    // `[] !== undefined`, so only a truly-omitted map tracks the defaults.
    usesDefaultMap: profile.modelMap === undefined,
    perAgent,
    providerPreference: profile.providerPreference,
    sessionAffinity: profile.sessionAffinity ?? true,
  };
}

/**
 * Resolves the `modelProviders` registry. The implicit `native` profile is
 * always injected; `default` resolves to 'native' when unset. A configured
 * `default` naming a missing profile has already been rejected by the schema
 * `.refine` at load time, so the resolved `default` always names a present key.
 */
function resolveModelProviders(config: UserConfig['modelProviders']): ResolvedModelProvidersConfig {
  const profiles: Record<string, ResolvedProviderProfile> = { [NATIVE_PROFILE_NAME]: { type: 'native' } };
  for (const [name, profile] of Object.entries(config?.profiles ?? {})) {
    profiles[name] = resolveProviderProfile(profile);
  }
  return {
    default: config?.default ?? NATIVE_PROFILE_NAME,
    profiles,
  };
}

/**
 * Resolves one validated provider profile (as `providerProfileSchema` parses
 * it) with its defaults applied. The API key is the profile's own; the env
 * override is layered on by the loader.
 */
export function resolveProviderProfile(profile: z.infer<typeof providerProfileSchema>): ResolvedProviderProfile {
  if (profile.type === 'openrouter') return resolveOpenrouterProfile(profile);
  if (profile.type === 'zai') {
    const model = profile.model ?? GLM_DEFAULT_MODEL;
    return {
      type: 'zai',
      apiKey: profile.apiKey ?? '',
      plan: profile.plan ?? 'api',
      model,
      modelMap: profile.modelMap ?? providerDefaultMap(profile.type, model),
      usesDefaultMap: profile.modelMap === undefined,
      perAgent: Object.fromEntries(DOCKER_AGENTS.map((agent) => [agent, profile.perAgent?.[agent]])) as Record<
        DockerAgent,
        string | undefined
      >,
    };
  }
  return { type: 'native' };
}

/**
 * Resolves the active provider profile for a session from an optional
 * per-session `providerProfileName`. Resolution order (§6): explicit name →
 * `modelProviders.default` (already 'native' when unset) → the resolved
 * profile. Throws a clear error listing the available profiles when the name
 * is not a key of the resolved `profiles` record (guards `--provider-profile`
 * typos and stale scripts). Pure — testable without infra.
 */
export function resolveActiveProfile(
  modelProviders: ResolvedModelProvidersConfig,
  providerProfileName?: string,
): ResolvedProviderProfile {
  const activeName = providerProfileName ?? modelProviders.default;
  if (!Object.prototype.hasOwnProperty.call(modelProviders.profiles, activeName)) {
    const available = Object.keys(modelProviders.profiles).join(', ');
    throw new Error(`Unknown provider profile "${activeName}". Available: ${available}.`);
  }
  return modelProviders.profiles[activeName];
}

/**
 * Masks an API key for display / the wire (`sk-...xyz`, `***` for short keys,
 * `none` when absent). The mask FORMAT is a load-bearing contract: the web-ui
 * dispatch compares an incoming wire value against `maskApiKey(currentKey)` to
 * implement the "leave-masked-to-keep" round-trip, and the frontend depends on
 * the same shape. Defined here (a dependency-light leaf) so both the interactive
 * CLI editor and the daemon WS dispatch share ONE definition without either
 * pulling in the other's imports (e.g. `@clack/prompts`).
 */
export function maskApiKey(key: string | undefined | null): string {
  if (!key) return 'none';
  if (key.length <= 6) return '***';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

export { cloneProviderPreference } from './provider-preference.js';

/**
 * Resolves Signal config inline to avoid circular imports with
 * signal-config.ts, which re-exports a richer version; this is the minimal
 * resolution needed by mergeWithDefaults(). The home comes from the shared
 * getIronCurtainHome() so an empty or relative IRONCURTAIN_HOME is handled
 * exactly as everywhere else.
 */
function resolveSignalFromUserConfig(
  config: UserConfig,
): import('../signal/signal-config.js').ResolvedSignalConfig | null {
  if (!config.signal) return null;
  if (!config.signal.botNumber || !config.signal.recipientNumber || !config.signal.recipientIdentityKey) {
    return null;
  }

  const home = getIronCurtainHome();
  return {
    botNumber: config.signal.botNumber,
    recipientNumber: config.signal.recipientNumber,
    recipientIdentityKey: config.signal.recipientIdentityKey,
    ...(config.signal.recipientUuid ? { recipientUuid: config.signal.recipientUuid } : {}),
    container: {
      image: config.signal.container?.image ?? SIGNAL_DEFAULT_IMAGE,
      port: config.signal.container?.port ?? 18080,
      dataDir: resolve(home, 'signal-data'),
      containerName: 'ironcurtain-signal',
    },
    maxConcurrentSessions: config.signal.maxConcurrentSessions ?? 3,
  };
}

/**
 * Applies environment variable overrides for all provider API keys and the
 * OS-sandbox policy. Each env var takes precedence over config file values.
 */
function applyEnvOverrides(config: ResolvedUserConfig): ResolvedUserConfig {
  return {
    ...config,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey,
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || config.googleApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
    anthropicBaseUrl: validateBaseUrlEnv('ANTHROPIC_BASE_URL') ?? config.anthropicBaseUrl,
    openaiBaseUrl: validateBaseUrlEnv('OPENAI_BASE_URL') ?? config.openaiBaseUrl,
    googleBaseUrl: validateBaseUrlEnv('GOOGLE_API_BASE_URL') ?? config.googleBaseUrl,
    modelProviders: applyProviderKeyEnv(config.modelProviders),
    // Validated: an invalid IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY
    // throws instead of silently selecting a weaker mode.
    sandboxPolicy: readSandboxPolicyEnv()?.policy ?? config.sandboxPolicy,
  };
}

/**
 * Layers the OPENROUTER_API_KEY env var over EVERY openrouter profile's
 * resolved apiKey (env fills/overrides). Resolution: `env || profile.apiKey`.
 * When the env var is unset, the config-resolved key is left unchanged.
 */
function providerKeyOverrides(): ReadonlyMap<string, string | undefined> {
  return new Map(getProviderEditorDescriptors().map(({ id, credentialEnv }) => [id, process.env[credentialEnv]]));
}

function applyProviderKeyEnv(config: ResolvedModelProvidersConfig): ResolvedModelProvidersConfig {
  const overrides = providerKeyOverrides();
  if (![...overrides.values()].some(Boolean)) return config;
  const profiles: Record<string, ResolvedProviderProfile> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    const key = overrides.get(profile.type);
    profiles[name] = profile.type !== 'native' && key ? { ...profile, apiKey: key } : profile;
  }
  return { default: config.default, profiles };
}

/**
 * Validates a base-URL environment variable using the same schema as the
 * config file (`z.url()`). Returns the validated string when set, or
 * `undefined` when the env var is unset/empty (callers fall back to the
 * config-file value). Throws on malformed URLs so misconfiguration surfaces
 * at config load instead of as an opaque fetch failure later.
 */
function validateBaseUrlEnv(envVarName: string): string | undefined {
  const value = process.env[envVarName];
  if (!value) return undefined;
  const parsed = z.url().safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? 'invalid URL';
    throw new Error(`Invalid ${envVarName}: ${detail} (got: ${JSON.stringify(value)})`);
  }
  return parsed.data;
}

/**
 * Validates a model ID string for use in text prompt validators.
 * Returns undefined on success, or an error message string on failure.
 */
export function validateModelId(id: string): string | undefined {
  const result = qualifiedModelId.safeParse(id);
  if (result.success) return undefined;
  return result.error.issues[0]?.message ?? 'Invalid model ID';
}

/**
 * Validates a model ID the way workflow definitions do ({@link looseModelId}:
 * Ollama-style "name:tag" IDs are accepted). Used for the workflow `--model`
 * flags, so a CLI override is held to the same rules as the YAML it overrides.
 * Returns undefined on success, or an error message.
 */
export function validateWorkflowModelId(id: string): string | undefined {
  const result = looseModelId.safeParse(id);
  if (result.success) return undefined;
  return result.error.issues[0]?.message ?? 'Invalid model ID';
}

/**
 * Deep-merges changes into an existing config object one level deep.
 * For nested objects, merges sub-fields rather than replacing the whole object.
 * Correctly handles null values for nullable budget fields.
 * An empty object ({}) signals "delete this section" — used by the config
 * editor's "Disable" action (e.g., disabling webSearch).
 */
function deepMergeConfig(existing: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  // Start with existing, then collect keys to remove (empty-object sentinel)
  const keysToRemove = new Set<string>();
  const result = { ...existing };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined && isPlainObject(value) && Object.keys(value).length === 0) {
      // Empty object = delete this section
      keysToRemove.add(key);
    } else if (value !== undefined && isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = { ...result[key], ...value };
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  // Build final object excluding removed keys
  if (keysToRemove.size === 0) return result;
  return Object.fromEntries(Object.entries(result).filter(([k]) => !keysToRemove.has(k)));
}

/**
 * Prevents provider environment API keys from being persisted to disk.
 *
 * `applyProviderKeyEnv` layers each service env key onto its profiles'
 * resolved `apiKey` at load time, so the editor and web-UI dispatch — which read
 * resolved config — would otherwise bake that env secret into config.json on any
 * `modelProviders` edit (silently, since the masked apiKey diff shows no change).
 * That defeats the point of the env var and contradicts the editor's "API keys
 * are excluded (use env vars)" design.
 *
 * At the single write chokepoint, any provider `apiKey` in the outgoing config
 * that equals the env value is replaced with the profile's ON-DISK key (so a
 * genuine file-origin key survives) or omitted entirely (env-only profiles). A
 * user-typed key that differs from the env value is untouched. No-op when the
 * env var is unset.
 */
function stripEnvProviderKeys(
  merged: Record<string, unknown>,
  existing: Record<string, unknown>,
  profileRenames: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const overrides = providerKeyOverrides();
  if (![...overrides.values()].some(Boolean)) return merged;
  const mp = merged['modelProviders'];
  if (!isPlainObject(mp) || !isPlainObject(mp['profiles'])) return merged;

  const existingMp = existing['modelProviders'];
  const existingProfiles: Record<string, unknown> =
    isPlainObject(existingMp) && isPlainObject(existingMp['profiles']) ? existingMp['profiles'] : {};

  for (const [name, profile] of Object.entries(mp['profiles'])) {
    if (!isPlainObject(profile)) continue;
    const envKey = typeof profile['type'] === 'string' ? overrides.get(profile['type']) : undefined;
    if (!envKey || profile['apiKey'] !== envKey) continue;
    const fileProfile = existingProfiles[profileRenames[name] ?? name];
    const fileKey =
      isPlainObject(fileProfile) && fileProfile['type'] === profile['type'] && typeof fileProfile['apiKey'] === 'string'
        ? fileProfile['apiKey']
        : undefined;
    if (fileKey) profile['apiKey'] = fileKey;
    else delete profile['apiKey'];
  }
  return merged;
}

/**
 * Saves user config changes to ~/.ironcurtain/config.json.
 *
 * A locked read-modify-write: under the cross-process config lock it reads
 * the existing file (if any), deep-merges the changes (one level deep for
 * nested objects), validates the result with Zod, keeps the replaced file as
 * `config.json.bak` and atomically writes the result, owner-only. Saves from
 * other processes (the daemon's web UI, `ironcurtain config`, setup-signal)
 * are applied one after another, so none is lost.
 *
 * An existing file that is not valid JSON, or not a JSON object, is never
 * replaced: the save throws, as loadUserConfig does, and the file stays as it
 * is for the user to fix. Starting from an empty object instead would drop
 * every API key, server credential and Signal identity the file holds.
 *
 * A save that creates config.json records `setupCompleted: false` unless the
 * changes set the marker themselves (the first-start wizard sets `true`), so
 * a file created by `ironcurtain mcp`, setup-signal or the web UI still
 * leaves the wizard pending (see setup-state.ts).
 *
 * @throws Error if the existing file is unreadable or not a JSON object, if
 *   the merged config fails Zod validation, or if another process holds the
 *   lock for too long (FileLockTimeoutError). Nothing is written in these cases.
 */
export function saveUserConfig(changes: UserConfig, profileRenames: Readonly<Record<string, string>> = {}): void {
  const configPath = getUserConfigPath();
  withConfigLock(configPath, () => {
    const previous = readConfigText(configPath);
    const existing: Record<string, unknown> =
      previous === undefined ? { setupCompleted: false } : parseConfigForUpdate(previous, configPath);

    const merged = normalizeLegacyPreferredMode(
      stripEnvProviderKeys(deepMergeConfig(existing, changes), existing, profileRenames),
    );

    // Validate the merged result (only known fields)
    const result = userConfigSchema.safeParse(merged);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
      throw new Error(`Invalid config after merge:\n${issues}`);
    }

    // `dockerWorkloadRequestedSchema` accepts the previously documented
    // implementation-policy fields only as a compatibility input and transforms
    // them to the canonical network-access request. Persist that transformed block
    // so the next successful save completes the migration without rewriting or
    // stripping unrelated top-level configuration.
    const normalized = { ...merged };
    if (result.data.dockerWorkload !== undefined) {
      normalized['dockerWorkload'] = result.data.dockerWorkload;
    }

    writeConfigFile(configPath, JSON.stringify(normalized, null, 2) + '\n', previous);
  });
}
