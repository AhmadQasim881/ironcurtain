/**
 * memory_store tool handler.
 * Validates input and delegates to the engine.
 *
 * Content and tags that contain a secret value are rejected (memory never keeps
 * secrets; see utils/secrets.ts), and importance above MAX_AGENT_IMPORTANCE is
 * stored as that cap. Who wrote the memory is recorded by the engine from the
 * host-set writer, never from these arguments.
 */

import type { MemoryEngine } from '../engine.js';
import type { StoreResult } from '../types.js';
import { MAX_CONTENT_LENGTH, capImportance, validateTags } from './validation.js';
import { assertNoSecret } from '../utils/secrets.js';

export interface StoreInput {
  content: string;
  tags?: string[];
  importance?: number;
}

export function validateStoreInput(args: Record<string, unknown>): StoreInput {
  const content = args.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('content is required and must be a non-empty string');
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
  }

  const tags = validateTags(args.tags);

  const importance = args.importance;
  if (importance !== undefined) {
    if (typeof importance !== 'number' || !Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new Error('importance must be a number between 0 and 1');
    }
  }

  assertNoSecret(content, 'content');
  for (const tag of tags ?? []) assertNoSecret(tag, 'a tag');

  return {
    content: content.trim(),
    tags,
    importance: capImportance(importance),
  };
}

export function formatStoreResult(result: StoreResult): string {
  switch (result.action) {
    case 'created':
      return `Stored memory ${result.id}`;
    case 'merged_duplicate':
      return `Merged with existing memory ${result.id} (duplicate detected)`;
    case 'contradiction_resolved':
      return `Updated memory ${result.id} (contradiction resolved — new content supersedes old)`;
  }
}

export async function handleStore(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateStoreInput(args);
  const result = await engine.store(input.content, {
    tags: input.tags,
    importance: input.importance,
  });
  return formatStoreResult(result);
}
