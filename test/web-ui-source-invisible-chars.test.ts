/**
 * The web UI shows the human every invisible or direction-changing character
 * in agent-chosen text as a visible escape (packages/web-ui/src/lib/
 * unicode-display.ts). Its own sources must not carry such characters raw: a
 * bidi override in a comment or string literal makes the code read
 * differently from what it does (Trojan Source), and a test that feeds one
 * must spell it as a backslash-u escape so the reviewer can see it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');

/** The approval UI, its end-to-end tests and the daemon side that serves it. */
const ROOTS = ['packages/web-ui/src', 'packages/web-ui/e2e', 'src/web-ui'];
const SOURCE_FILE = /\.(?:ts|mts|js|mjs|svelte|css|html)$/;

/**
 * What the UI escapes for display, minus the whitespace controls source files
 * legitimately contain. An emoji's presentation selector, which the UI shows
 * as itself, is spelled as an escape in source too.
 */
const RAW_INVISIBLE = /(?![\n\r\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

function sourceFiles(root: string): string[] {
  const entries = readdirSync(join(projectRoot, root), { recursive: true, encoding: 'utf8' });
  return entries.filter((entry) => SOURCE_FILE.test(entry)).map((entry) => join(root, entry));
}

describe('web UI sources', () => {
  it('contain no raw invisible, bidi or control characters', () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(projectRoot, file), 'utf8');
      for (const match of text.matchAll(RAW_INVISIBLE)) {
        const line = text.slice(0, match.index).split('\n').length;
        const codePoint = match[0].codePointAt(0) ?? 0;
        offenders.push(`${file}:${line} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
