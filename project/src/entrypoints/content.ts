/**
 * entrypoints/content — bootstrap only (plan/19 §3.2 cutover).
 *
 * The one runtime owns everything document-side: verified registration
 * handshake, route-epoch fencing, serial mutation queue, style delivery
 * reconcile, replay, relay. This entrypoint creates the single session —
 * it holds no logic of its own (rule 16: wire it, do not reimplement it).
 */
import { bootRuntimeSession } from '../runtime/session.ts';

export default defineContentScript({
  matches: ['<all_urls>'],
  // S8.3 (plan/12 §3): one runtime per individually permissioned frame —
  // the browser injects only where the extension's host permissions cover
  // the frame's origin. Each frame registers its own DocumentKey
  // (tabId+frameId+documentId); the workspace pins an exact frame explicitly.
  allFrames: true,
  main() {
    void bootRuntimeSession();
  },
});
