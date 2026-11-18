# Secure Package Installation Proxy for Docker Agent Mode

**Status (2026-11-14):** Implemented (`src/docker/registry-proxy.ts`). Since this design the registry proxy allows only GET and HEAD on an explicit route allowlist with strict package-name parsing, strips credentials and audits every decision (WP-25, WP-26), and bounds its resources (WP-72).

## Overview

This design extends IronCurtain's Docker Agent Mode to support secure package
installation (npm, pip/PyPI, uv) inside network-isolated containers. The
existing MITM proxy -- which already terminates TLS, allowlists hosts, and
swaps sentinel credentials -- is extended with a **registry proxy** layer that
**rewrites package metadata responses** to remove disallowed versions before the
package manager ever sees them, and **blocks tarball downloads** as a
defense-in-depth backstop. All decisions are binary: allow or deny (no
escalation). The design preserves IronCurtain's core security invariants:
default-deny, credential isolation, and a complete audit trail.

The registry proxy is **read-only**. It forwards only GET and HEAD requests
without a body, only on an explicit per-registry route allowlist, and never
with the client's credentials. Publishing, dist-tag writes, yanks, logins and
every other registry write are refused with a 403. Every request the proxy
forwards or refuses is written to `package-audit.jsonl` (see
[Read-Only Gate and Route Allowlist](#read-only-gate-and-route-allowlist)).

## Architecture Context

Today's Docker Agent Mode data flow:

```
Container (agent)
  |  HTTP CONNECT (HTTPS_PROXY)
  v
MITM Proxy (host)
  |  host allowlist: api.anthropic.com, api.openai.com, ...
  |  TLS termination, endpoint filtering, key swap
  v
Upstream LLM API
```

The MITM proxy uses a `providersByHost` map to allowlist CONNECT targets.
Any host not in the map gets a `403 Forbidden` on CONNECT. This is the
primary network isolation enforcement point for Docker sessions.

**Package registries are currently blocked** because `registry.npmjs.org`,
`pypi.org`, and `files.pythonhosted.org` are not in the allowlist.

## Key Design Decisions

### 1. Extend the MITM proxy rather than create a new MCP tool

**Decision:** Package installation flows through the existing MITM proxy as
HTTP traffic, not through the MCP proxy as a tool call.

**Rationale:**

- Package managers (npm, pip, uv) are complex CLI tools that make dozens of
  HTTP requests per install (dependency resolution, tarball downloads, metadata
  fetches). Wrapping them in an MCP tool would require re-implementing
  resolution logic or shelling out inside the trusted process.
- The MITM proxy already has all the infrastructure: TLS termination,
  per-host cert generation, host allowlisting, request buffering, and
  connection tracking.
- Agents call `npm install` or `pip install` naturally through their shell
  access -- no special tool invocation needed.
- Package managers respect `HTTPS_PROXY`, which is already set in the
  container environment.

**Trade-off:** We lose the MCP-level policy engine evaluation (which operates
on structured `ToolCallRequest` objects). Instead, package validation happens
inside the MITM proxy itself, operating on HTTP request/response metadata.
This is acceptable because: (a) the security-relevant decision is whether a
specific package version is safe to download, not whether the agent is
"allowed to install packages" (which is always yes -- they need packages to
do their work), and (b) the MITM proxy already makes similar allow/deny
decisions via endpoint filtering.

### 2. Proactive metadata filtering (primary gate)

**Decision:** The proxy rewrites registry metadata responses to remove
disallowed versions **before** the package manager resolves dependencies.
This is the primary security enforcement point.

**Rationale:**

- npm and pip resolve versions from metadata, then download tarballs for
  the resolved versions. If we only block at the tarball download level,
  the package manager has already committed to a specific version and will
  fail with a confusing error (403/404 after retries, hard install failure).
- By filtering metadata, the package manager never sees disallowed versions.
  It resolves to the best allowed version naturally, or produces a clean
  "no matching version" error if all versions are filtered.
- This approach is proven: [npm-registry-firewall](https://github.com/antongolub/npm-registry-firewall)
  uses the same pattern.

**npm metadata filtering:**

1. Proxy fetches the full packument JSON from upstream (`GET /{package}`)
2. Removes disallowed versions from the `versions` object
3. Removes corresponding entries from the `time` object
4. Updates `dist-tags.latest` to point to the newest remaining version
5. Returns the filtered packument to npm

The packument is never parsed into objects: it is indexed as it streams in
and served as the upstream's own bytes with the denied versions cut out (see
[Metadata Resource Bounds](#metadata-resource-bounds)).

**PyPI metadata filtering:**

1. Proxy fetches the Simple Repository HTML from upstream (`GET /simple/{package}/`)
2. Removes `<a>` links for disallowed distribution files. Each file is gated by
   its own upload time, not its release's: a release can gain files long after
   it was published (a new platform wheel), and such a file is as new as its
   own upload
3. Returns the filtered HTML to pip/uv

**Failure modes:**

- If a transitive dependency requires `foo@^2.0.0` and all 2.x versions are
  filtered, npm produces a clean `ETARGET` error. pip/uv produce
  "No matching distribution found." These are clear, actionable errors.

### 3. Tarball download blocking (defense-in-depth backstop)

**Decision:** Even though metadata filtering is the primary gate, the proxy
also validates tarball download requests and returns 403 for disallowed
versions. This is a defense-in-depth measure.

**Rationale:**

- An agent could construct a tarball URL directly (guessing or from cached
  data) without going through the metadata endpoint.
- The tarball check uses the same `PackageValidator` as the metadata filter,
  ensuring consistent decisions.
- The tarball check also catches any bugs in the metadata filtering logic.

**Implementation:** When a tarball download request arrives, the proxy:

1. Parses the package name and version from the URL
2. Checks the in-memory metadata cache (populated during metadata filtering).
   npm and crates.io are cached per version; PyPI per distribution file, by its
   `files.pythonhosted.org` path
3. If the version (or PyPI file) was filtered from metadata, returns 403
4. If it is unknown (cache miss), reads metadata from upstream as it streams,
   without holding it, and validates before forwarding

### 4. Binary allow/deny decisions (no escalation)

**Decision:** All package decisions are binary: allow or deny. No escalation
to the user.

**Rationale:**

- Escalation over HTTP is awkward: package managers have tight request
  timeouts (npm: 30s, pip: 15s), and holding HTTP connections open while
  waiting for human input is fragile.
- For a PoC, binary decisions are sufficient. Denied versions simply
  disappear from the package manager's view.
- Users control behavior through configuration (allowlist, denylist,
  quarantine period).

### 5. Validation scope for PoC

**Decision:** Implement two validation checks:

| Check                      | Description                                |
| -------------------------- | ------------------------------------------ |
| Package allowlist/denylist | User-configured lists in `config.json`     |
| Version age gate           | Versions published < N days ago are denied |

**Deferred checks (future work):**

| Check                   | Description                                  |
| ----------------------- | -------------------------------------------- |
| Typosquatting detection | Requires a corpus of popular package names   |
| Dependency confusion    | Requires knowledge of internal package names |
| Malware signatures      | Requires threat intel feed integration       |

**Rationale:** Aikido safe-chain's full threat intelligence stack is a
production system with maintained signature databases. For a PoC, the
version age gate (which only requires reading the package metadata timestamp)
combined with an allowlist gives meaningful security value with minimal
complexity.

### 6. Version age gate: 2 days (configurable)

**Decision:** Deny versions whose publish timestamp is less than 2 days old.
Allowlisted packages bypass this check.

**Rationale:**

- Most malicious packages are detected and removed within 24-72 hours.
  A 2-day window provides margin without being so long that it blocks
  legitimate new packages indefinitely.
- This specifically targets new _versions_ of packages (including brand-new
  packages where all versions are new), not established packages getting
  routine updates -- unless those updates are very recent.
- Configurable via `quarantineDays` in user config (default: 2, set to 0
  to disable).

### 7. Pre-install uv and ruff in base image

**Decision:** Install `uv` and `ruff` in `Dockerfile.base` (and
`Dockerfile.base.arm64`), not in agent-specific Dockerfiles.

**Rationale:**

- Both tools are useful regardless of which agent runs in the container.
- `uv` is a fast Python package manager that agents may use instead of pip.
- `ruff` is a fast Python linter (commonly requested by agents).
- Installing in the base image avoids re-downloading on every agent image
  rebuild.
- Both are single-binary installs with minimal image size impact.

### 8. Audit logging for package operations

**Decision:** Package install decisions are logged to a new
`package-audit.jsonl` file alongside the existing MCP audit log.

**Rationale:**

- Package operations are not MCP tool calls, so they do not fit the existing
  `AuditEntry` schema (which requires `serverName`, `toolName`, etc.).
- A separate audit stream avoids schema pollution and can be analyzed
  independently.
- The entry format mirrors `AuditEntry`'s spirit: timestamp, what was
  requested, what decision was made, and why.
- Every request the registry proxy forwards or refuses gets an entry: package
  decisions, read-only pass-throughs, and refusals alike. An entry records the
  method, host and path, never a header value or the request body.

## Component Architecture

```
Container
  |
  |  npm install express    (or pip install, uv add)
  |  -> HTTPS_PROXY=http://...
  |
  v
MITM Proxy (host-side)
  |
  |  CONNECT registry.npmjs.org:443
  |
  +--> Host Allowlist Check
  |      registry.npmjs.org -> RegistryConfig
  |      (registered alongside LLM providers)
  |
  +--> TLS Termination (per-host cert, same as LLM providers)
  |
  +--> Registry Request Handler (new)
  |      |
  |      +-- Read-only gate (every registry, HTTPS and plain-HTTP apt):
  |      |     403 for any method but GET/HEAD (publish, dist-tag writes,
  |      |     yank, login, npm audit POSTs) and for any request body
  |      |
  |      +-- Request-path gate (every registry, HTTPS and plain-HTTP apt):
  |      |     403 for dot-leading segments (., .., ..;), backslashes, //, encoded . \ % ? #,
  |      |     an encoded / outside npm's @scope%2fname, or a path that
  |      |     WHATWG URL parsing would rewrite
  |      |
  |      +-- Route allowlist per registry host (anything off it -> 403)
  |      |
  |      +-- Metadata budget (per proxy): queued slots, buffered bytes,
  |      |   a per-response ceiling, deadlines; client disconnect aborts upstream
  |      |
  |      +-- GET /{package} (npm metadata request)
  |      |     |
  |      |     +-- Fetch full packument from upstream (indexed as it streams)
  |      |     +-- Filter versions: remove denylisted + too-new
  |      |     +-- Update dist-tags.latest to newest allowed version
  |      |     +-- Cache allowed version set in memory
  |      |     +-- Return filtered packument to container
  |      |     +-- Log filtered versions to package-audit.jsonl
  |      |
  |      +-- GET /simple/{package}/ (PyPI metadata request)
  |      |     |
  |      |     +-- Fetch HTML index, and each file's upload time from the JSON API
  |      |     +-- Remove <a> links for disallowed files (each by its own upload time)
  |      |     +-- Cache allowed file paths in memory
  |      |     +-- Return filtered HTML to container
  |      |     +-- Log filtered versions to package-audit.jsonl
  |      |
  |      +-- GET /{package}/-/{tarball} (npm tarball download)
  |      +-- GET /packages/.../{tarball} (PyPI tarball download)
  |      |     |
  |      |     +-- Parse package name + version from URL
  |      |     +-- Check against cached allowed versions (PyPI: file paths)
  |      |     +-- If allowed -> forward upstream response
  |      |     +-- If denied  -> return 403
  |      |     +-- If unknown -> stream metadata, validate, then decide
  |      |     +-- Log decision to package-audit.jsonl
  |      |
  |      +-- Allowlisted read-only routes that name no package (npm ping,
  |      |   search and dist-tag ls, the PyPI JSON API, cargo search and
  |      |   config.json, Debian dists/ metadata) -> forwarded as-is
  |      |     +-- Log the pass-through to package-audit.jsonl
  |      |
  |      +-- Every refusal -> 403, logged to package-audit.jsonl
  |
  +--> Upstream Forward: the client's GET/HEAD, no body, and only
  |    content-negotiation, caching and range headers (no credentials)
  |
  v
registry.npmjs.org / pypi.org / files.pythonhosted.org
```

## Interface Definitions

### Registry Provider Configuration

The existing `ProviderConfig` interface is designed for LLM APIs (key
injection, endpoint filtering). Registry proxies need different semantics:
no key injection, but package-level validation. Rather than overloading
`ProviderConfig`, we introduce a parallel `RegistryConfig` type and extend
the MITM proxy to handle both.

```typescript
/**
 * Supported package registry types.
 * Each type determines how package names and versions are extracted
 * from HTTP request paths, and how metadata responses are filtered.
 */
type RegistryType = 'npm' | 'pypi';

/**
 * Configuration for a package registry host.
 *
 * Unlike ProviderConfig (which handles credential swap and endpoint
 * filtering for LLM APIs), RegistryConfig handles package-level
 * validation for software registries.
 *
 * No key injection is needed -- package registries are public.
 */
interface RegistryConfig {
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
```

### Built-in Registry Configs

```typescript
const npmRegistry: RegistryConfig = {
  host: 'registry.npmjs.org',
  displayName: 'npm',
  type: 'npm',
};

const pypiRegistry: RegistryConfig = {
  host: 'pypi.org',
  displayName: 'PyPI',
  type: 'pypi',
  mirrorHosts: ['files.pythonhosted.org'],
};
```

### Package Validation Types

```typescript
/**
 * Parsed package identity extracted from a registry HTTP request.
 *
 * Invariant: scope is only present for npm scoped packages
 * (e.g., @types/node). PyPI packages never have a scope.
 */
interface PackageIdentity {
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
type PackageDecision =
  { readonly status: 'allow'; readonly reason: string } | { readonly status: 'deny'; readonly reason: string };
```

### Package Validator Interface

```typescript
/**
 * Validates whether a package version should be allowed.
 *
 * Used in two contexts:
 * 1. Metadata filtering: called per-version to decide which versions
 *    to include in the filtered metadata response.
 * 2. Tarball backstop: called when a tarball download is requested,
 *    as a defense-in-depth check.
 *
 * Implementations are stateless -- all configuration is provided
 * at construction time.
 */
interface PackageValidator {
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
 * Per-version metadata from the registry, focused on the fields
 * needed for security validation.
 *
 * Intentionally minimal -- we only extract what we check.
 */
interface VersionMetadata {
  /** When this specific version was published. */
  readonly publishedAt?: Date;
  /** Whether this version has been deprecated. */
  readonly deprecated?: boolean;
}
```

### Allowed Version Cache

```typescript
/**
 * In-memory cache of allowed artifacts per package.
 * Populated during metadata filtering, consulted during tarball downloads.
 * Bounded (1,024 packages, 250,000 entries in all, 1-hour TTL); eviction only
 * means the next download revalidates from fresh metadata.
 *
 * Keyed by canonical package identifier: 'npm:express', 'npm:@types/node',
 * 'cargo:serde'. PyPI is gated per distribution file, so its entries are
 * 'pypi-file:numpy' and hold files.pythonhosted.org paths, not versions.
 */
type AllowedVersionCache = Map<
  string,
  {
    /** Versions that passed validation, or for 'pypi-file:', the paths of the files that did. */
    readonly allowedVersions: ReadonlySet<string>;
    /** When this cache entry was populated. */
    readonly cachedAt: Date;
  }
>;
```

### Package Audit Entry

```typescript
/**
 * Audit log entry for package installation decisions.
 * Written to package-audit.jsonl in the session directory.
 */
interface PackageAuditEntry {
  readonly timestamp: string;
  /** Package identity. */
  readonly registry: RegistryType;
  /** The client's method: GET or HEAD, or the refused method. */
  readonly method: string;
  /** The registry host the client addressed. */
  readonly host: string;
  /** Percent-decoded name; absent when no package identity was parsed. */
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly packageScope?: string;
  /** PyPI only: the distribution file the decision applies to. */
  readonly packageFile?: string;
  /** Decision made by the validator, or the proxy's own for a request that names no package. */
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  /** Which check produced the decision. */
  readonly source:
    'metadata-filter' | 'tarball-backstop' | 'deb-backstop' | 'request-gate' | 'request-path' | 'pass-through';
  /** The HTTP request path that triggered this check, exactly as sent. */
  readonly requestPath: string;
}
```

Three sources record a request that names no package:

- `request-gate`: refused because the method is not GET or HEAD, or the
  request declares a body (see
  [Read-Only Gate and Route Allowlist](#read-only-gate-and-route-allowlist)).
- `request-path`: refused because the path failed the canonical-path gate (see
  [Request-Path Canonicalization](#request-path-canonicalization)), or matched
  no route on the registry's allowlist.
- `pass-through`: an allowlisted read-only route, such as npm search or Debian
  `dists/` metadata, forwarded without credentials.

The tarball backstop also writes a `deny` entry without a package name when it
cannot parse an artifact path. A metadata request always leaves an entry too:
when the upstream metadata cannot be fetched or processed, or lists no
installable version, the handler writes a `metadata-filter` `deny` entry with
the package name and no version.

### User Configuration Extension

```typescript
// Added to the existing UserConfig schema in user-config.ts

interface PackageInstallConfig {
  /** Enable package installation support. Default: true. */
  readonly enabled?: boolean;

  /**
   * Days a version must age before auto-allow.
   * Versions published less than this many days ago are denied
   * (filtered from metadata). Allowlisted packages bypass this.
   * Default: 2. Set to 0 to disable the age gate.
   */
  readonly quarantineDays?: number;

  /**
   * Packages always allowed (bypass age gate).
   * Format: 'express', '@types/node', 'numpy'.
   * Supports glob patterns: '@types/*', 'eslint-*'.
   */
  readonly allowedPackages?: readonly string[];

  /**
   * Packages always denied (all versions filtered from metadata).
   * Takes precedence over allowedPackages.
   */
  readonly deniedPackages?: readonly string[];
}
```

## URL Parsing Strategy

Each registry type requires a different URL parser to extract package identity
from HTTP request paths.

### Read-Only Gate and Route Allowlist

The registry hosts are on the MITM allowlist of every Docker agent session by
default, so the registry proxy must not become a write channel to them. The
audit found that every request the handler did not recognise was forwarded
with the client's method, all of its headers (`Authorization` and `Cookie`
included) and its body. A compromised agent could publish a crate, move an npm
dist-tag, rewrite a packument or post a PyPI login form, with its own token or
one found in the workspace, and nothing reached `package-audit.jsonl`.

`handleRegistryRequest` therefore applies three rules to every request, for all
registries and for both the HTTPS CONNECT and the plain-HTTP (apt) entry
points:

1. **Method and body** (`checkRegistryRequestMethodAndBody` in
   `src/docker/registry-request-gate.ts`). The method must be GET or HEAD, and
   the request must not declare a body (any `Transfer-Encoding`, or a
   `Content-Length` other than `0`). Anything else gets a 403 and a
   `request-gate` audit entry before any route is considered. The rule runs
   before npm metadata handling, which used to answer an npm publish
   (`PUT /<name>`) with a 200 from a GET of the packument.
2. **Canonical path** (see
   [Request-Path Canonicalization](#request-path-canonicalization)).
3. **Route allowlist** (`classifyRegistryRoute`). Each registry host has an
   explicit list of routes. A request that matches none of them gets a 403 and
   a `request-path` audit entry. Nothing is forwarded just because it is
   unrecognised.

| Host                                    | Allowed routes                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `registry.npmjs.org`                    | Packuments and tarballs; `/-/ping` (npm ping), `/-/v1/search` (npm search), `/-/package/<name>/dist-tags` (npm dist-tag ls) |
| `pypi.org`                              | `/simple/<name>/`; the JSON API `/pypi/<name>/json` and `/pypi/<name>/<version>/json` (Poetry, pip-audit)                   |
| `files.pythonhosted.org`                | Distribution files under `/packages/`                                                                                       |
| `deb.debian.org`, `security.debian.org` | `.deb` packages; allowlisted `dists/` metadata                                                                              |
| `index.crates.io`                       | Sparse-index files; `/config.json`                                                                                          |
| `static.crates.io`                      | Crate downloads under `/crates/`                                                                                            |
| `crates.io`                             | `/api/v1/crates/<name>/<version>/download` (legacy download redirect); `/api/v1/crates` (cargo search)                      |

Everything else is refused. That includes the npm registry root,
`/-/whoami`, `/-/npm/v1/...` (audit, login, tokens, profile, signing keys) and
`/<name>/-rev/...`; the PyPI `/simple/` root and web pages; and crates.io's
crate, owner and user APIs. Rule 1 refuses writes to any route: npm publish,
unpublish, deprecate and dist-tag add/rm, `cargo publish`, `cargo yank`, and
PyPI logins and uploads.

Routes that name no package (npm ping, search and dist-tag ls, the PyPI JSON
API, cargo search and `config.json`, Debian `dists/` metadata) are forwarded
unmodified and audited as `pass-through`. The PyPI JSON API lists every
release unfiltered. A disallowed version found there is still refused by the
tarball backstop on `files.pythonhosted.org`.

**Credentials never leave the proxy.** Metadata the proxy fetches for itself
carries only `Accept` and `Host`. A request forwarded on the client's behalf
(an artifact, a `.deb`, a read-only route) carries the client's GET or HEAD,
no body, and only the client headers in `READ_ONLY_REQUEST_HEADERS`: `accept`,
`accept-encoding`, `accept-language`, `cache-control`, `pragma`, `user-agent`,
the conditional `if-*` headers and `range`. `Authorization`, `Cookie`, every
`npm-*` header (`npm-otp`, `npm-session`, ...), every header the strict package
listener treats as a credential, and any header not on the list are dropped.
So a credential header nobody has listed yet fails closed. Stripping breaks no
install that worked before: the proxy's own metadata and tarball fetches never
carried credentials, so authenticated and private-registry installs never
worked through it.

npm audits every install with a POST to `/-/npm/v1/security/advisories/bulk`,
falling back to `/-/npm/v1/security/audits/quick`. Rule 1 refuses both. npm
treats a failed audit as non-fatal, and the agent containers set
`NPM_CONFIG_AUDIT=false` and `NPM_CONFIG_FUND=false` so that npm does not try.
An explicit `npm audit` is refused.

### Request-Path Canonicalization

The proxy and the upstream registry must read a request path the same way.
Otherwise the proxy validates one package while the registry serves another.
registry.npmjs.org resolves `..` segments, and Debian mirrors percent-decode
file names. So `/@x/../express/-/express-4.18.2.tgz`, `/-/../express`, or
`%6Eetcat-traditional_...deb` once reached a denylisted package.
`handleRegistryRequest` therefore runs `checkRegistryRequestPath`
(`src/docker/registry-request-path.ts`) before any dispatch. It runs for every
registry type, and for both the HTTPS CONNECT and the plain-HTTP (apt) entry
points. The gate refuses with a 403, and writes a `request-path` audit entry,
when any of these holds:

- the target is not origin-form, contains a control character, space,
  non-ASCII byte or `#`;
- the path (before `?`) has a backslash, an empty segment (`//`), a segment
  that starts with a dot, or malformed percent-encoding. A dot-leading segment
  covers `.` and `..`, and also `..;` and `.;`, which servlet containers resolve
  as `..` and `.` after they drop the `;` path parameter. No package name or
  repository path segment starts with a dot;
- the path percent-encodes `.`, `\`, `%`, `?` or `#`, or encodes `/` anywhere
  except npm's one `@scope%2fname` segment;
- `new URL(path).pathname` differs from the path;
- the path decoded once is not printable ASCII (a control character, space,
  or a non-ASCII character an upstream might Unicode-normalize), or contains a
  backslash, `//` or a segment that starts with a dot.

After the gate, each parser decodes the path once and validates the decoded
names against the registry's grammar.

### npm Registry

npm uses a flat URL structure:

```
Metadata:   GET /express                      -> { name: 'express' }
            GET /@types%2fnode               -> { name: 'node', scope: 'types' }
            GET /@types/node                  -> { name: 'node', scope: 'types' }
Tarball:    GET /express/-/express-4.18.2.tgz -> { name: 'express', version: '4.18.2' }
            GET /@types/node/-/node-20.0.0.tgz -> { name: 'node', scope: 'types', version: '20.0.0' }
```

Each scope and name component must match a case-insensitive form of npm's name
grammar: `[A-Za-z0-9][A-Za-z0-9._~!'()*-]{0,213}`. That excludes empty, `.`-,
`_`- or `-`-leading components, a `/` inside a scoped name, and any `%`. Legacy
mixed-case names such as `JSONStream` stay valid. The proxy never forwards the
client's path for a package request. It fetches the canonical path rebuilt from
the validated identity: `/name` or `/@scope%2fname` for metadata, and
`/[@scope/]name/-/name-version.tgz` for a tarball.

**Metadata requests** are intercepted, fetched from upstream, filtered, and
returned. The proxy identifies metadata requests by the absence of a `-` path
segment in the decoded path.

**Tarball requests** (a `-` segment after the package name) are checked against
the allowed version cache. If the version is not in the cache, the tarball is
blocked with 403. A tarball-shaped path that does not parse is also denied.

Only npm's read-only `/-/ping`, `/-/v1/search` and
`/-/package/<name>/dist-tags` pass through without naming a package (see
[Read-Only Gate and Route Allowlist](#read-only-gate-and-route-allowlist)).
Any other path that names no valid package (for example `/`, `/_x`, `/@x/a/b`,
`/express/` or `/-/whoami`) is refused. It is not forwarded, because the
registry might still resolve it to an unfiltered packument.

### PyPI Registry

PyPI splits across two hosts:

```
Metadata:  GET https://pypi.org/simple/numpy/     -> { name: 'numpy' }
Tarball:   GET https://files.pythonhosted.org/packages/.../numpy-1.26.0.tar.gz
                                                   -> { name: 'numpy', version: '1.26.0' }
           GET https://files.pythonhosted.org/packages/.../numpy-1.26.0-*.whl
                                                   -> { name: 'numpy', version: '1.26.0' }
```

**Metadata** on `pypi.org` (Simple Repository HTML) is intercepted and
filtered. The proxy removes `<a>` links for disallowed distribution files.

**Tarball downloads** on `files.pythonhosted.org` are checked against the
allowed file cache. The package name and version are extracted from the
filename (last path segment), and the file is identified by its exact path,
which embeds its blake2b-256 digest. A PEP 658 `.metadata` (or `.provenance`)
sidecar is gated with its file. Only paths under `/packages/` are routed there.

The JSON API on `pypi.org` (`/pypi/<name>/json` and
`/pypi/<name>/<version>/json`), which Poetry and pip-audit read, passes through
unfiltered and is audited. Every other `pypi.org` path is refused.

### PyPI Metadata for File Upload Times

PyPI is age-gated per distribution file (EGR-5). A release can gain files
long after it was published: PyYAML 6.0.1 gained a cp312 aarch64 wheel 184
days after release. Gating a release by its earliest upload would let a
freshly uploaded wheel on a long-published release through at once, and pip
prefers the most specific wheel. So each file is gated by its own
`upload_time_iso_8601`.

The proxy reads `GET https://pypi.org/pypi/{name}/json` as it streams and
keeps only, for every file in `releases`, its `files.pythonhosted.org` URL
path and upload time. A Simple Repository link is matched to its record by
the exact path its href resolves to; that path embeds the file's digest and
name. A link with no matching record (or a record without a valid time) gets
no metadata, so the age gate drops it under a quarantine (fail-closed). The
JSON API is read alongside each Simple Repository request, and on a backstop
cache miss.

The proxy asks for the normalized name, and Warehouse answers a name spelled
other than the project's display name with a redirect to it:
`/pypi/django/json` is a 301 to `/pypi/Django/json` (`pyyaml` to `PyYAML`,
`typing-extensions` to `typing_extensions`). The proxy follows exactly one
301, 302, 307 or 308 whose `Location` resolves to
`https://pypi.org/pypi/<X>/json` with no credentials, port, query or fragment,
where `X` normalizes to the same project name (`pypiJsonApiRedirectPath`). It
reads the redirected document under the same operation deadline and limits
and never reads the redirect's own body. Any other redirect, or a second one,
fails the read like any other non-200 answer, so every file of the project is
withheld (fail-closed).

### Debian Repository

apt speaks plain HTTP. The MITM proxy rewrites each absolute-form request to
origin form and routes it through the same handler as HTTPS traffic. apt quotes
`+`, `~` and space across the whole URI, so `g++-12` arrives as
`g%2b%2b-12_12.2.0-14_amd64.deb`.

```
Package:   GET /debian/pool/main/g/gcc-12/g%2b%2b-12_12.2.0-14_amd64.deb
                                              -> { name: 'g++-12', version: '12.2.0-14' }
Metadata:  GET /debian/dists/bookworm/InRelease   (passed through, apt verifies the signature)
```

The proxy decodes the last path segment exactly once. It refuses malformed
encoding, and a decoded name that still contains `%` (double encoding), `/`,
`\` or a control character. The `.deb` check, name, version and arch then come
from the decoded file name. The name must match Debian's grammar
`[a-z0-9][a-z0-9+.-]+`, the version an optional numeric epoch followed by
`[A-Za-z0-9][A-Za-z0-9.+~-]*`, and the arch `[a-z0-9][a-z0-9-]*`. The validator
and the audit log see the decoded name, so a `g++-12` denylist entry matches
apt's request.

Paths are routed by an explicit allowlist:

- **`.deb` packages** (the decoded file name ends in `.deb`, at any location)
  must parse, and then go through the validator. Debian skips the age gate
  (`publishedAt` is the epoch), so only the allow and deny lists apply.
- **Repository metadata** passes through unmodified, and each request is
  audited as `pass-through`. It is a path under
  `dists/<suite>/` with no `%` and no `pool` segment, whose file is
  `InRelease`, `Release` or `Release.gpg`, an apt index target (`Packages`,
  `Sources`, `Translation-*`, `Contents-*`, `Commands-*`, `Components-*.yml`,
  `icons-*.tar`, optionally compressed), or a `by-hash/<algorithm>/<digest>`
  entry.
- **Everything else is refused with 403**: an unparseable `.deb`, any other
  file under `pool/` (`.udeb`, source packages such as `.dsc` and
  `.orig.tar.*`, directory listings), and paths outside `dists/` and `pool/`.
  pdiff files (`Packages.diff/...`) are refused too; apt falls back to the full
  index.

### crates.io

cargo resolves versions from the sparse index and downloads crates from a CDN:

```
Bootstrap: GET https://index.crates.io/config.json       (passed through)
Metadata:  GET https://index.crates.io/se/rd/serde       -> { name: 'serde' }
Crate:     GET https://static.crates.io/crates/serde/serde-1.0.0.crate
                                                          -> { name: 'serde', version: '1.0.0' }
Search:    GET https://crates.io/api/v1/crates?q=serde   (passed through)
```

Each sparse-index line carries its own `pubtime`, so the index file is filtered
like an npm packument and the allowed versions are cached. `static.crates.io`
is a pure download host, like `files.pythonhosted.org`: every path under
`/crates/` goes through the tarball backstop, and every other path is refused.
On `crates.io` only the legacy `/api/v1/crates/<name>/<version>/download`
redirect (tarball backstop) and `cargo search` are routed. Publish, yank,
owners and every other API call are refused.

## Metadata Filtering Implementation

### npm Packument Filtering

```typescript
/**
 * Filters an indexed npm packument (full or abbreviated) without parsing it
 * into objects. The result:
 * - drops disallowed versions from `versions`, and their entries from `time`;
 *   `time` keeps `created`, `modified` and the allowed versions' entries;
 * - keeps the `dist-tags` that point at an allowed version, and recomputes
 *   `latest` as the newest allowed version when its target was dropped;
 * - copies every other member byte for byte.
 *
 * @param index - Member offsets from createNpmPackumentIndexer(), built while
 *   the packument streamed in
 * @param chunks - The packument as it arrived
 * @returns The response as slices of `chunks` plus the few rebuilt members,
 *   the allowed versions, the denied versions, and every version's publish
 *   time (for the publish-time cache)
 */
function filterNpmPackumentDocument(
  index: NpmPackumentIndex,
  chunks: readonly Buffer[],
  validator: PackageValidator,
  pkg: PackageIdentity,
): FilteredNpmPackument;
```

A version whose `time` entry is missing or not a valid date has no
`publishedAt`, which the age gate treats as fail-closed. `filterNpmPackument`
applies the same filter to a packument object (by way of its JSON text).

### PyPI Simple Index Filtering

```typescript
/**
 * Filters a PyPI Simple Repository HTML page, one distribution file at a time.
 *
 * Each <a> link names a file. Its version comes from the file name, its age
 * from that file's own upload time: the href is resolved to a
 * files.pythonhosted.org path and looked up in `fileUploadTimes`.
 *
 * @param html - Raw HTML from GET /simple/{package}/
 * @param validator - Package validator instance
 * @param packageName - Parsed package name
 * @param fileUploadTimes - files.pythonhosted.org path -> upload time
 *   (read from GET /pypi/{package}/json)
 * @returns Filtered HTML, one denied entry per removed file, and the kept
 *   files' paths (the backstop cache)
 */
function filterPypiIndex(
  html: string,
  validator: PackageValidator,
  packageName: string,
  fileUploadTimes: ReadonlyMap<string, number | undefined>,
): { filtered: string; denied: DeniedArtifact[]; allowedVersions: Set<string>; allowedFiles: Set<string> };
```

## Tarball Backstop Implementation

The tarball backstop is a simple check that runs on every tarball download
request. It ensures that even if an agent constructs a tarball URL directly
(bypassing metadata), the download is blocked if the version is not allowed.

```
Tarball request arrives (GET /express/-/express-4.18.2.tgz)
  |
  +-- Parse package name + version from URL
  |
  +-- Look up in AllowedVersionCache (PyPI: by file path)
  |     |
  |     +-- Cache HIT, version in allowed set -> FORWARD to upstream
  |     +-- Cache HIT, version NOT in allowed set -> 403 (was filtered)
  |     +-- Cache MISS -> stream metadata, run validator
  |           |   (npm: a cached version-to-time map that lists the version
  |           |    avoids refetching the packument; PyPI: the file's own time)
  |           |
  |           +-- Version allowed -> populate cache, FORWARD
  |           +-- Version denied -> populate cache, 403
  |           +-- Metadata fetch failed -> 403 (fail-closed)
  |
  +-- Log decision to package-audit.jsonl
```

The cache miss path is the defense-in-depth case: the agent somehow has a
tarball URL for a package whose metadata was never requested through the
proxy. This could happen if:

- The agent guesses a tarball URL based on package naming conventions
- The agent has cached package information from a previous session
- A bug in the metadata filtering allowed a version through metadata but
  the tarball check catches it

## Validation Logic

The `PackageValidator` evaluates rules in this order (first match wins):

```
1. Denylist match?     -> DENY  (takes precedence over everything)
2. Allowlist match?    -> ALLOW (bypasses age gate)
3. Version too new?    -> DENY  (published < quarantineDays ago)
4. No metadata?        -> DENY  (fail-closed)
5. Default             -> ALLOW
```

Allowlist and denylist support glob patterns via [minimatch](https://github.com/isaacs/minimatch)
or similar. Examples: `@types/*`, `eslint-*`, `react-*`.

## MITM Proxy Integration

### Changes to `createMitmProxy`

The `MitmProxyOptions` interface gains an optional `registries` field:

```typescript
interface MitmProxyOptions {
  // ... existing fields ...

  /**
   * Package registry configurations.
   * When present, the proxy allows CONNECT to registry hosts and
   * validates/filters package metadata and tarball downloads.
   */
  readonly registries?: readonly RegistryConfig[];

  /**
   * Package validation configuration.
   * Only meaningful when registries is non-empty.
   */
  readonly packageValidation?: {
    readonly validator: PackageValidator;
    readonly auditLogPath: string;
  };
}
```

### Host Allowlist Extension

The CONNECT handler's `providersByHost` map currently only contains LLM
provider hosts. Registry hosts are added to a parallel
`registriesByHost: Map<string, RegistryConfig>` map. The CONNECT handler
checks both maps:

```typescript
// In CONNECT handler:
const provider = providersByHost.get(host);
const registry = registriesByHost.get(host);

if (!provider && !registry) {
  // DENIED
  clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  clientSocket.destroy();
  return;
}
```

Registry connections get TLS-terminated identically to provider connections
(same `getOrCreateSecureContext` path). The difference is in the inner
server's request handler, where registry requests are routed to the
metadata filtering / tarball backstop pipeline instead of the API key swap
pipeline.

The `socketMetadata` WeakMap is extended to include an optional `registry`
field so the inner server can distinguish registry requests from provider
requests:

```typescript
// Extended metadata:
interface ConnectionMeta {
  readonly provider?: ProviderKeyMapping;
  readonly registry?: RegistryConfig;
  readonly host: string;
  readonly port: number;
}
```

### Inner Server Request Dispatch

```typescript
innerServer.on('request', (clientReq, clientRes) => {
  const meta = socketMetadata.get(clientReq.socket as tls.TLSSocket);

  if (meta?.provider) {
    // Existing LLM API path: endpoint filter -> key swap -> forward
    handleProviderRequest(meta.provider, clientReq, clientRes);
  } else if (meta?.registry) {
    // New registry path: metadata filter or tarball backstop
    handleRegistryRequest(meta.registry, clientReq, clientRes);
  } else {
    clientRes.writeHead(500);
    clientRes.end('Internal error');
  }
});
```

### Registry Request Handler

```typescript
async function handleRegistryRequest(
  registry: RegistryConfig,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
): Promise<void> {
  const path = clientReq.url ?? '/';

  // Anything but a bodiless GET or HEAD -> 403 (request-gate)
  const gate = checkRegistryRequestMethodAndBody(clientReq.method, clientReq.headers);
  if (!gate.ok) return refuseRegistryRequest(clientRes, path, gate.reason, 'request-gate');

  // Non-canonical paths (dot segments, encoded separators, ...) -> 403
  const pathCheck = checkRegistryRequestPath(registry.type, path);
  if (!pathCheck.ok) return refuseRegistryRequest(clientRes, path, pathCheck.reason, 'request-path');

  // Handlers get the client's headers, never its request stream
  const request = { method: gate.method, host, path, headers: clientReq.headers };
  const route = classifyRegistryRoute(registry, host, path);
  switch (route.kind) {
    case 'npm-metadata': // fetch the canonical packument, filter, cache
      return handleNpmMetadata(request, route.pkg);
    case 'pypi-simple': // fetch the simple page and JSON timestamps, filter, cache
      return handlePypiSimple(request, route.pkg);
    case 'cargo-index': // fetch the sparse-index file, filter, cache
      return handleCargoSparseIndex(request, route.pkg);
    case 'artifact': // tarball backstop: cached or freshly validated version, or 403
      return handleTarballDownload(request);
    case 'debian-package': // allow/deny lists (no age gate), then forward or 403
      return handleDebianPackage(request, route.pkg);
    case 'read-only': // npm ping/search/dist-tag ls, PyPI JSON, cargo search, dists/
      auditRegistryDecision(request, { decision: 'allow', source: 'pass-through', reason: route.endpoint });
      return forwardReadOnly(request, path);
    case 'refused': // off the allowlist -> 403
      return refuseRegistryRequest(clientRes, path, route.reason, 'request-path');
  }
}
```

`forwardReadOnly` is the only way a client request reaches the registry. It
sends the client's GET or HEAD with no body and only the headers that
`buildReadOnlyUpstreamHeaders` copies.

## Dockerfile Changes

### `Dockerfile.base` and `Dockerfile.base.arm64`

Add uv and ruff installation after the existing `apt-get` block:

```dockerfile
# Python tooling: uv (fast package manager) and ruff (linter)
# Install as root before switching to codespace user.
# Uses the official install scripts for platform-appropriate binaries.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    curl -LsSf https://astral.sh/ruff/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/ruff /usr/local/bin/ruff && \
    rm -rf /root/.local
```

For `Dockerfile.base.arm64` (which already purges curl after Goose download),
curl must be retained or re-installed. The simplest approach is to install
uv/ruff before the curl purge step, or to use the static binary downloads
directly:

```dockerfile
# Direct binary download (no curl dependency at runtime)
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) UV_ARCH=x86_64;; \
      arm64) UV_ARCH=aarch64;; \
    esac && \
    curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" | \
      tar -xz -C /usr/local/bin/ --strip-components=1 && \
    curl -fsSL "https://github.com/astral-sh/ruff/releases/latest/download/ruff-${UV_ARCH}-unknown-linux-gnu.tar.gz" | \
      tar -xz -C /usr/local/bin/
```

Note: `Dockerfile.base` uses the `devcontainers/universal` image which
already has Python and curl. `Dockerfile.base.arm64` uses `node:22-bookworm`
which needs `curl` (already installed for git/socat). The uv/ruff install
should happen while curl is still available, before the apt purge in
agent-specific Dockerfiles.

## Session Lifecycle Integration

### `prepareDockerInfrastructure()` Changes

The infrastructure setup function gains registry configuration:

1. Read `packageInstall` config from `ResolvedUserConfig`.
2. If enabled, construct `RegistryConfig[]` for npm and PyPI.
3. Construct a `PackageValidator` from the allowlist/denylist/quarantine config.
4. Pass registries and validator to `createMitmProxy()`.
5. Write the package audit log path into the session directory.

### Container Environment

No container-side changes are needed beyond what already exists. The
`HTTPS_PROXY` environment variable is already set, and package managers
honor it. The IronCurtain CA certificate is already trusted (installed in
the base image via `update-ca-certificates`).

npm, pip, and uv all support HTTPS proxies via the `HTTPS_PROXY`
environment variable and will route registry traffic through the MITM
proxy automatically.

Every agent container, and the workflow dependency provisioner, also gets
`NPM_CONFIG_AUDIT=false` and `NPM_CONFIG_FUND=false`
(`src/docker/package-client-env.ts`). The read-only registry proxy refuses
npm's install-time audit POSTs, so npm is told not to send them.

## New Files

| File                                        | Purpose                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/docker/registry-proxy.ts`              | `RegistryConfig`, URL parsers, `handleRegistryRequest()`, metadata filtering       |
| `src/docker/registry-metadata.ts`           | Streaming metadata readers (npm, PyPI per file, cargo), npm publish-time cache     |
| `src/docker/registry-metadata-budget.ts`    | Per-proxy metadata budget: queued slots, buffered bytes, ceiling, deadlines        |
| `src/docker/json-stream-scanner.ts`         | Incremental, bounded JSON scanner with byte offsets                                |
| `src/docker/package-validator.ts`           | `PackageValidator` implementation, age gate/allowlist/denylist logic               |
| `src/docker/package-types.ts`               | `PackageIdentity`, `PackageDecision`, `VersionMetadata`, `PackageAuditEntry`       |
| `src/docker/registry-request-gate.ts`       | Read-only gate (GET/HEAD, no body) and the forwarded-header allowlist              |
| `src/docker/package-client-env.ts`          | `NPM_CONFIG_AUDIT=false` / `NPM_CONFIG_FUND=false` for agent containers            |
| `test/docker/registry-proxy.test.ts`        | URL parsing, metadata filtering, tarball backstop, read-only gate, route allowlist |
| `test/docker/registry-request-gate.test.ts` | Method/body gate, credential stripping                                             |
| `test/docker/package-validator.test.ts`     | Validation logic: allowlist, denylist, age gate                                    |

## Modified Files

| File                                  | Change                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `src/docker/mitm-proxy.ts`            | Add `registries` to options, extend CONNECT handler and inner server dispatch |
| `src/docker/docker-infrastructure.ts` | Build registry configs and validator, pass to MITM proxy; package-client env  |
| `src/docker/pty-session.ts`           | Package-client env for PTY agent containers                                   |
| `src/config/user-config.ts`           | Add `packageInstall` config schema and defaults                               |
| `docker/Dockerfile.base`              | Install uv and ruff                                                           |
| `docker/Dockerfile.base.arm64`        | Install uv and ruff                                                           |

## Extension Points

### Future: Full Aikido-style Threat Intelligence

The `PackageValidator` interface is deliberately narrow. A future implementation
could:

1. Call an external threat intelligence API (e.g., Socket.dev, Snyk, OSV)
   during the `validate()` step, with results cached.
2. Check for known CVEs in the specific version being downloaded.
3. Perform typosquatting detection by computing edit distance against a
   corpus of top-1000 packages.
4. Detect dependency confusion by checking if the package name matches
   any known private registry package.

These would be additional `PackageValidator` implementations composed via
a chain-of-responsibility pattern:

```typescript
function createCompositeValidator(validators: readonly PackageValidator[]): PackageValidator {
  return {
    validate(pkg, metadata) {
      for (const v of validators) {
        const decision = v.validate(pkg, metadata);
        if (decision.status !== 'allow') return decision;
      }
      return { status: 'allow', reason: 'All validators passed' };
    },
  };
}
```

### Future: Escalation Support

The current binary allow/deny model could be extended to support escalation
for borderline cases (e.g., recently published versions of established
packages). This would require solving the HTTP timeout problem -- either
by increasing package manager timeouts in the container environment, or by
using a pre-flight validation model where packages are approved before
installation begins.

### Future: Private Registry Support

The `RegistryConfig` type can be extended with authentication fields
(similar to `ProviderConfig.keyInjection`) for private npm registries
or Artifactory/Nexus instances. This would follow the same credential
isolation pattern: the container gets a fake token, the MITM proxy
swaps it for the real one.

### Future: Dependency Lock File Validation

Instead of checking individual package downloads, a more holistic approach
would validate the entire dependency tree against a lock file
(`package-lock.json`, `uv.lock`) that was approved before the session
started. This is orthogonal to the per-download validation designed here
and could be layered on top.

## Testing Strategy

### Unit Tests

The design's modular structure enables clean unit testing:

- **URL parsers** (`registry-proxy.ts`): Pure functions, tested with tables
  of npm/PyPI URL patterns mapped to expected `PackageIdentity` values.
- **Metadata filters** (`registry-proxy.ts`): Given a raw packument/HTML
  and a validator config, verify correct version removal and dist-tags update.
- **PackageValidator** (`package-validator.ts`): Stateless validation logic
  tested with various `PackageIdentity` + `VersionMetadata` combinations
  against different allowlist/denylist/quarantine configs.
- **Tarball backstop**: Given a URL and an allowed version cache, verify
  correct allow/deny decisions.
- **Read-only gate and route allowlist** (`registry-request-gate.ts`,
  `classifyRegistryRoute`): every write (npm publish and dist-tag writes,
  cargo publish and yank, PyPI login, any POST) and every off-allowlist path
  gets a 403 and an audit entry without reaching upstream; no credential or
  `npm-*` header is forwarded; npm, pip, cargo and apt installs against a fake
  upstream still succeed.

### Integration Tests

- Spawn a real MITM proxy with registry configs enabled.
- Use a mock registry server (plain HTTP) as the "upstream."
- Verify: (a) allowed versions appear in filtered metadata, (b) denied
  versions are removed from metadata, (c) tarball downloads for denied
  versions return 403, (d) tarball downloads for allowed versions succeed.

### Manual Testing

- Build a container with uv/ruff pre-installed.
- Run `npm install express` inside a Docker agent session.
- Verify the package audit log contains the expected entries.
- Run `uv add numpy` (a package old enough to pass the age gate).
- Verify that very recently published package versions are filtered out.

## Security Considerations

### No Credential Injection for Registries

Unlike LLM providers, public package registries do not require
authentication. The MITM proxy does not inject any credentials into
registry requests. This eliminates an entire class of credential
leakage risks.

It also strips every credential the client sends. A forwarded request carries
only an allowlist of content-negotiation, caching and range headers, so
neither the agent's token nor a user token found in the workspace (`.npmrc`,
`.cargo/credentials.toml`) ever reaches a registry.

### Fail-Closed Behavior

If the upstream metadata fetch fails (network error, invalid JSON,
timeout), the metadata handler returns a 502 error to the package
manager rather than serving unfiltered metadata (a 404 for a crates.io
sparse-index file, which cargo reads as "crate not found"), and audits the
failure as a `metadata-filter` deny. For tarball backstop
cache misses where metadata cannot be fetched, the download is denied
with a 403. This ensures that registry outages or parsing errors do
not silently allow potentially dangerous packages.

A forwarded download or pass-through route whose upstream fails (a reset, a
socket error) or goes idle past its timeout gets a 502 (504 for the timeout)
while no response headers were sent. Once they were sent, the proxy destroys
the client response, so the client sees an aborted transfer at once and can
retry, instead of holding a truncated body until its own timeout.

### Metadata Resource Bounds

The registry proxy runs in the trusted host process, and the agent chooses
which package metadata it fetches. npm packuments reach tens of megabytes
(`@prisma/client` 68 MB, `vite` 39 MB, `next` 31 MB), so metadata work is
bounded per proxy (EGR-4, `registry-metadata-budget.ts`):

| Bound                                                     | Value   |
| --------------------------------------------------------- | ------- |
| Metadata operations running at once (more wait in FIFO)   | 8       |
| Operations waiting for a slot (more get 503)              | 512     |
| Metadata bytes buffered at once, across operations        | 256 MiB |
| One metadata response, buffered or streamed (fail-closed) | 128 MiB |
| One operation, queueing and response included             | 5 min   |
| Upstream metadata fetch with no data                      | 30 s    |

An operation is one metadata request, or one tarball-backstop lookup on a
cache miss. Before reading a body it buffers, it reserves the declared length
(or the whole 128 MiB ceiling when none is declared) and waits, in FIFO order,
until that fits; the reservation shrinks to the actual size once known and is
held until its response is flushed. A client that disconnects aborts the
operation, its upstream fetches and any wait. Each failure is a fixed audit
reason that names the bound (`Upstream metadata exceeds the 128 MiB metadata
size ceiling`, `Registry metadata request exceeded its 300 s deadline`,
`Registry metadata queue is full`, ...).

Memory per buffered document is about its size: an npm packument is indexed
by an incremental JSON scanner (`json-stream-scanner.ts`) as it arrives and
served as slices of the upstream's own bytes with denied versions cut out. It
is never parsed into objects or serialized again. A tracked member repeated in
the packument (`versions`, `time`, `dist-tags`, or one version) is refused,
since `JSON.parse` on the client would keep the last copy. The tarball
backstop and the PyPI JSON API are read as they stream and never held. npm
version-to-publish-time maps are cached per package (512 packages, 250,000
versions, 6 hours); publish times never change, and a version a cached map
does not list is always refetched.

### Two-Layer Defense

The metadata filter + tarball backstop provides defense in depth:

1. **Primary**: Metadata filtering ensures package managers never
   resolve to disallowed versions.
2. **Backstop**: Tarball blocking catches direct URL construction,
   cache inconsistencies, or metadata filtering bugs.

### No Arbitrary Host Access

Adding registry hosts to the MITM proxy's allowlist does NOT give the
container general internet access. The container can only reach hosts
explicitly listed in the `providersByHost` or `registriesByHost` maps.
Each registry host's traffic is further filtered by the registry request
handler. Anything but a bodiless GET or HEAD is refused, so the registries
cannot be written to (no publish, dist-tag change, yank or login).
Non-canonical request paths are refused before dispatch. Package metadata and
download paths are validated and filtered. A few read-only routes that name no
package (npm ping, search and dist-tag ls, the PyPI JSON API, cargo search and
`config.json`, Debian `dists/` metadata) are forwarded without filtering or
credentials. Every other path is refused, and every forwarded or refused
request is audited.

### Post-Install Script Mitigation

Package install scripts (`preinstall`, `postinstall` for npm; `setup.py`
for pip) can execute arbitrary code. While the container's network
isolation limits their damage, the container environment should be
configured to skip install scripts by default where possible:

- npm: Set `NPM_CONFIG_IGNORE_SCRIPTS=true` in container environment
- pip: Use `--no-build-isolation` cautiously; prefer wheels over sdists

This is a container configuration concern, not a proxy concern, but is
noted here for completeness.

## Migration Plan

### Phase 1: Types and Validator (no runtime changes)

- Add `package-types.ts` with all type definitions.
- Implement `PackageValidator` with allowlist/denylist/age gate.
- Add URL parsers for npm and PyPI.
- Add metadata filtering functions (npm packument, PyPI simple index).
- Full test coverage for validator, parsers, and filters.

### Phase 2: MITM Proxy Extension

- Extend `MitmProxyOptions` with registry fields.
- Add `registriesByHost` map and CONNECT handler extension.
- Add inner server request dispatch for registry connections.
- Implement `handleRegistryRequest()` with metadata filtering and tarball
  backstop.
- Add `AllowedVersionCache` with 1-hour TTL.
- Integration tests with mock upstream.

### Phase 3: Session Integration

- Add `packageInstall` to user config schema.
- Wire registry configs into `prepareDockerInfrastructure()`.
- Add package audit log writing.

### Phase 4: Dockerfile and E2E

- Add uv/ruff to base Dockerfiles.
- End-to-end test: Docker session with package install.
- Documentation update.
