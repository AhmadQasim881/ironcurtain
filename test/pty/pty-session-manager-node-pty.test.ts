/**
 * The web UI terminal's default preflight without node-pty (BLD-10): creating
 * a PTY session fails with a PtyUnavailableError that says how to rebuild
 * node-pty for a global install, instead of the bare module-loader error.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => {
  throw new Error('Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64');
});

import { PtySessionManager } from '../../src/web-ui/pty-session-manager.js';
import type { PtyBridge } from '../../src/pty/pty-bridge.js';
import { nodePtyRemediation } from '../../src/pty/node-pty-loader.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { WebEventBus } from '../../src/web-ui/web-event-bus.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';

describe('PtySessionManager default preflight without node-pty', () => {
  it('refuses the session with the rebuild command', async () => {
    const createBridge = vi.fn(async (): Promise<PtyBridge> => {
      throw new Error('no bridge without node-pty');
    });
    const manager = new PtySessionManager({
      sender: { sendToSubscribers: () => {} },
      sessionManager: new SessionManager(),
      eventBus: new WebEventBus(),
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      daemonId: 'test',
      daemonPid: 1,
      createBridge,
    });

    const failure = manager.create();
    await expect(failure).rejects.toThrow(
      /^PTY terminal unavailable: Web UI terminal sessions need the optional node-pty package/,
    );
    // The shared remediation for what npm left on disk: a rebuild when the
    // package is there (only its import is mocked to fail), else a reinstall.
    await expect(failure).rejects.toThrow(nodePtyRemediation());
    expect(createBridge).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });
});
