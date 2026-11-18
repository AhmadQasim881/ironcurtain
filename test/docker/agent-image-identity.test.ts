/**
 * Agent image build identity: pins and overrides are part of the build hash,
 * images are built and used under build-hash tags, and `:latest` is only a
 * moving alias (WP-100).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logger from '../../src/logger.js';
import {
  assertPreparedImageResolution,
  computeAgentImageBuildHash,
  computeDockerBuildHash,
  describeAgentImageBuild,
  rebuildAgentImage,
  resolveAgentImage,
  type AgentImageResolution,
} from '../../src/docker/docker-infrastructure.js';
import { CLAUDE_CODE_CLI_VERSION, resolveAgentCliBuildArgs } from '../../src/docker/agent-cli-version.js';
import {
  IMAGE_BUILD_HASH_LABEL,
  imageBuildTag,
  imageRepository,
  isImageBuildTagIn,
  isImageBuildTagOf,
  isImmutableImageId,
  shortBuildHash,
} from '../../src/docker/image-identity.js';
import { makeImageStore } from '../helpers/image-store.js';

const CLAUDE_IMAGE = 'ironcurtain-claude-code:latest';

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent image build hash', () => {
  let dockerDir: string;

  beforeEach(() => {
    dockerDir = mkdtempSync(join(tmpdir(), 'ironcurtain-agent-hash-'));
    writeFileSync(join(dockerDir, 'Dockerfile.base'), 'FROM pinned\n');
    writeFileSync(join(dockerDir, 'entrypoint.sh'), '#!/bin/sh\n');
  });

  afterEach(() => {
    rmSync(dockerDir, { recursive: true, force: true });
  });

  function agentHash(cliVersion: string, buildArgs?: Readonly<Record<string, string>>): string {
    writeFileSync(
      join(dockerDir, 'Dockerfile.agent'),
      `ARG IRONCURTAIN_BASE_IMAGE=ironcurtain-base:latest\nFROM \${IRONCURTAIN_BASE_IMAGE}\n` +
        `ARG CLAUDE_CODE_VERSION=${cliVersion}\nRUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}"\n`,
    );
    const base = computeDockerBuildHash(dockerDir, ['Dockerfile.base']);
    return computeDockerBuildHash(dockerDir, ['Dockerfile.agent'], base, buildArgs);
  }

  it('changes when a pinned CLI version ARG is bumped', () => {
    const pinned = agentHash('2.1.292');
    expect(agentHash('2.1.293')).not.toBe(pinned);
    expect(agentHash('2.1.292')).toBe(pinned);
  });

  it('changes with a CLI version override and keeps the default hash without one', () => {
    const pinned = agentHash('2.1.292');
    expect(agentHash('2.1.292', {})).toBe(pinned);
    const latest = agentHash('2.1.292', { CLAUDE_CODE_VERSION: 'latest' });
    expect(latest).not.toBe(pinned);
    expect(agentHash('2.1.292', { CLAUDE_CODE_VERSION: '2.1.300' })).not.toBe(latest);
    // Independent of key order.
    expect(agentHash('2.1.292', { B: '2', A: '1' })).toBe(agentHash('2.1.292', { A: '1', B: '2' }));
  });

  it('folds the configured override into the checked-in agent image hash', () => {
    const pinned = computeAgentImageBuildHash(CLAUDE_IMAGE);
    const latest = computeAgentImageBuildHash(CLAUDE_IMAGE, {
      cliBuildArgs: resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, { 'claude-code': 'latest' }),
    });
    const samePin = computeAgentImageBuildHash(CLAUDE_IMAGE, {
      cliBuildArgs: resolveAgentCliBuildArgs(CLAUDE_CODE_CLI_VERSION, {
        'claude-code': CLAUDE_CODE_CLI_VERSION.pinned,
      }),
    });
    expect(latest).not.toBe(pinned);
    expect(samePin).toBe(pinned);
  });
});

describe('image build tags', () => {
  it('derives a stable tag from the repository and the build hash', () => {
    const hash = '0123456789abcdef'.repeat(4);
    expect(imageBuildTag(CLAUDE_IMAGE, hash)).toBe('ironcurtain-claude-code:build-0123456789abcdef');
    expect(imageBuildTag('ironcurtain-base:latest', hash)).toBe('ironcurtain-base:build-0123456789abcdef');
    expect(imageBuildTag('localhost:5000/ironcurtain-base', hash)).toBe(
      'localhost:5000/ironcurtain-base:build-0123456789abcdef',
    );
    expect(isImageBuildTagOf('ironcurtain-claude-code:build-0123456789abcdef', CLAUDE_IMAGE, hash)).toBe(true);
    expect(isImageBuildTagOf('ironcurtain-claude-code:build-0123456789abcdef', CLAUDE_IMAGE, 'f'.repeat(64))).toBe(
      false,
    );
    expect(isImageBuildTagOf('ironcurtain-claude-code:latest', CLAUDE_IMAGE, hash)).toBe(false);
    expect(isImageBuildTagIn('ironcurtain-claude-code:build-0123456789abcdef', 'ironcurtain-claude-code')).toBe(true);
    expect(isImageBuildTagIn('ironcurtain-claude-code:latest', 'ironcurtain-claude-code')).toBe(false);
    expect(imageRepository('localhost:5000/name')).toBe('localhost:5000/name');
    expect(shortBuildHash(hash)).toBe('0123456789abcdef');
    expect(shortBuildHash('\u001b[2Jnot-a-hash')).toBe('unknown');
    expect(() => imageBuildTag(CLAUDE_IMAGE, 'not-a-hash')).toThrow(/invalid image build hash/u);
  });

  it('tells an immutable image ID from a tag or digest reference', () => {
    const hex = '0a'.repeat(32);
    expect(isImmutableImageId(`sha256:${hex}`)).toBe(true);
    expect(isImmutableImageId(hex)).toBe(true);
    expect(isImmutableImageId('ironcurtain-snapshot:wf-1-primary-x')).toBe(false);
    expect(isImmutableImageId(`ironcurtain-claude-code@sha256:${hex}`)).toBe(false);
    expect(isImmutableImageId(`sha256:${hex.toUpperCase()}`)).toBe(false);
    expect(isImmutableImageId(`sha256:${hex.slice(2)}`)).toBe(false);
  });
});

describe('resolveAgentImage with build tags', () => {
  it('builds the base and agent under their build tags, the agent FROM the exact base build', async () => {
    const store = makeImageStore();
    const expected = describeAgentImageBuild(CLAUDE_IMAGE);

    const resolution = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds.map((build) => build.tag)).toEqual([expected.base.buildTag, expected.buildTag]);
    expect(store.builds[0].dockerfile).toMatch(/^Dockerfile\.base/u);
    expect(store.builds[0].labels).toEqual({ [IMAGE_BUILD_HASH_LABEL]: expected.base.buildHash });
    expect(store.builds[1]).toMatchObject({
      dockerfile: 'Dockerfile.claude-code',
      labels: { [IMAGE_BUILD_HASH_LABEL]: expected.buildHash },
      buildArgs: { IRONCURTAIN_BASE_IMAGE: expected.base.buildTag },
      options: undefined,
    });
    // Sessions create from the exact build; the aliases follow it.
    expect(resolution).toMatchObject({
      logicalName: CLAUDE_IMAGE,
      imageRef: expected.buildTag,
      buildHash: expected.buildHash,
    });
    expect(store.idOf(CLAUDE_IMAGE)).toBe(store.idOf(expected.buildTag));
    expect(store.idOf('ironcurtain-base:latest')).toBe(store.idOf(expected.base.buildTag));
  });

  it('reuses a present build without building again', async () => {
    const store = makeImageStore();
    await resolveAgentImage(CLAUDE_IMAGE, store.runtime);
    store.builds.length = 0;

    const again = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds).toEqual([]);
    expect(again.imageRef).toBe(describeAgentImageBuild(CLAUDE_IMAGE).buildTag);
  });

  it('switching between two builds re-points the alias instead of rebuilding either', async () => {
    // Two identities side by side, as an installed release and a development
    // checkout (here: the pin and a CLI override) produce.
    const store = makeImageStore();
    const override = { cliBuildArgs: { CLAUDE_CODE_VERSION: 'latest' } };
    const pinned = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);
    const latest = await resolveAgentImage(CLAUDE_IMAGE, store.runtime, undefined, override);
    // The override reuses the base and builds only its own agent image.
    expect(store.builds.map((build) => build.tag)).toEqual([
      describeAgentImageBuild(CLAUDE_IMAGE).base.buildTag,
      pinned.imageRef,
      latest.imageRef,
    ]);
    expect(store.builds[2].buildArgs).toMatchObject({ CLAUDE_CODE_VERSION: 'latest' });
    expect(latest.imageRef).not.toBe(pinned.imageRef);
    expect(store.idOf(CLAUDE_IMAGE)).toBe(store.idOf(latest.imageRef));
    store.builds.length = 0;

    const back = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds).toEqual([]);
    expect(back.imageRef).toBe(pinned.imageRef);
    expect(store.idOf(CLAUDE_IMAGE)).toBe(store.idOf(pinned.imageRef));
    // The other identity's build is still there for its next session.
    expect(store.idOf(latest.imageRef)).toBeDefined();
  });

  it('adopts a current image an older IronCurtain built under the alias only', async () => {
    const store = makeImageStore();
    const expected = describeAgentImageBuild(CLAUDE_IMAGE);
    const legacyId = store.seed(CLAUDE_IMAGE, { [IMAGE_BUILD_HASH_LABEL]: expected.buildHash });

    const resolution = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds).toEqual([]);
    expect(resolution.imageRef).toBe(expected.buildTag);
    expect(store.idOf(expected.buildTag)).toBe(legacyId);
  });

  it('never adopts or uses an alias that names another build', async () => {
    const store = makeImageStore();
    const expected = describeAgentImageBuild(CLAUDE_IMAGE);
    const otherId = store.seed(CLAUDE_IMAGE, { [IMAGE_BUILD_HASH_LABEL]: 'f'.repeat(64) });

    const resolution = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds.map((build) => build.tag)).toContain(expected.buildTag);
    expect(resolution.imageRef).toBe(expected.buildTag);
    expect(store.idOf(expected.buildTag)).not.toBe(otherId);
    expect(store.tagCalls).not.toContainEqual([CLAUDE_IMAGE, expected.buildTag]);
  });

  it('keeps the logical tag as the only reference on a runtime that cannot tag', async () => {
    const store = makeImageStore({ tagging: false });

    const resolution = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);

    expect(store.builds.map((build) => build.tag)).toEqual(['ironcurtain-base:latest', CLAUDE_IMAGE]);
    expect(store.builds[1].buildArgs).toEqual({ IRONCURTAIN_BASE_IMAGE: 'ironcurtain-base:latest' });
    expect(resolution.imageRef).toBe(CLAUDE_IMAGE);
  });
});

describe('rebuildAgentImage', () => {
  it('rebuilds only the agent without the layer cache, under the same build tag', async () => {
    const store = makeImageStore();
    const first = await resolveAgentImage(CLAUDE_IMAGE, store.runtime);
    const before = store.idOf(first.imageRef);
    store.builds.length = 0;

    const rebuilt = await rebuildAgentImage(CLAUDE_IMAGE, store.runtime, 'agent');

    expect(store.builds).toHaveLength(1);
    expect(store.builds[0]).toMatchObject({ tag: first.imageRef, options: { noCache: true } });
    expect(rebuilt.imageRef).toBe(first.imageRef);
    expect(rebuilt.buildHash).toBe(first.buildHash);
    expect(store.idOf(first.imageRef)).not.toBe(before);
    expect(store.idOf(CLAUDE_IMAGE)).toBe(store.idOf(first.imageRef));
  });

  it('rebuilds the base too, without the cache, when asked', async () => {
    const store = makeImageStore();
    await resolveAgentImage(CLAUDE_IMAGE, store.runtime);
    store.builds.length = 0;
    const expected = describeAgentImageBuild(CLAUDE_IMAGE);

    await rebuildAgentImage(CLAUDE_IMAGE, store.runtime, 'agent-and-base');

    expect(store.builds.map((build) => [build.tag, build.options])).toEqual([
      [expected.base.buildTag, { noCache: true }],
      [expected.buildTag, { noCache: true }],
    ]);
  });
});

describe('assertPreparedImageResolution', () => {
  const buildHash = 'c'.repeat(64);
  const resolution = (imageRef: string): AgentImageResolution => ({
    mode: 'build-if-stale',
    logicalName: CLAUDE_IMAGE,
    imageRef,
    buildHash,
  });

  it('accepts the exact build tag or the logical name for an ordinary session', () => {
    expect(() => assertPreparedImageResolution(resolution(CLAUDE_IMAGE), CLAUDE_IMAGE, undefined)).not.toThrow();
    expect(() =>
      assertPreparedImageResolution(resolution(imageBuildTag(CLAUDE_IMAGE, buildHash)), CLAUDE_IMAGE, undefined),
    ).not.toThrow();
  });

  it('rejects a build tag of another build, another image, or another agent', () => {
    for (const imageRef of [
      imageBuildTag(CLAUDE_IMAGE, 'd'.repeat(64)),
      'ironcurtain-codex:latest',
      imageBuildTag('ironcurtain-codex:latest', buildHash),
    ]) {
      expect(() => assertPreparedImageResolution(resolution(imageRef), CLAUDE_IMAGE, undefined), imageRef).toThrow(
        /does not match selected agent/u,
      );
    }
    expect(() =>
      assertPreparedImageResolution(resolution(CLAUDE_IMAGE), 'ironcurtain-codex:latest', undefined),
    ).toThrow(/does not match selected agent/u);
  });

  it('keeps nested-Docker resolutions on the logical name', () => {
    expect(() =>
      assertPreparedImageResolution(resolution(imageBuildTag(CLAUDE_IMAGE, buildHash)), CLAUDE_IMAGE, 'docker'),
    ).toThrow(/does not match selected agent/u);
  });
});
