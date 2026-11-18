import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const annotations: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    filesystem: {
      inputHash: '',
      tools: [
        {
          serverName: 'filesystem',
          toolName: 'read_file',
          comment: '',
          inputSchema: {},
          args: { path: ['read-path'] },
        },
      ],
    },
  },
};
const policy = (within: string): CompiledPolicyFile => ({
  generatedAt: '',
  inputHash: '',
  constitutionHash: '',
  rules: [
    {
      name: 'reviewed-root',
      description: '',
      principle: '',
      if: { server: ['filesystem'], paths: { roles: ['read-path'], within } },
      then: 'allow',
      reason: '',
    },
  ],
});
const request = (path: string) => ({
  requestId: 'fixture',
  serverName: 'filesystem',
  toolName: 'read_file',
  arguments: { path },
  timestamp: '',
});

describe('workspace-derived policy roots at engine construction', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-policy-root-')));
    workspace = join(root, 'workspace');
    outside = join(root, 'ordinary-outside');
    mkdirSync(workspace);
    mkdirSync(outside);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('refuses an escaped workspace rule root when a replacement engine is constructed', () => {
    const within = join(workspace, 'reports');
    mkdirSync(within);
    const original = new PolicyEngine(policy(within), annotations, [], workspace);
    renameSync(within, join(workspace, 'previous-reports'));
    symlinkSync(outside, within);
    const replacement = new PolicyEngine(policy(within), annotations, [], workspace);
    expect(original.evaluate(request(join(outside, 'ordinary-note'))).decision).toBe('deny');
    expect(replacement.evaluate(request(join(outside, 'ordinary-note')))).toMatchObject({
      decision: 'deny',
      rule: 'structural-unsafe-policy-root',
    });
  });

  it('checks a link in a root ancestor and applies the same defense to a task scope', () => {
    const parent = join(workspace, 'reports');
    symlinkSync(outside, parent);
    const within = join(parent, 'nested');
    const engine = new PolicyEngine(policy(outside), annotations, [], workspace, undefined, undefined, undefined, {
      compiledPolicy: policy(within),
    });
    expect(engine.evaluate(request(join(outside, 'nested', 'ordinary-note')))).toMatchObject({
      decision: 'deny',
      rule: 'structural-unsafe-policy-root',
    });
  });

  it('preserves explicitly trusted external roots and workspace links staying inside it', () => {
    const externalName = join(root, 'trusted-reports');
    symlinkSync(outside, externalName);
    expect(
      new PolicyEngine(policy(externalName), annotations, [], workspace).evaluate(
        request(join(outside, 'ordinary-note')),
      ).decision,
    ).toBe('allow');
    const reports = join(workspace, 'reports');
    mkdirSync(reports);
    symlinkSync(reports, join(workspace, 'current-reports'));
    expect(
      new PolicyEngine(policy(join(workspace, 'current-reports')), annotations, [], workspace).evaluate(
        request(join(reports, 'ordinary-note')),
      ).decision,
    ).toBe('allow');
  });

  it('also refuses an external name whose controlling chain passes through the workspace', () => {
    const mutableLink = join(workspace, 'current-reports');
    symlinkSync(outside, mutableLink);
    const externalName = join(root, 'reviewed-name');
    symlinkSync(mutableLink, externalName);
    const engine = new PolicyEngine(policy(externalName), annotations, [], workspace);
    expect(engine.evaluate(request(join(outside, 'ordinary-note')))).toMatchObject({
      decision: 'deny',
      rule: 'structural-unsafe-policy-root',
    });
  });
});
