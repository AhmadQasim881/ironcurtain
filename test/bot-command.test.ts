/**
 * `ironcurtain bot` is the Signal transport alone, never the cron daemon: its
 * arguments are parsed strictly, every spelling of the agent option selects
 * the agent, and a subcommand is refused with a pointer to
 * `ironcurtain daemon` (both once routed to a full daemon, scheduler
 * included).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBotArgs, runBotCommand, type BotOptions } from '../src/signal/bot-command.js';

describe('parseBotArgs', () => {
  it('reads -a X, --agent X and --agent=X alike', () => {
    for (const args of [['-a', 'goose'], ['--agent', 'goose'], ['--agent=goose']]) {
      expect(parseBotArgs(args), args.join(' ')).toEqual({ kind: 'run', options: { agent: 'goose' } });
    }
    expect(parseBotArgs([])).toEqual({ kind: 'run', options: { agent: undefined } });
  });

  it('answers -h/--help', () => {
    expect(parseBotArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseBotArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseBotArgs(['list-jobs', '--help'])).toEqual({ kind: 'help' });
  });

  it('refuses a subcommand, pointing at ironcurtain daemon', () => {
    expect(() => parseBotArgs(['list-jobs'])).toThrow(/takes no subcommand \('list-jobs'\).*ironcurtain daemon/);
    expect(() => parseBotArgs(['--agent', 'goose', 'run-job', 'nightly'])).toThrow(/takes no subcommand/);
  });

  it('refuses unknown options, a missing agent and an empty one', () => {
    expect(() => parseBotArgs(['--no-signal'])).toThrow(/Unknown option '--no-signal'/);
    expect(() => parseBotArgs(['--agent'])).toThrow(/argument missing/);
    expect(() => parseBotArgs(['--agent='])).toThrow(/--agent requires an agent name/);
  });
});

describe('runBotCommand', () => {
  let stderr: string[];
  let errors: string[];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stderr = [];
    errors = [];
    savedExitCode = process.exitCode;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  it('runs the Signal bot with the agent, whichever spelling selected it', async () => {
    for (const args of [['-a', 'goose'], ['--agent', 'goose'], ['--agent=goose']]) {
      const run = vi.fn<(options: BotOptions) => Promise<void>>(async () => {});
      await runBotCommand(args, run);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({ agent: 'goose' });
    }
  });

  it('runs nothing for --help or an argument error, which exits 1 with a usage hint', async () => {
    const run = vi.fn<(options: BotOptions) => Promise<void>>(async () => {});
    await runBotCommand(['--help'], run);
    expect(process.exitCode).toBe(savedExitCode);
    expect(errors.join('\n')).toContain('ironcurtain bot - Run the Signal transport alone, without the cron scheduler');

    await runBotCommand(['list-jobs'], run);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Run `ironcurtain bot --help` for usage.');
    expect(run).not.toHaveBeenCalled();
  });
});
