/**
 * Classifies one run of the root vitest suite for scripts/test.sh (BLD-3).
 *
 *   pass        vitest exited 0.
 *   fail        a real failure, never retried: a failed test or file, an
 *               unhandled error other than a worker exit, an interrupted run,
 *               or a non-zero exit that no worker death explains.
 *   flake       the teardown flake (issue #363): vitest failed only because
 *               forked workers exited unexpectedly, and the run ledger proves
 *               that every planned file and test reached a final state and
 *               none failed.
 *   incomplete  a worker died and some planned file or test has no final
 *               result (a crash mid-file or while importing), or there is no
 *               ledger to prove otherwise.
 *
 * test.sh retries `flake` and `incomplete` runs. It accepts a final-attempt
 * `flake`, but fails a final-attempt `incomplete` run: tests that never ran
 * cannot be reported as passing. Where the teardown signature appears in the
 * log does not matter; vitest prints the worker-exit error before the summary.
 *
 * CLI: tsx scripts/classify-vitest-run.ts --exit-code <n> --ledger <path> [--log <path>]
 * prints the verdict on stdout and the reasons on stderr.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEDGER_VERSION } from './vitest-run-ledger.js';
import type { LedgerError, LedgerFile, LedgerModule, RunLedger } from './vitest-run-ledger.js';

export type RunVerdict = 'pass' | 'fail' | 'flake' | 'incomplete';

export interface RunClassification {
  verdict: RunVerdict;
  reasons: string[];
}

export interface RunEvidence {
  exitCode: number;
  /** Parsed ledger JSON (validated here), or null when no ledger was written. */
  ledger: unknown;
  /** Combined vitest output; consulted only when there is no usable ledger. */
  log: string;
  /** Directory that file paths in the reasons are shown relative to. */
  root?: string;
}

/** Teardown signatures from issue #363, used only when the ledger is missing. */
export const TEARDOWN_SIGNATURE =
  /Worker exited unexpectedly|prevents Vite server from exiting|close timed out after \d+ms/;

const WORKER_EXIT_MESSAGE = 'Worker exited unexpectedly';
const POOL_WORKER_ERROR = /^\[vitest-pool\]: Worker \S+ emitted error\.$/;
const MAIN_PROCESS_ERROR_TYPE = 'Unhandled Error';
/** How many offending files or errors a reason lists before summarizing the rest. */
const MAX_LISTED = 10;
const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, 'g');

/**
 * True for the error vitest's main process records when a forked worker exits
 * while it still owns a test file: `[vitest-pool]: Worker forks emitted error.`
 * caused by `Worker exited unexpectedly`. Errors reported from inside a worker
 * (an uncaught exception or unhandled rejection in test code) carry another
 * type, so a test cannot fake this by throwing the same message.
 */
export function isWorkerExitError(error: LedgerError): boolean {
  if (error.type !== MAIN_PROCESS_ERROR_TYPE) return false;
  if (error.message === WORKER_EXIT_MESSAGE) return true;
  return POOL_WORKER_ERROR.test(error.message) && error.causes[0] === WORKER_EXIT_MESSAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLedgerFile(value: unknown): value is LedgerFile {
  return isRecord(value) && typeof value.project === 'string' && typeof value.moduleId === 'string';
}

function isLedgerModule(value: unknown): value is LedgerModule {
  if (!isRecord(value)) return false;
  const { state, tests } = value;
  return (
    isLedgerFile(value) &&
    typeof state === 'string' &&
    isRecord(tests) &&
    isCount(tests.passed) &&
    isCount(tests.failed) &&
    isCount(tests.skipped) &&
    isCount(tests.pending)
  );
}

function isLedgerError(value: unknown): value is LedgerError {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    isStringArray(value.causes)
  );
}

/** Validates ledger JSON; anything unexpected yields null, which never proves completeness. */
export function parseRunLedger(value: unknown): RunLedger | null {
  if (!isRecord(value) || value.version !== LEDGER_VERSION || typeof value.reason !== 'string') return null;
  const { planned, modules, unhandledErrors } = value;
  if (!Array.isArray(planned) || !planned.every(isLedgerFile)) return null;
  if (!Array.isArray(modules) || !modules.every(isLedgerModule)) return null;
  if (!Array.isArray(unhandledErrors) || !unhandledErrors.every(isLedgerError)) return null;
  return { version: LEDGER_VERSION, reason: value.reason, planned, modules, unhandledErrors };
}

function fileKey(file: LedgerFile): string {
  return `${file.project}\u0000${file.moduleId}`;
}

function label(file: LedgerFile, root: string | undefined): string {
  const rel = root === undefined ? file.moduleId : relative(root, file.moduleId);
  const path = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file.moduleId : rel;
  return file.project ? `${path} [${file.project}]` : path;
}

function listed(items: string[]): string[] {
  if (items.length <= MAX_LISTED) return items;
  return [...items.slice(0, MAX_LISTED), `... and ${items.length - MAX_LISTED} more`];
}

function describeError(error: LedgerError): string {
  const head = `${error.type || 'error'}: ${error.message}`;
  return error.causes.length > 0 ? `${head} (caused by: ${error.causes.join(' <- ')})` : head;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Files and tests that have no final result, as human-readable lines. */
function missingResults(ledger: RunLedger, root: string | undefined): string[] {
  const reported = new Set(ledger.modules.map(fileKey));
  const missing: string[] = [];
  for (const file of ledger.planned) {
    if (!reported.has(fileKey(file))) missing.push(`${label(file, root)}: no result (the file never started)`);
  }
  for (const module of ledger.modules) {
    const finished = module.state === 'passed' || module.state === 'skipped';
    if (finished && module.tests.pending === 0) continue;
    const { passed, skipped, pending } = module.tests;
    const tests =
      passed + skipped + pending === 0
        ? 'no test was collected'
        : `tests ${passed} passed, ${skipped} skipped, ${pending} without a result`;
    missing.push(`${label(module, root)}: file ${module.state}, ${tests}`);
  }
  return missing;
}

export function classifyVitestRun(evidence: RunEvidence): RunClassification {
  if (evidence.exitCode === 0) return { verdict: 'pass', reasons: [] };

  const exit = `vitest exited ${evidence.exitCode}`;
  const ledger = parseRunLedger(evidence.ledger);
  if (ledger === null) {
    const why = evidence.ledger === null ? 'no run ledger was written' : 'the run ledger is malformed';
    if (TEARDOWN_SIGNATURE.test(stripAnsi(evidence.log))) {
      return {
        verdict: 'incomplete',
        reasons: [`${exit} with a worker-death signature, but ${why}, so no test result can be trusted`],
      };
    }
    return { verdict: 'fail', reasons: [`${exit} and ${why}; there is no worker-death signature either`] };
  }

  const failedFiles = ledger.modules.filter((module) => module.state === 'failed');
  const failedTests = ledger.modules.reduce((sum, module) => sum + module.tests.failed, 0);
  if (failedFiles.length > 0 || failedTests > 0) {
    return {
      verdict: 'fail',
      reasons: [
        `${failedTests} test(s) failed; ${failedFiles.length} test file(s) failed`,
        ...listed(failedFiles.map((file) => label(file, evidence.root))),
      ],
    };
  }
  if (ledger.reason === 'interrupted') {
    return { verdict: 'fail', reasons: [`${exit}: the run was interrupted`] };
  }

  const otherErrors = ledger.unhandledErrors.filter((error) => !isWorkerExitError(error));
  if (otherErrors.length > 0) {
    return {
      verdict: 'fail',
      reasons: [
        `${exit} with ${otherErrors.length} unhandled error(s) that are not worker exits`,
        ...listed(otherErrors.map(describeError)),
      ],
    };
  }
  const workerExits = ledger.unhandledErrors.length;
  if (workerExits === 0) {
    return {
      verdict: 'fail',
      reasons: [`${exit}, but no test failed and no worker exit was recorded; this is not the teardown flake`],
    };
  }

  const missing =
    ledger.planned.length === 0 ? ['the ledger lists no planned test files'] : missingResults(ledger, evidence.root);
  if (missing.length > 0) {
    return {
      verdict: 'incomplete',
      reasons: [
        `${workerExits} worker(s) exited unexpectedly and ${missing.length} test file(s) lack final results`,
        ...listed(missing),
      ],
    };
  }
  const tests = ledger.modules.reduce((sum, module) => sum + module.tests.passed + module.tests.skipped, 0);
  return {
    verdict: 'flake',
    reasons: [
      `${workerExits} worker(s) exited unexpectedly after every one of the ${ledger.planned.length} planned test files ` +
        `and ${tests} tests finished, with no failures`,
    ],
  };
}

function readLedgerFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    // Unparseable JSON: hand parseRunLedger a value it rejects as malformed.
    return { malformed: true };
  }
}

interface CliArgs {
  exitCode: number;
  ledgerPath: string;
  logPath: string | undefined;
}

function parseCliArgs(argv: string[]): CliArgs | string {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--exit-code', '--ledger', '--log'].includes(flag) || value === undefined)
      return `unexpected argument ${flag}`;
    values.set(flag, value);
  }
  const exitCode = Number(values.get('--exit-code'));
  const ledgerPath = values.get('--ledger');
  if (!Number.isInteger(exitCode) || exitCode < 0) return '--exit-code must be a non-negative integer';
  if (ledgerPath === undefined) return '--ledger is required';
  return { exitCode, ledgerPath, logPath: values.get('--log') };
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv);
  if (typeof args === 'string') {
    process.stderr.write(`classify-vitest-run: ${args}\n`);
    return 2;
  }
  const log = args.logPath !== undefined && existsSync(args.logPath) ? readFileSync(args.logPath, 'utf-8') : '';
  const result = classifyVitestRun({
    exitCode: args.exitCode,
    ledger: readLedgerFile(args.ledgerPath),
    log,
    root: process.cwd(),
  });
  for (const reason of result.reasons) process.stderr.write(`classify-vitest-run: ${reason}\n`);
  process.stdout.write(`${result.verdict}\n`);
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
