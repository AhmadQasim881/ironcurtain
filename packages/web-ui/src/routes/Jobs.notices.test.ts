import { render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';

vi.mock('../lib/stores.svelte.js', () => ({
  appState: {
    jobs: [
      {
        job: { id: 'example', name: 'Example', enabled: true, schedule: '0 9 * * *' },
        lastRun: {
          outcome: { kind: 'success' },
          budget: { estimatedCostUsd: 0 },
          notices: ['Example host-file warning\u0007.\nInspect /workspace/example.'],
        },
        isRunning: false,
        nextRun: null,
        consecutiveFailures: 0,
      },
    ],
  },
  runJob: vi.fn(),
  enableJob: vi.fn(),
  disableJob: vi.fn(),
  removeJob: vi.fn(),
  recompileJob: vi.fn(),
}));

import Jobs from './Jobs.svelte';

it('shows a completed run notice even when the run succeeded, with controls visible', () => {
  render(Jobs);
  expect(screen.getByRole('alert').textContent).toContain('Example host-file warning\\u0007.');
  expect(screen.getByRole('alert').textContent).toContain('Inspect /workspace/example.');
});
