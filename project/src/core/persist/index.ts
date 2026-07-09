import { getSemanticRole, getAccessibleName } from '../observe';
import type { ActionSpec } from '../plan';

export interface TargetDescriptor {
  tag: string;
  role: string;
  accessibleName: string;
  textFingerprint: string;
  ancestorChain: { tag: string; role: string }[];
  childElementCount: number;
  approxRect: { x: number; y: number; width: number; height: number };
}

export interface BehaviorRecord {
  id: string;
  intent: string;
  actionType: string;
  descriptor?: TargetDescriptor | null;
  actionSpec: ActionSpec;
  createdAt: number;
}

export interface TransformRecord {
  id: string;
  intent: string;
  kind: 'isolate' | 'hide';
  keepDescriptor?: TargetDescriptor | null;
  targetDescriptors?: TargetDescriptor[];
  css: string;
  createdAt: number;
}

export interface SiteState {
  enabled: boolean;
  transforms: TransformRecord[];
  behaviors: BehaviorRecord[];
}

export function buildDescriptor(el: Element): TargetDescriptor {
  const textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const textFingerprint = textContent.substring(0, 60);
  
  const ancestorChain: { tag: string, role: string }[] = [];
  let p = el.parentElement;
  while (p && p !== document.documentElement) {
    ancestorChain.push({
      tag: p.tagName.toLowerCase(),
      role: getSemanticRole(p) || ''
    });
    p = p.parentElement;
  }

  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role: getSemanticRole(el) || '',
    accessibleName: getAccessibleName(el),
    textFingerprint,
    ancestorChain,
    childElementCount: el.childElementCount,
    approxRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  };
}

export function reidentify(desc: TargetDescriptor): { el: Element, confidence: number } | null {
  const candidates = document.querySelectorAll(desc.tag);
  let bestEl: Element | null = null;
  let bestScore = -1;
  
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.hasAttribute('data-webmorph-ui') || el.closest('[data-webmorph-ui]')) continue;

    let score = 0;
    
    // Role + Name
    const role = getSemanticRole(el) || '';
    const name = getAccessibleName(el);
    if (role === desc.role) score += 20;
    if (name && name === desc.accessibleName) score += 30;
    else if (!name && !desc.accessibleName) score += 10;
    
    // Text fingerprint
    const textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (textContent.substring(0, 60) === desc.textFingerprint) score += 20;
    
    // Ancestor chain similarity
    let pEl = el.parentElement;
    let matchCount = 0;
    let totalAnc = desc.ancestorChain.length;
    let ancIndex = 0;
    while (pEl && pEl !== document.documentElement && ancIndex < totalAnc) {
      const ancDesc = desc.ancestorChain[ancIndex];
      if (pEl.tagName.toLowerCase() === ancDesc.tag && (getSemanticRole(pEl) || '') === ancDesc.role) {
        matchCount++;
      }
      pEl = pEl.parentElement;
      ancIndex++;
    }
    score += totalAnc > 0 ? (matchCount / totalAnc) * 20 : 20;
    
    // Tiebreakers
    if (el.childElementCount === desc.childElementCount) score += 5;
    
    const rect = el.getBoundingClientRect();
    if (Math.abs(rect.x - desc.approxRect.x) < 50 && Math.abs(rect.y - desc.approxRect.y) < 50) score += 5;
    if (Math.abs(rect.width - desc.approxRect.width) < 50 && Math.abs(rect.height - desc.approxRect.height) < 50) score += 5;
    
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }
  
  const confidence = Math.min(100, Math.round((bestScore / 100) * 100));
  if (bestEl && confidence > 40) return { el: bestEl, confidence };
  return null;
}

export async function loadSiteState(origin: string): Promise<SiteState> {
  const result = await browser.storage.local.get([origin]);
  if (result[origin]) {
    const state = result[origin] as any;
    // Migration: ensure behaviors array exists
    if (!state.behaviors) state.behaviors = [];
    return state as SiteState;
  }
  return { enabled: true, transforms: [], behaviors: [] };
}

export async function saveSiteState(origin: string, state: SiteState): Promise<void> {
  await browser.storage.local.set({ [origin]: state });
}

export async function clearSiteState(origin: string): Promise<void> {
  await browser.storage.local.remove([origin]);
}
