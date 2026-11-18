import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CHECKPOINT_SCHEMA_VERSION,
  FileCheckpointStore,
  rebaseRunLocalPaths,
  WorkflowRunFileTooNewError,
} from '../../src/workflow/checkpoint.js';
import type { WorkflowCheckpoint, WorkflowId } from '../../src/workflow/types.js';
import { createWorkflowId } from '../../src/workflow/types.js';
import { VERSION } from '../../src/version.js';

function makeCheckpoint(overrides?: Partial<WorkflowCheckpoint>): WorkflowCheckpoint {
  return {
    machineState: 'coding',
    context: {
      taskDescription: 'Build a widget',
      artifacts: {},
      round: 1,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      totalTokens: 500,
      lastError: null,
      agentConversationsByState: {},
      previousAgentOutput: null,
      previousAgentNotes: null,
      previousStateName: null,
      visitCounts: {},
    },
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    ...overrides,
  };
}

describe('FileCheckpointStore', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-checkpoint-test-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('round-trips a checkpoint through save and load, stamped with its format and writer', () => {
    const id = createWorkflowId();
    const checkpoint = makeCheckpoint();

    store.save(id, checkpoint);
    const loaded = store.load(id);

    expect(loaded).toEqual({ ...checkpoint, schemaVersion: CHECKPOINT_SCHEMA_VERSION, writerVersion: VERSION });
  });

  it('returns undefined for a missing checkpoint', () => {
    const id = createWorkflowId();
    expect(store.load(id)).toBeUndefined();
  });

  it('lists workflow IDs that have checkpoints', () => {
    const id1 = createWorkflowId();
    const id2 = createWorkflowId();
    const id3 = createWorkflowId();

    store.save(id1, makeCheckpoint());
    store.save(id2, makeCheckpoint());

    const listed = store.listAll();
    expect(listed).toContain(id1);
    expect(listed).toContain(id2);
    expect(listed).not.toContain(id3);
  });

  it('returns empty list when no checkpoints exist', () => {
    expect(store.listAll()).toEqual([]);
  });

  it('returns empty list when baseDir does not exist', () => {
    const nonExistentStore = new FileCheckpointStore(`/tmp/nonexistent-${Date.now()}`);
    expect(nonExistentStore.listAll()).toEqual([]);
  });

  it('removes a checkpoint', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    expect(store.load(id)).toBeDefined();

    store.remove(id);
    expect(store.load(id)).toBeUndefined();
  });

  it('remove is a no-op for missing checkpoint', () => {
    const id = createWorkflowId();
    expect(() => store.remove(id)).not.toThrow();
  });

  it('overwrites previous checkpoint on re-save', () => {
    const id = createWorkflowId();
    const first = makeCheckpoint({ machineState: 'planning' });
    const second = makeCheckpoint({ machineState: 'coding' });

    store.save(id, first);
    store.save(id, second);

    const loaded = store.load(id);
    expect(loaded?.machineState).toBe('coding');
  });

  it('preserves complex context through serialization', () => {
    const id = createWorkflowId();
    const checkpoint = makeCheckpoint({
      machineState: { parent: 'coding', child: 'writing' },
      transitionHistory: [
        {
          from: 'planning',
          to: 'coding',
          event: 'AGENT_COMPLETED',
          timestamp: '2026-01-01T00:00:00Z',
          duration_ms: 5000,
        },
      ],
    });

    store.save(id, checkpoint);
    const loaded = store.load(id);

    expect(loaded?.machineState).toEqual({ parent: 'coding', child: 'writing' });
    expect(loaded?.transitionHistory).toHaveLength(1);
    expect(loaded?.transitionHistory[0].from).toBe('planning');
  });

  it('atomic write does not corrupt existing checkpoint on temp file rename', () => {
    const id = createWorkflowId();
    const original = makeCheckpoint({ machineState: 'original' });
    store.save(id, original);

    // Save again - the rename should atomically replace
    const updated = makeCheckpoint({ machineState: 'updated' });
    store.save(id, updated);

    const loaded = store.load(id);
    expect(loaded?.machineState).toBe('updated');
  });

  it('removed checkpoint no longer appears in listAll', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    expect(store.listAll()).toContain(id);

    store.remove(id);
    expect(store.listAll()).not.toContain(id);
  });
});

describe('FileCheckpointStore durability and recovery', () => {
  let baseDir: string;
  let warnings: string[];
  let store: FileCheckpointStore;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-checkpoint-durable-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
    warnings = [];
    store = new FileCheckpointStore(baseDir, { warn: (message) => warnings.push(message) });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  const currentPath = (id: WorkflowId): string => resolve(baseDir, id, 'checkpoint.json');
  const previousPath = (id: WorkflowId): string => resolve(baseDir, id, 'checkpoint.prev.json');

  it('keeps the checkpoint it replaces as checkpoint.prev.json', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    expect(existsSync(previousPath(id))).toBe(false);

    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    const previous = JSON.parse(readFileSync(previousPath(id), 'utf8')) as WorkflowCheckpoint;
    expect(previous.machineState).toBe('planning');
    expect(store.load(id)?.machineState).toBe('coding');
  });

  it('falls back to the previous checkpoint when checkpoint.json is truncated', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));

    const bytes = readFileSync(currentPath(id));
    writeFileSync(currentPath(id), bytes.subarray(0, Math.floor(bytes.length / 2)));

    const record = store.loadRecord(id);
    expect(record?.checkpoint.machineState).toBe('planning');
    expect(record?.recoveredFromPrevious).toBe(true);
    expect(store.load(id)?.machineState).toBe('planning');
    expect(warnings.join('\n')).toContain('using the previous checkpoint');
    // Reported once per damaged file, however often listings reload it.
    expect(warnings).toHaveLength(1);
  });

  it('falls back to the previous checkpoint when checkpoint.json is empty or not a checkpoint', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));

    writeFileSync(currentPath(id), '');
    expect(store.load(id)?.machineState).toBe('planning');

    writeFileSync(currentPath(id), JSON.stringify({ machineState: 'coding' }));
    expect(store.load(id)?.machineState).toBe('planning');
  });

  it('renders its default recovery warning safe for a terminal', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const defaultStore = new FileCheckpointStore(baseDir);
      const id = createWorkflowId();
      defaultStore.save(id, makeCheckpoint({ machineState: 'planning' }));
      defaultStore.save(id, makeCheckpoint({ machineState: 'coding' }));
      // The parse error quotes the damaged bytes, escape sequences included.
      writeFileSync(currentPath(id), '{"a": \u001b]0;owned\u0007 x}');
      expect(defaultStore.load(id)?.machineState).toBe('planning');
      const warned = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(warned).toContain('using the previous checkpoint');
      expect(warned).not.toContain('\u001b');
      expect(warned).not.toContain('\u0007');
    } finally {
      stderr.mockRestore();
    }
  });

  it('throws when neither the checkpoint nor a previous copy is usable', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    writeFileSync(currentPath(id), '{"truncated":');
    expect(() => store.load(id)).toThrow(/not valid JSON/);
  });

  it('never promotes an empty checkpoint over a good previous copy', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    writeFileSync(currentPath(id), '');

    store.save(id, makeCheckpoint({ machineState: 'review' }));
    const previous = JSON.parse(readFileSync(previousPath(id), 'utf8')) as WorkflowCheckpoint;
    expect(previous.machineState).toBe('planning');
  });

  it('never promotes a damaged checkpoint over a good previous copy', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    // Garbled, as a crash or a full disk leaves it: a resume then runs from
    // the previous copy, which must survive the resumed run's next save.
    writeFileSync(currentPath(id), '{"machineState": "cod');
    expect(store.load(id)?.machineState).toBe('planning');

    store.save(id, makeCheckpoint({ machineState: 'review' }));
    const previous = JSON.parse(readFileSync(previousPath(id), 'utf8')) as WorkflowCheckpoint;
    expect(previous.machineState).toBe('planning');
    expect(store.load(id)?.machineState).toBe('review');
  });

  it('promotes a sound checkpoint written by another store', () => {
    // The CLI and the daemon each hold their own store over one base directory.
    const id = createWorkflowId();
    new FileCheckpointStore(baseDir).save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    const previous = JSON.parse(readFileSync(previousPath(id), 'utf8')) as WorkflowCheckpoint;
    expect(previous.machineState).toBe('planning');
  });

  it('refuses a checkpoint from a newer format with WORKFLOW_CHECKPOINT_TOO_NEW, even with a previous copy', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    const record = JSON.parse(readFileSync(currentPath(id), 'utf8')) as Record<string, unknown>;
    writeFileSync(currentPath(id), JSON.stringify({ ...record, schemaVersion: 99, writerVersion: '9.9.9' }));

    let caught: unknown;
    try {
      store.load(id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowRunFileTooNewError);
    expect(caught).toMatchObject({ code: 'WORKFLOW_CHECKPOINT_TOO_NEW', schemaVersion: 99 });
    expect((caught as Error).message).toContain('IronCurtain 9.9.9');
  });

  it('treats a malformed schemaVersion as damage', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    const record = JSON.parse(readFileSync(currentPath(id), 'utf8')) as Record<string, unknown>;
    writeFileSync(currentPath(id), JSON.stringify({ ...record, schemaVersion: 'two' }));
    expect(store.load(id)?.machineState).toBe('planning');
  });

  it('reads an unversioned (format 1) checkpoint', () => {
    const id = createWorkflowId();
    mkdirSync(dirname(currentPath(id)), { recursive: true });
    writeFileSync(currentPath(id), JSON.stringify(makeCheckpoint({ machineState: 'legacy' }), null, 2));
    expect(store.load(id)?.machineState).toBe('legacy');
  });

  it('saves through a run directory that is a symlink (a run moved to another disk)', () => {
    const id = createWorkflowId();
    const moved = resolve(baseDir, 'other-disk', id);
    mkdirSync(moved, { recursive: true });
    symlinkSync(moved, resolve(baseDir, id));

    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    expect(store.load(id)?.machineState).toBe('coding');
    expect(readdirSync(moved).sort()).toEqual(['checkpoint.json', 'checkpoint.prev.json']);
  });

  it('refuses a symlinked checkpoint instead of following it', () => {
    const id = createWorkflowId();
    const elsewhere = resolve(baseDir, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(makeCheckpoint({ machineState: 'elsewhere' })));
    mkdirSync(dirname(currentPath(id)), { recursive: true });
    symlinkSync(elsewhere, currentPath(id));
    expect(() => store.load(id)).toThrow();
  });

  it('writes owner-only files and leaves no temporary file behind', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    store.save(id, makeCheckpoint());
    expect(statSync(currentPath(id)).mode & 0o777).toBe(0o600);
    expect(readdirSync(resolve(baseDir, id)).sort()).toEqual(['checkpoint.json', 'checkpoint.prev.json']);
  });

  it('sweeps temporary files a crashed writer left, but not fresh ones', () => {
    const id = createWorkflowId();
    const dir = resolve(baseDir, id);
    mkdirSync(dir, { recursive: true });
    const stale = [
      'checkpoint.tmp.0b5c3f4e-8f7a-4c1e-9d2b-3a4b5c6d7e8f',
      `.ironcurtain-tmp-${'ab'.repeat(12)}.tmp`,
      `.checkpoint.prev.json.${'cd'.repeat(8)}.tmp`,
    ];
    const fresh = `.ironcurtain-tmp-${'ef'.repeat(12)}.tmp`;
    const unrelated = 'notes.tmp';
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const name of [...stale, fresh, unrelated]) {
      writeFileSync(resolve(dir, name), 'partial');
      if (name !== fresh) utimesSync(resolve(dir, name), anHourAgo, anHourAgo);
    }

    store.save(id, makeCheckpoint());
    const remaining = readdirSync(dir);
    for (const name of stale) expect(remaining).not.toContain(name);
    expect(remaining).toContain(fresh);
    expect(remaining).toContain(unrelated);
  });

  it('remove() deletes the previous copy as well', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    store.save(id, makeCheckpoint());
    store.remove(id);
    expect(existsSync(currentPath(id))).toBe(false);
    expect(existsSync(previousPath(id))).toBe(false);
    expect(store.load(id)).toBeUndefined();
  });

  it('keeps checkpoint.json in place while it is replaced (the previous copy is a hard link)', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint({ machineState: 'planning' }));
    const before = statSync(currentPath(id)).ino;
    store.save(id, makeCheckpoint({ machineState: 'coding' }));
    // The replaced inode lives on as the previous copy.
    expect(statSync(previousPath(id)).ino).toBe(before);
    // A manual hard link is no obstacle to the next save either.
    linkSync(currentPath(id), resolve(baseDir, 'extra-link.json'));
    store.save(id, makeCheckpoint({ machineState: 'review' }));
    expect(store.load(id)?.machineState).toBe('review');
  });
});

describe('FileCheckpointStore workflow id validation', () => {
  let root: string;
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(() => {
    root = resolve('/tmp', `ironcurtain-checkpoint-ids-${process.pid}-${Date.now()}`);
    baseDir = resolve(root, 'nested', 'workflow-runs');
    mkdirSync(baseDir, { recursive: true });
    store = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['../../x', '../escaped', 'a/b', '..', '.', '', 'x'.repeat(129), 'id with space', 'wf\u0000'])(
    'refuses the id %j for save, load and remove without touching the filesystem',
    (id) => {
      const workflowId = id as WorkflowId;
      expect(() => store.save(workflowId, makeCheckpoint())).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_INVALID_ID' }),
      );
      expect(() => store.load(workflowId)).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVALID_ID' }));
      expect(() => store.remove(workflowId)).toThrow(expect.objectContaining({ code: 'WORKFLOW_INVALID_ID' }));
      expect(existsSync(resolve(root, 'x'))).toBe(false);
      expect(existsSync(resolve(root, 'nested', 'escaped'))).toBe(false);
    },
  );

  it('accepts legacy slug ids and 128-character ids', () => {
    for (const id of ['legacy-run_1', 'x'.repeat(128)] as WorkflowId[]) {
      store.save(id, makeCheckpoint());
      expect(store.load(id)).toBeDefined();
    }
  });

  it('listAll skips directories that are not workflow ids', () => {
    const id = createWorkflowId();
    store.save(id, makeCheckpoint());
    for (const name of ['has space', 'dotted.name']) {
      mkdirSync(resolve(baseDir, name), { recursive: true });
      writeFileSync(resolve(baseDir, name, 'checkpoint.json'), JSON.stringify(makeCheckpoint()));
    }
    expect(store.listAll()).toEqual([id]);
  });
});

describe('rebaseRunLocalPaths', () => {
  const id = 'wf-moved' as WorkflowId;
  const oldRun = `/old/home/.ironcurtain/workflow-runs/${id}`;
  const newRun = `/new/home/.ironcurtain/workflow-runs/${id}`;

  it('moves the recorded run directory (format 2) onto the current one', () => {
    const checkpoint = makeCheckpoint({
      runDir: oldRun,
      workspacePath: `${oldRun}/workspace`,
      workflowSkillsDir: `${oldRun}/workflow-skills`,
      workflowScriptsDir: `${oldRun}/workflow-scripts`,
    });
    checkpoint.context.artifacts.plan = `${oldRun}/workspace/.workflow/plan`;

    const rebased = rebaseRunLocalPaths(checkpoint, id, newRun);
    expect(rebased).toMatchObject({
      runDir: newRun,
      workspacePath: `${newRun}/workspace`,
      workflowSkillsDir: `${newRun}/workflow-skills`,
      workflowScriptsDir: `${newRun}/workflow-scripts`,
    });
    expect(rebased.context.artifacts.plan).toBe(`${newRun}/workspace/.workflow/plan`);
  });

  it('infers the run directory of an unversioned checkpoint from the default workspace', () => {
    const checkpoint = makeCheckpoint({ workspacePath: `${oldRun}/workspace` });
    expect(rebaseRunLocalPaths(checkpoint, id, newRun).workspacePath).toBe(`${newRun}/workspace`);
  });

  it('keeps a user workspace outside the run directory', () => {
    const recorded = makeCheckpoint({ runDir: oldRun, workspacePath: '/home/me/project' });
    expect(rebaseRunLocalPaths(recorded, id, newRun).workspacePath).toBe('/home/me/project');

    const legacy = makeCheckpoint({ workspacePath: '/home/me/workspace' });
    expect(rebaseRunLocalPaths(legacy, id, newRun)).toBe(legacy);
  });

  it('returns the checkpoint unchanged when the run did not move', () => {
    const checkpoint = makeCheckpoint({ runDir: newRun, workspacePath: `${newRun}/workspace` });
    expect(rebaseRunLocalPaths(checkpoint, id, newRun)).toBe(checkpoint);
  });

  it('never rebases a path that only shares a prefix with the run directory', () => {
    const checkpoint = makeCheckpoint({ runDir: oldRun, workspacePath: `${oldRun}-sibling/workspace` });
    expect(rebaseRunLocalPaths(checkpoint, id, newRun).workspacePath).toBe(`${oldRun}-sibling/workspace`);
  });
});
