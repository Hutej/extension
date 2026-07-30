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

import { perceive, clearHandles, serializePerception } from '../../src/core/perceive/index.ts';
import { extractLayoutIR, currentConstraints } from '../../src/core/layout/ir.ts';
import { detectExclusions } from '../../src/core/layout/exclusions.ts';
import { assignSlots } from '../../src/core/layout/assign.ts';

// Exposed on window by the bundled module (see probe.ts build).
(globalThis as unknown as { __wmPerceive: typeof perceive; __wmClearHandles: typeof clearHandles; __wmSerialize: typeof serializePerception }).__wmPerceive = perceive;
(globalThis as unknown as { __wmClearHandles: typeof clearHandles }).__wmClearHandles = clearHandles;
(globalThis as unknown as { __wmSerialize: typeof serializePerception }).__wmSerialize = serializePerception;
// Phase 2.5 — the Current Layout IR extractor + current-arrangement constraints (pure; the probe
// measures IR stability across perturbations).
(globalThis as unknown as { __wmExtractLayoutIR: typeof extractLayoutIR }).__wmExtractLayoutIR = extractLayoutIR;
(globalThis as unknown as { __wmCurrentConstraints: typeof currentConstraints }).__wmCurrentConstraints = currentConstraints;
// Phase 2.5 Step 1.5C/D — exclusion detection + slot assignment.
(globalThis as unknown as { __wmDetectExclusions: typeof detectExclusions }).__wmDetectExclusions = detectExclusions;
(globalThis as unknown as { __wmAssignSlots: typeof assignSlots }).__wmAssignSlots = assignSlots;
