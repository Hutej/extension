/**
 * capabilities/inject — Phase 3 (AUGMENT).
 * Inject brand-new elements/UI/widgets/3D that never existed, isolated in
 * Shadow DOM so injected markup can't collide with or be broken by the host page.
 *
 * Contract only — not implemented yet.
 */

export interface AugmentOp {
  kind: 'panel' | 'overlay' | 'control' | 'background';
  /** Sanitized HTML for the new element (rendered inside a shadow root). */
  html: string;
  /** Scoped CSS for the shadow root. */
  css?: string;
  /** Perception handle to anchor near, or 'viewport' for a floating element. */
  anchor?: string;
}

// TODO(phase-3): render AugmentOp inside an attached shadow root via sanitize + execute.
export {};
