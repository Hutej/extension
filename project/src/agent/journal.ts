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

  /** Undo the last N action entries by replaying their inverses. */
  async undo(n: number, dispatch: (inverse: any) => Promise<void>): Promise<number> {
    let undone = 0;
    for (let i = this.entries.length - 1; i >= 0 && undone < n; i--) {
      const entry = this.entries[i];
      if (entry.kind !== 'act' || !entry.inverse) continue;
      await dispatch(entry.inverse);
      this.entries.splice(i, 1);
      undone++;
    }
    return undone;
  }

  toState(): JournalState {
    return {
      enabled: true,
      origin: this.origin,
      goal: this.goal,
      entries: this.entries,
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
    return parts.join(', ');
  }
  if (r.issues) return r.issues.length ? `${r.issues.length} issues: ${r.issues.join('; ')}` : 'clean';
  if (r.changed !== undefined) return r.changed ? 'changed' : 'unchanged';
  if (r.textLength != null) return `ok (${r.textLength} chars)`;
  if (r.error) return `error: ${r.error}`;
  return 'ok';
}
