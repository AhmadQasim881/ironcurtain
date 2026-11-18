/**
 * persona.json: its schema, and the one parser every reader goes through.
 *
 * `loadPersona` (resolve.ts) reads a persona's definition only through
 * {@link readPersonaDefinition}, so sessions, cron jobs, workflows, the CLI
 * and the web UI all see the same validated object, and `ironcurtain doctor`
 * judges a persona.json with {@link checkPersonaDefinition}, the same check.
 * The file is refused, never coerced (`PERSONA_INVALID`), when:
 *
 *  - it is not JSON, or a field has the wrong type: `servers` must be an
 *    array of server names (a bare string such as `"github"` would otherwise
 *    match server names character by character), `allowBroadPolicy` and
 *    `memory.enabled` must be booleans (the string `"false"` is truthy);
 *  - it carries a field this version does not know (a misspelled
 *    `"server"` would otherwise silently mean "every server");
 *  - its `name` is not the name of the directory it lives in. A persona
 *    directory copied by hand keeps the original's name in persona.json;
 *    trusting that name would send the copy's edits to the original, and a
 *    name such as `"../x"` would point outside `personas/`. Every path
 *    operation uses the directory name, and the stored name must agree with
 *    it (`ironcurtain persona clone` makes a correct copy).
 *
 * Whether the servers are configured is not checked here: a server removed
 * from the configuration later must not make its personas unloadable
 * (sessions warn about it instead, see `applyServerAllowlist`). Creating a
 * persona checks it (`validatePersonaServers`, persona-service.ts).
 *
 * `agentModelId` and `resourceBudget` are known fields, but their values are
 * checked where they take effect (persona-overrides.ts,
 * `PERSONA_OVERRIDES_INVALID`), never here: sessions, `ironcurtain start`,
 * cron runs and the persona pickers refuse a persona whose value is
 * malformed, while the persona itself stays loadable, so `ironcurtain
 * persona set` can repair it and `persona show` and doctor can report it.
 * Neither is ever coerced: the value is carried exactly as stored.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { SLUG_PATTERN } from '../types/slug.js';
import { describeSchemaIssues, formatArtifactProblems } from '../types/policy-schema.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import type { PersonaDefinition, PersonaName, PersonaResourceBudget } from './types.js';

/** Error code of {@link PersonaDefinitionError}; catch on it, not on the class. */
export const PERSONA_INVALID = 'PERSONA_INVALID';

/** Basename of a persona's definition file. */
export const PERSONA_DEFINITION_FILENAME = 'persona.json';

/**
 * A persona.json that exists but cannot be used: unreadable, not JSON, not
 * matching the schema, or naming another persona than its directory.
 * `problems` holds one line per problem, each naming the field.
 */
export class PersonaDefinitionError extends Error {
  readonly code = PERSONA_INVALID;
  /** The persona (directory name) whose definition was refused. */
  readonly persona: string;
  /** The definition file. */
  readonly path: string;
  readonly problems: readonly string[];

  constructor(persona: string, path: string, problems: readonly string[], options?: ErrorOptions) {
    super(formatArtifactProblems(`Persona "${persona}" has an invalid definition (${path})`, problems), options);
    this.name = 'PersonaDefinitionError';
    this.persona = persona;
    this.path = path;
    this.problems = problems;
  }
}

/** True for a {@link PersonaDefinitionError} (tested by code, not class). */
export function isPersonaDefinitionError(err: unknown): err is PersonaDefinitionError {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === PERSONA_INVALID;
}

const SLUG_RULE = 'lowercase letters, digits, "-" and "_", starting with a letter or digit, at most 63 characters';

/** A server name as a persona may list it (the shape only; see the module comment). */
const serverNameSchema = z.string().regex(SLUG_PATTERN, { error: `is not a server name (${SLUG_RULE})` });

const personaDefinitionSchema = z.strictObject({
  // Compared with the directory name separately (checkPersonaDefinition).
  name: z.string(),
  description: z.string(),
  createdAt: z.iso.datetime({
    offset: true,
    error: 'expected an ISO 8601 timestamp such as "2026-03-06T12:00:00.000Z"',
  }),
  servers: z.array(serverNameSchema).optional(),
  memory: z.strictObject({ enabled: z.boolean() }).optional(),
  memoryNamespace: z
    .string()
    .regex(SLUG_PATTERN, { error: `is not a memory namespace (${SLUG_RULE})` })
    .optional(),
  allowBroadPolicy: z.boolean().optional(),
  // Values checked where they take effect (see the module comment).
  agentModelId: z.unknown().optional(),
  resourceBudget: z.unknown().optional(),
});

/** What {@link checkPersonaDefinition} found: the usable definition, or every problem. */
export type PersonaDefinitionCheck =
  | { readonly ok: true; readonly definition: PersonaDefinition }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks a parsed persona.json for the persona whose directory is `dirName`.
 * Every problem is reported at once: the stored name is compared with the
 * directory name even when other fields are wrong. The definition returned
 * holds only the known fields, and its `name` is `dirName`; `agentModelId`
 * and `resourceBudget` are carried as stored, for `readPersonaOverrides`
 * (persona-overrides.ts) to check.
 */
export function checkPersonaDefinition(value: unknown, dirName: PersonaName): PersonaDefinitionCheck {
  const result = personaDefinitionSchema.safeParse(value, { reportInput: true });
  const problems = result.success ? [] : describeSchemaIssues(result.error.issues);
  const storedName = isPlainObject(value) ? value.name : undefined;
  if (typeof storedName === 'string' && storedName !== dirName) {
    problems.push(nameProblem(storedName, dirName));
  }
  if (!result.success || problems.length > 0) return { ok: false, problems };

  const data = result.data;
  return {
    ok: true,
    definition: {
      name: dirName,
      description: data.description,
      createdAt: data.createdAt,
      ...(data.servers !== undefined ? { servers: data.servers } : {}),
      ...(data.memory !== undefined ? { memory: { enabled: data.memory.enabled } } : {}),
      ...(data.memoryNamespace !== undefined ? { memoryNamespace: data.memoryNamespace } : {}),
      ...(data.allowBroadPolicy !== undefined ? { allowBroadPolicy: data.allowBroadPolicy } : {}),
      // Unchecked here (the casts do not validate): every reader that applies
      // them goes through readPersonaOverrides, which refuses a malformed one.
      ...(data.agentModelId !== undefined ? { agentModelId: data.agentModelId as string } : {}),
      ...(data.resourceBudget !== undefined ? { resourceBudget: data.resourceBudget as PersonaResourceBudget } : {}),
    },
  };
}

/**
 * Validates a parsed persona.json for the persona whose directory is
 * `dirName` (see {@link checkPersonaDefinition}).
 *
 * @throws {PersonaDefinitionError} listing every problem.
 */
export function parsePersonaDefinition(value: unknown, dirName: PersonaName, path: string): PersonaDefinition {
  const check = checkPersonaDefinition(value, dirName);
  if (!check.ok) throw new PersonaDefinitionError(dirName, path, check.problems);
  return check.definition;
}

function nameProblem(stored: string, dirName: PersonaName): string {
  if (!SLUG_PATTERN.test(stored)) {
    return `name: ${JSON.stringify(stored)} is not a persona name (${SLUG_RULE})`;
  }
  // Kept under the 500 characters an error message line shows, even for two
  // 63-character names, so the clone command is never cut off.
  return (
    `name: ${JSON.stringify(stored)} does not match the persona's directory name "${dirName}" ` +
    `(a hand-copied persona directory?). Set "name" to "${dirName}" and recompile it, or remove the copy ` +
    `and run: ironcurtain persona clone ${stored} ${dirName}`
  );
}

/**
 * Reads and validates the persona.json at `path`, which must belong to the
 * persona `expectedName` (its directory name).
 *
 * @throws an error with code `PERSONA_NOT_FOUND` when the file does not
 *   exist, or a {@link PersonaDefinitionError} when it cannot be used.
 */
export function readPersonaDefinition(path: string, expectedName: PersonaName): PersonaDefinition {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw Object.assign(new Error(`Persona "${expectedName}" not found: ${path} does not exist.`, { cause: err }), {
        code: 'PERSONA_NOT_FOUND',
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new PersonaDefinitionError(expectedName, path, [`cannot be read: ${reason}`], { cause: err });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PersonaDefinitionError(expectedName, path, [`is not valid JSON: ${reason}`], { cause: err });
  }
  return parsePersonaDefinition(value, expectedName, path);
}
