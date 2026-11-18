#!/usr/bin/env tsx
/**
 * stamp-package-annotations.ts — developer tool for the bundled
 * src/config/generated/tool-annotations.json.
 *
 * Every server entry in the bundled file carries a `contentDigest` of its
 * tools and the digests of earlier shipped revisions (`supersededDigests`).
 * Users' annotation overlays use them to tell a stale copy of package data
 * from a real user annotation, so a changed package entry must be re-stamped
 * before it ships (test/annotations-overlay.test.ts fails otherwise).
 *
 * Usage:
 *   # after editing src/config/generated/tool-annotations.json by hand
 *   npx tsx scripts/stamp-package-annotations.ts
 *
 *   # after `ironcurtain annotate-tools --server <name>` and reviewing the
 *   # result: copy that server's entry from your overlay into the package
 *   npx tsx scripts/stamp-package-annotations.ts --from ~/.ironcurtain/generated/tool-annotations.json --server <name>
 *
 * Do not copy the overlay file over the package file: the overlay holds only
 * the servers you re-annotated.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readToolAnnotationsFile } from '../src/config/tool-annotations-overlay.js';
import { promoteOverlayEntries, stampPackageAnnotations } from '../src/pipeline/annotation-overlay.js';
import { writeArtifact } from '../src/pipeline/pipeline-shared.js';
import { VERSION } from '../src/version.js';

const packageDir = resolve(fileURLToPath(import.meta.url), '../../src/config/generated');
const packagePath = resolve(packageDir, 'tool-annotations.json');

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    server: { type: 'string', multiple: true },
  },
  strict: true,
});

const packageFile = readToolAnnotationsFile(packagePath);
if (!packageFile) throw new Error(`${packagePath} not found`);

if (values.from === undefined && values.server !== undefined) {
  throw new Error('--server is only meaningful with --from');
}

let result: { readonly file: typeof packageFile; readonly changed: readonly string[] };
if (values.from !== undefined) {
  const overlay = readToolAnnotationsFile(resolve(values.from));
  if (!overlay) throw new Error(`${values.from} not found`);
  const promotion = promoteOverlayEntries(packageFile, overlay, VERSION, values.server);
  console.log(`Promoted from overlay: ${promotion.promoted.join(', ')}`);
  result = promotion;
} else {
  result = stampPackageAnnotations(packageFile, VERSION);
}

if (result.changed.length === 0) {
  console.log('Already stamped; nothing changed.');
} else {
  writeArtifact(packageDir, 'tool-annotations.json', result.file);
  console.log(`Re-stamped: ${result.changed.join(', ')} (producerVersion ${VERSION})`);
}
