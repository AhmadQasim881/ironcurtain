import { afterEach, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import {
  checkServerRelevance,
  PREFILTER_DECISION_FILE,
  prefilterServers,
  type PrefilterCacheOptions,
} from '../src/pipeline/server-prefilter.js';
import { mergeServerResults } from '../src/pipeline/pipeline-runner.js';
import type { ToolAnnotation, CompiledRule } from '../src/pipeline/types.js';

/** Matches the unexported ServerCompilationResult shape from pipeline-runner. */
type ServerResult = Parameters<typeof mergeServerResults>[0][number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeV3Result(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [],
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  };
}

function createMockModel(responses: string[]): MockLanguageModelV3 {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (callIndex >= responses.length) {
        throw new Error(
          `MockLanguageModelV3 called ${callIndex + 1} times, but only ${responses.length} responses were provided.`,
        );
      }
      return makeV3Result(responses[callIndex++]);
    },
  });
}

function createFailingModel(error: Error): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });
}

const filesystemTools: ToolAnnotation[] = [
  { toolName: 'read_file', serverName: 'filesystem', comment: 'Read a file from the filesystem', args: {} },
  { toolName: 'write_file', serverName: 'filesystem', comment: 'Write content to a file', args: {} },
];

const githubTools: ToolAnnotation[] = [
  { toolName: 'search_issues', serverName: 'github', comment: 'Search GitHub issues', args: {} },
  { toolName: 'create_pr', serverName: 'github', comment: 'Create a pull request', args: {} },
];

const gitTools: ToolAnnotation[] = [
  { toolName: 'git_log', serverName: 'git', comment: 'Show commit history', args: {} },
  { toolName: 'git_branch', serverName: 'git', comment: 'List or create branches', args: {} },
];

// ---------------------------------------------------------------------------
// Unit tests: checkServerRelevance
// ---------------------------------------------------------------------------

describe('checkServerRelevance', () => {
  it('returns skip: true when the model says the server is irrelevant', async () => {
    const model = createMockModel([JSON.stringify({ skip: true, reason: 'No filesystem guidance found' })]);

    const result = await checkServerRelevance(
      'Only allow GitHub operations',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('No filesystem guidance found');
  });

  it('returns skip: false when the model says the server is relevant', async () => {
    const model = createMockModel([JSON.stringify({ skip: false, reason: 'Constitution mentions file reading' })]);

    const result = await checkServerRelevance(
      'Allow reading any text files in the workspace',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toBe('Constitution mentions file reading');
  });

  it('fails open (skip: false) when the model throws an error', async () => {
    const model = createFailingModel(new Error('API rate limit exceeded'));

    const result = await checkServerRelevance(
      'Allow reading files',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toContain('Pre-filter error');
    expect(result.reason).toContain('API rate limit exceeded');
  });

  it('fails open when model returns invalid JSON (schema validation fails)', async () => {
    // generateObjectWithRepair will try to repair once, then throw.
    // Both attempts return invalid JSON, so checkServerRelevance catches the error.
    const model = createMockModel(['not valid json at all', 'still not valid json']);

    const result = await checkServerRelevance(
      'Allow reading files',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toContain('Pre-filter error');
  });

  it('works with task-policy constitution kind', async () => {
    const model = createMockModel([JSON.stringify({ skip: true, reason: 'Task does not require GitHub' })]);

    const result = await checkServerRelevance(
      'Analyze CSV files in the data directory',
      'github',
      githubTools,
      model,
      'task-policy',
    );

    expect(result.skip).toBe(true);
    expect(result.serverName).toBe('github');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: prefilterServers
// ---------------------------------------------------------------------------

describe('prefilterServers', () => {
  it('short-circuits on empty text without calling the model', async () => {
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        return makeV3Result(JSON.stringify({ skip: false, reason: 'should not happen' }));
      },
    });

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('', servers, model, 'constitution');

    expect(modelCalled).toBe(false);
    expect(results).toHaveLength(2);
    expect(results.every((d) => d.skip)).toBe(true);

    // Also works with whitespace-only text
    const results2 = await prefilterServers('   \n  ', servers, model, 'constitution');
    expect(modelCalled).toBe(false);
    expect(results2).toHaveLength(2);
    expect(results2.every((d) => d.skip)).toBe(true);
  });

  it('calls the model for each server and returns decisions', async () => {
    const model = createMockModel([
      JSON.stringify({ skip: false, reason: 'Filesystem is relevant' }),
      JSON.stringify({ skip: true, reason: 'GitHub is not needed' }),
    ]);

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('Allow reading local files only', servers, model, 'constitution');

    expect(results).toHaveLength(2);

    const fsDecision = results.find((d) => d.serverName === 'filesystem');
    expect(fsDecision?.skip).toBe(false);

    const ghDecision = results.find((d) => d.serverName === 'github');
    expect(ghDecision?.skip).toBe(true);
  });

  it('handles a single server', async () => {
    const model = createMockModel([JSON.stringify({ skip: false, reason: 'Git is needed for branch operations' })]);

    const results = await prefilterServers('Allow listing branches', [['git', gitTools]], model, 'task-policy');

    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe('git');
    expect(results[0].skip).toBe(false);
  });

  it('runs all servers concurrently (returns results for all even if some fail)', async () => {
    // First call succeeds, second call fails (model only has one response)
    // The second call will throw, but checkServerRelevance catches it and fails open
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return makeV3Result(JSON.stringify({ skip: true, reason: 'Not needed' }));
        }
        throw new Error('Connection timeout');
      },
    });

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('Some task', servers, model, 'constitution');

    expect(results).toHaveLength(2);
    // One should have skip: true (succeeded), one should have skip: false (failed open)
    const succeeded = results.find((d) => d.skip);
    const failedOpen = results.find((d) => !d.skip);
    expect(succeeded).toBeDefined();
    expect(failedOpen).toBeDefined();
    expect(failedOpen!.reason).toContain('Pre-filter error');
  });
});

// ---------------------------------------------------------------------------
// WP-88 / PIP-15(b): cached pre-filter decisions
// ---------------------------------------------------------------------------

describe('prefilterServers decision cache', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function cacheIn(overrides: Partial<PrefilterCacheOptions> = {}): PrefilterCacheOptions {
    const outputDir = mkdtempSync(resolve(tmpdir(), 'ic-wp88-prefilter-'));
    dirs.push(outputDir);
    return { outputDir, modelId: 'test:haiku', ...overrides };
  }

  /** Answers per server from `answers` and counts the calls. */
  function answeringModel(answers: Record<string, { skip: boolean; reason: string } | Error>) {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls++;
        const system = JSON.stringify(options.prompt.filter((m) => m.role === 'system'));
        const server = Object.keys(answers).find((name) => system.includes(`Server: \\"${name}\\"`));
        const answer = server === undefined ? new Error('unknown server') : answers[server];
        if (answer instanceof Error) throw answer;
        return makeV3Result(JSON.stringify(answer));
      },
    });
    return { model, callCount: () => calls };
  }

  const SERVERS: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
    ['filesystem', filesystemTools],
    ['github', githubTools],
  ];
  const ANSWERS = {
    filesystem: { skip: false, reason: 'Files are mentioned' },
    github: { skip: true, reason: 'Nothing about GitHub' },
  };
  const TEXT = 'Allow reading local files only';

  it('an unchanged rerun asks the model nothing and returns the same decisions', async () => {
    const cache = cacheIn();
    const first = answeringModel(ANSWERS);
    const decided = await prefilterServers(TEXT, SERVERS, first.model, 'constitution', cache);
    expect(first.callCount()).toBe(2);
    expect(decided.map((d) => d.cached)).toEqual([undefined, undefined]);
    expect(existsSync(resolve(cache.outputDir, 'servers', 'github', PREFILTER_DECISION_FILE))).toBe(true);

    const second = answeringModel({ filesystem: new Error('must not be called'), github: new Error('nor this') });
    const reused = await prefilterServers(TEXT, SERVERS, second.model, 'constitution', cache);

    expect(second.callCount()).toBe(0);
    expect(reused).toEqual([
      { serverName: 'filesystem', skip: false, reason: 'Files are mentioned', cached: true },
      { serverName: 'github', skip: true, reason: 'Nothing about GitHub', cached: true },
    ]);
  });

  it('asks again when the text, the tools, the mode or the model change', async () => {
    const cache = cacheIn();
    await prefilterServers(TEXT, SERVERS, answeringModel(ANSWERS).model, 'constitution', cache);

    const changes: Array<() => Promise<unknown>> = [];
    const counted = answeringModel(ANSWERS);
    changes.push(() => prefilterServers(`${TEXT} and GitHub issues`, SERVERS, counted.model, 'constitution', cache));
    const renamedTool: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', [{ ...filesystemTools[0], comment: 'Read a file (now also directories)' }, filesystemTools[1]]],
    ];
    changes.push(() => prefilterServers(TEXT, renamedTool, counted.model, 'constitution', cache));
    changes.push(() => prefilterServers(TEXT, [SERVERS[0]], counted.model, 'task-policy', cache));
    changes.push(() =>
      prefilterServers(TEXT, [SERVERS[0]], counted.model, 'constitution', { ...cache, modelId: 'test:other' }),
    );
    let expected = 0;
    for (const [i, change] of changes.entries()) {
      await change();
      expected += i === 0 ? 2 : 1;
      expect(counted.callCount()).toBe(expected);
    }
  });

  it('does not cache a fail-open decision after an error', async () => {
    const cache = cacheIn();
    const failing = answeringModel({ filesystem: new Error('rate limited'), github: ANSWERS.github });
    const decided = await prefilterServers(TEXT, SERVERS, failing.model, 'constitution', cache);
    expect(decided[0]).toMatchObject({ serverName: 'filesystem', skip: false });
    expect(decided[0].reason).toContain('Pre-filter error');
    expect(existsSync(resolve(cache.outputDir, 'servers', 'filesystem', PREFILTER_DECISION_FILE))).toBe(false);

    const next = answeringModel(ANSWERS);
    await prefilterServers(TEXT, SERVERS, next.model, 'constitution', cache);
    expect(next.callCount()).toBe(1); // filesystem only; github's decision was cached
  });

  it('refresh asks again and stores the new decision', async () => {
    const cache = cacheIn();
    await prefilterServers(TEXT, [SERVERS[1]], answeringModel(ANSWERS).model, 'constitution', cache);
    const flipped = answeringModel({ ...ANSWERS, github: { skip: false, reason: 'Issues matter after all' } });

    const refreshed = await prefilterServers(TEXT, [SERVERS[1]], flipped.model, 'constitution', {
      ...cache,
      refresh: true,
    });

    expect(flipped.callCount()).toBe(1);
    expect(refreshed[0]).toMatchObject({ skip: false, reason: 'Issues matter after all' });
    const stored = JSON.parse(
      readFileSync(resolve(cache.outputDir, 'servers', 'github', PREFILTER_DECISION_FILE), 'utf-8'),
    ) as { skip: boolean };
    expect(stored.skip).toBe(false);
  });

  it('ignores a damaged cache file', async () => {
    const cache = cacheIn();
    await prefilterServers(TEXT, [SERVERS[1]], answeringModel(ANSWERS).model, 'constitution', cache);
    const file = resolve(cache.outputDir, 'servers', 'github', PREFILTER_DECISION_FILE);
    const stored = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...stored, skip: 'yes' }));

    const again = answeringModel(ANSWERS);
    const decided = await prefilterServers(TEXT, [SERVERS[1]], again.model, 'constitution', cache);
    expect(again.callCount()).toBe(1);
    expect(decided[0]).toMatchObject({ skip: true });
    expect(decided[0].cached).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt content tests (tested indirectly through checkServerRelevance)
// ---------------------------------------------------------------------------

describe('buildPrefilterPrompt (indirect)', () => {
  /** Extract the system message from the V3 prompt array passed to doGenerate. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK internal prompt shape
  function extractSystemFromPrompt(options: Record<string, any>): string | undefined {
    const prompt = options.prompt as Array<{ role: string; content: string }> | undefined;
    const systemMsg = prompt?.find((m: { role: string }) => m.role === 'system');
    return systemMsg?.content;
  }

  it('constitution mode prompt mentions "allowed or granted special permissions"', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Allow file reading', 'filesystem', filesystemTools, model, 'constitution');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('allowed or granted special permissions');
    expect(capturedSystem).not.toContain('accomplishing this task would require');
  });

  it('task-policy mode prompt mentions "accomplishing this task would require"', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Analyze CSV files', 'filesystem', filesystemTools, model, 'task-policy');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('accomplishing this task would require');
    expect(capturedSystem).not.toContain('allowed or granted special permissions');
  });

  it('prompt includes server name and tool descriptions', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Some text', 'github', githubTools, model, 'constitution');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('"github"');
    expect(capturedSystem).toContain('search_issues');
    expect(capturedSystem).toContain('Search GitHub issues');
    expect(capturedSystem).toContain('create_pr');
  });
});

// ---------------------------------------------------------------------------
// Functional tests: mergeServerResults with skippedServers
// ---------------------------------------------------------------------------

describe('mergeServerResults with skippedServers', () => {
  const sampleRule: CompiledRule = {
    name: 'allow-read-file',
    description: 'Allow reading files in sandbox',
    principle: 'File reading is safe',
    if: { server: ['filesystem'], tool: ['read_file'] },
    then: 'allow',
    reason: 'Read-only access is safe',
  };

  it('includes skippedServers in the output when provided', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const skipped = [
      { serverName: 'github', reason: 'No GitHub guidance in constitution' },
      { serverName: 'slack', reason: 'No Slack guidance in constitution' },
    ];

    const merged = mergeServerResults(results, 'const-hash', skipped);

    expect(merged.skippedServers).toBeDefined();
    expect(merged.skippedServers).toHaveLength(2);
    expect(merged.skippedServers![0].serverName).toBe('github');
    expect(merged.skippedServers![1].serverName).toBe('slack');
    expect(merged.rules).toHaveLength(1);
  });

  it('omits skippedServers field when no servers were skipped', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const merged = mergeServerResults(results, 'const-hash');

    expect(merged.skippedServers).toBeUndefined();
  });

  it('omits skippedServers field when empty array is passed', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const merged = mergeServerResults(results, 'const-hash', []);

    expect(merged.skippedServers).toBeUndefined();
  });

  it('works when all servers are skipped (no rules)', () => {
    const skipped = [
      { serverName: 'filesystem', reason: 'Not relevant' },
      { serverName: 'github', reason: 'Not relevant' },
    ];

    const merged = mergeServerResults([] as ServerResult[], 'const-hash', skipped);

    expect(merged.rules).toHaveLength(0);
    expect(merged.skippedServers).toHaveLength(2);
  });

  it('preserves rules from compiled servers alongside skipped servers', () => {
    const rule2: CompiledRule = {
      name: 'allow-git-log',
      description: 'Allow git log',
      principle: 'Read-only git is safe',
      if: { server: ['git'], tool: ['git_log'] },
      then: 'allow',
      reason: 'Read-only',
    };

    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
      {
        serverName: 'git',
        rules: [rule2],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'def456',
        constitutionHash: 'const-hash',
      },
    ];

    const skipped = [{ serverName: 'github', reason: 'Skipped by pre-filter' }];

    const merged = mergeServerResults(results, 'const-hash', skipped);

    expect(merged.rules).toHaveLength(2);
    expect(merged.skippedServers).toHaveLength(1);
    // Rules should be sorted by server name (filesystem before git)
    expect(merged.rules[0].name).toBe('allow-read-file');
    expect(merged.rules[1].name).toBe('allow-git-log');
  });
});
