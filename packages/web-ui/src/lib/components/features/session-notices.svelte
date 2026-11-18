<script lang="ts">
  import type { SessionNoticeEntry } from '$lib/types.js';
  import { describeSessionNotice } from '$lib/session-notices.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';

  /**
   * The notices a session reported for the user (a stale compiled policy, an
   * MCP server that could not start, host-model fallbacks, annotation drift,
   * setuid or root-owned files the agent left in its host mounts), each until
   * it is dismissed. Their text carries server- and agent-chosen strings, so it
   * is rendered with SafeText.
   */
  let {
    notices,
    ondismiss,
  }: {
    notices: readonly SessionNoticeEntry[];
    ondismiss: (key: string) => void;
  } = $props();

  const visible = $derived(notices.filter((entry) => !entry.dismissed));
</script>

{#if visible.length > 0}
  <div
    class="px-6 py-2 border-b border-border bg-warning/10 space-y-2 shrink-0"
    role="region"
    aria-label="Session notices"
    data-testid="session-notices"
  >
    {#each visible as entry (entry.key)}
      {@const shown = describeSessionNotice(entry.notice)}
      <div class="flex items-start justify-between gap-4 text-xs" role="alert" data-testid="session-notice">
        <div class="min-w-0">
          <div class="font-semibold text-warning"><SafeText text={shown.title} /></div>
          <!-- The detail keeps its line feeds: the pre-wrap span holds nothing but SafeText. -->
          <div class="mt-0.5 break-words text-foreground/80" data-testid="session-notice-detail">
            <span class="whitespace-pre-wrap"><SafeText text={shown.detail} multiline /></span>
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
          onclick={() => ondismiss(entry.key)}
        >
          Dismiss
        </button>
      </div>
    {/each}
  </div>
{/if}
