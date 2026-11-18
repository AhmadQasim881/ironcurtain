/**
 * The shipped CHANGELOG.md, read the way the upgrade notice reads it
 * (`parseChangelogBehaviorChanges` in src/config/state-version.ts).
 *
 * The first command after an upgrade, and `ironcurtain doctor --upgrade`,
 * print the titles of the `### Behavior changes` bullets of every release
 * since the version that last ran. The parser skips `[Unreleased]`: its
 * bullets reach users when a release renames that heading to the new
 * version. So the test renames it the way a release does and checks what the
 * next version's users would be shown. The checks are about the format the
 * notice depends on (`- **Title** — details`), never about what a bullet
 * says, so editing, adding or removing bullets does not break them.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  behaviorChangesBetween,
  compareVersions,
  getPackageChangelogPath,
  parseChangelogBehaviorChanges,
} from '../src/config/state-version.js';
import { VERSION } from '../src/version.js';

const CHANGELOG = readFileSync(getPackageChangelogPath(), 'utf-8');

/** Longest title the parser keeps whole: a longer one is cut to this length, ending in an ellipsis. */
const TITLE_LIMIT = 100;

const UNRELEASED_HEADING = '## [Unreleased]';

/** A `## [x.y.z]` release heading, as the parser recognizes it. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/;

/** The version the next release gets at the least: the running version's next minor release. */
function nextMinorVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (match === null) throw new Error(`not a release version: ${version}`);
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

/** The lines of each `## ` section, keyed by its heading line. */
function sectionsByHeading(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      current = [];
      sections.set(line, current);
    } else {
      current?.push(line);
    }
  }
  return sections;
}

/**
 * The top-level bullets under a section's `### Behavior changes` heading,
 * found without the parser; undefined when the section has no such heading.
 */
function behaviorBullets(lines: readonly string[]): string[] | undefined {
  let inBehaviorChanges = false;
  let seen = false;
  const bullets: string[] = [];
  for (const line of lines) {
    if (line.startsWith('### ')) {
      inBehaviorChanges = line.slice(4).trim().toLowerCase() === 'behavior changes';
      seen ||= inBehaviorChanges;
    } else if (inBehaviorChanges && line.startsWith('- ')) {
      bullets.push(line);
    }
  }
  return seen ? bullets : undefined;
}

/** The bold title of a bullet as the notice prints it: code spans and links without their markup. */
function boldTitle(bullet: string): string | undefined {
  const bold = /^- \*\*(.+?)\*\*/.exec(bullet);
  if (bold === null) return undefined;
  return bold[1]
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * Asserts that `titles`, the parser's titles for one section, are exactly the
 * bold titles of `bullets`: one per bullet (none empty, none lost), each
 * complete (not cut at the length limit) and none repeated.
 */
function expectCompleteDistinctTitles(label: string, bullets: readonly string[], titles: readonly string[]): void {
  expect(titles, `${label}: one title per bullet`).toHaveLength(bullets.length);
  bullets.forEach((bullet, index) => {
    const title = titles[index];
    expect(boldTitle(bullet), `${label}: "${bullet.slice(0, 80)}" starts with a bold title`).toBeDefined();
    expect(title.trim(), `${label}: title of "${bullet.slice(0, 80)}"`).not.toBe('');
    expect(title.length, `${label}: "${title}" fits the notice`).toBeLessThanOrEqual(TITLE_LIMIT);
    expect(title, `${label}: "${title}" is the whole bold text`).toBe(boldTitle(bullet));
  });
  const repeated = titles.filter((title, index) => titles.indexOf(title) !== index);
  expect(repeated, `${label}: repeated titles`).toEqual([]);
}

const unreleasedLines = sectionsByHeading(CHANGELOG).get(UNRELEASED_HEADING);
const unreleasedBullets = unreleasedLines === undefined ? undefined : behaviorBullets(unreleasedLines);

describe('CHANGELOG.md behavior changes', () => {
  it('heads every section with a release version, below at most one [Unreleased]', () => {
    // The parser skips a section whose heading names no version, so a typo
    // there would drop that release's behavior changes from the notice.
    const headings = CHANGELOG.split(/\r?\n/).filter((line) => line.startsWith('## '));
    const releases = headings[0] === UNRELEASED_HEADING ? headings.slice(1) : headings;
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.filter((line) => !RELEASE_HEADING.test(line))).toEqual([]);
  });

  it('spells every behavior-changes heading the way the parser reads it', () => {
    // The parser takes only a level-3 heading reading "Behavior changes".
    // "Behaviour changes", a singular or another heading level would leave
    // that section's bullets out of the upgrade notice, and the checks
    // below, which find the section the same way, would not notice.
    const misspelled = CHANGELOG.split(/\r?\n/).filter(
      (line) =>
        /^#+\s/.test(line) &&
        /behaviou?r\W*changes?/i.test(line) &&
        !(line.startsWith('### ') && line.slice(4).trim().toLowerCase() === 'behavior changes'),
    );
    expect(misspelled).toEqual([]);
  });

  // Right after a release, [Unreleased] starts over without a Behavior
  // changes subsection (or is not there yet): none of it would reach the
  // notice, so the test reports itself skipped. A Behavior changes heading
  // without bullets fails.
  it.skipIf(unreleasedBullets === undefined)(
    'lists the [Unreleased] behavior changes, complete and distinct, once that section is released',
    () => {
      const nextVersion = nextMinorVersion(VERSION);
      expect(compareVersions(nextVersion, VERSION)).toBeGreaterThan(0);
      const released = CHANGELOG.replace(/^## \[Unreleased\]$/m, `## [${nextVersion}] - next release`);

      const releases = parseChangelogBehaviorChanges(released);
      // Newest first: the renamed section comes before every earlier release.
      expect(releases.at(0)?.version).toBe(nextVersion);
      const titles = releases.at(0)?.changes ?? [];
      expect(titles.length).toBeGreaterThan(0);
      expectCompleteDistinctTitles(`[${nextVersion}]`, unreleasedBullets ?? [], titles);

      // What a user upgrading from the running version is shown, in order.
      expect(behaviorChangesBetween(releases, VERSION, nextVersion)).toEqual(titles);
    },
  );

  it('gives the behavior changes of every release complete, distinct titles', () => {
    const releases = parseChangelogBehaviorChanges(CHANGELOG);
    expect(releases.length).toBeGreaterThan(0);
    const releasesByVersion = new Map(releases.map((release) => [release.version, release.changes]));
    for (const [heading, lines] of sectionsByHeading(CHANGELOG)) {
      const version = RELEASE_HEADING.exec(heading)?.[1];
      const bullets = behaviorBullets(lines);
      if (version === undefined || bullets === undefined) continue;
      expectCompleteDistinctTitles(heading, bullets, releasesByVersion.get(version) ?? []);
    }
  });
});
