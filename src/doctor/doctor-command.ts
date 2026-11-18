/**
 * `ironcurtain doctor` — on-demand diagnostics.
 *
 * Unlike pre-flight (which is a fail-fast gate), doctor:
 *   - runs every check (continue-on-failure),
 *   - includes active probes pre-flight has no reason to run,
 *   - opt-in network checks: --check-api (a round-trip for each configured
 *     host model role and a no-refresh validation of the OAuth access tokens),
 *     --check-refresh (the OAuth refresh grants: Anthropic's rotates the
 *     token, Google's saves a new access token), and --upgrade (what an
 *     upgrade can leave behind in this home).
 *
 * Doctor is read-only: it writes nothing in the IronCurtain home. The config
 * is loaded without creating or backfilling config.json, the V8 check writes
 * no cache marker, the MCP probes keep their srt settings and working
 * directories in a temporary directory outside the home, and the memory model
 * check only reads and hashes the model store (no download). Credentials are
 * never refreshed except under --check-refresh, and the macOS Keychain is
 * never written.
 *
 * Process exit status: 0 if no checks return `fail`, 1 otherwise.
 * Warnings do not affect the exit code.
 */

import { parseArgs } from 'node:util';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import {
  checkActiveRuntime,
  checkAnnotationDrift,
  checkAnnotationOverlay,
  checkAppleContainer,
  checkConfigLoad,
  checkConstitutionDrift,
  checkDocker,
  checkDockerResources,
  checkDockerUserNamespace,
  checkHostIdentityForLinuxDocker,
  checkHostModelApiRoundtrips,
  checkHostModelRouting,
  checkMcpServerLiveness,
  checkMemoryModels,
  checkMemoryReviewQuarantine,
  checkNodePty,
  checkNodeVersion,
  checkOsSandbox,
  checkPolicyArtifacts,
  checkPreferredMode,
  checkRosetta,
  checkSandbox,
  checkServerCredentials,
  collectDeclaredEnvVars,
  type CheckResult,
  type OsSandboxCheckDeps,
  type ServerLivenessOptions,
} from './checks.js';
import {
  checkDockerWorkloadLeases,
  checkEnvFiles,
  checkEnvironmentVariables,
  checkHomePermissions,
  checkPackageAssets,
  checkSecretFiles,
} from './home-checks.js';
import { checkContainerAgentCredentials, checkModelCredentials } from './model-credential-checks.js';
import { checkDiskUsage } from './disk-usage-checks.js';
import {
  checkAnthropicCredentials,
  checkAnthropicOAuthToken,
  checkCodexCredentials,
  checkOAuthProviderRefresh,
  checkOAuthProviders,
  checkOAuthProviderTokens,
  checkOAuthRefresh,
  type OAuthCheckDeps,
} from './oauth-checks.js';
import { checkJobs, checkPersonas } from './persona-job-checks.js';
import { checkJobDefinitions } from './job-checks.js';
import {
  checkPolicyInvariants,
  checkPolicyProvenanceStatus,
  checkPolicySource,
  checkStoredScenarioReplay,
} from './policy-checks.js';
import type { ServerProbe } from './mcp-liveness.js';
import type { NodePtyProbe } from '../pty/node-pty-loader.js';
import {
  checkChangesSince,
  checkPolicyFreshness,
  checkVersionState,
  checkWorkflowDefinitions,
  checkWorkflowRuns,
  checkWorkflowSnapshots,
  type SnapshotImageInspector,
} from './upgrade-checks.js';
import { printCheck, printSection, printSummary } from './output.js';
import type { MemoryModelsRunner } from '../memory/memory-models.js';

/**
 * Injectable dependencies for runDoctorCommand. Tests pass a probe stub
 * to avoid spawning real MCP servers; production calls receive the
 * defaults automatically.
 */
export interface DoctorDeps {
  readonly probeMcpServer?: ServerProbe;
  /** OS-sandbox dependency check and srt smoke run (tests stub these). */
  readonly osSandbox?: OsSandboxCheckDeps;
  /** The probes' image and npx cache checks (tests stub these). */
  readonly probeEnvironment?: ServerLivenessOptions['environment'];
  /** Network for the --check-api / --check-refresh OAuth checks (tests stub it). */
  readonly oauth?: OAuthCheckDeps;
  /** Image questions of the --upgrade snapshot check (tests stub them). */
  readonly snapshotInspector?: SnapshotImageInspector;
  /** Runs the memory server's model check (tests stub it; default spawns the bundled server). */
  readonly memoryModels?: MemoryModelsRunner;
  /** Whether the installed memory server has the review quarantine (tests stub it; default resolves its exports). */
  readonly memoryReviewQuarantine?: () => boolean;
  /** node-pty load and spawn-helper probe (tests stub it). */
  readonly nodePty?: () => Promise<NodePtyProbe>;
}

const DOCTOR_HELP: CommandSpec = {
  name: 'ironcurtain doctor',
  description: 'Diagnose installation, credentials, and MCP server health (read-only)',
  usage: ['ironcurtain doctor [options]'],
  options: [
    {
      flag: 'check-api',
      description: 'Also run a round-trip for each host model role and validate OAuth access tokens (no refresh)',
    },
    {
      flag: 'check-refresh',
      description:
        'Also test the OAuth refresh tokens with a refresh grant: Anthropic, which rotates it (the new token is saved to the credentials file, and a running Claude Code or Anthropic CLI must re-read it; Keychain-stored credentials are never refreshed), and Google Workspace (the new access token is saved)',
    },
    {
      flag: 'upgrade',
      description:
        'Also check what an upgrade can leave behind: workflow definitions and runs, snapshots, stale policies',
    },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain doctor',
    'ironcurtain doctor --check-api',
    'ironcurtain doctor --upgrade',
    'ironcurtain doctor --check-refresh',
  ],
};

export interface DoctorCliArgs {
  readonly checkApi: boolean;
  readonly checkRefresh: boolean;
  readonly upgrade: boolean;
  readonly help: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      'check-api': { type: 'boolean' },
      'check-refresh': { type: 'boolean' },
      upgrade: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  return {
    checkApi: values['check-api'] === true,
    checkRefresh: values['check-refresh'] === true,
    upgrade: values.upgrade === true,
    help: values.help === true,
  };
}

/**
 * Runs the doctor pipeline. Exits with 1 if any check returned `fail`.
 */
export async function runDoctorCommand(argv: string[], deps: DoctorDeps = {}): Promise<void> {
  let args: DoctorCliArgs;
  try {
    args = parseDoctorArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (checkHelp(args, DOCTOR_HELP)) return;

  process.stdout.write('ironcurtain doctor\n');

  const collected: CheckResult[] = [];
  const report = (result: CheckResult | undefined): void => {
    if (result === undefined) return;
    printCheck(result);
    collected.push(result);
  };

  // Environment — sandbox and docker probes are independent, kick off in
  // parallel and await in declaration order so output stays deterministic.
  printSection('Environment', { first: true });
  report(checkNodeVersion());

  const sandboxPromise = checkSandbox();
  const dockerPromise = checkDocker();
  const applePromise = checkAppleContainer();

  report(await sandboxPromise);
  // The optional terminal module behind mux, the web UI terminal and Apple
  // Container interactive sessions.
  report(await checkNodePty(deps.nodePty));
  const dockerResult = await dockerPromise;
  report(dockerResult);
  const appleResult = await applePromise;
  report(appleResult);

  // Rosetta only matters when the Apple backend is usable: its BuildKit
  // builder VM cannot build agent images without it.
  if (appleResult.status === 'ok') report(checkRosetta());

  // Configuration — gates everything that needs the resolved config.
  printSection('Configuration');
  const configCheck = checkConfigLoad();
  report(configCheck.result);
  // Before the config gate: a config.json that this version cannot load may
  // have been written by a newer IronCurtain, which this line names.
  report(checkVersionState(undefined, args.upgrade));

  if (!configCheck.config) {
    // Without a config we can't proceed past the basic environment.
    printSummary(collected);
    exitWithStatus(collected);
  }
  const config = configCheck.config;

  // Resolve which container backend sessions will actually use (env
  // override > containerRuntime config > auto probe) and evaluate the
  // remaining container checks against THAT backend — a Docker-less
  // machine on the Apple runtime is a healthy setup, not a broken one.
  const runtime = await checkActiveRuntime(config, dockerResult, appleResult);
  report(runtime.result);

  // Linux Docker only (the checks skip themselves elsewhere): whether the
  // host identity can be remapped into agent containers at all, and whether
  // container root is real host root on bind mounts.
  const hostIdentityResult = checkHostIdentityForLinuxDocker(runtime.kind);
  if (hostIdentityResult.status !== 'skip') report(hostIdentityResult);
  const userNamespaceResult = await checkDockerUserNamespace(runtime.kind, runtime.availability.status === 'ok');
  if (userNamespaceResult.status !== 'skip') report(userNamespaceResult);

  // Reuse the availability result from the Environment section so each
  // runtime is probed at most once per doctor run. checkPreferredMode
  // upgrades the earlier warn to a fail when preferredMode is "container",
  // because in that configuration runtime unavailability means sessions
  // refuse to start.
  report(checkPreferredMode(config, runtime.availability, runtime.label));

  // Offline: host roles bound to a gateway that would receive a model ID it
  // cannot route (the round-trips under --check-api confirm the rest).
  const routingResult = checkHostModelRouting(config);
  if (routingResult.status !== 'skip') report(routingResult);

  // The resource probe is the slow part of this section (can take up to ~30s
  // worst case waiting on a container run). Kick it off in parallel with the
  // synchronous policy-artifact checks below and await before printing.
  const resourcePromise =
    runtime.availability.status === 'ok' ? checkDockerResources(config, {}, runtime.kind) : undefined;

  const policyCheck = checkPolicyArtifacts(config);
  for (const r of policyCheck.results) report(r);

  // The global policy's staleness, for the --upgrade summary.
  const globalPolicyProblems: string[] = [];
  if (policyCheck.compiledPolicy !== undefined) {
    // Where the policy comes from and whether it still matches this
    // IronCurtain: provenance, an offline replay of its stored scenarios, and
    // the universal invariants. The constitution check below says nothing
    // about compiler, engine or annotation changes.
    report(checkPolicySource(policyCheck));
    const provenance = checkPolicyProvenanceStatus(config, policyCheck);
    report(provenance);
    if (provenance.status !== 'ok') globalPolicyProblems.push(provenance.message);
    report(checkStoredScenarioReplay(config, policyCheck));
    report(checkPolicyInvariants(config, policyCheck));

    const constitutionResult = checkConstitutionDrift(config, policyCheck.compiledPolicy);
    report(constitutionResult);
    if (constitutionResult.status !== 'ok') globalPolicyProblems.push(constitutionResult.message);

    report(checkAnnotationDrift(policyCheck.toolAnnotations, config.mcpServers));
    report(checkAnnotationOverlay(policyCheck.toolAnnotationsOverlay));
  } else {
    globalPolicyProblems.push('the compiled policy does not load');
  }

  // Personas and cron jobs: definitions sessions and the daemon refuse or
  // skip, and their compiled policies (presence, constitution, provenance,
  // broad-policy opt-in).
  report(checkPersonas(config, policyCheck.toolAnnotations));
  report(checkJobs(policyCheck.toolAnnotations));

  if (resourcePromise !== undefined) report(await resourcePromise);

  // Cron job definitions the daemon would not load (invalid job.json).
  report(checkJobDefinitions());

  // Files and settings around the process.
  printSection('Files');
  report(checkHomePermissions());
  report(await checkDiskUsage(config));
  report(checkSecretFiles());
  report(checkEnvFiles());
  report(checkEnvironmentVariables());
  report(await checkPackageAssets(config));
  report(await checkDockerWorkloadLeases(config));

  // Credentials.
  printSection('Credentials');
  report(await checkAnthropicCredentials(config));
  const codexLogin = checkCodexCredentials();
  report(codexLogin);
  report(checkContainerAgentCredentials(config.userConfig, codexLogin));
  for (const r of checkOAuthProviders(config)) report(r);
  for (const r of checkModelCredentials(config.userConfig)) report(r);

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    // Skip servers with no declared credential env vars — they'd otherwise
    // produce one "no credentials required" line per server, drowning out
    // the servers that actually need attention.
    if (collectDeclaredEnvVars(serverConfig).length === 0) continue;
    report(checkServerCredentials(serverName, serverConfig, config));
  }

  // MCP servers — parallel probes, started the way a session's relay starts
  // them (srt included). Nothing is created in the IronCurtain home: when the
  // configured allowed directory does not exist yet, the filesystem server
  // is probed against a temporary empty directory instead.
  printSection('MCP servers');
  // OS sandbox first: servers it refuses are not probed (sessions will not
  // start them, and the probe would spawn them unconfined).
  const osSandbox = await checkOsSandbox(config, deps.osSandbox);
  report(osSandbox.result);

  // Each live server's tools are diffed against the effective annotations
  // (argument-level drift); the server-level check above only compares
  // server names.
  const livenessResults = await checkMcpServerLiveness(config, {
    probe: deps.probeMcpServer,
    refusedServers: osSandbox.refused,
    toolAnnotations: policyCheck.toolAnnotations,
    sandbox: { availability: osSandbox.availability, policy: osSandbox.policy },
    environment: deps.probeEnvironment,
  });
  for (const r of livenessResults) report(r);

  // Memory: the memory server's pinned models in ~/.ironcurtain/models,
  // verified against their hashes. Read-only like the rest of doctor: the
  // server's --verify-models only reads and hashes the store, never
  // downloads and never creates the models directory. Then whether the
  // installed server has the review quarantine cron jobs and workflows need
  // (found from its package exports; nothing is started).
  printSection('Memory');
  report(await checkMemoryModels(config, deps.memoryModels));
  report(checkMemoryReviewQuarantine(config, deps.memoryReviewQuarantine));

  // Optional network checks.
  if (args.checkApi || args.checkRefresh) {
    printSection('API round-trip');
    if (args.checkApi) {
      for (const r of await checkHostModelApiRoundtrips(config)) report(r);
      report(await checkAnthropicOAuthToken(config, deps.oauth));
      for (const r of await checkOAuthProviderTokens(config, deps.oauth)) report(r);
    }
    if (args.checkRefresh) {
      report(await checkOAuthRefresh(config, deps.oauth));
      for (const r of await checkOAuthProviderRefresh(config)) report(r);
    }
  }

  if (args.upgrade) {
    printSection('Upgrade');
    report(checkChangesSince());
    report(await checkWorkflowDefinitions());
    report(await checkWorkflowRuns());
    report(await checkWorkflowSnapshots(dockerResult.status === 'ok', deps.snapshotInspector, config.userConfig));
    report(
      checkPolicyFreshness(
        config,
        policyCheck.toolAnnotations,
        globalPolicyProblems.length === 0 ? undefined : globalPolicyProblems.join('; '),
      ),
    );
  }

  printSummary(collected);
  exitWithStatus(collected);
}

/**
 * Exits the process with status 1 on any check failure, 0 otherwise.
 * Always exits explicitly because MCP server subprocesses spawned by the
 * liveness probes can keep the Node event loop alive past the last printed
 * line, even after `client.close()` (the MCP SDK doesn't aggressively
 * SIGKILL the child).
 */
function exitWithStatus(collected: CheckResult[]): never {
  const code = collected.some((c) => c.status === 'fail') ? 1 : 0;
  // Set exitCode first so any handler that swallows process.exit (test
  // harnesses, signal handlers) still sees a non-zero status for CI to gate on.
  process.exitCode = code;
  process.exit(code);
}
