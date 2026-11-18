# Design: Policy Compilation Pipeline

**Status (2026-11-14):** Implemented (`src/pipeline/`).

**Date:** 2026-02-17

## Problem

The current policy engine (`policy-engine.ts`) hardcodes filesystem tool names in `READ_TOOLS`, `WRITE_TOOLS`, and `DELETE_TOOLS` sets. Adding a new MCP server (Gmail, Slack, Calendar) requires manually updating these sets -- it doesn't scale. Additionally, `constitution.md` exists but is never read by the system; the policy rules that happen to reflect it are hand-written code.

We need:

1. Automatic discovery and classification of MCP tool capabilities.
2. A compilation pipeline that turns the English-language constitution into enforceable declarative policy rules, verified against real policy engine execution.
3. Persistent configuration artifacts produced by a dedicated command, not regenerated on every startup.

## Design Overview

The pipeline is a **separate offline command** (`ironcurtain compile-policy`) that produces three persistent configuration files:

```
constitution.md + MCP tool schemas
        |
        v
+---------------------+
|  Tool Annotator LLM |  -->  tool-annotations.json
+---------------------+
        |
        v
+--------------------------+
| Constitution Compiler LLM |  -->  compiled-policy.json
+--------------------------+
        |
        v
+------------------------------+
| Test Scenario Generator LLM  |  -->  test-scenarios.json
+------------------------------+
        |
        v
+---------------------------+
| Policy Verifier            |  -->  pass/fail + diagnostics
| (real engine + LLM judge)  |
+---------------------------+
```

Artifacts are written to `src/config/generated/` as each pipeline step completes (regardless of whether verification passes). At runtime, `PolicyEngine` loads `compiled-policy.json` and `tool-annotations.json` and evaluates declaratively -- no hardcoded tool sets.

**Critical architectural constraint:** Structural invariants are **never** part of the compiled policy. They are hardcoded in the PolicyEngine and evaluated before any compiled rules. See Section 7 for details.

**Packaging:** During development, `npm run compile-policy`. When published as a package, `npx @provos/ironcurtain compile-policy`. The CLI entry point dispatches subcommands.

## Component Details

### 1. Tool Annotation Schema

Each MCP tool is annotated with whether it has **side effects** and the **roles** of its arguments. Argument roles are the single source of truth for tool classification -- there is no separate `effect` field. An argument can carry multiple roles (e.g., the source of a move is both a read-path and a delete-path).

```typescript
type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

interface ToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string; // LLM-generated description of the tool's purpose
  args: Record<string, ArgumentRole[]>;
}

// Per-server annotations file
interface ToolAnnotationsFile {
  generatedAt: string;
  servers: Record<
    string,
    {
      inputHash: string; // content hash for caching (see Section 9)
      tools: ToolAnnotation[];
    }
  >;
}
```

**Argument role semantics:**

| Role          | Meaning                                 | Policy check                          |
| ------------- | --------------------------------------- | ------------------------------------- |
| `read-path`   | Argument is a path that will be read    | Checked against permitted directories |
| `write-path`  | Argument is a path that will be written | Checked against permitted directories |
| `delete-path` | Argument is a path that will be deleted | Subject to delete policy              |
| `none`        | Not a resource path                     | No path-based policy check            |

All path-bearing roles use symlink-aware `resolveRealPath()` for normalization, which follows symlinks to canonical forms (on macOS through the native realpath, which also returns the on-disk spelling of existing components). This prevents symlink-escape attacks where a symlinked directory could circumvent containment checks.

**Conditional roles:** Multi-mode tools (e.g., `git_branch` with list/create/delete operations) use conditional role specs in the stored annotation format (`StoredToolAnnotation`). Instead of a static `ArgumentRole[]`, an argument's roles can be `{ default: ArgumentRole[], when: [{ condition: { arg, equals|in|is }, roles }] }`. The `default` is the most-restrictive union; `when` clauses narrow it based on sibling argument values. Resolution happens at the policy engine lookup boundary via `resolveStoredAnnotation()` — all downstream consumers see plain `ToolAnnotation`. See `docs/designs/conditional-argument-roles.md` for the full design.

**Example annotations:**

```json
{
  "toolName": "move_file",
  "serverName": "filesystem",
  "comment": "Moves a file from source to destination, deleting the source",
  "args": {
    "source": ["read-path", "delete-path"],
    "destination": ["write-path"]
  }
}
```

The `source` of a move carries both `read-path` and `delete-path` roles. This means a compiled rule matching on `delete-path` will catch `move_file` -- the move tool cannot be used as a backdoor around delete policies.

```json
{
  "toolName": "list_allowed_directories",
  "serverName": "filesystem",
  "comment": "Lists directories the server is allowed to access",
  "args": {}
}
```

No arguments, no side effects. The compiled policy can include a rule allowing side-effect-free tools without path constraints.

### 2. Tool Annotator (`src/pipeline/tool-annotator.ts`)

**Input:** MCP tool schemas (from `listTools()` for each configured server).

**Process:** Single LLM call per server. The prompt provides:

- The tool name, description, and input schema for every tool on that server.
- The `ToolAnnotation` output schema with role definitions.
- Instructions to map argument names to roles. An argument may have multiple roles.

**Output:** `ToolAnnotation[]` for the server.

**Compile-time validation:** After the LLM returns annotations, a heuristic check runs against each tool's schema. For every argument whose default value or schema examples suggest a filesystem path (strings starting with `/` or `.`), the validator checks that the annotation includes an appropriate path role. If the heuristic finds potential paths not covered by any role, the pipeline emits a warning and halts. This catches annotation errors at compile time rather than leaving gaps at runtime.

**Design notes:**

- Single-pass (no verifier for annotations). The constitution verifier downstream validates the overall pipeline.
- The annotator does not see the constitution. It classifies tools purely by their schemas and descriptions.
- Module exports the main function and a prompt builder (for hash computation):

```typescript
async function annotateTools(
  serverName: string,
  tools: Tool[], // MCP Tool type from listTools()
  llm: LanguageModel, // AI SDK model instance (injectable for testing)
): Promise<ToolAnnotation[]>;

function buildAnnotationPrompt(serverName: string, tools: Tool[]): string; // exported for content-hash computation
```

### 3. Constitution Compiler (`src/pipeline/constitution-compiler.ts`)

**Input:** Constitution text + tool annotations + system config (`CompilerConfig` with `sandboxDirectory: string` and `protectedPaths: string[]`).

**Process:** Single LLM call. The prompt provides:

- The full constitution text.
- All tool annotations (so the LLM knows what tools exist, what they do, and which have side effects).
- The `CompiledRule` schema (see below).
- The concrete directory paths referenced by the constitution (e.g., sandbox directory, documents directory). These are resolved from system configuration before being passed to the compiler.
- An explicit instruction that structural invariants (protected paths, audit log protection, unknown tool denial) are handled separately and must NOT be included in the compiled rules.
- Instructions to produce an ordered rule chain (first match wins) that faithfully implements the constitution's non-structural principles. Rules must reference concrete absolute paths, not abstract labels.

**Output:** `CompiledRule[]`

```typescript
interface PathCondition {
  roles: ArgumentRole[]; // which argument roles to extract paths from
  within: string; // concrete absolute directory path
  // True if ALL extracted paths resolve to within this directory.
  // Zero extracted paths = condition not satisfied (rule does not match).
}

interface CompiledRuleCondition {
  roles?: ArgumentRole[]; // match tools with any argument having these roles (blanket rules)
  server?: string[]; // server names to match (omit = all)
  tool?: string[]; // specific tool names (omit = all)
  paths?: PathCondition; // if present, rule only fires when path condition is met
  // Note: `roles` and `paths` serve different purposes. `roles` is for blanket
  // matching (e.g., "deny all tools with delete-path args"). `paths` extracts
  // concrete path values and checks containment. They should not both appear
  // in the same rule.
}

interface CompiledRule {
  name: string;
  description: string;
  principle: string; // which constitution principle this implements
  if: CompiledRuleCondition;
  then: 'allow' | 'deny' | 'escalate';
  reason: string;
}

interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string; // content hash for caching (see Section 9)
  rules: CompiledRule[];
}
```

**Rule evaluation semantics:**

1. Rules are evaluated in order. First matching rule wins.
2. A rule **matches** if ALL conditions in the `if` block are true:
   - `roles` is absent OR the tool has at least one argument whose annotated roles include any role in the list.
   - `server` is absent OR the request's server is in the list.
   - `tool` is absent OR the request's tool is in the list.
   - `paths` is absent OR the path condition evaluates to true (see below).
3. If no rule matches, default deny.

**Path condition evaluation:**

For each argument in the request whose annotated roles include any role in `paths.roles`, extract the path value. Then:

- **Zero paths extracted:** The condition is **not satisfied** -- the rule does not match. Tools with no path arguments need a separate rule without a `paths` condition (e.g., matching on specific tool names).
- **`within`:** True if **ALL** extracted paths resolve to within the specified directory. (Conservative: one path outside fails the whole check.)

Path resolution uses `node:path.resolve()` to neutralize traversal attacks.

The "outside a directory" semantics are handled by rule ordering: a rule with `within: "/some/dir"` matches the inside case; the next rule without a `paths` condition catches everything else as a fallthrough. This eliminates the need for an explicit `outside` operator.

**Example compiled policy for the current constitution:**

In this example, the sandbox is at `/tmp/ironcurtain-sandbox`. A richer constitution might also grant read access to `/home/user/Documents`.

```json
{
  "rules": [
    {
      "name": "deny-delete-operations",
      "description": "Block all tools that carry a delete-path role argument",
      "principle": "No destruction",
      "if": { "roles": ["delete-path"] },
      "then": "deny",
      "reason": "Delete operations are never permitted. This also catches move_file because its source argument has a delete-path role."
    },
    {
      "name": "allow-sandbox-read",
      "description": "Allow reading files within the sandbox directory",
      "principle": "Containment",
      "if": {
        "paths": { "roles": ["read-path"], "within": "/tmp/ironcurtain-sandbox" }
      },
      "then": "allow",
      "reason": "Read within sandbox directory"
    },
    {
      "name": "escalate-read-elsewhere",
      "description": "Reads outside permitted directories need human approval",
      "principle": "Human oversight",
      "if": { "roles": ["read-path"] },
      "then": "escalate",
      "reason": "Read outside permitted directories requires human approval"
    },
    {
      "name": "allow-sandbox-write",
      "description": "Allow writes where all paths are within sandbox",
      "principle": "Containment",
      "if": {
        "paths": { "roles": ["write-path"], "within": "/tmp/ironcurtain-sandbox" }
      },
      "then": "allow",
      "reason": "Write within sandbox directory"
    },
    {
      "name": "escalate-write-elsewhere",
      "description": "Writes outside sandbox need human approval",
      "principle": "Human oversight",
      "if": { "roles": ["write-path"] },
      "then": "escalate",
      "reason": "Write outside sandbox requires human approval"
    }
  ]
}
```

Note how all moves are denied by the `deny-delete-operations` rule: `move_file`'s source argument carries `["read-path", "delete-path"]` roles, so any move matches the blanket `roles: ["delete-path"]` condition. No separate move-specific rules are needed.

A richer constitution allowing read access to a documents folder would add a rule before `escalate-read-elsewhere`:

```json
{
  "name": "allow-read-documents",
  "description": "Allow reading files in the user's documents folder",
  "principle": "Containment",
  "if": {
    "paths": { "roles": ["read-path"], "within": "/home/user/Documents" }
  },
  "then": "allow",
  "reason": "Read access to documents folder"
}
```

### 4. Test Scenario Generator (`src/pipeline/scenario-generator.ts`)

**Input:** Constitution text + tool annotations + mandatory handwritten scenarios, plus two inputs taken from the rules under test: the directories they name in `paths.within` (allow and escalate rules alike) and their resolved dynamic-list values.

**Process:** Single LLM call. The prompt instructs the LLM to:

- Read the constitution's principles.
- Generate test scenarios: concrete tool call examples with expected policy decisions.
- Cover positive cases (should be allowed), negative cases (should be denied), and edge cases (boundary conditions, path traversal attempts).
- Include scenarios for side-effect-free tools.
- Include scenarios for multi-role arguments (e.g., `move_file` -- all permutations should be denied because the source has a `delete-path` role).
- Base every expected decision on the constitution, never on the compiled rules.

**Inputs from the policy under test:** The scenarios are the oracle for the rules, so nothing taken from the rules may decide an expectation. The rules' directories are listed under "Directories Referenced by the Policy Under Test": they give the concrete paths of directories the constitution names in prose, and the prompt says not to assume a listed directory is permitted (an over-broad rule `within` a home directory must not turn into `allow` expectations that confirm it). The resolved list values are presented as possibly wrong: scenarios use list values and unrelated values alike, and expect `allow` for a list value only when the constitution permits it. The judge prompt shares the list section and probes inside and just outside the rules' directories as well as the directories the constitution names. Generating scenarios from the constitution before compiling, with the constitution's directory references resolved deterministically, would remove these inputs altogether; it is not done yet.

**Verifier model:** `policyVerifierModelId` in `~/.ironcurtain/config.json` (optional) names a model for the oracle: it generates the scenarios and their replacements and judges every verification round, while the policy model (`policyModelId`) compiles, repairs and resolves lists. Unset, the policy model does both, in separate sessions. A separate model keeps one model's blind spots from both writing and approving the rules; each verified per-server commit records it (`verifierModelId`).

**Output:** `TestScenario[]`

```typescript
interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: 'allow' | 'deny' | 'escalate';
  reasoning: string; // why this decision follows from the constitution
  source: 'generated' | 'handwritten';
}

interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string; // content hash for caching (see Section 9)
  scenarios: TestScenario[];
}
```

**Mandatory handwritten scenarios:** The pipeline includes a set of handwritten test scenarios (`src/pipeline/handwritten-scenarios.ts`), always included in the output alongside LLM-generated scenarios and shown to the compiler as ground truth. They provide human-authored ground truth that the verifier checks against, mitigating the circular reasoning risk where the compiler and scenario generator share the same blind spots. The judge can never correct them.

Only universal, constitution-independent invariants belong there, so every compile includes them: the global constitution, persona compiles and cron-job task policies alike (`PipelineRunConfig.includeHandwrittenScenarios` defaults to true for both constitution kinds; only tests whose fake servers they do not apply to turn them off). Each server gets the ones that name it. The handwritten scenarios cover the `filesystem` server:

- Move a file from outside the sandbox (`/etc/important.txt`) into it, not allowed (the source has a `delete-path` role)
- Write a file outside the sandbox (`/etc/test.txt`), not allowed

### 5. Policy Verifier (`src/pipeline/policy-verifier.ts`)

The verifier is a **multi-round loop** that executes test scenarios against the real PolicyEngine and uses an LLM judge to analyze results and probe for gaps.

**Round 1 -- Execute and judge:**

1. Instantiate a real `PolicyEngine` with the compiled policy, tool annotations, and `protectedPaths`.
2. Run every test scenario (handwritten + LLM-generated) through the engine.
3. Collect execution results: for each scenario, the actual decision, matching rule, and whether it matches the expected decision.
4. Send to Verifier LLM: the constitution, the compiled rules, the tool annotations, and the full execution results table. The LLM is asked to:
   a. Analyze any discrepancies (expected != actual). Is the rule wrong, or is the expectation wrong?
   b. Identify suspicious patterns (e.g., a broad allow rule shadowing a narrow deny).
   c. Identify missing coverage -- scenarios the constitution implies that weren't tested.
   d. If gaps are suspected, output **additional test scenarios** to probe them.

**Round 2+ -- Probe gaps (if the verifier generated new scenarios):**

5. Run the new scenarios through the real PolicyEngine.
6. Send results back to the Verifier LLM alongside previous context.
7. Verifier makes updated judgment, potentially generating more scenarios.

**Exit condition:** The judge asks for no further probes, or the maximum round count is reached (3 rounds for the initial verification, 2 for each follow-up verification in the repair loop, to bound LLM cost). Probes the judge asks for in the final round are still run through the engine afterwards (after the same schema, default-role-fallback and structural filtering as every probe) and recorded as that round's `unjudgedResults`. The schema filter checks probe arguments against the live input schemas `compile-policy` collected (`liveToolSchemas`) where it has them, else against the stored ones, as the pipeline runner checks its scenarios. The structural filter drops only expectations no rule change could meet: the domain gate's escalation is not final (a compiled deny wins over it), so under the gate only an `allow` expectation is dropped, and a `deny` probe that fails there is run as the rule failure it is.

**Verdict:** structured data only. Verification passes when the judge's `pass` flag in the final round is true AND no executed scenario failed in any round, unjudged probes included. The judge's free-text analysis never decides the verdict. The judge names each failure it attributes by the `[N]` index shown in the results as well as by description, so two scenarios that share a description are told apart; an attribution that names no single FAIL result is dropped, and the failure counts as a rule failure.

```typescript
interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: 'allow' | 'deny' | 'escalate';
  matchingRule: string; // which rule fired (structural or compiled)
  pass: boolean; // actualDecision === expectedDecision
}

interface VerifierRound {
  round: number;
  executionResults: ExecutionResult[]; // results the judge saw this round
  llmAnalysis: string;
  judgePass: boolean; // the judge's structured verdict for this round
  newScenarios: TestScenario[]; // additional scenarios to probe (empty if none)
  attributedFailures?: AttributedFailure[]; // resolved to FAIL results by index
  unjudgedResults?: ExecutionResult[]; // final round only: probes run after the round limit
}

interface VerificationResult {
  pass: boolean; // final judgePass && no failure in any round
  rounds: VerifierRound[];
  summary: string;
  failedScenarios: ExecutionResult[]; // every failure, unjudged probes included
}
```

**Why execute the real engine:** An LLM simulating first-match-wins evaluation over ordered rules is unreliable. By running the actual PolicyEngine, we get ground truth about what the compiled policy does. The LLM judge then focuses on what it's good at: reasoning about whether those outcomes are correct according to the constitution's intent.

**Design notes:**

- The verifier is told about structural invariants so it understands the complete policy stack.
- If verification fails, the command prints diagnostics and exits with a non-zero code. Artifacts remain on disk for inspection and caching (verification is a quality report, not a deployment gate).
- The multi-round loop lets the verifier probe edges it's suspicious about, similar to an engineer running tests, reading failures, and writing more targeted tests.
- Future enhancement: feed failures back to the compiler for a re-compilation attempt. Not in tracer bullet scope.

### 6. Declarative PolicyEngine (refactored `src/trusted-process/policy-engine.ts`)

The refactored engine evaluates in two phases: hardcoded structural invariants first, then compiled rules.

```typescript
class PolicyEngine {
  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[], // from system config, not compiled
  );

  evaluate(request: ToolCallRequest): EvaluationResult;
}
```

**Evaluation algorithm:**

**Structural checks -- Structural invariants (hardcoded, never LLM-generated):**

1. Extract the values of every argument whose annotated roles include a path role. A string, a finite number (in decimal form) or an array of those yields its values. Any other value (an object, an array holding an object, an array or `null`, a boolean) yields every string and number value inside it, so no value can hide from the checks in a structure, and the call is also escalated to a human (step 4a). Object keys are not read: a resource identifier used as a key is seen only by that human.
2. Resolve each extracted path with the symlink-following `resolveRealPath()`, once per evaluation however many checks compare it. The sandbox (`allowedDirectory`) and every rule's `paths.within` are resolved once when the engine is built (a policy hot-swap builds a new engine); the protected entries are resolved again for every evaluation, so a symlink created later at a protected name protects its target.
3. Check each resolved path against `protectedPaths`. If any path is a protected path or is within a protected directory, return `{ decision: 'deny', rule: 'structural-protected-path', reason: 'Access to a protected path is forbidden' }`. The reason never echoes the requested or protected path. Matching is spelling-insensitive and the sandbox exemption is per entry (see "Protected paths" in section 7). A path argument that cannot be canonicalized at all is denied with `structural-unresolvable-path`.
   a. When the engine has a read-only workspace (`PolicyEngineOptions.readOnlyWorkspace`: a `workspaceAccess: read-only` workflow state or container scope), every resolved value of a mutation path role (every path role but `read-path`) must lie inside one of its writable directories, the canonical sandbox joined with each workspace-relative writable path (the state's `.workflow/<output>` directories). A call that changes a git repository (any mutation path role on the git backend, a history role on any server) is refused wherever its path points: host git acts on the repository that contains the path, and from a writable directory that is the workspace's own (the discovery ceiling is the workspace's parent), so `git reset --hard` or `git stash` "in `.workflow/reviews`" would rewrite the whole work tree. Otherwise return `{ decision: 'deny', rule: 'structural-read-only-workspace' }`. This runs before sandbox containment, which would otherwise allow every change inside the sandbox, and the coordinator applies it to every engine `loadPolicy` swaps in, so no persona's rules lift it.
4. If the tool has no annotation (unknown tool), return `{ decision: 'deny', rule: 'structural-unknown-tool', reason: '...' }`.
   a. If an argument with a role other than `none` holds a value that is not a string, a number or a flat list of them (step 1), record a human-only escalation, `structural-nested-argument-escalate`, naming that argument's roles. Like the other structural escalations it is combined with the compiled result: a compiled deny still wins, and otherwise the call goes to a human (never to the auto-approver or a whitelist pattern, which only see top-level values). A role describes the whole argument, so no per-value decision can say what the structure means to the server.

**Compiled rule evaluation -- Compiled rules with multi-role evaluation:**

5. Look up `ToolAnnotation` for `request.serverName + request.toolName`.
6. Collect all distinct non-`none` roles from the tool's annotation (e.g., `edit_file` might have `read-path` and `write-path`).

**If the tool has no roles** (e.g., `list_allowed_directories`), evaluate the rule chain once without role filtering. First matching rule wins.

**If the tool has one or more roles**, evaluate the rule chain independently for each role. For each role evaluation:

- Rules with role-related conditions (`roles` or `paths`) are only considered if they are relevant to the current role.
- Rules without role conditions (role-agnostic) are always considered.
- First matching rule wins for that role.

The **most restrictive result** across all per-role evaluations wins: `deny > escalate > assess > allow`. This ensures that a tool like `move_file` (with `read-path`, `write-path`, and `delete-path` roles) is denied if any single role triggers a deny, even if the other roles would allow. An `assess` rule allows subject to the opt-in outbound content assessment; the pipeline turns every compiled allow that can match an outbound-channel tool into `assess` after compilation (see [outbound-content-assessment.md](outbound-content-assessment.md)).

7. For each rule in `compiledPolicy.rules` (in order):
   a. Check `if.roles` -- does the tool have any argument with a matching role?
   b. Check `if.server` -- does the server match?
   c. Check `if.tool` -- does the tool name match?
   d. If `if.paths` present:
   - Extract paths from `request.arguments` where any of the argument's annotated roles appears in `paths.roles` (values as in step 1).
   - If zero paths extracted, condition not satisfied, rule does not match.
   - Use each extracted path's resolution from this evaluation (step 2) and the `paths.within` directory resolved when the engine was built. A `within` directory that does not exist yet keeps the deepest-existing-ancestor resolution: created later as a plain directory it resolves to the same path, while a symlink created there later is not followed.
   - Evaluate: true if ALL resolved paths are within `paths.within` directory.
     f. If all conditions met, return this rule's decision (`assess` returns an allow that requires the outbound content assessment). An outcome other than `allow`, `assess`, `escalate` or `deny` is returned as `deny` under the rule's name (fail closed).
8. No rule matched, return `{ decision: 'deny', rule: 'default-deny', reason: 'No matching policy rule' }`.

**Load-time validation.** The runtime loaders (`loadGeneratedPolicy`, `loadPersonaPolicyArtifacts` in `src/config/index.ts`) parse `compiled-policy.json`, `dynamic-lists.json` and `tool-annotations.json` through the schemas in `src/types/policy-schema.ts` rather than casting them. Rule and condition objects are strict: an unknown key (a misspelled `tools`, or a field an older version wrote such as `sideEffects`) is an error, because an ignored condition would widen the rule. `then` must be `allow`, `assess`, `escalate` or `deny`; argument roles must be registered; `paths.within` must be absolute or `~`-relative; and an allow, assess or escalate rule must not have a catch-all condition (an empty `lists` array counts as none). A failure throws `PolicyArtifactError` (`code: 'POLICY_ARTIFACT_INVALID'`) listing the file and each offending field; sessions do not start and a policy hot-swap keeps the current engine. `ironcurtain doctor` reports the same errors.

### 7. Structural Invariants -- Hardcoded, Never Compiled

The architecture document states that structural invariants are "hardcoded, never overridden." They form the trust foundation that makes all other policy compilation trustworthy.

**What structural invariants enforce:**

- The agent cannot access protected paths in any way -- reads, writes, and deletes are all denied. The check extracts ALL path-bearing arguments (including read-path), not just writes and deletes, and every string value inside an argument that holds a nested object or array (object keys are not read; such a call always goes to a human, see below).
- Unknown tools (no annotation) are denied.
- An agent with a read-only workspace cannot write, delete or rewrite git history anywhere outside its writable directories, nor change a local git repository, whatever the compiled rules allow (step 3a). A push, a remote side effect, stays with the compiled rules.
- A role-bearing argument whose value is not a string, a number or a flat list of them is never decided by the values extracted from it alone: the call escalates to a human (`structural-nested-argument-escalate`) unless a structural or compiled deny applies.

**Protected paths** are concrete filesystem paths (not substring patterns) passed to the `PolicyEngine` constructor as `protectedPaths: string[]`.

For the current system, protected paths include:

- The constitution file (e.g., `src/config/constitution.md`)
- The generated policy directory (e.g., `src/config/generated/`) -- directory: everything within is protected
- The MCP server configuration (e.g., `src/config/mcp-servers.json`)
- The audit log file path (from `AUDIT_LOG_PATH` config)
- The credential files IronCurtain loads (`$IRONCURTAIN_HOME/.env` and an explicit `--env-file` / `IRONCURTAIN_ENV_FILE`) and the host credential stores (`src/config/credential-stores.ts`). A `.env` in the working directory is never loaded (`src/config/trusted-env.ts`), so it is not listed.

**Why paths, not patterns:** The previous `PROTECTED_PATTERNS` used substring matching (`p.includes('constitution.md')`), which is both over-broad (blocks a sandbox file named `my-constitution.md-notes`) and under-specific (doesn't protect by location, only by name). Protected paths use path comparison and directory containment on canonical paths (`resolveRealPath()`: symlinks followed, and on macOS the on-disk spelling of existing components). A path is protected if it equals a protected path or is contained within a protected directory.

**How the match is made** (`src/trusted-process/protected-paths.ts`):

- _Spelling-insensitive, deny side only._ Both sides are compared after folding: default-ignorable code points removed, Unicode NFC, full case folding. On case- or normalization-insensitive volumes (macOS, WSL `/mnt/c`, Linux casefold directories, exFAT), and through the filesystem MCP server's own NFC matching on any volume, `.ENV` or an NFD spelling of an accented directory reaches the protected file. Folding is applied on every volume; on case-sensitive volumes it only over-denies. A leaf that does not exist yet is compared as the canonical deepest existing ancestor plus the remaining components. Allow-side checks (sandbox containment, `paths.within`, whitelist directories) compare canonical paths exactly, because folding them would widen access on case-sensitive volumes.
- _Per-entry sandbox exemption._ The sandbox (`allowedDirectory`) may live inside a protected entry, as `~/.ironcurtain/sessions/<id>/sandbox` lives inside `~/.ironcurtain/`. An entry that strictly contains the sandbox does not cover paths inside the sandbox (compared exactly). An entry equal to or inside the sandbox stays protected, so a `--workspace` that holds an explicit `--env-file`, a host credential store (`~/.claude/.credentials.json` under a `~/.claude` workspace) or a checkout's policy files cannot be used to read or rewrite them through policy-mediated tools. (Docker Agent Mode bind-mounts the workspace, so the engine cannot protect files inside it there.)
- _Fail closed._ If no ancestor of a path can be canonicalized, `resolveRealPath()` throws and the call is denied (`structural-unresolvable-path`) instead of being evaluated in the caller's unresolved spelling.

**Where protected paths come from:** They are derived from system configuration at `PolicyEngine` construction time -- the config already knows the constitution path, the generated directory path, the MCP servers config path, and the audit log path. These are not compiled by the LLM and are not stored in `compiled-policy.json`. The engine canonicalizes the entries again at every evaluation (once per evaluation, however many paths the call has) rather than once at construction: an entry is matched by what it names when the call is made, so a protected name that becomes a symlink later (a `.env` created after start-up, a credential directory replaced by a link) protects its new target.

**Interaction with compiled rules:** The structural invariant check runs first. If a request touches a protected path, it is denied before any compiled rule is evaluated. The compiler prompt explicitly instructs the LLM to NOT generate rules for protected path checking, as the hardcoded layer handles it.

**Security property:** Even if `compiled-policy.json` is corrupted or adversarially crafted, the structural invariants still protect the system's core files. The compiled rules can only make policy decisions about non-protected resources.

### 8. CLI Command (`src/pipeline/compile.ts`)

Entry point for `ironcurtain compile-policy`. Orchestrates the full pipeline:

```
1.  Load config (mcp-servers.json: the package's servers with the user's ~/.ironcurtain/mcp-servers.json layered over them, see user-mcp-servers.md; constitution.md, directory paths, protected paths)
2.  Connect to each MCP server, list tools
3.  For each server: annotateTools() -> ToolAnnotation[]
    - Write tool-annotations.json immediately (for inspection/caching even if later steps fail)
4.  Validate annotations against heuristic (flag potential paths not annotated with roles)
5.  compileConstitution(constitution, annotations, config) -> CompiledRule[]
    - Write compiled-policy.json immediately
6.  Load mandatory handwritten scenarios
7.  generateScenarios(constitution, annotations, handwrittenScenarios) -> TestScenario[]
    - Write test-scenarios.json immediately
8.  verifyPolicy(constitution, rules, annotations, protectedPaths, scenarios) -> VerificationResult
    - Instantiate real PolicyEngine
    - Execute scenarios, collect results
    - LLM judge analyzes results (up to 3 rounds)
9.  Print summary (rules count, scenarios tested, verification rounds)
10. If verification fails:
    - Print diagnostics (which scenarios failed, why, LLM analysis)
    - Exit with code 1 (artifacts remain on disk for inspection and caching)
11. Disconnect MCP servers, clean up
```

Artifacts are always written to disk as each pipeline step completes, regardless of whether subsequent steps (including verification) succeed. This serves two purposes: (1) artifacts are available for human inspection even when verification fails, and (2) the content-hash caching system (see Section 9) can skip expensive LLM calls on re-runs when inputs haven't changed.

All LLM interactions are logged to `src/config/generated/llm-interactions.jsonl` via AI SDK middleware (`src/pipeline/llm-logger.ts`). Each entry records the step name, model ID, prompt, response, token usage, and duration.

**Development vs published usage:**

```bash
# During development
npm run compile-policy

# When published as a package
npx @provos/ironcurtain compile-policy
```

**Security invariant:** The `src/config/generated/` directory must NOT overlap with any directory permitted by the compiled policy (e.g., the sandbox directory). This is validated at startup. The sandbox defaults to `/tmp/ironcurtain-sandbox`; the generated config lives in the source tree. This is also enforced by the structural invariants (protected paths).

## File Layout

```
src/pipeline/
  compile.ts                  # CLI entry point
  tool-annotator.ts           # Step 2: LLM annotates tools
  constitution-compiler.ts    # Step 3: LLM compiles rules
  scenario-generator.ts       # Step 4: LLM generates test scenarios
  policy-verifier.ts          # Step 5: real engine execution + LLM judge
  types.ts                    # Shared types (ToolAnnotation, CompiledRule, etc.)
  handwritten-scenarios.ts    # Mandatory test scenarios from existing tests
  llm-logger.ts               # AI SDK middleware for LLM interaction logging

src/config/
  constitution.md             # (existing) English-language principles
  mcp-servers.json            # (existing) built-in MCP server definitions (users add theirs in ~/.ironcurtain/mcp-servers.json)
  generated/                  # Output of compile-policy command
    tool-annotations.json
    compiled-policy.json
    test-scenarios.json
    llm-interactions.jsonl    # LLM call log (not checked in, covered by .gitignore)

src/trusted-process/
  policy-engine.ts            # Refactored: structural invariants + compiled rules
  policy-types.ts             # Updated: declarative rule types
```

### 9. Content-Hash Caching

Each pipeline artifact includes an `inputHash` field that captures a SHA-256 hash of all inputs that produced it (including the LLM prompt text). On subsequent runs, the CLI loads existing artifacts via the generic `loadExistingArtifact<T>()` loader and compares the stored `inputHash` against the freshly computed hash. If they match, the LLM call is skipped entirely and the cached artifact is reused.

The hash computation includes the prompt text itself (via exported prompt builders `buildAnnotationPrompt`, `buildCompilerPrompt`, `buildGeneratorPrompt`), ensuring that prompt changes invalidate the cache.

**Per-artifact hashing:**

- **Tool annotations:** Hash of `serverName + JSON(tools) + annotationPrompt`. Stored per server in `ToolAnnotationsFile.servers[name].inputHash`.
- **Compiled policy:** Hash of `constitutionText + JSON(annotations) + JSON(config) + compilerPrompt`. Stored in `CompiledPolicyFile.inputHash`.
- **Test scenarios:** Hash of `generatorPrompt + constitutionText + JSON(annotations) + JSON(handwrittenScenarios) + JSON(config) + JSON(protectedPaths)`. Stored in `TestScenariosFile.inputHash`.

This is a lightweight alternative to a full incremental recompilation system -- it simply skips the LLM call when nothing has changed, but always reruns verification.

> **Current state.** Compilation is per server now, and the per-server cache serves only rules that passed verification. Its key is split into the compiler inputs (including the hand-bumped `POLICY_COMPILER_EPOCH`), a digest of the verified rules, and the scenario inputs of the final rules: a scenario-only change re-verifies the cached rules instead of recompiling them. The policy model and verifier version are recorded per server and only warn on a cache hit (`compile-policy --force` rebuilds). Every compiled policy carries a `provenance` block that loaders compare with the running IronCurtain. See [per-server-policy-compilation.md](per-server-policy-compilation.md) ("Split Cache Key", "Policy Provenance").

## Testing Strategy

Each pipeline component is independently testable:

- **Tool Annotator tests:** Provide mock tool schemas, mock LLM returning canned responses, verify annotations have correct side-effect flags and argument roles (including multi-role args like move source). Test the compile-time heuristic validator catches unannotated path arguments.
- **Constitution Compiler tests:** Provide constitution + annotations, mock LLM, verify compiled rules cover expected cases. Assert that structural invariant rules are NOT present in output. Verify the `principle` field links back to the constitution.
- **Scenario Generator tests:** Provide constitution + annotations + handwritten scenarios, mock LLM, verify output includes both generated and handwritten scenarios with valid structure.
- **Policy Verifier tests:** Provide known-good and known-bad rule sets. For known-bad rules (e.g., missing delete denial), verify that executing scenarios against the real engine produces failures and the verifier reports them.
- **PolicyEngine tests -- structural invariants:** Directly test that protected paths are denied regardless of compiled rules. Test with an empty compiled rule set to confirm invariants work standalone.
- **PolicyEngine tests -- compiled rules:** Load compiled artifacts, run existing test cases. Test zero-path-extraction behavior (side-effect-free tools). Test unknown tools (no annotation, deny). Test path traversal attacks.
- **PolicyEngine tests -- move matrix:** Test all four permutations (sandbox-to-sandbox, sandbox-to-external, external-to-sandbox, external-to-external) -- all denied via `deny-delete-operations` rule because `move_file`'s source has a `delete-path` role.

**Integration test:** Run the full pipeline against the filesystem MCP server with a real LLM and verify the compiled policy produces identical decisions to the current hardcoded policy for all existing test cases in `policy-engine.test.ts`.

## Tracer Bullet Scope

**In scope:**

- All five pipeline stages (annotator, compiler, scenario generator, verifier with real engine execution, CLI command).
- Structural invariants with protected paths (replacing PROTECTED_PATTERNS).
- Declarative PolicyEngine with if/then rules replacing hardcoded rules.
- Side-effect annotations on tools.
- Multi-role argument annotations (move source = read-path + delete-path).
- Mandatory handwritten scenarios.
- Multi-round verifier (capped at 3 rounds).
- Compile-time heuristic validation of annotations.
- Filesystem MCP server only.
- Existing tests adapted to pass with compiled policy.

**Deferred:**

- Non-filesystem MCPs (Gmail, Slack, Calendar) -- the design supports them, but tracer bullet only exercises filesystem.
- Per-task policy layer -- future enhancement on top of compiled constitution policy.
- LLM assessment rules (semantic checks like PII detection). The `assess` outcome now exists for outbound content (deterministic encoded-data checks, opt-in, plus an optional LLM intelligibility check; see [outbound-content-assessment.md](outbound-content-assessment.md)); other semantic checks are still deferred.
- Retry loop feeding verifier failures back to the compiler for re-compilation.
- Full incremental recompilation -- content-hash caching skips unchanged LLM calls, but does not support partial recompilation of individual rules.
- Runtime constitution hash verification -- generated files record the hash; runtime check is deferred.

## Resolved Design Decisions

1. **Heuristic fallback:** Compile-time validation only (not runtime). The annotator's output is checked against the heuristic during `compile-policy`. The structural invariants use both heuristic and role-based extraction as defense-in-depth for protected path checks. Compiled rules trust annotations.

2. **Move semantics:** The `source` argument of `move_file` carries `["read-path", "delete-path"]` roles. All moves are denied by the blanket `deny-delete-operations` rule (which matches on `roles: ["delete-path"]`). No separate move-specific rules are needed. This prevents the move tool from being used as a backdoor around delete policies.

3. **Verifier executes real engine:** The verifier instantiates the actual PolicyEngine and runs scenarios through it. The LLM judge analyzes execution results rather than simulating rule evaluation. Multi-round: the LLM can generate additional probe scenarios, capped at 3 rounds.

4. **Policy format:** Predicate rules with `if`/`then` structure. Links each rule to a constitution `principle`. Easier to read than match/pathConstraint while maintaining the same expressiveness.

5. **Protected paths, not patterns:** Structural invariants use concrete filesystem paths and directory containment, not substring matching. Derived from system configuration at construction time.

6. **Concrete paths in compiled rules:** `PathCondition` uses `within: "/absolute/path"` with concrete directory paths, not abstract labels like `sandbox` or `external`. The compiler resolves directory names from the constitution (e.g., "sandbox directory," "documents folder") to concrete paths using system configuration. This means compiled policies are environment-specific; changing paths requires recompilation. The `CompiledPolicyFile` has no `allowedDirectory` field -- each rule carries its own path. "Outside" semantics are handled by rule ordering: the `within` rule matches the inside case, and the fallthrough rule catches everything else.

## Open Considerations

### Adversarial tool descriptions

An MCP tool could have a description designed to mislead the annotation LLM. Example: a tool that deletes files but describes itself as "safely archives data for later retrieval."

For the tracer bullet, not a concern -- we control the filesystem MCP server. Future mitigations:

- Human review of annotations before acceptance.
- Annotation verifier that cross-checks descriptions against observed behavior.
- Treating new MCP server onboarding as a security boundary requiring explicit human approval.

### Determinism and reproducibility

LLM outputs are non-deterministic. Two runs of `compile-policy` with the same inputs may produce different rules. The verifier with real engine execution provides a strong safety net, and the persistent files mean we only accept a compilation that passes verification.

Future improvements: temperature=0, seed parameters, structured output constraints. Content-hash caching is implemented (see Section 9), so unchanged inputs skip LLM calls on re-runs.
