/**
 * `ironcurtain start --persona <name>` runs the persona's agentModelId unless
 * `--model` is given (WP-126). The command applies the persona's model to the
 * config before its preflight (which checks the builtin model's API key), and
 * hands `--model` to the session as its explicit override, so the session
 * factory never lets the persona's model replace it.
 *
 * The session factory, the mode preflight and the transport are mocked; the
 * persona, its compiled policy and its overrides are real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REAL_TMP } from './fixtures/test-policy.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { SessionOptions } from '../src/session/types.js';

const state = vi.hoisted(() => ({
  sessionOptions: [] as SessionOptions[],
  preflightConfigs: [] as IronCurtainConfig[],
}));

vi.mock('ora', () => ({
  default: () => ({
    start() {
      return this;
    },
    fail() {},
    succeed() {},
  }),
}));

vi.mock('../src/session/index.js', () => ({
  createStandaloneSession: (options: SessionOptions) => {
    state.sessionOptions.push(options);
    return Promise.reject(new Error('stop after session options'));
  },
}));

vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: (options: { config: IronCurtainConfig }) => {
    state.preflightConfigs.push(options.config);
    return Promise.resolve({ mode: { kind: 'builtin' }, reason: 'test' });
  },
  formatModeLine: () => 'Mode: builtin (test)',
}));

vi.mock('../src/session/cli-transport.js', () => ({
  CliTransport: class {
    createEscalationHandler(): () => void {
      return () => {};
    }
    createEscalationExpiredHandler(): () => void {
      return () => {};
    }
    createDiagnosticHandler(): () => void {
      return () => {};
    }
  },
}));

// Partial: resolving the persona checks its policy's breadth, which loads the
// real tool annotations.
vi.mock('../src/config/tool-annotations-overlay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/tool-annotations-overlay.js')>()),
  warnOnAnnotationOverlay: () => {},
}));

vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: () => testConfig(),
  loadGeneratedPolicy: () => ({
    compiledPolicy: { rules: [] },
    toolAnnotations: { servers: {} },
    toolAnnotationsOverlay: undefined,
  }),
  checkConstitutionFreshness: () => {},
  checkAnnotationFreshness: () => {},
}));

import { main } from '../src/index.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-start-persona-model-test-${process.pid}`;
const GLOBAL_MODEL = 'anthropic:claude-sonnet-4-6';
const PERSONA_MODEL = 'anthropic:claude-haiku-4-5';
const CLI_MODEL = 'anthropic:claude-opus-4-6';

function testConfig(): IronCurtainConfig {
  return {
    agentModelId: GLOBAL_MODEL,
    protectedPaths: [],
    mcpServers: {},
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: resolve(TEST_HOME, 'constitution.md'),
    userConfig: {
      agentModelId: GLOBAL_MODEL,
      memory: { enabled: false, autoSave: false },
    },
  } as unknown as IronCurtainConfig;
}

function createPersona(name: string, extra: Record<string, unknown> = {}): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir, 'persona.json'),
    JSON.stringify({ name, description: 'test', createdAt: '2026-11-11T00:00:00.000Z', ...extra }),
  );
  writePersonaPolicy(personaDir);
}

/** Runs `ironcurtain start <args>` until it creates the session (which stops it). */
async function start(args: string[]): Promise<SessionOptions> {
  await expect(main([...args, 'do the task'])).rejects.toThrow('process.exit(1)');
  const options = state.sessionOptions.at(-1);
  if (options === undefined) throw new Error('the session was never created');
  return options;
}

describe('ironcurtain start: persona agent model', () => {
  let stderr: string[];

  beforeEach(() => {
    process.env['IRONCURTAIN_HOME'] = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    state.sessionOptions.length = 0;
    state.preflightConfigs.length = 0;
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['IRONCURTAIN_HOME'];
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("runs the persona's model when --model is not given", async () => {
    createPersona('cheap', { agentModelId: PERSONA_MODEL });

    const options = await start(['--persona', 'cheap']);

    expect(options.persona).toBe('cheap');
    expect(options.agentModelOverride).toBeUndefined();
    expect(options.config?.agentModelId).toBe(PERSONA_MODEL);
    expect(options.config?.userConfig.agentModelId).toBe(PERSONA_MODEL);
    // The preflight checks the model the session will run.
    expect(state.preflightConfigs[0]?.userConfig.agentModelId).toBe(PERSONA_MODEL);
    expect(stderr.join('')).toContain(`Agent model: ${PERSONA_MODEL} (persona "cheap")`);
  });

  it('runs --model over the persona model, as the explicit override', async () => {
    createPersona('cheap', { agentModelId: PERSONA_MODEL });

    const options = await start(['--persona', 'cheap', '--model', CLI_MODEL]);

    expect(options.agentModelOverride).toBe(CLI_MODEL);
    expect(options.config?.agentModelId).toBe(CLI_MODEL);
    expect(state.preflightConfigs[0]?.userConfig.agentModelId).toBe(CLI_MODEL);
  });

  it('keeps the global model for a persona without one', async () => {
    createPersona('plain');

    const options = await start(['--persona', 'plain']);

    expect(options.agentModelOverride).toBeUndefined();
    expect(options.config?.agentModelId).toBe(GLOBAL_MODEL);
  });

  it('refuses a persona with a malformed model before any session work', async () => {
    createPersona('broken', { agentModelId: 'goose' });

    await expect(main(['--persona', 'broken', 'do the task'])).rejects.toThrow('process.exit(1)');

    expect(state.preflightConfigs).toHaveLength(0);
    expect(state.sessionOptions).toHaveLength(0);
    expect(stderr.join('')).toContain('Persona "broken" has an invalid agentModelId');
  });
});
