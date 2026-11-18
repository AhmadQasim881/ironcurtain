/**
 * The `ironcurtain` CLI run as a user runs it (src/cli.ts through tsx), each
 * time in a fresh HOME, IRONCURTAIN_HOME and working directory, with stdin
 * not a terminal:
 *
 * - every top-level command answers --help with its usage and exit 0, and
 *   creates no file, also on a host where the V8 sandbox cannot load
 *   (test/fixtures/block-isolated-vm-hook.mjs makes isolated-vm and
 *   @utcp/code-mode unresolvable, as an unsupported Node.js or a stale
 *   native build does);
 * - a --help before the command prints the top-level help and runs nothing;
 * - the read-only daemon and workflow commands work on such a host, while
 *   the commands that run sessions still stop at the sandbox preflight;
 * - `bot --agent X`, in every spelling, is the Signal-only bot and never the
 *   cron daemon;
 * - the interactive commands refuse cleanly without a terminal, and the
 *   escalation listener, under one, ends cleanly on EOF.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { topLevelCommandNames } from '../src/cli-routing.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = resolve(projectRoot, 'src', 'cli.ts');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const NO_SANDBOX_HOOK = pathToFileURL(resolve(projectRoot, 'test', 'fixtures', 'block-isolated-vm-hook.mjs')).href;
const CLI_TIMEOUT_MS = 90_000;

/** One CLI invocation's fresh directories (short paths: the daemon socket lives in `icHome`). */
interface CliDirs {
  readonly root: string;
  readonly home: string;
  readonly icHome: string;
  readonly cwd: string;
}

interface CliRun {
  readonly status: number | null;
  /** stdout and stderr, interleaved. */
  readonly output: string;
}

let base: string;

function freshDirs(label: string): CliDirs {
  const root = mkdtempSync(join(base, `${label.slice(0, 12)}-`));
  const dirs = { root, home: join(root, 'home'), icHome: join(root, 'ich'), cwd: join(root, 'cwd') };
  mkdirSync(dirs.home);
  mkdirSync(dirs.cwd);
  return dirs;
}

/** Every file or directory the run left in HOME, IRONCURTAIN_HOME or its working directory. */
function createdEntries(dirs: CliDirs): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      found.push(relative(dirs.root, path));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dirs.home);
  walk(dirs.cwd);
  if (existsSync(dirs.icHome)) {
    found.push(relative(dirs.root, dirs.icHome));
    walk(dirs.icHome);
  }
  return found;
}

function runCli(
  dirs: CliDirs,
  args: readonly string[],
  options: { readonly noSandbox?: boolean } = {},
): Promise<CliRun> {
  const nodeArgs = ['--import', TSX_LOADER, ...(options.noSandbox ? ['--import', NO_SANDBOX_HOOK] : [])];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI_ENTRY, ...args], {
      cwd: dirs.cwd,
      env: { PATH: process.env.PATH ?? '', HOME: dirs.home, IRONCURTAIN_HOME: dirs.icHome, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf-8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf-8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS - 5_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, output });
    });
  });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ic-cli-')));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('every top-level command answers --help', () => {
  it.concurrent.each(topLevelCommandNames())(
    '%s --help prints its usage, exits 0 and creates no file, even without the V8 sandbox',
    async (command) => {
      const dirs = freshDirs(command);
      const run = await runCli(dirs, [command, '--help'], { noSandbox: true });
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(command === 'help' ? 'ironcurtain - ' : `ironcurtain ${command}`);
      expect(run.output).not.toContain('Fatal Error');
      expect(createdEntries(dirs)).toEqual([]);
    },
    CLI_TIMEOUT_MS,
  );

  // The commands that ignored --help before (or ran something first).
  it.concurrent.each(['setup', 'config', 'customize-policy', 'escalation-listener', 'bot', 'setup-signal', 'daemon'])(
    '%s -h prints its usage, exits 0 and creates no file',
    async (command) => {
      const dirs = freshDirs(command);
      const run = await runCli(dirs, [command, '-h']);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(`ironcurtain ${command} - `);
      expect(createdEntries(dirs)).toEqual([]);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'prints the top-level help for a --help before the command, instead of running the command',
    async () => {
      for (const args of [
        ['--help', 'start'],
        ['-h', 'daemon'],
      ]) {
        const dirs = freshDirs('global-help');
        const run = await runCli(dirs, args);
        expect(run.status, run.output).toBe(0);
        expect(run.output).toContain('ironcurtain - Secure agent runtime');
        expect(createdEntries(dirs)).toEqual([]);
      }
    },
    CLI_TIMEOUT_MS * 2,
  );
});

describe('on a host where isolated-vm cannot load', () => {
  it(
    'daemon list-jobs and status and workflow list still work',
    async () => {
      const dirs = freshDirs('no-sandbox');
      const list = await runCli(dirs, ['daemon', 'list-jobs'], { noSandbox: true });
      expect(list.status, list.output).toBe(0);
      expect(list.output).toContain('No jobs configured.');
      expect(list.output).not.toContain('Fatal Error');
      // Neither the sandbox preflight nor the session mode (its "Mode:" line).
      expect(list.output).not.toContain('Mode:');

      const status = await runCli(dirs, ['daemon', 'status'], { noSandbox: true });
      expect(status.status, status.output).toBe(0);
      expect(status.output).toContain('Daemon is not running.');

      const workflows = await runCli(dirs, ['workflow', 'list'], { noSandbox: true });
      expect(workflows.status, workflows.output).toBe(0);
      expect(workflows.output).toContain('design-and-code');
    },
    CLI_TIMEOUT_MS * 3,
  );

  it(
    'commands that run sessions here still stop at the sandbox preflight',
    async () => {
      const dirs = freshDirs('preflight');
      for (const args of [
        ['start', 'summarize the notes'],
        ['workflow', 'start', 'design-and-code', 'a task'],
        // No daemon answers, so the job would run in this process.
        ['daemon', 'run-job', 'nightly'],
      ]) {
        const run = await runCli(dirs, args, { noSandbox: true });
        expect(run.status, `${args.join(' ')}: ${run.output}`).toBe(1);
        expect(run.output).toContain('Fatal Error: Missing required dependency: @utcp/code-mode');
      }
      expect(existsSync(join(dirs.icHome, 'daemon.lock'))).toBe(false);
    },
    CLI_TIMEOUT_MS * 3,
  );
});

describe('ironcurtain bot', () => {
  it.each([[['--agent', 'goose']], [['-a', 'goose']], [['--agent=goose']]])(
    'bot %j is the Signal-only bot and never starts the cron daemon',
    async (agentArgs) => {
      const dirs = freshDirs('bot');
      // Without the V8 sandbox too: bot checks its arguments and the Signal
      // configuration before its own sandbox preflight (src/cli.ts runs none
      // for it).
      const run = await runCli(dirs, ['bot', ...agentArgs], { noSandbox: true });
      // The Signal bot's own check, not the daemon's preflight or start-up.
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('Signal is not configured. Run: ironcurtain setup-signal');
      expect(run.output).not.toContain('Fatal Error');
      expect(run.output).not.toContain('Mode:');
      expect(existsSync(join(dirs.icHome, 'daemon.lock'))).toBe(false);
      expect(existsSync(join(dirs.icHome, 'daemon.sock'))).toBe(false);
      expect(existsSync(join(dirs.icHome, 'jobs'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    'refuses a subcommand and points at ironcurtain daemon',
    async () => {
      const dirs = freshDirs('bot-sub');
      const run = await runCli(dirs, ['bot', 'list-jobs'], { noSandbox: true });
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain("ironcurtain bot takes no subcommand ('list-jobs')");
      expect(run.output).toContain('ironcurtain daemon --help');
      expect(run.output).not.toContain('Fatal Error');
      expect(existsSync(join(dirs.icHome, 'daemon.lock'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );
});

describe('the commands that ignored their arguments now parse them strictly', () => {
  // They once ran (a wizard, a TUI taking its lock, Signal onboarding) or
  // refused for want of a terminal whatever the arguments said.
  it.concurrent.each(['setup', 'config', 'customize-policy', 'escalation-listener', 'setup-signal'])(
    '%s refuses an unknown option before anything else',
    async (command) => {
      const dirs = freshDirs(command);
      const run = await runCli(dirs, [command, '--bogus']);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain("Unknown option '--bogus'");
      expect(run.output).toContain(`Run \`ironcurtain ${command} --help\` for usage.`);
      expect(run.output).not.toContain('requires an interactive terminal');
      // Only the version record every known command writes (src/config/state-version.ts).
      expect(createdEntries(dirs)).toEqual(['ich', join('ich', 'state.json')]);
    },
    CLI_TIMEOUT_MS,
  );
});

describe('interactive commands without a terminal', () => {
  it(
    'escalation-listener refuses before taking its lock or creating a directory',
    async () => {
      const dirs = freshDirs('listener');
      const run = await runCli(dirs, ['escalation-listener']);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain('ironcurtain escalation-listener requires an interactive terminal (TTY).');
      expect(existsSync(join(dirs.icHome, 'escalation-listener.lock'))).toBe(false);
      expect(existsSync(join(dirs.icHome, 'pty-registry'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  it.each(['setup', 'config', 'customize-policy'])(
    '%s refuses without starting its prompts or writing a config',
    async (command) => {
      const dirs = freshDirs(command);
      const run = await runCli(dirs, [command]);
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain(`ironcurtain ${command} requires an interactive terminal (TTY).`);
      expect(existsSync(join(dirs.icHome, 'config.json'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );
});

/** node-pty when it loads and can spawn here (it is an optional dependency); probing repairs nothing. */
async function loadPty(): Promise<typeof import('node-pty') | undefined> {
  try {
    const { probeNodePty } = await import('../src/pty/node-pty-loader.js');
    if ((await probeNodePty()).status !== 'ok') return undefined;
    return await import('node-pty');
  } catch {
    return undefined;
  }
}

describe('escalation-listener under a terminal', () => {
  it(
    'ends on EOF with exit 0 and releases its lock',
    async (context) => {
      const pty = await loadPty();
      if (!pty) {
        context.skip();
        return;
      }
      const dirs = freshDirs('listener-tty');
      const term = pty.spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'escalation-listener'], {
        cwd: dirs.cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dirs.home,
          IRONCURTAIN_HOME: dirs.icHome,
          NO_COLOR: '1',
          TERM: 'xterm',
        },
        cols: 120,
        rows: 40,
      });
      let output = '';
      let sentEof = false;
      const exit = await new Promise<{ exitCode: number; signal?: number }>((resolvePromise) => {
        const timer = setTimeout(() => term.kill('SIGKILL'), CLI_TIMEOUT_MS - 10_000);
        term.onData((data) => {
          output += data;
          if (!sentEof && output.includes('Escalation Listener')) {
            sentEof = true;
            // Ctrl-D at an empty prompt: readline closes, as on /quit.
            setTimeout(() => term.write('\x04'), 300);
          }
        });
        term.onExit((event) => {
          clearTimeout(timer);
          resolvePromise(event);
        });
      });
      expect(sentEof, output).toBe(true);
      expect(exit.exitCode, output).toBe(0);
      expect(existsSync(join(dirs.icHome, 'escalation-listener.lock'))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );
});
