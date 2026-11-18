import { afterAll, describe, expect, it, vi } from 'vitest';

// Exercise the renderer's terminal-capable branch without opening a terminal.
const previousCapability = vi.hoisted(() => {
  const previous = process.env.FORCE_HYPERLINK;
  process.env.FORCE_HYPERLINK = '1';
  return previous;
});

import { renderAgentMarkdown } from '../src/session/cli-transport.js';

afterAll(() => {
  if (previousCapability === undefined) delete process.env.FORCE_HYPERLINK;
  else process.env.FORCE_HYPERLINK = previousCapability;
});

describe('terminal markdown destinations', () => {
  it('prints a link destination beside its label even when hyperlinks are supported', () => {
    const rendered = renderAgentMarkdown('[Reference](https://example.invalid/reference)');
    expect(rendered).toContain('Reference');
    expect(rendered).toContain('https://example.invalid/reference');
    expect(rendered).not.toContain('\u001b]8;');
  });

  it('keeps custom destinations inert and shows image destinations', () => {
    const rendered = renderAgentMarkdown(
      '[Local reference](notes:reference)\n\n![Diagram](https://example.invalid/diagram.png)',
    );
    expect(rendered).toContain('notes:reference');
    expect(rendered).toContain('https://example.invalid/diagram.png');
    expect(rendered).toContain('Diagram');
    expect(rendered).not.toContain('\u001b]8;');
  });

  it('makes hidden destination characters visible without losing ordinary markdown', () => {
    const rendered = renderAgentMarkdown('**Reference** [Details](https://example.invalid/a\u034fb)');
    expect(rendered).toContain('Reference');
    expect(rendered).toContain('https://example.invalid/a\\u034fb');
    expect(rendered).not.toContain('\u034f');
    expect(rendered).not.toContain('\u001b]8;');
  });
});
