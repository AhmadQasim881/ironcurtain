/**
 * Tool Annotator -- LLM-driven classification of MCP tool capabilities.
 *
 * Given a set of MCP tool schemas from a server, the annotator uses an LLM
 * to classify each tool's argument roles. Results are processed in batches
 * with Zod schema validation and repair loops to ensure correctness.
 *
 * Each annotation records a per-tool key (name, description, input schema,
 * prompt and role-registry version); a tool whose key is unchanged keeps its
 * previous roles and comment, so a refresh after an upstream change sends
 * only the new and changed tools to the LLM.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
  ARGUMENT_ROLE_REGISTRY,
  extractDefaultRoles,
  getRolesForServer,
  isConditionalRoles,
  type ArgumentRole,
} from '../types/argument-roles.js';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { generateObjectWithRepair } from './generate-with-repair.js';
import type { McpToolHints, StoredToolAnnotation } from './types.js';

/** Default number of tools per LLM call. */
export const ANNOTATION_BATCH_SIZE = 25;

/**
 * Splits an array into chunks of at most `size` elements.
 * Returns the original array (wrapped) if it fits in one chunk.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError(`chunk size must be positive, got ${size}`);
  if (items.length <= size) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// Input type matching what MCP's listTools() returns
export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** The server's behaviour hints for the tool (MCP `ToolAnnotations`). */
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

/**
 * Copies the boolean behaviour hints the server declared for a tool. They are
 * stored so the policy lint can treat a tool the server marks as changing
 * state accordingly; values of any other type are ignored.
 */
export function extractMcpToolHints(tool: MCPToolSchema): McpToolHints | undefined {
  const { readOnlyHint, destructiveHint } = tool.annotations ?? {};
  const hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {};
  if (typeof readOnlyHint === 'boolean') hints.readOnlyHint = readOnlyHint;
  if (typeof destructiveHint === 'boolean') hints.destructiveHint = destructiveHint;
  return Object.keys(hints).length > 0 ? hints : undefined;
}

// ---------------------------------------------------------------------------
// Roles on structured arguments
// ---------------------------------------------------------------------------

/**
 * An annotated argument that carries a role other than `none` although its
 * input schema lets it hold an object, or an array whose elements may be
 * objects or arrays. A role describes a top-level argument as a whole, so
 * policy cannot address the values inside such a structure one by one: the
 * engine checks every string inside it against the deny-side rules and sends
 * the call to a human (`structural-nested-argument-escalate`, human-only).
 */
export interface StructuredRoleArgument {
  readonly toolName: string;
  readonly argName: string;
  /** The argument's roles other than `none` (the default roles of a conditional spec). */
  readonly roles: readonly ArgumentRole[];
}

/** Combinator nesting followed when reading a schema; deeper branches are not inspected. */
const MAX_SCHEMA_DEPTH = 8;

function asSchema(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The schema itself and the branches of its anyOf/oneOf/allOf, at any depth up to MAX_SCHEMA_DEPTH. */
function schemaVariants(schema: unknown, depth = 0): Record<string, unknown>[] {
  const node = asSchema(schema);
  if (node === undefined || depth > MAX_SCHEMA_DEPTH) return [];
  const variants = [node];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) variants.push(...schemaVariants(branch, depth + 1));
  }
  return variants;
}

function declaresType(node: Record<string, unknown>, type: string): boolean {
  const declared = node.type;
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}

/** True when some variant of `schema` is an object schema (declared, or implied by its keywords). */
function admitsObject(schema: unknown): boolean {
  return schemaVariants(schema).some(
    (node) =>
      declaresType(node, 'object') ||
      (node.type === undefined && (node.properties !== undefined || node.patternProperties !== undefined)),
  );
}

/** True when some variant of `schema` is an array schema (declared, or implied by its keywords). */
function admitsArray(schema: unknown): boolean {
  return schemaVariants(schema).some(
    (node) =>
      declaresType(node, 'array') ||
      (node.type === undefined && (node.items !== undefined || node.prefixItems !== undefined)),
  );
}

/** The element schemas of every array variant of `schema` (`items`, tuple `items`, `prefixItems`). */
function elementSchemas(schema: unknown): unknown[] {
  const elements: unknown[] = [];
  for (const node of schemaVariants(schema)) {
    if (Array.isArray(node.items)) elements.push(...(node.items as unknown[]));
    else if (node.items !== undefined) elements.push(node.items);
    if (Array.isArray(node.prefixItems)) elements.push(...(node.prefixItems as unknown[]));
  }
  return elements;
}

/**
 * True when a JSON Schema lets an argument hold a value the policy engine
 * cannot evaluate value by value: an object, or an array whose elements may
 * be objects or arrays. A schema that does not say (no type, a `$ref`) is
 * not flagged; the engine still escalates such a value at evaluation time.
 */
export function schemaAdmitsStructuredValue(schema: unknown): boolean {
  if (admitsObject(schema)) return true;
  return elementSchemas(schema).some((element) => admitsObject(element) || admitsArray(element));
}

/**
 * The arguments of `annotations` that carry a role other than `none` on a
 * schema property that can hold an object or a nested array (see
 * {@link StructuredRoleArgument}). Without sub-path roles nothing more
 * precise can be annotated: assigning `none` instead would hide the values
 * from policy altogether, so `annotate-tools` reports these rather than
 * rewriting them. In the shipped annotations they are the `editors`
 * argument of the two gsheets protected-range tools.
 */
export function findStructuredRoleArguments(annotations: readonly StoredToolAnnotation[]): StructuredRoleArgument[] {
  const found: StructuredRoleArgument[] = [];
  for (const annotation of annotations) {
    const properties = asSchema(annotation.inputSchema.properties) ?? {};
    for (const [argName, spec] of Object.entries(annotation.args)) {
      const roles = extractDefaultRoles(spec).filter((role) => role !== 'none');
      if (roles.length === 0 || !Object.hasOwn(properties, argName)) continue;
      if (schemaAdmitsStructuredValue(properties[argName])) {
        found.push({ toolName: annotation.toolName, argName, roles });
      }
    }
  }
  return found;
}

/**
 * Warning lines for {@link findStructuredRoleArguments} results. Server,
 * tool and argument names come from the MCP server, so they are rendered
 * terminal-safe.
 */
export function describeStructuredRoleArguments(
  serverName: string,
  found: readonly StructuredRoleArgument[],
): string[] {
  const show = (text: string): string => toDisplayText(text, { maxLength: 120 });
  return found.map(({ toolName, argName, roles }) => {
    const assigned = roles.length === 1 ? `its role ${roles[0]} applies` : `its roles ${roles.join(', ')} apply`;
    return (
      `Warning: ${show(serverName)}/${show(toolName)}: argument "${show(argName)}" can hold an object or a nested ` +
      `array, but ${assigned} to the whole value. Policy cannot check the values inside it one by one ` +
      '(sub-path roles are not supported), so every call that passes such a value is escalated to a human, ' +
      'or denied by the policy.'
    );
  });
}

function buildAnnotationsResponseSchema(serverName: string, tools: MCPToolSchema[]) {
  const toolNames = tools.map((t) => t.name) as [string, ...string[]];

  // Build a per-server role enum so the schema rejects irrelevant roles
  const roleValues = getRolesForServer(serverName).map(([role]) => role) as [ArgumentRole, ...ArgumentRole[]];
  const argumentRoleSchema = z.enum(roleValues);

  // LLMs sometimes return a bare string instead of a single-element array.
  // Accept both formats and normalize to an array.
  const rolesArraySchema = z.union([z.array(argumentRoleSchema), argumentRoleSchema.transform((r) => [r])]);

  // Conditional role schemas: a condition on a sibling argument's value
  const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
  const conditionSchema = z
    .object({
      arg: z.string(),
      equals: scalarSchema.optional(),
      in: z.array(scalarSchema).optional(),
      is: z.enum(['present', 'absent', 'truthy', 'falsy']).optional(),
    })
    .refine(
      (c) => {
        const count = [c.equals !== undefined, c.in !== undefined, c.is !== undefined].filter(Boolean).length;
        return count === 1;
      },
      { message: 'Exactly one of equals, in, or is must be set' },
    );

  const conditionalEntrySchema = z.object({
    condition: conditionSchema,
    roles: rolesArraySchema,
  });

  const conditionalRolesSchema = z
    .object({
      default: rolesArraySchema,
      when: z.array(conditionalEntrySchema),
    })
    .refine(
      (spec) => {
        const defaultSet = new Set(spec.default);
        return spec.when.every((entry) => entry.roles.every((role) => defaultSet.has(role)));
      },
      { message: 'Conditional roles must be a subset of the default roles' },
    );

  // An argument's roles: either a static array or a conditional block
  const argumentRoleSpecSchema = z.union([rolesArraySchema, conditionalRolesSchema]);

  // Map tool name → expected argument names from input schemas
  const toolArgNames = new Map<string, string[]>();
  for (const t of tools) {
    const props = (t.inputSchema['properties'] ?? {}) as Record<string, unknown>;
    toolArgNames.set(t.name, Object.keys(props));
  }

  const toolAnnotationSchema = z.object({
    toolName: z.enum(toolNames),
    comment: z.string(),
    args: z.record(z.string(), argumentRoleSpecSchema),
  });

  return z.object({
    annotations: z.array(toolAnnotationSchema).superRefine((annotations, ctx) => {
      // The runtime loaders refuse a server entry that annotates a tool twice
      // (src/types/policy-schema.ts): the engine would keep only one of them.
      const firstIndex = new Map<string, number>();
      for (let i = 0; i < annotations.length; i++) {
        const a = annotations[i];
        const first = firstIndex.get(a.toolName);
        if (first === undefined) {
          firstIndex.set(a.toolName, i);
        } else {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'toolName'],
            message: `Tool "${a.toolName}" is annotated more than once (also at index ${first}). Return exactly one annotation per tool.`,
          });
        }
        const expectedArgs = toolArgNames.get(a.toolName) ?? [];
        const missingArgs = expectedArgs.filter((name) => !(name in a.args));
        if (missingArgs.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'args'],
            message: `Tool "${a.toolName}" is missing role annotations for arguments: ${missingArgs.join(', ')}. Each argument must have a role array (e.g. ["read-path"] or ["none"]).`,
          });
        }

        // Cross-argument validation: conditional role conditions must reference
        // sibling argument names that exist in the same tool's annotation (own
        // keys, as the runtime schema checks: "constructor" is no argument)
        for (const [argName, spec] of Object.entries(a.args)) {
          if (isConditionalRoles(spec)) {
            for (const entry of spec.when) {
              const condArg = entry.condition.arg;
              if (!Object.hasOwn(a.args, condArg)) {
                ctx.addIssue({
                  code: 'custom',
                  path: [i, 'args', argName],
                  message:
                    `Conditional role on "${argName}" references unknown argument "${condArg}". ` +
                    `The condition argument must be another argument in the same tool's input schema.`,
                });
              }
            }
          }
        }
      }
    }),
  });
}

/** Builds role description lines dynamically from the registry for the LLM prompt. */
export function buildRoleDescriptions(serverName?: string): string {
  const entries = serverName ? getRolesForServer(serverName) : [...ARGUMENT_ROLE_REGISTRY.entries()];
  const lines: string[] = [];
  for (const [role, def] of entries) {
    lines.push(`   - "${role}" -- ${def.description}. ${def.annotationGuidance}`);
  }
  return lines.join('\n');
}

export function buildAnnotationPrompt(serverName: string, tools: MCPToolSchema[]): string {
  const toolDescriptions = tools
    .map((t) => {
      return [
        `Tool: ${t.name}`,
        t.description ? `Description: ${t.description}` : '',
        `Input Schema: ${JSON.stringify(t.inputSchema, null, 2)}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  return `You are annotating MCP tools for a security policy engine. For each tool on the "${serverName}" server, classify:

1. **comment**: A brief one-sentence description of what the tool does.

2. **args**: For each argument in the tool's input schema, assign an ARRAY of one or more roles:
${buildRoleDescriptions(serverName)}

   IMPORTANT: Each value in the args object MUST be an ARRAY of roles, even for single roles.
   Example: { "path": ["read-path"], "content": ["none"] }
   NOT: { "path": "read-path", "content": "none" }

   An argument can have MULTIPLE roles. For example, the "source" argument of a move operation has both "read-path" and "delete-path" roles because the source is read and then deleted.

   Only include arguments that appear in the tool's input schema. If the tool has no arguments, use an empty object.

Here is a complete example annotation for a move_file tool that shows multi-role arguments:

{
  "toolName": "move_file",
  "comment": "Moves or renames a file or directory from a source path to a destination path in a single operation.",
  "args": {
    "source": ["read-path", "delete-path"],
    "destination": ["write-path"]
  }
}

## Conditional Roles

When a tool has a mode/operation argument that changes its behavior, use
conditional role assignment instead of assigning the union of all possible
roles. This produces more precise policy evaluation.

Use conditional roles when:
- A tool has an operation/mode/type/action argument that selects between
  read-only and mutating behavior (e.g., "list" vs "create"/"delete")
- A boolean flag (like dryRun or force) changes whether the tool modifies
  state

IMPORTANT: Always check for mode-like arguments (mode, operation, type,
action, command, subcommand). If a mode argument's possible values include
both read-only operations (list, show, get, status) and mutating operations
(create, delete, add, remove, push, pop, apply, drop, rename), the path
argument MUST use conditional roles — not a static union of all roles.

Format for conditional roles:
{
  "default": ["read-path", "write-history", "delete-history"],
  "when": [
    { "condition": { "arg": "operation", "equals": "list" }, "roles": ["read-path"] },
    { "condition": { "arg": "operation", "in": ["create", "rename"] }, "roles": ["read-path", "write-history"] },
    { "condition": { "arg": "operation", "equals": "delete" }, "roles": ["read-path", "delete-history"] }
  ]
}

Rules for conditional roles:
- The "default" MUST be the MOST RESTRICTIVE role set (the union of all
  possible roles). This is the fallback when no condition matches.
- Each "when" entry narrows the roles for a specific mode/flag value.
- The "arg" in a condition must reference another argument in the same
  tool's input schema.
- Use "equals" for single-value matching, "in" for multiple values with
  the same roles, and "is" for presence/truthiness checks.
- Only use conditional roles when the mode argument genuinely changes the
  security profile. Do not add conditions for arguments that do not affect
  which resources are accessed.
- Most arguments will still use static role arrays. Only use conditional
  roles where the tool is clearly multi-mode.

Example: A tool with a mode argument (list is read-only, push/pop mutate):
{
  "path": {
    "default": ["read-path", "write-history"],
    "when": [
      { "condition": { "arg": "mode", "in": ["list", "show"] }, "roles": ["read-path"] }
    ]
  },
  "mode": ["none"],
  "message": ["none"]
}

Example: A tool with dryRun flag:
{
  "path": {
    "default": ["read-path", "write-path"],
    "when": [
      { "condition": { "arg": "dryRun", "equals": true }, "roles": ["read-path"] }
    ]
  },
  "dryRun": ["none"]
}

Here are the tools to annotate:

${toolDescriptions}

Return annotations for ALL ${tools.length} tools. Use the exact tool names as provided.`;
}

// ---------------------------------------------------------------------------
// Per-tool annotation cache
// ---------------------------------------------------------------------------

/**
 * Part of every per-tool annotation key: bump it to re-annotate every tool
 * when the meaning of the annotation instructions changes without their text.
 */
export const ANNOTATION_PROMPT_EPOCH = 1;

/**
 * Version of what the annotator asks for one server's tools: the prompt
 * template without any tool (its instructions, plus the description and
 * guidance of every role the server may use), the server's role registry
 * (each role's category and resource-identifier flag, which decide how the
 * engine treats it) and {@link ANNOTATION_PROMPT_EPOCH}.
 */
export function annotationPromptVersion(serverName: string): string {
  const roles = getRolesForServer(serverName).map(([role, def]) => ({
    role,
    description: def.description,
    annotationGuidance: def.annotationGuidance,
    category: def.category,
    isResourceIdentifier: def.isResourceIdentifier,
    serverNames: def.serverNames,
  }));
  return canonicalDigest({ epoch: ANNOTATION_PROMPT_EPOCH, prompt: buildAnnotationPrompt(serverName, []), roles });
}

/**
 * Per-tool annotation key: sha256 of what the annotator sees of the tool
 * (name, description, input schema; canonical JSON) and of the server's
 * {@link annotationPromptVersion}. Stored on each annotation as
 * `annotationKey`; an annotation whose key matches the live tool's is reused
 * instead of asking the LLM again. The description is part of the
 * key: a change of meaning alone (same schema) re-annotates the tool.
 */
export function computeToolAnnotationKey(tool: MCPToolSchema, promptVersion: string): string {
  return canonicalDigest({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    promptVersion,
  });
}

/** Result of {@link annotateServerTools}. */
export interface ServerToolAnnotations {
  /** One annotation per live tool, in the order the server lists them. */
  readonly annotations: StoredToolAnnotation[];
  /** Tools whose previous annotation (roles and comment) was reused. */
  readonly reused: readonly string[];
  /** Tools the LLM annotated in this call. */
  readonly annotated: readonly string[];
}

/**
 * True when `candidate` is a complete, valid annotation of `tool` for this
 * server: the response schema the LLM's own answer must pass (registered
 * roles of this server, every argument annotated, conditions naming another
 * argument) accepts it. A reused annotation is held to the same bar.
 */
function isValidAnnotationFor(serverName: string, tool: MCPToolSchema, candidate: StoredToolAnnotation): boolean {
  const { toolName, comment, args } = candidate;
  return buildAnnotationsResponseSchema(serverName, [tool]).safeParse({ annotations: [{ toolName, comment, args }] })
    .success;
}

/**
 * Finds the reusable annotation for one live tool: the first candidate, in
 * priority order, with the tool's name and key that is still valid. Only its
 * roles and comment are kept; what comes from the server is the live tool's:
 * the input schema (the key says it is the same schema, up to key order) and
 * the behaviour hints. The key does not cover the hints (the LLM never sees
 * them), but the policy lint reads them, so a reused annotation carries the
 * hints the server declares now, exactly as a fresh annotation would: a tool
 * the server starts marking destructive is linted as changing state.
 */
function findReusable(
  serverName: string,
  tool: MCPToolSchema,
  key: string,
  previous: ReadonlyArray<readonly StoredToolAnnotation[]>,
): StoredToolAnnotation | undefined {
  for (const candidates of previous) {
    const candidate = candidates.find((a) => a.toolName === tool.name);
    if (candidate?.annotationKey === key && isValidAnnotationFor(serverName, tool, candidate)) {
      const mcpHints = extractMcpToolHints(tool);
      return {
        toolName: candidate.toolName,
        serverName,
        comment: candidate.comment,
        args: candidate.args,
        inputSchema: tool.inputSchema,
        ...(mcpHints ? { mcpHints } : {}),
        annotationKey: key,
      };
    }
  }
  return undefined;
}

/**
 * Annotates a server's tools, reusing previous annotations of unchanged
 * tools.
 *
 * `previous` lists earlier annotations of this server in priority order
 * (`annotate-tools` passes the reviewed package entry and the user's own
 * entry). A live tool whose {@link computeToolAnnotationKey} equals the
 * `annotationKey` of a previous annotation of the same name keeps that
 * annotation's roles and comment; only the remaining tools go to the LLM,
 * in batches of {@link ANNOTATION_BATCH_SIZE}, at temperature 0. Every
 * returned annotation carries its tool's key.
 *
 * Throws (before any LLM call) when the server lists a tool more than once,
 * and when the LLM leaves a tool unannotated after its repair attempts.
 */
export async function annotateServerTools(opts: {
  readonly serverName: string;
  readonly tools: MCPToolSchema[];
  /**
   * The annotation model, or a function returning it that is called only
   * when some tool needs the LLM: a server whose tools are all reused (a
   * tool removed, the list reordered) needs no model or credentials.
   */
  readonly llm: LanguageModel | (() => Promise<LanguageModel>);
  readonly previous?: ReadonlyArray<readonly StoredToolAnnotation[]>;
  readonly onProgress?: (message: string) => void;
}): Promise<ServerToolAnnotations> {
  const { serverName, tools, onProgress } = opts;
  if (tools.length === 0) return { annotations: [], reused: [], annotated: [] };

  // The runtime loaders refuse an entry that annotates a tool twice, and a
  // tool listed twice cannot be told apart for reuse either: fail before
  // spending any LLM call.
  const repeated = new Set(tools.map((t) => t.name).filter((name, index, names) => names.indexOf(name) !== index));
  if (repeated.size > 0) {
    const names = [...repeated].map((name) => toDisplayText(JSON.stringify(name))).join(', ');
    throw new Error(`Annotation incomplete: the server lists these tools more than once: ${names}`);
  }

  const promptVersion = annotationPromptVersion(serverName);
  const keys = new Map(tools.map((t) => [t.name, computeToolAnnotationKey(t, promptVersion)]));
  const keyOf = (name: string): string => keys.get(name) ?? '';

  const byName = new Map<string, StoredToolAnnotation>();
  const reused: string[] = [];
  const toAnnotate: MCPToolSchema[] = [];
  for (const tool of tools) {
    const reusable = findReusable(serverName, tool, keyOf(tool.name), opts.previous ?? []);
    if (reusable) {
      byName.set(tool.name, reusable);
      reused.push(tool.name);
    } else {
      toAnnotate.push(tool);
    }
  }
  if (reused.length > 0 && toAnnotate.length > 0) {
    onProgress?.(`${reused.length} unchanged tool(s) reused; annotating ${toAnnotate.length}`);
  }

  const batches = toAnnotate.length > 0 ? chunk(toAnnotate, ANNOTATION_BATCH_SIZE) : [];
  let model: LanguageModel | undefined;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    model ??= typeof opts.llm === 'function' ? await opts.llm() : opts.llm;

    if (batches.length > 1) {
      onProgress?.(`Batch ${i + 1}/${batches.length} (${batch.length} tools)`);
    }

    const schema = buildAnnotationsResponseSchema(serverName, batch);
    const prompt = buildAnnotationPrompt(serverName, batch);

    // Temperature 0: annotations are reviewed TCB data, and a refresh should
    // not re-sample the roles of a tool whose description and schema stayed.
    const { output } = await generateObjectWithRepair({
      model,
      schema,
      prompt,
      temperature: 0,
      onProgress: batches.length > 1 ? (msg) => onProgress?.(`Batch ${i + 1}/${batches.length}: ${msg}`) : onProgress,
    });

    // Build a lookup from tool name to its MCP listing for this batch
    const toolByName = new Map(batch.map((t) => [t.name, t]));

    for (const a of output.annotations) {
      const tool = toolByName.get(a.toolName);
      const mcpHints = tool ? extractMcpToolHints(tool) : undefined;
      byName.set(a.toolName, {
        ...a,
        serverName,
        inputSchema: tool?.inputSchema ?? { type: 'object' },
        ...(mcpHints ? { mcpHints } : {}),
        annotationKey: keyOf(a.toolName),
      });
    }
  }

  // Validate all input tools are represented across all batches
  const missingTools = tools.filter((t) => !byName.has(t.name));
  if (missingTools.length > 0) {
    const names = missingTools.map((t) => t.name).join(', ');
    throw new Error(`Annotation incomplete: missing tools: ${names}`);
  }

  return {
    // The server's own order, so a re-annotation diffs cleanly against the last one.
    annotations: tools.map((t) => byName.get(t.name)).filter((a): a is StoredToolAnnotation => a !== undefined),
    reused,
    annotated: toAnnotate.map((t) => t.name),
  };
}

/** {@link annotateServerTools} without previous annotations: every tool goes to the LLM. */
export async function annotateTools(
  serverName: string,
  tools: MCPToolSchema[],
  llm: LanguageModel,
  onProgress?: (message: string) => void,
): Promise<StoredToolAnnotation[]> {
  return (await annotateServerTools({ serverName, tools, llm, onProgress })).annotations;
}
