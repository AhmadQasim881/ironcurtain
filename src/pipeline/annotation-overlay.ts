/**
 * Write side of the tool-annotation overlay (offline tooling only).
 *
 * The user's `~/.ironcurtain/generated/tool-annotations.json` holds only the
 * servers the user re-annotated; every loader layers it per server over the
 * package annotations (`config/tool-annotations-overlay.ts` defines the
 * resolution rules). This module is what `annotate-tools` uses to keep the
 * overlay in that shape:
 *
 *   - {@link migrateOverlay} drops entries the loaders would not use (stale
 *     copies of package content and entries for the same tools as a reviewed
 *     package entry) and stamps the rest with provenance;
 *   - {@link planServerAnnotation} decides, for one live server, whether to
 *     adopt the package entry, keep the cached user entry, or call the LLM
 *     ({@link updateAnnotationOverlay} runs it for every live server, keeps a
 *     server's entry when annotating it fails, and checkpoints the overlay
 *     after each server);
 *   - {@link resetToolAnnotationsOverlay} implements `--reset`;
 *   - {@link stampPackageAnnotations} / {@link promoteOverlayEntries} maintain
 *     the provenance of the bundled package file for developers
 *     (`scripts/stamp-package-annotations.ts`).
 */

import { constants, copyFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  computeAnnotationContentDigest,
  isLegacyOverlayEntry,
  isOverlayEntryInEffect,
  readToolAnnotationsFile,
  resolveServerOverlay,
  TOOL_ANNOTATIONS_FILENAME,
  type OverlayResolution,
  type ServerOverlayDecision,
} from '../config/tool-annotations-overlay.js';
import { removeArtifactIfExists, writeArtifact } from './pipeline-shared.js';
import type { StoredServerAnnotations, StoredToolAnnotation, StoredToolAnnotationsFile } from './types.js';

/**
 * Copy of a legacy (pre-overlay) user annotations file, written once before
 * `annotate-tools` first rewrites it. Never overwritten.
 */
export const LEGACY_OVERLAY_BACKUP_FILENAME = 'tool-annotations.pre-overlay.json';

function entryOf(file: StoredToolAnnotationsFile | undefined, server: string): StoredServerAnnotations | undefined {
  return file && Object.hasOwn(file.servers, server) ? file.servers[server] : undefined;
}

// ---------------------------------------------------------------------------
// Entry stamping
// ---------------------------------------------------------------------------

/** The identity a live server reported at `initialize`. */
export type ServerInfo = NonNullable<StoredServerAnnotations['serverInfo']>;

/**
 * Returns `entry` as a stamped user overlay entry: `source: 'user'`, a fresh
 * `contentDigest`, and no package-only fields. `producerVersion`, `pinned`
 * and `serverInfo` are taken from `opts` when given, otherwise kept from
 * `entry`.
 */
export function stampUserEntry(
  entry: Pick<StoredServerAnnotations, 'inputHash' | 'tools' | 'producerVersion' | 'pinned' | 'serverInfo'>,
  opts: { readonly producerVersion?: string; readonly pinned?: boolean; readonly serverInfo?: ServerInfo } = {},
): StoredServerAnnotations {
  const producerVersion = opts.producerVersion ?? entry.producerVersion;
  const pinned = opts.pinned ?? entry.pinned === true;
  const serverInfo = opts.serverInfo ?? entry.serverInfo;
  return {
    inputHash: entry.inputHash,
    contentDigest: computeAnnotationContentDigest(entry.tools),
    source: 'user',
    ...(producerVersion !== undefined ? { producerVersion } : {}),
    ...(pinned ? { pinned: true } : {}),
    ...(serverInfo !== undefined ? { serverInfo } : {}),
    tools: entry.tools,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface OverlayMigration {
  /** The overlay with only the entries the loaders use, stamped. */
  readonly overlay: StoredToolAnnotationsFile;
  /** Entries removed because the package entry applies instead. */
  readonly dropped: readonly ServerOverlayDecision[];
  /**
   * Legacy entries kept because they genuinely differ from the package's
   * (annotated for other tool schemas, or pinned by hand). They override
   * the package's reviewed annotations, so callers warn about them.
   */
  readonly keptDivergentLegacy: readonly string[];
  /** The input had at least one legacy (unstamped) entry. */
  readonly hadLegacyEntries: boolean;
}

/**
 * Rewrites an overlay into the shape the loaders expect: entries the loaders
 * would ignore are dropped (rules 'identical', 'superseded' and 'same-input'
 * of `config/tool-annotations-overlay.ts`), pinned entries are always kept,
 * and every kept entry is stamped (see {@link stampUserEntry}).
 *
 * Applied on every `annotate-tools` write, this is the one-time migration of
 * legacy full snapshots; on an already migrated overlay it changes nothing
 * the loaders can observe.
 */
export function migrateOverlay(
  overlay: StoredToolAnnotationsFile | undefined,
  base: StoredToolAnnotationsFile | undefined,
): OverlayMigration {
  const kept: Array<[string, StoredServerAnnotations]> = [];
  const dropped: ServerOverlayDecision[] = [];
  const keptDivergentLegacy: string[] = [];
  let hadLegacyEntries = false;
  for (const [server, entry] of Object.entries(overlay?.servers ?? {})) {
    const legacy = isLegacyOverlayEntry(entry);
    hadLegacyEntries ||= legacy;
    const resolution = resolveServerOverlay(entryOf(base, server), entry);
    if (entry.pinned === true || isOverlayEntryInEffect(resolution)) {
      kept.push([server, stampUserEntry(entry)]);
      if (legacy && (resolution === 'user' || resolution === 'pinned')) keptDivergentLegacy.push(server);
    } else {
      dropped.push({ server, resolution, legacy });
    }
  }
  return {
    overlay: {
      generatedAt: overlay?.generatedAt ?? new Date().toISOString(),
      servers: Object.fromEntries(kept),
    },
    dropped,
    keptDivergentLegacy,
    hadLegacyEntries,
  };
}

// ---------------------------------------------------------------------------
// Per-server annotate decision
// ---------------------------------------------------------------------------

export type ServerAnnotationPlan =
  /** The package ships reviewed annotations for exactly the live tools: use them, drop any overlay entry. */
  | { readonly kind: 'adopt-package' }
  /** The (migrated) overlay entry was produced for exactly the live tools: keep it. */
  | { readonly kind: 'cached'; readonly entry: StoredServerAnnotations }
  /** Neither matches the live tools: annotate with the LLM. */
  | { readonly kind: 'annotate' };

/**
 * Decides how `annotate-tools` handles one connected server.
 *
 * When the package entry was produced for the live tools (same inputHash),
 * its reviewed annotations win over both a cached user entry and a new LLM
 * result. Only a pinned overlay entry, or `--pin`, keeps the user's own
 * annotations in that case.
 *
 * `overlayEntry` must come from a migrated overlay ({@link migrateOverlay}),
 * so it is never a stale copy of package content.
 */
export function planServerAnnotation(opts: {
  readonly liveHash: string;
  readonly packageEntry: StoredServerAnnotations | undefined;
  readonly overlayEntry: StoredServerAnnotations | undefined;
  readonly pin: boolean;
}): ServerAnnotationPlan {
  const pinned = opts.pin || opts.overlayEntry?.pinned === true;
  if (!pinned && opts.packageEntry?.inputHash === opts.liveHash) return { kind: 'adopt-package' };
  if (opts.overlayEntry?.inputHash === opts.liveHash) return { kind: 'cached', entry: opts.overlayEntry };
  return { kind: 'annotate' };
}

/**
 * What `annotate-tools` did for one live server. 'failed': annotating it
 * threw (an LLM or network error, repairs exhausted, tools left
 * unannotated); its previous overlay entry, if any, is kept unchanged.
 */
export type ServerAnnotationOutcome = 'adopted-package' | 'cached' | 'annotated' | 'failed';

export interface OverlayUpdateResult {
  /** The overlay to write: migrated, with the live servers' results applied. */
  readonly overlay: StoredToolAnnotationsFile;
  readonly migration: OverlayMigration;
  /** What happened to each live server, in input order. */
  readonly outcomes: ReadonlyArray<{
    readonly server: string;
    readonly outcome: ServerAnnotationOutcome;
    /** A user entry for this server was replaced by the package's (adopted-package only). */
    readonly replacedUserEntry: boolean;
    /** Why annotating the server failed ('failed' only). */
    readonly error?: string;
  }>;
  /** Overlay entries dropped because their server is no longer configured (`--all` only). */
  readonly orphansDropped: readonly string[];
  /**
   * The migration's {@link OverlayMigration.keptDivergentLegacy} entries that
   * are still in the overlay unchanged after this run (a live server may have
   * adopted the package entry or been re-annotated instead).
   */
  readonly keptDivergentLegacy: readonly string[];
}

/**
 * The previous annotations of a server that the annotator may reuse for its
 * unchanged tools, in priority order: the reviewed package entry first and
 * the user's own entry second, or the other way round when the user's entry
 * is pinned (as {@link planServerAnnotation} prefers whole entries).
 */
export function reusableAnnotations(opts: {
  readonly packageEntry: StoredServerAnnotations | undefined;
  readonly overlayEntry: StoredServerAnnotations | undefined;
  readonly pinned: boolean;
}): ReadonlyArray<readonly StoredToolAnnotation[]> {
  const ordered = opts.pinned ? [opts.overlayEntry, opts.packageEntry] : [opts.packageEntry, opts.overlayEntry];
  return ordered.flatMap((entry) => (entry ? [entry.tools] : []));
}

/**
 * The overlay update performed by `annotate-tools`, minus MCP and LLM I/O:
 * migrates the existing overlay, applies {@link planServerAnnotation} to each
 * live server and calls `annotate` only for servers that need the LLM, with
 * the previous annotations it may reuse ({@link reusableAnnotations}).
 *
 * A server whose `annotate` call throws is recorded as 'failed' and keeps its
 * migrated overlay entry (or, without one, the package entry stays in
 * effect); `--pin` pins only what a run produces, so a failed run leaves that
 * entry unpinned unless the user had pinned it before. The other servers are
 * still processed. `onCheckpoint` receives the overlay after each live
 * server, so the caller can write it and keep the results of servers already
 * annotated when a later one fails or the run is interrupted.
 *
 * Servers that are not live (not requested, or failed to connect) keep their
 * migrated overlay entry. With `configuredServers` (`--all`), entries for
 * servers outside that set are dropped.
 */
export async function updateAnnotationOverlay<T>(opts: {
  readonly overlay: StoredToolAnnotationsFile | undefined;
  readonly base: StoredToolAnnotationsFile | undefined;
  /**
   * The connected servers: the annotator's hash of their live tools, the
   * tools themselves, and the identity each reported at `initialize` (kept
   * on the entry so drift reports can name the annotated release).
   */
  readonly live: ReadonlyMap<
    string,
    { readonly liveHash: string; readonly tools: T; readonly serverInfo?: ServerInfo }
  >;
  readonly pin: boolean;
  readonly producerVersion: string;
  readonly configuredServers?: ReadonlySet<string>;
  readonly annotate: (
    server: string,
    tools: T,
    previous: ReadonlyArray<readonly StoredToolAnnotation[]>,
  ) => Promise<StoredServerAnnotations['tools']>;
  readonly onPlan?: (server: string, plan: ServerAnnotationPlan) => void;
  /** Called with the overlay so far after each live server (orphans not yet dropped). */
  readonly onCheckpoint?: (overlay: StoredToolAnnotationsFile) => void;
}): Promise<OverlayUpdateResult> {
  // `--pin` keeps the user's existing entry for the live servers even where
  // migration would drop it ('same-input'): pin first, then migrate.
  const overlayToMigrate =
    opts.pin && opts.overlay
      ? {
          ...opts.overlay,
          servers: Object.fromEntries(
            Object.entries(opts.overlay.servers).map(([server, entry]): [string, StoredServerAnnotations] => [
              server,
              opts.live.has(server) ? { ...entry, pinned: true } : entry,
            ]),
          ),
        }
      : opts.overlay;
  const migration = migrateOverlay(overlayToMigrate, opts.base);
  const servers = new Map(Object.entries(migration.overlay.servers));
  const outcomes: Array<OverlayUpdateResult['outcomes'][number]> = [];
  const snapshot = (): StoredToolAnnotationsFile => ({
    generatedAt: new Date().toISOString(),
    servers: Object.fromEntries(servers),
  });

  for (const [server, { liveHash, tools, serverInfo }] of opts.live) {
    const existing = servers.get(server);
    const packageEntry = entryOf(opts.base, server);
    const plan = planServerAnnotation({ liveHash, packageEntry, overlayEntry: existing, pin: opts.pin });
    opts.onPlan?.(server, plan);
    switch (plan.kind) {
      case 'adopt-package':
        servers.delete(server);
        outcomes.push({ server, outcome: 'adopted-package', replacedUserEntry: existing !== undefined });
        break;
      case 'cached':
        // Same tools as before: keep the annotations, refresh the recorded
        // server identity (the release may have changed without its tools).
        servers.set(server, stampUserEntry(plan.entry, { pinned: opts.pin || plan.entry.pinned === true, serverInfo }));
        outcomes.push({ server, outcome: 'cached', replacedUserEntry: false });
        break;
      case 'annotate': {
        const pinned = opts.pin || existing?.pinned === true;
        let annotated: StoredServerAnnotations['tools'];
        try {
          annotated = await opts.annotate(
            server,
            tools,
            reusableAnnotations({ packageEntry, overlayEntry: existing, pinned }),
          );
        } catch (err) {
          // Keep what is in effect for this server and go on with the others.
          // `--pin` pins the annotations a run produces; a failed run takes
          // back the pin it put on the server's earlier entry, so that entry
          // is exactly as effective as before (one the loaders ignored for a
          // reviewed package entry stays ignored instead of overriding it).
          if (existing && opts.pin && entryOf(opts.overlay, server)?.pinned !== true) {
            servers.set(server, stampUserEntry(existing, { pinned: false }));
          }
          outcomes.push({
            server,
            outcome: 'failed',
            replacedUserEntry: false,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        servers.set(
          server,
          stampUserEntry(
            { inputHash: liveHash, tools: annotated, serverInfo },
            { producerVersion: opts.producerVersion, pinned },
          ),
        );
        outcomes.push({ server, outcome: 'annotated', replacedUserEntry: false });
        break;
      }
    }
    opts.onCheckpoint?.(snapshot());
  }

  const orphansDropped: string[] = [];
  if (opts.configuredServers) {
    for (const server of [...servers.keys()]) {
      if (opts.configuredServers.has(server)) continue;
      servers.delete(server);
      orphansDropped.push(server);
    }
  }

  // A cached or failed server keeps its entry as it was (a failed `--pin`
  // run unpins it again, so it may no longer override the package entry).
  const replaced = new Set(
    outcomes.filter((o) => o.outcome === 'adopted-package' || o.outcome === 'annotated').map((o) => o.server),
  );
  const overridesPackage = (server: string): boolean => {
    const entry = servers.get(server);
    return entry !== undefined && isOverlayEntryInEffect(resolveServerOverlay(entryOf(opts.base, server), entry));
  };
  return {
    overlay: { generatedAt: new Date().toISOString(), servers: Object.fromEntries(servers) },
    migration,
    outcomes,
    orphansDropped,
    keptDivergentLegacy: migration.keptDivergentLegacy.filter(
      (server) => !replaced.has(server) && overridesPackage(server),
    ),
  };
}

// ---------------------------------------------------------------------------
// Overlay file I/O
// ---------------------------------------------------------------------------

/**
 * Copies the overlay file to {@link LEGACY_OVERLAY_BACKUP_FILENAME} unless a
 * backup already exists. Returns the backup path when one was written.
 */
export function backupLegacyOverlay(overlayDir: string): string | undefined {
  const backupPath = resolve(overlayDir, LEGACY_OVERLAY_BACKUP_FILENAME);
  try {
    copyFileSync(resolve(overlayDir, TOOL_ANNOTATIONS_FILENAME), backupPath, constants.COPYFILE_EXCL);
    return backupPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
}

/**
 * Writes the overlay atomically, or removes the file when the overlay has no
 * servers left (the package annotations then apply unchanged).
 */
export function writeToolAnnotationsOverlay(
  overlayDir: string,
  overlay: StoredToolAnnotationsFile,
): 'written' | 'removed' {
  if (Object.keys(overlay.servers).length === 0) {
    removeArtifactIfExists(overlayDir, TOOL_ANNOTATIONS_FILENAME);
    return 'removed';
  }
  writeArtifact(overlayDir, TOOL_ANNOTATIONS_FILENAME, overlay);
  return 'written';
}

export interface OverlayResetOutcome {
  readonly overlayPath: string;
  /** False when there was no overlay file (nothing to reset). */
  readonly overlayExisted: boolean;
  /** Servers removed because the reset named them (all servers for a full reset). */
  readonly removed: readonly string[];
  /** The migration applied to the remaining entries (per-server reset only). */
  readonly migration?: OverlayMigration;
  /** Set when a legacy overlay was backed up before being rewritten. */
  readonly backupPath?: string;
  readonly result: 'written' | 'removed' | 'unchanged';
}

/**
 * `annotate-tools --reset [--server <name>]`: removes the user's annotations
 * for one server (or the whole overlay) so the package annotations apply.
 *
 * A full reset deletes the file without parsing it, so it also recovers from
 * a damaged overlay. A per-server reset rewrites the rest of the overlay
 * through {@link migrateOverlay}. A legacy overlay is backed up first.
 */
export function resetToolAnnotationsOverlay(opts: {
  readonly overlayDir: string;
  readonly packageDir: string;
  readonly server?: string;
}): OverlayResetOutcome {
  const overlayPath = resolve(opts.overlayDir, TOOL_ANNOTATIONS_FILENAME);
  // lstat, not existsSync: a dangling symlink at the name is an overlay that
  // sessions refuse, and removing it is what the reset is for.
  if (lstatSync(overlayPath, { throwIfNoEntry: false }) === undefined) {
    return { overlayPath, overlayExisted: false, removed: [], result: 'unchanged' };
  }

  if (opts.server === undefined) {
    let overlay: StoredToolAnnotationsFile | undefined;
    try {
      overlay = readToolAnnotationsFile(overlayPath);
    } catch {
      overlay = undefined; // damaged: removing it is the point of the reset
    }
    const legacy = overlay !== undefined && Object.values(overlay.servers).some(isLegacyOverlayEntry);
    const backupPath = legacy ? backupLegacyOverlay(opts.overlayDir) : undefined;
    removeArtifactIfExists(opts.overlayDir, TOOL_ANNOTATIONS_FILENAME);
    return {
      overlayPath,
      overlayExisted: true,
      removed: overlay ? Object.keys(overlay.servers).sort() : [],
      ...(backupPath ? { backupPath } : {}),
      result: 'removed',
    };
  }

  const overlay = readToolAnnotationsFile(overlayPath);
  if (!overlay || !Object.hasOwn(overlay.servers, opts.server)) {
    return { overlayPath, overlayExisted: overlay !== undefined, removed: [], result: 'unchanged' };
  }
  const base = readToolAnnotationsFile(resolve(opts.packageDir, TOOL_ANNOTATIONS_FILENAME));
  const remaining: StoredToolAnnotationsFile = {
    ...overlay,
    servers: Object.fromEntries(Object.entries(overlay.servers).filter(([name]) => name !== opts.server)),
  };
  const migration = migrateOverlay(remaining, base);
  const backupPath = Object.values(overlay.servers).some(isLegacyOverlayEntry)
    ? backupLegacyOverlay(opts.overlayDir)
    : undefined;
  const result = writeToolAnnotationsOverlay(opts.overlayDir, migration.overlay);
  return {
    overlayPath,
    overlayExisted: true,
    removed: [opts.server],
    migration,
    ...(backupPath ? { backupPath } : {}),
    result,
  };
}

// ---------------------------------------------------------------------------
// Package file maintenance (developers)
// ---------------------------------------------------------------------------

/**
 * Re-stamps the bundled package annotations after their content changed.
 *
 * For every server whose content no longer matches its recorded
 * `contentDigest` (a hand edit, a re-annotation or a promoted overlay entry),
 * the recorded digest moves into `supersededDigests` and `producerVersion`
 * becomes `producerVersion`. User overlays that still hold a copy of the
 * previous revision then resolve to the new one ('superseded') instead of
 * shadowing it. Idempotent: a stamped file is returned unchanged.
 *
 * Throws when an entry is stamped `source: 'user'`: the file is (part of) a
 * user overlay copied over the package file. An overlay lists only the
 * servers its user re-annotated and carries no `supersededDigests`, so
 * stamping it as the package would silently drop the other servers and the
 * revision history that lets legacy user snapshots resolve to the package.
 */
export function stampPackageAnnotations(
  file: StoredToolAnnotationsFile,
  producerVersion: string,
): { readonly file: StoredToolAnnotationsFile; readonly changed: readonly string[] } {
  const userEntries = Object.entries(file.servers)
    .filter(([, entry]) => entry.source === 'user')
    .map(([server]) => JSON.stringify(server));
  if (userEntries.length > 0) {
    throw new Error(
      `Refusing to stamp user overlay entries as package annotations: ${userEntries.join(', ')}. ` +
        'Restore the package file (e.g. `git checkout src/config/generated/tool-annotations.json`) and ' +
        'promote reviewed overlay entries with `--from <overlay> --server <name>`.',
    );
  }
  const changed: string[] = [];
  const servers: Array<[string, StoredServerAnnotations]> = [];
  for (const [server, entry] of Object.entries(file.servers)) {
    const digest = computeAnnotationContentDigest(entry.tools);
    const superseded = new Set(entry.supersededDigests ?? []);
    let version = entry.producerVersion;
    if (entry.contentDigest !== digest) {
      if (entry.contentDigest !== undefined) superseded.add(entry.contentDigest);
      version = producerVersion;
      changed.push(server);
    }
    // A revision that is current again (a revert) is not superseded.
    superseded.delete(digest);
    servers.push([
      server,
      {
        inputHash: entry.inputHash,
        contentDigest: digest,
        source: 'package',
        ...(version !== undefined ? { producerVersion: version } : {}),
        ...(superseded.size > 0 ? { supersededDigests: [...superseded] } : {}),
        ...(entry.serverInfo !== undefined ? { serverInfo: entry.serverInfo } : {}),
        tools: entry.tools,
      },
    ]);
  }
  return { file: { ...file, servers: Object.fromEntries(servers) }, changed };
}

/**
 * Copies reviewed overlay entries into the package file (all overlay servers,
 * or only `servers`), then re-stamps it. The replaced package revision is
 * recorded as superseded. Throws when a requested server is not in the overlay.
 */
export function promoteOverlayEntries(
  packageFile: StoredToolAnnotationsFile,
  overlay: StoredToolAnnotationsFile,
  producerVersion: string,
  servers?: readonly string[],
): {
  readonly file: StoredToolAnnotationsFile;
  readonly promoted: readonly string[];
  readonly changed: readonly string[];
} {
  const selected = servers ?? Object.keys(overlay.servers);
  const replacements = new Map<string, StoredServerAnnotations>();
  for (const server of selected) {
    const overlayEntry = entryOf(overlay, server);
    if (!overlayEntry) throw new Error(`Server ${JSON.stringify(server)} is not in the overlay`);
    const previous = entryOf(packageFile, server);
    replacements.set(server, {
      inputHash: overlayEntry.inputHash,
      // Keep the previous revision's digest so stamping records it as superseded.
      ...(previous?.contentDigest !== undefined ? { contentDigest: previous.contentDigest } : {}),
      ...(previous?.supersededDigests ? { supersededDigests: previous.supersededDigests } : {}),
      ...(overlayEntry.serverInfo !== undefined ? { serverInfo: overlayEntry.serverInfo } : {}),
      tools: overlayEntry.tools,
    });
  }
  // Existing servers keep their position; new servers are appended.
  const mergedEntries = [
    ...Object.entries(packageFile.servers).map(([name, entry]): [string, StoredServerAnnotations] => [
      name,
      replacements.get(name) ?? entry,
    ]),
    ...[...replacements].filter(([name]) => !Object.hasOwn(packageFile.servers, name)),
  ];
  const stamped = stampPackageAnnotations(
    { ...packageFile, servers: Object.fromEntries(mergedEntries) },
    producerVersion,
  );
  return { file: stamped.file, promoted: [...selected], changed: stamped.changed };
}

/** Human-readable reasons for {@link OverlayMigration.dropped} entries. */
export function describeDroppedEntry(resolution: OverlayResolution): string {
  switch (resolution) {
    case 'identical':
      return 'identical to the shipped annotations';
    case 'superseded':
      return 'copy of an earlier shipped revision';
    case 'same-input':
      return 'differs from the shipped annotations for the same tools';
    default:
      return resolution;
  }
}
