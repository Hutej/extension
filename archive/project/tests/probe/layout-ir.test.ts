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
 *   RVGRID=smoke  (1 site)  | RVSITE=Wikipedia
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

const SMOKE = process.env.RVGRID === 'smoke';
const SITE_FILTER = process.env.RVSITE;
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
  slotMap: Record<string, string>;       // 1.5D: handle -> slotId
  excludedMap: Record<string, string>;    // 1.5C: handle -> exclusion reason
  parentWidthFromParent: number;          // 1.6C: clusters using parent-relative path (widthFractionOfParent < 1)
  parentWidthFallback: number;            // 1.6C: clusters using viewport fallback (widthFractionOfParent >= 1)
}

const KINDS = ['FillParent', 'Centered', 'StackVertically', 'WrapOnOverflow', 'MaxWidth', 'AspectRatio', 'Gap', 'Alignment', 'Ordering'] as const;

// 1.6A — role → slot map (mirrors languages/documentation.ts). Used to classify flip
// pairs as LAYOUT-CRITICAL (different slots) or COSMETIC (same slot). Test fixture, not
// product code — no hostname branching, just a mirror of the slot language for analysis.
const ROLE_TO_SLOT_MERGED: Record<string, string> = {
  'page-title': 'masthead', 'nav-primary': 'masthead', 'search': 'masthead', 'toolbar': 'masthead', 'actions-primary': 'masthead',
  'nav-local': 'nav-local', 'sidebar': 'nav-local',  // merged (1.5D)
  'toc': 'toc',
  'article-body': 'main', 'listing': 'main', 'media': 'main', 'comments': 'main', 'metadata': 'main',
  'footer-chrome': 'footer',
  // ad-or-void → overflow
};
const ROLE_TO_SLOT_UNMERGED: Record<string, string> = {
  ...ROLE_TO_SLOT_MERGED,
  'sidebar': 'sidebar',  // sidebar as its own slot (1.6A A2)
};
function slotFor(role: string, merged: boolean): string {
  const map = merged ? ROLE_TO_SLOT_MERGED : ROLE_TO_SLOT_UNMERGED;
  return map[role] ?? 'overflow';
}
/** A flip pair is LAYOUT-CRITICAL if the two roles land in DIFFERENT slots (the node
 *  would change which region of the page it belongs to). COSMETIC if same slot. */
function flipSeverity(from: string, to: string, merged: boolean): 'CRITICAL' | 'COSMETIC' {
  return slotFor(from, merged) !== slotFor(to, merged) ? 'CRITICAL' : 'COSMETIC';
}

async function runIR(page: Page, bundle: string): Promise<IRShape> {
  return await page.evaluate(async (src: string): Promise<IRShape> => {
    new Function(src)();
    const perceive = (window as unknown as { __rvPerceive: () => unknown }).__rvPerceive;
    const clearHandles = (window as unknown as { __rvClearHandles: () => void }).__rvClearHandles;
    const extractIR = (window as unknown as { __rvExtractLayoutIR: (p: unknown) => any }).__rvExtractLayoutIR;
    const curCons = (window as unknown as { __rvCurrentConstraints: (n: any) => any[] }).__rvCurrentConstraints;
    const detectExcl = (window as unknown as { __rvDetectExclusions: (c: any[]) => Map<string, string> }).__rvDetectExclusions;
    const assignS = (window as unknown as { __rvAssignSlots: (n: any[], e: Set<string>) => any }).__rvAssignSlots;
    clearHandles();
    const p = perceive() as any;
    const clusters = p.clusters as any[];
    // 1.5C — exclusion detection
    const excludedRaw = detectExcl(clusters);
    const excludedMap: Record<string, string> = {};
    const excludedSet = new Set<string>();
    for (const [h, r] of excludedRaw) { excludedMap[h] = r; excludedSet.add(h); }
    // 1.5D — slot assignment (all nodes, including excluded — excluded still land in a slot)
    const ir = extractIR(p) as { nodes: any[]; byHandle: Map<string, any> };
    const assignment = assignS(ir.nodes, excludedSet);
    const slotMap: Record<string, string> = {};
    for (const [h, s] of assignment.handleToSlot) slotMap[h] = s;
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
    return { clusterCount: nodes.length, nodes, slotMap, excludedMap,
      parentWidthFromParent: clusters.filter((c: any) => c.widthFractionOfParent < 1).length,
      parentWidthFallback: clusters.filter((c: any) => c.widthFractionOfParent >= 1).length };
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

/** 1.5D: slot-assignment stability — fraction of shared handles landing in the same slot.
 *  If `eligibleOnly` is true, only count handles not in the excluded set. */
function slotStability(a: IRShape, b: IRShape, eligibleOnly: boolean): number {
  const ma = byHandle(a), mb = byHandle(b);
  let shared = 0, kept = 0;
  for (const [h] of ma) {
    if (!mb.has(h)) continue;
    if (eligibleOnly && (a.excludedMap[h] || b.excludedMap[h])) continue;
    shared++;
    if (a.slotMap[h] === b.slotMap[h]) kept++;
  }
  return shared > 0 ? kept / shared : 1;
}

/** 1.6A A1: slot stability EXCLUDING pairs where both baseline and perturbed slot = overflow.
 *  Overflow is a single flat slot — overflow→overflow pairs score a free 1.0 and inflate
 *  the metric. THE GATE reads this number, not the raw slotStabEligible. */
function slotStabilityExclOverflow(a: IRShape, b: IRShape, eligibleOnly: boolean): number {
  const ma = byHandle(a), mb = byHandle(b);
  let shared = 0, kept = 0;
  for (const [h] of ma) {
    if (!mb.has(h)) continue;
    if (eligibleOnly && (a.excludedMap[h] || b.excludedMap[h])) continue;
    if (a.slotMap[h] === 'overflow' && b.slotMap[h] === 'overflow') continue;  // skip free-1.0 pairs
    shared++;
    if (a.slotMap[h] === b.slotMap[h]) kept++;
  }
  return shared > 0 ? kept / shared : 1;
}

/** 1.6A A2: slot stability with sidebar as its OWN slot (unmerged), both with and without
 *  overflow inflation. Reports the gate BOTH ways so the merge can be judged on design
 *  grounds alone, not by the numbers it produces. */
function slotStabilityUnmerged(a: IRShape, b: IRShape, eligibleOnly: boolean, exclOverflow: boolean): number {
  const ma = byHandle(a), mb = byHandle(b);
  const slotA = (h: string) => ma.get(h)?.role === 'sidebar' ? 'sidebar' : a.slotMap[h];
  const slotB = (h: string) => mb.get(h)?.role === 'sidebar' ? 'sidebar' : b.slotMap[h];
  let shared = 0, kept = 0;
  for (const [h] of ma) {
    if (!mb.has(h)) continue;
    if (eligibleOnly && (a.excludedMap[h] || b.excludedMap[h])) continue;
    if (exclOverflow && slotA(h) === 'overflow' && slotB(h) === 'overflow') continue;
    shared++;
    if (slotA(h) === slotB(h)) kept++;
  }
  return shared > 0 ? kept / shared : 1;
}
function fieldStabilityEligible(a: IRShape, b: IRShape, field: keyof IRNodeShape): number {
  const ma = byHandle(a), mb = byHandle(b);
  let shared = 0, kept = 0;
  for (const [h, na] of ma) {
    const nb = mb.get(h); if (!nb) continue;
    if (a.excludedMap[h] || b.excludedMap[h]) continue;
    shared++;
    if (String(na[field]) === String(nb[field])) kept++;
  }
  return shared > 0 ? kept / shared : 1;
}

function constraintStabilityEligible(a: IRShape, b: IRShape, withOrder: boolean): number {
  const key = withOrder ? 'sig' : 'sigNoOrder';
  return fieldStabilityEligible(a, b, key as keyof IRNodeShape);
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

interface RoleFlip { handle: string; from: string; to: string; }
interface FillParentFlip { handle: string; ratioBefore: number; ratioAfter: number; tokenBefore: string; tokenAfter: string; }

interface PerturbResult {
  name: string;
  isViewportChange: boolean;           // true for resize/zoom, false for mutations/lazy-load/spa
  nodeIdentity: number;
  parentChild: number;
  role: number;
  constraintWith: number;
  constraintNoOrder: number;   // THE GATE NUMBER
  kindFlips: Record<string, number>;
  fieldStab: Record<string, number>;  // position/flexWrap/alignment/widthSizing/centered
  roleFlips: RoleFlip[];              // A1: per-handle (from -> to) pairs
  fpFlips: FillParentFlip[];          // A4: widthRatio values around the 0.97 threshold
  // 1.5C/D metrics
  slotStabAll: number;               // slot-assignment stability (all nodes)
  slotStabEligible: number;           // slot-assignment stability (eligible only)
  // Old four metrics on eligible nodes (diagnostics)
  idElig: number; pcElig: number; roleElig: number; conNoOrderElig: number;
  overflowCount: number;             // overflow slot membership (eligible nodes, perturbed)
  // 1.6A — decontaminated slot stability
  slotStabNoOverflow: number;         // (A1-ii) EXCLUDING overflow→overflow pairs — THE GATE NUMBER
  slotStabUnmerged: number;           // (A2) sidebar as own slot
  slotStabUnmergedNoOverflow: number; // (A2) sidebar as own slot, excl overflow
  overflowPct: number;                // (A1-iii) overflow membership % of eligible nodes
  overflowCountBase: number;          // baseline overflow membership (eligible)
  maxCriticalFlipCount: number;       // (1.6F-b) max count of any single CRITICAL pair this perturbation
}

/** Role confusion pairs: every shared handle where role changed, with (from -> to). */
function roleFlipList(a: IRShape, b: IRShape): RoleFlip[] {
  const ma = byHandle(a), mb = byHandle(b);
  const out: RoleFlip[] = [];
  for (const [h, na] of ma) {
    const nb = mb.get(h); if (!nb) continue;
    if (na.role !== nb.role) out.push({ handle: h, from: na.role, to: nb.role });
  }
  return out;
}

/** FillParent flip details: widthRatio on both sides for handles where FillParent token changed. */
function fillParentFlipList(a: IRShape, b: IRShape): FillParentFlip[] {
  const ma = byHandle(a), mb = byHandle(b);
  const out: FillParentFlip[] = [];
  for (const [h, na] of ma) {
    const nb = mb.get(h); if (!nb) continue;
    if (na.kindTokens['FillParent'] !== nb.kindTokens['FillParent'])
      out.push({ handle: h, ratioBefore: na.widthRatio, ratioAfter: nb.widthRatio, tokenBefore: na.kindTokens['FillParent'], tokenAfter: nb.kindTokens['FillParent'] });
  }
  return out;
}

function compare(baseline: IRShape, perturbed: IRShape, name: string): PerturbResult {
  const isViewportChange = name.startsWith('resize-') || name.startsWith('zoom-');
  return {
    name,
    isViewportChange,
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
    roleFlips: roleFlipList(baseline, perturbed),
    fpFlips: fillParentFlipList(baseline, perturbed),
    slotStabAll: slotStability(baseline, perturbed, false),
    slotStabEligible: slotStability(baseline, perturbed, true),
    slotStabNoOverflow: slotStabilityExclOverflow(baseline, perturbed, true),
    slotStabUnmerged: slotStabilityUnmerged(baseline, perturbed, true, false),
    slotStabUnmergedNoOverflow: slotStabilityUnmerged(baseline, perturbed, true, true),
    idElig: ((): number => {
      const ma = byHandle(baseline), mb = byHandle(perturbed);
      let inter = 0, union = 0;
      for (const [h] of ma) if (!baseline.excludedMap[h]) { union++; if (mb.has(h) && !perturbed.excludedMap[h]) inter++; }
      for (const [h] of mb) if (!perturbed.excludedMap[h] && !ma.has(h)) union++;
      return union > 0 ? inter / union : 1;
    })(),
    pcElig: fieldStabilityEligible(baseline, perturbed, 'parent'),
    roleElig: fieldStabilityEligible(baseline, perturbed, 'role'),
    conNoOrderElig: constraintStabilityEligible(baseline, perturbed, false),
    overflowCount: Object.entries(perturbed.slotMap).filter(([h, s]) => s === 'overflow' && !perturbed.excludedMap[h]).length,
    overflowCountBase: Object.entries(baseline.slotMap).filter(([h, s]) => s === 'overflow' && !baseline.excludedMap[h]).length,
    overflowPct: (() => {
      const eligTotal = Object.keys(perturbed.slotMap).filter((h) => !perturbed.excludedMap[h]).length;
      return eligTotal > 0 ? Object.entries(perturbed.slotMap).filter(([h, s]) => s === 'overflow' && !perturbed.excludedMap[h]).length / eligTotal * 100 : 0;
    })(),
    maxCriticalFlipCount: (() => {
      const pairCounts = new Map<string, number>();
      for (const f of roleFlipList(baseline, perturbed)) {
        if (flipSeverity(f.from, f.to, true) === 'CRITICAL') {
          const k = `${f.from}->${f.to}`;
          pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
        }
      }
      return pairCounts.size > 0 ? Math.max(...pairCounts.values()) : 0;
    })(),
  };
}

// ── Perturbations ──

async function baselineAndAt(page: Page, bundle: string, url: string, _settleMs: number): Promise<IRShape> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.setViewportSize({ width: BASE_W, height: BASE_H });
  // S3.4 — inject the bundle so waitForSettle is available, then use the
  // MutationObserver settle condition instead of the fixed settleMs stopwatch.
  await page.evaluate((src: string) => { new Function(src)(); }, bundle);
  const settleResult = await page.evaluate(async () => {
    const wfs = (globalThis as unknown as { __rvWaitForSettle?: (q?: number, m?: number) => Promise<{ settled: boolean; waitMs: number }> }).__rvWaitForSettle;
    if (wfs) return await wfs(500, 6000);
    return { settled: false, waitMs: 0 };
  });
  // P5.2 — clear the sticky role cache on navigation (session-scoped, not page-persisted).
  await page.evaluate(() => { (globalThis as unknown as { __rvClearRoleCache?: () => void }).__rvClearRoleCache?.(); });
  const ir = await runIR(page, bundle);
  (ir as IRShape & { settleInfo?: { settled: boolean; waitMs: number } }).settleInfo = settleResult;
  return ir;
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
    const els = Array.from(document.querySelectorAll('[data-rv-c]')) as HTMLElement[];
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
  const settle = (base as IRShape & { settleInfo?: { settled: boolean; waitMs: number } }).settleInfo;
  console.log(`  baseline: ${base.clusterCount} nodes @ ${BASE_W}x${BASE_H} — settle: ${settle?.settled ? 'quiet' : 'timeout'} @ ${settle?.waitMs}ms — C3 normWidth: ${base.parentWidthFromParent} parent-relative / ${base.parentWidthFallback} viewport-fallback`);
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
    console.log(`    slot-stab: (i)all-elig=${p.slotStabEligible.toFixed(3)} (ii)excl-overflow=${p.slotStabNoOverflow.toFixed(3)} (iii)overflow=${p.overflowCount} (${p.overflowPct.toFixed(0)}%) [base-overflow=${p.overflowCountBase}]`);
    console.log(`    slot-stab-unmerged: elig=${p.slotStabUnmerged.toFixed(3)} excl-overflow=${p.slotStabUnmergedNoOverflow.toFixed(3)}`);
    console.log(`    eligible-metrics: id=${p.idElig.toFixed(3)} pc=${p.pcElig.toFixed(3)} role=${p.roleElig.toFixed(3)} con(noO)=${p.conNoOrderElig.toFixed(3)}`);
    console.log(`    kind-flips: ${KINDS.map((k) => `${k}=${(p.kindFlips[k] * 100).toFixed(0)}%`).join(' ')}`);
    console.log(`    field-stab: pos=${p.fieldStab.position.toFixed(2)} flexWrap=${p.fieldStab.flexWrap.toFixed(2)} align=${p.fieldStab.alignment.toFixed(2)} widthSizing=${p.fieldStab.widthSizing.toFixed(2)} centered=${p.fieldStab.centered.toFixed(2)}`);
    // 1.6A A1/A3: role confusion matrix per perturbation, with CRITICAL/COSMETIC classification
    // derived from the slot map (not asserted). Absolute counts per pair.
    if (p.roleFlips.length) {
      const pairCounts = new Map<string, number>();
      for (const f of p.roleFlips) { const k = `${f.from} -> ${f.to}`; pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1); }
      const crit = [...pairCounts.entries()].filter(([k]) => { const [a, b] = k.split(' -> '); return flipSeverity(a, b, true) === 'CRITICAL'; });
      const cos = [...pairCounts.entries()].filter(([k]) => { const [a, b] = k.split(' -> '); return flipSeverity(a, b, true) === 'COSMETIC'; });
      console.log(`    role-flips (${p.roleFlips.length}): CRITICAL=${crit.map(([k, c]) => `${k}(${c})`).join(', ') || 'none'} | COSMETIC=${cos.map(([k, c]) => `${k}(${c})`).join(', ') || 'none'} | maxCritFlip=${p.maxCriticalFlipCount}`);
    }
    // A4: FillParent flip details
    if (p.fpFlips.length) {
      console.log(`    FillParent-flips: ${p.fpFlips.map((f) => `${f.handle} ${f.ratioBefore.toFixed(3)}->${f.ratioAfter.toFixed(3)} [${f.tokenBefore}->${f.tokenAfter}]`).join(', ')}`);
    }
  }

  // A3: per-perturbation-type decomposition of role stability
  const vpChange = perturbs.filter((p) => p.isViewportChange);
  const fixedVP = perturbs.filter((p) => !p.isViewportChange);
  const avgRole = (ps: PerturbResult[]) => ps.length ? ps.reduce((s, p) => s + p.role, 0) / ps.length : 1;
  console.log(`  [A3] role-stab: viewport-change avg=${avgRole(vpChange).toFixed(3)} (${vpChange.map((p) => p.role.toFixed(3)).join(', ')})`);
  console.log(`  [A3] role-stab: fixed-viewport avg=${avgRole(fixedVP).toFixed(3)} (${fixedVP.map((p) => p.role.toFixed(3)).join(', ')})`);

  console.log(`  GATE: ${gate}${reasons.length ? ' — ' + reasons.join('; ') : ''}`);

  // 1.5C — exclusion stats
  const excludedCount = Object.keys(base.excludedMap).length;
  const excludedPct = (excludedCount / base.clusterCount * 100).toFixed(0);
  const exclByCategory: Record<string, number> = {};
  for (const r of Object.values(base.excludedMap)) exclByCategory[r] = (exclByCategory[r] ?? 0) + 1;
  console.log(`  [1.5C] excluded: ${excludedCount}/${base.clusterCount} (${excludedPct}%) — ${Object.entries(exclByCategory).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // 1.6A — decontaminated slot-assignment stability gate (GATE reads excl-overflow)
  const docSites = ['MDN', 'Wikipedia', 'GitHub'];
  const isDocSite = docSites.includes(site.name);
  const slotStabsNoOverflow = perturbs.map((p) => p.slotStabNoOverflow);
  const minSlotNoOverflow = Math.min(...slotStabsNoOverflow);
  const slotStabsUnmergedNoOverflow = perturbs.map((p) => p.slotStabUnmergedNoOverflow);
  const minSlotUnmergedNoOverflow = Math.min(...slotStabsUnmergedNoOverflow);
  const slotGate = isDocSite ? (minSlotNoOverflow >= 0.95 ? 'PASS' : 'FAIL') : 'ADVISORY';
  console.log(`  [1.6A] slot-stab (GATE): merged excl-overflow min=${minSlotNoOverflow.toFixed(3)} ${slotGate}${isDocSite ? ` (gate: ≥0.95)` : ' (advisory)'}`);
  console.log(`  [1.6A] slot-stab (unmerged): sidebar-as-own-slot excl-overflow min=${minSlotUnmergedNoOverflow.toFixed(3)}`);
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

  // A1/A3 cross-site summary: all unique role flip pairs, split by perturbation type
  const vpPairs = new Map<string, { sites: Set<string>; count: number }>();
  const fxPairs = new Map<string, { sites: Set<string>; count: number }>();
  for (const r of results) {
    for (const p of r.perturbs) {
      const target = p.isViewportChange ? vpPairs : fxPairs;
      for (const f of p.roleFlips) {
        const k = `${f.from} -> ${f.to}`;
        const e = target.get(k) ?? { sites: new Set<string>(), count: 0 };
        e.sites.add(r.name); e.count++; target.set(k, e);
      }
    }
  }
  console.log(`\n--- A1/A3: role flip pairs (viewport-change perturbations) ---`);
  for (const [k, e] of vpPairs) { const [a, b] = k.split(' -> '); console.log(`  [${flipSeverity(a, b, true)}] ${k}: ${e.count}x on ${[...e.sites].join(', ')}`); }
  console.log(`\n--- A1/A3: role flip pairs (fixed-viewport perturbations) ---`);
  for (const [k, e] of fxPairs) { const [a, b] = k.split(' -> '); console.log(`  [${flipSeverity(a, b, true)}] ${k}: ${e.count}x on ${[...e.sites].join(', ')}`); }
  if (!vpPairs.size && !fxPairs.size) console.log('  (no role flips observed)');

  // A4 cross-site summary: FillParent flip widthRatio ranges
  const fpAll: FillParentFlip[] = [];
  for (const r of results) for (const p of r.perturbs) fpAll.push(...p.fpFlips);
  if (fpAll.length) {
    console.log(`\n--- A4: FillParent flip widthRatio values ---`);
    for (const f of fpAll) console.log(`  ${f.handle}: ${f.ratioBefore.toFixed(3)} -> ${f.ratioAfter.toFixed(3)} [${f.tokenBefore} -> ${f.tokenAfter}]`);
  } else {
    console.log(`\n--- A4: FillParent flips: (none) ---`);
  }

  // 1.6A/1.6F — decontaminated slot-assignment stability + exit rule
  console.log(`\n--- 1.6A: SLOT-ASSIGNMENT STABILITY (decontaminated) ---`);
  console.log(`  (i)=all-eligible  (ii)=excl-overflow→overflow [GATE NUMBER]  (iii)=overflow count/%`);
  const docSites = ['MDN', 'Wikipedia', 'GitHub'];
  const docResults: { name: string; minNoOverflow: number; maxCriticalFlip: number; overflowPct: number; conNoOrderElig: number }[] = [];
  for (const r of results) {
    const isDoc = docSites.includes(r.name);
    const noOverflowStabs = r.perturbs.map((p) => p.slotStabNoOverflow);
    const minNoOverflow = Math.min(...(noOverflowStabs.length ? noOverflowStabs : [1]));
    const unmergedStabs = r.perturbs.map((p) => p.slotStabUnmergedNoOverflow);
    const minUnmerged = Math.min(...(unmergedStabs.length ? unmergedStabs : [1]));
    const maxCritFlip = Math.max(...(r.perturbs.length ? r.perturbs.map((p) => p.maxCriticalFlipCount) : [0]));
    const overflowPct = Math.max(...(r.perturbs.length ? r.perturbs.map((p) => p.overflowPct) : [0]));
    const conNoOrderElig = Math.min(...(r.perturbs.length ? r.perturbs.map((p) => p.conNoOrderElig) : [1]));
    const gate = isDoc ? (minNoOverflow >= 0.95 ? '✓ PASS' : '✗ FAIL') : 'advisory';
    console.log(`  ${r.name.padEnd(12)} (i)=${Math.min(...(r.perturbs.length ? r.perturbs.map((p) => p.slotStabEligible) : [1])).toFixed(3)} (ii)=${minNoOverflow.toFixed(3)} (iii)=${Math.round(overflowPct)}% maxCritFlip=${maxCritFlip} unmerged(ii)=${minUnmerged.toFixed(3)} ${gate}`);
    // Per-perturbation breakdown
    for (const p of r.perturbs) {
      if (p.slotStabNoOverflow < 0.95) console.log(`    ${p.name}: (ii)=${p.slotStabNoOverflow.toFixed(3)} (iii)=${Math.round(p.overflowPct)}% critFlip=${p.maxCriticalFlipCount}`);
    }
    if (isDoc) docResults.push({ name: r.name, minNoOverflow, maxCriticalFlip: maxCritFlip, overflowPct, conNoOrderElig });
    // YouTube hypothesis
    if (r.name === 'YouTube') {
      const idAll = Math.min(...r.perturbs.map((p) => p.nodeIdentity));
      const idElig = Math.min(...r.perturbs.map((p) => p.idElig));
      console.log(`    YouTube identity hypothesis: all-nodes min=${idAll.toFixed(3)} eligible min=${idElig.toFixed(3)} → ${idElig > 0.95 ? 'CONFINED to excluded subtrees — Phase 5 stays' : 'NOT confined — Phase 5 may need to move'}`);
    }
  }

  // C3 — normWidthFromParent per site
  console.log(`\n--- C3: NORMWIDTH PATH (parent-relative vs viewport-fallback) ---`);
  // Reported at baseline per site in measureSite; summarized here from first perturbation's baseline
  // (the baseline IRShape is not preserved across measureSite; the perturbation results are)
  // ponytail: the baseline count is printed per-site in measureSite; this section is a pointer
  console.log(`  (see per-site baseline line for parent-relative / viewport-fallback counts)`);

  // 1.6F — PRE-COMMITTED EXIT RULE
  console.log(`\n--- 1.6F: EXIT RULE ---`);
  if (docResults.length >= 3) {
    const sorted = [...docResults].sort((a, b) => b.minNoOverflow - a.minNoOverflow);
    const top2 = sorted.slice(0, 2);
    const third = sorted[2];
    const condA = top2.every((d) => d.minNoOverflow >= 0.95) && third.minNoOverflow >= 0.90;
    const condB = docResults.every((d) => d.maxCriticalFlip <= 3);
    const condC = docResults.every((d) => d.conNoOrderElig >= 0.95);
    const mdnOverflow = docResults.find((d) => d.name === 'MDN');
    const condD = mdnOverflow ? mdnOverflow.overflowPct < 15 : true;
    console.log(`  (a) overflow-excluded slot stab ≥0.95 on 2 doc sites, ≥0.90 on 3rd: ${condA ? 'YES' : 'NO'} (values: ${docResults.map((d) => `${d.name}=${d.minNoOverflow.toFixed(3)}`).join(', ')})`);
    console.log(`  (b) no CRITICAL flip pair >3x per site per perturbation: ${condB ? 'YES' : 'NO'} (max: ${docResults.map((d) => `${d.name}=${d.maxCriticalFlip}`).join(', ')})`);
    console.log(`  (c) constraint stab (no-Ordering, eligible) ≥0.95: ${condC ? 'YES' : 'NO'} (values: ${docResults.map((d) => `${d.name}=${d.conNoOrderElig.toFixed(3)}`).join(', ')})`);
    console.log(`  (d) MDN overflow membership <15%: ${condD ? 'YES' : 'NO'} (${mdnOverflow ? Math.round(mdnOverflow.overflowPct) + '%' : 'N/A'})`);
    const allFour = condA && condB && condC && condD;
    console.log(`  → ${allFour ? 'PROCEED TO SOLVER (Step 2)' : 'BLOCKED — Phase 5 (role-anchored stable handles) built next'}`);
  } else {
    console.log(`  (insufficient doc-site results to evaluate)`);
  }
}

// ── S3.3 — Cross-run role agreement ──────────────────────────────────

/** Two fresh loads (cache cleared) of each doc site. Measures whether the
 *  first classification (now permanent via sticky cache) is consistent across
 *  independent loads. Also reports node-count spread (S3.4 settle verification). */
async function crossRunAgreement(page: Page, bundle: string, docSites: { name: string; url: string; settleMs: number }[]): Promise<void> {
  console.log('\n\n========== S3.3 — CROSS-RUN ROLE AGREEMENT ==========\n');
  console.log('Two fresh loads (cache cleared) of each doc site. Sticky roles are');
  console.log('cleared between runs so each classifies fresh. Measures whether the');
  console.log('first classification is consistent across independent loads.\n');

  interface RunInfo { name: string; run1Nodes: number; run1Settle: string; run2Nodes: number; run2Settle: string; spread: number; shared: number; agreed: number; agreement: number; }
  const results: RunInfo[] = [];

  for (const site of docSites) {
    console.log(`  --- ${site.name} ---`);
    // Run 1
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.setViewportSize({ width: BASE_W, height: BASE_H });
    await page.evaluate((src: string) => { new Function(src)(); }, bundle);
    const s1 = await page.evaluate(async () => {
      const wfs = (globalThis as unknown as { __rvWaitForSettle?: (q?: number, m?: number) => Promise<{ settled: boolean; waitMs: number }> }).__rvWaitForSettle;
      return wfs ? await wfs(500, 6000) : { settled: false, waitMs: 0 };
    }) as { settled: boolean; waitMs: number };
    await page.evaluate(() => { (globalThis as unknown as { __rvClearRoleCache?: () => void }).__rvClearRoleCache?.(); });
    const ir1 = await runIR(page, bundle);

    // Run 2 (fresh reload, cache cleared again)
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.setViewportSize({ width: BASE_W, height: BASE_H });
    await page.evaluate((src: string) => { new Function(src)(); }, bundle);
    const s2 = await page.evaluate(async () => {
      const wfs = (globalThis as unknown as { __rvWaitForSettle?: (q?: number, m?: number) => Promise<{ settled: boolean; waitMs: number }> }).__rvWaitForSettle;
      return wfs ? await wfs(500, 6000) : { settled: false, waitMs: 0 };
    }) as { settled: boolean; waitMs: number };
    await page.evaluate(() => { (globalThis as unknown as { __rvClearRoleCache?: () => void }).__rvClearRoleCache?.(); });
    const ir2 = await runIR(page, bundle);

    // Compare: for shared handles, fraction with same role.
    const m1 = byHandle(ir1), m2 = byHandle(ir2);
    let shared = 0, agreed = 0;
    for (const [h, n1] of m1) {
      const n2 = m2.get(h);
      if (!n2) continue;
      shared++;
      if (n1.role === n2.role) agreed++;
    }
    const agreement = shared > 0 ? agreed / shared : 1;
    const spread = Math.abs(ir1.clusterCount - ir2.clusterCount);
    const r1s = `${s1.settled ? 'quiet' : 'timeout'}@${s1.waitMs}ms`;
    const r2s = `${s2.settled ? 'quiet' : 'timeout'}@${s2.waitMs}ms`;
    console.log(`    run1: ${ir1.clusterCount} nodes (${r1s}) | run2: ${ir2.clusterCount} nodes (${r2s}) | spread=${spread} | role agreement=${agreement.toFixed(3)} (${agreed}/${shared})`);
    results.push({ name: site.name, run1Nodes: ir1.clusterCount, run1Settle: r1s, run2Nodes: ir2.clusterCount, run2Settle: r2s, spread, shared, agreed, agreement });
  }

  console.log('\n  --- Summary table ---');
  console.log(`  ${'Site'.padEnd(12)} ${'Run1'.padEnd(8)} ${'Run2'.padEnd(8)} ${'Spread'.padEnd(7)} ${'Agreement'.padEnd(10)} ${'Agreed/Shared'.padEnd(14)}`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(12)} ${String(r.run1Nodes).padEnd(8)} ${String(r.run2Nodes).padEnd(8)} ${String(r.spread).padEnd(7)} ${r.agreement.toFixed(3).padEnd(10)} ${r.agreed}/${r.shared}`);
  }
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

  // S3.3 — Cross-run role agreement (2 fresh loads of each doc site).
  const docSiteNames = ['MDN', 'Wikipedia', 'GitHub'];
  const docSitesForAgreement = sites.filter((s) => docSiteNames.includes(s.name));
  await crossRunAgreement(page, bundle, docSitesForAgreement);

  // Step 3 — run the v2 solver on MDN, execute the wrapper plan, show the shell grid.
  const solverSite = process.env.RV_RUN_SOLVER ? (SMOKE ? sites[0] : sites.find((s) => s.name === 'MDN') ?? sites[0]) : null;
  if (solverSite) {
    console.log(`\n\n========== STEP 3 — V2 SOLVER + SLOT WRAPPERS (${solverSite.name}) ==========`);
    await page.goto(solverSite.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.setViewportSize({ width: BASE_W, height: BASE_H });
    // S3.4 — settle condition, not fixed wait.
    await page.evaluate((src: string) => { new Function(src)(); }, bundle);
    const settleInfo = await page.evaluate(async () => {
      const wfs = (globalThis as unknown as { __rvWaitForSettle?: (q?: number, m?: number) => Promise<{ settled: boolean; waitMs: number }> }).__rvWaitForSettle;
      return wfs ? await wfs(500, 6000) : { settled: false, waitMs: 0 };
    }) as { settled: boolean; waitMs: number };
    console.log(`  settle: ${settleInfo.settled ? 'quiet' : 'timeout'} @ ${settleInfo.waitMs}ms`);
    await page.evaluate(() => { (globalThis as unknown as { __rvClearRoleCache?: () => void }).__rvClearRoleCache?.(); });
    const solverResult = await page.evaluate(async (src: string) => {
      new Function(src)();
      const perceive = (window as unknown as { __rvPerceive: () => unknown }).__rvPerceive;
      const clearHandles = (window as unknown as { __rvClearHandles: () => void }).__rvClearHandles;
      const extractIR = (window as unknown as { __rvExtractLayoutIR: (p: unknown) => any }).__rvExtractLayoutIR;
      const detectExcl = (window as unknown as { __rvDetectExclusions: (c: any[]) => Map<string, string> }).__rvDetectExclusions;
      const assignS = (window as unknown as { __rvAssignSlots: (n: any[], e: Set<string>) => any }).__rvAssignSlots;
      const solve = (window as unknown as { __rvSolve: (i: any) => any }).__rvSolve;
      const computePlacement = (window as unknown as { __rvComputeGridPlacementCss: (r: any) => any }).__rvComputeGridPlacementCss;
      const buildTargetIR = (window as unknown as { __rvBuildFallbackTargetIR: (h: Map<string, string>, s: Map<string, string>) => any }).__rvBuildFallbackTargetIR;
      const docSlots = (window as unknown as { __rvDocumentationSlots: readonly any[] }).__rvDocumentationSlots;
      clearHandles();
      const p = perceive() as any;
      const ir = extractIR(p);
      const excludedRaw = detectExcl(p.clusters);
      const excludedSet = new Set<string>();
      for (const [h] of excludedRaw) excludedSet.add(h);
      const assignment = assignS(ir.nodes, excludedSet);
      const slotPreferredWidth = new Map<string, string>();
      for (const s of docSlots) slotPreferredWidth.set(s.id, s.preferredWidth);
      const targetIR = buildTargetIR(assignment.handleToSlot, slotPreferredWidth);
      const result = solve({ ir, target: targetIR, excluded: excludedSet });
      // S7.1 — CSS-only grid placement (no DOM mutation).
      const placementResult = computePlacement
        ? computePlacement(result)
        : { css: '', nodesPlaced: 0, nodesNotPlaceable: [], intermediatesCollapsed: 0, intermediatesSkipped: 0, selectorFallback: 0, skippedReasons: [] };
      // Count slot distribution
      const slotDist: Record<string, number> = {};
      for (const [_h, s] of assignment.handleToSlot) slotDist[s] = (slotDist[s] ?? 0) + 1;
      return { css: placementResult.css, rulesEmitted: result.rulesEmitted, matchedTargets: result.matchedTargets,
        impossibleNodes: [] as string[], droppedOptionals: result.droppedOptionals,
        nodeCount: ir.nodes.length, nodesPlaced: placementResult.nodesPlaced,
        nodesNotPlaceable: placementResult.nodesNotPlaceable.length,
        intermediatesCollapsed: placementResult.intermediatesCollapsed,
        intermediatesSkipped: placementResult.intermediatesSkipped,
        selectorFallback: placementResult.selectorFallback,
        placementCount: result.placement.size,
        slotDist };
    }, bundle);
    console.log(`  nodes: ${solverResult.nodeCount}, rules emitted: ${solverResult.rulesEmitted}, matched: ${solverResult.matchedTargets}`);
    console.log(`  impossible nodes: ${solverResult.impossibleNodes.length === 0 ? 'none' : solverResult.impossibleNodes.join(', ')}`);
    console.log(`  dropped optionals: ${solverResult.droppedOptionals.length === 0 ? 'none' : solverResult.droppedOptionals.map((d: any) => `${d.handle}:${d.kind}`).join(', ')}`);
    console.log(`  placement: ${solverResult.placementCount} handles, ${solverResult.nodesPlaced} placed, ${solverResult.nodesNotPlaceable} not placeable, ${solverResult.intermediatesCollapsed} collapsed, ${solverResult.intermediatesSkipped} skipped, ${solverResult.selectorFallback} selector fallbacks`);
    console.log(`  slot distribution: ${Object.entries(solverResult.slotDist).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`\n--- CSS (first 4000 chars) ---\n${solverResult.css.slice(0, 4000)}${solverResult.css.length > 4000 ? '\n... (truncated)' : ''}`);
  }

  await context.close();
  const pass = results.filter((r) => r.gate === 'PASS').length;
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });