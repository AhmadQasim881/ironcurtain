<script module lang="ts">
  /**
   * Highlighted escapes per SafeText. Past this many the escapes are still
   * spelled out, just as plain text, so an agent that packs a value with
   * invisible characters cannot make the approval UI build an element for
   * each one.
   */
  export const MAX_HIGHLIGHTED_ESCAPES = 500;
</script>

<script lang="ts">
  import { segmentDisplayText } from '$lib/unicode-display.js';

  /**
   * Renders untrusted text with every invisible or direction-changing code
   * point shown as a highlighted escape (U+202E appears as the six characters
   * `\u202e`), so what the reviewer sees is what the value contains. See
   * `$lib/unicode-display.ts`.
   */
  let {
    text,
    multiline = false,
  }: {
    text: string;
    /** Keep line feeds and tabs (inside a `<pre>`); otherwise they become visible escapes too. */
    multiline?: boolean;
  } = $props();

  let segments = $derived(segmentDisplayText(text, { multiline, maxEscapeSegments: MAX_HIGHLIGHTED_ESCAPES }));

  function describe(codePoint: number): string {
    return `Invisible or direction-changing character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  }
</script>

<!-- Kept on one line: this renders inside <pre> blocks, where template whitespace would show. -->
{#each segments as segment, index (index)}{#if segment.kind === 'escape'}<span
      class="rounded-sm bg-warning/30 px-0.5 font-mono text-foreground"
      title={describe(segment.codePoint ?? 0)}
      data-invisible-char={segment.codePoint}>{segment.value}</span
    >{:else}{segment.value}{/if}{/each}
