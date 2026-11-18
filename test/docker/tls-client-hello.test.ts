import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import {
  isClientHelloError,
  MAX_CLIENT_HELLO_BYTES,
  MAX_CLIENT_HELLO_RECORDS,
  parseClientHello,
  readClientHello,
  type ClientHelloRead,
} from '../../src/docker/tls-client-hello.js';
import {
  buildClientHelloMessage,
  buildClientHelloRecord,
  encodeExtension,
  encodeServerNameExtension,
  wrapHandshakeRecord,
} from '../helpers/tls-client-hello-fixture.js';

/** The handshake message spread over exactly `count` non-empty records of near-equal size. */
function splitIntoRecords(message: Buffer, count: number): Buffer {
  const records: Buffer[] = [];
  const base = Math.floor(message.length / count);
  const remainder = message.length % count;
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    records.push(wrapHandshakeRecord(message.subarray(offset, offset + size)));
    offset += size;
  }
  return Buffer.concat(records);
}

describe('parseClientHello', () => {
  it('extracts the host_name SNI from a single-record ClientHello', () => {
    expect(parseClientHello(buildClientHelloRecord('api.example.com'))).toEqual({
      status: 'parsed',
      serverName: 'api.example.com',
    });
  });

  it('returns the SNI exactly as sent, without canonicalizing it', () => {
    expect(parseClientHello(buildClientHelloRecord('API.Example.com.'))).toEqual({
      status: 'parsed',
      serverName: 'API.Example.com.',
    });
  });

  it('reports a ClientHello without the server_name extension as parsed with no SNI', () => {
    expect(parseClientHello(buildClientHelloRecord(undefined))).toEqual({ status: 'parsed', serverName: undefined });
  });

  it('reassembles a ClientHello fragmented across handshake records', () => {
    for (const splitAt of [1, 3, 4, 40, 90]) {
      expect(parseClientHello(buildClientHelloRecord('split.example.com', { splitAt })), `splitAt ${splitAt}`).toEqual({
        status: 'parsed',
        serverName: 'split.example.com',
      });
    }
  });

  it('asks for more bytes at every prefix of a complete ClientHello', () => {
    const record = buildClientHelloRecord('prefix.example.com', { splitAt: 30 });
    for (let length = 0; length < record.length; length += 1) {
      const parsed = parseClientHello(record.subarray(0, length));
      expect(parsed.status, `length ${length}`).toBe('incomplete');
      // The reported minimum is always ahead of the data and never past the
      // complete first flight, so a reader that waits for it cannot stall.
      if (parsed.status !== 'incomplete') continue;
      expect(parsed.minimumLength, `length ${length}`).toBeGreaterThan(length);
      expect(parsed.minimumLength, `length ${length}`).toBeLessThanOrEqual(record.length);
    }
    expect(parseClientHello(record).status).toBe('parsed');
  });

  it('names the next record boundary as the minimum length to wait for', () => {
    const record = buildClientHelloRecord('boundary.example.com', { splitAt: 30 });
    // First record: 5-byte header + 30 bytes of handshake; then the second header.
    expect(parseClientHello(record.subarray(0, 3))).toEqual({ status: 'incomplete', minimumLength: 5 });
    expect(parseClientHello(record.subarray(0, 5))).toEqual({ status: 'incomplete', minimumLength: 35 });
    expect(parseClientHello(record.subarray(0, 35))).toEqual({ status: 'incomplete', minimumLength: 40 });
    expect(parseClientHello(record.subarray(0, 40))).toEqual({ status: 'incomplete', minimumLength: record.length });
  });

  it('reassembles a ClientHello spread over the maximum number of records', () => {
    const message = buildClientHelloMessage('many.example.com');
    const records = splitIntoRecords(message, MAX_CLIENT_HELLO_RECORDS);
    expect(records.length).toBe(message.length + 5 * MAX_CLIENT_HELLO_RECORDS);
    expect(parseClientHello(records)).toEqual({ status: 'parsed', serverName: 'many.example.com' });
  });

  it('refuses a ClientHello spread over more records than the cap, without waiting for the rest', () => {
    const message = buildClientHelloMessage('many.example.com');
    const oneByteRecords = Buffer.concat([...message].map((byte) => wrapHandshakeRecord(Buffer.from([byte]))));
    expect(message.length).toBeGreaterThan(MAX_CLIENT_HELLO_RECORDS);
    // Judged as soon as the cap is reached, not once the message completes.
    expect(parseClientHello(oneByteRecords.subarray(0, 6 * MAX_CLIENT_HELLO_RECORDS))).toMatchObject({
      status: 'malformed',
    });
    expect(parseClientHello(oneByteRecords)).toMatchObject({ status: 'malformed' });
  });

  it('flags an ECH or draft ESNI extension, whose SNI is only the outer name', () => {
    for (const type of [0xfe0d, 0xffce]) {
      const record = buildClientHelloRecord('public.example.com', {
        extraExtensions: encodeExtension(
          type,
          Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x07, 0x00, 0x00, 0x00, 0x00]),
        ),
      });
      expect(parseClientHello(record), type.toString(16)).toEqual({
        status: 'parsed',
        serverName: 'public.example.com',
        encryptedClientHello: true,
      });
    }
  });

  it('ignores bytes after the ClientHello (a compatibility ChangeCipherSpec, early data)', () => {
    const record = buildClientHelloRecord('trailing.example.com');
    const changeCipherSpec = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);
    expect(parseClientHello(Buffer.concat([record, changeCipherSpec]))).toEqual({
      status: 'parsed',
      serverName: 'trailing.example.com',
    });
  });

  it.each([
    ['plain HTTP', Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')],
    ['an SSH banner', Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')],
    ['an SSLv2-style hello', Buffer.from([0x80, 0x2e, 0x01, 0x03, 0x01])],
    ['a handshake byte with a non-TLS version', Buffer.from([0x16, 0x01, 0x00])],
  ])('reports %s as not TLS', (_label, bytes) => {
    expect(parseClientHello(bytes).status).toBe('not-tls');
  });

  it('refuses a first handshake message that is not a ClientHello', () => {
    const serverHello = Buffer.from(buildClientHelloMessage('x.example.com'));
    serverHello[0] = 0x02;
    expect(parseClientHello(wrapHandshakeRecord(serverHello))).toMatchObject({ status: 'malformed' });
  });

  it('refuses a non-handshake record before the ClientHello completed', () => {
    const message = buildClientHelloMessage('x.example.com');
    const first = wrapHandshakeRecord(message.subarray(0, 20));
    const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);
    expect(parseClientHello(Buffer.concat([first, alert]))).toMatchObject({ status: 'malformed' });
  });

  it('refuses empty and oversized records', () => {
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x00]))).toMatchObject({ status: 'malformed' });
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x40, 0x01]))).toMatchObject({ status: 'malformed' });
  });

  it('refuses a ClientHello that announces more than the byte cap', () => {
    const header = Buffer.from([0x01, 0x01, 0x00, 0x01]); // 65537-byte body
    expect(parseClientHello(wrapHandshakeRecord(header))).toMatchObject({ status: 'malformed' });
  });

  it('refuses two server_name extensions, two host_name entries and a bad list length', () => {
    const duplicateExtension = buildClientHelloRecord('a.example.com', {
      extraExtensions: encodeServerNameExtension('b.example.com'),
    });
    expect(parseClientHello(duplicateExtension)).toMatchObject({ status: 'malformed' });

    const twoNames = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x0d]),
      Buffer.from('a.example.com'),
      Buffer.from([0x00, 0x00, 0x0d]),
      Buffer.from('b.example.com'),
    ]);
    const listLength = Buffer.alloc(2);
    listLength.writeUInt16BE(twoNames.length);
    const twoNamesRecord = wrapHandshakeRecord(
      buildClientHelloMessage(undefined, encodeExtension(0x0000, Buffer.concat([listLength, twoNames]))),
    );
    expect(parseClientHello(twoNamesRecord)).toMatchObject({ status: 'malformed' });

    const badLength = wrapHandshakeRecord(
      buildClientHelloMessage(undefined, encodeExtension(0x0000, Buffer.from([0x00, 0x09, 0x00, 0x00, 0x01, 0x61]))),
    );
    expect(parseClientHello(badLength)).toMatchObject({ status: 'malformed' });
  });

  it('refuses control, space and non-ASCII bytes in the host_name', () => {
    for (const name of ['a b.example.com', 'a\u0000.example.com', 'bücher.example']) {
      expect(parseClientHello(buildClientHelloRecord(name)), JSON.stringify(name)).toMatchObject({
        status: 'malformed',
      });
    }
  });

  it('refuses an extensions block whose length disagrees with the message', () => {
    const message = buildClientHelloMessage('x.example.com');
    // Append a stray byte to the body and fix up only the handshake length.
    const patched = Buffer.concat([message, Buffer.from([0x00])]);
    patched.writeUIntBE(patched.length - 4, 1, 3);
    expect(parseClientHello(wrapHandshakeRecord(patched))).toMatchObject({ status: 'malformed' });
  });
});

describe('readClientHello', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  /** A connected socket pair over loopback TCP: [server side, client side]. */
  async function socketPair(): Promise<[net.Socket, net.Socket]> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
    const client = net.connect({ host: '127.0.0.1', port });
    const serverSide = await accepted;
    cleanup.push(() => {
      client.destroy();
      serverSide.destroy();
      server.close();
    });
    return [serverSide, client];
  }

  it('reads a real Node TLS ClientHello and leaves the socket paused for replay', async () => {
    const [serverSide, client] = await socketPair();
    const tlsClient = tls.connect({ socket: client, servername: 'real.example.com', rejectUnauthorized: false });
    tlsClient.on('error', () => undefined);
    cleanup.push(() => tlsClient.destroy());

    const result: ClientHelloRead = await readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 2000 });
    expect(result.serverName).toBe('real.example.com');
    expect(result.encryptedClientHello).toBe(false);
    expect(result.bytes[0]).toBe(0x16);
    expect(parseClientHello(result.bytes)).toEqual({ status: 'parsed', serverName: 'real.example.com' });
    expect(serverSide.isPaused()).toBe(true);
    expect(serverSide.listenerCount('data')).toBe(0);
  });

  it('counts the CONNECT head as the start of the ClientHello', async () => {
    const [serverSide, client] = await socketPair();
    const record = buildClientHelloRecord('head.example.com');
    const pending = readClientHello(serverSide, record.subarray(0, 10), { timeoutMs: 2000 });
    client.write(record.subarray(10));
    const result = await pending;
    expect(result.serverName).toBe('head.example.com');
    expect(result.bytes.equals(record)).toBe(true);
  });

  it('completes when the ClientHello arrives one byte per write', async () => {
    const [serverSide, client] = await socketPair();
    client.setNoDelay(true);
    const record = buildClientHelloRecord('dribble.example.com', { splitAt: 50 });
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 5000 });
    for (const byte of record) {
      client.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await pending;
    expect(result.serverName).toBe('dribble.example.com');
    expect(result.bytes.equals(record)).toBe(true);
  });

  it('stops reading a ClientHello dribbled as one-byte records once the record cap is reached', async () => {
    // One record per TCP segment used to make every new record re-walk all
    // the earlier ones: about 3.5 s of event-loop CPU for one connection
    // inside the byte cap. The reader must give up after the cap instead.
    class FakeSocket extends EventEmitter {
      pause(): this {
        return this;
      }
    }
    const socket = new FakeSocket();
    const declared = 10_000;
    const message = Buffer.alloc(4 + declared);
    message[0] = 0x01;
    message.writeUIntBE(declared, 1, 3);
    const pending = readClientHello(socket as unknown as net.Socket, Buffer.alloc(0), { timeoutMs: 60_000 });
    const outcome = pending.catch((caught: unknown) => caught);

    let delivered = 0;
    for (const byte of message) {
      const record = wrapHandshakeRecord(Buffer.from([byte]));
      socket.emit('data', record.subarray(0, 5));
      socket.emit('data', record.subarray(5));
      delivered += 1;
      // The reader detaches its data listener when it settles.
      if (socket.listenerCount('data') === 0) break;
    }
    expect(delivered).toBeLessThanOrEqual(MAX_CLIENT_HELLO_RECORDS);
    expect(await outcome).toMatchObject({ code: 'MALFORMED' });
  });

  it('reports an ECH ClientHello read from the socket', async () => {
    const [serverSide, client] = await socketPair();
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 2000 });
    client.write(
      buildClientHelloRecord('public.example.com', {
        extraExtensions: encodeExtension(
          0xfe0d,
          Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x07, 0x00, 0x00, 0x00, 0x00]),
        ),
      }),
    );
    const result = await pending;
    expect(result.serverName).toBe('public.example.com');
    expect(result.encryptedClientHello).toBe(true);
  });

  it('rejects non-TLS bytes with code NOT_TLS', async () => {
    const [serverSide, client] = await socketPair();
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 2000 });
    client.write('GET / HTTP/1.1\r\n\r\n');
    await expect(pending).rejects.toMatchObject({ code: 'NOT_TLS' });
  });

  it('rejects a client that stalls with code TIMEOUT', async () => {
    const [serverSide, client] = await socketPair();
    const record = buildClientHelloRecord('stall.example.com');
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 100 });
    client.write(record.subarray(0, 12));
    const error: unknown = await pending.catch((caught: unknown) => caught);
    expect(isClientHelloError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects a client that goes away first with code CLOSED', async () => {
    const [serverSide, client] = await socketPair();
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 2000 });
    client.end(buildClientHelloRecord('gone.example.com').subarray(0, 8));
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('rejects more buffered bytes than the cap with code OVERSIZED', async () => {
    const [serverSide, client] = await socketPair();
    // A valid record header that promises a ClientHello split over many
    // maximum-size records, delivered past the configured cap.
    const pending = readClientHello(serverSide, Buffer.alloc(0), { timeoutMs: 2000, maxBytes: 1024 });
    const message = buildClientHelloMessage('big.example.com', encodeExtension(0x0015, Buffer.alloc(4000)));
    client.write(wrapHandshakeRecord(message.subarray(0, 2000)));
    await expect(pending).rejects.toMatchObject({ code: 'OVERSIZED' });
    expect(MAX_CLIENT_HELLO_BYTES).toBe(64 * 1024);
  });
});
