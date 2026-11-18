/**
 * Top-level routing of `ironcurtain` (src/cli-routing.ts): global options
 * count only before the command, each command gets exactly its own
 * arguments, and only invocations that can run an agent session in the CLI
 * process need the V8 sandbox preflight (help and the read-only or
 * daemon-backed subcommands never do).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requestsHelp, routeCommandLine, sandboxPreflightRequired, topLevelCommandNames } from '../src/cli-routing.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('routeCommandLine', () => {
  it('shows the top-level help without a command, for `help`, and for a global --help', () => {
    for (const argv of [[], ['help'], ['help', 'start'], ['--help'], ['-h'], ['--'], ['-h', 'start', 'task']]) {
      expect(routeCommandLine(argv), JSON.stringify(argv)).toEqual({ kind: 'help' });
    }
  });

  it('never runs a command named after a global --help (it once ran `start` with the task "start")', () => {
    expect(routeCommandLine(['--help', 'start'])).toEqual({ kind: 'help' });
    expect(routeCommandLine(['-h', 'daemon'])).toEqual({ kind: 'help' });
  });

  it('prints the version for a global -v/--version, which wins over --help', () => {
    expect(routeCommandLine(['--version'])).toEqual({ kind: 'version' });
    expect(routeCommandLine(['-v', 'persona'])).toEqual({ kind: 'version' });
    expect(routeCommandLine(['--help', '--version'])).toEqual({ kind: 'version' });
  });

  it('hands a command exactly the arguments after its name, global-looking flags included', () => {
    expect(routeCommandLine(['start', '--help'])).toEqual({ kind: 'command', name: 'start', args: ['--help'] });
    expect(routeCommandLine(['start', '-v'])).toEqual({ kind: 'command', name: 'start', args: ['-v'] });
    expect(routeCommandLine(['bot', '--agent', 'goose'])).toEqual({
      kind: 'command',
      name: 'bot',
      args: ['--agent', 'goose'],
    });
    expect(routeCommandLine(['daemon'])).toEqual({ kind: 'command', name: 'daemon', args: [] });
    expect(routeCommandLine(['--', 'start', 'x'])).toEqual({ kind: 'command', name: 'start', args: ['x'] });
    expect(routeCommandLine(['nonsense', 'a'])).toEqual({ kind: 'command', name: 'nonsense', args: ['a'] });
  });

  it('refuses any other option before the command', () => {
    const route = routeCommandLine(['--agent', 'claude-code', 'mux']);
    expect(route.kind).toBe('error');
    expect(route.kind === 'error' ? route.message : '').toContain("Unknown option '--agent'");
  });
});

describe('requestsHelp', () => {
  it('finds -h or --help among the arguments, up to a --', () => {
    expect(requestsHelp(['--help'])).toBe(true);
    expect(requestsHelp(['-h'])).toBe(true);
    expect(requestsHelp(['list-jobs', '--help'])).toBe(true);
    expect(requestsHelp([])).toBe(false);
    expect(requestsHelp(['--', '--help'])).toBe(false);
    expect(requestsHelp(['--model=--help'])).toBe(false);
    expect(requestsHelp(['fix the --help text'])).toBe(false);
  });
});

describe('sandboxPreflightRequired', () => {
  it('is required for start, except for its help', () => {
    expect(sandboxPreflightRequired('start', [])).toBe(true);
    expect(sandboxPreflightRequired('start', ['summarize this'])).toBe(true);
    // After `--`, "--help" is task text: the session runs.
    expect(sandboxPreflightRequired('start', ['--', '--help'])).toBe(true);
    expect(sandboxPreflightRequired('start', ['--help'])).toBe(false);
    expect(sandboxPreflightRequired('start', ['-h'])).toBe(false);
  });

  it('is required only for the workflow subcommands that run sessions here', () => {
    for (const sub of ['start', 'resume-standalone', 'run-state']) {
      expect(sandboxPreflightRequired('workflow', [sub, 'x', 'y']), sub).toBe(true);
      expect(sandboxPreflightRequired('workflow', [sub, '--help']), `${sub} --help`).toBe(false);
    }
    const withoutSessions = ['list', 'inspect', 'lint', 'watch', 'run', 'resume', 'status', 'await', 'gate'];
    for (const sub of [...withoutSessions, 'escalation', 'show']) {
      expect(sandboxPreflightRequired('workflow', [sub, 'x']), sub).toBe(false);
    }
    expect(sandboxPreflightRequired('workflow', [])).toBe(false);
    expect(sandboxPreflightRequired('workflow', ['--help'])).toBe(false);
    // An unknown subcommand is checked (and then refused by the command).
    expect(sandboxPreflightRequired('workflow', ['frobnicate'])).toBe(true);
  });

  it('leaves daemon and bot to check it themselves, and is never required elsewhere', () => {
    expect(sandboxPreflightRequired('daemon', [])).toBe(false);
    expect(sandboxPreflightRequired('daemon', ['list-jobs'])).toBe(false);
    expect(sandboxPreflightRequired('bot', ['--agent', 'goose'])).toBe(false);
    for (const command of topLevelCommandNames()) {
      if (command === 'start' || command === 'workflow') continue;
      expect(sandboxPreflightRequired(command, []), command).toBe(false);
    }
  });
});

describe('topLevelCommandNames', () => {
  it('lists exactly the commands src/cli.ts dispatches, so every one of them is in the help and its tests', () => {
    const cliSource = readFileSync(resolve(projectRoot, 'src', 'cli.ts'), 'utf-8');
    const dispatched = [...cliSource.matchAll(/^ {2}case '([a-z-]+)':/gm)].map((match) => match[1]);
    expect(dispatched.length).toBeGreaterThan(10);
    expect(new Set(topLevelCommandNames())).toEqual(new Set([...dispatched, 'help']));
  });
});
