/**
 * The V8 sandbox preflight cache (src/utils/preflight-checks.ts): a cached
 * "the sandbox loads" verdict is reused only for the same runtime (Node.js
 * version, platform, architecture), the same installation (the resolved
 * @utcp/code-mode entry) and the same resolved @utcp/code-mode and
 * isolated-vm versions. Anything else runs the real check again; doctor
 * never uses the cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkSandboxViability,
  getSandboxCacheMarkerPath,
  resolveSandboxFingerprint,
  type PreflightCheckResult,
  type SandboxFingerprint,
} from '../src/utils/preflight-checks.js';

const OK: PreflightCheckResult = { ok: true, message: 'V8 sandbox loaded successfully.' };

/** The real installation's fingerprint (this checkout's node_modules). */
function realFingerprint(): SandboxFingerprint {
  const fingerprint = resolveSandboxFingerprint();
  if (fingerprint === null) throw new Error('the sandbox packages do not resolve in this checkout');
  return fingerprint;
}

function writeMarker(content: unknown): void {
  writeFileSync(getSandboxCacheMarkerPath(), JSON.stringify(content));
}

function readMarker(): unknown {
  return JSON.parse(readFileSync(getSandboxCacheMarkerPath(), 'utf-8')) as unknown;
}

describe('resolveSandboxFingerprint', () => {
  let root: string;

  beforeEach(() => {
    // Real path: module resolution reports resolved (symlink-free) paths.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-sandbox-fp-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A fake installation: the code-mode fork (exports map without ./package.json) and isolated-vm. */
  function fakeInstall(isolatedVmVersion: string): string {
    const codeMode = join(root, 'node_modules', '@utcp', 'code-mode');
    mkdirSync(join(codeMode, 'dist'), { recursive: true });
    writeFileSync(
      join(codeMode, 'package.json'),
      JSON.stringify({
        name: '@provos/utcp-code-mode',
        version: '1.2.13-ic.1',
        main: 'dist/index.cjs',
        exports: { '.': { require: './dist/index.cjs', default: './dist/index.cjs' } },
      }),
    );
    // A nested package.json that names no package must not be taken for the package's own.
    writeFileSync(join(codeMode, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
    writeFileSync(join(codeMode, 'dist', 'index.cjs'), 'module.exports = {};\n');
    const ivm = join(root, 'node_modules', 'isolated-vm');
    mkdirSync(ivm, { recursive: true });
    writeFileSync(
      join(ivm, 'package.json'),
      JSON.stringify({ name: 'isolated-vm', version: isolatedVmVersion, main: 'isolated-vm.js' }),
    );
    writeFileSync(join(ivm, 'isolated-vm.js'), 'module.exports = {};\n');
    const app = join(root, 'app');
    mkdirSync(app, { recursive: true });
    return join(app, 'index.js');
  }

  it('reads the versions from the resolved packages, although the code-mode exports map hides its package.json', () => {
    const from = fakeInstall('7.0.1');

    const fingerprint = resolveSandboxFingerprint(from);

    expect(fingerprint).toEqual({
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      utcpVersion: '1.2.13-ic.1',
      utcpEntryPath: join(root, 'node_modules', '@utcp', 'code-mode', 'dist', 'index.cjs'),
      isolatedVmVersion: '7.0.1',
    });
  });

  it('changes when only isolated-vm is upgraded', () => {
    const from = fakeInstall('7.0.1');
    const before = resolveSandboxFingerprint(from);
    writeFileSync(
      join(root, 'node_modules', 'isolated-vm', 'package.json'),
      JSON.stringify({ name: 'isolated-vm', version: '7.0.2', main: 'isolated-vm.js' }),
    );

    const after = resolveSandboxFingerprint(from);

    expect(after?.isolatedVmVersion).toBe('7.0.2');
    expect(after).not.toEqual(before);
  });

  it('is null when isolated-vm cannot be resolved', () => {
    const from = fakeInstall('7.0.1');
    rmSync(join(root, 'node_modules', 'isolated-vm'), { recursive: true, force: true });

    expect(resolveSandboxFingerprint(from)).toBeNull();
  });

  it("resolves this checkout's installation", () => {
    const req = createRequire(import.meta.url);
    const ivmPackage = JSON.parse(readFileSync(req.resolve('isolated-vm/package.json'), 'utf-8')) as {
      version: string;
    };

    const fingerprint = realFingerprint();

    expect(fingerprint.utcpEntryPath).toBe(req.resolve('@utcp/code-mode'));
    expect(fingerprint.isolatedVmVersion).toBe(ivmPackage.version);
    expect(fingerprint.utcpVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('checkSandboxViability cache', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-preflight-cache-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs the check once, records the full fingerprint owner-only, and then answers from the cache', async () => {
    const probe = vi.fn(async () => OK);

    expect(await checkSandboxViability({ probe })).toEqual(OK);
    expect(readMarker()).toEqual(realFingerprint());
    expect(statSync(getSandboxCacheMarkerPath()).mode & 0o777).toBe(0o600);

    expect(await checkSandboxViability({ probe })).toEqual({ ok: true, message: 'cached' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('changing the isolated-vm version invalidates the cache', async () => {
    const current = realFingerprint();
    writeMarker({ ...current, isolatedVmVersion: `${current.isolatedVmVersion}-older` });
    const probe = vi.fn(async () => OK);

    expect(await checkSandboxViability({ probe })).toEqual(OK);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(readMarker()).toEqual(current);
  });

  it.each([
    ['architecture', { arch: 'not-this-arch' }],
    ['platform', { platform: 'not-this-platform' }],
    ['Node.js version', { nodeVersion: '0.0.1' }],
    ['installation (another checkout sharing the home)', { utcpEntryPath: '/elsewhere/node_modules/x/index.cjs' }],
    ['@utcp/code-mode version', { utcpVersion: '0.0.1' }],
  ])('a marker for another %s runs the check again', async (_label, difference) => {
    writeMarker({ ...realFingerprint(), ...difference });
    const probe = vi.fn(async () => OK);

    await checkSandboxViability({ probe });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('ignores a marker from before the fingerprint (Node.js and code-mode versions only)', async () => {
    const current = realFingerprint();
    writeMarker({ nodeVersion: current.nodeVersion, utcpVersion: current.utcpVersion });
    const probe = vi.fn(async () => OK);

    await checkSandboxViability({ probe });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(readMarker()).toEqual(current);
  });

  it('records nothing when the check fails', async () => {
    const failure: PreflightCheckResult = { ok: false, message: 'Native module ABI mismatch detected.' };
    const probe = vi.fn(async () => failure);

    expect(await checkSandboxViability({ probe })).toEqual(failure);
    expect(await checkSandboxViability({ probe })).toEqual(failure);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(existsSync(getSandboxCacheMarkerPath())).toBe(false);
  });

  it('without the cache (doctor) runs the real check despite a matching marker and writes nothing', async () => {
    writeMarker(realFingerprint());
    const before = readFileSync(getSandboxCacheMarkerPath(), 'utf-8');
    const probe = vi.fn(async () => OK);

    expect(await checkSandboxViability({ useCache: false, probe })).toEqual(OK);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(readFileSync(getSandboxCacheMarkerPath(), 'utf-8')).toBe(before);
  });

  it('without the cache, does not create the home', async () => {
    const missing = resolve(home, 'not-created');
    process.env.IRONCURTAIN_HOME = missing;

    await checkSandboxViability({ useCache: false, probe: async () => OK });

    expect(existsSync(missing)).toBe(false);
  });
});
