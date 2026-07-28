/**
 * core/compile/expand — the deterministic expander. Phase 2 of the semantic-IR
 * pivot.
 *
 * The model emits per-role design INTENTS (RoleIntent[]) + a design-language
 * pack; the expander maps intents + the pack + the Phase 1 semantic graph to
 * the concrete `rules`/`composition`/`ops` the compiler already consumes.
 *
 * Pure, deterministic, free (0 model calls). The model NEVER emits a raw px
 * spacing value, a raw px type size, or a raw color — it emits TOKEN GRAMMAR
 * (spacing steps, type-ramp roles, named accents, surface tiers) the expander
 * resolves against the pack + the model's packOverrides.
 *
 * Hard-safety rule (permanent, from Step 1): destructive intents (hidden /
 * collapse) are FORBIDDEN on roles below the confidence threshold (0.5) — the
 * classifier is < coin-flip sure what the region is, so deleting/collapsing it
 * risks removing misread content. Enforced here, in the expander — not just the
 * prompt.
 *
 * Escape hatch: the model MAY also emit raw `rules` (styles/layout on a
 * specific handle) when the intent vocabulary can't express the design. The
 * expander reports which handles the model gave raw rules for (the count + the
 * FRACTION of total targets = the vocabulary-gap metric; > 20% on a grid run =
 * a loud pivot-failure flag).
 */

import type { DesignSpec, DesignRule, DesignOp, RoleIntent, AestheticOverrides, StyleDecls, LayoutDecls } from '../spec/index.ts';
import type { Perception, Cluster } from '../perceive/index.ts';
import type { DesignRole } from '../perceive/semantic.ts';
import { resolvePack, type DesignPack, type TypeRole, type SurfaceTier } from '../design/packs.ts';

/** The destructive-confidence floor: a destructive intent (hidden/collapse) is
 *  forbidden on a role the classifier is < this sure about. The Step-1 value. */
export const DESTRUCTIVE_CONFIDENCE_FLOOR = 0.5;

export interface ExpansionResult {
  /** The expanded rules (one per resolved handle), mergeable with the spec's
   *  raw escape-hatch rules. */
  rules: DesignRule[];
  /** Region-level composition rules derived from placement/measure intents. */
  composition: DesignRule[];
  /** Structural ops derived from placement intents (topbar/relocate/collapse). */
  ops: DesignOp[];
  /** Handles the model ALSO gave a raw rule for (the escape hatch). Logged loudly. */
  escapeHatchUses: string[];
  /** escapeHatchUses ÷ total targets. > ~0.20 on a grid run = a pivot-failure flag. */
  escapeHatchFraction: number;
  /** Every handle an intent resolved to (the expander's allTargets). The model
   *  coverage gate + the escape-hatch denominator must count these — Phase 2 moved
   *  the model's output from raw rules to intents, so the pre-expansion spec.rules
   *  (the raw escape-hatch only) undercount what the model addressed. Without this,
   *  a spec with 8 raw overrides on top of 111 intent-expanded rules reads as
   *  modelCov=0.085 + escapeHatch=100% (a false pivot-failure flag). */
  expandedTargets: string[];
  /** The resolved pack (for conformance — it checks the CSS against this). */
  pack: DesignPack;
  /** Per-intent resolution diagnostics (for the run report). */
  notes: string[];
}

/**
 * Expand the spec's intents into rules/composition/ops. The PRIMARY model output
 * path. Pure: takes the spec + perception as data, returns the expansion. The
 * caller (compile/index.ts) merges these with any raw escape-hatch rules (raw
 * wins on a specific handle — the escape hatch is the model's explicit override)
 * then runs the existing compile path.
 */
export function expandIntents(spec: DesignSpec, perception: Perception): ExpansionResult {
  const pack = resolvePack(spec.pack, spec.packOverrides);
  const intents = spec.intents ?? [];

  const byHandle = new Map<string, Cluster>();
  for (const c of perception.clusters) byHandle.set(c.handle, c);
  const byRole = new Map<DesignRole, Cluster[]>();
  for (const c of perception.clusters) {
    const arr = byRole.get(c.designRole);
    if (arr) arr.push(c); else byRole.set(c.designRole, [c]);
  }
  const byGroup = new Map<string, Cluster[]>();
  for (const c of perception.clusters) {
    if (!c.group) continue;
    const arr = byGroup.get(c.group);
    if (arr) arr.push(c); else byGroup.set(c.group, [c]);
  }

  const rulesByHandle = new Map<string, DesignRule>();
  const compositionByHandle = new Map<string, DesignRule>();
  const ops: DesignOp[] = [];
  const notes: string[] = [];
  const allTargets = new Set<string>();       // every handle an intent resolved to
  const escapeHatchUses = new Set<string>();   // those the model ALSO gave a raw rule

  // Record which handles the model gave raw rules for (the escape hatch).
  for (const rule of spec.rules) escapeHatchUses.add(rule.target);

  /** Resolve an intent's target to the cluster handles it applies to. A role
   *  target fans out to every cluster with that designRole; a group target to
   *  every cluster in that group; a handle target to one (if it exists). A
   *  "role@group" target (the model sometimes qualifies a role with a group id)
   *  fans out to clusters of that role RESTRICTED to that group — a useful pattern
   *  (a role within a specific sibling group) the model is already expressing. */
  const resolveTarget = (intent: RoleIntent): Cluster[] => {
    const t = intent.target;
    // Explicit targetKind, or infer: a handle matches c[0-9a-z]{5}; a group
    // matches g[0-9a-z]{5}; a "role@g..." compound; else it's a role.
    let kind = intent.targetKind;
    if (!kind) {
      if (/^c[0-9a-z]{6}$/.test(t)) kind = 'handle';
      else if (/^g[0-9a-z]{6}$/.test(t)) kind = 'group';
      else kind = 'role';
    }
    if (kind === 'handle') {
      const c = byHandle.get(t);
      return c ? [c] : [];
    }
    if (kind === 'group') {
      return byGroup.get(t) ?? [];
    }
    // role — a "role@groupId" compound narrows the role to a specific group. The
    // model sometimes qualifies a role with a group id; if the suffix is a real
    // group id, restrict the role to that group; if it's not (a handle, garbage),
    // ignore the suffix and use the unfiltered role (don't drop the whole intent).
    if (t.includes('@')) {
      const [roleName, groupId] = t.split('@');
      const roleClusters = byRole.get(roleName as DesignRole) ?? [];
      if (!groupId || !byGroup.has(groupId)) return roleClusters;
      const inGroup = new Set(byGroup.get(groupId)!.map((c) => c.handle));
      return roleClusters.filter((c) => inGroup.has(c.handle));
    }
    // role — fan out to every cluster with that designRole (by role NAME).
    return byRole.get(t as DesignRole) ?? [];
  };

  /** Get-or-create a rule for a handle in the rules map (component rules). */
  const ruleFor = (handle: string): DesignRule => {
    let r = rulesByHandle.get(handle);
    if (!r) { r = { target: handle }; rulesByHandle.set(handle, r); }
    return r;
  };
  /** Get-or-create a composition rule (region-level proportions, compiled first). */
  const compFor = (handle: string): DesignRule => {
    let r = compositionByHandle.get(handle);
    if (!r) { r = { target: handle }; compositionByHandle.set(handle, r); }
    return r;
  };

  /** Merge a styles bag into a rule's styles (last-write-wins per key). */
  const addStyles = (r: DesignRule, styles: StyleDecls): void => {
    r.styles = { ...(r.styles ?? {}), ...styles };
  };
  /** Merge a layout bag into a rule's layout. */
  const addLayout = (r: DesignRule, layout: LayoutDecls): void => {
    r.layout = { ...(r.layout ?? {}), ...layout };
  };

  // ── Emphasis → type (ramp role) + surface + accent ──────────────────
  const emphasisTypeRole = (e: RoleIntent['emphasis']): TypeRole | undefined => {
    if (e === 'hero') return 'display';
    if (e === 'normal') return 'body';
    if (e === 'de-emphasized') return 'small';
    return undefined;
  };

  // ── Density → spacing-scale index + line-height modulation ───────────
  // compact = step 2, comfortable = step 4, spacious = step 6 on the scale.
  const densityStep = (d: RoleIntent['density']): number | undefined => {
    if (d === 'compact') return 2;
    if (d === 'comfortable') return 4;
    if (d === 'spacious') return 6;
    return undefined;
  };

  for (const intent of intents) {
    const clusters = resolveTarget(intent);
    if (!clusters.length) { notes.push(`intent ${intent.target}: no clusters matched`); continue; }

    for (const c of clusters) {
      allTargets.add(c.handle);

      // ── Hard-safety rule: destructive intents on low-confidence roles ──
      // hidden/collapse are FORBIDDEN when the classifier is < 0.5 sure what
      // this region is. A confident ad-or-void stays collapsible; an uncertain
      // role gets conservative treatment only.
      if (intent.emphasis === 'hidden' || intent.placement === 'collapse') {
        if (c.designRoleConfidence < DESTRUCTIVE_CONFIDENCE_FLOOR) {
          notes.push(`intent ${intent.target} (${c.handle}): ${intent.emphasis === 'hidden' ? 'hidden' : 'collapse'} REFUSED — role ${c.designRole}@${c.designRoleConfidence.toFixed(2)} < ${DESTRUCTIVE_CONFIDENCE_FLOOR} (hard-safety rule; low-confidence role gets conservative treatment only)`);
          continue;
        }
      }

      // ── Emphasis ──
      if (intent.emphasis === 'hidden') {
        const r = ruleFor(c.handle);
        r.hide = true;
      } else if (intent.emphasis) {
        const tr = intent.aesthetic?.typeRamp ?? emphasisTypeRole(intent.emphasis);
        if (tr) {
          const r = ruleFor(c.handle);
          addLayout(r, { fontSize: `${pack.typeRamp[tr]}px`, lineHeight: String(pack.lineHeight[tr]) });
          // A hero gets a bold weight; de-emphasized gets a lighter weight.
          if (intent.emphasis === 'hero') addLayout(r, { fontWeight: '700' });
          else if (intent.emphasis === 'de-emphasized') {
            addStyles(r, { color: pack.colors.subtle });
            addLayout(r, { fontWeight: '400' });
          }
        }
      }

      // ── Density → spacing (padding) + line-height modulation ──
      const ds = densityStep(intent.density);
      if (ds != null && pack.spacingScale[ds] != null) {
        const px = pack.spacingScale[ds];
        const r = ruleFor(c.handle);
        addStyles(r, { padding: `${px}px` });
        // Spacious bumps line-height up ~0.1; compact down ~0.1 from the body ramp.
        if (intent.density === 'spacious') addLayout(r, { lineHeight: String(pack.lineHeight.body + 0.1) });
        else if (intent.density === 'compact') addLayout(r, { lineHeight: String(Math.max(1.2, pack.lineHeight.body - 0.1)) });
      }

      // ── Measure → width (the pack's measurePx; compile percentifies it) ──
      if (intent.measure) {
        const px = pack.measurePx[intent.measure];
        const r = compFor(c.handle);
        addLayout(r, { maxWidth: `${px}px` });
      }

      // ── Placement → structural ops + composition ──
      if (intent.placement === 'topbar') {
        // Sidebar → full-width top bar: reorder the rail above the main content +
        // a composition width change. The reorder op is validated + executed by the
        // existing ops path; the width change widens the rail to full width.
        // Guard: if the cluster can't be reordered (moveSafety != safe — nav is
        // forbidden/risky to move), the reorder is refused by guard laws. Emitting
        // only the width:100% widens the rail IN PLACE → overflow + squeezed content
        // (the half-applied topbar). So refuse the whole topbar on a non-safe target
        // (the Architect should use a narrowing 'measure' or 'collapse' instead).
        if (c.moveSafety !== 'safe') {
          notes.push(`intent ${intent.target} (${c.handle}): topbar REFUSED — moveSafety=${c.moveSafety}; a non-reorderable rail widened in place overflows (use a narrowing measure or collapse instead)`);
        } else {
          ops.push({ kind: 'reorder', target: c.handle });
          const r = compFor(c.handle);
          addLayout(r, { width: '100%', maxWidth: '100%' });
          notes.push(`intent ${intent.target} (${c.handle}): topbar — reorder + full-width`);
        }
      } else if (intent.placement === 'collapse') {
        // A high-confidence void (gated above) → remove op (reclaims the space).
        ops.push({ kind: 'remove', target: c.handle });
        notes.push(`intent ${intent.target} (${c.handle}): collapse — remove op`);
      } else if (intent.placement === 'relocate') {
        ops.push({ kind: 'move', target: c.handle });
        notes.push(`intent ${intent.target} (${c.handle}): relocate — move op (no dest; compile refuses without to)`);
      } else if (intent.placement && typeof intent.placement === 'object' && intent.placement.kind === 'relocate') {
        ops.push({ kind: 'move', target: c.handle, to: intent.placement.to });
        notes.push(`intent ${intent.target} (${c.handle}): relocate → ${intent.placement.to}`);
      }

      // ── Aesthetic overrides → styles in token grammar ──
      if (intent.aesthetic) {
        const a = intent.aesthetic;
        const r = ruleFor(c.handle);
        // Surface tier → the pack's surface bg/border/shadow.
        if (a.surface) {
          const surf = pack.surfaces[a.surface];
          if (surf) {
            addStyles(r, { background: surf.bg });
            if (a.texture === 'glass') addStyles(r, { backdropFilter: 'blur(12px)' });
          }
        }
        // Named accent → the pack's accent hex (the model never emits a raw hex).
        if (a.accent && pack.colors.accents[a.accent]) {
          addStyles(r, { background: pack.colors.accents[a.accent] });
        }
        // Scale steps → the pack's scale values (the model never emits a raw px).
        if (a.radiusStep != null && pack.radiusScale[a.radiusStep] != null) {
          const rv = pack.radiusScale[a.radiusStep];
          addStyles(r, { borderRadius: rv >= 999 ? '9999px' : `${rv}px` });
        }
        if (a.borderStep != null && pack.borderScale[a.borderStep] != null) {
          addStyles(r, { borderWidth: `${pack.borderScale[a.borderStep]}px`, borderStyle: 'solid', borderColor: pack.colors.subtle });
        }
        if (a.shadowStep != null && pack.shadowScale[a.shadowStep] != null) {
          addStyles(r, { boxShadow: pack.shadowScale[a.shadowStep] });
        }
        // Type-ramp role overrides the emphasis-derived size.
        if (a.typeRamp) {
          addLayout(r, { fontSize: `${pack.typeRamp[a.typeRamp]}px`, lineHeight: String(pack.lineHeight[a.typeRamp]) });
        }
      }
    }
  }

  // Filter rules to those that actually carry something (drop empty placeholders).
  const rules = [...rulesByHandle.values()].filter((r) => r.styles || r.layout || r.hover || r.focusVisible || r.hide);
  const composition = [...compositionByHandle.values()].filter((r) => r.styles || r.layout || r.hide);

  // Escape-hatch metric: the handles the model gave raw rules for ÷ the handles
  // the intents resolved to. A raw rule on a handle the intents DIDN'T target
  // is a pure escape-hatch use (the model reached below the vocabulary); a raw
  // rule on a handle the intents ALSO targeted is an override (still counts —
  // the model bypassed the vocabulary for that handle).
  const escapeCount = [...escapeHatchUses].filter((h) => allTargets.has(h) || byHandle.has(h)).length;
  const totalTargets = allTargets.size || 1;
  const escapeHatchFraction = escapeCount / totalTargets;

  return { rules, composition, ops, escapeHatchUses: [...escapeHatchUses], escapeHatchFraction, expandedTargets: [...allTargets], pack, notes };
}

/** Resolve a pack from a spec (for conformance — it checks the CSS against the
 *  pack the expander used). */
export function packForSpec(spec: DesignSpec): DesignPack {
  return resolvePack(spec.pack, spec.packOverrides);
}

export type { DesignPack, TypeRole, SurfaceTier };
