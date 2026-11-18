import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { lintWorkflow, type Diagnostic, type LintContext } from '../../src/workflow/lint.js';
import { validateDefinition } from '../../src/workflow/validate.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub context that claims every persona exists. Phase 1 checks ignore it. */
const stubCtx: LintContext = { personaExists: () => true };

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** Returns a baseline valid definition that each test mutates as needed. */
function baseline(): WorkflowDefinition {
  return validateDefinition({
    name: 'lint-test',
    description: 'baseline for lint tests',
    initial: 'plan',
    states: {
      plan: {
        type: 'agent',
        description: 'Plan',
        persona: 'global',
        prompt: 'plan',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'done' }],
      },
      done: {
        type: 'terminal',
        description: 'done',
        outputs: ['plan'],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// WF001 — state cannot reach any terminal
// ---------------------------------------------------------------------------

describe('WF001 — unreachable terminal', () => {
  it('flags a self-looping non-terminal whose forward cone never hits a terminal', () => {
    // Initial -> either done (terminal) or stuck (self-loop with no exit).
    // Both branches are reachable; stuck's forward cone is {stuck}, no terminal.
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'entry',
      states: {
        entry: {
          type: 'agent',
          description: 'entry',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['o'],
          transitions: [{ to: 'done', when: { verdict: 'ok' } }, { to: 'stuck' }],
        },
        stuck: {
          type: 'agent',
          description: 'stuck',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['s'],
          transitions: [{ to: 'stuck' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });

    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF001');
    const wf001 = result.find((d) => d.code === 'WF001');
    expect(wf001?.stateId).toBe('stuck');
    expect(wf001?.severity).toBe('error');
  });

  it('does not flag states that reach a terminal through a cycle', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'plan',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['o'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'review',
          persona: 'global',
          prompt: 'p',
          inputs: ['o'],
          outputs: ['r'],
          transitions: [
            { to: 'plan', when: { verdict: 'rejected' } },
            { to: 'done', when: { verdict: 'approved' } },
          ],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).not.toContain('WF001');
  });
});

// ---------------------------------------------------------------------------
// WF002 — unversionedArtifacts entry not produced
// ---------------------------------------------------------------------------

describe('WF002 — unversionedArtifacts not produced', () => {
  it('warns on an unversionedArtifacts name that no state outputs', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { unversionedArtifacts: ['ghost'] },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd', outputs: ['plan'] },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF002');
    const d = result.find((x) => x.code === 'WF002');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"ghost"');
  });

  it('passes when every entry matches a produced artifact', () => {
    const def = baseline();
    const withSettings: WorkflowDefinition = {
      ...def,
      settings: { ...(def.settings ?? {}), unversionedArtifacts: ['plan'] },
    };
    expect(codes(lintWorkflow(withSettings, stubCtx))).not.toContain('WF002');
  });
});

// ---------------------------------------------------------------------------
// WF003 — terminal.outputs not produced by reachable state
// ---------------------------------------------------------------------------

describe('WF003 — terminal output not produced', () => {
  it('warns when a terminal lists an output that nothing produces', () => {
    const def = validateDefinition({
      name: 't',
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
        },
        done: { type: 'terminal', description: 'd', outputs: ['plan', 'phantom'] },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF003');
    const d = result.find((x) => x.code === 'WF003');
    expect(d?.stateId).toBe('done');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"phantom"');
  });
});

// ---------------------------------------------------------------------------
// WF004 — human_gate present not produced
// ---------------------------------------------------------------------------

describe('WF004 — human_gate present artifact not produced', () => {
  it('errors when a human_gate presents an artifact no reachable state produces', () => {
    const def = validateDefinition({
      name: 't',
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
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'gate',
          acceptedEvents: ['APPROVE', 'ABORT'],
          // `?` marker should be stripped the same way validateArtifactInputs does.
          present: ['missing-artifact?'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF004');
    const d = result.find((x) => x.code === 'WF004');
    expect(d?.stateId).toBe('gate');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('"missing-artifact"');
    expect(d?.message).not.toContain('?"');
  });
});

// ---------------------------------------------------------------------------
// WF006 — maxRounds without isRoundLimitReached guard
// ---------------------------------------------------------------------------

describe('WF006 — maxRounds with no guard', () => {
  it('warns when maxRounds is set but no transition uses isRoundLimitReached', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { maxRounds: 4 },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF006');
    const d = result.find((x) => x.code === 'WF006');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('maxRounds=4');
  });

  it('passes when some transition uses isRoundLimitReached', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { maxRounds: 4 },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done', guard: 'isRoundLimitReached' }, { to: 'plan' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF006');
  });
});

// ---------------------------------------------------------------------------
// WF007 — persona not installed locally
// ---------------------------------------------------------------------------

describe('WF007 — persona not installed', () => {
  /** Baseline workflow that routes `persona` through to the state under test. */
  function withPersona(persona: string): WorkflowDefinition {
    return validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona,
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  it('warns when an agent state references a persona that does not exist', () => {
    const def = withPersona('nonexistent');
    const ctx: LintContext = { personaExists: () => false };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).toContain('WF007');
    const d = result.find((x) => x.code === 'WF007');
    expect(d?.stateId).toBe('plan');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"nonexistent"');
  });

  it('does NOT fire on GLOBAL_PERSONA even when the stub claims it is missing', () => {
    // Stub returns false for everything — if WF007 fires here it means the
    // GLOBAL_PERSONA skip is not doing its job.
    const def = withPersona('global');
    const ctx: LintContext = { personaExists: () => false };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).not.toContain('WF007');
  });

  it('does NOT fire when personaExists returns true', () => {
    const def = withPersona('my-installed-persona');
    const ctx: LintContext = { personaExists: () => true };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).not.toContain('WF007');
  });
});

// ---------------------------------------------------------------------------
// WF008 — visit-cap guard must precede loop-continuing transitions
// ---------------------------------------------------------------------------

describe('WF008 — visit-cap transition ordering', () => {
  /**
   * Sentinel sharing the `| undefined` slot so a test can opt out of
   * `maxVisits` entirely. Default parameters in JS collapse an explicit
   * `undefined` into the default value, which would hide the "no
   * maxVisits" case.
   */
  const OMIT_MAX_VISITS = Symbol('omit-maxVisits');

  /**
   * Helper: builds a 3-state workflow where `review` is a bounded-loop
   * state whose transitions are supplied by the caller. Includes escalate
   * + approval terminals keyed off common transition targets so
   * reachability/terminal checks pass regardless of which transitions the
   * test supplies.
   */
  function withReviewTransitions(
    transitions: readonly unknown[],
    maxVisits: number | typeof OMIT_MAX_VISITS = 3,
  ): WorkflowDefinition {
    const reviewBase: Record<string, unknown> = {
      type: 'agent',
      description: 'review',
      persona: 'global',
      prompt: 'p',
      inputs: ['plan'],
      outputs: ['review'],
      transitions,
    };
    if (maxVisits !== OMIT_MAX_VISITS) reviewBase.maxVisits = maxVisits;

    return validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        // `plan` dispatches to `review` and also to `escalate_gate` so the
        // gate remains reachable even in tests where the review state has
        // no cap-guarded transition going there.
        plan: {
          type: 'agent',
          description: 'plan',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'escalate_gate', when: { verdict: 'escalate' } }, { to: 'review' }],
        },
        review: reviewBase,
        escalate_gate: {
          type: 'human_gate',
          description: 'escalate',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
  }

  it('errors when a non-approval when clause precedes the cap guard', () => {
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan', when: { verdict: 'rejected' } },
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
    ]);

    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF008');
    const d = result.find((x) => x.code === 'WF008');
    expect(d?.stateId).toBe('review');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('position 3');
    expect(d?.message).toContain('position 2');
    expect(d?.message).toContain('rejected');
  });

  it('passes when the cap guard precedes all loop-continuing transitions', () => {
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      { to: 'plan', when: { verdict: 'rejected' } },
    ]);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('passes when maxVisits is set but no cap-guarded transition is present', () => {
    // Without the guard, the cap is inert anyway — this rule is only
    // concerned with ordering, not with whether the cap is wired up.
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan', when: { verdict: 'rejected' } },
    ]);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('passes when the cap-guarded transition exists but maxVisits is absent', () => {
    // The guard on a state without maxVisits is inert — not WF008's concern.
    const def = withReviewTransitions(
      [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
        { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      ],
      OMIT_MAX_VISITS,
    );
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('flags an unconditional transition preceding the cap guard', () => {
    // An unconditional `to:` transition matches every time, so it
    // short-circuits the cap just like a non-approval when clause.
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan' }, // unconditional — always matches
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
    ]);
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF008');
    const d = result.find((x) => x.code === 'WF008');
    expect(d?.message).toContain('unconditional');
  });

  it('accepts all approval-style exit verdicts before the cap', () => {
    // All five approval verdicts can legitimately precede the cap: on
    // the cap visit, if the agent emits an approval verdict we take the
    // success exit rather than escalating.
    const approvalVerdicts = ['approved', 'complete', 'done', 'success', 'passed'];
    const transitions = [
      ...approvalVerdicts.map((v) => ({ to: 'done', when: { verdict: v } })),
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      { to: 'plan', when: { verdict: 'rejected' } },
    ];
    const def = withReviewTransitions(transitions);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  // Note on `when` clauses with non-`verdict` keys: validateDefinition
  // already rejects those (only `verdict` is supported for when-clause
  // routing), so they cannot reach lint in practice. The rule's
  // `isApprovalExitTransition` still treats them as loop-continuing for
  // defense-in-depth when multi-field `when` becomes a supported feature.
});

// ---------------------------------------------------------------------------
// WF010 — agent state references an invalid or missing skill
// ---------------------------------------------------------------------------

describe('WF010 — skill references', () => {
  let packageDir: string;
  let manifestPath: string;

  beforeEach(() => {
    // Each test gets its own package dir so we can write a workflow.yaml
    // alongside an optional `skills/` sidecar tree. The lint check
    // resolves `skills/` off the manifest's parent dir, mirroring what
    // `getWorkflowPackageDir(workflowFilePath)` does at runtime.
    packageDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-lint-skills-test-'));
    manifestPath = resolve(packageDir, 'workflow.yaml');
    writeFileSync(manifestPath, '# placeholder — lint reads only the package dir off this path\n');
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  function writeSkillManifest(name: string): void {
    const dir = resolve(packageDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`);
  }

  /** Builds a workflow whose `plan` agent state declares the given skill list. */
  function workflowWithSkills(skills: readonly string[]): WorkflowDefinition {
    return validateDefinition({
      name: 'lint-skills',
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

  function ctxWithPath(): LintContext {
    return { personaExists: () => true, workflowFilePath: manifestPath };
  }

  it('passes when every skill exists at <pkg>/skills/<name>/SKILL.md', () => {
    writeSkillManifest('fetcher');
    const def = workflowWithSkills(['fetcher']);
    expect(codes(lintWorkflow(def, ctxWithPath()))).not.toContain('WF010');
  });

  it('errors when a referenced skill manifest is missing', () => {
    const def = workflowWithSkills(['absent']);
    const result = lintWorkflow(def, ctxWithPath());
    expect(codes(result)).toContain('WF010');
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.stateId).toBe('plan');
    expect(d?.message).toContain('"absent"');
    expect(d?.message).toContain(resolve(packageDir, 'skills'));
    expect(d?.message).toMatch(/no skill with that frontmatter name was found/);
  });

  it('matches on frontmatter `name:`, not directory name', () => {
    // Dir is `dir-name/` but the SKILL.md frontmatter says
    // `name: frontmatter-name`. Lint matches on frontmatter name (so
    // `workflowSkillFilter` in the resolver agrees with the lint
    // surface): `frontmatter-name` passes, `dir-name` does not.
    const dir = resolve(packageDir, 'skills', 'dir-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), '---\nname: frontmatter-name\ndescription: x\n---\n');

    const passing = workflowWithSkills(['frontmatter-name']);
    expect(codes(lintWorkflow(passing, ctxWithPath()))).not.toContain('WF010');

    const failing = workflowWithSkills(['dir-name']);
    const result = lintWorkflow(failing, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/no skill with that frontmatter name was found/);
    // Available list surfaces the real (frontmatter) identifier — what an
    // author should reference instead.
    expect(d?.message).toContain('frontmatter-name');
  });

  it('errors on an empty-string skill name', () => {
    const def = workflowWithSkills(['']);
    const result = lintWorkflow(def, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/Invalid skill name/);
    expect(d?.message).toMatch(/empty/);
  });

  it('errors on a skill name containing a path separator', () => {
    const def = workflowWithSkills(['foo/bar']);
    const result = lintWorkflow(def, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/path separator/);
  });

  it('errors on "." and ".."', () => {
    for (const bad of ['.', '..']) {
      const def = workflowWithSkills([bad]);
      const result = lintWorkflow(def, ctxWithPath());
      const d = result.find((x) => x.code === 'WF010');
      expect(d?.severity).toBe('error');
      expect(d?.message).toMatch(/Invalid skill name/);
    }
  });

  it('emits one diagnostic per offending entry (batched, not first-error-only)', () => {
    const def = workflowWithSkills(['', 'foo/bar', 'absent']);
    const result = lintWorkflow(def, ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(3);
  });

  it('does not fire when ctx.workflowFilePath is omitted', () => {
    // Lint callers without a path on hand (e.g., tests that synthesize a
    // definition in memory, or `inspect` over a past run) should see the
    // rule skip cleanly rather than emit noise about non-existent
    // sidecars.
    const def = workflowWithSkills(['absent']);
    const noPathCtx: LintContext = { personaExists: () => true };
    expect(codes(lintWorkflow(def, noPathCtx))).not.toContain('WF010');
  });

  it('does not fire on agent states without a skills field', () => {
    const def = validateDefinition({
      name: 'no-skills',
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
          // skills omitted entirely
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(codes(lintWorkflow(def, ctxWithPath()))).not.toContain('WF010');
  });

  // -------------------------------------------------------------------------
  // Package-scoped WF010: malformed SKILL.md surfaces even when no state
  // references it. Closes the gap that let typo'd frontmatter ship silently.
  // -------------------------------------------------------------------------

  /**
   * Writes a `SKILL.md` under `<packageDir>/skills/<dirName>/` with the
   * given exact body (no frontmatter wrapping). Lets tests construct
   * malformed manifests that `writeSkillManifest` cannot.
   */
  function writeRawSkillManifest(dirName: string, body: string): string {
    const dir = resolve(packageDir, 'skills', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), body);
    return dir;
  }

  /** Definition with no `skills:` references — isolates the package walk. */
  function workflowWithoutSkills(): WorkflowDefinition {
    return validateDefinition({
      name: 'no-refs',
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
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  it('errors on a SKILL.md with malformed YAML even when no state references it', () => {
    // Closes the WF010 gap: pre-fix, a typo'd frontmatter under
    // `<pkg>/skills/<dir>/SKILL.md` produced zero diagnostics if no
    // state happened to reference it. Authors had no signal at all.
    const skillDir = writeRawSkillManifest('broken', '---\nname: "unterminated\n---\n');

    const result = lintWorkflow(workflowWithoutSkills(), ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(1);
    expect(wf010[0].severity).toBe('error');
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain('Malformed SKILL.md');
    expect(wf010[0].message).toContain(skillDir);
  });

  it('errors on a SKILL.md missing the `name:` field', () => {
    const skillDir = writeRawSkillManifest('no-name', '---\ndescription: "x"\n---\n');

    const result = lintWorkflow(workflowWithoutSkills(), ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(1);
    expect(wf010[0].severity).toBe('error');
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain(skillDir);
    expect(wf010[0].message).toContain('SKILL.md');
  });

  it('surfaces both a healthy and a broken SKILL.md alongside each other', () => {
    // Healthy manifest is discoverable for the reference check; broken
    // manifest produces a package-scoped diagnostic. The reference
    // check still passes for the healthy entry.
    writeSkillManifest('healthy');
    const brokenDir = writeRawSkillManifest('broken', '---\n\t- not: : a: mapping\n---\n');

    const def = workflowWithSkills(['healthy']);
    const result = lintWorkflow(def, ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    // One package-scoped diagnostic for the broken file. The reference
    // to `healthy` resolves cleanly, so no state-scoped diagnostic.
    expect(wf010).toHaveLength(1);
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain(brokenDir);
  });

  it('does not fire on directories without a SKILL.md (legitimate sidecars)', () => {
    // A skills root may legitimately contain helper subdirs (READMEs,
    // fixtures, test artifacts). `missing-manifest` is intentionally
    // not surfaced — same reasoning as the runtime warning gate.
    const helperDir = resolve(packageDir, 'skills', 'shared-fixtures');
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(resolve(helperDir, 'README.md'), '# notes\n');

    expect(codes(lintWorkflow(workflowWithoutSkills(), ctxWithPath()))).not.toContain('WF010');
  });

  it('does not fire when `workflowFilePath` is omitted, even if a malformed manifest would exist', () => {
    // Without a manifest path the lint surface has no way to locate
    // the package dir; the rule must skip cleanly rather than guess.
    writeRawSkillManifest('broken', '---\nname: "unterminated\n---\n');

    const noPathCtx: LintContext = { personaExists: () => true };
    expect(codes(lintWorkflow(workflowWithoutSkills(), noPathCtx))).not.toContain('WF010');
  });

  it('errors on duplicate frontmatter names within a single skills root', () => {
    // Two skill directories under the same root claim the same
    // frontmatter `name:`. The lex-first directory wins discovery; the
    // loser is reported as a duplicate so authors see the collision
    // instead of silently losing one entry to last-write-wins layering.
    writeSkillManifest('alpha-shared');
    // `writeSkillManifest` derives the name from the directory; we need
    // a second directory whose frontmatter collides with the first's
    // name. `b-shared/` declares `name: alpha-shared` to force the
    // collision.
    const loserDir = resolve(packageDir, 'skills', 'b-shared');
    mkdirSync(loserDir, { recursive: true });
    writeFileSync(resolve(loserDir, 'SKILL.md'), `---\nname: alpha-shared\ndescription: x\n---\n`);

    const result = lintWorkflow(workflowWithoutSkills(), ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(1);
    expect(wf010[0].severity).toBe('error');
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain('Duplicate skill');
    expect(wf010[0].message).toContain(loserDir);
    expect(wf010[0].message).toContain('"alpha-shared"');
  });
});

// ---------------------------------------------------------------------------
// Regression — bundled workflows must lint clean (zero errors)
// ---------------------------------------------------------------------------

describe('bundled workflows lint clean', () => {
  const workflowsDir = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows');

  // personaExists returns false unconditionally — bundled workflows use
  // GLOBAL_PERSONA throughout, so WF007 must skip via the alias, not the stub.
  const bundledCtx: LintContext = { personaExists: () => false };

  for (const name of [
    'design-and-code',
    'test-email-summary',
    'deterministic-eval-smoke',
    'deterministic-verdict-smoke',
    'evolve',
  ]) {
    it(`${name}: zero errors`, () => {
      const manifestPath = resolve(workflowsDir, name, 'workflow.yaml');
      const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 });
      const def = validateDefinition(raw);
      // Pass `workflowFilePath` so WF010 (skill references) runs against
      // the real package directory — bundled workflows don't currently
      // reference skills, but if they ever do this regression catches a
      // missing manifest sidecar.
      const ctx: LintContext = { ...bundledCtx, workflowFilePath: manifestPath };
      const diagnostics = lintWorkflow(def, ctx);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        console.error('Unexpected errors:', errors);
      }
      expect(errors.length).toBe(0);
    });
  }

  // Stronger than "zero errors": every bundled package (discovered, so a new
  // one is covered automatically) lints with no diagnostics at all, apart
  // from WF007, which depends on which personas the machine has installed.
  // In particular none of them declares a field that validates but does
  // nothing (WF016-WF018), such as evolve's former researcher/analyzer
  // maxVisits that no transition checked.
  it('every bundled package has no warnings except persona availability', () => {
    const manifests = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(workflowsDir, entry.name, 'workflow.yaml'))
      .filter((manifestPath) => existsSync(manifestPath));
    expect(manifests.length).toBeGreaterThanOrEqual(6);

    for (const manifestPath of manifests) {
      const def = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));
      const diagnostics = lintWorkflow(def, { ...bundledCtx, workflowFilePath: manifestPath });
      expect(
        diagnostics.filter((d) => d.code !== 'WF007').map((d) => `${d.code} ${d.stateId ?? ''}`),
        manifestPath,
      ).toEqual([]);
    }
  });
});

describe('WF011 — mixed agent/deterministic scope ordering', () => {
  function withDeterministic(opts: { agentScope?: string; detScope?: string; container: boolean }): WorkflowDefinition {
    return validateDefinition({
      name: 'wf011',
      description: 'd',
      initial: 'prep',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        prep: {
          type: 'agent',
          description: 'prep',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['o'],
          ...(opts.agentScope !== undefined ? { containerScope: opts.agentScope } : {}),
          transitions: [{ to: 'check' }],
        },
        check: {
          type: 'deterministic',
          description: 'check',
          ...(opts.container ? { container: true } : { host: true }),
          ...(opts.detScope !== undefined ? { containerScope: opts.detScope } : {}),
          run: [['echo', 'hi']],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
  }

  it('flags a mixed scope path that reaches the helper before its same-scope agent', () => {
    const raw = withDeterministic({ agentScope: 'b', detScope: 'b', container: true });
    const def: WorkflowDefinition = { ...raw, initial: 'check' };
    expect(codes(lintWorkflow(def, stubCtx))).toContain('WF011');
  });

  it('does not flag when an agent in the same scope precedes the state', () => {
    const def = withDeterministic({ agentScope: 'b', detScope: 'b', container: true });
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF011');
  });

  it('does not flag a host-side deterministic state', () => {
    const def = withDeterministic({ agentScope: 'a', container: false });
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF011');
  });

  it('allows the intentionally no-LLM nested-Docker workflow', () => {
    const manifestPath = resolve(
      __dirname,
      '..',
      '..',
      'src',
      'workflow',
      'workflows',
      'nested-docker-live-smoke',
      'workflow.yaml',
    );
    const def = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));
    expect(lintWorkflow(def, { ...stubCtx, workflowFilePath: manifestPath })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bundled evolve manifest controls
// ---------------------------------------------------------------------------

describe('bundled evolve manifest', () => {
  const manifestPath = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml');

  function loadRaw(): Record<string, unknown> {
    return parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }) as Record<string, unknown>;
  }

  it('lints clean with provision as the initial state', () => {
    const def = validateDefinition(loadRaw());
    const result = lintWorkflow(def, { ...stubCtx, workflowFilePath: manifestPath });

    expect(def.initial).toBe('provision');
    expect(result.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('fails validation if the provision blocked edge points at a missing state', () => {
    const raw = loadRaw();
    const states = raw.states as Record<string, { transitions?: Array<Record<string, unknown>> }>;
    const provision = states.provision;
    if (!provision.transitions) throw new Error('evolve provision state missing transitions');
    const blocked = provision.transitions.find((transition) => {
      const when = transition.when as Record<string, unknown> | undefined;
      return when?.verdict === 'blocked';
    });
    if (!blocked) throw new Error('evolve provision state missing blocked transition');
    blocked.to = 'missing_state';

    expect(() => validateDefinition(raw)).toThrow(/missing_state/);
  });

  it('fails validation if the initial state is missing', () => {
    const raw = loadRaw();
    raw.initial = 'missing_initial';

    expect(() => validateDefinition(raw)).toThrow(/Initial state "missing_initial" does not exist/);
  });
});

// ---------------------------------------------------------------------------
// WF012 — deterministic verdict edges need a resultFile source
// ---------------------------------------------------------------------------

describe('WF012 — deterministic verdict edges without resultFile', () => {
  function verdictWorkflow(withResultFile: boolean): WorkflowDefinition {
    return validateDefinition({
      name: 'wf012',
      description: 'd',
      initial: 'prep',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        prep: {
          type: 'agent',
          description: 'prep',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'classify' }],
        },
        classify: {
          type: 'deterministic',
          description: 'classify',
          container: true,
          ...(withResultFile ? { resultFile: '.workflow/result.json' } : {}),
          run: [['python3', '/workflow-scripts/classify.py']],
          transitions: [{ to: 'passed', when: { verdict: 'pass' } }, { to: 'failed' }],
        },
        passed: { type: 'terminal', description: 'passed' },
        failed: { type: 'terminal', description: 'failed' },
      },
    });
  }

  it('warns when a deterministic state routes on verdict but declares no resultFile', () => {
    const result = lintWorkflow(verdictWorkflow(false), stubCtx);
    expect(codes(result)).toContain('WF012');
    const d = result.find((x) => x.code === 'WF012');
    expect(d?.severity).toBe('warning');
    expect(d?.stateId).toBe('classify');
    expect(d?.message).toContain('when:{verdict}');
  });

  it('does not warn when the deterministic verdict source is declared', () => {
    expect(codes(lintWorkflow(verdictWorkflow(true), stubCtx))).not.toContain('WF012');
  });

  it('the bundled deterministic-verdict-smoke fixture lints clean for WF012', () => {
    const manifestPath = resolve(
      __dirname,
      '..',
      '..',
      'src',
      'workflow',
      'workflows',
      'deterministic-verdict-smoke',
      'workflow.yaml',
    );
    const def = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));
    expect(codes(lintWorkflow(def, { ...stubCtx, workflowFilePath: manifestPath }))).not.toContain('WF012');
  });
});

// ---------------------------------------------------------------------------
// WF015 — deterministic state runs workspace code on the host
// ---------------------------------------------------------------------------

describe('WF015 — host deterministic states', () => {
  function hostWorkflow(
    settings: Record<string, unknown>,
    check: Record<string, unknown> = { host: true, run: [['npm', 'test']] },
  ): WorkflowDefinition {
    return validateDefinition({
      name: 'wf015',
      description: 'd',
      initial: 'implement',
      settings,
      states: {
        implement: {
          type: 'agent',
          description: 'implement',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'check' }],
        },
        check: {
          type: 'deterministic',
          description: 'check',
          transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'implement' }],
          ...check,
        },
        done: { type: 'terminal', description: 'done', outputs: ['code'] },
      },
    });
  }

  it('warns on a host: true state and explains that host toolchains run workspace code', () => {
    const result = lintWorkflow(
      hostWorkflow({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true }),
      stubCtx,
    );
    const wf015 = result.filter((d) => d.code === 'WF015');

    expect(wf015).toHaveLength(1);
    expect(wf015[0]?.severity).toBe('warning');
    expect(wf015[0]?.stateId).toBe('check');
    expect(wf015[0]?.message).toContain('runs its commands on the host (host: true)');
    expect(wf015[0]?.message).toContain(
      'npm, pytest, make, cargo and git execute code and configuration from the workspace',
    );
    expect(wf015[0]?.hint).toContain('set container: true');
  });

  it('gives builtin workflows a hint that does not pretend a container exists', () => {
    const wf015 = lintWorkflow(hostWorkflow({ mode: 'builtin' }), stubCtx).find((d) => d.code === 'WF015');

    expect(wf015?.hint).toContain('Builtin mode has no container');
  });

  it('does not flag container states, fan-out drivers or states with nothing to run', () => {
    const shared = { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true };
    expect(
      codes(lintWorkflow(hostWorkflow(shared, { container: true, run: [['npm', 'test']] }), stubCtx)),
    ).not.toContain('WF015');
    expect(codes(lintWorkflow(hostWorkflow(shared, { run: [] }), stubCtx))).not.toContain('WF015');
    expect(codes(lintWorkflow(hostWorkflow(shared, { host: true, run: [[]] }), stubCtx))).not.toContain('WF015');
  });

  it('flags a fan-out driver that also runs as a segment member (its run executes in each lane)', () => {
    const def = validateDefinition({
      name: 'wf015-nested',
      description: 'd',
      initial: 'outer',
      settings: { mode: 'builtin', workers: 2 },
      states: {
        outer: {
          type: 'deterministic',
          description: 'outer',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['inner'],
          transitions: [{ to: 'done' }],
        },
        inner: {
          type: 'deterministic',
          description: 'inner',
          host: true,
          run: [['make', 'check']],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['leaf'],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        leaf: {
          type: 'agent',
          description: 'leaf',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });

    const wf015 = lintWorkflow(def, stubCtx).filter((d) => d.code === 'WF015');
    expect(wf015.map((d) => d.stateId)).toEqual(['inner']);
  });

  it('flags the example manifest, whose builtin validate state runs on the host', () => {
    const manifestPath = resolve(__dirname, '..', '..', 'examples', 'workflow-demo.yaml');
    const def = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));
    const wf015 = lintWorkflow(def, stubCtx).filter((d) => d.code === 'WF015');

    expect(wf015.map((d) => d.stateId)).toEqual(['validate']);
  });

  it('bundled workflows run no deterministic state on the host', () => {
    const workflowsDir = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows');
    for (const name of [
      'design-and-code',
      'test-email-summary',
      'deterministic-eval-smoke',
      'deterministic-verdict-smoke',
      'nested-docker-live-smoke',
      'evolve',
    ]) {
      const manifestPath = resolve(workflowsDir, name, 'workflow.yaml');
      const def = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));
      expect(codes(lintWorkflow(def, stubCtx)), name).not.toContain('WF015');
    }
  });
});

// ---------------------------------------------------------------------------
// WF013 (fan-out budget) / WF014 (fan-out child-bounds) diagnostics
// ---------------------------------------------------------------------------

describe('WF013/WF014 — fan-out scaffolding diagnostics', () => {
  function fanOutWorkflow(
    overrides: {
      settings?: Record<string, unknown>;
      workersState?: Record<string, unknown>;
      workerState?: Record<string, unknown>;
    } = {},
  ): WorkflowDefinition {
    return validateDefinition({
      name: 'fanout-lint',
      description: 'd',
      initial: 'start',
      settings: {
        mode: 'docker',
        dockerAgent: 'claude-code',
        sharedContainer: true,
        workers: 3,
        maxRounds: 5,
        ...overrides.settings,
      },
      states: {
        start: {
          type: 'agent',
          description: 'start',
          persona: 'global',
          prompt: 'start',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'workers' }],
        },
        workers: {
          type: 'deterministic',
          description: 'fan out',
          run: [['true']],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['worker'],
          transitions: [{ to: 'done' }],
          ...overrides.workersState,
        },
        worker: {
          type: 'agent',
          description: 'lane worker',
          persona: 'global',
          prompt: 'worker',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'worker', when: { verdict: 'retry' } }, { to: 'done' }],
          ...overrides.workerState,
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
  }

  it('WF013 warns the fan-out state that maxRounds caps batches, not candidates', () => {
    const result = lintWorkflow(fanOutWorkflow(), stubCtx);
    const wf013 = result.filter((d) => d.code === 'WF013');

    expect(wf013).toHaveLength(1);
    expect(wf013[0]?.severity).toBe('warning');
    expect(wf013[0]?.stateId).toBe('workers');
    expect(wf013[0]?.message).toContain('candidate budget');
  });

  it('WF014 warns a self-loopable segment child that lacks a per-lane maxVisits bound', () => {
    const result = lintWorkflow(fanOutWorkflow(), stubCtx);
    const wf014 = result.filter((d) => d.code === 'WF014');

    expect(wf014).toHaveLength(1);
    expect(wf014[0]?.severity).toBe('warning');
    expect(wf014[0]?.stateId).toBe('worker');
    expect(wf014[0]?.message).toContain('no per-lane maxVisits');
  });

  it('WF014 does not warn on child loops bounded by maxVisits and its isStateVisitLimitReached transition', () => {
    const result = lintWorkflow(
      fanOutWorkflow({
        workerState: {
          maxVisits: 3,
          transitions: [
            { to: 'done', guard: 'isStateVisitLimitReached' },
            { to: 'worker', when: { verdict: 'retry' } },
            { to: 'done' },
          ],
        },
      }),
      stubCtx,
    );

    expect(result.filter((d) => d.code === 'WF014')).toHaveLength(0);
    expect(result.filter((d) => d.code === 'WF016')).toHaveLength(0);
    // WF013 (budget) still fires on the fan-out state itself.
    const wf013 = result.filter((d) => d.code === 'WF013');
    expect(wf013).toHaveLength(1);
    expect(wf013[0]?.stateId).toBe('workers');
  });

  it('WF014 still warns when the child declares maxVisits but nothing checks it', () => {
    // maxVisits without an isStateVisitLimitReached transition never fires, so
    // it must not count as a per-lane bound (it used to silence WF014).
    const result = lintWorkflow(fanOutWorkflow({ workerState: { maxVisits: 3 } }), stubCtx);

    const wf014 = result.filter((d) => d.code === 'WF014');
    expect(wf014).toHaveLength(1);
    expect(wf014[0]?.stateId).toBe('worker');
    expect(wf014[0]?.message).toContain('isStateVisitLimitReached');
    const wf016 = result.filter((d) => d.code === 'WF016');
    expect(wf016).toHaveLength(1);
    expect(wf016[0]?.stateId).toBe('worker');
  });

  // A numeric `fanOut.count` override runs multiple lanes at runtime even at
  // settings.workers=1; WF013/WF014 gate per-state on the RESOLVED count, so the
  // numeric override no longer bypasses them.
  it('WF013/WF014 still fire when fanOut.count=3 overrides settings.workers=1', () => {
    const result = lintWorkflow(
      fanOutWorkflow({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 3, join: 'barrier' } },
      }),
      stubCtx,
    );

    const wf013 = result.filter((d) => d.code === 'WF013');
    expect(wf013).toHaveLength(1);
    expect(wf013[0]?.stateId).toBe('workers');
    // Budget math uses the state's effective workers (3), not settings.workers (1):
    // maxRounds(5) × workers(3) = 15.
    expect(wf013[0]?.message).toContain('3 lanes');
    expect(wf013[0]?.message).toContain('maxRounds × workers = 15');

    const wf014 = result.filter((d) => d.code === 'WF014');
    expect(wf014).toHaveLength(1);
    expect(wf014[0]?.stateId).toBe('worker');
  });

  it('WF013/WF014 stay silent when a numeric count resolves to a single lane (count=1, workers=1)', () => {
    const result = lintWorkflow(
      fanOutWorkflow({
        settings: { workers: 1 },
        workersState: { fanOut: { count: 1, join: 'barrier' } },
      }),
      stubCtx,
    );

    expect(result.filter((d) => d.code === 'WF013')).toHaveLength(0);
    expect(result.filter((d) => d.code === 'WF014')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WF016 / WF017 / WF018 — fields that validate but have no effect
// ---------------------------------------------------------------------------

describe('inert definition fields produce their lint codes', () => {
  interface RawInertBase {
    name: string;
    description: string;
    initial: string;
    settings: Record<string, unknown>;
    states: { work: Record<string, unknown>; done: Record<string, unknown> };
  }

  /** A one-agent workflow that lints with no diagnostics at all. */
  function inertBase(): RawInertBase {
    return {
      name: 'inert-fields',
      description: 'd',
      initial: 'work',
      settings: { mode: 'builtin' },
      states: {
        work: {
          type: 'agent',
          description: 'work',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    };
  }

  const cases: ReadonlyArray<{
    readonly field: string;
    readonly code: string;
    readonly stateId: string | undefined;
    readonly apply: (raw: RawInertBase) => void;
  }> = [
    {
      field: 'maxVisits',
      code: 'WF016',
      stateId: 'work',
      apply: (raw) => {
        raw.states.work.maxVisits = 2;
      },
    },
    {
      field: 'settings.gitRepoPath',
      code: 'WF017',
      stateId: undefined,
      apply: (raw) => {
        raw.settings.gitRepoPath = '/srv/repo';
      },
    },
    {
      field: 'worktree',
      code: 'WF017',
      stateId: 'work',
      apply: (raw) => {
        raw.states.work.worktree = true;
      },
    },
    {
      field: 'cleanup',
      code: 'WF017',
      stateId: 'done',
      apply: (raw) => {
        raw.states.done.cleanup = [['echo', 'bye']];
      },
    },
    {
      field: 'schedule.pool',
      code: 'WF018',
      stateId: 'work',
      apply: (raw) => {
        raw.states.work.schedule = { pool: 'agent' };
      },
    },
    {
      field: 'schedule.resources',
      code: 'WF018',
      stateId: 'work',
      apply: (raw) => {
        raw.states.work.schedule = { pool: 'agent', resources: { mem: '1g' } };
      },
    },
  ];

  it('the baseline has no diagnostics', () => {
    expect(lintWorkflow(validateDefinition(inertBase()), stubCtx)).toEqual([]);
  });

  for (const { field, code, stateId, apply } of cases) {
    it(`${field} -> ${code} warning`, () => {
      const raw = inertBase();
      apply(raw);
      const matching = lintWorkflow(validateDefinition(raw), stubCtx).filter(
        (d) => d.code === code && d.message.includes(field),
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].severity).toBe('warning');
      expect(matching[0].stateId).toBe(stateId);
    });
  }
});

describe('WF016 — visit cap that is never checked', () => {
  /** plan -> review loop; `review` merges the caller's fields over a capped default. */
  function loopWorkflow(review: Record<string, unknown>): WorkflowDefinition {
    return validateDefinition({
      name: 'wf016',
      description: 'd',
      initial: 'plan',
      states: {
        // `plan` also reaches `escalated`, so it stays reachable when the
        // test removes the cap-guarded edge from `review`.
        plan: {
          type: 'agent',
          description: 'plan',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'escalated', when: { verdict: 'escalate' } }, { to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'review',
          persona: 'global',
          prompt: 'p',
          inputs: ['plan'],
          outputs: ['review'],
          maxVisits: 3,
          transitions: [
            { to: 'done', when: { verdict: 'approved' } },
            { to: 'escalated', guard: 'isStateVisitLimitReached' },
            { to: 'plan', when: { verdict: 'rejected' } },
          ],
          ...review,
        },
        done: { type: 'terminal', description: 'done' },
        escalated: { type: 'terminal', description: 'escalated' },
      },
    });
  }

  const loopWithoutCapGuard = [
    { to: 'done', when: { verdict: 'approved' } },
    { to: 'plan', when: { verdict: 'rejected' } },
  ];

  it('stays silent when maxVisits is paired with its guard on the same state', () => {
    expect(codes(lintWorkflow(loopWorkflow({}), stubCtx))).not.toContain('WF016');
  });

  it('warns about maxVisits that no isStateVisitLimitReached transition checks', () => {
    const result = lintWorkflow(loopWorkflow({ transitions: loopWithoutCapGuard }), stubCtx);
    const wf016 = result.filter((d) => d.code === 'WF016');
    expect(wf016).toHaveLength(1);
    expect(wf016[0].stateId).toBe('review');
    expect(wf016[0].severity).toBe('warning');
    expect(wf016[0].message).toContain('maxVisits=3');
    expect(wf016[0].message).toContain('never checked');
    // Not an ordering problem: WF008 stays out of it.
    expect(codes(result)).not.toContain('WF008');
  });

  it('warns about an isStateVisitLimitReached transition on a state without maxVisits', () => {
    const result = lintWorkflow(loopWorkflow({ maxVisits: undefined }), stubCtx);
    const wf016 = result.filter((d) => d.code === 'WF016');
    expect(wf016).toHaveLength(1);
    expect(wf016[0].stateId).toBe('review');
    expect(wf016[0].message).toContain('declares no maxVisits');
    expect(wf016[0].hint).toContain('Add maxVisits');
  });

  it('warns about an isStateVisitLimitReached transition on a deterministic state', () => {
    const def = validateDefinition({
      name: 'wf016-det',
      description: 'd',
      initial: 'check',
      states: {
        check: {
          type: 'deterministic',
          description: 'check',
          host: true,
          run: [['true']],
          transitions: [{ to: 'escalated', guard: 'isStateVisitLimitReached' }, { to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
        escalated: { type: 'terminal', description: 'escalated' },
      },
    });
    const wf016 = lintWorkflow(def, stubCtx).filter((d) => d.code === 'WF016');
    expect(wf016).toHaveLength(1);
    expect(wf016[0].stateId).toBe('check');
    expect(wf016[0].hint).toContain('Only plain agent states');
  });

  it('warns about maxVisits on a fan-out parent even with the guard', () => {
    const def = validateDefinition({
      name: 'wf016-fanout',
      description: 'd',
      initial: 'batch',
      states: {
        batch: {
          type: 'agent',
          description: 'fan-out parent',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['lane'],
          maxVisits: 2,
          transitions: [{ to: 'escalated', guard: 'isStateVisitLimitReached' }, { to: 'done' }],
        },
        lane: {
          type: 'agent',
          description: 'lane',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
        escalated: { type: 'terminal', description: 'escalated' },
      },
    });
    const wf016 = lintWorkflow(def, stubCtx).filter((d) => d.code === 'WF016');
    expect(wf016).toHaveLength(1);
    expect(wf016[0].stateId).toBe('batch');
    expect(wf016[0].message).toContain('fan-out states do not count visits');
  });
});

describe('WF017 — legacy fields that are accepted but ignored', () => {
  function legacyWorkflow(opts: {
    gitRepoPath?: string;
    worktree?: boolean;
    cleanup?: string[][];
  }): WorkflowDefinition {
    return validateDefinition({
      name: 'wf017',
      description: 'd',
      initial: 'work',
      settings: { mode: 'builtin', ...(opts.gitRepoPath !== undefined ? { gitRepoPath: opts.gitRepoPath } : {}) },
      states: {
        work: {
          type: 'agent',
          description: 'work',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: [],
          ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
          transitions: [{ to: 'done' }],
        },
        done: {
          type: 'terminal',
          description: 'done',
          ...(opts.cleanup !== undefined ? { cleanup: opts.cleanup } : {}),
        },
      },
    });
  }

  it('warns about settings.gitRepoPath without echoing the path', () => {
    const wf017 = lintWorkflow(legacyWorkflow({ gitRepoPath: '/home/someone/secret-repo' }), stubCtx).filter(
      (d) => d.code === 'WF017',
    );
    expect(wf017).toHaveLength(1);
    expect(wf017[0].stateId).toBeUndefined();
    expect(wf017[0].message).toContain('settings.gitRepoPath is ignored');
    expect(wf017[0].message).not.toContain('secret-repo');
  });

  it('warns about worktree on an agent state, whichever value it has', () => {
    for (const worktree of [true, false]) {
      const wf017 = lintWorkflow(legacyWorkflow({ worktree }), stubCtx).filter((d) => d.code === 'WF017');
      expect(wf017).toHaveLength(1);
      expect(wf017[0].stateId).toBe('work');
      expect(wf017[0].message).toContain(`worktree: ${worktree}`);
      expect(wf017[0].message).toContain('no git worktree is created');
    }
  });

  it('warns that terminal cleanup commands never run, without echoing them', () => {
    const wf017 = lintWorkflow(legacyWorkflow({ cleanup: [['rm', '-rf', 'build-cache']] }), stubCtx).filter(
      (d) => d.code === 'WF017',
    );
    expect(wf017).toHaveLength(1);
    expect(wf017[0].stateId).toBe('done');
    expect(wf017[0].message).toContain('never run');
    expect(wf017[0].message).not.toContain('build-cache');
  });

  it('reports each legacy field separately', () => {
    const wf017 = lintWorkflow(
      legacyWorkflow({ gitRepoPath: '/repo', worktree: true, cleanup: [['true']] }),
      stubCtx,
    ).filter((d) => d.code === 'WF017');
    expect(wf017.map((d) => d.stateId ?? '(settings)')).toEqual(['(settings)', 'work', 'done']);
  });
});

describe('WF018 — lane scheduling metadata without a scheduler', () => {
  function scheduledWorkflow(schedule: Record<string, unknown>): WorkflowDefinition {
    return validateDefinition({
      name: 'wf018',
      description: 'd',
      initial: 'workers',
      states: {
        workers: {
          type: 'deterministic',
          description: 'fan out',
          run: [],
          fanOut: { count: 'workers', join: 'barrier' },
          segment: ['check'],
          transitions: [{ to: 'done' }],
        },
        check: {
          type: 'deterministic',
          description: 'lane check',
          host: true,
          run: [['true']],
          fanOutMember: true,
          schedule,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
  }

  it('warns that the scheduling pool is ignored', () => {
    const wf018 = lintWorkflow(scheduledWorkflow({ pool: 'eval' }), stubCtx).filter((d) => d.code === 'WF018');
    expect(wf018).toHaveLength(1);
    expect(wf018[0].stateId).toBe('check');
    expect(wf018[0].severity).toBe('warning');
    expect(wf018[0].message).toContain('schedule.pool "eval"');
  });

  it('separately warns that resource requests are not enforced, naming the fields but not the values', () => {
    const wf018 = lintWorkflow(scheduledWorkflow({ pool: 'eval', resources: { cpu: 2, mem: '3g' } }), stubCtx).filter(
      (d) => d.code === 'WF018',
    );
    expect(wf018).toHaveLength(2);
    const resources = wf018.find((d) => d.message.includes('schedule.resources'));
    expect(resources?.stateId).toBe('check');
    expect(resources?.message).toContain('(cpu, mem)');
    expect(resources?.message).toContain('not enforced');
    expect(resources?.message).not.toContain('3g');
  });
});

// ---------------------------------------------------------------------------
// WF019 — fan-out wider than the default resource envelope
// ---------------------------------------------------------------------------

describe('WF019 — fan-out width', () => {
  function widthWorkflow(settings: Record<string, unknown>, count: 'workers' | number = 'workers'): WorkflowDefinition {
    return validateDefinition({
      name: 'fanout-width',
      description: 'd',
      initial: 'workers',
      settings,
      states: {
        workers: {
          type: 'deterministic',
          description: 'fan out',
          run: [['true']],
          fanOut: { count, join: 'barrier' },
          segment: ['worker'],
          transitions: [{ to: 'done' }],
        },
        worker: {
          type: 'agent',
          description: 'lane worker',
          persona: 'global',
          prompt: 'worker',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
  }

  const shared = { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true };

  it('warns a shared-container fan-out wider than 4 lanes about the one container budget', () => {
    const wf019 = lintWorkflow(widthWorkflow({ ...shared, workers: 8 }), stubCtx).filter((d) => d.code === 'WF019');
    expect(wf019).toHaveLength(1);
    expect(wf019[0]?.severity).toBe('warning');
    expect(wf019[0]?.stateId).toBe('workers');
    expect(wf019[0]?.message).toContain('8 concurrent lanes in one shared container');
    expect(wf019[0]?.hint).toContain("Cap workers to the container's CPU and RAM budget");
  });

  it('warns a non-shared fan-out wider than 4 lanes about the agent concurrency cap', () => {
    const wf019 = lintWorkflow(widthWorkflow({ mode: 'builtin', workers: 6 }), stubCtx).filter(
      (d) => d.code === 'WF019',
    );
    expect(wf019).toHaveLength(1);
    expect(wf019[0]?.message).toContain('maxConcurrentAgentSessions');
  });

  it('gates on the resolved lane count, including a numeric fanOut.count override', () => {
    expect(codes(lintWorkflow(widthWorkflow({ ...shared, workers: 1 }, 5), stubCtx))).toContain('WF019');
    expect(codes(lintWorkflow(widthWorkflow({ ...shared, workers: 4 }), stubCtx))).not.toContain('WF019');
    expect(codes(lintWorkflow(widthWorkflow({ ...shared, workers: 9 }, 2), stubCtx))).not.toContain('WF019');
  });
});

// ---------------------------------------------------------------------------
// WF008 — a transition that leaves the loop through a visit reset
// ---------------------------------------------------------------------------

describe('WF008 — loop exits through a visit-count reset', () => {
  /**
   * planner -> design -> review (capped) with review able to hand control
   * back to the planner (`replan`) ahead of its cap guard.
   */
  function replanWorkflow(options: { resetOnRedispatch: boolean; bypass?: boolean }): WorkflowDefinition {
    const redispatch: Record<string, unknown> = { to: 'design', when: { verdict: 'design' } };
    if (options.resetOnRedispatch) {
      redispatch.actions = [{ type: 'resetVisitCounts', stateIds: ['design', 'review'] }];
    }
    const plannerTransitions: unknown[] = [redispatch, { to: 'done', when: { verdict: 'complete' } }];
    // A second planner route back into design that does not reset review's count.
    if (options.bypass === true) plannerTransitions.splice(1, 0, { to: 'design', when: { verdict: 'again' } });
    return validateDefinition({
      name: 'replan',
      description: 'review can return a flawed directive to the planner',
      initial: 'planner',
      states: {
        planner: {
          type: 'agent',
          description: 'planner',
          persona: 'global',
          prompt: 'p',
          inputs: ['review?'],
          outputs: ['plan'],
          transitions: plannerTransitions,
        },
        design: {
          type: 'agent',
          description: 'design',
          persona: 'global',
          prompt: 'p',
          inputs: ['plan'],
          outputs: ['design'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'review',
          persona: 'global',
          prompt: 'p',
          inputs: ['design'],
          outputs: ['review'],
          maxVisits: 3,
          transitions: [
            { to: 'done', when: { verdict: 'approved' } },
            { to: 'planner', when: { verdict: 'replan' } },
            { to: 'gate', guard: 'isStateVisitLimitReached' },
            { to: 'design', when: { verdict: 'rejected' } },
          ],
        },
        gate: {
          type: 'human_gate',
          description: 'cap reached',
          acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'planner', event: 'FORCE_REVISION' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'done' },
        aborted: { type: 'terminal', description: 'aborted' },
      },
    });
  }

  it('accepts a verdict ahead of the cap whose target re-enters the loop only through a reset of the capped state', () => {
    expect(codes(lintWorkflow(replanWorkflow({ resetOnRedispatch: true }), stubCtx))).not.toContain('WF008');
  });

  it('still flags it when the way back into the loop keeps the visit count', () => {
    const result = lintWorkflow(replanWorkflow({ resetOnRedispatch: false }), stubCtx);
    const d = result.find((x) => x.code === 'WF008');
    expect(d?.stateId).toBe('review');
    expect(d?.message).toContain('replan');
    expect(d?.message).toContain('position 2');
  });

  it('still flags it when any path back skips the reset', () => {
    const result = lintWorkflow(replanWorkflow({ resetOnRedispatch: true, bypass: true }), stubCtx);
    expect(codes(result)).toContain('WF008');
  });
});

// ---------------------------------------------------------------------------
// WF020 — model provider the state's harness does not call
// ---------------------------------------------------------------------------

describe('WF020 — model provider vs agent harness', () => {
  function harnessWorkflow(settings: Record<string, unknown>, reviewer: Record<string, unknown>): WorkflowDefinition {
    return validateDefinition({
      name: 'harness-model',
      description: 'coder on the default harness, reviewer overridden',
      initial: 'coder',
      settings,
      states: {
        coder: {
          type: 'agent',
          description: 'coder',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'reviewer' }],
        },
        reviewer: {
          type: 'agent',
          description: 'reviewer',
          persona: 'global',
          prompt: 'p',
          inputs: ['code'],
          outputs: ['review'],
          transitions: [{ to: 'done' }],
          ...reviewer,
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
  }

  it('warns when a codex state inherits an anthropic settings.model', () => {
    const result = lintWorkflow(
      harnessWorkflow({ mode: 'docker', model: 'anthropic:claude-opus-4-8' }, { dockerAgent: 'codex' }),
      stubCtx,
    );
    const wf020 = result.filter((d) => d.code === 'WF020');
    expect(wf020).toHaveLength(1);
    expect(wf020[0]).toMatchObject({ severity: 'warning', stateId: 'reviewer' });
    expect(wf020[0]?.message).toContain('codex harness');
    expect(wf020[0]?.message).toContain('inherited from settings.model');
    expect(wf020[0]?.hint).toContain('"openai:" model');
  });

  it('warns when a claude-code state names an openai model', () => {
    const result = lintWorkflow(harnessWorkflow({ mode: 'docker' }, { model: 'openai:gpt-5' }), stubCtx);
    expect(result.filter((d) => d.code === 'WF020').map((d) => d.stateId)).toEqual(['reviewer']);
  });

  it('is silent for matching providers, bare model names, goose and builtin mode', () => {
    const silent: Array<[string, WorkflowDefinition]> = [
      [
        'matching providers',
        harnessWorkflow(
          { mode: 'docker', model: 'anthropic:claude-opus-4-8' },
          { dockerAgent: 'codex', model: 'openai:gpt-5' },
        ),
      ],
      [
        'bare model names',
        harnessWorkflow({ mode: 'docker', model: 'claude-opus-4-8' }, { dockerAgent: 'codex', model: 'gpt-5' }),
      ],
      ['goose', harnessWorkflow({ mode: 'docker', dockerAgent: 'goose', model: 'google:gemini-2.5-pro' }, {})],
      ['builtin', harnessWorkflow({ mode: 'builtin', model: 'openai:gpt-5' }, {})],
    ];
    for (const [label, def] of silent) {
      expect(codes(lintWorkflow(def, stubCtx)), label).not.toContain('WF020');
    }
  });
});
