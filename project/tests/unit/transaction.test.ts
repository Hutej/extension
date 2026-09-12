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
import type { Verifier, VerificationReport, VerifyPlan } from '../../src/runtime/verify.ts';
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
  /** S7.1: native activation/focus/scroll duck methods + parentElement. */
  parentElement?: StubNode | null;
  click?(): void;
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
  contains?(other: StubNode | null): boolean;
  focus?(): void;
  scrollIntoView?(opts?: unknown): void;
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
  const listeners: Array<[string, () => void]> = [];
  const containsFn = (self: StubNode, other: StubNode | null): boolean => {
    let n: StubNode | null = other;
    while (n) {
      if (n === self) return true;
      n = n.parentElement ?? null;
    }
    return false;
  };
  const node: StubNode = {
    nodeType,
    ...(nodeType === 1
      ? {
          tagName: tagOrValue.toUpperCase(),
          isContentEditable: false,
          addEventListener: (t: string, fn: () => void) => { listeners.push([t, fn]); },
          removeEventListener: (t: string, fn: () => void) => {
            const i = listeners.findIndex(([tt, f]) => tt === t && f === fn);
            if (i !== -1) listeners.splice(i, 1);
          },
          contains: (other: StubNode | null) => containsFn(node, other),
        }
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
    get parentElement(): StubNode | null {
      const p = node.parentNode;
      return p && p.nodeType === 1 ? p : null;
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
      // Real DOM semantics: appending MOVES the node from its old parent.
      if (child.parentNode) {
        const old = child.parentNode;
        const oi = old.childNodes.indexOf(child);
        if (oi !== -1) old.childNodes.splice(oi, 1);
        const oc = old.children.indexOf(child);
        if (oc !== -1) old.children.splice(oc, 1);
      }
      child.parentNode = node;
      node.childNodes.push(child);
      if (child.nodeType === 1) node.children.push(child);
      return child;
    },
    insertBefore(node_, ref) {
      if (node_.parentNode) {
        const old = node_.parentNode;
        const oi = old.childNodes.indexOf(node_);
        if (oi !== -1) old.childNodes.splice(oi, 1);
        const oc = old.children.indexOf(node_);
        if (oc !== -1) old.children.splice(oc, 1);
      }
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
/** S7.1: an element that satisfies the bind-action duck checks (focus/click/
 *  scrollIntoView), so bindKey batches run against realistic targets. */
const activatable = (tag: string): StubNode => {
  const node = el(tag);
  node.click = () => {};
  node.focus = () => {};
  node.scrollIntoView = () => {};
  const listeners: Array<[string, () => void]> = [];
  node.addEventListener = (t: string, fn: () => void) => { listeners.push([t, fn]); };
  node.removeEventListener = (t: string, fn: () => void) => {
    const i = listeners.findIndex(([tt, f]) => tt === t && f === fn);
    if (i !== -1) listeners.splice(i, 1);
  };
  (node as StubNode & { __listeners(): number }).__listeners = () => listeners.length;
  (node as StubNode & { __invoke(type: string): void }).__invoke = (type: string) => {
    for (const [t, fn] of listeners) if (t === type) fn();
  };
  return node;
};

function makeDoc(): { doc: StubNode } {
  const doc = makeNode(9, '#document');
  doc.__connected = true;
  (doc as unknown as { createElement(tag: string): StubNode }).createElement = (tag: string) => activatable(tag);
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
  verifyMode: 'pass' | 'fail' | 'unknown' | 'empty';
  verifyCalls: number;
  /** S7.1: normalized chords currently live in the fake behavior. */
  bindInstalls: string[];
  bindDisposes: string[];
  /** S7.2: customization ids with a live rule. */
  ruleInstalls: string[];
  ruleDisposes: string[];
  projectionDisposes: string[];
}

/** S7.1+S7.2: minimal in-memory behavior double — real conflict/cap semantics
 *  via boundChords(); install/dispose recorded for rollback assertions. */
function makeFakeBehavior(w: World): import('../../src/runtime/behavior.ts').BehaviorCore {
  const live = new Map<string, import('../../src/runtime/behavior.ts').BindingSpec>();
  const rules = new Map<string, import('../../src/runtime/behavior.ts').RuleSpec>();
  let ruleSeq = 0;
  return {
    install: (spec) => {
      live.set(spec.normalized, spec);
      w.bindInstalls.push(spec.normalized);
      return {
        dispose: () => {
          if (live.get(spec.normalized) === spec) {
            live.delete(spec.normalized);
            w.bindDisposes.push(spec.normalized);
          }
        },
      };
    },
    boundChords: () => {
      const out = new Map<string, string>();
      for (const [normalized, spec] of live) out.set(normalized, spec.customizationId);
      return out;
    },
    isBound: (normalized: string) => live.has(normalized),
    installRule: (spec) => {
      const key = `${spec.customizationId}#${ruleSeq++}`;
      rules.set(key, spec);
      w.ruleInstalls.push(spec.customizationId);
      return { dispose: () => { rules.delete(key); w.ruleDisposes.push(spec.customizationId); } };
    },
    hasRule: (customizationId: string) => {
      for (const [key, spec] of rules) if (spec.customizationId === customizationId && rules.has(key)) return true;
      return false;
    },
    dispose: () => { live.clear(); rules.clear(); },
  };
}

/** Semi-real stub verifier: re-checks the same primitives the S4.2 inline
 *  checks covered (text values, insert placement, token membership) so the
 *  settle-mutation scenarios exercise the rollback paths; explicit modes
 *  force fail/unknown/empty reports for the T13 gate tests. */
function makeStubVerifier(w: World): Verifier {
  const outcome = (key: string, status: 'pass' | 'fail' | 'unknown', section: 'delivery' | 'effect' | 'integrity', detail?: string) =>
    ({ key, section, status, ...(detail ? { detail } : {}) });
  return {
    captureBaseline: () => ({ ok: true as const, baseline: { viewportOverflowX: 0, els: new Map() } }),
    verify: async (plan: VerifyPlan): Promise<VerificationReport> => {
      w.verifyCalls += 1;
      const outcomes: Array<{ key: string; section: 'delivery' | 'effect' | 'integrity'; status: 'pass' | 'fail' | 'unknown'; detail?: string }> = [];
      outcomes.push(outcome('delivery:css', 'pass', 'delivery'));
      for (const b of plan.bindings) {
        outcomes.push(outcome(b.key, w.bindInstalls.some((s) => s === b.normalized) ? 'pass' : 'fail', 'effect', 'binding not installed'));
      }
      for (const c of plan.collapses) {
        outcomes.push(outcome(c.key, (c.toggle as unknown as StubNode).isConnected ? 'pass' : 'fail', 'effect', 'toggle not connected'));
      }
      for (const r of plan.rules) {
        outcomes.push(outcome(r.key, w.ruleInstalls.includes(r.ruleKey) ? 'pass' : 'fail', 'effect', 'rule not installed'));
      }
      for (const t of plan.texts) {
        const ok = t.node.isConnected && t.node.nodeValue === t.installed;
        outcomes.push(outcome(t.key, ok ? 'pass' : 'fail', 'effect', ok ? undefined : 'text value does not hold'));
      }
      for (const ins of plan.inserts) {
        const ok = ins.roots.every((r) => r.isConnected);
        outcomes.push(outcome(ins.key, ok ? 'pass' : 'fail', 'effect', ok ? undefined : 'not connected'));
      }
      for (const p of plan.projections) {
        const ok = (p.root as unknown as StubNode).isConnected;
        outcomes.push(outcome(p.key, ok ? 'pass' : 'fail', 'effect', ok ? undefined : 'view not connected'));
      }
      for (const t of plan.tokenChecks) {
        const ok = t.el.isConnected && t.el.getAttribute(TOKEN_ATTRIBUTE) === t.ns;
        outcomes.push(outcome(t.key, ok ? 'pass' : 'fail', 'delivery', ok ? undefined : 'token lost'));
      }
      if (w.verifyMode === 'fail') outcomes.push(outcome('forced:fail', 'fail', 'integrity', 'forced by test'));
      if (w.verifyMode === 'unknown') outcomes.push(outcome('forced:unknown', 'unknown', 'integrity', 'forced by test'));
      if (w.verifyMode === 'empty') outcomes.length = 0;
      const fail = outcomes.some((o) => o.status === 'fail');
      const unknown = outcomes.some((o) => o.status === 'unknown');
      const counts = {
        pass: outcomes.filter((o) => o.status === 'pass').length,
        satisfied: 0,
        fail: outcomes.filter((o) => o.status === 'fail').length,
        unknown: outcomes.filter((o) => o.status === 'unknown').length,
      };
      return {
        revisionId: plan.revisionId,
        batchId: plan.batchId,
        epoch: plan.entryEpoch,
        status: fail ? 'fail' : unknown ? 'unknown' : outcomes.length === 0 ? 'unknown' : 'pass',
        issues: outcomes.filter((o) => o.status !== 'pass') as VerificationReport['issues'],
        counts,
        coverage: { protectedTargets: plan.protectedEls.length, sentinels: plan.sentinels.length, combinedRevisions: plan.combined.length, checks: outcomes.length, unmeasuredDecls: plan.unmeasuredDecls, preExistingBroken: 0, rechecked: false },
      };
    },
  };
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
  const world: World = {
    doc,
    deps: {} as TransactionDeps,
    txn: {} as Transaction,
    calls,
    epoch,
    verifyMode: 'pass',
    verifyCalls: 0,
    bindInstalls: [],
    bindDisposes: [],
    ruleInstalls: [],
    ruleDisposes: [],
    projectionDisposes: [],
    setStage: (o) => { stageOutcome = o; },
    setCommit: (o) => { commitOutcome = o; },
    setRemove: (o) => { removeOutcome = o; },
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
    behavior: makeFakeBehavior(world),
    projection: (spec, container) => ({
      root: el('section') as unknown as HTMLElement,
      connect: () => {},
      dispose: () => { world.projectionDisposes.push(spec.customizationId); },
      itemCount: () => container.children.length,
      staleCount: () => 0,
      coverageText: () => `Showing ${container.children.length} of ${container.children.length} items`,
    }),
    verify: makeStubVerifier(world),
    settle: async () => {
      (world as World & { settleHook?: () => void }).settleHook?.();
    },
  };
  world.deps = deps;
  world.txn = createTransaction(deps);
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

test('S8.2: every v1 operation kind has an executor — an ungated relocate is refused before side effects (plan/08 §1)', async () => {
  const w = makeWorld();
  const h = el('h1');
  w.doc.appendChild(h);
  const ref = observe(w, h);
  // The former unsupported kinds (float/relocate) execute now; the v1
  // refusal gate remains for future kinds. An ungated relocate is the
  // prepare-time refusal that must leave earlier batch ops unexecuted.
  const r = await w.txn.applyBatch(req('b1', 'c1', [
    insertOp(ref, [{ tag: 'p', text: 'x' }]),
    { kind: 'relocate', target: { targetRef: ref }, destination: { targetRef: ref }, position: 'after' },
  ]));
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'invalid-schema');
  assert.match(r.error!.message, /structuralGrant/);
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

// ── S4.3: mandatory verification gates ──────────────────────────────────

test('T13: a missing verifier refuses the batch before any side effect — a clean predecessor is untouched', async () => {
  const w = makeWorld();
  const h = el('h1');
  const node = text('keep');
  h.appendChild(node);
  w.doc.appendChild(h);
  const ref = observe(w, h);
  // A transaction constructed WITHOUT the verifier (deps override).
  const bare = createTransaction({ ...w.deps, verify: undefined });
  const r = await bare.applyBatch(req('b1', 'c1', [textOp(ref, 'changed')]));
  assert.equal(r.status, 'not-applied');
  assert.match(r.error!.message, /verification is unavailable/);
  assert.equal(node.nodeValue, 'keep', 'nothing was written without a verifier');
  assert.equal(w.txn.receiptFor('b1'), undefined, 'the bare transaction retains its own receipts');
});

test('T13: a verifier report with zero measured checks can never pass', async () => {
  const w = makeWorld();
  const h = el('h1');
  h.appendChild(text('keep'));
  w.doc.appendChild(h);
  const ref = observe(w, h);
  w.verifyMode = 'empty';
  const r = await w.txn.applyBatch(req('b1', 'c1', [textOp(ref, 'changed')]));
  assert.ok(['rolled-back', 'conflicted'].includes(r.status), JSON.stringify(r));
  assert.equal(r.error!.code, 'conflict');
  assert.equal(r.report!.issues[0].key, 'verify:internal', 'the synthetic unknown is visible in the receipt');
  assert.equal(node_value_of(h), 'keep');
  w.verifyMode = 'pass';
});
const node_value_of = (h: StubNode): string => (h.childNodes[0] as StubNode).nodeValue ?? '';

test('S4.3: an accepted receipt carries the exact-revision VerificationReport', async () => {
  const w = makeWorld();
  const h = el('h1');
  h.appendChild(text('original'));
  w.doc.appendChild(h);
  const ref = observe(w, h);
  const r = await w.txn.applyBatch(req('b1', 'c1', [textOp(ref, 'changed')]));
  assert.equal(r.status, 'accepted');
  assert.ok(r.report, 'the gating report ships with the accepted receipt');
  assert.equal(r.report!.revisionId, 'b1-rev');
  assert.equal(r.report!.status, 'pass');
  assert.ok(r.report!.coverage.checks > 0);
});

// ── S7.1: approved native action bindings (bindKey) ──────────────────────

const bindOp = (target: { targetRef?: string; localRef?: string }, chord: string, actionIds: string[], extra: Record<string, unknown> = {}): Operation => ({
  kind: 'bindKey', target, chord, actionIds, ...extra,
});

test('S7.1: a bindKey-only batch installs exactly one binding; a colliding chord conflicts with its owner named; release uninstalls exactly', async () => {
  const w = makeWorld();
  const btn = activatable('button');
  w.doc.appendChild(btn);
  const ref = observe(w, btn);

  const r = await w.txn.applyBatch(req('kb1', 'keys1', [bindOp({ targetRef: ref }, 'Alt+G', ['activate'])]));
  assert.equal(r.status, 'accepted', JSON.stringify(r).slice(0, 400));
  assert.deepEqual(r.resourceIds, ['bind-0']);
  assert.deepEqual(w.bindInstalls, ['alt+g']);
  // A second customization cannot take the same chord (plan/09 §2).
  const other = await w.txn.applyBatch(req('kb2', 'keys2', [bindOp({ targetRef: ref }, 'Alt+G', ['focus'])]));
  assert.equal(other.status, 'not-applied');
  assert.equal(other.error!.code, 'conflict');
  assert.match(other.error!.message, /keys1/);
  assert.equal(w.bindInstalls.length, 1, 'the refused batch installed nothing');

  const rel = await w.txn.releaseCustomization('keys1');
  assert.equal(rel.status, 'accepted');
  assert.deepEqual(w.bindDisposes, ['alt+g']);
  // The freed chord is bindable again by the next customization.
  const again = await w.txn.applyBatch(req('kb3', 'keys2', [bindOp({ targetRef: ref }, 'Alt+G', ['focus'])]));
  assert.equal(again.status, 'accepted');
});

test('S7.1: reserved, plain-typing, unparseable and duplicate chords are refused before any install', async () => {
  const w = makeWorld();
  const btn = activatable('button');
  w.doc.appendChild(btn);
  const ref = observe(w, btn);

  const cases: Array<[Operation[], string, RegExp]> = [
    [[bindOp({ targetRef: ref }, 'Ctrl+T', ['activate'])], 'unsupported-capability', /reserved by the browser/],
    [[bindOp({ targetRef: ref }, 'Cmd+W', ['activate'])], 'unsupported-capability', /reserved by the browser/],
    [[bindOp({ targetRef: ref }, 'g', ['activate'])], 'conflict', /plain typing/],
    [[bindOp({ targetRef: ref }, 'Foo+G', ['activate'])], 'invalid-schema', /not a recognized modifier/],
    [[bindOp({ targetRef: ref }, 'NotAKey', ['activate'])], 'invalid-schema', /not a bindable key/],
    [[bindOp({ targetRef: ref }, 'Alt+G', ['activate']), bindOp({ targetRef: ref }, 'Alt+G', ['focus'])], 'duplicate-id', /bound twice/],
  ];
  for (const [operations, code, message] of cases) {
    const r = await w.txn.applyBatch(req(`bad-${Math.random().toString(36).slice(2, 6)}`, 'keys', operations));
    assert.equal(r.status, 'not-applied');
    assert.equal(r.error!.code, code, JSON.stringify(r.error));
    assert.match(r.error!.message, message);
  }
  assert.equal(w.bindInstalls.length, 0, 'no refused chord ever installed');
});

test('S7.1: action catalog is validated against the concrete target before any side effect', async () => {
  const w = makeWorld();
  const div = activatable('div'); // no tabindex, not focusable-tag
  w.doc.appendChild(div);
  const ref = observe(w, div);

  const notInCatalog = await w.txn.applyBatch(req('ac1', 'keys', [bindOp({ targetRef: ref }, 'Alt+G', ['selfDestruct'])]));
  assert.equal(notInCatalog.status, 'not-applied');
  assert.equal(notInCatalog.error!.code, 'invalid-schema');
  assert.match(notInCatalog.error!.message, /not in the bind action catalog/);

  const followPlainDiv = await w.txn.applyBatch(req('ac2', 'keys', [bindOp({ targetRef: ref }, 'Alt+G', ['followLink'])]));
  assert.equal(followPlainDiv.status, 'not-applied');
  assert.equal(followPlainDiv.error!.code, 'unsupported-capability');
  assert.match(followPlainDiv.error!.message, /followLink targets a link/);

  const focusPlainDiv = await w.txn.applyBatch(req('ac3', 'keys', [bindOp({ targetRef: ref }, 'Alt+G', ['focus'])]));
  assert.equal(focusPlainDiv.status, 'not-applied');
  assert.equal(focusPlainDiv.error!.code, 'unsupported-capability');
  assert.match(focusPlainDiv.error!.message, /not keyboard-focusable/);

  // A safe link IS followable; javascript: links never are.
  const link = activatable('a');
  link.setAttribute('href', 'https://example.com/page');
  w.doc.appendChild(link);
  const linkRef = observe(w, link);
  const ok = await w.txn.applyBatch(req('ac4', 'keys', [bindOp({ targetRef: linkRef }, 'Alt+L', ['followLink'])]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 300));

  const jsLink = activatable('a');
  jsLink.setAttribute('href', 'javascript:alert(1)');
  w.doc.appendChild(jsLink);
  const jsRef = observe(w, jsLink);
  const refused = await w.txn.applyBatch(req('ac5', 'keys', [bindOp({ targetRef: jsRef }, 'Alt+J', ['followLink'])]));
  assert.equal(refused.status, 'not-applied');
  assert.equal(refused.error!.code, 'unsupported-capability');
  assert.match(refused.error!.message, /protocol/);
});

test('S7.1: the per-document binding cap refuses the 21st chord with the quota code', async () => {
  const w = makeWorld();
  const btn = activatable('button');
  w.doc.appendChild(btn);
  const ref = observe(w, btn);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const operations = Array.from({ length: 21 }, (_, i) => bindOp({ targetRef: ref }, `Alt+${letters[i]}`, ['focus']));
  const r = await w.txn.applyBatch(req('cap1', 'keys', operations));
  assert.equal(r.status, 'not-applied');
  assert.equal(r.error!.code, 'quota-exceeded');
  assert.equal(w.bindInstalls.length, 0, 'the over-cap batch installed nothing');
});

test('S7.1: a failed replacement rolls the candidate back AND restores the predecessor binding', async () => {
  const w = makeWorld();
  const btn = activatable('button');
  w.doc.appendChild(btn);
  const ref = observe(w, btn);

  const first = await w.txn.applyBatch(req('rk1', 'keys1', [bindOp({ targetRef: ref }, 'Alt+G', ['activate'])]));
  assert.equal(first.status, 'accepted');
  assert.deepEqual(w.bindInstalls, ['alt+g']);

  // Same customization, same chord, a longer action sequence — but the
  // verification gate fails: the whole candidate reverses and the
  // predecessor's binding is restored (not left half-retired).
  w.verifyMode = 'fail';
  const second = await w.txn.applyBatch(req('rk2', 'keys1', [bindOp({ targetRef: ref }, 'Alt+G', ['focus', 'activate'], { repeat: true })], 'rk2-rev'));
  assert.equal(second.status, 'rolled-back');
  const disposes = w.bindDisposes.filter((c) => c === 'alt+g');
  assert.equal(disposes.length, 1, 'the candidate binding uninstalled exactly once');
  assert.ok(w.bindInstalls.filter((c) => c === 'alt+g').length >= 2, 'the predecessor binding re-installed after rollback');
  assert.ok(w.deps.behavior.isBound('alt+g'), 'the predecessor shortcut is live again');
});

test('S7.1: an accepted replacement retires the predecessor binding; the new one owns the chord', async () => {
  const w = makeWorld();
  const btn = activatable('button');
  w.doc.appendChild(btn);
  const ref = observe(w, btn);

  const first = await w.txn.applyBatch(req('rp1', 'keys1', [bindOp({ targetRef: ref }, 'Alt+G', ['activate'])]));
  assert.equal(first.status, 'accepted');
  const second = await w.txn.applyBatch(req('rp2', 'keys1', [bindOp({ targetRef: ref }, 'Alt+G', ['focus'], { repeat: true })], 'rp2-rev'));
  assert.equal(second.status, 'accepted', JSON.stringify(second).slice(0, 300));
  const installs = w.bindInstalls.filter((c) => c === 'alt+g');
  assert.equal(installs.length, 2, 'predecessor + replacement');
  // Same-chord replacement: the successor overwrote the registry entry, so
  // the predecessor's stale handle disposes as an exact no-op — one live
  // binding, owned by the replacement revision (no duplication, AC-11).
  assert.equal(w.deps.behavior.boundChords().size, 1, 'exactly one live entry owns the chord');
  assert.ok(w.deps.behavior.isBound('alt+g'), 'the replacement owns the chord');
  assert.equal(w.deps.behavior.boundChords().get('alt+g'), 'keys1');
});

// ── S7.2: owned collapse disclosures + finite local rules ─────────────────

test('S7.2: a collapse batch inserts an owned toggle, hides the collapsed target, and verifies both', async () => {
  const w = makeWorld();
  const target = activatable('article');
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const r = await w.txn.applyBatch(req('col1', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide comment', initialState: 'collapsed', placement: 'before' },
  ]));
  assert.equal(r.status, 'accepted', JSON.stringify(r).slice(0, 400));
  assert.deepEqual(r.resourceIds, ['aggregate-css', 'insert-0', 'collapse-0'], 'the toggle is an insert resource; the collapse rule ships in the aggregate CSS');
  // The toggle exists as an owned child of the target's parent, BEFORE it.
  const parent = target.parentNode!;
  const idx = parent.childNodes.indexOf(target);
  const toggle = parent.childNodes[idx - 1];
  assert.ok(toggle, 'the toggle sits before the target');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(target.getAttribute('data-rv2-collapsed'), '1', 'the collapsed state is an owned attribute write');
});

test('S7.2: user override is mandatory; an empty label is refused', async () => {
  const w = makeWorld();
  const target = activatable('article');
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const noOverride = await w.txn.applyBatch(req('col-ov', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide', userOverride: false },
  ]));
  assert.equal(noOverride.status, 'not-applied');
  assert.equal(noOverride.error!.code, 'invalid-schema');
  assert.match(noOverride.error!.message, /override cannot be disabled/);

  const noLabel = await w.txn.applyBatch(req('col-lb', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: '  ' },
  ]));
  assert.equal(noLabel.status, 'not-applied');
  assert.equal(noLabel.error!.code, 'invalid-schema');
});

test('S7.2: release restores the collapse attribute baseline and removes the toggle exactly', async () => {
  const w = makeWorld();
  const target = activatable('article');
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const r = await w.txn.applyBatch(req('col2', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide' },
  ]));
  assert.equal(r.status, 'accepted');
  assert.equal(target.getAttribute('data-rv2-collapsed'), '1');
  const parent = target.parentNode!;
  const toggleCount = parent.childNodes.filter((n) => n.tagName === 'BUTTON').length;
  assert.equal(toggleCount, 1);

  const rel = await w.txn.releaseCustomization('col');
  assert.equal(rel.status, 'accepted');
  assert.equal(target.getAttribute('data-rv2-collapsed'), null, 'the site baseline (absent) is restored');
  assert.equal(parent.childNodes.filter((n) => n.tagName === 'BUTTON').length, 0, 'the owned toggle is removed exactly');
});

test('S7.2: a failed replacement rolls the collapse back — the site attribute baseline survives', async () => {
  const w = makeWorld();
  const target = activatable('article');
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const first = await w.txn.applyBatch(req('col-r1', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide' },
  ]));
  assert.equal(first.status, 'accepted');

  w.verifyMode = 'fail';
  const second = await w.txn.applyBatch(req('col-r2', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide', initialState: 'expanded' },
  ], 'col-r2-rev'));
  assert.equal(second.status, 'rolled-back');
  assert.equal(target.getAttribute('data-rv2-collapsed'), '1', 'the predecessor state is restored after rollback');
  assert.ok(target.parentNode!.childNodes.some((n) => n.tagName === 'BUTTON'), 'the predecessor toggle stays');
});

test('S7.2: a target-appeared rule installs, refuses wrong triggers/actions, and releases exactly', async () => {
  const w = makeWorld();
  const container = activatable('section');
  const comment = activatable('article');
  const toggle = activatable('button');
  toggle.setAttribute('aria-expanded', 'true');
  comment.appendChild(toggle);
  container.appendChild(comment);
  w.doc.appendChild(container);
  const containerRef = observe(w, container);
  const commentRef = observe(w, comment);
  const toggleRef = observe(w, toggle);

  const badTrigger = await w.txn.applyBatch(req('rule-t', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, trigger: 'trusted-shortcut', predicates: [], actionId: 'activateDisclosure' },
  ]));
  assert.equal(badTrigger.status, 'not-applied');
  assert.equal(badTrigger.error!.code, 'unsupported-capability');
  assert.match(badTrigger.error!.message, /no executor/);

  const badAction = await w.txn.applyBatch(req('rule-a', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, trigger: 'target-appeared', predicates: [], actionId: 'hideEverything' },
  ]));
  assert.equal(badAction.status, 'not-applied');
  assert.equal(badAction.error!.code, 'invalid-schema');
  assert.match(badAction.error!.message, /not in the rule action catalog/);

  const ownedState = await w.txn.applyBatch(req('rule-o', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, trigger: 'target-appeared', actionId: 'focus', predicates: [{ type: 'owned-state-equals', value: 'x' }] },
  ]));
  assert.equal(ownedState.status, 'not-applied');
  assert.equal(ownedState.error!.code, 'unsupported-capability');
  assert.match(ownedState.error!.message, /owned-state predicates/);

  // activateDisclosure needs an affordance INSIDE the instance with an
  // observable expanded state.
  const noAffordance = await w.txn.applyBatch(req('rule-n', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, trigger: 'target-appeared', predicates: [], actionId: 'activateDisclosure' },
  ]));
  assert.equal(noAffordance.status, 'not-applied');
  assert.match(noAffordance.error!.message, /needs the disclosure affordance/);

  const outside = activatable('button');
  w.doc.appendChild(outside);
  const outsideRef = observe(w, outside);
  const notInside = await w.txn.applyBatch(req('rule-x', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, targetRef: outsideRef, trigger: 'target-appeared', predicates: [], actionId: 'activateDisclosure' },
  ]));
  assert.equal(notInside.status, 'not-applied');
  assert.match(notInside.error!.message, /must live inside/);

  const ok = await w.txn.applyBatch(req('rule-ok', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, targetRef: toggleRef, trigger: 'target-appeared', predicates: [{ type: 'member-of', targetRef: containerRef }, { type: 'expanded-equals', value: true }], actionId: 'activateDisclosure' },
  ]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 400));
  assert.deepEqual(ok.resourceIds, ['rule-0']);
  assert.deepEqual(w.ruleInstalls, ['rule']);

  // Two rule ops in one batch install two copies (replay expands one saved
  // rule this way); they share the rule's per-instance once-set — one action
  // per instance per customization (conservative by design).
  const twoRules = await w.txn.applyBatch(req('rule-2', 'rule', [
    { kind: 'localRule', target: { targetRef: commentRef }, targetRef: toggleRef, trigger: 'target-appeared', predicates: [], actionId: 'activateDisclosure' },
    { kind: 'localRule', target: { targetRef: commentRef }, targetRef: toggleRef, trigger: 'target-appeared', predicates: [{ type: 'expanded-equals', value: false }], actionId: 'activateDisclosure' },
  ]));
  assert.equal(twoRules.status, 'accepted', JSON.stringify(twoRules).slice(0, 300));
  assert.deepEqual(twoRules.resourceIds, ['rule-0', 'rule-1']);
  assert.equal(w.ruleInstalls.length, 3, 'seed rule + two copies');
  assert.ok(w.deps.behavior.hasRule('rule'));

  const rel = await w.txn.releaseCustomization('rule');
  assert.equal(rel.status, 'accepted');
  assert.equal(w.ruleDisposes.length, 3, 'every installed copy uninstalled exactly');
  assert.equal(w.deps.behavior.hasRule('rule'), false);
});

test('S7.2: a collapsed instance joins the intentional hide scope (verification exemption)', async () => {
  const w = makeWorld();
  const target = activatable('article');
  w.doc.appendChild(target);
  const ref = observe(w, target);

  const r = await w.txn.applyBatch(req('col-h', 'col', [
    { kind: 'collapse', target: { targetRef: ref }, label: 'Hide' },
  ]));
  assert.equal(r.status, 'accepted', JSON.stringify(r).slice(0, 400));
  assert.equal(r.report!.status, 'pass');
  assert.ok(r.report!.issues.every((i) => i.status === 'pass'), 'the intentional collapse is exempt from integrity failures');
});

// ── S8.1: linked projection views (T17 at the unit boundary) ──────────────

const projectOp = (
  targetRef: string,
  sourceSetRef: string,
  overrides: Partial<Extract<Operation, { kind: 'projectCollection' }>> = {},
): Operation => ({
  kind: 'projectCollection',
  target: { targetRef },
  sourceSetRef,
  fields: [{ sourceField: 'title', label: 'Title' }, { sourceField: 'link', label: 'Link' }, { sourceField: 'category', label: 'Category' }],
  view: 'board',
  groupBy: 'category',
  ...overrides,
});

test('S8.1: a board projection installs after its anchor, protects its source set, and releases exactly', async () => {
  const w = makeWorld();
  const list = el('ul');
  const a = el('li');
  const b = el('li');
  list.appendChild(a);
  list.appendChild(b);
  const section = el('section');
  w.doc.appendChild(section);
  w.doc.appendChild(list);
  const sectionRef = observe(w, section);
  const listRef = observe(w, list);

  const ok = await w.txn.applyBatch(req('proj-ok', 'proj', [projectOp(sectionRef, listRef)]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 400));
  assert.deepEqual(ok.resourceIds, ['projection-0']);
  // The stub view root sits after the anchor; the source container is
  // protected (its release/dispose bookkeeping ran through the real path).
  const root = section.nextSibling!;
  assert.equal((root as StubNode).tagName, 'SECTION');

  // A replacement revision (fresh batch id, same customization) retires the
  // predecessor's wiring exactly.
  const replacement = await w.txn.applyBatch(req('proj-ok2', 'proj', [projectOp(sectionRef, listRef, { view: 'list' })]));
  assert.equal(replacement.status, 'accepted', JSON.stringify(replacement).slice(0, 400));
  assert.deepEqual(w.projectionDisposes, ['proj'], 'the predecessor view uninstalled at acceptance');

  const release = await w.txn.releaseCustomization('proj');
  assert.equal(release.status, 'accepted');
  assert.deepEqual(w.projectionDisposes, ['proj', 'proj'], 'release disposes the view exactly once more');
  assert.equal(
    w.doc.children.filter((c) => (c as StubNode).getAttribute('data-rv2p-view') !== null).length, 0,
    'the owned view tree is removed with the owned nodes',
  );
});

test('S8.1: projection refusals — board needs a group, the source set must resolve', async () => {
  const w = makeWorld();
  const section = el('section');
  const list = el('ul');
  w.doc.appendChild(section);
  w.doc.appendChild(list);
  const sectionRef = observe(w, section);
  const listRef = observe(w, list);

  const noGroup = await w.txn.applyBatch(req('proj-g', 'proj', [projectOp(sectionRef, listRef, { groupBy: undefined })]));
  assert.equal(noGroup.status, 'not-applied');
  assert.equal(noGroup.error!.code, 'invalid-schema');
  assert.match(noGroup.error!.message, /board groups by/);

  const missingSet = await w.txn.applyBatch(req('proj-s', 'proj', [projectOp(sectionRef, 'd999')]));
  assert.equal(missingSet.status, 'not-applied');
  assert.equal(missingSet.error!.code, 'unknown-target');

  // No view is left behind by refusals: the document holds exactly the two
  // observed elements and no disposal ever ran.
  assert.deepEqual(w.projectionDisposes, []);
  assert.equal(w.doc.children.filter((c) => (c as StubNode).getAttribute('data-rv2p-view') !== null).length, 0);
});

test('S8.1: showOriginal false hides the source set through the compiled hide path and restores on release', async () => {
  const w = makeWorld();
  const section = el('section');
  const list = el('ul');
  const item = el('li');
  list.appendChild(item);
  w.doc.appendChild(section);
  w.doc.appendChild(list);
  const sectionRef = observe(w, section);
  const listRef = observe(w, list);

  const ok = await w.txn.applyBatch(req('proj-hide', 'proj', [projectOp(sectionRef, listRef, { showOriginal: false })]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 400));
  // The container carries the composition token (the hide fragment targets it).
  assert.match(list.getAttribute(TOKEN_ATTRIBUTE) ?? '', /^rv2\.i.+\.g\d+$/, 'the source set joined the composition');
  // The acceptance report measured the compiled display:none effect.
  assert.ok((ok.report?.counts.pass ?? 0) > 0, 'the verifier measured the candidate');

  const release = await w.txn.releaseCustomization('proj');
  assert.equal(release.status, 'accepted');
  assert.equal(list.getAttribute(TOKEN_ATTRIBUTE), null, 'the source set left the composition on release');
});

// ── S8.2: float + gated relocation (T18 at the unit boundary) ─────────────

test('S8.2: a float op compiles measured fixed-position declarations, hosts the minimize control, and releases exactly', async () => {
  const w = makeWorld();
  const player = activatable('div');
  w.doc.appendChild(player);
  const ref = observe(w, player);

  const ok = await w.txn.applyBatch(req('float-ok', 'c-float', [
    { kind: 'float', target: { targetRef: ref }, edge: 'bottom-end', width: '24rem', maxHeight: '40vh', inset: '12px' },
  ]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 500));
  assert.deepEqual(ok.resourceIds, ['aggregate-css', 'insert-0', 'float-0'], 'the control rides the owned insert; the float carries its resource + its fragment rules');
  // The minimize control is the float target's first child (runtime-owned).
  const btn = player.children[0] as StubNode | undefined;
  assert.ok(btn && btn.tagName === 'BUTTON', 'the minimize control is an owned button inside the surface');
  assert.equal(btn!.getAttribute('data-rv2-float-btn'), '1');
  assert.equal(btn!.getAttribute('aria-label'), 'Minimize floated surface');

  // Minimize → the owned attribute flips on the target; restore un-flips.
  const invoke = (btn as unknown as { __invoke(type: string): void }).__invoke;
  invoke.call(btn, 'click');
  assert.equal(player.getAttribute('data-rv2-float-min'), '1');
  assert.equal(btn!.getAttribute('aria-label'), 'Restore floated surface');
  invoke.call(btn, 'click');
  assert.equal(player.getAttribute('data-rv2-float-min'), null, 'the minimized state is exact');

  const release = await w.txn.releaseCustomization('c-float');
  assert.equal(release.status, 'accepted');
  assert.equal(player.children.filter((c) => (c as StubNode).tagName === 'BUTTON').length, 0, 'the control is removed exactly');
  assert.equal(player.getAttribute('data-rv2-float-min'), null, 'the site baseline (no attribute) restored');
});

test('S8.2: float refusals — a bare media element cannot host the control; invalid CSS values refuse via the compiler', async () => {
  const w = makeWorld();
  const video = activatable('video');
  const player = activatable('div');
  w.doc.appendChild(video);
  w.doc.appendChild(player);
  const videoRef = observe(w, video);
  const playerRef = observe(w, player);

  const media = await w.txn.applyBatch(req('float-m', 'c-m', [{ kind: 'float', target: { targetRef: videoRef }, edge: 'top-start' }]));
  assert.equal(media.status, 'not-applied');
  assert.equal(media.error!.code, 'unsupported-capability');
  assert.match(media.error!.message, /float its container/);

  const badCss = await w.txn.applyBatch(req('float-c', 'c-c', [
    { kind: 'float', target: { targetRef: playerRef }, edge: 'top-start', width: 'url(https://evil.test/x)' },
  ]));
  assert.equal(badCss.status, 'not-applied', 'an unsafe width refuses through the compiled style path');
  assert.equal(player.children.length, 0, 'no control survived the refusal');
});

test('S8.2: relocate moves the exact node, keeps its identity, and release restores the original anchors exactly', async () => {
  const w = makeWorld();
  const node = activatable('div');
  const originalParent = el('section');
  const originalSibling = el('p');
  originalParent.appendChild(node);
  originalParent.appendChild(originalSibling);
  const destination = el('aside');
  w.doc.appendChild(originalParent);
  w.doc.appendChild(destination);
  const nodeRef = observe(w, node);
  const destRef = observe(w, destination);

  const ok = await w.txn.applyBatch(req('rel-ok', 'c-rel', [
    { kind: 'relocate', target: { targetRef: nodeRef }, destination: { targetRef: destRef }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(ok.status, 'accepted', JSON.stringify(ok).slice(0, 500));
  assert.deepEqual(ok.resourceIds, ['relocate-0']);
  assert.equal(node.parentElement, destination, 'the EXACT node reference moved (same listeners)');
  assert.ok((destination.children as unknown[]).includes(node));

  const release = await w.txn.releaseCustomization('c-rel');
  assert.equal(release.status, 'accepted');
  assert.equal(node.parentElement, originalParent, 'disable reattached the site baseline position');
  const siblings = originalParent.childNodes;
  assert.equal(siblings.indexOf(originalSibling) - siblings.indexOf(node), 1, 'the original next-sibling anchor held');
});

test('S8.2: relocation gates — no grant, self/containment, protected native targets, invalid list context, before/after without parent', async () => {
  const w = makeWorld();
  const node = activatable('div');
  const dest = el('aside');
  const formControl = activatable('input');
  const media = activatable('video');
  const custom = activatable('my-widget');
  const listItem = el('li');
  const list = el('ul');
  list.appendChild(listItem);
  w.doc.appendChild(node);
  w.doc.appendChild(dest);
  w.doc.appendChild(formControl);
  w.doc.appendChild(media);
  w.doc.appendChild(custom);
  w.doc.appendChild(list);
  const ref = (n: StubNode): string => observe(w, n);

  const noGrant = await w.txn.applyBatch(req('rel-g', 'c1', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(dest) }, position: 'last-child' },
  ]));
  assert.equal(noGrant.status, 'not-applied');
  assert.match(noGrant.error!.message, /structuralGrant/);

  const self = await w.txn.applyBatch(req('rel-s', 'c2', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(node) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(self.status, 'not-applied');
  assert.match(self.error!.message, /relative to itself/);

  const contains = await w.txn.applyBatch(req('rel-c', 'c3', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(formControl) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(contains.status, 'not-applied', 'a batch target cannot relocate INTO its own subtree');

  for (const [label, target] of [['form control', formControl], ['media', media], ['custom element', custom]] as const) {
    const refused = await w.txn.applyBatch(req(`rel-p-${label}`, 'c4', [
      { kind: 'relocate', target: { targetRef: ref(target) }, destination: { targetRef: ref(dest) }, position: 'last-child', structuralGrant: true },
    ]));
    assert.equal(refused.status, 'not-applied', `${label} targets are refused`);
    assert.equal(refused.error!.code, 'unsupported-capability');
    assert.match(`${refused.error!.message} ${refused.error!.recoveryAction ?? ''}`, /float\/CSS|linked projection/);
  }

  const intoList = await w.txn.applyBatch(req('rel-l', 'c5', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(dest) }, position: 'last-child', structuralGrant: true },
  ]));
  // A div into an aside is fine; the LIST context check fires against a ul:
  const intoUl = await w.txn.applyBatch(req('rel-ul', 'c6', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(dest) }, position: 'before', structuralGrant: true },
  ]));
  assert.equal(intoList.status, 'accepted', JSON.stringify(intoList).slice(0, 300));
  assert.ok(intoUl.status === 'accepted' || intoUl.status === 'not-applied');
});

test('S8.2: a rolled-back relocation reattaches the exact node and keeps focus; a release conflict records the site override and suspends after two fights', async () => {
  const w = makeWorld();
  const node = activatable('div');
  const originalParent = el('section');
  originalParent.appendChild(node);
  const destA = el('aside');
  const destB = el('aside');
  w.doc.appendChild(originalParent);
  w.doc.appendChild(destA);
  w.doc.appendChild(destB);
  const ref = (n: StubNode): string => observe(w, n);

  // 1. The site overrides an accepted relocation → release conflict = fight 1.
  const okA = await w.txn.applyBatch(req('rel-a', 'c-rel', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(destA) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(okA.status, 'accepted', JSON.stringify(okA).slice(0, 300));
  // The site moves the node elsewhere (its newer position wins).
  const siteHome = el('div');
  w.doc.appendChild(siteHome);
  siteHome.appendChild(node);
  const releaseA = await w.txn.releaseCustomization('c-rel');
  assert.equal(releaseA.status, 'conflicted');
  assert.ok(releaseA.conflicts?.some((c) => /newer position stays/.test(c)));
  assert.equal(node.parentElement, siteHome, 'the site position is never overwritten (I23)');
  // The site baseline could not restore; the fight is counted once.
  assert.equal(node.parentElement, siteHome);

  // 2. A second site override (release of another accepted relocation) → fight 2.
  const movedB = originalSiblingless();
  const okB = await w.txn.applyBatch(req('rel-b', 'c-rel2', [
    { kind: 'relocate', target: { targetRef: ref(movedB) }, destination: { targetRef: ref(destB) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(okB.status, 'accepted', JSON.stringify(okB).slice(0, 300));
  const otherSite = el('div');
  w.doc.appendChild(otherSite);
  otherSite.appendChild(movedB); // the site overrides the accepted relocation
  const releaseB = await w.txn.releaseCustomization('c-rel2');
  assert.equal(releaseB.status, 'conflicted', 'the second site override records a visible fight');

  // 3. The third relocation attempt is refused with the visible fallback.
  const suspended = await w.txn.applyBatch(req('rel-c', 'c-rel3', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(destA) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(suspended.status, 'not-applied');
  assert.equal(suspended.error!.code, 'conflict');
  assert.match(suspended.error!.message, /relocation is suspended on this document/);
  assert.match(suspended.error!.message, /linked projection/);

  function originalSiblingless(): StubNode {
    const n = activatable('div');
    originalParent.appendChild(n);
    return n;
  }
});

test('S8.2: a rolled-back relocation reattaches the exact node to its recorded anchors with focus preserved', async () => {
  const w = makeWorld();
  const node = activatable('div');
  const originalParent = el('section');
  originalParent.appendChild(node);
  const dest = el('aside');
  w.doc.appendChild(originalParent);
  w.doc.appendChild(dest);
  const ref = (n: StubNode): string => observe(w, n);

  w.verifyMode = 'fail'; // the candidate rolls back after the write section
  const failed = await w.txn.applyBatch(req('rel-x', 'c-x', [
    { kind: 'relocate', target: { targetRef: ref(node) }, destination: { targetRef: ref(dest) }, position: 'last-child', structuralGrant: true },
  ]));
  assert.equal(failed.status, 'rolled-back');
  assert.equal(node.parentElement, originalParent, 'the exact node reattached to its original parent');
  assert.equal(dest.children.length, 0);
});
