/**
 * Top-level command routing for `ironcurtain` (src/cli.ts): the command
 * table behind `ironcurtain --help`, where the command and its own arguments
 * start, and which invocations must pass the V8 sandbox preflight before they
 * are dispatched.
 *
 * Free of side effects, unlike src/cli.ts (which dispatches when imported),
 * so tests can check every command's routing and run each one's `--help`.
 */

import type { CommandSpec } from './cli-help.js';

export const topLevelSpec: CommandSpec = {
  name: 'ironcurtain',
  description: 'Secure agent runtime with policy-driven tool mediation',
  usage: ['ironcurtain [--env-file <path>] <command> [options]'],
  subcommands: [
    { name: 'start [task]', description: 'Run a one-shot or non-mux agent session' },
    { name: 'daemon', description: 'Unified Signal + cron daemon' },
    { name: 'mux', description: 'Recommended interactive Docker-agent terminal' },
    { name: 'escalation-listener', description: 'Aggregate escalation notifications from PTY sessions' },
    { name: 'bot', description: "Run only the Signal transport, without the cron scheduler ('daemon' runs both)" },
    { name: 'persona', description: 'Manage personas (named policy profiles)' },
    {
      name: 'memory',
      description: "Review and curate a persona's or cron job's persistent memory; prefetch the memory models",
    },
    { name: 'auth', description: 'Manage OAuth providers (import credentials, authorize, revoke)' },
    { name: 'setup', description: 'Run the first-start wizard (always runs)' },
    { name: 'setup-signal', description: 'Interactive Signal transport onboarding' },
    {
      name: 'annotate-tools',
      description: 'Classify MCP tool arguments via LLM (--server <name>, --all, --check or --reset)',
    },
    { name: 'compile-policy', description: 'Compile constitution into enforceable policy rules' },
    { name: 'refresh-lists', description: 'Re-resolve dynamic lists without full recompilation' },
    { name: 'customize-policy', description: 'Customize your policy via LLM-assisted conversation' },
    { name: 'mcp', description: 'Add, remove and list MCP servers (~/.ironcurtain/mcp-servers.json)' },
    { name: 'config', description: 'Edit configuration interactively' },
    { name: 'workflow', description: 'Run multi-agent workflows (start, resume, inspect)' },
    { name: 'observe', description: 'Watch live LLM token output for running sessions' },
    { name: 'statistics', description: 'View and manage locally persisted LLM statistics' },
    { name: 'audit', description: 'Analyze audit logs, verify the policy-mutation log, review learned amendments' },
    { name: 'doctor', description: 'Diagnose installation, credentials, and MCP server health' },
    { name: 'gc', description: 'Inspect or reclaim orphaned IronCurtain containers and networks' },
    { name: 'images', description: 'Show, rebuild or prune the Docker agent images and their CLI versions' },
    {
      name: 'prune',
      description: 'Remove old sessions, workflow runs, run records and dependency caches (retention)',
    },
    {
      name: 'docker-workload',
      description: 'Inspect, reconcile or clear nested-Docker leases (status|reconcile|clear)',
    },
    { name: 'help', description: 'Show this help message' },
  ],
  options: [
    {
      flag: 'env-file',
      placeholder: '<path>',
      description: 'Also load API keys from this file (give it before the command; or set IRONCURTAIN_ENV_FILE)',
    },
    { flag: 'help', short: 'h', description: 'Show this help message (each command also takes --help)' },
    { flag: 'version', short: 'v', description: 'Show version number' },
  ],
  examples: [
    'ironcurtain mux                                # Recommended interactive session',
    'ironcurtain mux --agent claude-code            # Interactive Docker: Claude Code',
    'ironcurtain start "Summarize files in ."       # Single-shot/non-mux task',
    'ironcurtain start --agent builtin              # Local builtin REPL',
    'ironcurtain start --resume <session-id>        # Resume a non-mux session',
    'ironcurtain start -w ./my-project "Fix bugs"   # Work in existing directory',
    'ironcurtain start --agent claude-code "task"   # Docker: Claude Code',
    'ironcurtain start --agent codex "task"         # Docker: Codex CLI',
    'ironcurtain daemon                             # Start the daemon',
    'ironcurtain daemon list-jobs                   # List scheduled jobs',
    'ironcurtain compile-policy                     # Compile policy',
    'ironcurtain compile-policy --help              # Any command: its options',
    'ironcurtain mcp add notes -- /opt/notes/server # Add an MCP server',
    'ironcurtain refresh-lists --with-mcp           # Refresh dynamic lists',
    'ironcurtain audit report --since 7d            # Summarize the last week of tool calls',
    'ironcurtain memory prefetch                    # Download and verify the memory models now',
    'ironcurtain memory alice review                # Memories unattended runs wrote, awaiting review',
    'ironcurtain prune --dry-run                    # See what retention would remove',
    'ironcurtain --env-file ~/work.env mux          # API keys from a file (default ~/.ironcurtain/.env)',
  ],
};

/** The command names `ironcurtain` dispatches (the first word of each table entry). */
export function topLevelCommandNames(): readonly string[] {
  return (topLevelSpec.subcommands ?? []).map((entry) => entry.name.split(' ')[0]);
}

/** Where `ironcurtain <argv>` goes; see {@link routeCommandLine}. */
export type TopLevelRoute =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'command'; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Routes the arguments after `ironcurtain` (with any leading `--env-file`
 * already taken off by the trusted-env bootstrap).
 *
 * The global options (`-h`/`--help`, `-v`/`--version`) count only before the
 * command; everything after the command word belongs to the command, which
 * gets exactly those arguments. So `ironcurtain start -v` is start's business
 * (an unknown option there), and `ironcurtain --help start` prints this help
 * instead of starting a session with the task "start" (before, the command's
 * arguments were taken as argv.slice(3), whatever stood in front of the
 * command). `--version` wins over `--help`; with neither and no command, or
 * the command `help`, the route is the top-level help. Any other option
 * before the command is an error: command options go after the command.
 */
export function routeCommandLine(argv: readonly string[]): TopLevelRoute {
  let help = false;
  let version = false;
  let commandIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      commandIndex = i + 1 < argv.length ? i + 1 : -1;
      break;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-v' || arg === '--version') {
      version = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      return {
        kind: 'error',
        message: `Unknown option '${arg}'. Options of a command go after it: ironcurtain <command> ${arg}`,
      };
    } else {
      commandIndex = i;
      break;
    }
  }
  if (version) return { kind: 'version' };
  if (help || commandIndex < 0) return { kind: 'help' };
  const name = argv[commandIndex];
  if (name === 'help') return { kind: 'help' };
  return { kind: 'command', name, args: argv.slice(commandIndex + 1) };
}

/**
 * Whether a command's own arguments ask for its help: `-h` or `--help` before
 * any `--`. Every command reads those as its help flag, and its strict parser
 * never takes them as an option's value, so such a run only prints usage.
 */
export function requestsHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '-h' || arg === '--help') return true;
  }
  return false;
}

/**
 * The `workflow` subcommands that never run an agent session in this
 * process. They read definitions or run directories from disk, or talk to a
 * daemon; that daemon passed the preflight when it started, and
 * `--ensure-daemon` starts one through `ironcurtain daemon`, which does.
 * Every other workflow subcommand gets the preflight (start,
 * resume-standalone and run-state run sessions here; an unknown one is
 * refused after it).
 */
const WORKFLOW_SUBCOMMANDS_WITHOUT_SESSIONS: ReadonlySet<string> = new Set([
  'list',
  'inspect',
  'lint',
  'watch',
  'run',
  'resume',
  'status',
  'await',
  'gate',
  'escalation',
  'show',
]);

/**
 * Whether `ironcurtain <command> <args>` must pass the V8 sandbox preflight
 * (checkSandboxViability: can isolated-vm load here?) before it is
 * dispatched: only invocations that can run an agent session in this
 * process. Help never does, nor do the read-only and daemon-backed workflow
 * subcommands, so those keep working on a host where isolated-vm cannot
 * load.
 *
 * `daemon` and `bot` run the preflight themselves, right before a session
 * can start: the daemon when it starts and for a run-job no daemon took (its
 * subcommand is known only after its own option parsing, and a forwarded
 * run-job needs none), the bot once its arguments and the Signal
 * configuration have been checked.
 */
export function sandboxPreflightRequired(command: string, args: readonly string[]): boolean {
  if (requestsHelp(args)) return false;
  switch (command) {
    case 'start':
      return true;
    case 'workflow':
      // No subcommand: the workflow help.
      return args.length > 0 && !WORKFLOW_SUBCOMMANDS_WITHOUT_SESSIONS.has(args[0]);
    default:
      return false;
  }
}
