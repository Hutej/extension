/**
 * agent/recover — R3d: bounded contrast recovery, the production half.
 *
 * The R3c experiment (proof/2026-09-04-r3c-bounded-contrast-recovery.md)
 * proved the flow in the harness:
 *
 *   primary applyCss → forced checkLayout → NEW invisible-text failures
 *     → ONE targeted model call carrying the named evidence (element, ratio,
 *       fg, bg) → repair through the SAME applyCss → verify → STOP.
 *
 * This module is the minimum production logic for that flow. The loop owns
 * the bound (a never-reset run flag) and the page-state decisions (keep the
 * repaired pair, or remove the failed repair and fall back to the existing
 * undo path); this module owns the trigger math, the evidence prompt, and the
 * single-attempt orchestration. All model/page access is injected, so the
 * fast suite exercises the whole trigger→repair→verify→stop flow with a fake
 * model over the real production tools.
 *
 * Scope discipline (R3c verdict, unchanged): the trigger is ONE deterministic
 * failure class — text the transformation made effectively invisible
 * (contrast ratio < 2.0, checkLayout's structured `contrastFailures` tier).
 * Warnings, vision scores, and aesthetic judgments never trigger.
 */

import { diffNewIssues } from './budget.ts';

/** One invisible-text failure as checkLayout's structured tier reports it. */
export interface ContrastFailure {
  tag: string;
  text: string;
  ratio: number;
  fg: string;
  bg: string;
}

/** Element identity for the baseline diff: the same element (tag + text) that
 *  was already invisible BEFORE the act did not become invisible because of
 *  it — the ratio is deliberately not part of the key, so a pre-existing
 *  borderline element whose ratio wiggles never triggers. */
function contrastFailureKey(f: ContrastFailure): string {
  return `<${f.tag}> "${f.text}"`;
}

/** Failures the transformation INTRODUCED: invisible now, not invisible at the
 *  pre-act baseline. A null baseline (capture failed) is conservative — every
 *  current failure counts (mirrors the loop's null-baseline policy). */
export function newContrastFailures(
  current: ContrastFailure[] | null | undefined,
  baseline: ContrastFailure[] | null,
): ContrastFailure[] {
  const post = current ?? [];
  if (!baseline) return post;
  const baselineKeys = new Set(baseline.map(contrastFailureKey));
  return post.filter((f) => !baselineKeys.has(contrastFailureKey(f)));
}

/** Is every NEW issue an invisible-text issue? The recovery fires only when
 *  the transformation's damage is entirely this one class — anything else
 *  (zero-size, unreachable, overflow) keeps the existing undo path. */
export function isContrastOnlyIssues(issues: string[]): boolean {
  return issues.length > 0 && issues.every((s) => s.startsWith('invisible text:'));
}

/** The recovery user content — compact, factual, the R3c-proven shape. The
 *  response contract is the loop's own (SYSTEM_PROMPT defines it): ONE
 *  applyCss tool call. */
function buildContrastRecoveryContent(goal: string, failures: ContrastFailure[]): string {
  const evidence = failures.map((f) =>
    `- <${f.tag}> "${f.text}" — measured contrast ratio ${f.ratio} (invisible: below 2.0). Text color: ${f.fg}. Effective background: ${f.bg}.`
  ).join('\n');
  return `RECOVERY — ONE TARGETED CONTRAST REPAIR

The primary transformation was applied successfully — do not redesign the page and do not undo its successful parts.

A deterministic contrast check found ${failures.length} element(s) where text is now effectively INVISIBLE against its background (introduced by the transformation):

${evidence}

USER GOAL (context): ${goal}

Author the MINIMUM corrective CSS that makes the affected text readable (aim for WCAG AA: 4.5 for normal text, 3.0 for large/bold). Target the affected elements and anything sharing their styling — touch nothing else. !important wins the cascade.

This is the ONLY repair attempt. Respond with ONE tool call: applyCss with the corrective stylesheet.`;
}

export interface ContrastRecoveryDeps {
  goal: string;
  /** The NEW failures that triggered the recovery (non-empty). */
  failures: ContrastFailure[];
  /** Pre-act structured baseline (null = capture failed, conservative). */
  baselineFailures: ContrastFailure[] | null;
  /** Pre-act allIssues baseline for the "repair introduced nothing new" check. */
  baselineAllIssues: string[] | null;
  /** ONE model call in the production response format ({ tool, args, reasoning }). */
  callModel: (userContent: string) => Promise<{ ok: boolean; json?: any; error?: string }>;
  /** Production applyCss dispatch — the repair passes every gate like any act. */
  applyCss: (css: string) => Promise<any>;
  /** Production checkLayout dispatch, for the post-repair verification. */
  checkLayout: () => Promise<any>;
}

export interface ContrastRecoveryResult {
  /** False when called with no failures (defensive — the loop gates anyway). */
  attempted: boolean;
  /** True only when the verification is clean: every new contrast failure
   *  repaired AND the repair introduced no new non-contrast issue. */
  repaired: boolean;
  css?: string;
  applied: boolean;
  /** The raw applyCss dispatch result (inverse, identityDigest, visualEffect)
   *  so the caller journals the repair exactly like a normal act. */
  applyResult?: any;
  postRepairFailures: ContrastFailure[];
  modelError?: string;
  applyError?: string;
}

/** The single bounded attempt. Exactly ONE callModel invocation site, no
 *  iteration over it — the mechanical bound. After it returns, the caller
 *  stops regardless of outcome: there is no second attempt, by structure. */
export async function attemptContrastRecovery(deps: ContrastRecoveryDeps): Promise<ContrastRecoveryResult> {
  if (deps.failures.length === 0) {
    return { attempted: false, repaired: false, applied: false, postRepairFailures: [] };
  }
  const modelRes = await deps.callModel(buildContrastRecoveryContent(deps.goal, deps.failures));
  const css = String(modelRes.json?.args?.css ?? '').trim();
  if (!modelRes.ok || modelRes.json?.tool !== 'applyCss' || !css) {
    return { attempted: true, repaired: false, applied: false, postRepairFailures: deps.failures, modelError: modelRes.error ?? 'the recovery response was not an applyCss tool call' };
  }
  const applyResult = await deps.applyCss(css);
  if (!applyResult?.ok) {
    return { attempted: true, repaired: false, css, applied: false, applyResult, postRepairFailures: deps.failures, applyError: String(applyResult?.error ?? 'applyCss refused the repair') };
  }
  const postCheck = await deps.checkLayout();
  const postRepairFailures = newContrastFailures(postCheck?.result?.contrastFailures, deps.baselineFailures);
  // Repaired means the page is verifiably clean against the ORIGINAL pre-act
  // baseline: the contrast failures are gone AND the repair introduced no
  // new non-contrast issue (invisible-text strings are excluded from the
  // string diff — their ratios legitimately changed; the structured diff
  // above is the authoritative check for that class).
  const postAll = (postCheck?.result?.allIssues as string[] | undefined) ?? [];
  const newNonContrast = (deps.baselineAllIssues ? diffNewIssues(postAll, deps.baselineAllIssues) : postAll)
    .filter((s) => !s.startsWith('invisible text:'));
  return {
    attempted: true,
    repaired: postRepairFailures.length === 0 && newNonContrast.length === 0,
    css, applied: true, applyResult, postRepairFailures,
  };
}
