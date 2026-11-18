# Adding an MCP Server to IronCurtain

This guide walks through how to add a new [MCP](https://modelcontextprotocol.io/) server to IronCurtain so its tools are available to the agent and governed by the policy engine.

## Overview

Adding a server involves four steps:

1. **Register** the server in your MCP server configuration, `~/.ironcurtain/mcp-servers.json`
2. **Configure credentials** (if the server needs API keys or OAuth tokens)
3. **Annotate** the server's tools so the policy engine understands their arguments
4. **Update the constitution** and recompile policy to define what the agent can and cannot do

`ironcurtain mcp add` runs all four for you:

```bash
ironcurtain mcp add notes --command /opt/notes-mcp/bin/server --allow-domain api.notes.example
ironcurtain mcp add slack --env SLACK_BOT_TOKEN --allow-domain slack.com -- npx -y @scope/slack-mcp@1.2.3
ironcurtain mcp list
ironcurtain mcp remove notes
```

It writes the definition, asks for the credentials the server declares, starts the server to annotate its tools, shows the annotations and the argument roles the server could use, offers `ironcurtain customize-policy` so you can say what the agent may do with the server, compiles and verifies the server's rules on their own (`compile-policy --server <name>`), and offers to rebuild the merged policy that sessions load. Nothing is written into the installed package, so upgrades keep your servers.

## Step 1: Register the Server

The servers shipped with IronCurtain (filesystem, git, fetch, github, google-workspace) are defined in the package's `mcp-servers.json`. Your own servers go in `~/.ironcurtain/mcp-servers.json` (`$IRONCURTAIN_HOME/mcp-servers.json`), which every IronCurtain command layers over the package file:

```json
{
  "_comment": "Keys starting with _ are comments.",
  "my-server": {
    "description": "What this server does",
    "command": "npx",
    "args": ["-y", "@example/my-mcp-server@1.2.3"],
    "env": {
      "SOME_SETTING": "value",
      "MY_SERVER_TOKEN": ""
    },
    "sandbox": {
      "network": { "allowedDomains": ["api.example.com"] }
    }
  }
}
```

`ironcurtain mcp add <name>` writes the same entry for you:

| Option | Entry |
| --- | --- |
| `--command <program>` (or the first word after `--`) | `command`: an absolute path, or a program name found on `PATH`. Servers run in a private working directory, so relative paths are refused. |
| `--arg <value>` (repeatable), or everything after `--` | `args`, used exactly as written. Write `--arg=-y` for a value that starts with `-`. |
| `--env NAME=value` | `env.NAME`: a plain setting. |
| `--env NAME` | A credential the server reads from its environment: an empty `env.NAME` slot (its value is asked for and stored in `config.json`, never in `mcp-servers.json`). For a `docker`/`podman` server, `-e NAME` is added after `run` instead, so the container receives it. |
| `--sandbox default` (the default) | No `sandbox` key: the server runs in the OS sandbox with no network access, writing only to the session sandbox. |
| `--allow-domain <pattern>` (repeatable) | `sandbox.network.allowedDomains`: domains the sandboxed server may reach (`example.com`, `*.example.com`). |
| `--sandbox none` | `"sandbox": false`: no OS sandbox, for example for a Docker-based server (Docker provides the isolation). Policy still mediates every tool call. |
| `--description <text>` | `description` |

The rules the file must follow (each problem is reported with the server and field, and stops every command until it is fixed):

- **Names** are 1-63 lowercase letters, digits and single hyphens, starting with a letter. `proxy`, `network`, `workflow` and `memory` are reserved for IronCurtain's internal servers.
- **Every field is checked**: an unknown field, a value of the wrong type, an invalid environment variable name or a domain pattern such as `https://example.com` is an error, not ignored.
- **The file must belong to you** and must not be writable by every user (`chmod 600 ~/.ironcurtain/mcp-servers.json`); it names programs IronCurtain runs. Agents can neither read nor write it.

For Docker-based servers, use `-e VAR_NAME` (without `=value`) in `args` so Docker forwards the variable from the host environment, as the shipped GitHub server does.

### Adjusting a built-in server

Your file may also name a built-in server, but only to adjust these documented fields:

- `env`: variables added to the server's environment (merged over the built-in's own, key by key). Variables that reconfigure the process rather than the server are refused: loader, path, proxy, TLS, git, docker and IronCurtain variables (`NODE_OPTIONS`, `PATH`, `GIT_*`, `HTTPS_PROXY`, `DOCKER_HOST`, ...).
- `sandbox.network.allowedDomains` and `sandbox.network.deniedDomains`: each replaces the built-in's list, for a built-in that already has a network allowlist (git, google-workspace).

```json
{
  "git": {
    "sandbox": { "network": { "allowedDomains": ["github.com", "*.github.com", "git.example.com"] } }
  }
}
```

A built-in's `command`, `args`, `description` and the rest of its `sandbox` cannot be replaced: IronCurtain special-cases its built-in servers by name (the filesystem server's root confinement, the git backend's hardened environment, the fetch server's SSRF guard), so a replaced definition would run another program under those assumptions. To run a different program, add it as a new server under its own name. Every adjustment is reported with a warning whenever a session or the policy pipeline loads the configuration, and `ironcurtain mcp list` shows it. `ironcurtain mcp remove <built-in>` removes your adjustment.

**For IronCurtain developers:** servers that ship with the package are added to `src/config/mcp-servers.json` instead. See "Onboarding a New MCP Server" in [CLAUDE.md](CLAUDE.md) for the checklist (argument roles, constitution, scenarios and tests).

## Step 2: Configure Credentials

Credentials are stored in `~/.ironcurtain/config.json` under `serverCredentials.<serverName>.<ENV_VAR>` and injected into the server's environment at runtime; they never appear in `mcp-servers.json`.

`ironcurtain mcp add` asks for the variables the server declares, and `ironcurtain config` (Server Credentials) prompts for the same ones later. A server declares a variable with a `-e NAME` argument (Docker), an empty `env` value (`"MY_SERVER_TOKEN": ""`), or an `env` key that looks like a credential (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `API`). `ironcurtain doctor` reports declared variables that have no value.

A variable a Docker server forwards with `-e NAME` may also come from your shell or from `~/.ironcurtain/.env`.

**For OAuth:** Use `ironcurtain auth` to set up OAuth credentials. See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for OAuth details.

## Step 3: Annotate Tool Arguments

The policy engine needs to know the *role* of each tool argument (e.g., is it a file path? a URL? a branch name?) to enforce policy rules correctly. `ironcurtain mcp add` annotates the new server; to re-annotate it later:

```bash
ironcurtain annotate-tools --server my-server
```

This connects to the server, discovers its tools, and uses an LLM to classify each argument. The result goes into your annotation overlay, `~/.ironcurtain/generated/tool-annotations.json`, which holds only the servers whose annotations differ from the ones IronCurtain ships: for a built-in server whose live tools match the shipped, reviewed annotations, those are used and no LLM is needed, and fixes to the shipped annotations reach you automatically. Unchanged tools keep their roles; only new and changed tools go to the LLM. The annotation run starts the server only to list its tools, the way a session's relay starts it: inside its OS sandbox when it asks for one (when the sandbox is unavailable, refused or run without it as `sandboxPolicy` says), with the credentials stored for it in `config.json`, and the filesystem server against an empty temporary directory. A server backed by an IronCurtain OAuth login (google-workspace) is not started. With `--all`, a server that fails keeps its previous annotations, and the run exits 1 naming it.

**Flags:**
- `--server <name>` — Annotate only this server (default workflow)
- `--all` — Re-annotate all servers
- `--check` — Compare the live tools with the stored annotations and report drift; no LLM, exit 1 on drift (`ironcurtain doctor` and `compile-policy` report drift too)
- `--pin` — With `--server`: keep your annotations for that server even where IronCurtain ships reviewed ones for the same tools
- `--reset` — Remove your annotations (for `--server`, or all) so the shipped ones apply; no LLM or MCP needed
- `--diff` — Print, per server, the tools whose roles this run changed
- `--help` — Show usage

After annotation, review the generated file to verify the LLM classified arguments correctly. Annotations are part of the Trusted Computing Base — incorrect classifications can lead to policy bypasses. A live argument that has no annotation is denied (`unannotated-arguments`), and `annotate-tools` warns about roles on arguments that can hold an object or a nested array, since such a role applies to the whole value.

**For IronCurtain developers:** The repository ships reviewed annotations in `src/config/generated/tool-annotations.json`. Do not copy your overlay over it (the overlay holds only the servers you re-annotated). After annotating and reviewing a server, promote its entry into the package file:

```bash
npx tsx scripts/stamp-package-annotations.ts --from ~/.ironcurtain/generated/tool-annotations.json --server <name>
```

After a hand edit of the package file, run `npx tsx scripts/stamp-package-annotations.ts` with no arguments. The shipped compiled policies record the annotations they were compiled against, so after changing shipped annotations either recompile those policies or, when the shipped rules still hold, re-stamp them with `npx tsx scripts/stamp-policy-provenance.ts` (`test/policy-provenance.test.ts` fails otherwise). Pin a shipped server exactly (an npm version, or an image digest for containers); after bumping it, run `npm test` (the annotation drift suite) or `ironcurtain annotate-tools --check --server <name>`, then re-annotate and promote the entry as above. `annotate-tools` never starts google-workspace, which is backed by an IronCurtain OAuth login, so it can neither check nor re-annotate that server.

### Argument Roles

The annotation pipeline assigns roles from a registry (`src/types/argument-roles.ts`). Common roles include:

| Role | Meaning |
| --- | --- |
| `read-path` | File/directory path used for reading |
| `write-path` | File/directory path used for writing |
| `delete-path` | File/directory path used for deletion |
| `url` | A URL (subject to domain allowlists) |
| `github-owner` | A GitHub owner/org name |
| `none` | Argument has no security-relevant semantics |

Most roles are limited to the built-in servers whose semantics they describe (`serverNames` in the registry). A server you add can currently be annotated only with `none`: policy can allow, escalate or deny each of its tools, but it inspects none of their arguments, so no protected-path, sandbox-containment or domain check applies to them. `ironcurtain mcp add` lists the roles available to the server. Have tools that read or change files, or reach the network, escalated for approval, and rely on the server's own OS sandbox for containment.

For a built-in server whose tools have URL roles, the policy engine's domain gate uses the server's `sandbox.network.allowedDomains`, or `["*"]` when it has none: every host name passes the gate, while an IP-literal destination (or a fetch URL that is not http(s)) escalates.

If your server introduces new resource-identifier semantics not covered by existing roles, extend the registry in `src/types/argument-roles.ts`.

## Step 4: Update Constitution and Compile Policy

Describe what the agent may do with the new server in your constitution: `ironcurtain customize-policy` (which `mcp add` offers) edits `~/.ironcurtain/constitution-user.md` for you. For example:

```markdown
## My Server Rules

- Read-only operations on my-server are safe and can be allowed automatically.
- Any mutation operations require human approval.
```

Without guidance that mentions the server, its tools are likely to stay denied: the compiler has nothing to grant, and the server pre-filter of a full `compile-policy` run may skip a server the constitution does not mention (`ironcurtain mcp add` reports when it did).

Then compile the updated policy:

```bash
ironcurtain compile-policy --server my-server   # compile and verify this server's rules on their own
ironcurtain compile-policy                      # rebuild the merged policy that sessions load
```

A `--server` run writes only `~/.ironcurtain/generated/servers/<name>/`; sessions start the server once the merged policy (a full run, which reuses every server verified earlier from the compile cache) has rules for it. Review the compiled output to confirm the rules match your intent.

### Adding Tests

**Handwritten scenarios** (`src/pipeline/handwritten-scenarios.ts`) are reserved for universal safety invariants that must hold regardless of the user's constitution — currently filesystem sandbox containment rules. Only add scenarios here if your server introduces a new universal invariant (e.g., a hard safety boundary that no constitution should be able to override).

**Policy unit tests** (`test/policy-engine.test.ts`) are where server-specific policy tests belong. Add test fixtures in `test/fixtures/test-policy.ts` with representative tools and rules, then write tests verifying your server's tools are correctly allowed/escalated/denied under the current compiled policy.

## Removing a Server

`ironcurtain mcp remove <name>` removes a server you added: its definition, its annotations, its compile cache and its rules in your merged policy and in your persona and job policies, so a server you later add under the same name starts with no permissions (`mcp add` drops any such rules it finds as well). Its stored credentials stay in `config.json` (remove them with `ironcurtain config`). It also removes entries that fail validation, one at a time, even when other entries in the file are broken too, and says what is still wrong.

## Verification

After completing all steps:

1. **List:** `ironcurtain mcp list` shows the server, its sandbox, its annotations and its rules
2. **Diagnose:** `ironcurtain doctor` checks credentials and starts each server
3. **Manual check:** Start the mux and ask the agent to verify the new server's tools appear and policy decisions are correct:
   ```bash
   ironcurtain mux
   ```

For servers shipped with the package, also run `npm run build` and `npm test`.

## Quick Reference

| Step | Command |
| --- | --- |
| Add a server (all steps) | `ironcurtain mcp add <name> --command <program> ...` |
| List servers | `ironcurtain mcp list` |
| Remove a server | `ironcurtain mcp remove <name>` |
| Annotate one server | `ironcurtain annotate-tools --server <name>` |
| Annotate all servers | `ironcurtain annotate-tools --all` |
| Check annotations against live tools | `ironcurtain annotate-tools --check` |
| Compile policy | `ironcurtain compile-policy` |
| Refresh dynamic lists | `ironcurtain refresh-lists` |
| Run tests | `npm test` |
