/**
 * Policy provenance: how a compiled-policy.json was built, recorded when it is
 * compiled and compared with the running IronCurtain when it is loaded.
 *
 * A compiled policy outlives the IronCurtain that compiled it. Someone who
 * ran `compile-policy` once keeps enforcing those rules after upgrades that
 * fix the compiler, change how the policy engine evaluates rules, or change
 * the shipped tool annotations, and the constitution hash cannot tell: such
 * fixes leave the constitution unchanged. Every compile therefore stamps a
 * `provenance` block into the policy: the deliberately bumped versions below,
 * the package version, the policy model, and a digest of the tool-annotation
 * content each server's rules were compiled against. Loaders compare it with
 * this IronCurtain and the annotations in effect, and report what no longer
 * matches (see `assessPolicyProvenance`).
 *
 * The versions are constants bumped by hand, never derived from prompt or
 * source text: runtime code may not import the compile pipeline, and a bump
 * is a statement that older artifacts are worth rebuilding.
 *
 * Runtime leaf: the compile pipeline imports it to stamp artifacts; the
 * session, coordinator and doctor import it to check them. It must not import
 * from src/pipeline (type-only imports excepted).
 */

import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../pipeline/types.js';
import { computeAnnotationContentDigest } from '../config/tool-annotations-overlay.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { extractRequiredServers } from '../trusted-process/policy-roots.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Format of the `provenance` block. Bump only when its shape changes incompatibly. */
export const POLICY_PROVENANCE_SCHEMA_VERSION = 1;

/**
 * Generation of the policy compiler. Bump when a change to compilation makes
 * policies compiled before it worth rebuilding: a rewritten compiler prompt
 * or rule schema, new post-processing of compiled rules, a fix that stops the
 * compiler emitting over-broad rules. It is part of the per-server compile
 * cache key, so a bump recompiles every server on the next `compile-policy`;
 * at load, a policy compiled in another epoch is stale.
 */
export const POLICY_COMPILER_EPOCH = 1;

/**
 * Version of the PolicyEngine's semantics for compiled rules. Bump when a
 * change can alter the decision an existing rule set gives: how rules match,
 * how argument roles are resolved, how lists are expanded, or the structural
 * invariants compiled rules rely on. A cached per-server result verified
 * under another version is re-verified (not recompiled) on the next compile;
 * at load, a policy compiled for another version is stale.
 */
export const ENGINE_SEMANTICS_VERSION = 2;

/**
 * Version of the compile pipeline's verification and repair logic: the judge
 * prompt, scenario filtering, correction and repair, point-fix repair, and the
 * repair and verification round limits. Bump when it changes. A per-server
 * cache hit verified by another version is still served, with a warning;
 * `compile-policy --force` recompiles and re-verifies.
 *
 * History: 2 -- the scenario generator and the judge are told that the rules'
 * directories and list values come from the policy under test (never that
 * they are permitted), and persona and job compiles verify the universal
 * handwritten invariants.
 */
export const PIPELINE_VERIFIER_VERSION = 2;

// ---------------------------------------------------------------------------
// The provenance block
// ---------------------------------------------------------------------------

/** How a compiled policy was built. Stored as `provenance` in compiled-policy.json. */
export interface PolicyProvenance {
  /** Format of this block ({@link POLICY_PROVENANCE_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  /** IronCurtain package version that compiled the policy. */
  readonly producerVersion: string;
  /** {@link POLICY_COMPILER_EPOCH} of the compiler that produced the rules. */
  readonly policyCompilerEpoch: number;
  /** {@link ENGINE_SEMANTICS_VERSION} the rules were verified against. */
  readonly engineSemanticsVersion: number;
  /**
   * {@link PIPELINE_VERIFIER_VERSION} of the verification the rules passed:
   * the oldest one when some servers' rules were served from cache.
   */
  readonly verifierVersion: number;
  /**
   * Policy model that compiled the rules (`policyModelId`), when known and the
   * same for every server. It also verified them unless a separate verifier
   * model (`policyVerifierModelId`) was configured; the per-server commits
   * record that one (`verifierModelId`).
   */
  readonly policyModelId?: string;
  /**
   * Content digest (`computeAnnotationContentDigest`, a sha256 of the
   * canonical JSON of the server's `tools`) of the tool annotations each
   * server's rules were compiled against, for every server the rules
   * reference. Not the annotation `inputHash`: that covers only the
   * annotator's inputs and stays the same when roles are edited.
   */
  readonly annotationDigests: Readonly<Record<string, string>>;
}

/** The servers a policy's rules reference (`rule.if.server`), reserved virtual servers excluded, sorted. */
export function policyRuleServers(policy: Pick<CompiledPolicyFile, 'rules'>): string[] {
  return [...extractRequiredServers(policy)].sort();
}

function annotationEntry(annotations: StoredToolAnnotationsFile, server: string) {
  return Object.hasOwn(annotations.servers, server) ? annotations.servers[server] : undefined;
}

/**
 * Builds the provenance block for a policy compiled now by this IronCurtain:
 * the current versions, `policyModelId` when known, and the content digest of
 * `annotations` for every server the rules reference.
 */
export function buildPolicyProvenance(input: {
  readonly policy: Pick<CompiledPolicyFile, 'rules'>;
  /** The effective annotations the rules were compiled against. */
  readonly annotations: StoredToolAnnotationsFile;
  readonly policyModelId?: string;
  /**
   * Verifier version to record when some rules were verified by an older one
   * (served from the per-server cache). Defaults to the current version.
   */
  readonly verifierVersion?: number;
}): PolicyProvenance {
  const digests: Array<[string, string]> = [];
  for (const server of policyRuleServers(input.policy)) {
    const entry = annotationEntry(input.annotations, server);
    if (entry) digests.push([server, computeAnnotationContentDigest(entry.tools)]);
  }
  return {
    schemaVersion: POLICY_PROVENANCE_SCHEMA_VERSION,
    producerVersion: VERSION,
    policyCompilerEpoch: POLICY_COMPILER_EPOCH,
    engineSemanticsVersion: ENGINE_SEMANTICS_VERSION,
    verifierVersion: input.verifierVersion ?? PIPELINE_VERIFIER_VERSION,
    ...(input.policyModelId ? { policyModelId: input.policyModelId } : {}),
    // fromEntries defines own properties, so a server named "__proto__" stays data.
    annotationDigests: Object.fromEntries(digests),
  };
}

/**
 * Returns `policy` with `provenance` set, placed after `inputHash` so the
 * block sits with the other build metadata at the top of the file. A block
 * the policy already carries is replaced (re-stamping a shipped policy).
 */
export function withPolicyProvenance(policy: CompiledPolicyFile, provenance: PolicyProvenance): CompiledPolicyFile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to drop the block being replaced.
  const { generatedAt, constitutionHash, inputHash, provenance: _replaced, ...rest } = policy;
  return { generatedAt, constitutionHash, inputHash, provenance, ...rest };
}

const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

type ParsedProvenance =
  | { readonly ok: true; readonly provenance: PolicyProvenance }
  | { readonly ok: false; readonly reason: PolicyStaleReason };

/** Validates a `provenance` value read from a file. */
function parseProvenance(raw: unknown): ParsedProvenance {
  const malformed: ParsedProvenance = { ok: false, reason: { kind: 'unreadable-provenance' } };
  if (!isPlainObject(raw) || !isNonNegativeInteger(raw.schemaVersion)) return malformed;
  if (raw.schemaVersion > POLICY_PROVENANCE_SCHEMA_VERSION) {
    return { ok: false, reason: { kind: 'provenance-format', recorded: raw.schemaVersion } };
  }
  const digests = raw.annotationDigests;
  if (
    typeof raw.producerVersion !== 'string' ||
    !isNonNegativeInteger(raw.policyCompilerEpoch) ||
    !isNonNegativeInteger(raw.engineSemanticsVersion) ||
    !isNonNegativeInteger(raw.verifierVersion) ||
    (raw.policyModelId !== undefined && typeof raw.policyModelId !== 'string') ||
    !isPlainObject(digests) ||
    !Object.values(digests).every((d) => typeof d === 'string')
  ) {
    return malformed;
  }
  return { ok: true, provenance: raw as unknown as PolicyProvenance };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** One reason a compiled policy may no longer describe what the policy engine will do. */
export type PolicyStaleReason =
  /** No `provenance` block: compiled before provenance was recorded (or by hand). */
  | { readonly kind: 'no-provenance' }
  /** The block is present but malformed. */
  | { readonly kind: 'unreadable-provenance' }
  /** The block has a format newer than this IronCurtain understands. */
  | { readonly kind: 'provenance-format'; readonly recorded: number }
  | { readonly kind: 'compiler-epoch'; readonly recorded: number; readonly current: number }
  | { readonly kind: 'engine-semantics'; readonly recorded: number; readonly current: number }
  /** The effective annotations of these servers differ from the ones the rules were compiled against. */
  | { readonly kind: 'annotations-changed'; readonly servers: readonly string[] }
  /** The provenance records no annotation digest for these servers, which the rules reference. */
  | { readonly kind: 'annotations-unrecorded'; readonly servers: readonly string[] }
  /** The rules reference these servers, which no longer have annotations (their tools are denied). */
  | { readonly kind: 'annotations-missing'; readonly servers: readonly string[] };

export interface PolicyProvenanceAssessment {
  /** The policy's provenance, when present and readable. */
  readonly provenance?: PolicyProvenance;
  /** Why the policy may be stale. Empty when its provenance matches this IronCurtain. */
  readonly staleReasons: readonly PolicyStaleReason[];
  /**
   * Rules without a `server` condition: the format compilers before
   * IronCurtain 0.9 produced. Such a rule matches calls to every server, but
   * sessions start only the servers rules name, so a server referenced by no
   * scoped rule is never started. Reported separately: not a staleness
   * reason by itself.
   */
  readonly unscopedRules: readonly string[];
}

/**
 * Compares a policy's provenance with this IronCurtain and, when given, the
 * annotations in effect. Pure: reads nothing from disk.
 *
 * Without `annotations` the annotation digests are not compared (a caller
 * that has none loaded checks only the versions).
 */
export function assessPolicyProvenance(
  policy: CompiledPolicyFile,
  annotations?: StoredToolAnnotationsFile,
): PolicyProvenanceAssessment {
  const unscopedRules = policy.rules.filter((rule) => rule.if.server === undefined).map((rule) => rule.name);
  const raw: unknown = (policy as { provenance?: unknown }).provenance;
  if (raw === undefined) return { staleReasons: [{ kind: 'no-provenance' }], unscopedRules };
  const parsed = parseProvenance(raw);
  if (!parsed.ok) return { staleReasons: [parsed.reason], unscopedRules };

  const provenance = parsed.provenance;
  const staleReasons: PolicyStaleReason[] = [];
  if (provenance.policyCompilerEpoch !== POLICY_COMPILER_EPOCH) {
    staleReasons.push({
      kind: 'compiler-epoch',
      recorded: provenance.policyCompilerEpoch,
      current: POLICY_COMPILER_EPOCH,
    });
  }
  if (provenance.engineSemanticsVersion !== ENGINE_SEMANTICS_VERSION) {
    staleReasons.push({
      kind: 'engine-semantics',
      recorded: provenance.engineSemanticsVersion,
      current: ENGINE_SEMANTICS_VERSION,
    });
  }
  if (annotations) {
    const changed: string[] = [];
    const unrecorded: string[] = [];
    const missing: string[] = [];
    for (const server of policyRuleServers(policy)) {
      const entry = annotationEntry(annotations, server);
      const recorded = Object.hasOwn(provenance.annotationDigests, server)
        ? provenance.annotationDigests[server]
        : undefined;
      if (!entry) missing.push(server);
      else if (recorded === undefined) unrecorded.push(server);
      else if (recorded !== computeAnnotationContentDigest(entry.tools)) changed.push(server);
    }
    if (changed.length > 0) staleReasons.push({ kind: 'annotations-changed', servers: changed });
    if (unrecorded.length > 0) staleReasons.push({ kind: 'annotations-unrecorded', servers: unrecorded });
    if (missing.length > 0) staleReasons.push({ kind: 'annotations-missing', servers: missing });
  }
  return { provenance, staleReasons, unscopedRules };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A name read from an artifact, quoted and safe to print. */
export function quoteArtifactName(name: string): string {
  return toDisplayText(JSON.stringify(name));
}

function serverList(servers: readonly string[]): string {
  return servers.map(quoteArtifactName).join(', ');
}

/** One-line, human-readable description of a stale reason. */
export function describePolicyStaleReason(reason: PolicyStaleReason): string {
  switch (reason.kind) {
    case 'no-provenance':
      return (
        'it records no provenance: it was compiled by an IronCurtain version from before compiled policies ' +
        'recorded how they were built, so later policy-compiler, policy-engine and tool-annotation fixes are not in it'
      );
    case 'unreadable-provenance':
      return 'its provenance record is malformed';
    case 'provenance-format':
      return (
        `its provenance record has format ${reason.recorded}, newer than this IronCurtain understands ` +
        `(${POLICY_PROVENANCE_SCHEMA_VERSION})`
      );
    case 'compiler-epoch':
      return reason.recorded < reason.current
        ? `it was compiled by an older policy compiler (epoch ${reason.recorded}; this IronCurtain is at epoch ${reason.current})`
        : `it was compiled by a newer policy compiler (epoch ${reason.recorded}; this IronCurtain is at epoch ${reason.current})`;
    case 'engine-semantics':
      return (
        `it was verified against policy-engine semantics v${reason.recorded}; ` +
        `this IronCurtain evaluates rules with v${reason.current}`
      );
    case 'annotations-changed':
      return `the tool annotations of ${serverList(reason.servers)} changed since it was compiled`;
    case 'annotations-unrecorded':
      return `it does not record which tool annotations of ${serverList(reason.servers)} it was compiled against`;
    case 'annotations-missing':
      return `it has rules for ${serverList(reason.servers)}, which no longer have tool annotations (their tools are denied)`;
  }
}

/** At most this many unscoped rule names are listed in a message. */
const MAX_LISTED_RULES = 5;

/** One-line description of rules without a `server` condition, or undefined when there are none. */
export function describeUnscopedRules(unscopedRules: readonly string[]): string | undefined {
  if (unscopedRules.length === 0) return undefined;
  const listed = unscopedRules.slice(0, MAX_LISTED_RULES).map(quoteArtifactName).join(', ');
  const more = unscopedRules.length > MAX_LISTED_RULES ? `, and ${unscopedRules.length - MAX_LISTED_RULES} more` : '';
  return (
    `${unscopedRules.length} rule(s) have no "server" condition (the format of IronCurtain before 0.9): ` +
    `${listed}${more}. Sessions start only the servers that rules name, so a server covered only by such ` +
    'rules is not started and its tools are unavailable'
  );
}
