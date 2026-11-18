/**
 * Dependency hygiene (BLD-9, BLD-10): the install-script policy for
 * development installs, the sandbox-runtime pin, and the Dependabot groups
 * for security updates. The npm audit gate has its own tests
 * (test/npm-audit-gate.test.ts).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  gypfile?: boolean;
  allowScripts?: Record<string, unknown>;
}

interface LockEntry {
  version?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf-8'));
}

const manifest = readJson('package.json') as Manifest;
const lock = readJson('package-lock.json') as { packages: Record<string, LockEntry | undefined> };
const allowScripts = manifest.allowScripts ?? {};

/** The package name of a lockfile path such as node_modules/@scope/name or node_modules/a/node_modules/b. */
function packageNameOf(lockPath: string): string {
  const segments = lockPath.split('node_modules/');
  return segments[segments.length - 1].replace(/\/$/u, '');
}

/**
 * The install scripts npm would run for an installed package, as npm 11
 * decides them: preinstall, install and postinstall, plus a synthetic
 * `node-gyp rebuild` when the package has a binding.gyp, no install or
 * preinstall script and no `"gypfile": false`.
 */
function installScriptsOf(packageDir: string): string[] {
  const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as Manifest;
  const scripts = installed.scripts ?? {};
  const found = ['preinstall', 'install', 'postinstall'].filter((event) => typeof scripts[event] === 'string');
  if (!scripts.preinstall && !scripts.install && installed.gypfile !== false) {
    if (existsSync(join(packageDir, 'binding.gyp'))) found.push('install (node-gyp rebuild)');
  }
  return found;
}

describe('allowScripts (development installs)', () => {
  it('names packages without versions, so dependency bumps need no edit', () => {
    expect(Object.keys(allowScripts).length).toBeGreaterThan(0);
    for (const [name, allowed] of Object.entries(allowScripts)) {
      expect(name, name).toMatch(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/u);
      expect(typeof allowed, name).toBe('boolean');
    }
  });

  it('runs the native builds IronCurtain needs and denies the CUDA download', () => {
    // isolated-vm is the V8 sandbox (compiled where it has no prebuild, e.g.
    // Intel Macs); node-pty has no Linux prebuild and is compiled on install.
    expect(allowScripts['isolated-vm']).toBe(true);
    expect(allowScripts['node-pty']).toBe(true);
    // onnxruntime-node's postinstall fetches the CUDA providers (273 MB) from
    // NuGet; the CPU runtime the memory server uses ships in the package.
    expect(allowScripts['onnxruntime-node']).toBe(false);
  });

  it('decides every install script in the installed dependency tree', () => {
    const undecided: string[] = [];
    let inspected = 0;
    for (const [lockPath, entry] of Object.entries(lock.packages)) {
      if (lockPath === '' || entry?.link === true || entry?.hasInstallScript !== true) continue;
      const packageDir = join(ROOT, lockPath);
      // Platform-specific optional packages (fsevents off macOS) are not installed.
      if (!existsSync(join(packageDir, 'package.json'))) continue;
      inspected++;
      const scripts = installScriptsOf(packageDir);
      const name = packageNameOf(lockPath);
      if (scripts.length > 0 && !(name in allowScripts)) undecided.push(`${name} (${scripts.join(', ')})`);
    }
    expect(inspected, 'no installed package with an install script was found').toBeGreaterThan(0);
    expect(
      undecided,
      'add each package to "allowScripts" in package.json: true to run its install scripts, false to skip them',
    ).toEqual([]);
  });
});

describe('@anthropic-ai/sandbox-runtime', () => {
  const SANDBOX_RUNTIME = '@anthropic-ai/sandbox-runtime';

  it('is pinned to exactly one version, so every upgrade is a deliberate, tested bump', () => {
    const spec = manifest.dependencies?.[SANDBOX_RUNTIME] ?? '';
    // An exact version, or a caret range below 0.1.0, which matches only that version.
    expect(spec).toMatch(/^(\d+\.\d+\.\d+|\^0\.0\.\d+)$/u);
    const installed = lock.packages[`node_modules/${SANDBOX_RUNTIME}`]?.version;
    expect(installed).toBe(spec.replace(/^\^/u, ''));
    expect(lock.packages['']?.dependencies?.[SANDBOX_RUNTIME]).toBe(spec);
  });
});

describe('dependabot.yml security updates', () => {
  interface Group {
    'applies-to'?: string;
    patterns?: string[];
    'exclude-patterns'?: string[];
  }
  const config = YAML.parse(readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf-8')) as {
    updates: Array<{ 'package-ecosystem': string; directory: string; groups?: Record<string, Group> }>;
  };
  const npm = config.updates.find((update) => update['package-ecosystem'] === 'npm' && update.directory === '/');
  const groups = Object.entries(npm?.groups ?? {});
  const securityGroups = groups.filter(([, group]) => group['applies-to'] === 'security-updates');

  /** Dependabot's wildcard: `*` matches any characters, `/` included. */
  function wildcard(name: string, pattern: string): boolean {
    const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'));
    return new RegExp(`^${source.join('.*')}$`, 'u').test(name);
  }

  function matches(group: Group, name: string): boolean {
    const included = (group.patterns ?? []).some((pattern) => wildcard(name, pattern));
    return included && !(group['exclude-patterns'] ?? []).some((pattern) => wildcard(name, pattern));
  }

  /** The security group a package's update lands in: the first one that matches it. */
  function securityGroupOf(name: string): string | undefined {
    return securityGroups.find(([, group]) => matches(group, name))?.[0];
  }

  it('groups every security update except the MCP servers, which keep their own review', () => {
    expect(securityGroups.length).toBeGreaterThan(0);
    for (const name of ['undici', 'node-forge', 'zod', '@modelcontextprotocol/sdk', 'shell-quote']) {
      expect(securityGroupOf(name), name).toBe('security');
    }
    for (const name of ['@cyanheads/git-mcp-server', '@modelcontextprotocol/server-filesystem']) {
      expect(securityGroupOf(name), name).toBeUndefined();
      expect(manifest.dependencies?.[name], name).toBeDefined();
    }
  });

  it('puts the packages bundled into the web UI in their own group, which calls for a release', () => {
    const webUi = readJson('packages/web-ui/package.json') as Manifest;
    // The Svelte runtime is bundled although the web UI lists it as a devDependency.
    const bundled = [...Object.keys(webUi.dependencies ?? {}), 'svelte'];
    expect(bundled).toContain('dompurify');
    for (const name of bundled) {
      expect(securityGroupOf(name), name).toBe('web-ui-security');
    }
  });
});
