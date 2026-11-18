/**
 * Tests for the workflow file-browser dispatch helpers and RPCs:
 * `workflows.fileTree`, `fileContent`, `artifacts`, `artifactFile`,
 * `messageLog` and `messageLogEntry` (WEB-3 / WEB-4).
 *
 * Calls that could regress into a blocking open/read (a FIFO or a device link
 * at the target) run in a child process with a hard timeout, see
 * `test/helpers/workflow-dispatch-child.ts`; everything else runs in-process.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inferLanguage,
  resolveAndContain,
  workflowDispatch,
  MAX_ARTIFACT_DEPTH,
  MAX_ARTIFACT_FILES,
  MAX_ARTIFACT_LISTING_BYTES,
  MAX_ARTIFACT_SCAN_ENTRIES,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_SCAN_ENTRIES,
  MAX_INLINE_MESSAGE_CHARS,
  MAX_MESSAGE_LOG_PAGE_BYTES,
  type WorkflowDispatchContext,
} from '../src/web-ui/dispatch/workflow-dispatch.js';
import {
  RpcError,
  type ArtifactContentDto,
  type FileContentResponseDto,
  type FileTreeResponseDto,
  type MessageLogEntryResponseDto,
  type MessageLogResponseDto,
} from '../src/web-ui/web-ui-types.js';
import { WebUiServer, type WebUiServerOptions } from '../src/web-ui/web-ui-server.js';
import { SessionManager } from '../src/session/session-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { WorkflowController } from '../src/workflow/orchestrator.js';
import type { PastRunLoadResult, WorkflowManager } from '../src/workflow/workflow-manager.js';
import type { MessageLogEntry } from '../src/workflow/message-log.js';
import type { ChildPlan, ChildResult } from './helpers/workflow-dispatch-child.js';
import { fifoSupported, makeFifo } from './helpers/fifo.js';
import { startSymlinkRacer, type SymlinkRacer } from './helpers/symlink-racer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');
const childScript = resolve(projectRoot, 'test/helpers/workflow-dispatch-child.ts');
/** Hard cap on a dispatch child; a correct implementation answers in milliseconds. */
const CHILD_TIMEOUT_MS = 30_000;
const hasDevZero = process.platform !== 'win32' && existsSync('/dev/zero');
const ONE_MIB = 1_048_576;

/** A fake WorkflowManager whose only (live) workflow has `workspacePath`. */
function fakeManager(
  workspacePath: string,
  opts: { baseDir?: string; loadPastRun?: () => PastRunLoadResult } = {},
): WorkflowManager {
  const controller = {
    getDetail: () => ({ workspacePath }),
    getStatus: () => undefined,
    listActive: () => [],
  } as unknown as WorkflowController;
  return {
    getOrchestrator: () => controller,
    getBaseDir: () => opts.baseDir ?? workspacePath,
    loadPastRun: opts.loadPastRun ?? (() => ({ error: 'not_found' as const })),
  } as unknown as WorkflowManager;
}

function makeContext(manager: WorkflowManager): WorkflowDispatchContext {
  return {
    handler: {} as ControlRequestHandler,
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 1,
    sessionQueues: new Map(),
    workflowManager: manager,
  };
}

async function expectRpcError(promise: Promise<unknown>, code: string): Promise<RpcError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(code);
  return caught as RpcError;
}

/**
 * Runs a plan in the dispatch child. A child killed by the timeout means a
 * call blocked (the regression these tests exist for) and fails loudly.
 */
function runInChild(plan: ChildPlan): Promise<ChildResult[]> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(tsxBin, [childScript, JSON.stringify(plan)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code, signal) => {
      if (signal) {
        rejectRun(
          new Error(`dispatch child killed by ${signal} after ${CHILD_TIMEOUT_MS} ms: a call blocked.\n${stderr}`),
        );
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`dispatch child exited with ${code}\n${stderr}`));
        return;
      }
      try {
        resolveRun(JSON.parse(stdout) as ChildResult[]);
      } catch (err) {
        rejectRun(new Error(`unparseable dispatch child output: ${stdout}\n${stderr}\n${String(err)}`));
      }
    });
  });
}

function call(method: string, params: Record<string, unknown>): ChildPlan['steps'][number] {
  return { type: 'call', method, params: { workflowId: 'wf', ...params } };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('inferLanguage', () => {
  it('maps TypeScript extensions', () => {
    expect(inferLanguage('foo.ts')).toBe('typescript');
    expect(inferLanguage('foo.tsx')).toBe('typescript');
  });

  it('maps JavaScript extensions', () => {
    expect(inferLanguage('foo.js')).toBe('javascript');
    expect(inferLanguage('foo.jsx')).toBe('javascript');
  });

  it('maps JSON', () => {
    expect(inferLanguage('package.json')).toBe('json');
  });

  it('maps Markdown', () => {
    expect(inferLanguage('README.md')).toBe('markdown');
  });

  it('maps YAML', () => {
    expect(inferLanguage('config.yaml')).toBe('yaml');
    expect(inferLanguage('config.yml')).toBe('yaml');
  });

  it('defaults to text for unknown extensions', () => {
    expect(inferLanguage('file.xyz')).toBe('text');
    expect(inferLanguage('Makefile')).toBe('text');
  });

  it('handles nested paths', () => {
    expect(inferLanguage('src/deep/nested/file.py')).toBe('python');
  });
});

describe('resolveAndContain', () => {
  const workspace = '/tmp/test-workspace';

  it('resolves simple relative paths', () => {
    const result = resolveAndContain(workspace, 'src/index.ts');
    expect(result).toBe('/tmp/test-workspace/src/index.ts');
  });

  it('rejects absolute paths', () => {
    expect(() => resolveAndContain(workspace, '/etc/passwd')).toThrow('Path must be relative');
  });

  it('rejects path traversal', () => {
    expect(() => resolveAndContain(workspace, '../../../etc/passwd')).toThrow('Path must be relative');
  });

  it('resolves empty path to workspace root', () => {
    const result = resolveAndContain(workspace, '');
    expect(result).toBe('/tmp/test-workspace');
  });

  it('resolves dot path to workspace root', () => {
    const result = resolveAndContain(workspace, '.');
    expect(result).toBe('/tmp/test-workspace');
  });
});

// ---------------------------------------------------------------------------
// WEB-3: agent-planted special files never block the daemon (child process)
// ---------------------------------------------------------------------------

describe('workspace reads never block on agent-planted special files (child process)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-child-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it.skipIf(!fifoSupported)(
    'fileContent on a file swapped for a FIFO returns an error promptly instead of blocking',
    async () => {
      writeFileSync(join(workspace, 'plan.md'), '# plan\n');

      const results = await runInChild({
        workspace,
        steps: [
          call('workflows.fileContent', { path: 'plan.md' }),
          { type: 'fifo', path: join(workspace, 'plan.md') },
          call('workflows.fileContent', { path: 'plan.md' }),
          // The tree view's directory read must not block on a FIFO either.
          call('workflows.fileTree', { path: 'plan.md' }),
        ],
      });

      expect(results[0]).toMatchObject({ ok: true, payload: { content: '# plan\n', language: 'markdown' } });
      // The FIFO is refused without being opened: no reader ever blocks.
      expect(results[1]).toMatchObject({ ok: true, payload: { error: 'Not a regular file' } });
      expect(results[1].ms).toBeLessThan(2_000);
      expect(results[2]).toMatchObject({ ok: false, code: 'INVALID_PARAMS', message: 'Path is not a directory' });
      expect(results[2].ms).toBeLessThan(2_000);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it.skipIf(!hasDevZero)(
    'a file swapped for a symlink to /dev/zero is refused without reading the device',
    async () => {
      writeFileSync(join(workspace, 'plan.md'), '# plan\n');
      const artifactDir = join(workspace, '.workflow', 'plan');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'plan.md'), '# plan\n');

      const results = await runInChild({
        workspace,
        steps: [
          { type: 'symlink', path: join(workspace, 'plan.md'), target: '/dev/zero' },
          call('workflows.fileContent', { path: 'plan.md' }),
          { type: 'symlink', path: join(artifactDir, 'plan.md'), target: '/dev/zero' },
          call('workflows.artifactFile', { artifactName: 'plan', path: 'plan.md' }),
        ],
      });

      // The workspace path now resolves outside the workspace: refused before any open.
      expect(results[0]).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
      expect(results[0].ms).toBeLessThan(2_000);
      // The artifact read goes straight to the no-follow reader: the link itself is refused.
      expect(results[1]).toMatchObject({ ok: true, payload: { error: 'Not a regular file' } });
      expect(results[1].ms).toBeLessThan(2_000);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it.skipIf(!fifoSupported)(
    'an artifact file swapped for a FIFO after the listing is skipped by the next listing and refused on read',
    async () => {
      const artifactDir = join(workspace, '.workflow', 'plan');
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'notes.md'), 'notes\n');
      writeFileSync(join(artifactDir, 'x.md'), 'x\n');

      const results = await runInChild({
        workspace,
        steps: [
          call('workflows.artifacts', { artifactName: 'plan' }),
          { type: 'fifo', path: join(artifactDir, 'x.md') },
          call('workflows.artifacts', { artifactName: 'plan' }),
          call('workflows.artifactFile', { artifactName: 'plan', path: 'x.md' }),
          call('workflows.artifactFile', { artifactName: 'plan', path: 'notes.md' }),
          // A listed file swapped for a symlink (out of the workspace) after the listing.
          { type: 'symlink', path: join(artifactDir, 'notes.md'), target: '/etc/hostname' },
          call('workflows.artifactFile', { artifactName: 'plan', path: 'notes.md' }),
        ],
      });

      expect(results[0]).toMatchObject({
        ok: true,
        payload: {
          files: [
            { path: 'notes.md', size: 6 },
            { path: 'x.md', size: 2 },
          ],
          truncated: false,
        },
      });
      expect(results[1]).toMatchObject({ ok: true, payload: { files: [{ path: 'notes.md', size: 6 }] } });
      expect(results[2]).toMatchObject({ ok: true, payload: { error: 'Not a regular file' } });
      expect(results[2].ms).toBeLessThan(2_000);
      expect(results[3]).toMatchObject({ ok: true, payload: { content: 'notes\n', language: 'markdown' } });
      expect(results[4]).toMatchObject({ ok: true, payload: { error: 'Not a regular file' } });
    },
    CHILD_TIMEOUT_MS + 5_000,
  );
});

// ---------------------------------------------------------------------------
// Containment, type checks and bounded listings (in-process)
// ---------------------------------------------------------------------------

describe('workspace file browser RPCs', () => {
  let workspace: string;
  let outside: string;
  let ctx: WorkflowDispatchContext;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-outside-'));
    ctx = makeContext(fakeManager(workspace));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const fileContent = (path: string) =>
    workflowDispatch(ctx, 'workflows.fileContent', { workflowId: 'wf', path }) as Promise<FileContentResponseDto>;
  const fileTree = (path?: string) =>
    workflowDispatch(ctx, 'workflows.fileTree', {
      workflowId: 'wf',
      ...(path === undefined ? {} : { path }),
    }) as Promise<FileTreeResponseDto>;
  const artifacts = (artifactName: string) =>
    workflowDispatch(ctx, 'workflows.artifacts', { workflowId: 'wf', artifactName }) as Promise<ArtifactContentDto>;
  const artifactFile = (artifactName: string, path: string) =>
    workflowDispatch(ctx, 'workflows.artifactFile', {
      workflowId: 'wf',
      artifactName,
      path,
    }) as Promise<FileContentResponseDto>;

  describe('workflows.fileContent', () => {
    it('reads a regular file with its language', async () => {
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'src', 'index.ts'), 'export {};\n');
      await expect(fileContent('src/index.ts')).resolves.toEqual({ content: 'export {};\n', language: 'typescript' });
    });

    it('reports a missing file and a directory as INVALID_PARAMS', async () => {
      mkdirSync(join(workspace, 'src'));
      const missing = await expectRpcError(fileContent('nope.md'), 'INVALID_PARAMS');
      expect(missing.message).toBe('File not found');
      const dir = await expectRpcError(fileContent('src'), 'INVALID_PARAMS');
      expect(dir.message).toBe('Path is a directory, not a file');
      const root = await expectRpcError(fileContent('.'), 'INVALID_PARAMS');
      expect(root.message).toBe('Path is a directory, not a file');
    });

    it('reports a file over 1 MiB as too large without returning its bytes', async () => {
      writeFileSync(join(workspace, 'big.txt'), Buffer.alloc(ONE_MIB + 1, 0x61));
      await expect(fileContent('big.txt')).resolves.toEqual({ error: 'File too large to display (>1MB)' });
    });

    it('detects binary content', async () => {
      writeFileSync(join(workspace, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
      await expect(fileContent('blob.bin')).resolves.toEqual({ binary: true });
    });

    it('refuses a symlink at the target, even one pointing inside the workspace', async () => {
      writeFileSync(join(workspace, 'real.md'), 'real\n');
      symlinkSync(join(workspace, 'real.md'), join(workspace, 'inside.md'));
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
      symlinkSync(join(outside, 'secret.txt'), join(workspace, 'leak.md'));
      // Inside: passes the containment check, then the no-follow open refuses the link.
      await expect(fileContent('inside.md')).resolves.toEqual({ error: 'Not a regular file' });
      // Outside: the containment check already refuses it.
      const leak = await expectRpcError(fileContent('leak.md'), 'INVALID_PARAMS');
      expect(leak.message).toBe('Path escapes workspace boundary');
    });

    it('refuses a file reached through a symlinked directory that leaves the workspace', async () => {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
      symlinkSync(outside, join(workspace, 'escape'));
      await expectRpcError(fileContent('escape/secret.txt'), 'INVALID_PARAMS');
    });
  });

  describe('workflows.fileTree', () => {
    it('lists directories first, then files with sizes, and reports truncated: false', async () => {
      mkdirSync(join(workspace, 'src'));
      writeFileSync(join(workspace, 'README.md'), '# hi\n');
      await expect(fileTree()).resolves.toEqual({
        entries: [
          { name: 'src', type: 'directory' },
          { name: 'README.md', type: 'file', size: 5 },
        ],
        truncated: false,
      });
    });

    it('returns an empty listing for a missing directory', async () => {
      await expect(fileTree('gone')).resolves.toEqual({ entries: [], truncated: false });
    });

    it('reports a regular file as INVALID_PARAMS', async () => {
      writeFileSync(join(workspace, 'README.md'), '# hi\n');
      const err = await expectRpcError(fileTree('README.md'), 'INVALID_PARAMS');
      expect(err.message).toBe('Path is not a directory');
    });

    it.skipIf(!fifoSupported)('never lists symlinks or FIFOs', async () => {
      writeFileSync(join(workspace, 'real.md'), 'real\n');
      symlinkSync(join(workspace, 'real.md'), join(workspace, 'link.md'));
      symlinkSync(workspace, join(workspace, 'loop'));
      makeFifo(join(workspace, 'pipe'));
      const res = await fileTree();
      expect(res.entries.map((e) => e.name)).toEqual(['real.md']);
    });

    it('truncates a 10,000-entry directory at MAX_DIRECTORY_ENTRIES', async () => {
      const big = join(workspace, 'big');
      mkdirSync(big);
      for (let i = 0; i < 10_000; i++) writeFileSync(join(big, `f${i}.txt`), '');
      const res = await fileTree('big');
      expect(res.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
      expect(res.truncated).toBe(true);
      for (const entry of res.entries) expect(entry).toMatchObject({ type: 'file', size: 0 });
    });

    it('stops reading a directory of unlisted entries (symlinks) at MAX_DIRECTORY_SCAN_ENTRIES', async () => {
      const links = join(workspace, 'links');
      mkdirSync(links);
      for (let i = 0; i <= MAX_DIRECTORY_SCAN_ENTRIES; i++) symlinkSync('nowhere', join(links, `l${i}`));
      writeFileSync(join(links, 'real.txt'), 'r');
      const res = await fileTree('links');
      expect(res.truncated).toBe(true);
      expect(res.entries.length).toBeLessThanOrEqual(1);
    });
  });

  describe('workflows.artifacts', () => {
    function seedArtifact(name: string, files: Record<string, string | Buffer>): string {
      const dir = join(workspace, '.workflow', name);
      mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      return dir;
    }

    it('lists names and sizes for 20 x 1 MiB files without reading any of them', async () => {
      const files: Record<string, Buffer> = {};
      for (let i = 0; i < 20; i++) files[`chunk-${String(i).padStart(2, '0')}.txt`] = Buffer.alloc(ONE_MIB, 0x61);
      seedArtifact('plan', files);

      const listing = await artifacts('plan');

      expect(listing.truncated).toBe(false);
      expect(listing.files).toHaveLength(20);
      expect(listing.files[0]).toEqual({ path: 'chunk-00.txt', size: ONE_MIB });
      expect(listing.files.every((f) => f.size === ONE_MIB)).toBe(true);
      // The reply is a listing, not 20 MiB (or, JSON-escaped, far more) of content.
      expect(JSON.stringify(listing).length).toBeLessThan(4_096);

      const one = await artifactFile('plan', 'chunk-07.txt');
      expect(one.content?.length).toBe(ONE_MIB);
      expect(one.language).toBe('text');
    });

    it('walks subdirectories with /-separated paths and sorts the listing', async () => {
      seedArtifact('review', { 'z.md': 'z', 'a/b/c.txt': 'c', 'a/d.txt': 'd' });
      const listing = await artifacts('review');
      expect(listing.files.map((f) => f.path)).toEqual(['a/b/c.txt', 'a/d.txt', 'z.md']);
    });

    it('skips symlinks (to files and to directories) and never descends into them', async () => {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
      const dir = seedArtifact('plan', { 'real.md': 'real' });
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.md'));
      symlinkSync(outside, join(dir, 'leakdir'));
      const listing = await artifacts('plan');
      expect(listing.files.map((f) => f.path)).toEqual(['real.md']);
      await expect(artifactFile('plan', 'leak.md')).resolves.toEqual({ error: 'Not a regular file' });
      await expectRpcError(artifactFile('plan', 'leakdir/secret.txt'), 'INVALID_PARAMS');
    });

    it('stops at MAX_ARTIFACT_FILES and reports truncated', async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i <= MAX_ARTIFACT_FILES; i++) files[`f${String(i).padStart(5, '0')}.txt`] = 'x';
      seedArtifact('many', files);
      const listing = await artifacts('many');
      expect(listing.files).toHaveLength(MAX_ARTIFACT_FILES);
      expect(listing.truncated).toBe(true);
    });

    it('does not descend below MAX_ARTIFACT_DEPTH and reports truncated', async () => {
      const deepDir = Array.from({ length: MAX_ARTIFACT_DEPTH + 1 }, (_, i) => `d${i + 1}`).join('/');
      const okDir = Array.from({ length: MAX_ARTIFACT_DEPTH }, (_, i) => `d${i + 1}`).join('/');
      seedArtifact('deep', { 'shallow.txt': 's', [`${okDir}/ok.txt`]: 'o', [`${deepDir}/deep.txt`]: 'd' });
      const listing = await artifacts('deep');
      expect(listing.files.map((f) => f.path)).toEqual([`${okDir}/ok.txt`, 'shallow.txt']);
      expect(listing.truncated).toBe(true);
    });

    it('budgets the serialized listing, so names JSON escapes six-fold cannot inflate it', async () => {
      // 1,500 names of 200 control characters: ~1.2 KB each once JSON-escaped,
      // ~1.8 MB in all, though only ~300 KB of raw name bytes.
      const files: Record<string, string> = {};
      for (let i = 0; i < 1_500; i++) files[`${'\u0001'.repeat(200)}${i}`] = '';
      seedArtifact('escaped', files);

      const listing = await artifacts('escaped');

      expect(listing.truncated).toBe(true);
      expect(listing.files.length).toBeGreaterThan(100);
      expect(listing.files.length).toBeLessThan(1_500);
      expect(Buffer.byteLength(JSON.stringify(listing.files))).toBeLessThanOrEqual(MAX_ARTIFACT_LISTING_BYTES);
    });

    it('stops reading at MAX_ARTIFACT_SCAN_ENTRIES when the artifact holds only unlisted entries', async () => {
      const dir = seedArtifact('links', {});
      for (let i = 0; i <= MAX_ARTIFACT_SCAN_ENTRIES; i++) symlinkSync('nowhere', join(dir, `l${i}`));
      const listing = await artifacts('links');
      expect(listing.truncated).toBe(true);
      expect(listing.files).toEqual([]);
    });

    it('refuses an artifact directory, or a .workflow, that resolves outside the workspace', async () => {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
      mkdirSync(join(workspace, '.workflow'));
      symlinkSync(outside, join(workspace, '.workflow', 'plan'));
      const viaArtifactLink = await expectRpcError(artifacts('plan'), 'INVALID_PARAMS');
      expect(viaArtifactLink.message).toBe('Artifact path escapes workflow directory');
      await expectRpcError(artifactFile('plan', 'secret.txt'), 'INVALID_PARAMS');

      // `.workflow` itself pointing out of the workspace: `plan` then sits
      // inside `.workflow` but outside the workspace.
      rmSync(join(workspace, '.workflow'), { recursive: true });
      mkdirSync(join(outside, 'plan'));
      writeFileSync(join(outside, 'plan', 'leak.md'), 'leak\n');
      symlinkSync(outside, join(workspace, '.workflow'));
      await expectRpcError(artifacts('plan'), 'INVALID_PARAMS');
      await expectRpcError(artifactFile('plan', 'leak.md'), 'INVALID_PARAMS');
    });

    it('lists an artifact only below the real .workflow directory, as the orchestrator requires', async () => {
      // A `.workflow` symlinked to another workspace directory stays inside the
      // workspace, but the orchestrator treats a symlinked `.workflow` root as
      // unsafe (resolveArtifactOutputDir), so the listing refuses it too.
      mkdirSync(join(workspace, 'elsewhere', 'plan'), { recursive: true });
      writeFileSync(join(workspace, 'elsewhere', 'plan', 'notes.md'), 'n\n');
      symlinkSync('elsewhere', join(workspace, '.workflow'));
      const err = await expectRpcError(artifacts('plan'), 'INVALID_PARAMS');
      expect(err.message).toBe('Artifact path escapes workflow directory');
    });

    it('reports ARTIFACT_NOT_FOUND for a missing artifact and INVALID_PARAMS for a bad name', async () => {
      await expectRpcError(artifacts('missing'), 'ARTIFACT_NOT_FOUND');
      await expectRpcError(artifactFile('missing', 'a.md'), 'ARTIFACT_NOT_FOUND');
      await expectRpcError(artifacts('../etc'), 'INVALID_PARAMS');
      await expectRpcError(artifacts('..'), 'INVALID_PARAMS');
    });
  });

  describe('workflows.artifactFile', () => {
    beforeEach(() => {
      const dir = join(workspace, '.workflow', 'plan', 'sub');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'nested.md'), '# nested\n');
      writeFileSync(join(workspace, '.workflow', 'plan', 'big.txt'), Buffer.alloc(ONE_MIB + 1, 0x61));
      writeFileSync(join(workspace, '.workflow', 'plan', 'blob.bin'), Buffer.from([0, 1, 2]));
      writeFileSync(join(workspace, 'top.md'), 'top\n');
    });

    it('reads a nested file and reports too-large and binary files like fileContent', async () => {
      await expect(artifactFile('plan', 'sub/nested.md')).resolves.toEqual({
        content: '# nested\n',
        language: 'markdown',
      });
      await expect(artifactFile('plan', 'big.txt')).resolves.toEqual({ error: 'File too large to display (>1MB)' });
      await expect(artifactFile('plan', 'blob.bin')).resolves.toEqual({ binary: true });
    });

    it('rejects traversal, absolute and empty path components', async () => {
      for (const bad of ['../../top.md', '/etc/passwd', 'sub//nested.md', './sub/nested.md', 'sub/../big.txt']) {
        const err = await expectRpcError(artifactFile('plan', bad), 'INVALID_PARAMS');
        expect(err.message).toBe('Invalid artifact file path');
      }
    });

    it('reports a missing file as INVALID_PARAMS', async () => {
      const err = await expectRpcError(artifactFile('plan', 'sub/missing.md'), 'INVALID_PARAMS');
      expect(err.message).toBe('File not found');
    });
  });
});

// ---------------------------------------------------------------------------
// Listings are not redirected by a symlink an agent retargets in a loop
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'linux')('listings under a racing symlink swap (Linux)', () => {
  const ITERATIONS = 1_500;
  let base: string;
  let workspace: string;
  let outside: string;
  let ctx: WorkflowDispatchContext;
  let racer: SymlinkRacer | undefined;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-race-')));
    workspace = join(base, 'ws');
    outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'HOST-ONLY-NAME.txt'), 'x'.repeat(1234));
    ctx = makeContext(fakeManager(workspace));
  });

  afterEach(() => {
    racer?.stop();
    racer = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * Runs `list` repeatedly while the racer flips the link; returns how many
   * listings succeeded. Each one must hold only the inside directory's names:
   * the path check and the open race, so a listing that trusted its path
   * would show the outside directory a few percent of the time.
   */
  async function raceListings(list: () => Promise<readonly string[]>): Promise<number> {
    let listed = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      let names: readonly string[];
      try {
        names = await list();
      } catch (err) {
        // Refused because the link pointed outside at that moment.
        expect(err).toBeInstanceOf(RpcError);
        continue;
      }
      listed++;
      expect(names).not.toContain('HOST-ONLY-NAME.txt');
    }
    return listed;
  }

  it('workflows.fileTree never lists the directory a racing symlink points outside', async () => {
    mkdirSync(join(workspace, 'real'), { recursive: true });
    writeFileSync(join(workspace, 'real', 'inside.md'), 'inside\n');
    symlinkSync('real', join(workspace, 'flip'));
    racer = await startSymlinkRacer(join(workspace, 'flip'), 'real', outside);

    const listed = await raceListings(async () => {
      const res = (await workflowDispatch(ctx, 'workflows.fileTree', {
        workflowId: 'wf',
        path: 'flip',
      })) as FileTreeResponseDto;
      return res.entries.map((e) => e.name);
    });
    expect(listed).toBeGreaterThan(0);
  }, 60_000);

  it('workflows.artifacts never walks a directory a racing artifact symlink points outside', async () => {
    mkdirSync(join(workspace, '.workflow', 'plan-real'), { recursive: true });
    writeFileSync(join(workspace, '.workflow', 'plan-real', 'inside.md'), 'inside\n');
    symlinkSync('plan-real', join(workspace, '.workflow', 'plan'));
    racer = await startSymlinkRacer(join(workspace, '.workflow', 'plan'), 'plan-real', outside);

    const listed = await raceListings(async () => {
      const res = (await workflowDispatch(ctx, 'workflows.artifacts', {
        workflowId: 'wf',
        artifactName: 'plan',
      })) as ArtifactContentDto;
      return res.files.map((f) => f.path);
    });
    expect(listed).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// End to end over the WebSocket server: the reply stays small, the socket open
// ---------------------------------------------------------------------------

describe('artifact review over the WebSocket server', () => {
  let workspace: string;
  let server: WebUiServer | null = null;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-ws-e2e-'));
  });

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    sockets.length = 0;
    if (server) {
      await server.stop();
      server = null;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  function makeHandler(): ControlRequestHandler {
    return {
      getStatus: vi.fn().mockReturnValue({
        uptimeSeconds: 1,
        jobs: { total: 0, enabled: 0, running: 0 },
        signalConnected: false,
        nextFireTime: undefined,
      }),
      removeJob: vi.fn(),
      enableJob: vi.fn(),
      disableJob: vi.fn(),
      recompileJob: vi.fn(),
      refreshLists: vi.fn(),
      reloadJob: vi.fn(),
      startJobRun: vi.fn(),
      runJobNow: vi.fn(),
      listJobs: vi.fn().mockReturnValue([]),
    };
  }

  async function connect(): Promise<WebSocket> {
    const options: WebUiServerOptions = {
      port: 0,
      host: '127.0.0.1',
      handler: makeHandler(),
      sessionManager: new SessionManager(),
      mode: { kind: 'builtin' },
      maxConcurrentWebSessions: 1,
      workflowManager: fakeManager(workspace),
    };
    server = new WebUiServer(options);
    const url = new URL(await server.start());
    const ws = new WebSocket(`ws://127.0.0.1:${url.port}/ws?token=${url.searchParams.get('token') ?? ''}`);
    sockets.push(ws);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.on('open', resolveOpen);
      ws.on('error', rejectOpen);
    });
    return ws;
  }

  function rpc(ws: WebSocket, id: string, method: string, params: Record<string, unknown>): Promise<string> {
    return new Promise((resolveReply) => {
      const onMessage = (data: Buffer): void => {
        const raw = data.toString();
        if ((JSON.parse(raw) as { id?: string }).id === id) {
          ws.off('message', onMessage);
          resolveReply(raw);
        }
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  it('an artifact of 20 x 1 MiB files is listed and read file by file without closing the socket', async () => {
    const dir = join(workspace, '.workflow', 'plan');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++)
      writeFileSync(join(dir, `part-${String(i).padStart(2, '0')}.md`), Buffer.alloc(ONE_MIB, 0x23));
    const ws = await connect();

    const listingRaw = await rpc(ws, 'list', 'workflows.artifacts', { workflowId: 'wf', artifactName: 'plan' });
    expect(listingRaw.length).toBeLessThan(4_096);
    const listing = JSON.parse(listingRaw) as { ok: boolean; payload: ArtifactContentDto };
    expect(listing.ok).toBe(true);
    expect(listing.payload.files).toHaveLength(20);
    expect(listing.payload.files[3]).toEqual({ path: 'part-03.md', size: ONE_MIB });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const fileRaw = await rpc(ws, 'file', 'workflows.artifactFile', {
      workflowId: 'wf',
      artifactName: 'plan',
      path: 'part-03.md',
    });
    const file = JSON.parse(fileRaw) as { ok: boolean; payload: FileContentResponseDto };
    expect(file.ok).toBe(true);
    expect(file.payload.content?.length).toBe(ONE_MIB);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// WEB-4: message-log pages are bounded in bytes; long messages load on demand
// ---------------------------------------------------------------------------

describe('workflows.messageLog byte budget and workflows.messageLogEntry', () => {
  const workflowId = 'wf-chatty';
  const MESSAGE_CHARS = 20 * 1024;
  const MESSAGES = 200;
  let baseDir: string;
  let ctx: WorkflowDispatchContext;
  let originals: MessageLogEntry[];

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'ironcurtain-wfd-msglog-'));
    const runDir = join(baseDir, workflowId);
    mkdirSync(runDir, { recursive: true });
    originals = [];
    for (let i = 0; i < MESSAGES; i++) {
      originals.push({
        type: 'agent_received',
        ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        workflowId,
        state: 'implement',
        role: 'coder',
        message: `message ${i} `.padEnd(MESSAGE_CHARS, 'x'),
        verdict: null,
        confidence: null,
      });
    }
    originals.push({
      type: 'state_transition',
      ts: new Date(1_700_000_000_000 + MESSAGES * 1000).toISOString(),
      workflowId,
      state: 'review',
      from: 'implement',
      event: 'review',
    });
    writeFileSync(join(runDir, 'messages.jsonl'), originals.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const loadPastRun = (): PastRunLoadResult => ({
      checkpoint: undefined,
      definition: { name: 'chatty', description: '', initial: 'implement', states: {} },
      messageLogPath: join(runDir, 'messages.jsonl'),
      isLive: false,
      runningElsewhere: false,
    });
    ctx = makeContext(fakeManager('/nonexistent-workspace', { baseDir, loadPastRun }));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const page = (params: Record<string, unknown> = {}) =>
    workflowDispatch(ctx, 'workflows.messageLog', { workflowId, ...params }) as Promise<MessageLogResponseDto>;
  const entry = (ref: string) =>
    workflowDispatch(ctx, 'workflows.messageLogEntry', { workflowId, ref }) as Promise<MessageLogEntryResponseDto>;

  it('cuts long messages with a ref and fills the page by their cut size, within the byte budget', async () => {
    const res = await page();

    // 201 entries do not fit the 1 MiB budget even cut to 8 KiB each, but far
    // more of them fit than whole 20 KiB lines would (about 50).
    expect(res.entries.length).toBeGreaterThan(100);
    expect(res.entries.length).toBeLessThan(MESSAGES + 1);
    expect(res.hasMore).toBe(true);
    // Newest first: the short state_transition, then the newest messages.
    expect(res.entries[0]).toEqual(originals[MESSAGES]);
    expect('truncated' in res.entries[0]).toBe(false);
    for (const e of res.entries.slice(1)) {
      expect(e.type).toBe('agent_received');
      if (e.type !== 'agent_received') continue;
      expect(e.message).toHaveLength(MAX_INLINE_MESSAGE_CHARS);
      expect(e.truncated).toBe(true);
      expect(e.ref).toMatch(/^\d+:\d+$/);
    }
    expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThanOrEqual(MAX_MESSAGE_LOG_PAGE_BYTES + 64);
  });

  it('pages on through the cursor until the log is exhausted', async () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = await page(before === undefined ? {} : { before });
      seen.push(...res.entries.map((e) => e.ts));
      if (!res.hasMore) break;
      before = res.entries[res.entries.length - 1].ts;
    }
    expect(seen).toEqual(originals.map((e) => e.ts).reverse());
  });

  it('messageLogEntry returns the complete entry behind a ref', async () => {
    const res = await page();
    const cut = res.entries[1];
    expect(cut.ref).toBeDefined();
    const full = await entry(cut.ref ?? '');
    expect(full.entry).toEqual(originals[MESSAGES - 1]);
  });

  it('rejects forged, stale and malformed refs without reading anything else', async () => {
    await expectRpcError(entry('1:5'), 'INVALID_PARAMS');
    await expectRpcError(entry('0:7'), 'INVALID_PARAMS');
    await expectRpcError(entry('abc'), 'INVALID_PARAMS');
    await expectRpcError(entry('0:999999999'), 'FILE_TOO_LARGE');
  });

  it('reports WORKFLOW_NOT_FOUND for an unknown workflow', async () => {
    const missing = makeContext(fakeManager('/nonexistent-workspace', { baseDir }));
    await expectRpcError(
      workflowDispatch(missing, 'workflows.messageLogEntry', { workflowId, ref: '0:1' }),
      'WORKFLOW_NOT_FOUND',
    );
  });
});
