import { describe, expect, it } from 'vitest';
import { stripHopByHopRequestHeaders } from '../../src/docker/hop-by-hop-headers.js';

describe('stripHopByHopRequestHeaders', () => {
  it('drops the hop-by-hop set and Connection-nominated names but keeps body framing', () => {
    const headers = {
      connection: 'close, X-Agent-Hop, transfer-encoding, content-length',
      'keep-alive': 'timeout=1',
      'proxy-authorization': 'Basic x',
      'proxy-connection': 'keep-alive',
      te: 'trailers',
      trailer: 'x-checksum',
      upgrade: 'h2c',
      'x-agent-hop': 'must-not-cross',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      'x-api-key': 'kept-for-the-credential-gate',
      empty: undefined,
    };
    expect(stripHopByHopRequestHeaders(headers)).toEqual({
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
      'x-api-key': 'kept-for-the-credential-gate',
    });
  });

  it('keeps content-length even when the Connection header nominates it', () => {
    expect(stripHopByHopRequestHeaders({ connection: 'content-length', 'content-length': '2' })).toEqual({
      'content-length': '2',
    });
  });

  it('does not modify its input', () => {
    const headers = { connection: 'keep-alive', accept: '*/*' };
    stripHopByHopRequestHeaders(headers);
    expect(headers).toEqual({ connection: 'keep-alive', accept: '*/*' });
  });
});
