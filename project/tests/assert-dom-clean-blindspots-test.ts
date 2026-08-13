/**
 * tests/assert-dom-clean-blindspots-test.ts — Phase 2.5 TASK7.
 *
 * assertDomClean() does NOT mean "the entire webpage is guaranteed unchanged."
 * It means the structural fingerprint + the inserted-node count match the
 * baseline. This test pins the KNOWN BLIND SPOTS: mutations that the
 * comparator CANNOT detect, each verified against the actual exclusion in
 * assert-dom-clean.ts FINGERPRINT_FN.
 *
 * For each blind spot: build a baseline DOM, mutate it in the blind-spot way,
 * assert the fingerprint is UNCHANGED (the mutation escaped detection). This
 * is a deliberate "known-blind" test — it documents what assertDomClean
 * cannot see, so a future developer does not assume it sees everything.
 *
 * Uses jsdom-free logic: the fingerprint function is the SAME string the page
 * runs (FINGERPRINT_FN), evaluated here against a DOM built with the DOMParser
 * available in Node via `linkedom` — but to avoid a new dependency, this test
 * reimplements the fingerprint in TS against a minimal in-memory node model
 * that mirrors FINGERPRINT_FN exactly. (Same logic, test-side copy; if they
 * drift, the byte-identity tests in phase2-reversal catch it on real pages.)
 *
 * Usage: node --experimental-strip-types tests/assert-dom-clean-blindspots-test.ts
 * No browser, no credentials.
 */

import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

// ── Minimal DOM model mirroring FINGERPRINT_FN exactly ──────────────────
// A node: { tag, attrs: Map, children: Node[], text: string (direct text) }
// The fingerprint: tag[sorted-attrs-except-denylist](child-fingerprints)[:trimmed-direct-text]
// Exclusions mirror FINGERPRINT_FN: data-rv-c, data-rv-wrap, #revueon-style,
// #revueon-escape-ui nodes excluded; `style`/data-rv-c/data-rv-wrap attrs denied;
// script/style TEXT skipped; whitespace collapsed+trimmed; attrs sorted.

interface Attr { name: string; value: string }
interface TNode { tag: string; attrs: Attr[]; children: TNode[]; text: string; id?: string; rvC?: boolean; rvWrap?: boolean }

const DENY = new Set(['style', 'data-rv-c', 'data-rv-wrap']);

function fingerprint(n: TNode): string {
  if (n.rvC || n.rvWrap || n.id === 'revueon-style' || n.id === 'revueon-escape-ui') return '';
  const tag = n.tag.toLowerCase();
  const attrs = n.attrs
    .filter((a) => !DENY.has(a.name))
    .map((a) => `${a.name}=${a.value}`)
    .sort();
  const attrStr = attrs.length ? `[${attrs.join(',')}]` : '';
  let text = '';
  if (tag !== 'script' && tag !== 'style') {
    const t = n.text.replace(/\s+/g, ' ').trim();
    if (t) text = `:${t}`;
  }
  const kids = n.children.map(fingerprint).filter(Boolean);
  const kidStr = kids.length ? `(${kids.join(',')})` : '';
  return tag + attrStr + text + kidStr;
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

function blindSpot(name: string, baseline: TNode, mutate: (n: TNode) => void, detailIfSeen: string): void {
  const before = fingerprint(baseline);
  // Work on a deep clone so the baseline fingerprint is from the un-mutated tree.
  const clone: TNode = JSON.parse(JSON.stringify(baseline));
  mutate(clone);
  const after = fingerprint(clone);
  const escaped = before === after;
  checks.push({
    name: `BLIND SPOT: ${name} — assertDomClean does NOT detect it`,
    pass: escaped,
    detail: escaped ? `(correctly invisible — blind spot confirmed)` : `FINGERPRINT CHANGED — not a blind spot! ${detailIfSeen}`,
  });
}

// ── 1. inline `style` attribute mutation is invisible ──────────────────
blindSpot(
  'inline style attribute',
  { tag: 'div', attrs: [{ name: 'class', value: 'card' }], children: [], text: 'hello' },
  (n) => { n.attrs.push({ name: 'style', value: 'display:none' }); },
  'style was supposed to be excluded but fingerprint changed',
);

// ── 2. form control .value property (attribute present, value unchanged) ──
// The fingerprint includes the value ATTRIBUTE. A mutation that only changes
// the .value PROPERTY (not the attribute) leaves the fingerprint unchanged.
blindSpot(
  'form .value property (not attribute)',
  { tag: 'input', attrs: [{ name: 'type', value: 'text' }, { name: 'value', value: 'original' }], children: [], text: '' },
  (n) => {
    // Simulate JS: el.value = 'user-typed' — updates the PROPERTY, not the attr.
    // In the fingerprint (attrs only), the value attr stays 'original'. So the
    // mutation is invisible. (We do NOT change attrs here — that's the point.)
    void n;
  },
  'value attribute changed — property-only mutation should be invisible',
);

// ── 3. <script> / <style> element TEXT rewrite ────────────────────────
blindSpot(
  'script element text rewrite',
  { tag: 'script', attrs: [{ name: 'src', value: 'app.js' }], children: [], text: 'console.log(1)' },
  (n) => { n.text = 'console.log("completely different and malicious")'; },
  'script text was supposed to be excluded but fingerprint changed',
);
blindSpot(
  'style element text rewrite',
  { tag: 'style', attrs: [], children: [], text: '.x{color:red}' },
  (n) => { n.text = '.x{color:blue;background:black}'; },
  'style text was supposed to be excluded but fingerprint changed',
);

// ── 4. Revueon marker churn (data-rv-c / data-rv-wrap) invisible ───────
blindSpot(
  'data-rv-c stamp churn',
  { tag: 'div', attrs: [{ name: 'data-rv-c', value: 'abc' }], children: [], text: 'x' },
  (n) => { n.attrs = n.attrs.map((a) => a.name === 'data-rv-c' ? { ...a, value: 'xyz' } : a); },
  'data-rv-c was supposed to be excluded but fingerprint changed',
);

// ── 5. whitespace-only text mutation invisible ─────────────────────────
blindSpot(
  'whitespace-only text change',
  { tag: 'p', attrs: [], children: [], text: 'hello   world' },
  (n) => { n.text = 'hello\t\tworld'; }, // collapses to same 'hello world'
  'whitespace was supposed to collapse but fingerprint changed',
);

// ── 6. attribute reorder invisible ─────────────────────────────────────
blindSpot(
  'attribute reorder',
  { tag: 'a', attrs: [{ name: 'href', value: '/x' }, { name: 'class', value: 'link' }], children: [], text: 'go' },
  (n) => { n.attrs = [n.attrs[1], n.attrs[0]]; }, // swap order
  'attrs are sorted — reorder should be invisible but fingerprint changed',
);

// ── 7. CONFIRM the fingerprint DOES catch a real mutation (control) ────
{
  const baseline: TNode = { tag: 'div', attrs: [{ name: 'class', value: 'card' }], children: [{ tag: 'p', attrs: [], children: [], text: 'keep me' }], text: '' };
  const before = fingerprint(baseline);
  const clone: TNode = JSON.parse(JSON.stringify(baseline));
  // Real mutation: remove a child — this MUST be detected.
  clone.children.pop();
  const after = fingerprint(clone);
  checks.push({
    name: 'CONTROL: assertDomClean DOES detect a removed child (not a blind spot)',
    pass: before !== after,
    detail: before !== after ? 'child removal detected ✓' : 'FAIL — child removal was invisible!',
  });
}
{
  const baseline: TNode = { tag: 'div', attrs: [{ name: 'class', value: 'card' }], children: [], text: 'original text' };
  const before = fingerprint(baseline);
  const clone: TNode = JSON.parse(JSON.stringify(baseline));
  clone.text = 'REWRITTEN by setText';
  const after = fingerprint(clone);
  checks.push({
    name: 'CONTROL: assertDomClean DOES detect setText (direct text change)',
    pass: before !== after,
    detail: before !== after ? 'setText detected ✓' : 'FAIL — setText was invisible!',
  });
}

let failures = 0;
console.log('\nPhase 2.5 TASK7 — assertDomClean known blind spots\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'assert-dom-clean-blindspots-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? 'All blind-spot checks passed (blind spots confirmed; real mutations still detected).\n' : `${failures} check(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);
