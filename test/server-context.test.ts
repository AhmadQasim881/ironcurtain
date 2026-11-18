import { describe, it, expect } from 'vitest';
import {
  updateServerContext,
  formatServerContext,
  type ServerContextMap,
} from '../src/trusted-process/server-context.js';

describe('updateServerContext', () => {
  it('captures working directory from git_set_working_dir', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/home/user/repo' });
    expect(map.get('git')?.workingDirectory).toBe('/home/user/repo');
  });

  it('does not take the working directory from git_clone (path is only the clone destination)', () => {
    // git-mcp-server's git_clone (destination `path` since 2.15) never changes
    // the session working directory, so neither does IronCurtain's mirror of it.
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_clone', {
      url: 'https://github.com/user/repo.git',
      path: '/tmp/cloned-repo',
    });
    expect(map.has('git')).toBe(false);

    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/home/user/repo' });
    updateServerContext(map, 'git', 'git_clone', { url: 'https://github.com/user/other.git', path: '/tmp/other' });
    expect(map.get('git')?.workingDirectory).toBe('/home/user/repo');
  });

  it('ignores the pre-2.15 localPath key as well', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_clone', { url: 'https://github.com/user/repo.git', localPath: '/tmp/x' });
    expect(map.has('git')).toBe(false);
  });

  it('clears the working directory on git_clear_working_dir', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/home/user/repo' });
    updateServerContext(map, 'git', 'git_clear_working_dir', { confirm: 'Y' });
    expect(map.get('git')?.workingDirectory).toBeUndefined();
    expect(formatServerContext(map, 'git')).toBeUndefined();

    // A new git_set_working_dir sets it again.
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/home/user/next' });
    expect(map.get('git')?.workingDirectory).toBe('/home/user/next');
  });

  it('git_clear_working_dir without a tracked directory is a no-op', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_clear_working_dir', { confirm: 'Y' });
    expect(map.has('git')).toBe(false);
  });

  it('does not treat Object.prototype keys as working-directory tools', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'constructor', { constructor: '/tmp/x' });
    updateServerContext(map, 'git', 'toString', { toString: '/tmp/x' });
    expect(map.has('git')).toBe(false);
  });

  it('ignores unrelated tools', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'fs', 'read_file', { path: '/etc/hosts' });
    expect(map.has('fs')).toBe(false);
  });

  it('ignores git_set_working_dir with non-string path', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: 123 });
    expect(map.has('git')).toBe(false);
  });

  it('updates existing context on subsequent calls', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/first' });
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/second' });
    expect(map.get('git')?.workingDirectory).toBe('/second');
  });
});

describe('formatServerContext', () => {
  it('returns undefined when no context exists', () => {
    const map: ServerContextMap = new Map();
    expect(formatServerContext(map, 'git')).toBeUndefined();
  });

  it('returns working directory when set', () => {
    const map: ServerContextMap = new Map();
    map.set('git', { workingDirectory: '/home/user/repo' });
    expect(formatServerContext(map, 'git')).toEqual({ 'Working directory': '/home/user/repo' });
  });

  it('returns undefined when context has no populated fields', () => {
    const map: ServerContextMap = new Map();
    map.set('git', {});
    expect(formatServerContext(map, 'git')).toBeUndefined();
  });
});
