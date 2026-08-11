/**
 * tests/parse-location-test.ts — Defect B1: CSS parse must run in the content
 * script, never in the background service worker.
 *
 * Constructable stylesheets (new CSSStyleSheet().replaceSync()) need a document.
 * A service worker has none. If the parse moved to the background with the insert,
 * every applyCss would throw at run time — and no build or string check would see
 * it, because the background bundle never runs parseCss in a build-time test.
 *
 * This test fails the moment parseCss / replaceSync / CSSStyleSheet appears in
 * the background entrypoint, OR the moment the content side stops parsing.
 *
 * Usage: node --experimental-strip-types tests/parse-location-test.ts
 * No browser, no credentials.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', 'src', rel), 'utf-8');
}

// 1. The background worker must NOT parse CSS. It only inserts a pre-serialised
//    string the content script sends. Any of these tokens in background.ts =
//    the parse has drifted into the worker = FAIL.
const bg = readSrc('entrypoints/background.ts');
const bgParseTokens = ['parseCss', 'replaceSync', 'CSSStyleSheet', 'emitCss', 'emitRules'];
const foundBg = bgParseTokens.filter(t => bg.includes(t));
checks.push({
  name: 'background.ts contains no CSS parse (parseCss/replaceSync/CSSStyleSheet/emitCss/emitRules)',
  pass: foundBg.length === 0,
  detail: foundBg.length ? `FOUND in background.ts: ${foundBg.join(', ')}` : 'background only inserts a pre-serialised string',
});

// 2. The content-script side (act.ts) MUST parse. parseCss is called from
//    emitAndInsert in act.ts. If that call disappears, the parse has moved.
const act = readSrc('tools/act.ts');
const actParses = act.includes('parseCss(');
checks.push({
  name: 'act.ts (content-script side) calls parseCss',
  pass: actParses,
  detail: actParses ? 'parseCss invoked in emitAndInsert' : 'parseCss call MISSING from act.ts — parse may have moved to the worker',
});

// 3. The insert message carries a CSS STRING, not rules/items. The background
//    receives message.css (a string), not message.items. This is the contract
//    that keeps parse on the content side and insert on the worker side.
const sendsString = act.includes("action: 'insertCSS', css") && bg.includes("css: message.css");
checks.push({
  name: 'insertCSS message carries a CSS string (content parses, background inserts)',
  pass: sendsString,
  detail: sendsString ? 'content sends css string; background inserts message.css' : 'insertCSS contract changed — verify parse/insert split',
});

// 4. Symmetry: removeCSS also takes a css string (the exact inserted one),
//    so undo does not re-parse either.
const undoString = bg.includes("css: message.css, origin: 'USER'") && bg.includes('removeCSS');
checks.push({
  name: 'removeCSS uses the exact css string (no re-parse on undo)',
  pass: undoString,
  detail: undoString ? 'undo removes by exact string' : 'undo contract changed',
});

// ── report ──
console.log('\n═══ PARSE-LOCATION TEST (defect B1) ═══');
for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
const allPass = checks.every(c => c.pass);
console.log(`\n  ${allPass ? 'ALL PASS' : 'FAILED'} — ${checks.filter(c => c.pass).length}/${checks.length}`);
writeFileSync(join(PROOF_DIR, 'parse-location-results.json'), JSON.stringify(checks, null, 2));
if (!allPass) process.exit(1);
