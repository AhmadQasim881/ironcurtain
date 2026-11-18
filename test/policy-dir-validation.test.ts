/**
 * Tests for policyDir validation (src/config/validate-policy-dir.ts), both
 * through createSession() and directly.
 *
 * Verifies that policyDir must resolve to one of the exact directories
 * IronCurtain compiles policies into (the global, persona, job and package
 * ones), never to another place under the IronCurtain home such as an
 * agent-writable session sandbox, that no other user can write it, and that
 * the policy artifacts in it are not read through a symlink.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-policydir-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  mkdirSync(resolve(TEST_HOME, 'jobs/test-job/generated'), { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(async () => {
  // Some paths below initialize session logging before validation fails.
  // Tear it down explicitly so this file cannot leak process-level state into
  // the next Vitest file scheduled on the same worker.
  const logger = await import('../src/logger.js');
  logger.teardown();
  vi.doUnmock('ai');
  vi.doUnmock('@ai-sdk/anthropic');
  vi.resetModules();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// We test the validatePolicyDir logic indirectly through createSession,
// but we can also test the validation function directly by importing
// the module and checking the error path.

describe('policyDir containment validation', () => {
  it('rejects policyDir outside IronCurtain home', async () => {
    // Mock heavy session dependencies to isolate the validation check
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
    }));
    vi.doMock('@ai-sdk/anthropic', () => ({
      anthropic: vi.fn(),
      createAnthropic: vi.fn(),
    }));

    const { createSession } = await import('../src/session/index.js');
    const { SessionError } = await import('../src/types/errors.js');
    const { loadConfig } = await import('../src/config/index.js');

    const config = loadConfig();

    await expect(
      createSession({
        config,
        policyDir: '/tmp/evil-policy',
      }),
    ).rejects.toThrow(SessionError);

    await expect(
      createSession({
        config,
        policyDir: '/tmp/evil-policy',
      }),
    ).rejects.toThrow(/policyDir must be one of IronCurtain's compiled-policy directories/);
  });

  it('rejects policyDir with path traversal', async () => {
    const { createSession } = await import('../src/session/index.js');

    const config = (await import('../src/config/index.js')).loadConfig();

    // Attempt traversal from inside the home directory
    await expect(
      createSession({
        config,
        policyDir: resolve(TEST_HOME, 'jobs/../../../etc'),
      }),
    ).rejects.toThrow(/policyDir must be one of IronCurtain's compiled-policy directories/);
  });

  it('rejects policyDir that is a prefix-match but not a subdirectory', async () => {
    const { createSession } = await import('../src/session/index.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    // Create a directory that matches the prefix but is a sibling
    const evilDir = TEST_HOME + '-evil';
    mkdirSync(evilDir, { recursive: true });

    try {
      await expect(
        createSession({
          config,
          policyDir: evilDir,
        }),
      ).rejects.toThrow(/policyDir must be one of IronCurtain's compiled-policy directories/);
    } finally {
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it('accepts policyDir under IronCurtain home', async () => {
    // Keep this as a config-building assertion instead of calling the full
    // createSession() happy path. The full path starts MCP proxy subprocesses;
    // this test only owns policyDir containment validation.
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    const validPolicyDir = resolve(TEST_HOME, 'jobs/test-job/generated');
    // A schema-valid policy: the scoped loader validates the file
    // (src/types/policy-schema.ts) before the server filter reads it.
    writeCompiledPolicyFor(validPolicyDir, 'Test job constitution.\n');
    const sessionId = createSessionId();

    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, {
      policyDir: validPolicyDir,
    });

    expect(sessionConfig.config.generatedDir).toBe(realpathSync(validPolicyDir));
  });

  // Regression: a contained policyDir without its own compiled policy used to
  // pass, and every loader then fell back to the package's default policy, so a
  // job whose compile failed ran unattended under the broad default policy.
  it('refuses a contained policyDir that holds no compiled policy instead of falling back', async () => {
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const { SessionError } = await import('../src/types/errors.js');
    const config = (await import('../src/config/index.js')).loadConfig();
    const sessionId = createSessionId();

    for (const policyDir of [
      resolve(TEST_HOME, 'jobs/test-job/generated'), // exists, empty
      resolve(TEST_HOME, 'jobs/never-compiled/generated'), // does not exist
    ]) {
      expect(() => buildSessionConfig(config, sessionId, sessionId, { policyDir })).toThrow(SessionError);
      expect(() => buildSessionConfig(config, sessionId, sessionId, { policyDir })).toThrow(
        /No compiled policy .*refusing to fall back to the default policy/,
      );
    }
    // Refused before any session state was created.
    expect(existsSync(resolve(TEST_HOME, 'sessions', sessionId))).toBe(false);
  });
});

// Policy learning: a session's human approvals are recorded under the
// constitution whose policy it runs, and not at all for a policy directory no
// customize flow edits.
describe('approval-history scope', () => {
  it('is global without a policyDir, the job for its own policy dir, and unset otherwise', async () => {
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    const sessionId = createSessionId();
    expect(buildSessionConfig(config, sessionId, sessionId).config.approvalHistoryScope).toBe('global');

    const jobPolicyDir = resolve(TEST_HOME, 'jobs/test-job/generated');
    writeCompiledPolicyFor(jobPolicyDir, 'Test job constitution.\n');
    const jobSession = createSessionId();
    expect(
      buildSessionConfig(config, jobSession, jobSession, { policyDir: jobPolicyDir }).config.approvalHistoryScope,
    ).toBe('job:test-job');

    // A persona's policy dir given as a plain policyDir is not a job's.
    const otherDir = resolve(TEST_HOME, 'personas/reviewer/generated');
    writeCompiledPolicyFor(otherDir, 'Reviewer constitution.\n');
    const otherSession = createSessionId();
    expect(
      buildSessionConfig(config, otherSession, otherSession, { policyDir: otherDir }).config.approvalHistoryScope,
    ).toBeUndefined();
  });
});

// `ironcurtain audit report --workflow` finds a workflow state that ran as its
// own session (builtin, or Docker without sharedContainer) by the run its
// metadata names: that session's audit log lives under sessions/, not under
// the workflow run.
describe('workflow run in session metadata', () => {
  it('records the workflow run of a workflow state session, and nothing for other sessions', async () => {
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const { loadSessionMetadata } = await import('../src/session/session-metadata.js');
    const { createWorkflowId } = await import('../src/workflow/types.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    const workflowRunId = createWorkflowId();
    const stateSession = createSessionId();
    buildSessionConfig(config, stateSession, stateSession, { workflow: { workflowRunId, stateId: 'plan' } });
    expect(loadSessionMetadata(stateSession)?.workflowRunId).toBe(workflowRunId);

    const plainSession = createSessionId();
    buildSessionConfig(config, plainSession, plainSession);
    expect(loadSessionMetadata(plainSession)).toBeDefined();
    expect(loadSessionMetadata(plainSession)?.workflowRunId).toBeUndefined();
  });
});

// A resumed session restores policyDir from its metadata and so never passes
// the daemon's run-time job gate. Without this check a resumed cron job
// session kept running the job policy compiled from an older constitution.
describe('resumed cron job sessions', () => {
  const JOB_ID = 'nightly';
  const jobDir = (): string => resolve(TEST_HOME, 'jobs', JOB_ID);
  const jobPolicyDir = (): string => resolve(jobDir(), 'generated');

  /** Writes job.json with `constitution` and a policy compiled from `compiledFrom`. */
  function writeJob(constitution: string, compiledFrom: string): void {
    mkdirSync(jobDir(), { recursive: true });
    writeFileSync(
      resolve(jobDir(), 'job.json'),
      JSON.stringify({
        id: JOB_ID,
        name: 'Nightly',
        schedule: '0 9 * * *',
        taskDescription: 'Summarize the workspace.',
        taskConstitution: constitution,
        notifyOnEscalation: false,
        notifyOnCompletion: false,
        enabled: true,
      }),
    );
    writeCompiledPolicyFor(jobPolicyDir(), compiledFrom);
  }

  async function load() {
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const config = (await import('../src/config/index.js')).loadConfig();
    return { buildSessionConfig, sessionId: createSessionId(), config };
  }

  /** Returns what `fn` throws (fails the test when it does not throw). */
  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected the call to throw');
  }

  it('refuses to resume a job session whose job constitution changed after the policy was compiled', async () => {
    writeJob('The agent may read AND DELETE files anywhere.', 'The agent may read files in its workspace.');
    const { buildSessionConfig, sessionId, config } = await load();

    const err = thrownBy(() =>
      buildSessionConfig(config, sessionId, sessionId, { resumeSessionId: sessionId, policyDir: jobPolicyDir() }),
    );
    expect(err).toMatchObject({
      code: 'POLICY_STALE',
      message:
        'Job "nightly" has a stale compiled policy: the constitution changed after the policy was compiled. ' +
        'Recompile it with: ironcurtain daemon recompile-job nightly',
    });
    // Refused before the session logged or created anything.
    expect(existsSync(resolve(TEST_HOME, 'sessions', sessionId))).toBe(false);
  });

  it('refuses a resumed job session whose job definition is gone', async () => {
    writeJob('Read files.', 'Read files.');
    rmSync(resolve(jobDir(), 'job.json'));
    const { buildSessionConfig, sessionId, config } = await load();

    const err = thrownBy(() =>
      buildSessionConfig(config, sessionId, sessionId, { resumeSessionId: sessionId, policyDir: jobPolicyDir() }),
    );
    expect(err).toMatchObject({ code: 'POLICY_STALE', message: expect.stringMatching(/constitution is missing/) });
  });

  it('resumes a stale job session only on the explicit override, and logs the override', async () => {
    writeJob('Read and write anything.', 'Read only.');
    const { buildSessionConfig, sessionId, config } = await load();
    const logger = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn');

    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, {
      resumeSessionId: sessionId,
      policyDir: jobPolicyDir(),
      allowStalePolicy: true,
    });

    expect(sessionConfig.config.generatedDir).toBe(realpathSync(jobPolicyDir()));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Job "nightly" has a stale compiled policy: .*stale-policy override was given\.$/),
    );
  });

  it('resumes a job session whose policy matches the job constitution', async () => {
    writeJob('Read files.', 'Read files.');
    const { buildSessionConfig, sessionId, config } = await load();

    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, {
      resumeSessionId: sessionId,
      policyDir: jobPolicyDir(),
    });

    expect(sessionConfig.config.generatedDir).toBe(realpathSync(jobPolicyDir()));
  });
});

// ---------------------------------------------------------------------------
// validatePolicyDir: exact compiled-policy directories only
// ---------------------------------------------------------------------------

describe('validatePolicyDir: exact compiled-policy directories', () => {
  async function load() {
    const { validatePolicyDir, PolicyDirValidationError } = await import('../src/config/validate-policy-dir.js');
    const { getPackageConfigDir } = await import('../src/config/paths.js');
    return { validatePolicyDir, PolicyDirValidationError, packageConfig: realpathSync(getPackageConfigDir()) };
  }

  /** Creates `dir` (under the test home) holding a compiled policy, and returns it. */
  function policyDir(...segments: string[]): string {
    const dir = resolve(TEST_HOME, ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify({ rules: [] }));
    return dir;
  }

  it('accepts the global, persona, job and bundled policy directories', async () => {
    const { validatePolicyDir, packageConfig } = await load();
    for (const dir of [
      policyDir('generated'),
      policyDir('personas', 'coder', 'generated'),
      policyDir('jobs', 'nightly_2', 'generated'),
    ]) {
      expect(validatePolicyDir(dir)).toBe(realpathSync(dir));
    }
    expect(validatePolicyDir(resolve(packageConfig, 'generated'))).toBe(resolve(packageConfig, 'generated'));
    expect(validatePolicyDir(resolve(packageConfig, 'generated-readonly'))).toBe(
      resolve(packageConfig, 'generated-readonly'),
    );
  });

  // A published task scope (`--task-scoped`) is a compiled-policy directory
  // too; its staging directories and anything else in the cache are not.
  it('accepts a published task scope, not its staging directories or other names in the cache', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const key = 'ab'.repeat(32);
    const scope = policyDir('task-policies', key);
    expect(validatePolicyDir(scope)).toBe(realpathSync(scope));

    const rejected = [
      policyDir('task-policies', `.compile-${key}-12345`),
      policyDir('task-policies', 'AB'.repeat(32)),
      policyDir('task-policies', key.slice(1)),
      policyDir('task-policies', key, 'generated'),
      policyDir('task-policies', 'generated'),
      policyDir('task-policies-old', key),
      resolve(TEST_HOME, 'task-policies'),
    ];
    for (const dir of rejected) {
      expect(() => validatePolicyDir(dir), dir).toThrow(PolicyDirValidationError);
    }
  });

  // Regression: the whole IronCurtain home used to be trusted, so a policy an
  // agent wrote into its own session sandbox was accepted.
  it('rejects a policy directory in an agent-writable session sandbox', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    for (const dir of [policyDir('sessions', 'abc', 'sandbox'), policyDir('sessions', 'abc', 'sandbox', 'generated')]) {
      expect(() => validatePolicyDir(dir)).toThrow(PolicyDirValidationError);
      expect(() => validatePolicyDir(dir)).toThrow(
        /policyDir must be one of IronCurtain's compiled-policy directories/,
      );
    }
  });

  it('rejects every other directory under the IronCurtain home', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const rejected = [
      policyDir('personas', 'coder', 'workspace'),
      policyDir('personas', 'coder', 'workspace', 'generated'),
      policyDir('jobs', 'nightly', 'workspace', 'generated'),
      policyDir('workflow-runs', 'run-1', 'generated'),
      policyDir('.persona-trash', 'coder-2026-11-11T00-00-00Z', 'generated'),
      policyDir('personas', 'Not_A_Slug', 'generated'),
      policyDir('personas', 'generated'),
      policyDir('other', 'generated'),
      TEST_HOME,
      resolve(TEST_HOME, 'personas'),
    ];
    for (const dir of rejected) {
      expect(() => validatePolicyDir(dir), dir).toThrow(PolicyDirValidationError);
    }
  });

  it('rejects package directories other than the bundled policies', async () => {
    const { validatePolicyDir, PolicyDirValidationError, packageConfig } = await load();
    for (const dir of [packageConfig, resolve(packageConfig, 'generated-coding'), resolve(packageConfig, '..')]) {
      expect(() => validatePolicyDir(dir), dir).toThrow(PolicyDirValidationError);
    }
  });

  it('judges a symlinked policy directory by where it really is', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const sandboxPolicy = policyDir('sessions', 'abc', 'sandbox', 'evil');
    mkdirSync(resolve(TEST_HOME, 'personas', 'linked'), { recursive: true });
    const link = resolve(TEST_HOME, 'personas', 'linked', 'generated');
    symlinkSync(sandboxPolicy, link);

    expect(() => validatePolicyDir(link)).toThrow(PolicyDirValidationError);
  });

  it('rejects a policy directory that other users can write', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const dir = policyDir('personas', 'shared', 'generated');
    chmodSync(dir, 0o777);
    expect(() => validatePolicyDir(dir)).toThrow(PolicyDirValidationError);
    expect(() => validatePolicyDir(dir)).toThrow(/world-writable/);

    chmodSync(dir, 0o755);
    expect(validatePolicyDir(dir)).toBe(realpathSync(dir));
    // A writable directory above it lets the policy directory be replaced.
    chmodSync(resolve(TEST_HOME, 'personas'), 0o777);
    expect(() => validatePolicyDir(dir)).toThrow(/world-writable directory/);
  });

  it('leaves a directory that does not exist to the caller', async () => {
    const { validatePolicyDir } = await load();
    const missing = resolve(TEST_HOME, 'jobs', 'never-compiled', 'generated');
    expect(validatePolicyDir(missing)).toBe(resolve(realpathSync(TEST_HOME), 'jobs', 'never-compiled', 'generated'));
  });

  // Regression: a missing directory was accepted without any check, and the
  // path returned for it kept a dangling symlink, so once an agent created the
  // link's target in its sandbox, the caller's reads loaded that policy.
  it('rejects a missing policy directory reached through a dangling symlink', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const { loadPersonaPolicyArtifacts } = await import('../src/config/index.js');
    const sandboxTarget = resolve(TEST_HOME, 'sessions', 'abc', 'sandbox', 'evil');
    mkdirSync(resolve(TEST_HOME, 'personas'), { recursive: true });
    symlinkSync(sandboxTarget, resolve(TEST_HOME, 'personas', 'linked'));
    const viaLink = resolve(TEST_HOME, 'personas', 'linked', 'generated');
    mkdirSync(resolve(TEST_HOME, 'personas', 'coder'), { recursive: true });
    symlinkSync(resolve(sandboxTarget, 'generated'), resolve(TEST_HOME, 'personas', 'coder', 'generated'));
    const danglingLeaf = resolve(TEST_HOME, 'personas', 'coder', 'generated');

    for (const dir of [viaLink, danglingLeaf]) {
      expect(() => validatePolicyDir(dir), dir).toThrow(PolicyDirValidationError);
      expect(() => validatePolicyDir(dir), dir).toThrow(/dangling symlink/);
    }

    // What the dangling path would have led to: the agent's own policy.
    writeCompiledPolicyFor(resolve(sandboxTarget, 'generated'), 'Agent constitution.\n', {
      generatedAt: 'agent-written',
    });
    expect(loadPersonaPolicyArtifacts(viaLink).compiledPolicy.generatedAt).toBe('agent-written');
    // Now that the target exists, the canonical path names the sandbox.
    for (const dir of [viaLink, danglingLeaf]) {
      expect(() => validatePolicyDir(dir), dir).toThrow(
        /policyDir must be one of IronCurtain's compiled-policy directories/,
      );
    }
  });

  it('rejects a missing policy directory that another user could create', async () => {
    const { validatePolicyDir, PolicyDirValidationError } = await load();
    const missing = resolve(TEST_HOME, 'jobs', 'not-yet', 'generated');
    chmodSync(resolve(TEST_HOME, 'jobs'), 0o777);
    expect(() => validatePolicyDir(missing)).toThrow(PolicyDirValidationError);
    expect(() => validatePolicyDir(missing)).toThrow(/world-writable directory/);

    chmodSync(resolve(TEST_HOME, 'jobs'), 0o755);
    chmodSync(TEST_HOME, 0o777);
    expect(() => validatePolicyDir(missing)).toThrow(/world-writable directory/);
    chmodSync(TEST_HOME, 0o755);
    expect(validatePolicyDir(missing)).toBe(resolve(realpathSync(TEST_HOME), 'jobs', 'not-yet', 'generated'));
  });
});

// ---------------------------------------------------------------------------
// Policy artifacts are read without following symlinks
// ---------------------------------------------------------------------------

describe('policy artifact reads', () => {
  it('refuses a compiled-policy.json that is a symlink, even to a well-formed policy', async () => {
    const { loadPersonaPolicyArtifacts } = await import('../src/config/index.js');
    const dir = resolve(TEST_HOME, 'personas', 'coder', 'generated');
    mkdirSync(dir, { recursive: true });
    const outsideDir = resolve(TEST_HOME, 'sessions', 'abc', 'sandbox');
    writeCompiledPolicyFor(outsideDir, 'Agent constitution.\n');
    symlinkSync(resolve(outsideDir, 'compiled-policy.json'), resolve(dir, 'compiled-policy.json'));

    expect(() => loadPersonaPolicyArtifacts(dir)).toThrow(/must be a readable regular non-symlink file/);
  });

  it('refuses a world-writable policy artifact', async () => {
    const { loadPersonaPolicyArtifacts } = await import('../src/config/index.js');
    const dir = resolve(TEST_HOME, 'personas', 'coder', 'generated');
    writeCompiledPolicyFor(dir, 'Coder constitution.\n');
    writeFileSync(resolve(dir, 'dynamic-lists.json'), JSON.stringify({ generatedAt: 'test', lists: {} }));
    expect(loadPersonaPolicyArtifacts(dir).dynamicLists).toEqual({ generatedAt: 'test', lists: {} });

    chmodSync(resolve(dir, 'dynamic-lists.json'), 0o666);
    expect(() => loadPersonaPolicyArtifacts(dir)).toThrow(/must not be world-writable/);
  });

  it('does not fall back to the package policy when the primary artifact is a dangling symlink', async () => {
    const { loadGeneratedPolicy, getPackageGeneratedDir } = await import('../src/config/index.js');
    const dir = resolve(TEST_HOME, 'generated');
    symlinkSync(resolve(TEST_HOME, 'missing-target.json'), resolve(dir, 'compiled-policy.json'));

    expect(() =>
      loadGeneratedPolicy({
        policyDir: dir,
        toolAnnotationsDir: getPackageGeneratedDir(),
        fallbackDir: getPackageGeneratedDir(),
      }),
    ).toThrow(/must be a readable regular non-symlink file/);
  });
});
