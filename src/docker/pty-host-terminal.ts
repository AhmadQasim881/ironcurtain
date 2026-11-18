/**
 * Host-terminal side of an interactive container PTY, shared by the socat
 * relay (`attachPty`) and Apple Container's runtime-native exec.
 *
 * Agent output is untrusted and goes to the user's real terminal, so every
 * chunk passes through {@link TerminalOutputFilter} first. When the relay ends
 * (or the process exits while it runs) the terminal modes the forwarded output
 * changed are restored, and terminal replies that arrive just after the
 * session ends are read and discarded instead of reaching the user's shell.
 */

import { TerminalOutputFilter } from '../terminal/terminal-output-filter.js';
import { clampPtySize } from '../pty/pty-size.js';

/** How long late terminal replies are read and discarded after a session ends (ms). */
export const PENDING_INPUT_DRAIN_MS = 50;

/** The writable side of a terminal: `process.stdout` in production. */
export type HostTerminalWriter = Pick<NodeJS.WriteStream, 'write'> & { readonly isTTY?: boolean };

export interface HostTerminalOutput {
  /**
   * Filter one chunk of untrusted output and write what remains. Returns the
   * writer's backpressure result (`false`: wait for `'drain'`).
   */
  write(chunk: Uint8Array | string): boolean;
  /** Restore the terminal modes the forwarded output changed. Idempotent. */
  restore(): void;
}

/** Create the filtered output side of one interactive session. */
export function createHostTerminalOutput(writer: HostTerminalWriter = process.stdout): HostTerminalOutput {
  const filter = new TerminalOutputFilter();
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.off('exit', restore);
    const tail = filter.end();
    if (!filter.hasForwardedOutput) return;
    // Only a terminal interprets the reset; never append it to a pipe or file.
    const text = writer.isTTY === true ? tail + filter.restoreSequence() : tail;
    if (text) writer.write(text);
  };
  // A forced exit (second Ctrl-C, fatal error) skips the relay's own cleanup;
  // a TTY write in an 'exit' listener is still synchronous.
  process.on('exit', restore);

  return {
    write(chunk: Uint8Array | string): boolean {
      const text = filter.write(chunk);
      return text.length === 0 ? true : writer.write(text);
    },
    restore,
  };
}

/** The readable side of a terminal: `process.stdin` in production. */
export type HostTerminalReader = Pick<NodeJS.ReadStream, 'on' | 'off' | 'resume' | 'pause'> & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
};

/**
 * Read and discard input for a short window while the terminal is still in raw
 * mode. Replies to queries the agent sent just before it exited (cursor
 * position, device attributes) would otherwise wait in the TTY buffer and be
 * read by the user's shell. Best effort: a reply delayed beyond the window
 * (a slow remote link) is not caught, which is why the output filter already
 * drops every report request whose reply could carry agent-chosen text.
 */
export async function drainPendingTerminalInput(
  reader: HostTerminalReader = process.stdin,
  windowMs = PENDING_INPUT_DRAIN_MS,
): Promise<void> {
  if (reader.isTTY !== true || reader.isRaw !== true) return;
  const discard = (): void => {};
  reader.on('data', discard);
  reader.resume();
  try {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  } finally {
    reader.off('data', discard);
    reader.pause();
  }
}

/** The subset of node-pty's `IPty` the relay uses. */
export interface HostPtyProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

/** node-pty's `spawn`, narrowed to what the relay's callers pass. */
export type HostPtySpawn = (
  file: string,
  args: string[],
  options: {
    readonly name: string;
    readonly cols: number;
    readonly rows: number;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => HostPtyProcess;

/** The user's terminal: `process.stdin` / `process.stdout` in production. */
export interface HostTerminalStreams {
  readonly input: HostTerminalReader & { setRawMode?(mode: boolean): unknown };
  readonly output: HostTerminalWriter &
    Pick<NodeJS.WriteStream, 'once' | 'off'> & {
      readonly columns?: number;
      readonly rows?: number;
      on(event: 'resize' | 'drain', listener: () => void): unknown;
    };
}

/** Ctrl-\ detaches from the session, as in the socat relay (raw mode disables SIGQUIT). */
const CTRL_BACKSLASH = 0x1c;

/**
 * Relay a host-side PTY child (Apple's `container exec --interactive --tty`
 * running under node-pty) to the user's terminal: the child's output is
 * filtered, input is forwarded in raw mode (a lone Ctrl-\ detaches), host
 * resizes resize the child's PTY (the runtime propagates them to the guest),
 * an abort sends SIGTERM, and the terminal modes are restored at the end.
 *
 * Resolves with the child's exit code, or 0 when the caller aborted or the
 * user detached.
 */
export async function relayHostPty(
  child: HostPtyProcess,
  options: { readonly signal?: AbortSignal; readonly terminal?: HostTerminalStreams } = {},
): Promise<number> {
  const { input, output } = options.terminal ?? { input: process.stdin, output: process.stdout };
  const { signal } = options;
  const terminal = createHostTerminalOutput(output);
  const enteredRawMode = input.isTTY === true && input.isRaw !== true;
  let detached = false;

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        // A stuck runtime CLI must not prevent the caller's container teardown.
        stopTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* Teardown still must proceed. */
          }
          unsubscribe();
          resolvePromise(0);
        }, 1000);
        try {
          child.kill('SIGTERM');
        } catch {
          /* The CLI may already have exited. */
        }
      };
      const onDrain = (): void => {
        child.resume();
      };
      const dataSubscription = child.onData((data) => {
        if (!terminal.write(data)) {
          child.pause();
          output.once('drain', onDrain);
        }
      });
      const onInput = (data: Buffer): void => {
        if (data.length === 1 && data[0] === CTRL_BACKSLASH) {
          detach();
          return;
        }
        child.write(data);
      };
      const onResize = (): void => {
        const { columns, rows } = output;
        if (!columns || !rows) return;
        const size = clampPtySize(columns, rows);
        child.resize(size.cols, size.rows);
      };
      const onAbort = (): void => {
        detach();
      };
      const unsubscribe = (): void => {
        if (stopTimer !== undefined) clearTimeout(stopTimer);
        dataSubscription.dispose();
        exitSubscription.dispose();
        input.off('data', onInput);
        output.off('resize', onResize);
        output.off('drain', onDrain);
        signal?.removeEventListener('abort', onAbort);
      };
      // node-pty reports exit asynchronously, after this subscription exists.
      const exitSubscription = child.onExit(({ exitCode: code }) => {
        unsubscribe();
        resolvePromise(detached ? 0 : code);
      });

      try {
        if (enteredRawMode) input.setRawMode?.(true);
        input.on('data', onInput);
        input.resume();
        output.on('resize', onResize);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      } catch (error) {
        unsubscribe();
        child.kill('SIGTERM');
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    terminal.restore();
    // Still in raw mode here: discard terminal replies that arrive late.
    await drainPendingTerminalInput(input);
    input.pause();
    if (enteredRawMode) input.setRawMode?.(false);
  }
  return exitCode;
}
