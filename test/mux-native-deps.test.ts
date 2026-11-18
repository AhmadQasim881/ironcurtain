/**
 * `ironcurtain mux` without node-pty (BLD-10): node-pty has no Linux prebuild,
 * so it is missing wherever npm could not compile it. `--help` must still
 * work, and the error must name a fix that works for a global install
 * (`npm install node-pty` in the current directory does not).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxApp } from '../src/mux/mux-app.js';

// The optional dependency is installed but its native addon did not build.
vi.mock('node-pty', () => {
  throw new Error('Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64');
});

import { main as muxMain } from '../src/mux/mux-command.js';
import { nodePtyRemediation } from '../src/pty/node-pty-loader.js';

function capture(stream: NodeJS.WriteStream): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('ironcurtain mux without node-pty', () => {
  let stderr: ReturnType<typeof capture>;
  let consoleError: string[];

  beforeEach(() => {
    stderr = capture(process.stderr);
    consoleError = [];
    // printHelp writes with console.error.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleError.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    stderr.restore();
    vi.restoreAllMocks();
  });

  it('prints --help without loading node-pty', async () => {
    const resolveSessionMode = vi.fn();
    const createMuxApp = vi.fn((): MuxApp => ({ start: vi.fn(), shutdown: vi.fn() }));

    await muxMain(['--help'], { resolveSessionMode, createMuxApp });

    expect(consoleError.join('\n')).toContain('ironcurtain mux');
    expect(stderr.text()).not.toContain('node-pty');
    expect(resolveSessionMode).not.toHaveBeenCalled();
    expect(createMuxApp).not.toHaveBeenCalled();
  });

  it('refuses to start with a remediation that works for a global install', async () => {
    const resolveSessionMode = vi.fn();

    await expect(muxMain([], { resolveSessionMode })).rejects.toThrow('process.exit:1');

    const text = stderr.text();
    expect(text).toContain('ironcurtain mux needs the optional node-pty package, which could not be loaded');
    // The fix for what npm left on disk: a rebuild when the package is there
    // (only its import is mocked to fail), a reinstall when it is gone.
    expect(text).toContain(nodePtyRemediation());
    expect(text).toMatch(/npm rebuild -g node-pty --allow-scripts=node-pty|npm install -g @provos\/ironcurtain/);
    expect(text).not.toContain('npm install node-pty');
    // The probe runs before the config and the session mode.
    expect(resolveSessionMode).not.toHaveBeenCalled();
  });

  it('rejects unknown flags before probing node-pty', async () => {
    await expect(muxMain(['--bogus'])).rejects.toThrow('process.exit:1');
    expect(stderr.text()).toContain('ironcurtain mux --help');
    expect(stderr.text()).not.toContain('node-pty');
  });
});
