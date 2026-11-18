/**
 * Persona scanner -- discovers available personas from disk.
 *
 * Reads persona directories and returns snapshots with compilation
 * status (missing, stale or compiled), mirroring the session-scanner
 * pattern.
 */

import { readdirSync } from 'node:fs';
import { getPersonasDir, getPersonaPolicyState, getPersonaWorkspaceDir, loadPersona } from '../persona/resolve.js';
import { createPersonaName, type PersonaName } from '../persona/types.js';
import { readPersonaOverrides, type PersonaOverrides } from '../persona/persona-overrides.js';
import type { PolicyStaleReason } from '../config/constitution-hash.js';

/** Snapshot of a persona for display in the picker. */
export interface PersonaSnapshot {
  readonly name: PersonaName;
  readonly description: string;
  /** Whether a compiled-policy.json exists (it may still be stale). */
  readonly compiled: boolean;
  /**
   * Present when the compiled policy no longer matches the persona's
   * constitution. Sessions refuse such a persona unless the user explicitly
   * overrides, so pickers must not offer it as a ready choice.
   */
  readonly stale?: PolicyStaleReason;
  readonly workspacePath: string;
  /** The persona's own agent model, when it sets a valid one (pickers show it). */
  readonly agentModelId?: string;
  /**
   * Present when the persona's `agentModelId` or `resourceBudget` is
   * malformed: the message sessions refuse the persona with. Pickers must
   * not offer such a persona as a ready choice either.
   */
  readonly invalidOverrides?: string;
}

/**
 * A directory under `personas/` with a valid persona name that is not a
 * usable persona: its persona.json is missing or invalid (for example a
 * persona directory copied by hand, whose persona.json still names the
 * original). Pickers never offer it; `persona list` reports it.
 */
export interface InvalidPersonaDir {
  readonly name: PersonaName;
  /** Why it cannot be loaded (the loader's message). */
  readonly reason: string;
}

/** Everything {@link scanPersonaDirs} found. */
export interface PersonaDirScan {
  /** Usable personas, sorted by name. */
  readonly personas: PersonaSnapshot[];
  /** Directories with a persona name that cannot be loaded, sorted by name. */
  readonly invalid: InvalidPersonaDir[];
}

/**
 * Scans the personas directory. Entries whose name is not a valid persona
 * name (including the dot-prefixed staging directories persona-service
 * builds personas in) are not personas and are skipped silently.
 */
export function scanPersonaDirs(): PersonaDirScan {
  const personasDir = getPersonasDir();

  let entries: string[];
  try {
    entries = readdirSync(personasDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { personas: [], invalid: [] };
  }

  const personas: PersonaSnapshot[] = [];
  const invalid: InvalidPersonaDir[] = [];

  for (const entry of entries) {
    let name: PersonaName;
    try {
      name = createPersonaName(entry);
    } catch {
      continue; // skip invalid persona names
    }

    try {
      const persona = loadPersona(name);
      const policy = getPersonaPolicyState(name);
      let overrides: PersonaOverrides = {};
      let invalidOverrides: string | undefined;
      try {
        overrides = readPersonaOverrides(name, persona);
      } catch (err) {
        invalidOverrides = err instanceof Error ? err.message : String(err);
      }
      personas.push({
        name,
        description: persona.description,
        compiled: policy.kind !== 'missing',
        ...(policy.kind === 'stale' ? { stale: policy.reason } : {}),
        workspacePath: getPersonaWorkspaceDir(name),
        ...(overrides.agentModelId !== undefined ? { agentModelId: overrides.agentModelId } : {}),
        ...(invalidOverrides !== undefined ? { invalidOverrides } : {}),
      });
    } catch (err) {
      // A missing or invalid persona.json: never offered, but reported.
      invalid.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  personas.sort((a, b) => a.name.localeCompare(b.name));
  invalid.sort((a, b) => a.name.localeCompare(b.name));
  return { personas, invalid };
}

/**
 * Scans the personas directory for available personas.
 * Returns snapshots sorted alphabetically by name; directories that cannot
 * be loaded are left out (see {@link scanPersonaDirs} to report them).
 */
export function scanPersonas(): PersonaSnapshot[] {
  return scanPersonaDirs().personas;
}
