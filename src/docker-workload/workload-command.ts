/**
 * `ironcurtain docker-workload status|reconcile|clear`: the operator surface
 * for nested-Docker leases. Without it a lease whose exact recovery keeps
 * failing blocks every nested session, and its leftovers are cleaned only when
 * the next one starts.
 *
 * - `status` reads every lease from one snapshot and changes nothing.
 * - `reconcile` runs one bounded exact-recovery pass (what each admission
 *   does first).
 * - `clear <lease-id>` plans, and with `--force` performs, the label-proven
 *   retirement in `lease-clear.ts`.
 */

import { parseArgs } from 'node:util';
import { toDisplayText, toTerminalSafeJsonText } from '../terminal/display-sanitize.js';
import type { DockerEndpoint } from '../docker/docker-endpoint.js';
import type { ContainerRuntime } from '../docker/types.js';
import { clearDockerWorkloadLease, type ClearDockerWorkloadLeaseResult } from './lease-clear.js';
import {
  DOCKER_WORKLOAD_FENCE_REMEDIATION,
  inspectDockerWorkloadLeases,
  reconcileDockerWorkloadLeases,
  type DockerWorkloadLeaseSummary,
  type DockerWorkloadRuntimeKind,
  type ReconcileDockerWorkloadOptions,
} from './infrastructure.js';

const USAGE = `Usage: ironcurtain docker-workload <command> [options]

Inspect and repair nested-Docker (dockerWorkload) leases.

Commands:
  status                     List every lease: state, incident, resources, runtime
  reconcile                  Retry exact recovery of every stale or incident lease once
  clear <lease-id> [--force] Show what clearing a fenced lease would remove; with
                             --force, remove what its generation label still owns
                             on its recorded runtime, prove nothing is left, and
                             retire its record

Options:
  --json   Machine-readable output (status)
  --force  Apply the clear plan
  -h, --help
`;

/** The recorded-runtime seam: production builds real runtimes; tests inject fakes. */
export interface DockerWorkloadCommandDeps {
  readonly write?: (text: string) => void;
  /** Runtime for a lease's recorded kind and Docker endpoint. */
  readonly runtimeFor?: (kind: DockerWorkloadRuntimeKind, endpoint?: DockerEndpoint) => ContainerRuntime;
  /** The runtime this host currently selects; used for records that name none. */
  readonly selectedRuntime?: () => Promise<{
    readonly runtime: ContainerRuntime;
    readonly kind: DockerWorkloadRuntimeKind;
  }>;
  /** Test seams for clocks, liveness, and the watchdog controller. */
  readonly lifecycle?: Pick<
    ReconcileDockerWorkloadOptions,
    'clock' | 'monotonicClock' | 'sleep' | 'pidAlive' | 'processIdentityForPid' | 'supervisor'
  >;
}

/** Returns the process exit code: 0 success, 1 a lease still fences admission or a clear was refused, 2 usage. */
export async function runDockerWorkloadCommand(
  args: readonly string[],
  deps: DockerWorkloadCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        json: { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals.at(0);
  const rest = positionals.slice(1);
  if (values.help === true || command === undefined) {
    write(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  switch (command) {
    case 'status': {
      if (rest.length > 0) return usageError(write, 'status takes no arguments');
      const summaries = inspectDockerWorkloadLeases(deps.lifecycle);
      if (values.json === true) write(`${toTerminalSafeJsonText(JSON.stringify(summaries.map(toJson), null, 2))}\n`);
      else writeStatus(write, summaries);
      return summaries.some((summary) => summary.fencesAdmission) ? 1 : 0;
    }
    case 'reconcile': {
      if (rest.length > 0) return usageError(write, 'reconcile takes no arguments');
      const result = await reconcileDockerWorkloadLeases(await lifecycleOptions(deps));
      write(
        `Reconciled ${result.reconciled.length}, preserved ${result.preserved.length} live, ` +
          `${result.fenced.length} still fenced.\n`,
      );
      for (const leaseId of result.reconciled) write(`  closed   ${display(leaseId)}\n`);
      const fenced = inspectDockerWorkloadLeases(deps.lifecycle).filter((summary) =>
        result.fenced.includes(summary.leaseId),
      );
      for (const summary of fenced) write(`  fenced   ${display(summary.leaseId)}: ${display(summary.detail)}\n`);
      if (fenced.length > 0) write(`${DOCKER_WORKLOAD_FENCE_REMEDIATION}.\n`);
      return result.fenced.length > 0 ? 1 : 0;
    }
    case 'clear': {
      if (rest.length !== 1) return usageError(write, 'clear takes exactly one lease id');
      const [leaseId] = rest;
      const result = await clearDockerWorkloadLease(leaseId, {
        ...(await lifecycleOptions(deps)),
        apply: values.force === true,
      });
      writeClear(write, result);
      return result.outcome === 'refused' ? 1 : 0;
    }
    default:
      return usageError(write, `unknown command: ${display(command)}`);
  }
}

/**
 * One background exact-recovery pass at daemon startup, so leftovers of a
 * crash or a failed teardown are reclaimed now rather than when the next
 * nested session starts. It runs only when some lease is stale or an
 * incident, each lease's recovery is bounded, and it never throws: it returns
 * a one-line outcome for the log, or undefined when there was nothing to do.
 */
export async function reconcileDockerWorkloadLeasesAtStartup(
  deps: DockerWorkloadCommandDeps = {},
): Promise<string | undefined> {
  try {
    const due = inspectDockerWorkloadLeases(deps.lifecycle).filter(
      (summary) => summary.state === 'stale' || summary.state === 'incident',
    );
    if (due.length === 0) return undefined;
    const result = await reconcileDockerWorkloadLeases(await lifecycleOptions(deps));
    return (
      `nested-Docker lease recovery: ${result.reconciled.length} closed, ${result.fenced.length} still fenced` +
      (result.fenced.length === 0
        ? ''
        : ` (${result.fenced.map((leaseId) => display(leaseId)).join(', ')}); see ironcurtain docker-workload status`)
    );
  } catch (error) {
    return `nested-Docker lease recovery failed: ${display(error instanceof Error ? error.message : String(error))}`;
  }
}

function usageError(write: (text: string) => void, message: string): number {
  write(`${message}\n\n${USAGE}`);
  return 2;
}

async function lifecycleOptions(deps: DockerWorkloadCommandDeps): Promise<ReconcileDockerWorkloadOptions> {
  const runtimeFor = deps.runtimeFor ?? (await productionRuntimeFactory());
  const selected = await (deps.selectedRuntime ?? productionSelectedRuntime)();
  return {
    runtime: selected.runtime,
    runtimeKind: selected.kind,
    runtimeForKind: runtimeFor,
    ...deps.lifecycle,
  };
}

async function productionRuntimeFactory(): Promise<
  (kind: DockerWorkloadRuntimeKind, endpoint?: DockerEndpoint) => ContainerRuntime
> {
  const { createContainerRuntime } = await import('../docker/container-runtime.js');
  return (kind, endpoint) => createContainerRuntime(kind, endpoint);
}

/** The configured runtime and, for Docker, the currently selected endpoint. */
async function productionSelectedRuntime(): Promise<{
  readonly runtime: ContainerRuntime;
  readonly kind: DockerWorkloadRuntimeKind;
}> {
  const { loadUserConfig } = await import('../config/user-config.js');
  const { createContainerRuntime, resolveRuntimeKind } = await import('../docker/container-runtime.js');
  const kind = await resolveRuntimeKind(loadUserConfig({ readOnly: true }).containerRuntime);
  if (kind === 'apple-container') return { runtime: createContainerRuntime(kind), kind };
  const { defaultExecFile } = await import('../docker/docker-manager.js');
  const { resolveDockerEndpoint } = await import('../docker/docker-endpoint.js');
  let endpoint: DockerEndpoint | undefined;
  try {
    endpoint = await resolveDockerEndpoint(defaultExecFile);
  } catch {
    // No resolvable context: leases still name their own endpoints.
  }
  return { runtime: createContainerRuntime(kind, endpoint), kind };
}

function writeStatus(write: (text: string) => void, summaries: readonly DockerWorkloadLeaseSummary[]): void {
  if (summaries.length === 0) {
    write('No nested-Docker leases.\n');
    return;
  }
  for (const summary of summaries) {
    const fence = summary.fencesAdmission ? '  [blocks nested-Docker admission]' : '';
    // Directory names are not validated lease ids: never echo them raw.
    write(`${display(summary.leaseId)}  ${summary.state}${fence}\n`);
    write(`  ${display(summary.detail)}\n`);
    const lease = summary.lease;
    if (lease === undefined) {
      write(`  record: ${display(summary.leasePath)}\n`);
      continue;
    }
    const endpoint = lease.schemaVersion === 1 ? undefined : lease.dockerEndpoint?.host;
    write(
      `  lease status ${lease.status}; runtime ${lease.runtimeKind}${endpoint === undefined ? '' : ` at ${display(endpoint)}`}; ` +
        `generation ${lease.generation}\n`,
    );
    write(
      `  coordinator pid ${lease.coordinator.pid}, last heartbeat ${lease.coordinator.heartbeatAt}; created ${lease.createdAt}\n`,
    );
    for (const resource of lease.resources) {
      const removal = resource.removal === null ? 'not proven removed' : `removed (${resource.removal.proof})`;
      write(
        `  ${resource.kind} ${display(resource.requestedName)} [${display(resource.role)}] ` +
          `${resource.observedId === null ? 'unobserved' : display(resource.observedId)}: ${removal}\n`,
      );
    }
  }
  if (summaries.some((summary) => summary.fencesAdmission)) write(`\n${DOCKER_WORKLOAD_FENCE_REMEDIATION}.\n`);
}

function writeClear(write: (text: string) => void, result: ClearDockerWorkloadLeaseResult): void {
  const verb = {
    recovered: 'Recovered',
    cleared: 'Cleared',
    planned: 'Plan for',
    refused: 'Refused to clear',
  }[result.outcome];
  write(`${verb} ${display(result.leaseId)}: ${display(result.detail)}\n`);
  for (const object of result.objects) {
    write(
      `  ${object.kind} ${display(object.name)} (${display(object.id)}) generation ${display(object.generation)}\n`,
    );
  }
  if (result.retiredTo !== undefined) write(`Record kept at ${display(result.retiredTo)}\n`);
  if (result.outcome === 'planned') write('Re-run with --force to apply.\n');
}

function toJson(summary: DockerWorkloadLeaseSummary) {
  return {
    leaseId: summary.leaseId,
    state: summary.state,
    fencesAdmission: summary.fencesAdmission,
    detail: summary.detail,
    ...(summary.lease === undefined
      ? {}
      : {
          status: summary.lease.status,
          runtimeKind: summary.lease.runtimeKind,
          dockerEndpoint: summary.lease.schemaVersion === 1 ? undefined : summary.lease.dockerEndpoint?.host,
          generation: summary.lease.generation,
          incident: summary.lease.incident,
          coordinator: summary.lease.coordinator,
          resources: summary.lease.resources.map((resource) => ({
            kind: resource.kind,
            role: resource.role,
            requestedName: resource.requestedName,
            observedId: resource.observedId,
            removed: resource.removal !== null,
          })),
        }),
  };
}

function display(value: string): string {
  return toDisplayText(value, { maxLength: 400 });
}
