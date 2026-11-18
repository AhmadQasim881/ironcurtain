<script module lang="ts">
  /**
   * Open modals, oldest first. Only the most recently opened one reacts to a
   * document-level Escape (see handleDocumentKeydown), so stacked dialogs
   * close one at a time.
   */
  const openModals: symbol[] = [];

  /**
   * Text-entry fields `focusOnOpen: 'dialog'` may focus. Everything else that
   * is focusable (buttons, links, checkboxes, radios, selects) acts on a key.
   */
  const TEXT_FIELD_SELECTOR = [
    'textarea',
    'input:not([type])',
    ...['text', 'search', 'email', 'url', 'tel', 'password', 'number'].map((type) => `input[type="${type}"]`),
  ]
    .map((selector) => `${selector}:not([disabled]):not([readonly])`)
    .join(', ');
</script>

<script lang="ts">
  import { cn } from '$lib/utils.js';
  import type { Snippet } from 'svelte';
  import type { ModalFocusOnOpen } from './index.js';

  let {
    open,
    onclose,
    onkeydown: externalKeydown,
    title,
    focusOnOpen = 'dialog',
    dialog = $bindable(undefined),
    class: className,
    children,
  }: {
    open: boolean;
    onclose: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
    title?: string;
    /**
     * Where keyboard focus goes when the modal opens.
     * - `'dialog'` (default): into the dialog, but never onto an action
     *   control -- a button, link, checkbox or select focused automatically
     *   would act on an Enter or Space the user was already typing. The first
     *   text field gets focus if there is one, otherwise the dialog container
     *   itself; Tab then moves on from there.
     * - `'none'`: focus stays where it is. For modals that open without a
     *   user action (the escalation modal): keystrokes meant for the page,
     *   such as the terminal, keep going there and none reaches the dialog
     *   until the user clicks into it. Escape anywhere still dismisses it.
     */
    focusOnOpen?: ModalFocusOnOpen;
    /**
     * The `role="dialog"` element while open (`bind:dialog`), for owners that
     * need to observe interaction anywhere inside the dialog.
     */
    dialog?: HTMLDivElement | undefined;
    class?: string;
    children?: Snippet;
  } = $props();

  let previousActiveElement: Element | null = null;
  const stackId = Symbol('modal');

  function getFocusableElements(): HTMLElement[] {
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      ),
    );
  }

  function trapFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      e.preventDefault();
      dialog?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      // Also from the dialog container itself, where focusOnOpen 'dialog'
      // puts focus: the browser would otherwise move it out to the page.
      if (document.activeElement === first || document.activeElement === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
      return;
    }
    trapFocus(e);
    externalKeydown?.(e);
  }

  /**
   * Escape pressed while focus is outside the dialog (`focusOnOpen: 'none'`,
   * or focus never moved in). Registered in the capture phase on the document
   * so it runs before the focused element (e.g. xterm's textarea) can swallow
   * it, and the event is consumed so a dismissal never doubles as terminal
   * input. Escape with focus inside the dialog is handled by handleKeydown.
   */
  function handleDocumentKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (openModals[openModals.length - 1] !== stackId) return;
    if (dialog && e.target instanceof Node && dialog.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    onclose();
  }

  function handleBackdropClick(): void {
    onclose();
  }

  $effect(() => {
    if (!open) return;
    openModals.push(stackId);
    document.addEventListener('keydown', handleDocumentKeydown, true);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeydown, true);
      const index = openModals.indexOf(stackId);
      if (index !== -1) openModals.splice(index, 1);
    };
  });

  $effect(() => {
    if (open) {
      previousActiveElement = document.activeElement;
      if (focusOnOpen === 'none') return;
      // After the dialog renders: its first text field, else the container.
      // Never an action control (see focusOnOpen).
      requestAnimationFrame(() => {
        const field = dialog?.querySelector<HTMLElement>(TEXT_FIELD_SELECTOR);
        (field ?? dialog)?.focus();
      });
    } else if (previousActiveElement instanceof HTMLElement) {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  });

  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onkeydown={handleKeydown}>
    <!-- Backdrop -->
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" onclick={handleBackdropClick}></div>

    <!-- Dialog -->
    <div
      bind:this={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      tabindex="-1"
      class={cn(
        'relative z-10 w-full max-w-2xl mx-4 bg-card border border-border rounded-xl shadow-2xl animate-fade-in overflow-hidden',
        className,
      )}
    >
      {#if title}
        <div class="px-5 py-3 border-b border-border">
          <h2 id={titleId} class="text-sm font-semibold">{title}</h2>
        </div>
      {/if}
      {#if children}
        {@render children()}
      {/if}
    </div>
  </div>
{/if}
