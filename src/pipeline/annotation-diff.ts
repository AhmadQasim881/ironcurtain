/**
 * Role diff for `annotate-tools --diff` (offline tooling only).
 *
 * Tool annotations are TCB data: every role decides how the policy engine
 * treats an argument, and every change must be reviewed. The diff lists, per
 * server, the tools whose roles (or one-sentence comment) changed between
 * the annotations in effect before a run and those in effect after it, so a
 * reviewer reads the changes instead of the whole file.
 */

import { canonicalJson } from '../policy-artifacts/canonical-json.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import type { ArgumentRoleSpec, RoleCondition, StoredToolAnnotation } from './types.js';

/** One argument whose roles differ. */
export interface ArgumentRoleChange {
  readonly arg: string;
  /** Absent: the argument had no roles before. */
  readonly before?: ArgumentRoleSpec;
  /** Absent: the argument has no roles any more. */
  readonly after?: ArgumentRoleSpec;
}

export type ToolAnnotationChange =
  | { readonly kind: 'added'; readonly toolName: string; readonly after: StoredToolAnnotation }
  | { readonly kind: 'removed'; readonly toolName: string }
  | {
      readonly kind: 'changed';
      readonly toolName: string;
      readonly args: readonly ArgumentRoleChange[];
      readonly commentChanged: boolean;
    };

export interface AnnotationDiff {
  /** Added and changed tools in the order of `after`, then removed tools in the order of `before`. */
  readonly changes: readonly ToolAnnotationChange[];
  /** Tools present before and after with the same roles and comment. */
  readonly unchanged: number;
}

function sameSpec(a: ArgumentRoleSpec | undefined, b: ArgumentRoleSpec | undefined): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function ownArgs(annotation: StoredToolAnnotation): Map<string, ArgumentRoleSpec> {
  return new Map(Object.entries(annotation.args));
}

/**
 * Compares two annotation sets of one server tool by tool. Only roles and
 * comments count: a re-annotation that kept every role (a changed input
 * schema, a new `annotationKey`) is unchanged.
 */
export function diffToolAnnotations(
  before: readonly StoredToolAnnotation[],
  after: readonly StoredToolAnnotation[],
): AnnotationDiff {
  const beforeByName = new Map(before.map((a) => [a.toolName, a]));
  const afterNames = new Set(after.map((a) => a.toolName));
  const changes: ToolAnnotationChange[] = [];
  let unchanged = 0;

  for (const next of after) {
    const previous = beforeByName.get(next.toolName);
    if (!previous) {
      changes.push({ kind: 'added', toolName: next.toolName, after: next });
      continue;
    }
    const previousArgs = ownArgs(previous);
    const nextArgs = ownArgs(next);
    const args: ArgumentRoleChange[] = [];
    for (const [arg, spec] of nextArgs) {
      const old = previousArgs.get(arg);
      if (!sameSpec(old, spec)) args.push({ arg, ...(old !== undefined ? { before: old } : {}), after: spec });
    }
    for (const [arg, old] of previousArgs) {
      if (!nextArgs.has(arg)) args.push({ arg, before: old });
    }
    const commentChanged = previous.comment !== next.comment;
    if (args.length === 0 && !commentChanged) {
      unchanged++;
    } else {
      changes.push({ kind: 'changed', toolName: next.toolName, args, commentChanged });
    }
  }
  for (const previous of before) {
    if (!afterNames.has(previous.toolName)) changes.push({ kind: 'removed', toolName: previous.toolName });
  }
  return { changes, unchanged };
}

function formatCondition(cond: RoleCondition): string {
  if (cond.equals !== undefined) return `${cond.arg}=${JSON.stringify(cond.equals)}`;
  if (cond.in !== undefined) return `${cond.arg} in ${JSON.stringify(cond.in)}`;
  if (cond.is !== undefined) return `${cond.arg} is ${cond.is}`;
  return `${cond.arg}=?`;
}

/** `[read-path, write-path]`, or `default=[...]; when mode="list" -> [...]` for conditional roles. */
export function formatRoleSpec(spec: ArgumentRoleSpec | undefined): string {
  if (spec === undefined) return '(none)';
  if (Array.isArray(spec)) return `[${spec.join(', ')}]`;
  const when = spec.when.map((w) => `when ${formatCondition(w.condition)} -> [${w.roles.join(', ')}]`);
  return [`default=[${spec.default.join(', ')}]`, ...when].join('; ');
}

const MAX_COMMENT_LENGTH = 160;

/**
 * Display lines for one server's diff, or none when nothing changed. Tool
 * and argument names and comments come from MCP servers and the LLM, so
 * every line is rendered display-safe.
 */
export function formatAnnotationDiff(serverLabel: string, diff: AnnotationDiff): string[] {
  if (diff.changes.length === 0) return [];
  const count = (kind: ToolAnnotationChange['kind']): number => diff.changes.filter((c) => c.kind === kind).length;
  const lines = [
    `${serverLabel}: ${count('changed')} changed, ${count('added')} added, ${count('removed')} removed, ` +
      `${diff.unchanged} unchanged`,
  ];
  for (const change of diff.changes) {
    switch (change.kind) {
      case 'added': {
        const comment = change.after.comment
          ? ` -- ${toDisplayText(change.after.comment, { maxLength: MAX_COMMENT_LENGTH })}`
          : '';
        lines.push(`  + ${change.toolName}${comment}`);
        for (const [arg, spec] of Object.entries(change.after.args)) {
          lines.push(`      ${arg}: ${formatRoleSpec(spec)}`);
        }
        if (Object.keys(change.after.args).length === 0) lines.push('      (no arguments)');
        break;
      }
      case 'removed':
        lines.push(`  - ${change.toolName}`);
        break;
      case 'changed':
        lines.push(`  ~ ${change.toolName}`);
        for (const { arg, before, after } of change.args) {
          lines.push(`      ${arg}: ${formatRoleSpec(before)} -> ${formatRoleSpec(after)}`);
        }
        if (change.commentChanged) lines.push('      (comment changed)');
        break;
    }
  }
  return lines.map((line) => toDisplayText(line));
}
