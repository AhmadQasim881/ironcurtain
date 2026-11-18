/**
 * Frozen watchdog-policy template plus per-session renderer.
 *
 * The checked-in template (`config/docker-workload/resource-watchdog-policy.json`)
 * freezes every measurement threshold and, per runtime, the storage classes
 * that give the observed-disk ceiling real coverage. It deliberately omits the
 * per-session `targetRoot`/`targetDevice`/`targetInode`. `renderWatchdogPolicy`
 * selects the admitted runtime's coverage, stamps the concrete state root, and
 * writes the immutable policy snapshot copied into the lease. A runtime with no
 * coverage in the template is not admitted at all: an observed-disk preview
 * whose watchdog cannot see the bundle's storage is a false ceiling. The
 * supervisor compares full validated values, then samples its private
 * in-memory copy for the generation's lifetime.
 */

import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { assertCanonicalHostPath, loadPackageAssetJson, writeStableJsonAtomic } from '../hardened-fs.js';
import { getIronCurtainPackageRoot } from '../docker/docker-workload-paths.js';
import { identifierSchema } from '../zod-helpers.js';
import {
  loadResourceWatchdogPolicy,
  RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
  RUNTIME_STORAGE_CLASS_KIND,
  resourceWatchdogPolicySchema,
  runtimeStorageClassSchema,
  type LoadedResourceWatchdogPolicy,
  type RuntimeStorageRuntimeKind,
  type RuntimeStorageWatchdogPolicy,
} from '../docker/resource-watchdog.js';
import type { DockerWorkloadLease } from './bundle-lease.js';

/** Version 2 replaced the host-directory classes (which nothing ever wrote) with per-runtime coverage. */
export const WATCHDOG_POLICY_TEMPLATE_SCHEMA_VERSION = 2;
export const MAX_WATCHDOG_POLICY_TEMPLATE_BYTES = 256 * 1024;

/**
 * Frozen coordinator-side lifecycle constants (heartbeat, staleness, and crash
 * recovery bound). Kept beside the watchdog policy so every frozen timing value
 * for the Docker-workload lifecycle lives in one auditable place; the bundle
 * cannot mount or mutate them. The stale bound is measured on each observer's
 * own monotonic clock from when it last saw the heartbeat change.
 */
export const DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS = 5_000;
export const DOCKER_WORKLOAD_STALE_HEARTBEAT_MS = 30_000;
export const DOCKER_WORKLOAD_RECOVERY_BOUND_MS = 120_000;
export const DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS = 30_000;
/**
 * Preallocated per-lease emergency reserve. Revocation frees it before its
 * first durable write, so a full host disk still leaves room for the lease,
 * lock, and status records that prove cleanup. Generous for those records,
 * which are a few KiB each.
 */
export const DOCKER_WORKLOAD_EMERGENCY_RESERVE_BYTES = 4 * 1024 * 1024;

const positiveBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const dockerCoverageSchema = z
  .object({
    stateClasses: z.array(runtimeStorageClassSchema).min(1).max(8),
    runtimeReserveBytes: positiveBytes,
  })
  .strict();
const appleCoverageSchema = z.object({ stateClasses: z.array(runtimeStorageClassSchema).min(1).max(8) }).strict();

const watchdogPolicyTemplateSchema = z
  .object({
    schemaVersion: z.literal(WATCHDOG_POLICY_TEMPLATE_SCHEMA_VERSION),
    policyId: identifierSchema,
    coverage: z
      .object({
        docker: dockerCoverageSchema.optional(),
        'apple-container': appleCoverageSchema.optional(),
      })
      .strict(),
    sampleIntervalMs: z.number().int().min(100).max(60_000),
    sampleTimeoutMs: z.number().int().min(100).max(60_000),
    staleAfterMs: z
      .number()
      .int()
      .min(200)
      .max(5 * 60_000),
    softEvidenceBytes: positiveBytes,
    hardSafetyBytes: positiveBytes,
    hostReserveBytes: positiveBytes,
    maximumOvershootBytes: positiveBytes,
    cleanupInventoryGapMs: z.number().int().min(100).max(60_000),
  })
  .strict()
  .superRefine((template, context) => {
    if (template.softEvidenceBytes >= template.hardSafetyBytes) {
      context.addIssue({ code: 'custom', message: 'watchdog soft threshold must be below hard threshold' });
    }
    if (template.sampleTimeoutMs >= template.staleAfterMs || template.staleAfterMs < template.sampleIntervalMs * 2) {
      context.addIssue({ code: 'custom', message: 'watchdog stale threshold must exceed timeout and two intervals' });
    }
    for (const runtimeKind of ['docker', 'apple-container'] as const) {
      const coverage = template.coverage[runtimeKind];
      if (coverage === undefined) continue;
      const expectedKind = RUNTIME_STORAGE_CLASS_KIND[runtimeKind];
      if (coverage.stateClasses.some((stateClass) => stateClass.kind !== expectedKind)) {
        context.addIssue({ code: 'custom', message: `${runtimeKind} coverage must measure ${expectedKind} storage` });
      }
      const ids = coverage.stateClasses.map((stateClass) => stateClass.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', message: 'duplicate watchdog state class ID' });
      }
    }
  });

export type WatchdogPolicyTemplate = z.infer<typeof watchdogPolicyTemplateSchema>;

/**
 * Read and validate the bounded frozen template through one no-follow
 * descriptor. It ships in the package, so it gets the package-asset ownership
 * and mode rules (a umask-002 install is accepted) and must lie below
 * `packageRoot`, which only tests override.
 */
export function loadFrozenWatchdogPolicyTemplate(
  path: string,
  packageRoot: string = getIronCurtainPackageRoot(),
): WatchdogPolicyTemplate {
  return loadPackageAssetJson(path, {
    label: 'watchdog policy template',
    schema: watchdogPolicyTemplateSchema,
    maxBytes: MAX_WATCHDOG_POLICY_TEMPLATE_BYTES,
    packageRoot,
  }).value;
}

/** The concrete state root a rendered policy is bound to. */
export interface WatchdogPolicyTarget {
  readonly root: string;
  readonly device: number;
  readonly inode: number;
}

/**
 * Throw unless the frozen template measures this runtime's storage. The
 * observed-disk preview is admitted only where the watchdog can see the
 * storage the bundle grows; admission checks this before creating any
 * lease-specific state.
 */
export function assertRuntimeWatchdogCoverage(
  template: WatchdogPolicyTemplate,
  runtimeKind: RuntimeStorageRuntimeKind,
): void {
  if (template.coverage[runtimeKind] === undefined) {
    throw new Error(
      `the frozen watchdog policy has no storage coverage for the ${runtimeKind} runtime; ` +
        'nested Docker is not admitted without an observed-disk watchdog that can see the bundle storage',
    );
  }
}

/** Pure projection of the frozen template onto one covered runtime and state root. */
export function buildRuntimeWatchdogPolicy(
  template: WatchdogPolicyTemplate,
  runtimeKind: RuntimeStorageRuntimeKind,
  target: WatchdogPolicyTarget,
): RuntimeStorageWatchdogPolicy {
  const validatedTemplate = watchdogPolicyTemplateSchema.parse(template);
  assertRuntimeWatchdogCoverage(validatedTemplate, runtimeKind);
  const coverage = validatedTemplate.coverage[runtimeKind];
  if (coverage === undefined) throw new Error(`no ${runtimeKind} watchdog coverage`);
  const policy = resourceWatchdogPolicySchema.parse({
    schemaVersion: RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
    policyId: validatedTemplate.policyId,
    runtimeKind,
    targetRoot: target.root,
    targetDevice: target.device,
    targetInode: target.inode,
    stateClasses: coverage.stateClasses,
    ...('runtimeReserveBytes' in coverage ? { runtimeReserveBytes: coverage.runtimeReserveBytes } : {}),
    sampleIntervalMs: validatedTemplate.sampleIntervalMs,
    sampleTimeoutMs: validatedTemplate.sampleTimeoutMs,
    staleAfterMs: validatedTemplate.staleAfterMs,
    softEvidenceBytes: validatedTemplate.softEvidenceBytes,
    hardSafetyBytes: validatedTemplate.hardSafetyBytes,
    hostReserveBytes: validatedTemplate.hostReserveBytes,
    maximumOvershootBytes: validatedTemplate.maximumOvershootBytes,
    cleanupInventoryGapMs: validatedTemplate.cleanupInventoryGapMs,
  });
  if (policy.schemaVersion !== RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION) {
    throw new Error('rendered watchdog policy must use the runtime-storage schema');
  }
  return policy;
}

/**
 * Stamp the concrete state root's device/inode onto the frozen template for
 * the admitted runtime, write immutable per-session policy `0o400`. The lease
 * owns a complete snapshot; this launch input must compare equal. The state
 * root must already exist.
 */
export function renderWatchdogPolicy(
  template: WatchdogPolicyTemplate,
  runtimeKind: RuntimeStorageRuntimeKind,
  stateRoot: string,
  outputPath: string,
): LoadedResourceWatchdogPolicy {
  assertCanonicalHostPath(stateRoot, 'watchdog policy state root');
  assertCanonicalHostPath(outputPath, 'watchdog policy output path');
  const stats = lstatSync(stateRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('watchdog policy state root must be a real directory');
  }
  const rendered = buildRuntimeWatchdogPolicy(template, runtimeKind, {
    root: stateRoot,
    device: stats.dev,
    inode: stats.ino,
  });
  writeStableJsonAtomic(outputPath, rendered, { mode: 0o400 });
  return loadResourceWatchdogPolicy(outputPath);
}

/** Validate launch/recovery input against the original generation's contract. */
export function loadLeaseWatchdogPolicy(lease: DockerWorkloadLease, path: string): LoadedResourceWatchdogPolicy {
  const loaded = loadResourceWatchdogPolicy(path);
  const matches =
    lease.schemaVersion === 1
      ? loaded.sha256 === lease.bindings.watchdogPolicySha256
      : isDeepStrictEqual(loaded.policy, lease.bindings.watchdogPolicy);
  if (!matches) throw new Error('watchdog policy does not match the bundle lease');
  if (
    loaded.policy.targetRoot !== lease.paths.stateRoot ||
    loaded.policy.cleanupInventoryGapMs !== lease.cleanupInventoryGapMs
  ) {
    throw new Error('watchdog policy target or cleanup interval does not match the bundle lease');
  }
  if (
    loaded.policy.schemaVersion === RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION &&
    loaded.policy.runtimeKind !== lease.runtimeKind
  ) {
    throw new Error('watchdog policy measures a different runtime than the bundle lease');
  }
  return loaded;
}
