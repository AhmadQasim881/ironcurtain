/**
 * `ironcurtain images status|rebuild|prune`: the operator surface for the
 * Docker agent images and the agent CLI versions they install.
 *
 * Images are built from this installation's `docker/` directory under build
 * tags (`<repository>:build-<hash>`, see image-identity.ts), so `status`
 * reports for each agent the build this installation expects, whether it is
 * present, and the CLI version it installs (the pin, or the `agentCliVersions`
 * override). `rebuild` rebuilds without the layer cache, which is how a
 * `latest` override picks up a newer CLI release. `prune` lists the builds
 * kept from other versions or checkouts and, with `--force`, removes them.
 *
 * Nested-Docker sessions (`dockerWorkload`) build their own base and agent
 * images: the Docker toolchain image they embed is part of the build hash.
 * `status` and `rebuild` cover those builds too when nested Docker is enabled
 * and the toolchain image is on the engine, and `prune` never counts them as
 * superseded.
 */

import { parseArgs } from 'node:util';
import { DOCKER_AGENTS, loadUserConfig, type DockerAgent, type ResolvedUserConfig } from '../config/user-config.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { errorMessage } from '../utils/error-message.js';
import { VERSION } from '../version.js';
import type { AgentAdapter, AgentId } from './agent-adapter.js';
import {
  assessAgentCliVersion,
  describeAgentCliVersionSelection,
  describeAgentCliVersionVerdict,
  type AgentCliVersionSupport,
} from './agent-cli-version.js';
import { createContainerRuntime, resolveRuntimeKind, type ContainerRuntimeKind } from './container-runtime.js';
import {
  agentImageBuildOptions,
  describeAgentImageBuild,
  rebuildAgentImage,
  type AgentImageBuildDescription,
  type AgentImageRebuildScope,
} from './docker-infrastructure.js';
import { IMAGE_BUILD_HASH_LABEL, imageRepository, isImageBuildTagIn } from './image-identity.js';
import type { ContainerRuntime } from './types.js';
import { findLocalDockerToolchainSource, type DockerToolchainSource } from '../docker-workload/toolchain-source.js';

const USAGE = `Usage: ironcurtain images <status|rebuild|prune> [options]

Docker agent images are built from this installation's docker/ directory and
tagged by build hash (<image>:build-<hash>); <image>:latest points at the build
used last. Each agent image installs a pinned CLI version unless
agentCliVersions in ~/.ironcurtain/config.json overrides it.

Commands:
  status           Show each image's expected build, whether it is built, and
                   the agent CLI version it installs
  rebuild          Rebuild agent images without the build cache (picks up a
                   newer CLI when agentCliVersions selects "latest")
  prune            List builds kept from other versions or checkouts; with
                   --force, remove them (never this installation's builds,
                   nested-Docker ones included)

Options:
  --agent <name>   claude-code, codex or goose (status: default all agents;
                   rebuild: default the preferred agent)
  --all            rebuild: every agent image
  --with-base      rebuild: also rebuild the base image without the cache
  --probe          status: run each built image's CLI to report its version
  --force          prune: remove the listed builds
  --runtime <kind> docker or apple-container (default: the configured runtime)
  -h, --help       Show this help
`;

/** What the command needs from an agent adapter. */
export type ImagesCommandAdapter = Pick<AgentAdapter, 'getImage' | 'versionProbe' | 'cliVersion'>;

export interface ImagesCommandDeps {
  readonly write?: (text: string) => void;
  /** Resolved user config (default: `loadUserConfig({ readOnly: true })`). */
  readonly userConfig?: ResolvedUserConfig;
  /** Runtime factory (tests inject fakes). */
  readonly createRuntime?: (kind: ContainerRuntimeKind) => ContainerRuntime;
  /** Resolves the configured runtime when `--runtime` is not given. */
  readonly resolveRuntime?: (userConfig: ResolvedUserConfig) => Promise<ContainerRuntimeKind>;
  /** Adapter lookup (default: the built-in agent registry). */
  readonly getAdapter?: (agent: DockerAgent) => Promise<ImagesCommandAdapter>;
}

interface ImagesCommandContext {
  readonly write: (text: string) => void;
  readonly userConfig: ResolvedUserConfig;
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly getAdapter: (agent: DockerAgent) => Promise<ImagesCommandAdapter>;
}

function parseAgent(value: string | undefined): DockerAgent | undefined {
  if (value === undefined) return undefined;
  if ((DOCKER_AGENTS as readonly string[]).includes(value)) return value as DockerAgent;
  throw new Error(`Unknown --agent "${value}" (expected ${DOCKER_AGENTS.join(', ')})`);
}

function parseRuntime(value: string | undefined): ContainerRuntimeKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'docker' || value === 'apple-container') return value;
  throw new Error(`Unknown --runtime "${value}" (expected docker or apple-container)`);
}

async function defaultGetAdapter(agent: DockerAgent): Promise<ImagesCommandAdapter> {
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  await registerBuiltinAdapters();
  return getAgent(agent as AgentId);
}

/** Whether an image of `buildHash` is present, by its build tag or (before build tags) its alias. */
async function buildPresence(
  runtime: ContainerRuntime,
  build: { readonly logicalName: string; readonly buildTag: string; readonly buildHash: string },
): Promise<{ readonly present: boolean; readonly ref?: string }> {
  if ((await runtime.getImageLabel(build.buildTag, IMAGE_BUILD_HASH_LABEL)) === build.buildHash) {
    return { present: true, ref: build.buildTag };
  }
  if ((await runtime.getImageLabel(build.logicalName, IMAGE_BUILD_HASH_LABEL)) === build.buildHash) {
    return { present: true, ref: build.logicalName };
  }
  return { present: false };
}

function describeCliSelection(support: AgentCliVersionSupport | undefined, userConfig: ResolvedUserConfig): string {
  if (support === undefined) return 'CLI version not pinned by IronCurtain';
  const { version, overridden } = describeAgentCliVersionSelection(support, userConfig.agentCliVersions);
  const range =
    support.minVersion === support.maxTested ? support.minVersion : `${support.minVersion}–${support.maxTested}`;
  const source = overridden && support.overrideKey !== undefined ? `agentCliVersions.${support.overrideKey}` : 'pinned';
  return `${support.displayName} CLI ${version} (${source}; qualified: ${range})`;
}

async function probeCli(
  runtime: ContainerRuntime,
  ref: string,
  adapter: ImagesCommandAdapter,
): Promise<string | undefined> {
  if (adapter.versionProbe === undefined || adapter.versionProbe.length === 0) return undefined;
  if (runtime.probeImageVersion === undefined) return 'version probe not supported by this runtime';
  const output = await runtime.probeImageVersion(ref, adapter.versionProbe);
  if (output === undefined) return 'version probe failed';
  if (adapter.cliVersion === undefined) return `installed: ${toDisplayText(output, { maxLength: 80 })}`;
  const { level, message } = describeAgentCliVersionVerdict(
    assessAgentCliVersion(output, adapter.cliVersion),
    adapter.cliVersion,
  );
  return level === 'warn' ? `WARNING: ${message}` : `installed: ${message}`;
}

const PAD = 13;

/**
 * The Docker toolchain of this engine's nested-Docker builds, from the
 * toolchain image already present (never pulled); undefined without one.
 */
async function localToolchainSource(runtime: ContainerRuntime): Promise<DockerToolchainSource | undefined> {
  try {
    return await findLocalDockerToolchainSource(runtime);
  } catch {
    return undefined;
  }
}

/**
 * The image builds `status` and `rebuild` cover: the ordinary ones, and when
 * nested Docker is enabled, the nested-Docker builds for the toolchain image
 * on this engine (said so when it is not there yet).
 */
async function buildVariants(
  context: ImagesCommandContext,
): Promise<readonly { readonly heading?: string; readonly toolchainSource?: DockerToolchainSource }[]> {
  if (context.userConfig.dockerWorkload?.enabled !== true) return [{}];
  const toolchainSource = await localToolchainSource(context.runtime);
  if (toolchainSource === undefined) {
    context.write(
      'Nested Docker is enabled, but its Docker toolchain image is not on this engine yet; ' +
        'the next nested-Docker session pulls it and builds its own images.\n',
    );
    return [{}];
  }
  const heading = `Nested-Docker builds (Docker toolchain ${toDisplayText(toolchainSource.reference, { maxLength: 160 })}):`;
  return [{}, { heading, toolchainSource }];
}

async function runStatus(context: ImagesCommandContext, agents: readonly DockerAgent[], probe: boolean): Promise<void> {
  const { write, runtime, userConfig } = context;
  write(`Images for IronCurtain ${VERSION} (${context.runtimeKind}):\n`);
  for (const variant of await buildVariants(context)) {
    if (variant.heading !== undefined) write(`${variant.heading}\n`);
    let baseReported: string | undefined;
    for (const agent of agents) {
      const adapter = await context.getAdapter(agent);
      const description = describeAgentImageBuild(
        await adapter.getImage(),
        agentImageBuildOptions(adapter, userConfig),
        variant.toolchainSource,
      );
      if (baseReported !== description.base.buildTag) {
        baseReported = description.base.buildTag;
        const base = await buildPresence(runtime, description.base);
        write(
          `  ${'base'.padEnd(PAD)}${description.base.buildTag}  ` +
            `${base.present ? 'built' : 'not built (the next session builds it)'}\n`,
        );
      }
      const presence = await buildPresence(runtime, description);
      write(
        `  ${agent.padEnd(PAD)}${description.buildTag}  ` +
          `${presence.present ? 'built' : 'not built (the next session builds it)'}\n`,
      );
      write(`  ${''.padEnd(PAD)}${describeCliSelection(adapter.cliVersion, userConfig)}\n`);
      if (probe && presence.ref !== undefined) {
        const probed = await probeCli(runtime, presence.ref, adapter);
        if (probed !== undefined) write(`  ${''.padEnd(PAD)}${probed}\n`);
      }
    }
  }
  let superseded: readonly SupersededBuild[];
  try {
    superseded = await findSupersededBuilds(context);
  } catch (error) {
    // The report above stands on its own; the inventory is a footnote.
    write(`Could not list image builds: ${toDisplayText(errorMessage(error), { maxLength: 200 })}\n`);
    return;
  }
  if (superseded.length > 0) {
    write(
      `${superseded.length} build(s) from other IronCurtain versions or checkouts are kept; ` +
        '`ironcurtain images prune` lists them.\n',
    );
  }
}

async function runRebuild(
  context: ImagesCommandContext,
  agents: readonly DockerAgent[],
  withBase: boolean,
): Promise<void> {
  const { write, runtime, userConfig } = context;
  for (const variant of await buildVariants(context)) {
    if (variant.heading !== undefined) write(`${variant.heading}\n`);
    // Each variant has its own base: rebuild it once, with the first agent.
    let baseRebuilt = false;
    for (const agent of agents) {
      const adapter = await context.getAdapter(agent);
      const image = await adapter.getImage();
      const scope: AgentImageRebuildScope = withBase && !baseRebuilt ? 'agent-and-base' : 'agent';
      write(
        `Rebuilding ${agent}${scope === 'agent-and-base' ? ' and the base image' : ''} without the build cache...\n`,
      );
      const resolution = await rebuildAgentImage(
        image,
        runtime,
        scope,
        agentImageBuildOptions(adapter, userConfig),
        variant.toolchainSource,
      );
      baseRebuilt ||= scope === 'agent-and-base';
      write(`  ${agent.padEnd(PAD)}${resolution.imageRef}  built\n`);
      const probed = await probeCli(runtime, resolution.imageRef, adapter);
      if (probed !== undefined) write(`  ${''.padEnd(PAD)}${probed}\n`);
    }
  }
}

interface SupersededBuild {
  readonly tag: string;
  readonly created: string;
}

/**
 * Build tags in the base and agent repositories other than the builds this
 * installation uses and other than the build each repository's `:latest`
 * alias points at (the one some checkout used last). This installation's
 * builds are, per agent, this release's pinned build and the one
 * `agentCliVersions` configures, each for ordinary sessions and, when the
 * Docker toolchain image is on the engine, for nested-Docker sessions (whose
 * build hash includes that toolchain), whether or not nested Docker is
 * enabled right now.
 */
async function findSupersededBuilds(context: ImagesCommandContext): Promise<readonly SupersededBuild[]> {
  const { runtime, userConfig } = context;
  const toolchainSource = await localToolchainSource(runtime);
  const descriptions: AgentImageBuildDescription[] = [];
  for (const agent of DOCKER_AGENTS) {
    const adapter = await context.getAdapter(agent);
    const image = await adapter.getImage();
    for (const buildOptions of [undefined, agentImageBuildOptions(adapter, userConfig)]) {
      descriptions.push(describeAgentImageBuild(image, buildOptions));
      if (toolchainSource !== undefined) {
        descriptions.push(describeAgentImageBuild(image, buildOptions, toolchainSource));
      }
    }
  }
  const keep = new Set<string>();
  const repositories = new Set<string>();
  const aliases = new Set<string>();
  for (const description of descriptions) {
    for (const build of [description, description.base]) {
      keep.add(build.buildTag);
      repositories.add(imageRepository(build.logicalName));
      aliases.add(build.logicalName);
    }
  }
  const images = await runtime.listImages({ labelFilter: IMAGE_BUILD_HASH_LABEL });
  // The build each alias points at stays: another checkout may be using it.
  const aliasTargets = new Set(
    images.filter((image) => image.repoTags.some((tag) => aliases.has(tag))).map((image) => image.id),
  );
  const superseded: SupersededBuild[] = [];
  for (const image of images) {
    if (aliasTargets.has(image.id)) continue;
    for (const tag of image.repoTags) {
      if (keep.has(tag)) continue;
      if (![...repositories].some((repository) => isImageBuildTagIn(tag, repository))) continue;
      superseded.push({ tag, created: image.created });
    }
  }
  return superseded.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

async function runPrune(context: ImagesCommandContext, apply: boolean): Promise<void> {
  const { write, runtime } = context;
  const superseded = await findSupersededBuilds(context);
  if (superseded.length === 0) {
    write('No superseded image builds.\n');
    return;
  }
  write(`${apply ? 'Removing' : 'Would remove'} ${superseded.length} superseded image build(s):\n`);
  let failed = 0;
  for (const build of superseded) {
    write(`  ${build.tag}  (created ${toDisplayText(build.created, { maxLength: 40 }) || 'unknown'})\n`);
    if (apply && !(await runtime.removeImage(build.tag))) failed++;
  }
  if (!apply) write('Re-run with --force to remove them.\n');
  else if (failed > 0) write(`${failed} build(s) could not be removed (in use or already gone).\n`);
}

/** Entry point of `ironcurtain images`. */
export async function runImagesCommand(args: readonly string[], deps: ImagesCommandDeps = {}): Promise<void> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      agent: { type: 'string' },
      all: { type: 'boolean' },
      'with-base': { type: 'boolean' },
      probe: { type: 'boolean' },
      force: { type: 'boolean' },
      runtime: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals.at(0);
  if (values.help === true || command === undefined) {
    write(USAGE);
    return;
  }
  if (positionals.length > 1) throw new Error(`Unexpected argument "${positionals[1]}"\n\n${USAGE}`);
  if (!['status', 'rebuild', 'prune'].includes(command)) {
    throw new Error(`Unknown images command "${command}" (expected status, rebuild or prune)`);
  }
  const agent = parseAgent(values.agent);
  if (values.all === true && agent !== undefined) throw new Error('Choose either --agent or --all, not both');
  if (values.all === true && command !== 'rebuild') throw new Error('--all applies to rebuild only');
  if (values['with-base'] === true && command !== 'rebuild') throw new Error('--with-base applies to rebuild only');
  if (values.probe === true && command !== 'status') throw new Error('--probe applies to status only');
  if (values.force === true && command !== 'prune') throw new Error('--force applies to prune only');
  // Prune considers every agent's builds together; accepting --agent would
  // suggest a narrower removal than --force performs.
  if (agent !== undefined && command === 'prune') throw new Error('--agent applies to status and rebuild only');

  const userConfig = deps.userConfig ?? loadUserConfig({ readOnly: true });
  const runtimeKind =
    parseRuntime(values.runtime) ??
    (await (deps.resolveRuntime ?? ((config) => resolveRuntimeKind(config.containerRuntime)))(userConfig));
  const runtime = (deps.createRuntime ?? ((kind: ContainerRuntimeKind) => createContainerRuntime(kind)))(runtimeKind);
  const context: ImagesCommandContext = {
    write,
    userConfig,
    runtime,
    runtimeKind,
    getAdapter: deps.getAdapter ?? defaultGetAdapter,
  };

  switch (command) {
    case 'status':
      await runStatus(context, agent === undefined ? DOCKER_AGENTS : [agent], values.probe === true);
      return;
    case 'rebuild':
      await runRebuild(
        context,
        values.all === true ? DOCKER_AGENTS : [agent ?? userConfig.preferredDockerAgent],
        values['with-base'] === true,
      );
      return;
    case 'prune':
      await runPrune(context, values.force === true);
      return;
  }
}
