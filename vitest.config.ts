import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Test files that instantiate a V8 isolate (isolated-vm), i.e. every file
 * gated on `isIsolatedVmAvailable()`. Kept in sync by
 * test/isolated-vm-test-inventory.test.ts, which fails if a new one appears.
 *
 * These are serialized against each other. Measured on macOS CI (issue #363),
 * 120 attempts per condition:
 *
 *   4 of these files, in parallel  -> 15.8% of runs wedge a worker at teardown
 *   2 of these files, in parallel  ->  5.0%
 *   4 of these files, serialized   ->  0.8%
 *   any one of them, alone         ->  0.2%
 *
 * Two or more live isolates in separate forked children is the trigger; the
 * files are individually and sequentially fine (serialized vs alone: p = 0.36).
 * Serializing only these files removes the trigger while all the others keep
 * running in parallel.
 */
const ISOLATED_VM_TESTS = [
  'test/adversarial-e2e.integration.test.ts',
  'test/builtin-session-readiness.integration.test.ts',
  'test/code-mode-lanes.integration.test.ts',
  'test/docker-code-mode.integration.test.ts',
  'test/help-integration.test.ts',
  'test/sandbox-chain-cancellation.integration.test.ts',
  'test/sandbox-chain-limits.integration.test.ts',
  'test/sandbox-tool-errors.integration.test.ts',
  'test/workflow-policy-cycling.integration.test.ts',
  'test/workflow/workflow-commit-sandbox.integration.test.ts',
];

/** Options that must apply to every project (they are project-level in vitest). */
const shared = {
  testTimeout: 30_000,
  // Match CI's default pool explicitly so local and CI runs behave the same.
  pool: 'forks',
  teardownTimeout: 30_000,
} as const;

export default defineConfig({
  test: {
    // Measured only with `--coverage` (`npm run test:coverage`; CI runs it on
    // one leg). The thresholds apply to the whole suite: a targeted run of a
    // few files will fall below them.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      // The security kernel, the Code Mode bridge into it and the MITM proxy
      // must not quietly lose their tests, for example when the isolated-vm
      // suites start skipping. Each glob is summed over its files. Measured
      // 2026-11 (full suite, Linux, Node 24): trusted-process 87.2 / 85.1 /
      // 92.7 / 87.7, sandbox 85.2 / 60.6 / 87.5 / 86.8, mitm-proxy 83.9 /
      // 74.1 / 85.6 / 84.7 (statements / branches / functions / lines). The
      // floors sit a few points lower for runner differences (the bubblewrap
      // suites skip where bwrap is missing, and CI does not run as root);
      // raise them as coverage grows.
      thresholds: {
        'src/trusted-process/**': { statements: 84, branches: 81, functions: 89, lines: 84 },
        'src/sandbox/**': { statements: 80, branches: 55, functions: 81, lines: 82 },
        'src/docker/mitm-proxy.ts': { statements: 80, branches: 70, functions: 81, lines: 81 },
      },
    },
    projects: [
      {
        test: {
          ...shared,
          name: 'isolated-vm',
          include: ISOLATED_VM_TESTS,
          // The whole point: never two of these in flight at once.
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: 'main',
          include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
          exclude: [...defaultExclude, ...ISOLATED_VM_TESTS],
        },
      },
    ],
  },
});

export { ISOLATED_VM_TESTS };
