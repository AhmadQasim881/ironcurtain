/**
 * Vitest reporter that writes a "run ledger" for scripts/test.sh: every test
 * file vitest planned to run, the final state of every file and test it
 * reported, and every unhandled error, as JSON.
 *
 * scripts/test.sh retries the root suite when a forked worker dies (the macOS
 * teardown flake, issue #363). A worker that dies mid-file also kills the
 * tests after the crash point, and vitest neither counts those as failed nor
 * prints "N failed" (BLD-3). The ledger is the evidence
 * scripts/classify-vitest-run.ts uses to tell the two apart: a run is the
 * benign flake only if every planned file and test reached a final state.
 * The reporter API exposes what the built-in JSON reporter does not: the
 * planned file list (a file whose worker died before it was queued is missing
 * from the JSON report), the real per-file state (the JSON report marks an
 * unfinished file "passed"), and the unhandled errors (the JSON report has
 * none, so a test-code error next to a worker death would be invisible).
 *
 * Writes only when IC_VITEST_LEDGER names the output file; otherwise it does
 * nothing. test.sh enables it with `--reporter=./scripts/vitest-run-ledger.ts`.
 */

import { renameSync, writeFileSync } from 'node:fs';
import type { Reporter, SerializedError, TestModule, TestRunEndReason, TestSpecification } from 'vitest/node';

/** Environment variable naming the ledger file the reporter writes. */
export const LEDGER_PATH_ENV = 'IC_VITEST_LEDGER';

export const LEDGER_VERSION = 1;

export interface LedgerFile {
  /** Vitest project name (vitest.config.ts defines `isolated-vm` and `main`). */
  project: string;
  /** Absolute path of the test file. */
  moduleId: string;
}

export interface LedgerTestCounts {
  passed: number;
  failed: number;
  skipped: number;
  /** Collected but never finished: running when the worker died, or never started. */
  pending: number;
}

export interface LedgerModule extends LedgerFile {
  /** `TestModule.state()`: queued, pending, passed, failed or skipped. */
  state: string;
  tests: LedgerTestCounts;
}

export interface LedgerError {
  /** Vitest's error category, for example "Unhandled Error" or "Unhandled Rejection". */
  type: string;
  name: string;
  message: string;
  /** Messages along the `cause` chain, direct cause first. */
  causes: string[];
}

export interface RunLedger {
  version: typeof LEDGER_VERSION;
  /** `onTestRunEnd` reason: passed, failed or interrupted. */
  reason: string;
  /** Every test file vitest was asked to run (`onTestRunStart`). */
  planned: LedgerFile[];
  /** Every test file vitest reported at the end of the run (`onTestRunEnd`). */
  modules: LedgerModule[];
  unhandledErrors: LedgerError[];
}

/** The parts of vitest's TestModule the ledger reads (TestModule satisfies it). */
export interface LedgerModuleSource {
  readonly moduleId: string;
  readonly project: { readonly name: string };
  state(): string;
  readonly children: { allTests(): Iterable<{ result(): { state: string } }> };
}

/** The parts of vitest's TestSpecification the ledger reads. */
export interface LedgerSpecificationSource {
  readonly moduleId: string;
  readonly project: { readonly name: string };
}

/** Bound on the cause chain we follow, in case an error object is cyclic. */
const MAX_CAUSES = 8;

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** Reduces an unhandled error (an Error, or a serialized one from a worker) to plain strings. */
export function describeUnhandledError(error: unknown): LedgerError {
  const causes: string[] = [];
  let cause: unknown = typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  while (cause !== undefined && cause !== null && causes.length < MAX_CAUSES) {
    causes.push(stringField(cause, 'message') ?? String(cause));
    cause = typeof cause === 'object' ? (cause as { cause?: unknown }).cause : undefined;
  }
  return {
    type: stringField(error, 'type') ?? '',
    name: stringField(error, 'name') ?? '',
    message: stringField(error, 'message') ?? String(error),
    causes,
  };
}

function countTests(module: LedgerModuleSource): LedgerTestCounts {
  const counts: LedgerTestCounts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const test of module.children.allTests()) {
    const state = test.result().state;
    if (state === 'passed' || state === 'failed' || state === 'skipped') counts[state] += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function buildRunLedger(
  planned: ReadonlyArray<LedgerSpecificationSource>,
  modules: ReadonlyArray<LedgerModuleSource>,
  unhandledErrors: ReadonlyArray<unknown>,
  reason: string,
): RunLedger {
  return {
    version: LEDGER_VERSION,
    reason,
    planned: planned.map((spec) => ({ project: spec.project.name, moduleId: spec.moduleId })),
    modules: modules.map((module) => ({
      project: module.project.name,
      moduleId: module.moduleId,
      state: module.state(),
      tests: countTests(module),
    })),
    unhandledErrors: unhandledErrors.map(describeUnhandledError),
  };
}

/** Writes via a temporary file and a rename, so a reader never sees a partial ledger. */
export function writeRunLedger(path: string, ledger: RunLedger): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export default class RunLedgerReporter implements Reporter {
  private planned: ReadonlyArray<TestSpecification> = [];

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.planned = [...specifications];
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const path = process.env[LEDGER_PATH_ENV];
    if (!path) return;
    writeRunLedger(path, buildRunLedger(this.planned, testModules, unhandledErrors, reason));
  }
}
