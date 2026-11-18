/**
 * Persona resolver -- locates persona directories, loads definitions,
 * and checks that the compiled policy exists and still matches the
 * persona's constitution.
 *
 * Follows the same directory-layout pattern as job paths in
 * src/config/paths.ts (getJobDir, getJobGeneratedDir, etc.).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import {
  checkScopedPolicy,
  ScopedPolicyError,
  type PolicyStaleReason,
  type ScopedPolicyState,
} from '../config/constitution-hash.js';
import { createPersonaName, type PersonaDefinition, type PersonaName } from './types.js';
import { PERSONA_DEFINITION_FILENAME, readPersonaDefinition } from './persona-definition.js';
import { describeBroadAccess, hasBroadAccess } from './broad-policy-validator.js';
import { inspectCompiledPolicyBreadth } from './policy-breadth-check.js';
import type { MCPServerConfig } from '../config/types.js';

/** Servers always included in persona sessions regardless of allowlist. */
const ALWAYS_INCLUDED_SERVERS = new Set(['filesystem']);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the base directory for all personas: {home}/personas/ */
export function getPersonasDir(): string {
  return resolve(getIronCurtainHome(), 'personas');
}

/** Returns the directory for a specific persona: {home}/personas/{name}/ */
export function getPersonaDir(name: PersonaName): string {
  return resolve(getPersonasDir(), name);
}

/** Returns the generated artifacts directory for a persona: {home}/personas/{name}/generated/ */
export function getPersonaGeneratedDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'generated');
}

/** Returns the constitution path for a persona: {home}/personas/{name}/constitution.md */
export function getPersonaConstitutionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'constitution.md');
}

/** Returns the workspace directory for a persona: {home}/personas/{name}/workspace/ */
export function getPersonaWorkspaceDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'workspace');
}

/** Returns the skills directory for a persona: {home}/personas/{name}/skills/ */
export function getPersonaSkillsDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'skills');
}

/** Returns the persona definition file path: {home}/personas/{name}/persona.json */
export function getPersonaDefinitionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), PERSONA_DEFINITION_FILENAME);
}

/**
 * Returns true iff a persona directory exists on disk.
 *
 * Takes a plain string (not branded) because callers get raw values from
 * YAML/JSON and should not have to brand them. Invalid names (that fail
 * the slug pattern) return `false` rather than throwing — the linter
 * treats them the same as missing.
 */
export function personaExists(name: string): boolean {
  // load-bearing ordering: brand-then-check prevents path traversal via existsSync.
  // `createPersonaName` rejects anything outside the slug pattern (e.g. "../evil",
  // absolute paths, NUL bytes), so `existsSync` only sees validated segments.
  let branded: PersonaName;
  try {
    branded = createPersonaName(name);
  } catch {
    return false;
  }
  return existsSync(getPersonaDir(branded));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Loads a persona definition from disk, validated against the persona.json
 * schema (see persona-definition.ts). The returned `name` is always the
 * directory name: a persona.json that names another persona (a directory
 * copied by hand) is refused, so no caller can be steered to the original
 * persona's files.
 *
 * @throws an error with code `PERSONA_NOT_FOUND` when persona.json does not
 *   exist, or a `PersonaDefinitionError` (code `PERSONA_INVALID`) when it
 *   cannot be used.
 */
export function loadPersona(name: PersonaName): PersonaDefinition {
  return readPersonaDefinition(getPersonaDefinitionPath(name), name);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Reads a persona's constitution.md verbatim (the exact text a compile
 * hashes), or returns undefined when it does not exist or cannot be read.
 */
function readPersonaConstitution(name: PersonaName): string | undefined {
  try {
    return readFileSync(getPersonaConstitutionPath(name), 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * State of a persona's compiled policy: missing, stale (it no longer
 * matches constitution.md) or fresh. Recomputed from disk on every call,
 * never cached or persisted, so an edit made by any surface (CLI, web UI,
 * a text editor) is seen by the next reader.
 */
export function getPersonaPolicyState(name: PersonaName): ScopedPolicyState {
  return checkScopedPolicy(getPersonaGeneratedDir(name), readPersonaConstitution(name));
}

/** Options for {@link resolvePersona}. */
export interface ResolvePersonaOptions {
  /**
   * Accept a compiled policy that no longer matches the persona's
   * constitution instead of refusing it. Only interactive sessions may set
   * this, and only on an explicit user override (`ironcurtain start
   * --allow-stale-policy`); unattended callers (cron jobs, workflows) never do.
   */
  readonly allowStalePolicy?: boolean;
}

/** Result of resolving a persona name to runtime-usable paths. */
export interface ResolvedPersona {
  readonly policyDir: string;
  readonly persona: PersonaDefinition;
  readonly workspacePath: string;
  /**
   * Set only when the compiled policy is stale and the caller allowed that
   * via {@link ResolvePersonaOptions.allowStalePolicy}; the caller must warn.
   */
  readonly stalePolicy?: { readonly reason: PolicyStaleReason; readonly detail: string };
}

/**
 * Resolves a persona name to a validated policyDir, workspace path,
 * and persona definition.
 *
 * Fails closed on the compiled policy: a persona without one never falls
 * back to another policy, a policy that no longer matches the persona's
 * constitution is refused unless the caller explicitly allows it, and a
 * policy that grants broad access is refused unless the persona has opted in
 * (`allowBroadPolicy: true`), whatever the caller allows. The breadth check is
 * the compile-time broad-policy validator applied to the artifacts on disk
 * (see {@link inspectCompiledPolicyBreadth}), so it also catches a policy
 * compiled before the opt-in was revoked, written without the validator, or
 * made broad by later annotation or list changes.
 *
 * Every session, cron job and workflow persona resolves through here; a
 * workflow resolves each persona once per run (its `getPolicyDir` cache).
 *
 * @throws if the persona does not exist, a {@link ScopedPolicyError}
 *   (`POLICY_MISSING` / `POLICY_STALE` / `POLICY_TOO_BROAD`) when its compiled
 *   policy is absent, stale and not allowed, or broader than the persona
 *   allows, or the artifact error when the policy or its lists are malformed.
 */
export function resolvePersona(nameRaw: string, options: ResolvePersonaOptions = {}): ResolvedPersona {
  const name = createPersonaName(nameRaw);

  // Load persona.json first — validates the persona directory exists and
  // produces a clear error ("not found") before checking for compiled policy.
  const persona = loadPersona(name);

  const state = getPersonaPolicyState(name);
  if (state.kind === 'missing') {
    throw new ScopedPolicyError(
      `Persona "${name}" has no compiled policy. Run: ironcurtain persona compile ${name}`,
      'POLICY_MISSING',
    );
  }
  if (state.kind === 'stale' && options.allowStalePolicy !== true) {
    throw new ScopedPolicyError(
      `Persona "${name}" has a stale compiled policy: ${state.detail}. ` +
        `Recompile it with: ironcurtain persona compile ${name}`,
      'POLICY_STALE',
    );
  }
  refuseUnauthorizedBreadth(name, persona);

  return {
    policyDir: getPersonaGeneratedDir(name),
    persona,
    workspacePath: getPersonaWorkspaceDir(name),
    ...(state.kind === 'stale' ? { stalePolicy: { reason: state.reason, detail: state.detail } } : {}),
  };
}

/**
 * Refuses the persona's compiled policy when it grants broad access (broad
 * wildcard domains or lists, out-of-workspace `paths.within`, unconstrained
 * resource arguments on `allow` rules) and the persona has not opted in. Only
 * an explicit `allowBroadPolicy: true` counts as the opt-in.
 */
function refuseUnauthorizedBreadth(name: PersonaName, persona: PersonaDefinition): void {
  if (persona.allowBroadPolicy === true) return;
  const findings = inspectCompiledPolicyBreadth(getPersonaGeneratedDir(name), getPersonaWorkspaceDir(name));
  if (!hasBroadAccess(findings)) return;
  throw new ScopedPolicyError(
    `Persona "${name}" has a compiled policy that grants broad access (${describeBroadAccess(findings).join('; ')}), ` +
      'but the persona has not opted in to broad policies. Narrow its constitution and recompile ' +
      `(ironcurtain persona compile ${name}), or allow broad access with: ` +
      `ironcurtain persona compile ${name} --allow-broad`,
    'POLICY_TOO_BROAD',
  );
}

// ---------------------------------------------------------------------------
// Server allowlist filtering
// ---------------------------------------------------------------------------

/**
 * Filters MCP servers to only those in the allowlist.
 * The "filesystem" server is always included even if omitted from
 * the allowlist -- this is a hardcoded safety invariant since the
 * agent sandbox requires filesystem access to function.
 *
 * The memory server is NOT in the always-included set; it is opt-in
 * per persona/job and injected by `buildSessionConfig` after this
 * filter runs (gated by `isMemoryEnabledFor`). See
 * docs/designs/per-persona-memory-optin.md.
 */
export function applyServerAllowlist(
  mcpServers: Record<string, MCPServerConfig>,
  allowlist: readonly string[],
): Record<string, MCPServerConfig> {
  // Warn about server names in the allowlist that are not configured:
  // `mcpServers` is the merged configuration from loadConfig() (the
  // package's servers plus the user's ~/.ironcurtain/mcp-servers.json). This
  // catches typos and stale references without breaking the persona
  // (non-fatal warning).
  const knownServers = new Set(Object.keys(mcpServers));
  for (const name of allowlist) {
    if (!knownServers.has(name) && !ALWAYS_INCLUDED_SERVERS.has(name)) {
      process.stderr.write(
        `Warning: persona allowlist includes unknown server ${JSON.stringify(name)} ` +
          '(not a configured MCP server; see `ironcurtain mcp list`)\n',
      );
    }
  }

  // Exact names only: a Set, so nothing but a whole server name can match
  // (persona.json validation already guarantees `allowlist` is an array).
  const allowed = new Set(allowlist);
  const filtered: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (allowed.has(name) || ALWAYS_INCLUDED_SERVERS.has(name)) {
      filtered[name] = config;
    }
  }
  return filtered;
}

/**
 * Filters MCP servers to only those referenced by the compiled policy.
 * Trusts the policy completely -- no hardcoded exceptions; the memory
 * server is injected by `buildSessionConfig` after this filter runs.
 */
export function filterMcpServersByPolicy(
  mcpServers: Record<string, MCPServerConfig>,
  requiredServers: ReadonlySet<string>,
): Record<string, MCPServerConfig> {
  const filtered: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (requiredServers.has(name)) {
      filtered[name] = config;
    }
  }
  return filtered;
}
