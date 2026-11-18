import { describe, expect, it, vi } from 'vitest';
import { createPtyResizeQueue } from '../src/docker/pty-resize-queue.js';
import type { ContainerRuntime, DockerExecResult } from '../src/docker/types.js';

/**
 * Fake runtime modelling the container PTY: resize-pty.sh sets the size once
 * the agent is "running", check-pty-size.sh reports it. Each exec takes
 * `execMs`, and the fake records how many execs overlap.
 */
function fakePtyRuntime(options: { execMs?: number; agentStartsAfterResizes?: number } = {}) {
  const execMs = options.execMs ?? 5;
  let size = { cols: 0, rows: 0 };
  let resizesSeen = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const resizes: string[] = [];
  const checks: string[] = [];
  const exec = vi.fn(async (_id: string, command: readonly string[]): Promise<DockerExecResult> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, execMs));
    inFlight -= 1;
    if (command[0] === '/etc/ironcurtain/resize-pty.sh') {
      resizes.push(`${command[1]}x${command[2]}`);
      resizesSeen += 1;
      if (resizesSeen > (options.agentStartsAfterResizes ?? 0)) {
        size = { cols: Number(command[1]), rows: Number(command[2]) };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    checks.push(`${size.cols}x${size.rows}`);
    return { exitCode: 0, stdout: `${size.rows} ${size.cols}\n`, stderr: '' };
  });
  return {
    runtime: { exec } as unknown as Pick<ContainerRuntime, 'exec'>,
    resizes,
    checks,
    get size() {
      return size;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const FAST = { debounceMs: 5, verifyDelayMs: 5, verifyIntervalMs: 5 } as const;

describe('PTY resize queue', () => {
  it('coalesces 50 resize events into at most two execs that end at the final size', async () => {
    const fake = fakePtyRuntime();
    const queue = createPtyResizeQueue({ runtime: fake.runtime, containerId: 'c1', ...FAST });

    for (let index = 0; index < 50; index += 1) queue.request(80 + index, 24 + index);
    await queue.whenIdle();

    expect(fake.resizes.length).toBeLessThanOrEqual(2);
    expect(fake.resizes.at(-1)).toBe('129x73');
    expect(fake.size).toEqual({ cols: 129, rows: 73 });
    // The settled size is verified once.
    expect(fake.checks).toEqual(['129x73']);
    queue.close();
  });

  it('keeps one exec in flight and applies the latest size requested meanwhile', async () => {
    const fake = fakePtyRuntime({ execMs: 20 });
    const queue = createPtyResizeQueue({ runtime: fake.runtime, containerId: 'c1', ...FAST });

    queue.request(100, 30);
    // Let the first exec start, then drag the window while it runs.
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let index = 0; index < 50; index += 1) queue.request(101 + index, 31);
    await queue.whenIdle();

    expect(fake.maxInFlight).toBe(1);
    expect(fake.resizes).toEqual(['100x30', '150x31']);
    expect(fake.size).toEqual({ cols: 150, rows: 31 });
    queue.close();
  });

  it('re-applies the size until the agent reports it, without ever restoring a stale size', async () => {
    // The agent is not running for the first two resizes (resize-pty.sh is a no-op).
    const fake = fakePtyRuntime({ agentStartsAfterResizes: 2 });
    const queue = createPtyResizeQueue({ runtime: fake.runtime, containerId: 'c1', ...FAST });

    queue.request(120, 40);
    await queue.whenIdle();
    expect(fake.size).toEqual({ cols: 120, rows: 40 });
    expect(fake.resizes).toEqual(['120x40', '120x40', '120x40']);

    queue.request(90, 20);
    await queue.whenIdle();
    expect(fake.size).toEqual({ cols: 90, rows: 20 });
    expect(fake.resizes.at(-1)).toBe('90x20');
    queue.close();
  });

  it('abandons verification of a size the user has since replaced', async () => {
    // Verification would retry the initial size forever if it ignored newer requests.
    const fake = fakePtyRuntime({ agentStartsAfterResizes: 1_000 });
    const queue = createPtyResizeQueue({
      runtime: fake.runtime,
      containerId: 'c1',
      debounceMs: 1,
      verifyDelayMs: 1,
      verifyIntervalMs: 30,
      verifyAttempts: 50,
    });

    queue.request(80, 24);
    await new Promise((resolve) => setTimeout(resolve, 40));
    queue.request(132, 43);
    await new Promise((resolve) => setTimeout(resolve, 60));
    queue.close();
    await queue.whenIdle();

    const firstNewSize = fake.resizes.indexOf('132x43');
    expect(firstNewSize).toBeGreaterThan(0);
    expect(fake.resizes.slice(firstNewSize)).not.toContain('80x24');
  });

  it('stops issuing execs once closed', async () => {
    const fake = fakePtyRuntime();
    const queue = createPtyResizeQueue({ runtime: fake.runtime, containerId: 'c1', ...FAST });
    queue.request(80, 24);
    queue.close();
    await queue.whenIdle();
    queue.request(100, 30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.resizes).toEqual([]);
  });

  it('ignores sizes that are not positive integers', async () => {
    const fake = fakePtyRuntime();
    const queue = createPtyResizeQueue({ runtime: fake.runtime, containerId: 'c1', ...FAST });
    queue.request(0, 24);
    queue.request(80, Number.NaN);
    await queue.whenIdle();
    expect(fake.resizes).toEqual([]);
    queue.close();
  });
});
