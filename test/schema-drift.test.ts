/**
 * Live-schema drift detection (src/trusted-process/schema-drift.ts) and its
 * runtime wiring: the coordinator records drift when a server registers its
 * tools, logs it to the session log, and sessions turn policy-affecting
 * drift into `annotation_drift` diagnostics.
 *
 * The fixtures replay the real git-mcp-server 2.8.4 → 2.15 drift that
 * shipped unnoticed in v0.13.0/v0.14.0: git_clone's destination renamed from
 * `localPath` to `path` (the new name unclassified, so policy never saw the
 * destination) and git_branch's discriminator renamed from `operation` to
 * `mode` (every conditional role fell back to its default).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as logger from '../src/logger.js';
import type { StoredToolAnnotation, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import {
  annotationDriftDiagnostics,
  formatAnnotationDriftNotice,
} from '../src/session/annotation-drift-diagnostics.js';
import {
  affectsPolicy,
  annotateCommandFor,
  canonicalSchemaHash,
  describeDriftNotice,
  describeServerDrift,
  diffServerSchemas,
  diffToolSchema,
  hasServerDrift,
  hasToolDrift,
  serverDriftAffectsPolicy,
  summarizeServerDrift,
  type LiveToolSchema,
} from '../src/trusted-process/schema-drift.js';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import type { ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';

// ---------------------------------------------------------------------------
// Fixtures: git-mcp-server 2.8.4 annotations, 2.15 live schemas
// ---------------------------------------------------------------------------

const CLONE_284: StoredToolAnnotation = {
  toolName: 'git_clone',
  serverName: 'git',
  comment: 'Clones a repository',
  args: { url: ['git-remote-url'], localPath: ['write-path'], depth: ['none'] },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Repository URL' },
      localPath: { type: 'string', description: 'Destination' },
      depth: { type: 'number' },
    },
    required: ['url', 'localPath'],
  },
};

const CLONE_215: LiveToolSchema = {
  name: 'git_clone',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Repository URL' },
      path: { type: 'string', description: 'Destination' },
      depth: { type: 'number' },
    },
    required: ['url', 'path'],
    additionalProperties: false,
  },
};

const BRANCH_284: StoredToolAnnotation = {
  toolName: 'git_branch',
  serverName: 'git',
  comment: 'Manages branches',
  args: {
    path: {
      default: ['read-path', 'write-history', 'delete-history'],
      when: [{ condition: { arg: 'operation', in: ['list', 'show'] }, roles: ['read-path'] }],
    },
    operation: ['none'],
    name: ['branch-name'],
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      operation: { type: 'string', enum: ['list', 'show', 'create', 'delete'] },
      name: { type: 'string' },
    },
    required: ['operation'],
  },
};

const BRANCH_215: LiveToolSchema = {
  name: 'git_branch',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      mode: { type: 'string', enum: ['list', 'show', 'create', 'delete', 'rename'] },
      branchName: { type: 'string' },
    },
    required: ['mode'],
  },
};

const SHOW_STORED: StoredToolAnnotation = {
  toolName: 'git_show',
  serverName: 'git',
  comment: 'Shows an object',
  args: {
    path: {
      default: ['read-path'],
      when: [{ condition: { arg: 'format', equals: 'json' }, roles: ['read-path'] }],
    },
    format: ['none'],
  },
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, format: { type: 'string', enum: ['raw', 'json'] } },
  },
};

const SHOW_LIVE: LiveToolSchema = {
  name: 'git_show',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, format: { type: 'string', enum: ['raw'] } },
  },
};

/** The live schema the annotation was written from, with key order shuffled. */
function liveOf(stored: StoredToolAnnotation): LiveToolSchema {
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .reverse()
          .map(([k, v]) => [k, reversed(v)]),
      );
    }
    return value;
  };
  return { name: stored.toolName, inputSchema: reversed(stored.inputSchema) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// diffToolSchema
// ---------------------------------------------------------------------------

describe('diffToolSchema', () => {
  it('reports nothing for the schema the annotation was written from, whatever the key order', () => {
    const drift = diffToolSchema(CLONE_284, liveOf(CLONE_284));
    expect(drift).toMatchObject({
      unannotatedArgs: [],
      removedArgs: [],
      brokenDiscriminators: [],
      enumChanges: [],
      schemaChanged: false,
    });
    expect(drift.requiredChange).toBeUndefined();
    expect(hasToolDrift(drift)).toBe(false);
    expect(drift.liveSchemaHash).toBe(drift.storedSchemaHash);
  });

  it('flags a renamed argument as unannotated (the new name) and removed (the old one)', () => {
    const drift = diffToolSchema(CLONE_284, CLONE_215);
    expect(drift.unannotatedArgs).toEqual(['path']);
    expect(drift.removedArgs).toEqual(['localPath']);
    expect(drift.requiredChange).toEqual({ added: ['path'], removed: ['localPath'] });
    expect(drift.schemaChanged).toBe(true);
    expect(affectsPolicy(drift)).toBe(true);
  });

  it('flags a conditional role keyed on an argument the live schema no longer has', () => {
    const drift = diffToolSchema(BRANCH_284, BRANCH_215);
    expect(drift.brokenDiscriminators).toEqual(['path: condition on unknown argument "operation"']);
    expect(drift.unannotatedArgs).toEqual(['branchName', 'mode']);
    expect(drift.removedArgs).toEqual(['name', 'operation']);
  });

  it('flags condition values outside the live enum, and enum changes on every argument', () => {
    const drift = diffToolSchema(SHOW_STORED, SHOW_LIVE);
    expect(drift.brokenDiscriminators).toEqual(['path: format="json" is not a live value']);
    expect(drift.enumChanges).toEqual([{ arg: 'format', added: [], removed: ['"json"'] }]);
    expect(drift.unannotatedArgs).toEqual([]);
    expect(affectsPolicy(drift)).toBe(true);
  });

  it('reports a value added to an enum (it falls back to the default roles)', () => {
    const live: LiveToolSchema = {
      name: 'git_show',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, format: { type: 'string', enum: ['raw', 'json', 'patch'] } },
      },
    };
    const drift = diffToolSchema(SHOW_STORED, live);
    expect(drift.enumChanges).toEqual([{ arg: 'format', added: ['"patch"'], removed: [] }]);
    expect(drift.brokenDiscriminators).toEqual([]);
  });

  it('treats a changed description or required list as drift without a policy effect', () => {
    const live = liveOf(CLONE_284);
    const props = live.inputSchema.properties as Record<string, Record<string, unknown>>;
    props.url = { ...props.url, description: 'The URL to clone' };
    live.inputSchema.required = ['url'];
    const drift = diffToolSchema(CLONE_284, live);
    expect(drift.schemaChanged).toBe(true);
    expect(drift.requiredChange).toEqual({ added: [], removed: ['localPath'] });
    expect(hasToolDrift(drift)).toBe(true);
    expect(affectsPolicy(drift)).toBe(false);
  });

  it('hashes the canonical schema, not the annotator inputHash', () => {
    expect(canonicalSchemaHash({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      canonicalSchemaHash({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
    expect(canonicalSchemaHash({ a: 1 })).not.toBe(canonicalSchemaHash({ a: 2 }));
    expect(canonicalSchemaHash({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tolerates live schemas without properties', () => {
    const drift = diffToolSchema(CLONE_284, { name: 'git_clone', inputSchema: { type: 'object' } });
    expect(drift.unannotatedArgs).toEqual([]);
    expect(drift.removedArgs).toEqual(['depth', 'localPath', 'url']);
  });
});

// ---------------------------------------------------------------------------
// diffServerSchemas and reporting
// ---------------------------------------------------------------------------

describe('diffServerSchemas', () => {
  const annotated = [CLONE_284, BRANCH_284, SHOW_STORED];

  it('reports nothing for a server whose live tools match its annotations', () => {
    const drift = diffServerSchemas('git', annotated, annotated.map(liveOf));
    expect(hasServerDrift(drift)).toBe(false);
    expect(serverDriftAffectsPolicy(drift)).toBe(false);
    expect(summarizeServerDrift(drift)).toBe('');
    expect(describeServerDrift(drift)).toEqual([]);
  });

  it('reports unannotated and stale tools and only the drifted annotated tools', () => {
    const live: LiveToolSchema[] = [CLONE_215, liveOf(BRANCH_284), { name: 'git_new', inputSchema: {} }];
    const drift = diffServerSchemas('git', annotated, live);
    expect(drift.unannotatedTools).toEqual(['git_new']);
    expect(drift.staleTools).toEqual(['git_show']);
    expect(drift.tools.map((t) => t.toolName)).toEqual(['git_clone']);
    expect(serverDriftAffectsPolicy(drift)).toBe(true);
  });

  it('describes the drift with the tool, the arguments and the annotate command', () => {
    const drift = diffServerSchemas('git', annotated, [CLONE_215, BRANCH_215, SHOW_LIVE]);
    const summary = summarizeServerDrift(drift);
    expect(summary).toContain('git_clone (unannotated: path; removed: localPath');
    expect(summary).toContain('git_branch');
    const lines = describeServerDrift(drift);
    expect(lines[0]).toContain('"git"');
    expect(lines.join('\n')).toContain('Calls carrying an unannotated argument are denied');
    expect(lines.join('\n')).toContain('fall back to their most restrictive default');
    expect(lines.at(-1)).toContain('`ironcurtain annotate-tools --server git`');
    const notice = describeDriftNotice(drift);
    expect(notice.message).toContain('denied or evaluated under default roles');
    expect(notice.hint).toBe(
      'Run `ironcurtain annotate-tools --server git`, review the result and recompile the policy.',
    );
  });

  it('says when drift has no policy effect', () => {
    const live = liveOf(CLONE_284);
    live.inputSchema.required = ['url'];
    const drift = diffServerSchemas('git', [CLONE_284], [live]);
    expect(hasServerDrift(drift)).toBe(true);
    expect(serverDriftAffectsPolicy(drift)).toBe(false);
    expect(describeDriftNotice(drift).message).toContain('no policy effect');
  });

  it('renders server-provided names as display text, never raw terminal sequences', () => {
    const hostile: LiveToolSchema = { name: 'evil\u001b]52;c;cHduZWQ=\u0007tool', inputSchema: {} };
    const drift = diffServerSchemas('git', [], [hostile]);
    const rendered = [summarizeServerDrift(drift), ...describeServerDrift(drift), describeDriftNotice(drift).message];
    for (const text of rendered) {
      expect(text).not.toContain('\u001b');
      expect(text).not.toContain('\u0007');
    }
    expect(summarizeServerDrift(drift)).toContain('evil\\u001b]52;c;cHduZWQ=\\u0007tool');
  });

  it('quotes server names the annotate command cannot take bare', () => {
    expect(annotateCommandFor('google-workspace')).toBe('ironcurtain annotate-tools --server google-workspace');
    expect(annotateCommandFor('my server')).toBe('ironcurtain annotate-tools --server "my server"');
  });
});

describe('annotationDriftDiagnostics', () => {
  it('emits one diagnostic per server whose drift changes policy, and none for schema text only', () => {
    const policyDrift = diffServerSchemas('git', [CLONE_284], [CLONE_215]);
    const textLive = liveOf(SHOW_STORED);
    (textLive.inputSchema as { description?: string }).description = 'changed';
    const textOnly = diffServerSchemas('other', [SHOW_STORED], [textLive]);
    expect(hasServerDrift(textOnly)).toBe(true);

    const events = annotationDriftDiagnostics([policyDrift, textOnly]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'annotation_drift', serverName: 'git' });
    expect(events[0].message).toContain('git_clone');
    expect(formatAnnotationDriftNotice(events[0])).toBe(
      `  [annotations] Warning: ${events[0].message}\n    ${events[0].hint}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Coordinator wiring
// ---------------------------------------------------------------------------

const ANNOTATIONS: StoredToolAnnotationsFile = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  servers: {
    git: { inputHash: 'h', tools: [CLONE_284, BRANCH_284] },
    trusted: { inputHash: 'h', tools: [{ ...SHOW_STORED, serverName: 'trusted' }] },
  },
};

function proxied(serverName: string, tools: readonly LiveToolSchema[]): ProxiedTool[] {
  return tools.map((tool) => ({ serverName, name: tool.name, inputSchema: tool.inputSchema }));
}

describe('ToolCallCoordinator.registerTools drift recording', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ic-schema-drift-'));
    logPath = join(dir, 'session.log');
    logger.setup({ logFilePath: logPath });
  });

  afterEach(() => {
    logger.teardown();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function coordinator(): ToolCallCoordinator {
    return new ToolCallCoordinator({
      compiledPolicy: { generatedAt: '', constitutionHash: '', inputHash: '', rules: [] },
      toolAnnotations: ANNOTATIONS,
      protectedPaths: [],
      allowedDirectory: dir,
      auditLogPath: join(dir, 'audit.jsonl'),
      trustedServers: new Set(['trusted']),
    });
  }

  it('records argument drift per server and writes the report to the session log, not to stderr', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const c = coordinator();
    c.registerTools('git', proxied('git', [CLONE_215, liveOf(BRANCH_284)]));

    const drift = c.getSchemaDrift().get('git');
    expect(drift?.tools.map((t) => t.toolName)).toEqual(['git_clone']);
    expect(drift?.tools[0].unannotatedArgs).toEqual(['path']);
    expect(serverDriftAffectsPolicy(drift ?? diffServerSchemas('git', [], []))).toBe(true);

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ WARN +\[annotations\] Tool annotations for MCP server "git" do not match/);
    expect(log).toContain('git_clone (unannotated: path; removed: localPath');
    expect(log).toContain('ironcurtain annotate-tools --server git');
    // The kernel never writes raw text to the terminal: sessions present it.
    expect(stderr).not.toHaveBeenCalled();

    expect(annotationDriftDiagnostics(c.getSchemaDrift().values()).map((e) => e.serverName)).toEqual(['git']);
  });

  it('records nothing for a server whose live tools match, and clears an earlier record', () => {
    const c = coordinator();
    c.registerTools('git', proxied('git', [CLONE_215, liveOf(BRANCH_284)]));
    expect(c.getSchemaDrift().has('git')).toBe(true);
    c.registerTools('git', proxied('git', [liveOf(CLONE_284), liveOf(BRANCH_284)]));
    expect(c.getSchemaDrift().size).toBe(0);
  });

  it('logs schema-text drift as information only', () => {
    const c = coordinator();
    const live = liveOf(CLONE_284);
    live.inputSchema.required = ['url'];
    c.registerTools('git', proxied('git', [live, liveOf(BRANCH_284)]));
    expect(c.getSchemaDrift().has('git')).toBe(true);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toMatch(/ INFO +\[annotations\]/);
    expect(log).not.toMatch(/ WARN +\[annotations\]/);
    expect(annotationDriftDiagnostics(c.getSchemaDrift().values())).toEqual([]);
  });

  it('skips trusted servers and servers without annotations', () => {
    const c = coordinator();
    c.registerTools('trusted', proxied('trusted', [SHOW_LIVE]));
    c.registerTools('unannotated', proxied('unannotated', [CLONE_215]));
    expect(c.getSchemaDrift().size).toBe(0);
  });
});
