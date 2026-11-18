import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import type { HostPtyProcess, HostPtySpawn, HostTerminalStreams } from '../../src/docker/pty-host-terminal.js';

function fixture() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const child: HostPtyProcess = {
    onData: (listener) => {
      onData = listener;
      return {
        dispose: () => {
          onData = undefined;
        },
      };
    },
    onExit: (listener) => {
      onExit = listener;
      return {
        dispose: () => {
          onExit = undefined;
        },
      };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const input = Object.assign(new EventEmitter(), { isTTY: false, resume: vi.fn(), pause: vi.fn() });
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    write: (text: string) => {
      writes.push(text);
      return true;
    },
  });
  const spawn = vi.fn<HostPtySpawn>(() => child);
  return {
    child,
    input,
    writes,
    spawn,
    terminal: { input, output } as unknown as HostTerminalStreams,
    data: (text: string) => onData?.(text),
    exit: (exitCode: number) => onExit?.({ exitCode }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('Docker native interactive exec', () => {
  it('pins endpoint and numeric user, preserves argv, and filters output', async () => {
    const f = fixture();
    vi.stubEnv('DOCKER_CONTEXT', 'unrelated');
    vi.stubEnv('DOCKER_HOST', 'tcp://unrelated:2375');
    const runtime = createDockerManager(undefined, undefined, {
      endpoint: { host: 'unix:///tmp/owned-docker.sock' },
      defaultExecUser: '1101',
      spawnPty: f.spawn,
      terminal: f.terminal,
    });
    const exited = runtime.execPty!('agent', ['sh', '-c', 'printf "$1"', 'literal', 'value;*']);
    expect(f.spawn.mock.calls[0]?.[1]).toEqual([
      '--host',
      'unix:///tmp/owned-docker.sock',
      'exec',
      '--interactive',
      '--tty',
      '--user',
      '1101',
      'agent',
      'sh',
      '-c',
      'printf "$1"',
      'literal',
      'value;*',
    ]);
    const environment = f.spawn.mock.calls[0]?.[2].env;
    expect(environment.DOCKER_HOST).toBe('unix:///tmp/owned-docker.sock');
    expect(environment.DOCKER_CONTEXT).toBeUndefined();
    f.data('ordinary\x1b]0;untrusted title\x07 text');
    f.input.emit('data', Buffer.from('ls\r'));
    f.exit(7);
    await expect(exited).resolves.toBe(7);
    expect(f.writes.join('')).toContain('ordinary text');
    expect(f.writes.join('')).not.toContain('untrusted title');
    expect(f.child.write).toHaveBeenCalledWith(Buffer.from('ls\r'));
  });
  it.each(['abort', 'detach'] as const)(
    'allows teardown after bounded %s even if the CLI never exits',
    async (trigger) => {
      vi.useFakeTimers();
      const f = fixture(),
        controller = new AbortController();
      const runtime = createDockerManager(undefined, undefined, { spawnPty: f.spawn, terminal: f.terminal });
      const exited = runtime.execPty!('agent', ['true'], controller.signal);
      if (trigger === 'abort') controller.abort();
      else f.input.emit('data', Buffer.from([0x1c]));
      expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(exited).resolves.toBe(0);
      expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
    },
  );
});
