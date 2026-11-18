/**
 * `ironcurtain refresh-lists`: re-resolves a policy's dynamic lists without
 * re-running the full compilation pipeline.
 *
 * Targets: the global policy (default), a persona's (`--persona <name>`) or a
 * cron job's (`--job <id>`). The daemon runs the same refresh for a persona
 * or a job over its control socket (`refreshDynamicLists`).
 *
 * List definitions come from the target's compiled-policy.json (the
 * authoritative source). Each selected list is re-resolved by the LLM; a
 * data-backed list through its MCP server, with every call mediated by the
 * security kernel under the read-only policy and audited
 * (`connectViaProxy`). The cache is always bypassed: refresh means "get
 * fresh data".
 *
 * Every file the refresh reads (the compiled policy, the merged lists and the
 * per-server copies it writes through to) is schema-validated before any
 * model is set up (src/types/policy-schema.ts): a malformed file stops the
 * refresh with a field-level error and nothing is written.
 *
 * Writes, the file the runtime reads last:
 *   1. servers/<server>/dynamic-lists.json of every server whose rules use a
 *      refreshed list, under the list's name there (`sourceName`), so the
 *      next compile-policy keeps the refreshed values instead of reverting to
 *      its cached ones. Per-server copies hold resolver output only.
 *   2. the merged dynamic-lists.json, with the user's manual overrides
 *      (`manualAdditions` / `manualRemovals`) kept. The overrides are never
 *      fed into the resolver, so a value the user removes from
 *      `manualAdditions` stops being allowed. The lists it carries over
 *      unrefreshed are re-validated against the current value rules
 *      (`mergeRefreshedLists`).
 *
 * The global policy may be the one shipped with the package (the user never
 * compiled locally). Its directory is not ours to write, so the refreshed
 * lists go to ~/.ironcurtain/generated/dynamic-lists.json, which holds only
 * the user's own entries and which the runtime layers over the shipped lists
 * (`layerUserDynamicLists` in config/index.ts).
 *
 * Every value a refresh adds or removes is reported for review
 * (`RefreshListsSummary.changes`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import chalk from 'chalk';
import { checkHelp, parseArgsStrict, type CommandSpec } from '../cli-help.js';
import { getPackageGeneratedDir, layerUserDynamicLists, loadConfig } from '../config/index.js';
import { getJobGeneratedDir, getUserGeneratedDir } from '../config/paths.js';
import type { MCPServerConfig } from '../config/types.js';
import { loadJob } from '../cron/job-store.js';
import { createJobId, JobNotFoundError } from '../cron/types.js';
import { applyServerAllowlist, getPersonaGeneratedDir, loadPersona } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import { parseArtifactJson, parseCompiledPolicyFile } from '../types/policy-schema.js';
import {
  diffListValues,
  formatListValueChanges,
  resolveList,
  revalidateResolvedList,
  type ListValueChange,
} from './list-resolver.js';
import {
  DYNAMIC_LISTS_FILENAME,
  listSourcesFromPolicy,
  ownListEntry,
  readDynamicListsArtifact,
  resolutionDefinitionOf,
} from './list-merge.js';
import {
  connectViaProxy,
  LIST_RESOLUTION_AUDIT_FILENAME,
  type MediatedMcpConnection,
} from './proxy-mcp-connections.js';
import { createPipelineLlm, loadPipelineConfig, writeArtifact, withSpinner } from './pipeline-shared.js';
import { serverArtifactDir } from './server-artifacts.js';
import type { CompiledPolicyFile, DynamicListsFile, ListDefinition, ResolvedList } from './types.js';

/** LLM interaction log of a refresh, next to the lists (kept apart from the compile's log). */
export const REFRESH_LISTS_LLM_LOG = 'llm-interactions-refresh-lists.jsonl';

// ---------------------------------------------------------------------------
// Targets and planning
// ---------------------------------------------------------------------------

/** The policy whose lists a refresh re-resolves. */
export type RefreshListsTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'persona'; readonly persona: string }
  | { readonly kind: 'job'; readonly jobId: string };

export interface RefreshListsOptions {
  readonly target: RefreshListsTarget;
  /** Refresh only this list (its name in the compiled policy). */
  readonly listName?: string;
  /** Resolve data-backed lists through their MCP servers. Without it they are skipped. */
  readonly withMcp: boolean;
}

/** A per-server copy (servers/<server>/dynamic-lists.json) a refresh writes through to. */
export interface PerServerCopy {
  /** The server's artifact directory in the policy dir. */
  readonly dir: string;
  /** Its current content (validated); the lists the refresh does not touch are kept. */
  readonly current: DynamicListsFile | undefined;
  /** The refreshed lists it receives: merged name -> the list's name in this server's artifacts. */
  readonly lists: ReadonlyMap<string, string>;
}

/** What a refresh will do, worked out before any LLM or MCP access. */
export interface RefreshPlan {
  /** Human-readable target, e.g. `persona "research"`. */
  readonly label: string;
  /** Directory the compiled policy was read from. */
  readonly policyDir: string;
  /** Directory the merged dynamic-lists.json is written to. */
  readonly outputDir: string;
  /** Whether the per-server copies next to the policy (servers/<server>/) are updated too. */
  readonly writeThrough: boolean;
  readonly compiledPolicy: CompiledPolicyFile;
  /** The lists as they are now (manual overrides, lists that are not refreshed). */
  readonly existingLists: DynamicListsFile | undefined;
  /**
   * The lists the policy runs with now, which the value changes are reported
   * against: `existingLists`, or for the shipped policy the user's file
   * layered over the shipped lists.
   */
  readonly baselineLists: DynamicListsFile | undefined;
  readonly definitions: readonly ListDefinition[];
  /** The lists to refresh. */
  readonly selected: readonly ListDefinition[];
  /** Data-backed lists left alone because the refresh has no MCP access. */
  readonly skipped: readonly string[];
  /** Per-server copies the refreshed lists are written through to (empty without write-through). */
  readonly perServerCopies: readonly PerServerCopy[];
  readonly withMcp: boolean;
  readonly mcpServers: Record<string, MCPServerConfig>;
  readonly protectedPaths: readonly string[];
  readonly toolAnnotationsDir: string;
  readonly toolAnnotationsFallbackDir: string;
}

/** What a refresh did. */
export interface RefreshListsSummary {
  readonly target: string;
  readonly policyDir: string;
  readonly outputDir: string;
  /** Lists re-resolved (names in the compiled policy). */
  readonly refreshed: readonly string[];
  /** Data-backed lists skipped for lack of MCP access. */
  readonly skipped: readonly string[];
  /** Per-server copies that were updated. */
  readonly perServerFiles: readonly string[];
  /** Every value the refresh added or removed, per list, for review. */
  readonly changes: readonly ListValueChange[];
  readonly llmLogPath?: string;
  readonly auditLogPath?: string;
}

type ResolvedTarget = Omit<
  RefreshPlan,
  'definitions' | 'selected' | 'skipped' | 'perServerCopies' | 'withMcp' | 'baselineLists'
> & {
  /** The shipped lists, for the shipped global policy only (see `baselineLists`). */
  readonly shippedLists?: DynamicListsFile;
};

/** Reads and validates `dir`/compiled-policy.json (src/types/policy-schema.ts). */
function readCompiledPolicy(dir: string, missingHint: string): CompiledPolicyFile {
  const path = resolve(dir, 'compiled-policy.json');
  if (!existsSync(path)) throw new Error(`${path} not found. ${missingHint}`);
  return parseCompiledPolicyFile(parseArtifactJson(readFileSync(path, 'utf-8'), 'compiled-policy', path), path);
}

function resolveGlobalTarget(): ResolvedTarget {
  const config = loadPipelineConfig();
  const userDir = config.generatedDir;
  const shared = {
    mcpServers: config.mcpServers,
    protectedPaths: config.protectedPaths,
    toolAnnotationsDir: userDir,
    toolAnnotationsFallbackDir: config.packageGeneratedDir,
  };

  // A locally compiled policy: its lists and per-server copies live with it.
  if (existsSync(resolve(userDir, 'compiled-policy.json'))) {
    return {
      ...shared,
      label: 'global policy',
      policyDir: userDir,
      outputDir: userDir,
      writeThrough: true,
      compiledPolicy: readCompiledPolicy(userDir, "Run 'ironcurtain compile-policy' first."),
      existingLists: readDynamicListsArtifact(userDir),
    };
  }

  // The policy shipped with the package: refreshed lists go to the user dir,
  // which the runtime layers over the shipped lists. That file holds only the
  // user's own entries (refreshed lists, overrides), never copies of shipped
  // ones, so a later package update of a list it does not hold still applies.
  const packageDir = config.packageGeneratedDir;
  return {
    ...shared,
    label: 'global policy (shipped with IronCurtain)',
    policyDir: packageDir,
    outputDir: userDir,
    writeThrough: false,
    compiledPolicy: readCompiledPolicy(packageDir, "Run 'ironcurtain compile-policy' first."),
    existingLists: readDynamicListsArtifact(userDir),
    shippedLists: readDynamicListsArtifact(packageDir),
  };
}

function resolvePersonaTarget(rawName: string): ResolvedTarget {
  const name = createPersonaName(rawName);
  const persona = loadPersona(name);
  const config = loadConfig();
  const dir = getPersonaGeneratedDir(name);
  return {
    label: `persona "${name}"`,
    policyDir: dir,
    outputDir: dir,
    writeThrough: true,
    compiledPolicy: readCompiledPolicy(dir, `Run: ironcurtain persona compile ${name}`),
    existingLists: readDynamicListsArtifact(dir),
    // The servers this persona may use, as for its compile.
    mcpServers: persona.servers ? applyServerAllowlist(config.mcpServers, persona.servers) : config.mcpServers,
    protectedPaths: config.protectedPaths,
    toolAnnotationsDir: getUserGeneratedDir(),
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
  };
}

function resolveJobTarget(rawJobId: string): ResolvedTarget {
  const jobId = createJobId(rawJobId);
  const job = loadJob(jobId);
  if (!job) throw new JobNotFoundError(jobId);
  // The same test the daemon uses to pick the policy a job runs under (executeJob).
  if (job.persona) {
    const persona = JSON.stringify(job.persona);
    throw new Error(
      `Job "${jobId}" runs under the policy of persona ${persona}, not its own. ` +
        `Refresh that one instead: ironcurtain refresh-lists --persona ${persona}`,
    );
  }
  const config = loadConfig();
  const dir = getJobGeneratedDir(jobId);
  return {
    label: `job "${jobId}"`,
    policyDir: dir,
    outputDir: dir,
    writeThrough: true,
    compiledPolicy: readCompiledPolicy(dir, `Run: ironcurtain daemon recompile-job ${jobId}`),
    existingLists: readDynamicListsArtifact(dir),
    mcpServers: config.mcpServers,
    protectedPaths: config.protectedPaths,
    toolAnnotationsDir: getUserGeneratedDir(),
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
  };
}

function resolveTarget(target: RefreshListsTarget): ResolvedTarget {
  switch (target.kind) {
    case 'global':
      return resolveGlobalTarget();
    case 'persona':
      return resolvePersonaTarget(target.persona);
    case 'job':
      return resolveJobTarget(target.jobId);
  }
}

/**
 * Selects the lists to refresh: the named one (an unknown name is an error),
 * else all. Without MCP access, data-backed lists are skipped.
 */
function selectLists(
  definitions: readonly ListDefinition[],
  listName: string | undefined,
  withMcp: boolean,
): { selected: ListDefinition[]; skipped: string[] } {
  let selected = [...definitions];
  if (listName !== undefined) {
    selected = selected.filter((d) => d.name === listName);
    if (selected.length === 0) {
      throw new Error(
        `List ${JSON.stringify(listName)} not found in the compiled policy. ` +
          `Available lists: ${definitions.map((d) => d.name).join(', ') || '(none)'}`,
      );
    }
  }
  if (withMcp) return { selected, skipped: [] };
  return {
    selected: selected.filter((d) => !d.requiresMcp),
    skipped: selected.filter((d) => d.requiresMcp).map((d) => d.name),
  };
}

/**
 * The per-server copies of every server whose rules use one of the `selected`
 * lists, with their current content read and validated now, before anything
 * is resolved: a malformed copy stops the refresh instead of being
 * overwritten after the lists were resolved.
 */
function planPerServerCopies(
  policyDir: string,
  compiledPolicy: CompiledPolicyFile,
  selected: readonly ListDefinition[],
): PerServerCopy[] {
  const sources = listSourcesFromPolicy(compiledPolicy);
  const byServer = new Map<string, Map<string, string>>();
  for (const definition of selected) {
    const source = sources.get(definition.name);
    if (!source) continue;
    for (const server of source.servers) {
      let lists = byServer.get(server);
      if (!lists) {
        lists = new Map();
        byServer.set(server, lists);
      }
      lists.set(definition.name, source.sourceName);
    }
  }

  const copies: PerServerCopy[] = [];
  for (const [server, lists] of byServer) {
    let dir: string;
    try {
      dir = serverArtifactDir(policyDir, server);
    } catch {
      continue; // a name that cannot be a directory has no per-server copies
    }
    // Only servers compiled into this policy dir have copies to keep in step.
    if (!existsSync(dir)) continue;
    copies.push({ dir, current: readDynamicListsArtifact(dir), lists });
  }
  return copies;
}

/**
 * Works out what a refresh will do: loads and validates the target's
 * compiled policy, its current lists and the per-server copies the refresh
 * writes through to, and selects the lists to refresh. Throws on an unknown
 * target, a missing or malformed file or an unknown list name; touches
 * nothing.
 */
export function planRefresh(options: RefreshListsOptions): RefreshPlan {
  const { shippedLists, ...target } = resolveTarget(options.target);
  const definitions = target.compiledPolicy.listDefinitions ?? [];
  const { selected, skipped } = selectLists(definitions, options.listName, options.withMcp);
  const perServerCopies = target.writeThrough
    ? planPerServerCopies(target.policyDir, target.compiledPolicy, selected)
    : [];
  const baselineLists =
    shippedLists && target.existingLists
      ? layerUserDynamicLists(shippedLists, target.existingLists).lists
      : (target.existingLists ?? shippedLists);
  return { ...target, baselineLists, definitions, selected, skipped, perServerCopies, withMcp: options.withMcp };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Writes refreshed values (resolver output only: overrides live in the merged file) to the per-server copies. */
function writePerServerCopies(
  copies: readonly PerServerCopy[],
  refreshed: ReadonlyMap<string, ResolvedList>,
): string[] {
  const written: string[] = [];
  for (const copy of copies) {
    const lists = new Map(Object.entries(copy.current?.lists ?? {}));
    for (const [mergedName, sourceName] of copy.lists) {
      const entry = refreshed.get(mergedName);
      if (entry) lists.set(sourceName, { ...entry, manualAdditions: [], manualRemovals: [] });
    }
    writeArtifact(copy.dir, DYNAMIC_LISTS_FILENAME, {
      generatedAt: new Date().toISOString(),
      lists: Object.fromEntries(lists),
    });
    written.push(resolve(copy.dir, DYNAMIC_LISTS_FILENAME));
  }
  return written;
}

/**
 * The dynamic-lists.json a refresh writes: the refreshed lists, plus every
 * other list of the existing file carried over. A carried-over list that the
 * policy still defines is re-validated against the current value rules (see
 * `revalidateResolvedList`), so rewriting the file never keeps a value that
 * today's rules refuse, such as a wildcard over a multi-tenant hosting
 * suffix cached under older rules. The refreshed entries are taken as they
 * are, so the caller attaches the user's overrides to them first.
 */
export function mergeRefreshedLists(
  existing: DynamicListsFile | undefined,
  refreshed: DynamicListsFile,
  definitions: readonly ListDefinition[],
): DynamicListsFile {
  const definitionsByName = new Map(definitions.map((d) => [d.name, d]));
  const lists: DynamicListsFile['lists'] = {};
  for (const [name, list] of Object.entries(existing?.lists ?? {})) {
    const definition = definitionsByName.get(name);
    lists[name] = definition && !Object.hasOwn(refreshed.lists, name) ? revalidateResolvedList(list, definition) : list;
  }
  // Refreshed lists replace the existing entries in place (or are appended).
  return { generatedAt: refreshed.generatedAt, lists: { ...lists, ...refreshed.lists } };
}

/** The refreshed entries of the merged file: refreshed values, the user's overrides from `existing` kept. */
function withUserOverrides(
  existing: DynamicListsFile | undefined,
  refreshed: ReadonlyMap<string, ResolvedList>,
): DynamicListsFile {
  const lists: DynamicListsFile['lists'] = {};
  for (const [name, entry] of refreshed) {
    const previous = ownListEntry(existing, name);
    lists[name] = {
      ...entry,
      manualAdditions: previous?.manualAdditions ?? [],
      manualRemovals: previous?.manualRemovals ?? [],
    };
  }
  return { generatedAt: new Date().toISOString(), lists };
}

export interface RefreshExecutionHooks {
  /** Transient progress text (the CLI spinner). */
  readonly onProgress?: (message: string) => void;
  /** TEST-ONLY: the resolver model. Production callers omit it (the configured policy model is used). */
  readonly model?: LanguageModel;
}

/**
 * Runs a planned refresh: resolves the selected lists, then writes the
 * per-server copies and the merged dynamic-lists.json. Nothing is written
 * unless every selected list resolved.
 */
export async function executeRefresh(
  plan: RefreshPlan,
  hooks: RefreshExecutionHooks = {},
): Promise<RefreshListsSummary> {
  const base = {
    target: plan.label,
    policyDir: plan.policyDir,
    outputDir: plan.outputDir,
    skipped: plan.skipped,
  };
  if (plan.selected.length === 0) return { ...base, refreshed: [], perServerFiles: [], changes: [] };

  let model: LanguageModel;
  let llmLogPath: string | undefined;
  if (hooks.model) {
    model = hooks.model;
  } else {
    const llm = await createPipelineLlm(plan.outputDir, 'refresh-lists', REFRESH_LISTS_LLM_LOG);
    model = llm.model;
    llmLogPath = llm.logPath;
  }

  // Each list is resolved under its name in its servers' own artifacts, so
  // the per-server copies get an entry their cache recognizes.
  const resolutionDefinitions = plan.selected.map(resolutionDefinitionOf);

  // Connect the MCP servers the data-backed lists name. Every resolver tool
  // call is mediated by the security kernel under the read-only policy and
  // audited next to the lists.
  const needsMcp = plan.withMcp && resolutionDefinitions.some((d) => d.requiresMcp);
  const auditLogPath = needsMcp ? resolve(plan.outputDir, LIST_RESOLUTION_AUDIT_FILENAME) : undefined;
  let mcpConnection: MediatedMcpConnection | undefined;
  if (auditLogPath !== undefined) {
    mcpConnection = await connectViaProxy(resolutionDefinitions, {
      mcpServers: plan.mcpServers,
      toolAnnotationsDir: plan.toolAnnotationsDir,
      toolAnnotationsFallbackDir: plan.toolAnnotationsFallbackDir,
      protectedPaths: plan.protectedPaths,
      auditLogPath,
    });
  }

  try {
    const refreshed = new Map<string, ResolvedList>();
    for (const [index, definition] of plan.selected.entries()) {
      // No existing entry is passed: the user's overrides never reach the
      // resolver output (withUserOverrides re-attaches them).
      const entry = await resolveList(resolutionDefinitions[index], { model, mcpConnection }, undefined, (message) =>
        hooks.onProgress?.(`@${definition.name}: ${message}`),
      );
      refreshed.set(definition.name, entry);
    }

    const perServerFiles = writePerServerCopies(plan.perServerCopies, refreshed);
    const merged = mergeRefreshedLists(
      plan.existingLists,
      withUserOverrides(plan.existingLists, refreshed),
      plan.definitions,
    );
    writeArtifact(plan.outputDir, DYNAMIC_LISTS_FILENAME, merged);
    return {
      ...base,
      refreshed: [...refreshed.keys()],
      perServerFiles,
      changes: diffListValues(plan.baselineLists, merged),
      ...(llmLogPath !== undefined ? { llmLogPath } : {}),
      ...(auditLogPath !== undefined ? { auditLogPath } : {}),
    };
  } finally {
    if (mcpConnection) {
      await mcpConnection.shutdown();
    }
  }
}

/**
 * Plans and runs a refresh without any terminal output. Used by the daemon
 * (control-socket `refresh-lists`).
 */
export async function refreshDynamicLists(
  options: RefreshListsOptions,
  hooks: RefreshExecutionHooks = {},
): Promise<RefreshListsSummary> {
  return executeRefresh(planRefresh(options), hooks);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const refreshListsSpec: CommandSpec = {
  name: 'ironcurtain refresh-lists',
  description: 'Re-resolve dynamic lists without full recompilation',
  usage: ['ironcurtain refresh-lists [options]'],
  options: [
    { flag: 'list', description: 'Refresh only the named list', placeholder: '<name>' },
    { flag: 'persona', description: "Refresh a persona's lists instead of the global policy's", placeholder: '<name>' },
    { flag: 'job', description: "Refresh a cron job's lists instead of the global policy's", placeholder: '<id>' },
    {
      flag: 'with-mcp',
      description: 'Connect to MCP servers for data-backed lists (default; kept for backward compatibility)',
    },
    { flag: 'no-mcp', description: 'Skip MCP server connections' },
    { flag: 'help', short: 'h', description: 'Show this help' },
  ],
  examples: [
    'ironcurtain refresh-lists                      # Refresh all lists (including MCP-backed)',
    'ironcurtain refresh-lists --list major-news    # Refresh a single list',
    'ironcurtain refresh-lists --persona research   # Refresh a persona policy',
    'ironcurtain refresh-lists --job daily-digest   # Refresh a cron job policy',
    'ironcurtain refresh-lists --no-mcp             # Skip MCP-backed lists',
  ],
};

/** Parses the CLI flags. Returns null when nothing is to be done (help, or an error already reported). */
export function parseRefreshArgs(args: string[]): RefreshListsOptions | null {
  const { values } = parseArgsStrict(
    {
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        list: { type: 'string' },
        persona: { type: 'string' },
        job: { type: 'string' },
        'with-mcp': { type: 'boolean' },
        'no-mcp': { type: 'boolean' },
      },
      allowPositionals: true,
    },
    refreshListsSpec.name,
  );

  if (checkHelp(values, refreshListsSpec)) return null;

  const persona = values.persona as string | undefined;
  const job = values.job as string | undefined;
  if (persona !== undefined && job !== undefined) {
    process.stderr.write('--persona and --job cannot be combined.\n');
    process.stderr.write(`Run \`${refreshListsSpec.name} --help\` for usage.\n`);
    process.exitCode = 1;
    return null;
  }

  const target: RefreshListsTarget =
    persona !== undefined
      ? { kind: 'persona', persona }
      : job !== undefined
        ? { kind: 'job', jobId: job }
        : { kind: 'global' };
  return {
    target,
    listName: values.list as string | undefined,
    withMcp: values['no-mcp'] ? false : true,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(args: string[] = [], hooks: RefreshExecutionHooks = {}): Promise<void> {
  const options = parseRefreshArgs(args);
  if (!options) return;

  let plan: RefreshPlan;
  try {
    plan = planRefresh(options);
  } catch (err) {
    console.error(chalk.red.bold(`Error: ${errorMessage(err)}`));
    process.exitCode = 1;
    return;
  }

  if (plan.definitions.length === 0) {
    console.error(
      chalk.yellow(`No dynamic lists defined in the compiled policy of the ${plan.label}. Nothing to refresh.`),
    );
    return;
  }

  console.error(chalk.bold('Dynamic List Refresh'));
  console.error(chalk.bold('===================='));
  console.error(`Policy:        ${chalk.dim(plan.label)}`);
  console.error(`Lists defined: ${chalk.dim(String(plan.definitions.length))}`);
  console.error(`Output:        ${chalk.dim(plan.outputDir + '/')}`);
  console.error('');
  for (const name of plan.skipped) {
    console.error(`  ${chalk.yellow('Skipping:')} @${name} (requires MCP — omit --no-mcp to include)`);
  }
  if (plan.selected.length === 0) {
    console.error(chalk.yellow('No eligible lists to refresh.'));
    return;
  }

  const stepText = 'Refreshing dynamic lists';
  let summary: RefreshListsSummary;
  try {
    ({ result: summary } = await withSpinner(
      stepText,
      async (spinner) =>
        executeRefresh(plan, {
          ...hooks,
          onProgress: (message) => {
            spinner.text = `${stepText} — ${message}`;
          },
        }),
      (result, elapsed) => `${stepText}: ${result.refreshed.length} list(s) refreshed (${elapsed.toFixed(1)}s)`,
    ));
  } catch (err) {
    console.error(chalk.red.bold(`List refresh failed: ${errorMessage(err)}`));
    process.exitCode = 1;
    return;
  }

  // Show every value the refresh added or removed, for review.
  console.error('');
  if (summary.changes.length === 0) {
    console.error('  No list values changed.');
  } else {
    console.error('  List value changes:');
    for (const line of formatListValueChanges(summary.changes)) console.error(line);
  }

  console.error('');
  console.error(`  Lists refreshed: ${summary.refreshed.length}`);
  console.error(`  Artifact written to: ${chalk.dim(resolve(summary.outputDir, DYNAMIC_LISTS_FILENAME))}`);
  for (const file of summary.perServerFiles) {
    console.error(`  Per-server copy updated: ${chalk.dim(file)}`);
  }
  if (summary.llmLogPath) {
    console.error(`  LLM interaction log: ${chalk.dim(summary.llmLogPath)}`);
  }
  if (summary.auditLogPath) {
    console.error(`  MCP tool-call audit: ${chalk.dim(summary.auditLogPath)}`);
  }
  console.error('');
  console.error(chalk.green.bold('List refresh successful!'));
}

// Only run when executed directly (not when imported by cli.ts or tests).
// Credentials come from the trusted env files only, never from <cwd>/.env.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bootstrapTrustedEnvForProcess } = await import('../config/trusted-env.js');
  bootstrapTrustedEnvForProcess();
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(chalk.red.bold('List refresh failed:'), err);
    process.exit(1);
  });
}
