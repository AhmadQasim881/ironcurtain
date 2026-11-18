/**
 * Memory in workflow shared-container mode, end to end through the real
 * default infrastructure factory.
 *
 * A shared-container bundle serves every persona in its scope through one
 * coordinator, and the memory server is trusted (it bypasses policy). One
 * bundle-wide memory server would therefore give every persona in the scope
 * the same database, so bundles run none, and the sessions that borrow them
 * must not tell the agent to call a memory tool that does not exist (no
 * memory prompt, no CLAUDE.md memory protocol). See
 * docs/designs/per-persona-memory-optin.md §1.2. One case runs the same
 * personas without `sharedContainer`, where each state builds its own bundle
 * and keeps its persona's own memory server and database.
 *
 * Everything below the orchestrator is real except the two pieces that need
 * Docker: `createDockerInfrastructure` returns a stub bundle (recording the
 * config the factory built), and `DockerAgentSession` is a scripted session
 * that records what `createSession` handed it. The orchestrator uses its own
 * default factory (no `createWorkflowInfrastructure` override), the
 * production session factory (`createWorkflowSessionFactory`), the real
 * `loadConfig()`, `createSession()`, memory gate and CLAUDE.md sync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { IronCurtainConfig, MCPServerConfig } from '../../src/config/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerAgentSessionDeps } from '../../src/docker/docker-agent-session.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import * as logger from '../../src/logger.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { createWorkflowSessionFactory } from '../../src/workflow/cli-support.js';
import {
  MEMORY_SERVER_NAME,
  buildMemoryServerConfig,
  buildTrustedServerSet,
} from '../../src/memory/memory-annotations.js';
import { resolveMemoryDbPath } from '../../src/memory/resolve-memory-path.js';
import { writePersonaPolicy } from '../fixtures/scoped-policy.js';
import {
  createDeps,
  createMockTab,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

/** What `createSession` handed one (scripted) Docker agent session. */
interface RecordedSession {
  readonly stateId: string | undefined;
  readonly persona: string | undefined;
  readonly systemPromptOverride: string | undefined;
  readonly mcpServers: Readonly<Record<string, MCPServerConfig>>;
  /** Whether CLAUDE.md existed in the bundle's conversation-state dir when the session was built. */
  readonly claudeMdPresent: boolean;
}

const mocks = vi.hoisted(() => ({
  createDockerInfrastructure: vi.fn(),
  /** Optional edit applied to every real `loadConfig()` result. */
  editConfig: undefined as ((config: IronCurtainConfig) => IronCurtainConfig) | undefined,
  sessions: [] as RecordedSession[],
  /** Artifacts each workflow state writes, keyed by state id. */
  outputsByState: new Map<string, readonly string[]>(),
}));

vi.mock('../../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/index.js')>();
  return {
    ...actual,
    loadConfig: (): IronCurtainConfig => {
      const config = actual.loadConfig();
      return mocks.editConfig ? mocks.editConfig(config) : config;
    },
  };
});

vi.mock('../../src/docker/docker-infrastructure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/docker-infrastructure.js')>()),
  createDockerInfrastructure: mocks.createDockerInfrastructure,
}));

// A memory server with the review quarantine, whatever this checkout's
// workspace build is: a workflow state refuses one without it (FU-05).
vi.mock('../../src/memory/memory-server-exports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/memory/memory-server-exports.js')>()),
  memoryServerHasReviewQuarantine: () => true,
}));

vi.mock('../../src/docker/docker-agent-session.js', async () => {
  const { MockSession, approvedResponse } = await import('./test-helpers.js');
  /**
   * Stands in for the container-driving session. Records its inputs, then
   * answers each turn by writing the state's artifacts into the workspace
   * (the session's allowed directory) and approving.
   */
  class ScriptedDockerAgentSession extends MockSession {
    constructor(deps: DockerAgentSessionDeps) {
      const stateId = deps.metricsStateId;
      const workspace = deps.config.allowedDirectory;
      super({
        responses: () => {
          for (const name of mocks.outputsByState.get(stateId ?? '') ?? []) {
            mkdirSync(join(workspace, '.workflow', name), { recursive: true });
            writeFileSync(join(workspace, '.workflow', name, `${name}.md`), `content for ${name}`);
          }
          return approvedResponse('done');
        },
      });
      const conversationStateDir = deps.infra.conversationStateDir;
      mocks.sessions.push({
        stateId,
        persona: deps.metricsPersonaId,
        systemPromptOverride: deps.systemPromptOverride,
        mcpServers: deps.config.mcpServers,
        claudeMdPresent: conversationStateDir !== undefined && existsSync(join(conversationStateDir, 'CLAUDE.md')),
      });
    }

    async initialize(): Promise<void> {}
  }
  return { DockerAgentSession: ScriptedDockerAgentSession };
});

type DefaultFactoryLoader = {
  loadDefaultInfrastructureFactory(): Promise<
    (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>
  >;
};

/** The arguments `createDockerInfrastructure` receives, as far as the stub reads them. */
type CreateInfraArgs = [
  config: IronCurtainConfig,
  mode: unknown,
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId: WorkflowId,
  scope: string,
];

/** A bundle as the real `createDockerInfrastructure` would return it, minus Docker. */
function makeStubBundle(...args: CreateInfraArgs): DockerInfrastructure {
  const [config, , bundleDir, workspaceDir, escalationDir, bundleId, workflowId, scope] = args;
  const conversationStateDir = join(bundleDir, 'conversation-state');
  mkdirSync(conversationStateDir, { recursive: true, mode: 0o700 });
  return {
    bundleId,
    workflowId,
    scope,
    bundleDir,
    workspaceDir,
    escalationDir,
    auditLogPath: config.auditLogPath,
    conversationStateDir,
    adapter: { id: 'claude-code' },
    systemPrompt: 'You are a shared-container test agent.',
    runtimeKind: 'docker',
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
    restageSkills: () => {},
  } as unknown as DockerInfrastructure;
}

/**
 * Installs a persona with no `memory` field (memory on by default) and a
 * fresh compiled policy (it records the hash of the persona's
 * constitution.md, which the runtime requires) that references only the
 * filesystem server. The rule escalates: an unconditioned `allow` would
 * grant broad access, which `resolvePersona` refuses for a persona without
 * the broad-policy opt-in.
 */
function installPersona(name: string): void {
  const home = process.env.IRONCURTAIN_HOME;
  if (!home) throw new Error('IRONCURTAIN_HOME not set; call stubPersonasForTest first');
  const personaDir = resolve(home, 'personas', name);
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir, 'persona.json'),
    JSON.stringify({ name, description: `The ${name} persona.`, createdAt: '2026-01-01T00:00:00.000Z' }),
  );
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
 * Two memory-enabled personas, one state each, sharing the default scope.
 * Two personas in one scope need `allowMixedPersonas: true`, which declares
 * the scope one trust domain (validateScopePersonaIsolation).
 */
const twoPersonaDef: WorkflowDefinition = {
  name: 'shared-memory-two-personas',
  description: 'Two memory-enabled personas in one shared-container scope',
  initial: 'research',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, allowMixedPersonas: true },
  states: {
    research: {
      type: 'agent',
      description: 'Research',
      persona: 'researcher',
      prompt: 'Research the task.',
      inputs: [],
      outputs: ['notes'],
      transitions: [{ to: 'write' }],
    },
    write: {
      type: 'agent',
      description: 'Write',
      persona: 'writer',
      prompt: 'Write it up.',
      inputs: ['notes'],
      outputs: ['report'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/** Memory tool names in either spelling (raw MCP or Code Mode). */
const MEMORY_TOOL_MENTION = /memory[._](context|store|recall)/u;

describe('workflow shared-container memory through the real default infrastructure factory', () => {
  let tmpDir: string;
  let cleanupPersonas: () => void;
  let orchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shared-container-memory-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, twoPersonaDef);
    installPersona('researcher');
    installPersona('writer');
    mocks.sessions.length = 0;
    mocks.outputsByState.clear();
    mocks.editConfig = undefined;
    mocks.createDockerInfrastructure.mockReset();
    mocks.createDockerInfrastructure.mockImplementation(async (...args: CreateInfraArgs) => makeStubBundle(...args));
    orchestrator = undefined;
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    // createSession routes console output to each state's session log; release it.
    logger.teardown();
    vi.restoreAllMocks();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('configures no memory server for the scope and emits no memory prompt or CLAUDE.md for either persona', async () => {
    for (const [stateId, state] of Object.entries(twoPersonaDef.states)) {
      if (state.type === 'agent') mocks.outputsByState.set(stateId, state.outputs);
    }
    const tab = createMockTab();
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        // The production session factory: real loadConfig() and createSession().
        createSession: createWorkflowSessionFactory(),
        createWorkflowTab: () => tab,
        // No createWorkflowInfrastructure: the orchestrator's default factory runs.
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, twoPersonaDef), 'task');
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // One bundle for the shared scope, built by the default factory from the
    // real server configuration: exactly the servers the policies reference,
    // and no memory server, so no persona can reach another's database.
    expect(mocks.createDockerInfrastructure).toHaveBeenCalledTimes(1);
    const [bundleConfig, mode, , , , , bundleWorkflowId, scope] = mocks.createDockerInfrastructure.mock
      .calls[0] as CreateInfraArgs;
    expect(mode).toEqual({ kind: 'docker', agent: 'claude-code' });
    expect(bundleWorkflowId).toBe(workflowId);
    expect(scope).toBe('primary');
    expect(Object.keys(bundleConfig.mcpServers)).toEqual(['filesystem']);
    expect(buildTrustedServerSet(bundleConfig.mcpServers).size).toBe(0);
    for (const server of Object.values(bundleConfig.mcpServers)) {
      expect(server.env?.MEMORY_DB_PATH).toBeUndefined();
    }

    // Each persona's state borrowed that bundle with the memory gate closed:
    // the persona prompt is there, the memory protocol is not, CLAUDE.md was
    // not seeded, and no memory server rode along in the session config.
    expect(mocks.sessions.map((s) => [s.stateId, s.persona])).toEqual([
      ['research', 'researcher'],
      ['write', 'writer'],
    ]);
    for (const session of mocks.sessions) {
      expect(session.systemPromptOverride).toContain(`## Persona: ${session.persona}`);
      expect(session.systemPromptOverride).not.toMatch(MEMORY_TOOL_MENTION);
      expect(session.claudeMdPresent).toBe(false);
      expect(Object.keys(session.mcpServers)).not.toContain(MEMORY_SERVER_NAME);
    }

    // The user is told why the memory-enabled personas run without memory.
    const notices = vi
      .mocked(tab.write)
      .mock.calls.map(([line]) => line)
      .filter((line) => line.startsWith('[memory]'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('researcher, writer');
  });

  it('gives each persona its own memory server and database when states do not share a container', async () => {
    // Without `sharedContainer`, every Docker state builds its own bundle
    // from its own session config, so per-persona memory is unchanged: the
    // gate only closes for sessions that borrow a shared bundle.
    const perStateDef: WorkflowDefinition = {
      ...twoPersonaDef,
      name: 'per-state-memory-two-personas',
      settings: { mode: 'docker', dockerAgent: 'claude-code' },
    };
    for (const [stateId, state] of Object.entries(perStateDef.states)) {
      if (state.type === 'agent') mocks.outputsByState.set(stateId, state.outputs);
    }
    const tab = createMockTab();
    const createWorkflowInfrastructure = vi.fn();
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: createWorkflowSessionFactory(),
        createWorkflowTab: () => tab,
        createWorkflowInfrastructure,
      }),
    );

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, perStateDef), 'task');
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // No shared bundle: each state's session built its own, with the
    // trusted memory server on that persona's database and namespace.
    expect(createWorkflowInfrastructure).not.toHaveBeenCalled();
    const memoryServers = mocks.createDockerInfrastructure.mock.calls.map((call) => {
      const [config] = call as CreateInfraArgs;
      expect([...buildTrustedServerSet(config.mcpServers)]).toEqual([MEMORY_SERVER_NAME]);
      const { env } = config.mcpServers[MEMORY_SERVER_NAME];
      return [env?.MEMORY_NAMESPACE, env?.MEMORY_DB_PATH];
    });
    expect(memoryServers).toEqual([
      ['researcher', resolveMemoryDbPath({ persona: 'researcher' })],
      ['writer', resolveMemoryDbPath({ persona: 'writer' })],
    ]);
    expect(resolveMemoryDbPath({ persona: 'researcher' })).not.toBe(resolveMemoryDbPath({ persona: 'writer' }));

    // Each persona is told about the memory it really has.
    expect(mocks.sessions.map((s) => s.persona)).toEqual(['researcher', 'writer']);
    for (const session of mocks.sessions) {
      expect(session.systemPromptOverride).toMatch(MEMORY_TOOL_MENTION);
      expect(session.claudeMdPresent).toBe(true);
      expect(Object.keys(session.mcpServers)).toContain(MEMORY_SERVER_NAME);
    }
    expect(vi.mocked(tab.write).mock.calls.filter(([line]) => line.startsWith('[memory]'))).toEqual([]);
  });

  it('never starts a memory server in a shared bundle, even when one is configured and required', async () => {
    // Defense in depth for the factory itself: a configured memory server
    // and a required set naming it must still not produce a bundle-wide
    // memory server that every persona in the scope would share.
    mocks.editConfig = (config) => ({
      ...config,
      mcpServers: {
        ...config.mcpServers,
        [MEMORY_SERVER_NAME]: buildMemoryServerConfig({
          dbPath: resolveMemoryDbPath({ persona: 'researcher' }),
          namespace: 'researcher',
        }),
      },
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();

    await factory({
      workflowId: 'workflow-memory-guard' as WorkflowId,
      bundleId: 'bundle-memory-guard' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tmpDir, 'control.sock'),
      workspacePath: join(tmpDir, 'workspace'),
      scope: 'primary',
      requiredServers: new Set(['filesystem', MEMORY_SERVER_NAME]),
      maxLanes: 1,
    });

    expect(mocks.createDockerInfrastructure).toHaveBeenCalledTimes(1);
    const [bundleConfig] = mocks.createDockerInfrastructure.mock.calls[0] as CreateInfraArgs;
    expect(Object.keys(bundleConfig.mcpServers)).toEqual(['filesystem']);
    expect(buildTrustedServerSet(bundleConfig.mcpServers).size).toBe(0);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      `not starting the "${MEMORY_SERVER_NAME}" server in shared-container scope "primary"`,
    );
  });
});
