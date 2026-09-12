/**
 * runtime/projection — linked alternative views (S8.1, plan/03
 * `runtime/projection`, plan/09 §4, algorithm A10).
 *
 * A projection is an extension-owned representation of OBSERVED source items,
 * linked to the live original (I25): the website stays source of truth; the
 * view owns only layout, grouping and explicit local organization.
 *
 * Hard semantics (plan/09 §4):
 *   - Every rendered string/link is extracted from the source item's DOM at
 *     render time through a finite field catalog (title/label/link/category)
 *     — never source innerHTML, never invented application state (I18/I25).
 *   - The stable item key is the origin-relative canonical link without
 *     sensitive query parameters; items without a usable link fall back to a
 *     session-only identity. A recycled row is a NEW item: local buckets
 *     follow the item key, never a DOM position.
 *   - Duplicate source keys disable the key-based action (the link) and mark
 *     the cards stale; a detached source item is marked stale and its reveal
 *     action disables. Nothing is auto-removed merely for going stale.
 *   - A board move is LOCAL organization only — the source DOM is never
 *     touched. Grouping follows observed categories; the user's explicit
 *     bucket assignment wins over later field changes (the S7.2 user-override
 *     rule applied to projections).
 *   - At most 200 rendered items with a loaded/total coverage line;
 *     pagination first ("Show more"), no virtualization.
 *   - "Show original" reveals the live source item (scrollIntoView) without
 *     destroying the projection configuration.
 *
 * The view is built with native DOM APIs only and carries one runtime-authored
 * stylesheet (constant strings — no model CSS, no network values). Source
 * updates are observed with ONE observer on the source container and applied
 * in bounded slices; the source DOM is never written.
 */

import { LIMITS, redactSensitiveText, PROJECTION_SOURCE_FIELDS, type ProjectionSourceField } from '../contracts.ts';

// ── bounded field extraction (pure, unit-tested) ─────────────────────────

export { PROJECTION_SOURCE_FIELDS };
export type { ProjectionSourceField };

/** Render cap (plan/09 §4: at most 200 rendered items; paginate first). */
export const RENDER_CAP = 200;
export const PAGE_SIZE = 50;
export const UNSORTED_COLUMN = 'Unsorted';

/** Query parameters never kept in a stable item key (plan/09 §4). */
const SENSITIVE_PARAM = /^(token|session|sid|auth|secret|jwt|access_token|api_key|api-key|key|code|state)$/i;

/** Explicit site-declared category markers, in priority order. */
const CATEGORY_ATTRS = ['data-status', 'data-state', 'data-label', 'data-priority'] as const;

export function canonicalKeyOf(href: string, baseOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  for (const [k] of url.searchParams) if (SENSITIVE_PARAM.test(k)) url.searchParams.delete(k);
  url.hash = ''; // a fragment is presentation, not item identity
  return url.origin === baseOrigin ? `${url.pathname}${url.search}` : url.href;
}

export interface ExtractedFields {
  title: string;
  label: string | null;
  link: string | null;
  /** Resolved absolute http(s) href for rendering; null when absent/unsafe. */
  category: string | null;
}

/** Extract the requested observed fields from one source item. Title falls
 *  back through aria-label to own text; links must be http(s) and resolve
 *  against the item's document. */
export function extractFields(item: Element, fields: readonly ProjectionSourceField[]): ExtractedFields {
  const want = new Set<string>(fields);
  const out: ExtractedFields = { title: '', label: null, link: null, category: null };
  if (want.has('title')) {
    // The item's own link text is the best title evidence in list rows; the
    // full text is the fallback. Whitespace collapses for display.
    const a = item.matches('a') ? item : item.querySelector('a');
    const own = ((a?.textContent ?? '') || (item.textContent ?? '') || item.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    out.title = redactSensitiveText(own.slice(0, 200));
  }
  if (want.has('label')) {
    const raw = item.getAttribute('aria-label') ?? item.getAttribute('title');
    out.label = raw ? redactSensitiveText(raw.trim().slice(0, 120)) : null;
  }
  if (want.has('link')) {
    const a = item.matches('a[href]') ? item : item.querySelector('a[href]');
    const raw = a?.getAttribute('href') ?? null;
    if (raw) {
      try {
        const resolved = new URL(raw, item.ownerDocument?.URL ?? undefined);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') out.link = resolved.href;
      } catch { /* unresolvable href: no link field */ }
    }
  }
  if (want.has('category')) {
    for (const attr of CATEGORY_ATTRS) {
      // The explicit marker sits on the item or on a dedicated badge inside it.
      const holder = item.hasAttribute(attr) ? item : item.querySelector(`[${attr}]`);
      const v = holder?.getAttribute(attr);
      if (v !== null && v !== undefined && v.trim() !== '') {
        out.category = redactSensitiveText(v.trim().slice(0, 64));
        break;
      }
    }
  }
  return out;
}

// ── local organization (session-scoped, survives re-applies) ─────────────

interface LocalOrganization {
  /** display key → user-chosen column. */
  buckets: Map<string, string>;
  /** display key → move sequence (moved items sort after unmoved ones). */
  seq: Map<string, number>;
  counter: number;
}

/** Session-scoped per-customization local organization. Kept across
 *  release/re-apply/re-enable so the user's arrangement survives the same
 *  reconciliation cycles as S7.2's once-per-instance state. Bounded by the
 *  64-revision document cap × ≤200 keys. */
const organizations = new Map<string, LocalOrganization>();

export function organizationFor(customizationId: string): LocalOrganization {
  let org = organizations.get(customizationId);
  if (!org) {
    org = { buckets: new Map(), seq: new Map(), counter: 0 };
    organizations.set(customizationId, org);
  }
  return org;
}

// ── column planning (pure, unit-tested) ──────────────────────────────────

export interface ColumnPlan {
  columns: string[];
  /** The column an item displays in: the user's bucket when that column
   *  exists, else the observed category, else Unsorted. */
  displayOf(category: string | null, bucket: string | null): string;
}

/** Board columns: observed categories in first-appearance order, then
 *  Unsorted, then user-created columns. Everything unknown folds into
 *  Unsorted — never an invented column set. */
export function planColumns(observedCategories: string[], orgColumns: string[], cap: number): ColumnPlan {
  const columns: string[] = [];
  const push = (c: string): void => {
    if (columns.length < cap && !columns.includes(c)) columns.push(c);
  };
  for (const c of observedCategories) push(c);
  push(UNSORTED_COLUMN);
  for (const c of orgColumns) push(c);
  return {
    columns,
    displayOf(category, bucket) {
      if (bucket !== null && columns.includes(bucket)) return bucket;
      if (category !== null && columns.includes(category)) return category;
      return columns.includes(UNSORTED_COLUMN) ? UNSORTED_COLUMN : columns[columns.length - 1] ?? UNSORTED_COLUMN;
    },
  };
}

// ── view construction ────────────────────────────────────────────────────

export interface ProjectionSpec {
  customizationId: string;
  view: 'list' | 'grid' | 'board';
  fields: Array<{ sourceField: ProjectionSourceField; label: string }>;
  groupBy?: 'category';
  order: 'source' | 'manual';
  showOriginal: boolean;
}

export interface ProjectionHandle {
  root: HTMLElement;
  /** Attach the source observer + interaction listeners (write section). */
  connect(): void;
  /** Disconnect the source observer. Owned-node listeners die with the
   *  tree; the local organization is session state and survives. */
  dispose(): void;
  itemCount(): number;
  staleCount(): number;
  coverageText(): string;
}

/** Runtime-authored stylesheet for the owned view — constant strings, no
 *  model CSS, no network values (I18). */
const VIEW_CSS = `
.rv2p { display: block; margin: 8px 0; padding: 8px 10px; border: 1px solid rgba(127,127,127,0.55); border-radius: 8px; font: 14px/1.45 system-ui, sans-serif; background: rgba(127,127,127,0.07); }
.rv2p-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
.rv2p-name { font-weight: 600; }
.rv2p-coverage, .rv2p-hint { opacity: 0.75; font-size: 12px; }
.rv2p-cols { display: flex; gap: 8px; overflow-x: auto; align-items: flex-start; }
.rv2p-col { flex: 1 1 0; min-width: 170px; background: rgba(127,127,127,0.09); border-radius: 6px; padding: 6px; }
.rv2p-col-name { font-size: 13px; margin: 0 0 6px; font-weight: 600; }
.rv2p-col-cards { display: flex; flex-direction: column; gap: 6px; min-height: 20px; }
.rv2p-col-cards.rv2p-drop { outline: 2px dashed rgba(127,127,127,0.8); outline-offset: 2px; }
.rv2p-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.rv2p-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rv2p-card { display: block; border: 1px solid rgba(127,127,127,0.5); border-radius: 6px; padding: 6px 8px; background: Canvas; color: CanvasText; }
.rv2p-card[draggable="true"] { cursor: grab; }
.rv2p-card.rv2p-is-stale { opacity: 0.65; }
.rv2p-stale-note { display: block; color: #b45309; font-size: 12px; }
.rv2p-title { font-weight: 600; color: inherit; }
.rv2p-badge { display: inline-block; font-size: 11px; border: 1px solid rgba(127,127,127,0.5); border-radius: 999px; padding: 0 6px; margin-left: 6px; }
.rv2p-actions { display: flex; gap: 6px; margin-top: 4px; align-items: center; flex-wrap: wrap; }
.rv2p-actions button, .rv2p-actions select { font: inherit; font-size: 12px; }
.rv2p-more { font: inherit; font-size: 13px; margin-top: 8px; }
`;

interface ItemState {
  el: Element;
  root: HTMLElement;
  title: HTMLElement;
  badge: HTMLSpanElement | null;
  staleNote: HTMLSpanElement;
  reveal: HTMLButtonElement;
  move: HTMLSelectElement | null;
  key: string | null;
  sessionKey: string;
  linkHref: string | null;
  category: string | null;
  stale: string | null;
}

const sessionIds = new WeakMap<Element, string>();
let sessionSeq = 0;
const sessionIdOf = (el: Element): string => {
  let id = sessionIds.get(el);
  if (id === undefined) {
    sessionSeq += 1;
    id = `s${sessionSeq}`;
    sessionIds.set(el, id);
  }
  return id;
};

export interface ProjectionDeps {
  doc: Document;
}

/** Create the owned projection view DETACHED for one source container.
 *  The source container's direct element children are the items. */
export function createProjection(deps: ProjectionDeps, spec: ProjectionSpec, container: Element): ProjectionHandle {
  const doc = deps.doc;
  const org = organizationFor(spec.customizationId);
  const fieldNames = spec.fields.map((f) => f.sourceField);
  const baseOrigin = (() => {
    try {
      return new URL(doc.URL ?? 'about:blank').origin;
    } catch {
      return 'null';
    }
  })();
  const isBoard = spec.view === 'board';
  const items: ItemState[] = [];
  /** Last extracted category per source element — the board plan reads it
   *  before/while cards are built (build order must not decide columns). */
  const categoryCache = new Map<Element, string | null>();
  let connected = false;
  let observer: MutationObserver | null = null;
  let flushQueued = false;
  /** Pending work: re-extractions + additions/deletions, applied in one slice. */
  const dirtyItems = new Set<ItemState>();
  const addedEls = new Set<Element>();
  const removedEls = new Set<Element>();

  // ── view skeleton ──────────────────────────────────────────────────────
  // A neutral div (region role, labeled): never a landmark/heading/content
  // tag that site descriptors could anchor on.
  const root = doc.createElement('div');
  root.className = 'rv2p';
  root.setAttribute('data-rv2p-view', '1');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', `Revueon linked ${spec.view}`);

  const style = doc.createElement('style');
  style.textContent = VIEW_CSS;
  root.appendChild(style);

  const head = doc.createElement('div');
  head.className = 'rv2p-head';
  const name = doc.createElement('strong');
  name.className = 'rv2p-name';
  name.textContent = `Linked ${spec.view}`;
  const coverage = doc.createElement('span');
  coverage.className = 'rv2p-coverage';
  coverage.setAttribute('data-rv2p-coverage', '1');
  head.append(name, coverage);
  if (isBoard) {
    const hint = doc.createElement('span');
    hint.className = 'rv2p-hint';
    hint.textContent = 'Moving items changes your local view only — the site stays unchanged';
    head.append(hint);
  }
  root.appendChild(head);

  const body = doc.createElement(spec.view === 'list' ? 'ul' : 'div');
  body.className = spec.view === 'list' ? 'rv2p-list' : 'rv2p-grid';
  root.appendChild(body);
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'rv2p-more';
  more.textContent = 'Show more';
  root.appendChild(more);

  /** All source items currently loaded (bounded scan). */
  const loadedElements = (): Element[] => [...container.children].filter((c) => c.nodeType === 1).slice(0, RENDER_CAP);
  let renderedCount = 0;

  const displayKeyOf = (it: { key: string | null; sessionKey: string }): string => (it.key !== null ? `k:${it.key}` : `s:${it.sessionKey}`);

  const columnsFor = (): ColumnPlan => {
    if (!isBoard) return { columns: [], displayOf: () => '' };
    const observed: string[] = [];
    for (const el of loadedElements()) {
      const c = categoryCache.get(el) ?? null;
      if (c !== null && !observed.includes(c)) observed.push(c);
    }
    const orgCols: string[] = [];
    for (const b of org.buckets.values()) if (!orgCols.includes(b)) orgCols.push(b);
    return planColumns(observed, orgCols, LIMITS.maxCollectionFields + 4);
  };

  let columnBodies = new Map<string, HTMLElement>();

  const buildBoardBodies = (): void => {
    const plan = columnsFor();
    const cols = doc.createElement('div');
    cols.className = 'rv2p-cols';
    columnBodies = new Map();
    for (const colName of plan.columns) {
      const col = doc.createElement('div');
      col.className = 'rv2p-col';
      col.setAttribute('data-rv2p-col', colName);
      const h = doc.createElement('h4');
      h.className = 'rv2p-col-name';
      h.textContent = colName;
      const cards = doc.createElement('div');
      cards.className = 'rv2p-col-cards';
      col.append(h, cards);
      cols.appendChild(col);
      columnBodies.set(colName, cards);
    }
    body.replaceChildren(cols);
  };

  const listBodyFor = (): HTMLElement => {
    if (isBoard) {
      if (columnBodies.size === 0) buildBoardBodies();
      return columnBodies.get(UNSORTED_COLUMN) ?? columnBodies.values().next().value!;
    }
    return body;
  };

  // ── card construction / patching ───────────────────────────────────────

  const buildCard = (el: Element, fields: ExtractedFields, column: string): ItemState => {
    const card = doc.createElement(spec.view === 'list' ? 'li' : isBoard ? 'article' : 'div');
    card.className = 'rv2p-card';
    card.setAttribute('data-rv2p-card', '1');
    if (isBoard) card.draggable = true;

    const title = doc.createElement(fields.link !== null ? 'a' : 'span');
    title.className = 'rv2p-title';
    let badge: HTMLSpanElement | null = null;
    if (fields.category !== null && fieldNames.includes('category')) {
      badge = doc.createElement('span');
      badge.className = 'rv2p-badge';
      badge.textContent = fields.category;
    }
    const staleNote = doc.createElement('span');
    staleNote.className = 'rv2p-stale-note';
    const actions = doc.createElement('div');
    actions.className = 'rv2p-actions';
    const reveal = doc.createElement('button');
    reveal.type = 'button';
    reveal.className = 'rv2p-reveal';
    reveal.textContent = 'Show original';
    reveal.setAttribute('aria-label', `Show original for: ${fields.title.slice(0, 80)}`);
    reveal.addEventListener('click', () => {
      if (el.isConnected) el.scrollIntoView({ block: 'center' });
    });
    actions.appendChild(reveal);
    let move: HTMLSelectElement | null = null;
    if (isBoard) {
      move = doc.createElement('select');
      move.setAttribute('aria-label', 'Move item to column');
      move.addEventListener('change', () => {
        moveToColumn(itemByCard.get(card)!, move!.value);
      });
      actions.appendChild(move);
    }
    card.append(title, ...(badge ? [badge] : []), staleNote, actions);

    const sessionKey = sessionIdOf(el);
    const state: ItemState = {
      el,
      root: card,
      title,
      badge,
      staleNote,
      reveal,
      move,
      key: fields.link !== null ? canonicalKeyOf(fields.link, baseOrigin) : null,
      sessionKey,
      linkHref: fields.link,
      category: fields.category,
      stale: null,
    };
    itemByCard.set(card, state);
    patchCard(state, fields, column);
    return state;
  };

  const patchCard = (it: ItemState, fields: ExtractedFields, column: string): void => {
    categoryCache.set(it.el, fields.category);
    // Title: a real link only when the source link is safe and unambiguous.
    const href = it.stale === 'duplicate source link' ? null : it.linkHref;
    if (href !== null) {
      if (it.title.tagName !== 'A') {
        const a = doc.createElement('a');
        a.className = 'rv2p-title';
        it.title.replaceWith(a);
        it.title = a;
      }
      (it.title as HTMLAnchorElement).href = href;
      (it.title as HTMLAnchorElement).textContent = fields.title;
    } else {
      if (it.title.tagName !== 'SPAN') {
        const span = doc.createElement('span');
        span.className = 'rv2p-title';
        it.title.replaceWith(span);
        it.title = span;
      }
      it.title.textContent = fields.title;
    }
    if (it.badge) it.badge.textContent = fields.category ?? '';
    it.reveal.disabled = !it.el.isConnected;
    if (it.move) {
      const plan = columnsFor();
      it.move.replaceChildren();
      for (const c of plan.columns) {
        const o = doc.createElement('option');
        o.value = c;
        o.textContent = c;
        it.move.appendChild(o);
      }
      it.move.value = column;
    }
    it.staleNote.textContent = it.stale ?? '';
    it.root.classList.toggle('rv2p-is-stale', it.stale !== null);
  };

  const reextract = (it: ItemState): ExtractedFields => {
    const fields = extractFields(it.el, fieldNames);
    it.key = fields.link !== null ? canonicalKeyOf(fields.link, baseOrigin) : null;
    it.linkHref = fields.link;
    it.category = fields.category;
    return fields;
  };

  const columnOf = (it: ItemState): string => {
    if (!isBoard) return '';
    const plan = columnsFor();
    return plan.displayOf(it.category, org.buckets.get(displayKeyOf(it)) ?? null);
  };

  const place = (it: ItemState): void => {
    const target = isBoard ? (columnBodies.get(columnOf(it)) ?? listBodyFor()) : body;
    target.appendChild(it.root);
  };

  const moveToColumn = (it: ItemState, column: string): void => {
    org.buckets.set(displayKeyOf(it), column);
    org.seq.set(displayKeyOf(it), ++org.counter);
    // Re-place into the (possibly new) column; refresh every move select so
    // the option lists stay in sync with the current column set.
    if (!columnBodies.has(column)) buildBoardBodies();
    place(it);
    for (const other of items) {
      if (other.move && other.root.isConnected) other.move.value = columnOf(other);
    }
  };

  /** Re-evaluate duplicate-key staleness over connected items. */
  const refreshDuplicates = (): void => {
    const byKey = new Map<string, ItemState[]>();
    for (const it of items) {
      if (it.key === null || !it.el.isConnected) continue;
      const list = byKey.get(it.key) ?? [];
      list.push(it);
      byKey.set(it.key, list);
    }
    for (const it of items) {
      if (it.stale === 'source left the page') continue;
      const dup = it.key !== null && (byKey.get(it.key)?.length ?? 0) > 1;
      const next = dup ? 'duplicate source link' : null;
      if (next !== it.stale) {
        it.stale = next;
        patchCard(it, extractFields(it.el, fieldNames), columnOf(it));
      }
    }
  };

  const refreshCoverage = (): void => {
    const loaded = loadedElements().length;
    const stale = items.filter((it) => it.stale !== null).length;
    const capped = loaded > RENDER_CAP ? ` (capped at ${RENDER_CAP})` : '';
    const staleNote = stale > 0 ? ` · ${stale} stale` : '';
    coverage.textContent = `Showing ${renderedCount} of ${loaded} items${capped}${staleNote}`;
    more.hidden = renderedCount >= Math.min(loaded, RENDER_CAP);
  };

  /** Render the initial page of items (pagination first). Categories are
   *  extracted for the WHOLE loaded set before the board plan is built —
   *  build order must not decide which columns exist. */
  const renderInitial = (): void => {
    const loaded = loadedElements();
    const extracted = loaded.map((el) => extractFields(el, fieldNames));
    for (const [i, el] of loaded.entries()) categoryCache.set(el, extracted[i]!.category);
    if (isBoard) buildBoardBodies();
    renderedCount = Math.min(loaded.length, PAGE_SIZE);
    for (const [i, el] of loaded.slice(0, renderedCount).entries()) {
      const it = buildCard(el, extracted[i]!, '');
      items.push(it);
    }
    refreshDuplicates();
    if (isBoard) {
      for (const it of items) place(it);
      for (const it of items) if (it.move) it.move.value = columnOf(it);
    }
    refreshCoverage();
  };

  const itemByCard = new Map<HTMLElement, ItemState>();

  // ── update slices (one container observer, microtask-batched) ──────────

  const scheduleFlush = (): void => {
    if (flushQueued || !connected) return;
    flushQueued = true;
    queueMicrotask(flush);
  };

  const flush = (): void => {
    flushQueued = false;
    if (!connected) return;
    // Removals → stale (never auto-removed); re-added → restored.
    for (const el of removedEls) {
      const it = items.find((i) => i.el === el);
      if (it && !el.isConnected && it.stale !== 'source left the page') {
        it.stale = 'source left the page';
        patchCard(it, extractFields(it.el, fieldNames), columnOf(it));
      }
    }
    removedEls.clear();
    // Additions → new items (bounded by the render cap; the rest wait behind
    // pagination and are counted in coverage).
    for (const el of addedEls) {
      if (items.some((i) => i.el === el)) continue;
      // Render immediately only when the first page is not full or every
      // loaded item is already rendered; otherwise it waits for "Show more".
      const showNow = renderedCount < PAGE_SIZE || more.hidden;
      if (!showNow || renderedCount >= RENDER_CAP) continue;
      const fields = extractFields(el, fieldNames);
      const it = buildCard(el, fields, '');
      items.push(it);
      renderedCount += 1;
      place(it);
      if (isBoard && it.move) it.move.value = columnOf(it);
    }
    addedEls.clear();
    // Field changes → re-extract + patch in place.
    for (const it of dirtyItems) {
      const fields = reextract(it);
      if (isBoard && it.category !== null && !columnBodies.has(it.category)) {
        buildBoardBodies(); // a newly observed category grows the board
      }
      const newColumn = columnOf(it);
      patchCard(it, fields, newColumn);
      if (isBoard && it.stale !== 'source left the page') place(it);
    }
    dirtyItems.clear();
    refreshDuplicates();
    refreshCoverage();
  };

  const owningItem = (node: Node): ItemState | null => {
    let cur: Node | null = node;
    while (cur && cur !== container) {
      if (cur.nodeType === 1) {
        const it = items.find((i) => i.el === cur);
        if (it) return it;
      }
      cur = cur.parentNode;
    }
    return null;
  };

  // ── interaction wiring (owned nodes + one container observer) ──────────

  const onDragStart = (ev: DragEvent): void => {
    const card = (ev.target as HTMLElement | null)?.closest?.('.rv2p-card') as HTMLElement | null;
    const it = card ? itemByCard.get(card) : undefined;
    if (!it || !isBoard) return;
    ev.dataTransfer?.setData('text/plain', displayKeyOf(it));
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (ev: DragEvent): void => {
    const zone = (ev.target as HTMLElement | null)?.closest?.('.rv2p-col-cards') as HTMLElement | null;
    if (!zone) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    zone.classList.add('rv2p-drop');
  };
  const onDragLeave = (ev: DragEvent): void => {
    const zone = (ev.target as HTMLElement | null)?.closest?.('.rv2p-col-cards') as HTMLElement | null;
    zone?.classList.remove('rv2p-drop');
  };
  const onDrop = (ev: DragEvent): void => {
    const zone = (ev.target as HTMLElement | null)?.closest?.('.rv2p-col-cards') as HTMLElement | null;
    zone?.classList.remove('rv2p-drop');
    if (!zone) return;
    ev.preventDefault();
    const key = ev.dataTransfer?.getData('text/plain');
    if (!key) return;
    const it = items.find((i) => displayKeyOf(i) === key);
    const colName = zone.closest('.rv2p-col')?.getAttribute('data-rv2p-col');
    if (it && colName) moveToColumn(it, colName);
  };
  const onMore = (): void => {
    const loaded = loadedElements();
    const target = Math.min(renderedCount + PAGE_SIZE, loaded.length, RENDER_CAP);
    for (const el of loaded.slice(renderedCount, target)) {
      const fields = extractFields(el, fieldNames);
      categoryCache.set(el, fields.category);
      const it = buildCard(el, fields, '');
      items.push(it);
      renderedCount += 1;
      place(it);
      if (isBoard && it.move) it.move.value = columnOf(it);
    }
    refreshDuplicates();
    refreshCoverage();
  };

  const onContainerMutation = (muts: MutationRecord[]): void => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of Array.from(m.addedNodes)) if (n.nodeType === 1) addedEls.add(n as Element);
        for (const n of Array.from(m.removedNodes)) if (n.nodeType === 1) removedEls.add(n as Element);
        if (m.target !== container) {
          const it = owningItem(m.target);
          if (it) dirtyItems.add(it);
        }
        continue;
      }
      const it = owningItem(m.target);
      if (it) dirtyItems.add(it);
    }
    scheduleFlush();
  };

  renderInitial();

  return {
    root,
    connect() {
      if (connected) return;
      connected = true;
      observer = new MutationObserver(onContainerMutation);
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['href', 'aria-label', 'title', ...CATEGORY_ATTRS],
      });
      root.addEventListener('dragstart', onDragStart);
      root.addEventListener('dragover', onDragOver);
      root.addEventListener('dragleave', onDragLeave);
      root.addEventListener('drop', onDrop);
      more.addEventListener('click', onMore);
    },
    dispose() {
      connected = false;
      observer?.disconnect();
      observer = null;
      // The local organization intentionally survives (session state; the
      // user's arrangement is not undone by disable/re-enable cycles).
    },
    itemCount: () => renderedCount,
    staleCount: () => items.filter((it) => it.stale !== null).length,
    coverageText: () => coverage.textContent ?? '',
  };
}
