import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { MCPServerConfig } from '../src/config/types.js';
import { resolveContainerSpawnCommand, commandExists } from '../src/trusted-process/container-command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The shipped github entry: github-mcp-server v2.1.0 pinned by digest (the
 * tool annotations describe that release), passed through untouched by the
 * docker→container translation.
 */
const GITHUB_IMAGE =
  'ghcr.io/github/github-mcp-server@sha256:f6056fc10bfffcc8c81a6417a2e9ca12808647e8dd6049642a4feaadee0e0f8a';
const GITHUB_ARGS = ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', GITHUB_IMAGE];

describe('shipped mcp-servers.json container images', () => {
  const servers = JSON.parse(readFileSync(resolve(__dirname, '../src/config/mcp-servers.json'), 'utf-8')) as Record<
    string,
    MCPServerConfig
  >;

  it('runs the github server from the digest-pinned v2.1.0 image', () => {
    expect(servers.github.command).toBe('docker');
    expect(servers.github.args).toEqual(GITHUB_ARGS);
  });

  it('pins every container image it runs by digest', () => {
    for (const [name, server] of Object.entries(servers)) {
      if (server.command !== 'docker' && server.command !== 'container') continue;
      const image = server.args.at(-1);
      expect(image, `${name} image`).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });
});

function exists(bins: string[]): (bin: string) => boolean {
  return (bin) => bins.includes(bin);
}

describe('resolveContainerSpawnCommand', () => {
  it('translates docker run to container when only container exists', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists(['container']));
    expect(spec.translated).toBe(true);
    expect(spec.command).toBe('container');
    // Argument array passes through untouched.
    expect(spec.args).toEqual(GITHUB_ARGS);
  });

  it('keeps docker when docker exists (even alongside container)', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists(['docker', 'container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('keeps docker when neither binary exists (connect failure handles it)', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists([]));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('never touches non-run docker subcommands', () => {
    const spec = resolveContainerSpawnCommand('docker', ['exec', 'c1', 'sh'], exists(['container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('never touches non-docker commands', () => {
    const spec = resolveContainerSpawnCommand('npx', ['-y', 'some-server'], exists(['container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('npx');
  });
});

describe('commandExists', () => {
  it('finds a binary that exists and caches the probe', () => {
    expect(commandExists('node')).toBe(true);
    expect(commandExists('node')).toBe(true);
  });

  it('reports a missing binary as absent', () => {
    expect(commandExists('ironcurtain-definitely-not-a-binary-xyz')).toBe(false);
  });
});
