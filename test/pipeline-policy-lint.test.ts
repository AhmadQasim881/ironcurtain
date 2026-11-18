/**
 * WP-59: the policy lint and rule checks at the PipelineRunner's choke points.
 *
 *  - PIP-5: a compile whose LLM emits a server-wide allow is sent back for a
 *    repair turn, and the server fails with the lint error when the compiler
 *    cannot fix it. Cached rules that fail the checks are recompiled; a repair
 *    that fails them is dropped in favour of the last valid rules; the merged
 *    policy is checked before it is written.
 *  - PIP-14: wording that merely mentions a structural invariant no longer
 *    drops a server.
 *
 * Every test drives the REAL PipelineRunner with scripted fake LLMs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import { computeServerRulesHash } from '../src/pipeline/server-artifacts.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  FailedServer,
  ListDefinition,
  ServerCompiledPolicyFile,
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
import {
  annotationsFor,
  CONSTITUTION,
  FS_ONLY,
  FS_SCENARIOS,
  FS_TOOLS,
  GOOD_FS,
  NEWS,
  NEWS_SCENARIOS,
  NEWS_TOOLS,
  PASS,
  REJECT_FS,
  SANDBOX,
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
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp59-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

interface RunOutcome {
  readonly policy?: CompiledPolicyFile;
  readonly error?: unknown;
  readonly warnings: string[];
}

async function run(
  fake: ScriptedPipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
): Promise<RunOutcome> {
  const warnings: string[] = [];
  const reporter: ServerProgressReporter = {
    update: () => {},
    complete: () => {},
    warn: (msg) => warnings.push(msg),
    fail: () => {},
    done: () => {},
  };
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
    reporterFactory: () => reporter,
    ...overrides,
  };
  try {
    return { policy: await new PipelineRunner(fake.models).run(config), warnings };
  } catch (error) {
    return { error, warnings };
  }
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
}

function callsOf(fake: ScriptedPipelineModels, phase: FakeLlmCall['phase']): FakeLlmCall[] {
  return fake.calls.filter((c) => c.phase === phase);
}

function ruleNames(policy: { rules: Array<{ name: string }> } | undefined): string[] {
  return (policy?.rules ?? []).map((r) => r.name);
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function failedServersOf(err: unknown): readonly FailedServer[] | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { failedServers?: readonly FailedServer[] }).failedServers
    : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-side typing for JSON artifacts
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/** An allow that matches every tool of `fs` (the PIP-5 repro). */
const SERVER_WIDE_FS = { rules: [rule('allow-all-fs', 'fs', {})] };

// ---------------------------------------------------------------------------
// PIP-5: the initial compile
// ---------------------------------------------------------------------------

describe('a server-wide allow from the compiler (PIP-5)', () => {
  it('is sent back with the lint error and the repaired rules are used', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [SERVER_WIDE_FS],
      validationRepair: [GOOD_FS],
      scenarios: [FS_SCENARIOS],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, FS_ONLY);

    expect(result.error).toBeUndefined();
    expect(ruleNames(result.policy)).toEqual(['allow-fs-reads']);
    const [repairCall] = callsOf(fake, 'validationRepair');
    expect(repairCall.userText).toContain('## RULE VALIDATION REPAIR (attempt 1)');
    expect(repairCall.userText).toContain('Rule "allow-all-fs" allows every tool of server(s) "fs"');
    // The delete_file role is reported too: the rule allows deleting anywhere.
    expect(repairCall.userText).toContain('delete-path');
    expect(result.warnings.some((w) => w.includes('asking the compiler to fix them'))).toBe(true);
    const committed = readJson<ServerCompiledPolicyFile>(resolve(outputDir, 'servers', 'fs', 'compiled-policy.json'));
    expect(ruleNames(committed)).toEqual(['allow-fs-reads']);
  });

  it('fails the server with the lint error when the compiler cannot fix it', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, { compile: [SERVER_WIDE_FS], validationRepair: [SERVER_WIDE_FS] });

    const result = await run(fake, outputDir, FS_ONLY);

    expect(errorCode(result.error)).toBe('ALL_SERVERS_FAILED');
    const [failure] = failedServersOf(result.error) ?? [];
    expect(failure.serverName).toBe('fs');
    expect(failure.phase).toBe('compiling');
    expect(failure.reason).toContain('failed the rule checks');
    expect(failure.reason).toContain('allows every tool of server(s) "fs"');
    // The bounded reason is backed by every error in the progress output.
    expect(result.warnings.some((w) => w.includes('Rule check failed:') && w.includes('"allow-all-fs"'))).toBe(true);
    // Two repair turns, then nothing was tested or written.
    expect(callsOf(fake, 'validationRepair')).toHaveLength(2);
    expect(callsOf(fake, 'scenarios')).toHaveLength(0);
    expect(existsSync(resolve(outputDir, 'compiled-policy.json'))).toBe(false);
    expect(existsSync(resolve(outputDir, 'servers', 'fs', 'compiled-policy.json'))).toBe(false);
  });

  // PIP-14: semantic errors reach the compiler. Resolving paths first used to
  // turn a relative paths.within into a directory under the compile's cwd.
  it('sends a relative paths.within back for repair instead of resolving it under the working directory', async () => {
    const outputDir = makeOutputDir();
    const relative = {
      rules: [rule('allow-fs-reads', 'fs', { tool: ['read_file'], paths: { roles: ['read-path'], within: 'etc' } })],
    };
    const fake = scripted(outputDir, {
      compile: [relative],
      validationRepair: [GOOD_FS],
      scenarios: [FS_SCENARIOS],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, FS_ONLY);

    expect(result.error).toBeUndefined();
    const [repairCall] = callsOf(fake, 'validationRepair');
    expect(repairCall.userText).toContain('paths.within must be an absolute path');
    // The rejected rules are shown as the compiler wrote them.
    expect(repairCall.userText).toContain('"within": "etc"');
    const committed = readJson<ServerCompiledPolicyFile>(resolve(outputDir, 'servers', 'fs', 'compiled-policy.json'));
    expect(committed.rules.map((r) => r.if.paths?.within)).toEqual(['/etc']);
  });

  it('leaves the other servers compiled and records the failure', async () => {
    const outputDir = makeOutputDir();
    const newsAllow = {
      rules: [
        rule('allow-news', 'news', {
          tool: ['http_fetch'],
          domains: { roles: ['fetch-url'], allowed: ['news.example.com'] },
        }),
      ],
    };
    const isFs = (call: FakeLlmCall) => call.system.includes('for the "fs" server');
    const fake = scripted(outputDir, {
      compile: [(call: FakeLlmCall) => (isFs(call) ? SERVER_WIDE_FS : newsAllow)],
      validationRepair: [SERVER_WIDE_FS],
      scenarios: [NEWS_SCENARIOS],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, annotationsFor({ fs: FS_TOOLS, news: NEWS_TOOLS }));

    expect(result.error).toBeUndefined();
    expect(ruleNames(result.policy)).toEqual(['allow-news']);
    expect(result.policy?.failedServers).toEqual([
      expect.objectContaining({
        serverName: 'fs',
        phase: 'compiling',
        reason: expect.stringContaining('allow-all-fs'),
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// PIP-14: wording is not a reason to drop a server
// ---------------------------------------------------------------------------

describe('rules whose names mention protected things (PIP-14)', () => {
  const SHEET_SCHEMA = {
    type: 'object',
    properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } },
    required: ['spreadsheetId'],
  };
  const SHEETS_TOOLS: StoredToolAnnotation[] = [
    {
      serverName: 'google-workspace',
      toolName: 'gsheets_read',
      comment: 'Reads cells.',
      args: { spreadsheetId: ['none'], range: ['none'] },
      inputSchema: SHEET_SCHEMA,
    },
    {
      serverName: 'google-workspace',
      toolName: 'gsheets_add_protected_range',
      comment: 'Protects a range.',
      args: { spreadsheetId: ['none'], range: ['none'] },
      inputSchema: SHEET_SCHEMA,
    },
  ];
  const gw = (name: string, tool: string, then: 'allow' | 'escalate', description: string) => ({
    ...rule(name, 'google-workspace', { tool: [tool] }, then),
    description,
  });

  it('a rule named protect-config no longer drops google-workspace', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            gw('allow-gsheets-read', 'gsheets_read', 'allow', 'Reading sheets is safe.'),
            gw(
              'protect-config',
              'gsheets_add_protected_range',
              'escalate',
              'Writing to a protected path is denied by the engine; protected ranges need approval.',
            ),
            gw(
              'escalate-gsheets-protected-range-changes',
              'gsheets_add_protected_range',
              'escalate',
              'Protected range changes need approval.',
            ),
          ],
        },
      ],
      scenarios: [
        {
          scenarios: [
            {
              description: 'read a sheet',
              request: { serverName: 'google-workspace', toolName: 'gsheets_read', arguments: { spreadsheetId: 's' } },
              expectedDecision: 'allow',
              reasoning: 'Reading is safe.',
            },
            {
              description: 'protect a range',
              request: {
                serverName: 'google-workspace',
                toolName: 'gsheets_add_protected_range',
                arguments: { spreadsheetId: 's', range: 'A1:B2' },
              },
              expectedDecision: 'escalate',
              reasoning: 'Edits need approval.',
            },
          ],
        },
      ],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, annotationsFor({ 'google-workspace': SHEETS_TOOLS }));

    expect(result.error).toBeUndefined();
    expect(result.policy?.failedServers).toBeUndefined();
    expect(ruleNames(result.policy)).toEqual([
      'allow-gsheets-read',
      'protect-config',
      'escalate-gsheets-protected-range-changes',
    ]);
    expect(callsOf(fake, 'validationRepair')).toHaveLength(0);
    // Reported as a warning, not an error.
    expect(result.warnings.some((w) => w.includes('mentions a structural invariant'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache hits, repairs and the merged policy
// ---------------------------------------------------------------------------

describe('rules that fail the checks are never served or adopted', () => {
  it('recompiles verified cached rules that fail the current checks', async () => {
    const outputDir = makeOutputDir();
    const first = await run(
      scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] }),
      outputDir,
      FS_ONLY,
    );
    expect(first.error).toBeUndefined();

    // Rules verified under weaker checks (an older version), still marked
    // verified: the commit's rulesHash matches them, so only the rule checks
    // can refuse to serve them.
    const path = resolve(outputDir, 'servers', 'fs', 'compiled-policy.json');
    const committed = readJson<ServerCompiledPolicyFile>(path);
    const rules = [...committed.rules, ...SERVER_WIDE_FS.rules];
    writeFileSync(
      path,
      JSON.stringify({ ...committed, rules, rulesHash: computeServerRulesHash(rules, committed.listDefinitions) }),
    );

    const down = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    const rerun = await run(down, outputDir, FS_ONLY);

    expect(callsOf(down, 'compile').length).toBeGreaterThan(0);
    expect(rerun.policy).toBeUndefined();
    expect(rerun.warnings.some((w) => w.includes('cached rules fail the rule checks'))).toBe(true);
  });

  it('keeps the last valid rules when a repair fails the checks, and repairs again', async () => {
    const outputDir = makeOutputDir();
    const escalatingScenarios = {
      scenarios: [
        FS_SCENARIOS.scenarios[0],
        { ...FS_SCENARIOS.scenarios[1], expectedDecision: 'escalate', reasoning: 'Deletes need approval.' },
      ],
    };
    const reject = {
      ...REJECT_FS,
      analysis: 'FAIL: deletes must escalate.',
      failureAttributions: [
        {
          scenarioIndex: 2,
          scenarioDescription: 'delete a file outside the sandbox',
          blame: { kind: 'rule', reasoning: 'Missing escalate rule.' },
        },
      ],
    };
    const badPatch = {
      reasoning: 'Allow everything.',
      operations: [{ op: 'add', rule: rule('allow-everything', 'fs', {}) }],
    };
    const goodPatch = {
      reasoning: 'Deletes need approval.',
      operations: [{ op: 'add', rule: rule('escalate-fs-deletes', 'fs', { tool: ['delete_file'] }, 'escalate') }],
    };
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [escalatingScenarios],
      judge: [reject, PASS],
      repair: [badPatch, goodPatch],
      validationRepair: [{ rules: [...GOOD_FS.rules, rule('allow-everything', 'fs', {})] }],
    });

    const result = await run(fake, outputDir, FS_ONLY);

    expect(result.error).toBeUndefined();
    expect(ruleNames(result.policy).sort()).toEqual(['allow-fs-reads', 'escalate-fs-deletes']);
    expect(callsOf(fake, 'repair')).toHaveLength(2);
    expect(callsOf(fake, 'validationRepair')).toHaveLength(2);
    // After a point-fix the compiler's last answer is a patch, so the
    // validation turn carries the patched rule set it rejected.
    const [firstFix] = callsOf(fake, 'validationRepair');
    expect(firstFix.userText).toContain('### Rejected rule set');
    expect(firstFix.userText).toContain('"name": "allow-fs-reads"');
    expect(firstFix.userText).toContain('"name": "allow-everything"');
    expect(firstFix.userText).toContain('not a patch');
    // The rejected candidate was never verified: initial verify + the good repair.
    expect(callsOf(fake, 'judge')).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('keeping the previous rules'))).toBe(true);
  });

  it('names the rejected repair in the failure when the repairs never pass', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [GOOD_FS],
      scenarios: [
        {
          scenarios: [
            FS_SCENARIOS.scenarios[0],
            { ...FS_SCENARIOS.scenarios[1], expectedDecision: 'escalate', reasoning: 'Deletes need approval.' },
          ],
        },
      ],
      judge: [REJECT_FS],
      repair: [
        { reasoning: 'Allow everything.', operations: [{ op: 'add', rule: rule('allow-everything', 'fs', {}) }] },
      ],
      validationRepair: [{ rules: [rule('allow-everything', 'fs', {})] }],
    });

    const result = await run(fake, outputDir, FS_ONLY);

    const [failure] = failedServersOf(result.error) ?? [];
    expect(failure.phase).toBe('verifying');
    expect(failure.reason).toContain('The last rejected repair failed the rule checks');
    expect(failure.reason).toContain('allow-everything');
  });
});

// ---------------------------------------------------------------------------
// Dynamic list values
// ---------------------------------------------------------------------------

describe('dynamic list values count', () => {
  const SITES: ListDefinition = {
    name: 'sites',
    type: 'domains',
    principle: 'News may be read.',
    generationPrompt: 'List news sites.',
    requiresMcp: false,
  };
  const SITES_SCENARIOS = NEWS_SCENARIOS;

  /** Seeds a server's lists file with the user's manual additions (kept across resolutions). */
  function seedManualAddition(outputDir: string, server: string, value: string): void {
    const dir = resolve(outputDir, 'servers', server);
    mkdirSync(dir, { recursive: true });
    const lists: DynamicListsFile = {
      generatedAt: '',
      lists: {
        sites: { values: [], manualAdditions: [value], manualRemovals: [], resolvedAt: '', inputHash: 'stale' },
      },
    };
    writeFileSync(resolve(dir, 'dynamic-lists.json'), JSON.stringify(lists));
  }

  const newsListRule = (then: 'allow' | 'escalate') => ({
    rules: [
      rule(
        'news-sites',
        'news',
        { tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed: ['@sites'] } },
        then,
      ),
    ],
    listDefinitions: [SITES],
  });

  it('fails a server whose allow reaches a broad manual list addition', async () => {
    const outputDir = makeOutputDir();
    seedManualAddition(outputDir, 'news', '*.github.io');
    const fake = scripted(outputDir, {
      compile: [newsListRule('allow')],
      listResolution: [{ values: ['news.example.com'] }],
    });

    const result = await run(fake, outputDir, annotationsFor({ news: NEWS_TOOLS }));

    const [failure] = failedServersOf(result.error) ?? [];
    expect(failure.serverName).toBe('news');
    expect(failure.phase).toBe('lists');
    expect(failure.reason).toContain('"*.github.io" (via @sites)');
    expect(callsOf(fake, 'scenarios')).toHaveLength(0);
  });

  it('accepts it with the broad-domains opt-in', async () => {
    const outputDir = makeOutputDir();
    seedManualAddition(outputDir, 'news', '*.github.io');
    const fake = scripted(outputDir, {
      compile: [newsListRule('allow')],
      listResolution: [{ values: ['news.example.com'] }],
      scenarios: [SITES_SCENARIOS],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, annotationsFor({ news: NEWS_TOOLS }), { allowBroadDomains: true });

    expect(result.error).toBeUndefined();
    expect(ruleNames(result.policy)).toEqual(['news-sites']);
  });

  it('recompiles cached rules that fail the checks once the lists their re-verification resolves are in', async () => {
    const outputDir = makeOutputDir();
    const EXTRA: ListDefinition = { ...SITES, name: 'extra', generationPrompt: 'List extra sites.' };
    const twoLists = {
      rules: [
        rule('news-lists', 'news', {
          tool: ['http_fetch'],
          domains: { roles: ['fetch-url'], allowed: ['@sites', '@extra'] },
        }),
      ],
      listDefinitions: [SITES, EXTRA],
    };
    const listResolution = [
      (call: FakeLlmCall) =>
        call.userText.includes('List extra sites.')
          ? { values: ['extra.example.com'] }
          : { values: ['news.example.com'] },
    ];
    const news = annotationsFor({ news: NEWS_TOOLS });
    const first = await run(
      scripted(outputDir, { compile: [twoLists], listResolution, scenarios: [NEWS_SCENARIOS], judge: [PASS] }),
      outputDir,
      news,
    );
    expect(first.error).toBeUndefined();

    // The cached @extra entry is gone (so the commit is re-verified, not
    // served) and the user has since added a broad value to @sites.
    const listsPath = resolve(outputDir, 'servers', 'news', 'dynamic-lists.json');
    const cachedLists = readJson<DynamicListsFile>(listsPath);
    const { sites } = cachedLists.lists;
    writeFileSync(
      listsPath,
      JSON.stringify({ ...cachedLists, lists: { sites: { ...sites, manualAdditions: ['*.github.io'] } } }),
    );

    const fake = scripted(outputDir, {
      compile: [{ rules: [NEWS.rules[0]] }],
      listResolution,
      scenarios: [NEWS_SCENARIOS],
      judge: [PASS],
    });
    const rerun = await run(fake, outputDir, news);

    expect(rerun.error).toBeUndefined();
    expect(ruleNames(rerun.policy)).toEqual(['allow-news']);
    expect(callsOf(fake, 'compile')).toHaveLength(1);
    expect(rerun.warnings.some((w) => w.includes('cached rules fail the rule checks with their lists'))).toBe(true);
    expect(rerun.warnings.some((w) => w.includes('"*.github.io" (via @sites)'))).toBe(true);
  });

  it('checks the merged policy, where a list shared by two servers takes one definition', async () => {
    const outputDir = makeOutputDir();
    // `alpha` escalates its @sites (broad values are fine there) and wins the
    // merge (alphabetical first-wins); `news` allows its own, narrow @sites.
    seedManualAddition(outputDir, 'alpha', '*.github.io');
    const ALPHA_TOOLS: StoredToolAnnotation[] = [{ ...NEWS_TOOLS[0], serverName: 'alpha', toolName: 'http_get' }];
    const alphaRule = {
      rules: [
        rule(
          'alpha-sites',
          'alpha',
          { tool: ['http_get'], domains: { roles: ['fetch-url'], allowed: ['@sites'] } },
          'escalate',
        ),
      ],
      listDefinitions: [SITES],
    };
    const fake = scripted(outputDir, {
      compile: [
        (call: FakeLlmCall) => (call.system.includes('for the "alpha" server') ? alphaRule : newsListRule('allow')),
      ],
      listResolution: [{ values: ['news.example.com'] }],
      scenarios: [
        (call: FakeLlmCall) =>
          call.system.includes('http_get')
            ? {
                scenarios: [
                  {
                    ...NEWS_SCENARIOS.scenarios[0],
                    request: { ...NEWS_SCENARIOS.scenarios[0].request, serverName: 'alpha', toolName: 'http_get' },
                    expectedDecision: 'escalate',
                  },
                ],
              }
            : SITES_SCENARIOS,
      ],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, annotationsFor({ alpha: ALPHA_TOOLS, news: NEWS_TOOLS }));

    expect(errorCode(result.error)).toBe('POLICY_LINT_FAILED');
    expect((result.error as Error).message).toContain('"*.github.io" (via @sites)');
    expect(existsSync(resolve(outputDir, 'compiled-policy.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The run's sandbox (for cron: the job workspace)
// ---------------------------------------------------------------------------

describe('the lint checks rules against the run sandbox', () => {
  it('treats the job workspace like the engine does (exempt from protection, structurally allowed)', async () => {
    const outputDir = makeOutputDir();
    // The default job workspace sits inside the protected IronCurtain home.
    const ironcurtainHome = resolve(outputDir, '..', 'ironcurtain-home');
    const workspace = resolve(ironcurtainHome, 'jobs', 'triage', 'workspace');
    mkdirSync(workspace, { recursive: true });
    const filesystem: StoredToolAnnotation[] = [
      {
        serverName: 'filesystem',
        toolName: 'write_file',
        comment: 'Writes a file.',
        args: { path: ['write-path'] },
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ];
    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            rule('write-reports', 'filesystem', {
              tool: ['write_file'],
              paths: { roles: ['write-path'], within: resolve(workspace, 'reports') },
            }),
          ],
        },
      ],
      scenarios: [
        {
          scenarios: [
            {
              description: 'write outside the workspace',
              request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/etc/motd' } },
              expectedDecision: 'deny',
              reasoning: 'Only the workspace is writable.',
            },
          ],
        },
      ],
      judge: [PASS],
    });

    const result = await run(fake, outputDir, annotationsFor({ filesystem }), {
      constitutionKind: 'task-policy',
      allowedDirectory: workspace,
      protectedPaths: [ironcurtainHome],
    });

    expect(result.error).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('is inside the sandbox'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('lies in protected path'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The prompt tells the compiler about broad egress
// ---------------------------------------------------------------------------

describe('compiler prompt', () => {
  it('states the broad-egress restriction for URL servers unless the policy opted in', async () => {
    const newsAllow = {
      rules: [
        rule('allow-news', 'news', {
          tool: ['http_fetch'],
          domains: { roles: ['fetch-url'], allowed: ['news.example.com'] },
        }),
      ],
    };
    const script = { compile: [newsAllow], scenarios: [NEWS_SCENARIOS], judge: [PASS] };
    const news = annotationsFor({ news: NEWS_TOOLS });

    const restricted = scripted(makeOutputDir(), script);
    await run(restricted, makeOutputDir(), news);
    const optedIn = scripted(makeOutputDir(), script);
    await run(optedIn, makeOutputDir(), news, { allowBroadDomains: true });
    const fsOnly = scripted(makeOutputDir(), { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] });
    await run(fsOnly, makeOutputDir(), FS_ONLY);

    expect(callsOf(restricted, 'compile')[0].system).toContain('## Broad Egress (not permitted for this policy)');
    expect(callsOf(optedIn, 'compile')[0].system).not.toContain('Broad Egress');
    expect(callsOf(fsOnly, 'compile')[0].system).not.toContain('Broad Egress');
  });
});
