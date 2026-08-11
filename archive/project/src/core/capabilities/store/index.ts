/**
 * capabilities/store — durable key/value storage primitive for tools that need
 * to remember state across sessions (watched values, counters, user prefs).
 * Wraps extension storage behind a namespaced interface.
 *
 * Contract only — not implemented yet.
 */

export interface KVStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

// TODO(phase-5/6): implement over browser.storage.local with per-tool namespacing.
export {};
