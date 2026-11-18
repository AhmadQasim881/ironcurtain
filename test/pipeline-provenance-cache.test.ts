/**
 * WP-60 regression tests for the per-server compile cache (PIP-11, PIP-18)
 * and the provenance the pipeline stamps.
 *
 *  - PIP-11: the verified commit stores the scenario hash of its FINAL
 *    (repaired) rules and lists, so a server whose repair changed permitted
 *    directories or lists is served from cache on the next unchanged run; a
 *    per-server dynamic-lists.json left by an earlier compile is ignored when
 *    the rules define no lists; a repair that removes every list drops the
 *    resolved lists too. A scenario-hash miss (or other engine semantics)
 *    keeps the verified rules and re-verifies them instead of recompiling.
 *  - PIP-18: the policy model and the verifier version are recorded per
 *    commit; a cache hit made by another one warns, and `force` recompiles.
 *    The compiler epoch is part of the cache key.
 *
 * Every test drives the REAL PipelineRunner with scripted fake LLMs (no
 * network, no real LLM). A run that must be served from cache uses an LLM
 * that throws on any call.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ServerCompiledPolicyFile,
  StoredToolAnnotationsFile,
  TestScenariosFile,
} from '../src/pipeline/types.js';
import { computeAnnotationContentDigest } from '../src/config/tool-annotations-overlay.js';
import {
  ENGINE_SEMANTICS_VERSION,
  PIPELINE_VERIFIER_VERSION,
  POLICY_COMPILER_EPOCH,
} from '../src/policy-artifacts/provenance.js';
import { replayRecordedDecisions } from '../src/policy-artifacts/scenario-replay.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import {
  createScriptedPipelineModels,
  createThrowingPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
  type ScriptedPipelineModels,
} from './fixtures/fake-pipeline-models.js';
import {
  CONSTITUTION,
  FS_AND_CHANGED_NEWS,
  FS_AND_NEWS,
  FS_ONLY,
  FS_SCENARIOS,
  GOOD_BOTH,
  GOOD_FS,
  NEWS,
  NEWS_SCENARIOS,
  NEWS_TOOLS,
  NO_CHANGE_PATCH,
  PASS,
  REJECT_FS,
  SANDBOX,
  annotationsFor,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeOutputDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp60-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

/** A reporter that keeps the warnings it receives. */
function recordingReporter(warnings: string[]): ServerProgressReporter {
  return {
    update: () => {},
    complete: () => {},
    warn: (message) => warnings.push(message),
    fail: () => {},
    done: () => {},
  };
}

interface RunOutcome {
  readonly policy?: CompiledPolicyFile;
  readonly error?: unknown;
  readonly warnings: string[];
}

async function run(
  fake: ScriptedPipelineModels | { models: ScriptedPipelineModels['models'] },
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
  Runner: typeof PipelineRunner = PipelineRunner,
): Promise<RunOutcome> {
  const warnings: string[] = [];
  const config: PipelineRunConfig = {
    constitutionInput: CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir,
    allowedDirectory: SANDBOX,
    protectedPaths: [],
    preloadedStoredAnnotations: annotations,
    includeHandwrittenScenarios: false,
    quiet: true,
    reporterFactory: () => recordingReporter(warnings),
    onProgress: () => {},
    ...overrides,
  };
  try {
    return { policy: await new Runner(fake.models).run(config), warnings };
  } catch (error) {
    return { error, warnings };
  }
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
}

function throwing(outputDir: string): ScriptedPipelineModels {
  return createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
}

/** Fake models that report `policyModelId` as the configured policy model. */
function withModel(fake: ScriptedPipelineModels, policyModelId: string) {
  return { models: { ...fake.models, policyModelId } };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-side typing for JSON artifacts
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function serverFile(outputDir: string, server: string, file: string): string {
  return resolve(outputDir, 'servers', server, file);
}

function commitOf(outputDir: string, server: string): ServerCompiledPolicyFile {
  return readJson<ServerCompiledPolicyFile>(serverFile(outputDir, server, 'compiled-policy.json'));
}

function editCommit(outputDir: string, server: string, edit: (c: Record<string, unknown>) => void): void {
  const path = serverFile(outputDir, server, 'compiled-policy.json');
  const commit = readJson<Record<string, unknown>>(path);
  edit(commit);
  writeFileSync(path, JSON.stringify(commit, null, 2));
}

function ruleNames(policy: { rules: Array<{ name: string }> } | undefined): string[] {
  return (policy?.rules ?? []).map((r) => r.name);
}

function callsOf(fake: ScriptedPipelineModels, phase: FakeLlmCall['phase']): FakeLlmCall[] {
  return fake.calls.filter((c) => c.phase === phase);
}

// --- fs rules whose repair moves the permitted directory -------------------

const DOCS_SCENARIOS = {
  scenarios: [
    {
      description: 'read a document',
      request: { serverName: 'fs', toolName: 'read_file', arguments: { path: '/wp60/opt/docs/a.txt' } },
      expectedDecision: 'allow',
      reasoning: 'Documents may be read.',
    },
    FS_SCENARIOS.scenarios[1],
  ],
};
const docsRule = (within: string) =>
  rule('allow-doc-reads', 'fs', { tool: ['read_file'], paths: { roles: ['read-path'], within } });
const REJECT_DOCS = {
  analysis: 'FAIL: the documents live in /wp60/opt/docs.',
  pass: false,
  failureAttributions: [
    { scenarioIndex: 1, scenarioDescription: 'read a document', blame: { kind: 'rule', reasoning: 'Wrong dir.' } },
  ],
  additionalScenarios: [],
};
const MOVE_DOCS = {
  reasoning: 'The documents live in /wp60/opt/docs.',
  operations: [{ op: 'update', ruleName: 'allow-doc-reads', rule: docsRule('/wp60/opt/docs') }],
};

// --- news rules with a dynamic list ----------------------------------------

const NEWS_LIST = {
  name: 'news-sites',
  type: 'domains',
  principle: 'News may be read.',
  generationPrompt: 'List news site domains.',
  requiresMcp: false,
};
const NEWS_WITH_LIST = {
  rules: [
    rule('allow-news', 'news', { tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed: ['@news-sites'] } }),
  ],
  listDefinitions: [NEWS_LIST],
};
const NEWS_ONLY = annotationsFor({ news: NEWS_TOOLS });
const CHANGED_NEWS_ONLY = { ...FS_AND_CHANGED_NEWS, servers: { news: FS_AND_CHANGED_NEWS.servers.news } };
const REJECT_NEWS = {
  analysis: 'FAIL: news must be reachable.',
  pass: false,
  failureAttributions: [
    { scenarioIndex: 1, scenarioDescription: 'fetch a news page', blame: { kind: 'rule', reasoning: 'Blocked.' } },
  ],
  additionalScenarios: [],
};
// List values must be registrable names (the Public Suffix List checks drop
// reserved TLDs such as `.example`), so the fixtures use example.com.
const NEWS_WITH_LIST_SCRIPT: FakePhaseScript = {
  compile: [NEWS_WITH_LIST],
  listResolution: [{ values: ['news.example.com'] }],
  scenarios: [NEWS_SCENARIOS],
  judge: [PASS],
};

// ---------------------------------------------------------------------------
// PIP-11
// ---------------------------------------------------------------------------

describe('a server whose repair changed its rules is served from cache next time (PIP-11)', () => {
  it('a repair that moved paths.within: the next unchanged run makes no LLM call', async () => {
    const outputDir = makeOutputDir();
    const fake1 = scripted(outputDir, {
      compile: [{ rules: [docsRule('/wp60/srv/docs')] }],
      scenarios: [DOCS_SCENARIOS],
      judge: [REJECT_DOCS, PASS],
      repair: [MOVE_DOCS],
    });
    const run1 = await run(fake1, outputDir, FS_ONLY);
    expect(run1.error).toBeUndefined();
    expect(callsOf(fake1, 'repair')).toHaveLength(1);
    expect(commitOf(outputDir, 'fs').rules[0].if.paths?.within).toBe('/wp60/opt/docs');

    const down = throwing(outputDir);
    const run2 = await run(down, outputDir, FS_ONLY);
    expect(down.calls).toEqual([]);
    expect(run2.error).toBeUndefined();
    expect(run2.policy?.rules).toEqual(run1.policy?.rules);
  });

  it('ignores a per-server dynamic-lists.json left by an earlier compile once the rules define no lists', async () => {
    const outputDir = makeOutputDir();
    expect((await run(scripted(outputDir, NEWS_WITH_LIST_SCRIPT), outputDir, NEWS_ONLY)).error).toBeUndefined();
    const listsPath = serverFile(outputDir, 'news', 'dynamic-lists.json');
    expect(existsSync(listsPath)).toBe(true);

    // The next compile (changed annotations) produces rules without lists;
    // the earlier lists file stays where it was.
    const run2 = await run(
      scripted(outputDir, { compile: [NEWS], scenarios: [NEWS_SCENARIOS], judge: [PASS] }),
      outputDir,
      CHANGED_NEWS_ONLY,
    );
    expect(run2.error).toBeUndefined();
    expect(existsSync(listsPath)).toBe(true);

    const down = throwing(outputDir);
    const run3 = await run(down, outputDir, CHANGED_NEWS_ONLY);
    expect(down.calls).toEqual([]);
    expect(ruleNames(run3.policy)).toEqual(['allow-news']);
    expect(run3.policy?.listDefinitions).toBeUndefined();
  });

  // The per-server lists file is read through the runtime schema (WP-61) only
  // when the cached rules use lists: their values and manual overrides become
  // the merged dynamic-lists.json.
  const MALFORMED_LISTS = JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    lists: {
      'news-sites': {
        values: ['news.example.com'],
        manualAdditions: '*.example.com',
        manualRemovals: [],
        resolvedAt: '2026-01-01T00:00:00.000Z',
        inputHash: 'x',
      },
    },
  });

  it('fails the server instead of serving a cached commit whose lists file is malformed', async () => {
    const outputDir = makeOutputDir();
    expect((await run(scripted(outputDir, NEWS_WITH_LIST_SCRIPT), outputDir, NEWS_ONLY)).error).toBeUndefined();
    const mergedPolicy = readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8');
    const mergedLists = readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8');

    // A misspelled override key: the values and overrides the scenario hash
    // covers are unchanged, so without the schema check the commit would be a
    // cache hit, and the merged dynamic-lists.json would carry a list entry
    // the runtime loader refuses (and the user's removal would never apply).
    const listsPath = serverFile(outputDir, 'news', 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeFileSync(
      listsPath,
      JSON.stringify({
        ...lists,
        lists: { 'news-sites': { ...lists.lists['news-sites'], manualRemoval: ['news.example.com'] } },
      }),
    );

    const down = throwing(outputDir);
    const result = await run(down, outputDir, NEWS_ONLY);
    expect(down.calls).toEqual([]);
    expect(result.error).toMatchObject({
      code: 'ALL_SERVERS_FAILED',
      failedServers: [
        {
          serverName: 'news',
          reason: expect.stringContaining('lists.news-sites.manualRemoval: unknown field') as unknown,
        },
      ],
    });
    // Nothing was merged from the malformed file.
    expect(readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8')).toBe(mergedPolicy);
    expect(readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8')).toBe(mergedLists);
  });

  it('serves rules without lists from cache even when an earlier, malformed lists file is left over', async () => {
    const outputDir = makeOutputDir();
    expect((await run(scripted(outputDir, NEWS_WITH_LIST_SCRIPT), outputDir, NEWS_ONLY)).error).toBeUndefined();
    const run2 = await run(
      scripted(outputDir, { compile: [NEWS], scenarios: [NEWS_SCENARIOS], judge: [PASS] }),
      outputDir,
      CHANGED_NEWS_ONLY,
    );
    expect(run2.error).toBeUndefined();
    writeFileSync(serverFile(outputDir, 'news', 'dynamic-lists.json'), MALFORMED_LISTS);

    const down = throwing(outputDir);
    const run3 = await run(down, outputDir, CHANGED_NEWS_ONLY);
    expect(down.calls).toEqual([]);
    expect(run3.error).toBeUndefined();
    expect(ruleNames(run3.policy)).toEqual(['allow-news']);
    expect(run3.policy?.listDefinitions).toBeUndefined();
  });

  it('a repair that removed every list drops the resolved lists, and the next run hits the cache', async () => {
    const outputDir = makeOutputDir();
    // The point-fix patch is unusable twice, so the session falls back to a
    // full recompile, which returns rules without any list.
    const fake1 = scripted(outputDir, {
      compile: [NEWS_WITH_LIST],
      listResolution: [{ values: ['blocked.example.com'] }],
      scenarios: [NEWS_SCENARIOS],
      judge: [REJECT_NEWS, PASS],
      repair: [{ unusable: true }],
      schemaRetry: [{ unusable: true }],
      recompile: [NEWS],
    });
    const run1 = await run(fake1, outputDir, NEWS_ONLY);
    expect(run1.error).toBeUndefined();
    expect(callsOf(fake1, 'recompile')).toHaveLength(1);
    expect(ruleNames(run1.policy)).toEqual(['allow-news']);
    expect(run1.policy?.listDefinitions).toBeUndefined();
    // The judge saw the list before the repair and not after it.
    const judges = callsOf(fake1, 'judge');
    expect(judges[0].system).toContain('Dynamic List Values');
    expect(judges[judges.length - 1].system).not.toContain('Dynamic List Values');

    const down = throwing(outputDir);
    const run2 = await run(down, outputDir, NEWS_ONLY);
    expect(down.calls).toEqual([]);
    expect(ruleNames(run2.policy)).toEqual(['allow-news']);
  });

  it('a scenario-hash miss keeps the verified rules and re-verifies them, without recompiling', async () => {
    const outputDir = makeOutputDir();
    const run1 = await run(scripted(outputDir, NEWS_WITH_LIST_SCRIPT), outputDir, NEWS_ONLY);
    expect(run1.error).toBeUndefined();
    const before = commitOf(outputDir, 'news');

    // The user adds a value to the resolved list: the rules now match more,
    // so they must be verified again, but nothing the compiler saw changed.
    const listsPath = serverFile(outputDir, 'news', 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeFileSync(
      listsPath,
      JSON.stringify({
        ...lists,
        lists: { 'news-sites': { ...lists.lists['news-sites'], manualAdditions: ['extra.example.com'] } },
      }),
    );

    // No compile script: a compile call would throw.
    const fake2 = scripted(outputDir, { scenarios: [NEWS_SCENARIOS], judge: [PASS] });
    const run2 = await run(fake2, outputDir, NEWS_ONLY);
    expect(run2.error).toBeUndefined();
    expect(callsOf(fake2, 'compile')).toEqual([]);
    expect(callsOf(fake2, 'listResolution')).toEqual([]);
    expect(callsOf(fake2, 'scenarios')).toHaveLength(1);
    expect(callsOf(fake2, 'judge').length).toBeGreaterThan(0);
    expect(run2.warnings.join('\n')).toContain(
      're-verifying the cached rules: the inputs of its test scenarios changed',
    );
    const after = commitOf(outputDir, 'news');
    expect(after.rules).toEqual(before.rules);
    expect(after.scenarioHash).not.toBe(before.scenarioHash);

    // ...and the re-verified commit is then served without any LLM call.
    const down = throwing(outputDir);
    expect((await run(down, outputDir, NEWS_ONLY)).error).toBeUndefined();
    expect(down.calls).toEqual([]);
  });

  it('re-verifies a completeness change and resolves its uncertain list before caching it again', async () => {
    const outputDir = makeOutputDir();
    expect((await run(scripted(outputDir, NEWS_WITH_LIST_SCRIPT), outputDir, NEWS_ONLY)).error).toBeUndefined();
    const listsPath = serverFile(outputDir, 'news', 'dynamic-lists.json');
    const previous = readJson<DynamicListsFile>(listsPath);
    writeFileSync(
      listsPath,
      JSON.stringify({
        ...previous,
        lists: { 'news-sites': { ...previous.lists['news-sites'], resolutionState: 'incomplete' } },
      }),
    );
    const fake = scripted(outputDir, {
      listResolution: [{ values: ['news.example.com'] }],
      scenarios: [NEWS_SCENARIOS],
      judge: [PASS],
    });
    const result = await run(fake, outputDir, NEWS_ONLY);
    expect(result.error).toBeUndefined();
    expect(callsOf(fake, 'compile')).toEqual([]);
    expect(callsOf(fake, 'listResolution')).toHaveLength(1);
    // The fresh resolution returns to the original served values/state, so
    // scenario generation can reuse its content hash; the judge still runs.
    expect(callsOf(fake, 'judge').length).toBeGreaterThan(0);
    expect(readJson<DynamicListsFile>(listsPath).lists['news-sites'].resolutionState).toBe('complete');
    const down = throwing(outputDir);
    expect((await run(down, outputDir, NEWS_ONLY)).error).toBeUndefined();
    expect(down.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Engine semantics, rules integrity
// ---------------------------------------------------------------------------

describe('verified commits from other engine semantics or edited after verification', () => {
  it('re-verifies (judge only) a commit verified under other policy-engine semantics', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    editCommit(outputDir, 'fs', (c) => {
      c.engineSemanticsVersion = ENGINE_SEMANTICS_VERSION - 1;
    });

    const fake = scripted(outputDir, { judge: [PASS] });
    const result = await run(fake, outputDir, FS_ONLY);
    expect(result.error).toBeUndefined();
    expect(new Set(fake.calls.map((c) => c.phase))).toEqual(new Set(['judge']));
    expect(result.warnings.join('\n')).toContain(`policy-engine semantics v${ENGINE_SEMANTICS_VERSION - 1}`);
    expect(commitOf(outputDir, 'fs').engineSemanticsVersion).toBe(ENGINE_SEMANTICS_VERSION);
    expect(ruleNames(result.policy)).toEqual(['allow-fs-reads']);
  });

  it('removes the commit when re-verification fails, so the next run recompiles', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    editCommit(outputDir, 'fs', (c) => {
      c.engineSemanticsVersion = ENGINE_SEMANTICS_VERSION - 1;
    });

    const rejected = await run(
      scripted(outputDir, { judge: [REJECT_FS], repair: [NO_CHANGE_PATCH] }),
      outputDir,
      FS_ONLY,
    );
    expect((rejected.error as { code?: string } | undefined)?.code).toBe('ALL_SERVERS_FAILED');
    expect(existsSync(serverFile(outputDir, 'fs', 'compiled-policy.json'))).toBe(false);
    expect(existsSync(serverFile(outputDir, 'fs', 'compiled-policy.unverified.json'))).toBe(true);

    const down = throwing(outputDir);
    await run(down, outputDir, FS_ONLY);
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
  });

  it('recompiles a commit whose rules were edited after verification (rulesHash mismatch)', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    editCommit(outputDir, 'fs', (c) => {
      const rules = c.rules as Array<{ if: { tool?: string[] } }>;
      rules[0].if.tool = ['read_file', 'delete_file'];
    });

    const down = throwing(outputDir);
    const result = await run(down, outputDir, FS_ONLY);
    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
    expect(result.policy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PIP-18: policy model and verifier version
// ---------------------------------------------------------------------------

describe('cached commits made by another policy model or verifier version (PIP-18)', () => {
  afterEach(() => {
    vi.doUnmock('../src/policy-artifacts/provenance.js');
    vi.resetModules();
  });

  it('changing PIPELINE_VERIFIER_VERSION warns on the next cache hit; force recompiles and re-verifies', async () => {
    const outputDir = makeOutputDir();
    await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    expect(commitOf(outputDir, 'fs').verifierVersion).toBe(PIPELINE_VERIFIER_VERSION);

    // A later IronCurtain with a bumped verifier version.
    vi.resetModules();
    vi.doMock('../src/policy-artifacts/provenance.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/policy-artifacts/provenance.js')>()),
      PIPELINE_VERIFIER_VERSION: PIPELINE_VERIFIER_VERSION + 1,
    }));
    const { PipelineRunner: UpgradedRunner } = await import('../src/pipeline/pipeline-runner.js');

    const down = throwing(outputDir);
    const cached = await run(down, outputDir, FS_ONLY, {}, UpgradedRunner);
    expect(cached.error).toBeUndefined();
    expect(down.calls).toEqual([]);
    // Without a caller hint (persona and cron-job compiles have no --force),
    // the warning names the server's artifact directory to remove.
    expect(cached.warnings.join('\n')).toMatch(
      new RegExp(
        `verified by pipeline verifier v${PIPELINE_VERIFIER_VERSION}; ` +
          `this IronCurtain's verifier is v${PIPELINE_VERIFIER_VERSION + 1}\\. ` +
          `Remove ${escapeRegExp(resolve(outputDir, 'servers', 'fs'))} and compile again`,
      ),
    );
    // The merged policy records the verifier its (cached) rules really passed.
    expect(cached.policy?.provenance?.verifierVersion).toBe(PIPELINE_VERIFIER_VERSION);

    const fake = scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] });
    const forced = await run(fake, outputDir, FS_ONLY, { force: true }, UpgradedRunner);
    expect(forced.error).toBeUndefined();
    expect(callsOf(fake, 'compile')).toHaveLength(1);
    expect(callsOf(fake, 'scenarios')).toHaveLength(1);
    expect(commitOf(outputDir, 'fs').verifierVersion).toBe(PIPELINE_VERIFIER_VERSION + 1);
    expect(forced.warnings.join('\n')).not.toContain('pipeline verifier');
    expect(forced.policy?.provenance?.verifierVersion).toBe(PIPELINE_VERIFIER_VERSION + 1);
  });

  it('a commit made by another policy model warns on a cache hit and records the model', async () => {
    const outputDir = makeOutputDir();
    const run1 = await run(
      withModel(scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }), 'test:model-a'),
      outputDir,
      FS_ONLY,
    );
    expect(run1.policy?.provenance?.policyModelId).toBe('test:model-a');
    expect(commitOf(outputDir, 'fs').policyModelId).toBe('test:model-a');

    const down = throwing(outputDir);
    const hint = 'Run `ironcurtain compile-policy` again with `--force` to recompile and re-verify it.';
    const run2 = await run(withModel(down, 'test:model-b'), outputDir, FS_ONLY, { cacheBypassHint: hint });
    expect(down.calls).toEqual([]);
    expect(run2.warnings.join('\n')).toContain(
      `compiled by test:model-a; the configured policy model is test:model-b. ${hint}`,
    );
    // The merged policy names the model that really compiled its (cached) rules.
    expect(run2.policy?.provenance?.policyModelId).toBe('test:model-a');

    const same = throwing(outputDir);
    const run3 = await run(withModel(same, 'test:model-a'), outputDir, FS_ONLY);
    expect(run3.warnings.join('\n')).not.toContain('policy model');
  });
});

// ---------------------------------------------------------------------------
// Provenance and replay records in the merged artifacts
// ---------------------------------------------------------------------------

describe('merged artifacts', () => {
  it('stamp provenance and record replayable decisions, also when served from cache', async () => {
    const outputDir = makeOutputDir();
    const run1 = await run(withModel(scripted(outputDir, GOOD_BOTH), 'test:model-a'), outputDir, FS_AND_NEWS);
    expect(run1.error).toBeUndefined();

    const checkMerged = () => {
      const policy = readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json'));
      expect(policy.provenance).toMatchObject({
        policyCompilerEpoch: POLICY_COMPILER_EPOCH,
        engineSemanticsVersion: ENGINE_SEMANTICS_VERSION,
        verifierVersion: PIPELINE_VERIFIER_VERSION,
        policyModelId: 'test:model-a',
        annotationDigests: {
          fs: computeAnnotationContentDigest(FS_AND_NEWS.servers.fs.tools),
          news: computeAnnotationContentDigest(FS_AND_NEWS.servers.news.tools),
        },
      });
      const scenarios = readJson<TestScenariosFile>(resolve(outputDir, 'test-scenarios.json'));
      expect(scenarios.replay?.allowedDirectory).toBe(SANDBOX);
      expect(scenarios.replay?.decisions).toHaveLength(scenarios.scenarios.length);
      const engine = new PolicyEngine(policy, FS_AND_NEWS, [], SANDBOX);
      expect(replayRecordedDecisions(engine, scenarios)).toMatchObject({ kind: 'replayed', changes: [] });
      return scenarios.replay?.decisions;
    };

    const decisions = checkMerged();
    const down = throwing(outputDir);
    expect((await run(withModel(down, 'test:model-a'), outputDir, FS_AND_NEWS)).error).toBeUndefined();
    expect(down.calls).toEqual([]);
    expect(checkMerged()).toEqual(decisions);
  });
});
