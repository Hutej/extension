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
import { registerIdentity, getIdentity } from '../core/identity-store';
import { liveIdentityDom } from '../core/identity-dom';

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
  // F1: register every targetable region's identity (selector -> fingerprint)
  // so the act tools can re-resolve + verify at use time. Re-register on every
  // describePage so a re-perceive refreshes the fingerprints (the last observe
  // wins — a refreshed DOM gives a refreshed identity, not a stale one).
  for (const r of regions) {
    if (r.targetable && r.selector) {
      const el = document.querySelector(r.selector);
      if (el) registerIdentity(r.selector, el, liveIdentityDom);
    }
  }
  return {
    ok: true,
    truncated,
    result: {
      regionCount: regions.length,
      truncated,
      // The model sees role/type/tag/textSample/position/width/repeat/selector/
      // targetable/untargetableReason — everything it needs to CHOOSE a target.
      // It does NOT see the fingerprint: that is internal identity evidence the
      // act tools read from the identity-store (keyed by selector) to re-resolve +
      // verify at use time. Emitting it would bloat the context with a long
      // structural string per region (×60) for no model value — and was a real
      // cost I introduced in the first F1 cut (caught by the real-site run).
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

  // F1 R1: resolve with a MEASURED confidence. findElements fail-closes on a
  // bad COUNT (0 / >200 / invalid selector -> ok:false naming an alternative),
  // NOT on a confidence floor: the confidence is informational (shown to the
  // model in the journal) and gates nothing. The real gate is the act guard
  // (resolveTarget in tools/act.ts), which re-resolves + verifies before any
  // mutation — not the old ok:true-with-empty-matches fail-open.
  let count = 0;
  try { count = document.querySelectorAll(selector).length; }
  catch { return { ok: false, error: `invalid selector "${selector}" — check syntax and call describePage to see available regions`, confidence: 0.1 }; }

  if (count === 0) {
    return { ok: false, error: `selector "${selector}" matched nothing. The element may have been removed or re-rendered. Call describePage to find the current region, then retry.`, confidence: 0.1 };
  }
  if (count > 200) {
    return { ok: false, error: `selector "${selector}" matched ${count} elements — too broad. Refine your selector to target fewer elements. Call describePage to see the regions.`, confidence: 0.1 };
  }

  // F1: a MEASURED confidence. A unique match the store recognizes is high; a
  // multi-match or an unrecognized selector is low. This confidence is
  // INFORMATIONAL (shown to the model in the journal) — the loop does NOT gate
  // on it; consecutiveNoInfo is computed from matches/error/regionCount, not
  // from confidence. The act guard is the real gate, and an unrecognized UNIQUE
  // selector is NOT refused there: resolveTarget returns {ok, reason:'unverified'}
  // and the act mutates by design (locked by tests/f1-identity-test.ts). This
  // replaces the old hardcoded 0.8.
  const recognized = getIdentity(selector) !== null;
  const confidence = count === 1 && recognized ? 0.85 : count === 1 ? 0.45 : 0.2;

  const regions = buildInventory();
  const truncated = regions.length >= 60;

  // F1: matches are the inventory regions whose selector string equals this one
  // (still string equality — the count above is the live-DOM truth). Surface the
  // live match count so the model knows if its selector is unique on the page now.
  const matches = regions
    .filter(r => r.targetable && r.selector === selector)
    .slice(0, 10)
    .map(r => ({
      id: r.id,
      confidence,
      reason: recognized
        ? `selector "${selector}" is a unique, describePage-verified target`
        : `selector "${selector}" resolved ${count} element(s) but was not returned by describePage — identity unverified`,
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
      recognized,
      message: count > 1 ? `selector matched ${count} elements — refine it to one for a safe act` : undefined,
    },
    confidence,
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
