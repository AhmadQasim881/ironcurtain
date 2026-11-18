/**
 * Read-only workspace confinement in the PolicyEngine (WP-131): an engine
 * built with `readOnlyWorkspace` denies, structurally and before sandbox
 * containment and the compiled rules, every write, delete or history rewrite
 * outside the workspace's writable directories. Reads are unaffected.
 *
 * Without the confinement, sandbox containment allows every change inside the
 * workspace whatever the persona's policy says, so a reviewer state running
 * the global policy could rewrite the code it reviews through the filesystem
 * or git MCP servers. The "control" engine in each group shows that baseline.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { gitDiscoveryCeiling } from '../src/trusted-process/git-backend-env.js';
import {
  PolicyEngine,
  READ_ONLY_WORKSPACE_DENY_RESULT,
  STRUCTURAL_READ_ONLY_WORKSPACE_RULE,
  TASK_SCOPE_ESCALATE_RULE,
  type PolicyEngineOptions,
} from '../src/trusted-process/policy-engine.js';
import type { TaskScopePolicy } from '../src/trusted-process/policy-types.js';
import { createReadOnlyWorkspace } from '../src/types/read-only-workspace.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import { REAL_TMP, TEST_PROTECTED_PATHS, testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';
import { scopeRule, taskScopePolicy } from './fixtures/task-scope.js';

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

let workspace: string;
let outside: string;

beforeAll(() => {
  workspace = mkdtempSync(join(REAL_TMP, 'ro-workspace-'));
  outside = mkdtempSync(join(REAL_TMP, 'ro-outside-'));
  mkdirSync(join(workspace, '.workflow', 'reviews'), { recursive: true });
  mkdirSync(join(workspace, '.workflow', 'spec'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(workspace, '.workflow', 'reviews', 'old.md'), 'old review\n');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function request(serverName: string, toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return { requestId: 'ro-test', serverName, toolName, arguments: args, timestamp: new Date().toISOString() };
}

function readOnlyEngine(
  writablePaths: readonly string[] = ['.workflow/reviews'],
  policy: CompiledPolicyFile = testCompiledPolicy,
): PolicyEngine {
  return new PolicyEngine(
    policy,
    testToolAnnotations,
    TEST_PROTECTED_PATHS,
    workspace,
    undefined,
    undefined,
    undefined,
    undefined,
    { readOnlyWorkspace: { writablePaths } },
  );
}

function readWriteEngine(): PolicyEngine {
  return new PolicyEngine(testCompiledPolicy, testToolAnnotations, TEST_PROTECTED_PATHS, workspace);
}

describe('PolicyEngine read-only workspace', () => {
  it('denies a write elsewhere in the workspace that sandbox containment allows without it', () => {
    const write = request('filesystem', 'write_file', { path: join(workspace, 'src', 'app.ts'), content: 'x' });

    // Control: the read-write workspace lets the agent rewrite the code.
    expect(readWriteEngine().evaluate(write).decision).toBe('allow');

    const result = readOnlyEngine().evaluate(write);
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    expect(result.reason).toBe(READ_ONLY_WORKSPACE_DENY_RESULT.reason);
  });

  it('allows writes inside a writable output directory, and creating the directory itself', () => {
    const engine = readOnlyEngine();
    const review = engine.evaluate(
      request('filesystem', 'write_file', { path: join(workspace, '.workflow', 'reviews', 'review.md'), content: 'x' }),
    );
    expect(review.decision).toBe('allow');
    expect(review.rule).toBe('structural-sandbox-allow');

    const nested = engine.evaluate(
      request('filesystem', 'write_file', {
        path: join(workspace, '.workflow', 'reviews', 'new', 'deep', 'notes.md'),
        content: 'x',
      }),
    );
    expect(nested.decision).toBe('allow');

    const mkdir = engine.evaluate(
      request('filesystem', 'create_directory', { path: join(workspace, '.workflow', 'reviews') }),
    );
    expect(mkdir.decision).toBe('allow');
  });

  it('keeps reads of the whole workspace allowed', () => {
    const engine = readOnlyEngine();
    expect(
      engine.evaluate(request('filesystem', 'read_file', { path: join(workspace, 'src', 'app.ts') })).decision,
    ).toBe('allow');
    expect(engine.evaluate(request('filesystem', 'list_directory', { path: workspace })).decision).toBe('allow');
    expect(engine.evaluate(request('git', 'git_status', { path: workspace })).decision).toBe('allow');
  });

  it('denies the other output directories and another state’s artifacts', () => {
    const result = readOnlyEngine().evaluate(
      request('filesystem', 'write_file', { path: join(workspace, '.workflow', 'spec', 'spec.md'), content: 'x' }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
  });

  it('denies a write outside the workspace instead of escalating it to a human', () => {
    const write = request('filesystem', 'write_file', { path: join(outside, 'x.txt'), content: 'x' });
    // Control: the compiled policy escalates writes outside the sandbox.
    expect(readWriteEngine().evaluate(write).decision).toBe('escalate');

    const result = readOnlyEngine().evaluate(write);
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
  });

  it('wins over a compiled rule that allows the write', () => {
    const permissive: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [
        {
          name: 'allow-all-filesystem',
          description: 'test',
          principle: 'test',
          if: { server: ['filesystem'] },
          then: 'allow',
          reason: 'test',
        },
        ...testCompiledPolicy.rules,
      ],
    };
    const write = request('filesystem', 'write_file', { path: join(outside, 'x.txt'), content: 'x' });
    expect(
      new PolicyEngine(permissive, testToolAnnotations, TEST_PROTECTED_PATHS, workspace).evaluate(write).decision,
    ).toBe('allow');
    expect(readOnlyEngine(['.workflow/reviews'], permissive).evaluate(write).rule).toBe(
      STRUCTURAL_READ_ONLY_WORKSPACE_RULE,
    );
  });

  it('denies edits, moves out of or into the output directory, and deletes outside it', () => {
    const engine = readOnlyEngine();
    const reviews = join(workspace, '.workflow', 'reviews');

    expect(
      engine.evaluate(request('filesystem', 'edit_file', { path: join(workspace, 'src', 'app.ts'), edits: [] })).rule,
    ).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    // Out of the output directory: the destination is written outside it.
    expect(
      engine.evaluate(
        request('filesystem', 'move_file', {
          source: join(reviews, 'old.md'),
          destination: join(workspace, 'src', 'x'),
        }),
      ).rule,
    ).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    // Into it: the source (delete-path) is outside it.
    expect(
      engine.evaluate(
        request('filesystem', 'move_file', {
          source: join(workspace, 'src', 'app.ts'),
          destination: join(reviews, 'a'),
        }),
      ).rule,
    ).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    // Within it: allowed.
    expect(
      engine.evaluate(
        request('filesystem', 'move_file', { source: join(reviews, 'old.md'), destination: join(reviews, 'older.md') }),
      ).decision,
    ).toBe('allow');
  });

  it('denies git operations that change the repository', () => {
    const engine = readOnlyEngine();
    for (const [toolName, args] of [
      ['git_add', { path: workspace, files: ['src/app.ts'] }],
      ['git_commit', { path: workspace, message: 'msg' }],
      ['git_reset', { path: workspace, mode: 'hard' }],
    ] as const) {
      const result = engine.evaluate(request('git', toolName, args));
      expect(result.decision, toolName).toBe('deny');
      expect(result.rule, toolName).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    }
  });

  it('denies git changes whose path lies inside a writable output directory', () => {
    // git acts on the repository that contains its path, not on the path:
    // "committing in .workflow/reviews" commits the workspace repository.
    const reviews = join(workspace, '.workflow', 'reviews');
    const calls = [
      ['git_add', { path: reviews, files: ['../../src/app.ts'] }],
      ['git_commit', { path: reviews, message: 'msg' }],
      ['git_reset', { path: reviews, mode: 'hard' }],
      ['git_branch', { path: reviews, name: 'x' }],
    ] as const;
    for (const [toolName, args] of calls) {
      // Control: without the confinement the path is inside the sandbox.
      expect(readWriteEngine().evaluate(request('git', toolName, args)).decision, toolName).not.toBe('deny');
      const result = readOnlyEngine().evaluate(request('git', toolName, args));
      expect(result.decision, toolName).toBe('deny');
      expect(result.rule, toolName).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    }
  });

  it('keeps git reads allowed, also from a writable output directory', () => {
    const engine = readOnlyEngine();
    for (const path of [workspace, join(workspace, '.workflow', 'reviews')]) {
      for (const toolName of ['git_status', 'git_log', 'git_diff']) {
        expect(engine.evaluate(request('git', toolName, { path })).decision, `${toolName} ${path}`).toBe('allow');
      }
    }
  });

  it('denies a path that leaves the output directory through .. or a symlink', () => {
    const engine = readOnlyEngine();
    const reviews = join(workspace, '.workflow', 'reviews');
    expect(
      engine.evaluate(
        request('filesystem', 'write_file', { path: join(reviews, '..', '..', 'src', 'x.ts'), content: 'x' }),
      ).rule,
    ).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);

    const link = join(reviews, 'to-src');
    symlinkSync(join(workspace, 'src'), link);
    try {
      expect(
        engine.evaluate(request('filesystem', 'write_file', { path: join(link, 'app.ts'), content: 'x' })).rule,
      ).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    } finally {
      rmSync(link);
    }
  });

  it('refuses writes through a writable directory that is itself a symlink out of place', () => {
    // An earlier read-write state left `.workflow/notes -> ../src`: writing
    // "into the output directory" would rewrite the code.
    symlinkSync(join(workspace, 'src'), join(workspace, '.workflow', 'notes'));
    try {
      const engine = readOnlyEngine(['.workflow/notes']);
      const result = engine.evaluate(
        request('filesystem', 'write_file', { path: join(workspace, '.workflow', 'notes', 'app.ts'), content: 'x' }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    } finally {
      rmSync(join(workspace, '.workflow', 'notes'));
    }
  });

  it('ignores writable paths that are not plain relative paths', () => {
    const engine = readOnlyEngine(['..', '/', '', '.workflow/../src', './src']);
    for (const path of [join(workspace, 'src', 'app.ts'), join(outside, 'x'), join(workspace, 'x')]) {
      expect(engine.evaluate(request('filesystem', 'write_file', { path, content: 'x' })).rule, path).toBe(
        STRUCTURAL_READ_ONLY_WORKSPACE_RULE,
      );
    }
  });

  it('makes nothing writable without an allowed directory', () => {
    const engine = new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      TEST_PROTECTED_PATHS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { readOnlyWorkspace: { writablePaths: ['.workflow/reviews'] } },
    );
    const result = engine.evaluate(
      request('filesystem', 'write_file', { path: join(workspace, '.workflow', 'reviews', 'r.md'), content: 'x' }),
    );
    expect(result.rule).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
  });

  it('leaves tools without path roles to the compiled policy', () => {
    const engine = readOnlyEngine();
    expect(engine.evaluate(request('fetch', 'http_fetch', { url: 'https://example.com/' })).decision).toBe('allow');
    expect(engine.evaluate(request('github', 'create_issue', { owner: 'o', repo: 'r', title: 't' })).decision).toBe(
      'escalate',
    );
  });

  it('applies together with a task scope: the scope cannot allow a change, and still narrows the rest', () => {
    // A workflow run started with --task-scoped (WP-119) gives its read-only
    // bundle both: the engine takes the task scope and the read-only
    // workspace side by side, and neither replaces the other.
    const permissive: CompiledPolicyFile = {
      ...testCompiledPolicy,
      rules: [
        {
          name: 'allow-all-filesystem',
          description: 'test',
          principle: 'test',
          if: { server: ['filesystem'] },
          then: 'allow',
          reason: 'test',
        },
      ],
    };
    const scope: TaskScopePolicy = {
      compiledPolicy: taskScopePolicy('Write the report next to the workspace.', [
        scopeRule('scope-write-outside', 'filesystem', { paths: { roles: ['write-path'], within: outside } }),
      ]),
    };
    const build = (options: PolicyEngineOptions): PolicyEngine =>
      new PolicyEngine(
        permissive,
        testToolAnnotations,
        TEST_PROTECTED_PATHS,
        workspace,
        undefined,
        undefined,
        undefined,
        scope,
        options,
      );
    const writeOutside = request('filesystem', 'write_file', { path: join(outside, 'report.md'), content: 'x' });
    const readOutside = request('filesystem', 'read_file', { path: join(outside, 'notes.md') });

    // Control: under the task scope alone the write is in scope and allowed.
    const scopedOnly = build({});
    expect(scopedOnly.hasTaskScope()).toBe(true);
    expect(scopedOnly.evaluate(writeOutside).decision).toBe('allow');

    const engine = build({ readOnlyWorkspace: createReadOnlyWorkspace(['.workflow/reviews']) });
    expect(engine.hasTaskScope()).toBe(true);
    expect(engine.evaluate(writeOutside)).toMatchObject({
      decision: 'deny',
      rule: STRUCTURAL_READ_ONLY_WORKSPACE_RULE,
    });
    expect(
      engine.evaluate(request('filesystem', 'write_file', { path: join(workspace, 'src', 'app.ts'), content: 'x' })),
    ).toMatchObject({ decision: 'deny', rule: STRUCTURAL_READ_ONLY_WORKSPACE_RULE });
    // The output directory stays writable (sandbox-resolved, in every scope) ...
    expect(
      engine.evaluate(
        request('filesystem', 'write_file', { path: join(workspace, '.workflow', 'reviews', 'r.md'), content: 'x' }),
      ).decision,
    ).toBe('allow');
    // ... and the task scope still narrows what the read-only rule leaves open.
    expect(engine.evaluate(readOutside)).toMatchObject({ decision: 'escalate', rule: TASK_SCOPE_ESCALATE_RULE });
  });
});

// ---------------------------------------------------------------------------
// Acceptance: the shipped compiled policy and annotations on a real repository
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable)('read-only workspace with the shipped policy on a git workspace', () => {
  const configDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config');
  const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(configDir, path), 'utf-8'));
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@test.local',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@test.local',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  let repo: string;
  let reviews: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
  }

  function shippedEngine(readOnly: boolean): PolicyEngine {
    return new PolicyEngine(
      readJson('generated/compiled-policy.json') as CompiledPolicyFile,
      readJson('generated/tool-annotations.json') as StoredToolAnnotationsFile,
      [],
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      readOnly ? { readOnlyWorkspace: createReadOnlyWorkspace(['.workflow/reviews']) } : {},
    );
  }

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(REAL_TMP, 'ro-git-workspace-')));
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.ts'), 'export {};\n');
    git(repo, 'add', 'app.ts');
    git(repo, 'commit', '-q', '-m', 'init');
    reviews = join(repo, '.workflow', 'reviews');
    mkdirSync(reviews, { recursive: true });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('runs git from a writable output directory on the workspace repository itself', () => {
    // The premise of the rule: the git backend's discovery ceiling is the
    // workspace's parent, so git started in an output directory finds and
    // changes the workspace's own repository.
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: reviews,
      encoding: 'utf-8',
      env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: gitDiscoveryCeiling(repo) },
    }).trim();
    expect(realpathSync(topLevel)).toBe(repo);
  });

  it('denies every git change, wherever its path points', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['git_reset', { path: reviews, mode: 'hard', target: 'HEAD' }],
      ['git_checkout', { path: reviews, target: 'main', paths: ['../../app.ts'] }],
      ['git_stash', { path: reviews, mode: 'push' }],
      ['git_add', { path: reviews, all: true }],
      ['git_commit', { path: reviews, message: 'reviewer commit' }],
      ['git_branch', { path: reviews, mode: 'create', branchName: 'reviewer' }],
      ['git_tag', { path: reviews, mode: 'create', tagName: 'v-reviewer' }],
      ['git_clean', { path: reviews, force: true }],
      ['git_worktree', { path: repo, mode: 'add', worktreePath: join(reviews, 'wt'), branch: 'wt' }],
      ['git_init', { path: join(reviews, 'nested') }],
      ['git_set_working_dir', { path: reviews, initializeIfNotPresent: true }],
      ['git_reset', { path: repo, mode: 'hard' }],
    ];
    const control = shippedEngine(false);
    const engine = shippedEngine(true);
    // Control: under the shipped policy a history rewrite inside the sandbox
    // is allowed, from an output directory too.
    expect(control.evaluate(request('git', 'git_reset', { path: reviews, mode: 'hard' })).decision).toBe('allow');
    for (const [toolName, args] of calls) {
      const result = engine.evaluate(request('git', toolName, args));
      expect(result.decision, toolName).toBe('deny');
      expect(result.rule, toolName).toBe(STRUCTURAL_READ_ONLY_WORKSPACE_RULE);
    }
  });

  it('keeps git reads allowed', () => {
    const engine = shippedEngine(true);
    const reads: Array<[string, Record<string, unknown>]> = [
      ['git_status', { path: repo }],
      ['git_log', { path: reviews }],
      ['git_diff', { path: repo }],
      ['git_show', { path: repo, object: 'HEAD' }],
      ['git_branch', { path: repo, mode: 'list' }],
      ['git_stash', { path: repo, mode: 'list' }],
      ['git_set_working_dir', { path: repo }],
    ];
    for (const [toolName, args] of reads) {
      expect(engine.evaluate(request('git', toolName, args)).decision, toolName).toBe('allow');
    }
    // The filesystem tools still write the output directory.
    expect(
      engine.evaluate(request('filesystem', 'write_file', { path: join(reviews, 'review.md'), content: 'x' })).decision,
    ).toBe('allow');
  });
});

describe('createReadOnlyWorkspace', () => {
  it('keeps plain relative paths, in order, once', () => {
    expect(createReadOnlyWorkspace(['.workflow/a', '.workflow/b/c', '.workflow/a']).writablePaths).toEqual([
      '.workflow/a',
      '.workflow/b/c',
    ]);
  });

  it.each(['', '/abs', '../x', 'a/../b', 'a//b', './a', 'a/', 'a\\b', 'a\0b'])('throws on %j', (path) => {
    expect(() => createReadOnlyWorkspace([path])).toThrow(/not a plain relative path/);
  });
});
