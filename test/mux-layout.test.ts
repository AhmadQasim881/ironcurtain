import { describe, it, expect } from 'vitest';
import { calculateLayout, isPickerMode, isBottomPanelPicker, MAX_INPUT_LINE_ROWS } from '../src/mux/types.js';

describe('calculateLayout', () => {
  it('PTY mode: viewport = totalRows - 3 (tab bar + 2-row footer)', () => {
    const layout = calculateLayout(24, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(21);
    expect(layout.overlayRows).toBe(0);
    expect(layout.tabBarY).toBe(0);
    expect(layout.ptyViewportY).toBe(1);
    expect(layout.footerY).toBe(22);
  });

  it('command mode, no escalations: overlay = 2 rows (hint + input)', () => {
    const layout = calculateLayout(24, 'command', 0);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.overlayRows).toBe(2); // hint bar + input line
    expect(layout.escalationPanelRows).toBe(0);
    expect(layout.inputLineRows).toBe(1);
  });

  it('command mode, 2 escalations: escalation panel + hint + input', () => {
    const layout = calculateLayout(24, 'command', 2);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    expect(layout.escalationPanelRows).toBe(8); // 2 * 4 rows per escalation
    // overlay clamped to floor(21/2)=10
    expect(layout.overlayRows).toBe(10); // 8 (esc panel) + 1 (hint) + 1 (input)
  });

  it('command mode, 10 escalations: overlay capped at half viewport', () => {
    const layout = calculateLayout(24, 'command', 10);
    expect(layout.ptyViewportRows).toBe(21); // CONSTANT
    // overlay capped at floor(21/2)=10, escalation clamped to fit: 10-1(hint)-1(input)=8
    expect(layout.escalationPanelRows).toBe(8);
    expect(layout.overlayRows).toBe(10);
  });

  it('minimum viewport height is 1 row', () => {
    const layout = calculateLayout(2, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(1); // min(1, 2-2=0) -> max(1, 0)
  });

  it('small terminal: 3 rows', () => {
    const layout = calculateLayout(3, 'pty', 0);
    expect(layout.ptyViewportRows).toBe(1); // min clamp
    expect(layout.footerY).toBe(2);
  });

  it('command mode: one more panel row per escalation offering a directory-wide pattern', () => {
    // One escalation, both patterns: header, argument, reason and two pattern lines.
    expect(calculateLayout(30, 'command', 1, 1, 1).escalationPanelRows).toBe(5);
    expect(calculateLayout(30, 'command', 1).escalationPanelRows).toBe(4);
    // Still capped by the panel maximum and the half-viewport overlay.
    expect(calculateLayout(60, 'command', 3, 1, 3).escalationPanelRows).toBe(12);
    expect(calculateLayout(24, 'command', 2, 1, 2).escalationPanelRows).toBe(8);
  });

  it('overlay Y position is correct', () => {
    const layout = calculateLayout(30, 'command', 1);
    // ptyViewport: 27 rows (30 - 3)
    // escalation panel: 4 rows (1 * 4)
    // 4 + 1 + 1 = 6, floor(27/2) = 13 => overlay = 6
    // overlayY = 1 + 27 - 6 = 22
    expect(layout.overlayY).toBe(22);
  });

  it('inputLineRows parameter increases overlay height', () => {
    const layout = calculateLayout(50, 'command', 0, 4);
    // ptyViewport: 47 rows, floor(47/2) = 23
    // 0 (esc) + 1 (hint) + 4 (input) = 5, clamped to min(5, 23) = 5
    expect(layout.overlayRows).toBe(5);
    expect(layout.inputLineRows).toBe(4);
  });

  it('inputLineRows is clamped to MAX_INPUT_LINE_ROWS', () => {
    const layout = calculateLayout(50, 'command', 0, 20);
    // Clamped to MAX_INPUT_LINE_ROWS=6: 0 + 1 + 6 = 7
    expect(layout.overlayRows).toBe(7);
    expect(layout.inputLineRows).toBe(MAX_INPUT_LINE_ROWS);
  });

  it('overlay does not exceed half viewport', () => {
    // With 10 rows total: viewport = 7, floor(7/2) = 3
    const layout = calculateLayout(10, 'command', 0, 6);
    expect(layout.ptyViewportRows).toBe(7);
    expect(layout.overlayRows).toBeLessThanOrEqual(Math.floor(7 / 2));
    // inputLineRows is clamped by the overlay budget
    expect(layout.inputLineRows).toBeGreaterThanOrEqual(1);
  });

  it('inputLineRows defaults to 1 when omitted', () => {
    const layout = calculateLayout(24, 'command', 0);
    expect(layout.inputLineRows).toBe(1);
  });

  it('inputLineRows is 1 in PTY mode', () => {
    const layout = calculateLayout(24, 'pty', 0);
    expect(layout.inputLineRows).toBe(1);
  });

  it('escalation-picker does not claim picker rows (floats over viewport)', () => {
    const layout = calculateLayout(24, 'escalation-picker', 0);
    expect(layout.pickerRows).toBe(0);
    expect(layout.overlayRows).toBe(0); // no command overlay
  });

  it('isPickerMode includes escalation-picker', () => {
    expect(isPickerMode('escalation-picker')).toBe(true);
    expect(isPickerMode('picker')).toBe(true);
    expect(isPickerMode('resume-picker')).toBe(true);
    expect(isPickerMode('persona-picker')).toBe(true);
    expect(isPickerMode('pty')).toBe(false);
    expect(isPickerMode('command')).toBe(false);
  });

  it('isBottomPanelPicker excludes escalation-picker', () => {
    expect(isBottomPanelPicker('escalation-picker')).toBe(false);
    expect(isBottomPanelPicker('picker')).toBe(true);
    expect(isBottomPanelPicker('resume-picker')).toBe(true);
    expect(isBottomPanelPicker('persona-picker')).toBe(true);
    expect(isBottomPanelPicker('pty')).toBe(false);
    expect(isBottomPanelPicker('command')).toBe(false);
  });

  it('the approve-all confirmation is a picker that floats over the full viewport', () => {
    expect(isPickerMode('escalation-approve-all')).toBe(true);
    expect(isBottomPanelPicker('escalation-approve-all')).toBe(false);
    const layout = calculateLayout(24, 'escalation-approve-all', 3);
    expect(layout.pickerRows).toBe(0);
    expect(layout.overlayRows).toBe(0);
  });
});

describe('message-panel mode', () => {
  it('is a bottom-panel picker that claims half the viewport', () => {
    expect(isPickerMode('message-panel')).toBe(true);
    expect(isBottomPanelPicker('message-panel')).toBe(true);
    const layout = calculateLayout(24, 'message-panel', 0);
    expect(layout.ptyViewportRows).toBe(21);
    expect(layout.pickerRows).toBe(10);
    expect(layout.pickerY).toBe(1 + 21 - 10);
    expect(layout.overlayRows).toBe(0);
  });
});
