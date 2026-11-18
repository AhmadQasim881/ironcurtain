/**
 * The generic Modal never puts keyboard focus on an action control: an Enter
 * or Space the user was already typing would activate it. Modals that open on
 * their own (focusOnOpen="none") leave focus where it is, and Escape outside
 * the dialog still dismisses the top-most modal without reaching the page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ModalHarness from './__test_harness__.svelte';

/** Past the animation frame the Modal uses to move focus. */
const afterFocusFrame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

let outside: HTMLTextAreaElement;

beforeEach(() => {
  outside = document.createElement('textarea');
  document.body.appendChild(outside);
  outside.focus();
});

afterEach(() => {
  outside.remove();
});

describe('Modal focus on open', () => {
  it('focuses the dialog container, not the first button, link or checkbox', async () => {
    render(ModalHarness, { props: { onclose: vi.fn() } });
    await afterFocusFrame();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('focuses the first text field when the dialog has one', async () => {
    render(ModalHarness, { props: { onclose: vi.fn(), withTextField: true } });
    await afterFocusFrame();
    expect(document.activeElement).toBe(screen.getByTestId('text-field'));
  });

  it('leaves focus where it was with focusOnOpen="none"', async () => {
    render(ModalHarness, { props: { onclose: vi.fn(), focusOnOpen: 'none', withTextField: true } });
    await afterFocusFrame();
    expect(document.activeElement).toBe(outside);
  });

  it('keeps Shift+Tab from the focused dialog container inside the dialog', async () => {
    render(ModalHarness, { props: { onclose: vi.fn() } });
    await afterFocusFrame();
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);

    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('checkbox'));
  });

  it('restores the previously focused element on close', async () => {
    const rendered = render(ModalHarness, { props: { onclose: vi.fn() } });
    await afterFocusFrame();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await rendered.rerender({ onclose: vi.fn(), open: false });
    expect(document.activeElement).toBe(outside);
  });
});

describe('Modal Escape handling', () => {
  it('closes on Escape pressed while focus is outside the dialog and consumes the key', async () => {
    const onclose = vi.fn();
    render(ModalHarness, { props: { onclose, focusOnOpen: 'none' } });
    const reachedPage = vi.fn();
    outside.addEventListener('keydown', reachedPage);

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    outside.dispatchEvent(event);

    expect(onclose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it('ignores other keys pressed outside the dialog', async () => {
    const onclose = vi.fn();
    render(ModalHarness, { props: { onclose, focusOnOpen: 'none' } });
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    outside.dispatchEvent(event);
    expect(onclose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes only the most recently opened of two stacked modals', async () => {
    const first = vi.fn();
    const second = vi.fn();
    render(ModalHarness, { props: { onclose: first, focusOnOpen: 'none' } });
    render(ModalHarness, { props: { onclose: second, focusOnOpen: 'none' } });

    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('closes exactly once on Escape pressed inside the dialog', async () => {
    const onclose = vi.fn();
    render(ModalHarness, { props: { onclose } });
    screen
      .getByTestId('action')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
