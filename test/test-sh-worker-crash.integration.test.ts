/**
 * End-to-end check of scripts/test.sh's worker-death handling (BLD-3).
 *
 * scripts/test.sh retries the root suite when a vitest worker dies, because
 * of the macOS teardown flake (issue #363). It used to accept a worker death
 * as that flake whenever no test was reported as failed, so a worker that
 * crashed mid-file on every run passed CI: the tests after the crash point
 * never ran, and vitest does not count them as failed.
 *
 * Here test.sh runs unmodified against the real vitest. Shims for `npx` and
 * `npm` on PATH point `npx vitest` at a small fixture project
 * (test/fixtures/vitest-run-ledger, copied to a temporary root) and stand in
 * for the web-ui suite. The fixture reproduces each shape:
 *
 * - mid-file-crash: a test SIGKILLs its own worker, as a native crash would;
 * - teardown-crash: the genuine flake. Every test passes and the worker dies
 *   right after its file's final result arrives (a main-process reporter
 *   kills it), which yields exactly the "Worker exited unexpectedly" error
 *   seen on CI with "Test Files 2 passed (2)".
 */

import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyVitestRun } from '../scripts/classify-vitest-run.js';
import { LEDGER_PATH_ENV } from '../scripts/vitest-run-ledger.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_SOURCE = join(ROOT, 'test/fixtures/vitest-run-ledger');
const TIMEOUT_MS = 240_000;

/**
 * `npx vitest ...` runs the repository's vitest on the fixture project, with
 * the default reporter when the caller names none and with the reporter that
 * reproduces the teardown flake. Other tools run from node_modules/.bin after
 * a line on stdout, as a wrapper such as safe-chain's npx shim may print one;
 * test.sh must not read that line as the classifier's verdict.
 */
const NPX_SHIM = `#!/bin/sh
tool=$1
shift
if [ "$tool" = vitest ]; then
  named=no
  for arg in "$@"; do
    case "$arg" in --reporter*) named=yes ;; esac
  done
  if [ "$named" = no ]; then set -- "$@" --reporter=default; fi
  exec "$IC_SHIM_REPO/node_modules/.bin/vitest" "$@" --root "$IC_SHIM_FIXTURE" \\
    --config "$IC_SHIM_FIXTURE/vitest.config.mjs" --reporter="$IC_SHIM_FIXTURE/kill-worker-after-file.mjs"
fi
echo "IC-SHIM npx wrapper: checked $tool"
exec "$IC_SHIM_REPO/node_modules/.bin/$tool" "$@"
`;

/** Stands in for `npm test -w packages/web-ui`, the step test.sh runs after the root suite. */
const NPM_SHIM = `#!/bin/sh
echo "IC-SHIM npm $*"
`;

interface RunResult {
  code: number;
  output: string;
}

// eslint-disable-next-line no-control-regex -- strips the colour codes vitest writes
const ANSI = /\u001b\[[0-9;]*m/g;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { cwd: ROOT, env, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolvePromise({ code, output: `${stdout}\n${stderr}`.replace(ANSI, '') });
      },
    );
  });
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('scripts/test.sh worker-death handling', () => {
  let work: string;
  let fixture: string;
  let env: (scenario: string) => NodeJS.ProcessEnv;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'ic-test-sh-'));
    fixture = join(work, 'fixture');
    cpSync(FIXTURE_SOURCE, fixture, { recursive: true });
    const bin = join(work, 'bin');
    mkdirSync(bin);
    mkdirSync(join(work, 'home'));
    mkdirSync(join(work, 'tmp'));
    writeFileSync(join(bin, 'npx'), NPX_SHIM);
    writeFileSync(join(bin, 'npm'), NPM_SHIM);
    chmodSync(join(bin, 'npx'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    // A minimal environment: no CI or agent variables (they change vitest's
    // reporters) and nothing from the vitest run executing this test.
    env = (scenario) => ({
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: join(work, 'home'),
      TMPDIR: join(work, 'tmp'),
      IC_SHIM_REPO: ROOT,
      IC_SHIM_FIXTURE: fixture,
      IC_LEDGER_FIXTURE_SCENARIO: scenario,
    });
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const testSh = (scenario: string) => run('bash', [join(ROOT, 'scripts/test.sh')], env(scenario));

  it(
    'fails a worker crash mid-file on every attempt, though no test failed (BLD-3)',
    async () => {
      const { code, output } = await testSh('mid-file-crash');
      // vitest itself reports no failed test: only the file count shows the gap.
      expect(output).toMatch(/Test Files\s+1 passed \(2\)/);
      expect(output).not.toMatch(/\d+ failed/);
      expect(code).toBe(1);
      expect(count(output, 'vitest worker died on attempt')).toBe(2);
      expect(output).toContain('::error::vitest worker died and test results are missing on the final attempt (3/3)');
      expect(output).toContain('mid-file-crash.spec.mjs: file pending');
      expect(output).not.toContain('treating as success');
      expect(output).not.toContain('IC-SHIM npm');
    },
    TIMEOUT_MS,
  );

  it(
    'still passes the genuine teardown flake, after retrying it',
    async () => {
      const { code, output } = await testSh('teardown-crash');
      expect(output).toContain('Worker exited unexpectedly');
      expect(output).toMatch(/Test Files\s+2 passed \(2\)/);
      expect(code).toBe(0);
      expect(count(output, 'vitest teardown flake on attempt')).toBe(2);
      expect(output).toContain('::warning::vitest teardown flake persisted across 3 attempts');
      expect(output).toContain('IC-SHIM npm test -w packages/web-ui');
    },
    TIMEOUT_MS,
  );

  it(
    'fails a real test failure at once, without retrying',
    async () => {
      const { code, output } = await testSh('test-failure');
      expect(code).toBe(1);
      expect(output).toContain('1 test(s) failed');
      expect(output).not.toContain('retrying');
      expect(output).not.toContain('IC-SHIM npm');
    },
    TIMEOUT_MS,
  );

  it(
    'runs the web-ui suite after a clean root suite',
    async () => {
      const { code, output } = await testSh('clean');
      expect(code).toBe(0);
      expect(output).not.toContain('::warning::');
      expect(output).toContain('IC-SHIM npm test -w packages/web-ui');
    },
    TIMEOUT_MS,
  );

  // Shapes test.sh would retry three times; check the ledger and verdict of a
  // single real run instead.
  it.each([
    ['import-crash', 'incomplete', 'import-crash.spec.mjs: file pending, no test was collected'],
    ['unhandled-rejection', 'fail', 'Unhandled Rejection: rejected and never handled'],
  ])(
    'classifies a real %s run as %s',
    async (scenario, verdict, reason) => {
      const ledgerPath = join(work, `${scenario}.ledger.json`);
      const reporters = ['--reporter=default', '--reporter=./scripts/vitest-run-ledger.ts'];
      const { code, output } = await run(join(work, 'bin/npx'), ['vitest', 'run', ...reporters], {
        ...env(scenario),
        [LEDGER_PATH_ENV]: ledgerPath,
      });
      expect(code).toBe(1);
      expect(output).not.toMatch(/\d+ failed/);
      const result = classifyVitestRun({
        exitCode: code,
        ledger: JSON.parse(readFileSync(ledgerPath, 'utf-8')) as unknown,
        log: output,
        root: fixture,
      });
      expect(result.verdict).toBe(verdict);
      expect(result.reasons.join('\n')).toContain(reason);
    },
    TIMEOUT_MS,
  );
});
