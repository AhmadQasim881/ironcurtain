import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { minimatch } from 'minimatch';
import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

/**
 * Guard for the per-glob coverage thresholds in vitest.config.ts, which CI
 * enforces with `npm run test:coverage`.
 *
 * Vitest sums each glob over the reported files that match it. A glob that
 * matches no file has no coverage at all ("Unknown"), and vitest never fails
 * it, so renaming, moving or splitting src/docker/mitm-proxy.ts (or emptying
 * one of the directories) would silently drop that code out of the gate.
 * This test is that signal.
 */

/** Keys of `coverage.thresholds` that are options rather than globs. */
const NON_GLOB_KEYS = new Set(['statements', 'branches', 'functions', 'lines', 'perFile', 'autoUpdate', '100']);

describe('coverage threshold globs', () => {
  it('each names at least one source file the coverage report includes', () => {
    const coverage = config.test?.coverage;
    const globs = Object.keys(coverage?.thresholds ?? {}).filter((key) => !NON_GLOB_KEYS.has(key));
    expect(globs).toEqual(
      expect.arrayContaining(['src/trusted-process/**', 'src/sandbox/**', 'src/docker/mitm-proxy.ts']),
    );

    const include = coverage?.include ?? [];
    const exclude = coverage?.exclude ?? [];
    const reported = readdirSync(join(import.meta.dirname, '..', 'src'), { recursive: true, encoding: 'utf-8' })
      .map((entry) => `src/${entry.split('\\').join('/')}`)
      .filter((file) => include.some((p) => minimatch(file, p)) && !exclude.some((p) => minimatch(file, p)));

    expect(globs.filter((glob) => !reported.some((file) => minimatch(file, glob)))).toEqual([]);
  });
});
