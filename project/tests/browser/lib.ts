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

/** Ephemeral static file server for the fixture pages. */
export function startFixtureServer(): Promise<{ server: Server; origin: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
