/**
 * Entry point for `ironcurtain bot` - runs the Signal transport daemon.
 *
 * Unlike `ironcurtain start "task"` which runs a single task and exits,
 * `ironcurtain bot` starts the SignalBotDaemon and waits for messages
 * indefinitely. Sessions are created on demand when the user sends a
 * Signal message and destroyed when they end.
 *
 * `bot` is only ever the Signal transport, never the cron scheduler: that is
 * `ironcurtain daemon`, which also owns the job subcommands. Its arguments
 * are parsed strictly, so `-a X`, `--agent X` and `--agent=X` all select the
 * agent, and a subcommand is refused with a pointer to `ironcurtain daemon`
 * (it was once routed to a full daemon, scheduler included, as was
 * `bot --agent X`).
 *
 * One process runs the Signal transport per IronCurtain home (see
 * signal-lock.ts): a bot started beside another bot, or beside a daemon that
 * runs Signal, exits 1 naming that process, before it touches the container.
 */

import { parseArgs } from 'node:util';
import { printHelp, type CommandSpec } from '../cli-help.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import { getDaemonLogPath } from '../config/paths.js';
import { createDockerManager } from '../docker/docker-manager.js';
import { isPreflightError, resolveSessionMode, type PreflightResult } from '../session/preflight.js';
import { SignalBotDaemon } from './signal-bot-daemon.js';
import { createSignalContainerManager } from './signal-container.js';
import { resolveSignalConfig } from './signal-config.js';
import { acquireSignalLock, isSignalLockBusyError, type SignalLock } from './signal-lock.js';
import * as logger from '../logger.js';
import { processLogRotation } from '../maintenance/log-rotation.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { ensureSandboxViable } from '../utils/preflight-checks.js';
import type { AgentId } from '../docker/agent-adapter.js';

export const botSpec: CommandSpec = {
  name: 'ironcurtain bot',
  description: 'Run the Signal transport alone, without the cron scheduler',
  usage: ['ironcurtain bot [options]'],
  options: [
    {
      flag: 'agent',
      short: 'a',
      description: 'Agent mode: builtin, claude-code, goose, or codex',
      placeholder: '<name>',
    },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain bot                       # Signal sessions in the configured mode',
    'ironcurtain bot --agent claude-code   # Signal sessions with Claude Code in Docker',
    'ironcurtain daemon                    # Signal and scheduled jobs together',
    'ironcurtain daemon list-jobs          # Job commands are under daemon',
  ],
};

export interface BotOptions {
  /** Explicit agent selection (e.g., 'claude-code'). */
  agent?: string;
}

/** What `ironcurtain bot <args>` asks for; see {@link parseBotArgs}. */
export type BotArgs = { readonly kind: 'help' } | { readonly kind: 'run'; readonly options: BotOptions };

/**
 * Parses the arguments of `ironcurtain bot` strictly: `-a`/`--agent` (as
 * `--agent X` or `--agent=X`) and `-h`/`--help`. Throws on an unknown option,
 * an empty agent name, or any positional argument: bot takes no subcommand
 * (the job commands are `ironcurtain daemon`'s), and it never starts the cron
 * scheduler.
 */
export function parseBotArgs(args: readonly string[]): BotArgs {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      agent: { type: 'string', short: 'a' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help === true) return { kind: 'help' };
  if (positionals.length > 0) {
    const word = toDisplayText(positionals[0]);
    throw new Error(
      `ironcurtain bot takes no subcommand ('${word}'): it runs only the Signal transport. ` +
        `Scheduled jobs and their commands are under ironcurtain daemon (ironcurtain daemon --help).`,
    );
  }
  if (values.agent !== undefined && values.agent.trim() === '') {
    throw new Error('--agent requires an agent name (builtin, claude-code, goose, or codex).');
  }
  return { kind: 'run', options: { agent: values.agent } };
}

/**
 * `ironcurtain bot <args>`: help, an argument error (exit 1), or the Signal
 * bot. `run` is a test seam.
 */
export async function runBotCommand(
  args: readonly string[],
  run: (options: BotOptions) => Promise<void> = runBot,
): Promise<void> {
  let parsed: BotArgs;
  try {
    parsed = parseBotArgs(args);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`Run \`${botSpec.name} --help\` for usage.\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.kind === 'help') {
    printHelp(botSpec);
    return;
  }
  await run(parsed.options);
}

export async function runBot(options: BotOptions = {}): Promise<void> {
  const userConfig = loadUserConfig();
  const signalConfig = resolveSignalConfig(userConfig);

  if (!signalConfig) {
    process.stderr.write('Signal is not configured. Run: ironcurtain setup-signal\n');
    process.exit(1);
  }

  // One Signal transport per IronCurtain home (see signal-lock.ts): when
  // another bot, or a daemon with Signal, runs it, stop here, before this
  // bot writes to signal-bot.log or touches the signal-cli container.
  const signalLock = acquireSignalLockOrExit();

  // The V8 sandbox preflight (src/cli.ts leaves it to this command): after
  // the Signal check, before any session can start.
  await ensureSandboxViable();

  // Claim the bot's own log before creating sessions. It is process-wide:
  // the bot's lines stay in signal-bot.log while each session logs to its
  // own file under a claim of its own. It rotates by size (retention.logs).
  const logClaim = logger.setup({
    logFilePath: getDaemonLogPath('signal-bot'),
    processWide: true,
    rotation: processLogRotation(userConfig.retention),
  });

  const config = loadConfig();

  // Resolve session mode (same logic as `ironcurtain start`). A failed
  // preflight (no container runtime, no credentials) is reported as its
  // message, after giving back the log and the Signal lock.
  let preflight: PreflightResult;
  try {
    preflight = await resolveSessionMode({
      config,
      requestedAgent: options.agent ? (options.agent as AgentId) : undefined,
    });
  } catch (err) {
    if (!isPreflightError(err)) throw err;
    logger.release(logClaim);
    signalLock.release();
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  const mode = preflight.mode;
  // Signal sessions do not show their start-up notices: say it once here.
  for (const warning of preflight.warnings ?? []) process.stderr.write(`Warning: ${warning}\n`);

  const docker = createDockerManager();
  const containerManager = createSignalContainerManager(docker, signalConfig.container);

  const daemon = new SignalBotDaemon({
    config: signalConfig,
    containerManager,
    mode,
  });

  // Wire up signal handling for graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) process.exit(1); // Second signal: force exit
    shuttingDown = true;
    await daemon.shutdown();
    logger.release(logClaim);
    signalLock.release();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  process.stderr.write(`IronCurtain bot starting (mode: ${mode.kind})...\n`);
  process.stderr.write('Press Ctrl+C to stop.\n');

  try {
    await daemon.start();
  } finally {
    // The transport has shut down, or never connected.
    signalLock.release();
  }
}

/**
 * Takes the Signal lock (see signal-lock.ts), or exits 1 naming the process
 * that runs the Signal transport for this home.
 */
function acquireSignalLockOrExit(): SignalLock {
  try {
    return acquireSignalLock();
  } catch (err) {
    if (!isSignalLockBusyError(err)) throw err;
    process.stderr.write(
      `Error: ${err.message}\nStop that process first; a daemon runs beside a bot only with --no-signal.\n`,
    );
    process.exit(1);
  }
}
