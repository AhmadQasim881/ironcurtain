/**
 * Shared interrupt handling for `start` (batch and PTY) and workflows. A
 * closed terminal or multiplexer PTY delivers SIGHUP twice (kernel and
 * session leader) and then fails every write with EIO; neither may cut the
 * teardown short.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdownSignals, shutdownSignalOf } from '../src/utils/shutdown-signals.js';

/**
 * The `signal` listener installed since `before` was captured, typed as Node
 * types the signal's listeners: call it with the signal it was installed for.
 */
function installedHandler(signal: NodeJS.Signals, before: ReadonlySet<unknown>) {
  const handler = process.listeners(signal).find((listener) => !before.has(listener));
  if (!handler) throw new Error(`no ${signal} handler was installed`);
  return handler;
}

describe('installShutdownSignals', () => {
  it('ignores the second SIGHUP of a hangup but still forces exit on a later SIGINT', () => {
    const beforeHup = new Set<unknown>(process.listeners('SIGHUP'));
    const beforeInt = new Set<unknown>(process.listeners('SIGINT'));
    const controller = new AbortController();
    const forceExit = vi.fn();
    const uninstall = installShutdownSignals(controller, { forceExit, stdio: [] });
    try {
      const hangup = installedHandler('SIGHUP', beforeHup);
      hangup('SIGHUP');
      hangup('SIGHUP');

      expect(controller.signal.aborted).toBe(true);
      expect(shutdownSignalOf(controller.signal)).toBe('SIGHUP');
      expect(forceExit).not.toHaveBeenCalled();

      installedHandler('SIGINT', beforeInt)('SIGINT');
      expect(forceExit).toHaveBeenCalledWith(130);
    } finally {
      uninstall();
    }
  });

  it('handles only the signals given, leaving the others with their existing disposition', () => {
    // Outside a terminal the daemon passes SIGINT and SIGTERM only and
    // ignores SIGHUP with a listener of its own (installDaemonShutdownSignals;
    // Node resets the ignored SIGHUP `nohup` sets, so none is inherited).
    const hupBefore = process.listenerCount('SIGHUP');
    const intBefore = new Set<unknown>(process.listeners('SIGINT'));
    const termBefore = new Set<unknown>(process.listeners('SIGTERM'));
    const controller = new AbortController();
    const forceExit = vi.fn();
    const uninstall = installShutdownSignals(controller, {
      signals: ['SIGINT', 'SIGTERM', 'SIGINT'],
      forceExit,
      stdio: [],
    });
    try {
      expect(process.listenerCount('SIGHUP')).toBe(hupBefore);
      expect(process.listenerCount('SIGINT')).toBe(intBefore.size + 1);
      expect(process.listenerCount('SIGTERM')).toBe(termBefore.size + 1);

      installedHandler('SIGTERM', termBefore)('SIGTERM');
      expect(shutdownSignalOf(controller.signal)).toBe('SIGTERM');
      installedHandler('SIGINT', intBefore)('SIGINT');
      expect(forceExit).toHaveBeenCalledWith(130);
    } finally {
      uninstall();
    }
    expect(new Set<unknown>(process.listeners('SIGINT'))).toEqual(intBefore);
    expect(new Set<unknown>(process.listeners('SIGTERM'))).toEqual(termBefore);
    expect(process.listenerCount('SIGHUP')).toBe(hupBefore);
  });

  it('swallows stdio stream errors from the first signal until uninstall', () => {
    const before = new Set<unknown>(process.listeners('SIGTERM'));
    const stdout = new EventEmitter();
    const uninstall = installShutdownSignals(new AbortController(), { forceExit: vi.fn(), stdio: [stdout] });
    const eio = Object.assign(new Error('write EIO'), { code: 'EIO' });

    // Before any signal a stream error still surfaces as usual.
    expect(() => stdout.emit('error', eio)).toThrow('write EIO');
    installedHandler('SIGTERM', before)('SIGTERM');
    // A spinner frame written to a hung-up terminal must not crash teardown.
    expect(() => stdout.emit('error', eio)).not.toThrow();

    uninstall();
    expect(stdout.listenerCount('error')).toBe(0);
    expect(new Set(process.listeners('SIGTERM'))).toEqual(before);
  });
});
