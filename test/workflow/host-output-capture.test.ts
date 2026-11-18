import { describe, it, expect } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { BoundedCapture, HOST_COMMAND_CAPTURE_BYTES } from '../../src/workflow/host-command-runner.js';

/** Bytes 0..n-1 of a recognisable stream: byte i is `i % 251`. */
function streamBytes(start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = (start + i) % 251;
  return bytes;
}

/** The capture the bound promises: the first and last `limit` bytes, with the gap counted. */
function expectedText(total: number, limit: number): string {
  if (total <= 2 * limit) return streamBytes(0, total).toString('utf8');
  return (
    `${streamBytes(0, limit).toString('utf8')}\n` +
    `[... ${total - 2 * limit} bytes of output omitted ...]\n` +
    streamBytes(total - limit, limit).toString('utf8')
  );
}

function capture(total: number, limit: number, chunkSizes: readonly number[]): string {
  const sink = new BoundedCapture(limit);
  let offset = 0;
  for (let i = 0; offset < total; i++) {
    const size = Math.min(chunkSizes[i % chunkSizes.length], total - offset);
    sink.push(streamBytes(offset, size));
    offset += size;
  }
  return sink.text();
}

describe('BoundedCapture', () => {
  it.each([
    ['one-byte chunks', [1]],
    ['chunks smaller than the bound', [7, 3, 11]],
    ['chunks larger than the bound', [250]],
    ['a mix that wraps the tail ring unevenly', [1, 64, 99, 100, 101, 37]],
  ])('keeps the first and last bytes exactly with %s', (_label, chunkSizes) => {
    for (const total of [0, 1, 99, 100, 101, 199, 200, 201, 1000, 12_345]) {
      expect(capture(total, 100, chunkSizes), `total ${total}`).toBe(expectedText(total, 100));
    }
  });

  it('counts everything as omitted when the bound is zero', () => {
    expect(capture(0, 0, [5])).toBe('');
    expect(capture(42, 0, [5])).toBe('\n[... 42 bytes of output omitted ...]\n');
  });

  it('holds a bounded amount of memory however finely the stream is chunked', () => {
    // A command that writes one byte at a time (a loop printing dots) is read
    // as one tiny chunk per write. Keeping each chunk object would retain
    // hundreds of bytes per byte of output: about 500 MB for this stream.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    gc();
    const before = process.memoryUsage().heapUsed;

    const sink = new BoundedCapture(HOST_COMMAND_CAPTURE_BYTES);
    const total = 2 * HOST_COMMAND_CAPTURE_BYTES + 4096;
    for (let i = 0; i < total; i++) sink.push(Buffer.alloc(1, 0x2e));

    gc();
    const retained = process.memoryUsage().heapUsed - before;
    expect(retained).toBeLessThan(64 * 1024 * 1024);
    expect(sink.text()).toContain('[... 4096 bytes of output omitted ...]');
  });
});
