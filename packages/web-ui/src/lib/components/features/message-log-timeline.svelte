<script lang="ts">
  /**
   * Vertical timeline of {@link MessageLogEntry} records.
   *
   * Pure prop-driven (no store access — see `packages/web-ui/CLAUDE.md` layer
   * rules). The parent route is responsible for fetching pages via the
   * `workflows.messageLog` RPC and feeding them in. Long messages arrive cut
   * (`entry.truncated` with an opaque `entry.ref`); the parent passes
   * `fetchFullEntry` so the complete text is fetched only when a reviewer
   * expands such an entry.
   */
  import type { MessageLogEntry, MessageLogEntryDto, MessageLogEntryResponseDto } from '$lib/types.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { renderMarkdown } from '$lib/markdown.js';

  let {
    entries,
    loading = false,
    hasMore,
    onLoadOlder,
    maxHeight = '60vh',
    fetchFullEntry,
  }: {
    entries: readonly MessageLogEntryDto[];
    loading?: boolean;
    hasMore: boolean;
    onLoadOlder?: () => void;
    /**
     * Cap the timeline scroll viewport. Defaults to `60vh` so a long log does
     * not push the surrounding page off-screen. Pass an empty string or a
     * larger value (e.g. `'100vh'`) to opt out.
     */
    maxHeight?: string;
    /** Loads the complete entry behind a truncated page entry's `ref`. */
    fetchFullEntry?: (ref: string) => Promise<MessageLogEntryResponseDto>;
  } = $props();

  // ------------------------------------------------------------------
  // Variant metadata
  //
  // Maps entry `type` to (badge variant, human label). Re-uses existing
  // `BadgeVariant` tokens — no new ones introduced.
  // ------------------------------------------------------------------
  type VariantMeta = {
    label: string;
    badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
  };

  const VARIANT_META: Record<MessageLogEntry['type'], VariantMeta> = {
    agent_sent: { label: 'Agent sent', badgeVariant: 'default' },
    agent_received: { label: 'Agent received', badgeVariant: 'success' },
    state_transition: { label: 'State', badgeVariant: 'outline' },
    gate_raised: { label: 'Gate raised', badgeVariant: 'secondary' },
    gate_resolved: { label: 'Gate resolved', badgeVariant: 'secondary' },
    tool_call_escalation: { label: 'Escalation', badgeVariant: 'warning' },
    error: { label: 'Error', badgeVariant: 'destructive' },
    quota_exhausted: { label: 'Quota exhausted', badgeVariant: 'destructive' },
    agent_retry: { label: 'Retry', badgeVariant: 'warning' },
  };

  /**
   * The daemon may log entry types this build does not know yet (the log is
   * append-only and outlives UI versions). Render those with a neutral badge
   * instead of failing the whole timeline on a missing table entry.
   */
  function metaFor(entry: MessageLogEntry): VariantMeta {
    return (
      (VARIANT_META as Partial<Record<string, VariantMeta>>)[entry.type] ?? {
        label: String(entry.type),
        badgeVariant: 'outline',
      }
    );
  }

  // `ts:type` alone is not unique enough: rapid `agent_retry` bursts can emit
  // multiple same-type entries within the same millisecond (orchestrator.ts:1531),
  // which would crash Svelte 5's keyed `{#each}` with `each_key_duplicate`.
  // We assign each entry object a monotonic id via WeakMap and include it in
  // the rendered key. Trade-off: this loses `expanded` state on a full
  // message-log refresh (re-fetched entries are new object references); a
  // backend `seq` field on `MessageLogEntry` would fix that, but a silent
  // expansion reset is far better than a fatal render crash.
  const entryIds = new WeakMap<MessageLogEntryDto, number>();
  let nextEntryId = 0;

  function entryKey(entry: MessageLogEntryDto): string {
    let id = entryIds.get(entry);
    if (id === undefined) {
      id = nextEntryId++;
      entryIds.set(entry, id);
    }
    return entry.ts + ':' + entry.type + ':' + String(id);
  }

  let expanded = $state<Set<string>>(new Set());

  // Complete entries fetched for truncated page entries, keyed like `expanded`.
  let fullEntries = $state<Map<string, MessageLogEntry>>(new Map());
  let fullLoading = $state<Set<string>>(new Set());
  let fullErrors = $state<Map<string, string>>(new Map());

  /** The entry to render: the fetched complete entry when there is one, else the page entry. */
  function shownEntry(entry: MessageLogEntryDto, key: string): MessageLogEntry {
    return fullEntries.get(key) ?? entry;
  }

  function isTruncated(entry: MessageLogEntryDto, key: string): boolean {
    return entry.truncated === true && !fullEntries.has(key);
  }

  async function loadFull(entry: MessageLogEntryDto, key: string): Promise<void> {
    if (!isTruncated(entry, key) || fullLoading.has(key)) return;
    if (entry.ref === undefined || fetchFullEntry === undefined) return;
    fullLoading = new Set(fullLoading).add(key);
    try {
      const res = await fetchFullEntry(entry.ref);
      fullEntries = new Map(fullEntries).set(key, res.entry);
      if (fullErrors.has(key)) {
        const next = new Map(fullErrors);
        next.delete(key);
        fullErrors = next;
      }
    } catch (err) {
      fullErrors = new Map(fullErrors).set(key, err instanceof Error ? err.message : String(err));
    } finally {
      const done = new Set(fullLoading);
      done.delete(key);
      fullLoading = done;
    }
  }

  function toggleExpanded(key: string, entry: MessageLogEntryDto): void {
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      // Expanding a cut message is when the full text is wanted.
      void loadFull(entry, key);
    }
    expanded = next;
  }

  function isExpanded(key: string): boolean {
    return expanded.has(key);
  }

  // ------------------------------------------------------------------
  // Preview helper for collapsed agent messages.
  // ------------------------------------------------------------------
  const PREVIEW_LIMIT = 120;

  function previewOf(text: string): string {
    if (!text) return '';
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (firstLine.length <= PREVIEW_LIMIT && !text.includes('\n')) {
      return firstLine;
    }
    const candidate = firstLine.length > PREVIEW_LIMIT ? firstLine.slice(0, PREVIEW_LIMIT) : firstLine;
    return candidate + '…';
  }

  // ------------------------------------------------------------------
  // Message logs intentionally retain seconds-level detail for recent events;
  // the shared compact formatter starts at minute granularity.
  // ------------------------------------------------------------------
  function formatMessageRelativeTime(iso: string, now: number = Date.now()): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const deltaSec = Math.round((now - ts) / 1000);
    if (deltaSec < 5) return 'just now';
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const min = Math.round(deltaSec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatAbsoluteTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toLocaleString();
  }

  function isAgentMessage(
    entry: MessageLogEntry,
  ): entry is Extract<MessageLogEntry, { type: 'agent_sent' | 'agent_received' }> {
    return entry.type === 'agent_sent' || entry.type === 'agent_received';
  }

  function handleLoadOlder(): void {
    onLoadOlder?.();
  }
</script>

<div data-testid="message-log-timeline" class="space-y-2">
  <div
    data-testid="message-log-scroll"
    class={maxHeight ? 'overflow-y-auto space-y-2 pr-1' : 'space-y-2'}
    style={maxHeight ? `max-height: ${maxHeight}` : undefined}
  >
    {#if entries.length === 0 && !loading}
      <div data-testid="message-log-empty" class="text-sm text-muted-foreground italic px-2 py-6 text-center">
        No message-log entries yet.
      </div>
    {/if}

    {#each entries as entry (entryKey(entry))}
      {@const meta = metaFor(entry)}
      {@const key = entryKey(entry)}
      {@const shown = shownEntry(entry, key)}
      {@const truncated = isTruncated(entry, key)}
      <Card data-testid="message-log-entry" data-entry-type={entry.type} class="px-3 py-2">
        <div class="flex items-baseline gap-2 text-xs text-muted-foreground mb-1">
          <Badge variant={meta.badgeVariant} class="font-mono shrink-0">{meta.label}</Badge>
          <span class="font-mono text-foreground/70">{entry.state}</span>
          <span class="ml-auto" title={formatAbsoluteTime(entry.ts)}>{formatMessageRelativeTime(entry.ts)}</span>
        </div>

        {#if isAgentMessage(shown)}
          {@const isOpen = isExpanded(key)}
          <button
            type="button"
            class="w-full text-left text-sm text-foreground/90 hover:text-foreground transition-colors"
            onclick={() => toggleExpanded(key, entry)}
            data-testid="agent-toggle"
            aria-expanded={isOpen}
          >
            {#if isOpen}
              <div class="prose-markdown" data-testid="agent-full">{@html renderMarkdown(shown.message)}</div>
            {:else}
              <div class="truncate" data-testid="agent-preview">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-2">{shown.role}</span>
                {previewOf(shown.message)}
              </div>
            {/if}
          </button>
          {#if isOpen && truncated}
            <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground" data-testid="agent-truncated">
              {#if fullLoading.has(key)}
                <Spinner size="xs" />
                <span>Loading the full message…</span>
              {:else if fullErrors.has(key)}
                <span class="text-destructive">Showing the first part only — {fullErrors.get(key)}</span>
              {:else}
                <span>Showing the first part only (message truncated).</span>
              {/if}
            </div>
          {/if}
          {#if shown.type === 'agent_received' && shown.verdict}
            <div class="mt-1 text-xs text-muted-foreground">
              verdict: <span class="font-mono text-foreground/80">{shown.verdict}</span>
              {#if shown.confidence}
                · confidence: <span class="font-mono text-foreground/80">{shown.confidence}</span>
              {/if}
            </div>
          {/if}
        {:else if shown.type === 'state_transition'}
          <div class="text-sm font-mono text-foreground/90">
            <span class="text-muted-foreground">{shown.from}</span>
            <span class="mx-1.5 text-muted-foreground">→</span>
            <span>{shown.state}</span>
            <span class="mx-2 text-muted-foreground">/</span>
            <span class="text-foreground/70">{shown.event}</span>
          </div>
        {:else if shown.type === 'gate_raised'}
          <div class="text-sm text-foreground/90">
            <span class="text-muted-foreground">accepted events:</span>
            <span class="font-mono text-foreground/80">{shown.acceptedEvents.join(', ') || '—'}</span>
          </div>
        {:else if shown.type === 'gate_resolved'}
          <div class="text-sm text-foreground/90">
            <span class="text-muted-foreground">resolved with</span>
            <span class="font-mono text-foreground/80">{shown.event}</span>
            {#if shown.resolvedBy}
              <span class="text-muted-foreground">via</span>
              <span class="font-mono text-foreground/80" data-testid="gate-resolved-by">{shown.resolvedBy}</span>
            {/if}
            {#if shown.prompt}
              <div class="mt-1 text-xs text-muted-foreground italic">{shown.prompt}</div>
            {/if}
          </div>
        {:else if shown.type === 'tool_call_escalation'}
          <div class="text-sm text-foreground/90">
            <span class="font-mono text-foreground/80">{shown.serverName}/{shown.toolName}</span>
            <span class="mx-1.5 text-muted-foreground">·</span>
            <span class="font-mono">{shown.outcome}</span>
          </div>
          <div class="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{shown.reason}</div>
        {:else if shown.type === 'error'}
          <div class="text-sm text-destructive whitespace-pre-wrap">{shown.error}</div>
          {#if shown.context}
            <div class="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{shown.context}</div>
          {/if}
        {:else if shown.type === 'quota_exhausted'}
          <div class="text-sm text-destructive">
            <span class="text-[10px] uppercase tracking-wider mr-2">{shown.role}</span>
            <span class="whitespace-pre-wrap">{shown.rawMessage}</span>
          </div>
          {#if shown.resetAt}
            <div class="mt-1 text-xs text-muted-foreground">resets at {formatAbsoluteTime(shown.resetAt)}</div>
          {/if}
        {:else if shown.type === 'agent_retry'}
          <div class="text-sm text-warning">
            <span class="text-[10px] uppercase tracking-wider mr-2">{shown.role}</span>
            <span class="font-mono">{shown.reason}</span>
          </div>
          <div class="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{shown.details}</div>
        {/if}

        {#if !isAgentMessage(shown) && truncated}
          <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground" data-testid="entry-truncated">
            <span>Text truncated.</span>
            {#if fetchFullEntry && entry.ref !== undefined}
              <button
                type="button"
                class="text-primary hover:underline disabled:opacity-60"
                onclick={() => loadFull(entry, key)}
                disabled={fullLoading.has(key)}
                data-testid="load-full-entry"
              >
                {fullLoading.has(key) ? 'Loading…' : 'Show full text'}
              </button>
            {/if}
            {#if fullErrors.has(key)}
              <span class="text-destructive">{fullErrors.get(key)}</span>
            {/if}
          </div>
        {/if}
      </Card>
    {/each}
  </div>

  {#if loading}
    <div
      data-testid="message-log-loading"
      class="flex items-center justify-center gap-2 text-xs text-muted-foreground py-3"
    >
      <Spinner size="sm" />
      <span>Loading older entries…</span>
    </div>
  {/if}

  {#if hasMore && !loading}
    <div class="flex justify-center pt-2">
      <Button
        data-testid="message-log-load-older"
        variant="outline"
        size="sm"
        onclick={handleLoadOlder}
        disabled={onLoadOlder == null}
      >
        Load older
      </Button>
    </div>
  {/if}
</div>
