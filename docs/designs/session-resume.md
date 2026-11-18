# Design: Session Resume for Docker PTY Sessions

**Status (2026-11-14):** Implemented: Docker PTY sessions keep the agent's conversation state on the host and resume from the mux or with `ironcurtain start --resume` (`src/docker/conversation-state.ts`, `src/docker/pty-session.ts`) for Claude Code, Goose and Codex; old sessions age out under `ironcurtain prune`. Every standalone session, builtin, batch container or PTY, holds its session's resume lock while it runs, and a resume whose session metadata cannot be read is refused (section 7).

**Date:** 2026-03-07

## 1. Problem Statement

When a Docker PTY session ends — whether from an OAuth token expiry, a crash, user disconnect, or intentional exit — there is no way to resume it. The user must start a fresh session, losing all conversation context. This is particularly painful for long-running sessions where significant work has been done.

Two independent problems prevent session resume:

1. **Agent conversation state is lost.** Agents store conversation history inside the container (e.g., Claude Code in `~/.claude/projects/`, Codex in `~/.codex/sessions/`, Goose in `~/.local/share/goose/sessions/`). These directories are not mounted from the host, so when the container exits, conversation data is destroyed.

2. **Mux has no resume capability.** The terminal multiplexer can only spawn new sessions. There is no way to resume a previously ended session, even though the session directory (sandbox, audit log, interaction logs) persists on disk.

## 2. Current Architecture

### What persists after a session ends

| Artifact                 | Location                                              | Survives exit?           |
| ------------------------ | ----------------------------------------------------- | ------------------------ |
| Workspace files          | `~/.ironcurtain/sessions/{id}/sandbox/`               | Yes                      |
| Audit log                | `~/.ironcurtain/sessions/{id}/audit.jsonl`            | Yes                      |
| LLM interactions         | `~/.ironcurtain/sessions/{id}/llm-interactions.jsonl` | Yes                      |
| Session log              | `~/.ironcurtain/sessions/{id}/session.log`            | Yes                      |
| Builtin conversation     | `~/.ironcurtain/sessions/{id}/messages.jsonl`         | Yes (builtin only, §7)   |
| Session lock             | `~/.ironcurtain/sessions/{id}/resume.lock`            | Released on close (§7)   |
| Agent conversation state | In-container paths (agent-specific)                   | **No**                   |
| PTY registration         | `~/.ironcurtain/pty-registry/session-{id}.json`       | **No** (deleted on exit) |
| Proxy sockets            | `~/.ironcurtain/sessions/{id}/sockets/`               | **No** (cleaned up)      |

### Existing resume support

`ironcurtain start --resume <sessionId>` exists but only reuses the session directory. It spawns a fresh container — the agent inside starts with no conversation memory. (Builtin Code Mode sessions now restore their conversation; see §7.)

### Container volume mounts (current)

```
Host                                    Container
{sessionDir}/sandbox        →    /workspace           (rw)
{sessionDir}/sockets        →    /run/ironcurtain     (rw, Linux)
{sessionDir}/orientation    →    /etc/ironcurtain     (ro)
```

## 3. Proposed Design

The design separates **generic session infrastructure** (snapshots, mux resume, `--resume` flag) from **agent-specific conversation persistence** (state directories, resume flags). The existing `AgentAdapter` interface (`src/docker/agent-adapter.ts`) is extended with optional resume hooks.

### 3.1 Agent adapter resume interface

Extend `AgentAdapter` with optional methods that each adapter implements if the agent supports session resume:

```typescript
interface AgentAdapter {
  // ... existing methods ...

  /**
   * Returns the conversation state configuration for this agent.
   * If undefined, the agent does not support conversation persistence
   * and sessions will not be marked as resumable.
   */
  getConversationStateConfig?(): ConversationStateConfig;
}

interface ConversationStateConfig {
  /** Host-side subdirectory name within sessionDir (e.g., 'claude-state'). */
  hostDirName: string;

  /** Container-side mount target (e.g., '/root/.claude/'). */
  containerMountPath: string;

  /**
   * Files/directories to pre-populate on first session start.
   * Paths are relative to the host-side directory.
   */
  seed: Array<{
    path: string;
    content: string | (() => string | undefined);
  }>;

  /**
   * CLI flag(s) the agent uses to continue a previous conversation.
   * Passed to the PTY start script on resume (IRONCURTAIN_RESUME_FLAGS,
   * e.g. ['--continue']). Empty when the script resumes by id instead.
   */
  resumeFlags: string[];

  /**
   * Where the CLI keeps transcripts in this directory:
   * 'claude-projects' | 'codex-rollouts' | 'goose-sessions'.
   */
  transcriptLayout: ConversationTranscriptLayout;
}
```

This keeps agent-specific details out of the generic infrastructure. `pty-session.ts` and `docker-infrastructure.ts` call the adapter method and act on the returned config without knowing agent internals. The probes that read a layout's transcripts, and the PTY start-script environment for a resume, live in `src/docker/conversation-state.ts`.

### 3.2 Agent-specific conversation persistence

#### Claude Code

```typescript
getConversationStateConfig(): ConversationStateConfig {
  return {
    hostDirName: 'claude-state',
    containerMountPath: '/home/codespace/.claude/',
    seed: [
      { path: 'projects/', content: '' },  // directory, populated by Claude Code
    ],
    resumeFlags: ['--continue'],
    transcriptLayout: 'claude-projects',
  };
}
```

**Explicitly excluded** from the mounted directory (never copied):

- `.credentials.json` — OAuth tokens (MITM proxy handles auth)
- `session-env/` — may contain env snapshots with secrets
- `statsig/`, `stats-cache.json` — analytics, unnecessary

**Runtime cleanup:** On each container start, the generic infrastructure deletes `.credentials.json` from the state directory if it exists. Since auth is handled entirely by the MITM proxy via environment variables, any credentials file created by the agent at runtime is stale/invalid and must not persist across resumes.

**Workspace path stability:** Claude Code keys conversations by the project working directory path. Since the container always mounts the workspace at `/workspace`, the conversation key is stable across container restarts for the same session. `--continue` will find the previous conversation.

#### Codex

```typescript
getConversationStateConfig(): ConversationStateConfig {
  return {
    hostDirName: 'codex-state',
    containerMountPath: '/home/codespace/.codex/',
    seed: [
      { path: 'sessions/', content: '' },
      { path: 'logs/', content: '' },
    ],
    resumeFlags: [], // resume goes by thread id
    transcriptLayout: 'codex-rollouts',
  };
}
```

Codex mints its own thread id and keeps one rollout per thread at `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`. A PTY resume continues the thread of the most recently modified rollout of the session's own state directory: the host passes it as `IRONCURTAIN_RESUME_ID` (a validated UUID), and `start-codex.sh` runs `codex resume <id>`, falling back to a fresh start if that fails. Never `--last`. Batch mode records the thread per conversation instead (see §3.6).

#### Goose

```typescript
getConversationStateConfig(): ConversationStateConfig {
  return {
    hostDirName: 'goose-state',
    containerMountPath: '/home/codespace/.local/share/goose/sessions/',
    seed: [],
    resumeFlags: ['--resume'],
    transcriptLayout: 'goose-sessions',
  };
}
```

The pinned Goose release keeps its sessions in a SQLite store (`sessions.db`) in its XDG data directory, so the mount target is that directory, not `~/.config/goose/` (which holds `config.yaml` and the skills mount). The image pre-creates it as `codespace`, so the bind mount does not leave a root-owned `~/.local/share/goose` behind. PTY mode names the session after the IronCurtain session id (`IRONCURTAIN_SESSION_NAME`): a fresh start runs `goose run -s --name <id> -i <prompt file>`, and a resume runs `goose session --name <id> --resume`, falling back to a fresh start if that fails. Batch mode no longer passes `--no-session` (see §3.6).

#### Agents without resume support

If an adapter does not implement `getConversationStateConfig()` (or returns `undefined`), sessions using that agent are not marked as resumable. The generic infrastructure handles this gracefully — the `resumable` field in the session snapshot is set to `false`.

### 3.3 Session state snapshot on exit (generic)

Write a `session-state.json` to the session directory when a PTY session ends, capturing enough metadata to support resume decisions. This is agent-agnostic.

```typescript
interface SessionSnapshot {
  sessionId: string;
  status: 'completed' | 'crashed' | 'auth-failure' | 'user-exit';
  exitCode: number | null;
  lastActivity: string; // ISO timestamp
  turnCount: number;
  workspacePath: string; // host-side workspace
  agent: string; // 'claude-code', 'goose', etc.
  label: string; // tab label from mux
  resumable: boolean; // true if agent supports resume AND state dir exists
}
```

Written to: `~/.ironcurtain/sessions/{id}/session-state.json`

The exit status can be inferred from:

- OAuth refresh failure → `auth-failure`
- Container exit code 0 → `completed`
- Container exit code != 0 → `crashed`
- User-initiated close → `user-exit`

The `resumable` field is set by checking:

1. The adapter implements `getConversationStateConfig()`
2. The conversation state directory holds a real transcript of the adapter's layout (`hasStoredTranscript` in `src/docker/conversation-state.ts`): a non-empty Claude Code `projects/<cwd-hash>/*.jsonl`, a non-empty Codex `sessions/YYYY/MM/DD/rollout-*.jsonl`, or a non-empty Goose session store. "Exists and is non-empty" is not enough: the seeds (`projects/`, `sessions/`, `logs/`), `settings.json` and `CLAUDE.md` make every state directory non-empty, so sessions that never held a conversation would be listed as resumable.

### 3.4 Mux resume support (generic)

#### New mux commands

| Command               | Behavior                                                      |
| --------------------- | ------------------------------------------------------------- |
| `/resume [sessionId]` | Open a picker of resumable sessions, or resume a specific one |
| `/sessions --all`     | List both active and resumable sessions                       |

#### Resume flow

```
/resume
    ↓
Scan ~/.ironcurtain/sessions/*/session-state.json
    ↓
Filter: resumable == true, sort by lastActivity desc
    ↓
Show picker: "session-id | agent | label | last activity | status"
    ↓
User selects session
    ↓
spawnSession(sessionId, workspacePath)  ← reuses existing sessionId
    ↓
PtyBridge spawns: ironcurtain start --pty --resume <sessionId> --agent <agent>
    ↓
New container starts with same sandbox + conversation state mounts
    ↓
Agent runs with resume flags (if any), finds previous conversation
    ↓
User continues where they left off
```

#### Auto-resume on mux startup (optional)

When `ironcurtain mux` starts, it could scan for sessions that ended with `auth-failure` or `crashed` status and offer to resume them. This could be a config option (`mux.autoResumeOnStart: boolean`).

### 3.5 Changes to `ironcurtain start --pty` (generic)

When `--resume <sessionId>` is passed:

1. Validate the session directory exists
2. Validate `session-state.json` exists and `resumable == true`
3. Load the adapter for the session's agent
4. Call `adapter.getConversationStateConfig()` to get mount config
5. Reuse `{sessionDir}/sandbox/` as workspace
6. Reuse `{sessionDir}/{hostDirName}/` (contains previous conversations)
7. Create fresh `sockets/` and `orientation/`
8. Pass the resume environment to the agent's PTY start script (`buildPtyConversationEnv`): the validated `resumeFlags` (`IRONCURTAIN_RESUME_FLAGS`), the Codex thread to resume (`IRONCURTAIN_RESUME_ID`), and the Goose session name (`IRONCURTAIN_SESSION_NAME`, set on fresh starts too)
9. Start new container with all mounts
10. Append to existing `session.log` and `audit.jsonl` (not overwrite)

### 3.6 Batch-mode continuity (Codex and Goose)

Batch sessions (`DockerAgentSession`, one `docker exec` per turn) continue a conversation across turns and across sessions that reuse its agent conversation id (a workflow state re-entered with `freshSession: false`, or `ironcurtain start --resume`). Claude Code takes the id directly (`--session-id` / `--resume`). The other two CLIs need a record, which the session keeps in the host-only bundle directory (`<bundleDir>/agent-conversations/<agentConversationId>.json`, mode 0600, written atomically, read bounded and without following links; the bundle directory is never mounted):

- **Codex:** `extractResponse` reports the `thread_id` of `thread.started` (validated as a UUID). The session records it, and later turns run `codex ... exec --json ... resume -- <thread> <message>`. A later session resumes only when its record names a thread whose rollout still exists, and never the "most recent" session: workflow states that share a container share `~/.codex`.
- **Goose:** each conversation is a named session, `goose run --name <agentConversationId>`; later turns add `--resume`. The record says the named session exists (the host never opens Goose's SQLite store); a later session resumes when the record exists and the session store is non-empty.

The first turn sends the system prompt with the message. A resumed turn sends the message alone: the conversation already holds the orientation.

## 4. Security Considerations

- **No credentials in conversation state directories**: Adapters are responsible for excluding credential files from the mounted state directory. The MITM proxy's fake-key swap handles auth independently. On each container start, `.credentials.json` is deleted from the state directory as a defense-in-depth measure.
- **Session isolation**: Each session has its own conversation state directory. State from one session is not visible to another.
- **Read-write mount**: Agents need write access to their state directories to save conversations. This is the same trust level as the workspace mount.
- **Host access to the state directory**: Whatever the agent leaves in its state directory survives into the next session that mounts it (a resume, or the next workflow state on a shared bundle), including symlinks (absolute, relative or dangling), FIFOs, hard links, directories and symlink loops. The host's per-session CLAUDE.md seeding and resume probe therefore go through `src/docker/conversation-state.ts`, and any other host access must likewise never follow a link, never open a non-regular entry, and bound every read. `CLAUDE.md` is seeded only for Claude Code, by writing an exclusive temporary file in the directory and renaming it over the name, so a planted link or FIFO is replaced rather than written through or opened, and a directory there fails session start. Otherwise it is removed with `unlink`, which never follows a link. The resume probes check exactly `projects/<cwd-hash>/<conversation-id>.jsonl` (Claude Code) or walk the fixed `sessions/YYYY/MM/DD/` levels (Codex) with non-recursive, capped directory reads and `lstat`, entering only real directories and counting only regular, non-empty files; nothing is opened and no symlink is followed. The directory itself is host-owned (its parent is not mounted), so final-component no-follow is sufficient.
- **Agent-chosen ids:** a Codex thread id comes from agent-controlled output (stdout, or a rollout file name). It is accepted only as a hyphenated UUID before it is recorded or passed to `codex ... resume`, so it can only select another conversation inside the same agent's own state, never an option or a path. Conversation records live outside the mounted directory.
- **Agent-specific exclusions**: Each adapter's `seed` list defines what gets pre-populated. Sensitive files (credentials, env snapshots) are never included.

## 5. Implementation Plan

### Phase 1: Adapter interface + Claude Code conversation persistence

1. Add `getConversationStateConfig()` to `AgentAdapter` interface
2. Implement for Claude Code adapter (seed files, exclude list, resume flags)
3. Generic logic in `docker-infrastructure.ts`: call adapter, create state dir, add mount
4. Verify `--continue` picks up previous conversations

### Phase 2: Session snapshots (generic)

1. Define `SessionSnapshot` type
2. Write snapshot on PTY session exit (classify exit reason)
3. Set `resumable` based on adapter capability and state directory existence
4. Add `--resume` validation logic to session startup

### Phase 3: Mux resume (generic)

1. Add `/resume` command to `MuxInputHandler`
2. Add session scanner (read `session-state.json` files)
3. Add resumable session picker UI
4. Wire `spawnSession()` to pass `--resume` flag and agent ID

### Phase 4: Goose + future agents

1. Implemented: `getConversationStateConfig()` for the Goose adapter, named sessions instead of `--no-session`, and Codex thread resume (§3.2, §3.6)
2. A new adapter declares its `transcriptLayout`, with a probe in `src/docker/conversation-state.ts`

### Phase 5: Polish (optional)

1. Auto-resume prompt on mux startup
2. Session age-out / cleanup for old state directories: implemented as `ironcurtain prune` (see [retention-and-prune.md](retention-and-prune.md)). A session directory inactive for `retention.sessions.maxAgeDays` (30 by default) is removed with its sandbox, logs and conversation state, unless it is live (the daemon runs it, a live PTY registration names it, a live process holds its `resume.lock`, or an owner lease says its containers may remain), holds a workspace a kept session, run or cron job uses, or belongs to a kept workflow run. Only on request, or by the daemon with `retention.autoPrune`.
3. `/sessions --all` command showing resumable sessions

## 6. Open Questions

1. **Session expiry**: resolved by retention: a session stays resumable until `ironcurtain prune` removes it, by default once it has been inactive for 30 days (`retention.sessions.maxAgeDays`; null keeps sessions forever). Nothing is removed automatically unless `retention.autoPrune` is set.
2. **Multiple resumes**: Should a session be resumable more than once? (Probably yes — the snapshot just gets overwritten each time.)
3. **Cross-agent resume**: If a session was started with `claude-code`, can it be resumed with `goose`? (No — conversation format is agent-specific. The `agent` field in the snapshot enforces this.)
4. **Mux tab restoration**: Should mux save/restore its full tab layout on restart, not just individual sessions?
5. **Goose session continuity**: resolved with named sessions keyed on the agent conversation id (batch) or the IronCurtain session id (PTY), stored in the mounted session store (§3.2, §3.6).

## 7. Builtin (Code Mode) session resume

**Status:** Implemented. The builtin agent keeps its conversation in-process (AI SDK `ModelMessage[]`), so resume is IronCurtain's job rather than an agent CLI's.

- **One identity.** `createBuiltinSession()` gives `AgentSession` the resumed session ID instead of minting a new one, so the directory tree, `interactions.jsonl` (written under `getInfo().id`), the saved conversation and the lock all stay in `sessions/{id}/`, and a resumed session can be resumed again. (Docker sessions still mint a new runtime ID on resume; the container, bundle and token-stream IDs depend on it.)
- **Saved conversation.** After every user turn that is recorded, `AgentSession` atomically rewrites `sessions/{id}/messages.jsonl` (`src/session/conversation-store.ts`): a header line (`format`, `version`, `savedAt`, `messageCount`, `lastInputTokens`, and after a compaction `summary`) followed by one AI SDK message per line. The messages are exactly what the next turn sends, so after compaction the file starts with the `<ironcurtain_conversation_summary>` message, and tool results trimmed within a turn are stored as their trimmed stubs. `summary` is the compactor's record of that summary message when the session wrote it: the user's messages it keeps verbatim, how many older ones it left to the notes, and the summarizer's notes (`CompactionSummaryState` in `src/session/message-compactor.ts`). It is optional, so the format version stays 1 and older readers ignore it. `lastInputTokens` is the compactor's trigger, the estimated size of the next request (the last step's input and output plus the tool results it appended), so the resumed session compacts before its first turn, and trims before its first step, exactly when the original would have. System turns (the memory auto-save prompt at session end, workflow prompts) are not saved. A failed turn (a provider error, the wall-clock budget aborting a model call, or a token or cost budget that the auto-compaction summary used up before the first step) in which no step finished is rolled back out of the history and not saved; one that failed after some of its steps finished keeps those steps and an `<ironcurtain_note>` saying the turn stopped early, and is saved, because their tool calls have already run. A turn that a resource budget or the step cap ended while the model was still calling tools is saved like any other, although a budget stop then reports `BudgetExhaustedError`: its steps stay in the history for the same reason. The file holds the whole conversation, so it is written mode 0600 through a temporary file renamed over the name (never through a link) and read through one no-follow descriptor.
- **Restore.** `--resume` loads the file and the session continues from it. A missing file (a session created before this, or one that never finished a user turn) resumes with an empty history. A file that does not validate completely (symlink, group/world-writable, malformed line, unknown format version, a message count that does not match, a system message, or any message the AI SDK's `modelMessageSchema` rejects) refuses the resume with the path and the reason, rather than continuing with silently missing context; moving the file aside resumes with the workspace only; a malformed `summary` record is refused the same way. A well-formed `summary` record is handed to the compactor (`MessageCompactor.restoreSummary()`), which takes the restored summary back as its own only when the record rebuilds that message exactly. The next compaction then carries the summary forward as the original session would have: the user's earlier messages stay verbatim in the new summary and only the notes are summarized again. Without a record (a file saved before it existed), or with one that does not rebuild the message, the compactor treats the restored summary like any summary it did not write: all of it, the user's verbatim messages included, is summarized again as earlier notes.
- **One running process per session.** The process running a standalone session holds `sessions/{id}/resume.lock` (`src/session/session-lock.ts`, the crash-recoverable process lock) from creation or resume until the session has closed, whatever kind it is: a builtin session until `close()`; a batch container session until `close()` has torn its bundle down (a resumed one claims the original directory before its session configuration touches it, although it runs under a new runtime ID); a PTY session until its teardown and snapshot are done (`runPtySession`, which holds a fresh session's claim as it holds a resume's). A second `--resume` of the same session, or a `--resume` of a session that is still running, is refused (`already in use by a running session`) instead of sharing the sandbox, the escalation directory, `user-context.json` and the agent's conversation state, whichever kinds the two sessions are; so is a resume of an ID that has no session directory. A lock left by a process that died is reclaimed, and `ironcurtain prune` keeps a session whose lock a live process holds. A turn still running when `close()` releases the lock no longer saves the conversation. A session on a borrowed workflow bundle works in the orchestrator's directories and takes no lock.
- **Metadata.** `session-metadata.json` is written once when the session is created, complete or not at all (flushed under a temporary name and hard-linked to its name, which never replaces a file already there), and on resume restores the persona, workspace, provider profile, policy directory, task scope, `disableAutoApprove` and agent conversation id. A missing file is a session created before metadata was recorded, which resumes as before. A file that exists but cannot be used (not a regular file, unreadable, not valid JSON, not an object, or a restored field of the wrong type) refuses the resume (`loadResumeSessionMetadata()`, for builtin, batch container and PTY resumes alike) instead of resuming the session under the global policy, the default sandbox and the auto-approver, wider than it ran; the error names the file, which can be fixed or moved aside to resume without what it records.
- **Agent.** `session-metadata.json` records the agent a session was created with (`agent`: `builtin` or the container agent ID). `ironcurtain start --resume <id>` without `--agent` resumes with that agent, so a builtin session resumes as builtin even when the configured default is container mode. The session factory refuses a resume across the builtin/container boundary (`findResumeAgentConflict()`), whichever `--agent` was given: a container resume of a builtin session would skip its conversation, and a builtin resume of a container session would run without that session's conversation. Switching between container agents is not checked. Sessions that recorded no agent resume as before.
- **Persona.** On resume the persona comes from `session-metadata.json`; the CLI's memory auto-save decision uses the same value (`resolveSessionPersona()`), so a resumed persona session saves memory in its own scope.
- **Session ID on start.** The CLI prints the session ID (and the `--resume` command) when the session is ready.
