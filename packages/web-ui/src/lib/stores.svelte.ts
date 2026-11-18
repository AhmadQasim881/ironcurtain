/**
 * Application state management using Svelte 5 runes.
 *
 * The store holds all reactive state and exposes methods to mutate it.
 * The WebSocket client feeds events into the store via handleEvent().
 */

import type {
  SessionDto,
  EscalationDto,
  EscalationGroupApprovalDto,
  DaemonStatusDto,
  JobListDto,
  OutputLine,
  PendingEscalation,
  PersonaListItem,
  PersonaDetailDto,
  PersonaEditResultDto,
  PersonaCompileOperationDto,
  PersonaCompileStreamAckDto,
  PersonaListCompilesDto,
  ResumableWorkflowDto,
  WorkflowSummaryDto,
  WorkflowDetailDto,
  WorkflowBudgetDto,
  ResourceBudgetConfigDto,
  WorkflowDefinitionDto,
  WorkflowReadmeDto,
  HumanGateRequestDto,
  WorkflowEscalationDto,
  FileTreeResponseDto,
  FileContentResponseDto,
  ArtifactContentDto,
  MessageLogResponseDto,
  MessageLogEntryResponseDto,
  GetModelProvidersDto,
  StatisticsConfigDto,
  SetModelProvidersDto,
  OpenrouterModelsDto,
  DockerWorkloadSettingsDto,
  PtySink,
  CreateSessionOptions,
  ResumableSessionDto,
  SessionDetailDto,
  SessionNoticeEntry,
  SessionNoticeEvent,
  StatisticsCapabilitiesDto,
  StatisticsSummaryQuery,
  StatisticsMetricSummaryDto,
  StatisticsSeriesQuery,
  StatisticsTimeBucketDto,
  StatisticsDistributionQuery,
  StatisticsMetricDistributionDto,
  StatisticsExchangeQuery,
  StatisticsExchangePageDto,
  StatisticsDimensionQuery,
  StatisticsDimensionValueDto,
} from './types.js';
import { PHASE } from './types.js';
import { createWsClient, type PreflightResult, type WsClient } from './ws-client.js';
import { handleEvent as handleEventPure, SESSION_MUTATION_EVENTS } from './event-handler.js';
import {
  ESCALATION_EVENTS,
  mergeEscalationSnapshot,
  mergeWorkflowEscalationSnapshot,
  type ReceivedEvent,
} from './escalation-snapshots.js';
import {
  dismissSessionNoticeEntry,
  retainSessionNotices,
  seedSessionNotices,
  toSessionNotice,
  type RetainedHostNotice,
} from './session-notices.js';

export type ViewId =
  'dashboard' | 'statistics' | 'sessions' | 'escalations' | 'jobs' | 'workflows' | 'personas' | 'settings';
export type ThemeId = 'iron' | 'daylight' | 'midnight';

const MAX_OUTPUT_LINES = 2000;
const THEME_KEY = 'ic-theme';
const AUTH_TOKEN_KEY = 'ic-auth-token';

const VALID_THEMES: ReadonlySet<string> = new Set<ThemeId>(['iron', 'daylight', 'midnight']);

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_KEY);
  return stored && VALID_THEMES.has(stored) ? (stored as ThemeId) : 'iron';
}

export function setTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

class AppState {
  retainedHostNotices: readonly RetainedHostNotice[] = $state([]);
  connected: boolean = $state(false);
  hasToken: boolean = $state(false);
  /**
   * Non-null when the last auth preflight (or server-side rejection)
   * indicated the token is bad. The browser WebSocket API hides HTTP
   * status codes, so we rely on an HTTP preflight to `/ws/auth` and
   * surface the result here to drive UI state.
   */
  authError: 'invalid_token' | null = $state(null);
  escalationLoadError: string | null = $state(null);
  refreshErrors: Readonly<Record<string, string>> = $state({});
  workflowReviewErrors: Map<string, string> = $state(new Map());
  get reviewRefreshError(): string | null {
    return (
      this.escalationLoadError ||
      Object.values(this.refreshErrors)[0] ||
      [...this.workflowReviewErrors.values()][0] ||
      null
    );
  }
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, PendingEscalation> = $state(new Map());
  escalationDisplayNumber: number = $state(0);
  escalationDismissedAt: number = $state(0);
  jobs: JobListDto[] = $state([]);
  sessionOutputs: Map<number, OutputLine[]> = $state(new Map());
  currentView: ViewId = $state('dashboard');

  // Workflow state
  workflows: Map<string, WorkflowSummaryDto> = $state(new Map());
  selectedWorkflowId: string | null = $state(null);
  pendingGates: Map<string, HumanGateRequestDto> = $state(new Map());
  /** Workflow tool-call escalations waiting for a human, keyed by escalationId. */
  pendingWorkflowEscalations: Map<string, WorkflowEscalationDto> = $state(new Map());

  // Persona streamed-compile state, keyed by operationId. Holds both live
  // (started/running) and recently-terminal (done/failed) operations as they
  // arrive via persona.compile.* events, hydrated on (re)connect via
  // personas.listCompiles.
  personaCompiles: Map<string, PersonaCompileOperationDto> = $state(new Map());

  /**
   * Notices each session reported for the user (a stale policy, an MCP server
   * that did not start, host-mount findings, ...; see `session-notices.ts`),
   * keyed by session label: seeded from the session's diagnostic log when it
   * is selected (`loadSessionNotices`), and from `session.diagnostic` events.
   */
  sessionNotices: Map<number, readonly SessionNoticeEntry[]> = $state(new Map());

  get selectedSession(): SessionDto | null {
    if (this.selectedSessionLabel === null) return null;
    return this.sessions.get(this.selectedSessionLabel) ?? null;
  }

  get escalationCount(): number {
    return this.pendingEscalations.size;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  addOutput(label: number, line: OutputLine): void {
    let existing = this.sessionOutputs.get(label) ?? [];

    // Remove stale "Thinking..." lines when real content arrives
    if (line.kind === 'tool_call' || line.kind === 'assistant' || line.kind === 'escalation') {
      existing = existing.filter((l) => l.kind !== 'thinking');
    }

    existing = [...existing, line];

    // Cap output to prevent unbounded memory growth
    if (existing.length > MAX_OUTPUT_LINES) {
      existing = existing.slice(existing.length - MAX_OUTPUT_LINES);
    }

    // Create a new Map so Svelte 5 detects the change
    this.sessionOutputs = new Map(this.sessionOutputs).set(label, existing);
  }

  filterOutput(label: number, predicate: (line: OutputLine) => boolean): void {
    const existing = this.sessionOutputs.get(label);
    if (!existing) return;
    const filtered = existing.filter(predicate);
    if (filtered.length !== existing.length) {
      this.sessionOutputs = new Map(this.sessionOutputs).set(label, filtered);
    }
  }

  removeOutput(label: number): void {
    const next = new Map(this.sessionOutputs);
    next.delete(label);
    this.sessionOutputs = next;
  }

  getOutput(label: number): OutputLine[] {
    return this.sessionOutputs.get(label) ?? [];
  }
}

export const appState = new AppState();

/**
 * Monotonically increasing counter bumped whenever connection-driven
 * refresh state is triggered, including the initial WebSocket connect
 * and any later reconnects.
 * Components can read `.value` as a $effect dependency to force
 * re-fetches after a connection event, even when other reactive
 * values haven't changed.
 */
export const connectionGeneration = $state({ value: 0 });

/**
 * Monotonically increasing counter bumped on every `personas.changed`
 * server-push event (persona create/edit/delete/memory/broad-policy mutation).
 * The Personas view reads `.value` as a $effect dependency to refresh its
 * locally-held persona list + selected detail, mirroring how `job.list_changed`
 * drives `refreshJobs`. Kept as a standalone reactive object (rather than on
 * appState) because the persona list lives in the route component, not the
 * global store.
 */
export const personasChangedGeneration = $state({ value: 0 });

/**
 * Monotonically increasing counter bumped on every `config.changed` server-push
 * event. The Settings view reads `.value` as an $effect dependency to refresh
 * its locally-held provider-profile and runtime views. Kept off appState because
 * the config view state lives in the route component, not the global store.
 */
export const configChangedGeneration = $state({ value: 0 });

/** Bumped when completion/failure events make active or past workflow history stale. */
export const workflowHistoryGeneration = $state({ value: 0 });

/**
 * Per-label terminal sink registry. A `web-pty` session's frames
 * (`session.pty_replay` / `session.pty_output`) can arrive BEFORE its
 * `TerminalConsole` has created its xterm terminal — a fast daemon sends the
 * one-shot replay the instant it receives `ptyAttach`, which can beat the
 * component's mount effect. So each sink BUFFERS frames until the route connects
 * the mounted terminal's live handle, then drains them in order — a replay
 * snapshot is never dropped (which would blank a reconnect to an idle session).
 * The pure event handler routes `session.pty_*` events here via `getPtySink`.
 * Not reactive — imperative handles, never rendered.
 */
/**
 * Cap on the pre-connect buffer (base64 chars ~= bytes). Bounds memory if a
 * terminal never connects (render error) or mounts late during heavy output;
 * the common case (mount within a frame or two) never trips it, and a snapshot
 * `reset()` supersedes the buffer entirely.
 */
const PTY_SINK_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

class BufferingPtySink implements PtySink {
  private live: PtySink | null = null;
  private buffered: Array<{ reset: boolean; b64: string }> = [];
  private bufferedBytes = 0;

  write(dataB64: string): void {
    if (this.live) {
      this.live.write(dataB64);
      return;
    }
    this.buffered.push({ reset: false, b64: dataB64 });
    this.bufferedBytes += dataB64.length;
    this.capBuffer();
  }

  reset(snapshotB64: string): void {
    if (this.live) {
      this.live.reset(snapshotB64);
      return;
    }
    // A fresh snapshot is the source of truth: it supersedes buffered deltas.
    this.buffered = [{ reset: true, b64: snapshotB64 }];
    this.bufferedBytes = snapshotB64.length;
  }

  /** Drops the oldest buffered frames once over the cap (always keeps >=1). */
  private capBuffer(): void {
    while (this.bufferedBytes > PTY_SINK_MAX_BUFFERED_BYTES && this.buffered.length > 1) {
      const dropped = this.buffered.shift();
      if (dropped) this.bufferedBytes -= dropped.b64.length;
    }
  }

  /** Connect the mounted terminal and flush any buffered frames, in order. */
  connect(handle: PtySink): void {
    this.live = handle;
    for (const frame of this.buffered) {
      if (frame.reset) handle.reset(frame.b64);
      else handle.write(frame.b64);
    }
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  disconnect(): void {
    this.live = null;
  }
}

const ptySinks = new Map<number, BufferingPtySink>();

/** Registers a buffering sink for a label. Idempotent — never clobbers a live sink. */
export function registerPtySink(label: number): void {
  if (!ptySinks.has(label)) ptySinks.set(label, new BufferingPtySink());
}

export function unregisterPtySink(label: number): void {
  ptySinks.delete(label);
}

/**
 * Connects a mounted terminal's live handle for `label`, draining buffered
 * frames. Order-independent with `registerPtySink` (creates the sink if the
 * terminal mounted before the route registered it).
 */
export function connectPtyTerminal(label: number, handle: PtySink): void {
  let sink = ptySinks.get(label);
  if (!sink) {
    sink = new BufferingPtySink();
    ptySinks.set(label, sink);
  }
  sink.connect(handle);
}

/** Disconnects the live handle (the terminal unmounted); later frames re-buffer. */
export function disconnectPtyTerminal(label: number): void {
  ptySinks.get(label)?.disconnect();
}

// WebSocket client singleton
let wsClient: WsClient | null = null;

export function getWsClient(): WsClient {
  if (!wsClient) {
    wsClient = createWsClient(verifyAuthToken);
    wireEventHandlers(wsClient);
  }
  return wsClient;
}

/**
 * HTTP preflight against the daemon's `/ws/auth` endpoint. The status is
 * mapped to three outcomes:
 *   - 200 → 'ok'
 *   - 401 → 'invalid' (clear the token and stop retrying)
 *   - anything else, including network errors → 'offline' (keep retrying;
 *     a transient 5xx must not destructively purge a good token)
 *
 * Exported for testing.
 */
export async function verifyAuthToken(token: string, fetchImpl: typeof fetch = fetch): Promise<PreflightResult> {
  try {
    const url = buildDaemonUrl(`/ws/auth?token=${encodeURIComponent(token)}`, { ws: false });
    const res = await fetchImpl(url, { method: 'GET', cache: 'no-store' });
    if (res.status === 200) return 'ok';
    if (res.status === 401) return 'invalid';
    return 'offline';
  } catch {
    return 'offline';
  }
}

type BufferedSessionEvent = {
  event: string;
  payload: unknown;
};

/** Replay buffer of the sessions.list refresh currently in flight (if any). */
let activeSessionBuffer: BufferedSessionEvent[] | null = null;
const queuedSessionRefreshes: Array<{ client: WsClient; buffered: BufferedSessionEvent[] }> = [];
let sessionRefreshQueueRunning = false;

/**
 * One log per escalation snapshot request in flight (`escalations.list`,
 * `workflows.get`): every escalation event received meanwhile is appended to
 * each, so the answer can be merged with them (see escalation-snapshots.ts).
 */
const escalationEventLogs = new Set<ReceivedEvent[]>();

/**
 * Sends a request whose answer is a snapshot of pending escalations, and
 * returns the answer with the escalation events received while it was in
 * flight. The log is closed when the answer arrives; the caller merges it in
 * the same microtask run, before the client handles any later frame.
 */
async function requestEscalationSnapshot<T>(
  client: WsClient,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ answer: T; events: readonly ReceivedEvent[] }> {
  const events: ReceivedEvent[] = [];
  escalationEventLogs.add(events);
  try {
    const answer = await client.request<T>(method, params);
    return { answer, events };
  } finally {
    escalationEventLogs.delete(events);
  }
}

function applyWebEvent(client: WsClient, event: string, payload: unknown): void {
  handleEventPure(
    appState,
    {
      refreshJobs: () => refreshJobs(client),
      refreshWorkflowHistory: () => {
        workflowHistoryGeneration.value++;
      },
      refreshPersonas: () => {
        personasChangedGeneration.value++;
      },
      refreshConfig: () => {
        configChangedGeneration.value++;
      },
      resync: () => {
        void refreshAll(client);
      },
      assignDisplayNumber: (_escalationId: string) => ++appState.escalationDisplayNumber,
      getPtySink: (label: number) => ptySinks.get(label),
    },
    event,
    payload,
  );
}

function wireEventHandlers(client: WsClient): void {
  client.onConnectionChange((connected) => {
    appState.connected = connected;
    if (connected) {
      // Connection success clears any stale auth error from a previous
      // attempt (e.g. user pasted a bad token, then a good one).
      appState.authError = null;
      refreshAll(client);
    }
  });

  client.onAuthError(() => {
    handleAuthError();
  });

  client.onEvent((event, payload) => {
    applyWebEvent(client, event, payload);
    if (SESSION_MUTATION_EVENTS.has(event)) {
      activeSessionBuffer?.push({ event, payload });
    }
    if (ESCALATION_EVENTS.has(event)) {
      for (const log of escalationEventLogs) log.push({ event, payload });
    }
  });
}

/** Purge the bad token and flip the UI back to the token input. */
function handleAuthError(): void {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  appState.hasToken = false;
  appState.authError = 'invalid_token';
}

let isInitialConnect = true;

function applySessionsSnapshot(sessions: SessionDto[]): void {
  const newSessions = new Map<number, SessionDto>();
  for (const session of sessions) {
    newSessions.set(session.label, session);
  }
  const previous = appState.sessions;
  appState.sessions = newSessions;
  // Each session's notices are its own: drop those of sessions that ended
  // while the socket was down, and of labels a restarted daemon gave to
  // other sessions.
  const notices = retainSessionNotices(appState.sessionNotices, previous, newSessions);
  if (notices !== undefined) appState.sessionNotices = notices;
}

function completeSessionRefresh(client: WsClient, buffered: BufferedSessionEvent[], sessions: SessionDto[]): void {
  applySessionsSnapshot(sessions);
  activeSessionBuffer = null;
  for (const event of buffered) {
    applyWebEvent(client, event.event, event.payload);
  }
}

async function runSessionRefresh(client: WsClient, buffered: BufferedSessionEvent[]): Promise<void> {
  try {
    const sessions = await client.request<SessionDto[]>('sessions.list');
    completeSessionRefresh(client, buffered, sessions);
  } catch (err) {
    // Session events were already applied live. Dropping only the replay
    // buffer preserves those mutations while allowing the next queued refresh.
    activeSessionBuffer = null;
    console.error('Failed to refresh sessions:', err);
  }
}

async function drainSessionRefreshQueue(): Promise<void> {
  while (queuedSessionRefreshes.length > 0) {
    const next = queuedSessionRefreshes.shift();
    if (!next) continue;
    activeSessionBuffer = next.buffered;
    await runSessionRefresh(next.client, next.buffered);
  }
  sessionRefreshQueueRunning = false;
}

function enqueueSessionRefresh(client: WsClient): void {
  const buffered: BufferedSessionEvent[] = [];
  queuedSessionRefreshes.push({ client, buffered });
  if (!sessionRefreshQueueRunning) {
    sessionRefreshQueueRunning = true;
    // The drain loop runs synchronously up to its first await, so the first
    // buffer becomes active before this returns — events delivered in the
    // same tick as the connect that queued the refresh are captured too.
    void drainSessionRefreshQueue();
  }
}

/**
 * Removes the gates in `heldIds` (the ones the client held before a refresh
 * started) that `shouldDrop` selects. Gates that arrived by event since then
 * are newer than any answer the refresh is acting on and are never touched.
 */
function dropHeldGates(heldIds: ReadonlySet<string>, shouldDrop: (gate: HumanGateRequestDto) => boolean): void {
  const next = new Map<string, HumanGateRequestDto>();
  for (const [gateId, gate] of appState.pendingGates) {
    if (!heldIds.has(gateId) || !shouldDrop(gate)) next.set(gateId, gate);
  }
  appState.pendingGates = next;
}

/**
 * Removes the workflow tool-call escalations in `heldIds` (held before a
 * refresh started) that `shouldDrop` selects; ones raised by events since then
 * are newer than the refresh's answers and are kept.
 */
function dropHeldWorkflowEscalations(
  heldIds: ReadonlySet<string>,
  shouldDrop: (escalation: WorkflowEscalationDto) => boolean,
): void {
  let next: Map<string, WorkflowEscalationDto> | null = null;
  for (const [escalationId, escalation] of appState.pendingWorkflowEscalations) {
    if (!heldIds.has(escalationId) || !shouldDrop(escalation)) continue;
    next ??= new Map(appState.pendingWorkflowEscalations);
    next.delete(escalationId);
  }
  if (next) appState.pendingWorkflowEscalations = next;
}

/**
 * Applies an `escalations.list` answer, merged with the escalation events
 * received while it was requested (`mergeEscalationSnapshot`): an escalation
 * raised meanwhile stays, one resolved or expired meanwhile does not come
 * back, and escalations missed while disconnected appear or disappear.
 */
function applyEscalationsSnapshot(listed: readonly EscalationDto[], events: readonly ReceivedEvent[]): void {
  // Escalations the UI already knows keep their display number; a number
  // above `escalationDismissedAt` re-opens the modal, and the user already
  // dismissed (or is looking at) these. Only escalations that arrived while
  // the socket was down get a fresh number and count as new.
  const next = mergeEscalationSnapshot(
    appState.pendingEscalations,
    listed,
    events,
    () => ++appState.escalationDisplayNumber,
  );
  appState.pendingEscalations = next;
  // Remove stale escalation output lines that are no longer pending
  for (const [label, lines] of appState.sessionOutputs) {
    const filtered = lines.filter(
      (line) => line.kind !== 'escalation' || (line.escalationId && next.has(line.escalationId)),
    );
    if (filtered.length !== lines.length) {
      appState.sessionOutputs = new Map(appState.sessionOutputs).set(label, filtered);
    }
  }
  // On initial connect, suppress auto-open for the escalations pending now;
  // one raised after this answer is new and opens the modal. On reconnect,
  // preserve the watermark so new escalations during disconnect will
  // trigger the modal.
  if (isInitialConnect) {
    appState.escalationDismissedAt = appState.escalationDisplayNumber;
    isInitialConnect = false;
  }
}

/**
 * Fetches the pending session escalations and applies them the moment the
 * answer arrives, so the events after it land on top of it instead of being
 * overwritten when the rest of the refresh finishes.
 */
async function refreshEscalations(client: WsClient): Promise<void> {
  try {
    const { answer, events } = await requestEscalationSnapshot<EscalationDto[]>(client, 'escalations.list');
    applyEscalationsSnapshot(answer, events);
    appState.escalationLoadError = null;
  } catch {
    appState.escalationLoadError = 'Pending requests could not be refreshed. Previously shown reviews remain visible.';
  }
}

async function refreshDomain<T>(name: string, request: Promise<T>): Promise<T | undefined> {
  try {
    const answer = await request;
    const next = { ...appState.refreshErrors };
    delete next[name];
    appState.refreshErrors = next;
    return answer;
  } catch {
    appState.refreshErrors = {
      ...appState.refreshErrors,
      [name]: `Could not refresh ${name}. Previously shown data remains visible.`,
    };
    return undefined;
  }
}

/**
 * Fetches a workflow's detail. Its `escalations` are the daemon's view of the
 * workflow's pending tool-call escalations: the moment the answer arrives
 * they replace what the client holds for that workflow, merged with the
 * escalation events received meanwhile (`mergeWorkflowEscalationSnapshot`).
 * The workflow's gate is left to the caller (`syncWorkflowGateFromDetail`).
 */
async function fetchWorkflowDetail(client: WsClient, workflowId: string): Promise<WorkflowDetailDto> {
  const { answer, events } = await requestEscalationSnapshot<WorkflowDetailDto>(client, 'workflows.get', {
    workflowId,
  });
  appState.pendingWorkflowEscalations = mergeWorkflowEscalationSnapshot(
    appState.pendingWorkflowEscalations,
    workflowId,
    // The daemon leaves `escalations` out while nothing is pending.
    answer.escalations ?? [],
    events,
  );
  const errors = new Map(appState.workflowReviewErrors);
  errors.delete(workflowId);
  appState.workflowReviewErrors = errors;
  return answer;
}

/**
 * Replaces whatever gate the client holds for `workflowId` with the server's
 * view from a fresh `workflows.get`: the gate it reports, or none when the
 * workflow is not waiting. A workflow has at most one active gate, so any
 * other entry for it is stale (its `gate_dismissed` was missed) and is
 * dropped rather than left to be resolved by mistake.
 */
export function syncWorkflowGateFromDetail(workflowId: string, detail: WorkflowDetailDto): void {
  const next = new Map<string, HumanGateRequestDto>();
  for (const [gateId, gate] of appState.pendingGates) {
    if (gate.workflowId !== workflowId) next.set(gateId, gate);
  }
  if (detail.phase === PHASE.WAITING_HUMAN && detail.gate) {
    next.set(detail.gate.gateId, detail.gate);
  }
  appState.pendingGates = next;
}

async function refreshAll(client: WsClient): Promise<void> {
  enqueueSessionRefresh(client);
  // Snapshot the gates and workflow tool-call escalations held before any
  // request goes out: every one of them is superseded by the server's answers
  // below, while a gate or escalation raised by an event during the refresh
  // is newer than those answers and kept.
  const gatesBeforeRefresh: ReadonlySet<string> = new Set(appState.pendingGates.keys());
  const workflowEscalationsBeforeRefresh: ReadonlySet<string> = new Set(appState.pendingWorkflowEscalations.keys());
  try {
    const [status, jobs, , workflowsList, personaCompiles] = await Promise.all([
      refreshDomain('status', client.request<DaemonStatusDto>('status')),
      refreshDomain('jobs', client.request<JobListDto[]>('jobs.list')),
      // Applied on arrival, not with the rest (see refreshEscalations).
      refreshEscalations(client),
      refreshDomain('workflows', client.request<WorkflowSummaryDto[]>('workflows.list')),
      client
        .request<PersonaListCompilesDto>('personas.listCompiles', {})
        .catch(() => ({ active: [], recent: [], queueDepth: 0 }) as PersonaListCompilesDto),
    ]);

    if (status !== undefined) appState.daemonStatus = status;
    if (jobs !== undefined) appState.jobs = jobs;

    if (workflowsList === undefined) {
      connectionGeneration.value++;
      return;
    }

    const newWorkflows = new Map<string, WorkflowSummaryDto>();
    for (const wf of workflowsList) {
      newWorkflows.set(wf.workflowId, wf);
    }
    appState.workflows = newWorkflows;

    // Rehydrate persona compile operations (active wins over recent on id collision).
    const newPersonaCompiles = new Map<string, PersonaCompileOperationDto>();
    for (const op of personaCompiles.recent) newPersonaCompiles.set(op.operationId, op);
    for (const op of personaCompiles.active) newPersonaCompiles.set(op.operationId, op);
    appState.personaCompiles = newPersonaCompiles;

    // Rebuild pending gates from server state. Events may have been lost
    // while disconnected in both directions: a gate raised meanwhile is
    // missing from `pendingGates`, and a gate dismissed meanwhile is still
    // in it. A stale entry is dangerous, not just untidy -- the review panel
    // would show one gate's summary while the user decides about it (the
    // daemon refuses a decision bound to a raise that is gone, but the user
    // has still been shown the wrong gate) -- so the server's view replaces
    // what the client held: only workflows the list reports as waiting keep a
    // gate, and only the gate `workflows.get` returns for them.
    const waiting = workflowsList.filter((wf) => wf.phase === PHASE.WAITING_HUMAN);
    const waitingIds = new Set(waiting.map((wf) => wf.workflowId));
    dropHeldGates(gatesBeforeRefresh, (gate) => !waitingIds.has(gate.workflowId));
    // Workflow tool-call escalations (the Workflows badge counts them) are
    // rebuilt the same way, from every workflow still live: an agent blocked
    // in an escalated call is `running`, and one at a gate may still hold one.
    // What was held for a workflow that finished or is gone is dropped.
    const live = workflowsList.filter((wf) => wf.phase === PHASE.RUNNING || wf.phase === PHASE.WAITING_HUMAN);
    const liveIds = new Set(live.map((wf) => wf.workflowId));
    appState.workflowReviewErrors = new Map([...appState.workflowReviewErrors].filter(([id]) => liveIds.has(id)));
    dropHeldWorkflowEscalations(workflowEscalationsBeforeRefresh, (escalation) => !liveIds.has(escalation.workflowId));
    await Promise.all(
      live.map(async (wf) => {
        try {
          // The detail's escalations are applied inside fetchWorkflowDetail.
          const detail = await fetchWorkflowDetail(client, wf.workflowId);
          // Applied the moment it arrives: responses and events share one
          // ordered socket, so an event handled after this answer (a dismissal
          // or a newer raise) lands on top of it instead of being overwritten
          // when the remaining fetches finish. A gate raised for a workflow
          // the list reported as running arrives by event and is kept.
          if (waitingIds.has(wf.workflowId)) syncWorkflowGateFromDetail(wf.workflowId, detail);
        } catch {
          // Keep the held review visible, explicitly unavailable for approval
          // until its current detail can be read. A later event still wins.
          appState.workflowReviewErrors = new Map(appState.workflowReviewErrors).set(
            wf.workflowId,
            'A workflow review could not be refreshed. Approval is unavailable until it can be read again.',
          );
        }
      }),
    );

    // Bump connection generation so detail views re-fetch
    connectionGeneration.value++;
  } catch (err) {
    console.error('Failed to refresh state:', err);
  }
}

let refreshJobsTimer: ReturnType<typeof setTimeout> | null = null;

function refreshJobs(client: WsClient): void {
  if (refreshJobsTimer) clearTimeout(refreshJobsTimer);
  refreshJobsTimer = setTimeout(async () => {
    refreshJobsTimer = null;
    try {
      appState.jobs = await client.request<JobListDto[]>('jobs.list');
    } catch {
      // Best-effort
    }
  }, 300);
}

/**
 * Build a daemon-relative URL. `ws: true` selects ws(s) for the WebSocket
 * endpoint; otherwise http(s) is used for plain HTTP requests like the
 * auth preflight. The scheme mirrors the page's own protocol so dev
 * (http) and prod (https) Just Work.
 */
function buildDaemonUrl(path: string, opts: { ws: boolean }): string {
  const isHttps = window.location.protocol === 'https:';
  const protocol = opts.ws ? (isHttps ? 'wss:' : 'ws:') : isHttps ? 'https:' : 'http:';
  return `${protocol}//${window.location.host}${path}`;
}

function buildWsUrl(): string {
  return buildDaemonUrl('/ws', { ws: true });
}

/**
 * Initialize the WebSocket connection. Extracts token from URL
 * or sessionStorage. `hasToken` is only flipped to `true` after the
 * store-level preflight inside `startConnectionWithToken()` succeeds or
 * returns 'offline' — we don't flip it here so a bad token doesn't
 * flash the dashboard.
 */
export async function initConnection(): Promise<void> {
  const client = getWsClient();

  const params = new URLSearchParams(window.location.search);
  let token = params.get('token');

  if (token) {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  } else {
    token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  }

  if (!token) {
    return;
  }

  await startConnectionWithToken(client, token);
}

/**
 * Send a resolve request for a pending escalation.
 * Callers handle errors in their own way (rethrow, display, etc.).
 */
export async function resolveEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  whitelistSelection?: number,
): Promise<void> {
  const params: Record<string, unknown> = { escalationId, decision };
  if (decision === 'approved' && whitelistSelection != null) {
    params.whitelistSelection = whitelistSelection;
  }
  await getWsClient().request('escalations.resolve', params);
}

/**
 * Approves every member of one whitelist-pattern group, after the user
 * confirmed the list. `escalationIds` must be exactly the members that were
 * shown: the daemon refuses (ESCALATION_GROUP_CHANGED), approving nothing,
 * when the group changed since. Each member is approved once; nothing is
 * whitelisted.
 */
export async function approveEscalationGroup(
  groupKey: string,
  escalationIds: readonly string[],
): Promise<EscalationGroupApprovalDto> {
  return getWsClient().request<EscalationGroupApprovalDto>('escalations.approveGroup', {
    groupKey,
    escalationIds: [...escalationIds],
  });
}

// ── Session RPC actions ──────────────────────────────────────────────

/**
 * Create a session. `persona` applies to every mode; `workspacePath`,
 * `providerProfileName`, and `model` are container/web-pty launch options (mux
 * `/new` parity).
 * Only the provided keys are sent so the backend schema's optionals stay unset.
 */
export async function createSession(opts?: CreateSessionOptions): Promise<{ label: number }> {
  const params: Record<string, unknown> = {};
  if (opts?.persona) params.persona = opts.persona;
  if (opts?.workspacePath) params.workspacePath = opts.workspacePath;
  if (opts?.providerProfileName) params.providerProfileName = opts.providerProfileName;
  if (opts?.model) params.model = opts.model;
  return getWsClient().request<{ label: number }>('sessions.create', params);
}

export async function listResumableSessions(): Promise<ResumableSessionDto[]> {
  return getWsClient().request<ResumableSessionDto[]>('sessions.listResumable');
}

export async function resumeSession(sessionId: string): Promise<{ label: number }> {
  return getWsClient().request<{ label: number }>('sessions.resume', { sessionId });
}

export async function endSession(label: number): Promise<void> {
  await getWsClient().request('sessions.end', { label });
}

/**
 * Seeds the session view's notices from the session's diagnostic log
 * (`sessions.get`): the start-up notices it emitted before this client was
 * watching, and host-mount findings. Notices already held are kept; a
 * dismissed one stays dismissed. A session that ended meanwhile is skipped.
 */
export async function loadSessionNotices(label: number): Promise<void> {
  const detail = await getWsClient().request<SessionDetailDto>('sessions.get', { label });
  const logged: SessionNoticeEvent[] = [];
  for (const event of Array.isArray(detail.diagnosticLog) ? detail.diagnosticLog : []) {
    const notice = toSessionNotice(event);
    if (notice !== undefined) logged.push(notice);
  }
  if (!appState.sessions.has(label)) return;
  appState.sessionNotices = new Map(appState.sessionNotices).set(
    label,
    seedSessionNotices(appState.sessionNotices.get(label), logged),
  );
}

/** Hides one notice of a session's view (it stays hidden when the notices are seeded again). */
export function dismissSessionNotice(label: number, key: string): void {
  const entries = appState.sessionNotices.get(label);
  if (entries === undefined) return;
  appState.sessionNotices = new Map(appState.sessionNotices).set(label, dismissSessionNoticeEntry(entries, key));
}

// ── PTY terminal RPC actions (web-pty sessions) ──────────────────────
//
// Attach/detach manage this client's subscription to a session's terminal
// stream; input/resize forward keystrokes and the browser xterm's size to the
// child PTY. `data` is base64 of the UTF-8 bytes of the keystroke string.
// Ending a PTY session reuses `endSession` (`sessions.end`).

export async function attachPty(label: number): Promise<void> {
  await getWsClient().request('sessions.ptyAttach', { label });
}

export async function detachPty(label: number): Promise<void> {
  await getWsClient().request('sessions.ptyDetach', { label });
}

export async function sendPtyInput(label: number, dataB64: string): Promise<void> {
  await getWsClient().request('sessions.ptyInput', { label, data: dataB64 });
}

/**
 * PTY size range the daemon accepts on `sessions.ptyResize` (mirrors
 * src/pty/pty-size.ts; out-of-range frames are rejected there because an
 * unbounded size makes the daemon's headless terminal allocate gigabytes).
 */
const PTY_MIN_COLS = 2;
const PTY_MAX_COLS = 1000;
const PTY_MIN_ROWS = 1;
const PTY_MAX_ROWS = 500;

function clampDimension(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export async function sendPtyResize(label: number, cols: number, rows: number): Promise<void> {
  // A zoomed-out or ultra-wide browser can fit more than the daemon accepts.
  // Clamp so the PTY still adopts the largest supported size; an out-of-range
  // frame would be rejected and leave the PTY at its previous size.
  await getWsClient().request('sessions.ptyResize', {
    label,
    cols: clampDimension(cols, PTY_MIN_COLS, PTY_MAX_COLS),
    rows: clampDimension(rows, PTY_MIN_ROWS, PTY_MAX_ROWS),
  });
}

/**
 * Send a TRUSTED user message to a web-pty session. Unlike `sendPtyInput`
 * (raw keystrokes, base64, never trusted), `text` is PLAIN text: the daemon
 * records it as trusted user-context (authorizing auto-approval) and injects it
 * into the child PTY. This is the only browser path to auto-approval.
 */
export async function sendPtyPrompt(label: number, text: string): Promise<void> {
  await getWsClient().request('sessions.ptyPrompt', { label, text });
}

// ── Job RPC actions ──────────────────────────────────────────────────

export async function runJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.run', { jobId });
}

export async function enableJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.enable', { jobId });
}

export async function disableJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.disable', { jobId });
}

export async function removeJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.remove', { jobId });
}

export async function recompileJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.recompile', { jobId });
}

// ── Persona RPC actions ──────────────────────────────────────────────

export async function listPersonas(): Promise<PersonaListItem[]> {
  return getWsClient().request<PersonaListItem[]>('personas.list');
}

/**
 * The configured MCP servers a persona can be narrowed to, in configuration
 * order (the built-ins, then the user's own servers): exactly the names
 * `personas.create` accepts in `servers`. A read, not gated on the mutation
 * kill switch. Rejects when the daemon cannot load its server configuration.
 */
export async function listPersonaServers(): Promise<string[]> {
  return getWsClient().request<string[]>('personas.listServers');
}

// ── Persona CRUD mutation RPC actions (Phase 1c) ──────────────────────
//
// All five are gated server-side on the daemon's `--allow-policy-mutation`
// flag: when off they reject with POLICY_MUTATION_FORBIDDEN. The UI hides
// these controls when `appState.daemonStatus.allowPolicyMutation` is false,
// so a forbidden rejection is a defense-in-depth path, not the normal one.
// Errors (RpcError with a `.code`) bubble to the caller for inline/actionable
// affordances. Each successful mutation also triggers a `personas.changed`
// server-push event handled by the event handler.

/**
 * Create a new persona. `servers: undefined` (or omitted) means "all servers
 * (incl. future)"; a non-empty array narrows to those servers explicitly.
 * Errors: INVALID_PARAMS (bad slug / empty description), PERSONA_EXISTS,
 * POLICY_MUTATION_FORBIDDEN.
 */
export async function createPersona(input: {
  name: string;
  description: string;
  servers?: string[];
  memoryEnabled?: boolean;
  constitution?: string;
}): Promise<PersonaDetailDto> {
  const params: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.servers !== undefined) params.servers = input.servers;
  if (input.memoryEnabled !== undefined) params.memoryEnabled = input.memoryEnabled;
  if (input.constitution !== undefined) params.constitution = input.constitution;
  return getWsClient().request<PersonaDetailDto>('personas.create', params);
}

/**
 * Replace a persona's constitution. Returns `{ stale }` — `stale: true` means
 * the previously compiled policy no longer matches the constitution and should
 * be recompiled. Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN.
 */
export async function editPersonaConstitution(name: string, constitution: string): Promise<PersonaEditResultDto> {
  return getWsClient().request<PersonaEditResultDto>('personas.editConstitution', { name, constitution });
}

/** Toggle a persona's persistent-memory flag. Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN. */
export async function setPersonaMemory(name: string, enabled: boolean): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.setMemory', { name, enabled });
}

/**
 * Set a persona's broad-policy opt-in. This is the ONLY way to set
 * `allowBroadPolicy`; it is never inferred from the constitution. When enabled,
 * the compiler's broad-policy validator permits allow rules with wildcard
 * domains/lists, out-of-workspace paths or unconstrained resource arguments.
 * Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN.
 */
export async function setPersonaBroadPolicyOptIn(name: string, enabled: boolean): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.setBroadPolicyOptIn', { name, enabled });
}

/**
 * Delete a persona. Soft by default (renamed into a trash dir, policy left
 * inert); `force: true` hard-deletes and revokes the policy. `confirmed: true`
 * is required by the backend schema. Errors: PERSONA_NOT_FOUND,
 * POLICY_MUTATION_FORBIDDEN.
 */
export async function deletePersona(name: string, opts?: { force?: boolean }): Promise<{ deleted: true }> {
  const params: Record<string, unknown> = { name, confirmed: true };
  if (opts?.force) params.force = true;
  return getWsClient().request<{ deleted: true }>('personas.delete', params);
}

// ── Workflow RPC actions ────────────────────────────────────────────

export async function listWorkflowDefinitions(): Promise<WorkflowDefinitionDto[]> {
  return getWsClient().request<WorkflowDefinitionDto[]>('workflows.listDefinitions');
}

/**
 * Fetches a workflow's co-packaged README markdown, addressed either by its
 * definition manifest path (Start picker, no running workflow) or by a
 * running/past workflow id (detail view). Exactly one argument is sent.
 */
export async function getWorkflowReadme(target: {
  definitionPath?: string;
  workflowId?: string;
}): Promise<WorkflowReadmeDto> {
  return getWsClient().request<WorkflowReadmeDto>('workflows.readme', target);
}

export async function listWorkflows(): Promise<WorkflowSummaryDto[]> {
  return getWsClient().request<WorkflowSummaryDto[]>('workflows.list');
}

export async function startWorkflow(
  definitionPath: string,
  taskDescription: string,
  workspacePath?: string,
): Promise<{ workflowId: string }> {
  const params: Record<string, unknown> = { definitionPath, taskDescription };
  if (workspacePath) params.workspacePath = workspacePath;
  return getWsClient().request<{ workflowId: string }>('workflows.start', params);
}

export async function abortWorkflow(workflowId: string): Promise<void> {
  await getWsClient().request('workflows.abort', { workflowId });
}

/**
 * Refusals of a gate decision that mean the gate the client displayed is no
 * longer the one the workflow waits at (another decider acted first, or a
 * `gate_dismissed` was missed).
 */
const STALE_GATE_ERROR_CODES: ReadonlySet<string> = new Set(['GATE_MISMATCH', 'WORKFLOW_NOT_AT_GATE']);

function rpcErrorCode(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/**
 * Submits a gate decision bound to the raise the user reviewed. `gateId` is
 * the id of the gate the panel displayed; the daemon rejects the decision
 * (`GATE_MISMATCH`) if the workflow has since moved to another raise, and
 * declares this client as the `web-ui` channel for the audit log.
 *
 * On a stale-gate refusal nothing was applied. Before rethrowing, the
 * workflow's gate is re-read from the daemon and replaces the stale entry
 * (or removes it when nothing is waiting), so the panel shows what is
 * actually pending and the next click reviews that, not the old raise.
 */
export async function resolveWorkflowGate(
  workflowId: string,
  gateId: string,
  event: string,
  prompt?: string,
): Promise<void> {
  if (event === 'APPROVE' && (appState.workflowReviewErrors.has(workflowId) || appState.refreshErrors.workflows)) {
    throw new Error('Refresh this workflow review before approving it.');
  }
  const params: Record<string, unknown> = { workflowId, gateId, event, resolvedBy: 'web-ui' };
  if (prompt) params.prompt = prompt;
  try {
    await getWsClient().request('workflows.resolveGate', params);
  } catch (err) {
    const code = rpcErrorCode(err);
    if (code !== undefined && STALE_GATE_ERROR_CODES.has(code)) {
      try {
        syncWorkflowGateFromDetail(workflowId, await getWorkflowDetail(workflowId));
      } catch {
        // Best-effort: the next gate event or reconnect refresh resyncs.
      }
    }
    throw err;
  }
}

/**
 * Approves or denies a workflow tool-call escalation. `whitelistSelection`
 * (approvals only) indexes the escalation's `whitelistCandidates`.
 */
export async function resolveWorkflowEscalation(
  workflowId: string,
  escalationId: string,
  decision: 'approved' | 'denied',
  whitelistSelection?: number,
): Promise<void> {
  const params: Record<string, unknown> = { workflowId, escalationId, decision };
  if (whitelistSelection !== undefined) params.whitelistSelection = whitelistSelection;
  await getWsClient().request('workflows.resolveEscalation', params);
}

export async function refreshWorkflows(): Promise<void> {
  try {
    const workflows = await listWorkflows();
    const newMap = new Map<string, WorkflowSummaryDto>();
    for (const wf of workflows) {
      newMap.set(wf.workflowId, wf);
    }
    appState.workflows = newMap;
  } catch {
    // Best-effort
  }
}

/**
 * Fetches a workflow's detail (`workflows.get`). The answer's pending
 * tool-call escalations also replace the ones the store holds for that
 * workflow, merged with the escalation events received while it was in
 * flight (see `fetchWorkflowDetail`); applying its gate is up to the caller.
 */
export async function getWorkflowDetail(workflowId: string): Promise<WorkflowDetailDto> {
  return fetchWorkflowDetail(getWsClient(), workflowId);
}

export async function listResumableWorkflows(): Promise<ResumableWorkflowDto[]> {
  return getWsClient().request<ResumableWorkflowDto[]>('workflows.listResumable');
}

export async function importWorkflow(baseDir: string): Promise<{ workflowId: string }> {
  return getWsClient().request<{ workflowId: string }>('workflows.import', { baseDir });
}

export async function resumeWorkflow(workflowId: string, useCurrentBudget = false): Promise<{ workflowId: string }> {
  return getWsClient().request<{ workflowId: string }>('workflows.resume', {
    workflowId,
    ...(useCurrentBudget ? { useCurrentBudget } : {}),
  });
}

// ── Workflow file browser RPC actions ──────────────────────────────────

export async function getWorkflowFileTree(workflowId: string, path?: string): Promise<FileTreeResponseDto> {
  const params: Record<string, unknown> = { workflowId };
  if (path) params.path = path;
  return getWsClient().request<FileTreeResponseDto>('workflows.fileTree', params);
}

export async function getWorkflowFileContent(workflowId: string, path: string): Promise<FileContentResponseDto> {
  return getWsClient().request<FileContentResponseDto>('workflows.fileContent', { workflowId, path });
}

/** Lists an artifact's files (names and sizes); contents come from {@link getWorkflowArtifactFile}. */
export async function getWorkflowArtifacts(workflowId: string, artifactName: string): Promise<ArtifactContentDto> {
  return getWsClient().request<ArtifactContentDto>('workflows.artifacts', { workflowId, artifactName });
}

/** Fetches one artifact file (same shape as a workspace file read). */
export async function getWorkflowArtifactFile(
  workflowId: string,
  artifactName: string,
  path: string,
): Promise<FileContentResponseDto> {
  return getWsClient().request<FileContentResponseDto>('workflows.artifactFile', { workflowId, artifactName, path });
}

/**
 * Fetch a page of message-log entries for a workflow. No client-side caching:
 * every call hits the daemon so live runs see fresh entries on each invocation.
 *
 * Cursor pagination per design D5: pass the oldest entry's `ts` as `before`
 * to fetch the next (older) page. RPC errors bubble to the caller.
 */
export async function getWorkflowMessageLog(
  workflowId: string,
  opts?: { before?: string; limit?: number },
): Promise<MessageLogResponseDto> {
  const params: Record<string, unknown> = { workflowId };
  if (opts?.before !== undefined) params.before = opts.before;
  if (opts?.limit !== undefined) params.limit = opts.limit;
  return getWsClient().request<MessageLogResponseDto>('workflows.messageLog', params);
}

/**
 * Fetch the complete entry behind a truncated page entry's `ref` (long agent
 * messages are cut in `workflows.messageLog` pages).
 */
export async function getWorkflowMessageLogEntry(workflowId: string, ref: string): Promise<MessageLogEntryResponseDto> {
  return getWsClient().request<MessageLogEntryResponseDto>('workflows.messageLogEntry', { workflowId, ref });
}

// ── Persona RPC actions (extended) ─────────────────────────────────────

export async function getPersonaDetail(name: string): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.get', { name });
}

/**
 * Fire-and-return a streamed persona compile. The ack carries the minted
 * operationId; subsequent progress arrives via persona.compile.* events that
 * land in `appState.personaCompiles`. RPC errors (e.g. POLICY_MUTATION_FORBIDDEN,
 * COMPILE_IN_PROGRESS, CREDENTIALS_MISSING) bubble to the caller.
 */
export async function startPersonaCompile(name: string): Promise<PersonaCompileStreamAckDto> {
  return getWsClient().request<PersonaCompileStreamAckDto>('personas.compileStream', { name });
}

/** Read a single compile operation snapshot (active live record, else recent LRU). */
export async function getPersonaCompile(operationId: string): Promise<PersonaCompileOperationDto> {
  return getWsClient().request<PersonaCompileOperationDto>('personas.getCompile', { operationId });
}

/** List in-flight + recently-terminal compile operations. */
export async function listPersonaCompiles(): Promise<PersonaListCompilesDto> {
  return getWsClient().request<PersonaListCompilesDto>('personas.listCompiles', {});
}

/**
 * (Re)hydrate `appState.personaCompiles` from the daemon's authoritative
 * active+recent records. Called on connect/reconnect and by the Personas view.
 * Returns the operationIds present on the server so callers can detect a
 * locally-tracked op that the server no longer knows about (interrupted).
 */
export async function hydratePersonaCompiles(): Promise<Set<string>> {
  const { active, recent } = await listPersonaCompiles();
  const next = new Map<string, PersonaCompileOperationDto>();
  for (const op of recent) next.set(op.operationId, op);
  // Active records win over a recent record with the same id.
  for (const op of active) next.set(op.operationId, op);
  appState.personaCompiles = next;
  return new Set(next.keys());
}

// ── Config RPC actions ─────────────────────────────────────────────────
//
// Config reads are ungated; writes are gated server-side on the daemon's
// `--allow-policy-mutation` flag (rejects with POLICY_MUTATION_FORBIDDEN when
// off). The Settings view hides mutation controls when the flag is false. A
// successful write broadcasts `config.changed` (bumps configChangedGeneration).

/**
 * Read the model-provider registry. Every openrouter profile's `apiKey` is
 * masked (`sk-...xyz` / 'none'); the implicit `native` profile is included.
 */
export async function getModelProviders(): Promise<GetModelProvidersDto> {
  return getWsClient().request<GetModelProvidersDto>('config.getModelProviders', {});
}

/**
 * Write the WHOLE model-provider registry. Sends the complete `profiles` record
 * (the backend replaces it wholesale). Per the M5 contract, leaving a profile's
 * masked `apiKey` untouched preserves the stored key; '' clears it; a new string
 * sets it. Returns the fresh masked registry. Errors (POLICY_MUTATION_FORBIDDEN,
 * INVALID_PARAMS) bubble to the caller.
 */
export async function setModelProviders(input: SetModelProvidersDto): Promise<GetModelProvidersDto> {
  return getWsClient().request<GetModelProvidersDto>('config.setModelProviders', {
    ...(input.default !== undefined ? { default: input.default } : {}),
    profiles: input.profiles,
    ...(input.renameFrom ? { renameFrom: input.renameFrom } : {}),
  });
}

export async function getStatisticsConfig(): Promise<StatisticsConfigDto> {
  return getWsClient().request<StatisticsConfigDto>('config.getStatistics', {});
}

export async function setStatisticsConfig(input: StatisticsConfigDto): Promise<StatisticsConfigDto> {
  return getWsClient().request<StatisticsConfigDto>('config.setStatistics', { ...input });
}

/**
 * Fetch the OpenRouter model-slug catalog for autocomplete/validation. `source`
 * tells the caller whether the list is authoritative (`live`/`cache` → hard-block
 * unknown slugs) or the offline floor (`bundled` → warn-only). Ungated read.
 * Pass `forceRefresh` to bypass the daemon's 6h cache (the editor's Refresh button).
 */
export async function listProviderModels(service: string, forceRefresh = false): Promise<OpenrouterModelsDto> {
  return getWsClient().request<OpenrouterModelsDto>('config.listProviderModels', {
    service,
    ...(forceRefresh ? { forceRefresh } : {}),
  });
}

export async function listOpenrouterModels(forceRefresh = false): Promise<OpenrouterModelsDto> {
  return getWsClient().request<OpenrouterModelsDto>(
    'config.listOpenrouterModels',
    forceRefresh ? { forceRefresh: true } : {},
  );
}

/** Read the supported nested-Docker settings. */
export async function getDockerWorkloadSettings(): Promise<DockerWorkloadSettingsDto> {
  return getWsClient().request<DockerWorkloadSettingsDto>('config.getDockerWorkload', {});
}

/**
 * Update only nested-Docker enablement and its three-state network access.
 * Advanced runtime fields are deliberately absent from this wire contract.
 */
export async function setDockerWorkloadSettings(input: DockerWorkloadSettingsDto): Promise<DockerWorkloadSettingsDto> {
  return getWsClient().request<DockerWorkloadSettingsDto>('config.setDockerWorkload', {
    enabled: input.enabled,
    networkAccess: input.networkAccess,
  });
}

// ── Read-only LLM statistics RPC actions ─────────────────────────────

export async function getStatisticsCapabilities(): Promise<StatisticsCapabilitiesDto> {
  return getWsClient().request<StatisticsCapabilitiesDto>('statistics.capabilities', {});
}

export async function getStatisticsSummary(
  query: StatisticsSummaryQuery,
): Promise<readonly StatisticsMetricSummaryDto[]> {
  return getWsClient().request<readonly StatisticsMetricSummaryDto[]>('statistics.summary', { ...query });
}

export async function getStatisticsSeries(query: StatisticsSeriesQuery): Promise<readonly StatisticsTimeBucketDto[]> {
  return getWsClient().request<readonly StatisticsTimeBucketDto[]>('statistics.series', { ...query });
}

export async function getStatisticsDistribution(
  query: StatisticsDistributionQuery,
): Promise<StatisticsMetricDistributionDto> {
  return getWsClient().request<StatisticsMetricDistributionDto>('statistics.distribution', { ...query });
}

export async function getStatisticsExchanges(query: StatisticsExchangeQuery): Promise<StatisticsExchangePageDto> {
  return getWsClient().request<StatisticsExchangePageDto>('statistics.exchanges', { ...query });
}

export async function getStatisticsDimensions(
  query: StatisticsDimensionQuery,
): Promise<readonly StatisticsDimensionValueDto[]> {
  return getWsClient().request<readonly StatisticsDimensionValueDto[]>('statistics.dimensions', { ...query });
}

export async function connectWithToken(token: string): Promise<void> {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  // Deliberately do NOT clear `authError` here. If the user re-pastes the
  // same bad token, clearing upfront blanks the banner for one tick and
  // then `handleAuthError()` sets it back — a visible flash. The banner
  // is cleared on successful connection in `onConnectionChange(true)`.
  const client = getWsClient();
  await startConnectionWithToken(client, token);
}

/**
 * Shared entry point for starting a connection with a token: runs the
 * HTTP preflight so the UI can distinguish an invalid token from an
 * unreachable daemon, then kicks off the WS client. The client's
 * reconnect loop will preflight again on each retry.
 */
async function startConnectionWithToken(client: WsClient, token: string): Promise<void> {
  const result = await verifyAuthToken(token);
  if (result === 'invalid') {
    handleAuthError();
    return;
  }
  // 'ok' or 'offline' — in both cases we're committing to the token and
  // want the UI past the login gate. On 'offline' the WS client will
  // enter the reconnect loop and preflight again each time.
  appState.hasToken = true;
  client.connect(buildWsUrl(), token);
}

export async function getWorkflowBudgetPreview(definitionPath: string): Promise<WorkflowBudgetDto> {
  return getWsClient().request<WorkflowBudgetDto>('workflows.getBudgetPreview', { definitionPath });
}

export async function getWorkflowBudget(workflowId: string): Promise<WorkflowBudgetDto> {
  return getWsClient().request<WorkflowBudgetDto>('workflows.getBudget', { workflowId });
}

export async function getResourceBudget(): Promise<ResourceBudgetConfigDto> {
  return getWsClient().request<ResourceBudgetConfigDto>('config.getResourceBudget', {});
}

export async function setResourceBudget(budget: ResourceBudgetConfigDto): Promise<ResourceBudgetConfigDto> {
  return getWsClient().request<ResourceBudgetConfigDto>('config.setResourceBudget', { ...budget });
}
