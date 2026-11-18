/**
 * The daemon-backed workflow commands deliver their whole output to a pipe
 * before the process exits, and a reader that stops early ends them quietly
 * (WP-52, WFC-13).
 *
 * Agents read these commands through pipes. The CLI used to call
 * process.exit() as soon as the command returned; on a pipe whose reader had
 * not caught up, Node drops everything still queued, so `workflow show --json`
 * of a large artifact arrived cut off (at 64 KiB for a reader that starts late)
 * as unparseable JSON with exit code 0. This runs the real entry point
 * (src/cli.ts under tsx) against a fake daemon serving a >1 MiB artifact (two
 * files, fetched one at a time with workflows.artifactFile after the
 * workflows.artifacts listing) and reads stdout only after the CLI has
 * finished talking to the daemon and had time to exit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { startFakeDaemon, type FakeDaemon, type FakeDaemonHandler } from '../helpers/fake-daemon-ws.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ENTRY = resolve(projectRoot, 'src', 'cli.ts');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const ESC = '\u001b';

let daemon: FakeDaemon | undefined;
let home: string | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Serves `files` as one artifact the way the daemon does: `workflows.artifacts`
 * lists paths and sizes, and `workflows.artifactFile` returns one file's text.
 */
function serveArtifact(files: ReadonlyArray<{ readonly path: string; readonly content: string }>): FakeDaemonHandler {
  return (request) => {
    if (request.method === 'workflows.artifacts') {
      return {
        payload: {
          files: files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content, 'utf8') })),
          truncated: false,
        },
      };
    }
    const file = files.find((candidate) => candidate.path === request.params.path);
    if (request.method === 'workflows.artifactFile' && file) {
      return { payload: { content: file.content, language: 'markdown' } };
    }
    return { error: { code: 'METHOD_NOT_FOUND', message: request.method } };
  };
}

describe('daemon gate commands: output on a pipe', () => {
  it('workflow show --json delivers a >1 MiB artifact intact to a reader that starts late', async () => {
    const files = [
      { path: 'spec.md', content: `${'s'.repeat(700_000)}${ESC}[2J\u009b31m end of spec` },
      { path: 'notes/review.md', content: `${'n'.repeat(700_000)} end of notes \u00e9\u{1f600}` },
    ];
    daemon = await startFakeDaemon(serveArtifact(files));
    home = mkdtempSync(join(tmpdir(), 'ic-gate-pipe-home-'));

    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, 'workflow', 'show', 'wf-pipe', '--artifact', 'spec', '--json'],
      {
        cwd: projectRoot,
        env: { PATH: process.env.PATH ?? '', HOME: home, IRONCURTAIN_HOME: daemon.home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // A slow reader: subscribed (so Node keeps what arrives) but paused, so
    // the pipe fills up and the CLI's writes queue behind it.
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stdout.pause();
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (code) => resolveExit(code));
    });

    // Reading starts only after the CLI has closed its daemon connection (its
    // whole result is written or queued by then) and has had time to exit. A
    // CLI that dies before connecting ends the wait too (and fails below).
    await Promise.race([daemon.firstConnectionClosed, exited]);
    await delay(1_500);
    child.stdout.resume();

    const code = await exited;
    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    expect(code, stderr.slice(0, 2_000)).toBe(0);
    expect(daemon.requests.map((request) => request.method)).toEqual([
      'workflows.artifacts',
      'workflows.artifactFile',
      'workflows.artifactFile',
    ]);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(1024 * 1024);
    expect(stdout.endsWith('\n')).toBe(true);
    const json = JSON.parse(stdout) as {
      ok: boolean;
      truncated: boolean;
      files: Array<{ path: string; content: string }>;
    };
    expect(json.ok).toBe(true);
    expect(json.truncated).toBe(false);
    // Compared field by field: a failing toEqual would print megabytes.
    expect(json.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(json.files.every((file, index) => file.content === files[index].content)).toBe(true);
    // The JSON carries the control characters as escapes, never raw.
    expect(stdout.includes(ESC)).toBe(false);
    expect(stdout.includes('\u009b')).toBe(false);
    // In --json mode the artifact content is not repeated on stderr.
    expect(stderr.length).toBeLessThan(2_000);
    expect(stderr.includes(ESC)).toBe(false);
  }, 90_000);

  it('a reader that stops early ends the command with its own exit code, not an EPIPE stack trace', async () => {
    // Like `ironcurtain workflow show ... --json | head -c 100`: the reader
    // takes the first chunk and closes the pipe while most of the output is
    // still queued. The failed write used to surface as an unhandled 'error'
    // event (a stack trace on stderr) and exit code 1.
    // Two files of up to the daemon's 1 MiB per-file cap.
    const files = [
      { path: 'spec.md', content: 's'.repeat(1_000_000) },
      { path: 'notes.md', content: 'n'.repeat(1_000_000) },
    ];
    daemon = await startFakeDaemon(serveArtifact(files));
    home = mkdtempSync(join(tmpdir(), 'ic-gate-pipe-home-'));

    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, 'workflow', 'show', 'wf-pipe', '--artifact', 'spec', '--json'],
      {
        cwd: projectRoot,
        env: { PATH: process.env.PATH ?? '', HOME: home, IRONCURTAIN_HOME: daemon.home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    let received = 0;
    child.stdout.once('data', (chunk: Buffer) => {
      received = chunk.length;
      child.stdout.destroy();
    });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (exitCode) => resolveExit(exitCode));
    });
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    // The reader really did stop early, with most of the output unsent.
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(1_000_000);
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(code, stderr.slice(0, 2_000)).toBe(0);
  }, 90_000);
});
