import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FileArtifactManager,
  GITIGNORE_MAX_BYTES,
  collectFilesRecursive,
  ensureWorkflowGitignored,
  hasAnyFiles,
  listArtifactOutputNames,
  prepareWorkflowArtifactDir,
  resolveArtifactOutputDir,
  snapshotArtifacts,
  walkTreeNoFollow,
} from '../../src/workflow/artifacts.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { createWorkflowId } from '../../src/workflow/types.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from '../helpers/fifo.js';

describe('FileArtifactManager', () => {
  let baseDir: string;
  let manager: FileArtifactManager;
  let workflowId: WorkflowId;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-artifact-test-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
    manager = new FileArtifactManager(baseDir);
    workflowId = createWorkflowId();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe('initialize', () => {
    it('creates the artifact directory structure', () => {
      const dir = manager.initialize(workflowId);
      expect(dir).toContain(workflowId);
      expect(dir).toMatch(/artifacts$/);
    });

    it('returns the artifact directory path', () => {
      const dir = manager.initialize(workflowId);
      expect(dir).toBe(resolve(baseDir, workflowId, 'artifacts'));
    });

    it('is idempotent', () => {
      const dir1 = manager.initialize(workflowId);
      const dir2 = manager.initialize(workflowId);
      expect(dir1).toBe(dir2);
    });
  });

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  describe('read', () => {
    it('returns file content by convention name', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'Architecture spec content');

      const content = manager.read(workflowId, 'spec');
      expect(content).toBe('Architecture spec content');
    });

    it('falls back to first file alphabetically when convention name is absent', () => {
      const artifactDir = manager.initialize(workflowId);
      const planDir = resolve(artifactDir, 'plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(resolve(planDir, 'beta.txt'), 'beta content');
      writeFileSync(resolve(planDir, 'alpha.txt'), 'alpha content');

      const content = manager.read(workflowId, 'plan');
      expect(content).toBe('alpha content');
    });

    it('returns undefined for missing artifact directory', () => {
      manager.initialize(workflowId);
      expect(manager.read(workflowId, 'nonexistent')).toBeUndefined();
    });

    it('returns undefined for empty artifact directory', () => {
      const artifactDir = manager.initialize(workflowId);
      mkdirSync(resolve(artifactDir, 'empty'), { recursive: true });

      expect(manager.read(workflowId, 'empty')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listArtifactFiles
  // -------------------------------------------------------------------------

  describe('listArtifactFiles', () => {
    it('lists files in an artifact subdirectory', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(codeDir, { recursive: true });
      writeFileSync(resolve(codeDir, 'main.ts'), 'code');
      writeFileSync(resolve(codeDir, 'utils.ts'), 'utils');

      const files = manager.listArtifactFiles(workflowId, 'code');
      expect(files).toEqual(['main.ts', 'utils.ts']);
    });

    it('returns empty array for missing artifact', () => {
      manager.initialize(workflowId);
      expect(manager.listArtifactFiles(workflowId, 'missing')).toEqual([]);
    });

    it('returns sorted file names', () => {
      const artifactDir = manager.initialize(workflowId);
      const dir = resolve(artifactDir, 'docs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'z.md'), '');
      writeFileSync(resolve(dir, 'a.md'), '');
      writeFileSync(resolve(dir, 'm.md'), '');

      const files = manager.listArtifactFiles(workflowId, 'docs');
      expect(files).toEqual(['a.md', 'm.md', 'z.md']);
    });
  });

  // -------------------------------------------------------------------------
  // findMissing
  // -------------------------------------------------------------------------

  describe('findMissing', () => {
    it('identifies missing artifacts', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'content');

      const missing = manager.findMissing(workflowId, ['spec', 'code', 'tests']);
      expect(missing).toEqual(['code', 'tests']);
    });

    it('returns empty array when all artifacts are present', () => {
      const artifactDir = manager.initialize(workflowId);
      for (const name of ['spec', 'code']) {
        const dir = resolve(artifactDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${name}.md`), 'content');
      }

      expect(manager.findMissing(workflowId, ['spec', 'code'])).toEqual([]);
    });

    it('treats empty directories as missing', () => {
      const artifactDir = manager.initialize(workflowId);
      mkdirSync(resolve(artifactDir, 'empty'), { recursive: true });

      expect(manager.findMissing(workflowId, ['empty'])).toEqual(['empty']);
    });

    it('returns all names when none exist', () => {
      manager.initialize(workflowId);
      expect(manager.findMissing(workflowId, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
  });

  // -------------------------------------------------------------------------
  // computeHash
  // -------------------------------------------------------------------------

  describe('computeHash', () => {
    it('produces a deterministic hash for the same content', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'stable content');

      const hash1 = manager.computeHash(workflowId, ['spec']);
      const hash2 = manager.computeHash(workflowId, ['spec']);
      expect(hash1).toBe(hash2);
    });

    it('changes when file content changes', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });

      writeFileSync(resolve(specDir, 'spec.md'), 'v1');
      const hash1 = manager.computeHash(workflowId, ['spec']);

      writeFileSync(resolve(specDir, 'spec.md'), 'rewritten contents v2');
      const hash2 = manager.computeHash(workflowId, ['spec']);

      expect(hash1).not.toBe(hash2);
    });

    it('produces a valid hex string', () => {
      const artifactDir = manager.initialize(workflowId);
      const dir = resolve(artifactDir, 'data');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'file.txt'), 'data');

      const hash = manager.computeHash(workflowId, ['data']);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles missing artifact directories gracefully', () => {
      manager.initialize(workflowId);
      const hash = manager.computeHash(workflowId, ['nonexistent']);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is order-independent on artifact names (sorted internally)', () => {
      const artifactDir = manager.initialize(workflowId);
      for (const name of ['alpha', 'beta']) {
        const dir = resolve(artifactDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'file.md'), `${name} content`);
      }

      const hash1 = manager.computeHash(workflowId, ['alpha', 'beta']);
      const hash2 = manager.computeHash(workflowId, ['beta', 'alpha']);
      expect(hash1).toBe(hash2);
    });

    it('includes nested files in hash computation', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'index.ts'), 'root file');
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'nested file');

      const hash1 = manager.computeHash(workflowId, ['code']);

      // Changing a nested file should change the hash
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'modified nested file');
      const hash2 = manager.computeHash(workflowId, ['code']);

      expect(hash1).not.toBe(hash2);
    });
  });

  // -------------------------------------------------------------------------
  // Nested directory support
  // -------------------------------------------------------------------------

  describe('nested directory support', () => {
    it('findMissing detects files in subdirectories', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'code');

      expect(manager.findMissing(workflowId, ['code'])).toEqual([]);
    });

    it('findMissing treats directories with only empty subdirs as missing', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src', 'empty'), { recursive: true });

      expect(manager.findMissing(workflowId, ['code'])).toEqual(['code']);
    });

    it('listArtifactFiles returns relative paths for nested files', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      mkdirSync(resolve(codeDir, 'tests'), { recursive: true });
      writeFileSync(resolve(codeDir, 'index.ts'), 'root');
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'src');
      writeFileSync(resolve(codeDir, 'tests', 'main.test.ts'), 'test');

      const files = manager.listArtifactFiles(workflowId, 'code');
      expect(files).toEqual(['index.ts', 'src/main.ts', 'tests/main.test.ts']);
    });

    it('read falls back to first file by sorted relative path in nested dirs', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'src', 'alpha.ts'), 'alpha content');

      const content = manager.read(workflowId, 'code');
      expect(content).toBe('alpha content');
    });
  });
});

// ---------------------------------------------------------------------------
// Shared filesystem helpers
// ---------------------------------------------------------------------------

describe('collectFilesRecursive', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve('/tmp', `ironcurtain-collect-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for nonexistent directory', () => {
    expect(collectFilesRecursive(resolve(testDir, 'nope'))).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    expect(collectFilesRecursive(testDir)).toEqual([]);
  });

  it('collects flat files', () => {
    writeFileSync(resolve(testDir, 'a.txt'), 'a');
    writeFileSync(resolve(testDir, 'b.txt'), 'b');

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['a.txt', 'b.txt']);
  });

  it('collects files from nested directories', () => {
    mkdirSync(resolve(testDir, 'src', 'utils'), { recursive: true });
    writeFileSync(resolve(testDir, 'index.ts'), 'root');
    writeFileSync(resolve(testDir, 'src', 'main.ts'), 'main');
    writeFileSync(resolve(testDir, 'src', 'utils', 'helper.ts'), 'helper');

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['index.ts', 'src/main.ts', 'src/utils/helper.ts']);
  });

  it('sorts results deterministically by relative path', () => {
    mkdirSync(resolve(testDir, 'z'), { recursive: true });
    mkdirSync(resolve(testDir, 'a'), { recursive: true });
    writeFileSync(resolve(testDir, 'z', 'file.ts'), 'z');
    writeFileSync(resolve(testDir, 'a', 'file.ts'), 'a');
    writeFileSync(resolve(testDir, 'middle.ts'), 'm');

    const paths = collectFilesRecursive(testDir).map((f) => f.relativePath);
    expect(paths).toEqual(['a/file.ts', 'middle.ts', 'z/file.ts']);
  });

  it('skips symlinks', () => {
    writeFileSync(resolve(testDir, 'real.txt'), 'real');
    symlinkSync(resolve(testDir, 'real.txt'), resolve(testDir, 'link.txt'));

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['real.txt']);
  });

  it('skips directories containing only empty subdirs', () => {
    mkdirSync(resolve(testDir, 'empty', 'nested'), { recursive: true });

    expect(collectFilesRecursive(testDir)).toEqual([]);
  });

  it('provides correct fullPath for each file', () => {
    mkdirSync(resolve(testDir, 'sub'), { recursive: true });
    writeFileSync(resolve(testDir, 'sub', 'file.txt'), 'content');

    const files = collectFilesRecursive(testDir);
    expect(files[0].fullPath).toBe(resolve(testDir, 'sub', 'file.txt'));
  });
});

describe('hasAnyFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve('/tmp', `ironcurtain-hasfiles-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns false for nonexistent directory', () => {
    expect(hasAnyFiles(resolve(testDir, 'nope'))).toBe(false);
  });

  it('returns false for empty directory', () => {
    expect(hasAnyFiles(testDir)).toBe(false);
  });

  it('returns false for directory with only empty subdirs', () => {
    mkdirSync(resolve(testDir, 'a', 'b', 'c'), { recursive: true });
    expect(hasAnyFiles(testDir)).toBe(false);
  });

  it('returns true for directory with a flat file', () => {
    writeFileSync(resolve(testDir, 'file.txt'), 'content');
    expect(hasAnyFiles(testDir)).toBe(true);
  });

  it('returns true for deeply nested file', () => {
    mkdirSync(resolve(testDir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(resolve(testDir, 'a', 'b', 'c', 'deep.txt'), 'deep');
    expect(hasAnyFiles(testDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent-planted trees: symlinked roots, caps, contained output dirs
// ---------------------------------------------------------------------------

describe('walkers on agent-controlled roots', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ironcurtain-walk-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('treats an output dir symlinked to / as empty, within 1 s', () => {
    symlinkSync('/', join(base, 'plan'));
    const started = Date.now();
    expect(hasAnyFiles(join(base, 'plan'))).toBe(false);
    expect(collectFilesRecursive(join(base, 'plan'))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats a root that is a regular file as empty', () => {
    writeFileSync(join(base, 'plan'), 'not a dir');
    expect(hasAnyFiles(join(base, 'plan'))).toBe(false);
    expect(collectFilesRecursive(join(base, 'plan'))).toEqual([]);
  });

  it('stops at the entry cap and reports truncation', () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(base, `f${i}`), 'x');
    const seen: string[] = [];
    const outcome = walkTreeNoFollow(
      base,
      { maxEntries: 4, maxDepth: 8 },
      {
        file: (fullPath) => {
          seen.push(fullPath);
          return false;
        },
      },
    );
    expect(outcome).toEqual({ truncated: true, stopped: false });
    expect(seen).toHaveLength(4);

    const all = walkTreeNoFollow(base, { maxEntries: 10, maxDepth: 8 }, { file: () => false });
    expect(all).toEqual({ truncated: false, stopped: false });
  });

  it('stops at the depth cap and reports truncation', () => {
    const deep = join(base, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'deep.txt'), 'x');
    writeFileSync(join(base, 'a', 'shallow.txt'), 'x');
    const seen: string[] = [];
    const outcome = walkTreeNoFollow(
      base,
      { maxEntries: 100, maxDepth: 2 },
      {
        file: (fullPath) => {
          seen.push(fullPath);
          return false;
        },
      },
    );
    expect(outcome.truncated).toBe(true);
    expect(seen).toEqual([join(base, 'a', 'shallow.txt')]);
  });

  it('never descends into symlinked directories or reports special files', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ironcurtain-walk-outside-'));
    try {
      writeFileSync(join(outside, 'host-secret'), 'x');
      symlinkSync(outside, join(base, 'link-dir'));
      symlinkSync(join(outside, 'host-secret'), join(base, 'link-file'));
      if (fifoSupported) makeFifo(join(base, 'pipe'));
      writeFileSync(join(base, 'real.txt'), 'x');
      const seen: string[] = [];
      walkTreeNoFollow(
        base,
        { maxEntries: 100, maxDepth: 8 },
        {
          file: (fullPath) => {
            seen.push(fullPath);
            return false;
          },
        },
      );
      expect(seen).toEqual([join(base, 'real.txt')]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips directories the visitor excludes and stops when the visitor asks', () => {
    mkdirSync(join(base, 'node_modules'));
    writeFileSync(join(base, 'node_modules', 'dep.js'), 'x');
    writeFileSync(join(base, 'a.txt'), 'x');
    writeFileSync(join(base, 'b.txt'), 'x');
    const seen: string[] = [];
    walkTreeNoFollow(
      base,
      { maxEntries: 100, maxDepth: 8 },
      {
        enterDirectory: (_path, name) => name !== 'node_modules',
        file: (fullPath) => {
          seen.push(fullPath);
          return false;
        },
      },
    );
    expect(seen.sort()).toEqual([join(base, 'a.txt'), join(base, 'b.txt')]);
    expect(walkTreeNoFollow(base, { maxEntries: 100, maxDepth: 8 }, { file: () => true }).stopped).toBe(true);
  });
});

describe('listArtifactOutputNames (workflow inspect, WP-83)', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ironcurtain-list-outputs-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('lists only real directories, sorted, never following or failing on planted links', () => {
    const root = join(base, '.workflow');
    mkdirSync(join(root, 'review'), { recursive: true });
    mkdirSync(join(root, 'plan'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    symlinkSync(join(base, 'gone'), join(root, 'dangling'));
    symlinkSync(base, join(root, 'linked-dir'));
    if (fifoSupported) makeFifo(join(root, 'pipe'));

    expect(listArtifactOutputNames(root)).toEqual({ kind: 'ok', names: ['plan', 'review'], truncated: false });
  });

  it('reports a missing root, and refuses a root that is a symlink or a file', () => {
    expect(listArtifactOutputNames(join(base, 'absent'))).toEqual({ kind: 'missing' });
    mkdirSync(join(base, 'elsewhere', 'host-dir'), { recursive: true });
    symlinkSync(join(base, 'elsewhere'), join(base, 'linked-root'));
    expect(listArtifactOutputNames(join(base, 'linked-root'))).toEqual({ kind: 'not_directory' });
    writeFileSync(join(base, 'file-root'), 'x');
    expect(listArtifactOutputNames(join(base, 'file-root'))).toEqual({ kind: 'not_directory' });
  });

  it('stops after the entry limit and says so', () => {
    for (let i = 0; i < 6; i++) mkdirSync(join(base, `out-${i}`));
    const listing = listArtifactOutputNames(base, 4);
    expect(listing).toMatchObject({ kind: 'ok', truncated: true });
    expect(listing.kind === 'ok' ? listing.names : []).toHaveLength(4);
  });
});

describe('resolveArtifactOutputDir', () => {
  let workspace: string;
  let artifactDir: string;
  let outside: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-outputs-'));
    artifactDir = join(workspace, '.workflow');
    mkdirSync(artifactDir);
    outside = mkdtempSync(join(tmpdir(), 'ironcurtain-outputs-outside-'));
    mkdirSync(join(outside, 'plan'));
    writeFileSync(join(outside, 'plan', 'host-file'), 'x');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('accepts a real directory below the workspace, including nested names', () => {
    mkdirSync(join(artifactDir, 'plan'));
    mkdirSync(join(artifactDir, 'reviews', 'round1'), { recursive: true });
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'plan')).toEqual({
      kind: 'ok',
      dir: join(artifactDir, 'plan'),
    });
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'reviews/round1')).toEqual({
      kind: 'ok',
      dir: join(artifactDir, 'reviews', 'round1'),
    });
  });

  it('reports absent outputs and non-directories as missing', () => {
    writeFileSync(join(artifactDir, 'file-output'), 'x');
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'plan')).toEqual({ kind: 'missing' });
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'file-output')).toEqual({ kind: 'missing' });
    rmSync(artifactDir, { recursive: true });
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'plan')).toEqual({ kind: 'missing' });
  });

  it('rejects a symlinked output dir, even to /', () => {
    symlinkSync('/', join(artifactDir, 'plan'));
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'plan')).toEqual({
      kind: 'rejected',
      reason: 'symlink',
      path: join(artifactDir, 'plan'),
    });
  });

  it('rejects a symlinked .workflow root and a symlinked intermediate component', () => {
    mkdirSync(join(artifactDir, 'real'));
    symlinkSync(join(outside), join(artifactDir, 'nested'));
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'nested/plan')).toEqual({
      kind: 'rejected',
      reason: 'symlink',
      path: join(artifactDir, 'nested'),
    });

    rmSync(artifactDir, { recursive: true });
    symlinkSync(outside, artifactDir);
    expect(resolveArtifactOutputDir(workspace, artifactDir, 'plan')).toEqual({
      kind: 'rejected',
      reason: 'symlink',
      path: artifactDir,
    });
  });

  it('rejects a real directory outside the workspace and names that are not plain paths', () => {
    expect(resolveArtifactOutputDir(workspace, outside, 'plan')).toEqual({
      kind: 'rejected',
      reason: 'outside_workspace',
      path: join(outside, 'plan'),
    });
    for (const bad of ['', '../plan', 'a/../b', '/etc', 'a//b', './plan']) {
      expect(resolveArtifactOutputDir(workspace, artifactDir, bad).kind, bad).toBe('rejected');
    }
  });
});

describe('prepareWorkflowArtifactDir', () => {
  let workspace: string;
  let hostHome: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-prepare-'));
    hostHome = mkdtempSync(join(tmpdir(), 'ironcurtain-prepare-host-'));
    mkdirSync(join(hostHome, '.ssh'));
    writeFileSync(join(hostHome, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA host-key\n');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });

  const description = (): string => join(workspace, '.workflow', 'task', 'description.md');

  it('creates the tree and writes the description in a fresh workspace', () => {
    const prepared = prepareWorkflowArtifactDir(workspace, 'Refactor the parser');
    expect(prepared.warnings).toEqual([]);
    expect(readFileSync(description(), 'utf-8')).toBe('Refactor the parser');
    expect(statSync(description()).mode & 0o777).toBe(0o644);
  });

  it('replaces a symlinked description.md without writing through it', () => {
    mkdirSync(join(workspace, '.workflow', 'task'), { recursive: true });
    symlinkSync(join(hostHome, '.ssh', 'authorized_keys'), description());

    const prepared = prepareWorkflowArtifactDir(workspace, 'Refactor the parser');

    expect(readFileSync(join(hostHome, '.ssh', 'authorized_keys'), 'utf-8')).toBe('ssh-ed25519 AAAA host-key\n');
    expect(lstatSync(description()).isFile()).toBe(true);
    expect(readFileSync(description(), 'utf-8')).toBe('Refactor the parser');
    expect(prepared.warnings.join('\n')).toContain('symbolic link');
  });

  it('replaces a hard-linked description.md without changing the other name', () => {
    mkdirSync(join(workspace, '.workflow', 'task'), { recursive: true });
    const victim = join(workspace, 'victim.txt');
    writeFileSync(victim, 'original');
    linkSync(victim, description());

    prepareWorkflowArtifactDir(workspace, 'Refactor the parser');

    expect(readFileSync(victim, 'utf-8')).toBe('original');
    expect(readFileSync(description(), 'utf-8')).toBe('Refactor the parser');
  });

  it('moves a symlinked .workflow or .workflow/task aside and leaves the target directory untouched', () => {
    symlinkSync(hostHome, join(workspace, '.workflow'));
    const first = prepareWorkflowArtifactDir(workspace, 'one');
    expect(lstatSync(join(workspace, '.workflow')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(hostHome, 'task'))).toBe(false);
    expect(first.warnings.join('\n')).toContain('moved it aside');

    rmSync(join(workspace, '.workflow', 'task'), { recursive: true });
    symlinkSync(join(hostHome, '.ssh'), join(workspace, '.workflow', 'task'));
    const second = prepareWorkflowArtifactDir(workspace, 'two');
    expect(lstatSync(join(workspace, '.workflow', 'task')).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(hostHome, '.ssh'))).toEqual(['authorized_keys']);
    expect(readFileSync(description(), 'utf-8')).toBe('two');
    expect(second.warnings.join('\n')).toContain('moved it aside');
  });

  it('moves a directory squatting on description.md aside', () => {
    mkdirSync(description(), { recursive: true });
    const prepared = prepareWorkflowArtifactDir(workspace, 'text');
    expect(readFileSync(description(), 'utf-8')).toBe('text');
    expect(prepared.warnings.join('\n')).toContain('was a directory');
  });

  it.skipIf(!fifoSupported)('replaces a FIFO at description.md without blocking', () => {
    mkdirSync(join(workspace, '.workflow', 'task'), { recursive: true });
    makeFifo(description());
    const unblocker = startFifoUnblocker(description());
    const started = Date.now();
    try {
      prepareWorkflowArtifactDir(workspace, 'text');
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lstatSync(description()).isFile()).toBe(true);
    expect(readFileSync(description(), 'utf-8')).toBe('text');
  });
});

describe('ensureWorkflowGitignored', () => {
  let workspace: string;
  let hostHome: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-gitignore-'));
    hostHome = mkdtempSync(join(tmpdir(), 'ironcurtain-gitignore-host-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  });

  const gitignore = (): string => join(workspace, '.gitignore');

  it('creates, appends to, and recognizes an existing entry', () => {
    expect(ensureWorkflowGitignored(workspace)).toEqual({ status: 'created' });
    expect(readFileSync(gitignore(), 'utf-8')).toBe('.workflow/\n');
    expect(ensureWorkflowGitignored(workspace)).toEqual({ status: 'already_listed' });

    writeFileSync(gitignore(), 'node_modules');
    expect(ensureWorkflowGitignored(workspace)).toEqual({ status: 'appended' });
    expect(readFileSync(gitignore(), 'utf-8')).toBe('node_modules\n.workflow/\n');

    writeFileSync(gitignore(), 'dist/\n.workflow\n');
    expect(ensureWorkflowGitignored(workspace)).toEqual({ status: 'already_listed' });
  });

  it('skips a .gitignore symlinked to a host file and leaves the target unchanged', () => {
    const gitconfig = join(hostHome, '.gitconfig');
    writeFileSync(gitconfig, '[user]\n\tname = Host\n');
    symlinkSync(gitconfig, gitignore());

    const result = ensureWorkflowGitignored(workspace);

    expect(result.status).toBe('skipped');
    expect(readFileSync(gitconfig, 'utf-8')).toBe('[user]\n\tname = Host\n');
    expect(readlinkSync(gitignore())).toBe(gitconfig);
  });

  it('skips a .gitignore symlinked to /dev/zero without reading it', () => {
    symlinkSync('/dev/zero', gitignore());
    const started = Date.now();
    expect(ensureWorkflowGitignored(workspace)).toEqual({ status: 'skipped', reason: 'it is a symbolic link' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('skips a dangling .gitignore symlink instead of creating its target', () => {
    const target = join(hostHome, 'created-by-host');
    symlinkSync(target, gitignore());
    expect(ensureWorkflowGitignored(workspace).status).toBe('skipped');
    expect(existsSync(target)).toBe(false);
  });

  it('skips a hard-linked or oversized .gitignore', () => {
    const victim = join(hostHome, 'config');
    writeFileSync(victim, 'host config\n');
    linkSync(victim, gitignore());
    expect(ensureWorkflowGitignored(workspace)).toEqual({
      status: 'skipped',
      reason: 'it has more than one hard link',
    });
    expect(readFileSync(victim, 'utf-8')).toBe('host config\n');

    rmSync(gitignore());
    writeFileSync(gitignore(), Buffer.alloc(GITIGNORE_MAX_BYTES + 1, 0x23));
    expect(ensureWorkflowGitignored(workspace).status).toBe('skipped');
    expect(statSync(gitignore()).size).toBe(GITIGNORE_MAX_BYTES + 1);
  });

  it.skipIf(!fifoSupported)('skips a FIFO .gitignore without blocking', () => {
    makeFifo(gitignore());
    const unblocker = startFifoUnblocker(gitignore());
    const started = Date.now();
    let result: ReturnType<typeof ensureWorkflowGitignored>;
    try {
      result = ensureWorkflowGitignored(workspace);
    } finally {
      unblocker.stop();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ status: 'skipped', reason: 'it is not a regular file' });
    expect(lstatSync(gitignore()).isFIFO()).toBe(true);
  });
});

describe('snapshotArtifacts on agent-controlled outputs', () => {
  let workspace: string;
  let artifactDir: string;
  let hostDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-snapshot-'));
    artifactDir = join(workspace, '.workflow');
    mkdirSync(artifactDir);
    hostDir = mkdtempSync(join(tmpdir(), 'ironcurtain-snapshot-host-'));
    mkdirSync(join(hostDir, 'plan'));
    writeFileSync(join(hostDir, 'plan', 'host-file'), 'host');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  });

  it('does not snapshot a symlinked output', () => {
    symlinkSync(join(hostDir, 'plan'), join(artifactDir, 'plan'));
    snapshotArtifacts(artifactDir, ['plan'], 2, new Set(), workspace);
    snapshotArtifacts(artifactDir, ['plan'], 3, new Set());
    expect(existsSync(join(artifactDir, 'plan.v1'))).toBe(false);
    expect(existsSync(join(artifactDir, 'plan.v2'))).toBe(false);
  });

  it('does not copy inside a host directory reached through a symlinked .workflow root', () => {
    rmSync(artifactDir, { recursive: true });
    symlinkSync(hostDir, artifactDir);
    snapshotArtifacts(artifactDir, ['plan'], 2, new Set(), workspace);
    expect(readdirSync(hostDir)).toEqual(['plan']);
  });

  it('leaves an entry already at the versioned name alone, even a dangling symlink', () => {
    mkdirSync(join(artifactDir, 'plan'));
    writeFileSync(join(artifactDir, 'plan', 'p.md'), 'plan');
    symlinkSync(join(hostDir, 'new-dir'), join(artifactDir, 'plan.v1'));
    snapshotArtifacts(artifactDir, ['plan'], 2, new Set(), workspace);
    expect(existsSync(join(hostDir, 'new-dir'))).toBe(false);
    expect(lstatSync(join(artifactDir, 'plan.v1')).isSymbolicLink()).toBe(true);
  });

  it('still snapshots a real output directory', () => {
    mkdirSync(join(artifactDir, 'plan'));
    writeFileSync(join(artifactDir, 'plan', 'p.md'), 'plan');
    snapshotArtifacts(artifactDir, ['plan'], 2, new Set(), workspace);
    expect(readFileSync(join(artifactDir, 'plan.v1', 'p.md'), 'utf-8')).toBe('plan');
  });
});
