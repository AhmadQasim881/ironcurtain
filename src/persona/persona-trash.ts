/**
 * The persona trash: where a soft delete moves a persona directory,
 * `{home}/.persona-trash/<name>-<timestamp>/`. It is OUTSIDE `personas/`, so
 * `scanPersonas` / `resolvePersona` never list or load an entry, and
 * `validatePolicyDir` never accepts an entry's `generated/` as a policy
 * directory.
 *
 * This module names, parses and lists entries (and purge remnants) only.
 * Every change to the trash (soft delete, restore, purge, the retention
 * sweep) is in persona-service.ts, which writes the policy-mutation audit
 * records.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, type Dirent } from 'node:fs';
import { resolve } from 'node:path';

import { getIronCurtainHome } from '../config/paths.js';
import { PERSONA_DEFINITION_FILENAME, readPersonaDefinition } from './persona-definition.js';
import { createPersonaName, type PersonaName } from './types.js';

/** Basename of the trash directory under the IronCurtain home. */
export const PERSONA_TRASH_DIRNAME = '.persona-trash';

/** Returns the persona trash base dir: {home}/.persona-trash/ (outside personas/). */
export function getPersonaTrashDir(): string {
  return resolve(getIronCurtainHome(), PERSONA_TRASH_DIRNAME);
}

/**
 * An entry id: the persona name, `-`, and the deletion time as an ISO 8601
 * UTC timestamp with `:` and `.` replaced by `-` (some filesystems refuse
 * colons), e.g. `coder-2026-11-12T10-04-05-123Z`. The timestamp's `T` and
 * `Z` are upper case, which a persona name never is, so an id is never a
 * persona name and splits in exactly one way.
 */
const ENTRY_ID_PATTERN = /^([a-z0-9][a-z0-9_-]{0,62})-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** The id (directory name) of the trash entry for `name` deleted at `deletedAt`. */
export function personaTrashEntryId(name: PersonaName, deletedAt: Date): string {
  return `${name}-${deletedAt.toISOString().replace(/[:.]/g, '-')}`;
}

/** Splits an entry id into the persona name and the deletion time; undefined when it is not one. */
export function parsePersonaTrashEntryId(id: string): { name: PersonaName; deletedAt: Date } | undefined {
  const match = ENTRY_ID_PATTERN.exec(id);
  if (!match) return undefined;
  const [, rawName, date, hours, minutes, seconds, millis] = match;
  const deletedAt = new Date(`${date}T${hours}:${minutes}:${seconds}.${millis}Z`);
  if (Number.isNaN(deletedAt.getTime())) return undefined;
  return { name: createPersonaName(rawName), deletedAt };
}

/** One soft-deleted persona. */
export interface PersonaTrashEntry {
  /** The entry's directory name under the trash: the handle restore and purge take. */
  readonly id: string;
  /** The name the persona had when it was deleted. */
  readonly name: PersonaName;
  readonly deletedAt: Date;
  /** Absolute path of the entry's directory. */
  readonly path: string;
  /** The persona's description, when its persona.json is valid. */
  readonly description?: string;
  /** Why its persona.json cannot be used (restore refuses such an entry). */
  readonly problem?: string;
}

/**
 * Lists the trash, newest first. Only real directories whose name is an
 * entry id count: anything else in the trash directory (a symlink, a file,
 * a directory with another name) is not an entry and is never restored or
 * purged as one. (Purge remnants, {@link PURGE_REMNANT_PREFIX}, are not
 * entries either; purges delete them.)
 */
export function listPersonaTrash(): PersonaTrashEntry[] {
  const trashDir = getPersonaTrashDir();
  let dirents: Dirent[];
  try {
    dirents = readdirSync(trashDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: PersonaTrashEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const parsed = parsePersonaTrashEntryId(dirent.name);
    if (!parsed) continue;
    const path = resolve(trashDir, dirent.name);
    let description: string | undefined;
    let problem: string | undefined;
    try {
      description = readPersonaDefinition(resolve(path, PERSONA_DEFINITION_FILENAME), parsed.name).description;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    entries.push({
      id: dirent.name,
      name: parsed.name,
      deletedAt: parsed.deletedAt,
      path,
      ...(description !== undefined ? { description } : {}),
      ...(problem !== undefined ? { problem } : {}),
    });
  }
  return entries.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime() || a.id.localeCompare(b.id));
}

/**
 * The entries `ref` selects: the entry with that id, or, for a persona
 * name, every entry of that persona (newest first). Empty when none match.
 */
export function selectPersonaTrashEntries(ref: string, entries: readonly PersonaTrashEntry[]): PersonaTrashEntry[] {
  const byId = entries.find((entry) => entry.id === ref);
  if (byId) return [byId];
  return entries.filter((entry) => entry.name === ref);
}

/** The error for a `ref` that selects no entry (code `PERSONA_NOT_FOUND`). */
export function trashEntryNotFoundError(ref: string): Error {
  return Object.assign(new Error(`No persona trash entry "${ref}" (list them with: ironcurtain persona trash list).`), {
    code: 'PERSONA_NOT_FOUND',
  });
}

/**
 * Name prefix of a purge remnant. A purge first renames each entry it
 * removes to `.purging-<id>-<uuid>` in the trash directory, in one step, and
 * only then deletes its files. Such a name never parses as an entry id, so
 * an entry being removed (or one whose removal failed or was cut short by
 * the process ending) is never listed and can never be restored half
 * deleted. The next purge removes what is left.
 */
export const PURGE_REMNANT_PREFIX = '.purging-';

/** A fresh path for the remnant of the entry `entryId` (see {@link PURGE_REMNANT_PREFIX}). */
export function purgeRemnantPath(entryId: string): string {
  return resolve(getPersonaTrashDir(), `${PURGE_REMNANT_PREFIX}${entryId}-${randomUUID()}`);
}

/** Absolute paths of the purge remnants in the trash: real directories only, never a link. */
export function listPurgeRemnants(): string[] {
  const trashDir = getPersonaTrashDir();
  let dirents: Dirent[];
  try {
    dirents = readdirSync(trashDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((dirent) => dirent.isDirectory() && dirent.name.startsWith(PURGE_REMNANT_PREFIX))
    .map((dirent) => resolve(trashDir, dirent.name))
    .sort();
}
