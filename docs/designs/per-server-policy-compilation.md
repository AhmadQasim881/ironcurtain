# Per-Server Policy Compilation

**Status (2026-11-14):** Implemented (`src/pipeline/pipeline-runner.ts`): each server is compiled, verified and cached on its own, and a server that fails verification is reported and never cached. Any constitution edit still invalidates every server's cache.

## Motivation

The current policy compilation pipeline compiles a single `constitution.md` into one `compiled-policy.json` containing rules for all MCP servers in a single LLM call. This creates several scaling problems:

1. **LLM context window pressure.** As servers are added, the tool annotations summary grows. With 4 servers and 85 tools, the system prompt is already substantial. Adding servers with tens or hundreds of tools will push against context limits and degrade output quality.

2. **No incremental recompilation.** Changing one server's tools (e.g., adding a tool to the fetch server) invalidates the entire `inputHash` and forces recompilation of rules for all servers. This wastes LLM calls and time.

3. **Monolithic repair loops.** When verification fails, the repair loop operates on the full rule set. The LLM must reason about all 23+ rules across all servers simultaneously, increasing the chance of regressions in unrelated servers' rules during repair.

4. **Scenario quality.** The scenario generator must cover all servers in one pass. With many servers, coverage becomes thin per server.

The tool annotator (`annotate.ts`) already solves the analogous problem: it processes each server independently with per-server content-hash caching. This design extends the same pattern to policy compilation.

### Behavioral Change: From Cross-Cutting Rules to Server-Scoped Rules

This is a **deliberate behavioral change**, not a transparent refactoring. The current monolithic compiler produces cross-cutting rules — for example, a single rule `escalate-write-history-outside-sandbox` with `"roles": ["write-history"]` that matches any server's tool with that role. Under per-server compilation, each server independently produces its own server-scoped version of such rules.

**Example — current monolithic output:**

```json
{
  "name": "escalate-write-history-outside-sandbox",
  "if": { "roles": ["write-history"] },
  "then": "escalate"
}
```

**Equivalent per-server output (one rule per server that has write-history tools):**

```json
// From git server compilation:
{
  "name": "escalate-git-write-history",
  "if": { "server": ["git"], "roles": ["write-history"] },
  "then": "escalate"
}
// From github server compilation:
{
  "name": "escalate-github-write-history",
  "if": { "server": ["github"], "roles": ["write-history"] },
  "then": "escalate"
}
```

Each server's compiler independently applies the same constitutional principle to its own tools. The per-server rules are more explicit (always server-scoped) but may use different condition patterns for the same principle — e.g., the filesystem compiler might use `roles`-based conditions while the GitHub compiler uses `tool`-based conditions. This is acceptable: what matters is that each server's rules correctly implement the constitution for that server's tools.

### Incremental Recompilation: Scope and Limitations

The primary incremental benefit comes from **tool annotation changes**: when one server's tools change, only that server recompiles. However, the constitution text is included in every server's cache key, so **constitution changes invalidate all server caches**. Since the constitution is not structured per-server (it uses cross-cutting principles), there is no clean way to scope constitution changes to individual servers. This is an acceptable tradeoff — constitution changes are infrequent compared to tool changes, and the per-server compilation is still faster than monolithic because each LLM call processes fewer tools.

## High-Level Approach

Split the pipeline into three phases:

```
Phase 1: Per-server compilation (parallelizable)
  For each server S with tools:
    - Build system prompt with constitution + S's annotations only
    - Compile rules (LLM call, cached per server)
    - Generate scenarios for S (LLM call, cached)
    - Verify S's rules against S's scenarios (compile-verify-repair loop)
    - Write per-server artifacts to generated/servers/{S}/

Phase 2: Merge
  - Concatenate all per-server rule sets into one ordered list
  - Merge list definitions from all servers (a name that servers define
    differently is kept apart per server, see "Dynamic Lists Across Servers")
  - Validate the merged rules against the merged list definitions
  - Write final compiled-policy.json (same format as today)

Phase 3: Merged dynamic lists
  - Take each merged list's values from the per-server resolution
    (servers/{S}/dynamic-lists.json)
  - Carry the user's manual overrides over from the previous merged
    dynamic-lists.json
```

The PolicyEngine consumes the merged `compiled-policy.json` unchanged. No runtime changes needed.

## Detailed Design

### Per-Server Compilation Unit

Each server's compilation is a self-contained unit with its own compile-verify-repair cycle. Introduce a type to represent the inputs and outputs of a single server's compilation:

```typescript
/**
 * Inputs for compiling a single server's policy rules.
 */
interface ServerCompilationUnit {
  /** The server name (e.g., "filesystem", "git", "github"). */
  readonly serverName: string;

  /** Tool annotations for this server only. */
  readonly annotations: ToolAnnotation[];

  /** Full constitution text (shared across all servers). */
  readonly constitutionText: string;

  /** Sandbox boundary for structural invariant checks. */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /** MCP server config for this server (for domain allowlist extraction). */
  readonly mcpServerConfig?: MCPServerConfig;

  /**
   * Handwritten scenarios scoped to this server.
   * Currently only filesystem has handwritten scenarios; other servers get [].
   */
  readonly handwrittenScenarios: TestScenario[];
}

/**
 * Output from a single server's compilation cycle.
 * Stored as a per-server artifact for caching.
 */
interface ServerCompilationResult {
  readonly serverName: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions: ListDefinition[];
  readonly scenarios: TestScenario[];
  readonly inputHash: string;
  readonly constitutionHash: string;
  readonly generatedAt: string;
}
```

### Per-Server Artifact Layout

Per-server artifacts are stored in subdirectories under the generated directory:

```
~/.ironcurtain/generated/
  servers/
    filesystem/
      compiled-policy.json             # VERIFIED per-server rules (verified: true); cache-eligible
      test-scenarios.json              # Scenarios those rules were verified against; cache-eligible
      compiled-policy.unverified.json  # Inspection copy: early, in-repair and failed rules (verified: false)
      test-scenarios.unverified.json   # Inspection copy: scenarios of a failed verification
      dynamic-lists.json               # Per-server resolved lists (their own per-list cache): resolver output only; ignored when the rules define no lists
    git/
      ...
  compiled-policy.json        # Merged final artifact, with its provenance block
  tool-annotations.json       # Unchanged (already per-server internally)
  dynamic-lists.json          # Merged lists: per-server values + the user's manual overrides (the file users edit)
  test-scenarios.json         # Merged scenarios from all servers, with the decisions recorded at verification
```

The per-server `compiled-policy.json` uses a `ServerCompiledPolicyFile` type, a subset of `CompiledPolicyFile` plus the verification marker (see "Verification-Gated Cache and Failed Servers" below):

```typescript
/**
 * Per-server compiled policy artifact.
 * Cache-eligible copy: generated/servers/{serverName}/compiled-policy.json,
 * written only after verification passed. Unverified copies go to
 * compiled-policy.unverified.json.
 */
interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  readonly inputHash: string; // compiler inputs, including the compiler epoch
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
  readonly verified: boolean; // true only in the cache-eligible file
  readonly verifiedAt?: string;
  // Verified commits only (see "Split Cache Key" below):
  readonly rulesHash?: string; // canonical digest of rules + listDefinitions as written
  readonly scenarioHash?: string; // scenario inputs of the FINAL rules and their resolved lists
  readonly engineSemanticsVersion?: number;
  readonly verifierVersion?: number;
  readonly policyModelId?: string; // compiled the rules (and verified them, unless verifierModelId is set)
  readonly verifierModelId?: string; // separate verifier model (policyVerifierModelId) that generated the scenarios and judged
}
```

The merged `compiled-policy.json` keeps the `CompiledPolicyFile` rule format; it gains an informational `provenance` block (see "Policy Provenance" below) that the PolicyEngine does not read. The merged `test-scenarios.json` gains `replay: { allowedDirectory, decisions }`, the decision the engine gave each scenario when the rules passed verification, index-aligned with `scenarios`.

### Per-Server Content-Hash Caching

Each server's `inputHash` is computed from:

```typescript
function computeServerPolicyHash(
  serverName: string,
  constitutionText: string,
  annotations: ToolAnnotation[],
  compilerPromptTemplate: string, // the prompt template text (not filled)
  compilerEpoch: number = POLICY_COMPILER_EPOCH,
): string {
  return computeHash(
    `policy-compiler-epoch:${compilerEpoch}\n`,
    serverName,
    constitutionText,
    JSON.stringify(annotations),
    compilerPromptTemplate,
  );
}
```

This means a server's cached rules are invalidated when:

- The constitution changes (affects all servers)
- The server's tool annotations change (affects only that server)
- The compiler prompt template changes (affects all servers, but rare)
- `POLICY_COMPILER_EPOCH` is bumped (affects all servers; see "Policy Provenance")

The policy model and the verifier version are deliberately not part of this hash: a model or provider-routing change would otherwise trigger a silent, costly recompile of every server. They are recorded per commit instead (see below).

When only the `git` server's annotations change, only `git` is recompiled. The other three servers hit cache and skip LLM calls entirely.

### Verification-Gated Cache and Failed Servers

The per-server cache must never become a way around verification. The rules for it live in `src/pipeline/server-artifacts.ts`:

- **Only verified rules are cache-eligible.** `servers/{S}/compiled-policy.json` is written only after S's rules pass verification, with `verified: true` (and `verifiedAt`) in the same atomic write as the rules. The scenarios they were verified against are written to `servers/{S}/test-scenarios.json` first, so the policy file is the commit point. A cache hit requires `verified === true`, a matching `inputHash`, `serverName` and `rulesHash`, rules and list definitions that pass the runtime compiled-policy schema (`assertServerPolicyRules` in `src/types/policy-schema.ts`: a hand-edited decision such as `"Allow"`, or a misspelled condition key, would otherwise be merged into a `compiled-policy.json` that sessions refuse to load, and every unchanged recompile would write it again), rules that are still scoped to S, a matching scenario hash and the current engine semantics version (see "Split Cache Key": a scenario-hash or engine-version mismatch re-verifies the rules instead of recompiling them). A cached file that fails the schema or scoping check is reported as "cached rules rejected" and recompiled. The per-server `dynamic-lists.json` is read through the runtime lists schema (`loadDynamicListsArtifact`) only when the cached rules define lists; a malformed one fails the server with the field-level error. Files written by older versions have no marker or no `rulesHash` and count as unverified, which costs one recompile after upgrading.
- **Intermediate and failed rules are inspection copies.** The rules persisted right after compilation, after every repair (always the repaired rules, passed explicitly), and when verification still fails after every repair go to `compiled-policy.unverified.json` with `verified: false`; the failing scenarios go to `test-scenarios.unverified.json`. The pipeline never reads these back.
- **A recompile invalidates first.** On a cache miss, the cache-eligible pair and old inspection copies are removed before anything new is written (the verified scenarios stay in memory for the scenario-generation cache). An abort, LLM or network error, or crash mid-compile therefore leaves nothing a later run would serve, including the case where only compiler-side inputs such as `protectedPaths` changed and an older scenarios file would still match.
- **What passing verification means.** A server passes only when the judge's structured `pass` verdict in the final round is true and no executed scenario failed, probes from the judge's final round included (they are run after the round limit). Judge corrections to scenario expectations are keyed by result index, never loosen an expectation to `allow`, and count only after every scenario is replayed against the current rules; a judge rejection with nothing failing is repaired from the judge's analysis and, if it persists, recorded as the failure reason. Right before the commit, every scenario persisted with the rules is replayed once more against them (see `docs/designs/scenario-generation-batching.md`, "Correction safeguards").
- **The oracle is kept apart from the rules it checks.** The scenario generator sees the directories the rules name and their resolved list values only as concrete paths and values, labelled as coming from the policy under test, never as permitted directories or as `allow` cases; every expectation comes from the constitution. The universal handwritten invariants (`src/pipeline/handwritten-scenarios.ts`) are ground truth in every compile kind, persona and job compiles included. With `policyVerifierModelId` set to another model, that model generates the scenarios and judges, and the policy model only compiles, repairs and resolves lists; the commit records it as `verifierModelId`. See `docs/designs/policy-compilation-pipeline.md`, section 4.

A server whose compilation fails (LLM or network error, invalid rules, verification still failing after every repair) is left out of the merged policy, so its tools are default-denied. The failure is recorded as `failedServers: [{ serverName, phase, reason }]` in the merged `compiled-policy.json` (informational; the engine does not read it), listed in the run summary instead of the success banner, and carried on the persona web compile result. `compile-policy` exits with status 2 on such a partial failure. When every server fails, the run throws `AllServersFailedError` (`code: 'ALL_SERVERS_FAILED'`) and writes no merged artifacts, so the previous policy stays active. An aborted run surfaces the abort itself, never a per-server failure.

`compile-policy --server <name>` (a `serverFilter` run) writes only `servers/<name>/`; the merged artifacts are left untouched, because a merged policy holding one server's rules would drop every other server from the active policy. Passing `--output-dir` or `--write-merged` (`writeMergedArtifacts: true`) writes them anyway; the CLI then warns up front that they will hold only that server's rules. An empty `--server` value is rejected as a usage error. A later full run picks up the server's verified commit from cache.

### Split Cache Key

A verified commit whose `inputHash` matches is not served blindly. Its key has three parts:

- `inputHash`: the compiler's inputs (above). A mismatch recompiles.
- `rulesHash`: written by `commitVerifiedServerArtifacts`, a canonical digest of exactly the rules and list definitions that passed. `loadVerifiedServerArtifacts` treats a commit whose rules no longer match it (edited after verification, or written before the hash existed) as unverified, so it is recompiled.
- `scenarioHash`: the scenario-generation inputs (generator prompt, handwritten scenarios, and the full content of the resolved lists: values and manual overrides) computed from the FINAL rules, after any repair, and their resolved lists. The cache check recomputes it from the cached rules and the per-server `dynamic-lists.json` entries their list definitions name. That file is read through the runtime lists schema, so a malformed one fails the server instead of being merged; a lists file left by an earlier compile is ignored, and not read, when the rules define no lists. Storing the hash of the final rules means a repair that changed `paths.within` directories or lists no longer makes the next unchanged run miss the cache.

What happens with a commit whose `inputHash` and `rulesHash` match:

- **Hit** (no LLM call): the recomputed scenario hash matches and the commit was verified under the current `ENGINE_SEMANTICS_VERSION`. A commit verified by another `PIPELINE_VERIFIER_VERSION`, compiled by another policy model than the configured `policyModelId`, or (when a separate verifier model is configured now or was then) judged by another model than the configured verifier, is still served, with a warning naming how to rebuild it without the cache: `compile-policy --force` (the caller's `PipelineRunConfig.cacheBypassHint`), or, for persona and cron-job compiles, which have no `--force`, removing the server's `servers/<name>/` directory.
- **Re-verify**: the scenario hash differs (scenario prompt, handwritten scenarios or list values changed), a resolved list is missing, a data-backed list was left UNRESOLVED by a run without MCP access (`compile-policy --no-mcp`) and this run has MCP access, or the engine semantics version differs. The commit's rules are kept: lists are resolved (per-list cache), scenarios are regenerated only when their hash changed, and the rules go through verification and, if needed, the repair loop (point-fix repairs start from the cached rules). The commit stays in place until the verdict; a pass replaces it, a failure removes it and keeps inspection copies, so rules that now fail are never served again.
- **Recompile**: the rules or list definitions fail the runtime compiled-policy schema, or the rules are no longer scoped to the server (reported as "cached rules rejected").

A repair that removes every list definition also drops the resolved lists from the compilation state, so neither the judge, the replays, the recorded decisions nor the final scenario hash see lists the rules no longer reference. The recorded decisions come from the engine verification and the replays use (`createVerifierEngine`).

`PipelineRunConfig.force` (`compile-policy --force`) ignores every verified commit and its scenarios: each server is recompiled, its scenarios regenerated and its rules re-verified. It also ignores the cached pre-filter decisions (`servers/<name>/prefilter-decision.json`, see [haiku-server-prefilter.md](haiku-server-prefilter.md)), so every server is judged again. Resolved lists keep their per-list cache (`refresh-lists` re-resolves them).

### Policy Provenance

The merged policy is stamped with a `provenance` block (`src/policy-artifacts/provenance.ts`, a runtime leaf):

```json
"provenance": {
  "schemaVersion": 1,
  "producerVersion": "<IronCurtain version>",
  "policyCompilerEpoch": 1,
  "engineSemanticsVersion": 1,
  "verifierVersion": 2,
  "policyModelId": "<policy model, when known and the same for every server>",
  "annotationDigests": { "<server>": "<sha256 of the canonical JSON of its tools>" }
}
```

The versions are constants bumped by hand: `POLICY_COMPILER_EPOCH` when compilation changes enough that older policies are worth rebuilding, `ENGINE_SEMANTICS_VERSION` when the PolicyEngine may decide differently for an existing rule set, `PIPELINE_VERIFIER_VERSION` when verification or repair logic changes. `verifierVersion` is the oldest one among the servers (a commit served from cache may predate the current verifier). `annotationDigests` covers every server the rules reference and uses the annotation content digest, not `inputHash` (which stays the same when roles are edited by hand).

Loaders compare it with the running IronCurtain (`src/config/policy-provenance-check.ts`): `buildSessionConfig` for every session (CLI, daemon, cron, PTY, workflow states) before anything is created for the session, and `loadPersonaPolicyArtifacts` when the coordinator hot-swaps a workflow persona's policy. A policy without provenance, from another compiler epoch or engine semantics, or compiled against other annotations than those in effect is stale: it is reported and used (`policy.onStale: "warn"`, the default), or refused (`"refuse"`, `StalePolicyError` with code `POLICY_PROVENANCE_STALE`; session start turns it into a `SessionError`). Rules without a `server` condition (the pre-0.9 format) are reported separately. Each warning goes to the session log, and the session emits it as a `policy_stale` start-up notice (`src/session/startup-notices.ts`): the CLI prints it after its initialization spinner, the web UI shows it in the session view, a Signal session sends it once after announcing itself, a cron run keeps it in its run record (`RunRecord.notices`) and a workflow prints it on stderr. A caller that passes no `onDiagnostic` (the PTY session, which prints it before its spinner starts) gets it on stderr from `buildSessionConfig`; a hot-swapped persona policy's warning goes to the session log. The check runs only after the artifacts passed their runtime schemas (`src/types/policy-schema.ts`), which leave the block itself to the check: a malformed block makes the policy stale, not unloadable. A persona or job policy is read from its own directory only (never the package fallback) and compared with the global tool annotations in effect, the same ones the coordinator retains for a hot-swap. This is independent of the persona and job constitution check (`ScopedPolicyError`, code `POLICY_STALE`, see [persona-system.md](persona-system.md)): `--allow-stale-policy` overrides only that one, never a provenance refusal. `ironcurtain doctor` reports the policy's source, the same assessment, an offline replay of the stored scenarios against their recorded decisions, and the universal handwritten invariants.

The policies shipped in `src/config/generated/` and `src/config/generated-readonly/` carry the block too (the example policy in `src/config/generated-coding/` is not loaded by IronCurtain and is not stamped); `scripts/stamp-policy-provenance.ts` re-stamps them after a reviewed hand edit of the shipped annotations, and `test/policy-provenance.test.ts` fails when they no longer record the shipped annotations.

### Deterministic Rule Checks (Policy Lint)

Schema validation and the LLM judge do not stop a rule that is simply too broad. Every compile mode (global, persona, cron) therefore runs two deterministic checks on compiled rules: `validateCompiledRules` (role names, `@list` references, `paths.within` syntax) and the policy lint, `lintCompiledRules` in `src/pipeline/policy-lint.ts`. The lint reads the stored tool annotations (every mode of a conditional annotation) and reports these errors. An `assess` rule is linted as the allow it is (`ruleOutcomeAllows` in `src/types/policy-schema.ts`): the merged policy is linted after the pipeline turned outbound-channel allows into `assess` rules.

- **Server-wide allow:** an allow with no `tool` and no role, path, domain or list constraint. A roles filter counts only when every role in it is a resource role: one that names `none` or another non-resource role matches every tool with such an argument (every Google Workspace tool, whatever resource roles the filter also names), so it counts as none.
- **Condition on the wrong kind of role:** an allow with `paths` on a non-path role, `domains` (or a `domains`-matched list) on a non-URL role, or a list on a path role. The engine applies a condition to whatever role it names, and such a condition matches far more than it appears to: a path has an empty hostname, which `""` and `*` match, and an owner name is resolved as a path under the working directory. It limits nothing, so it is an error (the broad-domain opt-in does not accept it).
- **Unconstrained mutation:** an allow that discharges `write-path`, `delete-path`, `write-history` or `delete-history` without `paths.within`. A role-agnostic allow on a multi-mode tool is one, and so is an allow whose only condition on the role is a domain or list.
- **Side-effect tool:** a tool whose MCP hints (`mcpHints`, captured by `annotate-tools` from the server's `readOnlyHint`/`destructiveHint`) say it changes state is allowed for an input outside every value constraint, following the engine's first-match, per-role evaluation. Hints only add this finding; a missing or read-only hint exempts nothing.
- **Broad path:** a write/delete/history allow whose `paths.within` is a home directory or broader (`~`, `/home`, `/Users`, `/`, any user's home) or contains a protected path. The cwd-derived default `./audit.jsonl` does not count. Read breadth is not linted: an unconstrained read allow is how a constitution says "read anywhere".
- **Broad domain:** `*`, or a wildcard that `isBroadDomainPattern` (`src/types/public-suffix.ts`) classifies as broad: over a public suffix of either PSL section (`*.com`, `*.co.uk`, `*.github.io`), at or under a curated multi-tenant cloud domain (`*.amazonaws.com`), directly above a PSL wildcard rule (`*.kawasaki.jp`, `*.gateway.dev`), or over anything that is not a registrable public name; including values reached through a `@list`. Also a URL role allowed with no `domains` condition. Escalate rules may use `*`. An explicit opt-in accepts these: `compile-policy --allow-broad-domains`, a constitution line holding only `<!-- ironcurtain: allow-broad-domains -->` (global constitution only), or the persona's gated `allowBroadPolicy` flag. Cron task text can never opt in.
- **Duplicate rule name** within the same server scope (point-fix repairs address rules by name).

Warnings (not errors) flag rules whose `paths.within` lies in a protected path (outside the sandbox) and filesystem rules inside the sandbox. The old name/description substring heuristic ("protected", "structural", "unknown-tool") is a warning too: real tools use those words (Sheets protected ranges, GitHub protected branches), and a misnamed rule cannot weaken the structural invariants.

Where the checks run:

1. **After the compiler answers.** Errors go back to the compiler session as a `## RULE VALIDATION REPAIR` turn that carries the rejected rule set (after a point-fix the compiler's last answer is a patch) and asks for the full rule set, at most two turns. `validateCompiledRules` sees the rules as written, before `paths.within` is canonicalized, so a relative `within` is sent back rather than resolved under the compile's working directory. Rules that still fail make the server fail (`phase: 'compiling'`) with the errors in its `failedServers` reason.
2. **After the server's dynamic lists are resolved**, with their values (for example, a broad manual addition). A failure fails the server.
3. **On a verified commit from the per-server cache** (see "Split Cache Key"). Its rules are checked with their resolved lists as they would be served (re-validated, as the merge does); rules that fail the current checks, which may be stricter than the ones they passed, are recompiled, neither served nor re-verified. A commit re-verified because its lists were missing is checked again once they are resolved, and recompiled if it fails.
4. **In the verify-repair loop.** A repair whose rules still fail the checks after the repair turns is rejected; the server keeps its last valid rules (and their lists file), and the next follow-up asks for a new repair against the same verdict. A rejected repair uses up a follow-up. If verification never passes, the failure reason names the last rejected repair's errors.
5. **On the merged policy**, with the merged lists, before anything is written. An error throws `PolicyLintError` (`code: 'POLICY_LINT_FAILED'`) and no artifact is written; this catches, for example, a list that two servers define differently (the merge keeps one definition).

The compiler prompt for a server whose tools take URLs carries a "Broad Egress" section when the policy has not opted in, and the task-policy prompt states the mutation and breadth rules, so the compiler rarely needs the repair turn. The list resolver never emits a broad wildcard (see `docs/designs/dynamic-lists.md`).

### Schema Enforcement: Server Scoping as a Zod Invariant

The primary enforcement mechanism for server scoping is the **Zod response schema**. Since the compiler only receives one server's tool annotations and the schema only permits that server's name, invalid output is rejected at parse time before it ever enters the system. No post-hoc filtering or validation is needed for correctness — the schema makes it structurally impossible to produce cross-server rules.

**1. Schema restriction (primary enforcement).** The `buildCompilerResponseSchema()` already accepts `serverNames` and `toolNames` as parameters. For per-server compilation, pass single-server values:

```typescript
const serverNames = [serverName] as [string, ...string[]];
const toolNames = [...new Set(serverAnnotations.map((a) => a.toolName))] as [string, ...string[]];
const schema = buildCompilerResponseSchema(serverNames, toolNames);
```

The Zod `z.enum(serverNames)` restricts the `server` field to exactly `[serverName]`. The `z.enum(toolNames)` restricts `tool` to only that server's tools. Any LLM output referencing other servers or tools fails schema validation and triggers the existing schema repair flow.

**2. Make `server` required in per-server mode.** Currently `server` is optional in the schema (`.optional()`). For per-server compilation, make it required so the LLM cannot omit it:

```typescript
function buildCompilerResponseSchema(
  serverNames: [string, ...string[]],
  toolNames: [string, ...string[]],
  options?: { requireServer?: boolean },
) {
  const serverField = z.array(z.enum(serverNames));
  const conditionSchema = z.object({
    // ...
    server: options?.requireServer
      ? serverField // required — schema rejects rules without server
      : serverField.optional(),
    // ...
  });
}
```

Per-server compilation passes `{ requireServer: true }`. Monolithic and task-policy compilation continue with `requireServer: false` (backward compatible). This ensures the LLM cannot produce rules without a `server` condition.

**3. Prompt reinforcement (belt-and-suspenders).** Add a directive to the system prompt. This guides the LLM to produce valid output on the first attempt, reducing schema repair round-trips:

```
## Server Scope

You are compiling rules for the "{serverName}" server ONLY.
Every rule you emit MUST include "server": ["{serverName}"] in the "if" condition.
Only the following tools are available: {toolNames}.
Do NOT emit rules for other servers or tools.
```

**4. Tool annotations scoping (input restriction).** The compiler receives only the target server's annotations. The `buildCompilerSystemPrompt()` formats only those annotations in the "Tool Annotations" section. The LLM never sees other servers' tools, making cross-server references unlikely even before schema validation.

The combination of input restriction (only one server's annotations), schema enforcement (Zod rejects invalid output), and prompt guidance (reduces repair round-trips) provides defense in depth. The `validateServerScoping()` function described later is a **debug assertion**, not a correctness requirement — if the schema is correct, it cannot fail.

### Per-Server Verification: Full Scoping Requirements

Per-server verification must scope **all** components to the single server being compiled. This is more than just passing fewer annotations — every verification subsystem needs scoping:

1. **PolicyEngine construction.** Create a per-server `PolicyEngine` with:
   - A `CompiledPolicyFile` containing only that server's rules
   - A `ToolAnnotationsFile` containing only that server's annotations (wrap in the `servers` record structure)
   - The same `protectedPaths` and `allowedDirectory` (structural invariants are global)
   - Per-server dynamic lists (only lists referenced by this server's rules, if any)

2. **PolicyVerifierSession scoping.** The `PolicyVerifierSession` constructor accepts `serverNames` and `toolNames` arrays that restrict the Zod schema for probe scenario generation. For per-server verification:

   ```typescript
   const verifierSession = new PolicyVerifierSession({
     system: verifierSystem,
     model: this.model,
     serverNames: [serverName] as [string, ...string[]],
     toolNames: serverToolNames, // only this server's tools
   });
   ```

   This prevents the verifier from generating probe scenarios for other servers.

3. **Judge system prompt scoping.** The `buildJudgeSystemPrompt()` accepts `allAvailableTools` and the compiled policy. For per-server verification, pass only that server's tools and rules:

   ```typescript
   const judgeSystem = buildJudgeSystemPrompt(
     constitutionText,
     serverPolicyFile, // only this server's rules
     protectedPaths,
     serverTools, // only this server's tools
     serverDynamicLists, // only lists referenced by this server
     allowedDirectory,
   );
   ```

4. **Structural conflict filtering.** The `filterStructuralConflicts()` function creates a `PolicyEngine` internally. It must use the per-server engine (same tool annotations and rules), not a merged one.

5. **Scenario generation scoping.** The `ScenarioGeneratorSession` receives annotations and generates scenarios only for tools it can see. For per-server compilation this is naturally scoped since we pass only that server's annotations.

**Cost implication:** Each server runs its own independent repair loop (up to 3 repair attempts per server). With N servers, the worst case is N × 3 repair cycles. For 4 servers, that's potentially 12 repair LLM calls instead of the current 2. In practice, most servers' rules are simpler in isolation and less likely to need repair.

### Handwritten Scenario Routing

The current `getHandwrittenScenarios()` returns scenarios only for the `filesystem` server (sandbox containment invariants). For per-server compilation, filter by server name to keep the approach general as new handwritten scenarios may be added for other servers in the future:

```typescript
function getHandwrittenScenariosForServer(serverName: string, sandboxDir: string): TestScenario[] {
  return getHandwrittenScenarios(sandboxDir).filter((s) => s.request.serverName === serverName);
}
```

This is safe because handwritten scenarios are already tagged with `serverName` in their `request` field. No new scenarios need to be created.

### Merge Phase

After all per-server compilations complete, merge results into the final `compiled-policy.json`:

```typescript
function mergeServerResults(results: ServerCompilationResult[], constitutionHash: string): CompiledPolicyFile {
  // Concatenate rules in a deterministic order (alphabetical by server name)
  const sortedResults = [...results].sort((a, b) => a.serverName.localeCompare(b.serverName));

  // Name every server's lists: shared when servers define a name identically,
  // `<server>--<name>` when they define it differently (list-merge.ts).
  const plan = planListMerge(results);
  const allRules: CompiledRule[] = sortedResults.flatMap((r) =>
    renameListReferences(r.rules, plan.renames.get(r.serverName)),
  );

  // The renamed, merged set must still validate (every @reference defined,
  // list types matching the conditions that use them); otherwise the run fails.
  const validation = validateCompiledRules(allRules, plan.definitions);
  if (!validation.valid) throw new Error(`The merged policy failed validation: ...`);

  // Compute a merged inputHash from all per-server hashes
  const mergedInputHash = computeHash(...sortedResults.map((r) => r.inputHash));

  return {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: mergedInputHash,
    rules: allRules,
    listDefinitions: plan.definitions.length > 0 ? plan.definitions : undefined,
  };
}
```

**Rule ordering within the merged file.** Since every rule has a `server` condition, rules from different servers never interfere with each other. A tool call for server X will never match a rule scoped to server Y. Therefore, the relative ordering of server blocks is irrelevant to correctness. We use alphabetical server order for determinism.

**Rule ordering within a server.** Each server's rules retain their LLM-generated order (first-match-wins within a server). This is preserved by `flatMap` on the sorted results.

**No cross-server conflict by construction.** The key insight: since compiled rules only use `allow` and `escalate` (never `deny`), and each rule is scoped to exactly one server via `server: [serverName]`, rules from different servers cannot conflict. A tool call is evaluated against the full rule chain, but only rules matching the call's server name can fire. Default-deny handles the rest. (Right before the merge, every server's allows that can match an outbound-channel tool become `assess` rules, an allow subject to the opt-in outbound content assessment; see [outbound-content-assessment.md](outbound-content-assessment.md). That is per rule and per server, so it does not change this argument.)

### Dynamic Lists Across Servers

Multiple servers can independently reference the same constitutional category (e.g., "major news sites"), and each server resolves and verifies its own lists (`servers/{S}/dynamic-lists.json`). Since list definitions are produced by independent LLM calls, two servers may also pick the same list name for different things (e.g., "trusted-hosts" as the hosts git may push to, and as the documentation sites fetch may read). The merge (`src/pipeline/list-merge.ts`) keeps every server's rules on the values they were verified with:

- **Same definition, shared list.** When every server that defines a name defines it identically (same type, generation prompt and `requiresMcp`, and for a data-backed list the same `mcpServerHint`; the descriptive `principle` is ignored), the servers share one merged list. Its values come from the first server (alphabetical) that has a resolution; a list none of them has resolved is written UNRESOLVED (no values, overrides kept), never with the values a previous merged file held.
- **Different definitions, kept apart.** Otherwise each server keeps its own list, renamed `<server>--<name>` in that server's rules and in the merged definitions. A renamed definition records its original name in `sourceName`; the per-server copies keep that name, which keys their cache (`computeListHash` includes the name). A note is printed for each such name.
- **No collisions.** A rename that would give two different lists the same merged name fails the merge (`ListNameCollisionError`) rather than mixing them.
- **Re-validated.** The merged rules are validated against the merged definitions (`validateCompiledRules`); an invalid merge fails the run before anything is written.

The merged `dynamic-lists.json` is the file users edit. Its `manualAdditions` / `manualRemovals` belong to the list name and are carried from the previous merged file into the next one, so a recompile (even one served entirely from cache) never reverts them. When the merge renames a list (it became, or stopped being, per-server), the removals of every previous list with that base name follow it, but additions follow only from a previous list resolved from the same definition (equal `inputHash`), so a value added for one server's list never widens another server's; a dropped addition is reported. Entries the new policy does not use are kept while they hold overrides, so a `--server --write-merged` run or a constitution change that drops a list for a while does not lose the user's removals. A previous file that is not valid JSON, or whose values or overrides are not arrays of strings, fails the run instead of being overwritten (it is read through the runtime lists schema). Each server's resolved lists are re-validated against the current value rules before they are merged, and the policy lint of the merged policy sees the merged lists with the carried-over overrides, as the engine will expand them: a broad manual addition (`*.com`) fails the compile unless the policy opts in to broad domains.

### PipelineRunner Changes

The `PipelineRunner.run()` method is restructured into three internal methods:

```typescript
class PipelineRunner {
  /**
   * Runs the full pipeline. New orchestration: per-server then merge.
   */
  async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    const toolAnnotationsFile = /* load as before */;
    const constitutionHash = computeHash(config.constitutionInput);

    // Phase 1: Per-server compilation
    const serverResults = await this.compileAllServers(config, toolAnnotationsFile, constitutionHash);

    // Phase 2: Merge
    const mergedPolicy = mergeServerResults(serverResults, constitutionHash);
    writeArtifact(config.outputDir, 'compiled-policy.json', mergedPolicy);

    // Merge scenarios for the global artifact
    const allScenarios = serverResults.flatMap(r => r.scenarios);
    writeArtifact(config.outputDir, 'test-scenarios.json', {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: mergedPolicy.inputHash,
      scenarios: allScenarios,
    });

    // Phase 3: Merged dynamic lists -- each list's values from the per-server
    // resolutions, the user's overrides from the previous merged file
    // (mergeDynamicLists in list-merge.ts). Written before compiled-policy.json.
    const previous = readDynamicListsArtifact(config.outputDir);
    const { lists: dynamicLists } = mergeDynamicLists(serverResults, plan, previous);

    // Optional: cross-server verification sanity check
    // (lightweight, uses merged policy + all scenarios)

    return mergedPolicy;
  }

  /**
   * Compiles rules for all servers. Currently sequential; can be
   * parallelized in a future PR.
   */
  private async compileAllServers(
    config: PipelineRunConfig,
    toolAnnotationsFile: ToolAnnotationsFile,
    constitutionHash: string,
  ): Promise<ServerCompilationResult[]> {
    const results: ServerCompilationResult[] = [];

    for (const [serverName, serverData] of Object.entries(toolAnnotationsFile.servers)) {
      const result = await this.compileServer({
        serverName,
        annotations: serverData.tools,
        constitutionText: config.constitutionInput,
        allowedDirectory: config.allowedDirectory,
        protectedPaths: config.protectedPaths,
        mcpServerConfig: config.mcpServers?.[serverName],
        handwrittenScenarios: getHandwrittenScenariosForServer(
          serverName, config.allowedDirectory
        ),
      }, config.outputDir, constitutionHash);
      results.push(result);
    }

    return results;
  }

  /**
   * Compiles a single server: compile -> generate scenarios -> verify -> repair.
   * Self-contained compile-verify-repair loop per server.
   */
  private async compileServer(
    unit: ServerCompilationUnit,
    outputDir: string,
    constitutionHash: string,
  ): Promise<ServerCompilationResult> {
    const serverOutputDir = resolve(outputDir, 'servers', unit.serverName);

    // Check per-server cache
    const existing = loadExistingArtifact<ServerCompiledPolicyFile>(
      serverOutputDir, 'compiled-policy.json'
    );
    const inputHash = computeServerPolicyHash(/* ... */);

    if (existing && existing.inputHash === inputHash) {
      // Cache hit: skip LLM calls entirely
      return { /* from existing */ };
    }

    // Build per-server system prompt (only this server's annotations)
    const compilerPrompt = buildCompilerSystemPrompt(
      unit.constitutionText,
      unit.annotations,  // <-- only this server's annotations
      { protectedPaths: unit.protectedPaths },
      unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
    );

    // Per-server compile-verify-repair loop:
    //
    // 1. Compile: ConstitutionCompilerSession with per-server schema
    //    (requireServer: true, single serverName enum, single server's toolNames)
    // 2. Generate scenarios: ScenarioGeneratorSession with this server's annotations only
    // 3. Verify: PolicyVerifierSession scoped to this server
    //    (single-server PolicyEngine, single-server judge prompt, single-server probe schema)
    // 4. Repair (up to 3 attempts): recompile + re-verify, all scoped to this server
    //
    // Each server gets its own independent sessions — no shared state between servers.
    // The repair loop logic is extracted from the existing PipelineRunner.run() method
    // into a reusable per-server method.
    // ...

    // Write per-server artifacts
    writeArtifact(serverOutputDir, 'compiled-policy.json', serverPolicyFile);
    writeArtifact(serverOutputDir, 'test-scenarios.json', serverScenariosFile);

    return result;
  }
}
```

### Parallel Server Compilation

Per-server compilations are independent and can run in parallel. The initial implementation should be **sequential** (for simpler debugging and progress reporting), with a `--parallel` flag or config option to enable concurrent compilation:

```typescript
// Future: parallel compilation
private async compileAllServersParallel(/* ... */): Promise<ServerCompilationResult[]> {
  const units = Object.entries(toolAnnotationsFile.servers).map(/* ... */);
  return Promise.all(units.map(unit => this.compileServer(unit, outputDir, constitutionHash)));
}
```

Parallel compilation is safe because:

- Each server writes to its own subdirectory (no file conflicts)
- Each server gets its own `ConstitutionCompilerSession` (no shared state)
- The LLM model object is stateless (AI SDK models are safe to call concurrently)
- Progress reporting will need adjustment (interleaved spinners or a summary mode)

However, parallel compilation should be deferred to a follow-up PR because:

- Progress reporting needs a different UX (cannot interleave multiple spinners)
- Error handling needs careful design (what to do if one server fails while others are in-flight)
- Rate limits on the LLM API may cause failures under parallel load

### Task-Policy Mode

The `compileTaskPolicy()` function (used by cron jobs) compiles whitelist rules from a task description. This mode should **not** use per-server compilation because:

1. Task policies are narrow whitelists, not broad constitution-derived rules
2. The task description is short and the LLM benefits from seeing all tools at once to select the minimal set
3. Task policies are compiled once per job, not incrementally

The per-server path is gated on `constitutionKind === 'constitution'`. Task-policy compilation continues to use the existing monolithic path.

```typescript
async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
  if (config.constitutionKind === 'task-policy') {
    return this.runMonolithic(config);  // existing logic, renamed
  }
  return this.runPerServer(config);     // new per-server logic
}
```

### Server Name Enforcement Validation (Debug Assertion)

Since the Zod schema enforces `server: [serverName]` as a required field in per-server mode, this validation should never fail. It exists as a debug assertion to catch bugs in the pipeline itself (e.g., if someone passes the wrong schema options). It runs before merge at negligible cost:

```typescript
function validateServerScoping(serverName: string, rules: CompiledRule[]): void {
  for (const rule of rules) {
    if (!rule.if.server || !rule.if.server.includes(serverName)) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" is missing ` +
          `server: ["${serverName}"] in its condition. This is a compiler bug.`,
      );
    }
    if (rule.if.server.length !== 1 || rule.if.server[0] !== serverName) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" has unexpected ` +
          `server scope: ${JSON.stringify(rule.if.server)}. Expected exactly ["${serverName}"].`,
      );
    }
  }
}
```

This validation runs before merge. If it fails, that server's compilation fails: the server is recorded in `failedServers` and left out of the merged policy (see "Verification-Gated Cache and Failed Servers"). It also runs on cache hits, after the runtime schema check of the cached rules, where a mis-scoped or malformed cached file is recompiled instead of served.

### Cross-Server Verification (Not Needed)

Cross-server verification after merging is unnecessary because per-server rules compose correctly by construction:

1. **Server scoping is a Zod invariant.** Every rule has `server: [serverName]` enforced by the schema (`requireServer: true` in per-server mode). Rules from server A structurally cannot reference server B.
2. **Engine enforces server matching.** The PolicyEngine checks `cond.server.includes(request.serverName)` before evaluating any rule. A rule scoped to server A will never fire for a server B tool call.
3. **No deny rules means no cross-server interference.** Compiled rules only use `allow`, `assess` (an allow subject to the outbound content assessment) and `escalate`. The default-deny fallback handles everything else. There is no mechanism by which server A's rules could weaken server B's security posture.
4. **Structural invariants are global and evaluated first.** Path containment and domain allowlist checks run before compiled rules, independent of server scoping.

If each server's rules verify correctly in isolation (which the per-server compile-verify-repair loop ensures), the merged rule set behaves identically to the union of independent per-server evaluations.

## Changes to Existing Modules

### `src/pipeline/pipeline-runner.ts` (major changes)

- `PipelineRunner.run()` becomes a dispatcher: per-server for `'constitution'`, monolithic for `'task-policy'`
- Existing `run()` logic moves to `runMonolithic()` (private, backward-compatible)
- New `runPerServer()` orchestrates per-server compilation + merge
- New `compileServer()` method handles a single server's compile-verify-repair cycle
- New `mergeServerResults()` and `validateServerScoping()` helper functions
- `PipelineRunConfig` gains an optional `serverFilter?: string[]` field to compile only specific servers (useful during development)

### `src/pipeline/constitution-compiler.ts` (moderate changes)

- `buildCompilerSystemPrompt()` gains an optional `serverScope?: string` parameter that, when provided, appends the "Server Scope" section to the system prompt
- `buildCompilerResponseSchema()` gains an `options?: { requireServer?: boolean }` parameter. When `requireServer: true`, the `server` field in `CompiledRuleCondition` is **required** (not optional), ensuring the Zod schema rejects rules without server scoping at parse time. The existing monolithic and task-policy paths pass `requireServer: false` (default) for backward compatibility.

### `src/pipeline/scenario-generator.ts` (minor changes)

- `buildGeneratorSystemPrompt()` already accepts `annotations: ToolAnnotation[]`; per-server compilation passes only the server's annotations
- `buildGeneratorResponseSchema()` already accepts `serverNames` and `toolNames`; no change needed

### `src/pipeline/policy-verifier.ts` (no code changes, different usage)

- `verifyPolicy()` already accepts a `CompiledPolicyFile` and `ToolAnnotationsFile` — per-server verification passes single-server versions of both
- `buildJudgeSystemPrompt()` already accepts `allAvailableTools` — per-server passes only that server's tools
- `PolicyVerifierSession` constructor already accepts `serverNames` and `toolNames` — per-server passes single-server arrays to restrict probe scenario generation
- No code changes needed in this file; all scoping is achieved by the caller passing scoped inputs

### `src/pipeline/handwritten-scenarios.ts` (no changes)

- Scenarios already have `serverName` in their request; filtering is done by the caller

### `src/pipeline/pipeline-shared.ts` (minor changes)

- `writeArtifact()` already handles `mkdirSync({ recursive: true })`; works for nested `servers/{name}/` directories
- New `loadServerArtifact()` convenience function for loading per-server cached artifacts

### `src/pipeline/compile.ts` (minor changes)

- Progress banner updated to show per-server compilation progress
- New `--server <name>` CLI flag to compile only a specific server (for development/debugging). It writes only `servers/<name>/` unless `--output-dir` or `--write-merged` is given.
- Exit status 2 when the policy was written but some servers failed (`failedServers`)

### `src/pipeline/types.ts` (additions only)

- New `ServerCompiledPolicyFile` interface
- New `ServerCompilationUnit` and `ServerCompilationResult` interfaces (or these could live in `pipeline-runner.ts` as they are internal)

### `src/trusted-process/policy-engine.ts` (no changes)

The PolicyEngine consumes `CompiledPolicyFile` which has the same format after merge. No changes needed.

### `src/config/generated/` (directory structure change)

New `servers/` subdirectory with per-server artifacts. The top-level `compiled-policy.json` remains the merged output, consumed by the runtime.

## Migration Path

### Phase 1: Extract monolithic logic into `runMonolithic()`

Rename the existing `run()` body to `runMonolithic()`. The public `run()` delegates to it. This is a pure refactor with no behavioral change. Tests continue to pass.

### Phase 2: Add per-server infrastructure

- Add `ServerCompiledPolicyFile` type
- Add `mergeServerResults()`, `validateServerScoping()`, `getHandwrittenScenariosForServer()`
- Add `compileServer()` method (extracts and adapts the compile-verify-repair loop)
- Add the `serverScope` parameter to `buildCompilerSystemPrompt()`
- Add per-server artifact I/O (`servers/{name}/` directory)

### Phase 3: Wire up `runPerServer()`

- Implement `runPerServer()` that orchestrates per-server compilation + merge
- Gate on `constitutionKind === 'constitution'` in `run()`
- Add `--server <name>` CLI flag

### Phase 4: Validate and tune

- Run full pipeline end-to-end, compare merged output quality to monolithic
- Verify that caching works (change one server's annotations, confirm only that server recompiles)
- Verify that task-policy mode is unaffected

### Backward Compatibility

- The merged `compiled-policy.json` has the same `CompiledPolicyFile` format
- Existing tests that use `PipelineRunner.run()` continue to work
- Task-policy compilation is completely unaffected
- The per-server artifacts in `servers/` are new and don't conflict with anything
- `compile-policy --force` forces a full recompilation (deleting `servers/` does too)

## Type Changes Summary

New types (all in `src/pipeline/types.ts` or `pipeline-runner.ts`):

```typescript
// Per-server compiled policy artifact
interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  readonly inputHash: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly rulesHash?: string;
  readonly scenarioHash?: string;
  readonly engineSemanticsVersion?: number;
  readonly verifierVersion?: number;
  readonly policyModelId?: string;
  readonly verifierModelId?: string;
}
```

Modified types:

```typescript
// PipelineRunConfig -- new optional fields
interface PipelineRunConfig {
  // ... existing fields ...

  /** Compile only these servers (default: all servers in annotations). */
  readonly serverFilter?: string[];

  /** Write the merged artifacts (default: true, but false when serverFilter is set). */
  readonly writeMergedArtifacts?: boolean;

  /** Ignore every verified per-server commit (compile-policy --force). */
  readonly force?: boolean;

  /** How the user rebuilds without the cache, named in cache-drift warnings (default: remove servers/<name>/). */
  readonly cacheBypassHint?: string;

  /**
   * Compile (and resolve lists) without scenarios, verification or repair.
   * Used only for task scopes (`--task-scoped`), which the engine intersects
   * with a verified session policy; see task-scoped-sessions.md. The
   * deterministic rule checks (policy lint) still run after the compiler and
   * after list resolution. The rules stay unverified drafts, which the
   * per-server cache never serves.
   */
  readonly skipVerification?: boolean;
}

// CompiledPolicyFile -- new optional, informational fields
interface CompiledPolicyFile {
  // ... existing fields ...
  provenance?: PolicyProvenance;
  failedServers?: Array<{ serverName: string; phase: ServerCompilationFailurePhase; reason: string }>;
}

// TestScenariosFile -- decisions recorded at verification, for offline replay
interface TestScenariosFile {
  // ... existing fields ...
  replay?: { allowedDirectory: string; decisions: Decision[] };
}
```

No existing types are modified in breaking ways. The `CompiledPolicyFile` format only gains the optional `provenance` and `failedServers` fields, which the engine does not read.

## Risks and Mitigations

**Risk: Per-server rules differ structurally from monolithic rules.** This is a deliberate behavioral change (see "Behavioral Change" section above). Each server's compiler independently interprets constitutional principles, which may produce different condition patterns across servers for the same principle. **Mitigation:** This is acceptable — correctness is per-server (each server's rules correctly implement the constitution for that server's tools). Cross-server consistency is nice-to-have, not required. The cross-server verification step confirms merged behavior is correct.

**Risk: Increased total LLM cost.** Multiple LLM calls instead of one, and each server may need independent repair loops (up to 3 repairs × N servers). **Mitigation:** Each call is smaller (fewer tokens in prompt and response). Incremental caching means most servers skip LLM calls entirely when nothing changes. Per-server rules are simpler in isolation and less likely to need repair. Net cost should be similar or lower over time.

**Risk: Rule ordering sensitivity across servers.** If server A and B both produce rules that could match the same tool call, ordering matters. **Mitigation:** This is structurally impossible because the Zod schema enforces `server: [serverName]` as a required field in per-server mode. Rules from server A literally cannot match tool calls for server B. Schema validation rejects any non-compliant LLM output at parse time.

**Risk: LLM ignores the server scope instruction.** The LLM might try to emit rules without the `server` field or with the wrong server. **Mitigation:** The Zod schema makes `server` required and restricts it to a single-element enum. Invalid output fails schema validation immediately and triggers the existing schema repair flow. The prompt reinforces this to reduce repair round-trips. The `validateServerScoping()` debug assertion provides a final safety net.

**Risk: Divergent dynamic list definitions across servers.** Two independent LLM calls may produce different definitions (prompt, type, data source) for the same list name. **Mitigation:** The merge keeps such lists apart per server (`<server>--<name>`), so each server's rules expand to the values resolved, and verified, for its own definition; identical definitions are shared. The merged rules are re-validated, and a rename that would collide with another list's name fails the merge. In practice, most lists are only referenced by one server's rules (e.g., domain lists by the fetch server).
