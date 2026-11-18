import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  usesSharedContainer,
  validateDefinition,
  validateWorkflowSkillReferences,
  WorkflowValidationError,
} from '../../src/workflow/validate.js';
import { parseDefinitionFile } from '../../src/workflow/discovery.js';
import { MAX_FAN_OUT_LANES } from '../../src/workflow/lane-template.js';
import { deterministicStateOf } from './machine-test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validDefinition(): Record<string, unknown> {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    initial: 'plan',
    settings: { mode: 'builtin', maxRounds: 4 },
    states: {
      plan: {
        type: 'agent',
        description: 'Creates a plan',
        persona: 'planner',
        prompt: 'You are a planner. Create a plan.',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'agent',
        description: 'Reviews the plan',
        persona: 'reviewer',
        prompt: 'You are a reviewer. Review the plan.',
        inputs: ['plan'],
        outputs: ['review'],
        transitions: [
          { to: 'gate', when: { verdict: 'approved' } },
          { to: 'plan', when: { verdict: 'rejected' } },
        ],
      },
      gate: {
        type: 'human_gate',
        description: 'Human review gate',
        acceptedEvents: ['APPROVE', 'ABORT'],
        present: ['review'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: {
        type: 'terminal',
        description: 'Workflow complete',
        outputs: ['review'],
      },
      aborted: {
        type: 'terminal',
        description: 'Workflow aborted',
      },
    },
  };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateDefinition', () => {
  describe('valid definitions', () => {
    it('accepts a valid multi-state workflow', () => {
      const def = validateDefinition(validDefinition());
      expect(def.name).toBe('test-workflow');
      expect(Object.keys(def.states)).toHaveLength(5);
    });

    it('accepts a minimal two-state workflow', () => {
      const minimal = {
        name: 'minimal',
        description: 'Minimal workflow',
        initial: 'start',
        states: {
          start: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'You are a worker.',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'done' }],
          },
          done: {
            type: 'terminal',
            description: 'Done',
          },
        },
      };
      const def = validateDefinition(minimal);
      expect(def.initial).toBe('start');
    });

    it('accepts optional artifact inputs (trailing ?)', () => {
      const def = deepClone(validDefinition());
      (def.states as Record<string, Record<string, unknown>>).review.inputs = ['plan', 'feedback?'];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts a workflow with deterministic states', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;

      // Insert a deterministic state between review and gate
      states.review.transitions = [
        { to: 'test', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
      ];
      states.test = {
        type: 'deterministic',
        description: 'Runs tests',
        // Builtin mode: host execution, so the acknowledgement is required.
        host: true,
        run: [['npm', 'test']],
        transitions: [{ to: 'gate', guard: 'isPassed' }, { to: 'plan' }],
      };

      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts a narrow artifact handoff to an agent validator', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.artifactHandoff = { requiredFiles: ['plan/README.md'] };
      expect(validateDefinition(def).states.plan).toMatchObject({
        artifactHandoff: { requiredFiles: ['plan/README.md'] },
      });
    });

    it('presents the artifacts produced for each design-and-code human review', () => {
      const raw = parseYaml(
        readFileSync(resolve('src/workflow/workflows/design-and-code/workflow.yaml'), 'utf-8'),
      ) as unknown;
      const definition = validateDefinition(raw);
      const expected = [
        ['plan', 'plan_review', 'plan'],
        ['design', 'design_review', 'spec'],
        ['review', 'escalate_gate', 'reviews'],
      ] as const;

      for (const [stateId, gateId, artifact] of expected) {
        const state = definition.states[stateId];
        const gate = definition.states[gateId];
        expect(state.type).toBe('agent');
        expect(gate.type).toBe('human_gate');
        if (state.type === 'agent' && gate.type === 'human_gate') {
          expect(state.transitions.some((transition) => transition.to === gateId)).toBe(true);
          expect(gate.present?.map((ref) => ref.replace(/\?$/, ''))).toContain(artifact);
        }
      }
    });
  });

  describe('fan-out scaffolding', () => {
    function fanOutDefinition(
      overrides: {
        settings?: Record<string, unknown>;
        workersState?: Record<string, unknown>;
        sampleState?: Record<string, unknown>;
        startPrompt?: string;
      } = {},
    ): Record<string, unknown> {
      return {
        name: 'fanout-fixture',
        description: 'Fan-out scaffold fixture',
        initial: 'start',
        settings: {
          mode: 'docker',
          dockerAgent: 'claude-code',
          sharedContainer: true,
          workers: 2,
          ...overrides.settings,
        },
        states: {
          start: {
            type: 'agent',
            description: 'Start',
            persona: 'global',
            prompt: overrides.startPrompt ?? 'start',
            inputs: [],
            outputs: [],
            transitions: [{ to: 'workers' }],
          },
          workers: {
            type: 'deterministic',
            description: 'Fan out',
            run: [['true']],
            fanOut: { count: 'workers', join: 'barrier' },
            segment: ['sample'],
            transitions: [{ to: 'done' }],
            ...overrides.workersState,
          },
          sample: {
            type: 'deterministic',
            description: 'Lane sample',
            container: true,
            fanOutMember: true,
            resultFile: '.evolve_runs/main/current/lane_${laneId}/sample.json',
            run: [['python3', '/workflow-scripts/sample.py']],
            transitions: [{ to: 'done' }],
            ...overrides.sampleState,
          },
          done: {
            type: 'terminal',
            description: 'Done',
          },
        },
      };
    }

    function issuesFor(raw: Record<string, unknown>): readonly string[] {
      try {
        validateDefinition(raw);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        return err.issues;
      }
      throw new Error('expected validation to fail');
    }

    it('preserves workers, fanOut, segment, fanOutMember, and schedule fields', () => {
      const def = validateDefinition(
        fanOutDefinition({
          sampleState: { schedule: { pool: 'eval', resources: { cpu: 2, mem: '8Gi', gpu: 0 } } },
        }),
      );

      expect(def.settings?.workers).toBe(2);
      const workers = deterministicStateOf(def, 'workers');
      const sample = deterministicStateOf(def, 'sample');
      expect(workers.type).toBe('deterministic');
      expect(workers.fanOut).toEqual({ count: 'workers', join: 'barrier' });
      expect(workers.segment).toEqual(['sample']);
      expect(sample.type).toBe('deterministic');
      expect(sample.fanOutMember).toBe(true);
      expect(sample.schedule).toEqual({ pool: 'eval', resources: { cpu: 2, mem: '8Gi', gpu: 0 } });
    });

    it('rejects non-positive workers and the retired maxParallelism field', () => {
      expect(() => validateDefinition(fanOutDefinition({ settings: { workers: 0 } }))).toThrow(WorkflowValidationError);
      expect(
        issuesFor(fanOutDefinition({ settings: { maxParallelism: 2 } })).some((issue) =>
          issue.includes('settings.maxParallelism is retired'),
        ),
      ).toBe(true);
    });

    it(`rejects workers above the ${MAX_FAN_OUT_LANES}-lane bound and accepts the bound itself`, () => {
      expect(validateDefinition(fanOutDefinition({ settings: { workers: MAX_FAN_OUT_LANES } })).settings?.workers).toBe(
        MAX_FAN_OUT_LANES,
      );
      const issues = issuesFor(fanOutDefinition({ settings: { workers: MAX_FAN_OUT_LANES + 1 } }));
      expect(issues.some((issue) => issue.startsWith('settings.workers') && issue.includes('at most 16'))).toBe(true);
      // The bound holds even when no state uses `count: 'workers'`.
      expect(() => validateDefinition({ ...validDefinition(), settings: { workers: 64 } })).toThrow(
        WorkflowValidationError,
      );
    });

    it(`rejects a numeric fanOut.count above the ${MAX_FAN_OUT_LANES}-lane bound`, () => {
      const issues = issuesFor(
        fanOutDefinition({
          settings: { workers: 1 },
          workersState: { fanOut: { count: MAX_FAN_OUT_LANES + 1, join: 'barrier' } },
        }),
      );
      expect(issues.some((issue) => issue.includes('fanOut') && issue.includes('at most 16'))).toBe(true);
    });

    it('rejects a human gate inside a fan-out segment', () => {
      const raw = fanOutDefinition();
      (raw.states as Record<string, unknown>).sample = {
        type: 'human_gate',
        description: 'Lane gate',
        acceptedEvents: ['APPROVE'],
        transitions: [{ to: 'done', event: 'APPROVE' }],
      };
      expect(issuesFor(raw).some((issue) => issue.includes('gates inside a fan-out segment are unreachable'))).toBe(
        true,
      );
    });

    it('rejects segment members that are not marked fanOutMember', () => {
      const raw = fanOutDefinition({ sampleState: { fanOutMember: false } });
      expect(issuesFor(raw).some((issue) => issue.includes('must declare fanOutMember: true'))).toBe(true);
    });

    it('rejects workers > 1 with a manifest-visible greedy sampler declaration', () => {
      const raw = fanOutDefinition({ startPrompt: 'run evolve-brief --sampling-algorithm greedy' });
      expect(issuesFor(raw).some((issue) => issue.includes('cannot be used with greedy sampling'))).toBe(true);
    });

    it('accepts a bare current/-rooted fan-out resultFile at both workers:1 and workers>1', () => {
      // The runtime pump (laneScopeEvolveCurrentPath) idempotently rewrites a bare
      // `current/` path to `current/lane_<k>/` per lane at workers>1, and leaves it
      // bare at workers:1. So the SAME bare manifest is per-lane-safe at every
      // worker count and byte-identical at the shipped workers:1 default — the
      // validator must accept it at both, with no resultFile lane-scoping issue.
      const bareResultFile = '.evolve_runs/main/current/result.json';
      for (const workers of [1, 3]) {
        // validateDefinition throws WorkflowValidationError on any issue, so a
        // clean return is itself the assertion that no resultFile issue fired.
        const def = validateDefinition(
          fanOutDefinition({
            settings: { workers },
            sampleState: { resultFile: bareResultFile },
          }),
        );
        expect(deterministicStateOf(def, 'sample').resultFile).toBe(bareResultFile);
      }
    });

    it('still accepts an explicit lane_${laneId}/ fan-out resultFile when workers > 1', () => {
      const resultFile = '.evolve_runs/main/current/lane_${laneId}/result.json';
      const def = validateDefinition(fanOutDefinition({ sampleState: { resultFile } }));
      expect(deterministicStateOf(def, 'sample').resultFile).toBe(resultFile);
    });

    it('rejects a fan-out resultFile the pump cannot lane-scope (not current/-rooted, no lane segment) when workers > 1', () => {
      // A path outside the pump's `current/` scratch dir AND with no explicit
      // lane_ segment would be clobbered by N concurrent lanes — the pump never
      // rewrites it, so it must stay rejected.
      const raw = fanOutDefinition({
        sampleState: { resultFile: '.evolve_runs/main/shared/result.json' },
      });
      expect(issuesFor(raw).some((issue) => issue.includes('resultFile must be per-lane-scoped'))).toBe(true);
    });

    it('rejects a HARDCODED lane_<N> fan-out resultFile (every lane writes it -> clobber) when workers > 1', () => {
      // current/lane_0/result.json LOOKS lane-scoped, but there is no ${laneId}
      // to expand and the pump's idempotency guard (/^lane_\d+\//) leaves the
      // already-`lane_`-prefixed path UNCHANGED — so all N lanes write the same
      // lane_0/ path and clobber. The validator must reject it with a targeted
      // diagnostic steering the author to the ${laneId} placeholder or a bare path.
      const raw = fanOutDefinition({
        sampleState: { resultFile: '.evolve_runs/main/current/lane_0/result.json' },
      });
      const issues = issuesFor(raw);
      expect(issues.some((issue) => issue.includes('hardcoded lane_<N> segment is written by EVERY lane'))).toBe(true);
    });

    it('rejects schedule.pool eval on non-fanOutMember states', () => {
      const raw = fanOutDefinition({
        sampleState: {
          fanOutMember: false,
          schedule: { pool: 'eval' },
        },
      });
      expect(issuesFor(raw).some((issue) => issue.includes('schedule.pool: eval'))).toBe(true);
    });

    it('rejects a non-barrier fanOut join at parse time (join is the literal "barrier")', () => {
      // The Zod literal makes a non-barrier join a structural parse error,
      // so it never reaches the linter. This replaces the former WF014.
      const raw = fanOutDefinition({
        workersState: { fanOut: { count: 'workers', join: 'race' } },
      });
      expect(() => validateDefinition(raw)).toThrow(WorkflowValidationError);
    });

    // A numeric `fanOut.count` override produces multiple lanes at runtime even
    // when settings.workers is 1 (orchestrator resolves count===number directly).
    // The resultFile/greedy checks must gate on the EFFECTIVE lane count, not on
    // settings.workers, so this numeric override no longer bypasses them.
    it('rejects an unscoped fanOutMember resultFile when fanOut.count=3 overrides settings.workers=1', () => {
      const raw = fanOutDefinition({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 3, join: 'barrier' } },
        sampleState: { resultFile: '.evolve_runs/main/shared/result.json' },
      });
      expect(issuesFor(raw).some((issue) => issue.includes('resultFile must be per-lane-scoped'))).toBe(true);
    });

    it('rejects a hardcoded lane_<N> resultFile when fanOut.count=3 overrides settings.workers=1', () => {
      const raw = fanOutDefinition({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 3, join: 'barrier' } },
        sampleState: { resultFile: '.evolve_runs/main/current/lane_0/result.json' },
      });
      expect(
        issuesFor(raw).some((issue) => issue.includes('hardcoded lane_<N> segment is written by EVERY lane')),
      ).toBe(true);
    });

    it('rejects a greedy sampler when fanOut.count=3 overrides settings.workers=1', () => {
      const raw = fanOutDefinition({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 3, join: 'barrier' } },
        startPrompt: 'run evolve-brief --sampling-algorithm greedy',
      });
      expect(issuesFor(raw).some((issue) => issue.includes('cannot be used with greedy sampling'))).toBe(true);
    });

    it('keeps a single-lane numeric count (count=1, workers=1) free of multi-lane resultFile/greedy checks', () => {
      // count=1 resolves to one lane, so a bare unscoped resultFile + greedy text
      // must NOT be flagged — the effective-lanes gate stays at 1 here.
      const def = validateDefinition(
        fanOutDefinition({
          settings: { workers: 1 },
          workersState: { fanOut: { count: 1, join: 'barrier' } },
          sampleState: { resultFile: '.evolve_runs/main/shared/result.json' },
          startPrompt: 'run evolve-brief --sampling-algorithm greedy',
        }),
      );
      expect(deterministicStateOf(def, 'sample').resultFile).toBe('.evolve_runs/main/shared/result.json');
    });
  });

  describe('structural validation (Zod)', () => {
    it('rejects empty input', () => {
      expect(() => validateDefinition({})).toThrow(WorkflowValidationError);
    });

    it('rejects missing required fields', () => {
      expect(() => validateDefinition({ name: 'test' })).toThrow(WorkflowValidationError);
    });

    it('rejects invalid state type', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.type = 'invalid';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects invalid settings values', () => {
      const def = deepClone(validDefinition());
      def.settings = { maxRounds: -1 };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects unknown settings keys instead of silently dropping them', () => {
      // A setting from a newer release (or a typo) must not vanish: the run
      // would otherwise execute with looser limits than its author set.
      const def = deepClone(validDefinition());
      def.settings = { maxRounds: 2, futureBudgetCap: { maxSteps: 20 } };
      let caught: unknown;
      try {
        validateDefinition(def);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkflowValidationError);
      expect((caught as WorkflowValidationError).issues.join('\n')).toContain('futureBudgetCap');
    });

    it('rejects agent state with empty transitions array', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.transitions = [];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });
  });

  describe('semantic validation', () => {
    it('restricts artifact handoff to safe declared-output files and one unconditional validator edge', () => {
      const invalidCases: Array<(states: Record<string, Record<string, unknown>>) => void> = [
        (states) => {
          states.plan.artifactHandoff = { requiredFiles: ['../README.md'] };
        },
        (states) => {
          states.plan.artifactHandoff = { requiredFiles: ['review/README.md'] };
        },
        (states) => {
          states.plan.artifactHandoff = { requiredFiles: ['plan/README.md'] };
          states.plan.transitions = [{ to: 'review', when: { verdict: 'approved' } }];
        },
        (states) => {
          states.plan.artifactHandoff = { requiredFiles: ['plan/README.md'] };
          states.plan.transitions = [{ to: 'done' }];
        },
      ];

      for (const mutate of invalidCases) {
        const def = deepClone(validDefinition());
        mutate(def.states as Record<string, Record<string, unknown>>);
        expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      }
    });

    it('rejects artifact handoff on non-agent states instead of silently stripping it', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.gate.artifactHandoff = { requiredFiles: ['review/README.md'] };
      expect(() => validateDefinition(def)).toThrow(/only valid on agent states/);
    });

    it('rejects definition with missing initial state', () => {
      const def = deepClone(validDefinition());
      def.initial = 'nonexistent';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nonexistent')]),
        );
      }
    });

    it('rejects definition with no terminal state', () => {
      const def = {
        name: 'no-terminal',
        description: 'Missing terminal',
        initial: 'start',
        states: {
          start: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'You are a worker.',
            inputs: [],
            outputs: [],
            transitions: [{ to: 'start' }],
          },
        },
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('terminal')]),
        );
      }
    });

    it('rejects unregistered guard name', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.review.transitions as Array<Record<string, unknown>>)[0].guard = 'doesNotExist';
      expect(() => validateDefinition(def)).toThrow(/guard/);
    });

    it('rejects transition to unknown state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.plan.transitions as Array<Record<string, unknown>>)[0].to = 'nowhere';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nowhere')]),
        );
      }
    });

    it('rejects unreachable states', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.orphan = {
        type: 'agent',
        description: 'Orphan state',
        persona: 'orphan',
        prompt: 'You are orphaned.',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('orphan')]),
        );
      }
    });

    it('rejects missing required artifact input', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.inputs = ['nonexistent_artifact'];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nonexistent_artifact')]),
        );
      }
    });

    it('rejects human gate with no transitions', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.gate.transitions = [];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects gate transition event not in acceptedEvents', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.gate.transitions = [
        { to: 'done', event: 'APPROVE' },
        { to: 'plan', event: 'REPLAN' }, // REPLAN not in acceptedEvents
      ];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('REPLAN')]),
        );
      }
    });

    it('collects multiple issues in a single error', () => {
      const def = deepClone(validDefinition());
      def.initial = 'nonexistent';
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.review.transitions as Array<Record<string, unknown>>)[0].guard = 'badGuard';
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('when clause validation', () => {
    it('accepts when with valid verdict on agent transition', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
      ];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects multi-field when clause with non-verdict key', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 'approved', confidence: 'high' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('only "verdict" is currently supported for when-clause routing'),
          ]),
        );
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('"confidence"')]));
      }
    });

    it('rejects when + guard on same transition', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', guard: 'isRoundLimitReached', when: { verdict: 'approved' } },
        { to: 'plan' },
      ];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('mutually exclusive')]));
      }
    });

    it('accepts deterministic when:{verdict} when the state is containerized and declares resultFile', () => {
      const def = {
        name: 'deterministic-verdict',
        description: 'Deterministic verdict routing',
        initial: 'author',
        settings: { mode: 'docker', sharedContainer: true },
        states: {
          author: {
            type: 'agent',
            description: 'Mints container',
            persona: 'global',
            prompt: 'author',
            inputs: [],
            outputs: [],
            transitions: [{ to: 'classify' }],
          },
          classify: {
            type: 'deterministic',
            description: 'Classifies',
            run: [['python3', '/workflow-scripts/classify.py']],
            container: true,
            resultFile: '.workflow/result.json',
            transitions: [
              { to: 'passed', when: { verdict: 'pass' } },
              { to: 'blocked', when: { verdict: 'block' } },
              // Deterministic verdicts are not validated against the table,
              // so an unconditional fallback is required (see
              // validateTransitionFallbacks).
              { to: 'blocked' },
            ],
          },
          passed: { type: 'terminal', description: 'pass' },
          blocked: { type: 'terminal', description: 'block' },
        },
      };

      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects deterministic when:{verdict} when the state is not container:true', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'test' }];
      states.test = {
        type: 'deterministic',
        description: 'Runs tests',
        run: [['npm', 'test']],
        transitions: [{ to: 'gate', when: { verdict: 'approved' } }, { to: 'plan' }],
      };

      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('container: true')]));
      }
    });

    it('rejects when with unknown key', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { mood: 'happy' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('not a valid AgentOutput field')]));
      }
    });

    it('accepts custom verdict values (free-form string)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 'thesis_validate' } }, { to: 'plan' }];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects invalid confidence value (and non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { confidence: 'very_high' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"confidence" — only "verdict" is currently supported'),
            expect.stringContaining('invalid confidence value'),
          ]),
        );
      }
    });

    it('rejects non-verdict AgentOutput fields in when clause', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      // All non-verdict AgentOutput fields should be rejected
      for (const [key, value] of [
        ['completed', true],
        ['testCount', 42],
        ['escalation', null],
      ] as const) {
        states.review.transitions = [{ to: 'gate', when: { [key]: value } }, { to: 'plan' }];
        try {
          validateDefinition(def);
          expect.fail(`should have thrown for key "${key}"`);
        } catch (e) {
          const err = e as WorkflowValidationError;
          expect(err.issues).toEqual(
            expect.arrayContaining([expect.stringContaining(`"${key}" — only "verdict" is currently supported`)]),
          );
        }
      }
    });

    it('collects multiple when issues in one error', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', when: { mood: 'happy' } },
        { to: 'plan', when: { confidence: 'super_high' } },
      ];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues.length).toBeGreaterThanOrEqual(3);
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('not a valid AgentOutput field'),
            expect.stringContaining('"confidence" — only "verdict" is currently supported'),
            expect.stringContaining('invalid confidence value'),
          ]),
        );
      }
    });

    it('rejects empty when clause', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: {} }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('empty "when"')]));
      }
    });

    it('rejects when with wrong type for completed (string instead of boolean)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { completed: 'true' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"completed" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'completed' with wrong type: expected boolean, got string/),
          ]),
        );
      }
    });

    it('rejects when with wrong type for completed (number instead of boolean)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { completed: 1 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"completed" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'completed' with wrong type: expected boolean, got number/),
          ]),
        );
      }
    });

    it('rejects when with wrong type for verdict (number instead of string)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 1 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/'when' key 'verdict' with wrong type: expected string, got number/),
          ]),
        );
        // Type check runs first -- verdict accepts any string but a number
        // is still the wrong type.
        expect(err.issues.every((issue) => issue.includes('wrong type'))).toBe(true);
      }
    });

    it('rejects when with wrong type for testCount (string instead of number)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: 'five' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"testCount" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'testCount' with wrong type: expected number or null, got string/),
          ]),
        );
      }
    });

    it('rejects when with numeric testCount (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: 5 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"testCount" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with null testCount (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: null } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"testCount" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with string escalation (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { escalation: 'blocked_on_dependency' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"escalation" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with null escalation (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { escalation: null } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"escalation" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with string notes (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { notes: 'some note' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"notes" — only "verdict" is currently supported')]),
        );
      }
    });

    it('accepts freshSession: true on agent state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.freshSession = true;
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts freshSession: false on agent state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.freshSession = false;
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts custom verdicts for direct routing in when clauses', () => {
      const def = {
        name: 'custom-verdict-workflow',
        description: 'Workflow with custom verdict routing',
        initial: 'orchestrator',
        states: {
          orchestrator: {
            type: 'agent',
            description: 'Routes to different states via custom verdicts',
            persona: 'router',
            prompt: 'You are a router.',
            inputs: [],
            outputs: ['journal'],
            transitions: [
              { to: 'analyze', when: { verdict: 'reanalyze' } },
              { to: 'validate', when: { verdict: 'thesis_validate' } },
              { to: 'escalate', when: { verdict: 'escalate' } },
              { to: 'done', guard: 'isRoundLimitReached' },
            ],
          },
          analyze: {
            type: 'agent',
            description: 'Analyzes',
            persona: 'analyst',
            prompt: 'Analyze.',
            inputs: ['journal'],
            outputs: ['analysis'],
            transitions: [{ to: 'orchestrator' }],
          },
          validate: {
            type: 'agent',
            description: 'Validates',
            persona: 'validator',
            prompt: 'Validate.',
            inputs: ['journal'],
            outputs: ['results'],
            transitions: [{ to: 'orchestrator' }],
          },
          escalate: {
            type: 'human_gate',
            description: 'Human escalation',
            acceptedEvents: ['APPROVE', 'ABORT'],
            transitions: [
              { to: 'orchestrator', event: 'APPROVE' },
              { to: 'done', event: 'ABORT' },
            ],
          },
          done: {
            type: 'terminal',
            description: 'Done',
            outputs: ['journal'],
          },
        },
      };
      expect(() => validateDefinition(def)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // containerScope validation
  // ---------------------------------------------------------------------------

  describe('containerScope', () => {
    function sharedContainerDef(overrides: {
      stateContainerScopes?: Partial<Record<string, string>>;
      personas?: Partial<Record<string, string>>;
    }): Record<string, unknown> {
      const { stateContainerScopes = {}, personas = {} } = overrides;
      return {
        name: 'scoped',
        description: 'Scoped workflow',
        initial: 'plan',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
        states: {
          plan: {
            type: 'agent',
            description: 'Plan',
            persona: personas.plan ?? 'global',
            prompt: 'Plan.',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'review' }],
            ...(stateContainerScopes.plan !== undefined ? { containerScope: stateContainerScopes.plan } : {}),
          },
          review: {
            type: 'agent',
            description: 'Review',
            persona: personas.review ?? 'global',
            prompt: 'Review.',
            inputs: ['plan'],
            outputs: ['review'],
            transitions: [{ to: 'done' }],
            ...(stateContainerScopes.review !== undefined ? { containerScope: stateContainerScopes.review } : {}),
          },
          done: { type: 'terminal', description: 'Done' },
        },
      };
    }

    it('rejects containerScope when sharedContainer is not true', () => {
      const def = sharedContainerDef({ stateContainerScopes: { plan: 'env-a' } });
      // Override settings to remove sharedContainer.
      (def.settings as Record<string, unknown>) = { mode: 'docker', dockerAgent: 'claude-code' };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => /containerScope.*sharedContainer/.test(i))).toBe(true);
      }
    });

    it('rejects an agent containerScope in builtin mode (sharedContainer is ignored there)', () => {
      const def = sharedContainerDef({ stateContainerScopes: { plan: 'env-a' } });
      // sharedContainer stays true, isolating the mode check: builtin mode
      // ignores sharedContainer, so the scope would be a silent no-op.
      (def.settings as Record<string, unknown>) = { mode: 'builtin', sharedContainer: true };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => /containerScope.*mode.*not "docker"/.test(i))).toBe(true);
      }
    });

    it('rejects containerScope values that violate the charset', () => {
      const def = sharedContainerDef({ stateContainerScopes: { plan: 'env a' } });
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('accepts legacy workflows (no containerScope, sharedContainer: true) with homogeneous persona', () => {
      const def = sharedContainerDef({});
      expect(() => validateDefinition(def)).not.toThrow();
    });

    function validationIssues(def: Record<string, unknown>): readonly string[] {
      try {
        validateDefinition(def);
      } catch (err) {
        if (err instanceof WorkflowValidationError) return err.issues;
        throw err;
      }
      return [];
    }

    it('rejects two states with different personas on the same scope without the opt-in', () => {
      // A scope is one container and one trust domain: processes, agent-CLI
      // settings and workspace hooks an earlier state leaves behind act under
      // the next persona's policy (audit finding DINF-14).
      const def = sharedContainerDef({
        personas: { plan: 'global', review: 'reviewer' },
      });
      const issues = validationIssues(def);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('containerScope "primary" mixes personas: global (plan); reviewer (review)');
      expect(issues[0]).toContain('allowMixedPersonas: true');
    });

    it('rejects mixed personas on an explicitly named shared scope too', () => {
      const def = sharedContainerDef({
        stateContainerScopes: { plan: 'shared', review: 'shared' },
        personas: { plan: 'global', review: 'reviewer' },
      });
      expect(validationIssues(def)).toEqual([expect.stringContaining('containerScope "shared" mixes personas')]);
    });

    it('accepts mixed personas on one scope when settings.allowMixedPersonas is true', () => {
      const def = sharedContainerDef({
        personas: { plan: 'global', review: 'reviewer' },
      });
      (def.settings as Record<string, unknown>).allowMixedPersonas = true;
      expect(() => validateDefinition(def)).not.toThrow();
      expect(validateDefinition(def).settings?.allowMixedPersonas).toBe(true);
    });

    it('keeps rejecting mixed personas when allowMixedPersonas is false', () => {
      const def = sharedContainerDef({
        personas: { plan: 'global', review: 'reviewer' },
      });
      (def.settings as Record<string, unknown>).allowMixedPersonas = false;
      expect(validationIssues(def)).toEqual([expect.stringContaining('mixes personas')]);
    });

    it('rejects allowMixedPersonas where no container is shared (a silent no-op)', () => {
      for (const settings of [
        { mode: 'docker', dockerAgent: 'claude-code', allowMixedPersonas: true },
        { mode: 'builtin', sharedContainer: true, allowMixedPersonas: true },
      ]) {
        const def = sharedContainerDef({ personas: { plan: 'global', review: 'reviewer' } });
        (def.settings as Record<string, unknown>) = settings;
        expect(validationIssues(def), JSON.stringify(settings)).toEqual([
          expect.stringContaining(
            'settings.allowMixedPersonas is only valid when the workflow runs in a shared container',
          ),
        ]);
      }
    });

    it('does not apply the scope persona rule without a shared container', () => {
      // Per-state containers (docker without sharedContainer) and builtin
      // sessions never share a container between states.
      for (const settings of [{ mode: 'docker', dockerAgent: 'claude-code' }, { mode: 'builtin' }]) {
        const def = sharedContainerDef({ personas: { plan: 'global', review: 'reviewer' } });
        (def.settings as Record<string, unknown>) = settings;
        expect(() => validateDefinition(def), JSON.stringify(settings)).not.toThrow();
      }
    });

    it('accepts mixed personas without the opt-in only for the display-only past-run load', () => {
      const def = sharedContainerDef({ personas: { plan: 'global', review: 'reviewer' } });
      expect(validationIssues(def)).toEqual([expect.stringContaining('mixes personas')]);
      // The host-state allowance alone does not relax the persona rule.
      expect(() => validateDefinition(def, { allowUnacknowledgedHostStates: true })).toThrow(/mixes personas/);

      const displayed = validateDefinition(def, { allowMixedPersonaScopes: true });
      expect(displayed.settings?.allowMixedPersonas).toBeUndefined();

      // The allowance covers only the missing opt-in: a misplaced
      // allowMixedPersonas is still rejected.
      const misplaced = sharedContainerDef({ personas: { plan: 'global', review: 'reviewer' } });
      (misplaced.settings as Record<string, unknown>) = {
        mode: 'docker',
        dockerAgent: 'claude-code',
        allowMixedPersonas: true,
      };
      expect(() => validateDefinition(misplaced, { allowMixedPersonaScopes: true })).toThrow(
        /settings\.allowMixedPersonas is only valid when the workflow runs in a shared container/,
      );
    });

    it('accepts distinct scopes with different personas', () => {
      const def = sharedContainerDef({
        stateContainerScopes: { review: 'reviewer-scope' },
        personas: { plan: 'global', review: 'reviewer' },
      });
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects containerScope on non-agent states via the raw-input check', () => {
      // The raw-input validator catches `containerScope` on non-agent
      // states (same mechanism as `maxVisits`) and throws before Zod
      // would silently strip the field.
      const def = {
        name: 'non-agent-scope',
        description: 'Bad scope placement',
        initial: 'plan',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
        states: {
          plan: {
            type: 'agent',
            description: 'Plan',
            persona: 'global',
            prompt: 'Plan.',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'done' }],
          },
          done: {
            type: 'terminal',
            description: 'Done',
            containerScope: 'not-allowed-here',
          },
        },
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('accepts containerized deterministic states in docker shared-container mode', () => {
      const def = sharedContainerDef({});
      const states = def.states as Record<string, unknown>;
      states.review = {
        type: 'deterministic',
        description: 'Run container helper',
        container: true,
        containerScope: 'primary',
        timeoutMs: 1000,
        run: [['python', '/workflow-scripts/check.py']],
        transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'done' }],
      };
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects deterministic containerScope without container true', () => {
      const def = sharedContainerDef({});
      const states = def.states as Record<string, unknown>;
      states.review = {
        type: 'deterministic',
        description: 'Bad scope',
        containerScope: 'primary',
        run: [['true']],
        transitions: [{ to: 'done' }],
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => i.includes('containerScope but is not container: true'))).toBe(true);
      }
    });

    it('rejects deterministic container true without sharedContainer true', () => {
      const def = sharedContainerDef({});
      (def.settings as Record<string, unknown>) = { mode: 'docker', dockerAgent: 'claude-code' };
      const states = def.states as Record<string, unknown>;
      states.review = {
        type: 'deterministic',
        description: 'No shared container',
        container: true,
        run: [['true']],
        transitions: [{ to: 'done' }],
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => i.includes('container: true'))).toBe(true);
      }
    });

    it('rejects deterministic container true in builtin mode', () => {
      const def = sharedContainerDef({});
      (def.settings as Record<string, unknown>) = { mode: 'builtin', sharedContainer: true };
      const states = def.states as Record<string, unknown>;
      states.review = {
        type: 'deterministic',
        description: 'Builtin cannot exec in container',
        container: true,
        run: [['true']],
        transitions: [{ to: 'done' }],
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => i.includes('settings.mode is not "docker"'))).toBe(true);
      }
    });

    it('rejects resultFile on a non-container deterministic state', () => {
      const def = sharedContainerDef({});
      const states = def.states as Record<string, unknown>;
      states.review = {
        type: 'deterministic',
        description: 'Bad result file',
        resultFile: '.workflow/result.json',
        run: [['true']],
        transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'done' }],
      };

      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => i.includes('container: true'))).toBe(true);
      }
    });

    it('rejects unsafe resultFile paths', () => {
      for (const resultFile of ['/tmp/result.json', '../result.json', './result.json', 'a//result.json']) {
        const def = sharedContainerDef({});
        const states = def.states as Record<string, unknown>;
        states.review = {
          type: 'deterministic',
          description: 'Bad result file path',
          container: true,
          resultFile,
          run: [['true']],
          transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'done' }],
        };

        expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
        try {
          validateDefinition(def);
        } catch (err) {
          if (!(err instanceof WorkflowValidationError)) throw err;
          expect(err.issues.some((i) => i.includes('workspace-relative path'))).toBe(true);
        }
      }
    });

    it('rejects resultFile on non-deterministic states via the raw-input check', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.resultFile = '.workflow/result.json';

      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"resultFile" but that field is only valid on deterministic states'),
          ]),
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Agent harness (dockerAgent) — per state, validated at load time
// ---------------------------------------------------------------------------

describe('agent harness (dockerAgent)', () => {
  /** A claude-code coder (workflow default) and a codex reviewer. */
  function coderReviewer(
    settings: Record<string, unknown>,
    reviewer: Record<string, unknown> = { dockerAgent: 'codex' },
  ): Record<string, unknown> {
    return {
      name: 'diverse-reviewer',
      description: 'Coder and reviewer on different harnesses',
      initial: 'coder',
      settings,
      states: {
        coder: {
          type: 'agent',
          description: 'Writes the change',
          persona: 'global',
          prompt: 'Write it.',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'reviewer' }],
        },
        reviewer: {
          type: 'agent',
          description: 'Reviews the change',
          persona: 'global',
          prompt: 'Review it.',
          inputs: ['code'],
          outputs: ['review'],
          transitions: [{ to: 'done' }],
          ...reviewer,
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
  }

  function issuesOf(raw: unknown): readonly string[] {
    try {
      validateDefinition(raw);
    } catch (err) {
      if (err instanceof WorkflowValidationError) return err.issues;
      throw err;
    }
    return [];
  }

  it('accepts a codex reviewer with a claude-code coder in per-state-container mode and keeps the field', () => {
    const def = validateDefinition(coderReviewer({ mode: 'docker' }));
    const reviewer = def.states.reviewer;
    expect(reviewer.type === 'agent' ? reviewer.dockerAgent : undefined).toBe('codex');
  });

  it('rejects a codex reviewer and a claude-code coder sharing one container scope', () => {
    const issues = issuesOf(coderReviewer({ mode: 'docker', sharedContainer: true }));
    expect(issues).toEqual([expect.stringContaining('Container scope "primary" mixes agent harnesses')]);
    expect(issues[0]).toContain('claude-code (coder)');
    expect(issues[0]).toContain('codex (reviewer)');
    expect(issues[0]).toContain('their own containerScope');
  });

  it('accepts mixed harnesses in shared-container mode when each harness has its own scope', () => {
    expect(() =>
      validateDefinition(
        coderReviewer({ mode: 'docker', sharedContainer: true }, { dockerAgent: 'codex', containerScope: 'review' }),
      ),
    ).not.toThrow();
  });

  it('compares resolved harnesses: an explicit dockerAgent equal to the workflow default does not mix a scope', () => {
    expect(() =>
      validateDefinition(
        coderReviewer({ mode: 'docker', sharedContainer: true, dockerAgent: 'codex' }, { dockerAgent: 'codex' }),
      ),
    ).not.toThrow();
    expect(issuesOf(coderReviewer({ mode: 'docker', sharedContainer: true, dockerAgent: 'goose' }))).toEqual([
      expect.stringContaining('goose (coder), codex (reviewer)'),
    ]);
  });

  it('rejects an unknown settings.dockerAgent at load time instead of when the first container starts', () => {
    const issues = issuesOf(coderReviewer({ mode: 'docker', dockerAgent: 'claud-code-typo' }, {}));
    expect(issues).toEqual([expect.stringContaining('settings.dockerAgent: dockerAgent must be one of')]);
    expect(issues[0]).toContain('claude-code, goose, codex');
  });

  it('rejects an unknown state-level dockerAgent', () => {
    expect(issuesOf(coderReviewer({ mode: 'docker' }, { dockerAgent: 'gpt' }))).toEqual([
      expect.stringContaining('states.reviewer.dockerAgent: dockerAgent must be one of'),
    ]);
  });

  it('rejects a state-level dockerAgent in builtin mode, where no harness runs', () => {
    expect(issuesOf(coderReviewer({ mode: 'builtin' }))).toEqual([
      expect.stringContaining('State "reviewer" sets dockerAgent "codex" but settings.mode is "builtin"'),
    ]);
    // settings.dockerAgent stays legal in builtin mode (run-state --mode docker reads it).
    expect(() => validateDefinition(coderReviewer({ mode: 'builtin', dockerAgent: 'goose' }, {}))).not.toThrow();
  });

  it('rejects dockerAgent on a non-agent state instead of stripping it', () => {
    const raw = deepClone(validDefinition());
    const states = raw.states as Record<string, Record<string, unknown>>;
    states.gate.dockerAgent = 'codex';
    expect(issuesOf(raw)).toEqual([
      expect.stringContaining(
        'State "gate" (type: human_gate) has "dockerAgent" but that field is only valid on agent states',
      ),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Host deterministic states — explicit host: true acknowledgement
// ---------------------------------------------------------------------------

describe('host deterministic states', () => {
  type Mode = 'builtin' | 'docker' | 'docker-shared';

  function settingsFor(mode: Mode): Record<string, unknown> {
    if (mode === 'builtin') return { mode: 'builtin' };
    if (mode === 'docker') return { mode: 'docker', dockerAgent: 'claude-code' };
    return { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true };
  }

  /** A workflow whose `check` deterministic state follows a single agent. */
  function withCheck(mode: Mode, check: Record<string, unknown>): Record<string, unknown> {
    return {
      name: 'host-check',
      description: 'Host deterministic validation',
      initial: 'work',
      settings: settingsFor(mode),
      states: {
        work: {
          type: 'agent',
          description: 'Writes code',
          persona: 'global',
          prompt: 'Write code.',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'check' }],
        },
        check: {
          type: 'deterministic',
          description: 'Runs the tests',
          run: [['npm', 'test']],
          transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'work' }],
          ...check,
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
  }

  function issuesOf(raw: Record<string, unknown>): readonly string[] {
    try {
      validateDefinition(raw);
      return [];
    } catch (err) {
      if (!(err instanceof WorkflowValidationError)) throw err;
      return err.issues;
    }
  }

  it.each<Mode>(['builtin', 'docker', 'docker-shared'])(
    'rejects a host state without host: true in %s mode and explains the risk',
    (mode) => {
      const issues = issuesOf(withCheck(mode, {}));

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('State "check" runs its commands on the host but does not set host: true.');
      expect(issues[0]).toContain('outside the container and the policy engine');
      expect(issues[0]).toContain('npm, pytest, make, cargo and git execute code and configuration from it');
      expect(issues[0]).toContain('add host: true to the state');
    },
  );

  it('points each mode at its contained alternative', () => {
    expect(issuesOf(withCheck('builtin', {}))[0]).toContain('Builtin mode has no container to run them in');
    expect(issuesOf(withCheck('docker', {}))[0]).toContain(
      'Set container: true (which needs settings.sharedContainer: true)',
    );
    expect(issuesOf(withCheck('docker-shared', {}))[0]).toContain(
      "Set container: true to run them in the workflow's shared container",
    );
  });

  it('treats an absent container field and container: false alike', () => {
    expect(issuesOf(withCheck('docker-shared', { container: false }))).toHaveLength(1);
  });

  it.each<Mode>(['builtin', 'docker', 'docker-shared'])('accepts host: true in %s mode', (mode) => {
    const definition = validateDefinition(withCheck(mode, { host: true, timeoutMs: 60_000 }));
    expect(definition.states.check).toMatchObject({ type: 'deterministic', host: true, timeoutMs: 60_000 });
  });

  it('accepts container: true without host in shared-container mode', () => {
    expect(issuesOf(withCheck('docker-shared', { container: true }))).toEqual([]);
  });

  it('rejects host: true together with container: true', () => {
    const issues = issuesOf(withCheck('docker-shared', { host: true, container: true }));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('sets both host: true and container: true');
  });

  it('does not require host: true when nothing would run', () => {
    expect(issuesOf(withCheck('docker', { run: [] }))).toEqual([]);
    expect(issuesOf(withCheck('docker', { run: [[]] }))).toEqual([]);
  });

  it('does not require host: true on a fan-out driver, whose run never executes', () => {
    const raw = {
      name: 'host-fanout',
      description: 'Fan-out driver with a run entry',
      initial: 'workers',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, workers: 2 },
      states: {
        workers: {
          type: 'deterministic',
          description: 'Fan out',
          run: [['true']],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['lane'],
          transitions: [{ to: 'done' }],
        },
        lane: {
          type: 'agent',
          description: 'Lane worker',
          persona: 'global',
          prompt: 'Work.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    expect(issuesOf(raw)).toEqual([]);
  });

  it('still requires host: true on a host fan-out member, which does run commands', () => {
    const raw = {
      name: 'host-fanout-member',
      description: 'Fan-out with a host deterministic member',
      initial: 'workers',
      settings: { mode: 'builtin', workers: 2 },
      states: {
        workers: {
          type: 'deterministic',
          description: 'Fan out',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['probe'],
          transitions: [{ to: 'done' }],
        },
        probe: {
          type: 'deterministic',
          description: 'Lane probe',
          run: [['make', 'check']],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const issues = issuesOf(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "probe" runs its commands on the host but does not set host: true.');
  });

  it('requires host: true on a fan-out driver that is also a segment member, whose run executes in every lane', () => {
    // Lane machines strip a member's fan-out markers and run it as a plain
    // deterministic state, so `inner`'s run executes in each lane of `outer`.
    const raw = {
      name: 'host-nested-driver',
      description: 'A fan-out driver that is itself a lane member',
      initial: 'outer',
      settings: { mode: 'builtin', workers: 2 },
      states: {
        outer: {
          type: 'deterministic',
          description: 'Outer fan out',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['inner'],
          transitions: [{ to: 'done' }],
        },
        inner: {
          type: 'deterministic',
          description: 'Inner fan out, run as a lane member',
          run: [['make', 'check']],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['leaf'],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        leaf: {
          type: 'agent',
          description: 'Leaf worker',
          persona: 'global',
          prompt: 'Work.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const issues = issuesOf(raw);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "inner" runs its commands on the host but does not set host: true.');

    (raw.states.inner as Record<string, unknown>).host = true;
    expect(issuesOf(raw)).toEqual([]);
  });

  it('accepts an unacknowledged host state only for the display-only past-run load', () => {
    const raw = withCheck('builtin', {});
    expect(issuesOf(raw)).toHaveLength(1);

    const definition = validateDefinition(raw, { allowUnacknowledgedHostStates: true });
    expect(definition.states.check).toMatchObject({ type: 'deterministic', run: [['npm', 'test']] });
    expect(definition.states.check).not.toHaveProperty('host');

    // The allowance covers only the missing acknowledgement.
    expect(() =>
      validateDefinition(withCheck('docker-shared', { host: true, container: true }), {
        allowUnacknowledgedHostStates: true,
      }),
    ).toThrow(/sets both host: true and container: true/);
  });

  it('rejects host on a non-deterministic state via the raw-input check', () => {
    const raw = withCheck('docker-shared', { container: true });
    const states = raw.states as Record<string, Record<string, unknown>>;
    states.work.host = true;

    const issues = issuesOf(raw);
    expect(issues).toEqual([
      'State "work" (type: agent) has "host" but that field is only valid on deterministic states.',
    ]);
  });

  it('rejects a timeoutMs that Node timers cannot honour', () => {
    const issues = issuesOf(withCheck('builtin', { host: true, timeoutMs: 2 ** 31 }));

    expect(issues.some((issue) => issue.startsWith('states.check.timeoutMs'))).toBe(true);
    expect(issuesOf(withCheck('builtin', { host: true, timeoutMs: 2 ** 31 - 1 }))).toEqual([]);
  });

  it('the example manifest acknowledges its host state', () => {
    const definition = validateDefinition(
      parseDefinitionFile(resolve(__dirname, '..', '..', 'examples', 'workflow-demo.yaml')),
    );
    expect(definition.states.validate).toMatchObject({ type: 'deterministic', host: true });
  });
});

// ---------------------------------------------------------------------------
// Fan-out lane concurrency — what N concurrent lanes of one segment would
// share: the coordinator's single active policy (persona homogeneity under a
// shared container), one scope bundle, the member's agent conversation
// (freshSession: false) and the run's artifact directories (outputs).
// ---------------------------------------------------------------------------

describe('fan-out lane concurrency', () => {
  interface LaneSegmentOverrides {
    settings?: Record<string, unknown>;
    workersState?: Record<string, unknown>;
    researcher?: Record<string, unknown>;
    analyzer?: Record<string, unknown>;
  }

  /** Shared-container, two-lane segment with two agent members that share a persona by default. */
  function laneSegmentDefinition(overrides: LaneSegmentOverrides = {}): Record<string, unknown> {
    return {
      name: 'lane-segment',
      description: 'Fan-out segment with two agent members',
      initial: 'workers',
      settings: {
        mode: 'docker',
        dockerAgent: 'claude-code',
        sharedContainer: true,
        workers: 2,
        ...overrides.settings,
      },
      states: {
        workers: {
          type: 'deterministic',
          description: 'Fan out over the segment',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['researcher', 'analyzer'],
          transitions: [{ to: 'done', when: { verdict: 'recorded' } }, { to: 'failed' }],
          ...overrides.workersState,
        },
        researcher: {
          type: 'agent',
          description: 'Researches a candidate',
          persona: 'reader',
          prompt: 'Research.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'analyzer' }],
          ...overrides.researcher,
        },
        analyzer: {
          type: 'agent',
          description: 'Analyzes the candidate',
          persona: 'reader',
          prompt: 'Analyze.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done', when: { verdict: 'recorded' } }, { to: 'failed' }],
          ...overrides.analyzer,
        },
        done: { type: 'terminal', description: 'Done' },
        failed: { type: 'terminal', description: 'Failed' },
      },
    };
  }

  function issuesOf(raw: Record<string, unknown>): readonly string[] {
    try {
      validateDefinition(raw);
      return [];
    } catch (err) {
      if (!(err instanceof WorkflowValidationError)) throw err;
      return err.issues;
    }
  }

  it('accepts a homogeneous multi-lane shared-container segment', () => {
    expect(issuesOf(laneSegmentDefinition())).toEqual([]);
  });

  it('rejects a multi-lane shared-container segment whose agent members use different personas', () => {
    // allowMixedPersonas accepts the scope as one trust domain, but it cannot
    // make concurrent lanes share the coordinator's single active policy.
    const issues = issuesOf(
      laneSegmentDefinition({ settings: { allowMixedPersonas: true }, analyzer: { persona: 'writer' } }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('different personas');
    expect(issues[0]).toContain('researcher: reader, analyzer: writer');
    expect(issues[0]).toContain('2 concurrent lanes');
    // Without the opt-in the scope persona rule reports the same mix as well.
    const withoutOptIn = issuesOf(laneSegmentDefinition({ analyzer: { persona: 'writer' } }));
    expect(withoutOptIn).toHaveLength(2);
    expect(withoutOptIn.some((issue) => issue.includes('containerScope "primary" mixes personas'))).toBe(true);
  });

  it('rejects different personas when a numeric fanOut.count overrides settings.workers: 1', () => {
    const issues = issuesOf(
      laneSegmentDefinition({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 3, join: 'barrier' } },
        analyzer: { persona: 'writer' },
      }),
    );
    expect(issues.some((issue) => issue.includes('different personas') && issue.includes('3 concurrent lanes'))).toBe(
      true,
    );
  });

  it('accepts different personas when the segment runs a single lane (states run serially) and the scope opts in', () => {
    expect(
      issuesOf(
        laneSegmentDefinition({
          settings: { workers: 1, allowMixedPersonas: true },
          analyzer: { persona: 'writer' },
        }),
      ),
    ).toEqual([]);
    // Serial states still share one container, so the scope needs the opt-in.
    expect(issuesOf(laneSegmentDefinition({ settings: { workers: 1 }, analyzer: { persona: 'writer' } }))).toEqual([
      expect.stringContaining('containerScope "primary" mixes personas'),
    ]);
  });

  it('accepts different personas in per-state-container docker mode (each session has its own coordinator)', () => {
    expect(
      issuesOf(laneSegmentDefinition({ settings: { sharedContainer: false }, analyzer: { persona: 'writer' } })),
    ).toEqual([]);
  });

  it('accepts different personas in builtin mode even with sharedContainer: true (the flag is ignored there)', () => {
    expect(usesSharedContainer({ mode: 'builtin', sharedContainer: true })).toBe(false);
    expect(usesSharedContainer({ sharedContainer: true })).toBe(true);
    expect(usesSharedContainer({ mode: 'docker', sharedContainer: true })).toBe(true);
    expect(usesSharedContainer({ mode: 'docker' })).toBe(false);
    expect(usesSharedContainer(undefined)).toBe(false);
    expect(
      issuesOf(
        laneSegmentDefinition({
          settings: { mode: 'builtin', dockerAgent: undefined },
          analyzer: { persona: 'writer' },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects a shared-container segment spanning multiple container scopes, at any lane count', () => {
    for (const workers of [1, 2]) {
      const issues = issuesOf(
        laneSegmentDefinition({
          settings: { workers },
          researcher: { containerScope: 'alpha' },
          analyzer: { containerScope: 'beta' },
        }),
      );
      expect(issues.some((issue) => issue.includes('multiple container scopes (alpha, beta)'))).toBe(true);
    }
  });

  it('rejects freshSession: false on a multi-lane agent member, in any mode', () => {
    for (const settings of [{}, { sharedContainer: false }, { mode: 'builtin', dockerAgent: undefined }]) {
      const issues = issuesOf(laneSegmentDefinition({ settings, researcher: { freshSession: false } }));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('"researcher" sets freshSession: false');
    }
  });

  it('accepts freshSession: false on a single-lane segment member', () => {
    expect(issuesOf(laneSegmentDefinition({ settings: { workers: 1 }, researcher: { freshSession: false } }))).toEqual(
      [],
    );
  });

  it('rejects non-empty outputs on a multi-lane agent member, in any mode', () => {
    for (const settings of [{}, { sharedContainer: false }, { mode: 'builtin', dockerAgent: undefined }]) {
      const issues = issuesOf(laneSegmentDefinition({ settings, analyzer: { outputs: ['analysis'] } }));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('"analyzer" declares outputs [analysis]');
      expect(issues[0]).toContain('not lane-scoped');
    }
  });

  it('accepts non-empty outputs on a single-lane segment member', () => {
    expect(issuesOf(laneSegmentDefinition({ settings: { workers: 1 }, analyzer: { outputs: ['analysis'] } }))).toEqual(
      [],
    );
  });

  it('reports every lane-concurrency problem of a segment at once', () => {
    const issues = issuesOf(
      laneSegmentDefinition({
        researcher: { freshSession: false, outputs: ['notes'] },
        analyzer: { persona: 'writer', containerScope: 'beta' },
      }),
    );
    expect(issues.filter((issue) => issue.includes('multiple container scopes'))).toHaveLength(1);
    expect(issues.filter((issue) => issue.includes('different personas'))).toHaveLength(1);
    expect(issues.filter((issue) => issue.includes('freshSession: false'))).toHaveLength(1);
    expect(issues.filter((issue) => issue.includes('declares outputs'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Transition fallbacks — an executable state must always be able to leave
// once its invoke settles (XState drops a done event that matches no
// transition and the state hangs forever).
// ---------------------------------------------------------------------------

describe('transition fallbacks', () => {
  function withStates(states: Record<string, unknown>): Record<string, unknown> {
    const def = deepClone(validDefinition());
    def.states = { ...(def.states as Record<string, unknown>), ...states };
    return def;
  }

  function issuesOf(raw: Record<string, unknown>): readonly string[] {
    try {
      validateDefinition(raw);
      return [];
    } catch (err) {
      if (!(err instanceof WorkflowValidationError)) throw err;
      return err.issues;
    }
  }

  const planToValidate = {
    type: 'agent',
    description: 'Creates a plan',
    persona: 'planner',
    prompt: 'You are a planner. Create a plan.',
    inputs: [],
    outputs: ['plan'],
    transitions: [{ to: 'validate' }],
  };

  it('rejects a deterministic state whose transitions are all conditional', () => {
    const issues = issuesOf(
      withStates({
        plan: planToValidate,
        validate: {
          type: 'deterministic',
          description: 'Runs tests',
          host: true,
          run: [['npm', 'test']],
          transitions: [{ to: 'review', guard: 'isPassed' }],
        },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "validate" is a deterministic state whose transitions are all conditional');
    expect(issues[0]).toContain('guard isPassed -> review');
    expect(issues[0]).toContain('unconditional fallback');
  });

  it('accepts a deterministic state with a guard followed by an unconditional fallback', () => {
    expect(
      issuesOf(
        withStates({
          plan: planToValidate,
          validate: {
            type: 'deterministic',
            description: 'Runs tests',
            host: true,
            run: [['npm', 'test']],
            transitions: [{ to: 'review', guard: 'isPassed' }, { to: 'plan' }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects a deterministic state that routes only on when:{verdict} with no fallback', () => {
    const issues = issuesOf(
      withStates({
        plan: planToValidate,
        validate: {
          type: 'deterministic',
          description: 'Classifies',
          run: [['python3', 'classify.py']],
          container: true,
          resultFile: '.workflow/result.json',
          transitions: [
            { to: 'review', when: { verdict: 'pass' } },
            { to: 'plan', when: { verdict: 'retry' } },
          ],
        },
      }),
    );
    // Container-only routing also complains (builtin fixture); the fallback
    // issue must be among the reported problems regardless.
    expect(issues.some((issue) => issue.includes('deterministic state whose transitions are all conditional'))).toBe(
      true,
    );
  });

  it('rejects an agent state that routes only on guards with no unconditional fallback', () => {
    const issues = issuesOf(
      withStates({
        plan: {
          ...planToValidate,
          transitions: [{ to: 'review', guard: 'isRoundLimitReached' }],
        },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "plan" is an agent state that routes only on guards');
    expect(issues[0]).toContain('guard isRoundLimitReached -> review');
  });

  it('accepts an agent state whose guard is followed by an unconditional fallback', () => {
    expect(
      issuesOf(
        withStates({
          plan: {
            ...planToValidate,
            transitions: [{ to: 'aborted', guard: 'isRoundLimitReached' }, { to: 'review' }],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts an agent state that routes on when:{verdict} plus a trailing guard (verdict validation reprompts)', () => {
    // The shape every shipped review/orchestrator state uses: no unconditional
    // edge, but the agent is reprompted until it commits a declared verdict.
    expect(
      issuesOf(
        withStates({
          review: {
            type: 'agent',
            description: 'Reviews the plan',
            persona: 'reviewer',
            prompt: 'You are a reviewer. Review the plan.',
            inputs: ['plan'],
            outputs: ['review'],
            transitions: [
              { to: 'gate', when: { verdict: 'approved' } },
              { to: 'plan', when: { verdict: 'rejected' } },
              { to: 'aborted', guard: 'isRoundLimitReached' },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });

  /** A two-lane fan-out parent of the given type over a one-member agent segment. */
  function fanOutParentDefinition(
    parentType: 'agent' | 'deterministic',
    parentTransitions: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    const parentBody =
      parentType === 'agent'
        ? { type: 'agent', persona: 'global', prompt: 'Fan out.', inputs: [], outputs: [] }
        : { type: 'deterministic', run: [] };
    return {
      name: 'fan-out-parent',
      description: 'Fan-out parent routing on batch verdicts',
      initial: 'workers',
      settings: { mode: 'builtin', workers: 2 },
      states: {
        workers: {
          ...parentBody,
          description: 'Fans out',
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['researcher'],
          transitions: parentTransitions,
        },
        researcher: {
          type: 'agent',
          description: 'Researches',
          persona: 'global',
          prompt: 'Research.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
        failed: { type: 'terminal', description: 'Failed' },
      },
    };
  }

  it('rejects an AGENT-typed fan-out parent that routes only on batch verdicts (nothing reprompts a join verdict)', () => {
    // An agent-typed parent is built as a fan-out invoke, not an agent turn:
    // `result_file_error` after a failed lane is outside the table and nothing
    // reprompts it, so the agent-state verdict exemption must not apply.
    const issues = issuesOf(
      fanOutParentDefinition('agent', [
        { to: 'done', when: { verdict: 'recorded' } },
        { to: 'failed', when: { verdict: 'escalate' } },
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "workers" is a fan-out state whose transitions are all conditional');
    expect(issues[0]).toContain('unconditional fallback');
  });

  it('rejects a deterministic fan-out parent that routes only on batch verdicts', () => {
    const issues = issuesOf(
      fanOutParentDefinition('deterministic', [
        { to: 'done', when: { verdict: 'recorded' } },
        { to: 'failed', when: { verdict: 'result_file_error' } },
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('State "workers" is a fan-out state whose transitions are all conditional');
  });

  it('accepts a fan-out parent of either type that ends with an unconditional fallback', () => {
    for (const parentType of ['agent', 'deterministic'] as const) {
      expect(
        issuesOf(fanOutParentDefinition(parentType, [{ to: 'done', when: { verdict: 'recorded' } }, { to: 'failed' }])),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// No-regression — shipped workflows still validate after the schema additions.
// ---------------------------------------------------------------------------

describe('shipped workflows validate unchanged', () => {
  const workflowsDir = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows');

  for (const name of [
    'design-and-code',
    'test-email-summary',
    'deterministic-eval-smoke',
    'deterministic-verdict-smoke',
    'nested-docker-live-smoke',
    'evolve',
  ]) {
    it(`${name}: workflow.yaml validates without errors`, () => {
      const manifestPath = resolve(workflowsDir, name, 'workflow.yaml');
      const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 });
      expect(() => validateDefinition(raw)).not.toThrow();
    });
  }

  it('test-email-summary mixes personas in its shared scope only through the explicit opt-in', () => {
    const manifestPath = resolve(workflowsDir, 'test-email-summary', 'workflow.yaml');
    const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }) as {
      settings: Record<string, unknown>;
    };
    expect(raw.settings.allowMixedPersonas).toBe(true);
    delete raw.settings.allowMixedPersonas;
    expect(() => validateDefinition(raw)).toThrow(/containerScope "primary" mixes personas/);
  });

  it('every bundled workflow package and the example manifest validate under the fallback and fan-out lane rules', () => {
    const manifests = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(workflowsDir, entry.name, 'workflow.yaml'))
      .filter((manifestPath) => existsSync(manifestPath));
    manifests.push(resolve(__dirname, '..', '..', 'examples', 'workflow-demo.yaml'));
    expect(manifests.length).toBeGreaterThanOrEqual(7);
    for (const manifestPath of manifests) {
      expect(() => validateDefinition(parseDefinitionFile(manifestPath)), manifestPath).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowSkillReferences — name shape + manifest existence
// ---------------------------------------------------------------------------

describe('validateWorkflowSkillReferences', () => {
  let packageDir: string;

  beforeEach(() => {
    packageDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-skill-refs-test-'));
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  /**
   * Builds a minimal workflow whose `plan` agent state references the
   * given list of skills. The workflow itself is structurally valid;
   * tests vary only the `skills:` slot.
   */
  function workflowWithSkills(skills: readonly string[]) {
    return validateDefinition({
      name: 'skills-test',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
          skills,
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  /** Writes a SKILL.md sidecar so existsSync returns true for `<pkg>/skills/<name>/SKILL.md`. */
  function writeSkillManifest(name: string): void {
    const dir = resolve(packageDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
  }

  it('passes when every skill name is valid and has a manifest', () => {
    writeSkillManifest('fetcher');
    writeSkillManifest('parser');
    const def = workflowWithSkills(['fetcher', 'parser']);
    expect(() => validateWorkflowSkillReferences(def, packageDir)).not.toThrow();
  });

  it('rejects an empty-string skill name', () => {
    const def = workflowWithSkills(['']);
    expect(() => validateWorkflowSkillReferences(def, packageDir)).toThrow(WorkflowValidationError);
    try {
      validateWorkflowSkillReferences(def, packageDir);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/invalid skill name/i);
      expect(issues[0]).toMatch(/empty/);
    }
  });

  it('rejects a skill name with a forward slash', () => {
    const def = workflowWithSkills(['foo/bar']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/path separator/);
    }
  });

  it('rejects a parent-traversal skill name', () => {
    const def = workflowWithSkills(['../escaped']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      // `../escaped` contains `/`, which trips the separator check
      // before traversal detection — both rejections are valid.
      expect(issues[0]).toMatch(/path separator|valid directory name/);
    }
  });

  it('rejects "."', () => {
    const def = workflowWithSkills(['.']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/valid directory name/);
    }
  });

  it('rejects ".."', () => {
    const def = workflowWithSkills(['..']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/valid directory name/);
    }
  });

  it('reports shape errors and missing manifests in one batch', () => {
    // Three problems, one call: authors should see all of them rather than
    // chasing them one at a time.
    const def = workflowWithSkills(['', 'foo/bar', 'absent']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(3);
      expect(issues[0]).toMatch(/empty/);
      expect(issues[1]).toMatch(/path separator/);
      expect(issues[2]).toMatch(/no skill with that frontmatter name was found/);
    }
  });

  it('skips the discovery check when the shape check fails', () => {
    // `..` would normally trigger filesystem probing — but we should
    // report the shape error and skip the discovery branch entirely.
    const def = workflowWithSkills(['..']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).not.toMatch(/no skill with that frontmatter name was found/);
    }
  });

  it('reports missing skill with the skills-root path the resolver scans', () => {
    const def = workflowWithSkills(['absent']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toContain(resolve(packageDir, 'skills'));
    }
  });

  it('matches on frontmatter `name:`, not directory name', () => {
    // The dir is `dir-name/`, but the SKILL.md frontmatter says
    // `name: frontmatter-name`. The resolver matches on frontmatter
    // name (see `workflowSkillFilter` in src/skills/discovery.ts), so
    // the validator must agree: `frontmatter-name` passes,
    // `dir-name` does not.
    const dir = resolve(packageDir, 'skills', 'dir-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), '---\nname: frontmatter-name\ndescription: x\n---\nbody\n');

    const passing = workflowWithSkills(['frontmatter-name']);
    expect(() => validateWorkflowSkillReferences(passing, packageDir)).not.toThrow();

    const failing = workflowWithSkills(['dir-name']);
    try {
      validateWorkflowSkillReferences(failing, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/no skill with that frontmatter name was found/);
      // The available list should surface the real (frontmatter) name so
      // an author hunting a typo gets pointed at the right identifier.
      expect(issues[0]).toContain('frontmatter-name');
    }
  });

  it('lists available frontmatter names in the error to help typo recovery', () => {
    writeSkillManifest('fetcher');
    writeSkillManifest('parser');
    const def = workflowWithSkills(['fetchr']); // typo
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toContain('Available: fetcher, parser');
    }
  });

  it('parses cleanly and skips manifest checks when skills is the "none" sentinel', () => {
    const def = validateDefinition({
      name: 'skills-test',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
          skills: 'none',
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(() => validateWorkflowSkillReferences(def, packageDir)).not.toThrow();
  });

  it('still rejects an array with a missing skill name (regression guard)', () => {
    const def = workflowWithSkills(['nonexistent']);
    expect(() => validateWorkflowSkillReferences(def, packageDir)).toThrow(WorkflowValidationError);
  });
});
