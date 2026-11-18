/**
 * A persona's agent model and resource limits (`agentModelId`,
 * `resourceBudget`) across persona.json validation and the persona
 * lifecycle. The strict persona.json schema knows both fields but leaves
 * their values to `readPersonaOverrides`, which sessions apply: a malformed
 * value refuses the persona's sessions while the persona stays loadable and
 * repairable. Every operation that rewrites persona.json keeps them, and a
 * clone copies them (validated, and audited). Runs against a temp
 * IRONCURTAIN_HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  clonePersona,
  createPersona,
  deletePersona,
  renamePersona,
  restorePersona,
  setPersonaBroadPolicyOptIn,
  setPersonaConstitution,
  setPersonaMemory,
  setPersonaOverrides,
} from '../src/persona/persona-service.js';
import { PERSONA_INVALID } from '../src/persona/persona-definition.js';
import { PERSONA_OVERRIDES_INVALID, readPersonaOverrides } from '../src/persona/persona-overrides.js';
import { verifyPolicyMutationLog } from '../src/persona/policy-mutation-audit.js';
import { loadPersona, resolvePersona } from '../src/persona/resolve.js';
import { createPersonaName } from '../src/persona/types.js';
import { scanPersonaDirs } from '../src/mux/persona-scanner.js';
import { personaDispatch } from '../src/web-ui/dispatch/persona-dispatch.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { main as personaMain } from '../src/persona/persona-command.js';
import { hashConstitutionText } from '../src/config/constitution-hash.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-lifecycle-overrides-test-${process.pid}`);

const MODEL = 'anthropic:claude-haiku-4-5';
/** A cost cap tighter than the global one, and a limit the persona disables. */
const BUDGET = { maxEstimatedCostUsd: 1, maxSteps: null };

interface AuditRecord {
  readonly method: string;
  readonly persona: string;
  readonly details: Record<string, unknown>;
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

function personaJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(personaDir(name), 'persona.json'), 'utf-8')) as Record<string, unknown>;
}

function readAudit(): AuditRecord[] {
  const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

/** A compiled persona whose persona.json also carries `extra`, as written by hand or by `persona set`. */
function makePersona(name: string, extra: Record<string, unknown> = {}): void {
  const constitution = `${name} rules`;
  createPersona({ name, description: `Persona ${name}`, constitution }, 'setup');
  writeCompiledPolicyFor(resolve(personaDir(name), 'generated'), `${constitution}\n`);
  if (Object.keys(extra).length > 0) {
    writeFileSync(resolve(personaDir(name), 'persona.json'), JSON.stringify({ ...personaJson(name), ...extra }));
  }
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('persona.json validation of the agent model and limits', () => {
  it('loads a persona that sets both, carrying them as stored for the sessions', () => {
    makePersona('tuned', { agentModelId: MODEL, resourceBudget: BUDGET });

    const persona = loadPersona(createPersonaName('tuned'));

    expect(persona).toMatchObject({ name: 'tuned', agentModelId: MODEL, resourceBudget: BUDGET });
    expect(readPersonaOverrides('tuned', persona)).toEqual({ agentModelId: MODEL, resourceBudget: BUDGET });
    expect(() => resolvePersona('tuned')).not.toThrow();
    expect(scanPersonaDirs()).toMatchObject({ personas: [{ name: 'tuned', agentModelId: MODEL }], invalid: [] });
  });

  it('keeps a persona with malformed values loadable: sessions refuse them, `persona set` repairs them', () => {
    makePersona('broken', { agentModelId: 42, resourceBudget: { maxCost: 1 } });
    const name = createPersonaName('broken');

    // Not PERSONA_INVALID: the persona loads, and what refuses it is the
    // check every session applies.
    const persona = loadPersona(name);
    expect(codeOf(() => readPersonaOverrides('broken', persona))).toBe(PERSONA_OVERRIDES_INVALID);
    expect(scanPersonaDirs().personas[0]?.invalidOverrides).toMatch(/invalid agentModelId/);

    setPersonaOverrides(name, { agentModelId: MODEL, resourceBudget: null }, 'cli');
    expect(readPersonaOverrides('broken', loadPersona(name))).toEqual({ agentModelId: MODEL });
  });

  it('still refuses a misspelled field as unknown', () => {
    makePersona('typo', { agentModel: MODEL });
    expect(codeOf(() => loadPersona(createPersonaName('typo')))).toBe(PERSONA_INVALID);
  });
});

describe('operations that rewrite persona.json keep the agent model and limits', () => {
  it('memory and broad-policy toggles, and a constitution edit', () => {
    makePersona('p', { agentModelId: MODEL, resourceBudget: BUDGET });
    const name = createPersonaName('p');

    setPersonaMemory(name, false, 'cli');
    setPersonaBroadPolicyOptIn(name, true, 'cli');
    setPersonaBroadPolicyOptIn(name, false, 'cli');
    setPersonaConstitution(name, 'new rules', 'cli');

    expect(personaJson('p')).toMatchObject({ memory: { enabled: false }, agentModelId: MODEL, resourceBudget: BUDGET });
  });

  it('a rename, and a restore under another name', () => {
    makePersona('old', { agentModelId: MODEL, resourceBudget: BUDGET });

    renamePersona(createPersonaName('old'), 'new', 'cli');
    expect(personaJson('new')).toMatchObject({
      name: 'new',
      memoryNamespace: 'old',
      agentModelId: MODEL,
      resourceBudget: BUDGET,
    });

    const { trashEntry } = deletePersona(createPersonaName('new'), 'cli');
    restorePersona(trashEntry ?? '', 'cli', { as: 'newest' });
    expect(personaJson('newest')).toMatchObject({ name: 'newest', agentModelId: MODEL, resourceBudget: BUDGET });
    expect(readPersonaOverrides('newest', loadPersona(createPersonaName('newest')))).toEqual({
      agentModelId: MODEL,
      resourceBudget: BUDGET,
    });
  });
});

describe('clonePersona copies the agent model and limits', () => {
  it('into the clone, whose sessions run with them, and records them in the audit log', () => {
    makePersona('source', { agentModelId: MODEL, resourceBudget: BUDGET });

    clonePersona(createPersonaName('source'), 'copy', 'cli');

    expect(personaJson('copy')).toMatchObject({ name: 'copy', agentModelId: MODEL, resourceBudget: BUDGET });
    expect(readPersonaOverrides('copy', loadPersona(createPersonaName('copy')))).toEqual({
      agentModelId: MODEL,
      resourceBudget: BUDGET,
    });
    expect(readAudit().filter((r) => r.method === 'clonePersona')).toEqual([
      expect.objectContaining({
        persona: 'copy',
        details: {
          source: 'source',
          constitutionHash: hashConstitutionText('source rules\n'),
          agentModelId: MODEL,
          // Flat, as setPersonaOverrides records limits: JSON with sorted keys.
          resourceBudget: '{"maxEstimatedCostUsd":1,"maxSteps":null}',
        },
      }),
    ]);
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true });
  });

  it('stores an empty budget as none, and records nothing for overrides the source does not set', () => {
    makePersona('source', { resourceBudget: {} });

    clonePersona(createPersonaName('source'), 'copy', 'cli');

    expect(personaJson('copy')).not.toHaveProperty('resourceBudget');
    expect(personaJson('copy')).not.toHaveProperty('agentModelId');
    expect(readAudit().filter((r) => r.method === 'clonePersona')[0]?.details).toEqual({
      source: 'source',
      constitutionHash: hashConstitutionText('source rules\n'),
    });
  });

  it('refuses a source whose values are malformed, creating nothing', () => {
    makePersona('source', { resourceBudget: { maxEstimatedCostUsd: 'cheap' } });

    expect(codeOf(() => clonePersona(createPersonaName('source'), 'copy', 'cli'))).toBe(PERSONA_OVERRIDES_INVALID);

    expect(readdirSync(resolve(TEST_HOME, 'personas'))).toEqual(['source']);
    expect(readAudit().filter((r) => r.method === 'clonePersona')).toEqual([]);
  });

  it('over the web UI, refuses a malformed source with PERSONA_INVALID', async () => {
    makePersona('source', { agentModelId: 'codex' });
    const ctx = { eventBus: new WebEventBus(), allowPolicyMutation: true } as unknown as WorkflowDispatchContext;

    await expect(personaDispatch(ctx, 'personas.clone', { name: 'source', newName: 'copy' })).rejects.toMatchObject({
      code: 'PERSONA_INVALID',
      message: expect.stringContaining('invalid agentModelId') as unknown,
    });
    expect(existsSync(personaDir('copy'))).toBe(false);
  });

  it('`persona clone` says what it copied, and exits 1 with the reason for a malformed source', async () => {
    makePersona('source', { agentModelId: MODEL });
    makePersona('broken', { agentModelId: 'codex' });
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });

    await personaMain(['clone', 'source', 'copy']);
    expect(lines.join('\n')).toContain('agent model, resource limits and skills');
    expect(personaJson('copy')).toMatchObject({ agentModelId: MODEL });

    lines.length = 0;
    await expect(personaMain(['clone', 'broken', 'copy2'])).rejects.toThrow('process.exit(1)');
    expect(lines.join('\n')).toContain('Persona "broken" has an invalid agentModelId');
    expect(existsSync(personaDir('copy2'))).toBe(false);
  });
});
