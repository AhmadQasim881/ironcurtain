# Workflows

IronCurtain workflows orchestrate multiple AI agents through a state machine to plan, design, implement, and review code autonomously. Each agent runs in a Docker container with IronCurtain's policy engine mediating tool access.

During an interactive run, the web UI shows agent output, artifacts and pending decisions together. Use the CLI commands below for scripting and debugging.

## Quick start (web UI — recommended)

Start the daemon with the web UI enabled and open the printed URL in a browser:

```bash
ironcurtain daemon --web-ui
```

The daemon prints an authenticated URL (e.g., `http://127.0.0.1:7400?token=<TOKEN>`). Open it, click **Workflows** in the sidebar, then **New run**:

- Pick a workflow from the dropdown (bundled definitions plus anything in `~/.ironcurtain/workflows/`).
- Enter a task description.
- Optionally set a workspace path: an existing directory, given as an absolute or `~` path (otherwise the workflow runs in a fresh directory under `~/.ironcurtain/workflow-runs/<id>/workspace/`).
- Optionally override the model.

Follow the run as it progresses: the state-machine graph highlights the current state, the agent-message timeline streams the conversation with markdown rendering, and gate panels appear when human input is needed. Past runs stay listed on the Workflows page once complete. See [Web UI](#web-ui) below for the full feature reference.

## Quick start (CLI — for scripting and debugging)

```bash
# Run the built-in design-and-code workflow on a new project
ironcurtain workflow start design-and-code \
  "Build a TypeScript CLI that converts CSV files to JSON"

# Run it on an existing codebase
ironcurtain workflow start design-and-code \
  "Add rate limiting to the API endpoints" \
  --workspace ~/src/my-api

# Use a cheaper model for experimentation
ironcurtain workflow start design-and-code \
  "Build a palindrome checker" \
  --model anthropic:claude-haiku-4-5
```

## Prerequisites

- Docker running (IronCurtain builds the agent images on first use; `ironcurtain images status` shows them)
- An API key for the agent's provider (`ANTHROPIC_API_KEY` in the environment, in `~/.ironcurtain/.env` or in `~/.ironcurtain/config.json`), or a Claude login for Claude Code
- A compiled policy: the shipped default, or your own (`ironcurtain compile-policy`). Every persona a workflow names must exist and be compiled.

## Resource limits

The **New run** form previews the effective agent limits before execution. The
workflow detail page shows those limits, their source, and the active or most
recent agent session's usage. **Settings → Resource Limits** edits the global
defaults. Settings changes apply to new runs; they do not change an existing
run's saved limits.

Workflows inherit `resourceBudget` from `~/.ironcurtain/config.json`. Override
individual fields in the workflow definition:

```yaml
settings:
  resourceBudget:
    maxEstimatedCostUsd: 20
    maxTotalTokens: 2000000
    maxSteps: 400
    maxSessionSeconds: 7200
    warnThresholdPercent: 80
```

Omitted fields inherit their global value. A positive number sets a limit;
`null` disables that individual limit. Token and step limits must be integers.
The warning threshold is a percentage from 1 through 99. Unknown budget fields
and conflicting values for the legacy `settings.maxSessionSeconds` and the
nested timeout are rejected. The legacy timeout remains supported. A state's
persona may set limits (`ironcurtain persona set`) for any field the workflow does
not set; the run's budget panel still shows the run-level limits.

These are agent limits. In builtin mode, token, step, time, and cost limits apply
per turn. In Docker mode the timeout bounds each turn inside the container (a
timed-out turn fails the state without hard retries), and the token and cost limits
are enforced by the MITM proxy: a shared-container workflow has one token and cost
allowance per container scope, shared by all of its states and fan-out lanes, and
completion requests outside an agent turn (for example from a deterministic
`container: true` step) are refused. The engine also checks cumulative agent
session tokens, steps, and cost before each state's turn and before recovery turns.

**Run-wide ceiling.** `settings.workflowBudget` caps what the whole run may use,
summed over every agent session of every state and lane and carried across
resumes:

```yaml
settings:
  workflowBudget:
    maxTotalTokens: 5000000 # input (cache reads and writes included) plus output
    maxEstimatedCostUsd: 50 # host-derived cost; agent self-reports never count
    maxWallClockSeconds: 14400 # time spent running states (not waiting at gates)
```

An omitted or `null` field sets no ceiling. The ceiling is checked before every
state, batch and fan-out lane step, so a run can overshoot it by at most the step
already running. A breach ends the run as `aborted` with the checkpoint kept: raise
or remove the limit in `<workflow-runs>/<id>/definition.json`, then run
`ironcurtain workflow resume <id>`. In Docker mode the run counts, container by
container, at least what the container's MITM budget gate charged: the gate counts
every completion request, with LLM statistics on or off, and charges a conservative
estimate for usage it could not measure, so a run may stop earlier than its
observed usage alone suggests. `maxTotalTokens` and `maxEstimatedCostUsd` fail
closed: when some session's usage was counted by nothing (neither token tracking
nor a budget gate), the run stops at the next state.

New runs save their effective limits and their source in the checkpoint so
resumed and historical runs can show the settings actually used. Resume keeps
the saved limits by default; the web UI's **Use current resource limits** option
explicitly resolves the run's workflow overrides against current global settings
instead. Older runs without this information are labelled as having an unknown historical budget;
current fallback settings must not be mistaken for the original limits.
Resuming an older run records the current effective limits for the resumed agent
sessions and enables their usage display. This does not reconstruct the original
limits. Subsequent resumes keep the newly saved limits unless current limits are
explicitly selected again.

The run's **Total Tokens** figure is the run-wide total of input, cache and output
tokens over every session, lane and resume, read from the LLM statistics. With
statistics off it reads "Unavailable"; a partly measured total is shown as `≥N`.

The daemon (or a CLI workflow run) keeps at most `maxConcurrentAgentSessions`
workflow agent environments alive at once (default 4; see
[CONFIG.md](CONFIG.md#session-mode-and-docker-agents)). A shared-container run
reserves one slot per container scope; other agent sessions take one slot each
while they live. A run waiting for a slot reports `waiting for a free agent slot`,
and a shared-container workflow with more scopes than the cap is refused at start.

## How workflows work

A workflow is a YAML or JSON file that defines a state machine. Each state is one of:

- **`agent`** -- Runs an AI agent with a role-specific prompt. The agent can read/write files, run commands, and use all available MCP tools. The policy engine controls what's allowed.
- **`human_gate`** -- Pauses execution and asks for your input: approve, request revision, or abort.
- **`deterministic`** -- Runs commands (typecheck, lint, test) without an LLM, in the workflow's container (`container: true`) or, with an explicit acknowledgement, on the host (`host: true`).
- **`terminal`** -- End state (success or aborted).

### Sessions and workspace

Each agent state gets its own session. All sessions share the same workspace directory — files written by one agent are visible to the next. The orchestrator passes the previous agent's handoff to the next agent so it has context about what was done.

Each invocation of an agent state starts a new agent conversation, unless the state sets `freshSession: false`: then a re-invocation of that state resumes the conversation that state had, so the agent keeps its history from earlier rounds. This works for Claude Code, Codex and Goose, within one container bundle.

Different states always get separate conversations — the planner, architect, coder, and critic each have their own history and cannot see each other's internal reasoning. They communicate through the shared workspace and the handoff passed by the orchestrator.

### Shared-container mode (`sharedContainer: true`)

Opt in by setting `settings.sharedContainer: true` in the workflow definition. Instead of each agent state spinning up its own Docker container, proxy, and `ToolCallCoordinator`, the orchestrator builds **one** Docker infrastructure bundle per container scope (`containerScope`, default `primary`) and every state of that scope borrows it. State sessions are constructed with `ownsInfra: false` so `close()` tears down only per-state resources; the bundle is destroyed once when the workflow reaches a terminal state. See [`docs/designs/workflow-container-lifecycle.md`](docs/designs/workflow-container-lifecycle.md) for the full design.

Before each agent state runs, the orchestrator hot-swaps the coordinator's active `PolicyEngine` to match the incoming state's `persona`. The swap is a `POST /__ironcurtain/policy/load` over the bundle's Unix domain control socket; the coordinator reloads `compiled-policy.json` / `tool-annotations.json` / `dynamic-lists.json` from the persona's policy directory under `callMutex` then `policyMutex`, so in-flight tool calls finish against the old engine and new calls use the new engine. Each bundle has one `audit.jsonl`; each entry carries a `persona` field so per-state slices can be reconstructed by scanning.

A container scope is one trust domain: every state in it shares the container, its files and its conversation state. Agent states of different personas in one scope therefore fail validation unless `settings.allowMixedPersonas: true` is set; give states that must stay apart their own `containerScope`. Separate scopes separate containers, but not the shared workspace.

Shared-container workflows run **without persona memory**: the memory server is not available to their states (a notice names the affected personas). Workflows without `sharedContainer`, and builtin workflows, keep per-persona memory.

Snapshot resume is opt-in on top of shared-container mode with `settings.snapshotOnStop: true`. When such a workflow stops in the `aborted` terminal phase, IronCurtain snapshots each live `containerScope` to an immutable local Docker image id (`sha256:...`) and records that digest in the checkpoint. `workflow resume` still prepares the normal agent image and workflow dependency layers, then creates each scope's container from the recorded digest when it still exists and was built from the same agent image. After an IronCurtain upgrade, a pin bump or an `agentCliVersions` change, resume starts fresh containers instead (the workspace and dependency layers carry over). If an operator prunes the snapshot image, resume falls back to a fresh container and keeps the checkpoint resumable. `snapshot.maxBytes` and the free-space check can skip a snapshot ([CONFIG.md](CONFIG.md#session-mode-and-docker-agents)).

A run holding a shared container at a human gate releases it after `settings.gateIdleTimeoutMinutes` (default 240 minutes; `null` means never; at most 20160): the run stops resumably at the gate, with the same gate id and a snapshot when `snapshotOnStop` is set, and the gate is dismissed. Resuming re-raises it.

Deterministic states can opt into this shared bundle with `container: true`.
Those commands run via `docker exec` inside the state's `containerScope`
(default: `primary`) instead of on the host. Workflow packages may
ship a sibling `scripts/` directory; it is staged into the run directory and
mounted read-only at `/workflow-scripts`. If that directory holds a `requirements.txt` or
a `package.json`, their dependencies are installed through the
registry proxy into a shared base (`~/.ironcurtain/workflow-dependency-bases/<key>/`,
built in a short-lived provisioning container that no agent shares and verified by
the host), and each run gets its own writable copy at
`workflow-runs/<id>/deps/<key>/`, mounted at `/opt/workflow-venv` and
`/opt/workflow-node_modules`. Agent installs stay in the run's copy and survive its
resume. `NODE_PATH` is set only for deterministic container execs. Runtime
dependencies need `packageInstall` enabled and are not supported with nested
Docker; `-r`/`-c` includes in `requirements.txt` and `file:` dependencies in
`package.json` are not supported.

### Workflow run layout

Workflow runs live under `~/.ironcurtain/workflow-runs/<workflowId>/`:

```
~/.ironcurtain/workflow-runs/<workflowId>/
  checkpoint.json              # resume point; checkpoint.prev.json is the one before it
  definition.json              # the definition this run uses
  messages.jsonl               # orchestrator message log
  run.lock                     # held by the process executing the run
  workspace/                   # agent workspace (unless --workspace was given)
  deps/<key>/                  # this run's dependency layers (python-venv, node_modules)
  containers/
    <bundleId>/                # one per container scope (shared-container mode)
      audit.jsonl              # coordinator audit log, persona-tagged entries
      bundle/                  # container support files: CA, orientation, system prompt
      captures/                # with --capture-traces (see below)
      states/
        <stateId>.<N>/         # per-invocation session.log and session-metadata.json
```

The bundle's sockets and its policy hot-swap control socket live under `~/.ironcurtain/run/<bundle>/`, which keeps socket paths short. In shared-container mode nothing lands in `~/.ironcurtain/sessions/` for a workflow run; without it, each agent state's session lives under `~/.ironcurtain/sessions/<sessionId>/` as single-session CLI runs (`ironcurtain start`, `mux`, PTY) do. `checkpoint.json` and `definition.json` are written `0600` and carry `schemaVersion` and `writerVersion`; a damaged `checkpoint.json` is replaced by `checkpoint.prev.json` automatically, and a failed checkpoint save appears in the message log with context `checkpoint save`.

When a run is started with `--capture-traces`, verbatim token trajectories are written under the run's container bundle:

```
~/.ironcurtain/workflow-runs/<workflowId>/containers/<bundleId>/captures/
  <sessionId>.jsonl            # one file per agent (FSM-state) session
  manifest.jsonl               # session ordering + per-session persona / fsmState / poison status
```

Each FSM-state session gets its own `<sessionId>.jsonl`; the `manifest.jsonl` is the canonical state→session map. Capture is off by default. See [`TRAJECTORIES.md`](TRAJECTORIES.md) for the format and SFT/RL usage.

`ironcurtain prune` removes workflow runs inactive for 30 days (by default), whatever their final state; its size cap only removes runs that can no longer be resumed, and a run holding its `run.lock` is never removed. Snapshot images of removed runs are reclaimed by the snapshot sweep. See `retention` in [CONFIG.md](CONFIG.md#retention-personas-and-cron).

## The design-and-code workflow

The built-in `design-and-code` workflow follows this flow:

```
plan --> [plan_review] --> design --> [design_review] --> implement --> review
  ^          |               ^            |                  ^          |
  |          |               |            |                  |          |
  +-- revision               +-- revision                    +-- rejected
                                                             |
                                                        [escalate_gate] --> done
```

States in brackets `[...]` are human gates where you review and approve.

**Agents:**

| Role      | What it does                     | Reads                        | Writes                        |
| --------- | -------------------------------- | ---------------------------- | ----------------------------- |
| Planner   | Breaks down the task into steps  | Workspace (if existing code) | `.workflow/plan/plan.md`      |
| Architect | Produces a technical design spec | Plan, workspace              | `.workflow/spec/spec.md`      |
| Coder     | Implements the design            | Plan, spec                   | Code at workspace root        |
| Critic    | Reviews code against the spec    | Spec, code                   | `.workflow/reviews/review.md` |

The coder and critic loop until the critic approves or the round limit is reached: design-and-code sets `settings.maxRounds: 3` (the engine default is 4). Approving the plan and design gates resets those phases' visit counts, so revisions there do not use up the implementation rounds. If the limit is reached, you're asked to intervene. The critic's review state runs read-only (`workspaceAccess: read-only`).

## Workspace layout

```
your-workspace/                  # Workspace root (new or existing repo)
  .workflow/                     # Agent-visible artifacts (gitignored automatically)
    plan/plan.md                 # Planner output
    spec/spec.md                 # Architect output
    reviews/review.md            # Critic output
  src/                           # Code written by the coder
  package.json                   # (or whatever the project needs)
  ...
```

When you provide `--workspace`, the agents work in your existing directory. It must exist, and it goes through the same checks as `ironcurtain start --workspace` (no home directory or its ancestors, nothing inside the IronCurtain home, no protected files); the run uses its canonical path. Workflow artifacts visible to the agents go into `.workflow/` inside the workspace and are automatically added to `.gitignore` (a `.gitignore` that is a symlink, FIFO, hard link or larger than 1 MiB is left unchanged with a warning to add `.workflow/` by hand). Code changes happen at the workspace root alongside your existing files. Run-level bookkeeping (`messages.jsonl`, the audit logs, per-state session logs, and — under `sharedContainer: true` — the shared Docker bundles) lives under `~/.ironcurtain/workflow-runs/<workflowId>/`; see "Workflow run layout" above.

When you don't provide `--workspace`, the orchestrator creates a fresh directory.

Starting or resuming on a reused workspace moves a non-directory or symlink found at `.workflow` or `.workflow/task` aside (to `<name>.ironcurtain-displaced-<random>`) with a warning. `.workflow/task/description.md` is always rewritten, from the checkpoint on resume. A declared output must be a real directory under a real `.workflow` inside the workspace: a symlinked output, or outputs under a symlinked `.workflow`, count as missing, are not presented at gates, and appear in the message log as an error (`security: unsafe artifact output`).

One process runs a run at a time, and one run uses a workspace at a time: the run lock (`run.lock`) and a workspace lock (`~/.ironcurtain/workflow-workspace-locks/`) are held while it executes, and a crashed holder's lock is reclaimed automatically. A run executing in another process is not offered for resume; the web UI marks it "running elsewhere".

## CLI commands

### `ironcurtain workflow list`

List available workflow definitions (bundled and user-defined).

```bash
ironcurtain workflow list
```

### `ironcurtain workflow start`

Start a new workflow. The first argument can be a workflow name (looked up from bundled and user directories) or a path to a definition file (YAML or JSON).

```bash
ironcurtain workflow start <name-or-path> "task description" [options]
```

Options:

- `--model <model>` -- Override the model (e.g., `anthropic:claude-haiku-4-5`)
- `--workspace <path>` -- Use an existing directory instead of creating a new one
- `--task-scoped` -- Compile the task into a scope intersected with each state's policy; calls outside it escalate (not yet available for `workflow run` or the daemon). Resume keeps the scope, and refuses one that no longer validates.
- `--capture-traces` -- Record token trajectories (see [TRAJECTORIES.md](TRAJECTORIES.md))
- `--no-lint` -- Skip the pre-flight lint pass
- `--strict-lint` -- Treat lint warnings as errors

A pre-flight lint pass runs before the workflow starts; error-severity diagnostics abort the start. See [`ironcurtain workflow lint`](#ironcurtain-workflow-lint) for the full check catalog.

After Ctrl-C the run is recorded as `Workflow interrupted by SIGINT`; a snapshot commit gets 15 seconds within the 30-second force-exit window, and a second Ctrl-C exits at once.

Examples:

```bash
ironcurtain workflow start design-and-code "Build a REST API"
ironcurtain workflow start ./my-workflow.yaml "Build a REST API"
ironcurtain workflow start design-and-code "task" --model anthropic:claude-haiku-4-5
```

### `ironcurtain workflow resume`

Resume a failed or interrupted workflow from its last checkpoint through the running daemon. This keeps resumed agent sessions on the daemon's configured model path (including a LiteLLM proxy).

```bash
ironcurtain workflow resume <workflowId|existingBaseDir> [options]
```

Options:

- `--workflow-id <id>` -- Select a workflow when the target is an external base directory
- `--trust` -- Required to import a run from a directory outside the home's `workflow-runs/` whose definition has host deterministic states
- `--ensure-daemon` -- Start a detached daemon if none is running
- `--json` -- Emit machine-readable output

Pass the base directory that holds the run, not the run directory itself (`WORKFLOW_INVALID_BASE_DIR`); select the run with `--workflow-id`. An external run must include its own `definition.json`; a checkpoint-selected original package is not opened. Import copies that definition and validated, real `workflow-skills` and `workflow-scripts` trees into the daemon's run directory and starts containers fresh (no snapshot restore). Workflow ids are 1-128 characters from `[A-Za-z0-9_-]` in every command.

Import refuses an already-present destination run before changing its definition or staged files. An active destination still reports `WORKFLOW_ALREADY_ACTIVE`; an inactive existing destination reports `WORKFLOW_NOT_RESUMABLE` and remains intact.

For the advanced local execution path, use `resume-standalone` explicitly:

```bash
ironcurtain workflow resume-standalone <baseDir> [--state <stateName>] [--model <model>] [--trust]
```

`resume-standalone` retains the local `--state`, `--model`, `--trust`, `--no-lint`, and `--strict-lint` options. It bypasses the daemon and therefore also bypasses daemon model routing.

Standalone resume validates staged resource directories before they are read or mounted. Foreign runs require their local definition copy and cannot recover missing stages from an original package named by the checkpoint. Runs in this home's own `workflow-runs` directory retain original-package recovery. `--trust` permits reviewed host commands; it does not permit foreign package-path recovery or widen staging roots. Staging copies bounded regular files without following links and preserves executable permission.

Resume errors to expect: `WORKFLOW_CHECKPOINT_TOO_NEW` (written by a newer IronCurtain), `WORKFLOW_WORKSPACE_MISSING` (the recorded workspace is gone; resume no longer recreates it, so recreate the directory yourself to continue with an empty workspace), `WORKFLOW_IMPORT_UNTRUSTED` (an import that needs `--trust`), and `WORKFLOW_NOT_RESUMABLE` (for example a custom workspace that became unsafe).

### `ironcurtain workflow inspect`

View the status of a workflow without running it.

```bash
ironcurtain workflow inspect <baseDir> [--all]
```

Shows: workflow ID, current state, artifacts, lint diagnostics on the checkpointed definition, and the last 20 message log entries. Use `--all` for the full log. A run that cannot be read is reported in place (`Could not inspect <id>: ...`) and the others still print. Links in a workspace's `.workflow` are never followed.

Lint output is informational only — it never changes the exit code.

### `ironcurtain workflow watch`

Replay and follow a single workflow's operational message log until it reaches
a terminal outcome:

```bash
ironcurtain workflow watch <workflowId|runDir> [--json] [--since <ISO>] [--events <list>] [--lines <N>]
```

Printed JSONL preserves decoded record values while escaping terminal controls and invisible characters; CR/tab whitespace outside JSON strings is normalized. Stored evidence bytes remain unchanged.

An ID resolves under `~/.ironcurtain/workflow-runs/`; a path must name an
individual existing run directory, not the parent runs directory. By default,
watch prints transitions, verdicts, retries, errors, transient/quota failures,
gates, tool-call escalations, and fan-out joins. Agent prompts (`sent`) are excluded unless selected.

- `--json` -- Emit each selected `messages.jsonl` record as one JSON line on stdout
- `--since <ISO>` -- Include records whose timestamps are at or after the timestamp
- `--events <list>` -- Comma-separated `transition,verdict,retry,error,transient,quota,gate,fanout,sent`, or `all` (tool-call escalations come with `gate`)
- `--lines <N>` -- Print the last N selected records from the log as it existed when invoked, then exit without following

Snapshot mode (`--lines`) exits `0` after writing the selected records and does
not contact or wait for the daemon. In live mode, human gates are reported but do not stop the watch. Exit codes are `0` for
completed, `3` for failed/aborted/interrupted, `130` for Ctrl+C, `2` for usage
errors, and `1` for operational errors. When invoked with an ID, watch uses the
existing daemon's `workflows.get` and lifecycle events only to reconcile status;
the streamed records always come from `messages.jsonl`. A run-directory path is
fully disk-only. Gate resolutions show which channel declared them (`via <channel>`).

### `ironcurtain workflow lint`

Run semantic checks on a workflow definition without executing it. The linter catches cross-cutting issues that structural (Zod) validation doesn't: unreachable states, dangling artifact references, missing personas, and similar smells.

```bash
ironcurtain workflow lint <name-or-path> [--strict]
```

Options:

- `--strict` -- Treat warnings as errors (exit code 2)

Exit codes:

- `0` -- No diagnostics, or warnings only (without `--strict`)
- `1` -- One or more errors
- `2` -- Warnings present and `--strict` was passed

#### Check catalog

| Code    | Severity | Catches                                                                                                                                        |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `WF001` | error    | State cannot reach any terminal — workflow would loop forever if it enters                                                                     |
| `WF002` | warning  | `settings.unversionedArtifacts` entry not produced by any state (silently versioned)                                                           |
| `WF003` | warning  | Terminal `outputs:` entry not produced by any reachable state                                                                                  |
| `WF004` | error    | Human-gate `present:` entry not produced (human would approve blind)                                                                           |
| `WF006` | warning  | `settings.maxRounds` set but no transition uses `isRoundLimitReached` guard (limit silently ignored)                                           |
| `WF007` | warning  | Agent state references a persona not installed locally (runtime failure)                                                                       |
| `WF008` | error    | `maxVisits` state has a cap-guarded transition positioned after a non-approval `when` (cap never fires); exempt when the loop resets the count |
| `WF010` | error    | A state names a workflow skill that does not exist, or a bundled skill's `SKILL.md` frontmatter is invalid                                     |
| `WF011` | warning  | Container deterministic state can run before an agent has populated its container scope                                                        |
| `WF012` | warning  | Deterministic state routes on `when:{verdict}` but declares no `resultFile`                                                                    |
| `WF013` | warning  | Fan-out state with several lanes: `settings.maxRounds` caps batches, so the candidate budget is `maxRounds × workers`                          |
| `WF014` | warning  | Fan-out segment member can loop within the segment without a per-lane cap (`maxVisits` plus an `isStateVisitLimitReached` transition)          |
| `WF015` | warning  | Deterministic state runs workspace code on the host (`host: true`)                                                                             |
| `WF016` | warning  | Visit cap that is never checked: `maxVisits` without an `isStateVisitLimitReached` transition, the reverse, or `maxVisits` on a fan-out parent |
| `WF017` | warning  | Legacy field ignored at runtime: `settings.gitRepoPath`, agent `worktree`, terminal `cleanup`                                                  |
| `WF018` | warning  | Lane scheduling metadata (`schedule`, `schedule.resources`) declared, but lane pools and per-lane resource caps are not implemented            |
| `WF019` | warning  | Fan-out state wider than 4 lanes (validation allows up to 16)                                                                                  |
| `WF020` | warning  | Agent state whose model names a provider its agent harness (`dockerAgent`) does not call natively                                              |

Example:

```bash
ironcurtain workflow lint design-and-code
ironcurtain workflow lint ./my-workflow.yaml --strict
```

When a workflow is started via the daemon/web UI, error-severity diagnostics abort with a `LINT_FAILED` JSON-RPC error carrying the full diagnostic list so the UI can render it inline. Because `WF015` is a warning, `--strict-lint` refuses every workflow with a `host: true` state.

#### Definition-level validation errors

The following checks are enforced during workflow validation before lint runs, so they are reported as `WorkflowValidationError` issues rather than `WF` lint diagnostics:

- Unknown keys under `settings:` (a misspelled setting is an error, not silently dropped)
- `maxVisits`, `dockerAgent`, `workspaceAccess` or `artifactHandoff` declared on a non-agent state, and `host` or `resultFile` on a non-deterministic state
- State ID does not match `^[A-Za-z_][A-Za-z0-9_]*$` (empty, leading digit, or contains `.`/space/`-`)
- A deterministic state that runs commands without `container: true` or `host: true`, or with both
- Deterministic states and guard-only agent states without an unconditional fallback transition (verdict-routed agent states are exempt: the orchestrator reprompts until a declared verdict is committed)
- `settings.workers` or a numeric `fanOut.count` above 16, and the fan-out rules under [Fan-out](#fan-out-parallel-lanes)
- Agent states of different personas in one container scope without `settings.allowMixedPersonas`
- A `dockerAgent` that is not `claude-code`, `goose` or `codex`, and `dockerAgent` on states of a builtin-mode workflow
- A provider prefix in a `model` that is a near miss of a real one (`anthropc:`, `opnai:`)

### `ironcurtain workflow run-state`

Run a single agent state once against a pre-staged artifact directory. Skips the orchestrator, journal, checkpoint, and transition machinery — one agent invocation, one response written to disk. Intended for prompt iteration, A/B comparing models on identical inputs, and reproducing a state's verdict from a real run without replaying the whole workflow.

Declared inputs from `--artifacts` are staged as regular files and real directories, skipping links and special entries. One shared budget limits the copy to 100,000 entries, 64 directory levels and 256 MiB; exceeding it stops before the agent starts. The explicit `--workspace` project layer retains its ordinary project-copy semantics.

```bash
ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir> [options]
```

Options:

- `--artifacts <dir>` -- Required. Directory containing pre-staged artifact subdirs (one per workflow input name)
- `--workspace <dir>` -- Source tree to stage alongside `.workflow/` so the agent can read code
- `--directive <text>` / `--directive-file <path>` -- Inline scoping directive injected as the previous agent's output (synthetic prior state name `debug`)
- `--task <text>` / `--task-file <path>` -- Task description; defaults to `<artifacts>/task/description.md` if present
- `--model <model-id>` -- Override the agent model
- `--mode <builtin|docker>` -- Override `settings.mode`

See `--help` for the full flag list.

#### Staging

The command stages a fresh workspace under `~/.ironcurtain/debug-runs/<workflow>-<state>-<timestamp>/workspace/` (override with `--output`). Each subdirectory of `--artifacts` whose name matches one of the state's declared `inputs` is copied into `workspace/.workflow/<name>/`. Required inputs missing on disk abort with a structured error; optional inputs (`?` suffix) are silently skipped.

When `--workspace` is provided, its contents are copied into the staged workspace first, **excluding any top-level `.workflow/` directory**. Artifact staging always wins on conflict, so pointing `--workspace` at a tree that already contains `.workflow/` will not overwrite the artifacts you staged separately via `--artifacts`. The `--workspace` copy source goes through the same workspace checks as `workflow start`.

#### Output

After the agent returns, the command writes:

- `agent-output.md` at the run's output dir -- full agent response (the primary debug artifact; the response can be megabytes and is inconvenient to recover from terminal scrollback)
- Anything the agent wrote to `workspace/.workflow/<output>/` per its declared `outputs`
- A short verdict line on stdout parsed from the response's `agent_status` block (run-state sessions have no commit tool)
- For Docker-mode runs only: `container-logs.txt` (the container's log, captured through the session's own container runtime: `docker logs` or, on Apple `container`, `container logs`; useful for diagnosing OOM-kills and other container-side failures) and `claude-session-logs/` (a copy of the in-container Claude Code conversation JSONL, useful for verifying what the agent actually saw)

#### Examples

```bash
# Re-run a state against pre-staged artifacts, no source tree
ironcurtain workflow run-state <workflow> <state> --artifacts ~/path/to/.workflow

# Include a workspace so the agent can read code alongside the artifacts
ironcurtain workflow run-state <workflow> <state> \
  --workspace ~/path/to/repo --artifacts ~/path/to/repo/.workflow

# Test routing-driven scoping with an explicit directive
ironcurtain workflow run-state <workflow> <state> \
  --artifacts ~/path/to/.workflow \
  --directive "focus on the issue identified by the prior agent"
```

#### Caveats

This is a single-state runner. It does not transition to other states, does not update the journal, does not write a checkpoint, and does not persist anything back to the source `--artifacts` directory. If a state's behavior depends on the workflow journal or on artifacts produced by other states earlier in the run, those artifacts must be present in the `--artifacts` dir before invocation.

### Driving workflows from an agent (daemon-backed)

The commands above run the orchestrator **in-process** and resolve human gates through an interactive terminal prompt — unusable by an autonomous agent. The commands in this section instead drive a **running daemon** over the same WebSocket JSON-RPC the web UI uses, so an agent (or any script) can start a gated workflow, observe in machine-readable JSON when human input is required, and resolve the gate itself — no TTY, no human. See [`docs/designs/agent-driven-workflow-gates.md`](docs/designs/agent-driven-workflow-gates.md) for the design.

They require a daemon started with the web UI:

```bash
ironcurtain daemon --web-ui
```

Every command here accepts `--json`, which prints a single newline-terminated JSON object to **stdout** while human-readable text goes to **stderr** (the two never interleave, so an agent parses stdout safely). JSON output writes C1, bidi and format characters as `\u` escapes; the parsed values are unchanged. When no daemon is reachable they fail fast with `{"ok":false,"error":"DAEMON_NOT_RUNNING"}` and a non-zero exit rather than hanging. `--ensure-daemon` (on every command here) spawns a detached `ironcurtain daemon --web-ui` instead; it reports `DAEMON_WITHOUT_WEB_UI` without spawning when a daemon without a reachable web UI is already running (restart that daemon with `--web-ui`).

The agent's loop is `run → await → (show → gate → await)* → terminal`:

```bash
# Start a gated workflow on the daemon; capture its id from stdout.
ironcurtain workflow run design-and-code "Add a CSV export to the reporting CLI" --json
# stdout: {"ok":true,"workflowId":"4b2f9c1e-...","phase":"running"}
WF=4b2f9c1e-...

# Block until the run needs a decision (or finishes).
ironcurtain workflow await "$WF" --json
# stdout (shape is representative): {"ok":true,"workflowId":"4b2f9c1e-...",
#   "phase":"waiting_human","currentState":"plan_review","round":1,
#   "gate":{"gateId":"4b2f9c1e-...-plan_review-1-k3x9","stateName":"plan_review","summary":"...",
#           "acceptedEvents":["APPROVE","FORCE_REVISION","ABORT"],"presentedArtifacts":["plan"]}}
GATE=4b2f9c1e-...-plan_review-1-k3x9

# Inspect what the gate presents, then decide.
ironcurtain workflow show "$WF" --artifact plan --json
ironcurtain workflow gate "$WF" --gate-id "$GATE" --event FORCE_REVISION --prompt "Cover empty input and quoted fields in the plan" --json

# Loop await -> gate until a terminal; eventually approve the gate await reports.
ironcurtain workflow gate "$WF" --gate-id "$GATE" --event APPROVE --json
ironcurtain workflow await "$WF" --json
# stdout: {"ok":true,"workflowId":"4b2f9c1e-...","phase":"completed","currentState":"done"}
```

The agent decider is a host agent reading artifacts that sandboxed agents wrote; treat `show` output as untrusted input.

#### `ironcurtain workflow run`

Start a workflow on the daemon and return immediately with its id (the daemon hosts the orchestrator). The first argument is a workflow name or a path, resolved client-side.

```bash
ironcurtain workflow run <name-or-path> "task description" [--workspace <path>] [--json] [--ensure-daemon]
```

Options:

- `--workspace <path>` -- Run against an existing directory instead of a fresh sandbox
- `--ensure-daemon` -- If no daemon is running, spawn a detached `ironcurtain daemon --web-ui` and wait for it to come up (off by default; lets an agent self-bootstrap)

Errors: `WORKFLOW_DEFINITION_NOT_FOUND` if the name/path doesn't resolve; `LINT_FAILED` (carrying `diagnostics`) or `INVALID_PARAMS` if the definition fails pre-flight lint or fails to load; `WORKSPACE_NOT_DIRECTORY` or `WORKSPACE_UNSAFE` for a workspace the checks refuse.

#### `ironcurtain workflow await`

Block until the workflow next reaches a human gate, a pending tool-call escalation **or** a terminal, print its status, and exit. This is the primary way an agent waits — it returns exactly at the next decision point, with no polling.

```bash
ironcurtain workflow await <workflowId> [--timeout <sec>] [--json]
```

- `--timeout <sec>` -- Maximum seconds to wait (default 600, at most about 24.8 days). On timeout, exits `4` with `AWAIT_TIMEOUT` (`{workflowId, timeoutSec, hint}`) and leaves the workflow running; re-issue `await` to keep waiting.

The status line includes `gate id: ...`. Short-lived `status` and `await` connections do not reset the idle countdown of unattended web terminal sessions.

#### `ironcurtain workflow status`

One-shot, stateless poll of a workflow's current phase and gate — the same JSON shape `await` prints, but returns immediately without blocking. Use it for a quick check or when a long-held connection is undesirable.

```bash
ironcurtain workflow status <workflowId> [--json]
```

#### `ironcurtain workflow gate`

Resolve a pending human gate by choosing an event. When driven by an agent, the agent is the decider.

```bash
ironcurtain workflow gate <workflowId> --gate-id <gateId> --event <APPROVE|FORCE_REVISION|REPLAN|ABORT> [--prompt <text>] [--json]
```

- `--gate-id <gateId>` -- Required: `gate.gateId` from `await`/`status`. Every raise of a gate has its own id (`<workflowId>-<state>-<visit>-<random>`), stable while the gate is up and across daemon restarts.
- `--prompt <text>` -- Required for `FORCE_REVISION` and `REPLAN` (the feedback is injected into the next agent's prompt); an empty prompt is rejected. Validated locally and re-validated by the daemon.

A stale gate id gets `GATE_MISMATCH`, and an event the gate does not accept (`gate.acceptedEvents` lists only those it will) gets `EVENT_NOT_ACCEPTED`; both exit 1, the run keeps waiting, nothing is logged, and the error does not reveal the live id, so re-read it with `await` or `status`. A run that is not at a gate gets `WORKFLOW_NOT_AT_GATE`. Gate records in the message log carry `gateId`, and resolutions carry `resolvedBy` (the declared channel: `web-ui`, `cli`, `signal` or `rpc`; declared, not authenticated, since the bearer token is shared).

#### `ironcurtain workflow escalation`

Resolve a tool-call escalation of a running workflow (see [Tool-call escalations](#tool-call-escalations)).

```bash
ironcurtain workflow escalation <workflowId> --approve --escalation-id <id> [--whitelist <n>] [--json]
ironcurtain workflow escalation <workflowId> --deny [--escalation-id <id>] [--json]
```

`--approve` always needs `--escalation-id` (as `status`/`await` list it), so the approval binds to the call that was reviewed. `--whitelist <n>` also whitelists candidate `n` (0-based, as `status` lists them) for the rest of that state's session.

#### `ironcurtain workflow show`

Print the content of an artifact a gate presents — turning the `presentedArtifacts` _names_ from `await`/`status` into the files the agent reasons over.

```bash
ironcurtain workflow show <workflowId> --artifact <name> [--file <path>] [--json]
```

It lists the artifact's files and inlines them one at a time, up to 4 MiB of returned text; files beyond that are listed with `omitted: true` and their size, and `--file <path>` fetches one of them. The JSON shape is `{ ok, files: [{ path, size, content? | binary? | error?, errorCode? | omitted? }], truncated }`. Per-file read errors are recorded in that file's entry; `WORKFLOW_NOT_FOUND` and `ARTIFACT_NOT_FOUND` fail the command. With `--json`, stderr gets only a summary line.

#### Exit codes

`await` and `status` report the **workflow phase** as their exit code; `run`, `resume`, `gate`, `escalation` and `show` report the **result of the call**.

`await` / `status` — phase-derived:

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | At a gate (`waiting_human`), at a tool-call escalation (`escalation`), or `completed` |
| `3`  | Terminal failure phase (`failed` or `aborted`)                                        |
| `4`  | `await` timed out before a decision point (workflow left running)                     |
| `1`  | Operational failure (no daemon reachable, connection lost, RPC error)                 |
| `2`  | Usage error (bad flags)                                                               |

The phase is read from an authoritative `workflows.get`, never inferred from a lifecycle event: a gate `ABORT` ends in `phase:"aborted"` (exit `3`) even though the run emits a "completed" lifecycle event internally.

`run` / `resume` / `gate` / `escalation` / `show` — call-result:

| Code | Meaning                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | The call succeeded (workflow started / gate or escalation resolved / artifact returned)                                                                                                                              |
| `1`  | Operational or RPC error — e.g. `ARTIFACT_NOT_FOUND` (artifact not produced yet), `WORKFLOW_NOT_AT_GATE`, `GATE_MISMATCH`, `EVENT_NOT_ACCEPTED`, `WORKFLOW_NOT_FOUND`, `DAEMON_NOT_RUNNING`, `DAEMON_WITHOUT_WEB_UI` |
| `2`  | Usage error (bad flags, missing/empty required `--prompt`, unknown event)                                                                                                                                            |

Every usage error is `INVALID_USAGE` JSON with exit 2. A daemon connection lost mid-call is `DAEMON_DISCONNECTED` (exit 1, including during `await`), other transport failures are `DAEMON_REQUEST_FAILED`, and unexpected CLI failures are `CLI_INTERNAL_ERROR`. For `run`, `resume`, `gate` and `escalation` such a result adds `effect: "unknown"` and a hint to check `status` before retrying, because the daemon may already have acted.

`show` is phase-agnostic: it returns `0` as soon as the named artifact exists on disk (even mid-run) and `1` (`ARTIFACT_NOT_FOUND`) while the producing state is still executing — it never reports a workflow phase.

## Human gates

When a workflow reaches a human gate, you're prompted to choose:

- **Approve (`a`)** -- Continue to the next state
- **Force Revision (`f`)** -- Send the workflow back with feedback (you'll be asked to type your feedback)
- **Replan (`r`)** -- Go back to the planning stage
- **Abort (`x`)** -- Stop the workflow

Your feedback text is included in the next agent's prompt. The terminal prompt is withdrawn when its gate stops waiting (for example after the gate idle timeout).

### Resolving gates without a human (agent-driven)

The prompt above is interactive — it expects a person at a terminal and is what the in-process `ironcurtain workflow start` uses. To let an **autonomous agent** drive a gated workflow (start it, detect when a gate needs a decision, and choose the event itself, with no human involved), use the daemon-backed commands instead — see [Driving workflows from an agent](#driving-workflows-from-an-agent-daemon-backed).

The agent observes the pending gate in machine-readable JSON (`workflow await`/`status` report the gate's `gateId`, `summary`, `acceptedEvents`, and `presentedArtifacts`), inspects the presented artifacts with `workflow show`, then resolves with `workflow gate --gate-id ... --event ...`, looping `await → gate → await` until a terminal. The same four events (`APPROVE` / `FORCE_REVISION` / `REPLAN` / `ABORT`) and the same "feedback required for `FORCE_REVISION`/`REPLAN`" rule apply — the agent simply plays the role a human plays at the interactive prompt.

## Tool-call escalations

An agent state's tool call that policy escalates waits for a decision like any other escalation:

- **Who answers:** in the standalone `ironcurtain workflow start`, a terminal prompt (withdrawn if the escalation expires). Through the daemon, the workflow detail page of the web UI shows an escalation panel (the Workflows nav badge counts pending ones), and `workflow status`/`await --json` report `phase: "escalation"` with an `escalations` array (exit code 0) that includes the reviewer context (`taskSummary`; the agent's own justification is deliberately omitted). Resolve them with `ironcurtain workflow escalation` or the `workflows.resolveEscalation` RPC.
- **Timeouts and withdrawal:** an escalation waits up to `escalationTimeoutSeconds`, then is denied as timed out. It is withdrawn (denied as cancelled) when the agent turn that raised it ends, the run aborts, or a policy hot-swap happens. Auto-approval is off in workflows, and a whitelist entry lasts until the persona changes or the session ends.
- **Records:** the message log has `tool_call_escalation` entries (raised, then approved, denied or expired); `workflow watch` shows them under the `gate` filter.

## Creating custom workflows

A workflow definition is a YAML (preferred) or JSON file. YAML is recommended because prompts can use `|` literal blocks for multi-line strings instead of escaped newlines.

```yaml
name: my-workflow
description: What this workflow does
initial: first_state

settings:
  mode: docker
  dockerAgent: claude-code
  maxRounds: 3
  systemPrompt: Optional persistent context for all agents
  sharedContainer: true # optional; see "Shared-container mode" above
  snapshotOnStop: true # optional; requires sharedContainer and preserves container writable layers across aborted resume

states:
  first_state:
    # ...
  second_state:
    # ...
  done:
    type: terminal
    description: Workflow complete
```

The `settings:` keys are `mode` (`docker` or `builtin`), `dockerAgent`, `model`, `maxRounds` (default 4), `systemPrompt`, `workers` (fan-out lanes, at most 16), `sharedContainer`, `allowMixedPersonas`, `snapshotOnStop`, `gateIdleTimeoutMinutes`, `resourceBudget`, `workflowBudget`, `unversionedArtifacts`, and the legacy `maxSessionSeconds` and `gitRepoPath`. Any other key is a validation error.

### Agent states

```yaml
my_state:
  type: agent
  persona: role-name
  prompt: |
    You are a ... Your responsibilities: ...
  inputs:
    - plan
    - spec
  outputs:
    - reviews
  transitions:
    - to: next_state
      when:
        verdict: approved
    - to: retry_state
      when:
        verdict: rejected
    - to: escalate
      guard: isRoundLimitReached
```

- **`persona`** -- Either `"global"` (use the default global policy) or the name of an IronCurtain persona created via `ironcurtain persona create <name>`. When set to a real persona name, the agent session uses that persona's compiled policy, model and limits (below the workflow's own), and system prompt augmentation, and its memory database except under `sharedContainer: true`. The orchestrator validates that all non-`"global"` personas exist before starting the workflow, and a stale or overly broad persona policy refuses the state.
- **`prompt`** -- Role instructions sent to the agent. The orchestrator automatically appends workflow context (task description, previous agent's handoff, artifact locations) and the instructions for committing a result after your prompt. When a state with `freshSession: false` is re-invoked, only new information is sent (the role instructions are already in the conversation history).
- **`inputs`** -- Artifact directories the agent should read (under `.workflow/`). Trailing `?` marks optional inputs (e.g., `reviews?`).
- **`outputs`** -- Artifact directories the agent must create (under `.workflow/`). Use `[]` for code-only states where the agent writes to the workspace root.
- **`transitions`** -- Where to go next, using `when` for declarative conditions or `guard` for context-based checks
- **`freshSession`** -- When `false`, re-invocations of this state resume the conversation it had before, receiving an abbreviated re-visit prompt. Use this for iterative refinement loops where the agent benefits from retaining its prior reasoning (e.g., a coder receiving critic feedback). Default: `true` (each invocation starts a fresh conversation, bootstrapping from artifacts on disk).
- **`maxVisits`** -- Optional positive integer. Caps how many times this specific state can be entered. Pairs with the `isStateVisitLimitReached` guard, which fires on the Nth visit's `onDone` (i.e., after the Nth invocation completes); `maxVisits` alone does nothing (lint `WF016`). Independent of `settings.maxRounds`. Only valid on `agent` states; placing it on other state types is a validation error. See "Transition actions" for the pairing with `resetVisitCounts`.
- **`model`** -- Optional model for this state (see [Model selection](#model-selection)).
- **`dockerAgent`** -- Optional agent harness for this state (`claude-code`, `goose` or `codex`), overriding `settings.dockerAgent`. Rejected in builtin mode. Under `sharedContainer: true` there is one harness per container scope, so states that need a different harness (for example a diverse-reviewer pattern) need their own `containerScope`; without a shared container any mix works.
- **`workspaceAccess`** -- `read-write` (default) or `read-only`. A read-only state reads everything and changes only its own `.workflow/<output>` directories, which it writes with `filesystem.write_file` through `execute_code`; in Docker `/workspace` and the dependency layers are mounted read-only and nested Docker is off, and every local git change is refused. A shared-container scope must not mix access, so give read-only states their own `containerScope`. Not allowed on fan-out states; output names must be plain relative paths; no containerized `resultFile` in a read-only scope.
- **`containerScope`** -- Under `sharedContainer: true`, the container the state runs in (default `primary`).
- **`skills`** -- Optional list of skill names (strings) selecting which workflow-bundled skills are visible to this state, or the literal string `none` to disable every skill layer. When omitted, the state gets every skill in the workflow package's `skills/` dir (default = all). When set to an array, the state is restricted to the listed names. User-global skills (under `~/.ironcurtain/skills/`) always apply on top, with last-wins on collision. Names that don't exist as `<workflow-pkg>/skills/<name>/SKILL.md` fail validation at workflow load. The `skills: none` sentinel is the true off-switch: no workflow-package, user-global, or persona skills are loaded. See "Skills" below.

### Model selection

Workflows can pin a specific LLM at two levels. The `model` field accepts three forms: a `provider:model-name` qualified ID (provider ∈ anthropic, google, openai), a bare model name (treated as Anthropic), or an Ollama-style `name:tag` identifier (e.g. `glm-5.1:cloud`, `qwen3.5-uncensored:35b`) forwarded verbatim to an upstream gateway such as `ANTHROPIC_BASE_URL`. A provider prefix that is a near miss of a real one (`anthropc:`) is an error.

Valid IDs depend on which agent is running the workflow:

- **`mode: builtin`** -- any configured provider: `anthropic:claude-opus-4-6`, `openai:gpt-5`, `google:gemini-2.5-pro`, etc.
- **`dockerAgent: claude-code`** -- the adapter passes the bare model name to the `claude --model` CLI flag. By default that targets Anthropic's API. To run a non-Anthropic model (e.g. an Ollama-served `glm-5.1:cloud`, an OpenRouter model, or any other Anthropic-compatible proxy), set `ANTHROPIC_BASE_URL` in the environment to the proxy endpoint; the same model name is then forwarded to that endpoint.
- **`dockerAgent: goose`** -- provider is selected at container startup via the user's `gooseProvider` setting, not via the workflow's `model` field. See the Goose caveat below.

- **Workflow-level** (`settings.model`) -- default for every agent state in the workflow.
- **State-level** (`model` on any agent state) -- overrides the workflow default for that state only.

```yaml
name: mixed-models
settings:
  mode: docker
  dockerAgent: claude-code
  model: anthropic:claude-sonnet-4-6 # default for every agent state

states:
  plan:
    type: agent
    persona: planner
    prompt: 'Plan the work.'
    model: anthropic:claude-opus-4-6 # overrides workflow default for this state
    outputs: [plan]
    transitions:
      - to: implement

  implement:
    type: agent
    persona: coder
    prompt: 'Implement the plan.'
    # no `model` -- inherits settings.model (sonnet)
    inputs: [plan]
    outputs: []
    transitions:
      - to: done

  done:
    type: terminal
```

**Precedence** (highest wins):

1. `--model` CLI flag on `ironcurtain workflow start` / `resume-standalone`
2. State-level `model` in the YAML
3. Workflow-level `settings.model` in the YAML
4. The state persona's `agentModelId` (`ironcurtain persona set <name> --model <id>`)
5. `agentModelId` in `~/.ironcurtain/config.json`
6. Hardcoded default (`anthropic:claude-sonnet-4-6`)

**Goose caveat.** Per-state switching only takes effect at container spawn for the Goose adapter: Goose reads `GOOSE_MODEL` from its container environment at startup and cannot change models per turn. Claude Code supports per-turn switching via `--model`, so per-state overrides within a single state's multi-round loop work as expected.

### Skills

Workflows can ship purpose-specific guidance to the agent as **skills**: SKILL.md packages — the open standard adopted by Claude Code, Goose, and Codex. IronCurtain stages the resolved set into a per-bundle host directory and bind-mounts it read-only into the container at the path the active agent's native discovery walks (Claude Code: a sibling path picked up via `--add-dir`; Goose: `~/.config/goose/skills/`). The agent then decides when to read each skill based on the frontmatter description.

A skill is a directory containing a `SKILL.md` with YAML frontmatter (`name`, `description`) plus any supporting files (helper scripts, fixtures, embedded markdown). Two layers stack at session creation:

- **User-global** -- `~/.ironcurtain/skills/<name>/` -- always applied to every Docker session, regardless of workflow or persona.
- **Workflow-bundled** -- `<workflow-pkg>/skills/<name>/` -- ships alongside `workflow.yaml` inside the workflow's package directory. Per-state filtering with the `skills:` field on agent states selects which workflow-bundled skills are visible to that state; omit the field to expose all of them.

On collision (same `name` in multiple layers), the workflow layer wins over user-global. State filtering excludes the workflow's version of a colliding name, so the user-global one wins by default for that state.

**Workflow package layout.**

```
my-workflow/
├── workflow.yaml         # the manifest
└── skills/               # optional; bundled skills available to this workflow
    ├── analyze/
    │   └── SKILL.md
    └── synthesize/
        ├── SKILL.md
        └── helper.sh
```

Inside an agent state's YAML:

```yaml
review:
  type: agent
  persona: global
  prompt: ...
  inputs: [plan]
  outputs: [reviews]
  transitions: [{ to: done }]
  skills: [analyze] # only `analyze` from workflow package; user-global always applies
```

In workflow mode the persona-skills layer (`~/.ironcurtain/personas/<name>/skills/`) is intentionally inert — workflow states use the per-state `skills:` field for differentiation, not the persona. Personas still carry skills for standalone (`ironcurtain start --persona <name>`) sessions.

**Three forms of the `skills:` field.** All three only affect Docker-mode sessions (`mode: docker` in the workflow's `settings`). Builtin-mode sessions do not stage skills regardless of this field — skill discovery is skipped entirely on the builtin path. The descriptions below describe Docker-mode behavior.

- `skills:` omitted — default. The state receives every workflow-package skill plus user-global skills (last-wins on name collisions). Persona skills are not loaded in workflow mode (see paragraph above); they apply only to standalone sessions.
- `skills: [name1, name2]` — array. The workflow-package layer is filtered to the listed entries; user-global skills still apply on top.
- `skills: none` — string sentinel. True off-switch: no workflow-package, user-global, or persona skills are loaded for the state. Useful when validating that a specific skill is carrying the work, or when a state should run with no skill context at all.

Note that `skills: []` (empty array) is **not** the off-switch — it filters the workflow-package layer to zero, but user-global skills still load. Use `skills: none` for the strict off-switch.

### Human gate states

```yaml
my_gate:
  type: human_gate
  description: Human review
  acceptedEvents:
    - APPROVE
    - FORCE_REVISION
    - ABORT
  present:
    - plan
  transitions:
    - to: next
      event: APPROVE
    - to: revise
      event: FORCE_REVISION
    - to: aborted
      event: ABORT
```

- **`acceptedEvents`** -- Which options to show the user. Choose from: `APPROVE`, `FORCE_REVISION`, `REPLAN`, `ABORT`.
- **`present`** -- Artifact names to show the user for review

### Deterministic states

Deterministic states run commands without an LLM. Commands are arrays of argument arrays (no shell strings). Each state must say where they run: `container: true` (in the workflow's container) or `host: true` (on your machine). Prefer the container:

```yaml
validate:
  type: deterministic
  description: Run tests and lint in the workflow container
  container: true
  containerScope: primary # optional; defaults to primary
  run:
    - - npm
      - test
    - - npm
      - run
      - lint
  transitions:
    - to: next
      guard: isPassed
    - to: fix
```

`container: true` requires `settings.sharedContainer: true` with Docker mode. Container deterministic commands run with `/workspace` as their working
directory, see the same workspace as the agent states in that scope, and can
read workflow helper code from `/workflow-scripts`. They are not mediated by the policy engine, and they cannot make LLM requests through the proxy. The agent in that scope has sudo and writes `/workspace`, so a helper's verdict is only as trustworthy as the run's agent.

`host: true` runs the commands on the host, as you, with network access and your environment, outside the container and the policy engine. Commands such as `npm`, `pytest`, `make`, `cargo` or `git` execute code from the agent-writable workspace, so a host state gives the agents' output code execution on your machine. Host commands run in the run's workspace, with stdin closed and no controlling terminal; on timeout, or when the run stops or is aborted, the whole process group is killed, and anything a command leaves running in its group is killed when it exits. A process that leaves the group (`setsid`, a daemonizing double fork) escapes that kill. Each output stream keeps its first and last 1 MiB. Lint `WF015` warns about every host state, and resuming a run imported from outside the home's `workflow-runs/` with host states needs `--trust`.

On both paths, `timeoutMs` bounds each command (default 10 minutes, at most 2147483647 ms), and a failure's message falls back from stderr to stdout to the exit status (or, on the host, the spawn error).

Use the `isPassed` guard for success transitions. Deterministic states need an unconditional fallback transition (the last `- to: fix` above).

Container deterministic states can also route on a helper-written verdict file.
Set `resultFile` to a normalized workspace-relative path and have the helper
write JSON with a required string `verdict`, optional object `payload`, and
optional boolean `passed`:

```yaml
classify:
  type: deterministic
  description: Route on helper output
  container: true
  resultFile: .workflow/result.json
  run:
    - - python3
      - /workflow-scripts/classify.py
  transitions:
    - to: passed
      when: { verdict: pass }
    - to: blocked
      when: { verdict: block }
    - to: error
      when: { verdict: result_file_error }
    - to: error
```

The result file is read only after all commands exit successfully. If a command
fails, legacy `isPassed`/`isFailed` behavior is unchanged and the file is not
read. When the file sets `passed`, it overrides the exit-code-derived pass/fail
(an evaluator can exit 0 yet report `passed: false` — e.g. a candidate that ran
cleanly but failed its checks), and `isPassed`/`isFailed` then see that
overridden value. If the file is missing, malformed, not a JSON object, lacks a non-empty
string `verdict`, is not a regular file (a symlink, even one pointing inside the workspace, or a FIFO), or is larger than 1 MiB, the deterministic result becomes `passed: false` with the
reserved verdict `result_file_error` and a descriptive message, which can be routed with
`when: { verdict: result_file_error }`. `resultFile` and deterministic
`when:{verdict}` routing are container-only; host deterministic states remain
guard-based.

When a deterministic state fails (any command exited non-zero) and routes to an agent state, the failed commands' captured output (stderr per command, falling back to stdout when stderr is empty, joined across all failing commands) is forwarded as the agent's prior-state context, rendered under `## Output from <det-state> / Directive: ...` in the agent's prompt. Successful deterministic results update only `previousTestCount`; the agent's own prior-state context fields (`previousAgentOutput`, `previousAgentNotes`, `previousStateName`) are left untouched, so the next agent still sees the last agent state's output.

### Terminal states

```yaml
done:
  type: terminal
  description: Workflow complete
  outputs:
    - reviews
```

Optional `outputs` lists artifacts to include in the final summary.

### Transition conditions

There are two ways to control transitions: declarative `when` conditions and code-based `guard` functions. `when` clauses with free-form verdict strings are the primary routing mechanism for agent states. Guards are reserved for conditions that require workflow context.

**`when` -- declarative conditions (preferred):**

```yaml
- to: done
  when: { verdict: approved }
- to: fix
  when: { verdict: rejected }
- to: validate
  when: { verdict: thesis_validate }
- to: escalate
  when: { verdict: escalate }
```

`when` matches against the verdict the agent committed. On container deterministic states with `resultFile`, `when:{verdict}` matches the helper-written deterministic verdict. All specified fields must match (AND semantics). The supported matchable field is `verdict`; other fields (`completed`, `confidence`, `escalation`, `testCount`, `notes`) are deprecated and rejected by validation.

The `verdict` field accepts any string value, enabling custom verdicts for direct routing (e.g., `"thesis_validate"`, `"escalate"`, `"reanalyze"`). Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`. This is the recommended pattern for new workflows: instruct the agent to use specific verdict strings in its prompt, then match on them with `when`.

Deterministic `when:{verdict}` requires `container: true`; without `resultFile`, WF012 warns that the verdict edges are dead. A transition cannot have both `when` and `guard`.

A state may transition to itself: the self-transition restarts the agent or deterministic invocation and counts as a new visit. A result that matches no transition routes to the state's error target with `lastError` `no transition matched (verdict X)` instead of hanging.

**`guard` -- code-based conditions (for context-based checks):**

| Guard                      | Checks                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `isRoundLimitReached`      | Max visit count across all states >= `settings.maxRounds` (workflow-wide cap; default 4)                                                 |
| `isStateVisitLimitReached` | Fires on the Nth `onDone` when the state carries `maxVisits: N` (see [`maxVisits`](#agent-states)). Inert on states without `maxVisits`. |
| `isStalled`                | Agent produced identical output artifacts as previous round                                                                              |
| `isPassed`                 | Deterministic state commands all passed                                                                                                  |

Use `guard` for conditions that depend on workflow context (round limits, stall detection) and for legacy deterministic pass/fail routing (`isPassed`). For verdict-based routing, use `when` clauses -- e.g., `when: { verdict: "approved" }` supports any verdict string for direct routing.

`isRoundLimitReached` applies a single workflow-wide cap: the highest visit count of any state. A long plan-revision phase therefore uses up rounds an implementation loop needs, unless the transition that closes that phase resets its visit counts (`resetVisitCounts`). `isStateVisitLimitReached` scopes the cap to one state via that state's `maxVisits`. Use the per-state guard for narrowly bounded loops (e.g., a review step that should escalate after N iterations without halting the whole workflow).

### Transition actions

A transition may declare an ordered list of side-effects via `actions:`, in addition to the default context update performed on every transition. This is valid on agent, deterministic, and human gate transitions alike. Each entry is an object discriminated on `type`:

```yaml
transitions:
  - to: next_state
    when: { verdict: approved }
    actions:
      - type: resetVisitCounts
        stateIds: [review_state, build_state]
```

| Action type        | Params                    | Effect                                                                                         |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `resetVisitCounts` | `stateIds: [string, ...]` | Zeroes the visit counter for each listed state. All listed IDs must reference existing states. |

Actions run in the order listed. The default action always runs first: the context-update action for agent/deterministic transitions, or `storeHumanPrompt` + `clearError` for human gate transitions.

**Human gate reset pattern.** When a bounded loop escalates to a human gate on cap-reached, the gate's APPROVE transition typically routes back into the loop. Without a reset action, the visit counter is still at the cap and the next `isStateVisitLimitReached` check fires immediately, re-escalating to the gate. Declare `resetVisitCounts` on the APPROVE transition so the human's approval actually restarts the loop:

```yaml
escalate_gate:
  type: human_gate
  acceptedEvents: [APPROVE, ABORT]
  transitions:
    - to: build_state
      event: APPROVE
      actions:
        - type: resetVisitCounts
          stateIds: [review_state, build_state]
    - to: aborted
      event: ABORT
```

**Bounded-loop pattern.** `maxVisits` + `isStateVisitLimitReached` + `resetVisitCounts` compose to bound a review/rework loop and reset the cap when the loop is re-entered from outside:

```yaml
states:
  plan:
    type: agent
    persona: planner
    description: Produce a plan
    prompt: 'Plan the task. Emit verdict: ready.'
    inputs: []
    outputs: [plan]
    transitions:
      - to: review
        when: { verdict: ready }
        # Fresh entry into the review loop -- clear any prior cap.
        actions:
          - type: resetVisitCounts
            stateIds: [review]

  review:
    type: agent
    persona: reviewer
    description: Review the plan; loop until approved or cap reached
    prompt: 'Review the plan. Emit verdict: approved or rejected.'
    inputs: [plan]
    outputs: [reviews]
    maxVisits: 3
    transitions:
      - to: done
        when: { verdict: approved }
      # Ordered before the rejection transition so the cap wins on visit 3.
      - to: escalate_gate
        guard: isStateVisitLimitReached
      - to: plan
        when: { verdict: rejected }

  escalate_gate:
    type: human_gate
    description: Review loop exhausted
    acceptedEvents: [APPROVE, ABORT]
    transitions:
      - to: done
        event: APPROVE
      - to: aborted
        event: ABORT

  done:
    type: terminal
    description: Done
  aborted:
    type: terminal
    description: Aborted
```

On the third `review` visit the cap fires before the rejection `when` clause is evaluated, routing to `escalate_gate`. Re-entering `review` via `plan` clears the counter so the loop starts fresh.

### Stall detection

The `isStalled` guard compares SHA-256 hashes of a state's output artifact files between consecutive visits. If an agent produces byte-identical output on two consecutive invocations of the same state, the guard returns true — the agent is stuck in a loop producing the same result. Hashes are computed only for states whose transitions use `guard: isStalled`; artifact walks stop at 100,000 entries or 64 levels per output.

This is useful for coder-critic loops where the coder might repeat the same implementation after being rejected:

```yaml
review:
  type: agent
  description: Reviews code against the spec
  transitions:
    - to: done
      when:
        verdict: approved
    - to: escalate_gate
      guard: isStalled
    - to: implement
      when:
        verdict: rejected
```

The `isStalled` transition should be ordered before the rejection transition so it fires first when the output is identical. This routes to a human gate or alternative state instead of letting the loop continue indefinitely.

### Fan-out (parallel lanes)

A state with `fanOut` runs a segment of other states as several concurrent lanes and joins them at a barrier:

```yaml
workers:
  type: deterministic
  description: Run one round as parallel lanes
  run: []
  fanOut: { count: workers, join: barrier } # or a number of lanes
  segment: [sample, researcher, evaluate] # states marked fanOutMember: true
  transitions:
    - to: next_round
      when: { verdict: recorded }
    - to: failed
```

`count` is `workers` (from `settings.workers`) or a number; either way at most 16 lanes, and lint `WF019` warns above 4. In shared-container mode every lane is an agent process in the scope's one container, so cap the lanes to that container's CPU and memory (`dockerResources`, 4 CPUs and 8 GB by default). Without a shared container each lane is its own session and takes an agent slot (`maxConcurrentAgentSessions`); lanes beyond the cap wait.

A shared-container fan-out segment with more than one lane must use one persona for all of its agent members and one `containerScope`. Agent members of a multi-lane segment may not set `freshSession: false` or declare `outputs`. Each lane's tool calls are rate-limited separately, with an overall bound for the bundle. Upstream quota exhaustion or a transient upstream failure in any lane aborts the whole batch, preserving the checkpoint; resume re-enters the fan-out state.

`settings.maxRounds` caps batches, so a fan-out's candidate budget is `maxRounds × workers` (lint `WF013`).

## Committing a result

An agent state reports its result by calling the `workflow.commit` tool (through `execute_code`): `workflow.commit({ invocation, verdict, notes?, handoff? })`, where `invocation` is the id the orchestrator puts into the state's instructions. The orchestrator appends these instructions to your prompt automatically, so your prompt only needs to describe which verdicts to use.

- **`verdict`** -- Free-form string that drives transition routing. Well-known values are `approved`, `rejected`, `blocked`, and `spec_flaw`, but workflows may define custom verdict strings for direct routing (e.g., `thesis_validate`, `escalate`). A verdict no transition accepts is refused within the turn, so the agent can correct it.
- **`notes`** and **`handoff`** -- Passed to the next state as context.

The first accepted commit is final. A turn that ends without one is uncommitted: the orchestrator sends the agent another turn (retry reason `missing_commit` in the message log) instead of guessing from the agent's prose.

Sessions without the commit tool (for example `ironcurtain workflow run-state`) fall back to a YAML status block at the end of the agent's response:

```yaml
agent_status:
  verdict: approved
  notes: 'Brief summary of what was done'
```

The fields `completed`, `confidence`, `escalation` and `test_count` are parsed if present but are deprecated and never used for routing.

## Message log

Every workflow produces a `messages.jsonl` file at `~/.ironcurtain/workflow-runs/<workflowId>/messages.jsonl` containing all agent exchanges, transitions, gate records (`gate_raised` and `gate_resolved`, with `gateId` and `resolvedBy`) and tool-call escalation records. Use `ironcurtain workflow inspect` or `ironcurtain workflow watch` to view it, or read it directly for debugging.

Each bundle's `audit.jsonl` holds two lines per dispatched tool call with the same `requestId`: a `dispatching` record written before the call is sent, and the outcome. A `dispatching` line without an outcome marks a call that was in flight when the process died.

## Checkpointing and resume

The orchestrator saves a checkpoint when it enters each state. If a workflow fails (agent error, Docker issue, Ctrl+C), resume it through the daemon from its workflow ID:

```bash
ironcurtain workflow resume <workflowId> --ensure-daemon
```

For workflows that ran before checkpointing was added, the explicit standalone command can synthesize a checkpoint at a specific state:

```bash
ironcurtain workflow resume-standalone /path/to/base-dir --state review
```

Resume is **at-least-once**: it re-runs the interrupted state from its start, with the same inputs the state machine builds for it. A replayed agent's prompt opens with a resume notice telling it to inspect the workspace and not to repeat external actions (pushes, PR comments, emails). Deterministic commands get no such signal and must be idempotent. A fan-out batch rebuilds its recorded lanes and re-spawns the missing ones.

Artifacts survive across resume, and so do the agents' conversations: a state with `freshSession: false` continues its recorded conversation. A run executing in another process (the CLI, `resume-standalone` or the daemon) cannot be resumed until that process stops; a crashed process's lock is reclaimed automatically.

When the daemon shuts down (SIGINT or SIGTERM), it aborts every running workflow with the reason `Daemon shutdown`: a `snapshotOnStop` snapshot (within 40 seconds), a terminal checkpoint and container teardown, all within 60 seconds. Runs paused at a gate come back as `aborted` and resumable, and resuming re-raises the same gate. `abort` stops in-flight work: a session created after the abort is closed unused, fan-out lanes stop, and a running host command is killed.

A definition copy that no longer validates (for example `settings.workers` above 16 after an upgrade) refuses the resume with `WORKFLOW_CHECKPOINT_CORRUPTED`, naming the file; fix `definition.json` in the run directory and resume again.

## Web UI

The intended interface for interactive workflow runs (see [Quick start (web UI)](#quick-start-web-ui--recommended) above for the basic launch). This section is the feature reference for what the Workflows page exposes once the daemon is running.

### Starting and resuming workflows

The Workflows page provides a form to start new workflows. Select a definition from the dropdown (bundled and user-defined workflows are auto-discovered), enter a task description, and optionally specify a workspace path (an existing directory, absolute or `~`). The web UI also lists resumable workflows -- previously checkpointed runs that can be continued with one click. A run executing in another process is listed as "running elsewhere" (a dashboard segment and a filter of its own) and has no Resume button. You can import a workflow from an external directory by providing its base directory path; the same import checks as `workflow resume` apply.

### State machine visualization

When you select a running workflow, a state machine graph shows all states and transitions from the workflow definition. The current state is highlighted, and completed states are visually distinguished. The transition history table shows timestamps and durations for each state change.

### Gate review

When a workflow pauses at a human gate, the web UI shows a review panel with the gate's accepted actions (Approve, Force Revision, Replan, Abort). The panel includes:

- **Artifact browser** -- the files of the `.workflow/` artifact directories the gate presents (plan, spec, reviews), listed with their sizes; the first file opens at once and the others load when expanded. Agent-written markdown is rendered strictly (raw HTML shows as text).
- **Feedback input** -- when choosing Force Revision, a text area lets you provide feedback that gets included in the next agent's prompt.

The Workflows page auto-selects a workflow when a gate is raised, so you are taken directly to the review panel when action is needed.

### Tool-call escalations

The workflow detail page shows a panel for each pending tool-call escalation of the run, and the Workflows entry in the navigation shows how many are pending. Approve, deny or approve and whitelist from there (see [Tool-call escalations](#tool-call-escalations)).

### Workspace browser

A collapsible file browser shows the workspace directory tree during and after workflow execution. You can navigate directories and view file contents with syntax highlighting. Binary files and files over 1MB are excluded. The `.git` and `node_modules` directories are filtered from listings, and a directory listing stops at 2,000 entries with a notice.

### Persona viewer

The web UI includes a Personas page (accessible from the sidebar) where you can view all configured personas, their constitutions (rendered as markdown), and compiled policy summaries. It is read-only unless the daemon was started with `--allow-policy-mutation` (see [DAEMON.md](DAEMON.md#persona-policy-management)); otherwise manage personas with the CLI (`ironcurtain persona create|compile|edit|delete`).

### Development and testing

For frontend development without Docker or an API key, use the mock WebSocket server:

```bash
cd packages/web-ui && npm run mock-server   # Terminal 1
cd packages/web-ui && npm run dev            # Terminal 2
```

Open `http://localhost:5173?token=mock-dev-token`. The mock server simulates workflow lifecycle events with realistic timing. See [docs/e2e-workflow-testing.md](docs/e2e-workflow-testing.md) for the full E2E testing guide.

## User-defined workflows

Custom workflow definitions (`.yaml`, `.yml`, or `.json`) can be placed in `~/.ironcurtain/workflows/`. Files in this directory are discovered by both `ironcurtain workflow list` and the web UI's definition dropdown. User-defined workflows override bundled ones if they share the same name. When both YAML and JSON versions exist with the same name, YAML takes precedence.
