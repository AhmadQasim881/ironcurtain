/**
 * A controllable stand-in for PtyBridge (src/pty/pty-bridge.ts) that spawns
 * nothing: tests inject it through `PtySessionManagerOptions.createBridge`
 * and fire onData / onExit / onSessionDiscovered themselves.
 */

import { vi } from 'vitest';
import type { PtySessionRegistration } from '../../src/docker/pty-types.js';

/** Controllable stub PtyBridge: fire onData/onExit/onSessionDiscovered at will. */
export class StubBridge {
  alive = true;
  exitCode: number | undefined;
  readonly sessionId: string | undefined = 'stub-session';
  escalationDir: string | undefined;
  readonly pid = 4242;
  serializeReturn = 'SNAPSHOT';

  private readonly dataCbs: Array<(chunk: string) => void> = [];
  private readonly exitCbs: Array<(code: number) => void> = [];
  private readonly sessionCbs: Array<(reg: PtySessionRegistration | null) => void> = [];

  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn<(cols: number, rows: number) => void>();
  readonly kill = vi.fn(() => this.emitExit(0));

  onOutput(): void {}
  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.push(cb);
    return () => {
      const i = this.dataCbs.indexOf(cb);
      if (i !== -1) this.dataCbs.splice(i, 1);
    };
  }
  serialize(): string {
    return this.serializeReturn;
  }
  onExit(cb: (code: number) => void): void {
    if (!this.alive && this.exitCode !== undefined) cb(this.exitCode);
    else this.exitCbs.push(cb);
  }
  onSessionDiscovered(cb: (reg: PtySessionRegistration | null) => void): void {
    this.sessionCbs.push(cb);
  }
  updateRegistration(): void {}

  // --- test drivers ---
  emitData(chunk: string): void {
    for (const cb of [...this.dataCbs]) cb(chunk);
  }
  emitExit(code: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = code;
    for (const cb of [...this.exitCbs]) cb(code);
  }
  emitDiscovered(reg: PtySessionRegistration | null): void {
    for (const cb of [...this.sessionCbs]) cb(reg);
  }
}
