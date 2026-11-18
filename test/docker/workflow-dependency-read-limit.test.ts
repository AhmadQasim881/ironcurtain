import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reader = vi.hoisted(() => ({ path: '', calls: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (String(args[0]) !== reader.path) return handle;
      return {
        stat: () => handle.stat(),
        close: () => handle.close(),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          reader.calls++;
          const count = Math.min(length, Math.max(0, 2 - position));
          buffer.fill(0x61, offset, offset + count);
          return { bytesRead: count, buffer };
        },
      };
    },
  };
});

import { buildDependencyTreeManifest } from '../../src/docker/workflow-dependency-cache.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dependency-read-limit-'));
  const tree = join(root, 'tree');
  mkdirSync(tree);
  reader.path = join(tree, 'example.txt');
  reader.calls = 0;
  writeFileSync(reader.path, 'a');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('stops on the first read beyond the recorded file size instead of continuing until EOF', async () => {
  await expect(buildDependencyTreeManifest(join(root, 'tree'), { maxBytes: 1 })).rejects.toThrow(/byte limit/);
  expect(reader.calls).toBe(1);
});
