<script lang="ts">
  import { tick } from 'svelte';
  import {
    appState,
    createSession,
    endSession,
    listPersonas,
    attachPty,
    detachPty,
    sendPtyInput,
    sendPtyResize,
    sendPtyPrompt,
    registerPtySink,
    unregisterPtySink,
    connectPtyTerminal,
    disconnectPtyTerminal,
    getModelProviders,
    listResumableSessions,
    resumeSession,
    loadSessionNotices,
    dismissSessionNotice,
  } from '../lib/stores.svelte.js';
  import type { CreateSessionOptions, ResumableSessionDto } from '../lib/types.js';

  import SessionSidebar from '$lib/components/features/session-sidebar.svelte';
  import TerminalConsole from '$lib/components/features/terminal-console.svelte';
  import ResumeSessionModal from '$lib/components/features/resume-session-modal.svelte';
  import SessionNotices from '$lib/components/features/session-notices.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Input } from '$lib/components/ui/input/index.js';

  // Bound TerminalConsole instance for the selected web-pty session.
  let terminalRef = $state<TerminalConsole | undefined>(undefined);

  // Session creation state
  let creatingSession = $state(false);
  let createError = $state('');

  let resumeModalOpen = $state(false);
  let resumableSessions = $state<ResumableSessionDto[]>([]);
  let loadingResumable = $state(false);
  let resumeLoadError = $state('');
  let resumeActionError = $state('');
  let resumingId = $state<string | null>(null);
  let resumeLoadGeneration = 0;

  const resumeDisabledReason = $derived(
    !appState.connected
      ? 'Connect to the daemon to resume a session.'
      : !appState.daemonStatus
        ? 'Daemon status is not available yet. Wait for the daemon connection to finish.'
        : appState.daemonStatus.sessionMode === undefined
          ? 'Session resume requires daemon session-mode support. Upgrade or restart the daemon, then refresh this page.'
          : appState.daemonStatus.sessionMode !== 'container'
            ? 'Session resume requires container mode.'
            : undefined,
  );

  async function loadResumable(): Promise<void> {
    const generation = ++resumeLoadGeneration;
    loadingResumable = true;
    resumeLoadError = '';
    resumeActionError = '';
    try {
      const sessions = await listResumableSessions();
      if (generation === resumeLoadGeneration && resumeModalOpen) resumableSessions = sessions;
    } catch (err) {
      if (generation === resumeLoadGeneration && resumeModalOpen) {
        resumeLoadError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (generation === resumeLoadGeneration && resumeModalOpen) loadingResumable = false;
    }
  }

  function openResumeModal(): void {
    if (resumeDisabledReason) return;
    resumeModalOpen = true;
    resumableSessions = [];
    resumeActionError = '';
    void loadResumable();
  }

  function closeResumeModal(): void {
    if (resumingId !== null) return;
    resumeModalOpen = false;
    resumeLoadGeneration++;
  }

  async function handleResume(sessionId: string): Promise<void> {
    if (resumingId !== null) return;
    resumingId = sessionId;
    resumeActionError = '';
    try {
      const result = await resumeSession(sessionId);
      appState.selectedSessionLabel = result.label;
      resumeModalOpen = false;
      resumeLoadGeneration++;
    } catch (err) {
      resumeActionError = err instanceof Error ? err.message : String(err);
    } finally {
      resumingId = null;
    }
  }

  // Session end state
  let endingSession = $state<number | null>(null);

  // Trusted-message bar state (web-pty sessions). A prompt is PLAIN text sent
  // via `sessions.ptyPrompt`; the daemon records it as trusted user-context
  // (authorizing auto-approval) — distinct from raw keystrokes, which are never
  // trusted. This is the only browser path to auto-approval.
  let promptText = $state('');
  let promptError = $state('');
  let sendingPrompt = $state(false);

  async function handleSendPrompt(): Promise<void> {
    const label = selectedPtyLabel;
    if (label === null) return;
    const text = promptText.trim();
    if (!text) return;
    sendingPrompt = true;
    promptError = '';
    try {
      await sendPtyPrompt(label, text);
      promptText = '';
    } catch (err) {
      promptError = err instanceof Error ? err.message : String(err);
    } finally {
      sendingPrompt = false;
    }
  }

  async function loadProviderProfiles(): Promise<string[]> {
    const providers = await getModelProviders();
    // The reserved 'native' profile is default routing; the dropdown's empty
    // "Default" option already covers it (omitting providerProfileName), so it
    // is not listed as an explicit choice.
    return Object.keys(providers.profiles).filter((name) => name !== 'native');
  }

  async function handleCreate(opts: CreateSessionOptions): Promise<void> {
    if (creatingSession) return;

    if (!appState.daemonStatus) {
      createError = 'Daemon status is not available yet. Wait for the daemon connection to finish, then try again.';
      return;
    }

    if (appState.daemonStatus.sessionMode === undefined) {
      createError =
        'Web sessions require daemon session-mode support. Upgrade or restart the daemon, then refresh this page.';
      return;
    }

    if (appState.daemonStatus.sessionMode !== 'container') {
      createError = 'Web sessions require container mode. Restart the daemon with container mode enabled.';
      return;
    }
    creatingSession = true;
    createError = '';
    try {
      const result = await createSession(opts);
      appState.selectedSessionLabel = result.label;
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creatingSession = false;
    }
  }

  async function handleEnd(): Promise<void> {
    const label = appState.selectedSessionLabel;
    if (label === null) return;
    endingSession = label;
    try {
      await endSession(label);
    } catch (err) {
      console.error('Failed to end session:', err);
    } finally {
      endingSession = null;
    }
  }

  // The selected session's label iff it is a web-pty terminal, else null.
  // A primitive derived: it flips null -> N when a freshly created pty session
  // first lands in the map, but does NOT change on unrelated session updates
  // (budget/status), so the attach effect never churns attach/detach.
  const selectedPtyLabel = $derived(
    appState.selectedSession?.source.kind === 'web-pty' ? appState.selectedSession.label : null,
  );

  // Reattach state for the selected terminal. `ptyDetached` flips on when the
  // WebSocket drops while a terminal is on screen and off once the terminal has
  // re-attached over the new connection; `ptyAttachError` carries a failed
  // (re)attach. Both drive the banner above the terminal.
  let ptyDetached = $state(false);
  let ptyAttachError = $state('');

  // PTY sink lifecycle, per label. Register the buffering sink BEFORE any
  // attach (the daemon sends a one-shot pty_replay on attach, which can beat the
  // terminal's mount): the sink buffers frames until the mounted TerminalConsole
  // connects its live handle via `onready`, so a replay is never dropped.
  // Detach + unregister on switch/unmount only -- deliberately NOT on reconnect,
  // so the mounted terminal keeps its live handle while the effect below
  // re-attaches (a fresh sink would never be connected again).
  $effect(() => {
    const label = selectedPtyLabel;
    if (label === null) return;

    registerPtySink(label);

    return () => {
      disconnectPtyTerminal(label);
      unregisterPtySink(label);
      detachPty(label).catch(() => {});
    };
  });

  // (Re)attach: once per label AND again after every reconnect. The daemon
  // drops this client's subscription the moment the socket closes (and arms the
  // idle reaper); without a fresh ptyAttach on the new socket the terminal
  // would stay frozen while keystrokes still reach the agent, and the session
  // would be reaped 30 minutes later. Keyed on the connection state itself
  // (not on `connectionGeneration`, which is bumped only when every RPC of the
  // reconnect's state refresh succeeds): each connect re-runs this effect once
  // and the replay snapshot repaints the terminal; while disconnected no
  // doomed attach is sent.
  $effect(() => {
    const label = selectedPtyLabel;
    const connected = appState.connected;
    if (label === null || !connected) return;

    // Idempotent; keeps register-before-attach true whatever the effect order.
    registerPtySink(label);
    let superseded = false;
    attachPty(label)
      .then(() => {
        if (superseded) return;
        ptyDetached = false;
        ptyAttachError = '';
      })
      .catch((err: unknown) => {
        if (superseded) return;
        ptyAttachError = err instanceof Error ? err.message : String(err);
        console.error('Failed to attach PTY:', err);
      });

    return () => {
      superseded = true;
    };
  });

  // The selected session's label unless it is a web-pty terminal (whose child
  // process prints its notices in the terminal), else null. A primitive, so
  // unrelated session updates (budget, status) do not refetch.
  const selectedNoticeLabel = $derived(
    appState.selectedSession && appState.selectedSession.source.kind !== 'web-pty'
      ? appState.selectedSession.label
      : null,
  );
  // When that session was created: after a daemon restart the same label can
  // name another session, whose notices must be read anew.
  const selectedNoticeCreatedAt = $derived(
    selectedNoticeLabel === null ? null : (appState.selectedSession?.createdAt ?? null),
  );

  // Session notices (a stale policy, an MCP server that did not start,
  // host-model fallbacks, annotation drift, host-mount findings): the ones the
  // session reported before this view watched it come from its diagnostic log,
  // read when it is selected, again after a reconnect and when its label comes
  // to name another session; later ones arrive as `session.diagnostic` events.
  $effect(() => {
    const label = selectedNoticeLabel;
    const connected = appState.connected;
    void selectedNoticeCreatedAt;
    if (label === null || !connected) return;
    loadSessionNotices(label).catch((err: unknown) => {
      console.error('Failed to load session notices:', err);
    });
  });

  // A dropped connection detaches the terminal server-side; remember it until
  // the re-attach above has completed so the banner can say so.
  $effect(() => {
    if (!appState.connected && selectedPtyLabel !== null) ptyDetached = true;
  });

  // Return focus to the terminal after the escalation overlay is dismissed
  // (the modal, owned by App.svelte, takes no focus when it opens, but the
  // user may have clicked into it). `escalationDismissedAt` is bumped by App
  // on dismiss.
  $effect(() => {
    void appState.escalationDismissedAt;
    if (selectedPtyLabel === null) return;
    tick().then(() => terminalRef?.focus?.());
  });
</script>

<div class="flex h-full min-h-0 flex-col animate-fade-in md:flex-row">
  <SessionSidebar
    sessions={appState.sessions}
    selectedLabel={appState.selectedSessionLabel}
    onselect={(label) => (appState.selectedSessionLabel = label)}
    oncreate={handleCreate}
    creating={creatingSession}
    {createError}
    loadPersonasFn={listPersonas}
    loadProviderProfilesFn={loadProviderProfiles}
    onresumeopen={openResumeModal}
    {resumeDisabledReason}
  />

  <ResumeSessionModal
    open={resumeModalOpen}
    sessions={resumableSessions}
    loading={loadingResumable}
    loadError={resumeLoadError}
    actionError={resumeActionError}
    {resumingId}
    onclose={closeResumeModal}
    onretry={loadResumable}
    onresume={handleResume}
  />

  {#if appState.selectedSession}
    {#if appState.selectedSession.source.kind === 'web-pty'}
      {@const ptySession = appState.selectedSession}
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div class="px-6 py-3 border-b border-border flex items-center justify-between bg-card/50">
          <div class="flex items-center gap-2">
            <span class="font-mono font-semibold">#{ptySession.label}</span>
            {#if ptySession.persona}
              <Badge variant="default">{ptySession.persona}</Badge>
            {/if}
            <Badge variant="secondary">terminal</Badge>
          </div>
          <div class="flex items-center gap-4">
            {#if ptySession.status === 'stopping'}
              <span
                id="pty-stopping-message"
                class="inline-flex max-w-xs items-center gap-1.5 text-right text-xs text-warning"
                role="status"
                aria-live="polite"
                aria-label="Stopping. Input is unavailable while shutdown completes."
              >
                <span
                  class="h-3 w-3 shrink-0 rounded-full border-2 border-warning/30 border-t-warning animate-spin"
                  aria-hidden="true"
                ></span>
                Stopping… Input is unavailable while shutdown completes.
              </span>
            {/if}
            <span class="text-xs text-muted-foreground hidden sm:inline">Resizing affects all viewers</span>
            <Button
              variant="destructive"
              size="sm"
              loading={ptySession.status === 'stopping' || endingSession === ptySession.label}
              disabled={ptySession.status === 'stopping'}
              aria-describedby={ptySession.status === 'stopping' ? 'pty-stopping-message' : undefined}
              onclick={handleEnd}
            >
              {ptySession.status === 'stopping' ? 'Stopping…' : endingSession === ptySession.label ? 'Ending' : 'End'}
            </Button>
          </div>
        </div>

        <SessionNotices
          notices={appState.sessionNotices.get(ptySession.label) ?? []}
          ondismiss={(key) => dismissSessionNotice(ptySession.label, key)}
        />

        <!-- OS-sandbox warning: MCP servers that asked for an OS sandbox the
             daemon host cannot provide (refused under "enforce", unconfined
             under "warn"). Computed by the daemon at create; absent when every
             such server is sandboxed. -->
        {#if ptySession.osSandboxWarning}
          <div
            class="px-6 py-2 border-b border-border bg-warning/10 text-xs text-warning"
            role="alert"
            data-testid="pty-os-sandbox-warning"
          >
            {ptySession.osSandboxWarning}
          </div>
        {/if}

        <!-- Detached/reattaching banner: the daemon drops this client's terminal
             subscription when the WebSocket closes; the attach effect re-sends
             ptyAttach on the new connection and clears this once it succeeds. -->
        {#if !appState.connected || ptyDetached}
          <div
            class="px-6 py-2 border-b border-border bg-warning/10 text-xs text-warning"
            role="status"
            aria-live="polite"
            data-testid="pty-reattach-banner"
          >
            {#if !appState.connected}
              Connection to the daemon lost — the terminal is detached. It will reattach automatically when the
              connection returns.
            {:else if ptyAttachError}
              Reconnected, but reattaching the terminal failed: {ptyAttachError}
            {:else}
              Reconnected — reattaching the terminal…
            {/if}
          </div>
        {/if}

        <!-- Remount a fresh terminal per label so switching PTY sessions never
             leaks buffer state from the previous one. -->
        {#key ptySession.label}
          <TerminalConsole
            bind:this={terminalRef}
            onready={(handle) => {
              connectPtyTerminal(ptySession.label, handle);
              terminalRef?.focus?.();
            }}
            oninput={(dataB64) => {
              if (ptySession.status !== 'stopping') sendPtyInput(ptySession.label, dataB64);
            }}
            onresize={(cols, rows) => sendPtyResize(ptySession.label, cols, rows)}
          />
        {/key}

        <!-- Trusted-message bar: docked below the terminal, subordinate to it.
             Plain text (NOT keystrokes) sent via `sessions.ptyPrompt` — the daemon
             records it as trusted user-context (authorizes auto-approval). -->
        <div class="px-4 py-3 border-t border-border bg-card/50 shrink-0">
          <form
            class="flex items-center gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              handleSendPrompt();
            }}
          >
            <Input
              data-testid="pty-prompt-input"
              bind:value={promptText}
              placeholder="Send a trusted message..."
              class="flex-1 py-1.5"
              disabled={ptySession.status !== 'ready' || sendingPrompt}
            />
            <Button
              type="submit"
              data-testid="pty-prompt-send"
              size="sm"
              loading={sendingPrompt}
              disabled={!promptText.trim() || ptySession.status !== 'ready'}
            >
              Send
            </Button>
          </form>
          <div class="mt-1 text-xs text-muted-foreground">Trusted message — authorizes auto-approval</div>
          {#if promptError}
            <div class="mt-1 text-xs text-destructive" data-testid="pty-prompt-error">{promptError}</div>
          {/if}
        </div>
      </div>
    {:else}
      {@const session = appState.selectedSession}
      <div class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <!-- What the session reported for the user, though the web UI cannot
             show the session itself. -->
        <SessionNotices
          notices={appState.sessionNotices.get(session.label) ?? []}
          ondismiss={(key) => dismissSessionNotice(session.label, key)}
        />
        <div class="flex-1 flex items-center justify-center text-muted-foreground">
          <div class="max-w-sm text-center px-6">
            <div class="text-sm font-semibold text-foreground mb-1">Unsupported session type</div>
            <div class="text-sm">
              Session <span class="font-mono">#{session.label}</span> is
              <span class="font-mono">{session.source.kind}</span>. The web UI only supports container terminal
              sessions.
            </div>
            <Button
              variant="outline"
              size="sm"
              class="mt-4"
              loading={endingSession === session.label}
              onclick={handleEnd}
            >
              {endingSession === session.label ? 'Ending' : 'End session'}
            </Button>
          </div>
        </div>
      </div>
    {/if}
  {:else}
    <div class="flex-1 flex items-center justify-center text-muted-foreground">
      <div class="text-center">
        <p class="text-lg mb-2">No session selected</p>
        <p class="text-sm">Select a session from the list or create a new one.</p>
      </div>
    </div>
  {/if}
</div>
