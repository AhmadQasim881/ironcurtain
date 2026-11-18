/**
 * Only the reviewed derived TLS/authenticated Signal bridge may run. The
 * default is a locally built image, resolved to its immutable ID without a
 * pull. Published custom images may be pinned by digest; explicit updates
 * must retain the same authentication contract and restore declined tags.
 */

import type { ContainerRuntime, DockerImageInfo } from '../docker/types.js';

/** Repository of the signal-cli REST bridge image. */
export const SIGNAL_IMAGE_REPOSITORY = 'bbernhard/signal-cli-rest-api';

/** Security contract of the derived TLS/authenticated bridge, not an upstream label. */
export const SIGNAL_BRIDGE_AUTH_LABEL = 'org.ironcurtain.signal-bridge-auth';
export const SIGNAL_BRIDGE_AUTH_VERSION = '1';
export const SIGNAL_BRIDGE_LOCAL_IMAGE = 'ironcurtain-signal-bridge:0.101-auth1';
export const SIGNAL_BRIDGE_BUILD_COMMAND = 'npm run build:signal-bridge';

/** Tag `setup-signal --update-image` pulls when the configured image names none. */
export const SIGNAL_IMAGE_UPDATE_TAG = 'latest';

/**
 * Placeholder digest (all zeros). It names no image, so it can be neither
 * pulled nor run: an image reference carrying it is refused before any
 * Docker call.
 */
export const SIGNAL_IMAGE_DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;

/** Legacy placeholder retained for callers rejecting old all-zero references; not the local default. */
export const SIGNAL_IMAGE_PINNED_DIGEST: string = SIGNAL_IMAGE_DIGEST_PLACEHOLDER;

/** Local derived image; build explicitly before setup. Never automatically pulled. */
export const SIGNAL_DEFAULT_IMAGE = SIGNAL_BRIDGE_LOCAL_IMAGE;

/** Age (days) after which starting the bridge logs a reminder that `--update-image` exists. */
export const SIGNAL_IMAGE_STALE_DAYS = 90;

const UPDATE_COMMAND = 'ironcurtain setup-signal --update-image';

/** `sha256:` plus 64 lowercase hex digits: the only digest syntax accepted. */
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
/** Immutable local image ID syntax. */
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
/** Docker's tag grammar. */
const TAG = /^\w[\w.-]{0,127}$/u;
const DOMAIN = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]+)?';
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
/** Docker's repository grammar: an optional registry host, then lowercase path components. */
const REPOSITORY = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*$`, 'u');
/** Longest reference accepted (Docker caps the name at 255 characters). */
const MAX_REFERENCE_LENGTH = 512;

/** A parsed image reference: `repository[:tag][@digest]`. */
export interface ImageReference {
  /** The repository without tag or digest, e.g. `bbernhard/signal-cli-rest-api`. */
  readonly repository: string;
  readonly tag?: string;
  /** `sha256:<64 hex>` when the reference names a digest. */
  readonly digest?: string;
}

/**
 * Parses an image reference, or returns undefined when it is not one
 * (including anything that starts with `-` or holds whitespace).
 */
export function parseImageReference(reference: string): ImageReference | undefined {
  if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) return undefined;
  let rest = reference;
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return undefined;
  }
  let tag: string | undefined;
  const colon = rest.indexOf(':', rest.lastIndexOf('/') + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return undefined;
  }
  if (!REPOSITORY.test(rest)) return undefined;
  return { repository: rest, ...(tag !== undefined ? { tag } : {}), ...(digest !== undefined ? { digest } : {}) };
}

/** Whether a reference names a digest that is not the placeholder. */
export function isDigestPinned(reference: string): boolean {
  const digest = parseImageReference(reference)?.digest;
  return digest !== undefined && digest !== SIGNAL_IMAGE_DIGEST_PLACEHOLDER;
}

/** Docker Hub repositories as Docker lists them: no registry host, no `library/`. */
function canonicalRepository(repository: string): string {
  const name = repository.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//u, '');
  return /^library\/[^/]+$/u.test(name) ? name.slice('library/'.length) : name;
}

/** The registry digests an image was pulled under for `repository` (its RepoDigests), deduplicated. */
export function repoDigestsFor(info: DockerImageInfo, repository: string): string[] {
  const wanted = canonicalRepository(repository);
  const digests = new Set<string>();
  for (const entry of info.repoDigests ?? []) {
    const parsed = parseImageReference(entry);
    if (parsed?.digest !== undefined && canonicalRepository(parsed.repository) === wanted) digests.add(parsed.digest);
  }
  return [...digests];
}

/** Why the bridge image cannot be used; a discriminant, so callers need not import this module's class. */
export type SignalImageErrorCode =
  /** `signal.container.image` is not an image reference. */
  | 'SIGNAL_IMAGE_INVALID'
  /**
   * Using the image needs an explicit, reviewed pull first: the build's
   * default digest is the placeholder, or a configured tag is not present
   * locally (tags are never pulled automatically).
   */
  | 'SIGNAL_IMAGE_NOT_PINNED'
  /** The pinned image is missing locally and could not be pulled. */
  | 'SIGNAL_IMAGE_UNAVAILABLE'
  /** The local image is not the one the reference names (no such digest, no immutable ID). */
  | 'SIGNAL_IMAGE_MISMATCH'
  | 'SIGNAL_IMAGE_AUTH_REQUIRED';

export class SignalImageError extends Error {
  readonly code: SignalImageErrorCode;

  constructor(code: SignalImageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SignalImageError';
    this.code = code;
  }
}

const SIGNAL_IMAGE_ERROR_CODES: ReadonlySet<string> = new Set<SignalImageErrorCode>([
  'SIGNAL_IMAGE_INVALID',
  'SIGNAL_IMAGE_NOT_PINNED',
  'SIGNAL_IMAGE_UNAVAILABLE',
  'SIGNAL_IMAGE_MISMATCH',
  'SIGNAL_IMAGE_AUTH_REQUIRED',
]);

/** Whether `error` carries this {@link SignalImageErrorCode} (checked by its `code`, not by class). */
export function hasSignalImageErrorCode(error: unknown, code: SignalImageErrorCode): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === code;
}

/** Whether `error` carries any {@link SignalImageErrorCode} (checked by its `code`, not by class). */
export function isSignalImageError(error: unknown): error is Error & { readonly code: SignalImageErrorCode } {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SIGNAL_IMAGE_ERROR_CODES.has(code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Docker calls the image functions need. */
export type SignalImageRuntime = Pick<ContainerRuntime, 'inspectImage' | 'pullImage'>;

/**
 * The Docker calls an explicit update needs: a pull moves a local tag, and a
 * declined or unusable candidate must put it back (`tagImage` is optional in
 * {@link ContainerRuntime}; without it a tag can only be removed).
 */
export type SignalImageUpdateRuntime = Pick<
  ContainerRuntime,
  'inspectImage' | 'pullImage' | 'removeImage' | 'tagImage'
>;

/** Optional progress and warning sinks (the module itself does not log). */
export interface SignalImageHooks {
  readonly info?: (message: string) => void;
  readonly warn?: (message: string) => void;
  /** Current time in ms, for the age reminder (tests). */
  readonly now?: () => number;
}

/** The configured image resolved to a local image. */
export interface ResolvedSignalImage {
  /** Immutable local image ID (`sha256:...`): the container is created from it. */
  readonly id: string;
  /** True when the configured reference names a digest (false: a tag used as present locally). */
  readonly pinned: boolean;
}

function placeholderMessage(image: string): string {
  return (
    `The configured Signal image (${image}) is an unusable legacy placeholder. ` +
    `Build with "${SIGNAL_BRIDGE_BUILD_COMMAND}" and set signal.container.image to ${SIGNAL_BRIDGE_LOCAL_IMAGE}, ` +
    `or configure a published authenticated image and review it with "${UPDATE_COMMAND}".`
  );
}

/**
 * Resolves the configured bridge image to the immutable ID of a local image,
 * without ever pulling a tag:
 *
 * - `<repository>@sha256:...` is pulled only when missing locally, and the
 *   local image must carry that digest;
 * - a tag is used only when the image is already present locally (it is not
 *   updated);
 * - the placeholder digest, an invalid reference, a missing tag or a missing
 *   digest that cannot be pulled throw a {@link SignalImageError} that says
 *   what to do.
 *
 * An image older than {@link SIGNAL_IMAGE_STALE_DAYS} days earns a warning
 * (signal-cli has to keep up with Signal's servers).
 */
export async function resolveSignalImage(
  runtime: SignalImageRuntime,
  image: string,
  hooks: SignalImageHooks = {},
): Promise<ResolvedSignalImage> {
  const reference = parseImageReference(image);
  if (reference === undefined) {
    throw new SignalImageError(
      'SIGNAL_IMAGE_INVALID',
      `signal.container.image is not a valid image reference: ${JSON.stringify(image)}. ` +
        `Use ${SIGNAL_IMAGE_REPOSITORY}@sha256:<digest>, or run "${UPDATE_COMMAND}" to record one.`,
    );
  }

  let info: DockerImageInfo | undefined;
  if (reference.digest !== undefined) {
    if (reference.digest === SIGNAL_IMAGE_DIGEST_PLACEHOLDER) {
      throw new SignalImageError('SIGNAL_IMAGE_NOT_PINNED', placeholderMessage(image));
    }
    // The digest alone decides; a tag next to it is ignored, as Docker does.
    const pinned = `${reference.repository}@${reference.digest}`;
    info = await runtime.inspectImage(pinned);
    if (info === undefined) {
      hooks.info?.(`Pulling the pinned image ${pinned}...`);
      try {
        await runtime.pullImage(pinned);
      } catch (err) {
        throw new SignalImageError(
          'SIGNAL_IMAGE_UNAVAILABLE',
          `Could not pull the pinned signal-cli image ${pinned}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      info = await runtime.inspectImage(pinned);
      if (info === undefined) {
        throw new SignalImageError(
          'SIGNAL_IMAGE_UNAVAILABLE',
          `The pinned signal-cli image ${pinned} is not present after pulling it.`,
        );
      }
    }
    if (!repoDigestsFor(info, reference.repository).includes(reference.digest)) {
      throw new SignalImageError(
        'SIGNAL_IMAGE_MISMATCH',
        `The local image found for ${pinned} does not carry that digest; refusing to run it.`,
      );
    }
  } else {
    info = await runtime.inspectImage(image);
    if (info === undefined) {
      if (image === SIGNAL_BRIDGE_LOCAL_IMAGE) {
        throw new SignalImageError(
          'SIGNAL_IMAGE_NOT_PINNED',
          `The authenticated Signal image is not built locally. Run "${SIGNAL_BRIDGE_BUILD_COMMAND}" before setup.`,
        );
      }
      throw new SignalImageError(
        'SIGNAL_IMAGE_NOT_PINNED',
        `signal.container.image (${image}) names a tag, not a digest, and that image is not present locally. ` +
          `IronCurtain does not pull tags on its own: run "${UPDATE_COMMAND}" to pull it, review its digest and pin it.`,
      );
    }
    if (image !== SIGNAL_BRIDGE_LOCAL_IMAGE)
      hooks.warn?.(
        `signal.container.image (${image}) names a tag, not a digest: the local image is used as it is and never ` +
          `updated automatically. Run "${UPDATE_COMMAND}" to pin it by digest.`,
      );
  }

  if (!IMAGE_ID.test(info.id)) {
    throw new SignalImageError(
      'SIGNAL_IMAGE_MISMATCH',
      `The local image for ${image} has no immutable sha256 image ID; refusing to run it.`,
    );
  }
  if (info.labels[SIGNAL_BRIDGE_AUTH_LABEL] !== SIGNAL_BRIDGE_AUTH_VERSION) {
    throw new SignalImageError('SIGNAL_IMAGE_AUTH_REQUIRED', authenticatedImageRequiredMessage());
  }
  warnIfStale(info, image, hooks);
  return { id: info.id, pinned: reference.digest !== undefined };
}

function authenticatedImageRequiredMessage(): string {
  return (
    'The Signal image does not implement the required TLS/authentication contract. ' +
    'Unmodified signal-cli-rest-api images are refused. Build the reviewed derived image with ' +
    '"npm run build:signal-bridge", or configure a reviewed published authenticated image.'
  );
}

function warnIfStale(info: DockerImageInfo, image: string, hooks: SignalImageHooks): void {
  const created = Date.parse(info.created);
  if (!Number.isFinite(created)) return;
  const days = Math.floor(((hooks.now ?? Date.now)() - created) / 86_400_000);
  if (days < SIGNAL_IMAGE_STALE_DAYS) return;
  hooks.warn?.(
    `The signal-cli image ${image} was built ${days} days ago. Signal changes its protocol from time to time; ` +
      `if the bridge stops working, run "${UPDATE_COMMAND}".`,
  );
}

/** A freshly pulled image, ready to be pinned. */
export interface SignalImageCandidate {
  /** The tag reference that was pulled, e.g. `bbernhard/signal-cli-rest-api:latest`. */
  readonly source: string;
  /** The reference to record: `<repository>@sha256:...`. */
  readonly reference: string;
  /** The registry (index) digest of the pulled image. */
  readonly digest: string;
  /** The local image ID. */
  readonly imageId: string;
  /** When the image was built, as Docker reports it. */
  readonly created: string;
  /**
   * Set when the configured image is the pulled tag itself (a tag, no
   * digest): the image ID that tag named locally before the pull, undefined
   * when it named none. The bridge runs whatever that tag names and the pull
   * moved it, so a declined candidate puts it back
   * ({@link discardSignalImageCandidate}). Unset for a configuration pinned
   * by digest, which the moved tag does not affect.
   */
  readonly tagBefore?: { readonly imageId: string | undefined };
}

/**
 * Pulls the current image for the configured one (its repository, at the tag
 * it names or {@link SIGNAL_IMAGE_UPDATE_TAG}) and returns the digest
 * reference that pins it. Only for explicit, interactive updates
 * (`setup-signal --update-image` and the setup wizard): the caller shows the
 * digest and records it only once the user confirms, and otherwise calls
 * {@link discardSignalImageCandidate}. Throws a {@link SignalImageError} when
 * the pull fails or Docker reports no single registry digest for the image;
 * a configured tag the pull moved is put back first.
 */
export async function pullSignalImageCandidate(
  runtime: SignalImageUpdateRuntime,
  configuredImage: string,
): Promise<SignalImageCandidate> {
  if (configuredImage === SIGNAL_BRIDGE_LOCAL_IMAGE) {
    throw new SignalImageError(
      'SIGNAL_IMAGE_NOT_PINNED',
      `The local authenticated Signal image is rebuilt with "${SIGNAL_BRIDGE_BUILD_COMMAND}"; it is never pulled.`,
    );
  }
  const reference = parseImageReference(configuredImage);
  if (reference === undefined) {
    throw new SignalImageError(
      'SIGNAL_IMAGE_INVALID',
      `signal.container.image is not a valid image reference: ${JSON.stringify(configuredImage)}.`,
    );
  }
  const source = `${reference.repository}:${reference.tag ?? SIGNAL_IMAGE_UPDATE_TAG}`;
  // A configuration without a digest runs whatever this tag names locally,
  // and the pull below moves it: note where it pointed, so that a candidate
  // that is declined or cannot be pinned leaves the bridge image as it was.
  const tagBefore = reference.digest === undefined ? { imageId: (await runtime.inspectImage(source))?.id } : undefined;
  try {
    await runtime.pullImage(source);
  } catch (err) {
    // A pull that fails leaves the tag where it was.
    throw new SignalImageError('SIGNAL_IMAGE_UNAVAILABLE', `Could not pull ${source}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  const refuse = async (code: SignalImageErrorCode, message: string): Promise<SignalImageError> => {
    if (tagBefore === undefined || (await restoreTag(runtime, source, tagBefore.imageId))) {
      return new SignalImageError(code, message);
    }
    return new SignalImageError(code, `${message} ${tagNotRestoredMessage(source)}`);
  };
  const info = await runtime.inspectImage(source);
  if (info === undefined) {
    throw await refuse('SIGNAL_IMAGE_UNAVAILABLE', `${source} is not present after pulling it.`);
  }
  const digests = repoDigestsFor(info, reference.repository);
  if (digests.length !== 1) {
    throw await refuse(
      'SIGNAL_IMAGE_MISMATCH',
      digests.length === 0
        ? `Docker reports no registry digest for ${source}, so it cannot be pinned.`
        : `Docker reports several registry digests for ${source} (${digests.join(', ')}). ` +
            `Pin one by setting signal.container.image to ${reference.repository}@<digest>.`,
    );
  }
  if (!IMAGE_ID.test(info.id)) {
    throw await refuse('SIGNAL_IMAGE_MISMATCH', `${source} has no immutable sha256 image ID.`);
  }
  if (info.labels[SIGNAL_BRIDGE_AUTH_LABEL] !== SIGNAL_BRIDGE_AUTH_VERSION) {
    throw await refuse('SIGNAL_IMAGE_AUTH_REQUIRED', authenticatedImageRequiredMessage());
  }
  const digest = digests[0];
  return {
    source,
    reference: `${reference.repository}@${digest}`,
    digest,
    imageId: info.id,
    created: info.created,
    ...(tagBefore !== undefined ? { tagBefore } : {}),
  };
}

/**
 * Undoes the pull of a candidate the user declined, so that declining
 * changes nothing: when the configured image is the pulled tag (see
 * {@link SignalImageCandidate.tagBefore}), the tag is put back on the image
 * it named before, or removed when it named none. Returns false when that
 * failed; the caller must then warn with {@link tagNotRestoredMessage}.
 */
export async function discardSignalImageCandidate(
  runtime: SignalImageUpdateRuntime,
  candidate: SignalImageCandidate,
): Promise<boolean> {
  if (candidate.tagBefore === undefined) return true;
  return restoreTag(runtime, candidate.source, candidate.tagBefore.imageId);
}

/** What to tell the user when a tag the update pull moved could not be put back. */
export function tagNotRestoredMessage(tag: string): string {
  return (
    `The local tag ${tag} now names the image just pulled and could not be put back. ` +
    'signal.container.image names that tag, so the bridge would run that image when it next starts: ' +
    `pin an image by digest (${SIGNAL_IMAGE_REPOSITORY}@sha256:...) or remove the tag (docker image rm ${tag}) first.`
  );
}

/**
 * Makes `tag` name the image `imageId` again, or nothing when `imageId` is
 * undefined. Returns whether the tag names exactly that afterwards.
 */
async function restoreTag(
  runtime: SignalImageUpdateRuntime,
  tag: string,
  imageId: string | undefined,
): Promise<boolean> {
  const current = async (): Promise<string | undefined> => (await runtime.inspectImage(tag))?.id;
  if ((await current()) === imageId) return true;
  try {
    if (imageId === undefined) await runtime.removeImage(tag);
    else if (runtime.tagImage !== undefined) await runtime.tagImage(imageId, tag);
    else return false;
  } catch {
    return false;
  }
  return (await current()) === imageId;
}
