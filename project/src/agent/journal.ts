/**
 * agent/journal — the single record of a run.
 *
 * What the model sees each turn, what undo(n) walks backwards, what
 * persistence replays per origin.
 *
 * D: The journal serialization is capped. The 7,600-character prompt
 * has reappeared wearing a different hat. A named constant caps it,
 * and the truncation is flagged in the prompt itself.
 */

import type { JournalEntry, JournalState } from '../core/persist';
export type { JournalEntry, JournalState };

// D: the journal serialization cap. Named constant, flagged when exceeded.
const MAX_JOURNAL_CHARS = 8_000;
const MAX_REGIONS_IN_PROMPT = 15;
const MAX_READTEXT_IN_PROMPT = 2_000;

export class Journal {
  entries: JournalEntry[] = [];
  goal = '';
  origin = '';
  /** F4: pathname persisted with the origin — the scope key is origin + path. */
  path = '';

  append(entry: JournalEntry): void {
    this.entries.push(entry);
  }

  /** Compact serialization for the model prompt. Capped at MAX_JOURNAL_CHARS. */
  serialize(): string {
    if (!this.entries.length) return 'Nothing yet.';

    let total = 0;
    const lines: string[] = [];
    let truncated = false;

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const argStr = Object.entries(e.args).map(([k, v]) => {
        const s = typeof v === 'string' ? (v.length > 60 ? `"${v.slice(0, 57)}..."` : `"${v}"`) : String(v);
        return `${k}=${s}`;
      }).join(', ');
      const resultStr = serializeResult(e);
      const confStr = e.confidence != null ? ` (conf ${e.confidence})` : '';
      const line = `[${i + 1}] ${e.tool}(${argStr}) → ${resultStr}${confStr}`;

      if (total + line.length > MAX_JOURNAL_CHARS) {
        truncated = true;
        break;
      }
      total += line.length + 1;
      lines.push(line);
    }

    if (truncated) {
      lines.push(`[TRUNCATED — journal exceeded ${MAX_JOURNAL_CHARS} chars, older entries omitted]`);
    }

    return lines.join('\n');
  }

  /** Undo the last N action entries by replaying their inverses.
   *
   *  dispatch reports whether the inverse actually restored the DOM:
   *  `{ ok: false, failed: 1, reason }` (a stale/wrong-target undo) is NOT
   *  counted as undone — the journal entry is kept so the model/loop know the
   *  act is still live on the page, and the terminal rollback can still try it.
   *  Returns { undone, failed, reason } so the loop can propagate the failure
   *  (rule 13: a swallowed undo makes the loop report success on a still-broken
   *  page). dispatch may return void (CSS/legacy paths) — treated as success. */
  async undo(
    n: number,
    dispatch: (inverse: any) => Promise<{ ok?: boolean; failed?: number; reason?: string } | void>,
  ): Promise<{ undone: number; failed: number; reason?: string }> {
    let undone = 0;
    let failed = 0;
    let reason: string | undefined;
    for (let i = this.entries.length - 1; i >= 0 && (undone + failed) < n; i--) {
      const entry = this.entries[i];
      if (entry.kind !== 'act' || !entry.inverse) continue;
      const r = await dispatch(entry.inverse);
      if (r && r.ok === false) {
        failed++;
        reason = r.reason;
        continue; // keep the entry — the act is still live on the page
      }
      this.entries.splice(i, 1);
      undone++;
    }
    return { undone, failed, reason };
  }

  /** F4: toState includes `path` (origin + path = the scope key). The SESSION
   *  journal keeps everything (result, inverses with prevHtml) — the model sees
   *  it, undo uses the clones, and the act's own guardTarget uses the result. For
   *  PERSISTENCE use toPersistableState(), which strips cleartext page content. */
  toState(): JournalState {
    return {
      enabled: true,
      origin: this.origin,
      path: this.path,
      goal: this.goal,
      entries: this.entries,
      createdAt: Date.now(),
    };
  }

  /** F4 PRIVACY (adversarial-review finding, user decision 19 Aug 2026): strip
   *  cleartext page content from the PERSISTED state. The persisted journal must
   *  carry only what replay needs — the act args, the identityDigest, and the
   *  removeCss inverse's CSS (the extension's OWN output, not page content).
   *  Stripped:
   *    - observe/control/verify entries ENTIRELY (replay skips them; their
   *      `result` is cleartext page text — describePage textSample, readText
   *      text, perceivePage perception — and none is consumed by replay).
   *    - every act entry's `result` (the act's confirmation, which carries
   *      `before`/`after` slices of page content).
   *    - `inverse.prevHtml` from restoreText/restoreHtml (full cleartext
   *      innerHTML — the post-reload undo fallback). The in-session cloned-node
   *      TransactionLog is the authoritative undo path; the innerHTML re-parse
   *      was a documented degradation. Dropping it means a post-reload undo of
   *      a setText/insert does nothing (no innerHTML to restore to) — accepted
   *      by the user as the cost of the privacy-strict choice. Replay still
   *      works (re-verify + re-execute); only the post-reload fallback-undo is
   *      removed. The persisted op stays (the digest + selector + args are
   *      enough to re-apply; undoAll post-reload clears storage + removes CSS).
   *  NOT stripped: identityDigest (a SHA-256, no cleartext), removeCss.inverse.css
   *  (our output), the act args (the CSS / text / html the MODEL authored — our
   *  own input, not the page's content; the `text`/`html` are what we put ON the
   *  page, not what was there before). */
  toPersistableState(): JournalState {
    const persistableEntries: JournalEntry[] = [];
    for (const e of this.entries) {
      if (e.kind !== 'act') continue; // observe/control/verify: not replayed; drop
      const inv = e.inverse as any;
      const cleanInv = (() => {
        if (!inv) return undefined;
        if (inv.kind === 'removeCss') return { kind: 'removeCss', css: inv.css }; // our output
        if (inv.kind === 'restoreText') return { kind: 'restoreText', selector: inv.selector }; // no prevHtml
        if (inv.kind === 'restoreHtml') return { kind: 'restoreHtml', selector: inv.selector, isInside: inv.isInside }; // no prevHtml
        return inv;
      })();
      persistableEntries.push({
        tool: e.tool,
        kind: 'act',
        args: e.args,
        // result dropped (cleartext confirmation slices); the type is optional now.
        confidence: e.confidence,
        identityDigest: e.identityDigest,
        inverse: cleanInv,
        reasoning: e.reasoning,
        costMs: e.costMs,
        timestamp: e.timestamp,
      } as JournalEntry);
    }
    return {
      enabled: true,
      origin: this.origin,
      path: this.path,
      goal: this.goal,
      entries: persistableEntries,
      createdAt: Date.now(),
    };
  }
}

function serializeResult(entry: JournalEntry): string {
  const r = entry.result as any;
  if (!r) return (entry as any).error ? `error: ${(entry as any).error}` : 'ok';

  // describePage — surface the region list, capped.
  if (r.regions != null && entry.tool === 'describePage') {
    const regions = (r.regions as any[]).slice(0, MAX_REGIONS_IN_PROMPT);
    const lines = regions.map((reg) =>
      `  ${reg.id}: ${reg.role}/${reg.type} sel=${reg.selector ?? '(none)'}${reg.targetable ? '' : ` [${reg.untargetableReason ?? 'untargetable'}]`} text="${reg.textSample ?? ''}"`
    ).join('\n');
    const more = r.regionCount > MAX_REGIONS_IN_PROMPT ? ` (${r.regionCount - MAX_REGIONS_IN_PROMPT} more, see full result)` : '';
    return `${r.regionCount} regions${r.truncated ? ' [TRUNCATED]' : ''}${more}:\n${lines}`;
  }

  // findElements — surface matches with selectors.
  if (r.matches != null) {
    if (r.matches.length === 0) return '0 matches';
    const lines = (r.matches as any[]).map((m) =>
      `  ${m.id}: conf=${m.confidence} sel="${m.selector || '(none)'}" ${m.targetable ? '' : `[${m.untargetableReason ?? 'untargetable'}]`} — ${m.reason}`
    ).join('\n');
    return `${r.matches.length} matches:\n${lines}`;
  }

  // readText — surface the text, capped at MAX_READTEXT_IN_PROMPT.
  if (r.text != null) {
    const text = r.text.length > MAX_READTEXT_IN_PROMPT
      ? r.text.slice(0, MAX_READTEXT_IN_PROMPT) + `... [TRUNCATED — ${r.text.length} total]`
      : r.text;
    return `text (${r.text.length} chars${r.truncated ? `, was truncated` : ''}):\n${text}`;
  }

  // Act results — surface applied status (C).
  if (r.applied !== undefined) {
    const parts: string[] = [];
    if (r.applied === true) parts.push('applied ✓');
    else if (r.applied === false) parts.push('NOT APPLIED ✗');
    else parts.push('applied=unknown');
    if (r.before != null && r.after != null) parts.push(`${r.before} → ${r.after}`);
    if (r.chars != null) parts.push(`${r.chars} chars`);
    if (r.healed) parts.push(`healed: ${r.healed.length} steps`);
    if (r.unverified) parts.push('UNVERIFIED target (selector describePage never returned — act on a single live match, not an observed identity)');
    return parts.join(', ');
  }
  if (r.issues) return r.issues.length ? `${r.issues.length} issues: ${r.issues.join('; ')}` : 'clean';
  if (r.changed !== undefined) return r.changed ? 'changed' : 'unchanged';
  if (r.textLength != null) return `ok (${r.textLength} chars)${r.unverified ? ' [UNVERIFIED target]' : ''}`;
  if (r.error) return `error: ${r.error}`;
  return 'ok';
}
