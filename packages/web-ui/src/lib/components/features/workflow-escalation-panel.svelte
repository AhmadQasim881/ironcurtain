<script lang="ts">
  /**
   * Tool calls that policy escalated inside a workflow agent state and that
   * wait for a human. The agent is blocked inside each call until it is
   * approved, denied, or expires at the escalation timeout (it then
   * disappears from the list).
   *
   * An approval surface like the session escalation cards, with the same
   * safeguards (see escalation-card.svelte and the Escalations page):
   *   - every agent-influenced string goes through SafeText, which shows
   *     invisible and direction-changing characters as visible escapes;
   *   - a card takes Approve, Deny and whitelist clicks only once it has
   *     been in its place in the list for ESCALATION_ARM_DELAY_MS. Resolving
   *     a card moves the ones below it up under the pointer, so the second
   *     click of a double click would otherwise decide a call the user has
   *     not looked at; a card that just appeared waits too.
   */
  import { untrack } from 'svelte';
  import type { WorkflowEscalationDto } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';
  import { hasInvisibleCodePoints } from '$lib/unicode-display.js';
  import { ESCALATION_ARM_DELAY_MS } from './escalation-modal.svelte';
  import EscalationReviewContext from './escalation-review-context.svelte';
  import { isApprovableEscalation } from '$lib/escalation-approval.js';

  let {
    escalations,
    busyId = null,
    onresolve,
  }: {
    escalations: readonly WorkflowEscalationDto[];
    /** Escalation whose resolution is in flight; its buttons are disabled. */
    busyId?: string | null;
    onresolve: (
      escalation: WorkflowEscalationDto,
      decision: 'approved' | 'denied',
      whitelistSelection?: number,
    ) => void;
  } = $props();

  let selectedWhitelist = $state<Record<string, number | undefined>>({});

  const placeOf = (escalationId: string, index: number): string => `${index}:${escalationId}`;
  let settledPlaces = $state<ReadonlySet<string>>(new Set());

  $effect(() => {
    const places = new Set(escalations.map((escalation, index) => placeOf(escalation.escalationId, index)));
    settledPlaces = new Set([...untrack(() => settledPlaces)].filter((place) => places.has(place)));
    const timer = setTimeout(() => {
      settledPlaces = places;
    }, ESCALATION_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  });

  function isArmed(escalationId: string, index: number): boolean {
    return settledPlaces.has(placeOf(escalationId, index));
  }

  function toggleWhitelist(escalationId: string, index: number, armed: boolean): void {
    if (!armed) return;
    selectedWhitelist = {
      ...selectedWhitelist,
      [escalationId]: selectedWhitelist[escalationId] === index ? undefined : index,
    };
  }

  function resolve(escalation: WorkflowEscalationDto, decision: 'approved' | 'denied', armed: boolean): void {
    if (!armed) return;
    if (decision === 'approved' && !isApprovableEscalation(escalation)) return;
    // A human-only escalation is approved once and never whitelisted; it
    // offers no candidates, and none is sent for it even if one was selected.
    const whitelistSelection =
      decision === 'approved' && escalation.humanOnly !== true ? selectedWhitelist[escalation.escalationId] : undefined;
    if (decision === 'approved') onresolve(escalation, decision, whitelistSelection);
    else onresolve(escalation, decision);
  }

  function containsInvisibleCharacters(escalation: WorkflowEscalationDto): boolean {
    return hasInvisibleCodePoints([
      escalation.serverName,
      escalation.toolName,
      escalation.stateId,
      escalation.persona ?? null,
      escalation.reason,
      escalation.arguments,
      (escalation.whitelistCandidates ?? []).map((candidate) => candidate.description),
      escalation.agentJustification ?? null,
    ]);
  }

  const UNARMED_TITLE = 'Enabled a moment after the request is shown here';
</script>

<div class="space-y-3" data-testid="workflow-escalation-panel">
  {#each escalations as escalation, index (escalation.escalationId)}
    {@const busy = busyId === escalation.escalationId}
    {@const armed = isArmed(escalation.escalationId, index)}
    <Card class="overflow-hidden border-warning/40 shadow-sm" data-testid="workflow-escalation">
      <div class="px-5 py-4 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="text-[11px] font-medium text-warning uppercase tracking-wider mb-1">
            Tool call awaiting approval
          </div>
          <div class="font-mono font-semibold text-sm bidi-safe">
            <SafeText text={escalation.serverName} /><span class="text-muted-foreground">/</span><SafeText
              text={escalation.toolName}
            />
          </div>
          <div class="mt-1 text-xs text-muted-foreground">
            state <span class="font-mono bidi-safe"><SafeText text={escalation.stateId} /></span>
            {#if escalation.persona}
              &middot; persona <span class="font-mono bidi-safe"><SafeText text={escalation.persona} /></span>
            {/if}
            &middot; {new Date(escalation.receivedAt).toLocaleTimeString()}
          </div>
        </div>
        <div class="flex gap-2 shrink-0">
          <Button
            variant="success"
            size="sm"
            disabled={busy || !isApprovableEscalation(escalation)}
            aria-disabled={armed ? undefined : 'true'}
            class={armed ? undefined : 'opacity-60 cursor-not-allowed'}
            title={armed ? undefined : UNARMED_TITLE}
            data-testid="workflow-escalation-approve"
            onclick={() => resolve(escalation, 'approved', armed)}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            aria-disabled={armed ? undefined : 'true'}
            class={armed ? undefined : 'opacity-60 cursor-not-allowed'}
            title={armed ? undefined : UNARMED_TITLE}
            data-testid="workflow-escalation-deny"
            onclick={() => resolve(escalation, 'denied', armed)}
          >
            Deny
          </Button>
        </div>
      </div>

      <div class="px-5 pb-4 space-y-3">
        {#if containsInvisibleCharacters(escalation)}
          <div
            role="note"
            data-testid="invisible-char-warning"
            class="text-xs rounded-lg px-3 py-2 bg-warning/15 border border-warning/40 text-foreground/90"
          >
            This request contains invisible or direction-changing characters (bidi controls, zero-width or control
            characters, variation selectors). They are shown below as highlighted <code class="font-mono">\u</code> escapes
            so the text reads as it really is.
          </div>
        {/if}
        {#if escalation.humanOnly}
          <div
            role="note"
            data-testid="human-only-note"
            class="text-xs rounded-lg px-3 py-2 bg-muted/40 border border-border text-foreground/90"
          >
            Human decision required: this call is approved once and is never whitelisted.
          </div>
        {/if}
        <EscalationReviewContext context={escalation} />
        <div>
          <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Reason</div>
          <div class="text-sm bg-muted/40 rounded-lg px-3 py-2.5 text-foreground/90 whitespace-pre-wrap bidi-safe">
            <SafeText text={escalation.reason} multiline />
          </div>
        </div>
        <div>
          <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Arguments</div>
          <!-- Wrapped, never scrolled sideways: nothing can hide past the right edge. -->
          <pre
            data-testid="workflow-escalation-arguments"
            class="bidi-safe text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-y-auto max-h-48 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80"><SafeText
              text={JSON.stringify(escalation.arguments, null, 2) ?? 'undefined'}
              multiline
            /></pre>
        </div>
        {#if !escalation.humanOnly && escalation.whitelistCandidates && escalation.whitelistCandidates.length > 0}
          <div>
            <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              Whitelist matching calls until the persona changes or the session ends (optional)
            </div>
            <div class="space-y-1.5">
              {#each escalation.whitelistCandidates as candidate, idx (idx)}
                {@const isSelected = selectedWhitelist[escalation.escalationId] === idx}
                <button
                  type="button"
                  onclick={() => toggleWhitelist(escalation.escalationId, idx, armed)}
                  disabled={busy}
                  aria-disabled={armed ? undefined : 'true'}
                  aria-pressed={isSelected}
                  title={armed ? undefined : UNARMED_TITLE}
                  data-testid="workflow-whitelist-candidate"
                  class="w-full text-left px-3 py-2 rounded-lg text-xs transition-colors bidi-safe
                    {isSelected
                    ? 'bg-primary/15 border border-primary/40 text-foreground'
                    : 'bg-muted/40 border border-transparent hover:bg-muted/60 text-foreground/80'}
                    {armed ? '' : 'cursor-not-allowed'}
                    disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <SafeText text={candidate.description} />
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </Card>
  {/each}
</div>
