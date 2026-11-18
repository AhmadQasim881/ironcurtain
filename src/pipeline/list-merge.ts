/**
 * Dynamic lists across per-server compilation: how a merged policy names each
 * server's lists, where its dynamic-lists.json takes their values, and how
 * the user's overrides in that file survive recompiles and refreshes.
 *
 * Naming. Per-server compilation resolves each server's lists on their own
 * (`servers/<server>/dynamic-lists.json`) and verifies each server's rules
 * against them. Servers that define a list name identically (type,
 * generation prompt, requiresMcp, and for a data-backed list the server it
 * reads) share one merged list. When servers define a name differently, the
 * merge keeps their lists apart: each of those servers' copies is renamed
 * `<server>--<name>` in that server's rules and in the merged definitions,
 * which record the original name in `sourceName`. No server's rules ever
 * expand to values resolved for another server's definition. A rename that
 * would collide with another list's name fails the merge.
 *
 * Values. A merged list takes its values from the per-server resolution of
 * the first server (alphabetically) that defines it; a list none of them has
 * resolved is written UNRESOLVED (no values), never with the values an
 * earlier merged file held. Per-server copies hold resolver output only; the
 * user's overrides never reach them.
 *
 * Overrides. A policy's merged dynamic-lists.json is the file users edit.
 * Its `manualAdditions` / `manualRemovals` belong to the list name and are
 * carried from the previous merged file into the next one. When the merge
 * renames a list (it became per-server, or stopped being per-server), the
 * removals of every previous list with that base name follow it, and
 * additions follow only from a previous list resolved from the same
 * definition, so a value the user added for one server's list never widens
 * another server's. An entry the new policy does not use is kept while it
 * holds overrides, so a filtered compile or a constitution change that drops
 * a list for a while does not lose the user's removals.
 */

import { DYNAMIC_LISTS_FILENAME, UNRESOLVED_LIST_HASH } from '../config/dynamic-lists-file.js';
import { loadDynamicListsArtifact } from '../config/index.js';
import type { CompiledPolicyFile, CompiledRule, DynamicListsFile, ListDefinition, ResolvedList } from './types.js';

/** File name of the resolved-lists artifact (merged and per-server). */
export { DYNAMIC_LISTS_FILENAME };

/** Separates the server name from the list name in a per-server list name. */
export const LIST_NAMESPACE_SEPARATOR = '--';

/** The merged name of `serverName`'s list `listName` when it is kept apart per server. */
export function namespacedListName(serverName: string, listName: string): string {
  return `${serverName}${LIST_NAMESPACE_SEPARATOR}${listName}`;
}

/**
 * Whether two definitions resolve to the same list: same type, generation
 * prompt and requiresMcp, and for a data-backed list the same server.
 * `principle` is descriptive only and is ignored, as is the hint of a
 * knowledge-based list (it is not used to resolve it).
 */
export function sameListDefinition(a: ListDefinition, b: ListDefinition): boolean {
  return (
    a.type === b.type &&
    a.generationPrompt === b.generationPrompt &&
    a.requiresMcp === b.requiresMcp &&
    (!a.requiresMcp || a.mcpServerHint === b.mcpServerHint)
  );
}

/** The list names (without `@`) a rule references. */
export function listReferencesOf(rule: CompiledRule): string[] {
  const entries = [...(rule.if.domains?.allowed ?? []), ...(rule.if.lists ?? []).flatMap((l) => l.allowed)];
  return entries.filter((entry) => entry.startsWith('@')).map((entry) => entry.slice(1));
}

/** The servers whose lists a merged list draws on, and the list's name there. */
export interface ListSource {
  /** The list's name in those servers' own artifacts (servers/<server>/). */
  readonly sourceName: string;
  /** Servers that define (or, for a policy read back from disk, reference) the list, alphabetical. */
  readonly servers: readonly string[];
}

/** A server's compiled output, as far as merging its lists is concerned. */
export interface ServerListsInput {
  readonly serverName: string;
  readonly listDefinitions: readonly ListDefinition[];
  readonly resolvedLists?: DynamicListsFile;
}

/** How the merged policy names every server's lists. */
export interface ListMergePlan {
  /** Merged list definitions: renamed ones carry `sourceName`. */
  readonly definitions: readonly ListDefinition[];
  /** Per server, the lists the merge renamed: list name -> merged name. */
  readonly renames: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Per merged list name, where its values come from. */
  readonly sources: ReadonlyMap<string, ListSource>;
  /** List names kept apart per server, with the servers that define them. */
  readonly divergent: ReadonlyMap<string, readonly string[]>;
}

/** Thrown when keeping lists apart per server would give two lists the same name. */
export class ListNameCollisionError extends Error {
  readonly code = 'LIST_NAME_COLLISION';
  constructor(readonly listName: string) {
    super(
      `Dynamic list name collision: two different lists would both be named ${JSON.stringify(`@${listName}`)} ` +
        `in the merged policy (a list kept apart per server is renamed "<server>${LIST_NAMESPACE_SEPARATOR}<name>"). ` +
        'Rename one of the MCP servers or reword the constitution so the lists get different names.',
    );
    this.name = 'ListNameCollisionError';
  }
}

/**
 * Decides the merged name of every server's lists. Servers are taken in
 * alphabetical order, so the result does not depend on the order of the
 * input. Throws `ListNameCollisionError` when two different lists would end
 * up with the same merged name.
 */
export function planListMerge(results: readonly ServerListsInput[]): ListMergePlan {
  const sorted = [...results].sort((a, b) => a.serverName.localeCompare(b.serverName));

  // Each server's definitions by name. Should a server repeat a name, the last
  // one counts: it is the one its rules were validated against
  // (validateCompiledRules) and its list was resolved from (resolveAllLists).
  const perServer = sorted.map((result) => {
    const byName = new Map<string, ListDefinition>();
    for (const definition of result.listDefinitions) byName.set(definition.name, definition);
    return { serverName: result.serverName, byName };
  });

  // Names that servers define differently.
  const firstDefinition = new Map<string, ListDefinition>();
  const definers = new Map<string, string[]>();
  const divergentNames = new Set<string>();
  for (const { serverName, byName } of perServer) {
    for (const [name, definition] of byName) {
      const first = firstDefinition.get(name);
      if (!first) firstDefinition.set(name, definition);
      else if (!sameListDefinition(first, definition)) divergentNames.add(name);
      definers.set(name, [...(definers.get(name) ?? []), serverName]);
    }
  }

  const definitions: ListDefinition[] = [];
  const renames = new Map<string, Map<string, string>>();
  const sources = new Map<string, { sourceName: string; servers: string[] }>();
  // Which (server, list) pair owns each merged name; a second owner is a collision.
  const owners = new Map<string, string>();

  for (const { serverName, byName } of perServer) {
    for (const [name, definition] of byName) {
      const keptApart = divergentNames.has(name);
      const mergedName = keptApart ? namespacedListName(serverName, name) : name;
      const owner = keptApart ? `server:${serverName}\0${name}` : `shared:${name}`;
      const previousOwner = owners.get(mergedName);
      if (previousOwner !== undefined && previousOwner !== owner) throw new ListNameCollisionError(mergedName);
      owners.set(mergedName, owner);

      if (keptApart) {
        let serverRenames = renames.get(serverName);
        if (!serverRenames) {
          serverRenames = new Map();
          renames.set(serverName, serverRenames);
        }
        serverRenames.set(name, mergedName);
      }

      const source = sources.get(mergedName);
      if (source) {
        source.servers.push(serverName);
        continue;
      }
      sources.set(mergedName, { sourceName: name, servers: [serverName] });
      definitions.push(keptApart ? { ...definition, name: mergedName, sourceName: name } : definition);
    }
  }

  const divergent = new Map<string, readonly string[]>();
  for (const name of [...divergentNames].sort()) divergent.set(name, definers.get(name) ?? []);
  return { definitions, renames, sources, divergent };
}

/** Rewrites `@name` references in `rules` according to `renames` (list name -> merged name). */
export function renameListReferences(
  rules: readonly CompiledRule[],
  renames: ReadonlyMap<string, string> | undefined,
): CompiledRule[] {
  if (!renames || renames.size === 0) return [...rules];
  const rename = (entry: string): string => {
    if (!entry.startsWith('@')) return entry;
    const merged = renames.get(entry.slice(1));
    return merged === undefined ? entry : `@${merged}`;
  };
  return rules.map((rule) => {
    const { domains, lists } = rule.if;
    if (!domains && !lists) return rule;
    return {
      ...rule,
      if: {
        ...rule.if,
        ...(domains ? { domains: { ...domains, allowed: domains.allowed.map(rename) } } : {}),
        ...(lists ? { lists: lists.map((l) => ({ ...l, allowed: l.allowed.map(rename) })) } : {}),
      },
    };
  });
}

/**
 * Where each list of a merged policy read back from disk takes its values:
 * the servers whose rules reference it (a merged policy's rules are scoped to
 * one server each) and its `sourceName`. Used by refresh-lists to update the
 * per-server copies along with the merged file.
 */
export function listSourcesFromPolicy(policy: CompiledPolicyFile): Map<string, ListSource> {
  const referencedBy = new Map<string, Set<string>>();
  for (const rule of policy.rules) {
    for (const name of listReferencesOf(rule)) {
      let servers = referencedBy.get(name);
      if (!servers) {
        servers = new Set();
        referencedBy.set(name, servers);
      }
      for (const server of rule.if.server ?? []) servers.add(server);
    }
  }
  const sources = new Map<string, ListSource>();
  for (const definition of policy.listDefinitions ?? []) {
    sources.set(definition.name, {
      sourceName: definition.sourceName ?? definition.name,
      servers: [...(referencedBy.get(definition.name) ?? [])].sort(),
    });
  }
  return sources;
}

/** The definition a merged list is resolved from: its name in its servers' own artifacts. */
export function resolutionDefinitionOf(definition: ListDefinition): ListDefinition {
  const { sourceName, ...rest } = definition;
  return sourceName === undefined ? rest : { ...rest, name: sourceName };
}

/** Own-property lookup, so a list named like an Object.prototype member is never confused with it. */
export function ownListEntry(file: DynamicListsFile | undefined, name: string): ResolvedList | undefined {
  if (!file || !Object.hasOwn(file.lists, name)) return undefined;
  return file.lists[name];
}

/** The overrides a merged list carries into the next merged file. */
interface CarriedOverrides {
  readonly additions: string[];
  readonly removals: string[];
}

/**
 * The overrides list `mergedName` (named `sourceName` in its servers'
 * artifacts, now resolved as `resolved`) takes from the previous merged file.
 * Records which previous entries it drew on in `consumed`.
 */
function carryOverrides(
  mergedName: string,
  sourceName: string,
  resolved: ResolvedList,
  previous: DynamicListsFile | undefined,
  consumed: Set<string>,
  notes: string[],
): CarriedOverrides {
  const same = ownListEntry(previous, mergedName);
  if (same) {
    consumed.add(mergedName);
    return { additions: [...same.manualAdditions], removals: [...same.manualRemovals] };
  }

  // New under this name: the list may have been renamed by the merge. Follow
  // every previous list with the same base name.
  const removals = new Set<string>();
  const additions = new Set<string>();
  const dropped = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(previous?.lists ?? {})) {
    if (name !== sourceName && !name.endsWith(`${LIST_NAMESPACE_SEPARATOR}${sourceName}`)) continue;
    consumed.add(name);
    for (const value of entry.manualRemovals) removals.add(value);
    const sameDefinition = entry.inputHash !== UNRESOLVED_LIST_HASH && entry.inputHash === resolved.inputHash;
    if (sameDefinition) {
      for (const value of entry.manualAdditions) additions.add(value);
    } else if (entry.manualAdditions.length > 0) {
      dropped.set(name, [...entry.manualAdditions]);
    }
  }
  for (const [name, values] of dropped) {
    notes.push(
      `Manual additions to @${name} (${values.join(', ')}) were not carried to @${mergedName}: ` +
        `that list now has a different definition. Add them to @${mergedName} in dynamic-lists.json if they still apply.`,
    );
  }
  return { additions: [...additions], removals: [...removals] };
}

/** The first resolution of a merged list among the servers that define it. */
function firstResolution(
  source: ListSource,
  byServer: ReadonlyMap<string, ServerListsInput>,
): ResolvedList | undefined {
  for (const serverName of source.servers) {
    const entry = ownListEntry(byServer.get(serverName)?.resolvedLists, source.sourceName);
    if (entry) return entry;
  }
  return undefined;
}

/** The merged dynamic-lists.json, plus notes for the user. */
export interface MergedDynamicLists {
  /** Undefined when the policy defines no lists and no overrides need keeping (remove the file). */
  readonly lists: DynamicListsFile | undefined;
  readonly notes: readonly string[];
}

/**
 * Builds a policy's merged dynamic-lists.json: each merged list's values
 * from its servers' per-server resolution, and the user's overrides from the
 * `previous` merged file (see the module comment for the carry rules).
 */
export function mergeDynamicLists(
  results: readonly ServerListsInput[],
  plan: ListMergePlan,
  previous: DynamicListsFile | undefined,
): MergedDynamicLists {
  const byServer = new Map(results.map((r) => [r.serverName, r]));
  const lists = new Map<string, ResolvedList>();
  const notes: string[] = [];
  const consumed = new Set<string>();

  for (const definition of plan.definitions) {
    const source = plan.sources.get(definition.name);
    if (!source) continue;
    // A list without a per-server resolution is stored UNRESOLVED: it keeps
    // the user's overrides but never the values of an earlier resolution
    // (left in the previous merged file), which nothing verified for this policy.
    const resolved = firstResolution(source, byServer) ?? {
      values: [],
      manualAdditions: [],
      manualRemovals: [],
      resolvedAt: '',
      inputHash: UNRESOLVED_LIST_HASH,
      resolutionState: 'incomplete' as const,
    };
    if (resolved.inputHash === UNRESOLVED_LIST_HASH && resolved.values.length === 0) {
      notes.push(
        `@${definition.name} has no resolved values (servers/${source.servers.join(', ')}); ` +
          'allow rules match only manual additions; escalation/deny conditions remain restrictive until it is resolved.',
      );
    }
    const overrides = carryOverrides(definition.name, source.sourceName, resolved, previous, consumed, notes);
    lists.set(definition.name, {
      values: [...resolved.values],
      manualAdditions: overrides.additions,
      manualRemovals: overrides.removals,
      resolvedAt: resolved.resolvedAt,
      inputHash: resolved.inputHash,
      resolutionState: resolved.resolutionState,
    });
  }

  // Keep the overrides of lists this policy does not use (parked).
  for (const [name, entry] of Object.entries(previous?.lists ?? {})) {
    if (lists.has(name) || consumed.has(name)) continue;
    if (entry.manualAdditions.length === 0 && entry.manualRemovals.length === 0) continue;
    lists.set(name, entry);
  }

  if (plan.definitions.length === 0 && lists.size === 0) return { lists: undefined, notes };
  return { lists: { generatedAt: new Date().toISOString(), lists: Object.fromEntries(lists) }, notes };
}

// ---------------------------------------------------------------------------
// Reading the user-edited file
// ---------------------------------------------------------------------------

/**
 * Reads a policy's merged dynamic-lists.json, which holds the user's manual
 * overrides, through the runtime schema (`loadDynamicListsArtifact`, the
 * reader the session loaders use): a file that is not valid JSON, or whose
 * values or overrides are not arrays of strings, throws a
 * `POLICY_ARTIFACT_INVALID` error naming the file and each offending field,
 * so the overrides are never silently lost or spread into characters.
 * Missing override arrays default to empty. Returns undefined when the file
 * does not exist.
 */
export function readDynamicListsArtifact(dir: string): DynamicListsFile | undefined {
  return loadDynamicListsArtifact(dir);
}
