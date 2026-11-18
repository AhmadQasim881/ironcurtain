/**
 * Hand-built TLS ClientHello records for tests of the MITM proxy's SNI pin
 * (src/docker/tls-client-hello.ts). Real clients produce the same framing;
 * building it by hand lets a test choose the SNI byte-for-byte (a trailing
 * dot, an absent extension) and fragment the handshake across records.
 */

import { randomBytes } from 'node:crypto';

export interface ClientHelloFixtureOptions {
  /**
   * Split the handshake message into two TLS records after this many bytes
   * (RFC 8446 §5.1 allows a handshake message to span records).
   */
  readonly splitAt?: number;
  /** Extra extensions appended after server_name, already encoded. */
  readonly extraExtensions?: Buffer;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u24(value: number): Buffer {
  return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

/** One extension: type, length, data. */
export function encodeExtension(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(data.length), data]);
}

/** The server_name extension (RFC 6066 §3) with one host_name entry. */
export function encodeServerNameExtension(serverName: string): Buffer {
  const name = Buffer.from(serverName, 'latin1');
  const entry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]);
  return encodeExtension(0x0000, Buffer.concat([u16(entry.length), entry]));
}

/** The ClientHello handshake message (type, 24-bit length, body). */
export function buildClientHelloMessage(serverName: string | undefined, extraExtensions?: Buffer): Buffer {
  const extensions = Buffer.concat([
    serverName === undefined ? Buffer.alloc(0) : encodeServerNameExtension(serverName),
    // supported_versions: TLS 1.3, as a modern client sends it.
    encodeExtension(0x002b, Buffer.from([0x02, 0x03, 0x04])),
    extraExtensions ?? Buffer.alloc(0),
  ]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // legacy_version
    randomBytes(32), // random
    Buffer.from([0x20]),
    randomBytes(32), // legacy_session_id
    u16(6),
    Buffer.from([0x13, 0x01, 0x13, 0x02, 0x00, 0x2f]), // cipher_suites
    Buffer.from([0x01, 0x00]), // legacy_compression_methods
    u16(extensions.length),
    extensions,
  ]);
  return Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
}

/** Wrap handshake bytes in one TLS handshake record. */
export function wrapHandshakeRecord(fragment: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(fragment.length), fragment]);
}

/** A complete client first flight: the ClientHello in one record, or two with `splitAt`. */
export function buildClientHelloRecord(
  serverName: string | undefined,
  options: ClientHelloFixtureOptions = {},
): Buffer {
  const message = buildClientHelloMessage(serverName, options.extraExtensions);
  if (options.splitAt === undefined) return wrapHandshakeRecord(message);
  return Buffer.concat([
    wrapHandshakeRecord(message.subarray(0, options.splitAt)),
    wrapHandshakeRecord(message.subarray(options.splitAt)),
  ]);
}
