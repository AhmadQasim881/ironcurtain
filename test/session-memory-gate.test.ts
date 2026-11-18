/**
 * Integration tests for the session-level memory gate.
 *
 * Exercises `buildSessionConfig` (and `buildDockerClaudeMd` indirectly)
 * to verify that the per-persona / per-job opt-in produces the expected
 * `mcpServers` shape, system-prompt content, and CLAUDE.md output.
 *
 * Coverage matches §9.3 of docs/designs/per-persona-memory-optin.md:
 *   - Persona opt-out: no memory server, no memory prompt, no CLAUDE.md.
 *   - Default-shape persona: memory present + persona augmentation present.
 *   - Default-shape cron job: memory present + cron memory prompt prepended.
 *   - Default session (no scope): memory off regardless of global flag.
 *   - Global kill switch overrides per-persona "on".
 *   - Borrowed workflow shared-container bundle: memory off (the bundle
 *     runs no memory server), so neither prompt nor CLAUDE.md mentions it.
 *   - Workflow state with no borrowed bundle: per-persona memory as in a
 *     standalone session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

import { buildSessionConfig } from '../src/session/index.js';
import { buildDockerClaudeMd } from '../src/docker/claude-md-seed.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-annotations.js';
import { createSessionId } from '../src/session/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { JobDefinition, JobId } from '../src/cron/types.js';
import type { PersonaDefinition } from '../src/persona/types.js';
import type { WorkflowId } from '../src/workflow/types.js';
import { isMemoryEnabledFor } from '../src/memory/memory-policy.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';
import { renamePersona } from '../src/persona/persona-service.js';
import { createPersonaName } from '../src/persona/types.js';

// A memory server with the review quarantine, whatever this checkout's
// workspace build is, unless a test says otherwise: cron and workflow sessions
// refuse one without it (FU-05, test/memory-annotations.test.ts).
const installedMemoryServer = vi.hoisted(() => ({ hasReviewQuarantine: true }));
vi.mock('../src/memory/memory-server-exports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/memory/memory-server-exports.js')>()),
  memoryServerHasReviewQuarantine: () => installedMemoryServer.hasReviewQuarantine,
}));

// Tests touch the user filesystem (persona dirs, job dirs) under a
// dedicated tmp home; pid suffix isolates parallel runs.
const TEST_HOME = `${REAL_TMP}/ironcurtain-session-memory-gate-test-${process.pid}`;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function createTestConfig(memoryEnabled: boolean): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
    },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
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
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: memoryEnabled, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * Writes a persona directory tree on disk with a minimal compiled policy
 * (so `loadGeneratedPolicy` succeeds inside `buildSessionConfig`).
 * The optional `memoryOptOut` flag adds `memory: { enabled: false }` to
 * persona.json, exercising the per-persona opt-out branch.
 */
function createTestPersonaOnDisk(name: string, opts: { memoryOptOut?: boolean } = {}): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  const generatedDir = resolve(personaDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });

  const definition: Record<string, unknown> = {
    name,
    description: `Test persona ${name}`,
    createdAt: '2026-04-27T00:00:00.000Z',
    ...(opts.memoryOptOut ? { memory: { enabled: false } } : {}),
  };
  writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(definition));

  // Minimal compiled-policy.json that references `filesystem` so
  // `filterMcpServersByPolicy` keeps it. Memory is bolted on after the
  // filter, so it doesn't need to appear here. The rule escalates: an
  // unconditioned `allow` would grant broad access, which `resolvePersona`
  // refuses for a persona without the broad-policy opt-in.
  writePersonaPolicy(personaDir, {
    rules: [
      {
        name: 'escalate-fs',
        description: 'test',
        principle: 'test',
        if: { server: ['filesystem'] },
        then: 'escalate',
        reason: 'test',
      },
    ],
  });
}

/**
 * Writes a minimal job directory + job.json so `loadJob(jobId)` returns a
 * definition matching `buildSessionConfig`'s expectations.
 */
function createTestJobOnDisk(id: string, opts: { memoryOptOut?: boolean } = {}): JobDefinition {
  const jobDir = resolve(TEST_HOME, 'jobs', id);
  mkdirSync(jobDir, { recursive: true });

  const job: JobDefinition = {
    id: id as JobId,
    name: `Test ${id}`,
    schedule: '0 * * * *',
    taskDescription: 'test',
    taskConstitution: 'test',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...(opts.memoryOptOut ? { memory: { enabled: false } } : {}),
  };
  writeFileSync(resolve(jobDir, 'job.json'), JSON.stringify(job, null, 2));
  return job;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
});

afterEach(() => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
  installedMemoryServer.hasReviewQuarantine = true;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSessionConfig memory gate', () => {
  it('omits the memory server and memory prompt when persona opts out', () => {
    createTestPersonaOnDisk('opt-out', { memoryOptOut: true });
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'opt-out' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // Persona augmentation is still emitted (header + description), but
    // the memory protocol fragment is gone — assert on the latter only.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).not.toContain('memory.context');
    expect(result.systemPromptAugmentation).not.toContain('memory_context');

    // CLAUDE.md path: the seeder must return undefined when memory is off.
    const claudeMd = buildDockerClaudeMd({ personaName: 'opt-out', memoryEnabled: false });
    expect(claudeMd).toBeUndefined();
  });

  it('includes memory server and memory prompt for a default-shape persona', () => {
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'default-persona' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeDefined();
    expect(result.systemPromptAugmentation).toBeDefined();
    // The MCP-namespaced memory tool names are spliced into the prompt.
    expect(result.systemPromptAugmentation).toContain('memory.context');

    // The Docker CLAUDE.md surface mirrors the same gate decision.
    const claudeMd = buildDockerClaudeMd({ personaName: 'default-persona', memoryEnabled: true });
    expect(claudeMd).toBeDefined();
    expect(claudeMd).toContain('memory.context');
  });

  it('hands the memory server its LLM key as its own credential, never in its config', () => {
    // The server config is serialized into the memory relay's
    // MCP_SERVERS_CONFIG; credentials travel only in that relay's
    // SERVER_CREDENTIALS, which it scrubs before spawning the server.
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'default-persona' });

    const memoryServer = result.config.mcpServers[MEMORY_SERVER_NAME];
    expect(memoryServer.env?.MEMORY_LLM_API_KEY).toBeUndefined();
    expect(JSON.stringify(memoryServer)).not.toContain('test-api-key');
    expect(result.config.userConfig.serverCredentials[MEMORY_SERVER_NAME]).toEqual({
      MEMORY_LLM_API_KEY: 'test-api-key',
    });
    // No other server is handed the key, and the caller's config is untouched.
    expect(Object.keys(result.config.userConfig.serverCredentials)).toEqual([MEMORY_SERVER_NAME]);
    expect(config.userConfig.serverCredentials).toBeUndefined();
  });

  it("keeps the user's stored credentials alongside the memory server's key", () => {
    createTestPersonaOnDisk('default-persona');
    const stored = { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_stored' }, memory: { EXTRA: 'kept' } };
    const config = createTestConfig(true);
    const withStored = { ...config, userConfig: { ...config.userConfig, serverCredentials: stored } };
    const sessionId = createSessionId();

    const result = buildSessionConfig(withStored, sessionId, sessionId, { persona: 'default-persona' });

    expect(result.config.userConfig.serverCredentials).toEqual({
      github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_stored' },
      memory: { EXTRA: 'kept', MEMORY_LLM_API_KEY: 'test-api-key' },
    });
    expect(stored.memory).toEqual({ EXTRA: 'kept' });
  });

  it('includes memory server and prepended cron prompt for a default-shape job', () => {
    const job = createTestJobOnDisk('default-job');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { jobId: job.id });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeDefined();
    // Non-persona cron sessions get the standalone memory prompt prepended,
    // so the augmentation must mention the memory tools.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).toContain('memory.context');
  });

  it('omits memory in default sessions (no persona, no job) regardless of global flag', () => {
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {});

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // No persona augmentation either — `systemPromptAugmentation` is whatever
    // the caller passed in (undefined here).
    expect(result.systemPromptAugmentation).toBeUndefined();
  });

  it('closes the gate for a default-shape persona on a borrowed workflow bundle', () => {
    // Workflow shared-container mode: the bundle's MCP servers were fixed by
    // the workflow's infrastructure factory, which never starts a memory
    // server, so the session must not add one or advertise the tool.
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const sessionId = createSessionId();
    const bundleDir = resolve(TEST_HOME, 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    const bundle = {
      bundleId: 'memory-gate-bundle',
      bundleDir,
      escalationDir: resolve(bundleDir, 'escalations'),
      auditLogPath: resolve(bundleDir, 'audit.jsonl'),
      restageSkills: () => {},
    } as unknown as DockerInfrastructure;

    const result = buildSessionConfig(config, sessionId, sessionId, {
      persona: 'default-persona',
      workflow: { infrastructure: bundle },
    });

    expect(result.memoryEnabled).toBe(false);
    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    const credentials = result.config.userConfig.serverCredentials as Record<string, unknown> | undefined;
    expect(credentials?.[MEMORY_SERVER_NAME]).toBeUndefined();
    // The persona prompt is still emitted; only the memory protocol is gone.
    expect(result.systemPromptAugmentation).toContain('## Persona: default-persona');
    expect(result.systemPromptAugmentation).not.toContain('memory.context');
    expect(result.systemPromptAugmentation).not.toContain('memory_context');
    // createDockerSession seeds CLAUDE.md from the same decision.
    expect(
      buildDockerClaudeMd({ personaName: 'default-persona', memoryEnabled: result.memoryEnabled }),
    ).toBeUndefined();
  });

  it('keeps per-persona memory for a workflow state that borrows no bundle', () => {
    // Per-state-container Docker workflows (no `sharedContainer`) and builtin
    // workflows pass a workflow record without `infrastructure`: the session
    // builds its own servers, so it gets its persona's memory server and
    // database exactly as a standalone session does.
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {
      persona: 'default-persona',
      workflow: { workflowRunId: 'wf-memory-gate' as WorkflowId, stateId: 'work', personaId: 'default-persona' },
    });

    expect(result.memoryEnabled).toBe(true);
    const memoryServer = result.config.mcpServers[MEMORY_SERVER_NAME];
    expect(memoryServer.env?.MEMORY_DB_PATH).toBe(resolve(TEST_HOME, 'personas', 'default-persona', 'memory.db'));
    expect(memoryServer.env?.MEMORY_NAMESPACE).toBe('default-persona');
    expect(result.systemPromptAugmentation).toContain('memory.context');
    expect(buildDockerClaudeMd({ personaName: 'default-persona', memoryEnabled: result.memoryEnabled })).toContain(
      'memory.context',
    );
  });

  it('a renamed persona keeps the namespace its memories were stored under, in its own moved database', () => {
    // `persona rename` moves memory.db with the persona and records the old
    // name as persona.json `memoryNamespace`, so the memories stay visible.
    createTestPersonaOnDisk('before');
    renamePersona(createPersonaName('before'), 'after', 'test');
    // The rename moved the policy aside (it named the old workspace): recompile.
    writePersonaPolicy(resolve(TEST_HOME, 'personas', 'after'), {
      rules: [
        {
          name: 'escalate-fs',
          description: 't',
          principle: 't',
          if: { server: ['filesystem'] },
          then: 'escalate',
          reason: 't',
        },
      ],
    });
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'after' });

    const memoryServer = result.config.mcpServers[MEMORY_SERVER_NAME];
    expect(memoryServer.env?.MEMORY_DB_PATH).toBe(resolve(TEST_HOME, 'personas', 'after', 'memory.db'));
    expect(memoryServer.env?.MEMORY_NAMESPACE).toBe('before');
  });

  // Every memory records who wrote it (WP-67). The kind and the session id come
  // from the session, never from the agent, so an unattended cron or workflow
  // run cannot pass its notes off as written in a session a person drove.
  it('tells the memory server which kind of session writes, and its id', () => {
    createTestPersonaOnDisk('default-persona');
    const job = createTestJobOnDisk('writer-job');
    const config = createTestConfig(true);

    const interactiveId = createSessionId();
    const interactive = buildSessionConfig(config, interactiveId, interactiveId, { persona: 'default-persona' });
    const cronId = createSessionId();
    const cron = buildSessionConfig(config, cronId, cronId, { jobId: job.id });
    const cronAsPersonaId = createSessionId();
    const cronAsPersona = buildSessionConfig(config, cronAsPersonaId, cronAsPersonaId, {
      persona: 'default-persona',
      jobId: job.id,
    });
    const workflowId = createSessionId();
    const workflow = buildSessionConfig(config, workflowId, workflowId, {
      persona: 'default-persona',
      workflow: { workflowRunId: 'wf-writer' as WorkflowId, stateId: 'work', personaId: 'default-persona' },
    });

    const writerEnv = (result: ReturnType<typeof buildSessionConfig>) => {
      const env = result.config.mcpServers[MEMORY_SERVER_NAME].env;
      return { kind: env?.MEMORY_WRITER_KIND, session: env?.MEMORY_SESSION_ID, scope: env?.MEMORY_WRITER_SCOPE };
    };
    // What an unattended session writes waits for review under its scope: the
    // job (its later runs see it) or the workflow run (its later states do).
    expect(writerEnv(interactive)).toEqual({ kind: 'interactive', session: interactiveId, scope: undefined });
    expect(writerEnv(cron)).toEqual({ kind: 'cron', session: cronId, scope: 'job:writer-job' });
    // A cron job running as a persona writes into the persona's memory, as cron.
    expect(writerEnv(cronAsPersona)).toEqual({ kind: 'cron', session: cronAsPersonaId, scope: 'job:writer-job' });
    expect(writerEnv(workflow)).toEqual({ kind: 'workflow', session: workflowId, scope: 'workflow:wf-writer' });
  });

  // FU-05: a memory server from before the review quarantine ignores the
  // scope and would show what the run writes to interactive sessions.
  it('refuses memory to cron and workflow sessions when the memory server predates the review quarantine', () => {
    installedMemoryServer.hasReviewQuarantine = false;
    createTestPersonaOnDisk('default-persona');
    const job = createTestJobOnDisk('writer-job');
    const config = createTestConfig(true);

    const cronId = createSessionId();
    expect(() => buildSessionConfig(config, cronId, cronId, { jobId: job.id })).toThrow(
      'predates the review quarantine',
    );
    const workflowId = createSessionId();
    expect(() =>
      buildSessionConfig(config, workflowId, workflowId, {
        persona: 'default-persona',
        workflow: { workflowRunId: 'wf-writer' as WorkflowId, stateId: 'work', personaId: 'default-persona' },
      }),
    ).toThrow('predates the review quarantine');

    // A session a person drives keeps its memory.
    const interactiveId = createSessionId();
    const interactive = buildSessionConfig(config, interactiveId, interactiveId, { persona: 'default-persona' });
    expect(interactive.config.mcpServers[MEMORY_SERVER_NAME].env?.MEMORY_WRITER_KIND).toBe('interactive');
  });

  // WP-95: models live in the IronCurtain home, verified against their pins;
  // memory.offlineModels keeps the server from downloading any.
  it('points the memory server at ~/.ironcurtain/models, offline when memory.offlineModels is on', () => {
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const onlineId = createSessionId();
    const online = buildSessionConfig(config, onlineId, onlineId, { persona: 'default-persona' });
    const offlineConfig: IronCurtainConfig = {
      ...config,
      userConfig: { ...config.userConfig, memory: { ...config.userConfig.memory, offlineModels: true } },
    };
    const offlineId = createSessionId();
    const offline = buildSessionConfig(offlineConfig, offlineId, offlineId, { persona: 'default-persona' });

    const onlineEnv = online.config.mcpServers[MEMORY_SERVER_NAME].env;
    expect(onlineEnv?.MEMORY_MODELS_DIR).toBe(resolve(TEST_HOME, 'models'));
    expect(onlineEnv?.MEMORY_MODELS_OFFLINE).toBeUndefined();
    const offlineEnv = offline.config.mcpServers[MEMORY_SERVER_NAME].env;
    expect(offlineEnv?.MEMORY_MODELS_DIR).toBe(resolve(TEST_HOME, 'models'));
    expect(offlineEnv?.MEMORY_MODELS_OFFLINE).toBe('true');
  });

  it('global kill switch overrides per-persona "on"', () => {
    createTestPersonaOnDisk('default-persona');
    // Global kill switch flipped off; persona has no `memory` field.
    const config = createTestConfig(false);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'default-persona' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // The persona augmentation is still produced (header + description),
    // but the memory protocol fragment is suppressed.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).not.toContain('memory.context');
  });
});

// ---------------------------------------------------------------------------
// Sanity checks: the gate helper agrees with the integration paths above.
// ---------------------------------------------------------------------------

describe('isMemoryEnabledFor — integration sanity', () => {
  it('agrees with buildSessionConfig for the persona-opt-out case', () => {
    const persona: PersonaDefinition = {
      name: 'opt-out' as PersonaDefinition['name'],
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
      memory: { enabled: false },
    };
    const config = createTestConfig(true);
    expect(isMemoryEnabledFor({ persona, userConfig: config.userConfig })).toBe(false);
  });

  it('agrees with buildSessionConfig for the default-shape persona case', () => {
    const persona: PersonaDefinition = {
      name: 'default-persona' as PersonaDefinition['name'],
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
    };
    const config = createTestConfig(true);
    expect(isMemoryEnabledFor({ persona, userConfig: config.userConfig })).toBe(true);
  });
});
