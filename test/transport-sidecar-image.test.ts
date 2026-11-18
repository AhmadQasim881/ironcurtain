/**
 * The macOS Docker Desktop transport sidecar image (WP-27,
 * src/docker/transport-sidecar-image.ts): built locally from the vendored
 * docker/transport-sidecar/Dockerfile through the build-hash-labelled image
 * cache, run by the immutable ID whose labels name that build, read-only,
 * as nobody, with every capability dropped and no new privileges. It used to
 * be `alpine/socat` pulled by name (so :latest of a third-party repository)
 * and trusted by name.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCreateArgs } from '../src/docker/docker-manager.js';
import {
  computeTransportSidecarBuildHash,
  ensureTransportSidecarImage,
  hardenTransportSidecarCreate,
  TRANSPORT_SIDECAR_BUILD_HASH_LABEL,
  TRANSPORT_SIDECAR_COMPONENT,
  TRANSPORT_SIDECAR_COMPONENT_LABEL,
  TRANSPORT_SIDECAR_IMAGE,
  TRANSPORT_SIDECAR_USER,
  transportSidecarContextDir,
} from '../src/docker/transport-sidecar-image.js';
import type { ContainerRuntime, DockerImageInfo } from '../src/docker/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const CONTEXT = transportSidecarContextDir();
const HASH = computeTransportSidecarBuildHash(CONTEXT);

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Runtime = Pick<ContainerRuntime, 'buildImage' | 'getImageLabel' | 'inspectImage'>;

/**
 * A runtime whose image cache holds `cached` (the labels the tag carries)
 * until a build stamps new labels on it. `resolvesTo` overrides what the tag
 * inspects to after the build (an image someone else put under the tag).
 */
function runtime(options: {
  readonly cached?: Record<string, string>;
  readonly buildFails?: boolean;
  readonly resolvesTo?: DockerImageInfo | null;
}) {
  let labels = options.cached;
  const buildImage = vi.fn(
    async (_tag: string, _dockerfile: string, _context: string, stamp?: Record<string, string>) => {
      if (options.buildFails) throw new Error('failed to resolve source metadata for docker.io/library/alpine:3.22');
      labels = { ...stamp };
    },
  );
  const getImageLabel = vi.fn(async (image: string, label: string) =>
    image === TRANSPORT_SIDECAR_IMAGE ? labels?.[label] : undefined,
  );
  const inspectImage = vi.fn(async (ref: string): Promise<DockerImageInfo | undefined> => {
    if (options.resolvesTo !== undefined) return options.resolvesTo ?? undefined;
    if (ref !== TRANSPORT_SIDECAR_IMAGE || labels === undefined) return undefined;
    return { id: IMAGE_ID, repoTags: [ref], labels, created: '' };
  });
  const rt: Runtime = { buildImage, getImageLabel, inspectImage };
  return { runtime: rt, buildImage, inspectImage };
}

const CURRENT_LABELS = {
  [TRANSPORT_SIDECAR_BUILD_HASH_LABEL]: HASH,
  [TRANSPORT_SIDECAR_COMPONENT_LABEL]: TRANSPORT_SIDECAR_COMPONENT,
};

describe('the vendored sidecar Dockerfile', () => {
  const dockerfile = readFileSync(resolve(CONTEXT, 'Dockerfile'), 'utf-8');
  const instructions = dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('builds from the Docker Official alpine image and installs socat from Alpine, not from alpine/socat', () => {
    expect(instructions.filter((line) => line.startsWith('FROM '))).toEqual([
      expect.stringMatching(/^FROM alpine:3\.\d+$/),
    ]);
    expect(dockerfile).not.toMatch(/alpine\/socat/);
    expect(instructions).toContain('RUN apk add --no-cache socat');
  });

  it('runs as nobody by default', () => {
    expect(instructions).toContain(`USER ${TRANSPORT_SIDECAR_USER}`);
  });

  it('lives in its own build context with nothing else in it', () => {
    expect(CONTEXT).toBe(resolve(__dirname, '../docker/transport-sidecar'));
    expect(readdirSync(CONTEXT)).toEqual(['Dockerfile']);
  });
});

describe('ensureTransportSidecarImage', () => {
  it('builds the image when none is cached, stamping the build hash and component, and returns its immutable ID', async () => {
    const { runtime: rt, buildImage } = runtime({});
    await expect(ensureTransportSidecarImage(rt)).resolves.toBe(IMAGE_ID);
    expect(buildImage).toHaveBeenCalledOnce();
    expect(buildImage).toHaveBeenCalledWith(
      TRANSPORT_SIDECAR_IMAGE,
      resolve(CONTEXT, 'Dockerfile'),
      CONTEXT,
      CURRENT_LABELS,
    );
  });

  it('reuses the cached image when it was built from the current Dockerfile', async () => {
    const { runtime: rt, buildImage } = runtime({ cached: CURRENT_LABELS });
    await expect(ensureTransportSidecarImage(rt)).resolves.toBe(IMAGE_ID);
    expect(buildImage).not.toHaveBeenCalled();
  });

  it('rebuilds when the Dockerfile changed since the cached build', async () => {
    const context = mkdtempSync(join(tmpdir(), 'ic-sidecar-context-'));
    scratchDirs.push(context);
    cpSync(CONTEXT, context, { recursive: true });
    writeFileSync(
      resolve(context, 'Dockerfile'),
      `${readFileSync(resolve(context, 'Dockerfile'), 'utf-8')}\n# changed\n`,
    );
    const changedHash = computeTransportSidecarBuildHash(context);
    expect(changedHash).not.toBe(HASH);

    const { runtime: rt, buildImage } = runtime({ cached: CURRENT_LABELS });
    await expect(ensureTransportSidecarImage(rt, undefined, context)).resolves.toBe(IMAGE_ID);
    expect(buildImage).toHaveBeenCalledWith(TRANSPORT_SIDECAR_IMAGE, resolve(context, 'Dockerfile'), context, {
      [TRANSPORT_SIDECAR_BUILD_HASH_LABEL]: changedHash,
      [TRANSPORT_SIDECAR_COMPONENT_LABEL]: TRANSPORT_SIDECAR_COMPONENT,
    });
  });

  it('fails closed when the build fails, saying why', async () => {
    const { runtime: rt, inspectImage } = runtime({ buildFails: true });
    await expect(ensureTransportSidecarImage(rt)).rejects.toThrow(
      /Could not build the transport sidecar image .*failed to resolve source metadata.*needs network access/,
    );
    expect(inspectImage).not.toHaveBeenCalled();
  });

  it('never runs an image that is not this build: other hash, other component, no sha256 ID, or none at all', async () => {
    const impostors: Array<DockerImageInfo | null> = [
      {
        id: IMAGE_ID,
        repoTags: [],
        labels: { ...CURRENT_LABELS, [TRANSPORT_SIDECAR_BUILD_HASH_LABEL]: 'f'.repeat(64) },
        created: '',
      },
      {
        id: IMAGE_ID,
        repoTags: [],
        labels: { ...CURRENT_LABELS, [TRANSPORT_SIDECAR_COMPONENT_LABEL]: 'fixed-relay' },
        created: '',
      },
      { id: IMAGE_ID, repoTags: [], labels: { [TRANSPORT_SIDECAR_BUILD_HASH_LABEL]: HASH }, created: '' },
      { id: 'alpine/socat', repoTags: [], labels: CURRENT_LABELS, created: '' },
      null,
    ];
    for (const resolvesTo of impostors) {
      const { runtime: rt } = runtime({ cached: CURRENT_LABELS, resolvesTo });
      await expect(ensureTransportSidecarImage(rt)).rejects.toThrow(/did not resolve to its expected local build/);
    }
  });
});

describe('no session path runs a sidecar image by name', () => {
  it('names no pullable socat image anywhere in src/docker', () => {
    const dockerSrc = resolve(__dirname, '../src/docker');
    for (const file of readdirSync(dockerSrc).filter((name) => name.endsWith('.ts'))) {
      // Code only: comments may still say what the sidecar used to run.
      const code = readFileSync(resolve(dockerSrc, file), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ file, namesSocatImage: /alpine\/socat/.test(code) }).toEqual({ file, namesSocatImage: false });
    }
  });
});

describe('hardenTransportSidecarCreate', () => {
  it('runs the sidecar read-only, as nobody, without new privileges, keeping the resource partition', () => {
    const hardened = hardenTransportSidecarCreate({
      resources: { memoryMb: 64, cpus: 0.25 },
      trustedCreateOptions: { pidsLimit: 32 },
    });
    expect(hardened).toEqual({
      resources: { memoryMb: 64, cpus: 0.25 },
      trustedCreateOptions: { pidsLimit: 32, readOnlyRootfs: true, securityOptions: ['no-new-privileges:true'] },
      user: '65534:65534',
    });

    const args = buildCreateArgs({
      image: IMAGE_ID,
      name: 'ironcurtain-sidecar-test',
      network: 'bridge',
      mounts: [],
      env: {},
      entrypoint: '/bin/sh',
      command: ['-c', 'socat TCP-LISTEN:1,fork TCP:host.docker.internal:1'],
      ...hardenTransportSidecarCreate({}),
    });
    expect(args).toContain('--cap-drop=ALL');
    expect(args).not.toContain('--cap-add');
    expect(args).toContain('--read-only');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges:true');
    expect(args.join(' ')).toContain('--user 65534:65534');
    expect(args).toContain(IMAGE_ID);
  });

  it('keeps security options the limits already carry', () => {
    const hardened = hardenTransportSidecarCreate({
      trustedCreateOptions: { securityOptions: ['apparmor=docker-default', 'no-new-privileges:true'] },
    });
    expect(hardened.trustedCreateOptions.securityOptions).toEqual([
      'apparmor=docker-default',
      'no-new-privileges:true',
    ]);
  });
});
