/**
 * The model store the suites that load the real embedding and re-ranking
 * models use (see test/setup/test-models.global.ts).
 *
 * `testModelEnv()` returns the MEMORY_* variables that point the server at it:
 * pass it to `loadConfig()` (or to a spawned server's environment) wherever a
 * test needs real models. It is empty when the run found no local copy of the
 * models; the suite then uses the built-in pins and downloads them.
 */

import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    memoryTestModelEnv: Record<string, string>;
  }
}

export function testModelEnv(): Record<string, string> {
  return { ...inject('memoryTestModelEnv') };
}
