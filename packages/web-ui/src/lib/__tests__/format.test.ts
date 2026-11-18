import { describe, expect, it } from 'vitest';
import { formatCostUsd } from '../format.js';

describe('formatCostUsd', () => {
  it('shows a known cost in dollars, with or without a source', () => {
    expect(formatCostUsd(1.234)).toBe('$1.23');
    expect(formatCostUsd(0.5, 'observed')).toBe('$0.50');
    expect(formatCostUsd(0.5, 'reported')).toBe('$0.50');
  });

  it('marks a partial cost as a lower bound', () => {
    expect(formatCostUsd(0.42, 'partial')).toBe('≥ $0.42');
  });

  it('says "unknown" instead of $0.00 when no cost was reported', () => {
    expect(formatCostUsd(0, 'unknown')).toBe('unknown');
  });
});
