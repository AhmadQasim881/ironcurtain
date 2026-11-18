/**
 * Per-server layering of the user's tool annotations over the package's.
 *
 * Tool annotations are TCB data: the policy engine derives every argument's
 * roles from them. IronCurtain ships reviewed annotations in
 * `<package>/config/generated/tool-annotations.json` (the base). A user's
 * `annotate-tools` run writes `~/.ironcurtain/generated/tool-annotations.json`
 * (the overlay), which holds only the servers that user re-annotated. Both
 * are read like compiled-policy.json (see {@link readToolAnnotationsFile}).
 *
 * Every loader resolves the two files per server with the same rules, so a
 * package annotation fix reaches users who once ran `annotate-tools`, and an
 * overlay that lists one server never drops the others:
 *
 *   1. no overlay entry                          -> package entry
 *   2. no package entry                          -> overlay entry ('user-only')
 *   3. same content as the package entry         -> package entry ('identical')
 *   4. overlay entry pinned                      -> overlay entry ('pinned')
 *   5. content of an earlier shipped revision    -> package entry ('superseded')
 *   6. same inputHash as the package entry       -> package entry ('same-input')
 *   7. otherwise (annotated for other tools)     -> overlay entry ('user')
 *
 * Rules 3, 5 and 6 are also the one-time migration of legacy overlays: before
 * overlays existed, `annotate-tools` copied every package entry into the user
 * file, which then shadowed all later package fixes. Copies of current or
 * earlier package content, and entries for the same tool schemas as the
 * reviewed package entry, give way to the package. `annotate-tools` rewrites
 * the overlay without them (see `src/pipeline/annotation-overlay.ts`).
 *
 * This module is a runtime leaf: it is used by the session/sandbox loaders and
 * must not import from `src/pipeline/` (type-only imports excepted).
 */

import { resolve } from 'node:path';
import type { StoredServerAnnotations, StoredToolAnnotationsFile } from '../pipeline/types.js';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import { policyArtifactEntryExists, readPolicyArtifact } from './policy-artifact-read.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { formatArtifactProblems, toolAnnotationsFileProblems } from '../types/policy-schema.js';
import { isObjectWithProp } from '../utils/is-plain-object.js';

export const TOOL_ANNOTATIONS_FILENAME = 'tool-annotations.json';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `TOOL_ANNOTATIONS_INVALID`: a tool-annotations.json exists but cannot be
 * read safely (a symlink at its name, not a regular file, writable by
 * another local user, owned by an untrusted user), is not JSON, or does not
 * have the expected shape. Callers across module boundaries should test
 * `code`, not `instanceof`.
 */
export const TOOL_ANNOTATIONS_INVALID = 'TOOL_ANNOTATIONS_INVALID';

export class ToolAnnotationsFileError extends Error {
  readonly code = TOOL_ANNOTATIONS_INVALID;
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ToolAnnotationsFileError';
    this.path = path;
  }
}

/**
 * Which file a {@link ToolAnnotationsFileError} is about: the annotations
 * shipped in `packageDir` ('shipped', which only a reinstall repairs) or a
 * user overlay ('overlay', which `annotate-tools --reset` removes). Returns
 * undefined for any other error. Tests the error code, not the class.
 */
export function damagedToolAnnotationsFile(err: unknown, packageDir: string): 'shipped' | 'overlay' | undefined {
  if (!isObjectWithProp(err, 'code') || err.code !== TOOL_ANNOTATIONS_INVALID) return undefined;
  const shippedPath = resolve(packageDir, TOOL_ANNOTATIONS_FILENAME);
  return isObjectWithProp(err, 'path') && err.path === shippedPath ? 'shipped' : 'overlay';
}

/** Hint for a damaged shipped annotations file ({@link damagedToolAnnotationsFile} 'shipped'). */
export const SHIPPED_ANNOTATIONS_DAMAGED_HINT =
  'The tool annotations shipped with IronCurtain are damaged; `annotate-tools --reset` cannot repair them. ' +
  'Reinstall IronCurtain.';

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

/**
 * sha256 (hex) of the canonical JSON of a server's `tools` array. Identifies a
 * revision of annotation content independently of key order and formatting.
 * Unlike `inputHash` (which covers only the annotator's inputs), it changes
 * when roles are edited by hand. Compiled policies record it per server in
 * their provenance (see `src/policy-artifacts/provenance.ts`).
 */
export function computeAnnotationContentDigest(tools: readonly unknown[]): string {
  return canonicalDigest(tools);
}

// ---------------------------------------------------------------------------
// Reading and validation
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingFileError(err: unknown): boolean {
  return isObjectWithProp(err, 'code') && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

/** Quotes an identifier for a message: JSON escapes, then visible escapes for bidi/format characters. */
function quoteForMessage(value: string): string {
  return toDisplayText(JSON.stringify(value));
}

/**
 * Checks the file against the runtime schema (`src/types/policy-schema.ts`):
 * every server entry and its provenance fields, and every tool annotation
 * down to each argument's roles, which must be registered roles (static
 * arrays, or conditional blocks whose conditions name another argument of
 * the tool). The engine derives each argument's roles from these entries,
 * so a misspelled role or condition must stop policy loading.
 */
function validateToolAnnotationsFile(value: unknown, path: string): asserts value is StoredToolAnnotationsFile {
  const problems = toolAnnotationsFileProblems(value);
  if (problems.length > 0) {
    throw new ToolAnnotationsFileError(
      path,
      formatArtifactProblems(`${path} is not a valid tool annotations file`, problems),
    );
  }
}

/** How the hardened read names a tool-annotations.json in its messages. */
const TOOL_ANNOTATIONS_LABEL = 'Tool annotations file';

/**
 * Reads and validates a tool-annotations.json file. Returns undefined when
 * nothing is at `path`. Throws {@link ToolAnnotationsFileError} when it
 * exists but is unreadable, not JSON, or malformed: a damaged annotations
 * file must stop policy loading rather than silently change which
 * annotations apply.
 *
 * The annotations assign every argument's roles, so they are read like the
 * other policy artifacts (`readPolicyArtifact`): a symlink at the name (a
 * dangling one too, which is not "missing" and so never makes a loader fall
 * back to the package file), anything but a regular file, and a file another
 * local user can write are refused, the last with the `chmod` that fixes it.
 */
export function readToolAnnotationsFile(path: string): StoredToolAnnotationsFile | undefined {
  let text: string;
  try {
    if (!policyArtifactEntryExists(path)) return undefined;
    text = readPolicyArtifact(path, TOOL_ANNOTATIONS_LABEL);
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw new ToolAnnotationsFileError(path, `Cannot read ${path}: ${describeError(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ToolAnnotationsFileError(path, `${path} is not valid JSON: ${describeError(err)}`);
  }
  validateToolAnnotationsFile(parsed, path);
  return parsed;
}

// ---------------------------------------------------------------------------
// Per-server resolution
// ---------------------------------------------------------------------------

/** How a server present in the overlay was resolved (see the module comment). */
export type OverlayResolution = 'user-only' | 'identical' | 'pinned' | 'superseded' | 'same-input' | 'user';

/** Resolutions under which the overlay entry, not the package entry, is in effect. */
export function isOverlayEntryInEffect(resolution: OverlayResolution): boolean {
  return resolution === 'user-only' || resolution === 'pinned' || resolution === 'user';
}

/** An overlay entry without `source: 'user'`: written before overlays existed (or by hand). */
export function isLegacyOverlayEntry(entry: StoredServerAnnotations): boolean {
  return entry.source !== 'user';
}

/**
 * Applies rules 2-7 of the module comment to one server. `packageEntry` is
 * undefined when the package does not ship the server.
 */
export function resolveServerOverlay(
  packageEntry: StoredServerAnnotations | undefined,
  overlayEntry: StoredServerAnnotations,
): OverlayResolution {
  if (!packageEntry) return 'user-only';
  const overlayDigest = computeAnnotationContentDigest(overlayEntry.tools);
  if (overlayDigest === computeAnnotationContentDigest(packageEntry.tools)) return 'identical';
  if (overlayEntry.pinned === true) return 'pinned';
  if (packageEntry.supersededDigests?.includes(overlayDigest)) return 'superseded';
  if (overlayEntry.inputHash === packageEntry.inputHash) return 'same-input';
  return 'user';
}

export interface ServerOverlayDecision {
  readonly server: string;
  readonly resolution: OverlayResolution;
  /** The overlay entry carries no provenance (see {@link isLegacyOverlayEntry}). */
  readonly legacy: boolean;
}

export interface MergedToolAnnotations {
  readonly annotations: StoredToolAnnotationsFile;
  /** One decision per overlay server, sorted by server name. */
  readonly decisions: ServerOverlayDecision[];
}

function entryOf(file: StoredToolAnnotationsFile | undefined, server: string): StoredServerAnnotations | undefined {
  return file && Object.hasOwn(file.servers, server) ? file.servers[server] : undefined;
}

/**
 * Merges an overlay into the package base, server by server. Servers only in
 * the base keep the base entry; servers only in the overlay keep theirs.
 * Neither input is modified.
 */
export function mergeToolAnnotationOverlay(
  base: StoredToolAnnotationsFile | undefined,
  overlay: StoredToolAnnotationsFile,
): MergedToolAnnotations {
  const servers: Array<[string, StoredServerAnnotations]> = [];
  const decisions: ServerOverlayDecision[] = [];
  for (const [server, packageEntry] of Object.entries(base?.servers ?? {})) {
    const overlayEntry = entryOf(overlay, server);
    if (!overlayEntry) {
      servers.push([server, packageEntry]);
      continue;
    }
    const resolution = resolveServerOverlay(packageEntry, overlayEntry);
    decisions.push({ server, resolution, legacy: isLegacyOverlayEntry(overlayEntry) });
    servers.push([server, isOverlayEntryInEffect(resolution) ? overlayEntry : packageEntry]);
  }
  for (const [server, overlayEntry] of Object.entries(overlay.servers)) {
    if (entryOf(base, server)) continue;
    decisions.push({ server, resolution: 'user-only', legacy: isLegacyOverlayEntry(overlayEntry) });
    servers.push([server, overlayEntry]);
  }
  decisions.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  return {
    annotations: {
      generatedAt: base?.generatedAt ?? overlay.generatedAt,
      // fromEntries defines own properties, so a server named "__proto__" stays data.
      servers: Object.fromEntries(servers),
    },
    decisions,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface ToolAnnotationsOverlayReport {
  /** The overlay file that was layered over the package base, if any. */
  readonly overlayPath?: string;
  /** One decision per overlay server; empty when there is no overlay. */
  readonly decisions: readonly ServerOverlayDecision[];
}

export interface LoadedToolAnnotations {
  readonly annotations: StoredToolAnnotationsFile;
  readonly overlay: ToolAnnotationsOverlayReport;
}

/**
 * Loads the effective tool annotations.
 *
 * `dir` is the annotations directory in use (normally the user generated dir
 * when the user has an overlay, otherwise the package dir). When `packageDir`
 * is given and differs from `dir`, the file in `dir` is an overlay layered
 * over the package file per server; otherwise the file in `dir` is used as is.
 *
 * Returns undefined when no annotations file exists at all. Throws
 * {@link ToolAnnotationsFileError} for an unreadable or malformed file.
 */
export function loadToolAnnotations(dir: string, packageDir?: string): LoadedToolAnnotations | undefined {
  const primaryPath = resolve(dir, TOOL_ANNOTATIONS_FILENAME);
  if (packageDir === undefined || resolve(packageDir) === resolve(dir)) {
    const file = readToolAnnotationsFile(primaryPath);
    return file ? { annotations: file, overlay: { decisions: [] } } : undefined;
  }
  const overlay = readToolAnnotationsFile(primaryPath);
  const base = readToolAnnotationsFile(resolve(packageDir, TOOL_ANNOTATIONS_FILENAME));
  if (!overlay) {
    return base ? { annotations: base, overlay: { decisions: [] } } : undefined;
  }
  const merged = mergeToolAnnotationOverlay(base, overlay);
  return { annotations: merged.annotations, overlay: { overlayPath: primaryPath, decisions: merged.decisions } };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** A server name as it should appear in a suggested command line. */
export function serverNameForCommand(server: string): string {
  return /^[A-Za-z0-9._-]+$/.test(server) ? server : quoteForMessage(server);
}

/**
 * Human-readable warnings for overlay entries that change which annotations
 * apply in a way the user may not expect:
 *   - a pinned entry overriding the package's reviewed annotations,
 *   - a legacy entry (written before overlays existed) overriding them,
 *   - a user entry being ignored because the package ships reviewed
 *     annotations for the same tools.
 * Stale copies of package content resolve to the package silently.
 */
export function describeOverlayWarnings(report: ToolAnnotationsOverlayReport): string[] {
  const where = report.overlayPath ? toDisplayText(report.overlayPath) : 'the user tool annotations';
  const lines: string[] = [];
  for (const { server, resolution, legacy } of report.decisions) {
    const name = quoteForMessage(server);
    const arg = serverNameForCommand(server);
    const reset = `\`ironcurtain annotate-tools --reset --server ${arg}\``;
    if (resolution === 'pinned') {
      lines.push(
        `Warning: your pinned tool annotations for ${name} (${where}) override the reviewed annotations ` +
          `shipped with IronCurtain. Run ${reset} to use the shipped ones.`,
      );
    } else if (resolution === 'user' && legacy) {
      lines.push(
        `Warning: tool annotations for ${name} in ${where} were written by an older annotate-tools and ` +
          `override the reviewed annotations shipped with IronCurtain. Run ` +
          `\`ironcurtain annotate-tools --server ${arg}\` to re-check them against the live server, ` +
          `or ${reset} to use the shipped ones.`,
      );
    } else if (resolution === 'same-input') {
      lines.push(
        `Note: ignoring your tool annotations for ${name} in ${where}: IronCurtain ships reviewed ` +
          `annotations for the same tools. Run \`ironcurtain annotate-tools --server ${arg} --pin\` ` +
          `to keep yours, or ${reset} to remove them.`,
      );
    }
  }
  return lines;
}

/** Writes {@link describeOverlayWarnings} to stderr (or `write`). */
export function warnOnAnnotationOverlay(
  report: ToolAnnotationsOverlayReport,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  for (const line of describeOverlayWarnings(report)) write(`${line}\n`);
}
