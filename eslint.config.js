import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettier,
  {
    ignores: [
      'dist/',
      'node_modules/',
      'packages/',
      'scripts/',
      // Packaged workflow helper scripts (Python/JS) run in-container, not in
      // the TS build — exclude them from the typescript-eslint project parser.
      'src/workflow/workflows/*/scripts/',
      // Test fixtures spawned as standalone subprocesses (.mjs) are not part of
      // the tsconfig.eslint project, so the typed parser cannot resolve them.
      'test/**/fixtures/**/*.mjs',
      'vitest.config.ts',
      'eslint.config.js',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  // Layering boundary: live-runtime modules must not statically VALUE-import
  // from src/pipeline (offline tooling). Type-only imports are allowed
  // (allowTypeImports), and value imports must go through the sanctioned
  // dynamic-import seam (compile-persona-policy.ts / compile-task-policy.ts).
  // Covers the tool-call mediation layers (session, sandbox, trusted-process,
  // docker, workflow, memory), the web UI, and every persona module except
  // its two sanctioned pipeline modules: the compile seam itself and
  // persona-customizer.ts (the customize-policy flow, which IS a pipeline
  // invocation). test/pipeline-import-boundary.test.ts checks the same scope
  // for transitive static reach and for dynamic imports, which this rule does
  // not see, and plants an import to prove this rule fires.
  {
    files: [
      'src/{session,sandbox,trusted-process,docker,workflow,memory}/**/*.ts',
      'src/web-ui/**/*.ts',
      'src/persona/**/*.ts',
    ],
    ignores: ['src/persona/compile-persona-policy.ts', 'src/persona/persona-customizer.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/pipeline/**'],
              allowTypeImports: true,
              message:
                'Live-runtime modules must not statically import VALUES from src/pipeline (offline tooling). Use `import type` for contracts, or reach pipeline code via the sanctioned dynamic-import seam (compile-persona-policy.ts / compile-task-policy.ts).',
            },
          ],
        },
      ],
    },
  },
  // Plain-ESM runtime shims under src/ (worker entry points, loader hooks).
  // They ship as .mjs because they must run without tsc, so they are outside
  // the tsconfig.eslint project — lint them with the untyped ruleset rather
  // than skipping them entirely.
  {
    files: ['src/**/*.mjs', 'docker/*.mjs', 'docker/signal-bridge/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { project: null, projectService: false },
    },
  },
  // Relaxed rules for test files — mocking patterns, deprecated API testing,
  // and vitest callbacks make strict unsafe-* rules too noisy.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
