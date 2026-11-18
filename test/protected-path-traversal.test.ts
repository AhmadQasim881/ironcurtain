import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePathLinkChain } from '../src/types/argument-roles.js';
import { validateWorkspacePath } from '../src/session/workspace-validation.js';

describe('protected path traversal metadata', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ic-path-components-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('retains ordinary components even when a later parent component removes them from the final target', () => {
    const workspace = join(root, 'workspace');
    const component = join(workspace, 'ordinary-directory');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(component, { recursive: true });
    mkdirSync(elsewhere);
    const name = join(root, 'protected-note-name');
    symlinkSync(`${component}/../../elsewhere/ordinary-note`, name);
    const chain = resolvePathLinkChain(name);
    expect(chain.target).toBe(join(elsewhere, 'ordinary-note'));
    expect(chain.links).toEqual([name]);
    expect(chain).toHaveProperty('components', expect.arrayContaining([workspace, component]));
    expect(() => validateWorkspacePath(workspace, [name])).toThrow('a traversed component');
    const unrelated = join(root, 'unrelated-workspace');
    mkdirSync(unrelated);
    expect(validateWorkspacePath(unrelated, [name])).toBe(unrelated);
  });
});
