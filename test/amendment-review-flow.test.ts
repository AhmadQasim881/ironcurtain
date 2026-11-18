/**
 * The customize-policy flows offer amendments learned from repeated human
 * approvals before their LLM conversation: `ironcurtain customize-policy`
 * for the global constitution, and the shared loop behind the persona and
 * job customizers. The prompts are scripted and the model is a mock that the
 * flows never call (the user finishes with "done"), so no LLM or network is
 * involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';

const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => prompts.select(...args),
  text: (...args: unknown[]) => prompts.text(...args),
  confirm: (...args: unknown[]) => prompts.confirm(...args),
  note: (...args: unknown[]) => prompts.note(...args),
  cancel: (...args: unknown[]) => prompts.cancel(...args),
  intro: (...args: unknown[]) => prompts.intro(...args),
  outro: (...args: unknown[]) => prompts.outro(...args),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  log: { info: prompts.logInfo, success: prompts.logSuccess, error: vi.fn(), warn: vi.fn(), step: vi.fn() },
}));

const model = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../src/pipeline/pipeline-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/pipeline-shared.js')>();
  return {
    ...actual,
    createPipelineLlm: async () => ({
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          model.calls += 1;
          throw new Error('the model must not be called');
        },
      }),
      logContext: { stepName: 'test' },
    }),
  };
});

import { personaApprovalScope, readApprovalHistory, recordHumanApproval } from '../src/audit/approval-history.js';
import { GLOBAL_APPROVAL_SCOPE, type ApprovalScope } from '../src/audit/approval-history.js';
import { runPersonaConstitutionCustomizer } from '../src/persona/persona-customizer.js';
import { main as customizePolicy } from '../src/pipeline/constitution-customizer.js';
import { getUserConstitutionPath } from '../src/config/paths.js';

const AMENDMENT =
  'The agent may use the `filesystem/write_file` tool without asking for human approval ' +
  'when it writes files within `/srv/reports`.';

let home: string;
let wasTty: boolean | undefined;

function approveThreeTimes(scope: ApprovalScope): void {
  for (let i = 0; i < 3; i += 1) {
    recordHumanApproval(scope, {
      serverName: 'filesystem',
      toolName: 'write_file',
      rule: 'escalate-write-outside-permitted-areas',
      constraints: [{ kind: 'directory', role: 'write-path', directory: '/srv/reports' }],
      description: 'Allow filesystem/write_file write-path within /srv/reports',
    });
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ironcurtain-amendment-flow-'));
  process.env.IRONCURTAIN_HOME = home;
  wasTty = process.stdin.isTTY;
  process.stdin.isTTY = true;
  model.calls = 0;
  for (const fn of Object.values(prompts)) fn.mockReset();
  prompts.text.mockResolvedValue('done');
  prompts.confirm.mockResolvedValue(false);
});

afterEach(() => {
  process.stdin.isTTY = wasTty as boolean;
  delete process.env.IRONCURTAIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('persona customizer', () => {
  const coder = personaApprovalScope('coder') as ApprovalScope;
  const initial = '# Coder\n\n - The agent may read files in the workspace\n';

  it('adds an accepted amendment to the constitution it returns', async () => {
    approveThreeTimes(coder);
    prompts.select.mockResolvedValueOnce('accept');
    const result = await runPersonaConstitutionCustomizer(initial, 'writes reports', undefined, coder);
    expect(result).toBe(`${initial} - ${AMENDMENT}\n`);
    expect(prompts.select).toHaveBeenCalledTimes(1);
    expect(model.calls).toBe(0);
  });

  it('leaves the constitution alone and records a dismissal', async () => {
    approveThreeTimes(coder);
    prompts.select.mockResolvedValueOnce('dismiss');
    const result = await runPersonaConstitutionCustomizer(initial, 'writes reports', undefined, coder);
    expect(result).toBe(initial);
    expect(readApprovalHistory().filter((r) => r.type === 'decision')).toHaveLength(1);
  });

  it('offers nothing without a scope or for another scope', async () => {
    approveThreeTimes(coder);
    await runPersonaConstitutionCustomizer(initial, 'writes reports');
    await runPersonaConstitutionCustomizer(initial, 'writes reports', undefined, personaApprovalScope('other'));
    expect(prompts.select).not.toHaveBeenCalled();
  });
});

describe('ironcurtain customize-policy', () => {
  it('saves an accepted global amendment with the user constitution', async () => {
    approveThreeTimes(GLOBAL_APPROVAL_SCOPE);
    prompts.select.mockResolvedValueOnce('accept');
    await customizePolicy();
    const saved = readFileSync(getUserConstitutionPath(), 'utf8');
    expect(saved).toContain(` - ${AMENDMENT}`);
    // Saved, then the user declined to compile; the model was never consulted.
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(model.calls).toBe(0);
  });

  it('saves nothing when the proposal is skipped', async () => {
    approveThreeTimes(GLOBAL_APPROVAL_SCOPE);
    prompts.select.mockResolvedValueOnce('skip');
    await customizePolicy();
    expect(readFileSync(getUserConstitutionPath(), 'utf8')).not.toContain(AMENDMENT);
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});
