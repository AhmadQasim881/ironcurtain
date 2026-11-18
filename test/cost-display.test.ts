import { describe, expect, it } from 'vitest';
import { formatCostAgainstLimit, formatCostSummary, formatCostUsd } from '../src/session/cost-display.js';

describe('cost display', () => {
  it('formats a known cost in dollars', () => {
    expect(formatCostUsd(1.234)).toBe('$1.23');
    expect(formatCostUsd(0.5, 'observed')).toBe('$0.50');
    expect(formatCostUsd(0.5, 'reported')).toBe('$0.50');
  });

  it('says "unknown" instead of $0.00 when nothing reported a cost', () => {
    expect(formatCostUsd(0, 'unknown')).toBe('unknown');
    expect(formatCostSummary(0, 'unknown')).toBe('cost unknown');
    expect(formatCostAgainstLimit(0, 'unknown', 5)).toBe('unknown (limit $5.00)');
    expect(formatCostAgainstLimit(0, 'unknown', null)).toBe('unknown (no limit)');
  });

  it('marks a partial cost as a lower bound', () => {
    expect(formatCostUsd(0.42, 'partial')).toBe('≥ $0.42');
    expect(formatCostSummary(0.42, 'partial')).toBe('≥ $0.42');
    expect(formatCostAgainstLimit(1, 'partial', 4)).toBe('≥ $1.00 / $4.00 (25%)');
  });

  it('keeps the estimate style for known costs', () => {
    expect(formatCostSummary(0.42)).toBe('~$0.42');
    expect(formatCostAgainstLimit(1, undefined, 4)).toBe('$1.00 / $4.00 (25%)');
    expect(formatCostAgainstLimit(1, 'observed', null)).toBe('$1.00 (no limit)');
  });
});
