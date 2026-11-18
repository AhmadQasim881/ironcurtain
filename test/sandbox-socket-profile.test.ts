import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseShell } from 'shell-quote';
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import { writeServerSettings } from '../src/trusted-process/sandbox-integration.js';

describe('generated SSH socket scope', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('names only the synthetic socket in the generated macOS profile', () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-profile-scope-')));
    const socket = join(root, 'ssh-agent.socket');
    vi.stubEnv('SSH_AUTH_SOCK', socket);
    const { settingsPath } = writeServerSettings(
      'git',
      {
        allowRead: [],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
        network: { allowedDomains: ['github.com'], deniedDomains: [] },
      },
      root,
      { sshAgent: true },
    );
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { network: { allowUnixSockets: string[] } };
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: true,
      allowUnixSockets: settings.network.allowUnixSockets,
      readConfig: { denyOnly: [], allowWithinDeny: [] },
      writeConfig: { allowOnly: [], denyWithinAllow: [] },
    });
    const argv = parseShell(wrapped);
    const profile = argv[argv.indexOf('-p') + 1];
    expect(profile).toEqual(expect.stringContaining(`(remote unix-socket (subpath ${JSON.stringify(socket)}))`));
    expect(profile).not.toEqual(expect.stringContaining(`(remote unix-socket (subpath ${JSON.stringify(root)}))`));
  });
});
