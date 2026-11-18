/**
 * Conversation continuity and per-session configuration at the
 * DockerAgentSession seam, for the adapters whose CLI does not accept a
 * caller-chosen conversation id (Codex) or names its sessions (Goose).
 *
 * Uses `scriptedExec` at the `docker.exec` seam, so no agent binary or Docker
 * daemon is needed. The conversation-state directory and the host-only record
 * store are real directories, laid out as the CLIs and the session leave them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerAgentSession } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { AgentAdapter, AgentId } from '../src/docker/agent-adapter.js';
import { getAgent, registerBuiltinAdapters } from '../src/docker/agent-registry.js';
import { createCodexAdapter } from '../src/docker/adapters/codex.js';
import { createGooseAdapter } from '../src/docker/adapters/goose.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentConversationId, BundleId, SessionId } from '../src/session/types.js';
import type { DockerExecResult } from '../src/docker/types.js';
import {
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
  scriptedExec,
} from './helpers/docker-mocks.js';

const CONVERSATION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e' as AgentConversationId;
const THREAD_ID = '01a1b67b-5e92-7fb0-aa3e-ebe122186d0b';

function codexTurn(text: string, threadId = THREAD_ID): DockerExecResult {
  return {
    exitCode: 0,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'),
    stderr: '',
  };
}

function gooseTurn(text: string): DockerExecResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }),
    stderr: '',
  };
}

const CLAUDE_OK: DockerExecResult = {
  exitCode: 0,
  stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { output_tokens: 1 } }),
  stderr: '',
};

function baseConfig(userConfig: Record<string, unknown> = {}, agentModelId?: string): IronCurtainConfig {
  return {
    mcpServers: {},
    ...(agentModelId === undefined ? {} : { agentModelId }),
    userConfig: {
      anthropicApiKey: 'sk-test',
      resourceBudget: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
      escalationTimeoutSeconds: 120,
      auditRedaction: { enabled: true },
      ...(agentModelId === undefined ? {} : { agentModelId }),
      ...userConfig,
    },
  } as unknown as IronCurtainConfig;
}

interface Bundle {
  readonly bundleDir: string;
  readonly stateDir: string | undefined;
}

describe('DockerAgentSession conversation continuity', () => {
  let tempDir: string;
  const sessions: DockerAgentSession[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-continuity-'));
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close().catch(() => {});
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A bundle dir with the adapter's conversation-state dir, as `prepareConversationStateDir` makes it. */
  function makeBundle(adapter: AgentAdapter): Bundle {
    const bundleDir = join(tempDir, 'bundle');
    mkdirSync(join(bundleDir, 'escalations'), { recursive: true });
    const stateConfig = adapter.getConversationStateConfig?.();
    const stateDir = stateConfig ? join(bundleDir, stateConfig.hostDirName) : undefined;
    if (stateDir) mkdirSync(stateDir, { recursive: true });
    return { bundleDir, stateDir };
  }

  async function startSession(options: {
    readonly adapter: AgentAdapter;
    readonly bundle: Bundle;
    readonly exec: (container: string, cmd: readonly string[]) => Promise<DockerExecResult>;
    readonly config?: IronCurtainConfig;
    readonly agentConversationId?: AgentConversationId;
  }): Promise<DockerAgentSession> {
    const { adapter, bundle } = options;
    const sandboxDir = join(tempDir, 'sandbox');
    mkdirSync(sandboxDir, { recursive: true });
    const stateConfig = adapter.getConversationStateConfig?.();
    const infra: DockerInfrastructure = {
      bundleId: 'test-bundle' as BundleId,
      bundleDir: bundle.bundleDir,
      workspaceDir: sandboxDir,
      escalationDir: join(bundle.bundleDir, 'escalations'),
      auditLogPath: join(tempDir, 'audit.jsonl'),
      proxy: createMockProxy(join(tempDir, 'proxy.sock')),
      mitmProxy: createMockMitmProxy(),
      docker: createMockDocker({ exec: options.exec }),
      adapter,
      ca: createMockCA(tempDir),
      fakeKeys: new Map([['api.anthropic.com', 'sk-fake']]),
      orientationDir: join(bundle.bundleDir, 'orientation'),
      systemPrompt: 'SYSTEM PROMPT',
      image: 'ironcurtain-test:latest',
      useTcp: false,
      socketsDir: join(tempDir, 'sockets'),
      mitmAddr: { socketPath: join(tempDir, 'mitm.sock') },
      authKind: 'apikey',
      containerId: 'container-abc123',
      containerName: 'ironcurtain-test',
      ...(bundle.stateDir && stateConfig
        ? { conversationStateDir: bundle.stateDir, conversationStateConfig: stateConfig }
        : {}),
      beginCaptureSession: () => {},
      endCaptureSession: async () => {},
    } as unknown as DockerInfrastructure;
    const session = new DockerAgentSession({
      config: options.config ?? baseConfig(),
      sessionId: `session-${sessions.length}` as SessionId,
      agentConversationId: options.agentConversationId ?? CONVERSATION_ID,
      infra,
      // Borrow mode, like a workflow state: close() leaves the bundle alone.
      ownsInfra: false,
    });
    sessions.push(session);
    await session.initialize();
    return session;
  }

  /** Write the rollout Codex leaves for a thread in its state dir. */
  function writeRollout(stateDir: string, threadId = THREAD_ID): void {
    const dayDir = join(stateDir, 'sessions', '2026', '11', '11');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, `rollout-2026-11-11T10-00-00-${threadId}.jsonl`), '{"type":"session_meta"}\n');
  }

  describe('Codex', () => {
    it('runs a second turn as codex exec resume <thread> with the message alone', async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const { exec, calls } = scriptedExec([codexTurn('first answer'), codexTurn('second answer')]);
      const session = await startSession({ adapter, bundle, exec });

      expect(await session.sendMessage('first request')).toBe('first answer');
      expect(await session.sendMessage('second request')).toBe('second answer');

      expect(calls[0]).not.toContain('resume');
      expect(calls[0].at(-1)).toContain('SYSTEM PROMPT');
      expect(calls[1].slice(calls[1].indexOf('resume'))).toEqual(['resume', '--', THREAD_ID, 'second request']);
      expect(calls[1]).not.toContain('--last');
    });

    it('resumes the recorded thread in a later session that continues the conversation', async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const first = await startSession({ adapter, bundle, exec: scriptedExec([codexTurn('done')]).exec });
      await first.sendMessage('first visit');
      await first.close();
      writeRollout(bundle.stateDir as string);

      // The workflow re-enters the state with freshSession: false.
      const { exec, calls } = scriptedExec([codexTurn('continued')]);
      const second = await startSession({ adapter, bundle, exec });
      await second.sendMessage('second visit');
      expect(calls[0].slice(calls[0].indexOf('resume'))).toEqual(['resume', '--', THREAD_ID, 'second visit']);
    });

    it('starts a new thread when the recorded thread has no rollout or the conversation is new', async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const first = await startSession({ adapter, bundle, exec: scriptedExec([codexTurn('done')]).exec });
      await first.sendMessage('first visit');
      await first.close();
      // No rollout was written for the recorded thread.

      const missing = scriptedExec([codexTurn('fresh')]);
      await startSession({ adapter, bundle, exec: missing.exec }).then((s) => s.sendMessage('again'));
      expect(missing.calls[0]).not.toContain('resume');

      writeRollout(bundle.stateDir as string);
      const other = scriptedExec([codexTurn('fresh')]);
      const otherConversation = '11111111-2222-3333-4444-555555555555' as AgentConversationId;
      await startSession({ adapter, bundle, exec: other.exec, agentConversationId: otherConversation }).then((s) =>
        s.sendMessage('a different state'),
      );
      // A thread recorded for another conversation in the shared ~/.codex is never picked up.
      expect(other.calls[0]).not.toContain('resume');
    });

    it('forgets the thread when the conversation id rotates', async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const { exec, calls } = scriptedExec([codexTurn('first'), codexTurn('second')]);
      const session = await startSession({ adapter, bundle, exec });
      await session.sendMessage('one');
      session.rotateAgentConversationId();
      await session.sendMessage('two');
      expect(calls[1]).not.toContain('resume');
      expect(calls[1].at(-1)).toContain('SYSTEM PROMPT');
    });

    it("does not report quota exhaustion for '429' in the transcript of a crashed turn", async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const crashed: DockerExecResult = {
        exitCode: 137,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'command_execution', aggregated_output: 'HTTP 429 Too Many Requests in fixtures/quota.txt' },
          }),
        ].join('\n'),
        stderr: '',
      };
      const session = await startSession({ adapter, bundle, exec: scriptedExec([crashed]).exec });
      const result = await session.sendMessageDetailed('run the tests');
      expect(result.quotaExhausted).toBeUndefined();
      expect(result.transientFailure).toBeUndefined();
      expect(result.hardFailure).toBe(false);
    });

    it('retries an empty Codex run on a fresh conversation (hardFailure)', async () => {
      const adapter = createCodexAdapter();
      const bundle = makeBundle(adapter);
      const session = await startSession({
        adapter,
        bundle,
        exec: scriptedExec([{ exitCode: 1, stdout: '', stderr: 'segfault' }]).exec,
      });
      const result = await session.sendMessageDetailed('do it');
      expect(result.hardFailure).toBe(true);
    });
  });

  describe('Goose', () => {
    it('creates the named session, then continues it, and a later session reuses it', async () => {
      const adapter = createGooseAdapter();
      const bundle = makeBundle(adapter);
      const { exec, calls } = scriptedExec([gooseTurn('first'), gooseTurn('second')]);
      const session = await startSession({ adapter, bundle, exec });
      await session.sendMessage('first request');
      await session.sendMessage('second request');

      expect(calls[0].slice(-3)).toEqual(['ironcurtain-goose', '--name', CONVERSATION_ID]);
      expect(calls[0].join('\n')).toContain('SYSTEM PROMPT');
      expect(calls[1].slice(-4)).toEqual(['ironcurtain-goose', '--name', CONVERSATION_ID, '--resume']);
      expect(calls[1].join('\n')).not.toContain('SYSTEM PROMPT');
      await session.close();

      // Goose wrote its session store in the mounted state dir.
      writeFileSync(join(bundle.stateDir as string, 'sessions.db'), 'SQLite format 3\0');
      const resumed = scriptedExec([gooseTurn('third')]);
      const later = await startSession({ adapter, bundle, exec: resumed.exec });
      await later.sendMessage('third request');
      expect(resumed.calls[0].slice(-4)).toEqual(['ironcurtain-goose', '--name', CONVERSATION_ID, '--resume']);
    });

    it('does not resume a session Goose never stored', async () => {
      const adapter = createGooseAdapter();
      const bundle = makeBundle(adapter);
      const first = await startSession({ adapter, bundle, exec: scriptedExec([gooseTurn('first')]).exec });
      await first.sendMessage('first request');
      await first.close();
      // A record exists, but there is no session store in the state dir.
      const { exec, calls } = scriptedExec([gooseTurn('fresh')]);
      const later = await startSession({ adapter, bundle, exec });
      await later.sendMessage('again');
      expect(calls[0]).not.toContain('--resume');
    });
  });
});

describe('Adapters follow each session config (one cached adapter per process)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-per-session-config-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function runOneTurn(adapter: AgentAdapter, config: IronCurtainConfig): Promise<readonly string[]> {
    const sessionDir = join(tempDir, `session-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(sessionDir, 'escalations'), { recursive: true });
    const { exec, calls } = scriptedExec([CLAUDE_OK]);
    const infra = {
      bundleId: 'test-bundle' as BundleId,
      bundleDir: sessionDir,
      workspaceDir: sessionDir,
      escalationDir: join(sessionDir, 'escalations'),
      auditLogPath: join(sessionDir, 'audit.jsonl'),
      proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
      mitmProxy: createMockMitmProxy(),
      docker: createMockDocker({ exec }),
      adapter,
      ca: createMockCA(sessionDir),
      fakeKeys: new Map([['api.anthropic.com', 'sk-fake']]),
      orientationDir: join(sessionDir, 'orientation'),
      systemPrompt: 'SYSTEM PROMPT',
      image: 'ironcurtain-claude-code:latest',
      useTcp: false,
      socketsDir: join(sessionDir, 'sockets'),
      mitmAddr: { socketPath: join(sessionDir, 'mitm.sock') },
      authKind: 'apikey',
      containerId: 'container-abc123',
      containerName: 'ironcurtain-test',
      beginCaptureSession: () => {},
      endCaptureSession: async () => {},
    } as unknown as DockerInfrastructure;
    const session = new DockerAgentSession({
      config,
      sessionId: 'session' as SessionId,
      agentConversationId: CONVERSATION_ID,
      infra,
      ownsInfra: false,
    });
    await session.initialize();
    await session.sendMessage('hello');
    await session.close();
    return calls[0];
  }

  function modelArg(command: readonly string[]): string | undefined {
    const index = command.indexOf('--model');
    return index >= 0 ? command[index + 1] : undefined;
  }

  it('changing agentModelId affects the next daemon session without a restart', async () => {
    // The daemon registers the adapters once (here with no config at all, as
    // the first-start wizard does) and reloads config for every session.
    await registerBuiltinAdapters();
    const claude = getAgent('claude-code' as AgentId);
    await registerBuiltinAdapters();
    expect(getAgent('claude-code' as AgentId)).toBe(claude);

    const before = baseConfig({}, 'anthropic:claude-sonnet-4-6');
    const edited = baseConfig({}, 'anthropic:claude-opus-4-6');
    expect(modelArg(await runOneTurn(claude, before))).toBe('claude-sonnet-4-6');
    expect(modelArg(await runOneTurn(claude, edited))).toBe('claude-opus-4-6');

    const fakeKeys = new Map([['api.anthropic.com', 'sk-fake']]);
    expect(claude.buildEnv(before, fakeKeys).IRONCURTAIN_MODEL).toBe('claude-sonnet-4-6');
    expect(claude.buildEnv(edited, fakeKeys).IRONCURTAIN_MODEL).toBe('claude-opus-4-6');
  });

  it('a workflow state model still wins over the session config', async () => {
    await registerBuiltinAdapters();
    const claude = getAgent('claude-code' as AgentId);
    const command = claude.buildCommand('m', 'p', {
      sessionId: CONVERSATION_ID,
      firstTurn: true,
      agentModelId: 'anthropic:claude-sonnet-4-6',
      modelOverride: 'anthropic:claude-haiku-4-5',
    });
    expect(modelArg(command)).toBe('claude-haiku-4-5');
  });

  it('a Goose provider or model edit reaches the next session through the cached adapter', async () => {
    await registerBuiltinAdapters();
    const goose = getAgent('goose' as AgentId);
    const anthropic = baseConfig({ gooseProvider: 'anthropic', gooseModel: 'claude-sonnet-4-20250514' });
    const openai = baseConfig({ gooseProvider: 'openai', gooseModel: 'gpt-4o', openaiApiKey: 'sk-openai' });

    expect(goose.getProviders(anthropic).map((p) => p.host)).toEqual(['api.anthropic.com']);
    expect(goose.getProviders(openai).map((p) => p.host)).toEqual(['api.openai.com']);
    expect(goose.buildEnv(openai, new Map([['api.openai.com', 'sk-fake']]))).toMatchObject({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'gpt-4o',
    });
    expect(goose.detectCredential?.(openai)).toEqual({ kind: 'apikey', key: 'sk-openai' });
    expect(goose.credentialHelpText?.(openai)).toContain('"openai"');
  });
});
