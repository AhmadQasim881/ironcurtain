/**
 * `workflow resume-standalone <baseDir>` of a base directory other than this
 * home's own ignores the container snapshots its checkpoints reference: they
 * can name any image on the engine (a copied, restored or agent-left run),
 * and a daemon import drops them the same way.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resumeStandaloneOptions } from '../../src/workflow/workflow-command.js';

describe('resumeStandaloneOptions', () => {
  let root: string;
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'resume-standalone-options-'));
    home = join(root, 'home');
    mkdirSync(join(home, 'workflow-runs'), { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the snapshot references of runs in this home's own workflow-runs directory", () => {
    expect(resumeStandaloneOptions(join(home, 'workflow-runs'))).toBeUndefined();
    expect(resumeStandaloneOptions(join(home, 'workflow-runs', '..', 'workflow-runs'))).toBeUndefined();
    const link = join(root, 'runs-link');
    symlinkSync(join(home, 'workflow-runs'), link);
    expect(resumeStandaloneOptions(link)).toBeUndefined();
  });

  it('ignores the snapshot references of runs in any other base directory', () => {
    const copied = join(root, 'backup', 'workflow-runs');
    mkdirSync(copied, { recursive: true });
    expect(resumeStandaloneOptions(copied)).toEqual({ ignoreContainerSnapshots: true });
    expect(resumeStandaloneOptions(join(root, 'missing'))).toEqual({ ignoreContainerSnapshots: true });
  });
});
