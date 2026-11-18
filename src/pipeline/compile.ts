/**
 * CLI entry point for `ironcurtain compile-policy`.
 *
 * Thin wrapper over PipelineRunner that handles CLI-specific concerns:
 * loading config, printing the progress banner, and exit codes.
 *
 * The core compile-verify-repair loop lives in PipelineRunner.
 *
 * CLI flags:
 *   --constitution <path>  Use an alternative constitution file
 *   --output-dir <path>    Write compiled artifacts to this directory
 *   --server <name>        Compile only this server (for debugging). Writes only
 *                          servers/<name>/ and leaves the merged policy alone,
 *                          unless --output-dir or --write-merged is also given.
 *   --write-merged         With --server: also write the merged artifacts. They
 *                          then hold ONLY that server's rules.
 *   --no-mcp               Do not pass MCP server configs to the pipeline.
 *                          Data-backed lists without a cached resolution are
 *                          left unresolved (empty, never cached as resolved).
 *   --force                Ignore every cached per-server result: recompile,
 *                          regenerate scenarios and re-verify each server, and
 *                          ask the pre-filter again (after switching the policy
 *                          model, or when a cached result was verified by an
 *                          older pipeline verifier; the cache warns about both
 *                          but still serves the result)
 *   --allow-broad-domains  Accept allow rules with broad domain access ("*", a
 *                          wildcard over a public suffix such as *.com or
 *                          *.github.io, or a URL role with no domains
 *                          condition). The policy lint rejects them otherwise.
 *                          The constitution can opt in instead with a line
 *                          holding only `<!-- ironcurtain: allow-broad-domains -->`.
 *   -h, --help             Show usage
 *
 * Exit status:
 *   0  every compiled server passed verification
 *   1  the run failed and wrote no merged policy (for example, every server
 *      failed), or the arguments were invalid
 *   2  partial failure: the policy was written, but the servers listed in its
 *      `failedServers` have no rules, so their tools are denied
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { checkHelp, type CommandSpec } from '../cli-help.js';
import { loadPrefilterConstitutionText } from '../config/paths.js';
import { loadToolAnnotations, warnOnAnnotationOverlay } from '../config/tool-annotations-overlay.js';
import type { MCPServerConfig } from '../config/types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { buildAnnotationCheckReport, formatAnnotationCheckReport } from './annotation-check.js';
import { buildLiveSchemaIndex, discoverLiveTools } from './live-tools.js';
import { loadPipelineConfig } from './pipeline-shared.js';
import { PipelineRunner, createPipelineModels, type PipelineModels } from './pipeline-runner.js';
import { BROAD_DOMAINS_DIRECTIVE, constitutionAllowsBroadDomains } from './policy-lint.js';
import type { LiveSchemaIndex } from './scenario-schema-validator.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from './types.js';

// Re-export utilities that test files import from this file.
export { resolveRulePaths } from './pipeline-shared.js';

/** Exit status when the policy was written but some servers failed and have no rules. */
export const COMPILE_PARTIAL_FAILURE_EXIT_CODE = 2;

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

export const compilePolicySpec: CommandSpec = {
  name: 'ironcurtain compile-policy',
  description: 'Compile the constitution into enforceable policy rules',
  usage: ['ironcurtain compile-policy [options]'],
  options: [
    { flag: 'constitution', description: 'Compile this constitution file instead', placeholder: '<path>' },
    { flag: 'output-dir', description: 'Write the compiled artifacts to this directory', placeholder: '<path>' },
    {
      flag: 'server',
      description: 'Compile only this server; writes only servers/<name>/ unless --output-dir or --write-merged',
      placeholder: '<name>',
    },
    { flag: 'write-merged', description: "With --server: also write the merged policy (ONLY that server's rules)" },
    {
      flag: 'no-mcp',
      description: 'No MCP server access: data-backed lists without a cached resolution stay unresolved (empty)',
    },
    {
      flag: 'force',
      description: 'Ignore every cached per-server result: recompile, regenerate scenarios and re-verify',
    },
    {
      flag: 'allow-broad-domains',
      description: 'Accept allow rules with broad domain access ("*", *.com, a URL role with no domains condition)',
    },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
  examples: [
    'ironcurtain compile-policy                     # Compile the active constitution',
    'ironcurtain compile-policy --server github     # Recompile one server (merged policy untouched)',
    'ironcurtain compile-policy --no-mcp            # Compile without connecting MCP servers',
    'ironcurtain compile-policy --force             # Recompile and re-verify every server',
  ],
};

export interface CompilePolicyCliArgs {
  constitution?: string;
  outputDir?: string;
  server?: string;
  noMcp?: boolean;
  writeMerged?: boolean;
  /** Ignore cached per-server results (`--force`). */
  force?: boolean;
  allowBroadDomains?: boolean;
  /** `--help` / `-h`: print usage and do nothing else. */
  help?: boolean;
}

/**
 * Parses the compile-policy flags from process.argv.
 * Returns resolved absolute paths when provided.
 */
export function parseCompilePolicyArgs(argv: string[] = process.argv.slice(2)): CompilePolicyCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      constitution: { type: 'string' },
      'output-dir': { type: 'string' },
      server: { type: 'string' },
      'no-mcp': { type: 'boolean' },
      'write-merged': { type: 'boolean' },
      force: { type: 'boolean' },
      'allow-broad-domains': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    // Strict so unknown flags are rejected; allowPositionals keeps the
    // `compile-policy` subcommand token (present in process.argv.slice(2))
    // from being treated as an unexpected argument.
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return { help: true };
  const constitution = typeof values.constitution === 'string' ? values.constitution : undefined;
  const outputDir = typeof values['output-dir'] === 'string' ? values['output-dir'] : undefined;
  const server = typeof values.server === 'string' ? values.server : undefined;
  // An empty name (`--server=`) would select no server filter, i.e. a full
  // run, while still counting as a --server run for the merged-write rule.
  if (server !== undefined && server.trim() === '') {
    throw new Error('--server requires a server name.');
  }
  const noMcp = values['no-mcp'] ?? false;
  const writeMerged = values['write-merged'] ?? false;
  if (writeMerged && server === undefined) {
    throw new Error('--write-merged only applies together with --server <name>.');
  }
  return {
    constitution: constitution ? resolve(constitution) : undefined,
    outputDir: outputDir ? resolve(outputDir) : undefined,
    server,
    noMcp,
    writeMerged,
    force: values.force ?? false,
    allowBroadDomains: values['allow-broad-domains'] ?? false,
  };
}

/**
 * Where the opt-in to broad domain access comes from, or undefined when the
 * run has none: the `--allow-broad-domains` flag, or the directive line in
 * the constitution (see BROAD_DOMAINS_DIRECTIVE).
 */
export function broadDomainsOptIn(args: CompilePolicyCliArgs, constitutionText: string): string | undefined {
  if (args.allowBroadDomains === true) return '--allow-broad-domains';
  if (constitutionAllowsBroadDomains(constitutionText)) return `constitution directive ${BROAD_DOMAINS_DIRECTIVE}`;
  return undefined;
}

/**
 * Whether a run may write the merged top-level artifacts. A `--server` run
 * compiles one server; written as the merged policy, its result would replace
 * every other server's rules in the active policy. Such a run therefore writes
 * only `servers/<name>/` unless the user chose a separate `--output-dir` or
 * passed `--write-merged`.
 */
export function shouldWriteMergedArtifacts(args: CompilePolicyCliArgs): boolean {
  if (args.server === undefined) return true;
  return args.outputDir !== undefined || args.writeMerged === true;
}

/** Exit status for a run that produced `policy` (see the header comment). */
export function compileExitCode(policy: CompiledPolicyFile): number {
  return (policy.failedServers?.length ?? 0) > 0 ? COMPILE_PARTIAL_FAILURE_EXIT_CODE : 0;
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

/** Injection seams, used by tests. */
export interface CompilePolicyDeps {
  /** Builds the pipeline models. Defaults to the configured providers. */
  readonly createModels?: (logDir: string) => Promise<PipelineModels>;
  /**
   * Compares the stored annotations with the live servers and returns their
   * live schemas (see {@link checkLiveAnnotationDrift}). Tests stub it so a
   * compile run spawns no MCP server.
   */
  readonly checkLiveDrift?: typeof checkLiveAnnotationDrift;
}

/**
 * Connects to the MCP servers the compile covers, warns about every server
 * whose stored annotations no longer describe its live tools (the compiled
 * policy is built from the stored annotations, so such a server's new or
 * renamed arguments stay unevaluated until it is re-annotated), and returns
 * the live input schemas for scenario validation. Servers that cannot be
 * started, or are not started (an OS sandbox the policy refuses to do
 * without, an OAuth-backed server), are reported as not checked, never
 * fatal: the compile goes on with the stored schemas for them. A warning,
 * not a refusal: the stored annotations are what sessions enforce either way
 * (and the pipeline denies every argument they do not classify), so
 * refusing would only keep a user's constitution changes from taking
 * effect.
 *
 * The servers are launched as their session relays launch them, the
 * filesystem server against an empty temporary directory (see
 * `live-tools.ts`). `discover` is a test seam; production uses
 * {@link discoverLiveTools}.
 */
export async function checkLiveAnnotationDrift(
  mcpServers: Record<string, MCPServerConfig>,
  annotations: StoredToolAnnotationsFile,
  serverFilter: string | undefined,
  log: (line: string) => void = (line) => {
    console.error(line);
  },
  discover: typeof discoverLiveTools = discoverLiveTools,
): Promise<LiveSchemaIndex> {
  const servers = Object.fromEntries(
    Object.entries(mcpServers).filter(
      ([name]) => Object.hasOwn(annotations.servers, name) && (serverFilter === undefined || name === serverFilter),
    ),
  );
  if (Object.keys(servers).length === 0) return new Map();
  log(chalk.dim(`Checking tool annotations against the live MCP servers: ${Object.keys(servers).join(', ')}`));
  const discovery = await discover(servers);
  try {
    if (discovery.sandboxWarning !== undefined) log(chalk.yellow(`  ${toDisplayText(discovery.sandboxWarning)}`));
    const report = buildAnnotationCheckReport(annotations, discovery.connections, discovery.skipped);
    for (const line of formatAnnotationCheckReport(report)) {
      log(line.level === 'warn' ? chalk.yellow(`  ${line.text}`) : chalk.dim(`  ${line.text}`));
    }
    if (report.affectsPolicy) {
      log(
        chalk.yellow(
          '  The policy is compiled from the stored annotations: tools and arguments they do not classify ' +
            'are denied, and changed discriminators fall back to default roles, until the server is ' +
            're-annotated and the policy recompiled.',
        ),
      );
    }
    if (report.skipped.length > 0) {
      log(chalk.dim('  Scenarios of servers that were not checked are validated against the stored schemas.'));
    }
    log('');
    return buildLiveSchemaIndex(discovery.connections);
  } finally {
    await discovery.close();
  }
}

/**
 * Runs compile-policy for `argv` and returns the exit status. Throws when the
 * run fails without writing a merged policy; the caller reports it (exit 1).
 */
export async function runCompilePolicy(argv: string[], deps: CompilePolicyDeps = {}): Promise<number> {
  let cliArgs: CompilePolicyCliArgs;
  try {
    cliArgs = parseCompilePolicyArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`Run \`${compilePolicySpec.name} --help\` for usage.\n`);
    return 1;
  }
  if (checkHelp(cliArgs, compilePolicySpec)) return 0;
  const config = loadPipelineConfig(cliArgs);

  // Load tool annotations early to validate they exist before printing the banner.
  // A user overlay in the output dir is layered per server over the package's.
  const loadedAnnotations = loadToolAnnotations(config.generatedDir, config.packageGeneratedDir);
  if (!loadedAnnotations) {
    console.error(
      chalk.red.bold(
        "Error: tool-annotations.json not found. Run 'npm run annotate-tools' first to generate tool annotations.",
      ),
    );
    return 1;
  }
  const storedAnnotationsFile = loadedAnnotations.annotations;
  warnOnAnnotationOverlay(loadedAnnotations.overlay, (text) => {
    process.stderr.write(chalk.yellow(text));
  });

  const allAnnotations = Object.values(storedAnnotationsFile.servers).flatMap((server) => server.tools);
  const serverNames = Object.keys(storedAnnotationsFile.servers);
  const writeMergedArtifacts = shouldWriteMergedArtifacts(cliArgs);
  const broadDomainsSource = broadDomainsOptIn(cliArgs, config.constitutionText);

  console.error(chalk.bold('Policy Compilation Pipeline (per-server)'));
  console.error(chalk.bold('========================================='));
  console.error(`Constitution: ${chalk.dim(config.constitutionPath)}`);
  console.error(`Sandbox:      ${chalk.dim(config.allowedDirectory)}`);
  console.error(`Output:       ${chalk.dim(config.generatedDir + '/')}`);
  console.error(
    `Annotations:  ${chalk.dim(`${allAnnotations.length} tools from ${serverNames.length} server(s): ${serverNames.join(', ')}`)}`,
  );
  if (cliArgs.force) {
    console.error(
      chalk.dim('Cache:        ignored (--force): every server is pre-filtered, recompiled and re-verified again'),
    );
  }
  if (broadDomainsSource) {
    console.error(
      chalk.yellow(
        `Broad domains: allowed (${broadDomainsSource}); "*" and public-suffix wildcards pass the policy lint.`,
      ),
    );
  }
  if (cliArgs.server) {
    console.error(`Server filter: ${chalk.cyan(cliArgs.server)}`);
    if (writeMergedArtifacts) {
      console.error(
        chalk.yellow(
          `  The merged artifacts in ${config.generatedDir}/ will hold ONLY ${cliArgs.server}'s rules; ` +
            'every other server in that policy loses its rules (default-deny).',
        ),
      );
    } else {
      console.error(
        chalk.dim(
          `  Only servers/${cliArgs.server}/ is written; the merged policy is not modified. ` +
            'Run without --server to rebuild it (verified servers are reused from cache).',
        ),
      );
    }
  }
  console.error('');

  // Live-schema drift: the stored annotations against the tools the servers
  // expose today. Without MCP the comparison is impossible, so say so rather
  // than silently skipping it.
  let liveToolSchemas: LiveSchemaIndex | undefined;
  if (cliArgs.noMcp) {
    console.error(
      chalk.dim(
        'Annotation drift against the live MCP servers was not checked (--no-mcp); ' +
          'scenarios are validated against the stored schemas.',
      ),
    );
    console.error('');
  } else {
    const checkLiveDrift = deps.checkLiveDrift ?? checkLiveAnnotationDrift;
    liveToolSchemas = await checkLiveDrift(config.mcpServers, storedAnnotationsFile, cliArgs.server);
  }

  const createModels = deps.createModels ?? createPipelineModels;
  const models = await createModels(config.generatedDir);

  const runner = new PipelineRunner(models);

  const policy = await runner.run({
    constitutionInput: config.constitutionText,
    constitutionKind: 'constitution',
    outputDir: config.generatedDir,
    toolAnnotationsDir: config.generatedDir,
    toolAnnotationsFallbackDir: config.packageGeneratedDir,
    allowedDirectory: config.allowedDirectory,
    protectedPaths: config.protectedPaths,
    mcpServers: cliArgs.noMcp ? undefined : config.mcpServers,
    llmLogPath: models.logPath,
    preloadedStoredAnnotations: storedAnnotationsFile,
    liveToolSchemas,
    serverFilter: cliArgs.server ? [cliArgs.server] : undefined,
    writeMergedArtifacts,
    force: cliArgs.force === true,
    cacheBypassHint: 'Run `ironcurtain compile-policy` again with `--force` to recompile and re-verify it.',
    allowBroadDomains: broadDomainsSource !== undefined,
    prefilterText: cliArgs.constitution
      ? config.constitutionText
      : loadPrefilterConstitutionText(config.constitutionText),
  });

  const exitCode = compileExitCode(policy);
  if (exitCode !== 0) {
    const failed = policy.failedServers ?? [];
    console.error('');
    console.error(
      chalk.red.bold(
        `Policy compilation incomplete: ${failed.length} server(s) failed and have no rules ` +
          `(${failed.map((f) => f.serverName).join(', ')}). Exit status ${exitCode}.`,
      ),
    );
  }
  return exitCode;
}

/**
 * CLI entry. Sets `process.exitCode` rather than calling `process.exit()`: an
 * immediate exit can drop the summary still queued for a piped stderr (pipe
 * writes are asynchronous on macOS), and the status reaches the shell once
 * the process ends. In-process callers use {@link runCompilePolicy}.
 */
export async function main(argv: string[] = process.argv.slice(2), deps: CompilePolicyDeps = {}): Promise<void> {
  const exitCode = await runCompilePolicy(argv, deps);
  if (exitCode !== 0) process.exitCode = exitCode;
}

// Only run when executed directly (not when imported by cli.ts or tests).
// Credentials come from the trusted env files only, never from <cwd>/.env.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bootstrapTrustedEnvForProcess } = await import('../config/trusted-env.js');
  bootstrapTrustedEnvForProcess();
  main().catch((err: unknown) => {
    console.error(chalk.red.bold('Policy compilation failed:'), err);
    process.exit(1);
  });
}
