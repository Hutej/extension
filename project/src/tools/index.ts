/**
 * tools/index — the tool registry. Every capability lives here, exactly once.
 * Tools compose; they never chain themselves.
 *
 * Tools execute in the content script (DOM access). The background imports
 * this module to build the agent prompt from tool metadata. The content script
 * imports it to dispatch tool calls.
 */

export type ToolKind = 'observe' | 'act' | 'verify' | 'control';

export interface ToolResult {
  ok: boolean;
  result?: any;          // evidence (observe) / confirmation (act) / check (verify)
  confidence?: number;   // 0..1, required for observe
  inverse?: any;          // for act — how to undo
  error?: string;
  truncated?: boolean;    // REQUIRED if any budget clipped the result
  costMs?: number;
  worse?: boolean;       // for act — signal that the result is worse than before
  /** F4: for act tools — SHA-256 of the target's structural fingerprint,
   *  captured at act time so reload/SPA-render can re-verify the target is
   *  the same element (wrong-target detection on replay) without persisting
   *  cleartext page content. See core/persist/digest.ts. Undefined for
   *  non-act tools and acts whose target could not be resolved at capture. */
  identityDigest?: string;
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  description: string;     // ≤1 line, for the model prompt
  args: Record<string, string>;  // arg name → type hint
  execute: (args: any) => Promise<ToolResult>;
  stub?: boolean;          // true = not implemented in this stage (hidden from prompt)
}

// ── control tools (undo, done, giveUp — handled by the loop, not dispatched) ──

const controlTools: ToolDef[] = [
  { name: 'undo', kind: 'control', description: 'undo the last N actions', args: { steps: 'number' }, execute: async () => ({ ok: true }) },
  { name: 'done', kind: 'control', description: 'finish with a summary', args: { summary: 'string' }, execute: async () => ({ ok: true }) },
  { name: 'giveUp', kind: 'control', description: 'give up with a reason', args: { reason: 'string' }, execute: async () => ({ ok: true }) },
  { name: 'askUser', kind: 'control', description: 'ask the user ONE clarifying question (options + their own answer)', args: { question: 'string', options: 'string[]' }, execute: async () => ({ ok: true }) },
];

// ── the registry ───────────────────────────────────────────────────

import { observeTools } from './observe';
import { actTools } from './act';
import { verifyTools } from './verify';

const allTools: ToolDef[] = [...observeTools, ...actTools, ...verifyTools, ...controlTools];

export const registry: Map<string, ToolDef> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

/** Serialize the tool list for the agent prompt. Only working tools (no stubs).
 *  Compact: one line per tool, args inline WITH their type hints — the registry
 *  record is the single argument schema (never duplicated in the prompt). The
 *  R3 evidence: bare arg names alone produced 15 missing/empty-"css" refusals
 *  in one run; a visible type hint is the cheapest fix at the prompt's cost. */
function serializeArgs(args: Record<string, string>): string {
  const argStr = Object.entries(args).map(([k, hint]) => hint ? `${k}: ${hint}` : k).join(', ');
  return argStr ? `(${argStr})` : '';
}

export function serializeToolList(): string {
  return allTools
    .filter((t) => t.kind !== 'control' && !t.stub)
    .map((t) => `${t.name}${serializeArgs(t.args)} — ${t.description}`)
    .join('\n');
}

/** F + D: restricted tool list — act, verify, done, giveUp. Used after two
 *  consecutive no-info observations OR when the act reserve is reached, so
 *  the model CANNOT observe again. Safety property enforced structurally. */
export function serializeRestrictedToolList(): string {
  const restricted = allTools.filter((t) =>
    ((t.kind === 'act' || t.kind === 'verify') && !t.stub) || t.name === 'done' || t.name === 'giveUp'
  );
  return restricted
    .map((t) => `${t.name}${serializeArgs(t.args)} — ${t.description}`)
    .join('\n');
}

/** Compact actionable malformed-call report: the exact expected argument shape,
 *  inline, so the model can correct the call on its NEXT turn without a second
 *  wrong guess. Single source — the prompt and every error compose this. */
export function expectedArgs(name: string): string {
  const tool = registry.get(name);
  if (!tool) return '';
  const argStr = Object.entries(tool.args).map(([k, hint]) => hint ? `${k}: ${hint}` : k).join(', ');
  return argStr ? `Expected: ${name}({ ${argStr} })` : `Expected: ${name}({})`;
}
