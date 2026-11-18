/**
 * Tool-annotation overlay (WP-09).
 *
 * The user's ~/.ironcurtain/generated/tool-annotations.json used to replace
 * the package's annotations wholesale, and one `annotate-tools` run copied
 * every package entry into it, so package annotation fixes never reached that
 * user again. These tests pin the overlay semantics: per-server merge in every
 * loader, migration of legacy snapshots, adoption of reviewed package entries
 * by annotate-tools, pinning, --reset, the doctor report, and the provenance
 * stamps on the bundled file that make all of this work after a package fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Lets a test point the "shipped" annotations dir at a temp dir (to damage
// it) for code that calls getPackageGeneratedDir() itself. Unset: the real one.
const shippedDirOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/index.js')>();
  return {
    ...actual,
    getPackageGeneratedDir: () => shippedDirOverride.dir ?? actual.getPackageGeneratedDir(),
  };
});

import { getPackageGeneratedDir, loadConfig, loadGeneratedPolicy } from '../src/config/index.js';
import {
  computeAnnotationContentDigest,
  damagedToolAnnotationsFile,
  describeOverlayWarnings,
  loadToolAnnotations,
  mergeToolAnnotationOverlay,
  readToolAnnotationsFile,
  resolveServerOverlay,
  TOOL_ANNOTATIONS_INVALID,
  ToolAnnotationsFileError,
  warnOnAnnotationOverlay,
} from '../src/config/tool-annotations-overlay.js';
import {
  LEGACY_OVERLAY_BACKUP_FILENAME,
  migrateOverlay,
  planServerAnnotation,
  promoteOverlayEntries,
  resetToolAnnotationsOverlay,
  reusableAnnotations,
  stampPackageAnnotations,
  updateAnnotationOverlay,
} from '../src/pipeline/annotation-overlay.js';
import { loadStoredToolAnnotationsFile, loadToolAnnotationsFile } from '../src/pipeline/pipeline-shared.js';
import { main as annotateMain, parseAnnotateArgs, validateAnnotateArgs } from '../src/pipeline/annotate.js';
import { checkAnnotationOverlay, checkPolicyArtifacts } from '../src/doctor/checks.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type {
  CompiledPolicyFile,
  StoredServerAnnotations,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE = 'tool-annotations.json';

function tool(server: string, toolName: string, args: StoredToolAnnotation['args']): StoredToolAnnotation {
  return { toolName, serverName: server, comment: `${toolName} tool`, args, inputSchema: {} };
}

/** Old and new revisions of a git annotation: the new one adds write-path (a "security fix"). */
const GIT_V1 = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path'] })];
const GIT_V2 = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path', 'write-path'] })];
const FS_TOOLS = [tool('filesystem', 'read_file', { path: ['read-path'] })];
const FETCH_TOOLS = [tool('fetch', 'http_fetch', { url: ['fetch-url'] })];

function packageEntry(
  inputHash: string,
  tools: StoredToolAnnotation[],
  superseded?: string[],
): StoredServerAnnotations {
  return {
    inputHash,
    contentDigest: computeAnnotationContentDigest(tools),
    source: 'package',
    producerVersion: '1.0.0',
    ...(superseded ? { supersededDigests: superseded } : {}),
    tools,
  };
}

/** Package base: git was fixed (v1 -> v2) and its inputHash changed with the new server version. */
function packageFile(): StoredToolAnnotationsFile {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    servers: {
      filesystem: packageEntry('fs-hash', FS_TOOLS),
      git: packageEntry('git-hash-v2', GIT_V2, [computeAnnotationContentDigest(GIT_V1)]),
      fetch: packageEntry('fetch-hash', FETCH_TOOLS),
    },
  };
}

/** What annotate-tools wrote before overlays: a full copy, no provenance. */
function legacySnapshot(): StoredToolAnnotationsFile {
  return {
    generatedAt: '2025-12-01T00:00:00.000Z',
    servers: {
      filesystem: { inputHash: 'fs-hash', tools: FS_TOOLS },
      git: { inputHash: 'git-hash-v1', tools: GIT_V1 },
      fetch: { inputHash: 'fetch-hash', tools: FETCH_TOOLS },
    },
  };
}

function userEntry(inputHash: string, tools: StoredToolAnnotation[], extra: Partial<StoredServerAnnotations> = {}) {
  return {
    inputHash,
    contentDigest: computeAnnotationContentDigest(tools),
    source: 'user' as const,
    producerVersion: '1.0.0',
    ...extra,
    tools,
  };
}

let root: string;
let packageDir: string;
let userDir: string;

function writeJson(dir: string, name: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), JSON.stringify(data, null, 2) + '\n');
}

function readAnnotationsJson(path: string): StoredToolAnnotationsFile {
  return JSON.parse(readFileSync(path, 'utf-8')) as StoredToolAnnotationsFile;
}

const MINIMAL_POLICY: CompiledPolicyFile = {
  generatedAt: 'x',
  constitutionHash: 'x',
  inputHash: 'x',
  rules: [],
};

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'ironcurtain-overlay-'));
  packageDir = resolve(root, 'package');
  userDir = resolve(root, 'home', 'generated');
  writeJson(packageDir, FILE, packageFile());
  writeJson(packageDir, 'compiled-policy.json', MINIMAL_POLICY);
});

afterEach(() => {
  shippedDirOverride.dir = undefined;
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-server merge in the loaders
// ---------------------------------------------------------------------------

describe('per-server overlay merge', () => {
  it('an overlay listing one server does not drop the others', () => {
    const githubTools = [tool('github', 'list_issues', { owner: ['github-owner'] })];
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { github: userEntry('gh-live', githubTools) },
    });

    const { toolAnnotations, toolAnnotationsOverlay } = loadGeneratedPolicy({
      policyDir: packageDir,
      toolAnnotationsDir: userDir,
      fallbackDir: packageDir,
    });

    expect(Object.keys(toolAnnotations.servers).sort()).toEqual(['fetch', 'filesystem', 'git', 'github']);
    expect(toolAnnotations.servers.git.tools).toEqual(GIT_V2);
    expect(toolAnnotations.servers.github.tools).toEqual(githubTools);
    expect(toolAnnotationsOverlay.overlayPath).toBe(resolve(userDir, FILE));
    expect(toolAnnotationsOverlay.decisions).toEqual([{ server: 'github', resolution: 'user-only', legacy: false }]);
  });

  it('a full legacy snapshot whose git entry equals an old package entry resolves to the new package entry', () => {
    writeJson(userDir, FILE, legacySnapshot());

    const { toolAnnotations, toolAnnotationsOverlay } = loadGeneratedPolicy({
      policyDir: packageDir,
      toolAnnotationsDir: userDir,
      fallbackDir: packageDir,
    });

    // Before the overlay, the snapshot replaced the package file wholesale and git stayed at v1.
    expect(toolAnnotations.servers.git.tools).toEqual(GIT_V2);
    expect(toolAnnotations.servers.git.inputHash).toBe('git-hash-v2');
    expect(toolAnnotationsOverlay.decisions).toEqual([
      { server: 'fetch', resolution: 'identical', legacy: true },
      { server: 'filesystem', resolution: 'identical', legacy: true },
      { server: 'git', resolution: 'superseded', legacy: true },
    ]);
    // Stale copies resolve silently.
    expect(describeOverlayWarnings(toolAnnotationsOverlay)).toEqual([]);
  });

  it('a legacy entry with the same inputHash as the package entry gives way to it, with a note', () => {
    const handEdited = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['none'] })];
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'git-hash-v2', tools: handEdited } } });

    const loaded = loadToolAnnotations(userDir, packageDir);
    expect(loaded?.annotations.servers.git.tools).toEqual(GIT_V2);
    expect(loaded?.overlay.decisions).toEqual([{ server: 'git', resolution: 'same-input', legacy: true }]);
    const [note] = describeOverlayWarnings(loaded?.overlay ?? { decisions: [] });
    expect(note).toMatch(/^Note: ignoring your tool annotations for "git"/);
    expect(note).toContain('annotate-tools --server git --pin');
  });

  it('a genuinely divergent legacy entry still applies, with a warning', () => {
    const otherTools = [
      tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'], depth: ['none'] }),
    ];
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'git-hash-live', tools: otherTools } } });

    const loaded = loadToolAnnotations(userDir, packageDir);
    expect(loaded?.annotations.servers.git.tools).toEqual(otherTools);
    expect(loaded?.overlay.decisions).toEqual([{ server: 'git', resolution: 'user', legacy: true }]);
    const [warning] = describeOverlayWarnings(loaded?.overlay ?? { decisions: [] });
    expect(warning).toMatch(/^Warning: tool annotations for "git" .* written by an older annotate-tools/);
    expect(warning).toContain('annotate-tools --reset --server git');
  });

  it('a stamped user entry for different tools applies silently', () => {
    const otherTools = [
      tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'], depth: ['none'] }),
    ];
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: userEntry('git-hash-live', otherTools) } });

    const loaded = loadToolAnnotations(userDir, packageDir);
    expect(loaded?.annotations.servers.git.tools).toEqual(otherTools);
    expect(loaded?.overlay.decisions).toEqual([{ server: 'git', resolution: 'user', legacy: false }]);
    expect(describeOverlayWarnings(loaded?.overlay ?? { decisions: [] })).toEqual([]);
  });

  it('a stamped user entry gives way once the package ships reviewed annotations for the same tools', () => {
    const llmTools = [
      tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'], depth: ['none'] }),
    ];
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: userEntry('git-hash-v2', llmTools) } });

    const loaded = loadToolAnnotations(userDir, packageDir);
    expect(loaded?.annotations.servers.git.tools).toEqual(GIT_V2);
    expect(loaded?.overlay.decisions[0].resolution).toBe('same-input');
  });

  it('a user-pinned divergent entry wins, with a warning', () => {
    const pinnedTools = [
      tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path', 'write-path', 'delete-path'] }),
    ];
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { git: userEntry('git-hash-v2', pinnedTools, { pinned: true }) },
    });

    const { toolAnnotations, toolAnnotationsOverlay } = loadGeneratedPolicy({
      policyDir: packageDir,
      toolAnnotationsDir: userDir,
      fallbackDir: packageDir,
    });
    expect(toolAnnotations.servers.git.tools).toEqual(pinnedTools);
    expect(toolAnnotationsOverlay.decisions).toEqual([{ server: 'git', resolution: 'pinned', legacy: false }]);

    const written: string[] = [];
    warnOnAnnotationOverlay(toolAnnotationsOverlay, (text) => written.push(text));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^Warning: your pinned tool annotations for "git" .* override the reviewed annotations/);
    expect(written[0]).toContain('annotate-tools --reset --server git');
  });

  it('pinned entries identical to the package resolve to the package without a warning', () => {
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { git: userEntry('git-hash-v2', GIT_V2, { pinned: true }) },
    });
    const loaded = loadToolAnnotations(userDir, packageDir);
    expect(loaded?.overlay.decisions[0].resolution).toBe('identical');
    expect(describeOverlayWarnings(loaded?.overlay ?? { decisions: [] })).toEqual([]);
  });

  it('uses the package file alone when there is no overlay or the dirs are the same', () => {
    const viaPackage = loadToolAnnotations(packageDir, packageDir);
    expect(viaPackage?.overlay).toEqual({ decisions: [] });
    expect(viaPackage?.annotations).toEqual(packageFile());

    const viaMissingOverlay = loadToolAnnotations(userDir, packageDir);
    expect(viaMissingOverlay?.annotations).toEqual(packageFile());
    expect(viaMissingOverlay?.overlay.overlayPath).toBeUndefined();
  });

  it('the pipeline loaders apply the same merge', () => {
    writeJson(userDir, FILE, legacySnapshot());
    expect(loadStoredToolAnnotationsFile(userDir, packageDir)?.servers.git.tools).toEqual(GIT_V2);
    expect(loadToolAnnotationsFile(userDir, packageDir)?.servers.git.tools[0].args.localPath).toEqual([
      'read-path',
      'write-path',
    ]);
  });

  it('keeps a server named __proto__ as data', () => {
    const merged = mergeToolAnnotationOverlay(packageFile(), {
      generatedAt: 'x',
      servers: JSON.parse('{"__proto__": {"inputHash": "h", "tools": []}}') as StoredToolAnnotationsFile['servers'],
    });
    expect(Object.hasOwn(merged.annotations.servers, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(merged.annotations.servers)).toBe(Object.prototype);
  });
});

// ---------------------------------------------------------------------------
// The shipped annotations: a package fix reaches a user with a legacy snapshot
// ---------------------------------------------------------------------------

describe('shipped annotations with a legacy user snapshot', () => {
  it('a simulated package fix to git_clone reaches the user and restores the protected-path deny', () => {
    const shippedDir = getPackageGeneratedDir();
    const shipped = readAnnotationsJson(resolve(shippedDir, FILE));

    // The user ran annotate-tools before overlays: a provenance-free copy of every server.
    const snapshot: StoredToolAnnotationsFile = {
      generatedAt: shipped.generatedAt,
      servers: Object.fromEntries(
        Object.entries(shipped.servers).map(([name, entry]) => [
          name,
          { inputHash: entry.inputHash, tools: entry.tools },
        ]),
      ),
    };
    writeJson(userDir, FILE, snapshot);

    // The package then fixes git_clone (the audit's gap1 drift: `path` is a write target) and re-stamps.
    const fixed = structuredClone(shipped);
    const gitClone = fixed.servers.git.tools.find((t) => t.toolName === 'git_clone');
    if (!gitClone) throw new Error('shipped annotations lack git_clone');
    gitClone.args.path = ['write-path'];
    const restamped = stampPackageAnnotations(fixed, '99.0.0').file;
    writeJson(packageDir, FILE, restamped);

    const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy({
      policyDir: shippedDir,
      toolAnnotationsDir: userDir,
      fallbackDir: packageDir,
    });
    expect(toolAnnotations.servers.git).toEqual(restamped.servers.git);

    const home = resolve(root, 'home');
    const sandbox = resolve(home, 'sessions', 's1', 'sandbox');
    const evaluate = (annotations: StoredToolAnnotationsFile) =>
      new PolicyEngine(compiledPolicy, annotations, [home], sandbox).evaluate({
        requestId: 't',
        serverName: 'git',
        toolName: 'git_clone',
        arguments: {
          url: 'https://github.com/example/repo.git',
          localPath: resolve(sandbox, 'repo'),
          path: resolve(home, 'skills', 'helpful-skill'),
        },
        timestamp: '',
      });

    const effective = evaluate(toolAnnotations);
    expect(effective.decision).toBe('deny');
    expect(effective.rule).toBe('structural-protected-path');
    // The decision is exactly the one the package's annotations alone produce.
    expect(evaluate(restamped)).toEqual(effective);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('damaged annotation files fail closed', () => {
  it('a corrupt overlay stops policy loading with a coded error', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, FILE), '{not json');
    let caught: unknown;
    try {
      loadGeneratedPolicy({ policyDir: packageDir, toolAnnotationsDir: userDir, fallbackDir: packageDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID });
    expect(String(caught)).toContain('not valid JSON');
  });

  it('rejects entries without tools or with a non-boolean pin', () => {
    // Field-level messages from the runtime schema (src/types/policy-schema.ts).
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'h' } } });
    expect(() => readToolAnnotationsFile(resolve(userDir, FILE))).toThrow(
      /servers\.git\.tools: missing \(expected an array\)/,
    );
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'h', tools: [], pinned: 'yes' } } });
    expect(() => readToolAnnotationsFile(resolve(userDir, FILE))).toThrow(
      /servers\.git\.pinned: expected a boolean, got "yes"/,
    );
  });

  it('rejects a malformed serverInfo and accepts a well-formed one', () => {
    // Field-level messages from the runtime schema (src/types/policy-schema.ts).
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'h', tools: [], serverInfo: 'git' } } });
    expect(() => readToolAnnotationsFile(resolve(userDir, FILE))).toThrow(
      /servers\.git\.serverInfo: expected an object, got "git"/,
    );
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { git: { inputHash: 'h', tools: [], serverInfo: { name: 'git', version: 2 } } },
    });
    expect(() => readToolAnnotationsFile(resolve(userDir, FILE))).toThrow(
      /servers\.git\.serverInfo\.version: expected a string, got 2/,
    );
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { git: { inputHash: 'h', tools: [], serverInfo: ['git', '2.15.3'] } },
    });
    expect(() => readToolAnnotationsFile(resolve(userDir, FILE))).toThrow(
      /servers\.git\.serverInfo: expected an object, got an array/,
    );
    const serverInfo = { name: '@cyanheads/git-mcp-server', version: '2.15.3' };
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: { inputHash: 'h', tools: [], serverInfo } } });
    expect(readToolAnnotationsFile(resolve(userDir, FILE))?.servers.git.serverInfo).toEqual(serverInfo);
  });

  it('tells a damaged user overlay from a damaged shipped file', () => {
    const errorFrom = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return err;
      }
      throw new Error('expected an error');
    };
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, FILE), '{not json');
    const overlayError = errorFrom(() => loadToolAnnotations(userDir, packageDir));
    expect(damagedToolAnnotationsFile(overlayError, packageDir)).toBe('overlay');

    writeJson(userDir, FILE, { generatedAt: 'x', servers: {} });
    writeFileSync(resolve(packageDir, FILE), '{not json');
    const shippedError = errorFrom(() => loadToolAnnotations(userDir, packageDir));
    expect(damagedToolAnnotationsFile(shippedError, packageDir)).toBe('shipped');
    // Without a user overlay the shipped file is read directly.
    expect(
      damagedToolAnnotationsFile(
        errorFrom(() => loadToolAnnotations(packageDir, packageDir)),
        packageDir,
      ),
    ).toBe('shipped');

    expect(damagedToolAnnotationsFile(new Error('ENOENT'), packageDir)).toBeUndefined();
  });

  it('reports a missing annotations file as ENOENT', () => {
    const empty = resolve(root, 'empty');
    mkdirSync(empty);
    writeJson(empty, 'compiled-policy.json', MINIMAL_POLICY);
    expect(() => loadGeneratedPolicy({ policyDir: empty, toolAnnotationsDir: empty, fallbackDir: empty })).toThrow(
      /ENOENT/,
    );
  });
});

// ---------------------------------------------------------------------------
// Annotation files are read like the other policy artifacts
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('annotation files are read like policy artifacts', () => {
  // Annotations assign every argument's roles, so they decide which rules
  // match: like compiled-policy.json they must be regular files at their own
  // name that no other local user can rewrite.
  const GITHUB_TOOLS = [tool('github', 'list_issues', { owner: ['github-owner'] })];
  const overlayFile = (): StoredToolAnnotationsFile => ({
    generatedAt: 'x',
    servers: { github: userEntry('gh-live', GITHUB_TOOLS) },
  });

  function errorFrom(fn: () => unknown): unknown {
    try {
      fn();
    } catch (err) {
      return err;
    }
    throw new Error('expected an error');
  }

  it('refuses a symlinked overlay, even to a well-formed file, and never falls back to the package file', () => {
    const elsewhere = resolve(root, 'elsewhere');
    writeJson(elsewhere, FILE, overlayFile());
    mkdirSync(userDir, { recursive: true });
    const overlayPath = resolve(userDir, FILE);
    symlinkSync(resolve(elsewhere, FILE), overlayPath);

    const err = errorFrom(() => readToolAnnotationsFile(overlayPath));
    expect(err).toBeInstanceOf(ToolAnnotationsFileError);
    expect(err).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID, path: overlayPath });
    expect(String(err)).toMatch(/must be a readable regular non-symlink file/);

    const loadErr = errorFrom(() =>
      loadGeneratedPolicy({ policyDir: packageDir, toolAnnotationsDir: userDir, fallbackDir: packageDir }),
    );
    expect(loadErr).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID });
    expect(damagedToolAnnotationsFile(loadErr, packageDir)).toBe('overlay');
  });

  it('refuses a dangling symlink instead of treating the overlay as missing', () => {
    mkdirSync(userDir, { recursive: true });
    symlinkSync(resolve(root, 'missing-target.json'), resolve(userDir, FILE));
    const err = errorFrom(() => loadToolAnnotations(userDir, packageDir));
    expect(err).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID, path: resolve(userDir, FILE) });
    expect(String(err)).toMatch(/must be a readable regular non-symlink file/);
  });

  it('refuses a world-writable overlay or shipped file with a chmod hint', () => {
    writeJson(userDir, FILE, overlayFile());
    chmodSync(resolve(userDir, FILE), 0o666);
    const overlayErr = errorFrom(() => loadToolAnnotations(userDir, packageDir));
    expect(overlayErr).toBeInstanceOf(ToolAnnotationsFileError);
    expect(overlayErr).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID });
    expect(String(overlayErr)).toMatch(/must not be world-writable: .*Fix it with: chmod o-w /);
    expect(damagedToolAnnotationsFile(overlayErr, packageDir)).toBe('overlay');

    chmodSync(resolve(userDir, FILE), 0o644);
    chmodSync(resolve(packageDir, FILE), 0o666);
    const shippedErr = errorFrom(() => loadToolAnnotations(userDir, packageDir));
    expect(shippedErr).toMatchObject({ code: TOOL_ANNOTATIONS_INVALID, path: resolve(packageDir, FILE) });
    expect(damagedToolAnnotationsFile(shippedErr, packageDir)).toBe('shipped');
    // Read directly too, without an overlay in front of it.
    expect(() => loadToolAnnotations(packageDir, packageDir)).toThrow(/must not be world-writable/);
  });

  it('loads a private regular file, and a missing overlay still falls back to the package file', () => {
    writeJson(userDir, FILE, overlayFile());
    chmodSync(resolve(userDir, FILE), 0o600);
    expect(loadToolAnnotations(userDir, packageDir)?.annotations.servers.github.tools).toEqual(GITHUB_TOOLS);

    rmSync(resolve(userDir, FILE));
    expect(loadToolAnnotations(userDir, packageDir)?.annotations).toEqual(packageFile());
    expect(readToolAnnotationsFile(resolve(userDir, FILE))).toBeUndefined();
  });

  it('loadConfig points sessions at a dangling overlay symlink, which then refuses to load', () => {
    const home = resolve(root, 'ic-home');
    vi.stubEnv('IRONCURTAIN_HOME', home);
    vi.stubEnv('ALLOWED_DIRECTORY', resolve(root, 'sandbox'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const generated = resolve(home, 'generated');
      mkdirSync(generated, { recursive: true });
      symlinkSync(resolve(root, 'missing-target.json'), resolve(generated, FILE));
      const config = loadConfig();
      // Before, existsSync() saw no overlay and the package annotations were
      // used as if the planted link were not there.
      expect(config.toolAnnotationsDir).toBe(generated);
      expect(() => loadToolAnnotations(generated, getPackageGeneratedDir())).toThrow(
        /must be a readable regular non-symlink file/,
      );
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// annotate-tools: migration, adoption of package entries, pinning
// ---------------------------------------------------------------------------

describe('annotate-tools overlay update', () => {
  const annotateNever = vi.fn((): Promise<StoredToolAnnotation[]> => {
    throw new Error('LLM must not be called');
  });

  beforeEach(() => {
    annotateNever.mockClear();
  });

  it('migrates a legacy snapshot: copies are dropped, divergent entries kept and reported', () => {
    const githubTools = [tool('github', 'list_issues', { owner: ['github-owner'] })];
    const divergentFetch = [tool('fetch', 'http_fetch', { url: ['fetch-url'], headers: ['none'] })];
    const legacy = legacySnapshot();
    legacy.servers.fetch = { inputHash: 'fetch-hash-live', tools: divergentFetch };
    legacy.servers.github = { inputHash: 'gh-hash', tools: githubTools };

    const migration = migrateOverlay(legacy, packageFile());

    expect(Object.keys(migration.overlay.servers).sort()).toEqual(['fetch', 'github']);
    expect(migration.overlay.servers.fetch).toEqual({
      inputHash: 'fetch-hash-live',
      contentDigest: computeAnnotationContentDigest(divergentFetch),
      source: 'user',
      tools: divergentFetch,
    });
    expect(migration.dropped).toEqual([
      { server: 'filesystem', resolution: 'identical', legacy: true },
      { server: 'git', resolution: 'superseded', legacy: true },
    ]);
    expect(migration.keptDivergentLegacy).toEqual(['fetch']);
    expect(migration.hadLegacyEntries).toBe(true);

    // Migration is what the loaders already do: the effective annotations do not change.
    const effectiveTools = (overlay: StoredToolAnnotationsFile) =>
      Object.fromEntries(
        Object.entries(mergeToolAnnotationOverlay(packageFile(), overlay).annotations.servers).map(([name, e]) => [
          name,
          e.tools,
        ]),
      );
    expect(effectiveTools(migration.overlay)).toEqual(effectiveTools(legacy));
  });

  it('adopts the reviewed package entry instead of a cached user copy for the same tools', async () => {
    const stale = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['none'] })];
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: userEntry('git-hash-v2', stale) } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v2', tools: [] }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: annotateNever,
    });
    expect(annotateNever).not.toHaveBeenCalled();
    expect(update.overlay.servers).toEqual({});
    expect(update.migration.dropped).toEqual([{ server: 'git', resolution: 'same-input', legacy: false }]);
    expect(update.outcomes).toEqual([{ server: 'git', outcome: 'adopted-package', replacedUserEntry: false }]);
  });

  it('adopts the reviewed package entry instead of the LLM once the package matches the live server', async () => {
    // The user annotated an older server version; the package has since been annotated for the live one.
    const older = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path'], old: ['none'] })];
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: userEntry('git-hash-old', older) } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v2', tools: [] }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: annotateNever,
    });
    expect(annotateNever).not.toHaveBeenCalled();
    expect(update.overlay.servers).toEqual({});
    expect(update.outcomes).toEqual([{ server: 'git', outcome: 'adopted-package', replacedUserEntry: true }]);
  });

  it('keeps a cached user entry produced for the live tools when the package was annotated for other tools', async () => {
    const mine = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: { inputHash: 'git-live', tools: mine } } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-live', tools: [] }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: annotateNever,
    });
    expect(annotateNever).not.toHaveBeenCalled();
    expect(update.outcomes[0].outcome).toBe('cached');
    expect(update.overlay.servers.git).toMatchObject({ inputHash: 'git-live', source: 'user', tools: mine });
  });

  it('calls the LLM only when neither entry matches the live tools, and stamps the result', async () => {
    const fresh = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
    const annotate = vi.fn(() => Promise.resolve(fresh));
    const update = await updateAnnotationOverlay({
      overlay: undefined,
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: ['live-tools'] }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate,
    });
    // The reviewed package entry is offered for reuse of unchanged tools.
    expect(annotate).toHaveBeenCalledWith('git', ['live-tools'], [GIT_V2]);
    expect(update.overlay.servers.git).toEqual({
      inputHash: 'git-hash-v3',
      contentDigest: computeAnnotationContentDigest(fresh),
      source: 'user',
      producerVersion: '2.0.0',
      tools: fresh,
    });
  });

  it('records the identity the live server reported on annotated and cached entries', async () => {
    const fresh = [tool('git', 'git_clone', { url: ['git-remote-url'], path: ['write-path'] })];
    const serverInfo = { name: '@cyanheads/git-mcp-server', version: '2.15.3' };
    const annotated = await updateAnnotationOverlay({
      overlay: undefined,
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [], serverInfo }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: () => Promise.resolve(fresh),
    });
    expect(annotated.overlay.servers.git.serverInfo).toEqual(serverInfo);

    // A later run against a patch release with the same tools keeps the
    // annotations and refreshes the recorded identity.
    const patched = { name: '@cyanheads/git-mcp-server', version: '2.15.4' };
    const cached = await updateAnnotationOverlay({
      overlay: annotated.overlay,
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [], serverInfo: patched }]]),
      pin: false,
      producerVersion: '2.0.1',
      annotate: annotateNever,
    });
    expect(cached.outcomes[0].outcome).toBe('cached');
    expect(cached.overlay.servers.git).toMatchObject({ serverInfo: patched, tools: fresh });
    // The identity is informational: it does not change the content digest.
    expect(cached.overlay.servers.git.contentDigest).toBe(annotated.overlay.servers.git.contentDigest);
  });

  it('--pin keeps the user entry over a matching package entry and marks it pinned', async () => {
    const mine = [
      tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path', 'write-path', 'delete-path'] }),
    ];
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: userEntry('git-hash-v2', mine) } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v2', tools: [] }]]),
      pin: true,
      producerVersion: '2.0.0',
      annotate: annotateNever,
    });
    expect(annotateNever).not.toHaveBeenCalled();
    expect(update.overlay.servers.git).toMatchObject({ pinned: true, tools: mine });
    expect(
      describeOverlayWarnings({ decisions: mergeToolAnnotationOverlay(packageFile(), update.overlay).decisions }),
    ).toHaveLength(1);
    // Once pinned, later runs keep it without --pin.
    expect(
      planServerAnnotation({
        liveHash: 'git-hash-v2',
        packageEntry: packageFile().servers.git,
        overlayEntry: update.overlay.servers.git,
        pin: false,
      }),
    ).toEqual({ kind: 'cached', entry: update.overlay.servers.git });
  });

  it('reports a kept legacy entry as overriding only while it is still in effect after the run', async () => {
    // Three legacy entries annotated for other tools than the package's: the migration keeps all of them.
    const olderGit = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path'], old: ['none'] })];
    const mineFetch = [tool('fetch', 'http_fetch', { url: ['fetch-url'], extra: ['none'] })];
    const mineFs = [tool('filesystem', 'read_file', { path: ['read-path'], extra: ['none'] })];
    const fresh = [tool('fetch', 'http_fetch', { url: ['fetch-url'], method: ['none'] })];
    const update = await updateAnnotationOverlay({
      overlay: {
        generatedAt: 'x',
        servers: {
          git: { inputHash: 'git-hash-old', tools: olderGit },
          fetch: { inputHash: 'fetch-old', tools: mineFetch },
          filesystem: { inputHash: 'fs-other', tools: mineFs },
        },
      },
      base: packageFile(),
      live: new Map([
        // The package now matches the live git server: its reviewed entry replaces the user's.
        ['git', { liveHash: 'git-hash-v2', tools: [] }],
        // Neither entry matches the live fetch server: the LLM re-annotates it.
        ['fetch', { liveHash: 'fetch-new', tools: [] }],
      ]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: () => Promise.resolve(fresh),
    });
    expect(update.migration.keptDivergentLegacy).toEqual(['git', 'fetch', 'filesystem']);
    expect(update.outcomes.map((o) => [o.server, o.outcome])).toEqual([
      ['git', 'adopted-package'],
      ['fetch', 'annotated'],
    ]);
    // Only the untouched filesystem entry still overrides the shipped annotations as it was.
    expect(update.keptDivergentLegacy).toEqual(['filesystem']);
  });

  // WP-88 / PIP-21: one server's failure no longer discards the others' results.
  it('a failure on the last server keeps the new annotations of the servers before it', async () => {
    const freshGit = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['read-path', 'write-path'] })];
    const freshFetch = [tool('fetch', 'http_fetch', { url: ['fetch-url'], method: ['none'] })];
    const ownFilesystem = userEntry('fs-old', [
      tool('filesystem', 'read_file', { path: ['read-path'], extra: ['none'] }),
    ]);
    const checkpoints: StoredToolAnnotationsFile[] = [];

    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { filesystem: ownFilesystem } },
      base: packageFile(),
      live: new Map([
        ['git', { liveHash: 'git-hash-v3', tools: [] }],
        ['fetch', { liveHash: 'fetch-new', tools: [] }],
        ['filesystem', { liveHash: 'fs-new', tools: [] }],
      ]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: (server) =>
        server === 'filesystem'
          ? Promise.reject(new Error('Annotation incomplete: missing tools: read_file'))
          : Promise.resolve(server === 'git' ? freshGit : freshFetch),
      onCheckpoint: (overlay) => checkpoints.push(overlay),
    });

    expect(update.outcomes).toEqual([
      { server: 'git', outcome: 'annotated', replacedUserEntry: false },
      { server: 'fetch', outcome: 'annotated', replacedUserEntry: false },
      {
        server: 'filesystem',
        outcome: 'failed',
        replacedUserEntry: false,
        error: 'Annotation incomplete: missing tools: read_file',
      },
    ]);
    expect(update.overlay.servers.git.tools).toEqual(freshGit);
    expect(update.overlay.servers.fetch.tools).toEqual(freshFetch);
    // The failed server keeps the annotations that were in effect for it.
    expect(update.overlay.servers.filesystem).toEqual(ownFilesystem);
    // Checkpointed after every server: the earlier results were on disk before the failure.
    expect(checkpoints.map((c) => Object.keys(c.servers).sort())).toEqual([
      ['filesystem', 'git'],
      ['fetch', 'filesystem', 'git'],
      ['fetch', 'filesystem', 'git'],
    ]);
    expect(checkpoints[0].servers.git.tools).toEqual(freshGit);
  });

  it('a failed server without an entry of its own keeps the shipped annotations in effect', async () => {
    const update = await updateAnnotationOverlay({
      overlay: undefined,
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [] }]]),
      pin: false,
      producerVersion: '2.0.0',
      annotate: () => Promise.reject(new Error('LLM unavailable')),
    });
    expect(update.outcomes).toEqual([
      { server: 'git', outcome: 'failed', replacedUserEntry: false, error: 'LLM unavailable' },
    ]);
    expect(update.overlay.servers).toEqual({});
    expect(mergeToolAnnotationOverlay(packageFile(), update.overlay).annotations.servers.git.tools).toEqual(GIT_V2);
  });

  // `--pin` pins the annotations a run produces. A failed `--server git --pin`
  // must not pin the user's older entry instead: that would let annotations
  // the loaders were ignoring override the reviewed package entry.
  it('a failed --pin run pins nothing: the shipped annotations stay in effect over an ignored user entry', async () => {
    // Same tools as the package entry (same-input): the loaders use the package's GIT_V2.
    const ignored = userEntry('git-hash-v2', GIT_V1);
    const overlay: StoredToolAnnotationsFile = { generatedAt: 'x', servers: { git: ignored } };
    expect(mergeToolAnnotationOverlay(packageFile(), overlay).annotations.servers.git.tools).toEqual(GIT_V2);
    const checkpoints: StoredToolAnnotationsFile[] = [];

    const update = await updateAnnotationOverlay({
      overlay,
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [] }]]),
      pin: true,
      producerVersion: '2.0.0',
      annotate: () => Promise.reject(new Error('LLM unavailable')),
      onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    });

    expect(update.outcomes).toEqual([
      { server: 'git', outcome: 'failed', replacedUserEntry: false, error: 'LLM unavailable' },
    ]);
    // Still what was in effect before the run, in the result and in every checkpoint.
    for (const written of [update.overlay, ...checkpoints]) {
      expect(written.servers.git.pinned).toBeUndefined();
      const merged = mergeToolAnnotationOverlay(packageFile(), written);
      expect(merged.annotations.servers.git.tools).toEqual(GIT_V2);
    }
    // The user's entry itself is kept (a later --pin run can still reuse it).
    expect(update.overlay.servers.git.tools).toEqual(GIT_V1);
  });

  it('a failed --pin run does not report an unpinned legacy entry as overriding the shipped annotations', async () => {
    // Legacy (pre-overlay) entry for the same tools as the package entry: ignored by the loaders.
    const legacy: StoredServerAnnotations = { inputHash: 'git-hash-v2', tools: GIT_V1 };
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: legacy } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [] }]]),
      pin: true,
      producerVersion: '2.0.0',
      annotate: () => Promise.reject(new Error('LLM unavailable')),
    });
    expect(update.outcomes.map((o) => o.outcome)).toEqual(['failed']);
    expect(update.keptDivergentLegacy).toEqual([]);
    expect(mergeToolAnnotationOverlay(packageFile(), update.overlay).annotations.servers.git.tools).toEqual(GIT_V2);
  });

  it('a failed --pin run keeps an entry the user had already pinned pinned', async () => {
    const pinned = userEntry('git-hash-v2', GIT_V1, { pinned: true });
    const update = await updateAnnotationOverlay({
      overlay: { generatedAt: 'x', servers: { git: pinned } },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v3', tools: [] }]]),
      pin: true,
      producerVersion: '2.0.0',
      annotate: () => Promise.reject(new Error('LLM unavailable')),
    });
    expect(update.overlay.servers.git).toEqual(pinned);
    expect(mergeToolAnnotationOverlay(packageFile(), update.overlay).annotations.servers.git.tools).toEqual(GIT_V1);
  });

  it('offers the reviewed package annotations for reuse first, and the user entry first when pinned', () => {
    const pkg = packageFile().servers.git;
    const own = userEntry('git-old', GIT_V1);
    expect(reusableAnnotations({ packageEntry: pkg, overlayEntry: own, pinned: false })).toEqual([GIT_V2, GIT_V1]);
    expect(reusableAnnotations({ packageEntry: pkg, overlayEntry: own, pinned: true })).toEqual([GIT_V1, GIT_V2]);
    expect(reusableAnnotations({ packageEntry: undefined, overlayEntry: undefined, pinned: false })).toEqual([]);
  });

  it('--all drops overlay entries for servers no longer configured; unreached servers keep theirs', async () => {
    const custom = [tool('custom', 'do', { x: ['none'] })];
    const update = await updateAnnotationOverlay({
      overlay: {
        generatedAt: 'x',
        servers: { gone: userEntry('g', custom), custom: userEntry('c', custom) },
      },
      base: packageFile(),
      live: new Map([['git', { liveHash: 'git-hash-v2', tools: [] }]]),
      pin: false,
      producerVersion: '2.0.0',
      configuredServers: new Set(['git', 'custom']),
      annotate: annotateNever,
    });
    expect(Object.keys(update.overlay.servers)).toEqual(['custom']);
    expect(update.orphansDropped).toEqual(['gone']);
  });
});

// ---------------------------------------------------------------------------
// --reset
// ---------------------------------------------------------------------------

describe('annotate-tools --reset', () => {
  it('--reset --server removes the overlay entry and keeps the others', () => {
    const githubTools = [tool('github', 'list_issues', { owner: ['github-owner'] })];
    const mine = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: { git: userEntry('git-live', mine), github: userEntry('gh', githubTools) },
    });

    const outcome = resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir, server: 'git' });

    expect(outcome.removed).toEqual(['git']);
    expect(outcome.result).toBe('written');
    const remaining = readAnnotationsJson(resolve(userDir, FILE));
    expect(Object.keys(remaining.servers)).toEqual(['github']);
    expect(loadToolAnnotations(userDir, packageDir)?.annotations.servers.git.tools).toEqual(GIT_V2);
    expect(existsSync(resolve(userDir, LEGACY_OVERLAY_BACKUP_FILENAME))).toBe(false);
  });

  it('removes the file when the last entry is reset, and backs up a legacy file first', () => {
    const divergent = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
    const legacy = legacySnapshot();
    legacy.servers.git = { inputHash: 'git-live', tools: divergent };
    writeJson(userDir, FILE, legacy);
    const original = readFileSync(resolve(userDir, FILE), 'utf-8');

    const outcome = resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir, server: 'git' });

    // filesystem and fetch were package copies: migrated away along with the reset.
    expect(outcome.migration?.dropped.map((d) => d.server)).toEqual(['filesystem', 'fetch']);
    expect(outcome.result).toBe('removed');
    expect(existsSync(resolve(userDir, FILE))).toBe(false);
    expect(outcome.backupPath).toBe(resolve(userDir, LEGACY_OVERLAY_BACKUP_FILENAME));
    expect(readFileSync(resolve(userDir, LEGACY_OVERLAY_BACKUP_FILENAME), 'utf-8')).toBe(original);
  });

  it('a full reset removes even a damaged overlay', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, FILE), '{broken');
    const outcome = resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir });
    expect(outcome.result).toBe('removed');
    expect(existsSync(resolve(userDir, FILE))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'a full reset removes a symlinked overlay sessions refuse, dangling or not',
    () => {
      const target = resolve(root, 'linked-annotations.json');
      writeJson(root, 'linked-annotations.json', { generatedAt: 'x', servers: { git: userEntry('g', GIT_V1) } });
      for (const linkTarget of [target, resolve(root, 'missing-target.json')]) {
        mkdirSync(userDir, { recursive: true });
        symlinkSync(linkTarget, resolve(userDir, FILE));
        const outcome = resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir });
        expect(outcome).toMatchObject({ overlayExisted: true, result: 'removed' });
        expect(lstatSync(resolve(userDir, FILE), { throwIfNoEntry: false })).toBeUndefined();
      }
      // The link is removed, never what it points to.
      expect(existsSync(target)).toBe(true);
    },
  );

  it('reports nothing to reset for an unknown server or a missing overlay', () => {
    expect(resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir }).overlayExisted).toBe(false);
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: userEntry('g', GIT_V1) } });
    const outcome = resetToolAnnotationsOverlay({ overlayDir: userDir, packageDir, server: 'nope' });
    expect(outcome).toMatchObject({ result: 'unchanged', removed: [] });
  });

  describe('CLI', () => {
    const savedHome = process.env.IRONCURTAIN_HOME;
    let errorSpy: MockInstance<typeof console.error>;

    beforeEach(() => {
      process.env.IRONCURTAIN_HOME = resolve(root, 'home');
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
      if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = savedHome;
    });

    it('`annotate-tools --reset --server <name>` edits the user overlay without MCP or LLM', async () => {
      const mine = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
      const custom = [tool('custom', 'do', { x: ['none'] })];
      writeJson(userDir, FILE, {
        generatedAt: 'x',
        servers: { git: userEntry('git-live', mine), custom: userEntry('c', custom) },
      });

      await annotateMain(['--reset', '--server', 'git']);

      const remaining = readAnnotationsJson(resolve(userDir, FILE));
      expect(Object.keys(remaining.servers)).toEqual(['custom']);
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('Removed your tool annotations for: git');
    });

    it('points a damaged shipped file at a reinstall: --reset cannot repair it', async () => {
      const mine = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
      writeJson(userDir, FILE, { generatedAt: 'x', servers: { git: userEntry('git-live', mine) } });
      writeFileSync(resolve(packageDir, FILE), '{not json');
      shippedDirOverride.dir = packageDir;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      try {
        await expect(annotateMain(['--reset', '--server', 'git'])).rejects.toThrow('process.exit');
      } finally {
        exitSpy.mockRestore();
      }
      const output = errorSpy.mock.calls.flat().join('\n');
      expect(output).toContain('Reinstall IronCurtain');
      expect(output).not.toContain('without --server');
      // The user overlay is left as it was.
      expect(Object.keys(readAnnotationsJson(resolve(userDir, FILE)).servers)).toEqual(['git']);
    });
  });

  it('parses and validates the new flags', () => {
    expect(parseAnnotateArgs(['--reset', '--server', 'git'])).toMatchObject({ reset: true, server: 'git', pin: false });
    expect(validateAnnotateArgs(parseAnnotateArgs(['--reset']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--reset', '--all']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--reset', '--pin']))).toMatch(/--pin cannot be used with --reset/);
    expect(validateAnnotateArgs(parseAnnotateArgs(['--server', 'git', '--pin']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--all', '--pin']))).toMatch(/--pin requires --server/);
    expect(validateAnnotateArgs(parseAnnotateArgs(['--server', 'git', '--all']))).toMatch(/cannot be used together/);
    expect(validateAnnotateArgs(parseAnnotateArgs([]))).toMatch(/specify --server/);
  });

  it('parses and validates --check (no LLM: alone, or with --server)', () => {
    expect(parseAnnotateArgs(['--check'])).toMatchObject({ check: true, server: undefined });
    expect(parseAnnotateArgs(['--server', 'git'])).toMatchObject({ check: false });
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check', '--server', 'git']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check', '--reset']))).toMatch(
      /--check cannot be used with --reset/,
    );
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check', '--pin']))).toMatch(/--check cannot be used with --pin/);
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check', '--server', 'git', '--all']))).toMatch(
      /cannot be used together/,
    );
  });

  it('parses and validates --diff (only when annotating)', () => {
    expect(parseAnnotateArgs(['--all', '--diff'])).toMatchObject({ all: true, diff: true });
    expect(parseAnnotateArgs(['--all'])).toMatchObject({ diff: false });
    expect(validateAnnotateArgs(parseAnnotateArgs(['--all', '--diff']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--server', 'git', '--diff']))).toBeUndefined();
    expect(validateAnnotateArgs(parseAnnotateArgs(['--check', '--diff']))).toMatch(/--diff applies only/);
    expect(validateAnnotateArgs(parseAnnotateArgs(['--reset', '--diff']))).toMatch(/--diff applies only/);
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe('doctor', () => {
  it('lists divergent servers', () => {
    const pinnedTools = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['none'] })];
    const mineFetch = [tool('fetch', 'http_fetch', { url: ['fetch-url'], extra: ['none'] })];
    writeJson(userDir, FILE, {
      generatedAt: 'x',
      servers: {
        git: userEntry('git-hash-v2', pinnedTools, { pinned: true }),
        fetch: { inputHash: 'fetch-live', tools: mineFetch },
        filesystem: { inputHash: 'fs-hash', tools: FS_TOOLS },
      },
    });
    const loaded = loadToolAnnotations(userDir, packageDir);
    if (!loaded) throw new Error('expected annotations');

    const result = checkAnnotationOverlay(loaded.overlay);

    expect(result.status).toBe('warn');
    expect(result.message).toContain('overrides shipped annotations for: fetch (annotated for different tools');
    expect(result.message).toContain('git (pinned)');
    expect(result.message).toContain('stale copies (cleaned up by the next annotate-tools run): filesystem');
    expect(result.hint).toContain('annotate-tools --reset --server fetch');
  });

  it('is ok without an overlay and for custom servers only', () => {
    expect(checkAnnotationOverlay({ decisions: [] }).status).toBe('ok');
    writeJson(userDir, FILE, { generatedAt: 'x', servers: { custom: userEntry('c', FS_TOOLS) } });
    const loaded = loadToolAnnotations(userDir, packageDir);
    const result = checkAnnotationOverlay(loaded?.overlay ?? { decisions: [] });
    expect(result.status).toBe('ok');
    expect(result.message).toContain('custom servers: custom');
  });

  it('points a damaged overlay at --reset rather than compile-policy', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, FILE), '{broken');
    const config = { generatedDir: packageDir, toolAnnotationsDir: userDir } as IronCurtainConfig;
    const check = checkPolicyArtifacts(config);
    expect(check.results[0].status).toBe('fail');
    expect(check.results[0].hint).toContain('annotate-tools --reset');
    expect(check.results[0].hint).not.toContain('to (re)generate compiled-policy.json and tool-annotations.json');
  });

  it('points a damaged shipped annotations file at a reinstall, not --reset', () => {
    writeFileSync(resolve(packageDir, FILE), '{broken');
    shippedDirOverride.dir = packageDir;
    const config = { generatedDir: packageDir, toolAnnotationsDir: packageDir } as IronCurtainConfig;
    const check = checkPolicyArtifacts(config);
    expect(check.results[0].status).toBe('fail');
    expect(check.results[0].hint).toContain('Reinstall IronCurtain');
    expect(check.results[0].hint).not.toMatch(/^Run `ironcurtain annotate-tools --reset`/);
  });

  it('no longer claims compile-policy regenerates tool-annotations.json', () => {
    const broken = resolve(root, 'broken');
    mkdirSync(broken);
    writeFileSync(resolve(broken, 'compiled-policy.json'), '{broken');
    const config = { generatedDir: broken, toolAnnotationsDir: broken } as IronCurtainConfig;
    const check = checkPolicyArtifacts(config);
    expect(check.results[0].status).toBe('fail');
    expect(check.results[0].hint).toMatch(/compile-policy` to regenerate compiled-policy\.json/);
    expect(check.results[0].hint).not.toMatch(/generate compiled-policy\.json and tool-annotations\.json/);
  });
});

// ---------------------------------------------------------------------------
// Provenance of the bundled package file
// ---------------------------------------------------------------------------

describe('package annotation stamps', () => {
  it('keeps the recorded server identity when stamping and promoting', () => {
    const serverInfo = { name: '@cyanheads/git-mcp-server', version: '2.15.3' };
    const base = packageFile();
    const edited: StoredToolAnnotationsFile = {
      ...base,
      servers: { ...base.servers, git: { ...base.servers.git, serverInfo, tools: GIT_V1 } },
    };
    const stamped = stampPackageAnnotations(edited, '3.0.0');
    expect(stamped.changed).toEqual(['git']);
    expect(stamped.file.servers.git.serverInfo).toEqual(serverInfo);

    const overlay: StoredToolAnnotationsFile = {
      generatedAt: 'x',
      servers: { git: userEntry('git-live', GIT_V2, { serverInfo }) },
    };
    const promoted = promoteOverlayEntries(base, overlay, '3.0.0');
    expect(promoted.file.servers.git).toMatchObject({ source: 'package', serverInfo, inputHash: 'git-live' });
  });

  it('every shipped entry is stamped: re-stamp after editing src/config/generated/tool-annotations.json', () => {
    const shipped = readToolAnnotationsFile(resolve(getPackageGeneratedDir(), FILE));
    if (!shipped) throw new Error('shipped annotations missing');
    for (const [server, entry] of Object.entries(shipped.servers)) {
      const digest = computeAnnotationContentDigest(entry.tools);
      // Fix: npx tsx scripts/stamp-package-annotations.ts
      expect({ server, source: entry.source, contentDigest: entry.contentDigest }).toEqual({
        server,
        source: 'package',
        contentDigest: digest,
      });
      expect(entry.producerVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.supersededDigests ?? []).not.toContain(digest);
    }
    expect(stampPackageAnnotations(shipped, '0.0.0').changed).toEqual([]);
  });

  it('keeps recognising every revision shipped before overlays: the history may only grow', () => {
    // Content digests of every revision of each server's entry in the git
    // history of src/config/generated/tool-annotations.json before overlays
    // shipped (oldest first; the last one was current then). Legacy user
    // snapshots are copies of these revisions and resolve to the package
    // only while the bundled file still lists them.
    const shippedBeforeOverlays: Record<string, string[]> = {
      filesystem: [
        '35aec87d9e4037dd94bad2261c176d76d8b1db634c5fcf6a6ec463b82ae73a67',
        '4eb87a909825ca6a9b66c83581716970dc95ee6aae8da4bddd9f29eed5617994',
        '838ab48ce97078ca7e7ad99916b1e042ce4810be957a1a069687f378df063b8f',
        '44ebcd1706fba8c9d7215bcf711144beb8bca288a4ad63b4f6aa769652e114d5',
        '8240d6f93d07c9afe42617456dc2ba83ea2f0803e995d7f9a2d290e77e91249c',
        'c58cba944eee64c24b23ed60a3d78263bcd803d8cfd4c21c3eae2f08aae5d9de',
        'ca576dc2781b95b177ef3bc40d0155b9e5e09146d0e37a24f1d160d69763c94c',
        '4c6a2571b15a6f37fb8d26972902688e698e0f6b044b6d6f9466f26d27ace8b1',
        '068f105632402f13dfa2cbc202b8c603ba9d47fabc4f2440562d2efa4e32e4af',
      ],
      git: [
        '860913a74e1973dfaae274ec68fd962ab92245011b8f4e2f85ebd6591602ec8c',
        '8e4473093059c7174e8350de6569f50c83be28ec3f46ef8e3b2222bbff02de3d',
        '9270a2358719399048639d223db70774683e390b37286ec94bd36209e8075826',
        '41b0240470ca96f31e5e1602846fb1a8fe9c723b21f729fec491721256b9f5a8',
        'c3623e1afea76523f79e1a3a04999d0aece06fe9412c00ea65e3ea1524e95694',
        // Before #207 (a07e105) changed the git roles without changing inputHash.
        '56e245624f9f2452f704fb979237e1645e69021cc17f95149df7bbe2b06e5db7',
        '4c75bc02fb7b493d430f524d30045a1c4d6653c67a2268504876bd76a59f8b83',
      ],
      fetch: [
        '8c99ca16146b6f2d694a406a06763013049d869c7801b92f21022173844f2119',
        '96989681101156333bbf0535a0d7059c8afa8adb39c2864bb6279dd73b0f48cd',
        '1fe125f78f651ea288b312ccd975bfa3af95eb1c347d1f4822ff47fd2bf1095c',
        'ee3ad7df1f88118b89f0929e93465e82a654770804dfed4b73d67346336feeac',
        'e843f4bf9c085a46d21be5cd1755151889ac9a7e3f0b60b8c3c1572621a04efb',
        '1c71d646cff273da9f9c3c444e843946867ef333209bafeea8367e85a4bae4d6',
      ],
      github: [
        '5caa477024aa9a1869c164b6f02f09af681701e3fbaa770903535bc45ef74406',
        '91800ebd77a970f97592bf06c7eb8aad0f41ee8f286409eb4730588b9834ad48',
        '1fd98645f2f121896ffd01e01d2708386e9695e530e03cd3eb47707bd2e4491f',
        '01e992d218817403eb64083a81a7c45466ee899c5b0ae8797c744f7f5065f8fd',
        'e4c6633217ce7c4e36a676be85912acdfc88f2ab46369669021ca98a86afdef8',
      ],
      'google-workspace': ['4df37ac27aad1f812f59e54466fed343dcc0e5b299f733e8f90662a5842ace79'],
    };
    const shipped = readToolAnnotationsFile(resolve(getPackageGeneratedDir(), FILE));
    if (!shipped) throw new Error('shipped annotations missing');
    for (const [server, digests] of Object.entries(shippedBeforeOverlays)) {
      // A server the package no longer ships needs no history: user entries for it are 'user-only'.
      if (!Object.hasOwn(shipped.servers, server)) continue;
      const entry = shipped.servers[server];
      const recognised = new Set([computeAnnotationContentDigest(entry.tools), ...(entry.supersededDigests ?? [])]);
      expect({ server, unrecognised: digests.filter((d) => !recognised.has(d)) }).toEqual({ server, unrecognised: [] });
    }
  });

  it('refuses to stamp a user overlay copied over the package file', () => {
    const copied: StoredToolAnnotationsFile = {
      generatedAt: 'x',
      servers: { git: userEntry('git-live', GIT_V2) },
    };
    expect(() => stampPackageAnnotations(copied, '2.0.0')).toThrow(/Refusing to stamp user overlay entries.*"git"/);
    // Promoting the same entry from the overlay is the supported route.
    const promoted = promoteOverlayEntries(packageFile(), copied, '2.0.0', ['git']);
    expect(promoted.file.servers.git.source).toBe('package');
    expect(promoted.file.servers.git.supersededDigests).toContain(computeAnnotationContentDigest(GIT_V1));
  });

  it('records the replaced revision as superseded, idempotently, and un-supersedes a revert', () => {
    const base = packageFile();
    const edited = structuredClone(base);
    edited.servers.fetch.tools = [tool('fetch', 'http_fetch', { url: ['fetch-url'], method: ['none'] })];

    const first = stampPackageAnnotations(edited, '2.0.0');
    expect(first.changed).toEqual(['fetch']);
    expect(first.file.servers.fetch.supersededDigests).toEqual([computeAnnotationContentDigest(FETCH_TOOLS)]);
    expect(first.file.servers.fetch.producerVersion).toBe('2.0.0');
    expect(first.file.servers.git).toEqual(base.servers.git);

    expect(stampPackageAnnotations(first.file, '3.0.0')).toEqual({ file: first.file, changed: [] });

    const reverted = structuredClone(first.file);
    reverted.servers.fetch.tools = FETCH_TOOLS;
    const back = stampPackageAnnotations(reverted, '3.0.0').file.servers.fetch;
    expect(back.supersededDigests).toEqual([computeAnnotationContentDigest(first.file.servers.fetch.tools)]);

    // A user copy of the replaced revision now resolves to the package entry.
    expect(resolveServerOverlay(first.file.servers.fetch, { inputHash: 'other', tools: FETCH_TOOLS })).toBe(
      'superseded',
    );
  });

  it('promotes a reviewed overlay entry into the package file', () => {
    const githubTools = [tool('github', 'list_issues', { owner: ['github-owner'] })];
    const mine = [tool('git', 'git_clone', { url: ['git-remote-url'], localPath: ['write-path'] })];
    const overlay = {
      generatedAt: 'x',
      servers: { git: userEntry('git-live', mine), github: userEntry('gh', githubTools) },
    };

    const { file, promoted, changed } = promoteOverlayEntries(packageFile(), overlay, '2.0.0', ['git']);

    expect(promoted).toEqual(['git']);
    expect(changed).toEqual(['git']);
    expect(Object.keys(file.servers)).toEqual(['filesystem', 'git', 'fetch']);
    expect(file.servers.git).toEqual({
      inputHash: 'git-live',
      contentDigest: computeAnnotationContentDigest(mine),
      source: 'package',
      producerVersion: '2.0.0',
      supersededDigests: [computeAnnotationContentDigest(GIT_V1), computeAnnotationContentDigest(GIT_V2)],
      tools: mine,
    });
    expect(() => promoteOverlayEntries(packageFile(), overlay, '2.0.0', ['nope'])).toThrow(/not in the overlay/);
  });

  it('content digests ignore key order and formatting', () => {
    const a = [{ toolName: 't', args: { b: ['none'], a: ['read-path'] } }];
    const b = [{ args: { a: ['read-path'], b: ['none'] }, toolName: 't', missing: undefined }];
    expect(computeAnnotationContentDigest(a)).toBe(computeAnnotationContentDigest(b));
    expect(computeAnnotationContentDigest(a)).not.toBe(
      computeAnnotationContentDigest([{ toolName: 't', args: { a: ['write-path'], b: ['none'] } }]),
    );
  });
});
