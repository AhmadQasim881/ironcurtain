/**
 * Registry proxy: URL parsing, metadata filtering, and tarball backstop
 * for the npm, PyPI, Debian and crates.io package registries.
 *
 * The proxy is read-only. This module provides:
 * - The request handler. It refuses anything but a bodiless GET or HEAD
 *   (`registry-request-gate.ts`) and any non-canonical request path
 *   (`registry-request-path.ts`), then routes the request through an explicit
 *   per-registry allowlist ({@link classifyRegistryRoute}). Every request it
 *   forwards or refuses is written to the package audit log
 * - URL parsers that extract PackageIdentity from HTTP request paths, decoding
 *   each path once and checking names against the registry's grammar
 * - Metadata filtering functions that remove disallowed versions (npm, cargo)
 *   and disallowed distribution files (PyPI, gated per file by its own upload
 *   time)
 * - Tarball backstop logic that blocks direct tarball URL access
 * - Built-in registry configurations
 *
 * Metadata work is bounded per proxy ({@link RegistryMetadataBudget}): a
 * queueing limit on concurrent operations, a budget for the bytes buffered at
 * once, a fail-closed per-response ceiling, an absolute deadline per
 * operation, and an idle limit per upstream fetch. An operation whose client
 * disconnects aborts its upstream fetches. npm packuments are filtered without
 * parsing them into objects (`registry-metadata.ts`), and the tarball backstop
 * reads metadata as it streams instead of buffering it.
 */

import type * as http from 'node:http';
import { promises as fs } from 'node:fs';
import type {
  PackageIdentity,
  PackageDecision,
  PackageValidator,
  PackageAuditEntry,
  AllowedVersionCache,
  RegistryConfig,
  RegistryType,
} from './package-types.js';
import { packageCacheKey, canonicalPackageName } from './package-validator.js';
import * as logger from '../logger.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { createDirectOutboundTransport, type OutboundTransport } from './outbound-transport.js';
import { guardUpstreamResponse } from './upstream-response.js';
import { checkRegistryRequestPath } from './registry-request-path.js';
import {
  buildReadOnlyUpstreamHeaders,
  checkRegistryRequestMethodAndBody,
  type ReadOnlyRegistryMethod,
} from './registry-request-gate.js';
import {
  createNpmPackumentIndexer,
  createNpmPublishTimesReader,
  createPypiFileTimesReader,
  formatByteCeiling,
  parsePublishTime,
  pypiDistributionFileKey,
  pypiFileKeyFromUrl,
  RegistryMetadataError,
  stripPypiSidecarSuffix,
  type NpmPackumentIndex,
  type NpmPackumentMember,
  type NpmPublishTimeCache,
  type NpmPublishTimes,
  type StreamingMetadataReader,
} from './registry-metadata.js';
import {
  RegistryMetadataBudget,
  RegistryMetadataBudgetError,
  type RegistryMetadataLimits,
  type RegistryMetadataPermit,
} from './registry-metadata-budget.js';

const DEFAULT_OUTBOUND_TRANSPORT = createDirectOutboundTransport();

// ── Built-in registry configs ───────────────────────────────────────

export const npmRegistry: RegistryConfig = {
  host: 'registry.npmjs.org',
  displayName: 'npm',
  type: 'npm',
};

export const pypiRegistry: RegistryConfig = {
  host: 'pypi.org',
  displayName: 'PyPI',
  type: 'pypi',
  mirrorHosts: ['files.pythonhosted.org'],
};

export const debianRegistry: RegistryConfig = {
  host: 'deb.debian.org',
  displayName: 'Debian APT',
  type: 'debian',
  mirrorHosts: ['security.debian.org'],
};

// crates.io topology. The three hosts need different handling:
//   - index.crates.io  : sparse index (version resolution) — metadata filter,
//                        plus the read-only /config.json
//   - static.crates.io : pure .crate tarball CDN — fail-closed backstop,
//                        exactly like PyPI's files.pythonhosted.org
//   - crates.io        : web API host. Only the legacy download redirect
//                        (backstop) and `cargo search` are routed; publish,
//                        yank, owners and every other API path are refused
const CARGO_INDEX_HOST = 'index.crates.io';
const CARGO_STATIC_HOST = 'static.crates.io';
const CARGO_API_HOST = 'crates.io';

export const cargoRegistry: RegistryConfig = {
  // Primary host is the sparse index — where cargo resolves versions.
  host: CARGO_INDEX_HOST,
  displayName: 'crates.io',
  type: 'cargo',
  // Both download hosts must be in the allowlist so their CONNECTs are
  // MITM-terminated; handleRegistryRequest then routes each by host.
  mirrorHosts: [CARGO_API_HOST, CARGO_STATIC_HOST],
};

// ── URL Parsers ─────────────────────────────────────────────────────

/**
 * One npm scope or package-name component: npm's URL-safe name alphabet,
 * matched case-insensitively so legacy mixed-case names such as `JSONStream`
 * stay valid, at most 214 characters. It starts with a letter or digit, so it
 * is never empty, never `.`-, `_`- or `-`-leading, and never a `.`/`..` path
 * segment. It cannot contain `/`, `\`, `%`, `@` or `:`. A component that passes
 * needs no percent-encoding, so the canonical upstream paths built from it are
 * unambiguous.
 */
const NPM_NAME_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~!'()*-]{0,213}$/;

/** An npm tarball version: semver plus legacy `_`/`~`, URL-safe, at most 256 characters. */
const NPM_TARBALL_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_~-]{0,255}$/;

/** A parsed npm package request: one package's metadata, or one version's tarball. */
export type NpmPackageRequest =
  | { readonly kind: 'metadata'; readonly pkg: PackageIdentity }
  | { readonly kind: 'tarball'; readonly pkg: PackageIdentity & { readonly version: string } };

/**
 * Parses an npm registry URL path into a metadata or tarball request.
 * Returns undefined if the path names no valid package.
 *
 * The query is dropped and the path is percent-decoded once, so the request is
 * classified as the registry will read it: `/@types%2fnode` is `@types/node`,
 * and an encoded `-` separator still marks a tarball. Patterns:
 *   GET /@scope/name                     -> metadata (scope + name)
 *   GET /@scope%2fname                   -> metadata (URL-encoded scope separator)
 *   GET /name                            -> metadata (unscoped)
 *   GET /name/-/name-1.0.0.tgz           -> tarball (unscoped)
 *   GET /@scope/name/-/name-1.0.0.tgz    -> tarball (scoped)
 *
 * Every scope and name must match {@link NPM_NAME_COMPONENT_RE}. So
 * `/@x/../express` names no package. It is never read as a package called
 * `../express` that slips past a denylist entry for `express`.
 */
export function parseNpmPackageRequest(path: string): NpmPackageRequest | undefined {
  const segments = decodedNpmSegments(path);
  if (segments === undefined) return undefined;

  const dashIndex = segments.indexOf('-');
  if (dashIndex < 0) {
    const parsed = parseNpmPackagePart(segments.join('/'));
    return parsed && { kind: 'metadata', pkg: { registry: 'npm', ...parsed } };
  }

  // Tarball: <package>/-/<file>, with exactly one segment after the separator.
  if (dashIndex !== segments.length - 2) return undefined;
  const parsed = parseNpmPackagePart(segments.slice(0, dashIndex).join('/'));
  if (!parsed) return undefined;
  const version = extractVersionFromNpmTarball(segments[dashIndex + 1], parsed.name);
  if (version === undefined) return undefined;
  return { kind: 'tarball', pkg: { registry: 'npm', ...parsed, version } };
}

/**
 * Parses an npm registry URL path into a PackageIdentity (see
 * {@link parseNpmPackageRequest}). A tarball identity carries its version.
 * Returns undefined for paths that name no valid package, including
 * tarball-shaped paths whose file name does not parse.
 */
export function parseNpmUrl(path: string): PackageIdentity | undefined {
  return parseNpmPackageRequest(path)?.pkg;
}

/**
 * True when the decoded path has a `-` separator segment after the first
 * segment. That is the npm tarball shape: `/name/-/file` or
 * `/@scope/name/-/file`. Such a path must parse as a tarball or be denied. It
 * is never passed through. Paths under npm's internal `/-/` prefix do not
 * have this shape.
 */
function isNpmTarballShaped(path: string): boolean {
  const segments = decodedNpmSegments(path);
  return segments !== undefined && segments.indexOf('-', 1) > 0;
}

/** Query-stripped, once-decoded path segments; undefined for a malformed or non-origin-form path. */
function decodedNpmSegments(path: string): string[] | undefined {
  const cleanPath = path.split('?')[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    // Malformed percent-encoding (e.g., %E0%A4) -- fail-closed
    return undefined;
  }
  if (!decodedPath.startsWith('/')) return undefined;
  return decodedPath.slice(1).split('/');
}

/**
 * Parses the decoded package part of an npm URL (without the leading /):
 * `name` or `@scope/name`, each component checked against
 * {@link NPM_NAME_COMPONENT_RE}. Returns { name, scope? } or undefined.
 */
function parseNpmPackagePart(packagePart: string): { name: string; scope?: string } | undefined {
  if (packagePart.startsWith('@')) {
    const slashIdx = packagePart.indexOf('/');
    if (slashIdx < 0) return undefined;
    const scope = packagePart.substring(1, slashIdx);
    // Everything after the first slash must be ONE name component: a second
    // slash (`@x/../express`, `@x/a/b`) is rejected here, not passed on.
    const name = packagePart.substring(slashIdx + 1);
    if (!NPM_NAME_COMPONENT_RE.test(scope) || !NPM_NAME_COMPONENT_RE.test(name)) return undefined;
    return { name, scope };
  }
  // Unscoped: one component. `/name/something` is not a metadata request (the
  // tarball form is split off on its `-` segment before this is called).
  if (!NPM_NAME_COMPONENT_RE.test(packagePart)) return undefined;
  return { name: packagePart };
}

/**
 * Extracts the version from an npm tarball filename.
 * Format: {name}-{version}.tgz, where {name} is the unscoped package name.
 */
function extractVersionFromNpmTarball(filename: string, name: string): string | undefined {
  const prefix = `${name}-`;
  const suffix = '.tgz';
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) return undefined;
  const version = filename.slice(prefix.length, -suffix.length);
  return NPM_TARBALL_VERSION_RE.test(version) ? version : undefined;
}

/**
 * The canonical upstream path for an npm packument: `/name`, or
 * `/@scope%2fname` (the npm CLI's encoding for scoped names). It is built only
 * from a validated identity, never from the client's request path.
 */
export function npmMetadataPath(pkg: PackageIdentity): string {
  return pkg.scope === undefined ? `/${pkg.name}` : `/@${pkg.scope}%2f${pkg.name}`;
}

/**
 * The canonical upstream path for one npm tarball,
 * `/[@scope/]name/-/name-version.tgz`. It is built only from a validated
 * identity.
 */
export function npmTarballPath(pkg: PackageIdentity & { readonly version: string }): string {
  const packagePath = pkg.scope === undefined ? pkg.name : `@${pkg.scope}/${pkg.name}`;
  return `/${packagePath}/-/${pkg.name}-${pkg.version}.tgz`;
}

/**
 * Parses a PyPI Simple Repository URL path into a PackageIdentity.
 * Returns undefined if the path doesn't match.
 *
 * Pattern: GET /simple/{name}/
 */
export function parsePypiSimpleUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  // Match /simple/package-name/ (with or without trailing slash)
  const match = cleanPath.match(/^\/simple\/([a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?)\/?$/);
  if (!match) return undefined;
  return { registry: 'pypi', name: normalizePypiName(match[1]) };
}

/**
 * Parses a PyPI tarball URL path into a PackageIdentity.
 * Returns undefined if the path doesn't match.
 *
 * Tarball URLs on files.pythonhosted.org:
 *   /packages/.../numpy-1.26.0.tar.gz
 *   /packages/.../numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl
 */
export function parsePypiTarballUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  const filename = cleanPath.split('/').pop();
  if (!filename) return undefined;

  return extractPypiPackageFromFilename(filename);
}

/**
 * Extracts package name and version from a PyPI distribution filename.
 *
 * Handles both sdist and wheel formats:
 *   numpy-1.26.0.tar.gz -> { name: 'numpy', version: '1.26.0' }
 *   numpy-1.26.0-cp312-*.whl -> { name: 'numpy', version: '1.26.0' }
 */
export function extractPypiPackageFromFilename(filename: string): PackageIdentity | undefined {
  // Strip known sidecar suffixes (e.g. .whl.metadata -> .whl) before parsing
  const baseFilename = stripPypiSidecarSuffix(filename);

  // Wheel format: {name}-{version}(-{tags}).whl
  // Sdist format: {name}-{version}.tar.gz or {name}-{version}.zip
  // The name-version boundary is the first hyphen followed by a digit
  const match = baseFilename.match(
    /^([a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?)-(\d[^-]*?)(?:\.tar\.gz|\.zip|-[a-zA-Z].*\.whl)$/,
  );
  if (!match) return undefined;

  return {
    registry: 'pypi',
    name: normalizePypiName(match[1]),
    version: match[2],
  };
}

/**
 * Normalizes a PyPI package name to lowercase with hyphens.
 * PEP 503: package names are case-insensitive and treat
 * hyphens, underscores, and dots as equivalent.
 */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** The PyPI JSON API document of one project: `/pypi/<name>/json`. */
export function pypiJsonApiPath(name: string): string {
  return `/pypi/${name}/json`;
}

/** A redirected PyPI JSON API path: `/pypi/<project name in any spelling>/json`. */
const PYPI_JSON_API_PATH_RE = /^\/pypi\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/json$/;

/** Redirect statuses a PyPI JSON API read may follow (see {@link pypiJsonApiRedirectPath}). */
const PYPI_JSON_API_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308]);

/**
 * The path a PyPI JSON API read of `/pypi/<name>/json` on `host` may follow a
 * `status` answer's `location` to, or undefined to refuse the redirect.
 * Warehouse answers a project name spelled other than the project's display
 * name with a redirect to it (`/pypi/django/json` to `/pypi/Django/json`,
 * `/pypi/typing-extensions/json` to `/pypi/typing_extensions/json`), so the
 * normalized name the proxies look up never reads its upload times without
 * one. The redirect admitted is a 301, 302, 307 or 308 whose location
 * resolves (against the requested document) to `https://<host>/pypi/<X>/json`
 * on the same host, with no credentials, port, query or fragment, where `X`
 * names the same project ({@link normalizePypiName}`(X) === name`). Anything
 * else is refused, and the caller follows at most one.
 */
export function pypiJsonApiRedirectPath(
  status: number,
  location: string,
  host: string,
  name: string,
): string | undefined {
  if (!PYPI_JSON_API_REDIRECT_STATUSES.has(status)) return undefined;
  let target: URL;
  try {
    target = new URL(location, `https://${host}${pypiJsonApiPath(name)}`);
  } catch {
    return undefined;
  }
  if (
    target.protocol !== 'https:' ||
    target.host !== host ||
    target.username !== '' ||
    target.password !== '' ||
    target.search !== '' ||
    target.hash !== ''
  ) {
    return undefined;
  }
  const match = PYPI_JSON_API_PATH_RE.exec(target.pathname);
  return match !== null && normalizePypiName(match[1]) === name ? target.pathname : undefined;
}

// ── Debian URL parsing ──────────────────────────────────────────────

/**
 * Debian binary package name (Debian Policy 5.6.1): lowercase letters, digits,
 * `+`, `-` and `.`, at least two characters, starting with a letter or digit.
 */
const DEBIAN_NAME_RE = /^[a-z0-9][a-z0-9+.-]+$/;

/**
 * Debian version (Debian Policy 5.6.12): an optional numeric epoch, then
 * letters, digits, `.`, `+`, `~` and `-`. Pool file names normally omit the
 * epoch. When present, apt encodes the colon as `%3a`.
 */
const DEBIAN_VERSION_RE = /^(?:[0-9]+:)?[A-Za-z0-9][A-Za-z0-9.+~-]*$/;

/** Debian architecture name (`amd64`, `arm64`, `all`, `kfreebsd-amd64`, ...). */
const DEBIAN_ARCH_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Percent-decodes one Debian URL path segment exactly once. Returns undefined
 * when the encoding is malformed, or when the decoded name still contains `%`
 * (double encoding), `/`, `\` or a control character.
 *
 * apt quotes `+`, `~` and space across the whole request URI, so a request for
 * `g++-12` arrives as `g%2b%2b-12_...deb`. Decoding before validation is what
 * lets a `g++-12` denylist entry match. It is also what stops
 * `%6Eetcat-traditional_...deb` from passing as a different name.
 */
function decodeDebianFilename(rawFilename: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawFilename);
  } catch {
    return undefined;
  }
  if (decoded.includes('%') || decoded.includes('/') || decoded.includes('\\')) return undefined;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return decoded;
}

/**
 * Parses a decoded `{name}_{version}_{arch}.deb` file name. The name, version
 * and arch must each match their Debian grammar.
 */
function parseDebianFilename(filename: string): PackageIdentity | undefined {
  if (!filename.endsWith('.deb')) return undefined;
  const parts = filename.slice(0, -'.deb'.length).split('_');
  if (parts.length !== 3) return undefined;
  const [name, version, arch] = parts;
  if (!DEBIAN_NAME_RE.test(name) || !DEBIAN_VERSION_RE.test(version) || !DEBIAN_ARCH_RE.test(arch)) {
    return undefined;
  }
  return { registry: 'debian', name, version };
}

/**
 * Extracts package name and version from a Debian `.deb` filename as it
 * appears in a request path (still percent-encoded).
 *
 * The whole file name is decoded once (see {@link decodeDebianFilename}). The
 * `.deb` suffix, name, version and arch are then read from the decoded text.
 *
 * Format: {name}_{version}_{arch}.deb
 * Examples:
 *   libssl3_3.0.11-1~deb12u2_arm64.deb   -> name='libssl3', version='3.0.11-1~deb12u2'
 *   gcc-14-base_14.2.0-19_arm64.deb      -> name='gcc-14-base', version='14.2.0-19'
 *   g%2b%2b-12_12.2.0-14_amd64.deb       -> name='g++-12', version='12.2.0-14'
 *   tar_1%3a1.35-2_arm64.deb             -> name='tar', version='1:1.35-2'
 */
export function extractDebianPackageFromFilename(filename: string): PackageIdentity | undefined {
  const decoded = decodeDebianFilename(filename);
  return decoded === undefined ? undefined : parseDebianFilename(decoded);
}

/**
 * Parses a Debian repository URL path into a PackageIdentity.
 * Returns undefined unless the last path segment, decoded once, is a
 * well-formed `.deb` file name.
 *
 * Matches a `.deb` at any location, not only under `/pool/`, because mirrors
 * and security repositories may use different layouts. What happens to every
 * other path is decided by {@link classifyDebianRequestPath}.
 */
export function parseDebianPackageUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];
  return extractDebianPackageFromFilename(cleanPath.slice(cleanPath.lastIndexOf('/') + 1));
}

/** How the standard registry proxy treats one Debian request path. */
export type DebianRequestRoute =
  | { readonly kind: 'artifact'; readonly pkg: PackageIdentity }
  | { readonly kind: 'metadata' }
  | { readonly kind: 'refused'; readonly reason: string };

/** Characters allowed in each segment of a Debian repository metadata path. */
const DEBIAN_METADATA_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const DEBIAN_RELEASE_FILE_RE = /^(?:InRelease|Release|Release\.gpg)$/;
/**
 * apt index targets: Packages, Sources and Translation-*, plus the optional
 * Contents-* (apt-file), Commands-* (command-not-found) and Components-*.yml /
 * icons-*.tar (AppStream). Each may carry a compression suffix.
 */
const DEBIAN_INDEX_FILE_RE =
  /^(?:Packages|Sources|Translation-[A-Za-z0-9_@.-]+|Contents-[A-Za-z0-9.-]+|Commands-[A-Za-z0-9.-]+|Components-[A-Za-z0-9.-]+\.yml|icons-[0-9]+x[0-9]+(?:@[0-9]+)?\.tar)(?:\.(?:gz|xz|bz2|lzma|lz4|zst))?$/;
const DEBIAN_BY_HASH_ALGORITHMS: ReadonlySet<string> = new Set(['MD5Sum', 'SHA1', 'SHA256', 'SHA512']);
const DEBIAN_BY_HASH_DIGEST_RE = /^[a-f0-9]{32,128}$/;

/**
 * True for a signed Debian repository metadata path under `dists/`:
 * `.../dists/<suite>/[...]/<file>`, where `<file>` is a Release file, an apt
 * index target, or a `by-hash/<algorithm>/<digest>` entry. The path must have
 * no `pool` segment and no percent-encoding, and each segment must match
 * {@link DEBIAN_METADATA_SEGMENT_RE}. apt verifies all of these files against
 * the archive signing key.
 */
function isDebianMetadataPath(cleanPath: string): boolean {
  if (cleanPath.includes('%')) return false;
  const segments = cleanPath.slice(1).split('/');
  if (segments.includes('pool') || !segments.every((segment) => DEBIAN_METADATA_SEGMENT_RE.test(segment))) {
    return false;
  }
  const distsIndex = segments.indexOf('dists');
  // At least dists/<suite>/<file>.
  if (distsIndex < 0 || segments.length - distsIndex < 3) return false;

  const file = segments[segments.length - 1];
  if (DEBIAN_RELEASE_FILE_RE.test(file) || DEBIAN_INDEX_FILE_RE.test(file)) return true;
  // by-hash lives below the suite: dists/<suite>/[...]/by-hash/<algorithm>/<digest>.
  return (
    segments.length - distsIndex >= 5 &&
    segments[segments.length - 3] === 'by-hash' &&
    DEBIAN_BY_HASH_ALGORITHMS.has(segments[segments.length - 2]) &&
    DEBIAN_BY_HASH_DIGEST_RE.test(file)
  );
}

/**
 * Classifies a Debian request path. The last segment is decoded once first.
 *
 * - `artifact`: the decoded file name ends in `.deb` and parses. The caller
 *   validates the package (denylist/allowlist) before forwarding.
 * - `metadata`: an allowlisted `dists/` path (see {@link isDebianMetadataPath}),
 *   forwarded as-is.
 * - `refused`: anything else. That includes a `.deb` name that does not parse,
 *   any other file under `pool/` (`.udeb`, `.dsc`, source tarballs, directory
 *   listings), malformed or double encoding, and every path outside `dists/`
 *   and `pool/`.
 */
export function classifyDebianRequestPath(path: string): DebianRequestRoute {
  const cleanPath = path.split('?')[0];
  const filename = decodeDebianFilename(cleanPath.slice(cleanPath.lastIndexOf('/') + 1));
  if (filename === undefined) {
    return { kind: 'refused', reason: 'Debian file name is malformed or double percent-encoded' };
  }
  if (filename.endsWith('.deb')) {
    const pkg = parseDebianFilename(filename);
    return pkg === undefined
      ? { kind: 'refused', reason: 'unable to identify Debian package from URL' }
      : { kind: 'artifact', pkg };
  }
  if (isDebianMetadataPath(cleanPath)) return { kind: 'metadata' };
  return { kind: 'refused', reason: 'not a Debian package or repository metadata path' };
}

// ── Cargo / crates.io URL parsing ───────────────────────────────────

/**
 * Normalizes a crate name for index lookup and cache keying.
 * crates.io treats names case-insensitively; the sparse index path
 * is always lowercase.
 */
export function normalizeCargoName(name: string): string {
  return name.toLowerCase();
}

/**
 * Computes the sparse-index path for a crate name (without leading /).
 *
 * Per the Cargo registry protocol:
 *   1 char  -> 1/{name}
 *   2 chars -> 2/{name}
 *   3 chars -> 3/{first}/{name}
 *   4+      -> {first-two}/{next-two}/{name}
 */
export function cargoSparseIndexPath(name: string): string {
  const lower = normalizeCargoName(name);
  switch (lower.length) {
    case 0:
      return lower;
    case 1:
      return `1/${lower}`;
    case 2:
      return `2/${lower}`;
    case 3:
      return `3/${lower[0]}/${lower}`;
    default:
      return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
  }
}

/** Valid crate name characters: ASCII alphanumerics, `-`, `_`. */
const CARGO_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parses a crates.io sparse-index URL path into a PackageIdentity.
 * Returns undefined for /config.json and paths that don't conform to
 * the sparse-index prefix layout.
 */
export function parseCargoSparseIndexUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0].replace(/^\/+/, '');
  if (cleanPath === 'config.json' || cleanPath === '') return undefined;

  const segments = cleanPath.split('/');
  const name = segments[segments.length - 1];
  if (!name || !CARGO_NAME_RE.test(name)) return undefined;

  // Verify the prefix matches the name (reject arbitrary paths).
  if (cargoSparseIndexPath(name) !== cleanPath.toLowerCase()) return undefined;

  return { registry: 'cargo', name: normalizeCargoName(name) };
}

/**
 * Parses a crates.io download URL into a PackageIdentity.
 *
 * Patterns (across crates.io and static.crates.io):
 *   /api/v1/crates/{name}/{version}/download
 *   /crates/{name}/{version}/download
 *   /crates/{name}/{name}-{version}.crate
 */
export function parseCargoDownloadUrl(path: string): PackageIdentity | undefined {
  const cleanPath = path.split('?')[0];

  // /api/v1/crates/{name}/{version}/download  or  /crates/{name}/{version}/download
  const dlMatch = cleanPath.match(/^(?:\/api\/v1)?\/crates\/([A-Za-z0-9_-]+)\/([^/]+)\/download$/);
  if (dlMatch) {
    return { registry: 'cargo', name: normalizeCargoName(dlMatch[1]), version: dlMatch[2] };
  }

  // /crates/{name}/{name}-{version}.crate
  const crateMatch = cleanPath.match(/^\/crates\/([A-Za-z0-9_-]+)\/([^/]+)\.crate$/);
  if (crateMatch) {
    const name = crateMatch[1];
    const filename = crateMatch[2];
    const prefix = `${name}-`;
    // crates.io treats crate names case-insensitively; cargo emits the
    // canonical case but compare case-insensitively so a mixed-case dir vs
    // filename (e.g. /crates/Inflector/inflector-0.11.4.crate) still parses
    // rather than being denied.
    if (!filename.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
    const version = filename.slice(prefix.length);
    if (!version) return undefined;
    return { registry: 'cargo', name: normalizeCargoName(name), version };
  }

  return undefined;
}

/** One line of the crates.io sparse index (newline-delimited JSON). */
interface CargoIndexLine {
  readonly name: string;
  readonly vers: string;
  readonly yanked?: boolean;
  /** Publish timestamp (RFC 3339), backfilled across all versions. */
  readonly pubtime?: string;
  readonly [key: string]: unknown;
}

/**
 * Filters a crates.io sparse-index file (newline-delimited JSON) to
 * remove disallowed versions. Each line is a self-contained JSON object
 * carrying its own `pubtime`, so no side-channel timestamp fetch is
 * needed (unlike PyPI).
 */
export function filterCargoSparseIndex(
  ndjson: string,
  validator: PackageValidator,
  packageName: string,
): { filtered: string; denied: Array<{ version: string; reason: string }>; allowedVersions: Set<string> } {
  const denied: Array<{ version: string; reason: string }> = [];
  const allowedVersions = new Set<string>();
  const kept: string[] = [];

  for (const rawLine of ndjson.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: CargoIndexLine;
    try {
      entry = JSON.parse(line) as CargoIndexLine;
    } catch {
      // Unparseable line — drop it (fail-closed).
      continue;
    }
    if (!entry.vers) continue;

    const rawDate = entry.pubtime ? new Date(entry.pubtime) : undefined;
    const publishedAt = rawDate && Number.isFinite(rawDate.getTime()) ? rawDate : undefined;

    const decision = validator.validate(
      { registry: 'cargo', name: packageName, version: entry.vers },
      publishedAt !== undefined ? { publishedAt } : undefined,
    );

    if (decision.status === 'allow') {
      allowedVersions.add(entry.vers);
      kept.push(line);
    } else {
      denied.push({ version: entry.vers, reason: decision.reason });
    }
  }

  // Trailing newline keeps cargo's NDJSON parser happy on an empty result.
  return { filtered: kept.join('\n') + '\n', denied, allowedVersions };
}

// ── Request classification ──────────────────────────────────────────

/** Returns true if the URL path is an npm metadata request for a valid package name. */
export function isNpmMetadataRequest(path: string): boolean {
  return parseNpmPackageRequest(path)?.kind === 'metadata';
}

/** Returns true if the URL path is a well-formed npm tarball download. */
export function isNpmTarballRequest(path: string): boolean {
  return parseNpmPackageRequest(path)?.kind === 'tarball';
}

/** Returns true if the URL path is a PyPI Simple Repository request. */
export function isPypiSimpleRequest(path: string): boolean {
  return parsePypiSimpleUrl(path) !== undefined;
}

// ── Route allowlist ─────────────────────────────────────────────────

/**
 * What the standard registry proxy does with one GET or HEAD request. Each
 * registry has an explicit allowlist of routes. A request that matches none
 * of them is refused; nothing is forwarded just because it is unrecognised.
 */
export type RegistryRoute =
  /** An npm packument: fetched at its canonical path, filtered and cached. */
  | { readonly kind: 'npm-metadata'; readonly pkg: PackageIdentity }
  /** A PyPI Simple Repository page: fetched, filtered and cached. */
  | { readonly kind: 'pypi-simple'; readonly pkg: PackageIdentity }
  /** One crate's sparse-index file: fetched, filtered and cached. */
  | { readonly kind: 'cargo-index'; readonly pkg: PackageIdentity }
  /**
   * An npm, PyPI or crates.io artifact download. The tarball backstop parses
   * the package from the path and forwards it only if that version is allowed.
   */
  | { readonly kind: 'artifact' }
  /** A Debian `.deb`, already parsed: validated, then forwarded. */
  | { readonly kind: 'debian-package'; readonly pkg: PackageIdentity }
  /**
   * A read-only endpoint that names no package, such as npm search or Debian
   * `dists/` metadata. It is forwarded without credentials and audited.
   */
  | { readonly kind: 'read-only'; readonly endpoint: string }
  /** No route: refused with 403. `reason` is fixed text, never derived from the request. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Routes a GET or HEAD request by registry host and path. `path` must already
 * have passed {@link checkRegistryRequestPath}, so it has one unambiguous
 * reading and the literal comparisons below are exact.
 *
 * The allowlist, per host:
 * - registry.npmjs.org: package metadata and tarballs, plus the read-only
 *   `/-/ping`, `/-/v1/search` and `/-/package/<name>/dist-tags` (npm ping,
 *   npm search, npm dist-tag ls). Everything else is refused, including the
 *   registry root, `/-/npm/v1/...` (audit, login, tokens, profile) and
 *   `/<name>/-rev/<rev>`.
 * - pypi.org: `/simple/<name>/`, and the JSON API (`/pypi/<name>/json`,
 *   `/pypi/<name>/<version>/json`) that Poetry and pip-audit read.
 * - files.pythonhosted.org: distribution files under `/packages/`.
 * - deb.debian.org, security.debian.org: `.deb` packages and allowlisted
 *   `dists/` metadata (see {@link classifyDebianRequestPath}).
 * - index.crates.io: sparse-index files and `/config.json`.
 * - static.crates.io: crate downloads under `/crates/`.
 * - crates.io: the legacy `/api/v1/crates/<name>/<version>/download`
 *   redirect and `cargo search` (`/api/v1/crates?q=...`). Publish, yank,
 *   owners and every other API path are refused.
 *
 * Methods and bodies are not considered here: a write never gets this far
 * (see `checkRegistryRequestMethodAndBody`).
 */
export function classifyRegistryRoute(registry: RegistryConfig, host: string, path: string): RegistryRoute {
  if (host !== registry.host && registry.mirrorHosts?.includes(host) !== true) {
    return refusedRoute('host is not served by this registry');
  }
  const cleanPath = path.split('?')[0];
  switch (registry.type) {
    case 'npm':
      return classifyNpmRoute(path, cleanPath);
    case 'pypi':
      return host === registry.host ? classifyPypiIndexRoute(path, cleanPath) : classifyPypiFilesRoute(cleanPath);
    case 'debian':
      return classifyDebianRoute(path);
    case 'cargo':
      return classifyCargoRoute(host, path, cleanPath);
    default: {
      const _exhaustive: never = registry.type;
      throw new Error(`Unknown registry type: ${String(_exhaustive)}`);
    }
  }
}

function refusedRoute(reason: string): RegistryRoute {
  return { kind: 'refused', reason };
}

function classifyNpmRoute(path: string, cleanPath: string): RegistryRoute {
  const request = parseNpmPackageRequest(path);
  if (request?.kind === 'metadata') return { kind: 'npm-metadata', pkg: request.pkg };
  // A `-` segment after the package name is the tarball shape
  // (/express/-/express-1.0.0.tgz). The backstop denies an unparseable one.
  if (request?.kind === 'tarball' || isNpmTarballShaped(path)) return { kind: 'artifact' };
  const endpoint = npmReadOnlyEndpoint(cleanPath);
  if (endpoint !== undefined) return { kind: 'read-only', endpoint };
  // A package-shaped path that is not a valid package name (/_x, /@x/a/b,
  // /express/, /express/-rev/1-abc) is never forwarded raw: the registry might
  // still resolve it to a real packument, which would reach the client unfiltered.
  return refusedRoute(
    cleanPath.startsWith('/-/') ? 'not an allowlisted read-only npm endpoint' : 'path names no valid npm package',
  );
}

/**
 * npm's read-only endpoints that name no package and that ordinary tooling
 * uses: `npm ping`, `npm search` and `npm dist-tag ls`. The dist-tag list
 * takes the package as one segment (`@scope%2fname`, npm's spelling) or as
 * two (`@scope/name`). Writing a dist-tag is a PUT or DELETE, refused before
 * routing.
 */
function npmReadOnlyEndpoint(cleanPath: string): string | undefined {
  if (cleanPath === '/-/ping') return 'npm ping';
  if (cleanPath === '/-/v1/search') return 'npm search';
  const segments = cleanPath.slice(1).split('/');
  if (
    (segments.length === 4 || segments.length === 5) &&
    segments[0] === '-' &&
    segments[1] === 'package' &&
    segments[segments.length - 1] === 'dist-tags'
  ) {
    const packagePart = decodeOnce(segments.slice(2, -1).join('/'));
    if (packagePart !== undefined && parseNpmPackagePart(packagePart) !== undefined) return 'npm dist-tag ls';
  }
  return undefined;
}

function decodeOnce(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * PyPI's JSON API: `/pypi/<name>/json` and `/pypi/<name>/<version>/json`. The
 * name follows PEP 508 and the version uses PEP 440's characters. Neither may
 * contain `%`, so the path names exactly one project.
 */
const PYPI_JSON_API_RE =
  /^\/pypi\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9.!+_-]*)?\/json$/;

/** pypi.org: the Simple Repository and the JSON API. */
function classifyPypiIndexRoute(path: string, cleanPath: string): RegistryRoute {
  const pkg = parsePypiSimpleUrl(path);
  if (pkg !== undefined) return { kind: 'pypi-simple', pkg };
  // The JSON API lists every release unfiltered. A disallowed version found
  // there is still refused by the tarball backstop on files.pythonhosted.org.
  if (PYPI_JSON_API_RE.test(cleanPath)) return { kind: 'read-only', endpoint: 'PyPI JSON API' };
  return refusedRoute('not a PyPI simple index or JSON API path');
}

/** files.pythonhosted.org serves only distribution files, all under `/packages/`. */
function classifyPypiFilesRoute(cleanPath: string): RegistryRoute {
  return cleanPath.startsWith('/packages/') ? { kind: 'artifact' } : refusedRoute('not a PyPI distribution file path');
}

function classifyDebianRoute(path: string): RegistryRoute {
  const route = classifyDebianRequestPath(path);
  switch (route.kind) {
    case 'artifact':
      return { kind: 'debian-package', pkg: route.pkg };
    case 'metadata':
      // Signed repository metadata: apt verifies it against the archive key.
      return { kind: 'read-only', endpoint: 'Debian repository metadata' };
    case 'refused':
      return refusedRoute(route.reason);
  }
}

function classifyCargoRoute(host: string, path: string, cleanPath: string): RegistryRoute {
  switch (host) {
    case CARGO_INDEX_HOST: {
      if (cleanPath === '/config.json') return { kind: 'read-only', endpoint: 'cargo registry config' };
      const pkg = parseCargoSparseIndexUrl(path);
      return pkg === undefined ? refusedRoute('not a crates.io sparse index path') : { kind: 'cargo-index', pkg };
    }
    case CARGO_STATIC_HOST:
      // A pure .crate CDN, like files.pythonhosted.org. The backstop denies
      // any path under /crates/ that is not a crate download.
      return cleanPath.startsWith('/crates/') ? { kind: 'artifact' } : refusedRoute('not a crates.io download path');
    case CARGO_API_HOST:
      if (cleanPath.startsWith('/api/v1/crates/') && parseCargoDownloadUrl(path) !== undefined) {
        return { kind: 'artifact' };
      }
      if (cleanPath === '/api/v1/crates') return { kind: 'read-only', endpoint: 'cargo search' };
      return refusedRoute('not a crates.io download or search path');
    default:
      return refusedRoute('host is not served by this registry');
  }
}

// ── npm Packument types (minimal) ───────────────────────────────────

/** Minimal npm packument structure for filtering. */
export interface NpmPackument {
  readonly name: string;
  readonly versions: Record<string, unknown>;
  readonly 'dist-tags'?: Record<string, string>;
  readonly time?: Record<string, string>;
  readonly [key: string]: unknown;
}

// ── Metadata filtering ─────────────────────────────────────────────

/** A denied version, or for PyPI a denied distribution file (`file` is its name). */
export interface DeniedArtifact {
  readonly version: string;
  readonly reason: string;
  readonly file?: string;
}

/**
 * Applies the validator to each version in order. A version's `publishedAt`
 * is its `time` entry; one that is missing or not a valid date stays
 * undefined, which the age gate treats as fail-closed.
 */
function decideNpmVersions(
  versions: Iterable<readonly [string, number | undefined]>,
  validator: PackageValidator,
  pkg: PackageIdentity,
): { allowed: Set<string>; denied: DeniedArtifact[] } {
  const allowed = new Set<string>();
  const denied: DeniedArtifact[] = [];
  for (const [version, time] of versions) {
    const publishedAt = time === undefined ? undefined : new Date(time);
    const decision = validator.validate(
      { registry: 'npm', name: pkg.name, scope: pkg.scope, version },
      { publishedAt },
    );
    if (decision.status === 'allow') allowed.add(version);
    else denied.push({ version, reason: decision.reason });
  }
  return { allowed, denied };
}

/** The document a filter serves: slices of the upstream body plus a few rebuilt members. */
export interface FilteredMetadataDocument {
  readonly parts: readonly Buffer[];
  readonly byteLength: number;
}

/** A filtered packument, with what the caches and the audit log need. */
export interface FilteredNpmPackument extends FilteredMetadataDocument {
  readonly allowedVersions: ReadonlySet<string>;
  readonly denied: readonly DeniedArtifact[];
  /** Every version the upstream listed, with its publish time. */
  readonly publishTimes: NpmPublishTimes;
}

/** A byte range of the source document, or literal bytes. */
type OutputPiece = { readonly start: number; readonly end: number } | Buffer;

/** One member of a rebuilt object: a source member (by its position in its object) or literal pieces. */
type OutputMember =
  | { readonly sourceIndex: number; readonly start: number; readonly end: number }
  | { readonly pieces: readonly OutputPiece[] };

const COMMA = Buffer.from(',');

/**
 * Appends `members` separated by commas. Members that were adjacent in the
 * source become one range, separator included, so an object with one denied
 * version is served as three slices rather than one per version.
 */
function appendJoinedMembers(pieces: OutputPiece[], members: readonly OutputMember[]): void {
  let previousSourceIndex: number | undefined;
  for (const [position, member] of members.entries()) {
    if ('sourceIndex' in member) {
      const last = pieces.at(-1);
      if (
        previousSourceIndex !== undefined &&
        member.sourceIndex === previousSourceIndex + 1 &&
        last !== undefined &&
        !Buffer.isBuffer(last)
      ) {
        pieces[pieces.length - 1] = { start: last.start, end: member.end };
      } else {
        if (position > 0) pieces.push(COMMA);
        pieces.push({ start: member.start, end: member.end });
      }
      previousSourceIndex = member.sourceIndex;
    } else {
      if (position > 0) pieces.push(COMMA);
      pieces.push(...member.pieces);
      previousSourceIndex = undefined;
    }
  }
}

/** The kept members of one packument object, rebuilt as `"name":{...}`. */
function rebuiltObject(
  name: string,
  members: readonly NpmPackumentMember[],
  keep: (member: NpmPackumentMember) => boolean,
): OutputMember {
  const pieces: OutputPiece[] = [Buffer.from(`${JSON.stringify(name)}:{`)];
  appendJoinedMembers(
    pieces,
    members.flatMap((member, sourceIndex) =>
      keep(member) ? [{ sourceIndex, start: member.start, end: member.end }] : [],
    ),
  );
  pieces.push(Buffer.from('}'));
  return { pieces };
}

/**
 * The newest allowed version by its kept `time` entry, the way `latest` is
 * recomputed when the upstream's `latest` was denied. With no valid time at
 * all, the first kept entry.
 */
function newestKeptVersion(keptTime: readonly NpmPackumentMember[]): string | undefined {
  let newest: { readonly version: string; readonly time: number } | undefined;
  let first: string | undefined;
  for (const member of keptTime) {
    if (member.name === 'created' || member.name === 'modified') continue;
    first ??= member.name;
    const time = parsePublishTime(member.text);
    if (time !== undefined && (newest === undefined || time > newest.time)) newest = { version: member.name, time };
  }
  return newest?.version ?? first;
}

/**
 * Filters an indexed npm packument (full or abbreviated) without parsing it
 * into objects. The result:
 * - drops disallowed versions from `versions`, and their entries from `time`;
 *   `time` keeps `created`, `modified` and the allowed versions' entries;
 * - keeps the `dist-tags` that point at an allowed version, and recomputes
 *   `latest` as the newest allowed version when its target was dropped;
 * - copies every other member byte for byte.
 */
export function filterNpmPackumentDocument(
  index: NpmPackumentIndex,
  chunks: readonly Buffer[],
  validator: PackageValidator,
  pkg: PackageIdentity,
): FilteredNpmPackument {
  const timeText = new Map<string, string>();
  for (const member of index.time ?? []) {
    if (member.kind === 'string' && member.text !== undefined) timeText.set(member.name, member.text);
  }
  const versionTimes = index.versions.map(
    (member) => [member.name, parsePublishTime(timeText.get(member.name))] as const,
  );
  const { allowed, denied } = decideNpmVersions(versionTimes, validator, pkg);

  const keepTime = (member: NpmPackumentMember): boolean =>
    member.kind === 'string' &&
    member.text !== undefined &&
    member.text !== '' &&
    (member.name === 'created' || member.name === 'modified' || allowed.has(member.name));
  const keptTime = (index.time ?? []).filter(keepTime);

  const distTags = new Map<string, string>();
  for (const member of index.distTags ?? []) {
    if (member.kind === 'string' && member.text !== undefined && allowed.has(member.text)) {
      distTags.set(member.name, member.text);
    }
  }
  if (!distTags.get('latest') && allowed.size > 0) {
    const newest = newestKeptVersion(keptTime);
    if (newest !== undefined) distTags.set('latest', newest);
  }
  const distTagsMember: OutputMember = {
    pieces: [Buffer.from(`"dist-tags":${JSON.stringify(Object.fromEntries(distTags))}`)],
  };

  const rootMembers: OutputMember[] = index.members.map((member, sourceIndex) => {
    switch (member.name) {
      case 'versions':
        return rebuiltObject('versions', index.versions, (version) => allowed.has(version.name));
      case 'time':
        return rebuiltObject('time', index.time ?? [], keepTime);
      case 'dist-tags':
        return distTagsMember;
      default:
        return { sourceIndex, start: member.start, end: member.end };
    }
  });
  // Like the object form ({ ...packument, versions, 'dist-tags', time }), add
  // the members the upstream left out.
  if (index.distTags === undefined) rootMembers.push(distTagsMember);
  if (index.time === undefined) rootMembers.push({ pieces: [Buffer.from('"time":{}')] });

  const pieces: OutputPiece[] = [Buffer.from('{')];
  appendJoinedMembers(pieces, rootMembers);
  pieces.push(Buffer.from('}'));
  return {
    ...resolveOutputPieces(pieces, chunks),
    allowedVersions: allowed,
    denied,
    publishTimes: { versions: new Map(versionTimes) },
  };
}

/** Turns output pieces into buffers: literal pieces as they are, ranges as slices of `chunks` (no copy). */
function resolveOutputPieces(pieces: readonly OutputPiece[], chunks: readonly Buffer[]): FilteredMetadataDocument {
  const sources = chunks.filter((chunk) => chunk.length > 0);
  const starts: number[] = [];
  let total = 0;
  for (const chunk of sources) {
    starts.push(total);
    total += chunk.length;
  }
  const parts: Buffer[] = [];
  let byteLength = 0;
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      parts.push(piece);
      byteLength += piece.length;
      continue;
    }
    if (piece.start < 0 || piece.end > total || piece.start > piece.end) {
      throw new RegistryMetadataError('malformed', 'packument member range is outside the document');
    }
    // The last chunk that starts at or before the range.
    let low = 0;
    let high = sources.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= piece.start) low = middle;
      else high = middle - 1;
    }
    let position = piece.start;
    for (let chunkIndex = low; position < piece.end; chunkIndex += 1) {
      const chunk = sources[chunkIndex];
      const chunkStart = starts[chunkIndex];
      const to = Math.min(chunk.length, piece.end - chunkStart);
      parts.push(chunk.subarray(position - chunkStart, to));
      position = chunkStart + to;
    }
    byteLength += piece.end - piece.start;
  }
  return { parts, byteLength };
}

/**
 * Filters an npm packument object to remove disallowed versions. It applies
 * the same filter the proxy serves ({@link filterNpmPackumentDocument}) to the
 * object's JSON text:
 * - Disallowed versions removed from `versions` and `time`
 * - `dist-tags.latest` updated to point to the newest remaining version
 * - `created` and `modified` timestamps preserved in `time`
 */
export function filterNpmPackument(
  packument: NpmPackument,
  validator: PackageValidator,
  packageName: string,
  scope?: string,
): { filtered: NpmPackument; denied: Array<{ version: string; reason: string }> } {
  const source = Buffer.from(JSON.stringify(packument));
  const indexer = createNpmPackumentIndexer();
  indexer.write(source);
  const result = filterNpmPackumentDocument(indexer.finish(), [source], validator, {
    registry: 'npm',
    name: packageName,
    scope,
  });
  return {
    filtered: JSON.parse(Buffer.concat(result.parts, result.byteLength).toString('utf8')) as NpmPackument,
    denied: result.denied.map(({ version, reason }) => ({ version, reason })),
  };
}

/**
 * Filters a PyPI Simple Repository HTML page, one distribution file at a time.
 *
 * Each `<a>` link names a file. Its version comes from the file name, and its
 * age from that file's own upload time: the href is resolved (against the
 * page's URL) to a `files.pythonhosted.org` path, which is looked up in
 * `fileUploadTimes` (from the JSON API, see `createPypiFileTimesReader`). The
 * path embeds the file's blake2b-256 digest, so the match is exact. A file
 * added to an old release is therefore as new as its own upload, not as old
 * as the release. A link with no matching upload time gets no metadata, so the
 * age gate drops it (fail-closed). Links whose file name names no version are
 * left alone; the backstop refuses their downloads.
 *
 * Returns the filtered HTML, one denied entry per removed file, the versions
 * with at least one kept file, and the kept files' paths (the backstop cache).
 */
export function filterPypiIndex(
  html: string,
  validator: PackageValidator,
  packageName: string,
  fileUploadTimes: ReadonlyMap<string, number | undefined>,
): { filtered: string; denied: DeniedArtifact[]; allowedVersions: Set<string>; allowedFiles: Set<string> } {
  const denied: DeniedArtifact[] = [];
  const allowedVersions = new Set<string>();
  const allowedFiles = new Set<string>();
  const pageUrl = `https://pypi.org/simple/${packageName}/`;

  // Match <a> tags with href attributes pointing to distribution files
  const filtered = html.replace(/<a\s+[^>]*href="[^"]*"[^>]*>[^<]*<\/a>\s*/gi, (match) => {
    const hrefMatch = match.match(/href="([^"]*)"/);
    if (!hrefMatch) return match;

    const href = hrefMatch[1];
    const filename = href.split('/').pop()?.split('#')[0]; // strip fragment
    if (!filename) return match;

    const parsed = extractPypiPackageFromFilename(filename);
    if (!parsed || !parsed.version) return match;

    const fileKey = pypiFileKeyFromUrl(href, pageUrl);
    const uploadedAt = fileKey === undefined ? undefined : fileUploadTimes.get(fileKey);
    const decision = validator.validate(
      { registry: 'pypi', name: packageName, version: parsed.version },
      uploadedAt !== undefined ? { publishedAt: new Date(uploadedAt) } : undefined,
    );

    if (decision.status === 'allow') {
      allowedVersions.add(parsed.version);
      if (fileKey !== undefined) allowedFiles.add(fileKey);
      return match;
    }
    denied.push({ version: parsed.version, file: filename, reason: decision.reason });
    return ''; // Remove the link
  });

  return { filtered, denied, allowedVersions, allowedFiles };
}

// ── AllowedVersionCache helpers ─────────────────────────────────────

/** Cache TTL: 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Packages one proxy's allowed cache holds; the oldest entry is evicted first. */
const MAX_CACHED_PACKAGES = 1024;
/** Versions and file paths one proxy's allowed cache holds, across packages. */
const MAX_CACHED_ARTIFACTS = 250_000;

/** Cache key namespace of PyPI's allowed distribution files (the backstop gates PyPI per file). */
function pypiFileCacheKey(pkg: PackageIdentity): string {
  return `pypi-file:${pkg.name}`;
}

function getCachedEntry(cache: AllowedVersionCache, key: string): ReadonlySet<string> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt.getTime() > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.allowedVersions;
}

/**
 * Stores an entry, then drops expired entries and evicts the oldest until the
 * cache is within its bounds. Eviction is always safe: a miss makes the
 * backstop validate from fresh metadata.
 */
function setCachedEntry(cache: AllowedVersionCache, key: string, artifacts: ReadonlySet<string>): void {
  cache.delete(key);
  if (artifacts.size > MAX_CACHED_ARTIFACTS) return;
  cache.set(key, { allowedVersions: artifacts, cachedAt: new Date() });
  const now = Date.now();
  let total = 0;
  for (const [entryKey, entry] of cache) {
    if (now - entry.cachedAt.getTime() > CACHE_TTL_MS) cache.delete(entryKey);
    else total += entry.allowedVersions.size;
  }
  for (const [oldest, entry] of cache) {
    if (cache.size <= MAX_CACHED_PACKAGES && total <= MAX_CACHED_ARTIFACTS) break;
    cache.delete(oldest);
    total -= entry.allowedVersions.size;
  }
}

/**
 * Gets allowed versions from cache, returning undefined on miss or expiry.
 */
export function getCachedVersions(cache: AllowedVersionCache, pkg: PackageIdentity): ReadonlySet<string> | undefined {
  return getCachedEntry(cache, packageCacheKey(pkg));
}

/**
 * Stores allowed versions in the cache.
 */
export function setCachedVersions(
  cache: AllowedVersionCache,
  pkg: PackageIdentity,
  versions: ReadonlySet<string>,
): void {
  setCachedEntry(cache, packageCacheKey(pkg), versions);
}

/** Gets a PyPI project's allowed distribution-file paths, or undefined on miss or expiry. */
export function getCachedPypiFiles(cache: AllowedVersionCache, pkg: PackageIdentity): ReadonlySet<string> | undefined {
  return getCachedEntry(cache, pypiFileCacheKey(pkg));
}

/** Stores a PyPI project's allowed distribution-file paths (see {@link pypiDistributionFileKey}). */
export function setCachedPypiFiles(cache: AllowedVersionCache, pkg: PackageIdentity, files: ReadonlySet<string>): void {
  setCachedEntry(cache, pypiFileCacheKey(pkg), files);
}

// ── Registry request handler ────────────────────────────────────────

/** Options for the registry request handler. */
export interface RegistryHandlerOptions {
  readonly validator: PackageValidator;
  readonly cache: AllowedVersionCache;
  readonly auditLogPath?: string;
  /** Destination-bound route selected by the owning MITM proxy. */
  readonly outboundTransport?: OutboundTransport;
  /**
   * The proxy's metadata bounds: concurrent operations, buffered bytes,
   * response size and deadlines. Each MITM proxy passes its own; without one,
   * a process-wide default applies, so metadata work is never unbounded.
   */
  readonly metadataBudget?: RegistryMetadataBudget;
  /**
   * npm version-to-publish-time maps for the tarball backstop, one per proxy.
   * Without one nothing is cached across requests.
   */
  readonly publishTimeCache?: NpmPublishTimeCache;
}

let defaultMetadataBudget: RegistryMetadataBudget | undefined;

function metadataBudgetFor(options: RegistryHandlerOptions): RegistryMetadataBudget {
  if (options.metadataBudget !== undefined) return options.metadataBudget;
  defaultMetadataBudget ??= new RegistryMetadataBudget();
  return defaultMetadataBudget;
}

/** What the audit log records about a request. Never a header value. */
interface AuditedRegistryRequest {
  readonly registryType: RegistryType;
  /** The client's method as received; only GET or HEAD gets past the gate. */
  readonly method: string;
  readonly host: string;
  /** The request target exactly as the client sent it. */
  readonly path: string;
  readonly auditLogPath: string | undefined;
}

/**
 * A request that passed the method, body and path gates. Handlers get the
 * client's headers but never its request stream, so no handler can forward a
 * request body.
 */
interface ReadOnlyRegistryRequest extends AuditedRegistryRequest {
  readonly method: ReadOnlyRegistryMethod;
  readonly registry: RegistryConfig;
  readonly port: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly res: http.ServerResponse;
  readonly options: RegistryHandlerOptions;
}

/**
 * Handles an HTTP request routed to a registry host.
 *
 * Every request passes three gates, for all registry types and for both the
 * HTTPS (CONNECT) and the plain-HTTP apt entry points:
 *
 * 1. {@link checkRegistryRequestMethodAndBody}: only a GET or HEAD without a
 *    body. Publishes, dist-tag writes, yanks, logins and npm's audit POSTs
 *    are refused here, before any route is considered.
 * 2. {@link checkRegistryRequestPath}: a path the upstream could read as a
 *    different resource than the parsers below (dot segments, backslashes,
 *    `//`, encoded `.`/`/`/`\`/`%`) is refused.
 * 3. {@link classifyRegistryRoute}: the request must match a route on the
 *    registry's allowlist.
 *
 * A request that fails a gate gets a 403. One that passes goes to metadata
 * filtering, the tarball or `.deb` backstop, or an allowlisted read-only
 * pass-through. Anything sent upstream on the client's behalf carries the
 * client's GET or HEAD, no body, and only the headers that
 * `buildReadOnlyUpstreamHeaders` copies (never a credential). Every request
 * that is forwarded or refused is written to the package audit log with its
 * method, host and path.
 */
export async function handleRegistryRequest(
  registry: RegistryConfig,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
  options: RegistryHandlerOptions,
): Promise<void> {
  const path = clientReq.url ?? '/';
  const audited: AuditedRegistryRequest = {
    registryType: registry.type,
    method: clientReq.method ?? '',
    host,
    path,
    auditLogPath: options.auditLogPath,
  };

  const gate = checkRegistryRequestMethodAndBody(clientReq.method, clientReq.headers);
  if (!gate.ok) {
    refuseRegistryRequest(clientRes, audited, gate.reason, 'request-gate');
    return;
  }
  const pathCheck = checkRegistryRequestPath(registry.type, path);
  if (!pathCheck.ok) {
    refuseRegistryRequest(clientRes, audited, pathCheck.reason, 'request-path');
    return;
  }

  const request: ReadOnlyRegistryRequest = {
    ...audited,
    method: gate.method,
    registry,
    port,
    headers: clientReq.headers,
    res: clientRes,
    options,
  };
  const route = classifyRegistryRoute(registry, host, path);
  switch (route.kind) {
    case 'npm-metadata':
      await handleNpmMetadata(request, route.pkg);
      return;
    case 'pypi-simple':
      await handlePypiSimple(request, route.pkg);
      return;
    case 'cargo-index':
      await handleCargoSparseIndex(request, route.pkg);
      return;
    case 'artifact':
      await handleTarballDownload(request);
      return;
    case 'debian-package':
      await handleDebianPackage(request, route.pkg);
      return;
    case 'read-only':
      auditRegistryDecision(request, {
        decision: 'allow',
        reason: `allowlisted read-only route: ${route.endpoint}`,
        source: 'pass-through',
      });
      await forwardReadOnly(request, path);
      return;
    case 'refused':
      refuseRegistryRequest(clientRes, request, route.reason, 'request-path');
      return;
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unknown registry route: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── Internal handlers ───────────────────────────────────────────────

/** Audit reason: upstream answered with an error or a non-200 status. */
const METADATA_UNAVAILABLE_REASON = 'Upstream metadata unavailable (fetch failed or not found)';
/** Audit reason: the upstream metadata arrived but could not be filtered or served. */
const METADATA_UNPROCESSABLE_REASON = 'Unable to process upstream metadata';

/**
 * Serves a filtered packument for an already-parsed npm metadata request.
 * The upstream fetch uses the canonical path rebuilt from `pkg`
 * ({@link npmMetadataPath}), never the client's request path. So the
 * packument that is filtered and cached is the one for the name the
 * validator checked. The client's path is used only for the audit log.
 *
 * The packument is indexed as it arrives and held, under the proxy's
 * metadata budget, as the chunks it arrived in. The response is those chunks
 * with the denied versions cut out; the document is never parsed into
 * objects or serialized again.
 */
async function handleNpmMetadata(request: ReadOnlyRegistryRequest, pkg: PackageIdentity): Promise<void> {
  const { options } = request;
  let audited = false;
  try {
    await withMetadataOperation(request, async (operation) => {
      const indexer = createNpmPackumentIndexer();
      const chunks = await fetchBufferedMetadata(
        operation,
        metadataTarget(request, npmMetadataPath(pkg), 'application/json'),
        (chunk) => indexer.write(chunk),
      );
      const filtered = filterNpmPackumentDocument(indexer.finish(), chunks, options.validator, pkg);

      setCachedVersions(options.cache, pkg, filtered.allowedVersions);
      options.publishTimeCache?.set(packageCacheKey(pkg), filtered.publishTimes);
      auditMetadataFilter(request, pkg, filtered.denied, filtered.allowedVersions.size, 'version');
      audited = true;
      if (filtered.denied.length > 0) {
        logger.info(
          `[registry-proxy] npm ${canonicalPackageName(pkg)}: filtered ${filtered.denied.length} version(s), ${filtered.allowedVersions.size} allowed`,
        );
      }
      await writeMetadataResponse(operation, request.res, 'application/json', filtered);
    });
  } catch (error) {
    failMetadataRequest(request, pkg, error, audited, 'package metadata');
  }
}

/**
 * Serves a PyPI Simple Repository page with every distribution file that
 * fails validation removed. Each file is gated by its own upload time from
 * the JSON API ({@link filterPypiIndex}), and the files kept are cached for
 * the backstop by path.
 */
async function handlePypiSimple(request: ReadOnlyRegistryRequest, pkg: PackageIdentity): Promise<void> {
  const { options } = request;
  let audited = false;
  try {
    await withMetadataOperation(request, async (operation) => {
      // Read concurrently with the page and never held: only the times are
      // kept. When it cannot be read, no file has a time, so the age gate
      // drops every link (fail-closed).
      const uploadTimes = streamMetadata(
        operation,
        pypiJsonApiTarget(request.host, request.port, pkg.name),
        createPypiFileTimesReader(),
      ).catch((error: unknown): ReadonlyMap<string, number | undefined> => {
        logger.info(`[registry-proxy] PyPI ${pkg.name}: no upload times (${metadataFailureOf(error).reason})`);
        return new Map();
      });
      const html = Buffer.concat(
        await fetchBufferedMetadata(operation, metadataTarget(request, request.path, 'text/html')),
      ).toString();
      const fileUploadTimes = await uploadTimes;
      // After an abort (the client left, or the deadline passed) the times
      // may be missing for that reason alone. Nothing will be served, so no
      // file is denied or cached on their account; the failure is audited.
      if (operation.signal.aborted) throw operation.failure() ?? clientClosedFailure();
      const { filtered, denied, allowedFiles } = filterPypiIndex(html, options.validator, pkg.name, fileUploadTimes);

      setCachedPypiFiles(options.cache, pkg, allowedFiles);
      auditMetadataFilter(request, pkg, denied, allowedFiles.size, 'file');
      audited = true;
      if (denied.length > 0) {
        logger.info(
          `[registry-proxy] PyPI ${pkg.name}: filtered ${denied.length} file(s), ${allowedFiles.size} allowed`,
        );
      }
      await writeMetadataResponse(operation, request.res, 'text/html', singlePartDocument(filtered));
    });
  } catch (error) {
    failMetadataRequest(request, pkg, error, audited, 'package index');
  }
}

/** Idle timeout for an artifact download forwarded upstream. */
const ARTIFACT_TIMEOUT_MS = 60_000;

/**
 * The tarball backstop for npm, PyPI and crates.io artifact downloads. The
 * package and version are parsed from the request path. npm and crates.io
 * artifacts are gated per version; a PyPI file is gated by its own path (see
 * {@link pypiDistributionFileKey}), since files can be added to a release
 * long after it was published. The artifact is forwarded only when it passed
 * validation, from the metadata filter's cache or, on a cache miss, from
 * metadata read as it streams. Every outcome is audited, including a path
 * that names no package.
 */
async function handleTarballDownload(request: ReadOnlyRegistryRequest): Promise<void> {
  const { registry, path, res, options } = request;
  const pkg = parseTarballUrl(registry.type, path);
  if (!pkg || !pkg.version) {
    // Can't parse -- fail-closed
    logger.info(
      `[registry-proxy] tarball backstop: can't parse URL, denying: ${toDisplayText(path, { maxLength: 512 })}`,
    );
    auditRegistryDecision(request, {
      decision: 'deny',
      reason: 'Unable to identify package from URL',
      source: 'tarball-backstop',
    });
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: unable to identify package from URL — ensure the package name and version are correct');
    return;
  }
  const version = pkg.version;
  const name = canonicalPackageName(pkg);
  const upstreamPath = artifactUpstreamPath(registry.type, pkg, version, path);
  const fileKey = registry.type === 'pypi' ? pypiDistributionFileKey(path) : undefined;
  const fileName = fileKey?.slice(fileKey.lastIndexOf('/') + 1);
  const artifact = fileName === undefined ? `${name}@${version}` : `${name} file ${fileName}`;
  const auditedPackage = {
    packageName: pkg.name,
    packageScope: pkg.scope,
    packageVersion: version,
    ...(fileName === undefined ? {} : { packageFile: fileName }),
  };
  const subject = fileKey === undefined ? 'Version' : 'File';

  // Check the allowed cache: versions for npm and crates.io, file paths for PyPI.
  const cached = fileKey === undefined ? getCachedVersions(options.cache, pkg) : getCachedPypiFiles(options.cache, pkg);
  if (cached !== undefined) {
    if (cached.has(fileKey ?? version)) {
      // Allowed -- forward upstream
      auditRegistryDecision(request, {
        ...auditedPackage,
        decision: 'allow',
        reason: `${subject} in allowed cache from metadata filtering`,
        source: 'tarball-backstop',
      });
      await forwardReadOnly(request, upstreamPath, ARTIFACT_TIMEOUT_MS);
      return;
    }
    // In cache but not in allowed set -- was filtered during metadata validation
    logger.info(`[registry-proxy] tarball backstop: denied ${toDisplayText(artifact, { maxLength: 512 })}`);
    auditRegistryDecision(request, {
      ...auditedPackage,
      decision: 'deny',
      reason: `${subject} not in allowed cache (filtered from metadata)`,
      source: 'tarball-backstop',
    });
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(
      `Forbidden: ${artifact} was filtered during metadata validation (may be too new, denylisted, or otherwise disallowed). Try an older version.`,
    );
    return;
  }

  // Cache miss -- need to fetch metadata and validate
  let decision: PackageDecision;
  try {
    decision = await withMetadataOperation(request, (operation) =>
      validateArtifactOnCacheMiss(operation, request, pkg, version, fileKey),
    );
  } catch (error) {
    // Fail-closed
    const failure = metadataFailureOf(error);
    logger.info(
      `[registry-proxy] tarball backstop error for ${toDisplayText(artifact, { maxLength: 512 })}: ${failure.reason}`,
    );
    auditRegistryDecision(request, {
      ...auditedPackage,
      decision: 'deny',
      reason: `Unable to validate package version (${failure.detail})`,
      source: 'tarball-backstop',
    });
    if (res.headersSent || res.destroyed || failure.kind === 'client-closed') {
      res.destroy();
      return;
    }
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(
      `Forbidden: unable to validate package version (${failure.detail}). This is a fail-closed response — retry later or use an allowlisted package.`,
    );
    return;
  }

  if (decision.status === 'allow') {
    auditRegistryDecision(request, {
      ...auditedPackage,
      decision: 'allow',
      reason: `${subject} passed validation on cache miss`,
      source: 'tarball-backstop',
    });
    await forwardReadOnly(request, upstreamPath, ARTIFACT_TIMEOUT_MS);
    return;
  }
  logger.info(
    `[registry-proxy] tarball backstop (cache miss): denied ${toDisplayText(artifact, { maxLength: 512 })}: ${decision.reason}`,
  );
  auditRegistryDecision(request, {
    ...auditedPackage,
    decision: 'deny',
    reason: decision.reason,
    source: 'tarball-backstop',
  });
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end(`Forbidden: ${artifact} — ${decision.reason}. Try a different version.`);
}

/**
 * The upstream path for an artifact that passed validation. An npm tarball is
 * refetched at the canonical path rebuilt from its validated identity
 * ({@link npmTarballPath}). The client's spelling of it (`@scope%2fname`,
 * percent-escapes, a query) is never forwarded. PyPI and cargo artifacts keep
 * the client's path. The request-path gate has already checked it, and their
 * parsers read the package from it without decoding.
 */
function artifactUpstreamPath(registryType: RegistryType, pkg: PackageIdentity, version: string, path: string): string {
  return registryType === 'npm' ? npmTarballPath({ ...pkg, version }) : path;
}

/** Dispatches tarball-URL parsing by registry type. */
function parseTarballUrl(registryType: RegistryType, path: string): PackageIdentity | undefined {
  switch (registryType) {
    case 'npm':
      return parseNpmUrl(path);
    case 'pypi':
      return parsePypiTarballUrl(path);
    case 'cargo':
      return parseCargoDownloadUrl(path);
    case 'debian':
      return parseDebianPackageUrl(path);
  }
}

async function handleCargoSparseIndex(request: ReadOnlyRegistryRequest, pkg: PackageIdentity): Promise<void> {
  const { options } = request;
  let audited = false;
  try {
    await withMetadataOperation(request, async (operation) => {
      const ndjson = Buffer.concat(
        await fetchBufferedMetadata(operation, metadataTarget(request, request.path, 'text/plain')),
      ).toString();
      const { filtered, denied, allowedVersions } = filterCargoSparseIndex(ndjson, options.validator, pkg.name);

      setCachedVersions(options.cache, pkg, allowedVersions);
      auditMetadataFilter(request, pkg, denied, allowedVersions.size, 'version');
      audited = true;
      if (denied.length > 0) {
        logger.info(
          `[registry-proxy] cargo ${pkg.name}: filtered ${denied.length} version(s), ${allowedVersions.size} allowed`,
        );
      }
      await writeMetadataResponse(operation, request.res, 'text/plain', singlePartDocument(filtered));
    });
  } catch (error) {
    // Cargo treats 404/non-200 here as "crate not found" — preserve that.
    failMetadataRequest(request, pkg, error, audited, 'crate index', { status: 404, body: 'Not Found' });
  }
}

/**
 * Validates a Debian `.deb` and forwards it when allowed. Its name and
 * version were taken from the once-decoded file name, so the validator and
 * the audit log see `g++-12`, never `g%2b%2b-12`. apt's own spelling of the
 * path is what is forwarded.
 */
async function handleDebianPackage(request: ReadOnlyRegistryRequest, pkg: PackageIdentity): Promise<void> {
  // Debian packages are distro-curated — bypass quarantine by providing
  // an epoch publish date. Only allow/denylist checks apply.
  const decision = request.options.validator.validate(pkg, { publishedAt: new Date(0) });

  auditRegistryDecision(request, {
    packageName: pkg.name,
    packageVersion: pkg.version,
    decision: decision.status,
    reason: decision.reason,
    source: 'deb-backstop',
  });

  if (decision.status === 'allow') {
    await forwardReadOnly(request, request.path);
  } else {
    logger.info(`[registry-proxy] debian backstop: denied ${pkg.name}_${pkg.version}: ${decision.reason}`);
    request.res.writeHead(403, { 'Content-Type': 'text/plain' });
    request.res.end(`Forbidden: Debian package ${pkg.name} (${pkg.version}) — ${decision.reason}`);
  }
}

/**
 * Validates an artifact whose package is not in the allowed cache, and
 * refills the cache as a side effect. Metadata is fetched from the registry's
 * primary host, whichever host the download came to.
 */
async function validateArtifactOnCacheMiss(
  operation: MetadataOperation,
  request: ReadOnlyRegistryRequest,
  pkg: PackageIdentity,
  version: string,
  fileKey: string | undefined,
): Promise<PackageDecision> {
  const { registry, options } = request;
  switch (registry.type) {
    case 'npm':
      return validateNpmVersionOnCacheMiss(operation, options, registry, pkg, version);
    case 'cargo': {
      // The sparse index carries pubtime per line. Index files are small, so
      // this one is held (under the budget) and filtered like a metadata response.
      const target = {
        host: cargoRegistry.host,
        port: 443,
        path: `/${cargoSparseIndexPath(pkg.name)}`,
        accept: 'text/plain',
      };
      const ndjson = Buffer.concat(await fetchBufferedMetadata(operation, target)).toString();
      const { denied, allowedVersions } = filterCargoSparseIndex(ndjson, options.validator, pkg.name);
      setCachedVersions(options.cache, pkg, allowedVersions);
      if (allowedVersions.has(version)) return { status: 'allow', reason: 'Version passed validation' };
      return {
        status: 'deny',
        reason: denied.find((d) => d.version === version)?.reason ?? 'Version not found in crate index',
      };
    }
    case 'pypi':
      return validatePypiFileOnCacheMiss(operation, options, registry, pkg, fileKey ?? '');
    case 'debian':
      // Debian packages never reach the tarball backstop (see handleDebianPackage).
      return { status: 'deny', reason: 'Debian packages are not validated by the tarball backstop' };
  }
}

/**
 * npm: decides from the cached version-to-time map when it lists `version`;
 * otherwise reads the packument as it streams (it is never held) and caches
 * the map. A version the cached map does not list is always refetched, so a
 * version published after the map was cached is not refused for being unknown.
 */
async function validateNpmVersionOnCacheMiss(
  operation: MetadataOperation,
  options: RegistryHandlerOptions,
  registry: RegistryConfig,
  pkg: PackageIdentity,
  version: string,
): Promise<PackageDecision> {
  const cacheKey = packageCacheKey(pkg);
  let times = options.publishTimeCache?.get(cacheKey);
  if (times === undefined || !times.versions.has(version)) {
    const target = { host: registry.host, port: 443, path: npmMetadataPath(pkg), accept: 'application/json' };
    times = await streamMetadata(operation, target, createNpmPublishTimesReader());
    options.publishTimeCache?.set(cacheKey, times);
  }
  const { allowed, denied } = decideNpmVersions(times.versions, options.validator, pkg);
  setCachedVersions(options.cache, pkg, allowed);
  if (allowed.has(version)) return { status: 'allow', reason: 'Version passed validation' };
  return {
    status: 'deny',
    reason: denied.find((d) => d.version === version)?.reason ?? 'Version not found in package metadata',
  };
}

/**
 * PyPI: reads every file's upload time from the JSON API as it streams,
 * validates each file of the project by its own time, caches the allowed
 * files, and decides the requested file by its exact path. A file the JSON
 * API does not list is refused (fail-closed).
 */
async function validatePypiFileOnCacheMiss(
  operation: MetadataOperation,
  options: RegistryHandlerOptions,
  registry: RegistryConfig,
  pkg: PackageIdentity,
  fileKey: string,
): Promise<PackageDecision> {
  const target = pypiJsonApiTarget(registry.host, 443, pkg.name);
  const uploadTimes = await streamMetadata(operation, target, createPypiFileTimesReader());
  const allowedFiles = new Set<string>();
  let requested: PackageDecision | undefined;
  for (const [file, uploadedAt] of uploadTimes) {
    const parsed = extractPypiPackageFromFilename(file.slice(file.lastIndexOf('/') + 1));
    if (parsed?.version === undefined || parsed.name !== pkg.name) continue;
    const decision = options.validator.validate(
      { registry: 'pypi', name: pkg.name, version: parsed.version },
      uploadedAt === undefined ? undefined : { publishedAt: new Date(uploadedAt) },
    );
    if (decision.status === 'allow') allowedFiles.add(file);
    if (file === fileKey) requested = decision;
  }
  setCachedPypiFiles(options.cache, pkg, allowedFiles);
  if (requested === undefined) return { status: 'deny', reason: 'File not found in package metadata' };
  return requested.status === 'allow' ? { status: 'allow', reason: 'File passed validation' } : requested;
}

// ── Metadata operations ─────────────────────────────────────────────

type MetadataFailureKind =
  'unavailable' | 'unprocessable' | 'too-large' | 'timeout' | 'stalled' | 'busy' | 'client-closed';

/**
 * Why a metadata operation ended without a result. `reason` is fixed text for
 * the audit log; `detail` says the same inside a sentence.
 */
class MetadataFailure extends Error {
  constructor(
    readonly kind: MetadataFailureKind,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(reason);
    this.name = 'MetadataFailure';
  }
}

function formatDuration(milliseconds: number): string {
  return milliseconds % 1000 === 0 ? `${milliseconds / 1000} s` : `${milliseconds} ms`;
}

function unavailableFailure(): MetadataFailure {
  return new MetadataFailure('unavailable', METADATA_UNAVAILABLE_REASON, 'upstream metadata fetch failed');
}

function unprocessableFailure(): MetadataFailure {
  return new MetadataFailure(
    'unprocessable',
    METADATA_UNPROCESSABLE_REASON,
    'upstream metadata could not be processed',
  );
}

function tooLargeFailure(limits: RegistryMetadataLimits): MetadataFailure {
  const ceiling = `${formatByteCeiling(limits.maxResponseBytes)} metadata size ceiling`;
  return new MetadataFailure(
    'too-large',
    `Upstream metadata exceeds the ${ceiling}`,
    `upstream metadata exceeds the ${ceiling}`,
  );
}

function timeoutFailure(limits: RegistryMetadataLimits): MetadataFailure {
  const deadline = `${formatDuration(limits.operationTimeoutMs)} deadline`;
  return new MetadataFailure(
    'timeout',
    `Registry metadata request exceeded its ${deadline}`,
    `the metadata request exceeded its ${deadline}`,
  );
}

function stalledFailure(limits: RegistryMetadataLimits): MetadataFailure {
  const idle = formatDuration(limits.upstreamIdleTimeoutMs);
  return new MetadataFailure(
    'stalled',
    `Upstream metadata stalled for ${idle}`,
    `upstream metadata stalled for ${idle}`,
  );
}

function busyFailure(): MetadataFailure {
  return new MetadataFailure('busy', 'Registry metadata queue is full', 'too many metadata requests are in progress');
}

function clientClosedFailure(): MetadataFailure {
  return new MetadataFailure(
    'client-closed',
    'Client closed the connection before the metadata was served',
    'the client disconnected',
  );
}

/** Any error from a metadata operation as a failure: a {@link MetadataFailure} as is, anything else as unprocessable. */
function metadataFailureOf(error: unknown): MetadataFailure {
  return error instanceof MetadataFailure ? error : unprocessableFailure();
}

/** One metadata operation in progress: its slot, abort signal and bounds. */
interface MetadataOperation {
  readonly signal: AbortSignal;
  readonly permit: RegistryMetadataPermit;
  readonly limits: RegistryMetadataLimits;
  readonly transport: OutboundTransport;
  /** The failure that aborted the operation, once one has. */
  failure(): MetadataFailure | undefined;
}

/** One upstream metadata document. */
interface MetadataTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly accept: string;
  /**
   * The one redirect this document may take: given a non-200 answer's status
   * and `Location`, the same-host path to read instead, or undefined to
   * refuse it. Without it every answer but a 200 fails the read. Only the PyPI
   * JSON API sets it ({@link pypiJsonApiTarget}).
   */
  readonly redirect?: (status: number, location: string) => string | undefined;
}

function metadataTarget(request: ReadOnlyRegistryRequest, path: string, accept: string): MetadataTarget {
  return { host: request.host, port: request.port, path, accept };
}

/**
 * The PyPI JSON API document of `name` (normalized) on `host`, which may
 * follow Warehouse's redirect to the project's display-name spelling
 * ({@link pypiJsonApiRedirectPath}).
 */
function pypiJsonApiTarget(host: string, port: number, name: string): MetadataTarget {
  return {
    host,
    port,
    path: pypiJsonApiPath(name),
    accept: 'application/json',
    redirect: (status, location) => pypiJsonApiRedirectPath(status, location, host, name),
  };
}

/**
 * Runs one metadata operation under the proxy's budget: waits (FIFO) for a
 * slot, then runs `work`. The operation is aborted when its client
 * disconnects or its deadline (queueing included) passes; the abort ends every
 * upstream fetch still open and wins over whatever error it caused. The slot
 * and any reserved bytes are returned on every exit.
 */
async function withMetadataOperation<T>(
  request: ReadOnlyRegistryRequest,
  work: (operation: MetadataOperation) => Promise<T>,
): Promise<T> {
  const budget = metadataBudgetFor(request.options);
  const { limits } = budget;
  const { res } = request;
  const controller = new AbortController();
  let failure: MetadataFailure | undefined;
  const abort = (cause: MetadataFailure): void => {
    if (controller.signal.aborted) return;
    failure = cause;
    controller.abort(cause);
  };
  const onClientClose = (): void => {
    if (!res.writableFinished) abort(clientClosedFailure());
  };
  res.on('close', onClientClose);
  const deadline = setTimeout(() => abort(timeoutFailure(limits)), limits.operationTimeoutMs);
  let permit: RegistryMetadataPermit | undefined;
  try {
    if (res.destroyed) abort(clientClosedFailure());
    try {
      permit = await budget.acquire(controller.signal);
    } catch (error) {
      throw error instanceof RegistryMetadataBudgetError && error.code === 'queue-full' ? busyFailure() : error;
    }
    const operation: MetadataOperation = {
      signal: controller.signal,
      permit,
      limits,
      transport: request.options.outboundTransport ?? DEFAULT_OUTBOUND_TRANSPORT,
      failure: () => failure,
    };
    return await work(operation);
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearTimeout(deadline);
    res.off('close', onClientClose);
    // End any fetch the work left open (a concurrent read it no longer needs).
    if (!controller.signal.aborted) controller.abort();
    permit?.release();
  }
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/**
 * Fetches one metadata document and hands its body to `onChunk` as it
 * arrives; resolves with the body's size. Fails closed with a
 * {@link MetadataFailure} on a non-200 status or a transport error, a body
 * above the response ceiling, an upstream that stalls, or an abort of the
 * operation. With `buffered`, the declared length (or the whole ceiling when
 * the response declares none) is reserved from the budget before the body is
 * read, and the reservation shrinks to the actual size once it is known.
 *
 * A redirect the target admits ({@link MetadataTarget.redirect}) is followed
 * once, under the same operation (its deadline, abort and budget) and with
 * the same limits; the redirect's own body is never read, and the document
 * it leads to may not redirect again.
 */
async function fetchMetadataBody(
  operation: MetadataOperation,
  target: MetadataTarget,
  buffered: boolean,
  onChunk: (chunk: Buffer) => void,
): Promise<number> {
  const first = await fetchMetadataDocument(operation, target, buffered, onChunk);
  if (typeof first === 'number') return first;
  const second = await fetchMetadataDocument(
    operation,
    { ...target, path: first.redirectTo, redirect: undefined },
    buffered,
    onChunk,
  );
  if (typeof second === 'number') return second;
  throw unavailableFailure();
}

/** A metadata answer that redirects to `redirectTo`, a path the target admitted. */
interface MetadataRedirect {
  readonly redirectTo: string;
}

/**
 * One metadata request: resolves with the body's size, or with the redirect
 * the target admits (see {@link fetchMetadataBody}).
 */
function fetchMetadataDocument(
  operation: MetadataOperation,
  target: MetadataTarget,
  buffered: boolean,
  onChunk: (chunk: Buffer) => void,
): Promise<number | MetadataRedirect> {
  const { limits, signal } = operation;
  return new Promise<number | MetadataRedirect>((resolve, reject) => {
    let settled = false;
    let upstreamRequest: http.ClientRequest | undefined;
    let upstreamResponse: http.IncomingMessage | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const stopIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      stopIdleTimer();
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const fail = (failure: MetadataFailure): void => {
      if (!settle()) return;
      upstreamResponse?.destroy();
      upstreamRequest?.destroy();
      reject(failure);
    };
    const armIdleTimer = (): void => {
      stopIdleTimer();
      idleTimer = setTimeout(() => fail(stalledFailure(limits)), limits.upstreamIdleTimeoutMs);
    };
    function onAbort(): void {
      fail(operation.failure() ?? unavailableFailure());
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const consume = async (response: http.IncomingMessage): Promise<number | MetadataRedirect> => {
      armIdleTimer();
      if (response.statusCode !== 200) {
        const redirectTo = admittedRedirect(target, response);
        if (redirectTo === undefined) throw unavailableFailure();
        return { redirectTo };
      }
      const declared = parseContentLength(response.headers['content-length']);
      if (declared !== undefined && declared > limits.maxResponseBytes) throw tooLargeFailure(limits);
      if (buffered) {
        // Waiting for buffer space is not an upstream stall; the operation
        // deadline still applies.
        stopIdleTimer();
        await operation.permit.reserve(declared ?? limits.maxResponseBytes, signal);
        armIdleTimer();
      }
      let bytes = 0;
      for await (const raw of response) {
        armIdleTimer();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        if (bytes > limits.maxResponseBytes) throw tooLargeFailure(limits);
        // The reservation was sized from the declared length.
        if (declared !== undefined && bytes > declared) throw unavailableFailure();
        onChunk(chunk);
      }
      if (buffered) operation.permit.shrink(bytes);
      return bytes;
    };

    try {
      upstreamRequest = operation.transport.request(
        {
          destination: { protocol: 'https:', hostname: target.host, port: target.port },
          path: target.path,
          method: 'GET',
          headers: { accept: target.accept, host: target.host },
        },
        (response) => {
          upstreamResponse = response;
          if (settled) {
            response.destroy();
            return;
          }
          consume(response).then(
            (outcome) => {
              if (!settle()) return;
              // A redirect's body is never read; its exchange ends here.
              if (typeof outcome !== 'number') {
                response.destroy();
                upstreamRequest?.destroy();
              }
              resolve(outcome);
            },
            (error: unknown) => {
              if (error instanceof MetadataFailure) fail(error);
              else if (error instanceof RegistryMetadataError) fail(unprocessableFailure());
              else fail(operation.failure() ?? unavailableFailure());
            },
          );
        },
      );
    } catch {
      fail(unavailableFailure());
      return;
    }
    upstreamRequest.on('error', () => fail(unavailableFailure()));
    armIdleTimer();
    upstreamRequest.end();
  });
}

/** The path of the redirect `response` answers with, when it is one `target` admits. */
function admittedRedirect(target: MetadataTarget, response: http.IncomingMessage): string | undefined {
  const location = response.headers.location;
  if (target.redirect === undefined || typeof location !== 'string') return undefined;
  return target.redirect(response.statusCode ?? 0, location);
}

/**
 * Fetches a metadata document into memory under the operation's byte
 * reservation and returns the chunks it arrived in. `observe` sees each chunk
 * first, so a reader can index the document while it downloads.
 */
async function fetchBufferedMetadata(
  operation: MetadataOperation,
  target: MetadataTarget,
  observe?: (chunk: Buffer) => void,
): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  await fetchMetadataBody(operation, target, true, (chunk) => {
    observe?.(chunk);
    chunks.push(chunk);
  });
  return chunks;
}

/** Reads a metadata document with `reader` as it streams; nothing but the reader's result is kept. */
async function streamMetadata<T>(
  operation: MetadataOperation,
  target: MetadataTarget,
  reader: StreamingMetadataReader<T>,
): Promise<T> {
  await fetchMetadataBody(operation, target, false, (chunk) => reader.write(chunk));
  try {
    return reader.finish();
  } catch (error) {
    throw error instanceof RegistryMetadataError ? unprocessableFailure() : error;
  }
}

function singlePartDocument(text: string): FilteredMetadataDocument {
  const body = Buffer.from(text);
  return { parts: [body], byteLength: body.length };
}

/**
 * Writes a filtered metadata document with backpressure and resolves once it
 * is flushed, so the bytes it references stay reserved until then. A client
 * disconnect or the operation deadline ends the write with a failure.
 */
async function writeMetadataResponse(
  operation: MetadataOperation,
  res: http.ServerResponse,
  contentType: string,
  document: FilteredMetadataDocument,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': document.byteLength });
  for (const part of document.parts) {
    if (operation.signal.aborted) throw operation.failure() ?? clientClosedFailure();
    if (part.length > 0 && !res.write(part)) await waitForResponseEvent(operation, res, 'drain');
  }
  res.end();
  if (!res.writableFinished) await waitForResponseEvent(operation, res, 'finish');
}

function waitForResponseEvent(
  operation: MetadataOperation,
  res: http.ServerResponse,
  event: 'drain' | 'finish',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      res.off(event, onEvent);
      res.off('close', onClose);
      operation.signal.removeEventListener('abort', onAbort);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      if (res.writableFinished) resolve();
      else reject(clientClosedFailure());
    };
    const onAbort = (): void => {
      cleanup();
      reject(operation.failure() ?? clientClosedFailure());
    };
    if (operation.signal.aborted) {
      onAbort();
      return;
    }
    res.once(event, onEvent);
    res.once('close', onClose);
    operation.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** What a client gets for a failed metadata request. */
interface MetadataFailureResponse {
  readonly status: number;
  readonly body: string;
}

function metadataFailureResponse(
  failure: MetadataFailure,
  what: string,
  unavailable: MetadataFailureResponse | undefined,
): MetadataFailureResponse {
  switch (failure.kind) {
    case 'unavailable':
      return unavailable ?? { status: 502, body: `Failed to fetch ${what} from upstream` };
    case 'unprocessable':
      return { status: 502, body: `Failed to process ${what}` };
    case 'too-large':
      return { status: 502, body: `Failed to fetch ${what}: ${failure.detail}` };
    case 'timeout':
    case 'stalled':
      return { status: 504, body: `Failed to fetch ${what}: ${failure.detail}` };
    case 'busy':
    case 'client-closed':
      return { status: 503, body: `Failed to fetch ${what}: ${failure.detail}; retry later` };
  }
}

/**
 * Ends a failed metadata request: logs it, audits it unless the filter
 * result was already audited, and answers the client (or drops a response
 * already under way, or a client already gone).
 */
function failMetadataRequest(
  request: ReadOnlyRegistryRequest,
  pkg: PackageIdentity,
  error: unknown,
  audited: boolean,
  what: string,
  unavailable?: MetadataFailureResponse,
): void {
  const failure = metadataFailureOf(error);
  const cause = error instanceof MetadataFailure || !(error instanceof Error) ? '' : ` (${error.message})`;
  logger.info(
    `[registry-proxy] ${request.registryType} ${what} for ${canonicalPackageName(pkg)} failed: ${failure.reason}${cause}`,
  );
  if (!audited) auditMetadataUnavailable(request, pkg, failure.reason);
  const { res } = request;
  if (res.headersSent || res.destroyed || failure.kind === 'client-closed') {
    res.destroy();
    return;
  }
  const response = metadataFailureResponse(failure, what, unavailable);
  res.writeHead(response.status, { 'Content-Type': 'text/plain' });
  res.end(response.body);
}

// ── Upstream forwarding ─────────────────────────────────────────────

/**
 * Forwards a validated or allowlisted request upstream and pipes the response
 * back to the client. This is the only path by which a client request reaches
 * the registry. The upstream request uses the client's GET or HEAD and
 * `upstreamPath` (rebuilt or checked by the caller). Its headers are only
 * those {@link buildReadOnlyUpstreamHeaders} copies, so no credential is
 * forwarded. It never carries a request body. The response streams through
 * with backpressure, nothing is buffered, and a client that disconnects ends
 * the upstream transfer too. An upstream that fails or goes idle before the
 * response headers were sent gets a 502 or 504; once they were sent, the
 * client response is destroyed, so the client sees an aborted transfer at
 * once instead of waiting on a truncated body.
 */
async function forwardReadOnly(
  request: ReadOnlyRegistryRequest,
  upstreamPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const { res, host, port } = request;
  const outboundTransport = request.options.outboundTransport ?? DEFAULT_OUTBOUND_TRANSPORT;
  // A client that is already gone would never see the response, and its
  // 'close' has already fired, so nothing below would end the transfer.
  if (res.destroyed) return;

  return new Promise((resolve) => {
    let upstreamRes: http.IncomingMessage | undefined;
    let upstreamReq: http.ClientRequest | undefined;
    const finish = (): void => {
      res.off('close', onClientClose);
      resolve();
    };
    function onClientClose(): void {
      if (res.writableFinished) return;
      upstreamRes?.destroy();
      upstreamReq?.destroy();
      finish();
    }
    /** Ends the client response for an upstream failure (see above), then settles. */
    const failUpstream = (status: 502 | 504, message: string): void => {
      if (!res.headersSent) {
        res.writeHead(status);
        res.end(message);
      } else if (!res.writableEnded) {
        res.destroy();
      }
      finish();
    };
    try {
      upstreamReq = outboundTransport.request(
        {
          destination: { protocol: 'https:', hostname: host, port },
          method: request.method,
          path: upstreamPath,
          headers: buildReadOnlyUpstreamHeaders(request.headers, host),
        },
        guardUpstreamResponse(
          res,
          (response) => {
            upstreamRes = response;
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
            response.on('end', finish);
            response.on('error', () => failUpstream(502, 'Upstream error'));
          },
          finish,
        ),
      );
    } catch {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Upstream connection error');
      }
      resolve();
      return;
    }
    const upstream = upstreamReq;
    res.on('close', onClientClose);
    upstream.on('error', () => failUpstream(502, 'Upstream connection error'));
    upstream.setTimeout(timeoutMs, () => {
      upstream.destroy();
      failUpstream(504, 'Upstream timeout');
    });
    upstream.end();
  });
}

// ── Audit logging ───────────────────────────────────────────────────

/** The fields of an audit entry that describe the decision rather than the request. */
type AuditDecision = Omit<PackageAuditEntry, 'timestamp' | 'registry' | 'method' | 'host' | 'requestPath'>;

/** Writes one package audit entry: the request's method, host and path, and the decision. */
function auditRegistryDecision(request: AuditedRegistryRequest, decision: AuditDecision): void {
  writeAuditEntry(request.auditLogPath, {
    timestamp: new Date().toISOString(),
    registry: request.registryType,
    method: request.method,
    host: request.host,
    ...decision,
    requestPath: request.path,
  });
}

/**
 * Audits a metadata-filter result: one deny entry for each removed version
 * (for PyPI, each removed distribution file, named in `packageFile`), and one
 * allow entry summarising what was kept. Metadata that lists nothing
 * installable still gets an entry, so every metadata request is on record.
 */
function auditMetadataFilter(
  request: AuditedRegistryRequest,
  pkg: PackageIdentity,
  denied: readonly DeniedArtifact[],
  allowedCount: number,
  unit: 'version' | 'file',
): void {
  for (const d of denied) {
    auditRegistryDecision(request, {
      packageName: pkg.name,
      packageScope: pkg.scope,
      packageVersion: d.version,
      ...(d.file === undefined ? {} : { packageFile: d.file }),
      decision: 'deny',
      reason: d.reason,
      source: 'metadata-filter',
    });
  }
  if (allowedCount > 0) {
    auditRegistryDecision(request, {
      packageName: pkg.name,
      packageScope: pkg.scope,
      packageVersion: `${allowedCount} ${unit}(s)`,
      decision: 'allow',
      reason: 'Passed all validation checks',
      source: 'metadata-filter',
    });
  } else if (denied.length === 0) {
    auditMetadataUnavailable(request, pkg, 'Upstream metadata lists no installable version');
  }
}

/**
 * Audits a metadata request that served no installable version: the upstream
 * fetch failed or could not be processed (the client gets an error), or the
 * metadata lists no version. The request was still sent upstream, so it is
 * recorded like any other forwarded request. `reason` must be fixed text.
 */
function auditMetadataUnavailable(request: AuditedRegistryRequest, pkg: PackageIdentity, reason: string): void {
  auditRegistryDecision(request, {
    packageName: pkg.name,
    packageScope: pkg.scope,
    decision: 'deny',
    reason,
    source: 'metadata-filter',
  });
}

/**
 * Refuses a request before any package identity is established: it is not a
 * bodiless GET or HEAD (`request-gate`), or its path is not canonical or
 * matches no allowlisted route (`request-path`). Writes a 403, an audit
 * entry, and a log line (method and path rendered with control characters
 * escaped). `reason` must be fixed text, never derived from the request.
 */
function refuseRegistryRequest(
  res: http.ServerResponse,
  request: AuditedRegistryRequest,
  reason: string,
  source: 'request-gate' | 'request-path',
): void {
  logger.info(
    `[registry-proxy] refused ${toDisplayText(request.method, { maxLength: 32 })} ${request.registryType} request to ${request.host} (${reason}): ${toDisplayText(request.path, { maxLength: 512 })}`,
  );
  auditRegistryDecision(request, { decision: 'deny', reason, source });
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end(`Forbidden: ${reason}`);
}

/**
 * Writes a package audit entry to the JSONL audit log.
 * Fire-and-forget: callers should not await the returned promise.
 */
function writeAuditEntry(auditLogPath: string | undefined, entry: PackageAuditEntry): void {
  if (!auditLogPath) return;
  fs.appendFile(auditLogPath, JSON.stringify(entry) + '\n').catch((err: unknown) => {
    logger.warn(`[registry-proxy] Failed to write audit entry: ${err instanceof Error ? err.message : String(err)}`);
  });
}
