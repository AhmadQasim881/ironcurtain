import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const base = join(tmpdir(), 'ic-protected-ancestor-fixture');
const workspace = join(base, 'workspace');
const annotations: StoredToolAnnotationsFile = {
  generatedAt: '',
  servers: {
    filesystem: {
      inputHash: '',
      tools: [
        {
          serverName: 'filesystem',
          toolName: 'move_file',
          comment: '',
          inputSchema: {},
          args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
        },
        {
          serverName: 'filesystem',
          toolName: 'remove_directory',
          comment: '',
          inputSchema: {},
          args: { path: ['delete-path'] },
        },
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
function engine(protectedPaths: string[], sandbox = workspace) {
  return new PolicyEngine(
    {
      generatedAt: '',
      inputHash: '',
      constitutionHash: '',
      rules: [
        {
          name: 'fixture-allow',
          description: '',
          principle: '',
          if: { server: ['filesystem'] },
          then: 'allow',
          reason: '',
        },
      ],
    },
    annotations,
    protectedPaths,
    sandbox,
  );
}
const request = (toolName: string, args: Record<string, unknown>) => ({
  requestId: 'fixture',
  serverName: 'filesystem',
  toolName,
  arguments: args,
  timestamp: '',
});

describe('destructive operands containing a protected entry', () => {
  const parent = join(workspace, 'ordinary-folder');
  const protectedNote = join(parent, 'protected-note');
  it('denies a move source containing a protected descendant before compiled allows', () => {
    expect(
      engine([protectedNote]).evaluate(
        request('move_file', { source: parent, destination: join(workspace, 'renamed') }),
      ),
    ).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });
  it('denies removing a containing directory without opening any file', () => {
    expect(engine([protectedNote]).evaluate(request('remove_directory', { path: parent }))).toMatchObject({
      decision: 'deny',
      rule: 'structural-protected-path',
    });
  });
  it('preserves read/list admission, unrelated siblings and the per-entry sandbox exemption', () => {
    expect(engine([protectedNote]).evaluate(request('read_file', { path: parent })).decision).toBe('allow');
    expect(
      engine([protectedNote]).evaluate(request('remove_directory', { path: join(workspace, 'ordinary-folder-other') }))
        .decision,
    ).toBe('allow');
    const home = join(base, 'home');
    const sandbox = join(home, 'sessions', 'ordinary', 'sandbox');
    expect(engine([home], sandbox).evaluate(request('remove_directory', { path: sandbox })).decision).toBe('allow');
    expect(
      engine([home, join(sandbox, 'protected-note')], sandbox).evaluate(request('remove_directory', { path: sandbox })),
    ).toMatchObject({ decision: 'deny', rule: 'structural-protected-path' });
  });
});
