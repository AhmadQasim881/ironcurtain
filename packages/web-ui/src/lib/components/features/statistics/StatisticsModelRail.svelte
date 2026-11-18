<script lang="ts">
  import { Card } from '$lib/components/ui/card/index.js';
  import type { StatisticsIdentityMode, StatisticsModelRailItem } from './statistics-helpers.js';
  import { formatCompactNumber, formatCoverage, statisticsGroupNoun } from './statistics-helpers.js';

  const RAIL_COPY: Readonly<
    Record<
      StatisticsIdentityMode,
      { readonly title: string; readonly description: string; readonly comparison: string; readonly column: string }
    >
  > = {
    routed: {
      title: 'Provider and model rail',
      description: 'Provider route and model sent upstream.',
      comparison: 'Provider and model comparison',
      column: 'Provider · model',
    },
    served: {
      title: 'Provider and model rail',
      description: 'Identity reported by the serving provider or trusted router.',
      comparison: 'Provider and model comparison',
      column: 'Provider · model',
    },
    persona: {
      title: 'Persona rail',
      description: 'Persona the session or workflow state ran as. Names show for personas configured on this host.',
      comparison: 'Persona comparison',
      column: 'Persona',
    },
    workflow: {
      title: 'Workflow rail',
      description: 'Workflow run that issued the requests.',
      comparison: 'Workflow run comparison',
      column: 'Workflow run',
    },
  };

  let {
    items,
    mode,
  }: {
    items: readonly StatisticsModelRailItem[];
    mode: StatisticsIdentityMode;
  } = $props();
</script>

<Card class="overflow-hidden" role="region" aria-labelledby="model-rail-title">
  <header>
    <h2 id="model-rail-title">{RAIL_COPY[mode].title}</h2>
    <p>{RAIL_COPY[mode].description}</p>
  </header>
  {#if items.length === 0}
    <p class="empty">No {statisticsGroupNoun(mode)} groups were observed.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="table-scroll" tabindex="0" role="region" aria-label={RAIL_COPY[mode].comparison}>
      <table>
        <thead
          ><tr
            ><th>{RAIL_COPY[mode].column}</th><th>Median speed</th><th>Middle 50%</th><th>Requests</th><th
              >Output tokens</th
            ><th>Coverage</th></tr
          ></thead
        >
        <tbody>
          {#each items as item (item.key)}
            <tr>
              <th scope="row"
                ><i style={`--series-color:${item.color}`}></i><span
                  ><b>{item.model}</b><small>{item.provider}</small></span
                ></th
              >
              <td>{item.median === null ? 'Unavailable' : `${item.median.toFixed(1)} tok/s`}</td>
              <td
                >{item.lowerQuartile === null || item.upperQuartile === null
                  ? '—'
                  : `${item.lowerQuartile.toFixed(1)}–${item.upperQuartile.toFixed(1)}`}</td
              >
              <td>{formatCompactNumber(item.requestCount, 0)}</td>
              <td>{formatCompactNumber(item.outputTokens, 0)}</td>
              <td>{formatCoverage(item.sampleCount, item.eligibleCount, item.sampleSessionCount)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

<style>
  header {
    padding: 1.2rem 1.25rem 0.8rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  p {
    margin: 0.3rem 0 0;
    color: hsl(var(--muted-foreground));
    font-size: 0.76rem;
  }
  .table-scroll {
    max-width: 100%;
    overflow-x: auto;
  }
  table {
    width: 100%;
    min-width: 52rem;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.8rem 1rem;
    border-top: 1px solid hsl(var(--border));
    text-align: left;
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
  }
  thead th {
    color: hsl(var(--muted-foreground));
    font-size: 0.65rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  tbody th {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }
  tbody th i {
    width: 1.5rem;
    border-top: 3px solid var(--series-color);
  }
  tbody th span {
    display: grid;
  }
  tbody th b {
    font-size: 0.8rem;
  }
  tbody th small {
    color: hsl(var(--muted-foreground));
    font-size: 0.67rem;
    font-weight: 500;
  }
  .empty {
    padding: 0 1.25rem 1.25rem;
  }
</style>
