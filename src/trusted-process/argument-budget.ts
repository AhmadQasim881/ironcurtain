/** Cheap, shared admission limits before synchronous resource normalization. */
import type { ArgumentRoleSpec, StoredToolAnnotation } from '../pipeline/types.js';
import { getRoleDefinition } from '../types/argument-roles.js';

export interface ArgumentValueLimits {
  readonly maxValuesPerArgument: number;
  readonly maxValuesPerCall: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxResourceChars: number;
  readonly maxValueChars: number;
}

export const ARGUMENT_VALUE_LIMITS: ArgumentValueLimits = Object.freeze({
  maxValuesPerArgument: 256,
  maxValuesPerCall: 1024,
  maxNodes: 4096,
  maxDepth: 32,
  maxResourceChars: 256 * 1024,
  maxValueChars: 16 * 1024,
});

export const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const BUDGET_CODE = 'TOOL_ARGUMENT_BUDGET_EXCEEDED';
const REASON = 'Tool arguments exceed the resource evaluation limits';
export const ARGUMENT_BUDGET_DENY_RESULT = Object.freeze({
  decision: 'deny' as const,
  rule: 'structural-argument-budget-deny',
  reason: REASON,
});

class ArgumentBudgetError extends Error {
  readonly code = BUDGET_CODE;
  constructor() {
    super(REASON);
    this.name = 'ArgumentBudgetError';
  }
}

export function isArgumentBudgetError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === BUDGET_CODE;
}

/** Trusted callers may tighten the defaults, never raise them. */
function limit(overrides: Partial<ArgumentValueLimits>, name: keyof ArgumentValueLimits): number {
  const value = overrides[name];
  return value === undefined || !Number.isFinite(value)
    ? ARGUMENT_VALUE_LIMITS[name]
    : Math.max(1, Math.min(ARGUMENT_VALUE_LIMITS[name], Math.floor(value)));
}

function rolesOf(spec: ArgumentRoleSpec): readonly string[] {
  return Array.isArray(spec) ? spec : spec.default;
}

/**
 * Bound the whole JSON argument object before recursive audit redaction or
 * backend schema validation, including fields with no policy role. Count each
 * occurrence, as a JSON serializer would. Checking depth before descending
 * bounds the call stack even for a cyclic object from an in-process caller.
 */
export function hasBoundedArgumentStructure(args: Record<string, unknown>): boolean {
  let remaining = ARGUMENT_VALUE_LIMITS.maxNodes;
  function visit(value: unknown, depth: number): boolean {
    if (depth > ARGUMENT_VALUE_LIMITS.maxDepth || --remaining < 0) return false;
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) {
      if (value.length > remaining) return false;
      for (const child of value) {
        if (!visit(child, depth + 1)) return false;
      }
    } else {
      const record = value as Record<string, unknown>;
      for (const key in record) {
        if (Object.hasOwn(record, key) && !visit(record[key], depth + 1)) return false;
      }
    }
    return true;
  }
  return visit(args, 0);
}

/**
 * Bounds policy-bearing values before conditional-role resolution, extraction
 * or filesystem work. Conditional defaults contain every narrower role.
 * Iterative traversal also bounds structured arguments and terminates cycles.
 */
export function assertArgumentValueBudget(
  args: Record<string, unknown>,
  annotation: Pick<StoredToolAnnotation, 'args'>,
  overrides: Partial<ArgumentValueLimits> = {},
): void {
  const perArgument = limit(overrides, 'maxValuesPerArgument');
  const perCall = limit(overrides, 'maxValuesPerCall');
  const nodeLimit = limit(overrides, 'maxNodes');
  const depthLimit = limit(overrides, 'maxDepth');
  const charLimit = limit(overrides, 'maxResourceChars');
  const valueLimit = limit(overrides, 'maxValueChars');
  let nodes = 0;
  let values = 0;
  let chars = 0;
  for (const [name, spec] of Object.entries(annotation.args)) {
    const roles = rolesOf(spec);
    if (!roles.some((role) => role !== 'none')) continue;
    const resource = (Array.isArray(spec) ? spec : spec.default).some(
      (role) => getRoleDefinition(role).isResourceIdentifier,
    );
    const pending = [{ value: Object.hasOwn(args, name) ? args[name] : undefined, depth: 0 }];
    const seen = new Set<object>();
    let argumentValues = 0;
    for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
      const { value, depth } = entry;
      if (depth > depthLimit) throw new ArgumentBudgetError();
      if (++nodes > nodeLimit) throw new ArgumentBudgetError();
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
        if (++argumentValues > perArgument || ++values > perCall) throw new ArgumentBudgetError();
        if (resource) {
          const length = typeof value === 'string' ? value.length : String(value).length;
          chars += length;
          if (length > valueLimit || chars > charLimit) throw new ArgumentBudgetError();
        }
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      // Direct engine callers can pass non-JSON objects. Reject repeated
      // references too, so later recursive extractors never encounter cycles.
      if (seen.has(value)) throw new ArgumentBudgetError();
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > perArgument || value.length + nodes + pending.length > nodeLimit) {
          throw new ArgumentBudgetError();
        }
        for (const child of value) pending.push({ value: child, depth: depth + 1 });
      } else {
        const record = value as Record<string, unknown>;
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue;
          if (nodes + pending.length >= nodeLimit) throw new ArgumentBudgetError();
          pending.push({ value: record[key], depth: depth + 1 });
        }
      }
    }
  }
}

/** Check serialized Code Mode arguments before parsing their JSON on the host. */
export function boundedToolArgumentsJson(value: unknown, maxBytes = MAX_TOOL_ARGUMENT_BYTES): string {
  const cap = Number.isFinite(maxBytes)
    ? Math.max(1, Math.min(maxBytes, MAX_TOOL_ARGUMENT_BYTES))
    : MAX_TOOL_ARGUMENT_BYTES;
  if (typeof value !== 'string') throw new TypeError('Tool arguments must be JSON text');
  if (value.length > cap || Buffer.byteLength(value, 'utf8') > cap) throw new ArgumentBudgetError();
  return value;
}
