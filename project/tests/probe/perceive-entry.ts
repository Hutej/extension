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

// Exposed on window by the bundled module (see probe.ts build).
(globalThis as unknown as { __wmPerceive: typeof perceive; __wmClearHandles: typeof clearHandles; __wmSerialize: typeof serializePerception }).__wmPerceive = perceive;
(globalThis as unknown as { __wmClearHandles: typeof clearHandles }).__wmClearHandles = clearHandles;
(globalThis as unknown as { __wmSerialize: typeof serializePerception }).__wmSerialize = serializePerception;
