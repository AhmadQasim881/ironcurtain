import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { copyRegularFileBelow, ensureDirectoryBelow } from '../hardened-fs.js';
import { getIronCurtainHome } from '../config/paths.js';
import { isSameDirectory } from './checkpoint-selection.js';
import { RUN_SCRIPTS_DIRNAME, RUN_SKILLS_DIRNAME } from './checkpoint.js';
import { ARTIFACT_WALK_LIMITS, walkTreeNoFollow } from './artifacts.js';

export type WorkflowStagedKind = 'skills' | 'scripts';
const STAGED_NAMES = { skills: RUN_SKILLS_DIRNAME, scripts: RUN_SCRIPTS_DIRNAME } as const;
const MAX_STAGED_BYTES = 256 * 1024 * 1024;

/** Limits for copying agent-written workflow resources; defaults match run staging. */
export interface WorkflowResourceCopyLimits {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxBytes?: number;
  /** Copy only these top-level directories when staging declared artifact inputs. */
  readonly rootDirectories?: ReadonlySet<string>;
}

/** Only this home's own runs may recover resources from their original package. */
export function isOwnWorkflowRunsDirectory(baseDir: string): boolean {
  return isSameDirectory(baseDir, resolve(getIronCurtainHome(), 'workflow-runs'));
}

/** A recorded stage must name this run's real, canonical stage directory. */
export function validatedWorkflowStagedDirectory(
  runDir: string,
  path: string | undefined,
  kind: WorkflowStagedKind,
): string | undefined {
  if (path === undefined || !isAbsolute(path)) return undefined;
  try {
    const expected = resolve(runDir, STAGED_NAMES[kind]);
    if (!lstatSync(path).isDirectory() || !lstatSync(expected).isDirectory()) return undefined;
    const root = realpathSync(runDir);
    const canonical = realpathSync(path);
    const inside = relative(root, canonical);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    return canonical === realpathSync(expected) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Copy bounded regular files between workflow resource roots, skipping links and special files. */
export function copyWorkflowResourceDirectory(
  source: string,
  destinationRoot: string,
  destinationRelative: string,
  options: WorkflowResourceCopyLimits = {},
): void {
  const { rootDirectories, ...overrides } = options;
  const limits = { ...ARTIFACT_WALK_LIMITS, maxBytes: MAX_STAGED_BYTES, ...overrides };
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error('Workflow resource copy limits must be non-negative safe integers');
  }
  if (!lstatSync(source).isDirectory()) throw new Error('Workflow resource source must be a real directory');
  const sourceRoot = resolve(realpathSync(dirname(source)), basename(source));
  if (realpathSync(sourceRoot) !== sourceRoot) throw new Error('Workflow resource source must be a real directory');
  const destination = realpathSync(destinationRoot);
  ensureDirectoryBelow(destination, destinationRelative);
  if (rootDirectories?.size === 0) return;
  let remainingBytes = limits.maxBytes;
  const outcome = walkTreeNoFollow(sourceRoot, limits, {
    enterDirectory: (fullPath) => {
      const name = relative(sourceRoot, fullPath).split(sep).join('/');
      if (rootDirectories !== undefined && !rootDirectories.has(name.split('/')[0])) return false;
      ensureDirectoryBelow(
        destination,
        `${destinationRelative}/${relative(sourceRoot, fullPath).split(sep).join('/')}`,
      );
      return true;
    },
    file: (fullPath, stats) => {
      const name = relative(sourceRoot, fullPath).split(sep).join('/');
      if (rootDirectories !== undefined && (name.indexOf('/') === -1 || !rootDirectories.has(name.split('/')[0])))
        return false;
      remainingBytes -= copyRegularFileBelow(destination, name, `${destinationRelative}/${name}`, {
        sourceRoot,
        maxBytes: remainingBytes,
        mode: stats.mode & 0o777,
        createParents: true,
      });
      return false;
    },
  });
  if (outcome.truncated) throw new Error('Workflow staging tree exceeds entry or depth limits');
}

/** Copy bounded regular files from a real source tree into a run-owned stage. */
export function copyWorkflowStagedDirectory(
  source: string,
  runDir: string,
  kind: WorkflowStagedKind,
  options: WorkflowResourceCopyLimits = {},
): string {
  const runRoot = realpathSync(runDir);
  const stageName = STAGED_NAMES[kind];
  copyWorkflowResourceDirectory(source, runRoot, stageName, options);
  const staged = validatedWorkflowStagedDirectory(runRoot, resolve(runRoot, stageName), kind);
  if (staged === undefined) throw new Error('Workflow staging directory changed while copying');
  return staged;
}
