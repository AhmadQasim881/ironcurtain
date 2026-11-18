import { describe, expect, it } from 'vitest';
import { assertAgentResponseOutputBound } from '../src/docker/agent-response-output.js';

describe('agent response parser budget', () => {
  it('accepts the exact combined output budget', () => {
    expect(() => assertAgentResponseOutputBound('hello', ' world', 11)).not.toThrow();
    expect(() => assertAgentResponseOutputBound('', '', 0)).not.toThrow();
  });

  it('refuses combined output before an adapter can parse a partial stream', () => {
    expect(() => assertAgentResponseOutputBound('hello', ' world', 10)).toThrow(
      expect.objectContaining({ code: 'AGENT_RESPONSE_OUTPUT_LIMIT' }),
    );
  });

  it('counts UTF-8 bytes rather than UTF-16 units', () => {
    expect(() => assertAgentResponseOutputBound('é', 'é', 4)).not.toThrow();
    expect(() => assertAgentResponseOutputBound('é', 'é', 3)).toThrow('exceeds 3 bytes');
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid limit %s', (limit) => {
    expect(() => assertAgentResponseOutputBound('', '', limit)).toThrow(RangeError);
  });
});
