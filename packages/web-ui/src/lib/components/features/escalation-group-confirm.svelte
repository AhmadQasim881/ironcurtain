<script lang="ts">
  /**
   * Confirmation for "approve group": lists every escalation of one
   * whitelist-pattern group -- session, tool, arguments, reason and the
   * reviewer context -- before any of them is approved.
   *
   *   - `reviewed` is the group as it was when the user opened this dialog;
   *     Approve sends exactly those ids, and the daemon refuses
   *     (ESCALATION_GROUP_CHANGED) unless they are still exactly the group.
   *   - `current` is the group now. When it differs from `reviewed` (a member
   *     arrived, expired or was resolved), Approve is disabled and the dialog
   *     says to review the group again.
   *   - Approve acts only once the list has been on screen for
   *     ESCALATION_ARM_DELAY_MS, on a press that began after that, so the
   *     second click of a double click on "Review group" cannot approve.
   *
   * Every agent-influenced string goes through SafeText.
   */
  import type { PendingEscalation } from '../../types.js';
  import { Modal } from '$lib/components/ui/modal/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';
  import { sameEscalationIds } from '$lib/escalation-groups.js';
  import { isApprovableEscalation } from '$lib/escalation-approval.js';
  import { ESCALATION_ARM_DELAY_MS } from './escalation-modal.svelte';
  import EscalationReviewContext from './escalation-review-context.svelte';

  let {
    open,
    description,
    reviewed,
    current,
    busy = false,
    onconfirm,
    onclose,
  }: {
    open: boolean;
    /** The shared whitelist pattern's description. */
    description: string;
    /** The members listed: what Approve approves. */
    reviewed: readonly PendingEscalation[];
    /** The group's members now. */
    current: readonly PendingEscalation[];
    busy?: boolean;
    onconfirm: () => void;
    onclose: () => void;
  } = $props();

  let changed = $derived(
    !sameEscalationIds(
      reviewed.map((esc) => esc.escalationId),
      current.map((esc) => esc.escalationId),
    ),
  );

  let armed = $state(false);
  let pressBeganUnarmed = false;
  let dialog = $state<HTMLDivElement | undefined>(undefined);

  // The delay restarts whenever the dialog opens on a list.
  $effect(() => {
    void reviewed;
    armed = false;
    if (!open) return;
    const timer = setTimeout(() => {
      armed = true;
    }, ESCALATION_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const element = dialog;
    if (!element) return;
    const onPointerDown = (): void => {
      pressBeganUnarmed = !armed;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      pressBeganUnarmed = !armed || e.repeat;
    };
    element.addEventListener('pointerdown', onPointerDown, true);
    element.addEventListener('keydown', onKeyDown, true);
    return () => {
      element.removeEventListener('pointerdown', onPointerDown, true);
      element.removeEventListener('keydown', onKeyDown, true);
    };
  });

  let canApprove = $derived(
    open && armed && !changed && !busy && reviewed.length > 0 && reviewed.every(isApprovableEscalation),
  );

  function confirm(): void {
    if (!canApprove || pressBeganUnarmed) return;
    onconfirm();
  }

  function argumentsText(esc: PendingEscalation): string {
    return JSON.stringify(esc.arguments, null, 2) ?? 'undefined';
  }
</script>

<Modal {open} {onclose} title="Approve this group of escalations?" bind:dialog>
  <div class="contents" data-testid="escalation-group-confirm" data-armed={armed ? 'true' : 'false'}>
    <div class="px-5 pt-3 space-y-2">
      <p class="text-sm">
        Each of these {reviewed.length} calls will be approved once. Nothing is whitelisted.
      </p>
      <div class="text-xs bg-primary/10 border border-primary/30 rounded-lg px-3 py-2 bidi-safe">
        <span class="text-muted-foreground">Every call matches:</span>
        <SafeText text={description} />
      </div>
      {#if changed}
        <div
          role="alert"
          data-testid="escalation-group-changed"
          class="text-xs rounded-lg px-3 py-2 bg-destructive/10 border border-destructive/30 text-destructive"
        >
          The group changed since this list was opened (an escalation arrived, expired or was resolved). Nothing will be
          approved from this list: close it and review the group again.
        </div>
      {/if}
    </div>

    <div class="max-h-[50vh] overflow-y-auto px-5 py-3 space-y-3">
      {#each reviewed as esc (esc.escalationId)}
        <div class="rounded-lg border border-border p-3 space-y-2" data-testid="escalation-group-member">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-mono text-muted-foreground">#{esc.sessionLabel}</span>
            <span class="font-mono font-semibold bidi-safe"
              ><SafeText text={esc.serverName} /><span class="text-muted-foreground">/</span><SafeText
                text={esc.toolName}
              /></span
            >
          </div>
          <pre
            class="bidi-safe text-xs font-mono bg-muted/40 rounded-lg px-3 py-2 overflow-y-auto max-h-32 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80"><SafeText
              text={argumentsText(esc)}
              multiline
            /></pre>
          <div class="text-xs text-foreground/80 bidi-safe">
            <span class="text-muted-foreground">Reason:</span>
            <SafeText text={esc.reason} />
          </div>
          <EscalationReviewContext context={esc} />
        </div>
      {/each}
    </div>

    <div class="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
      <span class="mr-auto text-[10px] text-muted-foreground" data-testid="escalation-group-arming"
        >{armed ? 'Approve enabled' : 'Approve enabled in a moment'}</span
      >
      <Button variant="outline" size="sm" onclick={onclose} data-testid="escalation-group-cancel">Cancel</Button>
      <Button
        variant="success"
        size="sm"
        loading={busy}
        aria-disabled={canApprove ? undefined : 'true'}
        class={canApprove ? undefined : 'opacity-60 cursor-not-allowed'}
        data-testid="escalation-group-approve"
        onclick={confirm}
      >
        {#if !busy}Approve {reviewed.length}{/if}
      </Button>
    </div>
  </div>
</Modal>
