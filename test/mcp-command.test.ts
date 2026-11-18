/**
 * `ironcurtain mcp add|remove|list` (src/mcp/mcp-command.ts). The round trip
 * adds test/fixtures/cwd-probe-server.mjs as a user server: it is written to
 * $IRONCURTAIN_HOME/mcp-servers.json, annotated through the annotate-tools
 * path (the server really starts; a fake model classifies its tools) and
 * compiled through compile-policy --server (fake pipeline models), and every
 * artifact lands under the temp IronCurtain home: nothing in the package
 * directory changes.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A full compile-policy run compiles every shipped server too, which the fake
// models have no script for. The activation tests point the shipped
// annotations at an empty directory so the user's servers are the whole set.
// Unset: the real package directory.
const shipped = vi.hoisted(() => ({ dir: undefined as string | undefined }));
// Tests run as root, which file modes do not stop: a write into this
// directory fails as a read-only directory would. Unset: every write works.
const unwritable = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('../src/pipeline/pipeline-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/pipeline-shared.js')>();
  return {
    ...actual,
    loadPipelineConfig: (...args: Parameters<typeof actual.loadPipelineConfig>) => {
      const config = actual.loadPipelineConfig(...args);
      return shipped.dir === undefined ? config : { ...config, packageGeneratedDir: shipped.dir };
    },
    writeArtifact: (...args: Parameters<typeof actual.writeArtifact>) => {
      if (args[0] === unwritable.dir) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${args[0]}/${args[1]}'`), { code: 'EACCES' });
      }
      actual.writeArtifact(...args);
    },
  };
});

import { loadConfig } from '../src/config/index.js';
import { getPackageMcpServersPath, loadMcpServers } from '../src/config/mcp-servers-overlay.js';
import { loadUserConfig } from '../src/config/user-config.js';
import {
  listMcpServers,
  parseAddArgs,
  runMcpCommand,
  scenariosWithoutServer,
  withoutServer,
  type McpCommandDeps,
} from '../src/mcp/mcp-command.js';
import { runCompilePolicy } from '../src/pipeline/compile.js';
import { loadPipelineConfig, type PipelineLlm } from '../src/pipeline/pipeline-shared.js';
import type {
  CompiledPolicyFile,
  ServerCompiledPolicyFile,
  StoredToolAnnotationsFile,
  TestScenario,
  TestScenariosFile,
} from '../src/pipeline/types.js';
import { replayRecordedDecisions } from '../src/policy-artifacts/scenario-replay.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { createScriptedPipelineModels, type FakePhaseScript } from './fixtures/fake-pipeline-models.js';
import { PASS, rule } from './fixtures/two-server-pipeline-fixture.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_SERVER = resolve(projectRoot, 'test/fixtures/cwd-probe-server.mjs');
const PACKAGE_CONFIG_DIR = dirname(getPackageMcpServersPath());

let root: string;
let home: string;
let log: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-mcp-command-')));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('IRONCURTAIN_HOME', home);
  vi.stubEnv('ALLOWED_DIRECTORY', join(root, 'sandbox'));
  log = [];
  // annotate-tools and compile-policy print banners, spinners and summaries.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  shipped.dir = undefined;
  unwritable.dir = undefined;
  rmSync(root, { recursive: true, force: true });
});

/**
 * Writes a persona's, job's or soft-deleted persona's (a `.persona-trash`
 * entry's) compiled policy (`<home>/<kind>/<id>/generated/`); returns its
 * directory.
 */
function seedScopedPolicy(
  kind: 'personas' | 'jobs' | '.persona-trash',
  id: string,
  rules: CompiledPolicyFile['rules'],
): string {
  const dir = join(home, kind, id, 'generated');
  mkdirSync(dir, { recursive: true });
  const policy: CompiledPolicyFile = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    constitutionHash: 'c',
    inputHash: 'i',
    rules,
  };
  writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify(policy));
  return dir;
}

function policyFile(dir: string): CompiledPolicyFile {
  return JSON.parse(readFileSync(join(dir, 'compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
}

function ruleNames(dir: string): string[] {
  return policyFile(dir).rules.map((r) => r.name);
}

function deps(overrides: Partial<McpCommandDeps> = {}): McpCommandDeps {
  return {
    interactive: false,
    log: (line) => log.push(line),
    out: (line) => log.push(line),
    compilePolicy: () => Promise.reject(new Error('compile-policy must not run in this test')),
    customizePolicy: () => Promise.reject(new Error('customize-policy must not run in this test')),
    ...overrides,
  };
}

function userFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'mcp-servers.json'), 'utf-8')) as Record<string, unknown>;
}

/** sha256 of every file in the package's config directory (definitions and generated policy). */
function packageSnapshot(): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hashes.set(path, createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(PACKAGE_CONFIG_DIR);
  return hashes;
}

// ---------------------------------------------------------------------------
// Fakes for the two LLM steps
// ---------------------------------------------------------------------------

const PROBE_ANNOTATIONS = {
  annotations: [
    { toolName: 'report_cwd', comment: 'Reports the server working directory.', args: {} },
    { toolName: 'report_env', comment: 'Reports one environment variable.', args: { name: ['none'] } },
    { toolName: 'report_env_all', comment: 'Reports the whole environment.', args: {} },
  ],
};

function fakeAnnotationLlm(): (generatedDir: string) => Promise<PipelineLlm> {
  const model = new MockLanguageModelV3({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: JSON.stringify(PROBE_ANNOTATIONS) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: 'fake', modelId: 'fake', timestamp: new Date(0) },
      }),
  });
  return (generatedDir) =>
    Promise.resolve({
      model,
      baseLlm: model,
      logContext: { stepName: 'annotate' },
      logPath: join(generatedDir, 'llm-interactions.jsonl'),
      cacheStrategy: { wrapSystemPrompt: (text: string) => text },
    } as unknown as PipelineLlm);
}

/** An annotation model that fails every call, as without credentials or with the provider down. */
function failingAnnotationLlm(message: string): (generatedDir: string) => Promise<PipelineLlm> {
  const model = new MockLanguageModelV3({ doGenerate: () => Promise.reject(new Error(message)) });
  return (generatedDir) =>
    Promise.resolve({
      model,
      baseLlm: model,
      logContext: { stepName: 'annotate' },
      logPath: join(generatedDir, 'llm-interactions.jsonl'),
      cacheStrategy: { wrapSystemPrompt: (text: string) => text },
    } as unknown as PipelineLlm);
}

const PROBE_COMPILE: FakePhaseScript = {
  compile: [{ rules: [rule('allow-probe-cwd', 'probe', { tool: ['report_cwd'] })] }],
  scenarios: [
    {
      scenarios: [
        {
          description: 'report the working directory',
          request: { serverName: 'probe', toolName: 'report_cwd', arguments: {} },
          expectedDecision: 'allow',
          reasoning: 'The agent may see where the server runs.',
        },
        {
          description: 'read an environment variable',
          request: { serverName: 'probe', toolName: 'report_env', arguments: { name: 'HOME' } },
          expectedDecision: 'deny',
          reasoning: 'Nothing grants reading the environment.',
        },
      ],
    },
  ],
  scenarioRepair: [{ scenarios: [] }],
  judge: [PASS],
};

function compileWithFakes(script: FakePhaseScript): (argv: string[]) => Promise<number> {
  return (argv) => {
    const fake = createScriptedPipelineModels(script, join(root, 'pipeline-llm.jsonl'));
    return runCompilePolicy(argv, {
      createModels: () => Promise.resolve(fake.models),
      // The annotation step already started the server; skip the drift probe.
      checkLiveDrift: () => Promise.resolve(new Map()),
    });
  };
}

// ---------------------------------------------------------------------------
// Round trip (acceptance)
// ---------------------------------------------------------------------------

describe('mcp add round trip', () => {
  it('writes the server, annotates its tools and compiles its rules, all outside the package', async () => {
    const before = packageSnapshot();

    const status = await runMcpCommand(
      ['add', 'probe', '--sandbox', 'none', '--description', 'Probe server', '--', process.execPath, PROBE_SERVER],
      deps({ createAnnotationLlm: fakeAnnotationLlm(), compilePolicy: compileWithFakes(PROBE_COMPILE) }),
    );
    expect(status).toBe(0);

    // The definition, in the user file only (owner-only).
    expect(userFile()).toEqual({
      probe: { description: 'Probe server', command: process.execPath, args: [PROBE_SERVER], sandbox: false },
    });
    expect(statSync(join(home, 'mcp-servers.json')).mode & 0o777).toBe(0o600);

    // The annotations, in the user's overlay.
    const annotations = JSON.parse(
      readFileSync(join(home, 'generated', 'tool-annotations.json'), 'utf-8'),
    ) as StoredToolAnnotationsFile;
    expect(Object.keys(annotations.servers)).toEqual(['probe']);
    expect(annotations.servers.probe.tools.map((tool) => tool.toolName).sort()).toEqual([
      'report_cwd',
      'report_env',
      'report_env_all',
    ]);

    // The rules: compiled and verified for this server alone; the merged
    // policy is left untouched (compile-policy --server).
    const serverPolicy = JSON.parse(
      readFileSync(join(home, 'generated', 'servers', 'probe', 'compiled-policy.json'), 'utf-8'),
    ) as ServerCompiledPolicyFile;
    expect(serverPolicy.verified).toBe(true);
    expect(serverPolicy.rules.map((r) => r.name)).toEqual(['allow-probe-cwd']);
    expect(existsSync(join(home, 'generated', 'compiled-policy.json'))).toBe(false);

    // The package directory is exactly as it was.
    expect(packageSnapshot()).toEqual(before);

    // Every reader sees the server.
    expect(loadConfig().mcpServers.probe.command).toBe(process.execPath);
    expect(loadPipelineConfig().mcpServers.probe.args).toEqual([PROBE_SERVER]);

    // The report shows the annotations, the usable roles and what to run next.
    const text = log.join('\n');
    expect(text).toContain('Tool annotations for probe');
    expect(text).toContain('report_env: Reports one environment variable.');
    expect(text).toContain('name: none');
    // Every role but "none" is restricted to the built-ins it describes, and
    // the report says what that means for the new server.
    expect(text).toContain('Argument roles available to probe: none');
    expect(text).toMatch(
      /Not available \(src\/types\/argument-roles\.ts restricts them to other servers\): .*read-path/,
    );
    expect(text).toContain('but it inspects none of their arguments');
    expect(text).toContain('allow-probe-cwd: allow (tools: report_cwd)');
    expect(text).toContain('ironcurtain compile-policy');
    expect(text).toContain('WITHOUT OS containment');
  }, 60_000);

  it('offers customize-policy and the merged rebuild when interactive', async () => {
    const asked: string[] = [];
    const compileCalls: string[][] = [];
    const compile = compileWithFakes(PROBE_COMPILE);
    let customized = 0;
    const status = await runMcpCommand(
      ['add', 'probe', '--sandbox', 'none', '--', process.execPath, PROBE_SERVER],
      deps({
        interactive: true,
        prompts: {
          confirm: (message) => {
            asked.push(message);
            // Customize: yes. Rebuild the merged policy: no.
            return Promise.resolve(message.includes('customize-policy'));
          },
          secret: () => Promise.resolve(undefined),
        },
        createAnnotationLlm: fakeAnnotationLlm(),
        customizePolicy: () => {
          customized++;
          return Promise.resolve();
        },
        compilePolicy: (argv) => {
          compileCalls.push(argv);
          return compile(argv);
        },
      }),
    );
    expect(status).toBe(0);
    expect(customized).toBe(1);
    expect(compileCalls).toEqual([['--server', 'probe']]);
    expect(asked).toEqual([
      expect.stringContaining('ironcurtain customize-policy'),
      expect.stringContaining('Rebuild the merged policy now'),
    ]);
    expect(log.join('\n')).toContain('ironcurtain compile-policy');
  }, 60_000);
});

describe('mcp add activation (rebuilding the merged policy)', () => {
  function interactiveRebuild(script: FakePhaseScript): McpCommandDeps {
    return deps({
      interactive: true,
      prompts: {
        // customize-policy: no; rebuild the merged policy: yes.
        confirm: (message) => Promise.resolve(message.includes('Rebuild the merged policy')),
        secret: () => Promise.resolve(undefined),
      },
      createAnnotationLlm: fakeAnnotationLlm(),
      compilePolicy: compileWithFakes(script),
    });
  }

  beforeEach(() => {
    shipped.dir = join(root, 'shipped');
    mkdirSync(shipped.dir);
  });

  it('activates the server: the full run reuses its verified rules', async () => {
    const status = await runMcpCommand(
      ['add', 'probe', '--sandbox', 'none', '--', process.execPath, PROBE_SERVER],
      interactiveRebuild({ ...PROBE_COMPILE, prefilter: [{ skip: false, reason: 'the constitution covers it' }] }),
    );
    expect(status).toBe(0);
    const merged = JSON.parse(
      readFileSync(join(home, 'generated', 'compiled-policy.json'), 'utf-8'),
    ) as CompiledPolicyFile;
    expect(merged.rules.map((r) => r.name)).toEqual(['allow-probe-cwd']);
    expect(log.join('\n')).toContain('probe is in the active policy (1 rule(s)).');
  }, 60_000);

  it('says so when the pre-filter of the full run skipped the server', async () => {
    const status = await runMcpCommand(
      ['add', 'probe', '--sandbox', 'none', '--', process.execPath, PROBE_SERVER],
      interactiveRebuild({ ...PROBE_COMPILE, prefilter: [{ skip: true, reason: 'nothing mentions probe' }] }),
    );
    expect(status).toBe(0);
    const text = log.join('\n');
    expect(text).toContain(
      'The merged policy has no rules for probe: the server pre-filter skipped it as irrelevant to your ' +
        'constitution (nothing mentions probe).',
    );
    expect(text).toContain('ironcurtain customize-policy');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// mcp add: refusals and credentials
// ---------------------------------------------------------------------------

describe('mcp add', () => {
  it('refuses a built-in name, a reserved name and an existing server, writing nothing', async () => {
    expect(await runMcpCommand(['add', 'git', '--command', '/bin/true'], deps())).toBe(1);
    expect(log.join('\n')).toMatch(/"git" is a built-in server; its command, arguments and sandbox cannot be replaced/);
    expect(await runMcpCommand(['add', 'memory', '--command', '/bin/true'], deps())).toBe(1);
    expect(await runMcpCommand(['add', 'proxy', '--command', '/bin/true'], deps())).toBe(1);
    // The egress-policy namespace and the coordinator's workflow tool are
    // virtual servers too: a user server would share their rules.
    log = [];
    expect(await runMcpCommand(['add', 'network', '--command', '/bin/true'], deps())).toBe(1);
    expect(await runMcpCommand(['add', 'workflow', '--command', '/bin/true'], deps())).toBe(1);
    expect(log.join('\n')).toContain('the server name "network" is reserved');
    expect(log.join('\n')).toContain('the server name "workflow" is reserved');
    expect(existsSync(join(home, 'mcp-servers.json'))).toBe(false);

    expect(await runMcpCommand(['add', 'notes', '--command', '/bin/true', '--no-annotate'], deps())).toBe(0);
    const written = readFileSync(join(home, 'mcp-servers.json'), 'utf-8');
    log = [];
    expect(await runMcpCommand(['add', 'notes', '--command', '/bin/false', '--no-annotate'], deps())).toBe(1);
    expect(log.join('\n')).toContain('"notes" is already in your mcp-servers.json');
    expect(readFileSync(join(home, 'mcp-servers.json'), 'utf-8')).toBe(written);
  });

  it('keeps the definition and says how to recover when the server cannot be annotated', async () => {
    const status = await runMcpCommand(
      ['add', 'broken', '--sandbox', 'none', '--', join(root, 'missing-binary')],
      deps({ createAnnotationLlm: fakeAnnotationLlm() }),
    );
    expect(status).toBe(1);
    expect(Object.keys(userFile())).toEqual(['broken']);
    const text = log.join('\n');
    expect(text).toContain('annotating broken failed: the server could not be started or did not list its tools');
    expect(text).toContain('ironcurtain mcp remove broken');
    expect(existsSync(join(home, 'generated', 'tool-annotations.json'))).toBe(false);
  }, 30_000);

  // annotate-tools records a server whose annotation fails and goes on with
  // the others (WP-88). mcp add must still stop: the new server's tools were
  // never classified, so they are neither shown as its annotations nor
  // compiled.
  it('stops with the reason when the annotation model fails for the new server', async () => {
    let compiled = false;
    const status = await runMcpCommand(
      ['add', 'probe', '--sandbox', 'none', '--', process.execPath, PROBE_SERVER],
      deps({
        createAnnotationLlm: failingAnnotationLlm('policy model unavailable'),
        compilePolicy: () => {
          compiled = true;
          return Promise.resolve(0);
        },
      }),
    );
    expect(status).toBe(1);
    expect(compiled).toBe(false);
    expect(Object.keys(userFile())).toEqual(['probe']);
    const text = log.join('\n');
    expect(text).toContain('annotating probe failed: policy model unavailable');
    expect(text).toContain('ironcurtain annotate-tools --server probe');
    expect(text).not.toContain('Tool annotations for probe');
    const overlayPath = join(home, 'generated', 'tool-annotations.json');
    if (existsSync(overlayPath)) {
      const written = JSON.parse(readFileSync(overlayPath, 'utf-8')) as StoredToolAnnotationsFile;
      expect(Object.hasOwn(written.servers, 'probe')).toBe(false);
    }
  }, 30_000);

  it('refuses an invalid definition with the field error', async () => {
    expect(
      await runMcpCommand(['add', 'notes', '--command', 'bin/server', '--allow-domain', 'https://x.example'], deps()),
    ).toBe(1);
    const text = log.join('\n');
    expect(text).toContain('notes.command: "bin/server" is a relative path');
    expect(text).toMatch(/notes\.sandbox\.network\.allowedDomains\[0\]: is not a domain pattern/);
    expect(existsSync(join(home, 'mcp-servers.json'))).toBe(false);
  });

  it('--no-annotate only writes the definition and says what comes next', async () => {
    expect(
      await runMcpCommand(
        ['add', 'notes', '--command', '/opt/notes/server', '--allow-domain', 'api.notes.example', '--no-annotate'],
        deps(),
      ),
    ).toBe(0);
    expect(userFile()).toEqual({
      notes: {
        command: '/opt/notes/server',
        args: [],
        sandbox: { network: { allowedDomains: ['api.notes.example'] } },
      },
    });
    expect(log.join('\n')).toContain('ironcurtain annotate-tools --server notes');
  });

  it('drops rules that an earlier server of the same name left in the merged policy', async () => {
    const generated = join(home, 'generated');
    mkdirSync(generated, { recursive: true });
    const policy: CompiledPolicyFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [
        rule('old-notes-allow', 'notes', { tool: ['delete_note'] }),
        rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
      ],
    };
    writeFileSync(join(generated, 'compiled-policy.json'), JSON.stringify(policy));

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(0);

    const after = JSON.parse(readFileSync(join(generated, 'compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    expect(after.rules.map((r) => r.name)).toEqual(['keep-fs']);
    expect(log.join('\n')).toContain('Removed 1 rule(s) that an earlier server named "notes" left');
  });

  it('drops the rules an earlier server of the same name left in persona and job policies', async () => {
    // Sessions with a persona or a job load its own policy instead of the
    // merged one: the old server's rules there would allow the new server's
    // same-named tools.
    const writer = seedScopedPolicy('personas', 'writer', [
      rule('old-notes-delete', 'notes', { tool: ['delete_note'] }),
      rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
    ]);
    const nightly = seedScopedPolicy('jobs', 'nightly', [rule('old-notes-list', 'notes', { tool: ['list_notes'] })]);
    const other = seedScopedPolicy('personas', 'other', [rule('keep-git', 'git', { tool: ['git_status'] })]);
    const otherBefore = readFileSync(join(other, 'compiled-policy.json'), 'utf-8');
    const broken = join(home, 'personas', 'broken', 'generated');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'compiled-policy.json'), '{not json');

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(0);

    expect(ruleNames(writer)).toEqual(['keep-fs']);
    expect(ruleNames(nightly)).toEqual([]);
    // The constitution hash is kept: the persona stays current and denies the
    // new server until it is recompiled.
    expect(policyFile(writer).constitutionHash).toBe('c');
    expect(readFileSync(join(other, 'compiled-policy.json'), 'utf-8')).toBe(otherBefore);
    const text = log.join('\n');
    expect(text).toContain(
      'Removed 2 rule(s) that an earlier server named "notes" left in the policies of job nightly, persona writer.',
    );
    expect(text).toContain('The policy of persona broken could not be read');
    expect(Object.keys(userFile())).toEqual(['notes']);
  });

  it("drops them from a soft-deleted persona's policy too, so restoring it cannot bring them back", async () => {
    // `persona trash restore` puts a persona back with its policy as it was.
    const trashed = seedScopedPolicy('.persona-trash', 'writer-2026-11-01T00-00-00-000Z', [
      rule('old-notes-delete', 'notes', { tool: ['delete_note'] }),
      rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
    ]);

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(0);

    expect(ruleNames(trashed)).toEqual(['keep-fs']);
    expect(log.join('\n')).toContain(
      'Removed 1 rule(s) that an earlier server named "notes" left in the policies of ' +
        'deleted persona writer-2026-11-01T00-00-00-000Z.',
    );
  });

  it('adds nothing while a persona policy that names the server cannot be rewritten', async () => {
    const writer = seedScopedPolicy('personas', 'writer', [
      rule('old-notes-delete', 'notes', { tool: ['delete_note'] }),
    ]);
    unwritable.dir = writer;

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(1);

    expect(log.join('\n')).toMatch(
      /Cannot add "notes": the rules an earlier server of that name left in persona writer \(EACCES[^)]*\) could not be removed/,
    );
    expect(existsSync(join(home, 'mcp-servers.json'))).toBe(false);
    expect(ruleNames(writer)).toEqual(['old-notes-delete']);
  });

  it('leaves a persona or job policy that sessions refuse alone, and reports it', async () => {
    // Sessions read a policy without following a symlink at its name and
    // refuse one that other users can write (readPolicyArtifact). Narrowed
    // and written back, either would become a regular file of this user's
    // that sessions accept, with content they never trusted.
    const target = join(root, 'elsewhere', 'compiled-policy.json');
    mkdirSync(dirname(target), { recursive: true });
    const linkedPolicy: CompiledPolicyFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [
        rule('old-notes-delete', 'notes', { tool: ['delete_note'] }),
        rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
      ],
    };
    writeFileSync(target, JSON.stringify(linkedPolicy));
    const linked = join(home, 'personas', 'linked', 'generated');
    mkdirSync(linked, { recursive: true });
    symlinkSync(target, join(linked, 'compiled-policy.json'));
    const shared = seedScopedPolicy('jobs', 'shared', [rule('old-notes-list', 'notes', { tool: ['list_notes'] })]);
    const sharedPath = join(shared, 'compiled-policy.json');
    chmodSync(sharedPath, 0o666);
    const targetBefore = readFileSync(target, 'utf-8');
    const sharedBefore = readFileSync(sharedPath, 'utf-8');

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(0);

    expect(lstatSync(join(linked, 'compiled-policy.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(targetBefore);
    expect(readFileSync(sharedPath, 'utf-8')).toBe(sharedBefore);
    expect(statSync(sharedPath).mode & 0o777).toBe(0o666);
    const text = log.join('\n');
    expect(text).toContain('The policy of persona linked could not be read');
    expect(text).toContain('The policy of job shared could not be read');
    expect(text).not.toContain('Removed');
  });

  it('adds nothing while the merged policy is one sessions refuse', async () => {
    const generated = join(home, 'generated');
    mkdirSync(generated, { recursive: true });
    const policyPath = join(generated, 'compiled-policy.json');
    const policy: CompiledPolicyFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [rule('old-notes-allow', 'notes', { tool: ['delete_note'] })],
    };
    writeFileSync(policyPath, JSON.stringify(policy));
    chmodSync(policyPath, 0o666);
    const before = readFileSync(policyPath, 'utf-8');

    expect(await runMcpCommand(['add', 'notes', '--command', '/opt/notes/server', '--no-annotate'], deps())).toBe(1);

    expect(log.join('\n')).toMatch(
      /Cannot add "notes": your merged policy cannot be checked for rules an earlier server of that name left[\s\S]*Sessions refuse that policy too/,
    );
    expect(existsSync(join(home, 'mcp-servers.json'))).toBe(false);
    expect(readFileSync(policyPath, 'utf-8')).toBe(before);
    expect(statSync(policyPath).mode & 0o777).toBe(0o666);
  });

  it('asks for the declared credentials and stores them in config.json, not in mcp-servers.json', async () => {
    const asked: string[] = [];
    const status = await runMcpCommand(
      [
        'add',
        'notes',
        '--command',
        '/opt/notes/server',
        '--env',
        'NOTES_TOKEN',
        '--env',
        'NOTES_REGION=eu',
        '--no-annotate',
      ],
      deps({
        interactive: true,
        prompts: {
          confirm: () => Promise.resolve(false),
          secret: (message) => {
            asked.push(message);
            return Promise.resolve('s3cret');
          },
        },
      }),
    );
    expect(status).toBe(0);
    expect(asked).toEqual([expect.stringMatching(/^NOTES_TOKEN for notes/)]);
    expect(loadUserConfig({ readOnly: true }).serverCredentials.notes).toEqual({ NOTES_TOKEN: 's3cret' });
    expect(userFile()).toEqual({
      notes: { command: '/opt/notes/server', args: [], env: { NOTES_TOKEN: '', NOTES_REGION: 'eu' } },
    });
    expect(readFileSync(join(home, 'mcp-servers.json'), 'utf-8')).not.toContain('s3cret');
  });

  it('without a terminal, lists the credentials still to store', async () => {
    expect(
      await runMcpCommand(
        ['add', 'notes', '--command', '/opt/notes/server', '--env', 'NOTES_TOKEN', '--no-annotate'],
        deps(),
      ),
    ).toBe(0);
    expect(log.join('\n')).toMatch(/Not set: NOTES_TOKEN\. Store them with `ironcurtain config`/);
  });
});

describe('parseAddArgs', () => {
  function request(args: string[]) {
    const parsed = parseAddArgs(args);
    if (parsed.kind !== 'request') throw new Error(`expected a request, got ${JSON.stringify(parsed)}`);
    return parsed.request;
  }
  function problems(args: string[]): readonly string[] {
    const parsed = parseAddArgs(args);
    if (parsed.kind !== 'error') throw new Error(`expected problems, got ${JSON.stringify(parsed)}`);
    return parsed.problems;
  }

  it('takes the program from --command and --arg, or from after --', () => {
    expect(request(['notes', '--command', '/opt/s', '--arg', 'a', '--arg=-b']).definition).toEqual({
      command: '/opt/s',
      args: ['a', '-b'],
    });
    expect(request(['notes', '--', 'npx', '-y', '@scope/pkg@1.0.0']).definition).toEqual({
      command: 'npx',
      args: ['-y', '@scope/pkg@1.0.0'],
    });
    expect(request(['notes', '--command', 'npx', '--', '-y', 'pkg']).definition.args).toEqual(['-y', 'pkg']);
  });

  it('declares a credential as an empty env slot, or as -e after run for docker and podman', () => {
    expect(request(['n', '--env', 'TOKEN', '--env', 'MODE=fast', '--', 'npx', 'pkg']).definition.env).toEqual({
      TOKEN: '',
      MODE: 'fast',
    });
    const docker = request(['n', '--env', 'TOKEN', '--sandbox', 'none', '--', 'docker', 'run', '-i', 'img']).definition;
    expect(docker.args).toEqual(['run', '-e', 'TOKEN', '-i', 'img']);
    expect(docker.env).toBeUndefined();
    // Already forwarded: not added twice.
    expect(
      request(['n', '--env', 'TOKEN', '--', '/usr/bin/podman', 'run', '-e', 'TOKEN', 'img']).definition.args,
    ).toEqual(['run', '-e', 'TOKEN', 'img']);
    expect(problems(['n', '--env', 'TOKEN', '--', 'docker', 'pull', 'img'])[0]).toMatch(/no "run" argument/);
  });

  it('maps --sandbox and --allow-domain to the sandbox block', () => {
    expect(request(['n', '--sandbox', 'none', '--', 'docker', 'run', 'img']).definition.sandbox).toBe(false);
    expect(request(['n', '--allow-domain', 'a.example', '--', 'npx', 'pkg']).definition.sandbox).toEqual({
      network: { allowedDomains: ['a.example'] },
    });
    expect(request(['n', '--', 'npx', 'pkg']).definition.sandbox).toBeUndefined();
    expect(problems(['n', '--sandbox', 'none', '--allow-domain', 'a.example', '--', 'npx'])[0]).toMatch(
      /cannot be combined with --sandbox none/,
    );
    expect(problems(['n', '--sandbox', 'off', '--', 'npx'])[0]).toMatch(/--sandbox must be "default" or "none"/);
  });

  it('reports usage problems', () => {
    expect(problems(['--command', 'npx'])[0]).toMatch(/exactly one server name/);
    expect(problems(['a', 'b', '--command', 'npx'])[0]).toMatch(/exactly one server name/);
    expect(problems(['n'])[0]).toMatch(/give the program to run/);
    expect(problems(['n', '--env', 'A', '--env', 'A=1', '--', 'npx'])[0]).toMatch(/more than once/);
    expect(problems(['n', '--env', 'bad name', '--', 'npx'])[0]).toMatch(/not an environment variable name/);
    expect(problems(['n', '--bogus', '--', 'npx'])[0]).toMatch(/bogus/);
    expect(parseAddArgs(['--help']).kind).toBe('help');
  });

  it('--no-annotate implies --no-compile', () => {
    expect(request(['n', '--no-annotate', '--', 'npx'])).toMatchObject({ annotate: false, compile: false });
    expect(request(['n', '--no-compile', '--', 'npx'])).toMatchObject({ annotate: true, compile: false });
  });
});

// ---------------------------------------------------------------------------
// mcp remove
// ---------------------------------------------------------------------------

describe('mcp remove', () => {
  function seedServer(name: string): void {
    writeFileSync(
      join(home, 'mcp-servers.json'),
      JSON.stringify({
        _comment: 'mine',
        [name]: { command: '/opt/s', args: [] },
        other: { command: '/opt/o', args: [] },
      }),
      { mode: 0o600 },
    );
    const generated = join(home, 'generated');
    mkdirSync(join(generated, 'servers', name), { recursive: true });
    writeFileSync(join(generated, 'servers', name, 'compiled-policy.json'), '{}');
    const tool = { toolName: 'do', serverName: name, comment: 'c', args: {}, inputSchema: { type: 'object' } };
    writeFileSync(
      join(generated, 'tool-annotations.json'),
      JSON.stringify({ generatedAt: 'x', servers: { [name]: { inputHash: 'h', source: 'user', tools: [tool] } } }),
    );
    const policy: CompiledPolicyFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [rule(`allow-${name}`, name, { tool: ['do'] }), rule('keep-fs', 'filesystem', { tool: ['read_file'] })],
      failedServers: [{ serverName: name, phase: 'verifying', reason: 'r' }],
    };
    writeFileSync(join(generated, 'compiled-policy.json'), JSON.stringify(policy));
  }

  it('removes the definition, annotations, compile cache and merged rules of a server you added', async () => {
    seedServer('notes');
    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(0);

    expect(userFile()).toEqual({ _comment: 'mine', other: { command: '/opt/o', args: [] } });
    expect(existsSync(join(home, 'generated', 'servers', 'notes'))).toBe(false);
    expect(existsSync(join(home, 'generated', 'tool-annotations.json'))).toBe(false);
    const policy = JSON.parse(
      readFileSync(join(home, 'generated', 'compiled-policy.json'), 'utf-8'),
    ) as CompiledPolicyFile;
    expect(policy.rules.map((r) => r.name)).toEqual(['keep-fs']);
    expect(policy.failedServers).toBeUndefined();
    expect(log.join('\n')).toContain('Removed the MCP server notes.');
  });

  it('still drops the merged rules and the cache when the annotations file is damaged', async () => {
    seedServer('notes');
    writeFileSync(join(home, 'generated', 'tool-annotations.json'), '{not json');
    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(1);
    expect(Object.keys(userFile())).not.toContain('notes');
    const policy = JSON.parse(
      readFileSync(join(home, 'generated', 'compiled-policy.json'), 'utf-8'),
    ) as CompiledPolicyFile;
    expect(policy.rules.map((r) => r.name)).toEqual(['keep-fs']);
    expect(existsSync(join(home, 'generated', 'servers', 'notes'))).toBe(false);
    expect(log.join('\n')).toContain('ironcurtain annotate-tools --reset --server notes');
  });

  it('needs --yes without a terminal, and asks with one', async () => {
    seedServer('notes');
    expect(await runMcpCommand(['remove', 'notes'], deps())).toBe(1);
    expect(log.join('\n')).toContain('pass --yes');
    expect(Object.keys(userFile())).toContain('notes');

    const declined = deps({
      interactive: true,
      prompts: { confirm: () => Promise.resolve(false), secret: () => Promise.resolve(undefined) },
    });
    expect(await runMcpCommand(['remove', 'notes'], declined)).toBe(0);
    expect(Object.keys(userFile())).toContain('notes');
  });

  it('removes your adjustment of a built-in, but never the built-in itself', async () => {
    expect(await runMcpCommand(['remove', 'git', '--yes'], deps())).toBe(1);
    expect(log.join('\n')).toContain('built-in servers cannot be removed');

    writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({ git: { env: { LOG_LEVEL: 'debug' } } }), {
      mode: 0o600,
    });
    expect(await runMcpCommand(['remove', 'git', '--yes'], deps())).toBe(0);
    expect(userFile()).toEqual({});
    expect(loadMcpServers().adjustments).toEqual([]);
  });

  it('drops its rules from persona and job policies, so no later server of the name inherits them', async () => {
    seedServer('notes');
    const writer = seedScopedPolicy('personas', 'writer', [
      rule('allow-notes', 'notes', { tool: ['do'] }),
      rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
    ]);
    const nightly = seedScopedPolicy('jobs', 'nightly', [rule('allow-notes-job', 'notes', { tool: ['do'] })]);

    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(0);

    expect(ruleNames(writer)).toEqual(['keep-fs']);
    expect(ruleNames(nightly)).toEqual([]);
    expect(log.join('\n')).toContain('Removed 2 rule(s) for it from the policies of job nightly, persona writer.');
  });

  it('drops its stored scenarios and their recorded decisions, so the offline replay still matches', async () => {
    // compile-policy stores the scenarios it verified beside each policy, with
    // the decision each got, and `ironcurtain doctor` replays them against
    // the policy. Without its rules and annotations the removed server's
    // scenarios are denied now, and doctor would call the policy stale.
    seedServer('notes');
    const generated = join(home, 'generated');
    const writer = seedScopedPolicy('personas', 'writer', [
      rule('allow-notes', 'notes', { tool: ['do'] }),
      rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
    ]);
    const scenario = (serverName: string, toolName: string): TestScenario => ({
      description: `${serverName}/${toolName}`,
      request: { serverName, toolName, arguments: {} },
      expectedDecision: 'allow',
      reasoning: 'r',
      source: 'generated',
    });
    const stored: TestScenariosFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      scenarios: [scenario('notes', 'do'), scenario('filesystem', 'read_file'), scenario('notes', 'do')],
      replay: { allowedDirectory: join(root, 'sandbox'), decisions: ['allow', 'allow', 'allow'] },
    };
    writeFileSync(join(generated, 'test-scenarios.json'), JSON.stringify(stored));
    writeFileSync(join(writer, 'test-scenarios.json'), JSON.stringify(stored));

    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(0);

    // What doctor sees after the removal: no annotations for notes any more.
    const annotations: StoredToolAnnotationsFile = {
      generatedAt: 'x',
      servers: {
        filesystem: {
          inputHash: 'h',
          tools: [
            {
              toolName: 'read_file',
              serverName: 'filesystem',
              comment: 'Reads a file.',
              args: {},
              inputSchema: { type: 'object' },
            },
          ],
        },
      },
    };
    for (const dir of [generated, writer]) {
      const after = JSON.parse(readFileSync(join(dir, 'test-scenarios.json'), 'utf-8')) as TestScenariosFile;
      expect(after.inputHash).toBe('i');
      expect(after.scenarios.map((s) => s.request.serverName)).toEqual(['filesystem']);
      expect(after.replay).toEqual({ allowedDirectory: join(root, 'sandbox'), decisions: ['allow'] });
      const engine = new PolicyEngine(policyFile(dir), annotations, []);
      expect(replayRecordedDecisions(engine, after)).toEqual({ kind: 'replayed', replayed: 1, changes: [] });
    }
  });

  it("drops its rules from soft-deleted personas' policies, and says to purge one it could not rewrite", async () => {
    seedServer('notes');
    const id = 'writer-2026-11-01T00-00-00-000Z';
    const trashed = seedScopedPolicy('.persona-trash', id, [
      rule('allow-notes', 'notes', { tool: ['do'] }),
      rule('keep-fs', 'filesystem', { tool: ['read_file'] }),
    ]);
    const stuck = seedScopedPolicy('.persona-trash', 'reader-2026-11-02T00-00-00-000Z', [
      rule('allow-notes', 'notes', { tool: ['do'] }),
    ]);
    unwritable.dir = stuck;

    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(1);

    expect(ruleNames(trashed)).toEqual(['keep-fs']);
    const text = log.join('\n');
    expect(text).toContain(`Removed 1 rule(s) for it from the policies of deleted persona ${id}.`);
    expect(text).toContain('Could not remove its rules from deleted persona reader-2026-11-02T00-00-00-000Z: EACCES');
    expect(text).toContain(
      'Purge it (`ironcurtain persona trash purge reader-2026-11-02T00-00-00-000Z`) before giving another ' +
        'server this name.',
    );
  });

  it('says how to recompile a persona or job policy it could not rewrite', async () => {
    seedServer('notes');
    const writer = seedScopedPolicy('personas', 'writer', [rule('allow-notes', 'notes', { tool: ['do'] })]);
    const nightly = seedScopedPolicy('jobs', 'nightly', [rule('allow-notes-job', 'notes', { tool: ['do'] })]);
    unwritable.dir = writer;

    expect(await runMcpCommand(['remove', 'notes', '--yes'], deps())).toBe(1);

    expect(Object.keys(userFile())).not.toContain('notes');
    expect(ruleNames(nightly)).toEqual([]);
    const text = log.join('\n');
    expect(text).toContain('Could not remove its rules from persona writer: EACCES');
    expect(text).toContain('Run `ironcurtain persona compile writer` before giving another server this name.');
  });

  it('removes an entry whose name is invalid or reserved, touching nothing named after it', async () => {
    writeFileSync(
      join(home, 'mcp-servers.json'),
      JSON.stringify({
        MyServer: { command: '/opt/x', args: [] },
        memory: { command: '/opt/m', args: [] },
        ok: { command: '/opt/o', args: [] },
      }),
      { mode: 0o600 },
    );
    // What IronCurtain itself has under the reserved name.
    const generated = join(home, 'generated');
    mkdirSync(join(generated, 'servers', 'memory'), { recursive: true });
    const merged: CompiledPolicyFile = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [rule('memory-rule', 'memory', { tool: ['memory_context'] })],
    };
    writeFileSync(join(generated, 'compiled-policy.json'), JSON.stringify(merged));
    const writer = seedScopedPolicy('personas', 'writer', [
      rule('persona-memory', 'memory', { tool: ['memory_context'] }),
    ]);

    expect(await runMcpCommand(['remove', 'MyServer', '--yes'], deps())).toBe(0);
    let text = log.join('\n');
    expect(text).toContain('Removed the entry "MyServer" from your mcp-servers.json');
    // The file is still refused, and the report says why.
    expect(text).toMatch(/still has problems[\s\S]*memory: the server name "memory" is reserved/);

    log = [];
    expect(await runMcpCommand(['remove', 'memory', '--yes'], deps())).toBe(0);
    text = log.join('\n');
    expect(text).not.toContain('still has problems');
    expect(userFile()).toEqual({ ok: { command: '/opt/o', args: [] } });
    expect(loadMcpServers().userServers).toEqual(['ok']);
    expect(existsSync(join(generated, 'servers', 'memory'))).toBe(true);
    expect(ruleNames(generated)).toEqual(['memory-rule']);
    expect(ruleNames(writer)).toEqual(['persona-memory']);
  });

  it('fixes a file with several broken entries one entry at a time', async () => {
    writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({ a: { command: 'x' }, b: { command: 'y' } }), {
      mode: 0o600,
    });
    expect(await runMcpCommand(['remove', 'a', '--yes'], deps())).toBe(0);
    expect(log.join('\n')).toMatch(/still has problems[\s\S]*b\.args: missing/);
    expect(Object.keys(userFile())).toEqual(['b']);

    log = [];
    expect(await runMcpCommand(['remove', 'b', '--yes'], deps())).toBe(0);
    expect(log.join('\n')).not.toContain('still has problems');
    expect(loadMcpServers().userServers).toEqual([]);
  });

  it('can remove a broken entry, which is how a hand edit gets fixed', async () => {
    writeFileSync(
      join(home, 'mcp-servers.json'),
      JSON.stringify({ broken: { command: 'x' }, ok: { command: '/opt/o', args: [] } }),
      { mode: 0o600 },
    );
    expect(await runMcpCommand(['list'], deps())).toBe(1);
    expect(log.join('\n')).toContain('broken.args: missing');
    expect(await runMcpCommand(['remove', 'broken', '--yes'], deps())).toBe(0);
    expect(loadMcpServers().userServers).toEqual(['ok']);
  });

  it('reports a server that is not there', async () => {
    expect(await runMcpCommand(['remove', 'nothing', '--yes'], deps())).toBe(1);
    expect(log.join('\n')).toContain('no server named "nothing"');
  });
});

// ---------------------------------------------------------------------------
// mcp list and helpers
// ---------------------------------------------------------------------------

describe('mcp list', () => {
  it('lists built-in, adjusted and user servers with their sandbox, annotations and rules', async () => {
    writeFileSync(
      join(home, 'mcp-servers.json'),
      JSON.stringify({
        git: { env: { LOG_LEVEL: 'debug' } },
        notes: {
          command: '/opt/notes/server',
          args: ['--stdio'],
          sandbox: { network: { allowedDomains: ['a.example'] } },
        },
      }),
      { mode: 0o600 },
    );
    const { entries } = listMcpServers();
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('filesystem')).toMatchObject({ source: 'built-in', sandbox: 'os, no network, roots only' });
    expect(byName.get('fetch')).toMatchObject({ source: 'built-in', sandbox: 'none' });
    expect(byName.get('git')?.source).toBe('built-in, adjusted');
    expect(byName.get('git')?.annotatedTools).toBeGreaterThan(0);
    expect(byName.get('notes')).toMatchObject({
      source: 'yours',
      sandbox: 'os, 1 domain',
      command: '/opt/notes/server --stdio',
      annotatedTools: undefined,
      policyRules: 0,
    });

    expect(await runMcpCommand(['list'], deps())).toBe(0);
    const text = log.join('\n');
    expect(text).toMatch(/^NAME\s+SOURCE\s+SANDBOX\s+ANNOTATIONS\s+POLICY$/m);
    expect(text).toMatch(/^notes\s+yours\s+os, 1 domain\s+not annotated\s+no rules$/m);
    expect(text).toContain('Adjusted: git: env LOG_LEVEL');
  });
});

describe('withoutServer', () => {
  it('drops rules for the server alone, narrows shared rules and its failure records', () => {
    const shared: CompiledPolicyFile['rules'][number] = {
      ...rule('shared', 'a', { tool: ['t'] }),
      if: { server: ['a', 'notes'], tool: ['t'] },
    };
    const policy: CompiledPolicyFile = {
      generatedAt: '',
      constitutionHash: 'c',
      inputHash: 'i',
      rules: [rule('mine', 'notes', {}), shared, rule('other', 'b', { tool: ['u'] })],
      failedServers: [
        { serverName: 'notes', phase: 'verifying', reason: 'r' },
        { serverName: 'b', phase: 'compiling', reason: 'r' },
      ],
      skippedServers: [{ serverName: 'notes', reason: 'irrelevant' }],
    };
    const result = withoutServer(policy, 'notes');
    expect(result.changedRules).toBe(2);
    expect(result.changed).toBe(true);
    expect(result.policy.rules.map((r) => [r.name, r.if.server])).toEqual([
      ['shared', ['a']],
      ['other', ['b']],
    ]);
    expect(result.policy.failedServers).toEqual([{ serverName: 'b', phase: 'compiling', reason: 'r' }]);
    expect(result.policy.skippedServers).toBeUndefined();
    expect(withoutServer(policy, 'absent').changed).toBe(false);
  });
});

describe('scenariosWithoutServer', () => {
  const request = (serverName: string) => ({ serverName, toolName: 't', arguments: {} });

  it('drops the server scenarios with their recorded decisions, keeping the rest of the file', () => {
    const file = {
      generatedAt: 'g',
      constitutionHash: 'c',
      inputHash: 'i',
      scenarios: [{ request: request('notes') }, { request: request('a') }, { request: request('notes') }],
      replay: { allowedDirectory: '/sandbox', decisions: ['allow', 'escalate', 'deny'] },
    };
    expect(scenariosWithoutServer(file, 'notes')).toEqual({
      generatedAt: 'g',
      constitutionHash: 'c',
      inputHash: 'i',
      scenarios: [{ request: request('a') }],
      replay: { allowedDirectory: '/sandbox', decisions: ['escalate'] },
    });
    expect(scenariosWithoutServer({ ...file, replay: undefined }, 'notes')).toMatchObject({
      scenarios: [{ request: request('a') }],
    });
  });

  it('leaves a file alone when nothing is the server or it cannot be narrowed safely', () => {
    const scenarios = [{ request: request('notes') }, { request: request('a') }];
    expect(scenariosWithoutServer({ scenarios }, 'absent')).toBeUndefined();
    // Recorded decisions that do not line up with the scenarios: doctor
    // reports the file as damaged; dropping some would line others up wrongly.
    expect(scenariosWithoutServer({ scenarios, replay: { decisions: ['allow'] } }, 'notes')).toBeUndefined();
    expect(scenariosWithoutServer({ scenarios, replay: 'x' }, 'notes')).toBeUndefined();
    expect(scenariosWithoutServer({ scenarios: 'x' }, 'notes')).toBeUndefined();
    expect(scenariosWithoutServer(['x'], 'notes')).toBeUndefined();
  });
});
