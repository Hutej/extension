/**
 * capabilities/act — Phase 4 (ACT / AUTOMATE).
 * Behavior changes through a sandboxed capability API: macros, auto-fill,
 * click-flows, keyboard shortcuts, and functional transforms ("hide the video,
 * give me audio-only + controls"). All actions pass trust-boundary safety checks
 * (no submit/password/payment/cross-origin) before running.
 *
 * Contract only — not implemented yet.
 */

export interface ActOp {
  kind: 'shortcut' | 'clickFlow' | 'autoFill' | 'unlockScroll' | 'mediaMode';
  /** Perception handle(s) the action operates on. */
  target?: string;
  /** e.g. keyboard combo for 'shortcut'. */
  key?: string;
  params?: Record<string, string>;
}

// TODO(phase-4): execute ActOp through core/sandbox with capability permissions.
export {};
