import { parseArgs } from 'node:util';
import { createContainerRuntime, CONTAINER_RUNTIME_KINDS, type ContainerRuntimeKind } from './container-runtime.js';
import { reconcileIronCurtainDockerResources, type ReconcileResult } from './docker-resource-lifecycle.js';
import type { ContainerRuntime } from './types.js';

const USAGE =
  'Usage: ironcurtain gc [--dry-run | --force] [--runtime docker|apple-container|all]\n\n' +
  'Lists crash-orphaned IronCurtain containers and networks by default.\n' +
  'Use --force to remove resources whose owner process is gone or released them.\n' +
  '--runtime selects the container runtime to inspect (default: docker); "all"\n' +
  'inspects Docker and Apple Container.\n';

export interface DockerGcCommandDeps {
  /** Runtime factory (tests inject fakes). */
  readonly createRuntime?: (kind: ContainerRuntimeKind) => ContainerRuntime;
  readonly write?: (text: string) => void;
}

function parseRuntimeSelection(value: string | undefined): readonly ContainerRuntimeKind[] {
  if (value === undefined || value === 'docker') return ['docker'];
  if (value === 'all') return CONTAINER_RUNTIME_KINDS;
  if (value === 'apple-container') return ['apple-container'];
  throw new Error(`Unknown --runtime value "${value}" (expected docker, apple-container or all)`);
}

function writeReport(
  write: (text: string) => void,
  kind: ContainerRuntimeKind,
  result: ReconcileResult,
  apply: boolean,
): void {
  const verb = apply ? 'Reclaimed' : 'Would reclaim';
  write(
    `[${kind}] ${verb} ${result.removedContainers.length} container(s) and ${result.removedNetworks.length} network(s).\n`,
  );
  for (const decision of result.decisions) {
    if (decision.action !== 'reclaim') continue;
    const label = decision.kind === 'container' ? 'container' : 'network  ';
    write(`  ${label} ${decision.name} (${decision.classification})\n`);
  }
  const retained = result.decisions.filter((decision) => decision.action === 'retain');
  if (retained.length > 0) {
    const counts = new Map<string, number>();
    for (const decision of retained)
      counts.set(decision.classification, (counts.get(decision.classification) ?? 0) + 1);
    write(
      `Retained ${retained.length} resource(s) whose owner may be alive: ` +
        `${[...counts].map(([classification, count]) => `${count} ${classification}`).join(', ')}.\n`,
    );
  }
  const skipped = result.decisions.filter((decision) => decision.action === 'skip');
  if (skipped.length > 0) {
    write(`Skipped ${skipped.length} resource(s) that could not be proven orphaned or removed:\n`);
    for (const decision of skipped) write(`  ${decision.kind} ${decision.name}: ${decision.reason}\n`);
  }
  if (result.prunedLeases > 0) write(`Removed ${result.prunedLeases} finished owner lease record(s).\n`);
}

/** Explicit operator surface for inspecting or applying the startup reconciler. */
export async function runDockerGcCommand(args: readonly string[], deps: DockerGcCommandDeps = {}): Promise<void> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const { values } = parseArgs({
    args: [...args],
    options: {
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      runtime: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    write(USAGE);
    return;
  }
  if (values.force && values['dry-run']) throw new Error('Choose either --dry-run or --force, not both');
  const runtimes = parseRuntimeSelection(values.runtime);
  const createRuntime = deps.createRuntime ?? ((kind: ContainerRuntimeKind) => createContainerRuntime(kind));

  const apply = values.force === true;
  const failures: string[] = [];
  for (const kind of runtimes) {
    let result: ReconcileResult;
    try {
      result = await reconcileIronCurtainDockerResources(createRuntime(kind), {
        dryRun: !apply,
        runtimeKind: kind,
      });
    } catch (error) {
      // With --runtime all, an unavailable runtime must not hide the other's report.
      if (runtimes.length === 1) throw error;
      failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    writeReport(write, kind, result, apply);
  }
  for (const failure of failures) write(`Could not inspect ${failure}\n`);
  if (!apply) write('Re-run with --force to apply this plan.\n');
}
