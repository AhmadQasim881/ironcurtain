/**
 * Persona-related JSON-RPC method dispatch.
 *
 * Handles `personas.*` methods: list, get, the Phase 1b streamed compile + its
 * read methods (compileStream / getCompile / listCompiles), the Phase 1c
 * CRUD methods, the lifecycle methods (clone / rename / listTrash /
 * restoreTrash / purgeTrash), and listServers (the configured servers the
 * create form's picker offers). There is a SINGLE compile surface
 * (compileStream) — it is both kill-switch gated and runs the broad-policy
 * validator. The old blocking `personas.compile` method was removed in
 * Phase 1c because it was an ungated, unvalidated second compile path.
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import { validateParams } from './types.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import {
  type PersonaDetailDto,
  type PersonaEditResultDto,
  type PersonaCompileStreamAckDto,
  type PersonaCompileOperationDto,
  type PersonaListCompilesDto,
  type PersonaRestoreResultDto,
  type PersonaTrashEntryDto,
  type PersonaTrashPurgeResultDto,
  RpcError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import {
  getPersonaDetail as getPersonaDetailService,
  listPersonas,
  createPersona as createPersonaService,
  setPersonaConstitution as setPersonaConstitutionService,
  setPersonaMemory as setPersonaMemoryService,
  deletePersona as deletePersonaService,
  setPersonaBroadPolicyOptIn as setPersonaBroadPolicyOptInService,
  clonePersona as clonePersonaService,
  renamePersona as renamePersonaService,
  listPersonaTrashEntries,
  restorePersona as restorePersonaService,
  purgePersonaTrash as purgePersonaTrashService,
  sweepPersonaTrash,
  listPersonaServerNames,
  PERSONA_UNKNOWN_SERVERS,
  type PersonaTrashPurgeSelection,
} from '../../persona/persona-service.js';
import { loadPersona } from '../../persona/resolve.js';
import { PERSONA_INVALID } from '../../persona/persona-definition.js';
import { PERSONA_OVERRIDES_INVALID } from '../../persona/persona-overrides.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from '../../persona/types.js';
import { personaCompileOrchestrator, CompileOrchestratorError } from '../../persona/persona-compile-orchestrator.js';
import { getConnId } from '../conn-registry.js';

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const personaNameSchema = z.object({ name: z.string().min(1) });
const getCompileSchema = z.object({ operationId: z.string().min(1) });
const listCompilesSchema = z.object({});

// ---------------------------------------------------------------------------
// Phase 1c persona-CRUD param schemas (locked contract; handlers added in the
// implementation stage). Exported so they form part of the wire contract and
// can be unit-tested independently. All mutation methods are additionally
// gated on `ctx.allowPolicyMutation` in the dispatch switch (else
// POLICY_MUTATION_FORBIDDEN); the schemas only validate shape.
// ---------------------------------------------------------------------------

/** `personas.create` -> PersonaDetailDto. Slug is branded inside the service. */
export const createPersonaSchema = z.object({
  name: z.string().min(1).max(63),
  description: z.string().trim().min(1),
  servers: z.array(z.string().trim().min(1)).optional(),
  memoryEnabled: z.boolean().optional(),
  constitution: z.string().optional(), // default '' inside the service (empty persona)
});

/** `personas.editConstitution` -> PersonaEditResultDto { stale }. */
export const editConstitutionSchema = z.object({
  name: z.string().min(1),
  constitution: z.string(),
});

/** `personas.setMemory` -> PersonaDetailDto. */
export const setMemorySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * `personas.delete` (soft by default) -> { deleted: true }.
 * `confirmed: z.literal(true)` makes an unconfirmed call a schema error;
 * confirmation lives in the UI. `force: true` => hard delete (revoke policy).
 */
export const deletePersonaSchema = z.object({
  name: z.string().min(1),
  confirmed: z.literal(true),
  force: z.boolean().optional(),
});

/**
 * `personas.setBroadPolicyOptIn` (gated) -> PersonaDetailDto. The ONLY way to
 * set `allowBroadPolicy`; never inferred from the constitution. Disabling it
 * moves a compiled policy that needed it aside (the detail then reports
 * `hasPolicy: false`), and fails with COMPILE_IN_PROGRESS while the persona
 * is being compiled.
 */
export const setBroadPolicyOptInSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * `personas.clone` (gated) -> PersonaDetailDto of the new persona: a copy of
 * `name`'s constitution, description (unless given), servers, memory setting,
 * agent model, resource limits and skills; not its compiled policy,
 * workspace, memory or broad-policy opt-in. Errors: INVALID_PARAMS (bad
 * slug), PERSONA_EXISTS, PERSONA_NOT_FOUND, PERSONA_INVALID (also for a
 * malformed agent model or resource limits, which are never copied).
 */
export const clonePersonaSchema = z.object({
  name: z.string().min(1),
  newName: z.string().min(1).max(63),
  description: z.string().optional(),
});

/**
 * `personas.rename` (gated) -> PersonaDetailDto under the new name. The
 * compiled policy is moved aside (`hasPolicy: false`; recompile). Errors:
 * INVALID_PARAMS, PERSONA_EXISTS, PERSONA_NOT_FOUND, PERSONA_INVALID,
 * COMPILE_IN_PROGRESS.
 */
export const renamePersonaSchema = z.object({
  name: z.string().min(1),
  newName: z.string().min(1).max(63),
});

/** `personas.listTrash` (read, ungated) -> PersonaTrashEntryDto[] (newest first). */
export const listTrashSchema = z.object({});

/**
 * `personas.listServers` (read, ungated) -> string[]: the configured MCP
 * servers a persona's allowlist may name (`listPersonaServerNames`: the
 * built-ins, then the user's own servers), which the create form's picker
 * offers. Names only. A server configuration that cannot be loaded fails the
 * call (no partial list); the picker then offers no narrowing.
 */
export const listServersSchema = z.object({});

/**
 * `personas.restoreTrash` (gated) -> PersonaRestoreResultDto. `entry` is a
 * trash entry id (or a persona name: its newest entry). A persona with the
 * target name is never overwritten: PERSONA_EXISTS unless `force`, which
 * moves it to the trash first. `as` restores under another name.
 */
export const restoreTrashSchema = z.object({
  entry: z.string().min(1),
  as: z.string().min(1).max(63).optional(),
  force: z.boolean().optional(),
});

/**
 * `personas.purgeTrash` (gated) -> PersonaTrashPurgeResultDto. Permanently
 * removes the entries named (ids, or persona names for all their entries),
 * the expired ones, or all; exactly one selector. `confirmed: true` is
 * required, as for `personas.delete`.
 */
export const purgeTrashSchema = z
  .object({
    entries: z.array(z.string().min(1)).min(1).optional(),
    expired: z.literal(true).optional(),
    all: z.literal(true).optional(),
    confirmed: z.literal(true),
  })
  .refine(
    (params) =>
      [params.entries !== undefined, params.expired === true, params.all === true].filter(Boolean).length === 1,
    { message: 'give exactly one of entries, expired or all' },
  );

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// The streamed compile is fire-and-return (the old blocking `personas.compile`
// that awaited the pipeline was removed). Only the trash methods that remove
// directories await (an asynchronous `rm`, so a large workspace does not block
// the event loop); a thrown RpcError is normalized into a rejected promise for
// callers that `await` it.
export async function personaDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
  client?: WsWebSocket,
): Promise<unknown> {
  switch (method) {
    case 'personas.list': {
      return listPersonas();
    }

    case 'personas.get': {
      const { name } = validateParams(personaNameSchema, params);
      return getPersonaDetail(name);
    }

    case 'personas.compileStream': {
      const { name } = validateParams(personaNameSchema, params);
      return compileStream(ctx, name, client);
    }

    case 'personas.getCompile': {
      const { operationId } = validateParams(getCompileSchema, params);
      return getCompile(operationId);
    }

    case 'personas.listCompiles': {
      validateParams(listCompilesSchema, params);
      return listCompiles();
    }

    // -----------------------------------------------------------------------
    // Phase 1c CRUD (all gated on ctx.allowPolicyMutation; gate fires BEFORE
    // any fs read). Each mutation emits `personas.changed`.
    // -----------------------------------------------------------------------

    case 'personas.create': {
      requirePolicyMutation(ctx);
      const input = validateParams(createPersonaSchema, params);
      return createPersonaHandler(ctx, input, client);
    }

    case 'personas.editConstitution': {
      requirePolicyMutation(ctx);
      const { name, constitution } = validateParams(editConstitutionSchema, params);
      return editConstitutionHandler(ctx, name, constitution, client);
    }

    case 'personas.setMemory': {
      requirePolicyMutation(ctx);
      const { name, enabled } = validateParams(setMemorySchema, params);
      return setMemoryHandler(ctx, name, enabled, client);
    }

    case 'personas.delete': {
      requirePolicyMutation(ctx);
      const { name, force } = validateParams(deletePersonaSchema, params);
      return await deletePersonaHandler(ctx, name, force ?? false, client);
    }

    case 'personas.setBroadPolicyOptIn': {
      requirePolicyMutation(ctx);
      const { name, enabled } = validateParams(setBroadPolicyOptInSchema, params);
      return setBroadPolicyOptInHandler(ctx, name, enabled, client);
    }

    // -----------------------------------------------------------------------
    // Lifecycle (mutations gated like the CRUD methods; listTrash is a read)
    // -----------------------------------------------------------------------

    case 'personas.clone': {
      requirePolicyMutation(ctx);
      const { name, newName, description } = validateParams(clonePersonaSchema, params);
      return clonePersonaHandler(ctx, name, newName, description, client);
    }

    case 'personas.rename': {
      requirePolicyMutation(ctx);
      const { name, newName } = validateParams(renamePersonaSchema, params);
      return renamePersonaHandler(ctx, name, newName, client);
    }

    case 'personas.listTrash': {
      validateParams(listTrashSchema, params);
      return listPersonaTrashEntries() satisfies PersonaTrashEntryDto[];
    }

    case 'personas.restoreTrash': {
      requirePolicyMutation(ctx);
      const input = validateParams(restoreTrashSchema, params);
      return await restoreTrashHandler(ctx, input, client);
    }

    case 'personas.purgeTrash': {
      requirePolicyMutation(ctx);
      const input = validateParams(purgeTrashSchema, params);
      return await purgeTrashHandler(ctx, input, client);
    }

    case 'personas.listServers': {
      validateParams(listServersSchema, params);
      return listPersonaServerNames();
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Brands a raw persona name, throwing INVALID_PARAMS for one that is not a valid slug. */
function personaNameOrThrow(nameRaw: string): PersonaName {
  try {
    return createPersonaName(nameRaw);
  } catch {
    throw new RpcError('INVALID_PARAMS', `Invalid persona name: ${nameRaw}`);
  }
}

/**
 * Validates the raw name string and loads the persona, throwing RpcError on
 * failure: PERSONA_INVALID when its persona.json exists but cannot be used
 * (with the loader's reasons), PERSONA_NOT_FOUND otherwise.
 */
function resolvePersonaOrThrow(nameRaw: string): { name: PersonaName; persona: PersonaDefinition } {
  const name = personaNameOrThrow(nameRaw);

  let persona;
  try {
    persona = loadPersona(name);
  } catch (err) {
    if (errorCode(err) === PERSONA_INVALID) {
      throw new RpcError('PERSONA_INVALID', err instanceof Error ? err.message : 'Persona definition is invalid.');
    }
    throw new RpcError('PERSONA_NOT_FOUND', `Persona "${nameRaw}" not found`);
  }

  return { name, persona };
}

/** The discriminant `code` a service error carries, if any. */
function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function getPersonaDetail(nameRaw: string): PersonaDetailDto {
  // Validate + map to RpcError consistently with the other persona methods,
  // then delegate the fs reads to the headless service (Phase 1a).
  const { name } = resolvePersonaOrThrow(nameRaw);
  return getPersonaDetailService(name);
}

/**
 * Fire-and-return streamed compile (Phase 1b). Gated behind the daemon's
 * `allowPolicyMutation` kill switch: when off (the DEFAULT), the mutation
 * surface does not exist — return POLICY_MUTATION_FORBIDDEN BEFORE any
 * credential read so a read-only client never learns credential state.
 */
function compileStream(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  client?: WsWebSocket,
): PersonaCompileStreamAckDto {
  if (ctx.allowPolicyMutation !== true) {
    throw new RpcError('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon.');
  }
  const { name } = resolvePersonaOrThrow(nameRaw);
  const actor = describeActor(client);
  try {
    return personaCompileOrchestrator.startCompile(name, actor, ctx.eventBus);
  } catch (err) {
    if (err instanceof CompileOrchestratorError) {
      throw new RpcError(err.code, err.message, err.data);
    }
    throw err;
  }
}

function getCompile(operationId: string): PersonaCompileOperationDto {
  const op = personaCompileOrchestrator.getCompile(operationId);
  if (!op) {
    throw new RpcError('PERSONA_NOT_FOUND', `No compile operation "${operationId}"`);
  }
  return op;
}

function listCompiles(): PersonaListCompilesDto {
  return personaCompileOrchestrator.listCompiles();
}

/**
 * Kill-switch gate shared by all mutation methods. Throws
 * POLICY_MUTATION_FORBIDDEN when the daemon was not launched with
 * `--allow-policy-mutation`. Fires BEFORE any fs/credential read so a read-only
 * client never learns persona/credential state.
 */
function requirePolicyMutation(ctx: WorkflowDispatchContext): void {
  if (ctx.allowPolicyMutation !== true) {
    throw new RpcError('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon.');
  }
}

/**
 * Maps a persona-service thrown error (which carries a discriminant `code`
 * string set via Object.assign) onto a typed RpcError. Unknown errors bubble.
 */
function rethrowServiceError(err: unknown): never {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : undefined;
  if (code === 'PERSONA_EXISTS') {
    throw new RpcError('PERSONA_EXISTS', message ?? 'Persona already exists.');
  }
  if (code === 'PERSONA_NOT_FOUND') {
    throw new RpcError('PERSONA_NOT_FOUND', message ?? 'Persona not found.');
  }
  // A clone copies its source's agent model and resource limits, and refuses
  // a malformed one: the source's persona.json cannot be used for that.
  if (code === PERSONA_INVALID || code === PERSONA_OVERRIDES_INVALID) {
    throw new RpcError('PERSONA_INVALID', message ?? 'Persona definition is invalid.');
  }
  if (code === PERSONA_UNKNOWN_SERVERS) {
    throw new RpcError('INVALID_PARAMS', message ?? 'Unknown MCP server.');
  }
  // A broad-policy opt-out, a delete, a rename and a forced restore take the
  // persona's compile lock: refused while a compile (from the web UI or the
  // CLI) runs.
  if (err instanceof CompileOrchestratorError && err.code === 'COMPILE_IN_PROGRESS') {
    throw new RpcError(err.code, err.message, err.data);
  }
  throw err;
}

/**
 * Runs a persona-service mutation under the WS actor, maps service errors to
 * RpcError (via rethrowServiceError), emits `personas.changed`, and returns the
 * mutation's result. Centralizes the per-handler try/catch + change-event
 * boilerplate so a new mutation method cannot forget the notification.
 */
function mutateAndEmit<T>(ctx: WorkflowDispatchContext, mutate: (actor: string) => T, client?: WsWebSocket): T {
  let result: T;
  try {
    result = mutate(describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return result;
}

/** {@link mutateAndEmit} for an asynchronous mutation. */
async function mutateAndEmitAsync<T>(
  ctx: WorkflowDispatchContext,
  mutate: (actor: string) => Promise<T>,
  client?: WsWebSocket,
): Promise<T> {
  let result: T;
  try {
    result = await mutate(describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return result;
}

function createPersonaHandler(
  ctx: WorkflowDispatchContext,
  input: { name: string; description: string; servers?: string[]; memoryEnabled?: boolean; constitution?: string },
  client?: WsWebSocket,
): PersonaDetailDto {
  // Validate the slug up front so a bad name is INVALID_PARAMS (not a raw throw).
  // An unknown server is INVALID_PARAMS too (rethrowServiceError).
  personaNameOrThrow(input.name);
  return mutateAndEmit(ctx, (actor) => createPersonaService(input, actor), client);
}

function editConstitutionHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  constitution: string,
  client?: WsWebSocket,
): PersonaEditResultDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  return mutateAndEmit(ctx, (actor) => setPersonaConstitutionService(name, constitution, actor), client);
}

function setMemoryHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  enabled: boolean,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  mutateAndEmit(ctx, (actor) => setPersonaMemoryService(name, enabled, actor), client);
  return getPersonaDetailService(name);
}

/**
 * Deletes a persona (soft by default). Only the name is validated: a persona
 * whose persona.json is invalid can still be deleted. After a soft delete
 * the retention sweep purges expired trash entries (best effort, awaited so
 * the reply follows the housekeeping, which never fails the delete).
 */
async function deletePersonaHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  force: boolean,
  client?: WsWebSocket,
): Promise<{ deleted: true }> {
  const name = personaNameOrThrow(nameRaw);
  mutateAndEmit(ctx, (actor) => deletePersonaService(name, actor, { force }), client);
  if (!force) await sweepPersonaTrash(describeActor(client));
  return { deleted: true };
}

function setBroadPolicyOptInHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  enabled: boolean,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  return mutateAndEmit(ctx, (actor) => setPersonaBroadPolicyOptInService(name, enabled, actor), client);
}

function clonePersonaHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  newNameRaw: string,
  description: string | undefined,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  const newName = personaNameOrThrow(newNameRaw);
  return mutateAndEmit(
    ctx,
    (actor) => clonePersonaService(name, newName, actor, description !== undefined ? { description } : {}),
    client,
  );
}

function renamePersonaHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  newNameRaw: string,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  const newName = personaNameOrThrow(newNameRaw);
  return mutateAndEmit(ctx, (actor) => renamePersonaService(name, newName, actor), client).detail;
}

/** Restores a trash entry; a forced restore that trashed a persona runs the retention sweep. */
async function restoreTrashHandler(
  ctx: WorkflowDispatchContext,
  input: { entry: string; as?: string; force?: boolean },
  client?: WsWebSocket,
): Promise<PersonaRestoreResultDto> {
  if (input.as !== undefined) personaNameOrThrow(input.as);
  const result = mutateAndEmit(
    ctx,
    (actor) =>
      restorePersonaService(input.entry, actor, {
        ...(input.as !== undefined ? { as: input.as } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
      }),
    client,
  );
  if (result.replaced !== undefined) await sweepPersonaTrash(describeActor(client));
  return {
    persona: result.detail,
    restored: result.restored,
    ...(result.replaced !== undefined ? { replaced: result.replaced } : {}),
  };
}

function purgeTrashHandler(
  ctx: WorkflowDispatchContext,
  input: { entries?: string[]; expired?: true; all?: true },
  client?: WsWebSocket,
): Promise<PersonaTrashPurgeResultDto> {
  const selection: PersonaTrashPurgeSelection = input.entries
    ? { kind: 'entries', refs: input.entries }
    : input.expired
      ? { kind: 'expired' }
      : { kind: 'all' };
  return mutateAndEmitAsync(ctx, (actor) => purgePersonaTrashService(selection, actor), client);
}

/** Builds the audit/actor string: `${remoteAddr}#${connId}` (WS) or 'cli'. */
function describeActor(client?: WsWebSocket): string {
  if (!client) return 'cli';
  const connId = getConnId(client);
  // `_socket` exposes the remote address on the underlying TCP socket.
  const remote = (client as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? 'unknown';
  return `${remote}#${connId ?? 'unknown'}`;
}
