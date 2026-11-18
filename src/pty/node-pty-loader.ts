/**
 * Loading node-pty for host-side PTYs: the mux's tabs, the web UI terminal
 * and Apple Container's runtime-native exec relay
 * (`src/docker/pty-host-terminal.ts`).
 *
 * node-pty is an optional dependency, so it may be missing, and its 1.1.0
 * macOS prebuilds ship `spawn-helper` without the execute bit
 * (https://github.com/microsoft/node-pty/issues/850), which makes every spawn
 * fail with "posix_spawnp failed". This module is the one place that repairs
 * that bit, and the one place that says how to fix an installation without
 * node-pty ({@link nodePtyRemediation}).
 *
 * node-pty 1.1.0 ships prebuilt binaries only for macOS and Windows. On Linux
 * npm compiles it when IronCurtain is installed, which needs python3, make
 * and a C++ compiler. Without them the build fails and npm deletes the
 * package, as it does any optional dependency whose install script fails.
 * When npm does not run install scripts at all (`--ignore-scripts`,
 * `ignore-scripts=true` in an npmrc), the package is installed but cannot
 * load. The two need different fixes ({@link nodePtyRemediation}).
 *
 * Leaf module: no IronCurtain imports.
 */

import { chmodSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_PTY_SPAWN_HELPER_ISSUE_URL = 'https://github.com/microsoft/node-pty/issues/850';

/** Why node-pty may be missing: shown with {@link nodePtyRemediation}. */
export const NODE_PTY_BUILD_NOTE =
  'node-pty is a native module with no prebuilt binary for Linux, so npm compiles it when IronCurtain is ' +
  'installed; it is left out when that build fails (no compiler) and stays unbuilt when npm does not run ' +
  'install scripts.';

/** The build tools npm needs to compile node-pty on `platform`. */
export function nodePtyBuildTools(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'linux':
      return 'python3, make and a C++ compiler (g++; build-essential on Debian and Ubuntu)';
    case 'darwin':
      return 'the Xcode Command Line Tools (`xcode-select --install`)';
    case 'win32':
      return 'Python and the Visual Studio C++ build tools';
    default:
      return 'python3, make and a C++ compiler';
  }
}

/**
 * How to make node-pty loadable again, as one line. The fix depends on
 * whether npm left the package on disk (`installed`, detected by default):
 *
 * - Missing: npm deletes an optional dependency whose install script failed
 *   (no compiler), and `--omit=optional` leaves it out. There is nothing to
 *   rebuild (`npm rebuild node-pty` matches no package and still reports
 *   success), so IronCurtain is reinstalled: an explicit
 *   `npm install -g @provos/ironcurtain` replaces the installed package and
 *   installs its missing optional dependencies again, building node-pty.
 * - Installed but not loadable: npm skipped its install script, or the build
 *   is broken. A reinstall keeps an installed dependency as it is, so
 *   node-pty is rebuilt: `npm rebuild -g node-pty` rebuilds the copy inside a
 *   global IronCurtain install (`npm rebuild -g @provos/ironcurtain` would run
 *   only IronCurtain's own scripts, not its dependencies'). Without
 *   `--ignore-scripts=false` an npmrc with `ignore-scripts=true`, a common
 *   reason it was never built, turns the rebuild into a silent no-op.
 *
 * `npm install node-pty` in the current directory helps neither: a global
 * install resolves modules from IronCurtain's package directory.
 * `--allow-scripts` lets the scripts run under an npm configuration that
 * blocks unreviewed install scripts; a project install (a source checkout)
 * rejects that flag and allows node-pty through the `allowScripts` field of
 * package.json instead.
 */
export function nodePtyRemediation(
  platform: NodeJS.Platform = process.platform,
  installed: boolean = isNodePtyInstalled(),
): string {
  const tools = `Install ${nodePtyBuildTools(platform)}, then `;
  if (!installed) {
    return (
      tools +
      'reinstall IronCurtain, which installs and builds node-pty again: ' +
      '`npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty` for a global install, ' +
      'or `npm install` in a source checkout.'
    );
  }
  return (
    tools +
    'rebuild node-pty: ' +
    '`npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false` for a global install of IronCurtain, ' +
    'or `npm rebuild node-pty --ignore-scripts=false` in a source checkout.'
  );
}

/** Outcome of {@link repairNodePtySpawnHelper}. */
export type SpawnHelperRepair =
  /** Not macOS, no helper found, or it is already executable. */
  | { readonly status: 'ok' }
  /** The execute bits were added. */
  | { readonly status: 'repaired'; readonly helperPath: string }
  /** The helper is not executable and cannot be fixed here (e.g. a read-only npx cache). */
  | { readonly status: 'not-executable'; readonly helperPath: string };

/** node-pty's prebuilt macOS `spawn-helper`, next to the package entry point. */
export function nodePtySpawnHelperPath(nodePtyEntry: string, arch: string = process.arch): string {
  return join(dirname(nodePtyEntry), '..', 'prebuilds', `darwin-${arch}`, 'spawn-helper');
}

/** The file mode of `helperPath`, or undefined when it does not exist. */
function helperMode(helperPath: string): number | undefined {
  try {
    return statSync(helperPath).mode;
  } catch {
    return undefined;
  }
}

/** Add the execute bits to `helperPath` when its owner cannot execute it. */
export function ensureSpawnHelperExecutable(helperPath: string): SpawnHelperRepair {
  const mode = helperMode(helperPath);
  // Not found: let node-pty report its own error if spawning fails.
  if (mode === undefined || mode & constants.S_IXUSR) return { status: 'ok' };
  try {
    chmodSync(helperPath, mode | constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH);
    return { status: 'repaired', helperPath };
  } catch {
    return { status: 'not-executable', helperPath };
  }
}

/** node-pty's entry point, or undefined when the package cannot be resolved. */
function resolveNodePtyEntry(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('node-pty'));
  } catch {
    return undefined;
  }
}

/**
 * Whether the node-pty package is on disk, loadable or not: false when npm
 * deleted it after its build failed or left it out (`--omit=optional`).
 */
export function isNodePtyInstalled(): boolean {
  return resolveNodePtyEntry() !== undefined;
}

/** On macOS, make node-pty's `spawn-helper` executable; a no-op elsewhere. */
export function repairNodePtySpawnHelper(platform: NodeJS.Platform = process.platform): SpawnHelperRepair {
  if (platform !== 'darwin') return { status: 'ok' };
  const entry = resolveNodePtyEntry();
  if (entry === undefined) return { status: 'ok' };
  return ensureSpawnHelperExecutable(nodePtySpawnHelperPath(entry));
}

/**
 * The read-only half of {@link ensureSpawnHelperExecutable}: reports a helper
 * its owner cannot execute without touching it. Never `repaired`.
 */
export function inspectSpawnHelper(helperPath: string): SpawnHelperRepair {
  const mode = helperMode(helperPath);
  if (mode === undefined || mode & constants.S_IXUSR) return { status: 'ok' };
  return { status: 'not-executable', helperPath };
}

/**
 * The read-only half of {@link repairNodePtySpawnHelper}, for diagnostics
 * that must not change the installation.
 */
export function inspectNodePtySpawnHelper(platform: NodeJS.Platform = process.platform): SpawnHelperRepair {
  if (platform !== 'darwin') return { status: 'ok' };
  const entry = resolveNodePtyEntry();
  if (entry === undefined) return { status: 'ok' };
  return inspectSpawnHelper(nodePtySpawnHelperPath(entry));
}

/** The installed node-pty version, when its package.json can be read. */
function installedNodePtyVersion(): string | undefined {
  const entry = resolveNodePtyEntry();
  if (entry === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf-8'));
    const version =
      typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link probeNodePty} found. */
export type NodePtyProbe =
  | { readonly status: 'ok'; readonly version: string | undefined }
  /**
   * The package is missing (`installed` false) or its native addon does not
   * load; {@link nodePtyRemediation} gives a different fix for each.
   */
  | { readonly status: 'unavailable'; readonly detail: string; readonly installed: boolean }
  /** macOS: it loads, but every spawn would fail with "posix_spawnp failed". */
  | { readonly status: 'spawn-helper-not-executable'; readonly helperPath: string };

export interface ProbeNodePtyOptions {
  /** Test seams; production imports the real package and inspects the real helper. */
  readonly importNodePty?: () => Promise<unknown>;
  readonly isNodePtyInstalled?: () => boolean;
  readonly inspectSpawnHelper?: () => SpawnHelperRepair;
  readonly readVersion?: () => string | undefined;
}

/**
 * Loads node-pty (its native addon included) and checks its spawn-helper
 * without repairing it: what `ironcurtain doctor` reports.
 */
export async function probeNodePty(options: ProbeNodePtyOptions = {}): Promise<NodePtyProbe> {
  try {
    await (options.importNodePty ?? (() => import('node-pty')))();
  } catch (error) {
    return {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
      installed: (options.isNodePtyInstalled ?? isNodePtyInstalled)(),
    };
  }
  const helper = (options.inspectSpawnHelper ?? inspectNodePtySpawnHelper)();
  if (helper.status === 'not-executable') {
    return { status: 'spawn-helper-not-executable', helperPath: helper.helperPath };
  }
  return { status: 'ok', version: (options.readVersion ?? installedNodePtyVersion)() };
}

export interface LoadNodePtyOptions {
  /** What needs node-pty, for the error message (e.g. "Apple Container interactive sessions"). */
  readonly purpose: string;
  /** Test seams; production imports the real package and repairs the real helper. */
  readonly importNodePty?: () => Promise<typeof import('node-pty')>;
  readonly isNodePtyInstalled?: () => boolean;
  readonly repairSpawnHelper?: () => SpawnHelperRepair;
}

/**
 * Import node-pty and make sure it can spawn, or throw an error that says
 * how to fix the installation.
 */
export async function loadNodePty(options: LoadNodePtyOptions): Promise<typeof import('node-pty')> {
  let nodePty: typeof import('node-pty');
  try {
    nodePty = await (options.importNodePty ?? (() => import('node-pty')))();
  } catch (error) {
    const installed = (options.isNodePtyInstalled ?? isNodePtyInstalled)();
    throw new Error(
      `${options.purpose} need the optional node-pty package, which could not be loaded. ` +
        `${NODE_PTY_BUILD_NOTE} ${nodePtyRemediation(process.platform, installed)}`,
      { cause: error },
    );
  }
  const repair = (options.repairSpawnHelper ?? repairNodePtySpawnHelper)();
  if (repair.status === 'not-executable') {
    throw new Error(
      `node-pty's spawn-helper is not executable and cannot be fixed automatically. ` +
        `Run: chmod +x "${repair.helperPath}" (see ${NODE_PTY_SPAWN_HELPER_ISSUE_URL})`,
    );
  }
  return nodePty;
}
