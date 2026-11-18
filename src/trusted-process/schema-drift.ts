/**
 * Live-schema drift detection for tool annotations.
 *
 * `tool-annotations.json` classifies every argument of every tool with the
 * roles the policy engine evaluates, and stores the tool's input schema as
 * the server exposed it when the annotation was written. A server release
 * that renames, adds or removes an argument, or changes an enum or the
 * required list, silently changes what policy evaluates: an argument the
 * annotation does not classify is invisible to the engine, the whitelist and
 * the auto-approver (the pipeline denies such calls, rule
 * `unannotated-arguments`), a renamed discriminator makes every conditional
 * role fall back to its default, and a removed argument makes calls that
 * still use it fail at the server's own validation.
 *
 * This module compares a stored annotation with the schema a live server
 * reports (`tools/list`) and names each kind of drift. It is a leaf: the
 * coordinator runs it when a server registers its tools; `doctor`, the
 * `annotate-tools --check` mode and `compile-policy` run it offline. No
 * pipeline value is imported here (type-only contracts excepted) so the live
 * runtime path stays free of pipeline code.
 *
 * Tool and argument names come from the server, so every rendered line
 * passes them through `toDisplayText` before they can reach a terminal.
 */

import type { StoredToolAnnotation } from '../pipeline/types.js';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { isConditionalRoles } from '../types/argument-roles.js';

/** A tool as a live server lists it: only the fields the drift check reads. */
export interface LiveToolSchema {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
}

/** An argument whose enum of accepted values changed. */
export interface EnumChange {
  readonly arg: string;
  /** Live values the stored schema did not list (as JSON text). */
  readonly added: readonly string[];
  /** Stored values the live schema no longer lists (as JSON text). */
  readonly removed: readonly string[];
}

/** Drift of one annotated tool against the live schema of the same tool. */
export interface ToolSchemaDrift {
  readonly toolName: string;
  /**
   * Live arguments without an `args` entry in the annotation. The main
   * security signal: policy cannot evaluate them, and the pipeline denies
   * calls that carry them.
   */
  readonly unannotatedArgs: readonly string[];
  /** Annotated arguments the live schema no longer declares; calls using them fail at the server. */
  readonly removedArgs: readonly string[];
  /**
   * Conditional role specs whose condition names an argument the live
   * schema lacks, or a value outside the live enum of that argument. Such
   * conditions never match, so the argument always gets its default roles.
   */
  readonly brokenDiscriminators: readonly string[];
  /** Enum changes on any argument (new values fall back to default roles). */
  readonly enumChanges: readonly EnumChange[];
  /** Change of the `required` list, when any. */
  readonly requiredChange?: { readonly added: readonly string[]; readonly removed: readonly string[] };
  /** The canonical hashes of the stored and live input schemas differ. */
  readonly schemaChanged: boolean;
  readonly storedSchemaHash: string;
  readonly liveSchemaHash: string;
}

/** Drift of one server's annotations against its live tool list. */
export interface ServerSchemaDrift {
  readonly serverName: string;
  /** Live tools with no annotation (denied, rule `missing-annotation`). */
  readonly unannotatedTools: readonly string[];
  /** Annotated tools the server no longer exposes. */
  readonly staleTools: readonly string[];
  /** Per-tool drift, only for tools where {@link hasToolDrift} holds, in live order. */
  readonly tools: readonly ToolSchemaDrift[];
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const props = schema.properties;
  return isRecord(props) ? props : {};
}

function schemaRequired(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const required = schema.required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : [];
}

/** The enum of a property as JSON text, or undefined when it has none. */
function propertyEnum(property: unknown): string[] | undefined {
  if (!isRecord(property) || !Array.isArray(property.enum)) return undefined;
  return property.enum.map((value) => JSON.stringify(value));
}

function sortedDifference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a.filter((item) => !other.has(item)))].sort();
}

/**
 * sha256 (hex) of the canonical JSON of a tool input schema. Unlike the
 * annotator's `inputHash`, it covers one schema only (no descriptions of
 * other tools, no prompt text), so it identifies exactly the schema the
 * policy engine's argument checks depend on.
 */
export function canonicalSchemaHash(schema: unknown): string {
  return canonicalDigest(schema);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compares a stored annotation with the live schema of the same tool.
 * Pure: reads both inputs, allocates the result, touches nothing else.
 */
export function diffToolSchema(stored: StoredToolAnnotation, live: LiveToolSchema): ToolSchemaDrift {
  const liveProps = schemaProperties(live.inputSchema);
  const storedProps = schemaProperties(stored.inputSchema);
  const liveArgNames = Object.keys(liveProps);
  const annotatedArgNames = Object.keys(stored.args);

  const unannotatedArgs = sortedDifference(liveArgNames, annotatedArgNames);
  const removedArgs = sortedDifference(annotatedArgNames, liveArgNames);

  const brokenDiscriminators: string[] = [];
  for (const [arg, spec] of Object.entries(stored.args)) {
    if (!isConditionalRoles(spec)) continue;
    for (const { condition } of spec.when) {
      if (!Object.hasOwn(liveProps, condition.arg)) {
        brokenDiscriminators.push(`${arg}: condition on unknown argument ${JSON.stringify(condition.arg)}`);
        continue;
      }
      const liveEnum = propertyEnum(liveProps[condition.arg]);
      if (liveEnum === undefined) continue;
      const values = condition.in ?? (condition.equals !== undefined ? [condition.equals] : []);
      for (const value of values) {
        if (!liveEnum.includes(JSON.stringify(value))) {
          brokenDiscriminators.push(`${arg}: ${condition.arg}=${JSON.stringify(value)} is not a live value`);
        }
      }
    }
  }

  const enumChanges: EnumChange[] = [];
  for (const arg of liveArgNames.slice().sort()) {
    if (!Object.hasOwn(storedProps, arg)) continue;
    const liveEnum = propertyEnum(liveProps[arg]) ?? [];
    const storedEnum = propertyEnum(storedProps[arg]) ?? [];
    const added = sortedDifference(liveEnum, storedEnum);
    const removed = sortedDifference(storedEnum, liveEnum);
    if (added.length > 0 || removed.length > 0) enumChanges.push({ arg, added, removed });
  }

  const liveRequired = schemaRequired(live.inputSchema);
  const storedRequired = schemaRequired(stored.inputSchema);
  const requiredAdded = sortedDifference(liveRequired, storedRequired);
  const requiredRemoved = sortedDifference(storedRequired, liveRequired);

  const storedSchemaHash = canonicalSchemaHash(stored.inputSchema);
  const liveSchemaHash = canonicalSchemaHash(live.inputSchema);

  return {
    toolName: live.name,
    unannotatedArgs,
    removedArgs,
    brokenDiscriminators,
    enumChanges,
    ...(requiredAdded.length > 0 || requiredRemoved.length > 0
      ? { requiredChange: { added: requiredAdded, removed: requiredRemoved } }
      : {}),
    schemaChanged: storedSchemaHash !== liveSchemaHash,
    storedSchemaHash,
    liveSchemaHash,
  };
}

/** True when the tool drifted in any way, a changed schema text included. */
export function hasToolDrift(drift: ToolSchemaDrift): boolean {
  return affectsPolicy(drift) || drift.requiredChange !== undefined || drift.schemaChanged;
}

/**
 * True when the drift changes what policy evaluates: arguments it cannot
 * see, arguments it classifies that no longer exist, dead conditions or
 * changed enums. A changed description or `required` list alone does not.
 */
export function affectsPolicy(drift: ToolSchemaDrift): boolean {
  return (
    drift.unannotatedArgs.length > 0 ||
    drift.removedArgs.length > 0 ||
    drift.brokenDiscriminators.length > 0 ||
    drift.enumChanges.length > 0
  );
}

/**
 * Compares every annotation of a server with the server's live tool list.
 * Tools present on both sides are diffed with {@link diffToolSchema}; only
 * the drifted ones are reported.
 */
export function diffServerSchemas(
  serverName: string,
  annotated: readonly StoredToolAnnotation[],
  live: readonly LiveToolSchema[],
): ServerSchemaDrift {
  const byName = new Map(annotated.map((tool) => [tool.toolName, tool]));
  const liveNames = new Set(live.map((tool) => tool.name));
  const tools: ToolSchemaDrift[] = [];
  for (const tool of live) {
    const stored = byName.get(tool.name);
    if (!stored) continue;
    const drift = diffToolSchema(stored, tool);
    if (hasToolDrift(drift)) tools.push(drift);
  }
  return {
    serverName,
    unannotatedTools: [...liveNames].filter((name) => !byName.has(name)).sort(),
    staleTools: [...byName.keys()].filter((name) => !liveNames.has(name)).sort(),
    tools,
  };
}

/** True when the server's annotations differ from its live tools in any way. */
export function hasServerDrift(drift: ServerSchemaDrift): boolean {
  return drift.unannotatedTools.length > 0 || drift.staleTools.length > 0 || drift.tools.length > 0;
}

/**
 * True when the drift changes what policy evaluates for some call: a live
 * tool without an annotation (denied) or a tool whose drift
 * {@link affectsPolicy}. Stale annotations and schema text alone do not.
 */
export function serverDriftAffectsPolicy(drift: ServerSchemaDrift): boolean {
  return drift.unannotatedTools.length > 0 || drift.tools.some(affectsPolicy);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** A server-provided name (tool, argument, enum value) as safe display text. */
function shown(name: string): string {
  return toDisplayText(name, { maxLength: 120 });
}

/** The command that refreshes a server's annotations. */
export function annotateCommandFor(serverName: string): string {
  const name = /^[A-Za-z0-9._-]+$/.test(serverName) ? serverName : JSON.stringify(serverName);
  return `ironcurtain annotate-tools --server ${shown(name)}`;
}

function list(items: readonly string[], max = 6): string {
  const shownItems = items.slice(0, max).map(shown).join(', ');
  return items.length > max ? `${shownItems} (and ${items.length - max} more)` : shownItems;
}

function describeToolDrift(drift: ToolSchemaDrift): string {
  const parts: string[] = [];
  if (drift.unannotatedArgs.length > 0) parts.push(`unannotated: ${list(drift.unannotatedArgs)}`);
  if (drift.removedArgs.length > 0) parts.push(`removed: ${list(drift.removedArgs)}`);
  if (drift.brokenDiscriminators.length > 0) parts.push(`dead conditions: ${list(drift.brokenDiscriminators, 3)}`);
  for (const change of drift.enumChanges) {
    const detail = [
      ...change.added.map((value) => `+${shown(value)}`),
      ...change.removed.map((value) => `-${shown(value)}`),
    ].join(' ');
    parts.push(`enum ${shown(change.arg)}: ${detail}`);
  }
  if (drift.requiredChange) {
    const { added, removed } = drift.requiredChange;
    parts.push(`required: ${[...added.map((a) => `+${shown(a)}`), ...removed.map((r) => `-${shown(r)}`)].join(', ')}`);
  }
  if (parts.length === 0 && drift.schemaChanged) parts.push('schema text changed');
  return `${shown(drift.toolName)} (${parts.join('; ')})`;
}

/**
 * One line summarizing a server's drift, for status lines and log entries.
 * Names the drifted tools and what changed on each; empty when nothing drifted.
 */
export function summarizeServerDrift(drift: ServerSchemaDrift): string {
  const parts: string[] = [];
  if (drift.unannotatedTools.length > 0) {
    parts.push(`${drift.unannotatedTools.length} unannotated tool(s): ${list(drift.unannotatedTools)}`);
  }
  if (drift.staleTools.length > 0) {
    parts.push(`${drift.staleTools.length} stale annotation(s): ${list(drift.staleTools)}`);
  }
  if (drift.tools.length > 0) {
    parts.push(`${drift.tools.length} tool(s) changed: ${drift.tools.slice(0, 4).map(describeToolDrift).join(', ')}`);
    if (drift.tools.length > 4) parts.push(`and ${drift.tools.length - 4} more changed tool(s)`);
  }
  return parts.join('; ');
}

/** The remedy for a drifted server, as one sentence. */
export function driftRemedy(serverName: string): string {
  return `Run \`${annotateCommandFor(serverName)}\`, review the result and recompile the policy.`;
}

/**
 * The message and remedy of a drift notification, for transports that show
 * one line per drifted server (diagnostic events, status rows).
 */
export function describeDriftNotice(drift: ServerSchemaDrift): { readonly message: string; readonly hint: string } {
  const consequence = serverDriftAffectsPolicy(drift)
    ? 'calls using the changes are denied or evaluated under default roles'
    : 'no policy effect';
  return {
    message:
      `tool annotations for MCP server ${shown(JSON.stringify(drift.serverName))} do not match its live tools ` +
      `(${summarizeServerDrift(drift)}); ${consequence}`,
    hint: driftRemedy(drift.serverName),
  };
}

/**
 * The full report for a server's drift as lines for a terminal or a log:
 * what drifted, what each kind of drift means for policy, and the command
 * that fixes it. Empty when nothing drifted.
 */
export function describeServerDrift(drift: ServerSchemaDrift): string[] {
  if (!hasServerDrift(drift)) return [];
  const lines: string[] = [];
  const server = shown(JSON.stringify(drift.serverName));
  lines.push(`Tool annotations for MCP server ${server} do not match the tools the server exposes:`);
  if (drift.unannotatedTools.length > 0) {
    lines.push(
      `  ${drift.unannotatedTools.length} live tool(s) have no annotation and are denied: ${list(drift.unannotatedTools, 10)}`,
    );
  }
  if (drift.staleTools.length > 0) {
    lines.push(`  ${drift.staleTools.length} annotated tool(s) are no longer exposed: ${list(drift.staleTools, 10)}`);
  }
  for (const tool of drift.tools) {
    lines.push(`  ${describeToolDrift(tool)}`);
  }
  if (drift.tools.some((tool) => tool.unannotatedArgs.length > 0)) {
    lines.push('  Calls carrying an unannotated argument are denied (policy cannot evaluate it).');
  }
  if (
    drift.tools.some((tool) => tool.brokenDiscriminators.length > 0 || tool.enumChanges.some((c) => c.added.length > 0))
  ) {
    lines.push('  Conditional roles keyed on changed discriminators fall back to their most restrictive default.');
  }
  lines.push(`  ${driftRemedy(drift.serverName)}`);
  return lines;
}
