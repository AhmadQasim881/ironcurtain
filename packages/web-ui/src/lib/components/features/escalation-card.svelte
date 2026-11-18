<script module lang="ts">
  /** Lines of text-xs that fit in the argument box (max-h-48) before it scrolls. */
  const VISIBLE_ARGUMENT_LINES = 10;
  /** Lines that fit in the context box (max-h-32). */
  const VISIBLE_CONTEXT_LINES = 6;
  /** Conservative characters per wrapped line in the modal's argument box. */
  const CHARS_PER_LINE = 80;

  /**
   * Whether `text`, wrapped as the argument boxes wrap it, needs more than
   * `visibleLines` lines, i.e. part of it is only reachable by scrolling.
   */
  function exceedsVisibleLines(text: string, visibleLines: number): boolean {
    let lines = 0;
    for (const line of text.split('\n')) {
      lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
      if (lines > visibleLines) return true;
    }
    return false;
  }
</script>

<script lang="ts">
  import type { EscalationDto } from '../../types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';
  import { hasInvisibleCodePoints } from '$lib/unicode-display.js';
  import { isApprovableEscalation, NOT_APPROVABLE_REASON } from '$lib/escalation-approval.js';
  import EscalationReviewContext from './escalation-review-context.svelte';

  let {
    escalation,
    loading = false,
    armed = true,
    onapprove,
    ondeny,
    onviewsession,
  }: {
    escalation: EscalationDto;
    loading?: boolean;
    /**
     * When false, Approve, Deny and the whitelist choices are shown but inert:
     * clicks on them are ignored. The escalation modal, which opens on its
     * own, keeps them unarmed for a short delay after an escalation appears
     * (see escalation-modal.svelte); the Escalations page does the same for a
     * card that has just appeared or moved up in the list. Defaults to true.
     */
    armed?: boolean;
    onapprove: (whitelistSelection?: number) => void;
    ondeny: () => void;
    onviewsession?: (label: number) => void;
  } = $props();

  let selectedWhitelist = $state<number | undefined>(undefined);

  // A request that does not say which tool and arguments it is about can be
  // denied, never approved (approving it would approve an unknown call).
  let approvable = $derived(isApprovableEscalation(escalation));

  // Every agent-influenced string on this card goes through SafeText, which
  // shows invisible and direction-changing characters as visible escapes.
  let argumentsText = $derived(JSON.stringify(escalation.arguments, null, 2) ?? 'undefined');
  let argumentsOverflow = $derived(exceedsVisibleLines(argumentsText, VISIBLE_ARGUMENT_LINES));
  let contextText = $derived(escalation.context ? JSON.stringify(escalation.context, null, 2) : '');
  let contextOverflow = $derived(exceedsVisibleLines(contextText, VISIBLE_CONTEXT_LINES));
  let containsInvisibleCharacters = $derived(
    hasInvisibleCodePoints([
      escalation.serverName,
      escalation.toolName,
      escalation.reason,
      escalation.arguments,
      escalation.context ?? null,
      (escalation.whitelistCandidates ?? []).map((candidate) => candidate.description),
      escalation.agentJustification ?? null,
    ]),
  );

  function toggleWhitelist(index: number): void {
    if (!armed || !approvable) return;
    selectedWhitelist = selectedWhitelist === index ? undefined : index;
  }

  function handleApprove(): void {
    if (!armed || !approvable) return;
    onapprove(selectedWhitelist);
  }

  function handleDeny(): void {
    if (!armed) return;
    ondeny();
  }

  const UNARMED_TITLE = 'Enabled a moment after the request is shown here';
</script>

<Card
  class="overflow-hidden transition-all animate-fade-in
  {loading ? 'opacity-50 border-border' : 'border-destructive/20 shadow-sm shadow-destructive/5'}"
>
  <div class="px-5 py-4 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-mono font-semibold text-sm bidi-safe"
          ><SafeText text={escalation.serverName} /><span class="text-muted-foreground">/</span><SafeText
            text={escalation.toolName}
          /></span
        >
      </div>
      <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <Badge variant="secondary" class="font-mono">#{escalation.sessionLabel}</Badge>
        <span>{escalation.sessionSource.kind}</span>
        {#if escalation.sessionSource.kind === 'cron' && escalation.sessionSource.jobName}
          <span class="bidi-safe" data-testid="escalation-job-name"
            ><SafeText text={escalation.sessionSource.jobName} /></span
          >
        {/if}
        <span>&middot;</span>
        <span>{new Date(escalation.receivedAt).toLocaleTimeString()}</span>
        {#if onviewsession}
          <span>&middot;</span>
          <button class="text-primary hover:underline" onclick={() => onviewsession(escalation.sessionLabel)}>
            View Session
          </button>
        {/if}
      </div>
    </div>
    <div class="flex gap-2 shrink-0">
      <Button
        variant="success"
        size="sm"
        {loading}
        disabled={!approvable}
        aria-disabled={armed && approvable ? undefined : 'true'}
        class={armed && approvable ? undefined : 'opacity-60 cursor-not-allowed'}
        title={!approvable ? NOT_APPROVABLE_REASON : armed ? undefined : UNARMED_TITLE}
        data-testid="escalation-approve"
        onclick={handleApprove}
      >
        {#if !loading}Approve{/if}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        {loading}
        aria-disabled={armed ? undefined : 'true'}
        class={armed ? undefined : 'opacity-60 cursor-not-allowed'}
        title={armed ? undefined : UNARMED_TITLE}
        data-testid="escalation-deny"
        onclick={handleDeny}
      >
        {#if !loading}Deny{/if}
      </Button>
    </div>
  </div>

  <div class="px-5 pb-4 space-y-3">
    {#if !approvable}
      <div
        role="note"
        data-testid="escalation-not-approvable"
        class="text-xs rounded-lg px-3 py-2 bg-destructive/10 border border-destructive/30 text-foreground/90"
      >
        {NOT_APPROVABLE_REASON}
      </div>
    {/if}

    {#if containsInvisibleCharacters}
      <div
        role="note"
        data-testid="invisible-char-warning"
        class="text-xs rounded-lg px-3 py-2 bg-warning/15 border border-warning/40 text-foreground/90"
      >
        This request contains invisible or direction-changing characters (bidi controls, zero-width or control
        characters, variation selectors). They are shown below as highlighted <code class="font-mono">\u</code> escapes so
        the text reads as it really is.
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
      <div class="flex items-baseline justify-between gap-3 mb-1.5">
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Arguments</div>
        {#if argumentsOverflow}
          <span class="text-[10px] text-warning" data-testid="arguments-overflow"
            >Long arguments &mdash; scroll to see all of them</span
          >
        {/if}
      </div>
      <!-- Wrapped, never scrolled sideways: nothing can hide past the right edge. -->
      <pre
        data-testid="escalation-arguments"
        class="bidi-safe text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-y-auto max-h-48 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80"><SafeText
          text={argumentsText}
          multiline
        /></pre>
      <p class="text-[10px] text-muted-foreground/60 mt-1">
        Path and URL arguments are shown as the policy engine evaluated them, which is also what the tool receives:
        relative paths resolved against the sandbox, <code class="font-mono">..</code> and symlinks resolved, URLs normalized.
      </p>
    </div>

    {#if escalation.context && Object.keys(escalation.context).length > 0}
      <div>
        <div class="flex items-baseline justify-between gap-3 mb-1.5">
          <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Context</div>
          {#if contextOverflow}
            <span class="text-[10px] text-warning" data-testid="context-overflow"
              >Long context &mdash; scroll to see all of it</span
            >
          {/if}
        </div>
        <pre
          data-testid="escalation-context"
          class="bidi-safe text-xs font-mono bg-muted/40 rounded-lg px-3 py-2.5 overflow-y-auto max-h-32 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80"><SafeText
            text={contextText}
            multiline
          /></pre>
      </div>
    {/if}

    {#if escalation.whitelistCandidates && escalation.whitelistCandidates.length > 0}
      <div>
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
          Whitelist (optional)
        </div>
        <div class="space-y-1.5">
          {#each escalation.whitelistCandidates as candidate, idx (idx)}
            {@const isSelected = selectedWhitelist === idx}
            <button
              onclick={() => toggleWhitelist(idx)}
              disabled={loading || !approvable}
              aria-disabled={armed ? undefined : 'true'}
              aria-pressed={isSelected}
              title={armed ? undefined : UNARMED_TITLE}
              data-testid="whitelist-candidate"
              class="w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors
                {isSelected
                ? 'bg-primary/15 border border-primary/40 text-foreground'
                : 'bg-muted/40 border border-transparent hover:bg-muted/60 text-foreground/80'}
                {armed ? '' : 'cursor-not-allowed'}
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span
                class="shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center
                {isSelected ? 'border-primary' : 'border-muted-foreground/40'}"
              >
                {#if isSelected}
                  <span class="w-2 h-2 rounded-full bg-primary"></span>
                {/if}
              </span>
              <span class="text-xs bidi-safe"><SafeText text={candidate.description} /></span>
            </button>
          {/each}
        </div>
        <p class="text-[10px] text-muted-foreground/60 mt-1.5">
          Select a rule to auto-approve similar future requests.
        </p>
      </div>
    {/if}
  </div>
</Card>
