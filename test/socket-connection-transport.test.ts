/**
 * Unit tests for the per-connection transport shared by the UDS and TCP
 * listeners. The listener-level behaviour (malformed and oversized frames
 * from real clients, concurrent clients, eviction) is covered in
 * uds-server-transport.test.ts and tcp-server-transport.test.ts; this file
 * pins the connection-level contract on its own.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultHighWaterMark } from 'node:stream';
import { serializeMessage, deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK,
  SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS,
  SocketConnectionTransport,
} from '../src/trusted-process/socket-connection-transport.js';

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

/**
 * Collects every NDJSON frame the client receives from now on. Attach it
 * before resuming a paused client, or the first frames are lost.
 */
function collectFrames(socket: Socket): JSONRPCMessage[] {
  const frames: JSONRPCMessage[] = [];
  let pending = '';
  socket.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    let start = 0;
    for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n', start)) {
      frames.push(deserializeMessage(pending.substring(start, newline)));
      start = newline + 1;
    }
    pending = pending.substring(start);
  });
  return frames;
}

/** Reads one NDJSON-framed JSON-RPC message from the client side. */
function readMessage(socket: Socket): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        socket.off('data', onData);
        socket.off('error', reject);
        resolve(deserializeMessage(buffer.substring(0, newlineIndex)));
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

describe('SocketConnectionTransport', () => {
  /** Every socket directory the test made (a test may connect more than one pair). */
  const dirs: string[] = [];
  let server: NetServer | undefined;
  const clientSockets: Socket[] = [];

  /**
   * Starts a raw UDS server whose accepted sockets are wrapped by `wrap`
   * and returns a connected client socket. The server-side transport is
   * delivered through `accepted`.
   */
  async function connectPair(
    wrap: (socket: Socket) => SocketConnectionTransport,
  ): Promise<{ client: Socket; connection: SocketConnectionTransport }> {
    const dir = mkdtempSync(join(tmpdir(), 'sct-test-'));
    dirs.push(dir);
    const socketPath = join(dir, 't.sock');
    let resolveConnection: (connection: SocketConnectionTransport) => void = () => undefined;
    const accepted = new Promise<SocketConnectionTransport>((resolve) => {
      resolveConnection = resolve;
    });
    const netServer = createServer((socket) => resolveConnection(wrap(socket)));
    server = netServer;
    await new Promise<void>((resolve) => netServer.listen(socketPath, resolve));
    const client = await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect(socketPath, () => resolve(socket));
      socket.on('error', reject);
    });
    client.on('error', () => undefined);
    clientSockets.push(client);
    return { client, connection: await accepted };
  }

  afterEach(async () => {
    for (const socket of clientSockets.splice(0)) socket.destroy();
    const netServer = server;
    server = undefined;
    if (netServer) await new Promise<void>((resolve) => netServer.close(() => resolve()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('buffers bytes that arrive before start() and delivers initialData first', async () => {
    const first: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'first' };
    const second: JSONRPCMessage = { jsonrpc: '2.0', id: 2, method: 'second' };
    const { client, connection } = await connectPair(
      (socket) => new SocketConnectionTransport(socket, { initialData: Buffer.from(serializeMessage(first)) }),
    );
    const messages: JSONRPCMessage[] = [];
    connection.onmessage = (message) => messages.push(message);

    // Written before start(): must be held by the socket, not dropped.
    client.write(serializeMessage(second));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(0);

    await connection.start();
    await waitUntil(() => messages.length >= 2);
    expect(messages).toEqual([first, second]);
  });

  it('reports a malformed line through onerror and keeps delivering', async () => {
    const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
    const messages: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    connection.onmessage = (message) => messages.push(message);
    connection.onerror = (error) => errors.push(error);
    await connection.start();

    client.write('not json at all\n');
    client.write('{"valid":"json","but":"not jsonrpc"}\n');
    client.write(serializeMessage({ jsonrpc: '2.0', id: 3, method: 'after' }));

    await waitUntil(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ id: 3, method: 'after' });
    expect(errors).toHaveLength(2);
    expect(connection.destroyed).toBe(false);
  });

  it('routes an exception thrown by onmessage to onerror and continues with the next frame', async () => {
    const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
    const delivered: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    connection.onmessage = (message) => {
      if ('method' in message && message.method === 'boom') throw new Error('handler exploded');
      delivered.push(message);
    };
    connection.onerror = (error) => errors.push(error);
    await connection.start();

    client.write(serializeMessage({ jsonrpc: '2.0', id: 1, method: 'boom' }));
    client.write(serializeMessage({ jsonrpc: '2.0', id: 2, method: 'fine' }));

    await waitUntil(() => delivered.length >= 1);
    expect(delivered[0]).toMatchObject({ id: 2, method: 'fine' });
    expect(errors.map((e) => e.message)).toEqual(['handler exploded']);
    expect(connection.destroyed).toBe(false);
  });

  it('destroys the socket on a frame over maxBufferSize and reports the overflow', async () => {
    const { client, connection } = await connectPair(
      (socket) => new SocketConnectionTransport(socket, { maxBufferSize: 1024 }),
    );
    const errors: Error[] = [];
    let closed = 0;
    connection.onerror = (error) => errors.push(error);
    connection.onclose = () => {
      closed++;
    };
    await connection.start();

    const clientClosed = waitForClose(client);
    client.write(Buffer.alloc(4096, 0x61)); // one line, no newline, 4x the cap
    await clientClosed;

    expect(connection.destroyed).toBe(true);
    expect(errors.some((e) => /exceeded maximum size/.test(e.message))).toBe(true);
    await waitUntil(() => closed === 1);
    await expect(connection.send({ jsonrpc: '2.0', id: 1, result: {} })).rejects.toThrow('closed');
  });

  it('send() writes NDJSON frames to the client', async () => {
    const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
    await connection.start();
    const reply = readMessage(client);
    await connection.send({ jsonrpc: '2.0', id: 9, result: { ok: true } });
    expect(await reply).toEqual({ jsonrpc: '2.0', id: 9, result: { ok: true } });
  });

  it('fires onclose exactly once whether the peer disconnects or close() is called', async () => {
    const peer = await connectPair((socket) => new SocketConnectionTransport(socket));
    let peerCloses = 0;
    peer.connection.onclose = () => {
      peerCloses++;
    };
    await peer.connection.start();
    peer.client.destroy();
    await waitUntil(() => peerCloses === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peerCloses).toBe(1);
    // Closing an already-closed connection is a harmless no-op.
    await peer.connection.close();
    expect(peerCloses).toBe(1);

    // Fresh pair, closed from our side this time.
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const ours = await connectPair((socket) => new SocketConnectionTransport(socket));
    let ourCloses = 0;
    ours.connection.onclose = () => {
      ourCloses++;
    };
    await ours.connection.start();
    const clientClosed = waitForClose(ours.client);
    await ours.connection.close();
    await clientClosed;
    await waitUntil(() => ourCloses === 1);
    expect(ours.connection.destroyed).toBe(true);
  });

  it('start() is idempotent', async () => {
    const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
    const messages: JSONRPCMessage[] = [];
    connection.onmessage = (message) => messages.push(message);
    await connection.start();
    await connection.start();
    client.write(serializeMessage({ jsonrpc: '2.0', id: 1, method: 'once' }));
    await waitUntil(() => messages.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A second start() must not install a second data handler (which would
    // deliver every frame twice).
    expect(messages).toHaveLength(1);
  });

  describe('a peer that does not read what is sent to it (FU-13)', () => {
    it('stops reading past the send high-water mark and, once the peer reads, answers every held frame', async () => {
      const highWater = 256 * 1024;
      const { client, connection } = await connectPair(
        (socket) => new SocketConnectionTransport(socket, { sendHighWaterMark: highWater }),
      );
      const pad = 'r'.repeat(4096);
      let parsed = 0;
      connection.onmessage = (message) => {
        parsed++;
        // Answered synchronously, so the pause takes effect between two frames.
        if ('id' in message && message.id !== undefined) {
          connection.send({ jsonrpc: '2.0', id: message.id, result: { pad } }).catch(() => undefined);
        }
      };
      await connection.start();

      client.pause(); // reads nothing for now
      // About 16 MiB of replies: far more than the kernel's socket buffers
      // and the peer's own read buffer absorb before the queue builds up.
      const total = 4_000;
      let requests = '';
      for (let id = 0; id < total; id++) requests += serializeMessage({ jsonrpc: '2.0', id, method: 'echo' });
      client.write(requests);

      await waitUntil(() => connection.readingPaused);
      const parsedAtPause = parsed;
      await sleep(100);
      // Nothing more is parsed while paused, and what is queued for the peer
      // stays at the mark plus the one reply that crossed it.
      expect(parsed).toBe(parsedAtPause);
      expect(parsed).toBeLessThan(total);
      expect(connection.writableLength).toBeLessThanOrEqual(highWater + 2 * pad.length);
      expect(connection.destroyed).toBe(false);

      // The peer reads: the queue drains, reading resumes, and every request
      // is answered, in order, none lost while it was held.
      const replies = collectFrames(client);
      client.resume();
      await waitUntil(() => replies.length === total, 15_000);
      expect(replies.map((reply) => ('id' in reply ? reply.id : null))).toEqual(
        Array.from({ length: total }, (_, id) => id),
      );
      expect(parsed).toBe(total);
      expect(connection.readingPaused).toBe(false);
    });

    it('drops the connection through onerror once more than maxSendBufferSize is queued', async () => {
      const { client, connection } = await connectPair(
        (socket) => new SocketConnectionTransport(socket, { maxSendBufferSize: 1024 * 1024 }),
      );
      const errors: Error[] = [];
      let closed = 0;
      connection.onerror = (error) => errors.push(error);
      connection.onclose = () => {
        closed++;
      };
      await connection.start();
      client.pause();

      // Replies to requests read before a pause keep coming: reading less
      // cannot stop them, so the queue needs a hard cap of its own.
      const reply: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { pad: 'q'.repeat(128 * 1024) } };
      const sends: Array<Promise<void>> = [];
      for (let i = 0; i < 256 && !connection.destroyed; i++) sends.push(connection.send(reply));

      expect(connection.destroyed).toBe(true);
      expect(errors[0]?.message).toMatch(/send buffer exceeded maximum size of 1048576 bytes/);
      expect(errors.filter((error) => /send buffer exceeded/.test(error.message))).toHaveLength(1);
      // Every send settles; none is left hanging on the dropped socket.
      await Promise.allSettled(sends);
      await waitUntil(() => closed === 1);
      await expect(connection.send(reply)).rejects.toThrow('closed');
      // The peer sees its connection end once it reads again.
      const clientClosed = waitForClose(client);
      client.resume();
      await clientClosed;
    });

    it('start() leaves reading paused while replies queued before it are unread', async () => {
      const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
      const messages: JSONRPCMessage[] = [];
      connection.onmessage = (message) => messages.push(message);
      client.pause();

      // Queued before start() for a peer that is not reading: past the
      // default 4 MiB mark, below the default 32 MiB cap.
      const queued = connection.send({
        jsonrpc: '2.0',
        method: 'notifications/bulk',
        params: { pad: 'p'.repeat(16 * 1024 * 1024) },
      });
      expect(connection.readingPaused).toBe(true);
      client.write(serializeMessage({ jsonrpc: '2.0', id: 1, method: 'held' }));
      await connection.start();
      await sleep(50);
      expect(messages).toHaveLength(0);

      client.resume(); // takes (and discards) the queue
      await queued;
      await waitUntil(() => messages.length === 1);
      expect(messages[0]).toMatchObject({ id: 1, method: 'held' });
      expect(connection.readingPaused).toBe(false);
    });

    it("resumes once the peer has read, even with less queued than the socket's own high-water mark (no 'drain' follows)", async () => {
      const { client, connection } = await connectPair(
        (socket) => new SocketConnectionTransport(socket, { sendHighWaterMark: 1 }),
      );
      const messages: JSONRPCMessage[] = [];
      connection.onmessage = (message) => messages.push(message);
      await connection.start();
      client.pause();

      // Fill the kernel's buffers with writes small enough that the socket
      // never reports backpressure itself, so it will never emit 'drain'.
      const fill: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/fill',
        params: { pad: 'f'.repeat(16_384) },
      };
      const sends: Array<Promise<void>> = [];
      for (let i = 0; i < 4_096 && connection.writableLength === 0; i++) sends.push(connection.send(fill));
      for (const send of sends) send.catch(() => undefined); // awaited below
      expect(connection.writableLength).toBeGreaterThan(0);
      expect(connection.writableLength).toBeLessThan(getDefaultHighWaterMark(false));
      expect(connection.readingPaused).toBe(true);

      client.write(serializeMessage({ jsonrpc: '2.0', id: 1, method: 'held' }));
      await sleep(50);
      expect(messages).toHaveLength(0);

      client.resume(); // takes (and discards) the queue
      await Promise.all(sends);
      await waitUntil(() => messages.length === 1);
      expect(messages[0]).toMatchObject({ id: 1, method: 'held' });
      expect(connection.readingPaused).toBe(false);
    });

    it('stops reading past sendHighWaterMessages queued replies however small they are, and answers every held frame once the peer reads', async () => {
      const { client, connection } = await connectPair(
        (socket) => new SocketConnectionTransport(socket, { sendHighWaterMessages: 32 }),
      );
      let parsed = 0;
      connection.onmessage = (message) => {
        parsed++;
        if ('id' in message && message.id !== undefined) {
          connection.send({ jsonrpc: '2.0', id: message.id, result: {} }).catch(() => undefined);
        }
      };
      await connection.start();
      client.pause();

      // One large message the peer leaves unread fills the kernel's buffers,
      // so the small replies after it queue here. It stays below the 4 MiB
      // byte mark: what pauses reading below is the count alone.
      const bulk = connection.send({
        jsonrpc: '2.0',
        method: 'notifications/bulk',
        params: { pad: 'b'.repeat(3 * 1024 * 1024) },
      });
      bulk.catch(() => undefined); // awaited below; never an unhandled rejection
      expect(connection.readingPaused).toBe(false);

      const total = 200;
      let requests = '';
      for (let id = 0; id < total; id++) requests += serializeMessage({ jsonrpc: '2.0', id, method: 'echo' });
      client.write(requests);

      await waitUntil(() => connection.readingPaused);
      const parsedAtPause = parsed;
      expect(parsedAtPause).toBeLessThanOrEqual(33);
      expect(connection.queuedMessages).toBeLessThanOrEqual(34);
      expect(connection.writableLength).toBeLessThanOrEqual(SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK);
      await sleep(100);
      expect(parsed).toBe(parsedAtPause);
      expect(connection.destroyed).toBe(false);

      const frames = collectFrames(client);
      client.resume();
      await bulk;
      await waitUntil(() => frames.length === total + 1, 15_000);
      expect(frames.slice(1).map((reply) => ('id' in reply ? reply.id : null))).toEqual(
        Array.from({ length: total }, (_, id) => id),
      );
      expect(parsed).toBe(total);
      expect(connection.readingPaused).toBe(false);
      expect(connection.queuedMessages).toBe(0);
    });

    it('drops the connection through onerror once more than maxSendBufferMessages are queued', async () => {
      const { client, connection } = await connectPair(
        (socket) => new SocketConnectionTransport(socket, { maxSendBufferMessages: 64 }),
      );
      const errors: Error[] = [];
      connection.onerror = (error) => errors.push(error);
      await connection.start();
      client.pause();

      const sends: Array<Promise<void>> = [
        connection.send({ jsonrpc: '2.0', method: 'notifications/bulk', params: { pad: 'b'.repeat(1024 * 1024) } }),
      ];
      // Tiny messages: far below any byte limit, yet each one queued for a
      // peer that is not reading costs the host far more than its bytes.
      for (let i = 0; i < 1_000 && !connection.destroyed; i++) {
        sends.push(connection.send({ jsonrpc: '2.0', id: i, result: {} }));
      }

      expect(connection.destroyed).toBe(true);
      expect(sends).toHaveLength(65);
      expect(errors.map((error) => error.message)).toEqual([
        expect.stringMatching(/send buffer exceeded maximum of 64 messages \(65 messages, \d+ bytes not taken/),
      ]);
      await Promise.allSettled(sends);
      expect(connection.queuedMessages).toBe(0);
      const clientClosed = waitForClose(client);
      client.resume();
      await clientClosed;
    });

    it('rejects a message that cannot be serialized without counting it as queued', async () => {
      const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
      await connection.start();
      const unserializable = { jsonrpc: '2.0', id: 1, result: { big: BigInt(1) } } as unknown as JSONRPCMessage;
      await expect(connection.send(unserializable)).rejects.toThrow(/BigInt/);
      expect(connection.queuedMessages).toBe(0);
      // The connection is unaffected.
      const reply = readMessage(client);
      await connection.send({ jsonrpc: '2.0', id: 2, result: {} });
      expect(await reply).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
      expect(connection.queuedMessages).toBe(0);
    });

    it('yields to the event loop between batches of frames, so replies are counted before more is parsed, and loses none', async () => {
      const { client, connection } = await connectPair((socket) => new SocketConnectionTransport(socket));
      const ids: unknown[] = [];
      let parsedBeforeFirstTurnEnded: number | undefined;
      connection.onmessage = (message) => {
        if (ids.length === 0) {
          setImmediate(() => {
            parsedBeforeFirstTurnEnded = ids.length;
          });
        }
        ids.push('id' in message ? message.id : null);
      };
      await connection.start();

      // One write, about 40 KB: the server receives it in one read.
      const total = 1_000;
      let requests = '';
      for (let id = 0; id < total; id++) requests += serializeMessage({ jsonrpc: '2.0', id, method: 'ping' });
      client.write(requests);

      await waitUntil(() => ids.length === total);
      expect(parsedBeforeFirstTurnEnded).toBeDefined();
      expect(parsedBeforeFirstTurnEnded).toBeLessThanOrEqual(SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS);
      expect(ids).toEqual(Array.from({ length: total }, (_, id) => id));
      expect(connection.readingPaused).toBe(false);

      // Reading carries on normally afterwards.
      client.write(serializeMessage({ jsonrpc: '2.0', id: 'after', method: 'ping' }));
      await waitUntil(() => ids.length === total + 1);
      expect(ids[total]).toBe('after');
    });
  });
});
