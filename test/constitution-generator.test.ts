/**
 * Tests for constitution generator prompt construction and response parsing
 * (pure functions), and for the generator session's exploration directory:
 * a throwaway clone of the job's repository (WP-134, WFC-25). The session
 * factory is mocked; the clone is a real one of a local `file://` repository
 * (or, to hold a clone in flight, of an ssh URL served by a stand-in ssh).
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  buildConstitutionGeneratorSystemPrompt,
  generateConstitution,
  parseConstitutionResponse,
} from '../src/cron/constitution-generator.js';
import { createSession } from '../src/session/index.js';
import type { Session, SessionInfo, SessionOptions } from '../src/session/types.js';
import { createGitSyncFixture, gitAvailable, posix, type GitSyncFixture } from './fixtures/git-sync-fixture.js';

vi.mock('../src/session/index.js', () => ({ createSession: vi.fn() }));

describe('buildConstitutionGeneratorSystemPrompt', () => {
  it('includes the task description', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt(
      'Label all open GitHub issues older than 7 days',
      '/home/user/workspace',
    );
    expect(prompt).toContain('Label all open GitHub issues older than 7 days');
  });

  it('includes the workspace path', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/home/user/workspace');
    expect(prompt).toContain('/home/user/workspace');
  });

  it('includes the git repo when provided', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt(
      'Some task',
      '/home/user/workspace',
      'git@github.com:org/repo.git',
    );
    expect(prompt).toContain('git@github.com:org/repo.git');
  });

  it('names the git repository without the credentials its URL embeds', () => {
    // A gitRepo is stored as entered; validation (and the clone) trim it.
    const urls = [
      'https://x-access-token:ghp_PromptSecret@github.com/org/repo.git',
      ' https://x-access-token:ghp_PromptSecret@github.com/org/repo.git\n',
    ];
    for (const url of urls) {
      for (const context of ['cron', 'persona'] as const) {
        const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/tmp/clone', url, context);
        expect(prompt).toContain('Git repository: https://github.com/org/repo.git\n');
        expect(prompt).not.toContain('ghp_PromptSecret');
      }
    }
  });

  it('indicates no git repo when not provided', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/home/user/workspace');
    expect(prompt).toContain('No git repository configured');
  });

  it('instructs the LLM about exploration', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('Explore');
    expect(prompt).toContain('execute_code');
  });

  it('instructs the LLM about output format', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('"constitution"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"exploredServers"');
  });

  it('explains structural rules and workspace auto-allow', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('Workspace auto-allow');
    expect(prompt).toContain('Default-deny');
    expect(prompt).toContain('/workspace');
  });

  it('explains cron context — unattended, no human to approve', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('unattended');
    expect(prompt).toContain('no human');
  });

  it('points a job with a git repository at the clone of it and its key files', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/tmp/clone', 'git@github.com:org/repo.git');
    expect(prompt).toContain("A temporary clone of the job's git repository is at: /tmp/clone");
    expect(prompt).toContain('README, package.json');
    expect(prompt).toContain('git remotes');
  });

  it('does not send a job without a git repository looking for project files', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/tmp/scratch');
    expect(prompt).toContain('there are no\nproject files to explore');
    expect(prompt).not.toContain('README');
    expect(prompt).not.toContain('git remotes');
  });
});

/** Minimal session whose single turn answers with `response`. */
function fakeSession(response: string): Session {
  return {
    getInfo: () =>
      ({ id: 'constgen-test', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage: vi.fn(async () => response),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    resolveEscalation: vi.fn(),
    getPendingEscalations: () => [],
    getBudgetStatus: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

const GENERATED = [
  '```json',
  '{"constitution": " - The agent may read the repository", "reasoning": "A Node project", "exploredServers": ["filesystem"]}',
  '```',
].join('\n');

/** The `exit` listeners registered since `before`: the generator's exit hook while it runs. */
function addedExitListeners(before: readonly NodeJS.ExitListener[]): NodeJS.ExitListener[] {
  return process.listeners('exit').filter((listener) => !before.includes(listener));
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!gitAvailable || !posix)('generateConstitution exploration directory', () => {
  let f: GitSyncFixture;
  /** The OS temp dir the generator sees (TMPDIR), so leftovers are visible. */
  let tmp: string;

  /** What the generator handed the session factory, read while the session exists. */
  interface SeenSession {
    readonly workspacePath: string;
    readonly entries: readonly string[];
    readonly prompt: string;
    readonly readme?: string;
    readonly origin?: string;
  }

  /** Makes createSession record what it was given and answer with GENERATED. */
  function recordSessions(): { readonly seen: SeenSession[]; readonly session: Session } {
    const seen: SeenSession[] = [];
    const session = fakeSession(GENERATED);
    vi.mocked(createSession).mockImplementation(async (options?: SessionOptions) => {
      const workspacePath = options?.workspacePath ?? '';
      const entries = readdirSync(workspacePath).sort();
      seen.push({
        workspacePath,
        entries,
        prompt: options?.systemPromptAugmentation ?? '',
        ...(entries.includes('README.md')
          ? {
              readme: readFileSync(join(workspacePath, 'README.md'), 'utf8'),
              origin: f.git(workspacePath, 'config', '--get', 'remote.origin.url').trim(),
            }
          : {}),
      });
      return session;
    });
    return { seen, session };
  }

  beforeEach(() => {
    f = createGitSyncFixture();
    f.commitUpstream({ 'README.md': '# Demo project\n', 'package.json': '{ "name": "demo" }\n' }, 'init');
    tmp = join(f.root, 'tmp');
    mkdirSync(tmp);
    vi.stubEnv('TMPDIR', tmp);
    vi.stubEnv('IRONCURTAIN_HOME', join(f.root, 'ironcurtain-home'));
    // The clone's host git reads only the fixture's own global config.
    vi.stubEnv('HOME', f.home);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.mocked(createSession).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    f.cleanup();
  });

  it("runs the session in a throwaway clone of the job's repository and deletes it afterwards", async () => {
    const { seen, session } = recordSessions();
    const exitListenersBefore = process.listeners('exit');

    const result = await generateConstitution({ taskDescription: 'Summarize the README', gitRepo: f.uri });

    expect(result.constitution).toBe('- The agent may read the repository');
    expect(seen).toHaveLength(1);
    const [first] = seen;
    // The session's allowedDirectory is a clone under the OS temp dir, never
    // the job workspace under the IronCurtain home.
    expect(first.workspacePath.startsWith(tmp + sep)).toBe(true);
    expect(first.entries).toEqual(['.git', 'README.md', 'package.json']);
    expect(first.readme).toBe('# Demo project\n');
    expect(first.origin).toBe(f.uri);
    expect(first.prompt).toContain(`A temporary clone of the job's git repository is at: ${first.workspacePath}`);
    expect(first.prompt).toContain('README, package.json');
    expect(session.close).toHaveBeenCalledTimes(1);
    // The clone and its mirror are gone, and so is the exit hook.
    expect(readdirSync(tmp)).toEqual([]);
    expect(addedExitListeners(exitListenersBefore)).toEqual([]);
  });

  it('starts no session when the repository cannot be cloned, and leaves nothing behind', async () => {
    recordSessions();

    await expect(
      generateConstitution({ taskDescription: 'Summarize the README', gitRepo: `file://${join(f.root, 'missing')}` }),
    ).rejects.toThrow("could not clone the job's git repository for exploration");

    expect(createSession).not.toHaveBeenCalled();
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('a cancelled clone starts no session and leaves nothing behind', async () => {
    recordSessions();
    const cancel = new AbortController();
    cancel.abort();

    await expect(
      generateConstitution({ taskDescription: 'Summarize the README', gitRepo: f.uri, signal: cancel.signal }),
    ).rejects.toThrow('constitution generation was cancelled');

    expect(createSession).not.toHaveBeenCalled();
    expect(readdirSync(tmp)).toEqual([]);
  });

  // In a terminal, clack's spinner turns Ctrl-C or Escape into process.exit(),
  // which skips every `finally`: only `exit` listeners run. Here a stand-in
  // ssh holds `git ls-remote` in flight, and the test runs the listeners the
  // generator registered, as process.exit() would.
  it('a process exit while cloning kills the clone and removes the throwaway directory', async () => {
    recordSessions();
    mkdirSync(join(f.root, 'bin'));
    const fakeSsh = join(f.root, 'bin', 'ssh');
    const pidFile = join(f.root, 'ssh.pid');
    writeFileSync(fakeSsh, ['#!/bin/sh', `echo $$ > ${pidFile}`, 'exec sleep 120', ''].join('\n'));
    chmodSync(fakeSsh, 0o755);
    vi.stubEnv('GIT_SSH_COMMAND', fakeSsh);
    const exitListenersBefore = process.listeners('exit');

    const generation = generateConstitution({
      taskDescription: 'Summarize the README',
      gitRepo: 'ssh://example.invalid/repo.git',
    });
    const settled = generation.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    let sshPid: number | undefined;
    try {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'the clone to start');
      sshPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(isAlive(sshPid)).toBe(true);
      expect(readdirSync(tmp)).toHaveLength(1);

      const hooks = addedExitListeners(exitListenersBefore);
      expect(hooks).toHaveLength(1);
      for (const hook of hooks) hook(0);

      // Synchronously, as an exiting process needs it: the directory is gone.
      expect(readdirSync(tmp)).toEqual([]);
      // The clone's process group (git, and the ssh it runs) was killed.
      const killed = sshPid;
      await waitFor(() => !isAlive(killed), 'the stand-in ssh to be killed', 5_000);
      expect(await settled).toBe('constitution generation was cancelled');
      expect(createSession).not.toHaveBeenCalled();
      expect(readdirSync(tmp)).toEqual([]);
      expect(addedExitListeners(exitListenersBefore)).toEqual([]);
    } finally {
      // Should an assertion fail, do not leave the stand-in ssh (and git) running.
      if (sshPid !== undefined && isAlive(sshPid)) process.kill(sshPid, 'SIGKILL');
    }
  }, 40_000);

  it('a process exit during the session removes the throwaway directory', async () => {
    const exitListenersBefore = process.listeners('exit');
    let existedAfterExit: boolean | undefined;
    vi.mocked(createSession).mockImplementation(async (options?: SessionOptions) => {
      for (const hook of addedExitListeners(exitListenersBefore)) hook(0);
      existedAfterExit = existsSync(options?.workspacePath ?? '');
      return fakeSession(GENERATED);
    });

    await generateConstitution({ taskDescription: 'Summarize the README', gitRepo: f.uri });

    expect(existedAfterExit).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
    expect(addedExitListeners(exitListenersBefore)).toEqual([]);
  });

  it('removes the throwaway directory even when closing the session fails', async () => {
    const { session } = recordSessions();
    vi.mocked(session.close).mockRejectedValueOnce(new Error('MCP teardown failed'));
    const exitListenersBefore = process.listeners('exit');

    await expect(generateConstitution({ taskDescription: 'Summarize the README', gitRepo: f.uri })).rejects.toThrow(
      'MCP teardown failed',
    );

    expect(readdirSync(tmp)).toEqual([]);
    expect(addedExitListeners(exitListenersBefore)).toEqual([]);
  });

  it('without a git repository, the session gets an empty throwaway directory', async () => {
    const { seen } = recordSessions();

    await generateConstitution({ taskDescription: 'Check the weather' });

    expect(seen).toHaveLength(1);
    expect(seen[0].workspacePath.startsWith(tmp + sep)).toBe(true);
    expect(seen[0].entries).toEqual([]);
    expect(seen[0].prompt).toContain(`Your scratch directory is: ${seen[0].workspacePath}`);
    expect(seen[0].prompt).not.toContain('README');
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('shows a persona its workspace while the session still runs in a throwaway directory', async () => {
    const { seen } = recordSessions();

    await generateConstitution({
      taskDescription: 'Email triage',
      workspacePath: '/home/user/.ironcurtain/personas/assistant/workspace',
      context: 'persona',
    });

    expect(seen[0].workspacePath.startsWith(tmp + sep)).toBe(true);
    expect(seen[0].prompt).toContain(
      'The persona workspace is at: /home/user/.ironcurtain/personas/assistant/workspace',
    );
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe('parseConstitutionResponse', () => {
  it('parses valid JSON in code fences', () => {
    const response = `
I explored the workspace and found the following...

\`\`\`json
{
  "constitution": " - The agent is allowed to read files\\n - The agent must ask for approval before writes",
  "reasoning": "The workspace contains a Node.js project",
  "exploredServers": ["filesystem", "git"]
}
\`\`\`
    `;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('read files');
    expect(result.reasoning).toContain('Node.js');
    expect(result.exploredServers).toEqual(['filesystem', 'git']);
  });

  it('parses raw JSON without code fences', () => {
    const response = `{
  "constitution": " - The agent is allowed to fetch URLs",
  "reasoning": "Simple web task",
  "exploredServers": ["fetch"]
}`;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('fetch URLs');
  });

  it('handles missing optional fields', () => {
    const response = `\`\`\`json
{
  "constitution": " - The agent is allowed to read files"
}
\`\`\``;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('read files');
    expect(result.reasoning).toBe('');
    expect(result.exploredServers).toEqual([]);
  });

  it('throws when no JSON block found', () => {
    const response = 'Here is a constitution without any JSON block.';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when JSON is malformed', () => {
    const response = '```json\n{invalid json}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when constitution field is missing', () => {
    const response = '```json\n{"reasoning": "no constitution"}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when constitution field is empty', () => {
    const response = '```json\n{"constitution": "   "}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('handles JSON embedded in surrounding text', () => {
    const response = `
After exploring the workspace, I found a Python project. Here is the constitution:

\`\`\`json
{
  "constitution": " - The agent is allowed to read Python files\\n - The agent may run pytest",
  "reasoning": "Python project with tests",
  "exploredServers": ["filesystem"]
}
\`\`\`

Let me know if you'd like to adjust anything.
    `;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('Python files');
    expect(result.exploredServers).toEqual(['filesystem']);
  });

  it('handles non-array exploredServers gracefully', () => {
    const response = '```json\n{"constitution": " - read files", "exploredServers": "filesystem"}\n```';
    const result = parseConstitutionResponse(response);
    expect(result.exploredServers).toEqual([]);
  });
});
