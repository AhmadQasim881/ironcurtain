/**
 * Disk usage of directory trees under the IronCurtain home, for the prune
 * report and `ironcurtain doctor`.
 *
 * Trees are walked with `lstat` only: a symlink counts as itself and is never
 * followed, so a link an agent left in a workspace cannot make the walk leave
 * the tree. Sizes are allocated bytes (`st_blocks * 512`, what `du` reports),
 * or the apparent size where the platform has no block count. A walk stops
 * after a budget of entries and then reports a lower bound.
 *
 * Asynchronous (fs/promises), so a walk in the daemon never blocks its event
 * loop for long.
 *
 * Leaf module: Node built-ins only.
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';

/** Entries one walk visits at most (a lower bound is reported past it). */
export const DEFAULT_WALK_ENTRY_BUDGET = 2_000_000;

/** What a walk of one tree found. */
export interface TreeUsage {
  /** Allocated bytes of every entry visited (the root included). */
  readonly bytes: number;
  /** Entries visited. */
  readonly entries: number;
  /** True when the walk stopped early (entry budget, abort): `bytes` is a lower bound. */
  readonly partial: boolean;
}

export interface MeasureOptions {
  /** Entries to visit at most. Default {@link DEFAULT_WALK_ENTRY_BUDGET}. */
  readonly entryBudget?: number;
  /** Stops the walk (the result is then partial). */
  readonly signal?: AbortSignal;
}

/** Allocated size of one entry: `st_blocks * 512`, else the apparent size. */
export function allocatedBytes(stats: Pick<Stats, 'blocks' | 'size'>): number {
  return Number.isFinite(stats.blocks) && stats.blocks >= 0 ? stats.blocks * 512 : stats.size;
}

/**
 * Measures the tree at `root` without following symlinks. A missing root is
 * empty; entries that vanish or cannot be read during the walk are skipped.
 */
export async function measureTree(root: string, options: MeasureOptions = {}): Promise<TreeUsage> {
  const budget = options.entryBudget ?? DEFAULT_WALK_ENTRY_BUDGET;
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (entries >= budget || options.signal?.aborted === true) return { bytes, entries, partial: true };
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch {
      continue; // gone, or not ours to read
    }
    entries += 1;
    bytes += allocatedBytes(stats);
    if (!stats.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      continue;
    }
    for (const name of names) pending.push(join(path, name));
  }
  return { bytes, entries, partial: false };
}

/** Bytes as a short human-readable size (`512 B`, `3.4 MB`, `1.2 GB`; powers of 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
