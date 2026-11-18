import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  type ConfigTestEnv,
  setupConfigEnv,
  teardownConfigEnv,
  seedConfig,
  readConfig,
  configExists,
} from './helpers/config-test-setup.js';

// Mocks must be defined via vi.hoisted() so they're available when vi.mock() runs
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mocks.select(...args),
  confirm: (...args: unknown[]) => mocks.confirm(...args),
  text: (...args: unknown[]) => mocks.text(...args),
  password: (...args: unknown[]) => mocks.password(...args),
  intro: (...args: unknown[]) => mocks.intro(...args),
  outro: (...args: unknown[]) => mocks.outro(...args),
  note: (...args: unknown[]) => mocks.note(...args),
  cancel: (...args: unknown[]) => mocks.cancel(...args),
  isCancel: (...args: unknown[]) => mocks.isCancel(...args),
  log: mocks.log,
}));

// Host OS-sandbox availability (the dependency check and the srt smoke run,
// as sessions resolve it) is injected so the wizard behaves the same on
// machines with and without a working sandbox. Default: available.
const sandboxMocks = vi.hoisted(() => ({
  availability: vi.fn(() => ({ available: true, platformSupported: true, problems: [] as string[], warnings: [] })),
  /** What the srt smoke run makes of it; default: whatever the dependency check said. */
  smokeVerdict: vi.fn(
    (dependencies: { available: boolean; platformSupported: boolean; problems: string[]; warnings: string[] }) =>
      dependencies,
  ),
}));
vi.mock('../src/trusted-process/sandbox-integration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/trusted-process/sandbox-integration.js')>();
  return {
    ...actual,
    getOsSandboxAvailability: () => sandboxMocks.availability(),
    resolveOsSandboxAvailability: () => Promise.resolve(sandboxMocks.smokeVerdict(sandboxMocks.availability())),
  };
});

// The read-only Claude login probe reads these instead of the real credential
// stores (~/.claude/.credentials.json, the Anthropic CLI store, the macOS
// Keychain), so the wizard behaves the same on machines with and without a
// `claude login`. Default: no login. No refresh or write functions, as in
// the real readOnlyCredentialSources.
const oauthMocks = vi.hoisted(() => ({
  files: vi.fn(
    (): Array<{
      credentials: { accessToken: string; refreshToken: string; expiresAt: number };
      filePath: string;
    }> => [],
  ),
}));
vi.mock('../src/docker/oauth-credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/docker/oauth-credentials.js')>();
  return {
    ...actual,
    readOnlyCredentialSources: {
      loadFromFile: () => null,
      loadFromKeychain: () => null,
      loadFromFilesWithSource: () => oauthMocks.files(),
      loadFromKeychainWithService: () => null,
    },
  };
});

import { collectCredentialNeeds, runFirstStart } from '../src/config/first-start.js';
import { readFirstStartSetupState } from '../src/config/setup-state.js';
import { testUserConfig } from './helpers/user-config.js';

/** A Claude login whose access token is valid for another day. */
function claudeLogin(): {
  credentials: { accessToken: string; refreshToken: string; expiresAt: number };
  filePath: string;
} {
  return {
    credentials: {
      accessToken: 'sk-ant-oat01-test',
      refreshToken: 'sk-ant-ort01-test',
      expiresAt: Date.now() + 86_400_000,
    },
    filePath: '/nonexistent/.claude/.credentials.json',
  };
}

describe('first-start wizard', () => {
  let env: ConfigTestEnv;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedPolicyEnv: { iron: string | undefined; plain: string | undefined } = { iron: undefined, plain: undefined };
  /** Credential variables the wizard reads that setupConfigEnv does not isolate. */
  const EXTRA_ENV = ['IRONCURTAIN_DOCKER_AUTH', 'OPENROUTER_API_KEY', 'ZAI_API_KEY'] as const;
  let savedExtraEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    env = setupConfigEnv('firststart');
    process.env.ANTHROPIC_API_KEY = 'test-key';
    savedExtraEnv = Object.fromEntries(EXTRA_ENV.map((key) => [key, process.env[key]]));
    for (const key of EXTRA_ENV) delete process.env[key];

    vi.clearAllMocks();
    oauthMocks.files.mockReturnValue([]);
    sandboxMocks.availability.mockReturnValue({ available: true, platformSupported: true, problems: [], warnings: [] });
    savedPolicyEnv = { iron: process.env.IRONCURTAIN_SANDBOX_POLICY, plain: process.env.SANDBOX_POLICY };
    delete process.env.IRONCURTAIN_SANDBOX_POLICY;
    delete process.env.SANDBOX_POLICY;
    mocks.isCancel.mockReturnValue(false);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    teardownConfigEnv(env);
    vi.restoreAllMocks();
    if (savedPolicyEnv.iron !== undefined) process.env.IRONCURTAIN_SANDBOX_POLICY = savedPolicyEnv.iron;
    if (savedPolicyEnv.plain !== undefined) process.env.SANDBOX_POLICY = savedPolicyEnv.plain;
    for (const key of EXTRA_ENV) {
      if (savedExtraEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedExtraEnv[key];
    }
  });

  /** Every p.log.warn text of the run. */
  function warnings(): string[] {
    return mocks.log.warn.mock.calls.map((call) => String(call[0]));
  }

  /** Every p.log.success text of the run. */
  function successes(): string[] {
    return mocks.log.success.mock.calls.map((call) => String(call[0]));
  }

  /** Sets up mocks for a basic wizard flow: confirm setup, skip web search, skip GitHub token, choose auto-approve. */
  function setupBasicFlow(autoApprove: boolean): void {
    mocks.confirm.mockResolvedValueOnce(true); // Step 1: continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // Step 4: web search provider
    mocks.confirm.mockResolvedValueOnce(false); // Step 5: skip GitHub token
    mocks.confirm.mockResolvedValueOnce(autoApprove); // Step 6: auto-approve
  }

  it('full flow with auto-approve enabled writes config', async () => {
    setupBasicFlow(true);

    await runFirstStart();

    const config = readConfig(env.testHome);
    expect(config.autoApprove?.enabled).toBe(true);
    expect(mocks.outro).toHaveBeenCalled();
  });

  it('auto-approve declined writes enabled: false', async () => {
    setupBasicFlow(false);

    await runFirstStart();

    const config = readConfig(env.testHome);
    expect(config.autoApprove?.enabled).toBe(false);
  });

  it('cancel at auto-approve step exits', async () => {
    mocks.confirm.mockResolvedValueOnce(true); // continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // skip web search
    mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mocks.cancel).toHaveBeenCalledWith('Setup cancelled.');
  });

  it('cancel at initial confirm exits early', async () => {
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('cancel at auto-approve does not write config', async () => {
    mocks.confirm.mockResolvedValueOnce(true); // continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // skip web search
    mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(configExists(env.testHome)).toBe(false);
  });

  it('points a missing API key at the trusted .env, never a project-directory .env', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    setupBasicFlow(false);

    await runFirstStart();

    const missingKey = warnings().find((text) => text.includes('Missing API key for anthropic'));
    expect(missingKey).toBeDefined();
    expect(missingKey).toContain('export ANTHROPIC_API_KEY=<your-key>');
    expect(missingKey).toContain(`add ANTHROPIC_API_KEY=<your-key> to ${env.testHome}/.env`);
    expect(missingKey).toContain('A .env file in your project directory is not read.');
    expect(missingKey).not.toContain('to a .env file in your project directory');
  });

  describe('setup marker', () => {
    it('records setupCompleted: true when the wizard completes, so start does not run it again', async () => {
      setupBasicFlow(false);

      await runFirstStart();

      expect(readConfig(env.testHome).setupCompleted).toBe(true);
      expect(readFirstStartSetupState()).toBe('completed');
    });

    it('completes setup in a config another command created (setupCompleted: false), keeping its settings', async () => {
      seedConfig(env.testHome, { setupCompleted: false, escalationTimeoutSeconds: 120 });
      expect(readFirstStartSetupState()).toBe('pending');
      setupBasicFlow(true);

      await runFirstStart();

      const config = readConfig(env.testHome);
      expect(config.setupCompleted).toBe(true);
      expect(config.escalationTimeoutSeconds).toBe(120);
      expect(config.autoApprove?.enabled).toBe(true);
    });

    it('a cancelled wizard leaves setup pending', async () => {
      seedConfig(env.testHome, { setupCompleted: false });
      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('skip'); // skip web search
      mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
      mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
      mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

      await expect(runFirstStart()).rejects.toThrow('process.exit');

      expect(readConfig(env.testHome).setupCompleted).toBe(false);
      expect(readFirstStartSetupState()).toBe('pending');
    });
  });

  describe('before ironcurtain start (start mode)', () => {
    it('declining setup returns "declined" without exiting, so the task still runs, and leaves setup pending', async () => {
      seedConfig(env.testHome, { setupCompleted: false });
      mocks.confirm.mockResolvedValueOnce(false); // Continue with setup? No

      await expect(runFirstStart({ mode: 'start' })).resolves.toBe('declined');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(mocks.confirm).toHaveBeenCalledTimes(1);
      // `ironcurtain start` without a task starts an interactive session, so
      // the outro speaks of the session, not of a task.
      expect(mocks.outro).toHaveBeenCalledWith(
        'Setup skipped; starting your session. Run `ironcurtain setup` at any time to complete it.',
      );
      expect(readConfig(env.testHome).setupCompleted).toBe(false);
      expect(readFirstStartSetupState()).toBe('pending');
    });

    it('returns "completed" when the wizard completes', async () => {
      setupBasicFlow(false);

      await expect(runFirstStart({ mode: 'start' })).resolves.toBe('completed');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(readFirstStartSetupState()).toBe('completed');
    });

    it('a cancelled prompt (Ctrl-C) exits non-zero: the task is not run', async () => {
      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce(Symbol.for('cancel')); // Ctrl-C at the web search step
      mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

      await expect(runFirstStart({ mode: 'start' })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(mocks.cancel).toHaveBeenCalledWith('Setup cancelled.');
    });

    it('`ironcurtain setup` (the default mode) still exits 0 when setup is declined', async () => {
      mocks.confirm.mockResolvedValueOnce(false);

      await expect(runFirstStart()).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(mocks.cancel).toHaveBeenCalledWith('Setup cancelled.');
    });
  });

  describe('credential check', () => {
    it('qualifies the missing Anthropic key for an OAuth-only container user instead of calling it missing', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      oauthMocks.files.mockReturnValue([claudeLogin()]);
      setupBasicFlow(false);

      await runFirstStart();

      expect(successes()).toContainEqual(
        expect.stringContaining('Claude login (OAuth) found: container sessions (Claude Code) can use it'),
      );
      expect(warnings().some((text) => text.includes('Missing API key for anthropic'))).toBe(false);
      const qualified = warnings().find((text) => text.startsWith('No API key for anthropic.'));
      expect(qualified).toBeDefined();
      expect(qualified).toContain('Your Claude login covers container sessions (Claude Code)');
      expect(qualified).toContain('these still need an API key:');
      expect(qualified).toContain('policy compilation (compile-policy, persona compile, customize-policy)');
      expect(qualified).toContain('auto-approve');
      expect(qualified).toContain('builtin sessions');
      expect(qualified).toContain('export ANTHROPIC_API_KEY=<your-key>');
      expect(qualified).toContain(`add ANTHROPIC_API_KEY=<your-key> to ${env.testHome}/.env`);
      expect(mocks.log.info).not.toHaveBeenCalledWith('All required credentials are configured.');
    });

    it('without a Claude login, names it as the alternative for container sessions', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      setupBasicFlow(false);

      await runFirstStart();

      const missing = warnings().find((text) => text.includes('Missing API key for anthropic'));
      expect(missing).toContain('used by container sessions (Claude Code), builtin sessions, policy compilation');
      expect(missing).toContain('Container sessions (Claude Code) can use a Claude login instead: run `claude login`');
      expect(successes().some((text) => text.includes('Claude login (OAuth) found'))).toBe(false);
    });

    it('does not let a Claude login stand in for the key when container sessions use the API key (IRONCURTAIN_DOCKER_AUTH=apikey)', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
      oauthMocks.files.mockReturnValue([claudeLogin()]);
      setupBasicFlow(false);

      await runFirstStart();

      const missing = warnings().find((text) => text.includes('Missing API key for anthropic'));
      expect(missing).toContain('used by container sessions (Claude Code)');
      // A login is never used in this mode, so the wizard must not suggest one.
      expect(missing).not.toContain('claude login');
      expect(missing).not.toContain('Claude login');
      expect(successes().some((text) => text.includes('Claude login (OAuth) found'))).toBe(false);
    });

    it('a Claude login does not cover builtin mode', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      seedConfig(env.testHome, { preferredMode: 'builtin' });
      oauthMocks.files.mockReturnValue([claudeLogin()]);
      setupBasicFlow(false);

      await runFirstStart();

      const missing = warnings().find((text) => text.includes('Missing API key for anthropic'));
      expect(missing).toBeDefined();
      expect(missing).not.toContain('container sessions');
      expect(missing).not.toContain('claude login');
      expect(successes().some((text) => text.includes('Claude login (OAuth) found'))).toBe(false);
    });

    it('counts an API key saved in config.json', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      seedConfig(env.testHome, { anthropicApiKey: 'sk-ant-api03-from-config' });
      setupBasicFlow(false);

      await runFirstStart();

      expect(warnings().filter((text) => /API key/.test(text))).toEqual([]);
      expect(successes()).toContain('API key configured for anthropic (config.json)');
      expect(mocks.log.info).toHaveBeenCalledWith('All required credentials are configured.');
    });

    it('derives the providers from the configured model IDs, not the defaults', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-openai-test';
      const openai = 'openai:gpt-5-mini';
      seedConfig(env.testHome, {
        preferredMode: 'builtin',
        agentModelId: openai,
        policyModelId: openai,
        prefilterModelId: openai,
        autoCompact: { summaryModelId: openai },
        autoApprove: { modelId: openai },
      });
      setupBasicFlow(false);

      await runFirstStart();

      expect(warnings().filter((text) => /API key/.test(text))).toEqual([]);
      expect(successes()).toContain('API key configured for openai (OPENAI_API_KEY)');
      expect(mocks.log.info).toHaveBeenCalledWith('All required credentials are configured.');
    });

    it('reports a host role bound to a gateway profile without a key by the profile, not the provider', async () => {
      seedConfig(env.testHome, {
        modelProviders: { profiles: { router: { type: 'openrouter' } } },
        hostModelProfiles: { policy: 'router', prefilter: 'router' },
      });
      setupBasicFlow(false);

      await runFirstStart();

      const missing = warnings().find((text) => text.includes('provider profile "router"'));
      expect(missing).toContain(
        'Missing API key for provider profile "router" (OpenRouter), used by policy compilation',
      );
      expect(missing).toContain('Set OPENROUTER_API_KEY');
      // The Anthropic key (ANTHROPIC_API_KEY, set) still covers the other roles.
      expect(successes()).toContain('API key configured for anthropic (ANTHROPIC_API_KEY)');
    });
  });

  describe('collectCredentialNeeds', () => {
    it('lists the container agent credential first and each provider once with all its uses', () => {
      const needs = collectCredentialNeeds(
        testUserConfig({
          preferredMode: 'container',
          preferredDockerAgent: 'claude-code',
          autoCompact: {
            enabled: true,
            thresholdTokens: 1,
            keepRecentMessages: 1,
            summaryModelId: 'google:gemini-2.5-flash',
          },
          googleApiKey: 'g-key',
        }),
      );

      expect(needs.map((need) => need.target)).toEqual([
        { kind: 'provider', provider: 'anthropic' },
        { kind: 'provider', provider: 'google' },
      ]);
      expect(needs[0].configured).toBe(false);
      expect(needs[0].uses[0]).toEqual({ label: 'container sessions (Claude Code)', claudeLogin: true });
      expect(needs[0].uses.map((use) => use.label)).toEqual([
        'container sessions (Claude Code)',
        'builtin sessions',
        'policy compilation (compile-policy, persona compile, customize-policy)',
        'auto-approve',
      ]);
      expect(needs[1]).toEqual({
        target: { kind: 'provider', provider: 'google' },
        configured: true,
        uses: [{ label: 'auto-compaction in builtin sessions' }],
      });
    });

    it("uses Goose's provider for Goose container sessions and adds nothing for Codex", () => {
      const goose = collectCredentialNeeds(
        testUserConfig({ preferredMode: 'container', preferredDockerAgent: 'goose', gooseProvider: 'openai' }),
      );
      expect(goose[0]).toMatchObject({
        target: { kind: 'provider', provider: 'openai' },
        uses: [{ label: 'container sessions (Goose)' }],
      });

      const codex = collectCredentialNeeds(
        testUserConfig({ preferredMode: 'container', preferredDockerAgent: 'codex' }),
      );
      expect(codex.flatMap((need) => need.uses.map((use) => use.label))).not.toContain('container sessions (Codex)');
    });

    it('does not mark Claude Code container sessions as login-capable when IRONCURTAIN_DOCKER_AUTH=apikey', () => {
      const config = testUserConfig({ preferredMode: 'container', preferredDockerAgent: 'claude-code' });
      expect(collectCredentialNeeds(config)[0].uses[0]).toEqual({
        label: 'container sessions (Claude Code)',
        claudeLogin: true,
      });

      process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';

      expect(collectCredentialNeeds(config)[0]).toMatchObject({
        target: { kind: 'provider', provider: 'anthropic' },
      });
      expect(collectCredentialNeeds(config)[0].uses[0]).toEqual({ label: 'container sessions (Claude Code)' });
    });
  });

  it('exits cleanly on broken config file', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(env.testHome, { recursive: true });
    writeFileSync(resolve(env.testHome, 'config.json'), 'not valid json');

    mocks.confirm.mockResolvedValueOnce(true);

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.log.error).toHaveBeenCalled();
  });

  describe('OS sandbox dependencies', () => {
    const missingDeps = {
      available: false,
      platformSupported: true,
      problems: ['ripgrep (rg) not found', 'socat not installed'],
      warnings: [],
    };

    it('reports an available OS sandbox without asking anything', async () => {
      setupBasicFlow(false);

      await runFirstStart();

      expect(mocks.log.success).toHaveBeenCalledWith(expect.stringContaining('OS sandbox available'));
      expect(mocks.confirm).toHaveBeenCalledTimes(3);
      expect(readConfig(env.testHome) as Record<string, unknown>).not.toHaveProperty('sandboxPolicy');
    });

    it('explains which servers will not start and keeps enforce unless the user opts out', async () => {
      sandboxMocks.availability.mockReturnValue(missingDeps);
      setupBasicFlow(false);
      mocks.confirm.mockResolvedValueOnce(false); // keep enforce

      await runFirstStart();

      const note = mocks.note.mock.calls.find((c) => c[1] === 'OS sandbox');
      expect(note?.[0]).toContain('ripgrep (rg) not found; socat not installed');
      expect(note?.[0]).toContain('git, google-workspace');
      expect(note?.[0]).toContain('sudo apt-get install -y bubblewrap socat ripgrep');
      const optOut = mocks.confirm.mock.calls[3][0] as { initialValue?: boolean };
      expect(optOut.initialValue).toBe(false);
      expect(readConfig(env.testHome) as Record<string, unknown>).not.toHaveProperty('sandboxPolicy');
    });

    // FU-02 (01-08): the wizard asks as a session decides, so a host whose
    // helpers are installed but where srt cannot start a sandbox is offered
    // "warn" too, instead of being told the sandbox is available.
    it('offers "warn" when the tools are present but the srt smoke run fails', async () => {
      // The dependency check passes; only the smoke run finds srt broken.
      sandboxMocks.smokeVerdict.mockReturnValueOnce({
        available: false,
        platformSupported: true,
        problems: ['srt cannot start a sandbox on this host: apply-seccomp: Permission denied'],
        warnings: [],
      });
      setupBasicFlow(false);
      mocks.confirm.mockResolvedValueOnce(true); // allow unsandboxed

      await runFirstStart();

      const note = mocks.note.mock.calls.find((c) => c[1] === 'OS sandbox');
      expect(note?.[0]).toContain('srt cannot start a sandbox on this host');
      expect(note?.[0]).not.toContain('apt-get');
      expect(mocks.log.success).not.toHaveBeenCalledWith(expect.stringContaining('OS sandbox available'));
      expect((readConfig(env.testHome) as Record<string, unknown>).sandboxPolicy).toBe('warn');
    });

    it('points at doctor instead of an install command when the tools are present but unusable', async () => {
      sandboxMocks.availability.mockReturnValue({
        available: false,
        platformSupported: true,
        problems: ["running as uid 0 without CAP_SETFCAP in this process's capability bounding set"],
        warnings: [],
      });
      setupBasicFlow(false);
      mocks.confirm.mockResolvedValueOnce(false); // keep enforce

      await runFirstStart();

      const note = mocks.note.mock.calls.find((c) => c[1] === 'OS sandbox');
      expect(note?.[0]).toContain('CAP_SETFCAP');
      expect(note?.[0]).not.toContain('apt-get');
      expect(note?.[0]).toContain('ironcurtain doctor');
    });

    it('saves sandboxPolicy "warn" when the user allows unsandboxed servers', async () => {
      sandboxMocks.availability.mockReturnValue(missingDeps);
      setupBasicFlow(false);
      mocks.confirm.mockResolvedValueOnce(true); // allow unsandboxed

      await runFirstStart();

      expect((readConfig(env.testHome) as Record<string, unknown>).sandboxPolicy).toBe('warn');
    });
  });

  describe('re-run safety', () => {
    it('preserves existing web search API key when re-selecting same provider', async () => {
      seedConfig(env.testHome, {
        webSearch: { provider: 'brave', brave: { apiKey: 'existing-brave-key' } },
      });

      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('brave'); // re-select brave
      mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
      mocks.confirm.mockResolvedValueOnce(false); // auto-approve

      await runFirstStart();

      const config = readConfig(env.testHome);
      expect(config.webSearch?.provider).toBe('brave');
      expect(config.webSearch?.brave?.apiKey).toBe('existing-brave-key');
      expect(mocks.text).not.toHaveBeenCalled();
      expect(mocks.password).not.toHaveBeenCalled();
    });

    it('prompts for API key when switching to a new provider', async () => {
      seedConfig(env.testHome, {
        webSearch: { provider: 'brave', brave: { apiKey: 'existing-brave-key' } },
      });

      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('tavily'); // switch to tavily
      mocks.password.mockResolvedValueOnce('new-tavily-key'); // enter key (masked prompt)
      mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
      mocks.confirm.mockResolvedValueOnce(false); // auto-approve

      await runFirstStart();

      const config = readConfig(env.testHome);
      expect(config.webSearch?.provider).toBe('tavily');
      expect(config.webSearch?.tavily?.apiKey).toBe('new-tavily-key');
      expect(mocks.password).toHaveBeenCalledTimes(1);
      expect(mocks.text).not.toHaveBeenCalled();
    });

    it('collects the GitHub token with a masked prompt and keeps the stored one when left blank', async () => {
      seedConfig(env.testHome, {
        serverCredentials: { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_stored_value' } },
      });

      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('skip'); // skip web search
      mocks.confirm.mockResolvedValueOnce(true); // update the GitHub token
      mocks.password.mockResolvedValueOnce(''); // blank: keep the current token
      mocks.confirm.mockResolvedValueOnce(false); // auto-approve

      await runFirstStart();

      expect(mocks.password).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('leave blank to keep the current token') }),
      );
      expect(mocks.text).not.toHaveBeenCalled();
      const config = readConfig(env.testHome);
      expect(config.serverCredentials?.github?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_stored_value');
    });

    it('preserves existing auto-approve state as initialValue', async () => {
      seedConfig(env.testHome, { autoApprove: { enabled: true } });

      setupBasicFlow(true);

      await runFirstStart();

      const autoApproveCall = mocks.confirm.mock.calls[2][0] as { initialValue?: boolean };
      expect(autoApproveCall.initialValue).toBe(true);
    });
  });
});
