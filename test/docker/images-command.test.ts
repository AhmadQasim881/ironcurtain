import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';
import { runImagesCommand, type ImagesCommandAdapter } from '../../src/docker/images-command.js';
import { describeAgentImageBuild, resolveAgentImage } from '../../src/docker/docker-infrastructure.js';
import { CLAUDE_CODE_CLI_VERSION, CODEX_CLI_VERSION, GOOSE_CLI_VERSION } from '../../src/docker/agent-cli-version.js';
import { IMAGE_BUILD_HASH_LABEL } from '../../src/docker/image-identity.js';
import type { ContainerRuntimeKind } from '../../src/docker/container-runtime.js';
import type { DockerAgent, ResolvedUserConfig } from '../../src/config/user-config.js';
import {
  findLocalDockerToolchainSource,
  type DockerToolchainSource,
} from '../../src/docker-workload/toolchain-source.js';
import {
  getDockerToolchainSourceReference,
  loadClientToolchainManifest,
} from '../../src/docker-workload/client-toolchain.js';
import { getFrozenClientToolchainManifestPath } from '../../src/docker/docker-workload-paths.js';
import { makeImageStore } from '../helpers/image-store.js';

const ADAPTERS: Record<DockerAgent, ImagesCommandAdapter> = {
  'claude-code': {
    getImage: async () => 'ironcurtain-claude-code:latest',
    versionProbe: ['claude', '--version'],
    cliVersion: CLAUDE_CODE_CLI_VERSION,
  },
  codex: {
    getImage: async () => 'ironcurtain-codex:latest',
    versionProbe: ['codex', '--version'],
    cliVersion: CODEX_CLI_VERSION,
  },
  goose: {
    getImage: async () => 'ironcurtain-goose:latest',
    versionProbe: ['goose', '--version'],
    cliVersion: GOOSE_CLI_VERSION,
  },
};

function userConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    preferredDockerAgent: 'claude-code',
    containerRuntime: 'docker',
    agentCliVersions: {},
    ...overrides,
  } as unknown as ResolvedUserConfig;
}

/** Nested Docker enabled (only `enabled` matters to this command). */
const NESTED_DOCKER = { dockerWorkload: { enabled: true } } as unknown as Partial<ResolvedUserConfig>;

/** Seeds the Docker toolchain image a nested-Docker session pulled; returns the source it selects. */
async function seedToolchain(store: ReturnType<typeof makeImageStore>): Promise<DockerToolchainSource> {
  const { manifest } = loadClientToolchainManifest(getFrozenClientToolchainManifestPath(), 'amd64');
  store.seed(
    getDockerToolchainSourceReference(manifest),
    {},
    { architecture: 'amd64', repoDigests: [`docker@sha256:${'d'.repeat(64)}`] },
  );
  const source = await findLocalDockerToolchainSource(store.runtime);
  if (source === undefined) throw new Error('the seeded toolchain image was not recognized');
  return source;
}

async function run(
  args: readonly string[],
  store: ReturnType<typeof makeImageStore>,
  config: ResolvedUserConfig = userConfig(),
): Promise<{ output: string; runtimes: ContainerRuntimeKind[] }> {
  const chunks: string[] = [];
  const runtimes: ContainerRuntimeKind[] = [];
  await runImagesCommand(args, {
    write: (text) => chunks.push(text),
    userConfig: config,
    createRuntime: (kind) => {
      runtimes.push(kind);
      return store.runtime;
    },
    resolveRuntime: async () => 'docker',
    getAdapter: async (agent) => ADAPTERS[agent],
  });
  return { output: chunks.join(''), runtimes };
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ironcurtain images', () => {
  it('prints usage without a command', async () => {
    const { output } = await run([], makeImageStore());
    expect(output).toContain('Usage: ironcurtain images <status|rebuild|prune>');
  });

  it('rejects unknown commands and flags that do not apply', async () => {
    const store = makeImageStore();
    await expect(run(['inspect'], store)).rejects.toThrow(/Unknown images command "inspect"/u);
    await expect(run(['status', '--agent', 'cursor'], store)).rejects.toThrow(/Unknown --agent "cursor"/u);
    await expect(run(['status', '--force'], store)).rejects.toThrow(/--force applies to prune only/u);
    await expect(run(['prune', '--probe'], store)).rejects.toThrow(/--probe applies to status only/u);
    await expect(run(['status', '--all'], store)).rejects.toThrow(/--all applies to rebuild only/u);
    await expect(run(['rebuild', '--all', '--agent', 'codex'], store)).rejects.toThrow(/either --agent or --all/u);
    await expect(run(['status', '--runtime', 'podman'], store)).rejects.toThrow(/Unknown --runtime "podman"/u);
    // Prune covers every agent: a narrower-looking request is refused, not widened.
    await expect(run(['prune', '--agent', 'codex', '--force'], store)).rejects.toThrow(
      /--agent applies to status and rebuild only/u,
    );
  });

  describe('status', () => {
    it('reports each expected build, whether it is built, and the CLI it installs', async () => {
      const store = makeImageStore();
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      const claude = describeAgentImageBuild('ironcurtain-claude-code:latest');
      const codex = describeAgentImageBuild('ironcurtain-codex:latest', {
        cliBuildArgs: { CODEX_VERSION: 'latest' },
      });

      const { output, runtimes } = await run(['status'], store, userConfig({ agentCliVersions: { codex: 'latest' } }));

      expect(runtimes).toEqual(['docker']);
      expect(output).toContain(`base         ${claude.base.buildTag}  built`);
      expect(output).toContain(`claude-code  ${claude.buildTag}  built`);
      expect(output).toContain(`Claude Code CLI ${CLAUDE_CODE_CLI_VERSION.pinned} (pinned; qualified:`);
      expect(output).toContain(`codex        ${codex.buildTag}  not built (the next session builds it)`);
      expect(output).toContain('Codex CLI latest (agentCliVersions.codex; qualified:');
      expect(output).toContain(`Goose CLI ${GOOSE_CLI_VERSION.pinned} (pinned;`);
      // The shared base is reported once.
      expect(output.match(/^ {2}base /gmu)).toHaveLength(1);
    });

    it('probes built images on request and flags a CLI outside the qualified range', async () => {
      const store = makeImageStore({ probe: () => '9.9.9 (Claude Code)' });
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);

      const { output } = await run(['status', '--agent', 'claude-code', '--probe'], store);

      expect(output).toContain('WARNING: Claude Code CLI 9.9.9 is newer than the versions qualified');
      expect(output).not.toContain('codex ');
    });

    it('still reports the builds when the image inventory cannot be listed', async () => {
      const store = makeImageStore();
      store.runtime.listImages = async () => Promise.reject(new Error('Cannot connect to the Docker daemon'));

      const { output } = await run(['status', '--agent', 'claude-code'], store);

      expect(output).toContain('claude-code  ');
      expect(output).toContain('Could not list image builds: Cannot connect to the Docker daemon');
    });

    it('reports the nested-Docker builds too when nested Docker is enabled', async () => {
      const store = makeImageStore();
      const toolchain = await seedToolchain(store);
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime, toolchain);
      const nested = describeAgentImageBuild('ironcurtain-claude-code:latest', undefined, toolchain);
      const ordinary = describeAgentImageBuild('ironcurtain-claude-code:latest');

      const { output } = await run(['status', '--agent', 'claude-code'], store, userConfig(NESTED_DOCKER));

      expect(nested.buildTag).not.toBe(ordinary.buildTag);
      expect(output).toContain(`claude-code  ${ordinary.buildTag}  not built`);
      expect(output).toContain(`Nested-Docker builds (Docker toolchain ${toolchain.reference}):`);
      expect(output).toContain(`base         ${nested.base.buildTag}  built`);
      expect(output).toContain(`claude-code  ${nested.buildTag}  built`);
    });

    it('says when nested Docker is enabled but its toolchain image is not on the engine', async () => {
      const { output } = await run(['status', '--agent', 'goose'], makeImageStore(), userConfig(NESTED_DOCKER));
      expect(output).toContain('Nested Docker is enabled, but its Docker toolchain image is not on this engine yet');
      expect(output).not.toContain('Nested-Docker builds');
    });

    it('uses an explicit --runtime over the configured one', async () => {
      const store = makeImageStore();
      const { runtimes } = await run(['status', '--agent', 'goose', '--runtime', 'apple-container'], store);
      expect(runtimes).toEqual(['apple-container']);
    });
  });

  describe('rebuild', () => {
    it('rebuilds the preferred agent without the layer cache and reports its CLI', async () => {
      const store = makeImageStore({ probe: () => `codex-cli ${CODEX_CLI_VERSION.pinned}` });
      await resolveAgentImage('ironcurtain-codex:latest', store.runtime);
      store.builds.length = 0;

      const { output } = await run(['rebuild'], store, userConfig({ preferredDockerAgent: 'codex' }));

      const codex = describeAgentImageBuild('ironcurtain-codex:latest');
      expect(store.builds.map((build) => [build.tag, build.options])).toEqual([[codex.buildTag, { noCache: true }]]);
      expect(output).toContain(`codex        ${codex.buildTag}  built`);
      expect(output).toContain(`installed: Codex CLI ${CODEX_CLI_VERSION.pinned}`);
    });

    it('rebuilds the shared base once with --all --with-base, and builds the override', async () => {
      const store = makeImageStore();
      const config = userConfig({ agentCliVersions: { 'claude-code': 'latest' } });

      await run(['rebuild', '--all', '--with-base'], store, config);

      const base = describeAgentImageBuild('ironcurtain-claude-code:latest').base.buildTag;
      expect(store.builds.filter((build) => build.tag === base)).toHaveLength(1);
      expect(store.builds.every((build) => build.options?.noCache === true)).toBe(true);
      const claude = store.builds.find((build) => build.tag.startsWith('ironcurtain-claude-code:'));
      expect(claude?.buildArgs).toMatchObject({ CLAUDE_CODE_VERSION: 'latest' });
      expect(store.builds.map((build) => build.tag.split(':')[0]).sort()).toEqual([
        'ironcurtain-base',
        'ironcurtain-claude-code',
        'ironcurtain-codex',
        'ironcurtain-goose',
      ]);
    });

    it('also rebuilds the nested-Docker build when nested Docker is enabled', async () => {
      const store = makeImageStore();
      const toolchain = await seedToolchain(store);
      const nested = describeAgentImageBuild('ironcurtain-claude-code:latest', undefined, toolchain);
      const ordinary = describeAgentImageBuild('ironcurtain-claude-code:latest');

      const { output } = await run(['rebuild', '--agent', 'claude-code'], store, userConfig(NESTED_DOCKER));

      const agentBuilds = store.builds.filter((build) => build.tag.startsWith('ironcurtain-claude-code:'));
      expect(agentBuilds.map((build) => [build.tag, build.options])).toEqual([
        [ordinary.buildTag, { noCache: true }],
        [nested.buildTag, { noCache: true }],
      ]);
      // The nested agent is built FROM the nested base, which embeds the toolchain.
      expect(agentBuilds[1].buildArgs).toMatchObject({ IRONCURTAIN_BASE_IMAGE: nested.base.buildTag });
      expect(store.builds.find((build) => build.tag === nested.base.buildTag)?.buildArgs).toEqual({
        IRONCURTAIN_DOCKER_SOURCE: toolchain.reference,
      });
      expect(output).toContain(`claude-code  ${nested.buildTag}  built`);
    });

    it('rebuilds only the ordinary builds when nested Docker is off', async () => {
      const store = makeImageStore();
      await seedToolchain(store);

      await run(['rebuild', '--agent', 'claude-code'], store);

      const ordinary = describeAgentImageBuild('ironcurtain-claude-code:latest');
      expect(
        store.builds.filter((build) => build.tag.startsWith('ironcurtain-claude-code:')).map((b) => b.tag),
      ).toEqual([ordinary.buildTag]);
    });
  });

  describe('prune', () => {
    function seedSuperseded(store: ReturnType<typeof makeImageStore>): string {
      // A build another IronCurtain version left behind.
      const old = 'ironcurtain-claude-code:build-00000000000000aa';
      store.seed(old, { [IMAGE_BUILD_HASH_LABEL]: `${'0'.repeat(62)}aa` });
      return old;
    }

    it('lists superseded builds and keeps current ones and what :latest points at', async () => {
      const store = makeImageStore();
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      const old = seedSuperseded(store);
      // The build another checkout used last (its :latest) stays.
      const otherLatest = 'ironcurtain-codex:build-00000000000000bb';
      store.seed(otherLatest, { [IMAGE_BUILD_HASH_LABEL]: `${'0'.repeat(62)}bb` });
      await store.runtime.tagImage?.(otherLatest, 'ironcurtain-codex:latest');
      // Not ours: never listed.
      store.seed('someone-else:build-00000000000000cc', { [IMAGE_BUILD_HASH_LABEL]: 'x' });

      const { output } = await run(['prune'], store);

      expect(output).toContain('Would remove 1 superseded image build(s):');
      expect(output).toContain(old);
      expect(output).not.toContain(otherLatest);
      expect(output).not.toContain('someone-else');
      expect(output).toContain('Re-run with --force');
      expect(store.idOf(old)).toBeDefined();
    });

    it('removes them with --force', async () => {
      const store = makeImageStore();
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      const old = seedSuperseded(store);
      const current = describeAgentImageBuild('ironcurtain-claude-code:latest').buildTag;

      const { output } = await run(['prune', '--force'], store);

      expect(output).toContain('Removing 1 superseded image build(s):');
      expect(store.idOf(old)).toBeUndefined();
      expect(store.idOf(current)).toBeDefined();
    });

    it('says so when nothing is superseded', async () => {
      const store = makeImageStore();
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      const { output } = await run(['prune'], store);
      expect(output).toBe('No superseded image builds.\n');
    });

    it("never removes this installation's nested-Docker builds, even after :latest moved on", async () => {
      const store = makeImageStore();
      const toolchain = await seedToolchain(store);
      // A nested-Docker session built its own base and agent ...
      const nestedRun = await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime, toolchain);
      const nested = describeAgentImageBuild('ironcurtain-claude-code:latest', undefined, toolchain);
      // ... then an ordinary session pointed both aliases at the ordinary builds.
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      const old = seedSuperseded(store);

      // Whether or not nested Docker is enabled right now.
      for (const config of [userConfig(), userConfig(NESTED_DOCKER)]) {
        const { output } = await run(['prune'], store, config);
        expect(output).toContain('Would remove 1 superseded image build(s):');
        expect(output).not.toContain(nested.buildTag);
        expect(output).not.toContain(nested.base.buildTag);
      }
      await run(['prune', '--force'], store);

      expect(store.idOf(old)).toBeUndefined();
      expect(nestedRun.imageRef).toBe(nested.buildTag);
      expect(store.idOf(nested.buildTag)).toBeDefined();
      expect(store.idOf(nested.base.buildTag)).toBeDefined();
    });

    it("keeps this release's pinned build while an agentCliVersions override is configured", async () => {
      const store = makeImageStore();
      const pinned = await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime);
      // The override's build is used last: :latest points at it now.
      await resolveAgentImage('ironcurtain-claude-code:latest', store.runtime, undefined, {
        cliBuildArgs: { CLAUDE_CODE_VERSION: 'latest' },
      });

      const { output } = await run(
        ['prune', '--force'],
        store,
        userConfig({ agentCliVersions: { 'claude-code': 'latest' } }),
      );

      expect(output).toBe('No superseded image builds.\n');
      expect(store.idOf(pinned.imageRef)).toBeDefined();
    });
  });
});
