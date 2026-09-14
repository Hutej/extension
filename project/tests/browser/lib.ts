/**
 * Browser-harness helpers shared by tests/browser/extension.test.ts.
 * The harness drives the BUILT extension (`.output/chrome-mv3`) through the
 * real production message path — the background service worker dispatches
 * `toolCall` exactly as the agent loop does. No test-only injection into the
 * page: the content script under test is the shipped one (I27/I28).
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const SRC_DIR = join(REPO, 'src');
export const BUILD_MANIFEST = join(REPO, '.output', 'chrome-mv3', 'manifest.json');
export const FIXTURES_DIR = join(REPO, 'tests', 'fixtures', 'pages');

/** The gate must refuse to run against a stale build (T01): the newest source
 *  file (or wxt config) must not be newer than the built manifest. */
export function isStaleBuild(manifestMtimeMs: number, newestSourceMtimeMs: number): boolean {
  return newestSourceMtimeMs > manifestMtimeMs;
}

export function newestMtime(dir: string, extraFiles: string[]): number {
  let newest = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else newest = Math.max(newest, st.mtimeMs);
    }
  };
  walk(dir);
  for (const f of extraFiles) newest = Math.max(newest, statSync(f).mtimeMs);
  return newest;
}

/** Ephemeral static file server for the fixture pages. POST
 *  /v1/chat/completions is a CANNED local model: it reads the planner's
 *  evidence block, finds the first h1 region and answers with a valid S1
 *  proposal targeting it — a deterministic stand-in so workspace tests run
 *  the full user workflow with zero live model and zero external network. */
export function startFixtureServer(): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      // The request body is a JSON chat envelope: evidence newlines live as
      // \n escapes inside message strings — extract the plaintext first.
      let evidenceText = body;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        evidenceText = (parsed.messages ?? []).map((msg) => msg.content ?? '').join('\n');
      } catch {
        /* fall back to raw body matching */
      }
      // Neubrutalism branch: declarations WITHOUT priority — the exact shape
      // the live model produced in the field (the failing plan). The runtime
      // defaults omitted priority to important (plan/08 §92), so the
      // intentional override wins the site's own base styles at verification.
      if (/neubrutalism/i.test(evidenceText)) {
        const bodyMatch = evidenceText.match(/^ {2}(t\d+) \| body\b/m);
        const panelMatch = evidenceText.match(/^ {2}(t\d+) \| main\b/m);
        const content = JSON.stringify({
          kind: 'proposal',
          schemaVersion: 1,
          summary: 'Transform to neubrutalism',
          operations: [
            {
              kind: 'style',
              rules: [
                {
                  target: { targetRef: bodyMatch ? bodyMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [
                    { property: 'background-color', value: '#ffffff' },
                    { property: 'margin', value: '0' },
                  ],
                  conditions: [],
                },
                {
                  target: { targetRef: panelMatch ? panelMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [{ property: 'background-color', value: '#fef3c7' }],
                  conditions: [],
                },
              ],
            },
          ],
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'chatcmpl-fixture-neubrutalism',
          object: 'chat.completion',
          created: 0,
          model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      // Glassmorphism branch: the EXACT field-failing shape (owner report,
      // 2026-09-13) — a `background` SHORTHAND in rule 0 that a later rule on
      // the SAME element overrides at background-color (the net-cascade
      // class), plus -webkit-backdrop-filter declarations (Chromium returns
      // EMPTY for the prefixed computed name and never applies it — the
      // compiler normalizes the alias to the standard property).
      if (/glassmorphism/i.test(evidenceText)) {
        const panelMatch = evidenceText.match(/^ {2}(t\d+) \| main\b/m);
        const navMatch = evidenceText.match(/^ {2}(t\d+) \| nav\b/m);
        const glassContent = JSON.stringify({
          kind: 'proposal',
          schemaVersion: 1,
          summary: 'Transform this into glassmorphism',
          operations: [
            {
              kind: 'style',
              rules: [
                {
                  target: { targetRef: panelMatch ? panelMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [
                    { property: 'background', value: 'rgba(255, 255, 255, 0.1)' },
                    { property: 'border-radius', value: '16px' },
                    { property: 'box-shadow', value: '0 8px 32px rgba(31, 38, 135, 0.2)' },
                  ],
                  conditions: [],
                },
                {
                  target: { targetRef: panelMatch ? panelMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [
                    { property: 'color', value: '#f8fafc' },
                    { property: 'border', value: '1px solid rgba(255, 255, 255, 0.18)' },
                    { property: '-webkit-backdrop-filter', value: 'blur(12px)' },
                  ],
                  conditions: [],
                },
                {
                  target: { targetRef: navMatch ? navMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [
                    { property: 'background-color', value: 'rgba(255, 255, 255, 0.2)' },
                    { property: 'border', value: '1px solid rgba(255, 255, 255, 0.3)' },
                    { property: '-webkit-backdrop-filter', value: 'blur(8px)' },
                  ],
                  conditions: [],
                },
                {
                  // A LATER rule re-declaring rule 0's background longhand on
                  // the SAME element — the net-cascade class that false-failed
                  // the whole batch under per-declaration checks.
                  target: { targetRef: panelMatch ? panelMatch[1] : '' },
                  surface: 'element',
                  state: 'none',
                  declarations: [
                    { property: 'background-color', value: 'rgba(255, 255, 255, 0.35)' },
                  ],
                  conditions: [],
                },
              ],
            },
          ],
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'chatcmpl-fixture-glass',
          object: 'chat.completion',
          created: 0,
          model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content: glassContent }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      // S7.1 branch: a goal asking for a shortcut gets a bindKey proposal on
      // the first observed button — the canned provider stays a stand-in for
      // the real model path; no test-only production hooks exist.
      if (/bind a shortcut/i.test(evidenceText)) {
        const actionMatch = evidenceText.match(/^ {2}(a\d+) \| button\b.* → (t\d+)$/m);
        const chordMatch = evidenceText.match(/chord:([A-Za-z0-9+]+)/);
        const bindContent = actionMatch
          ? JSON.stringify({
              kind: 'proposal',
              schemaVersion: 1,
              summary: 'Bind a shortcut to the Poke button',
              operations: [{
                kind: 'bindKey',
                target: { targetRef: actionMatch[2] },
                chord: chordMatch ? chordMatch[1] : 'Alt+G',
                actionIds: ['activate'],
              }],
            })
          : JSON.stringify({ kind: 'cannotComplete', reason: `no button evidence in the payload; got: ${evidenceText.slice(0, 2000).replace(/\s+/g, ' ')}` });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'chatcmpl-fixture-bind',
          object: 'chat.completion',
          created: 0,
          model: 'fixture-model',
          choices: [{ index: 0, message: { role: 'assistant', content: bindContent }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      const m = evidenceText.match(/^ {2}(t\d+) \| h1\b/m);
      if (!m) console.log('[fixture-provider] no h1 match; evidence head:', evidenceText.slice(-2500).replace(/\s+/g, ' ').slice(0, 2500));
      const targetRef = m ? m[1] : '';
      const content = targetRef
        ? JSON.stringify({
            kind: 'proposal',
            schemaVersion: 1,
            summary: 'Color the main heading crimson',
            operations: [
              {
                kind: 'style',
                rules: [
                  {
                    target: { targetRef },
                    surface: 'element',
                    state: 'none',
                    declarations: [{ property: 'color', value: 'crimson', priority: 'important' }],
                    conditions: [],
                  },
                ],
              },
            ],
          })
        : JSON.stringify({ kind: 'cannotComplete', reason: `no heading evidence in the payload; got: ${evidenceText.slice(0, 4000).replace(/\s+/g, ' ')}` });
      const payload = JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        created: 0,
        model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(FIXTURES_DIR, name);
    if (!path.startsWith(FIXTURES_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    } catch {
      res.writeHead(404).end('no such fixture');
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no fixture server address');
      resolvePromise({
        server,
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
