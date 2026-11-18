/**
 * CLI entry point for `ironcurtain mcp`: the MCP servers a user configures
 * in `$IRONCURTAIN_HOME/mcp-servers.json`, layered over the built-in servers
 * shipped with IronCurtain (see `config/mcp-servers-overlay.ts`).
 *
 *   mcp list            every configured server: built-in, built-in with the
 *                       user's adjustments, or the user's own; its sandbox,
 *                       whether its tools are annotated and how many rules
 *                       the active policy has for it.
 *   mcp add <name> ...  adds a server: validates the definition and writes
 *                       it, asks for the credentials it declares, annotates
 *                       its tools (`annotate-tools --server <name>`), shows
 *                       the annotations and the argument roles available to
 *                       the server, offers `customize-policy`, compiles and
 *                       verifies the server's rules on their own
 *                       (`compile-policy --server <name>`, which writes only
 *                       `generated/servers/<name>/`), and offers to rebuild
 *                       the merged policy so sessions can use the server.
 *   mcp remove <name>   removes a server the user added (its definition, its
 *                       annotations, its compile cache and its rules in the
 *                       merged policy and in persona and job policies), the
 *                       user's adjustment of a built-in, or an entry that
 *                       fails validation (a hand edit).
 *
 * A server name can be reused: a server added after another of the same
 * name was removed must not inherit the rules compiled for the old one, so
 * `add` and `remove` both drop the name's rules from every compiled policy
 * that sessions load (the merged one, and each persona's and job's), and its
 * scenarios from the test scenarios stored beside each, whose recorded
 * decisions `ironcurtain doctor` replays against the policy. A policy is
 * read the way sessions read it (`readCompiledPolicyFile`), so one they
 * refuse (a symlink, a file another user owns or can write) is reported,
 * never narrowed and written back as a file they would accept.
 *
 * Nothing here writes into the installed package. Offline tooling like the
 * pipeline commands it drives: live session code never imports it.
 */

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, type Dirent } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import chalk from 'chalk';

import { checkHelp, printHelp, type CommandSpec } from '../cli-help.js';
import { getPackageGeneratedDir, loadPersonaPolicyArtifacts, readCompiledPolicyFile } from '../config/index.js';
import {
  collectDeclaredEnvVars,
  isContainerCommand,
  loadBuiltinMcpServers,
  loadMcpServers,
  removeUserMcpServerEntry,
  updateUserMcpServers,
  userServerNameProblem,
  validateUserServerDefinition,
  type LoadedMcpServers,
} from '../config/mcp-servers-overlay.js';
import { getJobsDir, getUserConfigPath, getUserGeneratedDir } from '../config/paths.js';
import { loadToolAnnotations } from '../config/tool-annotations-overlay.js';
import type { MCPServerConfig } from '../config/types.js';
import { loadUserConfig, saveUserConfig } from '../config/user-config.js';
import {
  annotateServers,
  annotationFilesDamagedHint,
  isAnnotateServerUnavailable,
  readAnnotationInputs,
  type AnnotationInputs,
} from '../pipeline/annotate.js';
import { resetToolAnnotationsOverlay } from '../pipeline/annotation-overlay.js';
import { runCompilePolicy } from '../pipeline/compile.js';
import { loadPipelineConfig, writeArtifact, type PipelineLlm } from '../pipeline/pipeline-shared.js';
import { loadVerifiedServerArtifacts, serverArtifactDir } from '../pipeline/server-artifacts.js';
import type {
  ArgumentRoleSpec,
  CompiledPolicyFile,
  CompiledRule,
  RoleCondition,
  StoredToolAnnotation,
} from '../pipeline/types.js';
import { getPersonasDir } from '../persona/resolve.js';
import { getPersonaTrashDir, listPersonaTrash, type PersonaTrashEntry } from '../persona/persona-trash.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { ironcurtainSubprocessEnv, passthroughEnvNames } from '../trusted-process/child-env.js';
import { ARGUMENT_ROLE_REGISTRY, getRolesForServer } from '../types/argument-roles.js';
import { isObjectWithProp, isPlainObject } from '../utils/is-plain-object.js';

const COMPILED_POLICY_FILE = 'compiled-policy.json';

/** The test scenarios a compile stores beside its policy, with the decisions recorded for doctor's replay. */
const TEST_SCENARIOS_FILE = 'test-scenarios.json';

/**
 * Code of the error {@link readCompiledPolicy} throws for a compiled policy
 * it cannot read the way sessions read it (sessions refuse such a policy).
 */
const POLICY_UNREADABLE = 'MCP_POLICY_UNREADABLE';

/**
 * Errors this command reports as one message and exit status 1 (each is
 * already a complete, field-level explanation): the server configuration,
 * a policy artifact or the annotations file is invalid, the merged policy
 * cannot be read the way sessions read it, a lock is held, the server
 * already exists, or a persona's or job's policy that names the server
 * could not be rewritten.
 */
const REPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'MCP_SERVERS_INVALID',
  'POLICY_ARTIFACT_INVALID',
  POLICY_UNREADABLE,
  'TOOL_ANNOTATIONS_INVALID',
  'FILE_LOCK_TIMEOUT',
  'MCP_SERVER_EXISTS',
  'MCP_SCOPED_POLICY_UNWRITABLE',
]);

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const mcpSpec: CommandSpec = {
  name: 'ironcurtain mcp',
  description: 'Manage the MCP servers in ~/.ironcurtain/mcp-servers.json',
  usage: ['ironcurtain mcp <action> [options]'],
  subcommands: [
    { name: 'list', description: 'List the configured servers, their sandbox, annotations and rules' },
    { name: 'add <name> ...', description: 'Add a server, annotate its tools and compile its policy' },
    { name: 'remove <name>', description: 'Remove a server you added (or your adjustment of a built-in)' },
  ],
  examples: [
    'ironcurtain mcp list',
    'ironcurtain mcp add notes --command /opt/notes-mcp/bin/server --allow-domain api.notes.example',
    'ironcurtain mcp add slack --env SLACK_BOT_TOKEN --allow-domain slack.com -- npx -y @scope/slack-mcp@1.2.3',
    'ironcurtain mcp remove notes',
  ],
};

const addSpec: CommandSpec = {
  name: 'ironcurtain mcp add',
  description: 'Add an MCP server to ~/.ironcurtain/mcp-servers.json, annotate its tools and compile its policy',
  usage: [
    'ironcurtain mcp add <name> --command <program> [--arg <value>]... [options]',
    'ironcurtain mcp add <name> [options] -- <program> [args...]',
  ],
  options: [
    { flag: 'command', placeholder: '<program>', description: 'Absolute path, or a program name found on PATH' },
    {
      flag: 'arg',
      placeholder: '<value>',
      description: 'One argument (repeatable; write --arg=-x for a value starting with "-", or put arguments after --)',
    },
    {
      flag: 'env',
      placeholder: '<NAME[=value]>',
      description:
        'NAME=value sets a variable; NAME declares a credential the server reads, asked for and stored in ' +
        'config.json (docker/podman: "-e NAME" is added after "run")',
    },
    {
      flag: 'sandbox',
      placeholder: '<default|none>',
      description: 'default: OS sandbox, no network unless --allow-domain; none: no OS sandbox (e.g. docker)',
    },
    {
      flag: 'allow-domain',
      placeholder: '<pattern>',
      description: 'Let the sandboxed server reach this domain (repeatable; example.com, *.example.com)',
    },
    { flag: 'description', placeholder: '<text>', description: 'One-line description of the server' },
    { flag: 'no-annotate', description: 'Only write the definition (no annotation, no compile)' },
    { flag: 'no-compile', description: 'Write and annotate, but do not compile the policy' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain mcp add notes --command /opt/notes-mcp/bin/server --arg=--read-only',
    'ironcurtain mcp add slack --env SLACK_BOT_TOKEN --allow-domain slack.com -- npx -y @scope/slack-mcp@1.2.3',
    'ironcurtain mcp add notion --sandbox none --env NOTION_TOKEN -- docker run -i --rm mcp/notion@sha256:<digest>',
  ],
};

const removeSpec: CommandSpec = {
  name: 'ironcurtain mcp remove',
  description: 'Remove a server you added, or your adjustment of a built-in server',
  usage: ['ironcurtain mcp remove <name> [--yes]'],
  options: [
    { flag: 'yes', short: 'y', description: 'Do not ask for confirmation (required without a terminal)' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
};

const listSpec: CommandSpec = {
  name: 'ironcurtain mcp list',
  description: 'List the configured MCP servers',
  usage: ['ironcurtain mcp list'],
  options: [{ flag: 'help', short: 'h', description: 'Show this help message' }],
};

// ---------------------------------------------------------------------------
// Dependencies (test seams)
// ---------------------------------------------------------------------------

/** The questions `mcp add` and `mcp remove` ask. */
export interface McpPrompts {
  /** Yes/no question; cancelling answers no. */
  confirm(message: string, initialValue: boolean): Promise<boolean>;
  /** Hidden input; undefined when cancelled or left empty. */
  secret(message: string): Promise<string | undefined>;
}

export interface McpCommandDeps {
  /** Whether questions may be asked (default: stdin and stderr are terminals). */
  readonly interactive?: boolean;
  readonly prompts?: McpPrompts;
  /** Creates the annotation LLM (default: the configured policy model). */
  readonly createAnnotationLlm?: (generatedDir: string) => Promise<PipelineLlm>;
  /** Runs compile-policy with these arguments and returns its exit status (default: in process). */
  readonly compilePolicy?: (argv: string[]) => Promise<number>;
  /** Runs `ironcurtain customize-policy` on this terminal (default: as a child process). */
  readonly customizePolicy?: () => Promise<void>;
  /** Progress and report lines (default: stderr). */
  readonly log?: (line: string) => void;
  /** `mcp list` output (default: stdout). */
  readonly out?: (line: string) => void;
}

interface ResolvedDeps {
  readonly interactive: boolean;
  readonly prompts: McpPrompts;
  readonly createAnnotationLlm?: (generatedDir: string) => Promise<PipelineLlm>;
  readonly compilePolicy: (argv: string[]) => Promise<number>;
  readonly customizePolicy: () => Promise<void>;
  readonly log: (line: string) => void;
  readonly out: (line: string) => void;
}

const clackPrompts: McpPrompts = {
  async confirm(message, initialValue) {
    const answer = await p.confirm({ message, initialValue });
    return !p.isCancel(answer) && answer;
  },
  async secret(message) {
    const answer = await p.password({ message });
    if (p.isCancel(answer) || answer === '') return undefined;
    return answer;
  },
};

function resolveDeps(deps: McpCommandDeps): ResolvedDeps {
  return {
    interactive: deps.interactive ?? (process.stdin.isTTY && process.stderr.isTTY),
    prompts: deps.prompts ?? clackPrompts,
    createAnnotationLlm: deps.createAnnotationLlm,
    compilePolicy: deps.compilePolicy ?? ((argv) => runCompilePolicy(argv)),
    customizePolicy: deps.customizePolicy ?? runCustomizePolicyChild,
    log:
      deps.log ??
      ((line) => {
        console.error(line);
      }),
    out:
      deps.out ??
      ((line) => {
        process.stdout.write(`${line}\n`);
      }),
  };
}

/**
 * Runs `ironcurtain customize-policy` as a child on this terminal, the way
 * the user would start it, so its own prompts, cancel handling and exit
 * status stay its own. `process.execArgv` carries a loader (`tsx`) into the
 * child when IronCurtain runs from source. Argument array, no shell.
 */
async function runCustomizePolicyChild(): Promise<void> {
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('cannot locate the ironcurtain entry point; run `ironcurtain customize-policy`');
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, cliEntry, 'customize-policy'], {
      stdio: 'inherit',
      env: ironcurtainSubprocessEnv(process.env),
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`customize-policy ended with ${signal ?? `status ${String(code)}`}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Runs `ironcurtain mcp <args>` and returns the exit status. */
export async function runMcpCommand(args: string[], deps: McpCommandDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);
  const action = args.at(0);
  const rest = args.slice(1);
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') {
    printHelp(mcpSpec);
    return action === undefined ? 1 : 0;
  }
  try {
    switch (action) {
      case 'list':
        return runList(rest, resolved);
      case 'add':
        return await runAdd(rest, resolved);
      case 'remove':
        return await runRemove(rest, resolved);
      default:
        resolved.log(chalk.red(`Unknown action: ${toDisplayText(action)}`));
        printHelp(mcpSpec);
        return 1;
    }
  } catch (err) {
    if (isObjectWithProp(err, 'code') && typeof err.code === 'string' && REPORTED_ERROR_CODES.has(err.code)) {
      resolved.log(chalk.red(toDisplayText(errorMessage(err), { multiline: true })));
      return 1;
    }
    throw err;
  }
}

/** CLI entry (`ironcurtain mcp ...`): sets the exit status instead of exiting, so piped output is flushed. */
export async function main(args: string[]): Promise<void> {
  const code = await runMcpCommand(args);
  if (code !== 0) process.exitCode = code;
}

/** Parses `--help` / `--yes` style flags and positionals; a usage error is reported and returns undefined. */
function parseSimpleArgs(
  args: string[],
  spec: CommandSpec,
  withYes: boolean,
  log: (line: string) => void,
): { readonly positionals: string[]; readonly help: boolean; readonly yes: boolean } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        ...(withYes ? { yes: { type: 'boolean' as const, short: 'y' } } : {}),
      },
      allowPositionals: true,
      strict: true,
    });
    return { positionals, help: values.help === true, yes: values.yes === true };
  } catch (err) {
    log(chalk.red(errorMessage(err)));
    log(`Run \`${spec.name} --help\` for usage.`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// mcp list
// ---------------------------------------------------------------------------

/** One row of `mcp list`. */
export interface McpServerListEntry {
  readonly name: string;
  readonly source: 'built-in' | 'built-in, adjusted' | 'yours';
  /** The command line (display text). */
  readonly command: string;
  /** How the server is contained (display text). */
  readonly sandbox: string;
  /** Tools annotated for it, or undefined when it has no annotations. */
  readonly annotatedTools: number | undefined;
  /** Rules for it in the active merged policy (undefined when that policy could not be read). */
  readonly policyRules: number | undefined;
}

/**
 * The rows of `mcp list`, plus notes about anything that could not be read
 * (the annotations or the policy). Throws `MCP_SERVERS_INVALID` when the
 * server configuration itself is invalid.
 */
export function listMcpServers(): {
  readonly loaded: LoadedMcpServers;
  readonly entries: McpServerListEntry[];
  readonly notes: string[];
} {
  const loaded = loadMcpServers();
  const notes: string[] = [];

  let annotatedTools: ReadonlyMap<string, number> = new Map();
  try {
    const annotations = loadToolAnnotations(getUserGeneratedDir(), getPackageGeneratedDir())?.annotations;
    annotatedTools = new Map(
      Object.entries(annotations?.servers ?? {}).map(([name, server]) => [name, server.tools.length]),
    );
  } catch (err) {
    notes.push(`Tool annotations could not be read: ${errorMessage(err)}`);
  }

  let rulesByServer: ReadonlyMap<string, number> | undefined;
  try {
    rulesByServer = countRulesByServer(readActivePolicy());
  } catch (err) {
    notes.push(`The compiled policy could not be read: ${errorMessage(err)}`);
  }

  const adjusted = new Set(loaded.adjustments.map((adjustment) => adjustment.server));
  const builtins = new Set(loaded.builtinServers);
  const entries = Object.entries(loaded.servers).map(([name, config]): McpServerListEntry => ({
    name,
    source: builtins.has(name) ? (adjusted.has(name) ? 'built-in, adjusted' : 'built-in') : 'yours',
    command: formatCommandLine(config),
    sandbox: describeSandbox(config),
    annotatedTools: annotatedTools.get(name),
    policyRules: rulesByServer ? (rulesByServer.get(name) ?? 0) : undefined,
  }));
  return { loaded, entries, notes };
}

function runList(args: string[], deps: ResolvedDeps): number {
  const parsed = parseSimpleArgs(args, listSpec, false, deps.log);
  if (!parsed) return 1;
  if (checkHelp(parsed, listSpec)) return 0;
  if (parsed.positionals.length > 0) {
    deps.log(chalk.red('Usage: ironcurtain mcp list'));
    return 1;
  }
  const { loaded, entries, notes } = listMcpServers();
  const rows = entries.map((entry) => [
    toDisplayText(entry.name),
    entry.source,
    entry.sandbox,
    entry.annotatedTools === undefined ? 'not annotated' : `${entry.annotatedTools} tools`,
    entry.policyRules === undefined ? '?' : entry.policyRules === 0 ? 'no rules' : `${entry.policyRules} rules`,
  ]);
  for (const line of formatTable([['NAME', 'SOURCE', 'SANDBOX', 'ANNOTATIONS', 'POLICY'], ...rows])) deps.out(line);
  const own = entries.filter((entry) => entry.source === 'yours');
  if (own.length > 0) {
    deps.out('');
    for (const entry of own) deps.out(`${toDisplayText(entry.name)}: ${entry.command}`);
  }
  deps.out('');
  deps.out(`Built-in servers: ${toDisplayText(loaded.packagePath)}`);
  deps.out(`Your servers:     ${toDisplayText(loaded.userPath)}${loaded.userFileExists ? '' : ' (not created yet)'}`);
  for (const adjustment of loaded.adjustments) {
    const parts = [
      ...(adjustment.env.length > 0 ? [`env ${adjustment.env.join(', ')}`] : []),
      ...(adjustment.allowedDomains ? [`allowedDomains [${adjustment.allowedDomains.join(', ')}]`] : []),
      ...(adjustment.deniedDomains ? [`deniedDomains [${adjustment.deniedDomains.join(', ')}]`] : []),
    ];
    deps.out(toDisplayText(`Adjusted: ${adjustment.server}: ${parts.join('; ')}`));
  }
  for (const note of notes) deps.out(toDisplayText(`Note: ${note}`, { maxLength: 400 }));
  return 0;
}

function formatTable(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd(),
  );
}

/** The command line of a server, display-safe and bounded. */
function formatCommandLine(config: MCPServerConfig): string {
  const words = [config.command, ...config.args].map((word) =>
    /^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word),
  );
  return toDisplayText(words.join(' '), { maxLength: 160 });
}

/** How a server is contained, in a few words. */
export function describeSandbox(config: MCPServerConfig): string {
  if (config.sandbox === false) return 'none';
  const network = config.sandbox?.network;
  const confined = config.sandbox?.filesystem?.confineToRoots === true ? ', roots only' : '';
  if (!network) return `os, no network${confined}`;
  const count = network.allowedDomains.length;
  return `os, ${count} domain${count === 1 ? '' : 's'}${confined}`;
}

// ---------------------------------------------------------------------------
// mcp add
// ---------------------------------------------------------------------------

/** What `mcp add` was asked to add. */
export interface McpAddRequest {
  readonly name: string;
  readonly definition: MCPServerConfig;
  /** Whether to annotate and compile (`--no-annotate` / `--no-compile`). */
  readonly annotate: boolean;
  readonly compile: boolean;
}

export type ParsedAddArgs =
  | { readonly kind: 'request'; readonly request: McpAddRequest }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly problems: readonly string[] };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Turns the `mcp add` arguments into a server definition (nothing is
 * written here). The definition is checked against the full schema later.
 */
export function parseAddArgs(argv: string[]): ParsedAddArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        command: { type: 'string' },
        arg: { type: 'string', multiple: true },
        env: { type: 'string', multiple: true },
        sandbox: { type: 'string' },
        'allow-domain': { type: 'string', multiple: true },
        description: { type: 'string' },
        'no-annotate': { type: 'boolean' },
        'no-compile': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (err) {
    return { kind: 'error', problems: [errorMessage(err)] };
  }
  const { values, tokens } = parsed;
  if (values.help === true) return { kind: 'help' };

  // Positionals before `--` name the server; after it, the program and its arguments.
  const named: string[] = [];
  const trailing: string[] = [];
  let afterTerminator = false;
  for (const token of tokens) {
    if (token.kind === 'option-terminator') afterTerminator = true;
    else if (token.kind === 'positional') (afterTerminator ? trailing : named).push(token.value);
  }

  const problems: string[] = [];
  if (named.length !== 1) problems.push('give exactly one server name: ironcurtain mcp add <name> ...');

  const serverArgs: string[] = [...(values.arg ?? [])];
  let command = values.command;
  if (command === undefined) {
    command = trailing.at(0);
    serverArgs.push(...trailing.slice(1));
  } else {
    serverArgs.push(...trailing);
  }
  if (command === undefined || command === '') {
    problems.push('give the program to run: --command <program>, or -- <program> [args...]');
  }

  const sandboxMode = values.sandbox ?? 'default';
  if (sandboxMode !== 'default' && sandboxMode !== 'none') {
    problems.push(`--sandbox must be "default" or "none", got ${JSON.stringify(sandboxMode)}`);
  }
  const allowedDomains = values['allow-domain'] ?? [];
  if (sandboxMode === 'none' && allowedDomains.length > 0) {
    problems.push('--allow-domain needs the OS sandbox; it cannot be combined with --sandbox none');
  }

  const env: Record<string, string> = {};
  const credentials: string[] = [];
  for (const spec of values.env ?? []) {
    const eq = spec.indexOf('=');
    const envName = eq < 0 ? spec : spec.slice(0, eq);
    if (!ENV_NAME.test(envName)) {
      problems.push(`--env ${JSON.stringify(spec)}: ${JSON.stringify(envName)} is not an environment variable name`);
    } else if (Object.hasOwn(env, envName) || credentials.includes(envName)) {
      problems.push(`--env ${envName} is given more than once`);
    } else if (eq < 0) {
      credentials.push(envName);
    } else {
      env[envName] = spec.slice(eq + 1);
    }
  }

  if (command !== undefined && command !== '') {
    for (const credential of credentials) {
      if (!isContainerCommand(command)) {
        // An empty value declares the slot: the value comes from serverCredentials.
        env[credential] = '';
      } else if (!passthroughEnvNames(serverArgs).includes(credential)) {
        // A container receives a host variable only through `-e NAME`.
        const run = serverArgs.indexOf('run');
        if (run < 0) {
          problems.push(
            `--env ${credential}: a ${command} server receives ${credential} only through "-e ${credential}" ` +
              'after "run", and no "run" argument was found',
          );
        } else {
          serverArgs.splice(run + 1, 0, '-e', credential);
        }
      }
    }
  }

  if (problems.length > 0 || command === undefined) return { kind: 'error', problems };
  const definition: MCPServerConfig = {
    ...(values.description !== undefined ? { description: values.description } : {}),
    command,
    args: serverArgs,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(sandboxMode === 'none'
      ? { sandbox: false as const }
      : allowedDomains.length > 0
        ? { sandbox: { network: { allowedDomains } } }
        : {}),
  };
  const annotate = values['no-annotate'] !== true;
  return {
    kind: 'request',
    request: { name: named[0], definition, annotate, compile: annotate && values['no-compile'] !== true },
  };
}

async function runAdd(args: string[], deps: ResolvedDeps): Promise<number> {
  const parsed = parseAddArgs(args);
  if (parsed.kind === 'help') {
    printHelp(addSpec);
    return 0;
  }
  if (parsed.kind === 'error') {
    for (const problem of parsed.problems) deps.log(chalk.red(`Error: ${toDisplayText(problem)}`));
    deps.log(`Run \`${addSpec.name} --help\` for usage.`);
    return 1;
  }
  const { request } = parsed;
  const { name, definition } = request;

  // Name and definition first: nothing is written for an invalid request.
  if (Object.hasOwn(loadBuiltinMcpServers(), name)) {
    deps.log(
      chalk.red(
        `Error: "${toDisplayText(name)}" is a built-in server; its command, arguments and sandbox cannot be ` +
          "replaced. Add your program under another name, or adjust the built-in's env or network allowlist " +
          'in ~/.ironcurtain/mcp-servers.json (see ADDING_MCP_SERVERS.md).',
      ),
    );
    return 1;
  }
  const validation = validateUserServerDefinition(name, definition);
  if (validation.problems.length > 0) {
    for (const problem of validation.problems) deps.log(chalk.red(`Error: ${toDisplayText(problem)}`));
    return 1;
  }

  const { loaded, result: stripped } = updateUserMcpServers((entries) => {
    if (Object.hasOwn(entries, name)) {
      throw Object.assign(
        new Error(
          `"${name}" is already in your mcp-servers.json; run \`ironcurtain mcp remove ${name}\` first to replace it.`,
        ),
        { code: 'MCP_SERVER_EXISTS' },
      );
    }
    // Rules an earlier server of this name left in the merged policy, or in
    // a persona's or a job's policy, would apply to this one's same-named
    // tools: drop them before it exists. Nothing is added while any of them
    // is left in place.
    let merged: number;
    try {
      merged = removeServerFromUserPolicy(name);
    } catch (err) {
      if (!isObjectWithProp(err, 'code') || err.code !== POLICY_UNREADABLE) throw err;
      throw Object.assign(
        new Error(
          `Cannot add "${name}": your merged policy cannot be checked for rules an earlier server of that name ` +
            `left (${errorMessage(err)}). Sessions refuse that policy too: delete it or rebuild it ` +
            '(`ironcurtain compile-policy`), then add the server again.',
          { cause: err },
        ),
        { code: POLICY_UNREADABLE },
      );
    }
    const scoped = removeServerFromScopedPolicies(name);
    if (scoped.unwritable.length > 0) {
      throw Object.assign(
        new Error(
          `Cannot add "${name}": the rules an earlier server of that name left in ` +
            `${scoped.unwritable.map((entry) => `${describeScopedPolicy(entry.dir)} (${entry.reason})`).join(', ')} ` +
            'could not be removed, and they would apply to the new server. Recompile or delete those policies, ' +
            'then add the server again.',
        ),
        { code: 'MCP_SCOPED_POLICY_UNWRITABLE' },
      );
    }
    entries[name] = definition;
    return { merged, scoped };
  });

  deps.log(chalk.bold(`Added MCP server "${toDisplayText(name)}" to ${toDisplayText(loaded.userPath)}`));
  deps.log(`  command: ${formatCommandLine(definition)}`);
  deps.log(`  sandbox: ${describeSandbox(definition)}`);
  if (definition.sandbox === false) {
    deps.log(
      chalk.yellow(
        '  It runs WITHOUT OS containment (--sandbox none): policy still mediates every tool call, but the ' +
          'process itself can reach anything your user account can.',
      ),
    );
  }
  if (stripped.merged > 0) {
    deps.log(
      chalk.yellow(
        `  Removed ${stripped.merged} rule(s) that an earlier server named "${toDisplayText(name)}" left in your ` +
          'merged policy.',
      ),
    );
  }
  if (stripped.scoped.stripped.length > 0) {
    deps.log(
      chalk.yellow(
        `  Removed ${countRules(stripped.scoped.stripped)} rule(s) that an earlier server named ` +
          `"${toDisplayText(name)}" left in ${describeScopedPolicies(stripped.scoped.stripped)}. Recompile them ` +
          'to let them use this server.',
      ),
    );
  }
  reportUnreadableScopedPolicies(stripped.scoped.unreadable, deps);
  deps.log('');

  await collectCredentials(name, definition, deps);

  if (!request.annotate) {
    printNextSteps(name, ['annotate', 'compile', 'activate'], deps);
    return 0;
  }

  const tools = await annotateNewServer(name, deps);
  if (!tools) return 1;
  printAnnotations(name, tools, deps);

  if (deps.interactive) {
    const customize = await deps.prompts.confirm(
      `Describe what the agent may do with ${name} now (ironcurtain customize-policy)? ` +
        'Without guidance that mentions it, its tools are likely to stay denied.',
      true,
    );
    if (customize) {
      try {
        await deps.customizePolicy();
      } catch (err) {
        deps.log(chalk.yellow(`customize-policy did not finish: ${toDisplayText(errorMessage(err))}`));
      }
    }
  } else {
    deps.log(
      `To describe what the agent may do with ${toDisplayText(name)}, run \`ironcurtain customize-policy\` ` +
        'and compile again.',
    );
  }

  if (!request.compile) {
    printNextSteps(name, ['compile', 'activate'], deps);
    return 0;
  }
  return compileNewServer(name, deps);
}

/**
 * Asks for the credentials the new server declares and stores them in
 * config.json `serverCredentials.<name>` (never in mcp-servers.json). A
 * `-e NAME` variable already set in this environment is forwarded from it.
 */
async function collectCredentials(name: string, definition: MCPServerConfig, deps: ResolvedDeps): Promise<void> {
  const declared = collectDeclaredEnvVars(definition);
  if (declared.length === 0) return;
  const configPath = getUserConfigPath();
  const stored = loadUserConfig({ readOnly: true }).serverCredentials[name] ?? {};
  const forwarded = new Set(passthroughEnvNames(definition.args));
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const variable of declared) {
    if (stored[variable]) continue;
    if (forwarded.has(variable) && process.env[variable]) {
      deps.log(`  ${variable}: forwarded from your environment`);
      continue;
    }
    const value = deps.interactive
      ? await deps.prompts.secret(
          `${variable} for ${name} (stored in ${configPath} under serverCredentials; leave empty to skip)`,
        )
      : undefined;
    if (value === undefined) missing.push(variable);
    else values[variable] = value;
  }
  if (Object.keys(values).length > 0) {
    saveUserConfig({ serverCredentials: { [name]: values } });
    deps.log(`  Stored ${Object.keys(values).join(', ')} for ${toDisplayText(name)} in ${toDisplayText(configPath)}`);
  }
  if (missing.length > 0) {
    deps.log(
      chalk.yellow(
        `  Not set: ${missing.join(', ')}. Store them with \`ironcurtain config\` (Server credentials) ` +
          'before using the server; it may not start without them.',
      ),
    );
  }
  deps.log('');
}

/** Annotates the new server; returns its annotations, or undefined after reporting the failure. */
async function annotateNewServer(name: string, deps: ResolvedDeps): Promise<StoredToolAnnotation[] | undefined> {
  const config = loadPipelineConfig();
  let inputs: AnnotationInputs;
  try {
    inputs = readAnnotationInputs(config);
  } catch (err) {
    deps.log(chalk.red(`Error: ${toDisplayText(errorMessage(err), { multiline: true })}`));
    deps.log(annotationFilesDamagedHint(err, config.packageGeneratedDir));
    return undefined;
  }
  const definition = config.mcpServers[name];
  deps.log(
    chalk.dim(
      `Annotating ${name}: IronCurtain starts the server as a session would (inside the OS sandbox it asks for, ` +
        'with its stored credentials) to list its tools, then classifies their arguments with the policy model.',
    ),
  );
  let reason: string;
  try {
    const result = await annotateServers({
      config,
      servers: { [name]: definition },
      requiredServer: name,
      inputs,
      pin: false,
      all: false,
      createLlm: deps.createAnnotationLlm,
    });
    const failure = result.update.outcomes.find((o) => o.server === name && o.outcome === 'failed');
    if (failure === undefined) {
      const servers = result.effective?.servers ?? {};
      return Object.hasOwn(servers, name) ? servers[name].tools : [];
    }
    // annotate-tools records a server whose annotation failed and goes on
    // (it keeps whatever annotated the name before). Nothing annotated these
    // tools, so they are neither shown as the server's annotations nor
    // compiled.
    reason = failure.error ?? 'the annotation run failed';
  } catch (err) {
    reason = isAnnotateServerUnavailable(err)
      ? 'the server could not be started or did not list its tools'
      : errorMessage(err);
  }
  deps.log(chalk.red(`Error: annotating ${toDisplayText(name)} failed: ${toDisplayText(reason)}`));
  const declared = collectDeclaredEnvVars(definition);
  if (declared.length > 0) {
    deps.log(
      `If it needs ${declared.join(', ')} to start, store ${declared.length === 1 ? 'it' : 'them'} with ` +
        '`ironcurtain config` (Server credentials): the annotation run gives the server its stored credentials.',
    );
  }
  deps.log(
    `The server stays in your mcp-servers.json. Fix its definition (\`ironcurtain mcp remove ${name}\`, then ` +
      `add it again), then run \`ironcurtain annotate-tools --server ${name}\` and \`ironcurtain compile-policy\`.`,
  );
  return undefined;
}

/** Shows the annotations (they decide what policy sees) and the argument roles open to the server. */
function printAnnotations(name: string, tools: readonly StoredToolAnnotation[], deps: ResolvedDeps): void {
  deps.log('');
  deps.log(chalk.bold(`Tool annotations for ${toDisplayText(name)} (review them: policy evaluates these roles):`));
  if (tools.length === 0) deps.log('  (the server lists no tools)');
  for (const tool of tools) {
    deps.log(`  ${toDisplayText(tool.toolName)}: ${toDisplayText(tool.comment, { maxLength: 200 })}`);
    const args = Object.entries(tool.args);
    if (args.length === 0) deps.log('      (no arguments)');
    for (const [arg, spec] of args) deps.log(`      ${toDisplayText(arg)}: ${formatRoleSpec(spec)}`);
  }
  const usable = getRolesForServer(name).map(([role]) => role);
  const restricted = [...ARGUMENT_ROLE_REGISTRY].flatMap(([role, def]) =>
    def.serverNames && !def.serverNames.includes(name) ? [`${role} (${def.serverNames.join(', ')})`] : [],
  );
  deps.log('');
  deps.log(`Argument roles available to ${toDisplayText(name)}: ${usable.join(', ')}`);
  if (restricted.length > 0) {
    deps.log(
      chalk.dim(
        `Not available (src/types/argument-roles.ts restricts them to other servers): ${restricted.join(', ')}`,
      ),
    );
  }
  if (usable.every((role) => role === 'none')) {
    // Path, URL and identifier roles are limited to the built-in servers whose
    // semantics they describe, so nothing about these arguments is checked.
    deps.log(
      chalk.yellow(
        `Policy can allow, escalate or deny each of ${toDisplayText(name)}'s tools, but it inspects none of their ` +
          'arguments: no protected-path, sandbox or domain check applies to this server. Have tools that read or ' +
          'change files, or reach the network, escalated for approval (say so with customize-policy), and rely ' +
          "on the server's own sandbox for containment.",
      ),
    );
  } else {
    deps.log(
      chalk.dim(
        'An argument classified "none" is checked by no structural rule. Re-annotate with ' +
          `\`ironcurtain annotate-tools --server ${name}\`, or correct your tool-annotations.json and compile again.`,
      ),
    );
  }
  deps.log('');
}

function formatRoleSpec(spec: ArgumentRoleSpec): string {
  if (Array.isArray(spec)) return spec.join(', ');
  const branches = spec.when.map(
    (entry) =>
      `${entry.roles.join(', ')} when ${toDisplayText(entry.condition.arg)} ${describeCondition(entry.condition)}`,
  );
  return `${spec.default.join(', ')} (default); ${branches.join('; ')}`;
}

function describeCondition(condition: RoleCondition): string {
  if (condition.equals !== undefined) return `= ${toDisplayText(JSON.stringify(condition.equals))}`;
  if (condition.in !== undefined) return `in ${toDisplayText(JSON.stringify(condition.in))}`;
  return `is ${condition.is ?? '?'}`;
}

/**
 * Compiles and verifies the new server's rules on their own
 * (`compile-policy --server <name>`: only `generated/servers/<name>/` is
 * written, the merged policy is left alone), shows them, and offers to
 * rebuild the merged policy that sessions load.
 */
async function compileNewServer(name: string, deps: ResolvedDeps): Promise<number> {
  deps.log(chalk.bold(`Compiling the policy for ${toDisplayText(name)} on its own (compile-policy --server ${name})`));
  let status: number;
  try {
    status = await deps.compilePolicy(['--server', name]);
  } catch (err) {
    deps.log(
      chalk.red(
        `Error: compiling ${toDisplayText(name)} failed: ${toDisplayText(errorMessage(err), { maxLength: 600 })}`,
      ),
    );
    deps.log(
      `Describe what the agent may do with it (\`ironcurtain customize-policy\`), then run ` +
        `\`ironcurtain compile-policy --server ${name}\`. Rejected rules are kept for inspection in ` +
        `generated/servers/${name}/.`,
    );
    return 1;
  }
  if (status !== 0) {
    deps.log(chalk.red(`compile-policy --server ${name} exited with status ${status}.`));
    return status;
  }

  const artifacts = loadVerifiedServerArtifacts(serverArtifactDir(getUserGeneratedDir(), name), name);
  const rules = artifacts?.policy.rules ?? [];
  deps.log('');
  deps.log(chalk.bold(`Verified rules for ${toDisplayText(name)}:`));
  if (rules.length === 0) {
    deps.log(
      chalk.yellow(
        `  none: every tool of ${toDisplayText(name)} is denied. Describe what the agent may do with it ` +
          '(`ironcurtain customize-policy`), then compile again.',
      ),
    );
  }
  for (const rule of rules) deps.log(`  ${formatRule(rule)}`);
  deps.log('');

  if (activeRuleCount(name) > 0) {
    deps.log(chalk.green(`${toDisplayText(name)} is in the active policy.`));
    return 0;
  }
  if (!deps.interactive || rules.length === 0) {
    printNextSteps(name, ['activate'], deps);
    return 0;
  }
  const rebuild = await deps.prompts.confirm(
    `Rebuild the merged policy now so sessions can use ${name}? (compile-policy: servers without a verified ` +
      'cached result are compiled again; on a first compile that is every server)',
    true,
  );
  if (!rebuild) {
    printNextSteps(name, ['activate'], deps);
    return 0;
  }
  let fullStatus: number;
  try {
    fullStatus = await deps.compilePolicy([]);
  } catch (err) {
    deps.log(chalk.red(`Error: compile-policy failed: ${toDisplayText(errorMessage(err), { maxLength: 600 })}`));
    return 1;
  }
  const active = activeRuleCount(name);
  if (active > 0) {
    deps.log(chalk.green(`${toDisplayText(name)} is in the active policy (${active} rule(s)).`));
  } else {
    deps.log(chalk.yellow(`The merged policy has no rules for ${toDisplayText(name)}: ${whyNoRules(name)}`));
    deps.log(
      chalk.yellow(
        'Describe what the agent may do with it (`ironcurtain customize-policy`), then run ' +
          '`ironcurtain compile-policy`.',
      ),
    );
  }
  return fullStatus;
}

/** Why the active merged policy has no rules for `name`, from its skipped and failed records. */
function whyNoRules(name: string): string {
  let policy: CompiledPolicyFile;
  try {
    policy = readActivePolicy();
  } catch (err) {
    return toDisplayText(`the policy could not be read (${errorMessage(err)})`, { maxLength: 400 });
  }
  const skipped = policy.skippedServers?.find((entry) => entry.serverName === name);
  if (skipped) {
    return toDisplayText(`the server pre-filter skipped it as irrelevant to your constitution (${skipped.reason}).`, {
      maxLength: 400,
    });
  }
  const failed = policy.failedServers?.find((entry) => entry.serverName === name);
  if (failed) return toDisplayText(`it failed to compile (${failed.phase}: ${failed.reason}).`, { maxLength: 400 });
  return 'nothing in your constitution grants it anything, so every tool is denied.';
}

function formatRule(rule: CompiledRule): string {
  const tools = rule.if.tool ? ` (tools: ${rule.if.tool.join(', ')})` : ' (every tool)';
  return toDisplayText(`${rule.name}: ${rule.then}${tools}`, { maxLength: 300 });
}

type NextStep = 'annotate' | 'compile' | 'activate';

function printNextSteps(name: string, steps: readonly NextStep[], deps: ResolvedDeps): void {
  const commands: Record<NextStep, string> = {
    annotate: `ironcurtain annotate-tools --server ${name}`,
    compile: `ironcurtain compile-policy --server ${name}`,
    activate: 'ironcurtain compile-policy',
  };
  deps.log('Next:');
  for (const step of steps) deps.log(`  ${commands[step]}`);
  if (steps.includes('activate')) {
    deps.log(
      chalk.dim(
        `Sessions start ${name} once the merged policy has rules for it (a full compile-policy run; servers ` +
          'verified earlier are reused from the compile cache).',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// mcp remove
// ---------------------------------------------------------------------------

async function runRemove(args: string[], deps: ResolvedDeps): Promise<number> {
  const parsed = parseSimpleArgs(args, removeSpec, true, deps.log);
  if (!parsed) return 1;
  if (checkHelp(parsed, removeSpec)) return 0;
  if (parsed.positionals.length !== 1) {
    deps.log(chalk.red('Usage: ironcurtain mcp remove <name> [--yes]'));
    return 1;
  }
  const name = parsed.positionals[0];
  const shownName = toDisplayText(name);
  const isBuiltin = Object.hasOwn(loadBuiltinMcpServers(), name);
  // Only a server with a valid name can ever have run, so only such a
  // server has annotations, a compile cache and rules to clean up. An entry
  // with an invalid or reserved name (a hand edit that every loader refuses)
  // is only taken out of the file; nothing named after it is touched (what
  // exists under a reserved name, such as `memory`, `proxy`, `network` or
  // `workflow`, belongs to IronCurtain).
  const cleanUp = !isBuiltin && userServerNameProblem(name) === undefined;

  if (!parsed.yes) {
    if (!deps.interactive) {
      deps.log(chalk.red(`Error: pass --yes to remove ${shownName} without a terminal.`));
      return 1;
    }
    const what = isBuiltin ? `your adjustment of the built-in server ${shownName}` : `the MCP server ${shownName}`;
    if (!(await deps.prompts.confirm(`Remove ${what}?`, false))) {
      deps.log('Nothing removed.');
      return 0;
    }
  }

  // The rest of the file need not be valid: removing a broken entry is one
  // way to fix it, one entry at a time.
  const { removed, remainingProblems } = removeUserMcpServerEntry(name);
  if (!removed) {
    deps.log(
      chalk.red(
        isBuiltin
          ? `Error: "${shownName}" is a built-in server and your mcp-servers.json does not adjust it; ` +
              "built-in servers cannot be removed (leave them out of your constitution or a persona's server list)."
          : `Error: no server named "${shownName}" in your mcp-servers.json.`,
      ),
    );
    return 1;
  }
  const reportRemainingProblems = (): void => {
    if (remainingProblems.length === 0) return;
    deps.log(
      chalk.yellow(
        toDisplayText(
          'Your mcp-servers.json still has problems, and IronCurtain refuses it until they are fixed:\n' +
            remainingProblems.map((problem) => `  - ${problem}`).join('\n'),
          { multiline: true },
        ),
      ),
    );
  };
  if (isBuiltin) {
    deps.log(`Removed your adjustment of ${shownName}; the shipped definition applies again.`);
    reportRemainingProblems();
    return 0;
  }
  if (!cleanUp) {
    deps.log(`Removed the entry "${shownName}" from your mcp-servers.json (not a valid server name, so it never ran).`);
    reportRemainingProblems();
    return 0;
  }

  // Everything `mcp add` produced for the server, so no later server of the
  // same name inherits its merged, persona or job rules, cached rules or
  // annotations. Each step runs even when another fails; a failure is
  // reported with its remedy.
  deps.log(`Removed the MCP server ${shownName}.`);
  const userDir = getUserGeneratedDir();
  let status = 0;
  const step = (what: string, remedy: string, run: () => string | undefined): void => {
    try {
      const done = run();
      if (done) deps.log(`  ${done}`);
    } catch (err) {
      status = 1;
      deps.log(chalk.red(`  Could not remove its ${what}: ${toDisplayText(errorMessage(err), { maxLength: 400 })}`));
      deps.log(`  ${remedy}`);
    }
  };
  step('rules from your merged policy', 'Run `ironcurtain compile-policy` to rebuild it without the server.', () => {
    const stripped = removeServerFromUserPolicy(name);
    return stripped > 0 ? `Removed ${stripped} rule(s) for it from your merged policy.` : undefined;
  });
  const scoped = removeServerFromScopedPolicies(name);
  if (scoped.stripped.length > 0) {
    deps.log(
      `  Removed ${countRules(scoped.stripped)} rule(s) for it from ${describeScopedPolicies(scoped.stripped)}.`,
    );
  }
  for (const entry of scoped.unwritable) {
    status = 1;
    deps.log(
      chalk.red(
        `  Could not remove its rules from ${describeScopedPolicy(entry.dir)}: ` +
          toDisplayText(entry.reason, { maxLength: 400 }),
      ),
    );
    deps.log(`  ${recompileHint(entry.dir)} before giving another server this name.`);
  }
  reportUnreadableScopedPolicies(scoped.unreadable, deps);
  step('compile cache', `Delete generated/servers/${name}/ by hand.`, () => {
    const serverDir = serverArtifactDir(userDir, name);
    if (!existsSync(serverDir)) return undefined;
    rmSync(serverDir, { recursive: true, force: true });
    return `Removed its compile cache (generated/servers/${name}/).`;
  });
  step('tool annotations', `Run \`ironcurtain annotate-tools --reset --server ${name}\`.`, () => {
    const reset = resetToolAnnotationsOverlay({
      overlayDir: userDir,
      packageDir: getPackageGeneratedDir(),
      server: name,
    });
    return reset.removed.includes(name) ? 'Removed its tool annotations.' : undefined;
  });
  const credentials = loadUserConfig({ readOnly: true }).serverCredentials[name] ?? {};
  if (Object.keys(credentials).length > 0) {
    deps.log(
      `  Its credentials stay in ${toDisplayText(getUserConfigPath())}; remove them with \`ironcurtain config\` ` +
        '(Server credentials).',
    );
  }
  reportRemainingProblems();
  return status;
}

// ---------------------------------------------------------------------------
// The merged policy
// ---------------------------------------------------------------------------

/** The merged policy sessions load: the user's when one was compiled, else the package's. */
function readActivePolicy(): CompiledPolicyFile {
  const userDir = getUserGeneratedDir();
  const dir = existsSync(resolve(userDir, COMPILED_POLICY_FILE)) ? userDir : getPackageGeneratedDir();
  return loadPersonaPolicyArtifacts(dir).compiledPolicy;
}

function countRulesByServer(policy: CompiledPolicyFile): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of policy.rules) {
    for (const server of rule.if.server ?? []) counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return counts;
}

/** Rules for `name` in the active merged policy (0 when it cannot be read). */
function activeRuleCount(name: string): number {
  try {
    return countRulesByServer(readActivePolicy()).get(name) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `policy` without `serverName`: rules scoped to it alone are dropped, and
 * it is taken out of the server list of rules that also name others (so
 * they keep applying to those). Its failed and skipped records go too. It
 * only ever removes permissions. `changedRules` counts the rules dropped or
 * narrowed; `changed` is whether anything differs.
 */
export function withoutServer(
  policy: CompiledPolicyFile,
  serverName: string,
): { readonly policy: CompiledPolicyFile; readonly changedRules: number; readonly changed: boolean } {
  let changedRules = 0;
  const rules: CompiledRule[] = [];
  for (const rule of policy.rules) {
    const servers = rule.if.server;
    if (!servers?.includes(serverName)) {
      rules.push(rule);
      continue;
    }
    changedRules++;
    const others = servers.filter((server) => server !== serverName);
    if (others.length > 0) rules.push({ ...rule, if: { ...rule.if, server: others } });
  }
  const next: CompiledPolicyFile = { ...policy, rules };
  let changed = changedRules > 0;
  if (policy.failedServers) {
    const kept = policy.failedServers.filter((failed) => failed.serverName !== serverName);
    changed ||= kept.length !== policy.failedServers.length;
    if (kept.length > 0) next.failedServers = kept;
    else delete next.failedServers;
  }
  if (policy.skippedServers) {
    const kept = policy.skippedServers.filter((skipped) => skipped.serverName !== serverName);
    changed ||= kept.length !== policy.skippedServers.length;
    if (kept.length > 0) next.skippedServers = kept;
    else delete next.skippedServers;
  }
  return { policy: next, changedRules, changed };
}

/**
 * Removes `serverName` from the user's merged compiled-policy.json (the
 * package's policy never names a user server), and its scenarios from the
 * test scenarios stored beside it. Returns the number of rules dropped or
 * narrowed. The file is read and schema-validated as sessions read it
 * before it is rewritten ({@link readCompiledPolicy}); an invalid one throws
 * `POLICY_ARTIFACT_INVALID`, one sessions refuse to read
 * {@link POLICY_UNREADABLE}.
 */
function removeServerFromUserPolicy(serverName: string): number {
  const userDir = getUserGeneratedDir();
  if (!existsSync(resolve(userDir, COMPILED_POLICY_FILE))) return 0;
  const result = withoutServer(readCompiledPolicy(userDir), serverName);
  if (result.changed) writeArtifact(userDir, COMPILED_POLICY_FILE, result.policy);
  removeServerFromStoredScenarios(userDir, serverName);
  return result.changedRules;
}

/**
 * `<dir>/compiled-policy.json`, read and schema-validated the way sessions
 * read it (`readCompiledPolicyFile`: no symlink at its name, a regular file
 * of a trusted owner that no other user can write). A policy sessions
 * refuse is therefore never narrowed and written back, which would turn it
 * into a file they accept. Throws `POLICY_ARTIFACT_INVALID` for an invalid
 * policy and {@link POLICY_UNREADABLE} for one that cannot be read so.
 */
function readCompiledPolicy(dir: string): CompiledPolicyFile {
  try {
    return readCompiledPolicyFile(dir);
  } catch (err) {
    if (isObjectWithProp(err, 'code') && err.code === 'POLICY_ARTIFACT_INVALID') throw err;
    throw Object.assign(new Error(errorMessage(err), { cause: err }), { code: POLICY_UNREADABLE });
  }
}

/**
 * Takes `serverName`'s scenarios, and the decisions recorded for them, out
 * of the test scenarios stored beside a policy that no longer names the
 * server ({@link scenariosWithoutServer}). `ironcurtain doctor` replays the
 * recorded decisions against the policy; the removed server's scenarios
 * would no longer get theirs, and the narrowed policy would be reported as
 * stale. Best effort: sessions never read the file, so one that is missing,
 * not a regular file, damaged or cannot be rewritten is left as it is
 * (doctor then suggests the recompile that rewrites it).
 */
function removeServerFromStoredScenarios(dir: string, serverName: string): void {
  const path = resolve(dir, TEST_SCENARIOS_FILE);
  try {
    if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) return;
    const narrowed = scenariosWithoutServer(JSON.parse(readFileSync(path, 'utf-8')) as unknown, serverName);
    if (narrowed) writeArtifact(dir, TEST_SCENARIOS_FILE, narrowed);
  } catch {
    // Diagnostics only (see above).
  }
}

/**
 * `file` (a parsed test-scenarios.json) without `serverName`'s scenarios and
 * the decisions recorded for them (`replay.decisions` is index-aligned with
 * `scenarios`), or undefined when it holds none of them or cannot be
 * narrowed safely: it is not a scenarios file, or its recorded decisions do
 * not line up with its scenarios (doctor reports such a file as it is).
 * Everything else, `inputHash` included, is kept, so the file still belongs
 * to the policy beside it.
 */
export function scenariosWithoutServer(file: unknown, serverName: string): Record<string, unknown> | undefined {
  if (!isPlainObject(file) || !Array.isArray(file.scenarios)) return undefined;
  const scenarios: unknown[] = file.scenarios;
  const keep = scenarios.map(
    (scenario) =>
      !(isPlainObject(scenario) && isPlainObject(scenario.request) && scenario.request.serverName === serverName),
  );
  if (keep.every(Boolean)) return undefined;
  const narrowed: Record<string, unknown> = { ...file, scenarios: scenarios.filter((_, index) => keep[index]) };
  if (file.replay !== undefined) {
    const replay = file.replay;
    if (!isPlainObject(replay) || !Array.isArray(replay.decisions) || replay.decisions.length !== scenarios.length) {
      return undefined;
    }
    const decisions: unknown[] = replay.decisions;
    narrowed.replay = { ...replay, decisions: decisions.filter((_, index) => keep[index]) };
  }
  return narrowed;
}

// ---------------------------------------------------------------------------
// Persona and job policies
// ---------------------------------------------------------------------------

/** What {@link removeServerFromScopedPolicies} did, by policy directory. */
interface ScopedPolicyCleanup {
  /** Policies that named the server and were rewritten without it, with the rules dropped or narrowed. */
  readonly stripped: ReadonlyArray<{ readonly dir: string; readonly rules: number }>;
  /** Policies that name the server but could not be rewritten: their rules for it still apply. */
  readonly unwritable: ReadonlyArray<{ readonly dir: string; readonly reason: string }>;
  /** Policies that could not be read or are invalid: sessions refuse them too, so they grant nothing. */
  readonly unreadable: ReadonlyArray<{ readonly dir: string; readonly reason: string }>;
}

/**
 * The policy directories compiled for a persona or a job
 * (`personas/<name>/generated/`, `jobs/<id>/generated/`) that hold a
 * compiled policy. Sessions load these instead of the merged policy, so they
 * name servers the same way. Soft-deleted personas' policies
 * (`.persona-trash/<entry>/generated/`) are included: `persona trash
 * restore` brings a persona back with its policy as it is, so a rule an
 * earlier server of a name left there would apply to a new server of that
 * name after the restore.
 */
function scopedPolicyDirs(): string[] {
  const dirs: string[] = [];
  for (const base of [getPersonasDir(), getJobsDir()]) {
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // No personas or no jobs.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = resolve(base, entry.name, 'generated');
      if (existsSync(resolve(dir, COMPILED_POLICY_FILE))) dirs.push(dir);
    }
  }
  for (const entry of personaTrashEntries()) {
    const dir = resolve(entry.path, 'generated');
    if (existsSync(resolve(dir, COMPILED_POLICY_FILE))) dirs.push(dir);
  }
  return dirs.sort();
}

/** The persona trash's entries (real directories only), or none when it cannot be listed. */
function personaTrashEntries(): readonly PersonaTrashEntry[] {
  try {
    return listPersonaTrash();
  } catch {
    return []; // No trash.
  }
}

/**
 * Removes `serverName` from every persona's and job's compiled policy
 * ({@link withoutServer}: it only ever removes permissions), and its
 * scenarios from the test scenarios stored beside each. The policies keep
 * their constitution hash, so they stay current; a persona or job that
 * should use a new server of the same name is recompiled. A policy is read
 * as sessions read it ({@link readCompiledPolicy}); one they refuse is
 * reported as unreadable and left alone. Never throws: each policy's
 * outcome is reported.
 */
function removeServerFromScopedPolicies(serverName: string): ScopedPolicyCleanup {
  const stripped: Array<{ dir: string; rules: number }> = [];
  const unwritable: Array<{ dir: string; reason: string }> = [];
  const unreadable: Array<{ dir: string; reason: string }> = [];
  for (const dir of scopedPolicyDirs()) {
    let result: ReturnType<typeof withoutServer>;
    try {
      result = withoutServer(readCompiledPolicy(dir), serverName);
    } catch (err) {
      unreadable.push({ dir, reason: errorMessage(err) });
      continue;
    }
    if (result.changed) {
      try {
        writeArtifact(dir, COMPILED_POLICY_FILE, result.policy);
        stripped.push({ dir, rules: result.changedRules });
      } catch (err) {
        unwritable.push({ dir, reason: errorMessage(err) });
        continue;
      }
    }
    removeServerFromStoredScenarios(dir, serverName);
  }
  return { stripped, unwritable, unreadable };
}

/**
 * The persona, job or soft-deleted persona (trash entry) a
 * {@link scopedPolicyDirs} entry belongs to (`<base>/<id>/generated`).
 */
function scopedPolicyOwner(dir: string): {
  readonly kind: 'persona' | 'job' | 'deleted persona';
  readonly id: string;
} {
  const ownerDir = dirname(dir);
  const base = dirname(ownerDir);
  return {
    kind: base === getPersonasDir() ? 'persona' : base === getPersonaTrashDir() ? 'deleted persona' : 'job',
    id: toDisplayText(basename(ownerDir)),
  };
}

/** `persona writer` / `job nightly` / `deleted persona writer-<timestamp>` (display text). */
function describeScopedPolicy(dir: string): string {
  const { kind, id } = scopedPolicyOwner(dir);
  return `${kind} ${id}`;
}

function describeScopedPolicies(entries: ReadonlyArray<{ readonly dir: string }>): string {
  return `the policies of ${entries.map((entry) => describeScopedPolicy(entry.dir)).join(', ')}`;
}

/** How to recompile (or, for a soft-deleted persona, purge) the owner of a scoped policy directory. */
function recompileHint(dir: string): string {
  const { kind, id } = scopedPolicyOwner(dir);
  switch (kind) {
    case 'persona':
      return `Run \`ironcurtain persona compile ${id}\``;
    case 'deleted persona':
      return `Purge it (\`ironcurtain persona trash purge ${id}\`)`;
    case 'job':
      return `Run \`ironcurtain daemon recompile-job ${id}\``;
  }
}

function countRules(entries: ReadonlyArray<{ readonly rules: number }>): number {
  return entries.reduce((total, entry) => total + entry.rules, 0);
}

function reportUnreadableScopedPolicies(
  entries: ReadonlyArray<{ readonly dir: string; readonly reason: string }>,
  deps: ResolvedDeps,
): void {
  for (const entry of entries) {
    deps.log(
      chalk.yellow(
        `  The policy of ${describeScopedPolicy(entry.dir)} could not be read, so it was not checked for rules ` +
          `naming this server (sessions refuse it until it is recompiled): ` +
          toDisplayText(entry.reason, { maxLength: 300 }),
      ),
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
