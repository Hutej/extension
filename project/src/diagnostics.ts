/**
 * diagnostics — small content-free event ring and export summary
 * (plan/02 §3, plan/16 §3/§4).
 *
 * The workspace (and later other owners) push BOUNDED public events: phase
 * transitions, receipt statuses, counters. Raw page text, prompts, CSS
 * values, URLs and credentials never enter the ring — the caller passes
 * already-public fields only, and every free-form string is length-capped.
 * Overflow drops the OLDEST diagnostics only, never active resources.
 * Session-only: nothing here persists.
 */

export const DIAGNOSTIC_EVENT_VERSION = 1;
export const DIAGNOSTIC_RING_CAPACITY = 200;
const MAX_DETAIL_CHARS = 200;
const MAX_CONTEXT_CHARS = 40;
const MAX_PHASE_CHARS = 40;

export interface DiagnosticEvent {
  eventVersion: 1;
  /** Injected monotonic-ish time (the owner's clock) — filled by the ring. */
  monotonicTime: number;
  /** Producing context, e.g. "workspace" — bounded label, never content. */
  context: string;
  phase: string;
  runId?: string;
  customizationId?: string;
  /** "ok" or an error-code string. */
  resultCode?: string;
  durationMs?: number;
  counts?: Record<string, number>;
  /** Bounded public detail only (recovery actions, error codes) — never page
   *  text, prompts, selectors with personal labels or credentials. */
  detail?: string;
}

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export interface DiagnosticRing {
  add(event: Omit<DiagnosticEvent, 'eventVersion' | 'monotonicTime'>): void;
  entries(): readonly DiagnosticEvent[];
  clear(): void;
  /** Human-readable summary for the workspace diagnostic panel — one line
   *  per event, newest last. */
  summary(): string;
}

export function createDiagnosticRing(deps: {
  now(): number;
  capacity?: number;
}): DiagnosticRing {
  const capacity = deps.capacity ?? DIAGNOSTIC_RING_CAPACITY;
  const ring: DiagnosticEvent[] = [];

  return {
    add(event) {
      const e: DiagnosticEvent = {
        eventVersion: DIAGNOSTIC_EVENT_VERSION,
        monotonicTime: deps.now(),
        context: cap(event.context || 'unknown', MAX_CONTEXT_CHARS),
        phase: cap(event.phase || 'unknown', MAX_PHASE_CHARS),
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
        ...(event.customizationId !== undefined ? { customizationId: event.customizationId } : {}),
        ...(event.resultCode !== undefined ? { resultCode: event.resultCode } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.counts !== undefined ? { counts: event.counts } : {}),
        ...(event.detail !== undefined ? { detail: cap(event.detail, MAX_DETAIL_CHARS) } : {}),
      };
      ring.push(e);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
    },
    entries: () => [...ring],
    clear: () => {
      ring.length = 0;
    },
    summary() {
      return ring
        .map((e) => {
          const counts = e.counts
            ? ' ' +
              Object.entries(e.counts)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : '';
          const detail = e.detail ? ` — ${e.detail}` : '';
          return `[${e.monotonicTime}] ${e.context}/${e.phase}${e.resultCode ? ` → ${e.resultCode}` : ''}${counts}${detail}`;
        })
        .join('\n');
    },
  };
}
