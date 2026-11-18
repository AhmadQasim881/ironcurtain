# Design: User Configuration File

**Status (2026-11-14):** Implemented: `~/.ironcurtain/config.json`, validated by `src/config/user-config.ts` and edited with `ironcurtain config` (`src/config/config-command.ts`). The file has many more settings than this design lists; `CONFIG.md` is the reference.

**Date:** 2026-02-19
**Author:** IronCurtain Engineering

## 1. Problem Statement

IronCurtain's user-facing settings are scattered across multiple locations:

- **LLM model names** are hardcoded in two source files (`agent-session.ts` line 260, `compile.ts` line 587), both using `'claude-sonnet-4-6'`. Changing the model requires editing source code.
- **`ANTHROPIC_API_KEY`** must be set as an environment variable or in `.env`. There is no persistent config file.
- **`ALLOWED_DIRECTORY`** and **`AUDIT_LOG_PATH`** use env-var overrides with hardcoded fallbacks.
- **`IRONCURTAIN_HOME`** defaults to `~/.ironcurtain`, overridable via env var.
- **MCP server definitions** live in `src/config/mcp-servers.json` inside the source tree, not in user-writable config.
- **Escalation timeout** (5 min) and **result size limit** (100KB) are internal constants with no user override.

A single config file at `~/.ironcurtain/config.json` would give users a persistent, inspectable place to customize their installation without editing source or managing shell environment variables.

## 2. What Belongs in Config

### Include (user-facing, installation-specific)

| Setting            | Current location                                      | Why configurable                                               |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------- |
| Agent model ID     | Hardcoded `'claude-sonnet-4-6'` in `agent-session.ts` | Users may want a different model (opus, haiku, future models)  |
| Pipeline model ID  | Hardcoded `'claude-sonnet-4-6'` in `compile.ts`       | May want cheaper model for compilation or premium for accuracy |
| Anthropic API key  | `ANTHROPIC_API_KEY` env var                           | Persistent storage alternative to env var                      |
| Escalation timeout | Hardcoded `5 * 60 * 1000` in `mcp-proxy-server.ts`    | Users who need more time to review escalations                 |

### Exclude (internal constants, not user-configurable)

| Setting                    | Reason to exclude                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `IRONCURTAIN_HOME`         | Must be known _before_ loading config (chicken-and-egg). Keep as env var.           |
| `ALLOWED_DIRECTORY`        | Per-session, derived from session ID. Not a global preference.                      |
| `AUDIT_LOG_PATH`           | Per-session, derived from session ID. Not a global preference.                      |
| Protected paths            | Derived from source tree layout. Changing breaks security invariants.               |
| MCP server definitions     | Kept out of config.json: users add servers in `~/.ironcurtain/mcp-servers.json` (see user-mcp-servers.md). |
| Result size limit          | Already has `RESULT_SIZE_LIMIT` env var. Internal tuning knob, not user preference. |
| Max agent steps            | Safety backstop (100). Loop detector handles the nuanced cases.                     |
| Circuit breaker thresholds | Internal safety mechanism. Wrong values compromise protection.                      |
| Loop detector thresholds   | Internal safety mechanism. Wrong values compromise protection.                      |
| Escalation poll intervals  | Implementation detail. No user-visible effect worth exposing.                       |
| Sandbox timeout            | Derived from escalation timeout. Coupling is an implementation detail.              |

## 3. Schema

```jsonc
// ~/.ironcurtain/config.json
{
  // LLM model used for the interactive agent (AI SDK model ID)
  "agentModelId": "claude-sonnet-4-6",

  // LLM model used for the policy compilation pipeline
  "policyModelId": "claude-sonnet-4-6",

  // Optional: a separate model that generates the policy compile's test
  // scenarios and judges the compiled rules (unset: policyModelId does both)
  "policyVerifierModelId": "openai:gpt-5",

  // Anthropic API key (alternative to ANTHROPIC_API_KEY env var)
  "anthropicApiKey": "<key>",

  // Escalation timeout in seconds (30-600)
  "escalationTimeoutSeconds": 300,
}
```

All fields are optional. Missing fields use defaults. Unknown fields are ignored with a warning to stderr.

> **Later fields.** `egressPolicy` (`{ enabled, allowedHosts }`, opt-in, default off, never backfilled) turns on policy-evaluated MITM egress for Docker sessions; its schema is strict and `allowedHosts` accepts only `*`, `*.domain` or an exact host name. See [`mitm-egress-policy.md`](mitm-egress-policy.md).

### TypeScript Types

```typescript
// src/config/user-config.ts

/** Schema for ~/.ironcurtain/config.json. All fields optional. */
export interface UserConfig {
  readonly agentModelId?: string;
  readonly policyModelId?: string;
  readonly anthropicApiKey?: string;
  readonly escalationTimeoutSeconds?: number;
}

/** Validated, defaults-applied configuration. All fields present. */
export interface ResolvedUserConfig {
  readonly agentModelId: string;
  readonly policyModelId: string;
  readonly anthropicApiKey: string;
  readonly escalationTimeoutSeconds: number;
}

export const USER_CONFIG_DEFAULTS = {
  agentModelId: 'claude-sonnet-4-6',
  policyModelId: 'claude-sonnet-4-6',
  escalationTimeoutSeconds: 300,
} as const;
```

### Validation Rules

| Field                      | Type     | Constraint           | On violation                       |
| -------------------------- | -------- | -------------------- | ---------------------------------- |
| `agentModelId`             | `string` | Non-empty            | Error at startup                   |
| `policyModelId`            | `string` | Non-empty            | Error at startup                   |
| `policyVerifierModelId`    | `string` | Qualified model ID   | Error at startup                   |
| `anthropicApiKey`          | `string` | Non-empty if present | Ignored (falls through to env var) |
| `escalationTimeoutSeconds` | `number` | Integer, 30-600      | Error at startup                   |

Validation uses Zod for consistency with the rest of the codebase. Invalid JSON is a hard error (not silently ignored).

## 4. Resolution Order

Settings are resolved with this precedence (highest wins):

1. **Environment variable** (e.g., `ANTHROPIC_API_KEY`) -- always overrides config file
2. **Config file** (`~/.ironcurtain/config.json`)
3. **Hardcoded defaults**

Rationale: env vars take precedence because they are the standard mechanism for CI, containers, and temporary overrides. The config file is the persistent base. This follows the convention established by tools like npm, Docker, and git.

For the API key specifically:

```
ANTHROPIC_API_KEY env var  >  config.json anthropicApiKey  >  error
```

## 5. Loading Behavior

### New file: `src/config/user-config.ts`

```typescript
export function loadUserConfig(): ResolvedUserConfig;
```

Behavior:

1. Compute config path: `${getIronCurtainHome()}/config.json`
2. If file does not exist: create it with defaults (pretty-printed JSON with comments stripped, since JSON does not support comments). Log to stderr: `Created default config at ~/.ironcurtain/config.json`
3. If file exists: parse JSON, validate with Zod, merge with defaults
4. Apply env var overrides (`ANTHROPIC_API_KEY` overrides `anthropicApiKey`)
5. Return `ResolvedUserConfig`

Auto-creation writes this content:

```json
{
  "agentModelId": "claude-sonnet-4-6",
  "policyModelId": "claude-sonnet-4-6",
  "escalationTimeoutSeconds": 300
}
```

Note: `anthropicApiKey` is intentionally omitted from the auto-created file. Users who want to store their key in config can add it manually.

### Error handling

| Condition                     | Behavior                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| File doesn't exist            | Create with defaults, continue                                 |
| Invalid JSON                  | Hard error with file path and parse error                      |
| Schema validation fails       | Hard error listing which fields are invalid                    |
| File permissions prevent read | Hard error                                                     |
| Directory doesn't exist       | Create directory recursively (already done by session factory) |
| Unknown fields in JSON        | Warn to stderr, ignore                                         |

### Writing

`config.json` holds API keys, server credentials and the Signal identity, and
several processes write it (the daemon's web UI, `ironcurtain config`,
`setup-signal`, and any non-read-only load that creates the file, backfills
defaults or migrates `dockerWorkload`). Every write follows the same rules:

- **Atomic and private.** `writePrivateFileAtomicSync()` (`src/util/atomic-write.ts`)
  writes a fresh temporary file in the same directory, created exclusively with
  mode 0600, fsyncs it, renames it over `config.json` and fsyncs the directory.
  A crash or a full disk leaves the old or the new file, never an empty or
  partial one, and the umask never widens the mode. A symlinked `config.json`
  (dotfile managers) is resolved first, so the link survives and its target is
  replaced.
- **One writer at a time.** Each write is a read-modify-write under the
  cross-process lock `config.json.lock` (`withFileLockSync()`,
  `src/util/file-lock.ts`, built on the crash-recoverable process lock). The
  file is re-read under the lock, so concurrent saves are applied one after
  another and a backfilling load never rolls back a save made meanwhile. The
  lock is held for milliseconds; a waiter gives up after 10 seconds with a
  `FILE_LOCK_TIMEOUT` error and writes nothing.
- **Never over an unreadable file.** `saveUserConfig()` throws, as the load
  path does, when the existing file is not valid JSON or not a JSON object,
  and leaves it untouched; merging into an empty object would silently drop
  every setting the file holds. Backfill and migration skip such a file and
  the load reports it.
- **One version back.** Before replacing the file, the previous contents are
  kept as `config.json.bak` (0600, next to `config.json`, unchanged when a
  save changes nothing), so the version before the latest write can be
  restored by hand. It may still hold a key that the latest save removed.

## 6. Integration Points

### `src/config/index.ts` -- `loadConfig()`

Call `loadUserConfig()` early. Use `resolvedConfig.anthropicApiKey` as the fallback for `ANTHROPIC_API_KEY`. Pass `agentModelId` through on `IronCurtainConfig`.

```typescript
export interface IronCurtainConfig {
  // ... existing fields ...
  agentModelId: string; // NEW
  escalationTimeoutSeconds: number; // NEW
}
```

### `src/session/agent-session.ts`

Replace:

```typescript
const baseModel = anthropic('claude-sonnet-4-6');
```

With:

```typescript
const baseModel = anthropic(this.config.agentModelId);
```

### `src/pipeline/compile.ts`

Needs access to `policyModelId`. Options:

**Option A (recommended):** Import and call `loadUserConfig()` directly, since the pipeline is a standalone CLI entry point that already loads its own config independently.

```typescript
const userConfig = loadUserConfig();
const baseLlm = anthropic(userConfig.policyModelId);
```

**Option B:** Thread through `PipelineConfig`. More coupling for no real benefit since the pipeline is not called from the session layer.

### `src/trusted-process/mcp-proxy-server.ts`

The escalation timeout needs the config value. Since the proxy runs as a child process with env-var configuration, add `ESCALATION_TIMEOUT_SECONDS` to the proxy env (set by `sandbox/index.ts` from `config.escalationTimeoutSeconds`).

> **Superseded (WP-35).** Policy evaluation and the escalation wait later moved into the parent process (`ToolCallCoordinator`), and the relay never read `ESCALATION_TIMEOUT_SECONDS`, so the configured value had no effect. Now `buildCoordinator` passes `escalationTimeoutMs` (from `escalationTimeoutSeconds`) to the coordinator directly, and the relay gets only `BACKEND_CALL_TIMEOUT_MS`, its bound for one backend `callTool` (reset on progress, with an absolute ceiling). It is relay-internal configuration (`RELAY_INTERNAL_ENV_NAMES` in `src/trusted-process/child-env.ts`): set explicitly by the session parent, never inherited by any other child or forwarded by a `-e` argument, so a list-resolution relay runs with the default bound. The global `Protocol.prototype.request` timeout patch is gone: the parent's `initialize` handshake with each relay carries an explicit bound (`MCP_CONNECT_TIMEOUT_MS`, 300 s, since a relay answers only once its backend is up), other parent-to-relay requests keep the SDK's 60 s default, and the `execute_code` chain timeout is derived from both bounds. See `src/trusted-process/call-timeouts.ts`.

### `src/sandbox/index.ts`

Pass escalation timeout from config into the proxy env and use it for the sandbox timeout:

```typescript
proxyEnv.ESCALATION_TIMEOUT_SECONDS = String(config.escalationTimeoutSeconds);
// ...
timeout: config.escalationTimeoutSeconds * 1000,
```

## 7. File Structure

```
src/config/
  user-config.ts          # NEW -- loadUserConfig(), UserConfig, ResolvedUserConfig
  index.ts                # MODIFIED -- call loadUserConfig(), extend IronCurtainConfig
  types.ts                # MODIFIED -- add agentModelId, escalationTimeoutSeconds
  paths.ts                # MODIFIED -- add getUserConfigPath()
```

## 8. Testing Strategy

- **Unit tests** for `loadUserConfig()`:
  - Returns defaults when file does not exist
  - Parses valid config and merges with defaults
  - Rejects invalid JSON with useful error
  - Env var `ANTHROPIC_API_KEY` overrides config file `anthropicApiKey`
  - Unknown fields produce warning but do not cause error
  - Missing optional fields use defaults
- Use temp directories (`/tmp/ironcurtain-test-*`) with `IRONCURTAIN_HOME` override to isolate tests from real user config.

## 9. Migration Path

This is additive. No existing behavior changes for users who do not create a config file:

1. Add `src/config/user-config.ts` with types, defaults, and `loadUserConfig()`
2. Add `getUserConfigPath()` to `src/config/paths.ts`
3. Extend `IronCurtainConfig` with new fields
4. Update `loadConfig()` to call `loadUserConfig()` and populate new fields
5. Update `agent-session.ts` to read model from config
6. Update `compile.ts` to read pipeline model from user config
7. Update `sandbox/index.ts` and `mcp-proxy-server.ts` for escalation timeout
8. Add tests

Each step can be a separate commit. No breaking changes. Existing env var overrides continue to work.
