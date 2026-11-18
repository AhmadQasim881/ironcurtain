/**
 * Unit tests for src/trusted-process/roots-expansion.ts: which roots an
 * approved escalation may add, the post-approval re-canonicalization
 * check, backend roots verification and roots-race detection.
 *
 * Uses real temp directories (realpath'd, so macOS /tmp -> /private/tmp
 * does not matter) because root selection checks the filesystem.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  captureApprovedPaths,
  describeRootsVerificationFailure,
  findChangedApprovedPaths,
  isReadOnlyAnnotation,
  isRootsRaceResult,
  listBackendAllowedDirectories,
  parseAllowedDirectories,
  selectRootsToAdd,
  verifyBackendRoots,
} from '../src/trusted-process/roots-expansion.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import type { McpRoot } from '../src/trusted-process/mcp-client-manager.js';

let base: string;
let sandbox: string;
let outside: string;
let approvedDir: string;
let secret: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'roots-expansion-test-')));
  sandbox = join(base, 'sandbox');
  outside = join(base, 'outside');
  approvedDir = join(outside, 'approved');
  secret = join(base, 'secret');
  mkdirSync(join(sandbox, 'sub'), { recursive: true });
  mkdirSync(approvedDir, { recursive: true });
  mkdirSync(secret);
  writeFileSync(join(sandbox, 'sub', 'a.txt'), 'in sandbox');
  writeFileSync(join(approvedDir, 'notes.txt'), 'approved notes');
  writeFileSync(join(outside, 'b.txt'), 'outside file');
  writeFileSync(join(secret, 'id_rsa'), 'TOP-SECRET');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const readManyAnnotation: ToolAnnotation = {
  toolName: 'read_multiple_files',
  serverName: 'filesystem',
  comment: 'Reads several files.',
  args: { paths: ['read-path'] },
};

const moveAnnotation: ToolAnnotation = {
  toolName: 'move_file',
  serverName: 'filesystem',
  comment: 'Moves a file.',
  args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
};

function root(path: string): McpRoot {
  return { uri: pathToFileURL(path).href, name: 'test' };
}

function sandboxRoot(): McpRoot[] {
  return [root(sandbox)];
}

// ---------------------------------------------------------------------------
// captureApprovedPaths
// ---------------------------------------------------------------------------

describe('captureApprovedPaths', () => {
  it('records every path argument but gives a root only to escalated roles', () => {
    const captured = captureApprovedPaths({
      args: { source: join(sandbox, 'sub', 'a.txt'), destination: join(outside, 'moved.txt') },
      annotation: moveAnnotation,
      escalatedRoles: ['write-path'],
      allowedDirectory: sandbox,
    });

    expect(captured).toEqual([
      { value: join(sandbox, 'sub', 'a.txt'), canonical: join(sandbox, 'sub', 'a.txt') },
      { value: join(outside, 'moved.txt'), canonical: join(outside, 'moved.txt'), rootDirectory: outside },
    ]);
  });

  it('uses an existing directory itself as its root and a file parent otherwise', () => {
    const captured = captureApprovedPaths({
      args: { paths: [approvedDir, join(outside, 'b.txt')] },
      annotation: readManyAnnotation,
      escalatedRoles: ['read-path'],
      allowedDirectory: sandbox,
    });
    expect(captured.map((p) => p.rootDirectory)).toEqual([approvedDir, outside]);
  });

  it('resolves relative values against the sandbox, never the process cwd', () => {
    const [captured] = captureApprovedPaths({
      args: { paths: ['sub/a.txt'] },
      annotation: readManyAnnotation,
      escalatedRoles: ['read-path'],
      allowedDirectory: sandbox,
    });
    expect(captured.canonical).toBe(join(sandbox, 'sub', 'a.txt'));
    expect(captured.rootDirectory).toBe(join(sandbox, 'sub'));
    expect(captured.rootDirectory).not.toBe(resolve('sub'));
  });

  it('gives no root to a relative value when there is no sandbox', () => {
    const [captured] = captureApprovedPaths({
      args: { paths: ['sub/a.txt'] },
      annotation: readManyAnnotation,
      escalatedRoles: ['read-path'],
      allowedDirectory: undefined,
    });
    expect(captured.rootDirectory).toBeUndefined();
  });

  it('gives no roots at all when the engine reports no escalated roles', () => {
    const captured = captureApprovedPaths({
      args: { paths: [join(outside, 'b.txt')] },
      annotation: readManyAnnotation,
      escalatedRoles: undefined,
      allowedDirectory: sandbox,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].rootDirectory).toBeUndefined();
  });

  it('keeps the evaluated path and derives no root when it no longer resolves to itself', () => {
    // The policy engine evaluated <sandbox>/flip/id_rsa while flip was a
    // real directory; the agent swaps flip for a symlink before the
    // capture runs. Re-resolving here would make the secret directory a
    // root candidate.
    const flip = join(sandbox, 'flip');
    mkdirSync(flip);
    const evaluated = join(flip, 'id_rsa');
    try {
      rmSync(flip, { recursive: true });
      symlinkSync(secret, flip);

      const captured = captureApprovedPaths({
        args: { paths: [evaluated, join(outside, 'b.txt')] },
        annotation: readManyAnnotation,
        escalatedRoles: ['read-path'],
        allowedDirectory: sandbox,
      });

      expect(captured).toEqual([
        { value: evaluated, canonical: evaluated },
        { value: join(outside, 'b.txt'), canonical: join(outside, 'b.txt'), rootDirectory: outside },
      ]);
      expect(findChangedApprovedPaths(captured, sandbox).map((p) => p.value)).toEqual([evaluated]);
      expect(
        selectRootsToAdd({ approvedPaths: captured, existingRoots: sandboxRoot(), allowedDirectory: sandbox }),
      ).toEqual([outside]);
    } finally {
      rmSync(flip, { recursive: true, force: true });
    }
  });

  it('ignores non-path roles even when they escalated', () => {
    const captured = captureApprovedPaths({
      args: { url: 'https://example.com/repo.git', path: join(outside, 'repo') },
      annotation: {
        toolName: 'git_clone',
        serverName: 'git',
        comment: 'Clones a repo.',
        args: { url: ['git-remote-url'], path: ['write-path'] },
      },
      escalatedRoles: ['git-remote-url'],
      allowedDirectory: sandbox,
    });
    expect(captured).toEqual([{ value: join(outside, 'repo'), canonical: join(outside, 'repo') }]);
  });
});

// ---------------------------------------------------------------------------
// findChangedApprovedPaths
// ---------------------------------------------------------------------------

describe('findChangedApprovedPaths', () => {
  it('reports nothing when the paths still resolve to the same place', () => {
    const captured = captureApprovedPaths({
      args: { paths: [join(approvedDir, 'notes.txt'), join(outside, 'new.txt'), 'sub/a.txt'] },
      annotation: readManyAnnotation,
      escalatedRoles: ['read-path'],
      allowedDirectory: sandbox,
    });
    expect(findChangedApprovedPaths(captured, sandbox)).toEqual([]);
  });

  it('detects a directory swapped for a symlink after evaluation', () => {
    const swapDir = join(outside, 'swap');
    mkdirSync(swapDir);
    try {
      const captured = captureApprovedPaths({
        args: { paths: [join(swapDir, 'id_rsa')] },
        annotation: readManyAnnotation,
        escalatedRoles: ['read-path'],
        allowedDirectory: sandbox,
      });
      expect(captured[0].rootDirectory).toBe(swapDir);

      // The agent replaces the directory while the approver decides.
      renameSync(swapDir, `${swapDir}.orig`);
      symlinkSync(secret, swapDir);

      const changed = findChangedApprovedPaths(captured, sandbox);
      expect(changed.map((p) => p.value)).toEqual([join(swapDir, 'id_rsa')]);
    } finally {
      rmSync(swapDir, { recursive: true, force: true });
      rmSync(`${swapDir}.orig`, { recursive: true, force: true });
    }
  });

  it('detects a swap of an in-sandbox directory referenced by a relative path', () => {
    const cmp = join(sandbox, 'cmp');
    mkdirSync(cmp);
    try {
      const captured = captureApprovedPaths({
        args: { paths: ['cmp/id_rsa', join(outside, 'b.txt')] },
        annotation: readManyAnnotation,
        escalatedRoles: ['read-path'],
        allowedDirectory: sandbox,
      });
      rmSync(cmp, { recursive: true });
      symlinkSync(secret, cmp);
      expect(findChangedApprovedPaths(captured, sandbox).map((p) => p.value)).toEqual(['cmp/id_rsa']);
    } finally {
      rmSync(cmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// selectRootsToAdd
// ---------------------------------------------------------------------------

describe('selectRootsToAdd', () => {
  function select(paths: string[], existingRoots: McpRoot[] = sandboxRoot()): string[] {
    const approvedPaths = captureApprovedPaths({
      args: { paths },
      annotation: readManyAnnotation,
      escalatedRoles: ['read-path'],
      allowedDirectory: sandbox,
    });
    return selectRootsToAdd({ approvedPaths, existingRoots, allowedDirectory: sandbox });
  }

  it('adds the canonical directory of an escalated path', () => {
    expect(select([join(approvedDir, 'notes.txt')])).toEqual([approvedDir]);
  });

  it('never adds a root at or under the sandbox, even with no sandbox root present', () => {
    expect(select([join(sandbox, 'sub', 'a.txt'), 'sub/a.txt', sandbox], [])).toEqual([]);
  });

  it('adds no <cwd>/<dir> root for a relative in-sandbox path in a mixed call', () => {
    const roots = select(['sub/a.txt', join(outside, 'b.txt')]);
    expect(roots).toEqual([outside]);
    expect(roots).not.toContain(resolve('sub'));
  });

  it('never adds a root under the IronCurtain home', () => {
    const home = join(base, 'ic-home');
    mkdirSync(join(home, 'sessions', 'other'), { recursive: true });
    vi.stubEnv('IRONCURTAIN_HOME', home);
    expect(select([join(home, 'sessions', 'other', 'x.txt'), home])).toEqual([]);
  });

  it('skips paths an existing root already contains (containment, not exact URI)', () => {
    expect(select([join(approvedDir, 'notes.txt')], [...sandboxRoot(), root(outside)])).toEqual([]);
  });

  it('collapses nested candidates into the outermost one', () => {
    expect(select([join(approvedDir, 'notes.txt'), outside])).toEqual([outside]);
  });

  it('skips directories that do not exist', () => {
    expect(select([join(outside, 'missing-dir', 'new.txt')])).toEqual([]);
  });

  it('skips a candidate that is no longer a real directory when roots are added', () => {
    const transient = join(outside, 'transient');
    mkdirSync(transient);
    try {
      const approvedPaths = captureApprovedPaths({
        args: { paths: [transient] },
        annotation: readManyAnnotation,
        escalatedRoles: ['read-path'],
        allowedDirectory: sandbox,
      });
      expect(approvedPaths[0].rootDirectory).toBe(transient);
      rmSync(transient, { recursive: true });
      symlinkSync(secret, transient);
      expect(selectRootsToAdd({ approvedPaths, existingRoots: sandboxRoot(), allowedDirectory: sandbox })).toEqual([]);
    } finally {
      rmSync(transient, { recursive: true, force: true });
    }
  });

  it('skips directory names the server would rewrite', () => {
    for (const name of ['trailing-space ', "quote'", 'quote"']) {
      const dir = join(outside, name);
      mkdirSync(dir);
      try {
        expect(select([join(dir, 'file.txt')])).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('skips directory names containing control characters', () => {
    const dir = join(outside, 'line\nbreak');
    mkdirSync(dir);
    try {
      expect(select([join(dir, 'file.txt')])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts names with URL syntax, which the URI encoding preserves', () => {
    const dir = join(outside, 'x#y?z');
    mkdirSync(dir);
    try {
      expect(select([join(dir, 'file.txt')])).toEqual([dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('on a case-insensitive volume (simulated)', () => {
    // realpathSync keeps the caller's spelling of each component, while the
    // server's native realpath returns the on-disk one. On Linux the two
    // agree, so the native realpath is stubbed to report another spelling.
    const nativeRealpath = realpathSync.native;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function stubServerSpelling(spellings: Record<string, string>): void {
      vi.spyOn(realpathSync, 'native').mockImplementation(
        (path: PathLike) => spellings[String(path)] ?? nativeRealpath(path),
      );
    }

    it('sends the root in the spelling the server reports', () => {
      const onDisk = join(outside, 'Approved');
      stubServerSpelling({ [approvedDir]: onDisk });
      expect(select([join(approvedDir, 'notes.txt')])).toEqual([onDisk]);
    });

    it('never adds a root under the on-disk spelling of the workspace', () => {
      // The workspace was configured as <base>/sandbox but is <base>/Sandbox
      // on disk; a path the agent spells the on-disk way is still inside it.
      const onDiskWorkspace = join(base, 'Sandbox');
      mkdirSync(join(onDiskWorkspace, 'sub'), { recursive: true });
      try {
        stubServerSpelling({ [sandbox]: onDiskWorkspace });
        expect(select([join(onDiskWorkspace, 'sub', 'x.txt')], [])).toEqual([]);
      } finally {
        rmSync(onDiskWorkspace, { recursive: true, force: true });
      }
    });

    it('treats a path inside the on-disk spelling of an existing root as covered', () => {
      const onDisk = join(base, 'Outside');
      mkdirSync(join(onDisk, 'approved'), { recursive: true });
      try {
        stubServerSpelling({ [outside]: onDisk });
        expect(select([join(onDisk, 'approved', 'notes.txt')], [...sandboxRoot(), root(outside)])).toEqual([]);
      } finally {
        rmSync(onDisk, { recursive: true, force: true });
      }
    });
  });

  it('adds nothing for paths that did not escalate', () => {
    const approvedPaths = captureApprovedPaths({
      args: { source: join(approvedDir, 'notes.txt'), destination: join(sandbox, 'sub', 'copy.txt') },
      annotation: moveAnnotation,
      escalatedRoles: ['write-path'],
      allowedDirectory: sandbox,
    });
    // Only the destination escalated, and it is inside the sandbox.
    expect(selectRootsToAdd({ approvedPaths, existingRoots: sandboxRoot(), allowedDirectory: sandbox })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backend verification
// ---------------------------------------------------------------------------

function listingClient(listings: string[][]): { client: Pick<Client, 'callTool'>; calls: () => number } {
  let call = 0;
  const callTool = vi.fn(async () => {
    const listing = listings[Math.min(call, listings.length - 1)];
    call++;
    return { content: [{ type: 'text', text: `Allowed directories:\n${listing.join('\n')}` }], isError: false };
  });
  return { client: { callTool } as unknown as Pick<Client, 'callTool'>, calls: () => call };
}

describe('verifyBackendRoots', () => {
  const intended = (): McpRoot[] => [root(sandbox), root(outside)];

  it('verifies once the backend reports the added roots', async () => {
    const { client } = listingClient([[sandbox, outside]]);
    await expect(verifyBackendRoots(client, intended(), [outside])).resolves.toEqual({ status: 'verified' });
  });

  it('polls until the backend has applied the refresh', async () => {
    const { client, calls } = listingClient([[sandbox], [sandbox], [sandbox, outside]]);
    const result = await verifyBackendRoots(client, intended(), [outside], { pollIntervalMs: 1 });
    expect(result).toEqual({ status: 'verified' });
    expect(calls()).toBe(3);
  });

  it('fails on a directory outside the intended set (a root resolved elsewhere)', async () => {
    const { client } = listingClient([[sandbox, secret]]);
    const result = await verifyBackendRoots(client, intended(), [outside]);
    expect(result).toEqual({ status: 'unexpected', directories: [secret] });
  });

  it('accepts the on-disk spelling the server reports for an intended root', async () => {
    // macOS: the workspace was configured as .../sandbox, the server's
    // native realpath reports .../Sandbox. Same directory, no mismatch.
    const onDisk = join(base, 'Sandbox');
    const nativeRealpath = realpathSync.native;
    vi.spyOn(realpathSync, 'native').mockImplementation((path: PathLike) =>
      String(path) === sandbox ? onDisk : nativeRealpath(path),
    );
    try {
      const { client } = listingClient([[onDisk, outside]]);
      await expect(verifyBackendRoots(client, intended(), [outside])).resolves.toEqual({ status: 'verified' });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never accepts another spelling for a root that now resolves through a symlink', async () => {
    const redirected = join(outside, 'redirected');
    symlinkSync(secret, redirected);
    try {
      const { client } = listingClient([[sandbox, secret]]);
      const result = await verifyBackendRoots(client, [root(sandbox), root(redirected)], [sandbox]);
      expect(result).toEqual({ status: 'unexpected', directories: [secret] });
    } finally {
      rmSync(redirected, { force: true });
    }
  });

  it('fails as unconfirmed when the roots never appear', async () => {
    const { client } = listingClient([[sandbox]]);
    const result = await verifyBackendRoots(client, intended(), [outside], { timeoutMs: 20, pollIntervalMs: 5 });
    expect(result).toEqual({ status: 'unconfirmed', missing: [outside] });
  });

  it('fails as unreadable when the listing cannot be parsed', async () => {
    const client = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'file content' }], isError: false })),
    } as unknown as Pick<Client, 'callTool'>;
    const result = await verifyBackendRoots(client, intended(), [outside]);
    expect(result.status).toBe('unreadable');
  });

  it('fails as unreadable when the listing call errors', async () => {
    const client = {
      callTool: vi.fn(async () => {
        throw new Error('Not connected');
      }),
    } as unknown as Pick<Client, 'callTool'>;
    const result = await verifyBackendRoots(client, intended(), [outside]);
    expect(result).toEqual({ status: 'unreadable', error: 'Not connected' });
  });

  it('describes each failure for the audit log', () => {
    expect(describeRootsVerificationFailure({ status: 'unexpected', directories: [secret] })).toContain(secret);
    expect(describeRootsVerificationFailure({ status: 'unconfirmed', missing: [outside] })).toContain(outside);
    expect(describeRootsVerificationFailure({ status: 'unreadable', error: 'boom' })).toContain('boom');
  });
});

describe('listBackendAllowedDirectories / parseAllowedDirectories', () => {
  it('parses the server-filesystem listing', () => {
    expect(parseAllowedDirectories('Allowed directories:\n/a\n/b c')).toEqual(['/a', '/b c']);
    expect(parseAllowedDirectories('Allowed directories:\n')).toEqual([]);
  });

  it('rejects any other shape', () => {
    expect(() => parseAllowedDirectories('/a\n/b')).toThrow(/unexpected/);
  });

  it('rejects an error result', async () => {
    const client = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Allowed directories:\n/a' }], isError: true })),
    } as unknown as Pick<Client, 'callTool'>;
    await expect(listBackendAllowedDirectories(client)).rejects.toThrow(/failed/);
  });
});

// ---------------------------------------------------------------------------
// Roots-race detection
// ---------------------------------------------------------------------------

describe('isRootsRaceResult', () => {
  // server-filesystem's per-file failure line inside read_multiple_files.
  const perFileDenied =
    '/data/approved/notes.txt: Error - Access denied - path outside allowed directories: ' +
    '/data/approved/notes.txt not in /data/sandbox';

  it('matches access-denied error results', () => {
    const result = {
      content: [{ type: 'text', text: 'Access denied - path outside allowed directories' }],
      isError: true,
    };
    expect(isRootsRaceResult(result, false)).toBe(true);
  });

  it('matches per-file denials in a successful read_multiple_files result', () => {
    const text = `/data/sandbox/a.txt:\nin sandbox\n\n---\n${perFileDenied}`;
    expect(isRootsRaceResult({ content: [{ type: 'text', text }] }, true)).toBe(true);
  });

  it('matches per-file symlink-target denials', () => {
    const text = '/data/x: Error - Access denied - symlink target outside allowed directories: /etc not in /data';
    expect(isRootsRaceResult({ content: [{ type: 'text', text }] }, true)).toBe(true);
  });

  it('ignores per-file denial text in results of calls that may write', () => {
    expect(isRootsRaceResult({ content: [{ type: 'text', text: perFileDenied }] }, false)).toBe(false);
  });

  it('ignores ordinary successful results', () => {
    expect(isRootsRaceResult({ content: [{ type: 'text', text: 'file content' }] }, true)).toBe(false);
    expect(isRootsRaceResult({ content: [] }, true)).toBe(false);
  });
});

describe('isReadOnlyAnnotation', () => {
  it('is true only when every resource role is read-path', () => {
    expect(isReadOnlyAnnotation(readManyAnnotation)).toBe(true);
    expect(isReadOnlyAnnotation({ ...readManyAnnotation, args: { path: ['read-path'], tail: ['none'] } })).toBe(true);
    expect(isReadOnlyAnnotation(moveAnnotation)).toBe(false);
    expect(isReadOnlyAnnotation({ ...readManyAnnotation, args: { path: ['read-path', 'write-path'] } })).toBe(false);
    expect(isReadOnlyAnnotation({ ...readManyAnnotation, args: { query: ['none'] } })).toBe(false);
  });
});
