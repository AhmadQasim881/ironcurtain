/**
 * Minimal TLS ClientHello reader for the MITM proxy's SNI-pinned passthrough
 * tunnel.
 *
 * A human approves a passthrough domain as `host:443`. The raw CONNECT tunnel
 * that serves it carries opaque TLS, so without looking at the ClientHello the
 * approval would also cover every other tenant served by the same address
 * (domain fronting on a shared CDN edge: any SNI and Host inside the tunnel).
 * This module reads just enough of the client's first flight to extract the
 * `server_name` extension, so the proxy can require it to equal the approved
 * host before a single byte is relayed. It never decrypts anything and hands
 * every byte it consumed back to the caller for verbatim replay upstream.
 *
 * Only the record and handshake framing needed to reach the extensions is
 * parsed (RFC 8446 §4.1.2, §4.4; RFC 6066 §3). A ClientHello may be split
 * over several handshake records, so records are reassembled until the
 * message is complete, under a hard byte cap, a record cap and a deadline.
 *
 * Limits of what the pin can see: with Encrypted ClientHello (ECH) the SNI
 * is only the outer, public name and the real one is encrypted, so a client
 * that deliberately uses ECH with the approved host as its outer name can
 * still reach another tenant of an ECH-enabled edge. GREASE ECH, which
 * Chromium sends on every connection, is indistinguishable from real ECH on
 * the wire, so an ECH hello is reported (`encryptedClientHello`) rather than
 * refused. Only the first ClientHello is inspected.
 */

import type { Socket } from 'node:net';

export type ClientHelloErrorCode = 'NOT_TLS' | 'MALFORMED' | 'OVERSIZED' | 'TIMEOUT' | 'CLOSED';

/** Raised by {@link readClientHello}; catch on `code`, not `instanceof`. */
export class ClientHelloError extends Error {
  readonly code: ClientHelloErrorCode;

  constructor(code: ClientHelloErrorCode, message: string) {
    super(message);
    this.name = 'ClientHelloError';
    this.code = code;
  }
}

export function isClientHelloError(error: unknown): error is ClientHelloError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ClientHelloError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

export type ClientHelloParse =
  /**
   * More bytes are needed before the ClientHello can be judged; nothing can
   * change until the data is at least `minimumLength` bytes long, so a reader
   * need not parse again before then.
   */
  | { readonly status: 'incomplete'; readonly minimumLength: number }
  /** The first bytes are not a TLS handshake record (plain HTTP, SSH, ...). */
  | { readonly status: 'not-tls' }
  /** TLS framing that no real client produces; never relayed. */
  | { readonly status: 'malformed'; readonly reason: string }
  /**
   * A complete ClientHello; `serverName` is the `host_name` SNI entry, if
   * any. `encryptedClientHello` is set when the hello carries an ECH (or
   * draft ESNI) extension: the SNI is then only the outer, public name, and
   * the name the client is really after is encrypted.
   */
  | {
      readonly status: 'parsed';
      readonly serverName: string | undefined;
      readonly encryptedClientHello?: true;
    };

const RECORD_HEADER_BYTES = 5;
const HANDSHAKE_HEADER_BYTES = 4;
const CONTENT_TYPE_HANDSHAKE = 0x16;
const RECORD_VERSION_MAJOR = 0x03;
const HANDSHAKE_TYPE_CLIENT_HELLO = 0x01;
/** RFC 8446 §5.1: a plaintext record carries at most 2^14 bytes. */
const MAX_RECORD_PAYLOAD_BYTES = 16_384;
const EXTENSION_SERVER_NAME = 0x0000;
/** encrypted_client_hello (ECH, draft-ietf-tls-esni-13 and later). */
const EXTENSION_ENCRYPTED_CLIENT_HELLO = 0xfe0d;
/** encrypted_server_name (the earlier ESNI drafts). */
const EXTENSION_ENCRYPTED_SERVER_NAME = 0xffce;
const SNI_NAME_TYPE_HOST_NAME = 0x00;
const MAX_SNI_BYTES = 253;

/**
 * Upper bound on the bytes buffered while waiting for a complete ClientHello.
 * Real ClientHellos are a few hundred bytes to roughly 2 KB (post-quantum key
 * shares); the cap only has to stop a client from parking memory on the proxy.
 */
export const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

/**
 * Upper bound on the handshake records one ClientHello may be spread over.
 * TLS stacks send it in as few records as fit (one, or a handful for a
 * hello past 16 KB). The bound keeps every re-parse of the first flight to a
 * fixed amount of work: without it a client sending one-byte records, one per
 * TCP segment, made each new record re-walk all the earlier ones, about 3.5 s
 * of event-loop CPU per connection inside the byte cap.
 */
export const MAX_CLIENT_HELLO_RECORDS = 64;

/**
 * Parse the accumulated first bytes of a client connection as a TLS
 * ClientHello. Pure: call it again with more data until the status is no
 * longer `incomplete`.
 */
export function parseClientHello(data: Buffer): ClientHelloParse {
  if (data.length === 0) return { status: 'incomplete', minimumLength: 1 };
  if (data[0] !== CONTENT_TYPE_HANDSHAKE) return { status: 'not-tls' };
  if (data.length < 2) return { status: 'incomplete', minimumLength: 2 };
  if (data[1] !== RECORD_VERSION_MAJOR) return { status: 'not-tls' };

  // Reassemble the handshake message across records.
  const fragments: Buffer[] = [];
  let offset = 0;
  let collected = 0;
  let messageLength: number | undefined;
  while (messageLength === undefined || collected < messageLength) {
    // Judged before waiting for more bytes, so the reader stops the moment
    // the cap is reached instead of buffering another record first.
    if (fragments.length === MAX_CLIENT_HELLO_RECORDS) {
      return {
        status: 'malformed',
        reason: `ClientHello spread over more than ${MAX_CLIENT_HELLO_RECORDS} handshake records`,
      };
    }
    if (data.length < offset + RECORD_HEADER_BYTES) {
      return { status: 'incomplete', minimumLength: offset + RECORD_HEADER_BYTES };
    }
    if (data[offset] !== CONTENT_TYPE_HANDSHAKE || data[offset + 1] !== RECORD_VERSION_MAJOR) {
      return { status: 'malformed', reason: 'non-handshake record before the ClientHello completed' };
    }
    const length = data.readUInt16BE(offset + 3);
    if (length === 0 || length > MAX_RECORD_PAYLOAD_BYTES) {
      return { status: 'malformed', reason: `handshake record length ${length} out of range` };
    }
    if (data.length < offset + RECORD_HEADER_BYTES + length) {
      return { status: 'incomplete', minimumLength: offset + RECORD_HEADER_BYTES + length };
    }
    fragments.push(data.subarray(offset + RECORD_HEADER_BYTES, offset + RECORD_HEADER_BYTES + length));
    collected += length;
    offset += RECORD_HEADER_BYTES + length;
    if (messageLength === undefined && collected >= HANDSHAKE_HEADER_BYTES) {
      const header = Buffer.concat(fragments, collected).subarray(0, HANDSHAKE_HEADER_BYTES);
      if (header[0] !== HANDSHAKE_TYPE_CLIENT_HELLO) {
        return { status: 'malformed', reason: 'first handshake message is not a ClientHello' };
      }
      messageLength = HANDSHAKE_HEADER_BYTES + header.readUIntBE(1, 3);
      if (messageLength > MAX_CLIENT_HELLO_BYTES) {
        return { status: 'malformed', reason: `ClientHello of ${messageLength} bytes exceeds the limit` };
      }
    }
  }

  const body = Buffer.concat(fragments, collected).subarray(HANDSHAKE_HEADER_BYTES, messageLength);
  const scan = scanExtensions(body);
  if (scan.kind === 'malformed') return { status: 'malformed', reason: scan.reason };
  return {
    status: 'parsed',
    serverName: scan.serverName,
    ...(scan.encryptedClientHello ? { encryptedClientHello: true as const } : {}),
  };
}

type ServerNameExtraction =
  { readonly kind: 'ok'; readonly value: string | undefined } | { readonly kind: 'malformed'; readonly reason: string };

type ExtensionScan =
  | { readonly kind: 'ok'; readonly serverName: string | undefined; readonly encryptedClientHello: boolean }
  | { readonly kind: 'malformed'; readonly reason: string };

/**
 * Walk the ClientHello body to its extensions: return the host_name SNI
 * entry and whether the hello offers ECH (or draft ESNI).
 */
function scanExtensions(body: Buffer): ExtensionScan {
  let position = 0;
  const need = (count: number): boolean => position + count <= body.length;
  // legacy_version (2) + random (32)
  if (!need(34)) return { kind: 'malformed', reason: 'ClientHello body truncated' };
  position += 34;
  // legacy_session_id<0..32>
  if (!need(1)) return { kind: 'malformed', reason: 'ClientHello body truncated' };
  const sessionIdLength = body[position];
  position += 1;
  if (sessionIdLength > 32 || !need(sessionIdLength)) {
    return { kind: 'malformed', reason: 'invalid ClientHello session id' };
  }
  position += sessionIdLength;
  // cipher_suites<2..2^16-2>
  if (!need(2)) return { kind: 'malformed', reason: 'ClientHello body truncated' };
  const cipherSuitesLength = body.readUInt16BE(position);
  position += 2;
  if (cipherSuitesLength < 2 || cipherSuitesLength % 2 !== 0 || !need(cipherSuitesLength)) {
    return { kind: 'malformed', reason: 'invalid ClientHello cipher suites' };
  }
  position += cipherSuitesLength;
  // legacy_compression_methods<1..2^8-1>
  if (!need(1)) return { kind: 'malformed', reason: 'ClientHello body truncated' };
  const compressionLength = body[position];
  position += 1;
  if (compressionLength < 1 || !need(compressionLength)) {
    return { kind: 'malformed', reason: 'invalid ClientHello compression methods' };
  }
  position += compressionLength;
  // extensions<8..2^16-1>, absent in a (pre-TLS 1.2) hello without extensions.
  if (position === body.length) return { kind: 'ok', serverName: undefined, encryptedClientHello: false };
  if (!need(2)) return { kind: 'malformed', reason: 'ClientHello body truncated' };
  const extensionsLength = body.readUInt16BE(position);
  position += 2;
  if (position + extensionsLength !== body.length) {
    return { kind: 'malformed', reason: 'ClientHello extensions length does not match the message' };
  }

  let serverName: string | undefined;
  let seenServerName = false;
  let encryptedClientHello = false;
  while (position < body.length) {
    if (!need(4)) return { kind: 'malformed', reason: 'truncated ClientHello extension' };
    const type = body.readUInt16BE(position);
    const length = body.readUInt16BE(position + 2);
    position += 4;
    if (!need(length)) return { kind: 'malformed', reason: 'truncated ClientHello extension' };
    if (type === EXTENSION_ENCRYPTED_CLIENT_HELLO || type === EXTENSION_ENCRYPTED_SERVER_NAME) {
      encryptedClientHello = true;
    }
    if (type === EXTENSION_SERVER_NAME) {
      if (seenServerName) return { kind: 'malformed', reason: 'duplicate server_name extension' };
      seenServerName = true;
      const parsed = parseServerNameExtension(body.subarray(position, position + length));
      if (parsed.kind === 'malformed') return parsed;
      serverName = parsed.value;
    }
    position += length;
  }
  return { kind: 'ok', serverName, encryptedClientHello };
}

/** RFC 6066 §3: ServerNameList with exactly one host_name entry in practice. */
function parseServerNameExtension(data: Buffer): ServerNameExtraction {
  if (data.length < 2) return { kind: 'malformed', reason: 'truncated server_name extension' };
  const listLength = data.readUInt16BE(0);
  if (listLength + 2 !== data.length) return { kind: 'malformed', reason: 'server_name list length mismatch' };
  let position = 2;
  let hostName: string | undefined;
  while (position < data.length) {
    if (position + 3 > data.length) return { kind: 'malformed', reason: 'truncated server_name entry' };
    const nameType = data[position];
    const nameLength = data.readUInt16BE(position + 1);
    position += 3;
    if (position + nameLength > data.length) return { kind: 'malformed', reason: 'truncated server_name entry' };
    if (nameType === SNI_NAME_TYPE_HOST_NAME) {
      if (hostName !== undefined) return { kind: 'malformed', reason: 'duplicate host_name in server_name' };
      if (nameLength === 0 || nameLength > MAX_SNI_BYTES) {
        return { kind: 'malformed', reason: 'invalid host_name length in server_name' };
      }
      const name = data.subarray(position, position + nameLength);
      // host_name is ASCII (RFC 6066 §3); anything else is not a name we can compare.
      if (name.some((byte) => byte <= 0x20 || byte >= 0x7f)) {
        return { kind: 'malformed', reason: 'non-ASCII or control byte in server_name host_name' };
      }
      hostName = name.toString('latin1');
    }
    position += nameLength;
  }
  return { kind: 'ok', value: hostName };
}

export interface ReadClientHelloOptions {
  /** Deadline for the complete ClientHello to arrive. */
  readonly timeoutMs: number;
  /** Byte cap on the buffered first flight; defaults to {@link MAX_CLIENT_HELLO_BYTES}. */
  readonly maxBytes?: number;
}

export interface ClientHelloRead {
  /** The `host_name` SNI the client sent, exactly as sent (not canonicalized). */
  readonly serverName: string | undefined;
  /**
   * True when the ClientHello offers ECH (or draft ESNI). `serverName` is then
   * the outer name only; the name inside the encrypted inner hello is not
   * visible. GREASE ECH, which Chromium sends on every connection, looks the
   * same on the wire, so this is a signal for the audit log, not a verdict.
   */
  readonly encryptedClientHello: boolean;
  /**
   * Every byte consumed from the client so far (the CONNECT `head` plus what
   * was read), to be replayed verbatim to the upstream once it is connected.
   */
  readonly bytes: Buffer;
}

/**
 * Read the client's first flight from `socket` (starting with `head`, the
 * bytes that arrived with the CONNECT request) until a complete ClientHello
 * has been seen. On success the socket is left paused with no `data`
 * listener attached, so the caller can `pipe()` it onward; everything
 * already read is returned for replay. Rejects with a {@link ClientHelloError}
 * when the bytes are not TLS, are malformed, exceed the cap, time out, or the
 * client goes away first.
 */
export function readClientHello(
  socket: Socket,
  head: Buffer,
  options: ReadClientHelloOptions,
): Promise<ClientHelloRead> {
  const maxBytes = options.maxBytes ?? MAX_CLIENT_HELLO_BYTES;
  return new Promise<ClientHelloRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    // Parse again only once enough bytes have arrived to change the outcome
    // (the next record header or the end of the current record), so a client
    // dribbling a record a byte at a time costs one parse per record, and
    // MAX_CLIENT_HELLO_RECORDS bounds both the number of parses and the work
    // in each.
    let minimumLength = 1;

    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onClose);
      socket.off('close', onClose);
      socket.off('error', onError);
      outcome();
    };

    const rejectOversized = (): void => {
      settle(() => reject(new ClientHelloError('OVERSIZED', `no complete ClientHello within ${maxBytes} bytes`)));
    };

    const evaluate = (): void => {
      if (size < minimumLength) {
        if (size > maxBytes) rejectOversized();
        return;
      }
      const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      chunks.length = 0;
      chunks.push(data);
      const parsed = parseClientHello(data);
      switch (parsed.status) {
        case 'incomplete':
          minimumLength = parsed.minimumLength;
          if (size > maxBytes) rejectOversized();
          return;
        case 'not-tls':
          settle(() => reject(new ClientHelloError('NOT_TLS', 'client did not start a TLS handshake')));
          return;
        case 'malformed':
          settle(() => reject(new ClientHelloError('MALFORMED', `malformed ClientHello: ${parsed.reason}`)));
          return;
        case 'parsed':
          // Stop consuming before anyone else reads: bytes that arrive after
          // this point stay in the socket's buffer for the caller's pipe().
          socket.pause();
          settle(() =>
            resolve({
              serverName: parsed.serverName,
              encryptedClientHello: parsed.encryptedClientHello === true,
              bytes: data,
            }),
          );
          return;
      }
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      evaluate();
    };
    const onClose = (): void => {
      settle(() => reject(new ClientHelloError('CLOSED', 'client closed before completing the ClientHello')));
    };
    const onError = (error: Error): void => {
      settle(() => reject(error));
    };
    const timer = setTimeout(() => {
      settle(() => reject(new ClientHelloError('TIMEOUT', `no complete ClientHello within ${options.timeoutMs} ms`)));
    }, options.timeoutMs);

    if (head.length > 0) {
      chunks.push(head);
      size += head.length;
    }
    socket.on('data', onData);
    socket.once('end', onClose);
    socket.once('close', onClose);
    socket.once('error', onError);
    evaluate();
  });
}
