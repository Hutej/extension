/**
 * tests/f4-persist-key-test.ts — Phase 5 F4 CONTINUITY unit test (pure, no browser).
 *
 * Proves the two F4 persistence primitives before any replay behaviour depends
 * on them (Step 1 of the approved implementation order):
 *
 *  1. scopeKey(url) = origin + pathname. Privacy: query and fragment are NEVER
 *     in the key — `?token=SECRET` and `#section` do not change it (rule 14 /
 *     product req 6: never store or transmit a full URL). Scoping: /wiki/CSS and
 *     /wiki/HTML are DIFFERENT keys (the approved origin+path decision; the
 *     opposite of the old origin-only key that leaked a hide across articles).
 *
 *  2. The persisted identity DIGEST is privacy-safe + identity-bearing:
 *     - same element (same structure) across a "reload" → SAME digest.
 *     - changed text → DIFFERENT digest (wrong-target detection survives).
 *     - changed attribute → DIFFERENT digest.
 *     - the digest STRING contains no cleartext page content (no 40-char text
 *       prefix, no aria-label/alt value) — it is a 64-char hex SHA-256.
 *     - two genuinely-identical twins → SAME digest (twin protection is NOT the
 *       digest's job; it stays F1's resolveTarget job, proven in f1-identity-test).
 *
 * Pure: no model, no browser, no extension. Imports the real `scopeKey` and the
 * real `digestOfElement` (which calls F1's real `fingerprint` + Web Crypto
 * `crypto.subtle.digest`). Runs on Node 22 (--experimental-strip-types) where
 * `crypto.subtle` is global. Rule 15: every check ships with a deliberate
 * FAILING case, demonstrated actually failing.
 *
 * Run: node --experimental-strip-types tests/f4-persist-key-test.ts
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scopeKey } from '../src/core/persist/index.ts';
import { digestOfElement, sha256Hex } from '../src/core/persist/digest.ts';
import { fingerprint, type IdentityDom } from '../src/core/identity.ts';
import { Journal } from '../src/agent/journal.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', name); } }
const failures: string[] = [];

// ── fake DOM (a minimal IdentityDom for fingerprint) ───────────────────────
// Same shape f1-identity-test uses: plain nodes, querySelectorAll over a tiny
// grammar. fingerprint() only reads tag/attrs/text/childElementCount/depth/parent,
// so a minimal adapter is enough.
interface N { tag: string; attrs: Record<string, string>; text: string; children: N[]; parent: N | null; }
function n(tag: string, opts: { attrs?: Record<string, string>; text?: string; children?: N[] } = {}): N {
  return { tag, attrs: opts.attrs ?? {}, text: opts.text ?? '', children: opts.children ?? [], parent: null };
}
function link(children: N[], parent: N) { for (const c of children) { c.parent = parent; link(c.children, c); } }

function fakeDom(root: N): IdentityDom {
  const all = (x: N): N[] => [x, ...x.children.flatMap(all)];
  const matches = (el: N, sel: string): boolean => {
    for (const part of sel.split(',')) {
      const s = part.trim();
      if (!s) continue;
      // tag#id, tag[attr=value], tag — enough for these tests
      const idm = s.match(/^(\w+)#([\w-]+)$/);
      if (idm && el.tag === idm[1] && el.attrs['id'] === idm[2]) return true;
      const am = s.match(/^(\w+)\[([\w-]+)=([^\]]+)\]$/);
      if (am && el.tag === am[1] && el.attrs[am[2]] === am[3]) return true;
      if (/^\w+$/.test(s) && el.tag === s) return true;
    }
    return false;
  };
  return {
    querySelectorAll: (sel: string) => all(root).filter((el) => matches(el, sel)),
    tagName: (el) => el.tag,
    attrs: (el) => Object.entries(el.attrs).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0),
    text: (el) => el.text,
    childElementCount: (el) => el.children.length,
    depthFromRoot: (el) => {
      let d = 0, x: N | null = el; while (x && x !== root) { x = x.parent; d++; if (d > 100) break; } return d;
    },
    parent: (el) => el.parent,
    fingerprintOfRef: (el) => fingerprint(el, fakeDom(root)),
  };
}

// ── 1. scopeKey ────────────────────────────────────────────────────────────
// scopeKey takes a URL (the content-script form passes window.location.href; the
// background form passes details.url). Both must produce origin+pathname only.
function checkScopeKey() {
  console.log('1. scopeKey — origin + pathname, never query/fragment');
  const base = 'https://en.wikipedia.org/wiki/CSS';
  ok('plain URL → origin+path', scopeKey(base) === 'https://en.wikipedia.org/wiki/CSS');
  // Privacy: query (tokens/personal data) is stripped, not persisted.
  ok('query stripped (?token=SECRET does not enter the key)',
    scopeKey('https://en.wikipedia.org/wiki/CSS?token=SECRET&utm=x') === 'https://en.wikipedia.org/wiki/CSS');
  // Privacy: fragment stripped.
  ok('fragment stripped (#section does not enter the key)',
    scopeKey('https://en.wikipedia.org/wiki/CSS#Layout') === 'https://en.wikipedia.org/wiki/CSS');
  // The combined privacy case the design names: ?token=SECRET#x == /wiki/CSS.
  ok('query+fragment together stripped (== plain)',
    scopeKey('https://en.wikipedia.org/wiki/CSS?token=SECRET#x') === scopeKey('https://en.wikipedia.org/wiki/CSS'));
  // Scoping: two articles are different keys (the approved origin+path decision).
  ok('different pathname → different key (/wiki/CSS != /wiki/HTML)',
    scopeKey('https://en.wikipedia.org/wiki/CSS') !== scopeKey('https://en.wikipedia.org/wiki/HTML'));
  ok('different origin → different key',
    scopeKey('https://en.wikipedia.org/wiki/CSS') !== scopeKey('https://developer.mozilla.org/en-US/docs/Web/CSS'));
  // Trailing slash is preserved by URL (a different pathname), not normalized away.
  ok('trailing slash is part of the pathname',
    scopeKey('https://example.com/a') !== scopeKey('https://example.com/a/'));

  // ── deliberate FAILING case (rule 15) ───────────────────────────────────
  // A key that INCLUDES query/fragment is WRONG. Prove a naive origin+path+search
  // key fails the privacy property the live scopeKey satisfies.
  const badKey = (url: string) => { const u = new URL(url); return u.origin + u.pathname + u.search + u.hash; };
  const badHasSecret = badKey('https://en.wikipedia.org/wiki/CSS?token=SECRET').includes('SECRET');
  ok('FAILING CASE: a key including search WOULD leak the token (the live scopeKey does not)',
    badHasSecret === true && !scopeKey('https://en.wikipedia.org/wiki/CSS?token=SECRET').includes('SECRET'));
  if (!badHasSecret) failures.push('badKey did not include the secret — failing case not demonstrated');

  // ── failing-case harness for scopeKey itself: if the live scopeKey ever
  // regresses to include search/hash, this assertion flips and fails the test.
  ok('scopeKey never contains the secret token',
    !scopeKey('https://en.wikipedia.org/wiki/CSS?token=TOPSECRET#frag').includes('TOPSECRET'));
  ok('scopeKey never contains the fragment',
    !scopeKey('https://en.wikipedia.org/wiki/CSS?x=1#frag').includes('frag'));
}

// ── 2. digest ───────────────────────────────────────────────────────────────
async function checkDigest() {
  console.log('2. persisted identity digest — SHA-256 of the fingerprint');
  // A sidebar element with a 40-char-ish text and an aria-label (the cleartext
  // content the full fingerprint would expose).
  const root = n('html', { children: [n('body', { children: [
    n('aside', { attrs: { id: 'sb', role: 'complementary', 'aria-label': 'Customer order 4421 — ship to 12 Oak Street' },
      text: 'Account summary and recent activity for the signed-in user.',
      children: [n('div', { text: 'inner panel' })] }),
  ] })] });
  link([root], null);
  const dom = fakeDom(root);
  const aside = root.children[0].children[0];

  const digestA = await digestOfElement(aside, dom);
  const digestB = await digestOfElement(aside, dom); // "reload" — recompute
  ok('digest is a 64-char hex SHA-256', /^[0-9a-f]{64}$/.test(digestA));
  ok('same element recomputed → same digest (survives reload)', digestA === digestB);
  ok('digest string contains NO cleartext text prefix', !digestA.includes('Account summary'));
  ok('digest string contains NO cleartext aria-label', !digestA.includes('Customer order 4421'));
  ok('digest string contains NO tag name', !digestA.includes('aside'));
  // 64 hex chars only — no cleartext of any kind survives.
  ok('digest is only hex (no other characters)', /^[0-9a-f]{64}$/.test(digestA) && digestA.length === 64);

  // Changed TEXT → different digest (the wrong-target detection that f4-identity-
  // mismatch-test depends on). Simulate a re-render that swapped the aside's text.
  const aside2text = n('aside', { attrs: { id: 'sb', role: 'complementary', 'aria-label': 'Customer order 4421 — ship to 12 Oak Street' },
    text: 'COMPLETELY DIFFERENT CONTENT after a page change.',
    children: [n('div', { text: 'inner panel' })] });
  link([aside2text], n('body')); aside2text.parent = root.children[0];
  const dom2 = fakeDom(root);
  const digestText = await digestOfElement(aside2text, dom2);
  ok('changed text → different digest (wrong-target detection survives)',
    digestA !== digestText);
  if (digestA === digestText) failures.push('changed text did NOT change the digest — wrong-target detection broken');

  // Changed ATTRIBUTE → different digest.
  const aside2attr = n('aside', { attrs: { id: 'sb', role: 'complementary', 'aria-label': 'DIFFERENT LABEL' },
    text: 'Account summary and recent activity for the signed-in user.',
    children: [n('div', { text: 'inner panel' })] });
  link([aside2attr], n('body')); aside2attr.parent = root.children[0];
  const dom3 = fakeDom(root);
  const digestAttr = await digestOfElement(aside2attr, dom3);
  ok('changed attribute → different digest', digestA !== digestAttr);

  // A DIFFERENT id IS a different identity (id is part of structure) → different
  // digest. (The old test wrongly expected these to match; an id difference is a
  // real identity difference the digest must reflect.)
  const twin = n('aside', { attrs: { id: 'other', role: 'complementary', 'aria-label': 'Customer order 4421 — ship to 12 Oak Street' },
    text: 'Account summary and recent activity for the signed-in user.',
    children: [n('div', { text: 'inner panel' })] });
  link([twin], n('body')); twin.parent = root.children[0];
  const domTwin = fakeDom(root);
  const digestTwin = await digestOfElement(twin, domTwin);
  ok('different id → different digest (id is part of identity)',
    digestA !== digestTwin);

  // GENUINE identical twins: same tag, same attrs (NO distinguishing id), same
  // text, same children → SAME digest. This is F1's identical-twin case. The
  // digest correctly cannot tell them apart — twin protection is NOT the digest's
  // job; it stays F1's resolveTarget (which refuses many-matches). Proven here
  // so F4 never relies on the digest to disambiguate twins.
  const t1 = n('div', { attrs: { class: 'card' }, text: 'same content', children: [] });
  const t2 = n('div', { attrs: { class: 'card' }, text: 'same content', children: [] });
  const twinRoot = n('html', { children: [n('body', { children: [t1, t2] })] });
  link([twinRoot], null);
  const domGT = fakeDom(twinRoot);
  const dt1 = await digestOfElement(t1, domGT);
  const dt2 = await digestOfElement(t2, domGT);
  ok('genuine identical twins → same digest (twin protection stays in F1 resolveTarget)',
    dt1 === dt2);

  // Style-agnostic: adding a `style` attribute does NOT change the digest (the
  // transform we apply changes style; the digest must survive it so replay can
  // re-verify an element we already hid/reclored).
  const asideStyled = n('aside', { attrs: { id: 'sb', role: 'complementary', 'aria-label': 'Customer order 4421 — ship to 12 Oak Street', style: 'display: none; color: red;' },
    text: 'Account summary and recent activity for the signed-in user.',
    children: [n('div', { text: 'inner panel' })] });
  link([asideStyled], n('body')); asideStyled.parent = root.children[0];
  const domStyled = fakeDom(root);
  const digestStyled = await digestOfElement(asideStyled, domStyled);
  ok('style change does NOT change the digest (style-agnostic — survives our transform)',
    digestA === digestStyled);
  if (digestA !== digestStyled) failures.push('style changed the digest — replay of a hidden element would false-mismatch');

  // ── deliberate FAILING case (rule 15) ───────────────────────────────────
  // A digest that DOES change on a text change is REQUIRED. Prove a digest
  // derived from only tag+attrs (ignoring text) would FAIL to detect the text
  // swap — i.e. that the live digest's text-sensitivity is load-bearing.
  const tagAttrOnly = (el: N) => el.tag + '|' + Object.entries(el.attrs).filter(([k]) => k !== 'style' && !k.startsWith('data-rv')).map(([k,v])=>k+'='+v).sort().join('|');
  const badDigestText = await sha256Hex(tagAttrOnly(aside2text));
  ok('FAILING CASE: a tag+attrs-only digest would MISS the text change (the live digest catches it)',
    badDigestText === (await sha256Hex(tagAttrOnly(aside))) && digestA !== digestText);
  if (badDigestText !== (await sha256Hex(tagAttrOnly(aside)))) failures.push('tag+attrs digest changed on text — failing case not demonstrated');
}

// ── F4 PRIVACY: toPersistableState strips cleartext page content ─────────────
// The adversarial review found that the persisted journal carried cleartext
// (observe results, act result slices, inverse.prevHtml innerHTML). The user
// (19 Aug 2026) chose to strip it. This proves the persisted state holds NO
// cleartext page content — only act args + identityDigest + removeCss CSS.
function checkPersistableStripsCleartext() {
  // Build a session Journal with observe + act entries carrying cleartext.
  const j = new Journal();
  j.origin = 'https://f4.test'; j.path = '/wiki/CSS'; j.goal = 'hide the sidebar';
  // observe entry (describePage) — has cleartext textSample.
  j.append({ tool: 'describePage', kind: 'observe', args: {}, result: { regions: [{ textSample: 'SECRET PAGE TEXT' }] }, costMs: 5, timestamp: 1 } as any);
  // act entry (setText) — result has a `before` slice, inverse has prevHtml.
  j.append({ tool: 'setText', kind: 'act', args: { selector: '#a', text: 'New' }, result: { applied: true, before: 'CLEARTEXT BEFORE', after: 'New' }, identityDigest: 'd1'.repeat(32), inverse: { kind: 'restoreText', selector: '#a', prevHtml: 'CLEARTEXT INNER HTML' }, costMs: 7, timestamp: 2 } as any);
  // act entry (hide/applyCss) — inverse is removeCss (OUR output, kept).
  j.append({ tool: 'hide', kind: 'act', args: { selector: '#a' }, result: { applied: true }, identityDigest: 'd2'.repeat(32), inverse: { kind: 'removeCss', css: '#a { display:none !important }' }, costMs: 9, timestamp: 3 } as any);

  const s = j.toPersistableState();
  // observe entries DROPPED entirely.
  ok('PRIVACY: observe entries dropped from persisted state', s.entries.every((e: any) => e.kind === 'act'));
  ok('PRIVACY: exactly 2 act entries persisted (observe dropped)', s.entries.length === 2, `len=${s.entries.length}`);
  // act entries have NO result.
  ok('PRIVACY: no persisted act entry carries a result', s.entries.every((e: any) => e.result == null));
  // restoreText inverse has NO prevHtml.
  const setTextEntry = s.entries.find((e: any) => e.tool === 'setText');
  ok('PRIVACY: setText inverse.prevHtml stripped', (setTextEntry?.inverse as any)?.prevHtml == null);
  ok('PRIVACY: setText identityDigest kept (SHA-256, not cleartext)', (setTextEntry?.identityDigest as string)?.length === 64);
  // removeCss inverse CSS kept (our output, not page content).
  const hideEntry = s.entries.find((e: any) => e.tool === 'hide');
  ok('PRIVACY: removeCss inverse.css kept (our output, not page content)', (hideEntry?.inverse as any)?.css === '#a { display:none !important }');
  // The whole serialized state contains NO cleartext page text.
  const blob = JSON.stringify(s);
  ok('PRIVACY: serialized persisted state has no "SECRET PAGE TEXT"', !blob.includes('SECRET PAGE TEXT'));
  ok('PRIVACY: serialized persisted state has no "CLEARTEXT BEFORE"', !blob.includes('CLEARTEXT BEFORE'));
  ok('PRIVACY: serialized persisted state has no "CLEARTEXT INNER HTML"', !blob.includes('CLEARTEXT INNER HTML'));

  // FAILING CASE: toState (session) STILL carries the cleartext (the model sees
  // it; the act guardTarget uses it) — only toPersistableState strips it. This
  // proves the strip is persistence-only, not destroying session data.
  const sessionState = j.toState();
  const sessionBlob = JSON.stringify(sessionState);
  ok('FAILING CASE: session toState still carries cleartext (strip is persistence-only)',
    sessionBlob.includes('SECRET PAGE TEXT') && sessionBlob.includes('CLEARTEXT INNER HTML'),
    !sessionBlob.includes('SECRET PAGE TEXT') ? 'session lost cleartext (would break the model/act)' : '');
}

// ── run ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== f4-persist-key-test ===');
  checkScopeKey();
  await checkDigest();
  checkPersistableStripsCleartext();
  const result = { pass, fail, failures };
  writeFileSync(join(PROOF_DIR, 'f4-persist-key-test.json'), JSON.stringify(result, null, 2));
  console.log(`\npass=${pass} fail=${fail}`);
  if (fail > 0) { console.error('FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
  console.log('ALL PASS');
}
void main();
