/**
 * Tests for the doctor's persona and job checks
 * (src/doctor/persona-job-checks.ts) and its upgrade checks
 * (src/doctor/upgrade-checks.ts), against a scratch IronCurtain home.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashConstitutionText, isScopedPolicyError } from '../src/config/constitution-hash.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { checkJobDefinitions } from '../src/doctor/job-checks.js';
import { checkJobs, checkPersonas } from '../src/doctor/persona-job-checks.js';
import {
  checkChangesSince,
  checkPolicyFreshness,
  checkVersionState,
  checkWorkflowDefinitions,
  checkWorkflowRuns,
  checkWorkflowSnapshots,
  currentAgentImageBuildHashes,
  type SnapshotImageInspector,
} from '../src/doctor/upgrade-checks.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { getAgent, registerBuiltinAdapters } from '../src/docker/agent-registry.js';
import { agentImageBuildOptions, describeAgentImageBuild } from '../src/docker/docker-infrastructure.js';
import { resolvePersona } from '../src/persona/resolve.js';
import { readPersonaOverrides, type PersonaOverrides } from '../src/persona/persona-overrides.js';
import { buildPolicyProvenance } from '../src/policy-artifacts/provenance.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';

/** The annotations policies are evaluated with; the broad rule below is for `fetch`. */
const annotations: StoredToolAnnotationsFile = { generatedAt: 'x', servers: { fetch: { inputHash: 'h', tools: [] } } };

function configWith(servers: string[] = ['filesystem', 'git']): IronCurtainConfig {
  return {
    mcpServers: Object.fromEntries(servers.map((name) => [name, { command: 'true', args: [] }])),
  } as unknown as IronCurtainConfig;
}

/** A compiled policy as a current compile writes it: constitution hash and provenance. */
function writePolicy(dir: string, constitution: string, rules: unknown[] = []): void {
  mkdirSync(dir, { recursive: true });
  const provenance = buildPolicyProvenance({ policy: { rules: rules as never }, annotations });
  writeFileSync(
    join(dir, 'compiled-policy.json'),
    JSON.stringify({
      generatedAt: 'x',
      inputHash: 'x',
      constitutionHash: hashConstitutionText(constitution),
      provenance,
      rules,
    }),
  );
}

function writePersona(home: string, name: string, definition: Record<string, unknown>, rules: unknown[] = []): void {
  const dir = join(home, 'personas', name);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'persona.json'), JSON.stringify(definition));
  writeFileSync(join(dir, 'constitution.md'), `constitution of ${name}\n`);
  writePolicy(join(dir, 'generated'), `constitution of ${name}\n`, rules);
}

function personaDefinition(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, description: 'd', createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

/** What a session reads of a persona's model and limits (buildSessionConfig does the same). */
function resolveSessionPersonaOverrides(name: string): PersonaOverrides {
  return readPersonaOverrides(name, resolvePersona(name).persona);
}

function jobDefinition(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    schedule: '0 9 * * *',
    taskDescription: 'do it',
    taskConstitution: `constitution of ${id}`,
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...extra,
  };
}

const broadRule = {
  name: 'allow-everything',
  description: 'd',
  principle: 'p',
  if: { server: ['fetch'], tool: ['http_fetch'], domains: { roles: [], allowed: ['*'] } },
  then: 'allow',
  reason: 'r',
};

/**
 * Names no domain: with the shipped annotations (`http_fetch.url` is a
 * `fetch-url`), every URL is allowed, which needs the broad-policy opt-in.
 */
const unconstrainedRule = {
  name: 'allow-any-url',
  description: 'd',
  principle: 'p',
  if: { server: ['fetch'], tool: ['http_fetch'] },
  then: 'allow',
  reason: 'r',
};

describe('doctor persona, job and upgrade checks', () => {
  let home: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-upgrade-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe('personas', () => {
    it('accepts a valid persona with a current policy', () => {
      writePersona(home, 'helper', personaDefinition('helper', { servers: ['git'] }));
      expect(checkPersonas(configWith(), annotations)).toMatchObject({
        status: 'ok',
        message: '1 persona, all usable and current',
      });
    });

    it('reports a renamed copy, unknown servers, a missing or stale policy and an unapproved broad policy', () => {
      writePersona(home, 'copy', personaDefinition('original', { servers: ['nope'] }));
      writePersona(home, 'stale', personaDefinition('stale'));
      writeFileSync(join(home, 'personas', 'stale', 'constitution.md'), 'edited\n');
      mkdirSync(join(home, 'personas', 'nopolicy'), { recursive: true });
      writeFileSync(join(home, 'personas', 'nopolicy', 'persona.json'), JSON.stringify(personaDefinition('nopolicy')));
      writePersona(home, 'broad', personaDefinition('broad'), [broadRule]);
      writePersona(home, 'optedin', personaDefinition('optedin', { allowBroadPolicy: true }), [broadRule]);

      const result = checkPersonas(configWith(), annotations);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('4 of 5 personas need attention');
      // The check loadPersona applies (persona-definition.ts), so doctor and sessions agree.
      expect(result.message).toContain(
        'persona.json name: "original" does not match the persona\'s directory name "copy"',
      );
      expect(result.message).toContain('ironcurtain persona clone original copy');
      expect(result.message).toContain('servers names unconfigured server(s) "nope"');
      expect(result.message).toContain('stale compiled policy: the constitution changed after the policy was compiled');
      expect(result.message).toContain('no compiled policy (run: ironcurtain persona compile nopolicy)');
      expect(result.message).toContain(
        'persona "broad": its policy grants broad access (broad wildcard domain/list access: *) but the persona ' +
          'has not opted in, so sessions refuse it',
      );
      expect(result.message).not.toContain('optedin');
    });

    it('reports every persona.json loadPersona refuses, so doctor and sessions agree', () => {
      writePersona(home, 'typo', personaDefinition('typo', { server: ['git'] }));
      writePersona(home, 'stringly', personaDefinition('stringly', { allowBroadPolicy: 'false' }));
      writePersona(home, 'fine', personaDefinition('fine'));

      const result = checkPersonas(configWith(), annotations);
      expect(result.message).toContain('2 of 3 personas need attention');
      expect(result.message).toContain('persona.json server: unknown field');
      expect(result.message).toContain('persona.json allowBroadPolicy: expected a boolean, got "false"');
      expect(result.message).not.toContain('"fine"');
      for (const name of ['typo', 'stringly']) {
        expect(() => resolvePersona(name)).toThrow(expect.objectContaining({ code: 'PERSONA_INVALID' }));
      }
      expect(() => resolvePersona('fine')).not.toThrow();
    });

    it('reports every policy resolvePersona refuses as too broad, unconstrained allow rules included', () => {
      writePersona(home, 'anyurl', personaDefinition('anyurl'), [unconstrainedRule]);
      writePersona(home, 'optedin', personaDefinition('optedin', { allowBroadPolicy: true }), [unconstrainedRule]);

      const result = checkPersonas(configWith(), annotations);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('1 of 2 personas needs attention');
      expect(result.message).toContain(
        'persona "anyurl": its policy grants broad access (allow rule(s) with unconstrained arguments: allow-any-url',
      );
      expect(result.message).toContain('ironcurtain persona compile anyurl --allow-broad');
      expect(result.message).not.toContain('optedin');
      // The same judgment sessions make.
      let refusal: unknown;
      try {
        resolvePersona('anyurl');
      } catch (err) {
        refusal = err;
      }
      expect(isScopedPolicyError(refusal, 'POLICY_TOO_BROAD')).toBe(true);
      expect(() => resolvePersona('optedin')).not.toThrow();
    });

    it('reports an agent model or resource limits that sessions refuse, as sessions judge them', () => {
      writePersona(home, 'agentname', personaDefinition('agentname', { agentModelId: 'codex' }));
      writePersona(home, 'negative', personaDefinition('negative', { resourceBudget: { maxSteps: -1 } }));
      writePersona(
        home,
        'tuned',
        personaDefinition('tuned', {
          agentModelId: 'anthropic:claude-haiku-4-5',
          resourceBudget: { maxEstimatedCostUsd: 1, maxSteps: null },
        }),
      );

      const result = checkPersonas(configWith(), annotations);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('2 of 3 personas need attention');
      expect(result.message).toContain(
        'agentModelId is invalid ("codex" is an agent, not a model), so sessions refuse it',
      );
      expect(result.message).toMatch(/resourceBudget is invalid \(maxSteps: [^)]+\), so sessions refuse it/);
      expect(result.message).not.toContain('tuned');
      // The same judgment sessions make.
      expect(() => resolveSessionPersonaOverrides('agentname')).toThrow(/invalid agentModelId/);
      expect(() => resolveSessionPersonaOverrides('negative')).toThrow(/invalid resourceBudget/);
      expect(() => resolveSessionPersonaOverrides('tuned')).not.toThrow();
    });

    it('reports a policy compiled before provenance was recorded as stale', () => {
      writePersona(home, 'old', personaDefinition('old'));
      const dir = join(home, 'personas', 'old', 'generated');
      writeFileSync(
        join(dir, 'compiled-policy.json'),
        JSON.stringify({
          generatedAt: 'x',
          inputHash: 'x',
          constitutionHash: hashConstitutionText('constitution of old\n'),
          rules: [],
        }),
      );
      expect(checkPersonas(configWith(), annotations).message).toContain(
        'its compiled policy is stale: it records no provenance',
      );
    });
  });

  describe('jobs', () => {
    function writeJob(id: string, definition: Record<string, unknown> | string, withPolicy = true): void {
      const dir = join(home, 'jobs', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'job.json'), typeof definition === 'string' ? definition : JSON.stringify(definition));
      if (withPolicy) writePolicy(join(dir, 'generated'), `constitution of ${id}`);
    }

    it('accepts a valid job with a current policy', () => {
      writeJob('daily', jobDefinition('daily'));
      expect(checkJobs(annotations)).toMatchObject({ status: 'ok', message: '1 job, all usable and current' });
    });

    it('reports jobs the daemon skips and jobs whose policy is missing or stale', () => {
      writeJob('broken', '{oops');
      writeJob('renamed', jobDefinition('other'));
      writeJob('nopolicy', jobDefinition('nopolicy'), false);
      writeJob('edited', jobDefinition('edited', { taskConstitution: 'changed' }));
      const result = checkJobs(annotations);
      expect(result.status).toBe('warn');
      expect(result.message).toContain(
        'job "broken": job.json is invalid (not valid JSON (Expected property name or \'}\' in JSON at position 1',
      );
      expect(result.message).toContain(
        'job "renamed": job.json is invalid (id "other" does not match its job directory "renamed"); the daemon ' +
          'does not schedule this job',
      );
      expect(result.message).toContain('Job "nopolicy" has no compiled policy');
      expect(result.message).toContain('Job "edited" has a stale compiled policy');
    });

    it('judges job.json with the job store, so it agrees with the Cron jobs line', () => {
      // A job.json of the right shape that the store's schema refuses: the
      // daemon does not schedule it.
      writeJob('badbudget', jobDefinition('badbudget', { budgetOverrides: { maxSteps: 'many' } }));
      writeJob('noschedule', jobDefinition('noschedule', { schedule: '' }));
      writeJob('good', jobDefinition('good'));

      const result = checkJobs(annotations);
      expect(result.status).toBe('warn');
      expect(result.message).toContain('2 of 3 jobs need attention');
      expect(result.message).toContain('job "badbudget": job.json is invalid (budgetOverrides.maxSteps:');
      expect(result.message).toContain('job "noschedule": job.json is invalid (schedule:');
      expect(result.message).not.toContain('job "good"');
      const definitions = checkJobDefinitions();
      expect(definitions.message).toContain('badbudget: INVALID: budgetOverrides.maxSteps:');
      expect(definitions.message).toContain('noschedule: INVALID: schedule:');
    });
  });

  describe('version state', () => {
    it('reports the version change the next command will record', () => {
      expect(checkVersionState('1.0.0').message).toBe('1.0.0 (new home)');
      writeFileSync(join(home, 'state.json'), JSON.stringify({ layoutVersion: 1, lastRunVersion: '1.0.0' }));
      expect(checkVersionState('1.0.0')).toMatchObject({ status: 'ok', message: '1.0.0' });
      writeFileSync(join(home, 'state.json'), JSON.stringify({ layoutVersion: 1, lastRunVersion: '0.9.0' }));
      const upgraded = checkVersionState('1.0.0');
      expect(upgraded).toMatchObject({ status: 'warn', message: '1.0.0; this home was last used by 0.9.0' });
      expect(upgraded.hint).toContain('ironcurtain doctor --upgrade');
      expect(checkVersionState('1.0.0', true).hint).toBe('See the Upgrade section below.');
    });

    it('fails a newer layout even when the rest of the record is not readable by this version', () => {
      writeFileSync(join(home, 'state.json'), JSON.stringify({ layoutVersion: 2, lastRun: { version: '2.0.0' } }));
      const result = checkVersionState('1.0.0');
      expect(result.status).toBe('fail');
      expect(result.message).toContain('has layout version 2, newer than the layout version 1');
    });

    it("lists this version's CHANGELOG behavior changes since the last run", () => {
      writeFileSync(join(home, 'state.json'), JSON.stringify({ layoutVersion: 1, lastRunVersion: '0.13.0' }));
      const result = checkChangesSince('0.14.0');
      expect(result.name).toBe('Changes since last run');
      expect(result.message).toContain('(0.13.0 -> 0.14.0)');
      expect(result.message).toContain('Node.js support is now limited to 24 and 26');
    });
  });

  describe('workflows', () => {
    const validDefinition = {
      name: 'tiny',
      description: 'd',
      initial: 'done',
      states: { done: { type: 'terminal', description: 'd' } },
    };

    function writeRun(id: string, checkpoint: Record<string, unknown>, definition: unknown = validDefinition): string {
      const dir = join(home, 'workflow-runs', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(checkpoint));
      writeFileSync(join(dir, 'definition.json'), JSON.stringify(definition));
      return dir;
    }

    const checkpoint = (extra: Record<string, unknown> = {}) => ({
      machineState: 'done',
      context: {},
      timestamp: 'x',
      transitionHistory: [],
      definitionPath: '/nowhere/workflow.yaml',
      ...extra,
    });

    it('reports workflow packages of the user own that no longer validate', async () => {
      const root = join(home, 'workflows');
      mkdirSync(join(root, 'good'), { recursive: true });
      writeFileSync(join(root, 'good', 'workflow.yaml'), JSON.stringify(validDefinition));
      mkdirSync(join(root, 'bad'), { recursive: true });
      writeFileSync(join(root, 'bad', 'workflow.yaml'), 'name: bad\ninitial: nope\nstates: {}\n');
      mkdirSync(join(root, 'not-a-package'), { recursive: true });
      const result = await checkWorkflowDefinitions();
      expect(result.status).toBe('warn');
      expect(result.message).toContain('1 of 2 no longer validate');
      expect(result.message).toContain('"bad"');
    });

    it('reports resumable runs that resume would refuse', async () => {
      writeRun('wf-ok', checkpoint());
      writeRun('wf-done', checkpoint({ finalStatus: { phase: 'completed' } }), { broken: true });
      writeRun('wf-invalid', checkpoint(), { name: 'x', initial: 'missing', states: {} });
      writeRun('wf-gone-state', checkpoint({ machineState: 'review' }));
      writeRun('wf-moved', checkpoint({ workspacePath: '/old-home/.ironcurtain/workflow-runs/wf-moved/workspace' }));
      writeRun('wf-missing-ws', checkpoint({ workspacePath: join(home, 'elsewhere') }));

      const result = await checkWorkflowRuns();
      expect(result.status).toBe('warn');
      expect(result.message).toContain('"wf-invalid": its definition');
      expect(result.message).toContain('no longer validates, so resume fails');
      expect(result.message).toContain('"wf-gone-state": its definition has no state "review" any more');
      // Run-local paths follow the run directory (a moved home): the workspace
      // resume looks for is this home's, and it is missing.
      expect(result.message).toContain(
        `"wf-moved": its workspace ${join(home, 'workflow-runs', 'wf-moved', 'workspace')} (recorded as ` +
          '/old-home/.ironcurtain/workflow-runs/wf-moved/workspace) no longer exists, so resume refuses the run',
      );
      expect(result.message).toContain(
        `"wf-missing-ws": its workspace ${join(home, 'elsewhere')} no longer exists, so resume refuses the run`,
      );
      expect(result.message).not.toContain('recreate');
      expect(result.message).not.toContain('wf-ok');
      expect(result.message).not.toContain('wf-done');
    });

    it('reports a run whose default workspace is gone: resume recreates no workspace, not even that one', async () => {
      const defaultGone = join(home, 'workflow-runs', 'wf-default-gone', 'workspace');
      writeRun('wf-default-gone', checkpoint({ workspacePath: defaultGone }));
      // No recorded workspace at all (older checkpoints): resume creates the default one.
      writeRun('wf-unrecorded', checkpoint());

      expect(await checkWorkflowRuns()).toMatchObject({
        status: 'warn',
        message:
          `1 problem(s) in 2 resumable run(s): "wf-default-gone": its workspace ${defaultGone} no longer exists, ` +
          'so resume refuses the run',
      });
    });

    it('follows a moved IronCurtain home and keeps an imported run workspace, as resume does', async () => {
      const otherHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-other-home-'));
      try {
        // A home moved here: resume rebases the run-local workspace onto this run directory.
        const relocated = writeRun(
          'wf-relocated',
          checkpoint({ workspacePath: '/old-home/.ironcurtain/workflow-runs/wf-relocated/workspace' }),
        );
        mkdirSync(join(relocated, 'workspace'));
        const stamped = writeRun(
          'wf-stamped',
          checkpoint({
            schemaVersion: 2,
            writerVersion: '0.14.0',
            runDir: '/old-home/runs/wf-stamped',
            workspacePath: '/old-home/runs/wf-stamped/workspace',
          }),
          { schemaVersion: 2, writerVersion: '0.14.0', ...validDefinition },
        );
        mkdirSync(join(stamped, 'workspace'));
        // An imported run keeps its source run's workspace, wherever that is.
        const foreign = join(otherHome, 'workflow-runs', 'wf-src', 'workspace');
        mkdirSync(foreign, { recursive: true });
        writeRun('wf-foreign', checkpoint({ workspacePath: foreign }));
        const source = writeRun('wf-source', checkpoint());
        mkdirSync(join(source, 'workspace'));
        writeRun('wf-imported', checkpoint({ workspacePath: join(source, 'workspace') }));

        expect(await checkWorkflowRuns()).toEqual({
          name: 'Workflow runs',
          status: 'ok',
          message: '5 resumable run(s), all resumable by this version',
        });
      } finally {
        rmSync(otherHome, { recursive: true, force: true });
      }
    });

    it('loads checkpoints and definition copies as the checkpoint store and resume do', async () => {
      writeRun('wf-newer', checkpoint({ schemaVersion: 99, writerVersion: '9.9.9' }));
      const recovered = writeRun('wf-recovered', checkpoint());
      writeFileSync(join(recovered, 'checkpoint.prev.json'), JSON.stringify(checkpoint()));
      writeFileSync(join(recovered, 'checkpoint.json'), '{"machineState": "do');
      const damaged = writeRun('wf-damaged', checkpoint());
      writeFileSync(join(damaged, 'checkpoint.json'), '{"machineState": "do');
      writeRun('wf-newer-definition', checkpoint(), { schemaVersion: 99, writerVersion: '9.9.9', ...validDefinition });

      const result = await checkWorkflowRuns();
      expect(result.status).toBe('warn');
      expect(result.message).toContain(
        '"wf-newer": its checkpoint was written by a newer IronCurtain, so this version refuses to resume it',
      );
      expect(result.message).toContain(
        '"wf-recovered": checkpoint.json is damaged, so resume continues from checkpoint.prev.json, one step older',
      );
      expect(result.message).toContain('"wf-damaged": its checkpoint cannot be loaded, so it cannot be resumed');
      expect(result.message).toContain(
        '"wf-newer-definition": its definition copy was written by a newer IronCurtain, so this version refuses to ' +
          'resume it',
      );
      expect(result.message).toContain('4 problem(s) in 4 resumable run(s)');
    });

    it('reports the snapshots resume will not use, as resume decides, and skips without Docker', async () => {
      // Image IDs whose first digits tell the cases apart in the (truncated) labels.
      const imageId = (digit: string): string => `sha256:${digit.repeat(64)}`;
      const now = 'a'.repeat(64);
      const old = 'b'.repeat(64);
      writeRun(
        'wf-snap',
        checkpoint({
          containerSnapshots: {
            // Labeled with the current build, but resume never offers a
            // snapshot whose checkpoint records no build.
            unrecorded: { image: imageId('1') },
            // A tag: another build could re-point it after the check.
            unpinned: { image: 'snap:unpinned', agentBuildHash: now },
            foreign: { image: imageId('2'), agentBuildHash: old },
            gone: { image: imageId('3'), agentBuildHash: now },
            // Recorded with the current build, but the image lacks its label.
            mislabeled: { image: imageId('4'), agentBuildHash: now },
            current: { image: imageId('5'), agentBuildHash: now },
          },
        }),
      );
      const labels: Record<string, string | null> = {
        [imageId('1')]: now,
        [imageId('2')]: old,
        [imageId('4')]: null,
        [imageId('5')]: now,
      };
      const inspector: SnapshotImageInspector = {
        buildHash: async (image) => labels[image],
        currentAgentBuildHashes: async () => new Set([now]),
      };
      expect(await checkWorkflowSnapshots(false, inspector)).toMatchObject({ status: 'skip' });
      const result = await checkWorkflowSnapshots(true, inspector);
      expect(result.status).toBe('warn');
      expect(result.message).toMatch(/^5 of 6 snapshot\(s\) will not be resumed, so their scopes start from a fresh/);
      const segment = (prefix: string): string =>
        result.message.split(' | ').find((part) => part.includes(prefix)) ?? '';
      expect(segment('taken before snapshots recorded')).toContain('sha256:1111');
      expect(segment('not named by an immutable image ID')).toContain('snap:unpinned');
      expect(segment('does not resolve now')).toContain('sha256:2222');
      expect(segment('gone:')).toContain('sha256:3333');
      expect(segment('not labeled with the agent image build')).toContain('sha256:4444');
      expect(result.message).not.toContain('sha256:5555');
      expect(result.message).not.toMatch(/resume would run|resume runs the captured image/);
      expect(result.hint).toContain('agentCliVersions');
    });

    it('reports nothing when every snapshot is of a build resume resolves', async () => {
      const now = 'c'.repeat(64);
      writeRun(
        'wf-current',
        checkpoint({ containerSnapshots: { primary: { image: `sha256:${'6'.repeat(64)}`, agentBuildHash: now } } }),
      );
      const result = await checkWorkflowSnapshots(true, {
        buildHash: async () => now,
        currentAgentBuildHashes: async () => new Set([now]),
      });
      expect(result).toMatchObject({ status: 'ok', message: "1 snapshot(s) from this version's agent images" });
    });

    it('predicts that agentSudo: false resumes only snapshots recorded as taken without agent sudo', async () => {
      const now = 'c'.repeat(64);
      const imageId = (digit: string): string => `sha256:${digit.repeat(64)}`;
      writeRun(
        'wf-sudo',
        checkpoint({
          containerSnapshots: {
            withSudo: { image: imageId('7'), agentBuildHash: now, agentSudo: true },
            // Recorded before snapshots carried the mode: counts as sudo on.
            notRecorded: { image: imageId('8'), agentBuildHash: now },
            withoutSudo: { image: imageId('9'), agentBuildHash: now, agentSudo: false },
          },
        }),
      );
      const inspector: SnapshotImageInspector = {
        buildHash: async () => now,
        currentAgentBuildHashes: async () => new Set([now]),
      };

      expect(await checkWorkflowSnapshots(true, inspector, { agentSudo: true })).toMatchObject({ status: 'ok' });
      const sudoOff = await checkWorkflowSnapshots(true, inspector, { agentSudo: false });
      expect(sudoOff.status).toBe('warn');
      expect(sudoOff.message).toMatch(/^2 of 3 snapshot\(s\) will not be resumed/);
      expect(sudoOff.message).toContain('not recorded as taken without agent sudo, which agentSudo: false requires');
      expect(sudoOff.message).toContain('sha256:7777');
      expect(sudoOff.message).toContain('sha256:8888');
      expect(sudoOff.message).not.toContain('sha256:9999');
      expect(sudoOff.hint).toContain('agentSudo');
    });

    it('counts the build of the agentCliVersions override as current, not the pin it replaces', async () => {
      await registerBuiltinAdapters();
      const adapter = getAgent('claude-code' as AgentId);
      const image = await adapter.getImage();
      const pinned = describeAgentImageBuild(image).buildHash;
      const overrides = { agentCliVersions: { 'claude-code': '2.1.300' } };
      const overridden = describeAgentImageBuild(image, agentImageBuildOptions(adapter, overrides)).buildHash;
      expect(overridden).not.toBe(pinned);

      expect(await currentAgentImageBuildHashes({})).toContain(pinned);
      const withOverride = await currentAgentImageBuildHashes(overrides);
      expect(withOverride).toContain(overridden);
      expect(withOverride).not.toContain(pinned);
    });

    it('summarizes every compiled policy that needs recompiling, and only the policy problem', () => {
      // A definition problem is not a policy problem: the Personas line reports it.
      writePersona(home, 'fresh', personaDefinition('renamed'));
      writePersona(home, 'stale', personaDefinition('stale'));
      writeFileSync(join(home, 'personas', 'stale', 'constitution.md'), 'edited\n');
      const current = checkPolicyFreshness(configWith(), annotations, undefined);
      expect(current.status).toBe('warn');
      expect(current.message).toBe(
        '1 of 3 need recompiling: persona "stale": stale compiled policy: the constitution changed after the policy ' +
          'was compiled (run: ironcurtain persona compile stale)',
      );
      const global = checkPolicyFreshness(configWith(), annotations, 'stale: compiled by an older policy compiler');
      expect(global.message).toContain('global: stale: compiled by an older policy compiler');
    });
  });
});
