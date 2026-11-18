/**
 * WP-60 (GAP3-1): policy provenance.
 *
 *  - Every compile stamps a `provenance` block (versions, producer, model,
 *    content digests of the annotations each referenced server was compiled
 *    against); `assessPolicyProvenance` compares it with this IronCurtain.
 *  - Session creation (`buildSessionConfig`) and policy hot-swaps
 *    (`ToolCallCoordinator.loadPolicy` -> `loadPersonaPolicyArtifacts`) warn
 *    about a stale policy, or refuse it under `policy.onStale: "refuse"`.
 *  - The shipped compiled policies record the shipped annotations.
 *  - doctor reports provenance, replays stored scenarios offline and checks
 *    the universal handwritten invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { getPackageGeneratedDir, loadPersonaPolicyArtifacts } from '../src/config/index.js';
import { getReadOnlyPolicyDir, getSessionDir } from '../src/config/paths.js';
import {
  checkPolicyProvenance,
  classifyPolicySource,
  isStalePolicyRefusal,
  POLICY_PROVENANCE_STALE,
  policyRebuildHint,
} from '../src/config/policy-provenance-check.js';
import { computeAnnotationContentDigest, readToolAnnotationsFile } from '../src/config/tool-annotations-overlay.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import {
  checkPolicyInvariants,
  checkPolicyProvenanceStatus,
  checkPolicySource,
  checkStoredScenarioReplay,
  type LoadedPolicyArtifacts,
} from '../src/doctor/policy-checks.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  TestScenario,
  TestScenariosFile,
} from '../src/pipeline/types.js';
import {
  assessPolicyProvenance,
  buildPolicyProvenance,
  describePolicyStaleReason,
  ENGINE_SEMANTICS_VERSION,
  PIPELINE_VERIFIER_VERSION,
  POLICY_COMPILER_EPOCH,
  POLICY_PROVENANCE_SCHEMA_VERSION,
  type PolicyProvenance,
  withPolicyProvenance,
} from '../src/policy-artifacts/provenance.js';
import { recordScenarioDecisions, replayRecordedDecisions } from '../src/policy-artifacts/scenario-replay.js';
import { buildSessionConfig } from '../src/session/index.js';
import { createSessionId } from '../src/session/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import { VERSION } from '../src/version.js';
import { writePersonaPolicy as writeFreshPersonaPolicy } from './fixtures/scoped-policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATH_SCHEMA = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

const FS_TOOLS: StoredToolAnnotation[] = [
  {
    serverName: 'fs',
    toolName: 'read_file',
    comment: 'Reads a file.',
    args: { path: ['read-path'] },
    inputSchema: PATH_SCHEMA,
  },
];
const NEWS_TOOLS: StoredToolAnnotation[] = [
  {
    serverName: 'news',
    toolName: 'http_fetch',
    comment: 'Fetches a page.',
    args: { url: ['fetch-url'] },
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
];

function annotations(servers: Record<string, StoredToolAnnotation[]>): StoredToolAnnotationsFile {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    servers: Object.fromEntries(Object.entries(servers).map(([name, tools]) => [name, { inputHash: name, tools }])),
  };
}

const ANNOTATIONS = annotations({ fs: FS_TOOLS, news: NEWS_TOOLS, unused: NEWS_TOOLS });

function rule(name: string, server?: string[], cond: Partial<CompiledRule['if']> = {}): CompiledRule {
  return {
    name,
    description: 'd',
    principle: 'p',
    if: { ...(server ? { server } : {}), ...cond },
    then: 'allow',
    reason: 'r',
  };
}

function policyOf(rules: CompiledRule[], provenance?: PolicyProvenance): CompiledPolicyFile {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    constitutionHash: 'c',
    inputHash: 'i',
    ...(provenance ? { provenance } : {}),
    rules,
  };
}

const RULES = [rule('allow-fs', ['fs'], { tool: ['read_file'] }), rule('allow-news', ['news'])];

/** A policy compiled now, by this IronCurtain, against `against`. */
function currentPolicy(
  rules: CompiledRule[] = RULES,
  against: StoredToolAnnotationsFile = ANNOTATIONS,
): CompiledPolicyFile {
  return policyOf(rules, buildPolicyProvenance({ policy: { rules }, annotations: against }));
}

function withProvenance(policy: CompiledPolicyFile, changes: Partial<PolicyProvenance>): CompiledPolicyFile {
  if (!policy.provenance) throw new Error('fixture has no provenance');
  return { ...policy, provenance: { ...policy.provenance, ...changes } };
}

function staleKinds(policy: CompiledPolicyFile, against?: StoredToolAnnotationsFile): string[] {
  return assessPolicyProvenance(policy, against).staleReasons.map((r) => r.kind);
}

// ---------------------------------------------------------------------------
// Stamping and assessment
// ---------------------------------------------------------------------------

describe('buildPolicyProvenance', () => {
  it('records the current versions, the model, and a content digest per referenced server', () => {
    const provenance = buildPolicyProvenance({
      policy: { rules: RULES },
      annotations: ANNOTATIONS,
      policyModelId: 'anthropic:model-a',
    });
    expect(provenance).toEqual({
      schemaVersion: POLICY_PROVENANCE_SCHEMA_VERSION,
      producerVersion: VERSION,
      policyCompilerEpoch: POLICY_COMPILER_EPOCH,
      engineSemanticsVersion: ENGINE_SEMANTICS_VERSION,
      verifierVersion: PIPELINE_VERIFIER_VERSION,
      policyModelId: 'anthropic:model-a',
      // `unused` has annotations but no rules, so it is not recorded.
      annotationDigests: {
        fs: computeAnnotationContentDigest(FS_TOOLS),
        news: computeAnnotationContentDigest(NEWS_TOOLS),
      },
    });
  });

  it('omits the model when unknown and skips the reserved proxy server and unannotated servers', () => {
    const rules = [rule('p', ['proxy']), rule('ghost', ['ghost']), rule('fs', ['fs'])];
    const provenance = buildPolicyProvenance({ policy: { rules }, annotations: ANNOTATIONS });
    expect(provenance.policyModelId).toBeUndefined();
    expect(Object.keys(provenance.annotationDigests)).toEqual(['fs']);
  });

  it('keeps a server named "__proto__" as data', () => {
    const tricky = annotations({ ['__proto__']: FS_TOOLS });
    const provenance = buildPolicyProvenance({ policy: { rules: [rule('x', ['__proto__'])] }, annotations: tricky });
    expect(Object.hasOwn(provenance.annotationDigests, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(provenance.annotationDigests)).toBe(Object.prototype);
  });
});

describe('withPolicyProvenance', () => {
  it('replaces a block the policy already carries (re-stamping a shipped policy)', () => {
    // scripts/stamp-policy-provenance.ts re-stamps policies that are already
    // stamped, after a reviewed hand edit of the shipped annotations: the new
    // digests must win over the recorded ones.
    const changed = annotations({ fs: [{ ...FS_TOOLS[0], comment: 'changed' }], news: NEWS_TOOLS });
    const fresh = buildPolicyProvenance({ policy: { rules: RULES }, annotations: changed });
    const restamped = withPolicyProvenance(currentPolicy(), fresh);
    expect(restamped.provenance).toEqual(fresh);
    expect(Object.keys(restamped)).toEqual(['generatedAt', 'constitutionHash', 'inputHash', 'provenance', 'rules']);
    expect(assessPolicyProvenance(restamped, changed).staleReasons).toEqual([]);
  });
});

describe('assessPolicyProvenance', () => {
  it('finds nothing stale in a policy compiled now against the annotations in effect', () => {
    expect(assessPolicyProvenance(currentPolicy(), ANNOTATIONS)).toMatchObject({
      staleReasons: [],
      unscopedRules: [],
    });
  });

  it('reports a policy without provenance (compiled before it was recorded)', () => {
    const assessment = assessPolicyProvenance(policyOf(RULES), ANNOTATIONS);
    expect(assessment.staleReasons).toEqual([{ kind: 'no-provenance' }]);
    expect(describePolicyStaleReason(assessment.staleReasons[0])).toMatch(/records no provenance/);
  });

  it('reports a policy from an older compiler epoch', () => {
    const old = withProvenance(currentPolicy(), { policyCompilerEpoch: POLICY_COMPILER_EPOCH - 1 });
    const [reason] = assessPolicyProvenance(old, ANNOTATIONS).staleReasons;
    expect(reason).toEqual({
      kind: 'compiler-epoch',
      recorded: POLICY_COMPILER_EPOCH - 1,
      current: POLICY_COMPILER_EPOCH,
    });
    expect(describePolicyStaleReason(reason)).toMatch(/older policy compiler/);
  });

  it('reports other policy-engine semantics', () => {
    const other = withProvenance(currentPolicy(), { engineSemanticsVersion: ENGINE_SEMANTICS_VERSION + 1 });
    expect(staleKinds(other, ANNOTATIONS)).toEqual(['engine-semantics']);
  });

  it('reports changed annotation content even when the annotation inputHash is unchanged', () => {
    // A hand edit of a role (the #207 git case) keeps inputHash but changes content.
    const edited = annotations({
      fs: [{ ...FS_TOOLS[0], args: { path: ['write-path'] } }],
      news: NEWS_TOOLS,
      unused: NEWS_TOOLS,
    });
    expect(edited.servers.fs.inputHash).toBe(ANNOTATIONS.servers.fs.inputHash);
    expect(assessPolicyProvenance(currentPolicy(), edited).staleReasons).toEqual([
      { kind: 'annotations-changed', servers: ['fs'] },
    ]);
  });

  it('does not report an inputHash change when the annotation content is the same', () => {
    const rehashed: StoredToolAnnotationsFile = {
      ...ANNOTATIONS,
      servers: { ...ANNOTATIONS.servers, fs: { inputHash: 'other', tools: FS_TOOLS } },
    };
    expect(staleKinds(currentPolicy(), rehashed)).toEqual([]);
  });

  it('reports servers without a recorded digest, and servers whose annotations are gone', () => {
    const policy = currentPolicy();
    const noNewsDigest = withProvenance(policy, {
      annotationDigests: { fs: computeAnnotationContentDigest(FS_TOOLS) },
    });
    expect(assessPolicyProvenance(noNewsDigest, ANNOTATIONS).staleReasons).toEqual([
      { kind: 'annotations-unrecorded', servers: ['news'] },
    ]);
    expect(assessPolicyProvenance(policy, annotations({ fs: FS_TOOLS })).staleReasons).toEqual([
      { kind: 'annotations-missing', servers: ['news'] },
    ]);
  });

  it('compares versions only when no annotations are given', () => {
    const policy = currentPolicy();
    expect(staleKinds(policy)).toEqual([]);
    expect(staleKinds(withProvenance(policy, { policyCompilerEpoch: 0 }))).toEqual(['compiler-epoch']);
  });

  it('reports a malformed provenance block, and one from a newer format', () => {
    const malformed = { ...policyOf(RULES), provenance: { schemaVersion: 1 } } as unknown as CompiledPolicyFile;
    expect(staleKinds(malformed, ANNOTATIONS)).toEqual(['unreadable-provenance']);
    const newer = withProvenance(currentPolicy(), { schemaVersion: POLICY_PROVENANCE_SCHEMA_VERSION + 1 });
    expect(staleKinds(newer, ANNOTATIONS)).toEqual(['provenance-format']);
  });

  it('lists rules without a server condition (pre-0.9 format) without calling the policy stale', () => {
    const rules = [...RULES, rule('legacy-allow-everything')];
    const assessment = assessPolicyProvenance(currentPolicy(rules), ANNOTATIONS);
    expect(assessment.staleReasons).toEqual([]);
    expect(assessment.unscopedRules).toEqual(['legacy-allow-everything']);
  });
});

describe('the compiled policies shipped with IronCurtain', () => {
  const shipped = readToolAnnotationsFile(resolve(getPackageGeneratedDir(), 'tool-annotations.json'));

  it.each([
    ['generated', getPackageGeneratedDir()],
    ['generated-readonly', getReadOnlyPolicyDir()],
  ])('%s/compiled-policy.json records the shipped annotations and the current versions', (_name, dir) => {
    expect(shipped).toBeDefined();
    const policy = JSON.parse(readFileSync(resolve(dir, 'compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
    const assessment = assessPolicyProvenance(policy, shipped);
    expect(
      assessment.staleReasons.map(describePolicyStaleReason),
      'After reviewing that the shipped rules still hold, re-stamp: npx tsx scripts/stamp-policy-provenance.ts',
    ).toEqual([]);
    expect(assessment.unscopedRules).toEqual([]);
    expect(classifyPolicySource(resolve(dir, 'compiled-policy.json')).kind).toBe('package');
  });
});

// ---------------------------------------------------------------------------
// Load-time check
// ---------------------------------------------------------------------------

describe('checkPolicyProvenance', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp60-check-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const userPolicyPath = () => resolve(home, 'generated', 'compiled-policy.json');

  it('warns about a stale user policy with the reasons and the rebuild command, and uses it', () => {
    const lines: string[] = [];
    const assessment = checkPolicyProvenance(policyOf(RULES), userPolicyPath(), ANNOTATIONS, {
      report: (text) => lines.push(text),
    });
    expect(assessment.staleReasons).toHaveLength(1);
    const text = lines.join('');
    expect(text).toContain(`the compiled policy at ${userPolicyPath()} may be stale`);
    expect(text).toContain('records no provenance');
    expect(text).toContain('Run `ironcurtain compile-policy` to rebuild it.');
    expect(text).toContain('"onStale": "refuse"');
  });

  it('refuses a stale policy under onStale "refuse" with a POLICY_PROVENANCE_STALE error', () => {
    const lines: string[] = [];
    const old = withProvenance(currentPolicy(), { policyCompilerEpoch: 0 });
    let error: unknown;
    try {
      checkPolicyProvenance(old, userPolicyPath(), ANNOTATIONS, { onStale: 'refuse', report: (t) => lines.push(t) });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: POLICY_PROVENANCE_STALE, policyPath: userPolicyPath() });
    expect(isStalePolicyRefusal(error)).toBe(true);
    // Not the code of a scoped policy compiled from another constitution
    // (ScopedPolicyError, which --allow-stale-policy overrides): this refusal
    // is not overridable that way, so callers must be able to tell them apart.
    expect(POLICY_PROVENANCE_STALE).not.toBe('POLICY_STALE');
    expect(isStalePolicyRefusal({ code: 'POLICY_STALE' })).toBe(false);
    expect((error as Error).message).toMatch(/Refusing the compiled policy .* older policy compiler/);
    expect(lines).toEqual([]);
  });

  it('is silent for a current policy, even under onStale "refuse"', () => {
    const lines: string[] = [];
    checkPolicyProvenance(currentPolicy(), userPolicyPath(), ANNOTATIONS, {
      onStale: 'refuse',
      report: (t) => lines.push(t),
    });
    expect(lines).toEqual([]);
  });

  it('warns about pre-0.9 rules without a server condition, but never refuses them alone', () => {
    const lines: string[] = [];
    const policy = currentPolicy([...RULES, rule('legacy')]);
    checkPolicyProvenance(policy, userPolicyPath(), ANNOTATIONS, { onStale: 'refuse', report: (t) => lines.push(t) });
    expect(lines.join('')).toMatch(/1 rule\(s\) have no "server" condition .*"legacy"/);
  });

  it('names the command that rebuilds each kind of policy', () => {
    const personaPath = resolve(home, 'personas', 'coder', 'generated', 'compiled-policy.json');
    const jobPath = resolve(home, 'jobs', 'nightly', 'generated', 'compiled-policy.json');
    expect(policyRebuildHint(classifyPolicySource(personaPath, { persona: 'coder' }), '')).toContain(
      'ironcurtain persona compile coder',
    );
    expect(policyRebuildHint(classifyPolicySource(jobPath, { jobId: 'nightly' }), '')).toContain(
      'ironcurtain daemon recompile-job nightly',
    );
    // The global dir is the user's policy even when a workflow loads it for the "global" persona.
    expect(classifyPolicySource(userPolicyPath(), { persona: 'global' })).toEqual({ kind: 'user' });
    const shippedPath = resolve(getPackageGeneratedDir(), 'compiled-policy.json');
    expect(classifyPolicySource(shippedPath, { persona: 'coder' })).toEqual({ kind: 'package' });
    // `compile-policy` cannot rebuild the shipped read-only policy; resetting
    // the user's annotations (the usual cause) can.
    const readOnlyPath = resolve(getReadOnlyPolicyDir(), 'compiled-policy.json');
    expect(policyRebuildHint(classifyPolicySource(readOnlyPath), '')).toContain('`ironcurtain annotate-tools --reset`');
  });
});

// ---------------------------------------------------------------------------
// Session creation (buildSessionConfig)
// ---------------------------------------------------------------------------

describe('session creation checks the policy provenance', () => {
  let home: string;
  let stderr: string[];

  function createTestConfig(onStale?: 'warn' | 'refuse'): IronCurtainConfig {
    return {
      auditLogPath: './audit.jsonl',
      allowedDirectory: resolve(home, 'sandbox'),
      mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
      protectedPaths: [],
      generatedDir: resolve(home, 'generated'),
      constitutionPath: resolve(home, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: {
        agentModelId: 'anthropic:claude-sonnet-4-6',
        policyModelId: 'anthropic:claude-sonnet-4-6',
        anthropicApiKey: '',
        googleApiKey: '',
        openaiApiKey: '',
        escalationTimeoutSeconds: 300,
        resourceBudget: {
          maxTotalTokens: 1_000_000,
          maxSteps: 200,
          maxSessionSeconds: 1800,
          maxEstimatedCostUsd: 5.0,
          warnThresholdPercent: 80,
        },
        autoCompact: { enabled: false, thresholdTokens: 80_000, keepRecentMessages: 10, summaryModelId: 'a:b' },
        autoApprove: { enabled: false, modelId: 'a:b' },
        auditRedaction: { enabled: true },
        memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
        ...(onStale ? { policy: { onStale } } : {}),
      },
    } as unknown as IronCurtainConfig;
  }

  /** The annotations a session in this home evaluates with (the shipped ones: no overlay). */
  function shippedAnnotations(): StoredToolAnnotationsFile {
    const file = readToolAnnotationsFile(resolve(getPackageGeneratedDir(), 'tool-annotations.json'));
    if (!file) throw new Error('shipped annotations missing');
    return file;
  }

  const FS_RULES = [rule('allow-fs-list', ['filesystem'], { tool: ['list_allowed_directories'] })];

  function writePolicy(dir: string, policy: CompiledPolicyFile): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(policy));
  }

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp60-session-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    loggerModule.teardown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('warns on stderr and in the session log about a user policy from an older compiler epoch', () => {
    const current = currentPolicy(FS_RULES, shippedAnnotations());
    writePolicy(
      resolve(home, 'generated'),
      withProvenance(current, { policyCompilerEpoch: POLICY_COMPILER_EPOCH - 1 }),
    );
    const sessionId = createSessionId();

    const result = buildSessionConfig(createTestConfig(), sessionId, sessionId);

    const warning = stderr.join('');
    expect(warning).toContain('may be stale');
    expect(warning).toContain('older policy compiler');
    expect(warning).toContain('ironcurtain compile-policy');
    // The session still starts on it ("warn" is the default) ...
    expect(Object.keys(result.config.mcpServers)).toEqual(['filesystem']);
    // ... and the session log records the warning too.
    const log = readFileSync(resolve(getSessionDir(sessionId), 'session.log'), 'utf-8');
    expect(log).toContain('older policy compiler');
  });

  it('refuses a stale policy under policy.onStale "refuse" before creating anything for the session', () => {
    writePolicy(resolve(home, 'generated'), policyOf(FS_RULES));
    const sessionId = createSessionId();

    let error: unknown;
    try {
      buildSessionConfig(createTestConfig('refuse'), sessionId, sessionId);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ name: 'SessionError', code: 'SESSION_INIT_FAILED' });
    expect((error as Error).message).toMatch(/Refusing the compiled policy .*records no provenance/);
    expect(existsSync(getSessionDir(sessionId))).toBe(false);
    expect(loggerModule.isActive()).toBe(false);
  });

  it('warns about a policy compiled against other tool annotations than those in effect', () => {
    // The #207 case: the user compiled against an earlier revision of the
    // shipped annotations; versions and constitution hash cannot tell.
    const shipped = shippedAnnotations();
    const filesystem = shipped.servers.filesystem;
    const earlier: StoredToolAnnotationsFile = {
      ...shipped,
      servers: { ...shipped.servers, filesystem: { ...filesystem, tools: filesystem.tools.slice(1) } },
    };
    writePolicy(resolve(home, 'generated'), currentPolicy(FS_RULES, earlier));
    const sessionId = createSessionId();

    buildSessionConfig(createTestConfig(), sessionId, sessionId);

    expect(stderr.join('')).toContain('the tool annotations of "filesystem" changed since it was compiled');
  });

  it('is silent for a policy compiled by this IronCurtain against the annotations in effect', () => {
    writePolicy(resolve(home, 'generated'), currentPolicy(FS_RULES, shippedAnnotations()));
    const sessionId = createSessionId();

    buildSessionConfig(createTestConfig('refuse'), sessionId, sessionId);

    expect(stderr.join('')).not.toContain('stale');
  });

  /**
   * A persona whose policy was compiled from its current constitution (the
   * persona resolver refuses any other), with `policy` supplying the rest.
   */
  function writeReviewerPersona(policy: CompiledPolicyFile): string {
    const personaDir = resolve(home, 'personas', 'reviewer');
    mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
    writeFileSync(
      resolve(personaDir, 'persona.json'),
      JSON.stringify({ name: 'reviewer', description: 'Reviews', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    // The fixture records the hash of the persona's constitution.
    writeFreshPersonaPolicy(personaDir, { ...policy });
    return personaDir;
  }

  it('checks a persona policy and names the persona compile command', () => {
    const personaDir = writeReviewerPersona(policyOf(FS_RULES));
    const sessionId = createSessionId();

    buildSessionConfig(createTestConfig(), sessionId, sessionId, { persona: 'reviewer' });

    const warning = stderr.join('');
    expect(warning).toContain(resolve(personaDir, 'generated', 'compiled-policy.json'));
    expect(warning).toContain('records no provenance');
    expect(warning).toContain('ironcurtain persona compile reviewer');
  });

  it('compares a persona policy with the global annotations in effect', () => {
    // The persona's policy is read from its own directory only (no package
    // fallback), but the annotations it is evaluated with are the global ones.
    const shipped = shippedAnnotations();
    const filesystem = shipped.servers.filesystem;
    const earlier: StoredToolAnnotationsFile = {
      ...shipped,
      servers: { ...shipped.servers, filesystem: { ...filesystem, tools: filesystem.tools.slice(1) } },
    };
    writeReviewerPersona(currentPolicy(FS_RULES, earlier));
    const sessionId = createSessionId();

    expect(() => buildSessionConfig(createTestConfig('refuse'), sessionId, sessionId, { persona: 'reviewer' })).toThrow(
      /tool annotations of "filesystem" changed/,
    );
    expect(existsSync(getSessionDir(sessionId))).toBe(false);

    // Compiled against the annotations in effect, it is not stale.
    writeReviewerPersona(currentPolicy(FS_RULES, shipped));
    const freshId = createSessionId();
    const result = buildSessionConfig(createTestConfig('refuse'), freshId, freshId, { persona: 'reviewer' });
    expect(Object.keys(result.config.mcpServers)).toEqual(['filesystem']);
    expect(stderr.join('')).not.toContain('stale');
  });
});

// ---------------------------------------------------------------------------
// Policy hot-swap (coordinator -> loadPersonaPolicyArtifacts)
// ---------------------------------------------------------------------------

describe('policy hot-swap checks the provenance', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp60-swap-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function coordinator(policyOnStale?: 'warn' | 'refuse'): ToolCallCoordinator {
    return new ToolCallCoordinator({
      compiledPolicy: currentPolicy(),
      toolAnnotations: ANNOTATIONS,
      protectedPaths: [],
      allowedDirectory: resolve(home, 'sandbox'),
      auditLogPath: resolve(home, 'audit.jsonl'),
      ...(policyOnStale ? { policyOnStale } : {}),
    });
  }

  function writePersonaPolicy(policy: CompiledPolicyFile): string {
    const dir = resolve(home, 'personas', 'reviewer', 'generated');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify(policy));
    return dir;
  }

  it('refuses to swap in a stale persona policy under "refuse"; the old engine stays', async () => {
    const policyDir = writePersonaPolicy(withProvenance(currentPolicy(), { engineSemanticsVersion: 0 }));
    const c = coordinator('refuse');
    const before = c.getPolicyEngine();
    try {
      await expect(c.loadPolicy({ persona: 'reviewer', policyDir })).rejects.toMatchObject({
        code: POLICY_PROVENANCE_STALE,
      });
      expect(c.getPolicyEngine()).toBe(before);
    } finally {
      await c.close();
    }
  });

  it('swaps in a stale policy under the default "warn" and logs why it is stale', async () => {
    const warn = vi.spyOn(loggerModule, 'warn');
    const policyDir = writePersonaPolicy(policyOf(RULES));
    const c = coordinator();
    const before = c.getPolicyEngine();
    try {
      await c.loadPolicy({ persona: 'reviewer', policyDir });
      expect(c.getPolicyEngine()).not.toBe(before);
      expect(warn.mock.calls.map((call) => call[0]).join('\n')).toMatch(
        /records no provenance[\s\S]*ironcurtain persona compile reviewer/,
      );
    } finally {
      await c.close();
    }
  });

  it('refuses a persona policy compiled against other annotations than the coordinator retained', async () => {
    // Current versions, but its digest for "fs" is of other annotations.
    const other = annotations({ fs: [{ ...FS_TOOLS[0], comment: 'changed' }], news: NEWS_TOOLS });
    const policyDir = writePersonaPolicy(currentPolicy(RULES, other));
    const c = coordinator('refuse');
    const before = c.getPolicyEngine();
    try {
      await expect(c.loadPolicy({ persona: 'reviewer', policyDir })).rejects.toThrow(
        /tool annotations of "fs" changed/,
      );
      expect(c.getPolicyEngine()).toBe(before);
    } finally {
      await c.close();
    }
  });

  it('compares the annotations the coordinator retained', () => {
    const changed = annotations({ fs: [{ ...FS_TOOLS[0], comment: 'changed' }], news: NEWS_TOOLS });
    const policyDir = writePersonaPolicy(currentPolicy());
    expect(() =>
      loadPersonaPolicyArtifacts(policyDir, {
        provenanceCheck: { annotations: changed, onStale: 'refuse', report: () => {} },
      }),
    ).toThrow(/tool annotations of "fs" changed/);
    // Without a provenance check the loader only loads.
    expect(loadPersonaPolicyArtifacts(policyDir).compiledPolicy.rules).toHaveLength(RULES.length);
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor policy checks', () => {
  let home: string;
  const sandbox = '/wp60/sandbox';

  const FS_ANNOTATIONS: StoredToolAnnotationsFile = annotations({
    filesystem: [
      {
        serverName: 'filesystem',
        toolName: 'read_file',
        comment: 'Reads a file.',
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
        },
      },
    ],
  });
  const READ_ETC = rule('allow-read-etc', ['filesystem'], {
    tool: ['read_file'],
    paths: { roles: ['read-path'], within: '/etc' },
  });
  const SCENARIOS: TestScenario[] = [
    {
      description: 'read /etc/hosts',
      request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/hosts' } },
      expectedDecision: 'allow',
      reasoning: 'r',
      source: 'generated',
    },
    {
      description: 'write /etc/hosts',
      request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/etc/hosts', content: 'x' } },
      expectedDecision: 'deny',
      reasoning: 'r',
      source: 'generated',
    },
  ];

  function config(onStale?: 'refuse'): IronCurtainConfig {
    return {
      allowedDirectory: sandbox,
      protectedPaths: [],
      mcpServers: {},
      userConfig: onStale ? { policy: { onStale } } : {},
    } as unknown as IronCurtainConfig;
  }

  /** Writes `policy` and its scenarios (with decisions recorded under `against`) to the user dir. */
  function loaded(
    policy: CompiledPolicyFile,
    against: StoredToolAnnotationsFile,
    current: StoredToolAnnotationsFile = against,
  ): LoadedPolicyArtifacts {
    const dir = resolve(home, 'generated');
    mkdirSync(dir, { recursive: true });
    const engine = new PolicyEngine(policy, against, [], sandbox);
    const scenarios: TestScenariosFile = {
      generatedAt: 'x',
      constitutionHash: policy.constitutionHash,
      inputHash: policy.inputHash,
      scenarios: SCENARIOS,
      replay: { allowedDirectory: sandbox, decisions: recordScenarioDecisions(engine, SCENARIOS) },
    };
    writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(policy));
    writeFileSync(resolve(dir, 'test-scenarios.json'), JSON.stringify(scenarios));
    return {
      compiledPolicy: policy,
      compiledPolicyPath: resolve(dir, 'compiled-policy.json'),
      toolAnnotations: current,
      toolAnnotationsOverlay: { decisions: [] },
      dynamicLists: undefined,
    };
  }

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ic-wp60-doctor-'));
    vi.stubEnv('IRONCURTAIN_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('reports the source and a current provenance as ok', () => {
    const artifacts = loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS);
    expect(checkPolicySource(artifacts)).toMatchObject({
      status: 'ok',
      message: expect.stringMatching(/your compiled/),
    });
    expect(checkPolicyProvenanceStatus(config(), artifacts)).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('matches this IronCurtain'),
    });
  });

  it('warns about a user policy from an older compiler epoch, and fails under onStale "refuse"', () => {
    const old = withProvenance(currentPolicy([READ_ETC], FS_ANNOTATIONS), { policyCompilerEpoch: 0 });
    const artifacts = loaded(old, FS_ANNOTATIONS);
    expect(checkPolicyProvenanceStatus(config(), artifacts)).toMatchObject({
      name: 'Policy provenance',
      status: 'warn',
      message: expect.stringContaining('older policy compiler'),
      hint: expect.stringContaining('ironcurtain compile-policy'),
    });
    expect(checkPolicyProvenanceStatus(config('refuse'), artifacts).status).toBe('fail');
  });

  it('replays the stored scenarios: unchanged decisions are ok', () => {
    const artifacts = loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS);
    expect(checkStoredScenarioReplay(config(), artifacts)).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('2 stored scenario(s)'),
    });
  });

  it('replays the stored scenarios: a decision changed by an annotation change marks the policy stale', () => {
    // read_file's path is no longer a read-path: the read rule stops matching.
    const changed: StoredToolAnnotationsFile = {
      ...FS_ANNOTATIONS,
      servers: {
        filesystem: {
          inputHash: 'filesystem',
          tools: FS_ANNOTATIONS.servers.filesystem.tools.map((t) =>
            t.toolName === 'read_file' ? { ...t, args: { path: ['write-path'] } } : t,
          ),
        },
      },
    };
    const artifacts = loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS, changed);
    const result = checkStoredScenarioReplay(config(), artifacts);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/1 of 2 stored scenario\(s\).*"read \/etc\/hosts".*allow -> deny/);
  });

  it('skips the replay when the stored scenarios record no decisions', () => {
    const artifacts = loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS);
    const path = resolve(home, 'generated', 'test-scenarios.json');
    const file = JSON.parse(readFileSync(path, 'utf-8')) as TestScenariosFile;
    delete file.replay;
    writeFileSync(path, JSON.stringify(file));
    expect(checkStoredScenarioReplay(config(), artifacts)).toMatchObject({
      status: 'skip',
      message: expect.stringContaining('record no decisions'),
    });
    expect(replayRecordedDecisions(new PolicyEngine(artifacts.compiledPolicy, FS_ANNOTATIONS, []), file).kind).toBe(
      'not-recorded',
    );
  });

  it('reports a malformed policy or damaged stored scenarios as results instead of throwing', () => {
    const artifacts = loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS);

    // Rules that are not an array: sessions cannot load this policy either.
    const noRules = {
      ...artifacts,
      compiledPolicy: { ...artifacts.compiledPolicy, rules: undefined } as unknown as CompiledPolicyFile,
    };
    expect(checkPolicyProvenanceStatus(config(), noRules)).toMatchObject({
      name: 'Policy provenance',
      status: 'fail',
      message: expect.stringContaining('the compiled policy is malformed'),
      hint: expect.stringContaining('ironcurtain compile-policy'),
    });
    expect(checkPolicyInvariants(config(), noRules)).toMatchObject({
      name: 'Policy invariants',
      status: 'fail',
      message: expect.stringContaining('could not be evaluated'),
    });

    // A rule without `if`.
    const noIf = {
      ...artifacts,
      compiledPolicy: {
        ...artifacts.compiledPolicy,
        rules: [{ name: 'broken', then: 'allow' }],
      } as unknown as CompiledPolicyFile,
    };
    expect(checkPolicyProvenanceStatus(config(), noIf).status).toBe('fail');

    // A stored scenario that is not an object.
    const path = resolve(home, 'generated', 'test-scenarios.json');
    const file = JSON.parse(readFileSync(path, 'utf-8')) as TestScenariosFile;
    writeFileSync(path, JSON.stringify({ ...file, scenarios: [null, ...file.scenarios.slice(1)] }));
    expect(checkStoredScenarioReplay(config(), artifacts)).toMatchObject({
      name: 'Scenario replay',
      status: 'warn',
      message: expect.stringContaining('the stored scenarios could not be replayed'),
    });
  });

  it('warns when the active policy breaks a universal invariant (a write outside the sandbox is allowed)', () => {
    const permissive = rule('allow-all-writes', ['filesystem'], { tool: ['write_file', 'move_file'] });
    const artifacts = loaded(currentPolicy([READ_ETC, permissive], FS_ANNOTATIONS), FS_ANNOTATIONS);
    const result = checkPolicyInvariants(config(), artifacts);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Write file outside sandbox -- not allowed');
    expect(
      checkPolicyInvariants(config(), loaded(currentPolicy([READ_ETC], FS_ANNOTATIONS), FS_ANNOTATIONS)),
    ).toMatchObject({ status: 'ok' });
  });
});
