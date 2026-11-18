/**
 * Build identity of IronCurtain's base and agent images (leaf module).
 *
 * Every image carries the content hash of its build inputs in the
 * `ironcurtain.build-hash` label (`computeDockerBuildHash` in
 * docker-infrastructure.ts). Images are built under a tag derived from that
 * hash, `<repository>:build-<16 hex>`, and sessions create containers from
 * that tag. The logical `:latest` tag is a moving alias pointed at the build
 * resolved last, kept for manual use and for consumers that address the image
 * by name and re-verify its label. So a development checkout and an installed
 * release, which compute different hashes, each keep their own build instead
 * of rebuilding each other's `:latest` (and its multi-GB base), and a build
 * from one can never be swapped under a session of the other.
 *
 * A tag is only an address: reuse is always decided by the full label.
 */

/** Label carrying the content hash an image was built from. */
export const IMAGE_BUILD_HASH_LABEL = 'ironcurtain.build-hash';

/** The base image's moving alias; builds live under {@link imageBuildTag}. */
export const BASE_IMAGE_LOGICAL_NAME = 'ironcurtain-base:latest';

/** A build hash: lowercase SHA-256 hex. */
export const IMAGE_BUILD_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Hex characters of the build hash in a build tag. */
const BUILD_TAG_HASH_CHARS = 16;

/** Matches the tag part of a build tag. */
const BUILD_TAG_SUFFIX = /:build-[0-9a-f]{16}$/u;

/** An immutable image ID: `sha256:` and 64 hex digits (the prefix may be omitted). */
const IMMUTABLE_IMAGE_ID = /^(?:sha256:)?[0-9a-f]{64}$/u;

/**
 * True when `reference` is an immutable image ID rather than a tag, which a
 * later build or another checkout could re-point at a different image.
 */
export function isImmutableImageId(reference: string): boolean {
  return IMMUTABLE_IMAGE_ID.test(reference);
}

/** The repository of an image reference (`name:tag` → `name`; a registry port is kept). */
export function imageRepository(reference: string): string {
  const colon = reference.lastIndexOf(':');
  return colon > reference.lastIndexOf('/') ? reference.slice(0, colon) : reference;
}

/**
 * The build tag of `logicalName`'s repository for `buildHash`:
 * `ironcurtain-claude-code:latest` → `ironcurtain-claude-code:build-<16 hex>`.
 */
export function imageBuildTag(logicalName: string, buildHash: string): string {
  if (!IMAGE_BUILD_HASH_PATTERN.test(buildHash)) {
    throw new Error(`invalid image build hash for ${imageRepository(logicalName)}`);
  }
  return `${imageRepository(logicalName)}:build-${buildHash.slice(0, BUILD_TAG_HASH_CHARS)}`;
}

/** True when `reference` is the build tag of `logicalName` for `buildHash`. */
export function isImageBuildTagOf(reference: string, logicalName: string, buildHash: string): boolean {
  return IMAGE_BUILD_HASH_PATTERN.test(buildHash) && reference === imageBuildTag(logicalName, buildHash);
}

/** True when `reference` is a build tag of `repository` (any build). */
export function isImageBuildTagIn(reference: string, repository: string): boolean {
  return BUILD_TAG_SUFFIX.test(reference) && imageRepository(reference) === repository;
}

/** The first characters of a build hash, for messages; `unknown` for anything else. */
export function shortBuildHash(value: unknown): string {
  return typeof value === 'string' && IMAGE_BUILD_HASH_PATTERN.test(value)
    ? value.slice(0, BUILD_TAG_HASH_CHARS)
    : 'unknown';
}
