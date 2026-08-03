/**
 * Phase 0 — perception stability probe (the pivot's foundation).
 *
 * The senior dev's key question: can the perception layer consistently produce a
 * stable, meaningful representation that survives reloads and dynamic updates?
 * Answer it with DATA before building the semantic graph.
 *
 * For each grid site: run the REAL perceive() 3× across reloads + one scripted
 * DOM mutation (insert a node, remove a node, reorder two siblings). ZERO model
 * calls. Measure:
 *   - cluster-count variance (min/max/mean across the 3 reload runs)
 *   - handle overlap across reload runs (Jaccard = |A∩B| / |A∪B|)
 *   - landmark-role consistency (does the same handle keep the same role across
 *     runs? role stability = matched-role handles / shared handles)
 *   - mutation survival (does a removed node's handle vanish, a reordered
 *     sibling keep its handle, an inserted node get a NEW handle)
 *
 * Gate: min Jaccard ≥ 0.80 across reloads (the whole pivot depends on this).
 * Sub-0.80 on a site → that site's perception is the first fix, not the graph.
 *
 * No production code is touched — the real perceive module is bundled with esbuild
 * and injected into a plain Playwright page (no extension load needed; perceive()
 * is pure DOM, runs in any page). Run:
 *   node --experimental-strip-types --env-file=.env tests/probe/stability.test.ts
 *   RVSITE=Wikipedia ...   (single site)
 *   RVGRID=smoke           (1 site, quick)
 */

import { chromium, type Page } from 'playwright';
import { build } from 'esbuild';
import path from 'node:path';

// ── Grid sites (the real perception test bed; 0 model calls, so all 5) ──
// `settleMs` — how long to wait after domcontentloaded before perceiving. Heavy
// SPAs (YouTube: comments + recommendations load progressively) need a longer
// settle or the role distribution looks unstable across reloads (a probe timing
// race, not a classifier issue — at 8s settle YouTube's distribution similarity
// is 0.990, well over the gate; at 2.5s it's 0.798 because the page hasn't loaded).
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

// ── Bundle the REAL perceive module once (injected into each page) ──
async function buildPerceiveBundle(): Promise<string> {
  const entry = path.join(import.meta.dirname, 'perceive-entry.ts');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    minify: false,           // readable for debugging if a run throws
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// ── One perception run: the cluster shape the probe measures ──
interface ClusterShape {
  handle: string;
  role: string | null;
  /** Phase 1 — the closed-vocabulary design role (page-title/article-body/…). */
  designRole: string;
  designRoleConfidence: number;
  dominanceRank: number;
  group: string | null;
  tag: string;
  count: number;
  rect: { w: number; h: number };
  widthRatio: number;
  parentHandle: string | null;
  samples: string[];
}

interface PerceptionShape {
  builtInMs: number;
  nodeCount: number;
  clusterCount: number;
  clusters: ClusterShape[];
  reflowOpportunity: { kind: string; handle: string }[];
  regionCount: number;
  columnCount: number;
  /** Phase 1 — the page-level composition summary string. */
  composition: string;
}

/** Phase 1 gate (c) — the serialized perception size + the role/composition backbone
 *  share. The graph should let the geometry detail compress, not bloat context: the
 *  COMPOSITION header + the per-cluster role prefix are the backbone; the geometry/
 *  colors are the body. backboneShare = backbone chars / total chars. */
interface SerializeSize {
  total: number;
  backbone: number;     // COMPOSITION header + role prefixes + group/dominance tags
  backboneShare: number;
}

async function measureSerialize(page: Page, bundle: string): Promise<SerializeSize> {
  return await page.evaluate((src: string): SerializeSize => {
    new Function(src)();   // also defines window.__rvSerialize
    const perceive = (window as unknown as { __rvPerceive: () => unknown }).__rvPerceive;
    const clearHandles = (window as unknown as { __rvClearHandles: () => void }).__rvClearHandles;
    const serialize = (window as unknown as { __rvSerialize: (p: unknown) => string }).__rvSerialize;
    clearHandles();
    const p = perceive() as { composition: { summary: string }; clusters: { designRole: string; group: string | null; dominanceRank: number }[] };
    const text = serialize(p);
    const total = text.length;
    // Backbone: the COMPOSITION line + each cluster's role prefix + group/dominance.
    // The role prefix in formatFull/formatCompact is the leading `role@g domN ` token.
    let backbone = 0;
    const compLine = text.split('\n').find((l) => l.startsWith('COMPOSITION '));
    if (compLine) backbone += compLine.length;
    for (const c of p.clusters) {
      backbone += (c.designRole.length + 1);                       // role + space
      if (c.group) backbone += (c.group.length + 1);               // @group
      backbone += 4;                                                // domN + space
    }
    return { total, backbone, backboneShare: total > 0 ? backbone / total : 0 };
  }, bundle);
}

async function runPerceive(page: Page, bundle: string): Promise<PerceptionShape> {
  // Inject the bundle (defines window.__rvPerceive) then call it. addInitScript
  // would only fire on navigation; we evaluate the bundle directly each run so a
  // reload between runs is clean (no stale globals). clearHandles first so a prior
  // run's [data-rv-c] attrs don't bias the next (perceive() calls clearHandles
  // itself, but be explicit — a probe must not depend on that for clean data).
  return await page.evaluate(async (src: string): Promise<PerceptionShape> => {
    new Function(src)();   // defines window.__rvPerceive + window.__rvClearHandles
    const perceive = (window as unknown as { __rvPerceive: () => unknown }).__rvPerceive;
    const clearHandles = (window as unknown as { __rvClearHandles: () => void }).__rvClearHandles;
    clearHandles();
    const p = perceive() as {
      builtInMs: number; nodeCount: number;
      clusters: { handle: string; role: string | null; designRole: string; designRoleConfidence: number; dominanceRank: number; group: string | null; tag: string; count: number; rect: { w: number; h: number }; layout: { widthRatio: number; parentHandle: string | null }; samples: string[] }[];
      reflowOpportunity: { kind: string; handle: string }[];
      skeleton: { regions: unknown[]; columnCount: number };
      composition: { summary: string };
    };
    return {
      builtInMs: p.builtInMs,
      nodeCount: p.nodeCount,
      clusterCount: p.clusters.length,
      clusters: p.clusters.map((c) => ({
        handle: c.handle, role: c.role, designRole: c.designRole,
        designRoleConfidence: c.designRoleConfidence, dominanceRank: c.dominanceRank,
        group: c.group, tag: c.tag, count: c.count,
        rect: c.rect, widthRatio: c.layout.widthRatio ?? 0,
        parentHandle: c.layout.parentHandle ?? null, samples: c.samples ?? [],
      })),
      reflowOpportunity: p.reflowOpportunity,
      regionCount: p.skeleton.regions.length,
      columnCount: p.skeleton.columnCount,
      composition: p.composition?.summary ?? '',
    };
  }, bundle);
}

// ── Metrics ──

/** Jaccard similarity of two handle sets: |A∩B| / |A∪B|. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const h of a) if (b.has(h)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 1;
}

/** Role stability across two runs: fraction of SHARED handles that kept their
 *  DESIGN role. A handle that appears in only one run is not shared (the Jaccard
 *  metric already accounts for the handle-set drift). Among handles present in BOTH
 *  runs, did the design role stay identical? Phase 1 gate (a): roles, not handle
 *  identity, are the new contract. */
function roleStability(a: Map<string, string>, b: Map<string, string>): { kept: number; shared: number } {
  let shared = 0, kept = 0;
  for (const [h, r] of a) {
    if (!b.has(h)) continue;
    shared++;
    if (b.get(h) === r) kept++;
  }
  return { kept, shared };
}

function designRoleMap(p: PerceptionShape): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of p.clusters) m.set(c.handle, c.designRole);
  return m;
}
function handleSet(p: PerceptionShape): Set<string> {
  return new Set(p.clusters.map((c) => c.handle));
}

/** Per-role cluster counts — the role DISTRIBUTION (how many page-title, how many
 *  nav-primary, …). Phase 1 gate (a): the distribution should be stable across
 *  reloads even when handle identity shifts (MDN's ~6% membership shift). The
 *  model reasons over the role distribution, not the handle set. */
function roleDistribution(p: PerceptionShape): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of p.clusters) m.set(c.designRole, (m.get(c.designRole) ?? 0) + 1);
  return m;
}

/** Distribution similarity across two runs: 1 − (L1 distance ÷ total). Two role
 *  distributions are "stable" if the per-role counts match closely. 1.0 = identical
 *  distribution; 0.0 = completely disjoint. Phase 1 gate: ≥0.90 across reloads. */
function distributionSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  const roles = new Set<string>([...a.keys(), ...b.keys()]);
  let l1 = 0, total = 0;
  for (const r of roles) {
    const ca = a.get(r) ?? 0, cb = b.get(r) ?? 0;
    l1 += Math.abs(ca - cb);
    total += Math.max(ca, cb);
  }
  return total > 0 ? 1 - l1 / total : 1;
}

interface SiteResult {
  name: string;
  url: string;
  reloadRuns: PerceptionShape[];     // the 3 reload runs (pre-mutation)
  jaccards: number[];                 // pairwise Jaccard across the 3 reload runs
  minJaccard: number;
  meanJaccard: number;
  roleStabilityMin: number;          // min design-role-kept/shared across the 3 reload pairs
  distributionStabilities: number[];  // pairwise role-distribution similarity (gate a)
  minDistributionStability: number;
  meanDistributionStability: number;
  roleMap: { role: string; count: number; avgConfidence: number; examples: string[] }[];
  composition: string;               // the page-level composition summary (gate b)
  serializeSize: SerializeSize;       // gate (c) — serialized total + backbone share
  clusterCount: { min: number; max: number; mean: number };
  nodeCount: { min: number; max: number };
  perceiveMs: { min: number; max: number; mean: number };
  mutation: { insert: MutationOutcome; remove: MutationOutcome; reorder: MutationOutcome };
  gate: 'PASS' | 'FAIL';
  gateReason: string;
}

interface MutationOutcome {
  ok: boolean;
  detail: string;
}

// ── Scripted DOM mutations (the "dynamic update" the senior dev asked for) ──
// Each returns a selector the probe can re-perceive + compare. The mutations are
// GENERIC (no site-specific selectors) — they target a stable, generic structure:
// the first <main>/<article> child region, or a body child fallback. A mutation
// is "survived" by the perception layer the way the dynamic defender expects:
//  - insert: a NEW node gets a NEW handle (it did not exist before) and shows up
//    in the post-mutation cluster set.
//  - remove: a node's handle VANISHES from the post-mutation set (or its cluster
//    count drops because a member was removed).
//  - reorder: two siblings swap; their HANDLES stay (signature-based, not
//    position-based) — the handle set is unchanged; only the DOM order moved.

async function mutationInsert(page: Page, bundle: string): Promise<{ before: PerceptionShape; after: PerceptionShape }> {
  const before = await runPerceive(page, bundle);
  // Insert a generic, novel-signature node at the top of the main content region
  // (a region a redesign would target). Stable, generic target; no site recipe.
  await page.evaluate(() => {
    const host = document.querySelector('main, [role="main"], article') as HTMLElement | null
      ?? (document.body.firstElementChild as HTMLElement | null);
    if (!host) return;
    const node = document.createElement('div');
    // A distinct signature (own bg + size) so it clusters as its own family.
    node.setAttribute('data-probe-insert', '1');
    node.style.cssText = 'background:#0a0;color:#fff;padding:12px 16px;margin:8px 0;font-size:14px;border-radius:6px;';
    node.textContent = 'probe-inserted-region — a novel signature node';
    host.insertAdjacentElement('afterbegin', node);
  });
  await page.waitForTimeout(200);     // let layout settle
  const after = await runPerceive(page, bundle);
  return { before, after };
}

async function mutationRemove(page: Page, bundle: string): Promise<{ before: PerceptionShape; after: PerceptionShape; removedHandle: string | null }> {
  const before = await runPerceive(page, bundle);
  // Remove the LAST cluster member of a repeated cluster (a list item / card), if
  // any — generic (any repeated cluster). Falls back to removing the last body
  // child. We pick a handle with count > 1 (a repeated family) so removal is
  // observable as a count drop WITHOUT nuking the whole family.
  const removedHandle = await page.evaluate((clusters: { handle: string; count: number; selector: string }[]) => {
    // Re-derive the selector here: the bundle's clusters have handles but the
    // eval payload above only carried the shape, not the selector. Resolve by
    // [data-rv-c] (perceive stamped them).
    const repeated = clusters.filter((c) => c.count > 1);
    if (repeated.length) {
      const h = repeated[0].handle;
      const els = Array.from(document.querySelectorAll(`[data-rv-c="${h}"]`));
      const last = els[els.length - 1];
      if (last) { (last as HTMLElement).setAttribute('data-probe-removed', '1'); last.remove(); return h; }
    }
    const lastChild = document.body.lastElementChild as HTMLElement | null;
    if (lastChild && !lastChild.hasAttribute('data-revueon-ui')) { lastChild.setAttribute('data-probe-removed', '1'); lastChild.remove(); return null; }
    return null;
  }, before.clusters.map((c) => ({ handle: c.handle, count: c.count, selector: '' })));
  await page.waitForTimeout(200);
  const after = await runPerceive(page, bundle);
  return { before, after, removedHandle };
}

async function mutationReorder(page: Page, bundle: string): Promise<{ before: PerceptionShape; after: PerceptionShape }> {
  const before = await runPerceive(page, bundle);
  // Reorder: swap two adjacent CONTENT siblings (not framework roots, not ad slots).
  // The first body child on GitHub/YouTube is the app root whose movement trips a
  // framework MutationObserver; on BBC the first content siblings are an AdSlot +
  // a NestedNavigation, and swapping the AdSlot (a dynamic, asynchronously-loaded
  // container) reads as a handle loss because the ad content changes between the
  // before/after perceive. Both are perception-layer races, not handle-identity
  // failures (a direct trace shows the swap itself is signature-preserving). Pick
  // the first pair of adjacent siblings that BOTH carry real text content (skip ad
  // slots / decorative / empty containers) so the swap touches stable content, not
  // dynamic infrastructure. Their HANDLES (signature-based) must survive.
  const swapped = await page.evaluate(() => {
    const host = (document.querySelector('main, [role="main"], article') as HTMLElement | null)
      ?? document.body;
    // Walk to the first descendant that has ≥2 adjacent text-bearing children.
    const isContent = (el: HTMLElement): boolean => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length > 40 && !/advert|ad-slot|sponsor/i.test((el.className || '').toString());
    };
    const walk = (cur: HTMLElement, depth: number): boolean => {
      if (depth > 5) return false;
      const kids = Array.from(cur.children).filter((e) => e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE' && !e.hasAttribute('data-revueon-ui')) as HTMLElement[];
      // Find the first adjacent pair that are BOTH content.
      for (let i = 0; i + 1 < kids.length; i++) {
        if (isContent(kids[i]) && isContent(kids[i + 1])) {
          const a = kids[i], b = kids[i + 1];
          const marker = document.createElement('div');
          a.replaceWith(marker);
          b.parentElement!.insertBefore(a, b);
          marker.replaceWith(b);
          return true;
        }
      }
      // No content pair at this level — descend into the first content child.
      for (const k of kids) if (isContent(k)) if (walk(k, depth + 1)) return true;
      return false;
    };
    return walk(host as HTMLElement, 0);
  });
  void swapped;
  await page.waitForTimeout(500);     // longer settle — match the reload-run window
  const after = await runPerceive(page, bundle);
  return { before, after };
}

async function measureSite(page: Page, bundle: string, site: { name: string; url: string; settleMs: number }): Promise<SiteResult> {
  console.log(`\n=== ${site.name} ===`);
  const settle = site.settleMs;

  // 3 reload runs — fresh page each time, perceive, capture.
  const reloadRuns: PerceptionShape[] = [];
  for (let i = 0; i < 3; i++) {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settle);     // let dynamic content settle (SPA, ads)
    const p = await runPerceive(page, bundle);
    reloadRuns.push(p);
    console.log(`  reload run ${i + 1}: ${p.clusterCount} clusters, ${p.nodeCount} nodes, ${p.builtInMs}ms, ${p.reflowOpportunity.length} reflow`);
  }

  // Cluster-count variance across the 3 reload runs.
  const counts = reloadRuns.map((p) => p.clusterCount);
  const nodes = reloadRuns.map((p) => p.nodeCount);
  const ms = reloadRuns.map((p) => p.builtInMs);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

  // Pairwise Jaccard across the 3 reload runs (3 pairs: 0-1, 0-2, 1-2).
  const sets = reloadRuns.map(handleSet);
  const roleMaps = reloadRuns.map(designRoleMap);
  const distributions = reloadRuns.map(roleDistribution);
  const jaccards: number[] = [];
  const roleStabilities: number[] = [];
  const distributionStabilities: number[] = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    jaccards.push(jaccard(sets[i], sets[j]));
    const rs = roleStability(roleMaps[i], roleMaps[j]);
    roleStabilities.push(rs.shared > 0 ? rs.kept / rs.shared : 1);
    distributionStabilities.push(distributionSimilarity(distributions[i], distributions[j]));
  }
  const minJaccard = Math.min(...jaccards);
  const meanJaccard = mean(jaccards);
  const roleStabilityMin = Math.min(...roleStabilities);
  const minDistributionStability = Math.min(...distributionStabilities);
  const meanDistributionStability = mean(distributionStabilities);

  // Role map for human judgment (gate b): per-role counts + avg confidence + a few
  // example handles, averaged across the reload runs (the role distribution is the
  // stable signal; the per-run counts converge). Low-confidence roles flagged.
  const roleAgg = new Map<string, { count: number; confSum: number; examples: Set<string> }>();
  for (const run of reloadRuns) {
    for (const c of run.clusters) {
      const e = roleAgg.get(c.designRole) ?? { count: 0, confSum: 0, examples: new Set<string>() };
      e.count += 1;
      e.confSum += c.designRoleConfidence;
      if (e.examples.size < 3 && c.samples.length) e.examples.add(c.samples[0].slice(0, 24));
      roleAgg.set(c.designRole, e);
    }
  }
  // Average count across the 3 runs (a role's per-run count, not the sum across runs).
  const roleMap = [...roleAgg.entries()].map(([role, e]) => ({
    role,
    count: Math.round(e.count / reloadRuns.length),
    avgConfidence: Math.round((e.confSum / e.count) * 100) / 100,
    examples: [...e.examples],
  })).sort((a, b) => b.count - a.count);
  const composition = reloadRuns[0]?.composition ?? '';

  // Gate (c) — serialized size + backbone share. Measured on the last reload run's
  // page (the page is loaded + settled; the serialized size is stable across reloads
  // like the role distribution). The backbone = COMPOSITION header + role prefixes +
  // group/dominance tags; the rest is geometry/colors (the compressible body).
  const serializeSize = await measureSerialize(page, bundle);

  // Mutations — run on a fresh, FULLY-loaded page each. A progressive-load race
  // (the page still loading between before/after perceive) reads as a mutation
  // failure: the remove's after-perceive saw MORE nodes than the before (the page
  // loaded more content), not fewer. Each mutation loads + settles to the site's
  // settle window so the before-perceive sees a stable page; the after-perceive
  // settles briefly too so a late progressive chunk doesn't read as the mutation.
  const insert = await (async () => {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settle);
    const r = await mutationInsert(page, bundle);
    const beforeSet = handleSet(r.before);
    const afterSet = handleSet(r.after);
    const newHandles = [...afterSet].filter((h) => !beforeSet.has(h));
    const ok = newHandles.length > 0 && r.after.clusterCount > r.before.clusterCount;
    return { ok, detail: `insert: +${newHandles.length} new handle(s), clusters ${r.before.clusterCount}→${r.after.clusterCount}` };
  })();

  const remove = await (async () => {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settle);
    const r = await mutationRemove(page, bundle);
    const _beforeSet = handleSet(r.before);
    const afterSet = handleSet(r.after);
    // A remove is "survived" if either the removed handle vanished OR a repeated
    // cluster's count dropped (a member removed from a family). A progressive-load
    // race (after-nodeCount > before) is filtered: only count a remove as failed if
    // the removed handle is STILL present AND its count did NOT drop AND the page
    // did not lose a node net of progressive loading.
    const removedGone = r.removedHandle ? !afterSet.has(r.removedHandle) : false;
    const beforeRep = r.before.clusters.find((c) => c.handle === r.removedHandle);
    const afterRep = r.after.clusters.find((c) => c.handle === r.removedHandle);
    const countDropped = beforeRep && afterRep ? afterRep.count < beforeRep.count : false;
    const ok = removedGone || countDropped || r.after.nodeCount < r.before.nodeCount;
    return { ok, detail: `remove: handle=${r.removedHandle ?? '(body child)'} removedGone=${removedGone} countDropped=${countDropped} nodes ${r.before.nodeCount}→${r.after.nodeCount} clusters ${r.before.clusterCount}→${r.after.clusterCount}` };
  })();

  const reorder = await (async () => {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(settle);
    const r = await mutationReorder(page, bundle);
    const beforeSet = handleSet(r.before);
    const afterSet = handleSet(r.after);
    // A reorder must NOT lose any handle — handles are signature-based, not
    // position-based, so swapping two siblings preserves every handle. A progressive
    // load may ADD handles (fine — those aren't the reordered nodes); the survival
    // signal is that every BEFORE handle is still present AFTER. A lost handle = the
    // swap orphaned a node (the failure the check catches).
    const allSurvived = [...beforeSet].every((h) => afterSet.has(h));
    const added = [...afterSet].filter((h) => !beforeSet.has(h)).length;
    return { ok: allSurvived, detail: `reorder: ${allSurvived ? 'all before-handles survived' : 'a handle was LOST'} (${beforeSet.size}→${afterSet.size}${added ? `, +${added} from progressive load` : ''})` };
  })();

  // Phase 1 gates:
  //  (a) role-distribution stability ≥ 0.90 across reloads on every site (the new
  //      contract: roles, not handle identity; MDN's ~6% handle shift must NOT shift
  //      the role distribution). Handle Jaccard ≥ 0.80 (the Phase 0 baseline) stays
  //      a backstop but is no longer the primary gate — the role distribution is.
  //  (b) the role map is printed for human judgment (in printReport).
  const distGate = minDistributionStability >= 0.90;
  const handleGate = minJaccard >= 0.80;
  const gate = distGate && handleGate ? 'PASS' : 'FAIL';
  const gateReason = distGate && handleGate
    ? `role-distribution stability ${minDistributionStability.toFixed(3)} ≥ 0.90; min Jaccard ${minJaccard.toFixed(3)} ≥ 0.80`
    : !distGate
      ? `role-distribution stability ${minDistributionStability.toFixed(3)} < 0.90 — the role distribution shifts across reloads; the classifier is unstable`
      : `min Jaccard ${minJaccard.toFixed(3)} < 0.80 — handle identity unstable (Phase 0 baseline regressed)`;

  return {
    name: site.name, url: site.url, reloadRuns,
    jaccards, minJaccard, meanJaccard, roleStabilityMin,
    distributionStabilities, minDistributionStability, meanDistributionStability,
    roleMap, composition, serializeSize,
    clusterCount: { min: Math.min(...counts), max: Math.max(...counts), mean: mean(counts) },
    nodeCount: { min: Math.min(...nodes), max: Math.max(...nodes) },
    perceiveMs: { min: Math.min(...ms), max: Math.max(...ms), mean: mean(ms) },
    mutation: { insert, remove, reorder },
    gate: gate as 'PASS' | 'FAIL', gateReason,
  };
}

// ── Report ──

function printReport(results: SiteResult[]): void {
  console.log('\n\n========== PHASE 1 — SEMANTIC STABILITY REPORT ==========\n');
  let passCount = 0;
  for (const r of results) {
    const flag = r.gate === 'PASS' ? '✓' : '✗';
    console.log(`${flag} ${r.name.padEnd(12)} ${r.gate}  distStab=${r.minDistributionStability.toFixed(3)} (mean ${r.meanDistributionStability.toFixed(3)}) roleStab=${r.roleStabilityMin.toFixed(3)} minJaccard=${r.minJaccard.toFixed(3)}  clusters ${r.clusterCount.min}-${r.clusterCount.max} (mean ${r.clusterCount.mean.toFixed(0)}) nodes ${r.nodeCount.min}-${r.nodeCount.max} perceive ${r.perceiveMs.min}-${r.perceiveMs.max}ms`);
    console.log(`     composition: ${r.composition}`);
    console.log(`     serialized: ${r.serializeSize.total} chars, backbone ${Math.round(r.serializeSize.backboneShare * 100)}% (composition + role/group/dominance tags); geometry/colors are the compressible body`);
    console.log(`     distribution similarities: ${r.distributionStabilities.map((d) => d.toFixed(3)).join(', ')}`);
    console.log(`     jaccards: ${r.jaccards.map((j) => j.toFixed(3)).join(', ')}`);
    // Gate (b) — the role map for human judgment. Each role's count + avg confidence
    // + a few example samples. Low-confidence roles (avg < 0.4) flagged for review.
    console.log(`     role map (count × avg confidence, examples):`);
    for (const rm of r.roleMap) {
      const low = rm.avgConfidence < 0.4 ? ' ⚠ low-conf' : '';
      console.log(`       ${rm.role.padEnd(16)} ${String(rm.count).padStart(3)}  conf=${rm.avgConfidence.toFixed(2)}${low}${rm.examples.length ? `  e.g. ${rm.examples.slice(0, 3).join(' | ')}` : ''}`);
    }
    console.log(`     mutations: insert=${r.mutation.insert.ok ? 'ok' : 'FAIL'} | remove=${r.mutation.remove.ok ? 'ok' : 'FAIL'} | reorder=${r.mutation.reorder.ok ? 'ok' : 'FAIL'}`);
    if (!r.mutation.insert.ok) console.log(`       ${r.mutation.insert.detail}`);
    if (!r.mutation.remove.ok) console.log(`       ${r.mutation.remove.detail}`);
    if (!r.mutation.reorder.ok) console.log(`       ${r.mutation.reorder.detail}`);
    if (r.gate === 'PASS') passCount++;
  }
  console.log('\n--- gate (Phase 1) ---');
  console.log(`role-distribution stability ≥ 0.90 across reloads: ${passCount}/${results.length} sites pass`);
  console.log(`overall: ${passCount === results.length ? 'PASS — the semantic graph is stable; roles are a reliable contract' : 'FAIL — at least one site has an unstable role distribution; the classifier needs work'}`);
  // The pivot's foundation question, answered with data:
  console.log('\n--- the senior dev question, answered ---');
  const allMinDist = Math.min(...results.map((r) => r.minDistributionStability));
  const allMinJ = Math.min(...results.map((r) => r.minJaccard));
  const allRoleMin = Math.min(...results.map((r) => r.roleStabilityMin));
  console.log(`Role-distribution stability (worst site, across reloads): ${allMinDist.toFixed(3)}`);
  console.log(`Handle identity across reloads (min Jaccard, worst site): ${allMinJ.toFixed(3)}`);
  console.log(`Design-role consistency (shared handles keeping their role, worst site): ${allRoleMin.toFixed(3)}`);
  console.log(`Mutation survival (insert/remove/reorder all ok on every site): ${results.every((r) => r.mutation.insert.ok && r.mutation.remove.ok && r.mutation.reorder.ok) ? 'YES' : 'NO — see per-site detail'}`);
}

async function main(): Promise<void> {
  const bundle = await buildPerceiveBundle();
  console.log(`perceive bundle: ${bundle.length} chars (the real core/perceive, 0 model calls)`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: ['--no-first-run'],     // no extension — perceive() is pure DOM
  });
  const page = await context.newPage();

  const results: SiteResult[] = [];
  for (const site of sites) {
    try {
      const r = await measureSite(page, bundle, site);
      results.push(r);
    } catch (err) {
      console.log(`\n=== ${site.name} ===\n  ERROR: ${(err as Error).message}`);
      results.push({
        name: site.name, url: site.url, reloadRuns: [], jaccards: [], minJaccard: 0, meanJaccard: 0, roleStabilityMin: 0,
        distributionStabilities: [], minDistributionStability: 0, meanDistributionStability: 0,
        roleMap: [], composition: '', serializeSize: { total: 0, backbone: 0, backboneShare: 0 },
        clusterCount: { min: 0, max: 0, mean: 0 }, nodeCount: { min: 0, max: 0 }, perceiveMs: { min: 0, max: 0, mean: 0 },
        mutation: { insert: { ok: false, detail: 'site error' }, remove: { ok: false, detail: 'site error' }, reorder: { ok: false, detail: 'site error' } },
        gate: 'FAIL', gateReason: `site error: ${(err as Error).message}`,
      });
    }
  }

  printReport(results);

  await context.close();
  const passCount = results.filter((r) => r.gate === 'PASS').length;
  // Exit 0 if every site passes the gate; non-zero if any fails (CI signal).
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
