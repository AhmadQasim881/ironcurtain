/**
 * `node docker/build-trust-runtime/build.mjs --check` (BLD-12): the committed
 * wrapper binaries must be byte-identical to a fresh build made with the Go
 * release manifest.json records, and any other release is a toolchain
 * mismatch rather than a pass.
 *
 * No Go toolchain is needed. build.mjs runs on a copy of the package (so a
 * committed binary can be made stale), with a fake `go` first on PATH that
 * reports FAKE_GO_RELEASE and "compiles" by copying prepared bytes.
 */

import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const ARCHITECTURES = ['amd64', 'arm64'] as const;

const FAKE_GO = `#!/bin/sh
# Stands in for the Go toolchain: reports $FAKE_GO_RELEASE and "builds" by
# copying $FAKE_GO_OUTPUTS/runc-$GOARCH to the -o path. It refuses every
# environment in which a real toolchain could build other bytes while still
# reporting that release: another toolchain or GOROOT, GOFLAGS, a go.env or
# go.work file, or a non-default microarchitecture level, experiment or FIPS
# module.
if [ "$GOTOOLCHAIN" != local ] || [ "$GOENV" != off ] || [ -n "$GOFLAGS" ] || [ "$GOWORK" != off ] ||
  [ "$GOAMD64" != v1 ] || [ "$GOARM64" != v8.0 ] || [ -n "$GOEXPERIMENT" ] || [ "$GOFIPS140" != off ] ||
  [ -n "\${GOROOT+set}" ]; then
  echo "fake go: unexpected toolchain environment" >&2
  exit 2
fi
case "$1" in
  version)
    echo "go version $FAKE_GO_RELEASE linux/amd64"
    ;;
  build)
    if [ "$CGO_ENABLED" != 0 ] || [ "$GOOS" != linux ]; then
      echo "fake go: unexpected build environment" >&2
      exit 2
    fi
    out=
    while [ $# -gt 0 ]; do
      if [ "$1" = -o ]; then out=$2; shift; fi
      shift
    done
    cp "$FAKE_GO_OUTPUTS/runc-$GOARCH" "$out"
    ;;
  *)
    echo "fake go: unsupported command $*" >&2
    exit 2
    ;;
esac
`;

interface Tree {
  readonly dir: string;
  readonly runtime: string;
  /** What the fake compiler produces for each architecture. */
  readonly outputs: string;
  readonly bin: string;
}

let tree: Tree;

function committed(architecture: string): string {
  return join(tree.runtime, `bin/linux-${architecture}/ironcurtain-build-trust-runc`);
}

/** The release manifest.json records, e.g. go1.26.1. */
function recordedRelease(): string {
  const manifest = JSON.parse(readFileSync(join(tree.runtime, 'manifest.json'), 'utf-8')) as { goVersion: string };
  const release = /^go version (go\S+)/u.exec(manifest.goVersion)?.[1];
  if (release === undefined) throw new Error(`unexpected manifest goVersion ${manifest.goVersion}`);
  return release;
}

/** Flips the last byte, leaving the ELF header intact. */
function corrupt(path: string): void {
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(path, bytes);
}

async function buildMjs(
  mode: '--check' | '--write',
  release: string,
  callerEnvironment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [join(tree.runtime, 'build.mjs'), mode], {
    cwd: tree.runtime,
    env: {
      ...process.env,
      ...callerEnvironment,
      PATH: `${tree.bin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_GO_RELEASE: release,
      FAKE_GO_OUTPUTS: tree.outputs,
    },
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ic-build-trust-check-'));
  const runtime = join(dir, 'docker/build-trust-runtime');
  cpSync(join(ROOT, 'docker/build-trust-runtime'), runtime, { recursive: true });
  mkdirSync(join(dir, 'src/docker'), { recursive: true });
  copyFileSync(
    join(ROOT, 'src/docker/build-trust-runtime-contract.ts'),
    join(dir, 'src/docker/build-trust-runtime-contract.ts'),
  );
  const outputs = join(dir, 'compiler-output');
  mkdirSync(outputs);
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'go'), FAKE_GO, { mode: 0o755 });
  tree = { dir, runtime, outputs, bin };
  // A faithful compiler reproduces the committed binaries.
  for (const architecture of ARCHITECTURES)
    copyFileSync(committed(architecture), join(outputs, `runc-${architecture}`));
});

afterEach(() => {
  rmSync(tree.dir, { recursive: true, force: true });
});

describe('build-trust runtime --check', () => {
  it('passes when the committed binaries are the recorded toolchain build of this source', async () => {
    const { stdout } = await buildMjs('--check', recordedRelease());
    expect(stdout).toContain('byte-identical');
  });

  it.each(ARCHITECTURES)('fails when the committed %s binary is stale', async (architecture) => {
    corrupt(committed(architecture));
    await expect(buildMjs('--check', recordedRelease())).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `bin/linux-${architecture}/ironcurtain-build-trust-runc is not the ${recordedRelease()} build of this source`,
      ),
    });
  });

  it('fails when the source builds to other bytes than were committed', async () => {
    corrupt(join(tree.outputs, 'runc-amd64'));
    await expect(buildMjs('--check', recordedRelease())).rejects.toMatchObject({
      stderr: expect.stringContaining('bin/linux-amd64/ironcurtain-build-trust-runc is not the'),
    });
  });

  it('fails when a committed binary is missing', async () => {
    rmSync(committed('arm64'));
    await expect(buildMjs('--check', recordedRelease())).rejects.toMatchObject({
      stderr: expect.stringContaining('bin/linux-arm64/ironcurtain-build-trust-runc is not the'),
    });
  });

  it('refuses to compare with another Go release instead of passing', async () => {
    // Even a corrupted binary must not pass through a toolchain mismatch.
    corrupt(committed('amd64'));
    await expect(buildMjs('--check', 'go1.99.0')).rejects.toMatchObject({
      stderr: expect.stringContaining(`toolchain mismatch: manifest.json records ${recordedRelease()}`),
    });
  });

  it('fails when the generated protocol metadata is stale', async () => {
    const contract = join(tree.dir, 'src/docker/build-trust-runtime-contract.ts');
    writeFileSync(contract, readFileSync(contract, 'utf-8').replace('"maxCodeBytes": 128', '"maxCodeBytes": 129'));
    await expect(buildMjs('--check', recordedRelease())).rejects.toMatchObject({
      stderr: expect.stringContaining('the generated build-trust protocol metadata differs from this source'),
    });
  });

  it('accepts a rebuild with --write once every binary and the manifest move to the new release', async () => {
    corrupt(join(tree.outputs, 'runc-amd64'));
    corrupt(join(tree.outputs, 'runc-arm64'));
    await buildMjs('--write', 'go1.99.0');

    const manifest = JSON.parse(readFileSync(join(tree.runtime, 'manifest.json'), 'utf-8')) as {
      goVersion: string;
      targets: unknown;
    };
    expect(manifest.goVersion).toBe('go version go1.99.0 linux/amd64');
    expect(manifest.targets).toEqual(
      ARCHITECTURES.map((architecture) => ({
        architecture,
        path: `bin/linux-${architecture}/ironcurtain-build-trust-runc`,
      })),
    );
    for (const architecture of ARCHITECTURES) {
      expect(
        readFileSync(committed(architecture)).equals(readFileSync(join(tree.outputs, `runc-${architecture}`))),
      ).toBe(true);
    }
    await expect(buildMjs('--check', 'go1.99.0')).resolves.toMatchObject({
      stdout: expect.stringContaining('byte-identical'),
    });
    await expect(buildMjs('--check', 'go1.26.1')).rejects.toMatchObject({
      stderr: expect.stringContaining('toolchain mismatch'),
    });
  });

  it('builds with Go defaults whatever toolchain settings the caller exports', async () => {
    // Each of these can change the compiled bytes (GOAMD64=v3 alone does) while
    // `go version` still names the recorded release.
    const { stdout } = await buildMjs('--check', recordedRelease(), {
      GOROOT: join(tree.dir, 'other-goroot'),
      GOTOOLCHAIN: 'go1.99.0',
      GOENV: join(tree.dir, 'go.env'),
      GOFLAGS: '-tags=unreviewed',
      GOWORK: join(tree.dir, 'go.work'),
      GOAMD64: 'v3',
      GOARM64: 'v9.0',
      GOEXPERIMENT: 'nogreenteagc',
      GOFIPS140: 'latest',
    });
    expect(stdout).toContain('byte-identical');
  });

  it('rejects `go version` output that names no release', async () => {
    await expect(buildMjs('--check', 'devel')).rejects.toMatchObject({
      stderr: expect.stringContaining('cannot read a Go release'),
    });
  });
});
