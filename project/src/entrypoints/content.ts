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
  main() {
    void bootRuntimeSession();
  },
});
