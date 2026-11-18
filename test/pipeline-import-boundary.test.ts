/**
 * Import-graph boundary test for the pipeline layering rule (CLAUDE.md,
 * "Module Layering"; PIP-22).
 *
 * src/pipeline/ is offline tooling. Live-runtime code must not load any of it
 * at runtime: a static VALUE import, direct or through an intermediate module,
 * pulls the compile pipeline (and its LLM stack) into the process.
 * Type-only imports of src/pipeline/types.ts (the artifact shapes) are the
 * one exception, as are the sanctioned seams below, which may only be reached
 * by a dynamic `import()`.
 *
 * Guarded modules:
 *  - every module under the live-runtime directories (session, sandbox,
 *    trusted-process, docker, workflow, memory): no import path of any kind
 *    to a pipeline module, static or dynamic, direct or through other
 *    modules (so no dynamic import of a seam, or of any module that loads
 *    the pipeline, either). The one exception is a CLI entry point that
 *    lives in such a directory (CLI_ENTRY_SEAM_IMPORTS): its own dynamic
 *    import of its seam is allowed, and nothing else on its paths;
 *  - every module under src/web-ui/ and src/persona/, except the two
 *    sanctioned persona pipeline modules: no static value path to any
 *    pipeline module, and no dynamic import of one (they reach the pipeline
 *    only through a seam, which they import dynamically).
 *
 * "Pipeline module" is every module under src/pipeline/ except types.ts.
 * types.ts is not exempt from the graph: its own value edges are followed, so
 * a value import of it is safe only while it stays free of pipeline code.
 *
 * Complements the ESLint `no-restricted-imports` rule (eslint.config.js),
 * which bans DIRECT static value imports in the same directories; this test
 * also catches TRANSITIVE static reach and dynamic imports. The last block
 * plants imports to prove that both guards fire.
 *
 * The graph comes from the TypeScript parser (one AST per file), not from
 * regular expressions, so multi-line import lists (the way Prettier wraps long
 * imports), `export ... from` re-exports, namespace, default and side-effect
 * imports are all edges, while comments, strings and `typeof import(...)`
 * type queries are not. It is a pure function of the files on disk (an
 * earlier madge-based version was non-deterministic under CPU contention).
 *
 * Edge semantics:
 *  - STATIC value edges: every `import`/`export ... from` except the fully
 *    type-only forms (`import type`, `export type`, and named lists whose
 *    every specifier is `type X`, which TypeScript erases). A MIXED
 *    `import { type A, b }` is a value edge, and so is an empty
 *    `import {} from` (it can still load the module).
 *  - DYNAMIC edges: `import('<literal>')` calls. The search from a
 *    live-runtime module follows them like static edges; the search from the
 *    other guarded modules does not, because a dynamic import of a seam is
 *    their sanctioned way to reach the pipeline.
 *  - Only relative specifiers that resolve to a module under src/ are edges
 *    (the `.js` extension in a specifier maps to the `.ts` source).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TypeScript from 'typescript';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

/**
 * The TypeScript compiler API, loaded with Node's own require: the package is
 * CommonJS and names a source map it does not ship, which Vite's module
 * transform would warn about on every run.
 */
const ts = createRequire(import.meta.url)('typescript') as typeof TypeScript;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

/** The only pipeline module live-runtime code may import (type-only). */
const PIPELINE_CONTRACTS = 'src/pipeline/types.ts';

/** Pipeline modules: everything under src/pipeline/ except the type contracts. */
function isPipelineModule(key: string): boolean {
  return key.startsWith('src/pipeline/') && key !== PIPELINE_CONTRACTS;
}

/** Sanctioned offline-tooling seams: reached only by a dynamic `import()`. */
const SEAMS = new Set(['src/persona/compile-persona-policy.ts', 'src/cron/compile-task-policy.ts']);

/** Live-runtime directories (tool-call mediation and session layers). */
const LIVE_RUNTIME_DIRS = ['session', 'sandbox', 'trusted-process', 'docker', 'workflow', 'memory'] as const;

/**
 * CLI entry points that live in a live-runtime directory, and the seams each
 * may import dynamically. `ironcurtain workflow start --task-scoped` compiles
 * the task scope in the workflow CLI command, before any session, sandbox or
 * orchestrator exists (docs/designs/task-scoped-sessions.md), as `ironcurtain
 * start --task-scoped` does from src/index.ts. Only that dynamic import of
 * the entry module itself is exempt: every other path from it is checked, and
 * a live-runtime module that imports the entry module reaches the seam
 * through it and fails.
 */
const CLI_ENTRY_SEAM_IMPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['src/workflow/workflow-command.ts', new Set(['src/cron/compile-task-policy.ts'])],
]);

/**
 * Further guarded directories. Their modules reach the persona compile seam
 * dynamically, through persona-compile-service.ts (`runPersonaCompile`), the
 * one compile path the web UI and the CLI share. Every module under them is
 * guarded, including persona-compile-service.ts and policy-breadth-check.ts.
 */
const GUARDED_DIRS = ['web-ui', 'persona'] as const;

/**
 * Persona modules that are pipeline invocations by design: the compile seam
 * and the customize-policy flow (an exception CLAUDE.md allows).
 */
const SANCTIONED_PIPELINE_MODULES = new Set([
  'src/persona/compile-persona-policy.ts',
  'src/persona/persona-customizer.ts',
]);

/** In-container helper scripts shipped with workflows (not host runtime code; ESLint ignores them too). */
const IN_CONTAINER_SCRIPTS = /^src\/workflow\/workflows\/[^/]+\/scripts\//;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.mjs'];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** The import specifiers of one module, split by kind. */
interface ModuleSpecifiers {
  /** Specifiers of static imports and re-exports that load the module at runtime. */
  readonly static: string[];
  /** Literal specifiers of dynamic `import()` calls. */
  readonly dynamic: string[];
}

/** `import type ...` (TypeScript 5.9 records it as the clause's phase modifier; older versions as isTypeOnly). */
function isTypeOnlyClause(clause: TypeScript.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword || clause.isTypeOnly;
}

/** True for a non-empty named list whose every specifier is `type X` (erased by TypeScript). */
function allTypeOnly(elements: TypeScript.NodeArray<TypeScript.ImportSpecifier | TypeScript.ExportSpecifier>): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyImport(statement: TypeScript.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false; // side-effect import
  if (isTypeOnlyClause(clause)) return true;
  if (clause.name) return false; // default import
  const bindings = clause.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) && allTypeOnly(bindings.elements);
}

function isTypeOnlyExport(statement: TypeScript.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && allTypeOnly(clause.elements);
}

/** Scans one module's source with the TypeScript parser. */
function scanModuleSpecifiers(fileName: string, source: string): ModuleSpecifiers {
  const scriptKind = fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind);
  const staticSpecifiers: string[] = [];
  const dynamicSpecifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!isTypeOnlyImport(statement)) staticSpecifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(statement)) staticSpecifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      staticSpecifiers.push(statement.moduleReference.expression.text);
    }
  }

  const visit = (node: TypeScript.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments.at(0);
      if (argument && ts.isStringLiteralLike(argument)) dynamicSpecifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { static: staticSpecifiers, dynamic: dynamicSpecifiers };
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Module key (repo-relative, `/`-separated) -> resolved edges. */
type ImportGraph = ReadonlyMap<string, { readonly static: string[]; readonly dynamic: string[] }>;

/** Candidate module keys for a resolved specifier path. */
function moduleCandidates(base: string): string[] {
  if (base.endsWith('.js')) return [`${base.slice(0, -'.js'.length)}.ts`];
  if (base.endsWith('.mjs')) return [base, `${base.slice(0, -'.mjs'.length)}.mts`];
  if (SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext))) return [base];
  return [`${base}.ts`, `${base}/index.ts`];
}

/** Resolves a relative specifier of module `fromKey` to a module key, or null outside the graph. */
function resolveSpecifier(fromKey: string, specifier: string, modules: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromKey), specifier));
  return moduleCandidates(base).find((candidate) => modules.has(candidate)) ?? null;
}

/** Builds the import graph of a set of modules (key -> source). */
function buildGraph(sources: ReadonlyMap<string, string>): ImportGraph {
  const modules = new Set(sources.keys());
  const graph = new Map<string, { static: string[]; dynamic: string[] }>();
  for (const [key, source] of sources) {
    const specifiers = scanModuleSpecifiers(key, source);
    const resolveAll = (list: string[]) => [
      ...new Set(list.map((s) => resolveSpecifier(key, s, modules)).filter((k): k is string => k !== null)),
    ];
    graph.set(key, { static: resolveAll(specifiers.static), dynamic: resolveAll(specifiers.dynamic) });
  }
  return graph;
}

/** Reads every source module under src/ (key -> source). */
function readSourceModules(): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.d.ts') || !SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      const key = relative(ROOT, full).split(sep).join('/');
      if (!IN_CONTAINER_SCRIPTS.test(key)) sources.set(key, readFileSync(full, 'utf-8'));
    }
  };
  walk(SRC);
  return sources;
}

/** An import path to a pipeline module, and whether any hop on it is a dynamic `import()`. */
interface PipelinePath {
  readonly kind: 'static' | 'dynamic';
  /** One hop at a time: `a -> b` for a static import, `a -> import('b')` for a dynamic one. */
  readonly text: string;
}

/**
 * Breadth-first search from `entry` over static value edges, and over
 * dynamic edges as well when `followDynamic` is set. Returns the shortest
 * import path to a pipeline module, or null. Nothing stops the search: a seam
 * reached statically leads on into the pipeline, so it is reported like any
 * other path. `entrySeams` are the seams `entry` itself may import
 * dynamically (a CLI entry point's, see CLI_ENTRY_SEAM_IMPORTS): only those
 * edges of `entry` are not followed.
 */
function pathToPipeline(
  graph: ImportGraph,
  entry: string,
  followDynamic: boolean,
  entrySeams: ReadonlySet<string> = new Set(),
): PipelinePath | null {
  const parent = new Map<string, { readonly from: string; readonly dynamic: boolean } | null>([[entry, null]]);
  const queue = [entry];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    const edges = graph.get(current);
    const dynamicEdges = followDynamic ? (edges?.dynamic ?? []) : [];
    const next = [
      ...(edges?.static ?? []).map((dep) => ({ dep, dynamic: false })),
      ...dynamicEdges.filter((dep) => current !== entry || !entrySeams.has(dep)).map((dep) => ({ dep, dynamic: true })),
    ];
    for (const { dep, dynamic } of next) {
      if (parent.has(dep)) continue;
      parent.set(dep, { from: current, dynamic });
      if (!isPipelineModule(dep)) {
        queue.push(dep);
        continue;
      }
      const hops: string[] = [];
      let anyDynamic = false;
      for (let at = dep, hop = parent.get(at); hop; at = hop.from, hop = parent.get(at)) {
        hops.unshift(hop.dynamic ? ` -> import('${at}')` : ` -> ${at}`);
        anyDynamic ||= hop.dynamic;
      }
      return { kind: anyDynamic ? 'dynamic' : 'static', text: entry + hops.join('') };
    }
  }
  return null;
}

function modulesUnder(graph: ImportGraph, dir: string): string[] {
  return [...graph.keys()].filter((key) => key.startsWith(`src/${dir}/`)).sort();
}

/**
 * Every layering violation of the guarded modules under `dir`, one line each.
 * A live-runtime module may not reach a pipeline module by any import path:
 * static or dynamic, direct or through other modules (a dynamic import of a
 * module that loads the pipeline loads it too), except for a CLI entry
 * point's own dynamic import of its seam. The other guarded modules may not
 * reach one statically, nor import one dynamically except through a seam.
 */
function violationsUnder(graph: ImportGraph, dir: string): string[] {
  const liveRuntime = (LIVE_RUNTIME_DIRS as readonly string[]).includes(dir);
  const violations: string[] = [];
  for (const key of modulesUnder(graph, dir)) {
    if (SANCTIONED_PIPELINE_MODULES.has(key)) continue;
    const path = pathToPipeline(graph, key, liveRuntime, CLI_ENTRY_SEAM_IMPORTS.get(key));
    if (path) violations.push(`${path.kind}: ${path.text}`);
    if (!liveRuntime) {
      for (const dep of graph.get(key)?.dynamic ?? []) {
        if (isPipelineModule(dep)) violations.push(`dynamic: ${key} -> import('${dep}')`);
      }
    }
  }
  return violations;
}

const VIOLATION_HELP =
  "Use 'import type' for pipeline contracts (src/pipeline/types.ts), move a runtime helper out of src/pipeline/ " +
  'into the consumer layer, or reach pipeline code through a sanctioned seam (compile-persona-policy.ts / ' +
  'compile-task-policy.ts) with a dynamic import from outside the live-runtime directories.';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('import scanner', () => {
  const scan = (source: string) => scanModuleSpecifiers('src/x/a.ts', source);

  it.each([
    ['a named value import', "import { a } from './v.js';", ['./v.js']],
    ['a multi-line named import (Prettier wrapping)', "import {\n  a,\n  b,\n} from './v.js';", ['./v.js']],
    ['a default import', "import a from './v.js';", ['./v.js']],
    ['a namespace import', "import * as v from './v.js';", ['./v.js']],
    ['a side-effect import', "import './v.js';", ['./v.js']],
    ['an empty named import', "import {} from './v.js';", ['./v.js']],
    ['a mixed type and value import', "import { type A, b } from './v.js';", ['./v.js']],
    ['a default import beside type specifiers', "import a, { type B } from './v.js';", ['./v.js']],
    ['a named re-export', "export { a } from './v.js';", ['./v.js']],
    ['a multi-line re-export', "export {\n  a,\n} from './v.js';", ['./v.js']],
    ['a star re-export', "export * from './v.js';", ['./v.js']],
    ['a namespace re-export', "export * as v from './v.js';", ['./v.js']],
    ['an import-equals require', "import v = require('./v.js');", ['./v.js']],
    ['import type', "import type { A } from './t.js';", []],
    ['a multi-line import type', "import type {\n  A,\n  B,\n} from './t.js';", []],
    ['named imports that are all type-only', "import { type A, type B } from './t.js';", []],
    ['export type', "export type { A } from './t.js';", []],
    ['named re-exports that are all type-only', "export { type A } from './t.js';", []],
    ['a typeof import() type query', "type T = typeof import('./v.js');", []],
    ['a commented-out import', "// import { a } from './v.js';\n/* import { b } from './w.js'; */", []],
    ['an import inside a string', 'const s = "import { a } from \'./v.js\'";', []],
  ])('%s', (_label, source, expected) => {
    expect(scan(source).static).toEqual(expected);
  });

  it('records literal dynamic imports, in any position, separately', () => {
    const result = scan(
      "import { a } from './v.js';\nexport async function f() {\n  const m = await import('./d.js');\n  return import(\n    './e.js'\n  );\n}",
    );
    expect(result.static).toEqual(['./v.js']);
    expect(result.dynamic).toEqual(['./d.js', './e.js']);
  });
});

describe('pipeline import boundary', () => {
  let sources: Map<string, string>;
  let graph: ImportGraph;

  beforeAll(() => {
    sources = readSourceModules();
    graph = buildGraph(sources);
  });

  it('sees the whole tree and the pipeline edges it must find', () => {
    expect(graph.size).toBeGreaterThan(300);
    for (const dir of [...LIVE_RUNTIME_DIRS, ...GUARDED_DIRS]) {
      expect(modulesUnder(graph, dir).length, `no modules found under src/${dir}/`).toBeGreaterThan(0);
    }
    // The seams statically reach the runner, and the persona compile service
    // (runPersonaCompile, the one path CLI and web-UI compiles share) reaches
    // the persona seam dynamically: if either edge disappeared, the scanner
    // broke.
    expect(graph.get('src/persona/compile-persona-policy.ts')?.static).toContain('src/pipeline/pipeline-runner.ts');
    expect(graph.get('src/cron/compile-task-policy.ts')?.static).toContain('src/pipeline/pipeline-runner.ts');
    expect(graph.get('src/persona/persona-compile-service.ts')?.dynamic).toContain(
      'src/persona/compile-persona-policy.ts',
    );
    // Live-runtime code does import the pipeline contracts, type-only.
    expect(sources.get('src/trusted-process/policy-engine.ts')).toContain("from '../pipeline/types.js'");
    expect(graph.get('src/trusted-process/policy-engine.ts')?.static).not.toContain(PIPELINE_CONTRACTS);
  });

  it('exempts only CLI entry points in live-runtime directories, for seams they do import', () => {
    for (const [entry, seams] of CLI_ENTRY_SEAM_IMPORTS) {
      expect(
        LIVE_RUNTIME_DIRS.some((dir) => entry.startsWith(`src/${dir}/`)),
        entry,
      ).toBe(true);
      for (const seam of seams) {
        expect(SEAMS.has(seam), seam).toBe(true);
        // An exemption the entry point no longer uses is removed, not kept.
        expect(graph.get(entry)?.dynamic, `${entry} no longer imports ${seam}`).toContain(seam);
      }
    }
  });

  for (const dir of LIVE_RUNTIME_DIRS) {
    it(`src/${dir}/ reaches pipeline code by no import path, static or dynamic`, () => {
      const violations = violationsUnder(graph, dir);
      expect(violations, `${violations.join('\n')}\n${VIOLATION_HELP}`).toEqual([]);
    });
  }

  for (const dir of GUARDED_DIRS) {
    it(`src/${dir}/ reaches pipeline code only through the sanctioned seams and modules`, () => {
      const violations = violationsUnder(graph, dir);
      expect(violations, `${violations.join('\n')}\n${VIOLATION_HELP}`).toEqual([]);
    });
  }

  describe('planted imports', () => {
    /** The real tree plus `planted` (key -> source). */
    const withPlanted = (planted: Record<string, string>): ImportGraph =>
      buildGraph(new Map([...sources, ...Object.entries(planted)]));

    it('a value import from a pipeline module into trusted-process fails', () => {
      const planted = withPlanted({
        'src/trusted-process/__planted__.ts': "import { PipelineRunner } from '../pipeline/pipeline-runner.js';\n",
      });
      expect(violationsUnder(planted, 'trusted-process')).toEqual([
        'static: src/trusted-process/__planted__.ts -> src/pipeline/pipeline-runner.ts',
      ]);
    });

    it('a multi-line value import through an intermediate module fails', () => {
      const planted = withPlanted({
        'src/session/__planted__.ts': "import { helper } from '../config/__planted_helper__.js';\n",
        'src/config/__planted_helper__.ts':
          "import {\n  mergeDynamicLists,\n  planListMerge,\n} from '../pipeline/list-merge.js';\nexport const helper = 1;\n",
      });
      expect(violationsUnder(planted, 'session')).toEqual([
        'static: src/session/__planted__.ts -> src/config/__planted_helper__.ts -> src/pipeline/list-merge.ts',
      ]);
    });

    it('a dynamic import of a pipeline module or a seam from a live-runtime directory fails', () => {
      const planted = withPlanted({
        'src/workflow/__planted_a__.ts': "export const f = () => import('../pipeline/pipeline-runner.js');\n",
        'src/workflow/__planted_b__.ts': "export const f = () => import('../cron/compile-task-policy.js');\n",
      });
      expect(violationsUnder(planted, 'workflow')).toEqual([
        "dynamic: src/workflow/__planted_a__.ts -> import('src/pipeline/pipeline-runner.ts')",
        "dynamic: src/workflow/__planted_b__.ts -> import('src/cron/compile-task-policy.ts') -> src/pipeline/pipeline-runner.ts",
      ]);
    });

    it('a dynamic import of a module that loads the pipeline, from a live-runtime directory, fails', () => {
      // Neither target is a pipeline module or a seam: one imports the
      // pipeline statically, the other loads a seam dynamically itself.
      const planted = withPlanted({
        'src/session/__planted__.ts': "export const load = () => import('../config/__planted_helper__.js');\n",
        'src/config/__planted_helper__.ts':
          "import { mergeDynamicLists } from '../pipeline/list-merge.js';\nexport const helper = mergeDynamicLists;\n",
        'src/memory/__planted__.ts': "export const load = () => import('../config/__planted_loader__.js');\n",
        'src/config/__planted_loader__.ts':
          "export const compile = () => import('../persona/compile-persona-policy.js');\n",
      });
      expect(violationsUnder(planted, 'session')).toEqual([
        "dynamic: src/session/__planted__.ts -> import('src/config/__planted_helper__.ts') -> src/pipeline/list-merge.ts",
      ]);
      expect(violationsUnder(planted, 'memory')).toEqual([
        "dynamic: src/memory/__planted__.ts -> import('src/config/__planted_loader__.ts') -> " +
          "import('src/persona/compile-persona-policy.ts') -> src/pipeline/pipeline-runner.ts",
      ]);
    });

    it('the workflow CLI entry point may import its seam only dynamically and directly', () => {
      const entry = 'src/workflow/workflow-command.ts';
      const asEntry = (source: string, extra: Record<string, string> = {}) =>
        violationsUnder(withPlanted({ [entry]: source, ...extra }), 'workflow');

      expect(asEntry("export const scope = () => import('../cron/compile-task-policy.js');\n")).toEqual([]);
      // Another seam, a pipeline module, the seam imported statically, and the
      // seam loaded through another module all fail.
      expect(asEntry("export const compile = () => import('../persona/compile-persona-policy.js');\n")).toEqual([
        "dynamic: src/workflow/workflow-command.ts -> import('src/persona/compile-persona-policy.ts') -> src/pipeline/pipeline-runner.ts",
      ]);
      expect(asEntry("export const run = () => import('../pipeline/pipeline-runner.js');\n")).toEqual([
        "dynamic: src/workflow/workflow-command.ts -> import('src/pipeline/pipeline-runner.ts')",
      ]);
      expect(asEntry("import '../cron/compile-task-policy.js';\n")).toEqual([
        'static: src/workflow/workflow-command.ts -> src/cron/compile-task-policy.ts -> src/pipeline/pipeline-runner.ts',
      ]);
      expect(
        asEntry("export const load = () => import('../config/__planted_loader__.js');\n", {
          'src/config/__planted_loader__.ts': "export const scope = () => import('../cron/compile-task-policy.js');\n",
        }),
      ).toEqual([
        "dynamic: src/workflow/workflow-command.ts -> import('src/config/__planted_loader__.ts') -> " +
          "import('src/cron/compile-task-policy.ts') -> src/pipeline/pipeline-runner.ts",
      ]);
    });

    it('a live-runtime module that imports the workflow CLI entry point fails', () => {
      const planted = withPlanted({
        'src/workflow/__planted__.ts': "import { main } from './workflow-command.js';\nexport const m = main;\n",
      });
      expect(violationsUnder(planted, 'workflow')).toEqual([
        'dynamic: src/workflow/__planted__.ts -> src/workflow/workflow-command.ts -> ' +
          "import('src/cron/compile-task-policy.ts') -> src/pipeline/pipeline-runner.ts",
      ]);
    });

    it('a dynamic import of a pipeline module from web-ui/ or persona/ fails; one of a seam does not', () => {
      const planted = withPlanted({
        'src/web-ui/__planted__.ts': "export const refresh = () => import('../pipeline/refresh-lists.js');\n",
        'src/persona/__planted__.ts': "export const run = () => import('../pipeline/pipeline-runner.js');\n",
        'src/web-ui/__planted_seam__.ts': "export const compile = () => import('../cron/compile-task-policy.js');\n",
      });
      expect(violationsUnder(planted, 'web-ui')).toEqual([
        "dynamic: src/web-ui/__planted__.ts -> import('src/pipeline/refresh-lists.ts')",
      ]);
      expect(violationsUnder(planted, 'persona')).toEqual([
        "dynamic: src/persona/__planted__.ts -> import('src/pipeline/pipeline-runner.ts')",
      ]);
    });

    it('a static import of the persona compile seam fails; a dynamic one from persona/ does not', () => {
      const staticPlant = withPlanted({
        'src/persona/__planted__.ts': "import { compilePersonaPolicy } from './compile-persona-policy.js';\n",
      });
      expect(violationsUnder(staticPlant, 'persona')).toEqual([
        'static: src/persona/__planted__.ts -> src/persona/compile-persona-policy.ts -> src/pipeline/pipeline-runner.ts',
      ]);
      const dynamicPlant = withPlanted({
        'src/persona/__planted__.ts': "export const load = () => import('./compile-persona-policy.js');\n",
      });
      expect(violationsUnder(dynamicPlant, 'persona')).toEqual([]);
    });

    it('type-only imports of any pipeline module pass', () => {
      const planted = withPlanted({
        'src/trusted-process/__planted__.ts':
          "import type { PipelineRunConfig } from '../pipeline/pipeline-runner.js';\n" +
          "import { type ListMergePlan } from '../pipeline/list-merge.js';\n" +
          "export type { CompiledRule } from '../pipeline/types.js';\n" +
          "export type Runner = typeof import('../pipeline/pipeline-runner.js');\n",
      });
      expect(violationsUnder(planted, 'trusted-process')).toEqual([]);
    });
  });
});

describe('ESLint layering rule', () => {
  const RULE = '@typescript-eslint/no-restricted-imports';
  let eslint: ESLint;

  beforeAll(() => {
    // The real eslint.config.js, without the type-aware rules (which would
    // need the planted file in the TypeScript project). The layering rule
    // needs no type information.
    eslint = new ESLint({ cwd: ROOT, overrideConfig: [tseslint.configs.disableTypeChecked] });
  });

  async function ruleMessages(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
    return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.message);
  }

  for (const dir of [...LIVE_RUNTIME_DIRS, ...GUARDED_DIRS]) {
    it(`fails a planted value import from the pipeline in src/${dir}/`, async () => {
      const messages = await ruleMessages(
        `src/${dir}/nested/__planted__.ts`,
        "import { PipelineRunner } from '../../pipeline/pipeline-runner.js';\nexport const r = PipelineRunner;\n",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('must not statically import VALUES from src/pipeline');
    });
  }

  it('fails a re-export and a multi-line import, allows type-only imports', async () => {
    const file = 'src/trusted-process/__planted__.ts';
    expect(await ruleMessages(file, "export { mergeDynamicLists } from '../pipeline/list-merge.js';\n")).toHaveLength(
      1,
    );
    expect(
      await ruleMessages(
        file,
        "import {\n  mergeDynamicLists,\n} from '../pipeline/list-merge.js';\nexport const m = mergeDynamicLists;\n",
      ),
    ).toHaveLength(1);
    expect(
      await ruleMessages(
        file,
        "import type { CompiledRule } from '../pipeline/types.js';\nimport { type ListMergePlan } from '../pipeline/list-merge.js';\nexport type X = [CompiledRule, ListMergePlan];\n",
      ),
    ).toEqual([]);
  });

  it('leaves the sanctioned pipeline modules and offline tooling alone', async () => {
    const code = "import { PipelineRunner } from '../pipeline/pipeline-runner.js';\nexport const r = PipelineRunner;\n";
    for (const file of [...SANCTIONED_PIPELINE_MODULES, ...SEAMS]) {
      expect(await ruleMessages(file, code), file).toEqual([]);
    }
  });
});
