import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { getLlmStatisticsIdentityKeyPath } from '../config/paths.js';
import { asIdentifier, asProviderIdentifier } from './normalization.js';
import type { LlmMetricsRepository } from './persistence/repository.js';
import type { GatewayRouteAttempt, LlmExchangeCompleted, LlmModelIdentity, SourcedIdentity } from './types.js';

const IDENTITY_KEY_BYTES = 32;
const HMAC_BYTES = 16;
const IDENTITY_KEY_FILENAME = 'identity.key';
/** How often a running protector looks for a rotated key file (one lstat). */
const KEY_RECHECK_INTERVAL_MS = 2_000;

export type StatisticsIdentityNamespace =
  'agent' | 'correlation' | 'conversation' | 'model' | 'persona' | 'profile' | 'provider' | 'route' | 'state';

/**
 * Built-in agent adapter ids. They are public product names (the Docker
 * agent registry's built-ins), so rows store them raw; any other agent id is
 * still pseudonymized. Keep in sync with `registerBuiltinAdapters()`.
 */
export const PUBLIC_AGENT_IDS: readonly string[] = Object.freeze(['claude-code', 'codex', 'goose']);
const PUBLIC_AGENT_ID_SET: ReadonlySet<string> = new Set(PUBLIC_AGENT_IDS);

/** A local pseudonym as stored in statistics rows. */
export const PROTECTED_LABEL_PATTERN = /^hmac:[a-f0-9]{32}$/;

export interface StatisticsLabelProtector {
  /** Stable local pseudonym under the current key. Raw input and the key are never exposed. */
  protectLabel(namespace: StatisticsIdentityNamespace, value: string): string;
}

export interface PersistenceIdentityProtector extends StatisticsLabelProtector {
  /** Immutable copy suitable for durable enqueue. The live event remains untouched. */
  protectExchange(exchange: LlmExchangeCompleted): LlmExchangeCompleted;
}

const OFFICIAL_PUBLIC_ORIGINS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'api.z.ai',
]);

function ensureStatisticsDirectory(statisticsDirectory: string): void {
  if (existsSync(statisticsDirectory)) {
    const status = lstatSync(statisticsDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Statistics path must be a real directory');
    }
  } else {
    mkdirSync(statisticsDirectory, { recursive: true, mode: 0o700 });
  }
  chmodSync(statisticsDirectory, 0o700);
}

interface IdentityKey {
  readonly key: Buffer;
  /** Identity of the key file the key was read from, to notice a rotation. */
  readonly fileIdentity: string;
}

function fileIdentity(status: { readonly dev: number; readonly ino: number; readonly size: number }): string {
  return `${status.dev}:${status.ino}:${status.size}`;
}

function readIdentityKey(keyPath: string): IdentityKey {
  const status = lstatSync(keyPath);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('Statistics identity key must be a regular file');
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== IDENTITY_KEY_BYTES) throw new Error('Statistics identity key has an invalid length');
  return { key, fileIdentity: fileIdentity(status) };
}

function writeCompleteFile(path: string, contents: Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < contents.length) offset += writeSync(descriptor, contents, offset, contents.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Create one complete key inode and publish it with an atomic hard-link.
 * Losing processes observe EEXIST only after the winning inode is fully
 * written and fsynced, so readers can never see a partially initialized key.
 */
function candidateKeyPath(statisticsDirectory: string): string {
  return join(statisticsDirectory, `.${IDENTITY_KEY_FILENAME}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
}

function loadOrCreateIdentityKey(statisticsDirectory: string): IdentityKey {
  ensureStatisticsDirectory(statisticsDirectory);
  const keyPath = getLlmStatisticsIdentityKeyPath(statisticsDirectory);
  if (existsSync(keyPath)) return readIdentityKey(keyPath);

  const candidatePath = candidateKeyPath(statisticsDirectory);
  writeCompleteFile(candidatePath, randomBytes(IDENTITY_KEY_BYTES));
  try {
    try {
      linkSync(candidatePath, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(candidatePath);
  }
  return readIdentityKey(keyPath);
}

/**
 * Replace the identity key with a fresh one: a complete, fsynced inode
 * atomically renamed over the old key. Labels derived afterwards cannot be
 * linked to labels derived from the old key, so this is part of an explicit
 * statistics reset (after the rows are deleted). Running protectors pick the
 * new key up within a few seconds.
 */
export function rotateLlmStatisticsIdentityKey(statisticsDirectory: string): void {
  ensureStatisticsDirectory(statisticsDirectory);
  const keyPath = getLlmStatisticsIdentityKeyPath(statisticsDirectory);
  if (existsSync(keyPath)) {
    const status = lstatSync(keyPath);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error('Statistics identity key must be a regular file');
  }
  const candidatePath = candidateKeyPath(statisticsDirectory);
  writeCompleteFile(candidatePath, randomBytes(IDENTITY_KEY_BYTES));
  try {
    renameSync(candidatePath, keyPath);
  } catch (error) {
    rmSync(candidatePath, { force: true });
    throw error;
  }
  const directory = openSync(statisticsDirectory, constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function recognizedPublicOrigin(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const hostOnly = value.toLowerCase();
  if (OFFICIAL_PUBLIC_ORIGINS.has(hostOnly)) return hostOnly;
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      (origin.port !== '' && origin.port !== '443') ||
      (origin.pathname !== '' && origin.pathname !== '/') ||
      origin.search !== '' ||
      origin.hash !== '' ||
      !OFFICIAL_PUBLIC_ORIGINS.has(origin.hostname.toLowerCase())
    ) {
      return null;
    }
    return origin.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sourcedIdentity(
  identity: SourcedIdentity,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
  kind: 'model' | 'provider',
): SourcedIdentity {
  if (identity.value === null) return identity;
  const valid = kind === 'model' ? asIdentifier(identity.value) : asProviderIdentifier(identity.value);
  return { ...identity, value: valid ?? protect(kind, identity.value) };
}

function protectModelIdentity(
  identity: LlmModelIdentity,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
): LlmModelIdentity {
  return {
    requestedModel: sourcedIdentity(identity.requestedModel, protect, 'model'),
    forwardedModel: sourcedIdentity(identity.forwardedModel, protect, 'model'),
    responseModel: sourcedIdentity(identity.responseModel, protect, 'model'),
    servedModel: sourcedIdentity(identity.servedModel, protect, 'model'),
    servedProvider: sourcedIdentity(identity.servedProvider, protect, 'provider'),
  };
}

function protectRouteAttempt(
  attempt: GatewayRouteAttempt,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
): GatewayRouteAttempt {
  return {
    ...attempt,
    provider:
      attempt.provider === null
        ? null
        : (asProviderIdentifier(attempt.provider) ?? protect('provider', attempt.provider)),
    model: attempt.model === null ? null : (asIdentifier(attempt.model) ?? protect('model', attempt.model)),
  };
}

function labelDigest(key: Buffer, namespace: StatisticsIdentityNamespace, value: string): string {
  const digest = createHmac('sha256', key)
    .update(namespace, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest()
    .subarray(0, HMAC_BYTES)
    .toString('hex');
  return `hmac:${digest}`;
}

/**
 * The current key, re-read when the key file is replaced (a statistics reset
 * rotates it). A missing key is recreated; an unreadable one throws, and the
 * previous key is dropped rather than kept, so no record is protected with a
 * key that should no longer be used. A clock that moved backwards forces a
 * re-check instead of postponing it.
 */
function keyHolder(load: () => IdentityKey | undefined, keyPath: string): () => Buffer | undefined {
  let current = load();
  let checkedAt = Date.now();
  return () => {
    const now = Date.now();
    if (now >= checkedAt && now - checkedAt < KEY_RECHECK_INTERVAL_MS) return current?.key;
    checkedAt = now;
    try {
      let identity: string | undefined;
      try {
        identity = fileIdentity(lstatSync(keyPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (identity === undefined || identity !== current?.fileIdentity) current = load();
    } catch (error) {
      current = undefined;
      throw error;
    }
    return current?.key;
  };
}

export function createPersistenceIdentityProtector(statisticsDirectory: string): PersistenceIdentityProtector {
  const currentKey = keyHolder(
    () => loadOrCreateIdentityKey(statisticsDirectory),
    getLlmStatisticsIdentityKeyPath(statisticsDirectory),
  );
  const protectLabel = (namespace: StatisticsIdentityNamespace, value: string): string => {
    const key = currentKey();
    if (key === undefined) throw new Error('Statistics identity key is unavailable');
    return labelDigest(key, namespace, value);
  };
  const always = (namespace: StatisticsIdentityNamespace, value: string | null): string | null =>
    value === null ? null : protectLabel(namespace, value);
  const agent = (value: string | null): string | null =>
    value === null ? null : PUBLIC_AGENT_ID_SET.has(value) ? value : protectLabel('agent', value);
  const safeModel = (value: string | null): string | null =>
    value === null ? null : (asIdentifier(value) ?? protectLabel('model', value));
  const safeCorrelation = (value: string | null): string | null =>
    value === null ? null : (asIdentifier(value) ?? protectLabel('correlation', value));

  return Object.freeze({
    protectLabel,
    protectExchange: (exchange: LlmExchangeCompleted): LlmExchangeCompleted => {
      const clientPublicOrigin = recognizedPublicOrigin(exchange.route.clientRouteId);
      const upstreamPublicOrigin = recognizedPublicOrigin(exchange.route.upstreamRouteId);
      return Object.freeze({
        ...exchange,
        attribution: Object.freeze({
          ...exchange.attribution,
          agentConversationId: always('conversation', exchange.attribution.agentConversationId),
          stateId: always('state', exchange.attribution.stateId),
          personaId: always('persona', exchange.attribution.personaId),
          agentId: agent(exchange.attribution.agentId),
        }),
        route: Object.freeze({
          ...exchange.route,
          logicalProvider:
            asIdentifier(exchange.route.logicalProvider) ?? protectLabel('provider', exchange.route.logicalProvider),
          providerProfileId: always('profile', exchange.route.providerProfileId),
          clientRouteId:
            clientPublicOrigin ??
            (exchange.route.clientRouteId === null ? null : protectLabel('route', exchange.route.clientRouteId)),
          upstreamRouteId:
            upstreamPublicOrigin ??
            (exchange.route.upstreamRouteId === null ? null : protectLabel('route', exchange.route.upstreamRouteId)),
        }),
        identity: Object.freeze(protectModelIdentity(exchange.identity, protectLabel)),
        responseMetadata: Object.freeze({
          ...exchange.responseMetadata,
          providerRequestId: safeCorrelation(exchange.responseMetadata.providerRequestId),
          providerResponseId: safeCorrelation(exchange.responseMetadata.providerResponseId),
          gatewayGenerationId: safeCorrelation(exchange.responseMetadata.gatewayGenerationId),
          actualServiceTier:
            exchange.responseMetadata.actualServiceTier === null
              ? null
              : (asIdentifier(exchange.responseMetadata.actualServiceTier) ??
                protectLabel('correlation', exchange.responseMetadata.actualServiceTier)),
        }),
        request: Object.freeze({ ...exchange.request, requestedModel: safeModel(exchange.request.requestedModel) }),
        gatewayRouteAttempts: Object.freeze(
          exchange.gatewayRouteAttempts.map((attempt) => Object.freeze(protectRouteAttempt(attempt, protectLabel))),
        ),
      });
    },
  });
}

/**
 * Label-only access to an existing key, for read paths that must not create
 * one (`ironcurtain statistics summary`). Undefined when no key exists yet:
 * then no stored row carries a pseudonym from it either.
 */
export function loadStatisticsLabelProtector(statisticsDirectory: string): StatisticsLabelProtector | undefined {
  const keyPath = getLlmStatisticsIdentityKeyPath(statisticsDirectory);
  if (!existsSync(keyPath)) return undefined;
  const currentKey = keyHolder(() => (existsSync(keyPath) ? readIdentityKey(keyPath) : undefined), keyPath);
  return Object.freeze({
    protectLabel: (namespace: StatisticsIdentityNamespace, value: string): string => {
      const key = currentKey();
      if (key === undefined) throw new Error('Statistics identity key is unavailable');
      return labelDigest(key, namespace, value);
    },
  });
}

/** Wrap every runtime-exposed durable enqueue without changing live bus events. */
export function protectLlmMetricsRepository(
  repository: LlmMetricsRepository,
  protector: PersistenceIdentityProtector,
): LlmMetricsRepository {
  const protectedRepository: LlmMetricsRepository = {
    enqueue: (exchange) => repository.enqueue(protector.protectExchange(exchange)),
    flush: () => repository.flush(),
    close: () => repository.close(),
    health: () => repository.health(),
    snapshotMaxSequence: () => repository.snapshotMaxSequence(),
    scan: (query) => repository.scan(query),
    dimensionValues: (dimension, query) => repository.dimensionValues(dimension, query),
    aggregate: (query) => repository.aggregate(query),
    distribution: (query) => repository.distribution(query),
    sessionTotals: (query) => repository.sessionTotals(query),
    deleteBefore: (cutoffMs, options) => repository.deleteBefore(cutoffMs, options),
  };
  return Object.freeze(protectedRepository);
}
