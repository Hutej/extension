/**
 * agent/loop — the main agent loop. Brain in the background service worker.
 *
 *   goal + origin/path in
 *   → ask the model what it needs to know
 *   → run that tool, append result to the journal
 *   → ask again with the journal; enough evidence?
 *        no  → observe one level deeper
 *        yes → act
 *   → apply IMMEDIATELY, never accumulate a batch
 *   → read the page back, compare to reality not to the plan
 *        worse → undo, try something else
 *   → done / giveUp / budget exhausted
 *
 * D: The budget guard reserves time for acting. Observation turns may
 * never spend the act reserve. When the reserve is reached, the loop
 * RESTRICTS available tools to act and verify only — it does not break.
 * A run must never end without either acting or stating why it could not.
 */

import { callLoopModel, callVisionModel } from '../core/reason';
import { getTool } from '../tools/index';
import { buildPrompt } from './prompt';
import { Journal } from './journal';
import { Budget } from './budget';
import { AI_CONFIG } from '../core/config';
import { saveJournalState, originKey, loadJournalState } from '../core/persist';

// D: Budget gate constants.
const ACT_RESERVE_MS = 20_000;  // reserve this much wall time for acting
const MIN_TURN_MS = 5_000;     // below this, no turn can complete — break

export interface LoopResult {
  status: 'done' | 'gaveUp' | 'budgetExhausted' | 'error';
  summary?: string;
  reason?: string;
  journal: Journal;
  budget: Budget;
  paidCalls: number;
  wallMs: number;
}

export interface LoopCredentials {
  accountId: string;
  apiToken: string;
}

export async function runLoop(
  goal: string,
  tabId: number,
  credentials: LoopCredentials,
  onProgress?: (entry: any) => void,
): Promise<LoopResult> {
  const journal = new Journal();
  journal.goal = goal;

  let origin = '';
  let path = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      const u = new URL(tab.url);
      origin = u.origin;
      path = u.pathname;
      journal.origin = origin;
    }
  } catch { /* tab might be gone */ }

  const budget = new Budget({ maxSteps: AI_CONFIG.maxSteps, maxWallMs: AI_CONFIG.maxWallMs });
  let paidCalls = 0;
  let consecutiveNoInfo = 0;
  let hasActed = false;

  // Replay persisted DOM mutations for this origin (CSS is handled by webNavigation).
  try {
    const key = originKey(origin);
    const stored = await loadJournalState(key);
    if (stored.entries?.length && stored.goal === goal) {
      for (const entry of stored.entries) {
        if (entry.kind === 'act') {
          const inv = entry.inverse as any;
          if (inv?.kind === 'removeCss') continue; // CSS — background handles
          await dispatchTool(tabId, entry.tool, entry.args);
          journal.entries.push(entry);
        }
      }
    }
  } catch { /* ignore replay errors */ }

  while (!budget.exhausted()) {
    const rem = budget.remaining();

    // D: If remaining is below MIN_TURN, no turn can complete — break.
    if (rem.wallMs <= MIN_TURN_MS) break;

    // D: If remaining is below ACT_RESERVE, restrict to act/verify only.
    // Observation turns may never spend the act reserve.
    const restrictToAct = rem.wallMs <= ACT_RESERVE_MS;

    budget.recordStep(0);

    // E3: model tiering — fast model for observation, strong for act.
    const lastEntry = journal.entries[journal.entries.length - 1];
    const useFast = !hasActed && (!lastEntry || lastEntry.kind === 'observe') && !restrictToAct;
    const loopModel = useFast ? AI_CONFIG.fastModel : AI_CONFIG.strongModel;

    // F + D: restricted tool list if consecutive no-info OR act reserve reached.
    const restricted = restrictToAct || consecutiveNoInfo >= 2;
    const prompt = buildPrompt(goal, origin, path, journal, budget, restricted);

    // D: timeouts derive from remaining budget, not a constant.
    const callTimeout = Math.min(rem.wallMs, AI_CONFIG.callTimeoutMs);

    const callStart = Date.now();
    let modelResult = await callLoopModel({
      systemPrompt: 'You are Revueon. Respond with one JSON object only.',
      userContent: prompt,
      accountId: credentials.accountId,
      apiKey: credentials.apiToken,
      model: loopModel,
      temperature: 0,
      timeoutMs: callTimeout,
    });
    paidCalls++;

    // Retry on parse error — only if enough budget remains.
    if (!modelResult.ok || !modelResult.json) {
      if (budget.remaining().wallMs <= MIN_TURN_MS) {
        await rollbackDomIfActed(tabId, journal, origin);
        await persistJournal(journal, origin);
        return { status: 'budgetExhausted', reason: 'budget too low for retry after parse error', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
      }
      const errorMsg = modelResult.raw
        ? `Your last response was not valid JSON: ${modelResult.raw.slice(0, 200)}. Respond with a valid JSON object.`
        : `Model error: ${modelResult.error}. Respond with a valid JSON object.`;
      modelResult = await callLoopModel({
        systemPrompt: 'You are Revueon. Respond with one JSON object only.',
        userContent: prompt + `\n\nERROR: ${errorMsg}`,
        accountId: credentials.accountId,
        apiKey: credentials.apiToken,
        timeoutMs: Math.min(budget.remaining().wallMs, AI_CONFIG.callTimeoutMs),
      });
      paidCalls++;
      if (!modelResult.ok || !modelResult.json) {
        await rollbackDomIfActed(tabId, journal, origin);
        return { status: 'error', reason: 'model returned invalid JSON twice', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
      }
    }

    const response = modelResult.json as any;

    if (response.done) {
      const result: LoopResult = { status: 'done', summary: response.summary ?? 'Done.', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
      await persistJournal(journal, origin);
      return result;
    }

    if (response.giveUp) {
      await rollbackDomIfActed(tabId, journal, origin);
      return { status: 'gaveUp', reason: response.reason ?? 'Agent gave up.', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
    }

    const toolName = response.tool as string;
    const toolArgs = response.args ?? {};
    const reasoning = response.reasoning ?? '';

    const tool = getTool(toolName);
    if (!tool) {
      journal.append({ tool: toolName, kind: 'observe', args: toolArgs, result: { error: `unknown tool: ${toolName}. Available tools are in the tool list above.` } as any, costMs: 0, timestamp: Date.now() });
      continue;
    }

    // D: If restricted and the model called an observation tool, refuse.
    if (restricted && tool.kind === 'observe' && toolName !== 'look') {
      journal.append({ tool: toolName, kind: 'observe', args: toolArgs, result: { error: 'Observation not available — act reserve reached. Call an act tool (applyCss, hide, insert, setText, heal), done, or giveUp.' } as any, costMs: 0, timestamp: Date.now() });
      continue;
    }

    if (tool.kind === 'control') {
      if (toolName === 'undo') {
        const steps = typeof toolArgs.steps === 'number' ? toolArgs.steps : 1;
        const undone = await journal.undo(steps, (inverse) => dispatchInverse(tabId, inverse));
        onProgress?.({ tool: 'undo', undone });
        continue;
      }
      if (toolName === 'done') {
        const result: LoopResult = { status: 'done', summary: toolArgs.summary ?? 'Done.', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
        await persistJournal(journal, origin);
        return result;
      }
      if (toolName === 'giveUp') {
        await rollbackDomIfActed(tabId, journal, origin);
        return { status: 'gaveUp', reason: toolArgs.reason ?? 'Agent gave up.', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
      }
    }

    // Dispatch the tool.
    let toolResult;
    try {
      if (tool.background) {
        toolResult = await handleBackgroundTool(tabId, toolName, toolArgs, credentials);
      } else {
        // D: dispatch timeout derives from remaining budget.
        const dispatchTimeout = Math.min(budget.remaining().wallMs, 30_000);
        toolResult = await dispatchTool(tabId, toolName, toolArgs, dispatchTimeout);
      }
    } catch (err) {
      toolResult = { ok: false, error: (err as Error).message };
    }
    paidCalls += toolResult?.httpRequests ?? 0;

    const entry = {
      tool: toolName,
      kind: tool.kind,
      args: toolArgs,
      result: toolResult.result ?? { error: toolResult.error },
      confidence: toolResult.confidence,
      inverse: toolResult.inverse,
      reasoning,
      costMs: toolResult.costMs ?? 0,
      timestamp: Date.now(),
    };
    journal.append(entry);
    onProgress?.(entry);

    budget.recordCallDuration(Date.now() - callStart);

    // F: track consecutive observations that return no new information.
    if (tool.kind === 'observe') {
      const r = entry.result as any;
      const noInfo = (r.matches?.length === 0) || (r.error) || (r.regionCount === 0) ||
        (toolName === 'readText' && r.error);
      if (noInfo) consecutiveNoInfo++;
      else consecutiveNoInfo = 0;
    } else if (tool.kind === 'act') {
      hasActed = true;
      consecutiveNoInfo = 0;
    }

    budget.totalCostMs += entry.costMs;

    // P10: if the action made things worse, undo immediately.
    if (tool.kind === 'act' && toolResult.worse) {
      await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
    }

    // F5: a failed checkLayout triggers undo, not repair.
    if (toolName === 'checkLayout' && toolResult.result?.issues?.length > 0) {
      const undone = await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
      if (undone > 0) {
        (toolResult.result as any).autoUndone = true;
        (toolResult.result as any).message = 'checkLayout found issues — last action was automatically undone. Try a different approach or give up.';
      }
    }
  }

  // D: if the loop ended without acting or giving up, that is a loop-level
  // failure. Report it as one — not a model behavior issue.
  if (!hasActed) {
    await persistJournal(journal, origin);
    return {
      status: 'budgetExhausted',
      reason: 'loop exhausted budget without acting or giving up',
      journal, budget, paidCalls, wallMs: budget.elapsedMs(),
    };
  }

  // F3 (RC3): the loop exhausted budget WITHOUT calling done — the run did not
  // cleanly succeed, so roll back every change it made. (A run that fully
  // succeeded calls `done`, which persists and returns before this point.)
  await rollbackDomIfActed(tabId, journal, origin);
  return { status: 'budgetExhausted', journal, budget, paidCalls, wallMs: budget.elapsedMs() };
}

// ── helpers ────────────────────────────────────────────────────────

async function handleBackgroundTool(tabId: number, toolName: string, args: any, credentials: LoopCredentials): Promise<any> {
  if (toolName === 'look') {
    return handleLook(tabId, args, credentials);
  }
  return { ok: false, error: `unknown background tool: ${toolName}` };
}

async function handleLook(tabId: number, args: any, credentials: LoopCredentials): Promise<any> {
  const prompt = args?.prompt as string | undefined;
  try {
    const dataUrl: string = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tabId, { format: 'png' }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
    const vision = await callVisionModel({
      imageDataUrl: dataUrl,
      prompt,
      accountId: credentials.accountId,
      apiKey: credentials.apiToken,
    });
    return {
      ok: vision.ok,
      result: { description: vision.description },
      confidence: vision.ok ? 0.9 : 0.2,
      error: vision.error,
      costMs: 0,
      httpRequests: vision.httpRequests,
    };
  } catch (err) {
    return { ok: false, error: `look failed: ${(err as Error).message}. Try checkLayout instead for physics-based verification.`, costMs: 0 };
  }
}

/** D: dispatch timeout derives from remaining budget. */
function dispatchTool(tabId: number, toolName: string, args: any, timeoutMs: number = 30_000): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'tool call timed out' }); } }, timeoutMs);
    chrome.tabs.sendMessage(tabId, { action: 'toolCall', tool: toolName, args }, (response) => {
      if (done) return; done = true; clearTimeout(t);
      if (chrome.runtime.lastError || !response) resolve({ ok: false, error: chrome.runtime.lastError?.message || 'no response from content script' });
      else resolve(response);
    });
  });
}

/** A: dispatch an inverse. removeCss is handled directly in the background
 *  via chrome.scripting.removeCSS — no content script round trip. */
async function dispatchInverse(tabId: number, inverse: any): Promise<void> {
  if (!inverse) return;
  if (inverse.kind === 'removeCss') {
    try {
      await chrome.scripting.removeCSS({ target: { tabId }, css: inverse.css, origin: 'USER' });
    } catch { /* tab may be gone */ }
  } else if (inverse.kind === 'restoreText') {
    await dispatchRestoreHtml(tabId, inverse.selector, inverse.prevHtml, true);
  } else if (inverse.kind === 'restoreHtml') {
    await dispatchRestoreHtml(tabId, inverse.selector, inverse.prevHtml, inverse.isInside);
  }
}

function dispatchRestoreHtml(tabId: number, selector: string, prevHtml: string, isInside: boolean): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'restoreHtml', selector, prevHtml, isInside }, () => resolve());
  });
}

/** F3 (RC3 fix): on a terminal loop failure, roll back EVERY change the run
 *  made so a failed/partial transform never leaves the page modified.
 *  CSS first (background removeCss for each act entry's removeCss inverse),
 *  then structural DOM (content-script undoAll — cloned-node exact for
 *  setText/insert). No-op if the run made no act changes. The loop's structure,
 *  budget tiers, and model-tiering are untouched — this is the ONLY new
 *  failure-path site, additive to the existing single-step undo(1). */
async function rollbackDomIfActed(tabId: number, journal: Journal, origin: string): Promise<void> {
  const actEntries = journal.entries.filter((e) => e.kind === 'act' && e.inverse);
  if (!actEntries.length) return;
  // 1. CSS off first — remove every removeCss inverse (avoids a flash of wrong
  //    layout from a display:none staying on while a structural reattach runs).
  for (const entry of actEntries) {
    const inv = entry.inverse as any;
    if (inv?.kind === 'removeCss' && inv.css) {
      try {
        await chrome.scripting.removeCSS({ target: { tabId }, css: inv.css, origin: 'USER' });
      } catch { /* tab may be gone */ }
    }
  }
  // 2. Structural undo — the content-script TransactionLog replays its cloned-
  //    node inverses backwards. Returns {undone, failed}; we don't throw on
  //    failed (one failed undo must not abandon the rest — per-op try/catch).
  await new Promise<void>((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'undoAll' }, () => resolve());
  });
  // 3. Drop the persisted journal state for this run so a reload doesn't
  //    re-apply a failed/partial transform. (CSS + DOM both undone above;
  //    clearing storage prevents the webNavigation re-insert path reviving it.)
  try {
    if (origin) {
      const key = originKey(origin);
      await saveJournalState(key, { enabled: false, origin: '', goal: '', entries: [], createdAt: Date.now() });
    }
  } catch { /* ignore */ }
}

/** D: persist by origin only — not origin + path. */
async function persistJournal(journal: Journal, origin: string): Promise<void> {
  try {
    if (origin) {
      const key = originKey(origin);
      await saveJournalState(key, journal.toState());
    }
  } catch { /* ignore persistence errors */ }
}
