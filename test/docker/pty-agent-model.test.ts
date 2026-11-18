/**
 * An interactive PTY session (`ironcurtain start --pty`, which the mux and
 * the web UI spawn per tab) resolves its agent model like every other
 * session: `--model` reaches `buildSessionConfig` as the explicit override,
 * above the persona's `agentModelId` (WP-126). Without `--model` nothing is
 * passed, so the persona's model, else the global one, applies.
 *
 * Docker is never reached: the mocked `buildSessionConfig` records its
 * options and stops the attempt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('../../src/session/index.js', () => ({
  buildSessionConfig: (_config: unknown, _effectiveSessionId: string, _sessionId: string, options: unknown) => {
    captured.options.push(options);
    throw new Error('stop after buildSessionConfig');
  },
}));

vi.mock('../../src/docker/docker-infrastructure.js', () => ({
  prepareDockerInfrastructure: vi.fn(),
  writeAptProxyConfigViaExec: vi.fn(),
  checkDockerContainerWritableStorage: vi.fn(),
  checkHostOnlyConnectivity: vi.fn(),
  checkInternalNetworkConnectivity: vi.fn(),
  attachDockerDesktopAgentEgressNetwork: vi.fn(),
}));

import { runPtySession } from '../../src/docker/pty-session.js';

function start(extra: { agentModelOverride?: string } = {}): Promise<void> {
  return runPtySession({
    config: { protectedPaths: [], userConfig: { modelProviders: { default: 'native' } } } as never,
    mode: { kind: 'docker', agent: 'claude-code' as never },
    persona: 'researcher',
    workspacePath: '/tmp',
    ...extra,
  });
}

describe('PTY session agent model', () => {
  afterEach(() => {
    captured.options.length = 0;
  });

  it('passes --model to buildSessionConfig as the explicit override', async () => {
    await expect(start({ agentModelOverride: 'anthropic:claude-opus-4-6' })).rejects.toThrow(
      'stop after buildSessionConfig',
    );
    expect(captured.options[0]).toMatchObject({
      persona: 'researcher',
      agentModelOverride: 'anthropic:claude-opus-4-6',
    });
  });

  it('passes no override without --model, so the persona model can apply', async () => {
    await expect(start()).rejects.toThrow('stop after buildSessionConfig');
    expect(captured.options[0]).toMatchObject({ persona: 'researcher' });
    expect(captured.options[0]).not.toHaveProperty('agentModelOverride');
  });
});
