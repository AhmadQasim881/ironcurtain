/**
 * DockerAgentSession.getLogRedaction(): the redaction a transport applies to
 * the session's transcript (interactions.jsonl). It carries the credential
 * values configured for the session, so a key the user pasted or the agent
 * echoed is masked even when no API-key pattern matches it, and it is null
 * (verbatim) when the user turned audit redaction off.
 *
 * The host credential stores are read too, so HOME and the related config
 * locations point at a fresh temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerAgentSession } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentConversationId, BundleId, SessionId } from '../src/session/types.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { createMockCA, createMockDocker, createMockMitmProxy, createMockProxy } from './helpers/docker-mocks.js';

const SERVER_TOKEN = 'corp-server-token-' + '0123456789abcdef';

function createSession(tempDir: string, userConfig: Record<string, unknown>): DockerAgentSession {
  const sessionDir = join(tempDir, 'session');
  const infra: DockerInfrastructure = {
    bundleId: 'test-bundle' as BundleId,
    bundleDir: sessionDir,
    workspaceDir: join(tempDir, 'sandbox'),
    escalationDir: join(tempDir, 'escalations'),
    auditLogPath: join(tempDir, 'audit.jsonl'),
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    docker: createMockDocker(),
    adapter: createClaudeCodeAdapter(),
    ca: createMockCA(tempDir),
    fakeKeys: new Map([['api.anthropic.com', 'sk-fake']]),
    orientationDir: join(sessionDir, 'orientation'),
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: 'docker',
    topology: 'uds',
    useTcp: false,
    socketsDir: join(sessionDir, 'sockets'),
    mitmAddr: { socketPath: '/tmp/test-mitm.sock' },
    metricsProxyUrl: 'http://127.0.0.1:18080',
    authKind: 'apikey',
    providerProfileId: 'native',
    containerId: 'container-abc123',
    containerName: 'ironcurtain-test',
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  };

  return new DockerAgentSession({
    config: { mcpServers: {}, userConfig } as unknown as IronCurtainConfig,
    sessionId: 'test-session-id' as SessionId,
    agentConversationId: '00000000-1111-2222-3333-444444444444' as AgentConversationId,
    infra,
    ownsInfra: true,
  });
}

describe('DockerAgentSession.getLogRedaction', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-log-redaction-'));
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('IRONCURTAIN_HOME', join(tempDir, '.ironcurtain'));
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(tempDir, 'anthropic'));
    vi.stubEnv('XDG_CONFIG_HOME', join(tempDir, 'xdg'));
    vi.stubEnv('CODEX_HOME', join(tempDir, 'codex'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('carries the credential values configured for the session', () => {
    const session = createSession(tempDir, {
      auditRedaction: { enabled: true },
      serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: SERVER_TOKEN } },
    });
    expect(session.getLogRedaction()?.secrets).toContain(SERVER_TOKEN);
  });

  it('is null when audit redaction is turned off', () => {
    const session = createSession(tempDir, {
      auditRedaction: { enabled: false },
      serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: SERVER_TOKEN } },
    });
    expect(session.getLogRedaction()).toBeNull();
  });
});
