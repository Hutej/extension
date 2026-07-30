/**
 * Phase 2.5, Step 1 — Layout IR stability probe (HARD GATE, 0 paid calls).
 *
 * Do NOT build the solver until the IR is proven stable across near-identical renders. Extends the
 * Phase 0/1 probe pattern: bundles the REAL perceive + the new extractLayoutIR via esbuild, injects
 * into a Playwright page, and measures IR stability across perturbations.
 *
 * Perturbations: resize (1920/1440/1280), zoom (viewport ÷ factor — 125%→1536px, 150%→1280px which
 * coincides with the 1280 resize by definition and is reported once), SPA route change (GitHub:
 * navigate to another route, go back, re-extract), lazy-load (scroll to bottom), minor DOM mutations
 * (insert/remove/reorder — reused from the Phase 0/1 probe).
 *
 * Metrics per site per perturbation: node identity (Jaccard), parent/child, role, constraint stability
 * (reported WITH and WITHOUT `Ordering`; THE GATE reads WITHOUT-Ordering), plus per-constraint-kind
 * flip rates and per-field stability for the 5 new perception fields.
 *
 * Gates (all 5 sites): parent/child ≥ 0.90 · role ≥ 0.90 · node identity ≥ 0.85 · constraint
 * (no-Ordering) ≥ 0.85.
 *
 * PRE-AUTHORIZED BLOCKED OUTCOME: if the gate fails ONLY on resize node-identity, that is expected
 * (geometry-derived handles re-cluster) — STOP and recommend pulling Phase 5 (role-anchored stable
 * handles) ahead of the solver. Never tune clustering/thresholds/settle to green the number.
 *
 * Run:
 *   node --experimental-strip-types --env-file=.env tests/probe/layout-ir.test.ts
 *   WMGRID=smoke  (1 site)  | WMSITE=Wikipedia
 */

import { chromium, type Page } from 'playwright';
import { build } from 'esbuild';
import path from 'node:path';

const SITES = [
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page', settleMs: 2500 },
  { name: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties', settleMs: 2500 },
  { name: 'BBC', url: 'https://www.bbc.com/news', settleMs: 2500 },
  { name: 'GitHub', url: 'https://github.com/torvalds/linux', settleMs: 3000 },
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', settleMs: 6000 },
];

const SMOKE = process.env.WMGRID === 'smoke';
const SITE_FILTER = process.env.WMSITE;
const sites = SMOKE ? SITES.slice(0, 1)
  : SITE_FILTER ? SITES.filter((s) => s.name === SITE_FILTER)
  : SITES;

const BASE_W = 1920;
const BASE_H = 1080;
// Zoom = viewport width ÷ factor. 150% (1280) coincides with the 1280 resize by definition.
const RESIZE_WIDTHS = [1440, 1280];
const ZOOM_WIDTHS = [1536];        // 125% only; 150% (1280) is shared with resize-1280

async function buildBundle(): Promise<string> {
  const entry = path.join(import.meta.dirname, 'perceive-entry.ts');
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser',
    target: 'es2020', write: false, minify: false, logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// ── One IR run: a plain serializable projection of the frozen LayoutIR + currentConstraints ──

export interface IRNodeShape {
  handle: string;
  role: string;
  parent: string | null;
  ordering: number;
  position: string;
  flexWrap: boolean;
  alignment: string;
  widthSizing: string;
  centered: boolean;
  widthRatio: number;
  sig: string;            // constraint signature WITH Ordering
  sigNoOrder: string;     // constraint signature WITHOUT Ordering (the gate number)
  kindTokens: Record<string, string>;  // kind -> "priority:value" (or 'none' when absent)
}
export interface IRShape {
  clusterCount: number;
  nodes: IRNodeShape[];
}

const KINDS = ['FillParent', 'Centered', 'StackVertically', 'WrapOnOverflow', 'MaxWidth', 'AspectRatio', 'Gap', 'Alignment', 'Ordering'] as const;

async function runIR(page: Page, bundle: string): Promise<IRShape> {
  return await page.evaluate(async (src: string): Promise<IRShape> => {
    new Function(src)();
    const perceive = (window as unknown as { __wmPerceive: () => unknown }).__wmPerceive;
    const clearHandles = (window as unknown as { __wmClearHandles: () => void }).__wmClearHandles;
    const extractIR = (window as unknown as { __wmExtractLayoutIR: (p: unknown) => any }).__wmExtractLayoutIR;
    const curCons = (window as unknown as { __wmCurrentConstraints: (n: any) => any[] }).__wmCurrentConstraints;
    clearHandles();
    const p = perceive();
    const ir = extractIR(p) as { nodes: any[]; byHandle: Map<string, any> };
    const byHandle = ir.byHandle as Map<string, any>;
    const nodes: IRNodeShape[] = ir.nodes.map((n) => {
      const cs = curCons(byHandle.get(n.handle)) as { kind: string; priority: string; value?: string }[];
      const sortSig = (withOrder: boolean): string =>
        cs.filter((c) => withOrder || c.kind !== 'Ordering')
          .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
          .map((c) => `${c.kind}:${c.priority}:${c.value ?? ''}`).join('|');
      const kindTokens: Record<string, string> = {};
      const kinds = ['FillParent', 'Centered', 'StackVertically', 'WrapOnOverflow', 'MaxWidth', 'AspectRatio', 'Gap', 'Alignment', 'Ordering'];
      for (const k of kinds) {
        const c = cs.find((x) => x.kind === k);
        kindTokens[k] = c ? `${c.priority}:${c.value ?? ''}` : 'none';
      }
      return {
        handle: n.handle,
        role: n.semantic.role,
        parent: n.computedRelationships.parent,
        ordering: n.computedRelationships.ordering,
        position: n.authoredLayout.position,
        flexWrap: n.authoredLayout.flexWrap,
        alignment: n.authoredLayout.alignment,
        widthSizing: n.authoredLayout.intrinsicSizing,
        centered: n.authoredLayout.centered,
        widthRatio: n.authoredLayout.widthRatio,
        sig: sortSig(true),
        sigNoOrder: sortSig(false),
        kindTokens,
      };
    });
    return { clusterCount: nodes.length, nodes };
  }, bundle);
}

// ── Metrics ──

function handleSet(s: IRShape): Set<string> { return new Set(s.nodes.map((n) => n.handle)); }
function byHandle(s: IRShape): Map<string, IRNodeShape> {
  const m = new Map<string, IRNodeShape>(); for (const n of s.nodes) m.set(n.handle, n); return m;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0; for (const h of a) if (b.has(h)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 1;
}

/** Fraction of shared handles whose `field` value is unchanged. */
function fieldStability(a: IRShape, b: IRShape, field: keyof IRNodeShape): number {
  const ma = byHandle(a), mb = byHandle(b);
  let shared = 0, kept = 0;
  for (const [h, na] of ma) {
    const nb = mb.get(h); if (!nb) continue;
    shared++;
    if (String(na[field]) === String(nb[field])) kept++;
  }
  return shared > 0 ? kept / shared : 1;
}

/** Constraint signature stability: fraction of shared handles whose signature matches. */
function constraintStability(a: IRShape, b: IRShape, withOrder: boolean): number {
  const key = withOrder ? 'sig' : 'sigNoOrder';
  return fieldStability(a, b, key as keyof IRNodeShape);
}

/** Per-constraint-kind flip rate: fraction of shared handles where that kind changed (present/absent
 *  or token differs). */
function kindFlipRates(a: IRShape, b: IRShape): Record<string, number> {
  const ma = byHandle(a), mb = byHandle(b);
  const out: Record<string, number> = {};
  for (const k of KINDS) {
    let shared = 0, changed = 0;
    for (const [h, na] of ma) {
      const nb = mb.get(h); if (!nb) continue;
      shared++;
      if (na.kindTokens[k] !== nb.kindTokens[k]) changed++;
    }
    out[k] = shared > 0 ? changed / shared : 0;
  }
  return out;
}

interface PerturbResult {
  name: string;
  nodeIdentity: number;
  parentChild: number;
  role: number;
  constraintWith: number;
  constraintNoOrder: number;   // THE GATE NUMBER
  kindFlips: Record<string, number>;
  fieldStab: Record<string, number>;  // position/flexWrap/alignment/widthSizing/centered
}

function compare(baseline: IRShape, perturbed: IRShape, name: string): PerturbResult {
  return {
    name,
    nodeIdentity: jaccard(handleSet(baseline), handleSet(perturbed)),
    parentChild: fieldStability(baseline, perturbed, 'parent'),
    role: fieldStability(baseline, perturbed, 'role'),
    constraintWith: constraintStability(baseline, perturbed, true),
    constraintNoOrder: constraintStability(baseline, perturbed, false),
    kindFlips: kindFlipRates(baseline, perturbed),
    fieldStab: {
      position: fieldStability(baseline, perturbed, 'position'),
      flexWrap: fieldStability(baseline, perturbed, 'flexWrap'),
      alignment: fieldStability(baseline, perturbed, 'alignment'),
      widthSizing: fieldStability(baseline, perturbed, 'widthSizing'),
      centered: fieldStability(baseline, perturbed, 'centered'),
    },
  };
}

// ── Perturbations ──

async function baselineAndAt(page: Page, bundle: string, url: string, settleMs: number): Promise<IRShape> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.setViewportSize({ width: BASE_W, height: BASE_H });
  await page.waitForTimeout(settleMs);
  return runIR(page, bundle);
}

async function atCurrentViewport(page: Page, bundle: string, settleMs: number): Promise<IRShape> {
  await page.waitForTimeout(Math.max(settleMs, 600));
  return runIR(page, bundle);
}

async function perturbResize(page: Page, bundle: string, base: IRShape, url: string, settleMs: number): Promise<PerturbResult[]> {
  const out: PerturbResult[] = [];
  for (const w of RESIZE_WIDTHS) {
    await page.setViewportSize({ width: w, height: BASE_H });
    const ir = await atCurrentViewport(page, bundle, settleMs);
    out.push(compare(base, ir, `resize-${w}`));
  }
  return out;
}

async function perturbZoom(page: Page, bundle: string, base: IRShape, settleMs: number): Promise<PerturbResult[]> {
  const out: PerturbResult[] = [];
  for (const w of ZOOM_WIDTHS) {
    await page.setViewportSize({ width: w, height: BASE_H });
    const ir = await atCurrentViewport(page, bundle, settleMs);
    out.push(compare(base, ir, `zoom-125%(${w}px)`));
  }
  // zoom-150%(1280px) coincides by definition with resize-1280 — reported once, attributed there.
  return out;
}

async function perturbSpaRoute(page: Page, bundle: string, base: IRShape, url: string, settleMs: number): Promise<PerturbResult | null> {
  // Only GitHub is an SPA proof site here. Navigate to another route, go back, re-extract: does the
  // SPA re-render of the SAME content reproduce the same IR?
  if (!/github\.com/.test(url)) return null;
  try {
    // Click the first in-repo file link in the file tree (a client-side pjax/turbo nav).
    const clicked = await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>('a[href*="/torvalds/linux/blob/"], a[href*="/torvalds/linux/tree/"]');
      if (a && a.href) { a.click(); return a.href; }
      return null;
    });
    if (!clicked) return null;
    await page.waitForTimeout(Math.max(settleMs, 2500));
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const ir = await atCurrentViewport(page, bundle, settleMs);
    return compare(base, ir, 'spa-route');
  } catch { return null; }
}

async function perturbLazyLoad(page: Page, bundle: string, base: IRShape): Promise<PerturbResult> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const ir = await runIR(page, bundle);
  return compare(base, ir, 'lazy-load');
}

// Minor DOM mutations — generic (no site selectors), reused from the Phase 0/1 probe.

async function mutInsert(page: Page, bundle: string, base: IRShape): Promise<PerturbResult> {
  await page.evaluate(() => {
    const host = document.querySelector('main, [role="main"], article') as HTMLElement | null
      ?? (document.body.firstElementChild as HTMLElement | null);
    if (!host) return;
    const node = document.createElement('div');
    node.style.cssText = 'background:#0a0;color:#fff;padding:12px 16px;margin:8px 0;font-size:14px;border-radius:6px;';
    node.textContent = 'probe-inserted-region';
    host.insertAdjacentElement('afterbegin', node);
  });
  await page.waitForTimeout(200);
  return compare(base, await runIR(page, bundle), 'mut-insert');
}

async function mutRemove(page: Page, bundle: string, base: IRShape): Promise<PerturbResult> {
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[data-wm-c]')) as HTMLElement[];
    if (els.length) els[els.length - 1].remove();
    else (document.body.lastElementChild as HTMLElement | null)?.remove();
  });
  await page.waitForTimeout(200);
  return compare(base, await runIR(page, bundle), 'mut-remove');
}

async function mutReorder(page: Page, bundle: string, base: IRShape): Promise<PerturbResult> {
  await page.evaluate(() => {
    const host = (document.querySelector('main, [role="main"], article') as HTMLElement | null) ?? document.body;
    const isContent = (el: HTMLElement) => (el.textContent || '').replace(/\s+/g, ' ').trim().length > 40;
    const walk = (cur: HTMLElement, depth: number): boolean => {
      if (depth > 5) return false;
      const kids = Array.from(cur.children).filter((e) => e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE') as HTMLElement[];
      for (let i = 0; i + 1 < kids.length; i++) {
        if (isContent(kids[i]) && isContent(kids[i + 1])) {
          const a = kids[i], b = kids[i + 1], m = document.createElement('div');
          a.replaceWith(m); b.parentElement!.insertBefore(a, b); m.replaceWith(b); return true;
        }
      }
      for (const k of kids) if (isContent(k) && walk(k, depth + 1)) return true;
      return false;
    };
    return walk(host as HTMLElement, 0);
  });
  await page.waitForTimeout(500);
  return compare(base, await runIR(page, bundle), 'mut-reorder');
}

// ── Per-site + report ──

interface SiteResult {
  name: string;
  perturbs: PerturbResult[];
  gate: 'PASS' | 'FAIL';
  failReasons: string[];
}

const GATE_ID = 0.85, GATE_PC = 0.90, GATE_ROLE = 0.90, GATE_CON = 0.85;

function gateCheck(p: PerturbResult, reasonOut: string[]): boolean {
  let ok = true;
  if (p.parentChild < GATE_PC) { ok = false; reasonOut.push(`${p.name}: parent/child ${p.parentChild.toFixed(3)} < ${GATE_PC}`); }
  if (p.role < GATE_ROLE) { ok = false; reasonOut.push(`${p.name}: role ${p.role.toFixed(3)} < ${GATE_ROLE}`); }
  if (p.nodeIdentity < GATE_ID) { ok = false; reasonOut.push(`${p.name}: node-identity ${p.nodeIdentity.toFixed(3)} < ${GATE_ID}`); }
  if (p.constraintNoOrder < GATE_CON) { ok = false; reasonOut.push(`${p.name}: constraint(no-Order) ${p.constraintNoOrder.toFixed(3)} < ${GATE_CON}`); }
  return ok;
}

async function measureSite(page: Page, bundle: string, site: { name: string; url: string; settleMs: number }): Promise<SiteResult> {
  console.log(`\n=== ${site.name} ===`);
  const base = await baselineAndAt(page, bundle, site.url, site.settleMs);
  console.log(`  baseline: ${base.clusterCount} nodes @ ${BASE_W}x${BASE_H}`);
  const perturbs: PerturbResult[] = [];
  perturbs.push(...await perturbResize(page, bundle, base, site.url, site.settleMs));
  perturbs.push(...await perturbZoom(page, bundle, base, site.settleMs));
  const spa = await perturbSpaRoute(page, bundle, base, site.url, site.settleMs);
  if (spa) perturbs.push(spa);
  perturbs.push(await perturbLazyLoad(page, bundle, base));
  perturbs.push(await mutInsert(page, bundle, base));
  perturbs.push(await mutRemove(page, bundle, base));
  perturbs.push(await mutReorder(page, bundle, base));

  const reasons: string[] = [];
  for (const p of perturbs) gateCheck(p, reasons);
  // Pre-authorized: a resize-only node-identity failure is expected (re-clustering), not a defect.
  const resizeIdFails = perturbs.filter((p) => p.name.startsWith('resize-') && p.nodeIdentity < GATE_ID);
  const otherFails = reasons.filter((r) => !r.includes('node-identity'));
  const onlyResizeNodeId = resizeIdFails.length > 0 && otherFails.length === 0
    && reasons.every((r) => r.includes('node-identity') && r.startsWith('resize-'));
  const gate = reasons.length === 0 ? 'PASS' : onlyResizeNodeId ? 'BLOCKED-RESIZE-IDENTITY' : 'FAIL';
  if (onlyResizeNodeId) {
    reasons.push('PRE-AUTHORIZED BLOCKED OUTCOME: gate fails ONLY on resize node-identity (geometry-derived handles re-cluster). STOP; recommend pulling Phase 5 (role-anchored stable handles) ahead of the solver. Do not tune clustering.');
  }
  for (const p of perturbs) {
    console.log(`  ${p.name.padEnd(22)} id=${p.nodeIdentity.toFixed(3)} pc=${p.parentChild.toFixed(3)} role=${p.role.toFixed(3)} con(noO)=${p.constraintNoOrder.toFixed(3)} con(wO)=${p.constraintWith.toFixed(3)}`);
    console.log(`    kind-flips: ${KINDS.map((k) => `${k}=${(p.kindFlips[k] * 100).toFixed(0)}%`).join(' ')}`);
    console.log(`    field-stab: pos=${p.fieldStab.position.toFixed(2)} flexWrap=${p.fieldStab.flexWrap.toFixed(2)} align=${p.fieldStab.alignment.toFixed(2)} widthSizing=${p.fieldStab.widthSizing.toFixed(2)} centered=${p.fieldStab.centered.toFixed(2)}`);
  }
  console.log(`  GATE: ${gate}${reasons.length ? ' — ' + reasons.join('; ') : ''}`);
  return { name: site.name, perturbs, gate: gate === 'PASS' ? 'PASS' : 'FAIL', failReasons: reasons };
}

function printReport(results: SiteResult[]): void {
  console.log('\n\n========== PHASE 2.5 — LAYOUT IR STABILITY REPORT ==========\n');
  for (const r of results) {
    const flag = r.gate === 'PASS' ? '✓' : (r.failReasons.some((x) => x.includes('PRE-AUTHORIZED')) ? '⊘' : '✗');
    console.log(`${flag} ${r.name.padEnd(12)} ${r.gate}`);
    for (const p of r.perturbs) {
      console.log(`  ${p.name.padEnd(22)} id=${p.nodeIdentity.toFixed(3)} pc=${p.parentChild.toFixed(3)} role=${p.role.toFixed(3)} con(noO)=${p.constraintNoOrder.toFixed(3)} [gate: ${p.constraintNoOrder >= GATE_CON && p.parentChild >= GATE_PC && p.role >= GATE_ROLE && p.nodeIdentity >= GATE_ID ? 'pass' : 'FAIL'}]`);
    }
    if (r.failReasons.length) console.log(`  reasons: ${r.failReasons.join('\n  ')}`);
  }
  const pass = results.filter((r) => r.gate === 'PASS').length;
  console.log(`\n--- gate ---`);
  console.log(`parent/child ≥ .90 · role ≥ .90 · identity ≥ .85 · constraint(no-Order) ≥ .85`);
  console.log(`PASS: ${pass}/${results.length}`);
}

async function main(): Promise<void> {
  const bundle = await buildBundle();
  console.log(`bundle: ${bundle.length} chars (real perceive + extractLayoutIR, 0 model calls)`);
  const context = await chromium.launchPersistentContext('', { headless: false, args: ['--no-first-run'] });
  const page = await context.newPage();
  await page.setViewportSize({ width: BASE_W, height: BASE_H });
  const results: SiteResult[] = [];
  for (const site of sites) {
    try { results.push(await measureSite(page, bundle, site)); }
    catch (err) {
      console.log(`\n=== ${site.name} ===\n  ERROR: ${(err as Error).message}`);
      results.push({ name: site.name, perturbs: [], gate: 'FAIL', failReasons: [`site error: ${(err as Error).message}`] });
    }
  }
  printReport(results);
  await context.close();
  const pass = results.filter((r) => r.gate === 'PASS').length;
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
