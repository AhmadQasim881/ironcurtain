/**
 * Runtime schemas for the policy artifacts the trusted process loads:
 * `compiled-policy.json`, `dynamic-lists.json` and `tool-annotations.json`.
 *
 * These files steer every policy decision, and people edit them by hand
 * (policy reviews, `manualAdditions` / `manualRemovals` in the lists). The
 * runtime loaders used to cast parsed JSON to the artifact types, so a typo
 * failed open: `then: "Escalate"` came back from the engine as a decision
 * the tool-call pipeline forwarded like an allow, a misspelled condition key
 * (`tools` for `tool`) was ignored and turned the rule server-wide, and a
 * string where the lists file expects an array was spread into single
 * characters (a bare `*` in an allowlist). Every runtime loader now parses
 * through this module and fails closed, naming the file and each offending
 * field. The offline pipeline uses it too where it reuses a file instead of
 * producing one: cached per-server rules (`assertServerPolicyRules`) and the
 * lists whose manual overrides list resolution carries forward.
 *
 * What the schemas check:
 *   - compiled-policy.json: every rule and condition exactly. Unknown keys in
 *     a rule or condition are errors, so a misspelled condition cannot widen
 *     a rule. Argument roles are checked against the static role registry,
 *     `then` must be allow, assess, escalate or deny (`assess` is an allow
 *     subject to the outbound content assessment, see `RuleOutcome`),
 *     `paths.within` must not depend on the working directory, and an allow,
 *     assess or escalate rule must not have a catch-all condition (deny may:
 *     it only restricts). File metadata is type-checked; other top-level
 *     keys are informational and kept. The `provenance` block is one of them
 *     here: the load-time provenance check
 *     (src/config/policy-provenance-check.ts) validates it itself and reports
 *     a malformed block as a stale policy rather than an unloadable one.
 *   - dynamic-lists.json: each list's values and manual overrides must be
 *     arrays of strings, and unknown keys in a list are errors (a misspelled
 *     `manualRemovals` must not silently keep a value the user removed).
 *     Missing override arrays default to empty, because users are told to
 *     add them by hand.
 *   - tool-annotations.json: each server entry and tool annotation; every
 *     argument's roles (a static array or a conditional block) against the
 *     role registry; conditions with exactly one operator, naming another
 *     argument of the same tool; no tool annotated twice for one server.
 *
 * Server and tool names are plain strings here. The compiler's schemas
 * enumerate the names of one compilation, which a runtime loader does not
 * have. Everything the compiler writes passes these schemas: the checks
 * added here (no catch-all allow, assess or escalate, anchored
 * `paths.within`) are ones the compiler already enforces before it writes a
 * policy (an `assess` rule is a compiled allow the pipeline converted).
 * Likewise the annotator refuses a tool annotated twice and a condition on
 * an argument the tool does not have (`src/pipeline/tool-annotator.ts`).
 *
 * Record-shaped values (servers, tool arguments, lists) are validated key by
 * key with `Object.entries`, so a key named `__proto__` is checked like any
 * other instead of being skipped.
 *
 * Leaf module: it imports zod, the role registry, the display sanitizer and
 * the plain-object guards, and only types from `src/pipeline/`.
 */

import { z } from 'zod';
import type {
  CompiledPolicyFile,
  CompiledRuleCondition,
  DynamicListsFile,
  ListType,
  RuleOutcome,
  ServerCompilationFailurePhase,
} from '../pipeline/types.js';
import type { PolicyDecisionStatus } from './mcp.js';
import { getArgumentRoleValues } from './argument-roles.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { isObjectWithProp, isPlainObject } from '../utils/is-plain-object.js';

// ---------------------------------------------------------------------------
// Static value sets
// ---------------------------------------------------------------------------

/** Every decision the policy engine returns. Records keep the sets in sync with the types. */
const POLICY_DECISIONS: Readonly<Record<PolicyDecisionStatus, true>> = { allow: true, escalate: true, deny: true };

/**
 * Every outcome a compiled rule may carry: the engine decisions plus
 * `assess`, an allow subject to the outbound content assessment (see
 * `RuleOutcome` in src/pipeline/types.ts).
 */
const RULE_OUTCOMES: Readonly<Record<RuleOutcome, true>> = { allow: true, assess: true, escalate: true, deny: true };

const LIST_TYPES: Readonly<Record<ListType, true>> = { domains: true, emails: true, identifiers: true };

const FAILURE_PHASES: Readonly<Record<ServerCompilationFailurePhase, true>> = {
  compiling: true,
  lists: true,
  scenarios: true,
  'repair-scenarios': true,
  verifying: true,
  'repair-compile': true,
  'repair-verify': true,
};

function enumValues<T extends string>(values: Readonly<Record<T, true>>): [T, ...T[]] {
  return Object.keys(values) as [T, ...T[]];
}

/** True for `allow`, `escalate` and `deny`: the decisions the policy engine returns. */
export function isPolicyDecisionStatus(value: unknown): value is PolicyDecisionStatus {
  return typeof value === 'string' && Object.hasOwn(POLICY_DECISIONS, value);
}

/**
 * True for `allow`, `assess`, `escalate` and `deny`: the outcomes a compiled
 * rule may carry. The policy engine uses it to treat any other outcome (a
 * rule built in memory without going through this module, say) as a deny.
 */
export function isRuleOutcome(value: unknown): value is RuleOutcome {
  return typeof value === 'string' && Object.hasOwn(RULE_OUTCOMES, value);
}

/**
 * True for the rule outcomes that let a matching call through: `allow`, and
 * `assess`, an allow subject to the opt-in outbound content assessment (which
 * looks at what a call sends, never at where it goes, and is off by
 * default). Every check of what a policy grants (the policy lint, the
 * broad-policy validator, list resolution) treats both alike: the compile
 * pipeline turns allows into `assess` before the merged policy is linted
 * and validated, so a check that looked for `allow` alone would wave every
 * outbound-channel allow through.
 */
export function ruleOutcomeAllows(outcome: unknown): boolean {
  return outcome === 'allow' || outcome === 'assess';
}

/**
 * True when a rule condition constrains nothing, so the rule matches every
 * call: no `roles`, `server`, `tool`, `paths` or `domains`, and no non-empty
 * `lists` (an empty `lists` array adds no constraint; the engine treats the
 * rule as role-agnostic and checks zero list conditions). Shared with the
 * constitution compiler's schema, which rejects such rules too.
 */
export function isCatchAllCondition(cond: CompiledRuleCondition): boolean {
  return (
    cond.roles === undefined &&
    cond.server === undefined &&
    cond.tool === undefined &&
    cond.paths === undefined &&
    cond.domains === undefined &&
    (cond.lists === undefined || cond.lists.length === 0)
  );
}

/**
 * `paths.within` must name the same directory wherever the engine runs:
 * absolute, `~` or `~/...` (the constitution compiler's rule). A relative
 * directory would resolve against the working directory of whichever
 * process evaluates it.
 */
function isAnchoredDirectory(value: string): boolean {
  return value.startsWith('/') || value === '~' || value.startsWith('~/');
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const argumentRoleSchema = z.enum(getArgumentRoleValues());
const roleListSchema = z.array(argumentRoleSchema);
const stringListSchema = z.array(z.string());

/**
 * An object whose own keys are free-form names and whose values all match
 * `valueSchema`. Unlike `z.record`, every own key is validated (zod's record
 * skips `__proto__`), and the output is built with `Object.fromEntries`, so
 * such a key stays plain data.
 */
function ownKeyRecord<T extends z.ZodType>(valueSchema: T) {
  return z.unknown().transform((value, ctx): Record<string, z.output<T>> => {
    if (!isPlainObject(value)) {
      ctx.addIssue({ code: 'invalid_type', expected: 'object', input: value, message: 'expected an object' });
      return z.NEVER;
    }
    const entries: Array<[string, z.output<T>]> = [];
    for (const [key, entry] of Object.entries(value)) {
      const result = valueSchema.safeParse(entry, { reportInput: true });
      if (result.success) {
        entries.push([key, result.data]);
      } else {
        for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] });
      }
    }
    return Object.fromEntries(entries);
  });
}

// ---------------------------------------------------------------------------
// compiled-policy.json
// ---------------------------------------------------------------------------

const pathConditionSchema = z.strictObject({
  roles: roleListSchema,
  within: z.string().refine(isAnchoredDirectory, 'must be an absolute path or start with ~/'),
});

const domainConditionSchema = z.strictObject({
  roles: roleListSchema,
  allowed: stringListSchema,
});

const listConditionSchema = z.strictObject({
  roles: roleListSchema,
  allowed: stringListSchema,
  matchType: z.enum(enumValues(LIST_TYPES)),
});

const ruleConditionSchema = z.strictObject({
  roles: roleListSchema.optional(),
  server: stringListSchema.optional(),
  tool: stringListSchema.optional(),
  paths: pathConditionSchema.optional(),
  domains: domainConditionSchema.optional(),
  lists: z.array(listConditionSchema).optional(),
});

/**
 * One compiled rule, exactly as the compiler writes it. `humanOnly` is not
 * part of the file format: only the hardcoded proxy rules carry it, and they
 * are merged in after the file has been validated.
 */
const compiledRuleSchema = z
  .strictObject({
    name: z.string(),
    description: z.string(),
    principle: z.string(),
    if: ruleConditionSchema,
    then: z.enum(enumValues(RULE_OUTCOMES)),
    reason: z.string(),
  })
  .superRefine((rule, ctx) => {
    if (rule.then !== 'deny' && isCatchAllCondition(rule.if)) {
      ctx.addIssue({
        code: 'custom',
        path: ['if'],
        message:
          `matches every call, which is not allowed for an "${rule.then}" rule: ` +
          'name a server, tool, roles, paths, domains or lists',
      });
    }
  });

/** List definitions are read by list resolution, not by the engine; checked for type, other keys kept. */
const listDefinitionSchema = z.looseObject({
  name: z.string(),
  type: z.enum(enumValues(LIST_TYPES)),
  principle: z.string(),
  generationPrompt: z.string(),
  requiresMcp: z.boolean(),
  mcpServerHint: z.string().optional(),
});

// Loose: `provenance` and other informational keys pass through unchanged
// (see the module comment).
const compiledPolicyFileSchema = z.looseObject({
  generatedAt: z.string(),
  constitutionHash: z.string(),
  inputHash: z.string(),
  rules: z.array(compiledRuleSchema),
  listDefinitions: z.array(listDefinitionSchema).optional(),
  skippedServers: z.array(z.looseObject({ serverName: z.string(), reason: z.string() })).optional(),
  failedServers: z
    .array(
      z.looseObject({
        serverName: z.string(),
        phase: z.enum(enumValues(FAILURE_PHASES)),
        reason: z.string(),
      }),
    )
    .optional(),
});

/**
 * The rules and list definitions of a per-server compiled policy (the
 * compile cache's `servers/<name>/compiled-policy.json`), checked exactly
 * as in compiled-policy.json: the pipeline merges them into that file. The
 * cache's own bookkeeping fields are checked by the pipeline.
 */
const serverPolicyRulesSchema = z.looseObject({
  rules: z.array(compiledRuleSchema),
  listDefinitions: z.array(listDefinitionSchema).optional(),
});

// ---------------------------------------------------------------------------
// dynamic-lists.json
// ---------------------------------------------------------------------------

const resolvedListSchema = z.strictObject({
  resolutionState: z.enum(['complete', 'incomplete']).optional(),
  values: stringListSchema,
  manualAdditions: stringListSchema.default(() => []),
  manualRemovals: stringListSchema.default(() => []),
  resolvedAt: z.string(),
  inputHash: z.string(),
});

const dynamicListsFileSchema = z.looseObject({
  generatedAt: z.string(),
  lists: ownKeyRecord(resolvedListSchema),
});

// ---------------------------------------------------------------------------
// tool-annotations.json
// ---------------------------------------------------------------------------

const roleConditionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const roleConditionSchema = z
  .strictObject({
    arg: z.string(),
    equals: roleConditionValueSchema.optional(),
    in: z.array(roleConditionValueSchema).optional(),
    is: z.enum(['present', 'absent', 'truthy', 'falsy']).optional(),
  })
  .refine(
    (cond) => [cond.equals, cond.in, cond.is].filter((operator) => operator !== undefined).length === 1,
    'must set exactly one of "equals", "in" or "is"',
  );

const conditionalRolesSchema = z.strictObject({
  default: roleListSchema,
  when: z.array(z.strictObject({ condition: roleConditionSchema, roles: roleListSchema })),
});

const argumentRoleSpecSchema = z.union([roleListSchema, conditionalRolesSchema]);

const storedToolAnnotationSchema = z
  .looseObject({
    toolName: z.string(),
    serverName: z.string().optional(),
    comment: z.string().optional(),
    args: ownKeyRecord(argumentRoleSpecSchema),
    // Captured for the compiler's scenario checks; the engine does not read it.
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((tool, ctx) => {
    // The annotator's rule: a condition names another annotated argument of
    // the same tool. A misspelled name never sees a value, so `is: "absent"`
    // or `"falsy"` would apply its narrowed roles to every call.
    for (const [argName, spec] of Object.entries(tool.args)) {
      if (Array.isArray(spec)) continue;
      spec.when.forEach((entry, index) => {
        if (!Object.hasOwn(tool.args, entry.condition.arg)) {
          ctx.addIssue({
            code: 'custom',
            path: ['args', argName, 'when', index, 'condition', 'arg'],
            message: `names no annotated argument of this tool (${JSON.stringify(entry.condition.arg)})`,
          });
        }
      });
    }
  });

const storedServerAnnotationsSchema = z
  .looseObject({
    inputHash: z.string(),
    contentDigest: z.string().optional(),
    source: z.enum(['user', 'package']).optional(),
    producerVersion: z.string().optional(),
    pinned: z.boolean().optional(),
    supersededDigests: stringListSchema.optional(),
    // The release the server reported when the entry was written. Drift
    // reports display it, so a damaged value is refused, not shown.
    serverInfo: z.looseObject({ name: z.string(), version: z.string() }).optional(),
    tools: z.array(storedToolAnnotationSchema),
  })
  .superRefine((entry, ctx) => {
    // The engine keys annotations by tool name; a second entry would
    // silently replace the first.
    const firstIndex = new Map<string, number>();
    entry.tools.forEach((tool, index) => {
      const first = firstIndex.get(tool.toolName);
      if (first === undefined) {
        firstIndex.set(tool.toolName, index);
        return;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['tools', index, 'toolName'],
        message: `annotates ${JSON.stringify(tool.toolName)} a second time (first at tools[${first}])`,
      });
    });
  });

const storedToolAnnotationsFileSchema = z.looseObject({
  generatedAt: z.string().optional(),
  servers: ownKeyRecord(storedServerAnnotationsSchema),
});

// ---------------------------------------------------------------------------
// Problem reporting
// ---------------------------------------------------------------------------

/** At most this many problems are listed in one error; the rest are counted. */
const MAX_LISTED_PROBLEMS = 20;
/** Longest rendering of an offending string value. */
const MAX_VALUE_LENGTH = 60;
/** Longest rendering of one problem line (room for the full list of argument roles). */
const MAX_PROBLEM_LENGTH = 500;

const IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `rules[3].if.paths`, `lists["a b"].values`; `(top level)` for the root. */
function formatFieldPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
      continue;
    }
    const key = typeof segment === 'symbol' ? segment.toString() : segment;
    if (IDENTIFIER_SEGMENT.test(key)) {
      out += out === '' ? key : `.${key}`;
    } else {
      out += `[${JSON.stringify(key)}]`;
    }
  }
  return out === '' ? '(top level)' : out;
}

function withArticle(noun: string): string {
  const shown = noun === 'record' ? 'object' : noun;
  return /^[aeiou]/.test(shown) ? `an ${shown}` : `a ${shown}`;
}

/** A short rendering of an offending value: strings quoted (and cut), containers by kind. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value);
    case 'number':
    case 'boolean':
      return String(value);
    case 'object':
      return 'an object';
    default:
      return typeof value;
  }
}

/** A union option that failed on the value's own type (an array offered to the object option, say). */
function isTypeMismatch(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some((issue) => issue.code === 'invalid_type' && issue.path.length === 0);
}

function describeIssue(issue: z.core.$ZodIssue, base: readonly PropertyKey[]): string[] {
  const path = [...base, ...issue.path];
  const where = formatFieldPath(path);
  switch (issue.code) {
    case 'unrecognized_keys':
      return issue.keys.map((key) => `${formatFieldPath([...path, key])}: unknown field`);
    case 'invalid_type':
      return [
        issue.input === undefined
          ? `${where}: missing (expected ${withArticle(issue.expected)})`
          : `${where}: expected ${withArticle(issue.expected)}, got ${describeValue(issue.input)}`,
      ];
    case 'invalid_value': {
      // The offending value first: a long list of options (the argument
      // roles) is what gets cut when the line is too long.
      const options = issue.values.map((value) => JSON.stringify(value)).join(', ');
      const expected = issue.values.length === 1 ? options : `one of ${options}`;
      return [
        issue.input === undefined
          ? `${where}: missing (expected ${expected})`
          : `${where}: ${describeValue(issue.input)} is not ${expected}`,
      ];
    }
    case 'invalid_union': {
      // Report the option the value's type selected (an array of roles vs a
      // conditional block); when none matches, name the accepted types.
      const candidates = issue.errors.filter((issues) => !isTypeMismatch(issues));
      if (candidates.length > 0) return candidates.flat().flatMap((nested) => describeIssue(nested, path));
      const accepted = new Set<string>();
      for (const nested of issue.errors.flat()) {
        if (nested.code === 'invalid_type' && nested.path.length === 0) accepted.add(withArticle(nested.expected));
      }
      return [`${where}: expected ${[...accepted].join(' or ') || 'another value'}, got ${describeValue(issue.input)}`];
    }
    default:
      return [`${where}: ${issue.message}`];
  }
}

/**
 * One line per problem, in the order zod found them, duplicates removed.
 * `base` prefixes every field path (the server name, for an entry of
 * mcp-servers.json validated on its own).
 */
export function describeSchemaIssues(issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[] = []): string[] {
  return [...new Set(issues.flatMap((issue) => describeIssue(issue, base)))];
}

/** The field path {@link describeSchemaIssues} prints: `git.env.TOKEN`, `servers["a b"]`. */
export function formatSchemaFieldPath(path: readonly PropertyKey[]): string {
  return formatFieldPath(path);
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return describeSchemaIssues(issues);
}

/**
 * Formats a heading and its problems as a multi-line error message. Lines
 * are made safe for a terminal (control and bidi characters escaped) and
 * bounded in number and length.
 */
export function formatArtifactProblems(heading: string, problems: readonly string[]): string {
  const lines = problems
    .slice(0, MAX_LISTED_PROBLEMS)
    .map((problem) => `  - ${toDisplayText(problem, { maxLength: MAX_PROBLEM_LENGTH })}`);
  if (problems.length > MAX_LISTED_PROBLEMS) {
    lines.push(`  - ... and ${problems.length - MAX_LISTED_PROBLEMS} more`);
  }
  return `${toDisplayText(heading)}:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `POLICY_ARTIFACT_INVALID`: a compiled-policy.json or dynamic-lists.json
 * exists but is not JSON or does not match its schema. Callers across module
 * boundaries should test `code`, not `instanceof`. (A malformed
 * tool-annotations.json throws `TOOL_ANNOTATIONS_INVALID` from
 * `src/config/tool-annotations-overlay.ts` instead.)
 */
export const POLICY_ARTIFACT_INVALID = 'POLICY_ARTIFACT_INVALID';

export type PolicyArtifactKind = 'compiled-policy' | 'dynamic-lists';

const ARTIFACT_LABELS: Readonly<Record<PolicyArtifactKind, string>> = {
  'compiled-policy': 'compiled policy',
  'dynamic-lists': 'dynamic lists file',
};

export class PolicyArtifactError extends Error {
  readonly code = POLICY_ARTIFACT_INVALID;
  readonly artifact: PolicyArtifactKind;
  /** The file that failed to load. */
  readonly path: string;
  /** One line per problem, each naming the offending field. */
  readonly problems: readonly string[];

  constructor(artifact: PolicyArtifactKind, path: string, problems: readonly string[], options?: ErrorOptions) {
    super(formatArtifactProblems(`${path} is not a valid ${ARTIFACT_LABELS[artifact]}`, problems), options);
    this.name = 'PolicyArtifactError';
    this.artifact = artifact;
    this.path = path;
    this.problems = problems;
  }
}

/**
 * Which artifact a {@link PolicyArtifactError} is about, or undefined for
 * any other error. Tests the error code, not the class.
 */
export function invalidPolicyArtifact(err: unknown): PolicyArtifactKind | undefined {
  if (!isObjectWithProp(err, 'code') || err.code !== POLICY_ARTIFACT_INVALID) return undefined;
  if (!isObjectWithProp(err, 'artifact')) return undefined;
  return err.artifact === 'compiled-policy' || err.artifact === 'dynamic-lists' ? err.artifact : undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses an artifact's JSON text. A syntax error becomes a
 * {@link PolicyArtifactError} that names the file.
 */
export function parseArtifactJson(text: string, artifact: PolicyArtifactKind, path: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (err) {
    throw new PolicyArtifactError(
      artifact,
      path,
      [`not valid JSON (${err instanceof Error ? err.message : String(err)})`],
      { cause: err },
    );
  }
}

/**
 * Validates a parsed compiled-policy.json. Returns the validated copy;
 * throws {@link PolicyArtifactError} listing every offending field.
 */
export function parseCompiledPolicyFile(value: unknown, path: string): CompiledPolicyFile {
  const result = compiledPolicyFileSchema.safeParse(value, { reportInput: true });
  if (!result.success) throw new PolicyArtifactError('compiled-policy', path, describeIssues(result.error.issues));
  return result.data;
}

/**
 * Validates the rules and list definitions of a per-server compiled policy
 * from the pipeline's compile cache against the compiled-policy.json
 * schema. Cached rules are merged into compiled-policy.json without being
 * compiled again, so a hand-edited or corrupted cache file would otherwise
 * produce a policy the runtime loaders refuse, and every unchanged recompile
 * would write it again. Throws {@link PolicyArtifactError} listing every
 * offending field.
 */
export function assertServerPolicyRules(value: unknown, path: string): void {
  const result = serverPolicyRulesSchema.safeParse(value, { reportInput: true });
  if (!result.success) throw new PolicyArtifactError('compiled-policy', path, describeIssues(result.error.issues));
}

/**
 * Validates a parsed dynamic-lists.json. Returns the validated copy with
 * missing `manualAdditions` / `manualRemovals` filled in as empty arrays;
 * throws {@link PolicyArtifactError} listing every offending field.
 */
export function parseDynamicListsFile(value: unknown, path: string): DynamicListsFile {
  const result = dynamicListsFileSchema.safeParse(value, { reportInput: true });
  if (!result.success) throw new PolicyArtifactError('dynamic-lists', path, describeIssues(result.error.issues));
  return result.data;
}

/**
 * The problems that keep a parsed tool-annotations.json from loading, one
 * line per offending field; empty when the file is valid. The annotations
 * loader (`src/config/tool-annotations-overlay.ts`) turns them into its own
 * coded error and returns the parsed file unchanged, so content digests and
 * overlay rewrites see exactly what is on disk.
 */
export function toolAnnotationsFileProblems(value: unknown): string[] {
  const result = storedToolAnnotationsFileSchema.safeParse(value, { reportInput: true });
  return result.success ? [] : describeIssues(result.error.issues);
}
