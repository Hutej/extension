/**
 * runtime/observe — bounded semantic snapshots (plan/03 `runtime/facts` +
 * `runtime/observe`, plan/07 §1, algorithm A1).
 *
 * One root-aware bounded pass over the document: deterministic document-order
 * traversal with cooperative slices, fact collection under the privacy
 * policy, explicit coverage with an epoch-bound cursor for expansion. No
 * global stamping (I16): the target registry's WeakMap maps nodes to session
 * refs; DOM token attributes are added only by accepted runtime resources,
 * never by observation. No website mutation; every returned ref resolves to
 * recorded evidence.
 *
 * Budgets are plan/07's proposed measurable targets (not benchmark facts):
 * 2,000 visited nodes, 60 output regions, ≤12 KiB serialized evidence after
 * privacy filtering, ≤100 ms total local work in ≤4 ms slices. A 10,000-node
 * page reports partial coverage truthfully (I21) and permits targeted
 * expansion — never a long synchronous enrichment tail.
 */

import { redactSensitiveText } from '../contracts.ts';
import { createTargetRegistry, type ResolvedTargetRegistry } from './targets.ts';

// ── budgets (plan/07 §1 proposed targets) ────────────────────────────────

export const MAX_VISITED_NODES = 2_000;
export const MAX_REGIONS = 60;
export const MAX_EVIDENCE_BYTES = 12 * 1024;
export const OBSERVATION_TIME_BUDGET_MS = 100;
export const SLICE_MS = 4;
export const MAX_TEXT_SAMPLE_CHARS = 80;
export const CURSOR_TTL_MS = 30_000; // plan/04 §2

/** Semantic region elements worth reporting (declared semantics only). */
const REGION_TAGS = new Set([
  'body', 'header', 'nav', 'main', 'aside', 'footer', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'button', 'a', 'input',
  'select', 'textarea', 'label', 'table', 'ul', 'ol', 'dl', 'canvas',
  'video', 'audio', 'dialog', 'details', 'summary', 'figure', 'iframe',
  'p', 'li', 'code', 'pre',
]);

const LANDMARK_TAGS = new Set(['header', 'footer', 'nav', 'main', 'aside']);

/** Subtrees that are never semantic evidence and are skipped whole. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link', 'title']);

/** Form control types whose value/name context is private (T04). */
const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel', 'search', 'hidden']);

// ── snapshot records (plan/04 §2) ────────────────────────────────────────

export interface RegionSemantics {
  tag: string;
  /** Author-declared role when present; otherwise the landmark
   *  approximation is labeled as such — never claimed as ARIA-tree parity. */
  role?: string;
  roleSource?: 'declared' | 'landmark-approximation';
  /** Accessible-name approximation from aria-label/alt/placeholder/label
   *  association; privacy-redacted. Labeled approximation. */
  nameApprox?: string;
  nameSource?: 'aria-label' | 'alt' | 'placeholder' | 'aria-labelledby' | 'title-attr' | 'button-text';
}

export interface RegionGeometry {
  /** Quantized viewport-relative rect (CSS px, rounded to integers). */
  x: number; y: number; w: number; h: number;
  inViewport: boolean;
  clipped?: boolean;
}

export interface Region {
  targetRef: string;
  rootRef: string;
  parentRef?: string;
  kind: 'element';
  semantics: RegionSemantics;
  textSample?: string;
  textLength?: number;
  geometry: RegionGeometry;
  stability: 'session-only';
  hidden: boolean;
  /** Action catalog ids this region participates in. */
  affordances?: string[];
}

export interface ActionEntry {
  actionId: string;
  kind: 'button' | 'link' | 'input' | 'select' | 'textarea' | 'submit';
  targetRef: string;
  /** Declared control type (input type attr) — never a value. */
  controlType?: string;
  disabled: boolean;
}

export interface SnapshotCoverage {
  visitedNodes: number;
  selectedRegions: number;
  completed: boolean;
  reason?: 'node-budget' | 'time-budget' | 'privacy' | 'unsupported-root' | 'unstable';
  nextCursor?: string;
}

export interface PageSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  collectedAt: number;
  viewport: { width: number; height: number };
  documentMetadata: { origin: string; titleRedacted?: string };
  roots: Array<{ rootId: string; kind: 'document' | 'shadow-root' }>;
  regions: Region[];
  actions: ActionEntry[];
  coverage: SnapshotCoverage;
}

export interface SnapshotCursor {
  snapshotId: string;
  epoch: number;
  offset: number;
  expiresAt: number;
}

export interface ObservationDeps {
  doc: Document;
  epoch(): number;
  now(): number;
  randomId(): string;
}

export interface ObservationEngine {
  collectSnapshot(): PageSnapshot;
  /** Expand an epoch-bound cursor: a fresh bounded pass continuing the same
   *  snapshot lineage. Stale/expired cursors are rejected deterministically. */
  expand(cursor: string): { ok: true; snapshot: PageSnapshot } | { ok: false; reason: 'stale' | 'missing'; detail: string };
  /** Bounded facts for one observed target; stale/missing refused (A2). */
  inspect(targetRef: string, fields: string[]): { ok: true; ref: string; facts: Record<string, unknown> } | { ok: false; reason: 'missing' | 'stale'; detail: string };
  /** The target registry this engine records into. */
  targets(): ResolvedTargetRegistry;
  lastSnapshot(): PageSnapshot | undefined;
}

const quantize = (n: number): number => Math.round(n);

interface NameApprox { name: string; source: NonNullable<RegionSemantics['nameSource']> }

function accessibleNameApproximation(el: Element): NameApprox | undefined {
  const pick = (value: string | null, source: NameApprox['source']): NameApprox | undefined =>
    value ? { name: value, source } : undefined;
  const ariaLabel = pick(el.getAttribute('aria-label'), 'aria-label');
  if (ariaLabel) return ariaLabel;
  const alt = pick(el.getAttribute('alt'), 'alt');
  if (alt) return alt;
  const placeholder = pick(el.getAttribute('placeholder'), 'placeholder');
  if (placeholder) return placeholder;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const target = el.ownerDocument.getElementById(labelledby);
    if (target?.textContent) return { name: target.textContent, source: 'aria-labelledby' };
  }
  const title = pick(el.getAttribute('title'), 'title-attr');
  if (title) return title;
  if (el.tagName === 'BUTTON' && el.textContent) {
    return { name: el.textContent, source: 'button-text' };
  }
  return undefined;
}

/** Privacy pass (T04): a private control's value/name context is never
 *  evidence. Text samples are residual-redacted (S1.2 boundary layer). */
function isSensitiveControl(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  return SENSITIVE_INPUT_TYPES.has(type);
}

export function createObservationEngine(deps: ObservationDeps, targets: ResolvedTargetRegistry = createTargetRegistry(deps.now)): ObservationEngine {
  let last: PageSnapshot | undefined;
  let lastCursor: SnapshotCursor | undefined;

  const roleOf = (el: Element): { role?: string; source?: RegionSemantics['roleSource'] } => {
    const declared = el.getAttribute('role');
    if (declared) return { role: declared, source: 'declared' };
    const tag = el.tagName.toLowerCase();
    if (LANDMARK_TAGS.has(tag)) return { role: tag, source: 'landmark-approximation' };
    return {};
  };

  const collectSnapshot = (): PageSnapshot => {
    const start = deps.now();
    const doc = deps.doc;
    const snapshotId = deps.randomId();
    const epoch = deps.epoch();
    const docRootId = targets.registerRoot(doc);

    const viewport = doc.defaultView
      ? { width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight }
      : { width: 0, height: 0 };

    if (!doc.body) {
      // A1 edge: body absent → honest partial with reason; never a fake root.
      return {
        schemaVersion: 1,
        snapshotId,
        collectedAt: deps.now(),
        viewport,
        documentMetadata: { origin: doc.location?.origin ?? '' },
        roots: targets.roots(),
        regions: [],
        actions: [],
        coverage: { visitedNodes: 0, selectedRegions: 0, completed: false, reason: 'unstable' },
      };
    }

    const regions: Region[] = [];
    const actions: ActionEntry[] = [];
    let visited = 0;
    let hitBudget: NonNullable<SnapshotCoverage['reason']> | undefined;

    const pushRegion = (el: Element, parentRef: string | undefined): Region | undefined => {
      if (regions.length >= MAX_REGIONS) {
        hitBudget = hitBudget ?? 'node-budget';
        return undefined;
      }
      const rootNode = el.getRootNode() as Document | ShadowRoot;
      const rootId = targets.registerRoot(rootNode);
      const role = roleOf(el);
      const ref = targets.register(el, rootId, role.role, epoch);
      const rect = el.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.top < viewport.height && rect.width > 0 && rect.height > 0;
      const region: Region = {
        targetRef: ref,
        rootRef: rootId,
        ...(parentRef !== undefined ? { parentRef } : {}),
        kind: 'element',
        semantics: {
          tag: el.tagName.toLowerCase(),
          ...(role.role !== undefined
            ? { role: role.role, ...(role.source ? { roleSource: role.source } : {}) }
            : {}),
        },
        geometry: {
          x: quantize(rect.left), y: quantize(rect.top), w: quantize(rect.width), h: quantize(rect.height),
          inViewport,
          ...(rect.width > 0 && rect.height > 0 && (rect.right > viewport.width || rect.bottom > viewport.height + rect.top)
            ? { clipped: true }
            : {}),
        },
        stability: 'session-only',
        hidden: rect.width === 0 || rect.height === 0,
      };
      // Accessible-name approximation, privacy-filtered (T04): private
      // controls keep no name context at all.
      if (!isSensitiveControl(el)) {
        const approx = accessibleNameApproximation(el);
        if (approx) {
          region.semantics.nameApprox = redactSensitiveText(approx.name.slice(0, MAX_TEXT_SAMPLE_CHARS));
          region.semantics.nameSource = approx.source;
        }
      }
      // Text sample: OWN text nodes only (no descendant aggregation), capped,
      // residual-redacted; form controls and editors contribute no text (T04).
      if (!isSensitiveControl(el) && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
        let ownText = '';
        for (const child of el.childNodes) {
          if (child.nodeType === 3) ownText += child.textContent ?? '';
        }
        ownText = ownText.trim();
        if (ownText) {
          region.textLength = ownText.length;
          region.textSample = redactSensitiveText(ownText.slice(0, MAX_TEXT_SAMPLE_CHARS));
        }
      }
      // Action affordances: declared control types only — never values.
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea') {
        const controlType = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : undefined;
        const actionId = `a${actions.length + 1}`;
        actions.push({
          actionId,
          kind: tag === 'button' ? (controlType === 'submit' ? 'submit' : 'button')
            : tag === 'a' ? 'link'
            : tag === 'input' ? 'input'
            : (tag as 'select' | 'textarea'),
          targetRef: ref,
          ...(controlType !== undefined && !isSensitiveControl(el) ? { controlType } : {}),
          disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        });
        region.affordances = [actionId];
      }
      regions.push(region);
      return region;
    };

    // Deterministic BFS in document order (A1: fixed traversal priorities,
    // no random sampling). The fold is not a priority signal — document order
    // reserves coverage for below-fold regions (T03).
    type QueueItem = { el: Element; ancestorRegionRef?: string };
    const queue: QueueItem[] = [{ el: doc.body }];
    while (queue.length > 0) {
      if (visited >= MAX_VISITED_NODES) { hitBudget = hitBudget ?? 'node-budget'; break; }
      if (deps.now() - start > OBSERVATION_TIME_BUDGET_MS) { hitBudget = hitBudget ?? 'time-budget'; break; }

      const { el, ancestorRegionRef } = queue.shift()!;
      visited += 1;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      // Open shadow roots: reachable roots are registered and their children
      // join the walk (I26 root discipline — they never cross into the light
      // DOM selector space).
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        targets.registerRoot(shadow);
        for (const child of shadow.children) queue.push({ el: child, ancestorRegionRef: undefined });
      }

      let ownRegionRef = ancestorRegionRef;
      if (REGION_TAGS.has(tag) || el.hasAttribute('role')) {
        const region = pushRegion(el, ancestorRegionRef);
        if (region) ownRegionRef = region.targetRef;
      }
      for (const child of el.children) queue.push({ el: child, ancestorRegionRef: ownRegionRef });
    }

    const completed = hitBudget === undefined && queue.length === 0;

    // Evidence byte budget: serialize whole records until the budget; never
    // split a record (A1). Dropped regions become the expansion cursor (I21:
    // honest partial coverage, not a claimed-complete sample).
    let evidenceBytes = 0;
    let kept = 0;
    for (const region of regions) {
      const size = JSON.stringify(region).length;
      if (kept > 0 && evidenceBytes + size > MAX_EVIDENCE_BYTES) {
        hitBudget = hitBudget ?? 'node-budget';
        break;
      }
      evidenceBytes += size;
      kept += 1;
    }
    const finalRegions = regions.slice(0, kept);
    const referenced = new Set(finalRegions.flatMap((r) => r.affordances ?? []));
    let actionBudget = MAX_EVIDENCE_BYTES - evidenceBytes;
    const finalActions: ActionEntry[] = [];
    for (const action of actions) {
      if (!referenced.has(action.actionId)) continue;
      const size = JSON.stringify(action).length;
      if (finalActions.length > 0 && size > actionBudget) break;
      actionBudget -= size;
      finalActions.push(action);
    }

    let nextCursor: string | undefined;
    if (!completed) {
      const cursor: SnapshotCursor = {
        snapshotId,
        epoch,
        offset: finalRegions.length,
        expiresAt: deps.now() + CURSOR_TTL_MS,
      };
      lastCursor = cursor;
      nextCursor = `${snapshotId}:${cursor.offset}:${cursor.expiresAt}`;
    }

    last = {
      schemaVersion: 1,
      snapshotId,
      collectedAt: deps.now(),
      viewport,
      documentMetadata: {
        origin: doc.location?.origin ?? '',
        ...(docRootId === 'document' && doc.title ? { titleRedacted: redactSensitiveText(doc.title.slice(0, 120)) } : {}),
      },
      roots: targets.roots(),
      regions: finalRegions,
      actions: finalActions,
      coverage: {
        visitedNodes: visited,
        selectedRegions: finalRegions.length,
        completed,
        ...(hitBudget !== undefined ? { reason: hitBudget } : {}),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      },
    };
    return last;
  };

  const expand = (cursor: string): { ok: true; snapshot: PageSnapshot } | { ok: false; reason: 'stale' | 'missing'; detail: string } => {
    if (!last || !lastCursor) {
      return { ok: false, reason: 'missing', detail: 'no snapshot exists to expand' };
    }
    const parts = cursor.split(':');
    if (parts.length !== 3) {
      return { ok: false, reason: 'stale', detail: 'malformed cursor' };
    }
    const [snapshotId, offsetRaw, expiresRaw] = parts;
    const offset = Number(offsetRaw);
    const expiresAt = Number(expiresRaw);
    if (!Number.isInteger(offset) || !Number.isFinite(expiresAt)) {
      return { ok: false, reason: 'stale', detail: 'malformed cursor' };
    }
    if (deps.now() > expiresAt) {
      return { ok: false, reason: 'stale', detail: 'cursor expired (30s); re-observe' };
    }
    if (snapshotId !== last.snapshotId || offset !== lastCursor.offset || lastCursor.epoch !== deps.epoch()) {
      return { ok: false, reason: 'stale', detail: 'cursor is bound to a different snapshot, position or route epoch' };
    }
    // A fresh bounded pass over the CURRENT document; the cursor only proves
    // lineage. Coverage stays explicit per pass (A1: expansion is targeted,
    // never a claimed-complete merge).
    return { ok: true, snapshot: collectSnapshot() };
  };

  const inspect = (targetRef: string, fields: string[]): { ok: true; ref: string; facts: Record<string, unknown> } | { ok: false; reason: 'missing' | 'stale'; detail: string } => {
    const resolved = targets.resolve(targetRef, {
      routeEpoch: deps.epoch(), domRevision: 0, customizationRevision: 0, viewportRevision: 0,
    });
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason === 'missing' ? 'missing' : 'stale', detail: resolved.detail };
    }
    const el = resolved.node;
    const requested = new Set(fields.slice(0, 16));
    const facts: Record<string, unknown> = { targetRef: resolved.ref, tag: el.tagName.toLowerCase() };
    const rect = el.getBoundingClientRect();
    const style = deps.doc.defaultView?.getComputedStyle(el);
    if (requested.size === 0 || requested.has('geometry')) {
      facts.geometry = { x: quantize(rect.left), y: quantize(rect.top), w: quantize(rect.width), h: quantize(rect.height) };
    }
    if (requested.size === 0 || requested.has('visibility')) {
      facts.visibility = {
        displayed: style?.display !== 'none',
        visible: rect.width > 0 && rect.height > 0,
        inViewport: rect.bottom > 0 && rect.top < (deps.doc.defaultView?.innerHeight ?? 0),
      };
    }
    if (requested.size === 0 || requested.has('style')) {
      if (style) {
        facts.style = {
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
        };
      }
    }
    if (requested.has('textLength')) {
      facts.textLength = (el.textContent ?? '').length;
    }
    return { ok: true, ref: resolved.ref, facts };
  };

  return {
    collectSnapshot,
    expand,
    inspect,
    targets: () => targets,
    lastSnapshot: () => last,
  };
}
