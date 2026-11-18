/**
 * Drift guard for the security documentation: docs/SECURITY_CONCERNS.md,
 * SANDBOXING.md and SECURITY.md.
 *
 * The audit found these documents describing a container posture, a network
 * topology, resource limits and a sandbox disposition the code no longer had
 * (DTL-8, DOA-5, DOA-12, DINF-25). This test keeps the checkable part of them
 * honest:
 *
 * - each document that carries a "Last verified against code" line has one
 *   with a date and a commit;
 * - every repository path the documents cite in backticks exists, so a claim
 *   that names its implementing module cannot point at a module that moved;
 * - every local link resolves, and links into these documents name a heading
 *   that exists;
 * - the facts they state as names and numbers match the code: the
 *   capabilities agent containers keep, the default container limits, the
 *   transport sidecar limits, the MITM tunnel idle timeouts, the Apple
 *   `container` version floor and topology, the mux arming delay, and which
 *   shipped MCP servers run without an OS sandbox;
 * - Code Mode tool stubs block the isolate until the host settles the call,
 *   which reaches the coordinator in-process (no stdio hop);
 * - the limits they state for a control hold in code, so a document cannot
 *   promise more than the control delivers (the review found it doing so):
 *   what a nested Apple session's fully visible `/proc` leaves to the VM,
 *   which fetch destinations policy denies outright, how registry request
 *   paths and PyPI list entries are matched, and how an exchange with
 *   unreported usage is charged;
 * - the overclaims a follow-up review found after the documentation run stay
 *   gone, and the corrected statements match the code: approved passthrough
 *   hosts are relayed without TLS termination, one host on one port, opened
 *   only by a human; outbound content assessment is off by default; the
 *   policy model writes and judges its own verification scenarios unless a
 *   verifier model is named; Docker sessions refresh Keychain credentials
 *   and write them back, with no keep-newer check; no lockfile is published,
 *   the audit gate covers the locked tree a release is built from, audit
 *   allowlist entries expire, and only the two native modules run install
 *   scripts in a development install (a global install runs the others');
 *   and the egress each nested-Docker network mode adds;
 * - SECURITY.md keeps a way around a documented mitigation in scope;
 * - the pull request template asks for a re-check of these documents when
 *   `src/docker/` or `src/trusted-process/` changes.
 *
 * When one of these facts changes in code, update the documents in the same
 * change. Their "Last verified" lines move only with a full re-check.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ACCEPTANCE_DAYS } from '../scripts/check-npm-audit.js';
import { USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';
import { AGENT_SUDO_CAPABILITIES } from '../src/docker/agent-privileges.js';
import { APPLE_FULLY_VISIBLE_PROC_ARGS, checkAppleContainerAvailable } from '../src/docker/apple-container-manager.js';
import { createBudgetGate, ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN } from '../src/docker/budget-gate.js';
import { AGENT_OPEN_FILES_LIMIT, TRANSPORT_SIDECAR_LIMITS } from '../src/docker/docker-infrastructure.js';
import { DEFAULT_MITM_RESOURCE_LIMITS } from '../src/docker/mitm-resource-limits.js';
import { resolveNetworkTopology } from '../src/docker/network-topology.js';
import { isTokenExpired, type OAuthCredentials } from '../src/docker/oauth-credentials.js';
import { OAuthTokenManager } from '../src/docker/oauth-token-manager.js';
import { PACKAGE_EGRESS_AUDIT_HOSTS } from '../src/docker/package-egress-proxy.js';
import { createPackageValidator } from '../src/docker/package-validator.js';
import { parsePassthroughTarget, proxyPolicyRules } from '../src/docker/proxy-tools.js';
import { parsePypiSimpleUrl } from '../src/docker/registry-proxy.js';
import { checkRegistryRequestPath } from '../src/docker/registry-request-path.js';
import { DOCKER_WORKLOAD_NETWORK_ACCESS, resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import * as logger from '../src/logger.js';
import { buildMemoryServerConfig } from '../src/memory/memory-annotations.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-server-name.js';
import { ESCALATION_ARMING_DELAY_MS } from '../src/mux/escalation-picker-state.js';
import { isLocalOrMetadataHost } from '../src/trusted-process/domain-utils.js';
import { BASELINE_CREDENTIAL_DENY_READ } from '../src/trusted-process/sandbox-integration.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SECURITY_CONCERNS = 'docs/SECURITY_CONCERNS.md';
const SANDBOXING = 'SANDBOXING.md';
const SECURITY_POLICY = 'SECURITY.md';
const SECURITY_DOCS = [SECURITY_CONCERNS, SANDBOXING, SECURITY_POLICY] as const;

/** Top-level directories whose files the documents cite as implementing modules. */
const REPOSITORY_PATH_PREFIXES = ['src/', 'docker/', 'packages/', 'scripts/', 'config/', 'test/', '.github/', 'docs/'];

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Backticked spans of a Markdown document, outside fenced code blocks. */
function codeSpans(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gmu, '');
  return [...prose.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
}

/** Backticked spans that name a repository file or directory. */
function citedRepositoryPaths(markdown: string): string[] {
  return codeSpans(markdown).filter(
    (span) =>
      REPOSITORY_PATH_PREFIXES.some((prefix) => span.startsWith(prefix)) &&
      !/[\s<>*{}|]/u.test(span) &&
      !span.includes('...'),
  );
}

/** Targets of inline Markdown links that stay inside the repository. */
function localLinkTargets(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gmu, '');
  return [...prose.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/iu.test(target));
}

/**
 * GitHub's heading anchor for a Markdown heading: emphasis and code markers
 * dropped, lower-cased, punctuation removed, spaces turned into hyphens.
 */
function headingSlug(heading: string): string {
  return heading
    .replace(/[`*]/gu, '')
    .replace(/(^|\s)_+|_+(\s|$)/gu, '$1$2')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

function headingSlugs(markdown: string): Set<string> {
  const prose = markdown.replace(/^```[\s\S]*?^```/gmu, '');
  return new Set([...prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)].map((match) => headingSlug(match[1])));
}

/** The rows of the first Markdown table whose header row contains `headerCell`, as trimmed cells. */
function tableRows(markdown: string, headerCell: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith('|') && line.includes(headerCell));
  expect(start, `a table with a "${headerCell}" column`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

describe('security documentation', () => {
  it('records when SECURITY_CONCERNS.md and SANDBOXING.md were last verified against the code', () => {
    for (const doc of [SECURITY_CONCERNS, SANDBOXING]) {
      expect(readRepoFile(doc), doc).toMatch(
        /Last verified against code:?\**:? \d{4}-\d{2}-\d{2}, at commit `[0-9a-f]{7,40}`/u,
      );
    }
  });

  it.each(SECURITY_DOCS)('%s cites only repository paths that exist', (doc) => {
    const cited = citedRepositoryPaths(readRepoFile(doc));
    expect(cited.length).toBeGreaterThan(0);
    const missing = cited.filter((path) => !existsSync(resolve(REPO_ROOT, path)));
    expect(missing, `${doc} names files that do not exist`).toEqual([]);
  });

  it('cites an implementing module in every section of SECURITY_CONCERNS.md', () => {
    const sections = readRepoFile(SECURITY_CONCERNS)
      .split(/^#{2,3} /mu)
      .slice(1);
    expect(sections.length).toBeGreaterThan(15);
    for (const section of sections) {
      const title = section.slice(0, section.indexOf('\n'));
      expect(citedRepositoryPaths(section).length, `section "${title}" names no module`).toBeGreaterThan(0);
    }
  });

  it.each(SECURITY_DOCS)('%s links only to local files and headings that exist', (doc) => {
    const docDir = dirname(resolve(REPO_ROOT, doc));
    const broken: string[] = [];
    for (const target of localLinkTargets(readRepoFile(doc))) {
      const hashIndex = target.indexOf('#');
      const file = hashIndex < 0 ? target : target.slice(0, hashIndex);
      const anchor = hashIndex < 0 ? undefined : target.slice(hashIndex + 1);
      const targetPath = file === '' ? resolve(REPO_ROOT, doc) : resolve(docDir, file);
      if (!existsSync(targetPath)) {
        broken.push(target);
        continue;
      }
      const isSecurityDoc = SECURITY_DOCS.some((securityDoc) => resolve(REPO_ROOT, securityDoc) === targetPath);
      if (anchor !== undefined && isSecurityDoc && !headingSlugs(readFileSync(targetPath, 'utf8')).has(anchor)) {
        broken.push(target);
      }
    }
    expect(broken, `${doc} has broken links`).toEqual([]);
  });

  it('lists the capabilities agent containers keep for sudo', () => {
    const listed = AGENT_SUDO_CAPABILITIES.join(', ');
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(listed);
    expect(readRepoFile(SANDBOXING)).toContain(listed);
  });

  it('states the default agent container limits', () => {
    const { memoryMb, cpus, pidsLimit } = USER_CONFIG_DEFAULTS.dockerResources;
    for (const doc of [SECURITY_CONCERNS, SANDBOXING]) {
      const text = readRepoFile(doc);
      expect(text, doc).toContain(`${memoryMb} MB`);
      expect(text, doc).toContain(`${cpus} CPUs`);
      expect(text, doc).toContain(`${pidsLimit} PIDs`);
      expect(text, doc).toContain(`nofile=${AGENT_OPEN_FILES_LIMIT}`);
    }
  });

  it('states the macOS transport sidecar limits', () => {
    const { memoryMb, cpus, pidsLimit, openFilesLimit } = TRANSPORT_SIDECAR_LIMITS;
    const stated = `${memoryMb} MB, ${cpus} CPU, ${pidsLimit} PIDs and ${openFilesLimit} open files`;
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(stated);
    expect(readRepoFile(SANDBOXING)).toContain(stated);
  });

  it('states the passthrough tunnel idle timeouts', () => {
    const minutes = DEFAULT_MITM_RESOURCE_LIMITS.tunnelIdleTimeoutMs / 60_000;
    expect(Number.isInteger(minutes)).toBe(true);
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(`after ${minutes} minutes without traffic`);
    expect(readRepoFile(SANDBOXING)).toContain(`a raw tunnel idle for ${minutes} minutes`);
    // A port-80 tunnel is served as HTTP, under the decrypted-connection idle deadline.
    const port80Minutes = DEFAULT_MITM_RESOURCE_LIMITS.connectionIdleTimeoutMs / 60_000;
    expect(Number.isInteger(port80Minutes)).toBe(true);
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(`port-80 tunnels after ${port80Minutes} minutes without traffic`);
    expect(readRepoFile(SANDBOXING)).toContain(`a port-80 tunnel idle for ${port80Minutes} minutes`);
  });

  it('describes the Apple container backend as the uds topology with its version floor', async () => {
    expect(resolveNetworkTopology('apple-container')).toBe('uds');
    const probe = await checkAppleContainerAvailable(
      () => Promise.resolve({ stdout: 'container CLI version 0.0.1 (build: release)', stderr: '' }),
      { platform: 'darwin', arch: 'arm64', release: '25.0.0' },
    );
    expect(probe.available).toBe(false);
    const floor = /need >= (\d+\.\d+\.\d+)/u.exec(probe.available ? '' : probe.reason)?.[1];
    expect(floor, 'the probe reports its version floor').toBeDefined();
    for (const doc of [SECURITY_CONCERNS, SANDBOXING]) {
      const text = readRepoFile(doc);
      expect(text, doc).toContain(`${floor} or later`);
      expect(text, doc).toMatch(/Apple `container`[^\n]*`uds`|`uds`[^\n]*Apple `container`/u);
    }
  });

  it('says Code Mode tool calls leave the isolate synchronously and reach the policy pipeline in-process', () => {
    // The isolate's tool bridge blocks in applySyncPromise; the UTCP protocol
    // hands each call to the coordinator in this process, with no child process.
    const chain = readRepoFile('src/sandbox/code-mode-chain.ts');
    expect(chain).toContain('Runs `code` as the body of an async function');
    expect(chain).toContain('bridge.applySyncPromise');
    const protocol = readRepoFile('src/sandbox/ironcurtain-protocol.ts');
    expect(protocol).toContain('await coordinator.handleToolCall(');
    expect(protocol).not.toMatch(/node:child_process|StdioClientTransport/u);

    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).not.toContain('exit to the MCP proxy via stdio');
    expect(concerns).toContain(
      'The script runs as the body of an async function, but each stub call blocks the isolate until the host settles it, and the host routes the call in-process, with no stdio or subprocess hop, to the coordinator',
    );
  });

  it('states the mux escalation arming delay', () => {
    const seconds = ESCALATION_ARMING_DELAY_MS / 1000;
    expect(Number.isInteger(seconds)).toBe(true);
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(`drawn in full for ${seconds} second${seconds === 1 ? '' : 's'}`);
  });

  it('shows the OS sandbox disposition of every shipped MCP server', () => {
    const shipped = JSON.parse(readRepoFile('src/config/mcp-servers.json')) as Record<string, { sandbox?: unknown }>;
    const memory = buildMemoryServerConfig({ dbPath: '/nonexistent/memory.db', modelsDir: '/nonexistent/models' });
    const expected: Record<string, boolean> = { [MEMORY_SERVER_NAME]: memory.sandbox !== false };
    for (const [name, server] of Object.entries(shipped)) expected[name] = server.sandbox !== false;

    const rows = tableRows(readRepoFile(SANDBOXING), 'OS sandbox');
    const listed = new Map(rows.map(([server, sandbox]) => [server.replace(/`/gu, ''), sandbox]));
    expect([...listed.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, sandboxed] of Object.entries(expected)) {
      expect(listed.get(name), `SANDBOXING.md row for ${name}`).toMatch(sandboxed ? /^yes\b/u : /^no\b/u);
    }

    const unsandboxed = Object.keys(expected).filter((name) => !expected[name]);
    const concerns = readRepoFile(SECURITY_CONCERNS);
    for (const name of unsandboxed) {
      const spelled = name === MEMORY_SERVER_NAME ? 'the memory server' : `\`${name}\``;
      expect(concerns, `SECURITY_CONCERNS.md names ${name} as unsandboxed`).toContain(spelled);
    }
  });

  it('asks pull requests that touch the security kernel or the Docker layer to re-check these documents', () => {
    const template = readRepoFile('.github/pull_request_template.md');
    const item = template.split('\n').find((line) => line.startsWith('- [ ]') && line.includes('src/docker/'));
    expect(item).toBeDefined();
    expect(item).toContain('src/trusted-process/');
    expect(item).toContain('docs/SECURITY_CONCERNS.md');
    expect(item).toContain('SANDBOXING.md');
    // Checking one change does not verify a whole document: the line records a full re-check.
    expect(item).toContain('"Last verified against code" line moves only when the whole document is re-checked');
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(
      'Whoever re-checks the whole document against the code updates the "Last verified against code" line.',
    );
  });

  it('leaves the VM as the boundary of a nested Apple session with a fully visible /proc', () => {
    // No path under /proc is masked or read-only in that container ...
    expect(APPLE_FULLY_VISIBLE_PROC_ARGS).toEqual(['--read-only-path', 'NONE', '--masked-path', 'NONE']);
    // ... and container root keeps no capability that the document says it lacks.
    expect(AGENT_SUDO_CAPABILITIES).not.toContain('SYS_ADMIN');
    expect(AGENT_SUDO_CAPABILITIES).not.toContain('NET_ADMIN');
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).toContain('Nothing under `/proc` is masked or read-only in that container.');
    expect(concerns).toContain('container root (through sudo) can change kernel settings of the session');
    expect(concerns).toContain('The VM, which runs only this session, is the boundary that holds.');
    // Missing capabilities do not keep root out of sysctls that check only file modes.
    expect(concerns).not.toMatch(/cannot write the sysctls/u);
  });

  it('names which fetch destinations policy denies outright and which the fetch server refuses', () => {
    expect(isLocalOrMetadataHost('localhost')).toBe(true);
    expect(isLocalOrMetadataHost('printer.local')).toBe(true);
    expect(isLocalOrMetadataHost('metadata.google.internal')).toBe(true);
    expect(isLocalOrMetadataHost('169.254.169.254')).toBe(true);
    // A loopback or private address literal is not a structural deny: it escalates.
    expect(isLocalOrMetadataHost('127.0.0.1')).toBe(false);
    expect(isLocalOrMetadataHost('10.0.0.1')).toBe(false);
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(
      "other loopback and private addresses are refused at connect time by the fetch server's own guard (§2c)",
    );
    expect(readRepoFile(SANDBOXING)).toContain(
      'fetches of local names (`localhost`, `*.local`, `*.internal` and similar) and of cloud-metadata names and addresses are denied',
    );
  });

  it('names the SSH private keys the read-containment baseline hides, and no others', () => {
    // The baseline hides the default key names, not ~/.ssh: git's ssh needs its config and known_hosts.
    expect(BASELINE_CREDENTIAL_DENY_READ).toContain('~/.ssh/id_*');
    expect(BASELINE_CREDENTIAL_DENY_READ).not.toContain('~/.ssh');
    const shipped = JSON.parse(readRepoFile('src/config/mcp-servers.json')) as Record<
      string,
      { sandbox?: unknown } | undefined
    >;
    const gitSandbox = shipped.git?.sandbox;
    const gitDenyRead =
      typeof gitSandbox === 'object' && gitSandbox !== null && 'filesystem' in gitSandbox
        ? (gitSandbox.filesystem as { denyRead?: readonly string[] }).denyRead
        : undefined;
    expect(gitDenyRead).toBeDefined();
    expect(gitDenyRead).not.toContain('~/.ssh');
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).toContain('the default-named SSH private keys `~/.ssh/id_*`');
    expect(concerns).toContain('a key file under another name stays readable to it');
    const sandboxing = readRepoFile(SANDBOXING);
    expect(sandboxing).toContain('SSH private keys at their default names `~/.ssh/id_*`');
    expect(sandboxing).not.toContain('SSH through ssh-agent only');
  });

  it('describes which registry request paths are refused, and that well-formed escapes are not', () => {
    // A path may carry percent-encoding: npm requests a scoped packument as `@scope%2fname`.
    expect(checkRegistryRequestPath('npm', '/@types%2fnode').ok).toBe(true);
    expect(checkRegistryRequestPath('npm', '/@types%2Fnode/-/node-1.0.0.tgz').ok).toBe(true);
    // What the documents list is refused.
    for (const path of ['/a/%2e%2e/b', '/a%25b', '/a\\b', '/a//b', '/.hidden', '/a/%2fb', '/café']) {
      expect(checkRegistryRequestPath('npm', path).ok, path).toBe(false);
    }
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(
      "a percent-encoded `.`, `\\`, `%`, `?` or `#`, an encoded `/` anywhere but npm's `@scope%2fname`",
    );
  });

  it('discloses that PyPI list entries match only in their PEP 503 form', () => {
    const requested = parsePypiSimpleUrl('/simple/typing_extensions/');
    if (requested === undefined) throw new Error('the PyPI Simple URL did not parse');
    expect(requested.name).toBe('typing-extensions');
    // An entry spelled the way the project publishes its name does not deny it ...
    const asPublished = createPackageValidator({ deniedPackages: ['typing_extensions'], quarantineDays: 0 });
    expect(asPublished.validate(requested, undefined).status).toBe('allow');
    // ... the normalized spelling does.
    const normalized = createPackageValidator({ deniedPackages: ['typing-extensions'], quarantineDays: 0 });
    expect(normalized.validate(requested, undefined).status).toBe('deny');
    expect(readRepoFile(SECURITY_CONCERNS)).toContain(
      'a `deniedPackages` entry `typing_extensions` never matches; write `typing-extensions`',
    );
    expect(readRepoFile(SANDBOXING)).toContain('(`typing-extensions`, not `typing_extensions`)');
  });

  it('states how the budget gate charges an exchange whose usage was never reported', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const gate = createBudgetGate({ mode: 'session', limits: { maxTotalTokens: null, maxEstimatedCostUsd: null } });
      const requestBytes = 30_000;
      const admission = gate.admit({
        protocol: 'anthropic-messages',
        model: 'claude-sonnet-4-5',
        outputCapTokens: 1,
        requestBytes,
      });
      if (!admission.admitted) throw new Error(admission.refusal.message);
      admission.ticket.markDelivered();
      admission.ticket.markUpstreamStatus(200);
      // Settled without an observed exchange: no usage report ever arrived.
      admission.ticket.settle();
      expect(gate.snapshot().totalTokens).toBe(1 + Math.ceil(requestBytes / ESTIMATED_REQUEST_BYTES_PER_INPUT_TOKEN));
    } finally {
      warn.mockRestore();
    }
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).toContain('its output cap plus an input estimate from the size of the request body');
    expect(concerns).not.toContain('charged its output cap only');
  });

  it('describes an approved passthrough host as an uninspected relay of one host and port that only a human opens', () => {
    // An approval is `host:port`: 443 unless the agent names 80, never another port.
    expect(parsePassthroughTarget('api.example.com')).toEqual({ host: 'api.example.com', port: 443 });
    expect(parsePassthroughTarget('api.example.com:80')).toEqual({ host: 'api.example.com', port: 80 });
    expect(() => parsePassthroughTarget('api.example.com:8443')).toThrow();
    const addDomain = proxyPolicyRules.find((rule) => rule.if.tool?.includes('add_proxy_domain'));
    expect(addDomain?.then).toBe('escalate');
    expect(addDomain?.humanOnly).toBe(true);

    // The 443 relay is a raw tunnel pinned to the approved SNI: the proxy never
    // decrypts it, so nothing in it is audited, filtered or given a credential.
    const sandboxing = readRepoFile(SANDBOXING);
    expect(sandboxing).not.toMatch(/still terminated|terminated for auditability/u);
    expect(sandboxing).toContain('Approved hosts get a **passthrough tunnel**: TLS is **not** terminated');
    expect(sandboxing).toContain('An approval covers one host on one port (443 by default, or 80)');
    // The deprecated escape hatch is not a stop-gap for workflows, whose escalations are routed.
    expect(sandboxing).not.toContain('escalation plumbing');
    expect(sandboxing).toContain('the flag is ignored while `egressPolicy.enabled` is on');
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).toContain(
      'an approved destination gets a **passthrough tunnel**: traffic is relayed without content inspection',
    );
    expect(concerns).toContain('`add_proxy_domain` is a hardcoded `escalate` rule marked `humanOnly`');
  });

  it('presents outbound content assessment as an opt-in that is off by default', () => {
    expect(USER_CONFIG_DEFAULTS.contentAssessment.enabled).toBe(false);
    expect(USER_CONFIG_DEFAULTS.contentAssessment.llmCheck).toBe(false);
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).toContain('**Opt-in outbound content assessment** (`contentAssessment.enabled`, default off;');
    expect(concerns).toContain('**Residual risk:** Both checks are off by default.');
    expect(concerns).not.toContain('**Traffic Analysis:**');
  });

  it('says the policy model writes and judges its own verification scenarios unless a verifier model is named', () => {
    // No verifier model by default: createPipelineModels then lets the policy model do both.
    expect(Object.keys(USER_CONFIG_DEFAULTS)).not.toContain('policyVerifierModelId');
    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).not.toMatch(/separate LLM generates/u);
    expect(concerns).toContain(
      'Unless `policyVerifierModelId` names another model, that model is the policy model itself, in a separate session',
    );
    expect(concerns).toContain('The verifier is still an LLM, and by default the model that wrote the rules');
  });

  it('says a Docker session refreshes Keychain credentials itself and writes them back to the Keychain', async () => {
    // "Within 5 minutes of expiry" is when a token counts as expired.
    expect(isTokenExpired({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 4 * 60_000 })).toBe(true);
    expect(isTokenExpired({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 6 * 60_000 })).toBe(false);

    const expiring: OAuthCredentials = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: Date.now() };
    const refreshed: OAuthCredentials = {
      accessToken: 'new',
      refreshToken: 'refresh-new',
      expiresAt: Date.now() + 3_600_000,
    };
    const writeToKeychain = vi.fn();
    const saveCredentials = vi.fn(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const manager = new OAuthTokenManager(
        expiring,
        { canRefresh: true },
        {
          loadCredentials: () => null,
          loadFromKeychain: () => expiring,
          refreshToken: () => Promise.resolve(refreshed),
          saveCredentials,
          credentialsFilePath: '/nonexistent/.credentials.json',
          writeToKeychain,
          keychainServiceName: 'Claude Code-credentials',
        },
      );
      // Neither the file nor the Keychain holds a valid token: the session refreshes it.
      expect(await manager.getValidAccessToken()).toBe('new');
    } finally {
      info.mockRestore();
    }
    expect(writeToKeychain).toHaveBeenCalledWith(refreshed, 'Claude Code-credentials');
    expect(saveCredentials).not.toHaveBeenCalled();

    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).not.toContain('never performs its own refresh grant');
    expect(concerns).toContain(
      'a session whose credentials came from the macOS Keychain refreshes them itself whenever they carry a refresh token',
    );
    expect(concerns).toContain(
      'the token goes on the stdin of `security -i`, never on argv, and the entry is read back',
    );
    expect(concerns).toContain(
      '`ironcurtain doctor` never writes the Keychain and refreshes only with `--check-refresh`',
    );
    // The read-back verifies the write; it is no keep-newer check
    // (test/oauth-keychain-write.test.ts), so the residual must not read as if
    // nothing were compared at all.
    expect(concerns).not.toContain('are not compared against the Keychain entry again after the grant');
    expect(concerns).toContain(
      'Keychain write-backs have no keep-newer check: after the grant the entry is read only to keep its other fields',
    );
  });

  it('says how host dependencies are pinned, audited and allowed to run install scripts', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as {
      files: string[];
      dependencies: Record<string, string>;
      allowScripts: Record<string, unknown>;
    };
    // No lockfile reaches users: there is no shrinkwrap and the lockfile is not a published file.
    expect(existsSync(resolve(REPO_ROOT, 'npm-shrinkwrap.json'))).toBe(false);
    expect(manifest.files.filter((entry) => entry.includes('package-lock'))).toEqual([]);
    for (const name of ['isolated-vm', '@modelcontextprotocol/server-filesystem', '@cyanheads/git-mcp-server']) {
      expect(manifest.dependencies[name], `${name} is pinned exactly`).toMatch(/^\d/u);
    }
    // These are the two explicitly allowed native modules. Unlisted scripts
    // still run in ordinary project installs unless strict mode is enabled.
    const allowed = Object.keys(manifest.allowScripts).filter((name) => manifest.allowScripts[name] === true);
    expect(allowed.sort()).toEqual(['isolated-vm', 'node-pty']);

    const concerns = readRepoFile(SECURITY_CONCERNS);
    expect(concerns).not.toContain('Strict use of lockfiles');
    expect(concerns).toContain('it is not published: the package ships no lockfile or shrinkwrap');
    expect(concerns).toContain(`expires at most ${MAX_ACCEPTANCE_DAYS} days after its review`);
    expect(concerns).toContain(
      '`isolated-vm` and `node-pty` may build; scripts of packages mapped to `false` are skipped',
    );
    expect(concerns).toContain('A dependency with no entry still runs its lifecycle scripts');
    expect(concerns).toContain('The repository does not enable strict mode');
    expect(concerns).toContain('`npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`');
    // The gate audits the locked tree a release is built from
    // (test/github-workflows.test.ts orders it before the build), not what an
    // installed copy resolves later.
    expect(concerns).not.toContain('a release does not ship an advisory nobody reviewed');
    expect(concerns).toContain(
      'no release is built while the locked production tree has a high or critical advisory nobody reviewed',
    );

    // Production dependencies other than the two native modules run install
    // scripts, and a global install ignores allowScripts.
    const lock = JSON.parse(readRepoFile('package-lock.json')) as {
      packages: Record<string, { hasInstallScript?: boolean; dev?: boolean; devOptional?: boolean } | undefined>;
    };
    const productionWithScripts = Object.entries(lock.packages)
      .filter(([path, entry]) => path.startsWith('node_modules/') && entry?.hasInstallScript === true)
      .filter(([, entry]) => entry?.dev !== true && entry?.devOptional !== true)
      .map(([path]) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(productionWithScripts).toEqual(expect.arrayContaining(['onnxruntime-node', 'protobufjs']));
    expect(concerns).toContain(
      "Unless the user's npm configuration blocks unreviewed install scripts, a global install also runs the install script of every dependency that has one.",
    );
  });

  it('lists the egress each nested-Docker network mode adds', () => {
    expect([...DOCKER_WORKLOAD_NETWORK_ACCESS].sort()).toEqual(['images', 'offline', 'packages']);
    // An enabled block that names no mode gets image pulls only.
    const resolved = resolveDockerWorkloadConfig({ enabled: true });
    if (!resolved.enabled) throw new Error('nested Docker did not resolve as enabled');
    expect(resolved.networkAccess).toBe('images');
    // Image pulls reach Docker Hub and GHCR only ...
    const registries = JSON.parse(readRepoFile('config/docker-workload/registry-egress-manifest.json')) as {
      origins: { destination: { hostname: string } }[];
    };
    expect(registries.origins.map((origin) => origin.destination.hostname).sort()).toEqual([
      'auth.docker.io',
      'ghcr.io',
      'registry-1.docker.io',
    ]);
    // ... and package mode the fixed apt, npm, PyPI and Cargo hosts.
    expect([...PACKAGE_EGRESS_AUDIT_HOSTS].sort()).toEqual([
      'crates.io',
      'deb.debian.org',
      'files.pythonhosted.org',
      'index.crates.io',
      'pypi.org',
      'registry.npmjs.org',
      'security.debian.org',
      'static.crates.io',
    ]);

    const sandboxing = readRepoFile(SANDBOXING);
    expect(sandboxing).toContain(
      'with `networkAccess` `images` (the default when the field is unset) the daemon pulls images from Docker Hub and GHCR',
    );
    expect(sandboxing).toContain(
      '`packages` also lets any process of the session download from the fixed public apt, npm, PyPI and Cargo repositories',
    );
    expect(sandboxing).toContain('`offline` adds no egress');
  });

  it('keeps a way around a documented mitigation in scope for security reports', () => {
    const policy = readRepoFile(SECURITY_POLICY);
    const start = policy.indexOf('The following are **out of scope**');
    const end = policy.indexOf('## Security Architecture');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const outOfScope = policy.slice(start, end);
    const accepted = outOfScope.split('\n').find((line) => line.includes('documents as accepted'));
    expect(accepted).toBeDefined();
    expect(accepted).toContain('A way around a mitigation that document describes');
    expect(accepted).toContain('is in scope');
  });
});
