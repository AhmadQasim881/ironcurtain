/**
 * Agent CLI version pins, qualified ranges, the version override, and the
 * check of the CLI version a built image actually carries.
 *
 * Each agent image installs its CLI at the version a Dockerfile ARG selects
 * (`ARG CLAUDE_CODE_VERSION`, `ARG CODEX_VERSION`, `ARG GOOSE_VERSION`). The
 * ARG default is the pin: the version qualified with this IronCurtain
 * release, recorded here as {@link AgentCliVersionSupport.pinned} (a test ties
 * the two together). Dockerfile contents are part of the image build hash, so
 * bumping a pin rebuilds the image, and workflow snapshots of the previous
 * build are no longer resumed (see `container-snapshots.ts`).
 *
 * Pinned by default (owner decision). `agentCliVersions` in config.json can
 * override the npm-installed CLIs (Claude Code, Codex) with an exact version
 * or the npm dist-tag `latest`. The override is passed as the build arg and
 * folded into the agent build hash, so changing it rebuilds the image. With
 * `latest` the hash does not move when npm publishes a release; `ironcurtain
 * images rebuild` refreshes the image. Manual builds can pass the same build
 * arg (`docker build --build-arg CLAUDE_CODE_VERSION=latest ...`).
 *
 * At session start the CLI version baked into the image is probed once per
 * build and process; a version outside the qualified range is logged as a
 * warning (it may not support the flags and environment this release uses).
 *
 * Leaf module: type-only imports, plus the logger and the display sanitizer.
 */

import * as logger from '../logger.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { ContainerRuntime } from './types.js';

/** Agents whose CLI version can be overridden in config.json (`agentCliVersions`). */
export const AGENT_CLI_OVERRIDE_KEYS = ['claude-code', 'codex'] as const;
export type AgentCliOverrideKey = (typeof AGENT_CLI_OVERRIDE_KEYS)[number];
/** `agentCliVersions` as resolved from config.json: absent keys use the pin. */
export type AgentCliVersionOverrides = Readonly<Partial<Record<AgentCliOverrideKey, string>>>;

/**
 * An accepted override: `latest` or an exact release such as `2.1.292` or
 * `1.0.0-beta.2`. The value reaches a shell inside the image build
 * (`npm install -g "<package>@${VERSION}"`), so anything else is rejected.
 */
export const AGENT_CLI_VERSION_OVERRIDE_PATTERN =
  /^(?:latest|\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,4})?)$/u;

export function isValidAgentCliVersionOverride(value: string): boolean {
  return AGENT_CLI_VERSION_OVERRIDE_PATTERN.test(value);
}

/** What an agent image installs and which CLI versions this release has qualified. */
export interface AgentCliVersionSupport {
  /** Name used in messages, e.g. `Claude Code`. */
  readonly displayName: string;
  /** Dockerfile ARG that selects the installed CLI version. */
  readonly buildArg: string;
  /** The Dockerfile's ARG default: the version the image installs unless overridden. */
  readonly pinned: string;
  /** Oldest CLI version qualified with this release. */
  readonly minVersion: string;
  /** Newest CLI version qualified with this release. */
  readonly maxTested: string;
  /** Key under `agentCliVersions` that may override the pin; absent when the install has no override. */
  readonly overrideKey?: AgentCliOverrideKey;
}

/**
 * Claude Code: the newest version this repository records as qualified
 * (docs/designs/zai-provider-profiles.md, live checks "Passed"). The adapter
 * sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS and CLAUDE_ENABLE_STREAM_WATCHDOG
 * for behavior changed in 2.1.196/2.1.198 (issue #367). Lower `minVersion` or
 * raise `maxTested` only after qualifying the version against this adapter.
 */
export const CLAUDE_CODE_CLI_VERSION: AgentCliVersionSupport = {
  displayName: 'Claude Code',
  buildArg: 'CLAUDE_CODE_VERSION',
  pinned: '2.1.292',
  minVersion: '2.1.292',
  maxTested: '2.1.292',
  overrideKey: 'claude-code',
};

/**
 * Codex: the MITM's openai-responses sanitizer keeps only the tool and item
 * types recorded from this client version (test/docker/fixtures/codex-*), and
 * the native provider binding sends it as its `version` header. Re-record
 * the fixtures before qualifying another version.
 */
export const CODEX_CLI_VERSION: AgentCliVersionSupport = {
  displayName: 'Codex',
  buildArg: 'CODEX_VERSION',
  pinned: '0.157.1',
  minVersion: '0.157.1',
  maxTested: '0.157.1',
  overrideKey: 'codex',
};

/** Goose: a GitHub release binary, pinned in docker/Dockerfile.goose; no override. */
export const GOOSE_CLI_VERSION: AgentCliVersionSupport = {
  displayName: 'Goose',
  buildArg: 'GOOSE_VERSION',
  pinned: '1.26.1',
  minVersion: '1.26.1',
  maxTested: '1.26.1',
};

/**
 * Build args that select the overridden CLI version, or none when the pin
 * applies. An override equal to the pin is the pin: no build arg, so the
 * image (and its build hash) is the default one.
 */
export function resolveAgentCliBuildArgs(
  support: AgentCliVersionSupport | undefined,
  overrides: AgentCliVersionOverrides | undefined,
): Readonly<Record<string, string>> {
  if (support?.overrideKey === undefined) return {};
  const requested = overrides?.[support.overrideKey];
  if (requested === undefined || requested === support.pinned) return {};
  // Validated with the config already; checked again because the value is
  // interpolated into a shell command inside the image build.
  if (!isValidAgentCliVersionOverride(requested)) {
    throw new Error(
      `agentCliVersions.${support.overrideKey} must be "latest" or an exact version such as ${support.pinned}`,
    );
  }
  return { [support.buildArg]: requested };
}

/** The CLI version an image installs: the override when one applies, else the pin. */
export function describeAgentCliVersionSelection(
  support: AgentCliVersionSupport,
  overrides: AgentCliVersionOverrides | undefined,
): { readonly version: string; readonly overridden: boolean } {
  const buildArgs = resolveAgentCliBuildArgs(support, overrides);
  const overridden = Object.hasOwn(buildArgs, support.buildArg);
  return { version: overridden ? buildArgs[support.buildArg] : support.pinned, overridden };
}

// ---------------------------------------------------------------------------
// Version parsing and comparison
// ---------------------------------------------------------------------------

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease?: string;
}

const VERSION_IN_TEXT = /(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?/u;
/** Probe output beyond this is never needed to find a version. */
const MAX_PROBE_OUTPUT_CHARS = 4096;

function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION_IN_TEXT.exec(text.slice(0, MAX_PROBE_OUTPUT_CHARS));
  if (match === null) return undefined;
  // The prerelease group is optional: absent from the match when not present.
  const prerelease = match[4] as string | undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

function formatVersion(version: ParsedVersion): string {
  const core = version.core.join('.');
  return version.prerelease === undefined ? core : `${core}-${version.prerelease}`;
}

/**
 * The first `MAJOR.MINOR.PATCH[-PRERELEASE]` in a CLI's `--version` output
 * (`2.1.292 (Claude Code)`, `codex-cli 0.157.1`), or undefined.
 */
export function parseAgentCliVersion(output: string): string | undefined {
  const parsed = parseVersion(output);
  return parsed === undefined ? undefined : formatVersion(parsed);
}

/** Orders two versions: release numbers first, then a prerelease before its release. */
export function compareAgentCliVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) throw new Error(`not a version: ${left === undefined ? a : b}`);
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Where a probed CLI version falls relative to the qualified range. */
export type AgentCliVersionVerdict =
  | { readonly kind: 'qualified'; readonly version: string }
  | { readonly kind: 'older'; readonly version: string }
  | { readonly kind: 'newer'; readonly version: string }
  /** The probe output carried no version; `output` is display-safe. */
  | { readonly kind: 'unparsed'; readonly output: string };

export function assessAgentCliVersion(probeOutput: string, support: AgentCliVersionSupport): AgentCliVersionVerdict {
  const version = parseAgentCliVersion(probeOutput);
  if (version === undefined) {
    return { kind: 'unparsed', output: toDisplayText(probeOutput.slice(0, 200)) };
  }
  if (compareAgentCliVersions(version, support.minVersion) < 0) return { kind: 'older', version };
  if (compareAgentCliVersions(version, support.maxTested) > 0) return { kind: 'newer', version };
  return { kind: 'qualified', version };
}

function qualifiedRange(support: AgentCliVersionSupport): string {
  return support.minVersion === support.maxTested ? support.minVersion : `${support.minVersion}–${support.maxTested}`;
}

/** One line describing a verdict; a warning for a version outside the qualified range. */
export function describeAgentCliVersionVerdict(
  verdict: AgentCliVersionVerdict,
  support: AgentCliVersionSupport,
): { readonly level: 'info' | 'warn'; readonly message: string } {
  const range = qualifiedRange(support);
  const remedy =
    support.overrideKey === undefined
      ? `docker/Dockerfile.* pins ${support.pinned}`
      : `remove agentCliVersions.${support.overrideKey} from config.json to build the pinned ${support.pinned}`;
  switch (verdict.kind) {
    case 'qualified':
      return { level: 'info', message: `${support.displayName} CLI ${verdict.version} (qualified: ${range})` };
    case 'older':
      return {
        level: 'warn',
        message:
          `${support.displayName} CLI ${verdict.version} is older than the versions qualified with this ` +
          `IronCurtain release (${range}); it may lack flags or behavior the adapter relies on (${remedy})`,
      };
    case 'newer':
      return {
        level: 'warn',
        message:
          `${support.displayName} CLI ${verdict.version} is newer than the versions qualified with this ` +
          `IronCurtain release (${range}); its behavior may differ from what the adapter expects (${remedy})`,
      };
    case 'unparsed':
      return {
        level: 'info',
        message: `${support.displayName} CLI version could not be read from its --version output: ${verdict.output}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Session-start check
// ---------------------------------------------------------------------------

/**
 * `${image}@${buildHash}` keys already checked in this process, so the probe
 * (a throwaway `run --rm --network none <image> --version`) runs at most once
 * per built image rather than for every session or workflow state. Keyed by
 * build hash, not the tag alone, so a rebuilt image is checked again.
 */
const checkedImages = new Set<string>();

/** Clears the once-per-build memo. */
export function resetAgentCliVersionChecksForTests(): void {
  checkedImages.clear();
}

export interface CheckAgentCliVersionInput {
  readonly runtime: Pick<ContainerRuntime, 'probeImageVersion'>;
  readonly image: string;
  readonly buildHash: string;
  /** Command printing the CLI version (`AgentAdapter.versionProbe`). */
  readonly versionProbe: readonly string[] | undefined;
  /** Qualified range (`AgentAdapter.cliVersion`); without it the version is only logged. */
  readonly support: AgentCliVersionSupport | undefined;
}

/**
 * Best-effort: probes the agent CLI baked into `image` and logs its version,
 * as a warning when it falls outside the qualified range. Returns the verdict
 * (undefined when nothing was probed). Skipped without a probe command or
 * when the runtime cannot run an ephemeral container; never throws.
 */
export async function checkAgentCliVersion(
  input: CheckAgentCliVersionInput,
): Promise<AgentCliVersionVerdict | undefined> {
  const { runtime, image, buildHash, versionProbe, support } = input;
  if (!versionProbe || versionProbe.length === 0 || !runtime.probeImageVersion) return undefined;
  const cacheKey = `${image}@${buildHash}`;
  if (checkedImages.has(cacheKey)) return undefined;
  checkedImages.add(cacheKey);
  let output: string | undefined;
  try {
    output = await runtime.probeImageVersion(image, versionProbe);
  } catch {
    // Diagnostic only: never disturb infrastructure preparation.
    return undefined;
  }
  if (output === undefined) return undefined;
  if (support === undefined) {
    const version = parseAgentCliVersion(output);
    logger.info(`[docker] ${image} agent CLI version: ${version ?? toDisplayText(output.slice(0, 200))}`);
    return undefined;
  }
  const verdict = assessAgentCliVersion(output, support);
  const { level, message } = describeAgentCliVersionVerdict(verdict, support);
  if (level === 'warn') logger.warn(`[docker] ${image}: ${message}`);
  else logger.info(`[docker] ${image}: ${message}`);
  return verdict;
}
