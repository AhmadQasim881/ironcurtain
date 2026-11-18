<script lang="ts">
  import type {
    HumanGateRequestDto,
    ArtifactContentDto,
    FileTreeResponseDto,
    FileContentResponseDto,
  } from '$lib/types.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Spinner } from '$lib/components/ui/spinner/index.js';
  import { renderMarkdown } from '$lib/markdown.js';
  import { ESCALATION_ARM_DELAY_MS } from './escalation-modal.svelte';
  import WorkspaceBrowser from './workspace-browser.svelte';

  let {
    gate,
    workflowName,
    workflowId,
    stateDescription,
    refreshSignal = '',
    layoutSignal = '',
    reviewAvailable = true,
    onResolve,
    fetchArtifacts,
    fetchArtifactFile,
    fetchFileTree,
    fetchFileContent,
  }: {
    gate: HumanGateRequestDto;
    workflowName: string;
    workflowId: string;
    stateDescription?: string;
    // Forwarded to the embedded workspace browser so the Files tab auto-refreshes.
    refreshSignal?: string | number;
    /** Changes to surrounding review surfaces restart the approval delay. */
    layoutSignal?: string;
    /** A failed detail refresh keeps the gate visible but cannot approve stale review data. */
    reviewAvailable?: boolean;
    // Receives the id of the gate this panel displayed, so the decision is
    // bound to the raise the user reviewed rather than whatever the workflow
    // is waiting at by the time the click lands.
    onResolve: (gateId: string, event: string, prompt?: string) => void | Promise<void>;
    // Lists an artifact's files (names and sizes). Contents are loaded one
    // file at a time through `fetchArtifactFile` when the reviewer opens
    // them, so a large artifact never arrives as a single oversized reply.
    fetchArtifacts?: (workflowId: string, artifactName: string) => Promise<ArtifactContentDto>;
    fetchArtifactFile?: (workflowId: string, artifactName: string, path: string) => Promise<FileContentResponseDto>;
    fetchFileTree?: (workflowId: string, path?: string) => Promise<FileTreeResponseDto>;
    fetchFileContent?: (workflowId: string, path: string) => Promise<FileContentResponseDto>;
  } = $props();

  type TabId = 'summary' | 'artifacts' | 'files';
  type FeedbackEvent = 'FORCE_REVISION' | 'REPLAN';

  let activeTab = $state<TabId>('summary');
  let feedbackText = $state('');
  // Which event the feedback form is collecting for. `null` = form hidden.
  // FORCE_REVISION and REPLAN both loop back with feedback, and the next
  // agent's prompt directly references what the human wrote -- so empty
  // feedback would produce an incoherent re-entry prompt.
  let feedbackEvent = $state<FeedbackEvent | null>(null);
  let confirmAbort = $state(false);
  let resolving = $state(false);
  let actionRow = $state<HTMLDivElement>();
  const reviewSnapshot = $derived(
    JSON.stringify([gate, workflowId, workflowName, stateDescription, refreshSignal, layoutSignal, reviewAvailable]),
  );
  let armedSnapshot = $state<string | null>(null);
  const armed = $derived(armedSnapshot === reviewSnapshot && reviewAvailable);
  let pressBeganUnarmed = false;
  let pressSnapshot: string | null = null;
  let armingEpoch = 0;
  let pressEpoch: number | null = null;
  let checkPlacement: (() => void) | undefined;

  // Bind arming and any second-step forms to the exact review on screen.
  $effect(() => {
    void reviewSnapshot;
    feedbackText = '';
    feedbackEvent = null;
    confirmAbort = false;
  });

  $effect(() => {
    const snapshot = reviewSnapshot;
    const row = actionRow;
    armedSnapshot = null;
    if (!row || !reviewAvailable || !hasEvent('APPROVE')) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number;
    let focused = document.hasFocus();
    const placement = (): string => {
      const { x, y, width, height } = row.getBoundingClientRect();
      return JSON.stringify([x, y, width, height]);
    };
    let lastPlacement = placement();
    const disarm = (): void => {
      clearTimeout(timer);
      armedSnapshot = null;
      armingEpoch += 1;
    };
    const restart = (): void => {
      disarm();
      if (!focused || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        if (placement() !== lastPlacement) {
          lastPlacement = placement();
          restart();
        } else if (focused && document.visibilityState !== 'hidden') {
          armedSnapshot = snapshot;
        }
      }, ESCALATION_ARM_DELAY_MS);
    };
    const check = (): void => {
      const next = placement();
      if (next !== lastPlacement) {
        lastPlacement = next;
        restart();
      }
    };
    checkPlacement = check;
    // Position can change when an ancestor moves without resizing this row.
    // Measure one small rectangle per frame, and again at the input boundary.
    const observePlacement = (): void => {
      check();
      frame = requestAnimationFrame(observePlacement);
    };
    const onFocus = (): void => {
      focused = true;
      restart();
    };
    const onBlur = (): void => {
      focused = false;
      disarm();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') disarm();
      else restart();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    restart();
    frame = requestAnimationFrame(observePlacement);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      checkPlacement = undefined;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  function beginPointerPress(): void {
    checkPlacement?.();
    pressBeganUnarmed = !armed;
    pressSnapshot = armed ? reviewSnapshot : null;
    pressEpoch = armingEpoch;
  }

  function beginMousePress(): void {
    checkPlacement?.();
    // Compatibility mouse events on touch release must not clear the mark.
    if (!armed) pressBeganUnarmed = true;
  }

  function beginKeyPress(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    checkPlacement?.();
    pressBeganUnarmed = !armed || event.repeat;
    pressSnapshot = armed ? reviewSnapshot : null;
    pressEpoch = armingEpoch;
  }

  // Artifact listings (per artifact name) and lazily loaded file contents
  // (per `fileKey`). A listing carries names and sizes only; a file's content
  // is fetched when its row is opened and cached for the panel's lifetime.
  let artifactContents = $state<Map<string, ArtifactContentDto>>(new Map());
  let artifactLoading = $state<Set<string>>(new Set());
  let artifactErrors = $state<Set<string>>(new Set());
  let selectedArtifact = $state<string | null>(null);
  let expandedFiles = $state<Set<string>>(new Set());
  let fileContents = $state<Map<string, FileContentResponseDto>>(new Map());
  let fileLoading = $state<Set<string>>(new Set());
  let fileErrors = $state<Map<string, string>>(new Map());

  const hasArtifactsTab = $derived(gate.presentedArtifacts.length > 0 && fetchArtifacts != null);
  const hasFilesTab = $derived(fetchFileTree != null && fetchFileContent != null);

  function hasEvent(event: string): boolean {
    return gate.acceptedEvents.includes(event);
  }

  async function handleApprove(event: MouseEvent): Promise<void> {
    checkPlacement?.();
    if (!armed || resolving || !hasEvent('APPROVE') || pressBeganUnarmed) return;
    // A pointer click whose press predates this panel has no recorded start.
    // Assistive/programmatic activation (detail 0) does not require a pointer.
    if (event.detail > 0 && pressEpoch === null) return;
    if (pressSnapshot !== null && pressSnapshot !== reviewSnapshot) return;
    if (pressEpoch !== null && pressEpoch !== armingEpoch) return;
    const gateId = gate.gateId;
    resolving = true;
    try {
      await onResolve(gateId, 'APPROVE');
    } finally {
      resolving = false;
    }
  }

  async function handleFeedbackEvent(eventType: FeedbackEvent): Promise<void> {
    if (resolving || !hasEvent(eventType)) return;
    if (feedbackEvent !== eventType) {
      feedbackEvent = eventType;
      return;
    }
    const trimmed = feedbackText.trim();
    if (!trimmed) return;
    const gateId = gate.gateId;
    resolving = true;
    try {
      await onResolve(gateId, eventType, trimmed);
    } finally {
      resolving = false;
      feedbackText = '';
      feedbackEvent = null;
    }
  }

  async function handleAbort(): Promise<void> {
    if (resolving || !hasEvent('ABORT')) return;
    if (!confirmAbort) {
      confirmAbort = true;
      return;
    }
    resolving = true;
    const gateId = gate.gateId;
    try {
      await onResolve(gateId, 'ABORT');
    } finally {
      resolving = false;
      confirmAbort = false;
    }
  }

  function cancelAbort(): void {
    if (resolving) return;
    confirmAbort = false;
  }

  function cancelFeedback(): void {
    if (resolving) return;
    feedbackEvent = null;
    feedbackText = '';
  }

  const feedbackLabel = $derived(feedbackEvent === 'REPLAN' ? 'Replan feedback' : 'Revision feedback');
  const feedbackSubmitLabel = $derived(feedbackEvent === 'REPLAN' ? 'Submit Replan' : 'Submit Revision');

  function submitFeedback(): Promise<void> {
    return feedbackEvent ? handleFeedbackEvent(feedbackEvent) : Promise.resolve();
  }

  function fileKey(artifact: string, path: string): string {
    return `${artifact}\u0000${path}`;
  }

  async function loadArtifact(name: string): Promise<void> {
    if (artifactContents.has(name) || artifactErrors.has(name) || !fetchArtifacts) return;
    const newLoading = new Set(artifactLoading);
    newLoading.add(name);
    artifactLoading = newLoading;
    let listing: ArtifactContentDto | undefined;
    try {
      listing = await fetchArtifacts(workflowId, name);
      artifactContents = new Map(artifactContents).set(name, listing);
    } catch {
      const newErrors = new Set(artifactErrors);
      newErrors.add(name);
      artifactErrors = newErrors;
    }
    const done = new Set(artifactLoading);
    done.delete(name);
    artifactLoading = done;
    // Open the first file so the common single-document artifact (plan.md)
    // is readable without another click; every other file loads on demand.
    if (listing && listing.files.length > 0) void openFile(name, listing.files[0].path);
  }

  async function openFile(artifact: string, path: string): Promise<void> {
    const key = fileKey(artifact, path);
    if (!expandedFiles.has(key)) expandedFiles = new Set(expandedFiles).add(key);
    if (!fetchArtifactFile || fileContents.has(key) || fileLoading.has(key)) return;
    fileLoading = new Set(fileLoading).add(key);
    try {
      const content = await fetchArtifactFile(workflowId, artifact, path);
      fileContents = new Map(fileContents).set(key, content);
      if (fileErrors.has(key)) {
        const next = new Map(fileErrors);
        next.delete(key);
        fileErrors = next;
      }
    } catch (err) {
      fileErrors = new Map(fileErrors).set(key, err instanceof Error ? err.message : String(err));
    } finally {
      const done = new Set(fileLoading);
      done.delete(key);
      fileLoading = done;
    }
  }

  function toggleFile(artifact: string, path: string): void {
    const key = fileKey(artifact, path);
    if (expandedFiles.has(key)) {
      const next = new Set(expandedFiles);
      next.delete(key);
      expandedFiles = next;
      return;
    }
    void openFile(artifact, path);
  }

  function selectArtifact(name: string): void {
    selectedArtifact = name;
    loadArtifact(name);
  }

  // A failed listing (e.g. the socket dropped mid-request) is not retried on
  // its own; the reviewer can ask for it again.
  function retryArtifact(name: string): void {
    const next = new Set(artifactErrors);
    next.delete(name);
    artifactErrors = next;
    void loadArtifact(name);
  }

  // Auto-select first artifact when switching to artifacts tab
  $effect(() => {
    if (activeTab === 'artifacts' && !selectedArtifact && gate.presentedArtifacts.length > 0) {
      selectArtifact(gate.presentedArtifacts[0]);
    }
  });

  function tabClass(tab: TabId): string {
    return activeTab === tab
      ? 'border-primary text-primary font-medium'
      : 'border-transparent text-muted-foreground hover:text-foreground';
  }

  function isMarkdown(path: string): boolean {
    return path.endsWith('.md');
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
</script>

<div class="border border-warning/30 bg-warning/5 rounded-lg p-5 space-y-4">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h3 class="text-lg font-semibold">Review Required: {gate.stateName}</h3>
      {#if stateDescription}
        <p class="text-sm text-muted-foreground mt-0.5">{stateDescription}</p>
      {/if}
      <p class="text-sm text-muted-foreground mt-0.5">{workflowName}</p>
    </div>
    <Badge variant="warning">Waiting for Review</Badge>
  </div>

  <!-- Tabs -->
  <div class="flex gap-1 border-b border-border">
    <button
      onclick={() => (activeTab = 'summary')}
      class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('summary')}"
    >
      Summary
    </button>
    {#if hasArtifactsTab}
      <button
        onclick={() => (activeTab = 'artifacts')}
        class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('artifacts')}"
      >
        Artifacts
        <span class="text-xs text-muted-foreground ml-1">({gate.presentedArtifacts.length})</span>
      </button>
    {/if}
    {#if hasFilesTab}
      <button
        onclick={() => (activeTab = 'files')}
        class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {tabClass('files')}"
      >
        Files
      </button>
    {/if}
  </div>

  <!-- Tab content -->
  {#if activeTab === 'summary'}
    <!-- Summary -->
    {#if gate.summary}
      <p class="text-sm text-foreground/80">{gate.summary}</p>
    {/if}

    {#if gate.presentedArtifacts.length > 0}
      <div>
        <p class="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wider">Artifacts</p>
        <div class="flex flex-wrap gap-2">
          {#each gate.presentedArtifacts as artifact (artifact)}
            <Badge variant="outline">{artifact}</Badge>
          {/each}
        </div>
      </div>
    {/if}
  {:else if activeTab === 'artifacts'}
    <!-- Artifact viewer -->
    <div class="space-y-3">
      {#if gate.presentedArtifacts.length > 1}
        <div class="flex flex-wrap gap-2">
          {#each gate.presentedArtifacts as artifact (artifact)}
            <button
              onclick={() => selectArtifact(artifact)}
              class="px-2 py-1 text-xs rounded border transition-colors
                {selectedArtifact === artifact
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground'}"
            >
              {artifact}
            </button>
          {/each}
        </div>
      {/if}

      {#if selectedArtifact}
        {@const artifact = selectedArtifact}
        {#if artifactLoading.has(artifact)}
          <div class="flex items-center justify-center py-4">
            <Spinner size="sm" />
          </div>
        {:else if artifactErrors.has(artifact)}
          <div class="flex items-center gap-2">
            <p class="text-sm text-destructive">Failed to load artifact.</p>
            <button
              type="button"
              class="text-xs text-primary hover:underline"
              onclick={() => retryArtifact(artifact)}
              data-testid="artifact-retry"
            >
              Retry
            </button>
          </div>
        {:else}
          {@const ac = artifactContents.get(artifact)}
          {#if ac && ac.files.length > 0}
            <div class="space-y-3">
              {#if ac.truncated}
                <p class="text-xs text-warning" data-testid="artifact-truncated">
                  Listing truncated: only the first {ac.files.length} files are shown. Browse the rest in the Files tab.
                </p>
              {/if}
              {#each ac.files as file (file.path)}
                {@const key = fileKey(artifact, file.path)}
                {@const open = expandedFiles.has(key)}
                {@const fc = fileContents.get(key)}
                <div class="border border-border rounded overflow-hidden">
                  <button
                    type="button"
                    onclick={() => toggleFile(artifact, file.path)}
                    class="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 text-xs font-mono text-muted-foreground
                      text-left hover:text-foreground transition-colors {open ? 'border-b border-border' : ''}"
                    aria-expanded={open}
                    data-testid="artifact-file-toggle"
                  >
                    <span class="shrink-0">{open ? '▾' : '▸'}</span>
                    <span class="truncate">{file.path}</span>
                    <span class="ml-auto shrink-0 text-[10px]" data-testid="artifact-file-size"
                      >{formatSize(file.size)}</span
                    >
                  </button>
                  {#if open}
                    {#if fileLoading.has(key)}
                      <div class="flex items-center justify-center py-3">
                        <Spinner size="xs" />
                      </div>
                    {:else if fileErrors.has(key)}
                      <p class="p-3 text-sm text-destructive">Failed to load file: {fileErrors.get(key)}</p>
                    {:else if fc?.error}
                      <p class="p-3 text-sm text-muted-foreground">{fc.error}</p>
                    {:else if fc?.binary}
                      <p class="p-3 text-sm text-muted-foreground italic">Binary file -- cannot display</p>
                    {:else if fc?.content != null}
                      {#if isMarkdown(file.path)}
                        <div class="p-3 prose-markdown text-sm">
                          {@html renderMarkdown(fc.content)}
                        </div>
                      {:else}
                        <pre class="p-3 text-xs overflow-x-auto"><code>{fc.content}</code></pre>
                      {/if}
                    {:else}
                      <p class="p-3 text-sm text-muted-foreground">File contents are not available here.</p>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <p class="text-sm text-muted-foreground">No files in this artifact.</p>
          {/if}
        {/if}
      {/if}
    </div>
  {:else if activeTab === 'files' && fetchFileTree && fetchFileContent}
    <!-- Workspace file browser -->
    <div class="h-[400px]">
      <WorkspaceBrowser {workflowId} {refreshSignal} {fetchFileTree} {fetchFileContent} />
    </div>
  {/if}

  <!-- Feedback area (shown when Force Revision or Replan is selected) -->
  {#if feedbackEvent !== null}
    <div class="space-y-2">
      <label for="gate-feedback" class="block text-sm font-medium">{feedbackLabel}</label>
      <textarea
        id="gate-feedback"
        bind:value={feedbackText}
        placeholder="Describe what should be changed..."
        rows={3}
        class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm
          placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50
          resize-y"
      ></textarea>
      <div class="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onclick={submitFeedback}
          disabled={!feedbackText.trim() || resolving}
          loading={resolving}
        >
          {feedbackSubmitLabel}
        </Button>
        <Button variant="ghost" size="sm" onclick={cancelFeedback} disabled={resolving}>Cancel</Button>
      </div>
    </div>
  {/if}

  <!-- Abort confirmation -->
  {#if confirmAbort}
    <div class="border border-destructive/30 bg-destructive/5 rounded-md p-3">
      <p class="text-sm font-medium text-destructive mb-2">
        Are you sure you want to abort this workflow? This action cannot be undone.
      </p>
      <div class="flex gap-2">
        <Button variant="destructive" size="sm" onclick={handleAbort} disabled={resolving} loading={resolving}
          >Confirm Abort</Button
        >
        <Button variant="ghost" size="sm" onclick={cancelAbort} disabled={resolving}>Cancel</Button>
      </div>
    </div>
  {/if}

  <!-- Action buttons -->
  {#if feedbackEvent === null && !confirmAbort}
    <div bind:this={actionRow} class="flex flex-wrap gap-2 pt-1">
      {#if hasEvent('APPROVE')}
        <Button
          variant="success"
          onclick={handleApprove}
          onpointerdown={beginPointerPress}
          onmousedown={beginMousePress}
          onkeydown={beginKeyPress}
          aria-disabled={!armed || resolving || !reviewAvailable}
          title={armed ? undefined : 'Approval is available after this review remains visible and in place for 750ms.'}
          class={!armed ? 'opacity-50' : ''}
          disabled={resolving || !reviewAvailable}
          loading={resolving}>Approve</Button
        >
      {/if}
      {#if hasEvent('FORCE_REVISION')}
        <Button variant="default" onclick={() => handleFeedbackEvent('FORCE_REVISION')} disabled={resolving}>
          Request Revision
        </Button>
      {/if}
      {#if hasEvent('REPLAN')}
        <Button variant="outline" onclick={() => handleFeedbackEvent('REPLAN')} disabled={resolving}>Replan</Button>
      {/if}
      {#if hasEvent('ABORT')}
        <Button variant="destructive" onclick={handleAbort} disabled={resolving}>Abort Workflow</Button>
      {/if}
    </div>
  {/if}
</div>
