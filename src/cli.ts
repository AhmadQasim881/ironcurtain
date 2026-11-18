#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHelp, parseArgsStrict, printHelp as printSpecHelp, type CommandSpec } from './cli-help.js';
import {
  requestsHelp,
  routeCommandLine,
  sandboxPreflightRequired,
  topLevelCommandNames,
  topLevelSpec,
} from './cli-routing.js';
import { bootstrapTrustedEnvForProcess } from './config/trusted-env.js';

// Load credentials before anything reads process.env: only from
// $IRONCURTAIN_HOME/.env and an explicit --env-file / IRONCURTAIN_ENV_FILE,
// never from a .env in the working directory (often an agent-writable
// workspace). Strips a leading `--env-file <path>` from process.argv.
bootstrapTrustedEnvForProcess();

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  // Works from both dist/ and src/ since package.json is one level up in either case.
  const packageJsonPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const setupSignalSpec: CommandSpec = {
  name: 'ironcurtain setup-signal',
  description: 'Interactive Signal transport onboarding',
  usage: ['ironcurtain setup-signal [options]'],
  options: [
    { flag: 're-trust', description: 'Re-verify a changed identity key' },
    {
      flag: 'update-image',
      description: 'Pull the current signal-cli image, show its digest and pin it (the only way the image changes)',
    },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
};

// The global options count only before the command, and each command gets
// exactly the arguments after its name: `ironcurtain --help start` prints
// this help instead of starting a session with the task "start", and a
// command's own --help always reaches that command (src/cli-routing.ts).
const route = routeCommandLine(process.argv.slice(2));
if (route.kind === 'version') {
  console.log(getVersion());
  process.exit(0);
}
if (route.kind === 'help') {
  printSpecHelp(topLevelSpec);
  process.exit(0);
}
if (route.kind === 'error') {
  process.stderr.write(`${route.message}\n\n`);
  printSpecHelp(topLevelSpec);
  process.exit(1);
}

const subcommand = route.name;
/** The command's own arguments (everything after its name). */
const args = [...route.args];
/** A command's --help: it prints usage and must not touch the home or the sandbox. */
const wantsSubcommandHelp = requestsHelp(args);

// Record which IronCurtain version runs against this home ($IRONCURTAIN_HOME/
// state.json). The first run after an upgrade prints the CHANGELOG's behavior
// changes since the version that last ran and suggests `ironcurtain doctor
// --upgrade`; a home with a newer layout than this version supports is
// refused. Runs before the sandbox preflight, which may create the home, so a
// fresh install is not mistaken for an upgraded one. `doctor` only reads the
// record (diagnostics write nothing), and neither unknown commands nor a
// subcommand's --help record anything.
const knownSubcommands = new Set(topLevelCommandNames());
if (knownSubcommands.has(subcommand) && subcommand !== 'doctor' && !wantsSubcommandHelp) {
  const { recordStartupState } = await import('./config/state-version.js');
  const { toDisplayText } = await import('./terminal/display-sanitize.js');
  try {
    for (const line of recordStartupState({ currentVersion: getVersion() })) {
      process.stderr.write(`${toDisplayText(line)}\n`);
    }
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'STATE_LAYOUT_TOO_NEW') throw err;
    process.stderr.write(`Error: ${toDisplayText(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  }
}

// The V8 sandbox preflight, for the invocations that can run an agent session
// in this process (`start`, the session-running workflow subcommands). It
// catches Node version mismatches or stale native module builds before the
// first session loads isolated-vm. Help, the read-only and daemon-backed
// subcommands skip it, so they work where isolated-vm cannot load; `daemon`
// (starting it, a local run-job) and `bot` run it themselves, right before
// they can start a session. `compile-policy` is the offline policy pipeline
// and never instantiates the V8 sandbox.
if (sandboxPreflightRequired(subcommand, args)) {
  const { ensureSandboxViable } = await import('./utils/preflight-checks.js');
  await ensureSandboxViable();
}

switch (subcommand) {
  case 'start': {
    const { main } = await import('./index.js');
    await main(args);
    break;
  }
  case 'annotate-tools': {
    const { main } = await import('./pipeline/annotate.js');
    await main(args);
    break;
  }
  case 'compile-policy': {
    const { main } = await import('./pipeline/compile.js');
    await main(args);
    break;
  }
  case 'refresh-lists': {
    const { main } = await import('./pipeline/refresh-lists.js');
    await main(args);
    break;
  }
  case 'customize-policy': {
    const { main } = await import('./pipeline/constitution-customizer.js');
    await main(args);
    break;
  }
  case 'config': {
    const { runConfigCommand } = await import('./config/config-command.js');
    await runConfigCommand(args);
    break;
  }
  case 'mcp': {
    const { main: mcpMain } = await import('./mcp/mcp-command.js');
    await mcpMain(args);
    break;
  }
  case 'persona': {
    const { main: personaMain } = await import('./persona/persona-command.js');
    await personaMain(args);
    break;
  }
  case 'memory': {
    const { runMemoryCommand } = await import('./memory/memory-command.js');
    process.exitCode = await runMemoryCommand(args);
    break;
  }
  case 'auth': {
    const { runAuthCommand } = await import('./auth/auth-command.js');
    await runAuthCommand(args);
    break;
  }
  case 'setup': {
    const { runSetupCommand } = await import('./config/first-start.js');
    await runSetupCommand(args);
    break;
  }
  case 'daemon': {
    const { runDaemonCommand } = await import('./daemon/daemon-command.js');
    await runDaemonCommand(args);
    break;
  }
  case 'bot': {
    // The Signal transport alone, never the cron scheduler: job commands
    // live under `ironcurtain daemon` (bot-command.ts parses strictly).
    const { runBotCommand } = await import('./signal/bot-command.js');
    await runBotCommand(args);
    break;
  }
  case 'mux': {
    const { main: muxMain } = await import('./mux/mux-command.js');
    await muxMain(args);
    break;
  }
  case 'escalation-listener': {
    const { main: listenerMain } = await import('./escalation/listener-command.js');
    await listenerMain(args);
    break;
  }
  case 'workflow': {
    const { main: workflowMain } = await import('./workflow/workflow-command.js');
    await workflowMain(args);
    break;
  }
  case 'observe': {
    const { runObserveCommand } = await import('./observe/observe-command.js');
    await runObserveCommand(args);
    break;
  }
  case 'statistics': {
    const { runStatisticsCommand } = await import('./llm-metrics/statistics-command.js');
    await runStatisticsCommand(args);
    break;
  }
  case 'audit': {
    const { runAuditCommand } = await import('./audit/audit-command.js');
    process.exitCode = await runAuditCommand(args);
    break;
  }
  case 'doctor': {
    const { runDoctorCommand } = await import('./doctor/doctor-command.js');
    await runDoctorCommand(args);
    break;
  }
  case 'gc': {
    const { runDockerGcCommand } = await import('./docker/gc-command.js');
    await runDockerGcCommand(args);
    break;
  }
  case 'images': {
    const { runImagesCommand } = await import('./docker/images-command.js');
    await runImagesCommand(args);
    break;
  }
  case 'prune': {
    const { runPruneCommand } = await import('./maintenance/prune-command.js');
    process.exitCode = await runPruneCommand(args);
    break;
  }
  case 'docker-workload': {
    const { runDockerWorkloadCommand } = await import('./docker-workload/workload-command.js');
    process.exitCode = await runDockerWorkloadCommand(args);
    break;
  }
  case 'setup-signal': {
    const { values } = parseArgsStrict(
      {
        args,
        options: {
          're-trust': { type: 'boolean' },
          'update-image': { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      },
      setupSignalSpec.name,
    );
    if (checkHelp(values, setupSignalSpec)) break;
    const reTrust = values['re-trust'] === true;
    const updateImage = values['update-image'] === true;
    if (reTrust && updateImage) {
      console.error('Use --re-trust or --update-image, not both.');
      process.exit(1);
    }
    const { runSignalSetup } = await import('./signal/setup-signal.js');
    await runSignalSetup({ reTrust, updateImage });
    break;
  }
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printSpecHelp(topLevelSpec);
    process.exit(1);
}
