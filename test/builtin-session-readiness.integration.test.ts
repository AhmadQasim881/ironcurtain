import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { getSessionAuditLogPath } from '../src/config/paths.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { createStandaloneSession } from '../src/session/index.js';
import { resolveSessionMode } from '../src/session/preflight.js';
import { resolveOsSandboxAvailability } from '../src/trusted-process/sandbox-integration.js';
import { createScriptedAnthropicFetch } from './harness/fake-provider.js';
import { isIsolatedVmAvailable } from './helpers/isolated-vm-available.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.skipIf(process.platform !== 'linux' || !isIsolatedVmAvailable())(
  'sends a policy-allowed read from the confined filesystem server back to the configured Anthropic SDK',
  async (ctx) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-builtin-ready-')));
    try {
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      mkdirSync(home);
      mkdirSync(workspace);
      vi.stubEnv('HOME', home);
      vi.stubEnv('IRONCURTAIN_HOME', join(home, '.ironcurtain'));
      vi.stubEnv('IRONCURTAIN_SANDBOX_POLICY', 'enforce');
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-builtin-session');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://provider.invalid');
      vi.stubEnv('HTTPS_PROXY', undefined);
      vi.stubEnv('HTTP_PROXY', undefined);

      // Keep the shipped policy, annotations and filesystem sandbox. Only this
      // backend is needed for the smoke, so no other services are started.
      const base = loadConfig({ readOnly: true });
      const config = { ...base, mcpServers: { filesystem: base.mcpServers.filesystem } };
      const availability = await resolveOsSandboxAvailability(config.mcpServers);
      if (!availability.available) ctx.skip(availability.problems.join(', '));
      const { mode } = await resolveSessionMode({ config, requestedAgent: 'builtin' as AgentId });
      expect(mode.kind).toBe('builtin');

      const path = join(workspace, 'note.txt');
      const marker = randomUUID();
      writeFileSync(path, marker);
      const provider = createScriptedAnthropicFetch([
        { kind: 'tool', code: `return filesystem.read_text_file({ path: ${JSON.stringify(path)} });` },
        { kind: 'text', text: 'Read complete.' },
      ]);
      const fetch: typeof globalThis.fetch = (url, init) => {
        expect(url instanceof Request ? url.url : url.toString()).toBe('https://provider.invalid/v1/messages');
        expect(new Headers(init?.headers).get('x-api-key')).toBe('test-builtin-session');
        return provider.fetch(url, init);
      };
      vi.stubGlobal('fetch', fetch);

      const session = await createStandaloneSession({ config, mode, workspacePath: workspace });
      try {
        expect(await session.sendMessage('Read note.txt from the workspace.')).toBe('Read complete.');
        expect(provider.rejections).toEqual([]);
        expect(provider.requests).toHaveLength(2);
        expect(JSON.stringify(provider.requests[1].messages.at(-1))).toContain(marker);

        const audit = readFileSync(getSessionAuditLogPath(session.getInfo().id), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown);
        expect(audit).toContainEqual(
          expect.objectContaining({
            serverName: 'filesystem',
            toolName: 'read_text_file',
            sandboxed: true,
            policyDecision: expect.objectContaining({ status: 'allow' }),
            result: expect.objectContaining({ status: 'success' }),
          }),
        );
      } finally {
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
