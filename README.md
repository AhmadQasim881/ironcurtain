# IronCurtain

[![CI](https://github.com/provos/ironcurtain/actions/workflows/ci.yml/badge.svg)](https://github.com/provos/ironcurtain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@provos/ironcurtain)](https://www.npmjs.com/package/@provos/ironcurtain)
[![License](https://img.shields.io/github/license/provos/ironcurtain)](LICENSE)
[![Website](https://img.shields.io/badge/web-ironcurtain.dev-blue)](https://ironcurtain.dev)

**A secure\* runtime for autonomous AI agents, where security policy is derived from a human-readable constitution.**

_\*When someone writes "secure," you should immediately be skeptical. [What do we mean by secure?](https://ironcurtain.dev)_

> [!WARNING]
> **Research Prototype.** IronCurtain is an early-stage research project exploring how to make AI agents safe enough to be genuinely useful. APIs, configuration formats, and architecture may change. Contributions and feedback are welcome.

## Demo

<p align="center">
  <img src="demo.gif" alt="IronCurtain mux demo: trusted input from command mode enables auto-approval of git clone and git push" width="800">
</p>

The agent is asked to clone a repository and push changes. Both `git_clone` and `git_push` are escalated by the policy engine, but the auto-approver approves them automatically — the user's trusted input from command mode (Ctrl-A) clearly authorized both, so no manual `/approve` was needed.

## The Problem

Autonomous AI agents can manage files, run git commands, send messages, and interact with APIs on your behalf. But today's agent frameworks give the agent the same privileges as the user such as full access to the filesystem, credentials, and network. Security researchers call this **ambient authority**, and it means a single prompt injection or multi-turn drift can cause an agent to delete files, exfiltrate data, or push malicious code.

The common response is to either restrict agents to a narrow sandbox (limiting their usefulness) or to ask the user to approve every action (limiting their autonomy). Neither is satisfactory.

## The Approach

IronCurtain takes a different path: **express your security intent in plain English, then let the system figure out enforcement.**

You write a **constitution** which is a short document describing what your agent is and isn't allowed to do. IronCurtain compiles this into a deterministic security policy using an LLM pipeline, validates the compiled rules against generated test scenarios, and then enforces the policy at runtime on every tool call. The result is an agent that can work autonomously within boundaries you define in natural language.

The key ideas:

- **The agent is untrusted.** IronCurtain assumes the LLM may be compromised by prompt injection or drift. Security does not depend on the model "being good."
- **English in, enforcement out.** You write intent ("no destructive git operations without approval"); the system compiles it into deterministic rules that are enforced without further LLM involvement at runtime.
- **Semantic interposition.** Instead of giving the agent raw system access, all interactions go through [MCP](https://modelcontextprotocol.io/) servers (filesystem, git, etc.). Every tool call passes through a policy engine that can **allow**, **deny**, or **escalate** to the user for approval.
- **Defense in depth.** Agent code runs in a V8 isolate with no direct access to the host. The only way out is through semantically meaningful MCP tool calls and every one is checked against policy.

## Architecture

IronCurtain supports two session modes with different trust models:

- **Builtin Agent (Code Mode)** — IronCurtain's own LLM agent writes TypeScript snippets that execute in a V8 sandbox. IronCurtain controls the agent, the sandbox, and the policy engine. Every tool call exits the sandbox as a structured MCP request, passes through the policy engine (allow / deny / escalate), and only then reaches the real MCP server.

- **Docker Agent Mode** — An external agent (Claude Code, Goose, Codex) runs inside a container without direct public-network access. IronCurtain mediates the external effects: LLM API calls pass through a TLS-terminating MITM proxy (host allowlist, fake-to-real key swap, request filtering, token and cost limits), MCP tool calls pass through the same policy engine, and supported package installations go through validating package proxies.

Opt-in [nested Docker](CONFIG.md#nested-docker-workloads) gives developer sessions a private, ephemeral
daemon without exposing the host Docker socket. Implemented profiles cover Apple Container and Docker
Desktop on macOS, and WSL2 with Docker Desktop on amd64. Its `offline`, `images`, and `packages` modes
separate local image use, mediated public image pulls, and supported package builds. Native Linux Engine
is not admitted for nesting; see the configuration reference for prerequisites and limitations.

In both modes, the agent is **untrusted**. Security does not depend on the model following instructions — it is enforced at the boundary.

The agent CLIs in the Docker images are pinned to versions qualified with each release (Claude Code 2.1.292, Codex 0.157.1); `agentCliVersions` in `config.json` overrides them, and `ironcurtain images status|rebuild|prune` manages the images. Provider-hosted tools such as web search are disabled or stripped from model requests, so the agent's web access goes through the policy-mediated fetch server.

See [SANDBOXING.md](SANDBOXING.md) for the full architecture with diagrams, layer-by-layer trust analysis, and macOS platform notes.

## Quick Start

### Prerequisites

- Node.js 24 or 26 — the even-numbered major lines IronCurtain tests. Other major versions are rejected by `ironcurtain doctor`.
- Build tools where a native module has no prebuilt binary: on Linux, `python3`, `make` and `g++` (for example `sudo apt-get install -y build-essential python3`) to compile `node-pty`, which `mux` and the web UI terminal need; on Intel Macs, the Xcode Command Line Tools to compile `isolated-vm` (prebuilt for linux-x64/arm64, darwin-arm64 and win32-x64).
- On Linux, `bubblewrap`, `socat` and `ripgrep` for the OS sandbox around MCP servers: `sudo apt-get install -y bubblewrap socat ripgrep`. Without them, the servers that ask for an OS sandbox (filesystem, git, google-workspace) do not start under the default `sandboxPolicy` of `enforce`; see [Troubleshooting](#troubleshooting). macOS needs nothing extra.
- Docker — not required but **strongly recommended** for Docker Agent Mode, which provides the strongest isolation. On Linux, run IronCurtain as a regular user: Docker Agent Mode refuses to run as root. On macOS 26+ (Apple silicon), [Apple `container`](https://github.com/apple/container) works as an alternative backend (VM per container; used automatically when its services are running — see `containerRuntime` in `ironcurtain config`).
- An API key for at least one LLM provider (Anthropic, Google, or OpenAI). Claude Code in Docker can use your Claude login (`claude login`) instead of an Anthropic key.

### Install

**As a global CLI tool (end users):**

```bash
npm install -g @provos/ironcurtain
```

- If your npm configuration blocks unreviewed install scripts, allow the two native modules: `npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`. With `strict-allow-scripts` set, that install fails on the install scripts of the other dependencies; see [Install scripts](docs/designs/dependency-hygiene.md#install-scripts) for the alternative.
- On linux-x64, the memory server's `onnxruntime-node` dependency downloads about 270 MB of CUDA providers it never uses. Skip that with `ONNXRUNTIME_NODE_INSTALL=skip npm install -g @provos/ironcurtain`.

**From source (development):**

```bash
git clone https://github.com/provos/ironcurtain.git
cd ironcurtain
npm install
```

A checkout's `package.json` decides which install scripts run (`allowScripts`; enforced by npm 11.19 and later). See [CONTRIBUTING.md](CONTRIBUTING.md).

### One-time setup

**1. Provide your API key.** For a first builtin session with the default Anthropic model, enter the key at a hidden Bash prompt. The key lasts for this shell session.

```bash
read -rsp 'Anthropic API key: ' ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
echo
```

For persistent access, create or open the credential file with owner-only permissions before entering the key. Add a line named `ANTHROPIC_API_KEY` with the value after `=` in your editor. When switching providers, select the corresponding agent model in `ironcurtain config`.

```bash
cred_dir="${IRONCURTAIN_HOME:-$HOME/.ironcurtain}"
(umask 077 && mkdir -p "$cred_dir" && touch "$cred_dir/.env") &&
  chmod 600 "$cred_dir/.env" && "${EDITOR:-vi}" "$cred_dir/.env"
```

IronCurtain loads credentials from `~/.ironcurtain/.env` (`$IRONCURTAIN_HOME/.env`) and from one extra file you name with `ironcurtain --env-file <path> <command>` (before the command) or `IRONCURTAIN_ENV_FILE=/absolute/path`. **A `.env` in the current directory is never read**; IronCurtain prints a one-line note when it finds one. Only credential keys load from these files: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY` and the variables configured MCP servers ask for (such as `GITHUB_PERSONAL_ACCESS_TOKEN`). A file owned by another user or writable by everyone is refused. Keys can also go in `~/.ironcurtain/config.json` (`anthropicApiKey`, `openaiApiKey`, `googleApiKey`); the environment wins. See [CONFIG.md](CONFIG.md#api-keys-and-base-urls).

**2. Run the first-start wizard** (it also runs automatically on the first interactive `ironcurtain start` until it has completed once):

```bash
ironcurtain setup
```

It checks the credentials your configured models need (API keys or a Claude login), offers a web search provider, a GitHub token and auto-approval, and checks the OS sandbox and Docker. It records its completion as `setupCompleted` in `~/.ironcurtain/config.json`; `mux` and `daemon` print a note while setup is pending.

**3. Check the installation** at any time:

```bash
ironcurtain doctor
```

Without `--check-refresh`, `doctor` is read-only. It checks Node.js, the V8 sandbox, `node-pty`, the OS sandbox, Docker, credentials for every model role, the compiled policies, personas, cron jobs, the memory models, MCP server health and the IronCurtain home. `--check-api` adds a round-trip to each model and validates OAuth access tokens without refreshing them; `--upgrade` checks what an upgrade can leave behind. Only `--check-refresh` refreshes credentials: it tests the Anthropic and Google Workspace refresh tokens with a real refresh grant and saves the new tokens, and since Anthropic rotates its refresh token, a running Claude Code or Anthropic CLI must re-read its credentials file afterwards. Doctor never refreshes or writes credentials in the macOS Keychain.

### Upgrading

After `npm install -g @provos/ironcurtain@latest`, the first command prints the behavior changes listed in the CHANGELOG since the version that last ran (recorded as `lastRunVersion` in `~/.ironcurtain/state.json`). Run `ironcurtain doctor --upgrade` to find workflow definitions, runs, snapshots and compiled policies that need attention. A policy compiled by an older version is reported as possibly stale until you recompile it (`ironcurtain compile-policy`, `ironcurtain persona compile <name>`, `ironcurtain daemon recompile-job <id>`). A home whose layout a newer version changed (`layoutVersion` in `state.json`) is refused; a home last used by a newer version with the same layout gets a notice that files the newer version wrote may not be readable.

## Running IronCurtain

IronCurtain ships with a default policy geared towards the developer experience — read-only operations are allowed, mutations (writes, pushes, PR creation) escalate for human approval. You can start using it immediately after setup.

### Terminal multiplexer (recommended)

The recommended way to use IronCurtain. It gives you the full power of your agent's interactive TUI (Claude Code, Goose or Codex) while IronCurtain mediates every tool call through its policy engine — all in a single terminal.

```bash
ironcurtain mux
```

**Key capabilities:**

- **Full agent TUI** — The agent runs in a PTY inside a Docker container with no network access. You interact with it exactly as if it were running locally.
- **Inline escalation handling** — An escalation rings the bell, updates the `[!N pending]` badge and shows a footer banner; the picker never takes over your keystrokes on its own. Press **Ctrl-E** to open it. Decision keys (`a` approve, `d` deny; `w` then `y` approve and whitelist the exact path or domain, `W` then `y` the whole directory, after showing the pattern in full) only count once the request has been on screen in full for about a second; `v` shows every argument. `/approve+ N` whitelists the exact path or domain for the rest of the session, `/approve+dir N` the directory.
- **Trusted user input** — Text typed in command mode (Ctrl-A) is captured on the host side before entering the container. This creates a verified intent signal that the auto-approver can use — e.g., typing "push my changes to origin" can auto-approve a subsequent `git_push` to `origin`.
- **Tab management** — Spawn multiple concurrent sessions (`/new`), switch between them (`/tab N`, Alt-1..9), close them (`/close`). Multiple mux instances can run in parallel.

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the full walkthrough: input modes, trusted input security model, escalation workflow, and keyboard reference.

### Non-mux sessions

Use `ironcurtain start` for quick one-shot tasks, scripts, or when you explicitly want the local builtin agent. For normal interactive Docker-agent work, use `ironcurtain mux`.

For a first run from a source checkout, the following Bash commands use the current branch and a disposable workspace. A successful session returns the contents of `note.txt` through the filesystem tool. The explicit `--agent builtin` selects Code Mode even when the preferred mode is the default `container`.

```bash
workspace=$(mktemp -d)
printf '%s\n' 'The office opens at 09:15.' > "$workspace/note.txt"
npm start -- --agent builtin -w "$workspace" "Read note.txt and tell me when the office opens."
```

```bash
ironcurtain start "Summarize the files in ./src"     # Single-shot mode
ironcurtain start -w ./my-project "Fix the tests"    # Single-shot workspace mode
ironcurtain start --agent builtin                    # Local builtin REPL, no Docker
ironcurtain start --persona my-assistant "Check my email"  # Use a persona
ironcurtain start --task-scoped "Summarize ./notes"  # Escalate calls the task does not need
```

`--task-scoped` compiles the task text into a scope (with the LLM, cached under `~/.ironcurtain/task-policies/`) and intersects it with the session policy: calls outside the scope escalate. It also works for mux (`/new [persona] --task-scoped <task>`) and `ironcurtain workflow start`. A `--workspace` (`-w`) must be an existing directory. Your home directory itself and its ancestors, the IronCurtain home and anything inside it, the MCP servers' private scratch directory (`<tmpdir>/ironcurtain-<uid>`), anything inside it and its ancestors (on Linux, `/tmp`), and directories that contain protected files are refused. A protected file that is a symbolic link to a missing file (a dangling `~/.npmrc`, say) counts as being where the link points, and a workspace may not hold another link on the way there.

### Other running modes

IronCurtain also supports session resume (`--resume <session-id>`), a legacy raw PTY/debug mode, a Signal messaging transport for mobile approval, and a daemon mode for scheduled cron jobs. The daemon has an optional [web UI](DAEMON.md#web-ui) (`--web-ui`) for browser-based monitoring and escalation handling. See [RUNNING_MODES.md](RUNNING_MODES.md) for details and the full command list.

### Multi-agent workflows

The bundled **design-and-code** workflow takes a task through planning, design, implementation and review. You approve the plan and design before implementation begins. The reviewer gets a read-only workspace. The engine passes artifacts between states and saves checkpoints so you can resume an interrupted run.

**The web UI is the intended interface for workflow runs.** Start the daemon, open the printed URL, and drive runs from the Workflows page — the state-machine graph highlights the active state, the agent-message timeline streams with markdown rendering, gate reviews include a workspace + artifact browser, and past runs stay listed. Gate Approve arms only after the exact review remains visible, focused and in place for 750 ms; moving the review or switching tabs restarts the delay.

```bash
ironcurtain daemon --web-ui
```

CLI access is available for scripting, automation, and debugging:

```bash
ironcurtain workflow start design-and-code \
  "Build a REST API with authentication"
```

See [WORKFLOWS.md](WORKFLOWS.md) for the full documentation.

## Customizing Your Policy

The default policy works well for general development, but you can tailor it to your workflow:

**1. Customize your constitution** (optional but recommended):

```bash
ironcurtain customize-policy
```

An LLM-assisted conversation that generates a constitution tailored to your workflow, saved to `~/.ironcurtain/constitution-user.md`. You can also edit this file directly.

**2. Compile the policy:**

```bash
ironcurtain compile-policy
```

Translates your constitution into deterministic rules, generates test scenarios, and verifies them. Compiled artifacts go to `~/.ironcurtain/generated/`. Policies record their provenance: sessions warn when a policy may be stale (built by an older compiler, or against other tool annotations), and `"policy": { "onStale": "refuse" }` in `config.json` makes them refuse instead.

### Personas

Personas are named policy profiles — each bundles a constitution, compiled policy, persistent workspace, and semantic memory. Use them to run agents with different roles or access levels.

```bash
ironcurtain persona create my-assistant    # Create a persona
ironcurtain persona compile my-assistant   # Compile its policy
ironcurtain start --persona my-assistant "Check my calendar"
```

A session refuses a persona whose constitution changed since its last compile; recompile it, or run the old policy once on purpose with `ironcurtain start --persona <name> --allow-stale-policy` (it prints a warning). A compile whose rules grant broad access (`*` or `*.com` domains, unconstrained paths or URLs) is refused unless the persona opts in: `ironcurtain persona compile <name> --allow-broad`. Personas can also carry their own agent model and resource limits (`ironcurtain persona set <name> --model <id> --max-cost <n>`), and be cloned, renamed and restored from the trash (`persona clone`, `persona rename`, `persona trash`). See `ironcurtain persona --help`.

In mux mode, `/new my-assistant` spawns a tab using that persona. Personas can also be assigned to cron jobs. See [DAEMON.md](DAEMON.md) for scheduled job configuration.

Personas can also be managed from the [web UI](DAEMON.md#persona-policy-management) — browse, create, edit constitutions, and compile policies with live progress. Because a policy is a security boundary, the web UI's mutation controls are read-only unless the daemon is started with `--allow-policy-mutation` (off by default).

### Skills

Drop SKILL.md packages under `~/.ironcurtain/skills/<name>/` to make purpose-specific guidance (helper scripts, deterministic checks, domain knowledge) available to every Docker agent session. The merged set is staged into a per-bundle host directory and bind-mounted **read-only** into the container at the path the active agent's native discovery walks — Claude Code is pointed at the staging dir via `--add-dir`, Goose scans `~/.config/goose/skills/<name>/SKILL.md`. The agent discovers them automatically and decides when to read them based on each skill's frontmatter description. The SKILL.md _format_ is the open standard adopted by Claude Code, Goose, and Codex; only the _discovery path_ differs per agent. Workflows can ship per-state skills inside the workflow package — see [WORKFLOWS.md](WORKFLOWS.md#skills).

## Policy: Constitution → Enforcement

You write intent in plain English; IronCurtain compiles it into deterministic rules:

```
constitution.md → [Annotate] → [Compile] → [Resolve Lists] → [Generate Scenarios] → [Verify & Repair]
                      │              │              │                  │                     │
                      ▼              ▼              ▼                  ▼                     ▼
              tool-annotations  compiled-policy  dynamic-lists   test-scenarios       verified policy
                  .json            .json            .json            .json      (failed servers stay denied)
```

1. **Annotate** — Classify each MCP tool's arguments by role (read-path, write-path, delete-path, none).
2. **Compile** — Translate the English constitution into deterministic if/then rules, one MCP server at a time. Categorical references ("major news sites", "my contacts") are emitted as `@list-name` symbolic references. A deterministic lint rejects rules that grant broad domain access (`*`, public-suffix wildcards such as `*.com`, an unconstrained URL) unless you pass `--allow-broad-domains` or put `<!-- ironcurtain: allow-broad-domains -->` in the constitution.
3. **Resolve Lists** — Resolve symbolic lists to concrete values via LLM knowledge or MCP tool-use (e.g., querying a contacts database). MCP-backed resolution runs under the security kernel with the read-only policy and is audited (`list-resolution-audit.jsonl` next to the compiled artifacts); a list resolved through MCP must name its server, and the fetch server never backs one. Written to `dynamic-lists.json`, user-editable. Skipped when no lists are present.
4. **Generate Scenarios** — Create test scenarios from the constitution plus mandatory handwritten invariant tests (a separate session of the policy model, or of `policyVerifierModelId`).
5. **Verify & Repair** — Run scenarios against the real policy engine. An LLM judge analyzes failures and generates targeted repairs (up to 3 follow-up verifications). A server whose rules still fail verification is left out of the merged policy, so its tools stay denied, and is recorded in `failedServers`; `compile-policy` then exits 2 (as do `persona compile` and the cron job compiles of `daemon add-job`, `edit-job` and `recompile-job`; a persona compile in the web UI lists the failed servers). It exits 1 when no policy could be written.

Per-server results are cached by content hash, so only servers whose inputs changed are recompiled; any change to the constitution recompiles every server.

### What compiled rules look like

A constitution clause like:

```markdown
- The agent may perform read-only git operations (status, diff, log) within the sandbox without approval.
- The agent must receive human approval before git push, pull, fetch, or any remote-contacting operation.
```

compiles to:

```json
[
  { "tool": "git_status", "decision": "allow", "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_diff", "decision": "allow", "condition": { "directory": { "within": "$SANDBOX" } } },
  { "tool": "git_push", "decision": "escalate", "reason": "Remote-contacting git operations require human approval" }
]
```

Any call that doesn't match an explicit `allow` or `escalate` rule is **denied by default**.

```bash
ironcurtain annotate-tools --server filesystem   # Annotate one server into your overlay
ironcurtain annotate-tools --all                 # Re-annotate all servers
ironcurtain annotate-tools --check               # Report live-schema drift (no LLM)
ironcurtain annotate-tools --reset               # Drop your annotations; use the shipped ones
ironcurtain compile-policy                       # Compile constitution into rules and verify
ironcurtain compile-policy --server git          # Compile one server (writes servers/git/ only)
ironcurtain compile-policy --force               # Ignore every cached per-server result
ironcurtain refresh-lists                        # Re-resolve dynamic lists without full recompilation
ironcurtain refresh-lists --list major-news      # Refresh a single list
```

`annotate-tools` writes only the servers whose annotations differ from the shipped ones to `~/.ironcurtain/generated/tool-annotations.json`, so fixes to the shipped annotations reach you automatically; `--pin` keeps yours for a server anyway, and `--diff` prints the role changes of a run. `compile-policy` also takes `--constitution <path>`, `--output-dir <path>`, `--write-merged` (with `--server`), `--no-mcp` and `--allow-broad-domains`; `refresh-lists` takes `--persona <name>`, `--job <id>` and `--no-mcp`. Every command answers `--help`.

Review the generated `~/.ironcurtain/generated/compiled-policy.json` — these are the exact rules enforced at runtime.

`dynamic-lists.json` ships with the package. `ironcurtain refresh-lists` writes only your own entries to `~/.ironcurtain/generated/dynamic-lists.json`, which is layered over the shipped lists; a stale entry falls back to the shipped values with a warning. To adjust a list by hand, edit its `manualAdditions` and `manualRemovals` (arrays of strings) in that file: they survive `compile-policy` and `refresh-lists`. To remove a domain, remove both `example.com` and `*.example.com` (the resolver adds the wildcard, which also matches the apex). A malformed file is refused with field-level errors, which `ironcurtain doctor` also reports.

## Configuration

IronCurtain stores configuration and session data in `~/.ironcurtain/` (or `$IRONCURTAIN_HOME`, an absolute path):

```
~/.ironcurtain/
├── config.json              # User configuration (config.json.bak: the version before the last save)
├── .env                     # Credentials (chmod 600)
├── constitution.md          # User-local base constitution (overrides package default)
├── constitution-user.md     # Your policy customizations (generated by customize-policy)
├── mcp-servers.json         # MCP servers you added with `ironcurtain mcp add`
├── generated/               # User-compiled policy artifacts and your tool-annotation overlay
├── personas/                # Persona directories (constitution, policy, workspace, memory)
├── skills/                  # User-global SKILL.md packages, mounted into every Docker session
├── workflows/               # Your own workflow definitions
├── jobs/                    # Cron job definitions, workspaces, git mirrors and run records
├── task-policies/           # Cached --task-scoped policies
├── models/                  # Verified memory-server models
├── statistics/              # Content-free local LLM usage database + pseudonymization key
├── audit/                   # Policy-mutation audit log (hash chain)
├── approval-history.jsonl   # Human approvals, the input to `ironcurtain audit proposals`
├── oauth/                   # OAuth tokens for MCP servers (ironcurtain auth)
├── logs/                    # daemon.log, signal-bot.log (rotated)
├── sessions/
│   └── {sessionId}/
│       ├── sandbox/         # Per-session filesystem sandbox
│       ├── escalations/     # File-based IPC for human approval
│       ├── audit.jsonl      # Per-session audit log
│       ├── messages.jsonl   # Builtin conversation (for --resume)
│       └── session.log      # Diagnostics
└── workflow-runs/           # Workflow runs (see below)
```

Single-session runs (`ironcurtain start`, mux tabs, cron jobs) write under `sessions/`. Session directories are `0700` and their logs `0600`. `ironcurtain prune` removes old sessions, workflow runs, run records and dependency caches according to the `retention` settings ([CONFIG.md](CONFIG.md#retention-personas-and-cron)); nothing is removed automatically unless you enable `retention.autoPrune`.

### Workflow run layout

Every workflow run lives under `~/.ironcurtain/workflow-runs/<workflowId>/`:

```
~/.ironcurtain/workflow-runs/<workflowId>/
├── checkpoint.json          # Resume point (checkpoint.prev.json: the one before)
├── definition.json          # The workflow definition the run uses
├── messages.jsonl           # Orchestrator message log
├── run.lock                 # Held by the process executing the run
├── workspace/               # Agent workspace (unless --workspace was given)
└── containers/
    └── <bundleId>/          # One per container scope (shared-container mode)
        ├── audit.jsonl      # Persona-tagged audit log
        ├── bundle/          # Container support files: CA, orientation, system prompt
        └── states/
            └── <stateId>.<N>/   # session.log + session-metadata.json per invocation
```

With `settings.sharedContainer: true`, every agent state runs inside the same long-lived container per scope and shares one policy engine; between states the orchestrator hot-swaps the active policy so each persona sees its own rules. Without it, each agent state gets its own session (under `sessions/`). See [WORKFLOWS.md](WORKFLOWS.md) for authoring workflow definitions and the full lifecycle.

Edit configuration interactively:

```bash
ironcurtain config
```

Key configuration areas: models and API keys, resource budgets (token/step/time/cost limits), auto-approve escalations, OS sandbox policy, web search provider, audit redaction, and memory server LLM settings. See [CONFIG.md](CONFIG.md) for the full reference of every setting and environment variable.

Git tools refuse a repository containing a specifically protected audit/config path, including metadata-only operations. If the default relative audit path falls inside your checkout, set an absolute `AUDIT_LOG_PATH` outside that repository before starting the session. Keep protections enabled when moving the files. Git wrap-up requires an explicitly tracked working directory and human approval for each call; see [Git admission](docs/designs/git-protected-repositories.md).

### Local LLM statistics

Content-free LLM usage collection is enabled by default. It records token counts (input, thinking, output, and
totals), timing, protocol/provider/model routing, outcomes, refusals, and cost metadata when providers expose it. It
does not store prompts, completions, thinking text, tool payloads, request/response bodies, credentials, or arbitrary
headers. User/config-derived labels and non-public routes are pseudonymized with a local HMAC key; bounded model and
provider identifiers remain readable for analysis.

Data lives in `~/.ironcurtain/statistics/llm-usage.sqlite3`; the pseudonymization key is
`~/.ironcurtain/statistics/identity.key`. The default retention period is 90 days. Use `ironcurtain config` →
**LLM Statistics**, the web UI Settings view, or set `"statistics": { "enabled": false }` to opt out. Set
`retentionDays` to `null` to disable automatic pruning. Restart a long-running daemon after changing these settings.

`ironcurtain statistics summary` prints usage, speed and breakdowns. Manual deletion is available with
`ironcurtain statistics delete --before <ISO-date-or-epoch-ms>` or `--all`. This is logical SQLite row deletion, not
secure erasure: deleted bytes may remain in free pages, WAL files, filesystem snapshots, or backups, and the identity
key is kept. `ironcurtain statistics reset` deletes every row and rotates the identity key.

To route LLM traffic through a gateway like LiteLLM or OpenRouter (in both Code Mode and Docker Agent Mode), see [MODEL_ROUTING.md](MODEL_ROUTING.md).

Route Docker agents through model-provider profiles (e.g. GLM-5.3 / GLM-5.3-Flash via OpenRouter, no sidecar) with `ironcurtain config` → Model Providers, then pick a profile at `/new` or with `--provider-profile` — see [MODEL_ROUTING.md](MODEL_ROUTING.md#first-class-openrouter).

## Built-in Capabilities

IronCurtain ships with six pre-configured MCP servers. Calls to the first five are governed by your compiled policy; the memory server is IronCurtain's own and has a fixed per-tool policy.

| Server               | Tools | Key capabilities                                                                                                                                                                                                                                  |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem**       | 14    | Read, write, edit, search files; directory tree; move; diff calculation. Runs OS-confined to its roots.                                                                                                                                           |
| **Git**              | 28    | Full git workflow: status, diff, log, commit, branch, push/pull/fetch, clone, stash, blame                                                                                                                                                        |
| **Fetch**            | 2     | HTTP GET with HTML-to-markdown conversion; web search (Brave, Tavily, SerpAPI)                                                                                                                                                                    |
| **GitHub**           | 41    | Issues, PRs, code search, reviews via `ghcr.io/github/github-mcp-server` (pinned by digest); requires a GitHub personal access token. Tools without annotations are denied.                                                                       |
| **Google Workspace** | 128   | Gmail, Calendar, Drive, Docs, Sheets — requires OAuth setup via `ironcurtain auth`                                                                                                                                                                |
| **Memory**           | 7     | Persistent semantic memory with hybrid vector+keyword search, LLM summarization, and automatic compaction. For personas and cron jobs that enable it; not available in shared-container workflows. Bulk deletions and large ingests need a human. |

Read-only operations are allowed by default policy; mutations (writes, pushes, PR creation) escalate for human approval. Tools use `server.tool` naming (e.g., `filesystem.read_file`, `memory.recall`). Add your own servers with `ironcurtain mcp add` — see [ADDING_MCP_SERVERS.md](ADDING_MCP_SERVERS.md).

A few server-specific rules to know:

- **Filesystem** — the server can reach only its roots. Approving access to a file directly in your home directory, or in a directory that contains the IronCurtain home, a credential store or a temporary directory, is refused (`root-not-exposable`).
- **Git** — only `https` and `ssh` remotes work (no `file://`, local paths, `git://` or `http://`). Repository hooks do not run for the agent's commits. The server runs with your global git credential helpers and `core.sshCommand`, but it cannot read SSH private keys at their default names (`~/.ssh/id_*`) or `~/.git-credentials`: push over SSH through `ssh-agent`, whose socket the git server receives. A key file under another name stays readable to the git server. Your `~/.ironcurtain/mcp-servers.json` cannot widen a built-in server's sandbox; it may change only its `env` and network domain lists ([ADDING_MCP_SERVERS.md](ADDING_MCP_SERVERS.md#adjusting-a-built-in-server)). In Code Mode, writes into `.git` escalate. Every git call on a repository whose config defines include files, filter/diff/merge drivers, configuration-defined hooks or alternates, that redirects git outside the sandbox (a gitfile, `commondir` or `core.worktree`), or whose `.git` directory holds a symbolic link leading outside the sandbox (git would write refs, reflogs or commit messages through it), escalates too.
- **Fetch** — `http_fetch` follows same-origin redirects only (up to 5); a cross-origin redirect is returned to the agent, which must fetch the new URL itself. Private, loopback and metadata destinations are refused (see `fetch.allowPrivateNetworks` in [CONFIG.md](CONFIG.md#security)).

### Network Passthrough (Docker Agent Mode)

In Docker Agent Mode, the container has no network access — all traffic goes through IronCurtain's MITM proxy. By default, only LLM provider domains and the package registries are reachable. The agent can request access to additional domains at runtime via the `proxy` virtual MCP server (`add_proxy_domain`). Each request needs a human: it is never auto-approved, whitelisted or included in "approve all".

An approval is one host on one port: 443 by default, or 80 when the agent asks for `host:80`. Port 443 gets a **raw passthrough tunnel**, relayed only after the TLS handshake names the approved host; port 80 traffic must be HTTP for that host. Traffic to approved domains is not inspected and carries no injected credentials, which gives the agent greater utility (calling third-party APIs, streaming data from external services) but means it is **unmediated**. As an opt-in alternative, `egressPolicy` lets the session's policy decide every other destination, with an allowlist, audit entries and one escalation per host and port (see [CONFIG.md](CONFIG.md#security)). See [SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) Section 2b-i for the threat model and [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for usage details.

## Security Model

IronCurtain is designed around a specific threat model: **the LLM goes rogue.** This can happen through prompt injection (a malicious email or web page hijacks the agent) or through multi-turn drift (the agent gradually deviates from the user's intent over a long session).

### What IronCurtain enforces

- **Filesystem containment** — Symlink-aware path resolution prevents path traversal and symlink-escape attacks.
- **Per-tool policy** — Each MCP tool call is evaluated against compiled rules. The policy engine classifies tool arguments by role (read-path, write-path, delete-path) to make fine-grained decisions. Arguments without an annotation are denied.
- **Structural invariants** — Certain protections are hardcoded and cannot be overridden by the constitution: the agent can never read or modify its own policy files, audit logs, configuration, IronCurtain's credential file, or the host credential stores (SSH, cloud, Docker, npm and other stores; see `credentialProtection` in [CONFIG.md](CONFIG.md#security)).
- **Human escalation** — When policy says "escalate," the agent pauses and the user must explicitly approve or deny. Optionally, an LLM-based auto-approver handles unambiguous cases (see [CONFIG.md](CONFIG.md#security)).
- **Audit trail** — Every tool call and policy decision is logged to an append-only JSONL audit log, with a record written before each call is dispatched. A call is refused when the audit log cannot be written. `ironcurtain audit report|verify|proposals` summarizes it.
- **Resource limits** — Token, step, time, and cost limits. The builtin agent's limits apply per turn; Docker agents' token and cost limits are enforced by the MITM proxy for the whole container. See [CONFIG.md](CONFIG.md#resource-limits).
- **Optional, off by default** — task-scoped policies (`--task-scoped`), sequence-aware taint escalation (`taintEscalation`), outbound content checks for encoded or hidden data (`contentAssessment`), and policy-evaluated network egress (`egressPolicy`).

### Known limitations

This is a research prototype. Known gaps include:

- **Policy compilation fidelity** — The LLM-based compiler can misinterpret constitution intent. The verification pipeline catches many errors but is not exhaustive, and unless `policyVerifierModelId` names another model, the policy model writes the test scenarios and judges its own rules. Always review the compiled `compiled-policy.json`.
- **V8 isolate boundaries** — Code Mode uses V8 isolates, not OS-level virtualization. A V8 zero-day could allow escape.
- **Outbound content** — An agent allowed to write files or post messages could encode sensitive data to bypass content-level controls. The opt-in `contentAssessment` checks catch common encodings, not all of them.
- **Escalation fatigue** — Too many false-positive escalations can lead to habitual approval. Tune your constitution to minimize unnecessary prompts.

See [docs/SECURITY_CONCERNS.md](docs/SECURITY_CONCERNS.md) for a detailed threat analysis.

## Troubleshooting

| Issue                                                  | Guidance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Missing API key**                                    | Export the variable (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENAI_API_KEY`), add it to `~/.ironcurtain/.env` (chmod 600), or set the corresponding key in `~/.ironcurtain/config.json`. A `.env` in your project directory is not read.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Sandbox unavailable / an MCP server does not start** | The servers that ask for an OS sandbox (filesystem, git, google-workspace) need `bubblewrap`, `socat` and `ripgrep` on Linux: `sudo apt-get install -y bubblewrap socat ripgrep`. Under the default `sandboxPolicy` `enforce` such a server does not start without them; `"sandboxPolicy": "warn"` in `config.json` (or `ironcurtain config` → Security, or `IRONCURTAIN_SANDBOX_POLICY=warn`) runs it without OS containment and with a warning. A host where the tools are installed but srt cannot start a sandbox (AppArmor-restricted user namespaces) is treated the same: session start runs one srt test and names the failure. `ironcurtain doctor` reports the cause. |
| **Budget exhausted**                                   | Adjust limits in `~/.ironcurtain/config.json` under `resourceBudget` (or a persona's limits with `ironcurtain persona set`). Set any individual limit to `null` to disable it. Docker sessions count tokens and cost for the whole container, cache reads included, so long interactive sessions can reach the 1,000,000-token default.                                                                                                                                                                                                                                                                                                                                         |
| **Node version errors**                                | Supported Node.js lines are 24 and 26. Other major versions are rejected by `ironcurtain doctor`. After switching Node versions, reinstall IronCurtain so native modules are rebuilt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`node-pty` missing or not loadable**                 | `ironcurtain start` works without it; `mux`, the web UI terminal and Apple `container` interactive sessions do not. Install the build tools (see [Prerequisites](#prerequisites)). If `node-pty` is missing, reinstall: `npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`. If it is installed but does not load, rebuild it: `npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false` (`npm rebuild node-pty --ignore-scripts=false` in a checkout). `ironcurtain doctor` reports which case applies.                                                                                                                                  |
| **V8 sandbox (`isolated-vm`) does not load**           | Commands that run sessions (`start`, which `mux` runs, `workflow start` and `resume-standalone`, `daemon`, `bot`) stop with a V8 sandbox error; other commands work. `isolated-vm` is prebuilt for linux-x64/arm64, darwin-arm64 and win32-x64. Elsewhere (Intel Macs) npm compiles it, which needs the Xcode Command Line Tools (Linux: `python3`, `make`, `g++`) and its install script: if your npm configuration blocks unreviewed scripts, install with `npm install -g @provos/ironcurtain --allow-scripts=isolated-vm,node-pty`. `ironcurtain doctor` reports the cause.                                                                                                 |
| **Policy doesn't match intent**                        | Review `compiled-policy.json` to see the generated rules. Run `ironcurtain customize-policy` to refine your constitution, then `ironcurtain compile-policy` to recompile. Specific wording produces better rules — vague phrasing leads to vague policy.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Policy may be stale / persona refused**              | Recompile: `ironcurtain compile-policy`, `ironcurtain persona compile <name>` or `ironcurtain daemon recompile-job <id>`. A persona whose broad policy lacks the opt-in is refused with `POLICY_TOO_BROAD`: narrow its constitution or recompile with `--allow-broad`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Auto-approve not triggering**                        | The auto-approver approves only when your message explicitly authorizes the action and names every escalated resource (the path or its directory, the destination host, or the git remote name), within 120 seconds. Vague messages always escalate to human review. Verify `autoApprove.enabled` is `true` and that its model has an API key; in mux, type in command mode (Ctrl-A).                                                                                                                                                                                                                                                                                           |
| **PTY/mux terminal garbled after exit**                | Run `reset` in that terminal to restore normal mode. This is needed when the process is killed ungracefully and raw mode is not restored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Escalation listener: "already running"**             | Only one `ironcurtain escalation-listener` can run at a time. The lock at `~/.ironcurtain/escalation-listener.lock` is reclaimed automatically when the previous process is dead. Mux instances do not take this lock; while a listener runs, mux leaves escalations of sessions it did not start to the listener.                                                                                                                                                                                                                                                                                                                                                              |
| **Daemon: "already running"**                          | Only one daemon runs per IronCurtain home. The error names the process holding `~/.ironcurtain/daemon.lock`, which may also be a local `daemon run-job` or `recompile-job`. A crashed daemon's lock is reclaimed automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Request too large / proxy errors**                   | Requests to a model provider are limited to its documented size (32 MiB; 50 MiB for OpenAI and Codex): a larger conversation gets a 413. A 503 `overloaded_error` with `Retry-After` means a per-session proxy limit was reached briefly; a 504 means the provider did not answer within 10 minutes. An agent that sends its own API key to a provider host gets a 401: only the session's injected credential works.                                                                                                                                                                                                                                                           |
| **A file IronCurtain ships or compiles is refused**    | Files shipped in the package (`config/docker-workload/*.json`, `docker/build-trust-runtime/bin/*`), compiled policy files and directories, and tool annotations (`tool-annotations.json`, shipped or yours) must be owned by root, you or the package owner, must not be world-writable, and may be group-writable only by your own user-private group. The error names the path and the fix (`chmod o-w <path>` or `chmod g-w <path>`). Symlinked policy and annotation files are refused, even dangling ones; `annotate-tools --reset` removes your annotations file.                                                                                                         |
| **`config.json` not saved**                            | A save refuses to overwrite a file that is not valid JSON (`Nothing was saved; fix or remove the file first.`). The previous version of the file is in `config.json.bak`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Signal bot not responding**                          | Verify the signal-cli container is running (`docker ps \| grep ironcurtain-signal`). Check that Signal is configured (`ironcurtain setup-signal`) and that its image is pinned (`ironcurtain setup-signal --update-image`). See [TRANSPORT.md](TRANSPORT.md) for detailed troubleshooting.                                                                                                                                                                                                                                                                                                                                                                                      |

## Development

```bash
npm test                                    # Run all tests
npm test -- test/policy-engine.test.ts      # Run a single test file
npm test -- -t "denies delete_file"         # Run a single test by name
npm run lint                                # Lint
npm run typecheck:tests                     # Type-check the test suite
npm run build                               # TypeScript compilation + asset copy
```

See [TESTING.md](TESTING.md) for the full testing guide, including integration test flags and conventions, and [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

### Project Structure

```
src/
├── index.ts                    # `ironcurtain start` entry point
├── cli.ts                      # CLI command dispatcher
├── config/                     # Configuration loading, constitution, MCP server definitions
├── session/                    # Multi-turn session management, budgets, loop detection
├── sandbox/                    # V8 isolated execution environment (Code Mode)
├── trusted-process/            # Policy engine, MCP proxy, audit log, approval whitelist
├── pipeline/                   # Constitution → policy compilation pipeline (offline)
├── policy-artifacts/           # Policy provenance and canonical JSON (runtime leaf)
├── escalation/                 # Escalation listener: session registry, TUI dashboard, state
├── mux/                        # Terminal multiplexer: renderer, escalation picker, trusted input
├── pty/                        # Shared PTY bridge (mux and web UI terminals)
├── persona/                    # Persona management (create, compile, resolve)
├── memory/                     # Memory server integration and the `memory` command
├── signal/                     # Signal messaging transport (bot daemon, setup, formatting)
├── daemon/                     # Unified daemon (Signal + cron scheduler, control socket)
├── cron/                       # Cron job management (scheduler, job store, git sync, policy)
├── docker/                     # Docker agent mode, PTY session, MITM proxy, registry proxy
├── docker-workload/            # Nested Docker leases, admission and watchdog
├── workflow/                   # Multi-agent workflow engine (orchestrator, state machine, gates)
├── web-ui/                     # Web UI backend (JSON-RPC dispatch, event bus, workflow manager)
├── doctor/                     # `ironcurtain doctor` checks
├── audit/                      # `ironcurtain audit` (reports, chain verification, proposals)
├── llm-metrics/                # LLM statistics, pricing
├── maintenance/                # Retention and `ironcurtain prune`
├── servers/                    # Built-in MCP servers (fetch, web search providers)
└── types/                      # Shared type definitions
packages/
├── memory-mcp-server/          # Standalone memory MCP server (publishable npm package)
└── web-ui/                     # Svelte web UI served by the daemon
```

## License

[Apache-2.0](LICENSE)
