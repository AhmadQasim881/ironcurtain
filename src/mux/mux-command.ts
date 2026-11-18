import { resolveHostModelApiKey } from '../config/model-provider.js';
/**
 * CLI entry point for `ironcurtain mux`.
 *
 * Parses command-line options, loads config, generates a unique muxId
 * for session ownership, creates the MuxApp, and runs until quit.
 */

import chalk from 'chalk';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getPtyRegistryDir } from '../config/paths.js';
import {
  NODE_PTY_BUILD_NOTE,
  NODE_PTY_SPAWN_HELPER_ISSUE_URL,
  nodePtyRemediation,
  repairNodePtySpawnHelper,
} from '../pty/node-pty-loader.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { parseModelId } from '../config/model-provider.js';
import { modelFlagProblem } from '../config/agent-model-guard.js';
import { loadConfig } from '../config/index.js';
import { formatSetupPendingNotice, readFirstStartSetupState } from '../config/setup-state.js';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import {
  resolveSessionMode as defaultResolveSessionMode,
  formatModeLine,
  PreflightError,
} from '../session/preflight.js';
import type { PreflightOptions, PreflightResult } from '../session/preflight.js';
import type { AgentId } from '../docker/agent-adapter.js';
import { createMuxApp, type MuxApp, type MuxAppOptions } from './mux-app.js';
import { buildProviderProfileSnapshots } from './provider-profile-snapshot.js';
import { formatDockerWorkloadStatus } from '../docker-workload/config.js';

const muxSpec: CommandSpec = {
  name: 'ironcurtain mux',
  description: 'Terminal multiplexer for PTY sessions (requires node-pty)',
  usage: ['ironcurtain mux [options]'],
  options: [
    { flag: 'agent', short: 'a', description: 'Agent mode (default: from config)', placeholder: '<name>' },
    { flag: 'model', short: 'm', description: 'Override the agent model ID', placeholder: '<model>' },
    {
      flag: 'capture-traces',
      description: 'Capture LLM API traces for sessions spawned by this mux (overrides config)',
    },
  ],
  examples: [
    'ironcurtain mux --agent claude-code   # then /new to spawn a session',
    // Task scoping is per session and opt-in: the tab's child compiles (or
    // reuses) the task scope before its session starts.
    'ironcurtain mux                       # /new [persona] --task-scoped <task>: escalate calls the task does not need',
  ],
};

/** Test injection points; production callers pass nothing. */
export interface MuxMainDeps {
  readonly resolveSessionMode?: (options: PreflightOptions) => Promise<PreflightResult>;
  readonly createMuxApp?: (options: MuxAppOptions) => MuxApp;
  readonly skipNativeProbes?: boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * node-pty and terminal-kit are optional dependencies. Runs after `--help`,
 * which needs neither. The remediation names commands that work for a global
 * install: `npm install <pkg>` in the current directory does not, since a
 * global IronCurtain resolves modules from its own package directory.
 */
async function probeNativeDependencies(): Promise<void> {
  try {
    await import('node-pty');
  } catch {
    process.stderr.write(
      chalk.red('Error: ironcurtain mux needs the optional node-pty package, which could not be loaded.\n') +
        `${NODE_PTY_BUILD_NOTE}\n${nodePtyRemediation()}\n` +
        'Run `ironcurtain doctor` to check the installation.\n',
    );
    process.exit(1);
  }

  // On macOS, node-pty <=1.1.0 ships spawn-helper without the execute bit,
  // causing "posix_spawnp failed" at runtime. Try to fix it; if we can't
  // (e.g. read-only npx cache), give the user an actionable error message.
  const spawnHelper = repairNodePtySpawnHelper();
  if (spawnHelper.status === 'not-executable') {
    process.stderr.write(
      chalk.red('Error: node-pty spawn-helper is not executable and cannot be fixed automatically.\n') +
        `Run: chmod +x "${spawnHelper.helperPath}"\n` +
        `See: ${NODE_PTY_SPAWN_HELPER_ISSUE_URL}\n`,
    );
    process.exit(1);
  }

  try {
    await import('terminal-kit');
  } catch {
    // Pure JavaScript: missing only when optional dependencies were omitted.
    process.stderr.write(
      chalk.red('Error: ironcurtain mux needs the optional terminal-kit package, which is not installed.\n') +
        'Reinstall IronCurtain with its optional dependencies (without --omit=optional): ' +
        '`npm install -g @provos/ironcurtain`, or `npm install` in a source checkout.\n',
    );
    process.exit(1);
  }
}

/** Returns true if a warning was emitted (caller should pause before fullscreen). */
function emitAutoApproveWarning(userConfig: ResolvedUserConfig): boolean {
  if (!userConfig.autoApprove.enabled) return false;

  const { provider } = parseModelId(userConfig.autoApprove.modelId);
  const apiKey = resolveHostModelApiKey(userConfig.autoApprove.modelId, userConfig, 'autoApprove');
  if (apiKey) return false;

  process.stderr.write(
    chalk.yellow(
      `Warning: auto-approve is enabled but no API key found for provider "${userConfig.hostModelProfiles?.autoApprove ?? provider}".\n` +
        'Auto-approve will be silently disabled. Set the API key in your environment or config.\n',
    ),
  );
  return true;
}

/**
 * Points out a home where the first-start wizard never completed (see
 * config/setup-state.ts). The mux's own sessions never run the wizard, and
 * its config load has created config.json by now. Returns true if the note
 * was printed (caller should pause before fullscreen).
 */
function emitSetupPendingNotice(): boolean {
  if (readFirstStartSetupState() !== 'pending') return false;
  process.stderr.write(chalk.yellow(`${formatSetupPendingNotice()}\n`));
  return true;
}

export async function main(args?: string[], deps: MuxMainDeps = {}): Promise<void> {
  const resolveSessionMode = deps.resolveSessionMode ?? defaultResolveSessionMode;
  const createApp = deps.createMuxApp ?? createMuxApp;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Parse args
  const { values } = parseArgsStrict(
    {
      args: args ?? [],
      options: {
        help: { type: 'boolean', short: 'h' },
        agent: { type: 'string', short: 'a' },
        model: { type: 'string', short: 'm' },
        'capture-traces': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    muxSpec.name,
  );

  // Help and argument errors need no native module: answer them before the
  // node-pty probe, so `ironcurtain mux --help` works where node-pty is missing.
  if (checkHelp(values, muxSpec)) return;

  if (!deps.skipNativeProbes) {
    await probeNativeDependencies();
  }

  const requestedAgentRaw = values.agent as string | undefined;
  const model = values.model as string | undefined;
  const modelMisuse = modelFlagProblem(model);
  if (modelMisuse) {
    process.stderr.write(chalk.red(`${modelMisuse}\n`));
    process.exit(1);
  }
  // CLI flag forces capture on for spawned sessions; absence falls through to
  // each child's config resolution (so we pass the flag, never an explicit off).
  const captureTraces = (values['capture-traces'] as boolean | undefined) ? true : undefined;

  const config = loadConfig();

  // Preflight runs before the autoApprove sleep so a fatal preflight does not wait 3 seconds.
  let preflight: PreflightResult;
  try {
    preflight = await resolveSessionMode({
      config,
      requestedAgent: requestedAgentRaw ? (requestedAgentRaw as AgentId) : undefined,
    });
  } catch (err) {
    if (err instanceof PreflightError) {
      process.stderr.write(chalk.red(err.message) + '\n');
      process.exit(1);
    }
    throw err;
  }

  process.stderr.write(chalk.dim(formatModeLine(preflight)) + '\n');

  // Builtin mode does not have a `--agent` flag to pass to the child PTY,
  // and the PTY child requires container mode anyway. Refuse cleanly here so
  // the user gets a single coherent message rather than per-tab failures.
  if (preflight.mode.kind !== 'docker') {
    process.stderr.write(
      chalk.red(
        'ironcurtain mux requires container agent mode.\n' +
          'Pass --agent claude-code, --agent goose, or --agent codex; or set Session Mode > Preferred mode to "container" in `ironcurtain config`.\n',
      ),
    );
    process.exit(1);
  }
  const resolvedAgent = preflight.mode.agent;
  const nestedDockerStatus = formatDockerWorkloadStatus(config.userConfig.dockerWorkload);
  if (nestedDockerStatus) process.stderr.write(chalk.dim(nestedDockerStatus) + '\n');

  const autoApproveWarned = emitAutoApproveWarning(config.userConfig);
  const setupNoticed = emitSetupPendingNotice();
  if (autoApproveWarned || setupNoticed) {
    process.stderr.write(chalk.dim('\nStarting in 3 seconds...\n'));
    await sleep(3000);
  }

  // Generate a unique mux instance ID for session ownership
  const muxId = `mux-${randomBytes(4).toString('hex')}`;

  // Ensure registry directory exists
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  // Config-load seam (F5): derive the provider-profile snapshot so the /new
  // picker can offer a profile step. Empty (native-only) → the step is skipped.
  const providerProfiles = buildProviderProfileSnapshots(config.userConfig.modelProviders);

  const app = createApp({
    agent: resolvedAgent,
    model,
    captureTraces,
    autoSpawn: false,
    protectedPaths: config.protectedPaths,
    muxId,
    muxPid: process.pid,
    providerProfiles,
  });

  await app.start();
}
