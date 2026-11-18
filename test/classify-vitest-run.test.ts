/**
 * Unit tests for the run ledger (scripts/vitest-run-ledger.ts) and the run
 * classifier (scripts/classify-vitest-run.ts) that scripts/test.sh uses to
 * tell the benign worker-teardown flake (issue #363) from a worker crash that
 * lost test results (BLD-3). test/test-sh-worker-crash.integration.test.ts
 * drives the same code through test.sh and the real vitest.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEARDOWN_SIGNATURE,
  classifyVitestRun,
  isWorkerExitError,
  parseRunLedger,
} from '../scripts/classify-vitest-run.js';
import RunLedgerReporter, {
  LEDGER_PATH_ENV,
  buildRunLedger,
  describeUnhandledError,
  writeRunLedger,
  type LedgerError,
  type LedgerModule,
  type LedgerModuleSource,
  type RunLedger,
} from '../scripts/vitest-run-ledger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

/** The error vitest's main process records when a forked worker dies (vitest 4). */
const WORKER_EXIT: LedgerError = {
  type: 'Unhandled Error',
  name: 'Error',
  message: '[vitest-pool]: Worker forks emitted error.',
  causes: ['Worker exited unexpectedly'],
};

const UNHANDLED_REJECTION: LedgerError = {
  type: 'Unhandled Rejection',
  name: 'Error',
  message: 'rejected and never handled',
  causes: [],
};

function moduleEntry(moduleId: string, state: string, tests: Partial<LedgerModule['tests']> = {}): LedgerModule {
  return {
    project: 'main',
    moduleId,
    state,
    tests: { passed: 0, failed: 0, skipped: 0, pending: 0, ...tests },
  };
}

function ledgerOf(modules: LedgerModule[], unhandledErrors: LedgerError[], extra: Partial<RunLedger> = {}): RunLedger {
  return {
    version: 1,
    reason: 'passed',
    planned: modules.map(({ project, moduleId }) => ({ project, moduleId })),
    modules,
    unhandledErrors,
    ...extra,
  };
}

const PASSING = moduleEntry('/repo/test/a.test.ts', 'passed', { passed: 4, skipped: 1 });
const ALSO_PASSING = moduleEntry('/repo/test/b.test.ts', 'passed', { passed: 2 });

describe('isWorkerExitError', () => {
  it('recognizes the pool error caused by a worker exit, and the bare exit error', () => {
    expect(isWorkerExitError(WORKER_EXIT)).toBe(true);
    expect(isWorkerExitError({ ...WORKER_EXIT, message: 'Worker exited unexpectedly', causes: [] })).toBe(true);
    expect(isWorkerExitError({ ...WORKER_EXIT, message: '[vitest-pool]: Worker threads emitted error.' })).toBe(true);
  });

  it('rejects other pool errors and errors reported from inside a worker', () => {
    expect(isWorkerExitError({ ...WORKER_EXIT, causes: ['channel closed'] })).toBe(false);
    expect(isWorkerExitError({ ...WORKER_EXIT, causes: [] })).toBe(false);
    expect(isWorkerExitError({ ...WORKER_EXIT, message: '[vitest-pool]: Timeout starting forks runner.' })).toBe(false);
    // Test code throwing the same message is an uncaught exception in the worker, not a worker exit.
    expect(
      isWorkerExitError({
        type: 'Uncaught Exception',
        name: 'Error',
        message: 'Worker exited unexpectedly',
        causes: [],
      }),
    ).toBe(false);
    expect(isWorkerExitError(UNHANDLED_REJECTION)).toBe(false);
  });
});

describe('classifyVitestRun', () => {
  it('passes a clean exit without consulting the ledger', () => {
    expect(classifyVitestRun({ exitCode: 0, ledger: null, log: '' })).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('calls a worker exit after every planned file and test finished the teardown flake', () => {
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: ledgerOf([PASSING, ALSO_PASSING], [WORKER_EXIT, WORKER_EXIT]),
      log: '',
    });
    expect(result.verdict).toBe('flake');
    expect(result.reasons.join('\n')).toContain('2 planned test files and 7 tests finished');
  });

  it('accepts skipped files and tests as finished', () => {
    const skipped = moduleEntry('/repo/test/skipped.test.ts', 'skipped', { skipped: 3 });
    const result = classifyVitestRun({ exitCode: 1, ledger: ledgerOf([PASSING, skipped], [WORKER_EXIT]), log: '' });
    expect(result.verdict).toBe('flake');
  });

  it('marks a crash mid-file incomplete (BLD-3: no test failed, yet tests never ran)', () => {
    const crashed = moduleEntry('/repo/test/crash.test.ts', 'pending', { passed: 1, pending: 2 });
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: ledgerOf([PASSING, crashed], [WORKER_EXIT]),
      log: '',
      root: '/repo',
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.reasons).toContain(
      'test/crash.test.ts [main]: file pending, tests 1 passed, 0 skipped, 2 without a result',
    );
  });

  it('marks a crash while importing incomplete, though the test totals stay consistent', () => {
    const crashed = moduleEntry('/repo/test/import-crash.test.ts', 'pending');
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: ledgerOf([PASSING, crashed], [WORKER_EXIT]),
      log: '',
      root: '/repo',
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.reasons).toContain('test/import-crash.test.ts [main]: file pending, no test was collected');
  });

  it('marks a planned file that never reported incomplete', () => {
    const ledger = ledgerOf([PASSING], [WORKER_EXIT]);
    ledger.planned.push({ project: 'isolated-vm', moduleId: '/repo/test/never.test.ts' });
    const result = classifyVitestRun({ exitCode: 1, ledger, log: '', root: '/repo' });
    expect(result.verdict).toBe('incomplete');
    expect(result.reasons).toContain('test/never.test.ts [isolated-vm]: no result (the file never started)');
  });

  it('marks queued files and passed files with unfinished tests incomplete', () => {
    const queued = moduleEntry('/repo/test/queued.test.ts', 'queued');
    const unfinished = moduleEntry('/repo/test/unfinished.test.ts', 'passed', { passed: 1, pending: 1 });
    for (const module of [queued, unfinished]) {
      const result = classifyVitestRun({ exitCode: 1, ledger: ledgerOf([PASSING, module], [WORKER_EXIT]), log: '' });
      expect(result.verdict).toBe('incomplete');
    }
  });

  it('marks a ledger with no planned files incomplete', () => {
    const result = classifyVitestRun({ exitCode: 1, ledger: ledgerOf([], [WORKER_EXIT]), log: '' });
    expect(result.verdict).toBe('incomplete');
  });

  it('fails a failed test or file even when a worker also died', () => {
    const failedTest = moduleEntry('/repo/test/fail.test.ts', 'failed', { passed: 1, failed: 1 });
    const failedImport = moduleEntry('/repo/test/syntax.test.ts', 'failed');
    for (const module of [failedTest, failedImport]) {
      const result = classifyVitestRun({ exitCode: 1, ledger: ledgerOf([PASSING, module], [WORKER_EXIT]), log: '' });
      expect(result.verdict).toBe('fail');
    }
  });

  it('fails an unhandled error from test code next to a worker death', () => {
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: ledgerOf([PASSING], [WORKER_EXIT, UNHANDLED_REJECTION]),
      log: 'Worker exited unexpectedly',
    });
    expect(result.verdict).toBe('fail');
    expect(result.reasons.join('\n')).toContain('Unhandled Rejection: rejected and never handled');
  });

  it('fails a non-zero exit that no worker exit explains, whatever the log says', () => {
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: ledgerOf([PASSING], []),
      log: 'close timed out after 30000ms\nTests closed successfully but something prevents Vite server from exiting',
    });
    expect(result.verdict).toBe('fail');
  });

  it('fails an interrupted run', () => {
    const result = classifyVitestRun({
      exitCode: 130,
      ledger: ledgerOf([PASSING], [WORKER_EXIT], { reason: 'interrupted' }),
      log: '',
    });
    expect(result.verdict).toBe('fail');
  });

  it('without a ledger, retries only when the log shows a worker death', () => {
    expect(classifyVitestRun({ exitCode: 1, ledger: null, log: 'Error: Worker exited unexpectedly' }).verdict).toBe(
      'incomplete',
    );
    // Colour codes inside the signature do not hide it.
    const colored = '\u001b[31mCaused by: Error: Worker \u001b[39mexited unexpectedly';
    expect(classifyVitestRun({ exitCode: 1, ledger: null, log: colored }).verdict).toBe('incomplete');
    expect(classifyVitestRun({ exitCode: 1, ledger: null, log: 'SyntaxError in vitest.config.ts' }).verdict).toBe(
      'fail',
    );
  });

  it('treats a malformed ledger like a missing one', () => {
    const result = classifyVitestRun({
      exitCode: 1,
      ledger: { version: 1, reason: 'passed', planned: 'all', modules: [], unhandledErrors: [] },
      log: '\u001b[2mError: Worker exited unexpectedly\u001b[22m',
    });
    expect(result.verdict).toBe('incomplete');
    expect(result.reasons[0]).toContain('malformed');
  });
});

describe('TEARDOWN_SIGNATURE', () => {
  it('matches the three signatures of issue #363', () => {
    expect(TEARDOWN_SIGNATURE.test('Caused by: Error: Worker exited unexpectedly')).toBe(true);
    expect(TEARDOWN_SIGNATURE.test('Tests closed successfully but something prevents Vite server from exiting')).toBe(
      true,
    );
    expect(TEARDOWN_SIGNATURE.test('close timed out after 30000ms')).toBe(true);
    expect(TEARDOWN_SIGNATURE.test('Tests  3 failed | 12 passed')).toBe(false);
  });
});

describe('parseRunLedger', () => {
  const valid = ledgerOf([PASSING], [WORKER_EXIT]);

  it('accepts a well-formed ledger', () => {
    expect(parseRunLedger(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it.each([
    ['another version', { ...valid, version: 2 }],
    ['no reason', { ...valid, reason: undefined }],
    ['a module without counts', { ...valid, modules: [{ project: 'main', moduleId: '/x', state: 'passed' }] }],
    ['a negative count', { ...valid, modules: [moduleEntry('/x', 'passed', { pending: -1 })] }],
    ['a fractional count', { ...valid, modules: [moduleEntry('/x', 'passed', { passed: 0.5 })] }],
    ['an error without causes', { ...valid, unhandledErrors: [{ ...WORKER_EXIT, causes: undefined }] }],
    ['a planned entry without a path', { ...valid, planned: [{ project: 'main' }] }],
    ['an array', [valid]],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseRunLedger(value)).toBeNull();
  });
});

describe('describeUnhandledError', () => {
  it('keeps type, name, message and the cause chain', () => {
    const error = Object.assign(
      new Error('[vitest-pool]: Worker forks emitted error.', {
        cause: new Error('Worker exited unexpectedly', { cause: 'SIGKILL' }),
      }),
      { type: 'Unhandled Error' },
    );
    expect(describeUnhandledError(error)).toEqual({
      type: 'Unhandled Error',
      name: 'Error',
      message: '[vitest-pool]: Worker forks emitted error.',
      causes: ['Worker exited unexpectedly', 'SIGKILL'],
    });
  });

  it('handles serialized errors, primitives and cyclic causes', () => {
    expect(describeUnhandledError({ message: 'from a worker', type: 'Unhandled Rejection' })).toEqual({
      type: 'Unhandled Rejection',
      name: '',
      message: 'from a worker',
      causes: [],
    });
    expect(describeUnhandledError('plain string').message).toBe('plain string');
    const cyclic: { message: string; cause?: unknown } = { message: 'loop' };
    cyclic.cause = cyclic;
    expect(describeUnhandledError(cyclic).causes.length).toBeLessThanOrEqual(8);
  });
});

describe('buildRunLedger', () => {
  function fakeModule(moduleId: string, state: string, testStates: string[]): LedgerModuleSource {
    return {
      moduleId,
      project: { name: 'main' },
      state: () => state,
      children: { allTests: () => testStates.map((testState) => ({ result: () => ({ state: testState }) })) },
    };
  }

  it('records planned files, file states, test counts and errors', () => {
    const ledger = buildRunLedger(
      [{ moduleId: '/repo/test/a.test.ts', project: { name: 'main' } }],
      [fakeModule('/repo/test/a.test.ts', 'pending', ['passed', 'skipped', 'failed', 'pending', 'pending'])],
      [new Error('boom')],
      'failed',
    );
    expect(ledger).toEqual({
      version: 1,
      reason: 'failed',
      planned: [{ project: 'main', moduleId: '/repo/test/a.test.ts' }],
      modules: [
        {
          project: 'main',
          moduleId: '/repo/test/a.test.ts',
          state: 'pending',
          tests: { passed: 1, skipped: 1, failed: 1, pending: 2 },
        },
      ],
      unhandledErrors: [{ type: '', name: 'Error', message: 'boom', causes: [] }],
    });
    expect(parseRunLedger(ledger)).toEqual(ledger);
  });
});

describe('RunLedgerReporter', () => {
  let dir: string;
  const saved = process.env[LEDGER_PATH_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-run-ledger-'));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[LEDGER_PATH_ENV];
    else process.env[LEDGER_PATH_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the ledger to the file IC_VITEST_LEDGER names, and nothing without it', () => {
    const reporter = new RunLedgerReporter();
    const spec = { moduleId: '/repo/test/a.test.ts', project: { name: 'main' } };
    const module = {
      ...spec,
      state: () => 'passed',
      children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] },
    };
    // The reporter only reads the fields LedgerSpecificationSource/LedgerModuleSource declare.
    const run = () => {
      reporter.onTestRunStart([spec] as unknown as Parameters<RunLedgerReporter['onTestRunStart']>[0]);
      reporter.onTestRunEnd([module] as unknown as Parameters<RunLedgerReporter['onTestRunEnd']>[0], [], 'passed');
    };

    delete process.env[LEDGER_PATH_ENV];
    run();
    expect(readdirSync(dir)).toEqual([]);

    const path = join(dir, 'ledger.json');
    process.env[LEDGER_PATH_ENV] = path;
    run();
    expect(readdirSync(dir)).toEqual(['ledger.json']);
    const ledger = parseRunLedger(JSON.parse(readFileSync(path, 'utf-8')));
    expect(ledger?.modules).toEqual([moduleEntry('/repo/test/a.test.ts', 'passed', { passed: 1 })]);
  });

  it('replaces the ledger file atomically', () => {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, 'stale');
    writeRunLedger(path, ledgerOf([PASSING], []));
    expect(readdirSync(dir)).toEqual(['ledger.json']);
    expect(parseRunLedger(JSON.parse(readFileSync(path, 'utf-8')))).not.toBeNull();
  });
});

describe('classify-vitest-run CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-run-classify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tsx = resolve(ROOT, 'node_modules/.bin/tsx');
  const script = resolve(ROOT, 'scripts/classify-vitest-run.ts');

  it('prints the verdict on stdout and the reasons on stderr', async () => {
    const ledgerPath = join(dir, 'ledger.json');
    const crashed = moduleEntry(join(ROOT, 'test/crash.test.ts'), 'pending', { pending: 3 });
    writeFileSync(ledgerPath, JSON.stringify(ledgerOf([PASSING, crashed], [WORKER_EXIT])));
    const { stdout, stderr } = await execFileAsync(tsx, [script, '--exit-code', '1', '--ledger', ledgerPath], {
      cwd: ROOT,
    });
    expect(stdout).toBe('incomplete\n');
    expect(stderr).toContain('classify-vitest-run: test/crash.test.ts [main]: file pending');
  });

  it('reads a missing ledger as no evidence and uses the log', async () => {
    const logPath = join(dir, 'run.log');
    writeFileSync(logPath, 'Caused by: Error: Worker exited unexpectedly\n');
    const args = [script, '--exit-code', '1', '--ledger', join(dir, 'missing.json')];
    expect((await execFileAsync(tsx, [...args, '--log', logPath], { cwd: ROOT })).stdout).toBe('incomplete\n');
    expect((await execFileAsync(tsx, args, { cwd: ROOT })).stdout).toBe('fail\n');
    expect(existsSync(join(dir, 'missing.json'))).toBe(false);
  });

  it('exits 2 on bad arguments', async () => {
    await expect(
      execFileAsync(tsx, [script, '--exit-code', 'one', '--ledger', 'x'], { cwd: ROOT }),
    ).rejects.toMatchObject({ code: 2 });
  });
});
