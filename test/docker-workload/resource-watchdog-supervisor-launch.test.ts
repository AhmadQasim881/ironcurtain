/**
 * Launch-path tests for the detached watchdog supervisor: which entrypoint a
 * coordinator launches, with which Node options, and how fast a child that
 * cannot start is reported. The children here are tiny scripts, not the real
 * supervisor; the real one is exercised by watchdog-sigkill.integration.test.ts.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  launchDetachedResourceWatchdogSupervisor,
  readResourceWatchdogSupervisorStderrTail,
  resolveResourceWatchdogSupervisorEntrypoint,
  RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE,
  supervisorLoaderExecArgv,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function controlDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'watchdog-launch-')));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function launchOptions(directory: string, entrypointPath: string, startupTimeoutMs = 20_000) {
  return {
    leasePath: join(directory, 'lease.json'),
    policyPath: join(directory, 'policy.json'),
    statusPath: join(directory, 'status.json'),
    stopRequestPath: join(directory, 'stop.json'),
    entrypointPath,
    startupTimeoutMs,
  };
}

describe('watchdog supervisor entrypoint resolution', () => {
  it('launches the entrypoint beside the running module: source under tsx, the build under dist', () => {
    expect(
      resolveResourceWatchdogSupervisorEntrypoint('file:///repo/src/docker-workload/resource-watchdog-supervisor.ts'),
    ).toBe('/repo/src/docker-workload/resource-watchdog-supervisor-main.ts');
    expect(
      resolveResourceWatchdogSupervisorEntrypoint('file:///repo/dist/docker-workload/resource-watchdog-supervisor.js'),
    ).toBe('/repo/dist/docker-workload/resource-watchdog-supervisor-main.js');
    expect(() =>
      resolveResourceWatchdogSupervisorEntrypoint('file:///repo/src/docker-workload/resource-watchdog-supervisor.mts'),
    ).toThrow(/unsupported extension/u);
  });

  it('resolves to an entrypoint that exists in this checkout without a build', () => {
    const entrypoint = resolveResourceWatchdogSupervisorEntrypoint();
    expect(entrypoint).toMatch(/src\/docker-workload\/resource-watchdog-supervisor-main\.ts$/u);
    expect(existsSync(entrypoint)).toBe(true);
  });

  it('passes only module-loader options to the child', () => {
    expect(
      supervisorLoaderExecArgv([
        '--require',
        '/repo/node_modules/tsx/dist/preflight.cjs',
        '--import',
        'file:///repo/node_modules/tsx/dist/loader.mjs',
        '--inspect-brk=9229',
        '--inspect',
        '--inspect-port=0',
        '--max-old-space-size=100',
        '--watch',
        '-e',
        'process.exit(0)',
        '--conditions=development',
        '-r',
        './preload.cjs',
        '--enable-source-maps',
      ]),
    ).toEqual([
      '--require',
      '/repo/node_modules/tsx/dist/preflight.cjs',
      '--import',
      'file:///repo/node_modules/tsx/dist/loader.mjs',
      '--conditions=development',
      '-r',
      './preload.cjs',
      '--enable-source-maps',
    ]);
    expect(supervisorLoaderExecArgv(['--import', 'tsx'])).toEqual(['--import', 'tsx']);
    expect(supervisorLoaderExecArgv([])).toEqual([]);
  });
});

describe('watchdog supervisor launch failures', () => {
  it('fails before spawning when the entrypoint is missing', async () => {
    const directory = controlDirectory();
    const missing = join(directory, 'dist', 'docker-workload', 'resource-watchdog-supervisor-main.js');
    const startedAt = Date.now();

    await expect(launchDetachedResourceWatchdogSupervisor(launchOptions(directory, missing))).rejects.toThrow(
      /watchdog supervisor entrypoint is missing: .*resource-watchdog-supervisor-main\.js/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(join(directory, RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE))).toBe(false);
  });

  it('reports a child that dies at once with its exit code and stderr instead of waiting out the deadline', async () => {
    const directory = controlDirectory();
    const entrypoint = join(directory, 'crashing-supervisor.mjs');
    writeFileSync(
      entrypoint,
      "process.stderr.write('x'.repeat(64 * 1024) + '\\nsupervisor could not load its policy\\n');\nprocess.exit(7);\n",
    );
    const startedAt = Date.now();

    const failure = launchDetachedResourceWatchdogSupervisor(launchOptions(directory, entrypoint));
    await expect(failure).rejects.toThrow(
      /exited during startup with exit code 7: .*supervisor could not load its policy$/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const message = await failure.then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );
    expect(message.length).toBeLessThan(5_000);
    const log = join(directory, RESOURCE_WATCHDOG_SUPERVISOR_STDERR_FILE);
    expect(lstatSync(log).mode & 0o777).toBe(0o600);
    expect(readResourceWatchdogSupervisorStderrTail(log)).toMatch(/supervisor could not load its policy$/u);
  });

  it('reports a dist entry that cannot load its modules with exit code 1', async () => {
    const directory = controlDirectory();
    const entrypoint = join(directory, 'stale-dist-supervisor.mjs');
    writeFileSync(entrypoint, "import './resource-watchdog-supervisor.js';\n");

    await expect(launchDetachedResourceWatchdogSupervisor(launchOptions(directory, entrypoint))).rejects.toThrow(
      /exited during startup with exit code 1: .*(?:ERR_MODULE_NOT_FOUND|Cannot find module)/u,
    );
  });

  it('truncates the previous launch log and writes the configured log path', async () => {
    const directory = controlDirectory();
    const log = join(directory, 'custom-stderr.log');
    writeFileSync(log, 'stale output from an earlier launch\n', { mode: 0o600 });
    const entrypoint = join(directory, 'quiet-crash.mjs');
    writeFileSync(entrypoint, "process.stderr.write('fresh failure\\n');\nprocess.exit(3);\n");

    await expect(
      launchDetachedResourceWatchdogSupervisor({ ...launchOptions(directory, entrypoint), stderrLogPath: log }),
    ).rejects.toThrow(/exit code 3: fresh failure$/u);
    expect(readFileSync(log, 'utf8')).toBe('fresh failure\n');
  });

  it('honours a slow child up to the deadline and then reports it with its stderr', async () => {
    const directory = controlDirectory();
    const entrypoint = join(directory, 'hung-supervisor.mjs');
    writeFileSync(entrypoint, "process.stderr.write('waiting for a lock\\n');\nsetInterval(() => {}, 1000);\n");

    await expect(launchDetachedResourceWatchdogSupervisor(launchOptions(directory, entrypoint, 500))).rejects.toThrow(
      /did not attest before the startup deadline: waiting for a lock$/u,
    );
  });
});
