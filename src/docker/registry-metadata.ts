/**
 * Streaming readers for package-registry metadata, shared by the standard
 * registry proxy (`registry-proxy.ts`) and the strict package-egress proxy
 * (`package-egress-proxy.ts`).
 *
 * Registry metadata documents can be large: the npm packument for
 * `@prisma/client` is about 68 MB, `vite` 39 MB and `next` 31 MB. None of the
 * readers here buffer the document or build it as JavaScript objects. Each is
 * fed the body chunk by chunk as it arrives ({@link StreamingMetadataReader})
 * and keeps only what its caller needs: one version's publish time, the
 * version-to-time map, the upload time of each PyPI distribution file, or the
 * byte offsets the standard proxy needs to cut denied versions out of a
 * packument it holds. JSON documents are read by `json-stream-scanner.ts`,
 * which checks the full grammar and refuses a repeated member name wherever a
 * reader looks.
 *
 * The age gate is applied per artifact:
 * - npm and crates.io: per version (one tarball per version, immutable).
 * - PyPI: per distribution file. A release can gain files long after it was
 *   published (a new platform wheel), so each file is gated by its own
 *   `upload_time_iso_8601`, matched by its exact `files.pythonhosted.org`
 *   path. That path embeds the file's blake2b-256 digest and file name.
 *
 * Errors are {@link RegistryMetadataError}s with fixed messages that never
 * quote the document.
 */

import { JsonScanError, JsonStreamScanner, type JsonScanChild, type JsonValueKind } from './json-stream-scanner.js';

const MIB = 1024 * 1024;

/**
 * The largest registry metadata response the proxies read. It sits well
 * above the largest real documents (`@prisma/client`'s packument is 65.4 MiB)
 * so ordinary installs are never refused, and below anything that could hold
 * the host process hostage.
 */
export const MAX_REGISTRY_METADATA_BYTES = 128 * MIB;

/**
 * `malformed`: not the expected document (invalid JSON, a repeated member
 * name, a wrong type). `limit`: a reader bound was exceeded. `absent`: the
 * requested version or file is not in the metadata.
 */
export type RegistryMetadataErrorCode = 'malformed' | 'limit' | 'absent';

export class RegistryMetadataError extends Error {
  constructor(
    readonly code: RegistryMetadataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryMetadataError';
  }
}

/** Renders a byte ceiling for an audit reason: `128 MiB`, or `4096 bytes` when it is not whole mebibytes. */
export function formatByteCeiling(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;
}

/** Reads one metadata body incrementally. `finish` checks the document is complete and returns the result. */
export interface StreamingMetadataReader<T> {
  write(chunk: Uint8Array): void;
  finish(): T;
}

/** A time string as an epoch-millisecond number, or undefined when it is missing or not a valid date. */
export function parsePublishTime(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const time = new Date(text).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function scanError(error: unknown): unknown {
  return error instanceof JsonScanError ? new RegistryMetadataError(error.code, error.message) : error;
}

/** Wraps a scanner so its errors surface as {@link RegistryMetadataError}s. */
function jsonReader<T>(scanner: JsonStreamScanner, finish: () => T): StreamingMetadataReader<T> {
  return {
    write(chunk) {
      try {
        scanner.write(chunk);
      } catch (error) {
        throw scanError(error);
      }
    },
    finish() {
      try {
        scanner.end();
      } catch (error) {
        throw scanError(error);
      }
      return finish();
    },
  };
}

// ── npm ─────────────────────────────────────────────────────────────

/** Most versions one packument may list; above every real package (`@prisma/client` has about 8,000). */
export const MAX_NPM_VERSIONS = 250_000;

/** Every version a packument lists, with its publish time when `time` gives a valid one. */
export interface NpmPublishTimes {
  readonly versions: ReadonlyMap<string, number | undefined>;
}

function isNpmIndexedMember(name: string): boolean {
  return name === 'versions' || name === 'time' || name === 'dist-tags';
}

/**
 * Reads one version's publish time from a full npm packument: whether
 * `versions[version]` exists and the value of `time[version]`. Used by the
 * strict proxy to age-gate one tarball. Throws `absent` when the packument
 * does not list the version; returns undefined when it has no valid time.
 */
export function createNpmVersionTimeReader(version: string): StreamingMetadataReader<number | undefined> {
  let rootKind: JsonValueKind | undefined;
  let versionsKind: JsonValueKind | undefined;
  let listed = false;
  let timeText: string | undefined;
  const scanner = new JsonStreamScanner({
    track: (path, kind) =>
      path.length === 0 || (path.length === 1 && kind === 'object' && (path[0] === 'versions' || path[0] === 'time')),
    capture: (path) => path.length === 2 && path[0] === 'time' && path[1] === version,
    child: (child) => {
      const { path } = child;
      if (path.length === 0) rootKind = child.kind;
      else if (path.length === 1 && path[0] === 'versions') versionsKind = child.kind;
      else if (path.length === 2 && path[1] === version) {
        if (path[0] === 'versions') listed = true;
        else if (path[0] === 'time' && child.kind === 'string') timeText = child.text;
      }
    },
  });
  return jsonReader(scanner, () => {
    if (rootKind !== 'object') throw new RegistryMetadataError('malformed', 'package metadata is not a JSON object');
    if (versionsKind !== 'object' || !listed) {
      throw new RegistryMetadataError('absent', 'requested package version is absent from npm metadata');
    }
    return parsePublishTime(timeText);
  });
}

/**
 * Reads every version of a full npm packument with its publish time. Used by
 * the standard proxy's tarball backstop, which validates a tarball without
 * holding the packument.
 */
export function createNpmPublishTimesReader(maxVersions = MAX_NPM_VERSIONS): StreamingMetadataReader<NpmPublishTimes> {
  let rootKind: JsonValueKind | undefined;
  let versionsKind: JsonValueKind | undefined;
  const versions: string[] = [];
  const timeTexts = new Map<string, string>();
  const scanner = new JsonStreamScanner({
    track: (path, kind) =>
      path.length === 0 || (path.length === 1 && kind === 'object' && (path[0] === 'versions' || path[0] === 'time')),
    capture: (path) => path.length === 2 && path[0] === 'time',
    child: (child) => {
      const { path } = child;
      if (path.length === 0) {
        rootKind = child.kind;
      } else if (path.length === 1) {
        if (path[0] === 'versions') versionsKind = child.kind;
      } else if (path.length === 2) {
        const name = String(path[1]);
        if (path[0] === 'versions') {
          if (versions.length >= maxVersions) {
            throw new RegistryMetadataError('limit', 'npm metadata lists more versions than the proxy reads');
          }
          versions.push(name);
        } else if (child.kind === 'string' && child.text !== undefined) {
          if (timeTexts.size >= maxVersions + 2) {
            throw new RegistryMetadataError('limit', 'npm metadata lists more versions than the proxy reads');
          }
          timeTexts.set(name, child.text);
        }
      }
    },
  });
  return jsonReader(scanner, () => {
    if (rootKind !== 'object') throw new RegistryMetadataError('malformed', 'package metadata is not a JSON object');
    if (versionsKind !== 'object') throw new RegistryMetadataError('malformed', 'npm metadata has no versions object');
    return { versions: new Map(versions.map((version) => [version, parsePublishTime(timeTexts.get(version))])) };
  });
}

/** One member of a packument object, by absolute byte offsets into the document. */
export interface NpmPackumentMember {
  readonly name: string;
  readonly kind: JsonValueKind;
  /** Offset of the member name's opening quote. */
  readonly start: number;
  /** Offset one past the member value. */
  readonly end: number;
  /** The string value, for members of `time` and `dist-tags`. */
  readonly text?: string;
}

/**
 * Where a packument's parts are, so the standard proxy can serve it with
 * denied versions cut out without parsing it into objects. `versions`, `time`
 * and `dist-tags` hold their members when the document has them.
 */
export interface NpmPackumentIndex {
  readonly members: readonly NpmPackumentMember[];
  readonly versions: readonly NpmPackumentMember[];
  readonly time?: readonly NpmPackumentMember[];
  readonly distTags?: readonly NpmPackumentMember[];
}

/**
 * Indexes a full or abbreviated npm packument as it streams in. The root must
 * be an object with a `versions` object; `time` and `dist-tags`, when present,
 * must be objects. None of them may repeat a member name.
 */
export function createNpmPackumentIndexer(maxVersions = MAX_NPM_VERSIONS): StreamingMetadataReader<NpmPackumentIndex> {
  let rootKind: JsonValueKind | undefined;
  const members: NpmPackumentMember[] = [];
  const children = new Map<string, NpmPackumentMember[]>([
    ['versions', []],
    ['time', []],
    ['dist-tags', []],
  ]);
  const member = (name: string, child: JsonScanChild): NpmPackumentMember => ({
    name,
    kind: child.kind,
    start: child.start,
    end: child.end,
    ...(child.text === undefined ? {} : { text: child.text }),
  });
  const scanner = new JsonStreamScanner({
    track: (path, kind) =>
      path.length === 0 || (path.length === 1 && kind === 'object' && isNpmIndexedMember(String(path[0]))),
    capture: (path) => path.length === 2 && (path[0] === 'time' || path[0] === 'dist-tags'),
    child: (child) => {
      const { path } = child;
      if (path.length === 0) {
        rootKind = child.kind;
      } else if (path.length === 1) {
        members.push(member(String(path[0]), child));
      } else if (path.length === 2) {
        const list = children.get(String(path[0]));
        if (list === undefined) return;
        if (list.length >= maxVersions + 2) {
          throw new RegistryMetadataError('limit', 'npm metadata lists more versions than the proxy reads');
        }
        list.push(member(String(path[1]), child));
      }
    },
  });
  return jsonReader(scanner, () => {
    if (rootKind !== 'object') throw new RegistryMetadataError('malformed', 'package metadata is not a JSON object');
    const kindOf = (name: string): JsonValueKind | undefined => members.find((entry) => entry.name === name)?.kind;
    if (kindOf('versions') !== 'object') {
      throw new RegistryMetadataError('malformed', 'npm metadata has no versions object');
    }
    for (const name of ['time', 'dist-tags']) {
      const kind = kindOf(name);
      if (kind !== undefined && kind !== 'object') {
        throw new RegistryMetadataError('malformed', `npm metadata ${name} is not an object`);
      }
    }
    return {
      members,
      versions: children.get('versions') ?? [],
      ...(kindOf('time') === undefined ? {} : { time: children.get('time') ?? [] }),
      ...(kindOf('dist-tags') === undefined ? {} : { distTags: children.get('dist-tags') ?? [] }),
    };
  });
}

// ── PyPI ────────────────────────────────────────────────────────────

/** The host that serves every PyPI distribution file. */
export const PYPI_FILES_HOST = 'files.pythonhosted.org';

/** Most distribution files one PyPI project may list; well above the largest real projects. */
export const MAX_PYPI_FILES = 200_000;

const PYPI_SIDECAR_SUFFIXES = ['.metadata', '.provenance'];

/**
 * Strips a PEP 658 (`.metadata`) or PEP 714 (`.provenance`) sidecar suffix
 * from a PyPI file name or path, so the sidecar is gated with its file.
 * Returns the value unchanged when no known suffix matches.
 */
export function stripPypiSidecarSuffix(value: string): string {
  for (const suffix of PYPI_SIDECAR_SUFFIXES) {
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
}

/**
 * The key a PyPI distribution file is gated by: its `files.pythonhosted.org`
 * path, query dropped and sidecar suffix stripped. `requestPath` must already
 * be canonical (the request-path gate, or the strict route grammar).
 */
export function pypiDistributionFileKey(requestPath: string): string {
  return stripPypiSidecarSuffix(requestPath.split('?')[0]);
}

/**
 * The file key of a distribution-file URL: the path of an `https` URL on
 * `files.pythonhosted.org` with no port, credentials or query (the fragment,
 * such as `#sha256=...`, is ignored). A relative `url` is resolved against
 * `base`. Undefined for any other URL.
 */
export function pypiFileKeyFromUrl(url: string, base?: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== PYPI_FILES_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== ''
  ) {
    return undefined;
  }
  return parsed.pathname;
}

/**
 * The JSON API files of a project, as they stream past: `releases[version][i]`
 * objects whose `url` and `upload_time_iso_8601` strings are captured. Calls
 * `onFile` once per file object.
 */
function pypiReleaseFilesScanner(onFile: (url: string | undefined, uploadTime: string | undefined) => void): {
  scanner: JsonStreamScanner;
  rootKind: () => JsonValueKind | undefined;
} {
  let rootKind: JsonValueKind | undefined;
  let url: string | undefined;
  let uploadTime: string | undefined;
  const scanner = new JsonStreamScanner({
    track: (path, kind) => {
      switch (path.length) {
        case 0:
          return true;
        case 1:
          return kind === 'object' && path[0] === 'releases';
        case 2:
          return kind === 'array';
        case 3:
          return kind === 'object';
        default:
          return false;
      }
    },
    capture: (path) => path.length === 4 && (path[3] === 'url' || path[3] === 'upload_time_iso_8601'),
    child: (child) => {
      const { path } = child;
      if (path.length === 0) {
        rootKind = child.kind;
      } else if (path.length === 4) {
        if (child.kind !== 'string') return;
        if (path[3] === 'url') url = child.text;
        else uploadTime = child.text;
      } else if (path.length === 3) {
        if (child.kind === 'object') onFile(url, uploadTime);
        url = undefined;
        uploadTime = undefined;
      }
    },
  });
  return { scanner, rootKind: () => rootKind };
}

/**
 * Two records for one file: keep the more restrictive time. An unknown time
 * is the most restrictive, since the age gate denies a file without one.
 */
function laterUploadTime(previous: number | undefined, next: number | undefined): number | undefined {
  return previous === undefined || next === undefined ? undefined : Math.max(previous, next);
}

/**
 * Reads the upload time of every distribution file from a project's PyPI JSON
 * API document (`/pypi/<name>/json`), keyed by {@link pypiFileKeyFromUrl}. A
 * file whose record has no valid time maps to undefined.
 */
export function createPypiFileTimesReader(
  maxFiles = MAX_PYPI_FILES,
): StreamingMetadataReader<ReadonlyMap<string, number | undefined>> {
  const times = new Map<string, number | undefined>();
  const files = pypiReleaseFilesScanner((url, uploadTime) => {
    const key = url === undefined ? undefined : pypiFileKeyFromUrl(url);
    if (key === undefined) return;
    const time = parsePublishTime(uploadTime);
    if (times.has(key)) {
      times.set(key, laterUploadTime(times.get(key), time));
      return;
    }
    if (times.size >= maxFiles) {
      throw new RegistryMetadataError('limit', 'PyPI metadata lists more files than the proxy reads');
    }
    times.set(key, time);
  });
  return jsonReader(files.scanner, () => {
    if (files.rootKind() !== 'object') {
      throw new RegistryMetadataError('malformed', 'package metadata is not a JSON object');
    }
    return times;
  });
}

/**
 * Reads the upload time of exactly one distribution file, the one whose
 * `files.pythonhosted.org` path is `fileKey` (see
 * {@link pypiDistributionFileKey}). Throws `absent` when no release lists it;
 * returns undefined when its record has no valid time.
 */
export function createPypiFileTimeReader(fileKey: string): StreamingMetadataReader<number | undefined> {
  let found = false;
  let time: number | undefined;
  const files = pypiReleaseFilesScanner((url, uploadTime) => {
    if (url === undefined || pypiFileKeyFromUrl(url) !== fileKey) return;
    const observed = parsePublishTime(uploadTime);
    time = found ? laterUploadTime(time, observed) : observed;
    found = true;
  });
  return jsonReader(files.scanner, () => {
    if (files.rootKind() !== 'object') {
      throw new RegistryMetadataError('malformed', 'package metadata is not a JSON object');
    }
    if (!found) throw new RegistryMetadataError('absent', 'requested file is absent from PyPI metadata');
    return time;
  });
}

// ── crates.io ───────────────────────────────────────────────────────

/** Longest sparse-index line read; real lines (one version each) are a few kilobytes. */
export const MAX_CARGO_INDEX_LINE_BYTES = 4 * MIB;

/**
 * Reads one version's `pubtime` from a crates.io sparse-index file
 * (newline-delimited JSON, one version per line). Every line must be a JSON
 * object, and the version may appear once. Throws `absent` when no line lists
 * it; returns undefined when its line has no valid `pubtime`.
 */
export function createCargoVersionTimeReader(
  version: string,
  maxLineBytes = MAX_CARGO_INDEX_LINE_BYTES,
): StreamingMetadataReader<number | undefined> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let found = false;
  let time: number | undefined;

  const readLine = (bytes: Buffer): void => {
    const line = bytes.toString('utf8').trim();
    if (line === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new RegistryMetadataError('malformed', 'Cargo sparse-index line is not valid JSON');
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RegistryMetadataError('malformed', 'Cargo sparse-index line is not a JSON object');
    }
    const record = entry as Record<string, unknown>;
    if (record.vers !== version) return;
    if (found) throw new RegistryMetadataError('malformed', 'package metadata repeated the requested Cargo version');
    found = true;
    time = parsePublishTime(typeof record.pubtime === 'string' ? record.pubtime : undefined);
  };

  const hold = (part: Buffer): void => {
    pendingBytes += part.length;
    if (pendingBytes > maxLineBytes) {
      throw new RegistryMetadataError('limit', 'Cargo sparse-index line is longer than the proxy reads');
    }
    pending.push(part);
  };

  return {
    write(chunk) {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let from = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, from);
        if (newline < 0) break;
        hold(bytes.subarray(from, newline));
        readLine(Buffer.concat(pending, pendingBytes));
        pending = [];
        pendingBytes = 0;
        from = newline + 1;
      }
      if (from < bytes.length) hold(Buffer.from(bytes.subarray(from)));
    },
    finish() {
      if (pendingBytes > 0) readLine(Buffer.concat(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
      if (!found) throw new RegistryMetadataError('absent', 'requested package version is absent from Cargo metadata');
      return time;
    },
  };
}

// ── npm publish-time cache ──────────────────────────────────────────

export interface NpmPublishTimeCacheLimits {
  /** Packages held at once. */
  readonly maxPackages: number;
  /** Versions held at once, across packages. */
  readonly maxVersions: number;
  /** How long an entry is used. */
  readonly ttlMs: number;
}

/**
 * Publish times never change once a version exists (npm refuses to reuse a
 * version number), so an entry stays valid for hours. A version an entry does
 * not list is never decided from it: the caller refetches.
 */
export const DEFAULT_NPM_PUBLISH_TIME_CACHE_LIMITS: NpmPublishTimeCacheLimits = Object.freeze({
  maxPackages: 512,
  maxVersions: 250_000,
  ttlMs: 6 * 60 * 60 * 1000,
});

/**
 * A bounded, least-recently-used cache of npm version-to-publish-time maps
 * per package, so the tarball backstop does not refetch a 30-70 MB packument
 * for each tarball. Eviction only costs a refetch.
 */
export class NpmPublishTimeCache {
  private readonly limits: NpmPublishTimeCacheLimits;
  private readonly entries = new Map<string, { readonly times: NpmPublishTimes; readonly storedAt: number }>();
  private versionCount = 0;

  constructor(
    limits: Partial<NpmPublishTimeCacheLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_NPM_PUBLISH_TIME_CACHE_LIMITS, ...limits };
  }

  /** Packages held now. */
  get size(): number {
    return this.entries.size;
  }

  get(key: string): NpmPublishTimes | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (this.now() - entry.storedAt > this.limits.ttlMs) {
      this.versionCount -= entry.times.versions.size;
      return undefined;
    }
    // Re-insert: the Map's order is the eviction order.
    this.entries.set(key, entry);
    return entry.times;
  }

  set(key: string, times: NpmPublishTimes): void {
    this.delete(key);
    if (times.versions.size > this.limits.maxVersions) return;
    this.entries.set(key, { times, storedAt: this.now() });
    this.versionCount += times.versions.size;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limits.maxPackages && this.versionCount <= this.limits.maxVersions) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.versionCount -= entry.times.versions.size;
  }
}
