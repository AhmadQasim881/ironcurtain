# Persona System

**Status (2026-11-14):** Implemented (`src/persona/`, `ironcurtain persona`).

> **Note (2026-03):** References to `memory.md` and `workspace/memory.md` in this document are historical. Persistent agent memory is now handled by the memory MCP server (see `memory-mcp-server-v2.md`). The persona workspace directory still exists but no longer contains a `memory.md` file.

## Overview

A persona is a named profile that bundles a constitution and compiled policy under a stable directory inside `~/.ironcurtain/personas/<name>/`. When a session is created with a persona, its `policyDir` points to the persona's `generated/` subdirectory, reusing the existing per-session policy override mechanism. Personas also support optional MCP server filtering -- each persona can declare which servers from the global `mcp-servers.json` are enabled or disabled, so an "exec-assistant" persona can operate with gmail and calendar servers while a "coder" persona operates with filesystem and github.

The design is deliberately thin: a persona is a named `policyDir` resolver plus an optional server filter. All compilation, loading, and enforcement infrastructure already exists.

## Motivation

Today IronCurtain has one global policy for interactive sessions and per-job policies for cron. Users who interact with IronCurtain across different contexts -- coding, email triage, research -- want different security postures without manually switching constitutions and recompiling. Cron jobs solve this for scheduled work, but interactive sessions (CLI, Signal, mux) have no equivalent. Personas fill this gap with minimal new machinery.

## Directory Layout

```
~/.ironcurtain/
  personas/
    exec-assistant/
      constitution.md          # persona-specific constitution text
      persona.json             # metadata + server filter config
      generated/
        compiled-policy.json   # output of persona compilation
        dynamic-lists.json     # optional, same as global pipeline
      workspace/               # persistent workspace across sessions
        memory.md              # agent-readable/writable memory file
    coder/
      constitution.md
      persona.json
      generated/
        compiled-policy.json
      workspace/
        memory.md
  .persona-trash/              # soft-deleted personas (persona trash list|restore|purge)
    old-helper-2026-11-12T10-04-05-123Z/
```

Personas live under `~/.ironcurtain/personas/`, which is already covered by the IronCurtain home directory's protected-path rule. The agent cannot modify persona configuration files (`constitution.md`, `persona.json`, `generated/`). However, `workspace/` (including `workspace/memory.md`) is writable by the agent — it is the persona's persistent state.

Tool annotations (`tool-annotations.json`) remain global -- they describe MCP tool schemas, not policy. Persona compilation reads annotations from the global generated directory, same as cron job compilation.

## Persona Definition

### persona.json

```jsonc
{
  "name": "exec-assistant",
  "description": "Email triage, calendar management, and document review",
  "createdAt": "2026-03-06T12:00:00.000Z",
  // Optional: only these MCP servers are available (allowlist)
  "servers": ["filesystem", "fetch", "gmail", "google-calendar"],
  // Optional: agent model and resource limits for this persona's sessions
  // (see "Per-Persona Agent Model and Resource Limits" below)
  "agentModelId": "anthropic:claude-haiku-4-5",
  "resourceBudget": { "maxEstimatedCostUsd": 1, "maxSteps": 60 }
}
```

Other optional fields: `memory` (`{"enabled": false}` opts the persona out of memory), `allowBroadPolicy` (`true` is the broad-policy opt-in, set only through the gated opt-in flows) and `memoryNamespace` (written by `persona rename`, see below).

#### Validation

`loadPersona` (`src/persona/resolve.ts`) reads persona.json only through `readPersonaDefinition` (`src/persona/persona-definition.ts`), so sessions, cron jobs, workflows, compiles, the CLI, the web UI and `ironcurtain doctor` judge a definition the same way. The file is validated with a strict zod schema and refused, never coerced, with error code `PERSONA_INVALID` and one line per problem:

- `name` must equal the persona's directory name. A persona directory copied by hand keeps the original's name; trusting it would send the copy's edits (and its sessions' policy and workspace lookups) to the original, and a name such as `"../x"` would point outside `personas/`. Every path operation uses the directory name. The error names the fix: set the name and recompile, or remove the copy and run `ironcurtain persona clone <original> <copy>`.
- `description` is a string, `createdAt` an ISO 8601 timestamp, `servers` an array of server names (a bare string such as `"github"` used to match server names character by character), `memory` is `{"enabled": <boolean>}`, `allowBroadPolicy` a boolean (the string `"false"` is truthy) and `memoryNamespace` a slug.
- An unknown field is refused (a misspelled `"server"` would otherwise silently mean "all servers").
- `agentModelId` and `resourceBudget` are known fields whose values are left to `readPersonaOverrides()`, which checks them wherever they take effect (see "Per-Persona Agent Model and Resource Limits" below): a malformed value refuses the persona's sessions with `PERSONA_OVERRIDES_INVALID`, while the persona itself still loads, so `persona set` can repair it and `persona show` and `ironcurtain doctor` can report it. Neither value is ever coerced.

Whether the listed servers are configured is checked when a persona is created (below), not on load: a server removed from the configuration later must not make its personas unloadable. `persona list` reports directories under `personas/` whose persona.json is missing or invalid; pickers and `personas.list` leave them out.

### PersonaDefinition type

```typescript
/**
 * Regex for valid persona names: 1-63 chars, lowercase alphanumeric,
 * hyphens, or underscores. Same rules as JobId.
 */
export const PERSONA_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Branded persona name to prevent mixing with other string identifiers. */
export type PersonaName = string & { readonly __brand: 'PersonaName' };

export function createPersonaName(raw: string): PersonaName {
  if (!PERSONA_NAME_PATTERN.test(raw)) {
    throw new Error(
      `Invalid persona name "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
  return raw as PersonaName;
}

/**
 * Persisted persona definition. Stored as JSON at
 * ~/.ironcurtain/personas/{name}/persona.json and read only through
 * loadPersona, which validates it (see Validation above).
 */
export interface PersonaDefinition {
  /** Always the persona's directory name. */
  readonly name: PersonaName;
  readonly description: string;
  readonly createdAt: string;
  /**
   * Optional allowlist of MCP server names from the global
   * mcp-servers.json. When set, only these servers are available.
   * When omitted, all global servers are enabled (default).
   * The "filesystem" server is always included regardless.
   */
  readonly servers?: readonly string[];
  readonly memory?: { readonly enabled: boolean };
  /** The namespace in the persona's own memory.db; absent = the persona name. */
  readonly memoryNamespace?: string;
  readonly allowBroadPolicy?: boolean;
}
```

### MCP Server Filtering

When a persona specifies a `servers` allowlist, the session factory filters the config's `mcpServers` map before spawning MCP server processes. The filtering happens in `buildSessionConfig()` after the existing deep-clone of `mcpServers`:

```typescript
function applyServerAllowlist(
  mcpServers: Record<string, MCPServerConfig>,
  allowlist: readonly string[],
): Record<string, MCPServerConfig> {
  const filtered: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (allowlist.includes(name) || name === 'filesystem') {
      filtered[name] = config;
    }
  }
  return filtered;
}
```

The `filesystem` server is always included even if omitted from the allowlist. This is a hardcoded safety invariant: the agent sandbox requires filesystem access to function, and the policy engine's structural invariants (protected paths, sandbox containment) depend on the filesystem server being present.

Only allowlists are supported — no denylists. This simplifies security reasoning: when a new server is added to the global config, it is not available to any persona unless explicitly opted in. Denylists would silently grant access to newly added servers.

Server filtering only affects which MCP servers are spawned. It does not affect tool annotations (which remain global) or the policy engine's structural invariants (which apply regardless).

## Persistent Workspace and Memory

### Persistent Workspace

Each persona gets a persistent `workspace/` directory at `~/.ironcurtain/personas/<name>/workspace/`. When a session is created with a persona, this workspace is passed as `workspacePath` to `createSession()`, replacing the ephemeral per-session sandbox. This means:

- Files the agent creates persist across Signal sessions
- The agent always starts in a familiar working directory
- Downloaded documents, drafts, and working files survive session boundaries

The `workspace/` directory is created during `ironcurtain persona create`. The existing `workspacePath` override in `buildSessionConfig()` already handles this — it replaces `sandboxDir` as `allowedDirectory` and patches the filesystem MCP server args.

```typescript
// In resolvePersona(), also return the workspace path:
export function resolvePersona(nameRaw: string): {
  policyDir: string;
  persona: PersonaDefinition;
  workspacePath: string;
} {
  // ...
  return {
    policyDir: generatedDir,
    persona: loadPersona(name),
    workspacePath: resolve(getPersonaDir(name), 'workspace'),
  };
}
```

In `buildSessionConfig()`, when a persona is resolved, its workspace is used automatically:

```typescript
if (opts.persona) {
  const resolved = resolvePersona(opts.persona);
  policyDir = resolved.policyDir;
  serverAllowlist = resolved.persona.servers;
  // Use persona workspace unless an explicit workspacePath was provided
  if (!opts.workspacePath) {
    opts.workspacePath = resolved.workspacePath;
  }
}
```

### Memory File

Each persona has a `memory.md` file at `~/.ironcurtain/personas/<name>/memory.md`, created empty during `ironcurtain persona create`. The agent is instructed to use it via `systemPromptAugmentation`:

```typescript
function buildPersonaSystemPromptAugmentation(persona: PersonaDefinition, memoryPath: string): string {
  const memoryContent = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf-8') : '';

  return `
## Persona: ${persona.name}

${persona.description}

## Persistent Memory

You have a persistent memory file at: ${memoryPath}
This file survives across sessions. Use it to remember important context:
- User preferences and patterns
- Ongoing tasks and their status
- Key decisions and their reasoning
- Names, dates, and recurring items

Read this file at the start of each session to recall prior context.
Before the session ends, update it with anything worth remembering.
Keep it concise and organized — this is your long-term memory.

${memoryContent ? `### Current Memory Contents\n\n${memoryContent}` : 'The memory file is currently empty — this is your first session.'}
`;
}
```

The memory file lives at `workspace/memory.md`. The system prompt augmentation reads it at session start and includes its contents, and the agent can also read and write it directly via filesystem tools during the session. This is simple, requires no extra hooks, and matches the actual implementation.

### Security Considerations for Workspace and Memory

- The persona workspace is writable by the agent — this is intentional. The policy engine's structural invariants (protected paths) still apply: `~/.ironcurtain/personas/<name>/constitution.md`, `persona.json`, and `generated/` are outside the workspace and protected.
- The `workspace/` directory is the persona's `allowedDirectory`. Path containment checks prevent the agent from escaping to other personas' workspaces or the parent `personas/` directory.
- Memory content is included in the system prompt, so it counts against context window limits. Large memory files should be summarized periodically by the agent.

## CLI Commands

New subcommand group: `ironcurtain persona <action>`.

### `ironcurtain persona create <name>`

Creates a new persona with an interactive flow mirroring the cron job wizard (named `cron create` in this design; as built, `ironcurtain daemon add-job`):

1. Prompt for description (or accept via `--description`)
2. Prompt for server allowlist (multi-select from available servers in `mcp-servers.json`)
3. Offer to auto-generate a constitution from the description (same as cron job flow)
4. If accepted, present the generated constitution for review: accept / customize / discard
5. If customized or discarded, open the interactive LLM customizer loop
6. Compile the final constitution into policy
7. Create `workspace/` directory and empty `workspace/memory.md`

```
$ ironcurtain persona create exec-assistant
◆ Description: Email triage, calendar management, and document review
◆ Select MCP servers:
  ◻ filesystem (always included)
  ◼ gmail
  ◼ google-calendar
  ◻ github
◆ Generate a constitution automatically from the description? Yes
◐ Generating constitution...
┌ Generated Constitution
│ ...
└
◆ What would you like to do?
  ● Accept
  ○ Customize interactively
  ○ Discard and write manually
◐ Compiling policy...
✔ Persona "exec-assistant" created and compiled.
```

Options:
- `--description <text>` -- set the description (skip prompt)
- `--servers <s1,s2>` -- set the server allowlist (skip multi-select). Every name must be a configured server (the package's `mcp-servers.json` plus the user's `~/.ironcurtain/mcp-servers.json`, as `ironcurtain mcp list` shows them); an unknown one is refused before any prompt (`validatePersonaServers`, which `createPersona` also applies for the web UI's `personas.create`, there as `INVALID_PARAMS`)
- `--no-generate` -- skip auto-generation, open `$EDITOR` directly

### `ironcurtain persona list`

Lists all personas with their description and compilation status.

```
$ ironcurtain persona list
  exec-assistant   Email triage and calendar       compiled
  coder            Software development            not compiled
```

Directories under `personas/` that have a persona name but a missing or invalid persona.json (typically a persona directory copied by hand) are listed after the personas, under "Persona directories that cannot be used", with the loader's reasons.

### `ironcurtain persona compile <name> [--allow-broad]`

Compiles the persona's `constitution.md` into policy rules, writing output to the persona's `generated/` directory. The compile runs through `runPersonaCompile` (`src/persona/persona-compile-service.ts`), the same path as a web-UI compile: it holds the persona's compile lock (a compile of the same persona running in the daemon refuses this one, and vice versa), runs the broad-policy validator before anything is written, is aborted at the 20-minute wall-clock cap, and records the compile in the policy-mutation audit log. See §4.3a of [web-ui-policy-persona-management.md](web-ui-policy-persona-management.md).

```
$ ironcurtain persona compile exec-assistant
Compiling policy for persona "exec-assistant"...
Done.
```

A result that grants broad access (a broad wildcard domain or list, a `paths.within` outside the persona's workspace, or an `allow` rule that leaves a resource argument unconstrained) is not written unless the persona has opted in to broad policies. The command prints what is broad and exits 1; `--allow-broad` sets the persona's opt-in (`allowBroadPolicy: true`, audited) and compiles; refused because another compile of the persona is running, it changes nothing. Exit status 2 means the policy was written but some servers failed and have no rules. `persona create` and `persona edit` ask before setting the opt-in, and `persona edit` can clear it again.

### `ironcurtain persona edit <name>`

Opens the persona's `constitution.md` in `$EDITOR`. After the editor exits, prompts to recompile if the file changed. Every edit (customizer, editor, generation, memory, broad-policy toggle) writes to the persona's directory name; a persona whose persona.json is invalid is refused before anything is written.

### `ironcurtain persona clone <source> <name> [--description <text>]`

Creates `<name>` as an independent copy of `<source>`'s configuration: its constitution (verbatim), description (unless `--description` is given), server allowlist, memory setting, agent model and resource limits, and `skills/` (links inside it are copied as they are, so a relative link resolves inside the clone, never into the source). The copy is built atomically like `persona create`. The agent model and limits are copied as sessions validate them: a malformed one refuses the clone (`PERSONA_OVERRIDES_INVALID`; fix the source with `persona set`) instead of being copied, and none is dropped, since a clone without the source's cost cap would run on looser limits. The `clonePersona` audit record carries the copied `agentModelId` and `resourceBudget` as a `setPersonaOverrides` record does. Not copied: the compiled policy (it was compiled for the source's workspace path; compile the clone), the workspace, `memory.db` and the broad-policy opt-in (set only through the gated opt-in flows, never inherited). This is the supported way to copy a persona; a copied directory is refused (see Validation).

### `ironcurtain persona rename <name> <new-name>`

Moves the whole persona directory (constitution, workspace, `memory.db`, skills) to `personas/<new-name>/` and rewrites persona.json for the new name. The compiled policy is moved aside to `generated/compiled-policy.revoked.json`: it names the old workspace path, so it would either grant access to a directory that is no longer this persona's (and could become another persona's) or be refused, and sessions refuse the persona until it is recompiled. persona.json records the old name as `memoryNamespace`, so the persona's sessions keep seeing the memories stored under its old name (in its own `memory.db`, never another persona's). The rename holds the persona's compile lock (refused while a compile runs). Cron jobs, workflow definitions and running sessions that name the old persona do not follow it.

### `ironcurtain persona delete <name>`

Removes the persona directory permanently after confirmation (refused while the persona is being compiled). The web UI's `personas.delete` soft-deletes by default instead, into the trash below.

### `ironcurtain persona trash list|restore|purge`

A soft delete (the web UI's default, or the persona a forced restore replaced) moves the persona directory, workspace and `memory.db` included, to `~/.ironcurtain/.persona-trash/<name>-<timestamp>/`, outside `personas/`, so nothing lists, resolves or loads it.

- `trash list` shows each entry with the persona's name, deletion time, description and expiry; an entry whose persona.json cannot be used says why.
- `trash restore <entry|name> [--as <name>] [--force]` restores an entry (a persona name selects its newest entry). The entry's persona.json is validated again and must name the persona it was deleted as. A persona with the target name is never overwritten: the restore is refused unless `--force`, which first moves that persona to the trash (recoverable; it is put back if the restore then fails). `--as` restores under another name, which re-labels the persona as a rename does (compiled policy moved aside, memory namespace kept). A restore under the same name keeps the compiled policy; while the persona is in the trash, `ironcurtain mcp add|remove` strip a server name from its policy as from an active persona's, so a restore never brings back rules an earlier server of a name left for a new server of that name.
- `trash purge <entry|name>... | --expired | --all [--yes]` permanently removes entries after showing them and asking (`--yes` skips the question). A purge first renames every entry it removes to a `.purging-<id>-<uuid>` remnant in the trash directory, which is never listed or restored, and only then deletes the files; a restore running meanwhile finds the whole entry or nothing, never a half-deleted persona. Files that cannot be deleted (or a purge cut short) stay in the remnant, the purge reports them, and the next purge deletes them. `--expired` selects the entries older than `personas.trashRetentionDays` in `config.json` (default 30 days; `null` keeps entries until purged by hand).

The retention sweep (purging expired entries) runs after every move into the trash, so the trash only grows within the retention window. Restore, purge and the sweep take effect at the service layer (`persona-service.ts`), so the CLI and the web UI's `personas.listTrash` / `restoreTrash` / `purgeTrash` behave the same; each restore and each purged entry is recorded in the policy-mutation audit log.

### `ironcurtain persona show <name>`

Prints the persona's metadata, its agent model and resource limits (or that it inherits them, or why they are invalid) and its constitution to stderr.

### `ironcurtain persona set <name> [options]`

Sets or removes the persona's `agentModelId` and `resourceBudget` without prompting: `--model <id>` / `--clear-model`, and per limit `--max-tokens`, `--max-steps`, `--max-session-seconds`, `--max-cost`, `--warn-threshold`, each taking a number, `none` (disable the limit for the persona's sessions; not for the warn threshold) or `inherit` (remove the persona's value). `--clear-limits` removes every limit. The write goes through `setPersonaOverrides()` in the persona service, which validates the result exactly as sessions do and records a `setPersonaOverrides` entry in the hash-chained policy-mutation audit log: the model (`agentModelId`, `null` when removed) and the limits (`resourceBudget`, as JSON with sorted keys, `null` when removed), so the entry's details stay flat and `ironcurtain audit verify` checks it like any other.

### CLI Registration

In `src/cli.ts`, add a `persona` case:

```typescript
case 'persona': {
  const { main } = await import('./persona/persona-command.js');
  await main(args); // the arguments after the command name
  break;
}
```

## Session Integration

### Resolving a persona to a policyDir

The core integration is a single utility function:

```typescript
// src/persona/resolve.ts

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from './types.js';

export function getPersonaDir(name: PersonaName): string {
  return resolve(getIronCurtainHome(), 'personas', name);
}

export function getPersonaGeneratedDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'generated');
}

export function getPersonaConstitutionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'constitution.md');
}

/**
 * Loads a persona definition from disk, validated against the persona.json
 * schema (src/persona/persona-definition.ts); its `name` is always the
 * directory name. Throws PERSONA_NOT_FOUND when persona.json does not exist,
 * PERSONA_INVALID when it cannot be used.
 */
export function loadPersona(name: PersonaName): PersonaDefinition { ... }

/**
 * Resolves a persona name to a validated policyDir, workspace path,
 * and persona definition.
 *
 * @throws if persona does not exist, or ScopedPolicyError when its
 *   compiled policy is missing (POLICY_MISSING) or no longer matches
 *   constitution.md (POLICY_STALE) and allowStalePolicy was not given
 */
export function resolvePersona(
  nameRaw: string,
  options: { allowStalePolicy?: boolean } = {},
): ResolvedPersona {
  const name = createPersonaName(nameRaw);
  const persona = loadPersona(name);

  // Recomputes sha256(constitution.md) and compares it with the
  // compiled policy's constitutionHash on every call.
  const state = getPersonaPolicyState(name);
  if (state.kind === 'missing') {
    throw new ScopedPolicyError(
      `Persona "${name}" has no compiled policy. Run: ironcurtain persona compile ${name}`,
      'POLICY_MISSING',
    );
  }
  if (state.kind === 'stale' && options.allowStalePolicy !== true) {
    throw new ScopedPolicyError(`Persona "${name}" has a stale compiled policy: ...`, 'POLICY_STALE');
  }

  return {
    policyDir: getPersonaGeneratedDir(name),
    persona,
    workspacePath: getPersonaWorkspaceDir(name),
    // set only for an allowed stale policy; the caller warns
    ...(state.kind === 'stale' ? { stalePolicy: { reason: state.reason, detail: state.detail } } : {}),
  };
}
```

### SessionOptions extension

Add an optional `persona` field to `SessionOptions`:

```typescript
export interface SessionOptions {
  // ... existing fields ...

  /**
   * Persona name. When set, resolves to a policyDir and optional
   * server filter. Mutually exclusive with policyDir -- if both
   * are provided, persona takes precedence with a warning.
   */
  persona?: string;
}
```

In `buildSessionConfig()`, resolve the persona early:

```typescript
function buildSessionConfig(config, effectiveSessionId, sessionId, opts) {
  let { policyDir, workspacePath, systemPromptAugmentation } = opts;
  let serverAllowlist: readonly string[] | undefined;

  if (opts.persona) {
    const resolved = resolvePersona(opts.persona);
    if (policyDir) {
      logger.warn('Both persona and policyDir specified; using persona.');
    }
    policyDir = resolved.policyDir;
    serverAllowlist = resolved.persona.servers;

    // Use persona workspace unless an explicit workspacePath was provided
    if (!workspacePath) {
      workspacePath = resolved.workspacePath;
    }

    // Build persona system prompt augmentation (includes memory contents)
    const personaAugmentation = buildPersonaSystemPromptAugmentation(
      resolved.persona,
      resolve(resolved.workspacePath, 'memory.md'),
    );
    systemPromptAugmentation = systemPromptAugmentation
      ? `${personaAugmentation}\n\n${systemPromptAugmentation}`
      : personaAugmentation;
  }

  if (policyDir) validatePolicyDir(policyDir);

  // ... existing setup (uses workspacePath and systemPromptAugmentation) ...

  // Apply server allowlist if persona specifies one
  if (serverAllowlist) {
    sessionConfig.mcpServers = applyServerAllowlist(sessionConfig.mcpServers, serverAllowlist);
  }

  // ... rest of existing code ...
}
```

This is the only integration point in the session layer. All downstream code (policy loading, proxy spawning, MCP client connections) sees the filtered `mcpServers` map, the persona's workspace, and the memory-augmented system prompt transparently.

### CLI: `ironcurtain start --persona <name>`

Add a `--persona` option to `parseArgs` in `src/index.ts`:

```typescript
persona: { type: 'string', short: 'p' },
```

Pass it through to `createSession()`:

```typescript
const session = await createSession({
  config,
  mode,
  persona: values.persona as string | undefined,
  // ... existing options ...
});
```

### Signal: `/new <persona>`

Extend the `/new` command in `SignalBotDaemon.handleControlCommand()` to accept an optional persona argument:

```typescript
// Current: /new
// New:     /new [persona-name]
const newMatch = lower.match(/^\/new(?:\s+(\S+))?$/);
if (newMatch) {
  const personaName = newMatch[1]; // undefined if bare /new
  this.scheduleSessionOp(async () => {
    try {
      await this.startNewSession(personaName);
    } catch (err: unknown) { ... }
  });
  return true;
}
```

In `startNewSession()`, pass `persona` through to `createSession()`:

```typescript
private async startNewSession(persona?: string): Promise<number> {
  // ... existing concurrency check ...
  const session = await createSession({
    config,
    mode: this.mode,
    persona,
    // ... existing callbacks ...
  });
  // ... existing registration ...
}
```

Update the `/help` output to show: `/new [persona] - start a new session (optionally with a persona)`.

### Mux: deferred

Mux persona support is deferred to a follow-up PR. The mux uses a picker-mode state machine for session creation, requiring changes to `MuxInputHandler`, `MuxAction`, `PtyBridgeOptions`, and `createPtyBridge()`. Once `--persona` works on the CLI, the mux integration is straightforward but not blocking for the initial release.

(The picker has since shipped. Each mux tab is an `ironcurtain start --pty --persona <name>` child, so it resolves the persona's agent model and limits like any `start` session; the picker shows a persona's `agentModelId` next to its description and, like an uncompiled or stale persona, does not offer one whose overrides are malformed. See "Per-Persona Agent Model and Resource Limits".)

### Cron: `persona` field in JobDefinition

Add an optional `persona` field to `JobDefinition`:

```typescript
export interface JobDefinition {
  // ... existing fields ...

  /**
   * Optional persona name. When set, the job uses this persona's
   * compiled policy instead of its inline taskConstitution.
   * Mutually exclusive with taskConstitution -- if persona is set,
   * taskConstitution is ignored for policy loading (but still used
   * as the system prompt augmentation if present).
   */
  readonly persona?: string;
}
```

When the daemon creates a cron session and `job.persona` is set, it resolves the persona and passes `persona` in `SessionOptions` instead of `policyDir: jobGeneratedDir`. This lets cron jobs share a persona's policy without maintaining a separate constitution.

The `taskConstitution` field remains the primary path for cron jobs. The `persona` field is a convenience for jobs that want to reuse an existing persona rather than defining their own policy inline.

## Per-Persona Agent Model and Resource Limits

A persona may set the agent model and the resource limits of its sessions:

```typescript
export interface PersonaDefinition {
  // ... existing fields ...
  /** "provider:model-name", a bare ID, or a gateway "name:tag" ID. */
  readonly agentModelId?: string;
  /** Same fields as config.json's resourceBudget (no model prices); null disables a limit. */
  readonly resourceBudget?: Partial<ResolvedResourceBudgetConfig>;
}
```

### Precedence

Both sit below everything a caller sets explicitly and above the global defaults (`src/session/model-budget-precedence.ts`):

- **Agent model**, highest first: `--model` on the command line (`ironcurtain start`, and so the `start --pty` children of the mux and the web UI; `ironcurtain workflow start|resume-standalone|run-state`) > the workflow state's `model` > the workflow's `settings.model` > the persona's `agentModelId` > the global `agentModelId`. Callers collapse the first three into `SessionOptions.agentModelOverride` (the workflow session factory puts `--model` over the orchestrator's `state.model ?? settings.model`); `buildSessionConfig` applies the persona's model only when that override is absent.
- **Resource limits**, field by field, highest first: the limits the caller sets explicitly (`SessionOptions.resourceBudgetOverrides`: a workflow's `settings.resourceBudget`, a cron job's `budgetOverrides`) > the persona's `resourceBudget` > the caller's own defaults (`SessionOptions.resourceBudgetBaseline`: the global/default limits a workflow run saved at start, the cron defaults) > the config's `resourceBudget`.

The workflow orchestrator splits a run's saved limits by their recorded source (`workflowSessionBudgetOptions` in `src/workflow/resource-budget.ts`): a limit the workflow sets stays an override, one the run inherited becomes the baseline, so a state's persona can tighten or loosen only what the workflow left to the defaults. The run's budget panel still shows the run-level limits; a state's session may run with its persona's value for an inherited field.

### Where it applies

`buildSessionConfig` resolves both once for every entry point (`ironcurtain start`, `start --pty` and therefore the mux and web UI terminals, Signal `/new <persona>`, web `sessions.create` in code mode, cron jobs with `persona`, workflow states). The chosen model goes into both `config.agentModelId` and `config.userConfig.agentModelId`, and into `SessionDirConfig.agentModelOverride`, which the builtin and container sessions pass to every agent turn; it is also the agent model the host-model roles fall back to (auto-compaction's summary model without credentials, `src/session/host-model-roles.ts`). The layered limits go into `config.userConfig.resourceBudget`, which the budget trackers read, and which a standalone container session's MITM budget gate (`src/docker/budget-gate.ts`) takes its token and cost limits from. A workflow's shared-container bundle keeps the run's limits as its container-wide gate, so there a state persona's tighter token or cost limit is enforced between turns (the session's own budget check) while the gate bounds a turn in flight at the run's limit. The agent adapter registry is process-wide (one adapter per agent, registered by whichever session needs it first, in a daemon possibly a persona session), so adapters capture no configuration: the Claude Code adapter derives `IRONCURTAIN_MODEL` for an interactive PTY from the session config it is given, and `DockerAgentSession` passes the session config's own `agentModelId` to `buildCommand` on every batch turn, so a global-model session started after a persona session does not inherit the persona's model. `ironcurtain start` additionally applies the persona's model to its config before the mode preflight, so the builtin agent's API-key check and the host-model role checks see the model the session will run.

### Validation

The persona.json schema (`src/persona/persona-definition.ts`, see "Validation" above) knows both fields but carries their values unchecked, so a malformed value never makes the persona unloadable. `readPersonaOverrides()` (`src/persona/persona-overrides.ts`) validates both whenever they are about to take effect: `agentModelId` with the workflow model-ID grammar, in printable ASCII without spaces, and never an agent name (`claude-code`, `goose`, `codex`); `resourceBudget` with config.json's limit schema, strict (an unknown field is an error). A malformed value fails closed: the session is refused before anything is created for it (`PersonaOverridesError`, code `PERSONA_OVERRIDES_INVALID`), rather than silently running on the global model or limits. `ironcurtain start` exits with the message before its preflight, a cron job with `persona` is refused before its git sync with the usual "Not run" notice (`findPersonaOverridesProblem`), and a workflow is refused at start, before its first state runs, when any agent state's persona has one (the orchestrator's persona pre-check names each such persona and the states that use it, next to any persona that does not exist). `persona show`, the mux picker and `ironcurtain doctor` (its persona check, `lintPersonaDefinition`) report the problem; `persona set` and `setPersonaOverrides()` never write a value that would be refused, and `persona clone` refuses to copy one. The other operations that rewrite persona.json (the memory and broad-policy toggles, `persona rename`, a trash restore under another name) keep both fields as they are.

## Constitution Authoring

Persona constitution authoring reuses the existing cron job infrastructure with minimal adaptation.

### Shared Components

The cron job flow already provides three reusable building blocks:

1. **`constitution-generator.ts`** — `generateConstitution()` runs an LLM under read-only policy to explore MCP servers and produce a draft constitution from a description. The generator currently has cron-specific framing baked into its system prompt (e.g., "this is an unattended cron job", "escalation effectively means block"). For personas (which are interactive sessions with a human present), escalation is meaningful.

   **Required refactor**: `buildConstitutionGeneratorSystemPrompt()` must accept a `generationContext` parameter that controls the framing:
   - `'cron'`: current behavior — unattended, escalation ≈ block, auto-allow task operations
   - `'persona'`: interactive session — escalation is valid for risky operations, human is present to approve

   The structural rules section (workspace auto-allow, default-deny) and the output format are shared. Only the "Critical Context" paragraph and the escalation guidance differ. `ConstitutionGeneratorOptions` gains an optional `context?: 'cron' | 'persona'` field (defaults to `'cron'` for backward compatibility). The persona context also makes workspace exploration optional since there may be no meaningful workspace at persona creation time.

2. **`constitution-customizer.ts`** (pipeline) — Shared utilities (`buildSystemPrompt`, `buildUserMessage`, `callLlm`, `applyChanges`, `computeLineDiff`, `formatDiff`) for the interactive LLM refinement loop. Already operates on in-memory strings.

3. **`job-customizer.ts`** (cron) — `runJobConstitutionCustomizer()` wraps the shared customizer with task-specific context in the system prompt. A persona equivalent (`runPersonaConstitutionCustomizer()`) follows the same pattern, replacing "task context" with "persona context" (description, server allowlist).

### Persona-Specific Adapter

```typescript
// src/persona/persona-customizer.ts

export function buildPersonaCustomizerSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  personaDescription: string,
  serverAllowlist?: readonly string[],
  githubIdentity?: GitHubIdentity | null,
): string {
  const basePrompt = buildSystemPrompt(baseConstitution, toolAnnotations, githubIdentity);

  const serverContext = serverAllowlist
    ? `\nThis persona only has access to these MCP servers: ${serverAllowlist.join(', ')}.`
    : '';

  return `${basePrompt}

## Persona Context

This constitution is for a persona with the following purpose:

${personaDescription}
${serverContext}

Focus your suggestions on what this persona needs. Grant the minimum
permissions required for the persona's purpose.`;
}

export async function runPersonaConstitutionCustomizer(
  initialConstitution: string,
  personaDescription: string,
  serverAllowlist?: readonly string[],
): Promise<string | undefined> {
  // Same structure as runJobConstitutionCustomizer, different system prompt
}
```

### Create Flow

The `persona create` command orchestrates these components in the same sequence as `job-commands.ts`:

```typescript
// In persona-command.ts, create subcommand:

// 1. Prompt for description and servers
// 2. Offer auto-generation
if (shouldGenerate) {
  const result = await generateConstitution({
    taskDescription: description,
    workspacePath: tempWorkspace,
    context: 'persona',  // interactive framing, escalation is meaningful
  });
  // 3. Present result: accept / customize / discard
  if (action === 'accept') {
    constitution = result.constitution;
  } else if (action === 'customize') {
    constitution = await runPersonaConstitutionCustomizer(
      result.constitution, description, servers,
    );
  }
}
// 4. Fallback: open $EDITOR
if (!constitution) {
  constitution = await openInEditor(constitutionPath);
}
// 5. Write constitution.md and compile
```

### Edit Flow

`ironcurtain persona edit <name>` also offers the customizer after editor exit:

```
$ ironcurtain persona edit exec-assistant
Opening constitution in editor...
◆ Constitution changed. What next?
  ● Compile now
  ○ Customize interactively first
  ○ Done (skip compilation)
```

## Policy Compilation

### compilePersonaPolicy()

A thin wrapper around `PipelineRunner`, similar to `compileTaskPolicy()`:

```typescript
// src/persona/compile-persona-policy.ts

import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels } from '../pipeline/pipeline-runner.js';
import { loadConfig } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { getPackageGeneratedDir } from '../config/index.js';
import { getPersonaConstitutionPath, getPersonaGeneratedDir } from './resolve.js';
import type { PersonaName } from './types.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';

export async function compilePersonaPolicy(name: PersonaName): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = getPersonaGeneratedDir(name);
  const constitutionPath = getPersonaConstitutionPath(name);
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const annotationsDir = getUserGeneratedDir();
  const models = await createPipelineModels(outputDir);
  const runner = new PipelineRunner(models);

  return runner.run({
    constitutionInput: constitutionText,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: config.allowedDirectory,
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    includeHandwrittenScenarios: true, // the universal invariants hold for every persona
  });
}
```

The `constitutionInput` receives the file contents (not the path) — `PipelineRunner.run()` expects the constitution as text. The `constitutionKind` is `'constitution'` since persona constitutions are written as broad principles (like the global constitution), not as English task descriptions (`'task-policy'`). This means the compiler uses the full constitution prompt variant, which is the right fit for persona-level policy.

**Note on `allowedDirectory`:** Persona compilation uses the global default `allowedDirectory` from `loadConfig()`. At runtime, the session factory overrides this with the session-specific sandbox. Compiled path rules use the sandbox placeholder pattern, so the compiled policy works with any session sandbox.

### Server-scoped compilation

When a persona has a `servers` filter, only the filtered set of servers should be considered during policy compilation. The `PipelineRunner.run()` call receives `mcpServers`, which is used for structural invariant generation and domain allowlist extraction. Apply the server filter before passing:

```typescript
let mcpServers = config.mcpServers;
const persona = loadPersona(name);
if (persona.servers) {
  mcpServers = applyServerAllowlist(mcpServers, persona.servers);
}

return runner.run({
  // ...
  mcpServers,
});
```

This ensures the compiled policy only references tools from servers the persona will actually use, and the LLM does not generate rules for irrelevant tools.

## File Organization

```
src/persona/
  types.ts                    # PersonaName, PersonaDefinition, PERSONA_NAME_PATTERN
  resolve.ts                  # getPersonaDir, resolvePersona, loadPersona, applyServerAllowlist
  compile-persona-policy.ts   # compilePersonaPolicy wrapper (reached only from persona-compile-service.ts)
  persona-compile-service.ts  # runPersonaCompile: the one compile path (lock, validator, cap, audit)
  policy-breadth-check.ts     # breadth of a compiled policy on disk (load-time check, opt-out)
  persona-customizer.ts       # LLM-assisted constitution customizer (adapts job-customizer)
  persona-prompt.ts           # buildPersonaSystemPromptAugmentation (memory injection)
  persona-overrides.ts        # agentModelId / resourceBudget validation (readPersonaOverrides)
  persona-command.ts          # CLI entry point for `ironcurtain persona` subcommands
```

## Component Relationships

```
CLI (src/cli.ts)
  └─ persona-command.ts ──> resolve.ts, persona-service.ts, persona-customizer.ts,
                             persona-compile-service.ts ──(await import)──> compile-persona-policy.ts

Constitution authoring (reused from cron)
  ├─ constitution-generator.ts  (src/cron/) ──> generateConstitution()
  ├─ constitution-customizer.ts (src/pipeline/) ──> shared LLM refinement utilities
  └─ persona-customizer.ts (src/persona/) ──> persona-specific system prompt adapter

Session factory (src/session/index.ts)
  └─ buildSessionConfig()
       ├─ resolvePersona()  ──> resolve.ts (policyDir + server allowlist)
       ├─ validatePolicyDir()  (existing)
       ├─ applyServerAllowlist()  ──> resolve.ts
       └─ loadGeneratedPolicy()  (existing, uses policyDir)

Signal (src/signal/signal-bot-daemon.ts)
  └─ startNewSession(persona?) ──> createSession({ persona })

Mux (src/mux/mux-app.ts)
  └─ (deferred — will thread --persona through picker UI in follow-up)

Daemon (src/daemon/ironcurtain-daemon.ts)
  └─ onJobTrigger(job)
       └─ if job.persona: createSession({ persona: job.persona })
          else: createSession({ policyDir: jobGeneratedDir })

Pipeline (src/persona/compile-persona-policy.ts)
  └─ PipelineRunner.run()  (existing pipeline infrastructure)
```

## Security Considerations

### Persona name validation

Persona names use the same validation pattern as job IDs (`PERSONA_NAME_PATTERN`): lowercase alphanumeric, hyphens, underscores, 1-63 characters. This prevents path traversal (no `/`, `..`, or special characters) and ensures the persona directory stays under `~/.ironcurtain/personas/`.

### Directory containment

`resolvePersona()` validates that the resolved persona directory is under `~/.ironcurtain/personas/`. The existing `validatePolicyDir()` in `buildSessionConfig()` provides a second layer of defense: the realpath of `policyDir` must be exactly one of the directories IronCurtain compiles policies into (`<home>/generated`, `<home>/personas/<name>/generated`, `<home>/jobs/<id>/generated`, a published task scope `<home>/task-policies/<key>`, or the package's bundled `generated/` and `generated-readonly/`), never another place in the home such as an agent-writable session sandbox or workspace, and it and the directories above it must not be writable by another user. A `policyDir` that does not exist yet is left to the caller's "no compiled policy" check, but the directory it would be created in must pass the same ownership rules, and a path that leads through a dangling symlink is refused (its target could appear later, in a sandbox say). The policy artifacts in it are read without following a symlink at their names, with the same owner and mode checks.

### Compiled policy required, and it must be current

`resolvePersona()` refuses to return a `policyDir` for a persona that has no `compiled-policy.json`. This prevents sessions from falling through to the global policy when the user intended a persona-specific policy. The error message tells the user exactly what command to run.

It also refuses a stale policy: `compiled-policy.json` records the sha256 of the `constitution.md` text it was compiled from (`constitutionHash`), and `getPersonaPolicyState()` recomputes that hash from disk on every call (`src/config/constitution-hash.ts`, no pipeline import). A policy whose hash does not match the current constitution, records none, or cannot be read is stale (`ScopedPolicyError` with code `POLICY_STALE`), so a narrowed constitution can never keep enforcing the older, broader rules without the user noticing. Unattended callers (cron jobs, workflow states) always refuse. An interactive session may run a stale persona only on an explicit override, `ironcurtain start --persona <name> --allow-stale-policy` (also honored on `--resume`), which prints a warning and records it in the session log; the mux picker and the web UI session launcher show such personas as stale and do not offer them. `persona list`, `persona show`, `personas.list` and `personas.get` report the stale state (`stale: 'constitution'`; `'engine'` is reserved: compiled policies now record their provenance, but it is checked when the policy is loaded, governed by `policy.onStale`, see the "Policy Provenance" section of [per-server-policy-compilation.md](per-server-policy-compilation.md)), and `persona edit` warns that sessions refuse the persona until it is recompiled.

Finally, it refuses a policy that grants broad access when the persona has not opted in (`ScopedPolicyError` with code `POLICY_TOO_BROAD`): `resolvePersona` runs the broad-policy validator's LLM-free check on the artifacts on disk (`policy-breadth-check.ts`: the compiled policy and its resolved dynamic lists, judged with the tool annotations in effect), so a policy compiled before CLI compiles ran the validator, a hand-edited `persona.json` or policy file, or an annotation or list change that broadens an existing policy cannot run without the opt-in. No override applies, `--allow-stale-policy` included. Clearing the opt-in (`personas.setBroadPolicyOptIn`, `persona edit`) moves a broad compiled policy aside to `generated/compiled-policy.revoked.json`, so the persona has no compiled policy until it is recompiled.

### Server filter safety

The `filesystem` server is never filtered out (hardcoded exception in `applyServerAllowlist`). If a persona's allowlist omits `filesystem`, it is silently added back. This preserves the sandbox invariant.

Server names in the allowlist are validated against the configured servers (the package's `mcp-servers.json` plus the user's `~/.ironcurtain/mcp-servers.json`, as loaded by `loadConfig()`; `listPersonaServerNames` in `persona-service.ts`) when the persona is created: `createPersona` refuses an unknown name (`PERSONA_UNKNOWN_SERVERS`, `INVALID_PARAMS` over the web UI). The web UI's create form offers exactly these names (`personas.listServers`). At session creation time an unknown name (a server removed from the configuration since) produces a warning, not an error, to avoid breaking personas when servers are added or removed from the global config. Matching is by whole name only (persona.json validation guarantees `servers` is an array, and `applyServerAllowlist` matches with a `Set`).

Only allowlists are supported. This ensures new servers added to the global config are never silently available to existing personas — each persona must explicitly opt in.

### Protected paths

Persona directories are already covered by the `~/.ironcurtain/` protected path. The agent cannot read or write persona constitutions or compiled policies.

### No privilege escalation

A persona's compiled policy is still evaluated by the same PolicyEngine with the same structural invariants (protected paths, unknown tool denial, SSRF blocking). A persona cannot grant permissions that structural invariants deny. The most a persona can do is relax the *compiled* rules (e.g., allow writes to broader paths), but structural invariants remain the floor.

## Testing Strategy

### Unit tests

- **resolve.ts**: Test `createPersonaName()` validation (rejects traversal attempts, accepts valid names), `resolvePersona()` error on missing directory, error on uncompiled persona, success with valid persona.
- **applyServerAllowlist()**: Test allowlist filtering, filesystem-always-included invariant, empty allowlist, unknown server names warning.
- **buildSessionConfig() with persona**: Test that persona's policyDir overrides global, server filter is applied, persona + policyDir conflict produces warning.

### Integration tests

- Create a persona, compile it, start a session with `--persona`, verify the session uses the persona's policy (tool calls are evaluated against persona rules, not global rules).
- Signal `/new exec-assistant` creates a session with the exec-assistant persona's policy.

All tests use the existing `SandboxFactory` mock pattern from `SessionOptions` -- no new test infrastructure needed.

## Migration Plan

### PR 1: Types and resolver

- Add `src/persona/types.ts` and `src/persona/resolve.ts`
- Add `getPersonaDir`, `getPersonaGeneratedDir` to `src/config/paths.ts`
- Unit tests for name validation and resolution

### PR 2: CLI commands and constitution authoring

- Add `src/persona/persona-command.ts` with create, list, compile, edit, delete, show
- Add `src/persona/persona-customizer.ts` adapting `job-customizer.ts` for persona context
- Add `src/persona/compile-persona-policy.ts`
- Wire `generateConstitution()` (from `src/cron/constitution-generator.ts`) into the create flow
- Register in `src/cli.ts`

### PR 3: Session integration

- Add `persona` field to `SessionOptions`
- Wire `resolvePersona()` + `applyServerFilter()` into `buildSessionConfig()`
- Add `--persona` flag to `ironcurtain start`
- Update Signal `/new` and cron `JobDefinition`
- Mux persona support deferred to follow-up PR

### PR 4: Documentation and polish

- User-facing docs, help text, examples
- Update `CLAUDE.md` with persona onboarding steps

## Future Extensions

- **Mux persona support**: Thread `--persona` through the mux picker-mode state machine (`MuxInputHandler`, `MuxAction`, `PtyBridgeOptions`, `createPtyBridge()`). Once CLI `--persona` works, this is a UI plumbing task.
- **Persona inheritance**: A persona could extend another persona's constitution, adding or overriding specific rules. Not needed now -- constitutions are small enough to copy.
- **Persona sharing**: Export/import personas as tarballs or from a central registry. The directory structure is self-contained, making this straightforward.
- **Auto-compile on constitution change**: Watch `constitution.md` for changes and trigger recompilation. The content-hash caching in the pipeline makes this cheap when nothing changed.
- **Default persona**: A `defaultPersona` field in `config.json` that applies when no persona is specified, replacing the global policy as the baseline.
