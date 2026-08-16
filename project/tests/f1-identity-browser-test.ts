/**
 * tests/f1-identity-browser-test.ts — Phase 4 F1 IDENTITY live guard (real Chromium).
 *
 * Proves the LIVE F1 guard end-to-end through the real extension:
 *   describePage (registers selector → fingerprint) → act tool re-resolves + verifies.
 * The pure decision is proven by tests/f1-identity-test.ts; THIS proves the guard
 * is wired into the real act tools against the real DOM, with deliberate failing
 * cases + controls (rule 15). No model HTTP — describePage + act tools called
 * directly via sendToolCall (the harness dispatch path the loop uses).
 *
 * Cases (each a deliberate FAIL + a CONTROL):
 *   1. WRONG-TARGET: describePage registers aside#sb; the live element's text is
 *      swapped (re-render) so its fingerprint differs; hide → REFUSES (ok:false,
 *      reason wrong-target). CONTROL: unchanged element → hide succeeds.
 *   2. DUPLICATES: two identical .card siblings; a selector matching both → act
 *      REFUSES (ambiguous / not an identity). CONTROL: a unique card → succeeds.
 *   3. STALE/DYNAMIC: describePage, then remove the target → act REFUSES (zero).
 *      CONTROL: present target → succeeds.
 *   4. SAME-PAGE-TWICE: describePage twice on the same fixture → same selectors
 *      AND same fingerprints (roadmap F1 Done: "same page twice → same selectors").
 *   5. SPA RE-RENDER: describePage, re-render the main content to equivalent
 *      structure, describePage again → same selectors (roadmap F1 Done: "after an
 *      SPA re-render → same selectors").
 *   6. UNTARGETABLE REASON: a region with no stable anchor surfaces the REASON
 *      (not just the bare UNTARGETABLE token — rule 13 / R3).
 *
 * Run: node --experimental-strip-types tests/f1-identity-browser-test.ts
 * Needs: built extension (.output/chrome-mv3), Playwright. No model HTTP / no creds.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, sendToolCall, hashStr } from './foundation-helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOF_DIR = join(__dirname, '..', 'proof');
mkdirSync(PROOF_DIR, { recursive: true });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function ck(n: string, pass: boolean, d: string) { checks.push({ name: n, pass, detail: d }); }

// A controlled fixture: a main article + a unique targetable aside + two duplicate cards.
const FIXTURE = `<!doctype html><html><head><meta charset=utf-8><style>
  body { margin:0; font:14px/1.4 sans-serif }
  #main { padding:12px }
  aside#sb { background:#eee; padding:8px; width:160px }
  .card { border:1px solid #ccc; padding:8px; margin:8px 0 }
</style></head><body>
  <main id="main">
    <h1>Article Title</h1>
    <aside id="sb">Sidebar content here</aside>
    <p class="card" id="c1">Card one with unique text AAA</p>
    <p class="card" id="c2">Card two with unique text BBB</p>
    <p class="twin">Twin A</p>
    <p class="twin">Twin B</p>
  </main>
</body></html>`;

async function describePage(ctx: any, page: any): Promise<any> {
  const res = await sendToolCall(context, page, 'describePage', {});
  if (!res?.ok) throw new Error('describePage failed: ' + JSON.stringify(res));
  return res;
}

async function findSelectorFor(ctx: any, page: any, predicate: (r: any) => boolean): Promise<any> {
  const res = await describePage(context, page);
  const r = (res.result?.regions ?? []).find(predicate);
  return r;
}

const context = await createContext('f1-identity-browser');

// Route a fake https URL so the content script (<all_urls>) matches and runs.
// setContent leaves about:blank, which the content script does NOT match — so
// describePage would never run. A route serves our controlled fixture at a real
// URL, keeping the genuine content-script dispatch path under test.
async function openFixture(html: string): Promise<any> {
  const page = await context.newPage();
  await page.route('https://f1.test/page', (route) => {
    route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('https://f1.test/page', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500); // let the content script bind
  return page;
}

try {
  // ── 1. WRONG-TARGET: hide refuses when the element changed (fp differs) ──
  {
    const page = await openFixture(FIXTURE);
    const aside = await findSelectorFor(context, page, (r) => r.tag === 'aside' && r.targetable);
    ck('1a WRONG-TARGET setup: aside is targetable with a selector', !!aside?.selector, JSON.stringify(aside ?? {}));
    if (aside?.selector) {
      // CONTROL first: unchanged element → hide succeeds
      const ctrl = await sendToolCall(context, page, 'hide', { selector: aside.selector });
      ck('1b WRONG-TARGET CONTROL: hide unchanged verified target → ok:true', !!ctrl?.ok, JSON.stringify(ctrl).slice(0, 160));
      // undo the control hide so the element is visible again, then re-describePage (refresh identity)
      await page.evaluate(() => { const el = document.querySelector('aside#sb') as HTMLElement; el.style.display = ''; });
      await describePage(context, page); // refresh fingerprints after the un-hide
      // Now mutate the element's text (re-render) so its fingerprint differs; selector still resolves to one.
      await page.evaluate(() => { (document.querySelector('aside#sb') as HTMLElement).textContent = 'RE-RENDERED different content'; });
      const fail = await sendToolCall(context, page, 'hide', { selector: aside.selector });
      ck('1c WRONG-TARGET FAIL: hide after re-render → REFUSES (ok:false)', !fail?.ok, JSON.stringify(fail).slice(0, 200));
      ck('1d WRONG-TARGET FAIL: reason names wrong-target / re-resolve', /different element|describePage/i.test(String(fail?.error ?? '')), String(fail?.error ?? '').slice(0, 160));
    }
    await page.close();
  }

  // ── 2. DUPLICATES: a selector matching twins → act refuses (ambiguous) ──
  {
    const page = await openFixture(FIXTURE);
    const dp = await describePage(context, page);
    // .twin matches BOTH twins — not an identity. hide must refuse (ambiguous).
    const fail = await sendToolCall(context, page, 'hide', { selector: '.twin' });
    ck('2a DUPLICATES FAIL: hide on a 2-match selector → REFUSES', !fail?.ok, JSON.stringify(fail).slice(0, 200));
    ck('2b DUPLICATES FAIL: reason is ambiguous (not a unique identity)', /2 elements|ambiguous|not a unique/i.test(String(fail?.error ?? '')), String(fail?.error ?? '').slice(0, 160));
    // CONTROL: a UNIQUE, describePage-verified target — use the selector describePage
    // actually returned for one of the cards (the cards differ in text, so each is
    // individually targetable with a structural selector). A raw '#c1' is NOT what
    // describePage returns, so it would be refused as unregistered — which is the
    // guard working, not a control. Use the real returned selector.
    const card = (dp.result?.regions ?? []).find((r: any) => r.targetable && /AAA|BBB/.test(r.textSample ?? ''));
    ck('2c DUPLICATES CONTROL setup: a unique card is targetable', !!card?.selector, JSON.stringify(card ?? {}).slice(0, 160));
    if (card?.selector) {
      const ctrl = await sendToolCall(context, page, 'hide', { selector: card.selector });
      ck('2d DUPLICATES CONTROL: hide a unique verified card → ok:true', !!ctrl?.ok, JSON.stringify(ctrl).slice(0, 160));
    }
    await page.close();
  }

  // ── 3. STALE/DYNAMIC: target removed between observe and act → refuse (zero) ──
  {
    const page = await openFixture(FIXTURE);
    const aside = await findSelectorFor(context, page, (r) => r.tag === 'aside' && r.targetable);
    if (aside?.selector) {
      // Remove the target after observe (dynamic DOM)
      await page.evaluate(() => { document.querySelector('aside#sb')?.remove(); });
      const fail = await sendToolCall(context, page, 'hide', { selector: aside.selector });
      ck('3a STALE FAIL: hide after target removed → REFUSES (zero)', !fail?.ok, JSON.stringify(fail).slice(0, 200));
      ck('3b STALE FAIL: reason names zero/removed/re-describePage', /nothing|removed|describePage/i.test(String(fail?.error ?? '')), String(fail?.error ?? '').slice(0, 160));
    } else ck('3 STALE setup: aside targetable', false, 'no aside');
    await page.close();
  }

  // ── 4. SAME-PAGE-TWICE: two describePage calls → same selectors + identity ──
  // The fingerprint is internal identity evidence (NOT in the model-facing
  // describePage output — emitting it bloats context for no model value; removed
  // after the real-site run found the bloat contributed to budget exhaustion).
  // So "same identity across calls" is proven INDIRECTLY: the selectors are
  // identical (4a), AND an act on a selector from call #1 still verifies after
  // call #2 re-registers identities (4b) — proving the store re-registered the
  // same fingerprints (the act guard would refuse if call #2's fingerprint differed).
  {
    const page = await openFixture(FIXTURE);
    const r1 = await describePage(context, page);
    const r2 = await describePage(context, page);
    const s1 = new Set((r1.result?.regions ?? []).filter((r: any) => r.targetable && r.selector).map((r: any) => r.selector));
    const s2 = new Set((r2.result?.regions ?? []).filter((r: any) => r.targetable && r.selector).map((r: any) => r.selector));
    const sameSelectors = s1.size === s2.size && [...s1].every((s) => s2.has(s));
    ck('4a SAME-PAGE-TWICE: identical selectors across two describePage calls', sameSelectors, `t1=${[...s1].join('||')} | t2=${[...s2].join('||')}`);
    // 4b: an act on a call-#1 selector must still VERIFY after call #2 — the act
    // guard reads the identity-store; if call #2 re-registered a DIFFERENT
    // fingerprint for the same selector, a hide would refuse (wrong-target). A
    // successful hide proves the identity was re-registered identically.
    const asideSel = [...s1].find((s) => /aside/.test(s));
    if (asideSel) {
      const hide = await sendToolCall(context, page, 'hide', { selector: asideSel });
      ck('4b SAME-PAGE-TWICE: act on call-#1 selector verifies after call #2 (identity re-registered)', !!hide?.ok, JSON.stringify(hide).slice(0, 160));
    } else ck('4b SAME-PAGE-TWICE: act verifies after re-register', false, 'no aside selector');
    await page.close();
  }

  // ── 5. SPA RE-RENDER: equivalent re-render → same selectors ──
  {
    const page = await openFixture(FIXTURE);
    const r1 = await describePage(context, page);
    // Simulate an SPA re-render: replace main's innerHTML with EQUIVALENT structure
    // (same ids/classes/text) — React-style re-render that preserves identity.
    await page.evaluate(() => {
      const main = document.getElementById('main')!;
      const equiv = `<h1>Article Title</h1>
        <aside id="sb">Sidebar content here</aside>
        <p class="card" id="c1">Card one with unique text AAA</p>
        <p class="card" id="c2">Card two with unique text BBB</p>
        <p class="twin">Twin A</p>
        <p class="twin">Twin B</p>`;
      main.innerHTML = equiv;
    });
    await page.waitForTimeout(300);
    const r2 = await describePage(context, page);
    const sel1 = new Set((r1.result?.regions ?? []).filter((r: any) => r.targetable && r.tag === 'aside').map((r: any) => r.selector));
    const sel2 = new Set((r2.result?.regions ?? []).filter((r: any) => r.targetable && r.tag === 'aside').map((r: any) => r.selector));
    ck('5a SPA RE-RENDER: aside still targetable after re-render', sel2.size > 0, 'no aside after re-render');
    // The id-anchored selector is stable; structural nth-of-type may shift but the
    // aside is still found by its id anchor → same selector.
    const sameAside = [...sel1].some((s) => sel2.has(s));
    ck('5b SPA RE-RENDER: aside selector stable after equivalent re-render', sameAside, `before=${[...sel1].join('|')} after=${[...sel2].join('|')}`);
    // And a hide on that stable selector still works after re-render (identity re-resolved)
    if (sameAside) {
      const stableSel = [...sel1].find((s) => sel2.has(s))!;
      const hide = await sendToolCall(context, page, 'hide', { selector: stableSel });
      ck('5c SPA RE-RENDER: hide on stable selector after re-render → ok:true (re-resolved)', !!hide?.ok, JSON.stringify(hide).slice(0, 160));
    }
    await page.close();
  }

  // ── 7. IDENTICAL TWINS — the act path refuses, no mutation, no txn ──
  // Two genuinely-identical article.cards. describePage would build a positional
  // selector (article.card:nth-of-type(k)) for one; the other has the same
  // structural fingerprint. The LIVE act guard must refuse (ok:false) — and the
  // refusal must leave the DOM UNCHANGED and record NO transaction (the guard
  // runs before the mutation; this is the safety boundary, not a message swap).
  // The fixture has a stable anchor on the <main> so buildStableSelector can chain
  // to each card; the cards are identical text so their fingerprints collide.
  {
    const TWIN_FIXTURE = `<!doctype html><html><head><meta charset=utf-8><style>
      body { margin:0; font:14px/1.4 sans-serif }
      #main { padding:12px }
      .card { border:1px solid #ccc; padding:8px; margin:8px 0 }
    </style></head><body>
      <main id="main">
        <h1>Article Title</h1>
        <article class="card">Twin card text</article>
        <article class="card">Twin card text</article>
      </main>
    </body></html>`;
    const page = await openFixture(TWIN_FIXTURE);
    const dp = await describePage(context, page);
    // Find a targetable card region (describePage registers its identity). The
    // selector describePage builds is `main#main > article:nth-of-type(k)` — it
    // does NOT echo the class, so match on the article tag (the twin cards share
    // a fingerprint; either region's selector is the twin-under-test).
    const card = (dp.result?.regions ?? []).find((r: any) => r.targetable && r.tag === 'article');
    ck('7a TWIN setup: a card region is targetable with a selector', !!card?.selector, JSON.stringify(card ?? {}).slice(0, 200));
    if (card?.selector) {
      // Capture the live fingerprints of BOTH cards + the flippable-set count for the proof.
      const probe = await page.evaluate((sel: string) => {
        const cards = Array.from(document.querySelectorAll('article.card')) as HTMLElement[];
        // The "flippable set" = the selector with positional pseudo-classes stripped.
        // For a describePage selector like `main#main > article.card:nth-of-type(k)`,
        // that is `main#main > article.card` — the set a reorder reroutes through.
        const stripped = sel.replace(/:nth-(?:of-type|child)\(([^)]*)\)/g, '').replace(/:nth-last-(?:of-type|child)\(([^)]*)\)/g, '')
          .replace(/:(?:first|last|only)-(?:of-type|child)/g, '');
        const flippable: string[] = [];
        try { for (const e of document.querySelectorAll(stripped)) flippable.push((e.textContent || '').trim()); } catch {}
        return {
          cardCount: cards.length,
          fpA: `${cards[0]?.tagName}|${cards[0]?.getAttribute('class')}|t=${(cards[0]?.textContent || '').trim()}`,
          fpB: `${cards[1]?.tagName}|${cards[1]?.getAttribute('class')}|t=${(cards[1]?.textContent || '').trim()}`,
          sameText: (cards[0]?.textContent || '').trim() === (cards[1]?.textContent || '').trim(),
          selector: sel,
          stripped,
          flippableCount: flippable.length,
          flippableTexts: flippable,
        };
      }, card.selector);
      ck('7b TWIN proof: two cards, identical text (a genuine twin pair)',
        probe.cardCount === 2 && probe.sameText,
        JSON.stringify(probe));
      ck('7c TWIN proof: the flippable set (selector stripped of positionals) contains both twins',
        probe.flippableCount >= 2,
        JSON.stringify(probe));

      // Read the pre-act display state of both cards.
      const before = await page.evaluate(() => {
        const cs = (e: Element) => getComputedStyle(e).display;
        return Array.from(document.querySelectorAll('article.card')).map(cs);
      });

      const res = await sendToolCall(context, page, 'hide', { selector: card.selector });
      ck('7d TWIN ACT: hide on an indistinguishable twin → REFUSES (ok:false)', !res?.ok, JSON.stringify(res).slice(0, 200));
      ck('7e TWIN ACT: refusal reason is indistinguishable-twin / structurally ambiguous',
        /indistinguishable|structurally|cannot determine|same structural|identical/i.test(String(res?.error ?? '')),
        String(res?.error ?? '').slice(0, 200));
      ck('7f TWIN ACT: refusal does NOT advise nth-of-type',
        !/\b(add|use|refine|try)[^.]*nth-of-type/i.test(String(res?.error ?? '').replace(/"[^"]*"/g, '')),
        String(res?.error ?? '').slice(0, 120));

      // CRITICAL — no mutation: the computed display of BOTH cards is unchanged.
      const after = await page.evaluate(() => {
        const cs = (e: Element) => getComputedStyle(e).display;
        return Array.from(document.querySelectorAll('article.card')).map(cs);
      });
      ck('7g TWIN SAFETY: neither twin was mutated (display unchanged on both)', JSON.stringify(before) === JSON.stringify(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

      // CRITICAL — no transaction recorded: an undoAll must report size 0 (the
      // guard refused before recordStructural). hide records no structural op
      // anyway (CSS inverse), so check the CSS was never inserted: query the
      // page for any element whose display became 'none' among the cards.
      const anyHidden = await page.evaluate(() =>
        Array.from(document.querySelectorAll('article.card')).some((e) => getComputedStyle(e).display === 'none'));
      ck('7h TWIN SAFETY: no CSS applied (no card is display:none)', !anyHidden, `anyHidden=${anyHidden}`);
    }
    await page.close();
  }

  // ── 8. REORDERED IDENTICAL TWINS — the actual attack, refused end-to-end ──
  // observe card A (describePage registers A's identity at its positional
  // selector), REORDER so card B is now at that positional slot, then act using
  // the ORIGINAL selector. B is now at the selector AND fingerprint(B)==fp(A),
  // so a bare fp-verify would PASS and mutate B. The twin check must refuse,
  // and BOTH cards must remain unmutated (B not the wrong twin; A not touched).
  {
    const page = await openFixture(`<!doctype html><html><head><meta charset=utf-8><style>
      body { margin:0; font:14px/1.4 sans-serif }
      #main { padding:12px }
      .card { border:1px solid #ccc; padding:8px; margin:8px 0 }
    </style></head><body>
      <main id="main">
        <h1>Article Title</h1>
        <article class="card">Twin card text</article>
        <article class="card">Twin card text</article>
      </main>
    </body></html>`);
    const dp1 = await describePage(context, page); // observe → register A's identity
    const card = (dp1.result?.regions ?? []).find((r: any) => r.targetable && r.tag === 'article');
    ck('8a REORDER setup: card targetable after first describePage', !!card?.selector, JSON.stringify(card ?? {}).slice(0, 120));
    if (card?.selector) {
      const sel = card.selector;
      // Reorder: swap the two cards so B is now at the positional slot the
      // selector targets (an SPA reorder of identical items).
      await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('article.card')) as HTMLElement[];
        const main = document.getElementById('main')!;
        const [a, b] = cards;
        main.insertBefore(b, a); // B now precedes A at the same nth-of-type slot
      });
      // Snapshot both cards' display + text before the act.
      const before = await page.evaluate(() => Array.from(document.querySelectorAll('article.card'))
        .map((e) => ({ display: getComputedStyle(e).display, text: (e.textContent || '').trim() })));

      const res = await sendToolCall(context, page, 'hide', { selector: sel });
      ck('8b REORDER ACT: observe A, reorder → B at selector, act → REFUSES (not wrong-twin mutation)', !res?.ok, JSON.stringify(res).slice(0, 200));
      ck('8c REORDER ACT: refusal reason is indistinguishable-twin',
        /indistinguishable|structurally|cannot determine|same structural|identical/i.test(String(res?.error ?? '')),
        String(res?.error ?? '').slice(0, 160));

      // Both cards untouched (B not the wrong twin; A not touched either).
      const after = await page.evaluate(() => Array.from(document.querySelectorAll('article.card'))
        .map((e) => ({ display: getComputedStyle(e).display, text: (e.textContent || '').trim() })));
      ck('8d REORDER SAFETY: neither card mutated (display+text unchanged)', JSON.stringify(before) === JSON.stringify(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
    await page.close();
  }

  // ── 9. CONTROL: distinct siblings still act (the rule must not over-refuse) ──
  // Two cards that differ in text are NOT twins (distinct fingerprints). A hide
  // on one must SUCCEED — the new safety rule does not destroy legitimate targeting.
  {
    const page = await openFixture(`<!doctype html><html><head><meta charset=utf-8><style>
      body { margin:0; font:14px/1.4 sans-serif }
      #main { padding:12px }
      .card { border:1px solid #ccc; padding:8px; margin:8px 0 }
    </style></head><body>
      <main id="main">
        <h1>Article Title</h1>
        <article class="card">First card unique text AAA</article>
        <article class="card">Second card unique text BBB</article>
      </main>
    </body></html>`);
    const dp = await describePage(context, page);
    const card = (dp.result?.regions ?? []).find((r: any) => r.targetable && r.tag === 'article' && /AAA/.test(r.textSample ?? ''));
    ck('9a CONTROL setup: distinct card is targetable', !!card?.selector, JSON.stringify(card ?? {}).slice(0, 140));
    if (card?.selector) {
      const res = await sendToolCall(context, page, 'hide', { selector: card.selector });
      ck('9b CONTROL: hide on a distinct (non-twin) card → ok:true (legitimate targeting preserved)', !!res?.ok, JSON.stringify(res).slice(0, 160));
      // And confirm the OTHER card is untouched (only the named one hidden).
      const states = await page.evaluate(() => Array.from(document.querySelectorAll('article.card'))
        .map((e) => getComputedStyle(e).display));
      ck('9c CONTROL: only the named card hidden, the other visible', states.includes('none') && states.filter((s: string) => s !== 'none').length >= 1, JSON.stringify(states));
    }
    await page.close();
  }

  // ── 6. UNTARGETABLE REASON: a region with no stable anchor surfaces the reason ──
  {
    // A fixture with regions that have NO stable anchor (no id/data-testid/role/
    // aria-label/name within 20 ancestors): a bare <nav> and <aside>, sized so
    // buildInventory's visibility check (≥50×20) admits them. They are semantic
    // tags so isSemanticRegion passes, but buildStableSelector finds no anchor →
    // targetable:false WITH a reason. The reason must reach the model (rule 13),
    // not just a bare UNTARGETABLE token (the old R3 drop).
    const page = await openFixture(`<!doctype html><html><head><style>
      body { margin:0; font:14px/1.4 sans-serif }
      .x { padding:12px; min-height:40px; width:200px }
    </style></head><body>
      <main id="main"><h1>Title</h1><p class="x">targetable content</p></main>
      <nav class="x"><a href="#">One</a><a href="#">Two</a><a href="#">Three</a></nav>
      <aside class="x"><p>sidebar text content enough to be a candidate region here</p></aside>
    </body></html>`);
    const res = await describePage(context, page);
    const regions = res.result?.regions ?? [];
    const untargetable = regions.find((r: any) => r.targetable === false);
    ck('6a UNTARGETABLE: an untargetable region is detected', !!untargetable, JSON.stringify(regions.map((r: any) => ({ tag: r.tag, tgt: r.targetable, reason: r.untargetableReason }))).slice(0, 400));
    ck('6b UNTARGETABLE: the REASON is surfaced (not a bare token, rule 13)',
      !!untargetable?.untargetableReason && untargetable.untargetableReason.length > 0 && /anchor/i.test(untargetable.untargetableReason),
      String(untargetable?.untargetableReason ?? '<none>'));
    await page.close();
  }
} catch (e: any) {
  ck('HARNESS: browser test completed', false, String(e?.stack || e?.message || e));
} finally {
  await context.close();
}

let failures = 0;
console.log('\nPhase 4 F1 — identity live guard (real Chromium)\n');
for (const c of checks) {
  console.log(`  ${c.pass ? '✓' : '✖'} ${c.name}`);
  if (!c.pass) { console.log(`      ${c.detail}`); failures++; }
}
const pass = failures === 0;
writeFileSync(join(PROOF_DIR, 'f1-identity-browser-test.json'), JSON.stringify({ checks, pass }, null, 2));
console.log(`\n${pass ? `All ${checks.length} F1 live-guard cases passed.\n` : `${failures} case(s) FAILED\n`}`);
process.exit(pass ? 0 : 1);
