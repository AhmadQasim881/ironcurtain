# Workspace Support for Workflows

**Status (2026-11-14):** Implemented: `--workspace` for `ironcurtain workflow start`, validated like other workspaces (`src/session/workspace-validation.ts`); artifacts live in the workspace's `.workflow/` directory.

## Overview

This design adds a `--workspace` flag to the workflow CLI and unifies how the orchestrator handles workspace directories. There is a single workspace model: the workspace is always a directory — either freshly created by the orchestrator or provided by the user via `--workspace`. Workflow artifacts (plans, specs, reviews) live under `.workflow/` inside the workspace. Code lives at the workspace root.

## Workspace Model

```
{workspace}/                          # The workspace root (fresh or existing repo)
  .workflow/                          # Workflow artifacts (gitignored)
    plan/plan.md                      # Planner output
    spec/spec.md                      # Architect output
    reviews/review.md                 # Critic output
    messages.jsonl                    # Message log (WARNING: agent-writable)
  .gitignore                          # Updated with .workflow/ entry
  src/                                # Code written by coder (or existing repo files)
  package.json
  ...

{baseDir}/{workflowId}/              # Orchestrator internals (outside workspace)
  checkpoint.json                     # XState checkpoint for resume
  definition.json                     # Copy of workflow definition
```

When no `--workspace` is provided, the orchestrator creates an empty directory at `{baseDir}/{workflowId}/workspace/`. When `--workspace` is provided, the orchestrator validates it with `validateWorkspacePath()` (the same validator `ironcurtain start -w` uses) and runs in the canonical path it returns. Either way, the agent sees the same layout — a workspace root with `.workflow/` for structured artifacts.

The workspace becomes the agent's `allowedDirectory` and, in Docker mode, a read-write bind mount at `/workspace`, so nothing inside it is protected: the PolicyEngine exempts the allowed directory from its protected-path check, and bind-mounted files never reach the PolicyEngine. `validateWorkspacePath()` therefore rejects a workspace that is or contains the user's home directory (lying inside it is the normal case); that is, contains or lies inside the IronCurtain home (apart from the managed `personas/<name>/workspace`, `sessions/<id>/sandbox`, `workflow-runs/<id>/workspace` and `jobs/<id>/workspace` directories), the package configuration directory, the MCP relays' private scratch root (`<os.tmpdir()>/ironcurtain-<uid>`, so on Linux `-w /tmp` is refused), or a protected path; or that contains the user config file. A protected entry that is, or lies below, a dangling symbolic link is checked at the path the link leads to as well, and the workspace may not contain any other link on the way there (`resolveDanglingLink`), since the agent could otherwise create the file, or replace the link, through which a later host run reads the entry. The only cwd-derived protected entry, the configured audit log when `AUDIT_LOG_PATH` is relative (by default `<cwd>/audit.jsonl`, see `getCwdDerivedProtectedPaths()`), is checked in the workspace-inside-entry direction alone, so `-w .` keeps working. A `.env` in the launch directory is never loaded and so not protected, unless it is the explicit `--env-file` (`IRONCURTAIN_ENV_FILE`); that file holds the real credentials, so a workspace that contains it is rejected like any other protected path. Containment is decided by `(st_dev, st_ino)` of each directory on the canonical paths, with a case- and Unicode-folded string comparison for entries that do not exist, so symlinks and case variants on case-insensitive volumes cannot slip through. On macOS the Data volume is also reachable at `/System/Volumes/Data`, so the ancestors of that verified alias (`/System/Volumes/Data`, `/System/Volumes`, `/System`) count as containing the home directory and the IronCurtain home too. `buildContainerWorkspaceMount()` repeats a spelling-level check (never mount the home directory, the IronCurtain home, or an ancestor of either, nor anything that is, contains or lies inside the scratch root) as defense in depth. A read-only workflow state (`workspaceAccess: read-only`) gets the same workspace mounted read-only instead, with the policy engine confining its MCP writes to its declared `.workflow/<output>` directories (see `src/types/read-only-workspace.ts`). Session resume applies the same rule: `ironcurtain start --resume` (from `session-metadata.json`) and PTY resume (from `session-state.json`) re-validate the recorded workspace and run in the canonical path, so a directory swapped for a symlink since the session ran makes it not resumable.

> **The workspace is agent-writable (hardening note).** In Docker mode the workspace is a read-write bind mount, so every entry under it, including `.workflow/` itself, `.workflow/task/description.md`, `.gitignore` and anything an earlier run left in a reused workspace, may be a symlink to a host path, a FIFO, a link to `/dev/zero`, or swapped while the host looks at it. All host-side I/O on the workspace therefore goes through no-follow, non-blocking, bounded helpers (`src/hardened-fs.ts`, used by `src/workflow/artifacts.ts` and the orchestrator). That includes the `<output>.v<N>` snapshots `snapshotArtifacts` takes before a state is re-entered, while a shared container may still be running: they copy regular files only (no symlinks, FIFOs or devices), each read through a contained no-follow descriptor and written to a file created exclusively and re-located inside the workspace, so a link the agent plants in the half-built snapshot is never written through; a snapshot stops, partial and reported, at 20,000 entries or 256 MiB. The sections below describe the original design; the notes marked "current behavior" describe how the code handles that threat.

## Artifact vs Code Output

Two kinds of agent output exist, distinguished by declaration:

### Workflow artifacts (declared in `outputs`)

Declared in a state's `outputs` array. The orchestrator creates and verifies these under `.workflow/{name}/`.

```json
{ "outputs": ["plan"] }
```

The orchestrator verifies `.workflow/plan/` contains at least one file. The agent is told to write to `.workflow/plan/`. The orchestrator hashes `.workflow/plan/` for stall detection.

### Code output (not declared)

Not declared in `outputs`. The agent writes files at the workspace root — `src/`, `package.json`, `tests/`, whatever. The orchestrator detects changes by hashing file metadata in the workspace root, excluding known directories.

A state can produce both: `outputs: ["reviews"]` declares a workflow artifact, while the agent might also modify code at the workspace root. A state with `outputs: []` produces only code output.

## Stall Detection

Stall detection uses a combined hash of workflow artifacts AND workspace root file metadata.

### Excluded directories

The following directories are excluded from workspace root hashing:

```typescript
const WORKSPACE_HASH_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.workflow',
  'node_modules',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.cache',
  '.venv',
  'venv',
]);
```

### Hash computation

`computeOutputHash` changes behavior based on whether `outputs` is empty:

- **Non-empty `outputs`**: Hash `.workflow/{name}/` for each declared output (current behavior, with `.workflow/` prefix).
- **Empty `outputs`**: Hash the workspace root file listing (paths + mtimes), excluding `WORKSPACE_HASH_EXCLUDED_DIRS`. This detects code-only changes without reading file contents.
- **Combined**: When `outputs` is non-empty, the declared artifact hash is sufficient — the orchestrator already verifies artifacts exist. Workspace-root hashing is only needed when `outputs` is empty and no artifacts provide a signal.

The `computeOutputHash` signature gains a `workspacePath` parameter:

```typescript
export function computeOutputHash(outputNames: readonly string[], artifactDir: string, workspacePath: string): string;
```

When `outputNames` is empty, it hashes the workspace root file listing instead of producing an empty hash.

> **Current behavior.** The hash has one consumer, the `isStalled` guard, so the orchestrator computes it only for agent states that have an `isStalled` transition; every other state gets an empty `outputHash` and nothing is walked. Each declared output is walked only if `resolveArtifactOutputDir` accepts it: `.workflow` and every component of the output name must lstat as a real directory, and the directory's realpath must lie inside the workspace. A symlinked output (for example `.workflow/plan -> /`) contributes nothing, counts as missing for the required-artifact check, is never presented at a gate, and is logged once per run as a security event. Every walk (`walkTreeNoFollow`) lstat-s entries instead of following them, reads directories incrementally, skips entries that vanish or become unreadable mid-walk (a concurrent temp-file rename cannot fail the state), and stops after a bounded number of entries and levels (100,000 entries for one output directory, 200,000 for the workspace root, 64 levels); a truncated listing is marked in the hash. Hashed sizes and mtimes come from the walk's own lstat.

## Workspace Root Hashing (File Listing + mtime)

For code-only states, stall detection hashes file metadata — NOT file contents. This keeps hashing fast even on large repos.

The algorithm:

1. Walk the workspace root recursively, excluding directories in `WORKSPACE_HASH_EXCLUDED_DIRS`.
2. For each file, collect `relativePath + ':' + mtime.getTime()` (relative to workspace root).
3. Sort the collected entries lexicographically.
4. SHA-256 hash the concatenated sorted entries.

This produces a consistent hash that changes when any file is added, removed, or modified — without reading file contents.

```typescript
function hashWorkspaceRoot(hash: Hash, workspacePath: string): void {
  const entries: string[] = [];
  collectFileEntries(workspacePath, '', entries);
  entries.sort();
  for (const entry of entries) {
    hash.update(entry);
  }
}

function collectFileEntries(basePath: string, relativeTo: string, out: string[]): void {
  const dirents = readdirSync(resolve(basePath, relativeTo), {
    withFileTypes: true,
  });
  for (const dirent of dirents) {
    const relPath = relativeTo ? `${relativeTo}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (WORKSPACE_HASH_EXCLUDED_DIRS.has(dirent.name)) continue;
      collectFileEntries(basePath, relPath, out);
    } else if (dirent.isFile()) {
      const fullPath = resolve(basePath, relPath);
      const mtime = statSync(fullPath).mtimeMs;
      out.push(`${relPath}:${mtime}`);
    }
  }
}
```

The full `computeOutputHash` function:

```typescript
export function computeOutputHash(outputNames: readonly string[], artifactDir: string, workspacePath: string): string {
  const hash = createHash('sha256');

  if (outputNames.length > 0) {
    // Hash declared workflow artifacts
    for (const output of outputNames) {
      const dir = resolve(artifactDir, output);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        hash.update(file.relativePath);
        hash.update(readFileSync(file.fullPath));
      }
    }
  } else {
    // Hash workspace root file listing for code-only states
    hashWorkspaceRoot(hash, workspacePath);
  }

  return hash.digest('hex');
}
```

## .gitignore Management

When the orchestrator creates the `.workflow/` directory, it ensures `.workflow/` is listed in the workspace root's `.gitignore`. This always happens — there is no opt-out.

```typescript
function ensureWorkflowGitignored(workspacePath: string): void {
  const gitignorePath = resolve(workspacePath, '.gitignore');

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n');
    const alreadyListed = lines.some((line) => line.trim() === '.workflow/' || line.trim() === '.workflow');
    if (!alreadyListed) {
      const suffix = content.endsWith('\n') ? '' : '\n';
      appendFileSync(gitignorePath, `${suffix}.workflow/\n`);
    }
  } else {
    writeFileSync(gitignorePath, '.workflow/\n');
  }
}
```

This is called in `start()` immediately after creating the `.workflow/` directory. We read `.gitignore` anyway for exclusion purposes, so maintaining it is low-cost.

> **Current behavior.** `ensureWorkflowGitignored` (now in `src/workflow/artifacts.ts`) reads `.gitignore` with `readUntrustedRegularFile` (no-follow, non-blocking, at most 1 MiB) and appends with `appendRegularFileNoFollow` (no-follow, single hard link, dev/ino re-check, same size cap); a missing file is created exclusively, so a dangling symlink is never followed. A `.gitignore` that is a symlink (to a host file or `/dev/zero`), a FIFO, a hard link or oversized is left untouched: the function returns `skipped` with a reason and `start()` prints a warning, because a missing ignore entry should not fail the run.

> **Current behavior (`.workflow/` and the task description).** `start()` and `resume()` call `prepareWorkflowArtifactDir`, which makes `.workflow/` and `.workflow/task/` real directories with `ensureRealDirectoryNoFollow` (a symlink or other non-directory at either name is renamed aside to `<name>.ironcurtain-displaced-<random>`, never followed) and writes `description.md` with `writeFileNoFollowAtomic` (an exclusive temporary file renamed over the name, so a symlink, FIFO or hard link there is replaced, not written through). `resume()` rewrites the description from the checkpoint. Each displaced or replaced entry is reported as a warning on stderr and the workflow tab. As everywhere in Node (no `openat`), a container that is still running can race these checks; the helpers re-verify the directory before the final rename, and the content written is the user's own task text.

## Message Log

The message log lives at `{workspace}/.workflow/messages.jsonl`, alongside other workflow artifacts. This keeps all workflow-visible artifacts together in a single directory tree.

```typescript
// WARNING: messages.jsonl is inside the agent's workspace mount and is writable
// by the agent. This is acceptable for diagnostic purposes but the log should
// not be used for security-critical decisions.
const messageLogPath = resolve(artifactDir, 'messages.jsonl');
```

## Definition File Copy

During `start()`, the orchestrator copies the validated workflow definition to `{baseDir}/{workflowId}/definition.json`. On `resume()`, the definition is read from this copy instead of the original path. This makes resume portable even if the original definition file is moved or deleted.

The copy is written durably and atomically (`writeRunDefinition` in `src/workflow/run-definition.ts`: temporary file, fsync, rename, directory fsync; mode 0600) and stamped with `schemaVersion` and `writerVersion`, like the checkpoint. A reader refuses a newer format with `WORKFLOW_CHECKPOINT_TOO_NEW` instead of reporting the run as corrupted or silently dropping fields it does not know, and removes the stamp before `validateDefinition` (whose `settings` schema rejects unknown keys).

```typescript
// In start():
writeRunDefinition(runDir, definition);

// In resume():
const definition = validateDefinition(readRunDefinitionRaw(runDefinitionPath(runDir)));
```

## Orchestrator Changes

### `WorkflowInstance` gains `workspacePath`

```typescript
interface WorkflowInstance {
  // ... existing fields ...

  /**
   * Root directory where the agent session operates. Either the run's
   * default `<baseDir>/<workflowId>/workspace`, derived and created by the
   * orchestrator, or the canonical path that `validateWorkspacePath()`
   * returned for a user-provided `--workspace`.
   */
  readonly workspacePath: string;
}
```

The existing `artifactDir` field is repurposed to always point at `{workspacePath}/.workflow/`. This preserves all existing artifact I/O code (`findMissingArtifacts`, `computeOutputHash`, `collectArtifactPaths`, gate `present` paths).

### `start()` signature

```typescript
start(
  definitionPath: string,
  taskDescription: string,
  workspacePath?: string,
): Promise<WorkflowId>
```

Behavior:

1. If `workspacePath` is provided, validate it with `validateWorkspacePath(workspacePath, protectedPaths)` before anything is created (`protectedPaths` comes from `WorkflowOrchestratorDeps.protectedPaths`, falling back to `loadConfig().protectedPaths`) and use the canonical path it returns. A rejected path throws a `WorkspaceValidationError` (code `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_DIRECTORY` or `WORKSPACE_UNSAFE`); the daemon's `workflows.start` maps it to `INVALID_PARAMS` and also rejects relative paths, which would otherwise resolve against the daemon's cwd. This is the authoritative check for the CLI, `workflow run` and the web UI; the CLI layers pre-check only for early errors.
2. If `workspacePath` is not provided, create `{baseDir}/{workflowId}/workspace/`. This derived default is not validated.
3. In both cases:
   - Set `instance.workspacePath` to the resolved workspace path.
   - Set `instance.artifactDir` to `{workspacePath}/.workflow/`.
   - Create `.workflow/` and `.workflow/task/` directories.
   - Write `task/description.md` to `.workflow/task/`.
   - Call `ensureWorkflowGitignored(workspacePath)` to add `.workflow/` to `.gitignore`.
   - Copy definition JSON to `{baseDir}/{workflowId}/definition.json`.
   - Create metadata directory at `{baseDir}/{workflowId}/` for checkpoints.
   - Message log is written to `{workspacePath}/.workflow/messages.jsonl`.

### Session creation

The one-line change:

```typescript
// Before:
workspacePath: instance.artifactDir,

// After:
workspacePath: instance.workspacePath,
```

This gives the agent the workspace root as its working directory, not the `.workflow/` subdirectory.

### `findMissingArtifacts` — no change needed

Already works correctly: checks `{artifactDir}/{output}/` which resolves to `.workflow/{output}/`. The `artifactDir` reassignment handles the prefix.

> **Current behavior.** The check first resolves the output through `resolveArtifactOutputDir` (see the stall-detection note above), so an output that is a symlink, sits under a symlinked `.workflow`, or resolves outside the workspace counts as missing and is reported as a security event, instead of satisfying the check with a host directory.

### `computeOutputHash` — workspace fallback

When `outputs` is empty, hash the workspace root file listing instead of producing an empty hash. See the [Workspace Root Hashing](#workspace-root-hashing-file-listing--mtime) section for full implementation.

### Checkpoint changes

```typescript
interface WorkflowCheckpoint {
  // ... existing fields ...
  readonly workspacePath?: string;
}
```

The checkpoint also records `runDir` (`{baseDir}/{workflowId}` when it was written). Paths inside it (the default workspace and the staged `workflow-skills` / `workflow-scripts`) are run-local: `rebaseRunLocalPaths` (`src/workflow/checkpoint.ts`) moves them onto the run directory the run is found in now, so a moved `IRONCURTAIN_HOME` (or a copied run directory) resumes in place. Checkpoints written before `runDir` existed are rebased by shape: a `workspacePath` of the form `<dir>/<workflowId>/workspace` names its own run directory, since the id is minted after any user-chosen workspace exists.

On `resume`:

- If `checkpoint.workspacePath` is unset (checkpoints from before workspaces were recorded), use the derived default `{baseDir}/{workflowId}/workspace/`, creating it.
- If the rebased path equals the derived default, use it; it must exist. It needs no validation only while it is what `start()` created, a real directory inside a real run directory. A default workspace that is a symlink, or lies below a symlinked run directory, points wherever its author chose (a copied or foreign base directory resumed with `resume-standalone` can hold one), so it is validated like any other path and its canonical form is used.
- Otherwise the path was user-supplied at start or arrived in an imported checkpoint, and the directory may have changed since: validate it again with `validateWorkspacePath()` and use the canonical path it returns. A rejected path fails the resume with `WorkflowResumeError('WORKFLOW_NOT_RESUMABLE')` before anything is created.
- A recorded workspace that no longer exists fails the resume with `WorkflowResumeError('WORKFLOW_WORKSPACE_MISSING')`. Resume never recreates it empty, which would let a long run continue without its earlier work (and, for a stale path, outside the active home).
- Reconstruct `artifactDir` from the workspace: `resolve(workspacePath, '.workflow')`. Do NOT use `resolve(baseDir, workflowId, 'artifacts')`.
- Read the workflow definition from `{baseDir}/{workflowId}/definition.json` instead of the original path.

```typescript
// In resume():
const checkpoint = rebaseRunLocalPaths(loaded, workflowId, runDir);
const workspacePath = this.resolveResumeWorkspace(workflowId, checkpoint.workspacePath, loaded.workspacePath);
const artifactDir = resolve(workspacePath, '.workflow');
```

An external run imported by the daemon (`workflow resume <baseDir>`, `workflows.import`) is rebased onto its external run directory, and its workspace is validated at import time. Its `run.lock`, checked first so a run still live in another process is not imported, is read only when it is a regular file, never through a link or by a blocking open: anything else there (a FIFO, a link to `/dev/zero`) counts as held, so the import refuses the run instead of hanging. The imported checkpoint names the daemon's own definition copy, written from the definition the import checked, so resume never reads a path the external checkpoint chose. A run without a definition copy is checked against the file its checkpoint names, which can ship inside the imported directory: like every definition file, it is read only when it has a `.yaml`, `.yml` or `.json` extension and is a regular file of at most 16 MiB, never by a blocking open, so a FIFO or a link to `/dev/zero` there fails the import instead of hanging the daemon. Its staged skills and scripts are kept only when they are real directories canonically inside the external run directory, never a symlink out of it, and skill discovery reads each staged `SKILL.md` the same non-blocking, bounded way, never through a link, reporting one it cannot read instead of waiting on it. Its run-wide usage is kept, so the resumed run continues its totals and `settings.workflowBudget` ceiling, and so is a task-scoped run's task scope (`taskPolicyDir`), which resume validates again and refuses the run over rather than run it unscoped; container snapshot references are dropped. A base directory that is the daemon's own under another spelling (a symlink to it, say) is not imported over itself.

## Prompt Builder Changes

The `.workflow/` prefix is hardcoded. No mode flag, no `artifactPrefix` parameter.

### Input artifact references

```typescript
// Before:
`Read the contents of the \`${name}/\` directory in your workspace...`
// After:
`Read the contents of the \`.workflow/${name}/\` directory in your workspace...`;
```

### Output artifact references

```typescript
// Before:
const outputList = stateConfig.outputs.map((o) => `- \`${o}/\``).join('\n');
sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);

// After:
const outputList = stateConfig.outputs.map((o) => `- \`.workflow/${o}/\``).join('\n');
sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
```

### Artifact re-prompt

```typescript
// Before:
const paths = missing.map((name) => `  - \`${name}/\``);

// After:
const paths = missing.map((name) => `  - \`.workflow/${name}/\``);
```

### No code output instructions

When `outputs` is empty, the prompt builder does not add an "Expected Outputs" section. The agent's role prompt handles telling it where to write code (the workspace root). No change needed — the empty-array check already skips the section.

## Workflow Definition

A single workflow definition works for both fresh tasks and existing repos. The only difference is whether `--workspace` is provided at the CLI.

### Example: `workflow-real-demo.json`

```json
{
  "name": "real-agent-workflow",
  "description": "Plan -> Design -> Implement -> Review workflow",
  "initial": "plan",
  "settings": {
    "mode": "docker",
    "dockerAgent": "claude-code",
    "maxRounds": 3,
    "systemPrompt": "Workflow artifacts (plan, spec, reviews) go in `.workflow/`. Code goes directly at the workspace root."
  },
  "states": {
    "plan": {
      "type": "agent",
      "persona": "planner",
      "prompt": "You are a project planner.\n\nYour responsibilities:\n- Analyze the task requirements\n- If there is existing code in the workspace, read it to understand the current architecture\n- Identify components, dependencies, and implementation order\n- Note key design decisions and trade-offs\n\nOutput: Create a `.workflow/plan/` directory with a `plan.md` file.\nWrite a structured markdown document with numbered steps.\nDo NOT write any code -- only the plan.",
      "inputs": [],
      "outputs": ["plan"],
      "transitions": [{ "to": "plan_review" }]
    },
    "plan_review": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["plan"],
      "transitions": [
        { "to": "design", "event": "APPROVE" },
        { "to": "plan", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "design": {
      "type": "agent",
      "persona": "architect",
      "prompt": "You are a software architect. Produce a technical design specification.\n\nYour responsibilities:\n- Define module structure, interfaces, and data flow\n- Specify function signatures with TypeScript types\n- Document key design decisions and rationale\n- If there is existing code, design around it\n\nOutput: Create a `.workflow/spec/` directory with a `spec.md` file.\nDo NOT write implementation code.",
      "inputs": ["plan"],
      "outputs": ["spec"],
      "transitions": [{ "to": "design_review" }]
    },
    "design_review": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["spec"],
      "transitions": [
        { "to": "implement", "event": "APPROVE" },
        { "to": "design", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "implement": {
      "type": "agent",
      "persona": "coder",
      "prompt": "You are an implementation engineer.\n\nYour responsibilities:\n- Implement all modules described in the spec\n- Write clean, well-typed TypeScript\n- Create unit tests\n- Run the tests to verify they pass\n\nWrite code directly at the workspace root (e.g., `src/`, `package.json`, `tests/`).\nDo NOT create a separate output directory for code.\nRun all tests to verify everything works.",
      "inputs": ["plan", "spec"],
      "outputs": [],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "critic",
      "prompt": "You are a code reviewer.\n\nYour responsibilities:\n- Verify correctness: does the code at the workspace root match the spec?\n- Check edge cases and error handling\n- Evaluate code quality, naming, and structure\n- Assess test coverage and test quality\n\nOutput: Create a `.workflow/reviews/` directory with a `review.md` file.\nIf issues are found, set verdict to \"rejected\" with specific, actionable feedback.\nIf the code is solid, set verdict to \"approved\".",
      "inputs": ["spec"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "escalate_gate", "guard": "isRoundLimitReached" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "escalate_gate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["reviews"],
      "transitions": [
        { "to": "done", "event": "APPROVE" },
        { "to": "implement", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": {
      "type": "terminal",
      "outputs": ["reviews"]
    },
    "aborted": {
      "type": "terminal"
    }
  }
}
```

Key points:

- The planner and architect say "if there is existing code" — works for both fresh and existing workspaces.
- The coder has `outputs: []` — writes code at the workspace root, not under `.workflow/`.
- The reviewer reads code from the workspace root, writes reviews to `.workflow/reviews/`.
- The terminal `done` state lists `reviews` (not `code`) since code is at the workspace root.

## CLI Integration

```bash
# Fresh workspace (orchestrator creates an empty directory)
ironcurtain workflow start workflow.json "build a palindrome checker"

# Existing repo (user provides the path)
ironcurtain workflow start workflow.json "refactor auth module" --workspace ~/src/myproject
```

### Argument parsing

Add `workspace` to the CLI options:

```typescript
options: {
  model: { type: 'string' },
  workspace: { type: 'string' },
}
```

### Validation (in CLI layer, before calling orchestrator)

The CLI pre-checks with the same validator for an early, readable error; the orchestrator re-validates authoritatively.

```typescript
if (workspaceArg) {
  try {
    workspacePath = validateWorkspacePath(workspaceArg, config.protectedPaths);
  } catch (err) {
    writeStderr(`Invalid workspace: ${err.message}`);
    process.exit(1);
  }
}
```

`ironcurtain workflow run --workspace` (the daemon client) runs the validator client-side before connecting and reports `WORKSPACE_NOT_DIRECTORY` (missing or not a directory) or `WORKSPACE_UNSAFE` (overlaps a trusted location).

### Resume

The workspace path is persisted in the checkpoint. On `resume`, the orchestrator reads it from the checkpoint automatically. No `--workspace` flag needed on resume.

## File Impact List

| File                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/workflow/types.ts`               | Add `workspacePath?: string` to `WorkflowCheckpoint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/workflow/orchestrator.ts`        | Add `workspacePath: string` to `WorkflowInstance`. `start()` gains optional `workspacePath` param; creates workspace at `{baseDir}/{id}/workspace/` when not provided. `artifactDir` always set to `{workspacePath}/.workflow/`. Session creation uses `instance.workspacePath`. `computeOutputHash` gains `workspacePath` param and workspace-root hashing fallback (file listing + mtime, no content reads) for empty `outputs`. Add `WORKSPACE_HASH_EXCLUDED_DIRS` set, `collectFileEntries`, and `hashWorkspaceRoot` helpers. Checkpoint saves `workspacePath`. `resume()` restores `workspacePath` from checkpoint and reconstructs `artifactDir` as `resolve(workspacePath, '.workflow')`. Copy definition to `{baseDir}/{workflowId}/definition.json` in `start()`; read from there in `resume()`. Add `ensureWorkflowGitignored()` helper, called in `start()`. Message log written to `{workspacePath}/.workflow/messages.jsonl` with agent-writable warning comment. |
| `src/workflow/prompt-builder.ts`      | All input path references get `.workflow/` prefix. All output path references get `.workflow/` prefix. Artifact re-prompt paths get `.workflow/` prefix. Remove `artifactPrefix` parameter (not needed — prefix is always `.workflow/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/workflow/validate.ts`            | No changes needed (`outputs: []` already valid)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `examples/workflow-real-demo.json`    | Update to unified model: coder gets `outputs: []`, prompts reference `.workflow/` for artifacts and workspace root for code, `systemPrompt` updated, terminal `done` drops `code` from outputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/designs/workflow-cli-design.md` | Add `--workspace` flag to help spec, examples, and argument table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `examples/workflow-real-spike.ts`     | Parse `--workspace` flag, pass to `orchestrator.start()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Files explicitly NOT changed:

- `src/workflow/machine-builder.ts` — state machine logic is workspace-agnostic
- `src/workflow/guards.ts` — guard predicates are workspace-agnostic
- `src/workflow/status-parser.ts` — agent output parsing is workspace-agnostic
- `src/workflow/checkpoint.ts` — `FileCheckpointStore` serializes whatever `WorkflowCheckpoint` contains
- `src/workflow/artifacts.ts` — `collectFilesRecursive` and `hasAnyFiles` work on any directory path
- `src/workflow/transition.ts` — transition logic is workspace-agnostic

## Implementation Steps

### Step 1: Types and checkpoint

- Add `workspacePath?: string` to `WorkflowCheckpoint` in `types.ts`.
- Existing checkpoints without `workspacePath` fall back to `{baseDir}/{id}/workspace/` on resume.

### Step 2: Orchestrator workspace routing

- Add `workspacePath: string` to `WorkflowInstance`.
- Modify `start()` to accept optional `workspacePath`.
- When not provided: create `{baseDir}/{id}/workspace/`.
- When provided: use directly.
- Always: set `artifactDir = resolve(workspacePath, '.workflow')`, create `.workflow/task/`, write task description.
- Call `ensureWorkflowGitignored(workspacePath)` after creating `.workflow/`.
- Copy definition JSON to `{baseDir}/{workflowId}/definition.json`.
- Write message log to `{workspacePath}/.workflow/messages.jsonl` with agent-writable warning comment.
- Update `saveCheckpoint()` to persist `workspacePath`.
- Update `resume()` to restore `workspacePath` from checkpoint and reconstruct `artifactDir` as `resolve(checkpoint.workspacePath, '.workflow')`. Read definition from `{baseDir}/{workflowId}/definition.json`.
- Add `WORKSPACE_HASH_EXCLUDED_DIRS`, `collectFileEntries`, `hashWorkspaceRoot`, and update `computeOutputHash` to accept `workspacePath` and hash workspace root file listing (paths + mtimes) when `outputs` is empty.

### Step 3: Prompt builder updates

- Add `.workflow/` prefix to all input, output, and re-prompt path references.
- No new parameters needed.

### Step 4: Workflow definition update

- Update `examples/workflow-real-demo.json` to unified model.
- Coder state: `outputs: []`, prompt says "write code at the workspace root".
- All artifact references use `.workflow/` prefix.

### Step 5: CLI integration

- Add `--workspace` flag parsing and validation.
- Pass workspace path to `orchestrator.start()`.
- Update CLI design doc.

Steps 1-3 form a cohesive PR. Step 4 can be bundled with it or separate. Step 5 depends on the CLI command existing.
