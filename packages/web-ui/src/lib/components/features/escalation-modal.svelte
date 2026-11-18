<script module lang="ts">
  /**
   * Arming delay. The modal opens on its own when an escalation arrives, so
   * input already in flight -- a click aimed at what the dialog now covers, a
   * second click or chord meant for the escalation that was just resolved --
   * must never decide the escalation on screen. Approve and Deny (buttons and
   * keyboard chords) act only once that escalation has been visible -- page
   * shown, window focused -- for this many milliseconds without a break, and
   * only on a press that began after that.
   */
  export const ESCALATION_ARM_DELAY_MS = 750;
</script>

<script lang="ts">
  import type { PendingEscalation } from '../../types.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';
  import { isApprovableEscalation } from '$lib/escalation-approval.js';
  import EscalationCard from './escalation-card.svelte';

  type Decision = 'approved' | 'denied';

  let {
    open,
    escalations,
    onclose,
    onresolve,
    onviewsession,
  }: {
    open: boolean;
    escalations: Map<string, PendingEscalation>;
    onclose: () => void;
    onresolve: (id: string, decision: Decision, whitelistSelection?: number) => Promise<void>;
    onviewsession: (label: number) => void;
  } = $props();

  let activeTabId = $state<string | null>(null);
  let resolvingIds = $state<Set<string>>(new Set());
  // Last failed approve/deny, shown inside the modal. A rejected resolve
  // (ESCALATION_EXPIRED, ESCALATION_NOT_FOUND, connection loss) used to
  // surface only as an unhandled promise rejection because the card calls
  // onapprove/ondeny without awaiting.
  let resolveError = $state('');

  // A failure belongs to the dialog session it happened in. The component
  // stays mounted while closed, so without this a later opening for a new,
  // unrelated escalation would show the old "Failed to approve" above it.
  $effect(() => {
    if (!open) resolveError = '';
  });

  // ── Arming ──────────────────────────────────────────────────────────────
  // The modal never takes focus (Modal focusOnOpen="none"): what the user is
  // typing keeps going to the terminal or input they were in, and no key
  // reaches the dialog until they click into it or Tab to it. Deciding is
  // therefore always an explicit act inside the dialog: a click on Approve
  // or Deny, or a Ctrl/Cmd chord once focus is inside. Bare letters do
  // nothing and key repeats never act.
  //
  // On top of that, both work only while the escalation on screen is
  // *armed*: it has been visible for ESCALATION_ARM_DELAY_MS. The delay
  // restarts whenever a different escalation is shown (modal opened,
  // previous one resolved, tab switched), so a double click or a repeated
  // chord cannot decide the escalation that just replaced the one the user
  // acted on. A click whose press began before arming does not count either.
  //
  // "Visible" means the user can be looking at it: while the page is hidden
  // (background tab) or the window is unfocused (another application in
  // front) the escalation is never armed, and the delay starts over when the
  // page becomes visible or the window regains focus. App.svelte flashes the
  // tab title to bring the user back, so the first click into the window or
  // tab must not decide an escalation that appeared while they were away.
  let armedId = $state<string | null>(null);
  let armed = $derived(open && activeTabId !== null && armedId === activeTabId);

  /**
   * Whether the latest press inside the dialog (a pointer press, or Enter or
   * Space, the keys that activate a focused button) began while unarmed or
   * was a key repeat. Recorded in the capture phase, before any handler runs,
   * and checked when the click it produces arrives, so a press held from the
   * arming delay into the armed state never decides.
   */
  let pressBeganUnarmed = false;

  /** Whether keyboard focus is inside the dialog, which the chords need. */
  let focusInside = $state(false);

  $effect(() => {
    const shownId = open ? activeTabId : null;
    armedId = null;
    pressBeganUnarmed = false;
    if (shownId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
      clearTimeout(timer);
      timer = undefined;
      armedId = null;
    };
    /** Disarm and start the full delay again, unless the page is hidden. */
    const restart = (): void => {
      disarm();
      if (document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        armedId = shownId;
      }, ESCALATION_ARM_DELAY_MS);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') disarm();
      else restart();
    };
    // Non-capturing listeners on window see only the window's own focus and
    // blur, not focus moving between elements of the page.
    window.addEventListener('focus', restart);
    window.addEventListener('blur', disarm);
    document.addEventListener('visibilitychange', onVisibilityChange);
    restart();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', restart);
      window.removeEventListener('blur', disarm);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  /** The Modal's `role="dialog"` element while open (bind:dialog). */
  let dialog = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    const element = dialog;
    if (!element) return;
    // pointerdown fires when a press really begins, for mouse, pen and touch.
    const onPointerDown = (): void => {
      pressBeganUnarmed = !armed;
    };
    // After a touch, browsers fire the compatibility mousedown when the finger
    // lifts, not when it lands, so mousedown may only mark a press as unarmed;
    // it never clears the mark pointerdown set when the press began.
    const onMouseDown = (): void => {
      if (!armed) pressBeganUnarmed = true;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      pressBeganUnarmed = !armed || e.repeat;
    };
    const onFocusIn = (): void => {
      focusInside = true;
    };
    const onFocusOut = (e: FocusEvent): void => {
      focusInside = e.relatedTarget instanceof Node && element.contains(e.relatedTarget);
    };
    element.addEventListener('pointerdown', onPointerDown, true);
    element.addEventListener('mousedown', onMouseDown, true);
    element.addEventListener('keydown', onKeyDown, true);
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    focusInside = element.contains(document.activeElement);
    return () => {
      element.removeEventListener('pointerdown', onPointerDown, true);
      element.removeEventListener('mousedown', onMouseDown, true);
      element.removeEventListener('keydown', onKeyDown, true);
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      focusInside = false;
    };
  });

  // Keep sorted by displayNumber so tabs are stable
  let sortedEscalations = $derived([...escalations.values()].sort((a, b) => a.displayNumber - b.displayNumber));

  // Auto-select first tab if active tab is gone (this restarts the arming delay)
  $effect(() => {
    if (sortedEscalations.length === 0) {
      activeTabId = null;
    } else if (activeTabId === null || !escalations.has(activeTabId)) {
      activeTabId = sortedEscalations[0].escalationId;
    }
  });

  let activeEscalation = $derived(activeTabId ? (escalations.get(activeTabId) ?? null) : null);

  async function handleResolve(id: string, decision: Decision, whitelistSelection?: number): Promise<void> {
    resolvingIds = new Set([...resolvingIds, id]);
    resolveError = '';
    try {
      await onresolve(id, decision, whitelistSelection);
    } catch (err) {
      resolveError = `Failed to ${decision === 'approved' ? 'approve' : 'deny'}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      const next = new Set(resolvingIds);
      next.delete(id);
      resolvingIds = next;
    }
  }

  /**
   * The single gate in front of every decision from this modal. `id` is the
   * escalation the acting control was rendered for; it must still be the one
   * on screen.
   */
  function decide(id: string, decision: Decision, whitelistSelection?: number): void {
    if (!armed || id !== activeTabId || resolvingIds.has(id)) return;
    // The approve chord must not get around the card's disabled Approve.
    const shown = escalations.get(id);
    if (decision === 'approved' && (!shown || !isApprovableEscalation(shown))) return;
    void handleResolve(id, decision, whitelistSelection);
  }

  /** Card buttons: a click acts only if its press began armed. */
  function decideByClick(id: string, decision: Decision, whitelistSelection?: number): void {
    if (pressBeganUnarmed) return;
    decide(id, decision, whitelistSelection);
  }

  /** Chords only: a bare letter typed into the terminal must never decide. */
  function chordDecision(e: KeyboardEvent): Decision | null {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
    if (e.key === 'Enter') return 'approved';
    if (e.key === 'Backspace') return 'denied';
    return null;
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Skip keyboard shortcuts when focus is in an input or textarea
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateTab(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateTab(1);
      return;
    }

    const decision = chordDecision(e);
    if (decision === null) return;
    e.preventDefault();
    if (e.repeat || activeTabId === null) return;
    decide(activeTabId, decision);
  }

  function navigateTab(direction: number): void {
    if (sortedEscalations.length <= 1) return;
    const currentIndex = sortedEscalations.findIndex((e) => e.escalationId === activeTabId);
    const nextIndex = (currentIndex + direction + sortedEscalations.length) % sortedEscalations.length;
    activeTabId = sortedEscalations[nextIndex].escalationId;
  }

  const modifierLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl';
</script>

<Modal {open} {onclose} title="Pending Escalations" onkeydown={handleKeydown} focusOnOpen="none" bind:dialog>
  <div class="contents" data-testid="escalation-dialog-body" data-armed={armed ? 'true' : 'false'}>
    <p class="sr-only" role="status">
      {sortedEscalations.length} pending {sortedEscalations.length === 1 ? 'escalation' : 'escalations'}.
      {armed ? 'Approve and Deny are enabled.' : 'Approve and Deny are enabled in a moment.'}
    </p>

    {#if sortedEscalations.length > 1}
      <div class="flex border-b border-border overflow-x-auto scroll-snap-x" role="tablist">
        {#each sortedEscalations as esc (esc.escalationId)}
          <button
            role="tab"
            aria-selected={esc.escalationId === activeTabId}
            onclick={() => (activeTabId = esc.escalationId)}
            class="shrink-0 scroll-snap-start px-4 py-2 text-xs font-mono border-b-2 transition-colors bidi-safe
              {esc.escalationId === activeTabId
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'}"
          >
            <SafeText text={esc.serverName} />/<SafeText text={esc.toolName} />
          </button>
        {/each}
      </div>
    {/if}

    {#if resolveError}
      <!-- The message comes from the daemon or the connection, but it can carry
           server-side text (ids, exception messages): shown like agent text. -->
      <div
        class="mx-5 mt-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive bidi-safe"
        role="alert"
        data-testid="escalation-resolve-error"
      >
        <SafeText text={resolveError} />
      </div>
    {/if}

    <div class="max-h-[60vh] overflow-y-auto">
      {#if activeEscalation}
        {@const shown = activeEscalation}
        {#key shown.escalationId}
          <EscalationCard
            escalation={shown}
            loading={resolvingIds.has(shown.escalationId)}
            {armed}
            onapprove={(whitelistSelection) => decideByClick(shown.escalationId, 'approved', whitelistSelection)}
            ondeny={() => decideByClick(shown.escalationId, 'denied')}
            onviewsession={(label) => {
              onclose();
              onviewsession(label);
            }}
          />
        {/key}
      {/if}
    </div>

    <div class="px-5 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center gap-4 flex-wrap">
      <span class={armed ? 'text-success font-medium' : 'font-medium'} data-testid="arming-status"
        >{armed ? 'Approve and Deny enabled' : 'Approve and Deny enabled in a moment'}</span
      >
      <span
        ><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">{modifierLabel}</kbd>+<kbd
          class="px-1 py-0.5 bg-muted rounded text-[10px]">Enter</kbd
        > approve</span
      >
      <span
        ><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">{modifierLabel}</kbd>+<kbd
          class="px-1 py-0.5 bg-muted rounded text-[10px]">Backspace</kbd
        > deny</span
      >
      {#if sortedEscalations.length > 1}
        <span
          ><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">&larr;</kbd><kbd
            class="px-1 py-0.5 bg-muted rounded text-[10px]">&rarr;</kbd
          > switch</span
        >
      {/if}
      <span><kbd class="px-1 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> dismiss</span>
      {#if !focusInside}
        <span data-testid="focus-hint">Click inside this dialog to use the keys.</span>
      {/if}
    </div>
  </div>
</Modal>
