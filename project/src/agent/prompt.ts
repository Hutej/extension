/**
 * agent/prompt — build the agent prompt.
 *
 * Cap: 2,000 characters. This is NOT about context size (262K tokens is
 * plenty). It exists so judgement problems are not solved by adding rules
 * to the prompt — the exact path by which the old Architect prompt reached
 * 7,600 characters and got worse at its job. Every line added is a defeat.
 *
 * States the goal, the origin and path, the available tools, the budgets,
 * and one instruction: gather the least evidence that lets you act correctly,
 * then act. Nothing about relations, packs, languages, archetypes or laws.
 */

import { serializeToolList, serializeRestrictedToolList } from '../tools/index';
import type { Budget } from './budget';
import type { Journal } from './journal';

export function buildPrompt(
  goal: string,
  origin: string,
  path: string,
  journal: Journal,
  budget: Budget,
  restrictTools: boolean = false,
): string {
  const rem = budget.remaining();
  const toolList = restrictTools
    ? serializeRestrictedToolList()
    : serializeToolList();
  const journalStr = journal.serialize();

  // S6: budget pressure — when one third remains, the next turn must be act/done/giveUp.
  const lowBudget = rem.steps <= Math.ceil(budget.maxSteps / 3) || rem.wallMs <= budget.maxWallMs / 3;
  const budgetLine = lowBudget
    ? `BUDGET: ${rem.steps} steps and ${Math.ceil(rem.wallMs / 1000)}s left — next turn MUST be act, done, or giveUp.`
    : `BUDGET: ${rem.steps} steps left, ${Math.ceil(rem.wallMs / 1000)}s left.`;

  // S6: observe before act — track whether any observation has happened.
  const hasObserved = journal.entries.some((e: any) => e.kind === 'observe');
  const observeRule = hasObserved
    ? ''
    : '\nRULE: Observe at least once before any act. No exceptions.';

  // F + D: if restrictTools, the prompt says why the list is short.
  const restrictNote = restrictTools
    ? '\nNOTE: Observation tools are not available — act reserve reached or repeated observations without new info. Call an act tool (applyCss, hide, insert, setText, heal), verify (checkLayout, look), done, or giveUp.'
    : '';

  return `You are Revueon, an AI agent that modifies web pages. A user stated a goal. You investigate the page, gather only the evidence you need, choose the cheapest correct action, apply it, verify the result, and stop.

GOAL: ${goal}
PAGE: ${origin}${path}

TOOLS:
${toolList}

${budgetLine}${observeRule}${restrictNote}

JOURNAL:
${journalStr}

Respond with ONE JSON object:
  {"tool":"<name>","args":{...},"reasoning":"why"}  to call a tool
  {"done":true,"summary":"what you did"}            when finished
  {"giveUp":true,"reason":"why you cannot"}         when you cannot do this

Gather the least evidence that lets you act correctly, then act. Do not invent things. If you cannot find what the user refers to, give up and say why. Low confidence means do less, not guess more.

Author CSS that stays responsive — prefer Flexbox, Grid, %, fr, auto, minmax(), clamp(), fit-content, aspect-ratio over fixed px on size or position (fixed px is fine for borders, spacing, typography). Think in dimensions — Layout, Spacing, Typography, Color, Surface, Hierarchy — as open conceptual labels, not a fixed menu; add any dimension the goal calls for.

Content changes are additive: insert new content alongside the original, never replace or hide it.`;
}
