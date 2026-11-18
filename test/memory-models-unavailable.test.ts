/**
 * `ironcurtain doctor` and `ironcurtain memory prefetch` when the memory
 * server package cannot be loaded (not installed, or not built in a
 * checkout). memory-annotations.ts resolves the package's entry point when it
 * loads and throws then; the doctor must still start and report the problem
 * as a check result instead of crashing before its first check (WP-95).
 */
import { describe, it, expect, vi } from 'vitest';
import type { IronCurtainConfig } from '../src/config/types.js';
import { testUserConfig } from './helpers/user-config.js';

// What loading memory-annotations.ts throws without a resolvable package.
vi.mock('../src/memory/memory-annotations.js', () => {
  throw new Error(
    "Cannot find module '/opt/ironcurtain/node_modules/@provos/memory-mcp-server/dist/index.js'\n" +
      'Require stack:\n- /opt/ironcurtain/dist/memory/memory-annotations.js',
  );
});

const UNAVAILABLE = /^the memory server package could not be loaded: [^\n]+$/;

function configWithMemory(): IronCurtainConfig {
  const userConfig = testUserConfig({
    memory: { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
  });
  return { userConfig } as unknown as IronCurtainConfig;
}

describe('memory models without a loadable memory server package', () => {
  it('reports why instead of throwing', async () => {
    const { runMemoryModelsTool } = await import('../src/memory/memory-models.js');
    const result = await runMemoryModelsTool('verify', { modelsDir: '/tmp/unused-models' });
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringMatching(UNAVAILABLE) });
  });

  it('still lets the doctor load, and its memory check warns', async () => {
    // Importing the doctor's checks must not load memory-annotations.ts.
    const { checkMemoryModels } = await import('../src/doctor/checks.js');
    const result = await checkMemoryModels(configWithMemory());
    expect(result).toMatchObject({
      name: 'Memory models',
      status: 'warn',
      message: expect.stringContaining('could not check: the memory server package could not be loaded'),
    });
  });

  it('makes `ironcurtain memory prefetch` fail with the reason', async () => {
    const { runMemoryCommand } = await import('../src/memory/memory-command.js');
    const errors: string[] = [];
    const code = await runMemoryCommand(['prefetch'], { write: () => undefined, writeError: (t) => errors.push(t) });
    expect(code).toBe(1);
    expect(errors.join('')).toContain(
      'Could not prefetch the memory models: the memory server package could not be loaded',
    );
  });
});
