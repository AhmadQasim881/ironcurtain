import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import GateReviewPanel from './gate-review-panel.svelte';
import type { HumanGateRequestDto, ArtifactContentDto, FileContentResponseDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeGate(overrides: Partial<HumanGateRequestDto> = {}): HumanGateRequestDto {
  return {
    gateId: 'gate-1',
    workflowId: 'wf-1',
    stateName: 'plan_review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'],
    presentedArtifacts: [],
    summary: 'Please review the implementation plan.',
    ...overrides,
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    gate: makeGate(),
    workflowName: 'My Workflow',
    workflowId: 'wf-1',
    onResolve: vi.fn(),
    ...overrides,
  };
}

/**
 * Builds the artifact fetchers from a map of artifact name -> file path ->
 * content, mirroring the daemon: `fetchArtifacts` returns names and sizes
 * only, `fetchArtifactFile` returns one file's content.
 */
function makeArtifactFetchers(artifacts: Record<string, Record<string, string>>, truncated = false) {
  const fetchArtifacts = vi.fn(async (_workflowId: string, name: string): Promise<ArtifactContentDto> => ({
    files: Object.entries(artifacts[name] ?? {}).map(([path, content]) => ({ path, size: content.length })),
    truncated,
  }));
  const fetchArtifactFile = vi.fn(
    async (_workflowId: string, name: string, path: string): Promise<FileContentResponseDto> => {
      const content = artifacts[name]?.[path];
      if (content === undefined) throw new Error(`no such file ${path}`);
      return { content, language: path.endsWith('.md') ? 'markdown' : 'text' };
    },
  );
  return { fetchArtifacts, fetchArtifactFile };
}

/** The clickable row for a listed artifact file. */
function fileToggle(path: string): HTMLElement {
  const toggle = screen.getByText(path).closest('button');
  expect(toggle, `expected a row for ${path}`).toBeTruthy();
  return toggle as HTMLElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GateReviewPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Switch to the Artifacts tab, disambiguating from the summary heading. */
  async function switchToArtifactsTab() {
    const buttons = screen.getAllByText(/Artifacts/);
    const tabButton = buttons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    expect(tabButton, 'Artifacts tab button should exist').toBeTruthy();
    await fireEvent.click(tabButton!);
  }

  // ── Header rendering ──────────────────────────────────────────────

  it('renders the gate state name and workflow name in the header', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Review Required: plan_review')).toBeTruthy();
    expect(screen.getByText('My Workflow')).toBeTruthy();
    expect(screen.getByText('Waiting for Review')).toBeTruthy();
  });

  // ── Summary tab ───────────────────────────────────────────────────

  it('shows the gate summary text on the summary tab', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Please review the implementation plan.')).toBeTruthy();
  });

  it('shows artifact badges on the summary tab when presentedArtifacts exist', () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('tests')).toBeTruthy();
    expect(screen.getByText('Artifacts')).toBeTruthy();
  });

  // ── Action buttons (all events) ──────────────────────────────────

  it('renders all four action buttons when all events are accepted', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Request Revision')).toBeTruthy();
    expect(screen.getByText('Replan')).toBeTruthy();
    expect(screen.getByText('Abort Workflow')).toBeTruthy();
  });

  it('hides action buttons for events not in acceptedEvents', () => {
    const gate = makeGate({ acceptedEvents: ['APPROVE'] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.queryByText('Request Revision')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();
    expect(screen.queryByText('Abort Workflow')).toBeNull();
  });

  // ── Approve flow ──────────────────────────────────────────────────

  it('keeps a held gate visible but disables approval while its review is unavailable', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve, reviewAvailable: false }) });
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await fireEvent.click(approve);
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByText('Abort Workflow')).toBeTruthy();
  });

  it('calls onResolve with APPROVE when Approve is clicked', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await vi.advanceTimersByTimeAsync(750);
    await fireEvent.click(screen.getByText('Approve'));
    expect(onResolve).toHaveBeenCalledWith('gate-1', 'APPROVE');
    vi.useRealTimers();
  });

  // ── Replan flow ───────────────────────────────────────────────────

  it('shows feedback form on first click of Replan, does not call onResolve yet', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Replan'));

    expect(screen.getByLabelText('Replan feedback')).toBeTruthy();
    expect(screen.getByPlaceholderText('Describe what should be changed...')).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('submits replan feedback when Submit Replan is clicked with text', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Replan'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: 'Rethink the design approach' } });

    await fireEvent.click(screen.getByText('Submit Replan'));

    expect(onResolve).toHaveBeenCalledWith('gate-1', 'REPLAN', 'Rethink the design approach');
  });

  it('keeps Submit Replan disabled with empty feedback', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Replan'));

    const submitBtn = screen.getByText('Submit Replan');
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  // ── Force Revision flow ───────────────────────────────────────────

  it('shows feedback form on first click of Request Revision, does not call onResolve yet', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    expect(screen.getByLabelText('Revision feedback')).toBeTruthy();
    expect(screen.getByPlaceholderText('Describe what should be changed...')).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('submits feedback when Submit Revision is clicked with text', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: 'Add more tests' } });

    await fireEvent.click(screen.getByText('Submit Revision'));

    expect(onResolve).toHaveBeenCalledWith('gate-1', 'FORCE_REVISION', 'Add more tests');
  });

  it('does not submit when feedback textarea is empty', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const submitBtn = screen.getByText('Submit Revision');
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  it('cancels the feedback form when Cancel is clicked', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Request Revision'));
    expect(screen.getByLabelText('Revision feedback')).toBeTruthy();

    await fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByLabelText('Revision feedback')).toBeNull();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  // ── Abort flow ────────────────────────────────────────────────────

  it('shows confirmation dialog on first click of Abort Workflow', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Abort Workflow'));

    expect(
      screen.getByText('Are you sure you want to abort this workflow? This action cannot be undone.'),
    ).toBeTruthy();
    expect(screen.getByText('Confirm Abort')).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('calls onResolve with ABORT on Confirm Abort click', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Abort Workflow'));
    await fireEvent.click(screen.getByText('Confirm Abort'));

    expect(onResolve).toHaveBeenCalledWith('gate-1', 'ABORT');
  });

  it('cancels the abort confirmation when Cancel is clicked', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Abort Workflow'));
    expect(screen.getByText('Confirm Abort')).toBeTruthy();

    // There are two Cancel buttons potentially -- pick the one in the abort confirmation
    const cancelButtons = screen.getAllByText('Cancel');
    await fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    expect(screen.queryByText('Confirm Abort')).toBeNull();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  // ── Tab navigation ────────────────────────────────────────────────

  it('shows Summary tab by default', () => {
    render(GateReviewPanel, { props: makeProps() });

    const summaryTab = screen.getByText('Summary');
    expect(summaryTab).toBeTruthy();
  });

  it('does not show Artifacts tab when no artifacts or fetchArtifacts', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.queryByText('Artifacts', { selector: 'button' })).toBeNull();
  });

  it('shows Artifacts tab when presentedArtifacts exist and fetchArtifacts is provided', () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const fetchArtifacts = vi.fn();
    render(GateReviewPanel, { props: makeProps({ gate, fetchArtifacts }) });

    // The Artifacts tab button should exist (not the "Artifacts" heading in summary)
    const buttons = screen.getAllByText(/Artifacts/);
    const tabButton = buttons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    expect(tabButton).toBeTruthy();
  });

  it('shows Files tab when fetchFileTree and fetchFileContent are provided', () => {
    const fetchFileTree = vi.fn();
    const fetchFileContent = vi.fn();
    render(GateReviewPanel, { props: makeProps({ fetchFileTree, fetchFileContent }) });

    expect(screen.getByText('Files')).toBeTruthy();
  });

  it('does not show Files tab when fetchFileTree is not provided', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.queryByText('Files')).toBeNull();
  });

  // ── Artifacts tab: loading and rendering ──────────────────────────

  it('loads and displays artifact content with markdown rendering using prose-markdown class', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const fetchers = makeArtifactFetchers({ plan: { 'plan.md': '# My Plan\n\nThis is the **plan**.' } });

    render(GateReviewPanel, {
      props: makeProps({ gate, ...fetchers }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // The first file of an artifact is opened eagerly (one fetch for its content).
    await vi.waitFor(() => {
      const markdownContainer = screen.getByText('plan.md').closest('.border')?.querySelector('.prose-markdown');
      expect(markdownContainer).toBeTruthy();
      expect(markdownContainer?.querySelector('h1')?.textContent).toBe('My Plan');
      expect(markdownContainer?.querySelector('strong')?.textContent).toBe('plan');
    });
    expect(fetchers.fetchArtifactFile).toHaveBeenCalledWith('wf-1', 'plan', 'plan.md');
  });

  it('renders non-markdown artifact files as code blocks without prose-markdown', async () => {
    const gate = makeGate({ presentedArtifacts: ['code'] });
    const fetchers = makeArtifactFetchers({ code: { 'main.ts': 'const x = 1;' } });

    render(GateReviewPanel, {
      props: makeProps({ gate, ...fetchers }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('const x = 1;').closest('code')).toBeTruthy();
    });

    const fileContainer = screen.getByText('main.ts').closest('.border');
    expect(fileContainer?.querySelector('.prose-markdown')).toBeNull();
  });

  // ── Artifacts tab: listing-only RPC + lazy per-file loading (WP-32) ───
  //
  // `workflows.artifacts` returns names and sizes; a file's content is fetched
  // through `workflows.artifactFile` when its row is opened. The first file
  // opens eagerly, every other file waits for a click, so an artifact with
  // many or large files never arrives in one reply.

  it('lists every file with its size but fetches only the first file eagerly', async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const fetchers = makeArtifactFetchers({
      docs: { 'readme.md': '# Readme\n\nWelcome.', 'config.json': '{ "key": "value" }' },
    });

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('readme.md')).toBeTruthy();
      expect(screen.getByText('config.json')).toBeTruthy();
    });
    const sizes = screen.getAllByTestId('artifact-file-size').map((el) => el.textContent?.trim());
    // '# Readme\n\nWelcome.' and '{ "key": "value" }' are 18 bytes each.
    expect(sizes).toEqual(['18 B', '18 B']);

    await vi.waitFor(() => {
      expect(screen.getByText('readme.md').closest('.border')?.querySelector('h1')?.textContent).toBe('Readme');
    });
    expect(fetchers.fetchArtifactFile).toHaveBeenCalledTimes(1);
    expect(fetchers.fetchArtifactFile).toHaveBeenCalledWith('wf-1', 'docs', 'readme.md');
    expect(screen.queryByText('{ "key": "value" }')).toBeNull();
  });

  it('loads a file when its row is clicked and does not refetch it when reopened', async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const fetchers = makeArtifactFetchers({
      docs: { 'readme.md': '# Readme', 'config.json': '{ "key": "value" }' },
    });

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();
    await vi.waitFor(() => expect(screen.getByText('config.json')).toBeTruthy());

    await fireEvent.click(fileToggle('config.json'));
    await vi.waitFor(() => {
      expect(screen.getByText('{ "key": "value" }').closest('code')).toBeTruthy();
    });
    expect(fetchers.fetchArtifactFile).toHaveBeenCalledWith('wf-1', 'docs', 'config.json');

    // Collapse and reopen: the cached content is shown without another fetch.
    await fireEvent.click(fileToggle('config.json'));
    expect(screen.queryByText('{ "key": "value" }')).toBeNull();
    await fireEvent.click(fileToggle('config.json'));
    await vi.waitFor(() => expect(screen.getByText('{ "key": "value" }')).toBeTruthy());
    const configCalls = fetchers.fetchArtifactFile.mock.calls.filter((call) => call[2] === 'config.json');
    expect(configCalls).toHaveLength(1);
  });

  it('shows a notice when the daemon truncated the artifact listing', async () => {
    const gate = makeGate({ presentedArtifacts: ['big'] });
    const fetchers = makeArtifactFetchers({ big: { 'a.txt': 'a', 'b.txt': 'b' } }, true);

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByTestId('artifact-truncated').textContent).toContain('Listing truncated');
    });
  });

  it('shows a per-file error when a file fails to load, keeping the rest of the listing usable', async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const fetchers = makeArtifactFetchers({ docs: { 'ok.md': '# Fine', 'broken.txt': 'x' } });
    fetchers.fetchArtifactFile.mockImplementation(async (_wf: string, _name: string, path: string) => {
      if (path === 'broken.txt') throw new Error('Connection closed');
      return { content: '# Fine', language: 'markdown' };
    });

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();
    await vi.waitFor(() => expect(screen.getByText('broken.txt')).toBeTruthy());

    await fireEvent.click(fileToggle('broken.txt'));
    await vi.waitFor(() => {
      expect(screen.getByText('Failed to load file: Connection closed')).toBeTruthy();
    });
    expect(screen.getByText('ok.md').closest('.border')?.querySelector('h1')?.textContent).toBe('Fine');
  });

  it("shows the daemon's display message for a file it refused to serve", async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const fetchers = makeArtifactFetchers({ docs: { 'huge.bin': 'x' } });
    fetchers.fetchArtifactFile.mockResolvedValue({ error: 'File too large to display (>1MB)' });

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('File too large to display (>1MB)')).toBeTruthy();
    });
  });

  it('shows error when artifact loading fails', async () => {
    const gate = makeGate({ presentedArtifacts: ['broken'] });
    const fetchArtifacts = vi.fn().mockRejectedValue(new Error('Network error'));

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('Failed to load artifact.')).toBeTruthy();
    });
  });

  it('retries a failed artifact listing on request', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const fetchers = makeArtifactFetchers({ plan: { 'plan.md': '# Recovered' } });
    fetchers.fetchArtifacts.mockRejectedValueOnce(new Error('Connection closed'));

    render(GateReviewPanel, { props: makeProps({ gate, ...fetchers }) });
    await switchToArtifactsTab();
    await vi.waitFor(() => expect(screen.getByText('Failed to load artifact.')).toBeTruthy());

    await fireEvent.click(screen.getByTestId('artifact-retry'));
    await vi.waitFor(() => {
      expect(screen.getByText('plan.md').closest('.border')?.querySelector('h1')?.textContent).toBe('Recovered');
    });
    expect(fetchers.fetchArtifacts).toHaveBeenCalledTimes(2);
  });

  // ── Multiple artifacts selection ──────────────────────────────────

  it('allows switching between multiple artifacts', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    const { fetchArtifacts, fetchArtifactFile } = makeArtifactFetchers({
      plan: { 'plan.md': '# Plan' },
      tests: { 'test.ts': 'test code' },
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts, fetchArtifactFile }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // Click the second artifact selector
    const selectorButtons = screen.getAllByText('tests');
    const testsSelector = selectorButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(testsSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('test.ts')).toBeTruthy();
    });

    expect(fetchArtifacts).toHaveBeenCalledWith('wf-1', 'plan');
    expect(fetchArtifacts).toHaveBeenCalledWith('wf-1', 'tests');
  });

  // ── Artifact empty state ────────────────────────────────────────

  it('shows "No files in this artifact." when artifact has zero files', async () => {
    const gate = makeGate({ presentedArtifacts: ['empty-artifact'] });
    const fetchArtifacts = vi.fn().mockResolvedValue({ files: [], truncated: false });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('No files in this artifact.')).toBeTruthy();
    });
  });

  // ── Action buttons hidden during feedback/abort ─────────────────

  it('hides action buttons when the feedback form is open', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Request Revision'));

    // The main action buttons should be hidden
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();
    expect(screen.queryByText('Abort Workflow')).toBeNull();

    // The feedback controls should be visible
    expect(screen.getByText('Submit Revision')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('hides action buttons when the abort confirmation is open', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Abort Workflow'));

    // The main action buttons should be hidden
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Request Revision')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();

    // The confirmation controls should be visible
    expect(screen.getByText('Confirm Abort')).toBeTruthy();
  });

  // ── Feedback text trimming ──────────────────────────────────────

  it('trims whitespace-only feedback and keeps submit disabled', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: '   ' } });

    const submitBtn = screen.getByText('Submit Revision');
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  it('trims feedback text before sending to onResolve', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: '  Fix the bug  ' } });

    await fireEvent.click(screen.getByText('Submit Revision'));

    expect(onResolve).toHaveBeenCalledWith('gate-1', 'FORCE_REVISION', 'Fix the bug');
  });

  // ── Artifact tab count display ──────────────────────────────────

  it('shows artifact count next to the Artifacts tab label', () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests', 'docs'] });
    const fetchArtifacts = vi.fn();
    render(GateReviewPanel, { props: makeProps({ gate, fetchArtifacts }) });

    expect(screen.getByText('(3)')).toBeTruthy();
  });

  // ── No summary text ────────────────────────────────────────────

  it('does not render summary paragraph when gate.summary is empty', () => {
    const gate = makeGate({ summary: '' });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    // The summary text should not be present -- the panel still renders
    expect(screen.getByText('Review Required: plan_review')).toBeTruthy();
    // There should be no paragraph with empty content for summary
    expect(screen.queryByText('Please review the implementation plan.')).toBeNull();
  });

  // ── No artifact badges on summary when artifacts are empty ──────

  it('does not show "Artifacts" section on summary tab when presentedArtifacts is empty', () => {
    const gate = makeGate({ presentedArtifacts: [] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    // The uppercase "Artifacts" section heading should not appear
    // (only the tab button would show "Artifacts" if fetchArtifacts is given)
    expect(screen.queryByText('Artifacts')).toBeNull();
  });

  // ── Caching: artifact is not re-fetched on re-select ────────────

  it('does not re-fetch an already loaded artifact when re-selected', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    const { fetchArtifacts, fetchArtifactFile } = makeArtifactFetchers({
      plan: { 'plan.md': '# Plan' },
      tests: { 'test.ts': 'test code' },
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts, fetchArtifactFile }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // Switch to second artifact
    const selectorButtons = screen.getAllByText('tests');
    const testsSelector = selectorButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(testsSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('test.ts')).toBeTruthy();
    });

    // Switch back to first artifact
    const planButtons = screen.getAllByText('plan');
    const planSelector = planButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(planSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    const planCalls = fetchArtifacts.mock.calls.filter((call: unknown[]) => call[1] === 'plan');
    expect(planCalls.length).toBe(1);
  });

  // ── Artifact with multiple files ────────────────────────────────

  it('renders every file of a single artifact once each row has been opened', async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const fetchers = makeArtifactFetchers({
      docs: { 'readme.md': '# Readme\n\nWelcome.', 'config.json': '{ "key": "value" }' },
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, ...fetchers }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('readme.md')).toBeTruthy();
      expect(screen.getByText('config.json')).toBeTruthy();
    });

    await vi.waitFor(() => {
      const readmeContainer = screen.getByText('readme.md').closest('.border')?.querySelector('.prose-markdown');
      expect(readmeContainer?.querySelector('h1')?.textContent).toBe('Readme');
    });

    // The second file loads on demand.
    await fireEvent.click(fileToggle('config.json'));
    await vi.waitFor(() => {
      expect(screen.getByText('{ "key": "value" }').closest('code')).toBeTruthy();
    });
  });

  // ── Single artifact does not show selector buttons ──────────────

  it('does not show artifact selector buttons when there is only one artifact', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const { fetchArtifacts, fetchArtifactFile } = makeArtifactFetchers({ plan: { 'plan.md': '# Plan' } });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts, fetchArtifactFile }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // With only one artifact, there should be no selector button row
    // (the artifact content should render directly without selection UI)
    // The "plan" text appears as a badge in summary but not as a selector button in artifacts tab
    const planElements = screen.queryAllByText('plan');
    const selectorButton = planElements.find((el) => el.closest('button') && el.closest('.space-y-3'));
    expect(selectorButton).toBeUndefined();
  });
});

describe('gate approval arming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function advance(ms = 750): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await tick();
  }

  it('requires a full stable 750ms review while abort remains available', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    const approve = screen.getByRole('button', { name: 'Approve' });
    await fireEvent.click(approve);
    await advance(749);
    await fireEvent.click(approve);
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Abort Workflow' })).toHaveProperty('disabled', false);
    await advance(1);
    await fireEvent.pointerDown(approve);
    await fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('gate-1', 'APPROVE');
  });

  it.each(['pointer', 'keyboard'])('refuses a %s press begun before arming', async (kind) => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    const approve = screen.getByRole('button', { name: 'Approve' });
    if (kind === 'pointer') await fireEvent.pointerDown(approve);
    else await fireEvent.keyDown(approve, { key: ' ' });
    await advance();
    await fireEvent.mouseDown(approve);
    await fireEvent.click(approve);
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.pointerDown(approve);
    await fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('refuses a pointer click with no press recorded by the displayed review', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await advance();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await fireEvent.click(approve, { detail: 1 });
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.pointerDown(approve);
    await fireEvent.click(approve, { detail: 1 });
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('restarts for a changed gate, accepted events, or refresh signal and resets drafts', async () => {
    const onResolve = vi.fn();
    const props = makeProps({ onResolve });
    const view = render(GateReviewPanel, { props });
    await advance();
    await fireEvent.click(screen.getByRole('button', { name: 'Request Revision' }));
    await fireEvent.input(screen.getByLabelText('Revision feedback'), { target: { value: 'Review notes' } });
    await view.rerender({ ...props, gate: makeGate({ acceptedEvents: ['APPROVE', 'ABORT'] }) });
    expect(screen.queryByLabelText('Revision feedback')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    await advance();
    await view.rerender({ ...props, gate: makeGate({ gateId: 'gate-2' }), refreshSignal: 'refreshed' });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    await advance();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('gate-2', 'APPROVE');
  });

  it('restarts after focus and visibility interruptions', async () => {
    const onResolve = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await advance();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }));
    window.dispatchEvent(new Event('blur'));
    await advance();
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    await advance(749);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance();
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('restarts when the approval row moves and ignores repeated keyboard activation', async () => {
    let top = 10;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, top, 100, 30));
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await advance();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }));
    top = 20;
    await advance(16);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    await advance();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await fireEvent.click(approve);
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.keyDown(approve, { key: 'Enter', repeat: true });
    await fireEvent.click(approve);
    expect(onResolve).not.toHaveBeenCalled();
    await fireEvent.keyDown(approve, { key: 'Enter' });
    await fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it.each(['refreshSignal', 'layoutSignal'])('restarts for a %s change on the same gate', async (key) => {
    const onResolve = vi.fn();
    const props = makeProps({ onResolve });
    const view = render(GateReviewPanel, { props });
    await advance();
    await view.rerender({ ...props, [key]: 'next' });
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    await advance();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Approve' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('requires a fresh delay when an initially unfocused review returns to the foreground', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await advance();
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    await advance(749);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).not.toHaveBeenCalled();
    await advance(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('allows only one submission while resolution is pending', async () => {
    let finish!: () => void;
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(GateReviewPanel, { props: makeProps({ onResolve }) });
    await advance();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await fireEvent.click(approve);
    await fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledTimes(1);
    finish();
    await tick();
  });
});
