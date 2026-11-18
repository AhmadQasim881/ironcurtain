/**
 * WP-59: a persona compile (CLI or web UI) runs the policy lint like every
 * other compile. Broad domain access is accepted only with the persona's gated
 * `allowBroadPolicy` opt-in; a directive in the persona constitution does not
 * count, because persona constitutions can be drafted from untrusted content.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { compilePersonaPolicy } from '../src/persona/compile-persona-policy.js';
import { getPersonaConstitutionPath, getPersonaDefinitionPath, getPersonaDir } from '../src/persona/resolve.js';
import { createPersonaName, type PersonaDefinition } from '../src/persona/types.js';
import type { PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import { BROAD_DOMAINS_DIRECTIVE } from '../src/pipeline/policy-lint.js';

const recorded = vi.hoisted(() => ({ runs: [] as PipelineRunConfig[] }));

vi.mock('../src/pipeline/pipeline-runner.js', () => ({
  createPipelineModels: vi.fn(async () => ({})),
  PipelineRunner: class {
    run(config: PipelineRunConfig) {
      recorded.runs.push(config);
      return Promise.resolve({ generatedAt: '', constitutionHash: '', inputHash: '', rules: [] });
    }
  },
}));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(() => ({ protectedPaths: [], mcpServers: {} }) as unknown as IronCurtainConfig),
}));

describe('persona compile: broad-domain opt-in', () => {
  let home: string;
  let savedHome: string | undefined;
  const name = createPersonaName('researcher');

  function writePersona(definition: Partial<PersonaDefinition>): void {
    mkdirSync(getPersonaDir(name), { recursive: true });
    writeFileSync(
      getPersonaDefinitionPath(name),
      JSON.stringify({ name, description: 'd', createdAt: '2026-01-01T00:00:00.000Z', ...definition }),
    );
    writeFileSync(getPersonaConstitutionPath(name), `# Researcher\n\n${BROAD_DOMAINS_DIRECTIVE}\n- Fetch any site.\n`);
  }

  beforeEach(() => {
    savedHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-persona-lint-'));
    process.env.IRONCURTAIN_HOME = home;
    recorded.runs.length = 0;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('does not accept broad domains from a directive in the persona constitution', async () => {
    writePersona({});
    await compilePersonaPolicy(name);
    expect(recorded.runs.map((c) => c.allowBroadDomains)).toEqual([false]);
  });

  it("accepts them with the persona's allowBroadPolicy opt-in", async () => {
    writePersona({ allowBroadPolicy: true });
    await compilePersonaPolicy(name);
    expect(recorded.runs.map((c) => c.allowBroadDomains)).toEqual([true]);
  });
});
