/**
 * Persona-level agent model and resource-budget overrides
 * (`agentModelId` and `resourceBudget` in persona.json).
 *
 * `loadPersona` validates persona.json against its schema
 * (persona-definition.ts), which knows these two fields but carries their
 * values unchecked, so a malformed one never makes the persona unloadable
 * (`persona set` can repair it). They are validated here, when they are about
 * to take effect: the session factory (`buildSessionConfig`) reads them through
 * {@link readPersonaOverrides} for every persona session, and `ironcurtain
 * start` does the same before its preflight. A malformed value refuses the
 * session with a {@link PersonaOverridesError} naming the persona and the
 * field, instead of silently running on the global model or limits: a budget
 * typo must never lift a cost cap. The persona service validates the same
 * way before it writes either field.
 *
 * Where each value sits in the precedence chain is documented in
 * src/session/model-budget-precedence.ts, which applies them.
 */

import { looseModelId, resourceBudgetFieldsSchema } from '../config/user-config.js';
import { modelFlagMisusedAsAgent } from '../config/agent-model-guard.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { loadPersona } from './resolve.js';
import { createPersonaName, type PersonaDefinition, type PersonaResourceBudget } from './types.js';

/** Discriminant of {@link PersonaOverridesError}; match on it rather than `instanceof`. */
export const PERSONA_OVERRIDES_INVALID = 'PERSONA_OVERRIDES_INVALID';

/** A persona's `agentModelId` or `resourceBudget` is malformed. */
export class PersonaOverridesError extends Error {
  readonly code = PERSONA_OVERRIDES_INVALID;

  constructor(
    readonly persona: string,
    message: string,
  ) {
    super(message);
    this.name = 'PersonaOverridesError';
  }
}

/** True for a {@link PersonaOverridesError}, recognized by its `code`. */
export function isPersonaOverridesError(err: unknown): err is PersonaOverridesError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PERSONA_OVERRIDES_INVALID;
}

/** The validated overrides of one persona. An absent field overrides nothing. */
export interface PersonaOverrides {
  readonly agentModelId?: string;
  readonly resourceBudget?: PersonaResourceBudget;
}

/** Outcome of checking one override value. */
export type OverrideCheck<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** Same fields as `resourceBudget` in config.json (no model prices); unknown keys are rejected. */
const personaResourceBudgetSchema = resourceBudgetFieldsSchema.strict();

/**
 * Printable ASCII without spaces, at most 200 characters. Every provider,
 * gateway and Ollama model ID fits; a control or format character never
 * reaches a terminal, a log line or the agent's command line.
 */
const MODEL_ID_CHARACTERS = /^[\x21-\x7e]{1,200}$/;

/**
 * Checks a value for a persona's `agentModelId`: the model-ID grammar of a
 * workflow's `model` fields (provider-qualified, bare, or a gateway
 * "name:tag" ID), in printable ASCII, and never an agent name:
 * `"claude-code"` is an agent, not a model.
 */
export function parsePersonaAgentModelId(value: unknown): OverrideCheck<string> {
  const parsed = looseModelId.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problem: parsed.error.issues[0]?.message ?? 'not a valid model ID' };
  }
  if (!MODEL_ID_CHARACTERS.test(parsed.data)) {
    return { ok: false, problem: 'a model ID is at most 200 printable ASCII characters, without spaces' };
  }
  if (modelFlagMisusedAsAgent(parsed.data) !== null) {
    return { ok: false, problem: `"${parsed.data}" is an agent, not a model` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Checks a value for a persona's `resourceBudget`: an object with any of
 * `maxTotalTokens`, `maxSteps`, `maxSessionSeconds`, `maxEstimatedCostUsd`
 * (positive, or `null` to disable the limit) and `warnThresholdPercent`
 * (1-99), and nothing else.
 */
export function parsePersonaResourceBudget(value: unknown): OverrideCheck<PersonaResourceBudget> {
  const parsed = personaResourceBudgetSchema.safeParse(value);
  if (parsed.success) {
    // Drop keys explicitly set to undefined so a spread never clears a lower layer.
    const budget: Record<string, number | null> = {};
    for (const key of Object.keys(parsed.data) as (keyof typeof parsed.data)[]) {
      const limit = parsed.data[key];
      if (limit !== undefined) budget[key] = limit;
    }
    return { ok: true, value: budget };
  }
  const issue = parsed.error.issues.at(0);
  if (issue === undefined) return { ok: false, problem: 'not a valid resource budget' };
  const where = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  // An unknown key is echoed in the message; it comes from the file.
  return { ok: false, problem: toDisplayText(`${where}${issue.message}`, { maxLength: 200 }) };
}

/**
 * Reads and validates the overrides of a loaded persona definition. `name`
 * is the validated persona name the definition was loaded under (error
 * messages never echo the file's own `name` field).
 *
 * @throws {PersonaOverridesError} when `agentModelId` or `resourceBudget` is
 *   present but malformed. Callers refuse the session.
 */
export function readPersonaOverrides(name: string, persona: PersonaDefinition): PersonaOverrides {
  // The persona.json schema carries both fields unchecked: treat them as unknown.
  const raw = persona as unknown as { readonly agentModelId?: unknown; readonly resourceBudget?: unknown };
  const fix = `Fix it with "ironcurtain persona set ${name}", or remove the field from its persona.json.`;

  let agentModelId: string | undefined;
  if (raw.agentModelId !== undefined) {
    const parsed = parsePersonaAgentModelId(raw.agentModelId);
    if (!parsed.ok) {
      throw new PersonaOverridesError(
        name,
        `Persona "${name}" has an invalid agentModelId (${parsed.problem}). ${fix}`,
      );
    }
    agentModelId = parsed.value;
  }

  let resourceBudget: PersonaResourceBudget | undefined;
  if (raw.resourceBudget !== undefined) {
    const parsed = parsePersonaResourceBudget(raw.resourceBudget);
    if (!parsed.ok) {
      throw new PersonaOverridesError(
        name,
        `Persona "${name}" has an invalid resourceBudget (${parsed.problem}). ${fix}`,
      );
    }
    resourceBudget = parsed.value;
  }

  return {
    ...(agentModelId !== undefined ? { agentModelId } : {}),
    ...(resourceBudget !== undefined ? { resourceBudget } : {}),
  };
}

/**
 * The problem with the overrides of the persona named `name`, or undefined
 * when they are valid. A persona that cannot be loaded at all is left to
 * whoever resolves it, which reports that (undefined here). For callers that
 * gate work on a persona before any session exists, like a cron job run.
 */
export function findPersonaOverridesProblem(name: string): string | undefined {
  let persona: PersonaDefinition;
  try {
    persona = loadPersona(createPersonaName(name));
  } catch {
    return undefined;
  }
  try {
    readPersonaOverrides(name, persona);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
