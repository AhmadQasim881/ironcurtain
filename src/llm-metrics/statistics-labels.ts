/**
 * Display labels for pseudonymized statistics identities.
 *
 * Persona, provider-profile and (in rows written before adapter ids were
 * stored raw) agent identities are stored as local HMAC pseudonyms. The key is
 * local, so the query layer can recompute the pseudonym of every *currently
 * configured* name and show that name for matching rows. Names are never
 * written to statistics rows, and a pseudonym whose name is no longer
 * configured (or that was derived from a rotated key) stays unlabelled.
 */

import { readdirSync } from 'node:fs';

import { loadUserConfig, NATIVE_PROFILE_NAME } from '../config/user-config.js';
import { getPersonasDir } from '../persona/resolve.js';
import { PERSONA_NAME_PATTERN } from '../persona/types.js';
import {
  PROTECTED_LABEL_PATTERN,
  PUBLIC_AGENT_IDS,
  type StatisticsIdentityNamespace,
  type StatisticsLabelProtector,
} from './identity-protector.js';
import type { LlmStatisticsDimension, LlmStatisticsDimensionValue } from './persistence/repository.js';

/** The workflow persona that means "no persona: the global policy". */
export const GLOBAL_PERSONA_NAME = 'global';
const MAX_CANDIDATES_PER_KIND = 1_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface StatisticsLabelCandidates {
  readonly personas: readonly string[];
  readonly providerProfiles: readonly string[];
  readonly agents: readonly string[];
}

export type StatisticsLabelCandidatesSource = () => StatisticsLabelCandidates;

export interface StatisticsLabelResolver {
  /** The configured name a stored value stands for, when it is a known pseudonym. */
  label(dimension: LlmStatisticsDimension, value: LlmStatisticsDimensionValue): string | undefined;
}

const LABELLED_DIMENSIONS: readonly {
  readonly dimension: LlmStatisticsDimension;
  readonly namespace: StatisticsIdentityNamespace;
  readonly candidates: keyof StatisticsLabelCandidates;
}[] = [
  { dimension: 'personaId', namespace: 'persona', candidates: 'personas' },
  { dimension: 'providerProfile', namespace: 'profile', candidates: 'providerProfiles' },
  { dimension: 'agent', namespace: 'agent', candidates: 'agents' },
];

function bounded(names: readonly string[]): readonly string[] {
  return [...new Set(names.filter((name) => typeof name === 'string' && name.length > 0))].slice(
    0,
    MAX_CANDIDATES_PER_KIND,
  );
}

function personaNames(): string[] {
  try {
    return readdirSync(getPersonasDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PERSONA_NAME_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function providerProfileNames(): string[] {
  try {
    return Object.keys(loadUserConfig({ readOnly: true }).modelProviders.profiles);
  } catch {
    return [];
  }
}

/** The names configured on this host: persona directories, provider profiles and built-in agents. */
export function loadStatisticsLabelCandidates(): StatisticsLabelCandidates {
  return {
    personas: [GLOBAL_PERSONA_NAME, ...personaNames()],
    providerProfiles: [NATIVE_PROFILE_NAME, ...providerProfileNames()],
    agents: [...PUBLIC_AGENT_IDS],
  };
}

export interface StatisticsLabelResolverOptions {
  /** How long a computed name-to-pseudonym table is reused. */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export function createStatisticsLabelResolver(
  protector: StatisticsLabelProtector,
  source: StatisticsLabelCandidatesSource = loadStatisticsLabelCandidates,
  options: StatisticsLabelResolverOptions = {},
): StatisticsLabelResolver {
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let tables: ReadonlyMap<LlmStatisticsDimension, ReadonlyMap<string, string>> = new Map();
  let builtAt = Number.NEGATIVE_INFINITY;

  const rebuild = (): void => {
    let candidates: StatisticsLabelCandidates;
    try {
      candidates = source();
    } catch {
      candidates = { personas: [], providerProfiles: [], agents: [] };
    }
    const next = new Map<LlmStatisticsDimension, Map<string, string>>();
    try {
      for (const { dimension, namespace, candidates: kind } of LABELLED_DIMENSIONS) {
        const table = new Map<string, string>();
        for (const name of bounded(candidates[kind])) table.set(protector.protectLabel(namespace, name), name);
        next.set(dimension, table);
      }
      tables = next;
    } catch {
      // Without a usable key no pseudonym can be resolved; show raw values.
      tables = new Map();
    }
  };

  return Object.freeze({
    label: (dimension: LlmStatisticsDimension, value: LlmStatisticsDimensionValue): string | undefined => {
      if (typeof value !== 'string' || !PROTECTED_LABEL_PATTERN.test(value)) return undefined;
      const current = now();
      if (current - builtAt >= ttlMs) {
        builtAt = current;
        rebuild();
      }
      return tables.get(dimension)?.get(value);
    },
  });
}
