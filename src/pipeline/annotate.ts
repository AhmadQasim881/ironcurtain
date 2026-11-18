/**
 * CLI entry point for `ironcurtain annotate-tools`.
 *
 * Connects to MCP servers, classifies tool arguments via LLM, and writes the
 * user's tool-annotations overlay (`~/.ironcurtain/generated/
 * tool-annotations.json`). The overlay holds only servers whose annotations
 * differ from the reviewed ones shipped with IronCurtain; every loader layers
 * it per server over the package annotations (see
 * `config/tool-annotations-overlay.ts`). When the package was annotated for
 * exactly the live tools, its reviewed annotations are adopted instead of a
 * cached or new LLM result, unless the user pinned their own.
 *
 * Tools whose name, description and input schema are unchanged keep their
 * previous roles and comment (`annotationKey`, see tool-annotator.ts);
 * only new and changed tools go to the LLM. `--diff` prints the role changes
 * of the run for review. A server that fails to annotate keeps its previous
 * annotations; the others are still annotated, the overlay is written after
 * each server, and the run exits 1 naming the failed servers.
 *
 * `--check [--server <name>]` connects to the servers and compares the
 * effective annotations with their live tools (`annotation-check.ts`),
 * exiting 1 on drift; no LLM.
 *
 * `--reset [--server <name>]` removes overlay entries without connecting to
 * any server or calling the LLM.
 *
 * The annotation step itself ({@link annotateServers}) is shared with
 * `ironcurtain mcp add`, which annotates the server it has just added.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import type { MCPServerConfig } from '../config/types.js';
import { getPackageGeneratedDir } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import {
  damagedToolAnnotationsFile,
  describeOverlayWarnings,
  isLegacyOverlayEntry,
  mergeToolAnnotationOverlay,
  readToolAnnotationsFile,
  serverNameForCommand,
  SHIPPED_ANNOTATIONS_DAMAGED_HINT,
  TOOL_ANNOTATIONS_FILENAME,
} from '../config/tool-annotations-overlay.js';
import { checkHelp, printHelp, type CommandSpec } from '../cli-help.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import {
  computeHash,
  createPipelineLlm,
  loadPipelineConfig,
  showCached,
  withSpinner,
  type PipelineConfig,
  type PipelineLlm,
} from './pipeline-shared.js';
import {
  backupLegacyOverlay,
  describeDroppedEntry,
  resetToolAnnotationsOverlay,
  updateAnnotationOverlay,
  writeToolAnnotationsOverlay,
  type OverlayMigration,
  type OverlayResetOutcome,
  type OverlayUpdateResult,
  type ServerAnnotationOutcome,
} from './annotation-overlay.js';
import { buildAnnotationCheckReport, formatAnnotationCheckReport } from './annotation-check.js';
import { openToolDiscovery, type LiveServerConnection, type ToolDiscoveryRun } from './live-tools.js';
import {
  annotateServerTools,
  buildAnnotationPrompt,
  describeStructuredRoleArguments,
  findStructuredRoleArguments,
} from './tool-annotator.js';
import { diffToolAnnotations, formatAnnotationDiff } from './annotation-diff.js';
import type { StoredToolAnnotationsFile } from './types.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const ANNOTATE_HELP: CommandSpec = {
  name: 'ironcurtain annotate-tools',
  description: 'Classify MCP tool arguments via LLM into your tool-annotation overlay',
  usage: [
    'ironcurtain annotate-tools --server <name> [--pin] [--diff]',
    'ironcurtain annotate-tools --all [--diff]',
    'ironcurtain annotate-tools --check [--server <name>]',
    'ironcurtain annotate-tools --reset [--server <name>]',
  ],
  options: [
    {
      flag: 'server',
      description: 'Annotate (or with --check/--reset, only check/reset) this MCP server',
      placeholder: '<name>',
    },
    { flag: 'all', description: 'Annotate all MCP servers' },
    {
      flag: 'pin',
      description: 'Keep your annotations for --server even where IronCurtain ships reviewed ones for the same tools',
    },
    {
      flag: 'diff',
      description: 'Print, per server, the tools whose roles this run changed (for review)',
    },
    {
      flag: 'check',
      description:
        'Compare the effective annotations with the live tools of the configured servers (or --server) and ' +
        'exit 1 on drift; no LLM',
    },
    {
      flag: 'reset',
      description: 'Remove your annotations (for --server, or all) so the shipped ones apply; no LLM or MCP',
    },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain annotate-tools --server filesystem',
    'ironcurtain annotate-tools --server github',
    'ironcurtain annotate-tools --all',
    'ironcurtain annotate-tools --all --diff',
    'ironcurtain annotate-tools --check',
    'ironcurtain annotate-tools --reset --server git',
  ],
};

export interface AnnotateToolsCliArgs {
  server?: string;
  all: boolean;
  reset: boolean;
  pin: boolean;
  check: boolean;
  /** Print the role changes of the run. */
  diff: boolean;
  help: boolean;
}

export function parseAnnotateArgs(argv: string[] = process.argv.slice(2)): AnnotateToolsCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: 'string' },
      all: { type: 'boolean' },
      reset: { type: 'boolean' },
      pin: { type: 'boolean' },
      check: { type: 'boolean' },
      diff: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  return {
    server: typeof values.server === 'string' ? values.server : undefined,
    all: values.all === true,
    reset: values.reset === true,
    pin: values.pin === true,
    check: values.check === true,
    diff: values.diff === true,
    help: values.help === true,
  };
}

/**
 * Returns an error message for an invalid flag combination, or undefined.
 * `--reset` alone (or with `--all`) resets the whole overlay; `--check`
 * alone checks every configured server.
 */
export function validateAnnotateArgs(args: AnnotateToolsCliArgs): string | undefined {
  if (args.server !== undefined && args.all) return '--server and --all cannot be used together.';
  if (args.check && args.reset) return '--check cannot be used with --reset.';
  if (args.check && args.pin) return '--check cannot be used with --pin.';
  if (args.diff && (args.check || args.reset)) return '--diff applies only when annotating (--server or --all).';
  if (args.check) return undefined;
  if (args.reset) return args.pin ? '--pin cannot be used with --reset.' : undefined;
  if (args.server === undefined && !args.all) return 'specify --server <name>, --all or --check.';
  if (args.pin && args.server === undefined) return '--pin requires --server <name>.';
  return undefined;
}

// ---------------------------------------------------------------------------
// MCP Server Connection & Tool Discovery
// ---------------------------------------------------------------------------

type ServerConnection = LiveServerConnection;

/** The servers a run connected to, and the run, which the caller must close. */
interface DiscoveredServers {
  readonly run: ToolDiscoveryRun;
  readonly connections: Map<string, ServerConnection>;
}

async function connectAndDiscoverTools(mcpServers: Record<string, MCPServerConfig>): Promise<DiscoveredServers> {
  const { result } = await withSpinner(
    '[1/2] Connecting to MCP servers',
    async (spinner) => {
      // Each server is started exactly as its session relay starts it: under
      // the OS sandbox it asks for (or refused, or unconfined, as the
      // sandboxPolicy says), with its stored credentials, the allowlisted
      // child environment and the docker->container translation; see
      // live-tools.ts.
      const run = await openToolDiscovery(mcpServers);
      const connections = new Map<string, ServerConnection>();
      const skipped: { name: string; reason: string }[] = [];
      let totalTools = 0;

      for (const serverName of Object.keys(mcpServers)) {
        spinner.text = `[1/2] Connecting to MCP server: ${serverName}...`;
        try {
          const connection = await run.connect(serverName);
          totalTools += connection.tools.length;
          connections.set(serverName, connection);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          skipped.push({ name: serverName, reason: msg });
        }
      }
      return { run, connections, totalTools, skipped };
    },
    (r, elapsed) => `[1/2] Found ${r.totalTools} tools (${elapsed.toFixed(1)}s)`,
  );

  if (result.run.sandboxWarning !== undefined) {
    console.error(chalk.yellow(`  ⚠ ${toDisplayText(result.run.sandboxWarning)}`));
  }
  for (const { name, reason } of result.skipped) {
    console.error(chalk.yellow(`  ⚠ Skipped server '${name}': ${toDisplayText(reason)}`));
  }

  return { run: result.run, connections: result.connections };
}

// ---------------------------------------------------------------------------
// Tool Annotation (LLM step -- cacheable per server + tool schemas)
// ---------------------------------------------------------------------------

function computeAnnotationHash(serverName: string, tools: ServerConnection['tools']): string {
  return computeHash(serverName, JSON.stringify(tools), buildAnnotationPrompt(serverName, tools));
}

function stepTextFor(serverName: string): string {
  return `[2/2] Annotating tools for ${serverName}`;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function listNames(names: readonly string[]): string {
  return names.map(serverNameForCommand).join(', ');
}

/**
 * Explains what the one-time migration of a legacy overlay did.
 * `keptDivergentLegacy` lists the kept legacy entries still in effect after
 * the run (default: all the migration kept).
 */
function printMigrationReport(
  migration: OverlayMigration,
  backupPath: string | undefined,
  keptDivergentLegacy: readonly string[] = migration.keptDivergentLegacy,
): void {
  if (migration.dropped.length === 0 && keptDivergentLegacy.length === 0) return;
  console.error(chalk.bold('Your tool annotations now hold only the servers you re-annotated:'));
  for (const { server, resolution } of migration.dropped) {
    console.error(
      `  ${serverNameForCommand(server)}: removed (${describeDroppedEntry(resolution)}); the shipped annotations apply`,
    );
  }
  for (const server of keptDivergentLegacy) {
    console.error(
      chalk.yellow(
        `  ${serverNameForCommand(server)}: kept; it overrides the shipped annotations. Review it, or run ` +
          `\`ironcurtain annotate-tools --reset --server ${serverNameForCommand(server)}\`.`,
      ),
    );
  }
  if (backupPath) console.error(`  Previous file saved as: ${chalk.dim(backupPath)}`);
  console.error('');
}

function printResetOutcome(outcome: OverlayResetOutcome, server: string | undefined): void {
  const where = chalk.dim(outcome.overlayPath);
  if (!outcome.overlayExisted) {
    console.error(`No user tool annotations at ${where}; the shipped annotations are in use.`);
    return;
  }
  if (outcome.removed.length === 0 && server !== undefined) {
    console.error(`No user tool annotations for ${serverNameForCommand(server)} in ${where}; nothing to reset.`);
    return;
  }
  if (outcome.migration) printMigrationReport(outcome.migration, outcome.backupPath);
  else if (outcome.backupPath) console.error(`Previous file saved as: ${chalk.dim(outcome.backupPath)}`);
  const removed = outcome.removed.length > 0 ? listNames(outcome.removed) : 'all servers';
  console.error(`Removed your tool annotations for: ${removed}. The shipped annotations apply.`);
  if (outcome.result === 'removed') console.error(`Removed ${where} (no user annotations remain).`);
}

/** Per annotated server: tools the LLM annotated, and unchanged tools whose annotations were reused. */
interface AnnotationStats {
  readonly annotated: number;
  readonly reused: number;
}

function printUpdateSummary(
  update: OverlayUpdateResult,
  overlayPath: string,
  writeResult: 'written' | 'removed',
  llm: PipelineLlm | undefined,
  stats: ReadonlyMap<string, AnnotationStats>,
): void {
  const byOutcome = (outcome: ServerAnnotationOutcome): string[] =>
    update.outcomes.filter((o) => o.outcome === outcome).map((o) => o.server);
  const adopted = byOutcome('adopted-package');
  const cached = byOutcome('cached');
  const annotated = byOutcome('annotated');

  console.error('');
  if (adopted.length > 0)
    console.error(`  Using the reviewed annotations shipped with IronCurtain: ${listNames(adopted)}`);
  for (const { server, replacedUserEntry } of update.outcomes) {
    if (replacedUserEntry) {
      console.error(
        `    ${serverNameForCommand(server)}: your previous annotations were removed in favor of the shipped ones ` +
          `(use --pin to keep your own)`,
      );
    }
  }
  if (cached.length > 0) console.error(`  Your annotations, unchanged: ${listNames(cached)}`);
  if (annotated.length > 0) {
    const sum = (field: keyof AnnotationStats): number =>
      annotated.reduce((total, server) => total + (stats.get(server)?.[field] ?? 0), 0);
    console.error(
      `  Re-annotated: ${listNames(annotated)} (${sum('annotated')} tool(s) annotated by the LLM, ` +
        `${sum('reused')} unchanged tool(s) kept)`,
    );
  }
  if (update.orphansDropped.length > 0) {
    console.error(`  Removed annotations for servers no longer configured: ${listNames(update.orphansDropped)}`);
  }
  if (writeResult === 'written') {
    console.error(`  Your annotations written to: ${chalk.dim(overlayPath)}`);
  } else {
    console.error(`  No user annotations remain; the shipped annotations apply (${chalk.dim(overlayPath)} absent).`);
  }
  if (llm) console.error(`  LLM interaction log: ${chalk.dim(llm.logPath)}`);
  console.error('');
}

/** Longest failure reason printed per server. */
const FAILURE_REASON_MAX_LENGTH = 500;

/** Names the servers whose annotation failed and what that leaves in effect. */
function printFailedServers(failed: OverlayUpdateResult['outcomes']): void {
  console.error(chalk.red.bold(`Annotation failed for: ${listNames(failed.map((f) => f.server))}`));
  for (const { server, error } of failed) {
    console.error(
      chalk.red(
        `  ${serverNameForCommand(server)}: ${toDisplayText(error ?? '', { maxLength: FAILURE_REASON_MAX_LENGTH })}`,
      ),
    );
  }
  console.error(
    chalk.yellow(
      '  Their previous annotations (shipped or your own) were kept. Tools and arguments added or changed since ' +
        'those were written stay unannotated, so calls that use them are denied until annotating succeeds.',
    ),
  );
  console.error(
    chalk.yellow(`  Retry with \`ironcurtain annotate-tools --server <name>\`; the other servers' results are saved.`),
  );
  console.error('');
}

/**
 * `--diff`: the role changes of this run, per live server, between the
 * annotations in effect before it and those in effect after it.
 */
function printRoleDiff(
  update: OverlayUpdateResult,
  before: StoredToolAnnotationsFile | undefined,
  after: StoredToolAnnotationsFile | undefined,
): void {
  const toolsOf = (file: StoredToolAnnotationsFile | undefined, server: string) =>
    file && Object.hasOwn(file.servers, server) ? file.servers[server].tools : [];
  console.error(chalk.bold('Role changes (annotations in effect before this run -> after):'));
  let any = false;
  for (const { server } of update.outcomes) {
    const lines = formatAnnotationDiff(
      serverNameForCommand(server),
      diffToolAnnotations(toolsOf(before, server), toolsOf(after, server)),
    );
    for (const line of lines) console.error(line);
    any ||= lines.length > 0;
  }
  if (!any) console.error('  (none)');
  console.error('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function exitWithError(message: string, hint?: string): never {
  console.error(chalk.red(`Error: ${message}`));
  if (hint) console.error(hint);
  process.exit(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `--reset [--server <name>]`: no MCP connections and no LLM. */
function runReset(server: string | undefined): void {
  const packageDir = getPackageGeneratedDir();
  let outcome: OverlayResetOutcome;
  try {
    outcome = resetToolAnnotationsOverlay({ overlayDir: getUserGeneratedDir(), packageDir, server });
  } catch (err) {
    exitWithError(
      errorMessage(err),
      damagedToolAnnotationsFile(err, packageDir) === 'shipped'
        ? SHIPPED_ANNOTATIONS_DAMAGED_HINT
        : 'Run `ironcurtain annotate-tools --reset` (without --server) to remove the whole file.',
    );
  }
  printResetOutcome(outcome, server);
}

/**
 * `--check [--server <name>]`: connects to the servers, compares the
 * effective annotations (package layered with the user overlay) with their
 * live tools and prints the report. No LLM. Returns the exit status: 1 when
 * any server drifted or the requested server could not be checked.
 */
async function runCheck(
  servers: Record<string, MCPServerConfig>,
  effective: StoredToolAnnotationsFile,
  requestedServer: string | undefined,
): Promise<number> {
  console.error(chalk.bold('Tool Annotation Check'));
  console.error(chalk.bold('====================='));
  console.error('');
  const { run, connections } = await connectAndDiscoverTools(servers);
  try {
    const skipped = Object.keys(servers)
      .filter((name) => !connections.has(name))
      .map((name) => ({ name, reason: 'could not be started (see above)' }));
    const report = buildAnnotationCheckReport(effective, connections, skipped);
    console.error('');
    for (const line of formatAnnotationCheckReport(report)) {
      console.error(line.level === 'warn' ? chalk.yellow(line.text) : line.text);
    }
    console.error('');
    const requestedMissing = requestedServer !== undefined && !connections.has(requestedServer);
    if (report.hasDrift) {
      console.error(chalk.yellow.bold('Tool annotations have drifted from the live servers.'));
      return 1;
    }
    if (requestedMissing) {
      console.error(chalk.red(`Error: failed to connect to server '${requestedServer}'.`));
      return 1;
    }
    console.error(chalk.green.bold('Tool annotations match the live servers.'));
    return 0;
  } finally {
    await run.close();
  }
}

export async function main(argv?: string[]): Promise<void> {
  let cliArgs: AnnotateToolsCliArgs;
  try {
    cliArgs = parseAnnotateArgs(argv);
  } catch (err) {
    console.error(chalk.red(errorMessage(err)));
    console.error('');
    printHelp(ANNOTATE_HELP);
    process.exit(1);
  }

  if (checkHelp(cliArgs, ANNOTATE_HELP)) return;

  const argError = validateAnnotateArgs(cliArgs);
  if (argError) {
    console.error(chalk.red(`Error: ${argError}`));
    console.error('');
    printHelp(ANNOTATE_HELP);
    process.exit(1);
  }

  if (cliArgs.reset) {
    runReset(cliArgs.server);
    return;
  }

  // The pipeline only lists tools; it never reads or writes through MCP
  // servers. Discovery points the filesystem server at an empty temporary
  // directory of its own (live-tools.ts), never at this process's cwd.
  const config = loadPipelineConfig();

  if (cliArgs.server && !Object.hasOwn(config.mcpServers, cliArgs.server)) {
    const available = Object.keys(config.mcpServers).join(', ');
    console.error(chalk.red(`Error: unknown server '${cliArgs.server}'.`));
    console.error(`Available servers: ${available}`);
    process.exit(1);
  }

  // Read both annotation files before connecting, so a damaged overlay
  // fails fast instead of being overwritten.
  const overlayPath = resolve(config.generatedDir, TOOL_ANNOTATIONS_FILENAME);
  let inputs: AnnotationInputs;
  try {
    inputs = readAnnotationInputs(config);
  } catch (err) {
    exitWithError(errorMessage(err), annotationFilesDamagedHint(err, config.packageGeneratedDir));
  }
  const { existingOverlay, packageAnnotations } = inputs;

  const serversToAnnotate = cliArgs.server
    ? { [cliArgs.server]: config.mcpServers[cliArgs.server] }
    : config.mcpServers;

  if (cliArgs.check) {
    // The annotations sessions actually use: the package file with the
    // user's overlay layered per server.
    const effective = existingOverlay
      ? mergeToolAnnotationOverlay(packageAnnotations, existingOverlay).annotations
      : packageAnnotations;
    if (!effective) exitWithError('tool-annotations.json not found; reinstall IronCurtain.');
    process.exitCode = await runCheck(serversToAnnotate, effective, cliArgs.server);
    return;
  }

  console.error(chalk.bold('Tool Annotation Pipeline'));
  console.error(chalk.bold('========================'));
  console.error('');
  console.error(
    chalk.yellow.bold('⚠  WARNING: Tool annotations are part of the IronCurtain TCB (Trusted Computing Base).'),
  );
  console.error(chalk.yellow('   This is a developer tool and should not be run lightly. All annotation'));
  console.error(chalk.yellow('   output must be manually reviewed for correctness before use in production.'));
  console.error('');
  if (cliArgs.server) {
    console.error(`Server: ${chalk.bold(cliArgs.server)}`);
  }
  console.error(`Output: ${chalk.dim(overlayPath)}`);
  console.error('');

  let result: AnnotateServersResult;
  try {
    result = await annotateServers({
      config,
      servers: serversToAnnotate,
      requiredServer: cliArgs.server,
      inputs,
      pin: cliArgs.pin,
      all: cliArgs.all,
      diff: cliArgs.diff,
    });
  } catch (err) {
    if (isAnnotateServerUnavailable(err)) {
      console.error(chalk.red(`Error: failed to connect to server '${err.serverName}'.`));
      process.exit(1);
    }
    throw err;
  }
  // The failed servers were named above; the others' results are saved.
  if (result.failed.length > 0) process.exitCode = 1;
}

/** The two annotation files an annotation run starts from. */
export interface AnnotationInputs {
  /** The user's overlay (`<generatedDir>/tool-annotations.json`), if any. */
  readonly existingOverlay: StoredToolAnnotationsFile | undefined;
  /** The annotations shipped with the package, if any. */
  readonly packageAnnotations: StoredToolAnnotationsFile | undefined;
}

/**
 * Reads the user's annotation overlay and the shipped annotations. Throws
 * (`TOOL_ANNOTATIONS_INVALID`) when either exists but is damaged; nothing
 * may be annotated then, or the damaged overlay would be overwritten. Pair
 * with {@link annotationFilesDamagedHint} for the remedy.
 */
export function readAnnotationInputs(
  config: Pick<PipelineConfig, 'generatedDir' | 'packageGeneratedDir'>,
): AnnotationInputs {
  return {
    existingOverlay: readToolAnnotationsFile(resolve(config.generatedDir, TOOL_ANNOTATIONS_FILENAME)),
    packageAnnotations: readToolAnnotationsFile(resolve(config.packageGeneratedDir, TOOL_ANNOTATIONS_FILENAME)),
  };
}

/** What to tell the user when {@link readAnnotationInputs} failed with `err`. */
export function annotationFilesDamagedHint(err: unknown, packageGeneratedDir: string): string {
  return damagedToolAnnotationsFile(err, packageGeneratedDir) === 'shipped'
    ? SHIPPED_ANNOTATIONS_DAMAGED_HINT
    : 'Run `ironcurtain annotate-tools --reset` to remove your annotations file and use the shipped ones.';
}

/** A server the run had to annotate could not be started or did not list its tools. */
export interface AnnotateServerUnavailableError extends Error {
  readonly code: 'ANNOTATE_SERVER_UNAVAILABLE';
  readonly serverName: string;
}

/** True for the error {@link annotateServers} throws when its required server did not connect. */
export function isAnnotateServerUnavailable(err: unknown): err is AnnotateServerUnavailableError {
  return err instanceof Error && 'code' in err && err.code === 'ANNOTATE_SERVER_UNAVAILABLE';
}

export interface AnnotateServersOptions {
  readonly config: PipelineConfig;
  /** The servers to connect to and annotate. */
  readonly servers: Record<string, MCPServerConfig>;
  /** A server that must connect: when it does not, nothing is written and the run throws. */
  readonly requiredServer?: string;
  readonly inputs: AnnotationInputs;
  /** Keep the user's annotations for the servers even where the package ships reviewed ones. */
  readonly pin: boolean;
  /** An `--all` run: servers no longer configured are dropped from the overlay. */
  readonly all: boolean;
  /** `--diff`: print, per server, the tools whose roles the run changed. */
  readonly diff?: boolean;
  /**
   * Creates the annotation LLM on first use (default: the configured policy
   * model through {@link createPipelineLlm}). A test seam.
   */
  readonly createLlm?: (generatedDir: string) => Promise<PipelineLlm>;
}

/** What {@link annotateServers} wrote. */
export interface AnnotateServersResult {
  /** The effective annotations sessions use after the run (package layered with the new overlay). */
  readonly effective: StoredToolAnnotationsFile | undefined;
  readonly update: OverlayUpdateResult;
  readonly overlayPath: string;
  /**
   * Live servers whose annotation failed (outcome 'failed'): each keeps the
   * annotations in effect before the run, which for a server without earlier
   * annotations means none. The run went on with the other servers.
   */
  readonly failed: readonly string[];
}

/**
 * The annotation step of `annotate-tools --server <name>` / `--all`, shared
 * with `ironcurtain mcp add`: connects to `servers` exactly as a session
 * relay would, classifies each server's tools (adopting the shipped or
 * cached annotations where they match the live tools; otherwise the LLM
 * annotates the new and changed tools and the unchanged ones keep their
 * annotations), writes the user's overlay after each server and prints the
 * summary. A server whose annotation fails keeps its previous annotations
 * and is listed in `failed`; the others are still annotated. Throws
 * `ANNOTATE_SERVER_UNAVAILABLE` ({@link isAnnotateServerUnavailable}),
 * writing nothing, when `requiredServer` does not connect.
 */
export async function annotateServers(options: AnnotateServersOptions): Promise<AnnotateServersResult> {
  const { config, inputs } = options;
  const { existingOverlay, packageAnnotations } = inputs;
  const overlayPath = resolve(config.generatedDir, TOOL_ANNOTATIONS_FILENAME);
  const createLlm = options.createLlm ?? ((generatedDir: string) => createPipelineLlm(generatedDir, 'annotate'));

  const { run, connections } = await connectAndDiscoverTools(options.servers);

  if (options.requiredServer !== undefined && !connections.has(options.requiredServer)) {
    await run.close();
    throw Object.assign(new Error(`failed to connect to server '${options.requiredServer}'`), {
      code: 'ANNOTATE_SERVER_UNAVAILABLE' as const,
      serverName: options.requiredServer,
    });
  }

  // The LLM is created on first use: servers whose shipped or cached
  // annotations match the live tools, or whose tools all keep their previous
  // annotations, need no model or credentials.
  let llm: PipelineLlm | undefined;
  const stats = new Map<string, AnnotationStats>();
  // Roles the annotator put on arguments that can hold an object or a nested
  // array, reported once the run's summary is printed.
  const structuredRoleWarnings: string[] = [];

  // The annotations in effect before this run, for --diff.
  const effectiveBefore = existingOverlay
    ? mergeToolAnnotationOverlay(packageAnnotations, existingOverlay).annotations
    : packageAnnotations;

  // The overlay is written after every server, so the annotations of servers
  // already done survive a later server's failure or an interrupted run. A
  // legacy (pre-overlay) file is copied once, before its first rewrite.
  const hadLegacyEntries = existingOverlay ? Object.values(existingOverlay.servers).some(isLegacyOverlayEntry) : false;
  let backupDone = false;
  let backupPath: string | undefined;
  const writeOverlay = (overlay: StoredToolAnnotationsFile): 'written' | 'removed' => {
    if (!backupDone) {
      backupDone = true;
      if (hadLegacyEntries) backupPath = backupLegacyOverlay(config.generatedDir);
    }
    return writeToolAnnotationsOverlay(config.generatedDir, overlay);
  };

  try {
    const live = new Map(
      [...connections].map(([serverName, conn]) => [
        serverName,
        {
          liveHash: computeAnnotationHash(serverName, conn.tools),
          tools: conn.tools,
          ...(conn.serverInfo ? { serverInfo: conn.serverInfo } : {}),
        },
      ]),
    );

    const update = await updateAnnotationOverlay({
      overlay: existingOverlay,
      base: packageAnnotations,
      live,
      pin: options.pin,
      producerVersion: VERSION,
      // --all: servers no longer configured are dropped from the overlay.
      configuredServers: options.all ? new Set(Object.keys(config.mcpServers)) : undefined,
      onPlan: (serverName, plan) => {
        if (plan.kind === 'adopt-package') showCached(stepTextFor(serverName), 'shipped, reviewed annotations');
        else if (plan.kind === 'cached') showCached(stepTextFor(serverName));
      },
      annotate: async (serverName, tools, previous) => {
        const stepText = stepTextFor(serverName);
        const { result } = await withSpinner(
          stepText,
          (spinner) =>
            annotateServerTools({
              serverName,
              tools,
              // Created when a tool first needs it: a server whose tools are
              // all unchanged needs no model or credentials either.
              llm: async () => {
                const pipelineLlm = llm ?? (await createLlm(config.generatedDir));
                llm = pipelineLlm;
                pipelineLlm.logContext.stepName = `annotate-${serverName}`;
                return pipelineLlm.model;
              },
              previous,
              onProgress: (msg) => {
                spinner.text = `${stepText} — ${msg}`;
              },
            }),
          (run, elapsed) =>
            `${stepText}: ${run.annotated.length} tool(s) annotated by the LLM, ` +
            `${run.reused.length} unchanged tool(s) kept (${elapsed.toFixed(1)}s)`,
        );
        stats.set(serverName, { annotated: result.annotated.length, reused: result.reused.length });
        // Reused annotations are in effect too, so they are checked as well.
        structuredRoleWarnings.push(
          ...describeStructuredRoleArguments(serverName, findStructuredRoleArguments(result.annotations)),
        );
        return result.annotations;
      },
      onCheckpoint: (overlay) => {
        writeOverlay(overlay);
      },
    });

    const writeResult = writeOverlay(update.overlay);
    printMigrationReport(update.migration, backupPath, update.keptDivergentLegacy);

    printUpdateSummary(update, overlayPath, writeResult, llm, stats);
    for (const line of structuredRoleWarnings) console.error(chalk.yellow(line));
    const merged = mergeToolAnnotationOverlay(packageAnnotations, update.overlay);
    if (options.diff === true) printRoleDiff(update, effectiveBefore, merged.annotations);
    for (const line of describeOverlayWarnings({ overlayPath, decisions: merged.decisions })) {
      console.error(chalk.yellow(line));
    }

    const failed = update.outcomes.filter((o) => o.outcome === 'failed');
    if (failed.length > 0) printFailedServers(failed);
    else console.error(chalk.green.bold('Tool annotation successful!'));
    return { effective: merged.annotations, update, overlayPath, failed: failed.map((o) => o.server) };
  } finally {
    await run.close();
  }
}

// Only run when executed directly (not when imported by cli.ts).
// Credentials come from the trusted env files only, never from <cwd>/.env.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bootstrapTrustedEnvForProcess } = await import('../config/trusted-env.js');
  bootstrapTrustedEnvForProcess();
  main().catch((err: unknown) => {
    console.error(chalk.red.bold('Tool annotation failed:'), err);
    process.exit(1);
  });
}
