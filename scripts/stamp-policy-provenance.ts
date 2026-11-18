#!/usr/bin/env tsx
/**
 * stamp-policy-provenance.ts — developer tool for the compiled policies
 * shipped in src/config/generated/ and src/config/generated-readonly/.
 *
 * Every compiled-policy.json carries a `provenance` block (see
 * src/policy-artifacts/provenance.ts) recording, among other things, the
 * content digest of the tool annotations each server's rules were compiled
 * against. Loaders compare it with the annotations in effect, so the shipped
 * policies must record the shipped annotations
 * (test/policy-provenance.test.ts fails otherwise).
 *
 * After a real recompile of a shipped policy the block is already correct.
 * After a hand edit of the shipped tool annotations, review whether the
 * shipped rules still hold for them; if they do, re-stamp:
 *
 *   npx tsx scripts/stamp-policy-provenance.ts
 *
 * Re-stamping writes the current compiler epoch, engine and verifier
 * versions, keeps a recorded policy model, and records the digests of the
 * shipped annotations. It does not recompile or re-verify anything.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolAnnotationsFile } from '../src/config/tool-annotations-overlay.js';
import { buildPolicyProvenance, withPolicyProvenance } from '../src/policy-artifacts/provenance.js';
import { writeArtifact } from '../src/pipeline/pipeline-shared.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';

const configDir = resolve(fileURLToPath(import.meta.url), '../../src/config');
const annotations = readToolAnnotationsFile(resolve(configDir, 'generated', 'tool-annotations.json'));
if (!annotations) throw new Error('src/config/generated/tool-annotations.json not found');

for (const dirName of ['generated', 'generated-readonly']) {
  const dir = resolve(configDir, dirName);
  const path = resolve(dir, 'compiled-policy.json');
  const policy = JSON.parse(readFileSync(path, 'utf-8')) as CompiledPolicyFile;
  const provenance = buildPolicyProvenance({
    policy,
    annotations,
    policyModelId: policy.provenance?.policyModelId,
  });
  const before = JSON.stringify(policy.provenance);
  const stamped = withPolicyProvenance(policy, provenance);
  if (JSON.stringify(stamped.provenance) === before) {
    console.log(`${dirName}/compiled-policy.json: already stamped`);
    continue;
  }
  writeArtifact(dir, 'compiled-policy.json', stamped);
  console.log(`${dirName}/compiled-policy.json: stamped (${Object.keys(provenance.annotationDigests).join(', ')})`);
}
