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

export function createContentCreator(doc: Document): ContentCreator {
  let idSeq = 0;
  const nextOwnedId = (): string => `${OWNED_ID_PREFIX}-${++idSeq}`;

  const buildNode = (
    plan: InsertUiNodePlan,
    byLocalId: Map<string, Element>,
    refs: Array<{ referrer: Element; attr: string; localId: string; path: string }>,
    path: string,
  ): Element => {
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
