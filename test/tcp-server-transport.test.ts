import { describe, it, expect, afterEach } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  TCP_TRANSPORT_HEALTH_REQUEST,
  TCP_TRANSPORT_HEALTH_RESPONSE,
  TcpServerTransport,
} from '../src/trusted-process/tcp-server-transport.js';
import {
  SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_SIZE,
  SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK,
  SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES,
  SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS,
  type SocketConnectionTransport,
} from '../src/trusted-process/socket-connection-transport.js';
import { serializeMessage, deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Connects to a TCP host:port and returns the socket. */
function connectToTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port }, () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Sends a JSON-RPC message over a socket using NDJSON framing. */
function sendMessage(socket: Socket, message: JSONRPCMessage): void {
  socket.write(serializeMessage(message));
}

/** Reads lines from a socket until a complete JSON-RPC message is received. */
function readMessage(socket: Socket): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        socket.off('data', onData);
        socket.off('error', reject);
        const line = buffer.substring(0, newlineIndex);
        resolve(deserializeMessage(line));
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/**
 * Collects messages from a transport's onmessage callback.
 * Returns the array (filled by side-effect) and a function
 * that waits until at least `count` messages have arrived.
 */
function createMessageCollector(transport: TcpServerTransport) {
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => messages.push(msg);

  function waitForMessages(count: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (messages.length >= count) {
          resolve();
        } else {
          setImmediate(check);
        }
      };
      check();
    });
  }

  return { messages, waitForMessages };
}

/** Polls until `predicate` holds; fails the test after `timeoutMs`. */
function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error('waitUntil: condition not met in time'));
      else setTimeout(check, 5);
    };
    check();
  });
}

/** Resolves once the socket has emitted 'close'. */
function waitForClose(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once('close', () => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves on the socket's next 'drain', or after `ms` without one (its peer stopped reading). */
function drainOrTimeout(socket: Socket, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      socket.off('drain', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    socket.once('drain', done);
  });
}

/** Resolves once `transport.send()` no longer has a client to write to (single-client mode). */
function waitForNoActiveClient(transport: TcpServerTransport): Promise<void> {
  const deadline = Date.now() + 5_000;
  return new Promise((resolve, reject) => {
    const probe = (): void => {
      transport.send({ jsonrpc: '2.0', method: 'notifications/probe' }).then(
        () => {
          if (Date.now() > deadline) reject(new Error('client still active'));
          else setTimeout(probe, 5);
        },
        () => resolve(),
      );
    };
    probe();
  });
}

describe('TcpServerTransport', () => {
  let transport: TcpServerTransport | undefined;
  let clientSocket: Socket | null = null;
  const extraSockets: Socket[] = [];

  afterEach(async () => {
    if (clientSocket) {
      clientSocket.destroy();
      clientSocket = null;
    }
    for (const socket of extraSockets.splice(0)) socket.destroy();
    if (transport) await transport.close();
  });

  it('binds to an OS-assigned port and exposes it via .port', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();

    const port = transport.port;
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('throws when accessing .port before start()', () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    expect(() => transport!.port).toThrow('has not been started');
  });

  it('accepts connections and receives messages', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();
    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };

    sendMessage(clientSocket, testMessage);

    await waitForMessages(1);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(testMessage);
  });

  it('sends messages to the connected client', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { waitForMessages } = createMessageCollector(transport);
    await transport.start();

    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    // Send a client→server message to prove the connection is established.
    // This is more reliable than setImmediate — on macOS the connection
    // callback can be deferred past a single event-loop tick.
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 0, method: 'ping' });
    await waitForMessages(1);

    const responseMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    };

    await transport.send(responseMessage);

    const received = await readMessage(clientSocket);
    expect(received).toEqual(responseMessage);
  });

  it('handles multiple messages in sequence', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();
    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    for (let i = 1; i <= 3; i++) {
      sendMessage(clientSocket, {
        jsonrpc: '2.0',
        id: i,
        method: 'tools/list',
      });
    }

    await waitForMessages(3);

    expect(messages).toHaveLength(3);
    expect(messages.map((m) => ('id' in m ? m.id : null))).toEqual([1, 2, 3]);
  });

  it('delivers a first frame that arrives split across TCP segments', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);
    await transport.start();
    clientSocket = await connectToTcp('127.0.0.1', transport.port);

    // The first bytes are classified before the connection becomes MCP; the
    // remainder must be handed over intact, not re-read or dropped.
    const frame = serializeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { split: true } });
    clientSocket.write(frame.slice(0, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    clientSocket.write(frame.slice(5));
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 2, method: 'ping' });

    await waitForMessages(2);
    expect(messages[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { split: true } });
    expect(messages[1]).toEqual({ jsonrpc: '2.0', id: 2, method: 'ping' });
  });

  it('invokes onclose callback when closed', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);

    let closeCalled = false;
    transport.onclose = () => {
      closeCalled = true;
    };

    await transport.start();
    await transport.close();

    expect(closeCalled).toBe(true);
  });

  it('throws when sending without an active connection', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 1,
        result: {},
      }),
    ).rejects.toThrow('No active TCP connection');
  });

  it('start() is idempotent -- second call is a no-op', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    await transport.start();
    const firstPort = transport.port;

    // Second start should not rebind to a different port
    await transport.start();
    expect(transport.port).toBe(firstPort);

    // Should still accept connections on the original port
    clientSocket = await connectToTcp('127.0.0.1', firstPort);
    expect(clientSocket.destroyed).toBe(false);
  });

  it('single-client mode refuses a second client while the first is served and never evicts it', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);

    await transport.start();

    // First client — send a message to confirm the connection is live
    const firstClient = await connectToTcp('127.0.0.1', transport.port);
    extraSockets.push(firstClient);
    sendMessage(firstClient, { jsonrpc: '2.0', id: 0, method: 'setup' });
    await waitForMessages(1);

    // A second client is classified as MCP by its first bytes and then refused;
    // the first client is not evicted and its traffic keeps flowing.
    const second = await connectToTcp('127.0.0.1', transport.port);
    extraSockets.push(second);
    sendMessage(second, { jsonrpc: '2.0', id: 42, method: 'test' });
    await waitForClose(second);

    expect(firstClient.destroyed).toBe(false);
    sendMessage(firstClient, { jsonrpc: '2.0', id: 1, method: 'still-served' });
    await waitForMessages(2);
    expect(messages[1]).toEqual({ jsonrpc: '2.0', id: 1, method: 'still-served' });
    expect(messages.some((m) => 'id' in m && m.id === 42)).toBe(false);

    // Once the served client disconnects, the next one is served.
    firstClient.destroy();
    await waitForNoActiveClient(transport);
    clientSocket = await connectToTcp('127.0.0.1', transport.port);
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 2, method: 'next' });
    await waitForMessages(3);
    expect(messages[2]).toMatchObject({ id: 2, method: 'next' });
  });

  it('bounds idle unclassified connections by the first-byte timeout', async () => {
    // Far longer than the settle wait below, so a loaded machine cannot fire
    // the timer before the no-eviction check.
    transport = new TcpServerTransport('127.0.0.1', 0, { firstByteTimeoutMs: 400 });
    await transport.start();

    // Several connections may be unclassified at once (parallel lanes connect
    // together); none evicts another, each is closed only once its own
    // timeout expires without any bytes.
    const firstPending = await connectToTcp('127.0.0.1', transport.port);
    extraSockets.push(firstPending);
    clientSocket = await connectToTcp('127.0.0.1', transport.port);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstPending.destroyed).toBe(false);

    await Promise.all([waitForClose(firstPending), waitForClose(clientSocket)]);
    expect(firstPending.destroyed).toBe(true);
    expect(clientSocket.destroyed).toBe(true);
  });

  it('answers a side-effect-free health probe without evicting the MCP client', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0);
    const { messages, waitForMessages } = createMessageCollector(transport);
    await transport.start();

    clientSocket = await connectToTcp('127.0.0.1', transport.port);
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 1, method: 'setup' });
    await waitForMessages(1);

    const probe = await connectToTcp('127.0.0.1', transport.port);
    const response = new Promise<string>((resolve, reject) => {
      let received = '';
      probe.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });
      probe.on('end', () => resolve(received));
      probe.on('error', reject);
    });
    // Split the magic request to cover TCP fragmentation.
    probe.write(TCP_TRANSPORT_HEALTH_REQUEST.slice(0, 8));
    probe.write(TCP_TRANSPORT_HEALTH_REQUEST.slice(8));
    expect(await response).toBe(TCP_TRANSPORT_HEALTH_RESPONSE);

    sendMessage(clientSocket, { jsonrpc: '2.0', id: 2, method: 'still-alive' });
    await waitForMessages(2);
    expect(messages[1]).toMatchObject({ id: 2, method: 'still-alive' });
  });

  it('closes a health-probe socket once answered, even if the peer keeps its side open', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0, { maxConnections: 1 });
    const seen: unknown[] = [];
    transport.onconnection = (connection) => {
      connection.onmessage = (message) => seen.push('id' in message ? message.id : null);
      void connection.start();
    };
    await transport.start();

    // A peer that reads the answer but never closes its own side. Merely
    // ending ours would keep the socket open, holding the only connection
    // slot and stalling close() for as long as the peer likes.
    const probe = netConnect({ host: '127.0.0.1', port: transport.port, allowHalfOpen: true });
    probe.on('error', () => undefined);
    extraSockets.push(probe);
    const answered = new Promise<string>((resolve) => {
      let received = '';
      probe.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });
      probe.on('end', () => resolve(received));
    });
    probe.write(TCP_TRANSPORT_HEALTH_REQUEST);
    expect(await answered).toBe(TCP_TRANSPORT_HEALTH_RESPONSE);
    expect(probe.destroyed).toBe(false);

    // The slot is free again: the agent's MCP connection is served...
    await new Promise((resolve) => setTimeout(resolve, 50));
    clientSocket = await connectToTcp('127.0.0.1', transport.port);
    sendMessage(clientSocket, { jsonrpc: '2.0', id: 1, method: 'ping' });
    await waitUntil(() => seen.length === 1);

    // ...and close() does not wait on the probe's peer.
    await transport.close();
    transport = undefined;
  });

  it('close() tears down connections that have not identified themselves yet', async () => {
    transport = new TcpServerTransport('127.0.0.1', 0, { firstByteTimeoutMs: 60_000 });
    await transport.start();
    const silent = await connectToTcp('127.0.0.1', transport.port);
    extraSockets.push(silent);
    const partialProbe = await connectToTcp('127.0.0.1', transport.port);
    extraSockets.push(partialProbe);
    partialProbe.write(TCP_TRANSPORT_HEALTH_REQUEST.slice(0, 6));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await transport.close();
    transport = undefined;
    await Promise.all([waitForClose(silent), waitForClose(partialProbe)]);
  });

  describe('malformed and oversized frames (TPM-7)', () => {
    it('passes the configured unread-byte cap through first-byte classification', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0, { maxBufferSize: 8 });
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      await transport.start();
      clientSocket = await connectToTcp('127.0.0.1', transport.port);
      clientSocket.write('ninebytes');
      const connected = clientSocket;
      await new Promise<void>((resolve) => connected.once('close', () => resolve()));
      expect(errors.some((error) => error.message.includes('maximum size of 8 bytes'))).toBe(true);
    });

    it('reports a malformed line via onerror, stays alive and delivers the next valid message', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0);
      const { messages, waitForMessages } = createMessageCollector(transport);
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      await transport.start();
      clientSocket = await connectToTcp('127.0.0.1', transport.port);

      // The very first bytes go through first-byte classification, so this
      // covers the inspectFirstBytes hand-off as well as the steady state.
      clientSocket.write('this is not json\n');
      await waitUntil(() => errors.length >= 1);
      clientSocket.write('{"hello":"world"}\n');
      sendMessage(clientSocket, { jsonrpc: '2.0', id: 7, method: 'tools/list' });

      await waitForMessages(1);
      expect(messages[0]).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
      expect(errors).toHaveLength(2);
      expect(clientSocket.destroyed).toBe(false);

      const reply = readMessage(clientSocket);
      await transport.send({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
      expect(await reply).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
    });

    it('destroys only the offending socket on a frame over 10 MiB and keeps accepting connections', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0);
      const seen: Array<{ lane: number; message: JSONRPCMessage }> = [];
      const errors: Error[] = [];
      let lanes = 0;
      transport.onconnection = (connection) => {
        const lane = lanes++;
        connection.onerror = (error) => errors.push(error);
        connection.onmessage = (message) => seen.push({ lane, message });
        void connection.start();
      };
      await transport.start();

      const good = await connectToTcp('127.0.0.1', transport.port);
      extraSockets.push(good);
      sendMessage(good, { jsonrpc: '2.0', id: 1, method: 'hello' });
      await waitUntil(() => seen.length === 1);

      const bad = await connectToTcp('127.0.0.1', transport.port);
      bad.on('error', () => undefined);
      extraSockets.push(bad);
      const badClosed = waitForClose(bad);
      bad.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
      await badClosed;
      expect(errors.some((e) => /exceeded maximum size/.test(e.message))).toBe(true);

      expect(good.destroyed).toBe(false);
      sendMessage(good, { jsonrpc: '2.0', id: 2, method: 'ping' });
      clientSocket = await connectToTcp('127.0.0.1', transport.port);
      sendMessage(clientSocket, { jsonrpc: '2.0', id: 3, method: 'ping' });

      await waitUntil(() => seen.length >= 3);
      expect(seen.map((s) => ('id' in s.message ? s.message.id : null)).sort()).toEqual([1, 2, 3]);
      expect(seen.find((s) => 'id' in s.message && s.message.id === 2)?.lane).toBe(0);
      expect(seen.find((s) => 'id' in s.message && s.message.id === 3)?.lane).toBe(2);
    });
  });

  describe('multi-client mode (DINF-9)', () => {
    it('serves concurrent clients with colliding JSON-RPC ids on separate connections', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0);
      transport.onconnection = (connection) => {
        connection.onmessage = (message) => {
          if ('method' in message && 'id' in message) {
            void connection.send({ jsonrpc: '2.0', id: message.id, result: { echo: message.params } });
          }
        };
        void connection.start();
      };
      await transport.start();

      const laneA = await connectToTcp('127.0.0.1', transport.port);
      extraSockets.push(laneA);
      const laneB = await connectToTcp('127.0.0.1', transport.port);
      extraSockets.push(laneB);

      const replyA = readMessage(laneA);
      const replyB = readMessage(laneB);
      sendMessage(laneA, { jsonrpc: '2.0', id: 1, method: 'answer', params: { lane: 'A' } });
      sendMessage(laneB, { jsonrpc: '2.0', id: 1, method: 'answer', params: { lane: 'B' } });

      expect(await replyA).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: { lane: 'A' } } });
      expect(await replyB).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: { lane: 'B' } } });
      expect(laneA.destroyed).toBe(false);
      expect(laneB.destroyed).toBe(false);
    });

    it('still answers health probes and respects the source filter', async () => {
      const rejected: Array<string | undefined> = [];
      transport = new TcpServerTransport('127.0.0.1', 0, {
        allowRemoteAddress: (addr) => {
          rejected.push(addr);
          return false;
        },
      });
      transport.onconnection = () => {
        throw new Error('no connection may reach onconnection when the source filter rejects it');
      };
      await transport.start();
      clientSocket = await connectToTcp('127.0.0.1', transport.port);
      await waitForClose(clientSocket);
      expect(rejected.length).toBeGreaterThan(0);
    });

    it('drops connections beyond maxConnections, reports the drop and keeps serving the others', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0, { maxConnections: 2 });
      const seen: unknown[] = [];
      const errors: Error[] = [];
      transport.onerror = (error) => errors.push(error);
      transport.onconnection = (connection) => {
        connection.onmessage = (message) => seen.push('id' in message ? message.id : null);
        void connection.start();
      };
      await transport.start();

      const first = await connectToTcp('127.0.0.1', transport.port);
      extraSockets.push(first);
      const second = await connectToTcp('127.0.0.1', transport.port);
      extraSockets.push(second);
      sendMessage(first, { jsonrpc: '2.0', id: 1, method: 'ping' });
      sendMessage(second, { jsonrpc: '2.0', id: 2, method: 'ping' });
      await waitUntil(() => seen.length >= 2);

      const third = await connectToTcp('127.0.0.1', transport.port);
      third.on('error', () => undefined);
      extraSockets.push(third);
      await waitForClose(third);
      // An agent process beyond the cap must not just see its connection vanish.
      await waitUntil(() => errors.length > 0);
      expect(errors.map((e) => e.message)).toEqual(['Connection refused: 2 connections already open']);

      expect(first.destroyed).toBe(false);
      expect(second.destroyed).toBe(false);
      sendMessage(first, { jsonrpc: '2.0', id: 3, method: 'ping' });
      await waitUntil(() => seen.length >= 3);
      expect(seen).toEqual([1, 2, 3]);
    });
  });

  describe('clients that never read their responses (FU-13)', () => {
    it('stops reading from a client that floods pings without reading, bounds its queue, and serves it again once it reads', async () => {
      transport = new TcpServerTransport('127.0.0.1', 0);
      const connections: SocketConnectionTransport[] = [];
      let parsed = 0;
      transport.onconnection = (connection) => {
        connections.push(connection);
        // Protocol.connect() keeps an onmessage installed before it and calls it first.
        connection.onmessage = () => {
          parsed++;
        };
        // The low-level Server, as CodeModeProxy uses it: one per connection.
        const server = new Server({ name: 'flood', version: '0' }, { capabilities: {} });
        void server.connect(connection);
      };
      await transport.start();

      const flooder = await connectToTcp('127.0.0.1', transport.port);
      flooder.on('error', () => undefined);
      extraSockets.push(flooder);
      flooder.pause(); // never reads a response
      // The first frame classifies the connection as MCP and arrives as initialData.
      sendMessage(flooder, { jsonrpc: '2.0', id: 0, method: 'ping' });
      await waitUntil(() => connections.length === 1);
      const flooded = connections[0];

      // Up to 1M pings, in batches, until the server stops reading them.
      let sent = 1;
      while (sent < 1_000_000 && !flooded.readingPaused && !flooded.destroyed) {
        let batch = '';
        for (let i = 0; i < 1_000; i++) batch += serializeMessage({ jsonrpc: '2.0', id: sent++, method: 'ping' });
        if (flooder.write(batch)) await new Promise((resolve) => setImmediate(resolve));
        else await drainOrTimeout(flooder, 100);
      }
      await sleep(200);

      expect(flooded.destroyed).toBe(false);
      expect(flooded.readingPaused).toBe(true);
      expect(flooded.writableLength).toBeLessThan(SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK + 1024 * 1024);
      expect(flooded.writableLength).toBeLessThan(SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_SIZE);
      // Bounded in messages too: each queued reply pins about 2 KiB of SDK
      // and stream state, so a byte bound alone would let 4 MiB of 40-byte
      // ping replies hold some 230 MiB. At most one batch of frames parsed
      // before the pause took effect is answered past the mark.
      expect(flooded.queuedMessages).toBeGreaterThan(SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES);
      expect(flooded.queuedMessages).toBeLessThanOrEqual(
        SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES + SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS,
      );
      const parsedWhilePaused = parsed;
      await sleep(200);
      expect(parsed).toBe(parsedWhilePaused);

      let answered = 0;
      flooder.on('data', (chunk: Buffer) => {
        for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1)) answered++;
      });
      flooder.resume();
      await waitUntil(() => answered === sent, 20_000);
      expect(flooded.queuedMessages).toBe(0);
      expect(parsed).toBe(sent);
      expect(flooded.readingPaused).toBe(false);
    });
  });
});
