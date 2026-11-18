# Design: Dynamic Lists for Policy Rules

**Status (2026-11-14):** Implemented (`src/pipeline/list-resolver.ts`). Values resolved through MCP tools are written without a confirmation step; see the list-poisoning note near the end.

**Date:** 2026-02-20

## Problem

The constitution is plain English. It references categories of things that can't be hardcoded into static policy rules:

- "collect news from the major news sites" -- which domains count as "major news sites"?
- "send email to people in my contacts without asking" -- which email addresses are in my contacts?
- "get financial data for major tech stocks" -- which ticker symbols? which data provider domains?

Today, the constitution compiler must either inline concrete values (making constitutions brittle and verbose) or produce overly broad rules (allowing all domains when only a category was intended). Neither is acceptable: the first defeats the purpose of plain-English constitutions, and the second defeats the purpose of policy enforcement.

We need a mechanism where the compiler recognizes categorical references, emits symbolic list names in compiled rules, and a resolution step populates those lists from LLM knowledge or live MCP tool calls. The resolved lists are user-inspectable, user-editable, and refreshable.

## Design Overview

Dynamic lists are an extension to the policy compilation pipeline. The compiler emits `@list-name` symbolic references in rule conditions wherever it encounters a categorical reference in the constitution. Alongside the rules, it emits a **list definition** for each symbolic name: a name, a type, and a generation prompt. A new pipeline sub-step resolves each list definition by running its prompt through an LLM that optionally has access to MCP servers (for data-backed lists like contacts). Resolved values are written to a separate artifact (`dynamic-lists.json`) that users can inspect and edit. At policy load time, `@list-name` references are expanded to concrete values, keeping the policy engine's hot path unchanged.

```
Constitution text + tool annotations
        |
        v
+----------------------------+
| Constitution Compiler LLM  |  -->  compiled-policy.json (rules with @list-name refs)
+----------------------------+       + list definitions
        |
        v
+----------------------------+
| List Resolver (LLM + MCP)  |  -->  dynamic-lists.json (resolved concrete values)
+----------------------------+
        |
        v
+----------------------------+
| Policy Engine (load time)  |      @list-name -> concrete values (inline expansion)
+----------------------------+
```

The list definitions are persisted in `compiled-policy.json` (the authoritative source) so that `ironcurtain refresh-lists` can re-resolve them without re-running the full compilation pipeline.

## Key Design Decisions

1. **The compiler decides what needs a list, not the user.** The constitution stays plain English. The compiler prompt instructs the LLM to identify categorical references and emit `@list-name` symbolic names in rule conditions. No special syntax or markers are needed in the constitution text. The compiler's judgment about what constitutes a "category" is validated by the existing verification pipeline.

2. **Lists are typed for matching semantics.** Each list has a `type` field from a fixed (but extensible) taxonomy. The type determines how values in the list are compared against tool call arguments at evaluation time. This prevents a domain-pattern list from being accidentally used for email matching or vice versa. The initial types are `domains`, `emails`, and `identifiers`. New types are added by extending the `ListType` union and adding a matcher function to the registry.

3. **Resolution is a sub-step of `compile-policy`, not a separate command.** After rules are compiled and list definitions are extracted, the resolver runs as step 1.5 (between compilation and scenario generation). This ensures that resolved lists are available for scenario generation and verification. The resolver can optionally connect to MCP servers for data-backed lists (e.g., querying a contacts server). If MCP connections are unavailable, knowledge-based lists still resolve via the LLM's training data.

4. **Resolved lists are a separate, user-editable artifact.** `dynamic-lists.json` is distinct from `compiled-policy.json`. Users can inspect resolved lists and add or remove entries through each list's `manualAdditions` / `manualRemovals`, and the edits persist across `compile-policy` and `refresh-lists` runs (see "Manual Overrides" below). This gives users a concrete, auditable view of what "major news sites" means for their policy.

5. **`@list-name` expansion happens at policy load time, not evaluation time.** When `PolicyEngine` loads `compiled-policy.json`, it resolves all `@list-name` references by substituting concrete values from `dynamic-lists.json`. Allow and assess rules use the resulting concrete values. For escalation and deny rules, an unavailable or incomplete list cannot narrow the applicable condition; the engine preserves its roles and other predicates and matches its present resource values conservatively. A missing list logs a warning without preventing policy load.

6. **Refresh is a targeted command, not a full recompile.** `ironcurtain refresh-lists` re-resolves the list definitions persisted in `compiled-policy.json` using their generation prompts, for the global policy or for a persona's or a cron job's policy. It does not re-run the constitution compiler or re-generate scenarios. The refresh connects to MCP servers for data-backed lists (unless `--no-mcp`). Manual overrides are preserved during refresh.

7. **List definitions are part of the compiled policy artifact.** The `CompiledPolicyFile` gains a `listDefinitions` field. This keeps the list definitions co-located with the rules that reference them and ensures they are versioned together. The resolved values live in the separate `dynamic-lists.json` artifact.

## Data Model

### List Type Registry

```typescript
// src/pipeline/dynamic-list-types.ts

/**
 * Taxonomy of list value types. Each type determines:
 * - How values are matched against tool call arguments
 * - What format the resolved values should be in
 * - How the values are displayed to users
 */
export type ListType = 'domains' | 'emails' | 'identifiers';

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

export const LIST_TYPE_REGISTRY: ReadonlyMap<ListType, ListTypeDef>;
```

Initial type definitions:

| Type          | Validate                                                                                                | Format guidance                                                 | Matching semantics                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `domains`     | Hostname inside one registrable domain, or a narrow `*.hostname` (Public Suffix List checks, see below) | "Return domain names or wildcard patterns like `*.example.com`" | Uses existing `domainMatchesAllowlist()`                           |
| `emails`      | Contains `@`, valid-ish format                                                                          | "Return email addresses in `user@domain` format"                | Exact match (case-insensitive local part, case-insensitive domain) |
| `identifiers` | Non-empty string, no whitespace                                                                         | "Return identifiers as plain strings, one per entry"            | Exact match (case-sensitive)                                       |

### List Definition (emitted by compiler)

```typescript
// Addition to src/pipeline/types.ts

/**
 * A symbolic list definition emitted by the constitution compiler.
 * The compiler creates these when it encounters categorical references
 * in the constitution text.
 *
 * Invariant: the `name` matches the @list-name reference in compiled rules.
 * Invariant: the `type` determines matching semantics at evaluation time.
 */
export interface ListDefinition {
  /** Symbolic name, e.g., "major-news-sites". Used as @major-news-sites in rules. */
  readonly name: string;

  /** Determines matching semantics and value validation. */
  readonly type: ListType;

  /**
   * The constitution text that motivated this list.
   * Used for provenance tracking and display to users.
   */
  readonly principle: string;

  /**
   * Prompt for the resolver LLM to generate concrete values.
   * Written by the compiler LLM based on the constitution context.
   * Example: "List the 20 most popular English-language news websites
   *           by domain name, including their main domains."
   */
  readonly generationPrompt: string;

  /**
   * When true, the resolver should connect to MCP servers to resolve
   * this list (e.g., querying a contacts database). When false, the
   * resolver uses only LLM knowledge (and optionally web search).
   */
  readonly requiresMcp: boolean;

  /**
   * The one MCP server a data-backed list reads. Required when
   * requiresMcp is true; resolution connects only this server (never
   * "all servers", never a network-egress server such as fetch).
   */
  readonly mcpServerHint?: string;
}
```

### Resolved List Artifact

```typescript
// src/pipeline/types.ts

/**
 * A single resolved dynamic list with its values and metadata.
 *
 * Note: does NOT embed the ListDefinition. The authoritative definitions
 * live in CompiledPolicyFile.listDefinitions. This avoids duplication
 * and drift between the two artifacts. The refresh-lists command reads
 * definitions from compiled-policy.json, not from this file.
 */
export interface ResolvedList {
  /** Fresh nonempty output with no validation loss; legacy omission is uncertain. */
  readonly resolutionState?: 'complete' | 'incomplete';

  /** The concrete resolved values. */
  readonly values: string[];

  /**
   * User-supplied additions that are always included regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualAdditions: string[];

  /**
   * User-supplied removals that are always excluded regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualRemovals: string[];

  /** ISO timestamp of last resolution. */
  readonly resolvedAt: string;

  /** Content hash of inputs that produced this resolution. */
  readonly inputHash: string;
}

/**
 * The dynamic-lists.json artifact.
 */
export interface DynamicListsFile {
  readonly generatedAt: string;
  readonly lists: Record<string, ResolvedList>; // keyed by list name
}
```

The effective values for a list at load time are:

```
effective = (resolved.values + manualAdditions) - manualRemovals
```

### Compiled Policy Extension

```typescript
// Extension to CompiledPolicyFile (src/pipeline/types.ts)

export interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  rules: CompiledRule[];

  /** List definitions emitted by the compiler. Empty if no dynamic lists needed. */
  listDefinitions?: ListDefinition[];
}
```

### Rule Condition Extension

The `@list-name` syntax is used exclusively in `DomainCondition.allowed` arrays and a new `ListCondition`:

```typescript
// Extension to CompiledRuleCondition

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  paths?: PathCondition;
  domains?: DomainCondition; // allowed[] may contain "@list-name" entries
}
```

A `@list-name` entry in `DomainCondition.allowed` is expanded at load time to the concrete domain values from the corresponding resolved list. This means the existing `domainMatchesAllowlist()` function works unchanged -- it never sees `@` prefixed strings.

For non-domain list types (emails, identifiers), the `@list-name` reference appears in a new condition type:

```typescript
/**
 * Condition that matches argument values against a dynamic list.
 * Used for non-domain list types (emails, identifiers).
 *
 * At load time, @list-name is resolved to concrete values.
 * At evaluation time, the values are matched using the list type's semantics.
 */
export interface ListCondition {
  /** Which argument roles to extract values from. */
  readonly roles: ArgumentRole[];

  /**
   * Allowed values or @list-name references.
   * After load-time expansion, contains only concrete values.
   */
  readonly allowed: string[];

  /** How to match values. Determines comparison semantics. */
  readonly matchType: ListType;
}
```

And `CompiledRuleCondition` gains:

```typescript
export interface CompiledRuleCondition {
  // ... existing fields ...
  lists?: ListCondition[]; // for email, identifier, and other non-domain lists
}
```

`lists` is an array so that a single rule can reference multiple list conditions with different roles and match types (e.g., checking both an email recipient list and an identifier list). Each `ListCondition` in the array must be satisfied for the rule to match (AND semantics, consistent with how multiple conditions interact elsewhere).

## Compiler Changes

### Return Type Changes

The existing `compileConstitution()` function returns only `CompiledRule[]`, discarding everything else from the LLM response. It must be extended to return both rules and list definitions:

```typescript
// constitution-compiler.ts

export interface CompilationOutput {
  rules: CompiledRule[];
  listDefinitions: ListDefinition[];
}

export async function compileConstitution(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  llm: LanguageModel,
  repairContext?: RepairContext,
  onProgress?: (message: string) => void,
): Promise<CompilationOutput> {
  // ... existing code ...
  return { rules: output.rules, listDefinitions: output.listDefinitions ?? [] };
}
```

This change cascades through the compilation pipeline in `compile.ts`:

- **`CompilationResult`** gains a `listDefinitions: ListDefinition[]` field alongside `rules` and `inputHash`.
- **`compilePolicyRules()`** returns list definitions from the compiler output.
- **`compilePolicyRulesWithRepair()`** likewise carries list definitions through. The `RepairContext.previousRules` already contains the full rule set; list definitions do not change during repair (they are derived from the constitution, not from rule structure), so the repair loop does not need to pass them back. If the repaired output includes different list definitions, the new ones are used.
- **`buildPolicyArtifact()`** includes `listDefinitions` in the `CompiledPolicyFile` output.
- **`validateCompiledRules()`** is extended to also accept `listDefinitions` and validate cross-references (see Validation below).

### Prompt Extension

The constitution compiler prompt is extended with instructions for emitting list definitions:

```
## Dynamic Lists

When the constitution references a CATEGORY of things (e.g., "major news sites",
"my contacts", "tech stocks"), do NOT hardcode specific values. Instead:

1. Choose a descriptive kebab-case name for the category (e.g., "major-news-sites").
2. In the rule condition, use "@major-news-sites" as an entry in the allowed list.
3. In the listDefinitions output, emit a ListDefinition with:
   - name: the symbolic name (without @)
   - type: "domains" for website/domain categories, "emails" for email address
     categories, "identifiers" for other value categories
   - principle: the constitution text that references this category
   - generationPrompt: a clear prompt describing WHAT to list (quantity, scope).
     Do NOT include format instructions (e.g., "return domain names only") --
     format guidance is added mechanically based on the list type.
   - requiresMcp: true ONLY if the list requires querying live data from an
     MCP server (e.g., "my contacts" needs a contacts database).
     false for knowledge-based lists (e.g., "major news sites").
   - mcpServerHint: REQUIRED when requiresMcp is true -- the name of the one
     MCP server that holds the data. Resolution reads only that server, under
     a read-only policy. A web-fetch server ("fetch") cannot back a list.

When the constitution says something like "any domain" or "all", do NOT create a
list. Use the wildcard pattern "*" directly.

Examples:
- "major news sites" -> @major-news-sites (type: domains, requiresMcp: false)
- "people in my contacts" -> @my-contacts (type: emails, requiresMcp: true, mcpServerHint: "google-workspace")
- "major tech stocks" -> @tech-stock-tickers (type: identifiers, requiresMcp: false)
```

### Schema Extension

The compiler's Zod response schema is extended to accept `listDefinitions`:

```typescript
const listDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    type: z.enum(['domains', 'emails', 'identifiers']),
    principle: z.string(),
    generationPrompt: z.string(),
    requiresMcp: z.boolean(),
    mcpServerHint: z.string().optional(),
  })
  // requiresMcp: true needs an mcpServerHint that is not a network-egress
  // server; a violation is fed back to the compiler LLM as a repair error.
  .superRefine((definition, ctx) => {
    const scopeError = getMcpListScopeError(definition); // dynamic-list-types.ts
    if (scopeError) ctx.addIssue({ code: 'custom', message: scopeError, path: ['mcpServerHint'] });
  });

// Extended response schema
const responseSchema = z.object({
  rules: z.array(compiledRuleSchema),
  listDefinitions: z.array(listDefinitionSchema).optional(),
});
```

### Validation

Post-compilation validation (`validateCompiledRules`) is extended to accept `listDefinitions` alongside rules:

1. Every `@list-name` reference in rule conditions must have a corresponding entry in `listDefinitions`.
2. Every entry in `listDefinitions` must be referenced by at least one rule.
3. **Domain lists go in `DomainCondition.allowed` only.** A `@list-name` reference to a `type: 'domains'` list must appear in `DomainCondition.allowed`, never in `ListCondition`. Conversely, `ListCondition` must only reference non-domain list types. This prevents two code paths for the same matching semantics and is enforced as a validation error.
4. When a `ListCondition` references `@list-name`, its `matchType` must equal the referenced list definition's `type`. A mismatch (e.g., `matchType: 'identifiers'` referencing a `type: 'emails'` list) would cause semantically incorrect matching and is a validation error.

The policy lint runs next to this validation and again once the lists are resolved, with each `@list` expanded to its effective values. An allow rule that reaches `*` or a public-suffix wildcard through a list is an error unless the policy opts in to broad domains (see `docs/designs/per-server-policy-compilation.md`, "Deterministic Rule Checks"). For servers whose tools take URLs, the compiler prompt's "any domain → `*`" guidance is qualified by a "Broad Egress" section when the policy has not opted in: `*` is then for escalate rules only.

## Resolution Pipeline

### New Module: `src/pipeline/list-resolver.ts`

```typescript
import type { LanguageModel } from 'ai';
import type { ListDefinition, ResolvedList, DynamicListsFile } from './types.js';

export interface ListResolverConfig {
  /** Pre-created LLM for resolution prompts. */
  readonly model: LanguageModel;

  /**
   * Policy-mediated MCP access for data-backed lists, from
   * `connectViaProxy` (src/pipeline/proxy-mcp-connections.ts). Every tool
   * call goes through a ToolCallCoordinator under the read-only policy;
   * the LLM is only told about tools marked `offered`. Required for lists
   * with requiresMcp: true -- resolution fails without it.
   */
  readonly mcpConnection?: Pick<MediatedMcpConnection, 'tools' | 'callTool'>;
}

/**
 * Resolves a list definition to concrete values.
 *
 * For knowledge-based lists (requiresMcp: false): sends the generation
 * prompt to the LLM and parses the response.
 *
 * For data-backed lists (requiresMcp: true): gives the LLM access to
 * MCP tools (via tool-use) so it can query live data sources.
 *
 * Applies type-specific validation to filter malformed values.
 * Preserves manual overrides from any existing resolution.
 */
export async function resolveList(
  definition: ListDefinition,
  config: ListResolverConfig,
  existing?: ResolvedList,
  onProgress?: (message: string) => void,
): Promise<ResolvedList>;

/**
 * Resolves all list definitions, respecting content-hash caching.
 * Skips resolution for lists whose inputs haven't changed and whose
 * existing resolution is still valid.
 */
export async function resolveAllLists(
  definitions: ListDefinition[],
  config: ListResolverConfig,
  existingLists?: DynamicListsFile,
  onProgress?: (message: string) => void,
): Promise<DynamicListsFile>;
```

### Resolution Flow

The resolver uses a Zod schema to get structured output from the LLM, ensuring the response is a typed array of strings rather than free-form text that needs fragile parsing:

```typescript
const listResponseSchema = z.object({
  values: z.array(z.string()).describe('The list of resolved values'),
});
```

For a knowledge-based list (e.g., "major news sites"):

```
LLM prompt:
  "List the 20 most popular English-language news websites by domain name.
   Return domain names or wildcard patterns like *.example.com."

LLM structured response (via Zod schema):
  { "values": ["cnn.com", "bbc.com", "nytimes.com", "reuters.com", ...] }

Post-processing:
  1. Validate each value with LIST_TYPE_REGISTRY['domains'].validate()
  2. Deduplicate
  3. Add `*.host` for each hostname under an ICANN suffix (www.nytimes.com
     then matches too); never for a name under a multi-tenant suffix
  4. Apply manual overrides: add manualAdditions, remove manualRemovals
```

Domain values are checked against the Public Suffix List (PSL, both its ICANN and private sections, via `tldts`; `src/types/public-suffix.ts`), because the runtime matcher treats `*.S` as a plain suffix match and reaches every host under `S`:

- A hostname must lie inside one registrable domain. IP literals in any spelling (`169.254.169.254`, `127.1`, `2130706433`), `localhost` and other local or private-use names (`*.local`, `*.internal`, `*.home.arpa`, cloud metadata names), single labels, names under an unknown TLD, and public suffixes themselves (`com`, `co.uk`, `github.io`, `readthedocs.io`) are dropped with a warning that names the reason.
- A wildcard is dropped when it is broad (`isBroadDomainPattern`): `*.S` where `S` is a public suffix of either PSL section (`*.co.uk`, `*.github.io`, `*.pages.dev`), lies at or under a curated multi-tenant cloud parent (`*.amazonaws.com`, `*.github.dev`), lies directly above a PSL wildcard rule so that each of its children is a separate tenant's suffix (`*.gateway.dev`), or is not a registrable public name. The same check applies to a wildcard the resolver LLM wrote and to the ones post-processing adds.
- Step 3 only widens a hostname whose public suffix is from the ICANN section and that is not such a multi-tenant parent or under a curated one. A name such as `raw.githubusercontent.com` or `alice.github.io` stays exact, since a wildcard over it would reach other tenants' hosts.
- Validation rules can tighten between releases and the cache key does not cover them, so a cached resolution (and, at merge time, the lists of a server served from its verified cache) is re-validated; manual additions are kept as the user's explicit choice.

The policy lint (`src/pipeline/policy-lint.ts`) checks the same breadth on the rules: an allow rule that reaches a broad wildcard, `*` included, through a `@list` (with its effective values, so a manual addition counts) is rejected unless the policy opts in to broad domains (`compile-policy --allow-broad-domains`, the constitution directive, or a persona's `allowBroadPolicy`; never for a cron job).

`compile-policy` and `refresh-lists` print, per list, every value the resolution added and removed (escaped for the terminal), so new allowlist entries can be reviewed.

For a data-backed list (e.g., "my contacts", `mcpServerHint: "contacts"`):

```
LLM is offered the contacts server's tools that the read-only policy can
allow (e.g., list_contacts); every call it makes, offered or not, is
evaluated by the security kernel and audited

LLM prompt:
  "Query the contacts database and return all email addresses.
   Return email addresses in user@domain format."

LLM tool call: contacts__list_contacts({})
LLM receives: [{name: "Alice", email: "alice@example.com"}, ...]

LLM structured response (via Zod schema):
  { "values": ["alice@example.com", "bob@company.org", ...] }

Post-processing: same as above but with email validation
```

### Pipeline Integration

The resolution step slots into `compile.ts` after rule compilation:

```
[1/4] Compiling constitution         (existing, now emits listDefinitions)
[1.5/4] Resolving dynamic lists      (NEW -- only runs if listDefinitions present)
[2/4] Generating test scenarios       (existing, receives resolved list values)
[3/4] Verifying policy                (existing, PolicyEngine receives dynamicLists)
```

When no `listDefinitions` are present in the compiled output, step 1.5 is skipped entirely. The pipeline numbering adjusts dynamically.

### Integration with Scenario Generation and Verification

Both downstream pipeline steps need access to resolved lists:

**Scenario generation** (`generateScenarios()`) must produce test scenarios that exercise list-based rules. The scenario generator prompt is extended with a summary of resolved lists and their effective values, so the LLM can generate both positive scenarios (e.g., "fetch cnn.com — expect allow") and negative scenarios (e.g., "fetch evil.com — expect deny"). The resolved list values become part of the scenario hash, so a list refresh invalidates cached scenarios.

**Verification** constructs `PolicyEngine` instances at three points in `compile.ts`:

1. `filterEngine` (line 472) — for filtering structural conflicts from scenarios
2. `verifyCompiledPolicy()` which calls `verifyPolicy()` in `policy-verifier.ts` (line 151) — the main verification engine
3. During repair loop iterations — reuses `verifyCompiledPolicy()`

All three must pass the `DynamicListsFile` so that `@list-name` references are expanded before evaluation. The `verifyCompiledPolicy()` function gains a `dynamicLists` parameter that is threaded through to the `PolicyEngine` constructor. The `filterEngine` in `compile.ts` is constructed with the same `dynamicLists`.

### Caching

Each resolved list has an `inputHash` computed from:

- The list definition (name, type, generationPrompt, requiresMcp, and for a data-backed list its mcpServerHint, so values read from one server are never reused for a definition that names another)
- The resolver prompt template

If the hash matches the existing resolution, the LLM call is skipped. Manual overrides are never part of the hash -- they are always preserved.

A run without MCP access (`compile-policy --no-mcp`) cannot resolve a data-backed list. If the list has no valid cached resolution, it gets an UNRESOLVED entry instead of failing the server: no values, the user's overrides kept, and an empty `inputHash`, which no run takes for a cache hit. A loud warning names the list. Allow rules using it match only the manual additions; escalation and deny conditions remain restrictive until a run with MCP access resolves it; a later `compile-policy` with MCP access also refuses to serve that server's cached rules as they are (they were verified against the empty list): it resolves the list and verifies the rules again with its values.

### Manual Overrides

Effective values are `(values + manualAdditions) - manualRemovals`, computed by the policy engine at load time. The overrides live only in a policy's merged `dynamic-lists.json` (the file next to `compiled-policy.json`, which users edit); the per-server copies under `servers/<server>/` and the `values` field hold resolver output only, and the overrides are never fed into the resolver, so removing a value from `manualAdditions` takes effect at the next policy load.

`compile-policy` rebuilds the merged file from the per-server resolutions and carries every list's overrides over from the previous merged file (`src/pipeline/list-merge.ts`), even when every server is served from cache. When the merge renames a list because servers define its name differently (see "Lists Across Per-Server Compilation"), the removals of every previous list with that base name follow it, and its additions follow only from a previous list resolved from the same definition. Entries the new policy no longer uses are kept while they hold overrides. A list the policy uses that has no per-server resolution is written UNRESOLVED with its overrides; the values of an earlier resolution left in the previous merged file are never reused.

Every reader of a `dynamic-lists.json` (compile-policy, refresh-lists and the runtime policy loader) reads it through the runtime schema (see "Validation on load"): a file that is not valid JSON, or whose values or overrides are not arrays of strings, is an error naming the file and each offending field. A compile or refresh then stops instead of overwriting it, and a session does not start. The file is never coerced: the engine would spread a string where an array belongs into its characters, so `"manualAdditions": "*.com"` would add `*`, which matches every domain. The per-server copies are read the same way: a malformed one fails that server's compile, and stops a refresh that would write through to it before any model is set up; it is left as it is.

### Lists Across Per-Server Compilation

Each server compiles, resolves and verifies its own lists. Servers that define a list name identically share one merged list. When servers define a name differently (type, generation prompt, `requiresMcp`, or the MCP server a data-backed list reads), each keeps its own: the merge renames it `<server>--<name>` in that server's rules and in the merged definitions, which record the original name in `sourceName`, so no server's rules expand to values resolved for another server's definition. The merged rules are validated against the merged definitions again, and a rename that would collide with another list's name fails the merge. Details: `docs/designs/per-server-policy-compilation.md`.

## Policy Engine Changes

### Loading Dynamic Lists at Runtime

The existing `loadGeneratedPolicy()` in `src/config/index.ts` returns `{ compiledPolicy, toolAnnotations }`. It must be extended to also load `dynamic-lists.json` when present:

```typescript
export function loadGeneratedPolicy(options: PolicyLoadOptions): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: StoredToolAnnotationsFile;
  dynamicLists: DynamicListsFile | undefined; // NEW
} {
  // compiled-policy.json from options.policyDir, else options.fallbackDir (the package)
  // ... existing loading ...
  const dynamicLists = loadDynamicListsFor(compiledPolicy, policySourceDir);
  return { compiledPolicy, toolAnnotations, dynamicLists };
}
```

A policy and its lists are one unit: `dynamic-lists.json` is read from the directory the compiled policy came from, never from another policy's directory (a locally compiled policy never picks up the package's lists). `loadPersonaPolicyArtifacts()` (persona, job and workflow hot-swap policies) loads lists the same way.

The one exception is the policy shipped with the package, which users who never compiled locally run with. `ironcurtain refresh-lists` cannot write next to it, so it writes `~/.ironcurtain/generated/dynamic-lists.json`, which the loader layers over the shipped lists (`layerUserDynamicLists`): per list, the user's overrides always apply, and the user's values replace the shipped ones only when they were resolved for the same definition (equal `inputHash`) and no earlier than the shipped ones (`resolvedAt`). Otherwise the shipped values are used: a warning asks for a refresh when an upgrade changed the definition, and a note says so when an upgrade shipped a newer resolution (which may drop values an older one had, so a user's earlier refresh never masks it). The package ships `dynamic-lists.json` next to its `compiled-policy.json` (package `files` and `scripts/copy-assets.mjs`).

When the compiled policy defines lists but no lists file exists, the loader logs a warning, and `ironcurtain doctor` reports the lists that have no values: rules that use them match nothing.

The three runtime call sites that construct `PolicyEngine` must pass the loaded `dynamicLists`:

1. **`mcp-proxy-server.ts`** (line 258-261) — the standalone MCP proxy process
2. **`trusted-process/index.ts`** (line 33-36) — the in-process `TrustedProcess` class
3. **`pipeline/policy-verifier.ts`** (line 151) — the verification step during compilation

All three follow the same pattern: destructure `dynamicLists` from `loadGeneratedPolicy()` and pass it as the new final argument to `new PolicyEngine(...)`.

**Validation on load.** `loadGeneratedPolicy()` and `loadPersonaPolicyArtifacts()` parse `dynamic-lists.json` through the runtime schema in `src/types/policy-schema.ts` instead of casting it. Each list's `values`, `manualAdditions` and `manualRemovals` must be arrays of strings: a string such as `"manualAdditions": "*.bbc.co.uk"` used to be spread into single characters, putting a bare `*` in the allowlist. Unknown keys in a list are rejected, so a misspelled `manualRemovals` cannot silently keep a value the user removed. Missing `manualAdditions` / `manualRemovals` default to empty arrays, since users add them by hand. A malformed file throws `PolicyArtifactError` (`code: 'POLICY_ARTIFACT_INVALID'`) naming the file and each field, and the session (or the policy hot-swap) does not start. The engine looks a `@list` up among the file's own lists only, so a name such as `@constructor` never resolves to an inherited object member.

List resolution reads the file through the same loader (`loadDynamicListsArtifact` in `src/config/index.ts`): `refresh-lists` for `dynamic-lists.json` and the per-server copies it updates, and `compile-policy` for each server's `servers/<name>/dynamic-lists.json` and for the merged file whose manual overrides it carries over. Resolution carries a list's manual overrides into the `values` it writes, so a string `manualAdditions` read with a cast was spread into `*`, `.`, `b`, ... inside `values`, where the bare `*` outlived the user's fix of the field the runtime had flagged. A malformed file now stops `refresh-lists` before any model is set up, and fails that server's compile, with the same field-level error; the file is left as it is and never skipped in favour of the package copy.

### Load-Time Expansion

`PolicyEngine` constructor gains a new optional parameter:

```typescript
class PolicyEngine {
  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
    serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
    dynamicLists?: DynamicListsFile, // NEW
  ) {
    // ... existing setup ...
    this.compiledPolicy = dynamicLists ? this.expandListReferences(compiledPolicy, dynamicLists) : compiledPolicy;
  }
}
```

The `expandListReferences` method walks all rules and replaces `@list-name` entries:

```typescript
private expandListReferences(
  policy: CompiledPolicyFile,
  lists: DynamicListsFile,
): CompiledPolicyFile {
  const expandedRules = policy.rules.map(rule => {
    let expandedRule = rule;

    // Expand @list-name in domains.allowed
    if (rule.if.domains?.allowed) {
      const expandedAllowed = rule.if.domains.allowed.flatMap(entry =>
        entry.startsWith('@')
          ? this.getEffectiveListValues(entry.slice(1), lists)
          : [entry]
      );
      expandedRule = {
        ...expandedRule,
        if: {
          ...expandedRule.if,
          domains: { ...expandedRule.if.domains!, allowed: expandedAllowed },
        },
      };
    }

    // Expand @list-name in each lists[] entry
    if (rule.if.lists) {
      const expandedLists = rule.if.lists.map(listCond => {
        const expandedAllowed = listCond.allowed.flatMap(entry =>
          entry.startsWith('@')
            ? this.getEffectiveListValues(entry.slice(1), lists)
            : [entry]
        );
        return { ...listCond, allowed: expandedAllowed };
      });
      expandedRule = {
        ...expandedRule,
        if: { ...expandedRule.if, lists: expandedLists },
      };
    }

    return expandedRule;
  });

  return { ...policy, rules: expandedRules };
}
```

The `getEffectiveListValues` method computes:

```typescript
private getEffectiveListValues(
  listName: string,
  lists: DynamicListsFile,
): string[] {
  const list = lists.lists[listName];
  if (!list) {
    throw new Error(
      `Dynamic list "@${listName}" referenced in policy but not found in dynamic-lists.json. ` +
      `Run "ironcurtain compile-policy" to resolve lists.`
    );
  }

  const removals = new Set(list.manualRemovals);
  return [...new Set([...list.values, ...list.manualAdditions])]
    .filter(v => !removals.has(v));
}
```

### New Extraction Function

The existing module-level extraction functions are type-specific: `extractAnnotatedPaths()` returns raw string values for path-category roles, and `extractAnnotatedUrls()` returns `{ value, role, roleDef }` tuples with URL-specific resolution. For `ListCondition`, we need a generic extraction function that pulls raw string values from arguments whose annotated roles match the target roles. This is structurally identical to `extractAnnotatedPaths()` but without the path-specific naming:

```typescript
// policy-engine.ts (module-level, alongside extractAnnotatedPaths and extractAnnotatedUrls)

/**
 * Extracts raw string values from arguments based on annotation roles.
 * Generic version of extractAnnotatedPaths -- no type-specific normalization.
 * Used by ListCondition evaluation.
 */
function extractAnnotatedValues(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): string[] {
  // Same logic as extractAnnotatedPaths: iterate annotation.args,
  // check role intersection with targetRoles, collect string values.
}
```

Note: `extractAnnotatedPaths()` could be refactored to delegate to this function, but that is a cleanup opportunity, not a requirement for the initial implementation.

### New Condition Evaluation: `lists`

The `ruleMatches` method in `PolicyEngine` is extended to handle the `lists` condition:

```typescript
// In ruleMatches(), after domains check:
if (cond.lists !== undefined) {
  for (const listCond of cond.lists) {
    const extractedValues = extractAnnotatedValues(request.arguments, annotation, listCond.roles);

    if (extractedValues.length === 0) return false;

    const matcher = getListMatcher(listCond.matchType);
    const allMatch = extractedValues.every((v) => listCond.allowed.some((pattern) => matcher(v, pattern)));
    if (!allMatch) return false;
  }
}
```

Matcher functions by type:

```typescript
function getListMatcher(type: ListType): (value: string, pattern: string) => boolean {
  switch (type) {
    case 'domains':
      return (v, p) => domainMatchesAllowlist(v, [p]);
    case 'emails':
      return (v, p) => v.toLowerCase() === p.toLowerCase();
    case 'identifiers':
      return (v, p) => v === p;
  }
}
```

A `domains` list on a URL role is not compared by the raw-value matcher. As implemented (`PolicyEngine.listConditionMatches`), its values are matched like a `domains` condition's: each value is resolved to every destination it reaches (`resolveUrlForDomainCheck`: named git remotes, URL rewrites and push URLs, the host of a fetch URL), every destination must match an entry, and a value whose destination cannot be verified matches none. A git remote named `gitlab.com` that points at `github.com` therefore does not match a `gitlab.com` entry. The matcher above applies to values of other roles only.

### Interaction with Existing Conditions

The `lists` condition follows the same semantics as `domains`:

- Zero extracted values = condition not satisfied, rule does not match.
- All extracted values must match at least one entry in `allowed`.
- The condition is role-scoped: only arguments with matching annotated roles are checked.

**Critical: per-role evaluation integration.** The `lists` condition must be recognized by `hasRoleConditions()` and `ruleRelevantToRole()`. Without this, a rule with only a `lists` condition would be treated as role-agnostic, causing it to match during evaluation of unrelated roles — a correctness bug. The required changes:

```typescript
function hasRoleConditions(rule: CompiledRule): boolean {
  return (
    rule.if.roles !== undefined ||
    rule.if.paths !== undefined ||
    rule.if.domains !== undefined ||
    (rule.if.lists !== undefined && rule.if.lists.length > 0)
  ); // NEW
}

function ruleRelevantToRole(rule: CompiledRule, role: ArgumentRole): boolean {
  const cond = rule.if;
  if (cond.roles !== undefined && !cond.roles.includes(role)) return false;
  if (cond.paths !== undefined && !cond.paths.roles.includes(role)) return false;
  if (cond.domains !== undefined && !cond.domains.roles.includes(role)) return false;
  // NEW: rule is relevant if ANY list condition references this role
  if (cond.lists !== undefined && !cond.lists.some((lc) => lc.roles.includes(role))) return false;
  return true;
}
```

## Refresh Mechanism

### CLI Command: `ironcurtain refresh-lists`

```
ironcurtain refresh-lists [--persona <name> | --job <id>] [--list <name>] [--no-mcp]
```

- Without `--persona` / `--job`: refreshes the global policy's lists. With `--persona <name>`: the persona's policy (`personas/<name>/generated/`), resolving data-backed lists only through the servers the persona may use. With `--job <id>`: the cron job's own policy (`jobs/<id>/generated/`); a job that runs under a persona is refused with a pointer to `--persona`.
- Without `--list`: refreshes all lists. With `--list <name>`: refreshes only the named list (its name in the compiled policy, e.g. `github--trusted-hosts`).
- By default it connects the MCP servers that data-backed lists name, every call mediated by the security kernel under the read-only policy and audited (`list-resolution-audit.jsonl` next to the lists). With `--no-mcp`, data-backed lists (`requiresMcp: true`) are skipped with a warning and their existing entries are left alone. (`--with-mcp` is accepted for backward compatibility.)
- The daemon runs the same refresh for a persona or a job over its control socket (`refresh-lists` request); the web UI exposes it for jobs as `jobs.refreshLists`.

The refresh command:

1. Loads list definitions from the target's `compiled-policy.json` (the authoritative source — not duplicated in `dynamic-lists.json`).
2. Loads the target's merged `dynamic-lists.json` for the manual overrides and the lists it does not refresh, schema-validated as in "Validation on load": a malformed file (not valid JSON, or values or overrides that are not arrays of strings) stops the refresh before any model is created.
3. Re-resolves each selected list under its name in its servers' own artifacts (`sourceName` for a list the merge renamed), without feeding the overrides into the resolver. Nothing is written unless every selected list resolved.
4. Writes the refreshed values to the per-server copy (`servers/<server>/dynamic-lists.json`) of every server whose rules use the list, so the next `compile-policy` keeps them instead of reverting to its cached ones (it then regenerates and re-verifies that server's scenarios, since the list values are part of the scenario prompt).
5. Writes the merged `dynamic-lists.json` last, with each list's manual overrides kept. When the global policy is the one shipped with the package, the merged file goes to `~/.ironcurtain/generated/` (see "Loading Dynamic Lists at Runtime") and there are no per-server copies to update.
6. Does NOT re-run compilation, scenario generation, or verification.

### Caching During Refresh

Refresh always re-runs resolution (bypasses the `inputHash` cache). This is the explicit intent -- the user asked for a refresh because they want fresh data. The new resolution gets a new `inputHash` and `resolvedAt` timestamp.

## Error Handling

### Missing List at Load Time

Missing references expand to no concrete values and log a warning, including when no lists file was loaded. A reference is never left as a literal that an argument named `@list-name` could match. For allow and assess rules, missing or empty lists match no values. For escalation and deny rules, a missing, empty, unresolved, legacy or partially filtered list cannot narrow the condition: it matches present values of the condition's roles conservatively, while every other tool, server, role, path and literal-list condition still applies. This prevents a later allow from discharging an escalation whose list lost values.

### Resolution Failure and Completeness

Transport or model failures throw and leave the previous artifact untouched. An empty successful response is recorded as `resolutionState: "incomplete"`. Filtering any invalid resolver value also records incomplete state, even if valid values survive. Later validation, merging, refresh carry-over and user overlay layering retain that state. Only a fresh, nonempty resolution with no validation loss is complete; manual additions do not repair an incomplete resolution. Legacy entries without the field remain uncertain until resolved again.

The cache admits only complete nonempty resolutions. Scenario hashes cover the revalidated values actually served, manual overrides, completeness and unresolved state. Changing that state triggers verification of the served rules. The engine uses the same handling for session and task-scope policies. There is no guaranteed catch-all escalation rule: safety comes from the applicable restrictive rule itself and the engine's default denial.

### MCP Unavailable for Data-Backed Lists

If a list has `requiresMcp: true` but its `mcpServerHint` names no reachable server with tools the read-only policy allows, the resolver fails with a descriptive error. A data-backed list without an `mcpServerHint`, or one that names a network-egress server such as `fetch`, is rejected outright; there is no fallback to other servers. Data-backed lists require live data -- an LLM guess at "my contacts" would be meaningless and potentially dangerous (allowing email to fabricated addresses or missing real contacts).

A run that has no MCP access at all never guesses either: `compile-policy --no-mcp` leaves such a list UNRESOLVED (empty, never cached as resolved; see "Caching") with a warning, `refresh-lists --no-mcp` skips it and keeps its entry, and the WS compile path (`allowMcpLists: false`) fails with `MCP_LISTS_DISALLOWED`.

### Validation Failures

Values that fail type-specific validation are filtered out with a warning:

```
Warning: Dropped invalid domain value "not a domain" from @major-news-sites
```

## Constitution Examples

### Example 1: News and Finance

Constitution:

```
You are allowed to collect news from the major news sites.
You are allowed to get financial data for major tech stocks.
You are not allowed to reach out to the Internet for other purposes.
```

Compiled rules (relevant excerpt):

```json
{
  "rules": [
    {
      "name": "allow-news-sites",
      "description": "Allow fetching from major news sites",
      "principle": "collect news from the major news sites",
      "if": {
        "domains": {
          "roles": ["fetch-url"],
          "allowed": ["@major-news-sites"]
        }
      },
      "then": "allow",
      "reason": "Constitution permits collecting news from major sites"
    },
    {
      "name": "allow-financial-data",
      "description": "Allow fetching financial data for tech stocks",
      "principle": "get financial data for major tech stocks",
      "if": {
        "domains": {
          "roles": ["fetch-url"],
          "allowed": ["@financial-data-providers"]
        }
      },
      "then": "allow",
      "reason": "Constitution permits financial data access"
    },
    {
      "name": "deny-other-internet",
      "description": "Deny all other internet access",
      "principle": "not allowed to reach out to the Internet for other purposes",
      "if": {
        "roles": ["fetch-url"]
      },
      "then": "deny",
      "reason": "Constitution forbids internet access beyond permitted categories"
    }
  ],
  "listDefinitions": [
    {
      "name": "major-news-sites",
      "type": "domains",
      "principle": "collect news from the major news sites",
      "generationPrompt": "List the 30 most widely-read English-language news websites. Include major newspapers, wire services, and broadcast news sites.",
      "requiresMcp": false
    },
    {
      "name": "financial-data-providers",
      "type": "domains",
      "principle": "get financial data for major tech stocks",
      "generationPrompt": "List the major financial data provider websites commonly used for stock market data, including Yahoo Finance, Google Finance, Bloomberg, MarketWatch, and similar.",
      "requiresMcp": false
    }
  ]
}
```

Resolved `dynamic-lists.json` (excerpt):

```json
{
  "lists": {
    "major-news-sites": {
      "values": [
        "cnn.com",
        "bbc.com",
        "nytimes.com",
        "reuters.com",
        "apnews.com",
        "theguardian.com",
        "washingtonpost.com",
        "wsj.com",
        "*.bbc.com",
        "*.cnn.com"
      ],
      "manualAdditions": [],
      "manualRemovals": [],
      "resolvedAt": "2026-02-20T10:00:00.000Z",
      "inputHash": "abc123..."
    }
  }
}
```

### Example 2: Email Contacts

Constitution:

```
The agent may read all my email. It may send email to people in my
contacts without asking. For anyone else, ask me first. Never delete
anything permanently.
```

Compiled rules (relevant excerpt):

```json
{
  "rules": [
    {
      "name": "allow-send-to-contacts",
      "description": "Allow sending email to known contacts",
      "principle": "send email to people in my contacts without asking",
      "if": {
        "server": ["email"],
        "tool": ["send_email"],
        "lists": [
          {
            "roles": ["email-recipient"],
            "allowed": ["@my-contacts"],
            "matchType": "emails"
          }
        ]
      },
      "then": "allow",
      "reason": "Recipient is in the user's contacts"
    },
    {
      "name": "escalate-send-to-unknown",
      "description": "Escalate sending email to unknown recipients",
      "principle": "For anyone else, ask me first",
      "if": {
        "server": ["email"],
        "tool": ["send_email"]
      },
      "then": "escalate",
      "reason": "Recipient not in contacts; requires human approval"
    }
  ],
  "listDefinitions": [
    {
      "name": "my-contacts",
      "type": "emails",
      "principle": "send email to people in my contacts",
      "generationPrompt": "Query the contacts database and return all email addresses.",
      "requiresMcp": true,
      "mcpServerHint": "contacts"
    }
  ]
}
```

Note: this example assumes an `email-recipient` argument role has been added to the argument role registry for the email MCP server. The role registry is extensible by design -- adding `email-recipient` follows the same pattern as the existing `fetch-url` or `git-remote-url` roles.

## File Layout

```
src/pipeline/
  dynamic-list-types.ts      # NEW: ListType taxonomy and type registry
  list-resolver.ts           # NEW: LLM-driven list resolution
  types.ts                   # MODIFIED: ListDefinition, ResolvedList, DynamicListsFile
  constitution-compiler.ts   # MODIFIED: prompt + schema for list emission
  compile.ts                 # MODIFIED: list resolution sub-step

src/trusted-process/
  policy-engine.ts           # MODIFIED: load-time expansion, ListCondition eval

src/config/
  generated/
    dynamic-lists.json       # NEW artifact (written to ~/.ironcurtain/generated/)
```

## Testing Strategy

### Unit Tests

- **List type registry**: validate/reject test values for each type. Verify matcher functions for edge cases (wildcard domains, case-insensitive emails, exact identifiers).

- **Compiler list emission**: provide a constitution with categorical references, mock LLM, verify that `listDefinitions` are emitted and `@list-name` references appear in rules. Verify validation catches orphaned references and orphaned definitions.

- **List resolver**: mock LLM returning various response formats (numbered lists, bare lines, mixed with explanations). Verify post-processing produces clean value arrays. Verify type validation filters malformed values. Verify manual overrides are preserved.

- **Policy engine expansion**: construct a `CompiledPolicyFile` with `@list-name` references and a `DynamicListsFile` with resolved values. Verify expansion produces correct concrete rules. Verify missing list throws descriptive error. Verify manual additions and removals are applied correctly.

- **ListCondition evaluation**: construct rules with `lists` conditions and verify matching semantics for each type. Verify zero-extraction behavior. Verify interaction with per-role evaluation.

### Integration Tests

- **End-to-end pipeline**: run `compile-policy` with a constitution containing categorical references against a real LLM. Verify list definitions are emitted, resolved, and the expanded policy passes verification.

- **Refresh**: resolve a list, modify `dynamic-lists.json` with manual overrides, run refresh, verify overrides are preserved and values are updated.

## Extensibility

### Adding a New List Type

Adding a new list type (e.g., `file-patterns` for glob patterns) requires:

1. Add the type to the `ListType` union.
2. Add an entry to `LIST_TYPE_REGISTRY` with validate, formatGuidance.
3. Add a case to `getListMatcher()`.
4. Update the compiler prompt to mention the new type.

All validation, resolution, and evaluation flows pick up the new type automatically via the registry.

### Adding MCP-Backed Resolution

The resolver's MCP integration is optional. When available, it creates an AI SDK `generateText` call with MCP tools bridged as AI SDK tools whose calls go through the security kernel. Any annotated, non-network MCP server that the read-only policy covers can back a list -- contacts, CRM, inventory, etc. -- without resolver-specific integration code: the list names it in `mcpServerHint`, and the read-only policy (`src/config/generated-readonly/`) needs rules for it.

### Future: List Freshness Policies

The `ListDefinition` type could be extended with a `refreshPolicy` field:

```typescript
readonly refreshPolicy?: {
  readonly maxAge: number;    // seconds
  readonly autoRefresh: boolean;
};
```

The policy engine could check `resolvedAt` against `maxAge` and trigger a background refresh. This is not in scope for the initial implementation.

## Migration Notes

### Backward Compatibility

- `compiled-policy.json` without `listDefinitions` is valid and works identically to today. The field is optional.
- `PolicyEngine` without `dynamicLists` parameter works identically to today.
- Existing constitutions that reference no categories produce no list definitions.
- No changes to the `annotate-tools` pipeline step.
- No changes to the argument role registry (new roles like `email-recipient` are orthogonal and would be added via the existing extension mechanism when an email MCP server is onboarded).

### Incremental Implementation

1. **Phase 1 -- Types and compiler emission**: Add `ListDefinition` types, extend compiler prompt and schema, extend validation. No resolution yet -- lists are emitted but not resolved. The verification step would fail if lists are referenced, providing a natural checkpoint.

2. **Phase 2 -- Resolution and expansion**: Add `list-resolver.ts` and `dynamic-list-types.ts`. Wire resolution into `compile.ts`. Add load-time expansion to `PolicyEngine`. End-to-end pipeline works for knowledge-based lists.

3. **Phase 3 -- MCP-backed resolution**: Add MCP client integration to the resolver. Wire `--with-mcp` flag. Data-backed lists work.

4. **Phase 4 -- Refresh command**: Add `ironcurtain refresh-lists` CLI command. Standalone refresh without full recompilation.

## Open Considerations

### Quality of LLM-Generated Lists

The resolver LLM produces best-effort lists from its training data. "Major news sites" is subjective and the LLM's list may not match the user's expectations. Mitigation: the resolved list is written to a user-inspectable artifact, and the user can add or remove entries via `manualAdditions`/`manualRemovals`. The refresh mechanism allows periodic updates as the LLM's knowledge improves or web search becomes available.

### Security of MCP-Backed Resolution

When the resolver connects to MCP servers and gives the LLM tool-use capabilities, the LLM reads data third parties can write (an email, a contact note, a GitHub issue) and could be manipulated by instructions planted in it. The resolver therefore has no direct MCP access: `connectViaProxy` (src/pipeline/proxy-mcp-connections.ts) puts a `ToolCallCoordinator` in front of the relay subprocesses, so every call is handled like an agent session's call:

- **Read-only policy.** Calls are evaluated against the bundled read-only policy (`src/config/generated-readonly/`), never the user's main policy, with the user's tool annotations and real protected paths. There is no `allowedDirectory`, so the structural sandbox fast-path never auto-allows a write.
- **Escalation means deny.** No escalation handler is wired and auto-approval is off, so anything the policy would escalate (sending mail, sharing or deleting Drive files, pushing to GitHub, writing files) is refused.
- **Audited.** Every call, allowed or refused, is written to `list-resolution-audit.jsonl` next to the artifacts (per server output directory for `compile-policy`, the generated directory for `refresh-lists`).
- **One server per list.** A data-backed list must name its server in `mcpServerHint`; only the named servers are connected, one relay per server with `SERVER_FILTER` so the server name the policy sees is authoritative. Network-egress servers (`fetch`, which also provides `web_search`) are never connected, because a fetched URL or a search query can carry the data elsewhere.
- **Least-privilege exposure.** The LLM is told only about tools that are annotated, that the read-only policy can allow for some arguments, and that it can never allow with a URL-category argument (`src/pipeline/list-resolution-tools.ts`). A multi-mode tool whose URL-carrying modes the policy refuses is offered for its other modes: `git_remote` is offered for listing, while add/set-url, whose `url` is a `git-remote-url`, are escalated and so refused. A call to any other tool name still goes through the kernel, so it gets the policy's decision and an audit entry; with the bundled read-only policy, every tool not offered on a server that can be connected is refused.
- **Relay environment.** Each relay gets only its server's credentials and an empty throwaway `ALLOWED_DIRECTORY`, overriding any inherited value, so sandboxed backends get no writable real directory. Like a session relay, it is spawned from IronCurtain's package root rather than the caller's working directory, and every path it receives (that directory, `TOOL_ANNOTATIONS_DIR`, the resolved `IRONCURTAIN_HOME`) is absolute; its backends run in private working directories (see "Working Directories" in [execution-containment.md](execution-containment.md)).
- **OS-sandbox policy.** The user's `sandboxPolicy` applies as in a session (see [execution-containment.md](execution-containment.md)): a named server that asks for an OS sandbox the host cannot provide (the dependency check, confirmed by one srt test run) is not started under `"enforce"` (lists that name it then have no tools) and runs unconfined under `"warn"`, with the same one-line notice either way. Each relay receives the resolved policy as both `IRONCURTAIN_SANDBOX_POLICY` and `SANDBOX_POLICY`, so an inherited value cannot relax it, and the availability it was planned with as `OS_SANDBOX_AVAILABILITY`.

What remains is list poisoning: the resolver can still be steered into returning attacker-chosen values (e.g., adding `mallory@evil.example` to `@my-contacts`), which then widen what the main policy allows for rules that reference the list. Resolved lists are user-inspectable in `dynamic-lists.json` (`manualRemovals` drops entries), and `compile-policy` and `refresh-lists` print every added and removed value, but they are not yet held for confirmation before being written. A compromised list can expand the set of allowed values for the rules that use it, within the value checks above: a domain list cannot gain an IP literal, a local name, a public suffix or a wildcard over a multi-tenant hosting suffix. It cannot make the resolver mutate data, bypass deny rules, or bypass structural protections.

### List Size Limits

Very large lists (thousands of entries) could impact policy load time and memory. For the initial implementation, no explicit size limit is enforced -- the existing domain allowlist mechanism handles lists of reasonable size efficiently. If this becomes a problem, a Bloom filter or sorted-array binary search could replace the linear scan in `domainMatchesAllowlist()`.
