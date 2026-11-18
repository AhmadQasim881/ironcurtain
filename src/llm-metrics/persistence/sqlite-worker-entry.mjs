/**
 * Worker entry point for source runs.
 *
 * Registers the TypeScript specifier remap hook in-thread so the worker never
 * depends on loaders inherited from the parent process, then loads the real
 * worker. Source runs always start the worker through this shim with an
 * explicit `execArgv` (see defaultWorkerFactory in sqlite-repository.ts), so
 * the parent's tsx hooks are never inherited on any Node version; the shim is
 * required for every source run. The compiled dist build spawns
 * sqlite-worker.js directly and bypasses this shim.
 *
 * `module.registerHooks` (Node >= 22.15) is required: it is the synchronous
 * hooks API, and the remap hook below depends on `nextResolve` throwing
 * synchronously. The async `module.register()` API returns a promise instead,
 * so the hook's fallback would never fire there. Every Node line the package
 * supports (`engines`: 24 and 26) has it.
 */

import * as nodeModule from 'node:module';
import { resolve } from './ts-specifier-remap.mjs';

nodeModule.registerHooks({ resolve });

await import('./sqlite-worker.ts');
