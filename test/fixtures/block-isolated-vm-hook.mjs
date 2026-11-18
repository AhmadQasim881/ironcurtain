// Loaded with `node --import <this file>` to simulate a host where the V8
// sandbox cannot load (an unsupported Node.js, a stale native build): every
// resolution of isolated-vm or @utcp/code-mode (which loads it) fails. The
// synchronous hooks of module.registerHooks apply to import(), require() and
// createRequire().resolve() alike, so the CLI's sandbox preflight
// (checkSandboxViability) fails too, as it would on such a host.
import { registerHooks } from 'node:module';

const BLOCKED = /^(?:isolated-vm|@utcp\/code-mode)(?:\/|$)/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BLOCKED.test(specifier)) {
      const error = new Error(`Cannot find package '${specifier}' (blocked: this test simulates a host without it)`);
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return nextResolve(specifier, context);
  },
});
