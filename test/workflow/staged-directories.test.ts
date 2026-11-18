import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageWorkflowScriptsAtStart, stageWorkflowSkillsAtStart } from '../../src/workflow/orchestrator.js';
import {
  copyWorkflowResourceDirectory,
  copyWorkflowStagedDirectory,
  validatedWorkflowStagedDirectory,
} from '../../src/workflow/staged-directories.js';

describe('workflow staging roots', () => {
  let root: string;
  let source: string;
  let run: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workflow-stage-validation-'));
    source = join(root, 'package');
    run = join(root, 'run');
    mkdirSync(source);
    mkdirSync(run);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['scripts', stageWorkflowScriptsAtStart],
    ['skills', stageWorkflowSkillsAtStart],
  ] as const)('requires a real %s source directory', (name, stage) => {
    const contents = join(source, 'contents');
    mkdirSync(contents);
    writeFileSync(join(contents, 'example.txt'), 'ordinary fixture');
    symlinkSync(contents, join(source, name));
    expect(() => stage(source, run)).toThrow(/real directory/);
  });

  it('preserves ordinary script contents and executable permission', () => {
    mkdirSync(join(source, 'scripts', 'nested'), { recursive: true });
    const script = join(source, 'scripts', 'nested', 'example.sh');
    writeFileSync(script, '#!/bin/sh\ntrue\n');
    chmodSync(script, 0o755);
    const staged = stageWorkflowScriptsAtStart(source, run);
    expect(staged).toBe(join(run, 'workflow-scripts'));
    expect(readFileSync(join(staged ?? '', 'nested', 'example.sh'), 'utf8')).toBe('#!/bin/sh\ntrue\n');
    expect(statSync(join(staged ?? '', 'nested', 'example.sh')).mode & 0o777).toBe(0o755);
  });

  it('accepts only the requested canonical run staging root', () => {
    const staged = join(run, 'workflow-scripts');
    mkdirSync(staged);
    mkdirSync(join(run, 'workspace'));
    expect(validatedWorkflowStagedDirectory(run, staged, 'scripts')).toBe(staged);
    expect(validatedWorkflowStagedDirectory(run, staged, 'skills')).toBeUndefined();
    expect(validatedWorkflowStagedDirectory(run, run, 'scripts')).toBeUndefined();
    expect(validatedWorkflowStagedDirectory(run, join(run, 'workspace'), 'scripts')).toBeUndefined();
    expect(validatedWorkflowStagedDirectory(run, source, 'scripts')).toBeUndefined();
  });

  it('fails closed on a tiny content budget before accepting an untrusted resource tree', () => {
    writeFileSync(join(source, 'example.txt'), 'two bytes or more');
    expect(() => copyWorkflowStagedDirectory(source, run, 'scripts', { maxBytes: 1 })).toThrow(/limit|bytes/i);
  });

  it('shares one byte budget across selected artifact inputs', () => {
    for (const name of ['first', 'second']) {
      mkdirSync(join(source, name));
      writeFileSync(join(source, name, 'example.txt'), 'a');
    }
    expect(() =>
      copyWorkflowResourceDirectory(source, run, 'inputs', {
        rootDirectories: new Set(['first', 'second']),
        maxBytes: 1,
      }),
    ).toThrow(/bytes/i);
  });

  it.each([{ maxEntries: 1 }, { maxDepth: 0 }])('rejects a tiny tree beyond %j', (limits) => {
    mkdirSync(join(source, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(source, 'nested', 'deeper', 'example.txt'), 'a');
    expect(() => copyWorkflowResourceDirectory(source, run, 'inputs', limits)).toThrow(/entry|depth/);
  });
});
