/**
 * The macOS Docker Desktop transport sidecar image.
 *
 * On the `tcp-sidecar` topology a small socat container bridges the
 * session's `--internal` network to the host-side MCP and MITM proxies (and,
 * in PTY mode, the terminal). It relays plaintext MCP JSON-RPC and the
 * agent's CONNECT streams, so it is part of the isolation boundary: a
 * replaced image could read or tamper with every tool call or hand the agent
 * unfiltered egress. The image is therefore
 *
 *   - built locally from the vendored `docker/transport-sidecar/Dockerfile`
 *     (the Docker Official alpine image plus Alpine's signed socat package),
 *     never pulled by name from a third-party namespace (it used to be
 *     `alpine/socat`, i.e. `:latest` of a community repository, trusted by
 *     name);
 *   - resolved here, in one place, through the build-hash-labelled image
 *     cache: the image is rebuilt whenever the Dockerfile changes, and the
 *     container is created from the immutable image ID whose labels name
 *     this build, so a local image that merely carries the tag is never run;
 *   - run read-only, as an unprivileged user, with every capability dropped
 *     and no new privileges, on top of the resource partition the caller
 *     already applies.
 *
 * Nothing else names the image: both the batch session path
 * (`docker-infrastructure.ts`) and the PTY path (`pty-session.ts`) call
 * {@link ensureTransportSidecarImage} and {@link hardenTransportSidecarCreate}.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainPackageRoot } from './docker-workload-paths.js';
import type { EffectiveDockerResources } from './resource-limits.js';
import type { ContainerRuntime, DockerTrustedCreateOptions } from './types.js';

/** Local tag of the sidecar image (a cache key only: the container is created by immutable ID). */
export const TRANSPORT_SIDECAR_IMAGE = 'ironcurtain-transport-sidecar:latest';

/** Label holding the hash of the build inputs, as for every locally built IronCurtain image. */
export const TRANSPORT_SIDECAR_BUILD_HASH_LABEL = 'ironcurtain.build-hash';

/** Label naming the component, so an image built from another context never passes as the sidecar. */
export const TRANSPORT_SIDECAR_COMPONENT_LABEL = 'ironcurtain.component';
export const TRANSPORT_SIDECAR_COMPONENT = 'transport-sidecar';

/**
 * The sidecar's user: `nobody`. socat needs no privilege (the relayed ports
 * are unprivileged) and no writable path.
 */
export const TRANSPORT_SIDECAR_USER = '65534:65534';

/** Immutable image ID syntax: `sha256:` plus 64 lowercase hex digits. */
const SHA256_IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;

/** The files of the build context that determine the image. */
const BUILD_INPUTS = ['Dockerfile'] as const;

/** The vendored build context (`<package>/docker/transport-sidecar`). */
export function transportSidecarContextDir(): string {
  return resolve(getIronCurtainPackageRoot(), 'docker', 'transport-sidecar');
}

/** sha256 (hex) of the build inputs; any change to them rebuilds the image. */
export function computeTransportSidecarBuildHash(contextDir: string): string {
  const hash = createHash('sha256');
  for (const file of BUILD_INPUTS) {
    hash.update(`file:${file}\n`);
    hash.update(readFileSync(resolve(contextDir, file)));
  }
  return hash.digest('hex');
}

/**
 * Builds the sidecar image when the cached one is missing or was built from
 * other inputs, then resolves it to its immutable image ID. Throws (and the
 * session fails closed) when the build fails, or when the image the tag
 * resolves to afterwards is not this build: no sha256 ID, another build
 * hash, or another component.
 *
 * `contextDir` exists for tests; production callers use the vendored context.
 */
export async function ensureTransportSidecarImage(
  runtime: Pick<ContainerRuntime, 'buildImage' | 'getImageLabel' | 'inspectImage'>,
  log: (message: string) => void = () => undefined,
  contextDir: string = transportSidecarContextDir(),
): Promise<string> {
  const buildHash = computeTransportSidecarBuildHash(contextDir);
  const cachedHash = await runtime.getImageLabel(TRANSPORT_SIDECAR_IMAGE, TRANSPORT_SIDECAR_BUILD_HASH_LABEL);
  if (cachedHash !== buildHash) {
    log('Building the transport sidecar image...');
    try {
      await runtime.buildImage(TRANSPORT_SIDECAR_IMAGE, resolve(contextDir, 'Dockerfile'), contextDir, {
        [TRANSPORT_SIDECAR_BUILD_HASH_LABEL]: buildHash,
        [TRANSPORT_SIDECAR_COMPONENT_LABEL]: TRANSPORT_SIDECAR_COMPONENT,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not build the transport sidecar image from ${contextDir}: ${detail}. ` +
          'The build pulls the alpine base image and installs socat, so Docker needs network access the first time.',
        { cause: err },
      );
    }
    log('Transport sidecar image built.');
  }
  const image = await runtime.inspectImage(TRANSPORT_SIDECAR_IMAGE);
  if (
    image === undefined ||
    !SHA256_IMAGE_ID.test(image.id) ||
    image.labels[TRANSPORT_SIDECAR_BUILD_HASH_LABEL] !== buildHash ||
    image.labels[TRANSPORT_SIDECAR_COMPONENT_LABEL] !== TRANSPORT_SIDECAR_COMPONENT
  ) {
    throw new Error(
      `The transport sidecar image ${TRANSPORT_SIDECAR_IMAGE} did not resolve to its expected local build; ` +
        'refusing to run it',
    );
  }
  return image.id;
}

/**
 * The hardening applied to the sidecar container on top of the Docker
 * Desktop resource partition (`buildDockerDesktopTransportCreateLimits`):
 * read-only root filesystem, no new privileges, the `nobody` user. Every
 * capability is already dropped by `buildCreateArgs` (`--cap-drop=ALL`) and
 * the sidecar adds none back. Security options the limits already carry are
 * kept.
 */
export function hardenTransportSidecarCreate(limits: {
  readonly resources?: EffectiveDockerResources;
  readonly trustedCreateOptions?: DockerTrustedCreateOptions;
}): {
  readonly resources?: EffectiveDockerResources;
  readonly trustedCreateOptions: DockerTrustedCreateOptions;
  readonly user: string;
} {
  const securityOptions = [
    ...new Set([...(limits.trustedCreateOptions?.securityOptions ?? []), 'no-new-privileges:true']),
  ];
  return {
    ...(limits.resources !== undefined ? { resources: limits.resources } : {}),
    trustedCreateOptions: {
      ...limits.trustedCreateOptions,
      readOnlyRootfs: true,
      securityOptions,
    },
    user: TRANSPORT_SIDECAR_USER,
  };
}
