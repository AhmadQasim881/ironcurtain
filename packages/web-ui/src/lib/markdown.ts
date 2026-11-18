/**
 * Markdown rendering for agent-written text.
 *
 * Everything rendered through here is chosen by an agent: workflow artifacts
 * reviewed at a human gate, transition messages, message-log entries, persona
 * constitutions and workflow READMEs. The output lands in the same document
 * as the approval controls, so the renderer is strict:
 *
 * - marked never emits raw HTML. Block and inline `html` tokens are escaped
 *   and shown as text, so hidden markup (comments, hidden divs, `<style>`)
 *   is visible to the reviewer instead of acting on the page.
 * - A dedicated DOMPurify instance (the global default config is untouched)
 *   allows only formatting elements plus the attributes GFM needs: table
 *   `align`, list `start`, and disabled task-list checkboxes. No `style`,
 *   `class` or `id`: the CSP permits inline styles for xterm and Svelte
 *   transitions, so a `<style>` block or `style=` attribute from an agent
 *   could otherwise restyle Approve/Deny or cover the page.
 * - Links keep only `http:`, `https:` and `mailto:` hrefs and open in a new
 *   tab with `rel="noopener noreferrer"`; relative and other schemes lose
 *   their href (the text stays). Images become their alt text and URL as
 *   text; the CSP blocks remote images anyway.
 *
 * `.prose-markdown` (app.css) adds `contain: paint` so even a positioned
 * element that survived could not draw outside its block.
 */

import { Marked, type Tokens } from 'marked';
import DOMPurify, { type Config } from 'dompurify';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Raw HTML in the source is shown, not interpreted. A block keeps its
    // line breaks so the reviewer reads it as written.
    html({ text, block }: Tokens.HTML | Tokens.Tag): string {
      return block ? `<pre>${escapeHtml(text)}</pre>\n` : escapeHtml(text);
    },
    image({ href, text, title }: Tokens.Image): string {
      const label = text !== '' ? text : (title ?? 'image');
      return `<em>[image: ${escapeHtml(label)}] ${escapeHtml(href)}</em>`;
    },
  },
});

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  's',
  'del',
  'ins',
  'sup',
  'sub',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  // Only as a disabled checkbox (GFM task list); enforced by the hook below.
  'input',
];

const ALLOWED_ATTR = ['href', 'title', 'align', 'start', 'type', 'checked', 'disabled'];

const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // `<style>` content is dropped with the element (DOMPurify's default
  // FORBID_CONTENTS covers style/script); other removed elements keep their
  // text so the reviewer still sees what the agent wrote.
  KEEP_CONTENT: true,
};

const purifier = DOMPurify(typeof window === 'undefined' ? undefined : window);

function isAllowedLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Relative URLs would navigate the SPA; agent text has no business doing that.
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
}

purifier.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') return;
  const element = node as Element;
  const isTaskCheckbox = element.getAttribute('type') === 'checkbox' && element.hasAttribute('disabled');
  if (!isTaskCheckbox) node.parentNode?.removeChild(node);
});

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return;
  const element = node as Element;
  const href = element.getAttribute('href');
  if (href === null) return;
  if (!isAllowedLink(href)) {
    element.removeAttribute('href');
    return;
  }
  element.setAttribute('target', '_blank');
  element.setAttribute('rel', 'noopener noreferrer');
});

/**
 * The DOMPurify step of {@link renderMarkdown}: the strict allowlist plus the
 * link and checkbox rules above. Exported so tests can exercise it directly;
 * through renderMarkdown, marked has already escaped any markup the agent
 * wrote, so this is the backstop for marked's own output.
 */
export function sanitizeMarkdownHtml(html: string): string {
  // DOMPurify returns its input unchanged when it has no DOM to work with;
  // fail closed instead and show the markup as text.
  if (!purifier.isSupported) return escapeHtml(html);
  return purifier.sanitize(html, PURIFY_CONFIG);
}

/**
 * Renders markdown text to sanitized HTML.
 * Safe for use with {@html ...} in Svelte templates.
 */
export function renderMarkdown(text: string): string {
  if (!purifier.isSupported) return `<pre>${escapeHtml(text)}</pre>`;
  return sanitizeMarkdownHtml(markdown.parse(text, { async: false }) as string);
}
