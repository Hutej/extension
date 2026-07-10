/**
 * Observe layer — Semantic Map builder + Design Context extractor.
 * Synchronous, single-frame, read-only DOM scan.
 * Tree-based, role/name/accessibility oriented.
 */

import { AI_CONFIG } from '../config';

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BR', 'HR', 'WBR', 'LINK', 'META', 'TEMPLATE', 'SLOT']);
const STYLE_ELEMENT_ID = 'webmorph-styles';

/** Roles that get stamped as data-wm-role on DOM nodes */
const STAMPABLE_ROLES = new Set([
  'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region',
  'form', 'button', 'link', 'heading', 'list', 'article'
]);

// ── Types ──────────────────────────────────────────────────────────

interface NodeRect {
  x: number; y: number; w: number; h: number;
}

type MediaClass = 'image' | 'video' | 'audioPlayer' | 'thumbnail' | 'icon' | 'canvas' | 'none';

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

export interface DesignContext {
  backgrounds: string[];
  textColors: string[];
  accentColors: string[];
  fontFamilies: string[];
  baseFontSize: string;
  borderRadii: string[];
  spacingRhythm: string[];
}

// ── Implicit semantic role map ─────────────────────────────────────

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

// ── Accessible name computation ────────────────────────────────────

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
  if (!name && 'placeholder' in el) name = (el as HTMLInputElement).placeholder || el.getAttribute('placeholder') || '';
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

// ── Media classification ───────────────────────────────────────────

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

// ── Build Semantic Map ─────────────────────────────────────────────

let smIdx = 0;

export function buildSemanticMap(): SemanticMap {
  const t0 = performance.now();
  smIdx = 0;
  let totalNodes = 0;

  function walk(el: HTMLElement, depth: number): SemanticNode[] {
    if (depth > 20 || totalNodes >= AI_CONFIG.maxObserveNodes) return [];
    if (performance.now() - t0 > AI_CONFIG.maxObserveTimeMs) return [];

    const tag = el.tagName.toUpperCase();
    if (IGNORED_TAGS.has(tag) || el.id === STYLE_ELEMENT_ID || el.id === 'webmorph-debug-overlay') return [];

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height), area = w * h;
    
    // Roughly hidden checks (avoids slow getComputedStyle)
    if (area === 0 && tag !== 'svg') return [];

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
    if (!isLandmark && area === 0) {
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

    // TASK 1: Stamp data-wm-role on nodes that have a stampable role
    if (role && STAMPABLE_ROLES.has(role)) {
      el.setAttribute('data-wm-role', role);
    }

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

// ── Serialize for AI (token-budgeted outline) ──────────────────────

export function serializeForAI(map: SemanticMap, maxTokens: number = 8000): { outline: string, truncated: boolean } {
  const vpArea = window.innerWidth * window.innerHeight;
  const maxChars = maxTokens * 4; // approx 4 chars per token
  let lines: { node: SemanticNode, depth: number, line: string, score: number, keep: boolean }[] = [];

  const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'form', 'region']);
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);

  function collectNodes(n: SemanticNode, depth: number) {
    const type = n.role || n.tag;
    let line = `${'  '.repeat(depth)}${type}`;
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
    
    let score = 0;
    if (LANDMARKS.has(type)) score += 100;
    if (INTERACTIVE.has(type)) score += 100;
    if (n.name) score += 50;
    if (n.inViewport) score += 20;
    score -= depth; // penalize deep nodes

    lines.push({ node: n, depth, line, score, keep: true });
    
    for (const c of n.children) {
      collectNodes(c, depth + 1);
    }
  }

  for (const r of map.roots) {
    collectNodes(r, 0);
  }

  // Calculate current length
  let totalChars = lines.reduce((sum, l) => sum + l.line.length + 1, 0);
  let truncated = false;

  if (totalChars > maxChars) {
    truncated = true;
    // Sort by score ascending (lowest priority first)
    const sorted = [...lines].sort((a, b) => a.score - b.score);
    for (const item of sorted) {
      if (totalChars <= maxChars) break;
      // Do not truncate essential nodes if possible, but if we have to, we have to.
      // But rules say: keep landmarks + interactive + named nodes.
      // If score >= 50, it's one of those. We try to only drop score < 50.
      if (item.score >= 50 && totalChars <= maxChars + 2000) {
        continue; // Give a little leeway for essential nodes
      }
      item.keep = false;
      totalChars -= (item.line.length + 1);
    }
  }

  const finalLines = lines.filter(l => l.keep).map(l => l.line);
  return { outline: finalLines.join('\n'), truncated };
}

// ── Theme Context ──────────────────────────────────────────────────

export function serializeThemeContext(map: SemanticMap): string {
  const roles = new Map<string, number>();
  
  function countNodes(n: SemanticNode) {
    if (n.role) roles.set(n.role, (roles.get(n.role) || 0) + 1);
    n.children.forEach(countNodes);
  }
  
  map.roots.forEach(countNodes);
  
  const roleStr = Array.from(roles.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([r, c]) => `${c}x ${r}`)
    .join(', ');
  
  return `Role Breakdown: ${roleStr || 'None'}`;
}

// ── Extract Design Context ─────────────────────────────────────────

export function extractDesignContext(): DesignContext {
  const backgrounds = new Set<string>();
  const textColors = new Set<string>();
  const accentColors = new Set<string>();
  const fontFamilies = new Set<string>();
  const borderRadii = new Set<string>();
  const margins = new Set<string>();
  let baseFontSize = '16px';

  // Sample body
  const bodyCs = getComputedStyle(document.body);
  backgrounds.add(bodyCs.backgroundColor);
  textColors.add(bodyCs.color);
  baseFontSize = bodyCs.fontSize;
  if (bodyCs.fontFamily) fontFamilies.add(bodyCs.fontFamily.split(',')[0].trim().replace(/['"]/g, ''));

  // Sample :root / html
  const htmlCs = getComputedStyle(document.documentElement);
  backgrounds.add(htmlCs.backgroundColor);

  // Sample representative nodes for design signals
  const selectors = ['main', 'nav', 'header', 'footer', 'aside', 'article', 'section', 'h1', 'h2', 'h3', 'p', 'a', 'button', 'input'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);

    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      backgrounds.add(bg);
    }

    textColors.add(cs.color);

    if (cs.fontFamily) {
      fontFamilies.add(cs.fontFamily.split(',')[0].trim().replace(/['"]/g, ''));
    }

    const br = cs.borderRadius;
    if (br && br !== '0px') {
      borderRadii.add(br);
    }

    // Links and buttons often carry accent colors
    if (sel === 'a' || sel === 'button') {
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        accentColors.add(bg);
      }
      accentColors.add(cs.color);
    }

    // Spacing rhythm from margins/padding
    const mt = cs.marginTop;
    if (mt && mt !== '0px') margins.add(mt);
    const mb = cs.marginBottom;
    if (mb && mb !== '0px') margins.add(mb);
    const pt = cs.paddingTop;
    if (pt && pt !== '0px') margins.add(pt);
  }

  return {
    backgrounds: [...backgrounds].slice(0, 5),
    textColors: [...textColors].slice(0, 5),
    accentColors: [...accentColors].slice(0, 3),
    fontFamilies: [...fontFamilies].slice(0, 3),
    baseFontSize,
    borderRadii: [...borderRadii].slice(0, 3),
    spacingRhythm: [...margins].slice(0, 5),
  };
}

export function serializeDesignContext(ctx: DesignContext): string {
  const lines = [
    `Backgrounds: ${ctx.backgrounds.join(', ')}`,
    `Text colors: ${ctx.textColors.join(', ')}`,
    `Accent colors: ${ctx.accentColors.join(', ') || 'none detected'}`,
    `Font families: ${ctx.fontFamilies.join(', ')}`,
    `Base font size: ${ctx.baseFontSize}`,
    `Border radii: ${ctx.borderRadii.join(', ') || 'none'}`,
    `Spacing rhythm: ${ctx.spacingRhythm.join(', ') || 'default'}`,
  ];
  return lines.join('\n');
}

// ── Primary content detection ──────────────────────────────────────

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
