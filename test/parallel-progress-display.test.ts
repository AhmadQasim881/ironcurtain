import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParallelProgressDisplay } from '../src/pipeline/parallel-progress.js';
import { toDisplayText } from '../src/terminal/display-sanitize.js';
import { SpinnerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import ora from 'ora';

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start() {
      return this;
    },
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    text: '',
  })),
}));

const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
afterEach(() => {
  vi.restoreAllMocks();
  if (tty) Object.defineProperty(process.stderr, 'isTTY', tty);
  else Reflect.deleteProperty(process.stderr, 'isTTY');
});

describe.each([false, true])('parallel progress (TTY=%s)', (isTTY) => {
  it('quotes model and judge diagnostics in live status and the final report', () => {
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: isTTY });
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      output.push(String(text));
      return true;
    });
    const marker = 'Example\u0007 diagnostic\u202e label';
    const display = new ParallelProgressDisplay(['example', 'second']);
    try {
      display.updateServer('example', 'compiling', marker);
      display.bufferWarning('example', marker);
      display.captureError('example', new Error(marker));
      display.setDone('second', marker);
    } finally {
      display.finish();
    }
    expect(output.join('')).toContain(toDisplayText(marker));
    expect(output.join('')).not.toContain(marker);
  });
});

it('quotes the same model-derived fields in sequential compilation progress', () => {
  const output: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((text) => {
    output.push(String(text));
  });
  const marker = 'Example\u0007 diagnostic\u202e label';
  const display = new SpinnerProgressReporter('example');
  display.update('compiling', marker);
  const spinner = vi.mocked(ora).mock.results.at(-1)?.value;
  display.warn(marker);
  display.complete('compiling', marker, 1);
  display.done(marker);
  expect(vi.mocked(ora).mock.calls.at(-1)?.[0]).toMatchObject({ text: expect.stringContaining(toDisplayText(marker)) });
  expect(spinner.succeed).toHaveBeenCalledWith(toDisplayText(marker));
  expect(output.join('')).toContain(toDisplayText(marker));
  expect(output.join('')).not.toContain(marker);
});
