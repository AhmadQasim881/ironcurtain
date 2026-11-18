import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openEditorForMultiline } from '../src/utils/editor.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

describe('private editor scratch files', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('creates an owner-only file in a private directory and removes editor backups too', () => {
    vi.stubEnv('VISUAL', 'fixture-editor');
    let scratch = '';
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const path = String(args?.[0]);
      scratch = dirname(path);
      expect(scratch).not.toBe(tmpdir());
      expect(basename(scratch)).toMatch(/^ironcurtain-test-/);
      expect(statSync(scratch).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('# Example instructions\n\nInitial content');
      writeFileSync(path, '# Example instructions\n\nEdited content\n');
      writeFileSync(join(scratch, 'editor-backup.md'), 'Ordinary editor backup');
      return { status: 0, signal: null, output: [], pid: 0, stdout: '', stderr: '' };
    });
    expect(openEditorForMultiline('Example instructions', 'Initial content', { prefix: 'ironcurtain-test' })).toBe(
      'Edited content',
    );
    expect(spawnSync).toHaveBeenCalledWith('fixture-editor', [join(scratch, 'content.md')], { stdio: 'inherit' });
    expect(existsSync(scratch)).toBe(false);
  });

  it('removes the private directory when launching the editor fails', () => {
    let scratch = '';
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      scratch = dirname(String(args?.[0]));
      expect(scratch).not.toBe(tmpdir());
      throw new Error('Fixture launch failure');
    });
    expect(() => openEditorForMultiline('Example instructions')).toThrow('Fixture launch failure');
    expect(existsSync(scratch)).toBe(false);
  });
});
