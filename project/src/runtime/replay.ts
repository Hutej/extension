/**
 * runtime/replay — continuity: route-aware replay of saved intent and
 * same-document reconciliation (plan/03 `runtime/reconcile`, plan/13 §4/§5/§6).
 *
 * Saved customizations arrive from the broker at registration (validated
 * records only — the runtime never touches storage). Replay runs each
 * enabled, in-scope customization through the SAME transaction path as an
 * initial apply (I14): resolve descriptors fresh → build a batch →
 * transaction.applyBatch → accepted (applied) or suspended. No provider
 * call, no historical action replay, no page refresh (I23).
 *
 * Per-customization live state is explicit and surfaced to workspaces
 * (plan/13 §4.5: never full success with missing coverage):
 *   applied | waiting (targets missing) | suspended (ambiguous/mismatch or
 *   verification rollback) | out-of-scope | paused (repeated conflict) |
 *   disabled | conflicted (release could not fully restore).
 *
 * Scope semantics (plan/13 §2): exactPath default; pathPrefix with slash
 * boundary; origin only with explicit approval; user-approved query/hash
 * discriminators are alternatives — any match admits the route, no automatic
 * wildcard over all query values.
 *
 * Reconciliation observes the document while anything is applied or waiting:
 * coalesced 100ms quiet / 500ms max passes with per-pass caps; a member loss
 * releases that member's resources; set growth re-applies the customization
 * once; a group pauses after two conflict cycles within 10s (plan/13 §5).
 */

import { LIMITS } from '../contracts.ts';
import type { Customization, RouteScope } from '../contracts.ts';
import { createTargetRegistry, type ResolvedTargetRegistry } from './targets.ts';
import type { BatchReceipt, Transaction } from './transaction.ts';

// ── route scope (pure, exported for tests) ───────────────────────────────

export function scopeMatches(scope: RouteScope, href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const path = url.pathname;
  if (scope.mode === 'exactPath') {
    if (scope.path === undefined || path !== scope.path) return false;
  } else if (scope.mode === 'pathPrefix') {
    const p = scope.path ?? '/';
    const base = p.endsWith('/') ? p : `${p}/`;
    if (path !== p && !path.startsWith(base)) return false;
  } // 'origin': every path on the origin
  const discriminators = scope.discriminators ?? [];
  if (discriminators.length === 0) return true;
  // Any approved discriminator admits the route (plan/13 §2) — exact
  // key+value matches only, never a wildcard over all query values.
  return discriminators.some((d) => {
    if (d.kind === 'query') return url.searchParams.get(d.key) === d.value;
    return url.hash === `#${d.value}`;
  });
}

// ── descriptor resolution (plan/04 §2) ───────────────────────────────────

export type DescriptorOutcome =
  | { ok: true; elements: Element[] }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'unsupported'; detail: string };

type DescriptorFailure = { ok: false; reason: 'missing' | 'ambiguous' | 'unsupported'; detail: string };

const MAX_CANDIDATE_SCAN = 500;

/** Predicate match for one element against one anchor spec. A hash is never
 *  identity (I15): predicates are observed tag/id/test-attribute/role/label. */
function matchesAnchor(el: Element, anchor: { tag?: string; stableId?: string; testAttribute?: { name: string; value: string }; role?: string; accessibleLabel?: string }): boolean {
  if (anchor.tag && el.tagName.toLowerCase() !== anchor.tag.toLowerCase()) return false;
  if (anchor.stableId !== undefined && el.id !== anchor.stableId) return false;
  if (anchor.testAttribute && el.getAttribute(anchor.testAttribute.name) !== anchor.testAttribute.value) return false;
  if (anchor.role !== undefined && el.getAttribute('role') !== anchor.role) return false;
  if (anchor.accessibleLabel !== undefined) {
    const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 300);
    if (label !== anchor.accessibleLabel) return false;
  }
  return true;
}

/** Extension-owned projection views are runtime UI, never descriptor
 *  evidence (S8.1): without this exclusion a projection's own nodes would
 *  join descriptor match sets and destabilize reconciliation (I15/I16). */
function isOwnView(el: Element): boolean {
  // closest is duck-typed (unit stubs implement the minimal element seam).
  const closest = (el as { closest?: (selector: string) => Element | null }).closest;
  return typeof closest === 'function' && closest.call(el, '[data-rv2p-view]') !== null;
}

/** Resolve the anchor element(s) of one descriptor inside its root scope. */
function resolveAnchors(scope: ParentNode, d: { anchor: { tag?: string; stableId?: string; testAttribute?: { name: string; value: string }; role?: string; accessibleLabel?: string } }): Element[] {
  const a = d.anchor;
  // Attribute-selector form (no CSS.escape dependency): the value is quoted
  // with backslash-escaped double quotes only — the strict predicate check
  // below re-verifies every candidate anyway.
  const quote = (v: string): string => v.replace(/[\\"]/g, '\\$&');
  if (a.stableId !== undefined) {
    const byId = scope.querySelector(`[id="${quote(a.stableId)}"]`);
    return byId && matchesAnchor(byId, a) && !isOwnView(byId) ? [byId] : [];
  }
  if (a.testAttribute) {
    return [...scope.querySelectorAll(`[${a.testAttribute.name}="${quote(a.testAttribute.value)}"]`)].filter((el) => matchesAnchor(el, a) && !isOwnView(el)).slice(0, MAX_CANDIDATE_SCAN);
  }
  const selector = a.tag ?? '*';
  let candidates: Element[] = [];
  try {
    candidates = [...scope.querySelectorAll(selector)];
  } catch {
    return [];
  }
  candidates = candidates.slice(0, MAX_CANDIDATE_SCAN);
  return candidates.filter((el) => matchesAnchor(el, a) && !isOwnView(el));
}

/** Target-side constraint: semantic guards describe the TARGET (plan/04 §2);
 *  the anchor predicates only locate the reference point. */
function matchesGuards(el: Element, guards?: { role?: string; controlType?: string; textDiscriminator?: string }): boolean {
  if (!guards) return true;
  if (guards.role !== undefined && el.getAttribute('role') !== guards.role) return false;
  if (guards.controlType !== undefined && (el as HTMLInputElement).type !== guards.controlType) return false;
  if (guards.textDiscriminator !== undefined && !(el.textContent ?? '').trim().includes(guards.textDiscriminator)) return false;
  return true;
}

/** Resolve one saved TargetDescriptor against the live document. Missing
 *  target → waiting; ambiguous/mismatch → suspended; never a guess (I15). */
export function resolveDescriptor(doc: Document, descriptor: { rootPath: string[]; selection: 'single' | 'set'; anchor: { tag?: string; stableId?: string; testAttribute?: { name: string; value: string }; role?: string; accessibleLabel?: string }; relation: 'self' | 'descendant' | 'direct-child' | 'sibling'; semanticGuards?: { role?: string; controlType?: string; textDiscriminator?: string }; matchBounds: { min: number; max: number } }): DescriptorOutcome {
  // rootPath: each open shadow host relative to the previous root. A closed
  // or absent shadow root is an explicit unsupported outcome (I26), never a
  // best-effort guess in the light DOM.
  let scope: ParentNode = doc;
  for (const hostSelector of descriptor.rootPath) {
    let host: Element | null = null;
    try {
      host = scope.querySelector(hostSelector);
    } catch {
      return { ok: false, reason: 'unsupported', detail: `rootPath segment "${hostSelector}" is not a valid selector` };
    }
    const inner = host?.shadowRoot;
    if (!inner) {
      return { ok: false, reason: 'unsupported', detail: `shadow root under "${hostSelector}" is closed or absent` };
    }
    scope = inner;
  }

  const anchors = resolveAnchors(scope, descriptor);
  if (anchors.length === 0) {
    return { ok: false, reason: 'missing', detail: 'no element matches the anchor predicates' };
  }

  const targets: Element[] = [];
  for (const anchor of anchors) {
    let found: Element[];
    switch (descriptor.relation) {
      case 'self':
        found = [anchor];
        break;
      case 'direct-child':
        found = [...anchor.children].filter((c) => matchesGuards(c, descriptor.semanticGuards) && !isOwnView(c));
        break;
      case 'sibling': {
        const parent = anchor.parentElement;
        found = parent ? [...parent.children].filter((c) => c !== anchor && matchesGuards(c, descriptor.semanticGuards) && !isOwnView(c)) : [];
        break;
      }
      case 'descendant':
        found = [...anchor.querySelectorAll('*')].slice(0, MAX_CANDIDATE_SCAN).filter((c) => matchesGuards(c, descriptor.semanticGuards) && !isOwnView(c));
        break;
    }
    targets.push(...found);
  }

  if (targets.length < descriptor.matchBounds.min) {
    return { ok: false, reason: 'missing', detail: `${targets.length} match(es), the descriptor requires at least ${descriptor.matchBounds.min}` };
  }
  if (descriptor.selection === 'single' && targets.length !== 1) {
    return { ok: false, reason: 'ambiguous', detail: `${targets.length} candidates match a single-target descriptor` };
  }
  return { ok: true, elements: targets.slice(0, descriptor.matchBounds.max) };
}

// ── replay state machine ─────────────────────────────────────────────────

export type CustomizationLiveState = 'applied' | 'waiting' | 'suspended' | 'out-of-scope' | 'paused' | 'disabled' | 'conflicted';

export interface ReplayEntry {
  customizationId: string;
  title: string;
  revisionId: string;
  state: CustomizationLiveState;
  /** Bounded public detail — never raw page content. */
  detail?: string;
}

export interface ReplayDeps {
  doc: Document;
  targets: ResolvedTargetRegistry;
  transaction: Transaction;
  href(): string;
  now(): number;
  randomId(): string;
  onStatesChanged(entries: ReplayEntry[]): void;
  /** Bounded settle wait between conflict re-checks (tests inject a no-op). */
  tick?(): Promise<void>;
}

const RECONCILE_QUIET_MS = 100;
const RECONCILE_MAX_WAIT_MS = 500;
const MAX_RECONCILED_PER_PASS = 32;
const PAUSE_AFTER_CONFLICTS = 2;
const PAUSE_WINDOW_MS = 10_000;

interface LiveEntry {
  customization: Customization;
  state: CustomizationLiveState;
  detail?: string;
  /** Resolved member refs the accepted batch was built from (set tracking). */
  memberRefs: string[];
  memberCount: number;
  rollbackTimes: number[];
}

export interface ReplayCore {
  /** Installed/waiting saved customizations (from the broker registration). */
  setApplicable(customizations: Customization[]): Promise<void>;
  /** Route epoch moved (broker-authoritative or local URL change). */
  onRouteChanged(): Promise<void>;
  /** Broker-relayed record updates (plan/13 §6). */
  setEnabled(customizationId: string, enabled: boolean): Promise<void>;
  removeCustomization(customizationId: string): Promise<void>;
  states(): ReplayEntry[];
  dispose(): void;
}

export function createReplay(deps: ReplayDeps): ReplayCore {
  const live = new Map<string, LiveEntry>();
  let observer: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt = 0;
  let disposed = false;

  const emit = (): void => {
    if (disposed) return;
    deps.onStatesChanged([...live.values()].map((e): ReplayEntry => ({
      customizationId: e.customization.customizationId,
      title: e.customization.title,
      revisionId: e.customization.activeRevisionId,
      state: e.state,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    })));
  };

  /** Descriptor-index target convention: a saved revision's operations
   *  reference `d<i>` = targetDescriptors[i]; replay rewrites them to fresh
   *  session refs after resolution. Unresolvable refs are rejected here —
   *  stale observation tokens can never reach the transaction. */
  const buildBatch = (entry: LiveEntry): { batch: Parameters<Transaction['applyBatch']>[0]; ruleCoverage?: string } | { fail: DescriptorFailure } => {
    const rev = entry.customization.revisions.find((r) => r.revisionId === entry.customization.activeRevisionId);
    if (!rev) return { fail: { ok: false, reason: 'unsupported', detail: 'the active revision is not stored on the record' } };
    const refMap = new Map<string, string>();
    const memberRefs: string[] = [];
    /** S7.2: descriptors referenced ONLY as a rule's affordance resolve
     *  RELATIVE to each instance — document-wide they are naturally
     *  ambiguous (one disclosure per instance) and must never gate the
     *  replay. */
    const affordanceOnly = new Set<number>();
    for (const op of rev.operations) {
      if (op.kind === 'localRule' && op.targetRef !== undefined) {
        const idx = Number.parseInt(op.targetRef.slice(1), 10);
        if (!Number.isNaN(idx)) affordanceOnly.add(idx);
      }
    }
    /** S7.2: per-descriptor member (ref, element) pairs, in resolution
     *  order — the rule expansion addresses each member individually. */
    const descriptorRefs: Array<Array<{ ref: string; el: Element }>> = [];
    for (let i = 0; i < rev.targetDescriptors.length; i++) {
      if (affordanceOnly.has(i)) {
        descriptorRefs.push([]);
        continue;
      }
      const outcome = resolveDescriptor(deps.doc, rev.targetDescriptors[i]);
      if (!outcome.ok) return { fail: outcome };
      const members: Array<{ ref: string; el: Element }> = [];
      for (const el of outcome.elements) {
        const ref = deps.targets.register(el, deps.targets.roots()[0]?.rootId ?? deps.targets.registerRoot(deps.doc), rev.targetDescriptors[i].anchor.role, deps.now(), rev.targetDescriptors[i].anchor.role !== undefined);
        refMap.set(`d${i}`, ref);
        memberRefs.push(ref);
        members.push({ ref, el });
      }
      descriptorRefs.push(members);
    }
    const rewritten: Parameters<Transaction['applyBatch']>[0]['operations'] = [];
    let ruleCoverage: string | undefined;
    for (const op of rev.operations) {
      const clone = structuredClone(op) as typeof op;
      // Every op kind carries its site targets in one of these slots (plan/04
      // §3 grammar). Local refs (insertUI/localRef) stay untouched.
      const retarget = (t?: { targetRef?: string; localRef?: string }): void => {
        if (t?.targetRef !== undefined) {
          const mapped = refMap.get(t.targetRef);
          if (mapped === undefined) throw new Error(`saved operation references unknown descriptor "${t.targetRef}"`);
          t.targetRef = mapped;
        }
      };
      switch (clone.kind) {
        case 'style':
          for (const rule of clone.rules) retarget(rule.target);
          break;
        case 'hide':
        case 'collapse':
        case 'float':
        case 'replaceText':
        case 'insertUI':
          retarget(clone.target);
          break;
        case 'projectCollection': {
          retarget(clone.target);
          const mappedSet = refMap.get(clone.sourceSetRef);
          if (mappedSet === undefined) throw new Error(`saved operation references unknown descriptor "${clone.sourceSetRef}"`);
          clone.sourceSetRef = mappedSet;
          break;
        }
        case 'bindKey':
          retarget(clone.target);
          break;
        case 'relocate':
          retarget(clone.target);
          retarget(clone.destination);
          break;
        case 'localRule': {
          // S7.2: the rule's saved target is a future-set descriptor — the
          // rule expands to ONE op per current member, each with its own
          // affordance resolved RELATIVE to that member (the same validated
          // anchor semantics, never a guessed selector). Member growth is
          // picked up by the next reconcile pass (release + re-apply); the
          // behavior engine's sticky once-per-instance state keeps user
          // overrides intact across re-applies.
          if (clone.target.targetRef === undefined) throw new Error('a saved rule must reference a descriptor');
          const instanceDescriptorIndex = Number.parseInt(clone.target.targetRef.slice(1), 10);
          const members = descriptorRefs[instanceDescriptorIndex] ?? [];
          let affordanceDescriptor: Parameters<typeof resolveDescriptor>[1] | null = null;
          if (clone.targetRef !== undefined) {
            const affIndex = Number.parseInt(clone.targetRef.slice(1), 10);
            const saved = rev.targetDescriptors[affIndex];
            if (!saved) throw new Error(`saved rule references unknown affordance descriptor "${clone.targetRef}"`);
            // Relative form: resolve WITHIN each member instance.
            affordanceDescriptor = { ...saved, rootPath: [], relation: 'self' };
          }
          let expanded = 0;
          for (const member of members) {
            if (rewritten.length >= LIMITS.maxOperations) break;
            let affordanceRef: string | undefined;
            if (affordanceDescriptor) {
              const aff = resolveDescriptor(member.el as unknown as Document, affordanceDescriptor);
              if (!aff.ok || aff.elements.length !== 1) continue; // ambiguous/missing affordance: instance is skipped honestly
              const affRef = deps.targets.register(aff.elements[0], deps.targets.roots()[0]?.rootId ?? deps.targets.registerRoot(deps.doc), undefined, deps.now(), false);
              affordanceRef = affRef;
            }
            const predicates = (clone.predicates ?? []).map((p) =>
              p.type === 'member-of'
                ? { ...p, targetRef: refMap.get(p.targetRef) ?? p.targetRef }
                : p,
            );
            rewritten.push({ ...clone, target: { targetRef: member.ref }, ...(affordanceRef !== undefined ? { targetRef: affordanceRef } : {}), ...(clone.predicates !== undefined ? { predicates } : {}) });
            expanded += 1;
          }
          if (members.length > expanded) {
            ruleCoverage = `rule expanded to ${expanded} of ${members.length} matching instances (batch limit)`;
          }
          entry.memberRefs = memberRefs;
          continue; // already pushed expanded forms
        }
      }
      rewritten.push(clone);
    }
    entry.memberRefs = memberRefs;
    entry.memberCount = memberRefs.length;
    return {
      batch: {
        batchId: `replay:${entry.customization.customizationId}:${rev.revisionId}`,
        customizationId: entry.customization.customizationId,
        revisionId: rev.revisionId,
        operations: rewritten,
      },
      ...(ruleCoverage !== undefined ? { ruleCoverage } : {}),
    };
  };

  const conflictsRecently = (entry: LiveEntry): boolean => {
    const now = deps.now();
    entry.rollbackTimes = entry.rollbackTimes.filter((t) => now - t < PAUSE_WINDOW_MS);
    return entry.rollbackTimes.length >= PAUSE_AFTER_CONFLICTS;
  };

  const replayEntry = async (entry: LiveEntry): Promise<void> => {
    const rev = entry.customization.revisions.find((r) => r.revisionId === entry.customization.activeRevisionId);
    if (!rev) {
      entry.state = 'suspended';
      entry.detail = 'the active revision is not stored on the record';
      emit();
      return;
    }
    if (!scopeMatches(entry.customization.scope, deps.href())) {
      if (entry.state === 'applied') await releaseEntry(entry);
      entry.state = 'out-of-scope';
      entry.detail = undefined;
      emit();
      return;
    }
    let built: ReturnType<typeof buildBatch>;
    try {
      built = buildBatch(entry);
    } catch (err) {
      if (entry.state === 'applied') await releaseEntry(entry);
      entry.state = 'suspended';
      entry.detail = err instanceof Error ? err.message.slice(0, 200) : 'the saved revision could not be materialized';
      emit();
      return;
    }
    if ('fail' in built) {
      if (entry.state === 'applied') await releaseEntry(entry);
      entry.state = built.fail.reason === 'missing' ? 'waiting' : 'suspended';
      entry.detail = built.fail.detail;
      emit();
      return;
    }
    const receipt: BatchReceipt = await deps.transaction.applyBatch(built.batch);
    if (receipt.status === 'accepted') {
      entry.state = 'applied';
      // S7.2: honest partial rule coverage (batch-limited expansion) —
      // never full success with missing coverage (plan/13 §4.5).
      entry.detail = built.ruleCoverage;
    } else {
      entry.rollbackTimes.push(deps.now());
      if (entry.state === 'applied' || conflictsRecently(entry)) {
        entry.state = conflictsRecently(entry) ? 'paused' : 'suspended';
        entry.detail = receipt.error?.message ?? receipt.conflicts?.[0] ?? `replay rolled back (${receipt.status})`;
      } else {
        entry.state = 'suspended';
        entry.detail = receipt.error?.message ?? receipt.conflicts?.[0] ?? `replay rolled back (${receipt.status})`;
      }
    }
    emit();
  };

  const releaseEntry = async (entry: LiveEntry): Promise<void> => {
    const receipt = await deps.transaction.releaseCustomization(entry.customization.customizationId);
    entry.memberRefs = [];
    if (receipt.status === 'conflicted') {
      entry.state = 'conflicted';
      entry.detail = receipt.conflicts?.[0] ?? 'release left conflicts visible';
    }
  };

  const replayAll = async (only?: string): Promise<void> => {
    for (const entry of live.values()) {
      if (disposed) return;
      if (only !== undefined && entry.customization.customizationId !== only) continue;
      if (entry.state === 'paused') continue; // visible pause needs a user/route action to clear
      if (!entry.customization.enabled) {
        if (entry.state === 'applied') await releaseEntry(entry);
        entry.state = 'disabled';
        continue;
      }
      await replayEntry(entry);
    }
    emit();
  };

  // ── same-document reconciliation (plan/13 §5) ──────────────────────────

  const scheduleReconcile = (): void => {
    if (disposed || debounceTimer !== null) return;
    firstDirtyAt = firstDirtyAt || deps.now();
    const wait = Math.max(0, Math.min(RECONCILE_QUIET_MS, RECONCILE_MAX_WAIT_MS - (deps.now() - firstDirtyAt)));
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      firstDirtyAt = 0;
      void reconcilePass();
    }, wait);
  };

  const reconcilePass = async (): Promise<void> => {
    if (disposed) return;
    let budget = MAX_RECONCILED_PER_PASS;
    for (const entry of live.values()) {
      if (budget <= 0) return; // honest partial: remaining entries wait for the next pass
      if (entry.state !== 'applied') continue;
      budget -= 1;
      // Revalidate the customization's resolved members against the live
      // document (descriptor predicates, not a hash — I15).
      const rev = entry.customization.revisions.find((r) => r.revisionId === entry.customization.activeRevisionId);
      if (!rev) continue;
      let missingAll = true;
      let memberCount = 0;
      for (const descriptor of rev.targetDescriptors) {
        const outcome = resolveDescriptor(deps.doc, descriptor);
        if (outcome.ok) {
          missingAll = false;
          memberCount += outcome.elements.length;
        }
      }
      if (missingAll) {
        // Every target vanished: release owned resources, wait for return.
        await releaseEntry(entry);
        entry.state = 'waiting';
        entry.detail = 'the customization targets are not on the page right now';
        emit();
        continue;
      }
      if (memberCount !== entry.memberCount) {
        // Membership changed: desired-state re-apply once (the same
        // validated intent, fresh resolution — no inference). A rollback
        // here counts toward the conflict pause.
        await releaseEntry(entry);
        if ((entry.state as CustomizationLiveState) === 'conflicted') { emit(); continue; }
        await replayEntry(entry);
      }
    }
  };

  const startObserving = (): void => {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(() => {
      if (disposed) return;
      // Self-writes are filtered by the transaction's own dedupe (same-batch
      // replay receipts); coalescing bounds the pass rate (plan/06 §5).
      scheduleReconcile();
    });
    observer.observe(deps.doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'id'] });
  };

  return {
    async setApplicable(customizations) {
      const seen = new Set<string>();
      for (const customization of customizations) {
        seen.add(customization.customizationId);
        const existing = live.get(customization.customizationId);
        if (existing && existing.customization.activeRevisionId === customization.activeRevisionId && existing.state === 'applied') {
          existing.customization = customization; // refresh record metadata
          continue; // same intent already live — never re-apply (no duplicate widgets)
        }
        const entry: LiveEntry = existing ?? {
          customization,
          state: customization.enabled ? 'waiting' : 'disabled',
          memberRefs: [],
          memberCount: 0,
          rollbackTimes: [],
        };
        entry.customization = customization;
        live.set(customization.customizationId, entry);
        await replayAll(customization.customizationId);
      }
      // Records removed elsewhere: drop local state and release leftovers.
      for (const [id, entry] of live) {
        if (!seen.has(id)) {
          if (entry.state === 'applied') await releaseEntry(entry);
          live.delete(id);
        }
      }
      emit();
      startObserving();
    },
    async onRouteChanged() {
      await replayAll();
    },
    async setEnabled(customizationId, enabled) {
      const entry = live.get(customizationId);
      if (!entry) return;
      entry.customization = { ...entry.customization, enabled };
      if (entry.state === 'paused') entry.state = enabled ? 'waiting' : 'disabled';
      await replayAll(customizationId);
    },
    async removeCustomization(customizationId) {
      const entry = live.get(customizationId);
      if (!entry) return;
      if (entry.state === 'applied') await releaseEntry(entry);
      live.delete(customizationId);
      emit();
    },
    states: () => [...live.values()].map((e): ReplayEntry => ({
      customizationId: e.customization.customizationId,
      title: e.customization.title,
      revisionId: e.customization.activeRevisionId,
      state: e.state,
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    })),
    dispose() {
      disposed = true;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      observer?.disconnect();
      observer = null;
    },
  };
}

/** Convenience: a registry for replay target registration (re-exports the
 *  real factory so unit tests can build the exact production shape). */
export const createReplayTargetRegistry = createTargetRegistry;
