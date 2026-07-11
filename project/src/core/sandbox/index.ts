/**
 * core/sandbox — Phase 4+ safe script execution + capability permissions.
 * Behavioral ops (capabilities/act) run here, gated by explicit grants, so a
 * saved tool can only touch the capabilities the user approved for it.
 *
 * Contract only — not implemented yet.
 */

import type { Capability } from '../understand';

export interface CapabilityGrant {
  capability: Capability | 'store' | 'integrate';
  allowed: boolean;
}

export interface SandboxContext {
  grants: CapabilityGrant[];
  origin: string;
}

// TODO(phase-4): run behavioral ops under a permission-checked context.
export {};
