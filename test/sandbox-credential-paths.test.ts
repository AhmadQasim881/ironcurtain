import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCredentialStoreProtectedPaths,
  computeSandboxCredentialPaths,
} from '../src/config/credential-stores.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { isForbiddenEnvKey } from '../src/config/trusted-env.js';
import { inheritedEnv } from '../src/trusted-process/child-env.js';
import { baselineDenyRead, planServerSandboxing } from '../src/trusted-process/sandbox-integration.js';
import {
  parseSandboxCredentialPaths,
  sandboxCredentialPathsEnv,
} from '../src/trusted-process/sandbox-credential-paths.js';

describe('sandbox credential path metadata', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-credential-meta-')));
    mkdirSync(join(root, 'home'));
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('IRONCURTAIN_HOME', join(root, 'home', '.ironcurtain'));
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(root, 'anthropic'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    vi.stubEnv('IRONCURTAIN_ENV_FILE', join(root, 'explicit.env'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('carries only paths and retains all configured stores without reading any files', () => {
    const extra = join(root, 'custom-store');
    const paths = computeSandboxCredentialPaths({ extraPaths: [extra] });
    expect(paths).toEqual(
      expect.arrayContaining([
        extra,
        join(root, 'anthropic', 'credentials'),
        join(root, 'xdg', 'anthropic', 'credentials'),
        join(root, 'home', '.config', 'anthropic', 'credentials'),
        join(root, 'explicit.env'),
      ]),
    );
    expect(parseSandboxCredentialPaths(Object.values(sandboxCredentialPathsEnv(paths))[0])).toEqual(paths);
    expect(baselineDenyRead(paths)).toEqual(expect.arrayContaining(paths));
    const plan = planServerSandboxing(
      { sample: { command: 'node', args: [], sandbox: {} } },
      join(root, 'workspace'),
      { available: true, platformSupported: true, problems: [], warnings: [] },
      'enforce',
      paths,
    );
    const sample = plan.resolved.get('sample');
    expect(sample?.sandboxed).toBe(true);
    if (sample?.sandboxed) expect(sample.config.denyRead).toEqual(expect.arrayContaining(paths));
  });

  it('covers every configured protected store in each shipped sandbox except the documented SSH and netrc entries', () => {
    const protection = { extraPaths: [join(root, 'additional-store')] };
    const servers = JSON.parse(
      readFileSync(new URL('../src/config/mcp-servers.json', import.meta.url), 'utf8'),
    ) as Record<string, MCPServerConfig>;
    const expectedPaths = computeCredentialStoreProtectedPaths(protection).filter(
      (path) => path !== join(root, 'home', '.ssh') && path !== join(root, 'home', '.netrc'),
    );
    const plan = planServerSandboxing(
      servers,
      join(root, 'workspace'),
      { available: true, platformSupported: true, problems: [], warnings: [] },
      'enforce',
      computeSandboxCredentialPaths(protection),
    );
    for (const [name, resolved] of plan.resolved) {
      if (resolved.sandboxed) expect(resolved.config.denyRead, name).toEqual(expect.arrayContaining(expectedPaths));
    }
  });

  it.each([
    'not json',
    '{}',
    '["relative"]',
    '["/bad\\u0000path"]',
    JSON.stringify(Array.from({ length: 257 }, () => '/path')),
  ])('refuses malformed path metadata', (value) => {
    expect(() => parseSandboxCredentialPaths(value)).toThrow();
  });
  it('refuses oversized metadata and keeps absent metadata compatible', () => {
    expect(parseSandboxCredentialPaths(undefined)).toEqual([]);
    expect(() => parseSandboxCredentialPaths(JSON.stringify(['/' + 'a'.repeat(4096)]))).toThrow();
    expect(() => parseSandboxCredentialPaths(' '.repeat(64 * 1024 + 1))).toThrow();
  });

  it('reserves internal path metadata instead of inheriting it into backends or credential files', () => {
    expect(isForbiddenEnvKey('SANDBOX_CREDENTIAL_PATHS')).toBe(true);
    expect(inheritedEnv({ SANDBOX_CREDENTIAL_PATHS: '["/path"]' })).not.toHaveProperty('SANDBOX_CREDENTIAL_PATHS');
  });
});
