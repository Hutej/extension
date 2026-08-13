/**
 * audit-wiring.ts — principle 13 enforcement (rule 16: wire it or do not
 * write it). No orphans in the src/ tree.
 *
 * Three checks, all fail the build (exit 1) if violated:
 *
 *   1. tools/: every export in src/tools/*.ts (except index.ts) is referenced
 *      in src/tools/index.ts — no tool function is written and never registered.
 *
 *   2. core/ + agent/: every export in the src/core subtree and src/agent dir
 *      (except type/interface exports) is referenced in some OTHER src file
 *      under src/. An export that nothing imports is an orphan. (Phase 2.5:
 *      this is the check that was missing — it let validateOps exist, be
 *      tested, but stay dead at runtime.)
 *
 *      An export may be DEFERRED with a `// audit:defer <reason>` comment on
 *      the line above its `export` statement. Deferred exports are skipped,
 *      but the reason is printed so the gap is never silent. This is the ONLY
 *      way to pass an export with no current consumer — faking a runtime call
 *      is forbidden (manufactured architecture). The reason must name when it
 *      will be wired (e.g. "wired when the first structural op ships").
 *
 *   3. The registry (getTool or registry from src/tools/index.ts) is imported
 *      by the agent loop and the content script — every registry entry is
 *      reachable from the loop.
 *
 * Run as part of `npm run build`, before wxt build.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath decodes %20 and keeps the leading slash — raw new URL().pathname
// leaves %20 encoded and breaks on any path containing a space.
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf-8');
}

let failed = false;
function fail(msg: string): void {
  console.error(`  ✖ ${msg}`);
  failed = true;
}

/** Recursively collect .ts files under a directory. */
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTs(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Read every .ts file under src/ into {path, content} pairs (path relative to src/). */
function readAllSrc(): { rel: string; content: string }[] {
  const files = listTs(srcDir);
  return files.map((f) => ({ rel: relative(srcDir, f).replace(/\\/g, '/'), content: readFileSync(f, 'utf-8') }));
}

const allSrc = readAllSrc();

/** Top-level exports in a file's source: export const/function/async fn X.
 *  Skips type/interface exports (types vanish at runtime; not wiring concerns). */
function findExports(content: string): { name: string; deferred: boolean; reason: string }[] {
  const out: { name: string; deferred: boolean; reason: string }[] = [];
  const lines = content.split('\n');
  // export\s+(?:const|function|async function|type|interface)\s+(\w+)
  const exportRe = /^export\s+(?:const|function|async function)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = exportRe.exec(lines[i]);
    if (!m) continue;
    // A deferred export: the line above carries `// audit:defer <reason>`.
    const above = i > 0 ? lines[i - 1] : '';
    const deferMatch = above.match(/\/\/\s*audit:defer\s+(.*)/);
    out.push({ name: m[1], deferred: !!deferMatch, reason: deferMatch ? deferMatch[1].trim() : '' });
  }
  return out;
}

/** Does `name` have a runtime consumer? An export is wired if it is:
 *   (a) referenced in some OTHER src file (an import / call site), OR
 *   (b) used within its OWN file's runtime code (a same-file call site — e.g.
 *       an internal singleton like `txnLog`, or a module-private constant
 *       used by a wired function). The export declaration line itself does
 *       NOT count as a use. */
function referencedElsewhere(name: string, ownRel: string, ownContent: string): boolean {
  // (a) referenced in another src file.
  for (const f of allSrc) {
    if (f.rel === ownRel) continue;
    if (new RegExp(`\\b${name}\\b`).test(f.content)) return true;
  }
  // (b) used within own file, excluding the export declaration line(s).
  const ownLines = ownContent.split('\n');
  const exportRe = new RegExp(`^export\\s+(?:const|function|async function)\\s+${name}\\b`);
  for (const line of ownLines) {
    if (exportRe.test(line)) continue; // the declaration — not a use
    if (new RegExp(`\\b${name}\\b`).test(line)) return true;
  }
  return false;
}

// ── check 1: every export in tools/ appears in tools/index.ts ─────────────

const toolsDir = join(srcDir, 'tools');
const toolFiles = readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts');

const indexContent = readSrc('tools/index.ts');

for (const file of toolFiles) {
  const content = readFileSync(join(toolsDir, file), 'utf-8');
  for (const { name, deferred, reason } of findExports(content)) {
    if (deferred) { console.log(`  • tools/${file} ${name} DEFERRED — ${reason}`); continue; }
    if (!indexContent.includes(name)) {
      fail(`tools/${file} exports "${name}" but it is not referenced in tools/index.ts`);
    }
  }
}

// ── check 2: every export in core/ + agent/ is referenced in another src file ──
//
// Phase 2.5 widening: this is the check the old audit lacked. It would have
// caught validateOps (core/ops/index.ts) being imported only by a test, never
// by src/. An export with no real consumer must be marked `audit:defer` with a
// reason naming when it wires — faking a call is forbidden.

const coreAgentFiles = allSrc.filter((f) =>
  (f.rel.startsWith('core/') && !f.rel.startsWith('core/perceive/')) || f.rel.startsWith('agent/'));
// perceive/ is explicitly off-limits this phase (roadmap §2: "huge, mostly
// orphaned" — its cleanup is NOT part of the ACT-reachability gate). Scoping the
// audit to the loop + tools + act/emit/sanitize/ops/persist/reason/config path
// is the "relevant src/ tree" the Phase 2.5 mandate names. perceive's orphans
// are a known, separately-tracked debt, not something to fix under "do not
// touch perceive/".

const deferredSeen: string[] = [];
for (const f of coreAgentFiles) {
  const exports = findExports(f.content);
  for (const { name, deferred, reason } of exports) {
    if (deferred) {
      deferredSeen.push(`  • ${f.rel} :: ${name} — ${reason}`);
      continue;
    }
    if (!referencedElsewhere(name, f.rel, f.content)) {
      fail(`src/${f.rel} exports "${name}" but nothing imports or uses it — not in another src/ file, and not within its own file's runtime code. ` +
        `Wire it to a real consumer, delete it if dead, or (for a genuinely-future guard) mark it ` +
        `'// audit:defer <reason + when it wires>' on the line above the export. ` +
        `Do NOT add a fake call to pass the audit.`);
    }
  }
}

// ── check 3: registry is reachable from the loop and content script ──

const loopContent = readSrc('agent/loop.ts');
const contentContent = readSrc('entrypoints/content.ts');

if (!loopContent.includes('tools/index') && !loopContent.includes('tools/')) {
  fail('agent/loop.ts does not import from tools/ — registry is unreachable from the loop');
}

if (!contentContent.includes('tools/index') && !contentContent.includes('tools/')) {
  fail('entrypoints/content.ts does not import from tools/ — tools are unreachable at execution time');
}

// Also check that getTool or registry is actually used (not just imported).
if (!loopContent.includes('getTool') && !loopContent.includes('registry')) {
  fail('agent/loop.ts imports tools/ but never calls getTool or registry');
}

if (!contentContent.includes('getTool') && !contentContent.includes('registry')) {
  fail('entrypoints/content.ts imports tools/ but never calls getTool or registry');
}

if (failed) {
  console.error('\naudit-wiring: FAIL — orphans found in src/ (rule 16 violated)');
  process.exit(1);
}

if (deferredSeen.length) {
  console.log('\naudit-wiring: deferred exports (honest gaps, not wired yet):');
  for (const d of deferredSeen) console.log(d);
}
console.log('audit-wiring: OK — every src/ export is referenced or explicitly deferred, registry reachable from loop + content');
