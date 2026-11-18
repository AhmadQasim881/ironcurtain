/**
 * The values policy reads from an annotated tool-call argument.
 *
 * Role annotations are per top-level argument, and an argument value is
 * evaluated as a list of strings: a path, a URL, an identifier, or a list of
 * them. An argument can also hold something else: an object or an array of
 * objects (the inputSchema of `gsheets_add_protected_range.editors` is
 * `{users: string[], groups: string[], ...}`), a nested array, a boolean.
 * Extraction used to yield no values for such an argument, so every check
 * that reads values (protected paths, sandbox containment, the domain gate,
 * compiled `paths`/`domains`/`lists` conditions) silently saw nothing there.
 *
 * {@link argumentValues} never yields nothing for a present value. A value
 * that is not a plain list of strings is reported as `structured`, with
 * every string and number found inside it as its values, so the deny-side
 * checks still judge each of them; the policy engine then escalates the call
 * to a human (`structural-nested-argument-escalate`), because no per-value
 * decision can say what the structure means to the server.
 */

/** What {@link argumentValues} found in one argument value. */
export interface ArgumentValues {
  /**
   * The strings policy evaluates: the value itself, the elements of a flat
   * array, or, for a structured value, every string and number inside it at
   * any depth (in document order). Numbers are given in decimal form.
   * Object keys are not included.
   */
  readonly values: readonly string[];
  /**
   * True when the value is present but is not a string, a finite number or
   * an array of those: an object, an array with any other element, a
   * boolean, a non-finite number. Policy cannot evaluate such a value one
   * value at a time.
   */
  readonly structured: boolean;
}

const ABSENT: ArgumentValues = Object.freeze({ values: [], structured: false });

/** A string or finite number as policy compares it; undefined for anything else. */
function scalarValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Every string and finite number inside `value`, depth first in document
 * order. Iterative, so a deeply nested value cannot exhaust the stack, and a
 * value already visited is skipped (a cyclic in-process object terminates).
 */
function leafValues(value: unknown): string[] {
  const leaves: string[] = [];
  const visited = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    const scalar = scalarValue(item);
    if (scalar !== undefined) {
      leaves.push(scalar);
      continue;
    }
    if (typeof item !== 'object' || item === null || visited.has(item)) continue;
    visited.add(item);
    const children: unknown[] = Array.isArray(item) ? item : Object.values(item);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return leaves;
}

/**
 * True when `value` is present but is not a string, a finite number or an
 * array of those ({@link ArgumentValues.structured}), without collecting
 * anything.
 */
export function isStructuredValue(value: unknown): boolean {
  if (value === undefined || value === null || scalarValue(value) !== undefined) return false;
  return !(Array.isArray(value) && (value as unknown[]).every((element) => scalarValue(element) !== undefined));
}

/**
 * The values of one argument value (see {@link ArgumentValues}): nothing for
 * an absent value (`undefined` or `null`), the value for a string or finite
 * number, the elements of an array of those, and otherwise every string and
 * number inside it, flagged `structured`.
 */
export function argumentValues(value: unknown): ArgumentValues {
  if (value === undefined || value === null) return ABSENT;
  if (isStructuredValue(value)) return { values: leafValues(value), structured: true };
  // A scalar or an array of scalars: every element converts.
  const values: string[] = [];
  for (const element of Array.isArray(value) ? (value as unknown[]) : [value]) {
    const scalar = scalarValue(element);
    if (scalar !== undefined) values.push(scalar);
  }
  return { values, structured: false };
}

/**
 * The value of the call argument `name`, read as an own property only, so an
 * argument the call does not pass never resolves to an inherited member such
 * as `constructor`.
 */
export function ownArgument(args: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(args, name) ? args[name] : undefined;
}
