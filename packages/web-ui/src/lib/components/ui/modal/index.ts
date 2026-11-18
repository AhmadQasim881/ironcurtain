import Root from './modal.svelte';

/**
 * Where keyboard focus goes when a Modal opens. `'dialog'` moves it into the
 * dialog but never onto an action control (first text field, else the dialog
 * container); `'none'` leaves focus where it is, for modals that open without
 * a user action. See `modal.svelte`.
 */
export type ModalFocusOnOpen = 'dialog' | 'none';

export { Root, Root as Modal };
