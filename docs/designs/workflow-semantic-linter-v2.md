# Workflow Semantic Linter — Revised Design (v2)

**Status (2026-11-14):** Implemented (`src/workflow/lint.ts`, `ironcurtain workflow lint`). The catalog has grown: this doc covers WF001 to WF007 (WF005 since retired) and WF016 to WF020; WF008 and WF010 to WF015 are described in `lint.ts`, and WF009 is retired.

## Why a revision

The v1 design was correct in shape (pure `lint.ts` module, `LintContext`
injection, `Diagnostic` model, separate from `validateSemantics()`, pre-flight
on `start`/`resume`) but the check catalog was partly wrong: several checks
were either already enforced by Zod, dead on well-formed input, or produced
false positives on real workflows in the repo (notably
`vuln-discovery.yaml`'s orchestrator-hub pattern). The integration story
also skipped the daemon/web UI path entirely.

This revision keeps the architecture and replaces the catalog, integration
points, and rollout plan.

## Architectural pieces retained from v1

These were sound and survive unchanged. They are listed here so the
implementation can be done straight off this document without re-reading v1.

- **`src/workflow/lint.ts`** is a pure, side-effect-free module. It does
  not call `validateDefinition()` — it receives an already-validated
  `WorkflowDefinition` as input. It never reads files or the filesystem
  directly; anything external comes through `LintContext`.
- **`LintContext`** is the seam for injecting external facts. Lint code
  asks the context ("does this persona exist?", "is this guard registered?")
  rather than calling modules directly. Unit tests pass a stub context.
- **`Diagnostic`** is the output model: a plain record. No exceptions.
  The linter produces a list; callers decide what to do with it.
- **`validateSemantics()` is NOT touched.** Anything that would duplicate
  or compete with an existing hard error in `validate.ts` is either (a)
  moved into `validateSemantics()` as a new hard error or (b) dropped.
  The linter is strictly for higher-level semantic smells that are
  non-fatal, cross-cutting, or require external context.
- **CLI: `ironcurtain workflow lint <name-or-path>`** — new subcommand.
- **Pre-flight integration on `start` and `resume`** (but not `inspect`;
  see below).

## Core types (for reference, not code)

    interface Diagnostic {
      code: 'WF001' | 'WF002' | ...;   // stable, starting at WF001 with no gaps
      severity: 'error' | 'warning';
      message: string;                  // what, and where
      stateId?: string;                 // populated when applicable
      hint?: string;                    // suggested fix, optional
    }

    interface LintContext {
      personaExists(name: string): boolean;   // false for GLOBAL_PERSONA is expected
      // Room to grow: mcpServerExists, guardExists, etc.
      // But note: guard existence is already checked by validateSemantics
      // via REGISTERED_GUARDS, so we do NOT duplicate it here.
    }

    function lintWorkflow(def: WorkflowDefinition, ctx: LintContext): Diagnostic[];

The function is pure: same definition + same context => same diagnostics.

## Check catalog (v1 shipping set)

Numbered WF001–WF007, no gaps. Reserved-code debt is not worth carrying for
a PoC — if a check is dropped later we renumber and bump a minor version.
Each check states (a) what it catches, (b) severity, (c) false-positive
risk, (d) whether it needs `LintContext` (external fact).

### WF001 — State can't reach any terminal

**What:** For each reachable non-terminal state, walk its forward transition
graph; if no terminal state is reachable from it, flag it.

**Severity:** error. A reachable state that can't reach a terminal is a
guaranteed infinite loop or dead-end at runtime.

**False-positive risk:** low. Human-gate `ABORT` transitions typically route
to a terminal `aborted` state; the only way to fail this check is to
genuinely be stuck. Cycles that eventually exit via a guard/verdict/event
to a terminal still pass, because reachability is over the union of all
transition targets, not a single path.

**External context needed:** no. Pure graph analysis over
`findReachableStates()` + per-state reachability to terminals.

**Note:** This subsumes what v1 called "WF002 (dead-end non-terminal)"
without the flaw the reviewer pointed out: we don't look for states with
no transitions (Zod rejects that), we look for states whose entire forward
cone contains no terminal.

### WF002 — `unversionedArtifacts` entry not produced by any state

**What:** Every entry in `settings.unversionedArtifacts` should appear in
some state's `outputs:`. If not, it's almost certainly a typo or a rename
that didn't propagate — the artifact is silently versioned contrary to
intent.

**Severity:** warning. Nothing crashes; the file is just versioned.

**False-positive risk:** low. The only legitimate case would be an
"artifact" that some out-of-band tool drops into the workspace — not
worth breaking the check for.

**External context needed:** no. Uses `collectOutputArtifacts()`.

### WF003 — `terminal.outputs` entry not produced by any reachable state

**What:** Every entry in a terminal's `outputs:` list should correspond to
an artifact produced by some reachable state. Unreachable producers don't
count (they won't run).

**Severity:** warning.

**False-positive risk:** low. Same reasoning as WF002.

**External context needed:** no.

### WF004 — Human-gate `present:` entry not produced by any reachable state

**What:** Every entry in a `human_gate` state's `present:` list must
match an artifact produced by a reachable state. A typo here is silent
and destructive: the gate renders with nothing to review, and the human
approves blind.

**Severity:** error. This is the highest-value check after reachability
because the failure mode is "humans approve without seeing the thing they
think they're approving." It is cheap (string comparison against the
output-artifact set) and has essentially no false positives. It belongs
in v1 despite not being in the reviewer's catalog — the reviewer listed
it as "missing but worth adding," and I agree it clears the bar.

**External context needed:** no.

### WF005 — `parallelKey` + `worktree: true` without `settings.gitRepoPath`

> **Retired.** The `parallelKey` field was removed and git worktrees were
> never wired into the runtime, so this precondition can no longer fire and
> the code must not be reused. `worktree` and `settings.gitRepoPath` are now
> reported as ignored fields by WF017 (below).

**What:** If any agent state has `parallelKey` set AND `worktree: true`,
the workflow requires `settings.gitRepoPath`. Without it, worktree creation
fails at runtime. (The reviewer correctly pointed out that the v1 check
confused `mode: docker` with worktree — worktrees are orthogonal to mode.)

**Severity:** error.

**False-positive risk:** none. Straight preconditional check.

**External context needed:** no.

### WF006 — `maxRounds` set without any `isRoundLimitReached` guard

**What:** If `settings.maxRounds` is set but no transition in any agent
or deterministic state uses the `isRoundLimitReached` guard, the limit
is silently ignored. Inverse is also suspicious (guard used without
`maxRounds`), but that is enforced at runtime by the guard implementation
reading `context.maxRounds` — treat only the first direction as a
warning here.

**Severity:** warning.

**False-positive risk:** low. Edge case: a workflow that sets
`maxRounds` purely to surface it in `workflow inspect` status. Acceptable.

**External context needed:** no. Guard names are in the definition;
`REGISTERED_GUARDS` is a module constant but we don't even need it for
this check — we just grep transitions for the literal guard name.

**Disagreement with reviewer:** the reviewer listed this as "missing worth
adding" with both directions. I am including only the forward direction
because the reverse (guard without `maxRounds`) has a well-defined runtime
failure (the guard reads `undefined` and returns `false`, which is
observable and harmless — the loop just never exits on rounds). The forward
direction is the silent one.

### WF007 — Persona not `GLOBAL_PERSONA` and not a directory under `getPersonasDir()`

**What:** For each agent state, if `persona !== GLOBAL_PERSONA` and the
persona directory does not exist, flag it. `GLOBAL_PERSONA` (`'global'`,
see `src/workflow/types.ts:22`) is a reserved alias and must NOT warn
(both bundled workflows use it — `vuln-discovery.yaml` and
`design-and-code.yaml`).

**Severity:** error at runtime (the session factory will fail), but we
emit `warning` because personas are user-installed and the workflow
author may legitimately ship a workflow that depends on a persona the
user hasn't installed yet. An error with `--strict-lint` becomes fatal.

**False-positive risk:** medium. This is the only check that depends on
user-local state. It is the reason `LintContext.personaExists()` exists:
tests don't touch the real filesystem, and the web UI could in principle
ask the daemon's persona manager instead of stat-ing directly.

**External context needed:** yes (via `LintContext`).

## Later additions: fields that validate but do nothing (WF016–WF018)

`validateSemantics` rejects silent no-ops where it can, but some fields
must keep loading for backward compatibility or describe a feature that is
only partly built. These warnings make sure an author does not rely on
them. Messages name the field only and never echo the author's values
(paths, commands, resource strings). The WF014 suppression for a
self-loopable fan-out child now requires the same effective cap that WF016
checks, so a bare `maxVisits` no longer silences it. (WF015, the warning on
`host: true` deterministic states, is a different concern; see
`deterministic-in-container-execution.md`.)

### WF016 — visit cap that is never checked

**What:** `maxVisits` is read only by the `isStateVisitLimitReached` guard
on the same state's transitions, and only for a plain agent state. Warn on
`maxVisits` without such a transition, on `maxVisits` on a fan-out parent
(fan-out states count no visits), and on an `isStateVisitLimitReached`
transition on a state without `maxVisits` (the guard is always false).
Ordering of a wired cap stays WF008's job.

**Severity:** warning. **False-positive risk:** none; each case is dead
configuration.

### WF017 — legacy fields that are accepted but ignored

**What:** `settings.gitRepoPath`, agent `worktree` and terminal `cleanup`
validate (existing manifests must still load) but nothing reads them: no
git worktree is created, and terminal cleanup commands never run.

**Severity:** warning. **False-positive risk:** none.

### WF018 — lane scheduling metadata without a scheduler

**What:** `schedule` (pool) and `schedule.resources` are metadata for the
evaluation-slot pool (fan-out Phase 8), which does not exist yet. Warn on
each separately: the pool is ignored, and resource requests are not
enforced (all lanes share the workflow container's CPU and memory). Retire
or narrow this code when the pool lands.

**Severity:** warning. **False-positive risk:** none until the pool exists.

## Later addition: fan-out width (WF019)

### WF019 — fan-out wider than the default resource envelope

**What:** validation caps a fan-out at `MAX_FAN_OUT_LANES` (16) lanes
(`settings.workers` and a numeric `fanOut.count`); below that cap the
width is legal but costly. Warn on a fan-out state whose resolved lane
count exceeds `FAN_OUT_LANES_WARNING_THRESHOLD` (4, `lane-template.ts`).
In shared-container mode every lane is an agent process under the one
container's CPU and memory ceiling (`dockerResources`, default 4 CPUs /
8 GB), so extra lanes contend instead of overlapping; otherwise each lane
is its own agent session and takes one of the `maxConcurrentAgentSessions`
slots (default 4), so extra lanes wait. The hint says to cap `workers` to
the container's CPU and RAM budget or raise both settings.

**Severity:** warning. **False-positive risk:** low; a host configured
with larger `dockerResources` and `maxConcurrentAgentSessions` can run
more lanes, and the warning is advisory there.

## Later addition: model provider vs. agent harness (WF020)

### WF020 — explicit model provider the state's harness does not call

**What:** a Docker-mode agent state runs on its own `dockerAgent`, else
`settings.dockerAgent`, else `claude-code` (`agent-harness.ts`). Warn when
the state's effective model (`model`, else `settings.model`) carries an
explicit `provider:` prefix that the harness's own client does not call:
Claude Code calls Anthropic, Codex calls OpenAI. The typical case is a
state moved to another harness (`dockerAgent: codex`) that still inherits
the workflow's Anthropic model, which otherwise fails only when the state's
first turn runs. Bare model names carry no provider and are not checked.
Goose is never flagged (it calls whichever provider `gooseProvider` selects
in the user's config, which the linter cannot see), and neither is builtin
mode, which runs no harness. An unknown harness name is a validation error
(`DOCKER_AGENTS`), so it has no lint code.

**Severity:** warning. **False-positive risk:** low; a gateway provider
profile (OpenRouter, say) can serve another provider's models to any
harness, and the hint says to ignore the warning there.

## What's deliberately NOT in v1

These were in v1 or in the reviewer's catalog and are intentionally
dropped or deferred:

- **Verdict routing symmetry (v1 WF003):** dropped entirely. The
  orchestrator-hub pattern in `vuln-discovery.yaml` is a legitimate
  design where an orchestrator emits N verdicts that downstream states
  consume once. Any symmetry-based heuristic floods this file with false
  positives. If a future check wants to flag "verdict declared but never
  consumed downstream," that requires data-flow analysis and is not a
  v1 item.

- **Unknown model ID (v1 WF004):** dropped. `qualifiedModelId` in
  `src/config/user-config.ts:64-85` already runs as a Zod refinement on
  both `agentStateSchema.model` and `workflowSettingsSchema.model`.
  `validateDefinition()` throws before lint runs. Dead code.

- **Guard on human-gate transition (v1 WF010):** dropped.
  `humanGateTransitionSchema` only allows `{to, event}` — Zod rejects
  the shape. Structurally impossible.

- **Unknown guard name:** already enforced by `validateSemantics()` via
  `REGISTERED_GUARDS` in `validate.ts:272-274`. Not a lint concern.

- **Inputs `?` typo check:** tempting, but there's no way to distinguish
  a typo from a legitimately-missing-yet-optional artifact without
  knowing the author's intent. The existing hard error in
  `validateArtifactInputs()` catches the important case (required input
  not produced). Skip.

- **Mode mismatches (v1 WF009):** collapsed into WF005, which is the
  real underlying check.

## Integration

### CLI

Add `workflow lint` subcommand to `src/workflow/workflow-command.ts`:

    ironcurtain workflow lint <name-or-path> [--strict]

Output: one diagnostic per line (code, severity, state, message). Exit
code: 0 if no diagnostics or only warnings, 1 if any error, 2 if `--strict`
and any warning.

### Pre-flight on `start` and `resume`

In `runStart()` and `runResume()` inside `workflow-command.ts`, after
`resolveWorkflowPath()` / `parseDefinitionFile()` and before
`orchestrator.start()` / `orchestrator.resume()`:

1. Parse + `validateDefinition()` (already happens via discovery).
2. Build a real `LintContext` (personas check via `existsSync` on
   `getPersonaDir(name)`).
3. Call `lintWorkflow()`.
4. Print warnings to stderr; print errors to stderr and exit 1 unless
   `--no-lint` is passed; exit 1 on any warning if `--strict-lint` is
   passed.

New flags for `start` and `resume` (only — `inspect` gets neither):

- `--no-lint` — skip linting entirely. Escape hatch for the case where
  a known-good workflow hits a linter bug.
- `--strict-lint` — treat warnings as errors.

### Daemon / JSON-RPC path

This is the integration gap v1 missed. Workflows started via
`workflows.start` in `src/web-ui/dispatch/workflow-dispatch.ts:134-138`
currently go straight to `controller.start(definitionPath, ...)`, which
calls `validateDefinition()` but never lints. The fix is a small shared
wrapper:

**New function in `workflow-command.ts` (or extracted to
`src/workflow/lint-integration.ts` if we want to keep CLI code slim):**

    function preflightLint(
      definition: WorkflowDefinition,
      mode: 'strict' | 'warn' | 'off'
    ): { ok: boolean; diagnostics: Diagnostic[] };

Both call sites use it:

- CLI `runStart` / `runResume` — builds mode from `--no-lint` /
  `--strict-lint`, prints diagnostics, exits on failure.
- JSON-RPC `workflows.start` handler — always runs with mode `'warn'`
  (never exits the daemon); on error-severity diagnostics throws
  `RpcError('LINT_FAILED', ...)` carrying the diagnostic list so the
  web UI can render it. Later, a `strict` setting per-workflow or per-daemon
  can be added.

Where does the daemon call it? Inside the `workflows.start` case, after
loading and validating the definition, before
`controller.start(definitionPath, ...)`. The controller call takes a
`definitionPath`, so the daemon needs to parse+validate the file once
here for linting (it's not currently done — the controller does it
internally). That's fine: `parseDefinitionFile()` +
`validateDefinition()` is cheap and idempotent.

**`workflows.resume` does NOT lint.** The definition that runs is
whatever was checkpointed, which may predate current lint rules. Running
the linter against stale YAML would produce noise the user can't act on
without unblocking the resume. (This matches the CLI's `inspect`
exclusion.)

**`workflows.inspect` / CLI `workflow inspect` do NOT lint.** Same
reason: it's a read-only introspection tool on checkpointed state.

### Where `listPersonas()` lives

The linter needs to know whether a persona directory exists. The v1
design claimed a `listPersonas()` function existed — it doesn't. Two
options:

1. **Minimal addition:** add a single-persona check to
   `src/persona/resolve.ts`:

        /** Returns true iff a persona directory exists on disk. */
        export function personaExists(name: string): boolean;

   Implementation: `existsSync(getPersonaDir(createPersonaName(name)))`.
   Signature takes a plain string because callers (the linter) get raw
   strings from YAML and should not have to brand them.

2. **List-based:** `listPersonas(): string[]` — useful for CLI
   auto-complete later, but overkill for the linter.

I recommend **option 1** for v1. The lint code does one-off checks, not
list iteration. If a future feature needs the full list we add
`listPersonas()` then.

### Exports from `validate.ts`

The linter needs two helpers that are currently private in `validate.ts`:

- `collectOutputArtifacts(states)` — already exists (line 127).
- `findReachableStates(initial, states)` — already exists (line 139).

Both should be exported. Nothing else in `validate.ts` needs to change.
The linter does NOT import `validateSemantics` — it assumes the
definition has already passed.

## Rollout

v1 proposed 4 commits with the CLI + pre-flight in commit 4. That packs
too much risk into the final commit and delays the user-visible payoff.
Split as follows:

**Commit 1 — Core + safe checks + CLI + pre-flight.**
- `lint.ts` with `Diagnostic`, `LintContext`, `lintWorkflow()`.
- Export `collectOutputArtifacts`, `findReachableStates` from
  `validate.ts`.
- Implement WF001–WF006 (all checks that need NO external context).
- CLI `workflow lint` subcommand.
- Pre-flight integration in CLI `start` and `resume` with `--no-lint`
  and `--strict-lint`.
- Unit tests against both bundled workflows (must produce zero errors).

Shipping WF001–WF006 in the first commit delivers user value immediately
and keeps the risky external-context plumbing for later.

**Commit 2 — Persona check (external context).**
- Add `personaExists()` to `src/persona/resolve.ts`.
- Implement WF007 against `LintContext`.
- Wire `LintContext` impl in CLI call sites.

**Commit 3 — Daemon integration.**
- Shared `preflightLint()` helper.
- Call it from `workflows.start` in `workflow-dispatch.ts`.
- Add `LINT_FAILED` RPC error code in `web-ui-types.ts`.
- Web UI surfaces diagnostics (out of scope for backend PR, but the
  error shape must be stable).

**Commit 4 — Polish.**
- Golden-test fixtures with deliberately broken workflows.
- `--format=json` on `workflow lint` for tooling (optional).

Three-commit ship is realistic for a PoC; commit 4 is only if there's
appetite.

## Testing strategy

- **Unit:** `test/workflow/lint.test.ts`. Construct `WorkflowDefinition`
  objects inline, pass a stub `LintContext`, assert exact diagnostic
  lists. No filesystem.
- **Snapshot:** run lint against `design-and-code.yaml` and
  `vuln-discovery.yaml` — must produce zero errors. If a future change
  to either workflow trips a rule, either the workflow is wrong (fix it)
  or the rule is (fix the rule).
- **CLI integration:** small shell test that `ironcurtain workflow lint`
  on a known-bad file exits 1 and prints the expected code.

## Anti-patterns this revision avoids

- **Parallel warning system:** the linter is NOT a mirror of
  `validateSemantics`. If a check belongs in hard validation (like the
  human-gate `acceptedEvents` consistency check), it goes into
  `validateSemantics`. If it's cross-cutting or needs external context,
  it goes into the linter. No duplication.
- **Reserved codes:** no gaps. WF001–WF007, renumber if dropped.
- **Speculative generality in `LintContext`:** only `personaExists()` in
  v1. We add methods when a check needs them.

## Summary of changes vs. v1

| Area | v1 | v2 |
|---|---|---|
| Unknown model ID | WF004 check | Dropped (Zod does it) |
| Verdict routing symmetry | WF003 check | Dropped (false positives) |
| Human-gate guard | WF010 check | Dropped (Zod does it) |
| Dead-end non-terminal | WF002 | Replaced by reach-to-terminal (WF001) |
| Mode mismatch | WF009 | Replaced by WF005 (parallelKey+worktree+gitRepoPath) |
| Persona check | `listPersonas()` (fiction) | `personaExists()` added to resolve.ts |
| `present:` validation | Not in v1 | WF004 (high-value addition) |
| `maxRounds` dead value | Not in v1 | WF006 |
| Daemon integration | Not addressed | `preflightLint()` shared helper |
| `inspect` | Not addressed | Explicitly excluded |
| `--no-lint` | Not in v1 | Added alongside `--strict-lint` |
| Rollout | 4 commits, CLI last | 3 commits, CLI in commit 1 |

## Files touched

- `src/workflow/lint.ts` — new.
- `src/workflow/validate.ts` — export `collectOutputArtifacts`,
  `findReachableStates`. No other changes.
- `src/workflow/workflow-command.ts` — new `lint` subcommand;
  `--no-lint` / `--strict-lint` on `start` and `resume`; shared
  `preflightLint()` helper (or extract to `lint-integration.ts`).
- `src/persona/resolve.ts` — add `personaExists(name: string): boolean`.
- `src/web-ui/dispatch/workflow-dispatch.ts` — call `preflightLint()`
  in `workflows.start`; `LINT_FAILED` error path.
- `src/web-ui/web-ui-types.ts` — add `LINT_FAILED` to RPC error
  codes (if not generic enough to reuse `INVALID_PARAMS`).
- `test/workflow/lint.test.ts` — new.
