/**
 * The daemon-backed workflow CLI (`workflow resume|status|await|gate|
 * escalation|show`) refuses a workflow id that is not one safe path segment
 * as a usage error, before it contacts (or starts) a daemon.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDaemonGateCommand } from '../../src/workflow/daemon-gate-commands.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: childProcess.spawn,
}));

describe('workflow CLI workflow-id validation', () => {
  let home: string;
  let savedHome: string | undefined;
  let stdout: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-wf-id-cli-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home; // no daemon, no web-ui.json
    stdout = [];
    childProcess.spawn.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  function lastJson(): Record<string, unknown> {
    const line = stdout.join('').trim().split('\n').pop() ?? '';
    return JSON.parse(line) as Record<string, unknown>;
  }

  // A traversal that does not exist on disk, so `resume` treats it as an id.
  const traversal = `../../ic-missing-${randomUUID()}`;

  it.each([
    ['resume', [traversal]],
    ['status', [traversal]],
    ['await', [traversal]],
    ['gate', [traversal, '--gate-id', 'g', '--event', 'APPROVE']],
    ['escalation', [traversal, '--deny']],
    ['show', [traversal, '--artifact', 'plan']],
  ])('%s rejects a traversal id as a usage error without contacting a daemon', async (subcommand, args) => {
    const exitCode = await runDaemonGateCommand(subcommand, [...args, '--json', '--ensure-daemon']);
    expect(exitCode).toBe(2);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: 'INVALID_PARAMS',
      message: expect.stringContaining('Invalid workflow ID'),
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('resume rejects a traversal --workflow-id inside an existing base directory', async () => {
    const baseDir = join(home, 'external-runs');
    mkdirSync(baseDir);
    const exitCode = await runDaemonGateCommand('resume', [baseDir, '--workflow-id', '../../x', '--json']);
    expect(exitCode).toBe(2);
    expect(lastJson()).toMatchObject({ error: 'INVALID_PARAMS', message: expect.stringContaining('../../x') });
  });

  it('resume accepts --trust only together with a base directory', async () => {
    const exitCode = await runDaemonGateCommand('resume', ['wf-1', '--trust', '--json']);
    expect(exitCode).toBe(2);
    expect(lastJson()).toMatchObject({ error: 'INVALID_PARAMS', message: expect.stringContaining('--trust') });
  });
});
