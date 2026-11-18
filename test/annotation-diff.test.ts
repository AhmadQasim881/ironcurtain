/**
 * `annotate-tools --diff` (WP-88 / GAP1-9): the role diff between the
 * annotations in effect before and after a run.
 */

import { describe, expect, it } from 'vitest';
import { diffToolAnnotations, formatAnnotationDiff, formatRoleSpec } from '../src/pipeline/annotation-diff.js';
import type { StoredToolAnnotation } from '../src/pipeline/types.js';

function tool(
  toolName: string,
  args: StoredToolAnnotation['args'],
  comment = `${toolName} tool`,
): StoredToolAnnotation {
  return { toolName, serverName: 'git', comment, args, inputSchema: {} };
}

const BRANCH_CONDITIONAL = {
  default: ['read-path' as const, 'write-history' as const],
  when: [{ condition: { arg: 'operation', equals: 'list' }, roles: ['read-path' as const] }],
};

describe('diffToolAnnotations', () => {
  it('reports added, removed and changed tools, and counts the unchanged ones', () => {
    const before = [
      tool('git_status', { path: ['read-path'] }),
      tool('git_branch', { path: ['read-path', 'write-history'], operation: ['none'] }),
      tool('git_gone', { path: ['read-path'] }),
    ];
    const after = [
      tool('git_status', { path: ['read-path'] }),
      tool('git_branch', { path: BRANCH_CONDITIONAL, operation: ['none'], force: ['none'] }, 'Branches (reworded).'),
      tool('git_new', { url: ['git-remote-url'] }),
    ];

    const diff = diffToolAnnotations(before, after);

    expect(diff.unchanged).toBe(1);
    expect(diff.changes).toEqual([
      {
        kind: 'changed',
        toolName: 'git_branch',
        args: [
          { arg: 'path', before: ['read-path', 'write-history'], after: BRANCH_CONDITIONAL },
          { arg: 'force', after: ['none'] },
        ],
        commentChanged: true,
      },
      { kind: 'added', toolName: 'git_new', after: after[2] },
      { kind: 'removed', toolName: 'git_gone' },
    ]);
  });

  it('ignores differences that are not roles or comments', () => {
    const before = [{ ...tool('git_log', { path: ['read-path'] }), inputSchema: { a: 1 }, annotationKey: 'old' }];
    const after = [{ ...tool('git_log', { path: ['read-path'] }), inputSchema: { a: 2 }, annotationKey: 'new' }];
    expect(diffToolAnnotations(before, after)).toEqual({ changes: [], unchanged: 1 });
  });
});

describe('formatAnnotationDiff', () => {
  it('renders each change with the roles before and after', () => {
    const before = [tool('git_branch', { path: ['read-path', 'write-history'] }), tool('git_gone', {})];
    const after = [tool('git_branch', { path: BRANCH_CONDITIONAL }), tool('git_new', {}, 'Does a new thing.')];

    expect(formatAnnotationDiff('git', diffToolAnnotations(before, after))).toEqual([
      'git: 1 changed, 1 added, 1 removed, 0 unchanged',
      '  ~ git_branch',
      '      path: [read-path, write-history] -> default=[read-path, write-history]; when operation="list" -> [read-path]',
      '  + git_new -- Does a new thing.',
      '      (no arguments)',
      '  - git_gone',
    ]);
  });

  it('prints nothing when nothing changed', () => {
    const same = [tool('git_log', { path: ['read-path'] })];
    expect(formatAnnotationDiff('git', diffToolAnnotations(same, same))).toEqual([]);
  });

  it('renders tool names and comments from the server and the LLM display-safe', () => {
    const lines = formatAnnotationDiff(
      'evil',
      diffToolAnnotations([], [tool('x\u001b]52;c;payload\u0007', { 'a‮b': ['none'] }, 'clear\u001b[2J')]),
    );
    const text = lines.join('\n');
    // eslint-disable-next-line no-control-regex -- asserting that no raw control character survives
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f‮]/);
    expect(text).toContain('x\\u001b]52;c;payload\\u0007');
  });

  it('formats absent, static and conditional role specs', () => {
    expect(formatRoleSpec(undefined)).toBe('(none)');
    expect(formatRoleSpec(['read-path'])).toBe('[read-path]');
    expect(
      formatRoleSpec({
        default: ['read-path'],
        when: [
          { condition: { arg: 'mode', in: ['a', 'b'] }, roles: ['read-path'] },
          { condition: { arg: 'dry', is: 'truthy' }, roles: [] },
        ],
      }),
    ).toBe('default=[read-path]; when mode in ["a","b"] -> [read-path]; when dry is truthy -> []');
  });
});
