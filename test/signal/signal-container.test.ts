import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContainerRuntime, DockerContainerConfig, DockerImageInfo } from '../../src/docker/types.js';
import type { SignalBridgeClient } from '../../src/signal/signal-bridge-client.js';
import {
  createSignalContainerManager,
  SIGNAL_BRIDGE_OWNER_LABEL,
  SIGNAL_BRIDGE_CREDENTIAL_LABEL,
} from '../../src/signal/signal-container.js';
import {
  SIGNAL_IMAGE_DIGEST_PLACEHOLDER,
  SIGNAL_BRIDGE_AUTH_LABEL,
  SIGNAL_BRIDGE_AUTH_VERSION,
} from '../../src/signal/signal-image.js';
const mocks = vi.hoisted(() => ({ credentials: vi.fn(), client: vi.fn() }));
vi.mock('../../src/signal/signal-bridge-credentials.js', () => ({
  loadOrCreateSignalBridgeCredentials: mocks.credentials,
}));
vi.mock('../../src/signal/signal-bridge-client.js', () => ({ createSignalBridgeClient: mocks.client }));
vi.mock('../../src/logger.js', () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const REPO = 'registry.example.test/ironcurtain/signal-bridge',
  PIN = `${REPO}@sha256:${'a'.repeat(64)}`;
const IMAGE = `sha256:${'1'.repeat(64)}`,
  OLD = `sha256:${'2'.repeat(64)}`,
  ID = '3'.repeat(64),
  NAME = 'ironcurtain-signal-test';
const DATA = '/home/.local/share/signal-cli',
  AUTH = '/run/ironcurtain-signal-auth/credentials.json',
  HEADER = 'X-IronCurtain-Signal-Auth';
type Raw = Record<string, unknown>;
const child = (raw: Raw, key: string): Raw => raw[key] as Raw;
function image(): DockerImageInfo {
  return {
    id: IMAGE,
    repoTags: [],
    repoDigests: [PIN],
    labels: { [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION },
    created: new Date().toISOString(),
  };
}
function profile(c: DockerContainerConfig): Raw {
  return {
    Id: ID,
    Image: c.image,
    State: { Running: false },
    Config: {
      Image: c.image,
      Labels: { ...c.labels },
      User: c.user ?? 'signal-api',
      Entrypoint: [c.entrypoint],
      Cmd: [...c.command],
      Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
    },
    Mounts: c.mounts.map((m) => ({ Type: 'bind', Source: m.source, Destination: m.target, RW: !m.readonly })),
    HostConfig: {
      NetworkMode: 'bridge',
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] },
      Privileged: false,
      PublishAllPorts: false,
      CapDrop: ['ALL'],
      CapAdd: c.capAdd!.map((capability) => `CAP_${capability}`),
      RestartPolicy: { Name: 'no' },
      SecurityOpt: [...(c.trustedCreateOptions?.securityOptions ?? [])],
    },
    NetworkSettings: { Networks: { bridge: {} } },
  };
}
interface State {
  images: Map<string, DockerImageInfo>;
  pullable?: DockerImageInfo;
  raw?: Raw;
}
function fake(state: State) {
  return {
    inspectImage: vi.fn((ref: string) => Promise.resolve(state.images.get(ref))),
    pullImage: vi.fn((ref: string) => {
      if (!state.pullable) return Promise.reject(new Error('pull failed'));
      state.images.set(ref, state.pullable);
      return Promise.resolve();
    }),
    containerExists: vi.fn(() => Promise.resolve(state.raw !== undefined)),
    inspectContainerRaw: vi.fn(() => Promise.resolve(state.raw)),
    isRunning: vi.fn(() => Promise.resolve(state.raw !== undefined && child(state.raw, 'State').Running === true)),
    exec: vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
    start: vi.fn(() => {
      if (state.raw) child(state.raw, 'State').Running = true;
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      if (state.raw) child(state.raw, 'State').Running = false;
      return Promise.resolve();
    }),
    remove: vi.fn(() => {
      state.raw = undefined;
      return Promise.resolve();
    }),
    create: vi.fn((c: DockerContainerConfig) => {
      state.raw = profile(c);
      return Promise.resolve(ID);
    }),
  };
}
describe('authenticated Signal container manager', () => {
  let home: string, dataDir: string, state: State, docker: ReturnType<typeof fake>, clients: SignalBridgeClient[];
  let credentials: { filePath: string; token: string; certPem: string; fingerprint: string };
  let health: 'secure' | 'missing-marker' | 'open' | 'unready';
  const saved = process.env.IRONCURTAIN_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-signal-container-'));
    process.env.IRONCURTAIN_HOME = home;
    dataDir = join(home, 'signal-data');
    const authDir = join(home, 'oauth', 'signal-bridge');
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    credentials = {
      filePath: join(authDir, 'credentials.json'),
      token: 'a'.repeat(64),
      certPem: 'fixture-public-certificate',
      fingerprint: 'b'.repeat(64),
    };
    writeFileSync(credentials.filePath, '{}', { mode: 0o600 });
    mocks.credentials.mockReset().mockImplementation(() => credentials);
    clients = [];
    health = 'secure';
    mocks.client.mockReset().mockImplementation((_origin: string, token: string) => {
      let closed = false;
      const c: SignalBridgeClient = {
        request: vi.fn(async () => {
          if (closed) throw new Error('Signal bridge client is closed');
          return new Response(null, {
            status: health === 'unready' ? 503 : token === credentials.token || health === 'open' ? 204 : 401,
            headers: health === 'missing-marker' ? {} : { [HEADER]: '1' },
          });
        }),
        openReceive: vi.fn(() => {
          throw new Error('unused fixture');
        }),
        close: vi.fn(() => {
          closed = true;
        }),
      };
      clients.push(c);
      return c;
    });
    state = { images: new Map([[PIN, image()]]) };
    docker = fake(state);
  });
  afterEach(() => {
    for (const c of clients) c.close();
    if (saved === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function manager(runtime: unknown = docker, ref = PIN) {
    return createSignalContainerManager(runtime as ContainerRuntime, {
      image: ref,
      port: 18080,
      dataDir,
      containerName: NAME,
    });
  }
  function legacy(): Raw {
    return {
      Id: ID,
      Image: OLD,
      State: { Running: true },
      Config: { Labels: {} },
      Mounts: [{ Type: 'bind', Source: dataDir, Destination: DATA, RW: true }],
    };
  }
  it('creates a private credential-file-bound bridge from the immutable image', async () => {
    expect(await manager().ensureRunning()).toBe(clients[0]);
    const c = docker.create.mock.calls[0][0];
    expect(c).toMatchObject({
      image: IMAGE,
      network: 'bridge',
      ports: ['127.0.0.1:18080:8080'],
      entrypoint: '/usr/local/bin/ironcurtain-signal-entrypoint',
      command: [],
      trustedCreateOptions: { securityOptions: ['no-new-privileges:true'] },
    });
    expect(c.mounts).toEqual([
      { source: dataDir, target: DATA, readonly: false },
      { source: credentials.filePath, target: AUTH, readonly: true },
    ]);
    expect(c.env).toMatchObject({ MODE: 'json-rpc', PORT: '8080', IRONCURTAIN_SIGNAL_CREDENTIALS_FILE: AUTH });
    if (process.platform === 'linux') {
      expect(c.user).toBe('0:0');
      expect(c.env).toMatchObject({
        SIGNAL_BRIDGE_UID: String(process.geteuid!()),
        SIGNAL_BRIDGE_GID: String(process.getegid!()),
      });
    }
    expect(c.labels?.[SIGNAL_BRIDGE_OWNER_LABEL]).toMatch(/^[a-f0-9]{64}$/u);
    expect(c.labels?.[SIGNAL_BRIDGE_CREDENTIAL_LABEL]).toBe(credentials.fingerprint);
    expect(JSON.stringify(c)).not.toContain(credentials.token);
    expect(JSON.stringify(c)).not.toContain(credentials.certPem);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(docker.start).toHaveBeenCalledWith(ID);
  });
  it('reuses an exact profile and closes the previous client on reconnect', async () => {
    const m = manager(),
      first = await m.ensureRunning();
    vi.clearAllMocks();
    expect(await m.ensureRunning()).not.toBe(first);
    expect(first.close).toHaveBeenCalledOnce();
    expect(docker.create).not.toHaveBeenCalled();
    expect(docker.start).not.toHaveBeenCalled();
  });
  it('starts a stopped owned profile by immutable ID', async () => {
    const m = manager();
    await m.ensureRunning();
    child(state.raw!, 'State').Running = false;
    vi.clearAllMocks();
    await m.ensureRunning();
    expect(docker.start).toHaveBeenCalledWith(ID);
    expect(docker.create).not.toHaveBeenCalled();
  });
  it('accepts equivalent prefixed and unprefixed capability names', async () => {
    const m = manager();
    await m.ensureRunning();
    const host = child(state.raw!, 'HostConfig');
    host.CapAdd = (host.CapAdd as string[]).map((capability, index) =>
      index % 2 === 0 ? capability.replace(/^CAP_/u, '') : capability,
    );
    vi.clearAllMocks();
    await m.ensureRunning();
    expect(docker.create).not.toHaveBeenCalled();
  });
  it('migrates a legacy bridge with exactly matching owned data', async () => {
    state.raw = legacy();
    await manager().ensureRunning();
    expect(docker.stop).toHaveBeenCalledWith(ID);
    expect(docker.remove).toHaveBeenCalledWith(ID);
    expect(docker.create).toHaveBeenCalledOnce();
  });
  it('closes an owned legacy listener before rejecting an unauthenticated image', async () => {
    state.raw = legacy();
    state.images.set(PIN, { ...image(), labels: {} });
    await expect(manager().ensureRunning()).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_AUTH_REQUIRED' });
    expect(docker.stop).toHaveBeenCalledWith(ID);
    expect(docker.remove).toHaveBeenCalledWith(ID);
    expect(docker.remove.mock.invocationCallOrder[0]).toBeLessThan(docker.inspectImage.mock.invocationCallOrder[0]);
    expect(docker.create).not.toHaveBeenCalled();
    expect(docker.start).not.toHaveBeenCalled();
  });
  it('leaves a foreign legacy listener untouched when the configured image is unauthenticated', async () => {
    state.raw = legacy();
    child(state.raw, 'Config').Labels = { [SIGNAL_BRIDGE_OWNER_LABEL]: 'foreign' };
    state.images.set(PIN, { ...image(), labels: {} });
    await expect(manager().ensureRunning()).rejects.toThrow('left untouched');
    expect(docker.stop).not.toHaveBeenCalled();
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.inspectImage).not.toHaveBeenCalled();
  });
  it('retains an already authenticated owned container when its configured image is unavailable', async () => {
    const m = manager();
    await m.ensureRunning();
    const existing = state.raw;
    state.images.clear();
    vi.clearAllMocks();
    await expect(m.ensureRunning()).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_UNAVAILABLE' });
    expect(state.raw).toBe(existing);
    expect(docker.stop).not.toHaveBeenCalled();
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.create).not.toHaveBeenCalled();
    expect(docker.start).not.toHaveBeenCalled();
  });
  it.each(['foreign-owner', 'different-data', 'missing-data'])(
    'refuses %s without touching the container',
    async (kind) => {
      state.raw = legacy();
      if (kind === 'foreign-owner') child(state.raw, 'Config').Labels = { [SIGNAL_BRIDGE_OWNER_LABEL]: 'foreign' };
      if (kind === 'different-data') (state.raw.Mounts as Raw[])[0].Source = join(home, 'other');
      if (kind === 'missing-data') state.raw.Mounts = [];
      await expect(manager().ensureRunning()).rejects.toThrow('left untouched');
      expect(docker.stop).not.toHaveBeenCalled();
      expect(docker.remove).not.toHaveBeenCalled();
      expect(docker.create).not.toHaveBeenCalled();
    },
  );
  it('requires full inspection support before startup', async () => {
    await expect(manager({ ...docker, inspectContainerRaw: undefined }).ensureRunning()).rejects.toThrow(
      'inspection support',
    );
    expect(docker.inspectImage).not.toHaveBeenCalled();
  });
  it('leaves an existing container untouched when inspection fails', async () => {
    state.raw = legacy();
    docker.inspectContainerRaw.mockResolvedValue(undefined);
    await expect(manager().ensureRunning()).rejects.toThrow('could not be inspected');
    expect(docker.remove).not.toHaveBeenCalled();
    expect(docker.stop).not.toHaveBeenCalled();
  });
  const changes: Array<[string, (raw: Raw) => void]> = [
    [
      'image',
      (r) => {
        r.Image = OLD;
      },
    ],
    [
      'entrypoint',
      (r) => {
        child(r, 'Config').Entrypoint = ['/ordinary'];
      },
    ],
    [
      'command',
      (r) => {
        child(r, 'Config').Cmd = ['ordinary'];
      },
    ],
    [
      'user',
      (r) => {
        child(r, 'Config').User = 'unmatched';
      },
    ],
    [
      'network',
      (r) => {
        child(r, 'HostConfig').NetworkMode = 'host';
      },
    ],
    [
      'extra network',
      (r) => {
        child(r, 'NetworkSettings').Networks = { bridge: {}, extra: {} };
      },
    ],
    [
      'port binding',
      (r) => {
        child(r, 'HostConfig').PortBindings = { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }] };
      },
    ],
    [
      'writable credential',
      (r) => {
        (r.Mounts as Raw[])[1].RW = true;
      },
    ],
    [
      'credential source',
      (r) => {
        (r.Mounts as Raw[])[1].Source = '/ordinary/credentials.json';
      },
    ],
    [
      'controlled environment',
      (r) => {
        child(r, 'Config').Env = ['MODE=normal'];
      },
    ],
    [
      'auth generation',
      (r) => {
        child(child(r, 'Config'), 'Labels')[SIGNAL_BRIDGE_AUTH_LABEL] = 'old';
      },
    ],
    [
      'credential generation',
      (r) => {
        child(child(r, 'Config'), 'Labels')[SIGNAL_BRIDGE_CREDENTIAL_LABEL] = 'old';
      },
    ],
    [
      'capabilities',
      (r) => {
        (child(r, 'HostConfig').CapAdd as string[])[0] = 'CAP_NET_ADMIN';
      },
    ],
    [
      'duplicate capabilities',
      (r) => {
        const capabilities = child(r, 'HostConfig').CapAdd as string[];
        capabilities[1] = capabilities[0].replace(/^CAP_/u, '');
      },
    ],
    [
      'missing no-new-privileges',
      (r) => {
        child(r, 'HostConfig').SecurityOpt = null;
      },
    ],
  ];
  it.each(changes)('recreates an owned container after %s changes', async (_name, change) => {
    const m = manager();
    await m.ensureRunning();
    change(state.raw!);
    vi.clearAllMocks();
    await m.ensureRunning();
    expect(docker.stop).toHaveBeenCalledWith(ID);
    expect(docker.remove).toHaveBeenCalledWith(ID);
    expect(docker.create).toHaveBeenCalledOnce();
  });
  it('recreates on credential rotation while keeping owner identity stable', async () => {
    const m = manager();
    await m.ensureRunning();
    const owner = child(child(state.raw!, 'Config'), 'Labels')[SIGNAL_BRIDGE_OWNER_LABEL];
    credentials = { ...credentials, token: 'c'.repeat(64), fingerprint: 'd'.repeat(64) };
    vi.clearAllMocks();
    await m.ensureRunning();
    expect(docker.create).toHaveBeenCalledOnce();
    expect(docker.create.mock.calls[0][0].labels).toMatchObject({
      [SIGNAL_BRIDGE_OWNER_LABEL]: owner,
      [SIGNAL_BRIDGE_CREDENTIAL_LABEL]: credentials.fingerprint,
    });
  });
  it('recreates an owned running container with a stale data bind', async () => {
    const m = manager();
    await m.ensureRunning();
    mkdirSync(join(dataDir, 'data'), { mode: 0o700 });
    docker.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    vi.clearAllMocks();
    await m.ensureRunning();
    expect(docker.exec).toHaveBeenCalledWith(ID, ['test', '-d', `${DATA}/data`], 5000, null);
    expect(docker.remove).toHaveBeenCalledWith(ID);
  });
  it('rejects outside data and leaves a directory symlink unchanged', async () => {
    dataDir = join(home, '..', 'ordinary-signal-data');
    await expect(manager().ensureRunning()).rejects.toThrow('below the IronCurtain home');
    dataDir = join(home, 'signal-data');
    const target = join(home, 'ordinary');
    mkdirSync(target, { mode: 0o750 });
    symlinkSync(target, dataDir);
    await expect(manager().ensureRunning()).rejects.toThrow();
    expect(lstatSync(dataDir).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o750);
    expect(docker.create).not.toHaveBeenCalled();
  });
  it('requires authenticated success and a guaranteed different-token rejection', async () => {
    const m = manager(),
      c = await m.ensureRunning();
    await m.waitForHealthy(c);
    expect(mocks.client).toHaveBeenCalledTimes(2);
    expect(mocks.client.mock.calls[1][1]).not.toBe(mocks.client.mock.calls[0][1]);
    expect(c.request).toHaveBeenCalledWith('/v1/health', { signal: expect.any(AbortSignal) });
    expect(clients[1].close).toHaveBeenCalledOnce();
  });
  it.each(['missing-marker', 'open'] as const)('rejects %s health admission', async (mode) => {
    const m = manager(),
      c = await m.ensureRunning();
    health = mode;
    await expect(m.waitForHealthy(c)).rejects.toThrow('did not prove authenticated admission');
    expect(clients[1].close).toHaveBeenCalledOnce();
  });
  it('bounds unavailable health and closes the negative client', async () => {
    const m = manager(),
      c = await m.ensureRunning();
    health = 'unready';
    await expect(m.waitForHealthy(c, 5)).rejects.toThrow('within 5ms');
    expect(clients[1].close).toHaveBeenCalledOnce();
  });
  it('refuses a caller-created client', async () => {
    const m = manager();
    await m.ensureRunning();
    await expect(m.waitForHealthy({ ...clients[0] })).rejects.toThrow('returned by this Signal container manager');
  });
  it('closes the client and tears down only the owned container', async () => {
    const m = manager(),
      c = await m.ensureRunning();
    vi.clearAllMocks();
    await m.teardown();
    expect(c.close).toHaveBeenCalledOnce();
    expect(docker.stop).toHaveBeenCalledWith(ID);
    expect(docker.remove).toHaveBeenCalledWith(ID);
  });
  it('refuses teardown after another owner takes the name', async () => {
    const m = manager(),
      c = await m.ensureRunning();
    child(child(state.raw!, 'Config'), 'Labels')[SIGNAL_BRIDGE_OWNER_LABEL] = 'other-home';
    vi.clearAllMocks();
    await expect(m.teardown()).rejects.toThrow('another IronCurtain home');
    expect(c.close).toHaveBeenCalledOnce();
    expect(docker.stop).not.toHaveBeenCalled();
    expect(docker.remove).not.toHaveBeenCalled();
  });
  it('pulls a missing digest and creates from its immutable ID', async () => {
    state.images.clear();
    state.pullable = image();
    await manager().ensureRunning();
    expect(docker.pullImage).toHaveBeenCalledExactlyOnceWith(PIN);
    expect(docker.create.mock.calls[0][0].image).toBe(IMAGE);
  });
  it('starts nothing for an unavailable or placeholder digest', async () => {
    state.images.clear();
    await expect(manager().ensureRunning()).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_UNAVAILABLE' });
    docker.pullImage.mockClear();
    await expect(manager(docker, `${REPO}@${SIGNAL_IMAGE_DIGEST_PLACEHOLDER}`).ensureRunning()).rejects.toMatchObject({
      code: 'SIGNAL_IMAGE_NOT_PINNED',
    });
    expect(docker.pullImage).not.toHaveBeenCalled();
    expect(docker.start).not.toHaveBeenCalled();
    expect(docker.create).not.toHaveBeenCalled();
  });
  it('never pulls configured tags', async () => {
    const tag = `${REPO}:reviewed`;
    state.images.set(tag, image());
    await manager(docker, tag).ensureRunning();
    expect(docker.pullImage).not.toHaveBeenCalled();
    state.images.delete(tag);
    docker.create.mockClear();
    await expect(manager(docker, tag).ensureRunning()).rejects.toMatchObject({ code: 'SIGNAL_IMAGE_NOT_PINNED' });
    expect(docker.pullImage).not.toHaveBeenCalled();
    expect(docker.create).not.toHaveBeenCalled();
  });
});
