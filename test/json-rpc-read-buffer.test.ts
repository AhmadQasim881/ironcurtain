import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcReadBuffer } from '../src/trusted-process/json-rpc-read-buffer.js';

afterEach(() => vi.restoreAllMocks());

describe('JsonRpcReadBuffer', () => {
  it('scans each byte once when a small ordinary frame arrives in fragments', () => {
    const input = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"hello"}\n');
    const original = Buffer.alloc(0).indexOf;
    let searched = 0;
    vi.spyOn(Buffer.prototype as Buffer, 'indexOf').mockImplementation(function (
      this: Buffer,
      value: string | number | Uint8Array,
      offset?: number | BufferEncoding,
      encoding?: BufferEncoding,
    ): number {
      searched += this.length - (typeof offset === 'number' ? offset : 0);
      const result: unknown = Reflect.apply(original, this, [value, offset, encoding]);
      if (typeof result !== 'number') throw new Error('Expected a byte search result');
      return result;
    });
    const buffer = new JsonRpcReadBuffer(128, 8);
    for (const byte of input.subarray(0, -1)) {
      buffer.append(Buffer.from([byte]));
      expect(buffer.readLine()).toBeNull();
      expect(buffer.readLine()).toBeNull();
    }
    buffer.append(input.subarray(-1));
    expect(buffer.readLine()).toBe(input.toString().slice(0, -1));
    expect(searched).toBe(input.length);
    expect(buffer.byteLength).toBe(0);
  });

  it('retains UTF-8, CRLF, successive lines, and a partial tail across pages', () => {
    const buffer = new JsonRpcReadBuffer(128, 4);
    buffer.append(Buffer.from('café\r\nnext\npar'));
    expect(buffer.readLine()).toBe('café');
    expect(buffer.readLine()).toBe('next');
    expect(buffer.readLine()).toBeNull();
    buffer.append(Buffer.from('t\n'));
    expect(buffer.readLine()).toBe('part');
    expect(buffer.readLine()).toBeNull();
  });

  it('bounds unread bytes and clears them on overflow', () => {
    const buffer = new JsonRpcReadBuffer(5, 2);
    buffer.append(Buffer.from('abc\n'));
    expect(buffer.readLine()).toBe('abc');
    buffer.append(Buffer.from('12345'));
    expect(() => buffer.append(Buffer.from('6'))).toThrow('maximum size of 5 bytes');
    expect(buffer.byteLength).toBe(0);
    expect(buffer.readLine()).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid limits %s', (limit) => {
    expect(() => new JsonRpcReadBuffer(limit)).toThrow('positive safe integer');
    expect(() => new JsonRpcReadBuffer(128, limit)).toThrow('positive safe integer');
  });
});
