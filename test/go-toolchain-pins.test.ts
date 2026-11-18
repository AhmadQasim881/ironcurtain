/**
 * Go toolchain pins (BLD-13): scripts/check-go-toolchain.ts over this
 * repository and over small fixture trees, and the fixed-target relay's image
 * build hash, which must change with a Go bump so that relay images already
 * built on users' machines are rebuilt with the new toolchain.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  checkGoToolchain,
  failingProblems,
  parseDockerfileGoImages,
  parseGoReleases,
  PLACEHOLDER_DIGEST,
  type GoRelease,
  type ToolchainReport,
} from '../scripts/check-go-toolchain.js';
import { computeDockerBuildHash, ensureDockerDesktopRelayImage } from '../src/docker/docker-infrastructure.js';
import type { ContainerRuntime } from '../src/docker/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_DIR = join(ROOT, 'docker/nested-relay');
const RELAY_BUILD_INPUTS = ['Dockerfile', 'main.go', 'go.mod'];
const DIGEST = `sha256:${'a'.repeat(64)}`;

function minor(version: string | undefined): number {
  const match = /^1\.(\d+)/u.exec(version ?? '');
  if (match === null) throw new Error(`not a Go 1.x release: ${String(version)}`);
  return Number(match[1]);
}

describe('Go toolchain pins in this repository', () => {
  const report = checkGoToolchain({ root: ROOT });

  it('finds every pin of the relay, the runc shim and the build-trust runtime', () => {
    expect(report.pins.map((pin) => `${pin.kind} ${pin.file}`)).toEqual(
      expect.arrayContaining([
        'image docker/nested-relay/Dockerfile',
        'image docker/nested-daemon/Dockerfile',
        'go.mod docker/nested-relay/go.mod',
        'go.mod docker/build-trust-runtime/go.mod',
        'setup-go .github/workflows/ci.yml',
        'setup-go .github/workflows/release.yml',
        'build-trust-manifest docker/build-trust-runtime/manifest.json',
      ]),
    );
  });

  it('has no floating, placeholder-digest or inconsistent pin', () => {
    expect(failingProblems(report, false)).toEqual([]);
  });

  it('reports only golang images still waiting for their digest as unverified', () => {
    for (const problem of report.problems.filter((candidate) => candidate.severity === 'unverified')) {
      expect(problem.message).toMatch(/^FROM golang:\d+\.\d+\.\d+-[a-z]+: pin the image by digest/u);
    }
  });

  it('keeps every golang stage buildable: no placeholder digest that no registry serves', () => {
    const images = report.pins.filter((pin) => pin.kind === 'image');
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images) {
      expect(image.digest, image.where).not.toBe(PLACEHOLDER_DIGEST);
      expect(image.digest === undefined || /^sha256:[0-9a-f]{64}$/u.test(image.digest), image.where).toBe(true);
    }
  });

  it('builds the relay and the runc shim with a supported Go release, not end-of-life Go 1.24', () => {
    const images = report.pins.filter((pin) => pin.kind === 'image');
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images) expect(minor(image.version)).toBeGreaterThanOrEqual(26);
    const relayModule = report.pins.find((pin) => pin.kind === 'go.mod' && pin.file === 'docker/nested-relay/go.mod');
    const relayImage = images.find((pin) => pin.file === 'docker/nested-relay/Dockerfile');
    expect(relayModule?.version).toBe(relayImage?.version);
  });
});

describe('fixed-target relay image build hash', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  /** A copy of the relay's build context with `edit` applied to one file. */
  function editedContext(file: string, edit: (text: string) => string): string {
    scratch ??= mkdtempSync(join(tmpdir(), 'ic-relay-hash-'));
    const context = mkdtempSync(join(scratch, 'context-'));
    cpSync(RELAY_DIR, context, { recursive: true });
    const before = readFileSync(join(context, file), 'utf-8');
    const after = edit(before);
    expect(after).not.toBe(before);
    writeFileSync(join(context, file), after);
    return context;
  }

  it('is stamped from Dockerfile, main.go and go.mod, so the Go bump rebuilds cached relay images', async () => {
    let stamped: string | undefined;
    const runtime = {
      getImageLabel: vi.fn(async () => undefined),
      buildImage: vi.fn(
        async (_tag: string, _dockerfile: string, _context: string, labels?: Record<string, string>) => {
          stamped = labels?.['ironcurtain.build-hash'];
        },
      ),
      inspectImage: vi.fn(async () => ({
        id: `sha256:${'c'.repeat(64)}`,
        repoTags: [],
        created: '',
        labels: {
          'ironcurtain.build-hash': stamped ?? '',
          'com.ironcurtain.docker-workload.component': 'fixed-relay',
        },
      })),
    } as unknown as ContainerRuntime;

    await ensureDockerDesktopRelayImage(runtime);
    expect(stamped).toBe(computeDockerBuildHash(RELAY_DIR, RELAY_BUILD_INPUTS));

    // The context as it was before this bump: golang:1.24-bookworm and go 1.24.
    const dockerfileBefore = editedContext('Dockerfile', (text) =>
      text.replace(/^FROM golang:\S+ AS build$/mu, 'FROM golang:1.24-bookworm AS build'),
    );
    writeFileSync(
      join(dockerfileBefore, 'go.mod'),
      readFileSync(join(dockerfileBefore, 'go.mod'), 'utf-8').replace(/^go .*$/mu, 'go 1.24'),
    );
    expect(computeDockerBuildHash(dockerfileBefore, RELAY_BUILD_INPUTS)).not.toBe(stamped);
  });

  it.each([
    ['Dockerfile', (text: string) => text.replace(/^FROM golang:\d+\.\d+\.\d+/mu, 'FROM golang:1.26.99')],
    ['go.mod', (text: string) => text.replace(/^go .*$/mu, 'go 1.26.99')],
  ])('changes when only %s names another Go release', (file, edit) => {
    const context = editedContext(file, edit);
    expect(computeDockerBuildHash(context, RELAY_BUILD_INPUTS)).not.toBe(
      computeDockerBuildHash(RELAY_DIR, RELAY_BUILD_INPUTS),
    );
  });
});

describe('check-go-toolchain rules', () => {
  /** Every fixture tree a test made; some tests check more than one. */
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const BUILD_TRUST_JOB = {
    'runs-on': 'ubuntu-latest',
    steps: [
      { uses: 'actions/setup-go@v7', with: { 'go-version': '1.26.1' } },
      { run: 'npm run check:build-trust-runtime' },
    ],
  };
  const RELAY_JOB = {
    'runs-on': 'ubuntu-latest',
    steps: [
      { uses: 'actions/setup-go@v7', with: { 'go-version-file': 'docker/relay/go.mod' } },
      { run: 'go test ./...' },
    ],
  };

  function consistentTree(): Record<string, string> {
    return {
      'docker/relay/Dockerfile': `# syntax=docker/dockerfile:1.7\nFROM golang:1.26.10-bookworm@${DIGEST} AS build\nFROM scratch\n`,
      'docker/relay/go.mod': 'module example.com/relay\n\ngo 1.26.10\n',
      'docker/shim/Dockerfile': `ARG SOURCE=docker:29\nFROM golang:1.26.10@${DIGEST} AS build\nFROM \${SOURCE} AS stock\n`,
      'docker/build-trust-runtime/go.mod': 'module example.com/trust\n\ngo 1.26\n',
      'docker/build-trust-runtime/manifest.json': JSON.stringify({
        schemaVersion: 2,
        goVersion: 'go version go1.26.1 linux/amd64',
        targets: [],
      }),
      '.github/workflows/ci.yml': YAML.stringify({ jobs: { trust: BUILD_TRUST_JOB, relay: RELAY_JOB } }),
    };
  }

  function check(files: Record<string, string>, releases?: readonly GoRelease[]): ToolchainReport {
    const root = mkdtempSync(join(tmpdir(), 'ic-go-toolchain-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return checkGoToolchain({ root, ...(releases === undefined ? {} : { releases }) });
  }

  function messages(report: ToolchainReport, strict = false): string[] {
    return failingProblems(report, strict).map((problem) => problem.message);
  }

  const SUPPORTED: GoRelease[] = [
    { version: 'go1.27.3', stable: true },
    { version: 'go1.26.10', stable: true },
    { version: 'go1.28rc1', stable: false },
  ];

  it('accepts exact, digest-pinned, consistent pins', () => {
    const report = check(consistentTree());
    expect(report.problems).toEqual([]);
    expect(report.pins.filter((pin) => pin.kind === 'image').map((pin) => pin.version)).toEqual(['1.26.10', '1.26.10']);
    expect(report.pins.find((pin) => pin.kind === 'setup-go' && pin.job === 'relay')?.version).toBe('1.26.10');
  });

  it('rejects a floating golang tag, and in strict mode its missing digest', () => {
    const files = consistentTree();
    files['docker/relay/Dockerfile'] = 'FROM golang:1.24-bookworm AS build\n';
    const report = check(files);
    expect(messages(report)).toEqual([expect.stringContaining('name an exact Go release')]);
    expect(messages(report, true)).toEqual([
      expect.stringContaining('name an exact Go release'),
      expect.stringContaining('pin the image by digest'),
    ]);
  });

  it('rejects a malformed digest', () => {
    const files = consistentTree();
    files['docker/shim/Dockerfile'] = 'FROM docker.io/library/golang:1.26.10@sha256:abc AS build\n';
    expect(messages(check(files))).toEqual([expect.stringContaining('malformed digest')]);
  });

  it('follows an ARG default into FROM', () => {
    const files = consistentTree();
    files['docker/relay/Dockerfile'] = 'ARG GO_IMAGE=golang:latest\nFROM ${GO_IMAGE} AS build\n';
    expect(messages(check(files), true)).toEqual([
      expect.stringContaining('FROM golang:latest: name an exact Go release'),
      expect.stringContaining('FROM golang:latest: pin the image by digest'),
    ]);
    expect(parseDockerfileGoImages('Dockerfile', 'ARG X=docker:29\nFROM ${X} AS stock\nFROM node:24\n')).toEqual([]);
  });

  it('reports an exact tag waiting for its digest as unverified, failing only in strict mode', () => {
    const files = consistentTree();
    files['docker/relay/Dockerfile'] = 'FROM golang:1.26.10-bookworm AS build\n';
    const report = check(files);
    expect(report.problems.map((problem) => problem.severity)).toEqual(['unverified']);
    expect(messages(report)).toEqual([]);
    expect(messages(report, true)).toEqual([
      expect.stringMatching(/^FROM golang:1\.26\.10-bookworm: pin the image by digest \(@sha256:<64 hex>/u),
    ]);
  });

  it('rejects a placeholder digest in every mode: the image could not be built', () => {
    const files = consistentTree();
    files['docker/relay/Dockerfile'] = `FROM golang:1.26.10-bookworm@${PLACEHOLDER_DIGEST} AS build\n`;
    const report = check(files);
    expect(report.problems.map((problem) => problem.severity)).toEqual(['error']);
    expect(messages(report)).toEqual([expect.stringContaining('placeholder that no registry serves')]);
  });

  it('requires a module built by a Dockerfile to declare the release the image ships', () => {
    const files = consistentTree();
    files['docker/relay/go.mod'] = 'module example.com/relay\n\ngo 1.24\ntoolchain go1.26.9\n';
    expect(messages(check(files))).toEqual([
      expect.stringMatching(/^go 1\.24: must be 1\.26\.10, the release docker\/relay\/Dockerfile:2 builds/u),
      expect.stringMatching(/^toolchain go1\.26\.9: must be 1\.26\.10/u),
    ]);
  });

  it.each([
    ['a minor-only version', { 'go-version': '1.26' }],
    ['an unquoted YAML number', { 'go-version': 1.26 }],
    ['an alias', { 'go-version': 'stable' }],
    ['no version', {}],
    ['both a version and a file', { 'go-version': '1.26.10', 'go-version-file': 'docker/relay/go.mod' }],
    ['a file outside the repository', { 'go-version-file': '../go.mod' }],
  ])('rejects setup-go with %s', (_label, settings) => {
    const files = consistentTree();
    files['.github/workflows/other.yml'] = YAML.stringify({
      jobs: { other: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/setup-go@v7', with: settings }] } },
    });
    expect(messages(check(files))).toEqual([expect.stringMatching(/^job other: setup-go|^setup-go go-version-file/u)]);
  });

  it('rejects setup-go reading a go.mod without a patch release', () => {
    const files = consistentTree();
    files['docker/relay/go.mod'] = 'module example.com/relay\n\ngo 1.26\n';
    files['docker/relay/Dockerfile'] = 'FROM scratch\n';
    expect(messages(check(files))).toEqual([
      expect.stringContaining('setup-go go-version-file docker/relay/go.mod: its go line must name an exact release'),
    ]);
  });

  it('requires build-trust jobs to install the release that built the committed binaries', () => {
    const files = consistentTree();
    files['.github/workflows/ci.yml'] = YAML.stringify({
      jobs: {
        trust: {
          ...BUILD_TRUST_JOB,
          steps: [
            { uses: 'actions/setup-go@v7', with: { 'go-version': '1.26.10' } },
            ...BUILD_TRUST_JOB.steps.slice(1),
          ],
        },
        relay: RELAY_JOB,
      },
    });
    expect(messages(check(files))).toEqual([
      expect.stringContaining(
        'job trust: setup-go: installs go1.26.10, but docker/build-trust-runtime/manifest.json records go1.26.1',
      ),
    ]);
  });

  it('rejects a build-trust go.mod that requires a newer release than built the binaries', () => {
    const files = consistentTree();
    files['docker/build-trust-runtime/go.mod'] = 'module example.com/trust\n\ngo 1.26.5\n';
    expect(messages(check(files))).toEqual([expect.stringContaining('requires a newer release than go1.26.1')]);
  });

  it('rejects an unreadable build-trust manifest', () => {
    const files = consistentTree();
    files['docker/build-trust-runtime/manifest.json'] = JSON.stringify({ goVersion: 'go version devel +abc' });
    expect(messages(check(files))).toEqual([expect.stringContaining('goVersion must be the `go version` output')]);
  });

  it('with the supported releases, rejects stale patches and unsupported minors', () => {
    const files = consistentTree();
    files['docker/shim/Dockerfile'] = `FROM golang:1.25.8@${DIGEST} AS build\n`;
    expect(messages(check(files, SUPPORTED))).toEqual([
      expect.stringContaining('Go 1.25 is no longer supported (supported: 1.27, 1.26)'),
      // The build-trust runtime: its CI pin and its committed binaries.
      expect.stringContaining('job trust: setup-go: go1.26.1 is behind go1.26.10'),
      expect.stringContaining('go1.26.1 is behind go1.26.10, the newest 1.26 release'),
    ]);
  });

  it('with the supported releases, accepts pins at the newest patch of a supported minor', () => {
    const files = consistentTree();
    files['docker/build-trust-runtime/manifest.json'] = JSON.stringify({
      schemaVersion: 2,
      goVersion: 'go version go1.26.10 linux/amd64',
      targets: [],
    });
    files['.github/workflows/ci.yml'] = YAML.stringify({
      jobs: {
        trust: {
          ...BUILD_TRUST_JOB,
          steps: [
            { uses: 'actions/setup-go@v7', with: { 'go-version': '1.26.10' } },
            ...BUILD_TRUST_JOB.steps.slice(1),
          ],
        },
        relay: RELAY_JOB,
      },
    });
    expect(check(files, SUPPORTED).problems).toEqual([]);
  });

  it('validates the go.dev release list', () => {
    expect(parseGoReleases([{ version: 'go1.27.3', stable: true, files: [] }])).toEqual([
      { version: 'go1.27.3', stable: true },
    ]);
    expect(() => parseGoReleases([])).toThrow(/non-empty/u);
    expect(() => parseGoReleases([{ version: 'go1.27.3' }])).toThrow(/boolean stable/u);
    expect(() => check(consistentTree(), [{ version: 'go1.28rc1', stable: false }])).toThrow(/no stable release/u);
  });
});
