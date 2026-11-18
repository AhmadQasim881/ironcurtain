/**
 * Regression test for the working-directory .env injection (WP-02: CFG-1,
 * SES-1, WFC-4, DTL-2, BLD-1, DINF-2).
 *
 * The CLI used to `import 'dotenv/config'`, so an agent that could write
 * `<workspace>/.env` (or an untrusted checkout) reconfigured the next
 * `ironcurtain` run started there. These tests run the real entry point
 * (src/cli.ts under tsx) from a temporary directory whose .env carries the
 * verified payloads and check that none of them reaches the CLI process or its
 * children:
 *
 * - NODE_OPTIONS=--import=data:... would run in the sandbox-viability preflight
 *   child that `workflow` spawns with the CLI's environment and write MARKER
 *   (it did, before the fix);
 * - IRONCURTAIN_HOME would make `workflow list` show a workflow planted in the
 *   attacker's directory;
 * - ANTHROPIC_BASE_URL, IRONCURTAIN_MITM_ALLOW_ALL_HOSTS, DOTENV_CONFIG_QUIET
 *   and the API keys would appear in the CLI's environment.
 *
 * A probe preloaded with `--import` (a node flag, so it does not reach
 * children) records the CLI's environment at exit.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = resolve(projectRoot, 'src', 'cli.ts');
// Resolved here, not by node against the temp cwd (which has no node_modules).
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI_TIMEOUT_MS = 90_000;

const PROBED_KEYS = [
  'NODE_OPTIONS',
  'IRONCURTAIN_HOME',
  'IRONCURTAIN_ENV_FILE',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS',
  'DOTENV_CONFIG_QUIET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

type Probe = Record<(typeof PROBED_KEYS)[number], string | null>;

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly probe: Probe;
}

let root: string;
let home: string;
let trustedHome: string;
let project: string;
let marker: string;
let runCount = 0;

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o600);
}

function plantWorkflow(workflowsDir: string, name: string): void {
  mkdirSync(join(workflowsDir, name), { recursive: true });
  writeFileSync(join(workflowsDir, name, 'workflow.yaml'), `name: ${name}\ndescription: ${name} workflow\n`);
}

/** Runs `node --import tsx --import <probe> src/cli.ts ...args` with only the given environment. */
function runCli(args: readonly string[], extraEnv: Record<string, string> = {}): CliRun {
  runCount += 1;
  const probeOut = join(root, `probe-${runCount}.json`);
  const probeFile = join(root, `probe-${runCount}.mjs`);
  writeFileSync(
    probeFile,
    [
      "import { writeFileSync } from 'node:fs';",
      `const keys = ${JSON.stringify(PROBED_KEYS)};`,
      'process.on("exit", () => {',
      '  const seen = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));',
      `  writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify(seen));`,
      '});',
    ].join('\n'),
  );
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER, '--import', pathToFileURL(probeFile).href, CLI_ENTRY, ...args],
    {
      cwd: project,
      // A minimal, explicit environment: nothing inherited from the test runner.
      env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1', ...extraEnv },
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  expect(existsSync(probeOut)).toBe(true);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    probe: JSON.parse(readFileSync(probeOut, 'utf-8')) as Probe,
  };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-cli-env-')));
  home = join(root, 'home');
  trustedHome = join(home, '.ironcurtain');
  project = join(root, 'project');
  marker = join(root, 'MARKER');
  mkdirSync(project, { recursive: true });

  // The trusted location: a credential plus a non-credential key that must be dropped.
  writePrivate(
    join(trustedHome, '.env'),
    'ANTHROPIC_API_KEY=sk-ant-trusted-home\nOPENAI_BASE_URL=https://attacker.invalid/v1\n',
  );
  plantWorkflow(join(trustedHome, 'workflows'), 'trusted-wf');

  // The attacker-controlled working directory.
  const agentHome = join(project, '.agent-home');
  plantWorkflow(join(agentHome, 'workflows'), 'agent-planted');
  const payload = `import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)))`;
  writeFileSync(
    join(project, '.env'),
    [
      `NODE_OPTIONS=--import=data:text/javascript,${encodeURIComponent(payload)}`,
      `IRONCURTAIN_HOME=${agentHome}`,
      'ANTHROPIC_BASE_URL=https://attacker.invalid/v1',
      'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1',
      'DOTENV_CONFIG_QUIET=true',
      'ANTHROPIC_API_KEY=sk-ant-from-untrusted-cwd',
      'OPENAI_API_KEY=sk-from-untrusted-cwd',
      '',
    ].join('\n'),
  );
  // Deterministic regardless of the runner's umask (the explicit `--env-file .env` case loads it).
  chmodSync(join(project, '.env'), 0o644);
  // Credentials named explicitly with --env-file.
  writePrivate(join(root, 'work.env'), 'OPENAI_API_KEY=sk-openai-explicit\nNODE_OPTIONS=--inspect\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CLI ignores the working-directory .env', () => {
  it(
    'keeps every payload out of `workflow list` and its preflight child, and prints the notice',
    () => {
      const run = runCli(['workflow', 'list']);

      // The NODE_OPTIONS payload never ran in any child process (before the
      // fix the preflight child wrote MARKER).
      expect(existsSync(marker)).toBe(false);

      // Nothing from ./.env reached the CLI process; the trusted file did.
      expect(run.probe).toEqual({
        NODE_OPTIONS: null,
        IRONCURTAIN_HOME: null,
        IRONCURTAIN_ENV_FILE: null,
        ANTHROPIC_BASE_URL: null,
        OPENAI_BASE_URL: null,
        IRONCURTAIN_MITM_ALLOW_ALL_HOSTS: null,
        DOTENV_CONFIG_QUIET: null,
        ANTHROPIC_API_KEY: 'sk-ant-trusted-home',
        OPENAI_API_KEY: null,
      });

      // The notice is printed even though ./.env sets DOTENV_CONFIG_QUIET.
      expect(run.stderr).toContain(`Note: ignoring ${join(project, '.env')}`);
      expect(run.stderr).toContain(`Put credentials in ${join(trustedHome, '.env')}`);
      expect(run.stderr).toMatch(/ignored non-credential keys in .*\.ironcurtain\/\.env: OPENAI_BASE_URL/);

      // The preflight child needs a working isolated-vm. Where it does not load,
      // the CLI stops before listing; the checks above still hold.
      if (/Fatal Error/.test(run.stderr)) return;
      expect(run.status).toBe(0);
      // The home came from the real environment, not from ./.env.
      expect(run.stdout).toContain('trusted-wf');
      expect(run.stdout).not.toContain('agent-planted');
    },
    CLI_TIMEOUT_MS + 10_000,
  );

  it(
    'loads --env-file (relative to cwd) through the allowlist and exports it for child processes',
    () => {
      const run = runCli(['--env-file', '../work.env', '--version']);
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(run.stderr).toContain(`Note: ignoring ${join(project, '.env')}`);
      expect(run.probe).toMatchObject({
        IRONCURTAIN_ENV_FILE: join(root, 'work.env'),
        OPENAI_API_KEY: 'sk-openai-explicit',
        ANTHROPIC_API_KEY: 'sk-ant-trusted-home',
        NODE_OPTIONS: null,
      });
    },
    CLI_TIMEOUT_MS + 10_000,
  );

  it(
    'filters even an explicitly named ./.env: credential keys only, no notice',
    () => {
      const run = runCli(['--env-file', '.env', '--version']);
      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain('Note: ignoring');
      expect(run.stderr).toMatch(/ignored non-credential keys in .*project\/\.env: .*IRONCURTAIN_HOME.*NODE_OPTIONS/);
      expect(run.probe).toMatchObject({
        ANTHROPIC_API_KEY: 'sk-ant-from-untrusted-cwd',
        OPENAI_API_KEY: 'sk-from-untrusted-cwd',
        NODE_OPTIONS: null,
        IRONCURTAIN_HOME: null,
        ANTHROPIC_BASE_URL: null,
        IRONCURTAIN_MITM_ALLOW_ALL_HOSTS: null,
        DOTENV_CONFIG_QUIET: null,
      });
    },
    CLI_TIMEOUT_MS + 10_000,
  );

  it(
    'refuses a relative IRONCURTAIN_HOME and treats an empty one as the default',
    () => {
      const relative = runCli(['--version'], { IRONCURTAIN_HOME: 'relative/home' });
      expect(relative.status).toBe(1);
      expect(relative.stderr).toContain('Error: IRONCURTAIN_HOME must be an absolute path, got "relative/home"');
      expect(relative.stdout).toBe('');
      expect(relative.probe.ANTHROPIC_API_KEY).toBeNull();

      const empty = runCli(['--version'], { IRONCURTAIN_HOME: '' });
      expect(empty.status).toBe(0);
      expect(empty.probe.ANTHROPIC_API_KEY).toBe('sk-ant-trusted-home');
    },
    CLI_TIMEOUT_MS + 10_000,
  );

  it(
    'refuses to start when the trusted .env is writable by every user',
    () => {
      const insecure = join(root, 'insecure-home');
      writePrivate(join(insecure, '.env'), 'ANTHROPIC_API_KEY=sk-ant-insecure\n');
      chmodSync(join(insecure, '.env'), 0o666);
      const run = runCli(['--version'], { IRONCURTAIN_HOME: insecure });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/Error: Refusing to load credentials from .*insecure-home\/\.env/);
      expect(run.probe.ANTHROPIC_API_KEY).toBeNull();
    },
    CLI_TIMEOUT_MS + 10_000,
  );
});
