/**
 * Tests for the home-level state record ($IRONCURTAIN_HOME/state.json) and
 * the first-run-after-upgrade notice (src/config/state-version.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assessStateVersion,
  behaviorChangesBetween,
  compareVersions,
  CURRENT_LAYOUT_VERSION,
  formatUpgradeNotice,
  parseChangelogBehaviorChanges,
  readPackageChangelog,
  readStateFile,
  recordStartupState,
  type ChangelogBehaviorChanges,
} from '../src/config/state-version.js';

const CHANGELOG = `# Changelog

## [Unreleased]

### Behavior changes

- **Not released yet** — must never be listed.

## [0.3.0] - 2026-03-01

### Features

- **A feature** — not a behavior change.

### Behavior changes

- **Workflows resume through the daemon** — details.
- Plain bullet without bold. Second sentence.
  - nested detail line, ignored

## [0.2.0] - 2026-02-01

### Behavior changes

- **Node.js 20 is no longer supported** — details with \`code\`.

## [0.1.0] - 2026-01-01

### Fixes

- **Only fixes here**
`;

const RELEASES: readonly ChangelogBehaviorChanges[] = parseChangelogBehaviorChanges(CHANGELOG);

describe('compareVersions', () => {
  it('orders releases numerically and pre-releases below their release', () => {
    expect(compareVersions('0.13.0', '0.14.0')).toBeLessThan(0);
    expect(compareVersions('0.14.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });

  it('refuses what is not major.minor.patch', () => {
    expect(compareVersions('latest', '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0', '1.0.0')).toBeUndefined();
  });
});

describe('CHANGELOG behavior changes', () => {
  it('reads the titles under each release, skipping [Unreleased] and other headings', () => {
    expect(RELEASES).toEqual([
      { version: '0.3.0', changes: ['Workflows resume through the daemon', 'Plain bullet without bold.'] },
      { version: '0.2.0', changes: ['Node.js 20 is no longer supported'] },
      { version: '0.1.0', changes: [] },
    ]);
  });

  it('lists the releases after the previous version, oldest first, prefixed only across releases', () => {
    expect(behaviorChangesBetween(RELEASES, '0.1.0', '0.3.0')).toEqual([
      '0.2.0: Node.js 20 is no longer supported',
      '0.3.0: Workflows resume through the daemon',
      '0.3.0: Plain bullet without bold.',
    ]);
    expect(behaviorChangesBetween(RELEASES, '0.2.0', '0.3.0')).toEqual([
      'Workflows resume through the daemon',
      'Plain bullet without bold.',
    ]);
    // An unknown previous version: only the running version's own changes.
    expect(behaviorChangesBetween(RELEASES, undefined, '0.2.0')).toEqual(['Node.js 20 is no longer supported']);
    // Never releases newer than the running version.
    expect(behaviorChangesBetween(RELEASES, '0.1.0', '0.2.0')).toEqual(['Node.js 20 is no longer supported']);
  });

  it("parses this package's CHANGELOG.md", () => {
    const releases = readPackageChangelog();
    expect(releases).toBeDefined();
    const release = releases?.find((entry) => entry.version === '0.14.0');
    expect(release?.changes).toContain('Node.js support is now limited to 24 and 26');
  });
});

describe('assessStateVersion', () => {
  const present = (layoutVersion: number, lastRunVersion: string) =>
    ({ kind: 'present', state: { layoutVersion, lastRunVersion } }) as const;

  it('tells a fresh home from one an unrecording version used', () => {
    expect(assessStateVersion({ kind: 'absent' }, '1.0.0', false).change).toBe('fresh');
    expect(assessStateVersion({ kind: 'absent' }, '1.0.0', true).change).toBe('unknown');
    expect(assessStateVersion({ kind: 'invalid', reason: 'x' }, '1.0.0', false).change).toBe('unknown');
  });

  it('compares the recorded version and layout', () => {
    expect(assessStateVersion(present(1, '1.0.0'), '1.0.0', true)).toMatchObject({
      change: 'same',
      layout: 'current',
    });
    expect(assessStateVersion(present(1, '0.9.0'), '1.0.0', true)).toMatchObject({
      change: 'upgraded',
      previousVersion: '0.9.0',
    });
    expect(assessStateVersion(present(1, '2.0.0'), '1.0.0', true).change).toBe('downgraded');
    expect(assessStateVersion(present(CURRENT_LAYOUT_VERSION + 1, '9.0.0'), '1.0.0', true).layout).toBe('newer');
  });
});

describe('formatUpgradeNotice', () => {
  it('summarizes the behavior changes since the previous version and suggests doctor --upgrade', () => {
    const lines = formatUpgradeNotice(
      { layout: 'current', recordedLayoutVersion: 1, change: 'upgraded', previousVersion: '0.1.0' },
      '0.3.0',
      RELEASES,
    );
    expect(lines[0]).toBe('IronCurtain was upgraded from 0.1.0 to 0.3.0.');
    expect(lines).toContain('Behavior changes since 0.1.0:');
    expect(lines).toContain('  - 0.2.0: Node.js 20 is no longer supported');
    expect(lines.at(-1)).toContain('ironcurtain doctor --upgrade');
  });

  it('says nothing for a fresh home or the same version, and warns on a downgrade', () => {
    expect(
      formatUpgradeNotice(
        { layout: 'older', recordedLayoutVersion: undefined, change: 'fresh', previousVersion: undefined },
        '1.0.0',
        RELEASES,
      ),
    ).toEqual([]);
    expect(
      formatUpgradeNotice(
        { layout: 'current', recordedLayoutVersion: 1, change: 'same', previousVersion: '1.0.0' },
        '1.0.0',
        RELEASES,
      ),
    ).toEqual([]);
    const downgrade = formatUpgradeNotice(
      { layout: 'current', recordedLayoutVersion: 1, change: 'downgraded', previousVersion: '2.0.0' },
      '1.0.0',
      RELEASES,
    );
    expect(downgrade[0]).toContain('last used by IronCurtain 2.0.0, a newer version');
  });
});

describe('recordStartupState', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'ironcurtain-state-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeState(home: string, content: unknown): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'state.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }

  it('records the version of a fresh install silently, creating an owner-only home and file', () => {
    const home = join(root, 'home');
    expect(recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES })).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf-8'))).toEqual({
      layoutVersion: CURRENT_LAYOUT_VERSION,
      lastRunVersion: '0.3.0',
    });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'state.json')).mode & 0o777).toBe(0o600);
    // The second run of a fresh install is not mistaken for an upgrade.
    expect(recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES })).toEqual([]);
  });

  it('prints the upgrade notice once when lastRunVersion differs, then records the new version', () => {
    const home = join(root, 'home');
    writeState(home, { layoutVersion: 1, lastRunVersion: '0.1.0', addedLater: { keep: true } });

    const notice = recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
    expect(notice[0]).toBe('IronCurtain was upgraded from 0.1.0 to 0.3.0.');
    expect(notice.join('\n')).toContain('ironcurtain doctor --upgrade');
    // Recorded, keeping the fields this version does not know.
    expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf-8'))).toEqual({
      layoutVersion: 1,
      lastRunVersion: '0.3.0',
      addedLater: { keep: true },
    });
    // One-time: the next run is quiet.
    expect(recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES })).toEqual([]);
  });

  it('notices a home used before versions were recorded', () => {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{}');
    const notice = recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
    expect(notice[0]).toBe('IronCurtain 0.3.0 is running on a home last used by an earlier version.');
    expect(notice).toContain('Behavior changes in 0.3.0:');
    expect(readStateFile(home)).toMatchObject({ kind: 'present', state: { lastRunVersion: '0.3.0' } });
  });

  it('treats an unreadable state.json as unknown and rewrites it', () => {
    const home = join(root, 'home');
    writeState(home, 'not json');
    expect(readStateFile(home)).toMatchObject({ kind: 'invalid' });
    expect(recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES })[0]).toContain('earlier version');
    expect(readStateFile(home)).toMatchObject({ kind: 'present' });
  });

  it('refuses a home with a newer layout and leaves its state alone', () => {
    const home = join(root, 'home');
    const newer = JSON.stringify({ layoutVersion: CURRENT_LAYOUT_VERSION + 1, lastRunVersion: '9.0.0' });
    writeState(home, newer);
    let caught: unknown;
    try {
      recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: unknown }).code).toBe('STATE_LAYOUT_TOO_NEW');
    expect((caught as Error).message).toContain(`layout version ${CURRENT_LAYOUT_VERSION + 1}`);
    expect(readFileSync(join(home, 'state.json'), 'utf-8')).toBe(newer);
  });

  it('refuses, and leaves alone, a newer layout whose other fields this version does not accept', () => {
    // A newer IronCurtain may rename or reshape every other field.
    for (const record of [
      { layoutVersion: CURRENT_LAYOUT_VERSION + 1 },
      { layoutVersion: CURRENT_LAYOUT_VERSION + 1, lastRunVersion: 42, layout: { generation: 2 } },
    ]) {
      const home = join(root, `home-${Object.keys(record).length}`);
      const text = JSON.stringify(record);
      writeState(home, text);
      expect(readStateFile(home)).toMatchObject({ kind: 'invalid', layoutVersion: CURRENT_LAYOUT_VERSION + 1 });
      let caught: unknown;
      try {
        recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: unknown }).code).toBe('STATE_LAYOUT_TOO_NEW');
      expect((caught as Error).message).toContain(`The IronCurtain home ${home} has layout version`);
      expect(readFileSync(join(home, 'state.json'), 'utf-8')).toBe(text);
    }
    // An unreadable record naming no newer generation is still repaired.
    const home = join(root, 'home-old');
    writeState(home, { layoutVersion: CURRENT_LAYOUT_VERSION });
    expect(assessStateVersion(readStateFile(home), '0.3.0', true).layout).toBe('older');
    recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
    expect(readStateFile(home)).toMatchObject({ kind: 'present', state: { lastRunVersion: '0.3.0' } });
  });

  it('never writes outside the home it is given', () => {
    const home = join(root, 'home');
    recordStartupState({ home, currentVersion: '0.3.0', releases: RELEASES });
    expect(existsSync(join(root, 'state.json'))).toBe(false);
  });
});
