/**
 * `ironcurtain doctor` upgrade checks.
 *
 * Every run reports whether this home was last used by this IronCurtain
 * version (`$IRONCURTAIN_HOME/state.json`, src/config/state-version.ts),
 * read-only: only the CLI's other commands record the running version.
 *
 * `doctor --upgrade` adds what an upgrade can leave behind:
 *
 *   - Changes since: the CHANGELOG's behavior changes between the version
 *     that last ran and this one.
 *   - Workflow definitions: workflow packages of the user's own
 *     (`~/.ironcurtain/workflows/`) that this version's schema rejects;
 *     `workflow list` skips them silently.
 *   - Workflow runs: resumable runs as resume loads them (the checkpoint
 *     store's format check and `checkpoint.prev.json` fallback, run-local
 *     paths rebased onto the run directory): checkpoints or definition copies
 *     written by a newer IronCurtain (WORKFLOW_CHECKPOINT_TOO_NEW), damaged
 *     checkpoints, definitions that no longer validate or no longer have the
 *     recorded state (WORKFLOW_CHECKPOINT_CORRUPTED), and workspaces that no
 *     longer exist (WORKFLOW_WORKSPACE_MISSING).
 *   - Workflow snapshots: container snapshots of resumable runs that resume
 *     will not use, so their scopes start from a fresh container: gone, taken
 *     before snapshots recorded their agent image build, or of an agent image
 *     build this installation no longer resolves (another version, pin or
 *     `agentCliVersions` setting).
 *   - Policies: every compiled policy, global, persona and job, that is
 *     missing, stale against its constitution, invalid, or of stale provenance.
 *
 * Read-only. Docker is only asked about images (`image inspect`), never to
 * pull or run anything.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome, getUserWorkflowsDir, getWorkflowRunsDir } from '../config/paths.js';
import {
  assessStateVersion,
  behaviorChangesBetween,
  describeNewerLayout,
  homeHasContent,
  readPackageChangelog,
  readStateFile,
  UPGRADE_CHECK_COMMAND,
} from '../config/state-version.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { isAgentSudoEnabled } from '../docker/agent-privileges.js';
import { IMAGE_BUILD_HASH_LABEL, isImmutableImageId } from '../docker/image-identity.js';
import type { DockerToolchainSource } from '../docker-workload/toolchain-source.js';
import type { StoredToolAnnotationsFile } from '../pipeline/types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import { VERSION } from '../version.js';
import {
  FileCheckpointStore,
  isCheckpointResumable,
  isWorkflowRunFileTooNewError,
  rebaseRunLocalPaths,
  type LoadedCheckpointRecord,
} from '../workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId } from '../workflow/types.js';
import type { CheckResult } from './checks.js';
import { findJobProblems, findPersonaProblems } from './persona-job-checks.js';

/** At most this many items are listed in one message. */
const MAX_LISTED = 4;

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join('; ');
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

function quote(value: string): string {
  return toDisplayText(JSON.stringify(value), { maxLength: 120 });
}

function errorText(err: unknown): string {
  return toDisplayText(err instanceof Error ? err.message : String(err), { maxLength: 240 });
}

/**
 * Whether this home was last used by `currentVersion`. A home whose layout
 * is newer than this version supports fails (every other command refuses
 * it); a version change warns and points at `doctor --upgrade`.
 */
export function checkVersionState(currentVersion: string = VERSION, upgradeRequested = false): CheckResult {
  const name = 'IronCurtain version';
  const read = readStateFile();
  const assessment = assessStateVersion(read, currentVersion, homeHasContent());
  if (assessment.layout === 'newer') {
    return { name, status: 'fail', message: describeNewerLayout(assessment.recordedLayoutVersion, currentVersion) };
  }
  const hint = upgradeRequested
    ? 'See the Upgrade section below.'
    : `Run \`${UPGRADE_CHECK_COMMAND}\` to check this home against this version.`;
  const previous = toDisplayText(assessment.previousVersion ?? '', { maxLength: 64 });
  if (read.kind === 'invalid') {
    return {
      name,
      status: 'warn',
      message: `${currentVersion}; state.json is unreadable (${toDisplayText(read.reason)}), so the version that last ran is unknown`,
      hint,
    };
  }
  switch (assessment.change) {
    case 'fresh':
      return { name, status: 'ok', message: `${currentVersion} (new home)` };
    case 'same':
      return { name, status: 'ok', message: currentVersion };
    case 'upgraded':
      return { name, status: 'warn', message: `${currentVersion}; this home was last used by ${previous}`, hint };
    case 'downgraded':
      return {
        name,
        status: 'warn',
        message: `${currentVersion} is older than ${previous}, which last used this home; files it wrote may not be readable`,
        hint,
      };
    case 'unknown':
      return {
        name,
        status: 'warn',
        message:
          assessment.previousVersion === undefined
            ? `${currentVersion}; this home was last used by an IronCurtain that did not record its version`
            : `${currentVersion}; the version that last ran (${previous}) cannot be compared`,
        hint,
      };
  }
}

/** The CHANGELOG's behavior changes since the version that last used this home. */
export function checkChangesSince(currentVersion: string = VERSION): CheckResult {
  const read = readStateFile();
  const assessment = assessStateVersion(read, currentVersion, homeHasContent());
  const previous = assessment.change === 'upgraded' ? assessment.previousVersion : undefined;
  const name = previous === undefined ? `Changes in ${currentVersion}` : 'Changes since last run';
  const releases = readPackageChangelog();
  if (releases === undefined) {
    return { name, status: 'skip', message: 'CHANGELOG.md is not part of this installation' };
  }
  const changes = behaviorChangesBetween(releases, previous, currentVersion);
  const span = previous === undefined ? currentVersion : `${toDisplayText(previous)} -> ${currentVersion}`;
  if (changes.length === 0) return { name, status: 'ok', message: `no behavior changes recorded (${span})` };
  return {
    name,
    status: 'ok',
    message: `${changes.length} behavior change${changes.length === 1 ? '' : 's'} (${span}): ${listed(changes)}`,
    hint: 'See CHANGELOG.md for the details.',
  };
}

/** Directory entries of `dir` that are directories and not hidden; [] when it does not exist. */
function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Workflow packages of the user's own that this version's schema rejects.
 * Directories without a `workflow.yaml`/`workflow.yml` are not packages.
 */
export async function checkWorkflowDefinitions(): Promise<CheckResult> {
  const name = 'Workflow definitions';
  const { loadDefinition } = await import('../workflow/definition-loader.js');
  const root = getUserWorkflowsDir();
  let packages = 0;
  const invalid: string[] = [];
  for (const entry of listDirectories(root)) {
    const manifest = ['workflow.yaml', 'workflow.yml'].map((file) => resolve(root, entry, file)).find(existsSync);
    if (manifest === undefined) continue;
    packages++;
    const loaded = loadDefinition(manifest);
    if (!loaded.ok) invalid.push(`${quote(entry)}: ${toDisplayText(loaded.message, { maxLength: 240 })}`);
  }
  if (packages === 0) return { name, status: 'ok', message: `none of your own (${toDisplayText(root)})` };
  if (invalid.length === 0) {
    return { name, status: 'ok', message: `${packages} of your own, all valid for this version` };
  }
  return {
    name,
    status: 'warn',
    message: `${invalid.length} of ${packages} no longer validate (\`workflow list\` hides them): ${listed(invalid)}`,
    hint: '`ironcurtain workflow lint <path>` shows every issue.',
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A resumable run, loaded as resume loads it. */
interface ResumableRun {
  readonly id: WorkflowId;
  readonly dir: string;
  /** The checkpoint with its run-local paths rebased onto `dir` (`rebaseRunLocalPaths`). */
  readonly checkpoint: WorkflowCheckpoint;
  /** The workspace path as the checkpoint records it, before rebasing. */
  readonly recordedWorkspace: string | undefined;
  /** `checkpoint.json` is damaged and resume falls back to `checkpoint.prev.json`. */
  readonly recoveredFromPrevious: boolean;
}

/**
 * The runs whose checkpoint resume would load and that are not completed,
 * read through the checkpoint store exactly as resume reads them (format
 * version check, `checkpoint.prev.json` fallback, safe run ids only), with
 * their run-local paths rebased onto the directory they were found in.
 * Checkpoints that cannot be loaded are reported. Nothing is written: the
 * store only writes on save, and its recovery warning is reported here
 * instead of printed.
 */
function readResumableRuns(): { readonly runs: ResumableRun[]; readonly unreadable: string[] } {
  const base = getWorkflowRunsDir();
  const store = new FileCheckpointStore(base, { warn: () => undefined });
  const runs: ResumableRun[] = [];
  const unreadable: string[] = [];
  let ids: WorkflowId[];
  try {
    ids = store.listAll().sort();
  } catch (err) {
    return { runs, unreadable: [`${toDisplayText(base)} cannot be read: ${errorText(err)}`] };
  }
  for (const id of ids) {
    let record: LoadedCheckpointRecord | undefined;
    try {
      record = store.loadRecord(id);
    } catch (err) {
      unreadable.push(
        isWorkflowRunFileTooNewError(err)
          ? `${quote(id)}: its checkpoint was written by a newer IronCurtain, so this version refuses to resume it`
          : `${quote(id)}: its checkpoint cannot be loaded, so it cannot be resumed: ${errorText(err)}`,
      );
      continue;
    }
    if (record === undefined || !isCheckpointResumable(record.checkpoint)) continue;
    const dir = resolve(base, id);
    runs.push({
      id,
      dir,
      checkpoint: rebaseRunLocalPaths(record.checkpoint, id, dir),
      recordedWorkspace: record.checkpoint.workspacePath,
      recoveredFromPrevious: record.recoveredFromPrevious,
    });
  }
  return { runs, unreadable };
}

/**
 * Resumable runs that resume would refuse, judged as `resume()` judges them:
 * the definition it loads (the run's `definition.json` copy, format-checked,
 * else the recorded `definitionPath`) must validate without the allowances
 * that only past-run displays get and must contain the recorded state, and
 * the workspace (the recorded path rebased onto the run directory, so a moved
 * IronCurtain home is no problem) must still exist: resume refuses a missing
 * one, the run's default workspace included, instead of recreating it empty.
 * A checkpoint resume would replace with its previous copy is reported too.
 */
export async function checkWorkflowRuns(): Promise<CheckResult> {
  const name = 'Workflow runs';
  const { loadDefinition } = await import('../workflow/definition-loader.js');
  const { loadRunDefinition, runDefinitionPath } = await import('../workflow/run-definition.js');
  const { runs, unreadable } = readResumableRuns();
  const problems = [...unreadable];
  for (const run of runs) {
    if (run.recoveredFromPrevious) {
      problems.push(
        `${quote(run.id)}: checkpoint.json is damaged, so resume continues from checkpoint.prev.json, one step older`,
      );
    }
    const copy = runDefinitionPath(run.dir);
    const hasCopy = existsSync(copy);
    const definitionPath = hasCopy ? copy : resolve(run.checkpoint.definitionPath);
    const loaded = hasCopy ? loadRunDefinition(copy) : loadDefinition(definitionPath);
    if (!loaded.ok) {
      problems.push(
        loaded.kind === 'too_new'
          ? `${quote(run.id)}: its definition copy was written by a newer IronCurtain, so this version refuses to resume it`
          : `${quote(run.id)}: its definition (${toDisplayText(definitionPath)}) no longer validates, so resume fails: ` +
              toDisplayText(loaded.message, { maxLength: 200 }),
      );
    } else {
      const state = String(run.checkpoint.machineState);
      if (!Object.hasOwn(loaded.definition.states, state)) {
        problems.push(`${quote(run.id)}: its definition has no state ${quote(state)} any more, so resume fails`);
      }
    }
    // No recorded workspace (checkpoints from before workspaces were
    // recorded): resume creates the default one.
    const workspace = run.checkpoint.workspacePath;
    if (workspace !== undefined && !isDirectory(workspace)) {
      const moved =
        run.recordedWorkspace !== undefined && run.recordedWorkspace !== workspace
          ? ` (recorded as ${toDisplayText(run.recordedWorkspace)})`
          : '';
      problems.push(
        `${quote(run.id)}: its workspace ${toDisplayText(workspace)}${moved} no longer exists, so resume refuses the run`,
      );
    }
  }
  if (runs.length === 0 && problems.length === 0) return { name, status: 'ok', message: 'no resumable runs' };
  if (problems.length === 0) {
    return { name, status: 'ok', message: `${runs.length} resumable run(s), all resumable by this version` };
  }
  return {
    name,
    status: 'warn',
    message: `${problems.length} problem(s) in ${runs.length + unreadable.length} resumable run(s): ${listed(problems)}`,
    hint:
      'Finish or abort these runs with the IronCurtain version that started them, or fix the stored files ' +
      `under ${toDisplayText(getWorkflowRunsDir())}.`,
  };
}

/** Image questions the snapshot check asks (the Docker CLI by default; tests inject). */
export interface SnapshotImageInspector {
  /** The image's `ironcurtain.build-hash` label, null when it has none; undefined when the image is gone. */
  buildHash(image: string): Promise<string | null | undefined>;
  /** The agent image builds a resume resolves now ({@link currentAgentImageBuildHashes}). */
  currentAgentBuildHashes(): Promise<ReadonlySet<string>>;
}

/**
 * The agent image builds a bundle of this installation resolves, which are the
 * only builds whose snapshots resume uses: per agent, the build of its pinned
 * CLI or of the `agentCliVersions` override, and with `toolchainSource` (the
 * Docker toolchain image, for nested-Docker sessions) that build's
 * nested-Docker variant too. Computed from the shipped Dockerfiles; no runtime
 * access.
 */
export async function currentAgentImageBuildHashes(
  userConfig: Pick<ResolvedUserConfig, 'agentCliVersions'>,
  toolchainSource?: DockerToolchainSource,
): Promise<ReadonlySet<string>> {
  const { registerBuiltinAdapters, listAgents } = await import('../docker/agent-registry.js');
  const { agentImageBuildOptions, describeAgentImageBuild } = await import('../docker/docker-infrastructure.js');
  await registerBuiltinAdapters();
  const hashes = new Set<string>();
  for (const agent of listAgents()) {
    try {
      const image = await agent.getImage();
      const buildOptions = agentImageBuildOptions(agent, userConfig);
      hashes.add(describeAgentImageBuild(image, buildOptions).buildHash);
      if (toolchainSource !== undefined) {
        hashes.add(describeAgentImageBuild(image, buildOptions, toolchainSource).buildHash);
      }
    } catch {
      // An agent without a shipped Dockerfile has no build hash to compare.
    }
  }
  return hashes;
}

async function defaultSnapshotInspector(
  userConfig: Pick<ResolvedUserConfig, 'agentCliVersions'>,
): Promise<SnapshotImageInspector> {
  const { createDockerManager } = await import('../docker/docker-manager.js');
  const docker = createDockerManager();
  return {
    buildHash: async (image) => {
      const info = await docker.inspectImage(image);
      if (info === undefined) return undefined;
      return Object.hasOwn(info.labels, IMAGE_BUILD_HASH_LABEL) ? info.labels[IMAGE_BUILD_HASH_LABEL] : null;
    },
    currentAgentBuildHashes: async () => {
      // Nested-Docker builds embed the Docker toolchain image; counted when it
      // is already on the engine (inspected, never pulled), as `images` does.
      const { findLocalDockerToolchainSource } = await import('../docker-workload/toolchain-source.js');
      const toolchainSource = await findLocalDockerToolchainSource(docker).catch(() => undefined);
      return currentAgentImageBuildHashes(userConfig, toolchainSource);
    },
  };
}

/**
 * Container snapshots of resumable runs that resume will not use, so their
 * scopes start from a fresh container: the workspace carries over, anything
 * else installed in the old container does not. Predicts resume's own
 * decision, in its order (`snapshotToResume` in the orchestrator, then
 * `selectResumableSnapshot` in docker-infrastructure.ts): the checkpoint must
 * record the agent image build the snapshot was taken from and name it by
 * immutable image ID, that build must be one this installation resolves now
 * (its pins and `agentCliVersions`, see {@link currentAgentImageBuildHashes}),
 * under `agentSudo: false` the snapshot must record that its agent ran without
 * sudo, and the image must still exist with that build's label. Skipped when
 * Docker is unavailable.
 */
export async function checkWorkflowSnapshots(
  dockerAvailable: boolean,
  inspector?: SnapshotImageInspector,
  userConfig: Pick<ResolvedUserConfig, 'agentCliVersions'> & Partial<Pick<ResolvedUserConfig, 'agentSudo'>> = {},
): Promise<CheckResult> {
  const name = 'Workflow snapshots';
  const snapshots: {
    readonly run: string;
    readonly image: string;
    readonly recorded?: string;
    readonly sudoOff: boolean;
  }[] = [];
  for (const run of readResumableRuns().runs) {
    for (const ref of Object.values(run.checkpoint.containerSnapshots ?? {})) {
      // Checkpoints are files on disk; read each reference defensively.
      if (!isPlainObject(ref)) continue;
      snapshots.push({
        run: run.id,
        image: ref.image,
        ...(typeof ref.agentBuildHash === 'string' ? { recorded: ref.agentBuildHash } : {}),
        sudoOff: ref.agentSudo === false,
      });
    }
  }
  if (snapshots.length === 0) return { name, status: 'ok', message: 'no resumable run keeps a container snapshot' };
  if (!dockerAvailable) {
    return { name, status: 'skip', message: `${snapshots.length} snapshot(s) not checked: Docker is unavailable` };
  }

  let images: SnapshotImageInspector;
  let current: ReadonlySet<string>;
  try {
    images = inspector ?? (await defaultSnapshotInspector(userConfig));
    current = await images.currentAgentBuildHashes();
  } catch (err) {
    return { name, status: 'warn', message: `could not be checked: ${errorText(err)}` };
  }
  const unrecorded: string[] = [];
  const unpinned: string[] = [];
  const foreign: string[] = [];
  const privileged: string[] = [];
  const gone: string[] = [];
  const mislabeled: string[] = [];
  const agentSudo = isAgentSudoEnabled(userConfig);
  for (const snapshot of snapshots) {
    const label = `${quote(snapshot.run)} (${toDisplayText(snapshot.image, { maxLength: 30 })})`;
    if (snapshot.recorded === undefined) {
      unrecorded.push(label);
      continue;
    }
    if (!isImmutableImageId(snapshot.image)) {
      unpinned.push(label);
      continue;
    }
    if (!current.has(snapshot.recorded)) {
      foreign.push(label);
      continue;
    }
    if (!agentSudo && !snapshot.sudoOff) {
      privileged.push(label);
      continue;
    }
    let labelled: string | null | undefined;
    try {
      labelled = await images.buildHash(snapshot.image);
    } catch (err) {
      gone.push(`${label}: ${errorText(err)}`);
      continue;
    }
    if (labelled === undefined) gone.push(label);
    else if (labelled !== snapshot.recorded) mislabeled.push(label);
  }
  const problems: string[] = [];
  if (unrecorded.length > 0) {
    problems.push(`taken before snapshots recorded their agent image build: ${listed(unrecorded)}`);
  }
  if (unpinned.length > 0) problems.push(`not named by an immutable image ID: ${listed(unpinned)}`);
  if (foreign.length > 0) {
    problems.push(`taken from an agent image build this installation does not resolve now: ${listed(foreign)}`);
  }
  if (privileged.length > 0) {
    problems.push(`not recorded as taken without agent sudo, which agentSudo: false requires: ${listed(privileged)}`);
  }
  if (gone.length > 0) problems.push(`gone: ${listed(gone)}`);
  if (mislabeled.length > 0) {
    problems.push(`not labeled with the agent image build their run recorded: ${listed(mislabeled)}`);
  }
  if (problems.length === 0) {
    return { name, status: 'ok', message: `${snapshots.length} snapshot(s) from this version's agent images` };
  }
  const unused =
    unrecorded.length + unpinned.length + foreign.length + privileged.length + gone.length + mislabeled.length;
  return {
    name,
    status: 'warn',
    message:
      `${unused} of ${snapshots.length} snapshot(s) will not be resumed, so their scopes start from a fresh ` +
      `container: ${problems.join(' | ')}`,
    hint:
      'Resume keeps the workspace but not what was installed in the old container. To keep a snapshot, finish its ' +
      'run with the IronCurtain version and the agentCliVersions and agentSudo settings that took it.',
  };
}

/**
 * Every compiled policy (global, personas, jobs) that is missing, stale
 * against its constitution, invalid, or of stale provenance. `globalStale`
 * is the global policy's finding from the Configuration section.
 */
export function checkPolicyFreshness(
  config: IronCurtainConfig,
  annotations: StoredToolAnnotationsFile | undefined,
  globalStale: string | undefined,
): CheckResult {
  const name = 'Policies';
  const stale: string[] = [];
  if (globalStale !== undefined) stale.push(`global: ${globalStale}`);
  let total = 1;
  try {
    for (const finding of [...findPersonaProblems(config, annotations), ...findJobProblems(annotations)]) {
      total++;
      if (finding.policyProblem !== undefined) stale.push(`${finding.subject}: ${finding.policyProblem}`);
    }
  } catch (err) {
    return { name, status: 'warn', message: `could not be checked: ${errorText(err)}` };
  }
  if (stale.length === 0) {
    return { name, status: 'ok', message: `${total} compiled polic${total === 1 ? 'y' : 'ies'}, all current` };
  }
  return {
    name,
    status: 'warn',
    message: `${stale.length} of ${total} need recompiling: ${listed(stale)}`,
    hint: `Each entry names its command. Policies live under ${toDisplayText(getIronCurtainHome())}.`,
  };
}
