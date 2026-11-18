/**
 * The CLI's startup state check (src/cli.ts + src/config/state-version.ts),
 * run as a user would run it: the first command after an upgrade prints the
 * notice and records the version, `doctor` and `--help` record nothing, and
 * a home with a newer layout is refused.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = resolve(projectRoot, 'src', 'cli.ts');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI_TIMEOUT_MS = 90_000;

let root: string;

function runCli(home: string, args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: join(root, 'user'), IRONCURTAIN_HOME: home, NO_COLOR: '1' },
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr };
}

function writeState(home: string, state: unknown): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(state);
  writeFileSync(join(home, 'state.json'), text, { mode: 0o600 });
  return text;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-cli-upgrade-')));
  mkdirSync(join(root, 'user'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI upgrade notice', () => {
  it(
    'prints the notice on a lastRunVersion mismatch, once, and records the running version',
    () => {
      const home = join(root, 'upgraded');
      writeState(home, { layoutVersion: 1, lastRunVersion: '0.0.1' });

      const first = runCli(home, ['persona', 'list']);
      expect(first.status).toBe(0);
      expect(first.stderr).toContain(`IronCurtain was upgraded from 0.0.1 to ${VERSION}.`);
      expect(first.stderr).toContain('Run `ironcurtain doctor --upgrade`');
      expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf-8'))).toMatchObject({ lastRunVersion: VERSION });

      const second = runCli(home, ['persona', 'list']);
      expect(second.stderr).not.toContain('IronCurtain was upgraded');
    },
    CLI_TIMEOUT_MS * 2,
  );

  it(
    'records nothing for doctor --help or a subcommand --help',
    () => {
      const home = join(root, 'help');
      const state = writeState(home, { layoutVersion: 1, lastRunVersion: '0.0.1' });
      expect(runCli(home, ['doctor', '--help']).status).toBe(0);
      expect(runCli(home, ['persona', '--help']).stderr).not.toContain('IronCurtain was upgraded');
      expect(readFileSync(join(home, 'state.json'), 'utf-8')).toBe(state);
    },
    CLI_TIMEOUT_MS * 2,
  );

  it(
    'refuses a home whose layout is newer than this version supports',
    () => {
      const home = join(root, 'newer');
      const state = writeState(home, { layoutVersion: 99, lastRunVersion: '99.0.0' });
      const run = runCli(home, ['persona', 'list']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('has layout version 99, newer than the layout version 1');
      expect(readFileSync(join(home, 'state.json'), 'utf-8')).toBe(state);
    },
    CLI_TIMEOUT_MS,
  );
});
