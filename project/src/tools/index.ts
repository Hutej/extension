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
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  description: string;     // ≤1 line, for the model prompt
  args: Record<string, string>;  // arg name → type hint
  execute: (args: any) => Promise<ToolResult>;
  stub?: boolean;          // true = not implemented in this stage (hidden from prompt)
  background?: boolean;    // true = runs in the background SW, not the content script
}

// ── control tools (undo, done, giveUp — handled by the loop, not dispatched) ──

const controlTools: ToolDef[] = [
  { name: 'undo', kind: 'control', description: 'undo the last N actions', args: { steps: 'number' }, execute: async () => ({ ok: true }) },
  { name: 'done', kind: 'control', description: 'finish with a summary', args: { summary: 'string' }, execute: async () => ({ ok: true }) },
  { name: 'giveUp', kind: 'control', description: 'give up with a reason', args: { reason: 'string' }, execute: async () => ({ ok: true }) },
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
 *  Compact: one line per tool, args inline. */
export function serializeToolList(): string {
  return allTools
    .filter((t) => t.kind !== 'control' && !t.stub)
    .map((t) => {
      const argStr = Object.entries(t.args).map(([k]) => k).join(',');
      return argStr ? `${t.name}(${argStr}) — ${t.description}` : `${t.name} — ${t.description}`;
    })
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
    .map((t) => {
      const argStr = Object.entries(t.args).map(([k]) => k).join(',');
      return argStr ? `${t.name}(${argStr}) — ${t.description}` : `${t.name} — ${t.description}`;
    })
    .join('\n');
}
