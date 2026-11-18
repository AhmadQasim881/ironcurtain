import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolutionDefinitionOf } from '../src/pipeline/list-merge.js';
import { computeListHash } from '../src/pipeline/list-resolver.js';
import type { CompiledPolicyFile, DynamicListsFile } from '../src/pipeline/types.js';

type DependencyMap = Readonly<Record<string, string>>;

interface PackageManifest {
  readonly files: readonly string[];
  readonly dependencies: DependencyMap;
  readonly devDependencies?: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
}

interface LockfileEntry {
  readonly version?: string;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly dependencies?: DependencyMap;
  readonly devDependencies?: DependencyMap;
  readonly optionalDependencies?: DependencyMap;
}

interface ServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

const FILESYSTEM_SERVER = '@modelcontextprotocol/server-filesystem';
/**
 * The filesystem server version src/config/generated/tool-annotations.json
 * describes. Changing it means re-running `ironcurtain annotate-tools
 * --server filesystem` (2.x adds append_file, copy_file and
 * directory_tree.depth) and then updating this constant.
 */
const FILESYSTEM_SERVER_VERSION = '2026.8.31';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('npm package contents', () => {
  it('ships the authoritative dist workflow copy without duplicating source workflows', () => {
    const manifest = readJson('package.json') as PackageManifest;

    expect(manifest.files).toContain('dist/');
    expect(manifest.files).toContain('docker/');
    expect(manifest.files.some((path) => path.startsWith('src/workflow/workflows'))).toBe(false);
  });

  it('ships CHANGELOG.md, which the first run after an upgrade summarizes', () => {
    const manifest = readJson('package.json') as PackageManifest;
    expect(manifest.files).toContain('CHANGELOG.md');
  });

  it('pins the filesystem MCP server as an exact runtime dependency, in the manifest and the lockfile', () => {
    const manifest = readJson('package.json') as PackageManifest;
    expect(manifest.dependencies[FILESYSTEM_SERVER]).toBe(FILESYSTEM_SERVER_VERSION);
    expect(manifest.devDependencies?.[FILESYSTEM_SERVER]).toBeUndefined();
    expect(manifest.optionalDependencies?.[FILESYSTEM_SERVER]).toBeUndefined();

    const lock = readJson('package-lock.json') as { packages: Readonly<Record<string, LockfileEntry>> };
    const root = lock.packages[''];
    expect(root.dependencies?.[FILESYSTEM_SERVER]).toBe(FILESYSTEM_SERVER_VERSION);
    expect(root.devDependencies?.[FILESYSTEM_SERVER]).toBeUndefined();
    expect(root.optionalDependencies?.[FILESYSTEM_SERVER]).toBeUndefined();

    // A production install (`npm ci --omit=dev`) must not skip it.
    const locked = lock.packages[`node_modules/${FILESYSTEM_SERVER}`];
    expect(locked.version).toBe(FILESYSTEM_SERVER_VERSION);
    expect(locked.dev).toBeUndefined();
    expect(locked.optional).toBeUndefined();
  });

  it('declares tldts (the Public Suffix List behind the domain breadth checks) as a pinned runtime dependency', () => {
    const manifest = readJson('package.json') as PackageManifest;
    const lock = readJson('package-lock.json') as { packages: Readonly<Record<string, LockfileEntry>> };
    const locked = lock.packages['node_modules/tldts'];
    expect(manifest.dependencies.tldts).toBe(locked.version);
    expect(lock.packages[''].dependencies?.tldts).toBe(locked.version);
    expect(locked.dev).toBeUndefined();
    expect(locked.optional).toBeUndefined();
  });

  it('ships an mcp-servers.json that launches the pinned filesystem server with node, never npx', () => {
    const manifest = readJson('package.json') as PackageManifest;
    expect(manifest.files).toContain('src/config/mcp-servers.json');

    const servers = readJson('src/config/mcp-servers.json') as Record<string, ServerEntry>;
    expect(servers.filesystem.command).toBe('node');
    expect(servers.filesystem.args[0]).toBe(`node_modules/${FILESYSTEM_SERVER}/dist/index.js`);
    expect(servers.filesystem.args).toHaveLength(2);
    const viaNpx = Object.entries(servers).filter(
      ([, server]) => server.command === 'npx' && server.args.some((arg) => arg.includes(FILESYSTEM_SERVER)),
    );
    expect(viaNpx).toEqual([]);
  });
});

describe('shipped policy artifacts', () => {
  /** The artifacts of the shipped policy that the runtime loads (config/index.ts). */
  const RUNTIME_ARTIFACTS = ['compiled-policy.json', 'dynamic-lists.json', 'tool-annotations.json'];

  /** The file names copy-assets copies from src/config/generated into dist/config/generated. */
  function copiedGeneratedArtifacts(): string[] {
    const script = readFileSync('scripts/copy-assets.mjs', 'utf8');
    const loop = /for \(const file of \[([^\]]*)\]\) \{\n\s*const src = resolve\(generatedDir, file\);/.exec(script);
    expect(loop, 'copy-assets.mjs no longer has the generated-artifacts loop').not.toBeNull();
    return [...(loop?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('ships every artifact of the shipped policy, dynamic-lists.json included, in both src/ and dist/', () => {
    const manifest = readJson('package.json') as PackageManifest;
    const copied = copiedGeneratedArtifacts();
    for (const file of RUNTIME_ARTIFACTS) {
      expect(manifest.files).toContain(`src/config/generated/${file}`);
      expect(copied).toContain(file);
    }
  });

  it('ships a resolved value list for every dynamic list the shipped policy defines, resolved for that definition', () => {
    const policy = readJson('src/config/generated/compiled-policy.json') as CompiledPolicyFile;
    const lists = readJson('src/config/generated/dynamic-lists.json') as DynamicListsFile;
    const definitions = policy.listDefinitions ?? [];
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      const list = lists.lists[definition.name] as DynamicListsFile['lists'][string] | undefined;
      expect(list, `@${definition.name} has no entry in the shipped dynamic-lists.json`).toBeDefined();
      expect(list?.values.length).toBeGreaterThan(0);
      // The runtime prefers a user-refreshed list only when it was resolved for
      // the same definition, comparing this hash. A stale shipped hash would make
      // every user refresh of the list be ignored.
      expect(list?.inputHash).toBe(computeListHash(resolutionDefinitionOf(definition)));
    }
  });
});
