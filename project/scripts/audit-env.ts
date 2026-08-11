/**
 * Env-parity gate — permanent mechanical gate.
 *
 * Fails when a `process.env.X` or `import.meta.env.X` read in src/ has NO matching
 * `define` entry in wxt.config.ts. A missing define leaves a raw `process.env.X` in
 * the browser bundle → `process is not defined` at load → the content script dies
 * silently (no onMessage listener → "Could not establish connection" → 130s
 * timeout). This defect class killed 1G and 1H silently and is invisible to
 * the other gates (tsc, eslint, wxt build).
 *
 * Usage: node --experimental-strip-types scripts/audit-env.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const wxtPath = join(root, 'wxt.config.ts');

function readDir(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...readDir(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Collect every process.env.X / import.meta.env.X read in src/.
const reads = new Set<string>();
const re = /\b(?:process|import\.meta)\.env\.([A-Z_][A-Z0-9_]*)/g;
for (const f of readDir(srcDir)) {
  const src = readFileSync(f, 'utf8');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) reads.add(`process.env.${m[1]}`);
}

// Collect every define key in wxt.config.ts (the left side of the define object).
const wxt = readFileSync(wxtPath, 'utf8');
const defineRe = /'process\.env\.([A-Z_][A-Z0-9_]*)'\s*:/g;
const defines = new Set<string>();
let dm: RegExpExecArray | null;
while ((dm = defineRe.exec(wxt)) !== null) defines.add(`process.env.${dm[1]}`);

const missing: string[] = [];
for (const r of reads) if (!defines.has(r)) missing.push(r);

if (missing.length) {
  console.error(`✗ audit:env — ${missing.length} env read(s) without a wxt.config.ts define entry:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('Add a matching define entry in wxt.config.ts, or the content script throws `process is not defined` at load.');
  process.exit(1);
}
console.log(`✓ audit:env — ${reads.size} env read(s) all have define entries (${[...defines].sort().join(', ')})`);
