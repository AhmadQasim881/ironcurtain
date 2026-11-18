/**
 * Tests for the compile-policy CLI: argument parsing, the single-server and
 * exit-status rules, the pre-filter input text, and end-to-end runs of
 * `runCompilePolicy` against a temp IRONCURTAIN_HOME with fake LLMs.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// compile-policy layers the user's generated/tool-annotations.json per server
// over the annotations shipped in the package (see
// docs/designs/tool-annotation-overlay.md), so a run would also compile every
// shipped server, which the fake LLMs have no script for. The end-to-end runs
// point the shipped dir at a temp dir holding only what each test puts there.
// Unset: the real package dir.
const shipped = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('../src/pipeline/pipeline-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/pipeline-shared.js')>();
  return {
    ...actual,
    loadPipelineConfig: (...args: Parameters<typeof actual.loadPipelineConfig>) => {
      const config = actual.loadPipelineConfig(...args);
      return shipped.dir === undefined ? config : { ...config, packageGeneratedDir: shipped.dir };
    },
  };
});

import {
  broadDomainsOptIn,
  COMPILE_PARTIAL_FAILURE_EXIT_CODE,
  compileExitCode,
  main,
  parseCompilePolicyArgs,
  runCompilePolicy,
  shouldWriteMergedArtifacts,
} from '../src/pipeline/compile.js';
import { BROAD_DOMAINS_DIRECTIVE } from '../src/pipeline/policy-lint.js';
import { loadConstitutionText, loadPrefilterConstitutionText } from '../src/config/paths.js';
import { computeAnnotationContentDigest } from '../src/config/tool-annotations-overlay.js';
import type { CompiledPolicyFile, ServerCompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import {
  createScriptedPipelineModels,
  type FakeLlmCall,
  type FakePhaseScript,
} from './fixtures/fake-pipeline-models.js';
import {
  annotationsFor,
  BAD_FS_GOOD_NEWS,
  FS_AND_CHANGED_NEWS,
  FS_AND_NEWS,
  FS_ONLY,
  FS_SCENARIOS,
  GOOD_BOTH,
  GOOD_FS,
  NEWS_SCENARIOS,
  NEWS_TOOLS,
  PASS,
  rule,
} from './fixtures/two-server-pipeline-fixture.js';

const PACKAGE_BASE_CONSTITUTION = fileURLToPath(new URL('../src/config/constitution.md', import.meta.url));

describe('parseCompilePolicyArgs', () => {
  it('returns defaults when no args provided', () => {
    const result = parseCompilePolicyArgs([]);
    expect(result.constitution).toBeUndefined();
    expect(result.outputDir).toBeUndefined();
    expect(result.server).toBeUndefined();
    expect(result.noMcp).toBe(false);
  });

  it('parses --constitution flag', () => {
    const result = parseCompilePolicyArgs(['--constitution', 'my-constitution.md']);
    expect(result.constitution).toBe(resolve('my-constitution.md'));
  });

  it('parses --output-dir flag', () => {
    const result = parseCompilePolicyArgs(['--output-dir', '/tmp/output']);
    expect(result.outputDir).toBe('/tmp/output');
  });

  it('parses both flags together', () => {
    const result = parseCompilePolicyArgs([
      '--constitution',
      '/path/to/constitution.md',
      '--output-dir',
      '/tmp/output',
    ]);
    expect(result.constitution).toBe('/path/to/constitution.md');
    expect(result.outputDir).toBe('/tmp/output');
  });

  it('rejects a known flag given without its value', () => {
    expect(() => parseCompilePolicyArgs(['--constitution'])).toThrow();
  });

  it('rejects unknown flags', () => {
    expect(() => parseCompilePolicyArgs(['--unknown', 'value'])).toThrow(/unknown/i);
  });

  it('tolerates the subcommand-name positional (process.argv.slice(2) form)', () => {
    const result = parseCompilePolicyArgs(['compile-policy', '--no-mcp']);
    expect(result.noMcp).toBe(true);
  });

  it('resolves relative constitution paths to absolute', () => {
    const result = parseCompilePolicyArgs(['--constitution', './relative/path.md']);
    expect(result.constitution).toBe(resolve('./relative/path.md'));
    expect(result.constitution).toMatch(/^\//);
  });

  it('resolves relative output-dir paths to absolute', () => {
    const result = parseCompilePolicyArgs(['--output-dir', './relative/dir']);
    expect(result.outputDir).toBe(resolve('./relative/dir'));
    expect(result.outputDir).toMatch(/^\//);
  });

  it('parses --server flag', () => {
    const result = parseCompilePolicyArgs(['--server', 'filesystem']);
    expect(result.server).toBe('filesystem');
  });

  it('parses --server with other flags', () => {
    const result = parseCompilePolicyArgs([
      '--constitution',
      '/path/to/c.md',
      '--server',
      'git',
      '--output-dir',
      '/tmp/out',
    ]);
    expect(result.server).toBe('git');
    expect(result.constitution).toBe('/path/to/c.md');
    expect(result.outputDir).toBe('/tmp/out');
  });

  it('parses --no-mcp flag', () => {
    const result = parseCompilePolicyArgs(['--no-mcp']);
    expect(result.noMcp).toBe(true);
  });

  it('defaults noMcp to false when not specified', () => {
    const result = parseCompilePolicyArgs(['--constitution', '/path/to/c.md']);
    expect(result.noMcp).toBe(false);
  });

  it('parses --write-merged together with --server', () => {
    expect(parseCompilePolicyArgs(['--server', 'git', '--write-merged']).writeMerged).toBe(true);
    expect(parseCompilePolicyArgs(['--server', 'git']).writeMerged).toBe(false);
  });

  it('rejects --write-merged without --server', () => {
    expect(() => parseCompilePolicyArgs(['--write-merged'])).toThrow(/--server/);
  });

  it('parses --force, off by default', () => {
    expect(parseCompilePolicyArgs(['--force']).force).toBe(true);
    expect(parseCompilePolicyArgs([]).force).toBe(false);
  });

  it('rejects an empty --server name (it would select a full run)', () => {
    expect(() => parseCompilePolicyArgs(['--server', ''])).toThrow(/server name/);
    expect(() => parseCompilePolicyArgs(['--server='])).toThrow(/server name/);
    expect(() => parseCompilePolicyArgs(['--server', '  '])).toThrow(/server name/);
  });

  it('parses --allow-broad-domains (off by default)', () => {
    expect(parseCompilePolicyArgs([]).allowBroadDomains).toBe(false);
    expect(parseCompilePolicyArgs(['--allow-broad-domains']).allowBroadDomains).toBe(true);
  });
});

describe('broadDomainsOptIn', () => {
  it('comes from the flag or the constitution directive, and from nothing else', () => {
    expect(broadDomainsOptIn({ allowBroadDomains: true }, '# Policy')).toBe('--allow-broad-domains');
    expect(broadDomainsOptIn({}, `# Policy\n${BROAD_DOMAINS_DIRECTIVE}\n`)).toContain('constitution directive');
    expect(broadDomainsOptIn({}, '# Policy\n- The agent may fetch any domain.\n')).toBeUndefined();
  });
});

describe('compile-policy --help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses --help and -h, alone or after the subcommand token', () => {
    expect(parseCompilePolicyArgs(['--help'])).toEqual({ help: true });
    expect(parseCompilePolicyArgs(['-h'])).toEqual({ help: true });
    expect(parseCompilePolicyArgs(['compile-policy', '--help'])).toEqual({ help: true });
  });

  it('prints the usage and exits 0 without compiling anything', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
    const createModels = vi.fn();

    for (const argv of [['--help'], ['-h'], ['compile-policy', '--help']]) {
      expect(await runCompilePolicy(argv, { createModels })).toBe(0);
    }

    expect(createModels).not.toHaveBeenCalled();
    const help = printed.join('\n');
    expect(help).toContain('ironcurtain compile-policy');
    for (const flag of ['--constitution', '--output-dir', '--server', '--write-merged', '--no-mcp', '-h, --help']) {
      expect(help).toContain(flag);
    }
  });

  it('main() leaves the exit status at 0 for --help', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await main(['compile-policy', '--help']);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('still points a bad invocation at --help (which now works)', async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    expect(await runCompilePolicy(['--bogus'])).toBe(1);
    expect(written.join('')).toContain('Run `ironcurtain compile-policy --help` for usage.');
  });
});

describe('shouldWriteMergedArtifacts', () => {
  it('writes the merged policy for a full run', () => {
    expect(shouldWriteMergedArtifacts({})).toBe(true);
    expect(shouldWriteMergedArtifacts({ outputDir: '/tmp/out' })).toBe(true);
  });

  it('does not write the merged policy for a --server run into the default output dir', () => {
    expect(shouldWriteMergedArtifacts({ server: 'git' })).toBe(false);
  });

  it('writes it for a --server run with --output-dir or --write-merged', () => {
    expect(shouldWriteMergedArtifacts({ server: 'git', outputDir: '/tmp/out' })).toBe(true);
    expect(shouldWriteMergedArtifacts({ server: 'git', writeMerged: true })).toBe(true);
  });
});

describe('compileExitCode', () => {
  const policy: CompiledPolicyFile = { generatedAt: '', constitutionHash: 'c', inputHash: 'i', rules: [] };

  it('is 0 when no server failed', () => {
    expect(compileExitCode(policy)).toBe(0);
    expect(compileExitCode({ ...policy, failedServers: [] })).toBe(0);
  });

  it('is the partial-failure status when servers failed', () => {
    expect(compileExitCode({ ...policy, failedServers: [{ serverName: 'fs', phase: 'verifying', reason: 'r' }] })).toBe(
      COMPILE_PARTIAL_FAILURE_EXIT_CODE,
    );
    expect(COMPILE_PARTIAL_FAILURE_EXIT_CODE).not.toBe(0);
    expect(COMPILE_PARTIAL_FAILURE_EXIT_CODE).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end runs against a temp IRONCURTAIN_HOME
// ---------------------------------------------------------------------------

const USER_CONSTITUTION = '# User guidance\n\nUSER-MARKER: the agent may read files and fetch news pages.\n';
const OVERRIDE_BASE = '# Replacement base\n\nOVERRIDE-MARKER: the agent may also use the widget server.\n';

describe('compile-policy end to end (fake LLM)', () => {
  let home: string;
  let shippedDir: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp15-cli-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
    vi.stubEnv('ALLOWED_DIRECTORY', resolve(home, 'sandbox'));
    mkdirSync(resolve(home, 'generated'), { recursive: true });
    // No shipped annotations unless a test writes them: the user file below
    // is then the whole annotation set.
    shippedDir = resolve(home, 'shipped');
    mkdirSync(shippedDir);
    shipped.dir = shippedDir;
    writeAnnotations(FS_AND_NEWS);
    writeFileSync(resolve(home, 'constitution-user.md'), USER_CONSTITUTION);
    // The CLI prints its banner, spinners and summary to stderr.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    shipped.dir = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes the user's annotations (the overlay in ~/.ironcurtain/generated/). */
  function writeAnnotations(annotations: StoredToolAnnotationsFile): void {
    writeFileSync(resolve(home, 'generated', 'tool-annotations.json'), JSON.stringify(annotations));
  }

  /** Writes the annotations "shipped with IronCurtain" (the package base). */
  function writeShipped(annotations: StoredToolAnnotationsFile): void {
    writeFileSync(resolve(shippedDir, 'tool-annotations.json'), JSON.stringify(annotations));
  }

  /** Servers the compiler LLM was asked to compile, in call order. */
  function compiledServers(calls: readonly FakeLlmCall[]): string[] {
    return calls.filter((c) => c.phase === 'compile').map((c) => /for the "([^"]+)" server/.exec(c.system)?.[1] ?? '?');
  }

  function generated(...parts: string[]): string {
    return resolve(home, 'generated', ...parts);
  }

  async function compile(argv: string[], script: FakePhaseScript) {
    const fake = createScriptedPipelineModels(script, resolve(home, 'llm.jsonl'));
    const exitCode = await runCompilePolicy(argv, { createModels: () => Promise.resolve(fake.models) });
    return { exitCode, calls: fake.calls };
  }

  const KEEP_ALL = { prefilter: [{ skip: false, reason: 'relevant' }] };
  const SKIP_ALL = { prefilter: [{ skip: true, reason: 'not relevant' }] };

  /** news is compiled to an allow for every domain ("*"), and the compiler insists on it. */
  const NEWS_ANY = {
    rules: [
      rule('allow-news-any', 'news', { tool: ['http_fetch'], domains: { roles: ['fetch-url'], allowed: ['*'] } }),
    ],
  };
  const isFsCall = (call: FakeLlmCall) => call.system.includes('for the "fs" server');
  const ANY_DOMAIN_NEWS: FakePhaseScript = {
    ...KEEP_ALL,
    compile: [(call: FakeLlmCall) => (isFsCall(call) ? GOOD_FS : NEWS_ANY)],
    validationRepair: [NEWS_ANY],
    scenarios: [(call: FakeLlmCall) => (call.system.includes('read_file') ? FS_SCENARIOS : NEWS_SCENARIOS)],
    judge: [PASS],
  };

  // WP-59 owner decision: "*" and public-suffix wildcard allows need an explicit opt-in.
  it('rejects an allow for every domain without the opt-in', async () => {
    const { exitCode, calls } = await compile(['--no-mcp'], ANY_DOMAIN_NEWS);

    expect(exitCode).toBe(COMPILE_PARTIAL_FAILURE_EXIT_CODE);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-fs-reads']);
    expect(merged.failedServers).toEqual([
      expect.objectContaining({ serverName: 'news', phase: 'compiling', reason: expect.stringContaining('"*"') }),
    ]);
    expect(calls.filter((c) => c.phase === 'validationRepair').length).toBeGreaterThan(0);
  });

  it.each([
    ['the --allow-broad-domains flag', ['--no-mcp', '--allow-broad-domains'], USER_CONSTITUTION],
    ['the constitution directive', ['--no-mcp'], `${USER_CONSTITUTION}\n${BROAD_DOMAINS_DIRECTIVE}\n`],
  ])('accepts an allow for every domain with %s', async (_label, argv, userConstitution) => {
    writeFileSync(resolve(home, 'constitution-user.md'), userConstitution);
    const { exitCode, calls } = await compile(argv, ANY_DOMAIN_NEWS);

    expect(exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-fs-reads', 'allow-news-any']);
    expect(calls.filter((c) => c.phase === 'validationRepair')).toHaveLength(0);
  });

  it('exits with the partial-failure status and records failedServers when a server fails', async () => {
    const { exitCode } = await compile(['--no-mcp'], { ...BAD_FS_GOOD_NEWS, ...KEEP_ALL });

    expect(exitCode).toBe(COMPILE_PARTIAL_FAILURE_EXIT_CODE);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-news']);
    expect(merged.failedServers).toEqual([
      expect.objectContaining({ serverName: 'fs', phase: 'verifying', reason: expect.any(String) }),
    ]);
  });

  it('main() reports a partial failure through process.exitCode, without exiting the process', async () => {
    const fake = createScriptedPipelineModels({ ...BAD_FS_GOOD_NEWS, ...KEEP_ALL }, resolve(home, 'llm.jsonl'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)}) called`);
    });
    const previousExitCode = process.exitCode;
    try {
      await main(['--no-mcp'], { createModels: () => Promise.resolve(fake.models) });
      expect(process.exitCode).toBe(COMPILE_PARTIAL_FAILURE_EXIT_CODE);
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits 0 when every server compiles', async () => {
    const { exitCode } = await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL });
    expect(exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.failedServers).toBeUndefined();
  });

  it('--force recompiles and re-verifies every server that an unchanged run serves from cache', async () => {
    expect((await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL })).exitCode).toBe(0);

    const cached = await compile(['--no-mcp'], KEEP_ALL);
    expect(cached.exitCode).toBe(0);
    expect(compiledServers(cached.calls)).toEqual([]);

    const forced = await compile(['--no-mcp', '--force'], { ...GOOD_BOTH, ...KEEP_ALL });
    expect(forced.exitCode).toBe(0);
    expect(compiledServers(forced.calls).sort()).toEqual(['fs', 'news']);
    expect(forced.calls.filter((c) => c.phase === 'judge').length).toBeGreaterThanOrEqual(2);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.provenance?.annotationDigests).toEqual({
      fs: computeAnnotationContentDigest(FS_AND_NEWS.servers.fs.tools),
      news: computeAnnotationContentDigest(FS_AND_NEWS.servers.news.tools),
    });
  });

  it('names --force in the warning about a cached result compiled by another policy model', async () => {
    const compileWith = async (script: FakePhaseScript, policyModelId: string) => {
      const fake = createScriptedPipelineModels(script, resolve(home, 'llm.jsonl'));
      const exitCode = await runCompilePolicy(['--no-mcp'], {
        createModels: () => Promise.resolve({ ...fake.models, policyModelId }),
      });
      return { exitCode, calls: fake.calls };
    };
    expect((await compileWith({ ...GOOD_BOTH, ...KEEP_ALL }, 'test:model-a')).exitCode).toBe(0);

    const stderr = vi.mocked(process.stderr.write);
    stderr.mockClear();
    const cached = await compileWith(KEEP_ALL, 'test:model-b');
    expect(cached.exitCode).toBe(0);
    expect(compiledServers(cached.calls)).toEqual([]);
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(
      'compiled by test:model-a; the configured policy model is test:model-b. ' +
        'Run `ironcurtain compile-policy` again with `--force` to recompile and re-verify it.',
    );
  });

  it('--server leaves the other servers in the merged policy intact', async () => {
    expect((await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL })).exitCode).toBe(0);
    const mergedBefore = readFileSync(generated('compiled-policy.json'), 'utf-8');
    expect((JSON.parse(mergedBefore) as CompiledPolicyFile).rules.map((r) => r.name)).toEqual([
      'allow-fs-reads',
      'allow-news',
    ]);

    // Change news's annotations so the --server run really recompiles it.
    writeAnnotations(FS_AND_CHANGED_NEWS);
    const { exitCode, calls } = await compile(['--no-mcp', '--server', 'news'], GOOD_BOTH);

    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.phase === 'compile')).toBe(true);
    expect(readFileSync(generated('compiled-policy.json'), 'utf-8')).toBe(mergedBefore);
    const news = JSON.parse(
      readFileSync(generated('servers', 'news', 'compiled-policy.json'), 'utf-8'),
    ) as ServerCompiledPolicyFile;
    expect(news.verified).toBe(true);
  });

  // WP-27: compile-policy compares the stored annotations with the live
  // servers before compiling and validates scenarios against their live
  // schemas; with --no-mcp it says the comparison did not happen.
  it('checks the stored annotations against the live servers it compiles, unless --no-mcp', async () => {
    const checkLiveDrift = vi.fn(() => Promise.resolve(new Map<string, Record<string, unknown>>()));
    const fake = createScriptedPipelineModels(GOOD_BOTH, resolve(home, 'llm.jsonl'));
    const exitCode = await runCompilePolicy(['--server', 'news'], {
      createModels: () => Promise.resolve(fake.models),
      checkLiveDrift,
    });
    expect(exitCode).toBe(0);
    expect(checkLiveDrift).toHaveBeenCalledOnce();
    // No allowed directory: discovery points the filesystem server at an
    // empty directory of its own (live-tools.ts).
    const [servers, annotations, serverFilter] = checkLiveDrift.mock.calls[0] as unknown as [
      Record<string, unknown>,
      StoredToolAnnotationsFile,
      string | undefined,
    ];
    expect(Object.keys(servers)).toContain('filesystem');
    expect(Object.keys(annotations.servers).sort()).toEqual(['fs', 'news']);
    expect(serverFilter).toBe('news');

    checkLiveDrift.mockClear();
    const noMcp = await runCompilePolicy(['--no-mcp', '--server', 'news'], {
      createModels: () => Promise.resolve(fake.models),
      checkLiveDrift,
    });
    expect(noMcp).toBe(0);
    expect(checkLiveDrift).not.toHaveBeenCalled();
    const stderrLines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(
      stderrLines.some((line) => line.includes('Annotation drift against the live MCP servers was not checked')),
    ).toBe(true);
  });

  it('validates generated scenarios against the live schema the drift check returned', async () => {
    // The live news server renamed http_fetch's `url` to `address`: the
    // generated scenario still passes the stored schema, but it is a call
    // the server rejects, so it must be discarded.
    const live = new Map<string, Record<string, unknown>>([
      ['news__http_fetch', { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] }],
    ]);
    // The repair turn cannot name `address` either (scenarios may only use
    // the stored argument names), so it returns no replacement.
    const fake = createScriptedPipelineModels(
      { ...GOOD_BOTH, scenarioRepair: [{ scenarios: [] }] },
      resolve(home, 'llm.jsonl'),
    );
    const exitCode = await runCompilePolicy(['--server', 'news'], {
      createModels: () => Promise.resolve(fake.models),
      checkLiveDrift: () => Promise.resolve(live),
    });
    expect(exitCode).toBe(0);
    expect(fake.calls.some((c) => c.phase === 'scenarioRepair')).toBe(true);
    const output = [
      ...vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' ')),
      ...vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])),
    ].join('\n');
    expect(output).toMatch(/Discarded \(schema mismatch\).*news/s);
    expect(output).toContain('url');
  });

  it('--server with --write-merged writes a merged policy holding only that server, and warns first', async () => {
    expect((await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL })).exitCode).toBe(0);

    writeAnnotations(FS_AND_CHANGED_NEWS);
    const { exitCode } = await compile(['--no-mcp', '--server', 'news', '--write-merged'], GOOD_BOTH);

    expect(exitCode).toBe(0);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-news']);
    const stderrLines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(stderrLines.some((line) => line.includes("will hold ONLY news's rules"))).toBe(true);
  });

  it('the pre-filter sees the text of a user base-constitution override', async () => {
    writeFileSync(resolve(home, 'constitution.md'), OVERRIDE_BASE);
    const { exitCode, calls } = await compile(['--no-mcp'], SKIP_ALL);

    expect(exitCode).toBe(0);
    const prefilterCalls = calls.filter((c) => c.phase === 'prefilter');
    expect(prefilterCalls.length).toBeGreaterThan(0);
    for (const call of prefilterCalls) {
      expect(call.userText).toContain('OVERRIDE-MARKER');
      expect(call.userText).toContain('USER-MARKER');
    }
  });

  it('without an override the pre-filter sees only the user constitution, not the package base', async () => {
    const { calls } = await compile(['--no-mcp'], SKIP_ALL);

    const prefilterCalls = calls.filter((c) => c.phase === 'prefilter');
    expect(prefilterCalls.length).toBeGreaterThan(0);
    for (const call of prefilterCalls) {
      expect(call.userText).toContain('USER-MARKER');
      expect(call.userText).not.toContain('Least privilege');
    }
  });

  it('compiles the shipped servers that a user annotations overlay does not list', async () => {
    writeShipped(FS_ONLY);
    // The user re-annotated only news, a server the package does not ship.
    writeAnnotations(annotationsFor({ news: NEWS_TOOLS }));

    const { exitCode, calls } = await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL });

    expect(exitCode).toBe(0);
    expect(compiledServers(calls).sort()).toEqual(['fs', 'news']);
    const merged = JSON.parse(readFileSync(generated('compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-fs-reads', 'allow-news']);
  });

  it('a shipped annotation fix reaches compile-policy past a legacy full copy and recompiles only that server', async () => {
    // Before overlays, annotate-tools copied every shipped entry into the user file.
    writeShipped(FS_AND_NEWS);
    writeAnnotations(FS_AND_NEWS);
    expect((await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL })).exitCode).toBe(0);

    // The next release fixes news's annotations; the replaced revision is recorded as superseded.
    const fixedNews = [{ ...NEWS_TOOLS[0], comment: 'Fetches a web page (reviewed fix).' }];
    writeShipped({
      ...FS_AND_NEWS,
      servers: {
        ...FS_AND_NEWS.servers,
        news: {
          inputHash: 'news-v2',
          supersededDigests: [computeAnnotationContentDigest(NEWS_TOOLS)],
          tools: fixedNews,
        },
      },
    });
    const { exitCode, calls } = await compile(['--no-mcp'], { ...GOOD_BOTH, ...KEEP_ALL });

    expect(exitCode).toBe(0);
    // The stale user copy no longer shadows the fix, so the verified cache
    // entry for news is invalidated; fs is still served from the cache.
    expect(compiledServers(calls)).toEqual(['news']);
    const news = JSON.parse(
      readFileSync(generated('servers', 'news', 'compiled-policy.json'), 'utf-8'),
    ) as ServerCompiledPolicyFile;
    expect(news.verified).toBe(true);
  });
});

describe('loadPrefilterConstitutionText', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp15-prefilter-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
    writeFileSync(resolve(home, 'constitution-user.md'), USER_CONSTITUTION);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the user constitution alone when the package base is in use', () => {
    const combined = loadConstitutionText(PACKAGE_BASE_CONSTITUTION);
    expect(loadPrefilterConstitutionText(combined)).toBe(USER_CONSTITUTION);
  });

  it('returns the full combined text when ~/.ironcurtain/constitution.md overrides the base', () => {
    writeFileSync(resolve(home, 'constitution.md'), OVERRIDE_BASE);
    const combined = loadConstitutionText(PACKAGE_BASE_CONSTITUTION);
    const text = loadPrefilterConstitutionText(combined);
    expect(text).toBe(combined);
    expect(text).toContain('OVERRIDE-MARKER');
    expect(text).toContain('USER-MARKER');
  });
});
