# ArgumentRole Registry Design

**Status (2026-11-14):** Implemented: the role registry in `src/types/argument-roles.ts`, which has grown well beyond the path roles described here (URL, identifier, history, egress-host and outbound-content roles).

## Problem

Argument role definitions (`'read-path' | 'write-path' | 'delete-path' | 'none'`) are scattered as hardcoded string literals across six files. Path normalization in `path-utils.ts` uses fragile heuristics (checking if strings start with `/`, `.`, or `~`) instead of leveraging the tool annotations that already classify every argument. This creates two problems:

1. **Fragile normalization**: A `content` argument containing `/etc/passwd` gets normalized as if it were a path. A string like `./disclaimer text` is incorrectly treated as a path.
2. **Scattered role knowledge**: Adding a new role requires finding and updating every hardcoded reference across the codebase.

## Solution

A central **ArgumentRole registry** that pairs each role with its semantic metadata and normalizer function. Normalization becomes annotation-driven: for each tool call argument, the registry looks up the argument's annotated roles and applies the corresponding normalizer. The heuristic is retained only as defense-in-depth inside the policy engine.

## Registry Interface

### `src/types/argument-roles.ts`

```typescript
export type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly category: RoleCategory;
  readonly canonicalize: (value: string) => string;
}

export const ARGUMENT_ROLE_REGISTRY: ReadonlyMap<ArgumentRole, RoleDefinition>;
```

Each role definition provides:

- **`description`** -- Human-readable explanation of the role's security semantics.
- **`isResourceIdentifier`** -- True if the role tags an argument that names an external resource (filesystem path, URL, etc.). False for `'none'`. Replaces all `role !== 'none'` checks in the codebase.
- **`canonicalize`** -- Canonicalizes a string argument value for transport to the MCP server. For path roles: tilde expansion + symlink-aware `resolveRealPath()` (follows symlinks via `realpathSync`, the native variant on macOS, with a deepest-existing-ancestor fallback for non-existent paths). For `'none'`: identity function. Must be pure. Only path roles may throw, and only `PathResolutionError` (code `PATH_UNRESOLVABLE`) when no ancestor of the path can be canonicalized; the tool-call pipeline turns that into an audited `structural-unresolvable-path` deny.

Domain extraction and other policy-oriented value transformations are handled externally by helper functions in `domain-utils.ts`, rather than through additional methods on `RoleDefinition`.

### Convenience accessors

```typescript
/** Returns the RoleDefinition for a role. Throws if not registered. */
export function getRoleDefinition(role: ArgumentRole): RoleDefinition;

/** Returns all roles where isResourceIdentifier is true. */
export function getResourceRoles(): ArgumentRole[];

/** Type guard: returns true if the value is a valid ArgumentRole string. */
export function isArgumentRole(value: string): value is ArgumentRole;

/** All role values as a tuple for z.enum() compatibility. */
export function getArgumentRoleValues(): [ArgumentRole, ...ArgumentRole[]];
```

### Compile-time completeness check

A type-level assertion ensures every member of the `ArgumentRole` union has a registry entry. Forgetting to add a registry entry for a new role produces a compile error.

## Role Definitions

| Role          | isResourceIdentifier | canonicalize                       | Description                                       |
| ------------- | -------------------- | ---------------------------------- | ------------------------------------------------- |
| `read-path`   | true                 | tilde expand + `resolveRealPath()` | Filesystem path that will be read                 |
| `write-path`  | true                 | tilde expand + `resolveRealPath()` | Filesystem path that will be written to           |
| `delete-path` | true                 | tilde expand + `resolveRealPath()` | Filesystem path that will be deleted              |
| `none`        | false                | identity (no-op)                   | Argument carries no resource-identifier semantics |

The registry has grown since (URL, identifier and opaque roles; see `src/types/argument-roles.ts`). A role may also set `outboundContent` (`'text'` or `'url'`): its values leave the machine as content other people or systems read, and the opt-in outbound content assessment checks them for encoded or hidden data. `outbound-text` (github, google-workspace: comment, issue and PR text, message subjects; never an argument that holds an object, see below), `email-body`, `commit-message` (git, github) and `fetch-url` set it; see [outbound-content-assessment.md](outbound-content-assessment.md). `isResourceIdentifier` is independent of the category: `github-resource-id` (github only) is an opaque role that is still a resource identifier. It tags arguments that name a GitHub resource by a global ID rather than by owner/repo, such as `pull_request_review_write.threadId` for `resolve_thread`/`unresolve_thread` and `sub_issue_write.sub_issue_id`. The engine evaluates it like any other resource role, so owner/repo-scoped rules (whose role conditions do not name it) never discharge it and the shipped github write rule escalates it, while the approval whitelist, which can generalize only paths, URLs and identifiers, offers no pattern for it.

For path roles, `canonicalize` uses `resolveRealPath()` which follows symlinks to produce the canonical real path. This neutralizes both path traversal attacks (via `resolve`) and symlink-escape attacks (via `realpathSync`). It works in three steps: (1) the whole path is canonicalized when it resolves; on macOS this uses `realpathSync.native`, which also returns the on-disk letter case and Unicode form of every component, so the policy engine and the MCP server see the same spelling; (2) otherwise the deepest ancestor that resolves is canonicalized and the remaining components are re-attached verbatim, however many there are (a binary search over the ancestors keeps this at O(log depth) realpath calls); (3) if not even the filesystem root resolves, it throws `PathResolutionError` rather than returning the unresolved spelling.

Policy-oriented transformations (e.g., domain extraction from URLs) are handled by helper functions in `domain-utils.ts` rather than through `RoleDefinition` methods.

## Annotation-Driven Normalization

### New function: `prepareToolArgs(args, annotation)`

Located in `src/trusted-process/path-utils.ts`. Returns two argument objects: one for transport (MCP server) and one for policy evaluation.

For each argument in `args`:

1. Look up `annotation.args[argName]` to get the role array
2. Find the first role where `getRoleDefinition(role).isResourceIdentifier === true`
3. If found: apply `canonicalize` to produce the canonical value for both transport and policy
4. If not found (roles are all `'none'`): pass through unchanged to both outputs
5. If `annotation` is `undefined` (unknown tool): fall back to the heuristic `normalizeToolArgPaths()` for both outputs

An argument that is not in the annotation at all never reaches `prepareToolArgs`: `handleCallTool` denies the call first (rule `unannotated-arguments`), because policy, the approval whitelist and the auto-approver only see annotated arguments. The check uses the stored annotation's keys, not the server's live schema, which is where server releases add or rename arguments.

The input object is never mutated; new objects are returned.

```typescript
interface PreparedToolArgs {
  /** Canonical args sent to the real MCP server. */
  argsForTransport: Record<string, unknown>;
  /** Args presented to the policy engine (resource-role values identical to argsForTransport). */
  argsForPolicy: Record<string, unknown>;
}

function prepareToolArgs(args: Record<string, unknown>, annotation: ToolAnnotation | undefined): PreparedToolArgs;
```

For path roles both outputs carry the same absolute canonical path. With `allowedDirectory` set, a relative path (anything but `/...`, `~` or `~/...`) is resolved against `allowedDirectory` before canonicalization, for transport as well as policy: left relative, the MCP server would resolve it against its own working directory (for git a per-server temp directory under srt, otherwise the IronCurtain launch directory), not against the sandbox that policy checked. For the git server, a `path` of `'.'` (its sentinel for the session working directory) is replaced by the tracked working directory before this step, like an omitted path.

A role describes a top-level argument as a whole, and `canonicalize` applies to a string or to each string of an array. Any other value of a role-bearing argument (an object, an array holding an object or another array, a boolean) passes through unchanged, so policy cannot claim it evaluated what the server receives. The policy engine reads such a value through `argumentValues()` (`src/trusted-process/argument-values.ts`): every string and number inside it is a value of the argument's roles for the protected-path, forbidden-destination and compiled checks, and the call escalates to a human (`structural-nested-argument-escalate`, human-only) unless one of them denies it. A number is read in decimal form (a numeric ID such as `sub_issue_write.sub_issue_id`), and an absent value (`undefined`, `null`) yields nothing. `annotate-tools` warns about every role it assigns to a schema property that can hold an object or a nested array (`findStructuredRoleArguments()` in `src/pipeline/tool-annotator.ts`); in the shipped annotations those are the `editors` argument of the two gsheets protected-range tools. Sub-path (JSON-pointer-style) roles that could address the values inside such an argument individually do not exist yet.

### Normalization flow

```
Tool Call arrives (raw args from sandbox/agent)
     |
     v
mcp-proxy-server.ts / TrustedProcess.handleToolCall()
     |
     +-- looks up ToolAnnotation via PolicyEngine.getAnnotation()
     |
     +-- calls prepareToolArgs(rawArgs, annotation)
     |       |
     |       +-- for each arg: looks up roles from annotation
     |       +-- for first resource-identifier role:
     |       |     canonicalize(value)         → argsForTransport[key]
     |       |     (argsForPolicy identical; relative paths resolved against allowedDirectory for both)
     |       |
     |       +-- returns { argsForTransport, argsForPolicy }
     |
     +---+---+
     |       |
     v       v
  callTool(argsForTransport)    PolicyEngine.evaluate(argsForPolicy)
     |                               |
     |                          Structural checks
     |                               +-- extractAnnotatedPaths()
     |                               +-- uses getPathRoles() / getUrlRoles()
     |                          Compiled rule evaluation
     |                               +-- collectDistinctRoles() uses isResourceIdentifier
     |                               +-- per-role evaluation, most-restrictive-wins
     v                               v
  MCP result                    EvaluationResult
```

### Behavioral change

Arguments with role `'none'` that happen to look like paths (e.g., a `content` field containing `/etc/passwd`) will **no longer be normalized**. This is correct behavior -- normalizing non-path arguments was a side effect of the heuristic approach. The defense-in-depth heuristic in the policy engine's structural invariant phase still catches path-like strings regardless of annotation.

## PolicyEngine.getAnnotation()

Public method on `PolicyEngine`:

```typescript
getAnnotation(serverName: string, toolName: string, callArgs: Record<string, unknown>): ToolAnnotation | undefined
```

Resolves conditional role specs against the tool call arguments and returns a plain `ToolAnnotation`. The annotation map internally stores `StoredToolAnnotation` (which may contain conditional role specs for multi-mode tools); resolution via `resolveStoredAnnotation()` happens here at the lookup boundary. A separate `getStoredAnnotation(serverName, toolName)` provides raw access for pipeline tools. Used by `mcp-proxy-server.ts` and `TrustedProcess`.

## Hardcoded String Replacement

All hardcoded role references across the codebase are replaced with registry-derived values:

| Current pattern                                              | Replacement                                    |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `['read-path', 'write-path', 'delete-path']`                 | `getResourceRoles()`                           |
| `role !== 'none'`                                            | `getRoleDefinition(role).isResourceIdentifier` |
| `z.enum(['read-path', 'write-path', 'delete-path', 'none'])` | `z.enum(getArgumentRoleValues())`              |
| `VALID_ROLES.includes(role)`                                 | `isArgumentRole(role)`                         |

## Files Affected

### New files

| File                          | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `src/types/argument-roles.ts` | Registry, type, normalizers, accessors  |
| `test/argument-roles.test.ts` | Unit tests for registry and normalizers |

### Modified files

| File                                      | Change                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `src/pipeline/types.ts`                   | Re-export `ArgumentRole` from canonical location                       |
| `src/trusted-process/path-utils.ts`       | Add `prepareToolArgs()`, deprecate heuristic                           |
| `src/trusted-process/policy-engine.ts`    | Use `getResourceRoles()`, `getRoleDefinition()`, add `getAnnotation()` |
| `src/trusted-process/mcp-proxy-server.ts` | Use annotation-driven normalization                                    |
| `src/trusted-process/index.ts`            | Use annotation-driven normalization                                    |
| `src/pipeline/tool-annotator.ts`          | Use `getArgumentRoleValues()` for Zod schema                           |
| `src/pipeline/constitution-compiler.ts`   | Use `getArgumentRoleValues()`, `isArgumentRole()`                      |
| `test/path-utils.test.ts`                 | Add tests for annotation-driven normalization                          |

### Unchanged files

- Generated JSON artifacts (`tool-annotations.json`, `compiled-policy.json`) -- roles stay as plain strings, no format change
- `src/pipeline/scenario-generator.ts`, `handwritten-scenarios.ts`, `policy-verifier.ts`, `compile.ts` -- no direct role manipulation

## Extensibility

### Adding a new role

Adding a new role (e.g., `'url'`) requires exactly two changes in one file (`src/types/argument-roles.ts`):

1. Add `'url'` to the `ArgumentRole` union
2. Add an entry to `ARGUMENT_ROLE_REGISTRY` with its canonicalize function
3. Add to `_ROLE_COMPLETENESS_CHECK` (compile error if forgotten)

All Zod schemas, validation logic, and normalization flows pick up the new role automatically via registry accessors.

### Policy-oriented transformations

When the policy engine needs a different view of a value than the MCP server (e.g., domain extraction from URLs), this is handled by standalone helper functions in `domain-utils.ts` rather than through `RoleDefinition` methods. The policy engine calls these functions directly, dispatching by role identity (see `extractDomainForRole` and `resolveUrlForDomainCheck`, the single resolver from a URL-role value to the domains it reaches).

### Future: `sanitizeForLLM` on RoleDefinition

A future `sanitizeForLLM` method on `RoleDefinition` could enable roles where the value presented to LLM-based components (auto-approver, annotation prompt) differs from both the transport and policy views. Potential use cases:

- **Content sanitization**: A `content` role with `sanitizeForLLM = stripInjectionPatterns` (LLM sees a sanitized version to resist prompt injection from rogue agents).
- **Credential redaction**: A `secret` role with `sanitizeForLLM = redact` (LLM never sees the actual secret, only a placeholder).

## Migration Plan

Four incremental steps, each independently testable:

1. **Registry module + re-export** -- Create `src/types/argument-roles.ts`, update `src/pipeline/types.ts` to re-export. Zero behavioral change.
2. **Pipeline hardcoded strings** -- Update `tool-annotator.ts` and `constitution-compiler.ts` to use registry accessors. Zero behavioral change.
3. **Policy engine hardcoded strings** -- Update `policy-engine.ts` to use `getResourceRoles()` and `getRoleDefinition()`. Add `getAnnotation()` method. Zero behavioral change.
4. **Annotation-driven normalization** -- Add `prepareToolArgs()` returning `{ argsForTransport, argsForPolicy }`. Update proxy and TrustedProcess to route `argsForTransport` to `callTool()` and `argsForPolicy` to `PolicyEngine.evaluate()`. Only step with a behavioral change (correct: `'none'`-role args stop being normalized).
