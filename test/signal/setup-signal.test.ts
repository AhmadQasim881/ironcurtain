import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type http from 'node:http';
import https from 'node:https';
import { createSignalBridgeClient, type SignalBridgeClient } from '../../src/signal/signal-bridge-client.js';
import { SIGNAL_TEST_BRIDGE_TOKEN, getSignalTestTlsIdentity } from '../helpers/mock-signal-api.js';

// ---- Module mocks (hoisted - no external variable references) ----

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
  }),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock('../../src/docker/docker-probe.js', () => ({
  checkDockerAvailable: vi.fn().mockResolvedValue({ available: true }),
}));

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomInt: vi.fn().mockReturnValue(847293),
  };
});

vi.mock('../../src/docker/docker-manager.js', () => ({
  createDockerManager: vi.fn(() => sharedDocker),
}));

vi.mock('../../src/config/user-config.js', () => ({
  saveUserConfig: vi.fn(),
  loadUserConfig: vi.fn(() => ({
    signal: {
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
    },
  })),
  loadSavedSignalContainerConfig: vi.fn(() => undefined),
}));

// Docker manager mock - shared so tests can script image pulls and inspects
const sharedDocker = {
  preflight: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue('container-id'),
  start: vi.fn().mockResolvedValue(undefined),
  exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
  stop: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  isRunning: vi.fn().mockResolvedValue(true),
  imageExists: vi.fn().mockResolvedValue(true),
  buildImage: vi.fn().mockResolvedValue(undefined),
  getImageLabel: vi.fn().mockResolvedValue(undefined),
  createNetwork: vi.fn().mockResolvedValue(undefined),
  removeNetwork: vi.fn().mockResolvedValue(undefined),
  pullImage: vi.fn().mockResolvedValue(undefined),
  inspectImage: vi.fn().mockResolvedValue(undefined),
  tagImage: vi.fn().mockResolvedValue(undefined),
  removeImage: vi.fn().mockResolvedValue(true),
  containerExists: vi.fn().mockResolvedValue(true),
  getContainerLabel: vi.fn().mockResolvedValue(undefined),
  removeStaleContainer: vi.fn().mockResolvedValue(false),
  getImageId: vi.fn().mockResolvedValue('sha256:abc123'),
};

// Container manager mock - needs to be a shared instance for test reconfiguration
const sharedContainerManager = {
  ensureRunning: vi.fn(),
  waitForHealthy: vi.fn().mockResolvedValue(undefined),
  teardown: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  isRunning: vi.fn().mockResolvedValue(true),
};

/** A reviewed-looking pin used by the resolved-config fixtures. */
const PINNED_IMAGE = `registry.example.test/ironcurtain/signal-bridge@sha256:${'1'.repeat(64)}`;

vi.mock('../../src/signal/signal-container.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/signal/signal-container.js')>(
    '../../src/signal/signal-container.js',
  );
  return {
    ...actual,
    createSignalContainerManager: vi.fn(() => sharedContainerManager),
  };
});

vi.mock('../../src/signal/signal-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/signal/signal-config.js')>(
    '../../src/signal/signal-config.js',
  );
  return {
    ...actual,
    getSignalDataDir: vi.fn(() => '/tmp/nonexistent-signal-test-data'),
    resolveSignalConfig: vi.fn(() => ({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: `registry.example.test/ironcurtain/signal-bridge@sha256:${'1'.repeat(64)}`,
        port: 0,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    })),
  };
});

// ---- Imports (after mocks) ----

import * as p from '@clack/prompts';
import {
  validatePhoneNumber,
  registerNewNumber,
  verifyRecipientIdentity,
  runSignalSetup,
  runReTrust,
  runUpdateImage,
} from '../../src/signal/setup-signal.js';
import { saveUserConfig, loadSavedSignalContainerConfig } from '../../src/config/user-config.js';
import { createSignalContainerManager } from '../../src/signal/signal-container.js';
import {
  SIGNAL_DEFAULT_IMAGE,
  SIGNAL_BRIDGE_AUTH_LABEL,
  SIGNAL_BRIDGE_AUTH_VERSION,
  SignalImageError,
} from '../../src/signal/signal-image.js';

// Cast for access to mock methods
const mockP = p as unknown as {
  text: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  intro: ReturnType<typeof vi.fn>;
  outro: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  note: ReturnType<typeof vi.fn>;
  isCancel: ReturnType<typeof vi.fn>;
  spinner: ReturnType<typeof vi.fn>;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
};
// ---- Mock Signal REST API server ----

interface SentMessage {
  message: string;
  number: string;
  recipients: string[];
}

class MockSignalApi {
  private server: https.Server;
  readonly sentMessages: SentMessage[] = [];
  // Assigned by start() after the OS picks an ephemeral port (bind to 0).
  port = 0;
  private identities: Array<{
    number: string;
    fingerprint: string;
    safety_number: string;
    added: string;
    status: string;
    uuid?: string;
  }> = [];
  private accounts: string[] = [];
  private registerShouldFail = false;
  private verifyShouldFail = false;

  constructor() {
    const identity = getSignalTestTlsIdentity();
    this.server = https.createServer({ cert: identity.certPem, key: identity.keyPem }, (req, res) => {
      this.handleRequest(req, res);
    });
  }

  setIdentities(entries: Array<{ number: string; fingerprint: string; uuid?: string; added?: string }>): void {
    this.identities = entries.map((e) => ({
      number: e.number,
      fingerprint: e.fingerprint,
      safety_number: 'test-safety-number',
      added: e.added ?? new Date().toISOString(),
      status: 'TRUSTED_UNVERIFIED',
      ...(e.uuid !== undefined ? { uuid: e.uuid } : {}),
    }));
  }

  setRegisterShouldFail(fail: boolean): void {
    this.registerShouldFail = fail;
  }

  setVerifyShouldFail(fail: boolean): void {
    this.verifyShouldFail = fail;
  }

  setAccounts(accounts: string[]): void {
    this.accounts = accounts;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      // Bind an ephemeral port (0) so parallel/retried runs never collide.
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${SIGNAL_TEST_BRIDGE_TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);

    if (url.pathname === '/v1/health' && req.method === 'GET') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/v1/accounts' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.accounts));
      return;
    }

    if (url.pathname.startsWith('/v1/register/') && !url.pathname.includes('/verify/') && req.method === 'POST') {
      if (this.registerShouldFail) {
        res.writeHead(400);
        res.end('Captcha rejected');
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (url.pathname.includes('/verify/') && req.method === 'POST') {
      if (this.verifyShouldFail) {
        res.writeHead(400);
        res.end('Invalid code');
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.pathname === '/v2/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as SentMessage;
        this.sentMessages.push(parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamp: Date.now() }));
      });
      return;
    }

    if (url.pathname.startsWith('/v1/identities/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.identities));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }
}

// ---- Tests ----

describe('validatePhoneNumber', () => {
  it('accepts valid E.164 numbers', () => {
    expect(validatePhoneNumber('+15551234567')).toBeUndefined();
    expect(validatePhoneNumber('+491711234567')).toBeUndefined();
    expect(validatePhoneNumber('+8613800138000')).toBeUndefined();
  });

  it('rejects empty input', () => {
    expect(validatePhoneNumber('')).toBe('Phone number is required');
    expect(validatePhoneNumber(undefined)).toBe('Phone number is required');
  });

  it('rejects numbers without + prefix', () => {
    expect(validatePhoneNumber('15551234567')).toContain('E.164');
  });

  it('rejects numbers that are too short', () => {
    expect(validatePhoneNumber('+12345')).toContain('E.164');
  });

  it('rejects numbers with non-digit characters', () => {
    expect(validatePhoneNumber('+1-555-123-4567')).toContain('E.164');
    expect(validatePhoneNumber('+1 555 1234567')).toContain('E.164');
  });
});

describe('registerNewNumber', () => {
  let api: MockSignalApi;
  let client: SignalBridgeClient;

  beforeAll(async () => {
    api = new MockSignalApi();
    await api.start();
    client = createSignalBridgeClient(`https://127.0.0.1:${api.port}`, SIGNAL_TEST_BRIDGE_TOKEN, {
      ca: getSignalTestTlsIdentity().certPem,
    });
  });

  afterAll(async () => {
    client.close();
    await api.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.setRegisterShouldFail(false);
    api.setVerifyShouldFail(false);
  });

  it('completes registration successfully', async () => {
    mockP.text
      .mockResolvedValueOnce('+15551234567') // phone number
      .mockResolvedValueOnce('signalcaptcha://token123') // captcha
      .mockResolvedValueOnce('123-456'); // verification code

    const result = await registerNewNumber(client);
    expect(result).toBe('+15551234567');
  });

  it('throws when captcha is rejected', async () => {
    api.setRegisterShouldFail(true);

    mockP.text.mockResolvedValueOnce('+15551234567').mockResolvedValueOnce('signalcaptcha://badtoken');

    await expect(registerNewNumber(client)).rejects.toThrow('Registration failed: 400');
  });

  it('throws when verification code is wrong', async () => {
    api.setVerifyShouldFail(true);

    mockP.text
      .mockResolvedValueOnce('+15551234567')
      .mockResolvedValueOnce('signalcaptcha://token123')
      .mockResolvedValueOnce('999999');

    await expect(registerNewNumber(client)).rejects.toThrow('Verification failed: 400');
  });
});

describe('verifyRecipientIdentity', () => {
  let api: MockSignalApi;
  let client: SignalBridgeClient;

  beforeAll(async () => {
    api = new MockSignalApi();
    await api.start();
    client = createSignalBridgeClient(`https://127.0.0.1:${api.port}`, SIGNAL_TEST_BRIDGE_TOKEN, {
      ca: getSignalTestTlsIdentity().certPem,
    });
  });

  afterAll(async () => {
    client.close();
    await api.stop();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5' }]);
  });

  it('sends challenge code and returns identity key on correct entry', async () => {
    // randomInt is mocked to return 847293
    mockP.text.mockResolvedValueOnce('847293');

    const result = await verifyRecipientIdentity(client, '+15551234567', '+15559876543');

    expect(result).toEqual({ identityKey: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5' });
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages[0].message).toContain('847293');
    expect(api.sentMessages[0].recipients).toEqual(['+15559876543']);
    expect(api.sentMessages[0].number).toBe('+15551234567');
  });

  it('allows retry on wrong code', async () => {
    mockP.text
      .mockResolvedValueOnce('000000') // wrong
      .mockResolvedValueOnce('847293'); // correct

    const result = await verifyRecipientIdentity(client, '+15551234567', '+15559876543');
    expect(result.identityKey).toBe('05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5');
    expect(mockP.log.warn).toHaveBeenCalledWith(expect.stringContaining('2 attempt(s) remaining'));
  });

  it('fails after 3 wrong attempts', async () => {
    mockP.text.mockResolvedValueOnce('000000').mockResolvedValueOnce('111111').mockResolvedValueOnce('222222');

    await expect(verifyRecipientIdentity(client, '+15551234567', '+15559876543')).rejects.toThrow(
      'Challenge verification failed after 3 attempts',
    );
  });

  it('throws when identity key is not available', async () => {
    api.setIdentities([]); // No identities
    mockP.text.mockResolvedValueOnce('847293');

    await expect(verifyRecipientIdentity(client, '+15551234567', '+15559876543')).rejects.toThrow(
      'Identity key could not be retrieved',
    );
  });

  it('handles fingerprints with spaces', async () => {
    api.setIdentities([{ number: '+15559876543', fingerprint: '05 a1 b2 c3 d4' }]);
    mockP.text.mockResolvedValueOnce('847293');

    const result = await verifyRecipientIdentity(client, '+15551234567', '+15559876543');
    expect(result.identityKey).toBe('05a1b2c3d4');
  });

  it('captures the newest record for the number, with its account UUID', async () => {
    api.setIdentities([
      { number: '+15559876543', fingerprint: '05newer', uuid: 'aci-new', added: '1700000002000' },
      { number: '+15550000000', fingerprint: '05other', uuid: 'aci-other', added: '1700000009000' },
      { number: '+15559876543', fingerprint: '05older', uuid: 'aci-old', added: '1700000001000' },
    ]);
    mockP.text.mockResolvedValueOnce('847293');

    const result = await verifyRecipientIdentity(client, '+15551234567', '+15559876543');
    expect(result).toEqual({ identityKey: '05newer', uuid: 'aci-new' });
  });
});

describe('runSignalSetup', () => {
  let api: MockSignalApi;
  let port: number;

  beforeAll(async () => {
    api = new MockSignalApi();
    await api.start();
    port = api.port;
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5' }]);
    api.setRegisterShouldFail(false);
    api.setVerifyShouldFail(false);

    mockP.text.mockReset();
    mockP.confirm.mockReset();
    sharedContainerManager.ensureRunning.mockReset().mockResolvedValue(
      createSignalBridgeClient(`https://127.0.0.1:${port}`, SIGNAL_TEST_BRIDGE_TOKEN, {
        ca: getSignalTestTlsIdentity().certPem,
      }),
    );
    sharedContainerManager.isRunning.mockResolvedValue(true);
    sharedContainerManager.waitForHealthy.mockResolvedValue(undefined);
    sharedDocker.pullImage.mockReset().mockResolvedValue(undefined);
    sharedDocker.inspectImage.mockReset().mockResolvedValue(undefined);
    sharedDocker.tagImage.mockReset().mockResolvedValue(undefined);
    sharedDocker.removeImage.mockReset().mockResolvedValue(true);
    vi.mocked(loadSavedSignalContainerConfig).mockReset().mockReturnValue(undefined);
  });

  /** Answers the prompts of a full setup that registers a new bot number. */
  function answerRegistrationPrompts(): void {
    mockP.text
      .mockResolvedValueOnce('+15551234567') // bot phone
      .mockResolvedValueOnce('signalcaptcha://tok123') // captcha
      .mockResolvedValueOnce('123-456') // SMS code
      .mockResolvedValueOnce('+15559876543') // recipient
      .mockResolvedValueOnce('847293'); // challenge code
  }

  function lastSavedSignal(): Record<string, unknown> | undefined {
    return vi.mocked(saveUserConfig).mock.calls.at(-1)?.[0].signal;
  }

  it('saves the account UUID and leaves the default image out of config.json', async () => {
    api.setIdentities([{ number: '+15559876543', fingerprint: '05a1b2c3', uuid: 'aci-1234' }]);
    mockP.confirm.mockResolvedValueOnce(true);
    answerRegistrationPrompts();

    await runSignalSetup();

    expect(vi.mocked(createSignalContainerManager)).toHaveBeenCalledWith(
      sharedDocker,
      expect.objectContaining({ image: SIGNAL_DEFAULT_IMAGE, port: 18080 }),
    );
    const saved = lastSavedSignal();
    expect(saved).toMatchObject({ recipientIdentityKey: '05a1b2c3', recipientUuid: 'aci-1234' });
    // A later release's reviewed default pin must still apply to this install.
    expect(saved?.container).toEqual({ port: 18080 });
    const client = (await sharedContainerManager.ensureRunning.mock.results[0].value) as SignalBridgeClient;
    expect(sharedContainerManager.waitForHealthy).toHaveBeenNthCalledWith(1, client);
    expect(sharedContainerManager.waitForHealthy).toHaveBeenNthCalledWith(2, client);
    await expect(client.request('/v1/health')).rejects.toThrow('closed');
  });

  it('stops setup on an authenticated accounts refusal and closes the client', async () => {
    const client = createSignalBridgeClient(`https://127.0.0.1:${port}`, 'c'.repeat(64), {
      ca: getSignalTestTlsIdentity().certPem,
    });
    sharedContainerManager.ensureRunning.mockResolvedValue(client);
    mockP.confirm.mockResolvedValueOnce(true);

    await expect(runSignalSetup()).rejects.toThrow('Signal bridge authentication failed');
    expect(saveUserConfig).not.toHaveBeenCalled();
    expect(mockP.text).not.toHaveBeenCalled();
    await expect(client.request('/v1/health')).rejects.toThrow('closed');
  });

  it('requires building a missing local default without offering an upstream pull', async () => {
    sharedContainerManager.ensureRunning.mockRejectedValueOnce(
      new SignalImageError('SIGNAL_IMAGE_NOT_PINNED', 'Local image is missing'),
    );
    mockP.confirm.mockResolvedValueOnce(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      await expect(runSignalSetup()).rejects.toThrow('process.exit called');
      expect(exit).toHaveBeenCalledWith(1);
      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining('npm run build:signal-bridge'));
      expect(mockP.confirm).toHaveBeenCalledOnce();
      expect(sharedDocker.pullImage).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it('keeps the image and port already saved in config.json', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({ image: PINNED_IMAGE, port: 18081 });
    mockP.confirm.mockResolvedValueOnce(true);
    answerRegistrationPrompts();

    await runSignalSetup();

    expect(vi.mocked(createSignalContainerManager)).toHaveBeenCalledWith(
      sharedDocker,
      expect.objectContaining({ image: PINNED_IMAGE, port: 18081 }),
    );
    expect(lastSavedSignal()?.container).toEqual({ image: PINNED_IMAGE, port: 18081 });
    expect(sharedDocker.pullImage).not.toHaveBeenCalled();
  });

  it('offers to pin a published authenticated image when it is not present, then uses and saves the pin', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({
      image: 'registry.example.test/ironcurtain/signal-bridge:latest',
    });
    const digest = `sha256:${'a'.repeat(64)}`;
    const pinned = `registry.example.test/ironcurtain/signal-bridge@${digest}`;
    sharedContainerManager.ensureRunning.mockRejectedValueOnce(
      new SignalImageError('SIGNAL_IMAGE_NOT_PINNED', 'This build has no reviewed digest'),
    );
    sharedDocker.inspectImage.mockResolvedValue({
      id: `sha256:${'b'.repeat(64)}`,
      repoTags: ['registry.example.test/ironcurtain/signal-bridge:latest'],
      repoDigests: [pinned],
      labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
      created: '2026-11-01T00:00:00Z',
    });
    mockP.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true); // continue, pin
    answerRegistrationPrompts();

    await runSignalSetup();

    expect(sharedDocker.pullImage).toHaveBeenCalledWith('registry.example.test/ironcurtain/signal-bridge:latest');
    const note = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'signal-cli image');
    expect(note?.[0]).toContain(`Digest:           ${digest}`);
    expect(mockP.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(pinned) }));
    expect(sharedContainerManager.ensureRunning).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createSignalContainerManager)).toHaveBeenLastCalledWith(
      sharedDocker,
      expect.objectContaining({ image: pinned }),
    );
    expect(lastSavedSignal()?.container).toEqual({ image: pinned, port: 18080 });
  });

  it('stops before starting a container when the user declines the pin', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({
      image: 'registry.example.test/ironcurtain/signal-bridge:latest',
    });
    sharedContainerManager.ensureRunning.mockRejectedValueOnce(
      new SignalImageError('SIGNAL_IMAGE_NOT_PINNED', 'This build has no reviewed digest'),
    );
    sharedDocker.inspectImage.mockResolvedValue({
      id: `sha256:${'b'.repeat(64)}`,
      repoTags: [],
      repoDigests: [`registry.example.test/ironcurtain/signal-bridge@sha256:${'a'.repeat(64)}`],
      labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
      created: '',
    });
    mockP.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // continue, decline the pin
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runSignalSetup()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(sharedContainerManager.ensureRunning).toHaveBeenCalledTimes(1);
      expect(saveUserConfig).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('removes the pulled tag again when the user declines to pin a configured tag that was missing', async () => {
    const tag = 'registry.example.test/ironcurtain/signal-bridge:0.92';
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({ image: tag });
    sharedContainerManager.ensureRunning.mockRejectedValueOnce(
      new SignalImageError(
        'SIGNAL_IMAGE_NOT_PINNED',
        'names a tag, not a digest, and that image is not present locally',
      ),
    );
    const local = new Map<string, unknown>();
    sharedDocker.inspectImage.mockImplementation((ref: string) => Promise.resolve(local.get(ref)));
    sharedDocker.pullImage.mockImplementation((ref: string) => {
      local.set(ref, {
        id: `sha256:${'b'.repeat(64)}`,
        repoTags: [tag],
        repoDigests: [`registry.example.test/ironcurtain/signal-bridge@sha256:${'a'.repeat(64)}`],
        labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
        created: '',
      });
      return Promise.resolve();
    });
    sharedDocker.removeImage.mockReset().mockImplementation((ref: string) => Promise.resolve(local.delete(ref)));
    mockP.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false); // continue, decline the pin
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runSignalSetup()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(sharedDocker.pullImage).toHaveBeenCalledWith(tag);
      // Without this, the next `ironcurtain bot` would run the declined image from the tag.
      expect(sharedDocker.removeImage).toHaveBeenCalledWith(tag);
      expect(local.has(tag)).toBe(false);
      expect(saveUserConfig).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('does not offer a pin for other container failures', async () => {
    sharedContainerManager.ensureRunning.mockRejectedValueOnce(new Error('port is already allocated'));
    mockP.confirm.mockResolvedValueOnce(true);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runSignalSetup()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(sharedDocker.pullImage).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('completes full registration flow and saves config', async () => {
    const { saveUserConfig: mockSave } = await import('../../src/config/user-config.js');

    mockP.confirm.mockResolvedValueOnce(true);
    mockP.text
      .mockResolvedValueOnce('+15551234567') // bot phone
      .mockResolvedValueOnce('signalcaptcha://tok123') // captcha
      .mockResolvedValueOnce('123-456') // SMS code
      .mockResolvedValueOnce('+15559876543') // recipient
      .mockResolvedValueOnce('847293'); // challenge code

    await runSignalSetup();

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({
          botNumber: '+15551234567',
          recipientNumber: '+15559876543',
          recipientIdentityKey: '05a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5',
        }),
      }),
    );

    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('Setup complete'));
  });

  it('stops before touching Docker or registering when config.json cannot be read', async () => {
    const { loadUserConfig: mockLoad, saveUserConfig: mockSave } = await import('../../src/config/user-config.js');
    vi.mocked(mockLoad).mockImplementationOnce(() => {
      throw new Error('Invalid JSON in /home/user/.ironcurtain/config.json: Unexpected token }');
    });
    mockP.confirm.mockResolvedValueOnce(true);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runSignalSetup()).rejects.toThrow('process.exit called');
      expect(mockLoad).toHaveBeenCalledWith({ readOnly: true });
      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'));
      expect(sharedContainerManager.ensureRunning).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('delegates to runReTrust when reTrust option is set', async () => {
    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: PINNED_IMAGE,
        port,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    });

    mockP.text.mockResolvedValueOnce('847293');

    await runSignalSetup({ reTrust: true });

    expect(mockP.intro).toHaveBeenCalledWith('Signal Identity Re-verification');
  });

  it('displays summary note with all config values', async () => {
    mockP.confirm.mockResolvedValueOnce(true);
    mockP.text
      .mockResolvedValueOnce('+15551234567')
      .mockResolvedValueOnce('signalcaptcha://tok123')
      .mockResolvedValueOnce('123-456')
      .mockResolvedValueOnce('+15559876543')
      .mockResolvedValueOnce('847293');

    await runSignalSetup();

    // Find the 'Configuration saved' note
    const noteCall = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'Configuration saved');
    expect(noteCall).toBeDefined();
    expect(noteCall![0]).toContain('+15551234567');
    expect(noteCall![0]).toContain('+15559876543');
    expect(noteCall![0]).toContain('18080');
  });
});

describe('runReTrust', () => {
  let api: MockSignalApi;
  let port: number;

  beforeAll(async () => {
    api = new MockSignalApi();
    await api.start();
    port = api.port;
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    api.sentMessages.length = 0;
    api.setIdentities([{ number: '+15559876543', fingerprint: '05newkey9876543210fedcba' }]);

    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue({
      botNumber: '+15551234567',
      recipientNumber: '+15559876543',
      recipientIdentityKey: '05oldkey1234567890abcdef',
      container: {
        image: PINNED_IMAGE,
        port,
        dataDir: '/tmp/test-signal-data',
        containerName: 'ironcurtain-signal-test',
      },
    });

    sharedContainerManager.isRunning.mockResolvedValue(true);
    sharedContainerManager.ensureRunning.mockResolvedValue(
      createSignalBridgeClient(`https://127.0.0.1:${port}`, SIGNAL_TEST_BRIDGE_TOKEN, {
        ca: getSignalTestTlsIdentity().certPem,
      }),
    );
  });

  it('stores the account UUID of the new key with it', async () => {
    api.setIdentities([{ number: '+15559876543', fingerprint: '05newkey', uuid: 'aci-new' }]);
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(saveUserConfig).toHaveBeenCalledWith({
      signal: expect.objectContaining({ recipientIdentityKey: '05newkey', recipientUuid: 'aci-new' }),
    });
  });

  it('drops a stored account UUID when the new record lists none', async () => {
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    const saved = vi.mocked(saveUserConfig).mock.calls.at(-1)?.[0].signal;
    expect(saved).toHaveProperty('recipientUuid', undefined);
    expect(saved?.recipientIdentityKey).toBe('05newkey9876543210fedcba');
  });

  it('re-verifies identity and saves new key', async () => {
    const { saveUserConfig: mockSave } = await import('../../src/config/user-config.js');
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.objectContaining({
          recipientIdentityKey: '05newkey9876543210fedcba',
        }),
      }),
    );

    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('Transport unlocked'));
  });

  it('displays previous and new key in note', async () => {
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    const noteCall = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'Key updated');
    expect(noteCall).toBeDefined();
    expect(noteCall![0]).toContain('Previous key:');
    expect(noteCall![0]).toContain('New key:');
  });

  it('starts container if not running', async () => {
    sharedContainerManager.isRunning.mockResolvedValue(false);
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(sharedContainerManager.ensureRunning).toHaveBeenCalled();
    expect(sharedContainerManager.waitForHealthy).toHaveBeenCalled();
  });

  it('validates an already-running bridge before re-trust and closes its client', async () => {
    sharedContainerManager.isRunning.mockResolvedValue(true);
    mockP.text.mockResolvedValueOnce('847293');

    await runReTrust();

    expect(sharedContainerManager.ensureRunning).toHaveBeenCalledOnce();
    const client = (await sharedContainerManager.ensureRunning.mock.results[0].value) as SignalBridgeClient;
    expect(sharedContainerManager.waitForHealthy).toHaveBeenCalledWith(client);
    await expect(client.request('/v1/health')).rejects.toThrow('closed');
  });

  it('exits when signal is not configured', async () => {
    const { resolveSignalConfig: mockResolve } = await import('../../src/signal/signal-config.js');
    (mockResolve as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runReTrust()).rejects.toThrow('process.exit called');
      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    } finally {
      mockExit.mockRestore();
    }
  });
});

describe('runUpdateImage', () => {
  const digest = `sha256:${'c'.repeat(64)}`;
  const pinned = `registry.example.test/ironcurtain/signal-bridge@${digest}`;
  const pulledImage = {
    id: `sha256:${'d'.repeat(64)}`,
    repoTags: ['registry.example.test/ironcurtain/signal-bridge:latest'],
    repoDigests: [pinned],
    labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
    created: '2026-11-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockP.isCancel.mockReturnValue(false);
    mockP.confirm.mockReset();
    sharedDocker.pullImage.mockReset().mockResolvedValue(undefined);
    sharedDocker.inspectImage.mockReset().mockResolvedValue(pulledImage);
    vi.mocked(loadSavedSignalContainerConfig)
      .mockReset()
      .mockReturnValue({ image: 'registry.example.test/ironcurtain/signal-bridge:latest' });
  });

  it('explains local rebuilding without pulling or changing configuration', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue(undefined);
    await runUpdateImage();
    expect(mockP.log.info).toHaveBeenCalledWith(expect.stringContaining('npm run build:signal-bridge'));
    expect(sharedDocker.pullImage).not.toHaveBeenCalled();
    expect(saveUserConfig).not.toHaveBeenCalled();
    expect(mockP.confirm).not.toHaveBeenCalled();
  });

  it('pulls the current image, shows its digest and records the pin once confirmed', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({
      image: 'registry.example.test/ironcurtain/signal-bridge:latest',
      port: 18090,
    });
    mockP.confirm.mockResolvedValueOnce(true);

    await runUpdateImage();

    expect(sharedDocker.pullImage).toHaveBeenCalledWith('registry.example.test/ironcurtain/signal-bridge:latest');
    const note = mockP.note.mock.calls.find((call: unknown[]) => call[1] === 'signal-cli image');
    expect(note?.[0]).toContain(`Digest:           ${digest}`);
    expect(note?.[0]).toContain('registry.example.test/ironcurtain/signal-bridge:latest');
    // The port saved before is kept: signal.container is replaced as a whole.
    expect(saveUserConfig).toHaveBeenCalledWith({ signal: { container: { port: 18090, image: pinned } } });
    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('recreated from the pinned image'));
  });

  it('updates a configured tag from that tag', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({
      image: 'registry.example.test/ironcurtain/signal-bridge:0.92',
    });
    mockP.confirm.mockResolvedValueOnce(true);

    await runUpdateImage();

    expect(sharedDocker.pullImage).toHaveBeenCalledWith('registry.example.test/ironcurtain/signal-bridge:0.92');
    expect(saveUserConfig).toHaveBeenCalledWith({ signal: { container: { image: pinned } } });
  });

  it('changes nothing when the configured pin already names that digest', async () => {
    vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({ image: pinned });

    await runUpdateImage();

    expect(mockP.confirm).not.toHaveBeenCalled();
    expect(saveUserConfig).not.toHaveBeenCalled();
    expect(mockP.outro).toHaveBeenCalledWith(expect.stringContaining('Already pinned'));
  });

  it('changes nothing when the user declines', async () => {
    mockP.confirm.mockResolvedValueOnce(false);

    await runUpdateImage();

    expect(saveUserConfig).not.toHaveBeenCalled();
  });

  describe('with signal.container.image naming a tag', () => {
    const tag = 'registry.example.test/ironcurtain/signal-bridge:latest';
    const previousId = `sha256:${'e'.repeat(64)}`;
    const previousImage = { ...pulledImage, id: previousId, repoDigests: [] };

    /** Local tags: the configured one names `previousImage` until the pull moves it to `pulledImage`. */
    function scriptTagMove(): Map<string, typeof pulledImage> {
      const local = new Map<string, typeof pulledImage>([[tag, previousImage]]);
      sharedDocker.inspectImage.mockImplementation((ref: string) => Promise.resolve(local.get(ref)));
      sharedDocker.pullImage.mockImplementation((ref: string) => {
        local.set(ref, pulledImage);
        return Promise.resolve();
      });
      sharedDocker.tagImage.mockImplementation((source: string, target: string) => {
        if (source === previousId) local.set(target, previousImage);
        return Promise.resolve();
      });
      return local;
    }

    beforeEach(() => {
      vi.mocked(loadSavedSignalContainerConfig).mockReturnValue({ image: tag });
      sharedDocker.tagImage.mockReset().mockResolvedValue(undefined);
      sharedDocker.removeImage.mockReset().mockResolvedValue(true);
    });

    it('puts the tag back on the image it named when the user declines, so the bridge keeps running it', async () => {
      const local = scriptTagMove();
      mockP.confirm.mockResolvedValueOnce(false);

      await runUpdateImage();

      expect(sharedDocker.pullImage).toHaveBeenCalledWith(tag);
      expect(sharedDocker.tagImage).toHaveBeenCalledWith(previousId, tag);
      expect(local.get(tag)?.id).toBe(previousId);
      expect(saveUserConfig).not.toHaveBeenCalled();
      expect(mockP.log.error).not.toHaveBeenCalled();
      expect(mockP.cancel).toHaveBeenCalledWith('Image not changed.');
    });

    it('puts the tag back when the user cancels the prompt, before exiting', async () => {
      const local = scriptTagMove();
      const cancelled = Symbol('cancel');
      mockP.confirm.mockResolvedValueOnce(cancelled);
      mockP.isCancel.mockImplementation((value: unknown) => value === cancelled);
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        await expect(runUpdateImage()).rejects.toThrow('process.exit called');
        expect(mockExit).toHaveBeenCalledWith(0);
        expect(local.get(tag)?.id).toBe(previousId);
        expect(saveUserConfig).not.toHaveBeenCalled();
      } finally {
        mockExit.mockRestore();
        mockP.isCancel.mockReset().mockReturnValue(false);
      }
    });

    it('warns when the tag cannot be put back', async () => {
      scriptTagMove();
      sharedDocker.tagImage.mockRejectedValue(new Error('No such image'));
      mockP.confirm.mockResolvedValueOnce(false);

      await runUpdateImage();

      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining(`docker image rm ${tag}`));
      expect(saveUserConfig).not.toHaveBeenCalled();
    });

    it('pins the pulled image once confirmed, leaving the moved tag alone', async () => {
      scriptTagMove();
      mockP.confirm.mockResolvedValueOnce(true);

      await runUpdateImage();

      expect(saveUserConfig).toHaveBeenCalledWith({ signal: { container: { image: pinned } } });
      expect(sharedDocker.tagImage).not.toHaveBeenCalled();
    });
  });

  it('exits without recording anything when the pull fails', async () => {
    sharedDocker.pullImage.mockRejectedValueOnce(new Error('network unreachable'));
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await expect(runUpdateImage()).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockP.log.error).toHaveBeenCalledWith(expect.stringContaining('network unreachable'));
      expect(saveUserConfig).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('is what runSignalSetup runs with updateImage', async () => {
    mockP.confirm.mockResolvedValueOnce(true);

    await runSignalSetup({ updateImage: true });

    expect(mockP.intro).toHaveBeenCalledWith('Signal Bridge Image Update');
    expect(saveUserConfig).toHaveBeenCalledWith({ signal: { container: { image: pinned } } });
  });
});
