# Design: Daemon Web UI

**Status (2026-11-14):** Implemented (PRs #154, #157, #159; extended since): `ironcurtain daemon --web-ui` (`src/web-ui/`, `packages/web-ui/`). Corrected 2026-11-14: the server always binds 127.0.0.1 (there is no `--web-host` flag), it caps concurrent connections but has no session-creation rate limit, and there are no `daemon.webUi` config keys; the flags are `--web-ui`, `--web-port` and `--web-ui-dev`. The streaming chat view of sessions this design describes was replaced by the live terminal of `webui-pty-terminal.md` for container sessions and removed for builtin ones (deferred, WP-125).

**Date:** 2026-04-04 (drafted), 2026-04-08 (consolidated)
**Author:** IronCurtain Engineering

---

## 1. Problem Statement

IronCurtain's daemon mode supports CLI (Unix domain socket) and Signal (WebSocket to signal-cli-rest-api) interaction surfaces. Both are limited:

- **CLI** is request-response only. No live streaming, no concurrent visibility into multiple sessions.
- **Signal** is linear and text-only. Escalation context is compressed to plain text. Multi-session management with `#N` prefixes is awkward.

The web UI provides:

1. **Live streaming** of session output with markdown rendering and syntax highlighting.
2. **Escalation dashboard** with full tool call context and one-click approval, plus a modal overlay for non-disruptive resolution.
3. **Job management** with proper forms instead of CLI prompts.
4. **Budget monitoring** with real-time gauges.
5. **Workflow visualization** with state machine graphs, file browsers, and artifact inspection.

### Non-goals

- Remote access over the internet. This is a local development tool.
- Replacing the CLI or Signal transports. All three coexist.
- Mobile-optimized design. Desktop browser is the primary target.

## 2. Design Overview

The web UI is a **bundled static asset** served directly by the daemon process. The Svelte 5 SPA is built at dev/release time in `packages/web-ui/`, compiled output is copied to `dist/web-ui-static/` during `npm run build`, and the daemon serves static files and handles WebSocket upgrades using Node's `http.createServer()`.

```
                        IronCurtainDaemon
                              |
               +--------------+--------------+
               |              |              |
        ControlSocket    SignalBotDaemon    WebUiServer
        (UDS, JSON)      (WS client)       (HTTP + WS server)
               |              |              |
               v              v              v
            CLI tools    signal-cli       Browser SPA
                         container        (static files + WS)
```

The browser communicates with the daemon over a single WebSocket using a JSON-RPC frame protocol. All requests (status queries, job CRUD, session messaging, escalation resolution, workflow operations) and all pushed events flow over this one connection.

This architecture provides:

- **Zero frontend runtime dependencies** in the published npm package. Only compiled static output ships.
- **No Docker requirement** for the web UI.
- **Single process** -- the daemon owns the HTTP server directly.
- **Trivial deployment** -- `npm install -g ironcurtain` includes everything.

## 3. Key Design Decisions

1. **Daemon serves static assets directly (no Docker container).** The SPA compiles to plain HTML/JS/CSS. The daemon serves it directly from `dist/web-ui-static/` via native `http.createServer()` with manual MIME type mapping. Hono was considered but not used -- raw `http.createServer()` avoids the dependency and gives full control over the upgrade handler.

2. **Single WebSocket with JSON-RPC frame protocol.** All communication flows over one WebSocket using request/response/event frames. No REST routes. Simplifies authentication (one handshake) and naturally supports long-running operations.

3. **Direct session targeting (no focus management).** Unlike Signal's `currentLabel` routing, the web UI always specifies the target session label explicitly. Web sessions do not update `currentLabel` or participate in `findMostRecentSignalLabel()`.

4. **Escalation resolution consolidated into SessionManager.** `SessionManager.resolveSessionEscalation()` is the single codepath for all three transports (Signal, web, cron auto-deny), with `whitelistSelection` passthrough.

5. **Session messaging is WebSocket-only.** Messages flow as JSON-RPC requests; responses stream back as `session.output` events. The request gets an immediate ack.

6. **Bearer token auth, delivered via URL.** The daemon generates a random token per launch, prints a full URL with the token as a query parameter to stderr, and the SPA extracts and stores it in `sessionStorage`.

7. **Opt-in via `--web-ui` flag or config setting.** The web UI server is not started by default. Default port is 7400.

8. **`escalation.expired` is its own event type.** Not overloaded onto `session.ended` or `escalation.resolved`.

9. **Full escalation data stored in ManagedSession.** `pendingEscalation: EscalationDto | null` replaces the string-only `pendingEscalationId`, enabling `escalations.list` to return data to late-connecting clients and the expiry handler to emit the correct escalation ID.

10. **Per-session message queuing.** Instead of a boolean `messageInFlight` flag, each session gets a serial promise chain. Messages are processed sequentially per session but different sessions process concurrently. This eliminates TOCTOU races from multiple browser tabs.

11. **Dispatch decomposed into sub-modules.** JSON-RPC dispatch is split by domain prefix (`session-dispatch.ts`, `job-dispatch.ts`, `escalation-dispatch.ts`, `workflow-dispatch.ts`, `persona-dispatch.ts`) in `src/web-ui/dispatch/`, with a thin router in `json-rpc-dispatch.ts`.

## 4. JSON-RPC Frame Protocol

All browser-daemon communication flows over a single WebSocket at `/ws`.

### 4.1 Frame Types

```typescript
// src/web-ui/web-ui-types.ts

/** Literal union of all valid JSON-RPC method names. */
export type MethodName =
  | 'status'
  | 'jobs.list' | 'jobs.remove' | 'jobs.enable'
  | 'jobs.disable' | 'jobs.recompile' | 'jobs.refreshLists' | 'jobs.reload' | 'jobs.run' | 'jobs.logs'
  | 'sessions.list' | 'sessions.get' | 'sessions.create' | 'sessions.end'
  | 'sessions.send' | 'sessions.budget' | 'sessions.history' | 'sessions.diagnostics'
  | 'escalations.list' | 'escalations.resolve' | 'escalations.approveGroup'
  | 'personas.list' | 'personas.get' | 'personas.compile'
  | 'workflows.list' | 'workflows.get' | 'workflows.start' | 'workflows.import'
  | 'workflows.resume' | 'workflows.abort' | 'workflows.resolveGate'
  | 'workflows.inspect' | 'workflows.fileTree' | 'workflows.fileContent'
  | 'workflows.artifacts' | 'workflows.artifactFile' | 'workflows.messageLog'
  | 'workflows.messageLogEntry' | 'workflows.listDefinitions' | 'workflows.listResumable';

/** Browser -> Daemon request frame. */
export interface RequestFrame {
  readonly id: string;       // UUID, set by browser
  readonly method: MethodName;
  readonly params?: Record<string, unknown>;
}

/** Daemon -> Browser response to a specific request. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

/** Daemon -> Browser unsolicited push event. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;      // monotonically increasing counter for ordering
}

/** Error codes for ResponseFrame errors. */
export type ErrorCode =
  | 'AUTH_REQUIRED' | 'SESSION_NOT_FOUND' | 'JOB_NOT_FOUND' | 'JOB_ALREADY_RUNNING'
  | 'ESCALATION_NOT_FOUND' | 'ESCALATION_EXPIRED' | 'SESSION_BUSY'
  | 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_NOT_AT_GATE' | 'GATE_MISMATCH' | 'EVENT_NOT_ACCEPTED'
  | 'ARTIFACT_NOT_FOUND' | 'PERSONA_NOT_FOUND' | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS' | 'RATE_LIMITED' | 'RESPONSE_TOO_LARGE' | 'METHOD_NOT_FOUND' | 'INTERNAL_ERROR';
```

### 4.2 Methods

All request params are validated with Zod schemas before dispatch. Validation failures return `INVALID_PARAMS` error responses.

| Method | Params | Response payload | Notes |
|--------|--------|-----------------|-------|
| `status` | -- | `DaemonStatusDto` | |
| `jobs.list` | -- | `JobListDto[]` | |
| `jobs.remove` | `{ jobId }` | -- | |
| `jobs.enable` | `{ jobId }` | -- | |
| `jobs.disable` | `{ jobId }` | -- | |
| `jobs.recompile` | `{ jobId }` | -- | |
| `jobs.refreshLists` | `{ jobId, list?, withMcp? }` | `RefreshListsResultDto` | Re-resolves the job policy's dynamic lists (`refresh-lists --job`); refused for a job that runs under a persona, `JOB_NOT_FOUND` for an unknown job |
| `jobs.reload` | `{ jobId }` | -- | Reload job definition from disk and reschedule |
| `jobs.run` | `{ jobId }` | `{ accepted, jobId }` | Fire-and-forget; progress via events. The job is reserved before the reply: `JOB_ALREADY_RUNNING` while a scheduled, CLI or web run of it has not finished, `JOB_NOT_FOUND` for an unknown job |
| `jobs.logs` | `{ jobId, limit? }` | `RunRecord[]` | |
| `sessions.list` | -- | `SessionDto[]` | |
| `sessions.get` | `{ label }` | `SessionDetailDto` | |
| `sessions.create` | `{ persona? }` | `{ label }` | |
| `sessions.end` | `{ label }` | -- | |
| `sessions.send` | `{ label, text }` | `{ accepted }` | Ack only; output arrives as events |
| `sessions.budget` | `{ label }` | `BudgetSummaryDto` | |
| `sessions.history` | `{ label }` | `ConversationTurn[]` | |
| `sessions.diagnostics` | `{ label }` | `DiagnosticEvent[]` | |
| `escalations.list` | -- | `EscalationDto[]` | |
| `escalations.resolve` | `{ escalationId, decision, whitelistSelection? }` | -- | |
| `escalations.approveGroup` | `{ groupKey, escalationIds }` | `{ approved, failed }` | Approves each member of one whitelist-pattern group once, after the UI listed them for confirmation. Refused (`ESCALATION_GROUP_CHANGED`, nothing approved) unless the ids are exactly the group's pending members; see 10.7 |
| `personas.list` | -- | persona list | |
| `personas.get` | `{ name }` | `PersonaDetailDto` | |
| `personas.compile` | `{ name }` | `PersonaCompileResultDto` | |
| `workflows.list` | -- | `WorkflowSummaryDto[]` | |
| `workflows.get` | `{ workflowId }` | `WorkflowDetailDto` | |
| `workflows.start` | `{ name, task, model?, workspace? }` | `{ workflowId }` | |
| `workflows.import` | `{ yaml }` | `{ name }` | Parse and import YAML definition |
| `workflows.resume` | `{ baseDir, state? }` | `{ workflowId }` | Resume a checkpointed workflow |
| `workflows.abort` | `{ workflowId }` | -- | |
| `workflows.resolveGate` | `{ workflowId, gateId, event, prompt?, resolvedBy? }` | -- | `gateId` is the active raise's per-raise id (else `GATE_MISMATCH`); `event` must be one the gate routes (else `EVENT_NOT_ACCEPTED`); `resolvedBy` is a declared channel (`web-ui`/`cli`/`signal`) for the `gate_resolved` log entry |
| `workflows.inspect` | `{ workflowId }` | messages log | |
| `workflows.fileTree` | `{ workflowId, path? }` | `FileTreeResponseDto` | Browse workspace files; directories and regular files only, at most 2,000 entries (`truncated`) |
| `workflows.fileContent` | `{ workflowId, path }` | `FileContentResponseDto` | Read file content (≤ 1 MiB, regular files only; `{ error }` otherwise) |
| `workflows.artifacts` | `{ workflowId, artifactName }` | `ArtifactContentDto` | Paths and sizes only (bounded, `truncated`) |
| `workflows.artifactFile` | `{ workflowId, artifactName, path }` | `FileContentResponseDto` | One artifact file, same rules as `fileContent` |
| `workflows.messageLog` | `{ workflowId, before?, limit? }` | `MessageLogResponseDto` | Newest first; pages capped in bytes, long strings cut with a `ref` |
| `workflows.messageLogEntry` | `{ workflowId, ref }` | `{ entry }` | Full text of a cut page entry |
| `workflows.listDefinitions` | -- | `WorkflowDefinitionDto[]` | Bundled + user definitions |
| `workflows.listResumable` | -- | `ResumableWorkflowDto[]` | Checkpointed workflows |

### 4.3 Events

| Event | Payload | Notes |
|-------|---------|-------|
| `session.created` | `SessionDto` | |
| `session.ended` | `{ label, reason }` | |
| `session.updated` | `SessionDto` | Session state change (persona, status) |
| `session.thinking` | `{ label, turnNumber }` | Emitted when `forwardMessage()` starts |
| `session.tool_call` | `{ label, toolName, preview }` | Per tool call during a turn |
| `session.tool_result` | `{ label, toolName, stepIndex }` | Emitted when a step completes |
| `session.text_delta` | `{ label, preview }` | Up to 200 chars of text per step (post-step snapshot, not streaming) |
| `session.output` | `{ label, text, turnNumber }` | Final response when `forwardMessage()` resolves |
| `session.diagnostic` | `{ label, event }` | Session notices only: the start-up notices and host-mount findings (see §5.4) |
| `session.budget_update` | `{ label, budget }` | |
| `escalation.created` | `EscalationDto` | Web sessions: their transport. Cron and Signal sessions: the SessionManager's escalation events, bridged by `WebUiServer` |
| `escalation.resolved` | `{ escalationId, decision }` | Web sessions: transport callback. Cron and Signal sessions: `resolveSessionEscalation`, bridged |
| `escalation.expired` | `{ escalationId, sessionLabel }` | Also bridged for cron and Signal sessions (proxy timeout, a response that came too late, the session ending) |
| `job.started` | `{ jobId, sessionLabel }` | |
| `job.completed` | `{ jobId, record }` | |
| `job.failed` | `{ jobId, error }` | |
| `job.list_changed` | `{}` | Emitted from daemon job mutation methods |
| `daemon.status` | `DaemonStatusDto` | Periodic (every 10s) |
| `daemon.resync` | `{ reason }` | To one client that missed events while backpressured; the UI refetches its state |
| `workflow.started` | `{ workflowId, name, taskDescription }` | |
| `workflow.state_entered` | `{ workflowId, state, previousState? }` | |
| `workflow.completed` | `{ workflowId }` | |
| `workflow.failed` | `{ workflowId, error }` | |
| `workflow.gate_raised` | `{ workflowId, gate }` | Human gate awaiting input |
| `workflow.gate_dismissed` | `{ workflowId, gateId }` | Gate resolved |
| `workflow.agent_started` | `{ workflowId, stateId, persona }` | |
| `workflow.agent_completed` | `{ workflowId, stateId, verdict?, confidence? }` | |

**Processing lifecycle notes.** The `text_delta` events are per-step post-completion snapshots (up to 200 chars), not token-level streaming. Each event is emitted from `onStepFinish`, meaning there is no feedback during a long inference step. True token-level streaming is deferred. The `step_finish` diagnostic kind is defined in `DiagnosticEvent` and emitted by `AgentSession`, enabling `session.tool_result` events.

**Event source of truth.** The `escalation.resolved` event is emitted only from `WebSessionTransport.onEscalationResolved` callback, not from the dispatch handler. This prevents duplicate emission for web-initiated resolutions and ensures correct behavior for cross-transport resolution (e.g., a web session's escalation approved via Signal).

## 5. Daemon-Side Architecture

### 5.1 Module Structure

```
src/web-ui/
  web-ui-server.ts         -- WebUiServer class (HTTP + WS, static file serving)
  web-session-transport.ts -- WebSessionTransport (extends BaseTransport)
  web-ui-types.ts          -- Frame types, DTOs, error classes, workflow DTOs
  web-event-bus.ts         -- WebEventBus (typed pub/sub)
  json-rpc-dispatch.ts     -- Thin router dispatching by method prefix
  workflow-manager.ts      -- WorkflowManager (bridges workflow engine to web UI)
  state-graph.ts           -- State machine graph utilities for workflow DTOs
  dispatch/
    types.ts               -- DispatchContext, DTO builders (toSessionDto, toBudgetDto)
    session-dispatch.ts    -- sessions.* methods
    job-dispatch.ts        -- jobs.* methods
    escalation-dispatch.ts -- escalations.* methods
    workflow-dispatch.ts   -- workflows.* methods
    persona-dispatch.ts    -- personas.* methods

src/session/
  session-manager.ts       -- SessionSource with 'web' kind, resolveSessionEscalation(),
                              pendingEscalations: Map<escalationId, PendingEscalationData>

packages/web-ui/           -- Svelte 5 SPA (workspace package, private)
  src/
    App.svelte
    views/
      Dashboard.svelte
      Sessions.svelte
      Escalations.svelte
      Jobs.svelte
      Workflows.svelte
      WorkflowDetail.svelte
      Personas.svelte
    lib/
      components/
        features/           -- Escalation card/modal, session console, file viewer, etc.
        ui/                 -- shadcn-svelte components (button, card, table, modal, etc.)
      ws-client.ts          -- Typed WebSocket client (JSON-RPC framing + reconnection)
      stores.svelte.ts      -- Svelte 5 rune-based reactive stores
      event-handler.ts      -- Event dispatch with EventSideEffects for testability
      flash-title.ts        -- Background-tab title flashing for escalations
      markdown.ts           -- Markdown rendering (marked + DOMPurify + Shiki)
      output-grouping.ts    -- Session output grouping logic
      types.ts              -- Frontend type definitions
      utils.ts              -- Utility functions (cn() class merging)
```

### 5.2 WebUiServer

The core daemon-side component. Creates a raw `http.createServer()`, serves static files with manual MIME type mapping, handles WebSocket upgrades via `ws.WebSocketServer`, authenticates connections, dispatches JSON-RPC methods, and broadcasts events.

Key implementation details:

- **Static file serving** uses a cache (`staticCache: Map`) with `readFileSync` + MIME type lookup. Files outside `staticRoot` are rejected via real-path containment check.
- **WebSocket upgrade** validates the Host header (see 8.3; anything else gets 421), then the token via `timingSafeEqual`, then the Origin header when present (same allowlist as Host; `--web-ui-dev` adds the Vite dev server origin instead of skipping the check; a missing Origin is a non-browser client such as the CLI daemon client and is accepted), then upgrades.
- **Ping/pong heartbeat** at 30s intervals. Clients missing 2 consecutive pings are terminated.
- **Orphaned session cleanup** via a grace period timer (60s default, `orphanGraceMs` for tests). When all connections close, the timer starts. If no client reconnects before it fires, all web sessions are ended.
- **One teardown path for web sessions.** Every way a turn-based web session ends — `sessions.end`, budget exhaustion, the transport's `run()` completing, the orphan reaper, and `stop()` on daemon shutdown — goes through `endManagedSession` (`src/web-ui/web-session-teardown.ts`): `SessionManager.end()` (which memoizes an in-flight end per label, so concurrent callers share one teardown and the session stays registered until its `close()` has finished), token-stream bus cleanup, the per-label send queue, `escalation.expired` for a still-pending escalation, and finally exactly one `session.ended`. The helper is idempotent per session on its own (a concurrent caller joins the helper teardown in flight), so a teardown that some other caller started with a bare `SessionManager.end()` (the Signal bot's `/quit #N` takes any label) is joined rather than mistaken for one that will emit the event. The daemon relies on that event to release its `TokenStreamBridge` label maps.
- **Event broadcasting** via `WebEventBus` subscription -- the server subscribes in its constructor and broadcasts all events to connected clients.

### 5.3 WebEventBus

Typed pub/sub bus decoupling event producers from WebSocket consumers. The `WebEventMap` interface ensures event name -> payload type is enforced at compile time. All connected clients receive all events (no per-client filtering needed for a local tool).

### 5.4 WebSessionTransport

Follows the `SignalSessionTransport` pattern:
- `runSession()` blocks until `close()` resolves a promise.
- `forwardMessage()` delegates to `sendAndLog()`.
- Callback factories emit events to the `WebEventBus`:
  - `createDiagnosticHandler()` emits the fine-grained `session.tool_call` / `session.text_delta` / `session.tool_result` events, and `session.diagnostic` only for the session notices (`isSessionNotice` in `src/session/startup-notices.ts`): the start-up diagnostics `annotation_drift`, `mcp_server_unavailable`, `host_model_fallback` and `policy_stale` (held until the session has a label), and `host_privileged_files` (setuid or root-owned files an agent left in its host mounts, after a turn or at session end). It does not forward every raw diagnostic (corrected 2026-11).
  - The frontend shows these notices in the session view, each in a dismissible banner rendered through `SafeText` (`features/session-notices.svelte`, pure logic in `src/lib/session-notices.ts`): seeded from the session's `diagnosticLog` (`sessions.get`) when it is selected and after a reconnect, and added from `session.diagnostic` events. They are kept per label and dropped with the session: on `session.ended`, and when a fresh `sessions.list` no longer has the session or shows the label naming another session (one created at another time; a restarted daemon numbers its sessions from 1 again). Signal and cron sessions, whose transports do not use the web bus, show the notices of their diagnostic log the same way. A `web-pty` terminal prints its own notices in the terminal.
  - `createEscalationHandler()` stores the full `EscalationDto` in `ManagedSession` via `setPendingEscalation()` before emitting `escalation.created`.
  - `createEscalationExpiredHandler()` receives the expired escalation's id, clears that one (the session's other pending escalations stay) and emits `escalation.expired` for it.
  - `createEscalationResolvedHandler()` is the single source of truth for `escalation.resolved` events.

**Cron and Signal sessions.** Their transports do not talk to the web bus. They record each escalation's full request on the SessionManager (`recordEscalation`: tool, arguments, whitelist candidates and the reviewer context, but no `groupKey`, so such an escalation never joins a group approval), and every outcome goes through `resolveSessionEscalation` or `expireEscalation`; the SessionManager tells its listeners, and `WebUiServer` re-emits those events for every session whose source is not `web` (web sessions announce their own, so nothing is sent twice; `escalations.resolve` and `escalations.approveGroup` announce the expiry of a late response themselves only for a web session's escalation). So a cron or Signal escalation appears live with its arguments, and disappears when it is decided anywhere. `escalations.resolve` refuses to approve (it can still deny) a pending escalation that does not name its server, tool and arguments, and the escalation card disables Approve for one. Without Signal, the daemon keeps a cron escalation pending for the web UI only while a browser is connected (`WebUiServer.hasBrowserClient()`: an authenticated client whose handshake carried an allowed Origin; the CLI clients send none); otherwise it is denied at once (see `cron-mode.md`, decision 3).

### 5.5 Integration with IronCurtainDaemon

The daemon gains an optional `WebUiServer` field, started after the control socket. The `--web-ui` flag controls activation (there is no config setting for it; see section 13). The server is dynamically imported so the `ws` dependency does not load when the web UI is disabled.

```bash
# Via flag
ironcurtain daemon --web-ui
ironcurtain daemon --web-ui --web-port 8080

# With development mode (also accepts the Vite dev server origin, localhost:5173)
ironcurtain daemon --web-ui --web-ui-dev

# Via config.json
{
  "daemon": { "webUi": { "enabled": true, "port": 7400 } }
}
```

## 6. SessionManager Changes

### 6.1 SessionSource Extension and Escalation Storage

```typescript
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string }
  | { readonly kind: 'web' };

export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  /**
   * Full data of every escalation of this session waiting for a decision, by
   * id: several can be pending at once (parallel tool calls), for
   * late-connecting clients and expiry handling.
   */
  readonly pendingEscalations: Map<string, PendingEscalationData>;
  /** Ids of the pending escalations whose resolution is in progress. */
  readonly escalationsResolving: Set<string>;
  runPromise: Promise<void> | null;
}
```

`escalations.list` lists every pending escalation of every session, and
`sessions.list` sets `hasPendingEscalation` when a session has at least one.

### 6.2 Escalation Resolution Extraction

`SessionManager.resolveSessionEscalation()` is the single codepath for all transports:

```typescript
async resolveSessionEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): Promise<EscalationResolutionResult> {
  // Find the session that has escalationId among its pendingEscalations
  // Guard against double-resolution of that escalation (escalationsResolving);
  //   the session's other escalations can be decided meanwhile
  // Call session.resolveEscalation() with whitelistSelection passthrough
  // A response written after the proxy's timeout throws ESCALATION_EXPIRED:
  //   return { resolved: false, reason: 'expired' }
  // Remove that escalation from pendingEscalations in a finally block
}
```

An `expired` result means the call was denied whatever the decision was:
`escalations.resolve` emits `escalation.expired` for the session and answers
with `ESCALATION_EXPIRED`, and the Signal bot replies that the escalation had
already expired, so a late approval is never reported as approved.

### 6.3 Web Sessions and currentLabel

Web sessions do not update `currentLabel`. The browser UI always specifies the target label explicitly. `findMostRecentSignalLabel()` only considers Signal sessions.

## 7. DTO Types

The full DTO type definitions are in `src/web-ui/web-ui-types.ts`. Key types:

- **SessionDto** / **SessionDetailDto** -- session snapshot with budget, escalation state, persona.
- **BudgetSummaryDto** -- the session's token/step/active-time/cost totals (`toBudgetDto` reads the cumulative view, because a builtin session's per-turn counters are zero between turns), with the per-turn limits. `costSource` (Docker sessions only) says where the cost comes from; the dashboard and session list show `unknown` for an `unknown` source and `≥ $x` for a `partial` one, never a made-up `$0.00`.
- **EscalationDto** -- full escalation context (tool call, arguments, reason, whitelist candidates), the reviewer context (`lastTrustedUserMessage` and `taskSummary`, the human's own text; `agentJustification`, written by the agent and untrusted) and `groupKey`, the whitelist-pattern group it belongs to (see 10.7).
- **DaemonStatusDto** -- uptime, job counts, transport states.
- **JobListDto** -- job definition with scheduling and last-run info, `isRunning` (true from the run's reservation, before its git sync and session start) and `consecutiveFailures`.
- **WorkflowSummaryDto** / **WorkflowDetailDto** -- workflow state with graph, transitions, context.
- **StateGraphDto** / **StateNodeDto** / **TransitionEdgeDto** -- state machine graph for visualization.
- **HumanGateRequestDto** -- human gate with accepted events and artifact names.
- **FileTreeResponseDto** / **FileContentResponseDto** -- workspace file browsing.
- **PersonaDetailDto** / **PersonaCompileResultDto** -- persona management.

### 7.1 Complete or deny-only escalation reviews

Each escalation fits a conservative 16 KiB review budget, 2,048 traversal entries and depth 16, or becomes an explicitly deny-only summary. Lists, workflow details and push events share the projection. Original pending records stay intact; every direct, PTY, workflow and group approval route checks them before resolving anything. No truncated request can be approved or whitelisted.

SPA refresh domains fail independently and retain held reviews on a failed RPC. The UI displays persistent recovery errors; a workflow whose current detail cannot be read has approval disabled while denial/abort remain available. The existing 8 MiB aggregate response cap remains, so very many bounded items can still fail a list/detail RPC visibly; pagination is not implemented.

## 8. Authentication and Security

### 8.1 Local-Only Binding

The HTTP server binds to `127.0.0.1`. The `--web-host` flag proposed here to bind other interfaces was not implemented, so `ironcurtain daemon` always binds the loopback address. No TLS.

### 8.2 Bearer Token Flow

1. Daemon generates `randomBytes(32).toString('base64url')` per launch.
2. Prints full URL with token to stderr: `Web UI: http://127.0.0.1:7400?token=<token>`.
3. SPA extracts token from `window.location.search`, stores in `sessionStorage`, strips from URL via `history.replaceState()`.
4. If no token in URL or `sessionStorage`, shows a prompt to paste from stderr.
5. WebSocket handshake: `ws://127.0.0.1:7400/ws?token=<token>`.
6. Token comparison uses `crypto.timingSafeEqual()`.

There is no unauthenticated endpoint serving the token.

### 8.3 Host and Origin Validation

**Host** (every HTTP request and WebSocket upgrade, DNS-rebinding defence): the `Host` header must name `localhost`, a loopback address (`127.0.0.0/8`, `::1`), the configured bind host or, when the daemon binds a wildcard address, any IP literal (no DNS name can be rebound to an IP literal), in each case at the port the connection arrived on. A missing, malformed or foreign Host gets `421 Misdirected Request`. The Vite dev proxy rewrites Host to the daemon's address (`changeOrigin: true`), so dev mode passes this check unchanged.

**Origin** (WebSocket upgrade, checked after the token): when the header is present it must be an `http:` origin whose authority passes the same Host rule. In dev mode (`--web-ui-dev`) the allowlist additionally contains the Vite dev server origins (`http://localhost:5173` and `http://127.0.0.1:5173`, the port following `IRONCURTAIN_WEB_UI_PORT` like `vite.config.ts`); the check is never skipped. A missing Origin is accepted because the CLI daemon client (`src/daemon-client/`) is not a browser and sends none; browsers always send one. The token remains the primary auth gate.

### 8.4 Additional Protections

- **WebSocket message size**: `maxPayload: 1MB` on `ws.WebSocketServer`.
- **Reply and send-buffer bounds**: a reply larger than 8 MiB, or one that would push the connection's send buffer past 8 MiB, is replaced by a `RESPONSE_TOO_LARGE` error for that request id; the socket is never closed for it (closing would fail every in-flight request and drop PTY and token-stream subscriptions). Event frames to a client whose send buffer is above 4 MiB are skipped, and the client gets one `daemon.resync` event once it drains (PTY output resyncs with a replay; token-stream deltas are dropped).
- **Agent-writable workspace reads**: the file browser and artifact methods never block on, or follow, what the agent planted: files are read through `readUntrustedRegularFileBelow` (`O_NOFOLLOW | O_NONBLOCK`, regular files only, at most 1 MiB + 1 bytes), each listed directory is opened through `openDirectoryBelow` (the directory actually opened must lie below the real workspace, or strictly below its real `.workflow` for artifacts; on Linux entries are read and sized through its descriptor, so a racing symlink swap cannot make a listing show a host directory), listings are asynchronous with entry, depth and serialized-byte budgets, and artifact contents are fetched one file per request.
- **Agent markdown** (`lib/markdown.ts`): marked escapes raw HTML tokens, so markup in agent text is shown, not interpreted; a dedicated DOMPurify instance allows only formatting elements plus the attributes GFM needs (`align`, `start`, disabled task-list checkboxes), never `style`, `class` or `id`, forms or other inputs; links keep only `http(s)`/`mailto` hrefs and open with `target=_blank rel="noopener noreferrer"`; images become text. `.prose-markdown` adds `contain: paint` so nothing rendered can draw outside its block. Rationale: agent-written artifacts, transition messages and log entries render in the same document as the Approve/Deny controls, and the CSP must keep `style-src 'unsafe-inline'` for xterm and Svelte transitions.
- **Escalation text** (`lib/unicode-display.ts`, `SafeText`): every agent-influenced string on the escalation card, on the workflow tool-call escalation panel (server/tool name, state, persona, reason, arguments, whitelist descriptions; see 10.3) and in the modal tab labels (server/tool name, reason, arguments, context, whitelist descriptions), and the modal's resolve-failure message (server text that can quote ids or exception messages), renders bidi controls, zero-width and other format characters, C0/C1 controls, and variation selectors, Hangul fillers and the other default-ignorable code points (which display as nothing) as highlighted `\uXXXX` escapes (at most 500 highlighted per text; any further ones are still spelled out, as plain text, so a value packed with invisible characters cannot make the page build an element per character). The one exception is the presentation selector of an ordinary emoji (a single U+FE0E/U+FE0F right after a pictograph, or the U+FE0F of a keycap): it changes how that emoji is drawn, so it is shown as itself and does not trigger the invisible-character note. Those blocks are `unicode-bidi: isolate; direction: ltr`, the argument and context blocks wrap instead of scrolling sideways, and notes warn when such characters are present or the arguments need scrolling. Path and URL arguments are shown as the policy engine evaluated them (relative paths resolved against the sandbox, `..` and symlinks resolved, URLs normalized), which is also what the transport sends.
- **Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- **CSP**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'` (dev mode widens `connect-src` to local `ws://` origins). `form-action 'none'` closes the form-submission path that `default-src` does not govern; the SPA's own forms all call `preventDefault`.
- **Rate limiting**: Max 10 concurrent WebSocket connections, and per-session message queuing. (The per-connection limit of 5 session creations per minute proposed here was not implemented; only concurrency caps exist.)
- **Policy bypass prevention**: The web UI communicates exclusively through the daemon API. Tool calls flow through the agent and policy engine.

## 9. Frontend Architecture

### 9.1 Technology Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`). SvelteKit is NOT used -- pure SPA.
- **Vite** for development (HMR) and production bundling.
- **shadcn-svelte** component library (copy-into-project, based on Bits UI headless primitives).
- **Tailwind CSS v3** with CSS variable theming and `class`-strategy dark mode.
- **marked** + **DOMPurify** for sanitized markdown rendering.
- **Shiki** for syntax highlighting.
- **Hash-based routing** for navigation.

Forms use plain Svelte 5 runes (`$state` for field values, `$derived` for validation errors) with Zod validation. Data tables use plain `{#each}` loops with sorted arrays. Neither `sveltekit-superforms`/`formsnap` (require SvelteKit) nor `@tanstack/svelte-table` (unnecessary for small data sets) nor `xterm-svelte` (uncertain Svelte 5 compatibility) were used.

### 9.2 State Management

```typescript
// packages/web-ui/src/lib/stores.svelte.ts

class AppState {
  connected: boolean = $state(false);
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, PendingEscalation> = $state(new Map());
  jobs: JobListDto[] = $state([]);
  sessionOutputs: Map<number, OutputLine[]> = $state(new Map());
  // ... derived getters
}
```

`selectedSessionLabel` is UI-local state (which tab the user clicked), not `currentLabel` from SessionManager.

### 9.3 WebSocket Client

The client implements exponential-backoff reconnection. On reconnect, it re-fetches all state in parallel (`Promise.all([status, sessions.list, jobs.list, escalations.list])`) and rehydrates stores.

### 9.4 Views

| View | Route | Data sources | Real-time events |
|------|-------|-------------|-----------------|
| **Dashboard** | `#/` | `status`, `sessions.list`, `jobs.list`, `escalations.list` | `daemon.status`, `session.*`, `job.*` |
| **Sessions** | `#/sessions/:label?` | `sessions.list`, `sessions.get`, `sessions.history`, `sessions.budget` | `session.*` events for selected session |
| **Escalations** | `#/escalations` | `escalations.list` | `escalation.*` |
| **Jobs** | `#/jobs/:jobId?` | `jobs.list`, `jobs.logs` | `job.*` |
| **Workflows** | `#/workflows` | `workflows.list`, `workflows.listDefinitions` | `workflow.*` |
| **Workflow Detail** | `#/workflows/:id` | `workflows.get`, `workflows.fileTree`, `workflows.fileContent` | `workflow.*` |
| **Personas** | `#/personas/:name?` | `personas.list`, `personas.get` | -- |

The sidebar shows navigation and an escalation count badge.

### 9.5 Component Library

shadcn-svelte components are scaffolded into `packages/web-ui/src/lib/components/ui/` via CLI and become project-owned source. Currently scaffolded: button, card, badge, table, tabs, dropdown-menu, input, modal, spinner, alert. The runtime dependency is Bits UI (~30KB gzipped).

## 10. Escalation Modal UX

The escalation experience uses a **modal dialog** for fast resolution, with the sidebar badge as a passive indicator when dismissed. This mirrors the terminal mux's floating overlay.

### 10.1 Component Structure

```
packages/web-ui/src/lib/components/
  features/
    escalation-card.svelte      -- Shared escalation card (used by both modal and page)
    escalation-modal.svelte     -- Modal with tab bar + cards + keyboard shortcuts
  ui/
    modal/                      -- Generic modal (backdrop, focus trap, Escape handling)
      modal.svelte
      index.ts
```

### 10.2 Generic Modal

Reusable component providing backdrop, centering, close-on-Escape, close-on-backdrop-click, and a focus trap:

- **On open:** saves `document.activeElement`. With `focusOnOpen="dialog"` (default) focus moves into the dialog but never onto an action control (a button, link, checkbox or select focused automatically would act on an Enter or Space the user was already typing): the first text field if there is one, otherwise the dialog container (`tabindex="-1"`). With `focusOnOpen="none"` (the escalation modal, which opens without a user action) focus stays where it is, so keystrokes meant for the page -- typically the terminal -- keep going there.
- **While open:** Tab/Shift+Tab cycles among modal's focusable elements (never escapes) once focus is inside. The `role="dialog"` element is exposed through `bind:dialog` for owners that observe presses inside it.
- **On close:** restores focus to previously focused element.
- ARIA: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to title.
- Escape: with focus inside the dialog the wrapper's `keydown` handler closes it and calls `event.stopPropagation()`. With focus outside (focus was never moved in) a document-level capture listener closes the top-most open modal and consumes the key, so a dismissal never doubles as terminal input.

### 10.3 Escalation Card

Shared component used by both the Escalations page and the modal:

```typescript
{
  escalation: EscalationDto;
  loading: boolean;
  armed?: boolean; // default true; false renders Approve, Deny and the whitelist choices inert
  onapprove: (whitelistSelection?: number) => void;
  ondeny: () => void;
}
```

The card owns its whitelist selection state via a local `$state` variable. Includes a "View Session #N" link that navigates to the session view and closes the modal. Every agent-influenced string is rendered through `SafeText` (invisible and direction-changing characters become highlighted escapes, see 8.4), a note warns when such characters occur or the arguments need scrolling, and the card says that path and URL arguments appear as the policy engine evaluated them. On the Escalations page a card is armed only once it has been in its place in the list for `ESCALATION_ARM_DELAY_MS`: resolving a card moves the ones below it up under the pointer, so a card that just appeared or moved up ignores clicks (the second click of a double click on Approve) for that long, while cards that did not move stay armed.

The card also shows the reviewer context (`escalation-review-context.svelte`): the session's task and "Your last message" (with the time it was sent) as the human's own text, and, set apart in a dashed warning box, "Agent's justification -- untrusted, written by the agent", with a note that it is the agent's unchecked claim and approves nothing. All of it goes through `SafeText`, and the justification counts toward the invisible-character note. The daemon fills these fields from the escalation request (`src/trusted-process/escalation-context.ts`): the last message is read like the auto-approver reads it (for a PTY session only what the trusted-message bar wrote), and the justification never reaches the auto-approver.

Workflow tool-call escalations (a call blocked inside a workflow agent state) are decided on the WorkflowDetail page, in `workflow-escalation-panel.svelte`, by escalation id through `workflows.resolveEscalation`. The panel follows the same rules: `SafeText` for every agent-influenced string with the same invisible-character note, a wrapped, bidi-isolated argument block, and the Escalations-page arming (a card takes Approve, Deny and whitelist clicks only once it has been in its place for `ESCALATION_ARM_DELAY_MS`). A human-only escalation (`humanOnly`, e.g. opening a passthrough domain) shows a note that it is approved once and offers no whitelist choices.

### 10.4 Escalation Modal

Composes the generic Modal with a tab bar and escalation cards:

- **Tab bar:** Each escalation gets a numbered tab with summary (e.g., "filesystem / write_file"). Left/Right arrows navigate. If the focused tab's escalation expires, focus snaps to nearest remaining tab.
- **Tab overflow (10+):** `overflow-x: auto` with `scroll-snap-type: x mandatory`. CSS gradient fade indicators at edges.

**Arming.** The modal opens on its own, usually while the user is typing into the terminal, so nothing already in flight may decide an escalation. It takes no focus (`focusOnOpen="none"`): keystrokes keep going where they were going and none reaches the dialog until the user clicks into it or tabs to it. Deciding is therefore always an explicit act inside the dialog -- a click on Approve or Deny, or a chord once focus is inside -- and it works only while the escalation on screen is _armed_: it has been visible for `ESCALATION_ARM_DELAY_MS` (750 ms) without a break. The delay restarts whenever a different escalation is shown (modal opened, previous one resolved, tab switched), so a double click or a repeated chord cannot decide the escalation that just replaced the one the user acted on. Visible means the user can be looking at it: while the page is hidden (background tab) or the window is unfocused the escalation is not armed, and the delay starts over when the page is shown or the window regains focus, so the first click into the window or tab (10.6 flashes the title to bring the user back) never decides. A click whose press (a pointer press, or Enter/Space on a focused button) began before arming, and key repeats, never act; the compatibility mousedown that follows a touch can only mark a press as unarmed. Until armed, Approve, Deny and the whitelist choices are shown but inert (`aria-disabled`). A `role="status"` line announces the state for screen readers.

**Keyboard shortcuts** (chords only; a bare letter typed into the terminal must never approve):

| Key | Action |
|-----|--------|
| Ctrl/⌘+Enter | Approve the escalation shown |
| Ctrl/⌘+Backspace | Deny the escalation shown |
| Left/Right | Navigate between tabs |
| Escape | Dismiss modal (updates watermark), also while focus is outside the dialog |

Chords fire only when focus is inside the dialog, never from an input or textarea inside it, only while armed, ignore `e.repeat`, and require exactly Ctrl or ⌘ (no Shift/Alt). Approve + whitelist is a click on a whitelist choice, then Approve. The legend at the bottom shows the chords, whether Approve and Deny are enabled yet, and, while focus is outside the dialog, that the keys need a click inside first.

**Resolve failures.** A decision the daemon rejects (`ESCALATION_EXPIRED`, `ESCALATION_NOT_FOUND`, a lost connection) is shown inside the modal as a `role="alert"` line ("Failed to approve: ...", rendered through `SafeText`), cleared when the next decision is attempted or the dialog closes. App keeps the dialog open on such a failure, so an expiry of the last pending escalation is reported instead of closing like a success.

### 10.5 Display Number Watermark

Client-side counters control auto-open/dismiss behavior:

```typescript
// In stores.svelte.ts
let escalationDisplayNumber: number = $state(0);
let escalationDismissedAt: number = $state(0);

function assignDisplayNumber(): number {
  return ++escalationDisplayNumber;
}

function recordDismissal(): void {
  escalationDismissedAt = escalationDisplayNumber;
}
```

Each escalation in `pendingEscalations` gets a `displayNumber` assigned client-side when `escalation.created` is processed. The `EventSideEffects` interface in `event-handler.ts` injects `assignDisplayNumber()` for testability.

**Auto-open/close logic (in `App.svelte`):**

```svelte
<script>
  let escalationModalOpen = $state(false);

  // Auto-open when new (unseen) escalations arrive,
  // unless user is on the Escalations page
  $effect(() => {
    const shouldOpen =
      escalationDisplayNumber > escalationDismissedAt &&
      pendingEscalations.size > 0 &&
      appState.currentView !== 'escalations';
    if (shouldOpen) escalationModalOpen = true;
  });

  // Auto-close when all escalations resolved
  $effect(() => {
    if (pendingEscalations.size === 0) escalationModalOpen = false;
  });

  function dismissEscalationModal() {
    escalationModalOpen = false;
    recordDismissal();
  }
</script>
```

**Reconnect behavior:** On the initial connect `refreshAll` sets `escalationDismissedAt` to `escalationDisplayNumber` so pre-existing escalations do not auto-open. On every (re)connect it keeps the display number of each escalation already in `pendingEscalations` and numbers only ids it has not seen, so a WebSocket reconnect never re-opens the modal for escalations the user already dismissed; only escalations that arrived while the socket was down count as new. The `escalations.list` answer is applied the moment it arrives and merged with the escalation events received while it was requested (`src/lib/escalation-snapshots.ts`): the answer reflects the daemon at one moment in that window, so an escalation an event raised, resolved or expired meanwhile (or one of a session that ended meanwhile) is decided by the client's live state, and every other one by the answer. An escalation raised during the refresh therefore stays pending, and one resolved during it does not come back. On the initial connect the watermark covers the escalations pending when that answer is applied; one raised after it opens the modal. A `daemon.resync` runs the same refresh.

### 10.6 Background Tab Notification

When an escalation fires and the tab is not visible, the document title flashes (e.g., alternating with "Warning Escalation Pending"). The `flash-title.ts` utility uses `setInterval` at 1s and stops via `visibilitychange` when the tab becomes visible. No Notification API (too intrusive for a dev tool).

### 10.7 Escalations Page

The full Escalations page remains as a persistent view. It serves as a fallback for deliberate browsing and a future home for escalation history. When the user is on the Escalations page, the modal suppresses auto-open.

**Group approval.** Pending escalations that share one whitelist pattern (the same `groupKey`, stamped by the daemon from the pattern key of the escalation's first whitelist candidate, the exact one `/approve+` selects; never the directory-wide one, `src/escalation/escalation-groups.ts`) are offered as a group above the cards: "N pending escalations share one pattern", the pattern, the session labels and a "Review group" button. Human-only escalations, those without a keyed pattern, and those of cron and Signal sessions (recorded without a `groupKey`, see 5.4) never group. A banner that appears or goes (a group forms, or dissolves because a member expired or was decided elsewhere) moves every card without changing its index, so the number of banners is part of a card's place in the arming rule above: the cards wait `ESCALATION_ARM_DELAY_MS` again, and a click aimed at "Review group" cannot land on the Approve or Deny of the card that moved into the banner's place. "Review group" opens `escalation-group-confirm.svelte`, which lists every member (session, tool, arguments, reason, reviewer context) and says that each is approved once and nothing is whitelisted. Its Approve button is inert for `ESCALATION_ARM_DELAY_MS` after the list opens and for a press that began before that; when the group changes while the list is open (a member arrived, expired or was resolved) it says so and Approve stays inert. Approve sends `escalations.approveGroup` with exactly the ids listed; the daemon re-checks that they are still exactly the group's pending members before resolving any, and reports members that then fail on their own (expired meanwhile) in `failed`.

## 11. Escalation Flow

```
Agent -> Proxy -> PolicyEngine -> escalate
                                      |
                                      v
                            Session.onEscalation callback
                                      |
                  +-------------------+-------------------+
                  |                   |                   |
          SignalTransport      WebTransport       HeadlessTransport
                               (stores DTO in     (auto-deny or
                                ManagedSession,    Signal notify)
                                emits to bus)
                                     |
                                     v
                            WebUiServer.broadcast()
                                     |
                              +------+------+
                              |             |
                         Modal overlay  Escalations page
                              |
                        User clicks Approve
                              |
                              v
                        WS RequestFrame { method: 'escalations.resolve' }
                              |
                              v
                        sessionManager.resolveSessionEscalation()
                              |
                              v
                        session.resolveEscalation()
                              |
                              v
                        Proxy picks up response file
```

All three transports resolve through `sessionManager.resolveSessionEscalation()`. Cross-transport resolution works: a web session's escalation can be approved from Signal, and both the transport callback event and the Signal confirmation fire independently.

## 12. Build and Deployment

### 12.1 Workspace Package

The web UI is `packages/web-ui/` -- an npm workspace package, `"private": true`. Compiled output goes to `dist/web-ui-static/` during the root build.

### 12.2 Vite Configuration

```typescript
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: { '/ws': { target: 'ws://127.0.0.1:7400', ws: true } },
  },
});
```

### 12.3 Root Build Pipeline

```json
{
  "build": "npm run build:web-ui --if-present && tsc && node scripts/copy-assets.mjs",
  "build:web-ui": "npm run build -w packages/web-ui"
}
```

The `--if-present` flag makes the web UI build optional. If it runs and fails, the entire build aborts. `copy-assets.mjs` copies `packages/web-ui/dist/` to `dist/web-ui-static/` if it exists, skipping silently otherwise. The daemon handles missing assets gracefully -- logs a warning and starts without the web UI.

All frontend dependencies are `devDependencies` of the workspace package. Only compiled static output ships with `npm install -g ironcurtain`.

### 12.4 Development Workflow

1. Start daemon: `ironcurtain daemon --web-ui --web-ui-dev`
2. Start Vite dev server: `cd packages/web-ui && npm run dev` (port 5173, proxies `/ws` to daemon)
3. Open `http://localhost:5173?token=<token>` for HMR development.
4. Mock server: `npm run mock-server -w packages/web-ui` for UI development without Docker/LLM.

## 13. Configuration

> **As implemented (2026-11):** the web UI has no settings in `~/.ironcurtain/config.json`; the `daemon.webUi` block proposed below was never added to the config schema. It is configured by `ironcurtain daemon` flags only: `--web-ui` (enable), `--web-port <port>` (default 7400) and `--web-ui-dev` (also accept the Vite dev server origin). The bind address is always `127.0.0.1`.

Proposed (not implemented):

```json
// In ~/.ironcurtain/config.json
{
  "daemon": {
    "webUi": {
      "enabled": true,
      "port": 7400
    }
  }
}
```

| Setting | Default | Flag override |
|---------|---------|--------------|
| `daemon.webUi.enabled` | `false` | `--web-ui` |
| `daemon.webUi.port` | `7400` | `--web-port` |
| `daemon.webUi.host` | `'127.0.0.1'` | `--web-host` (not implemented) |

## 14. Dependencies

### Daemon-side (root package.json)

| Package | Purpose | Notes |
|---------|---------|-------|
| `ws` | WebSocket server | Moved from devDependencies to dependencies. No `WebSocketServer` in Node.js core. |

Hono was considered but not used. Static file serving uses native `http.createServer()` with manual MIME mapping.

### Frontend (packages/web-ui/ devDependencies)

| Package | Purpose |
|---------|---------|
| `svelte` | Frontend framework (build-time) |
| `@sveltejs/vite-plugin-svelte` | Vite integration (build-time) |
| `vite` | Build tool + dev server (build-time) |
| `tailwindcss` v3 | CSS framework + theming (build-time) |
| `bits-ui` | Headless accessible primitives (~30KB runtime) |
| `sonner` | Toast notifications |
| `shiki` | Syntax highlighting |
| `dompurify` | HTML sanitization |
| `marked` | Markdown rendering |

**Key win:** One new runtime dependency (`ws` moved from dev) in the main package. All frontend dependencies bundled by Vite.

## 15. Testing Strategy

### Daemon-side

- **Unit tests** for `SessionManager.resolveSessionEscalation()`, `WebUiServer` dispatch, `WebSessionTransport`, auth/origin validation, frame parsing.
- **Integration tests** for full flow: start daemon with `--web-ui`, connect WS, create session, send message, receive events.
- Located in `src/web-ui/__tests__/`.

### Frontend

- **Component tests** via Svelte Testing Library + Vitest (36 tests in `packages/web-ui`).
- **WebSocket client tests**: mock WebSocket, verify frame construction, request/response correlation, reconnection.
- **Event handler tests**: verify `EventSideEffects` injection enables deterministic testing.
- Run via `npm test -w packages/web-ui`.
- No E2E browser tests in initial implementation.

## 16. Design Review Notes

This design went through a formal 21-item architectural critique. Key items that influenced the implementation:

1. **Full escalation storage in ManagedSession** (critique #6). The original `pendingEscalationId: string` was insufficient for `escalations.list`. Changed to `pendingEscalation: EscalationDto | null` so late-connecting clients can fetch pending escalations. This also fixed the `escalationId: 'unknown'` problem in the expired handler (critique #5).

2. **Dropped `sveltekit-superforms` and `formsnap`** (critique #8, #9). Both require SvelteKit's server-side form actions. Replaced with plain Svelte 5 runes + Zod validation.

3. **Dropped `xterm-svelte`** (critique #10). Uncertain Svelte 5 compatibility. Using `<pre>` + markdown rendering instead.

4. **Tailwind v3 instead of v4** (critique #11). shadcn-svelte CLI generates v3-style config. v4 migration deferred.

5. **Dropped `@tanstack/svelte-table`** (critique #16). Unnecessary for expected data volumes (<50 jobs, <10 sessions). Using plain `{#each}` + sorted arrays.

6. **Dropped command palette** (critique #15). Over-engineered for a local tool with few sessions.

7. **Removed duplicate `escalation.resolved` emission** (critique #12). The `onEscalationResolved` callback is the single source of truth.

8. **`step_finish` diagnostic emission wired** (critique #1). Added to `AgentSession.onStepFinish` so `session.tool_result` events fire.

9. **`job.list_changed` trigger points wired** (critique #20). Event bus emissions added to daemon's `addJob()`, `removeJob()`, `enableJob()`, `disableJob()`, and `recompileJob()`.

10. **Origin validation in dev mode** (critique #13) originally accepted any origin. It now adds only the Vite dev server origins to the allowlist (see 8.3); the bearer token remains the real auth gate.

Other critique items (turn number in `session.thinking`, auto-save memory for web sessions, `sessions.send` to non-web sessions, reconnection hydration order) were addressed during implementation as documented in the relevant sections above.

---

**Note:** The files `docs/designs/daemon-web-ui-critique.md` and `docs/designs/web-ui-escalation-ux.md` are superseded by this consolidated document and should be deleted.
