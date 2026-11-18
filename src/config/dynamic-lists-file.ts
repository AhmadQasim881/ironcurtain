/**
 * Names shared by everything that reads or writes a policy's
 * dynamic-lists.json: the runtime policy loader (config/index.ts) and
 * compile-policy and refresh-lists (src/pipeline/). Leaf module.
 *
 * The file holds resolver output and the user's manual overrides
 * (`manualAdditions` / `manualRemovals`), and users edit it by hand, so it is
 * only ever read through the runtime schema (`loadDynamicListsArtifact` in
 * config/index.ts, src/types/policy-schema.ts): a file that is not valid
 * JSON, or whose values and overrides are not arrays of strings, is an error
 * naming the file and each offending field. A string where an array belongs
 * would otherwise be spread into its characters: `"manualAdditions": "*.com"`
 * would add `*`, which matches every domain, and `"manualRemovals":
 * "evil.example"` would remove nothing.
 */

/** File name of a policy's resolved dynamic lists (merged and per-server). */
export const DYNAMIC_LISTS_FILENAME = 'dynamic-lists.json';

/**
 * `inputHash` of an UNRESOLVED list entry (a data-backed list that a run
 * without MCP access could not resolve). No resolution hash is empty, so such
 * an entry is never taken for a valid resolution: it is never a cache hit and
 * never matches a shipped resolution.
 */
export const UNRESOLVED_LIST_HASH = '';
