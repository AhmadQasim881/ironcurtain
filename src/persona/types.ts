/**
 * Persona types -- named profiles bundling a constitution and compiled
 * policy under ~/.ironcurtain/personas/<name>/.
 *
 * Follows the same branded-type pattern as JobId in src/cron/types.ts.
 */

import { SLUG_PATTERN, validateSlug } from '../types/slug.js';
import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';

/**
 * Regex for valid persona names: 1-63 chars, lowercase alphanumeric,
 * hyphens, or underscores. Same rules as JobId.
 */
export const PERSONA_NAME_PATTERN: RegExp = SLUG_PATTERN;

/**
 * Branded persona name to prevent mixing with other string identifiers.
 */
export type PersonaName = string & { readonly __brand: 'PersonaName' };

/**
 * Validates and creates a PersonaName from a user-provided string.
 */
export function createPersonaName(raw: string): PersonaName {
  validateSlug(raw, 'persona name');
  return raw as PersonaName;
}

/** Per-persona memory configuration. */
export interface PersonaMemoryConfig {
  /**
   * Whether the memory MCP server is mounted into sessions for this
   * persona. Defaults to true when this whole block is absent.
   * The global kill switch (`userConfig.memory.enabled`) ANDs with this:
   * if the global is off, memory is off regardless of this field.
   */
  readonly enabled: boolean;
}

/**
 * Per-persona resource limits, the same fields as `resourceBudget` in
 * ~/.ironcurtain/config.json (model prices excluded). A missing field
 * inherits; `null` disables that limit for the persona's sessions.
 */
export type PersonaResourceBudget = Partial<ResolvedResourceBudgetConfig>;

/**
 * Persisted persona definition. Stored as JSON at
 * ~/.ironcurtain/personas/{name}/persona.json, and only ever read through
 * `loadPersona` (resolve.ts), which validates it against the schema in
 * persona-definition.ts: a file whose fields have the wrong type, carries an
 * unknown field, or names another persona than its directory is refused
 * (`PERSONA_INVALID`), never coerced. The values of `agentModelId` and
 * `resourceBudget` are carried unchecked and judged where they take effect
 * (`readPersonaOverrides`, persona-overrides.ts: `PERSONA_OVERRIDES_INVALID`).
 */
export interface PersonaDefinition {
  /**
   * Persona name. Always equal to the persona's directory name: a
   * persona.json naming another persona (a copied directory) is refused.
   */
  readonly name: PersonaName;

  /** Human-readable description of the persona's purpose. */
  readonly description: string;

  /** ISO 8601 timestamp of when the persona was created. */
  readonly createdAt: string;

  /**
   * Optional allowlist of MCP server names from the global
   * mcp-servers.json. When set, only these servers are available.
   * When omitted, all global servers are enabled (default).
   * The "filesystem" server is always included regardless. Creating a
   * persona refuses a name that is not a configured server; a server removed
   * from the configuration later is only warned about when sessions load the
   * persona.
   */
  readonly servers?: readonly string[];

  /**
   * Optional memory configuration. Absent = use defaults (memory on,
   * subject to the global kill switch). Present = explicit per-persona
   * choice, persisted across upgrades.
   */
  readonly memory?: PersonaMemoryConfig;

  /**
   * The namespace this persona's sessions use inside its own memory.db.
   * Absent = the persona name. Set by a rename (`persona rename`, and a
   * trash restore under another name) to the namespace the memories were
   * stored under, so renaming a persona never hides its memories. It selects
   * memories only within the persona's own database
   * (`personas/<name>/memory.db`), never another persona's.
   */
  readonly memoryNamespace?: string;

  /**
   * Whether this persona is authorized to compile and run a "broad" policy.
   * Unless it is exactly `true`, the Phase-1c broad-policy validator (the
   * `validateCompiled` hook of every compile, CLI or web UI, see
   * persona-compile-service.ts) rejects any compiled policy with an `allow`
   * rule (or an `assess` rule, an allow subject to the outbound content
   * assessment) that has a broad wildcard in `domains.allowed` or
   * `lists[].allowed` (`'*'`, or a wildcard over a public suffix such as
   * `'*.com'` or `'*.github.io'`), a `paths.within` resolving outside the
   * persona's workspace dir, or a resource argument left unconstrained (see
   * broad-policy-validator.ts), and `resolvePersona` refuses such a policy
   * already on disk. `escalate` rules are never rejected. Set ONLY via
   * `setPersonaBroadPolicyOptIn` (the gated `personas.setBroadPolicyOptIn`,
   * `ironcurtain persona compile --allow-broad`, the `persona edit` toggle) —
   * it is NEVER inferred from the constitution text. Clearing it moves a
   * compiled policy that needed it aside. This is the opt-in that defeats
   * constitution prompt-injection toward an over-permissive policy. Added in
   * Phase 1c. It is also the persona's opt-in for the pipeline policy lint's
   * broad domain check (`allowBroadDomains`, pipeline/policy-lint.ts), which
   * runs on every persona compile, CLI included.
   */
  readonly allowBroadPolicy?: boolean;

  /**
   * Optional agent model for this persona's sessions ("provider:model-name",
   * or a bare or gateway "name:tag" ID, as in workflow `model` fields).
   * Precedence, highest first: `--model` on the command line, the workflow
   * state's `model`, the workflow's `settings.model`, this field, then the
   * global `agentModelId`. Validated when the persona is resolved for a
   * session; an invalid value refuses the session (see persona-overrides.ts).
   */
  readonly agentModelId?: string;

  /**
   * Optional resource limits for this persona's sessions. Each field sits
   * above the caller's defaults (the global `resourceBudget`, the cron
   * defaults, a workflow run's inherited limits) and below the limits the
   * caller sets explicitly (a cron job's `budgetOverrides`, a workflow's
   * `settings.resourceBudget`). Validated when the persona is resolved for a
   * session, like {@link agentModelId}.
   */
  readonly resourceBudget?: PersonaResourceBudget;
}
