/**
 * core/tools — Phase 6 (COMPOSE) + Phase 8 (ECOSYSTEM).
 * Registry of saved, named, reusable user-built tools/mini-apps: a bundle of a
 * transform (StyleSpec today; +structure/augment/act later) plus metadata the
 * user can re-invoke, and eventually share. This is "WebMorph builds you an
 * extension on demand".
 *
 * Contract only — not implemented yet.
 */

import type { StyleSpec } from '../spec';

export interface SavedTool {
  id: string;
  name: string;
  intent: string;
  /** Match rule for where this tool applies (origin/glob). */
  match?: string;
  style?: StyleSpec;
  // structure?/augment?/act? — added with their phases
  createdAt: number;
}

export interface ToolRegistry {
  list(): Promise<SavedTool[]>;
  save(tool: SavedTool): Promise<void>;
  remove(id: string): Promise<void>;
}

// TODO(phase-6): implement registry over storage; Phase 8 adds share/import.
export {};
