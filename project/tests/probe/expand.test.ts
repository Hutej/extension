/**
 * Self-check for core/compile/transform — the deterministic transformation
 * engine, + the conformance check. One runnable check (ponytail rule:
 * non-trivial logic leaves the smallest thing that fails if the logic
 * breaks). Run:
 *   node --experimental-strip-types tests/probe/expand.test.ts
 *
 * Tests:
 *  - a role-targeted relation fans out to every member of that role.
 *  - a widthFraction relation produces a composition width.
 *  - a hide on a low-confidence role is REFUSED (hard-safety rule).
 *  - a hide on a high-confidence role produces a hide rule.
 *  - the escape-hatch fraction is computed.
 *  - conformance: an on-pack CSS passes; an off-scale spacing value violates.
 */
import { transformIntent } from '../../src/core/compile/transform.ts';
import { checkConformance } from '../../src/core/verify/index.ts';
import type { DesignSpec } from '../../src/core/spec/index.ts';
import type { Perception, Cluster } from '../../src/core/perceive/index.ts';
import type { DesignRole } from '../../src/core/perceive/semantic.ts';

// A minimal Cluster factory (only the fields the engine reads).
function cl(handle: string, role: DesignRole, conf: number, opts: Partial<Cluster> = {}): Cluster {
  return {
    handle, selector: `[data-rv-c="${handle}"]`, count: 1, tag: 'div', role: null,
    isNativeControl: false, isCheckboxRadio: false, hasSolidBg: false,
    rect: { x: 0, y: 0, w: 800, h: 200, vx: 0, vy: 0, aboveFold: true }, samples: [], style: { background: '', color: '', border: 'none', borderRadius: '0px', boxShadow: 'none', fontFamily: 'sans-serif', fontSize: '16px', fontWeight: '400', padding: '0', display: 'block', hasBgImage: false },
    layout: { display: 'block', flow: 'column', widthRatio: 0.6, isContainer: false, ownedByFlexGrid: false, constraintOwnerHandle: null, parentHandle: null, isPassiveWrapper: false, isOpaqueWrapper: false, depth: 1, position: 'static', flexWrap: false, alignment: 'start', widthSizing: 'auto', centered: false },
    prominence: 1, widthFractionOfParent: 1, emptinessScore: 0, moveSafety: 'safe', sourceOrder: 0,
    designRole: role, designRoleConfidence: conf, dominanceRank: 0.5, group: null,
    governingHeading: null, componentType: 'unknown', componentConfidence: 0,
    textProfile: { readingLength: 0, kind: 'none', dir: 'auto', longestToken: 0, truncated: false },
    provenance: {},
    ...opts,
  };
}

function perception(clusters: Cluster[]): Perception {
  return {
    builtInMs: 0, nodeCount: clusters.length, site: { host: 'example.com', title: 'test' },
    canvas: { bg: '#fff', color: '#000', fontFamily: 'sans-serif', fontSize: '16px' },
    cssVars: [], cssVarMap: {}, clusters, skeleton: { regions: [], contentMaxWidthPx: 800, columnCount: 1 },
    handles: new Set(clusters.map((c) => c.handle)), opaqueWrappers: new Set(), scrollables: [],
    viewport: { w: 1280, h: 800 }, reflowOpportunity: [],
    outline: [],
    colorModel: { palette: [], relationships: [], saturationRange: [0, 0], lightnessRange: [0, 0], geometry: { radii: [], borderWidths: [], hasShadow: false, shadowSpread: 0, spacingRhythm: 0 } },
    density: { rhythmBaseline: 0, alignmentEdges: [], whitespaceGini: 0, regions: [], pageDensityClass: 'comfortable', rhythmVariance: 0, rhythmConsistent: true, modalPadding: '0px', paddingOutliers: [] },
    composition: { dominant: [], columnCount: 1, hasTopNav: false, hasRightRail: false, hasLeftRail: false, groupCount: 0, summary: '' },
    shadowRoots: [],
  };
}

let failures = 0;
const assert = (cond: boolean, msg: string) => { if (!cond) { console.log(`✗ ${msg}`); failures++; } };

// 1) Role target fans out to every member of that role.
const p1 = perception([
  cl('c111111', 'listing', 0.8), cl('c222222', 'listing', 0.8), cl('c333333', 'article-body', 0.9),
]);
const e1 = transformIntent({ reasoning: '', pack: 'minimal-editorial', relations: [{ relation: 'sizeRatio', subject: 'listing', reference: 'body', ratio: 1.5 }], rules: [] }, p1);
assert(e1.rules.length === 2, `role target fans out to every member (got ${e1.rules.length} rules for 2 listings)`);
assert(e1.rules.some((r) => r.target === 'c111111') && e1.rules.some((r) => r.target === 'c222222'), 'both listing handles got a rule');
assert(!e1.rules.some((r) => r.target === 'c333333'), 'the article-body was NOT targeted by the listing relation');

// 2) widthFraction relation → a composition width.
const p2 = perception([cl('c444444', 'nav-local', 0.9), cl('c555555', 'article-body', 0.9)]);
const e2 = transformIntent({ reasoning: '', pack: 'minimal-editorial', relations: [{ relation: 'widthFraction', subject: 'c444444', reference: 'c555555', fraction: 1.0 }], rules: [] }, p2);
assert(e2.composition.some((r) => r.target === 'c444444' && r.layout?.width === '100%'), 'widthFraction 1.0 → 100% width composition');

// 3) hide on a low-confidence role is REFUSED (hard-safety rule).
const p3 = perception([cl('c666666', 'ad-or-void', 0.3), cl('c777777', 'ad-or-void', 0.8)]);
const e3 = transformIntent({ reasoning: '', pack: 'minimal-editorial', relations: [{ relation: 'hide', subject: 'c666666' }, { relation: 'hide', subject: 'c777777' }], rules: [] }, p3);
assert(!e3.rules.some((r) => r.target === 'c666666' && r.hide), 'hide on low-confidence role REFUSED (no hide rule)');
assert(e3.rules.some((r) => r.target === 'c777777' && r.hide), 'hide on high-confidence ad-or-void → hide rule');
assert(e3.notes.some((n) => n.includes('REFUSED')), 'a refusal note was emitted for the low-confidence hide');

// 4) escape-hatch: a raw rule on a handle the relations also targeted is counted.
const e5 = transformIntent({ reasoning: '', pack: 'minimal-editorial', relations: [{ relation: 'emphasisRank', subject: 'c777777', rank: 2 }], rules: [{ target: 'c777777', styles: { color: '#f00' } }] }, p3);
assert(e5.escapeHatchUses.includes('c777777'), 'a raw rule on a relation-targeted handle is counted as escape-hatch');

// 5) conformance: on-pack CSS passes; an off-scale spacing value violates.
const spec: DesignSpec = { reasoning: '', pack: 'minimal-editorial', relations: [{ relation: 'typeRank', subject: 'listing', rank: 0 }], rules: [] };
const onPackCss = '[data-rv-c="c111111"] {\n  padding: 16px !important;\n  font-size: 48px !important;\n  background: #fafaf7 !important;\n}\n';
const cOk = checkConformance(onPackCss, spec, [], 1);
assert(cOk.ok, `on-pack CSS conforms (violations: ${cOk.violations.join('; ')})`);

// 20px is between scale steps 16 and 24 (>2px tolerance) → off-scale.
// 41px is off the ramp [48,32,17,13] → off-ramp.
const offScaleCss = '[data-rv-c="c111111"] {\n  padding: 20px !important;\n  font-size: 41px !important;\n}\n';
const cBad = checkConformance(offScaleCss, spec, [], 1);
assert(!cBad.ok, 'off-scale spacing + off-ramp type → conformance fails');
assert(cBad.violations.some((v) => v.includes('spacing off-scale')), 'an off-scale spacing violation is reported verbatim');
assert(cBad.violations.some((v) => v.includes('type off-ramp')), 'an off-ramp type violation is reported verbatim');

// 6) a spec with no relations/pack (raw-only) → conformance ok with no violations.
const cRaw = checkConformance('body { padding: 99px !important; }', { reasoning: '', rules: [] } as DesignSpec, [], 1);
assert(cRaw.ok, 'a raw-only spec (no declared system) → conformance ok (no system to check against)');

console.log(failures === 0 ? '\n✓ transform + conformance self-check PASS' : `\n✗ transform + conformance self-check FAIL: ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
