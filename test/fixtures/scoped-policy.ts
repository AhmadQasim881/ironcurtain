/**
 * Scoped (per-persona and per-job) compiled-policy fixtures.
 *
 * The runtime refuses a scoped policy unless it records the sha256 of the
 * constitution it was compiled from (src/config/constitution-hash.ts), so a
 * fixture must write a matching pair: the persona's constitution.md (or the
 * job's taskConstitution) and a compiled-policy.json carrying its hash.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashConstitutionText } from '../../src/config/constitution-hash.js';

/** Default constitution text for persona fixtures. */
export const TEST_PERSONA_CONSTITUTION = 'Test persona constitution.\n';

/**
 * Writes `<policyDir>/compiled-policy.json` as if compiled from
 * `constitution`. `policy` supplies the remaining fields (rules default to
 * none). `generatedAt` and `inputHash` default to placeholders: the loaders
 * schema-validate the file (src/types/policy-schema.ts) and refuse one
 * without them.
 */
export function writeCompiledPolicyFor(
  policyDir: string,
  constitution: string,
  policy: Record<string, unknown> = {},
): void {
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    resolve(policyDir, 'compiled-policy.json'),
    JSON.stringify({
      generatedAt: 'test',
      inputHash: 'test',
      rules: [],
      ...policy,
      constitutionHash: hashConstitutionText(constitution),
    }),
  );
}

/**
 * Writes a persona's constitution.md and a generated/compiled-policy.json
 * compiled from it, so the persona resolves as fresh.
 */
export function writePersonaPolicy(
  personaDir: string,
  policy: Record<string, unknown> = {},
  constitution: string = TEST_PERSONA_CONSTITUTION,
): void {
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(resolve(personaDir, 'constitution.md'), constitution);
  writeCompiledPolicyFor(resolve(personaDir, 'generated'), constitution, policy);
}
