# Daemon Mode

IronCurtain's daemon mode runs a long-lived process that combines Signal messaging with scheduled cron jobs. The daemon manages both interactive sessions (triggered by Signal messages or the web UI) and headless sessions (triggered by cron schedules) through a single process with unified escalation routing.

Use daemon mode when you want IronCurtain to run tasks on a schedule — code reviews, repository maintenance, report generation, data processing — without manual intervention.

## Quick Start

**1. Define a job:**

```bash
ironcurtain daemon add-job
```

The interactive wizard asks for a job ID, a display name, a cron schedule, an optional git repository, an optional custom workspace, an optional persona, the task description, the task constitution (the job's security policy), optional budget overrides, whether to notify over Signal on escalation and on completion, and whether the job gets persistent memory. It can generate the constitution from the task description with an LLM; the generator explores a throwaway clone of the job's repository, so a job without a repository has no project files for it to look at. Multi-line fields (task description, constitution) open your `$VISUAL` or `$EDITOR`. `edit-job` offers the same steps.

- **Workspace:** an existing directory, checked as the daemon checks it before every run (like `start --workspace`) and saved as its canonical path. Leave it empty for the default workspace. A job's git repository is synced into a custom workspace too, which must be empty the first time.
- **Persona:** one of your personas, or none. A persona job runs under the persona's compiled policy, so it needs no task constitution and the wizard compiles no policy for it; compile the persona with `ironcurtain persona compile <name>`.
- **Budget overrides:** each limit in turn. A number overrides the limit, `none` removes it, and an empty answer keeps the default (see [Resource Budgets](#resource-budgets)).

When you confirm, `add-job` compiles the job's policy; for a persona job it checks the persona instead (its compiled policy, agent model and resource limits, as the daemon does before every run). The job is saved disabled until that compile (or check) succeeds: after a failed compile, fix the constitution and run `ironcurtain daemon recompile-job <id>`, then `ironcurtain daemon enable-job <id>` (for a persona job, fix the persona, then run `enable-job`). A compile that writes the policy without some servers (they failed to compile and have no rules, so the job's calls to their tools would be denied) also leaves the job disabled: `add-job` names them and exits 2; `recompile-job` retries, and `enable-job` alone runs the job under the policy as it is. `edit-job` recompiles the policy of a job without a persona when its constitution or workspace changed, or when its policy is missing or stale. A workspace change first moves the policy compiled for the old workspace aside (to `generated/compiled-policy.revoked.json`), so the job does not run until the recompile succeeds. A running daemon is asked to load the new job, so it is scheduled without a restart.

**2. Start the daemon:**

```bash
ironcurtain daemon
```

The daemon takes the daemon lock, loads and schedules all enabled jobs, and optionally connects to Signal and starts the web UI. It does not compile policies: it lists the jobs whose policy is missing or stale (they will not run until recompiled) and the jobs whose `job.json` is invalid (they are not loaded). It runs until stopped with Ctrl-C or SIGTERM.

**Example: daily repository triage**

```bash
# Add a job that triages GitHub issues every morning at 8am
ironcurtain daemon add-job
# → ID: issue-triage
# → Schedule: 0 8 * * *
# → Task: "Review open issues in the repo, label them, and close stale ones"
# → Constitution: "Allow reading and labeling issues. Escalate closing issues."
# → Git repo: https://github.com/myorg/myrepo.git

# Start the daemon
ironcurtain daemon
```

## Job Definition

Jobs are defined interactively via `add-job` and stored as JSON at `~/.ironcurtain/jobs/{jobId}/job.json`. A `job.json` that fails validation is not scheduled: `list-jobs` shows it as `INVALID: <reason>`, `ironcurtain doctor` reports it under `Cron jobs`, and `remove-job` can still delete it.

| Field                | Type    | Required | Description                                                                                                                                             |
| -------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string  | Yes      | Stable slug identifier (lowercase alphanumeric, hyphens, underscores, 1-63 chars)                                                                       |
| `name`               | string  | Yes      | Human-friendly display name                                                                                                                             |
| `schedule`           | string  | Yes      | Cron expression (5-field format: min hour dom mon dow)                                                                                                  |
| `taskDescription`    | string  | Yes      | English task description sent to the agent as its work prompt                                                                                           |
| `taskConstitution`   | string  | Yes      | English policy text compiled into per-job security rules                                                                                                |
| `workspace`          | string  | No       | Custom workspace path (default: `~/.ironcurtain/jobs/{id}/workspace/`). `~/...` and symlinked paths work; the path is checked like `start --workspace`. |
| `gitRepo`            | string  | No       | Git repository URI to sync before each run (see [Workspace and Git Sync](#workspace-and-git-sync))                                                      |
| `notifyOnEscalation` | boolean | Yes      | With Signal: send escalations as Signal messages and wait for a reply (see [Escalation Handling](#escalation-handling))                                 |
| `notifyOnCompletion` | boolean | Yes      | With Signal: send a message with the run summary on completion                                                                                          |
| `budgetOverrides`    | object  | No       | Per-job resource budget overrides (see [Resource Budgets](#resource-budgets))                                                                           |
| `persona`            | string  | No       | Run under this persona's compiled policy (and memory) instead of the job's own; `taskConstitution` is then not used                                     |
| `memory`             | object  | No       | Per-job memory choice (`{ "enabled": false }` turns it off); absent means on, subject to the global `memory.enabled`                                    |
| `enabled`            | boolean | Yes      | Whether the job is scheduled. Disabled jobs are skipped                                                                                                 |

## Commands

All commands are subcommands of `ironcurtain daemon`:

| Command                | Description                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(no subcommand)_      | Start the daemon                                                                                                                                      |
| `add-job`              | Add a new scheduled job (interactive wizard; compiles its policy)                                                                                     |
| `edit-job <id>`        | Edit an existing job (interactive, same steps as `add-job`; recompiles when the constitution or workspace changes, or the policy is missing or stale) |
| `list-jobs`            | List all jobs with schedule, status, next run time, last outcome and failure streak                                                                   |
| `run-job <id>`         | Run a job now                                                                                                                                         |
| `status`               | Show daemon status (uptime, job counts, Signal status, next fire time)                                                                                |
| `remove-job <id> [-f]` | Delete a job and all its artifacts, cancelling a run in progress (`-f` skips the confirmation)                                                        |
| `disable-job <id>`     | Stop scheduling a job (preserves definition and workspace)                                                                                            |
| `enable-job <id>`      | Resume scheduling a disabled job                                                                                                                      |
| `recompile-job <id>`   | Re-run policy compilation for a job (and reschedule it)                                                                                               |
| `logs <id> [--runs N]` | Show recent run records (default: last 5 runs)                                                                                                        |

**Daemon options:**

| Option                    | Description                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-a, --agent <name>`      | Agent mode (same as `ironcurtain start`)                                                                                                                           |
| `--no-signal`             | Skip Signal transport (cron-only mode)                                                                                                                             |
| `--web-ui`                | Enable the web UI (see [Web UI](#web-ui))                                                                                                                          |
| `--web-port <port>`       | Web UI port (default: 7400)                                                                                                                                        |
| `--web-ui-dev`            | Also accept the Vite dev server as an Origin (development; see [Development workflow](#development-workflow))                                                      |
| `--capture-traces`        | Capture LLM API traces for every session this daemon launches (see [TRAJECTORIES.md](TRAJECTORIES.md))                                                             |
| `--allow-policy-mutation` | Allow the web UI to create/edit/compile/delete personas and to change its Settings (default: **off**; see [Persona policy management](#persona-policy-management)) |
| `-f, --force`             | Skip confirmation prompts                                                                                                                                          |

**How job commands reach the daemon.** `list-jobs`, `run-job`, `remove-job`, `enable-job`, `disable-job` and `recompile-job` go to the running daemon over its control socket whenever one is reachable. They run locally only when no daemon is reachable (no socket, a stale socket, or no connection within 2 seconds). Run locally, every one of them except `list-jobs` holds the daemon lock, so a daemon cannot start in the middle of it; `list-jobs` only reads the job files and takes no lock. When a daemon took the request but failed, dropped it or did not answer in time, the command reports an error and exits 1; it is never repeated locally, because the daemon may already be doing the work. `add-job` and `edit-job` write the job files themselves and then ask a running daemon to reload the job. An unknown job id fails with `Job not found: <id>`.

`run-job` starts the run in the daemon and then waits for it by polling; Ctrl-C stops the waiting, not the run. It exits 1 when the run's outcome is not success, and refuses a job that is already running (`JOB_ALREADY_RUNNING`). `recompile-job` and `edit-job` exit 2 when the policy was written but some servers failed to compile: they are named, have no rules, and the job's calls to their tools are denied until a compile succeeds (the job keeps its schedule; through a daemon, its log has the reasons). `recompile-job` waits up to 60 minutes for the daemon, `remove-job` up to 5. `remove-job` asks for confirmation whether or not a daemon runs, unless `-f` is given.

Only starting the daemon, and a `run-job` that no running daemon takes, check the V8 sandbox and resolve the session mode (the container runtime and credential probe). The other subcommands work where `isolated-vm` cannot load or Docker is down. A session mode that cannot be resolved stops `ironcurtain daemon` with the preflight message and exit 1.

**`list-jobs` labels.** `NO POLICY` or `POLICY STALE`: the job will not run until it is recompiled. `NOT SCHEDULED`: an enabled job the running daemon does not hold (run `enable-job`). `QUEUED`: a run waiting for `cron.maxConcurrentRuns`. `INVALID: <reason>`: a broken `job.json`.

## Cron Expressions

Jobs use standard 5-field cron expressions:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

**Examples:**

| Expression     | Description                          |
| -------------- | ------------------------------------ |
| `0 8 * * *`    | Every day at 8:00 AM                 |
| `0 8 * * 1-5`  | Weekdays at 8:00 AM                  |
| `*/30 * * * *` | Every 30 minutes                     |
| `0 0 1 * *`    | First day of every month at midnight |
| `0 9 * * 1`    | Every Monday at 9:00 AM              |

Schedules use local time. In the spring-forward gap of a daylight-saving change, a fixed-time job (minute and hour fields that do not start with `*`) runs once right after the gap, and a job whose minute or hour field starts with `*` skips it. In the repeated fall-back hour a fixed-time job runs once and such a wildcard job runs at both occurrences. Day and month combinations that never occur are rejected. A fire time the daemon reaches more than 5 minutes late (the machine slept, or the daemon was blocked) counts as missed: it is skipped and logged, unless `cron.catchUpMissedRuns` is set in `config.json`, which runs the job once however many of its fire times the gap covered. Runs missed while the daemon was not running are never caught up. A scheduled run is also skipped while the job's previous run is still in progress (with a Signal notice). `cron.maxConcurrentRuns` limits how many job runs start at once ([CONFIG.md](CONFIG.md#retention-personas-and-cron)).

## Per-Job Policy

Each job has its own security policy compiled from its `taskConstitution` field. This is separate from the global policy used by interactive sessions.

**How it works:**

1. The `taskConstitution` text is compiled through the same pipeline as the global constitution (compile → verify), against the job's workspace (or the default job workspace). Job policies can never opt in to broad domains.
2. Compiled artifacts are written to `~/.ironcurtain/jobs/{jobId}/generated/`.
3. The job's workspace directory is set as the `allowedDirectory` for policy evaluation — file operations within the workspace are governed by the job's own rules.
4. Tool annotations are reused from the global annotations (the shipped ones plus your overlay); only the policy rules are job-specific.

**Runs check their policy.** Every run checks that `jobs/{jobId}/generated/compiled-policy.json` exists and was compiled from the job's current `taskConstitution` (for a persona job: that the persona's policy is fresh and, unless the persona opted in to broad policies, not broad). Otherwise the run is refused with an error run record and, with Signal, a "Not run" notice. The daemon never compiles by itself, and no override lets a job run with a stale policy: `--allow-stale-policy` is accepted only by an interactive `ironcurtain start` (a persona session, or resuming a job's session).

**When to recompile:**

- After editing a job's `taskConstitution` or `workspace` by hand (`edit-job` recompiles for you)
- After updating global tool annotations (`ironcurtain annotate-tools`)
- After an IronCurtain upgrade that reports the policy as possibly stale
- Manually via `ironcurtain daemon recompile-job <id>`

## Workspace and Git Sync

Each job has a persistent workspace directory that survives across runs.

**Default workspace:** `~/.ironcurtain/jobs/{jobId}/workspace/`

**Git sync behavior:** When a job has a `gitRepo` configured, the daemon keeps a bare mirror of it at `~/.ironcurtain/jobs/{jobId}/repo.git`, which is never mounted into the agent's container. Before every run it:

- fetches the repository into the mirror (the first run clones it; changing `gitRepo` re-clones);
- moves the workspace's `.git` aside and rebuilds it from the mirror, so commits and branches the agent made in the previous run do not persist;
- hard-resets the tracked files to the remote's default branch, which follows the upstream `HEAD` on every sync (falling back to the recorded branch, then `main`, then `master`). Files dropped upstream are deleted; untracked files are kept.

The run record's `discardedChanges` lists the agent's changes to tracked files since the previous sync (never upstream changes); it is empty on the first sync. A sync that fails or times out records an error run, and the agent does not run. A custom `workspace` must be empty the first time it is synced, so a sync never replaces files it did not create.

The rebuilt `.git` has `origin` set to `gitRepo` without the credentials a URL can carry: an `https://user:token@host/...` URL loses its whole `user:token@` part, any other URL only its password. Credentials embedded in `gitRepo` stay on the host (in `job.json` and the job's mirror) and are used only by IronCurtain's own fetches; the constitution generator's prompt names the repository without them too. An agent that pushes needs credentials of its own.

**One run per workspace:** two jobs may name the same custom `workspace`, and a workflow may run in a job's workspace, but never at the same time. A run takes the workspace lock that workflow runs take (`~/.ironcurtain/workflow-workspace-locks/`) before its git sync and keeps it until its session has ended. A run that finds the workspace in use by another job's run or a workflow is not run and never syncs: it records an error (phase `setup`) and, with Signal, sends a "Not run" notice whatever `notifyOnCompletion` says.

**Supported protocols:** `https`, `http`, `ssh`, `git`, `file`, and SCP-style (`git@host:org/repo.git`). The `ext::` protocol is rejected for security. Each fetch may use only its own URL's transport (`file` only for a `file://` URL). Git runs without prompts: ssh runs in batch mode with a 30-second connect timeout, so keys must work without a passphrase prompt (ssh-agent or a passphrase-less deploy key) and the host key must already be in `known_hosts`; HTTPS credentials must come from a non-interactive credential helper in your global git config. LLM provider keys are never passed to git. Timeouts: 2 minutes to query the remote, 10 minutes for the first fetch, 5 minutes for later fetches and for each local step.

**Cross-run state files:**

Persistent memory across runs is handled by the memory MCP server (see the [memory-mcp-server README](packages/memory-mcp-server/README.md)). The agent also maintains a file in the workspace:

- **`last-run.md`** — A structured summary of the run: date/time, actions taken with counts, issues encountered, recommendations for the next run. Before every run the daemon moves the previous `last-run.md` to **`previous-run.md`** (the agent is told to read it), so the run record captures only what the current run wrote: sanitized, at most 2000 characters, read from at most 8 KiB.

Every run produces a run record in `jobs/{jobId}/runs/` (and `latest.json` with the newest record and the failure streak), including runs that failed in setup or in the git sync; the record's error says which `phase` failed (`setup`, `sync` or `session`). With Signal, every run also sends a completion notice when `notifyOnCompletion` is on.

## Escalation Handling

How tool call escalations of a cron run are handled depends on whether the daemon runs the Signal transport. Once the transport has started, it counts as running until the daemon stops, also while its connection is down (it keeps reconnecting):

**Without Signal (not configured, `--no-signal`, an `ironcurtain bot` holding the Signal lock, or the Signal transport failed to start):**

- When a browser has the daemon's web UI open as the escalation arrives, the escalation waits there for a decision for up to `escalationTimeoutSeconds`, also if the browser disconnects meanwhile. When no browser is connected (a CLI client such as `observe` does not count), it is denied at once. `notifyOnEscalation` does not apply. The agent is instructed not to retry denied operations and to note them in its summary.

**With Signal and `notifyOnEscalation: true`:**

- The daemon sends a Signal banner describing the escalation, with a 4-character code in its header and the arguments in a second message, and waits for a reply up to `escalationTimeoutSeconds`. Reply `approve <code>` (or `approve #N <code>`) to approve, `approve+ <code>` to approve and whitelist the pattern the banner shows, and `deny <code>` to deny (`deny` alone works while only one escalation is pending, `deny #N` while only one is pending on session N); `details <code>` shows more of the arguments. A bare `approve`, or `approve 2` without the code, is refused. The escalation can also be decided in the web UI.
- Escalation routing is unified across Signal-initiated and cron-initiated sessions. When no decision arrives before the escalation times out, the request is denied and the expiry is announced over Signal. A banner that still cannot be delivered after retries (for example while signal-cli is unreachable) denies the escalation.

**With Signal and `notifyOnEscalation: false`:**

- Escalations are denied at once, even while a browser has the web UI open.

Completion notifications (`notifyOnCompletion: true`) send a Signal message with the run outcome, duration, cost and summary; the summary is quoted as plain text, each line prefixed with `│ `. See [TRANSPORT.md](TRANSPORT.md) for the Signal reply syntax.

## Resource Budgets

Cron jobs use tighter default budgets than interactive sessions to prevent runaway costs:

| Limit           | Cron Default | Interactive Default |
| --------------- | ------------ | ------------------- |
| Max tokens      | 500,000      | 1,000,000           |
| Max steps       | 100          | 200                 |
| Session timeout | 1 hour       | 30 minutes          |
| Cost cap        | $2.00        | $5.00               |

Override per-job with the budget step of `add-job` or `edit-job` (`none` removes a limit), or the `budgetOverrides` field in the job definition. Set any field to `null` to disable that limit. Precedence, field by field: `budgetOverrides`, then the persona's `resourceBudget` (for a persona job), then the cron defaults above.

```json
{
  "budgetOverrides": {
    "maxTotalTokens": 1000000,
    "maxSteps": null,
    "maxSessionSeconds": 7200,
    "maxEstimatedCostUsd": 5.0
  }
}
```

When a budget is exhausted, the run ends with outcome `budget_exhausted` and the exceeded dimension is recorded. For a builtin-agent job every limit applies per turn. For a Docker-agent job the session timeout bounds each turn inside the container (a timed-out turn records `budget_exhausted`, dimension `wall_clock`), and the token and cost limits are cumulative for the run: the MITM proxy refuses further model requests once one is reached, mid-turn, and the run ends with `budget_exhausted`. A run record's `budget` is the run's total, including a memory auto-save turn; a cost nothing reported is shown as unknown, not as $0.00. See [CONFIG.md](CONFIG.md#resource-limits).

## File Layout

```
~/.ironcurtain/
├── daemon.sock                    # Unix domain socket for CLI ↔ daemon communication (0600)
├── daemon.lock                    # Singleton lock (owner pid and process identity)
├── signal.lock                    # Held by the one process running the Signal transport (this daemon or ironcurtain bot)
├── jobs/
│   └── {jobId}/
│       ├── job.json               # Job definition
│       ├── repo.git/              # Daemon-owned bare mirror of gitRepo
│       ├── generated/             # Compiled per-job policy artifacts
│       │   ├── compiled-policy.json
│       │   └── ...
│       ├── workspace/             # Persistent workspace (or custom path)
│       │   ├── last-run.md        # This run's summary (written by the agent)
│       │   ├── previous-run.md    # The previous run's last-run.md
│       │   └── ...                # Cloned repo or working files
│       └── runs/
│           ├── {timestamp}.json   # Run records (one per run)
│           └── latest.json        # Newest record and the failure streak
├── logs/
│   └── daemon.log                 # Daemon log (rotated to daemon.log.1 ... .3)
└── sessions/
    └── {sessionId}/               # Per-run session data (audit, escalations, logs)
```

The daemon makes the IronCurtain home `0700` at start and refuses to start when the home is not owned by the current user. Run records beyond `retention.jobRuns.maxRecords` (200 by default) are removed by `ironcurtain prune`, or by the daemon itself with `retention.autoPrune` ([CONFIG.md](CONFIG.md#retention-personas-and-cron)).

## Running as a service

The daemon handles SIGINT and SIGTERM with a graceful shutdown: every workflow run is aborted with the reason `Daemon shutdown` (a `snapshotOnStop` snapshot within 40 seconds, a terminal checkpoint, container teardown), all within a 60-second deadline. Runs paused at a gate come back as resumable `aborted` runs, and resuming re-raises the same gate. A second SIGINT or SIGTERM forces the exit; the daemon also forces its own exit after 85 seconds. SIGHUP depends on where the daemon runs. In a terminal (its stdout or stderr is one), closing the terminal drains it the same way, and the second SIGHUP a closing terminal sends does not force the exit. Outside a terminal, as under `nohup ironcurtain daemon &` (which moves stdout and stderr off the terminal), under a service manager, or when `--ensure-daemon` started it, SIGHUP is ignored, so the daemon keeps running after logout; stop it with SIGTERM. Node does not keep the ignored SIGHUP that `nohup` sets, so it is this handling, not `nohup` itself, that keeps a hangup from killing the daemon.

Under systemd, keep `TimeoutStopSec` at 90 seconds or more, and prefer `KillMode=mixed`, so that SIGTERM reaches only the daemon first: with the default `control-group` mode its MCP relays and Docker CLI children are signalled at the same moment, and the graceful workflow drain cannot rely on them.

At start, the daemon also runs one background recovery pass for nested-Docker leases when any lease is stale or has an incident, and logs the outcome.

## Web UI

The daemon can optionally serve a browser-based dashboard for monitoring sessions, reviewing escalations, and managing jobs, workflows and personas. The web UI is a Svelte 5 single-page application served on `127.0.0.1:7400` by default.

### Starting the web UI

```bash
ironcurtain daemon --web-ui
```

On startup, the daemon prints an authenticated URL to stderr:

```
  Web UI: http://127.0.0.1:7400?token=<random-token>
```

Open this URL in your browser. The token parameter authenticates your session — treat it like a password: it can approve escalations and send input to agent sessions, and it ends up in the browser history. The web UI binds to 127.0.0.1 only; there is no command-line option to bind another address.

To use a different port:

```bash
ironcurtain daemon --web-ui --web-port 8080
```

Requests whose `Host` header is not `localhost`, a loopback address or the bind host at the listening port are refused (421), and a WebSocket's `Origin` must match the same rules. Responses carry a restrictive Content-Security-Policy.

### Views

| View            | Description                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**   | Overview of daemon status, active sessions, workflows and recent job runs.                                                                                                                                                                                                                          |
| **Sessions**    | Interactive container terminal sessions (the same agent PTY the mux runs), with a trusted-message bar whose text authorizes auto-approval like mux command mode; a terminal reattaches after a reconnect. Other session kinds are not supported in the browser. At most 5 web sessions run at once. |
| **Escalations** | Pending escalations across all sessions (cron and Signal sessions included), with full arguments. Approve or deny from the browser; escalations that share a whitelist pattern can be reviewed and approved as a group.                                                                             |
| **Jobs**        | Job definitions, schedules and run history; run a job, enable, disable or remove it.                                                                                                                                                                                                                |
| **Workflows**   | Start, follow and resume workflow runs (see [WORKFLOWS.md](WORKFLOWS.md#web-ui)).                                                                                                                                                                                                                   |
| **Personas**    | Browse personas and their constitutions / compiled policies. Read-only by default; create / edit / compile / delete controls appear only when the daemon is started with `--allow-policy-mutation` (see below).                                                                                     |
| **Statistics**  | LLM usage, speed and cost from the local statistics database, grouped by model, persona or workflow.                                                                                                                                                                                                |
| **Settings**    | Resource limits, LLM statistics, model providers and nested Docker. Read-only unless the daemon is started with `--allow-policy-mutation`; changes are written to `config.json` and are not recorded in the policy-mutation log.                                                                    |

**Escalation dialog.** When an escalation arrives, the dialog opens without taking keyboard focus, so typing into a terminal never decides it. Approve, Deny and the whitelist choices are enabled 750 ms after the escalation is shown (the delay restarts on a tab switch or when the next escalation replaces a resolved one). Keyboard shortcuts work only after you click into the dialog (or tab to it): **Ctrl/Cmd+Enter** approves and **Ctrl/Cmd+Backspace** denies. Escape dismisses the dialog without deciding. To approve and whitelist, choose a whitelist entry, then Approve. An approval that arrives after the escalation timed out is reported as expired (`ESCALATION_EXPIRED`).

**Workflow gate approval.** Approve requires the exact review to remain visible, focused and in place for 750 ms. Review changes, surrounding card/error changes, layout movement and focus/visibility interruptions restart the delay. A press begun before arming cannot approve after it. Abort and revision/replan retain their existing confirmation or feedback flows.

**Agent output.** Markdown written by agents (workflow artifacts at gates, messages, persona constitutions, workflow READMEs) is rendered strictly: raw HTML shows as text, images show as `[image: alt] url`, and only `http`, `https` and `mailto` links are clickable (they open in a new tab).

**Large replies.** A reply larger than 8 MiB, or one that would push a connection's send buffer past 8 MiB, becomes a `RESPONSE_TOO_LARGE` error and the connection stays open. Workflow artifacts and files are listed with their sizes and loaded one at a time.

### Persona policy management

By default the Personas view is **read-only** — you can browse personas, their constitutions, and compiled-policy status, but the mutation controls are hidden. Because a persona's policy _is_ its security boundary, editing it from the browser is a privilege-escalation surface, so it is gated behind an explicit, off-by-default kill switch:

```bash
ironcurtain daemon --web-ui --allow-policy-mutation
```

With the flag on, the Personas view gains:

- **Create** a persona (name, description, optional server allowlist picked from the configured servers, the built-in ones and those in `~/.ironcurtain/mcp-servers.json`, memory opt-in, optional constitution).
- **Edit constitution** in-browser; saving flags the compiled policy as **stale** until you recompile.
- **Compile** (or recompile) with live per-phase progress streamed over the WebSocket, plus a rule-count diff (`ruleDelta`) on completion. A compile that left servers out is shown as "Compiled with failures" with each failed server (its tools are denied until a recompile succeeds); one the policy lint refused (`POLICY_LINT_FAILED`, nothing written) shows the lint's findings.
- **Toggle persistent memory** and the **broad-policy opt-in** (the opt-in is required to compile a policy that grants broad access — e.g. `*` / `*.com` domains, or allow rules that leave paths or URLs unconstrained; without it such policies are rejected). Turning the opt-in off moves a compiled policy that needed it aside, so the persona shows as not compiled until it is recompiled; the toggle is refused while the persona is compiling.
- **Delete** (soft delete: the persona directory moves to `~/.ironcurtain/.persona-trash/`, where it is kept for `personas.trashRetentionDays` and can be restored with `ironcurtain persona trash restore <name>`).

Safeguards (all enforced server-side, regardless of the browser):

- The flag is **CLI-only and not persisted** to `config.json`, so the mutation surface cannot be silently enabled by editing config — the operator must deliberately pass it at launch. When off, every mutation request (Settings changes included) is rejected with `POLICY_MUTATION_FORBIDDEN`.
- Every persona mutation is recorded in `~/.ironcurtain/audit/policy-mutation.jsonl`, a hash chain with a persisted head that `ironcurtain audit verify` checks. The chain detects edits, removals, reordering and truncation by anyone who does not rebuild the whole chain and its head; a process running as your user can rebuild both, so it is evidence, not tamper-proofing. Once the log has rotated (at about 10 MB, keeping `policy-mutation.jsonl.1` to `.3`), removing its oldest records can look like rotation and go unreported. Recording is best effort: a record that cannot be written (the log lock stays busy, an I/O error) is skipped silently and never blocks the mutation, so the log can miss a mutation.
- **Tool annotations are never editable from the web UI** — generating them (`ironcurtain annotate-tools`) is CLI-only; compilation only ever reads `tool-annotations.json`.
- v1 targets a **single-operator localhost** daemon; the kill switch is the authorization gate (there is no separate admin credential). Do not expose the daemon beyond localhost.

### Authentication

The web UI uses a bearer token generated randomly on each daemon start. The token is passed as a `?token=` query parameter in the URL printed to stderr. WebSocket connections are authenticated on upgrade using the same token. While the daemon runs, it writes the port and token to `~/.ironcurtain/web-ui.json`, which is how CLI clients such as `ironcurtain observe` and the agent-driven `ironcurtain workflow` commands connect (see [WORKFLOWS.md](WORKFLOWS.md#driving-workflows-from-an-agent-daemon-backed)).

### Development workflow

For frontend development with hot reload, run the daemon with the `--web-ui-dev` flag and the Vite dev server side by side:

```bash
# Terminal 1 — daemon that also accepts the Vite dev server origin
ironcurtain daemon --web-ui --web-ui-dev

# Terminal 2 — Vite dev server with hot module replacement
cd packages/web-ui && npm run dev
```

The daemon prints a second URL for the dev server (`http://localhost:5173?token=...`). The Vite dev server proxies WebSocket connections to the daemon, so the frontend connects to the real backend while Vite handles hot reload. `--web-ui-dev` adds only the Vite dev server origins (`http://localhost:<port>` and `http://127.0.0.1:<port>`, where the port is `IRONCURTAIN_WEB_UI_PORT`, default 5173) to the Origin allowlist; Host and Origin are still validated.

### Mock server (no Docker or LLM needed)

For UI development and testing without starting Docker containers or using LLM API keys, use the mock WebSocket server:

```bash
# Terminal 1 — mock server simulating the daemon's JSON-RPC protocol
cd packages/web-ui && npm run mock-server

# Terminal 2 — Vite dev server with hot module replacement
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=mock-dev-token` in your browser. The mock server provides:

- **Session simulation** — sessions produce realistic event sequences (thinking, tool calls, markdown responses)
- **Escalation testing** — send a message containing the word "escalate" to trigger an escalation in the Escalations view
- **Job management** — pre-populated jobs with working enable/disable/remove actions
- **Persona selection** — pre-populated personas in the session creation picker

This is the recommended workflow for iterating on the frontend without incurring LLM costs.

### Unit tests

The web UI has unit tests covering stores, views, the escalation dialog, markdown rendering and the WebSocket client:

```bash
npm test -w packages/web-ui
```

These tests run automatically as part of the root `npm test` suite.

## Troubleshooting

| Issue                                                                            | Guidance                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job not running on schedule**                                                  | Check `list-jobs`: the job must be enabled and must not show `NO POLICY`, `POLICY STALE`, `NOT SCHEDULED` or `INVALID`. Verify the cron expression. The daemon must be running — jobs don't run without it.                                                                                                                                                                                                                               |
| **`NO POLICY` / `POLICY STALE`**                                                 | Run `ironcurtain daemon recompile-job <id>` (and `enable-job <id>` if the job was saved disabled). For a persona job, recompile the persona: `ironcurtain persona compile <name>`. A persona job also shows `NO POLICY` when the persona's policy grants broad access without its opt-in: narrow the constitution and recompile, or opt in with `ironcurtain persona compile <name> --allow-broad`.                                       |
| **Policy compilation fails**                                                     | Run `ironcurtain daemon recompile-job <id>` to see errors. Ensure the `taskConstitution` is well-formed English and does not ask for broad domain access, which job policies cannot opt in to.                                                                                                                                                                                                                                            |
| **Git sync fails or times out**                                                  | Verify the `gitRepo` URI uses a supported protocol. SSH keys must work without a prompt (ssh-agent or a deploy key without a passphrase) and the host key must be in `known_hosts`; HTTPS needs a non-interactive credential helper. Check network connectivity. The run record shows the error (`Git sync failed: ...` or `Git sync timed out: ...`).                                                                                    |
| **"Workspace ... is in use by a workflow or cron job running in ..."**           | Another job with the same `workspace`, or a workflow run in it, was still running, so this run was refused before it synced. Give the jobs different schedules or workspaces. A workflow holds its workspace while it runs, including while it waits at a gate.                                                                                                                                                                           |
| **"workspace ... is not empty and was not populated by IronCurtain's git sync"** | A custom `workspace` must be empty the first time the job's repository is synced into it. Empty it once (or point `workspace` at a new directory).                                                                                                                                                                                                                                                                                        |
| **Escalations always denied**                                                    | Without Signal, an escalation waits only when a browser has the web UI open (`--web-ui`) as it arrives; otherwise it is denied at once. With Signal, set `notifyOnEscalation: true` on the job (without it, escalations are denied even while the web UI is open), and check that signal-cli is reachable: a banner that cannot be delivered denies the escalation. Approve over Signal with the code from the banner (`approve <code>`). |
| **Daemon won't start ("already running")**                                       | Another process holds `~/.ironcurtain/daemon.lock`; the message names its pid. It may be another daemon, or a job command that runs locally while no daemon does (such as `daemon run-job` or `recompile-job`). A dead process's lock is reclaimed automatically.                                                                                                                                                                         |
| **"Signal transport not started: Process N holds the IronCurtain Signal lock"**  | An `ironcurtain bot` runs the Signal transport for this home. Only one process may use the signal-cli container and its messages, so the daemon runs without Signal (scheduled jobs and the web UI still work). Stop the bot and restart the daemon, or keep the bot and start the daemon with `--no-signal`.                                                                                                                             |
| **Daemon won't start (home not owned)**                                          | The daemon refuses an IronCurtain home that is not owned by the current user. Run it as the user that owns `~/.ironcurtain` (or `$IRONCURTAIN_HOME`).                                                                                                                                                                                                                                                                                     |
| **Run record shows `budget_exhausted`**                                          | The job hit a resource limit. Increase the relevant budget in `budgetOverrides` (or the persona's limits) or set the field to `null` to disable the limit.                                                                                                                                                                                                                                                                                |
| **`last-run.md` missing**                                                        | This file is created by the agent, not the daemon. If the agent didn't write it, check the task description — the agent is prompted to use this file but may skip it if the task completes very quickly or errors out early. The previous run's file is `previous-run.md`.                                                                                                                                                                |
| **Changes from previous run discarded**                                          | This is expected behavior with `gitRepo` configured. Tracked files are hard-reset to the remote's default branch and the workspace `.git` is rebuilt before each run. Untracked files are kept, except that the previous run's `last-run.md` is renamed `previous-run.md`.                                                                                                                                                                |
| **Web UI not loading**                                                           | Ensure `--web-ui` was passed when starting the daemon. Check that the port (default 7400) is not in use. The URL with token is printed to stderr on startup — copy it exactly, as the token is required for authentication. Open it as `127.0.0.1` or `localhost`: another host name gets 421.                                                                                                                                            |
