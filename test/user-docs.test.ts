/**
 * The user and operator guides, and the guides for agents (every CLAUDE.md
 * at the root, in a src/ module or in a package, with its GEMINI.md twin),
 * must not send readers to things that do not exist. For every guide below:
 *
 * - every relative link and image names an existing file, and every `#anchor`
 *   names a heading of its target (GitHub's heading ids);
 * - every repository path written in a code span (`src/...`, `docs/...`,
 *   `scripts/...`, ...) exists;
 * - every `ironcurtain <command>` in a code span or code block names a real
 *   top-level command, and every `--option` on that command line is one the
 *   source defines;
 * - every `npm run <script>` names a script of the package it runs in;
 * - none of the names this documentation pass removed comes back, and the
 *   statements that correct an earlier overclaim stay;
 * - the WORKFLOWS.md lint catalog lists exactly the diagnostic codes
 *   src/workflow/lint.ts emits, each with its severity;
 * - where a guide restates a fact the security documents state (which SSH
 *   keys the OS sandbox hides, the passthrough tunnel idle timeouts, how
 *   PyPI package list entries match), it says what the code does;
 * - the README's isolated-vm troubleshooting row names the commands that run
 *   the V8 sandbox preflight and the platforms isolated-vm ships prebuilt;
 * - the first-run guide uses the builtin agent and an isolated workspace when
 *   launching a session directly from the checkout.
 *
 * The design docs that describe shipped code (a dated Status line of
 * Implemented or Partial) get the link check, heading anchors included, and
 * the command check for the commands they name in code spans, shell code
 * blocks and the `$` prompt lines of their other code blocks; the rest of
 * those blocks holds source, logs and sample output. Their
 * repository paths and the removed names are not checked: a design doc keeps
 * the file names of its own history, with a pointer to what replaced them.
 *
 * Options are checked against the whole of src/, not per command: every
 * command's import closure takes in more than half of src/ (the user
 * configuration module alone does), and the option tables of several
 * commands are not exported, so a per-command check would be hardly
 * stricter without restructuring the commands.
 *
 * A few statements that design docs, agent guides and one source comment
 * make about the code are checked against it too (agent container
 * privileges, the Apple `container` topology, audit redaction, the agent CLI
 * pin, the Node.js engines, the Signal container, the memory server's recall
 * output).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, type Token } from 'marked';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { sandboxPreflightRequired, topLevelCommandNames } from '../src/cli-routing.js';
import { USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';
import { CLAUDE_CODE_CLI_VERSION, isValidAgentCliVersionOverride } from '../src/docker/agent-cli-version.js';
import {
  AGENT_SUDO_CAPABILITIES,
  isAgentSudoEnabled,
  NO_NEW_PRIVILEGES_SECURITY_OPTION,
  planAgentContainerPrivileges,
} from '../src/docker/agent-privileges.js';
import { checkAppleContainerAvailable } from '../src/docker/apple-container-manager.js';
import { DEFAULT_MITM_RESOURCE_LIMITS } from '../src/docker/mitm-resource-limits.js';
import { resolveNetworkTopology } from '../src/docker/network-topology.js';
import { createPackageValidator } from '../src/docker/package-validator.js';
import { parsePypiSimpleUrl } from '../src/docker/registry-proxy.js';
import { buildSpawnArgs } from '../src/pty/pty-bridge.js';
import { prepareRedactionSecrets, redactString } from '../src/trusted-process/audit-redactor.js';
import { BASELINE_CREDENTIAL_DENY_READ } from '../src/trusted-process/sandbox-integration.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The user and operator guides these checks cover (repository-relative), and
 * the guides for agents: every CLAUDE.md, with the GEMINI.md symlinks beside
 * some of them (test/dev-environment.test.ts keeps those symlinks).
 */
const USER_DOCS = [
  'README.md',
  'CONFIG.md',
  'DAEMON.md',
  'WORKFLOWS.md',
  'RUNNING_MODES.md',
  'MODEL_ROUTING.md',
  'TRANSPORT.md',
  'TRAJECTORIES.md',
  'DEVELOPER_GUIDE.md',
  'ADDING_MCP_SERVERS.md',
  'CONTRIBUTING.md',
  'TESTING.md',
  'docs/e2e-workflow-testing.md',
  'packages/memory-mcp-server/README.md',
  'packages/memory-mcp-server/CLAUDE.md',
  'packages/web-ui/README.md',
  'packages/web-ui/CLAUDE.md',
  'CLAUDE.md',
  'GEMINI.md',
  'src/docker/CLAUDE.md',
  'src/docker/GEMINI.md',
  'src/persona/CLAUDE.md',
  'src/pipeline/CLAUDE.md',
  'src/pipeline/GEMINI.md',
  'src/trusted-process/CLAUDE.md',
  'src/trusted-process/GEMINI.md',
  'test/README.md',
] as const;

/**
 * Names that described behaviour that no longer exists (or never did). Each
 * was corrected in these guides; the reason says what replaced it.
 */
const REMOVED_REFERENCES: readonly { readonly text: string; readonly reason: string }[] = [
  { text: 'packageInstallation', reason: 'the config key is packageInstall' },
  { text: '--web-host', reason: 'the web UI always binds 127.0.0.1; there is no host option' },
  { text: 'IRONCURTAIN_ENSURE_DAEMON', reason: 'only the --ensure-daemon flag exists' },
  { text: 'proxy-control.sock', reason: 'the control socket is ~/.ironcurtain/run/<bundle>/ctrl.sock' },
  { text: 'claude --continue', reason: 'conversations resume by id, only with freshSession: false' },
  { text: 'src/agent/', reason: 'the agent loop lives in src/session/agent-session.ts' },
  { text: 'mock-token-for-dev', reason: "the mock server's token is mock-dev-token" },
  { text: 'loaded automatically via `dotenv`', reason: 'credentials come from ~/.ironcurtain/.env' },
  {
    text: "`allowRead` in the server's sandbox settings",
    reason: "~/.ironcurtain/mcp-servers.json may change only a built-in server's env and network domain lists",
  },
  {
    text: 'show an `[!]` badge',
    reason: 'the mux tab bar has one `[!N pending]` badge counting every pending escalation',
  },
  {
    text: 'cannot read your SSH private keys',
    reason: 'the OS sandbox hides SSH private keys only at their default names (`~/.ssh/id_*`)',
  },
  {
    text: 'Tunnels close after 10 minutes without traffic',
    reason: 'a port-80 tunnel is served as HTTP and closes after the 15-minute connection idle deadline',
  },
  {
    text: 'An IronCurtain home written by a newer version is refused',
    reason:
      'only a newer layoutVersion in state.json is refused; a home a newer version last used gets a notice (src/config/state-version.ts)',
  },
  {
    text: 'its judge is the same model family as the compiler',
    reason: 'unless policyVerifierModelId names another model, the policy model writes the scenarios and judges them',
  },
];

/**
 * Statements a guide must keep: each replaced a description that did not
 * match the code. The reason says what the code does.
 */
const REQUIRED_STATEMENTS: readonly { readonly path: string; readonly pattern: RegExp; readonly reason: string }[] = [
  {
    path: 'DAEMON.md',
    pattern: /`list-jobs` only reads the job files and takes no lock/,
    reason: 'a local list-jobs runs without the daemon lock (daemon-command.ts)',
  },
  {
    path: 'DAEMON.md',
    pattern: /policy-mutation\.jsonl`[^\n]*Recording is best effort/,
    reason: 'PolicyMutationAuditLog.append skips a record it cannot write instead of blocking the mutation',
  },
  {
    path: 'README.md',
    pattern: /`w` then `y` approve and whitelist/,
    reason: "the mux picker's w and W only show the whitelist pattern; y then approves and whitelists it",
  },
  {
    path: 'README.md',
    pattern: /validates OAuth access tokens without refreshing them[^\n]*Only `--check-refresh` refreshes credentials/,
    reason: 'doctor --check-api never runs a refresh grant; only --check-refresh does (src/doctor/oauth-checks.ts)',
  },
  {
    path: 'README.md',
    pattern: /A home whose layout a newer version changed \(`layoutVersion` in `state\.json`\) is refused/,
    reason: 'recordStartupState refuses a newer home layout and only notes a newer last-run version',
  },
  {
    path: 'README.md',
    pattern: /\| \*\*V8 sandbox \(`isolated-vm`\) does not load\*\* +\|[^\n]*--allow-scripts=isolated-vm,node-pty/,
    reason:
      'isolated-vm is compiled where it has no prebuild, which needs build tools and its install script (docs/designs/dependency-hygiene.md)',
  },
  {
    path: 'README.md',
    pattern: /Without `--check-refresh`, `doctor` is read-only/,
    reason:
      '--check-refresh saves the rotated Anthropic credentials and the new Google Workspace access token (src/doctor/oauth-checks.ts)',
  },
  {
    path: 'README.md',
    pattern: /With `strict-allow-scripts` set, that install fails on the install scripts of the other dependencies/,
    reason:
      'strict mode fails on every install script no allowlist covers, and the global tree has more than the two native modules (docs/designs/dependency-hygiene.md)',
  },
];

/** How the guides name a gate event (`APPROVE` -> "Approve", `FORCE_REVISION` -> "Force Revision"). */
function gateEventLabel(event: string): string {
  return event
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface DocFile {
  readonly path: string;
  readonly text: string;
  readonly tokens: Token[];
}

function loadDoc(path: string): DocFile {
  const text = readFileSync(join(projectRoot, path), 'utf-8');
  return { path, text, tokens: marked.lexer(text) };
}

const docs: DocFile[] = USER_DOCS.map(loadDoc);

/** The kinds of a design doc's dated Status line (test/design-doc-status.test.ts) that describe shipped code. */
const CURRENT_DESIGN_STATUS = /^\*\*Status \(\d{4}-\d{2}-\d{2}\):\*\* (?:Implemented|Partial)\b/m;

/** The design docs that describe shipped code (repository-relative, sorted). */
const designDocs: DocFile[] = readdirSync(join(projectRoot, 'docs', 'designs'))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => loadDoc(`docs/designs/${name}`))
  .filter((doc) => CURRENT_DESIGN_STATUS.test(doc.text));

/** Every token of a document, depth-first (inline tokens, list items and table cells included). */
function allTokens(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  const visit = (token: Token): void => {
    out.push(token);
    const record = token as unknown as Record<string, unknown>;
    for (const child of (record.tokens as Token[] | undefined) ?? []) visit(child);
    for (const item of (record.items as Token[] | undefined) ?? []) visit(item);
    for (const cell of (record.header as { tokens: Token[] }[] | undefined) ?? []) cell.tokens.forEach(visit);
    for (const row of (record.rows as { tokens: Token[] }[][] | undefined) ?? []) {
      for (const cell of row) cell.tokens.forEach(visit);
    }
  };
  tokens.forEach(visit);
  return out;
}

/** The plain text of inline tokens (what a heading id is derived from). */
function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      const record = token as unknown as Record<string, unknown>;
      const children = record.tokens as Token[] | undefined;
      if (children !== undefined && children.length > 0) return plainText(children);
      return typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

/** GitHub's heading id: lower case, punctuation dropped (hyphens and underscores kept), spaces to hyphens. */
function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map<string, ReadonlySet<string>>();

/** The heading ids of a markdown file (with GitHub's `-1`, `-2` suffixes for repeats). */
function anchorsOf(absolutePath: string): ReadonlySet<string> {
  const cached = anchorCache.get(absolutePath);
  if (cached !== undefined) return cached;
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const token of allTokens(marked.lexer(readFileSync(absolutePath, 'utf-8')))) {
    if (token.type !== 'heading') continue;
    const slug = githubSlug(plainText((token as { tokens?: Token[] }).tokens ?? []));
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    anchors.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  anchorCache.set(absolutePath, anchors);
  return anchors;
}

/** The text of a token (a code span's code, a code block's lines), or undefined. */
function tokenText(token: Token): string | undefined {
  const text = (token as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

/** Code block languages whose lines are shell commands. */
const SHELL_LANGUAGES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);

/** A line of a code block that shows a shell prompt (`$ ironcurtain ...`). */
const PROMPT_LINE = /^\s*\$\s/;

/**
 * The code spans and code-block lines of a document, shell comments dropped
 * from the lines. With `shellLinesOnly`, the blocks marked as shell code count
 * whole, and of the other blocks only the lines that start with a `$` prompt
 * (a design doc's other blocks hold source, logs and prose).
 */
function codeTexts(doc: DocFile, { shellLinesOnly = false } = {}): string[] {
  const texts: string[] = [];
  for (const token of allTokens(doc.tokens)) {
    const text = tokenText(token);
    if (text === undefined) continue;
    if (token.type === 'codespan') texts.push(text);
    if (token.type !== 'code') continue;
    const lang = (token as { lang?: unknown }).lang;
    const shell = SHELL_LANGUAGES.has(typeof lang === 'string' ? lang.split(/\s/)[0] : '');
    const lines = text.split('\n').filter((line) => !shellLinesOnly || shell || PROMPT_LINE.test(line));
    texts.push(...lines.map((line) => line.replace(/(^|\s)#.*$/, '')));
  }
  return texts;
}

/** The relative links and images of a document that name no file, or no heading of a Markdown file. */
function brokenLinks(doc: DocFile): string[] {
  const broken: string[] = [];
  for (const token of allTokens(doc.tokens)) {
    if (token.type !== 'link' && token.type !== 'image') continue;
    const href = (token as { href: string }).href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // https:, mailto:, ...
    const hash = href.indexOf('#');
    const target = hash < 0 ? href : href.slice(0, hash);
    const anchor = hash < 0 ? '' : href.slice(hash + 1);
    const absolute = target === '' ? join(projectRoot, doc.path) : resolve(projectRoot, dirname(doc.path), target);
    if (!existsSync(absolute)) {
      broken.push(`${href} (no such file)`);
      continue;
    }
    if (anchor !== '' && absolute.endsWith('.md') && !anchorsOf(absolute).has(anchor)) {
      broken.push(`${href} (no such heading)`);
    }
  }
  return broken;
}

/** Every source file under src/, concatenated. */
const sourceText = ((): string => {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs|js|json)$/.test(entry.name)) parts.push(readFileSync(path, 'utf-8'));
    }
  };
  walk(join(projectRoot, 'src'));
  return parts.join('\n');
})();

const commands = new Set(topLevelCommandNames());

/** A repository path in a code span: `src/...`, `docs/...`, ..., optionally with a `:line` suffix. */
const REPOSITORY_PATH =
  /^(?:\.\/)?((?:src|test|docs|scripts|packages|docker|examples|config)\/[\w./@-]*?)(?::\d+(?:-\d+)?)?$/;

/** Global options accepted before the command; `--env-file` takes a value. */
const GLOBAL_OPTIONS = new Set(['--help', '-h', '--version', '-v']);

interface CommandUse {
  readonly command: string;
  readonly options: readonly string[];
}

/**
 * The `ironcurtain` invocations on one line of code (`ironcurtain`, or the
 * source and built entry points `src/cli.ts` / `dist/cli.js`). Options are
 * collected up to a comment, a pipe or a command separator.
 */
function commandUses(line: string): CommandUse[] {
  const uses: CommandUse[] = [];
  const pattern = /(?:^|[\s(`$])(?:ironcurtain|src\/cli\.ts|dist\/cli\.js)\s+(.*)$/;
  let rest = line;
  for (let match = pattern.exec(rest); match !== null; match = pattern.exec(rest)) {
    const words = match[1].split(/\s+/).filter((word) => word !== '');
    let index = 0;
    while (index < words.length && (GLOBAL_OPTIONS.has(words[index]) || words[index] === '--env-file')) {
      index += words[index] === '--env-file' ? 2 : 1;
    }
    const command = (words[index] ?? '').replace(/[`).,:;]+$/, '');
    const options: string[] = [];
    for (const word of words.slice(index + 1)) {
      if (word.startsWith('#') || ['|', '||', '&&', ';', '>', '2>'].includes(word)) break;
      const option = /^--([a-z][a-z0-9-]*)/.exec(word);
      if (option !== null) options.push(option[1]);
    }
    if (command !== '') uses.push({ command, options });
    rest = match[1];
  }
  return uses;
}

/** The `ironcurtain` invocations on these code lines that name no command, or an option src/ does not define. */
function unknownCommands(lines: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const line of lines) {
    for (const use of commandUses(line)) {
      if (/^[<[]/.test(use.command) || use.command.startsWith('"')) continue; // a placeholder or a task string
      if (!commands.has(use.command)) {
        unknown.push(`ironcurtain ${use.command}`);
        continue;
      }
      for (const option of use.options) {
        const defined = [`'${option}'`, `"${option}"`, `--${option}`].some((form) => sourceText.includes(form));
        if (!defined) unknown.push(`ironcurtain ${use.command} --${option}`);
      }
    }
  }
  return unknown;
}

describe('user documentation', () => {
  it.each(docs.map((doc) => [doc.path, doc] as const))('%s: relative links resolve', (_path, doc) => {
    expect(brokenLinks(doc)).toEqual([]);
  });

  it.each(docs.map((doc) => [doc.path, doc] as const))('%s: repository paths in code exist', (_path, doc) => {
    const missing: string[] = [];
    for (const token of allTokens(doc.tokens)) {
      const text = tokenText(token);
      if (token.type !== 'codespan' || text === undefined) continue;
      const match = REPOSITORY_PATH.exec(text.trim());
      if (match === null) continue;
      const path = match[1];
      if (existsSync(join(projectRoot, path)) || existsSync(resolve(projectRoot, dirname(doc.path), path))) continue;
      missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it.each(docs.map((doc) => [doc.path, doc] as const))('%s: ironcurtain commands and options exist', (_path, doc) => {
    expect(unknownCommands(codeTexts(doc))).toEqual([]);
  });

  it.each(docs.map((doc) => [doc.path, doc] as const))('%s: npm scripts exist', (_path, doc) => {
    const missing: string[] = [];
    for (const line of codeTexts(doc)) {
      let cwd = dirname(join(projectRoot, doc.path));
      for (const segment of line.split(/&&|;/)) {
        const words = segment.trim().split(/\s+/);
        if (words[0] === 'cd' && words.length > 1) {
          cwd = resolve(projectRoot, words[1]);
          continue;
        }
        const npm = words.indexOf('npm');
        if (npm < 0) continue;
        const args = words.slice(npm + 1);
        let script: string | undefined;
        let workspace: string | undefined;
        for (let index = 0; index < args.length; index++) {
          const word = args[index];
          if (word.startsWith('#')) break;
          if (word === '-w' || word === '--workspace') workspace = args[++index];
          else if (word.startsWith('--workspace=')) workspace = word.slice('--workspace='.length);
          else if (index === 0 && word === 'test') script = 'test';
          else if (index === 1 && (args[0] === 'run' || args[0] === 'run-script')) script = word;
        }
        if (script === undefined || script.startsWith('<')) continue;
        let packageDir = workspace !== undefined ? resolve(projectRoot, workspace) : cwd;
        while (!existsSync(join(packageDir, 'package.json')) && packageDir !== projectRoot) {
          packageDir = dirname(packageDir);
        }
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        if (manifest.scripts?.[script] === undefined) missing.push(`npm run ${script} (${packageDir})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(docs.map((doc) => [doc.path, doc] as const))('%s: no removed names come back', (_path, doc) => {
    const found = REMOVED_REFERENCES.filter(({ text }) => doc.text.includes(text)).map(
      ({ text, reason }) => `${text}: ${reason}`,
    );
    expect(found).toEqual([]);
  });

  it('checks every guide for agents at the root, in a src/ module and in a package', () => {
    const guides = ['CLAUDE.md', 'GEMINI.md'].filter((name) => existsSync(join(projectRoot, name)));
    for (const parent of ['src', 'packages']) {
      for (const entry of readdirSync(join(projectRoot, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const name of ['CLAUDE.md', 'GEMINI.md']) {
          if (existsSync(join(projectRoot, parent, entry.name, name))) guides.push(`${parent}/${entry.name}/${name}`);
        }
      }
    }
    expect(guides.length).toBeGreaterThanOrEqual(7);
    expect(guides.filter((path) => !(USER_DOCS as readonly string[]).includes(path))).toEqual([]);
  });

  it.each(REQUIRED_STATEMENTS.map((entry) => [entry.path, entry] as const))(
    '%s: keeps a statement the code requires',
    (path, entry) => {
      const doc = docs.find((candidate) => candidate.path === path);
      expect(doc, `${path} is one of the checked guides`).toBeDefined();
      expect(doc?.text ?? '', entry.reason).toMatch(entry.pattern);
    },
  );

  it('WORKFLOWS.md: the lint catalog matches src/workflow/lint.ts', () => {
    const source = readFileSync(join(projectRoot, 'src/workflow/lint.ts'), 'utf-8');
    const union = /export type DiagnosticCode =([^;]+);/.exec(source)?.[1] ?? '';
    const codes = [...union.matchAll(/'(WF\d{3})'/g)].map((match) => match[1]);
    expect(codes.length).toBeGreaterThan(10);

    // The severity each code is emitted with (`code: 'WF001', severity: 'error'`).
    const severities = new Map<string, Set<string>>();
    for (const match of source.matchAll(/code:\s*'(WF\d{3})',\s*severity:\s*'(error|warning)'/g)) {
      severities.set(match[1], (severities.get(match[1]) ?? new Set<string>()).add(match[2]));
    }
    expect(
      codes.filter((code) => severities.get(code)?.size !== 1),
      'codes not emitted with exactly one severity',
    ).toEqual([]);

    const workflowsDoc = docs.find((doc) => doc.path === 'WORKFLOWS.md');
    const catalog = new Map<string, string>();
    for (const line of (workflowsDoc?.text ?? '').split('\n')) {
      const row = /^\|\s*`(WF\d{3})`\s*\|\s*(\w+)\s*\|/.exec(line);
      if (row !== null) catalog.set(row[1], row[2]);
    }
    expect([...catalog.keys()].sort(), 'codes in the WORKFLOWS.md check catalog').toEqual([...codes].sort());
    const wrongSeverity = codes.filter((code) => catalog.get(code) !== [...(severities.get(code) ?? [])][0]);
    expect(wrongSeverity, 'catalog rows whose severity differs from lint.ts').toEqual([]);
  });

  it('docs/e2e-workflow-testing.md: the escalate_gate row lists the events the bundled gate accepts', () => {
    const definition = YAML.parse(
      readFileSync(join(projectRoot, 'src/workflow/workflows/design-and-code/workflow.yaml'), 'utf-8'),
    ) as { states?: Partial<Record<string, { acceptedEvents?: unknown }>> };
    const accepted = definition.states?.escalate_gate?.acceptedEvents;
    const events = Array.isArray(accepted) ? accepted.map(String) : [];
    expect(events.length, 'design-and-code has an escalate_gate with accepted events').toBeGreaterThan(0);

    const e2eDoc = docs.find((doc) => doc.path === 'docs/e2e-workflow-testing.md');
    const row = (e2eDoc?.text ?? '').split('\n').find((line) => line.startsWith('| `escalate_gate` |')) ?? '';
    const missing = events.filter((event) => !row.includes(gateEventLabel(event)));
    expect(missing, `events missing from: ${row}`).toEqual([]);
  });

  it('checks the commands it should (sanity check of the parsers)', () => {
    expect(commandUses('ironcurtain --env-file ~/w.env mux --agent codex # comment --nope')).toEqual([
      { command: 'mux', options: ['agent'] },
    ]);
    expect(commandUses('npx tsx src/cli.ts daemon --web-ui && echo')).toEqual([
      { command: 'daemon', options: ['web-ui'] },
    ]);
    expect(commandUses('ls ~/.ironcurtain/sessions')).toEqual([]);
    expect(githubSlug('Quick start (web UI — recommended)')).toBe('quick-start-web-ui--recommended');
    expect(githubSlug('`ironcurtain workflow lint`')).toBe('ironcurtain-workflow-lint');
    // A design doc's TypeScript blocks are code, not commands; its code spans,
    // shell blocks and the prompt lines of its other blocks are.
    const sample = [
      '`ironcurtain start`',
      '```ts\n// the ironcurtain process\n```',
      '```bash\nironcurtain mux\n```',
      '```\nthe ironcurtain repo\n$ ironcurtain doctor\n```',
    ].join('\n\n');
    const mixed: DocFile = { path: 'sample.md', text: sample, tokens: marked.lexer(sample) };
    expect(unknownCommands(codeTexts(mixed))).toEqual(['ironcurtain process', 'ironcurtain repo']);
    expect(codeTexts(mixed, { shellLinesOnly: true })).toEqual([
      'ironcurtain start',
      'ironcurtain mux',
      '$ ironcurtain doctor',
    ]);
    expect(unknownCommands(['$ ironcurtain cron create nightly'])).toEqual(['ironcurtain cron']);
  });
});

describe('design docs that describe shipped code', () => {
  it('finds them', () => {
    expect(designDocs.length).toBeGreaterThan(50);
    expect(designDocs.map((doc) => doc.path)).toContain('docs/designs/docker-agent-broker.md');
  });

  it.each(designDocs.map((doc) => [doc.path, doc] as const))('%s: relative links and anchors resolve', (_path, doc) => {
    expect(brokenLinks(doc)).toEqual([]);
  });

  it.each(designDocs.map((doc) => [doc.path, doc] as const))(
    '%s: ironcurtain commands named in code spans, shell blocks and prompt lines exist',
    (_path, doc) => {
      expect(unknownCommands(codeTexts(doc, { shellLinesOnly: true }))).toEqual([]);
    },
  );
});

/** The text of one checked guide (whitespace runs collapsed, so a statement may wrap). */
function guideText(path: (typeof USER_DOCS)[number]): string {
  const doc = docs.find((candidate) => candidate.path === path);
  if (doc === undefined) throw new Error(`${path} is not one of the checked guides`);
  return doc.text.replace(/\s+/g, ' ');
}

describe('user guides agree with the security documents and the code', () => {
  it('README.md: the git server is denied only the default-named SSH private keys', () => {
    // The baseline hides `~/.ssh/id_*`, not `~/.ssh` (ssh needs its config and
    // known_hosts), and the shipped git server does not deny `~/.ssh` itself.
    expect(BASELINE_CREDENTIAL_DENY_READ).toContain('~/.ssh/id_*');
    expect(BASELINE_CREDENTIAL_DENY_READ).not.toContain('~/.ssh');
    const shipped = JSON.parse(readFileSync(join(projectRoot, 'src/config/mcp-servers.json'), 'utf-8')) as {
      git?: { sandbox?: { filesystem?: { denyRead?: readonly string[] } } };
    };
    const gitDenyRead = shipped.git?.sandbox?.filesystem?.denyRead;
    expect(gitDenyRead).toBeDefined();
    expect(gitDenyRead).not.toContain('~/.ssh');

    const readme = guideText('README.md');
    expect(readme).toContain('it cannot read SSH private keys at their default names (`~/.ssh/id_*`)');
    expect(readme).toContain('A key file under another name stays readable to the git server.');
  });

  it('README.md: the first run from source selects the builtin agent and a disposable workspace', () => {
    const onboarding = guideText('README.md');
    expect(onboarding).toContain('workspace=$(mktemp -d)');
    expect(onboarding).toContain('npm start -- --agent builtin -w "$workspace"');
  });

  it('README.md: the isolated-vm row names the commands that load the V8 sandbox and its prebuilt platforms', () => {
    // `start` passes the sandbox preflight, also as the child each mux tab runs;
    // so do the session-running workflow subcommands. mux itself does not.
    const ptyChild = buildSpawnArgs({ cols: 80, rows: 24, ironcurtainBin: 'ironcurtain', agent: 'claude-code' });
    expect(ptyChild[0]).toBe('start');
    expect(sandboxPreflightRequired(ptyChild[0], ptyChild.slice(1))).toBe(true);
    expect(sandboxPreflightRequired('mux', [])).toBe(false);
    for (const sub of ['start', 'resume-standalone']) {
      expect(sandboxPreflightRequired('workflow', [sub, 'x']), `workflow ${sub}`).toBe(true);
    }
    // daemon and bot run the preflight themselves before they can start a session.
    for (const file of ['src/daemon/daemon-command.ts', 'src/signal/bot-command.ts']) {
      expect(readFileSync(join(projectRoot, file), 'utf-8'), file).toContain('await ensureSandboxViable();');
    }
    // The platforms isolated-vm ships prebuilt binaries for; npm compiles it elsewhere.
    const isolatedVm = dirname(createRequire(import.meta.url).resolve('isolated-vm/package.json'));
    expect(readdirSync(join(isolatedVm, 'prebuilds')).sort()).toEqual([
      'darwin-arm64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);

    const readme = docs.find((doc) => doc.path === 'README.md')?.text ?? '';
    const row = readme.split('\n').find((line) => line.startsWith('| **V8 sandbox (`isolated-vm`) does not load**'));
    expect(row).toContain(
      'Commands that run sessions (`start`, which `mux` runs, `workflow start` and `resume-standalone`, `daemon`, `bot`)',
    );
    expect(row).toContain('`isolated-vm` is prebuilt for linux-x64/arm64, darwin-arm64 and win32-x64');
  });

  it('DEVELOPER_GUIDE.md: states the idle timeout of each passthrough tunnel kind', () => {
    // A port-443 approval is a raw tunnel; a port-80 one is served as HTTP
    // under the decrypted-connection idle deadline.
    const rawMinutes = DEFAULT_MITM_RESOURCE_LIMITS.tunnelIdleTimeoutMs / 60_000;
    const port80Minutes = DEFAULT_MITM_RESOURCE_LIMITS.connectionIdleTimeoutMs / 60_000;
    expect(Number.isInteger(rawMinutes) && Number.isInteger(port80Minutes)).toBe(true);
    expect(guideText('DEVELOPER_GUIDE.md')).toContain(
      `A port-443 tunnel closes after ${rawMinutes} minutes without traffic, a port-80 tunnel after ${port80Minutes} minutes.`,
    );
  });

  it('CONFIG.md: PyPI package list entries match only in their PEP 503 form, ignoring case', () => {
    const requested = parsePypiSimpleUrl('/simple/typing_extensions/');
    if (requested === undefined) throw new Error('the PyPI Simple URL did not parse');
    expect(requested.name).toBe('typing-extensions');
    const status = (config: { allowedPackages?: string[]; deniedPackages?: string[] }): string =>
      createPackageValidator({ ...config, quarantineDays: 0 }).validate(requested, undefined).status;
    // An entry spelled the way the project publishes its name never matches ...
    expect(status({ deniedPackages: ['typing_extensions'] })).toBe('allow');
    // ... the PEP 503 spelling does, in any case, in either list.
    expect(status({ deniedPackages: ['Typing-Extensions'] })).toBe('deny');
    const fresh = { publishedAt: new Date() };
    expect(createPackageValidator({ quarantineDays: 2 }).validate(requested, fresh).status).toBe('deny');
    const allowed = createPackageValidator({ allowedPackages: ['TYPING-EXTENSIONS'], quarantineDays: 2 });
    expect(allowed.validate(requested, fresh).status).toBe('allow');

    const config = guideText('CONFIG.md');
    expect(config).toContain('write `typing-extensions`, not `typing_extensions`');
    expect(config).toContain('so an entry `typing_extensions` never matches (write `typing-extensions`)');
  });
});

/** A repository file with whitespace runs collapsed, so a statement may wrap. */
function repoText(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf-8').replace(/\s+/g, ' ');
}

/** Names listed the way the documents list them: "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The Node.js majors package.json "engines" allows, ascending, e.g. `^24.0.0 || ^26.0.0` -> [24, 26]. */
function engineNodeMajors(): number[] {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
    engines: { node: string };
  };
  return manifest.engines.node
    .split('||')
    .map((clause) => Number(/\^(\d+)\./.exec(clause)?.[1]))
    .sort((a, b) => a - b);
}

describe('design docs, agent guides and a source comment agree with the code', () => {
  it('docs/designs/docker-agent-broker.md: agent containers keep passwordless sudo and its capabilities by default', () => {
    const plan = (agentSudo: boolean) =>
      planAgentContainerPrivileges({
        runtimeKind: 'docker',
        useTcp: false,
        agentSudo,
        nestedDocker: false,
        hostIdentity: { uid: 1000, gid: 1000 },
      });
    expect(isAgentSudoEnabled({}), 'agentSudo defaults to on').toBe(true);
    expect(plan(true).capAdd).toEqual(AGENT_SUDO_CAPABILITIES);
    expect(plan(false).capAdd).toEqual([]);
    expect(plan(false).securityOptions).toEqual([NO_NEW_PRIVILEGES_SECURITY_OPTION]);

    // The design-era claims of a non-root, capability-less agent stand only next to what was built.
    const broker = repoText('docs/designs/docker-agent-broker.md');
    expect(broker).not.toContain('The container runs as non-root (`codespace` user from devcontainers base image)');
    expect(broker).not.toContain('- No capabilities granted (`--cap-drop=ALL`)');
    expect(broker).not.toContain('Non-root, no capabilities');
    expect(broker).toContain(`re-adds ${listed(AGENT_SUDO_CAPABILITIES)} after \`--cap-drop=ALL\``);
    expect(broker).toContain(
      'This design granted no capabilities; as implemented the capabilities sudo needs are added back by default',
    );
    expect(broker).toContain('as implemented, IronCurtain keeps that passwordless sudo unless `agentSudo` is false');
    expect(broker).toContain(
      'passwordless sudo and the capabilities it needs by default (agentSudo: false removes both',
    );
  });

  it('docs/designs/apple-container-runtime.md: the host-only decisions give way to the uds topology', async () => {
    expect(resolveNetworkTopology('apple-container')).toBe('uds');
    const probe = await checkAppleContainerAvailable(
      () => Promise.resolve({ stdout: 'container CLI version 0.0.1 (build: release)', stderr: '' }),
      { platform: 'darwin', arch: 'arm64', release: '25.0.0' },
    );
    const floor = /need >= (\d+\.\d+\.\d+)/u.exec(probe.available ? '' : probe.reason)?.[1];
    expect(floor, 'the probe reports its version floor').toBeDefined();

    const lines = readFileSync(join(projectRoot, 'docs/designs/apple-container-runtime.md'), 'utf-8').split('\n');
    const decision = (n: number): string => lines.find((line) => line.startsWith(`${n}. **`)) ?? '';
    const superseded = '_Superseded by [1.1.0 — UDS topology](#110--uds-topology-supersedes-tcp-hostonly)';
    for (const n of [2, 3, 5]) expect(decision(n), `Key Design Decision ${n}`).toContain(superseded);
    // `--network none` leaves the VM its loopback interface, nothing else.
    expect(decision(5)).toContain('with `--network none` the agent VM has only a loopback interface');
    expect(decision(4)).toContain('_Applies only to the unselected `tcp-hostonly` path');
    expect(decision(6)).toContain(`version >= 1.0, since raised to ${floor ?? '?'} by`);
    const design = lines.join(' ').replace(/\s+/g, ' ');
    expect(design).toContain('**Phase 5 -- docs + tests. DONE.**');
    // Missing capabilities do not keep container root out of the sysctls that check only file modes.
    expect(design).not.toMatch(/cannot write the sysctls/u);
    expect(design).toContain(
      'many sysctls check only file permissions, so container root (through sudo) can change kernel settings',
    );
  });

  it('docs/designs/fetch-server-credentials.md: audit entries are redacted, by default', () => {
    expect(USER_CONFIG_DEFAULTS.auditRedaction.enabled).toBe(true);
    const secret = 'server-credential-0123456789';
    expect(redactString(`{"token":"${secret}"}`, prepareRedactionSecrets([secret])).redacted).not.toContain(secret);

    const design = repoText('docs/designs/fetch-server-credentials.md');
    expect(design).not.toContain('Audit log redaction is not implemented');
    expect(design).toContain(
      'As implemented since, audit entries are redacted too, on by default (`auditRedaction.enabled`)',
    );
  });

  it('src/docker/request-sanitizers/anthropic.ts: Claude Code is pinned, with an override', () => {
    expect(CLAUDE_CODE_CLI_VERSION.pinned).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(CLAUDE_CODE_CLI_VERSION.overrideKey).toBe('claude-code');
    expect(isValidAgentCliVersionOverride('latest')).toBe(true);
    const comment = readFileSync(join(projectRoot, 'src/docker/request-sanitizers/anthropic.ts'), 'utf-8')
      .replace(/\n\s*\* ?/g, ' ')
      .replace(/\s+/g, ' ');
    expect(comment).not.toContain('Claude Code is not pinned');
    expect(comment).toContain(
      'Claude Code is pinned by default, but `agentCliVersions` can select another release or `latest`',
    );
  });

  it('docs/designs/mitm-llm-statistics-implementation-plan.md: its Node.js 22 plan is marked historical', () => {
    // node:sqlite needs no flag from Node.js 22.13 and 23.4 on, so on every supported major.
    const majors = engineNodeMajors();
    expect(majors.length).toBeGreaterThan(0);
    for (const major of majors) expect(major, 'a supported Node.js major').toBeGreaterThanOrEqual(24);
    const ci = YAML.parse(readFileSync(join(projectRoot, '.github/workflows/ci.yml'), 'utf-8')) as {
      jobs: { ci: { strategy: { matrix: { 'node-version': number[] } } } };
    };
    expect([...ci.jobs.ci.strategy.matrix['node-version']].sort((a, b) => a - b)).toEqual(majors);

    expect(repoText('docs/designs/mitm-llm-statistics-implementation-plan.md')).toContain(
      'Gate this change in the existing Node 22/24/26 CI matrix. If retaining Node 22.0 is mandatory, select and package a supported SQLite binding instead; do not add an unindexed JSONL fallback that changes query semantics. (Historical: the engine floor and the Node 22/24/26 matrix are those of the time of writing. Node.js 22 is no longer supported:',
    );
  });

  it('TRANSPORT.md and the Signal design: capabilities, immutable container identity and migration', () => {
    const source = readFileSync(join(projectRoot, 'src/signal/signal-container.ts'), 'utf-8');
    const declared = /const CAPABILITIES = \[([^\]]*)\] as const;/.exec(source)?.[1] ?? '';
    const capabilities = [...declared.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(capabilities.length).toBeGreaterThan(0);
    expect(source).toContain('capAdd: CAPABILITIES');
    expect(source).not.toMatch(/restartPolicy:/);

    expect(guideText('TRANSPORT.md')).toContain(
      `\`--cap-drop=ALL\`, then ${listed(capabilities.map((name) => `\`${name}\``))} added back for its entrypoint`,
    );
    expect(guideText('TRANSPORT.md')).toContain('| Restart policy | None: IronCurtain starts the container');
    const design = repoText('docs/designs/signal-transport.md').split('## Historical design record')[0];
    expect(design).toContain(`${listed(capabilities)} are added back for its entrypoint`);
    expect(design).toContain('none as built (the bot or daemon starts it)');
    expect(design).toContain('Foreign-owned or mismatched-data containers are refused untouched');
    expect(design).toContain('before resolving a replacement image');

    // The manager resolves ownership before admitting a replacement image and
    // mutates the inspected immutable identity rather than a reusable name.
    expect(source).toContain('id = validateOwnership(existing, owner, dataDir, true);');
    expect(source).toContain('await docker.stop(id);');
    expect(source).toContain('await docker.remove(id);');
    expect(source).not.toContain('await docker.remove(config.containerName)');
    expect(source).toContain('await staleBindMount(docker, id, dataDir)');
    const ownership = source.indexOf('id = validateOwnership(existing, owner, dataDir, true);');
    const legacyRemoval = source.indexOf('await docker.remove(id);', ownership);
    const imageAdmission = source.indexOf('const image = await resolveSignalImage(', ownership);
    expect(legacyRemoval).toBeGreaterThan(ownership);
    expect(imageAdmission).toBeGreaterThan(legacyRemoval);
  });

  it('packages/memory-mcp-server/CLAUDE.md: memory_recall returns source_segment_ids as structured content', () => {
    const server = readFileSync(join(projectRoot, 'packages/memory-mcp-server/src/server.ts'), 'utf-8');
    expect(server).toMatch(/structuredContent: \{[^}]*source_segment_ids: result\.source_segment_ids/);
    expect(guideText('packages/memory-mcp-server/CLAUDE.md')).toContain(
      'structured output (structuredContent carries source_segment_ids, the ids memory_expand takes)',
    );
  });

  it('src/docker/CLAUDE.md: describes the batch-mode conversation resume bug without the removed command', () => {
    expect(guideText('src/docker/CLAUDE.md')).toContain(
      'conversation state mount was added to PTY mode but missed in batch mode, so batch conversations could not resume across container recreations',
    );
  });
});
