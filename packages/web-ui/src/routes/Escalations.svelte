<script lang="ts">
  import { untrack } from 'svelte';
  import { appState, approveEscalationGroup, resolveEscalation } from '../lib/stores.svelte.js';
  import type { PendingEscalation } from '../lib/types.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Card } from '$lib/components/ui/card/index.js';
  import { Alert } from '$lib/components/ui/alert/index.js';
  import { SafeText } from '$lib/components/ui/safe-text/index.js';
  import EscalationCard from '$lib/components/features/escalation-card.svelte';
  import EscalationGroupConfirm from '$lib/components/features/escalation-group-confirm.svelte';
  import { ESCALATION_ARM_DELAY_MS } from '$lib/components/features/escalation-modal.svelte';
  import { groupMembersOf, groupPendingEscalations } from '$lib/escalation-groups.js';

  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';

  let resolvingIds = $state<Set<string>>(new Set());
  let resolveError = $state('');

  let pending = $derived([...appState.pendingEscalations.values()]);

  // Escalations sharing one whitelist pattern can be approved together, but
  // only from a confirmation that lists every member (see
  // escalation-group-confirm.svelte); the daemon refuses unless the ids sent
  // are still exactly the group.
  let groups = $derived(groupPendingEscalations(pending));
  let reviewingGroup = $state<{
    key: string;
    description: string;
    members: readonly PendingEscalation[];
  } | null>(null);
  let reviewingCurrent = $derived(reviewingGroup ? groupMembersOf(pending, reviewingGroup.key) : []);
  let groupBusy = $state(false);

  function reviewGroup(group: { key: string; description: string; members: readonly PendingEscalation[] }): void {
    reviewingGroup = { key: group.key, description: group.description, members: [...group.members] };
  }

  async function handleApproveGroup(): Promise<void> {
    const group = reviewingGroup;
    if (!group || groupBusy) return;
    groupBusy = true;
    resolveError = '';
    try {
      const result = await approveEscalationGroup(
        group.key,
        group.members.map((esc) => esc.escalationId),
      );
      if (result.failed.length > 0) {
        resolveError = `Approved ${result.approved.length} of ${group.members.length}; not approved: ${result.failed
          .map((failure) => failure.message)
          .join('; ')}`;
      }
    } catch (err) {
      resolveError = `Failed to approve the group: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      groupBusy = false;
      reviewingGroup = null;
    }
  }

  // A card takes Approve, Deny and whitelist clicks only once it has been in
  // its place in the list for ESCALATION_ARM_DELAY_MS. Resolving a card moves
  // the ones below it up under the pointer, so the second click of a double
  // click on Approve -- or any click aimed at the card that was there --
  // would otherwise decide an escalation the user has not looked at. A card
  // that just appeared waits too. Cards that did not move stay armed.
  // The group banners above the list move every card when one appears or
  // goes (a group forms, or dissolves because a member expired or was decided
  // elsewhere) without changing any card's index: a click aimed at "Review
  // group" would land on the first card's Approve or Deny. So the number of
  // banners is part of a card's place too.
  const placeOf = (escalationId: string, index: number, banners: number): string =>
    `${banners}:${index}:${escalationId}`;
  let settledPlaces = $state<ReadonlySet<string>>(new Set());

  $effect(() => {
    const banners = groups.length;
    const places = new Set(pending.map((esc, index) => placeOf(esc.escalationId, index, banners)));
    settledPlaces = new Set([...untrack(() => settledPlaces)].filter((place) => places.has(place)));
    const timer = setTimeout(() => {
      settledPlaces = places;
    }, ESCALATION_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  });

  async function handleResolve(
    escalationId: string,
    decision: 'approved' | 'denied',
    whitelistSelection?: number,
  ): Promise<void> {
    resolvingIds = new Set([...resolvingIds, escalationId]);
    resolveError = '';
    try {
      await resolveEscalation(escalationId, decision, whitelistSelection);
    } catch (err) {
      resolveError = `Failed to ${decision === 'approved' ? 'approve' : 'deny'}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      const next = new Set(resolvingIds);
      next.delete(escalationId);
      resolvingIds = next;
    }
  }
</script>

<div class="p-6 space-y-5 animate-fade-in">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold tracking-tight">Escalations</h2>
    {#if appState.pendingEscalations.size > 0}
      <Badge variant="destructive" class="font-mono font-semibold px-2.5 py-1 text-xs">
        {appState.pendingEscalations.size} pending
      </Badge>
    {/if}
  </div>

  {#if resolveError}
    <Alert variant="destructive" dismissible ondismiss={() => (resolveError = '')}>
      {resolveError}
    </Alert>
  {/if}

  {#if appState.pendingEscalations.size === 0}
    <Card class="p-12 text-center">
      <CheckCircle size={40} class="mx-auto text-muted-foreground/30 mb-4" />
      <p class="text-muted-foreground">No pending escalations</p>
      <p class="text-sm text-muted-foreground/70 mt-1">Escalations appear here when a tool call requires approval.</p>
    </Card>
  {:else}
    {#if groups.length > 0}
      <div class="space-y-2" data-testid="escalation-groups">
        {#each groups as group (group.key)}
          <Card
            class="px-5 py-3 flex items-center justify-between gap-4 border-primary/30"
            data-testid="escalation-group"
          >
            <div class="min-w-0 text-sm">
              <div class="font-medium">{group.members.length} pending escalations share one pattern</div>
              <div class="text-xs text-muted-foreground bidi-safe truncate">
                <SafeText text={group.description} />
                <span>
                  &middot; #{group.members.map((esc) => esc.sessionLabel).join(', #')}
                </span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="shrink-0"
              data-testid="escalation-group-review"
              onclick={() => reviewGroup(group)}
            >
              Review group
            </Button>
          </Card>
        {/each}
      </div>
    {/if}
    <div class="space-y-3">
      {#each pending as esc, index (esc.escalationId)}
        <EscalationCard
          escalation={esc}
          loading={resolvingIds.has(esc.escalationId)}
          armed={settledPlaces.has(placeOf(esc.escalationId, index, groups.length))}
          onapprove={(whitelistSelection) => handleResolve(esc.escalationId, 'approved', whitelistSelection)}
          ondeny={() => handleResolve(esc.escalationId, 'denied')}
        />
      {/each}
    </div>
  {/if}
</div>

<EscalationGroupConfirm
  open={reviewingGroup !== null}
  description={reviewingGroup?.description ?? ''}
  reviewed={reviewingGroup?.members ?? []}
  current={reviewingCurrent}
  busy={groupBusy}
  onconfirm={() => void handleApproveGroup()}
  onclose={() => (reviewingGroup = null)}
/>
