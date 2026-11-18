// Fixture project for test/vitest-run-ledger.integration.test.ts. The test
// copies this directory to a temporary root and runs the real vitest on it,
// through scripts/test.sh or directly. IC_LEDGER_FIXTURE_SCENARIO picks the
// files. No imports: the temporary root has no node_modules, so the cases use
// vitest globals.
const SCENARIOS = {
  clean: ['cases/passing.spec.mjs'],
  'test-failure': ['cases/passing.spec.mjs', 'cases/failing.spec.mjs'],
  'mid-file-crash': ['cases/passing.spec.mjs', 'cases/mid-file-crash.spec.mjs'],
  'import-crash': ['cases/passing.spec.mjs', 'cases/import-crash.spec.mjs'],
  'teardown-crash': ['cases/passing.spec.mjs', 'cases/teardown-crash.spec.mjs'],
  'unhandled-rejection': ['cases/passing.spec.mjs', 'cases/unhandled-rejection.spec.mjs'],
};

const scenario = process.env.IC_LEDGER_FIXTURE_SCENARIO ?? '';
const include = SCENARIOS[scenario];
if (include === undefined) throw new Error(`unknown IC_LEDGER_FIXTURE_SCENARIO: "${scenario}"`);

export default {
  cacheDir: '.vite-cache',
  test: {
    include,
    globals: true,
    pool: 'forks',
    cache: false,
    testTimeout: 30_000,
  },
};
