<script lang="ts">
  // Mounts a Modal whose body has action controls first and, optionally, a
  // text field after them. Used exclusively by modal.test.ts.
  import Modal from './modal.svelte';
  import type { ModalFocusOnOpen } from './index.js';

  let {
    open = true,
    onclose,
    focusOnOpen,
    withTextField = false,
  }: {
    open?: boolean;
    onclose: () => void;
    focusOnOpen?: ModalFocusOnOpen;
    withTextField?: boolean;
  } = $props();
</script>

<Modal {open} {onclose} {focusOnOpen} title="Harness">
  <div>
    <a href="#top">Link</a>
    <button data-testid="action">Delete</button>
    <input type="checkbox" data-testid="checkbox" />
    {#if withTextField}
      <input type="text" data-testid="text-field" />
    {/if}
  </div>
</Modal>
