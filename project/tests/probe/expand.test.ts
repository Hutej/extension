/**
 * Self-check for core/compile/expand — the deterministic expander, + the
 * conformance check. One runnable check (ponytail rule: non-trivial logic
 * leaves the smallest thing that fails if the logic breaks). Run:
 *   node --experimental-strip-types tests/probe/expand.test.ts
 *
 * Builds a tiny synthetic perception + spec and checks:
 *  - a role-targeted intent fans out to every member of that role.
 *  - a `topbar` placement produces a reorder op + a full-width composition.
 *  - a `collapse`/`hidden` on a low-confidence role is REFUSED (hard-safety rule).
 *  - a `collapse` on a high-confidence ad-or-void produces a remove op.
 *  - the escape-hatch fraction is computed.
 *  - conformance: an on-pack CSS passes; an off-scale spacing value violates.
 */
import { expandIntents } from '../../src/core/compile/expand.ts';
import { checkConformance } from '../../src/core/verify/index.ts';
import type { DesignSpec } from '../../src/core/spec/index.ts';
import type { Perception, Cluster } from '../../src/core/perceive/index.ts';
import type { DesignRole } from '../../src/core/perceive/semantic.ts';

// A minimal Cluster factory (only the fields the expander reads).
function cl(handle: string, role: DesignRole, conf: number, opts: Partial<Cluster> = {}): Cluster {
  return {
    handle, selector: `[data-wm-c="${handle}"]`, count: 1, tag: 'div', role: null,
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
    density: { rhythmBaseline: 0, alignmentEdges: [], whitespaceGini: 0 },
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
const e1 = expandIntents({ reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'listing', emphasis: 'hero' }], rules: [] }, p1);
assert(e1.rules.length === 2, `role target fans out to every member (got ${e1.rules.length} rules for 2 listings)`);
assert(e1.rules.some((r) => r.target === 'c111111') && e1.rules.some((r) => r.target === 'c222222'), 'both listing handles got a rule');
assert(!e1.rules.some((r) => r.target === 'c333333'), 'the article-body was NOT targeted by the listing intent');

// 2) topbar placement → a reorder op + a full-width composition.
const p2 = perception([cl('c444444', 'nav-local', 0.9), cl('c555555', 'article-body', 0.9)]);
const e2 = expandIntents({ reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'c444444', placement: 'topbar' }], rules: [] }, p2);
assert(e2.ops.some((o) => o.kind === 'reorder' && o.target === 'c444444'), 'topbar → a reorder op on the rail');
assert(e2.composition.some((r) => r.target === 'c444444' && r.layout?.width === '100%'), 'topbar → full-width composition on the rail');

// 3) collapse on a low-confidence role is REFUSED (hard-safety rule).
const p3 = perception([cl('c666666', 'ad-or-void', 0.3), cl('c777777', 'ad-or-void', 0.8)]);
const e3 = expandIntents({ reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'c666666', placement: 'collapse' }, { target: 'c777777', placement: 'collapse' }], rules: [] }, p3);
assert(!e3.ops.some((o) => o.kind === 'remove' && o.target === 'c666666'), 'collapse on low-confidence role REFUSED (no remove op)');
assert(e3.ops.some((o) => o.kind === 'remove' && o.target === 'c777777'), 'collapse on high-confidence ad-or-void → remove op');
assert(e3.notes.some((n) => n.includes('REFUSED')), 'a refusal note was emitted for the low-confidence collapse');

// 4) hidden on a low-confidence role is REFUSED.
const e4 = expandIntents({ reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'c666666', emphasis: 'hidden' }], rules: [] }, p3);
assert(!e4.rules.some((r) => r.target === 'c666666' && r.hide), 'hidden on low-confidence role REFUSED (no hide rule)');

// 5) escape-hatch: a raw rule on a handle the intents also targeted is counted.
const e5 = expandIntents({ reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'c777777', emphasis: 'normal' }], rules: [{ target: 'c777777', styles: { color: '#f00' } }] }, p3);
assert(e5.escapeHatchUses.includes('c777777'), 'a raw rule on an intent-targeted handle is counted as escape-hatch');

// 6) conformance: on-pack CSS passes; an off-scale spacing value violates.
const spec: DesignSpec = { reasoning: '', pack: 'minimal-editorial', intents: [{ target: 'listing', emphasis: 'hero' }], rules: [] };
const onPackCss = '[data-wm-c="c111111"] {\n  padding: 16px !important;\n  font-size: 48px !important;\n  background: #fafaf7 !important;\n}\n';
const cOk = checkConformance(onPackCss, spec, [], 1);
assert(cOk.ok, `on-pack CSS conforms (violations: ${cOk.violations.join('; ')})`);

// 20px is between scale steps 16 and 24 (>2px tolerance) → off-scale.
// 41px is off the ramp [48,32,17,13] → off-ramp.
const offScaleCss = '[data-wm-c="c111111"] {\n  padding: 20px !important;\n  font-size: 41px !important;\n}\n';
const cBad = checkConformance(offScaleCss, spec, [], 1);
assert(!cBad.ok, 'off-scale spacing + off-ramp type → conformance fails');
assert(cBad.violations.some((v) => v.includes('spacing off-scale')), 'an off-scale spacing violation is reported verbatim');
assert(cBad.violations.some((v) => v.includes('type off-ramp')), 'an off-ramp type violation is reported verbatim');

// 7) a spec with no intents/pack (raw-only) → conformance ok with no violations.
const cRaw = checkConformance('body { padding: 99px !important; }', { reasoning: '', rules: [] } as DesignSpec, [], 1);
assert(cRaw.ok, 'a raw-only spec (no declared system) → conformance ok (no system to check against)');

console.log(failures === 0 ? '\n✓ expand + conformance self-check PASS' : `\n✗ expand + conformance self-check FAIL: ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
