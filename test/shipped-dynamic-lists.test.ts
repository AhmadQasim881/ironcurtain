/**
 * The dynamic lists shipped in the package (src/config/generated*) must meet
 * the current list value rules. A value the resolver would drop today, such as
 * an IP literal, a public suffix or a wildcard over a multi-tenant hosting
 * suffix (`*.readthedocs.io`, `*.githubusercontent.com`), must not ship either:
 * an install that never compiles uses these lists as they are, and a persona
 * whose policy references one would be rejected as broad.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIST_TYPE_REGISTRY, describeDomainValueProblem } from '../src/pipeline/dynamic-list-types.js';
import { isBroadDomainPattern } from '../src/types/public-suffix.js';
import type { CompiledPolicyFile, DynamicListsFile } from '../src/pipeline/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = resolve(ROOT, 'src', 'config');

function findListFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) found.push(...findListFiles(path));
    else if (entry === 'dynamic-lists.json') found.push(path);
  }
  return found;
}

const listFiles = readdirSync(CONFIG_DIR)
  .map((entry) => resolve(CONFIG_DIR, entry))
  .filter((path) => basename(path).startsWith('generated') && statSync(path).isDirectory())
  .flatMap(findListFiles);

describe('shipped dynamic lists', () => {
  it('ships at least the default lists', () => {
    expect(listFiles.map((f) => relative(ROOT, f))).toContain('src/config/generated/dynamic-lists.json');
  });

  for (const file of listFiles) {
    it(`${relative(ROOT, file)}: every value passes the current list rules`, () => {
      const lists = JSON.parse(readFileSync(file, 'utf-8')) as DynamicListsFile;
      const policyPath = resolve(dirname(file), 'compiled-policy.json');
      expect(existsSync(policyPath)).toBe(true);
      const definitions = (JSON.parse(readFileSync(policyPath, 'utf-8')) as CompiledPolicyFile).listDefinitions ?? [];

      const problems: string[] = [];
      for (const [name, list] of Object.entries(lists.lists)) {
        const definition = definitions.find((d) => d.name === name);
        expect(definition, `@${name} has a list definition`).toBeDefined();
        if (definition === undefined) continue;
        const validate = LIST_TYPE_REGISTRY.get(definition.type)?.validate ?? (() => true);
        for (const value of [...list.values, ...list.manualAdditions]) {
          if (!validate(value)) {
            const reason = definition.type === 'domains' ? describeDomainValueProblem(value) : 'invalid';
            problems.push(`@${name}: ${value} (${reason ?? 'invalid'})`);
          } else if (definition.type === 'domains' && isBroadDomainPattern(value)) {
            problems.push(`@${name}: ${value} (broad wildcard)`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
