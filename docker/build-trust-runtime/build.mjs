#!/usr/bin/env node

// Cross-compiles the build-trust runc wrapper for linux/amd64 and linux/arm64.
//
//   --write  replaces the committed binaries under bin/, regenerates
//            src/docker/build-trust-runtime-contract.ts and records the
//            toolchain in manifest.json.
//   --check  rebuilds both with the toolchain manifest.json records and
//            requires the committed binaries to be byte-identical to the fresh
//            build (BLD-12). The build is reproducible (-trimpath, no cgo, no VCS
//            stamp, cross-compiled in a pinned Go environment), so a difference
//            means a committed ELF is stale or was replaced. It also checks the
//            generated protocol metadata. Another Go release may compile the
//            same source to other bytes, so with any other `go` --check fails
//            with a toolchain mismatch instead of comparing bytes it cannot
//            reproduce. CI and release install the recorded release
//            (scripts/check-go-toolchain.ts keeps those pins in step).

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoFailureDiagnosticCodes } from './diagnostic-codes.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const architectures = ['amd64', 'arm64'];
// The toolchain decides the bytes: never let go.mod, GOFLAGS, a go.env or
// go.work file, another GOROOT, or a microarchitecture level, experiment or
// FIPS module inherited from the caller switch to another release or change the
// build while `go version` still reports the recorded release. The pinned
// values are Go's defaults, which CI and release use. Without GOROOT, `go`
// uses the installation it belongs to.
const callerEnvironment = { ...process.env };
delete callerEnvironment.GOROOT;
const goEnvironment = {
  ...callerEnvironment,
  GOENV: 'off',
  GOFLAGS: '',
  GOTOOLCHAIN: 'local',
  GOWORK: 'off',
  GOAMD64: 'v1',
  GOARM64: 'v8.0',
  GOEXPERIMENT: '',
  GOFIPS140: 'off',
};
const runtimeContractPath = join(root, '../../src/docker/build-trust-runtime-contract.ts');
const fixture = JSON.parse(readFileSync(join(root, 'testdata/synthetic-build-trust-contract.json'), 'utf8'));
const mode = process.argv[2];
if (!['--check', '--write'].includes(mode) || process.argv.length !== 3) {
  throw new Error('usage: node build.mjs --check|--write');
}
const metadata = {
  schemaVersion: 2,
  wrapper: {
    packagePaths: Object.fromEntries(
      architectures.map((arch) => [arch, `docker/build-trust-runtime/bin/linux-${arch}/ironcurtain-build-trust-runc`]),
    ),
    packageMode: '0755',
    guestMode: '0555',
  },
  realRunc: {
    path: fixture.realRunc.path,
    mode: '0755',
    nlink: 1,
    version: fixture.realRunc.version,
    requiresEffectiveReadOnly: true,
  },
  trustContract: {
    parentDirectory: {
      path: '/ironcurtain-build-trust',
      mode: '0755',
      requiresEffectiveReadOnly: true,
    },
    mode: '0444',
    nlink: 1,
    requiresEffectiveReadOnly: true,
  },
  failureDiagnostic: {
    path: '/tmp/.ironcurtain-build-trust-runc-failure-v1',
    clearCommand: '--ironcurtain-internal-clear-failure-v1',
    readCommand: '--ironcurtain-internal-read-failure-v1',
    unavailableCode: 'ICBT-DIAGNOSTIC-UNAVAILABLE-V1',
    maxCodeBytes: 128,
    allowedCodes: parseGoFailureDiagnosticCodes(readFileSync(join(root, 'main.go'), 'utf8')),
  },
};
const rendered = `/** Generated protocol/layout metadata. No executable byte pins. */\n// prettier-ignore\nexport const BUILD_TRUST_RUNTIME_CONTRACT = ${JSON.stringify(metadata, null, 2)} as const;\n`;
const targets = architectures.map((architecture) => ({
  architecture,
  path: `bin/linux-${architecture}/ironcurtain-build-trust-runc`,
}));
const goVersion = execFileSync('go', ['version'], { cwd: root, encoding: 'utf8', env: goEnvironment }).trim();
const release = goRelease(goVersion);
if (mode === '--check') {
  const recorded = goRelease(readManifest().goVersion);
  if (release !== recorded) {
    throw new Error(
      `toolchain mismatch: manifest.json records ${recorded}, which built the committed binaries, but go is ${release}. ` +
        `--check compares the committed binaries byte for byte with a fresh build, which only ${recorded} reproduces: ` +
        `install ${recorded}, or rebuild with node build.mjs --write and move the CI and release Go pins to ${release} in the same change.`,
    );
  }
}
const temporary = mkdtempSync(join(tmpdir(), 'ironcurtain-build-trust-runtime-'));
try {
  const problems = [];
  for (const { architecture, path } of targets) {
    const binary = join(temporary, `runc-${architecture}`);
    execFileSync(
      'go',
      ['build', '-buildvcs=false', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', binary, '.'],
      {
        cwd: root,
        env: { ...goEnvironment, GOOS: 'linux', GOARCH: architecture, CGO_ENABLED: '0' },
        stdio: 'inherit',
      },
    );
    const bytes = readFileSync(binary);
    const machine = architecture === 'amd64' ? 62 : 183;
    if (
      !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== machine
    ) {
      throw new Error(`compiler did not produce a Linux ${architecture} ELF executable`);
    }
    if (mode === '--write') {
      atomicWrite(join(root, path), bytes, 0o755);
    } else if (!sameBytes(join(root, path), bytes)) {
      problems.push(`${path} is not the ${release} build of this source`);
    }
  }
  if (mode === '--write') {
    atomicWrite(runtimeContractPath, Buffer.from(rendered), 0o644);
    atomicWrite(
      join(root, 'manifest.json'),
      Buffer.from(`${JSON.stringify({ schemaVersion: 2, goVersion, targets }, null, 2)}\n`),
      0o644,
    );
  } else {
    const source = readFileSync(runtimeContractPath, 'utf8');
    const match = /export const BUILD_TRUST_RUNTIME_CONTRACT = ([\s\S]*?) as const;/u.exec(source);
    if (match === null || JSON.stringify(JSON.parse(match[1])) !== JSON.stringify(metadata)) {
      problems.push('the generated build-trust protocol metadata differs from this source');
    }
    if (problems.length > 0) {
      throw new Error(
        `build-trust runtime check failed: ${problems.join('; ')}. Run node build.mjs --write and commit the result.`,
      );
    }
  }
  process.stdout.write(
    mode === '--write'
      ? `build-trust runtime packaged for ${architectures.join(', ')} with ${release}\n`
      : `build-trust runtime compiled with ${release}; committed binaries for ${architectures.join(', ')} are byte-identical\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

/** The release in `go version` output: "go version go1.26.1 linux/amd64" is "go1.26.1". */
function goRelease(output) {
  const match = /^go version (go\d+\.\d+(?:\.\d+)?(?:(?:rc|beta)\d+)?)(?:\s|$)/u.exec(String(output));
  if (match === null) throw new Error(`cannot read a Go release from ${JSON.stringify(output)}`);
  return match[1];
}

/** manifest.json as --write produced it, for these targets. */
function readManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== 2 ||
    typeof manifest.goVersion !== 'string' ||
    JSON.stringify(manifest.targets) !== JSON.stringify(targets)
  ) {
    throw new Error(
      'manifest.json is not the schema 2 manifest for the amd64 and arm64 targets; run node build.mjs --write',
    );
  }
  return manifest;
}

function sameBytes(path, expected) {
  try {
    return readFileSync(path).equals(expected);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function atomicWrite(path, bytes, modeBits) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, bytes, { flag: 'wx', mode: modeBits });
    chmodSync(staging, modeBits);
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
