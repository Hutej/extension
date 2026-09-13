/**
 * runtime/verify — mandatory structured verification (plan/03 `runtime/verify`,
 * plan/08 §6, algorithm A7, roadmap S4.3).
 *
 * Three distinct results over a bounded measured scope:
 *   - DELIVERY: the staged bundle is confirmed inserted; candidate targets
 *     carry the composition token (an inert sheet is not an effect).
 *   - EFFECT: each declared postcondition holds — including already-satisfied
 *     values (no-change alone is never failure, change alone never success).
 *   - INTEGRITY: already-accepted state still holds after the new batch —
 *     each accepted revision's measured declarations, texts and owned nodes
 *     re-verified (T30), pre-existing breakage exempt and disclosed. The
 *     former speculative side-effect police (visibility/focusability/
 *     overflow/contrast heuristics over protected elements and parent/
 *     sibling sentinels) is CUT (owner direction, 2026-09-13): the operation
 *     set cannot remove elements, disable controls or pause media, and the
 *     heuristics false-failed user-approved restyles (thick borders grew
 *     scrollWidth; visibility heuristics misread restyled ancestors). The
 *     effect checks remain the honesty contract: what was declared must hold.
 *
 * Truthfulness rules (I11/T13): a missing, throwing or malformed verifier is
 * UNKNOWN, never pass; an empty check set is unknown, never an empty-array
 * pass; pre-existing breakage is exempt and disclosed, never silently
 * dropped. One bounded recheck after settle; a still-unknown result rolls
 * the provisional candidate back. No probe modifies native content: the
 * owned probe element is removed in `finally`. The user's window is never
 * resized or moved (I22) — measurements are read-only.
 */

import { TOKEN_ATTRIBUTE } from './styles.ts';

// ── shapes ───────────────────────────────────────────────────────────────

export interface ComputedLike {
  getPropertyValue(name: string): string;
}

export interface RectLike {
  width: number;
  height: number;
}

export interface CheckOutcome {
  key: string;
  section: 'delivery' | 'effect' | 'integrity';
  status: 'pass' | 'fail' | 'unknown' | 'satisfied';
  detail?: string;
}

export interface VerificationReport {
  revisionId: string;
  batchId: string;
  epoch: number;
  status: 'pass' | 'fail' | 'unknown';
  /** Bounded non-pass outcomes (structured keys), fail entries first. */
  issues: CheckOutcome[];
  counts: { pass: number; satisfied: number; fail: number; unknown: number };
  coverage: {
    combinedRevisions: number;
    checks: number;
    /** Declarations excluded from effect measurement by design. */
    unmeasuredDecls: number;
    /** Combined checks already broken before the candidate (exempt, disclosed). */
    preExistingBroken: number;
    rechecked: boolean;
  };
}

export interface StyleEffectCheck {
  key: string;
  el: Element;
  property: string;
  value: string;
  pseudo?: '::before' | '::after';
}

export interface TextEffectCheck {
  key: string;
  node: Text;
  installed: string;
}

export interface InsertEffectCheck {
  key: string;
  roots: Element[];
  /** The parent the roots must sit in (captured before insertion). */
  expectedParent: Element | null;
}

export interface CombinedCheck {
  key: string;
  el: Element;
  property: string;
  value: string;
}

export interface CombinedSample {
  customizationId: string;
  revisionId: string;
  checks: CombinedCheck[];
  texts: Array<{ key: string; node: Text; installed: string }>;
  nodes: Array<{ key: string; el: Element }>;
}

export interface VerifyPlan {
  batchId: string;
  revisionId: string;
  entryEpoch: number;
  /** The candidate CSS bundle is confirmed inserted (broker receipt). */
  staged: boolean;
  styles: StyleEffectCheck[];
  texts: TextEffectCheck[];
  inserts: InsertEffectCheck[];
  combined: CombinedSample[];
  /** S7.1: installed keyboard bindings — the chord must be live. */
  bindings: Array<{ key: string; normalized: string }>;
  /** S7.2: owned collapse disclosures — the toggle must sit at its validated
   *  anchor, and a collapsed initial state must measure display:none. */
  collapses: Array<{ key: string; toggle: Element; expectedParent: Element | null; target: Element; collapsed: boolean }>;
  /** S7.2: the installed local rule — it must be live. */
  rules: Array<{ key: string; ruleKey: string }>;
  /** S8.1: linked projection views — connected at the validated anchor with
   *  the expected rendered count and a coverage line. */
  projections: Array<{ key: string; root: Element; expectedParent: Element | null; expectedItems: number; container: Element }>;
  tokenChecks: Array<{ key: string; el: Element; ns: string }>;
  /** S8.3: root-local author stylesheets — installed inside each open shadow
   *  root whose targets the document fragment cannot reach (plan/12 §3). */
  localSheets: Array<{ key: string; root: Node; node: Element | null }>;
  /** Declarations skipped by design (custom properties) — disclosed, never silently. */
  unmeasuredDecls: number;
}

export interface ElBaseline {
  key: string;
  computed: Record<string, string>;
}

export interface VerifyBaseline {
  els: Map<string, ElBaseline>;
}

export interface Verifier {
  /** Capture the mandatory pre-write baseline (A4 step 2). Any measurement
   *  failure refuses the batch BEFORE activation. */
  captureBaseline(plan: VerifyPlan): { ok: true; baseline: VerifyBaseline } | { ok: false; detail: string };
  /** Verify the candidate against the baseline. Unknown outcomes get ONE
   *  bounded recheck; the aggregate is fail > unknown > pass. */
  verify(plan: VerifyPlan, baseline: VerifyBaseline): Promise<VerificationReport>;
}

export interface VerifierDeps {
  doc: Document;
  now(): number;
  /** Computed style reader (seam for unit tests). */
  computedOf(el: Element, pseudo?: '::before' | '::after'): ComputedLike | null;
  /** Canonical computed form of a DECLARED value in the target's inheritance
   *  context (owned probe element, removed in finally). */
  canonicalOf(declared: string, property: string, context: Element): string;
  /** Canonical computed forms of a SHORTHAND's longhands (the same owned
   *  probe sets the shorthand; each longhand is read from its computation).
   *  Computed shorthands have no single value form in Chrome — verification
   *  rides the longhands (owner-directed shorthand fix, 2026-09-13). */
  canonicalAllOf(declared: string, shorthandProperty: string, longhands: string[], context: Element): string[];
  rectOf(el: Element): RectLike | null;
  /** Bounded wait before the single recheck of unknown outcomes. */
  recheckWait?(): Promise<void>;
  /** S7.1: measured postcondition for keyboard bindings — is this chord live
   *  in the behavior registry? A missing seam fails the check (never an
   *  accidental pass, T13). */
  isBound(normalized: string): boolean;
  /** S7.2: measured postcondition for local rules — is this rule live? */
  hasRule(customizationId: string): boolean;
}

// ── bounds ───────────────────────────────────────────────────────────────

export const MAX_BASELINE_ELS = 48;
export const MAX_COMBINED_CHECKS_PER_REVISION = 4;
export const MAX_ISSUES = 32;

// ── helpers ──────────────────────────────────────────────────────────────

/** Bounded shorthand → longhand table for the effect check: computed
 *  shorthands have no single value form, so their declared effect verifies
 *  through every longhand the shorthand sets (browser-resolved). */
const SHORTHAND_LONGHANDS: Record<string, string[]> = {
  border: ['border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style', 'border-right-color', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  overflow: ['overflow-x', 'overflow-y'],
  gap: ['row-gap', 'column-gap'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'place-items': ['align-items', 'justify-items'],
  background: ['background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'background-attachment'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-size', 'line-height', 'font-family'],
};

/** Compare a computed value against the canonical form of the declared value:
 *  exact after trim/lowercase, or numerically equal after a px strip ('0' ≡
 *  '0px'). Colors compare through the canonical form, so this never invents
 *  equality — only provable equality passes. */
function valueMatches(computed: string, canonical: string): boolean {
  const a = computed.trim().toLowerCase();
  const b = canonical.trim().toLowerCase();
  if (a === b) return true;
  const na = Number.parseFloat(a.replace(/px$/, ''));
  const nb = Number.parseFloat(b.replace(/px$/, ''));
  if (Number.isFinite(na) && Number.isFinite(nb) && /^-?[\d.]+(px)?$/.test(a) && /^-?[\d.]+(px)?$/.test(b)) {
    return Math.abs(na - nb) < 0.01;
  }
  return false;
}

/** Production canonicalizer: an OWNED probe element (removed in finally)
 *  computes the declared value in the target's inheritance context, so
 *  'red'/'rgb(255,0,0)'/'1em' compare against real computed forms. Probe work
 *  never modifies native content (plan/03) and never touches the window (I22). */
export function probeCanonicalOf(doc: Document): VerifierDeps['canonicalOf'] {
  return (declared, property, context) => {
    let probe: HTMLElement | null = null;
    try {
      probe = doc.createElement('span');
      probe.setAttribute('data-rv2-verify-probe', '1');
      probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;${property}:${declared}!important`;
      // Relative declared values (em/unitless line-height/…) resolve against
      // the inheritance context they are measured in — the probe computes in
      // the TARGET's own context (absolute + hidden + removed in finally, so
      // native layout never changes; void targets fall back to the parent).
      let host: HTMLElement = context as HTMLElement;
      try {
        host.appendChild(probe);
      } catch {
        host = (context.parentElement ?? context) as HTMLElement;
        host.appendChild(probe);
      }
      const v = doc.defaultView?.getComputedStyle(probe).getPropertyValue(property);
      return (v ?? '').trim() || declared.trim();
    } catch {
      return declared.trim();
    } finally {
      try { probe?.remove(); } catch { /* detached */ }
    }
  };
}

/** Production shorthand canonicalizer: ONE owned probe with the shorthand;
 *  each longhand read from the probe's computed form (removed in finally). */
export function probeCanonicalAllOf(doc: Document): VerifierDeps['canonicalAllOf'] {
  return (declared, shorthandProperty, longhands, context) => {
    let probe: HTMLElement | null = null;
    try {
      probe = doc.createElement('span');
      probe.setAttribute('data-rv2-verify-probe', '1');
      probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;${shorthandProperty}:${declared}!important`;
      const host = (context.parentElement ?? context) as HTMLElement;
      host.appendChild(probe);
      const computed = doc.defaultView?.getComputedStyle(probe);
      return longhands.map((lh) => (computed?.getPropertyValue(lh) ?? '').trim() || declared.trim());
    } catch {
      return longhands.map(() => declared.trim());
    } finally {
      try { probe?.remove(); } catch { /* detached */ }
    }
  };
}

// ── verifier ─────────────────────────────────────────────────────────────

export function createVerifier(deps: VerifierDeps): Verifier {
  const sampleEl = (key: string, el: Element, computedProps: string[]): ElBaseline => {
    const computed = deps.computedOf(el);
    const entry: ElBaseline = { key, computed: {} };
    for (const p of computedProps) {
      entry.computed[p] = computed?.getPropertyValue(p) ?? '';
    }
    return entry;
  };

  const captureBaseline = (plan: VerifyPlan): { ok: true; baseline: VerifyBaseline } | { ok: false; detail: string } => {
    try {
      const els = new Map<string, ElBaseline>();
      let budget = MAX_BASELINE_ELS;
      const propsOf = new Map<Element, string[]>();
      for (const c of plan.combined) {
        for (const chk of c.checks) {
          const list = propsOf.get(chk.el) ?? [];
          if (!list.includes(chk.property)) list.push(chk.property);
          propsOf.set(chk.el, list);
        }
      }
      const cap = (key: string, el: Element, props: string[]): boolean => {
        if (els.has(key)) return true;
        if (budget <= 0) return false;
        budget -= 1;
        els.set(key, sampleEl(key, el, props));
        return true;
      };
      for (const c of plan.combined) {
        for (const chk of c.checks) {
          if (!cap(chk.key, chk.el, propsOf.get(chk.el) ?? [])) break;
        }
        for (const n of c.nodes) if (!cap(n.key, n.el, [])) break;
      }
      return { ok: true, baseline: { els } };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  };

  type CheckRun = { outcomes: CheckOutcome[]; preExistingBroken: number };
  const runChecks = (plan: VerifyPlan, baseline: VerifyBaseline, recheckKeys: Set<string> | null): CheckRun => {
    const outcomes: CheckOutcome[] = [];
    const want = (key: string): boolean => recheckKeys === null || recheckKeys.has(key);

    // DELIVERY
    if (want('delivery:css')) {
      outcomes.push(plan.staged
        ? { key: 'delivery:css', section: 'delivery', status: 'pass' }
        : { key: 'delivery:css', section: 'delivery', status: 'satisfied', detail: 'no CSS resource in this batch' });
    }
    for (const t of plan.tokenChecks) {
      if (!want(t.key)) continue;
      if (!t.el.isConnected) {
        outcomes.push({ key: t.key, section: 'delivery', status: 'unknown', detail: 'a candidate target left the document before verification' });
      } else if (t.el.getAttribute(TOKEN_ATTRIBUTE) === t.ns) {
        outcomes.push({ key: t.key, section: 'delivery', status: 'pass' });
      } else {
        outcomes.push({ key: t.key, section: 'delivery', status: 'fail', detail: 'a candidate target lost its composition token (site interference)' });
      }
    }

    for (const [j, ls] of plan.localSheets.entries()) {
      const key = ls.key ?? `delivery:local-sheet:${j}`;
      if (!want(key)) continue;
      if (ls.node === null) {
        outcomes.push({ key, section: 'delivery', status: 'unknown', detail: 'the root-local stylesheet was not installed (the root could not host it)' });
      } else if (!ls.node.isConnected || ls.node.parentNode !== ls.root) {
        outcomes.push({ key, section: 'delivery', status: 'fail', detail: 'the root-local stylesheet left its shadow root (site interference)' });
      } else if ((ls.node.textContent ?? '').length === 0) {
        outcomes.push({ key, section: 'delivery', status: 'fail', detail: 'the root-local stylesheet carries no bytes' });
      } else {
        outcomes.push({ key, section: 'delivery', status: 'pass' });
      }
    }

    // EFFECT
    for (const c of plan.styles) {
      if (!want(c.key)) continue;
      const computed = deps.computedOf(c.el, c.pseudo);
      if (computed === null) {
        outcomes.push({ key: c.key, section: 'effect', status: 'unknown', detail: 'computed style unavailable' });
        continue;
      }
      const longhands = SHORTHAND_LONGHANDS[c.property];
      if (longhands !== undefined) {
        // Shorthand: no single computed form — every longhand the shorthand
        // sets must hold the browser-resolved declared effect.
        const canonicals = deps.canonicalAllOf(c.value, c.property, longhands, c.el);
        const hold = longhands.every((lh, i) => valueMatches(computed.getPropertyValue(lh), canonicals[i] ?? ''));
        outcomes.push({
          key: c.key,
          section: 'effect',
          status: hold ? 'pass' : 'fail',
          ...(hold ? {} : { detail: `computed longhands [${longhands.map((lh) => `${lh}=${(computed.getPropertyValue(lh) ?? '').trim()}`).join(', ')}] do not hold the declared "${c.value.trim()}"` }),
        });
        continue;
      }
      const actual = computed.getPropertyValue(c.property);
      const canonical = deps.canonicalOf(c.value, c.property, c.el);
      if (valueMatches(actual, canonical)) {
        outcomes.push({ key: c.key, section: 'effect', status: 'pass' });
      } else {
        outcomes.push({ key: c.key, section: 'effect', status: 'fail', detail: `computed "${actual.trim()}" does not hold the declared "${c.value.trim()}"` });
      }
    }
    for (const t of plan.texts) {
      if (!want(t.key)) continue;
      if (!t.node.isConnected) outcomes.push({ key: t.key, section: 'effect', status: 'fail', detail: 'the text target left the document' });
      else if (t.node.nodeValue === t.installed) outcomes.push({ key: t.key, section: 'effect', status: 'pass' });
      else outcomes.push({ key: t.key, section: 'effect', status: 'fail', detail: 'the text target does not hold its installed value' });
    }
    for (const ins of plan.inserts) {
      if (!want(ins.key)) continue;
      const placed = ins.roots.every((r) => r.isConnected && r.parentNode === ins.expectedParent);
      outcomes.push(placed
        ? { key: ins.key, section: 'effect', status: 'pass' }
        : { key: ins.key, section: 'effect', status: 'fail', detail: 'the owned tree is not connected at its validated anchor' });
    }
    for (const b of plan.bindings) {
      if (!want(b.key)) continue;
      outcomes.push(deps.isBound(b.normalized)
        ? { key: b.key, section: 'effect', status: 'pass' }
        : { key: b.key, section: 'effect', status: 'fail', detail: 'the keyboard binding is not installed in the behavior registry' });
    }
    for (const c of plan.collapses) {
      if (!want(c.key)) continue;
      const placed = c.toggle.isConnected && c.toggle.parentNode === c.expectedParent;
      if (!placed) {
        outcomes.push({ key: c.key, section: 'effect', status: 'fail', detail: 'the disclosure toggle is not connected at its validated anchor' });
        continue;
      }
      if (!c.collapsed) {
        outcomes.push({ key: c.key, section: 'effect', status: 'pass' });
        continue;
      }
      const display = deps.computedOf(c.target)?.getPropertyValue('display');
      outcomes.push(display === 'none'
        ? { key: c.key, section: 'effect', status: 'pass' }
        : { key: c.key, section: 'effect', status: 'fail', detail: `the collapsed target measures display "${display ?? 'unknown'}", not none` });
    }
    for (const r of plan.rules) {
      if (!want(r.key)) continue;
      outcomes.push(deps.hasRule(r.ruleKey)
        ? { key: r.key, section: 'effect', status: 'pass' }
        : { key: r.key, section: 'effect', status: 'fail', detail: 'the behavior rule is not installed in the behavior registry' });
    }
    for (const p of plan.projections) {
      if (!want(p.key)) continue;
      const placed = p.root.isConnected && p.root.parentNode === p.expectedParent;
      if (!placed) {
        outcomes.push({ key: p.key, section: 'effect', status: 'fail', detail: 'the projection view is not connected at its validated anchor' });
        continue;
      }
      const rendered = p.root.querySelectorAll('[data-rv2p-card]').length;
      if (rendered !== p.expectedItems) {
        outcomes.push({ key: `${p.key}:items`, section: 'effect', status: 'fail', detail: `the projection renders ${rendered} item(s), expected ${p.expectedItems}` });
      } else {
        outcomes.push({ key: `${p.key}:items`, section: 'effect', status: 'pass' });
      }
      const coverage = p.root.querySelector('[data-rv2p-coverage]');
      outcomes.push(coverage !== null && (coverage.textContent ?? '').includes('Showing')
        ? { key: `${p.key}:coverage`, section: 'effect', status: 'pass' }
        : { key: `${p.key}:coverage`, section: 'effect', status: 'fail', detail: 'the projection coverage line is missing' });
      if (!p.container.isConnected) {
        outcomes.push({ key: `${p.key}:source`, section: 'effect', status: 'fail', detail: 'the projection source set left the document' });
      }
    }

    // COMBINED revision verification (T30: the candidate is verified against
    // the whole composition, not in isolation; pre-existing breakage is
    // exempt and disclosed, never silently dropped).
    let preExistingBroken = 0;
    for (const c of plan.combined) {
      for (const chk of c.checks) {
        if (!want(chk.key)) continue;
        const base = baseline.els.get(chk.key);
        const computed = deps.computedOf(chk.el);
        const actual = computed?.getPropertyValue(chk.property);
        if (!base || actual === undefined) {
          outcomes.push({ key: chk.key, section: 'integrity', status: 'unknown', detail: 'the combined revision sample could not be measured' });
          continue;
        }
        const canonical = deps.canonicalOf(chk.value, chk.property, chk.el);
        const baseHeld = valueMatches(base.computed[chk.property] ?? '', canonical);
        if (!baseHeld) {
          preExistingBroken += 1; // already broken before the candidate — exempt, disclosed
          continue;
        }
        if (valueMatches(actual, canonical)) {
          outcomes.push({ key: chk.key, section: 'integrity', status: 'pass' });
        } else {
          outcomes.push({ key: chk.key, section: 'integrity', status: 'fail', detail: `an accepted revision's effect ("${chk.value}") no longer holds ("${actual.trim()}")` });
        }
      }
      for (const t of c.texts) {
        if (!want(t.key)) continue;
        if (!t.node.isConnected || t.node.nodeValue !== t.installed) {
          outcomes.push({ key: t.key, section: 'integrity', status: 'fail', detail: 'an accepted revision no longer holds its text value' });
        } else {
          outcomes.push({ key: t.key, section: 'integrity', status: 'pass' });
        }
      }
      for (const n of c.nodes) {
        if (!want(n.key)) continue;
        outcomes.push(n.el.isConnected
          ? { key: n.key, section: 'integrity', status: 'pass' }
          : { key: n.key, section: 'integrity', status: 'fail', detail: 'an accepted owned tree left the document' });
      }
    }

    return { outcomes, preExistingBroken };
  };

  const verify = async (plan: VerifyPlan, baseline: VerifyBaseline): Promise<VerificationReport> => {
    let first: CheckRun = runChecks(plan, baseline, null);
    let rechecked = false;
    const unknownKeys = new Set<string>(first.outcomes.filter((o) => o.status === 'unknown').map((o) => o.key));
    if (unknownKeys.size > 0) {
      await (deps.recheckWait ? deps.recheckWait() : Promise.resolve());
      const second = runChecks(plan, baseline, unknownKeys);
      rechecked = true;
      // Replace the rechecked outcomes; keep the rest from the first pass.
      const kept = first.outcomes.filter((o) => !unknownKeys.has(o.key));
      first = { outcomes: [...kept, ...second.outcomes], preExistingBroken: first.preExistingBroken + second.preExistingBroken };
    }

    const counts = { pass: 0, satisfied: 0, fail: 0, unknown: 0 };
    for (const o of first.outcomes) {
      if (o.status === 'pass') counts.pass += 1;
      else if (o.status === 'satisfied') counts.satisfied += 1;
      else if (o.status === 'fail') counts.fail += 1;
      else counts.unknown += 1;
    }
    let status: VerificationReport['status'];
    if (first.outcomes.length === 0) {
      status = 'unknown'; // no empty-array fallback pass (T13)
    } else if (counts.fail > 0) {
      status = 'fail';
    } else if (counts.unknown > 0) {
      status = 'unknown';
    } else {
      status = 'pass';
    }
    const issues = first.outcomes
      .filter((o) => o.status === 'fail' || o.status === 'unknown')
      .slice(0, MAX_ISSUES);
    return {
      revisionId: plan.revisionId,
      batchId: plan.batchId,
      epoch: plan.entryEpoch,
      status,
      issues,
      counts,
      coverage: {
        combinedRevisions: plan.combined.length,
        checks: first.outcomes.length,
        unmeasuredDecls: plan.unmeasuredDecls,
        preExistingBroken: first.preExistingBroken,
        rechecked,
      },
    };
  };

  return { captureBaseline, verify };
}
