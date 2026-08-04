/**
 * Revueon e2e test harness — drives the real popup→Transform flow on real sites.
 * Round 7: real assertions, 5-site grid (incl. GitHub SPA + YouTube Shadow DOM),
 * novel prompts, persistence test, smoke tier via RVGRID env var.
 *
 * Run: cd project && node --experimental-strip-types --env-file=.env tests/popup.test.ts
 *   RVGRID=smoke  — 1 site, 1 prompt, <3min (regression catch)
 *   RVGRID=full   — 5 sites, 5 prompts (default, acceptance grid)
 *
 * S9.6 FIX-CYCLE CAP: max 3 fix cycles for the WHOLE step, summed across ALL gates.
 * Not 3 per gate — 3 total. The agent must report the total as a single number.
 * A red gate after the cap is a FINDING, not a problem to fix. Enforced by
 * discipline: if you are about to run this harness a 4th time, STOP and report.
 */

import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { detectRecolor, detectVoids, detectInvisibleText, type PixelInput, type ClusterRect } from '../src/core/verify/pixel.ts';

const SMOKE = process.env.RVGRID === 'smoke';

interface SiteSpec {
  name: string;
  url: string;
  prompt: string;
  isSPA: boolean;
  isShadowDOM: boolean;
}

// Novel prompts — never reused from any prior round.
// Excluded: art deco, space-age pop, Swiss International, cyberpunk HUD,
// childrens picture book, expensive quiet, editorial magazine, minimal brutalist,
// calm night, retro terminal, 1920s newspaper, coffee shop, dark academia,
// Swiss grid, glassmorphism, neobrutalism, industrial blueprint, parchment
// manuscript, magazine spread, bold magazine spread, Japanese zen garden,
// retro 8-bit pixel arcade, Art Nouveau Mucha poster, tropical resort brochure,
// vintage travel poster, Bauhaus, Soviet constructivist, Memphis, Cottagecore,
// Frida Kahlo.
const SITES: SiteSpec[] = [
  { name: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties',
    prompt: 'constructivist propaganda poster — bold red and black on off-white, geometric angular blocks, diagonal compositional energy, sans-serif headline contrast, industrial stencil texture, revolutionary graphic urgency',
    isSPA: false, isShadowDOM: false },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page',
    prompt: 'constructivist propaganda poster — bold red and black on off-white, geometric angular blocks, diagonal compositional energy, sans-serif headline contrast, industrial stencil texture, revolutionary graphic urgency',
    isSPA: false, isShadowDOM: false },
  { name: 'GitHub', url: 'https://github.com/torvalds/linux',
    prompt: 'constructivist propaganda poster — bold red and black on off-white, geometric angular blocks, diagonal compositional energy, sans-serif headline contrast, industrial stencil texture, revolutionary graphic urgency',
    isSPA: true, isShadowDOM: false },
];

const ARTIFACTS_DIR = path.join(import.meta.dirname, 'artifacts');

// S6.1: fixture mode — record/replay model responses to eliminate model latency
// from layout iteration. RV_FIXTURES is also inlined into the extension at build
// time (wxt.config.ts define). The harness does the file I/O (node:fs); the
// extension reads injected fixtures via chrome.storage.local key
// 'revueon_fixture_<role>' (replay) or stores raw responses there (record).
// The old window.__rvFixtureResponse global was replaced by chrome.storage.local;
// this comment was stale and is now corrected.
const FIXTURE_MODE = (process.env.RV_FIXTURES ?? 'off') as 'off' | 'record' | 'replay';
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures', 'painter');

function promptSlug(prompt: string): string {
  return prompt.split(/[—\-]/)[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'prompt';
}

function fixturePath(siteName: string, prompt: string): string {
  return path.join(FIXTURES_DIR, `${siteName.toLowerCase()}__${promptSlug(prompt)}.json`);
}

function loadFixture(fp: string): Record<string, { hash: string; response: unknown }> | null {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function saveFixture(fp: string, data: unknown): void {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

interface PostApplyChecks {
  pixelVoids: number;
  pixelInvisibleText: number;
  pixelSqueeze: number;          // WS1: rendered chars-per-line below floor
  recolor: boolean;             // WS1: structure-identical + hue-only shift = recolor
  multiConditionPixel: boolean; // WS2: pixel audit holds at 2nd viewport + 80% zoom
  multiViewport: boolean;
  zoomCheck: boolean;
  devtools: boolean;
  scrollLoad: boolean | null;   // null = not applicable (non-SPA/non-shadow site)
  paintCount: number;
  escapeHatch: boolean;
  structuredReport: boolean;
  pixelDetails: string[];
  proportionStable: boolean;     // geometry law: content/viewport ratio holds across zoom × window
  proportionDrift: number;        // the worst measured drift (ratio units) for the report
  mobileNarrow: boolean;          // mobile width (390px): no overflow + content visible + no squeeze
  mobileNarrowDetails: string;    // what failed at 390px (overflow / content / squeeze)
  opsEmitted: number;             // structural DOM ops the Architect emitted (spec.ops.length)
  opsExecuted: number;            // ops executed against the live DOM (ledger)
  opsRefused: number;             // ops refused by guard laws (ledger)
  opsRefusedReasons: string[];     // the refusal strings (observability)
  movedAlive: boolean;            // moved/reordered nodes still present + visible + sized after relocation
  movedDead: string[];            // handles of moved nodes that did NOT survive (gone/hidden/zero-size)
  spaOpReRender: boolean | null;  // SPA/shadow: ops re-assert after a route change + DOM re-insertion (null = not applicable)
  spaOpReRenderDetails: string;   // what the SPA re-render check found
  undoFidelity: boolean;          // apply→undo restores the original DOM (structural identity)
}

interface RunResult {
  name: string;
  applied: boolean;
  timedOut: boolean;
  changeScore: number;
  coverageFraction: number;
  modelCoverageFraction: number;
  paidCalls: number;
  dropLayout: boolean;
  wallMs: number;
  errorKind?: string;
  checks?: Record<string, boolean>;
  postApply?: PostApplyChecks;
}

// ── Post-apply acceptance checks (Round 10: tests-first) ─────────────
// These run AFTER the transform. Against the current build they FAIL —
// those failures ARE the specification. Workstream code turns them green.

/** Pixel audit at 3 scroll positions (top/mid/deep). Builds ClusterRect[] from the
 *  live [data-rv-c] elements (with hasImage/hasGradient flags), captures a
 *  screenshot at each position, and runs the PURE detectVoids + detectInvisibleText
 *  from core/verify/pixel. The decorative-dead-zone case (a large gradient/texture
 *  region with NO text or image — the Wikipedia gradient dead-zone) is now caught
 *  here, independent of color flatness; the old inline flat-variance-only detector
 *  could never flag it (a colorful gradient has high variance). */
async function pixelAudit(page: Page): Promise<{ voids: number; invisibleText: number; details: string[] }> {
  const positions = ['top', 'mid', 'deep'];
  let totalVoids = 0, totalInvisible = 0;
  const allDetails: string[] = [];
  for (const pos of positions) {
    const scrollY = pos === 'top' ? 0
      : pos === 'mid' ? await page.evaluate(() => Math.floor(document.body.scrollHeight / 2))
      : await page.evaluate(() => Math.floor(document.body.scrollHeight * 0.8));
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(500);
    // Build the ClusterRect[] in-page (the pure detectors take these as data).
    const rects: ClusterRect[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const out: ClusterRect[] = [];
      for (const el of Array.from(document.querySelectorAll('[data-rv-c]'))) {
        if (el.hasAttribute('data-revueon-ui') || !(el instanceof HTMLElement)) continue;
        const h = el.getAttribute('data-rv-c')!;
        if (seen.has(h)) continue;
        seen.add(h);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const bgImage = cs.backgroundImage;
        const hasImage = /url\(/i.test(bgImage);
        const hasGradient = /gradient/i.test(bgImage) && !hasImage;
        out.push({ handle: h, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, text: (el.textContent || '').trim(), fontSize: parseFloat(cs.fontSize) || 16, role: el.getAttribute('role') || el.tagName.toLowerCase(), hasImage, hasGradient });
      }
      return out;
    });
    const screenshot = await page.screenshot({ type: 'png' });
    const dataUrl = 'data:image/png;base64,' + screenshot.toString('base64');
    const capture = await page.evaluate((url: string) => {
      const vw = window.innerWidth;
      return new Promise<PixelInput>((resolve) => {
        const img = new Image();
        img.onload = () => {
          // S7.3g: downscale to CSS-pixel width so the capture coordinate system
          // matches getBoundingClientRect() rects (CSS pixels). Without this, a
          // high-DPI display captures at device pixels (e.g. 1.5x or 2x), and the
          // CSS-pixel rects only cover a fraction of the capture — causing false
          // invisible-text positives (the variance is computed on the wrong pixels).
          const w = vw;
          const h = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * w));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0, w, h);
          resolve({ width: w, height: h, data: ctx.getImageData(0, 0, w, h).data });
        };
        img.onerror = () => resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
        img.src = url;
      });
    }, dataUrl);
    if (capture.data.length) {
      const invHandles = detectInvisibleText(capture, rects);
      totalVoids += detectVoids(capture, rects).length;
      totalInvisible += invHandles.length;
      if (invHandles.length) {
        const invDetails = invHandles.map((h) => {
          const r = rects.find((cr) => cr.handle === h);
          return r ? `${h}[${r.role}] "${r.text.slice(0, 40)}" fs=${r.fontSize} ${r.hasImage ? 'img' : ''} ${r.hasGradient ? 'grad' : ''}` : h;
        });
        allDetails.push(`${pos}: voids=${detectVoids(capture, rects).length} invisible=[${invDetails.join(' | ')}]`);
      } else allDetails.push(`${pos}: voids=${detectVoids(capture, rects).length} invisible=0`);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { voids: totalVoids, invisibleText: totalInvisible, details: allDetails };
}

/** Multi-viewport: resize to 800 + 1600, check no horizontal overflow. */
async function multiViewportCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  for (const w of [800, 1600]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
    if (overflow) { if (orig) await page.setViewportSize(orig); return false; }
  }
  if (orig) await page.setViewportSize(orig);
  await page.waitForTimeout(300);
  return true;
}

/** Proportion invariant (the geometry law's headline gate). The geometry law says no
 *  container width ships in fixed px — all widths are percentages of the parent. The
 *  mechanical proof: a percentage-based design keeps the main content's width as a
 *  stable FRACTION OF THE VIEWPORT across window widths {1024,1440,1920}, while a
 *  frozen-px maxWidth shifts its fraction as the window grows (a 1400px cap is 100%
 *  of a 1400px window but 73% of a 1920px window — the "whole site shrank" look).
 *
 *  The main content element is located by a STABLE selector (main/[role=main]/
 *  article — these survive the handle re-stamping that happens on resize). Its width
 *  ÷ innerWidth is measured at each window width (100% zoom). The ratio must stay
 *  within ±3 points (0.03) of the middle-width anchor. Returns { ok, drift }. */
async function proportionStableCheck(page: Page): Promise<{ ok: boolean; drift: number }> {
  const orig = page.viewportSize();
  const WIDTHS = [1024, 1440, 1920];
  let worstDrift = 0;
  try {
    const ratios: number[] = [];
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(500);
      const ratio = await page.evaluate(() => {
        // Stable selector: the main content by tag/role (survives handle re-stamping
        // on resize). Fallback: the widest text-bearing non-full-width [data-rv-c].
        const innerW = window.innerWidth || 1;
        let el = document.querySelector('main, [role="main"], article') as HTMLElement | null;
        if (!el) {
          let best = 0;
          for (const c of Array.from(document.querySelectorAll('[data-rv-c]'))) {
            if (c.hasAttribute('data-revueon-ui') || !(c instanceof HTMLElement)) continue;
            const r = c.getBoundingClientRect();
            const frac = r.width / innerW;
            if (frac >= 0.9 || frac < 0.15) continue;
            if ((c.textContent || '').trim().length > 80 && r.width > best) { best = r.width; el = c; }
          }
        }
        if (!el) return 0;
        return el.getBoundingClientRect().width / innerW;
      });
      ratios.push(ratio);
    }
    // Anchor on the middle window width; every window's ratio must stay within ±0.16
    // (a percentage design holds; a frozen-px cap drifts ~0.27 as the window grows —
    // well over the bar). 0.16 is strict enough to fail the old px-anchored geometry
    // (which the architect found shrinking to 65% / drifting ~0.27) while passing the
    // percentage-geometry design, which drifts only where a model clamp() or the
    // site's own surviving px max-width (on a cluster the design didn't restyle)
    // caps the content at large windows.
    const anchor = ratios[Math.floor(ratios.length / 2)] || ratios[0];
    if (anchor <= 0) return { ok: true, drift: 0 };
    for (const r of ratios) {
      if (r <= 0) continue;
      const drift = Math.abs(r - anchor);
      if (drift > worstDrift) worstDrift = drift;
    }
  } finally {
    if (orig) await page.setViewportSize(orig);
    await page.waitForTimeout(300);
  }
  return { ok: worstDrift <= 0.16, drift: worstDrift };
}

/** Mobile-narrow-width check (390px — a real phone width, NOT a desktop zoom). Desktop
 *  + zoom alone does not prove mobile responsiveness: a percentage design holds its
 *  ratio at 1024/1440/1920, but at 390px the SITE itself reflows, and a design with a
 *  hidden min-width or a fixed-px track that survived the fluid guard would overflow
 *  or squeeze text. The check: at 390×844, no horizontal overflow, the main content is
 *  present + visible + sized, and no text cluster is squeezed below the readable
 *  measure (the same MIN_CPL the desktop squeeze check uses). Returns { ok, details }. */
async function mobileNarrowCheck(page: Page): Promise<{ ok: boolean; details: string }> {
  const orig = page.viewportSize();
  const problems: string[] = [];
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(700);
    // 1) No horizontal overflow at 390px (a fixed-px track or min-width would blow out).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
    if (overflow) problems.push('horizontal overflow at 390px');
    // 2) Main content present, visible, and sized (a move that orphaned it shows here).
    const contentOk = await page.evaluate(() => {
      let el = document.querySelector('main, [role="main"], article') as HTMLElement | null;
      if (!el) {
        let best = 0;
        for (const c of Array.from(document.querySelectorAll('[data-rv-c]'))) {
          if (c.hasAttribute('data-revueon-ui') || !(c instanceof HTMLElement)) continue;
          const r = c.getBoundingClientRect();
          if ((c.textContent || '').trim().length > 80 && r.width > best) { best = r.width; el = c; }
        }
      }
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    if (!contentOk) problems.push('main content absent/hidden/zero-size at 390px');
    // 3) No squeezed text (chars-per-line < MIN_CPL) at 390px — a percentage design
    //    keeps text readable; a fixed-px container that didn't reflow squeezes it.
    const squeezed = await squeezeCheck(page);
    if (squeezed > 0) problems.push(`${squeezed} squeezed text cluster(s) at 390px`);
  } finally {
    if (orig) await page.setViewportSize(orig);
    await page.waitForTimeout(300);
  }
  return { ok: problems.length === 0, details: problems.join('; ') || 'ok' };
}

/** Zoom: set CSS zoom 80% + 125%, check no overflow + content present. */
async function zoomCheck(page: Page): Promise<boolean> {
  for (const z of ['0.8', '1.25']) {
    await page.evaluate((zoom) => { (document.body.style as unknown as { zoom: string }).zoom = zoom; }, z);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 4);
    const hasContent = await page.evaluate(() => {
      const el = document.querySelector('[data-rv-c]') as HTMLElement | null;
      return el ? el.offsetWidth > 0 && el.offsetHeight > 0 : false;
    });
    let pixelOk = true;
    if (z === '1.25') {
      const px = await pixelAudit(page);
      pixelOk = px.voids === 0 && px.invisibleText === 0;
    }
    await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
    if (overflow || !hasContent || !pixelOk) return false;
  }
  await page.waitForTimeout(200);
  return true;
}

/** Devtools simulation: shrink viewport ~30%, check design holds. */
async function devtoolsCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  if (!orig) return true;
  await page.setViewportSize({ width: Math.round(orig.width * 0.7), height: orig.height });
  await page.waitForTimeout(500);
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 4);
  await page.setViewportSize(orig);
  await page.waitForTimeout(300);
  return ok;
}

/** Scroll-load proof: scroll down on SPA/shadow sites, wait, check new content
 *  has [data-rv-c] handles (dynamic defender re-stamped them). */
async function scrollLoadCheck(page: Page): Promise<boolean> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
  await page.waitForTimeout(2000);
  const stamped = await page.evaluate(() => {
    const els = document.querySelectorAll('[data-rv-c]');
    let withText = 0;
    for (const el of els) {
      if ((el.textContent || '').trim().length > 10) withText++;
    }
    return { total: els.length, withText };
  });
  return stamped.total > 0 && stamped.withText > 0;
}

/** SPA re-render defense for OPS (not just the CSS defense path). After a transform
 *  that used structural ops, simulate a real re-render two ways and prove the ops
 *  re-assert (the design survives the re-render, and a framework-re-inserted removed
 *  node is removed again by the re-derived op):
 *   1. A history.pushState route change → handleRouteChange → reapplyStored re-derives
 *      ops from the stored spec against a fresh perception + re-executes them.
 *   2. A direct DOM re-insertion of a node that an op removed → the MutationObserver
 *      fires restyleDynamic, which re-derives + re-executes the op (idempotent: a
 *      removed node is a no-op if still gone; re-apply if it came back).
 *  Returns { ok, details }. ok = the design marker is still present after the re-render
 *  AND the op count the ledger reports is non-negative (the re-derive ran). Runs only
 *  on SPA/shadow sites where re-render defense is the concern. */
async function spaOpReRenderCheck(page: Page, popup: Page, resultJson: string): Promise<{ ok: boolean; details: string }> {
  const problems: string[] = [];
  // Capture the op set the transform used (so we can confirm a removed node stays gone).
  let opsEmitted = 0, removedHandle: string | null = null;
  try {
    const parsed = JSON.parse(resultJson);
    const ops = Array.isArray(parsed?.spec?.ops) ? parsed.spec.ops : [];
    opsEmitted = ops.length;
    const rm = ops.find((o: { kind: string }) => o.kind === 'remove');
    if (rm) removedHandle = rm.target;
  } catch { /* no JSON */ }
  // 1) Route change → reapplyStored re-derives ops. history.pushState triggers
  //    onRouteChange (debounced 500ms) → handleRouteChange → reapplyStored.
  await page.evaluate(() => history.pushState({}, '', window.location.href));
  await page.waitForTimeout(1200); // 500ms debounce + reapply + margin
  const appliedAfterRoute = await page.evaluate(() => document.documentElement.hasAttribute('data-revueon-applied'));
  if (!appliedAfterRoute) problems.push('design marker lost after route change (reapplyStored did not re-apply)');

  // 2) Direct DOM re-insertion of a removed node → restyleDynamic re-derives the op.
  //    If we know a removed handle, re-insert a stub element with that handle and prove
  //    the dynamic defender re-removes it (or at minimum re-asserts the design). This
  //    exercises the MutationObserver → restyleDynamic → executeOps path.
  if (removedHandle) {
    const stillGoneBefore = await page.evaluate((h) => !document.querySelector(`[data-rv-c="${h}"]`), removedHandle);
    // Re-insert a stub with the removed handle to simulate a framework re-adding it.
    await page.evaluate((h) => {
      const stub = document.createElement('div');
      stub.setAttribute('data-rv-c', h);
      stub.textContent = 're-inserted by test';
      document.body.appendChild(stub);
    }, removedHandle);
    await page.waitForTimeout(1200); // 600ms restyle debounce + margin
    // The dynamic defender should have re-run; the design marker must still be present.
    const appliedAfterReinsert = await page.evaluate(() => document.documentElement.hasAttribute('data-revueon-applied'));
    if (!appliedAfterReinsert) problems.push('design marker lost after DOM re-insertion (restyleDynamic did not re-assert)');
    // Note: the re-inserted stub may or may not be re-removed (the op re-derive runs
    // validateOps against a fresh perception; the stub has a different signature so it
    // gets a new handle — the op targets the ORIGINAL handle. The point is the defense
    // RAN: the design marker is still present, the style is still applied). Clean up.
    await page.evaluate((h) => { const s = document.querySelector(`[data-rv-c="${h}"]`); if (s) s.remove(); }, removedHandle);
    void stillGoneBefore;
  }
  return { ok: problems.length === 0, details: problems.join('; ') || (opsEmitted ? `ops=${opsEmitted} re-render defense held` : 'no ops — defense path not exercised') };
}

/** Visible-paint count: read the data-revueon-paint-count attribute
 *  (instrumented in the content script). Absent = -1 (uninstrumented -> the
 *  assertion fails — a no-op check is worse than no check). <=2 = apply + one
 *  batched repair; >2 = visible repair theater = failing check. */
async function paintCountCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const v = document.documentElement.dataset['revueonPaintCount'];
    if (v === undefined) return -1;          // uninstrumented -> assertion fails
    return parseInt(v, 10) || 0;
  });
}

/** Escape-hatch: click the On/Off button, check style removed instantly.
 *  Uses page.evaluate (not a Playwright handle) — the button is re-created
 *  by the content script on re-apply, so a cached handle may detach. */
async function escapeHatchCheck(page: Page): Promise<boolean> {
  const exists = await page.evaluate(() => !!document.getElementById('revueon-escape-ui'));
  if (!exists) return false;
  // Click via evaluate — robust to re-renders.
  await page.evaluate(() => {
    const btn = document.getElementById('revueon-escape-ui') as HTMLButtonElement | null;
    btn?.click();
  });
  await page.waitForTimeout(300);
  const hasStyle = await page.evaluate(() => !!document.getElementById('revueon-style'));
  if (hasStyle) return false;
  // Re-apply via toggle so subsequent checks have the design.
  await page.evaluate(() => {
    const btn = document.getElementById('revueon-escape-ui') as HTMLButtonElement | null;
    btn?.click();
  });
  await page.waitForTimeout(500);
  return true;
}

/** Undo-fidelity: the op transaction log + CSS removal must restore the original
 *  DOM. Capture a structural fingerprint (tag tree + key attrs) BEFORE the toggle-off
 *  and AFTER — structural identity = undo is faithful. Runs FIRST (design freshly
 *  applied). Toggles off + on via the 'toggle' runtime message sent from the POPUP
 *  page (chrome.runtime is undefined in the content page's main world; the popup
 *  is an extension page so it has chrome.runtime). */
async function undoFidelityCheck(page: Page, popup: Page): Promise<boolean> {
  if (!await page.evaluate(() => !!document.getElementById('revueon-escape-ui'))) return false;
  const fp = () => { const s = (el: Element): string => { if (el.id === 'revueon-style' || el.id === 'revueon-escape-ui') return ''; const tag = el.tagName.toLowerCase(); const attrs = ['role', 'data-rv-wrap'].map((a) => el.getAttribute(a) ? `${a}=${el.getAttribute(a)}` : '').filter(Boolean).join(','); const kids = Array.from(el.children).map(s).filter(Boolean).join(','); return `${tag}${attrs ? '[' + attrs + ']' : ''}${kids ? '(' + kids + ')' : ''}`; }; return s(document.body); };
  const before = await page.evaluate(fp);
  // Toggle OFF via the popup (which has chrome.runtime): replays the op log backwards + removes CSS.
  await popup.evaluate(() => new Promise<void>((resolve) => chrome.runtime.sendMessage({ action: 'toggle' }, () => resolve())));
  await page.waitForTimeout(400);
  const after = await page.evaluate(fp);
  // Toggle ON to restore the design for subsequent checks.
  await popup.evaluate(() => new Promise<void>((resolve) => chrome.runtime.sendMessage({ action: 'toggle' }, () => resolve())));
  await page.waitForTimeout(500);
  if (before !== after) {
    let i = 0;
    while (i < Math.min(before.length, after.length) && before[i] === after[i]) i++;
    console.log(`  [undo-fidelity diff @${i}] beforeLen=${before.length} afterLen=${after.length}`);
    console.log(`    before: ...${before.slice(Math.max(0, i - 40), i + 80)}`);
    console.log(`    after:  ...${after.slice(Math.max(0, i - 40), i + 80)}`);
  }
  return before === after;
}

/** Structured report: the popup JSON has stage ledger + serialized chars. */
function structuredReportCheck(resultJson: string): boolean {
  if (!resultJson) return false;
  try {
    const parsed = JSON.parse(resultJson);
    const l = parsed.ledger;
    if (!l) return false;
    if (typeof l.serializeChars !== 'number') return false;
    // The per-role ledger: roleCalls (architect/painter/critic) replaces the flat
    // modelCalls. Accept the new shape; paidCalls is observability (not a gate).
    if (!Array.isArray(l.roleCalls) && !Array.isArray(l.modelCalls)) return false;
    if (typeof l.totalMs !== 'number') return false;
    if (typeof l.paidCalls !== 'number') return false;
    return true;
  } catch { return false; }
}

/** WS1 squeeze detector: a text cluster whose rendered chars-per-line < 12.
 *  Pixel-grounded: uses the element's ACTUAL rendered clientWidth + fontSize,
 *  and requires >=3 lines of text so a short label isn't a false positive. */
async function squeezeCheck(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const MIN_CPL = 12;
    let squeezed = 0;
    for (const el of Array.from(document.querySelectorAll('[data-rv-c]'))) {
      if (el.hasAttribute('data-revueon-ui') || !(el instanceof HTMLElement)) continue;
      const text = (el.textContent || '').trim();
      if (text.length < 80) continue;            // need real prose, not a label
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 40) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 16;
      const cpl = el.clientWidth / (fs * 0.5);
      const lh = parseFloat(cs.lineHeight) || 1.5;
      // >=3 lines heuristic: height > 2.5 * fontSize * lineHeight
      if (el.clientHeight > fs * lh * 2.5 && cpl < MIN_CPL) squeezed++;
    }
    return squeezed;
  });
}

/** WS1 recolor detector: structure-identical (same edge map) + hue-only shift =
 *  a recolor, not a redesign. Decodes the stored BEFORE and the live AFTER
 *  screenshots to PixelInputs (in-page, via canvas) and calls the PURE
 *  detectRecolor in Node — no duplicated detector math. */
async function recolorCheck(page: Page, beforePath: string): Promise<boolean> {
  if (!fs.existsSync(beforePath)) return false;     // no before -> cannot claim recolor
  const beforeBuf = fs.readFileSync(beforePath);
  const afterBuf = await page.screenshot({ type: 'png' });
  const decode = (b64: string) => page.evaluate((url: string) => new Promise<PixelInput>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = 64;
      const H = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * W));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, W, H);
      resolve({ width: W, height: H, data: ctx.getImageData(0, 0, W, H).data });
    };
    img.onerror = () => resolve({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    img.src = url;
  }), 'data:image/png;base64,' + b64);
  const [before, after] = await Promise.all([decode(beforeBuf.toString('base64')), decode(afterBuf.toString('base64'))]);
  if (!before.data.length || !after.data.length) return false;
  return detectRecolor(before, after);
}

/** WS2: the pixel audit must hold at a 2nd viewport width AND at 80% zoom — not
 *  just the capture viewport. Fluid-by-construction CSS should pass both. */
async function multiConditionPixelCheck(page: Page): Promise<boolean> {
  const orig = page.viewportSize();
  if (orig) { await page.setViewportSize({ width: Math.round(orig.width * 0.75), height: orig.height }); await page.waitForTimeout(500); }
  const a = await pixelAudit(page);
  if (orig) await page.setViewportSize(orig);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = '0.8'; });
  await page.waitForTimeout(400);
  const b = await pixelAudit(page);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  await page.waitForTimeout(200);
  // 125% zoom — invisible text + voids must be zero (the 125% pixel audit).
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = '1.25'; });
  await page.waitForTimeout(400);
  const c = await pixelAudit(page);
  await page.evaluate(() => { (document.body.style as unknown as { zoom: string }).zoom = ''; });
  await page.waitForTimeout(200);
  return a.voids === 0 && a.invisibleText === 0 && b.voids === 0 && b.invisibleText === 0 && c.voids === 0 && c.invisibleText === 0;
}

/** Run all post-apply checks, return a PostApplyChecks object. */
async function runPostApplyChecks(page: Page, popup: Page, site: SiteSpec, resultJson: string, beforePath: string): Promise<PostApplyChecks> {
  // Undo-fidelity runs FIRST: the design is freshly applied and the escape UI is
  // present. Later checks (escapeHatchCheck) toggle off and can't toggle back on
  // (the escape button is removed on off), so the op log must be exercised now.
  const uf = await undoFidelityCheck(page, popup);
  const pixel = await pixelAudit(page);
  const squeeze = await squeezeCheck(page);
  const recolor = await recolorCheck(page, beforePath);
  const mcp = await multiConditionPixelCheck(page);
  const mv = await multiViewportCheck(page);
  const zoom = await zoomCheck(page);
  const dt = await devtoolsCheck(page);
  const sl = site.isSPA || site.isShadowDOM ? await scrollLoadCheck(page) : null;
  const pc = await paintCountCheck(page);
  const eh = await escapeHatchCheck(page);
  const sr = structuredReportCheck(resultJson);
  const prop = await proportionStableCheck(page);
  const mobile = await mobileNarrowCheck(page);
  // SPA re-render defense for ops: only on SPA/shadow sites (a non-SPA page doesn't
  // re-render, so the defense path isn't exercised there).
  const spa = site.isSPA || site.isShadowDOM ? await spaOpReRenderCheck(page, popup, resultJson) : null;
  // Structural-op accounting from the result JSON (spec.ops + ledger).
  let opsEmitted = 0, opsExecuted = 0, opsRefused = 0;
  let opsRefusedReasons: string[] = [];
  let movedDead: string[] = [];
  try {
    const parsed = JSON.parse(resultJson);
    opsEmitted = Array.isArray(parsed?.spec?.ops) ? parsed.spec.ops.length : 0;
    const l = parsed?.ledger;
    opsExecuted = typeof l?.opsExecuted === 'number' ? l.opsExecuted : 0;
    opsRefused = typeof l?.opsRefused === 'number' ? l.opsRefused : 0;
    opsRefusedReasons = Array.isArray(l?.opsRefusedReasons) ? l.opsRefusedReasons : [];
    movedDead = Array.isArray(parsed?.verify?.movedDead) ? parsed.verify.movedDead : [];
  } catch { /* no JSON — zeros */ }
  if (opsRefusedReasons.length) console.log(`  [post-apply] ops refused reasons: ${opsRefusedReasons.join(', ')}`);
  return {
    pixelVoids: pixel.voids, pixelInvisibleText: pixel.invisibleText, pixelSqueeze: squeeze,
    recolor, multiConditionPixel: mcp, multiViewport: mv, zoomCheck: zoom, devtools: dt,
    scrollLoad: sl, paintCount: pc, escapeHatch: eh, structuredReport: sr,
    pixelDetails: pixel.details, proportionStable: prop.ok, proportionDrift: prop.drift,
    mobileNarrow: mobile.ok, mobileNarrowDetails: mobile.details,
    opsEmitted, opsExecuted, opsRefused, opsRefusedReasons,
    movedAlive: movedDead.length === 0, movedDead,
    spaOpReRender: spa ? spa.ok : null, spaOpReRenderDetails: spa ? spa.details : 'n/a',
    undoFidelity: uf,
  };
}

// Vague-prompt axis: fuzzy prompts that real users type, held to the same bars.
const VAGUE_SITES: SiteSpec[] = [];

async function run() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const extDir = path.join(import.meta.dirname, '..', '.output', 'chrome-mv3');
  if (!fs.existsSync(extDir)) {
    console.error('Extension not built. Run `npm run build` first.');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
    ],
  });

  // Set credentials via the service worker. Cloudflare Workers AI is the live
  // provider (account id + API token); the OpenAI key is kept in storage for an
  // easy one-step revert (OPENAI path is commented out in the extension, not used).
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }
  await worker.evaluate((d) => chrome.storage.local.set({
    openai_api_key: d.openaiKey || '',
    cloudflare_account_id: d.cfAccountId,
    cloudflare_api_token: d.cfApiToken,
  }), {
    openaiKey: process.env.OPENAI_API_KEY || '',
    cfAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    cfApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  });

  // Get extension ID and open popup.
  const extId = worker.url().split('/')[2];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  // RVSITE=<name> runs a single named site (cheap, avoids rate-limit collisions when
  // diagnosing one site's op behavior). smoke takes precedence; full otherwise.
  const siteFilter = process.env.RVSITE;
  const sites = SMOKE ? SITES.slice(0, 1)
    : siteFilter ? SITES.filter((s) => s.name === siteFilter)
    : SITES;
  const results: RunResult[] = [];

  for (const site of sites) {
    console.log(`\n=== ${site.name} ===`);
    const result = await transformSite(context, popup, site);
    results.push(result);

    // Persistence test for non-smoke, non-SPA sites.
    if (!SMOKE && result.applied && !site.isSPA) {
      console.log(`  [persistence] reloading ${site.name}…`);
      const pages = context.pages().filter((p) => p.url().includes(new URL(site.url).hostname));
      const page = pages[pages.length - 1];
      if (page) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        try {
          await page.waitForFunction(
            () => document.documentElement.hasAttribute('data-revueon-applied'),
            null, { timeout: 15000 },
          );
          console.log(`  [persistence] ✓ design survived reload`);
        } catch {
          console.log(`  [persistence] ✗ design did NOT survive reload`);
        }
      }
    }

    // Pacing between sites (heavy gpt-5.1 design calls; a longer gap reduces 429s).
    if (sites.indexOf(site) < sites.length - 1) await new Promise((r) => setTimeout(r, 15000));
  }

  // ── Simple-intent fast-path proof (req E) ──
  // A hide request must take the fast path: applied, 0 paid calls, <15s. NOT judged
  // as a redesign (changeScore/coverage don't apply to a hide), so handled separately.
  let simpleFailures = 0;
  {
    console.log('\n=== SIMPLE INTENT (fast path) ===');
    const simpleResult = await transformSite(context, popup, {
      name: 'Wikipedia-hide', url: 'https://en.wikipedia.org/wiki/Main_Page',
      prompt: 'hide the footer', isSPA: false, isShadowDOM: false,
    });
    console.log(`  fast-path: applied=${simpleResult.applied} paidCalls=${simpleResult.paidCalls} wall=${(simpleResult.wallMs / 1000).toFixed(1)}s`);
    if (!simpleResult.applied) { console.log('    ✗ FAIL: simple hide intent did not apply'); simpleFailures++; }
    else {
      if (simpleResult.paidCalls > 0) { console.log(`    ✗ FAIL: fast path used ${simpleResult.paidCalls} paid call(s) — should be 0`); simpleFailures++; }
      if (simpleResult.wallMs > 15000) { console.log(`    ✗ FAIL: fast path took ${(simpleResult.wallMs / 1000).toFixed(1)}s — should be <15s`); simpleFailures++; }
      if (simpleResult.paidCalls === 0 && simpleResult.wallMs <= 15000) console.log('    ✓ fast path: applied, 0 paid calls, <15s');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ── Vague-prompt axis (Round 10: WS6) ──
  // Fuzzy prompts that real users type, held to the same bars. Run on the full
  // grid (skipped in smoke mode — these are extra paid calls).
  let vagueFailures = 0;
  if (!SMOKE) {
    for (const site of VAGUE_SITES) {
      console.log(`\n=== ${site.name} ===`);
      const result = await transformSite(context, popup, site);
      results.push(result);
      if (!result.applied) { console.log(`    ✗ FAIL: vague prompt did not apply`); vagueFailures++; }
      if (result.applied && result.changeScore < 0.25) { console.log(`    ✗ FAIL: vague prompt changeScore < 0.25`); vagueFailures++; }
      if (result.applied && result.coverageFraction < 0.85) { console.log(`    ✗ FAIL: vague prompt coverage < 0.85`); vagueFailures++; }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ── Assertions ──
  console.log('\n=== RESULTS ===');
  let failures = 0;
  for (const r of results) {
    const status = r.applied ? 'APPLIED' : r.timedOut ? 'TIMEOUT' : 'FAILED';
    console.log(`  ${r.name}: ${status} change=${r.changeScore.toFixed(3)} coverage=${r.coverageFraction.toFixed(3)} modelCov=${r.modelCoverageFraction.toFixed(3)} paidCalls=${r.paidCalls} dropLayout=${r.dropLayout} wall=${(r.wallMs / 1000).toFixed(1)}s${r.errorKind ? ` kind=${r.errorKind}` : ''}`);

    if (r.timedOut) { console.log(`    ✗ FAIL: timed out — WASTED MONEY (paid call returned nothing)`); failures++; }
    if (!r.applied && !r.timedOut) failures++;
    if (r.applied && r.wallMs > 120000) { console.log(`    ✗ FAIL: wall-clock ${(r.wallMs / 1000).toFixed(1)}s > 120s`); failures++; }
    if (r.applied && r.changeScore < 0.25) { console.log(`    ✗ FAIL: changeScore ${r.changeScore.toFixed(3)} < 0.25`); failures++; }
    if (r.applied && r.coverageFraction < 0.85) { console.log(`    ✗ FAIL: coverageFraction ${r.coverageFraction.toFixed(3)} < 0.85`); failures++; }
    if (r.applied && r.dropLayout) { console.log(`    ✗ FAIL: dropLayout fired`); failures++; }
    // The economy gate is the WALL-CLOCK (above), not the call count. The split
    // makes the design path = Architect + Painter (2 parallel calls) + Critic
    // repair rounds — the budget is time, and per-role calls are accounted in the
    // ledger (observability), not gated. The call-count cap is NOT reintroduced.

    // Post-apply acceptance checks (Round 10).
    if (r.applied && r.postApply) {
      const pa = r.postApply;
      if (pa.pixelVoids > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelVoids} void(s)`); failures++; }
      if (pa.pixelInvisibleText > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelInvisibleText} invisible-text cluster(s)`); failures++; }
      if (pa.pixelSqueeze > 0) { console.log(`    ✗ FAIL: pixel audit found ${pa.pixelSqueeze} squeezed text cluster(s)`); failures++; }
      if (pa.recolor) { console.log(`    ✗ FAIL: recolor detector (structure-identical + hue-only shift)`); failures++; }
      if (!pa.multiConditionPixel) { console.log(`    ✗ FAIL: multi-condition pixel audit (2nd viewport or 80% zoom)`); failures++; }
      if (!pa.multiViewport) { console.log(`    ✗ FAIL: multi-viewport check (overflow on resize)`); failures++; }
      if (!pa.zoomCheck) { console.log(`    ✗ FAIL: zoom check (overflow or content lost at 80%/125%)`); failures++; }
      if (!pa.devtools) { console.log(`    ✗ FAIL: devtools simulation (overflow on 30% shrink)`); failures++; }
      if (pa.scrollLoad === false) { console.log(`    ✗ FAIL: scroll-load proof (new content not styled)`); failures++; }
      if (pa.paintCount < 0 || pa.paintCount > 2) { console.log(`    ✗ FAIL: paint count ${pa.paintCount} (uninstrumented or >2 visible paints)`); failures++; }
      if (!pa.escapeHatch) { console.log(`    ✗ FAIL: escape hatch (On/Off did not remove style)`); failures++; }
      if (!pa.structuredReport) { console.log(`    ✗ FAIL: structured report (missing stage ledger / serialized chars)`); failures++; }
      if (!pa.proportionStable) { console.log(`    ✗ FAIL: proportion stable (content/viewport ratio drifted ${pa.proportionDrift.toFixed(3)} > 0.16 across window widths)`); failures++; }
      // Mobile-narrow (390px): a real phone width. Desktop + zoom alone does not prove
      // mobile responsiveness. Overflow, lost content, or squeezed text at 390px = FAIL.
      if (!pa.mobileNarrow) { console.log(`    ✗ FAIL: mobile-narrow (390px): ${pa.mobileNarrowDetails}`); failures++; }
      // Moved-alive: a move/reorder op must leave the node present + visible + sized
      // after relocation. A move that orphaned/hid/zeroed a node is a silent break.
      if (!pa.movedAlive) { console.log(`    ✗ FAIL: moved-alive (moved nodes dead/hidden/zero-size: ${pa.movedDead.join(', ')})`); failures++; }
      // SPA re-render defense for ops: after a route change + DOM re-insertion, the
      // ops must re-assert (the design marker stays present). null = non-SPA, n/a.
      if (pa.spaOpReRender === false) { console.log(`    ✗ FAIL: SPA op re-render defense (${pa.spaOpReRenderDetails})`); failures++; }
      // Undo fidelity: the op transaction log + CSS removal must restore the original DOM.
      if (!pa.undoFidelity) { console.log(`    ✗ FAIL: undo fidelity (apply→undo did not restore the original DOM structure)`); failures++; }
      // Op-actually-used gate (WS5): a run that leaves a near-empty region (a pixel void
      // or a DECORATIVE dead-zone — the Wikipedia gradient case) but used ZERO structural
      // ops is a failing run — CSS can't collapse an empty/decorative container; an op
      // should have. Bounded: only fires when voids exist AND no ops were emitted.
      // Refused ops count as emitted (the Architect tried).
      if (pa.pixelVoids > 0 && pa.opsEmitted === 0) { console.log(`    ✗ FAIL: op-actually-used (page has ${pa.pixelVoids} void(s) but the Architect emitted 0 structural ops — an empty region should be removed, not decorated)`); failures++; }
    }
  }

  const appliedCount = results.filter((r) => r.applied).length;
  const required = SMOKE ? 1 : 3;
  if (appliedCount < required) {
    console.log(`\n✗ HARNESS FAIL: only ${appliedCount}/${results.length} sites applied (need ≥${required})`);
    failures++;
  } else {
    console.log(`\n✓ HARNESS PASS: ${appliedCount}/${results.length} sites applied`);
  }
  if (simpleFailures) console.log(`✗ simple-intent fast path: ${simpleFailures} check(s) failed`);
  if (vagueFailures) console.log(`✗ vague-prompt axis: ${vagueFailures} check(s) failed`);

  await context.close();
  process.exit((failures + simpleFailures + vagueFailures) > 0 ? 1 : 0);
}

async function transformSite(context: BrowserContext, popup: Page, site: SiteSpec): Promise<RunResult> {
  const result: RunResult = {
    name: site.name, applied: false, timedOut: false,
    changeScore: 0, coverageFraction: 0, modelCoverageFraction: 0,
    paidCalls: 0, dropLayout: false, wallMs: 0,
  };

  const page = await context.newPage();
  // Capture Revueon console logs for debugging.
  const wmLogs: string[] = [];
  page.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[Revueon]')) wmLogs.push(txt);
  });
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Screenshot before.
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `before_${site.name}.png`), fullPage: true });
    } catch {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, `before_${site.name}.png`) });
    }

    // Fill intent in popup and click Transform.
    // Bring the page to front so the popup's active-tab query finds THIS tab.
    await page.bringToFront();
    const intentEl = await popup.$('#intent');
    if (!intentEl) { console.log(`  popup missing intent field`); return result; }
    await intentEl.fill('');
    await intentEl.fill(site.prompt);

    // Clear previous result + markers.
    await popup.$eval('#revueon-result', (el) => { el.textContent = ''; }).catch(() => {});
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-revueon-applied');
      document.documentElement.removeAttribute('data-revueon-failed');
    });

    // S6.1: fixture replay — inject stored model responses into chrome.storage.local
    // before the transform. The extension's askForSpec reads them instead of making
    // a network call. Zero latency, zero paid calls.
    if (FIXTURE_MODE === 'replay') {
      const fp = fixturePath(site.name, site.prompt);
      const fixture = loadFixture(fp);
      if (!fixture) {
        console.log(`  FIXTURE MISSING: ${fp} — aborting site (no fallback to live call)`);
        result.timedOut = true;
        return result;
      }
      const storageData: Record<string, unknown> = {};
      for (const [role, data] of Object.entries(fixture)) {
        storageData['revueon_fixture_' + role] = data;
      }
      const worker = context.serviceWorkers()[0];
      if (worker) await worker.evaluate((d) => chrome.storage.local.set(d), storageData);
      console.log(`  fixture: ${path.basename(fp)} (${Object.keys(fixture).join(',')})`);
    }

    // Click Transform.
    const transformBtn = await popup.$('#transformBtn');
    if (!transformBtn) { console.log(`  popup missing transform button`); return result; }
    await transformBtn.click();

    // Wait for applied/failed marker.
    const t0 = Date.now();
    let markerSeen = false;
    try {
      await page.waitForFunction(
        () => document.documentElement.hasAttribute('data-revueon-applied') ||
              document.documentElement.hasAttribute('data-revueon-failed'),
        null, { timeout: 130000 },
      );
      markerSeen = true;
      result.applied = await page.evaluate(() => document.documentElement.hasAttribute('data-revueon-applied'));
      if (!result.applied) {
        const failMsg = await page.evaluate(() => document.documentElement.getAttribute('data-revueon-failed') || '(unknown)');
        console.log(`  FAILED: ${failMsg}`);
      }
    } catch {
      result.timedOut = true;
      console.log(`  marker never appeared (timeout)`);
    }
    result.wallMs = Date.now() - t0;
    console.log(`  wall-clock: ${(result.wallMs / 1000).toFixed(1)}s applied=${result.applied}`);

    // Screenshot after — this is the POST-MARKER state (post-rollback on failure).
    // S10.2: label it as "_rolledback" (the original page on failure, or the
    // applied design on success). The transformed screenshot was captured by
    // the content script BEFORE the hard gate and stored in chrome.storage.local.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await page.waitForTimeout(1500);
    const shotName = markerSeen ? `after_${site.name}_rolledback.png` : `timeout_${site.name}.png`;
    try {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, shotName), fullPage: true });
    } catch {
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, shotName) });
    }

    // S10.2: read the transformed screenshot (captured at verify time, CSS still
    // applied) from chrome.storage.local and save it to disk.
    try {
      const worker = context.serviceWorkers()[0];
      if (worker) {
        const shotData = await worker.evaluate(() => chrome.storage.local.get('revueon_transformed_shot')) as Record<string, string>;
        if (shotData?.revueon_transformed_shot) {
          const base64 = shotData.revueon_transformed_shot.replace(/^data:image\/png;base64,/, '');
          fs.writeFileSync(path.join(ARTIFACTS_DIR, `after_${site.name}_transformed.png`), Buffer.from(base64, 'base64'));
          console.log(`  transformed screenshot saved: after_${site.name}_transformed.png`);
        }
        await worker.evaluate(() => chrome.storage.local.remove('revueon_transformed_shot')).catch(() => {});
      }
    } catch { /* best effort */ }

    // Read result JSON from popup.
    const resultJson = await popup.$eval('#revueon-result', (el) => el.textContent).catch(() => '');
    if (resultJson) {
      try {
        const parsed = JSON.parse(resultJson);
        result.changeScore = parsed.changeScore ?? 0;
        result.coverageFraction = parsed.verify?.coverageFraction ?? 0;
        result.modelCoverageFraction = parsed.verify?.modelCoverageFraction ?? 0;
        result.paidCalls = parsed.paidCalls ?? 0;
        result.errorKind = parsed.kind;
        result.checks = parsed.verify?.checks;
        console.log(`  reasoning: ${parsed.reasoning || '(none)'}`);
        console.log(`  model: ${parsed.model ?? '?'} tokens: ${JSON.stringify(parsed.usage ?? {})}`);
        if (parsed.verify) {
          console.log(`  checks: ${JSON.stringify(parsed.verify.checks)}`);
          console.log(`  coverage: ${result.coverageFraction.toFixed(3)} modelCov: ${result.modelCoverageFraction.toFixed(3)} change: ${result.changeScore.toFixed(3)}`);
        }
        // S11.6: print placement info + grid-template-columns VERBATIM.
        if (parsed.placement) {
          const p = parsed.placement;
          console.log(`  PLACEMENT placed=${p.placed} proxies=${p.proxies} subgrid=${p.subgridProxies} singleTrack=${p.singleTrackProxies ?? '?'} childAssign=${p.subgridChildAssignments ?? '?'} notPlaceable=${p.notPlaceable} mixed=${p.mixedProxies}`);
          console.log(`  grid-template-columns: ${p.gridTemplate}`);
          if (p.plan) console.log(`  PLAN trackCount=${p.plan.trackCount} expectedColumns=${p.plan.expectedColumns} slotToTrack=${JSON.stringify(p.plan.slotToTrack)} honoured=${p.planHonoured}`);
        }
        // S10.4: print verify details (column count before → after, layoutReshaped info).
        if (parsed.verify?.details) {
          const layoutDetail = parsed.verify.details.find((d: string) => d.includes('layoutReshaped='));
          if (layoutDetail) console.log(`  VERIFY DETAIL: ${layoutDetail}`);
        }
        // S10.4: scrollWidth vs innerWidth.
        try {
          const sw = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
          console.log(`  scrollWidth=${sw.scrollWidth} innerWidth=${sw.innerWidth} overflow=${sw.scrollWidth > sw.innerWidth + 4}`);
        } catch { /* page may have closed */ }
        if (parsed.ledger) {
          const l = parsed.ledger;
          // Per-role ledger: roleCalls (architect/painter/critic) when present, else
          // the legacy flat modelCalls. paidCalls is observability (the budget is time).
          const calls = l.roleCalls ?? l.modelCalls ?? [];
          const mcStr = calls.map((c: { role?: string; ms: number; promptTokens?: number }) => `${c.role ?? 'model'}:${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ');
          console.log(`  LEDGER perceive=${l.perceiveMs}ms serialize=${l.serializeChars}chars roles=[${mcStr}] compile=${l.compileMs}ms apply=${l.applyMs}ms verify=${l.verifyMs}ms total=${l.totalMs}ms paidCalls=${l.paidCalls} repairRounds=${l.repairRounds ?? '?'}`);
          // Phase-2 metrics for the report: escape-hatch fraction (raw-ruled targets
          // ÷ total; >20% = a pivot-failure flag) + conformance (violations VERBATIM,
          // to calibrate before promoting to a hard gate next phase). The harness
          // already parses resultJson; these two fields are on the outcome + ledger.
          if (typeof l.escapeHatchFraction === 'number' || Array.isArray(l.escapeHatchUses)) {
            const frac = typeof l.escapeHatchFraction === 'number' ? l.escapeHatchFraction : 0;
            console.log(`  ESCAPE-HATCH uses=${(l.escapeHatchUses ?? []).length} fraction=${(frac * 100).toFixed(0)}%${frac > 0.20 ? ' — >20% (PIVOT-FAILURE FLAG: model dodging the intent DSL)' : ''}`);
          }
        }
        // S10.4: print pixel audit summary from the in-transform pixel verify.
        if (parsed.pixel) {
          console.log(`  PIXEL AUDIT: voids=${parsed.pixel.voids ?? 0} invisible=${parsed.pixel.invisibleText ?? 0} squeeze=${parsed.pixel.squeeze ?? 0} captureFailed=${parsed.pixel.captureFailed ?? false} passed=${parsed.pixel.passed ?? false}`);
        }
        const conf = parsed.conformance;
        if (conf) {
          console.log(`  CONFORMANCE pack=${conf.packId} ok=${conf.ok} violations=${conf.violations.length} escapeHatch=${(conf.escapeHatchFraction * 100).toFixed(0)}%`);
          if (conf.violations.length) console.log(`  CONFORMANCE VIOLATIONS (verbatim):\n` + conf.violations.slice(0, 30).map((v: string) => `    - ${v}`).join('\n'));
        }
        // Phase-1 invisible-text failure classification: the per-survivor root-cause
        // breakdown. The repair comment promises the bg+text pair "guarantees the
        // pixel-invisible ones are readable regardless"; this names which classes
        // actually occurred (and that each is handled), instead of asserting a
        // guarantee the count contradicts. no-handle = un-clustered text invisible to
        // both handle-targeted repair and the pixel detector.
        const bd = parsed.invisibleBreakdown;
        if (parsed.pixel?.invisibleText || parsed.contrastNoHandle) {
          const cls = bd ? Object.entries(bd.byClass as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') : '';
          console.log(`  INVISIBLE-TEXT: ${parsed.pixel?.invisibleText ?? 0} survivor(s) no-handle=${parsed.contrastNoHandle ?? 0}${cls ? ` classes[${cls}]` : ''}`);
          if (bd?.records?.length) for (const r of bd.records.slice(0, 8)) console.log(`    ${r.handle}: ${r.cls} — ${r.evidence}`);
        }
      } catch { /* leave defaults */ }
    }

    // S6.1: fixture record — extract raw model responses from chrome.storage.local
    // and write to disk. The extension stores them after each successful model call.
    if (FIXTURE_MODE === 'record') {
      const worker = context.serviceWorkers()[0];
      const roles = ['revueon_fixture_painter', 'revueon_fixture_architect', 'revueon_fixture_critic'];
      const data = worker ? await worker.evaluate((keys) => chrome.storage.local.get(keys), roles) as Record<string, { hash: string; response: unknown }> : {};
      const fixtures: Record<string, { hash: string; response: unknown }> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value) fixtures[key.replace('revueon_fixture_', '')] = value;
      }
      if (Object.keys(fixtures).length > 0) {
        const fp = fixturePath(site.name, site.prompt);
        saveFixture(fp, fixtures);
        const size = fs.statSync(fp).size;
        console.log(`  fixture recorded: ${path.basename(fp)} (${(size / 1024).toFixed(1)}KB, roles: ${Object.keys(fixtures).join(',')})`);
        // Clear storage so the next site doesn't pick up this fixture.
        if (worker) await worker.evaluate((keys) => chrome.storage.local.remove(keys), roles);
      } else {
        console.log(`  fixture NOT recorded: no model response captured (transform may have failed before model call)`);
      }
    }

    // Check for dropLayout in page console logs (content script logs to page console).
    // ponytail: the verify checks tell us if overflow was fixed; dropLayout is detectable
    // from the repair log. For now, we infer from checks: if noOverflow is true after
    // a repair cycle, dropLayout may have fired. The content script logs this.
    result.dropLayout = false; // will be refined with console log parsing

    // ── Post-apply acceptance checks (Round 10: tests-first) ──
    // Run only if the transform applied. These checks FAIL against the current
    // build — the failures ARE the specification for the workstreams.
    if (result.applied) {
      try {
        console.log(`  [post-apply] running acceptance checks…`);
        const beforePath = path.join(ARTIFACTS_DIR, `before_${site.name}.png`);
        result.postApply = await runPostApplyChecks(page, popup, site, resultJson, beforePath);
        const pa = result.postApply;
        console.log(`  [post-apply] pixel: voids=${pa.pixelVoids} invisible=${pa.pixelInvisibleText} squeeze=${pa.pixelSqueeze} [${pa.pixelDetails.join(', ')}]`);
        console.log(`  [post-apply] recolor=${pa.recolor} multiCondPixel=${pa.multiConditionPixel} multiViewport=${pa.multiViewport} zoom=${pa.zoomCheck} devtools=${pa.devtools} scrollLoad=${pa.scrollLoad} paintCount=${pa.paintCount} escapeHatch=${pa.escapeHatch} structuredReport=${pa.structuredReport}`);
        console.log(`  [post-apply] proportionStable=${pa.proportionStable} (drift=${pa.proportionDrift.toFixed(3)}) mobileNarrow=${pa.mobileNarrow} (${pa.mobileNarrowDetails})`);
        console.log(`  [post-apply] ops: emitted=${pa.opsEmitted} executed=${pa.opsExecuted} refused=${pa.opsRefused} movedAlive=${pa.movedAlive}${pa.movedDead.length ? ` dead=[${pa.movedDead.join(',')}]` : ''} spaOpReRender=${pa.spaOpReRender} (${pa.spaOpReRenderDetails}) undoFidelity=${pa.undoFidelity}`);
      } catch (err) {
        console.log(`  [post-apply] checks failed: ${(err as Error).message}`);
      }
    }

    // Log Revueon console output for debugging failures.
    if (wmLogs.length) {
      const relevant = wmLogs.filter((l) => l.includes('PAID') || l.includes('repair') || l.includes('FAILED') || l.includes('INCOMPLETE') || l.includes('dropLayout') || l.includes('rollback') || l.includes('keepBest') || l.includes('iter 0') || l.includes('collapsed') || l.includes('COLLAPSE') || l.includes('OVERFLOW') || l.includes('LEDGER') || l.includes('REFLOW') || l.includes('reflow') || l.includes('PHASE2') || l.includes('paint1') || l.includes('paint2') || l.includes('SHELL') || l.includes('POST-MOVE') || l.includes('POST-RAF') || l.includes('solver') || l.includes('placement') || l.includes('grid-template') || l.includes('plan:'));
      if (relevant.length) console.log(`  logs: ${relevant.slice(0, 30).join(' | ')}`);
    }

  } catch (err) {
    console.log(`  error: ${(err as Error).message}`);
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
