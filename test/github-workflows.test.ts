/**
 * Static checks of .github/workflows (BLD-4). GitHub Actions cannot run in the
 * test suite, so this parses every workflow and checks what actionlint would
 * catch in these files (unknown `needs`, job outputs, step ids, inputs and env
 * names in expressions, shell syntax of every `run:` script), plus the release
 * pipeline's security properties:
 *
 * - every workflow pins the GITHUB_TOKEN permissions; ci.yml is read-only;
 * - the release workflows are split into build, test, publish and
 *   release-notes jobs. Only publish holds `id-token: write` (and nothing
 *   else), sits behind the protected `npm-publish` Environment, never checks
 *   out or installs anything, verifies the tarball's checksum and publishes it
 *   with --provenance --ignore-scripts. Only release-notes can write;
 * - checkouts never persist credentials, the tag must match package.json, the
 *   tarball is built without dependency lifecycle scripts, and no tool is
 *   installed unpinned or as @latest;
 * - the jobs that build and publish the tarball restore no Actions cache,
 *   which any default-branch run that executes dependency code can write;
 * - a manual run of release.yml is a dry run that publishes nothing;
 * - the release fails when its rebuild of the build-trust binaries differs
 *   from git (BLD-12), or when a Go builder image is not pinned by digest.
 *
 * And what CI covers (BLD-5, MEM-19, DWL-16): only documentation skips it;
 * the fixed-target relay's Go tests, the workspace packages' checks and tests,
 * the scripts' and tests' type checks and a global install of the packed
 * tarball run on every PR; images, Go release support and the annotations of
 * the container and npx MCP servers are checked weekly. The npm audit gate
 * (BLD-9) runs on every PR, weekly and before a release.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, '.github/workflows');
const RELEASE_WORKFLOWS = ['release.yml', 'release-memory-mcp-server.yml'];

type Json = Record<string, unknown>;

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Json;
  env?: Json;
  if?: string;
}

interface Job {
  name: string;
  raw: Json;
  permissions: unknown;
  needs: string[];
  outputs: Json;
  steps: Step[];
}

interface Workflow {
  file: string;
  raw: Json;
  jobs: Map<string, Job>;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadWorkflow(file: string): Workflow {
  const document = YAML.parseDocument(readFileSync(join(WORKFLOW_DIR, file), 'utf-8'));
  if (document.errors.length > 0) throw new Error(`${file}: ${document.errors.map(String).join('; ')}`);
  const raw: unknown = document.toJS();
  if (!isRecord(raw) || !isRecord(raw.jobs)) throw new Error(`${file}: no jobs`);
  const jobs = new Map<string, Job>();
  for (const [name, value] of Object.entries(raw.jobs)) {
    if (!isRecord(value)) throw new Error(`${file}: job ${name} is not a mapping`);
    const needs = value.needs === undefined ? [] : Array.isArray(value.needs) ? value.needs : [value.needs];
    jobs.set(name, {
      name,
      raw: value,
      permissions: value.permissions,
      needs: needs.map(String),
      outputs: isRecord(value.outputs) ? value.outputs : {},
      steps: Array.isArray(value.steps) ? (value.steps as Step[]) : [],
    });
  }
  return { file, raw, jobs };
}

const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file));
const workflows = new Map(WORKFLOW_FILES.map((file) => [file, loadWorkflow(file)]));

function workflow(file: string): Workflow {
  const loaded = workflows.get(file);
  if (loaded === undefined) throw new Error(`missing workflow ${file}`);
  return loaded;
}

function job(file: string, name: string): Job {
  const found = workflow(file).jobs.get(name);
  if (found === undefined) throw new Error(`${file}: missing job ${name}`);
  return found;
}

/** Every string in a value, with a readable path. */
function strings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

/** The expressions in a string: `${{ ... }}` blocks, or the whole string for an `if:` without them. */
function expressions(path: string, text: string): string[] {
  const blocks = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]);
  if (blocks.length === 0 && /\.if$/.test(path)) return [text];
  return blocks;
}

function runSteps(target: Job): Array<{ step: Step; script: string }> {
  return target.steps.flatMap((step) => (typeof step.run === 'string' ? [{ step, script: step.run }] : []));
}

function stepLabel(step: Step): string {
  return step.name ?? step.id ?? step.uses ?? step.run?.split('\n')[0] ?? '?';
}

describe.each(WORKFLOW_FILES)('workflow %s', (file) => {
  const loaded = workflow(file);

  it('declares token permissions for every job', () => {
    const topLevel = loaded.raw.permissions !== undefined;
    for (const target of loaded.jobs.values()) {
      expect(topLevel || target.permissions !== undefined, `${file}: job ${target.name} has no permissions`).toBe(true);
    }
  });

  it('has well-formed jobs and steps', () => {
    for (const target of loaded.jobs.values()) {
      expect(target.raw['runs-on'], `${target.name}: runs-on`).toBeDefined();
      expect(target.steps.length, `${target.name}: steps`).toBeGreaterThan(0);
      for (const step of target.steps) {
        const kinds = [step.run, step.uses].filter((kind) => kind !== undefined);
        expect(kinds.length, `${target.name}: step ${stepLabel(step)} needs exactly one of run/uses`).toBe(1);
      }
      for (const need of target.needs) {
        expect(loaded.jobs.has(need), `${target.name} needs unknown job ${need}`).toBe(true);
      }
    }
  });

  it('only references needs outputs, step ids, inputs and env that exist', () => {
    const on = isRecord(loaded.raw.on) ? loaded.raw.on : {};
    const dispatch = isRecord(on.workflow_dispatch) ? on.workflow_dispatch : {};
    const inputs = new Set(Object.keys(isRecord(dispatch.inputs) ? dispatch.inputs : {}));
    const workflowEnv = Object.keys(isRecord(loaded.raw.env) ? loaded.raw.env : {});
    for (const target of loaded.jobs.values()) {
      const stepIds = new Set(target.steps.flatMap((step) => (step.id === undefined ? [] : [step.id])));
      const env = new Set([...workflowEnv, ...Object.keys(isRecord(target.raw.env) ? target.raw.env : {})]);
      for (const [path, text] of strings(target.raw, target.name)) {
        for (const expression of expressions(path, text)) {
          for (const [, need, output] of expression.matchAll(/\bneeds\.([\w-]+)\.outputs\.([\w-]+)/g)) {
            expect(target.needs, `${path}: needs.${need} is not in needs`).toContain(need);
            expect(Object.keys(job(file, need).outputs), `${path}: ${need} has no output ${output}`).toContain(output);
          }
          for (const [, id] of expression.matchAll(/\bsteps\.([\w-]+)\.outputs\./g)) {
            expect(stepIds.has(id), `${path}: no step with id ${id}`).toBe(true);
          }
          for (const [, input] of expression.matchAll(/\binputs\.([\w-]+)/g)) {
            expect(inputs.has(input), `${path}: unknown input ${input}`).toBe(true);
          }
          for (const [, name] of expression.matchAll(/\benv\.([\w]+)/g)) {
            expect(env.has(name), `${path}: unknown env ${name}`).toBe(true);
          }
        }
      }
    }
  });

  it('keeps event data and inputs out of run scripts', () => {
    for (const target of loaded.jobs.values()) {
      for (const { step, script } of runSteps(target)) {
        expect(script, `${target.name}: ${stepLabel(step)}`).not.toMatch(/\$\{\{[^}]*\b(inputs|github\.event)\./);
      }
    }
  });

  it('has run scripts that bash can parse', () => {
    for (const target of loaded.jobs.values()) {
      for (const { step, script } of runSteps(target)) {
        const result = spawnSync('bash', ['-n'], {
          input: script.replace(/\$\{\{[\s\S]*?\}\}/g, 'EXPR'),
          encoding: 'utf-8',
        });
        expect(result.status, `${file} ${target.name}: ${stepLabel(step)}: ${result.stderr}`).toBe(0);
      }
    }
  });
});

/** Whether a push touching only `path` runs a workflow with these `paths` filters (last match wins). */
function pathTriggers(patterns: readonly string[], path: string): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (minimatch(path, negated ? pattern.slice(1) : pattern, { dot: true })) included = !negated;
  }
  return included;
}

function scriptsOf(file: string, name: string): string[] {
  return runSteps(job(file, name)).map(({ script }) => script);
}

describe('ci.yml', () => {
  it('reads the repository only and keeps its job names', () => {
    expect(workflow('ci.yml').raw.permissions).toEqual({ contents: 'read' });
    // Branch protection refers to these job names; a new job blocks merges
    // only once it is added there as a required check.
    expect([...workflow('ci.yml').jobs.keys()]).toEqual([
      'build-trust-runtime',
      'nested-relay',
      'ci',
      'dependency-audit',
      'network-isolation',
      'workspaces',
      'package-smoke',
    ]);
  });

  it('gates every PR on the npm audit of the production tree, installing without lifecycle scripts', () => {
    const scripts = scriptsOf('ci.yml', 'dependency-audit');
    expect(scripts).toEqual(['npm ci --ignore-scripts', 'npm run check:audit']);
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['check:audit']).toBe('tsx scripts/check-npm-audit.ts');
  });

  it('skips only documentation: Markdown that is runtime input still runs CI', () => {
    const on = workflow('ci.yml').raw.on;
    for (const event of ['push', 'pull_request']) {
      const filter = isRecord(on) && isRecord(on[event]) ? on[event].paths : undefined;
      expect(Array.isArray(filter), event).toBe(true);
      const patterns = (filter as unknown[]).map(String);
      for (const path of [
        'src/config/constitution.md',
        'src/config/constitution-user-base.md',
        'src/workflow/workflows/test-email-summary/skills/summary-style-guide/SKILL.md',
        'src/workflow/workflows/evolve/README.md',
        'docker/build-trust-runtime/README.md',
        'src/index.ts',
        '.github/workflows/ci.yml',
        'docker/nested-relay/go.mod',
        'packages/web-ui/src/App.svelte',
      ]) {
        expect(pathTriggers(patterns, path), `${event}: ${path}`).toBe(true);
      }
      for (const path of [
        'README.md',
        'CHANGELOG.md',
        'docs/designs/linux-nested-docker-assessment.md',
        'docs/images/overview.png',
        'LICENSE',
        'src/docker/CLAUDE.md',
        'src/pipeline/GEMINI.md',
        '.claude/agents/feature-architect.md',
      ]) {
        expect(pathTriggers(patterns, path), `${event}: ${path}`).toBe(false);
      }
    }
  });

  it('vets and tests the fixed-target relay with the Go release its image is built with', () => {
    const relay = job('ci.yml', 'nested-relay');
    expect(relay.raw.defaults).toEqual({ run: { 'working-directory': 'docker/nested-relay' } });
    const setupGo = relay.steps.find((step) => step.uses?.startsWith('actions/setup-go@'));
    expect(setupGo?.with?.['go-version-file']).toBe('docker/nested-relay/go.mod');
    expect(setupGo?.with?.['go-version']).toBeUndefined();
    expect(scriptsOf('ci.yml', 'nested-relay')).toEqual(['go vet ./...', 'go test ./...']);
  });

  it('checks the workspace packages, scripts and test types', () => {
    const scripts = scriptsOf('ci.yml', 'workspaces');
    for (const command of [
      'npm run check -w packages/web-ui',
      'npm run lint -w packages/web-ui',
      'npm run format:check -w packages/web-ui',
      'npm run typecheck:scripts',
      'npm run typecheck:tests',
      'npm run lint -w packages/memory-mcp-server',
      'npm run format:check -w packages/memory-mcp-server',
      'npm run build -w packages/memory-mcp-server',
      'npm test -w packages/memory-mcp-server',
    ]) {
      expect(scripts).toContain(command);
    }
  });

  it('restores the memory server model cache after the install, where transformers.js keeps it', () => {
    const steps = job('ci.yml', 'workspaces').steps;
    const install = steps.findIndex((step) => step.run?.includes('npm ci'));
    const locate = steps.findIndex((step) => step.id === 'models');
    const cache = steps.findIndex((step) => step.uses?.startsWith('actions/cache@'));
    const test = steps.findIndex((step) => step.run === 'npm test -w packages/memory-mcp-server');
    expect(install).toBeGreaterThanOrEqual(0);
    expect([install < locate, locate < cache, cache < test]).toEqual([true, true, true]);
    expect(steps[locate].run).toContain("import('@huggingface/transformers')");
    expect(steps[locate].run).toContain('env.cacheDir');
    expect(steps[cache].with?.path).toBe('${{ steps.models.outputs.dir }}');
    expect(String(steps[cache].with?.key)).toContain('${{ steps.models.outputs.version }}');
  });

  it('installs the packed tarball globally on every supported Node major and runs it from outside the checkout', () => {
    const smoke = job('ci.yml', 'package-smoke');
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { engines: { node: string } };
    const majors = [...packageJson.engines.node.matchAll(/\^(\d+)\./g)].map((match) => Number(match[1]));
    const strategy = isRecord(smoke.raw.strategy) ? smoke.raw.strategy : {};
    const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
    expect(majors.length).toBeGreaterThan(0);
    expect(matrix['node-version']).toEqual(majors);

    const scripts = scriptsOf('ci.yml', 'package-smoke').join('\n');
    expect(scripts).toMatch(/npm pack --ignore-scripts --pack-destination/u);
    expect(scripts).toMatch(/npm install --global --prefix "\$RUNNER_TEMP\/global" [^\n]*"\$TARBALL"/u);
    const run = scripts.slice(scripts.indexOf('cd "$RUNNER_TEMP"'));
    expect(run).toContain('"$cli" --version');
    expect(run).toContain('"$cli" workflow list');
    expect(run.indexOf('cd "$RUNNER_TEMP"')).toBe(0);
  });
});

describe('scheduled-checks.yml', () => {
  const file = 'scheduled-checks.yml';

  it('runs weekly and on demand, and reads the repository only', () => {
    const on = workflow(file).raw.on;
    expect(isRecord(on) && Array.isArray(on.schedule) && on.schedule.length).toBe(1);
    expect(isRecord(on) && 'workflow_dispatch' in on).toBe(true);
    expect(workflow(file).raw.permissions).toEqual({ contents: 'read' });
  });

  it('fails on Go releases out of support or behind their newest patch, and on undigested Go builders', () => {
    const scripts = scriptsOf(file, 'go-toolchain');
    const fetch = scripts.findIndex((script) => script.includes("'https://go.dev/dl/?mode=json'"));
    const check = scripts.findIndex((script) => script.includes('npm run check:go-toolchain -- --strict --releases'));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(fetch);
  });

  it('builds the agent base and images on amd64 and arm64, and the nested-Docker images', () => {
    const images = job(file, 'images');
    const strategy = isRecord(images.raw.strategy) ? images.raw.strategy : {};
    const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
    expect(matrix.include).toEqual([
      { runner: 'ubuntu-latest', base: 'Dockerfile.base' },
      { runner: 'ubuntu-24.04-arm', base: 'Dockerfile.base.arm64' },
    ]);
    const scripts = scriptsOf(file, 'images').join('\n');
    expect(scripts).toContain('--tag ironcurtain-base:latest --file "docker/$BASE_DOCKERFILE" docker');
    expect(scripts).toContain('for agent in claude-code codex goose; do');
    for (const context of ['docker/nested-relay', 'docker/nested-daemon', 'docker/transport-sidecar']) {
      expect(scripts).toMatch(new RegExp(`docker build --tag \\S+ ${context}$`, 'mu'));
    }
    for (const agent of ['claude-code', 'codex', 'goose']) {
      expect(readdirSync(join(ROOT, 'docker'))).toContain(`Dockerfile.${agent}`);
    }
  });

  it('runs the npm audit gate weekly and fails while sandbox-runtime is behind its newest release', () => {
    const steps = job(file, 'dependencies').steps;
    const scripts = scriptsOf(file, 'dependencies');
    expect(scripts.slice(0, 2)).toEqual(['npm ci --ignore-scripts', 'npm run check:audit']);
    const currency = steps.find((step) => step.run?.includes('npm view @anthropic-ai/sandbox-runtime version'));
    expect(currency?.run).toContain("packages['node_modules/@anthropic-ai/sandbox-runtime'].version");
    expect(currency?.run).toContain('exit 1');
    // Reported even when the audit step failed.
    expect(currency?.if).toBe('${{ !cancelled() }}');
  });

  // google-workspace is backed by an IronCurtain OAuth login, and tool
  // listings outside a session never start such a server
  // (src/trusted-process/tool-listing-launch.ts), so a
  // `--check --server google-workspace` step could only ever fail.
  it('checks the github annotations against the live server, and not google-workspace', () => {
    const scripts = scriptsOf(file, 'annotation-drift');
    expect(scripts).toContain('npx tsx src/cli.ts annotate-tools --check --server github');
    expect(scripts.filter((script) => script.includes('google-workspace'))).toEqual([]);
    const github = job(file, 'annotation-drift').steps.find((step) => step.run?.includes('--server github'));
    expect(github?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBeDefined();
  });
});

describe('release.yml build-trust rebuild and Go pins', () => {
  it('fails the build job when the rebuilt build-trust binaries differ from git, before packing', () => {
    const scripts = scriptsOf('release.yml', 'build');
    const write = scripts.indexOf('npm run build:build-trust-runtime');
    const diff = scripts.findIndex(
      (script) => script.includes('git status --porcelain') && script.includes('docker/build-trust-runtime/bin'),
    );
    const pack = scripts.findIndex((script) => /\bnpm pack\b/u.test(script));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(diff).toBeGreaterThan(write);
    expect(pack).toBeGreaterThan(diff);
    expect(scripts[diff]).toContain('src/docker/build-trust-runtime-contract.ts');
    expect(scripts[diff]).toContain('exit 1');
  });

  it('checks npm advisories before building, and reports a stale sandbox-runtime', () => {
    const scripts = scriptsOf('release.yml', 'build');
    const install = scripts.indexOf('npm ci --ignore-scripts');
    const audit = scripts.indexOf('npm run check:audit');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(install);
    expect(audit).toBeLessThan(scripts.indexOf('npm run build'));
    const currency = scripts.find((script) => script.includes('npm view @anthropic-ai/sandbox-runtime version'));
    expect(currency).toContain('::warning::');
    // Only a warning: neither a stale version nor a failed registry lookup
    // (which would end the step under bash -e) stops the release.
    expect(currency).not.toContain('exit 1');
    expect(currency).toContain('if ! latest="$(npm view @anthropic-ai/sandbox-runtime version)"; then');
  });

  it('refuses Go builder images not pinned by digest before building', () => {
    const scripts = scriptsOf('release.yml', 'build');
    const check = scripts.indexOf('npm run check:go-toolchain -- --strict');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(scripts.indexOf('npm run build'));
  });
});

describe('dependabot.yml', () => {
  it('updates the base and Go builder images', () => {
    const config = YAML.parse(readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf-8')) as {
      updates: Array<{ 'package-ecosystem': string; directory: string }>;
    };
    const docker = config.updates
      .filter((update) => update['package-ecosystem'] === 'docker')
      .map((update) => update.directory);
    expect(docker).toEqual(['/docker', '/docker/nested-relay', '/docker/nested-daemon', '/docker/transport-sidecar']);
  });
});

describe('flake-probe.yml', () => {
  it('reads the repository only and classifies attempts like scripts/test.sh', () => {
    const probe = workflow('flake-probe.yml');
    expect(probe.raw.permissions).toEqual({ contents: 'read' });
    const scripts = runSteps(job('flake-probe.yml', 'probe'))
      .map(({ script }) => script)
      .join('\n');
    expect(scripts).toContain('--reporter=./scripts/vitest-run-ledger.ts');
    expect(scripts).toContain('scripts/classify-vitest-run.ts');
  });
});

describe.each(RELEASE_WORKFLOWS)('release workflow %s', (file) => {
  const loaded = workflow(file);
  // Looked up inside each test, so a missing job fails those tests, not the file.
  const jobs = () => ({
    build: job(file, 'build'),
    test: job(file, 'test'),
    publish: job(file, 'publish'),
    notes: job(file, 'release-notes'),
  });

  it('is split into build, test, publish and release-notes, read-only by default', () => {
    const { build, test, notes } = jobs();
    expect([...loaded.jobs.keys()].sort()).toEqual(['build', 'publish', 'release-notes', 'test']);
    expect(loaded.raw.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(test.permissions).toEqual({ contents: 'read' });
    expect(notes.permissions).toEqual({ contents: 'write' });
    expect(notes.needs).toContain('publish');
  });

  it('gives the publish job only id-token: write, behind the protected Environment', () => {
    const { build, test, publish, notes } = jobs();
    expect(publish.permissions).toEqual({ 'id-token': 'write' });
    expect(publish.needs).toEqual(expect.arrayContaining(['build', 'test']));
    const environment = publish.raw.environment;
    expect(isRecord(environment) ? environment.name : environment).toBe('npm-publish');
    for (const other of [build, test, notes]) {
      expect(JSON.stringify(other.permissions)).not.toContain('id-token');
    }
  });

  it('never checks out or installs anything in the publish job', () => {
    const { publish } = jobs();
    const uses = publish.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses.split('@')[0]]));
    expect(uses.sort()).toEqual(['actions/download-artifact', 'actions/setup-node']);
    for (const { script } of runSteps(publish)) {
      expect(script).not.toMatch(/\bnpm\s+(ci|install|i|add|rebuild|run|exec|pack)\b|\bnpx\b|\byarn\b|\bpnpm\b/);
    }
    const setupNode = publish.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.cache).toBeUndefined();
  });

  it('publishes the checksum-verified tarball with provenance and without scripts', () => {
    const { build, publish } = jobs();
    const scripts = runSteps(publish).map(({ script }) => script);
    const verify = scripts.findIndex((script) => script.includes('sha256sum --check --strict'));
    const publishing = scripts.findIndex((script) => /\bnpm publish\b/.test(script));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(publishing).toBeGreaterThan(verify);
    const command = scripts[publishing];
    expect(command).toMatch(/npm publish "\$RUNNER_TEMP\/npm-package\/\$TARBALL"/);
    expect(command).toContain('--provenance');
    expect(command).toContain('--ignore-scripts');
    expect(Object.keys(build.outputs)).toEqual(expect.arrayContaining(['version', 'tarball', 'sha256']));
  });

  it('builds the tarball without dependency lifecycle scripts and checks the tag', () => {
    const { build } = jobs();
    const scripts = runSteps(build).map(({ script }) => script);
    expect(scripts).toContain('npm ci --ignore-scripts');
    expect(scripts.some((script) => /\bnpm pack\b.*--ignore-scripts/.test(script))).toBe(true);
    const tagCheck = scripts.find((script) => script.includes('does not match package.json version'));
    expect(tagCheck).toBeDefined();
    expect(tagCheck).toContain('GITHUB_REF_NAME');
    expect(tagCheck).toContain('exit 1');
    const upload = build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.['if-no-files-found']).toBe('error');
  });

  it('restores no Actions cache in the jobs that build or publish the tarball', () => {
    const { build, publish } = jobs();
    for (const target of [build, publish]) {
      for (const step of target.steps) {
        const action = step.uses?.split('@')[0] ?? '';
        const label = `${target.name}: ${stepLabel(step)}`;
        expect(action.startsWith('actions/cache'), label).toBe(false);
        if (action === 'actions/setup-node') {
          expect(step.with?.cache, label).toBeUndefined();
          // setup-node enables a cache by itself when package.json names a packageManager.
          expect(step.with?.['package-manager-cache'], label).toBe(false);
        } else if (action.startsWith('actions/setup-')) {
          // setup-go and friends cache by default.
          expect(step.with?.cache, label).toBe(false);
        }
      }
    }
  });

  it('never persists checkout credentials and keeps tokens in release-notes', () => {
    const { notes } = jobs();
    for (const target of loaded.jobs.values()) {
      for (const step of target.steps) {
        if (step.uses?.startsWith('actions/checkout@')) {
          expect(step.with?.['persist-credentials'], `${target.name}: checkout`).toBe(false);
        }
      }
      if (target !== notes) {
        expect(JSON.stringify(target.raw), target.name).not.toMatch(/github\.token|secrets\./);
      }
    }
  });

  it('pins the toolchain: exact Node and npm >= 11.5.1, safe-chain, nothing @latest', () => {
    const { build, test } = jobs();
    const env = isRecord(loaded.raw.env) ? loaded.raw.env : {};
    expect(env.NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = String(env.NPM_VERSION).split('.').map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11 * 1e6 + 5 * 1e3 + 1);
    for (const target of loaded.jobs.values()) {
      for (const step of target.steps) {
        if (step.uses?.startsWith('actions/setup-node@')) {
          expect(step.with?.['node-version'], target.name).toBe('${{ env.NODE_VERSION }}');
        }
      }
      for (const { script } of runSteps(target)) {
        expect(script).not.toContain('@latest');
        for (const install of script.matchAll(/\bnpm\s+(?:install|i)\s+(?:--global|-g)\b[^\n]*/g)) {
          expect(install[0], `${target.name}: unpinned global install`).toMatch(/@\d+\.\d+\.\d+\b|--before=/);
        }
      }
    }
    const installs = [...build.steps, ...test.steps].filter((step) => step.run?.includes('@aikidosec/safe-chain'));
    expect(installs.length).toBe(2);
  });
});

describe('release.yml dry run', () => {
  it('runs build and test on a manual dispatch but never publish or release-notes', () => {
    const on = workflow('release.yml').raw.on;
    expect(isRecord(on) && 'workflow_dispatch' in on).toBe(true);
    for (const name of ['publish', 'release-notes']) {
      expect(job('release.yml', name).raw.if).toBe(
        "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      );
    }
    expect(job('release.yml', 'build').raw.if).toBeUndefined();
    expect(job('release.yml', 'test').raw.if).toBeUndefined();
  });

  it('skips publish and release-notes in a memory-mcp-server dry run', () => {
    for (const name of ['publish', 'release-notes']) {
      expect(String(job('release-memory-mcp-server.yml', name).raw.if)).toContain('!inputs.dry_run');
    }
  });
});
