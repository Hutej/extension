/**
 * Observe layer — Interface Graph builder.
 * Synchronous, single-frame, read-only DOM scan.
 * Filters by geometry + density, NOT tag name.
 */

const MAX_WALK_DEPTH = 15;
const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT']);
const STYLE_ELEMENT_ID = 'webmorph-styles';

// ── Types ──────────────────────────────────────────────────────────

export interface NodeRect {
  x: number; y: number; w: number; h: number;
}

export interface GraphNode {
  id: string;
  tag: string;
  role: string;
  rect: NodeRect;
  viewportCoveragePct: number;
  isOffscreen: boolean;
  layout: {
    display: string;
    position: string;
    parentLayoutModel: string;
  };
  style: {
    color: string;
    backgroundColor: string;
    fontSize: string;
    fontWeight: string;
    zIndex: string;
    overflow: string;
  };
  language: {
    text: string;
    ariaLabel: string;
    placeholder: string;
    alt: string;
    title: string;
  };
  interactiveDensity: number;
  directTextLength: number;
  childElementCount: number;
}

export interface InterfaceGraph {
  url: string;
  viewport: { w: number; h: number };
  builtInMs: number;
  nodeCount: number;
  nodes: GraphNode[];
}

// ── Implicit ARIA role map (cheap subset) ──────────────────────────

const IMPLICIT_ROLES: Record<string, string> = {
  A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
  TEXTAREA: 'textbox', IMG: 'img', TABLE: 'table', FORM: 'form',
  NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
  ASIDE: 'complementary', ARTICLE: 'article', SECTION: 'region',
  UL: 'list', OL: 'list', LI: 'listitem', H1: 'heading', H2: 'heading',
  H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  DIALOG: 'dialog', DETAILS: 'group', SUMMARY: 'button',
};

// ── Interactive element detection ──────────────────────────────────

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

function isInteractiveElement(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') return true;
  return false;
}

// ── Direct text length (text nodes that are direct children) ───────

function getDirectTextLength(el: HTMLElement): number {
  let len = 0;
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 3) { // TEXT_NODE
      const t = n.textContent;
      if (t) len += t.trim().length;
    }
  }
  return len;
}

// ── Language text: direct text nodes only, capped at 120 chars ─────
// Using direct text (not innerText) avoids including descendant text
// which would bloat containers and duplicate content from children.

function getLanguageText(el: HTMLElement): string {
  const parts: string[] = [];
  let total = 0;
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 3) {
      const t = n.textContent?.trim();
      if (t && t.length > 0) {
        parts.push(t);
        total += t.length;
        if (total >= 120) break;
      }
    }
  }
  const joined = parts.join(' ');
  if (joined.length <= 120) return joined;
  return joined.slice(0, 117) + '...';
}

// ── Node retention filter ──────────────────────────────────────────
// Geometry + density based. NOT tag-name based.
// Goal: capture STRUCTURAL boundaries (sections, containers, layout
// regions), not individual content elements (every link, every <li>).

const MIN_VP_COVERAGE = 0.003; // 0.3% of viewport area to be "meaningful"
const MIN_TEXT_LEN = 5;

// Semantic landmark tags worth keeping even without other signals
const LANDMARK_TAGS = new Set([
  'NAV', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'ARTICLE', 'SECTION', 'FORM',
]);

function shouldRetain(
  el: HTMLElement,
  rect: DOMRect,
  directTextLen: number,
  interactiveCount: number,
  totalDesc: number,
  cs: CSSStyleDeclaration,
  vpW: number,
  vpH: number,
): boolean {
  const w = rect.width;
  const h = rect.height;
  const area = w * h;
  const vpArea = vpW * vpH;

  // Invisible or collapsed
  if (w === 0 && h === 0) return false;

  // Fully clipped
  if (cs.overflow === 'hidden' && (w < 2 || h < 2)) return false;

  const hasOwnText = directTextLen >= MIN_TEXT_LEN;
  const hasExplicitRole = !!el.getAttribute('role');
  const isLandmark = LANDMARK_TAGS.has(el.tagName);
  const isFormElement = el.tagName === 'INPUT' || el.tagName === 'SELECT' ||
    el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON';

  // Coverage-based: is this node a significant part of the viewport?
  const coverage = vpArea > 0 ? area / vpArea : 0;

  // Always keep form elements (inputs, buttons, selects)
  if (isFormElement) return true;

  // Explicit ARIA role needs meaningful viewport coverage
  if (hasExplicitRole && coverage >= MIN_VP_COVERAGE) return true;

  // Semantic landmarks with meaningful coverage — always keep
  if (isLandmark && coverage >= MIN_VP_COVERAGE) return true;



  // Heading elements with text — keep (important for AI to see page structure)
  const isHeading = el.tagName === 'H1' || el.tagName === 'H2' ||
    el.tagName === 'H3' || el.tagName === 'H4';
  if (isHeading && hasOwnText) return true;

  // Leaf nodes (no element children)
  if (el.childElementCount === 0) {
    // Only keep leaf nodes if they cover enough viewport
    // This prevents hundreds of small links/list-items from flooding the graph
    if (coverage >= MIN_VP_COVERAGE && hasOwnText) return true;
    // Images with decent size
    if (el.tagName === 'IMG' && coverage >= MIN_VP_COVERAGE) return true;
    return false;
  }

  // Container nodes: meaningful coverage + some contribution
  if (coverage < MIN_VP_COVERAGE) return false;

  // Flex/grid layout boundaries with multiple children — structural
  if (el.childElementCount >= 2 &&
    (cs.display === 'flex' || cs.display === 'grid' ||
      cs.display === 'inline-flex' || cs.display === 'inline-grid')) {
    if (coverage >= MIN_VP_COVERAGE) return true;
  }



  // Container with own text — keep
  if (hasOwnText && coverage >= MIN_VP_COVERAGE) return true;

  // Single-child wrapper — skip (child will be evaluated separately)
  if (el.childElementCount === 1) return false;



  return false;
}

// ── Build ──────────────────────────────────────────────────────────

export function buildInterfaceGraph(): InterfaceGraph {
  const t0 = performance.now();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const vpArea = vpW * vpH;
  const nodes: GraphNode[] = [];
  let idx = 0;

  const body = document.body;
  if (!body) {
    return {
      url: location.href,
      viewport: { w: vpW, h: vpH },
      builtInMs: Math.round(performance.now() - t0),
      nodeCount: 0,
      nodes: [],
    };
  }

  function walk(el: HTMLElement, depth: number, parentDisplay: string): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (IGNORED_TAGS.has(el.tagName)) return;
    if (el.id === STYLE_ELEMENT_ID || el.id === 'webmorph-debug-overlay') return;

    const cs = getComputedStyle(el);

    // Quick reject: hidden
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;

    const rect = el.getBoundingClientRect();

    // Count interactive descendants
    const allDesc = el.getElementsByTagName('*');
    const totalDesc = allDesc.length;
    let interactiveCount = 0;
    for (let i = 0; i < totalDesc; i++) {
      if (isInteractiveElement(allDesc[i])) interactiveCount++;
    }
    if (isInteractiveElement(el)) interactiveCount++;

    const directTextLen = getDirectTextLength(el);

    if (!shouldRetain(el, rect, directTextLen, interactiveCount, totalDesc, cs, vpW, vpH)) {
      // Still walk children — they might be retained
      const children = el.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child instanceof HTMLElement) {
          walk(child, depth + 1, cs.display);
        }
      }
      return;
    }

    const nodeId = `wm-${idx++}`;
    el.setAttribute('data-wm-id', nodeId);

    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);

    const isOffscreen = (x + w <= 0) || (y + h <= 0) || (x >= vpW) || (y >= vpH);
    const visibleW = Math.max(0, Math.min(x + w, vpW) - Math.max(x, 0));
    const visibleH = Math.max(0, Math.min(y + h, vpH) - Math.max(y, 0));
    const coveragePct = vpArea > 0 ? Math.round((visibleW * visibleH / vpArea) * 10000) / 100 : 0;

    const explicitRole = el.getAttribute('role') || '';
    const computedRole = explicitRole || IMPLICIT_ROLES[el.tagName] || '';

    const density = totalDesc > 0
      ? Math.round((interactiveCount / totalDesc) * 100) / 100
      : (isInteractiveElement(el) ? 1 : 0);

    nodes.push({
      id: nodeId,
      tag: el.tagName.toLowerCase(),
      role: computedRole,
      rect: { x, y, w, h },
      viewportCoveragePct: coveragePct,
      isOffscreen,
      layout: {
        display: cs.display,
        position: cs.position,
        parentLayoutModel: parentDisplay,
      },
      style: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        zIndex: cs.zIndex,
        overflow: cs.overflow,
      },
      language: {
        text: getLanguageText(el),
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: (el as HTMLInputElement).placeholder || el.getAttribute('placeholder') || '',
        alt: (el as HTMLImageElement).alt || el.getAttribute('alt') || '',
        title: el.getAttribute('title') || '',
      },
      interactiveDensity: density,
      directTextLength: directTextLen,
      childElementCount: el.childElementCount,
    });

    // Continue walking children
    const children = el.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child instanceof HTMLElement) {
        walk(child, depth + 1, cs.display);
      }
    }
  }

  walk(body, 0, 'block');

  const builtInMs = Math.round(performance.now() - t0);

  return {
    url: location.href,
    viewport: { w: vpW, h: vpH },
    builtInMs,
    nodeCount: nodes.length,
    nodes,
  };
}

// ── Serialize for AI (compact JSON) ────────────────────────────────

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb;
  const r = parseInt(m[1], 10);
  const g = parseInt(m[2], 10);
  const b = parseInt(m[3], 10);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function serializeGraphForAI(graph: InterfaceGraph): string {
  const compact = {
    url: graph.url,
    vp: graph.viewport,
    ms: graph.builtInMs,
    n: graph.nodeCount,
    nodes: graph.nodes.map(n => {
      const c = rgbToHex(n.style.color);
      const bg = rgbToHex(n.style.backgroundColor);
      // Only include style props that carry signal
      const s: Record<string, string | undefined> = {
        c: c !== '#000000' ? c : undefined,
        bg: bg !== '#000000' && !n.style.backgroundColor.includes('0, 0, 0, 0') && n.style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? bg : undefined,
        fs: n.style.fontSize,
        fw: n.style.fontWeight !== '400' ? n.style.fontWeight : undefined,
        z: n.style.zIndex !== 'auto' ? n.style.zIndex : undefined,
        ov: n.style.overflow !== 'visible' ? n.style.overflow : undefined,
      };
      // Strip undefined values
      const sClean: Record<string, string> = {};
      for (const [k, v] of Object.entries(s)) {
        if (v !== undefined) sClean[k] = v;
      }

      const langObj: Record<string, string> = {};
      if (n.language.text) langObj.t = n.language.text;
      if (n.language.ariaLabel) langObj.aria = n.language.ariaLabel;
      if (n.language.placeholder) langObj.ph = n.language.placeholder;
      if (n.language.alt) langObj.alt = n.language.alt;
      if (n.language.title) langObj.ti = n.language.title;
      
      const layArr = [n.layout.display, n.layout.position, n.layout.parentLayoutModel];
      const isDefaultLay = layArr[0] === 'block' && layArr[1] === 'static' && layArr[2] === 'block';

      return {
        id: n.id,
        tag: n.tag,
        role: n.role || undefined,
        r: [n.rect.x, n.rect.y, n.rect.w, n.rect.h],
        vpPct: n.viewportCoveragePct || undefined,
        off: n.isOffscreen || undefined,
        lay: isDefaultLay ? undefined : layArr,
        s: Object.keys(sClean).length > 0 ? sClean : undefined,
        lang: Object.keys(langObj).length > 0 ? langObj : undefined,
        iD: n.interactiveDensity || undefined,
        dtl: n.directTextLength || undefined,
        cec: n.childElementCount || undefined,
      };
    }),
  };
  return JSON.stringify(compact);
}
// ── Step 3: Semantic Map ──────────────────────────────────────────

export type MediaClass = 'image' | 'video' | 'audioPlayer' | 'thumbnail' | 'icon' | 'canvas' | 'none';

export interface SemanticNode {
  id: string;
  role: string | null;
  tag: string;
  name: string;
  inferredName?: boolean;
  media: MediaClass;
  rect: NodeRect;
  inViewport: boolean;
  area: number;
  repeated?: number;
  preview?: string;
  children: SemanticNode[];
}

export interface SemanticMap {
  builtInMs: number;
  nodeCount: number;
  roots: SemanticNode[];
}

const SEMANTIC_ROLES: Record<string, string> = {
  nav: 'navigation', main: 'main', aside: 'complementary',
  ul: 'list', ol: 'list', li: 'listitem', form: 'form',
  img: 'img', video: 'video', audio: 'audio', table: 'table',
  article: 'article'
};

export function getSemanticRole(el: Element): string | null {
  const explicitRole = el.getAttribute('role');
  if (explicitRole) return explicitRole;
  
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes((el as HTMLInputElement).type))) return 'button';
  if (SEMANTIC_ROLES[tag]) return SEMANTIC_ROLES[tag];
  if (tag === 'header') return 'banner';
  if (tag === 'footer') return 'contentinfo';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') return (el as HTMLInputElement).type === 'checkbox' ? 'checkbox' : 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'section') {
    if (el.getAttribute('aria-labelledby') || el.getAttribute('aria-label') || el.getAttribute('title')) return 'region';
  }
  return null;
}

export function getAccessibleName(el: Element): string {
  let name = '';
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const ids = labelledBy.split(/\s+/);
    name = ids.map(id => {
      const target = root.getElementById(id);
      return target ? (target.textContent || '').trim() : '';
    }).join(' ').trim();
  }
  if (!name) name = el.getAttribute('aria-label') || '';
  if (!name && el.tagName === 'IMG') name = el.getAttribute('alt') || '';
  if (!name) name = el.getAttribute('title') || '';
  if (!name && el.tagName === 'INPUT') name = (el as HTMLInputElement).placeholder || el.getAttribute('placeholder') || '';
  if (!name) {
    let directText = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3 && n.textContent) {
        directText += n.textContent + ' ';
      }
    }
    name = directText.trim();
  }
  name = name.replace(/\s+/g, ' ').trim();
  if (name.length > 80) name = name.substring(0, 77) + '...';
  return name;
}

function getMediaClass(el: HTMLElement, tag: string, role: string | null, w: number, h: number): MediaClass {
  if (tag === 'canvas') return 'canvas';
  if (tag === 'audio') return 'audioPlayer';
  const isImg = tag === 'img' || tag === 'svg' || tag === 'video' || role === 'img';
  if (!isImg) return 'none';
  if (w <= 32 && h <= 32) return 'icon';
  const parent = el.parentElement;
  if (parent && (parent.tagName === 'A' || parent.getAttribute('role') === 'link')) return 'thumbnail';
  if (tag === 'video') return 'video';
  return 'image';
}

let smIdx = 0;

export function buildSemanticMap(): SemanticMap {
  const t0 = performance.now();
  smIdx = 0;
  let totalNodes = 0;

  function walk(el: HTMLElement, depth: number): SemanticNode[] {
    if (depth > 20) return [];
    const tag = el.tagName.toUpperCase();
    if (IGNORED_TAGS.has(tag) || el.id === STYLE_ELEMENT_ID || el.id === 'webmorph-debug-overlay') return [];

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return [];

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height), area = w * h;
    const inViewport = !(rect.x + w <= 0 || rect.y + h <= 0 || rect.x >= window.innerWidth || rect.y >= window.innerHeight);

    const role = getSemanticRole(el);
    let name = getAccessibleName(el);
    const lowerTag = tag.toLowerCase();
    const media = getMediaClass(el, lowerTag, role, w, h);

    let children: SemanticNode[] = [];
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] instanceof HTMLElement || kids[i] instanceof SVGElement) {
        children = children.concat(walk(kids[i] as HTMLElement, depth + 1));
      }
    }
    
    // Pierce open shadow roots
    if (el.shadowRoot) {
      const srKids = el.shadowRoot.children;
      for (let i = 0; i < srKids.length; i++) {
        if (srKids[i] instanceof HTMLElement || srKids[i] instanceof SVGElement) {
          children = children.concat(walk(srKids[i] as HTMLElement, depth + 1));
        }
      }
    }

    const isLandmark = role && ['banner', 'contentinfo', 'main', 'complementary', 'navigation', 'region'].includes(role);
    if (!isLandmark && (area === 0 || (cs.overflow === 'hidden' && (w < 2 || h < 2)))) {
      return children; // reparent
    }

    let hasDirectText = false;
    for (let i = 0; i < el.childNodes.length; i++) {
      const n = el.childNodes[i];
      if (n.nodeType === 3 && (n.textContent || '').trim().length > 0) {
        hasDirectText = true; break;
      }
    }

    // Do NOT emit presentational wrappers
    if (!role && !name && !hasDirectText) {
      return children; // reparent
    }

    // Deduplicate
    if (children.length === 1 && children[0].role === role && children[0].name === name) {
      return children; // deduplicate
    }

    let repeated: number | undefined;
    if (children.length >= 3) {
      const sigs: Record<string, number> = {};
      let maxCount = 0;
      for (const c of children) {
        const sig = `${c.tag}|${c.role || ''}`;
        sigs[sig] = (sigs[sig] || 0) + 1;
        if (sigs[sig] > maxCount) maxCount = sigs[sig];
      }
      if (maxCount >= 3) repeated = maxCount;
    }

    let inferredName = false;
    if (!name && children.length > 0) {
      let headingText = '';
      let nodesChecked = 0;
      function findHeading(kids: SemanticNode[]): boolean {
        for (const c of kids) {
          if (nodesChecked++ > 5) return false;
          if (c.role === 'heading' || /^h[1-6]$/.test(c.tag)) {
            if (c.name) { headingText = c.name; return true; }
          }
          if (findHeading(c.children)) return true;
        }
        return false;
      }
      findHeading(children);
      if (headingText) {
        name = headingText;
        inferredName = true;
      }
    }

    let preview: string | undefined;
    if (!name) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) {
        preview = txt.length > 40 ? txt.substring(0, 37) + '...' : txt;
      }
    }

    const id = `wm-${smIdx++}`;
    el.setAttribute('data-wm-id', id);
    totalNodes++;

    return [{
      id, role, tag: lowerTag, name, inferredName, media,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w, h },
      inViewport, area, repeated, preview, children
    }];
  }

  const roots: SemanticNode[] = [];
  if (document.body) {
    const bodyKids = document.body.children;
    for (let i = 0; i < bodyKids.length; i++) {
      if (bodyKids[i] instanceof HTMLElement || bodyKids[i] instanceof SVGElement) {
        roots.push(...walk(bodyKids[i] as HTMLElement, 0));
      }
    }
  }
  return {
    builtInMs: Math.round(performance.now() - t0),
    nodeCount: totalNodes,
    roots
  };
}

export function serializeForAI(map: SemanticMap): string {
  const vpArea = window.innerWidth * window.innerHeight;
  let lines: string[] = [];

  function printNode(n: SemanticNode, depth: number) {
    const indent = '  '.repeat(depth);
    const type = n.role || n.tag;
    let line = `${indent}${type}`;
    if (n.name) {
      if (n.inferredName) line += ` "${n.name}" (inferred)`;
      else line += ` "${n.name}"`;
    }
    line += ` #${n.id}`;
    
    const flags = [];
    if (n.repeated) flags.push(`repeated:${n.repeated}`);
    if (n.preview) flags.push(`preview:"${n.preview}"`);
    if (n.media !== 'none') flags.push(n.media);
    if (n.media !== 'none' || (vpArea > 0 && n.area / vpArea > 0.05)) {
      flags.push(`${n.rect.w}x${n.rect.h}`);
    }
    if (flags.length > 0) {
      line += ` ${flags.join(' ')}`;
    }
    
    lines.push(line);
    for (const c of n.children) {
      printNode(c, depth + 1);
    }
  }

  for (const r of map.roots) {
    printNode(r, 0);
  }
  return lines.join('\n');
}

export function findPrimaryContentNode(): Element | null {
  let bestEl: Element | null = null;
  let maxScore = -1;
  const els = document.body.querySelectorAll('*');
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const vpArea = vpW * vpH;

  els.forEach(el => {
    // Ignore UI elements
    if (el.hasAttribute('data-webmorph-ui') || el.closest('[data-webmorph-ui]')) return;

    const textLen = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if (textLen < 100) return;

    let interactiveTextLen = 0;
    const interactives = el.querySelectorAll('a, button, input, select, textarea');
    interactives.forEach(i => {
      interactiveTextLen += (i.textContent || '').replace(/\s+/g, ' ').trim().length;
    });

    const ratio = textLen > 0 ? interactiveTextLen / textLen : 1;
    if (ratio < 0.3) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const area = rect.width * rect.height;
        if (vpArea > 0 && (area / vpArea) > 0.05) {
          if (textLen > maxScore) {
            maxScore = textLen;
            bestEl = el;
          }
        }
      }
    }
  });
  return bestEl;
}
