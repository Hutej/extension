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
import { buildPrompt, SYSTEM_PROMPT } from './prompt';
import { Journal } from './journal';
import { Budget, disposeTerminalRun, diffNewIssues, classifyResizeProof } from './budget';
import { attemptContrastRecovery, newContrastFailures, isContrastOnlyIssues, type ContrastFailure } from './recover';
export { disposeTerminalRun }; // back-compat re-export
import { AI_CONFIG } from '../core/config';
import { saveJournalState, loadJournalState, scopeKey, mergeLiveScopeEntries, trimScopeEntries, actIdentity } from '../core/persist';
import { shouldRefuseDone } from './journal';

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

// T3 resize proof: the narrow width the proof tests (CSS px). 480 sits below
// every desktop layout's comfort zone but above the tiny-phone range — wide
// enough that OS window clamping usually permits it, narrow enough to break
// fixed-px layouts built for 1000px+ canvases. The CURRENT viewport is already
// covered by the forced per-act checkLayout, so narrow is the missing case.
const NARROW_WIDTH = 480;



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
export function classifyCheckLayout(cl: any): { outcome: CheckLayoutOutcome; issues: string[]; allIssues: string[]; warnings: string[]; allWarnings: string[]; innerWidth?: number } {
  const dispatchFailed = !cl || !!cl?.error || !cl?.result;
  if (dispatchFailed) return { outcome: 'error', issues: [], allIssues: [], warnings: [], allWarnings: [] };
  const issues = (cl?.result?.issues as string[] | undefined) ?? [];
  // allIssues is the UNCAPPED issue list (for baseline-diff). Falls back to the
  // capped `issues` if a checkLayout build predates the field.
  const allIssues = (cl?.result?.allIssues as string[] | undefined) ?? issues;
  // T3: the WARNING tier (low contrast that is not invisible). Same fallback
  // shape for older builds; allWarnings feeds its own baseline diff and is
  // NEVER auto-undone.
  const warnings = (cl?.result?.warnings as string[] | undefined) ?? [];
  const allWarnings = (cl?.result?.allWarnings as string[] | undefined) ?? warnings;
  const innerWidth = typeof cl?.result?.innerWidth === 'number' ? cl.result.innerWidth as number : undefined;
  if (issues.length > 0) return { outcome: 'issues', issues, allIssues, warnings, allWarnings, innerWidth };
  return { outcome: 'clean', issues: [], allIssues, warnings, allWarnings, innerWidth };
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
  /**
   * R0 benchmark overrides — set from chrome.storage.local by the background
   * (`revueon_model_override` etc.) so model variants can be A/B'd WITHOUT
   * rebuilding the bundle. Undefined/empty in production → AI_CONFIG defaults.
   */
  modelOverride?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export async function runLoop(
  goal: string,
  tabId: number,
  credentials: LoopCredentials,
  onProgress?: (entry: any) => void,
  /** askUser — ask the human a clarifying question (options + free text).
   *  Provided by the background (popup round-trip). When absent the tool
   *  refuses with guidance (a model without a UI must reason, not ask). */
  askUser?: (question: string, options: string[]) => Promise<string>,
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
  // T2 reliability: is the page's current act-state verified clean by the
  // forced post-act checkLayout? Set true on a CLEAN check; unchanged on a
  // check error (unknown) or after a successful auto-undo (restores the prior
  // verified state); set FALSE when an auto-undo FAILS (possibly-broken page).
  let verifiedClean = false;
  // T3 resize proof: the page's issues at the NARROW width WITHOUT our
  // transformation (the site's own narrow-width behavior), captured once
  // before the first layout-affecting act. null = not captured yet (or the
  // window could not be resized — the proof then skips honestly).
  let narrowBaseline: { allIssues: string[]; innerWidth: number } | null = null;
  let narrowAttempted = false; // one capture attempt per run — a skipped proof is journalled once, not per act
  let wideInnerWidth = 0;
  // R2 convergence guard: consecutive applyCss acts with visibleChange === false.
  let noVisibleStreak = 0;
  // R3d: bounded contrast recovery — used AT MOST ONCE per run. The flag is
  // the mechanical hard bound (never reset, checked before the attempt): the
  // run can never chain primary → repair → repair, no matter what the model
  // or the page does. Proven flow: R3c (harness), graduated in R3d.
  let contrastRecoveryUsed = false;
  // Genuine first reply: forwarded once via onProgress when the model's first
  // response arrives (its reasoning IS the ack — no hardcoded claim).
  let firstReplyDelivered = false;
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
    // only. Observation turns may never SPEND the act reserve via tool
    // RESTRICTION (restrictToAct refuses observation tools here). T2
    // reliability: the reserve no longer shrinks TIMEouts — the old
    // turnCap derivation (`max(MIN_TURN, rem − RESERVE)`) manufactured the
    // late-run timeouts that rolled back verified transformations
    // (proof/T2R_DECISION.md §C). Timeouts are now bounded only by the
    // per-call constant and the remaining wall clock.
    const restrictToAct = rem.wallMs <= ACT_RESERVE_MS + MIN_TURN_MS;

    budget.recordStep(0);

    // Production uses ONE model — GLM 5.2 — for every loop turn. Phase 2.5
    // evidence showed the "fast" companion model was SLOWER (8-25s, often
    // timing out >30s) and the cause of most parse/call failures, while GLM 5.2
    // is faster (1.4-3.7s) and returns valid JSON. The cheapest *correct* call
    // is the one that completes, so the second production model and its tier
    // logic were removed in Phase 6. Vision (the former `look` tool) is
    // test/QA-only and lives in tests/, not here.
    const loopModel = credentials.modelOverride || AI_CONFIG.strongModel;

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

    // T2 RELIABILITY: the per-call timeout is the constant cap bounded only by
    // what is actually left — NOT by (remaining − act reserve). The old
    // derivation manufactured late-run timeouts: at rem=15s a model needing
    // 8-20s got a 3-5s cap, timed out, and the parse path rolled back VERIFIED
    // work (proof/T2R_DECISION.md §C). The act reserve keeps its BEHAVIORAL
    // role (restrictToAct gates which tools observation turns may call); it no
    // longer shrinks timeouts.
    const callTimeout = Math.min(rem.wallMs, AI_CONFIG.callTimeoutMs);

    let modelResult = await callLoopModel({
      systemPrompt: SYSTEM_PROMPT,
      userContent: prompt,
      accountId: credentials.accountId,
      apiKey: credentials.apiToken,
      model: loopModel,
      temperature: 0,
      timeoutMs: callTimeout,
      reasoningEffort: credentials.reasoningEffort,
      maxTokens: credentials.maxTokens,
    });
    paidCalls++;

    // Retry on parse error — one retry, gated by remaining wall time (no
    // unlimited retries; a retry is only worth attempting while the failure
    // could be transient). T2 RELIABILITY: when the loop cannot retry, the
    // terminal disposition policy decides keep-vs-rollback — verified work is
    // no longer destroyed because the model became unreachable.
    if (!modelResult.ok || !modelResult.json) {
      recordParseFailure(modelResult.model, modelResult.raw, modelResult.error);
      const remAfter = budget.remaining().wallMs;
      // Below this, no retry can complete — go to the terminal disposition.
      const retryFloor = MIN_TURN_MS;
      if (remAfter <= retryFloor) {
        if (disposeTerminalRun(hasActed, verifiedClean) === 'rollback') {
          // REFINE MERGE: rollback already wrote the trimmed scope state —
          // persisting the session journal afterwards would re-save the acts
          // the rollback just removed from the page (they would resurrect on
          // reload). The keep branch persists; the rollback branch does not.
          await rollbackDomIfActed(tabId, journal, origin);
        } else {
          await persistJournal(journal, origin);
        }
        const kept = hasActed && verifiedClean;
        return { status: 'budgetExhausted', reason: kept
          ? `the model became unreachable (${modelResult.error ?? 'invalid output'}) after the transformation was applied and verified (layout check clean). The verified work was kept; refinement stopped early.`
          : `the model became unreachable (${modelResult.error ?? 'invalid output'}) before any change was applied. Nothing was modified — try again.`,
          journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
      const errorMsg = modelResult.raw
        ? `Your last response was not valid JSON: ${modelResult.raw.slice(0, 200)}. Respond with a valid JSON object.`
        : `The previous model call ${modelResult.error ?? 'failed'}. Respond with one valid JSON object only.`;
      // T2 RELIABILITY: the retry timeout is the per-call constant bounded by
      // what is left — the old min(retryCap, 12s) assumed a 60s budget and
      // guaranteed the retry of a slow call would also die.
      modelResult = await callLoopModel({
        systemPrompt: SYSTEM_PROMPT,
        userContent: prompt + `\n\nERROR: ${errorMsg}`,
        accountId: credentials.accountId,
        apiKey: credentials.apiToken,
        model: loopModel,
        timeoutMs: Math.min(remAfter, AI_CONFIG.callTimeoutMs),
        reasoningEffort: credentials.reasoningEffort,
        maxTokens: credentials.maxTokens,
      });
      paidCalls++;
      if (!modelResult.ok || !modelResult.json) {
        recordParseFailure(modelResult.model, modelResult.raw, modelResult.error);
        if (disposeTerminalRun(hasActed, verifiedClean) === 'rollback') {
          await rollbackDomIfActed(tabId, journal, origin);
          return { status: 'error', reason: 'model returned invalid JSON twice', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
        }
        // Verified work exists — keep it (honest status: the budget/run ended,
        // not a clean done; the reason carries the transport failure).
        // T4 honesty fix (evidence: mdn-minimal died with 0 acts yet the old
        // message claimed a transformation was applied): the message must
        // match what actually happened.
        await persistJournal(journal, origin);
        return { status: 'budgetExhausted', reason: (hasActed && verifiedClean)
          ? `the model became unreachable (${modelResult.error ?? 'invalid output'}) after the transformation was applied and verified (layout check clean). The verified work was kept; refinement stopped early.`
          : `the model became unreachable (${modelResult.error ?? 'invalid output'}) before any change was applied. Nothing was modified — try again.`, journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
    }

    const response = modelResult.json as any;

    // First agent reply to the user. The model's own opening reasoning IS the
    // acknowledgment the user reads (popup: "Revueon: …", page overlay) — the
    // product deliberately ships no canned acknowledgment. Delivered exactly
    // once, on the first parsed model response; subsequent turns' reasoning
    // already reaches the user through their journal entries.
    if (!firstReplyDelivered) {
      const replyText = typeof response.reasoning === 'string' && response.reasoning.trim()
        ? response.reasoning.trim()
        : typeof response.summary === 'string' && response.summary.trim() ? response.summary.trim() : '';
      if (replyText) {
        firstReplyDelivered = true;
        onProgress?.({ tool: 'reply', kind: 'reply', reasoning: replyText });
      }
    }

    if (response.done) {
      // R2 done-gate: an all-no-op CSS run cannot ship as done — every
      // applyCss act reported visibleChange:false, so the delivered
      // transformation IS the original page (T5/T6 class). Refuse, name the
      // recovery path (rule 13), let the model re-scope or giveUp.
      if (shouldRefuseDone(journal.entries as any)) {
        journal.append({ tool: 'note', kind: 'observe' as const, args: {}, result: { error: 'done refused: every applyCss act reported NO VISIBLE CHANGE — the page as delivered is pixel-identical to the original. The rules are being shadowed by the elements that actually paint this content. Call findElements on the region the goal names, re-scope the CSS to those elements, or giveUp.' } as any, reasoning: 'done-gate: no visible effect in the run', costMs: 0, timestamp: Date.now() });
        continue;
      }
      // T3 resize proof at done: verified work must survive a narrower
      // viewport (Law 6). NEW narrow-width issues → undo the last act, tell
      // the model, keep going (the breaker caps the retry loop). The proof
      // never destroys on 'error' (unmeasurable ≠ broken).
      const proofGate = await runResizeProofGate();
      if (proofGate === 'fatal') {
        await rollbackDomIfActed(tabId, journal, origin);
        return { status: 'gaveUp', reason: 'giving up: repeated actions each broke the page at a narrow viewport (resize proof). The page has been rolled back to its original state.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
      }
      if (proofGate === 'issues') continue; // journal entry appended; the model refines
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
      // askUser — the agent asks the human when the request is genuinely
      // ambiguous. The answer is evidence (observe-kind journal entry);
      // the loop does not interpret it — the model does, next turn.
      if (toolName === 'askUser') {
        const question = String(toolArgs.question ?? '').trim();
        const options = Array.isArray(toolArgs.options) ? toolArgs.options.map(String).slice(0, 4) : [];
        if (!question) {
          journal.append({ tool: 'askUser', kind: 'observe', args: toolArgs, result: { error: 'missing "question" argument. Ask one clear question, e.g. {"tool":"askUser","args":{"question":"Hide the sidebar completely, or collapse it?","options":["Hide completely","Collapse"]}}' } as any, costMs: 0, timestamp: Date.now() });
          continue;
        }
        if (!askUser) {
          journal.append({ tool: 'askUser', kind: 'observe', args: toolArgs, result: { error: 'No user available to ask (running headless). Interpret the request yourself using the page evidence, or giveUp if it cannot be safely interpreted.' } as any, costMs: 0, timestamp: Date.now() });
          continue;
        }
        const answer = await askUser(question, options);
        const entry = { tool: 'askUser', kind: 'observe' as const, args: { question, options }, result: { answer }, costMs: 0, timestamp: Date.now() };
        journal.append(entry);
        onProgress?.(entry);
        continue;
      }
      if (toolName === 'done') {
        // R2 done-gate — identical to the response.done path above.
        if (shouldRefuseDone(journal.entries as any)) {
          journal.append({ tool: 'note', kind: 'observe' as const, args: {}, result: { error: 'done refused: every applyCss act reported NO VISIBLE CHANGE — the page as delivered is pixel-identical to the original. The rules are being shadowed by the elements that actually paint this content. Call findElements on the region the goal names, re-scope the CSS to those elements, or giveUp.' } as any, reasoning: 'done-gate: no visible effect in the run', costMs: 0, timestamp: Date.now() });
          continue;
        }
        const proofGate = await runResizeProofGate();
        if (proofGate === 'fatal') {
          await rollbackDomIfActed(tabId, journal, origin);
          return { status: 'gaveUp', reason: 'giving up: repeated actions each broke the page at a narrow viewport (resize proof). The page has been rolled back to its original state.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
        }
        if (proofGate === 'issues') continue;
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
    let preActWarnings: string[] | null = null;
    // R3d: the structured contrast baseline — elements already invisible
    // BEFORE the act must never trigger (or count against) a recovery.
    let preActContrast: ContrastFailure[] | null = null;
    if (tool.kind === 'act') {
      try {
        const pre = await dispatchTool(tabId, 'checkLayout', {}, Math.min(budget.remaining().wallMs, 20_000));
        const preCl = classifyCheckLayout(pre);
        preActIssues = preCl.allIssues ?? [];
        preActWarnings = preCl.allWarnings ?? [];
        preActContrast = (pre?.result?.contrastFailures as ContrastFailure[] | undefined) ?? [];
        if (preCl.innerWidth) wideInnerWidth = preCl.innerWidth;
      } catch { preActIssues = null; preActWarnings = null; preActContrast = null; } // baseline capture must never block an act
      // T3: capture the NARROW baseline once, before the first layout-affecting
      // act (applyCss/hide — the acts that can introduce narrow-viewport
      // breakage; a color-only sheet still counts: it may pair with later
      // layout acts, and one baseline per run keeps the cost fixed). The
      // narrow baseline is the SITE's own behavior at 480px — the proof later
      // diffs against it so the site's native narrow overflow is never blamed
      // on the transformation. Any window-API failure → null → the proof
      // skips honestly (reported, never silently passed).
      if (!narrowAttempted && (toolName === 'applyCss' || toolName === 'hide')) {
        narrowAttempted = true;
        narrowBaseline = await captureNarrowBaseline(tabId);
        // Honest telemetry: a proof that could not run is journalled as
        // skipped — never silently unmeasured (rule 12).
        if (!narrowBaseline) {
          const skipEntry = {
            tool: 'checkLayout', kind: 'verify' as const, args: {},
            result: { resizeProof: true, outcome: 'skipped', reason: 'the window could not be narrowed for a trustworthy narrow-width measurement on this display' },
            reasoning: 'resize proof baseline capture skipped',
            costMs: 0, timestamp: Date.now(),
          };
          journal.append(skipEntry);
        }
      }
    }
    try {
      // T2 RELIABILITY: dispatch timeouts are the constant cap bounded by what
      // is left — the observe-specific reserve subtraction (another
      // manufactured-timeout path) is gone. Tool dispatches are ms-fast except
      // perceivePage (seconds); 30s is generous headroom either way.
      const remNow = budget.remaining().wallMs;
      const dispatchTimeout = Math.min(remNow, 30_000);
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
      // T2 reliability: hasActed means an act actually SUCCEEDED (ok:true) —
      // a refused act (F1/responsive/identity) changed nothing and must not
      // drive the terminal disposition ("acted but unverified → rollback")
      // when there is literally nothing on the page to roll back.
      if (toolResult.ok) hasActed = true;
      consecutiveNoInfo = 0;
      // R2 convergence guard: consecutive successful applyCss acts that
      // changed NOTHING visible. Streak 2 = the model is retrying the same
      // shadowed target — escalate BEFORE it burns the budget (the T5 churn
      // class: 96/166 calls re-refining blind).
      if (toolResult.ok && toolName === 'applyCss') {
        const ve = (toolResult.result as any)?.visualEffect;
        noVisibleStreak = ve && ve.visibleChange === false ? noVisibleStreak + 1 : 0;
        if (noVisibleStreak >= 2) {
          journal.append({ tool: 'note', kind: 'observe' as const, args: {}, result: { error: `[convergence] ${noVisibleStreak} consecutive applyCss acts with NO VISIBLE CHANGE. Retrying the same selector/properties will not help — the elements that paint this content are targeted by other rules. Call findElements on the region, scope to what it returns, or giveUp.` } as any, reasoning: 'convergence guard: no-visible-change streak', costMs: 0, timestamp: Date.now() });
        }
      }
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
      // T2 RELIABILITY: bounded by remaining + the per-call constant — the
      // reserve subtraction (another manufactured-timeout path) is gone. The
      // MIN_TURN floor keeps the verification runnable even at the wall edge:
      // the disposition policy needs to know the state before deciding.
      const clTimeout = Math.min(Math.max(rem.wallMs, MIN_TURN_MS), 30_000);
      const cl = await dispatchTool(tabId, 'checkLayout', {}, clTimeout);
      const { outcome, issues: rawIssues, allIssues: rawAll, allWarnings: rawWarn } = classifyCheckLayout(cl);
      // F5.8 baseline-diff: keep only issues the ACT INTRODUCED — after-act
      // allIssues NOT in the pre-act baseline allIssues. checkLayout now returns
      // an UNCAPPED allIssues (the display `issues` is capped for the model) so
      // the diff matches every pre-existing issue (Wikipedia has 700+) exactly.
      // Exact-string match: pre-existing issues are byte-identical pre/post for
      // unchanged elements. A normalized-key fallback covers a label that
      // shifts a few chars. If the baseline capture failed (null), flag all
      // (conservative — better a false-undo than a false-pass with no baseline).
      // T3: the shared diffNewIssues is also used by the resize proof — one
      // diff, two consumers.
      const clIssues = preActIssues
        ? diffNewIssues(rawAll, preActIssues)
        : rawIssues;
      // T3 WARNING tier: new low-contrast warnings are surfaced to the model
      // but NEVER auto-undone (uncertain ≠ destroy; a borderline link color is
      // a judgment call that belongs to the model, not the breaker).
      const newWarnings = preActWarnings
        ? diffNewIssues(rawWarn, preActWarnings)
        : rawWarn;
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
        // KNOW the act is broken, only that we couldn't check it. verifiedClean
        // is left unchanged (unknown — the terminal disposition is conservative).
        (clEntry.result as any).message = 'checkLayout itself failed — could not verify the page is not broken. Re-run checkLayout, or give up if you cannot verify.';
      } else if (diffedOutcome === 'issues') {
        // R3d: BOUNDED CONTRAST RECOVERY. When the ONLY new issues are
        // invisible-text failures on a CSS sheet, the R3c-proven flow runs
        // BEFORE any undo: one targeted model call carrying the structured
        // evidence (element, measured ratio, fg, bg) → repair through the
        // SAME applyCss → verify. Repaired → both sheets stay live and the
        // act counts as clean. Not repaired → the repair entry is popped by
        // undo(1) (it is the most recent act) and the existing undo path for
        // the primary follows unchanged. The flag above is the hard bound:
        // one attempt per run, never reset, no iteration anywhere.
        let repairedByRecovery = false;
        let recoveryAttempted = false;
        const newFailures = newContrastFailures(cl?.result?.contrastFailures, preActContrast);
        if (toolName === 'applyCss' && !contrastRecoveryUsed && isContrastOnlyIssues(clIssues)
          && newFailures.length > 0 && budget.remaining().wallMs > MIN_TURN_MS) {
          contrastRecoveryUsed = true;
          recoveryAttempted = true;
          const rec = await attemptContrastRecovery({
            goal, failures: newFailures,
            baselineFailures: preActContrast, baselineAllIssues: preActIssues,
            callModel: (userContent) => callLoopModel({
              systemPrompt: SYSTEM_PROMPT, userContent,
              accountId: credentials.accountId, apiKey: credentials.apiToken,
              model: loopModel, temperature: 0,
              timeoutMs: Math.min(budget.remaining().wallMs, AI_CONFIG.callTimeoutMs),
              reasoningEffort: credentials.reasoningEffort, maxTokens: credentials.maxTokens,
            }),
            applyCss: (css) => dispatchTool(tabId, 'applyCss', { css }, 30_000),
            checkLayout: () => dispatchTool(tabId, 'checkLayout', {}, 30_000),
          });
          paidCalls++; // the single recovery model call — the flag guarantees there is never another
          // The repair entry mirrors the normal act construction: it is live
          // on the page, so undo/toggle/persistence must all know about it.
          const repairEntry = rec.css && rec.applyResult ? {
            tool: 'applyCss', kind: 'act' as const, args: { css: rec.css },
            result: rec.applyResult.result ?? { error: rec.applyResult.error },
            confidence: rec.applyResult.confidence, inverse: rec.applyResult.inverse,
            identityDigest: rec.applyResult.identityDigest,
            reasoning: 'bounded contrast recovery: one targeted repair of the named invisible-text failures',
            costMs: rec.applyResult.costMs ?? 0, timestamp: Date.now(),
          } : null;
          if (rec.repaired && repairEntry) {
            repairedByRecovery = true;
            journal.append(repairEntry);
            onProgress?.(repairEntry);
            (clEntry.result as any).recovery = 'repaired';
            (clEntry.result as any).message = `checkLayout found ${clIssues.length} NEW invisible-text issue(s) — the bounded recovery repaired them in ONE targeted pass (evidence: ${newFailures.map((f) => `<${f.tag}>`).join(', ')}). The transformation and its repair are both live and verified; continue or call done.`;
            consecutiveCheckLayoutUndos = 0; // a repaired state is a clean state
            verifiedClean = true; // the post-repair checkLayout verified it against the pre-act baseline
          } else if (repairEntry) {
            // Not repaired: remove the failed repair FIRST — journal.undo(1)
            // pops it (the most recent act entry; verify entries are skipped),
            // dispatching its removeCss inverse. The primary then follows the
            // standard undo path below.
            journal.append(repairEntry);
            const uRepair = await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
            (clEntry.result as any).recovery = uRepair.undone > 0 ? 'attempted-and-removed' : 'attempted-remove-failed';
            if (uRepair.undone === 0) {
              (clEntry.result as any).message = `the failed recovery repair could NOT be removed (undo failed) — it may still be on the page.`;
            }
          }
        }
        if (!repairedByRecovery) {
          const u = await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
          if (u.undone > 0) {
            consecutiveCheckLayoutUndos++;
            // The undo restored the previously verified act-state — the flag's
            // meaning ("current page state verified") is preserved, not cleared.
            (clEntry.result as any).autoUndone = true;
            (clEntry.result as any).message = `checkLayout found ${clIssues.length} NEW issue(s) (pre-existing baseline issues excluded): ${clIssues.join('; ')}. The last action was automatically undone — the page's layout would have been broken. Try a different approach or give up.`;
          } else if (u.failed > 0) {
            // F1: the undo did NOT restore the DOM (stale/wrong-target — the page
            // re-rendered so the selector now resolves to a different element).
            // Do NOT count this as a clean undo or bump the circuit breaker — the
            // act is still live on the page (journal kept the entry). The page is
            // possibly broken → the terminal disposition must roll back.
            verifiedClean = false;
            (clEntry.result as any).autoUndone = false;
            (clEntry.result as any).undoFailed = true;
            (clEntry.result as any).message = `checkLayout found ${clIssues.length} NEW issue(s) but the automatic undo FAILED to restore the DOM (${u.reason ?? 'stale/wrong-target'}). The action is still on the page. Call the undo tool (steps: 1) to retry, or give up.`;
          }
          if (recoveryAttempted) {
            (clEntry.result as any).message = `A bounded contrast recovery was attempted first and did not repair the failure (it was removed). ${(clEntry.result as any).message ?? ''}`;
          }
          if (consecutiveCheckLayoutUndos >= MAX_CHECKLAYOUT_UNDOS) {
            await rollbackDomIfActed(tabId, journal, origin);
            return {
              status: 'gaveUp', reason: `giving up: ${consecutiveCheckLayoutUndos} consecutive actions each broke the page layout (checkLayout failed). The page has been rolled back to its original state.`,
              journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures,
            };
          }
        }
      } else {
        // CLEAN — reset the circuit-breaker. The streak counts BACK-TO-BACK
        // break→undo with no successful act in between; a clean checkLayout
        // means the act SUCCEEDED (the page is good), which terminates the
        // streak. (A clean after an undo = the undo restored the page → not a
        // streak; a clean after a fresh act = the act worked. Both reset.)
        consecutiveCheckLayoutUndos = 0;
        // T2 reliability: the page's act-state is now verified clean — the
        // terminal disposition may KEEP this work if the run ends early.
        verifiedClean = true;
        // T3: surface new low-contrast warnings on the CLEAN path too — the
        // act is accepted, but the model should see what it made hard to read.
        if (newWarnings.length > 0) {
          (clEntry.result as any).warnings = newWarnings;
          (clEntry.result as any).message = `The action was applied and the layout check is clean. ${newWarnings.length} low-contrast warning(s) (NOT auto-undone — your call): ${newWarnings.join('; ')}. If the goal did not ask for hard-to-read text, refine the colors; otherwise continue.`;
        }
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

  // F3 (RC3), T2 RELIABILITY REVISION: the loop ended without done — the
  // disposition policy decides. Verified work (acts applied, forced checkLayout
  // clean) is KEPT and persisted: the transformation the user asked for is on
  // the page and verified; destroying it because the model never got to say
  // "done" is the exact failure this amendment removes. Unverified or
  // broken-undo states still roll back (RC3's real purpose).
  if (disposeTerminalRun(hasActed, verifiedClean) === 'rollback') {
    await rollbackDomIfActed(tabId, journal, origin);
    return { status: 'budgetExhausted', reason: 'the loop stopped because the remaining execution budget was insufficient to finish, and the changes were not verified as intact. The actions taken this run were rolled back to keep the page intact. Try a simpler request.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
  }
  // T3 resize proof gate for the two done-sites. Returns 'clean' (done may
  // proceed / no proof needed), 'issues' (journal entry appended, undo done,
  // the loop continues so the model can refine), or 'fatal' (breaker tripped).
  // A proof that RAN clean also appends an entry — a silent pass is
  // indistinguishable from a skip, and the run record should show the proof
  // happened (rule 12's spirit: never silently unmeasured).
  async function runResizeProofGate(): Promise<'clean' | 'issues' | 'fatal'> {
    if (!(hasActed && verifiedClean && narrowBaseline)) return 'clean';
    const check = await resizeAndCheck(tabId);
    const proof = classifyResizeProof(check, narrowBaseline);
    const ran = !!check && !check.error && !!check.result;
    if (proof.outcome === 'clean') {
      if (ran) {
        journal.append({
          tool: 'checkLayout', kind: 'verify' as const, args: {},
          result: { resizeProof: true, outcome: 'clean', narrowInnerWidth: check?.result?.innerWidth ?? null },
          reasoning: 'resize proof at done — the transformation survives a narrower viewport',
          costMs: 0, timestamp: Date.now(),
        });
      }
      return 'clean';
    }
    const u = await journal.undo(1, (inverse) => dispatchInverse(tabId, inverse));
    if (u.undone > 0) {
      consecutiveCheckLayoutUndos++;
    } else {
      // The undo failed — the breaking sheet may still be on the page.
      verifiedClean = false;
    }
    journal.append({
      tool: 'checkLayout', kind: 'verify' as const, args: {},
      result: { resizeProof: true, outcome: 'issues', narrowInnerWidth: check?.result?.innerWidth ?? null, newIssues: proof.newIssues, autoUndone: u.undone > 0, undoFailed: u.failed > 0 },
      reasoning: 'resize proof at done — the transformation must survive a narrower viewport',
      costMs: 0, timestamp: Date.now(),
    });
    if (consecutiveCheckLayoutUndos >= MAX_CHECKLAYOUT_UNDOS) return 'fatal';
    return 'issues';
  }

  /** T3: resize the window to NARROW_WIDTH, run checkLayout, restore the
   *  exact prior geometry. The window is resized for ~300ms — real resize,
   *  so media queries and viewport units re-solve (a root-constraint
   *  simulation, the archive's approach, cannot do that). Returns the
   *  checkLayout response (with innerWidth read-back) or { ok:false } on any
   *  window-API failure. The restore ALWAYS runs.
   *  Window managers vary in what they honor: Chrome on Linux ignores width-
   *  only updates (size+state+position must go in ONE update) and some
   *  position-preserving resizes are silently dropped on bare X. Hence the
   *  attempt ladder below — polite position first, then (0,0), then a known-
   *  good geometry — with a read-back after each. If NOTHING narrows the
   *  window, checkLayout still runs but its innerWidth betrays the clamp and
   *  the caller skips the proof honestly. */
  async function resizeAndCheck(tabId: number): Promise<any> {
    let saved: { width?: number; height?: number; left?: number; top?: number; state?: string; id?: number } | null = null;
    try {
      const win = await chrome.windows.get((await chrome.tabs.get(tabId)).windowId!);
      saved = { width: win.width, height: win.height, left: win.left, top: win.top, state: win.state, id: win.id };
      if (saved.state === 'fullscreen' || saved.state === undefined) return { ok: false, error: 'window is fullscreen — resize proof skipped' };
      // BACKGROUND TABS DO NOT REFLOW — a background tab keeps its stale
      // innerWidth and skips the relayout, so the narrow check would measure
      // the old viewport. The proof must observe the live page: activate the
      // tab (the one the user invoked Revueon on) for the ~1s measurement.
      await chrome.tabs.update(tabId, { active: true });
      const attempts = [
        { width: NARROW_WIDTH, height: saved.height, left: saved.left, top: saved.top },
        { width: NARROW_WIDTH, height: saved.height, left: 0, top: 0 },
        { width: NARROW_WIDTH, height: 800, left: 0, top: 0 },
      ];
      for (const a of attempts) {
        await chrome.windows.update(win.id!, { state: 'normal' as chrome.windows.WindowState, ...a });
        await new Promise((r) => setTimeout(r, 280));
        const mid = await chrome.windows.get(win.id!);
        if ((mid.width ?? 0) <= NARROW_WIDTH + 100) break;
      }
      const check = await dispatchTool(tabId, 'checkLayout', {}, 30_000);
      return check;
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'resize proof failed' };
    } finally {
      if (saved) {
        try {
          const winId = saved.id ?? (await chrome.tabs.get(tabId)).windowId!;
          if (saved.state === 'maximized') {
            await chrome.windows.update(winId, { state: 'maximized' as chrome.windows.WindowState });
          } else {
            // Restore with read-back + one retry — the same WM flakiness
            // applies to the restore, and a stuck-narrow window is a worse
            // artifact than anything the proof measures.
            await chrome.windows.update(winId, { state: 'normal' as chrome.windows.WindowState, width: saved.width, height: saved.height, left: saved.left, top: saved.top });
            await new Promise((r) => setTimeout(r, 250));
            const end = await chrome.windows.get(winId);
            if (saved.width && (end.width ?? 0) < saved.width - 100) {
              await chrome.windows.update(winId, { state: 'normal' as chrome.windows.WindowState, width: saved.width, height: saved.height, left: 0, top: 0 });
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        } catch { /* tab/window may be gone */ }
      }
    }
  }

  /** T3: capture the narrow baseline (the site's OWN narrow-width issues,
   *  before any transformation). null when the window cannot be narrowed
   *  enough for the measurement to mean anything (OS clamping) — the caller
   *  then skips the proof honestly. */
  async function captureNarrowBaseline(tabId: number): Promise<{ allIssues: string[]; innerWidth: number } | null> {
    const check = await resizeAndCheck(tabId);
    const cl = classifyCheckLayout(check);
    if (!cl.innerWidth) return null; // dispatch failed / checkLayout errored — no trustworthy baseline
    // Clamping guard: if the OS refused to narrow the window (innerWidth
    // stayed within ~120px of the original), the "narrow" reading tests the
    // wrong viewport and would false-flag. Skip honestly.
    if (wideInnerWidth > 0 && wideInnerWidth - cl.innerWidth < 120) return null;
    return { allIssues: cl.allIssues, innerWidth: cl.innerWidth };
  }

  // T3: the work is verified at the current viewport and will be KEPT — but
  // the hard law says a transformation must survive a resize. Run the proof;
  // a transformation that breaks a narrow viewport must not be kept forever
  // just because the model became unreachable before refining it. A proof
  // that could not MEASURE (error/clamped) keeps the work (uncertain ≠ destroy).
  if (narrowBaseline) {
    const check = await resizeAndCheck(tabId);
    const proof = classifyResizeProof(check, narrowBaseline);
    const ran = !!check && !check.error && !!check.result;
    if (proof.outcome === 'issues') {
      await rollbackDomIfActed(tabId, journal, origin);
      return { status: 'budgetExhausted', reason: `the transformation was applied and verified at the current window size, but the resize proof found it breaks at a narrow viewport (${proof.newIssues[0]}). The run ended before the model could fix this, so the changes were rolled back. Try a responsive approach (percentages, fr, clamp).`, journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
    }
    if (ran) {
      journal.append({
        tool: 'checkLayout', kind: 'verify' as const, args: {},
        result: { resizeProof: true, outcome: 'clean', narrowInnerWidth: check?.result?.innerWidth ?? null },
        reasoning: 'resize proof on terminal keep — the transformation survives a narrower viewport',
        costMs: 0, timestamp: Date.now(),
      });
    }
  }
  await persistJournal(journal, origin);
  return { status: 'budgetExhausted', reason: 'the transformation was applied and verified (layout check clean) before the run ended; the work was kept. Refinement stopped early — the model did not reach its final done.', journal, budget, paidCalls, wallMs: budget.elapsedMs(), parseFailures };
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
  // 3. Trim THIS run's delivered acts (those with inverses — a refused act
  //    never reached the page) from the persisted scope state: the rollback
  //    removed exactly those from the page. Earlier runs' still-live work on
  //    the same scope must SURVIVE a failed refinement run — the old full
  //    clear destroyed the transformation the user already kept, losing it
  //    on the next reload while its CSS was still on the page. An emptied
  //    state disables the scope (reload restores nothing).
  try {
    if (origin) {
      const key = scopeKey(origin + journal.path);
      const prior = await loadJournalState(key);
      const rolledBack = journal.entries.filter((e) => e.kind === 'act' && (e as any).inverse);
      prior.entries = trimScopeEntries(prior.entries, rolledBack);
      prior.enabled = prior.enabled && prior.entries.length > 0;
      await saveJournalState(key, prior);
    }
  } catch { /* ignore */ }
}

/** F4: persist by scope (origin + path). The journal holds both; scopeKey
 *  composes the key. Uses toPersistableState() — the persisted state STRIPS
 *  cleartext page content (observe entries, act results, inverse.prevHtml),
 *  keeping only the replay-relevant fields + the removeCss CSS (our output) +
 *  the SHA-256 identityDigest. See Journal.toPersistableState.
 *
 *  REFINE MERGE: the persisted scope state is the accumulated LIVE acts of
 *  every run on this scope. Earlier runs' still-live entries stay on the page
 *  through this run (no path below removes them), so they must survive this
 *  persist — replacing the state (the old behavior) lost them on reload. A
 *  prior state the user explicitly toggled OFF (enabled: false) is not live
 *  and is not merged — the new run starts a fresh live set for the scope. */
async function persistJournal(journal: Journal, origin: string): Promise<void> {
  try {
    if (origin) {
      const key = scopeKey(origin + journal.path);
      const state = journal.toPersistableState();
      const prior = await loadJournalState(key);
      if (prior.enabled && prior.entries.length) {
        state.entries = mergeLiveScopeEntries(prior.entries, state.entries);
      }
      await saveJournalState(key, state);
    }
  } catch { /* ignore persistence errors */ }
}
