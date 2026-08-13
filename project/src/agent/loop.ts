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
// Phase 2.5 TASK2: 20s was HALF the 60s budget — it squeezed observation turns
// so hard (a turn-6 observe call at rem=25s was capped to 5s, under the model's
// real latency) that the strong model timed out on later turns and never
// reached act (proof/parse-failures: turn-8 timeouts on reduce-clutter /
// hide-sidebar). Real act calls (applyCss/insert) complete in 3-9s (gate2
// runs 1/5/6: total run 9-26s for 3-6 calls). 12s reserves ample time for the
// final act while letting observation turns run long enough to complete.
const ACT_RESERVE_MS = 12_000;  // reserve this much wall time for acting
const MIN_TURN_MS = 5_000;     // below this, no turn can complete — break

export interface ParseFailure {
  model: string;
  /** raw model output that failed JSON parsing (capped for transport). */
  raw: string;
  /** length of the original (uncapped) output. */
  len: number;
  turn: number;
  /** model error/timeout message when raw is absent (the call didn't complete). */
  error?: string;
}

export interface LoopResult {
  status: 'done' | 'gaveUp' | 'budgetExhausted' | 'error';
  summary?: string;
  reason?: string;
  journal: Journal;
  budget: Budget;
  paidCalls: number;
  wallMs: number;
  /** Phase 2.5 TASK1 — REAL parse-failure outputs, for root-cause
   *  classification. Deterministic (no async storage): collected in-loop and
   *  surfaced through the LoopResult the background returns to the popup. */
  parseFailures: ParseFailure[];
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
  // Phase 2.5 TASK1 — collect REAL malformed model outputs for root-cause
  // classification. Deterministic: surfaced via LoopResult.parseFailures.
  const parseFailures: ParseFailure[] = [];
  const recordParseFailure = (model: string | undefined, raw: string | undefined, error?: string): void => {
    // Capture both invalid-JSON outputs (raw present) AND model errors/timeouts
    // (raw absent, error present) so the root cause is classifiable either way.
    if (!raw && !error) return;
    parseFailures.push({ model: model ?? '(unknown)', raw: (raw ?? '').slice(0, 4000), len: raw?.length ?? 0, turn: budget.stepsUsed, error });
  };

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

    // D: If remaining is below ACT_RESERVE + MIN_TURN, restrict to act/verify
    // only. Observation turns may never spend the act reserve. Phase 2.5
    // adversarial review (wf_e3e50d92) found a breach in the window
    // rem ∈ (ACT_RESERVE, ACT_RESERVE + MIN_TURN): turnCap's MIN_TURN_MS floor
    // could force a 5s observation call that dips below the 12s reserve. Fix:
    // refuse observation a full MIN_TURN earlier — observation needs room for
    // a complete turn AND the reserve. (Act/verify turns own the reserve, so
    // the restrictToAct cap below is the full rem — no floor conflict there.)
    const restrictToAct = rem.wallMs <= ACT_RESERVE_MS + MIN_TURN_MS;

    // D (Phase 2.5 TASK2 — the budget-reserve invariant): an OBSERVATION turn
    // may spend at most (remaining - ACT_RESERVE_MS) so it can NEVER dip into
    // the act reserve. The old code used Math.min(rem, callTimeoutMs): at
    // rem=25s a single model call could run 25s and eat the whole 20s reserve,
    // leaving ACT with nothing — the exact failure 5/6 baseline goals hit
    // ("budget too low for retry after parse error"). The retry and the tool
    // dispatch timeout are capped the same way. Once restrictToAct is true
    // the reserve IS the acting budget, so the cap is the full remaining.
    const turnCap = restrictToAct
      ? rem.wallMs
      : Math.max(MIN_TURN_MS, rem.wallMs - ACT_RESERVE_MS);

    budget.recordStep(0);

    // E3: model tiering. Phase 2.5 TASK1 — REAL evidence (proof/transport-
    // capture*.json, 14 calls) showed the "fast" observation model
    // (@cf/zai-org/glm-4.7-flash) is SLOWER (8-25s, >30s sometimes → timeout)
    // and the cause of most parse/call failures, while the strong model
    // (@cf/zai-org/glm-5.2) is faster (1.4-3.7s) and returns valid JSON. Using
    // the flash model for the first turns burns a turn on a timeout and is the
    // dominant reason ACT is never reached. So: use the STRONG model for every
    // loop turn (the cheapest *correct* call is the one that completes). This
    // is a local change to the tier pick, not a loop redesign — the two-model
    // config and the `useFast` heuristic stay; only the default flips so the
    // loop stops spending its first turns on a model that times out.
    const lastEntry = journal.entries[journal.entries.length - 1];
    const useFast = false; // was: !hasActed && (!lastEntry || lastEntry.kind === 'observe') && !restrictToAct
    const loopModel = useFast ? AI_CONFIG.fastModel : AI_CONFIG.strongModel;

    // F + D: restricted tool list if consecutive no-info OR act reserve reached.
    // Phase 2.5: ALSO restrict at 1/3 budget. The prompt already SAYS "next
    // turn MUST be act/done/giveUp" at low budget, but the model was ignoring it
    // — run3 spent 10 turns on describePage/findElements/look/checkLayout under
    // low-budget pressure and never acted (gate3: budgetExhausted, no act).
    // Enforcing the restriction (refuse observation at low budget) makes the
    // model act or give up instead of observing its way to a timeout. Small,
    // additive — same `restricted` flag the prompt already consumes.
    const lowBudget = rem.steps <= Math.ceil(budget.maxSteps / 3) || rem.wallMs <= budget.maxWallMs / 3;
    const restricted = restrictToAct || consecutiveNoInfo >= 2 || lowBudget;
    const prompt = buildPrompt(goal, origin, path, journal, budget, restricted);

    // D: timeouts derive from remaining budget, not a constant — and are capped
    // by turnCap so observation can't breach the act reserve (TASK2).
    const callTimeout = Math.min(turnCap, AI_CONFIG.callTimeoutMs);

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

    // Retry on parse error — only if enough budget remains FOR THE RETRY AND
    // the act reserve. The old gate checked `remaining <= MIN_TURN_MS` (5s),
    // so a parse error at rem=25s passed, the retry ran up to 25s, and landed
    // at 0 — eating the entire 20s act reserve. That is the exact cause of
    // "budget too low for retry after parse error" in the baseline. Now the
    // retry only proceeds if remaining leaves room for both the retry and the
    // reserve, and the retry timeout is capped to (remaining - reserve).
    if (!modelResult.ok || !modelResult.json) {
      recordParseFailure(modelResult.model, modelResult.raw, modelResult.error);
      const remAfter = budget.remaining().wallMs;
      // Phase 2.5 TASK2: an observation turn's retry must preserve the act
      // reserve; an act turn (restrictToAct) owns the reserve, so only MIN_TURN
      // guards it. This is the fix that lets the loop REACH act after a retry.
      const retryFloor = restrictToAct ? MIN_TURN_MS : ACT_RESERVE_MS + MIN_TURN_MS;
      if (remAfter <= retryFloor) {
        await rollbackDomIfActed(tabId, journal, origin);
        await persistJournal(journal, origin);
        return { status: 'budgetExhausted', reason: 'budget too low for retry after parse error', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
      const errorMsg = modelResult.raw
        ? `Your last response was not valid JSON: ${modelResult.raw.slice(0, 200)}. Respond with a valid JSON object.`
        : `The previous model call ${modelResult.error ?? 'failed'}. Respond with one valid JSON object only.`;
      // TASK2: retry timeout capped to leave the act reserve intact when observing.
      // Phase 2.5 TASK1: cap the retry at min(retryCap, 12s) so a retry can NEVER
      // take the full 30s — if the first call timed out, the retry must fail fast
      // (affordable) instead of eating another 30s. Real evidence
      // (proof/transport-capture*.json): the slow observation model times out
      // at >30s; a second 30s retry would burn the budget. 12s is enough for a
      // normal 1-25s response, and short enough to preserve the act reserve.
      const retryCap = restrictToAct
        ? remAfter
        : Math.max(MIN_TURN_MS, remAfter - ACT_RESERVE_MS);
      modelResult = await callLoopModel({
        systemPrompt: 'You are Revueon. Respond with one JSON object only.',
        userContent: prompt + `\n\nERROR: ${errorMsg}`,
        accountId: credentials.accountId,
        apiKey: credentials.apiToken,
        timeoutMs: Math.min(retryCap, 12_000),
      });
      paidCalls++;
      if (!modelResult.ok || !modelResult.json) {
        recordParseFailure(modelResult.model, modelResult.raw, modelResult.error);
        await rollbackDomIfActed(tabId, journal, origin);
        return { status: 'error', reason: 'model returned invalid JSON twice', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
    }

    const response = modelResult.json as any;

    if (response.done) {
      const result: LoopResult = { status: 'done', summary: response.summary ?? 'Done.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      await persistJournal(journal, origin);
      return result;
    }

    if (response.giveUp) {
      await rollbackDomIfActed(tabId, journal, origin);
      return { status: 'gaveUp', reason: response.reason ?? 'Agent gave up.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
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
        const result: LoopResult = { status: 'done', summary: toolArgs.summary ?? 'Done.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
        await persistJournal(journal, origin);
        return result;
      }
      if (toolName === 'giveUp') {
        await rollbackDomIfActed(tabId, journal, origin);
        return { status: 'gaveUp', reason: toolArgs.reason ?? 'Agent gave up.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
    }

    // Dispatch the tool.
    let toolResult;
    try {
      if (tool.background) {
        toolResult = await handleBackgroundTool(tabId, toolName, toolArgs, credentials);
      } else {
        // D: dispatch timeout derives from remaining budget. Phase 2.5 TASK2:
        // an OBSERVATION dispatch (describePage/readText/findElements/perceivePage)
        // is capped to leave the act reserve intact; an ACT dispatch owns the
        // reserve (it IS the act). look/checkLayout are verify — they run in the
        // reserve window once restrictToAct, or under turnCap while observing.
        const remNow = budget.remaining().wallMs;
        const observeDispatchCap = Math.max(MIN_TURN_MS, remNow - ACT_RESERVE_MS);
        const dispatchTimeout = tool.kind === 'observe'
          ? Math.min(observeDispatchCap, 30_000)
          : Math.min(remNow, 30_000);
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
      parseFailures,
    };
  }

  // F3 (RC3): the loop exhausted budget WITHOUT calling done — the run did not
  // cleanly succeed, so roll back every change it made. (A run that fully
  // succeeded calls `done`, which persists and returns before this point.)
  await rollbackDomIfActed(tabId, journal, origin);
  return { status: 'budgetExhausted', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
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
