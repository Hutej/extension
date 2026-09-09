/**
 * audit-imports — resolved TypeScript import/dependency gate (T29, plan/02 §5).
 *
 * Replaces regex reachability guessing: uses the INSTALLED TypeScript compiler
 * API to parse every src file and resolve relative/alias imports to actual
 * files, so the graph is real, not text-matched. Enforces:
 *
 *   1. Boundary rules (plan/02 layer table, current-tree subset):
 *        shared/**    imports no other src module (pure leaf)
 *        core/**      imports neither agent/ nor tools/ nor entrypoints/
 *        tools/**     imports neither agent/ nor entrypoints/ nor core/reason/**
 *                     (core/reason is the provider/network boundary)
 *        agent/**     imports no entrypoints/
 *        no module imports entrypoints/** (entrypoints are roots)
 *   2. No runtime import cycles (type-only edges are exempt and tracked as such).
 *   3. Every relative/alias specifier resolves to a real file.
 *
 * `import type ...` / all-type-only named imports are edges for resolution but
 * never boundary or cycle violations. Unknown bare specifiers (npm packages)
 * are outside the gate's scope.
 *
 * The checker is importable so tests/unit can prove the negative controls
 * (T29: a deliberately forbidden fixture fails this gate; a type-only cycle
 * does not). Run directly: `node --experimental-strip-types scripts/audit-imports.ts`.
 */

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ImportEdge {
  from: string;          // root-relative importer path, e.g. 'core/emit.ts'
  to: string;            // root-relative resolved target path
  typeOnly: boolean;
}
export interface Graph {
  root: string;
  files: string[];       // root-relative .ts files
  edges: ImportEdge[];
  unresolved: { from: string; spec: string }[];
}
export interface Violation {
  kind: 'boundary' | 'cycle' | 'unresolved';
  message: string;
}

// ── file walking ────────────────────────────────────────────────────────

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

// ── specifier resolution (relative + @/ ~/ aliases; everything else = bare) ──

function resolveSpecifier(fromAbs: string, spec: string, root: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(root, spec.slice(2));
  else if (spec.startsWith('~/')) base = join(root, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromAbs), spec);
  else return null; // bare (npm) specifier — outside this gate

  const candidates = base.endsWith('.ts')
    ? [base]
    : [`${base}.ts`, join(base, 'index.ts')];
  for (const c of candidates) {
    if (statSync(c, { throwIfNoEntry: false })?.isFile()) return c;
  }
  return null;
}

/** Runtime-relevant import specifiers of one file: value imports (including a
 *  named list that mixes type-only and value names) and dynamic imports. */
function edgeSpecs(abs: string): { spec: string; typeOnly: boolean }[] {
  const src = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: { spec: string; typeOnly: boolean }[] = [];

  const namedAllTypeOnly = (clause: ts.NamedImportBindings | ts.NamedExportBindings | undefined): boolean => {
    if (!clause || !ts.isNamedImports(clause)) return false;
    const el = Array.from(clause.elements);
    return el.length > 0 && el.every((e) => e.isTypeOnly);
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const typeOnly = st.importClause?.isTypeOnly === true || namedAllTypeOnly(st.importClause?.namedBindings) === true;
      out.push({ spec: st.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const typeOnly = st.isTypeOnly === true || namedAllTypeOnly(st.exportClause) === true;
      out.push({ spec: st.moduleSpecifier.text, typeOnly });
    } else if (ts.isCallExpression(st) && st.expression.kind === ts.SyntaxKind.ImportKeyword && st.arguments[0] && ts.isStringLiteral(st.arguments[0])) {
      out.push({ spec: st.arguments[0].text, typeOnly: false });
    }
  }
  return out;
}

// ── graph construction ──────────────────────────────────────────────────

export function buildGraph(root: string): Graph {
  const absRoot = resolve(root);
  const files = listTs(absRoot);
  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const unresolved: { from: string; spec: string }[] = [];

  for (const abs of files) {
    for (const { spec, typeOnly } of edgeSpecs(abs)) {
      const target = resolveSpecifier(abs, spec, absRoot);
      if (target === null) {
        // Relative/alias specifier that resolves to nothing = broken reference
        // (bare npm specifiers return null only via the bare branch above).
        if (spec.startsWith('.') || spec.startsWith('@/')) unresolved.push({ from: rel(absRoot, abs), spec });
        continue;
      }
      if (!fileSet.has(target)) continue; // resolves outside the graph root
      edges.push({ from: rel(absRoot, abs), to: rel(absRoot, target), typeOnly });
    }
  }
  return { root: absRoot, files: files.map((f) => rel(absRoot, f)), edges, unresolved };
}

function rel(root: string, abs: string): string {
  const r = relative(root, abs).replace(/\\/g, '/');
  if (isAbsolute(r) || r.startsWith('..')) throw new Error(`path ${abs} escapes graph root ${root}`);
  return r;
}

// ── boundary rules (plan/02 §1 layer table, current-tree subset) ────────

const BOUNDARIES: { owner: (p: string) => boolean; forbidden: (p: string) => boolean; rule: string }[] = [
  { owner: (p) => p === 'contracts.ts' || p.startsWith('contracts/'), forbidden: (p) => !p.startsWith('shared/'), rule: 'contracts/ is the pure bottom layer and may import shared/ only' },
  { owner: (p) => p.startsWith('shared/'), forbidden: () => true, rule: 'shared/ is a pure leaf (imports no other module)' },
  { owner: (p) => p.startsWith('core/'), forbidden: (p) => p.startsWith('agent/') || p.startsWith('tools/') || p.startsWith('entrypoints/'), rule: 'core/ must not import agent/, tools/ or entrypoints/' },
  { owner: (p) => p.startsWith('tools/'), forbidden: (p) => p.startsWith('agent/') || p.startsWith('entrypoints/') || p.startsWith('core/reason/'), rule: 'tools/ must not import agent/, entrypoints/ or core/reason/ (network boundary)' },
  { owner: (p) => p.startsWith('agent/'), forbidden: (p) => p.startsWith('entrypoints/'), rule: 'agent/ must not import entrypoints/' },
  { owner: () => true, forbidden: (p) => p.startsWith('entrypoints/'), rule: 'entrypoints/ are roots; nothing imports them' },
];

export function checkBoundaries(graph: Graph): Violation[] {
  const out: Violation[] = [];
  for (const e of graph.edges) {
    if (e.typeOnly) continue; // types are erased at runtime — not a dependency
    if (e.from.startsWith('entrypoints/') && e.to.startsWith('entrypoints/')) continue;
    for (const b of BOUNDARIES) {
      if (b.owner(e.from) && b.forbidden(e.to)) {
        out.push({ kind: 'boundary', message: `${e.from} imports ${e.to} — forbidden: ${b.rule}` });
        break;
      }
    }
  }
  return out;
}

// ── runtime cycle detection (type-only edges exempt) ────────────────────

export function findCycles(graph: Graph): Violation[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.typeOnly) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const out: Violation[] = [];
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const path: string[] = [];
  const visit = (n: string): void => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) {
      const start = path.indexOf(n);
      out.push({ kind: 'cycle', message: `runtime import cycle: ${[...path.slice(start), n].join(' -> ')}` });
      return;
    }
    state.set(n, 1);
    path.push(n);
    for (const next of adj.get(n) ?? []) visit(next);
    path.pop();
    state.set(n, 2);
  };
  for (const n of adj.keys()) visit(n);
  return out;
}

export function auditGraph(graph: Graph): Violation[] {
  return [
    ...graph.unresolved.map((u) => ({ kind: 'unresolved' as const, message: `${u.from}: specifier "${u.spec}" resolves to no file` })),
    ...checkBoundaries(graph),
    ...findCycles(graph),
  ];
}

// ── main ────────────────────────────────────────────────────────────────

function isMain(): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : '';
  // fileURLToPath decodes %20 — import.meta.url keeps it encoded (path has spaces).
  return entry !== '' && fileURLToPath(import.meta.url) === entry;
}

if (isMain()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const violations = auditGraph(buildGraph(root));
  if (violations.length) {
    console.error(`✗ audit:imports — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  [${v.kind}] ${v.message}`);
    process.exit(1);
  }
  console.log(`✓ audit:imports — ${graphFileCount(root)} files, boundaries respected, no runtime cycles`);
}

function graphFileCount(root: string): number {
  return listTs(root).length;
}
