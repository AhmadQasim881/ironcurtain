/**
 * A real terminal-kit Terminal that writes into memory, plus a headless xterm
 * that replays the bytes so tests can read the screen the user would see.
 *
 * Used to prove that agent-derived text reaches the terminal only as inert,
 * visible characters: the byte stream is checked for control characters
 * that terminal-kit itself never emits, and the xterm screen is checked for
 * the literal escaped spellings (`\u001b[2J`) and intact layout rows.
 */

import { PassThrough } from 'node:stream';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export interface CapturedScreen {
  /** Visible rows (trailing whitespace trimmed), top to bottom. */
  readonly rows: string[];
  /** How many rows scrolled off the top: non-zero means the layout was shifted. */
  readonly scrolledRows: number;
}

export interface CapturedTerminalKit {
  /** The terminal-kit Terminal, untyped like the renderer's `term` parameter. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly term: any;
  /** Every byte written since this capture started, as UTF-8 text. */
  output(): Promise<string>;
  /** Forget the bytes written so far. */
  reset(): void;
  /** The screen after replaying everything written so far into a headless xterm. */
  screen(): Promise<CapturedScreen>;
}

interface SharedTerminal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly term: any;
  readonly stdout: PassThrough & { columns: number; rows: number };
  written: string;
}

/**
 * terminal-kit adds process exit listeners for every Terminal it creates and
 * never removes them, so one Terminal is shared per test process. Each
 * capture resets its buffer: use one capture at a time.
 */
let shared: Promise<SharedTerminal> | undefined;

async function sharedTerminal(): Promise<SharedTerminal> {
  const terminalKit = await import('terminal-kit');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createTerminal = terminalKit.default.createTerminal as (options: Record<string, unknown>) => any;
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
  const term: unknown = createTerminal({
    stdin,
    stdout,
    generic: 'xterm-256color',
    appId: 'xterm-256color',
    isTTY: true,
  });
  const state: SharedTerminal = { term, stdout, written: '' };
  stdout.on('data', (chunk: Buffer) => {
    state.written += chunk.toString('utf8');
  });
  return state;
}

export async function captureTerminalKit(cols: number, rows: number): Promise<CapturedTerminalKit> {
  shared ??= sharedTerminal();
  const state = await shared;
  // Let bytes from an earlier capture drain before this one starts.
  await new Promise((resolve) => setImmediate(resolve));
  state.stdout.columns = cols;
  state.stdout.rows = rows;
  state.written = '';

  const output = async (): Promise<string> => {
    await new Promise((resolve) => setImmediate(resolve));
    return state.written;
  };

  return {
    term: state.term,
    output,
    reset() {
      state.written = '';
    },
    async screen() {
      const data = await output();
      const xterm = new Terminal({ cols, rows, allowProposedApi: true });
      await new Promise<void>((resolve) => {
        xterm.write(data, resolve);
      });
      const buffer = xterm.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < rows; y++) {
        lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
      }
      return { rows: lines, scrolledRows: buffer.baseY };
    },
  };
}

/** Removes the CSI sequences terminal-kit itself emits (cursor moves, erase, SGR). */
export function withoutTerminalKitSequences(output: string): string {
  // eslint-disable-next-line no-control-regex
  return output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '');
}

/** Control characters a terminal acts on; none may come from untrusted text. */
// eslint-disable-next-line no-control-regex
export const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
