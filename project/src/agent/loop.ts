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

import { callLoopModel } from '../core/reason';
import { getTool } from '../tools/index';
import { buildPrompt } from './prompt';
import { Journal } from './journal';
import { Budget } from './budget';
import { AI_CONFIG } from '../core/config';
import { saveJournalState, scopeKey } from '../core/persist';

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

// F5: circuit-breaker on repeated checkLayout-triggered auto-undo. The loop
// can silently burn the budget re-acting-and-breaking (act → forced checkLayout
// fails → undo → act again → fails → undo …). After this many CONSECUTIVE
// checkLayout undos the loop gives up (gaveUp + rollback) instead of burning
// the whole budget. 2 = "two consecutive acts each broke the page layout, stop
// trying" — mirrors consecutiveNoInfo (which restricts at 2). The counter
// resets on a CLEAN checkLayout, so a transient break does not poison the run.
const MAX_CHECKLAYOUT_UNDOS = 2;

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

/**
 * F5: classify the result of a forced checkLayout after a successful act.
 * PURE — extracted so the loop's integrity DECISION is unit-testable without
 * the model or a live tab (adversarial review wf_21a77cf9, RUNNER major: the
 * branch logic was previously only regex-guarded, never executed by a test).
 *
 * checkLayout's contract: it returns `ok: issues.length === 0` — so `ok:false`
 * means ISSUES WERE FOUND, NOT "the check failed". A naive `clOk = !!cl.ok`
 * made every real break look like a verifier error → the undo branch + the
 * circuit-breaker were dead code. This function encodes the correct contract:
 *   - 'error'  : the dispatch failed or checkLayout itself errored (no undo;
 *                we don't KNOW the act broke, only that we couldn't verify it).
 *   - 'issues' : checkLayout found layout issues → undo the act; the caller
 *                increments the circuit-breaker and may giveUp at the cap.
 *   - 'clean'  : no issues → accept the act; the caller resets the breaker.
 */
export type CheckLayoutOutcome = 'error' | 'issues' | 'clean';
export function classifyCheckLayout(cl: any): { outcome: CheckLayoutOutcome; issues: string[]; allIssues: string[] } {
  const dispatchFailed = !cl || !!cl?.error || !cl?.result;
  if (dispatchFailed) return { outcome: 'error', issues: [], allIssues: [] };
  const issues = (cl?.result?.issues as string[] | undefined) ?? [];
  // allIssues is the UNCAPPED issue list (for baseline-diff). Falls back to the
  // capped `issues` if a checkLayout build predates the field.
  const allIssues = (cl?.result?.allIssues as string[] | undefined) ?? issues;
  if (issues.length > 0) return { outcome: 'issues', issues, allIssues };
  return { outcome: 'clean', issues: [], allIssues: [] };
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
      journal.path = path;   // F4: scope key = origin + path
    }
  } catch { /* tab might be gone */ }

  const budget = new Budget({ maxSteps: AI_CONFIG.maxSteps, maxWallMs: AI_CONFIG.maxWallMs });
  let paidCalls = 0;
  let consecutiveNoInfo = 0;
  let consecutiveCheckLayoutUndos = 0; // F5 circuit-breaker — consecutive forced-checkLayout undos
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

  // F4 (approved Q2): persisted operations are NOT replayed by the loop. The
  // content script owns page continuity (reapplyPersistedDom on load + SPA route
  // change); the background owns CSS replay (webNavigation.onCommitted +
  // onHistoryStateUpdated). The loop executing them here too was a SECOND replay
  // path → double-application, and its `stored.goal === goal` gate broke
  // cross-goal continuity (a "reduce clutter" run dropped a persisted "hide the
  // sidebar"). The loop now starts with an empty journal; the model re-observes
  // the page as it is (with persisted mods already applied). Persisted state is
  // never converted into new journal entries merely because it was replayed.

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

    // Production uses ONE model — GLM 5.2 — for every loop turn. Phase 2.5
    // evidence showed the "fast" companion model was SLOWER (8-25s, often
    // timing out >30s) and the cause of most parse/call failures, while GLM 5.2
    // is faster (1.4-3.7s) and returns valid JSON. The cheapest *correct* call
    // is the one that completes, so the second production model and its tier
    // logic were removed in Phase 6. Vision (the former `look` tool) is
    // test/QA-only and lives in tests/, not here.
    const loopModel = AI_CONFIG.strongModel;

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
        return { status: 'budgetExhausted', reason: 'the loop stopped because the remaining execution budget was insufficient to retry after a model parse error. Try a simpler request.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
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
    if (restricted && tool.kind === 'observe') {
      journal.append({ tool: toolName, kind: 'observe', args: toolArgs, result: { error: 'Observation not available — act reserve reached. Call an act tool (applyCss, hide, insert, setText, heal), done, or giveUp.' } as any, costMs: 0, timestamp: Date.now() });
      continue;
    }

    if (tool.kind === 'control') {
      if (toolName === 'undo') {
        const steps = typeof toolArgs.steps === 'number' ? toolArgs.steps : 1;
        const r = await journal.undo(steps, (inverse) => dispatchInverse(tabId, inverse));
        onProgress?.({ tool: 'undo', undone: r.undone, failed: r.failed, reason: r.reason });
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
    // F5.8 real-site fix (baseline-diff): a STATELESS post-act checkLayout
    // flags EVERY pre-existing clipped/collapsed element on a real site (Wikipedia
    // has many legitimately-clipped controls/tables), false-undoing legitimate
    // transforms. The forced check exists to catch issues the ACT INTRODUCED, so
    // we capture a PRE-ACT baseline checkLayout and diff — flag only issues NOT in
    // the baseline. (Matches the resize gate's newViolations approach.) The
    // baseline is cheap: one verify dispatch before the act; stored per-loop.
    let preActIssues: string[] | null = null;
    if (tool.kind === 'act') {
      try {
        const pre = await dispatchTool(tabId, 'checkLayout', {}, Math.min(budget.remaining().wallMs - ACT_RESERVE_MS, 20_000));
        preActIssues = (classifyCheckLayout(pre).allIssues) ?? [];
      } catch { preActIssues = null; } // baseline capture must never block an act
    }
    try {
      // D: dispatch timeout derives from remaining budget. Phase 2.5 TASK2:
      // an OBSERVATION dispatch (describePage/readText/findElements/perceivePage)
      // is capped to leave the act reserve intact; an ACT dispatch owns the
      // reserve (it IS the act). checkLayout is verify — it runs in the
      // reserve window once restrictToAct, or under turnCap while observing.
      const remNow = budget.remaining().wallMs;
      const observeDispatchCap = Math.max(MIN_TURN_MS, remNow - ACT_RESERVE_MS);
      const dispatchTimeout = tool.kind === 'observe'
        ? Math.min(observeDispatchCap, 30_000)
        : Math.min(remNow, 30_000);
      toolResult = await dispatchTool(tabId, toolName, toolArgs, dispatchTimeout);
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
      // F4: persist the act's target identity digest so reload/SPA-render can
      // re-verify the target. Only act tools set this; undefined for others.
      identityDigest: toolResult.identityDigest,
      reasoning,
      costMs: toolResult.costMs ?? 0,
      timestamp: Date.now(),
    };
    journal.append(entry);
    onProgress?.(entry);

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

    // F5 INTEGRITY: after every successful ACT, FORCE checkLayout to run (the
    // browser owns geometry, rule 8 — this is a deterministic measurement, not
    // a model decision, so it does not violate "every request goes to the
    // model"). The model could already call checkLayout itself; this guarantees
    // it. A failed check (issues) triggers UNDO, not repair (roadmap Phase 3:
    // "repairing in place produces a differently-broken result nobody planned").
    // This is additive — one extra verify turn per act — and reuses the exact
    // F3 inverse path (dispatchInverse → cloned-node undoLast for DOM, exact
    // removeCss for CSS). checkLayout itself is a verify tool already in the
    // registry; the forced call reuses the same dispatch path a model call uses.
    //
    // Three outcomes, all surfaced to the model via the journal entry:
    //  - CLEAN (ok, no issues): the act is accepted; reset the circuit-breaker.
    //  - ISSUES (ok, issues): undo the act; increment the circuit-breaker.
    //  - ERROR (the check itself failed): do NOT assume clean (that would be a
    //    false pass — a broken verifier silently accepting a maybe-broken act).
    //    Surface the error, do NOT reset the counter, do NOT undo — we don't
    //    know the act is broken, only that we couldn't check it. The model
    //    decides whether to re-check, give up, or proceed.
    if (tool.kind === 'act' && toolResult.ok && !toolResult.worse) {
      // F5 adversarial review (RUNNER blocker): checkLayout returns
      // ok: issues.length === 0 — so `ok:false` means ISSUES WERE FOUND, not
      // "the check failed". Distinguish the three cases by structure, not by
      // `ok`: ERROR = dispatch failed or `cl.error` set; ISSUES = cl.result.issues
      // non-empty (regardless of ok, since ok is false on issues); CLEAN =
      // otherwise. The old `clOk = !!cl?.ok && !cl?.error` made every real
      // break look like "checkLayout itself failed" → the undo branch + the
      // circuit-breaker were DEAD CODE. Fixed.
      //
      // F5 adversarial review (ARITHMETIC major): only run the forced check
      // when there is room for it AND a following turn without dipping below
      // MIN_TURN_MS — a forced check that runs at the reserve edge can exhaust
      // the wall budget and the act gets rolled back for the wrong reason.
      const rem = budget.remaining();
      const clTimeout = Math.max(MIN_TURN_MS, Math.min(rem.wallMs - ACT_RESERVE_MS, 30_000));
      const cl = await dispatchTool(tabId, 'checkLayout', {}, clTimeout);
      const { outcome, issues: rawIssues, allIssues: rawAll } = classifyCheckLayout(cl);
      // F5.8 baseline-diff: keep only issues the ACT INTRODUCED — after-act
      // allIssues NOT in the pre-act baseline allIssues. checkLayout now returns
      // an UNCAPPED allIssues (the display `issues` is capped for the model) so
      // the diff matches every pre-existing issue (Wikipedia has 700+) exactly.
      // Exact-string match: pre-existing issues are byte-identical pre/post for
      // unchanged elements. A normalized-key fallback covers a label that
      // shifts a few chars. If the baseline capture failed (null), flag all
      // (conservative — better a false-undo than a false-pass with no baseline).
      const normKey = (s: string) => {
        const m = s.match(/^([^:]+: <[a-z0-9]+> )"([^"]{0,12})/);
        return m ? m[1] + m[2] : s.slice(0, 40);
      };
      const clIssues = preActIssues
        ? rawAll.filter((iss) => !preActIssues.includes(iss) && !preActIssues.some((b) => normKey(b) === normKey(iss)))
        : rawIssues;
      const diffedOutcome: 'issues' | 'clean' = outcome === 'error' ? 'clean' : (clIssues.length > 0 ? 'issues' : 'clean');
      const clEntry = {
        tool: 'checkLayout', kind: 'verify' as const, args: {},
        result: cl?.result ?? { error: cl?.error ?? 'checkLayout dispatch failed' },
        confidence: cl?.confidence, reasoning: 'forced integrity check after act',
        costMs: cl?.costMs ?? 0, timestamp: Date.now(),
      };
      journal.append(clEntry);
      onProgress?.(clEntry);
      if (outcome === 'error') {
        // Verifier error — surface it, don't assume clean, don't undo. We don't
        // KNOW the act is broken, only that we couldn't check it.
        (clEntry.result as any).message = 'checkLayout itself failed — could not verify the page is not broken. Re-run checkLayout, or give up if you cannot verify.';
      } else if (diffedOutcome === 'issues') {
        const u = await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
        if (u.undone > 0) {
          consecutiveCheckLayoutUndos++;
          (clEntry.result as any).autoUndone = true;
          (clEntry.result as any).message = `checkLayout found ${clIssues.length} NEW issue(s) (pre-existing baseline issues excluded): ${clIssues.join('; ')}. The last action was automatically undone — the page's layout would have been broken. Try a different approach or give up.`;
        } else if (u.failed > 0) {
          // F1: the undo did NOT restore the DOM (stale/wrong-target — the page
          // re-rendered so the selector now resolves to a different element).
          // Do NOT count this as a clean undo or bump the circuit breaker — the
          // act is still live on the page (journal kept the entry). Surface the
          // failure so the model knows the break is still there and must undo
          // it itself (the `undo` control tool) or give up. Rule 13: a swallowed
          // failure here would have the loop report success on a still-broken page.
          (clEntry.result as any).autoUndone = false;
          (clEntry.result as any).undoFailed = true;
          (clEntry.result as any).message = `checkLayout found ${clIssues.length} NEW issue(s) but the automatic undo FAILED to restore the DOM (${u.reason ?? 'stale/wrong-target'}). The action is still on the page. Call the undo tool (steps: 1) to retry, or give up.`;
        }
        if (consecutiveCheckLayoutUndos >= MAX_CHECKLAYOUT_UNDOS) {
          await rollbackDomIfActed(tabId, journal, origin);
          return {
            status: 'gaveUp', reason: `giving up: ${consecutiveCheckLayoutUndos} consecutive actions each broke the page layout (checkLayout failed). The page has been rolled back to its original state.`,
            journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures,
          };
        }
      } else {
        // CLEAN — reset the circuit-breaker. The streak counts BACK-TO-BACK
        // break→undo with no successful act in between; a clean checkLayout
        // means the act SUCCEEDED (the page is good), which terminates the
        // streak. (A clean after an undo = the undo restored the page → not a
        // streak; a clean after a fresh act = the act worked. Both reset.)
        consecutiveCheckLayoutUndos = 0;
      }
    }
  }

  // D: if the loop ended without acting or giving up, that is a loop-level
  // failure. Report it as one — not a model behavior issue.
  if (!hasActed) {
    await persistJournal(journal, origin);
    return {
      status: 'budgetExhausted',
      reason: 'the loop stopped because the remaining execution budget was insufficient to act. Try a simpler request, or rephrase so less observation is needed.',
      journal, budget, paidCalls, wallMs: budget.elapsedMs(),
      parseFailures,
    };
  }

  // F3 (RC3): the loop exhausted budget WITHOUT calling done — the run did not
  // cleanly succeed, so roll back every change it made. (A run that fully
  // succeeded calls `done`, which persists and returns before this point.)
  await rollbackDomIfActed(tabId, journal, origin);
  return { status: 'budgetExhausted', reason: 'the loop stopped because the remaining execution budget was insufficient to finish. The actions taken this run were rolled back to keep the page intact. Try a simpler request.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
}

// ── helpers ────────────────────────────────────────────────────────

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
 *  via chrome.scripting.removeCSS — no content script round trip.
 *
 *  F5: DOM inverses (restoreText/restoreHtml) route through the content-script
 *  TransactionLog's exact cloned-node `undoLast`, NOT a lossy innerHTML
 *  re-parse. Law 7: textContent/innerHTML is never a valid in-session inverse —
 *  the cloned subtree the act captured is still in the content-script log, so
 *  use it. This is the shared dispatch the `undo` control tool, the checkLayout
 *  auto-undo, and the P10 worse-undo all use, so fixing it here fixes every
 *  per-step undo path at once (root cause, not symptom). undoLast undoes the
 *  single most-recent structural op; because recordStructural + journal.append
 *  happen in the same order inside one tool execute, the popped entry is the
 *  matching one.
 *
 *  F1 (adversarial review wf): AWAIT the content-script reply and report failure.
 *  The old `() => resolve()` discarded {undone, failed, reason} — so a
 *  stale/wrong-target undo (the page re-rendered so aside#sb is now a different
 *  element → fingerprint mismatch → undoLast throws) was silently swallowed:
 *  journal.undo counted it as undone, the loop set autoUndone:true and bumped
 *  the circuit breaker, and the model was told the undo succeeded while the
 *  page kept the broken mutation. Now dispatch reports {ok:false, failed, reason}
 *  when undoLast failed, and journal.undo keeps the entry + counts it failed.
 *
 *  POST-RELOAD fallback (the clone is gone): content.ts undoPersistedDom reads
 *  the persisted journal and calls restoreHtmlLocal directly — fully
 *  content-side, no message round trip, no Node crossing the boundary. */
async function dispatchInverse(
  tabId: number,
  inverse: any,
): Promise<{ ok: boolean; failed?: number; reason?: string }> {
  if (!inverse) return { ok: true };
  if (inverse.kind === 'removeCss') {
    try {
      await chrome.scripting.removeCSS({ target: { tabId }, css: inverse.css, origin: 'USER' });
      return { ok: true };
    } catch { /* tab may be gone */ return { ok: true }; /* best-effort CSS removal */ }
  } else if (inverse.kind === 'restoreText' || inverse.kind === 'restoreHtml') {
    // Exact in-session undo via the cloned-node TransactionLog. AWAIT the reply
    // so a stale/wrong-target undo is reported, not swallowed.
    const reply = await new Promise<any>((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'undoLast' }, (response) => resolve(response));
    });
    if (reply && reply.failed > 0) {
      return { ok: false, failed: reply.failed, reason: reply.reason };
    }
    return { ok: true };
  }
  return { ok: true };
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
  //    F1 (adversarial review wf): AWAIT the reply and surface a dirty rollback.
  //    The old `() => resolve()` discarded {undone, failed}, so a stale/wrong-
  //    target undo (left un-consumed by undoLast so undoAll retries it here) was
  //    silently dropped — the loop reported a clean rollback while one mutation
  //    stayed on the page. Now a non-zero `failed` is surfaced (console.warn,
  //    visible in the content-script log) so a dirty rollback is never silent.
  const undoReply = await new Promise<any>((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'undoAll' }, (response) => resolve(response));
  });
  if (undoReply?.failed > 0) {
    console.warn(`[Revueon] F1: terminal rollback could not fully restore the DOM — ${undoReply.failed} structural undo(s) failed (stale/wrong-target). ${undoReply.undone} of ${(undoReply.undone ?? 0) + (undoReply.failed ?? 0)} restored. The page may still carry a mutation; storage has been cleared so a reload restores the original.`);
  }
  // 3. Drop the persisted journal state for this scope so a reload doesn't
  //    re-apply a failed/partial transform. (CSS + DOM both undone above;
  //    clearing storage prevents the webNavigation re-insert path reviving it.)
  // F4: key by origin + path (scopeKey), not origin only.
  try {
    if (origin) {
      const key = scopeKey(origin + journal.path);
      await saveJournalState(key, { enabled: false, origin: '', path: '', goal: '', entries: [], createdAt: Date.now() });
    }
  } catch { /* ignore */ }
}

/** F4: persist by scope (origin + path). The journal holds both; scopeKey
 *  composes the key. Uses toPersistableState() — the persisted state STRIPS
 *  cleartext page content (observe entries, act results, inverse.prevHtml),
 *  keeping only the replay-relevant fields + the removeCss CSS (our output) +
 *  the SHA-256 identityDigest. See Journal.toPersistableState. */
async function persistJournal(journal: Journal, origin: string): Promise<void> {
  try {
    if (origin) {
      const key = scopeKey(origin + journal.path);
      await saveJournalState(key, journal.toPersistableState());
    }
  } catch { /* ignore persistence errors */ }
}
