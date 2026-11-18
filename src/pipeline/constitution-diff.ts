/**
 * Line-level helpers shared by the constitution customizers and the review
 * of learned amendments: merging proposed statements into a constitution and
 * showing the change as a diff.
 */

import chalk from 'chalk';
import { toDisplayText } from '../terminal/display-sanitize.js';

/**
 * Merges LLM-proposed changes into the current constitution text.
 * Removes lines matching `removeRules`, then appends `addRules`.
 */
export function applyChanges(current: string, addRules: string[], removeRules: string[]): string {
  let lines = current.split('\n');

  // Remove lines that match removeRules (normalized comparison: strip
  // leading whitespace, bullet prefixes like "- " or "* ", and trailing space)
  if (removeRules.length > 0) {
    const normalize = (s: string) => s.trim().replace(/^[-*]\s*/, '');
    const removals = new Set(removeRules.map(normalize));
    lines = lines.filter((line) => !removals.has(normalize(line)));
  }

  // Remove trailing blank lines before appending
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Append new rules
  for (const rule of addRules) {
    lines.push(` - ${rule}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Line-Level Diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

/**
 * Computes a simple line-level diff between two texts.
 * Uses a longest common subsequence approach for accuracy.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) return newLines.map((text) => ({ type: 'added', text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ type: 'removed', text }));

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'unchanged', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Formats a line diff with chalk colors for terminal display.
 * Red for removed, green for added, plain for unchanged context.
 */
export function formatDiff(diff: DiffLine[]): string {
  return diff
    .map((line) => {
      // Escape each source line before adding trusted diff styling. No
      // proposed permission is removed or shortened for review.
      const text = toDisplayText(line.text);
      switch (line.type) {
        case 'added':
          return chalk.green(`+ ${text}`);
        case 'removed':
          return chalk.red(`- ${text}`);
        case 'unchanged':
          return `  ${text}`;
      }
    })
    .join('\n');
}
