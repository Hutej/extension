/**
 * background/store — the persistent record owner (plan/03 `background/store`,
 * plan/13 §1/§3/§6/§7, plan/04 §4).
 *
 * One OriginRecord per origin under `rv2:origin:<origin>`. The broker alone
 * writes it; content scripts cannot. Guarantees come from ONE trusted writer
 * with per-origin write serialization, an expected-recordRevision gate and
 * lastMutationId reconciliation — never from a fictitious storage CAS:
 *
 *   1. save/enable/remove enqueue on the origin's promise chain (serialized);
 *   2. read the current record; stale expectedRecordRevision → explicit
 *      conflict with the current record summary (concurrent edits are never
 *      overwritten silently — T30);
 *   3. measure serialized bytes against the plan/13 budgets BEFORE the write;
 *      oversize is refused with the record untouched (applied work stays
 *      applied-unsaved — I21);
 *   4. write a session pending marker, then the complete record with the new
 *      recordRevision + lastMutationId, then RE-READ: matching mutationId
 *      proves the write; anything else is outcome-unknown "unsaved" (T12);
 *   5. removal writes a bounded tombstone so a stale session cannot
 *      resurrect the customization (stale deadline 5 minutes);
 *   6. hydration loads recognized v2 records; unknown-schema, corrupt and
 *      legacy `rv_*` entries are quarantined UNTOUCHED — never executed,
 *      never overwritten (T26, plan/13 §7, plan/19 §1).
 *
 * Core is pure over injected storage seams; installStore() is the only
 * chrome.* wiring. DOM-free by layer table (plan/02 §1).
 */

import {
  decodeOriginRecord,
  decodeRouteScope,
  decodeRevision,
  LIMITS,
  ORIGIN_RECORD_SCHEMA_VERSION,
  type Customization,
  type OriginRecord,
  type Revision,
  type RouteScope,
  type Tombstone,
} from '../contracts.ts';

export const ORIGIN_KEY_PREFIX = 'rv2:origin:';
export const LEGACY_KEY_PREFIX = 'rv_';
const PENDING_KEY = 'rv2:pendingWrites';
const MAX_TRACKED_MUTATIONS = 128;

/** Structural mirror of a chrome.storage.StorageArea (trusted contexts only). */
export interface StorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface StoreDeps {
  /** Trusted persistent storage (chrome.storage.local in wiring). */
  local: StorageArea;
  /** Trusted session storage (chrome.storage.session in wiring). */
  session: StorageArea;
  now(): number;
  /** UTF-8 byte length of a string (TextEncoder in wiring). */
  byteSize(s: string): number;
}

export interface SaveRevisionRequest {
  origin: string;
  customizationId: string;
  title: string;
  scope: RouteScope;
  contentSensitivity: 'page-only' | 'includes-user-content';
  grants: string[];
  /** Validated intent — the broker decodes it with decodeRevision before
   *  the store sees it (store re-checks defensively). */
  revision: Revision;
  expectedRecordRevision: number;
  mutationId: string;
}

export interface EnableRequest {
  origin: string;
  customizationId: string;
  enabled: boolean;
  expectedRecordRevision: number;
  mutationId: string;
}

export interface RemoveRequest {
  origin: string;
  customizationId: string;
  expectedRecordRevision: number;
  mutationId: string;
}

/** What a conflicted workspace needs to merge disjoint customizations after
 *  refreshing (plan/13 §3.3): it may merge disjoint IDs but never silently
 *  overwrite a concurrent edit to the same customization. */
export interface ConflictSummary {
  recordRevision: number;
  customizations: Array<Pick<Customization, 'customizationId' | 'title' | 'activeRevisionId' | 'updatedAt'>>;
}

export type StoreOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: 'conflict' | 'quota-exceeded' | 'internal' | 'invalid-schema';
      message: string;
      fieldPath?: string;
      recordRevision?: number;
      conflict?: ConflictSummary;
    };

export interface QuarantineEntry {
  key: string;
  reason: 'legacy-v0' | 'unknown-schema' | 'corrupt';
  bytes: number;
}

export interface PendingOutcome {
  mutationId: string;
  origin: string;
  /** confirmed: the record's lastMutationId matches — the write happened
   *  before the restart. unsaved: no proof — reported, never retried blind. */
  outcome: 'confirmed' | 'unsaved';
}

export interface HydrationResult {
  loaded: number;
  quarantined: QuarantineEntry[];
  /** Pending-write markers reconciled against records at startup. */
  pending: PendingOutcome[];
  /** Total persisted customization bytes (plan/13 §1 budget). */
  totalBytes: number;
}

interface MutationReceipt {
  digest: string;
  outcome: StoreOutcome<unknown>;
}

const digestOf = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + s.length.toString(16);
};

const ORIGIN_PATTERN = /^https?:\/\/[^\s]+$/;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function summaryOf(record: OriginRecord): ConflictSummary {
  return {
    recordRevision: record.recordRevision,
    customizations: record.customizations.map((c) => ({
      customizationId: c.customizationId,
      title: c.title,
      activeRevisionId: c.activeRevisionId,
      updatedAt: c.updatedAt,
    })),
  };
}

export interface StoreCore {
  /** Load/quarantine all stored records and reconcile pending writes.
   *  Called once at broker hydration; handlers await it. */
  hydrate(): Promise<HydrationResult>;
  save(req: SaveRevisionRequest): Promise<StoreOutcome<{ recordRevision: number; origin: string; mutationId: string }>>;
  setEnabled(req: EnableRequest): Promise<StoreOutcome<{ recordRevision: number }>>;
  removeCustomization(req: RemoveRequest): Promise<StoreOutcome<{ recordRevision: number }>>;
  /** Read the current record (workspace refresh after a conflict). */
  getRecord(origin: string): Promise<OriginRecord | null>;
  /** Raw stored bytes of a quarantined key — export/review only, never
   *  executed (plan/13 §7). Returns undefined for unknown keys. */
  exportQuarantined(key: string): Promise<string | undefined>;
  quarantined(): QuarantineEntry[];
  /** Diagnostics snapshot. */
  stats(): { origins: number; totalBytes: number };
}

export function createStore(deps: StoreDeps): StoreCore {
  /** Per-origin write serialization — one trusted writer, no CAS pretense. */
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(origin: string, op: () => Promise<T>): Promise<T> => {
    const tail = queues.get(origin) ?? Promise.resolve();
    const next = tail.then(op, op);
    queues.set(origin, next.catch(() => {}));
    return next;
  };

  const quarantinedEntries = new Map<string, QuarantineEntry>();
  const loadedBytes = new Map<string, number>();
  const recentMutations = new Map<string, MutationReceipt>();

  const keyOf = (origin: string): string => ORIGIN_KEY_PREFIX + origin;

  const byteSizeOf = (value: unknown): number => deps.byteSize(JSON.stringify(value));

  const readRecord = async (origin: string): Promise<{ ok: true; record: OriginRecord | null } | { ok: false; code: 'corrupt' | 'unknown-schema'; raw: string | undefined }> => {
    const key = keyOf(origin);
    const stored = await deps.local.get(key);
    const raw = stored[key];
    if (raw === undefined) return { ok: true, record: null };
    if (typeof raw !== 'string') return { ok: false, code: 'corrupt', raw: undefined };
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsedOk = false;
    }
    const decoded = parsedOk ? decodeOriginRecord(parsed) : undefined;
    if (decoded?.ok) return { ok: true, record: decoded.value };
    if (!parsedOk) return { ok: false, code: 'corrupt', raw };
    const schema = (parsed as Record<string, unknown> | null)?.schemaVersion;
    return { ok: false, code: schema === ORIGIN_RECORD_SCHEMA_VERSION ? 'corrupt' : 'unknown-schema', raw };
  };

  const writeRecord = async (origin: string, record: OriginRecord, mutationId: string): Promise<StoreOutcome<{ recordRevision: number }>> => {
    const key = keyOf(origin);
    // Pending marker BEFORE the privileged write: a restart between marker
    // and record read reconciles by lastMutationId (plan/13 §3.5, T12).
    const pendingStored = await deps.session.get(PENDING_KEY);
    const pending = (pendingStored[PENDING_KEY] as Record<string, { origin: string; at: number }> | undefined) ?? {};
    pending[mutationId] = { origin, at: deps.now() };
    await deps.session.set({ [PENDING_KEY]: pending });

    const json = JSON.stringify(record);
    try {
      await deps.local.set({ [key]: json });
    } catch (err) {
      // Quota or storage failure — the record on disk is untouched.
      const message = (err as Error)?.message ?? 'storage write failed';
      delete pending[mutationId];
      await deps.session.set({ [PENDING_KEY]: pending });
      return {
        ok: false,
        code: /quota/i.test(message) ? 'quota-exceeded' : 'internal',
        message: `the record write failed: ${message.slice(0, 200)}`,
      };
    }

    // Confirm by re-read: matching lastMutationId proves the write (plan/13 §3.5).
    const after = await readRecord(origin);
    delete pending[mutationId];
    await deps.session.set({ [PENDING_KEY]: pending });
    if (!after.ok || after.record?.lastMutationId !== mutationId) {
      return {
        ok: false,
        code: 'internal',
        message: 'the write could not be confirmed after re-read; it is reported unsaved, not applied',
      };
    }
    loadedBytes.set(origin, deps.byteSize(json));
    return { ok: true, value: { recordRevision: record.recordRevision } };
  };

  const rememberMutation = (mutationId: string, digest: string, outcome: StoreOutcome<unknown>): void => {
    recentMutations.set(mutationId, { digest, outcome });
    if (recentMutations.size > MAX_TRACKED_MUTATIONS) {
      const oldest = recentMutations.keys().next().value;
      if (oldest !== undefined) recentMutations.delete(oldest);
    }
  };

  /** Shared gate for every mutating command: schema/bounds validation,
   *  idempotent replay, and the expected-recordRevision CAS gate. */
  const gate = (
    origin: string,
    expectedRecordRevision: number,
    mutationId: string,
    digest: string,
    record: OriginRecord | null,
  ): StoreOutcome<null> | { ok: true; value: null } => {
    if (!ORIGIN_PATTERN.test(origin)) {
      return { ok: false, code: 'invalid-schema', message: 'origin must be an absolute http(s) origin', fieldPath: 'origin' };
    }
    if (!MUTATION_ID_PATTERN.test(mutationId)) {
      return { ok: false, code: 'invalid-schema', message: 'mutationId must be a bounded opaque id', fieldPath: 'mutationId' };
    }
    const seen = recentMutations.get(mutationId);
    if (seen) {
      if (seen.digest !== digest) {
        return { ok: false, code: 'conflict', message: 'this mutationId was already used with a different payload', fieldPath: 'mutationId' };
      }
      return { ok: true, value: null }; // exact replay: idempotent re-run below returns the stored outcome
    }
    if (expectedRecordRevision !== (record?.recordRevision ?? 0)) {
      return {
        ok: false,
        code: 'conflict',
        message: `record moved: expected revision ${expectedRecordRevision}, current ${record?.recordRevision ?? 0}; refresh and re-save — concurrent edits are never overwritten`,
        fieldPath: 'expectedRecordRevision',
        ...(record ? { recordRevision: record.recordRevision, conflict: summaryOf(record) } : {}),
      };
    }
    return { ok: true, value: null };
  };

  const hydrate = async (): Promise<HydrationResult> => {
    const stored = await deps.local.get(null);
    let loaded = 0;
    let totalBytes = 0;
    for (const [key, raw] of Object.entries(stored)) {
      if (key.startsWith(ORIGIN_KEY_PREFIX)) {
        let parsed: unknown;
        let parsedOk = true;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          parsedOk = false;
        }
        const decoded = parsedOk ? decodeOriginRecord(parsed) : { ok: false as const, issues: [] };
        const bytes = typeof raw === 'string' ? deps.byteSize(raw) : byteSizeOf(raw);
        if (decoded.ok) {
          loaded += 1;
          loadedBytes.set(decoded.value.origin, bytes);
          totalBytes += bytes;
        } else {
          const schema = parsedOk ? (parsed as Record<string, unknown> | null)?.schemaVersion : undefined;
          quarantinedEntries.set(key, {
            key,
            reason: !parsedOk || schema === ORIGIN_RECORD_SCHEMA_VERSION ? 'corrupt' : 'unknown-schema',
            bytes,
          });
        }
      } else if (key.startsWith(LEGACY_KEY_PREFIX)) {
        // plan/13 §7 / plan/19: recognized v0 rv_* journals are quarantined
        // disabled — left byte-for-byte untouched, never replayed or executed.
        quarantinedEntries.set(key, {
          key,
          reason: 'legacy-v0',
          bytes: typeof raw === 'string' ? deps.byteSize(raw) : byteSizeOf(raw),
        });
      }
    }

    // Reconcile pending-write markers left by a worker that died mid-write.
    const pending: PendingOutcome[] = [];
    try {
      const storedPending = await deps.session.get(PENDING_KEY);
      const markers = (storedPending[PENDING_KEY] as Record<string, { origin: string; at: number }> | undefined) ?? {};
      for (const [mutationId, marker] of Object.entries(markers)) {
        const read = await readRecord(marker.origin);
        const confirmed = read.ok && read.record?.lastMutationId === mutationId;
        pending.push({ mutationId, origin: marker.origin, outcome: confirmed ? 'confirmed' : 'unsaved' });
      }
      if (Object.keys(markers).length > 0) await deps.session.remove(PENDING_KEY);
    } catch {
      /* session unavailable — nothing to reconcile */
    }
    return { loaded, quarantined: [...quarantinedEntries.values()], pending, totalBytes };
  };

  const save = (req: SaveRevisionRequest): Promise<StoreOutcome<{ recordRevision: number; origin: string; mutationId: string }>> =>
    serialize(req.origin, async () => {
      const digest = digestOf(JSON.stringify(req));
      // Defensive re-validation: the broker already decoded the request, but
      // the record owner never trusts its caller's types (plan/03).
      if (!decodeRouteScope(req.scope).ok) {
        return { ok: false, code: 'invalid-schema', message: 'scope failed validation', fieldPath: 'scope' };
      }
      if (!decodeRevision(req.revision).ok) {
        return { ok: false, code: 'invalid-schema', message: 'revision failed validation', fieldPath: 'revision' };
      }
      if (!Number.isInteger(req.expectedRecordRevision) || req.expectedRecordRevision < 0) {
        return { ok: false, code: 'invalid-schema', message: 'expectedRecordRevision must be a non-negative integer', fieldPath: 'expectedRecordRevision' };
      }

      const read = await readRecord(req.origin);
      if (!read.ok) {
        // A corrupt/unknown record is never overwritten — it is evidence (T26).
        return {
          ok: false,
          code: 'internal',
          message: read.code === 'unknown-schema'
            ? 'the stored record has an unknown schema version; it stays quarantined and untouched'
            : 'the stored record is corrupt; it stays quarantined and untouched',
        };
      }
      const record: OriginRecord = read.record ?? {
        schemaVersion: ORIGIN_RECORD_SCHEMA_VERSION,
        origin: req.origin,
        recordRevision: 0,
        lastMutationId: '',
        customizations: [],
        updatedAt: 0,
        tombstones: [],
      };

      const gateResult = gate(req.origin, req.expectedRecordRevision, req.mutationId, digest, read.record);
      if (!gateResult.ok) return gateResult;
      const seen = recentMutations.get(req.mutationId);
      if (seen) {
        // Exact replay of a processed mutation: return the same outcome.
        return seen.outcome as StoreOutcome<{ recordRevision: number; origin: string; mutationId: string }>;
      }

      // Tombstone: a removed customization cannot be resurrected by a stale
      // session until the stale deadline passes (plan/13 §6).
      const now = deps.now();
      const liveTombstones: Tombstone[] = (record.tombstones ?? []).filter((t) => now - t.at < LIMITS.tombstoneStaleMs);
      if (liveTombstones.some((t) => t.customizationId === req.customizationId)) {
        return {
          ok: false,
          code: 'conflict',
          message: 'this customization was removed; the removal tombstone outlives stale save messages',
          fieldPath: 'customizationId',
          ...(read.record ? { recordRevision: read.record.recordRevision, conflict: summaryOf(record) } : {}),
        };
      }

      // Upsert preserving the explicit customization array order (I13: the
      // array order IS the canonical composition order; merges never reorder).
      const existingIndex = record.customizations.findIndex((c) => c.customizationId === req.customizationId);
      const nowMs = deps.now();
      let customizations: Customization[];
      if (existingIndex >= 0) {
        const prev = record.customizations[existingIndex];
        const revisions = prev.revisions.some((r) => r.revisionId === req.revision.revisionId)
          ? prev.revisions
          : [...prev.revisions, req.revision];
        // plan/13 §1: two accepted intent revisions — active + previous.
        const kept = revisions.slice(-LIMITS.maxRevisionsKept);
        const updated: Customization = {
          ...prev,
          title: req.title,
          enabled: true,
          scope: req.scope,
          activeRevisionId: req.revision.revisionId,
          revisions: kept,
          updatedAt: nowMs,
          contentSensitivity: req.contentSensitivity,
          grants: req.grants,
        };
        customizations = [...record.customizations];
        customizations[existingIndex] = updated;
      } else {
        customizations = [
          ...record.customizations,
          {
            customizationId: req.customizationId,
            title: req.title,
            enabled: true,
            scope: req.scope,
            activeRevisionId: req.revision.revisionId,
            revisions: [req.revision],
            createdAt: nowMs,
            updatedAt: nowMs,
            contentSensitivity: req.contentSensitivity,
            grants: req.grants,
          },
        ];
      }

      const next: OriginRecord = {
        ...record,
        recordRevision: record.recordRevision + 1,
        lastMutationId: req.mutationId,
        customizations,
        updatedAt: nowMs,
        tombstones: liveTombstones,
      };

      // Byte budgets BEFORE the write — oversize is refused with the record
      // untouched (plan/13 §1; applied work stays applied-unsaved, I21).
      const custom = customizations[existingIndex >= 0 ? existingIndex : customizations.length - 1];
      const customBytes = byteSizeOf(custom);
      if (customBytes > LIMITS.maxCustomizationBytes) {
        return {
          ok: false,
          code: 'quota-exceeded',
          message: `the customization serializes to ${customBytes} bytes over the ${LIMITS.maxCustomizationBytes}-byte budget; export or trim it`,
          fieldPath: 'revision',
          ...(read.record ? { recordRevision: read.record.recordRevision, conflict: summaryOf(record) } : {}),
        };
      }
      const originBytes = byteSizeOf(next);
      if (originBytes > LIMITS.maxOriginRecordBytes) {
        return {
          ok: false,
          code: 'quota-exceeded',
          message: `the origin record serializes to ${originBytes} bytes over the ${LIMITS.maxOriginRecordBytes}-byte budget`,
          fieldPath: 'customizations',
          ...(read.record ? { recordRevision: read.record.recordRevision, conflict: summaryOf(record) } : {}),
        };
      }
      const otherBytes = [...loadedBytes.entries()].filter(([o]) => o !== req.origin).reduce((sum, [, b]) => sum + b, 0);
      if (otherBytes + originBytes > LIMITS.maxTotalRecordBytes) {
        return {
          ok: false,
          code: 'quota-exceeded',
          message: `total saved customization data would exceed the ${LIMITS.maxTotalRecordBytes}-byte budget`,
          fieldPath: 'customizations',
          ...(read.record ? { recordRevision: read.record.recordRevision, conflict: summaryOf(record) } : {}),
        };
      }

      const outcome = await writeRecord(req.origin, next, req.mutationId);
      const full: StoreOutcome<{ recordRevision: number; origin: string; mutationId: string }> = outcome.ok
        ? { ok: true, value: { recordRevision: outcome.value.recordRevision, origin: req.origin, mutationId: req.mutationId } }
        : outcome;
      rememberMutation(req.mutationId, digest, full);
      return full;
    });

  const setEnabled = (req: EnableRequest): Promise<StoreOutcome<{ recordRevision: number }>> =>
    serialize(req.origin, async () => {
      const digest = digestOf(JSON.stringify(req));
      const read = await readRecord(req.origin);
      if (!read.ok) {
        return { ok: false, code: 'internal', message: 'the stored record is unreadable; it stays quarantined and untouched' };
      }
      const record = read.record;
      if (record === null) {
        return { ok: false, code: 'conflict', message: 'no saved customizations exist for this origin yet', fieldPath: 'origin' };
      }
      const gateResult = gate(req.origin, req.expectedRecordRevision, req.mutationId, digest, record);
      if (!gateResult.ok) return gateResult;
      const seen = recentMutations.get(req.mutationId);
      if (seen) return seen.outcome as StoreOutcome<{ recordRevision: number }>;
      const index = record.customizations.findIndex((c) => c.customizationId === req.customizationId);
      if (index < 0) {
        return { ok: false, code: 'conflict', message: 'no such customization on this origin record', fieldPath: 'customizationId', recordRevision: record.recordRevision };
      }
      const customizations = [...record.customizations];
      customizations[index] = { ...customizations[index], enabled: req.enabled, updatedAt: deps.now() };
      const next: OriginRecord = {
        ...record,
        recordRevision: record.recordRevision + 1,
        lastMutationId: req.mutationId,
        customizations,
        updatedAt: deps.now(),
      };
      const outcome = await writeRecord(req.origin, next, req.mutationId);
      rememberMutation(req.mutationId, digest, outcome);
      return outcome;
    });

  const removeCustomization = (req: RemoveRequest): Promise<StoreOutcome<{ recordRevision: number }>> =>
    serialize(req.origin, async () => {
      const digest = digestOf(JSON.stringify(req));
      const read = await readRecord(req.origin);
      if (!read.ok) {
        return { ok: false, code: 'internal', message: 'the stored record is unreadable; it stays quarantined and untouched' };
      }
      const record = read.record;
      if (record === null) {
        return { ok: false, code: 'conflict', message: 'no saved customizations exist for this origin yet', fieldPath: 'origin' };
      }
      const gateResult = gate(req.origin, req.expectedRecordRevision, req.mutationId, digest, record);
      if (!gateResult.ok) return gateResult;
      const seen = recentMutations.get(req.mutationId);
      if (seen) return seen.outcome as StoreOutcome<{ recordRevision: number }>;
      if (!record.customizations.some((c) => c.customizationId === req.customizationId)) {
        return { ok: false, code: 'conflict', message: 'no such customization on this origin record', fieldPath: 'customizationId', recordRevision: record.recordRevision };
      }
      const now = deps.now();
      const tombstones: Tombstone[] = [
        ...(record.tombstones ?? []).filter((t) => now - t.at < LIMITS.tombstoneStaleMs),
        { customizationId: req.customizationId, mutationId: req.mutationId, at: now },
      ].slice(-LIMITS.maxTombstones);
      const next: OriginRecord = {
        ...record,
        recordRevision: record.recordRevision + 1,
        lastMutationId: req.mutationId,
        customizations: record.customizations.filter((c) => c.customizationId !== req.customizationId),
        updatedAt: now,
        tombstones,
      };
      const outcome = await writeRecord(req.origin, next, req.mutationId);
      rememberMutation(req.mutationId, digest, outcome);
      return outcome;
    });

  const getRecord = async (origin: string): Promise<OriginRecord | null> => {
    const read = await readRecord(origin);
    return read.ok ? read.record : null;
  };

  const exportQuarantined = async (key: string): Promise<string | undefined> => {
    const stored = await deps.local.get(key);
    const raw = stored[key];
    return typeof raw === 'string' ? raw : undefined;
  };

  return {
    hydrate,
    save,
    setEnabled,
    removeCustomization,
    getRecord,
    exportQuarantined,
    quarantined: () => [...quarantinedEntries.values()],
    stats: () => ({ origins: loadedBytes.size, totalBytes: [...loadedBytes.values()].reduce((a, b) => a + b, 0) }),
  };
}
