/**
 * `ironcurtain start` reports a failed mode preflight (a PreflightError: no
 * container runtime for a container agent, no credentials, `--agent builtin`
 * without the model's API key) as its message and exit status 1, as `daemon`
 * and `mux` do, instead of letting the rejection reach cli.ts, where it ends
 * the process with an uncaught-error stack trace.
 *
 * The preflight and the configuration are the real ones, against a temporary
 * IronCurtain home and no API keys in the environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ConfigTestEnv, seedConfig, setupConfigEnv, teardownConfigEnv } from './helpers/config-test-setup.js';
import { getSessionDir, getSessionStatePath } from '../src/config/paths.js';
import { saveSessionMetadata } from '../src/session/session-metadata.js';
import * as dockerProbe from '../src/docker/docker-probe.js';

import { main } from '../src/index.js';

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('ironcurtain start: preflight errors', () => {
  let env: ConfigTestEnv;
  let stderr: string[];
  let savedRuntime: string | undefined;
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let listenersBefore: Record<(typeof SIGNALS)[number], Set<unknown>>;

  beforeEach(() => {
    env = setupConfigEnv('start-preflight');
    // The container runtime is never probed for --agent builtin; keep the
    // auto-detection (an Apple `container` probe on macOS) out of it anyway.
    savedRuntime = process.env.IRONCURTAIN_CONTAINER_RUNTIME;
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
    // No terminal: the first-start wizard stays out of it.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
    listenersBefore = {
      SIGINT: new Set(process.listeners('SIGINT')),
      SIGTERM: new Set(process.listeners('SIGTERM')),
      SIGHUP: new Set(process.listeners('SIGHUP')),
    };
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitCalled(code);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore[signal].has(listener)) process.off(signal, listener);
      }
    }
    if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (savedRuntime === undefined) delete process.env.IRONCURTAIN_CONTAINER_RUNTIME;
    else process.env.IRONCURTAIN_CONTAINER_RUNTIME = savedRuntime;
    teardownConfigEnv(env);
  });

  it('prints the message of --agent builtin without an API key and exits 1, without a stack trace', async () => {
    await expect(main(['--agent', 'builtin', 'Summarize the notes'])).rejects.toMatchObject({ code: 1 });

    const written = stderr.join('');
    expect(written).toContain('ANTHROPIC_API_KEY');
    expect(written).toContain('Run `ironcurtain doctor` for a full diagnostic.');
    // The message alone: no "Error:" stack frames.
    expect(written).not.toMatch(/^\s+at /m);
    expect(written).not.toContain('PreflightError');
  });

  it.each([
    { pty: false, saved: 'team', expectedKey: 'OPENROUTER_API_KEY' },
    { pty: true, saved: 'team', expectedKey: 'OPENROUTER_API_KEY' },
    { pty: false, saved: undefined, expectedKey: 'ZAI_API_KEY' },
    { pty: true, saved: undefined, expectedKey: 'ZAI_API_KEY' },
  ])('checks the saved provider on resume (pty=$pty, profile=$saved)', async ({ pty, saved, expectedKey }) => {
    vi.spyOn(dockerProbe, 'checkDockerAvailable').mockResolvedValue({ available: true });
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('ZAI_API_KEY', '');
    seedConfig(env.testHome, {
      modelProviders: { default: 'current', profiles: { team: { type: 'openrouter' }, current: { type: 'zai' } } },
    });
    const sessionId = 'resume-profile';
    const workspacePath = mkdtempSync(join(tmpdir(), 'ironcurtain-resume-profile-'));
    try {
      mkdirSync(getSessionDir(sessionId), { recursive: true });
      const createdAt = new Date().toISOString();
      saveSessionMetadata(sessionId, { createdAt, agent: 'claude-code', providerProfileName: pty ? 'current' : saved });
      if (pty) {
        writeFileSync(
          getSessionStatePath(sessionId),
          JSON.stringify({
            sessionId,
            status: 'user-exit',
            exitCode: 0,
            lastActivity: createdAt,
            agent: 'claude-code',
            label: 'Fixture',
            resumable: true,
            workspacePath,
            providerProfileName: saved,
          }),
        );
      }
      const args = [...(pty ? ['--pty'] : []), '--resume', sessionId, '--provider-profile', 'ignored-on-resume'];
      await expect(main(args)).rejects.toMatchObject({ code: 1 });
      expect(stderr.join('')).toContain(`Set ${expectedKey}`);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
