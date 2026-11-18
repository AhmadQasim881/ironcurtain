/**
 * Phase 1c persona-CRUD dispatch tests.
 *
 * Verifies: (1) ALL mutation methods (create/editConstitution/setMemory/delete/
 * setBroadPolicyOptIn, the 1b compileStream, and the lifecycle methods clone/
 * rename/restoreTrash/purgeTrash) return POLICY_MUTATION_FORBIDDEN when the
 * kill switch is off; (2) the gate fires BEFORE any fs read; (3) the happy
 * paths work with the gate on, emit personas.changed, and route service
 * errors to typed RpcErrors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { personaDispatch } from '../src/web-ui/dispatch/persona-dispatch.js';
import {
  RpcError,
  type PersonaDetailDto,
  type PersonaEditResultDto,
  type PersonaRestoreResultDto,
  type PersonaTrashEntryDto,
  type PersonaTrashPurgeResultDto,
} from '../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { createPersona, deletePersona } from '../src/persona/persona-service.js';
import { getPersonaTrashDir, personaTrashEntryId } from '../src/persona/persona-trash.js';
import { createPersonaName } from '../src/persona/types.js';
import { loadBuiltinMcpServers } from '../src/config/mcp-servers-overlay.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-crud-dispatch-test-${process.pid}`);

function makeCtx(allowPolicyMutation: boolean | undefined): {
  ctx: WorkflowDispatchContext;
  events: Array<{ name: string; payload: unknown }>;
} {
  const bus = new WebEventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.subscribe((name, payload) => events.push({ name, payload }));
  const ctx = { eventBus: bus, allowPolicyMutation } as unknown as WorkflowDispatchContext;
  return { ctx, events };
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

const MUTATION_CALLS: Array<{ method: string; params: Record<string, unknown> }> = [
  { method: 'personas.create', params: { name: 'x', description: 'd' } },
  { method: 'personas.editConstitution', params: { name: 'x', constitution: 'c' } },
  { method: 'personas.setMemory', params: { name: 'x', enabled: false } },
  { method: 'personas.delete', params: { name: 'x', confirmed: true } },
  { method: 'personas.setBroadPolicyOptIn', params: { name: 'x', enabled: true } },
  { method: 'personas.compileStream', params: { name: 'x' } },
  { method: 'personas.clone', params: { name: 'x', newName: 'y' } },
  { method: 'personas.rename', params: { name: 'x', newName: 'y' } },
  { method: 'personas.restoreTrash', params: { entry: 'x' } },
  { method: 'personas.purgeTrash', params: { all: true, confirmed: true } },
];

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});
afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('kill switch (allowPolicyMutation) gating', () => {
  for (const flag of [undefined, false] as const) {
    for (const { method, params } of MUTATION_CALLS) {
      it(`${method} returns POLICY_MUTATION_FORBIDDEN when flag is ${String(flag)}`, async () => {
        const { ctx } = makeCtx(flag);
        await expect(personaDispatch(ctx, method, params)).rejects.toMatchObject({
          code: 'POLICY_MUTATION_FORBIDDEN',
        });
      });
    }
  }

  it('personas.listTrash is a read: allowed with the kill switch off', async () => {
    const { ctx } = makeCtx(false);
    await expect(personaDispatch(ctx, 'personas.listTrash', {})).resolves.toEqual([]);
  });

  it('a gated lifecycle method changes nothing when forbidden', async () => {
    createPersona({ name: 'kept', description: 'd' }, 'cli');
    const { ctx } = makeCtx(false);
    await expect(personaDispatch(ctx, 'personas.rename', { name: 'kept', newName: 'moved' })).rejects.toMatchObject({
      code: 'POLICY_MUTATION_FORBIDDEN',
    });
    expect(existsSync(personaDir('kept'))).toBe(true);
    expect(existsSync(personaDir('moved'))).toBe(false);
  });

  it('the gate fires before any fs read (forbidden even for an existing persona)', async () => {
    createPersona({ name: 'existing', description: 'd' }, 'cli');
    const { ctx } = makeCtx(false);
    await expect(
      personaDispatch(ctx, 'personas.setMemory', { name: 'existing', enabled: false }),
    ).rejects.toMatchObject({ code: 'POLICY_MUTATION_FORBIDDEN' });
  });

  // The legacy blocking `personas.compile` method was an UNGATED, UNVALIDATED
  // second compile path (it bypassed both the kill switch and the broad-policy
  // validator). It was removed in Phase 1c; compileStream is the single gated +
  // validated compile surface. Guard against its reintroduction.
  it('personas.compile no longer exists (removed: it was an ungated/unvalidated compile path)', async () => {
    const { ctx } = makeCtx(true); // even with the kill switch ON
    await expect(personaDispatch(ctx, 'personas.compile', { name: 'x' })).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
    });
  });
});

describe('CRUD happy paths (gate on)', () => {
  it('personas.create creates the persona, returns the detail DTO, and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    const detail = (await personaDispatch(ctx, 'personas.create', {
      name: 'coder',
      description: 'Build',
    })) as PersonaDetailDto;
    expect(detail.name).toBe('coder');
    expect(detail.allowBroadPolicy).toBe(false);
    expect(existsSync(personaDir('coder'))).toBe(true);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });

  it('personas.create on a duplicate returns PERSONA_EXISTS', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'dup', description: 'd' });
    await expect(personaDispatch(ctx, 'personas.create', { name: 'dup', description: 'd' })).rejects.toMatchObject({
      code: 'PERSONA_EXISTS',
    });
  });

  it('personas.create with an invalid slug returns INVALID_PARAMS', async () => {
    const { ctx } = makeCtx(true);
    await expect(
      personaDispatch(ctx, 'personas.create', { name: 'Not Valid', description: 'd' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('personas.editConstitution returns { stale } and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const result = (await personaDispatch(ctx, 'personas.editConstitution', {
      name: 'p',
      constitution: 'new rules',
    })) as PersonaEditResultDto;
    expect(result.stale).toBe(true); // no compiled policy yet
    expect(events.filter((e) => e.name === 'personas.changed').length).toBeGreaterThanOrEqual(2);
  });

  it('personas.editConstitution on a missing persona returns PERSONA_NOT_FOUND', async () => {
    const { ctx } = makeCtx(true);
    await expect(
      personaDispatch(ctx, 'personas.editConstitution', { name: 'missing', constitution: 'c' }),
    ).rejects.toMatchObject({ code: 'PERSONA_NOT_FOUND' });
  });

  it('personas.setMemory returns the updated detail DTO', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const detail = (await personaDispatch(ctx, 'personas.setMemory', {
      name: 'p',
      enabled: false,
    })) as PersonaDetailDto;
    expect(detail.memory).toBe(false);
  });

  it('personas.delete soft-deletes by default and returns { deleted: true }', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const result = await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true });
    expect(result).toEqual({ deleted: true });
    expect(existsSync(personaDir('p'))).toBe(false);
    // Soft: present in trash.
    expect(existsSync(resolve(TEST_HOME, '.persona-trash'))).toBe(true);
  });

  it('personas.delete with force:true hard-deletes (no trash)', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true, force: true });
    expect(existsSync(personaDir('p'))).toBe(false);
    const trash = resolve(TEST_HOME, '.persona-trash');
    expect(existsSync(trash)).toBe(false);
  });

  it('personas.delete without confirmed:true is INVALID_PARAMS', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await expect(personaDispatch(ctx, 'personas.delete', { name: 'p' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('personas.setBroadPolicyOptIn flips allowBroadPolicy and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const detail = (await personaDispatch(ctx, 'personas.setBroadPolicyOptIn', {
      name: 'p',
      enabled: true,
    })) as PersonaDetailDto;
    expect(detail.allowBroadPolicy).toBe(true);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });

  it('routes unknown methods to METHOD_NOT_FOUND', async () => {
    const { ctx } = makeCtx(true);
    await expect(personaDispatch(ctx, 'personas.bogus', {})).rejects.toBeInstanceOf(RpcError);
  });
});

describe('persona.json validation over the WS surface', () => {
  function copyPersonaDir(from: string, to: string): void {
    mkdirSync(personaDir(to), { recursive: true });
    const json = JSON.parse(readFileSync(resolve(personaDir(from), 'persona.json'), 'utf-8')) as object;
    writeFileSync(resolve(personaDir(to), 'persona.json'), JSON.stringify(json));
  }

  it('personas.get and edits of a copied persona directory return PERSONA_INVALID', async () => {
    createPersona({ name: 'a', description: 'd' }, 'cli');
    copyPersonaDir('a', 'b');
    const { ctx, events } = makeCtx(true);
    await expect(personaDispatch(ctx, 'personas.get', { name: 'b' })).rejects.toMatchObject({
      code: 'PERSONA_INVALID',
    });
    await expect(
      personaDispatch(ctx, 'personas.editConstitution', { name: 'b', constitution: 'x' }),
    ).rejects.toMatchObject({ code: 'PERSONA_INVALID' });
    expect(events).toEqual([]);
  });

  it('personas.delete still removes a persona whose persona.json is invalid', async () => {
    createPersona({ name: 'a', description: 'd' }, 'cli');
    copyPersonaDir('a', 'b');
    const { ctx } = makeCtx(true);
    await expect(personaDispatch(ctx, 'personas.delete', { name: 'b', confirmed: true })).resolves.toEqual({
      deleted: true,
    });
    expect(existsSync(personaDir('b'))).toBe(false);
  });

  it('personas.create with an unconfigured server returns INVALID_PARAMS and creates nothing', async () => {
    const { ctx } = makeCtx(true);
    await expect(
      personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd', servers: ['not-a-server'] }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('not-a-server') });
    expect(existsSync(personaDir('p'))).toBe(false);
  });
});

// The web UI's "Narrow to specific servers" picker is built from this list
// (it used to be a static list that offered a nonexistent `web-search` and
// lacked `fetch` and every server the user added).
describe('personas.listServers', () => {
  /** Adds `name` to the user's server file in the test home (`$IRONCURTAIN_HOME/mcp-servers.json`). */
  function addUserServer(name: string): void {
    writeFileSync(
      resolve(TEST_HOME, 'mcp-servers.json'),
      JSON.stringify({ [name]: { command: '/usr/bin/true', args: [], description: 'A server the user added' } }),
      { mode: 0o600 },
    );
  }

  it('lists the built-in servers and the user servers, and is a read allowed with the kill switch off', async () => {
    addUserServer('notes');
    const { ctx, events } = makeCtx(false);

    const servers = (await personaDispatch(ctx, 'personas.listServers', {})) as string[];

    expect(servers).toEqual([...Object.keys(loadBuiltinMcpServers()), 'notes']);
    expect(servers).toContain('fetch');
    expect(servers).not.toContain('web-search');
    expect(events).toEqual([]);
  });

  it('offers names personas.create accepts, a built-in and a user server alike', async () => {
    addUserServer('notes');
    const { ctx } = makeCtx(true);
    const servers = (await personaDispatch(ctx, 'personas.listServers', {})) as string[];

    const detail = (await personaDispatch(ctx, 'personas.create', {
      name: 'narrow',
      description: 'd',
      servers: servers.filter((server) => server === 'fetch' || server === 'notes'),
    })) as PersonaDetailDto;

    expect(detail.servers).toEqual(['fetch', 'notes']);
  });

  it('fails rather than offering a partial list when the user server file is invalid', async () => {
    writeFileSync(resolve(TEST_HOME, 'mcp-servers.json'), '{ not json', { mode: 0o600 });
    const { ctx } = makeCtx(true);

    await expect(personaDispatch(ctx, 'personas.listServers', {})).rejects.toMatchObject({
      code: 'MCP_SERVERS_INVALID',
    });
  });
});

describe('persona lifecycle methods (gate on)', () => {
  it('personas.clone creates an independent copy and emits personas.changed', async () => {
    createPersona({ name: 'src', description: 'Source', constitution: 'Rules.' }, 'cli');
    const { ctx, events } = makeCtx(true);
    const detail = (await personaDispatch(ctx, 'personas.clone', {
      name: 'src',
      newName: 'dst',
      description: 'Copy',
    })) as PersonaDetailDto;
    expect(detail).toMatchObject({ name: 'dst', description: 'Copy', constitution: 'Rules.\n', hasPolicy: false });
    expect(existsSync(personaDir('src'))).toBe(true);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
    await expect(personaDispatch(ctx, 'personas.clone', { name: 'src', newName: 'dst' })).rejects.toMatchObject({
      code: 'PERSONA_EXISTS',
    });
    await expect(personaDispatch(ctx, 'personas.clone', { name: 'src', newName: 'Bad Name' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('personas.rename moves the persona and reports it uncompiled', async () => {
    createPersona({ name: 'old', description: 'd' }, 'cli');
    const { ctx, events } = makeCtx(true);
    const detail = (await personaDispatch(ctx, 'personas.rename', { name: 'old', newName: 'new' })) as PersonaDetailDto;
    expect(detail).toMatchObject({ name: 'new', hasPolicy: false });
    expect(existsSync(personaDir('old'))).toBe(false);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
    await expect(personaDispatch(ctx, 'personas.rename', { name: 'old', newName: 'x' })).rejects.toMatchObject({
      code: 'PERSONA_NOT_FOUND',
    });
  });

  it('personas.listTrash / restoreTrash: a collision needs force, which trashes the existing persona', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'deleted', constitution: 'old' });
    await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true });
    const [entry] = (await personaDispatch(ctx, 'personas.listTrash', {})) as PersonaTrashEntryDto[];
    expect(entry).toMatchObject({ name: 'p', description: 'deleted' });
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'recreated', constitution: 'new' });

    await expect(personaDispatch(ctx, 'personas.restoreTrash', { entry: entry.id })).rejects.toMatchObject({
      code: 'PERSONA_EXISTS',
    });
    const result = (await personaDispatch(ctx, 'personas.restoreTrash', {
      entry: entry.id,
      force: true,
    })) as PersonaRestoreResultDto;
    expect(result).toMatchObject({ restored: entry.id, persona: { name: 'p', description: 'deleted' } });
    expect(result.replaced).toBeDefined();
    const trash = (await personaDispatch(ctx, 'personas.listTrash', {})) as PersonaTrashEntryDto[];
    expect(trash.map((e) => [e.id, e.description])).toEqual([[result.replaced, 'recreated']]);

    await expect(
      personaDispatch(ctx, 'personas.restoreTrash', { entry: result.replaced, as: '../x' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(personaDispatch(ctx, 'personas.restoreTrash', { entry: 'nope' })).rejects.toMatchObject({
      code: 'PERSONA_NOT_FOUND',
    });
  });

  it('personas.purgeTrash needs confirmation and exactly one selector, then purges', async () => {
    const { ctx, events } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true });

    await expect(personaDispatch(ctx, 'personas.purgeTrash', { all: true })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      personaDispatch(ctx, 'personas.purgeTrash', { all: true, expired: true, confirmed: true }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      personaDispatch(ctx, 'personas.purgeTrash', { entries: ['nope'], confirmed: true }),
    ).rejects.toMatchObject({ code: 'PERSONA_NOT_FOUND' });

    events.length = 0;
    const result = (await personaDispatch(ctx, 'personas.purgeTrash', {
      entries: ['p'],
      confirmed: true,
    })) as PersonaTrashPurgeResultDto;
    expect(result.purged).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(readdirSync(getPersonaTrashDir())).toEqual([]);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });

  it('a soft delete runs the retention sweep: entries past the 30-day default are purged', async () => {
    createPersona({ name: 'ancient', description: 'd' }, 'cli');
    const { trashEntry } = deletePersona(createPersonaName('ancient'), 'cli');
    const oldId = personaTrashEntryId(createPersonaName('ancient'), new Date(Date.now() - 31 * 24 * 3600 * 1000));
    renameSync(resolve(getPersonaTrashDir(), trashEntry ?? ''), resolve(getPersonaTrashDir(), oldId));

    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true });

    const names = ((await personaDispatch(ctx, 'personas.listTrash', {})) as PersonaTrashEntryDto[]).map((e) => e.name);
    expect(names).toEqual(['p']);
  });
});
