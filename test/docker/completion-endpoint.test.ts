import { describe, expect, it } from 'vitest';
import {
  matchesEndpointPattern,
  resolveCompletionEndpoint,
  validateCompletionEndpoints,
} from '../../src/docker/llm-observation/completion-endpoint.js';
import { googleProvider } from '../../src/docker/provider-config.js';

describe('completion endpoint routing', () => {
  it('accepts and distinguishes the official Google action suffixes', () => {
    const endpoints = googleProvider.completionEndpoints ?? [];
    expect(() => validateCompletionEndpoints(endpoints, googleProvider.allowedEndpoints)).not.toThrow();

    expect(resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash:generateContent')?.path).toBe(
      '/v1beta/models/*:generateContent',
    );
    expect(
      resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
        ?.path,
    ).toBe('/v1beta/models/*:streamGenerateContent');
    expect(
      resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash/generateContent'),
    ).toBeUndefined();
  });

  it('matches a wildcard only against unreserved characters that are not all dots', () => {
    const endpoints = googleProvider.completionEndpoints ?? [];
    for (const path of [
      '/v1beta/models/..:generateContent',
      '/v1beta/models/.:generateContent',
      '/v1beta/models/..%2F..%2Fx:generateContent',
      '/v1beta/models/x%2e%2e:generateContent',
      '/v1beta/models/x\\y:generateContent',
      '/v1beta/models/x;y:generateContent',
    ]) {
      expect(matchesEndpointPattern(endpoints[0], 'POST', path), path).toBe(false);
      expect(resolveCompletionEndpoint(endpoints, 'POST', path), path).toBeUndefined();
    }
    expect(matchesEndpointPattern(endpoints[0], 'POST', '/v1beta/models/gemini-2.5-pro_x.y~z:generateContent')).toBe(
      true,
    );
  });
});
