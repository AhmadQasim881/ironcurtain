/**
 * The per-run definition copy and the host-command check that guards
 * `workflow resume-standalone` of a base directory other than the home's own.
 * The check must look at exactly the definition a resume would load.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostCommandStatesForResume, writeRunDefinition } from '../../src/workflow/run-definition.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';

const hostDefinition: WorkflowDefinition = {
  name: 'host-flow',
  description: 'Runs a host command',
  initial: 'build',
  settings: { mode: 'builtin' },
  states: {
    build: {
      type: 'deterministic',
      description: 'Builds on the host',
      run: [['make']],
      host: true,
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const containerDefinition: WorkflowDefinition = {
  ...hostDefinition,
  name: 'container-flow',
  states: {
    ...hostDefinition.states,
    build: {
      type: 'deterministic',
      description: 'Builds in the container',
      run: [['make']],
      container: true,
      transitions: [{ to: 'done' }],
    },
  },
};

/**
 * Recorded before a shared-container scope needed one persona (or
 * `allowMixedPersonas: true`): resume refuses it until the copy is fixed,
 * but it still runs a host command once fixed.
 */
const mixedPersonaHostDefinition: WorkflowDefinition = {
  name: 'mixed-persona-host-flow',
  description: 'Two personas share the primary scope, then a host build',
  initial: 'read',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    read: {
      type: 'agent',
      description: 'Reads untrusted input',
      persona: 'reader',
      prompt: 'Read.',
      inputs: [],
      outputs: ['notes'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Acts with a broader policy',
      persona: 'reviewer',
      prompt: 'Review.',
      inputs: ['notes'],
      outputs: ['report'],
      transitions: [{ to: 'build' }],
    },
    build: {
      type: 'deterministic',
      description: 'Builds on the host',
      run: [['make']],
      host: true,
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

describe('hostCommandStatesForResume', () => {
  let root: string;
  let runDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ic-run-definition-'));
    runDir = join(root, 'runs', 'wf-1');
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the run's own definition copy first", () => {
    writeRunDefinition(runDir, hostDefinition);
    const elsewhere = join(root, 'container.json');
    writeFileSync(elsewhere, JSON.stringify(containerDefinition));
    expect(hostCommandStatesForResume(runDir)).toEqual(['build']);
  });

  it('requires a local copy even when an original package definition exists', () => {
    const original = join(root, 'host.json');
    writeFileSync(original, JSON.stringify(hostDefinition));
    expect(hostCommandStatesForResume(runDir)).toEqual([]);

    const contained = join(root, 'container.json');
    writeFileSync(contained, JSON.stringify(containerDefinition));
    expect(hostCommandStatesForResume(runDir)).toEqual([]);
  });

  it('requires a real definition copy', () => {
    const original = join(root, 'host.json');
    writeFileSync(original, JSON.stringify(hostDefinition));
    symlinkSync(original, join(runDir, 'definition.json'));
    expect(hostCommandStatesForResume(runDir)).toEqual([]);
  });

  it('still sees the host commands of a run recorded before a shared scope needed one persona', () => {
    // A validation rule that resume enforces must not make this check load
    // nothing and report no host commands.
    const original = join(root, 'mixed.json');
    writeFileSync(original, JSON.stringify(mixedPersonaHostDefinition));
    expect(hostCommandStatesForResume(runDir)).toEqual([]);

    writeRunDefinition(runDir, mixedPersonaHostDefinition);
    expect(hostCommandStatesForResume(runDir)).toEqual(['build']);
  });

  it('is empty when no definition can be found (resume refuses such a run)', () => {
    expect(hostCommandStatesForResume(runDir)).toEqual([]);
  });
});

describe('writeRunDefinition', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ic-run-definition-write-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the copy through a run directory that is a symlink, never through a symlinked copy', () => {
    const moved = join(root, 'other-disk', 'wf-1');
    mkdirSync(moved, { recursive: true });
    const runDir = join(root, 'wf-1');
    symlinkSync(moved, runDir);
    writeRunDefinition(runDir, hostDefinition);
    expect(lstatSync(join(moved, 'definition.json')).isFile()).toBe(true);

    // A symlink at the copy's own name is replaced, its target left alone.
    const target = join(root, 'target.json');
    writeFileSync(target, 'untouched');
    rmSync(join(moved, 'definition.json'));
    symlinkSync(target, join(moved, 'definition.json'));
    writeRunDefinition(runDir, hostDefinition);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(join(moved, 'definition.json')).isFile()).toBe(true);
  });
});
