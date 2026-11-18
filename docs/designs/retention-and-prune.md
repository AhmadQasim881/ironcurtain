# Retention and `ironcurtain prune`

**Status (2026-11-14):** Implemented (`src/maintenance/`, `ironcurtain prune`).

## 1. Problem

Every session, cron run and workflow run leaves a directory in the IronCurtain home, and nothing removed them: `sessions/<id>/` (sandbox, audit log, session and LLM logs, conversation state, trajectory captures), `workflow-runs/<id>/` (checkpoint, message log, default workspace, bundle logs, per-run dependency layers), one cron run record per run under `jobs/<id>/runs/`, one shared workflow dependency base per agent build and manifest under `workflow-dependency-bases/`, and an ever-growing `logs/daemon.log`. A long-lived daemon with cron jobs and workflows fills the disk, and listings (the mux resume picker, `jobs.list`) slow down with it.

## 2. Configuration

`retention` in `~/.ironcurtain/config.json`; every limit takes `null` for "keep forever". The block is not backfilled into the file.

| Setting                           | Default    | Meaning                                                                           |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `sessions.maxAgeDays`             | 30         | Remove a session directory inactive for longer.                                   |
| `sessions.maxBytes`               | null       | Then remove the oldest sessions while all of them take more.                      |
| `workflowRuns.maxAgeDays`         | 30         | Remove a workflow run directory inactive for longer.                              |
| `workflowRuns.maxBytes`           | null       | Then remove the oldest finished runs while all runs take more.                    |
| `jobRuns.maxRecords`              | 200        | Run records kept per cron job (the newest).                                       |
| `dependencyCaches.maxUnusedDays`  | 14         | Remove a shared dependency base no run used for longer.                           |
| `logs.maxBytes` / `logs.maxFiles` | 10 MiB / 3 | Size rotation of `daemon.log` and `signal-bot.log`; `maxBytes: null` disables it. |
| `autoPrune`                       | false      | The daemon prunes 60 s after start and every `autoPruneIntervalHours` (24).       |

Owner decision: `ironcurtain prune` applies these defaults when run; automatic pruning is opt-in. Log rotation is on by default (it only bounds the daemon's own log). `ironcurtain doctor` reports disk usage per category, what a prune would free, and a warning when the filesystem of the home is low on space.

## 3. What is judged, and how

"Inactive" is the newest modification time of a directory's direct entries (logs, checkpoint, state files), lock files excluded; the directory's own time when it is empty. A time more than a day in the future is not activity: an agent can set the times of its own workspace (a direct entry of its session or run directory, bind-mounted read-write), and would otherwise keep that directory forever. A dependency base's last use is its `last-used.json` marker, written under the provisioning lock by every run that seeds from it (the files' times for a base from before the marker).

Only entries directly under `sessions/`, `workflow-runs/` and `workflow-dependency-bases/` are touched, and only real directories named like what those directories hold (a session id, a workflow id, a 24-hex key); a symlink is never followed or removed. A workspace a session or run was given with `--workspace` lives elsewhere and is never touched. Run records are only files named like a record's start timestamp, never the newest `maxRecords`, never `latest.json` or the record it names.

Nothing active within the last day is removed, whatever the limits: neither a size cap nor an age limit below a day reaches a session that is still starting (an image build can run before anything else holds it) or a base that was just used. The size caps never remove a workflow run that can still be resumed (no final status, failed, aborted, or a checkpoint that cannot be read): those runs expire by age only ("recent resumable runs are kept").

## 4. What is never removed

Each of these is reported as kept, with the reason, when it is past its limit:

- **Live sessions.** One the calling daemon runs (its web, Signal and cron sessions and the workflow agent sessions it tracks, passed as `liveSessionIds`); one whose PTY registration (`pty-registry/session-<id>.json`) names a live process, or cannot be read; one whose `resume.lock` a live process holds (every standalone session holds it while it runs: builtin, batch container and PTY sessions, fresh or resumed).
- **Live workflow runs.** One the calling daemon runs, or whose `run.lock` a live process holds (held by every orchestrator from start or resume until the run is terminal, also while it waits at a gate).
- **Container resources.** A session (bundle id = session id) or a run (bundle ids under `containers/`) named by any owner lease record in `run/docker-owners/`, active or released: its containers may still exist and mount its directories. Records disappear after a clean teardown, `ironcurtain gc --force`, or when their owner process exits (a container left behind then carries a dead owner's labels, which `ironcurtain gc` reclaims). A record that cannot be read names no bundle, so while one exists no session or run is pruned at all (a record still being written counts too; the next prune judges again).
- **Workspaces in use.** A session or run directory that holds the workspace a kept session records (`session-metadata.json`, `session-state.json`), a kept run records (`checkpoint.json`), or a cron job uses (`job.json`, read leniently). Paths are compared as written and canonically (through symlinks); the check repeats until stable, since a kept entry may use a workspace inside another.
- **Workflow sessions.** A session whose metadata names a workflow run that is kept (its audit log belongs to the run).
- **Dependency bases in use.** One a layer of a kept run was seeded from (`<run>/deps/<key>`), or whose provisioning lock is held.
- **Anything that cannot be inspected.** When the owner leases (or any one of their records), the PTY registry or the cron jobs directory cannot be read, no session or run (and so no dependency base) is judged. Sessions and runs are judged together or not at all: each may work in the other's directory (and a run's states are sessions), so when `sessions/` or `workflow-runs/` cannot be listed, neither is pruned.

## 5. Removal

One prune at a time: a real prune holds `prune.lock`; a second gets `PRUNE_BUSY` (the CLI exits 1, the daemon skips that round). A dry run reads only: no lock, no write.

A session or run directory is removed by taking its own lock exactly as a resume would (`resume.lock`, `run.lock`; a live owner keeps the directory), renaming it to `.ironcurtain-pruned-<id>-<random>` beside it, and deleting that tombstone (read-only directories are made writable through no-follow descriptors first). A resume that comes later finds no directory, and no scan takes a dot-named tombstone for a session or run (`discoverWorkflowRuns` lists only safe workflow ids). A tombstone left by a crash is deleted by the next prune.

Sessions and runs are removed in an order where whatever would keep an entry is handled first: its workflow run before a session, and every selected entry using a workspace inside a directory before that directory (otherwise runs first, oldest first). An entry that stays at removal time after all, because a resume took its lock after the prune planned or it could not be removed, keeps what depends on it, as a kept entry does during planning: the session holding the workspace of a run resumed meanwhile stays with it. Bases go last, and a base a staying run was seeded from stays.

A dependency base is removed under its provisioning lock (non-blocking): the marker is read again, the provisioned records are deleted first (a crash midway leaves a base that is rebuilt, never one trusted half-deleted), then the key directory is moved aside and deleted. A run that waited for the lock re-creates the key directory once it holds it (`ensureWorkflowDependencyLayers`) and rebuilds the base.

Snapshot images of a removed run become orphans, which the snapshot sweep reclaims.

## 6. Job run records

`runs/latest.json` (`{ version: 1, file, consecutiveFailures }`) is written after each record. `list-jobs`, `jobs.list` and `daemon status` read it and the record it names instead of listing the directory; the failure streak is carried forward, so pruning never shortens it. A missing or unusable pointer, or one naming a record that is gone, falls back to listing (newest first by plain string order). A record saved out of order (the clock went back) recounts from the files.

## 7. Daemon log rotation

A logger claim may rotate its own file by size (`LoggerOptions.rotation`). The decision is taken per claim on the path that claim writes, just before a line is appended, so it follows the active file however claims stack: the daemon's and the Signal bot's process-wide logs rotate, a session's log does not. The size is tracked in memory and read again before a rotation, so a file another writer already rotated is not rotated twice; a failed rotation never costs the line.

## 8. Limits

- The legacy `workflow-deps/` caches of earlier versions are only reported: a process of such a version may still mount them read-write into an agent container.
- A session or run that starts after the prune planned and uses a workspace inside a directory selected for removal (a new `--workspace` pointing into an idle session's sandbox) is not seen by that prune.
- An owner that exits removes its lease records even when a container of it survived a failed teardown. Every container session start reconciles such containers away, but until then nothing protects the directories that container mounts, and tree removal is path-based (Node has no `openat`), so a process still writing into a tree being deleted could redirect the deletion. The same holds for the dependency-cache tombstones of `workflow-dependency-cache.ts`.
- Other per-host state (`task-policies/`, `run/` roots of crashed bundles, workflow workspace locks) is outside retention.
