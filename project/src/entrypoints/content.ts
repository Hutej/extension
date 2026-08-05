/**
 * content — the page transform orchestrator, running in the page.
 *
 *   perceive -> (background: reason -> DesignSpec) -> compile -> apply CSS
 *            -> verify(before) -> repair loop (recompile / re-reason / keepBest)
 *            -> persist
 *
 * Shadow-aware (inject + defend per open shadow root), SPA-navigation aware
 * (hook pushState/popstate, re-perceive + re-compile on route change), per-URL
 * persistence (origin + normalized pathname).
 */

import { perceive, serializePerception, serializePainterPerception, clearHandles, clearRoleCache, captureLayoutFingerprint, lastSerializeBudget } from '@/core/perceive';
import { compileSpec, type CompileOptions } from '@/core/compile';
import { startMovableHandlers, stopMovableHandlers } from '@/core/interaction/movable';
import { transformIntent, resolveComposition } from '@/core/compile/transform.ts';
import { sanitizeCss } from '@/core/sanitize';
import { redactSensitiveData } from '@/core/sanitize/redact';
import { verifyStyle, checkConformance, type VerifyResult, type ConformanceResult } from '@/core/verify';
import { type PixelVerifyResult, type InvisibleBreakdown } from '@/core/verify/pixel';
import { captureShotAt, captureAndPixelVerify } from '@/core/verify/pixel-capture';
import { classifyInvisible } from '@/core/verify/pixel-classify';
import { checkResizeInvariance, defaultCheckAt, type ResizeCheckResult } from '@/core/verify/resize';
import { planRepair, type Attempt } from '@/core/repair';
import { checkCompleteness, mergeSpecs } from '@/core/spec';
import { applyStyleEverywhere, removeStyleEverywhere, startDefenseEverywhere, ensureEscapeUI, removeEscapeUI } from '@/core/execute';
import { applyInlineBackstop } from '@/core/execute/backstop';
import { loadSiteState, saveSiteState, clearSiteState, storageKey } from '@/core/persist';
import { AI_CONFIG, logDebug } from '@/core/config';
import type { Role } from '@/core/reason';
import type { DesignSpec } from '@/core/spec';
import { TransactionLog } from '@/core/ops/transaction';
import { validateOps, type ValidatedOp } from '@/core/ops';
import { liveDom, executeOps } from '@/core/ops/execute';
import { extractLayoutIR, buildFallbackTargetIR } from '@/core/layout/ir';
import { detectExclusions } from '@/core/layout/exclusions';
import { assignSlots } from '@/core/layout/assign';
import { getLanguage, LANGUAGE_IDS, proposeLanguageCandidates, formatCandidates } from '@/core/layout/languages';
import { solve, computeGridPlacementCss, type SolverPlan } from '@/core/layout/solve';
import { assertPlanHonoured } from '@/core/layout/plan-assert';

interface SpecResponse { ok: boolean; spec?: DesignSpec; kind?: string; message?: string; usage?: unknown; model?: string; callMs?: number; httpRequests?: number; }

/** Per-role call accounting (calls × tokens × wall-clock per role). The budget is
 *  TIME, not calls — per-role calls are OBSERVABILITY, not a gate. */
export interface RoleCall {
  role: Role;
  ms: number;
  promptTokens?: number;
  completionTokens?: number;
  /** true HTTP request count (including retries). Surface this — the UI
   *  reported 1 paid call when up to 5 HTTP requests were made. */
  httpRequests: number;
}

export interface Ledger {
  perceiveMs: number;
  serializeChars: number;
  serializeCharsBefore: number;  // pre-budget char count (demote/drop tail to fit the budget)
  roleCalls: RoleCall[];          // per-role calls (architect/painter/critic) — observability
  compileMs?: number;   // optional — measured when the stage is instrumented
  applyMs?: number;
  verifyMs?: number;
  pixelVerifyMs?: number;   // optional — separated from verifyMs when measured
  persistMs?: number;      // optional — measured when the stage is instrumented
  unaccountedMs?: number;  // optional — computed from real stages, not invented
  totalMs: number;
  paidCalls: number;        // total HTTP requests across roles (includes retries)
  repairRounds: number;     // Critic repair rounds used
  paintCount: number;     // visible repaints (the ≤2 contract)
  opsExecuted: number;      // structural DOM ops executed (remove/move/reorder/wrap)
  opsRefused: number;       // ops refused by guard laws (logged with reasons)
  opsRefusedReasons: string[]; // the `kind(handle:reason)` refusal strings (observability)
  /** escape-hatch metric: handles the model gave raw rules for (the
   *  vocabulary-gap metric). Fraction > ~0.20 = a loud pivot-failure flag. */
  escapeHatchUses?: string[];
  escapeHatchFraction?: number;
  /** conformance to the declared pack (ok + violation count). The
   *  violations are listed verbatim on TransformOutcome.conformance. */
  conformanceOk?: boolean;
  conformanceViolations?: number;
}

export interface TransformOutcome {
  ok: boolean;
  message?: string;
  kind?: string;         // error kind for popup taxonomy (invalid_key, timeout, etc.)
  reasoning?: string;
  spec?: DesignSpec;
  verify?: VerifyResult;
  pixel?: { passed: boolean; voids: number; invisibleText: number; squeeze: number; captureFailed?: boolean };
  /** placement diagnostics for the report. */
  placement?: { placed: number; proxies: number; subgridProxies: number; singleTrackProxies: number; subgridChildAssignments: number; notPlaceable: number; gridTemplate: string; mixedProxies: number; plan?: SolverPlan; planHonoured?: boolean };
  /** the per-failure-class breakdown of SURVIVING invisible-text clusters
   *  (still invisible after the final paint). null when none survived. Each record
   *  names the root-cause class {no-handle, wrong-bg, cascade-loss, multi-bg} + the
   *  evidence — so the run report proves WHY the deterministic guarantee held or
   *  which class still leaks, instead of asserting a guarantee the count contradicts. */
  invisibleBreakdown?: { records: { handle: string; cls: string; evidence: string }[]; byClass: Record<string, number> } | null;
  /** count of low-contrast text nodes WITHOUT a [data-rv-c] ancestor —
   *  invisible to handle-targeted repair and the pixel detector. */
  contrastNoHandle?: number;
  /** conformance to the declared pack (spacing ∈ scale, type ∈ ramp,
   *  colors ∈ relationships, family consistency). The violations are listed
   *  verbatim in the end report. null when the spec declared no system. */
  conformance?: ConformanceResult;
  perceiveMs?: number;
  clusters?: number;
  changeScore?: number;
  accentFraction?: number;
  modelCoverageFraction?: number;
  wallMs?: number;       // total transform wall-clock
  model?: string;        // which model served the request
  usage?: unknown;       // token usage
  paidCalls?: number;    // total HTTP model requests used (includes retries)
  /** whether the perception was truncated — a partial perception can ship
   *  a partial redesign as a success. Surfaced so the caller can warn. */
  perceptionTruncated?: { walk: boolean; serialize: boolean };
  paintCount?: number;   // visible repaints
  ledger?: Ledger;       // stage-by-stage time breakdown (structured run report)
}

const APPLIED = 'revueonApplied';
const FAILED = 'revueonFailed';

let inFlight: Promise<TransformOutcome> | null = null;
let activeShadowRoots: ShadowRoot[] = [];
let lastAppliedCss = '';   // last applied CSS — for immediate shadow-root injection on dynamic content
// the solver's structural CSS (grid + display:contents). Stored separately so
// restyleDynamic can re-apply it alongside re-compiled aesthetic CSS.
let activeStructuralCss = '';

// Dynamic-content defense: the stored spec + opts, used to re-stamp +
// re-apply the design on inserted content (free, no model call).
let activeSpec: DesignSpec | null = null;
let activeOpts: CompileOptions = {};
// Structural ops: the transaction log (session-only undo) + the accepted op
// set (for re-derive on reload + re-exec on SPA re-render). `activeOps` is the
// validated plan from the LAST compile; re-derive re-runs validateOps against a
// fresh perception then executeOps. The log holds live-node inverses for undo.
const txnLog = new TransactionLog();
let activeOps: ValidatedOp[] = [];
let dynamicObserver: MutationObserver | null = null;
let shadowDynamicObservers: MutationObserver[] = [];
let restyleTimer: ReturnType<typeof setTimeout> | null = null;

function markApplied(id: string): void {
  delete document.documentElement.dataset[FAILED];
  document.documentElement.dataset[APPLIED] = id;
}
function markFailed(msg: string): void {
  delete document.documentElement.dataset[APPLIED];
  document.documentElement.dataset[FAILED] = msg.slice(0, 80);
}

// ── Core run ───────────────────────────────────────────────

async function runStyle(intent: string, restyleOnly = false): Promise<TransformOutcome> {
  // MV3 keepalive: open a port so the SW stays alive for the duration of this run.
  // The SW (background.ts) relays the model fetch (70-90s) — without the port, MV3's
  // ~30s idle kill terminates the SW mid-fetch, and askForSpec's sendMessage never
  // resolves (a silent hang). The port's existence keeps the SW alive; the sendMessage
  // timeout (in askForSpec) is the backstop if the SW dies anyway. The in-flight flag
  // surfaces a stale-run warning in the popup.
  const keepalivePort = chrome.runtime.connect();
  void chrome.storage.local.set({ revueonRunInFlight: Date.now() });
  try {
    return await runStyleImpl(intent, restyleOnly);
  } catch (err) {
    // A throw anywhere in runStyleImpl (after the model calls, before markApplied)
    // would silently reject this Promise → the popup's chrome.tabs.sendMessage
    // callback gets chrome.runtime.lastError → "Cannot reach the page" — AND the
    // DOM marker is never set, so the harness waits the full timeout. Catch it,
    // log it loudly, mark failed, and return a clean error outcome so the popup
    // gets a real error message (not a "Cannot reach the page" lie) and the
    // harness sees the failed marker. The conformance block + the engine
    // are the prime throw risks (a malformed packOverrides can spread a non-object).
    const msg = (err as Error)?.message || 'Transform crashed (internal error).';
    logDebug(`RUN CRASHED: ${msg}` + (err && (err as Error).stack ? `\n${(err as Error).stack}` : ''));
    rollbackFailed('internal error');
    return { ok: false, kind: 'bad_output', message: msg, paidCalls: 0, wallMs: 0 };
  } finally {
    keepalivePort.disconnect();
    void chrome.storage.local.remove('revueonRunInFlight');
  }
}

async function runStyleImpl(intent: string, restyleOnly = false): Promise<TransformOutcome> {
  const t0 = Date.now();
  // global abort — one time budget enforced across the whole pipeline.
  // Per-call timeouts exist, but runs can still exceed designMaxMs when verify +
  // persist + repair all add up. This check leaves the page untouched on abort.
  const budgetExceeded = (): boolean => Date.now() - t0 > AI_CONFIG.designMaxMs;
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
  // Reset the visible-paint counter at the start of every transform. The
  // harness asserts paintCount <= 2 (apply + one batched repair). applyStyleEverywhere
  // increments it.
  document.documentElement.dataset['revueonPaintCount'] = '0';
  stopDynamicDefense();
  activeSpec = null;
  // Clear any stale style from a previous transform or reapplyStored before the
  // new transform begins — ensures the before-capture  sees the true original
  // AND no stale style survives a model failure (the dense-news-page discrepancy).
  removeStyleEverywhere(activeShadowRoots);
  stopMovableHandlers();
  lastAppliedCss = '';

  clearHandles();
  let perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  const serialized = serializePerception(perception);
  // redact sensitive data (form values, credentials) before sending to the model.
  const serializedRedacted = redactSensitiveData(serialized);
  // The Architect chooses the layout language. Perception proposes a shortlist;
  // the Architect sees ONLY those candidates (their ids + one-line descriptions),
  // never all seven, never the full slot tables. Measurement proposes; the model
  // decides.
  const candidates = proposeLanguageCandidates(perception);
  const architectPerception = serializedRedacted + '\nLAYOUT CANDIDATES (pick one `language`):\n' + formatCandidates(candidates);
  const serializeChars = serializedRedacted.length;
  // flag serialization truncation (budget hit → demoted/dropped entries).
  if (perception.truncated) perception.truncated.serialize = lastSerializeBudget.before > lastSerializeBudget.after;
  // the Painter decides surface (not layout), so it gets a TRIMMED
  // perception: header + role/group inventory, no per-cluster geometry/colors
  // (work item B — cuts Painter prompt ~40% + its wall-clock). The Architect keeps
  // the full serialization (it needs geometry for reflow). Logged for the ledger.
  const painterSerialized = redactSensitiveData(serializePainterPerception(perception));
  logDebug(`painter perception trimmed: ${painterSerialized.length}chars (full=${serializeChars})`);
  // Capture the reflow opportunities from the ORIGINAL page (before any op
  // re-perceive). The verify gate checks whether the Architect addressed each; the
  // post-op perception may have dropped a removed side-rail, so we hold the
  // original list. Empty on pages with no detectable side-rail (no gate then).
  const reflowOpportunity = perception.reflowOpportunity;
  const before = captureLayoutFingerprint();
  logDebug(`perceived ${perception.nodeCount} nodes -> ${perception.clusters.length} clusters (${perception.builtInMs}ms) ${perception.shadowRoots.length} shadow roots serialize=${serializeChars}chars`);

  // Before-capture for the recolor detector: capture the original page at scroll 0
  // BEFORE any style is applied. Threaded through applyOnce → captureAndPixelVerify
  // → pixelVerify so detectRecolor compares before/after edge maps. 0 paid calls,
  // 0 paintCount — a read, not a paint.
  const beforeTop = await captureShotAt(0);

  // Per-role call accounting (observability — the budget is TIME, not calls).
  const roleCalls: RoleCall[] = [];
  let repairRounds = 0;
  const recordCall = (role: Role, res: SpecResponse): void => {
    if (res.callMs == null) return;
    const u = res.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    roleCalls.push({ role, ms: res.callMs, promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens, httpRequests: res.httpRequests ?? 1 });
  };
  // paidCalls = sum of actual HTTP requests (including retries), not just
  //  the number of role calls. The UI was reporting 1 call when up to 5 were made.
  const paidCalls = (): number => roleCalls.reduce((s, c) => s + c.httpRequests, 0);
  // A Critic repair round fits only if the remaining wall-clock clears the per-call
  // minimum; the budget is time, not a call count.
  const canReReason = (): boolean => (AI_CONFIG.designMaxMs - (Date.now() - t0)) > AI_CONFIG.criticMinMs;

  // ── Design call: Architect + Painter in PARALLEL, then merge ──
  // The Architect sets the structure (composition/layout/canvasLayout/hide); the
  // Painter sets the surface (canvas/variables/paletteMode/styles). Independent
  // inputs → run concurrently. compile joins them via mergeSpecs.
  // Restyle-only: the Painter ALONE (no Architect) — a pure palette request isn't
  // asking for a rearrangement, so the Architect (structure) would only add latency.
  let archRes: SpecResponse = { ok: false };
  let paintRes: SpecResponse;
  if (restyleOnly) {
    paintRes = await askForSpec('painter', intent, painterSerialized);
    recordCall('painter', paintRes);
  } else {
    [archRes, paintRes] = await Promise.all([
      askForSpec('architect', intent, architectPerception),
      askForSpec('painter', intent, painterSerialized),
    ]);
    recordCall('architect', archRes);
    recordCall('painter', paintRes);
    // If the Architect failed (a transient timeout/error on a large page) but the
    // Painter succeeded, the merged spec is the Painter-only surface — a recolor,
    // which the verify !layoutReshaped gate catches and the Critic may upgrade. A
    // retry was tried but pushed large pages past the hard budget (a timeout wastes
    // the paid call); shipping the recolor + honest failure is the lesser evil.
  }
  // global abort after the design calls — leaves the page untouched.
  if (budgetExceeded() && (!archRes.ok || !paintRes.ok)) {
    rollbackFailed('global time budget exceeded');
    return { ok: false, kind: 'timeout', message: 'The design exceeded the time budget and was rolled back.', paidCalls: paidCalls(), wallMs: Date.now() - t0 };
  }
  if ((!archRes.ok || !archRes.spec) && (!paintRes.ok || !paintRes.spec)) {
    // Both roles failed (or the sole Painter failed) — honest error (no fallback chain).
    const failed = !archRes.ok && !paintRes.ok ? archRes : paintRes;
    logDebug(`LEDGER perceive=${perception.builtInMs}ms serialize=${serializeChars}chars roles=[${roleCalls.map((c) => `${c.role}:${c.ms}ms`).join(', ')}] total=${Date.now() - t0}ms paidCalls=${paidCalls()} — FAILED ${failed.kind ?? ''}`);
    rollbackFailed(failed.message || 'engine failed');
    return { ok: false, kind: failed.kind, message: failed.message || 'Design engine failed.', paidCalls: paidCalls(), wallMs: Date.now() - t0 };
  }
  let spec = mergeSpecs(archRes.ok ? archRes.spec : undefined, paintRes.ok ? paintRes.spec : undefined);
  logDebug(`architect=${archRes.ok ? 'ok' : (restyleOnly ? 'skipped' : 'FAIL')} painter=${paintRes.ok ? 'ok' : 'FAIL'} merged rules=${spec.rules.length} composition=${spec.composition?.length ?? 0} clusters=${perception.clusters.length}`);
  logDebug(`paletteMode=${spec.paletteMode ?? 'restrained(default)'} rules=${spec.rules.length}`);

  // Evidence dump — the model's relations + pack + overrides + the engine's
  // resolved rules/composition/escape-hatch. Lets a run be diagnosed by LAYER
  // (model relations vs engine mapping) without a debugger.
  {
    const exp = transformIntent(spec, perception);
    logDebug(`EVIDENCE pack=${spec.pack ?? 'default'} packOverrides=${spec.packOverrides ? JSON.stringify(spec.packOverrides).slice(0, 400) : 'none'}`);
    logDebug(`RELATIONS (${spec.relations?.length ?? 0}): ${(spec.relations ?? []).map((r) => JSON.stringify(r)).join(' | ')}`);
    logDebug(`RESOLVED rules=${exp.rules.length} composition=${exp.composition.length} ops=${exp.ops.length} escapeHatch=${exp.escapeHatchUses.length}/${exp.expandedTargets.length}=${(exp.escapeHatchFraction * 100).toFixed(0)}%${exp.notes.length ? ` notes=${exp.notes.slice(0, 6).join('; ')}` : ''}`);
  }


  // Completeness contract — BEFORE apply. Log only; base-coat harmonizes
  // unaccounted clusters and the post-apply !c.covered gate catches under-coverage.
  {
    const comp = checkCompleteness(spec, perception.handles);
    if (!comp.ok) {
      logDebug(`INCOMPLETE SPEC — ${comp.reason}`);
    } else {
      logDebug(`completeness OK — ${perception.handles.size} clusters, ${comp.unaccounted.length} base-coated`);
    }
  }

  // ── Structural ops: validate + execute ONCE before paint 1, then re-perceive
  // so compile uses POST-OP geometry (risk 4: a removed sidebar's main column must
  // widen into the reclaimed space — compile against stale pre-op geometry keeps
  // the dead-margin band). The initial `perception` stamped the live nodes; we
  // resolve by handle, mutate, record the inverse, then refresh geometry. The
  // `before` fingerprint (captured earlier) stays the original page — correct.
  // Idempotent: re-derive (reload/SPA) re-runs this against fresh stamps.
  txnLog.clear();
  const opsResult = (function () {
    const { ops: validated, refused: opRefusals } = validateOps(spec.ops, perception);
    if (!validated.length) return { executed: 0, refused: opRefusals.length, reasons: opRefusals, ops: [] as ValidatedOp[] };
    // Execute against the CURRENT (pre-op) stamps — handles resolve to live nodes.
    const r = executeOps(validated, true, txnLog);
    activeOps = validated;
    return { executed: r.executed, refused: r.refused + opRefusals.length, reasons: [...opRefusals, ...r.refusedReasons], ops: validated };
  })();
  if (opsResult.executed) {
    logDebug(`ops: executed=${opsResult.executed} refused=${opsResult.refused}${opsResult.reasons.length ? ` refused=[${opsResult.reasons.join(',')}]` : ''}`);
    // Re-perceive so compile sees the post-op DOM. The before-fingerprint is
    // unchanged (the original page); verify compares against it.
    const reP = perceive();
    activeShadowRoots = reP.shadowRoots;
    perception = reP; // compile + verify below use post-op geometry
  } else {
    activeOps = opsResult.ops;
  }
  const removedHandles = txnLog.removedHandles();
  const movedHandles = txnLog.movedHandles();

  // ── Structural CSS from the solver (free, no model calls) ──
  // The solver produces grid placement CSS from the Target Layout IR. The Target
  // IR is built from the model's composition relations (when present) or the
  // deterministic slot assignment (fallback). The structural CSS is combined
  // with the aesthetic CSS from the compiler.
  let structuralCss = '';
  let solvePlacement: ReturnType<typeof computeGridPlacementCss> | null = null;
  let planHonoured = true;
  if (!restyleOnly) {
    document.querySelectorAll('[data-rv-grid]').forEach((el) => el.removeAttribute('data-rv-grid'));
    document.querySelectorAll('[data-rv-plan-slot]').forEach((el) => el.removeAttribute('data-rv-plan-slot'));
    const sIR = extractLayoutIR(perception);
    const sExcludedRaw = detectExclusions(perception.clusters);
    const sExcludedSet = new Set<string>();
    for (const [h] of sExcludedRaw) sExcludedSet.add(h);
    // The model picks the layout language; perception proposes a shortlist. An
    // unknown id falls back to documentation (reported below). A language outside
    // the shortlist that exists is honoured and recorded as a divergence.
    const langId = spec.language;
    const lang = getLanguage(langId);
    const divergence = langId && !LANGUAGE_IDS.has(langId) ? langId : null;
    if (divergence) logDebug(`language: unknown id '${divergence}' — fell back to documentation`);
    else if (langId && lang.id === 'documentation' && langId !== 'documentation') logDebug(`language: '${langId}' not in registry — fell back to documentation`);
    const sAssignment = assignSlots(sIR.nodes, lang);
    const fallbackTarget = buildFallbackTargetIR(sAssignment.handleToSlot, lang);
    // Build the DOM-order map (handle → sourceOrder) for readBefore/prominentFirst
    // to check whether the relation can be satisfied through placement alone.
    const domOrder = new Map<string, number>();
    for (const node of sIR.nodes) domOrder.set(node.handle, node.computedRelationships.ordering);
    const focalHandle = perception.spatial?.focalPoint?.handle ?? null;
    const sTarget = resolveComposition(spec.relations, fallbackTarget, domOrder, focalHandle, lang);
    try {
      const sSolveResult = solve({ ir: sIR, target: sTarget, excluded: sExcludedSet });
      solvePlacement = computeGridPlacementCss(sSolveResult);
      structuralCss = solvePlacement.css;
      planHonoured = assertPlanHonoured(solvePlacement.plan);
      logDebug(`solver: matched=${sSolveResult.matchedTargets} placed=${solvePlacement.nodesPlaced} notPlaceable=${solvePlacement.nodesNotPlaceable.length} collapsed=${solvePlacement.intermediatesCollapsed} selectorFallback=${solvePlacement.selectorFallback} planCols=${solvePlacement.plan.expectedColumns} planHonoured=${planHonoured} archetype=${sTarget.archetype} tracks=${sTarget.tracks.length} unsatisfiable=${sTarget.unsatisfiable.length}`);
      if (sTarget.unsatisfiable.length) logDebug(`solver unsatisfiable: ${sTarget.unsatisfiable.map((u) => `${u.handle}:${u.constraint} (${u.reason})`).join('; ')}`);
    } catch (e) {
      logDebug(`solver failed (non-fatal): ${(e as Error).message}`);
    }
  }

  // Build modelAddressed set for the model coverage gate.
  const modelAddressed = new Set<string>();
  for (const rule of spec.rules) {
    if (rule.styles || rule.layout || rule.hover || rule.focusVisible || rule.hide) modelAddressed.add(rule.target);
  }
  if (spec.composition) {
    for (const rule of spec.composition) {
      if (rule.styles || rule.layout || rule.hide) modelAddressed.add(rule.target);
    }
  }
  if (spec.ops) for (const op of spec.ops) modelAddressed.add(op.target);
  // The relations resolve to per-handle rules. Count the engine's resolved
  // targets as model-addressed too, or the coverage gate undercounts (modelCov)
  // and the escape-hatch denominator is wrong. The engine is pure + free
  // (0 model calls); resolving the targets once here keeps the coverage gate
  // honest for BOTH paints' verify passes.
  if (spec.relations?.length) {
    for (const h of transformIntent(spec, perception).expandedTargets) modelAddressed.add(h);
  }

  let options: CompileOptions = { paletteMode: spec.paletteMode };
  const attempts: Attempt[] = [];
  let lastVerify: VerifyResult | null = null;
  let lastPixel: PixelVerifyResult | null = null;
  let lastBreakdown: InvisibleBreakdown | null = null;
  let lastCompiled: ReturnType<typeof compileSpec> | null = null;   // escape-hatch + conformance inputs
  let compileMsTotal = 0, applyMsTotal = 0, verifyMsTotal = 0, pixelVerifyMsTotal = 0;

  // Batched repair: apply once (paint 1) → verify (DOM + pixel) → compute ALL
  // repairs as a batch → one merged re-apply (paint 2) → STOP. A 3rd visible repaint
  // is a failing check (the harness asserts paintCount <= 2). No keepBest re-apply
  // beyond paint 2: if paint 2 is broken we rollback+fail rather than repaint again.
  let paintCount = 0;

  const applyOnce = async (curSpec: DesignSpec, opts: CompileOptions): Promise<{ compiled: ReturnType<typeof compileSpec>; sanitized: string; verify: VerifyResult; pixel: PixelVerifyResult; breakdown: InvisibleBreakdown | null }> => {
    const tcCompile = performance.now();
    const compiled = compileSpec(curSpec, perception, opts);
    compileMsTotal += performance.now() - tcCompile;
    const aestheticCss = sanitizeCss(compiled.css).css;
    const sanitized = structuralCss
      ? sanitizeCss(structuralCss + '\n' + aestheticCss).css
      : aestheticCss;
    if (!sanitized.trim()) return Promise.reject(new Error('no styles'));
    const tcApply = performance.now();
    applyStyleEverywhere(sanitized, activeShadowRoots);
    // Inline forceContrast backstop: forces the readable pair onto each invisible
    // cluster's own element, beating id-level site !important that defeats the CSS
    // rule (the cascade-loss class). applied to ALL contrast targets (DOM +
    // pixel), not just pixel-invisible — id-level !important survivors need inline.
    const allContrastTargetsV1 = [...new Set([...(opts.pixelInvisibleTargets ?? []), ...(opts.contrastTargets ?? [])])];
    applyInlineBackstop(curSpec, allContrastTargetsV1, opts.contrastTargetBgs);
    applyMsTotal += performance.now() - tcApply;
    paintCount++;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const tcVerify = performance.now();
    // Restyle-only: a palette change isn't claiming to reshape, so the reshape checks
    // (layoutReshaped/usesRoom) are reported but not enforced; the recolor pixel
    // detector is skipped (no `before` passed to captureAndPixelVerify). The by-eye-
    // safety bars still hold.
    const verify = verifyStyle(before, curSpec.paletteMode, modelAddressed, restyleOnly, removedHandles, movedHandles, reflowOpportunity);
    verifyMsTotal += performance.now() - tcVerify;
    const px = await captureAndPixelVerify(restyleOnly ? undefined : beforeTop);
    pixelVerifyMsTotal += px.ms;
    // instrument: classify each surviving invisible-text cluster into its
    // root-cause class so the run report names WHY each is still invisible, not just
    // the count. The breakdown is logged per-paint and carried on the outcome.
    const breakdown = classifyInvisible(px.result.invisibleText);
    if (breakdown) logDebug(`invisible-text breakdown: ${px.result.invisibleText.length} survivor(s) — no-handle=${verify.contrastNoHandle} wrong-bg=${breakdown.byClass['wrong-bg']} cascade-loss=${breakdown.byClass['cascade-loss']} multi-bg=${breakdown.byClass['multi-bg']} unknown=${breakdown.byClass['unknown']}${breakdown.records.slice(0, 6).map((r) => `\n  ${r.handle}: ${r.cls} — ${r.evidence}`).join('')}`);
    return { compiled, sanitized, verify, pixel: px.result, breakdown };
  };

  // ── Paint 1: initial apply + verify (DOM + pixel) ──
  let phase1Sanitized = '';
  let phase1Verify: VerifyResult | null = null;
  try {
    const p1 = await applyOnce(spec, options);
    phase1Sanitized = p1.sanitized; phase1Verify = p1.verify; lastVerify = p1.verify; lastPixel = p1.pixel; lastBreakdown = p1.breakdown; lastCompiled = p1.compiled;
    attempts.push({ spec, css: p1.sanitized, notBroken: p1.verify.checks.notBlank && p1.verify.checks.noOverflow && p1.verify.checks.noOverlap && p1.verify.checks.contrastOk && p1.verify.checks.contentIntact && p1.verify.checks.contentVisible, changeScore: p1.verify.changeScore, covered: p1.verify.checks.covered, coherent: p1.verify.checks.coherent, changed: p1.verify.checks.changed, contentIntact: p1.verify.checks.contentIntact });
    logDebug(`paint1: rules=${p1.compiled.rulesEmitted} baseCoat=${p1.compiled.baseCoatCount} checks=${JSON.stringify(p1.verify.checks)} pixel(passed=${p1.pixel.passed} voids=${p1.pixel.voids.length} invisible=${p1.pixel.invisibleText.length} squeeze=${p1.pixel.squeeze.length}) change=${p1.verify.changeScore.toFixed(3)} accent=${p1.verify.accentFraction.toFixed(3)} coverage=${p1.verify.coverageFraction.toFixed(3)} modelCov=${p1.verify.modelCoverageFraction.toFixed(3)}${p1.compiled.droppedProps.length ? ' dropped=[' + p1.compiled.droppedProps.slice(0, 12).join(',') + ']' : ''}`);
    logDebug(`  detail: ${p1.verify.details.join(' | ')}`);
    if (!p1.pixel.passed) logDebug(`  pixel critiques: ${p1.pixel.critiques.join(' | ')}`);
  } catch (e) {
    rollbackFailed('no styles');
    return { ok: false, message: (e as Error).message || 'Produced no applicable styles.', spec, reasoning: spec.reasoning, paidCalls: paidCalls(), wallMs: Date.now() - t0 };
  }

  // passed := DOM passed AND pixel passed. A by-eye-killer is mechanically
  // impossible to report as PASS.
  const phase1Passed = phase1Verify.passed && (lastPixel?.passed ?? true);

  if (!phase1Passed && paintCount < 2) {
    // The budget is TIME: a Critic repair round fits only if the remaining
    // wall-clock clears the per-call minimum (canReReason). No call-count cap.
    // opTargets = the handles a structural op targeted (remove/move/reorder/wrap) —
    // the hard void law needs them to decide which voids are "addressed".
    const opTargets = new Set(activeOps.map((o) => o.target));
    const decision = planRepair(phase1Verify!, options, repairRounds, spec.paletteMode, lastPixel, canReReason(), opTargets);
    logDebug(`repair -> ${decision.action}: ${decision.reason}`);

    if (decision.action === 'rollback') {
      rollbackFailed('content blanked');
      return { ...failVerify(spec, phase1Verify!), paidCalls: paidCalls(), wallMs: Date.now() - t0 };
    }

    if (decision.action === 'reReason') {
      // Latency guard: if the design calls already consumed most of the budget, a
      // Critic round would push past the hard abort. Ship paint 1 if non-broken.
      if (!canReReason()) {
        logDebug('Critic skipped — time budget exhausted; shipping paint 1');
        if (!(phase1Verify!.checks.notBlank && phase1Verify!.checks.contentIntact)) {
          rollbackFailed('time budget — no revision');
          return { ...failVerify(spec, phase1Verify!), paidCalls: paidCalls(), wallMs: Date.now() - t0 };
        }
      } else {
        // Append the pixel-grounded critiques so the Critic fixes the by-eye-killers
        // (voids, invisible text, squeeze), not just DOM flags.
        const critique = decision.critique + (lastPixel && !lastPixel.passed ? '\nPixel verification also found: ' + lastPixel.critiques.join('; ') : '');
        const failing = Object.entries(phase1Verify!.checks).filter(([, v]) => !v).map(([k]) => k).join(',');
        logDebug(`CRITIC REPAIR ROUND — fixing: ${failing}${lastPixel && !lastPixel.passed ? ' +pixel' : ''}`);
        repairRounds++;
        const re = await askForSpec('critic', intent, serializedRedacted, critique, Math.max(AI_CONFIG.criticMinMs, AI_CONFIG.designMaxMs - (Date.now() - t0)));
        recordCall('critic', re);
        if (re.ok && re.spec) {
          // Merge the Critic's corrections into the spec (Critic returns a patch:
          // styles/layout on the failing clusters). The structure (Architect) +
          // surface (Painter) base stays; the Critic overrides the failing bits.
          spec = mergeSpecs(spec, re.spec);
          // Carry the deterministic repair options (forceContrast + the flagged
          // contrast/pixel-invisible handles) into paint 2 — the Critic is a model
          // call that may not fix every invisible cluster; the deterministic bg+text
          // pair guarantees the pixel-invisible ones are readable. (The old code
          // reset options to paletteMode only, dropping the deterministic backstop.)
          options = { ...options, ...decision.options, paletteMode: spec.paletteMode };
          // ── Paint 2: re-apply with the corrected spec ──
          try {
            const p2 = await applyOnce(spec, options);
            lastVerify = p2.verify; lastPixel = p2.pixel; lastBreakdown = p2.breakdown; lastCompiled = p2.compiled; lastCompiled = p2.compiled;
            attempts.push({ spec, css: p2.sanitized, notBroken: p2.verify.checks.notBlank && p2.verify.checks.noOverflow && p2.verify.checks.noOverlap && p2.verify.checks.contrastOk && p2.verify.checks.contentIntact && p2.verify.checks.contentVisible, changeScore: p2.verify.changeScore, covered: p2.verify.checks.covered, coherent: p2.verify.checks.coherent, changed: p2.verify.checks.changed, contentIntact: p2.verify.checks.contentIntact });
            logDebug(`paint2(critic): checks=${JSON.stringify(p2.verify.checks)} pixel(passed=${p2.pixel.passed})`);
            // If paint 2 is broken, rollback+fail (no 3rd paint to revert).
            if (!(p2.verify.checks.notBlank && p2.verify.checks.contentIntact)) {
              rollbackFailed('revision broke content');
              return { ...failVerify(spec, p2.verify), paidCalls: paidCalls(), wallMs: Date.now() - t0 };
            }
          } catch {
            // Critic'd spec produced no styles — keep paint 1 if non-broken.
            if (!(phase1Verify!.checks.notBlank && phase1Verify!.checks.contentIntact)) {
              rollbackFailed('revision failed');
              return { ...failVerify(spec, phase1Verify!), paidCalls: paidCalls(), wallMs: Date.now() - t0 };
            }
            applyStyleEverywhere(phase1Sanitized, activeShadowRoots); // revert to paint 1
            logDebug('paint2 produced no styles — reverted to paint 1');
          }
        }
      }
    } else {
      // Deterministic repair: batch ALL option changes into one CompileOptions,
      // recompile once, re-apply once (paint 2). No keepBest re-apply beyond this.
      const batchedOpts = { ...options, ...decision.options };
      options = batchedOpts;
      try {
        const p2 = await applyOnce(spec, options);
        lastVerify = p2.verify; lastPixel = p2.pixel; lastBreakdown = p2.breakdown; lastCompiled = p2.compiled;
        attempts.push({ spec, css: p2.sanitized, notBroken: p2.verify.checks.notBlank && p2.verify.checks.noOverflow && p2.verify.checks.noOverlap && p2.verify.checks.contrastOk && p2.verify.checks.contentIntact && p2.verify.checks.contentVisible, changeScore: p2.verify.changeScore, covered: p2.verify.checks.covered, coherent: p2.verify.checks.coherent, changed: p2.verify.checks.changed, contentIntact: p2.verify.checks.contentIntact });
        logDebug(`paint2(repair): checks=${JSON.stringify(p2.verify.checks)} pixel(passed=${p2.pixel.passed}) change=${p2.verify.changeScore.toFixed(3)} accent=${p2.verify.accentFraction.toFixed(3)}`);
        if (!(p2.verify.checks.notBlank && p2.verify.checks.contentIntact)) {
          // Repair broke content — revert to paint 1 (paint 1 is still on screen?
          // No — paint 2 overwrote it). Re-applying paint 1 would be a 3rd paint.
          // Rollback+fail honestly instead.
          rollbackFailed('repair broke content');
          return { ...failVerify(spec, p2.verify), paidCalls: paidCalls(), wallMs: Date.now() - t0 };
        }
      } catch {
        // repair produced no styles — keep paint 1
        applyStyleEverywhere(phase1Sanitized, activeShadowRoots);
        logDebug('paint2(repair) produced no styles — reverted to paint 1');
      }
    }
  }

  // Verify the paint budget. <=2 paints is the contract; a 3rd = failing.
  // Set the dataset explicitly from the internal counter — applyStyleEverywhere no
  // longer increments it (defense re-applies are invisible restores, not visible
  // paints), so the harness reads the true visible-paint count.
  document.documentElement.dataset['revueonPaintCount'] = String(paintCount);
  const finalPaintCount = paintCount;
  if (finalPaintCount > 2) logDebug(`PAINT BUDGET EXCEEDED: ${finalPaintCount} > 2 (visible repair theater)`);

  // conformance: a free, deterministic check that the emitted CSS
  // follows its own declared design system (the pack the engine resolved).
  // The first constructive verification. Computed on the final applied CSS +
  // the spec + the escape-hatch from the last compile. The violations are
  // logged VERBATIM (calibrate before promoting to a hard gate next phase);
  // the escape-hatch FRACTION > ~20% is a loud pivot-failure flag (the model is
  // dodging the relation language) — logged + surfaced even when the design applies.
  let conformance: ConformanceResult | null = null;
  if (lastCompiled && lastVerify) {
    const escapeHatchUses = lastCompiled.escapeHatchUses ?? [];
    // Total targets = every handle a rule/composition/op targeted OR the relations
    // expanded to. modelAddressed (built above) already folds in the engine's
    // resolved targets, so this is the honest denominator for the escape-hatch
    // fraction (raw-ruled handles ÷ all model-targeted handles). >20% = the model
    // is dodging the relation language — a pivot-failure flag.
    const totalTargets = Math.max(1, modelAddressed.size);
    // Conformance is a CONSTRUCTIVE signal, not a hard gate this phase — it must
    // never break the transform. A malformed packOverrides (the model emits
    // packOverrides with no value-level validation in validateSpec) can spread a
    // non-object in resolvePack/declaredColorSet and throw. Catch it, log it,
    // and ship the design without conformance (runStyle's catch backstops this
    // too, but a local catch keeps the design alive instead of failing the run).
    try {
      conformance = checkConformance(lastCompiled.css || '', spec, escapeHatchUses, totalTargets);
      lastVerify.conformance = conformance;
      logDebug(`CONFORMANCE pack=${conformance.packId} ok=${conformance.ok} violations=${conformance.violations.length} escapeHatch=${escapeHatchUses.length}/${totalTargets} (${(conformance.escapeHatchFraction * 100).toFixed(0)}%)${conformance.violations.length ? `\n  violations:\n` + conformance.violations.slice(0, 20).map((v) => `    - ${v}`).join('\n') : ''}${lastCompiled.expandNotes?.length ? `\n  expand notes: ${lastCompiled.expandNotes.slice(0, 8).join('; ')}` : ''}`);
      if (conformance.escapeHatchFraction > 0.20) logDebug(`ESCAPE-HATCH FRACTION >20%: ${(conformance.escapeHatchFraction * 100).toFixed(0)}% of targets used raw rules — the model is dodging the relation language (a pivot-failure flag even if the design applies)`);
    } catch (err) {
      logDebug(`CONFORMANCE skipped (threw — a malformed packOverrides?): ${(err as Error)?.message}`);
    }
  }


  // Persist + defend + mark applied. Time the persist stage too.
  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `style_${Date.now()}`;
  const appliedCss = document.getElementById('revueon-style')?.textContent ?? attempts[attempts.length - 1]?.css ?? '';
  lastAppliedCss = appliedCss;
  state.enabled = true;
  state.style = { id, intent, spec, css: appliedCss, structuralCss: structuralCss || undefined, reasoning: spec.reasoning, compileOptions: options, createdAt: Date.now() };
  const tPersist = performance.now();
  await saveSiteState(key, state);
  const persistMs = Math.round(performance.now() - tPersist);

  startDefenseEverywhere(state.style.css, activeShadowRoots);
  activeSpec = spec;
  activeOpts = options;
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);
  startMovableHandlers();

  // Ledger — stage-by-stage time breakdown (account to wall-clock, nothing
  // unexplained). unaccountedMs = totalMs − sum(stages); a big gap means a stage
  // is eating time we didn't instrument (the ~44s unexplained-overhead case).
  const totalMs = Date.now() - t0;
  const modelMsTotal = roleCalls.reduce((s, c) => s + c.ms, 0);
  const stagesMs = perception.builtInMs + modelMsTotal + Math.round(compileMsTotal) + Math.round(applyMsTotal) + Math.round(verifyMsTotal) + Math.round(pixelVerifyMsTotal) + persistMs;
  const ledger: Ledger = {
    perceiveMs: perception.builtInMs, serializeChars, serializeCharsBefore: lastSerializeBudget.before,
    roleCalls, compileMs: Math.round(compileMsTotal),
    applyMs: Math.round(applyMsTotal), verifyMs: Math.round(verifyMsTotal),
    pixelVerifyMs: Math.round(pixelVerifyMsTotal), persistMs,
    unaccountedMs: Math.max(0, totalMs - stagesMs),
    totalMs, paidCalls: paidCalls(), repairRounds, paintCount: finalPaintCount,
    opsExecuted: opsResult.executed, opsRefused: opsResult.refused, opsRefusedReasons: opsResult.reasons,
    ...(conformance ? {
      escapeHatchUses: conformance.escapeHatchUses,
      escapeHatchFraction: conformance.escapeHatchFraction,
      conformanceOk: conformance.ok,
      conformanceViolations: conformance.violations.length,
    } : {}),
  };
  const rolesStr = roleCalls.map((c) => `${c.role}:${c.ms}ms/${c.promptTokens ?? '?'}tok`).join(', ');
  logDebug(`LEDGER perceive=${ledger.perceiveMs}ms serialize=${serializeChars}chars${lastSerializeBudget.before > lastSerializeBudget.after ? `(budget ${lastSerializeBudget.before}->${lastSerializeBudget.after})` : ''} roles=[${rolesStr}] compile=${ledger.compileMs}ms apply=${ledger.applyMs}ms verify=${ledger.verifyMs}ms pixelVerify=${ledger.pixelVerifyMs}ms persist=${persistMs}ms unaccounted=${ledger.unaccountedMs}ms total=${totalMs}ms paidCalls=${ledger.paidCalls} repairRounds=${repairRounds} paints=${finalPaintCount} ops=${opsResult.executed}/${opsResult.refused}`);
  if ((ledger.unaccountedMs ?? 0) > 0.15 * totalMs) logDebug(`LEDGER GAP >15%: ${ledger.unaccountedMs}ms unaccounted — investigate`);

  return {
    ok: true, reasoning: spec.reasoning, spec, verify: lastVerify || undefined,
    pixel: lastPixel ? { passed: lastPixel.passed, voids: lastPixel.voids.length, invisibleText: lastPixel.invisibleText.length, squeeze: lastPixel.squeeze.length } : undefined,
    invisibleBreakdown: lastBreakdown,
    contrastNoHandle: lastVerify?.contrastNoHandle,
    conformance: conformance ?? undefined,
    perceiveMs: perception.builtInMs, clusters: perception.clusters.length,
    changeScore: lastVerify?.changeScore, accentFraction: lastVerify?.accentFraction,
    modelCoverageFraction: lastVerify?.modelCoverageFraction,
    wallMs: totalMs, model: roleCalls.map((c) => c.role).join('+'),
    usage: roleCalls.length ? { total: roleCalls.reduce((s, c) => s + (c.promptTokens ?? 0) + (c.completionTokens ?? 0), 0) } : undefined,
    paidCalls: paidCalls(), paintCount: finalPaintCount, ledger,
    perceptionTruncated: perception.truncated,
    ...(solvePlacement ? {
      placement: { placed: solvePlacement.nodesPlaced, proxies: solvePlacement.proxyCount, subgridProxies: solvePlacement.subgridProxies, singleTrackProxies: solvePlacement.singleTrackProxies, subgridChildAssignments: solvePlacement.subgridChildAssignments, notPlaceable: solvePlacement.nodesNotPlaceable.length, gridTemplate: solvePlacement.gridTemplateColumns, mixedProxies: solvePlacement.mixedProxies, plan: solvePlacement.plan, planHonoured },
    } : {}),
  };
}

function failVerify(spec: DesignSpec, verify: VerifyResult): TransformOutcome {
  return { ok: false, message: 'Result failed checks: ' + verify.details.slice(0, 3).join('; '), spec, reasoning: spec.reasoning, verify };
}

// fixture mode — inlined at build time, 'off' (default) → dead branch in production.
const FIXTURE_MODE = (process.env.RV_FIXTURES ?? 'off') as 'off' | 'record' | 'replay';

// ponytail: djb2 — 4-line non-crypto hash for stale-fixture detection (not security).
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function askForSpec(role: Role, intent: string, perception: string, critique?: string, timeoutMs?: number): Promise<SpecResponse> {
  return new Promise((resolve) => {
    // fixture replay — return stored response, zero network. The harness
    // injects the fixture via chrome.storage.local before the transform.
    if (FIXTURE_MODE === 'replay') {
      const key = 'revueon_fixture_' + role;
      chrome.storage.local.get([key], (data) => {
        const fx = data[key] as { hash: string; response: SpecResponse } | undefined;
        if (!fx) { resolve({ ok: false, kind: 'fixture_missing', message: `No fixture for role ${role}. Expected chrome.storage.local key ${key}.` }); return; }
        const currentHash = djb2(perception);
        if (currentHash !== fx.hash) console.warn(`[Revueon] STALE FIXTURE ${role}: request hash ${currentHash} != fixture hash ${fx.hash} — replaying anyway`);
        resolve(fx.response);
      });
      return;
    }

    let done = false;
    // MV3 sendMessage timeout: if the SW is killed mid-fetch (the ~30s idle kill
    // terminates the SW during a 70-90s model call), the callback never fires — a
    // silent hang. This timer resolves a clean `kind: 'timeout'` failure (which the
    // popup's error taxonomy already maps to a user message) instead of hanging.
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, kind: 'timeout', message: 'Service worker dropped mid-run (no response within timeout).' });
    }, timeoutMs ?? 120000);
    chrome.runtime.sendMessage({ action: 'styleSpec', role, intent, perception, critique, timeoutMs }, (response) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (chrome.runtime.lastError || !response) resolve({ ok: false, message: chrome.runtime.lastError?.message || 'No response from design engine.' });
      else {
        // fixture record — store the raw response via chrome.storage.local
        // for the harness to read and write to disk.
        if (FIXTURE_MODE === 'record' && response?.ok) {
          void chrome.storage.local.set({ ['revueon_fixture_' + role]: { hash: djb2(perception), response } });
        }
        resolve(response as SpecResponse);
      }
    });
  });
}

// resize-invariance harness — wired, NOT YET RUN. This is a legitimate
// hard gate once validated against real sites. A layout built from constraints
// survives a viewport change with no pipeline re-run. Call after the final
// hard-gate check to validate the transform is resize-invariant.
// ponytail: not called yet — wired for the next sweep to enable.
async function _runResizeInvarianceCheck(): Promise<ResizeCheckResult | null> {
  try {
    return await checkResizeInvariance(defaultCheckAt);
  } catch {
    return null;
  }
}

async function reapplyStored(): Promise<boolean> {
  const key = storageKey();
  let state = await loadSiteState(key);
  // Origin-level fallback: if no design for this pathname, check origin.
  if (!state.style) {
    state = await loadSiteState(window.location.origin);
    if (!state.style) return false;
  }
  if (!state.enabled || !state.style?.css) return false;
  clearRoleCache();  // invalidate stale roles from the previous route
  clearHandles();
  let perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  // Re-derive structural ops from the stored spec (risk 3): the spec is the durable
  // source of truth; the session log died with the tab. Re-validate against the
  // fresh perception (handles may differ) + execute idempotently (skip if already
  // satisfied — a move already applied, a removed element gone). No log on re-derive.
  const { ops: revalidated } = validateOps(state.style.spec.ops, perception);
  if (revalidated.length) {
    executeOps(revalidated, false, txnLog);
    activeOps = revalidated;
    // Re-perceive so compile uses post-op geometry (the reclamation must show).
    perception = perceive();
    activeShadowRoots = perception.shadowRoots;
  } else {
    activeOps = [];
  }
  txnLog.clear(); // fresh session — the log is session-only
  const opts = state.style.compileOptions ?? { paletteMode: state.style.spec.paletteMode };
  // When structural CSS is present, use the stored combined CSS directly (the exact
  // CSS from paint2). Re-compilation with a fresh perception can produce slightly
  // different forceContrast text colors (stale contrastTargetBgs vs fresh
  // cl.style.background), causing text to become invisible after undo-fidelity
  // toggle. The stored CSS is authoritative.
  // Dynamic content is handled by the MutationObserver defense (restyleDynamic).
  const structuralCss = state.style.structuralCss ?? '';
  let css: string;
  if (structuralCss) {
    // Structural CSS present: stored CSS already includes structural + aesthetic + repair.
    css = state.style.css;
    // Still re-stamp handles so [data-rv-c] selectors match on the live page.
    clearHandles();
    perception = perceive();
    activeShadowRoots = perception.shadowRoots;
  } else {
    // No structural CSS (restyle-only): re-compile (ops may have changed the DOM).
    const compiled = compileSpec(state.style.spec, perception, opts);
    css = sanitizeCss(compiled.css).css || state.style.css;
  }
  applyStyleEverywhere(css, activeShadowRoots);
  startDefenseEverywhere(css, activeShadowRoots);
  activeSpec = state.style.spec;
  activeOpts = opts;
  activeStructuralCss = structuralCss;
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(state.style.id);
  return true;
}

async function toggleSiteState(): Promise<void> {
  const key = storageKey();
  const state = await loadSiteState(key);
  if (!state.style) return;
  state.enabled = !state.enabled;
  await saveSiteState(key, state);
  if (state.enabled) await reapplyStored();
  else { undoOpsAndCss(); }
}

/** Off / undo: replay the op transaction log backwards (restore the original
 *  DOM), then strip the CSS. The escape hatch stays instant and absolute —
 *  ops are undone BEFORE the style tag is removed, so the page returns to its
 *  pre-transform state in one synchronous pass. The log is session-only.
 *  returns { undone, failed } from the undo for the structural assertion. */
function undoOpsAndCss(): { undone: number; failed: number } {
  stopDynamicDefense();
  activeSpec = null; activeOps = []; activeStructuralCss = '';
  const undoResult = txnLog.undoAll(liveDom);
  // clean up data-rv-grid / data-rv-plan-slot debug attributes from CSS-only placement.
  document.querySelectorAll('[data-rv-grid]').forEach((el) => el.removeAttribute('data-rv-grid'));
  document.querySelectorAll('[data-rv-plan-slot]').forEach((el) => el.removeAttribute('data-rv-plan-slot'));
  removeStyleEverywhere(activeShadowRoots); removeEscapeUI();
  stopMovableHandlers();
  delete document.documentElement.dataset[APPLIED];
  return undoResult;
}

/** structural invariant — after any failed transform, the DOM must be
 *  structurally identical to its pre-transform state. Encoded as an assertion,
 *  not a comment: no Revueon-injected elements or attributes may remain. */
function assertDomClean(undoResult: { undone: number; failed: number }): void {
  const remaining = document.getElementById('revueon-style');
  const wraps = document.querySelectorAll('[data-rv-wrap]').length;
  const gridAttrs = document.querySelectorAll('[data-rv-grid]').length;
  if (remaining || wraps > 0 || gridAttrs > 0 || undoResult.failed > 0) {
    const issues = [
      remaining ? 'style element still present' : '',
      wraps > 0 ? `${wraps} wrapper(s) still present` : '',
      gridAttrs > 0 ? `${gridAttrs} grid attr(s) still present` : '',
      undoResult.failed > 0 ? `${undoResult.failed} undo(s) failed` : '',
    ].filter(Boolean).join('; ');
    console.error(`[Revueon] INVARIANT VIOLATION: DOM not clean after failed transform: ${issues}`);
  }
}

/** rollback a failed transform — undo ops, strip CSS, assert DOM clean,
 *  mark failed. Every failure path calls this instead of just stripping CSS. */
function rollbackFailed(msg: string): void {
  const ur = undoOpsAndCss();
  assertDomClean(ur);
  markFailed(msg);
}

async function removeAll(): Promise<void> {
  undoOpsAndCss();
  await clearSiteState(storageKey());
}

// ── Dynamic content defense ────────────────────────────────────────
// Signature-based handles are deterministic: new content with the same visual
// signature gets the SAME handle, so the stored CSS applies once re-stamped.
// A MutationObserver (light DOM + active shadow roots) debounces a FREE
// re-perceive + re-compile(stored spec) + re-apply — no model call. New content
// is either styled (matches an existing family) or base-coated (novel signature).
// Self-trigger is avoided by ignoring additions of our own data-revueon-ui nodes.
function restyleDynamic(): void {
  if (!activeSpec) return;
  restyleTimer = null;
  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;
  // Re-derive ops against the fresh perception (risk 2: a framework re-inserted
  // a removed element; re-execute is idempotent — removed ops are a no-op if
  // the element is gone, re-apply if it came back). No log (re-derive path).
  const { ops: revalidated } = validateOps(activeSpec.ops, perception);
  if (revalidated.length) { executeOps(revalidated, false, txnLog); activeOps = revalidated; }
  const compiled = compileSpec(activeSpec, perception, activeOpts);
  // prepend the stored structural CSS (grid + display:contents) so the
  // grid layout survives dynamic re-style (MutationObserver re-apply path).
  const painterCss = sanitizeCss(compiled.css).css;
  const css = activeStructuralCss ? sanitizeCss(activeStructuralCss + '\n' + painterCss).css : painterCss;
  if (css) { applyStyleEverywhere(css, activeShadowRoots); lastAppliedCss = css; }
  logDebug(`dynamic restyle: ${perception.clusters.length} clusters re-stamped + re-applied${revalidated.length ? ` ops=${revalidated.length}` : ''}`);
}

function scheduleRestyle(): void {
  if (restyleTimer) clearTimeout(restyleTimer);
  restyleTimer = setTimeout(restyleDynamic, 600);
}

function startDynamicDefense(): void {
  stopDynamicDefense();
  // Ignore mutations whose only additions are our own injected elements (style /
  // escape UI) so re-applying never self-triggers a restyle loop.
  const hasForeignAdd = (muts: MutationRecord[]): boolean =>
    muts.some((m) => Array.from(m.addedNodes).some(
      (n) => !((n instanceof HTMLElement) && n.hasAttribute('data-revueon-ui')),
    ));
  dynamicObserver = new MutationObserver((muts) => {
    if (!hasForeignAdd(muts)) return;
    // Scan for newly-added elements with shadow roots not yet tracked — inject
    // the design CSS immediately so scroll-loaded custom elements (cards, video
    // portals) arrive styled with no 600ms flash. 0 paintCount (defense path).
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes)) {
        if (!(n instanceof HTMLElement)) continue;
        const sr = n.shadowRoot;
        if (sr && !activeShadowRoots.includes(sr)) {
          activeShadowRoots.push(sr);
          const obs = new MutationObserver((muts) => { if (hasForeignAdd(muts)) scheduleRestyle(); });
          obs.observe(sr, { childList: true, subtree: true });
          shadowDynamicObservers.push(obs);
          if (lastAppliedCss) applyStyleEverywhere(lastAppliedCss, [sr]);
        }
      }
    }
    scheduleRestyle();
  });
  dynamicObserver.observe(document.body, { childList: true, subtree: true });
  for (const root of activeShadowRoots) {
    const obs = new MutationObserver((muts) => { if (hasForeignAdd(muts)) scheduleRestyle(); });
    obs.observe(root, { childList: true, subtree: true });
    shadowDynamicObservers.push(obs);
  }
  // Resize: re-compile so containerWidthPx-based font clamps track the new
  // width. Most fluidity is already in the CSS (clamp/min(100%,…)); this catches
  // the container-measured clamps. Debounced with the same restyle timer.
  window.addEventListener('resize', scheduleRestyle);
}

function stopDynamicDefense(): void {
  dynamicObserver?.disconnect();
  dynamicObserver = null;
  for (const o of shadowDynamicObservers) o.disconnect();
  shadowDynamicObservers = [];
  if (restyleTimer) { clearTimeout(restyleTimer); restyleTimer = null; }
  window.removeEventListener('resize', scheduleRestyle);
}

// ── SPA navigation ─────────────────────────────────────────────────

let routeTimer: ReturnType<typeof setTimeout> | null = null;

function onRouteChange(): void {
  if (routeTimer) clearTimeout(routeTimer);
  routeTimer = setTimeout(handleRouteChange, 500); // debounce — SPA frameworks sometimes call pushState multiple times
}

async function handleRouteChange(): Promise<void> {
  if (inFlight) return; // a transform is running — it will handle the current page
  clearRoleCache();  // invalidate stale roles on SPA navigation
  stopDynamicDefense();
  activeSpec = null;
  removeStyleEverywhere(activeShadowRoots);
  removeEscapeUI();
  delete document.documentElement.dataset[APPLIED];
  await reapplyStored();
}

// ── Adaptive effort ─────────────────────────────────────────────────
// Simple intents (hide/remove a named thing, move X to a direction) take a FAST
// path: perceive → match the target noun to clusters → apply. Zero paid model
// calls, ~1-2s. Ambitious/descriptive intents get the full design pipeline. A
// heuristic classifier routes obvious cases; ambiguous ones fall through to the
// full path.

/** Intent routing. The pure-palette path ('restyle-only') runs the PAINTER alone
 *  — 1 fast call, no Architect — a big latency win on the most common request type.
 *  It is exempt from the recolor + layoutReshaped checks (a palette-only request
 *  isn't claiming to be a redesign) but KEEPS every by-eye-safety bar (contrast,
 *  invisible, voids, squeeze, overflow, coverage, proportion). The exemption is
 *  bounded by the CLASSIFIER ONLY: a palette word AND NO arrangement word. A mixed
 *  request ('make it dark and move the sidebar to the top') goes full design. */
function classifyIntent(intent: string): 'hide' | 'move' | 'restyle-only' | 'design' {
  const s = intent.trim().toLowerCase();
  if (s.length > 120) return 'design';                  // long/descriptive → design
  // Starts with a hide verb AND has no aesthetic/design keywords → simple hide.
  if (/^(hide|remove|delete|get rid of)\b/.test(s) &&
      !/\b(like|style|theme|aesthetic|redesign|make it|transform|look)\b/.test(s)) return 'hide';
  // Starts with a move verb + a direction, no aesthetic keywords → simple move.
  if (/^(move|shift|relocate|push|send)\b/.test(s) &&
      /\b(to (the )?(top|bottom|up|down|beginning|start|end|finish))\b/.test(s) &&
      !/\b(like|style|theme|aesthetic|redesign|make it|transform|look)\b/.test(s)) return 'move';
  // Restyle-only: a pure palette request. A palette/theme word AND no arrangement
  // word (column/width/grid/layout/move/rearrange/sidebar/stack/reorder/etc.) →
  // Painter alone. A mixed request falls through to the full design path.
  const hasPaletteWord = /\b(colou?r|theme|palette|dark|light|neon|cyberpunk|warm|cool|muted|vivid|pastel|monochrome|grayscale|sepia|saturat|bright|moody|earthy|duotone)\b/.test(s);
  const hasArrangementWord = /\b(column|columns|width|grid|layout|move|rearrange|sidebar|side bar|stack|reorder|row|arrange|arrangement|narrow|widen|spacing|restructur)\b/.test(s);
  if (hasPaletteWord && !hasArrangementWord) return 'restyle-only';
  return 'design';
}

async function fastHidePath(intent: string): Promise<TransformOutcome> {
  const t0 = Date.now();
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
  stopDynamicDefense();
  activeSpec = null;

  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;

  // Extract target words after the hide verb (length > 3, stopwords removed).
  const targetWords = intent.toLowerCase()
    .replace(/.*?\b(hide|remove|delete|get rid of)\b/, '')
    .replace(/\b(the|a|an|all|please|and|on|my|site|page|element|section)\b/g, '')
    .split(/[^a-z]+/).filter((w) => w.length > 3);
  if (!targetWords.length) {
    markFailed('could not identify what to hide');
    return { ok: false, message: 'Could not identify what to hide. Try: "hide the footer".', paidCalls: 0, wallMs: Date.now() - t0 };
  }

  // Match clusters whose role/tag/samples contain any target word.
  const hideHandles: string[] = [];
  for (const c of perception.clusters) {
    const haystack = [c.role ?? '', c.tag, ...c.samples].join(' ').toLowerCase();
    if (targetWords.some((w) => haystack.includes(w))) hideHandles.push(c.handle);
  }
  if (!hideHandles.length) {
    markFailed('no matching element found');
    return { ok: false, message: `No element matching "${targetWords.join(' ')}" was found.`, paidCalls: 0, wallMs: Date.now() - t0 };
  }

  // Hide-only spec — hideRefusal guards primary content/wrappers, so this can't
  // delete the page. If every match is refused, sanitized CSS is empty.
  const spec: DesignSpec = { reasoning: `fast hide: ${intent}`, rules: hideHandles.map((h) => ({ target: h, hide: true })) };
  const compiled = compileSpec(spec, perception, {});
  const sanitized = sanitizeCss(compiled.css).css;
  if (!sanitized.trim()) {
    markFailed('hide refused (protected content)');
    return { ok: false, message: 'That element is protected and cannot be hidden.', paidCalls: 0, wallMs: Date.now() - t0 };
  }
  applyStyleEverywhere(sanitized, activeShadowRoots);
  lastAppliedCss = sanitized;
  document.documentElement.dataset['revueonPaintCount'] = '1'; // 1 visible paint (fast path)
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `hide_${Date.now()}`;
  state.enabled = true;
  state.style = { id, intent, spec, css: sanitized, reasoning: spec.reasoning, compileOptions: {}, createdAt: Date.now() };
  await saveSiteState(key, state);
  startDefenseEverywhere(sanitized, activeShadowRoots);
  activeSpec = spec;
  activeOpts = {};
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  const wallMs = Date.now() - t0;
  logDebug(`FAST HIDE PATH: ${hideHandles.length} cluster(s) hidden in ${wallMs}ms (0 paid calls)`);
  return {
    ok: true, reasoning: spec.reasoning, spec, perceiveMs: perception.builtInMs,
    clusters: perception.clusters.length, paidCalls: 0, wallMs,
    ledger: { perceiveMs: perception.builtInMs, serializeChars: 0, serializeCharsBefore: 0, roleCalls: [], totalMs: wallMs, paidCalls: 0, repairRounds: 0, paintCount: 1, opsExecuted: 0, opsRefused: 0, opsRefusedReasons: [] },
  };
}

/** Fast move path — CSS-only reposition via sticky/order, NO DOM relocation.
 *  "move the X to top/bottom" → position: sticky; "to beginning/end" → order.
 *  Ambiguous or no match → falls back to the full design pipeline. 0 paid calls. */
async function fastMovePath(intent: string): Promise<TransformOutcome> {
  const t0 = Date.now();
  delete document.documentElement.dataset[APPLIED];
  delete document.documentElement.dataset[FAILED];
  stopDynamicDefense();
  activeSpec = null;
  removeStyleEverywhere(activeShadowRoots);
  lastAppliedCss = '';

  clearHandles();
  const perception = perceive();
  activeShadowRoots = perception.shadowRoots;

  // Extract the direction from the intent.
  const s = intent.toLowerCase();
  const isTop = /\b(to (the )?top|up)\b/.test(s);
  const isBottom = /\b(to (the )?bottom|down)\b/.test(s);
  const isBeginning = /\b(to (the )?(beginning|start))\b/.test(s);
  const isEnd = /\b(to (the )?(end|finish))\b/.test(s);
  if (!isTop && !isBottom && !isBeginning && !isEnd) return runStyle(intent);

  // Extract the target noun (remove the move verb, direction words, stopwords).
  const targetWords = s
    .replace(/.*?\b(move|shift|relocate|push|send)\b/, '')
    .replace(/\b(to (the )?(top|bottom|up|down|beginning|start|end|finish))\b/g, '')
    .replace(/\b(the|a|an|all|please|and|on|my|site|page|element|section)\b/g, '')
    .split(/[^a-z]+/).filter((w) => w.length > 3);
  if (!targetWords.length) return runStyle(intent);

  // Match clusters whose role/tag/samples contain any target word.
  const moveHandles: string[] = [];
  for (const c of perception.clusters) {
    const haystack = [c.role ?? '', c.tag, ...c.samples].join(' ').toLowerCase();
    if (targetWords.some((w) => haystack.includes(w))) moveHandles.push(c.handle);
  }
  if (!moveHandles.length) return runStyle(intent);

  // Emit CSS by direction. Sticky positioning is raw CSS (position is NOT in
  // LAYOUT_PROPS — adding it would expose the footgun to the model's allowed-keys
  // list). Order goes through compileSpec (order IS in LAYOUT_PROPS).
  let sanitized: string;
  let spec: DesignSpec;
  if (isTop || isBottom) {
    const stickyVal = isTop ? 'top: 0' : 'bottom: 0';
    const selectors = moveHandles.map((h) => `[data-rv-c="${h}"]`);
    const rawCss = `${selectors.join(',\n')} {\n  position: sticky;\n  ${stickyVal};\n}`;
    sanitized = sanitizeCss(rawCss).css;
    spec = { reasoning: `fast move: ${intent}`, rules: moveHandles.map((h) => ({ target: h, styles: {} })) };
  } else {
    spec = { reasoning: `fast move: ${intent}`, rules: moveHandles.map((h) => ({ target: h, layout: { order: isBeginning ? '-1' : '999' } })) };
    const compiled = compileSpec(spec, perception, {});
    sanitized = sanitizeCss(compiled.css).css;
  }
  if (!sanitized.trim()) return runStyle(intent);

  applyStyleEverywhere(sanitized, activeShadowRoots);
  lastAppliedCss = sanitized;
  document.documentElement.dataset['revueonPaintCount'] = '1';
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  const key = storageKey();
  const state = await loadSiteState(key);
  const id = `move_${Date.now()}`;
  state.enabled = true;
  state.style = { id, intent, spec, css: sanitized, reasoning: spec.reasoning, compileOptions: {}, createdAt: Date.now() };
  await saveSiteState(key, state);
  startDefenseEverywhere(sanitized, activeShadowRoots);
  activeSpec = spec;
  activeOpts = {};
  startDynamicDefense();
  ensureEscapeUI(toggleSiteState);
  markApplied(id);

  const wallMs = Date.now() - t0;
  const dirLabel = isTop ? 'to top' : isBottom ? 'to bottom' : isBeginning ? 'to beginning' : 'to end';
  logDebug(`FAST MOVE PATH: ${moveHandles.length} cluster(s) moved ${dirLabel} in ${wallMs}ms (0 paid calls)`);
  return {
    ok: true, reasoning: spec.reasoning, spec, perceiveMs: perception.builtInMs,
    clusters: perception.clusters.length, paidCalls: 0, wallMs,
    ledger: { perceiveMs: perception.builtInMs, serializeChars: 0, serializeCharsBefore: 0, roleCalls: [], totalMs: wallMs, paidCalls: 0, repairRounds: 0, paintCount: 1, opsExecuted: 0, opsRefused: 0, opsRefusedReasons: [] },
  };
}

/** Restyle-only path — Painter ALONE (1 fast call, no Architect). A pure palette
 *  request ("make it dark", "cyberpunk colors") runs the Painter only and is
 *  exempt from the recolor + layoutReshaped checks (it's a palette change by
 *  definition, not a redesign), but keeps every by-eye-safety bar. The classifier
 *  gates this: a palette word AND no arrangement word. A mixed request goes full. */
function restyleOnlyPath(intent: string): Promise<TransformOutcome> {
  return runStyle(intent, true);
}

// ── Entry ──────────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    void reapplyStored();

    // SPA navigation detection.
    const origPush = history.pushState;
    history.pushState = function (...args) { origPush.apply(this, args); onRouteChange(); };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) { origReplace.apply(this, args); onRouteChange(); };
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'r') void toggleSiteState();
    });

    browser.runtime.onMessage.addListener((message: { action: string; intent?: string }) => {
      if (message.action === 'transform' && message.intent) {
        if (!inFlight) {
          const intent = message.intent;
          // Adaptive effort: simple hide/move intents take the fast no-model path;
          // a pure-palette restyle-only intent takes the Painter-alone path.
          // Clear any prior session's op log so a fast-path undo (CSS-only) never
          // replays stale design-path ops; runStyle clears it again before recording.
          txnLog.clear(); activeOps = [];
          const kind = classifyIntent(intent);
          // ONE runner-catch at the listener: wraps whichever runner is chosen
          // (fastHidePath / fastMovePath / restyleOnlyPath / runStyle). A throw
          // ANYWHERE in a runner (before runStyleImpl's own catch, in a fast path
          // with no catch, or a sync throw in classifyIntent/runner construction)
          // would reject the returned Promise → the popup's sendMessage callback
          // gets chrome.runtime.lastError → "Cannot reach the page" — and no DOM
          // marker is set, so the harness waits the full 130s. Catch it here: log
          // the stack loudly, mark the FAILED marker, return a clean bad_output so
          // the popup shows the REAL error and the harness fails fast. This is the
          // invisible-failure hole closed at the root (all four paths route here).
          const runner = (async (): Promise<TransformOutcome> => {
            const chosen = kind === 'hide' ? fastHidePath(intent) : kind === 'move' ? fastMovePath(intent) : kind === 'restyle-only' ? restyleOnlyPath(intent) : runStyle(intent);
            return await chosen;
          })().catch((err) => {
            const msg = (err as Error)?.message || 'Transform crashed (internal error).';
            logDebug(`LISTENER RUNNER CRASHED: ${msg}` + (err && (err as Error).stack ? `\n${(err as Error).stack}` : ''));
            rollbackFailed('internal error');
            return { ok: false, kind: 'bad_output', message: msg, paidCalls: 0, wallMs: 0 };
          });
          inFlight = runner.finally(() => { inFlight = null; });
        }
        return inFlight;
      }
      if (message.action === 'toggle') return toggleSiteState().then(() => ({ ok: true }));
      if (message.action === 'remove_all') return removeAll().then(() => ({ ok: true }));
      if (message.action === 'getSiteInfo') {
        return Promise.resolve({
          url: window.location.href,
          origin: window.location.origin,
          applied: document.documentElement.hasAttribute(`data-${APPLIED}`),
        });
      }
      return undefined;
    });
  },
});
