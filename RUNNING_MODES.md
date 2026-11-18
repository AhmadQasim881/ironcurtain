# Running Modes

IronCurtain supports several running modes beyond the recommended `ironcurtain mux`. This document covers all available modes and when to use them, and lists the other commands.

Every command answers `--help` (`ironcurtain <command> --help`). The global options `-h`/`--help`, `-v`/`--version` and `--env-file <path>` count only before the command: `ironcurtain --help start` prints the top-level help, and `ironcurtain start -v` is an error.

## Terminal Multiplexer (recommended)

The default and recommended way to use IronCurtain. See the main [README](README.md) for quick start.

```bash
ironcurtain mux
ironcurtain mux --agent claude-code   # Specify agent (default: claude-code)
```

The mux supports session resume and persona selection through an interactive picker when spawning new tabs, and `/new [persona] --task-scoped <task>` for a task-scoped tab.

See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the full walkthrough: input modes, trusted input security model, escalation workflow, and keyboard reference.

## Non-Mux Start Sessions

`ironcurtain start` remains useful for one-shot tasks, scripts, and explicit builtin-agent sessions. It is not the recommended interactive Docker-agent UI; use `ironcurtain mux` for that.

### Builtin Agent (Code Mode)

IronCurtain's own LLM agent writes TypeScript that executes in a V8 sandbox. IronCurtain controls the agent, the sandbox, and the policy engine. Docker is not required. `--agent builtin` (or `preferredMode: "builtin"`) needs an API key for the agent model; without one the session refuses to start.

### Builtin interactive mode

A multi-turn session where you type tasks and the agent responds:

```bash
ironcurtain start --agent builtin
```

Escalated tool calls pause the agent and prompt you with `/approve` or `/deny` (see [Session commands](#session-commands)).

### Single-shot mode

Send one task and exit when the agent finishes:

```bash
ironcurtain start "Summarize the files in the current directory"
```

### Workspace mode

Point the agent at an existing directory instead of a fresh sandbox:

```bash
ironcurtain start -w ./my-project "Fix the failing tests"
ironcurtain start --workspace /home/user/repos/my-app
```

The workspace replaces the session sandbox as the agent's working area. All session infrastructure (logs, escalations, audit) still lives under `~/.ironcurtain/sessions/`. The path must be an existing directory, and it is validated to prevent use of sensitive directories: your home directory itself and its ancestors, the IronCurtain home and anything inside it, IronCurtain's own package directory, the MCP servers' private scratch directory (`<tmpdir>/ironcurtain-<uid>`), anything inside it and its ancestors (on Linux, `/tmp`), and directories that contain protected files are refused. (So run IronCurtain on IronCurtain's own source from a separate checkout.) A protected file that is a symbolic link to a missing file counts as being where the link points, and a workspace may not hold another link on the way there.

### Task-scoped sessions

```bash
ironcurtain start --task-scoped "Summarize the notes in ./notes"
```

`--task-scoped` compiles the task text into a task scope (the pre-filter plus a per-server compile, without verification) and intersects it with the session policy: calls the task does not need escalate (rule `task-scope-escalate`), and you can approve or whitelist them as usual. Scopes are cached under `~/.ironcurtain/task-policies/`, so a rerun with the same task and workspace starts at once. With `--pty` the task text only sets the scope. Resume keeps the scope, and `--task-scoped` is ignored with `--resume`.

### Personas

Use a named persona profile with its own constitution, compiled policy, and persistent workspace:

```bash
ironcurtain start -p exec-assistant "Check my email"
ironcurtain start --persona coder "Refactor the auth module"
```

A session refuses a persona whose constitution changed since its last compile; `--allow-stale-policy` runs the old policy once, with a warning. Manage personas with the `ironcurtain persona` subcommand (`create`, `list`, `compile`, `edit`, `set`, `clone`, `rename`, `show`, `delete`, `trash`). See `ironcurtain persona --help` for details.

### Session resume

Resume a previous non-mux session. In mux, use `/resume` from command mode.

```bash
ironcurtain start --resume <session-id>
```

Session IDs are printed on session start (`Session <id> (resume with: ironcurtain start --resume <id>)`) and stored under `~/.ironcurtain/sessions/`. A resumed session keeps its persona, workspace, policy, task scope and agent, as recorded in `~/.ironcurtain/sessions/<id>/session-metadata.json`. Without `--agent` it resumes with the agent it was created with, so a builtin session resumes as builtin and a container session in container mode even when the configured default is the other one; an `--agent` that switches between the two is refused. A metadata file that is there but cannot be read (damaged, truncated, not a regular file) refuses the resume instead of resuming the session without its persona, policy and task scope: fix the file, or move it aside to resume without them. A builtin session restores its conversation from `~/.ironcurtain/sessions/<id>/messages.jsonl`; a session created before conversations were saved, or one that never completed a turn, resumes with its workspace only. A corrupted `messages.jsonl` refuses the resume (move it aside to resume with the workspace only). Only one process runs a session at a time, builtin or container, fresh or resumed: resuming a session that is still running, in this or another terminal, is refused with `already in use by a running session`. An ID with no session directory is refused with `session directory not found`.

### Session commands

Commands available during an interactive or single-shot session:

| Command            | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `/approve [N]`     | Approve escalation #N                                                         |
| `/approve+ [N]`    | Approve #N and whitelist the exact path or domain for the rest of the session |
| `/approve+dir [N]` | Approve #N and whitelist its directory (recursively), when offered            |
| `/deny [N]`        | Deny escalation #N                                                            |
| `/budget`          | Show resource consumption (tokens, steps, cost)                               |
| `/logs`            | Display diagnostic events                                                     |
| `/quit`            | End the session                                                               |

Several escalations can be pending at once (parallel tool calls). Banners are numbered (`ESCALATION #N`), and the number may be omitted only while exactly one escalation is pending.

Ctrl-C (or SIGTERM/SIGHUP) during session setup tears down whatever was created; a second Ctrl-C or SIGTERM forces the exit (a repeated SIGHUP does not). An interrupted setup exits with 128 plus the signal number (130 for Ctrl-C), and so does a session that a signal ends, once it has closed.

The exit status tells scripts how the session ended: 0 when it ended normally (the single-shot task completed, or `/quit`), 1 when the single-shot task failed or a budget stopped it, and 1, with the preflight's message and no stack trace, when the mode preflight fails (no container runtime, no credentials). Declining the first-start wizard skips setup, not the task: the session still starts.

## Legacy Raw PTY Mode (Docker Agent, separate escalation listener)

Raw PTY mode is a low-level debugging workflow. It requires two terminals and does not provide mux trusted input:

```bash
# Terminal 1 — interactive agent session (e.g., Claude Code in Docker)
ironcurtain start --pty

# Terminal 2 — approve or deny escalations from all active PTY sessions
ironcurtain escalation-listener
```

This workflow does not support trusted input or auto-approval for PTY sessions. Use `ironcurtain mux` for normal interactive work. The escalation listener needs a terminal, and only one can run at a time. Its `/approve all` (like `/approve group N`) first lists what it would approve with a 6-character code, and approves only when you repeat the command with that code while the same escalations are pending.

**Emergency exit and terminal recovery:** Press `Ctrl-\` to trigger a graceful shutdown of the PTY session. If the process is killed ungracefully, run `reset` in that terminal to restore normal terminal mode. The agent's terminal output is filtered before it reaches your terminal (no clipboard, title or hyperlink escape sequences), and terminal modes are restored on exit.

## Signal Messaging Transport

Run IronCurtain sessions via Signal messages — send tasks, receive responses, and approve or deny escalations from your phone. All communication is end-to-end encrypted via the Signal protocol.

```bash
ironcurtain setup-signal    # One-time setup wizard
ironcurtain bot             # Run the Signal transport alone
```

`ironcurtain bot` runs only the Signal transport, without the cron scheduler. It takes only `-a`/`--agent` and `--help`, and refuses subcommands; use `ironcurtain daemon` for Signal plus scheduled jobs and for the job commands. One process runs Signal per IronCurtain home: a second bot, or a bot beside a daemon that runs Signal, exits naming the one already running. See [TRANSPORT.md](TRANSPORT.md) for setup instructions, the reply syntax for approvals, architecture details, and why we chose Signal over alternatives like Telegram.

## Daemon Mode

A unified long-running daemon that combines Signal messaging with scheduled cron jobs. Define recurring tasks with per-job security policies, and IronCurtain runs them headlessly on a cron schedule.

```bash
ironcurtain daemon add-job        # Interactive wizard to define a scheduled job
ironcurtain daemon                # Start the daemon (Signal + cron)
ironcurtain daemon --no-signal    # Cron-only mode (no Signal transport)
ironcurtain daemon --web-ui       # Start with browser-based dashboard
ironcurtain daemon list-jobs      # List jobs with schedule and status
ironcurtain daemon logs <id>      # Show recent run summaries
```

The `--web-ui` flag enables a browser-based dashboard for monitoring sessions, handling escalations, and managing jobs, workflows and personas. See the [Web UI section in DAEMON.md](DAEMON.md#web-ui) for details.

Each job has its own task description, security constitution (compiled into per-job policy rules), persistent workspace, optional git repo sync, and configurable resource budgets. Without Signal, an escalation of a cron run waits for a decision in the web UI while a browser is connected, and is denied otherwise; with Signal and `notifyOnEscalation`, it is sent to your phone.

See [DAEMON.md](DAEMON.md) for the full setup guide, job definition reference, and troubleshooting.

## OAuth Authentication

IronCurtain supports third-party OAuth providers for MCP servers that require authenticated access (e.g., Google Workspace). Manage OAuth credentials with the `auth` subcommand:

```bash
ironcurtain auth                           # Show status of all providers
ironcurtain auth import <provider> <file>  # Import OAuth client credentials
ironcurtain auth <provider>                # Authorize a provider (opens browser)
ironcurtain auth <provider> --no-browser   # Authorize on a headless host (paste the redirect URL back)
ironcurtain auth revoke <provider>         # Revoke and delete stored token
```

`auth revoke` deletes the stored token only when the provider confirms the revocation; otherwise it keeps the token and exits 1. `auth import` validates the file before it replaces stored credentials.

## Agent Selection

Both `start` and `mux` accept `--agent` to choose which agent adapter to use. List registered agents with:

```bash
ironcurtain start --list-agents
```

## Other commands

| Command                                                | Purpose                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ironcurtain setup`                                    | Run the first-start wizard again (needs a terminal)                                                                                                                             |
| `ironcurtain config`                                   | Edit `~/.ironcurtain/config.json` interactively ([CONFIG.md](CONFIG.md))                                                                                                        |
| `ironcurtain doctor`                                   | Read-only diagnostics; `--check-api` round-trips each model role, `--check-refresh` tests OAuth refresh, `--upgrade` checks what an upgrade left behind                         |
| `ironcurtain customize-policy`                         | LLM-assisted constitution editing                                                                                                                                               |
| `ironcurtain compile-policy`                           | Compile the constitution into rules ([README](README.md#policy-constitution--enforcement))                                                                                      |
| `ironcurtain annotate-tools`                           | Classify MCP tool arguments; `--check` reports drift without an LLM                                                                                                             |
| `ironcurtain refresh-lists`                            | Re-resolve dynamic lists                                                                                                                                                        |
| `ironcurtain mcp add\|remove\|list`                    | Manage your own MCP servers ([ADDING_MCP_SERVERS.md](ADDING_MCP_SERVERS.md))                                                                                                    |
| `ironcurtain workflow ...`                             | Multi-agent workflows ([WORKFLOWS.md](WORKFLOWS.md))                                                                                                                            |
| `ironcurtain observe <label>\|--all`                   | Watch live LLM token output of running sessions                                                                                                                                 |
| `ironcurtain statistics summary\|delete\|reset`        | Local LLM usage statistics ([CONFIG.md](CONFIG.md#local-llm-statistics))                                                                                                        |
| `ironcurtain audit report\|verify\|proposals`          | Summarize audit logs, verify the policy-mutation log, review policy amendments learned from your approvals                                                                      |
| `ironcurtain memory <persona\|job> ...`                | Review and curate persistent memory (`list`, `search`, `show`, `forget`, `export`, `import`, `stats`, `review`); `ironcurtain memory prefetch` downloads the memory models      |
| `ironcurtain prune [--dry-run]`                        | Remove old sessions, workflow runs, run records and dependency caches (`retention` in [CONFIG.md](CONFIG.md))                                                                   |
| `ironcurtain gc [--dry-run\|--force]`                  | Inspect or reclaim orphaned IronCurtain containers and networks (`--runtime docker\|apple-container\|all`)                                                                      |
| `ironcurtain images status\|rebuild\|prune`            | Show, rebuild or prune the Docker agent images and their CLI versions. Superseded builds stay tagged, so `docker image prune` does not remove them; `images prune --force` does |
| `ironcurtain docker-workload status\|reconcile\|clear` | Nested-Docker leases ([CONFIG.md](CONFIG.md#nested-docker-workloads))                                                                                                           |
