import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { SocketConnectionTransport } from '../src/trusted-process/socket-connection-transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
const listener = vi.hoisted(() => ({ accept: undefined as ((socket: Socket) => void) | undefined }));
vi.mock('node:net', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    createServer: (accept: (socket: Socket) => void) => {
      listener.accept = accept;
      return Object.assign(new Emitter(), {
        listen: (_port: number, _host: string, callback: () => void) => callback(),
        address: () => ({ port: 12345 }),
        close: (callback: () => void) => callback(),
      });
    },
  };
});
import {
  TcpServerTransport,
  TCP_TRANSPORT_HEALTH_REQUEST,
  TCP_TRANSPORT_HEALTH_RESPONSE,
} from '../src/trusted-process/tcp-server-transport.js';
class LocalSocket extends EventEmitter {
  readonly remoteAddress = '127.0.0.1';
  destroyed = false;
  readonly sent: string[] = [];
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
  end(data: string, callback: () => void): this {
    this.sent.push(data);
    callback();
    return this;
  }
}
const token = '11'.repeat(32);
const auth = `IRONCURTAIN_AUTH/1 ${token}\n`;
const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}\n';
const transports: TcpServerTransport[] = [];
async function setup() {
  const transport = new TcpServerTransport('127.0.0.1', 0, { requiredToken: token, firstByteTimeoutMs: 50 });
  transports.push(transport);
  const accepted = vi.fn<(connection: SocketConnectionTransport) => void>();
  transport.onconnection = accepted;
  await transport.start();
  const socket = new LocalSocket();
  listener.accept?.(socket as unknown as Socket);
  return { transport, socket, accepted };
}
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.close();
  vi.useRealTimers();
});
describe('TCP admission authentication without network I/O', () => {
  it('refuses MCP input before allocating a connection', async () => {
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from(ping));
    expect(socket.destroyed).toBe(true);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated health', async () => {
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from(TCP_TRANSPORT_HEALTH_REQUEST));
    expect(socket.destroyed).toBe(true);
    expect(socket.sent).toEqual([]);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('admits split authentication before following MCP data', async () => {
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from(auth.slice(0, 12)));
    expect(accepted).not.toHaveBeenCalled();
    socket.emit('data', Buffer.from(auth.slice(12) + ping));
    expect(socket.destroyed).toBe(false);
    expect(accepted).toHaveBeenCalledTimes(1);
    const connection = accepted.mock.calls[0][0];
    const received = vi.fn();
    connection.onmessage = received;
    await connection.start();
    expect(received).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });
  it('authenticates before answering health', async () => {
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from(auth + TCP_TRANSPORT_HEALTH_REQUEST));
    expect(socket.sent).toEqual([TCP_TRANSPORT_HEALTH_RESPONSE]);
    expect(accepted).not.toHaveBeenCalled();
  });
  it.each([
    `IRONCURTAIN_AUTH/1 ${'22'.repeat(32)}\n`,
    `IRONCURTAIN_AUTH/1 ${'g'.repeat(64)}\n`,
    `${auth.trim()}\r\n`,
    'x'.repeat(84),
  ])('refuses a wrong/noncanonical frame', async (frame) => {
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from(frame));
    expect(socket.destroyed).toBe(true);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('retains the deadline for incomplete authentication', async () => {
    vi.useFakeTimers();
    const { socket, accepted } = await setup();
    socket.emit('data', Buffer.from('IRONCURTAIN_'));
    await vi.advanceTimersByTimeAsync(51);
    expect(socket.destroyed).toBe(true);
    expect(accepted).not.toHaveBeenCalled();
  });
});
