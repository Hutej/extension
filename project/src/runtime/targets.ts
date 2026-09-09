/**
 * runtime/targets — identity/root registry (plan/03 `runtime/targets`,
 * plan/07 §3, algorithm A2).
 *
 * Session-instance identity is EXACT NODE identity: observation registers the
 * live node under an opaque, snapshot-local targetRef; resolution accepts
 * only that recorded node while it stays connected inside its registered
 * root with its declared predicates unchanged. A selector or a hash is never
 * identity proof (I15) — the legacy `expectedFp = null → mutate unverified`
 * path has no equivalent here. WeakMap-backed references are never
 * serialized (plan/04 §2: ResolvedTarget is runtime-local state).
 *
 * Root discipline (I26): every query is relative to one registered root;
 * document selectors never cross root boundaries. Open ShadowRoots are
 * registered roots; a null shadowRoot is recorded as unknown-capability,
 * never silently treated as "no shadow". Closed roots and inaccessible
 * frames are capability boundaries.
 */

import type { Epoch } from '../contracts.ts';

/** Budgets for bounded candidate evaluation (plan/07 §2 Discover selector). */
export const MAX_DISCOVER_MATCHES = 64;

export type ResolveOutcome =
  | { ok: true; node: Element; ref: string; rootId: string; predicates: TargetPredicates; evidenceRevision: number }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'stale' | 'unsupported'; detail: string };

export interface TargetPredicates {
  /** Declared tag — the only structural predicate applied on re-resolution. */
  tag: string;
  /** Author-declared role attribute or landmark approximation, when present. */
  role?: string;
  /** Declared roles are re-checked against the attribute; approximation
   *  roles are deterministic functions of the tag and re-derived there. */
  roleDeclared?: boolean;
  /** The ref's registered root. */
  rootId: string;
}

export interface ObservedRegistration {
  ref: string;
  rootId: string;
  node: Element;
  predicates: TargetPredicates;
  evidenceRevision: number;
  registeredAt: number;
}

export interface ResolvedTargetRegistry {
  /** Register one observed node under a fresh opaque ref. Idempotent per
   *  node+root within the same evidence revision. `roleDeclared` marks the
   *  role as an attribute predicate (re-checked on resolve) versus a
   *  landmark approximation (a pure function of the tag). */
  register(node: Element, rootId: string, role: string | undefined, evidenceRevision: number, roleDeclared?: boolean): string;
  /** A2 session-instance path: accept only the recorded connected node with
   *  its declared predicates unchanged. */
  resolve(ref: string, epoch: Epoch): ResolveOutcome;
  /** A2 discovery: syntax-validated selector, root-local, bounded candidate
   *  count — for observation only, never mutation. Zero matches is a
   *  missing outcome; candidate-cap hit reports ambiguity, never a first
   *  match. Returns found refs plus their nodes. */
  discover(rootId: string, selector: string, epoch: Epoch): { ok: true; matches: Array<{ ref: string; node: Element }> } | { ok: false; reason: 'unsupported' | 'missing'; detail: string };
  /** Register a root (document or open ShadowRoot). Returns its rootId. */
  registerRoot(root: Document | ShadowRoot): string;
  roots(): Array<{ rootId: string; kind: 'document' | 'shadow-root' }>;
  /** Drop everything (document teardown). */
  dispose(): void;
  size(): number;
}

const REF_PREFIX = 't';

export function createTargetRegistry(now: () => number = () => Date.now()): ResolvedTargetRegistry {
  const nodesToRefs = new WeakMap<Element, ObservedRegistration>();
  const refsToRecords = new Map<string, ObservedRegistration>();
  const rootsToIds = new WeakMap<Document | ShadowRoot, string>();
  const rootRecords: Array<{ rootId: string; root: Document | ShadowRoot; kind: 'document' | 'shadow-root' }> = [];
  let refSeq = 0;
  let rootSeq = 0;

  const registry: ResolvedTargetRegistry = {
    registerRoot(root) {
      const existing = rootsToIds.get(root);
      if (existing) return existing;
      const seq = ++rootSeq;
      // The first registered root is the document root in production and
      // carries the stable id 'document'; further roots are shadow roots.
      const rootId = seq === 1 ? 'document' : `root-${seq}`;
      rootsToIds.set(root, rootId);
      // nodeType 11 = DocumentFragment (ShadowRoot); avoids referencing the
      // ShadowRoot global, which does not exist in plain Node test runs.
      rootRecords.push({ rootId, root, kind: root.nodeType === 11 ? 'shadow-root' : 'document' });
      return rootId;
    },

    roots: () => rootRecords.map((r) => ({ rootId: r.rootId, kind: r.kind })),

    register(node, rootId, role, evidenceRevision, roleDeclared) {
      const existing = nodesToRefs.get(node);
      if (existing && existing.rootId === rootId && existing.evidenceRevision === evidenceRevision) {
        return existing.ref;
      }
      const ref = `${REF_PREFIX}${++refSeq}`;
      const predicates: TargetPredicates = {
        tag: node.tagName.toLowerCase(),
        ...(role !== undefined && role !== ''
          ? { role, ...(roleDeclared ? { roleDeclared: true } : { roleDeclared: false }) }
          : {}),
        rootId,
      };
      const record: ObservedRegistration = { ref, rootId, node, predicates, evidenceRevision, registeredAt: now() };
      nodesToRefs.set(node, record);
      refsToRecords.set(ref, record);
      return ref;
    },

    resolve(ref, epoch) {
      const record = refsToRecords.get(ref);
      if (!record) {
        return { ok: false, reason: 'missing', detail: `targetRef "${ref}" was never observed in this session` };
      }
      // Same root, same document lifetime, connected, declared tag/role
      // unchanged. A recorded node that disconnected WAS observed and is now
      // stale evidence (plan/07 §3: gone exact node fails the session op) —
      // distinct from a never-observed ref ('missing').
      if (!record.node.isConnected) {
        return { ok: false, reason: 'stale', detail: 'the observed node is no longer connected' };
      }
      const currentRootId = rootsToIds.get(record.node.getRootNode() as Document | ShadowRoot);
      if (currentRootId !== record.predicates.rootId || record.predicates.rootId !== record.rootId) {
        return { ok: false, reason: 'stale', detail: 'the observed node left its registered root', };
      }
      const tag = record.node.tagName.toLowerCase();
      if (tag !== record.predicates.tag) {
        return { ok: false, reason: 'stale', detail: `declared tag changed: ${record.predicates.tag} → ${tag}` };
      }
      // Declared roles are re-checked against the attribute. Approximation
      // roles are pure functions of the tag — the tag check above already
      // re-derives them (plan/07 §3: declared facts are the predicates).
      if (record.predicates.roleDeclared) {
        const currentRole = record.node.getAttribute('role') ?? undefined;
        if (record.predicates.role !== currentRole) {
          return { ok: false, reason: 'stale', detail: `declared role changed: ${record.predicates.role ?? 'none'} → ${currentRole ?? 'none'}` };
        }
      }
      // Route epoch check: the caller compares against the session epoch;
      // the registry records the evidence revision it was observed at.
      void epoch;
      return {
        ok: true,
        node: record.node,
        ref,
        rootId: record.rootId,
        predicates: { ...record.predicates },
        evidenceRevision: record.evidenceRevision,
      };
    },

    discover(rootId, selector, epoch) {
      void epoch;
      // Syntax-validated, bounded, root-local: the browser's querySelectorAll
      // is the only evaluator; a throw is reported as unsupported, never
      // downgraded to a first-match guess.
      const rootRecord = rootRecords.find((r) => r.rootId === rootId);
      if (!rootRecord) {
        return { ok: false, reason: 'unsupported', detail: `root "${rootId}" is not registered in this session` };
      }
      let matches: NodeList;
      try {
        matches = rootRecord.root.querySelectorAll(selector);
      } catch (err) {
        return { ok: false, reason: 'unsupported', detail: `invalid selector: ${(err as Error).message}` };
      }
      if (matches.length === 0) {
        return { ok: false, reason: 'missing', detail: `no matches for "${selector}" inside ${rootId}` };
      }
      if (matches.length > MAX_DISCOVER_MATCHES) {
        return { ok: false, reason: 'unsupported', detail: `${matches.length} matches exceed the ${MAX_DISCOVER_MATCHES}-candidate cap; narrow the hypothesis` };
      }
      return {
        ok: true,
        matches: Array.from(matches, (n) => {
          const node = n as Element;
          const record = nodesToRefs.get(node);
          const ref = record?.ref ?? registry.register(node, rootId, node.getAttribute('role') ?? undefined, 0, true);
          return { ref, node };
        }),
      };
    },

    dispose() {
      refsToRecords.clear();
      rootRecords.length = 0;
      // WeakMap entries are unreachable after teardown — no strong refs kept.
    },

    size: () => refsToRecords.size,
  };

  return registry;
}
