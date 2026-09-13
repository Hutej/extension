/**
 * runtime/content — generic owned element creation and exact reversal
 * primitives (plan/03 `runtime/content`, plan/28 §2, algorithm A5).
 *
 * One safe creator for every owned element (plan/28 §2): validated trees are
 * built with native DOM APIs only — never innerHTML, never a clone-based
 * restoration (I08). Accessibility references to local ids resolve to
 * runtime-generated ids AFTER the complete tree is validated; references may
 * name a node anywhere within that same tree. Insertion is exact:
 * before/after need a connected parent; first-child/last-child place at the
 * anchor itself; a root host invalid inside a target table/list is refused so
 * the browser is never left to repair placement (plan/28 §2). Removal removes
 * exactly the created nodes — an already-absent owned node is released, not a
 * failed restoration (I09). The site's listeners and state survive every
 * write (I08/I23): no native node is ever replaced.
 */

import type { CanvasScene } from '../contracts.ts';
import type { CompileDiagnostic, InsertUiNodePlan, InsertUiPlan } from './compile.ts';

export type Placement = 'before' | 'after' | 'first-child' | 'last-child';

export const OWNED_ID_PREFIX = 'rv2-owned';

export interface OwnedTreeBuild {
  ok: true;
  roots: Element[];
  byLocalId: Map<string, Element>;
}
export interface OwnedTreeRefusal {
  ok: false;
  diagnostics: CompileDiagnostic[];
}
export type OwnedTreeResult = OwnedTreeBuild | OwnedTreeRefusal;

export type TextLeafResult =
  | { ok: true; text: Text }
  | { ok: false; code: 'unsupported-text-shape'; message: string };

export interface ContentCreator {
  /** Build the validated owned tree DETACHED. Refuses (nothing created that
   *  survives) when an accessibility reference names no node in the tree. */
  build(plan: InsertUiPlan): OwnedTreeResult;
  /** Validate the anchor context for the planned placement (plan/28 §2: a
   *  root host invalid inside a target table/list is refused). */
  checkPlacement(anchor: Element, position: Placement, roots: Element[]): void;
  /** Insert roots at the validated anchor/position. Throws on invalid
   *  placement — the transaction treats any throw as a candidate failure. */
  insert(anchor: Element, position: Placement, roots: Element[]): void;
  /** Remove exactly these owned nodes. */
  remove(nodes: Element[]): void;
  /** plan/08 §7 replaceText leaf shape: a noneditable element with exactly one
   *  Text child. Returns the Text node or a typed refusal. */
  textLeafOf(element: Element): TextLeafResult;
}

const TABLE_CHILDREN = new Set(['thead', 'tbody', 'tr']);
const ROW_CHILDREN = new Set(['th', 'td']);

export class InvalidPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlacementError';
  }
}

// ── S8.4 owned Canvas 2D renderer (plan/28 §3) ──────────────────────────
// One small data-only renderer inside the generic creator: closed validated
// records painted on an OWNED canvas, never a borrowed page canvas (I18), no
// scene graph, no worker, no perpetual animation loop. Backing scale is
// capped and explicitly receipted; hidden/zero-size boxes wait; release
// disconnects the observer and frees the exact document pixel budget.

const CANVAS_CAPS = {
  maxBackingScale: 2,
  maxPixelsPerCanvas: 1_000_000,
  maxPixelsPerDocument: 2_000_000,
  maxCanvases: 4,
} as const;

interface OwnedCanvasState {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  fallback: HTMLElement;
  scene: CanvasScene;
  observer: ResizeObserver | null;
  ctx: CanvasRenderingContext2D | null;
  lost: boolean;
  allocatedPixels: number;
}

/** Paint the closed records in listed order (plan/28 §3). The vocabulary is
 *  the scene, not CSS: no arbitrary context properties, no methods, no
 *  images — every color already validated solid by the decode. */
const paintScene = (ctx: CanvasRenderingContext2D, scene: CanvasScene): void => {
  for (const rec of scene.draw) {
    switch (rec.kind) {
      case 'rect':
        if (rec.fill !== undefined) {
          ctx.fillStyle = rec.fill;
          ctx.fillRect(rec.x, rec.y, rec.width, rec.height);
        }
        if (rec.stroke !== undefined) {
          ctx.strokeStyle = rec.stroke;
          ctx.lineWidth = rec.lineWidth ?? 1;
          ctx.strokeRect(rec.x, rec.y, rec.width, rec.height);
        }
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(rec.x, rec.y, rec.radius, 0, Math.PI * 2);
        if (rec.fill !== undefined) {
          ctx.fillStyle = rec.fill;
          ctx.fill();
        }
        if (rec.stroke !== undefined) {
          ctx.strokeStyle = rec.stroke;
          ctx.lineWidth = rec.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      case 'polyline':
        ctx.beginPath();
        rec.points.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
        if (rec.closed === true) ctx.closePath();
        if (rec.closed === true && rec.fill !== undefined) {
          ctx.fillStyle = rec.fill;
          ctx.fill();
        }
        if (rec.stroke !== undefined) {
          ctx.strokeStyle = rec.stroke;
          ctx.lineWidth = rec.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      case 'text':
        ctx.font = `${rec.fontWeight ?? 400} ${rec.fontSize}px ${rec.fontFamily}`;
        ctx.textAlign = rec.align;
        ctx.fillStyle = rec.fill;
        ctx.fillText(rec.text, rec.x, rec.y);
        break;
    }
  }
};

export function createContentCreator(doc: Document): ContentCreator {
  let idSeq = 0;
  const nextOwnedId = (): string => `${OWNED_ID_PREFIX}-${++idSeq}`;
  const canvases = new Map<Element, OwnedCanvasState>();
  let canvasCount = 0;
  let documentPixels = 0;

  const showFallback = (state: OwnedCanvasState, unavailable: boolean): void => {
    state.host.setAttribute('data-rv2-canvas-state', unavailable ? 'canvas-unavailable' : 'canvas-owned');
    // An unavailable canvas paints nothing — the last resolution receipt
    // would lie, so it goes with the fallback.
    if (unavailable) state.host.removeAttribute('data-rv2-canvas-scale');
    // Unavailable = the accessible fallback SHOWS; owned = it waits hidden.
    state.fallback.hidden = !unavailable;
  };

  /** One redraw from saved scene data: measure the owned box, cap the backing
   *  scale (explicit receipt when lowered), allocate, reset transform,
   *  uniformly scale + center (contain, not stretch), paint. Zero-size or
   *  hidden boxes wait — no zero-size allocation, no redraw loop. */
  const redraw = (state: OwnedCanvasState): void => {
    if (state.lost || state.ctx === null) return;
    // A scheduled redraw firing after release must not repaint the detached
    // host or corrupt the document budget (exact release, plan/28 §3).
    if (canvases.get(state.host) !== state) return;
    const host = state.host;
    const boxW = host.clientWidth;
    const boxH = host.clientHeight;
    if (boxW <= 0 || boxH <= 0) return;
    const scene = state.scene;
    const contain = Math.min(boxW / scene.viewBoxWidth, boxH / scene.viewBoxHeight);
    if (!(contain > 0) || !Number.isFinite(contain)) return;
    const dpr = doc.defaultView?.devicePixelRatio || 1;
    const requested = Math.min(CANVAS_CAPS.maxBackingScale, dpr);
    let backingScale = requested;
    const fitCanvas = Math.sqrt(CANVAS_CAPS.maxPixelsPerCanvas / (boxW * boxH));
    if (fitCanvas < backingScale) backingScale = fitCanvas;
    // Per-document budget: exact accounting — this canvas's own current
    // allocation is excluded, the new allocation must fit what remains.
    const freeDocument = CANVAS_CAPS.maxPixelsPerDocument - (documentPixels - state.allocatedPixels);
    if (freeDocument <= 0) backingScale = 0;
    else {
      const fitDocument = Math.sqrt(freeDocument / (boxW * boxH));
      if (fitDocument < backingScale) backingScale = fitDocument;
    }
    const width = Math.round(boxW * backingScale);
    const height = Math.round(boxH * backingScale);
    if (!(backingScale > 0) || width <= 0 || height <= 0) {
      showFallback(state, true);
      return;
    }
    host.setAttribute('data-rv2-canvas-scale', backingScale.toFixed(3));
    if (backingScale < requested) host.setAttribute('data-rv2-canvas-lowered', '1');
    else host.removeAttribute('data-rv2-canvas-lowered');
    documentPixels += width * height - state.allocatedPixels;
    state.allocatedPixels = width * height;
    // Set only the owned backing width/height and reset the transform.
    state.canvas.width = width;
    state.canvas.height = height;
    state.canvas.style.width = `${boxW}px`;
    state.canvas.style.height = `${boxH}px`;
    const ctx = state.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const offsetX = (boxW - scene.viewBoxWidth * contain) / 2;
    const offsetY = (boxH - scene.viewBoxHeight * contain) / 2;
    ctx.setTransform(contain * backingScale, 0, 0, contain * backingScale, offsetX * backingScale, offsetY * backingScale);
    paintScene(ctx, scene);
    showFallback(state, false);
  };

  const buildScene = (plan: InsertUiNodePlan, byLocalId: Map<string, Element>): HTMLElement => {
    const scene = plan.scene as CanvasScene;
    const host = doc.createElement('scene');
    // An unknown element defaults to display:inline, whose clientWidth is
    // always 0 — the creator owns this minimal layout so the owned box is
    // measurable (plan/28 §3: measure the owned CSS box). The model's style
    // operations override it in the same batch.
    host.style.display = 'block';
    if (plan.localId !== undefined) byLocalId.set(plan.localId, host);
    const canvas = doc.createElement('canvas');
    canvas.setAttribute('data-rv2-canvas', 'owned');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', scene.accessibleDescription);
    const fallback = doc.createElement('div');
    fallback.setAttribute('data-rv2-canvas-fallback', '');
    fallback.hidden = true;
    fallback.appendChild(doc.createTextNode(scene.fallbackText ?? scene.accessibleDescription));
    host.appendChild(canvas);
    host.appendChild(fallback);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    const state: OwnedCanvasState = {
      host: host as HTMLElement,
      canvas: canvas as HTMLCanvasElement,
      fallback: fallback as HTMLElement,
      scene,
      observer: null,
      ctx,
      lost: false,
      allocatedPixels: 0,
    };
    if (ctx === null || canvasCount + 1 > CANVAS_CAPS.maxCanvases) {
      // No allocation/context is possible: the accessible fallback shows with
      // an explicit canvas-unavailable receipt, never canvas success (I26).
      showFallback(state, true);
    } else {
      canvasCount += 1;
      // Coalesced one-shot scheduling — a native ResizeObserver plus a
      // scheduled callback, never a perpetual requestAnimationFrame loop.
      let scheduled = false;
      const schedule = (): void => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          redraw(state);
        }, 0);
      };
      state.observer = new ResizeObserver(schedule);
      state.observer.observe(host);
      canvas.addEventListener('contextlost', () => {
        state.lost = true;
        showFallback(state, true);
      });
      canvas.addEventListener('contextrestored', () => {
        state.lost = false;
        schedule(); // redraw saved data once
      });
      schedule();
      showFallback(state, false);
    }
    canvases.set(host, state);
    return host;
  };

  const buildNode = (
    plan: InsertUiNodePlan,
    byLocalId: Map<string, Element>,
    refs: Array<{ referrer: Element; attr: string; localId: string; path: string }>,
    path: string,
  ): Element => {
    if (plan.tag === 'scene') {
      // The renderer owns the scene interior (canvas + accessible fallback);
      // the host carries only the model's validated attributes.
      const host = buildScene(plan, byLocalId);
      for (const [attr, value] of Object.entries(plan.attrs ?? {})) host.setAttribute(attr, value);
      return host;
    }
    const el = doc.createElement(plan.tag);
    for (const [attr, value] of Object.entries(plan.attrs ?? {})) el.setAttribute(attr, value);
    if (plan.text !== undefined) el.appendChild(doc.createTextNode(plan.text));
    if (plan.localId !== undefined) byLocalId.set(plan.localId, el);
    for (const ref of plan.refTargets ?? []) refs.push({ referrer: el, attr: ref.attr, localId: ref.localId, path: `${path}.refs` });
    for (const [ci, child] of (plan.children ?? []).entries()) {
      el.appendChild(buildNode(child, byLocalId, refs, `${path}.children[${ci}]`));
    }
    return el;
  };

  return {
    build(plan) {
      const byLocalId = new Map<string, Element>();
      const refs: Array<{ referrer: Element; attr: string; localId: string; path: string }> = [];
      const roots: Element[] = [];
      for (const [ti, tree] of plan.trees.entries()) {
        roots.push(buildNode(tree, byLocalId, refs, `trees[${ti}]`));
      }
      // Accessibility references resolve only after the COMPLETE tree exists
      // (plan/28 §2); a missing target refuses the whole tree.
      const diagnostics: CompileDiagnostic[] = [];
      for (const ref of refs) {
        const target = byLocalId.get(ref.localId);
        if (!target) {
          diagnostics.push({ path: ref.path, code: 'target', message: `accessibility reference names no node with localId "${ref.localId}" in this tree` });
          continue;
        }
        let id = target.getAttribute('id');
        if (id === null || id === undefined || !id.startsWith(OWNED_ID_PREFIX)) {
          id = nextOwnedId();
          target.setAttribute('id', id);
        }
        ref.referrer.setAttribute(ref.attr, id);
      }
      if (diagnostics.length > 0) return { ok: false, diagnostics };
      return { ok: true, roots, byLocalId };
    },

    checkPlacement(anchor, position, roots) {
      if (position === 'before' || position === 'after') {
        if (!anchor.parentNode) {
          throw new InvalidPlacementError('before/after placement requires an anchor with a parent node');
        }
      }
      if (!anchor.isConnected) {
        throw new InvalidPlacementError('the anchor is not connected');
      }
      const anchorTag = anchor.tagName.toLowerCase();
      for (const node of roots) {
        const tag = node.tagName.toLowerCase();
        if ((anchorTag === 'ul' || anchorTag === 'ol') && tag !== 'li') {
          throw new InvalidPlacementError(`a ${tag} root host is invalid inside a target ${anchorTag}`);
        }
        if (anchorTag === 'table' && !TABLE_CHILDREN.has(tag)) {
          throw new InvalidPlacementError(`a ${tag} root host is invalid inside a target table`);
        }
        if (anchorTag === 'tr' && !ROW_CHILDREN.has(tag)) {
          throw new InvalidPlacementError(`a ${tag} root host is invalid inside a target table row`);
        }
        if ((anchorTag === 'thead' || anchorTag === 'tbody') && tag !== 'tr') {
          throw new InvalidPlacementError(`a ${tag} root host is invalid inside a target row group`);
        }
      }
    },

    insert(anchor, position, roots) {
      this.checkPlacement(anchor, position, roots);
      for (const node of roots) {
        if (position === 'before') anchor.parentNode!.insertBefore(node, anchor);
        else if (position === 'after') anchor.parentNode!.insertBefore(node, anchor.nextSibling);
        else if (position === 'first-child') anchor.insertBefore(node, anchor.firstChild);
        else anchor.appendChild(node);
      }
    },

    remove(nodes) {
      // Owned canvases disconnect their observers and free the exact document
      // pixel budget BEFORE the nodes are removed (plan/28 §3 release).
      for (const node of nodes) {
        const state = canvases.get(node);
        if (state !== undefined) {
          state.observer?.disconnect();
          canvases.delete(node);
          canvasCount -= 1;
          documentPixels -= state.allocatedPixels;
        }
      }
      for (const node of nodes) node.remove();
    },

    textLeafOf(element) {
      if ((element as HTMLElement).isContentEditable) {
        return { ok: false, code: 'unsupported-text-shape', message: 'the target is editable; site editor values are excluded' };
      }
      if (element.children.length > 0) {
        return { ok: false, code: 'unsupported-text-shape', message: 'replaceText targets a leaf element, but the target has element children' };
      }
      let text: Text | undefined;
      for (const child of element.childNodes) {
        if (child.nodeType === 1) {
          return { ok: false, code: 'unsupported-text-shape', message: 'replaceText targets a leaf element with exactly one Text child' };
        }
        if (child.nodeType === 3) {
          if (text !== undefined) {
            return { ok: false, code: 'unsupported-text-shape', message: 'the target has more than one Text child' };
          }
          text = child as Text;
        }
      }
      if (text === undefined) {
        return { ok: false, code: 'unsupported-text-shape', message: 'the target has no Text child' };
      }
      return { ok: true, text };
    },
  };
}
