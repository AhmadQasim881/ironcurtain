/**
 * WP-88 / PIP-15: work a recompile no longer redoes.
 *
 *  - (b) Pre-filter decisions are cached per server: an unchanged rerun makes
 *    no pre-filter call (and no other LLM call), so it cannot flip a skip
 *    decision; `force` asks again.
 *  - (c) Data-backed lists: the policy-mediated MCP connection is opened only
 *    when such a list misses the list cache, and one connection serves every
 *    resolution of a server's compile (the repair loop resolves the lists
 *    again after each repair).
 *
 * The real PipelineRunner runs with scripted fake LLMs; `connectViaProxy` is
 * replaced by a counting fake (no relay subprocess, no Docker).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { MCPServerConfig } from '../src/config/types.js';
import type { ListDefinition, StoredToolAnnotation, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const proxy = vi.hoisted(() => ({ connects: [] as string[][], shutdowns: 0 }));
vi.mock('../src/pipeline/proxy-mcp-connections.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/proxy-mcp-connections.js')>();
  return {
    ...actual,
    connectViaProxy: (definitions: readonly ListDefinition[]) => {
      proxy.connects.push(definitions.map((d) => d.name));
      return Promise.resolve({
        tools: [{ serverName: 'mail', name: 'list_contacts', inputSchema: { type: 'object' }, offered: true }],
        callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'alice@example.com' }], isError: false }),
        shutdown: () => {
          proxy.shutdowns++;
          return Promise.resolve();
        },
      });
    },
  };
});

import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import { PREFILTER_DECISION_FILE } from '../src/pipeline/server-prefilter.js';
import {
  createScriptedPipelineModels,
  createThrowingPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
  type ScriptedPipelineModels,
} from './fixtures/fake-pipeline-models.js';
import {
  CONSTITUTION,
  FS_AND_NEWS,
  FS_SCENARIOS,
  GOOD_FS,
  PASS,
  SANDBOX,
  annotationsFor,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  proxy.connects.length = 0;
  proxy.shutdowns = 0;
});

function makeOutputDir(): string {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-wp88-incr-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

const noopReporter: ServerProgressReporter = {
  update: () => {},
  complete: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
};

async function run(
  fake: ScriptedPipelineModels,
  outputDir: string,
  annotations: StoredToolAnnotationsFile,
  overrides: Partial<PipelineRunConfig> = {},
) {
  const logs: string[] = [];
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
    reporterFactory: () => noopReporter,
    onProgress: (msg) => logs.push(msg),
    ...overrides,
  };
  const policy = await new PipelineRunner(fake.models).run(config);
  return { policy, logs };
}

function scripted(outputDir: string, script: FakePhaseScript): ScriptedPipelineModels {
  return createScriptedPipelineModels(script, resolve(outputDir, '..', 'llm.jsonl'));
}

const callsOf = (fake: ScriptedPipelineModels, phase: FakeLlmCall['phase']): FakeLlmCall[] =>
  fake.calls.filter((c) => c.phase === phase);

// ---------------------------------------------------------------------------
// Pre-filter decision cache
// ---------------------------------------------------------------------------

describe('pre-filter decisions are cached (PIP-15b)', () => {
  /** The pre-filter keeps fs and skips news. */
  const KEEP_FS_SKIP_NEWS = {
    prefilter: [
      (call: FakeLlmCall) =>
        call.system.includes('Server: "fs"')
          ? { skip: false, reason: 'Files are mentioned.' }
          : { skip: true, reason: 'Nothing grants news access.' },
    ],
    compile: [GOOD_FS],
    scenarios: [FS_SCENARIOS],
    judge: [PASS],
  };
  const PREFILTER_TEXT = 'Reading files anywhere is fine.';

  it('an unchanged rerun makes zero pre-filter calls and keeps the same skip decisions', async () => {
    const outputDir = makeOutputDir();
    const first = scripted(outputDir, KEEP_FS_SKIP_NEWS);
    const before = await run(first, outputDir, FS_AND_NEWS, { prefilterText: PREFILTER_TEXT });
    expect(callsOf(first, 'prefilter')).toHaveLength(2);
    expect(before.policy.skippedServers).toEqual([{ serverName: 'news', reason: 'Nothing grants news access.' }]);
    expect(existsSync(resolve(outputDir, 'servers', 'news', PREFILTER_DECISION_FILE))).toBe(true);

    // An LLM that fails every call: the rerun can only succeed without one.
    const down = createThrowingPipelineModels(resolve(outputDir, '..', 'llm.jsonl'));
    const after = await run(down, outputDir, FS_AND_NEWS, { prefilterText: PREFILTER_TEXT });

    expect(down.calls).toHaveLength(0);
    expect(after.policy.skippedServers).toEqual(before.policy.skippedServers);
    expect(after.policy.rules).toEqual(before.policy.rules);
    expect(after.logs.some((l) => l.includes('2 decision(s) reused'))).toBe(true);
  });

  it('asks again when the pre-filter text changes, and with force', async () => {
    const outputDir = makeOutputDir();
    await run(scripted(outputDir, KEEP_FS_SKIP_NEWS), outputDir, FS_AND_NEWS, { prefilterText: PREFILTER_TEXT });

    const edited = scripted(outputDir, KEEP_FS_SKIP_NEWS);
    await run(edited, outputDir, FS_AND_NEWS, { prefilterText: `${PREFILTER_TEXT} News may be read.` });
    expect(callsOf(edited, 'prefilter')).toHaveLength(2);

    const forced = scripted(outputDir, KEEP_FS_SKIP_NEWS);
    await run(forced, outputDir, FS_AND_NEWS, { prefilterText: PREFILTER_TEXT, force: true });
    expect(callsOf(forced, 'prefilter')).toHaveLength(2);
  });

  it('a different pre-filter model is asked again', async () => {
    const outputDir = makeOutputDir();
    await run(scripted(outputDir, KEEP_FS_SKIP_NEWS), outputDir, FS_AND_NEWS, { prefilterText: PREFILTER_TEXT });

    const other = scripted(outputDir, KEEP_FS_SKIP_NEWS);
    const runner = new PipelineRunner({ ...other.models, prefilterModelId: 'test:another-haiku' });
    await runner.run({
      constitutionInput: CONSTITUTION,
      constitutionKind: 'constitution',
      outputDir,
      toolAnnotationsDir: outputDir,
      allowedDirectory: SANDBOX,
      protectedPaths: [],
      preloadedStoredAnnotations: FS_AND_NEWS,
      includeHandwrittenScenarios: false,
      quiet: true,
      reporterFactory: () => noopReporter,
      prefilterText: PREFILTER_TEXT,
    });
    expect(callsOf(other, 'prefilter')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Data-backed lists: connect only on a cache miss, one connection per compile
// ---------------------------------------------------------------------------

describe('data-backed list resolution connects only when needed (PIP-15c)', () => {
  const PATH_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const mailTools = (comment = 'Reads a file.'): StoredToolAnnotation[] => [
    { serverName: 'mail', toolName: 'read_file', comment, args: { path: ['read-path'] }, inputSchema: PATH_SCHEMA },
    {
      serverName: 'mail',
      toolName: 'delete_file',
      comment: 'Deletes a file.',
      args: { path: ['delete-path'] },
      inputSchema: PATH_SCHEMA,
    },
    {
      serverName: 'mail',
      toolName: 'send_email',
      comment: 'Sends an email.',
      args: { to: ['email-address'] },
      inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
  ];
  const MAIL = annotationsFor({ mail: mailTools() });
  const MCP_SERVERS: Record<string, MCPServerConfig> = { mail: { command: 'unused-in-tests', args: [] } };

  const contactsList = (name: string): ListDefinition => ({
    name,
    type: 'emails',
    principle: 'People in my contacts may be emailed.',
    generationPrompt: `List the email addresses in ${name}.`,
    requiresMcp: true,
    mcpServerHint: 'mail',
  });
  const emailRule = (ruleName: string, list: string) =>
    rule(
      ruleName,
      'mail',
      { tool: ['send_email'], lists: [{ roles: ['email-address'], allowed: [`@${list}`], matchType: 'emails' }] },
      'escalate',
    );
  const COMPILED = {
    rules: [rule('allow-mail-reads', 'mail', { tool: ['read_file'] }), emailRule('escalate-contacts', 'contacts')],
    listDefinitions: [contactsList('contacts')],
  };
  const SCENARIOS = {
    scenarios: FS_SCENARIOS.scenarios.map((s) => ({ ...s, request: { ...s.request, serverName: 'mail' } })),
  };
  const BASE_SCRIPT: FakePhaseScript = {
    compile: [COMPILED],
    scenarios: [SCENARIOS],
    judge: [PASS],
    mcpListResolution: [{ values: ['alice@example.com'] }],
  };

  it('connects for a list that misses the cache, and not again for the same list on a recompile', async () => {
    const outputDir = makeOutputDir();
    const first = scripted(outputDir, BASE_SCRIPT);
    await run(first, outputDir, MAIL, { mcpServers: MCP_SERVERS });
    expect(proxy.connects).toEqual([['contacts']]);
    expect(proxy.shutdowns).toBe(1);
    expect(callsOf(first, 'mcpListResolution')).toHaveLength(1);
    const lists = JSON.parse(readFileSync(resolve(outputDir, 'servers', 'mail', 'dynamic-lists.json'), 'utf-8')) as {
      lists: Record<string, { values: string[] }>;
    };
    expect(lists.lists.contacts.values).toEqual(['alice@example.com']);

    // A changed annotation recompiles mail; the compiler emits the same list,
    // which is served from the list cache without starting any MCP server.
    const second = scripted(outputDir, BASE_SCRIPT);
    await run(second, outputDir, annotationsFor({ mail: mailTools('Reads a file (updated).') }), {
      mcpServers: MCP_SERVERS,
    });
    expect(callsOf(second, 'compile')).toHaveLength(1);
    expect(callsOf(second, 'mcpListResolution')).toHaveLength(0);
    expect(proxy.connects).toEqual([['contacts']]);
  });

  it('reuses one connection when a repair adds another list of the same server', async () => {
    const outputDir = makeOutputDir();
    const addFriends = {
      reasoning: 'Friends may be emailed too.',
      operations: [{ op: 'add', afterRule: 'escalate-contacts', rule: emailRule('escalate-friends', 'friends') }],
      listDefinitions: [contactsList('friends')],
    };
    const fake = scripted(outputDir, {
      ...BASE_SCRIPT,
      judge: [
        { analysis: 'Friends are not covered.', pass: false, failureAttributions: [], additionalScenarios: [] },
        PASS,
      ],
      repair: [addFriends],
    });

    const { policy } = await run(fake, outputDir, MAIL, { mcpServers: MCP_SERVERS });

    expect(policy.rules.map((r) => r.name)).toEqual(['allow-mail-reads', 'escalate-contacts', 'escalate-friends']);
    expect(callsOf(fake, 'repair')).toHaveLength(1);
    // Initial resolution (contacts) and the repair's (friends, contacts cached): one connection.
    expect(callsOf(fake, 'mcpListResolution')).toHaveLength(2);
    expect(proxy.connects).toEqual([['contacts']]);
    expect(proxy.shutdowns).toBe(1);
  });
});
