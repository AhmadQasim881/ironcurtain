/**
 * MuxEscalationManager -- manages escalation watchers for all PTY sessions.
 *
 * Wraps the existing EscalationWatcher and ListenerState modules for the
 * mux context. Creates watchers directly when sessions are spawned, and
 * optionally polls the PTY registry for externally-spawned sessions.
 */

import { mkdirSync } from 'node:fs';
import { getListenerLockPath, getPtyRegistryDir } from '../config/paths.js';
import { isOwnedByLiveMux, readActiveRegistrations } from '../escalation/session-registry.js';
import { createEscalationWatcher } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';
import { isListenerLockHeld } from '../escalation/listener-lock.js';
import {
  createInitialState,
  addSession,
  removeSession,
  addEscalation,
  resolveEscalation,
  expireEscalation,
  type ListenerState,
} from '../escalation/listener-state.js';
import {
  DEFAULT_WHITELIST_OPTIONS,
  directoryCandidateIndex,
  type WhitelistScope,
} from '../trusted-process/approval-whitelist.js';
import { escalationGroupKey, escalationGroupPattern } from '../escalation/escalation-groups.js';
import type { PendingRef } from './types.js';
import { sameEscalationSet } from './escalation-picker-state.js';

/** Poll interval for the session registry directory (ms). */
const REGISTRY_POLL_INTERVAL_MS = 1000;

export interface ResolveOptions {
  /**
   * The whitelist pattern to add with an approval. `exact` is the
   * escalation's first candidate, which binds paths exactly (`/approve+ N`,
   * the picker's confirmed `w`); it is never applied to a human-only
   * escalation, which is approved once instead. `directory` is the
   * directory-wide candidate (`/approve+dir N`, the picker's confirmed `W`):
   * when the escalation offers none, nothing is resolved and the message
   * says so. Absent or `false`: no whitelisting.
   */
  readonly whitelist?: false | WhitelistScope;
  /**
   * The request the user decided on. When given, the decision is refused,
   * and nothing is written, unless this is the id of the escalation pending
   * under the display number: a decision applies to what was shown, never
   * to whatever took its place.
   */
  readonly escalationId?: string;
}

export interface MuxEscalationManager {
  /** Current state (sessions, pending escalations, history). */
  readonly state: ListenerState;

  /** Number of pending escalations across all sessions. */
  readonly pendingCount: number;

  /**
   * Registers a session for escalation watching.
   */
  addSession(registration: PtySessionRegistration): void;

  /**
   * Removes a session's watcher.
   */
  removeSession(sessionId: string): void;

  /** Returns pending display numbers in ascending order. */
  sortedDisplayNumbers(): number[];

  /**
   * Every pending escalation as display number and escalation id, in
   * ascending display-number order, each with its whitelist-pattern group
   * key when it is groupable (see escalation/escalation-groups.ts).
   */
  pendingRefs(): PendingRef[];

  /**
   * The pending members of the whitelist-pattern group escalation #N
   * belongs to, #N included, in display-number order; with the group's
   * key and pattern description. Undefined when #N is not pending or is
   * never grouped (human-only, or its first whitelist candidate -- the
   * exact one `/approve+` selects -- has no pattern key).
   */
  groupOf(displayNumber: number): { key: string; description: string; members: PendingRef[] } | undefined;

  /** Resolves a pending escalation by display number (see {@link ResolveOptions}). */
  resolve(displayNumber: number, decision: 'approved' | 'denied', options?: ResolveOptions): string;

  /** Denies every pending escalation, human-only ones included. */
  denyAll(): string;

  /**
   * Approves exactly the escalations the user reviewed on the approve-all
   * screen. Refused, with nothing resolved, unless `reviewed` is precisely
   * the set pending now (same display numbers and escalation ids): one that
   * arrived, expired or was resolved since the list was shown means the
   * user did not review what would be approved. Human-only escalations
   * (`EscalationRequest.humanOnly`, e.g. opening a passthrough domain) in
   * the set stay pending and must be approved one at a time. With
   * `whitelist` (`/approve+ all`) each approved escalation's first
   * candidate pattern (the exact one) is whitelisted; directory-wide
   * patterns are only ever chosen one escalation at a time.
   */
  approveAll(reviewed: readonly PendingRef[], options?: { readonly whitelist?: boolean }): string;

  /**
   * Approves exactly the members of whitelist-pattern group `groupKey` that
   * the user reviewed on the approve-group screen (`/approve group N`).
   * Refused, with nothing resolved, unless `reviewed` is precisely the set
   * of escalations pending in that group now: a member that arrived,
   * expired or was resolved since the list was shown means the user did not
   * review what would be approved. A group never holds a human-only
   * escalation. With `whitelist` (`/approve+ group N`) each approved
   * escalation's exact pattern (the one the group shares) is whitelisted in
   * its own session; directory-wide patterns are never chosen in bulk.
   */
  approveGroup(reviewed: readonly PendingRef[], groupKey: string, options?: { readonly whitelist?: boolean }): string;

  /** Starts polling for externally-spawned sessions. */
  startRegistryPolling(): void;

  /** Stops all watchers and polling. */
  stop(): void;

  /** Register callback for state changes (triggers redraws). */
  onChange(callback: () => void): void;

  /**
   * Registers a callback fired when registry polling discovers a new
   * external session. Used to back-fill bridge registrations that
   * timed out during initial discovery.
   */
  onSessionDiscovered(callback: (reg: PtySessionRegistration) => void): void;

  /**
   * Marks a session ID as managed so registry polling treats it as
   * owned by the mux (won't re-add after removal).
   */
  claimSession(sessionId: string): void;
}

export interface MuxEscalationManagerOptions {
  /** Mux instance ID for session ownership filtering. When absent, all sessions are claimed. */
  readonly muxId?: string;
}

/**
 * Checks whether the standalone escalation listener is currently running:
 * its lock is held by a live process (pid and process-start identity, so a
 * reused pid of a crashed listener does not count).
 */
function isStandaloneListenerRunning(): boolean {
  return isListenerLockHeld(getListenerLockPath());
}

/**
 * Determines whether this mux should claim a registry entry based on ownership.
 * Returns true if the session should be watched by this mux instance.
 */
function shouldClaimSession(
  reg: PtySessionRegistration,
  ourMuxId: string,
  standaloneListenerRunning: boolean,
): boolean {
  if (reg.muxId === ourMuxId) return true;

  // Skip sessions owned by another live mux. A session whose owner is gone
  // is orphaned; an unowned one has no owner at all. The standalone
  // listener applies the same rule (see listener-command.ts).
  if (reg.muxId !== undefined && (reg.muxPid === undefined || isOwnedByLiveMux(reg))) return false;

  // Skip unowned/orphaned sessions if a standalone listener is handling them
  return !standaloneListenerRunning;
}

/**
 * Creates a new MuxEscalationManager.
 */
export function createMuxEscalationManager(options?: MuxEscalationManagerOptions): MuxEscalationManager {
  const ourMuxId = options?.muxId;
  let state = createInitialState();
  const changeCallbacks: Array<() => void> = [];
  const discoveryCallbacks: Array<(reg: PtySessionRegistration) => void> = [];
  let registryPollInterval: ReturnType<typeof setInterval> | null = null;

  // Track session IDs that we manage (spawned by mux)
  const managedSessionIds = new Set<string>();
  // Tombstones: removed sessions that may still linger in the registry briefly
  const removedSessionIds = new Set<string>();

  function notifyChange(): void {
    for (const cb of changeCallbacks) cb();
  }

  function createWatcherForSession(sessionId: string, escalationDir: string): EscalationWatcher {
    return createEscalationWatcher(
      escalationDir,
      {
        onEscalation: (request) => {
          state = addEscalation(state, sessionId, request);
          notifyChange();
          // BEL to alert user
          process.stderr.write('\x07');
        },
        onEscalationExpired: (escalationId) => {
          state = expireEscalation(state, sessionId, escalationId);
          notifyChange();
        },
      },
      { pollIntervalMs: 300 },
    );
  }

  return {
    get state() {
      return state;
    },

    get pendingCount() {
      return state.pendingEscalations.size;
    },

    sortedDisplayNumbers(): number[] {
      return [...state.pendingEscalations.keys()].sort((a, b) => a - b);
    },

    pendingRefs(): PendingRef[] {
      return [...state.pendingEscalations.values()]
        .sort((a, b) => a.displayNumber - b.displayNumber)
        .map((esc) => {
          const groupKey = escalationGroupKey(esc.request);
          return {
            displayNumber: esc.displayNumber,
            escalationId: esc.request.escalationId,
            ...(groupKey !== undefined ? { groupKey } : {}),
          };
        });
    },

    groupOf(displayNumber: number): { key: string; description: string; members: PendingRef[] } | undefined {
      const escalation = state.pendingEscalations.get(displayNumber);
      if (!escalation) return undefined;
      const pattern = escalationGroupPattern(escalation.request);
      if (pattern === undefined) return undefined;
      const key = pattern.patternKey;
      return {
        key,
        description: pattern.description,
        members: this.pendingRefs().filter((ref) => ref.groupKey === key),
      };
    },

    addSession(registration: PtySessionRegistration): void {
      managedSessionIds.add(registration.sessionId);

      // If a watcher already exists for this session (e.g., registry polling
      // discovered it before the bridge did), stop the old watcher first.
      const existing = state.sessions.get(registration.sessionId);
      if (existing) {
        existing.watcher.stop();
      }

      const watcher = createWatcherForSession(registration.sessionId, registration.escalationDir);
      state = addSession(state, registration, watcher);
      watcher.start();
      notifyChange();
    },

    removeSession(sessionId: string): void {
      const session = state.sessions.get(sessionId);
      session?.watcher.stop();
      removedSessionIds.add(sessionId);
      state = removeSession(state, sessionId);
      notifyChange();
    },

    resolve(displayNumber: number, decision: 'approved' | 'denied', options?: ResolveOptions): string {
      const whitelist = options?.whitelist;
      const escalation = state.pendingEscalations.get(displayNumber);
      if (!escalation) {
        return `No pending escalation #${displayNumber}`;
      }

      if (options?.escalationId !== undefined && options.escalationId !== escalation.request.escalationId) {
        return `Escalation #${displayNumber} was not resolved: it is not the request that was shown`;
      }

      const session = state.sessions.get(escalation.sessionId);
      if (!session) {
        return `Session for escalation #${displayNumber} no longer active`;
      }

      // A human-only escalation is never whitelisted: /approve+ approves
      // this one call and says so. /approve+dir needs a directory-wide
      // candidate (a human-only escalation has none): without one nothing
      // is resolved, so the user decides again knowing that.
      const humanOnly = escalation.request.humanOnly === true;
      const scope = decision === 'approved' && whitelist !== undefined ? whitelist : false;
      let selection: { readonly whitelistSelection: number } | undefined;
      let whitelistSuffix = '';
      if (scope === 'directory') {
        const index = humanOnly ? undefined : directoryCandidateIndex(escalation.request.whitelistCandidates);
        if (index === undefined) {
          return humanOnly
            ? `Escalation #${displayNumber} was not resolved: a human-only escalation is never whitelisted (/approve ${displayNumber} approves it once)`
            : `Escalation #${displayNumber} was not resolved: it offers no directory-wide whitelist pattern (/approve+ ${displayNumber} whitelists this path only)`;
        }
        selection = { whitelistSelection: index };
        whitelistSuffix = ' (whitelisted: directory-wide)';
      } else if (scope === 'exact') {
        selection = humanOnly ? undefined : DEFAULT_WHITELIST_OPTIONS;
        whitelistSuffix = humanOnly ? ' (human-only: approved once, not whitelisted)' : ' (whitelisted)';
      }

      try {
        const accepted = session.watcher.resolve(escalation.request.escalationId, decision, selection);
        state = resolveEscalation(state, displayNumber, decision);
        notifyChange();

        if (!accepted) {
          return `Escalation #${displayNumber} expired (response was too late)`;
        }

        const label = decision === 'approved' ? 'APPROVED' : 'DENIED';
        return `Escalation #${displayNumber} ${label}${whitelistSuffix}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    denyAll(): string {
      if (state.pendingEscalations.size === 0) {
        return 'No pending escalations';
      }
      return this.pendingRefs()
        .map((ref) => this.resolve(ref.displayNumber, 'denied', { escalationId: ref.escalationId }))
        .join('\n');
    },

    approveAll(reviewed: readonly PendingRef[], options?: { readonly whitelist?: boolean }): string {
      if (state.pendingEscalations.size === 0) {
        return 'No pending escalations';
      }
      const current = this.pendingRefs();
      if (reviewed.length === 0 || !sameEscalationSet(reviewed, current)) {
        return 'Nothing was approved: the pending escalations changed since they were listed. Review them again.';
      }

      const messages: string[] = [];
      for (const ref of current) {
        if (state.pendingEscalations.get(ref.displayNumber)?.request.humanOnly === true) {
          messages.push(
            `Escalation #${ref.displayNumber} requires individual approval (/approve ${ref.displayNumber})`,
          );
          continue;
        }
        messages.push(
          this.resolve(ref.displayNumber, 'approved', {
            whitelist: options?.whitelist === true ? 'exact' : false,
            escalationId: ref.escalationId,
          }),
        );
      }
      return messages.join('\n');
    },

    approveGroup(
      reviewed: readonly PendingRef[],
      groupKey: string,
      options?: { readonly whitelist?: boolean },
    ): string {
      const members = this.pendingRefs().filter((ref) => ref.groupKey === groupKey);
      if (members.length === 0) {
        return 'Nothing was approved: no escalation of that group is pending any more.';
      }
      if (reviewed.length === 0 || !sameEscalationSet(reviewed, members)) {
        return "Nothing was approved: the group's escalations changed since they were listed. Review the group again.";
      }

      const messages: string[] = [];
      for (const ref of members) {
        // Unreachable (a human-only escalation has no group key), but a
        // group approval must never approve one.
        if (state.pendingEscalations.get(ref.displayNumber)?.request.humanOnly === true) {
          messages.push(
            `Escalation #${ref.displayNumber} requires individual approval (/approve ${ref.displayNumber})`,
          );
          continue;
        }
        // `/approve+ group` whitelists the exact pattern the members share;
        // directory-wide patterns are only ever chosen one at a time.
        messages.push(
          this.resolve(ref.displayNumber, 'approved', {
            whitelist: options?.whitelist === true ? 'exact' : false,
            escalationId: ref.escalationId,
          }),
        );
      }
      return messages.join('\n');
    },

    startRegistryPolling(): void {
      if (registryPollInterval) return;

      const registryDir = getPtyRegistryDir();
      mkdirSync(registryDir, { recursive: true, mode: 0o700 });

      registryPollInterval = setInterval(() => {
        const registrations = readActiveRegistrations(registryDir);
        const currentIds = new Set(registrations.map((r) => r.sessionId));
        const stateIds = new Set(state.sessions.keys());

        let changed = false;

        // Cache the standalone listener check once per poll cycle
        const standaloneListenerRunning = ourMuxId ? isStandaloneListenerRunning() : false;

        // Add sessions that belong to us (skip managed, tombstoned, other mux's sessions)
        for (const reg of registrations) {
          if (
            stateIds.has(reg.sessionId) ||
            managedSessionIds.has(reg.sessionId) ||
            removedSessionIds.has(reg.sessionId)
          ) {
            continue;
          }

          // Ownership filtering when this mux has a muxId
          if (ourMuxId && !shouldClaimSession(reg, ourMuxId, standaloneListenerRunning)) {
            continue;
          }

          const watcher = createWatcherForSession(reg.sessionId, reg.escalationDir);
          state = addSession(state, reg, watcher);
          watcher.start();
          changed = true;
          for (const cb of discoveryCallbacks) cb(reg);
        }

        // Clear tombstones and managed IDs once the registry entry disappears
        for (const id of removedSessionIds) {
          if (!currentIds.has(id)) {
            removedSessionIds.delete(id);
          }
        }
        for (const id of managedSessionIds) {
          if (!currentIds.has(id) && !stateIds.has(id)) {
            managedSessionIds.delete(id);
          }
        }

        // Remove gone external sessions
        for (const id of stateIds) {
          if (!currentIds.has(id) && !managedSessionIds.has(id)) {
            const session = state.sessions.get(id);
            session?.watcher.stop();
            state = removeSession(state, id);
            changed = true;
          }
        }

        if (changed) notifyChange();
      }, REGISTRY_POLL_INTERVAL_MS);
    },

    stop(): void {
      if (registryPollInterval) {
        clearInterval(registryPollInterval);
        registryPollInterval = null;
      }

      for (const session of state.sessions.values()) {
        session.watcher.stop();
      }
    },

    onChange(callback: () => void): void {
      changeCallbacks.push(callback);
    },

    onSessionDiscovered(callback: (reg: PtySessionRegistration) => void): void {
      discoveryCallbacks.push(callback);
    },

    claimSession(sessionId: string): void {
      managedSessionIds.add(sessionId);
    },
  };
}
