/**
 * Tests for src/signal/signal-image.ts: parsing image references, resolving
 * the configured signal-cli image without pulling tags, pulling a candidate
 * for an explicit update, and the pinned defaults in both config resolvers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { DockerImageInfo } from '../../src/docker/types.js';
import {
  SIGNAL_DEFAULT_IMAGE,
  SIGNAL_IMAGE_DIGEST_PLACEHOLDER,
  SIGNAL_BRIDGE_LOCAL_IMAGE,
  SIGNAL_BRIDGE_AUTH_LABEL,
  SIGNAL_BRIDGE_AUTH_VERSION,
  SIGNAL_IMAGE_REPOSITORY,
  SIGNAL_IMAGE_STALE_DAYS,
  SignalImageError,
  hasSignalImageErrorCode,
  discardSignalImageCandidate,
  isDigestPinned,
  isSignalImageError,
  parseImageReference,
  pullSignalImageCandidate,
  repoDigestsFor,
  resolveSignalImage,
  tagNotRestoredMessage,
  type SignalImageUpdateRuntime,
} from '../../src/signal/signal-image.js';
import { SIGNAL_DEFAULTS, resolveSignalConfig } from '../../src/signal/signal-config.js';
import { loadSavedSignalContainerConfig, loadUserConfig } from '../../src/config/user-config.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const PINNED = `${SIGNAL_IMAGE_REPOSITORY}@${DIGEST}`;

function imageInfo(overrides: Partial<DockerImageInfo> = {}): DockerImageInfo {
  return {
    id: IMAGE_ID,
    repoTags: [`${SIGNAL_IMAGE_REPOSITORY}:latest`],
    repoDigests: [PINNED],
    labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
    created: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A runtime whose local images are `images` (by reference); pulls add `pulled`
 * under the pulled reference, and tags can be pointed at a known image ID or
 * removed. `local` exposes the references for assertions.
 */
function fakeRuntime(
  images: Record<string, DockerImageInfo> = {},
  pulled?: DockerImageInfo,
  options: { readonly tagFails?: boolean } = {},
): SignalImageUpdateRuntime & {
  local: Map<string, DockerImageInfo>;
  inspectImage: ReturnType<typeof vi.fn>;
  pullImage: ReturnType<typeof vi.fn>;
  removeImage: ReturnType<typeof vi.fn>;
  tagImage: ReturnType<typeof vi.fn>;
} {
  const local = new Map(Object.entries(images));
  const byId = new Map([...local.values(), ...(pulled ? [pulled] : [])].map((info) => [info.id, info]));
  return {
    local,
    inspectImage: vi.fn((ref: string) => Promise.resolve(local.get(ref))),
    pullImage: vi.fn((ref: string) => {
      if (pulled === undefined) return Promise.reject(new Error('manifest unknown'));
      local.set(ref, pulled);
      return Promise.resolve();
    }),
    removeImage: vi.fn((ref: string) => Promise.resolve(local.delete(ref))),
    tagImage: vi.fn((source: string, target: string) => {
      const info = byId.get(source);
      if (options.tagFails === true || info === undefined) return Promise.reject(new Error('No such image'));
      local.set(target, info);
      return Promise.resolve();
    }),
  };
}

describe('parseImageReference', () => {
  it('parses repositories with tags, digests or both', () => {
    expect(parseImageReference('bbernhard/signal-cli-rest-api')).toEqual({
      repository: 'bbernhard/signal-cli-rest-api',
    });
    expect(parseImageReference('bbernhard/signal-cli-rest-api:0.92')).toEqual({
      repository: 'bbernhard/signal-cli-rest-api',
      tag: '0.92',
    });
    expect(parseImageReference(PINNED)).toEqual({ repository: SIGNAL_IMAGE_REPOSITORY, digest: DIGEST });
    expect(parseImageReference(`registry.example.com:5000/team/signal:1.0@${DIGEST}`)).toEqual({
      repository: 'registry.example.com:5000/team/signal',
      tag: '1.0',
      digest: DIGEST,
    });
  });

  it('rejects anything that is not an image reference', () => {
    for (const reference of [
      '',
      '-v /:/host',
      '--privileged',
      'bbernhard/signal cli',
      'Bbernhard/Signal',
      `bbernhard/signal-cli-rest-api@sha256:${'A'.repeat(64)}`,
      'bbernhard/signal-cli-rest-api@sha256:abc',
      'bbernhard/signal-cli-rest-api@md5:abcd',
      'bbernhard/signal-cli-rest-api:',
      'bbernhard/signal-cli-rest-api:-bad',
      `x/${'a'.repeat(600)}`,
    ]) {
      expect(parseImageReference(reference), reference).toBeUndefined();
    }
  });

  it('tells digest pins from tags and the placeholder', () => {
    expect(isDigestPinned(PINNED)).toBe(true);
    expect(isDigestPinned(`${SIGNAL_IMAGE_REPOSITORY}:latest`)).toBe(false);
    expect(isDigestPinned(`${SIGNAL_IMAGE_REPOSITORY}@${SIGNAL_IMAGE_DIGEST_PLACEHOLDER}`)).toBe(false);
  });
});

describe('SignalImageError', () => {
  it('is recognized by its code, not its class', () => {
    const error = new SignalImageError('SIGNAL_IMAGE_MISMATCH', 'no');
    expect(isSignalImageError(error)).toBe(true);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_NOT_PINNED')).toBe(false);
    const lookalike = Object.assign(new Error('elsewhere'), { code: 'SIGNAL_IMAGE_NOT_PINNED' });
    expect(isSignalImageError(lookalike)).toBe(true);
    expect(isSignalImageError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isSignalImageError('SIGNAL_IMAGE_NOT_PINNED')).toBe(false);
  });
});

describe('repoDigestsFor', () => {
  it('matches Docker Hub repositories however the registry is spelled', () => {
    const info = imageInfo({
      repoDigests: [`docker.io/${SIGNAL_IMAGE_REPOSITORY}@${DIGEST}`, `someone/else@${OTHER_DIGEST}`, PINNED],
    });
    expect(repoDigestsFor(info, SIGNAL_IMAGE_REPOSITORY)).toEqual([DIGEST]);
    expect(repoDigestsFor(imageInfo({ repoDigests: [`alpine@${DIGEST}`] }), 'docker.io/library/alpine')).toEqual([
      DIGEST,
    ]);
    expect(repoDigestsFor(imageInfo({ repoDigests: undefined }), SIGNAL_IMAGE_REPOSITORY)).toEqual([]);
  });
});

describe('pinned defaults', () => {
  it('uses the explicitly built authenticated default in both config resolvers', () => {
    const parsed = parseImageReference(SIGNAL_DEFAULT_IMAGE);
    expect(SIGNAL_DEFAULT_IMAGE).toBe(SIGNAL_BRIDGE_LOCAL_IMAGE);
    expect(parsed).toEqual({ repository: 'ironcurtain-signal-bridge', tag: '0.101-auth1' });
    expect(SIGNAL_DEFAULTS.image).toBe(SIGNAL_DEFAULT_IMAGE);
    const resolved = resolveSignalConfig({
      signal: { botNumber: '+15551234567', recipientNumber: '+15559876543', recipientIdentityKey: 'key' },
    });
    expect(resolved?.container.image).toBe(SIGNAL_DEFAULT_IMAGE);
  });

  describe('loadUserConfig', () => {
    let home: string;
    const saved = process.env.IRONCURTAIN_HOME;

    beforeEach(() => {
      home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-signal-image-'));
      process.env.IRONCURTAIN_HOME = home;
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    });

    function writeConfig(signal: Record<string, unknown>): void {
      writeFileSync(resolve(home, 'config.json'), JSON.stringify({ signal }), { mode: 0o600 });
    }

    it('resolves the same pinned default, and the stored account UUID', () => {
      writeConfig({
        botNumber: '+15551234567',
        recipientNumber: '+15559876543',
        recipientIdentityKey: 'key',
        recipientUuid: 'aci-1234',
      });
      const signal = loadUserConfig({ readOnly: true }).signal;
      expect(signal?.container.image).toBe(SIGNAL_DEFAULT_IMAGE);
      expect(signal?.recipientUuid).toBe('aci-1234');
      expect(resolveSignalConfig({ signal })?.recipientUuid).toBe('aci-1234');
    });

    it('keeps an image pinned in config.json, and reads the saved container block raw', () => {
      writeConfig({
        botNumber: '+15551234567',
        recipientNumber: '+15559876543',
        recipientIdentityKey: 'key',
        container: { image: PINNED, port: 18081 },
      });
      expect(loadUserConfig({ readOnly: true }).signal?.container).toMatchObject({ image: PINNED, port: 18081 });
      expect(loadSavedSignalContainerConfig()).toEqual({ image: PINNED, port: 18081 });
    });

    it('reads a saved container block even while Signal is not fully set up', () => {
      writeConfig({ container: { image: PINNED } });
      expect(loadUserConfig({ readOnly: true }).signal).toBeNull();
      expect(loadSavedSignalContainerConfig()).toEqual({ image: PINNED });
    });

    it('reads nothing when there is no config file', () => {
      expect(loadSavedSignalContainerConfig()).toBeUndefined();
    });
  });
});

describe('resolveSignalImage', () => {
  it('uses a pinned image that is present locally without pulling', async () => {
    const runtime = fakeRuntime({ [PINNED]: imageInfo() });
    await expect(resolveSignalImage(runtime, PINNED)).resolves.toEqual({ id: IMAGE_ID, pinned: true });
    expect(runtime.pullImage).not.toHaveBeenCalled();
  });

  it('pulls a pinned image by its digest only when it is missing', async () => {
    const runtime = fakeRuntime({}, imageInfo());
    const info = vi.fn();
    await expect(resolveSignalImage(runtime, PINNED, { info })).resolves.toEqual({ id: IMAGE_ID, pinned: true });
    expect(runtime.pullImage).toHaveBeenCalledTimes(1);
    expect(runtime.pullImage).toHaveBeenCalledWith(PINNED);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Pulling the pinned image'));
  });

  it('resolves a tag next to a digest by the digest alone', async () => {
    const runtime = fakeRuntime({ [PINNED]: imageInfo() });
    await expect(resolveSignalImage(runtime, `${SIGNAL_IMAGE_REPOSITORY}:latest@${DIGEST}`)).resolves.toEqual({
      id: IMAGE_ID,
      pinned: true,
    });
    expect(runtime.inspectImage).toHaveBeenCalledWith(PINNED);
  });

  it('fails when the pinned image cannot be pulled', async () => {
    const runtime = fakeRuntime();
    const error = await resolveSignalImage(runtime, PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_UNAVAILABLE')).toBe(true);
    expect((error as Error).message).toContain('manifest unknown');
  });

  it('refuses a local image that does not carry the pinned digest', async () => {
    const runtime = fakeRuntime({
      [PINNED]: imageInfo({ repoDigests: [`${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`] }),
    });
    const error = await resolveSignalImage(runtime, PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
  });

  it('refuses an image without an immutable sha256 ID', async () => {
    const runtime = fakeRuntime({ [PINNED]: imageInfo({ id: 'latest' }) });
    const error = await resolveSignalImage(runtime, PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
  });

  it('refuses the placeholder digest before any Docker call, pointing at --update-image', async () => {
    const runtime = fakeRuntime({}, imageInfo());
    const error = await resolveSignalImage(
      runtime,
      `${SIGNAL_IMAGE_REPOSITORY}@${SIGNAL_IMAGE_DIGEST_PLACEHOLDER}`,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SignalImageError);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_NOT_PINNED')).toBe(true);
    expect((error as Error).message).toContain('ironcurtain setup-signal --update-image');
    expect(runtime.inspectImage).not.toHaveBeenCalled();
    expect(runtime.pullImage).not.toHaveBeenCalled();
  });

  it('uses a tag only as present locally, with a warning, and never pulls it', async () => {
    const tag = `${SIGNAL_IMAGE_REPOSITORY}:latest`;
    const present = fakeRuntime({ [tag]: imageInfo() }, imageInfo({ id: `sha256:${'d'.repeat(64)}` }));
    const warn = vi.fn();
    await expect(resolveSignalImage(present, tag, { warn })).resolves.toEqual({ id: IMAGE_ID, pinned: false });
    expect(present.pullImage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('names a tag, not a digest'));

    const missing = fakeRuntime({}, imageInfo());
    const error = await resolveSignalImage(missing, tag).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_NOT_PINNED')).toBe(true);
    expect(missing.pullImage).not.toHaveBeenCalled();
  });

  it('refuses an invalid reference without calling Docker', async () => {
    const runtime = fakeRuntime();
    const error = await resolveSignalImage(runtime, '--privileged').catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_INVALID')).toBe(true);
    expect(runtime.inspectImage).not.toHaveBeenCalled();
  });

  it('reminds that --update-image exists when the image is old', async () => {
    const now = Date.parse('2026-11-11T00:00:00Z');
    const created = new Date(now - (SIGNAL_IMAGE_STALE_DAYS + 10) * 86_400_000).toISOString();
    const runtime = fakeRuntime({ [PINNED]: imageInfo({ created }) });
    const warn = vi.fn();
    await resolveSignalImage(runtime, PINNED, { warn, now: () => now });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`was built ${SIGNAL_IMAGE_STALE_DAYS + 10} days ago`));

    const fresh = vi.fn();
    await resolveSignalImage(fakeRuntime({ [PINNED]: imageInfo({ created: new Date(now).toISOString() }) }), PINNED, {
      warn: fresh,
      now: () => now,
    });
    expect(fresh).not.toHaveBeenCalled();
  });
});

describe('pullSignalImageCandidate', () => {
  it('pulls the latest tag for a pinned or default image and returns its digest reference', async () => {
    const runtime = fakeRuntime({}, imageInfo({ created: '2026-11-01T00:00:00Z' }));
    for (const configured of [PINNED, `${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`]) {
      await expect(pullSignalImageCandidate(runtime, configured)).resolves.toEqual({
        source: `${SIGNAL_IMAGE_REPOSITORY}:latest`,
        reference: PINNED,
        digest: DIGEST,
        imageId: IMAGE_ID,
        created: '2026-11-01T00:00:00Z',
      });
    }
    expect(runtime.pullImage).toHaveBeenCalledWith(`${SIGNAL_IMAGE_REPOSITORY}:latest`);
  });

  it('pulls the tag a configured image names', async () => {
    const runtime = fakeRuntime({}, imageInfo());
    const candidate = await pullSignalImageCandidate(runtime, `${SIGNAL_IMAGE_REPOSITORY}:0.92`);
    expect(runtime.pullImage).toHaveBeenCalledWith(`${SIGNAL_IMAGE_REPOSITORY}:0.92`);
    expect(candidate.reference).toBe(PINNED);
  });

  it('refuses to guess between several registry digests, and fails without any', async () => {
    const several = fakeRuntime({}, imageInfo({ repoDigests: [PINNED, `${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`] }));
    const error = await pullSignalImageCandidate(several, PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
    expect((error as Error).message).toContain(OTHER_DIGEST);

    const none = fakeRuntime({}, imageInfo({ repoDigests: [] }));
    const noDigest = await pullSignalImageCandidate(none, PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(noDigest, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
  });

  it('reports a failed pull', async () => {
    const error = await pullSignalImageCandidate(fakeRuntime(), PINNED).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_UNAVAILABLE')).toBe(true);
  });
});

describe('discardSignalImageCandidate', () => {
  const TAG = `${SIGNAL_IMAGE_REPOSITORY}:latest`;
  const OLD_ID = `sha256:${'e'.repeat(64)}`;
  const previous = imageInfo({ id: OLD_ID, repoDigests: [`${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`] });

  it('puts a configured tag back on the image it named, so declining changes what runs not at all', async () => {
    // signal.container.image names the tag, so the bridge runs whatever it names locally.
    const runtime = fakeRuntime({ [TAG]: previous }, imageInfo());
    const candidate = await pullSignalImageCandidate(runtime, TAG);
    expect(runtime.local.get(TAG)?.id).toBe(IMAGE_ID);
    expect(candidate.tagBefore).toEqual({ imageId: OLD_ID });

    await expect(discardSignalImageCandidate(runtime, candidate)).resolves.toBe(true);
    expect(runtime.tagImage).toHaveBeenCalledWith(OLD_ID, TAG);
    expect(runtime.local.get(TAG)?.id).toBe(OLD_ID);
    await expect(resolveSignalImage(runtime, TAG)).resolves.toEqual({ id: OLD_ID, pinned: false });
  });

  it('removes a configured tag that was not present before the pull', async () => {
    const runtime = fakeRuntime({}, imageInfo());
    const candidate = await pullSignalImageCandidate(runtime, TAG);

    await expect(discardSignalImageCandidate(runtime, candidate)).resolves.toBe(true);
    expect(runtime.removeImage).toHaveBeenCalledWith(TAG);
    expect(runtime.local.has(TAG)).toBe(false);
    const error = await resolveSignalImage(runtime, TAG).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_NOT_PINNED')).toBe(true);
  });

  it('touches no tag for a configuration pinned by digest, which the moved tag does not affect', async () => {
    for (const configured of [PINNED, `${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`]) {
      const runtime = fakeRuntime({ [TAG]: previous }, imageInfo());
      const candidate = await pullSignalImageCandidate(runtime, configured);
      expect(candidate.tagBefore).toBeUndefined();
      await expect(discardSignalImageCandidate(runtime, candidate)).resolves.toBe(true);
      expect(runtime.tagImage).not.toHaveBeenCalled();
      expect(runtime.removeImage).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the pull did not move the tag', async () => {
    const runtime = fakeRuntime({ [TAG]: imageInfo() }, imageInfo());
    const candidate = await pullSignalImageCandidate(runtime, TAG);
    await expect(discardSignalImageCandidate(runtime, candidate)).resolves.toBe(true);
    expect(runtime.tagImage).not.toHaveBeenCalled();
    expect(runtime.removeImage).not.toHaveBeenCalled();
  });

  it('says so when the tag cannot be put back', async () => {
    const runtime = fakeRuntime({ [TAG]: previous }, imageInfo(), { tagFails: true });
    const candidate = await pullSignalImageCandidate(runtime, TAG);
    await expect(discardSignalImageCandidate(runtime, candidate)).resolves.toBe(false);
    expect(tagNotRestoredMessage(TAG)).toContain(`docker image rm ${TAG}`);
  });

  it('puts the tag back before refusing a pulled image it cannot pin', async () => {
    const several = imageInfo({ repoDigests: [PINNED, `${SIGNAL_IMAGE_REPOSITORY}@${OTHER_DIGEST}`] });
    const runtime = fakeRuntime({ [TAG]: previous }, several);
    const error = await pullSignalImageCandidate(runtime, TAG).catch((err: unknown) => err);
    expect(hasSignalImageErrorCode(error, 'SIGNAL_IMAGE_MISMATCH')).toBe(true);
    expect(runtime.local.get(TAG)?.id).toBe(OLD_ID);

    const stuck = fakeRuntime({ [TAG]: previous }, several, { tagFails: true });
    const stuckError = await pullSignalImageCandidate(stuck, TAG).catch((err: unknown) => err);
    expect((stuckError as Error).message).toContain(tagNotRestoredMessage(TAG));
  });
});

describe('authenticated image contract', () => {
  it('refuses a locally available unmodified upstream image', async () => {
    const runtime = fakeRuntime({ [PINNED]: imageInfo({ labels: {} }) });
    await expect(resolveSignalImage(runtime, PINNED)).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_AUTH_REQUIRED' });
    expect(runtime.pullImage).not.toHaveBeenCalled();
  });
  it('refuses an unauthenticated update and restores the previous local tag', async () => {
    const tag = `${SIGNAL_IMAGE_REPOSITORY}:latest`;
    const previous = imageInfo({ id: `sha256:${'d'.repeat(64)}` });
    const runtime = fakeRuntime({ [tag]: previous }, imageInfo({ labels: {} }));
    await expect(pullSignalImageCandidate(runtime, tag)).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_AUTH_REQUIRED' });
    expect(runtime.local.get(tag)?.id).toBe(previous.id);
  });
  it('does not try to download the local derived image', async () => {
    const runtime = fakeRuntime();
    await expect(pullSignalImageCandidate(runtime, SIGNAL_BRIDGE_LOCAL_IMAGE)).rejects.toMatchObject({
      code: 'SIGNAL_IMAGE_NOT_PINNED',
    });
    expect(runtime.pullImage).not.toHaveBeenCalled();
  });
});
