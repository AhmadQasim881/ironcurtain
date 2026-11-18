<script lang="ts">
  /**
   * What a reviewer sees about an escalation besides the call itself:
   *
   *   - the session's task and the human's last message: TRUSTED, the
   *     human's own text, recorded by the trusted host;
   *   - the agent's justification: UNTRUSTED, written by the agent, so it
   *     is set apart in a warning box and labelled as the agent's claim.
   *
   * Every value goes through SafeText (invisible and direction-changing
   * characters become visible escapes) like any other agent-influenced
   * string. Renders nothing when the escalation carries none of them.
   */
  import type { EscalationReviewContext } from '../../types.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';

  let { context }: { context: EscalationReviewContext } = $props();

  // The task is the human's first message. When it is also the last one (a
  // one-shot or cron session), it is shown once, as the task: nobody typed it
  // just now. Mirrors displayedUserMessage in src/escalation/escalation-review.ts.
  let task = $derived(context.taskSummary);
  let userMessage = $derived(
    context.lastTrustedUserMessage !== undefined &&
      (task === undefined || context.lastTrustedUserMessage.text.trim() !== task.trim())
      ? context.lastTrustedUserMessage
      : undefined,
  );
  let sentAt = $derived(
    userMessage?.sentAt !== undefined && !Number.isNaN(new Date(userMessage.sentAt).getTime())
      ? new Date(userMessage.sentAt).toLocaleTimeString()
      : undefined,
  );
</script>

{#if task !== undefined || userMessage !== undefined}
  <div class="space-y-2" data-testid="escalation-trusted-context">
    {#if task !== undefined}
      <div>
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Task</div>
        <div
          data-testid="escalation-task-summary"
          class="text-sm bg-success/10 border border-success/30 rounded-lg px-3 py-2 text-foreground/90 whitespace-pre-wrap bidi-safe max-h-32 overflow-y-auto"
        >
          <SafeText text={task} multiline />
        </div>
      </div>
    {/if}
    {#if userMessage !== undefined}
      <div>
        <div class="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
          Your last message{#if sentAt}<span class="normal-case tracking-normal"> &middot; sent {sentAt}</span>{/if}
        </div>
        <div
          data-testid="escalation-user-message"
          class="text-sm bg-success/10 border border-success/30 rounded-lg px-3 py-2 text-foreground/90 whitespace-pre-wrap bidi-safe max-h-32 overflow-y-auto"
        >
          <SafeText text={userMessage.text} multiline />
        </div>
      </div>
    {/if}
  </div>
{/if}

{#if context.agentJustification !== undefined}
  <div data-testid="escalation-agent-justification">
    <div class="text-[11px] font-medium text-warning uppercase tracking-wider mb-1.5">
      Agent's justification &mdash; untrusted, written by the agent
    </div>
    <div
      role="note"
      class="text-sm bg-warning/10 border border-dashed border-warning/50 rounded-lg px-3 py-2 text-foreground/80 whitespace-pre-wrap bidi-safe max-h-32 overflow-y-auto"
    >
      <SafeText text={context.agentJustification} multiline />
    </div>
    <p class="text-[10px] text-muted-foreground/70 mt-1">
      The agent's own claim about this call. It is not checked and approves nothing: decide from the call itself.
    </p>
  </div>
{/if}
