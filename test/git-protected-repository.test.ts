import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const annotations: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    git: {
      inputHash: '',
      tools: [
        {
          serverName: 'git',
          toolName: 'git_add',
          comment: '',
          inputSchema: {},
          args: { path: ['read-path', 'write-history'], paths: ['none'] },
        },
        {
          serverName: 'git',
          toolName: 'git_show',
          comment: '',
          inputSchema: {},
          args: { path: ['read-path'], object: ['none'], filePath: ['none'] },
        },
        { serverName: 'git', toolName: 'git_status', comment: '', inputSchema: {}, args: { path: ['read-path'] } },
        {
          serverName: 'git',
          toolName: 'git_wrapup_instructions',
          comment: '',
          inputSchema: {},
          args: { acknowledgement: ['none'] },
        },
        {
          serverName: 'git',
          toolName: 'git_clear_working_dir',
          comment: '',
          inputSchema: {},
          args: { confirm: ['none'] },
        },
      ],
    },
  },
};
const request = (toolName: string, args: Record<string, unknown>) => ({
  requestId: 'fixture',
  serverName: 'git',
  toolName,
  arguments: args,
  timestamp: '',
});

describe('Git repository admission around specific protected descendants', () => {
  let root: string;
  let workspace: string;
  let repo: string;
  let protectedNote: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-git-protected-repo-')));
    workspace = join(root, 'workspace');
    repo = join(workspace, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'subdirectory'));
    protectedNote = join(repo, 'protected-note');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function engine(paths = [protectedNote], toolAnnotations = annotations) {
    return new PolicyEngine(
      {
        generatedAt: '',
        inputHash: '',
        constitutionHash: '',
        rules: [
          { name: 'fixture-allow', description: '', principle: '', if: { server: ['git'] }, then: 'allow', reason: '' },
        ],
      },
      toolAnnotations,
      paths,
      workspace,
    );
  }

  it('denies a repository from a selected subdirectory without interpreting selectors', () => {
    expect(
      engine().evaluate(request('git_add', { path: join(repo, 'subdirectory'), paths: ['ordinary-note'] })),
    ).toMatchObject({ decision: 'deny', rule: 'structural-git-protected-repository' });
    expect(
      engine().evaluate(request('git_show', { path: repo, object: 'HEAD', filePath: 'ordinary-note' })),
    ).toMatchObject({ decision: 'deny', rule: 'structural-git-protected-repository' });
  });
  it('preserves the broad protected-ancestor sandbox exemption', () => {
    expect(engine([root]).evaluate(request('git_status', { path: repo })).decision).toBe('allow');
  });
  it('uses the current target of an original protected name', () => {
    const name = join(root, 'protected-note-name');
    symlinkSync(protectedNote, name);
    expect(engine([name]).evaluate(request('git_status', { path: repo }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-git-protected-repository',
    });
  });
  it('refuses wrap-up without trusted context and permits clearing context', () => {
    const result = engine([]).evaluate(request('git_wrapup_instructions', { acknowledgement: 'yes' }));
    expect(result).toMatchObject({ decision: 'deny', rule: 'structural-git-context-deny' });
    expect(result.reason).toContain('git_set_working_dir');
    expect(engine().evaluate(request('git_clear_working_dir', { confirm: true })).decision).toBe('allow');
  });

  it('uses separate trusted wrap-up context and keeps per-call approval for a clean repository', () => {
    const call = request('git_wrapup_instructions', { acknowledgement: 'yes' });
    expect(engine().evaluate(call, { gitWorkingDirectory: repo })).toMatchObject({
      decision: 'deny',
      rule: 'structural-git-protected-repository',
    });
    expect(engine([]).evaluate(call, { gitWorkingDirectory: repo })).toMatchObject({
      decision: 'escalate',
      humanOnly: true,
    });
    expect(
      engine([]).evaluate(request('git_wrapup_instructions', { acknowledgement: 'yes', gitWorkingDirectory: repo })),
    ).toMatchObject({ decision: 'deny', rule: 'structural-git-context-deny' });
  });

  it('checks explicit repository selectors even when an older annotation marks them opaque', () => {
    const opaque: StoredToolAnnotationsFile = {
      ...annotations,
      servers: {
        git: { ...annotations.servers.git, tools: [{ ...annotations.servers.git.tools[2], args: { path: ['none'] } }] },
      },
    };
    expect(engine([protectedNote], opaque).evaluate(request('git_status', { path: repo }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-git-protected-repository',
    });
    expect(engine([], opaque).evaluate(request('git_status', { path: repo })).decision).toBe('allow');
    expect(
      engine([protectedNote], opaque).evaluate(request('git_status', { path: 'repo' }), {
        gitWorkingDirectory: workspace,
      }),
    ).toMatchObject({ decision: 'deny', rule: 'structural-git-protected-repository' });
    expect(engine([], opaque).evaluate(request('git_status', { path: 'repo' }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-git-context-deny',
    });
  });
});
