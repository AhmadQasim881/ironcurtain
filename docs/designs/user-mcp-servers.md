# Design: User-Level MCP Server Configuration

**Status (2026-11-14):** Implemented.

**Code:** `src/config/mcp-servers-overlay.ts`, `src/mcp/mcp-command.ts`

## Problem

The MCP servers IronCurtain runs were defined only in the package's `src/config/mcp-servers.json` (`dist/config/` for an npm install). Every reader (the runtime's `loadConfig`, the pipeline's `loadPipelineConfig`, the credential editor) loaded that file with a bare cast. Adding a server meant patching node_modules (root for a global install, lost on upgrade), and a hand-edit typo crashed deep inside a spawn (`config.args.length` of an entry without `args`) instead of naming the field.

## The user file

`$IRONCURTAIN_HOME/mcp-servers.json` (`getUserMcpServersPath()`) is layered over the package file by `loadMcpServers()`. Every reader uses it: `loadConfig()` (sessions, daemon, doctor, persona and job compiles), `loadPipelineConfig()` (`compile-policy`, `annotate-tools`), the `ironcurtain config` credential editor, the first-start sandbox check, and the trusted credential loader (`getCredentialEnvKeys`, which also accepts the `-e NAME` pass-through names of the user's servers from `~/.ironcurtain/.env`). The persona server allowlist is checked against `loadConfig().mcpServers`, so it sees the same set.

### Adding servers

An entry whose name is not a built-in adds a server. It is a complete definition (`command`, `args`, `env`, `description`, `sandbox`) validated with the same strict zod schema as the package file (unknown fields, wrong types, invalid env names and malformed domain patterns are errors). Extra rules for user servers:

- Names are 1-63 lowercase letters, digits and single hyphens, starting with a letter. A server name becomes a directory (`generated/servers/<name>/`), a tool-key prefix (`<name>__<tool>`, split at the first `__`) and a code-mode namespace (hyphens become underscores, so underscores are refused to keep that mapping one-to-one).
- The command is an absolute path or a bare program name: servers run in a private working directory (`spawn-cwd.ts`), where a relative path names nothing.
- The definition is used as written. `node_modules/` and `./src/` paths are resolved against the package for built-ins only (`builtinServerConfigs`).

### Adjusting built-ins (owner decision)

Owner decision: the user file may only add servers; built-ins can be adjusted only through documented fields, and attempts to replace a built-in's command, args or sandbox are rejected with a clear error. An entry named after a built-in may therefore contain only:

- `env`: merged over the built-in's own env, key by key. Names in the credential loader's denylist (`isForbiddenEnvKey`: loader, path, proxy, TLS, git, docker and IronCurtain variables) are refused, because they would change how the process runs: `NODE_OPTIONS` or `LD_PRELOAD` inject code, `GIT_*` would desynchronize the git backend from the configuration the policy engine resolves remotes from, `DOCKER_HOST` would move the GitHub container to another daemon.
- `sandbox.network.allowedDomains` / `deniedDomains`: each replaces the built-in's list, and only for a built-in that already has a network allowlist (git, google-workspace). Giving the filesystem server network access would replace its sandbox.

`command`, `args`, `description` and the rest of `sandbox` (including `sandbox: false`, `network: false` and `filesystem`) are refused with the field and the remedy (add the program as a new server). IronCurtain special-cases built-ins by name: `applyAllowedDirectoryToMcpArgs` rewrites the filesystem server's last argument and its sandbox confines it to its roots, `isGitBackend` hardens the git server's environment, `applyFetchServerOptions` writes the fetch server's settings channel after the merge (so the user file cannot set it). A replaced definition would run another program under those assumptions.

Every adjustment is reported on stderr by `loadConfig()` and `loadPipelineConfig()` (`warnOnMcpServerAdjustments`), once per process per distinct warning, so the daemon does not repeat it for every job. `ironcurtain mcp list` shows adjustments too.

### Reserved names

The in-process virtual servers of `RESERVED_SERVER_NAMES` (`proxy`, the domain-management tools; `network`, the policy namespace of MITM egress decisions; `workflow`, the coordinator's `workflow_commit` tool) and `memory` (`SESSION_INJECTED_SERVER_NAMES`, the server sessions add themselves and trust by exact command) are refused in either file: a configured server under one of these names would share their annotations and rules. Sessions still verify a `memory` entry with `verifyMemoryServerConfig` before trusting it.

### Validation and failure

`loadMcpServers()` validates the package file and the user file and throws `McpServersConfigError` (`code: 'MCP_SERVERS_INVALID'`) naming the file and every offending field (`git.command: ...`, `notes.sandbox.network.allowedDomains[0]: ...`). Nothing partial is returned, so no session, compile or annotation runs on a broken file. `ironcurtain doctor` reports it under "MCP servers" with the file to fix.

The user file is read through one descriptor: it must be a regular file owned by the current user (or root) and not writable by every user (group-writable is accepted, as for the credential files). It is at most 1 MiB. Keys starting with `_` are comments.

### Protection

The file is inside the IronCurtain home, which is a protected path. `computeProtectedPaths` also lists it on its own, even when absent (like `config.json`), so neither the policy engine nor workspace validation depends on the home-wide entry for it.

## `ironcurtain mcp`

- `mcp list` prints every server with its source (built-in, built-in adjusted, yours), sandbox, annotation count and rule count in the active merged policy.
- `mcp add <name> --command <program> [--arg <value>]... [--env NAME[=value]]... [--sandbox default|none] [--allow-domain <pattern>]... [--description <text>] [--no-annotate] [--no-compile]` (or `-- <program> [args...]`):
  1. Builds and validates the definition; refuses built-in, reserved, invalid or existing names. `--env NAME` declares a credential: an empty `env` slot, or `-e NAME` after `run` for docker and podman.
  2. Under the user file's lock: drops the rules an earlier server of the same name left in the user's merged policy and in every persona's and job's compiled policy (`personas/<name>/generated/`, `jobs/<id>/generated/`) and every soft-deleted persona's (`.persona-trash/<entry>/generated/`, which `persona trash restore` brings back as it is), since they would apply to the new server's same-named tools, then writes the entry (atomic, 0600, comments and other entries kept; `updateUserMcpServers`). The stripped policies keep their constitution hash, so they stay current and deny the new server until they are recompiled. The name's scenarios, with the decisions recorded for them, are taken out of the `test-scenarios.json` beside each policy (`scenariosWithoutServer`), so `ironcurtain doctor`'s offline replay of the recorded decisions still matches the narrowed policy; that file is diagnostic only, so a damaged one is left alone. A policy is read the way sessions read it (`readCompiledPolicyFile`: no symlink at its name, a trusted owner, not writable by other users), so one sessions refuse is never narrowed and written back as a file they would accept. Nothing is added while a policy that names the server cannot be rewritten, or while the merged policy cannot be read; a persona or job policy that cannot be read is reported (sessions refuse it as well).
  3. Asks for the declared credentials (`collectDeclaredEnvVars`, shared with doctor and the credential editor) and stores them in `config.json` `serverCredentials`.
  4. Annotates the server through `annotateServers` (the `annotate-tools --server` path), shows the annotations and the argument roles available to the server, and warns when only `none` is (see Limitations). `annotateServers` records a server whose annotation fails (an LLM error, output truncated, tools left unannotated) and goes on; `mcp add` stops there with the reason, showing and compiling nothing, as when the server cannot be started.
  5. Offers `ironcurtain customize-policy` (a child process on the terminal).
  6. Runs `compile-policy --server <name>`: the server's rules are compiled and verified on their own and written only to `generated/servers/<name>/` (the merged policy is untouched), then shown.
  7. Offers a full `compile-policy` (verified servers are reused from the compile cache) and reports whether the merged policy now has rules for the server, or why not (skipped by the pre-filter, failed, or granted nothing).
- `mcp remove <name> [--yes]` removes a user server (definition, user annotations, `generated/servers/<name>/`, its rules and failure records in the merged policy and in persona, job and soft-deleted persona policies, and its stored scenarios beside each; a soft-deleted persona's policy that cannot be rewritten is reported with the purge command) or the user's adjustment of a built-in. The rest of the file need not be valid (`removeUserMcpServerEntry`): a hand-edited file with several broken entries is repaired one entry at a time, and what is still wrong is reported. An entry whose name is invalid or reserved (`memory`, `proxy`, `network`, `workflow`) is only taken out of the file: no server ever ran under it, and nothing named after it (IronCurtain's own `memory` artifacts or `network` egress rules, say) is touched. Built-ins cannot be removed.

## Limitations

- Every argument role except `none` is limited to built-in servers by `serverNames` in `src/types/argument-roles.ts`, so a user server's arguments are all `none`: policy can allow, escalate or deny each tool, but no protected-path, sandbox-containment or domain check applies to its arguments. `mcp add` says so.
- Annotation starts the server the way its session relay does (`live-tools.ts` over `trusted-process/tool-listing-launch.ts`): inside the OS sandbox it asks for, refused or unconfined as `sandboxPolicy` says when that sandbox is unavailable, and with the credentials `mcp add` stored for it. So under the default `"enforce"`, a server that asks for the OS sandbox cannot be annotated on a host where the sandbox is unavailable: `mcp add` stops with the refusal, as for any server that cannot be started.
- Policies compiled into other directories (`compile-policy --output-dir`) are not tracked: `mcp add` and `mcp remove` strip a server name only from the merged policy, the persona and job policies that sessions load, and the policies of soft-deleted personas (which a restore makes loadable again).
