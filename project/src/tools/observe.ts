/**
 * tools/observe — observation tools. Collect evidence, decide nothing.
 * Every result carries a confidence number. No result can be applied to a page.
 *
 * D: findElements no longer makes a model call AND no longer matches by text.
 * The loop's own model call already sees the describePage inventory and names a
 * selector directly. findElements only RESOLVES that selector against the DOM
 * and returns the count + region metadata — it decides nothing. Text-based
 * concept matching (a substring keyword table) was removed: standing rule 13
 * forbids a keyword table, and rule 1 forbids a saved code path.
 *
 * D: verifySelector accepts 1..N, returns the count, lets the agent decide.
 * Refuses only on a clearly wrong match count (>200) and says so.
 */

import type { ToolDef, ToolResult } from './index';
import { buildInventory, serializeInventory } from '../core/inventory';
import { redactSensitiveData } from '../core/sanitize/redact';
import { perceive, serializePerception } from '../core/perceive';

const CONFIDENCE_FLOOR = 0.5;

/** D: verify a selector resolves. Accept 1..N, return the count.
 *  Refuse only on a clearly wrong match count (>200). */
function verifySelectorResult(selector: string): { count: number; first: Element | null } {
  try {
    const els = document.querySelectorAll(selector);
    if (els.length > 200) return { count: els.length, first: null };
    return { count: els.length, first: els[0] ?? null };
  } catch { return { count: 0, first: null }; }
}

// ── describePage ───────────────────────────────────────────────────

async function describePage(_args: any): Promise<ToolResult> {
  const regions = buildInventory();
  const MAX_REGIONS = 60;
  const truncated = regions.length >= MAX_REGIONS;
  return {
    ok: true,
    truncated,
    result: {
      regionCount: regions.length,
      truncated,
      regions: regions.map((r) => ({
        id: r.id, role: r.role, type: r.componentType, tag: r.tag,
        textSample: r.textSample, position: r.position, width: r.width,
        repeat: r.repeatCount, selector: r.targetable ? r.selector : undefined,
        targetable: r.targetable, untargetableReason: r.untargetableReason,
      })),
    },
    confidence: regions.length > 0 ? 0.7 : 0.2,
    costMs: 0,
  };
}

// ── findElements — resolve a selector the model named. No text matching. ──

async function findElements(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  if (!selector) return { ok: false, error: 'missing "selector" argument. The loop already has the describePage inventory — name a selector and findElements resolves it against the DOM (count + region metadata). No concept matching is done.' };

  // D: resolve against the live DOM. Accept 1..N, return the count. Refuse
  // only on a clearly wrong match count (>200). No keyword table, no concept
  // scoring — the model picks the selector from the inventory it already saw.
  const { count } = verifySelectorResult(selector);
  if (count === 0) {
    return {
      ok: true,
      result: { selector, matches: [], count: 0, truncated: false },
      confidence: 0.1,
      costMs: 0,
    };
  }

  const regions = buildInventory();
  const truncated = regions.length >= 60;

  // Map the resolved elements to inventory regions by selector, when present.
  const matches = regions
    .filter(r => r.targetable && r.selector === selector)
    .slice(0, 10)
    .map(r => ({
      id: r.id,
      confidence: 0.8,
      reason: `selector "${selector}" resolved by the model`,
      selector: r.selector,
      targetable: r.targetable,
      untargetableReason: r.untargetableReason,
    }));

  return {
    ok: true,
    truncated,
    result: {
      selector,
      count,
      matches,
      truncated,
      message: count > 200 ? `selector matched ${count} elements — too broad; refine it` : undefined,
    },
    confidence: count > 0 && count <= 200 ? 0.8 : 0.2,
    costMs: 0,
  };
}

// ── readText ──────────────────────────────────────────────────────

async function readText(args: any): Promise<ToolResult> {
  const selector = args?.selector as string;
  if (!selector) return { ok: false, error: 'missing "selector" argument. Call describePage first to find the region, then pass its selector.' };

  // D: accept 1..N — read the first element, report the count.
  const { count, first: el } = verifySelectorResult(selector);
  if (count === 0) return { ok: false, error: `selector "${selector}" did not resolve to any element. Call describePage to see available regions with their selectors.`, confidence: 0.1 };
  if (count > 200) return { ok: false, error: `selector "${selector}" matched ${count} elements — too broad. Refine your selector to target fewer elements.`, confidence: 0.1 };

  // F1: refuse on measurement, not spelling.
  const targetEl = el as HTMLElement;
  const elText = (targetEl.textContent || '').replace(/\s+/g, ' ').trim();
  const pageText = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
  const textShare = pageText.length > 0 ? elText.length / pageText.length : 0;
  const elRect = targetEl.getBoundingClientRect();
  const pageArea = window.innerWidth * window.innerHeight;
  const areaShare = pageArea > 0 ? (elRect.width * elRect.height) / pageArea : 0;

  if (textShare > 0.8) {
    return {
      ok: false,
      error: `"${selector}" covers ${Math.round(textShare * 100)}% of the page text — too broad. Call describePage to find the specific region (e.g. the article body, not the whole page), then readText on that region.`,
      confidence: 0.1,
    };
  }
  if (areaShare > 0.9) {
    return {
      ok: false,
      error: `"${selector}" covers ${Math.round(areaShare * 100)}% of the viewport area — too broad. Call describePage to find the specific region, then readText on that.`,
      confidence: 0.1,
    };
  }

  let text = targetEl.textContent || '';
  text = text.replace(/\s+/g, ' ').trim();
  const MAX_CHARS = 100_000;
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);
  text = redactSensitiveData(text);

  return {
    ok: true,
    truncated,
    result: { text, length: text.length, truncated, originalLength: targetEl.textContent?.replace(/\s+/g, ' ').trim().length ?? 0, elementCount: count },
    confidence: 0.85,
    costMs: 0,
  };
}

// ── perceivePage — level 4 full page perception (expensive) ────────

async function perceivePage(_args: any): Promise<ToolResult> {
  const t0 = performance.now();
  const p = perceive();
  const text = serializePerception(p);
  const elapsed = performance.now() - t0;
  const BUDGET = 8000;
  const truncated = text.length > BUDGET;
  const result = truncated ? text.slice(0, BUDGET) : text;
  return {
    ok: true,
    truncated,
    result: { perception: result, length: text.length, truncated, regions: p.skeleton?.regions?.length ?? 0 },
    confidence: 0.9,
    costMs: Math.round(elapsed),
  };
}

// ── stubs ─────────────────────────────────────────────────────────

function notImplemented(name: string): Promise<ToolResult> {
  return Promise.resolve({ ok: false, error: `${name} is not implemented in Stage 0.5. Available observe tools: describePage, findElements, readText, perceivePage.` });
}

// ── exports ────────────────────────────────────────────────────────

export const observeTools: ToolDef[] = [
  { name: 'describePage', kind: 'observe', description: 'list page regions (roles, types, positions)',
    args: {}, execute: describePage },
  { name: 'findElements', kind: 'observe', description: 'resolve a selector the model named (count + region metadata; no concept matching)',
    args: { selector: 'string' }, execute: findElements },
  { name: 'readText', kind: 'observe', description: 'read text content of an element',
    args: { selector: 'string' }, execute: readText },
  { name: 'inspect', kind: 'observe', description: 'computed style, box, children of one element',
    args: { selector: 'string' }, execute: () => notImplemented('inspect'), stub: true },
  { name: 'measure', kind: 'observe', description: 'geometry only (rect, position, size)',
    args: { selector: 'string' }, execute: () => notImplemented('measure'), stub: true },
  { name: 'perceivePage', kind: 'observe', description: 'full page perception — level 4, expensive, call rarely',
    args: {}, execute: perceivePage },
];
