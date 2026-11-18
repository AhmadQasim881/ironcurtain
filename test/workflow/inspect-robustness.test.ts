/**
 * `workflow inspect` shows every run it can, whatever one run holds (WP-83,
 * WFC-28): an agent can plant links (dangling ones too) in the workspace's
 * `.workflow`, and a run directory can hold a file that cannot be read. Each
 * used to abort the whole command, hiding every other run.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main as workflowMain } from '../../src/workflow/workflow-command.js';

const DEFINITION = {
  name: 'inspect-flow',
  description: 'A minimal valid workflow',
  initial: 'done',
  states: { done: { type: 'terminal', description: 'Terminal state' } },
};

let base: string;
let home: string;
let originalHome: string | undefined;
let stdout: string[];
let stderr: string[];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

/** A run with a definition copy, a checkpoint and a message log. */
function seedRun(id: string): string {
  const runDir = join(base, id);
  mkdirSync(join(runDir, 'workspace', '.workflow'), { recursive: true });
  writeFileSync(join(runDir, 'definition.json'), JSON.stringify(DEFINITION));
  writeFileSync(
    join(runDir, 'checkpoint.json'),
    JSON.stringify({
      machineState: 'done',
      context: { taskDescription: `task of ${id}` },
      timestamp: '2026-11-10T00:00:00.000Z',
      transitionHistory: [],
      definitionPath: join(base, 'no-such-definition.json'),
    }),
  );
  writeFileSync(
    join(runDir, 'messages.jsonl'),
    JSON.stringify({ type: 'error', ts: '2026-11-10T00:00:01.000Z', workflowId: id, state: 'done', error: 'boom' }) +
      '\n',
  );
  return runDir;
}

/** Fixes the newest-first order of the runs (directory mtimes), after their content is in place. */
function setAge(runDir: string, age: number): void {
  const when = new Date(Date.UTC(2026, 0, 1) - age * 60_000);
  utimesSync(runDir, when, when);
}

async function inspect(): Promise<{ out: string; err: string }> {
  await workflowMain(['inspect', base]);
  return { out: stdout.join(''), err: stderr.join('') };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ic-inspect-robust-'));
  home = mkdtempSync(join(tmpdir(), 'ic-inspect-home-'));
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  stdout = [];
  stderr = [];
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = originalHome;
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('workflow inspect robustness', () => {
  it('lists artifact directories without following links an agent planted, dangling or not', async () => {
    const planted = seedRun('wf-planted');
    const artifactDir = join(planted, 'workspace', '.workflow');
    mkdirSync(join(artifactDir, 'plan'));
    mkdirSync(join(artifactDir, 'review'));
    writeFileSync(join(artifactDir, 'stray.txt'), 'not an artifact directory');
    symlinkSync(join(base, 'gone'), join(artifactDir, 'dangling'));
    symlinkSync(base, join(artifactDir, 'linked-dir'));
    setAge(planted, 0);
    setAge(seedRun('wf-older'), 1);

    const { out } = await inspect();

    expect(out).toContain('Workflow: wf-planted');
    expect(out).toContain('Artifacts: plan, review\n');
    expect(out).not.toContain('dangling');
    expect(out).not.toContain('linked-dir');
    expect(out).toContain('Workflow: wf-older');
  });

  it('does not follow a .workflow that is itself a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ic-inspect-outside-'));
    try {
      mkdirSync(join(outside, 'host-secret-dir'));
      const runDir = seedRun('wf-linked-root');
      rmSync(join(runDir, 'workspace', '.workflow'), { recursive: true });
      symlinkSync(outside, join(runDir, 'workspace', '.workflow'));

      const { out } = await inspect();

      expect(out).toContain('Workflow: wf-linked-root');
      expect(out).toContain('(not listed: .workflow is not a directory)');
      expect(out).not.toContain('host-secret-dir');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a run whose files cannot be read where it would appear, and still shows the next run', async () => {
    const unreadable = seedRun('wf-unreadable');
    // A message log that is not a readable file (EISDIR on read).
    rmSync(join(unreadable, 'messages.jsonl'));
    mkdirSync(join(unreadable, 'messages.jsonl'));
    setAge(unreadable, 0);
    setAge(seedRun('wf-fine'), 1);

    const { out } = await inspect();

    expect(out).toMatch(/Could not inspect wf-unreadable: .*EISDIR/u);
    expect(out).toContain('Workflow: wf-fine');
    expect(out.indexOf('Workflow: wf-fine')).toBeGreaterThan(out.indexOf('Could not inspect wf-unreadable'));
    expect(out).toContain('Task: task of wf-fine');
  });

  it('skips a run directory that cannot be examined with a warning, and shows the others', async () => {
    const looped = seedRun('wf-looped');
    rmSync(join(looped, 'checkpoint.json'));
    symlinkSync('checkpoint.json', join(looped, 'checkpoint.json'));
    setAge(looped, 0);
    setAge(seedRun('wf-fine'), 1);

    const { out, err } = await inspect();

    expect(err).toMatch(/Skipping run directory .*wf-looped: .*ELOOP/u);
    expect(out).not.toContain('Workflow: wf-looped');
    expect(out).toContain('Workflow: wf-fine');
  });
});
