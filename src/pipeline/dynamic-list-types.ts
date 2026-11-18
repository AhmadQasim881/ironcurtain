/**
 * List Type Registry -- taxonomy of dynamic list value types.
 *
 * Each type determines:
 * - How values are validated during resolution
 * - What format guidance is appended to the generation prompt
 *
 * Runtime value/pattern matching lives in `src/trusted-process/list-matcher.ts`
 * so the policy engine does not depend on the offline pipeline layer.
 *
 * Also defines which MCP server a data-backed list may read
 * (`getMcpListScopeError`), shared by the compiler schema, the resolver
 * connection setup, and the resolver itself.
 */

import { classifyHost } from '../types/public-suffix.js';
import type { ListDefinition, ListType } from './types.js';

export interface ListTypeDef {
  readonly description: string;

  /**
   * Validates that a resolved value is well-formed for this type.
   * Used during resolution to filter out malformed LLM output.
   */
  readonly validate: (value: string) => boolean;

  /**
   * Suffix mechanically appended to the generation prompt when the
   * resolver LLM is called. The compiler LLM does NOT include format
   * instructions in its generationPrompt -- the type registry handles
   * this automatically based on the list type.
   */
  readonly formatGuidance: string;
}

/** Hostname syntax: dot-separated labels of letters, digits and inner hyphens. */
const HOSTNAME_SYNTAX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/**
 * Why a value cannot go into a `domains` list, or undefined when it can.
 *
 * A value is a hostname (`example.com`) or a prefix wildcard
 * (`*.example.com`); whitespace, schemes and paths are refused. The hostname
 * must lie inside one registrable domain of the Public Suffix List, so IP
 * literals, localhost and other local or private-use names, single labels,
 * unknown TLDs and public suffixes themselves (`com`, `co.uk`, `github.io`)
 * are refused. A wildcard must not be broad (`isBroadDomainPattern` in
 * src/types/public-suffix.ts): `*.co.uk`, `*.github.io` and `*.amazonaws.com`
 * are refused, while `*.github.com` and `*.example.co.uk` are kept. The same
 * check applies whether the resolver LLM wrote the wildcard or the resolver
 * added it.
 */
export function describeDomainValueProblem(value: string): string | undefined {
  if (value.length === 0 || /\s/.test(value)) return 'not a hostname';
  const wildcard = value.startsWith('*.');
  const hostname = wildcard ? value.slice(2) : value;
  if (!HOSTNAME_SYNTAX.test(hostname)) return 'not a hostname';
  const host = classifyHost(hostname);
  switch (host.kind) {
    case 'invalid':
      return 'not a hostname';
    case 'ip':
      return 'an IP address';
    case 'local':
      return 'a local, private-use or single-label name';
    case 'public-suffix': {
      const section = host.section === 'private' ? 'multi-tenant hosting' : 'registry';
      return `${wildcard ? 'a wildcard over ' : ''}a public suffix (${section} section of the Public Suffix List)`;
    }
    case 'registrable':
      if (wildcard && host.multiTenantParent !== undefined) {
        return `a wildcard over the multi-tenant domain ${host.multiTenantParent}`;
      }
      return undefined;
  }
}

/** Validates a `domains` list value; see {@link describeDomainValueProblem}. */
function isValidDomain(value: string): boolean {
  return describeDomainValueProblem(value) === undefined;
}

function isValidEmail(value: string): boolean {
  return value.includes('@') && !/\s/.test(value) && value.length > 2;
}

function isValidIdentifier(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

export const LIST_TYPE_REGISTRY: ReadonlyMap<ListType, ListTypeDef> = new Map<ListType, ListTypeDef>([
  [
    'domains',
    {
      description: 'Domain names or wildcard domain patterns',
      validate: isValidDomain,
      formatGuidance: 'Return domain names or wildcard patterns like `*.example.com`.',
    },
  ],
  [
    'emails',
    {
      description: 'Email addresses',
      validate: isValidEmail,
      formatGuidance: 'Return email addresses in `user@domain` format.',
    },
  ],
  [
    'identifiers',
    {
      description: 'Plain string identifiers',
      validate: isValidIdentifier,
      formatGuidance: 'Return identifiers as plain strings, one per entry.',
    },
  ],
]);

// ---------------------------------------------------------------------------
// MCP scope of data-backed lists
// ---------------------------------------------------------------------------

/**
 * MCP servers that exist to reach arbitrary network endpoints. List
 * resolution never connects them: the resolver LLM reads untrusted data
 * (mail, issues, documents), and a URL it fetches or a query it searches for
 * would carry that data to whoever controls the destination. The read-only
 * policy alone does not prevent that, because it permits some web access.
 */
export const LIST_RESOLUTION_EXCLUDED_SERVERS: ReadonlySet<string> = new Set(['fetch']);

/**
 * Returns why a list definition cannot be resolved from MCP data, or
 * undefined when its scope is acceptable. Knowledge-based lists
 * (`requiresMcp: false`) are always acceptable.
 *
 * A data-backed list must name the single MCP server it reads in
 * `mcpServerHint`. There is no "connect every server" fallback, and
 * network-egress servers (`LIST_RESOLUTION_EXCLUDED_SERVERS`) are refused.
 */
export function getMcpListScopeError(
  definition: Pick<ListDefinition, 'name' | 'requiresMcp' | 'mcpServerHint'>,
): string | undefined {
  if (!definition.requiresMcp) return undefined;
  // JSON quoting keeps names read back from an artifact on disk printable.
  const list = JSON.stringify(`@${definition.name}`);
  const server = definition.mcpServerHint;
  if (!server) {
    return (
      `List ${list} has requiresMcp: true but no mcpServerHint. ` +
      `A data-backed list must name the one MCP server that holds its data.`
    );
  }
  if (LIST_RESOLUTION_EXCLUDED_SERVERS.has(server)) {
    return (
      `List ${list} names the network server ${JSON.stringify(server)} as its data source. ` +
      `Network-fetch servers cannot back a dynamic list; use requiresMcp: false for ` +
      `knowledge-based lists or name the server that stores the data.`
    );
  }
  return undefined;
}
