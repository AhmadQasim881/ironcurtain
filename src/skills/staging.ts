import { cpSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { copyRegularFileBelow, ensureDirectoryBelow } from '../hardened-fs.js';
import { ARTIFACT_WALK_LIMITS, walkTreeNoFollow } from '../workflow/artifacts.js';
import type { ResolvedSkill } from './types.js';

/** Stable signature for change-detection in `createCachedStager`. */
function computeSignature(skills: readonly ResolvedSkill[]): string {
  return skills
    .map((s) => `${s.name}\0${s.sourceDir}`)
    .sort()
    .join('\n');
}

/**
 * Rejects skill names whose `resolve(destDir, name)` would either
 * overlay the staging root (`''`, `.`), escape it (`..`), or nest
 * beneath it (`/`, `\\`) — the container's one-level walk only sees
 * `<root>/<name>/SKILL.md`. Throws on rejection.
 */
export function validateSkillName(name: string): void {
  if (name === '') {
    throw new Error('Invalid skill name: name is empty');
  }
  if (name === '.' || name === '..') {
    throw new Error(`Invalid skill name: "${name}" is not a valid directory name`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid skill name: "${name}" contains a path separator`);
  }
}

/**
 * Replaces the contents of `destDir` with the resolved set: each skill
 * is copied to `<destDir>/<skill.name>/`. Skill names are validated by
 * {@link validateSkillName}.
 *
 * Wipes children individually rather than the parent itself. Workflow
 * bundles bind-mount this directory into a long-lived container; on
 * Linux a bind mount pins the source's inode at mount time, so removing
 * and recreating the parent dir leaves the container's mount pointing
 * at the freed (now-empty) inode. Per-child cleanup keeps the parent
 * inode stable across re-stages.
 */
export function stageSkillsToBundle(skills: readonly ResolvedSkill[], destDir: string): void {
  for (const skill of skills) validateSkillName(skill.name);
  const normalizedDestDir = resolve(destDir);
  mkdirSync(normalizedDestDir, { recursive: true });
  if (!lstatSync(normalizedDestDir).isDirectory()) throw new Error('Skill staging root must be a real directory');
  const destinationRoot = realpathSync(normalizedDestDir);
  for (const entry of readdirSync(normalizedDestDir)) {
    rmSync(resolve(normalizedDestDir, entry), { recursive: true, force: true });
  }

  let remainingBytes = 256 * 1024 * 1024;
  for (const skill of skills) {
    // User/persona layers are user-maintained and support linked skills.
    // Workflow packages and external run stages are untrusted sources.
    if (skill.source !== 'workflow') {
      cpSync(skill.sourceDir, resolve(destinationRoot, skill.name), { recursive: true });
      continue;
    }
    const sourceRoot = resolve(skill.sourceDir);
    if (!lstatSync(sourceRoot).isDirectory()) throw new Error('Skill source must be a real directory');
    if (realpathSync(sourceRoot) !== sourceRoot) throw new Error('Skill source must be a real directory');
    ensureDirectoryBelow(destinationRoot, skill.name);
    const outcome = walkTreeNoFollow(sourceRoot, ARTIFACT_WALK_LIMITS, {
      file: (fullPath, stats) => {
        const name = relative(sourceRoot, fullPath).split(sep).join('/');
        remainingBytes -= copyRegularFileBelow(destinationRoot, name, `${skill.name}/${name}`, {
          sourceRoot,
          maxBytes: remainingBytes,
          mode: stats.mode & 0o777,
          createParents: true,
        });
        return false;
      },
      enterDirectory: (fullPath) => {
        const name = relative(sourceRoot, fullPath).split(sep).join('/');
        ensureDirectoryBelow(destinationRoot, `${skill.name}/${name}`);
        return true;
      },
    });
    if (outcome.truncated) throw new Error('Skill staging tree exceeds entry or depth limits');
  }
}

/**
 * Builds a `stage(skills)` closure pinned to `destDir` that skips the
 * wipe-and-rebuild when the resolved set is byte-identical to the
 * previous call. Used by workflow bundles to keep state-transition
 * latency near-zero when consecutive states resolve to the same skills.
 */
export function createCachedStager(destDir: string): (skills: readonly ResolvedSkill[]) => boolean {
  let lastSignature: string | undefined;
  return (skills) => {
    const signature = computeSignature(skills);
    if (signature === lastSignature) return false;
    stageSkillsToBundle(skills, destDir);
    lastSignature = signature;
    return true;
  };
}
