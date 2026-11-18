/**
 * The shared policy fixture (test/fixtures/test-policy.ts) stands in for the
 * generated tool-annotations.json that production loads, and integration
 * tests write it to disk as that file. These checks keep it in the stored
 * format: every tool carries an input schema, and the schema declares exactly
 * the arguments the annotation classifies, so a server that lists those
 * schemas shows no drift against the fixture.
 */

import { describe, expect, it } from 'vitest';
import { diffServerSchemas, hasServerDrift } from '../src/trusted-process/schema-drift.js';
import { argsSchema, objectSchema, testToolAnnotations, withInputSchemas } from './fixtures/test-policy.js';

/** Argument names a tool input schema declares, sorted. */
function declaredArguments(schema: Readonly<Record<string, unknown>>): string[] {
  const properties = schema.properties;
  return properties !== null && typeof properties === 'object' ? Object.keys(properties).sort() : [];
}

/** The schema's `required` list (empty when absent). */
function requiredArguments(schema: Readonly<Record<string, unknown>>): unknown[] {
  return Array.isArray(schema.required) ? schema.required : [];
}

describe('test policy fixture', () => {
  it('stores an input schema with every annotation, declaring exactly the classified arguments', () => {
    for (const [serverName, server] of Object.entries(testToolAnnotations.servers)) {
      for (const tool of server.tools) {
        const label = `${serverName}/${tool.toolName}`;
        expect(tool.serverName, label).toBe(serverName);
        expect(tool.inputSchema.type, label).toBe('object');
        expect(declaredArguments(tool.inputSchema), label).toEqual(Object.keys(tool.args).sort());
        for (const name of requiredArguments(tool.inputSchema)) {
          expect(Object.keys(tool.args), label).toContain(name);
        }
      }
    }
  });

  it('shows no schema drift against servers that list the fixture schemas', () => {
    for (const [serverName, server] of Object.entries(testToolAnnotations.servers)) {
      const live = server.tools.map((tool) => ({ name: tool.toolName, inputSchema: tool.inputSchema }));
      expect(hasServerDrift(diffServerSchemas(serverName, server.tools, live)), serverName).toBe(false);
    }
  });

  it('completes test-local annotations with a schema of their arguments and keeps explicit ones', () => {
    const explicit = objectSchema({ path: 'string' }, ['path']);
    const file = withInputSchemas({
      generatedAt: 'test',
      servers: {
        local: {
          inputHash: 'test',
          tools: [
            { toolName: 'derived', serverName: 'local', comment: '', args: { path: ['read-path'], depth: ['none'] } },
            {
              toolName: 'explicit',
              serverName: 'local',
              comment: '',
              args: { path: ['read-path'] },
              inputSchema: explicit,
            },
          ],
        },
      },
    });

    const [derived, kept] = file.servers.local.tools;
    expect(derived.inputSchema).toEqual({ type: 'object', properties: { path: {}, depth: {} } });
    expect(derived.inputSchema).toEqual(argsSchema(derived.args));
    expect(kept.inputSchema).toBe(explicit);
  });
});
