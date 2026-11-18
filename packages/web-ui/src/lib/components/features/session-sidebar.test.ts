import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import SessionSidebar from './session-sidebar.svelte';
import { mockSession } from '../../__tests__/fixtures.js';
import type { CreateSessionOptions, PersonaListItem, SessionDto } from '$lib/types.js';

function makePersona(overrides: Partial<PersonaListItem> = {}): PersonaListItem {
  return {
    name: 'coder',
    description: 'Code-focused persona',
    compiled: true,
    ...overrides,
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    sessions: new Map<number, SessionDto>(),
    selectedLabel: null,
    onselect: vi.fn(),
    oncreate: vi.fn<(opts: CreateSessionOptions) => void>(),
    creating: false,
    createError: '',
    loadPersonasFn: vi.fn<() => Promise<PersonaListItem[]>>().mockResolvedValue([]),
    loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ...overrides,
  };
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows launch options and loads personas/provider profiles without creating a session', async () => {
    const loadPersonasFn = vi
      .fn<() => Promise<PersonaListItem[]>>()
      .mockResolvedValue([
        makePersona({ name: 'coder', compiled: true }),
        makePersona({ name: 'draft', compiled: false }),
      ]);
    const loadProviderProfilesFn = vi.fn<() => Promise<string[]>>().mockResolvedValue(['work']);

    render(SessionSidebar, { props: makeProps({ loadPersonasFn, loadProviderProfilesFn }) });

    expect(screen.getByText('Launch options')).toBeTruthy();
    expect(screen.getByTestId('launch-persona')).toBeTruthy();
    expect(screen.getByTestId('launch-workspace')).toBeTruthy();
    expect(screen.getByTestId('launch-provider')).toBeTruthy();
    expect(screen.getByTestId('launch-model')).toBeTruthy();
    expect(screen.getByTestId('launch-start')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(screen.queryByTestId('persona-default')).toBeNull();
    await waitFor(() => {
      expect(loadPersonasFn).toHaveBeenCalledTimes(1);
      expect(loadProviderProfilesFn).toHaveBeenCalledTimes(1);
    });

    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((option) => option.value === 'coder')).toBe(true);
    });

    const draftOption = Array.from(personaSelect.options).find((option) => option.value === 'draft');
    expect(draftOption?.disabled).toBe(true);

    const providerSelect = screen.getByTestId('launch-provider') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(providerSelect.options).some((option) => option.value === 'work')).toBe(true);
    });
  });

  it('disables a persona whose compiled policy is stale (the daemon would refuse it)', async () => {
    const loadPersonasFn = vi
      .fn<() => Promise<PersonaListItem[]>>()
      .mockResolvedValue([
        makePersona({ name: 'coder', compiled: true }),
        makePersona({ name: 'edited', compiled: true, stale: 'constitution' }),
      ]);
    render(SessionSidebar, { props: makeProps({ loadPersonasFn }) });

    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((option) => option.value === 'edited')).toBe(true);
    });
    const options = Array.from(personaSelect.options);
    const edited = options.find((option) => option.value === 'edited');
    expect(edited?.disabled).toBe(true);
    expect(edited?.textContent).toMatch(/\(policy stale\)/);
    const coder = options.find((option) => option.value === 'coder');
    expect(coder?.disabled).toBe(false);
    expect(coder?.textContent).not.toMatch(/stale/);
  });

  it('does not create when selecting launch options and submits only from start session', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(SessionSidebar, {
      props: makeProps({
        oncreate,
        loadPersonasFn: vi
          .fn<() => Promise<PersonaListItem[]>>()
          .mockResolvedValue([makePersona({ name: 'coder', compiled: true })]),
        loadProviderProfilesFn: vi.fn<() => Promise<string[]>>().mockResolvedValue(['ops']),
      }),
    });

    const personaSelect = screen.getByTestId('launch-persona') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(personaSelect.options).some((option) => option.value === 'coder')).toBe(true);
    });

    await fireEvent.change(personaSelect, { target: { value: 'coder' } });
    await fireEvent.input(screen.getByTestId('launch-workspace'), { target: { value: '  /tmp/workspace  ' } });
    await fireEvent.change(screen.getByTestId('launch-provider'), { target: { value: 'ops' } });
    await fireEvent.input(screen.getByTestId('launch-model'), { target: { value: '  gpt-5  ' } });
    expect(oncreate).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate).toHaveBeenCalledWith({
      persona: 'coder',
      workspacePath: '/tmp/workspace',
      providerProfileName: 'ops',
      model: 'gpt-5',
    });
  });

  it('uses the blank persona option as the default and omits empty launch fields', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(SessionSidebar, { props: makeProps({ oncreate }) });

    await fireEvent.click(screen.getByTestId('launch-start'));

    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate).toHaveBeenCalledWith({});
  });

  it('ignores native form submit while a session is already being created', async () => {
    const oncreate = vi.fn<(opts: CreateSessionOptions) => void>();
    render(SessionSidebar, { props: makeProps({ creating: true, oncreate }) });

    await fireEvent.submit(screen.getByTestId('session-launch-form'));

    expect(oncreate).not.toHaveBeenCalled();
  });

  it('still selects existing sessions from the list', async () => {
    const onselect = vi.fn();
    render(SessionSidebar, {
      props: makeProps({
        sessions: new Map([[3, mockSession(3, { source: { kind: 'web-pty' } })]]),
        onselect,
      }),
    });

    await fireEvent.click(screen.getByTestId('session-item-3'));

    expect(onselect).toHaveBeenCalledWith(3);
  });

  it('marks partial session token totals and omits tokens when they cannot be observed', () => {
    const budget = mockSession(5).budget;
    render(SessionSidebar, {
      props: makeProps({
        sessions: new Map([
          [
            5,
            mockSession(5, {
              turnCount: 2,
              budget: {
                ...budget,
                totalTokens: 4200,
                tokenTrackingStatus: 'partial',
                observedExchanges: 3,
                incompleteExchanges: 1,
              },
            }),
          ],
          [6, mockSession(6, { budget: { ...budget, totalTokens: 1500 } })],
          [
            7,
            mockSession(7, {
              budget: { ...budget, tokenTrackingAvailable: false, tokenTrackingStatus: 'unavailable' },
            }),
          ],
          [8, mockSession(8, { budget: { ...budget, tokenTrackingStatus: 'partial', observedExchanges: 0 } })],
        ]),
      }),
    });

    expect(screen.getByTestId('session-usage-5').textContent).toContain(`≥${(4200).toLocaleString()} tokens`);
    expect(screen.getByTestId('session-usage-6').textContent).toContain(`${(1500).toLocaleString()} tokens`);
    expect(screen.getByTestId('session-usage-6').textContent).not.toContain('≥');
    expect(screen.getByTestId('session-usage-7').textContent).not.toContain('tokens');
    expect(screen.getByTestId('session-usage-8').textContent).toContain('no exchanges observed yet');
  });

  it('shows the session cost with its source: unknown, a lower bound, or the amount', () => {
    const budget = mockSession(1).budget;
    render(SessionSidebar, {
      props: makeProps({
        sessions: new Map([
          [1, mockSession(1, { budget: { ...budget, estimatedCostUsd: 0, costSource: 'unknown' } })],
          [2, mockSession(2, { budget: { ...budget, estimatedCostUsd: 0.4, costSource: 'partial' } })],
          [3, mockSession(3, { budget: { ...budget, estimatedCostUsd: 1.25 } })],
        ]),
      }),
    });

    expect(screen.getByTestId('session-usage-1').textContent).toContain('unknown');
    expect(screen.getByTestId('session-usage-1').textContent).not.toContain('$0.00');
    expect(screen.getByTestId('session-usage-2').textContent).toContain('≥ $0.40');
    expect(screen.getByTestId('session-usage-3').textContent).toContain('$1.25');
  });

  it('shows a live stopping state for sessions awaiting process exit', () => {
    render(SessionSidebar, {
      props: makeProps({
        selectedLabel: 4,
        sessions: new Map([[4, mockSession(4, { source: { kind: 'web-pty' }, status: 'stopping' })]]),
      }),
    });

    const stoppingStatus = screen.getByTestId('session-stopping-status');
    expect(stoppingStatus.textContent).toContain('Stopping…');
    expect(stoppingStatus.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
