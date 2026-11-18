/**
 * scripts/pin-models.ts, the maintainer tool that records PINNED_MODELS:
 * it pins a commit SHA (resolving a branch first) and hashes exactly the
 * files the server loads, at that commit.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { formatPin, recordPin } from '../scripts/pin-models.js';
import { PINNED_MODELS, pinProblem } from '../src/models/manifest.js';

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

function hub(): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.endsWith('/revision/main')) return Response.json({ sha: COMMIT });
    if (url.includes(`/resolve/${COMMIT}/`)) return new Response(`contents of ${url.split('/').pop() ?? ''}`);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe('pin-models', () => {
  const template = PINNED_MODELS[0];

  it('resolves the branch to a commit and pins every loaded file at that commit', async () => {
    const { fetch, requests } = hub();

    const pin = await recordPin(template, 'main', fetch);

    expect(pin.revision).toBe(COMMIT);
    expect(pin.files.map((file) => file.path)).toEqual(template.files.map((file) => file.path));
    const config = pin.files.find((file) => file.path === 'config.json');
    const expected = Buffer.from('contents of config.json');
    expect(config).toEqual({
      path: 'config.json',
      sha256: createHash('sha256').update(expected).digest('hex'),
      size: expected.length,
    });
    expect(pinProblem(pin)).toBeUndefined();
    expect(requests[0]).toBe(`https://huggingface.co/api/models/${template.repo}/revision/main`);
    expect(requests.slice(1).every((url) => url.includes(`/${template.repo}/resolve/${COMMIT}/`))).toBe(true);
  });

  it('uses a commit it is given without asking the Hub to resolve it', async () => {
    const { fetch, requests } = hub();
    const pin = await recordPin(template, COMMIT, fetch);
    expect(pin.revision).toBe(COMMIT);
    expect(requests.some((url) => url.includes('/api/'))).toBe(false);
  });

  it('fails when the Hub does not name a commit', async () => {
    const fetchImpl = (async () => Response.json({ sha: 'main' })) as unknown as typeof fetch;
    await expect(recordPin(template, 'main', fetchImpl)).rejects.toThrow(/no commit SHA/);
  });

  it('prints an entry for PINNED_MODELS', async () => {
    const pin = await recordPin(template, 'main', hub().fetch);
    const source = formatPin(pin);
    expect(source).toContain(`repo: '${template.repo}'`);
    expect(source).toContain(`revision: '${COMMIT}'`);
    for (const file of pin.files) {
      expect(source).toContain(`{ path: '${file.path}', sha256: '${file.sha256}', size: ${file.size} }`);
    }
  });
});
