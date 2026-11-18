/**
 * node-pty loading for host-side PTYs. Apple Container's native exec now runs
 * under node-pty so its output can be filtered; node-pty is an optional
 * dependency whose 1.1.0 macOS prebuild needs its spawn-helper made
 * executable, which only the mux used to do.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Whether this checkout has the node-pty package itself (an --omit=optional install does not). */
const NODE_PTY_ON_DISK = existsSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'package.json'),
);

// The optional dependency is not installed (or failed to build).
vi.mock('node-pty', () => {
  throw new Error("Cannot find package 'node-pty'");
});

import {
  ensureSpawnHelperExecutable,
  inspectSpawnHelper,
  isNodePtyInstalled,
  loadNodePty,
  nodePtyRemediation,
  nodePtySpawnHelperPath,
  probeNodePty,
  repairNodePtySpawnHelper,
} from '../src/pty/node-pty-loader.js';
import { createAppleContainerManager } from '../src/docker/apple-container-manager.js';
import type { ExecFileFn } from '../src/docker/docker-manager.js';
import type { DockerAvailability } from '../src/docker/docker-probe.js';

describe('node-pty spawn-helper repair', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-pty-helper-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the execute bits to a helper shipped without them', () => {
    const helper = join(dir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);

    expect(ensureSpawnHelperExecutable(helper)).toEqual({ status: 'repaired', helperPath: helper });
    expect(statSync(helper).mode & 0o777).toBe(0o755);
    // Idempotent once executable.
    expect(ensureSpawnHelperExecutable(helper)).toEqual({ status: 'ok' });
  });

  it('leaves a missing helper to node-pty and does nothing off macOS', () => {
    expect(ensureSpawnHelperExecutable(join(dir, 'absent'))).toEqual({ status: 'ok' });
    expect(repairNodePtySpawnHelper('linux')).toEqual({ status: 'ok' });
  });

  it('locates the prebuilt helper next to the package entry point', () => {
    expect(nodePtySpawnHelperPath('/pkg/node-pty/lib/index.js', 'arm64')).toBe(
      '/pkg/node-pty/prebuilds/darwin-arm64/spawn-helper',
    );
  });

  it('inspects a helper without changing it (what doctor reports)', () => {
    const helper = join(dir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o644);

    expect(inspectSpawnHelper(helper)).toEqual({ status: 'not-executable', helperPath: helper });
    expect(statSync(helper).mode & 0o777).toBe(0o644);
    chmodSync(helper, 0o755);
    expect(inspectSpawnHelper(helper)).toEqual({ status: 'ok' });
    expect(inspectSpawnHelper(join(dir, 'absent'))).toEqual({ status: 'ok' });
  });
});

describe('node-pty remediation (BLD-10)', () => {
  it('rebuilds an installed but unbuilt node-pty, in a way that works for a global install', () => {
    const linux = nodePtyRemediation('linux', true);
    expect(linux).toContain('python3, make and a C++ compiler');
    // `npm rebuild -g @provos/ironcurtain` runs only IronCurtain's own scripts,
    // and `npm install node-pty` in the cwd does not reach a global install.
    // --ignore-scripts=false: with ignore-scripts=true in an npmrc (a common
    // reason node-pty was never built) the rebuild would silently do nothing.
    expect(linux).toContain('`npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false`');
    expect(linux).toContain('`npm rebuild node-pty --ignore-scripts=false` in a source checkout');
    expect(linux).not.toMatch(/npm install node-pty|rebuild -g @provos\/ironcurtain/);
    expect(nodePtyRemediation('darwin', true)).toContain('Xcode Command Line Tools');
  });

  it('reinstalls IronCurtain when npm deleted node-pty after its build failed', () => {
    // npm removes an optional dependency whose install script fails, so there
    // is nothing for `npm rebuild node-pty` to rebuild: it would match no
    // package and still report success.
    const linux = nodePtyRemediation('linux', false);
    expect(linux).toContain('python3, make and a C++ compiler');
    expect(linux).toContain('`npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`');
    expect(linux).toContain('`npm install` in a source checkout');
    expect(linux).not.toMatch(/npm rebuild|npm install node-pty/);
  });

  it('detects whether the package is on disk, whether or not it loads (the import is mocked here)', () => {
    expect(isNodePtyInstalled()).toBe(NODE_PTY_ON_DISK);
    expect(nodePtyRemediation('linux')).toBe(nodePtyRemediation('linux', NODE_PTY_ON_DISK));
  });
});

describe('probeNodePty', () => {
  it('reports a node-pty that does not load, with the loader error', async () => {
    const probe = await probeNodePty({
      importNodePty: () => Promise.reject(new Error('Failed to load native module: pty.node, checked: build/Release')),
      isNodePtyInstalled: () => true,
    });
    expect(probe).toEqual({
      status: 'unavailable',
      detail: 'Failed to load native module: pty.node, checked: build/Release',
      installed: true,
    });
  });

  it('reports whether the package that does not load is on disk at all', async () => {
    const probe = await probeNodePty({
      importNodePty: () => Promise.reject(new Error("Cannot find package 'node-pty'")),
      isNodePtyInstalled: () => false,
    });
    expect(probe).toEqual({ status: 'unavailable', detail: "Cannot find package 'node-pty'", installed: false });
  });

  it('reports the real optional package as unavailable when it cannot be imported', async () => {
    // node-pty is mocked to throw at the top of this file.
    expect(await probeNodePty()).toMatchObject({ status: 'unavailable', installed: NODE_PTY_ON_DISK });
  });

  it('reports a non-executable spawn-helper without repairing it, and the version when it loads', async () => {
    const loads = () => Promise.resolve({});
    expect(
      await probeNodePty({
        importNodePty: loads,
        inspectSpawnHelper: () => ({ status: 'not-executable', helperPath: '/ro/spawn-helper' }),
      }),
    ).toEqual({ status: 'spawn-helper-not-executable', helperPath: '/ro/spawn-helper' });
    expect(
      await probeNodePty({
        importNodePty: loads,
        inspectSpawnHelper: () => ({ status: 'ok' }),
        readVersion: () => '1.1.0',
      }),
    ).toEqual({ status: 'ok', version: '1.1.0' });
  });
});

describe('loadNodePty', () => {
  it('explains how to get node-pty back when it cannot be loaded', async () => {
    await expect(
      loadNodePty({
        purpose: 'Apple Container interactive sessions',
        importNodePty: () => Promise.reject(new Error('Cannot find package')),
        isNodePtyInstalled: () => false,
      }),
    ).rejects.toThrow(
      /Apple Container interactive sessions need the optional node-pty package, which could not be loaded\..*npm install -g @provos\/ironcurtain/,
    );
    await expect(
      loadNodePty({
        purpose: 'Apple Container interactive sessions',
        importNodePty: () => Promise.reject(new Error('Failed to load native module: pty.node')),
        isNodePtyInstalled: () => true,
      }),
    ).rejects.toThrow(/npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false/);
  });

  it('refuses a spawn-helper it cannot make executable', async () => {
    const nodePty = {} as typeof import('node-pty');
    await expect(
      loadNodePty({
        purpose: 'test',
        importNodePty: async () => nodePty,
        repairSpawnHelper: () => ({ status: 'not-executable', helperPath: '/ro/spawn-helper' }),
      }),
    ).rejects.toThrow(/chmod \+x "\/ro\/spawn-helper"/);
    await expect(
      loadNodePty({ purpose: 'test', importNodePty: async () => nodePty, repairSpawnHelper: () => ({ status: 'ok' }) }),
    ).resolves.toBe(nodePty);
  });

  it('makes Apple native PTY exec fail with that guidance instead of running unfiltered', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' })) as unknown as ExecFileFn;
    const available = async (): Promise<DockerAvailability> => ({ available: true });
    const runtime = createAppleContainerManager(exec, available);

    await expect(runtime.execPty?.('c1', ['/etc/ironcurtain/start-claude.sh'])).rejects.toThrow(
      /Apple Container interactive sessions need the optional node-pty package/,
    );
    expect(exec).not.toHaveBeenCalled();
  });
});
