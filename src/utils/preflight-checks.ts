import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { getIronCurtainHome } from '../config/paths.js';
import { inheritedEnv } from '../trusted-process/child-env.js';
import { writePrivateFileAtomicSync } from '../util/atomic-write.js';

export interface PreflightCheckResult {
  ok: boolean;
  message: string;
  details?: string;
}

/** Hard timeout for the child-process viability check. */
const SANDBOX_CHECK_TIMEOUT_MS = 10_000;

/**
 * What a cached "the V8 sandbox loads" verdict was established for. The
 * marker in the IronCurtain home is reused only while every field still
 * matches the running process and the installed packages:
 *
 * - `nodeVersion`, `platform`, `arch`: the runtime the native addon must
 *   match. A Rosetta x64 and an arm64 Node.js of the same version load
 *   different binaries, and a home can be shared between machines.
 * - `utcpVersion`, `isolatedVmVersion`: the installed versions of
 *   @utcp/code-mode and of the isolated-vm it loads. isolated-vm is pinned
 *   on its own, so it can change while the code-mode fork does not.
 * - `utcpEntryPath`: which installation. A global install and a source
 *   checkout can share one home, and so one marker.
 */
export interface SandboxFingerprint {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly utcpVersion: string;
  readonly utcpEntryPath: string;
  readonly isolatedVmVersion: string;
}

const FINGERPRINT_FIELDS = [
  'nodeVersion',
  'platform',
  'arch',
  'utcpVersion',
  'utcpEntryPath',
  'isolatedVmVersion',
] as const satisfies readonly (keyof SandboxFingerprint)[];

/** The cache marker's path: `<IronCurtain home>/.preflight-ok`. */
export function getSandboxCacheMarkerPath(): string {
  return resolve(getIronCurtainHome(), '.preflight-ok');
}

/**
 * The version of the package `filePath` belongs to: the nearest package.json
 * above it that names a package (a nested one such as `dist/package.json`
 * holding only `"type"` does not), never looking past the `node_modules`
 * directory the package sits in. Null when there is none.
 */
function owningPackageVersion(filePath: string): string | null {
  for (let dir = dirname(filePath); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No (readable) package.json here: keep walking up.
    }
    if (dirname(dir) === dir) break;
  }
  return null;
}

/**
 * The fingerprint of the V8 sandbox this process would load, resolved the
 * way the viability check and Code Mode load it: `@utcp/code-mode` through
 * Node's module resolution from `from` (this module by default), and
 * isolated-vm from the code-mode package. Versions come from the resolved
 * packages' own package.json files, found from their entry points: the
 * code-mode fork's `exports` map does not expose `./package.json`, so
 * resolving that subpath directly always fails. Null when anything cannot be
 * resolved, which disables the cache: the real check then runs and reports
 * the problem.
 */
export function resolveSandboxFingerprint(from: string | URL = import.meta.url): SandboxFingerprint | null {
  try {
    const utcpEntryPath = createRequire(from).resolve('@utcp/code-mode');
    const utcpVersion = owningPackageVersion(utcpEntryPath);
    const isolatedVmVersion = owningPackageVersion(createRequire(utcpEntryPath).resolve('isolated-vm'));
    if (utcpVersion === null || isolatedVmVersion === null) return null;
    return {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      utcpVersion,
      utcpEntryPath,
      isolatedVmVersion,
    };
  } catch {
    return null;
  }
}

/** The marker's fingerprint, or null when there is none or it is not a complete one (a pre-fingerprint marker). */
function readCacheMarker(): SandboxFingerprint | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getSandboxCacheMarkerPath(), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return FINGERPRINT_FIELDS.every((field) => typeof record[field] === 'string')
      ? (record as unknown as SandboxFingerprint)
      : null;
  } catch {
    return null;
  }
}

function sameFingerprint(a: SandboxFingerprint, b: SandboxFingerprint): boolean {
  return FINGERPRINT_FIELDS.every((field) => a[field] === b[field]);
}

function writeCacheMarker(fingerprint: SandboxFingerprint): void {
  try {
    mkdirSync(getIronCurtainHome(), { recursive: true, mode: 0o700 });
    const marker = Object.fromEntries(FINGERPRINT_FIELDS.map((field) => [field, fingerprint[field]]));
    writePrivateFileAtomicSync(getSandboxCacheMarkerPath(), JSON.stringify(marker));
  } catch {
    // Cache writes are best-effort — failure just means we re-run next time.
  }
}

/** Options for {@link checkSandboxViability}. */
export interface SandboxViabilityOptions {
  /**
   * Consult and refresh the cache marker in the IronCurtain home (default
   * true). `ironcurtain doctor` passes false: it always runs the real check
   * and writes nothing, so a diagnostic run neither trusts a stale marker
   * nor creates the home.
   */
  readonly useCache?: boolean;
  /** The check run on a cache miss (tests). Default: load the sandbox in a child process. */
  readonly probe?: () => Promise<PreflightCheckResult>;
}

/**
 * Validates that the V8 sandbox (isolated-vm) can be initialized.
 * We spawn a separate Node process to prevent native module crashes (like
 * segfaults on Node 25 or ABI mismatches from stale builds) from killing
 * the main CLI process.
 *
 * On success, writes a cache marker holding the {@link SandboxFingerprint}
 * (runtime, installation and resolved package versions), so later
 * invocations with the same fingerprint skip the spawn (which otherwise
 * costs hundreds of ms for the UTCP module load). Any difference, such as an
 * isolated-vm upgrade, a different architecture or another installation
 * sharing the home, runs the real check again. With `useCache: false` the
 * marker is neither read nor written.
 */
export async function checkSandboxViability(options: SandboxViabilityOptions = {}): Promise<PreflightCheckResult> {
  const fingerprint = options.useCache === false ? null : resolveSandboxFingerprint();
  if (fingerprint !== null) {
    const cached = readCacheMarker();
    if (cached !== null && sameFingerprint(cached, fingerprint)) {
      return { ok: true, message: 'cached' };
    }
  }

  const result = await (options.probe ?? runSandboxViabilityCheck)();
  if (result.ok && fingerprint !== null) {
    writeCacheMarker(fingerprint);
  }
  return result;
}

/**
 * The sandbox preflight of a command about to run agent sessions in this
 * process: runs {@link checkSandboxViability} and, when the V8 sandbox cannot
 * load, prints the fatal error and exits with status 1. Commands answer
 * `--help` and argument errors before calling it (see
 * `sandboxPreflightRequired` in src/cli-routing.ts and the daemon command),
 * so those never depend on isolated-vm, and neither do the commands that run
 * no session (listing jobs or workflows, for example).
 *
 * Writes with process.stderr.write rather than console.error: the logger
 * (src/logger.ts) can redirect console.* into a log file, and this message
 * must reach the terminal.
 */
export async function ensureSandboxViable(): Promise<void> {
  const result = await checkSandboxViability();
  if (result.ok) return;
  process.stderr.write(`\n${chalk.bold(chalk.red('Fatal Error:'))} ${result.message}\n`);
  if (result.details) {
    process.stderr.write(chalk.dim(result.details) + '\n');
  }
  process.stderr.write(chalk.dim('Run `ironcurtain doctor` for a full diagnostic.\n\n'));
  process.exit(1);
}

function runSandboxViabilityCheck(): Promise<PreflightCheckResult> {
  return new Promise((resolvePromise) => {
    // Resolve the absolute path here so the child's cwd doesn't affect lookup —
    // a bare `@utcp/code-mode` specifier in `node -e` is resolved against
    // `<process.cwd()>/[eval]`, which breaks when the user invokes ironcurtain
    // from outside the installed package tree (e.g. global installs). Convert
    // to a file:// URL because ESM import() treats strings as URL-like, so a
    // raw path containing `#` or `?` would be misparsed as fragment/query.
    let utcpEntryUrl: string;
    try {
      const utcpEntry = createRequire(import.meta.url).resolve('@utcp/code-mode');
      utcpEntryUrl = pathToFileURL(utcpEntry).href;
    } catch (err) {
      resolvePromise({
        ok: false,
        message: 'Missing required dependency: @utcp/code-mode',
        details: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const script = `
      import(${JSON.stringify(utcpEntryUrl)})
        .then((m) => m.CodeModeUtcpClient.create())
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e.message || e);
          process.exit(1);
        });
    `;

    const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // The check loads one native module and exits; it needs nothing from
      // the host beyond the allowlist (PATH, HOME, TMPDIR, ...), and must not
      // inherit NODE_OPTIONS or the host's secrets.
      env: inheritedEnv(process.env),
    });

    let stderrOutput = '';
    let settled = false;

    const settle = (result: PreflightCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      // SIGKILL directly — the child is either hung in native init or stuck
      // loading UTCP, neither of which respects SIGTERM cleanly.
      child.kill('SIGKILL');
      settle({
        ok: false,
        message: 'Sandbox viability check timed out.',
        details:
          `The V8 sandbox (isolated-vm) did not initialize within ${SANDBOX_CHECK_TIMEOUT_MS}ms. ` +
          'This usually indicates a hung native module load. ' +
          'Try `npm rebuild` or `rm -rf node_modules && npm install` to rebuild dependencies.',
      });
    }, SANDBOX_CHECK_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    child.on('close', (code, signal) => {
      if (settled) return;

      if (code === 0 && !signal) {
        settle({ ok: true, message: 'V8 sandbox loaded successfully.' });
        return;
      }

      const stderr = stderrOutput.trim();
      let message = 'Failed to initialize the V8 sandbox (isolated-vm).';
      let hint: string | undefined;

      if (signal) {
        message = `V8 sandbox crashed with signal ${signal}.`;
        if (signal === 'SIGSEGV' || signal === 'SIGILL') {
          hint = 'This is often caused by an unsupported Node.js version. Please use Node.js 24 or 26.';
        }
      } else if (stderr.includes('NODE_MODULE_VERSION')) {
        message = 'Native module ABI mismatch detected.';
        hint =
          'You likely changed Node.js versions without rebuilding dependencies. ' +
          'Run `npm rebuild` or `rm -rf node_modules && npm install` to fix this.';
      } else if (stderr.includes('Cannot find package')) {
        message = 'Missing required dependency: @utcp/code-mode';
        hint = 'Run `npm install` to ensure all dependencies are present.';
      }

      const details = [hint, stderr].filter(Boolean).join('\n') || `Process exited with code ${code}`;
      settle({ ok: false, message, details });
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        message: 'Failed to spawn sandbox check process.',
        details: err.message,
      });
    });
  });
}
