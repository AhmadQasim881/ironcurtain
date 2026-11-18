/**
 * Checks the Go toolchain pins of IronCurtain's Go components (BLD-13).
 *
 *   docker/nested-relay         the fixed-target relay. Its image is built on the
 *                               user's machine and cached by a hash of Dockerfile,
 *                               main.go and go.mod, so a new toolchain reaches users
 *                               only through an edit of those files.
 *   docker/nested-daemon        the runc shim built into the nested-daemon image.
 *   docker/build-trust-runtime  committed cross-compiled binaries. manifest.json
 *                               records the toolchain that built them, and
 *                               `node build.mjs --check` rebuilds them with that
 *                               toolchain and requires identical bytes.
 *
 * Dependabot can bump a literal `FROM golang:...@sha256:...` line, but not a
 * go.mod `go` line, a setup-go version or the build-trust manifest, and nothing
 * notices a release going out of support. This check covers those pins.
 *
 * Without network data (every PR, through test/go-toolchain-pins.test.ts):
 *   - every golang image under docker/ names an exact release
 *     (golang:1.26.10-bookworm), and a digest, if present, is well formed;
 *   - a module built by a Dockerfile in its own directory declares that same
 *     release in go.mod (`go 1.26.10`), so CI's `go test`, which installs the
 *     go.mod release, runs the toolchain the image ships;
 *   - every actions/setup-go step installs an exact release, directly or
 *     through such a go.mod;
 *   - jobs that build or check the build-trust runtime install the release in
 *     its manifest.json, and its go.mod does not require a newer one.
 *
 * With --releases <file>, the JSON of https://go.dev/dl/?mode=json (the
 * supported releases, newest patch of each), every pinned minor must still be
 * supported and every exact pin must be the newest patch of its minor: patch
 * releases carry the standard library's security fixes.
 *
 * A golang image must also be pinned by the digest of its multi-platform index
 * (golang:1.26.10-bookworm@sha256:<64 hex>) before a release. One without a
 * digest is reported as `unverified`, which fails only with --strict (the
 * release and the weekly scheduled check), so the image still builds while the
 * verified digest is pending. A placeholder digest (PLACEHOLDER_DIGEST, 64
 * zeros) is an error everywhere: no registry serves it, so the image could not
 * be built on users' machines at all.
 *
 * CLI: tsx scripts/check-go-toolchain.ts [--strict] [--releases <file>]
 * Exits 1 on any error (and, with --strict, on any unverified pin).
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import YAML from 'yaml';

/** A placeholder digest: well formed, but no registry serves it, so the image cannot be built. */
export const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;

/** Where the build-trust runtime records the toolchain its committed binaries were built with. */
export const BUILD_TRUST_MANIFEST = 'docker/build-trust-runtime/manifest.json';
const BUILD_TRUST_GO_MOD = 'docker/build-trust-runtime/go.mod';
/** A job that mentions this in a run script builds or checks the build-trust runtime. */
const BUILD_TRUST_MARKER = 'build-trust-runtime';

export type PinKind = 'image' | 'go.mod' | 'setup-go' | 'build-trust-manifest';

export interface GoPin {
  readonly kind: PinKind;
  /** Repository-relative path with forward slashes. */
  readonly file: string;
  readonly line?: number;
  /** What the pin is, for messages. */
  readonly where: string;
  /** The Go release it names: "1.26.10", or "1.26" for a go.mod minimum without a patch. */
  readonly version?: string;
  /** Image pins only. */
  readonly reference?: string;
  readonly digest?: string;
  /** setup-go pins only: the job, and whether it builds or checks the build-trust runtime. */
  readonly job?: string;
  readonly buildTrustJob?: boolean;
}

export interface ToolchainProblem {
  /** `unverified` marks a golang image not pinned by digest, which fails only in strict mode. */
  readonly severity: 'error' | 'unverified';
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface GoRelease {
  readonly version: string;
  readonly stable: boolean;
}

export interface ToolchainReport {
  readonly pins: readonly GoPin[];
  readonly problems: readonly ToolchainProblem[];
}

export interface CheckOptions {
  readonly root: string;
  /** The supported releases (go.dev/dl/?mode=json); without them, no support or patch-level check. */
  readonly releases?: readonly GoRelease[];
}

interface Release {
  readonly major: number;
  readonly minor: number;
  readonly patch?: number;
}

const EXACT_RELEASE = /^(\d+)\.(\d+)\.(\d+)$/u;
const MINOR_RELEASE = /^(\d+)\.(\d+)$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
/** `go version` output, as recorded in the build-trust manifest. */
const GO_VERSION_OUTPUT = /^go version go(\d+\.\d+(?:\.\d+)?)(?:\s|$)/u;
/** An exact golang image tag: the release, then an optional variant such as -bookworm. */
const EXACT_GOLANG_TAG = /^(\d+\.\d+\.\d+)(?:-[a-z0-9][a-z0-9.-]*)?$/u;
const GOLANG_IMAGE = /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/)?(?:library\/)?golang(?::(\S+))?$/u;

function parseRelease(version: string): Release | undefined {
  const exact = EXACT_RELEASE.exec(version);
  if (exact) return { major: Number(exact[1]), minor: Number(exact[2]), patch: Number(exact[3]) };
  const minor = MINOR_RELEASE.exec(version);
  if (minor) return { major: Number(minor[1]), minor: Number(minor[2]) };
  return undefined;
}

/** Orders releases; a missing patch counts as .0, the earliest release of that minor. */
function compareReleases(a: Release, b: Release): number {
  return a.major - b.major || a.minor - b.minor || (a.patch ?? 0) - (b.patch ?? 0);
}

function isExact(version: string | undefined): version is string {
  return version !== undefined && EXACT_RELEASE.test(version);
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

/** Regular files under `dir` (symbolic links are not followed), repository-relative. */
function walk(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(root, path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/u, '$2');
}

/**
 * The golang images a Dockerfile builds from. A `FROM ${NAME}` whose ARG
 * default names golang counts too, so moving the pin into an ARG does not
 * hide it.
 */
export function parseDockerfileGoImages(file: string, text: string): GoPin[] {
  const pins: GoPin[] = [];
  const args = new Map<string, string>();
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/iu.exec(line);
    if (arg) {
      args.set(arg[1], stripQuotes(arg[2]));
      return;
    }
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/iu.exec(line);
    if (!from) return;
    const reference = from[1].replace(
      /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/u,
      (whole, braced: string | undefined, bare: string | undefined) => args.get(braced ?? bare ?? '') ?? whole,
    );
    const at = reference.indexOf('@');
    const name = at === -1 ? reference : reference.slice(0, at);
    const golang = GOLANG_IMAGE.exec(name);
    if (!golang) return;
    const tag = golang[1];
    pins.push({
      kind: 'image',
      file,
      line: index + 1,
      where: `FROM ${reference}`,
      version: tag === undefined ? undefined : EXACT_GOLANG_TAG.exec(tag)?.[1],
      reference,
      ...(at === -1 ? {} : { digest: reference.slice(at + 1) }),
    });
  });
  return pins;
}

/** The `go` line of a go.mod (and its `toolchain` line, when present). */
export function parseGoMod(file: string, text: string): { go?: GoPin; toolchain?: GoPin } {
  const result: { go?: GoPin; toolchain?: GoPin } = {};
  const go = /^go[ \t]+(\S+)[ \t]*$/mu.exec(text);
  if (go) {
    result.go = { kind: 'go.mod', file, line: lineNumber(text, go.index), where: `go ${go[1]}`, version: go[1] };
  }
  const toolchain = /^toolchain[ \t]+go(\S+)[ \t]*$/mu.exec(text);
  if (toolchain) {
    result.toolchain = {
      kind: 'go.mod',
      file,
      line: lineNumber(text, toolchain.index),
      where: `toolchain go${toolchain[1]}`,
      version: toolchain[1],
    };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the go.dev/dl/?mode=json document. */
export function parseGoReleases(json: unknown): GoRelease[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error('Go release list: expected a non-empty JSON array');
  return json.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.version !== 'string' || typeof entry.stable !== 'boolean') {
      throw new Error(`Go release list: entry ${index} has no string version and boolean stable`);
    }
    return { version: entry.version, stable: entry.stable };
  });
}

class Checker {
  readonly pins: GoPin[] = [];
  readonly problems: ToolchainProblem[] = [];

  constructor(private readonly root: string) {}

  error(file: string, line: number | undefined, message: string): void {
    this.problems.push({ severity: 'error', file, ...(line === undefined ? {} : { line }), message });
  }

  read(file: string): string {
    return readFileSync(join(this.root, file), 'utf-8');
  }

  checkImages(): Map<string, GoPin[]> {
    const byDirectory = new Map<string, GoPin[]>();
    const dockerfiles = walk(this.root, 'docker').filter((file) => /^Dockerfile(?:\..+)?$/u.test(posix.basename(file)));
    for (const file of dockerfiles) {
      for (const pin of parseDockerfileGoImages(file, this.read(file))) {
        this.pins.push(pin);
        const directory = posix.dirname(file);
        byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), pin]);
        if (pin.version === undefined) {
          this.error(
            file,
            pin.line,
            `${pin.where}: name an exact Go release (golang:<major>.<minor>.<patch>[-variant]); a floating tag never refreshes images already built on users' machines`,
          );
        }
        if (pin.digest === undefined) {
          this.problems.push({
            severity: 'unverified',
            file,
            ...(pin.line === undefined ? {} : { line: pin.line }),
            message: `${pin.where}: pin the image by digest (@sha256:<64 hex>, the verified digest of the multi-platform ${pin.reference ?? 'golang'} index); the release refuses an undigested golang image`,
          });
        } else if (pin.digest === PLACEHOLDER_DIGEST) {
          this.error(
            file,
            pin.line,
            `${pin.where}: the digest is a placeholder that no registry serves, so the image cannot be built; use the verified digest of the multi-platform ${pin.reference?.split('@')[0] ?? 'golang'} index, or no digest until it is known`,
          );
        } else if (!DIGEST.test(pin.digest)) {
          this.error(file, pin.line, `${pin.where}: malformed digest (expected sha256:<64 lowercase hex>)`);
        }
      }
    }
    return byDirectory;
  }

  checkModules(imagesByDirectory: Map<string, GoPin[]>): void {
    for (const file of walk(this.root, 'docker').filter((path) => posix.basename(path) === 'go.mod')) {
      const { go, toolchain } = parseGoMod(file, this.read(file));
      if (go === undefined) {
        this.error(file, undefined, 'go.mod has no `go` line');
        continue;
      }
      this.pins.push(go);
      if (toolchain !== undefined) this.pins.push(toolchain);
      if (parseRelease(go.version ?? '') === undefined) {
        this.error(file, go.line, `${go.where}: expected a Go release such as 1.26 or 1.26.10`);
      }
      const images = imagesByDirectory.get(posix.dirname(file)) ?? [];
      for (const image of images) {
        if (image.version === undefined) continue;
        for (const declared of [go, toolchain]) {
          if (declared !== undefined && declared.version !== image.version) {
            this.error(
              file,
              declared.line,
              `${declared.where}: must be ${image.version}, the release ${image.file}:${image.line ?? '?'} builds this module with, so CI tests the toolchain the image ships`,
            );
          }
        }
      }
    }
  }

  resolveGoModRelease(file: string, versionFile: string): string | undefined {
    const path = posix.normalize(toPosix(versionFile));
    if (
      posix.isAbsolute(path) ||
      path.startsWith('../') ||
      posix.basename(path) !== 'go.mod' ||
      !existsSync(join(this.root, path))
    ) {
      this.error(file, undefined, `setup-go go-version-file ${versionFile}: not a go.mod in this repository`);
      return undefined;
    }
    const { go, toolchain } = parseGoMod(path, this.read(path));
    const version = toolchain?.version ?? go?.version;
    if (!isExact(version)) {
      this.error(
        file,
        undefined,
        `setup-go go-version-file ${versionFile}: its go line must name an exact release (go 1.26.10) so CI installs exactly that release`,
      );
      return undefined;
    }
    return version;
  }

  checkWorkflows(): void {
    for (const file of walk(this.root, '.github/workflows').filter((path) => /\.ya?ml$/u.test(path))) {
      const parsed: unknown = YAML.parse(this.read(file));
      const jobs = isRecord(parsed) && isRecord(parsed.jobs) ? parsed.jobs : {};
      for (const [job, definition] of Object.entries(jobs)) {
        const steps = isRecord(definition) && Array.isArray(definition.steps) ? definition.steps : [];
        const buildTrustJob = steps.some(
          (step) => isRecord(step) && typeof step.run === 'string' && step.run.includes(BUILD_TRUST_MARKER),
        );
        for (const step of steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('actions/setup-go@')) continue;
          const settings = isRecord(step.with) ? step.with : {};
          const version: unknown = settings['go-version'];
          const versionFile: unknown = settings['go-version-file'];
          const where = `job ${job}: setup-go`;
          let resolved: string | undefined;
          if (version !== undefined && versionFile !== undefined) {
            this.error(file, undefined, `${where}: set go-version or go-version-file, not both`);
          } else if (versionFile !== undefined) {
            resolved = typeof versionFile === 'string' ? this.resolveGoModRelease(file, versionFile) : undefined;
            if (typeof versionFile !== 'string') this.error(file, undefined, `${where}: go-version-file is not a path`);
          } else if (typeof version === 'string' && isExact(version)) {
            resolved = version;
          } else {
            // YAML reads an unquoted 1.20 as the number 1.2: insist on an exact string.
            this.error(
              file,
              undefined,
              `${where}: install an exact release (go-version: 1.26.10, or go-version-file: <go.mod>), not ${JSON.stringify(version ?? null)}`,
            );
          }
          this.pins.push({
            kind: 'setup-go',
            file,
            where,
            job,
            buildTrustJob,
            ...(resolved === undefined ? {} : { version: resolved }),
          });
        }
      }
    }
  }

  checkBuildTrust(): void {
    if (!existsSync(join(this.root, BUILD_TRUST_MANIFEST))) return;
    let recorded: string | undefined;
    try {
      const manifest: unknown = JSON.parse(this.read(BUILD_TRUST_MANIFEST));
      const goVersion = isRecord(manifest) ? manifest.goVersion : undefined;
      recorded = typeof goVersion === 'string' ? GO_VERSION_OUTPUT.exec(goVersion)?.[1] : undefined;
    } catch {
      recorded = undefined;
    }
    if (!isExact(recorded)) {
      this.error(BUILD_TRUST_MANIFEST, undefined, 'goVersion must be the `go version` output of an exact release');
      return;
    }
    this.pins.push({
      kind: 'build-trust-manifest',
      file: BUILD_TRUST_MANIFEST,
      where: `committed build-trust binaries built with go${recorded}`,
      version: recorded,
    });
    const recordedRelease = parseRelease(recorded);
    for (const pin of this.pins) {
      if (pin.kind !== 'setup-go' || pin.buildTrustJob !== true || pin.version === undefined) continue;
      if (pin.version !== recorded) {
        this.error(
          pin.file,
          pin.line,
          `${pin.where}: installs go${pin.version}, but ${BUILD_TRUST_MANIFEST} records go${recorded}; build.mjs --check compares the committed binaries byte for byte only with that release (run node build.mjs --write with the new release and move every pin together)`,
        );
      }
    }
    if (existsSync(join(this.root, BUILD_TRUST_GO_MOD))) {
      const { go } = parseGoMod(BUILD_TRUST_GO_MOD, this.read(BUILD_TRUST_GO_MOD));
      const required = go?.version === undefined ? undefined : parseRelease(go.version);
      if (required !== undefined && recordedRelease !== undefined && compareReleases(required, recordedRelease) > 0) {
        this.error(
          BUILD_TRUST_GO_MOD,
          go?.line,
          `${go?.where ?? 'go'}: requires a newer release than go${recorded}, which built the committed binaries`,
        );
      }
    }
  }

  checkSupport(releases: readonly GoRelease[]): void {
    const newest = new Map<string, Release>();
    for (const release of releases) {
      if (!release.stable) continue;
      const parsed = parseRelease(release.version.replace(/^go/u, ''));
      if (parsed?.patch === undefined) continue;
      const key = `${parsed.major}.${parsed.minor}`;
      const known = newest.get(key);
      if (known === undefined || compareReleases(parsed, known) > 0) newest.set(key, parsed);
    }
    if (newest.size === 0) throw new Error('Go release list: no stable release');
    const supported = [...newest.keys()].join(', ');
    for (const pin of this.pins) {
      const parsed = pin.version === undefined ? undefined : parseRelease(pin.version);
      if (parsed === undefined) continue;
      const key = `${parsed.major}.${parsed.minor}`;
      const latest = newest.get(key);
      if (latest === undefined) {
        this.error(pin.file, pin.line, `${pin.where}: Go ${key} is no longer supported (supported: ${supported})`);
      } else if (parsed.patch !== undefined && parsed.patch < (latest.patch ?? 0)) {
        this.error(
          pin.file,
          pin.line,
          `${pin.where}: go${pin.version ?? ''} is behind go${key}.${latest.patch ?? 0}, the newest ${key} release; patch releases carry the security fixes`,
        );
      } else if (parsed.patch !== undefined && parsed.patch > (latest.patch ?? 0)) {
        this.error(pin.file, pin.line, `${pin.where}: go${pin.version ?? ''} is not a released Go version`);
      }
    }
  }
}

/** Collects every Go toolchain pin under `root` and what is wrong with them. */
export function checkGoToolchain(options: CheckOptions): ToolchainReport {
  const checker = new Checker(options.root);
  checker.checkModules(checker.checkImages());
  checker.checkWorkflows();
  checker.checkBuildTrust();
  if (options.releases !== undefined) checker.checkSupport(options.releases);
  return { pins: checker.pins, problems: checker.problems };
}

/** Problems that fail the check: errors, and with `strict` undigested golang images too. */
export function failingProblems(report: ToolchainReport, strict: boolean): ToolchainProblem[] {
  return report.problems.filter((problem) => problem.severity === 'error' || strict);
}

function formatProblem(problem: ToolchainProblem, failing: boolean, github: boolean): string {
  const location = problem.line === undefined ? problem.file : `${problem.file}:${problem.line}`;
  if (github) {
    const properties = `file=${problem.file}${problem.line === undefined ? '' : `,line=${problem.line}`}`;
    return `::${failing ? 'error' : 'warning'} ${properties}::${problem.message}`;
  }
  return `${failing ? 'error' : 'warning'}: ${location}: ${problem.message}`;
}

function main(argv: string[]): number {
  let values: { strict: boolean; releases?: string; root?: string };
  let releases: GoRelease[] | undefined;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        strict: { type: 'boolean', default: false },
        releases: { type: 'string' },
        root: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
    releases =
      values.releases === undefined
        ? undefined
        : parseGoReleases(JSON.parse(readFileSync(values.releases, 'utf-8')) as unknown);
  } catch (error) {
    process.stderr.write(`check-go-toolchain: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('usage: tsx scripts/check-go-toolchain.ts [--strict] [--releases <go.dev/dl JSON>]\n');
    return 2;
  }
  const root = resolve(values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const report = checkGoToolchain({ root, ...(releases === undefined ? {} : { releases }) });
  const failing = new Set(failingProblems(report, values.strict));
  const github = process.env.GITHUB_ACTIONS === 'true';
  for (const pin of report.pins) {
    const location = pin.line === undefined ? pin.file : `${pin.file}:${pin.line}`;
    console.log(`${location}: ${pin.where}${pin.version === undefined ? '' : ` -> go${pin.version}`}`);
  }
  for (const problem of report.problems) {
    console.log(formatProblem(problem, failing.has(problem), github));
  }
  const unverified = report.problems.filter((problem) => problem.severity === 'unverified').length;
  console.log(
    `${report.pins.length} Go toolchain pins, ${failing.size} failing problem(s)` +
      (unverified > 0 && !values.strict
        ? `, ${unverified} golang image(s) not pinned by digest (they fail with --strict)`
        : '') +
      (releases === undefined ? '; release support not checked (no --releases)' : ''),
  );
  return failing.size > 0 ? 1 : 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
