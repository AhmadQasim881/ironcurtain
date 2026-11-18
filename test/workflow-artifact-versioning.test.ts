/**
 * Tests for artifact versioning via snapshotArtifacts().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  constants as fsConstants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Pass-through `node:fs` with two seams, so a test can act as a live agent in
// the shared workspace at the exact moment the host looks at or opens a path:
// `afterLstat` runs after every lstatSync (with whether it threw), and
// `beforeOpen` runs before every openSync.
const fsHooks = vi.hoisted(() => ({
  afterLstat: undefined as ((path: string, threw: boolean) => void) | undefined,
  beforeOpen: undefined as ((path: string, flags: number) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = (path: unknown, ...rest: unknown[]): unknown => {
    let threw = false;
    try {
      return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      fsHooks.afterLstat?.(String(path), threw);
    }
  };
  const openSync = (path: unknown, flags: unknown, ...rest: unknown[]): number => {
    fsHooks.beforeOpen?.(String(path), typeof flags === 'number' ? flags : 0);
    return (actual.openSync as (...args: unknown[]) => number)(path, flags, ...rest);
  };
  return { ...actual, lstatSync, openSync };
});

// Pass-through so a test can fail one file copy via mockImplementationOnce.
vi.mock('../src/hardened-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hardened-fs.js')>();
  return { ...actual, copyRegularFileBelow: vi.fn(actual.copyRegularFileBelow) };
});

import { copyRegularFileBelow } from '../src/hardened-fs.js';
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_WALK_LIMITS, snapshotArtifacts } from '../src/workflow/artifacts.js';
import { fifoSupported, makeFifo, startFifoUnblocker } from './helpers/fifo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let artifactDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-artifact-version-'));
}

function writeArtifactFile(outputName: string, fileName: string, content: string): void {
  const dir = resolve(artifactDir, outputName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), content);
}

function readVersionedFile(outputName: string, version: number, fileName: string): string {
  return readFileSync(resolve(artifactDir, `${outputName}.v${version}`, fileName), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  artifactDir = createTempDir();
});

afterEach(() => {
  fsHooks.afterLstat = undefined;
  fsHooks.beforeOpen = undefined;
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('snapshotArtifacts', () => {
  it('creates .v1 backup on second visit', () => {
    writeArtifactFile('analysis', 'analysis.md', 'original analysis');

    snapshotArtifacts(artifactDir, ['analysis'], 2, new Set());

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('original analysis');
  });

  it('creates .v2 backup on third visit', () => {
    writeArtifactFile('analysis', 'analysis.md', 'round-two analysis');

    snapshotArtifacts(artifactDir, ['analysis'], 3, new Set());

    expect(readVersionedFile('analysis', 2, 'analysis.md')).toBe('round-two analysis');
  });

  it('skips artifacts in the unversionedArtifacts set', () => {
    writeArtifactFile('journal', 'journal.md', 'append-only log');

    snapshotArtifacts(artifactDir, ['journal'], 2, new Set(['journal']));

    expect(existsSync(resolve(artifactDir, 'journal.v1'))).toBe(false);
  });

  it('does not overwrite an existing versioned directory (idempotency)', () => {
    writeArtifactFile('analysis', 'analysis.md', 'original content');

    // Simulate a previous snapshot that already created .v1
    const existingVersionDir = resolve(artifactDir, 'analysis.v1');
    mkdirSync(existingVersionDir, { recursive: true });
    writeFileSync(resolve(existingVersionDir, 'analysis.md'), 'preserved content');

    // Now overwrite the source with new content
    writeArtifactFile('analysis', 'analysis.md', 'corrupted content');

    snapshotArtifacts(artifactDir, ['analysis'], 2, new Set());

    // The .v1 should still have the preserved content, NOT the corrupted content
    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('preserved content');
  });

  it('does nothing when source directory does not exist', () => {
    // No artifact directory created — the agent failed before writing output
    snapshotArtifacts(artifactDir, ['nonexistent'], 2, new Set());

    expect(existsSync(resolve(artifactDir, 'nonexistent.v1'))).toBe(false);
  });

  it('recursively copies nested subdirectories', () => {
    const subDir = resolve(artifactDir, 'harness_build', 'src', 'tests');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(artifactDir, 'harness_build', 'README.md'), 'top-level');
    writeFileSync(resolve(subDir, 'test_main.c'), 'int main() {}');

    snapshotArtifacts(artifactDir, ['harness_build'], 2, new Set());

    expect(readVersionedFile('harness_build', 1, 'README.md')).toBe('top-level');
    expect(readFileSync(resolve(artifactDir, 'harness_build.v1', 'src', 'tests', 'test_main.c'), 'utf-8')).toBe(
      'int main() {}',
    );
  });

  it('does nothing on first visit (visitNumber === 1)', () => {
    writeArtifactFile('analysis', 'analysis.md', 'first visit');

    snapshotArtifacts(artifactDir, ['analysis'], 1, new Set());

    expect(existsSync(resolve(artifactDir, 'analysis.v0'))).toBe(false);
    expect(existsSync(resolve(artifactDir, 'analysis.v1'))).toBe(false);
  });

  it('snapshots multiple outputs in a single call', () => {
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');
    writeArtifactFile('harness_design', 'design.md', 'design content');

    snapshotArtifacts(artifactDir, ['analysis', 'harness_design'], 2, new Set());

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');
    expect(readVersionedFile('harness_design', 1, 'design.md')).toBe('design content');
  });

  it('snapshots some outputs while skipping unversioned ones', () => {
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');
    writeArtifactFile('journal', 'journal.md', 'journal content');

    snapshotArtifacts(artifactDir, ['analysis', 'journal'], 2, new Set(['journal']));

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');
    expect(existsSync(resolve(artifactDir, 'journal.v1'))).toBe(false);
  });

  it('logs a warning and continues when a single copy fails', () => {
    writeArtifactFile('broken', 'broken.md', 'triggers copy error');
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');

    // Fail the first file copy only; the second output proceeds normally.
    vi.mocked(copyRegularFileBelow).mockImplementationOnce(() => {
      throw new Error('simulated copy failure');
    });

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    try {
      expect(() => snapshotArtifacts(artifactDir, ['broken', 'analysis'], 2, new Set())).not.toThrow();
    } finally {
      stderrSpy.mockRestore();
    }

    // The failed artifact was not snapshotted.
    expect(existsSync(resolve(artifactDir, 'broken.v1'))).toBe(false);
    // The subsequent artifact in the same call still got snapshotted.
    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');

    // A warning was written to stderr mentioning src, dest, and the error message.
    const combined = stderrWrites.join('');
    expect(combined).toMatch(/snapshotArtifacts/);
    expect(combined).toContain(resolve(artifactDir, 'broken'));
    expect(combined).toContain(resolve(artifactDir, 'broken.v1'));
    expect(combined).toContain('simulated copy failure');
  });
});

// ---------------------------------------------------------------------------
// A live agent in the shared workspace
// ---------------------------------------------------------------------------

describe('snapshotArtifacts with a live agent in the workspace', () => {
  // In shared-container mode the agent's container (a peer fan-out lane, or a
  // background process an earlier turn left behind) keeps running while the
  // host snapshots its outputs, so it can create entries in the half-built
  // snapshot and swap entries in the source. The hooks above play that agent
  // at the exact moment the host looks at or opens a path.
  let base: string;
  let workspace: string;
  let workflowDir: string;
  let hostSsh: string;
  let stderrWrites: string[];
  let stderrSpy: { mockRestore(): void };

  const hostKey = 'ssh-ed25519 HOST key\n';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ironcurtain-snapshot-live-'));
    workspace = join(base, 'workspace');
    workflowDir = join(workspace, '.workflow');
    hostSsh = join(base, 'host-home', '.ssh');
    mkdirSync(join(workflowDir, 'plan'), { recursive: true });
    mkdirSync(hostSsh, { recursive: true });
    writeFileSync(join(hostSsh, 'authorized_keys'), hostKey);
    stderrWrites = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(base, { recursive: true, force: true });
  });

  it('never writes through a symlink planted inside the half-built snapshot', () => {
    writeFileSync(join(workflowDir, 'plan', 'authorized_keys'), 'ssh-ed25519 ATTACKER key\n');
    const dest = join(workflowDir, 'plan.v1');
    // Right after the host saw nothing at the versioned name, the agent creates
    // it with a link to a host file at a name the copy is about to write.
    fsHooks.afterLstat = (path, threw) => {
      if (path !== dest || !threw) return;
      fsHooks.afterLstat = undefined;
      mkdirSync(dest);
      symlinkSync(join(hostSsh, 'authorized_keys'), join(dest, 'authorized_keys'));
    };

    snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);

    expect(fsHooks.afterLstat).toBeUndefined(); // the agent really acted
    expect(readFileSync(join(hostSsh, 'authorized_keys'), 'utf-8')).toBe(hostKey);
    expect(lstatSync(join(dest, 'authorized_keys')).isSymbolicLink()).toBe(true);
    expect(stderrWrites.join('')).toContain('snapshotArtifacts: failed to copy');
  });

  it('creates nothing with content in a host directory the snapshot directory is swapped for', () => {
    writeFileSync(join(workflowDir, 'plan', 'notes.md'), 'attacker content');
    const dest = join(workflowDir, 'plan.v1');
    fsHooks.beforeOpen = (path, flags) => {
      if ((flags & fsConstants.O_CREAT) === 0 || !path.endsWith(join('plan.v1', 'notes.md'))) return;
      fsHooks.beforeOpen = undefined;
      renameSync(dest, join(workflowDir, 'plan.v1-moved'));
      symlinkSync(hostSsh, dest);
    };

    snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);

    expect(fsHooks.beforeOpen).toBeUndefined();
    const strays = readdirSync(hostSsh).filter((name) => name !== 'authorized_keys');
    if (process.platform === 'linux') {
      // Located through /proc/self/fd before anything was written, and removed.
      expect(strays).toEqual([]);
    } else {
      for (const name of strays) expect(statSync(join(hostSsh, name)).size).toBe(0);
    }
    expect(readFileSync(join(hostSsh, 'authorized_keys'), 'utf-8')).toBe(hostKey);
    expect(stderrWrites.join('')).toContain('snapshotArtifacts: failed to copy');
  });

  it('never copies a host file when a source file is swapped for a link to it', () => {
    writeFileSync(join(hostSsh, 'id_ed25519'), 'PRIVATE KEY');
    writeFileSync(join(workflowDir, 'plan', 'notes.md'), 'notes');
    writeFileSync(join(workflowDir, 'plan', 'plan.md'), 'the plan');
    fsHooks.beforeOpen = (path, flags) => {
      if ((flags & fsConstants.O_CREAT) !== 0 || !path.endsWith(join('.workflow', 'plan', 'notes.md'))) return;
      fsHooks.beforeOpen = undefined;
      rmSync(join(workflowDir, 'plan', 'notes.md'));
      symlinkSync(join(hostSsh, 'id_ed25519'), join(workflowDir, 'plan', 'notes.md'));
    };

    snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);

    expect(fsHooks.beforeOpen).toBeUndefined();
    expect(existsSync(join(workflowDir, 'plan.v1', 'notes.md'))).toBe(false);
    expect(readFileSync(join(workflowDir, 'plan.v1', 'plan.md'), 'utf-8')).toBe('the plan');
  });

  it.skipIf(!fifoSupported)('copies only regular files: FIFOs and symlinks are skipped without blocking', () => {
    writeFileSync(join(workflowDir, 'plan', 'plan.md'), 'the plan');
    makeFifo(join(workflowDir, 'plan', 'pipe'));
    symlinkSync(join(hostSsh, 'authorized_keys'), join(workflowDir, 'plan', 'keys'));
    const unblocker = startFifoUnblocker(join(workflowDir, 'plan', 'pipe'));
    const started = Date.now();
    try {
      snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);
    } finally {
      unblocker.stop();
    }

    expect(Date.now() - started).toBeLessThan(1000);
    expect(readdirSync(join(workflowDir, 'plan.v1'))).toEqual(['plan.md']);
  });

  it('refuses to copy more than SNAPSHOT_MAX_BYTES', () => {
    writeFileSync(join(workflowDir, 'plan', 'plan.md'), 'the plan');
    // Sparse, so it costs no disk here, but a plain copy would write a GiB.
    writeFileSync(join(workflowDir, 'plan', 'huge.bin'), '');
    truncateSync(join(workflowDir, 'plan', 'huge.bin'), SNAPSHOT_MAX_BYTES + 1);
    const started = Date.now();

    snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(join(workflowDir, 'plan.v1', 'huge.bin'))).toBe(false);
    expect(stderrWrites.join('')).toContain(`more than ${SNAPSHOT_MAX_BYTES} bytes to copy`);
  });

  it('reports a snapshot cut short by the walk limits as partial', () => {
    let deepest = join(workflowDir, 'plan');
    for (let level = 0; level <= SNAPSHOT_WALK_LIMITS.maxDepth + 1; level++) deepest = join(deepest, 'd');
    mkdirSync(deepest, { recursive: true });
    writeFileSync(join(deepest, 'too-deep.md'), 'unreachable');
    writeFileSync(join(workflowDir, 'plan', 'plan.md'), 'the plan');

    snapshotArtifacts(workflowDir, ['plan'], 2, new Set(), workspace);

    expect(readFileSync(join(workflowDir, 'plan.v1', 'plan.md'), 'utf-8')).toBe('the plan');
    expect(stderrWrites.join('')).toContain('the snapshot is partial');
  });

  it('keeps permission bits, nested output names and empty outputs', () => {
    writeFileSync(join(workflowDir, 'plan', 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(workflowDir, 'plan', 'run.sh'), 0o755);
    mkdirSync(join(workflowDir, 'empty'));
    mkdirSync(join(workflowDir, 'reviews', 'round1'), { recursive: true });
    writeFileSync(join(workflowDir, 'reviews', 'round1', 'review.md'), 'lgtm');

    snapshotArtifacts(workflowDir, ['plan', 'empty', 'reviews/round1'], 2, new Set(), workspace);

    expect(statSync(join(workflowDir, 'plan.v1', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(workflowDir, 'empty.v1'))).toEqual([]);
    expect(readFileSync(join(workflowDir, 'reviews', 'round1.v1', 'review.md'), 'utf-8')).toBe('lgtm');
    expect(stderrWrites.join('')).toBe('');
  });
});
