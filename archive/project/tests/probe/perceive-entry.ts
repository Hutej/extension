/**
 * perceive-entry — the bundler entrypoint for the Phase 0 stability probe.
 *
 * Imports the REAL core/perceive (no production code is duplicated or modified)
 * and exposes the functions the probe measures, so a Playwright page can run the
 * actual perception layer with zero model calls. esbuild bundles this to a
 * single JS string the probe injects via page.addInitScript / page.evaluate.
 *
 * The returned shape is perception-AS-DATA: the probe needs the cluster handles,
 * roles, tags, counts, and rects to compute cluster-count variance + handle
 * Jaccard across reloads + the mutation survival. Geometry/style detail the probe
 * does NOT need is dropped here to keep the eval payload small.
 */

import { perceive, clearHandles, serializePerception, clearRoleCache, waitForSettle } from '../../src/core/perceive/index.ts';
import { extractLayoutIR, currentConstraints, buildFallbackTargetIR } from '../../src/core/layout/ir.ts';
import { detectExclusions } from '../../src/core/layout/exclusions.ts';
import { assignSlots } from '../../src/core/layout/assign.ts';
import { DOCUMENTATION_SLOTS } from '../../src/core/layout/languages/documentation.ts';
import { solve, computeGridPlacementCss } from '../../src/core/layout/solve.ts';

// Exposed on window by the bundled module (see probe.ts build).
(globalThis as unknown as { __rvPerceive: typeof perceive; __rvClearHandles: typeof clearHandles; __rvSerialize: typeof serializePerception }).__rvPerceive = perceive;
(globalThis as unknown as { __rvClearHandles: typeof clearHandles }).__rvClearHandles = clearHandles;
(globalThis as unknown as { __rvSerialize: typeof serializePerception }).__rvSerialize = serializePerception;
// Phase 2.5 — the Current Layout IR extractor + current-arrangement constraints (pure; the probe
// measures IR stability across perturbations).
(globalThis as unknown as { __rvExtractLayoutIR: typeof extractLayoutIR }).__rvExtractLayoutIR = extractLayoutIR;
(globalThis as unknown as { __rvCurrentConstraints: typeof currentConstraints }).__rvCurrentConstraints = currentConstraints;
// Phase 2.5 Step 1.5C/D — exclusion detection + slot assignment.
(globalThis as unknown as { __rvDetectExclusions: typeof detectExclusions }).__rvDetectExclusions = detectExclusions;
(globalThis as unknown as { __rvAssignSlots: typeof assignSlots }).__rvAssignSlots = assignSlots;
// P5.2 — sticky role cache: cleared on navigation (session-scoped, not page-persisted).
(globalThis as unknown as { __rvClearRoleCache: typeof clearRoleCache }).__rvClearRoleCache = clearRoleCache;
// S3.4 — perception settle condition (MutationObserver quiet window).
(globalThis as unknown as { __rvWaitForSettle: typeof waitForSettle }).__rvWaitForSettle = waitForSettle;
// The unified solver. Takes the Current IR + Target Layout IR + exclusions.
(globalThis as unknown as { __rvSolve: typeof solve }).__rvSolve = solve;
// S7.1 — CSS-only grid placement (replaces wrapper DOM execution).
(globalThis as unknown as { __rvComputeGridPlacementCss: typeof computeGridPlacementCss }).__rvComputeGridPlacementCss = computeGridPlacementCss;
// G1 — Target Layout IR fallback builder (deterministic slot assignment → tracks).
(globalThis as unknown as { __rvBuildFallbackTargetIR: typeof buildFallbackTargetIR }).__rvBuildFallbackTargetIR = buildFallbackTargetIR;
// G1 — slot definitions (for building slotPreferredWidth in the test).
(globalThis as unknown as { __rvDocumentationSlots: typeof DOCUMENTATION_SLOTS }).__rvDocumentationSlots = DOCUMENTATION_SLOTS;