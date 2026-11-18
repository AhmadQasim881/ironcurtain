/** Owns one authenticated Signal bridge and refuses containers from another home. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContainerRuntime, DockerContainerConfig } from '../docker/types.js';
import { getIronCurtainHome, getOAuthDir } from '../config/paths.js';
import { assertTrustedDirectoryChain } from '../hardened-fs.js';
import { getSignalDataDir } from './signal-config.js';
import { resolveSignalImage, SIGNAL_BRIDGE_AUTH_LABEL, SIGNAL_BRIDGE_AUTH_VERSION } from './signal-image.js';
import { createSignalBridgeClient, type SignalBridgeClient } from './signal-bridge-client.js';
import { loadOrCreateSignalBridgeCredentials } from './signal-bridge-credentials.js';
import * as logger from '../logger.js';

const SIGNAL_CLI_DATA_DIR = '/home/.local/share/signal-cli';
const CREDENTIALS_TARGET = '/run/ironcurtain-signal-auth/credentials.json';
const ENTRYPOINT = '/usr/local/bin/ironcurtain-signal-entrypoint';
const AUTH_HEADER = 'X-IronCurtain-Signal-Auth';
export const SIGNAL_BRIDGE_OWNER_LABEL = 'org.ironcurtain.signal-bridge-owner';
export const SIGNAL_BRIDGE_CREDENTIAL_LABEL = 'org.ironcurtain.signal-bridge-credentials';
const CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL'] as const;

export interface SignalContainerConfig {
  readonly image: string;
  readonly port: number;
  readonly dataDir: string;
  readonly containerName: string;
}
export interface SignalContainerManager {
  ensureRunning(): Promise<SignalBridgeClient>;
  waitForHealthy(client: SignalBridgeClient, timeoutMs?: number): Promise<void>;
  teardown(): Promise<void>;
  exists(): Promise<boolean>;
  isRunning(): Promise<boolean>;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
/** Existing owned data is narrowed to private modes, never chowned. */
function privateDataDirectory(configured: string, create: boolean): string {
  const euid = process.geteuid?.();
  if (euid === undefined || euid === 0)
    throw new Error('Signal requires a non-root host user with a verifiable identity');
  const home = resolve(getIronCurtainHome());
  const data = configured || getSignalDataDir();
  if (!isAbsolute(data)) throw new Error('Signal data directory must be absolute and below the IronCurtain home');
  const below = relative(home, resolve(data));
  if (below === '' || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below))
    throw new Error('Signal data directory must be below the IronCurtain home');
  if (create) mkdirSync(home, { recursive: true, mode: 0o700 });
  const canonicalHome = realpathSync(home);
  if (lstatSync(canonicalHome).uid !== euid) throw new Error('Signal home must be owned by the current host user');
  assertTrustedDirectoryChain(canonicalHome, {
    root: canonicalHome,
    rootDescription: 'the IronCurtain home',
    label: 'Signal home',
  });
  let current = canonicalHome;
  for (const component of below.split(sep)) {
    current = join(current, component);
    if (create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const descriptor = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isDirectory() || stats.uid !== euid)
        throw new Error('Signal data directories must be owned by the current host user');
      if (create) fchmodSync(descriptor, 0o700);
      else if ((stats.mode & 0o777) !== 0o700) throw new Error('Signal data directory must have mode 0700');
    } finally {
      closeSync(descriptor);
    }
  }
  return current;
}
function ownerFor(dataDir: string): string {
  return createHash('sha256')
    .update(`${realpathSync(getOAuthDir())}\0${dataDir}`)
    .digest('hex');
}
function mountMatches(value: unknown, source: string, target: string, writable: boolean): boolean {
  const mount = record(value);
  return mount.Type === 'bind' && mount.Source === source && mount.Destination === target && mount.RW === writable;
}
function validateOwnership(
  raw: Readonly<Record<string, unknown>>,
  owner: string,
  dataDir: string,
  allowLegacy: boolean,
): string {
  const labels = record(record(raw.Config).Labels);
  if (labels[SIGNAL_BRIDGE_OWNER_LABEL] !== undefined && labels[SIGNAL_BRIDGE_OWNER_LABEL] !== owner)
    throw new Error('The named Signal container belongs to another IronCurtain home; it was left untouched');
  if (!allowLegacy && labels[SIGNAL_BRIDGE_OWNER_LABEL] !== owner)
    throw new Error('The named Signal container has no matching owner label; it was left untouched');
  const mounts = Array.isArray(raw.Mounts) ? raw.Mounts : [];
  const dataMounts = mounts.filter((mount) => record(mount).Destination === SIGNAL_CLI_DATA_DIR);
  if (dataMounts.length !== 1 || !mountMatches(dataMounts[0], dataDir, SIGNAL_CLI_DATA_DIR, true))
    throw new Error(
      "The named Signal container does not mount this home's exact data directory; it was left untouched",
    );
  if (typeof raw.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.Id))
    throw new Error('Signal container inspection did not provide an immutable container ID');
  return raw.Id;
}
function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}
function exactCapabilities(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== CAPABILITIES.length) return false;
  const normalized = value.map((capability: unknown) =>
    typeof capability === 'string' ? capability.replace(/^CAP_/u, '') : undefined,
  );
  return (
    new Set(normalized).size === CAPABILITIES.length &&
    CAPABILITIES.every((capability) => normalized.includes(capability))
  );
}
function matchesProfile(
  raw: Readonly<Record<string, unknown>>,
  profile: DockerContainerConfig,
  fingerprint: string,
): boolean {
  const config = record(raw.Config),
    host = record(raw.HostConfig),
    labels = record(config.Labels);
  const mounts = Array.isArray(raw.Mounts) ? raw.Mounts : [];
  const bindings = record(host.PortBindings),
    binding = bindings['8080/tcp'];
  const expectedBinding = profile.ports?.length === 1 ? profile.ports[0] : undefined;
  const expectedOwner = profile.labels?.[SIGNAL_BRIDGE_OWNER_LABEL];
  if (expectedBinding === undefined || expectedOwner === undefined) return false;
  const port = /^127\.0\.0\.1:(\d+):8080$/u.exec(expectedBinding)?.[1];
  if (port === undefined) return false;
  const networks = record(record(raw.NetworkSettings).Networks);
  if (
    raw.Image !== profile.image ||
    config.Image !== profile.image ||
    labels[SIGNAL_BRIDGE_OWNER_LABEL] !== expectedOwner ||
    labels[SIGNAL_BRIDGE_AUTH_LABEL] !== SIGNAL_BRIDGE_AUTH_VERSION ||
    labels[SIGNAL_BRIDGE_CREDENTIAL_LABEL] !== fingerprint ||
    !exactStrings(config.Entrypoint, [ENTRYPOINT]) ||
    !(config.Cmd === undefined || config.Cmd === null || exactStrings(config.Cmd, [])) ||
    (profile.user !== undefined
      ? config.User !== profile.user
      : !['signal-api', '1000', '1000:1000'].includes(String(config.User))) ||
    host.NetworkMode !== 'bridge' ||
    Object.keys(networks).length !== 1 ||
    !('bridge' in networks) ||
    host.Privileged !== false ||
    host.PublishAllPorts !== false ||
    Object.keys(bindings).length !== 1 ||
    !Array.isArray(binding) ||
    binding.length !== 1 ||
    record(binding[0]).HostIp !== '127.0.0.1' ||
    record(binding[0]).HostPort !== port ||
    mounts.length !== profile.mounts.length ||
    profile.mounts.some(
      (mount) => !mounts.some((observed) => mountMatches(observed, mount.source, mount.target, !mount.readonly)),
    ) ||
    !exactStrings(host.CapDrop, ['ALL']) ||
    !exactCapabilities(host.CapAdd) ||
    record(host.RestartPolicy).Name !== 'no' ||
    !Array.isArray(host.SecurityOpt) ||
    !host.SecurityOpt.some((option) => option === 'no-new-privileges' || option === 'no-new-privileges:true')
  )
    return false;
  if (!Array.isArray(config.Env) || !config.Env.every((entry) => typeof entry === 'string')) return false;
  const env = new Map<string, string>();
  for (const entry of config.Env) {
    const equals = entry.indexOf('=');
    if (equals < 1 || env.has(entry.slice(0, equals))) return false;
    env.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  if (env.has('AUTO_RECEIVE_SCHEDULE')) return false;
  if (profile.user === undefined && (env.has('SIGNAL_BRIDGE_UID') || env.has('SIGNAL_BRIDGE_GID'))) return false;
  return Object.entries(profile.env).every(([name, value]) => env.get(name) === value);
}
async function staleBindMount(docker: ContainerRuntime, id: string, dataDir: string): Promise<boolean> {
  try {
    if (!lstatSync(join(dataDir, 'data')).isDirectory()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    return (await docker.exec(id, ['test', '-d', `${SIGNAL_CLI_DATA_DIR}/data`], 5_000, null)).exitCode !== 0;
  } catch {
    return true;
  }
}
export function createSignalContainerManager(
  docker: ContainerRuntime,
  config: SignalContainerConfig,
): SignalContainerManager {
  let activeClient: SignalBridgeClient | undefined;
  let credentials: ReturnType<typeof loadOrCreateSignalBridgeCredentials> | undefined;
  const origin = `https://127.0.0.1:${config.port}`;
  async function inspect(name: string): Promise<Readonly<Record<string, unknown>>> {
    if (docker.inspectContainerRaw === undefined)
      throw new Error('Signal requires complete Docker container inspection support');
    const raw = await docker.inspectContainerRaw(name);
    if (raw === undefined)
      throw new Error('Signal container could not be inspected; no existing container was changed');
    return raw;
  }
  return {
    async ensureRunning(): Promise<SignalBridgeClient> {
      activeClient?.close();
      activeClient = undefined;
      credentials = undefined;
      if (docker.inspectContainerRaw === undefined)
        throw new Error('Signal requires complete Docker container inspection support');
      if (
        !Number.isInteger(config.port) ||
        config.port < 1024 ||
        config.port > 65535 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(config.containerName)
      )
        throw new Error('Invalid Signal bridge port or container name');
      const dataDir = privateDataDirectory(config.dataDir, true);
      credentials = loadOrCreateSignalBridgeCredentials();
      const owner = ownerFor(dataDir),
        linux = process.platform === 'linux';
      const uid = process.geteuid?.(),
        gid = process.getegid?.();
      if (linux && (uid === undefined || gid === undefined || uid === 0 || gid === 0))
        throw new Error('Signal requires positive non-root host UID and GID');
      let existing: Readonly<Record<string, unknown>> | undefined;
      let id: string | undefined;
      if (await docker.containerExists(config.containerName)) {
        existing = await inspect(config.containerName);
        id = validateOwnership(existing, owner, dataDir, true);
        // Image resolution can fail during an upgrade. Close an owned legacy
        // listener first, so that failure cannot leave the old API exposed.
        if (record(record(existing.Config).Labels)[SIGNAL_BRIDGE_AUTH_LABEL] !== SIGNAL_BRIDGE_AUTH_VERSION) {
          logger.info('[Signal Container] Removing owned legacy bridge before image admission');
          if (record(existing.State).Running === true) await docker.stop(id);
          await docker.remove(id);
          existing = undefined;
          id = undefined;
        }
      }
      const image = await resolveSignalImage(docker, config.image, {
        info: (message) => logger.info(`[Signal Container] ${message}`),
        warn: (message) => logger.warn(`[Signal Container] ${message}`),
      });
      const profile: DockerContainerConfig = {
        image: image.id,
        name: config.containerName,
        network: 'bridge',
        ports: [`127.0.0.1:${config.port}:8080`],
        entrypoint: ENTRYPOINT,
        ...(linux ? { user: '0:0' } : {}),
        capAdd: CAPABILITIES,
        trustedCreateOptions: { securityOptions: ['no-new-privileges:true'] },
        labels: {
          [SIGNAL_BRIDGE_AUTH_LABEL]: SIGNAL_BRIDGE_AUTH_VERSION,
          [SIGNAL_BRIDGE_OWNER_LABEL]: owner,
          [SIGNAL_BRIDGE_CREDENTIAL_LABEL]: credentials.fingerprint,
        },
        mounts: [
          { source: dataDir, target: SIGNAL_CLI_DATA_DIR, readonly: false },
          { source: credentials.filePath, target: CREDENTIALS_TARGET, readonly: true },
        ],
        env: {
          MODE: 'json-rpc',
          PORT: '8080',
          SIGNAL_CLI_CHOWN_ON_STARTUP: 'false',
          IRONCURTAIN_SIGNAL_CREDENTIALS_FILE: CREDENTIALS_TARGET,
          ...(linux ? { SIGNAL_BRIDGE_UID: String(uid), SIGNAL_BRIDGE_GID: String(gid) } : {}),
        },
        command: [],
      };
      if (existing !== undefined && id !== undefined) {
        const raw = existing;
        const running = record(raw.State).Running === true;
        if (
          !matchesProfile(raw, profile, credentials.fingerprint) ||
          (running && (await staleBindMount(docker, id, dataDir)))
        ) {
          logger.info('[Signal Container] Recreating owned container with the authenticated bridge profile');
          if (running) await docker.stop(id);
          await docker.remove(id);
          id = undefined;
        } else if (!running) await docker.start(id);
      }
      if (id === undefined) {
        const created = await docker.create(profile);
        const raw = await inspect(created);
        id = validateOwnership(raw, owner, dataDir, false);
        if (id !== created || !matchesProfile(raw, profile, credentials.fingerprint))
          throw new Error(
            'New Signal container does not match the required authenticated bridge profile; it was not started',
          );
        await docker.start(id);
      }
      activeClient = createSignalBridgeClient(origin, credentials.token, { ca: credentials.certPem });
      return activeClient;
    },
    async waitForHealthy(client, timeoutMs = 30_000): Promise<void> {
      if (client !== activeClient || credentials === undefined)
        throw new Error('Use the authenticated client returned by this Signal container manager');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
        throw new Error('Invalid Signal health timeout');
      const token = `${credentials.token[0] === '0' ? '1' : '0'}${credentials.token.slice(1)}`;
      const negative = createSignalBridgeClient(origin, token, { ca: credentials.certPem });
      const deadline = AbortSignal.timeout(timeoutMs),
        end = Date.now() + timeoutMs;
      let delay = 500;
      try {
        while (Date.now() < end) {
          try {
            const response = await client.request('/v1/health', { signal: deadline });
            if (response.status === 204) {
              if (response.headers.get(AUTH_HEADER) !== SIGNAL_BRIDGE_AUTH_VERSION)
                throw new Error('Signal bridge did not prove authenticated admission');
              const refused = await negative.request('/v1/health', { signal: deadline });
              if (refused.status !== 401 || refused.headers.get(AUTH_HEADER) !== SIGNAL_BRIDGE_AUTH_VERSION)
                throw new Error('Signal bridge did not prove authenticated admission');
              return;
            }
          } catch (error) {
            if (
              error instanceof Error &&
              (error.message === 'Signal bridge did not prove authenticated admission' ||
                error.message === 'Signal bridge client is closed')
            )
              throw error;
          }
          const remaining = end - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, Math.min(delay, remaining)));
          delay = Math.min(delay * 1.5, 3000);
        }
        throw new Error(`Authenticated Signal bridge did not become healthy within ${timeoutMs}ms`);
      } finally {
        negative.close();
      }
    },
    async teardown(): Promise<void> {
      activeClient?.close();
      activeClient = undefined;
      credentials = undefined;
      if (!(await docker.containerExists(config.containerName))) return;
      const dataDir = privateDataDirectory(config.dataDir, false);
      const raw = await inspect(config.containerName);
      const id = validateOwnership(raw, ownerFor(dataDir), dataDir, false);
      if (record(raw.State).Running === true) await docker.stop(id);
      await docker.remove(id);
    },
    async exists(): Promise<boolean> {
      return docker.containerExists(config.containerName);
    },
    async isRunning(): Promise<boolean> {
      return docker.isRunning(config.containerName);
    },
  };
}
