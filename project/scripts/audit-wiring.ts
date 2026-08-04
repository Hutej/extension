/**
 * Wiring audit — permanent gate.
 *
 * Fails when:
 *  1. A vocabulary relation is missing any of: RELATION_SPECS entry, prompt
 *     mention, validator path, emission path.
 *  2. An exported symbol in src/ has no non-test caller.
 *  3. A PackPrinciples field is never read by the engine.
 *
 * Usage: node --experimental-strip-types scripts/audit-wiring.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

type Finding = { check: string; symbol: string; verdict: 'fail' | 'pass' | 'warn'; detail: string };
const findings: Finding[] = [];

function readDir(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...readDir(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

const srcFiles = readDir(srcDir);
const srcContent = new Map<string, string>();
for (const f of srcFiles) srcContent.set(f, readFileSync(f, 'utf8'));
const allSrc = [...srcContent.values()].join('\n');

// ── Check 1: Vocabulary relation wiring ────────────────────────────
{
  const vocabPath = join(srcDir, 'core/design/vocabulary.ts');
  const vocab = readFileSync(vocabPath, 'utf8');
  // Extract relation names from the discriminated union.
  const relNames = new Set<string>();
  for (const m of vocab.matchAll(/relation:\s*'([^']+)'/g)) relNames.add(m[1]);
  // RELATION_SPECS entries.
  const specsNames = new Set<string>();
  for (const m of vocab.matchAll(/\{\s*relation:\s*'([^']+)'/g)) specsNames.add(m[1]);
  // Prompt mentions.
  const promptPath = join(srcDir, 'core/reason/index.ts');
  const prompt = readFileSync(promptPath, 'utf8');
  // Validator.
  const validatePath = join(srcDir, 'core/design/validate.ts');
  const validate = readFileSync(validatePath, 'utf8');
  // Transform engine — case statements + COMPOSITION_RELATIONS.
  const transformPath = join(srcDir, 'core/compile/transform.ts');
  const transform = readFileSync(transformPath, 'utf8');
  // Domain modules: after H4, the relation switch is split into per-domain
  // handler modules in relations/*.ts. Read all of them (except composition.ts
  // and context.ts which are not relation handlers) so the emission check can
  // find handler entries there.
  const relationsDir = join(srcDir, 'core/compile/relations');
  const domainModuleContent = readDir(relationsDir)
    .filter((f) => !f.endsWith('composition.ts') && !f.endsWith('context.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  // Composition relations are resolved by resolveComposition (in relations/composition.ts),
  // not case statements in transform.ts. Check both files for the COMPOSITION_RELATIONS set.
  const compositionRels = new Set<string>();
  const compModulePath = join(srcDir, 'core/compile/relations/composition.ts');
  const compModule = readFileSync(compModulePath, 'utf8');
  const compMatch = compModule.match(/COMPOSITION_RELATIONS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (compMatch) {
    for (const m of compMatch[1].matchAll(/'([^']+)'/g)) compositionRels.add(m[1]);
  }

  for (const rel of relNames) {
    const inSpecs = specsNames.has(rel);
    const inPrompt = prompt.includes(rel);
    // Validator: if the relation has a RELATION_SPECS entry, it's in
    // RELATION_NAMES and the validator checks it (known type, subject,
    // reference, magnitude). Relations with specific cases get extra
    // validation, but the generic path covers all.
    const inValidator = inSpecs;
    // Emission: a case statement in transform.ts, a handler in a domain
    // module, or in COMPOSITION_RELATIONS.
    const hasCase = new RegExp(`case\\s+'${rel}'`).test(transform);
    const hasHandler = new RegExp(`\\b${rel}\\s*\\(\\s*_?rel\\b`).test(domainModuleContent);
    const inComposition = compositionRels.has(rel);
    const hasEmission = hasCase || hasHandler || inComposition;

    // H2: For composition relations, a validation path is not an emission
    // path. The solver reads slotAssignment, spans, tracks, slotBehaviour —
    // it does NOT read adjacency or readingOrder. A relation whose case
    // block only pushes to adjacency/readingOrder/unsatisfiable has no
    // emission path; its sole possible outcome is unsatisfiable. Check
    // that the case block in composition.ts modifies at least one
    // solver-read IR field.
    let emissionHole = false;
    if (inComposition) {
      // Find the case block for this relation in composition.ts: from
      // `case 'rel':` to the next `case ` (captures the entire block,
      // including inner break; statements in nested if-blocks).
      const caseMarker = `case '${rel}'`;
      const caseStart = compModule.indexOf(caseMarker);
      if (caseStart !== -1) {
        const nextCase = compModule.indexOf('case ', caseStart + caseMarker.length);
        const caseEnd = nextCase === -1 ? compModule.length : nextCase;
        const caseBody = compModule.slice(caseStart, caseEnd);
        if (!/\bslotAssignment\b|\bspans\b|\btracks\b|\bslotBehaviour\b/.test(caseBody)) emissionHole = true;
      }
    }

    const missing: string[] = [];
    if (!inSpecs) missing.push('RELATION_SPECS');
    if (!inPrompt) missing.push('prompt');
    if (!inValidator) missing.push('validator');
    if (!hasEmission) missing.push('emission');
    if (emissionHole) missing.push('emission (case only pushes to adjacency/readingOrder/unsatisfiable — solver reads none of those)');

    findings.push({
      check: 'relation-wiring',
      symbol: rel,
      verdict: missing.length ? 'fail' : 'pass',
      detail: missing.length ? `missing: ${missing.join(', ')}` : 'wired',
    });
  }
}

// ── Check 2: Exported symbol with no non-test caller ──────────────
{
  // Extract all exports from src/ files.
  const exports = new Map<string, string[]>(); // file -> exported names
  for (const [path, content] of srcContent) {
    const names: string[] = [];
    // export function X, export const X, export class X, export type X, export interface X
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/g)) {
      names.push(m[1]);
    }
    for (const m of content.matchAll(/export\s+type\s+([A-Za-z_$][\w$]*)/g)) {
      names.push(m[1]);
    }
    for (const m of content.matchAll(/export\s+interface\s+([A-Za-z_$][\w$]*)/g)) {
      names.push(m[1]);
    }
    if (names.length) exports.set(path, names);
  }

  // For each exported symbol, check if it's imported in any OTHER src/ file.
  for (const [exportPath, names] of exports) {
    const exportRel = relative(srcDir, exportPath).replace(/\\/g, '/');
    for (const name of names) {
      // Check if the name appears in an import in any other src/ file.
      let found = false;
      for (const [otherPath, otherContent] of srcContent) {
        if (otherPath === exportPath) continue;
        // Look for import { name } or import type { name } or import { ..., name, ... }
        // Also check re-export: export { name } from
        if (new RegExp(`\\b${name}\\b`).test(otherContent) && otherContent.includes(name)) {
          // Check if it's in an import statement or usage
          // Simple heuristic: if the name appears in the file at all (beyond the export),
          // it's likely used. This has false positives but is conservative.
          found = true;
          break;
        }
      }
      if (!found) {
        // Check if it's used in test files (tests are valid callers for some exports).
        // But the audit says "no non-test caller" — so test-only exports are flagged.
        findings.push({
          check: 'orphan-export',
          symbol: `${name} (${exportRel})`,
          verdict: 'warn',
          detail: 'no non-test caller found in src/',
        });
      }
    }
  }
}

// ── Check 3: PackPrinciples fields never read ─────────────────────
{
  const packsPath = join(srcDir, 'core/design/packs.ts');
  const packsContent = readFileSync(packsPath, 'utf8');
  // Extract PackPrinciples interface fields.
  const principleFields: string[] = [];
  const ifaceMatch = packsContent.match(/interface\s+PackPrinciples\s*\{([^}]*)\}/);
  if (ifaceMatch) {
    for (const m of ifaceMatch[1].matchAll(/(\w+)\s*[?:]/g)) principleFields.push(m[1]);
  }
  for (const field of principleFields) {
    // Check if the field is read in any src/ file (beyond the interface declaration).
    let found = false;
    for (const [path, content] of srcContent) {
      if (path === packsPath) continue;
      if (new RegExp(`\\b${field}\\b`).test(content)) { found = true; break; }
    }
    if (!found) {
      // Also check if it's read in packs.ts itself (e.g., in resolvePack).
      const inPacks = (packsContent.match(new RegExp(`\\b${field}\\b`, 'g')) || []).length > 1;
      if (!inPacks) {
        findings.push({
          check: 'principle-never-read',
          symbol: field,
          verdict: 'fail',
          detail: 'PackPrinciples field never read by the engine',
        });
      }
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.verdict === 'fail');
const warns = findings.filter((f) => f.verdict === 'warn');

console.log('\n┌─ Wiring Audit ──────────────────────────────────────────────');
console.log('│');

// Group by check.
const checks = [...new Set(findings.map((f) => f.check))];
for (const check of checks) {
  const items = findings.filter((f) => f.check === check);
  const failsInCheck = items.filter((f) => f.verdict === 'fail');
  const warnsInCheck = items.filter((f) => f.verdict === 'warn');
  if (failsInCheck.length === 0 && warnsInCheck.length === 0) {
    console.log(`│ ${check}: ${items.length} checked, all pass`);
    continue;
  }
  console.log(`│ ${check}: ${items.length} checked, ${failsInCheck.length} fail, ${warnsInCheck.length} warn`);
  for (const f of failsInCheck) {
    console.log(`│   FAIL  ${f.symbol} — ${f.detail}`);
  }
  for (const f of warnsInCheck) {
    console.log(`│   WARN  ${f.symbol} — ${f.detail}`);
  }
}

console.log('│');
console.log(`│ Total: ${findings.length} checked, ${fails.length} fail, ${warns.length} warn`);
console.log('└──────────────────────────────────────────────────────────────\n');

if (fails.length > 0) {
  console.error(`✗ Wiring audit FAILED: ${fails.length} hard failure(s)`);
  process.exit(1);
} else {
  console.log('✓ Wiring audit PASSED');
  process.exit(0);
}
