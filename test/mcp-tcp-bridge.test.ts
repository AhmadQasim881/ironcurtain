import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  tcpTransportAuthFrame,
  TCP_TRANSPORT_HEALTH_REQUEST,
  TCP_TRANSPORT_HEALTH_RESPONSE,
} from '../src/trusted-process/tcp-server-transport.js';
interface BridgeModule {
  runMcpTcpBridge(options: {
    address: string;
    health?: boolean;
    input: Readable;
    output: Writable;
    environment: Record<string, string | undefined>;
    connect: (address: { host: string; port: number }) => Duplex;
    timeoutMs?: number;
  }): Promise<void>;
  parseTcpAddress(address: string): { host: string; port: number };
}
const assetUrl = new URL('../docker/mcp-bridge.mjs', import.meta.url).href;
const bridge = (await import(assetUrl)) as BridgeModule;
const token = '11'.repeat(32);
function fixture(environment: Record<string, string | undefined>, health = false) {
  const written: string[] = [];
  const outputBytes: string[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => outputBytes.push(chunk.toString()));
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  const connect = vi.fn(() => socket);
  const done = bridge.runMcpTcpBridge({
    address: 'host.docker.internal:12345',
    health,
    environment,
    input,
    output,
    connect,
  });
  return { written, outputBytes, input, output, socket, connect, done };
}
describe('packaged TCP MCP client without network I/O', () => {
  it('writes canonical admission before forwarding ordinary stdin and returns only server output', async () => {
    const f = fixture({ IRONCURTAIN_MCP_TCP_TOKEN: token });
    f.socket.emit('connect');
    f.input.write('ordinary request\n');
    f.socket.push('ordinary reply\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.written).toEqual([tcpTransportAuthFrame(token), 'ordinary request\n']);
    expect(f.outputBytes.join('')).toBe('ordinary reply\n');
    expect(f.connect).toHaveBeenCalledWith({ host: 'host.docker.internal', port: 12345 });
    f.socket.destroy();
    await f.done;
    f.input.destroy();
    f.output.destroy();
  });
  it.each([{}, { IRONCURTAIN_MCP_TCP_TOKEN: '' }])(
    'preserves legacy TCP when no nonempty credential is configured',
    async (environment) => {
      const f = fixture(environment);
      f.socket.emit('connect');
      f.input.write('legacy request\n');
      expect(f.written).toEqual(['legacy request\n']);
      f.socket.destroy();
      await f.done;
      f.input.destroy();
      f.output.destroy();
    },
  );
  it('refuses malformed configured credentials before connecting', async () => {
    const connect = vi.fn();
    const input = new PassThrough();
    const output = new PassThrough();
    await expect(
      bridge.runMcpTcpBridge({
        address: 'host.docker.internal:12345',
        environment: { IRONCURTAIN_MCP_TCP_TOKEN: 'invalid' },
        input,
        output,
        connect,
      }),
    ).rejects.toThrow('credential is invalid');
    expect(connect).not.toHaveBeenCalled();
    input.destroy();
    output.destroy();
  });
  it('health authenticates without forwarding stdin and prints only the fixed success receipt', async () => {
    const f = fixture({ IRONCURTAIN_MCP_TCP_TOKEN: token }, true);
    f.socket.emit('connect');
    f.input.write('not a request\n');
    expect(f.written).toEqual([tcpTransportAuthFrame(token), TCP_TRANSPORT_HEALTH_REQUEST]);
    f.socket.push(TCP_TRANSPORT_HEALTH_RESPONSE);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.socket.destroy();
    await f.done;
    expect(f.outputBytes.join('')).toBe(TCP_TRANSPORT_HEALTH_RESPONSE);
    f.input.destroy();
    f.output.destroy();
  });
  it.each(['missing-port', 'host:0', 'host:65536', 'host:80/path'])(
    'refuses malformed destinations before connecting',
    (address) => {
      expect(() => bridge.parseTcpAddress(address)).toThrow('valid port');
    },
  );
});
