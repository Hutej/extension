/**
 * core/understand — parse the user's English request into a goal + the
 * capabilities needed to satisfy it.
 *
 * Phase 1: every request is served by the `style` capability, so this is a
 * thin pass-through. Phase 2+ will decompose a request into the mix of
 * capabilities it needs (hide/move/inject/automate/extract) — the model call
 * that does that decomposition is deliberately not built yet.
 */

export type Capability = 'style' | 'structure' | 'augment' | 'act' | 'extract' | 'integrate';

export interface Goal {
  intent: string;
  capabilities: Capability[];
}

export function understand(intent: string): Goal {
  return { intent, capabilities: ['style'] };
}
