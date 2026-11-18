/**
 * Type definitions for the secure package installation proxy.
 *
 * These types are shared across the package validator, registry proxy,
 * and MITM proxy integration layers.
 */

/**
 * Supported package registry types.
 * Each type determines how package names and versions are extracted
 * from HTTP request paths, and how metadata responses are filtered.
 */
export type RegistryType = 'npm' | 'pypi' | 'debian' | 'cargo';

/**
 * Configuration for a package registry host.
 *
 * Unlike ProviderConfig (which handles credential swap and endpoint
 * filtering for LLM APIs), RegistryConfig handles package-level
 * validation for software registries.
 *
 * No key injection is needed -- package registries are public. The
 * registry proxy also strips every credential the client sends.
 */
export interface RegistryConfig {
  /** Registry hostname (e.g., 'registry.npmjs.org'). */
  readonly host: string;

  /** Human-readable name for logging. */
  readonly displayName: string;

  /** Registry type, determines URL parsing and metadata filtering strategy. */
  readonly type: RegistryType;

  /**
   * Additional hosts that serve package tarballs for this registry.
   * For PyPI, this includes 'files.pythonhosted.org'.
   * These hosts are added to the MITM proxy's allowlist and their
   * requests are validated using the same rules as the main host.
   */
  readonly mirrorHosts?: readonly string[];
}

/**
 * Parsed package identity extracted from a registry HTTP request.
 *
 * Invariant: scope is only present for npm scoped packages
 * (e.g., @types/node). PyPI packages never have a scope.
 */
export interface PackageIdentity {
  /** Registry type this package belongs to. */
  readonly registry: RegistryType;
  /** Package name (e.g., 'express', 'numpy'). */
  readonly name: string;
  /** npm scope without @, if scoped (e.g., 'types' for @types/node). */
  readonly scope?: string;
  /** Package version, if parseable from the URL or metadata. */
  readonly version?: string;
}

/**
 * Result of a package validation check.
 * Binary: allow or deny. No escalation.
 */
export type PackageDecision =
  { readonly status: 'allow'; readonly reason: string } | { readonly status: 'deny'; readonly reason: string };

/**
 * Per-version metadata from the registry, focused on the fields
 * needed for security validation.
 *
 * Intentionally minimal -- we only extract what we check.
 */
export interface VersionMetadata {
  /** When this specific version was published. */
  readonly publishedAt?: Date;
  /** Whether this version has been deprecated. */
  readonly deprecated?: boolean;
}

/**
 * Validates whether a package version should be allowed.
 *
 * Used in two contexts:
 * 1. Metadata filtering: called per-version to decide which versions
 *    to include in the filtered metadata response.
 * 2. Tarball backstop: called when a tarball download is requested,
 *    as a defense-in-depth check.
 */
export interface PackageValidator {
  /**
   * Validates a package version against configured rules.
   *
   * @param pkg - Parsed package identity (name, version, scope).
   * @param metadata - Per-version metadata from the registry, if available.
   *   Undefined when metadata could not be fetched (treated as deny).
   * @returns Decision: allow or deny.
   */
  validate(pkg: PackageIdentity, metadata: VersionMetadata | undefined): PackageDecision;
}

/**
 * In-memory cache of allowed artifacts per package.
 * Populated during metadata filtering, consulted during tarball downloads.
 * The registry proxy bounds it (entries, total size, 1-hour TTL); eviction
 * only means the next download revalidates from fresh metadata.
 *
 * Keyed by canonical package identifier: 'npm:express', 'npm:@types/node',
 * 'cargo:serde'. PyPI is gated per distribution file, so its entries are
 * 'pypi-file:numpy' and hold `files.pythonhosted.org` paths, not versions.
 */
export type AllowedVersionCache = Map<
  string,
  {
    /** Versions that passed validation, or for a 'pypi-file:' entry, the paths of the files that did. */
    readonly allowedVersions: ReadonlySet<string>;
    /** When this cache entry was populated. */
    readonly cachedAt: Date;
  }
>;

/**
 * Audit log entry for package installation decisions.
 * Written to package-audit.jsonl in the session directory.
 *
 * The standard registry proxy writes one for every request it forwards or
 * refuses. An entry records the method, host and path, never a header value.
 */
export interface PackageAuditEntry {
  readonly timestamp: string;
  /** Package identity. */
  readonly registry: RegistryType;
  /** The client's HTTP method: GET or HEAD, or the refused method on a `request-gate` refusal. */
  readonly method: string;
  /** The registry host the client addressed (the CONNECT host, or the host of apt's absolute URL). */
  readonly host: string;
  /**
   * Package name, percent-decoded (e.g. `g++-12`, never `g%2b%2b-12`).
   * Absent when no package identity was parsed: a `request-gate`,
   * `request-path` or `pass-through` entry, or an artifact path the tarball
   * backstop could not parse.
   */
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly packageScope?: string;
  /**
   * PyPI only: the distribution file the decision applies to. PyPI is gated
   * per file, by that file's own upload time, so one release can have both
   * allowed and denied files.
   */
  readonly packageFile?: string;
  /** Decision made by the validator, or the proxy's own allow/deny for a request that names no package. */
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  /**
   * Which check produced the decision:
   * - `metadata-filter`, `tarball-backstop`, `deb-backstop`: package validation.
   *   A `metadata-filter` deny entry without a version records metadata that
   *   could not be fetched or processed, or that lists no installable version.
   * - `request-gate`: refused because the method is not GET or HEAD, or the
   *   request declares a body.
   * - `request-path`: refused because the path is not canonical, or matches no
   *   route on the registry's allowlist.
   * - `pass-through`: an allowlisted read-only route that names no package
   *   (npm search, the PyPI JSON API, Debian `dists/` metadata, ...),
   *   forwarded without credentials.
   */
  readonly source:
    'metadata-filter' | 'tarball-backstop' | 'deb-backstop' | 'request-gate' | 'request-path' | 'pass-through';
  /** The HTTP request path that triggered this check, exactly as the client sent it. */
  readonly requestPath: string;
}
