/**
 * The developer environment and the agent guidance stay in step with the code
 * (audit findings BLD-16 and SES-21).
 *
 * - `nix develop` (flake.nix) and scripts/linux-dev.sh provide a Node.js major
 *   that package.json "engines" allows, plus the toolchains the native modules
 *   (Python for node-gyp) and the Go components need.
 * - scripts/linux-dev.sh forwards credentials without executing env files, and
 *   sourcing it (as these tests do) runs nothing.
 * - The agent guidance files (CLAUDE.md files; their GEMINI.md twins are
 *   symlinks) name only paths that exist, so they cannot keep describing a
 *   deleted module such as `src/agent/`; the security kernel's guide names
 *   only modules of src/trusted-process/ that exist, even by bare file name.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCredentialEnvKeys } from '../src/config/trusted-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINUX_DEV_SCRIPT = join(ROOT, 'scripts/linux-dev.sh');
const LINUX_DEV_IMAGE = 'ironcurtain-linux-dev';

/** Writes an executable POSIX shell stub `dir/name` with the given body. */
function writeStub(dir: string, name: string, body: string): void {
  const stub = join(dir, name);
  writeFileSync(stub, `#!/bin/sh\n${body}\n`);
  chmodSync(stub, 0o755);
}

/** The agent guidance files this test keeps honest (repository-relative). */
const GUIDANCE_FILES = [
  'CLAUDE.md',
  'src/trusted-process/CLAUDE.md',
  'src/docker/CLAUDE.md',
  'src/pipeline/CLAUDE.md',
  'src/persona/CLAUDE.md',
  'packages/web-ui/CLAUDE.md',
];

/** GEMINI.md files that must stay symlinks to the CLAUDE.md beside them. */
const GEMINI_TWINS = ['GEMINI.md', 'src/trusted-process/GEMINI.md', 'src/docker/GEMINI.md', 'src/pipeline/GEMINI.md'];

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8');
}

/** The Node.js majors package.json "engines" allows, e.g. `^24.0.0 || ^26.0.0` -> [24, 26]. */
function engineNodeMajors(): number[] {
  const pkg = JSON.parse(readRepoFile('package.json')) as { engines?: { node?: string } };
  const range = pkg.engines?.node ?? '';
  const majors = range.split('||').map((part) => {
    const match = /^\s*\^(\d+)\.\d+\.\d+\s*$/.exec(part);
    if (!match) throw new Error(`unexpected engines.node clause: ${JSON.stringify(part)}`);
    return Number(match[1]);
  });
  return [...new Set(majors)].sort((a, b) => a - b);
}

/** Go minor version a go.mod `go` directive names, e.g. `go 1.26.10` -> 26. */
function goModMinor(path: string): number {
  const match = /^go 1\.(\d+)(?:\.\d+)?$/m.exec(readRepoFile(path));
  if (!match) throw new Error(`${path} has no go directive`);
  return Number(match[1]);
}

describe('engines', () => {
  it('allows Node.js 24 and 26', () => {
    expect(engineNodeMajors()).toEqual([24, 26]);
  });
});

describe('flake.nix (nix develop)', () => {
  // Comments may name other versions; only the expressions count.
  const code = readRepoFile('flake.nix')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

  it('provides only Node.js majors package.json allows', () => {
    const majors = [...code.matchAll(/\bnodejs_(\d+)\b/g)].map((m) => Number(m[1]));
    expect(majors.length).toBeGreaterThan(0);
    for (const major of majors) expect(engineNodeMajors()).toContain(major);
    // The unversioned attribute follows nixpkgs' default, not package.json.
    expect(code).not.toMatch(/\bnodejs\b(?!_)/);
  });

  it('provides python3 for node-gyp and the Go release the Go components declare', () => {
    expect(code).toMatch(/\bpython3\b/);
    const minor = goModMinor('docker/nested-relay/go.mod');
    expect(goModMinor('docker/build-trust-runtime/go.mod')).toBe(minor);
    expect(code).toMatch(new RegExp(`\\bgo_1_${minor}\\b`));
  });

  it('adds bubblewrap only on Linux', () => {
    expect(code).toMatch(/lib\.optionals\s+stdenv\.hostPlatform\.isLinux\s*\[\s*bubblewrap\s*\]/);
  });
});

describe('scripts/linux-dev.sh', () => {
  const script = readFileSync(LINUX_DEV_SCRIPT, 'utf-8');
  // The inline Dockerfile, without its comment lines.
  const dockerfile = (/<<'DOCKERFILE'\n([\s\S]*?)\nDOCKERFILE\n/.exec(script)?.[1] ?? '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('parses', () => {
    const result = spawnSync('bash', ['-n', LINUX_DEV_SCRIPT], { encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts exactly the Node.js majors package.json allows', () => {
    const declared = /^SUPPORTED_NODE_MAJORS="([\d ]+)"$/m.exec(script)?.[1];
    expect(declared?.split(' ').map(Number)).toEqual(engineNodeMajors());
  });

  it('builds an image that installs a supported Node.js and fails the build on any other major', () => {
    expect(dockerfile).not.toBe('');
    // Alpine 3.22's `nodejs` package is Node 22.
    expect(dockerfile).not.toMatch(/\bnodejs\b(?!-)/);
    expect(dockerfile).toMatch(/\bnodejs-current\b/);
    expect(dockerfile).toMatch(/^ARG SUPPORTED_NODE_MAJORS$/m);
    expect(dockerfile).toMatch(
      /node -p 'process\.versions\.node\.split\("\."\)\[0\]'[\s\S]*\$SUPPORTED_NODE_MAJORS[\s\S]*exit 1/,
    );
    expect(script).toContain('--build-arg "SUPPORTED_NODE_MAJORS=$SUPPORTED_NODE_MAJORS"');
  });

  it('never writes a .env into the workspace', () => {
    expect(script).not.toMatch(/\/workspace\/\.env/);
  });

  it('forwards exactly the credential names the CLI loads from env files', () => {
    const block = /^CREDENTIAL_VARS=\(\n([\s\S]*?)\n\)$/m.exec(script)?.[1] ?? '';
    const forwarded = block.split(/\s+/).filter(Boolean).sort();
    // The bundled mcp-servers.json only: the script cannot know a user's own servers.
    const noUserServers = join(ROOT, 'test', 'no-such-directory', 'mcp-servers.json');
    expect(forwarded).toEqual([...getCredentialEnvKeys(undefined, noUserServers)].sort());
  });

  describe('helpers (sourced)', () => {
    let scratch = '';
    let home = '';

    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'ic-linux-dev-'));
      home = join(scratch, 'home');
      mkdirSync(join(home, '.ironcurtain'), { recursive: true });
      const bin = join(scratch, 'bin');
      mkdirSync(bin);
      // `git` and `docker` stubs record any call: sourcing must make none.
      for (const tool of ['git', 'docker'])
        writeStub(bin, tool, `echo "${tool} $*" >> "${join(scratch, 'calls.log')}"`);
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    /** Sources the script in a clean environment, then runs `body`; returns its stdout. */
    function runSourced(body: string, env: Record<string, string> = {}): string {
      const result = spawnSync('bash', ['-c', `source "$1"\n${body}`, 'bash', LINUX_DEV_SCRIPT], {
        encoding: 'utf-8',
        env: { PATH: `${join(scratch, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    }

    function stubCalls(): string {
      const log = join(scratch, 'calls.log');
      return existsSync(log) ? readFileSync(log, 'utf-8') : '';
    }

    it('runs nothing when sourced', () => {
      expect(runSourced('echo sourced')).toBe('sourced\n');
      expect(stubCalls()).toBe('');
    });

    it('recognizes exactly the supported Node.js majors', () => {
      const stdout = runSourced(
        'for m in 22 24 25 26 ""; do if is_supported_node_major "$m"; then echo "$m:yes"; else echo "$m:no"; fi; done',
      );
      expect(stdout.trim().split('\n')).toEqual(['22:no', '24:yes', '25:no', '26:yes', ':no']);
    });

    it('forwards credentials from the environment and the trusted env files without executing them', () => {
      writeFileSync(
        join(home, '.ironcurtain', '.env'),
        [
          'export ANTHROPIC_API_KEY="sk-ant-home" # comment',
          'OPENAI_API_KEY=sk-openai-home',
          'ZAI_API_KEY=first',
          "ZAI_API_KEY='second'",
          '# GITHUB_PERSONAL_ACCESS_TOKEN=commented-out',
          'NODE_OPTIONS=--require=/tmp/x.js',
          'GOOGLE_GENERATIVE_AI_API_KEY=$(touch "$HOME/pwned")',
          '',
        ].join('\n'),
      );
      const explicit = join(scratch, 'explicit.env');
      writeFileSync(explicit, 'OPENAI_API_KEY=sk-openai-explicit\r\n');

      const stdout = runSourced(
        [
          'collect_credentials',
          'echo "ARGS=${ENV_ARGS[@]+${ENV_ARGS[@]}}"',
          'for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY GITHUB_PERSONAL_ACCESS_TOKEN NODE_OPTIONS GOOGLE_GENERATIVE_AI_API_KEY; do echo "$v=[${!v:-}]"; done',
        ].join('\n'),
        { IRONCURTAIN_ENV_FILE: explicit, OPENROUTER_API_KEY: 'from-shell' },
      );
      expect(stdout.trim().split('\n')).toEqual([
        'ARGS=-e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e GOOGLE_GENERATIVE_AI_API_KEY -e OPENROUTER_API_KEY -e ZAI_API_KEY',
        'ANTHROPIC_API_KEY=[sk-ant-home]',
        // $IRONCURTAIN_ENV_FILE wins over the home file; the CR is dropped.
        'OPENAI_API_KEY=[sk-openai-explicit]',
        // A value already in the environment wins over both files.
        'OPENROUTER_API_KEY=[from-shell]',
        // The last assignment wins, quotes removed.
        'ZAI_API_KEY=[second]',
        'GITHUB_PERSONAL_ACCESS_TOKEN=[]',
        // Only credential names are read.
        'NODE_OPTIONS=[]',
        // Read as text: the command substitution never runs.
        'GOOGLE_GENERATIVE_AI_API_KEY=[$(touch]',
      ]);
      expect(existsSync(join(home, 'pwned'))).toBe(false);
    });

    it('never reads a .env in the repository or the working directory', () => {
      const project = join(scratch, 'project');
      mkdirSync(project);
      writeFileSync(join(project, '.env'), 'ANTHROPIC_API_KEY=from-project\n');
      const stdout = runSourced(
        [
          `cd "${project}"`,
          `MAC_PROJECT_DIR="${project}"`,
          'collect_credentials',
          'echo "[${ANTHROPIC_API_KEY:-}] [${ENV_ARGS[@]+${ENV_ARGS[@]}}]"',
        ].join('\n'),
      );
      expect(stdout.trim()).toBe('[] []');
    });

    it('uses an absolute IRONCURTAIN_HOME and ignores a relative one', () => {
      const stdout = runSourced(
        [
          'IRONCURTAIN_HOME=/opt/ic-home ironcurtain_home_dir; echo',
          'IRONCURTAIN_HOME=relative/home ironcurtain_home_dir; echo',
          'IRONCURTAIN_HOME= ironcurtain_home_dir; echo',
        ].join('\n'),
      );
      expect(stdout.trim().split('\n')).toEqual(['/opt/ic-home', `${home}/.ironcurtain`, `${home}/.ironcurtain`]);
    });
  });

  describe('launch (git and docker stubbed)', () => {
    let scratch = '';
    let home = '';
    let bin = '';

    // Records what the script asks Docker to do. `image inspect` succeeds when
    // STUB_IMAGE_EXISTS is set, the Node.js probe of an existing image prints
    // STUB_NODE_MAJOR, `build` keeps the Dockerfile it reads from stdin, and
    // the final `run` stores each argument in its own file.
    const DOCKER_STUB = [
      'log="$STUB_DIR/docker.log"',
      'case "$1" in',
      '  image) [ -n "${STUB_IMAGE_EXISTS:-}" ] ;;',
      '  container) exit 1 ;;',
      '  build) echo "$*" >>"$log"; cat >"$STUB_DIR/Dockerfile" ;;',
      '  run)',
      '    if [ "$2" = --rm ] && [ "$3" = --entrypoint ]; then',
      '      echo "probe $5" >>"$log"',
      '      printf "%s\\n" "${STUB_NODE_MAJOR:-}"',
      '    else',
      '      echo run >>"$log"',
      '      n=0',
      '      for arg in "$@"; do n=$((n + 1)); printf "%s" "$arg" >"$STUB_DIR/run-arg-$n"; done',
      '      echo "$n" >"$STUB_DIR/run-argc"',
      '    fi ;;',
      '  *) echo "unexpected: $*" >>"$log"; exit 1 ;;',
      'esac',
    ].join('\n');

    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'ic-linux-dev-launch-'));
      home = join(scratch, 'home');
      mkdirSync(join(home, '.ironcurtain'), { recursive: true });
      mkdirSync(join(scratch, 'linux-clone', '.git'), { recursive: true });
      bin = join(scratch, 'bin');
      mkdirSync(bin);
      writeStub(bin, 'git', 'exit 0');
      writeStub(bin, 'docker', DOCKER_STUB);
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    /** Runs the script (not sourced); returns the Docker call log and the final `docker run` arguments. */
    function launch(env: Record<string, string>, args: string[] = []): { log: string[]; runArgs: string[] } {
      const result = spawnSync('bash', [LINUX_DEV_SCRIPT, ...args], {
        encoding: 'utf-8',
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: home,
          LINUX_PROJECT_DIR: join(scratch, 'linux-clone'),
          STUB_DIR: scratch,
          ...env,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const argc = Number(readFileSync(join(scratch, 'run-argc'), 'utf-8'));
      const runArgs = Array.from({ length: argc }, (_, i) => readFileSync(join(scratch, `run-arg-${i + 1}`), 'utf-8'));
      return { log: readFileSync(join(scratch, 'docker.log'), 'utf-8').trim().split('\n'), runArgs };
    }

    function hasPair(args: readonly string[], flag: string, value: string): boolean {
      return args.some((arg, i) => arg === flag && args[i + 1] === value);
    }

    it('rebuilds an existing image whose Node.js is unsupported, then starts the container', () => {
      const { log, runArgs } = launch({
        STUB_IMAGE_EXISTS: '1',
        STUB_NODE_MAJOR: '22',
        ANTHROPIC_API_KEY: 'from-shell',
      });
      expect(log).toEqual([
        `probe ${LINUX_DEV_IMAGE}`,
        `build -t ${LINUX_DEV_IMAGE} --build-arg SUPPORTED_NODE_MAJORS=24 26 -f - ${ROOT}`,
        'run',
      ]);
      expect(readFileSync(join(scratch, 'Dockerfile'), 'utf-8')).toMatch(/\bnodejs-current\b/);
      // The credential travels by name in the environment, never on the command line.
      expect(hasPair(runArgs, '-e', 'ANTHROPIC_API_KEY')).toBe(true);
      expect(runArgs.join('\n')).not.toContain('from-shell');
      expect(hasPair(runArgs, '-v', `${home}/.ironcurtain:/home/dev/.ironcurtain`)).toBe(true);
    });

    it('keeps an existing image whose Node.js is supported', () => {
      const { log } = launch({ STUB_IMAGE_EXISTS: '1', STUB_NODE_MAJOR: '24' });
      expect(log).toEqual([`probe ${LINUX_DEV_IMAGE}`, 'run']);
    });

    it('starts a container script that installs dependencies, or rebuilds native modules that do not load', () => {
      const { runArgs } = launch({ STUB_IMAGE_EXISTS: '1', STUB_NODE_MAJOR: '24' }, ['true']);
      const image = runArgs.indexOf(LINUX_DEV_IMAGE);
      expect(runArgs.slice(image + 1, image + 3)).toEqual(['sh', '-c']);
      expect(runArgs.slice(image + 4)).toEqual(['sh', 'true']);
      const containerScript = runArgs[image + 3] ?? '';
      const scriptFile = join(scratch, 'container.sh');
      writeFileSync(scriptFile, containerScript);
      expect(spawnSync('sh', ['-n', scriptFile]).status).toBe(0);

      // Run it against a stand-in /workspace with the container's tools stubbed;
      // `su dev -c CMD` runs CMD, and the node probe exits STUB_NATIVE_LOAD_EXIT.
      const workspace = join(scratch, 'workspace');
      mkdirSync(workspace);
      const local = containerScript
        .replaceAll('/workspace', workspace)
        .replaceAll('/var/log/dockerd.log', join(scratch, 'dockerd.log'));
      const containerBin = join(scratch, 'container-bin');
      mkdirSync(containerBin);
      const calls = join(scratch, 'container.log');
      for (const tool of ['dockerd-entrypoint.sh', 'docker', 'chown']) writeStub(containerBin, tool, 'exit 0');
      writeStub(containerBin, 'su', '[ "$1" = dev ] && [ "$2" = -c ] || exit 2\nexec sh -c "$3"');
      writeStub(
        containerBin,
        'node',
        `case "$1" in --version) echo v24.0.0 ;; -e) echo "node -e $2" >>"${calls}"; exit "$STUB_NATIVE_LOAD_EXIT" ;; esac`,
      );
      writeStub(containerBin, 'npm', `echo "npm $*" >>"${calls}"`);
      const runContainer = (nativeLoadExit: number): string[] => {
        rmSync(calls, { force: true });
        const result = spawnSync('sh', ['-c', local, 'sh', 'true'], {
          encoding: 'utf-8',
          env: { PATH: `${containerBin}:${process.env.PATH ?? ''}`, STUB_NATIVE_LOAD_EXIT: String(nativeLoadExit) },
        });
        expect(result.status, result.stderr).toBe(0);
        return existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n') : [];
      };
      const probe = "node -e require('node-pty'); require('isolated-vm')";

      // No node_modules: a plain install.
      expect(runContainer(0)).toEqual(['npm install', 'npm run build']);
      mkdirSync(join(workspace, 'node_modules'));
      // Both native modules load: nothing to do.
      expect(runContainer(0)).toEqual([probe]);
      // One does not (another platform, or the Node.js of an older image):
      // npm install alone would keep it, so it is rebuilt.
      expect(runContainer(1)).toEqual([probe, 'npm install', 'npm rebuild', 'npm run build']);
    });
  });
});

describe('agent guidance', () => {
  type NamedPath = { readonly path: string; readonly from: 'code' | 'link' };

  /** Candidate repository paths named in a guidance file: inline code spans and markdown link targets. */
  function namedPaths(file: string): NamedPath[] {
    // Fenced code blocks hold commands and snippets, not references.
    const text = readRepoFile(file).replace(/^```[\s\S]*?^```/gm, '');
    const found: NamedPath[] = [];
    for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
      for (const raw of span.split(/\s+/)) {
        const token = raw.replace(/^['"(]+/, '').replace(/['"),.;:]+$/, '');
        if (/[*{}<>$\\]/.test(token)) continue;
        // `./path`-style tokens are command-line examples, not references.
        if (/^(src|test|scripts|docs|packages|docker|examples)\/[\w.@/-]*$/.test(token) || token.startsWith('../')) {
          found.push({ path: token, from: 'code' });
        }
      }
    }
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      found.push({ path: target.replace(/#.*$/, ''), from: 'link' });
    }
    return found;
  }

  /**
   * Whether a named path exists. Repository-style paths may be written from
   * the repository root or from the guidance file's directory (the web UI
   * package's own `src/lib/...`); relative ones and link targets resolve from
   * the guidance file's directory. An import specifier may name the `.js` of a
   * `.ts` source. A relative path that leaves the repository is a snippet
   * (`'../pipeline/types.js'` in the root file), not a reference.
   */
  function resolves({ path, from }: NamedPath, file: string): boolean {
    const fileDir = dirname(join(ROOT, file));
    const bases = path.startsWith('../') || from === 'link' ? [fileDir] : [ROOT, fileDir];
    let inside = false;
    for (const base of bases) {
      const absolute = resolve(base, path);
      const rel = relative(ROOT, absolute);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      inside = true;
      if (existsSync(absolute) || existsSync(absolute.replace(/\.js$/, '.ts'))) return true;
    }
    return !inside;
  }

  it.each(GUIDANCE_FILES)('%s names only paths that exist', (file) => {
    const missing = namedPaths(file)
      .filter((named) => !resolves(named, file))
      .map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  it.each(GUIDANCE_FILES)('%s no longer describes the deleted src/agent/ module', (file) => {
    const text = readRepoFile(file);
    expect(text).not.toMatch(/\bsrc\/agent\//);
    expect(text).not.toMatch(/direct-tool-call/);
  });

  it('src/trusted-process/CLAUDE.md names only security-kernel modules that exist', () => {
    // The guide names its modules by bare file name; it once listed the deleted
    // EscalationHandler (`escalation.ts`) as the current approval path.
    const modules = [...readRepoFile('src/trusted-process/CLAUDE.md').matchAll(/`([\w.-]+\.ts)`/g)].map(
      (match) => match[1],
    );
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.filter((name) => !existsSync(join(ROOT, 'src/trusted-process', name)))).toEqual([]);
  });

  it('src/docker/CLAUDE.md never describes reserved IronCurtain-in-IronCurtain scaffolding as live', () => {
    // The foundations test/docker-workload/ironcurtain-in-ironcurtain-reserved.test.ts
    // keeps unwired; every line that names one must say so.
    const mentions = readRepoFile('src/docker/CLAUDE.md')
      .split('\n')
      .filter((line) =>
        /createParentProxyOutboundTransport|linux-dependency-abi|exchangeRoot|fixed[- ]parent/i.test(line),
      );
    expect(mentions.length).toBeGreaterThanOrEqual(3);
    for (const line of mentions) expect(line).toMatch(/not yet wired|reserved/i);
  });

  it('does not hard-code test or method counts that drift', () => {
    const text = readRepoFile('CLAUDE.md');
    expect(text).not.toMatch(/\(\d+ tests\)/);
    expect(text).not.toMatch(/\(\d+ methods\b/);
  });

  /** Zero-width and bidi control code points: they hide or reorder what a reader sees (Trojan Source). */
  function hiddenControlCodePoints(text: string): string[] {
    const found: string[] = [];
    for (const char of text) {
      const cp = char.codePointAt(0) ?? 0;
      const hidden =
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x2064) ||
        (cp >= 0x2066 && cp <= 0x2069) ||
        cp === 0xfeff;
      if (hidden) found.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    return found;
  }

  it.each(GUIDANCE_FILES)('%s contains no invisible or direction-changing characters', (file) => {
    expect(hiddenControlCodePoints(readRepoFile(file))).toEqual([]);
  });

  it('detects hidden control characters', () => {
    expect(hiddenControlCodePoints(`a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x200b)}c`)).toEqual([
      'U+202E',
      'U+200B',
    ]);
    expect(hiddenControlCodePoints('plain text, `\\u202e` spelled out')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps every GEMINI.md a symlink to the CLAUDE.md beside it', () => {
    for (const file of GEMINI_TWINS) {
      const absolute = join(ROOT, file);
      expect(lstatSync(absolute).isSymbolicLink(), file).toBe(true);
      expect(readlinkSync(absolute), file).toBe('CLAUDE.md');
    }
  });
});
