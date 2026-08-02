/**
 * core/layout/length — Law 0: Give Layout Back to the Browser.
 *
 * A Length carries PROVENANCE: where the value came from. Every value the
 * compiler emits must be constructed through this type. A measurement-provenance
 * length reaching the emitter is a HARD REJECTION, not a warning — measurements
 * may inform decisions; they may never become output.
 *
 * Provenance kinds:
 *   token            — from a design token (fluid clamp set, CSS custom property)
 *   authorConstraint — from the layout language (slot minWidth, preferredWidth)
 *   intrinsic        — from the element's own intrinsic sizing (auto, min-content, fit-content)
 *   measurement      — from a captured rect (getBoundingClientRect / computed style) — NEVER emitted
 */

export type LengthProvenance = 'token' | 'authorConstraint' | 'intrinsic' | 'measurement';

export type LengthUnit =
  | 'px' | '%' | 'fr' | 'vw' | 'vh' | 'rem' | 'em'
  | 'auto' | 'min-content' | 'max-content' | 'fit-content' | 'none';

export interface Length {
  readonly value: number;
  readonly unit: LengthUnit;
  readonly provenance: LengthProvenance;
}

// ── Factories ───────────────────────────────────────────────────────

/** A design-token length (fluid clamp set, CSS custom property). */
export function token(value: number, unit: LengthUnit): Length {
  return { value, unit, provenance: 'token' };
}

/** A layout-language constraint (slot minWidth, preferredWidth ceiling). */
export function authorConstraint(value: number, unit: LengthUnit): Length {
  return { value, unit, provenance: 'authorConstraint' };
}

/** An intrinsic sizing keyword (auto, min-content, fit-content, max-content). */
export function intrinsic(unit: 'auto' | 'min-content' | 'max-content' | 'fit-content'): Length {
  return { value: 0, unit, provenance: 'intrinsic' };
}

/** A measurement-provenance length — informs decisions, NEVER emitted. */
export function measurement(value: number, unit: LengthUnit): Length {
  return { value, unit, provenance: 'measurement' };
}

// ── Serialization ────────────────────────────────────────────────────

/** Serialize a Length to a CSS string. Intrinsic keywords emit bare. */
export function serialize(l: Length): string {
  switch (l.unit) {
    case 'auto': case 'min-content': case 'max-content': case 'fit-content': case 'none':
      return l.unit;
    default:
      return `${l.value}${l.unit}`;
  }
}

// ── Assertion (the load-bearing gate) ───────────────────────────────

export interface AssertResult {
  passed: boolean;
  violations: string[];
}

/** Compiler-level assertion pass: reject any measurement-provenance length
 *  that reached the final declaration set. This is the gate that makes Law 0
 *  mechanically impossible to violate. */
export function assertNoMeasurementLengths(decls: Map<string, Length[]>): AssertResult {
  const violations: string[] = [];
  for (const [selector, lengths] of decls) {
    for (const l of lengths) {
      if (l.provenance === 'measurement') {
        violations.push(`${selector}: ${l.value}${l.unit} (measurement — must not be emitted)`);
      }
    }
  }
  return { passed: violations.length === 0, violations };
}
