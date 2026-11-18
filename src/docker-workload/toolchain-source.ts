/** One source selection shared by the agent and daemon build transaction. */
import type { ContainerRuntime, DockerImageInfo } from '../docker/types.js';
import { getFrozenClientToolchainManifestPath } from '../docker/docker-workload-paths.js';
import { getDockerToolchainSourceReference, loadClientToolchainManifest } from './client-toolchain.js';

export interface DockerToolchainSource {
  readonly architecture: 'amd64' | 'arm64';
  readonly imageId: string;
  readonly reference: string;
}

export async function resolveDockerToolchainSource(
  runtime: Pick<ContainerRuntime, 'inspectImage' | 'pullImage'>,
  architecture: DockerToolchainSource['architecture'],
): Promise<DockerToolchainSource> {
  const tag = dockerToolchainSourceTag(architecture);
  let image = await runtime.inspectImage(tag);
  if (image === undefined) {
    await runtime.pullImage(tag);
    image = await runtime.inspectImage(tag);
  }
  return toolchainSourceOf(tag, image, architecture);
}

/**
 * The source {@link resolveDockerToolchainSource} selects on this engine,
 * computed from the toolchain image already present (it is never pulled), or
 * undefined when that image is absent or unusable. The platform is the
 * image's own: a resolution only succeeds for an execution platform the image
 * matches. `ironcurtain images` uses it to recognize this installation's
 * nested-Docker image builds, whose build hash includes this source.
 */
export async function findLocalDockerToolchainSource(
  runtime: Pick<ContainerRuntime, 'inspectImage'>,
): Promise<DockerToolchainSource | undefined> {
  // The versioned tag names the daemon version, the same for every platform.
  const tag = dockerToolchainSourceTag('amd64');
  const image = await runtime.inspectImage(tag);
  const architecture = image?.architecture;
  if (architecture === undefined) return undefined;
  try {
    return toolchainSourceOf(tag, image, architecture);
  } catch {
    return undefined;
  }
}

function dockerToolchainSourceTag(architecture: DockerToolchainSource['architecture']): string {
  const { manifest } = loadClientToolchainManifest(getFrozenClientToolchainManifestPath(), architecture);
  return getDockerToolchainSourceReference(manifest);
}

function toolchainSourceOf(
  tag: string,
  image: DockerImageInfo | undefined,
  architecture: DockerToolchainSource['architecture'],
): DockerToolchainSource {
  if (image === undefined || !/^sha256:[a-f0-9]{64}$/u.test(image.id)) {
    throw new Error(`Docker toolchain source did not resolve to an image ID: ${tag}`);
  }
  if (image.architecture !== architecture) {
    throw new Error(
      `Docker toolchain source platform ${image.architecture ?? '(missing)'} does not match execution platform ${architecture}`,
    );
  }
  // OCI repository digests are runtime-returned source identities, not a
  // maintained release allowlist. Both builds consume this same reference.
  const reference =
    image.repoDigests?.find((ref) => /@sha256:[a-f0-9]{64}$/u.test(ref)) ??
    (image.descriptorDigest !== undefined && /^sha256:[a-f0-9]{64}$/u.test(image.descriptorDigest)
      ? `${tag}@${image.descriptorDigest}`
      : undefined);
  if (reference === undefined) {
    throw new Error(
      `Docker toolchain source has no usable immutable registry descriptor: ${tag}; pull the versioned source again`,
    );
  }
  return { architecture, imageId: image.id, reference };
}
