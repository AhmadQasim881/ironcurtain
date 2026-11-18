import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { guardUpstreamResponse, isValidUpstreamStatus } from '../src/docker/upstream-response.js';

/** In-memory HTTP shapes only: these tests never send malformed wire responses. */
function responseFixture() {
  const response = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    getHeaderNames: () => ['x-partial'],
    removeHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return { response, target: response as unknown as ServerResponse };
}

function upstreamFixture(statusCode: number | undefined): IncomingMessage {
  return Object.assign(new PassThrough(), { statusCode }) as unknown as IncomingMessage;
}

describe('upstream response validation', () => {
  it.each([100, 200, 299, 400, 599])('accepts an integer HTTP status %s', (status) => {
    expect(isValidUpstreamStatus(status)).toBe(true);
  });

  it.each([undefined, null, 0, 99, 600, 999, 200.5, Number.NaN, Number.POSITIVE_INFINITY, '200'])(
    'rejects a value outside the HTTP status contract: %s',
    (status) => expect(isValidUpstreamStatus(status)).toBe(false),
  );

  it('forwards an ordinary response unchanged', () => {
    const { response, target } = responseFixture();
    const upstream = upstreamFixture(200);
    const forward = vi.fn();
    guardUpstreamResponse(target, forward)(upstream);
    expect(forward).toHaveBeenCalledExactlyOnceWith(upstream);
    expect(response.writeHead).not.toHaveBeenCalled();
    upstream.destroy();
  });

  it('refuses missing response metadata and closes only the exchange', () => {
    const { response, target } = responseFixture();
    const upstream = upstreamFixture(undefined);
    const forward = vi.fn();
    const rejected = vi.fn();
    response.end.mockImplementation(() => expect(rejected).toHaveBeenCalledOnce());
    guardUpstreamResponse(target, forward, rejected)(upstream);
    expect(forward).not.toHaveBeenCalled();
    expect(upstream.destroyed).toBe(true);
    expect(response.removeHeader).toHaveBeenCalledWith('x-partial');
    expect(response.writeHead).toHaveBeenCalledWith(502, expect.objectContaining({ Connection: 'close' }));
    expect(response.end).toHaveBeenCalledWith('Invalid upstream response.');
    expect(rejected).toHaveBeenCalledOnce();
  });

  it('contains a response callback failure before headers are sent', () => {
    const { response, target } = responseFixture();
    const upstream = upstreamFixture(200);
    const rejected = vi.fn();
    const callback = guardUpstreamResponse(
      target,
      () => {
        throw new Error('fixture formatting failure');
      },
      rejected,
    );
    expect(() => callback(upstream)).not.toThrow();
    expect(response.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
    expect(upstream.destroyed).toBe(true);
    expect(rejected).toHaveBeenCalledOnce();
  });

  it('destroys a started response rather than writing another status', () => {
    const { response, target } = responseFixture();
    response.headersSent = true;
    guardUpstreamResponse(target, () => {
      throw new Error('fixture stream setup failure');
    })(upstreamFixture(200));
    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.destroy).toHaveBeenCalledOnce();
  });

  it('contains a secondary failure while sending the rejection', () => {
    const { response, target } = responseFixture();
    response.writeHead.mockImplementation(() => {
      throw new Error('fixture response already unavailable');
    });
    const rejected = vi.fn();
    expect(() => guardUpstreamResponse(target, vi.fn(), rejected)(upstreamFixture(undefined))).not.toThrow();
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(rejected).toHaveBeenCalledOnce();
  });
});
