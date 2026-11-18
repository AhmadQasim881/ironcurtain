/**
 * Backlog and design-doc status (DTL-24, DOA-17, DOM-20).
 *
 * docs/MISSING_FEATURES.md is the source of truth for what IronCurtain
 * implements and what is missing. Every design doc under docs/designs/ carries
 * one dated Status line right under its title, so a reader can tell whether it
 * describes shipped code, a partial implementation, a proposal, a replaced
 * design or a historical record. These checks keep that true:
 *
 * - every Markdown file under docs/designs/ has a `**Status (YYYY-MM-DD):** <Kind>`
 *   line as the first thing under its title, with a known kind and a real date, and no
 *   older-style `Status:` line left beside it in the header;
 * - the files and design docs those Status lines name exist;
 * - every MISSING_FEATURES.md entry carries one status, and the code it points
 *   at exists;
 * - relative links in the design docs and the backlog files resolve, and
 *   in-page anchors of the backlog files name a heading (test/user-docs.test.ts
 *   checks the anchors of the design docs that describe shipped code);
 * - a document under docs/ that still names removed code (the src/agent/
 *   module, the direct-tool-call path) says in its dated Status line that it
 *   no longer exists, and that code is indeed gone;
 * - the SHA-256 digests the evidence records give for checked-in files match;
 * - a few statements that are easy to get wrong are checked against the code
 *   they describe (the OS sandbox read baseline, the placeholders a release
 *   must fill in, the web UI session views, the `--ensure-daemon` flag, the
 *   lint catalog).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUnverifiedPin, PINNED_MODELS } from '../packages/memory-mcp-server/src/models/manifest.js';
import { listProtectedCredentialStores } from '../src/config/credential-stores.js';
import { SIGNAL_BRIDGE_BUILD_COMMAND, SIGNAL_DEFAULT_IMAGE } from '../src/signal/signal-image.js';
import { BASELINE_CREDENTIAL_DENY_READ } from '../src/trusted-process/sandbox-integration.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGNS = join(ROOT, 'docs', 'designs');

/** The kinds a design doc's Status line may give. */
const DESIGN_STATUS_KINDS = ['Implemented', 'Partial', 'Proposal', 'Superseded', 'Historical', 'Reserved'];

/** The statuses a MISSING_FEATURES.md entry may carry. */
const BACKLOG_STATUS_KINDS = ['Implemented', 'Partial', 'Missing', 'Deferred', 'Superseded', 'Reserved'];

/** Backlog and vision files whose links and anchors are checked with the design docs. */
const BACKLOG_FILES = [
  'docs/MISSING_FEATURES.md',
  'TODO.md',
  'docs/secure-agent-runtime-v2.md',
  'docs/brainstorm-use-cases.md',
];

const STATUS_LINE = /^\*\*Status \((\d{4}-\d{2}-\d{2})\):\*\* ([A-Za-z]+)\b/;
/** A status label of the formats used before the dated line (`Status:`, `**Status:**`, `_Status:`). */
const OLD_STATUS_LABEL = /^(?:\*\*|_)?Status(?:\*\*)?:/;
/** A repository path a document points at, in backticks. */
const REPO_PATH = /^(?:src|test|packages|docker|scripts|docs)\/[\w./-]+$/;
/** A bare Markdown file name in backticks (a sibling design doc or a top-level guide). */
const BARE_DOC = /^[\w.-]+\.md$/;

function listMarkdown(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdown(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

/** The TypeScript sources under a directory, without declaration files and `__tests__` directories. */
function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...listSources(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files.sort();
}

const designDocs = listMarkdown(DESIGNS);

function readLines(path: string): string[] {
  return readFileSync(path, 'utf-8').split('\n');
}

/** Index of the document's title (its first `# ` line, near the top). */
function titleIndex(lines: readonly string[]): number {
  return lines.slice(0, 12).findIndex((line) => line.startsWith('# '));
}

/** The lines between the title and the first `## ` heading. */
function headerLines(lines: readonly string[]): string[] {
  const start = titleIndex(lines) + 1;
  const end = lines.findIndex((line, i) => i >= start && line.startsWith('## '));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** The first non-blank line after the title. */
function lineAfterTitle(lines: readonly string[]): string | undefined {
  return lines.slice(titleIndex(lines) + 1).find((line) => line.trim() !== '');
}

function isRealDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function backtickSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/** Missing files among the repository paths and design-doc names a text points at, relative to `fromDir`. */
function missingPointers(text: string, fromDir: string): string[] {
  const missing: string[] = [];
  for (const span of backtickSpans(text)) {
    if (REPO_PATH.test(span)) {
      if (!existsSync(join(ROOT, span))) missing.push(span);
    } else if (BARE_DOC.test(span)) {
      const candidates = [fromDir, DESIGNS, join(DESIGNS, 'archive'), join(ROOT, 'docs'), ROOT];
      if (!candidates.some((dir) => existsSync(join(dir, span)))) missing.push(span);
    }
  }
  return missing;
}

/** The text of a Markdown file without fenced code blocks and inline code spans. */
function proseOf(path: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of readLines(path)) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined && (fence === undefined || fence === marker)) {
      fence = fence === undefined ? marker : undefined;
      continue;
    }
    if (fence === undefined) kept.push(line.replace(/`[^`]*`/g, ''));
  }
  return kept.join('\n');
}

function linkTargets(path: string): string[] {
  return [...proseOf(path).matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(path: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of proseOf(path).split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1];
    if (heading !== undefined) anchors.add(headingAnchor(heading));
  }
  return anchors;
}

describe('design-doc Status lines', () => {
  it('finds the design docs', () => {
    expect(designDocs.length).toBeGreaterThan(100);
  });

  it.each(designDocs.map((path) => [relative(ROOT, path), path]))(
    '%s starts with a dated Status line of a known kind',
    (_name, path) => {
      const lines = readLines(path);
      expect(titleIndex(lines), 'a `# ` title near the top').toBeGreaterThanOrEqual(0);
      const line = lineAfterTitle(lines) ?? '';
      const match = STATUS_LINE.exec(line);
      expect(match, `first line under the title: ${line.slice(0, 80)}`).not.toBeNull();
      const date = match?.[1] ?? '';
      const kind = match?.[2] ?? '';
      expect(isRealDate(date), `date ${date}`).toBe(true);
      expect(DESIGN_STATUS_KINDS).toContain(kind);

      const header = headerLines(lines);
      expect(header.filter((l) => STATUS_LINE.test(l))).toHaveLength(1);
      expect(
        header.filter((l) => OLD_STATUS_LABEL.test(l)),
        'an older Status line next to the dated one',
      ).toEqual([]);
      expect(missingPointers(line, dirname(path)), 'files the Status line names').toEqual([]);
    },
  );
});

describe('docs/MISSING_FEATURES.md', () => {
  const path = join(ROOT, 'docs', 'MISSING_FEATURES.md');
  const text = readFileSync(path, 'utf-8');

  it('gives every entry one status', () => {
    const entries = text.split('\n').filter((line) => line.startsWith('### '));
    expect(entries.length).toBeGreaterThan(20);
    const statusPattern = new RegExp(` — \\*\\*(${BACKLOG_STATUS_KINDS.join('|')})\\*\\*$`);
    expect(entries.filter((entry) => !statusPattern.test(entry))).toEqual([]);
  });

  it('points only at code and documents that exist', () => {
    expect(missingPointers(text, dirname(path))).toEqual([]);
  });

  it('lists the deferred owner decisions', () => {
    for (const pkg of ['WP-125', 'WP-127', 'WP-128', 'WP-132']) expect(text).toContain(pkg);
  });
});

describe('relative links', () => {
  const files = [...designDocs, ...BACKLOG_FILES.map((file) => join(ROOT, file))];

  it.each(files.map((path) => [relative(ROOT, path), path]))('%s links only to files that exist', (_name, path) => {
    const broken = linkTargets(path)
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
      .filter((target) => !existsSync(resolve(dirname(path), target.split('#')[0])));
    expect(broken).toEqual([]);
  });

  it.each(BACKLOG_FILES.map((file) => [file]))('%s links only to headings that exist', (file) => {
    const path = join(ROOT, file);
    const anchors = anchorsOf(path);
    const broken = linkTargets(path)
      .filter((target) => target.startsWith('#'))
      .filter((target) => !anchors.has(target.slice(1)));
    expect(broken).toEqual([]);
  });
});

/**
 * Code a document may still describe as history, with a pointer in its Status
 * line: the src/agent/ module (the builtin agent loop is `AgentSession`) and
 * the direct-tool-call path (`TrustedProcess` serves only integration tests).
 */
const REMOVED_CODE: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'src/agent/', pattern: /\bsrc\/agent\// },
  { name: 'direct-tool-call', pattern: /direct-tool-call/ },
];

describe('documents that describe removed code', () => {
  // docs/completion/ is the completion effort's own record.
  const completion = join(ROOT, 'docs', 'completion');
  const scanned = listMarkdown(join(ROOT, 'docs'))
    .filter((path) => relative(completion, path).startsWith('..'))
    .map((path) => ({ path, text: readFileSync(path, 'utf-8') }));
  const naming = scanned.filter(({ text }) => REMOVED_CODE.some(({ pattern }) => pattern.test(text)));

  it('the removed code is gone', () => {
    expect(existsSync(join(ROOT, 'src', 'agent'))).toBe(false);
    // Nothing outside the tests imports TrustedProcess (src/trusted-process/index.ts).
    const trustedProcess = join(ROOT, 'src', 'trusted-process', 'index.ts');
    const sources = listSources(join(ROOT, 'src'));
    expect(sources.length).toBeGreaterThan(100);
    const importers = sources.filter((file) =>
      [...readFileSync(file, 'utf-8').matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].some(
        (match) => resolve(dirname(file), match[1]).replace(/\.js$/, '.ts') === trustedProcess,
      ),
    );
    expect(importers.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('scans the documents under docs/ and recognizes the removed names', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.some(({ path }) => path.startsWith(`${completion}/`))).toBe(false);
    // MISSING_FEATURES.md describes this check with the scope it has.
    expect(readFileSync(join(ROOT, 'docs', 'MISSING_FEATURES.md'), 'utf-8').replace(/\s+/g, ' ')).toContain(
      'in any document under `docs/` that still names removed code',
    );
    const [agentModule, directPath] = REMOVED_CODE.map(({ pattern }) => pattern);
    expect(agentModule.test('the loop in `src/agent/index.ts`')).toBe(true);
    expect(agentModule.test('src/agents/tool-loop-detection.ts')).toBe(false);
    expect(directPath.test('the direct-tool-call fallback')).toBe(true);
  });

  it.each(naming.map(({ path, text }) => [relative(ROOT, path), path, text]))(
    '%s says in its Status line that the code it names no longer exists',
    (_name, path, text) => {
      const status = lineAfterTitle(text.split('\n')) ?? '';
      expect(STATUS_LINE.test(status), `a dated Status line under the title: ${status.slice(0, 80)}`).toBe(true);
      expect(status).toMatch(/no longer exist/);
      for (const { name, pattern } of REMOVED_CODE) {
        if (pattern.test(text)) expect(status, `the Status line names ${name}`).toMatch(pattern);
      }
      expect(missingPointers(status, dirname(path)), 'files the Status line names').toEqual([]);
    },
  );
});

describe('vision documents', () => {
  it.each(['docs/secure-agent-runtime-v2.md', 'docs/brainstorm-use-cases.md'].map((file) => [file]))(
    '%s carries a dated status banner that names MISSING_FEATURES as the source of truth',
    (file) => {
      const banner = readLines(join(ROOT, file)).find((line) => line.startsWith('> **Status ('));
      expect(banner, 'a "> **Status (YYYY-MM-DD):**" banner').toBeDefined();
      expect(banner).toMatch(/^> \*\*Status \(\d{4}-\d{2}-\d{2}\):\*\*/);
      expect(banner).toContain('(MISSING_FEATURES.md)');
      expect(banner).toContain('source of truth');
    },
  );
});

/** A `~/...` spelling of an absolute path under the home directory. */
function tildePath(path: string): string {
  const home = resolve(homedir());
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** True when a `denyRead` entry (`~/...`, possibly ending in a `*` glob) hides `path` or part of it. */
function baselineCovers(path: string, partially: boolean): boolean {
  return BASELINE_CREDENTIAL_DENY_READ.some((entry) => {
    const glob = entry.endsWith('*') ? entry.slice(0, -1) : undefined;
    if (entry === path || path.startsWith(`${entry}/`)) return true;
    if (glob !== undefined && path.startsWith(glob)) return true;
    // An entry inside the store (`~/.ssh/id_*` in `~/.ssh`) covers part of it.
    return partially && entry.startsWith(`${path}/`);
  });
}

/** The `### Name — **Status**` entry of MISSING_FEATURES.md with this name, up to the next heading. */
function backlogEntry(text: string, name: string): string {
  const start = text.indexOf(`### ${name} — `);
  expect(start, `MISSING_FEATURES.md entry "${name}"`).toBeGreaterThanOrEqual(0);
  const next = text.slice(start + 4).search(/^#{2,3} /m);
  return next === -1 ? text.slice(start) : text.slice(start, start + 4 + next);
}

/** The bullet of a Markdown list that starts with `prefix`, with its continuation lines. */
function bulletStartingWith(text: string, prefix: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`- ${prefix}`));
  expect(start, `a "- ${prefix}" bullet`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && (line.startsWith('- ') || line.trim() === ''));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** Lint codes named in `text`, expanding `WF010 to WF015` ranges. */
function lintCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(/WF(\d{3})(?: to WF(\d{3}))?/g)) {
    const first = Number(match[1]);
    const rangeEnd = match.at(2);
    const last = rangeEnd === undefined ? first : Number(rangeEnd);
    for (let n = first; n <= last; n++) codes.add(`WF${String(n).padStart(3, '0')}`);
  }
  return codes;
}

describe('statements checked against the code', () => {
  const missingFeatures = readFileSync(join(ROOT, 'docs', 'MISSING_FEATURES.md'), 'utf-8');

  it('names every protected credential store the OS sandbox read baseline leaves readable, and only those', () => {
    const uncovered = listProtectedCredentialStores()
      .filter((store) => store.tier === 'extended')
      .flatMap((store) => store.paths.map(tildePath))
      .filter((path) => !baselineCovers(path, true));
    const bullet = bulletStartingWith(missingFeatures, 'OS sandbox read baseline');
    const named = backtickSpans(bullet).filter((span) => span.startsWith('~/'));
    for (const path of uncovered) expect(named, `${path} is not in BASELINE_CREDENTIAL_DENY_READ`).toContain(path);
    for (const path of named) expect(baselineCovers(path, false), `${path} is named as readable`).toBe(false);
    // The TB0 entry must not claim the baseline covers the credential stores without that exception.
    const tb0 = backlogEntry(missingFeatures, 'OS-Level Execution Containment (TB0)');
    for (const path of uncovered) expect(tb0).toContain(`\`${path}\``);
  });

  it('lists unverified model pins and the active local Signal build prerequisite', () => {
    // The bullet with its nested items (indented, so they continue it).
    const prerequisites = bulletStartingWith(missingFeatures, 'Release prerequisites');
    expect(prerequisites.includes('`MODEL_UNPINNED`')).toBe(PINNED_MODELS.some(isUnverifiedPin));
    expect(prerequisites).toContain(`\`${SIGNAL_DEFAULT_IMAGE}\``);
    expect(prerequisites).toContain(`\`${SIGNAL_BRIDGE_BUILD_COMMAND}\``);
    expect(prerequisites).toContain('not a published or pullable release');
    expect(prerequisites).not.toContain('`SIGNAL_IMAGE_PINNED_DIGEST`');
  });

  it('describes the web UI session views the frontend renders', () => {
    const sessionsView = readFileSync(join(ROOT, 'packages', 'web-ui', 'src', 'routes', 'Sessions.svelte'), 'utf-8');
    const webUi = backlogEntry(missingFeatures, 'Web UI');
    const builtinUnsupported = sessionsView.includes('Unsupported session type');
    expect(webUi.includes('"unsupported session type" panel')).toBe(builtinUnsupported);
    if (builtinUnsupported) expect(webUi).not.toMatch(/chat view for builtin/i);
  });

  it('names every workflow subcommand that accepts --ensure-daemon', () => {
    const source = readFileSync(join(ROOT, 'src', 'workflow', 'daemon-gate-commands.ts'), 'utf-8');
    const accepting = new Set(
      [...source.matchAll(/Usage: ironcurtain workflow ([a-z-]+)[^'\n]*\[--ensure-daemon\]/g)].map((m) => m[1]),
    );
    expect(accepting.size).toBeGreaterThan(0);
    const doc = readFileSync(join(DESIGNS, 'agent-driven-workflow-gates.md'), 'utf-8').replace(/\n/g, ' ');
    const sentence = /accepts the flag: ([^;]+);/.exec(doc)?.[1] ?? '';
    expect(new Set(backtickSpans(sentence))).toEqual(accepting);
  });

  it('accounts for every lint code in the linter design status line', () => {
    const lintSource = readFileSync(join(ROOT, 'src', 'workflow', 'lint.ts'), 'utf-8');
    const doc = readLines(join(DESIGNS, 'workflow-semantic-linter-v2.md'));
    const status = lineAfterTitle(doc) ?? '';
    const [coveredPart = '', restPart = ''] = status.split(';');
    const lintOnly = lintCodes(restPart.split('are described in')[0] ?? '');
    const withHeading = new Set(doc.flatMap((line) => /^### (WF\d{3}) /.exec(line)?.[1] ?? []));
    for (const code of lintCodes(coveredPart)) expect(withHeading, `${code} has a section`).toContain(code);
    for (const code of lintOnly) expect(withHeading.has(code), `${code} has no section here`).toBe(false);
    expect(lintCodes(status)).toEqual(lintCodes(lintSource));
  });
});

describe('evidence records', () => {
  it('give the current SHA-256 of every checked-in file they cite', () => {
    const cited: Array<{ record: string; file: string; digest: string }> = [];
    for (const path of listMarkdown(join(DESIGNS, 'evidence'))) {
      const text = readFileSync(path, 'utf-8');
      for (const match of text.matchAll(/\]\(([^)\s]+)\)[^`[]*?SHA-256[^`[]*?`([0-9a-f]{64})`/g)) {
        cited.push({ record: relative(ROOT, path), file: resolve(dirname(path), match[1]), digest: match[2] });
      }
    }
    expect(cited.length).toBeGreaterThanOrEqual(3);
    for (const { record, file, digest } of cited) {
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(actual, `${record}: ${relative(ROOT, file)}`).toBe(digest);
    }
  });
});
