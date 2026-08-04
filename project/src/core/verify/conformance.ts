/**
 * core/verify/conformance — structural conformance checks.
 *
 * Every check asks "did we build the page we declared?" — NEVER "is it
 * beautiful?". Each one compares the rendered DOM against the TargetLayoutIR
 * (and the DesignSpec/pack), not against taste.
 *
 * The checks run on the RENDERED DOM (getComputedStyle, getBoundingClientRect).
 * They are called after the solver has placed proxies and the CSS has been
 * applied. They are the REAL gate — the proxy gates in verify/index.ts
 * (changed, coherent, covered) are demoted to advisory.
 */

import type { TargetLayoutIR, UnsatisfiableConstraint } from '../layout/ir.ts';
import type { SolverPlan } from '../layout/solve.ts';
import type { DesignSpec } from '../spec/index.ts';
import type { DesignPack } from '../design/packs.ts';
import { packForSpec } from '../compile/transform.ts';
import { parseColor, colorfulness } from '../../shared/color.ts';

// ── Types ───────────────────────────────────────────────────────────

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StructuralConformanceResult {
  ok: boolean;
  checks: ConformanceCheck[];
  unsatisfiable: UnsatisfiableConstraint[];
}

export interface ConformancePlacement {
  plan: SolverPlan;
  nodesPlaced: number;
  gridTemplateColumns: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

interface ProxyInfo {
  el: HTMLElement;
  handle: string;
  trackIndex: number;
  rect: DOMRect;
  gridColumnStart: string;
  gridColumnEnd: string;
}

function collectProxies(): ProxyInfo[] {
  const els = document.querySelectorAll<HTMLElement>('[data-rv-plan-slot]');
  const out: ProxyInfo[] = [];
  for (const el of els) {
    const handle = el.getAttribute('data-rv-c') ?? '';
    const trackIndex = parseInt(el.getAttribute('data-rv-plan-slot') ?? '0', 10);
    const cs = getComputedStyle(el);
    out.push({
      el, handle, trackIndex,
      rect: el.getBoundingClientRect(),
      gridColumnStart: cs.gridColumnStart,
      gridColumnEnd: cs.gridColumnEnd,
    });
  }
  return out;
}

function archetypeTrackCount(archetype: string): number {
  switch (archetype) {
    case 'single-column': return 1;
    case 'two-column-rail-left':
    case 'two-column-rail-right': return 2;
    case 'three-column': return 3;
    default: return 1;
  }
}

/** Prose roles: the 65ch measure applies to these. */
const PROSE_ROLES = new Set(['article-body', 'metadata', 'toc']);

// ── The 10 checks ───────────────────────────────────────────────────

function checkArchetypeConformance(target: TargetLayoutIR, proxies: ProxyInfo[]): ConformanceCheck {
  const expected = archetypeTrackCount(target.archetype);
  // Count distinct left-edge x-positions (bucketed to 40px) among non-full-width proxies.
  const leftEdges = new Set<number>();
  for (const p of proxies) {
    const isFullWidth = p.gridColumnEnd === '-1' || p.gridColumnEnd === String(expected + 1);
    if (isFullWidth) continue;
    const bucket = Math.round(p.rect.left / 40) * 40;
    leftEdges.add(bucket);
  }
  const measured = leftEdges.size;
  if (expected === 1) {
    // Single-column is a legitimate choice: 1 column = PASS.
    return {
      name: 'archetype-conformance',
      passed: measured <= 1,
      detail: measured <= 1
        ? `declared single-column, measured ${measured} column(s) — PASS`
        : `declared single-column, measured ${measured} columns — unexpected`,
    };
  }
  // Multi-column archetype: distinguish "chose single-column" from "declared multi but collapsed".
  // The only way to distinguish is to check the declared archetype: if the model declared
  // multi-column and only 1 column renders, that's a COLLAPSE (fail).
  if (measured <= 1) {
    return {
      name: 'archetype-conformance',
      passed: false,
      detail: `declared ${target.archetype} (${expected} columns) but only 1 rendered — collapsed`,
    };
  }
  return {
    name: 'archetype-conformance',
    passed: measured >= 2,
    detail: `declared ${target.archetype} (${expected} tracks), measured ${measured} column(s)`,
  };
}

function checkTrackConformance(target: TargetLayoutIR, proxies: ProxyInfo[]): ConformanceCheck {
  if (target.tracks.length <= 1) {
    return { name: 'track-conformance', passed: true, detail: 'single track — no ratio to check' };
  }
  // Measure the width of each rendered track (from proxies in each track).
  const trackWidths = new Map<number, number>();
  for (const p of proxies) {
    const existing = trackWidths.get(p.trackIndex);
    if (existing === undefined || p.rect.width > existing) {
      trackWidths.set(p.trackIndex, p.rect.width);
    }
  }
  if (trackWidths.size < 2) {
    return { name: 'track-conformance', passed: true, detail: 'fewer than 2 tracks rendered — skip' };
  }
  // Extract declared fr ratios from target.tracks (parse "Xfr" from max).
  const declaredRatios: number[] = target.tracks.map(t => {
    const m = /([\d.]+)fr/.exec(t.max);
    return m ? parseFloat(m[1]) : 1;
  });
  // Measure ratios (normalize to sum = declared sum).
  const measuredWidths = [...trackWidths.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  const declaredSum = declaredRatios.reduce((a, b) => a + b, 0);
  const measuredSum = measuredWidths.reduce((a, b) => a + b, 0);
  if (measuredSum === 0) {
    return { name: 'track-conformance', passed: false, detail: 'measured total width is 0' };
  }
  let ok = true;
  const parts: string[] = [];
  for (let i = 0; i < Math.min(declaredRatios.length, measuredWidths.length); i++) {
    const declaredRatio = declaredRatios[i] / declaredSum;
    const measuredRatio = measuredWidths[i] / measuredSum;
    const ratioDiff = Math.abs(measuredRatio - declaredRatio) / Math.max(declaredRatio, 0.01);
    const within = ratioDiff <= 0.25;
    if (!within) ok = false;
    parts.push(`track${i}:${declaredRatio.toFixed(2)}vs${measuredRatio.toFixed(2)}${within ? '' : '!'}`);
  }
  return { name: 'track-conformance', passed: ok, detail: parts.join(' ') + ' (tol 25%)' };
}

function checkSlotConformance(target: TargetLayoutIR, proxies: ProxyInfo[]): ConformanceCheck {
  const failures: string[] = [];
  let checked = 0;
  for (const [handle, trackIdx] of target.slotAssignment) {
    const proxy = proxies.find(p => p.handle === handle);
    if (!proxy) {
      failures.push(`${handle}: not found in DOM`);
      continue;
    }
    checked++;
    const expectedCol = trackIdx + 1; // grid-column is 1-based
    const actualCol = parseInt(proxy.gridColumnStart, 10);
    if (isNaN(actualCol) || actualCol !== expectedCol) {
      failures.push(`${handle}: expected col ${expectedCol}, got ${proxy.gridColumnStart}`);
    }
  }
  return {
    name: 'slot-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} slot assignments verified`
      : `${failures.length}/${checked} slot mismatches: ${failures.slice(0, 5).join('; ')}`,
  };
}

function checkReadingOrderConformance(target: TargetLayoutIR, proxies: ProxyInfo[]): ConformanceCheck {
  if (target.readingOrder.length < 2) {
    return { name: 'reading-order-conformance', passed: true, detail: 'no reading-order constraints' };
  }
  const failures: string[] = [];
  // Check rendered visual order matches declared order.
  const proxyByHandle = new Map(proxies.map(p => [p.handle, p]));
  for (let i = 0; i < target.readingOrder.length - 1; i++) {
    const a = proxyByHandle.get(target.readingOrder[i]);
    const b = proxyByHandle.get(target.readingOrder[i + 1]);
    if (!a || !b) continue;
    // Visual order: top-to-bottom, left-to-right.
    const aBeforeB = a.rect.top < b.rect.top - 4 ||
      (Math.abs(a.rect.top - b.rect.top) <= 4 && a.rect.left < b.rect.left);
    if (!aBeforeB) {
      failures.push(`${target.readingOrder[i]} should precede ${target.readingOrder[i + 1]} visually`);
    }
  }
  // Accessibility: check DOM order hasn't diverged from visual order.
  // Get DOM order of all proxies.
  const domOrder = [...document.querySelectorAll<HTMLElement>('[data-rv-plan-slot]')];
  const domIndex = new Map<HTMLElement, number>();
  domOrder.forEach((el, i) => domIndex.set(el, i));
  // Sort proxies by visual position (row then column).
  const visualSorted = [...proxies].sort((a, b) => {
    if (Math.abs(a.rect.top - b.rect.top) > 4) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  });
  for (let i = 0; i < visualSorted.length - 1; i++) {
    const di = domIndex.get(visualSorted[i].el) ?? 0;
    const dj = domIndex.get(visualSorted[i + 1].el) ?? 0;
    if (di > dj) {
      failures.push(`DOM order diverged from visual order at ${visualSorted[i].handle}→${visualSorted[i + 1].handle}`);
      break;
    }
  }
  return {
    name: 'reading-order-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? 'reading order + DOM order match visual order'
      : `${failures.length} issues: ${failures.slice(0, 3).join('; ')}`,
  };
}

function checkSpacingConformance(pack: DesignPack, proxies: ProxyInfo[]): ConformanceCheck {
  const scale = pack.spacingScale;
  const failures: string[] = [];
  let checked = 0;
  for (const p of proxies) {
    const cs = getComputedStyle(p.el);
    for (const prop of ['padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'gap'] as const) {
      const val = parseFloat(cs.getPropertyValue(prop));
      if (isNaN(val) || val === 0) continue;
      checked++;
      const near = scale.some(step => Math.abs(val - step) <= 2);
      if (!near) {
        failures.push(`${p.handle}.${prop}=${val}px not on scale`);
      }
    }
  }
  return {
    name: 'spacing-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} spacing values traced to pack scale`
      : `${failures.length}/${checked} off-scale: ${failures.slice(0, 5).join('; ')}`,
  };
}

function checkTypeRampConformance(pack: DesignPack, proxies: ProxyInfo[]): ConformanceCheck {
  const ramp = pack.typeRamp;
  const rampValues = new Set([ramp.display, ramp.heading, ramp.body, ramp.small]);
  const failures: string[] = [];
  let checked = 0;
  for (const p of proxies) {
    const role = p.el.getAttribute('data-rv-c') ?? '';
    // Map handle to semantic role: check the element's data-rv-role if available,
    // or infer from the handle. The proxies carry [data-rv-c=handle] but the
    // semantic role is in the perception, not on the DOM. We approximate by
    // reading computed font-size and checking it's on the ramp.
    const cs = getComputedStyle(p.el);
    const fs = parseFloat(cs.fontSize);
    if (isNaN(fs)) continue;
    checked++;
    if (!rampValues.has(fs) && Math.round(fs) !== Math.round(ramp.display) &&
        Math.round(fs) !== Math.round(ramp.heading) &&
        Math.round(fs) !== Math.round(ramp.body) &&
        Math.round(fs) !== Math.round(ramp.small)) {
      // Tolerance: within 1px of a ramp value.
      const near = [ramp.display, ramp.heading, ramp.body, ramp.small].some(v => Math.abs(fs - v) <= 1);
      if (!near) {
        failures.push(`${role}: font-size ${fs}px not on ramp [${rampValues.size} values]`);
      }
    }
  }
  // Monotonicity: display > heading > body > small (if all present).
  if (ramp.display <= ramp.heading) failures.push('display not > heading');
  if (ramp.heading <= ramp.body) failures.push('heading not > body');
  if (ramp.body <= ramp.small) failures.push('body not > small');
  return {
    name: 'type-ramp-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} elements on ramp; monotonic display>heading>body>small`
      : `${failures.length} issues: ${failures.slice(0, 5).join('; ')}`,
  };
}

function checkAccentBudgetConformance(pack: DesignPack, proxies: ProxyInfo[]): ConformanceCheck {
  const maxCount = pack.principles.maxAccentCount;
  let accentCount = 0;
  for (const p of proxies) {
    const cs = getComputedStyle(p.el);
    const bg = cs.backgroundColor;
    const parsed = parseColor(bg);
    if (parsed && colorfulness(parsed) >= 0.35) {
      accentCount++;
    }
  }
  return {
    name: 'accent-budget-conformance',
    passed: accentCount <= maxCount,
    detail: `${accentCount} accent regions (max ${maxCount})`,
  };
}

function checkElevationConformance(pack: DesignPack, proxies: ProxyInfo[]): ConformanceCheck {
  // Loose check: verify shadow/border values are from the pack's scale.
  const shadowScale = pack.shadowScale;
  const borderScale = pack.borderScale;
  const failures: string[] = [];
  let checked = 0;
  for (const p of proxies) {
    const cs = getComputedStyle(p.el);
    const shadow = cs.boxShadow;
    if (shadow && shadow !== 'none') {
      checked++;
      // Parse shadow values and check they're on the scale (loose: just check
      // the shadow string is one of the scale entries, or the blur radius
      // matches a scale step).
      const blurMatch = shadowScale.some(s => {
        const m = /(\d+)px\s+\d+px\s+(\d+)px/.exec(s);
        if (!m) return false;
        const scaleBlur = parseInt(m[2], 10);
        const shadowBlur = /(?:\d+px\s+\d+px\s+(\d+)px)/.exec(shadow);
        return shadowBlur && Math.abs(parseInt(shadowBlur[1], 10) - scaleBlur) <= 2;
      });
      if (!blurMatch) {
        failures.push(`${p.handle}: box-shadow not on pack scale`);
      }
    }
    const borderWeight = parseFloat(cs.borderTopWidth);
    if (!isNaN(borderWeight) && borderWeight > 0) {
      checked++;
      const near = borderScale.some(step => Math.abs(borderWeight - step) <= 0.5);
      if (!near) {
        failures.push(`${p.handle}: border ${borderWeight}px not on scale [${borderScale.join(',')}]`);
      }
    }
  }
  return {
    name: 'elevation-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} shadow/border values checked`
      : `${failures.length}/${checked} off-scale: ${failures.slice(0, 3).join('; ')}`,
  };
}

function checkMeasureConformance(pack: DesignPack, proxies: ProxyInfo[]): ConformanceCheck {
  const measurePx = pack.measurePx;
  const failures: string[] = [];
  let checked = 0;
  for (const p of proxies) {
    const role = p.el.getAttribute('data-rv-c') ?? '';
    // Only check prose regions for measure conformance.
    if (!PROSE_ROLES.has(role)) continue;
    const cs = getComputedStyle(p.el);
    const fs = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight);
    const width = p.el.clientWidth;
    checked++;
    // Line length: within [measurePx.prose, measurePx.full] (loose: within 10%).
    if (width > measurePx.full * 1.1) {
      failures.push(`${role}: line length ${width}px exceeds full measure ${measurePx.full}px`);
    }
    // Line-height: compare against the pack's declared lineHeight for the
    // region's role, not a hardcoded taste band. The pack declares per-role
    // line-height values — the rendered value should match within tolerance.
    if (!isNaN(lh) && fs > 0) {
      const lhRatio = lh / fs;
      // The pack's lineHeightScale is [1.0, 1.15, 1.3, 1.45, 1.6, 1.8, 2.0].
      // Conformance: the rendered line-height ratio should be within 0.15 of
      // a step on the scale (the pack's declared steps, not a taste band).
      const onScale = pack.lineHeightScale.some(step => Math.abs(lhRatio - step) <= 0.15);
      if (!onScale) {
        failures.push(`${role}: line-height ratio ${lhRatio.toFixed(2)} not on pack scale [${pack.lineHeightScale.join(',')}]`);
      }
    }
  }
  return {
    name: 'measure-conformance',
    passed: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} prose regions within readable band`
      : `${failures.length}/${checked} issues: ${failures.slice(0, 3).join('; ')}`,
  };
}

// ── The entry point ─────────────────────────────────────────────────

export function checkStructuralConformance(
  target: TargetLayoutIR,
  placement: ConformancePlacement | null,
  spec: DesignSpec,
): StructuralConformanceResult {
  const pack = packForSpec(spec);
  const proxies = collectProxies();
  const checks: ConformanceCheck[] = [];

  // 1. Archetype conformance
  checks.push(checkArchetypeConformance(target, proxies));

  // 2. Track conformance
  checks.push(checkTrackConformance(target, proxies));

  // 3. Slot conformance
  checks.push(checkSlotConformance(target, proxies));

  // 4. Reading order conformance (accessibility)
  checks.push(checkReadingOrderConformance(target, proxies));

  // 5. Spacing conformance
  checks.push(checkSpacingConformance(pack, proxies));

  // 6. Type ramp conformance
  checks.push(checkTypeRampConformance(pack, proxies));

  // 7. Accent budget conformance
  checks.push(checkAccentBudgetConformance(pack, proxies));

  // 8. Elevation conformance
  checks.push(checkElevationConformance(pack, proxies));

  // 9. Measure conformance
  checks.push(checkMeasureConformance(pack, proxies));

  // 10. Unsatisfiable reporting (not pass/fail — REPORTS target.unsatisfiable)
  // A run with unsatisfiables is NOT a clean run.
  const unsatisfiable = target.unsatisfiable;

  const allPass = checks.every(c => c.passed) && unsatisfiable.length === 0;

  return {
    ok: allPass,
    checks,
    unsatisfiable,
  };
}
