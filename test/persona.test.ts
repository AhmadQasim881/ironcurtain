/**
 * Tests for the persona system: types, resolver, server filtering,
 * system prompt augmentation, and constitution generator persona context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The persona CLI reaches the compiler only through runPersonaCompile's dynamic
// import (persona-compile-service.ts); these tests never compile.
vi.mock('../src/persona/compile-persona-policy.js', () => ({ compilePersonaPolicy: vi.fn() }));

// Mock the memory prompt module before importing persona-prompt
vi.mock('../src/memory/memory-prompt.js', () => ({
  buildMemorySystemPrompt: vi.fn(
    (opts?: { persona?: string }) =>
      `## Memory System${opts?.persona ? ` (${opts.persona})` : ''}\nUse memory tools to store and retrieve information.`,
  ),
  adaptMemoryToolNames: (prompt: string) => prompt,
}));

import { createPersonaName, PERSONA_NAME_PATTERN } from '../src/persona/types.js';
import {
  getPersonaDir,
  getPersonaGeneratedDir,
  getPersonaConstitutionPath,
  getPersonaPolicyState,
  getPersonaWorkspaceDir,
  loadPersona,
  personaExists,
  resolvePersona,
  applyServerAllowlist,
  filterMcpServersByPolicy,
} from '../src/persona/resolve.js';
import {
  createPersona,
  getPersonaDetail,
  listPersonas,
  setPersonaConstitution,
} from '../src/persona/persona-service.js';
import { main as personaMain } from '../src/persona/persona-command.js';
import { isScopedPolicyError } from '../src/config/constitution-hash.js';
import { buildPersonaSystemPromptAugmentation } from '../src/persona/persona-prompt.js';
import { buildConstitutionGeneratorSystemPrompt } from '../src/cron/constitution-generator.js';
import { buildPersonaCustomizerSystemPrompt } from '../src/persona/persona-customizer.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: create a persona on disk for testing
// ---------------------------------------------------------------------------

function createTestPersona(
  name: string,
  opts: { compiled?: boolean; servers?: string[]; description?: string } = {},
): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  const generatedDir = resolve(personaDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });

  const definition = {
    name,
    description: opts.description ?? `Test persona: ${name}`,
    createdAt: '2026-03-07T12:00:00.000Z',
    ...(opts.servers ? { servers: opts.servers } : {}),
  };
  writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(definition));

  if (opts.compiled !== false) {
    writePersonaPolicy(personaDir);
  }
}

// ---------------------------------------------------------------------------
// PersonaName validation (types.ts)
// ---------------------------------------------------------------------------

describe('createPersonaName', () => {
  it('accepts valid lowercase alphanumeric names', () => {
    expect(createPersonaName('coder')).toBe('coder');
    expect(createPersonaName('exec-assistant')).toBe('exec-assistant');
    expect(createPersonaName('my_persona_1')).toBe('my_persona_1');
    expect(createPersonaName('a')).toBe('a');
    expect(createPersonaName('9lives')).toBe('9lives');
  });

  it('accepts names up to 63 characters', () => {
    const name = 'a'.repeat(63);
    expect(createPersonaName(name)).toBe(name);
  });

  it('rejects empty string', () => {
    expect(() => createPersonaName('')).toThrow('Invalid persona name');
  });

  it('rejects names longer than 63 characters', () => {
    const name = 'a'.repeat(64);
    expect(() => createPersonaName(name)).toThrow('Invalid persona name');
  });

  it('rejects names starting with a hyphen', () => {
    expect(() => createPersonaName('-coder')).toThrow('Invalid persona name');
  });

  it('rejects names starting with an underscore', () => {
    expect(() => createPersonaName('_coder')).toThrow('Invalid persona name');
  });

  it('rejects uppercase letters', () => {
    expect(() => createPersonaName('Coder')).toThrow('Invalid persona name');
  });

  it('rejects path traversal characters', () => {
    expect(() => createPersonaName('../etc')).toThrow('Invalid persona name');
    expect(() => createPersonaName('foo/bar')).toThrow('Invalid persona name');
    expect(() => createPersonaName('foo..bar')).toThrow('Invalid persona name');
  });

  it('rejects spaces and special characters', () => {
    expect(() => createPersonaName('my persona')).toThrow('Invalid persona name');
    expect(() => createPersonaName('my@persona')).toThrow('Invalid persona name');
  });

  it('includes the invalid name in the error message', () => {
    expect(() => createPersonaName('BAD!')).toThrow('"BAD!"');
  });
});

describe('PERSONA_NAME_PATTERN', () => {
  it('matches the documented pattern', () => {
    expect(PERSONA_NAME_PATTERN.source).toBe('^[a-z0-9][a-z0-9_-]{0,62}$');
  });
});

// ---------------------------------------------------------------------------
// Persona resolver (resolve.ts)
// ---------------------------------------------------------------------------

describe('loadPersona', () => {
  it('loads a valid persona definition', () => {
    createTestPersona('test-persona', {
      servers: ['filesystem', 'github'],
      description: 'A test persona',
    });
    const name = createPersonaName('test-persona');

    const result = loadPersona(name);
    expect(result.name).toBe('test-persona');
    expect(result.description).toBe('A test persona');
    expect(result.createdAt).toBe('2026-03-07T12:00:00.000Z');
    expect(result.servers).toEqual(['filesystem', 'github']);
  });

  it('loads a persona without servers field', () => {
    createTestPersona('no-filter');
    const name = createPersonaName('no-filter');

    const result = loadPersona(name);
    expect(result.servers).toBeUndefined();
  });

  it('throws when persona.json does not exist', () => {
    const name = createPersonaName('nonexistent');
    expect(() => loadPersona(name)).toThrow('not found');
  });
});

describe('resolvePersona', () => {
  it('resolves a valid persona with compiled policy', () => {
    createTestPersona('coder', { description: 'Software development' });

    const result = resolvePersona('coder');
    expect(result.policyDir).toBe(resolve(TEST_HOME, 'personas', 'coder', 'generated'));
    expect(result.persona.name).toBe('coder');
    expect(result.persona.description).toBe('Software development');
    expect(result.workspacePath).toBe(resolve(TEST_HOME, 'personas', 'coder', 'workspace'));
  });

  it('throws when persona has no compiled policy', () => {
    createTestPersona('uncompiled', { compiled: false });

    expect(() => resolvePersona('uncompiled')).toThrow('has no compiled policy');
    expect(() => resolvePersona('uncompiled')).toThrow('ironcurtain persona compile uncompiled');
  });

  it('throws for invalid persona name', () => {
    expect(() => resolvePersona('../etc')).toThrow('Invalid persona name');
  });

  it('returns workspace path under persona directory', () => {
    createTestPersona('wp-test');

    const result = resolvePersona('wp-test');
    expect(result.workspacePath).toContain('personas/wp-test/workspace');
  });

  it('refuses a policy compiled from an older constitution (POLICY_STALE)', () => {
    createTestPersona('narrowed');
    // The user narrows the constitution but never recompiles.
    writeFileSync(getPersonaConstitutionPath(createPersonaName('narrowed')), 'Only READ files under ~/projects.\n');

    let thrown: unknown;
    try {
      resolvePersona('narrowed');
    } catch (err) {
      thrown = err;
    }
    expect(isScopedPolicyError(thrown, 'POLICY_STALE')).toBe(true);
    expect((thrown as Error).message).toBe(
      'Persona "narrowed" has a stale compiled policy: the constitution changed after the policy was compiled. ' +
        'Recompile it with: ironcurtain persona compile narrowed',
    );
  });

  it('refuses a policy that records no constitution hash', () => {
    createTestPersona('legacy');
    writeFileSync(
      resolve(getPersonaGeneratedDir(createPersonaName('legacy')), 'compiled-policy.json'),
      JSON.stringify({ rules: [] }),
    );

    expect(() => resolvePersona('legacy')).toThrow(/stale compiled policy: the compiled policy does not record/);
  });

  it('returns a stale policy only on the explicit override, flagged for the caller to warn', () => {
    createTestPersona('edited');
    writeFileSync(getPersonaConstitutionPath(createPersonaName('edited')), 'Edited.\n');

    const result = resolvePersona('edited', { allowStalePolicy: true });
    expect(result.policyDir).toBe(getPersonaGeneratedDir(createPersonaName('edited')));
    expect(result.stalePolicy).toEqual({
      reason: 'constitution',
      detail: 'the constitution changed after the policy was compiled',
    });
    // A fresh persona never carries the flag.
    createTestPersona('fresh');
    expect(resolvePersona('fresh', { allowStalePolicy: true })).not.toHaveProperty('stalePolicy');
  });
});

describe('persona policy staleness on read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Creates a persona through the service and compiles it (writes the matching policy). */
  function createCompiledPersona(name: string, constitution: string): void {
    createPersona({ name, description: `Persona ${name}`, constitution }, 'cli');
    writePersonaPolicy(getPersonaDir(createPersonaName(name)), {}, `${constitution}\n`);
  }

  it('getPersonaPolicyState recomputes the state from disk on every call', () => {
    createCompiledPersona('coder', 'Read and write the workspace.');
    const name = createPersonaName('coder');
    expect(getPersonaPolicyState(name)).toEqual({ kind: 'fresh' });

    setPersonaConstitution(name, 'Read the workspace only.', 'cli');
    expect(getPersonaPolicyState(name)).toMatchObject({ kind: 'stale', reason: 'constitution' });

    // Reverting the edit makes the existing policy match again.
    setPersonaConstitution(name, 'Read and write the workspace.', 'cli');
    expect(getPersonaPolicyState(name)).toEqual({ kind: 'fresh' });
  });

  it('persona list and detail report stale after a constitution edit', () => {
    createCompiledPersona('coder', 'Read and write the workspace.');
    createCompiledPersona('writer', 'Write docs.');
    createPersona({ name: 'draft', description: 'Persona draft', constitution: 'Draft.' }, 'cli');
    expect(listPersonas().find((p) => p.name === 'coder')).toEqual({
      name: 'coder',
      description: 'Persona coder',
      compiled: true,
    });

    expect(setPersonaConstitution(createPersonaName('coder'), 'Read the workspace only.', 'cli')).toEqual({
      stale: true,
    });

    expect(listPersonas()).toEqual([
      { name: 'coder', description: 'Persona coder', compiled: true, stale: 'constitution' },
      { name: 'draft', description: 'Persona draft', compiled: false },
      { name: 'writer', description: 'Persona writer', compiled: true },
    ]);
    const detail = getPersonaDetail(createPersonaName('coder'));
    expect(detail.hasPolicy).toBe(true);
    expect(detail.stale).toBe('constitution');
    expect(getPersonaDetail(createPersonaName('writer'))).not.toHaveProperty('stale');
  });

  it('`persona list` and `persona show` print the stale status', async () => {
    createCompiledPersona('coder', 'Read and write the workspace.');
    createCompiledPersona('writer', 'Write docs.');
    setPersonaConstitution(createPersonaName('coder'), 'Read the workspace only.', 'cli');
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await personaMain(['list']);
    const coderRow = lines.find((l) => l.includes('coder'));
    const writerRow = lines.find((l) => l.includes('writer'));
    expect(coderRow).toMatch(/stale \(recompile\)/);
    expect(writerRow).toMatch(/compiled/);
    expect(writerRow).not.toMatch(/stale/);

    lines.length = 0;
    await personaMain(['show', 'coder']);
    expect(lines.find((l) => l.startsWith('Policy:'))).toMatch(
      /stale: the constitution changed after the policy was compiled\. Recompile with: ironcurtain persona compile coder/,
    );
  });
});

describe('path helpers', () => {
  it('getPersonaDir returns correct path', () => {
    const name = createPersonaName('test');
    expect(getPersonaDir(name)).toBe(resolve(TEST_HOME, 'personas', 'test'));
  });

  it('getPersonaGeneratedDir returns correct path', () => {
    const name = createPersonaName('test');
    expect(getPersonaGeneratedDir(name)).toBe(resolve(TEST_HOME, 'personas', 'test', 'generated'));
  });

  it('getPersonaConstitutionPath returns correct path', () => {
    const name = createPersonaName('test');
    expect(getPersonaConstitutionPath(name)).toBe(resolve(TEST_HOME, 'personas', 'test', 'constitution.md'));
  });

  it('getPersonaWorkspaceDir returns correct path', () => {
    const name = createPersonaName('test');
    expect(getPersonaWorkspaceDir(name)).toBe(resolve(TEST_HOME, 'personas', 'test', 'workspace'));
  });
});

describe('personaExists', () => {
  it('returns true for an installed persona', () => {
    createTestPersona('installed');
    expect(personaExists('installed')).toBe(true);
  });

  it('returns false for a missing persona', () => {
    expect(personaExists('nonexistent')).toBe(false);
  });

  it('returns false for path-traversal names without touching the filesystem', () => {
    // The brand-then-check ordering is load-bearing: if existsSync received
    // "../evil" unescaped, it could probe arbitrary locations outside
    // the personas directory. createPersonaName rejects the pattern first,
    // so existsSync is never called.
    expect(personaExists('../evil')).toBe(false);
    expect(personaExists('../../../etc/passwd')).toBe(false);
    expect(personaExists('foo/bar')).toBe(false);
  });

  it('returns false for invalid slug characters', () => {
    expect(personaExists('Bad!')).toBe(false);
    expect(personaExists('my persona')).toBe(false);
    expect(personaExists('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server allowlist filtering (resolve.ts)
// ---------------------------------------------------------------------------

describe('applyServerAllowlist', () => {
  const mockServers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'node', args: ['fs.js'] },
    github: { command: 'node', args: ['gh.js'] },
    gmail: { command: 'node', args: ['gmail.js'] },
    fetch: { command: 'node', args: ['fetch.js'] },
  };

  it('filters servers to only those in the allowlist', () => {
    const filtered = applyServerAllowlist(mockServers, ['filesystem', 'github']);
    expect(Object.keys(filtered).sort()).toEqual(['filesystem', 'github']);
  });

  it('always includes filesystem even when not in allowlist', () => {
    const filtered = applyServerAllowlist(mockServers, ['gmail']);
    expect(Object.keys(filtered).sort()).toEqual(['filesystem', 'gmail']);
  });

  it('always includes filesystem even with empty allowlist', () => {
    const filtered = applyServerAllowlist(mockServers, []);
    expect(Object.keys(filtered)).toEqual(['filesystem']);
  });

  it('preserves server config objects', () => {
    const filtered = applyServerAllowlist(mockServers, ['github']);
    expect(filtered['github']).toBe(mockServers['github']);
    expect(filtered['filesystem']).toBe(mockServers['filesystem']);
  });

  it('warns about unknown server names', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      applyServerAllowlist(mockServers, ['filesystem', 'nonexistent-server']);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown server "nonexistent-server"'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('does not warn about filesystem even if not in server map', () => {
    const serversWithoutFilesystem: Record<string, MCPServerConfig> = {
      github: { command: 'node', args: ['gh.js'] },
    };

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      applyServerAllowlist(serversWithoutFilesystem, ['filesystem']);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns only known servers from the allowlist (ignores unknown)', () => {
    const filtered = applyServerAllowlist(mockServers, ['github', 'nonexistent']);
    // nonexistent is not in mockServers, so it's silently dropped (with a warning)
    expect(Object.keys(filtered).sort()).toEqual(['filesystem', 'github']);
  });
});

// ---------------------------------------------------------------------------
// Policy-derived filtering (resolve.ts)
// ---------------------------------------------------------------------------

describe('filterMcpServersByPolicy', () => {
  const mockServers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'node', args: ['fs.js'] },
    github: { command: 'node', args: ['gh.js'] },
    gmail: { command: 'node', args: ['gmail.js'] },
    fetch: { command: 'node', args: ['fetch.js'] },
  };

  it('keeps only servers present in the required set', () => {
    const filtered = filterMcpServersByPolicy(mockServers, new Set(['filesystem', 'fetch']));
    expect(Object.keys(filtered).sort()).toEqual(['fetch', 'filesystem']);
  });

  it('returns an empty object when the required set is empty', () => {
    const filtered = filterMcpServersByPolicy(mockServers, new Set());
    expect(filtered).toEqual({});
  });

  it('preserves server config object identity', () => {
    const filtered = filterMcpServersByPolicy(mockServers, new Set(['github']));
    expect(filtered['github']).toBe(mockServers['github']);
  });

  it('ignores required-set entries that are not in mcpServers', () => {
    const filtered = filterMcpServersByPolicy(mockServers, new Set(['github', 'nonexistent']));
    expect(Object.keys(filtered)).toEqual(['github']);
  });
});

// ---------------------------------------------------------------------------
// System prompt augmentation (persona-prompt.ts)
// ---------------------------------------------------------------------------

describe('buildPersonaSystemPromptAugmentation', () => {
  it('includes persona name and description', () => {
    const persona = {
      name: 'exec-assistant' as ReturnType<typeof createPersonaName>,
      description: 'Email triage and calendar management',
      createdAt: '2026-03-07T12:00:00.000Z',
    };

    const result = buildPersonaSystemPromptAugmentation(persona, false);
    expect(result).toContain('## Persona: exec-assistant');
    expect(result).toContain('Email triage and calendar management');
  });

  it('includes memory system prompt when memoryEnabled is true', () => {
    const persona = {
      name: 'test' as ReturnType<typeof createPersonaName>,
      description: 'Test',
      createdAt: '2026-03-07T12:00:00.000Z',
    };

    const result = buildPersonaSystemPromptAugmentation(persona, true);
    expect(result).toContain('## Memory System (test)');
    expect(result).toContain('memory tools');
  });

  it('does not include memory section when memoryEnabled is false', () => {
    const persona = {
      name: 'test' as ReturnType<typeof createPersonaName>,
      description: 'Test',
      createdAt: '2026-03-07T12:00:00.000Z',
    };

    const result = buildPersonaSystemPromptAugmentation(persona, false);
    expect(result).not.toContain('Memory System');
    expect(result).not.toContain('memory tools');
  });

  it('passes persona name to buildMemorySystemPrompt', async () => {
    const { buildMemorySystemPrompt } = await import('../src/memory/memory-prompt.js');
    const mockBuild = buildMemorySystemPrompt as ReturnType<typeof vi.fn>;
    mockBuild.mockClear();

    const persona = {
      name: 'exec-assistant' as ReturnType<typeof createPersonaName>,
      description: 'Email triage',
      createdAt: '2026-03-07T12:00:00.000Z',
    };

    buildPersonaSystemPromptAugmentation(persona, true);
    expect(mockBuild).toHaveBeenCalledWith({ persona: 'exec-assistant' });
  });

  it('does not call buildMemorySystemPrompt when memory is disabled', async () => {
    const { buildMemorySystemPrompt } = await import('../src/memory/memory-prompt.js');
    const mockBuild = buildMemorySystemPrompt as ReturnType<typeof vi.fn>;
    mockBuild.mockClear();

    const persona = {
      name: 'test' as ReturnType<typeof createPersonaName>,
      description: 'Test',
      createdAt: '2026-03-07T12:00:00.000Z',
    };

    buildPersonaSystemPromptAugmentation(persona, false);
    expect(mockBuild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Constitution generator persona context (constitution-generator.ts)
// ---------------------------------------------------------------------------

describe('buildConstitutionGeneratorSystemPrompt persona context', () => {
  it('uses persona framing when context is persona', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt(
      'Email triage and review',
      '/workspace',
      undefined,
      'persona',
    );

    expect(prompt).toContain('interactive persona');
    expect(prompt).toContain('human is present');
  });

  it('uses cron framing by default', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Label issues', '/workspace');

    expect(prompt).toContain('unattended');
    expect(prompt).toContain('cron');
  });

  it('makes exploration optional for persona context', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Email triage', '/workspace', undefined, 'persona');

    expect(prompt).toContain('optional');
  });

  it('uses persona label in workspace description', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Research tasks', '/workspace', undefined, 'persona');

    expect(prompt).toContain('persona workspace');
  });

  it('explains escalation is meaningful for persona', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Email triage', '/workspace', undefined, 'persona');

    expect(prompt).toContain('approve or deny escalated operations');
  });
});

// ---------------------------------------------------------------------------
// Persona customizer system prompt (persona-customizer.ts)
// ---------------------------------------------------------------------------

describe('buildPersonaCustomizerSystemPrompt', () => {
  it('includes persona description', () => {
    const result = buildPersonaCustomizerSystemPrompt(
      'Some base constitution',
      [],
      'Email triage and calendar management',
    );

    expect(result).toContain('Persona Context');
    expect(result).toContain('Email triage and calendar management');
  });

  it('includes server allowlist when provided', () => {
    const result = buildPersonaCustomizerSystemPrompt('Some base constitution', [], 'Email persona', [
      'filesystem',
      'gmail',
      'google-calendar',
    ]);

    expect(result).toContain('filesystem, gmail, google-calendar');
  });

  it('omits server context when no allowlist', () => {
    const result = buildPersonaCustomizerSystemPrompt('Some base constitution', [], 'General purpose persona');

    expect(result).not.toContain('only has access to these MCP servers');
  });

  it('includes minimum permissions guidance', () => {
    const result = buildPersonaCustomizerSystemPrompt('Constitution text', [], 'Coding persona');

    expect(result).toContain('minimum');
    expect(result).toContain('permissions');
  });
});
