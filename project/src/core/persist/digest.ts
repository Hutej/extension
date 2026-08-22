/**
 * core/persist/digest — F4 CONTINUITY persisted identity.
 *
 * The problem (PHASE5_DESIGN §5/§22-Q1): a persisted act must be re-verified on
 * reload/SPA-render so a selector that now points to a DIFFERENT element is
 * caught, not silently re-mutated. F1's `resolveTarget` does this in-session by
 * comparing the live `fingerprint(el)` string to the observe-time fingerprint.
 * But that string embeds page content in CLEARTEXT — a 40-char text prefix and
 * attribute values (aria-label/alt/title/name…) — so persisting it whole would
 * store page content in chrome.storage.local (privacy: rule 14, product req 6).
 *
 * The approved resolution (F4-local hash, NO F1 change): persist only a
 * CRYPTOGRAPHIC DIGEST of the fingerprint. SHA-256 via the Web Crypto SubtleCrypto
 * API — available in content scripts (where the element lives) and in the
 * Node --experimental-strip-types test runtime. The cleartext fingerprint is
 * computed in memory during replay and immediately hashed; it is never written
 * to storage. Comparing two digests answers "is this the same element?" without
 * the comparison itself being content.
 *
 * This is NOT a second identity resolver (F4 invariant #1). `resolveTarget`
 * stays the sole selector→element resolver; F4 owns only the digest conversion
 * (live fingerprint → SHA-256 → compare with the persisted digest). It reuses
 * F1's `fingerprint()` (not duplicated) and F1's `IdentityDom` surface.
 *
 * F4 invariant #3: the persisted record holds a string digest, never a live
 * Node. The digest is a 64-char hex string — trivially serializable across the
 * structured-clone boundary, trivially JSON-able into JournalEntry.
 *
 * Why SHA-256 and not a small non-cryptographic hash: the digest is the SOLE
 * persisted comparator for wrong-target detection. A 32-bit `shortHash` (or
 * any short FNV/CRC) collides often enough across a page with thousands of
 * elements that a wrong target could share a digest with the intended one.
 * SHA-256 makes a colliding wrong target computationally infeasible — the
 * digest is a real identity, not a bucket. `crypto.subtle.digest` is async,
 * but every act tool is already async (awaits rAF + sendMessage), and the
 * digest is computed in the content script and returned in the ToolResult.
 */
import { fingerprint, type IdentityDom } from '../identity.ts';

/** A persisted identity digest: SHA-256 hex of the structural fingerprint. */
export type IdentityDigest = string;

const enc = new TextEncoder();

/** SHA-256 over a string → 64-char lowercase hex. Uses global crypto.subtle
 *  (SubtleCrypto), available in content scripts and Node 22. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** Compute the persisted identity digest for an element: SHA-256 of its F1
 *  structural fingerprint. The fingerprint is style-agnostic (excludes `style`
 *  and our data-rv-* stamps), so it survives the transform we apply AND survives
 *  replay re-applying it — the same element has the same digest before and after.
 *  Computed in memory; only the hex digest is persisted (never the fingerprint). */
export async function digestOfElement(el: Element, dom: IdentityDom): Promise<IdentityDigest> {
  return sha256Hex(fingerprint(el, dom));
}
