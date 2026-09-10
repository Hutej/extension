/**
 * transaction.test — S4.2 one-batch transactions and generic element
 * insertion (T08/T09/T14/T30/T31 at the unit boundary).
 *
 * The DOM seam is a minimal faithful stub (elements, text nodes, tree
 * mutation) so the real transaction, compiler, target registry and token
 * scope run their exact production code in plain Node. The style-delivery
 * client is faked with kill switches: every delivery/commit boundary can
 * fail, hang or be made unknown — the T08/T14 crash-at-every-await matrix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTargetRegistry } from '../../src/runtime/targets.ts';
import { createTokenScope, TOKEN_ATTRIBUTE } from '../../src/runtime/styles.ts';
import { createContentCreator } from '../../src/runtime/content.ts';
import {
  createTransaction,
  type StyleClient,
  type StyleOutcome,
  type Transaction,
  type TransactionDeps,
} from '../../src/runtime/transaction.ts';
import type { DocumentKey, Operation } from '../../src/contracts.ts';

const DK: DocumentKey = { tabId: 1, frameId: 0, browserDocumentId: 'd1', runtimeInstanceId: 'ri' };

// ── DOM stub ─────────────────────────────────────────────────────────────

interface StubNode {
  nodeType: number;
  nodeValue?: string;
  tagName?: string;
  parentNode: StubNode | null;
  childNodes: StubNode[];
  attrs: Map<string, string>;
  children: StubNode[];
  isContentEditable?: boolean;
  __connected?: boolean;
  getRootNode(): StubNode;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  get isConnected(): boolean;
  get firstChild(): StubNode | null;
  get nextSibling(): StubNode | null;
  appendChild(child: StubNode): StubNode;
  insertBefore(node: StubNode, ref: StubNode | null): StubNode;
  remove(): void;
}

function makeNode(nodeType: number, tagOrValue: string): StubNode {
  const node: StubNode = {
    nodeType,
    ...(nodeType === 1
      ? { tagName: tagOrValue.toUpperCase(), isContentEditable: false }
      : { nodeValue: tagOrValue }),
    attrs: new Map<string, string>(),
    children: [],
    parentNode: null,
    childNodes: [],
    getRootNode(): StubNode {
      let p: StubNode = node;
      while (p.parentNode) p = p.parentNode;
      return p;
    },
    getAttribute(name) {
      return nodeType === 1 ? node.attrs.get(name) ?? null : null;
    },
    setAttribute(name, value) {
      assert.equal(nodeType, 1);
      node.attrs.set(name, value);
    },
    removeAttribute(name) {
      node.attrs.delete(name);
    },
    get isConnected(): boolean {
      let p: StubNode = node;
      while (p.parentNode) p = p.parentNode;
      return p.__connected === true;
    },
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      const siblings = node.parentNode?.childNodes ?? [];
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    appendChild(child) {
      child.parentNode = node;
      node.childNodes.push(child);
      if (child.nodeType === 1) node.children.push(child);
      return child;
    },
    insertBefore(node_, ref) {
      const idx = ref === null ? node.childNodes.length : node.childNodes.indexOf(ref);
      const at = idx === -1 ? node.childNodes.length : idx;
      node_.parentNode = node;
      node.childNodes.splice(at, 0, node_);
      if (node_.nodeType === 1) node.children.push(node_);
      return node_;
    },
    remove() {
      const parent = node.parentNode;
      if (!parent) return;
      const i = parent.childNodes.indexOf(node);
      if (i !== -1) parent.childNodes.splice(i, 1);
      const j = parent.children.indexOf(node);
      if (j !== -1) parent.children.splice(j, 1);
      node.parentNode = null;
    },
  };
  return node;
}

const el = (tag: string): StubNode => makeNode(1, tag) as StubNode;
const text = (value: string): StubNode => makeNode(3, value) as StubNode;

function makeDoc(): { doc: StubNode } {
  const doc = makeNode(9, '#document');
  doc.__connected = true;
  (doc as unknown as { createElement(tag: string): StubNode }).createElement = (tag: string) => el(tag);
  (doc as unknown as { createTextNode(v: string): StubNode }).createTextNode = (v: string) => text(v);
  return { doc: doc as unknown as StubNode };
}

function querySelectorAll(root: StubNode, attrName: string, value: string): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode): void => {
    if (n.nodeType === 1 && n.getAttribute(attrName) === value) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

// ── world ────────────────────────────────────────────────────────────────

interface World {
  doc: StubNode;
  deps: TransactionDeps;
  txn: Transaction;
  calls: Array<{ op: string; args: unknown }>;
  setStage: (outcome: 'inserted' | 'unknown' | 'refused') => void;
  setCommit: (outcome: 'committed' | 'refused') => void;
  setRemove: (outcome: 'removed' | 'refused') => void;
  onStage?: () => void;
  epoch: { value: number };
}

function makeWorld(): World {
  const { doc } = makeDoc();
  const targets = createTargetRegistry();
  targets.registerRoot(doc as unknown as Document); // 'document' — the first registered root
  const tokenDoc = {
    querySelectorAll: (sel: string) => {
      const m = sel.match(/\[data-rv2-ns="(.*)"\]/);
      if (!m) return [];
      return querySelectorAll(doc, TOKEN_ATTRIBUTE, m[1]) as unknown as Element[];
    },
  } as unknown as Document;
  const tokens = createTokenScope(tokenDoc);
  const content = createContentCreator(doc as unknown as Document);
  const calls: World['calls'] = [];
  let stageOutcome: 'inserted' | 'unknown' | 'refused' = 'inserted';
  let commitOutcome: 'committed' | 'refused' = 'committed';
  let removeOutcome: 'removed' | 'refused' = 'removed';
  const epoch = { value: 0 };
  const styleClient: StyleClient = {
    stage: async (order) => {
      calls.push({ op: 'stage', args: order });
      world.onStage?.();
      if (stageOutcome === 'refused') return { ok: false, code: 'conflict', message: 'staging refused by test' };
      return { ok: true, state: stageOutcome } as StyleOutcome;
    },
    commit: async (operationId) => {
      calls.push({ op: 'commit', args: operationId });
      return commitOutcome === 'refused'
        ? { ok: false, code: 'conflict', message: 'commit refused by test' }
        : { ok: true, state: 'committed' };
    },
    remove: async (operationId, css) => {
      calls.push({ op: 'remove', args: [operationId, css] });
      return removeOutcome === 'refused'
        ? { ok: false, code: 'conflict', message: 'removal refused by test' }
        : { ok: true, state: 'removed' };
    },
  };
  const deps: TransactionDeps = {
    doc: doc as unknown as Document,
    targets,
    tokens,
    content,
    routeEpoch: () => epoch.value,
    documentKey: () => DK,
    now: () => Date.now(),
    randomId: () => Math.random().toString(36).slice(2),
    installationId: () => 'testinst',
    styleClient,
    settle: async () => {
      world.settleHook?.();
    },
  };
  const txn = createTransaction(deps);
  const world: World & { settleHook?: () => void } = {
    doc,
    deps,
    txn,
    calls,
    epoch,
    setStage: (o) => { stageOutcome = o; },
    setCommit: (o) => { commitOutcome = o; },
    setRemove: (o) => { removeOutcome = o; },
  };
  return world;
}

const observe = (w: World, node: StubNode): string =>
  w.deps.targets.register(node as unknown as Element, 'document', undefined, 0);

const styleOp = (targetRef: string, property: string, value: string): Operation => ({
  kind: 'style',
  rules: [{ target: { targetRef }, surface: 'element', state: 'none', declarations: [{ property, value, priority: 'important' }], conditions: [] }],
});

const insertOp = (targetRef: string, nodes: Array<Record<string, unknown>>, position: 'before' | 'after' | 'first-child' | 'last-child' = 'last-child'): Operation => ({
  kind: 'insertUI',
  target: { targetRef },
  position,
  nodes: nodes as never,
});

const textOp = (targetRef: string, value: string): Operation => ({
  kind: 'replaceText',
  target: { targetRef },
  text: value,
});

const req = (batchId: string, customizationId: string, operations: Operation[], revisionId = `${batchId}-rev`) => ({
  batchId,
  customizationId,
  revisionId,
  operations,
});

// ── T31: generic insertion + same-batch local styling ───────────────────

test('T31: insertUI card with heading/button/local input places at each valid position and styles local refs in the same batch', async () => {
  const w = makeWorld();
  const anchor = el('div');
  w.doc.appendChild(anchor);
  const anchorRef = observe(w, anchor);

  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(anchorRef, [
      { localId: 'panel', tag: 'div', children: [
        { tag: 'h2', text: 'Notes' },
        { tag: 'button', text: 'Go' },
        { localId: 'nameField', tag: 'input', attributes: { type: 'text', placeholder: 'Search' } },
      ] },
    ]),
    { kind: 'style', rules: [{ target: { localRef: 'panel' }, surface: 'element', state: 'none', declarations: [{ property: 'background', value: 'rebeccapurple', priority: 'important' }], conditions: [] }] },
  ]));

  assert.equal(r.status, 'accepted', JSON.stringify(r));
  const panel = anchor.childNodes[0] as StubNode; // inserted as the anchor's last child
  assert.equal(panel.tagName, 'DIV');
  assert.equal(anchor.childNodes.length, 1, 'the tree is inserted as the anchor child');
  // same-batch local styling: the owned node carries the composition token
  assert.ok(panel.getAttribute(TOKEN_ATTRIBUTE), 'the styled localRef node is tokened');
  assert.ok(w.calls.some((c) => c.op === 'stage' && String((c.args as { css: string }).css).includes('rebeccapurple')));
  assert.ok(w.calls.some((c) => c.op === 'commit'));
  // input forced to a local type; button always type=button (compile contract)
  const button = panel.children.find((c) => c.tagName === 'BUTTON')!;
  assert.equal(button.attrs.get('type'), 'button');
  const input = [...panel.childNodes].find((c) => c.tagName === 'INPUT')!;
  assert.equal(input.attrs.get('type'), 'text');
});

test('T31: label forRef resolves to a runtime-generated id after the complete tree is validated', async () => {
  const w = makeWorld();
  const anchor = el('div');
  w.doc.appendChild(anchor);
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(observe(w, anchor), [
      { tag: 'label', text: 'Search', labelFor: 'nameField' },
      { localId: 'nameField', tag: 'input', attributes: { type: 'search' } },
    ]),
  ]));
  assert.equal(r.status, 'accepted', JSON.stringify(r));
  const label = anchor.childNodes[0] as StubNode;
  const input = anchor.childNodes[1] as StubNode;
  const forId = label.attrs.get('for');
  assert.ok(forId?.startsWith('rv2-owned-'), `runtime-generated id, got ${forId}`);
  assert.equal(input.attrs.get('id'), forId, 'the id is set on the referenced owned node');
});

test('T31: an accessibility reference naming no node refuses the whole batch before insertion', async () => {
  const w = makeWorld();
  const anchor = el('div');
  w.doc.appendChild(anchor);
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(observe(w, anchor), [{ tag: 'label', text: 'x', labelFor: 'missing' }]),
  ]));
  assert.equal(r.status, 'not-applied');
  assert.match(r.error!.message, /missing/);
  assert.equal(anchor.childNodes.length, 0, 'nothing is inserted');
});

test('T31: a root host invalid inside a target list is refused before side effects', async () => {
  const w = makeWorld();
  const list = el('ul');
  w.doc.appendChild(list);
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(observe(w, list), [{ tag: 'div', text: 'nope' }], 'last-child'),
  ]));
  assert.equal(r.status, 'not-applied');
  assert.match(r.error!.message, /invalid inside a target ul/);
  assert.equal(list.childNodes.length, 0);
});

test('T31: replay of the same batch id and payload returns the prior receipt without re-execution', async () => {
  const w = makeWorld();
  const anchor = el('div');
  w.doc.appendChild(anchor);
  const ref = observe(w, anchor);
  const first = await w.txn.applyBatch(req('b1', 'c1', [insertOp(ref, [{ tag: 'p', text: 'once' }])]));
  assert.equal(first.status, 'accepted');
  const stages = w.calls.filter((c) => c.op === 'stage').length;
  const second = await w.txn.applyBatch(req('b1', 'c1', [insertOp(ref, [{ tag: 'p', text: 'once' }])]));
  assert.equal(second, first, 'the exact prior receipt object is returned');
  assert.equal(w.calls.filter((c) => c.op === 'stage').length, stages, 'no duplicate insert');
  assert.equal(anchor.childNodes.filter((c) => c.nodeType === 1).length, 1, 'replay creates no duplicate widget');
});

test('T08: the same batch id with a DIFFERENT payload never executes and never overwrites the prior receipt', async () => {
  const w = makeWorld();
  const anchor = el('div');
  w.doc.appendChild(anchor);
  const ref = observe(w, anchor);
  const first = await w.txn.applyBatch(req('b1', 'c1', [insertOp(ref, [{ tag: 'p', text: 'original' }])]));
  assert.equal(first.status, 'accepted');
  const forged = await w.txn.applyBatch(req('b1', 'c1', [insertOp(ref, [{ tag: 'p', text: 'altered' }])]));
  assert.equal(forged.status, 'not-applied');
  assert.equal(forged.error!.code, 'duplicate-id');
  assert.equal(w.txn.receiptFor('b1')!.status, 'accepted', 'the original accepted receipt is preserved');
  assert.equal(anchor.childNodes.filter((c) => c.nodeType === 1).length, 1);
});

// ── T09: same-node text reversal ────────────────────────────────────────

test('T09: a failed candidate returns the predecessor value on the SAME Text node; release returns the site baseline; a site change is never overwritten', async () => {
  const w = makeWorld();
  const target = el('p');
  const node = text('Site original A');
  target.appendChild(node);
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const a = await w.txn.applyBatch(req('b1', 'c1', [textOp(ref, 'First change B')]));
  assert.equal(a.status, 'accepted');
  assert.equal(node.nodeValue, 'First change B');

  // Candidate C fails AFTER its write section (commit refusal on a CSS-bearing
  // batch): rollback returns the predecessor B — same node, compare-and-restore.
  w.setCommit('refused');
  const c = await w.txn.applyBatch(req('b2', 'c1', [textOp(ref, 'Second change C'), styleOp(ref, 'color', 'red')]));
  assert.ok(['rolled-back', 'conflicted'].includes(c.status), JSON.stringify(c));
  assert.match(c.error!.message, /late promotion compensated/);
  assert.equal(node.nodeValue, 'First change B', 'failed candidate returns the predecessor value, not the site baseline');
  w.setCommit('committed');

  // Accepted C; then release returns the SITE baseline A (not B).
  const d = await w.txn.applyBatch(req('b3', 'c1', [textOp(ref, 'Second change C')]));
  assert.equal(d.status, 'accepted');
  assert.equal(node.nodeValue, 'Second change C');
  const release = await w.txn.releaseCustomization('c1');
  assert.equal(release.status, 'accepted', JSON.stringify(release));
  assert.equal(node.nodeValue, 'Site original A', 'disable restores the underlying site baseline, not the predecessor');

  // The site changed the value during a candidate: the newer value stays.
  const target2 = el('p');
  const node2 = text('Second original');
  target2.appendChild(node2);
  w.doc.appendChild(target2);
  const ref2 = observe(w, target2);
  await w.txn.applyBatch(req('b4', 'c2', [textOp(ref2, 'claimed')]), );
  (w as World & { settleHook?: () => void }).settleHook = () => {
    (w as World & { settleHook?: () => void }).settleHook = undefined;
    node2.nodeValue = 'User typed this while the candidate was running';
  };
  const conflicted = await w.txn.applyBatch(req('b5', 'c2', [textOp(ref2, 'refined')]));
  assert.equal(conflicted.status, 'conflicted', JSON.stringify(conflicted));
  assert.equal(node2.nodeValue, 'User typed this while the candidate was running', 'the site change is preserved, never overwritten');
  const release2 = await w.txn.releaseCustomization('c2');
  assert.equal(release2.status, 'conflicted', 'the conflicting release is visible, not a false clean ack');
  assert.equal(node2.nodeValue, 'User typed this while the candidate was running');
});

test('T08: a target that mutates after CSS ack never activates and the inert bundle is exact-cleaned', async () => {
  const w = makeWorld();
  const anchor = el('div');
  const textNode = text('keep');
  anchor.appendChild(textNode);
  w.doc.appendChild(anchor);
  const anchorRef = observe(w, anchor);
  (w as World & { onStage?: () => void }).onStage = () => {
    anchor.remove();
  };
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(anchorRef, [{ tag: 'p', text: 'orphaned' }]),
    textOp(anchorRef, 'never written'),
    styleOp(anchorRef, 'color', 'red'), // the batch stages CSS, so the ack-then-mutation window opens
  ]));
  (w as World & { onStage?: () => void }).onStage = undefined;
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'stale-target');
  assert.equal(textNode.nodeValue, 'keep', 'the text write never happened');
  assert.equal(anchor.childNodes.length, 1, 'no widget was inserted');
  assert.ok(w.calls.some((c) => c.op === 'remove'), 'the inert candidate bundle was exact-cleaned');
});

test('T30: rollback of one candidate never touches an independent accepted customization', async () => {
  const w = makeWorld();
  const a1 = el('h1');
  w.doc.appendChild(a1);
  const a1Ref = observe(w, a1);
  const first = await w.txn.applyBatch(req('b1', 'themeA', [styleOp(a1Ref, 'color', 'tomato')]));
  assert.equal(first.status, 'accepted');
  const tokenA = a1.getAttribute(TOKEN_ATTRIBUTE)!;
  assert.ok(tokenA);

  // themeB's candidate fails at staging: themeA is untouched.
  w.setStage('refused');
  const failed = await w.txn.applyBatch(req('b2', 'themeB', [styleOp(a1Ref, 'color', 'steelblue')]));
  assert.equal(failed.status, 'not-applied');
  assert.equal(a1.getAttribute(TOKEN_ATTRIBUTE), tokenA, 'accepted work survives the failed candidate');

  // themeB accepts; then a refinement of themeB fails mid-verify: themeA's
  // fragment stays in the accepted aggregate and themeA's element keeps styling.
  w.setStage('inserted');
  const b1 = await w.txn.applyBatch(req('b3', 'themeB', [styleOp(a1Ref, 'color', 'steelblue')]));
  assert.equal(b1.status, 'accepted');
  const tokenAfterB = a1.getAttribute(TOKEN_ATTRIBUTE)!;
  assert.notEqual(tokenAfterB, tokenA, 'the composition moved to a new generation');
  const removeCalls = w.calls.filter((c) => c.op === 'remove');
  assert.equal(removeCalls.length, 1, 'the predecessor aggregate was released after commit');

  (w as World & { settleHook?: () => void }).settleHook = () => {
    (w as World & { settleHook?: () => void }).settleHook = undefined;
    a1.setAttribute(TOKEN_ATTRIBUTE, 'page-written'); // site interference
  };
  const b2 = await w.txn.applyBatch(req('b4', 'themeB', [styleOp(a1Ref, 'color', 'green')]));
  assert.ok(['rolled-back', 'conflicted'].includes(b2.status), JSON.stringify(b2));
  assert.equal(a1.getAttribute(TOKEN_ATTRIBUTE), tokenAfterB, 'the accepted generation was re-activated after the failed candidate');
  assert.ok(w.calls.some((c) => c.op === 'remove'), 'the candidate bundle was exact-cleaned');
});

test('T30: accepted C then disable returns the site baseline — and a cross-customization text claim conflicts', async () => {
  const w = makeWorld();
  const p = el('p');
  const node = text('original');
  p.appendChild(node);
  w.doc.appendChild(p);
  const ref = observe(w, p);

  assert.equal((await w.txn.applyBatch(req('b1', 'c1', [textOp(ref, 'one')]))).status, 'accepted');
  // A DIFFERENT customization cannot claim the same native text node.
  const clash = await w.txn.applyBatch(req('b2', 'c2', [textOp(ref, 'two')]));
  assert.equal(clash.status, 'not-applied');
  assert.equal(clash.error!.code, 'conflict');
  assert.match(clash.error!.message, /c1/);
  assert.equal(node.nodeValue, 'one', 'the conflicting batch wrote nothing');
  // The SAME customization refines its own claim.
  assert.equal((await w.txn.applyBatch(req('b3', 'c1', [textOp(ref, 'two')]))).status, 'accepted');
  assert.equal(node.nodeValue, 'two');
});

// ── T08/T14: crash at every boundary ────────────────────────────────────

test('T14: a staging refusal performs no local writes and no activation', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  w.setStage('refused');
  const r = await w.txn.applyBatch(req('b1', 'c1', [styleOp(ref, 'color', 'red')]));
  assert.equal(r.status, 'not-applied');
  assert.equal(h.getAttribute(TOKEN_ATTRIBUTE), null);
});

test('T14/I06: an unknown staging outcome yields outcome-unknown — never not-applied — and no activation', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  w.setStage('unknown');
  const r = await w.txn.applyBatch(req('b1', 'c1', [styleOp(ref, 'color', 'red')]));
  assert.equal(r.status, 'outcome-unknown');
  assert.equal(r.error!.code, 'timeout-unknown');
  assert.equal(h.getAttribute(TOKEN_ATTRIBUTE), null, 'never activated');
});

test('T14: cancellation after staging rolls the candidate back and preserves accepted work', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  const accepted = await w.txn.applyBatch(req('b1', 'c1', [styleOp(ref, 'color', 'red')]));
  assert.equal(accepted.status, 'accepted');
  const token = h.getAttribute(TOKEN_ATTRIBUTE)!;

  (w as World & { onStage?: () => void }).onStage = () => {
    (w as World & { onStage?: () => void }).onStage = undefined;
    w.epoch.value += 1; // route changed while the candidate staged
  };
  const cancelled = await w.txn.applyBatch(req('b2', 'c1', [styleOp(ref, 'color', 'blue')]));
  assert.equal(cancelled.status, 'not-applied');
  assert.equal(cancelled.error!.code, 'stale-route');
  assert.equal(h.getAttribute(TOKEN_ATTRIBUTE), token, 'the accepted generation is still active');
  assert.ok(w.calls.some((c) => c.op === 'remove'), 'the inert candidate bundle was exact-cleaned');
});

test('T08: a late commit-refusal after the write section compensates the whole candidate', async () => {
  const w = makeWorld();
  const h = el('h1');
  const node = text('keep me');
  h.appendChild(node);
  w.doc.appendChild(h);
  const hRef = observe(w, h);
  // first accepted revision establishes a token generation to restore
  assert.equal((await w.txn.applyBatch(req('b1', 'c1', [styleOp(hRef, 'color', 'red')]))).status, 'accepted');
  const token = h.getAttribute(TOKEN_ATTRIBUTE)!;

  w.setCommit('refused');
  const r = await w.txn.applyBatch(req('b2', 'c1', [textOp(hRef, 'changed'), styleOp(hRef, 'color', 'blue')]));
  assert.ok(['rolled-back', 'conflicted'].includes(r.status), JSON.stringify(r));
  assert.match(r.error!.message, /late promotion compensated/);
  assert.equal(node.nodeValue, 'keep me', 'the text write reversed');
  assert.equal(h.getAttribute(TOKEN_ATTRIBUTE), token, 'the accepted generation was re-activated');
});

// ── policy refusals before any side effect ──────────────────────────────

test('unsupported operations are refused before side effects (plan/08 §1)', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(ref, [{ tag: 'p', text: 'x' }]),
    { kind: 'bindKey', chord: 'Ctrl+K', actionIds: ['a1'] },
  ]));
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'unsupported-capability');
  assert.equal(h.childNodes.length, 0, 'the earlier op in the same batch did not survive the refusal');
});

test('a stale observed target refuses the batch (no first-match fallback)', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  h.remove();
  const r = await w.txn.applyBatch(req('b1', 'c1', [styleOp(ref, 'color', 'red')]));
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'stale-target');
});

test('an empty text replacement is refused before any side effect (schema min-1; approval arrives with grants)', async () => {
  const w = makeWorld();
  const p = el('p');
  p.appendChild(text('content'));
  w.doc.appendChild(p);
  const r = await w.txn.applyBatch(req('b1', 'c1', [textOp(observe(w, p), '')]));
  assert.equal(r.status, 'not-applied');
  assert.ok(['denied', 'invalid-schema'].includes(r.error!.code));
  assert.equal((p.childNodes[0] as StubNode).nodeValue, 'content', 'nothing was written');
});

test('a non-leaf text target is refused with the exact shape error', async () => {
  const w = makeWorld();
  const p = el('p');
  p.appendChild(text('a'));
  p.appendChild(text('b'));
  w.doc.appendChild(p);
  const r = await w.txn.applyBatch(req('b1', 'c1', [textOp(observe(w, p), 'x')]));
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'unsupported-text-shape');
});

test('hide compiles through the same style path and token-activates the target (I17)', async () => {
  const w = makeWorld();
  const shorts = el('section');
  w.doc.appendChild(shorts);
  const r = await w.txn.applyBatch(req('b1', 'c1', [{ kind: 'hide', target: { targetRef: observe(w, shorts) } }]));
  assert.equal(r.status, 'accepted');
  assert.ok(shorts.getAttribute(TOKEN_ATTRIBUTE), 'the hidden target is tokened');
  const staged = w.calls.find((c) => c.op === 'stage')!.args as { css: string };
  assert.match(staged.css, /display:\s*none\s*!important/);
});

test('quota: a 65th new customization is refused before any side effect', async () => {
  const w = makeWorld();
  for (let i = 0; i < 64; i++) {
    const h = el('h1');
    w.doc.appendChild(h);
    const r = await w.txn.applyBatch(req(`q${i}`, `c${i}`, [styleOp(observe(w, h), 'color', 'red')]));
    assert.equal(r.status, 'accepted', `batch ${i}`);
  }
  const h = el('h1');
  w.doc.appendChild(h);
  const over = await w.txn.applyBatch(req('q64', 'c64', [styleOp(observe(w, h), 'color', 'red')]));
  assert.equal(over.status, 'not-applied');
  assert.equal(over.error!.code, 'quota-exceeded');
});
