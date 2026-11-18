/**
 * WP-62: the dynamic-lists lifecycle.
 *
 *  - PIP-8: the user's manual overrides in a policy's merged dynamic-lists.json
 *    survive compile-policy (they used to be rebuilt from the per-server copies
 *    and silently dropped).
 *  - PIP-6: servers that define the same list name differently keep separate
 *    values (the merge used to keep one server's definition with another
 *    server's values).
 *  - PIP-25: refresh-lists --persona / --job refreshes that policy, updating
 *    the merged file AND the per-server copies, so the next compile keeps the
 *    refreshed values.
 *  - PIP-24: compile-policy --no-mcp leaves data-backed lists unresolved
 *    (empty, never cached as resolved) instead of failing the server.
 *  - GAP3-12: the runtime layers user-refreshed lists over the shipped policy's
 *    lists; a policy's lists come from its own directory; a missing lists file
 *    is reported.
 *
 * Pipeline runs drive the REAL PipelineRunner with scripted fake LLMs (no
 * network). A follow-up run with an LLM that throws on every call proves the
 * run was served from cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import { computeListHash, resolveAllLists } from '../src/pipeline/list-resolver.js';
import { mergeDynamicLists, planListMerge } from '../src/pipeline/list-merge.js';
import { main as refreshListsMain, parseRefreshArgs, refreshDynamicLists } from '../src/pipeline/refresh-lists.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import {
  findMissingDynamicLists,
  getPackageGeneratedDir,
  layerUserDynamicLists,
  loadGeneratedPolicy,
  loadPersonaPolicyArtifacts,
} from '../src/config/index.js';
import * as logger from '../src/logger.js';
import { checkPolicyArtifacts } from '../src/doctor/checks.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  ListDefinition,
  ResolvedList,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';
import {
  createScriptedPipelineModels,
  createThrowingPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
  type ScriptedPipelineModels,
} from './fixtures/fake-pipeline-models.js';
import { annotationsFor, PASS, rule } from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeOutputDir(): string {
  const outputDir = resolve(tempDir('ic-wp62-'), 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

const SANDBOX = '/wp62/sandbox';
const CONSTITUTION = 'Fetch news from news sites. Push only to the company git host. Read documentation sites.';

interface Reported {
  readonly warnings: string[];
}

function reporterFor(reported: Reported): ServerProgressReporter {
  return {
    update: () => {},
    complete: () => {},
    warn: (message) => reported.warnings.push(message),
    fail: () => {},
    done: () => {},
  };
}

function runConfig(
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  reported: Reported,
  overrides: Partial<PipelineRunConfig> = {},
): PipelineRunConfig {
  return {
    constitutionInput: CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir,
    allowedDirectory: SANDBOX,
    protectedPaths: [],
    preloadedStoredAnnotations: annotations,
    includeHandwrittenScenarios: false,
    quiet: true,
    reporterFactory: () => reporterFor(reported),
    onProgress: () => {},
    ...overrides,
  };
}

async function compile(
  fake: ScriptedPipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
): Promise<{ policy: CompiledPolicyFile; reported: Reported }> {
  const reported: Reported = { warnings: [] };
  const policy = await new PipelineRunner(fake.models).run(runConfig(outputDir, annotations, reported, overrides));
  return { policy, reported };
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-side typing for JSON artifacts
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Writes a complete job.json (the job store validates it on read), `overrides` on top. */
function writeJobJson(jobDir: string, id: string, overrides: Record<string, unknown> = {}): void {
  writeJson(resolve(jobDir, 'job.json'), {
    id,
    name: id,
    schedule: '0 9 * * *',
    taskDescription: 'Summarize the news',
    taskConstitution: 't',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  });
}

const URL_SCHEMA = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
const TO_SCHEMA = { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] };

function urlTool(serverName: string, toolName: string): StoredToolAnnotation {
  return { serverName, toolName, comment: `${toolName} a URL.`, args: { url: ['fetch-url'] }, inputSchema: URL_SCHEMA };
}

function domainsList(name: string, generationPrompt: string, extra: Partial<ListDefinition> = {}): ListDefinition {
  return { name, type: 'domains', principle: 'p', generationPrompt, requiresMcp: false, ...extra };
}

function domainsRule(name: string, server: string, tool: string, list: string): CompiledRule {
  return rule(name, server, { tool: [tool], domains: { roles: ['fetch-url'], allowed: [`@${list}`] } });
}

function urlScenario(server: string, tool: string, url: string, expectedDecision: 'allow' | 'deny') {
  return {
    description: `${server} ${tool} ${url}`,
    request: { serverName: server, toolName: tool, arguments: { url } },
    expectedDecision,
    reasoning: 'r',
  };
}

/** Evaluates a URL call against the policy and lists in `dir`, as a session would load them. */
function decide(dir: string, annotations: StoredToolAnnotationsFile, server: string, tool: string, url: string) {
  const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(dir);
  const engine = new PolicyEngine(compiledPolicy, annotations, [], undefined, undefined, dynamicLists);
  return engine.evaluate({ requestId: 't', serverName: server, toolName: tool, arguments: { url }, timestamp: '' })
    .decision;
}

// ---------------------------------------------------------------------------
// PIP-8: manual overrides survive compile-policy
// ---------------------------------------------------------------------------

const NEWS_ANNOTATIONS = annotationsFor({ news: [urlTool('news', 'http_fetch')] });
const NEWS_LIST = domainsList('news-sites', 'List news site domains.');

const NEWS_SCRIPT: FakePhaseScript = {
  compile: [
    { rules: [domainsRule('allow-news-sites', 'news', 'http_fetch', 'news-sites')], listDefinitions: [NEWS_LIST] },
  ],
  listResolution: [{ values: ['good.example.com', 'evil.example.com'] }],
  scenarios: [
    {
      scenarios: [
        urlScenario('news', 'http_fetch', 'https://good.example.com/today', 'allow'),
        urlScenario('news', 'http_fetch', 'https://elsewhere.example.com/', 'deny'),
      ],
    },
  ],
  judge: [PASS],
};

describe('PIP-8: manual list overrides survive compile-policy', () => {
  it('keeps a manual removal (and addition) through an unchanged recompile served from cache', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://evil.example.com/')).toBe('allow');

    // The user edits the merged file, as the docs tell them to.
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const edited = readJson<DynamicListsFile>(listsPath);
    const entry = edited.lists['news-sites'];
    writeJson(listsPath, {
      ...edited,
      lists: {
        'news-sites': {
          ...entry,
          manualRemovals: ['evil.example.com', '*.evil.example.com'],
          manualAdditions: ['extra.example.com'],
        },
      },
    });
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://evil.example.com/')).toBe('deny');

    // Unchanged recompile: no LLM call at all, so it is served from cache...
    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await compile(offline, outputDir, NEWS_ANNOTATIONS);
    expect(offline.calls).toEqual([]);

    // ...and the overrides are still there and still enforced.
    const after = readJson<DynamicListsFile>(listsPath).lists['news-sites'];
    expect(after.manualRemovals).toEqual(['evil.example.com', '*.evil.example.com']);
    expect(after.manualAdditions).toEqual(['extra.example.com']);
    expect(after.values).toEqual(entry.values);
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://evil.example.com/')).toBe('deny');
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://www.evil.example.com/')).toBe('deny');
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://extra.example.com/')).toBe('allow');
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://good.example.com/')).toBe('allow');

    // Overrides never leak into the per-server copy or into `values`, so
    // revoking a manual addition takes effect.
    const perServer = readJson<DynamicListsFile>(resolve(outputDir, 'servers', 'news', 'dynamic-lists.json'));
    expect(perServer.lists['news-sites'].manualAdditions).toEqual([]);
    expect(perServer.lists['news-sites'].manualRemovals).toEqual([]);
    expect(after.values).not.toContain('extra.example.com');
    writeJson(listsPath, {
      ...readJson<DynamicListsFile>(listsPath),
      lists: { 'news-sites': { ...after, manualAdditions: [] } },
    });
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://extra.example.com/')).toBe('deny');
  });

  it('keeps the overrides when the server is recompiled', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeJson(listsPath, {
      ...lists,
      lists: {
        'news-sites': { ...lists.lists['news-sites'], manualRemovals: ['evil.example.com', '*.evil.example.com'] },
      },
    });

    // A changed tool description makes the server recompile.
    const changed = annotationsFor({ news: [{ ...urlTool('news', 'http_fetch'), comment: 'Fetches news.' }] });
    const fake = scripted(outputDir, NEWS_SCRIPT);
    await compile(fake, outputDir, changed);
    expect(fake.calls.some((c) => c.phase === 'compile')).toBe(true);

    expect(readJson<DynamicListsFile>(listsPath).lists['news-sites'].manualRemovals).toEqual([
      'evil.example.com',
      '*.evil.example.com',
    ]);
    expect(decide(outputDir, changed, 'news', 'http_fetch', 'https://evil.example.com/')).toBe('deny');
  });

  it('keeps the overrides of a list the new policy does not use, for when it comes back', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    // `*.evil.example.com` (added by the resolver) also matches the apex, so both go.
    writeJson(listsPath, {
      ...lists,
      lists: {
        'news-sites': { ...lists.lists['news-sites'], manualRemovals: ['evil.example.com', '*.evil.example.com'] },
      },
    });

    // The constitution changes and the list disappears for a while...
    const noList: FakePhaseScript = {
      ...NEWS_SCRIPT,
      compile: [
        {
          rules: [
            rule('allow-good-news', 'news', {
              tool: ['http_fetch'],
              domains: { roles: ['fetch-url'], allowed: ['good.example.com'] },
            }),
          ],
        },
      ],
    };
    await compile(scripted(outputDir, noList), outputDir, NEWS_ANNOTATIONS, { constitutionInput: 'Fetch anything.' });
    expect(readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json')).listDefinitions).toBeUndefined();
    expect(readJson<DynamicListsFile>(listsPath).lists['news-sites'].manualRemovals).toEqual([
      'evil.example.com',
      '*.evil.example.com',
    ]);

    // ...and comes back: the removal still applies.
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    expect(readJson<DynamicListsFile>(listsPath).lists['news-sites'].manualRemovals).toEqual([
      'evil.example.com',
      '*.evil.example.com',
    ]);
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://evil.example.com/')).toBe('deny');
  });

  it('removes the lists file when no list remains and no overrides need keeping', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const noList: FakePhaseScript = {
      ...NEWS_SCRIPT,
      compile: [
        {
          rules: [
            rule('allow-good-news', 'news', {
              tool: ['http_fetch'],
              domains: { roles: ['fetch-url'], allowed: ['good.example.com'] },
            }),
          ],
        },
      ],
    };
    await compile(scripted(outputDir, noList), outputDir, NEWS_ANNOTATIONS, { constitutionInput: 'Fetch anything.' });
    expect(existsSync(resolve(outputDir, 'dynamic-lists.json'))).toBe(false);
  });

  it('fails without writing anything when the user-edited lists file is not valid JSON', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    writeFileSync(listsPath, '{ "lists": { "news-sites": { "manualRemovals": ["evil.example.com"] ');
    const policyBefore = readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8');

    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await expect(compile(offline, outputDir, NEWS_ANNOTATIONS)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(listsPath, 'utf-8')).toContain('evil.example.com');
    expect(readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8')).toBe(policyBefore);
  });

  it('fails when an override is not an array of strings, rather than spreading it into characters', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeJson(listsPath, {
      ...lists,
      lists: { 'news-sites': { ...lists.lists['news-sites'], manualAdditions: '*.com' } },
    });

    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await expect(compile(offline, outputDir, NEWS_ANNOTATIONS)).rejects.toThrow(
      /lists\.news-sites\.manualAdditions: expected an array/,
    );
  });

  it('lints the merged policy with the carried-over overrides: a broad manual addition fails the compile', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeJson(listsPath, {
      ...lists,
      lists: { 'news-sites': { ...lists.lists['news-sites'], manualAdditions: ['*.com'] } },
    });
    const listsBefore = readFileSync(listsPath, 'utf-8');
    const policyBefore = readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8');

    // Served from cache, but the merged policy is linted with the lists the
    // engine will expand, the user's additions included.
    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await expect(compile(offline, outputDir, NEWS_ANNOTATIONS)).rejects.toMatchObject({
      code: 'POLICY_LINT_FAILED',
    });
    expect(offline.calls).toEqual([]);
    expect(readFileSync(listsPath, 'utf-8')).toBe(listsBefore);
    expect(readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8')).toBe(policyBefore);

    // An explicit opt-in to broad domains (part of the compiler inputs, so the
    // server is compiled again) accepts it, and the addition is kept.
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS, { allowBroadDomains: true });
    expect(readJson<DynamicListsFile>(listsPath).lists['news-sites'].manualAdditions).toEqual(['*.com']);
  });

  it('fails the server whose per-server copy is not a valid lists file, never spreading it into characters', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, NEWS_SCRIPT), outputDir, NEWS_ANNOTATIONS);
    const copyPath = resolve(outputDir, 'servers', 'news', 'dynamic-lists.json');
    const copy = readJson<DynamicListsFile>(copyPath);
    // A string where an array belongs (the cache keeps its valid inputHash).
    writeJson(copyPath, { ...copy, lists: { 'news-sites': { ...copy.lists['news-sites'], values: '*.example' } } });
    const copyBefore = readFileSync(copyPath, 'utf-8');
    const mergedBefore = readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8');

    // The copy is read through the runtime schema: the server fails with the
    // field-level error instead of having its values merged in that shape.
    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await expect(compile(offline, outputDir, NEWS_ANNOTATIONS)).rejects.toThrow(
      /lists\.news-sites\.values: expected an array/,
    );
    expect(offline.calls).toEqual([]);
    expect(readFileSync(copyPath, 'utf-8')).toBe(copyBefore);
    expect(readFileSync(resolve(outputDir, 'dynamic-lists.json'), 'utf-8')).toBe(mergedBefore);
    expect(decide(outputDir, NEWS_ANNOTATIONS, 'news', 'http_fetch', 'https://attacker.invalid/')).toBe('deny');
  });

  it('writes a list no server resolved as unresolved, never with the values an earlier merged file held', () => {
    // A cached server whose per-server lists file is gone: no resolution.
    const results = [{ serverName: 'news', listDefinitions: [NEWS_LIST], resolvedLists: undefined }];
    const previous: DynamicListsFile = {
      generatedAt: '',
      lists: {
        'news-sites': {
          values: ['stale.example.com', '*.stale.example.com'],
          manualAdditions: ['extra.example.com'],
          manualRemovals: ['evil.example.com'],
          resolvedAt: '2026-01-01T00:00:00.000Z',
          inputHash: computeListHash(NEWS_LIST),
        },
      },
    };

    const { lists, notes } = mergeDynamicLists(results, planListMerge(results), previous);

    expect(lists?.lists['news-sites']).toEqual({
      values: [],
      manualAdditions: ['extra.example.com'],
      manualRemovals: ['evil.example.com'],
      resolvedAt: '',
      inputHash: '',
      resolutionState: 'incomplete',
    });
    expect(notes.join('\n')).toMatch(/@news-sites has no resolved values/);
  });

  it('preserves partial validation state in the merged list', () => {
    const entry: ResolvedList = {
      values: ['news.example.com'],
      manualAdditions: [],
      manualRemovals: [],
      resolvedAt: '',
      inputHash: 'fixture',
      resolutionState: 'incomplete',
    };
    const results = [
      {
        serverName: 'news',
        listDefinitions: [NEWS_LIST],
        resolvedLists: { generatedAt: '', lists: { 'news-sites': entry } },
      },
    ];
    const merged = mergeDynamicLists(results, planListMerge(results), undefined);
    expect(merged.lists?.lists['news-sites'].resolutionState).toBe('incomplete');
    expect(merged.lists?.lists['news-sites'].values).toEqual(entry.values);
  });
});

// ---------------------------------------------------------------------------
// PIP-6: servers that define a list name differently keep separate values
// ---------------------------------------------------------------------------

const PUSH_PROMPT = 'List the company git host we may PUSH to.';
const READ_PROMPT = 'List documentation sites to READ.';
const TWO_SERVER_ANNOTATIONS = annotationsFor({
  alpha: [urlTool('alpha', 'push')],
  zeta: [urlTool('zeta', 'http_fetch')],
});

const isAlpha = (call: FakeLlmCall): boolean => call.system.includes('for the "alpha" server');

const TRUSTED_HOSTS_SCRIPT: FakePhaseScript = {
  compile: [
    (call: FakeLlmCall) =>
      isAlpha(call)
        ? {
            rules: [domainsRule('allow-push-trusted', 'alpha', 'push', 'trusted-hosts')],
            listDefinitions: [domainsList('trusted-hosts', PUSH_PROMPT)],
          }
        : {
            rules: [domainsRule('allow-read-trusted', 'zeta', 'http_fetch', 'trusted-hosts')],
            listDefinitions: [domainsList('trusted-hosts', READ_PROMPT)],
          },
  ],
  listResolution: [
    (call: FakeLlmCall) =>
      call.userText.includes('PUSH')
        ? { values: ['git.corp.example.com'] }
        : { values: ['docs.python.org', 'pages.example.org'] },
  ],
  scenarios: [
    (call: FakeLlmCall) =>
      call.system.includes('alpha/push')
        ? {
            scenarios: [
              urlScenario('alpha', 'push', 'https://git.corp.example.com/repo.git', 'allow'),
              urlScenario('alpha', 'push', 'https://attacker.github.io/x', 'deny'),
            ],
          }
        : {
            scenarios: [
              urlScenario('zeta', 'http_fetch', 'https://docs.python.org/3/', 'allow'),
              urlScenario('zeta', 'http_fetch', 'https://git.corp.example.com/', 'deny'),
            ],
          },
  ],
  judge: [PASS],
};

describe('PIP-6: two servers defining "trusted-hosts" differently', () => {
  it('keeps separate values for each server, each verified against its own list', async () => {
    const outputDir = makeOutputDir();
    const { policy } = await compile(scripted(outputDir, TRUSTED_HOSTS_SCRIPT), outputDir, TWO_SERVER_ANNOTATIONS);

    expect(policy.listDefinitions?.map((d) => [d.name, d.sourceName, d.generationPrompt])).toEqual([
      ['alpha--trusted-hosts', 'trusted-hosts', PUSH_PROMPT],
      ['zeta--trusted-hosts', 'trusted-hosts', READ_PROMPT],
    ]);

    const merged = readJson<DynamicListsFile>(resolve(outputDir, 'dynamic-lists.json'));
    expect(merged.lists['alpha--trusted-hosts'].values).toContain('git.corp.example.com');
    expect(merged.lists['alpha--trusted-hosts'].values).not.toContain('pages.example.org');
    expect(merged.lists['zeta--trusted-hosts'].values).toContain('pages.example.org');
    expect(merged.lists['zeta--trusted-hosts'].values).not.toContain('git.corp.example.com');
    expect(Object.hasOwn(merged.lists, 'trusted-hosts')).toBe(false);

    // The verified behaviour holds in the merged policy, for both servers.
    const at = (server: string, tool: string, url: string) =>
      decide(outputDir, TWO_SERVER_ANNOTATIONS, server, tool, url);
    expect(at('alpha', 'push', 'https://git.corp.example.com/repo.git')).toBe('allow');
    expect(at('alpha', 'push', 'https://attacker.github.io/x')).toBe('deny');
    expect(at('alpha', 'push', 'https://pages.example.org/x')).toBe('deny');
    expect(at('zeta', 'http_fetch', 'https://docs.python.org/3/')).toBe('allow');
    expect(at('zeta', 'http_fetch', 'https://git.corp.example.com/')).toBe('deny');

    // Per-server copies keep the list's own name, which keys their cache.
    const alphaCopy = readJson<DynamicListsFile>(resolve(outputDir, 'servers', 'alpha', 'dynamic-lists.json'));
    expect(Object.keys(alphaCopy.lists)).toEqual(['trusted-hosts']);
    expect(alphaCopy.lists['trusted-hosts'].inputHash).toBe(computeListHash(domainsList('trusted-hosts', PUSH_PROMPT)));
    expect(merged.lists['alpha--trusted-hosts'].inputHash).toBe(alphaCopy.lists['trusted-hosts'].inputHash);
  });

  it('a list that just got kept apart keeps the removals of the list it was, and its additions only for the same definition', async () => {
    const outputDir = makeOutputDir();
    // At first only alpha defines trusted-hosts.
    const alphaOnly = annotationsFor({ alpha: [urlTool('alpha', 'push')] });
    await compile(scripted(outputDir, TRUSTED_HOSTS_SCRIPT), outputDir, alphaOnly);
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    const lists = readJson<DynamicListsFile>(listsPath);
    writeJson(listsPath, {
      ...lists,
      lists: {
        'trusted-hosts': {
          ...lists.lists['trusted-hosts'],
          manualRemovals: ['revoked.corp.example.com'],
          manualAdditions: ['mirror.corp.example.com'],
        },
      },
    });

    // Then zeta defines it differently: both are kept apart.
    const logs: string[] = [];
    await compile(scripted(outputDir, TRUSTED_HOSTS_SCRIPT), outputDir, TWO_SERVER_ANNOTATIONS, {
      onProgress: (message) => logs.push(message),
    });

    const merged = readJson<DynamicListsFile>(listsPath).lists;
    // alpha's list is the same list as before: both overrides follow it.
    expect(merged['alpha--trusted-hosts'].manualRemovals).toEqual(['revoked.corp.example.com']);
    expect(merged['alpha--trusted-hosts'].manualAdditions).toEqual(['mirror.corp.example.com']);
    // zeta's is a different list: the removal follows (restrictive), the addition does not.
    expect(merged['zeta--trusted-hosts'].manualRemovals).toEqual(['revoked.corp.example.com']);
    expect(merged['zeta--trusted-hosts'].manualAdditions).toEqual([]);
    expect(logs.join('\n')).toMatch(
      /Manual additions to @trusted-hosts \(mirror\.corp\.example\.com\) were not carried/,
    );
    expect(Object.hasOwn(merged, 'trusted-hosts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PIP-24: compile-policy --no-mcp
// ---------------------------------------------------------------------------

const MAIL_ANNOTATIONS = annotationsFor({
  mail: [
    {
      serverName: 'mail',
      toolName: 'send_email',
      comment: 'Sends an email.',
      args: { to: ['email-address'] },
      inputSchema: TO_SCHEMA,
    },
  ],
});
const CONTACTS_LIST: ListDefinition = {
  name: 'my-contacts',
  type: 'emails',
  principle: 'p',
  generationPrompt: 'List the email addresses in my contacts.',
  requiresMcp: true,
  mcpServerHint: 'contacts',
};
const MAIL_SCRIPT: FakePhaseScript = {
  compile: [
    {
      rules: [
        rule('allow-email-contacts', 'mail', {
          tool: ['send_email'],
          lists: [{ roles: ['email-address'], allowed: ['@my-contacts'], matchType: 'emails' }],
        }),
      ],
      listDefinitions: [CONTACTS_LIST],
    },
  ],
  scenarios: [
    {
      scenarios: [
        {
          description: 'email a stranger',
          request: { serverName: 'mail', toolName: 'send_email', arguments: { to: 'stranger@evil.example' } },
          expectedDecision: 'deny',
          reasoning: 'r',
        },
      ],
    },
  ],
  judge: [PASS],
};

describe('PIP-24: compile-policy --no-mcp', () => {
  it('leaves a data-backed list unresolved (no values, no valid inputHash) instead of failing the server', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, MAIL_SCRIPT);
    const { policy, reported } = await compile(fake, outputDir, MAIL_ANNOTATIONS, { mcpServers: undefined });

    expect(policy.failedServers).toBeUndefined();
    expect(fake.calls.some((c) => c.phase === 'listResolution')).toBe(false);
    for (const file of [
      resolve(outputDir, 'servers', 'mail', 'dynamic-lists.json'),
      resolve(outputDir, 'dynamic-lists.json'),
    ]) {
      const entry = readJson<DynamicListsFile>(file).lists['my-contacts'];
      expect(entry.values).toEqual([]);
      expect(entry.inputHash).toBe('');
    }
    expect(reported.warnings.join('\n')).toMatch(/@my-contacts needs MCP access and was NOT resolved/);
  });

  it('serves the cached result again without MCP, but resolves and re-verifies once MCP is available', async () => {
    const outputDir = makeOutputDir();
    await compile(scripted(outputDir, MAIL_SCRIPT), outputDir, MAIL_ANNOTATIONS, { mcpServers: undefined });

    // Still no MCP: the cache is fine (nothing better can be done).
    const offline = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    await compile(offline, outputDir, MAIL_ANNOTATIONS, { mcpServers: undefined });
    expect(offline.calls).toEqual([]);

    // With MCP access the empty list must not be served from cache forever:
    // the cached rules are verified again once the list is resolved (here the
    // contacts server is not configured, so resolving it fails the server).
    const online = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    const reported: Reported = { warnings: [] };
    await expect(
      new PipelineRunner(online.models).run(runConfig(outputDir, MAIL_ANNOTATIONS, reported, { mcpServers: {} })),
    ).rejects.toThrow(/failed compilation/);
    expect(reported.warnings.join('\n')).toMatch(
      /re-verifying the cached rules: @my-contacts was left unresolved by a run without MCP access/,
    );
  });

  it('never takes an unresolved entry for a cache hit', async () => {
    const unresolved: DynamicListsFile = {
      generatedAt: '',
      lists: {
        'my-contacts': { values: [], manualAdditions: [], manualRemovals: [], resolvedAt: '', inputHash: '' },
      },
    };
    const model = createThrowingPipelineModels('/dev/null').models.baseLlm;
    await expect(resolveAllLists([CONTACTS_LIST], { model }, unresolved)).rejects.toThrow(/has no MCP access/);
  });

  it('still reuses a valid cached resolution without MCP', async () => {
    const cached: ResolvedList = {
      resolutionState: 'complete',
      values: ['alice@corp.example'],
      manualAdditions: [],
      manualRemovals: [],
      resolvedAt: '2026-01-01T00:00:00.000Z',
      inputHash: computeListHash(CONTACTS_LIST),
    };
    const model = createThrowingPipelineModels('/dev/null').models.baseLlm;
    const result = await resolveAllLists(
      [CONTACTS_LIST],
      { model, leaveMcpListsUnresolved: true },
      { generatedAt: '', lists: { 'my-contacts': cached } },
    );
    expect(result.lists['my-contacts']).toEqual(cached);
  });
});

// ---------------------------------------------------------------------------
// PIP-25: refresh-lists --persona / --job
// ---------------------------------------------------------------------------

const NEWS_RESOLUTION = domainsList('news-sites', 'List news site domains.');
const PUSH_RESOLUTION = domainsList('trusted-hosts', PUSH_PROMPT);
const READ_RESOLUTION = domainsList('trusted-hosts', READ_PROMPT);

/** A merged policy as compile-policy writes it: news-sites shared, trusted-hosts kept apart. */
const MERGED_POLICY: CompiledPolicyFile = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  constitutionHash: 'c',
  inputHash: 'i',
  rules: [
    domainsRule('allow-push-trusted', 'alpha', 'push', 'alpha--trusted-hosts'),
    domainsRule('allow-news', 'news', 'http_fetch', 'news-sites'),
    domainsRule('allow-read-trusted', 'zeta', 'http_fetch', 'zeta--trusted-hosts'),
  ],
  listDefinitions: [
    { ...PUSH_RESOLUTION, name: 'alpha--trusted-hosts', sourceName: 'trusted-hosts' },
    NEWS_RESOLUTION,
    { ...READ_RESOLUTION, name: 'zeta--trusted-hosts', sourceName: 'trusted-hosts' },
  ],
};

function oldEntry(values: string[], definition: ListDefinition, overrides: Partial<ResolvedList> = {}): ResolvedList {
  return {
    values,
    manualAdditions: [],
    manualRemovals: [],
    resolvedAt: '2026-01-01T00:00:00.000Z',
    inputHash: computeListHash(definition),
    ...overrides,
  };
}

/** Writes a compiled policy with its merged lists and per-server copies into `generatedDir`. */
function seedPolicyDir(generatedDir: string): void {
  writeJson(resolve(generatedDir, 'compiled-policy.json'), MERGED_POLICY);
  writeJson(resolve(generatedDir, 'dynamic-lists.json'), {
    generatedAt: '2026-01-01T00:00:00.000Z',
    lists: {
      'alpha--trusted-hosts': oldEntry(['old-git.corp.example.com'], PUSH_RESOLUTION),
      'news-sites': oldEntry(['old-news.example.com', 'bad-news.example.com'], NEWS_RESOLUTION, {
        manualRemovals: ['bad-news.example.com', '*.bad-news.example.com'],
        manualAdditions: ['local-news.example.com'],
      }),
      'zeta--trusted-hosts': oldEntry(['old-docs.example.com'], READ_RESOLUTION),
    },
  });
  writeJson(resolve(generatedDir, 'servers', 'alpha', 'dynamic-lists.json'), {
    generatedAt: '2026-01-01T00:00:00.000Z',
    lists: {
      'trusted-hosts': oldEntry(['old-git.corp.example.com'], PUSH_RESOLUTION),
      'unrelated-list': oldEntry(['keep.example.com'], domainsList('unrelated-list', 'x')),
    },
  });
  writeJson(resolve(generatedDir, 'servers', 'news', 'dynamic-lists.json'), {
    generatedAt: '2026-01-01T00:00:00.000Z',
    lists: { 'news-sites': oldEntry(['old-news.example.com', 'bad-news.example.com'], NEWS_RESOLUTION) },
  });
  // zeta has no per-server directory here: nothing may be created for it.
}

const REFRESH_SCRIPT: FakePhaseScript = {
  listResolution: [
    (call: FakeLlmCall) => {
      if (call.userText.includes('PUSH')) return { values: ['new-git.corp.example.com'] };
      if (call.userText.includes('READ')) return { values: ['new-docs.example.com'] };
      return { values: ['new-news.example.com', 'bad-news.example.com'] };
    },
  ],
};

describe('PIP-25: refresh-lists for a persona or a job', () => {
  let home: string;

  beforeEach(() => {
    home = tempDir('ic-wp62-home-');
    vi.stubEnv('IRONCURTAIN_HOME', home);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  function personaGenerated(name: string): string {
    return resolve(home, 'personas', name, 'generated');
  }

  function seedPersona(name: string): string {
    writeJson(resolve(home, 'personas', name, 'persona.json'), {
      name,
      description: 'test persona',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const dir = personaGenerated(name);
    seedPolicyDir(dir);
    return dir;
  }

  it('refresh-lists --persona updates both the merged file and the per-server copies', async () => {
    const dir = seedPersona('research');
    const fake = createScriptedPipelineModels(REFRESH_SCRIPT, resolve(home, 'llm.jsonl'));
    const previousExitCode = process.exitCode;

    await refreshListsMain(['--persona', 'research'], { model: fake.models.baseLlm });

    expect(process.exitCode).toBe(previousExitCode);
    expect(fake.calls.filter((c) => c.phase === 'listResolution')).toHaveLength(3);

    // Merged file: refreshed values, the user's overrides kept.
    const merged = readJson<DynamicListsFile>(resolve(dir, 'dynamic-lists.json')).lists;
    expect(merged['news-sites'].values).toContain('new-news.example.com');
    expect(merged['news-sites'].values).not.toContain('old-news.example.com');
    expect(merged['news-sites'].manualRemovals).toEqual(['bad-news.example.com', '*.bad-news.example.com']);
    expect(merged['news-sites'].manualAdditions).toEqual(['local-news.example.com']);
    expect(merged['alpha--trusted-hosts'].values).toContain('new-git.corp.example.com');
    expect(merged['zeta--trusted-hosts'].values).toContain('new-docs.example.com');

    // Per-server copies: the refreshed values under the list's own name, with
    // the hash its cache expects and no overrides.
    const alpha = readJson<DynamicListsFile>(resolve(dir, 'servers', 'alpha', 'dynamic-lists.json')).lists;
    expect(alpha['trusted-hosts'].values).toContain('new-git.corp.example.com');
    expect(alpha['trusted-hosts'].inputHash).toBe(computeListHash(PUSH_RESOLUTION));
    expect(alpha['trusted-hosts'].manualAdditions).toEqual([]);
    expect(alpha['unrelated-list'].values).toEqual(['keep.example.com']);
    const news = readJson<DynamicListsFile>(resolve(dir, 'servers', 'news', 'dynamic-lists.json')).lists;
    expect(news['news-sites'].values).toContain('new-news.example.com');
    expect(news['news-sites'].values).toContain('bad-news.example.com');
    expect(news['news-sites'].manualRemovals).toEqual([]);
    expect(existsSync(resolve(dir, 'servers', 'zeta'))).toBe(false);

    // The runtime sees the refresh, with the user's removal still applied.
    const annotations = annotationsFor({
      alpha: [urlTool('alpha', 'push')],
      news: [urlTool('news', 'http_fetch')],
      zeta: [urlTool('zeta', 'http_fetch')],
    });
    expect(decide(dir, annotations, 'news', 'http_fetch', 'https://new-news.example.com/')).toBe('allow');
    expect(decide(dir, annotations, 'news', 'http_fetch', 'https://bad-news.example.com/')).toBe('deny');
    expect(decide(dir, annotations, 'alpha', 'push', 'https://old-git.corp.example.com/')).toBe('deny');
    expect(decide(dir, annotations, 'alpha', 'push', 'https://new-docs.example.com/')).toBe('deny');
  });

  it('--list refreshes one list by its merged name and leaves the others alone', async () => {
    const dir = seedPersona('research');
    const fake = createScriptedPipelineModels(REFRESH_SCRIPT, resolve(home, 'llm.jsonl'));

    const summary = await refreshDynamicLists(
      { target: { kind: 'persona', persona: 'research' }, listName: 'alpha--trusted-hosts', withMcp: false },
      { model: fake.models.baseLlm },
    );

    expect(summary.refreshed).toEqual(['alpha--trusted-hosts']);
    const merged = readJson<DynamicListsFile>(resolve(dir, 'dynamic-lists.json')).lists;
    expect(merged['alpha--trusted-hosts'].values).toContain('new-git.corp.example.com');
    expect(merged['news-sites'].values).toContain('old-news.example.com');
    expect(merged['zeta--trusted-hosts'].values).toEqual(['old-docs.example.com']);
    // Every value the refresh added or removed is reported for review.
    expect(summary.changes).toEqual([
      {
        name: 'alpha--trusted-hosts',
        added: ['new-git.corp.example.com', '*.new-git.corp.example.com'],
        removed: ['old-git.corp.example.com'],
        total: 2,
      },
    ]);
  });

  it('stops before resolving anything when a per-server copy it would update is malformed', async () => {
    const dir = seedPersona('research');
    const copyPath = resolve(dir, 'servers', 'alpha', 'dynamic-lists.json');
    writeJson(copyPath, {
      generatedAt: '',
      lists: { 'trusted-hosts': { values: '*', resolvedAt: '', inputHash: 'h' } },
    });
    const copyBefore = readFileSync(copyPath, 'utf-8');
    const mergedBefore = readFileSync(resolve(dir, 'dynamic-lists.json'), 'utf-8');
    const throwing = createThrowingPipelineModels(resolve(home, 'llm.jsonl'));

    await expect(
      refreshDynamicLists(
        { target: { kind: 'persona', persona: 'research' }, withMcp: false },
        { model: throwing.models.baseLlm },
      ),
    ).rejects.toMatchObject({
      code: 'POLICY_ARTIFACT_INVALID',
      message: expect.stringContaining('lists.trusted-hosts.values: expected an array') as unknown,
    });
    expect(throwing.calls).toEqual([]);
    expect(readFileSync(copyPath, 'utf-8')).toBe(copyBefore);
    expect(readFileSync(resolve(dir, 'dynamic-lists.json'), 'utf-8')).toBe(mergedBefore);
  });

  it('refreshes a job policy with --job, and points a persona-backed job at its persona', async () => {
    const jobDir = resolve(home, 'jobs', 'nightly');
    writeJobJson(jobDir, 'nightly', { name: 'Nightly' });
    seedPolicyDir(resolve(jobDir, 'generated'));
    writeJobJson(resolve(home, 'jobs', 'with-persona'), 'with-persona', { persona: 'research' });
    const fake = createScriptedPipelineModels(REFRESH_SCRIPT, resolve(home, 'llm.jsonl'));

    const summary = await refreshDynamicLists(
      { target: { kind: 'job', jobId: 'nightly' }, withMcp: false },
      { model: fake.models.baseLlm },
    );
    expect(summary.outputDir).toBe(resolve(jobDir, 'generated'));
    expect(
      readJson<DynamicListsFile>(resolve(jobDir, 'generated', 'servers', 'news', 'dynamic-lists.json')).lists[
        'news-sites'
      ].values,
    ).toContain('new-news.example.com');

    await expect(
      refreshDynamicLists(
        { target: { kind: 'job', jobId: 'with-persona' }, withMcp: false },
        { model: fake.models.baseLlm },
      ),
    ).rejects.toThrow(/--persona "research"/);
  });

  it('refuses a job whose persona field is empty, as the daemon does: its job.json is invalid', async () => {
    const jobDir = resolve(home, 'jobs', 'no-persona');
    // A job names a persona or has no persona field. The job store reports any
    // other value as an invalid job.json, so the daemon neither schedules nor
    // runs the job, and no policy of it is refreshed either.
    writeJobJson(jobDir, 'no-persona', { name: 'N', persona: null });
    seedPolicyDir(resolve(jobDir, 'generated'));
    const listsBefore = readFileSync(resolve(jobDir, 'generated', 'dynamic-lists.json'), 'utf-8');
    const throwing = createThrowingPipelineModels(resolve(home, 'llm.jsonl'));

    await expect(
      refreshDynamicLists(
        { target: { kind: 'job', jobId: 'no-persona' }, listName: 'news-sites', withMcp: false },
        { model: throwing.models.baseLlm },
      ),
    ).rejects.toMatchObject({ code: 'JOB_INVALID', message: expect.stringContaining('persona') as unknown });
    expect(throwing.calls).toEqual([]);
    expect(readFileSync(resolve(jobDir, 'generated', 'dynamic-lists.json'), 'utf-8')).toBe(listsBefore);
  });

  it('rejects an invalid or unknown persona, an unknown list, and --persona with --job', async () => {
    const model = createThrowingPipelineModels(resolve(home, 'llm.jsonl')).models.baseLlm;
    await expect(
      refreshDynamicLists({ target: { kind: 'persona', persona: '../evil' }, withMcp: false }, { model }),
    ).rejects.toThrow();
    await expect(
      refreshDynamicLists({ target: { kind: 'persona', persona: 'missing' }, withMcp: false }, { model }),
    ).rejects.toThrow(/not found/);
    // An unknown job is JOB_NOT_FOUND, which the web UI reports as such.
    await expect(
      refreshDynamicLists({ target: { kind: 'job', jobId: 'missing' }, withMcp: false }, { model }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    seedPersona('research');
    await expect(
      refreshDynamicLists(
        { target: { kind: 'persona', persona: 'research' }, listName: 'nope', withMcp: false },
        { model },
      ),
    ).rejects.toThrow(/List "nope" not found/);

    const previousExitCode = process.exitCode;
    try {
      expect(parseRefreshArgs(['--persona', 'a', '--job', 'b'])).toBeNull();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(parseRefreshArgs(['--job', 'nightly', '--no-mcp'])).toEqual({
      target: { kind: 'job', jobId: 'nightly' },
      listName: undefined,
      withMcp: false,
    });
  });

  it('skips data-backed lists with --no-mcp and leaves their entries alone', async () => {
    const dir = seedPersona('mailer');
    const policy: CompiledPolicyFile = {
      ...MERGED_POLICY,
      rules: [
        rule('allow-email-contacts', 'mail', {
          tool: ['send_email'],
          lists: [{ roles: ['email-address'], allowed: ['@my-contacts'], matchType: 'emails' }],
        }),
      ],
      listDefinitions: [CONTACTS_LIST],
    };
    writeJson(resolve(dir, 'compiled-policy.json'), policy);
    const before = readJson<DynamicListsFile>(resolve(dir, 'dynamic-lists.json'));
    const model = createThrowingPipelineModels(resolve(home, 'llm.jsonl')).models.baseLlm;

    const summary = await refreshDynamicLists(
      { target: { kind: 'persona', persona: 'mailer' }, withMcp: false },
      { model },
    );
    expect(summary.skipped).toEqual(['my-contacts']);
    expect(summary.refreshed).toEqual([]);
    expect(readJson<DynamicListsFile>(resolve(dir, 'dynamic-lists.json'))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// GAP3-12: lists at runtime
// ---------------------------------------------------------------------------

describe('GAP3-12: loading a policy with its lists', () => {
  let home: string;

  beforeEach(() => {
    home = tempDir('ic-wp62-runtime-');
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  const packageDir = getPackageGeneratedDir();
  const shipped = readJson<DynamicListsFile>(resolve(packageDir, 'dynamic-lists.json'));
  const fetchCall = (url: string) => ({
    requestId: 't',
    serverName: 'fetch',
    toolName: 'http_fetch',
    arguments: { url },
    timestamp: '',
  });

  function loadShipped() {
    return loadGeneratedPolicy({ policyDir: packageDir, toolAnnotationsDir: packageDir, fallbackDir: packageDir });
  }

  function engineFor(loaded: ReturnType<typeof loadShipped>): PolicyEngine {
    return new PolicyEngine(
      loaded.compiledPolicy,
      loaded.toolAnnotations,
      [],
      undefined,
      undefined,
      loaded.dynamicLists,
    );
  }

  /** Captures the session-log warnings emitted while `fn` runs. */
  function withLogWarnings<T>(fn: () => T): { result: T; log: string } {
    const logPath = resolve(home, 'session.log');
    logger.setup({ logFilePath: logPath });
    try {
      const result = fn();
      return { result, log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '' };
    } finally {
      logger.teardown();
    }
  }

  it('the shipped policy loads with the shipped lists (news sites are allowed, others escalate)', () => {
    const engine = engineFor(loadShipped());
    expect(engine.evaluate(fetchCall('https://www.nytimes.com/section')).decision).toBe('allow');
    expect(engine.evaluate(fetchCall('https://refreshed-news.example.com/')).decision).toBe('escalate');
  });

  it('uses user-refreshed lists over the shipped policy, with the user overrides', () => {
    const news = shipped.lists['popular-news-sites'];
    writeJson(resolve(home, 'generated', 'dynamic-lists.json'), {
      generatedAt: '2026-11-01T00:00:00.000Z',
      lists: {
        'popular-news-sites': {
          ...news,
          values: ['refreshed-news.example.com', 'nytimes.com'],
          manualRemovals: ['nytimes.com'],
        },
      },
    });

    const loaded = loadShipped();
    const engine = engineFor(loaded);
    expect(engine.evaluate(fetchCall('https://refreshed-news.example.com/')).decision).toBe('allow');
    expect(engine.evaluate(fetchCall('https://nytimes.com/')).decision).toBe('escalate');
    // Lists the user file does not have come from the package.
    expect(engine.evaluate(fetchCall('https://github.com/x')).decision).toBe('allow');

    // A workflow state that swaps to the global policy sees the same lists.
    expect(loadPersonaPolicyArtifacts(packageDir).dynamicLists).toEqual(loaded.dynamicLists);
  });

  it('refresh-lists for the shipped policy writes only the refreshed list to the user dir, and the runtime uses it', async () => {
    const shippedBefore = readFileSync(resolve(packageDir, 'dynamic-lists.json'), 'utf-8');
    const fake = createScriptedPipelineModels(
      { listResolution: [{ values: ['fresh-news.example.com'] }] },
      resolve(home, 'llm.jsonl'),
    );

    const summary = await refreshDynamicLists(
      { target: { kind: 'global' }, listName: 'popular-news-sites', withMcp: false },
      { model: fake.models.baseLlm },
    );

    expect(summary.policyDir).toBe(packageDir);
    expect(summary.outputDir).toBe(resolve(home, 'generated'));
    expect(summary.perServerFiles).toEqual([]);
    expect(readFileSync(resolve(packageDir, 'dynamic-lists.json'), 'utf-8')).toBe(shippedBefore);
    const user = readJson<DynamicListsFile>(resolve(home, 'generated', 'dynamic-lists.json'));
    // Only the user's own entry: shipped lists are never copied, so a package
    // update of them still applies.
    expect(Object.keys(user.lists)).toEqual(['popular-news-sites']);
    expect(user.lists['popular-news-sites'].inputHash).toBe(shipped.lists['popular-news-sites'].inputHash);
    // The changes are reported against the shipped values the policy ran with.
    expect(summary.changes.map((change) => change.name)).toEqual(['popular-news-sites']);
    expect(summary.changes[0].added).toEqual(['fresh-news.example.com', '*.fresh-news.example.com']);
    expect(summary.changes[0].removed).toContain('nytimes.com');

    const engine = engineFor(loadShipped());
    expect(engine.evaluate(fetchCall('https://fresh-news.example.com/')).decision).toBe('allow');
    expect(engine.evaluate(fetchCall('https://www.nytimes.com/')).decision).toBe('escalate');
    expect(engine.evaluate(fetchCall('https://github.com/x')).decision).toBe('allow');
  });

  it('ignores user values resolved for another definition but keeps the user overrides, and warns', () => {
    const news = shipped.lists['popular-news-sites'];
    writeJson(resolve(home, 'generated', 'dynamic-lists.json'), {
      generatedAt: '2026-11-01T00:00:00.000Z',
      lists: {
        'popular-news-sites': {
          ...news,
          inputHash: 'resolved-for-an-older-definition',
          values: ['stale-news.example.com'],
          manualRemovals: ['nytimes.com', '*.nytimes.com'],
        },
      },
    });

    const { result: loaded, log } = withLogWarnings(() => loadShipped());
    const engine = engineFor(loaded);
    expect(engine.evaluate(fetchCall('https://stale-news.example.com/')).decision).toBe('escalate');
    expect(engine.evaluate(fetchCall('https://www.bbc.com/news')).decision).toBe('allow');
    expect(engine.evaluate(fetchCall('https://nytimes.com/')).decision).toBe('escalate');
    expect(log).toMatch(/popular-news-sites.*different definition/);
  });

  it('reads a locally compiled policy with its own lists only, and warns when they are missing', () => {
    const userDir = resolve(home, 'generated');
    const policy: CompiledPolicyFile = {
      generatedAt: '',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [domainsRule('allow-news', 'fetch', 'http_fetch', 'popular-news-sites')],
      listDefinitions: [domainsList('popular-news-sites', 'my own definition')],
    };
    writeJson(resolve(userDir, 'compiled-policy.json'), policy);

    // The package's lists file must not stand in for the user's.
    const { result: loaded, log } = withLogWarnings(() =>
      loadGeneratedPolicy({ policyDir: userDir, toolAnnotationsDir: packageDir, fallbackDir: packageDir }),
    );
    expect(loaded.dynamicLists).toBeUndefined();
    expect(findMissingDynamicLists(loaded.compiledPolicy, loaded.dynamicLists)).toEqual(['popular-news-sites']);
    expect(log).toMatch(/defines dynamic list\(s\) @popular-news-sites but has no dynamic-lists\.json/);
    expect(engineFor(loaded).evaluate(fetchCall('https://www.nytimes.com/')).decision).toBe('deny');
  });

  it('ironcurtain doctor reports lists the policy uses that have no values', () => {
    const userDir = resolve(home, 'generated');
    writeJson(resolve(userDir, 'compiled-policy.json'), {
      generatedAt: '',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [domainsRule('allow-news', 'fetch', 'http_fetch', 'popular-news-sites')],
      listDefinitions: [domainsList('popular-news-sites', 'my own definition')],
    } satisfies CompiledPolicyFile);
    const config = { generatedDir: userDir, toolAnnotationsDir: packageDir } as IronCurtainConfig;

    const missing = checkPolicyArtifacts(config).results;
    expect(missing.map((r) => [r.name, r.status])).toEqual([
      ['Policy artifacts', 'ok'],
      ['Dynamic lists', 'warn'],
    ]);
    expect(missing[1].message).toContain('@popular-news-sites');
    expect(missing[1].hint).toContain('refresh-lists');

    writeJson(resolve(userDir, 'dynamic-lists.json'), {
      generatedAt: '',
      lists: { 'popular-news-sites': shipped.lists['popular-news-sites'] },
    });
    expect(checkPolicyArtifacts(config).results.map((r) => r.name)).toEqual(['Policy artifacts']);
  });

  it('a newer shipped resolution supersedes an older user refresh of the same definition; overrides still apply', () => {
    const news = shipped.lists['popular-news-sites'];
    writeJson(resolve(home, 'generated', 'dynamic-lists.json'), {
      generatedAt: '2026-01-01T00:00:00.000Z',
      lists: {
        'popular-news-sites': {
          ...news,
          // Same definition, but resolved before the shipped lists were.
          resolvedAt: '2026-01-01T00:00:00.000Z',
          values: ['old-refresh.example.com'],
          manualRemovals: ['nytimes.com', '*.nytimes.com'],
        },
      },
    });

    const { result: loaded, log } = withLogWarnings(() => loadShipped());
    const engine = engineFor(loaded);
    expect(engine.evaluate(fetchCall('https://old-refresh.example.com/')).decision).toBe('escalate');
    expect(engine.evaluate(fetchCall('https://www.bbc.com/news')).decision).toBe('allow');
    expect(engine.evaluate(fetchCall('https://nytimes.com/')).decision).toBe('escalate');
    expect(log).toMatch(/popular-news-sites.*older than the one shipped/);

    const layered = layerUserDynamicLists(shipped, {
      generatedAt: '',
      lists: { 'popular-news-sites': { ...news, resolvedAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect(layered.superseded).toEqual(['popular-news-sites']);
    expect(layered.stale).toEqual([]);
  });

  it('fails the load when a hand-edited override is not an array of strings, rather than spreading it', () => {
    const news = shipped.lists['popular-news-sites'];
    // A string where an array belongs: spread into characters, "*.example"
    // would have added "*", which matches every domain.
    writeJson(resolve(home, 'generated', 'dynamic-lists.json'), {
      generatedAt: '',
      lists: { 'popular-news-sites': { ...news, manualAdditions: '*.example' } },
    });
    expect(() => loadShipped()).toThrow(/lists\.popular-news-sites\.manualAdditions: expected an array/);

    // The same for a policy's own lists file (persona, job, local compile)...
    const dir = resolve(home, 'personas', 'p', 'generated');
    writeJson(resolve(dir, 'compiled-policy.json'), {
      generatedAt: '',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [domainsRule('allow-news', 'fetch', 'http_fetch', 'news')],
      listDefinitions: [domainsList('news', 'p')],
    } satisfies CompiledPolicyFile);
    writeJson(resolve(dir, 'dynamic-lists.json'), {
      generatedAt: '',
      lists: { news: { values: ['a.example.com'], manualRemovals: 'a.example.com' } },
    });
    expect(() => loadPersonaPolicyArtifacts(dir)).toThrow(/lists\.news\.manualRemovals: expected an array/);

    // ...and missing override arrays still default to empty (the schema
    // requires `values`, `resolvedAt` and `inputHash`).
    writeJson(resolve(dir, 'dynamic-lists.json'), {
      generatedAt: '',
      lists: { news: { values: ['a.example.com'], resolvedAt: '', inputHash: '' } },
    });
    expect(loadPersonaPolicyArtifacts(dir).dynamicLists?.lists.news).toEqual({
      values: ['a.example.com'],
      manualAdditions: [],
      manualRemovals: [],
      resolvedAt: '',
      inputHash: '',
    });
  });

  it('without any lists file, a @list reference allows nothing: an argument spelled "@list" does not match it', () => {
    const dir = resolve(home, 'generated');
    writeJson(resolve(dir, 'compiled-policy.json'), {
      generatedAt: '',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [
        rule('allow-mail-contacts', 'mail', {
          tool: ['send_email'],
          lists: [{ roles: ['email-address'], allowed: ['@my-contacts'], matchType: 'emails' }],
        }),
      ],
      listDefinitions: [CONTACTS_LIST],
    } satisfies CompiledPolicyFile);

    const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(dir);
    expect(dynamicLists).toBeUndefined();
    const engine = new PolicyEngine(compiledPolicy, MAIL_ANNOTATIONS, [], undefined, undefined, dynamicLists);
    for (const to of ['@my-contacts', '@MY-CONTACTS', 'alice@corp.example']) {
      const request = { requestId: 't', serverName: 'mail', toolName: 'send_email', arguments: { to }, timestamp: '' };
      expect(engine.evaluate(request).decision, to).toBe('deny');
    }
  });

  it('layerUserDynamicLists keeps shipped lists the user file lacks and adds lists only the user has', () => {
    const entry = (values: string[], inputHash: string): ResolvedList => ({
      values,
      manualAdditions: [],
      manualRemovals: [],
      resolvedAt: '',
      inputHash,
    });
    const { lists, stale } = layerUserDynamicLists(
      { generatedAt: '', lists: { a: entry(['a1'], 'ha'), b: entry(['b1'], 'hb') } },
      { generatedAt: 'u', lists: { b: entry(['b2'], 'hb'), c: entry(['c2'], 'hc') } },
    );
    expect(stale).toEqual([]);
    expect(Object.fromEntries(Object.entries(lists.lists).map(([name, l]) => [name, l.values]))).toEqual({
      a: ['a1'],
      b: ['b2'],
      c: ['c2'],
    });
  });
});
