/**
 * Validates test scenario arguments against tool input schemas.
 *
 * Catches common LLM errors: wrong argument names, missing required fields,
 * and invalid enum values. Validates against the schema the live server
 * reports when the caller reached the server (`compile-policy` without
 * `--no-mcp`), otherwise against the JSON Schema stored in the tool
 * annotations (captured from the MCP server at annotation time). Only the
 * live schema can reject a shape the server itself rejects after a release
 * renamed an argument; the stored one is as old as the annotation.
 */

import { z } from 'zod';
import type { StoredToolAnnotation, TestScenario, DiscardedScenario } from './types.js';

// ---------------------------------------------------------------------------
// JSON Schema helpers (minimal subset for validation)
// ---------------------------------------------------------------------------

interface JsonSchemaProperty {
  type?: string;
  enum?: unknown[];
}

interface JsonSchema {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function asJsonSchema(raw: Record<string, unknown>): JsonSchema {
  return raw;
}

/**
 * Live input schemas keyed by {@link liveSchemaKey}. Built by
 * `live-tools.ts` from the servers `compile-policy` could reach; a tool
 * absent from the index is validated against its stored schema.
 */
export type LiveSchemaIndex = ReadonlyMap<string, Record<string, unknown>>;

/** The key of a tool's live schema in a {@link LiveSchemaIndex}. */
export function liveSchemaKey(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
  readonly message: string;
}

/**
 * Validates a scenario's arguments against the matching tool's input schema:
 * the live one when `liveSchemas` has it, else the stored annotation's.
 *
 * Returns an empty array if the scenario is valid or if no schema is known
 * for the tool (graceful skip).
 */
export function validateScenarioArgs(
  scenario: TestScenario,
  storedAnnotations: StoredToolAnnotation[],
  liveSchemas?: LiveSchemaIndex,
): SchemaValidationError[] {
  const { serverName, toolName } = scenario.request;
  const live = liveSchemas?.get(liveSchemaKey(serverName, toolName));
  const stored = storedAnnotations.find((a) => a.serverName === serverName && a.toolName === toolName)?.inputSchema;
  const rawSchema = live ?? stored;
  if (!rawSchema) return [];

  const schema = asJsonSchema(rawSchema);
  if (!schema.properties) return [];

  const errors: SchemaValidationError[] = [];
  const scenarioArgs = scenario.request.arguments;
  const schemaPropertyNames = new Set(Object.keys(schema.properties));

  // Check for unknown argument names
  for (const argName of Object.keys(scenarioArgs)) {
    if (!schemaPropertyNames.has(argName)) {
      errors.push({ message: `unknown argument "${argName}" (valid: ${[...schemaPropertyNames].join(', ')})` });
    }
  }

  // Check for missing required fields
  if (schema.required) {
    for (const requiredArg of schema.required) {
      if (!(requiredArg in scenarioArgs)) {
        errors.push({ message: `missing required argument "${requiredArg}"` });
      }
    }
  }

  // Check enum constraints
  for (const [argName, propSchema] of Object.entries(schema.properties)) {
    if (!propSchema.enum || !(argName in scenarioArgs)) continue;
    const value = scenarioArgs[argName];
    if (!propSchema.enum.includes(value)) {
      errors.push({
        message: `argument "${argName}" has invalid value ${JSON.stringify(value)} (valid: ${propSchema.enum.map((v) => JSON.stringify(v)).join(', ')})`,
      });
    }
  }

  return errors;
}

/**
 * Filters scenarios with invalid arguments, returning valid and discarded sets.
 *
 * Scenarios without a known schema (no live schema, no matching annotation
 * or an annotation without inputSchema) are kept (not discarded).
 */
export function filterInvalidSchemaScenarios(
  scenarios: TestScenario[],
  storedAnnotations: StoredToolAnnotation[],
  liveSchemas?: LiveSchemaIndex,
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const valid: TestScenario[] = [];
  const discarded: DiscardedScenario[] = [];

  for (const scenario of scenarios) {
    const errors = validateScenarioArgs(scenario, storedAnnotations, liveSchemas);
    if (errors.length > 0) {
      discarded.push({
        scenario,
        actual: 'deny',
        rule: `invalid-schema: ${errors.map((e) => e.message).join('; ')}`,
      });
    } else {
      valid.push(scenario);
    }
  }

  return { valid, discarded };
}

// ---------------------------------------------------------------------------
// Zod integration: validate scenario arguments at schema parse time
// ---------------------------------------------------------------------------

/**
 * Builds a Map from toolName → Set of valid argument names, extracted from inputSchema.
 * Used by Zod superRefine to reject scenarios with invalid argument names at parse time.
 */
export function buildToolArgNamesMap(annotations: StoredToolAnnotation[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const ann of annotations) {
    const schema = asJsonSchema(ann.inputSchema);
    if (schema.properties) {
      map.set(ann.toolName, new Set(Object.keys(schema.properties)));
    }
  }
  return map;
}

/**
 * Creates a Zod superRefine function that validates scenario arguments against
 * tool input schemas. When integrated into the scenario Zod schema, validation
 * errors are returned to the LLM via generateObjectWithRepair for automatic fix.
 *
 * This is the PRIMARY validation point — it replaces post-hoc filtering.
 */
export function buildScenarioArgsSuperRefine(
  toolArgNames: Map<string, Set<string>>,
): (scenario: { request: { toolName: string; arguments: Record<string, unknown> } }, ctx: z.RefinementCtx) => void {
  return (scenario, ctx) => {
    const validArgs = toolArgNames.get(scenario.request.toolName);
    if (!validArgs) return; // unknown tool — can't validate, Zod enum on toolName catches it

    for (const argName of Object.keys(scenario.request.arguments)) {
      if (!validArgs.has(argName)) {
        ctx.addIssue({
          code: 'custom',
          path: ['request', 'arguments', argName],
          message: `Unknown argument "${argName}" for tool "${scenario.request.toolName}". Valid arguments: ${[...validArgs].join(', ')}`,
        });
      }
    }
  };
}

/**
 * Formats tool argument names for inclusion in LLM prompts, so the LLM knows
 * which argument names are valid per tool.
 */
export function formatToolArgNames(annotations: StoredToolAnnotation[]): string {
  const lines: string[] = [];
  for (const ann of annotations) {
    const schema = asJsonSchema(ann.inputSchema);
    if (schema.properties) {
      const args = Object.keys(schema.properties).join(', ');
      lines.push(`- ${ann.toolName}: args=[${args}]`);
    }
  }
  return lines.join('\n');
}
