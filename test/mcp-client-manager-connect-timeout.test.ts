/**
 * The parent's MCP `initialize` handshake with a relay (WP-35 review).
 *
 * A relay answers `initialize` only after it has started its backend and
 * listed its tools, each bounded by the MCP SDK's 60 s inside the relay, and
 * a backend's first start can download a package or pull an image. Until
 * WP-35 a global `Protocol.prototype.request` patch gave this handshake the
 * escalation timeout (300 s by default). With the patch gone the handshake
 * must carry its own bound, or the parent gives up at the SDK's 60 s on a
 * relay that its own bounds still let start.
 *
 * The stdio transport is replaced by one that accepts every message and
 * never answers, so only the handshake's timer decides the outcome.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_CONNECT_TIMEOUT_MS } from '../src/trusted-process/call-timeouts.js';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    readonly stderr = null;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    onmessage?: (message: unknown) => void;
    start(): Promise<void> {
      return Promise.resolve();
    }
    send(message: unknown): Promise<void> {
      sent.push(message);
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.onclose?.();
      return Promise.resolve();
    }
  },
}));

import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';

afterEach(() => {
  vi.useRealTimers();
  sent.length = 0;
});

describe('MCPClientManager.connect handshake bound', () => {
  it('outlives the SDK 60 s default: a slow relay may answer initialize after a minute', async () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const manager = new MCPClientManager();
    let outcome: 'pending' | 'connected' | Error = 'pending';
    const connecting = manager.connect('slow', { command: 'relay', args: [] }).then(
      () => {
        outcome = 'connected';
      },
      (err: unknown) => {
        outcome = err instanceof Error ? err : new Error(String(err));
      },
    );

    // The initialize request went out and is still waiting well past 60 s.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sent.some((m) => (m as { method?: string }).method === 'initialize')).toBe(true);
    expect(outcome).toBe('pending');

    // It is still bounded: a relay that never answers fails at the bound.
    await vi.advanceTimersByTimeAsync(MCP_CONNECT_TIMEOUT_MS);
    await connecting;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as unknown as Error).message).toMatch(/timed out/i);
  });
});
