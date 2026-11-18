/**
 * Acceptance test for the filesystem server's confinement to its MCP roots
 * (docs/designs/filesystem-server-confinement.md), under real bubblewrap.
 *
 * `@modelcontextprotocol/server-filesystem` validates a path and then
 * reopens it by name, so a process that renames workspace entries
 * concurrently (a Docker-mode agent) can swap a directory for a symlink in
 * between and make an unconfined server read, write or create anything the
 * host user can. Here the relay (`mcp-proxy-server.ts`) runs the shipped
 * `filesystem` entry, which srt confines to its roots, while a separate
 * process keeps swapping `<workspace>/a` between a real directory and a
 * symlink to `$HOME`. Thousands of read_text_file, list_directory,
 * write_file and create_directory calls through `<workspace>/a` must never
 * return the home's content or listing, or create anything in it. A policy root (`~/Downloads`)
 * and a root added after an approved escalation (the relay restarts the
 * server for it) keep working; other home directories stay hidden.
 *
 * Linux only, gated like test/sandbox-integration.test.ts: skipped when
 * sandbox-runtime reports missing dependencies or cannot run a command at
 * all on this host (some containers forbid the user namespaces bubblewrap
 * needs). The macOS profile is covered at the config level by
 * test/roots-confinement.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import { rootUriForPath } from '../src/trusted-process/policy-roots.js';
import {
  addRootsToClient,
  listBackendAllowedDirectories,
  verifyBackendRoots,
} from '../src/trusted-process/roots-expansion.js';
import {
  checkSandboxAvailability,
  runOsSandboxSmokeTest,
  type OsSandboxSmokeResult,
} from '../src/trusted-process/sandbox-integration.js';
import { CONFINED_ROOTS_VERIFY_TIMEOUT_MS } from '../src/trusted-process/tool-call-pipeline.js';
import { packagedFilesystemServerConfig } from './helpers/filesystem-server.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');

/** Calls per tool while the swapper runs (override with FS_TOCTOU_CALLS). */
const CALLS_PER_TOOL = Number(process.env.FS_TOCTOU_CALLS ?? '1000');
/** Calls in flight at once. */
const CONCURRENCY = 8;

const HOME_SECRET = 'HOME-SECRET-7f3a';
/** A file name that exists only in the home, so a directory listing of it is recognizable. */
const HOME_ONLY_ENTRY = 'HOME-ONLY-ENTRY-91c2';
const IC_SECRET = 'IRONCURTAIN-CONFIG-SECRET';
const WORKSPACE_DATA = 'WORKSPACE-DATA';

const { platformSupported, errors: dependencyErrors } = checkSandboxAvailability();
const sandboxAvailable = platformSupported && dependencyErrors.length === 0;

/**
 * Keeps swapping `<dir>/a` between the real directory and the symlink
 * `<dir>/a.link` (to `$HOME`) with atomic renames, until SIGTERM; then
 * leaves the real directory at `a` and prints how many swaps it made.
 *
 * Node has no renameat2(RENAME_EXCHANGE), so `a` is briefly missing between
 * renames, and a create_directory call (mkdir -p) can recreate it as an
 * empty directory; such an intruder is moved aside to `a.intruder-<n>`.
 */
const SWAPPER_SCRIPT = `
const { renameSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.env.SWAP_DIR;
const a = join(dir, 'a'), real = join(dir, 'a.real'), link = join(dir, 'a.link');
let stop = false, swaps = 0, intruders = 0;
process.on('SIGTERM', () => { stop = true; });
function moveInto(from) {
  for (;;) {
    try { renameSync(from, a); return; } catch (err) {
      if (!['EISDIR', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(err.code)) throw err;
      renameSync(a, join(dir, 'a.intruder-' + intruders++));
    }
  }
}
function batch() {
  for (let i = 0; i < 50; i++) {
    renameSync(a, real);
    moveInto(link);
    renameSync(a, link);
    moveInto(real);
    swaps++;
  }
  if (stop) { process.stdout.write(String(swaps) + '\\n'); process.exit(0); }
  setImmediate(batch);
}
process.stdout.write('ready\\n');
batch();
`;

interface ToolResult {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

function textOf(result: unknown): string {
  const content = (result as ToolResult).content ?? [];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

async function inBatches<T>(count: number, task: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < count; start += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, count - start) }, (_, i) => task(start + i));
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

describe.skipIf(process.platform !== 'linux' || !sandboxAvailable)(
  'filesystem server confinement under bubblewrap (symlink-swap TOCTOU)',
  { timeout: 300_000 },
  () => {
    let smoke: OsSandboxSmokeResult = { ok: false, elapsedMs: 0, detail: 'not run' };
    let scratch: string;
    let home: string;
    let icHome: string;
    let workspace: string;
    let downloads: string;
    let approved: string;
    let otherProject: string;
    let manager: MCPClientManager | undefined;

    function requireSrt(ctx: { skip: () => void }): void {
      if (!smoke.ok) {
        console.warn(`Skipping: srt cannot run sandboxed commands here: ${smoke.detail}`);
        ctx.skip();
      }
    }

    /** The coordinator-side client of the relay under test. */
    function relay(): MCPClientManager {
      if (!manager) throw new Error('relay not started');
      return manager;
    }

    beforeAll(async () => {
      smoke = await runOsSandboxSmokeTest();
      if (!smoke.ok) return;

      scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-fs-toctou-')));
      home = join(scratch, 'home');
      icHome = join(home, '.ironcurtain');
      workspace = join(icHome, 'sessions', 'toctou', 'sandbox');
      downloads = join(home, 'Downloads');
      approved = join(home, 'projects', 'approved');
      otherProject = join(home, 'projects', 'other');
      for (const dir of [join(workspace, 'a'), downloads, approved, otherProject]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, 'data.txt'), HOME_SECRET);
      writeFileSync(join(home, `${HOME_ONLY_ENTRY}.txt`), 'listed only in the home');
      writeFileSync(join(icHome, 'config.json'), IC_SECRET);
      writeFileSync(join(workspace, 'a', 'data.txt'), WORKSPACE_DATA);
      writeFileSync(join(downloads, 'dl.txt'), 'DOWNLOADED');
      writeFileSync(join(approved, 'ok.txt'), 'APPROVED-CONTENT');
      writeFileSync(join(otherProject, 'private.txt'), 'OTHER-PROJECT-SECRET');
      symlinkSync(home, join(workspace, 'a.link'));

      // The policy names ~/Downloads, so it is a root from the start.
      const policyDir = join(scratch, 'policy');
      mkdirSync(policyDir);
      const compiledPolicy: CompiledPolicyFile = {
        generatedAt: 'test-fixture',
        constitutionHash: 'test-fixture',
        inputHash: 'test-fixture',
        rules: [
          {
            name: 'allow-read-downloads',
            description: 'test',
            principle: 'test',
            if: { server: ['filesystem'], roles: ['read-path'], paths: { roles: ['read-path'], within: downloads } },
            then: 'allow',
            reason: 'test',
          },
        ],
      };
      const toolAnnotations: ToolAnnotationsFile = { generatedAt: 'test-fixture', servers: {} };
      writeFileSync(join(policyDir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
      writeFileSync(join(policyDir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));

      manager = new MCPClientManager();
      await relay().connect(
        'filesystem',
        {
          command: tsxBin,
          args: [proxyServerPath],
          env: {
            MCP_SERVERS_CONFIG: JSON.stringify({ filesystem: packagedFilesystemServerConfig(workspace) }),
            GENERATED_DIR: policyDir,
            ALLOWED_DIRECTORY: workspace,
            IRONCURTAIN_HOME: icHome,
            HOME: home,
            SERVER_FILTER: 'filesystem',
            SANDBOX_POLICY: 'enforce',
            SESSION_LOG_PATH: join(scratch, 'session.log'),
          },
          sandbox: false,
        },
        [
          { uri: rootUriForPath(workspace), name: 'sandbox' },
          { uri: rootUriForPath(downloads), name: 'allow-read-downloads' },
        ],
      );

      // The server installs its roots asynchronously after the handshake.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const state = relay().getClientState('filesystem');
        if (!state) throw new Error('relay not connected');
        const listed = await listBackendAllowedDirectories(state.client);
        if (listed.includes(downloads) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    afterAll(async () => {
      try {
        await manager?.closeAll();
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    });

    async function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      return (await relay().callTool('filesystem', tool, args)) as ToolResult;
    }

    interface Swapper {
      readonly child: ChildProcess;
      readonly exited: Promise<number | null>;
      output: string;
    }

    /** Starts the swapper on the workspace and resolves once it runs. */
    async function startSwapper(): Promise<Swapper> {
      const child = spawn(process.execPath, ['-e', SWAPPER_SCRIPT], {
        env: { ...process.env, SWAP_DIR: workspace },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const swapper: Swapper = {
        child,
        exited: new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code))),
        output: '',
      };
      await new Promise<void>((resolveReady, rejectReady) => {
        child.once('error', rejectReady);
        child.stdout.on('data', (chunk: Buffer) => {
          swapper.output += chunk.toString();
          if (swapper.output.includes('ready\n')) resolveReady();
        });
      });
      return swapper;
    }

    /** Stops the swapper and returns how many swaps it made; the real directory is back in place. */
    async function stopSwapper(swapper: Swapper): Promise<number> {
      swapper.child.kill('SIGTERM');
      expect(await swapper.exited).toBe(0);
      expect(lstatSync(join(workspace, 'a')).isDirectory()).toBe(true);
      expect(readFileSync(join(workspace, 'a', 'data.txt'), 'utf-8')).toBe(WORKSPACE_DATA);
      expect(lstatSync(join(workspace, 'a.link')).isSymbolicLink()).toBe(true);
      return Number(swapper.output.trim().split('\n').pop());
    }

    /** Entries the race tried to create, if any reached the host home. */
    function escapedIntoHome(): string[] {
      return readdirSync(home).filter((name) => /^(w|d)-\d+/.test(name));
    }

    it('serves the workspace and the ~/Downloads policy root, and nothing else in the home', async (ctx) => {
      requireSrt(ctx);

      expect(textOf(await call('read_text_file', { path: join(workspace, 'a', 'data.txt') }))).toBe(WORKSPACE_DATA);
      expect(textOf(await call('read_text_file', { path: join(downloads, 'dl.txt') }))).toBe('DOWNLOADED');
      const write = await call('write_file', { path: join(downloads, 'saved.txt'), content: 'SAVED' });
      expect(write.isError).toBeFalsy();
      expect(readFileSync(join(downloads, 'saved.txt'), 'utf-8')).toBe('SAVED');

      for (const outside of [join(home, 'data.txt'), join(icHome, 'config.json'), join(otherProject, 'private.txt')]) {
        const result = await call('read_text_file', { path: outside });
        expect(result.isError).toBe(true);
        expect(textOf(result)).not.toMatch(/SECRET/);
      }
    });

    it('never reads or creates anything outside the confined view while a concurrent process swaps a workspace directory for a symlink to $HOME', async (ctx) => {
      requireSrt(ctx);

      const swapper = await startSwapper();
      let reads: ToolResult[];
      let listings: ToolResult[];
      let writes: ToolResult[];
      let mkdirs: ToolResult[];
      try {
        reads = await inBatches(CALLS_PER_TOOL, () =>
          call('read_text_file', { path: join(workspace, 'a', 'data.txt') }),
        );
        listings = await inBatches(CALLS_PER_TOOL, () => call('list_directory', { path: join(workspace, 'a') }));
        writes = await inBatches(CALLS_PER_TOOL, (i) =>
          call('write_file', { path: join(workspace, 'a', `w-${i}.txt`), content: `written ${i}` }),
        );
        mkdirs = await inBatches(CALLS_PER_TOOL, (i) =>
          call('create_directory', { path: join(workspace, 'a', `d-${i}`) }),
        );
      } finally {
        const swaps = await stopSwapper(swapper);
        expect(swaps).toBeGreaterThan(100);
      }

      // The race was live: the server saw the real directory (reads that
      // succeeded) and the swapped or missing one (reads that failed).
      const readTexts = reads.map(textOf);
      expect(readTexts.filter((text) => text === WORKSPACE_DATA).length).toBeGreaterThan(0);
      expect(reads.filter((result) => result.isError === true).length).toBeGreaterThan(0);

      // Nothing from outside the roots was returned or created.
      expect(readTexts.filter((text) => text.includes(HOME_SECRET))).toEqual([]);
      expect(listings.map(textOf).filter((text) => text.includes(HOME_ONLY_ENTRY))).toEqual([]);
      expect([...writes, ...mkdirs].map(textOf).filter((text) => text.includes(HOME_SECRET))).toEqual([]);
      expect(escapedIntoHome()).toEqual([]);
      expect(readFileSync(join(home, 'data.txt'), 'utf-8')).toBe(HOME_SECRET);
    });

    it('restarts the server for an approved root, which then works while the rest of the home stays hidden', async (ctx) => {
      requireSrt(ctx);

      const state = relay().getClientState('filesystem');
      if (!state) throw new Error('relay not connected');
      expect(await addRootsToClient(state, [approved])).toBe('added');
      const verification = await verifyBackendRoots(state.client, state.roots, [approved], {
        timeoutMs: CONFINED_ROOTS_VERIFY_TIMEOUT_MS,
      });
      expect(verification).toEqual({ status: 'verified' });

      expect(textOf(await call('read_text_file', { path: join(approved, 'ok.txt') }))).toBe('APPROVED-CONTENT');
      expect(textOf(await call('read_text_file', { path: join(downloads, 'dl.txt') }))).toBe('DOWNLOADED');
      expect(textOf(await call('read_text_file', { path: join(workspace, 'a', 'data.txt') }))).toBe(WORKSPACE_DATA);
      const other = await call('read_text_file', { path: join(otherProject, 'private.txt') });
      expect(other.isError).toBe(true);
      expect(textOf(other)).not.toContain('OTHER-PROJECT-SECRET');

      // The restarted server is confined too.
      const swapper = await startSwapper();
      let reads: ToolResult[];
      try {
        reads = await inBatches(Math.max(100, CALLS_PER_TOOL / 4), () =>
          call('read_text_file', { path: join(workspace, 'a', 'data.txt') }),
        );
      } finally {
        await stopSwapper(swapper);
      }
      expect(reads.map(textOf).filter((text) => text.includes(HOME_SECRET))).toEqual([]);
      expect(existsSync(join(home, 'w-0.txt'))).toBe(false);
    });
  },
);
