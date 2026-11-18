/**
 * Home-level state record: `$IRONCURTAIN_HOME/state.json`.
 *
 *     { "layoutVersion": 1, "lastRunVersion": "0.14.0" }
 *
 * - `layoutVersion` is the on-disk layout generation of the IronCurtain home.
 *   An IronCurtain that finds a newer generation than it supports refuses to
 *   run: it would read, and rewrite, files in a format it does not know. An
 *   older or unrecorded home is brought to the current generation. There are
 *   no migrations yet: generation 1 is the first one recorded and every
 *   earlier home already has its layout, so bringing a home to it only writes
 *   this file. A later generation adds its ordered migration here.
 * - `lastRunVersion` is the IronCurtain version that last ran a command
 *   against this home. When it differs from the running version, the first
 *   command after the upgrade (or downgrade) prints a notice that summarizes
 *   the CHANGELOG's behavior changes in between and suggests
 *   `ironcurtain doctor --upgrade`, then records the running version, so the
 *   notice appears once.
 *
 * Only the CLI entry point writes the file ({@link recordStartupState}).
 * `ironcurtain doctor` reads it ({@link readStateFile},
 * {@link assessStateVersion}) and never writes. Fields this version does not
 * know are kept when the file is rewritten, so a newer version's additions
 * survive a run of an older one with the same layout.
 *
 * Leaf module: Node built-ins, zod and the atomic-write helper only.
 */

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';
import { getIronCurtainHome } from './paths.js';

/** Basename of the state record inside the IronCurtain home. */
export const STATE_FILE_NAME = 'state.json';

/** The home layout generation this IronCurtain reads and writes. */
export const CURRENT_LAYOUT_VERSION = 1;

/** state.json is a few dozen bytes; anything larger is not ours. */
const MAX_STATE_FILE_BYTES = 64 * 1024;

/** At most this many behavior-change lines in the upgrade notice. */
const MAX_NOTICE_CHANGES = 8;

/** Longest behavior-change title shown in the notice. */
const MAX_CHANGE_TITLE_LENGTH = 100;

const stateFileSchema = z
  .object({
    layoutVersion: z.number().int().min(1),
    lastRunVersion: z.string().min(1).max(64),
  })
  .loose();

/** The validated content of state.json (unknown fields kept). */
export type IronCurtainState = z.infer<typeof stateFileSchema>;

/**
 * What {@link readStateFile} found. An invalid record still reports its
 * `layoutVersion` when that field alone is a valid generation: a newer
 * IronCurtain may have changed the other fields, and its layout must be
 * refused, not overwritten, whatever else the record holds.
 */
export type StateFileRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly layoutVersion?: number }
  | { readonly kind: 'present'; readonly state: IronCurtainState };

const layoutVersionSchema = stateFileSchema.shape.layoutVersion;

/** `$IRONCURTAIN_HOME/state.json` for the given home. */
export function getStateFilePath(home: string = getIronCurtainHome()): string {
  return resolve(home, STATE_FILE_NAME);
}

/** Reads and validates state.json. Never throws. */
export function readStateFile(home: string = getIronCurtainHome()): StateFileRead {
  const path = getStateFilePath(home);
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { kind: 'invalid', reason: 'it is not a regular file' };
    if (stats.size > MAX_STATE_FILE_BYTES)
      return { kind: 'invalid', reason: `it is larger than ${MAX_STATE_FILE_BYTES} bytes` };
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'invalid', reason: `it cannot be read (${code ?? String(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'it is not valid JSON' };
  }
  const result = stateFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = `${issue.path.join('.') || 'value'}: ${issue.message}`;
    const layout =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? layoutVersionSchema.safeParse((parsed as { layoutVersion?: unknown }).layoutVersion)
        : undefined;
    return layout?.success === true
      ? { kind: 'invalid', reason, layoutVersion: layout.data }
      : { kind: 'invalid', reason };
  }
  return { kind: 'present', state: result.data };
}

/**
 * True when the home holds anything besides the state record: a home that
 * an earlier IronCurtain (one that wrote no state.json) has used. A missing
 * or empty home is a fresh install.
 */
export function homeHasContent(home: string = getIronCurtainHome()): boolean {
  try {
    return readdirSync(home).some((entry) => entry !== STATE_FILE_NAME && !entry.startsWith(`${STATE_FILE_NAME}.`));
  } catch {
    return false;
  }
}

/** How the running IronCurtain relates to the recorded state. */
export interface StateVersionAssessment {
  /**
   * `newer`: the home has a layout generation this IronCurtain does not
   * support; nothing may run against it. `current`: the layout is this
   * version's. `older`: an earlier generation (or none recorded), which
   * {@link recordStartupState} brings up to date.
   */
  readonly layout: 'current' | 'older' | 'newer';
  readonly recordedLayoutVersion: number | undefined;
  /**
   * `fresh`: a new home (nothing recorded, nothing to upgrade). `same`: last
   * run by this version. `upgraded` / `downgraded`: last run by an older or
   * newer version. `unknown`: used before IronCurtain recorded versions, or
   * the record is unreadable, or a version cannot be compared.
   */
  readonly change: 'fresh' | 'same' | 'upgraded' | 'downgraded' | 'unknown';
  /** The version that last ran, when recorded. */
  readonly previousVersion: string | undefined;
}

/**
 * Compares the recorded state with `currentVersion`. Pure; `hasContent`
 * tells an unrecorded pre-existing home from a fresh one.
 */
export function assessStateVersion(
  read: StateFileRead,
  currentVersion: string,
  hasContent: boolean,
): StateVersionAssessment {
  if (read.kind !== 'present') {
    // An unreadable record is brought up to date, unless the generation it
    // names is newer than this version's: then the record (and the home) is
    // another IronCurtain's, however its other fields look.
    const recorded = read.kind === 'invalid' ? read.layoutVersion : undefined;
    return {
      layout: recorded !== undefined && recorded > CURRENT_LAYOUT_VERSION ? 'newer' : 'older',
      recordedLayoutVersion: recorded,
      change: read.kind === 'absent' && !hasContent ? 'fresh' : 'unknown',
      previousVersion: undefined,
    };
  }
  const { layoutVersion, lastRunVersion } = read.state;
  const layout =
    layoutVersion > CURRENT_LAYOUT_VERSION ? 'newer' : layoutVersion < CURRENT_LAYOUT_VERSION ? 'older' : 'current';
  const order = compareVersions(lastRunVersion, currentVersion);
  const change = order === undefined ? 'unknown' : order === 0 ? 'same' : order < 0 ? 'upgraded' : 'downgraded';
  return { layout, recordedLayoutVersion: layoutVersion, change, previousVersion: lastRunVersion };
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semantic-version precedence of `a` and `b`: negative when `a` is older,
 * zero when equal, positive when newer. Build metadata is ignored and a
 * pre-release ranks below its release. Undefined when either is not a
 * `major.minor.patch` version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = SEMVER_PATTERN.exec(a.trim());
  const right = SEMVER_PATTERN.exec(b.trim());
  if (left === null || right === null) return undefined;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return comparePrerelease(left.at(4), right.at(4));
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) {
    if (a === b) return 0;
    return a === undefined ? 1 : -1;
  }
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left.at(i);
    const y = right.at(i);
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CHANGELOG summary
// ---------------------------------------------------------------------------

/** One released version's "Behavior changes" bullets, by title. */
export interface ChangelogBehaviorChanges {
  readonly version: string;
  readonly changes: readonly string[];
}

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/;

/**
 * The titles of the top-level bullets under each release's
 * `### Behavior changes` heading in CHANGELOG.md, newest release first. A
 * bullet's title is its leading bold text (`- **Title** — details`), or else
 * its first sentence. `[Unreleased]` and malformed headings are skipped.
 */
export function parseChangelogBehaviorChanges(text: string): ChangelogBehaviorChanges[] {
  const releases: { version: string; changes: string[] }[] = [];
  let current: { version: string; changes: string[] } | undefined;
  let inBehaviorChanges = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const match = RELEASE_HEADING.exec(line);
      current = match === null ? undefined : { version: match[1], changes: [] };
      if (current !== undefined) releases.push(current);
      inBehaviorChanges = false;
      continue;
    }
    if (line.startsWith('### ')) {
      inBehaviorChanges = line.slice(4).trim().toLowerCase() === 'behavior changes';
      continue;
    }
    if (current !== undefined && inBehaviorChanges && line.startsWith('- ')) {
      const title = bulletTitle(line.slice(2));
      if (title !== '') current.changes.push(title);
    }
  }
  return releases;
}

function bulletTitle(bullet: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(bullet);
  const title = bold !== null ? bold[1] : (/^(.+?[.!?])(?:\s|$)/.exec(bullet)?.[1] ?? bullet);
  // Markdown code spans and links read fine without their markup.
  const plain = title
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  return plain.length > MAX_CHANGE_TITLE_LENGTH ? `${plain.slice(0, MAX_CHANGE_TITLE_LENGTH - 1)}…` : plain;
}

/**
 * The behavior-change titles of the releases after `fromVersion` up to and
 * including `toVersion`, oldest first, each prefixed with its version
 * (`0.14.0: ...`) when more than one release is listed. Without
 * `fromVersion` (the previous version is unknown) only `toVersion`'s own
 * changes are listed.
 */
export function behaviorChangesBetween(
  releases: readonly ChangelogBehaviorChanges[],
  fromVersion: string | undefined,
  toVersion: string,
): string[] {
  const selected = releases.filter((release) => {
    const upper = compareVersions(release.version, toVersion);
    if (upper === undefined || upper > 0) return false;
    if (fromVersion === undefined) return upper === 0;
    const lower = compareVersions(release.version, fromVersion);
    return lower !== undefined && lower > 0;
  });
  const withChanges = selected.filter((release) => release.changes.length > 0).reverse();
  const prefixed = withChanges.length > 1;
  return withChanges.flatMap((release) =>
    release.changes.map((change) => (prefixed ? `${release.version}: ${change}` : change)),
  );
}

/** CHANGELOG.md of this IronCurtain package (two levels above this module in src/ and dist/). */
export function getPackageChangelogPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CHANGELOG.md');
}

/** The package CHANGELOG's behavior changes, or undefined when it cannot be read. */
export function readPackageChangelog(path: string = getPackageChangelogPath()): ChangelogBehaviorChanges[] | undefined {
  try {
    return parseChangelogBehaviorChanges(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** The command that checks a home after an upgrade. */
export const UPGRADE_CHECK_COMMAND = 'ironcurtain doctor --upgrade';

/**
 * The lines of the first-run-after-upgrade notice, or an empty list when
 * nothing changed (or the home is new). Plain text: the caller writes it to
 * stderr.
 */
export function formatUpgradeNotice(
  assessment: StateVersionAssessment,
  currentVersion: string,
  releases: readonly ChangelogBehaviorChanges[] | undefined,
): string[] {
  if (assessment.change === 'fresh' || assessment.change === 'same') return [];
  const previous = assessment.previousVersion;
  const suggestion =
    `Run \`${UPGRADE_CHECK_COMMAND}\` to check your personas, jobs, workflow runs and policies ` +
    'against this version.';
  if (assessment.change === 'downgraded' && previous !== undefined) {
    return [
      `IronCurtain ${currentVersion} is running on a home last used by IronCurtain ${previous}, a newer version. ` +
        'Files the newer version wrote may not be readable by this one.',
      suggestion,
    ];
  }
  const header =
    assessment.change === 'upgraded' && previous !== undefined
      ? `IronCurtain was upgraded from ${previous} to ${currentVersion}.`
      : `IronCurtain ${currentVersion} is running on a home last used by an earlier version.`;
  const lines = [header];
  const changes =
    releases === undefined
      ? []
      : behaviorChangesBetween(releases, assessment.change === 'upgraded' ? previous : undefined, currentVersion);
  if (changes.length > 0) {
    lines.push(
      assessment.change === 'upgraded' && previous !== undefined
        ? `Behavior changes since ${previous}:`
        : `Behavior changes in ${currentVersion}:`,
    );
    for (const change of changes.slice(0, MAX_NOTICE_CHANGES)) lines.push(`  - ${change}`);
    if (changes.length > MAX_NOTICE_CHANGES) lines.push(`  - and ${changes.length - MAX_NOTICE_CHANGES} more`);
    lines.push('  See CHANGELOG.md for the details.');
  }
  lines.push(suggestion);
  return lines;
}

// ---------------------------------------------------------------------------
// Startup hook
// ---------------------------------------------------------------------------

/** Thrown when the home cannot be used by this IronCurtain. Callers match on `code`. */
export class StateVersionError extends Error {
  readonly code = 'STATE_LAYOUT_TOO_NEW';

  constructor(message: string) {
    super(message);
    this.name = 'StateVersionError';
  }
}

/** The refusal for a home whose layout is newer than this version supports. */
export function describeNewerLayout(
  recordedLayoutVersion: number | undefined,
  currentVersion: string,
  home: string = getIronCurtainHome(),
): string {
  return (
    `The IronCurtain home ${home} has layout version ${String(recordedLayoutVersion)}, newer than ` +
    `the layout version ${CURRENT_LAYOUT_VERSION} that IronCurtain ${currentVersion} supports. It was used by a ` +
    'newer IronCurtain; run that version, or point IRONCURTAIN_HOME at another directory.'
  );
}

/** Options for {@link recordStartupState} (tests inject these). */
export interface StartupStateOptions {
  readonly home?: string;
  readonly currentVersion: string;
  /** Behavior changes for the notice; default: the package CHANGELOG.md. */
  readonly releases?: readonly ChangelogBehaviorChanges[];
}

/**
 * The CLI's startup step: refuses a home with a newer layout
 * ({@link StateVersionError}), returns the upgrade notice lines (empty when
 * there is nothing to say), and records the running version and the current
 * layout generation in state.json, keeping unknown fields. A failed write is
 * ignored: the command still runs, and the notice repeats next time.
 *
 * @throws StateVersionError when the home's layout is newer than supported.
 */
export function recordStartupState(options: StartupStateOptions): string[] {
  const home = options.home ?? getIronCurtainHome();
  const read = readStateFile(home);
  const assessment = assessStateVersion(read, options.currentVersion, homeHasContent(home));
  if (assessment.layout === 'newer') {
    throw new StateVersionError(describeNewerLayout(assessment.recordedLayoutVersion, options.currentVersion, home));
  }
  const notice = formatUpgradeNotice(
    assessment,
    options.currentVersion,
    options.releases ?? (assessment.change === 'fresh' || assessment.change === 'same' ? [] : readPackageChangelog()),
  );
  if (assessment.change !== 'same' || assessment.layout !== 'current') {
    const kept = read.kind === 'present' ? read.state : {};
    const next = { ...kept, layoutVersion: CURRENT_LAYOUT_VERSION, lastRunVersion: options.currentVersion };
    try {
      // A fresh install records its version too; otherwise its second run
      // would look like a home an earlier IronCurtain used.
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(getStateFilePath(home), `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      // Best effort: an unwritable home only means the notice is shown again.
    }
  }
  return notice;
}
