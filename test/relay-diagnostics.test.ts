import { beforeEach, describe, expect, it, vi } from 'vitest';
const writes = vi.hoisted(() => vi.fn((_fd: number, text: string | Uint8Array) => text.length));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: writes,
}));
import { emitProxyDiagnostic } from '../src/trusted-process/mcp-proxy-server.js';
import { StartupStderrCapture } from '../src/trusted-process/relay-diagnostics.js';

beforeEach(() => {
  writes.mockClear();
});

describe('relay diagnostic display', () => {
  it('quotes formatting before the synchronous terminal sink', () => {
    emitProxyDiagnostic('WARNING', 'example\u0007\u202e\nnext', undefined);
    expect(writes).toHaveBeenCalledWith(2, 'WARNING: example\\u0007\\u202e\\nnext\n');
  });

  it('bounds ordinary long diagnostics with an explicit omission marker', () => {
    emitProxyDiagnostic('ERROR', 'x'.repeat(10_000), undefined);
    const output = String(writes.mock.calls[0][1]);
    expect(output.length).toBeLessThan(4200);
    expect(output).toContain('...[+');
  });
});

describe('startup stderr capture', () => {
  it('retains a complete bounded sample and stops after finish', () => {
    const capture = new StartupStderrCapture(5);
    capture.append('ab');
    capture.append('cde');
    expect(capture.finish()).toBe('abcde');
    capture.append('later');
    expect(capture.finish()).toBe('');
  });

  it('drops the whole sample on overflow instead of exposing a cut secret', () => {
    const capture = new StartupStderrCapture(5);
    capture.append('ab');
    capture.append('cdef');
    capture.append('later');
    expect(capture.finish()).toBeUndefined();
  });
});
