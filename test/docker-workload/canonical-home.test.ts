/**
 * Nested-Docker staging below an IronCurtain home that is reached through a
 * symlink (a relocated `/home`, an automount, `IRONCURTAIN_HOME` under `/tmp`
 * on macOS). The home and its ancestors are trusted; everything below it must
 * be real, and staging uses the canonical location.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPathBelowHome, resolveCanonicalIronCurtainHome } from '../../src/docker-workload/canonical-home.js';
import { stageNestedDaemonIdentity } from '../../src/docker-workload/nested-daemon-identity.js';
import { stageAppleVmDockerWorkloadBootstrap } from '../../src/docker-workload/apple-private-docker.js';
import { createTestAppleVmDockerWorkloadBootstrap } from './helpers/infrastructure-harness.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A real home plus a symlink to it in another directory. */
function symlinkedHome(): { readonly real: string; readonly link: string; readonly outside: string } {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-home-')));
  directories.push(outside);
  const real = join(outside, 'data', 'home', '.ironcurtain');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  const link = join(outside, 'home-link');
  symlinkSync(join(outside, 'data', 'home'), link);
  return { real, link: join(link, '.ironcurtain'), outside };
}

describe('canonical IronCurtain home for nested staging', () => {
  it('resolves a symlinked home once and maps paths below it to their real location', () => {
    const { real, link } = symlinkedHome();
    mkdirSync(join(real, 'run', 'bundle000001', 'host'), { recursive: true, mode: 0o700 });

    const home = resolveCanonicalIronCurtainHome(link);
    expect(home).toEqual({ configured: link, canonical: real });
    // Existing components are verified; the missing tail is appended for the caller to create.
    expect(canonicalPathBelowHome(home, join(link, 'run', 'bundle000001', 'host', 'daemon'), 'test path')).toBe(
      join(real, 'run', 'bundle000001', 'host', 'daemon'),
    );
    expect(canonicalPathBelowHome(home, join(real, 'run'), 'test path')).toBe(join(real, 'run'));
    expect(canonicalPathBelowHome(home, link, 'test path')).toBe(real);
  });

  it('stages Docker Desktop daemon identity below a symlinked home with canonical bind sources', () => {
    const { real, link } = symlinkedHome();
    mkdirSync(join(real, 'run', 'bundle000001', 'host'), { recursive: true, mode: 0o700 });
    const configured = join(link, 'run', 'bundle000001', 'host', 'daemon');

    // The lexical path the path helpers derive is refused, as before.
    expect(() => stageNestedDaemonIdentity(configured, { uid: 1101, gid: 1102 })).toThrow(
      /canonical owner-only directory/u,
    );
    const canonical = canonicalPathBelowHome(resolveCanonicalIronCurtainHome(link), configured, 'daemon config');
    const mounts = stageNestedDaemonIdentity(canonical, { uid: 1101, gid: 1102 });
    expect(mounts.map((mount) => mount.source)).toEqual(
      ['passwd', 'group', 'subuid', 'subgid'].map((name) => join(real, 'run', 'bundle000001', 'host', 'daemon', name)),
    );
  });

  it('stages the Apple selected-agent archive into a lease below a symlinked home', () => {
    const { real, link } = symlinkedHome();
    const stagingRoot = join(real, 'docker-workload', 'state', 'dw-lease', 'staging');
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const artifactParent = join(real, 'docker-workload', 'agent-artifacts');
    mkdirSync(artifactParent, { recursive: true, mode: 0o700 });
    const source = createTestAppleVmDockerWorkloadBootstrap(artifactParent);
    const lexicalStagingRoot = join(link, 'docker-workload', 'state', 'dw-lease', 'staging');

    expect(() =>
      stageAppleVmDockerWorkloadBootstrap({ leaseStagingRoot: lexicalStagingRoot, artifact: source.artifact }),
    ).toThrow(/private, owner-owned real directory/u);
    const staged = stageAppleVmDockerWorkloadBootstrap({
      leaseStagingRoot: canonicalPathBelowHome(resolveCanonicalIronCurtainHome(link), lexicalStagingRoot, 'staging'),
      artifact: source.artifact,
    });
    expect(staged.hostArtifactDirectory).toBe(join(stagingRoot, 'selected-agent-artifact'));
  });

  it('refuses a symlink IronCurtain created nothing for below the home', () => {
    const { real, link, outside } = symlinkedHome();
    const elsewhere = join(outside, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(real, 'run'));

    expect(() =>
      canonicalPathBelowHome(resolveCanonicalIronCurtainHome(link), join(link, 'run', 'bundle', 'host'), 'staging'),
    ).toThrow(/owner-owned real directories below the IronCurtain home/u);
  });

  it('refuses a non-directory component and a path outside the home', () => {
    const { real, link, outside } = symlinkedHome();
    writeFileSync(join(real, 'run'), 'not a directory\n', { mode: 0o600 });
    const home = resolveCanonicalIronCurtainHome(link);

    expect(() => canonicalPathBelowHome(home, join(link, 'run', 'bundle', 'host'), 'staging')).toThrow(
      /owner-owned real directories/u,
    );
    expect(() => canonicalPathBelowHome(home, join(outside, 'other', 'daemon'), 'staging')).toThrow(
      /must be below the IronCurtain home/u,
    );
    expect(() => canonicalPathBelowHome(home, `${link}-sibling/daemon`, 'staging')).toThrow(
      /must be below the IronCurtain home/u,
    );
    expect(() => canonicalPathBelowHome(home, 'relative/daemon', 'staging')).toThrow(/canonical and absolute/u);
    expect(() => resolveCanonicalIronCurtainHome(join(outside, 'missing-home'))).toThrow(/not accessible/u);
  });
});
