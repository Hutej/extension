/**
 * tests/vision-report.ts — Phase 1 (F7 SIGHT) full vision-in-words report.
 *
 * The harness log truncates vision descriptions to 200/500 chars. Phase 1
 * requires the FULL vision-in-words for every screenshot. This sends each
 * before/after PAIR (diff prompt) and each red-test SINGLE (describe prompt)
 * to @cf/moonshotai/kimi-k2.7-code and writes untruncated descriptions to
 * proof/vision-report.json.
 *
 * Rule 14: never send page content for identification; describing OUR OWN test
 * screenshot is explicitly allowed. The author of this script never reads the
 * PNGs — only the vision model sees them, and only its WORDS are kept.
 *
 * Usage: node --experimental-strip-types --env-file=.env tests/vision-report.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SHOT_DIR = join(__dirname, 'screenshots');
const PROOF_DIR = join(ROOT, 'proof');
const OUT = join(PROOF_DIR, 'vision-report.json');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const MODEL = '@cf/moonshotai/kimi-k2.7-code';

const DIFF_PROMPT =
  'You are shown two screenshots of the same web page, before and after a browser tool acted on it. ' +
  'Describe in words what is DIFFERENT between the first and second screenshot — hidden sections, ' +
  'removed sidebars, reduced clutter, inserted boxes, spacing, colours, layout shifts. Be specific and concrete. ' +
  'If nothing visibly changed, say exactly: nothing changed. Do not invent changes.';

const SINGLE_PROMPT =
  'Describe what you see on this screenshot of a web test page, in words. Note the background colour ' +
  'of the page and of any boxed test element, and any text labels. Be concrete and brief.';

interface VisionCall { kind: 'diff' | 'single'; name: string; before?: string; after?: string; image: string; description: string; }

function b64(path: string): string {
  return readFileSync(path).toString('base64');
}

async function callVision(prompt: string, imagePaths: string[]): Promise<string> {
  if (!ACCOUNT_ID || !API_TOKEN) return '[vision skipped: no credentials]';
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const p of imagePaths) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(p)}` } });
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) return `[vision error ${res.status}: ${(await res.text()).slice(0, 200)}]`;
    const data: any = await res.json();
    return (data?.result?.response
      ?? data?.result?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.message?.content
      ?? '[vision: no content returned]') as string;
  } catch (err) {
    return `[vision error: ${(err as Error).message}]`;
  }
}

function exists(name: string): string | null {
  const p = join(SHOT_DIR, name);
  return existsSync(p) ? p : null;
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in .env');
    process.exit(1);
  }

  const calls: VisionCall[] = [];

  // ── Harness before/after pairs (diff prompt) ──────────────────────
  const pairs: [string, string, string][] = [
    ['run1-summarise', 'run1-summarise-before.png', 'run1-summarise.png'],
    ['run2-failing-case', 'run2-failing-case-before.png', 'run2-failing-case.png'],
    ['run4-reduce-clutter', 'run4-reduce-clutter-before.png', 'run4-reduce-clutter.png'],
    ['run5-hn-spacing', 'run5-hn-spacing-before.png', 'run5-hn-spacing.png'],
    ['run6-toggle-cycle', 'run6-toggle-cycle-before.png', 'run6-toggle-cycle.png'],
    ['control-pair', 'control-pair-1.png', 'control-pair-2.png'],
  ];
  for (const [name, before, after] of pairs) {
    const bp = exists(before), ap = exists(after);
    if (!bp || !ap) { console.log(`skip pair ${name}: missing file`); continue; }
    process.stdout.write(`vision diff: ${name} ... `);
    const description = await callVision(DIFF_PROMPT, [bp, ap]);
    calls.push({ kind: 'diff', name, before, after, image: after, description });
    console.log(description.slice(0, 80).replace(/\n/g, ' ') + (description.length > 80 ? '…' : ''));
  }

  // ── Red-test singles (describe prompt) ────────────────────────────
  const reds = [
    'red-v1-unlayered-normal.png', 'red-v2-emitter-bypassed.png',
    'red-v3-author-important.png', 'red-v5a-author-loses.png',
    'red-v4-user-important.png', 'red-v5b-user-wins.png',
  ];
  for (const name of reds) {
    const p = join(PROOF_DIR, name);
    if (!existsSync(p)) { console.log(`skip single ${name}: missing`); continue; }
    process.stdout.write(`vision single: ${name} ... `);
    const description = await callVision(SINGLE_PROMPT, [p]);
    calls.push({ kind: 'single', name, image: name, description });
    console.log(description.slice(0, 80).replace(/\n/g, ' ') + (description.length > 80 ? '…' : ''));
  }

  writeFileSync(OUT, JSON.stringify({
    model: MODEL,
    generated: '2026-08-12',
    rule14_note: 'Vision model describes OUR OWN test screenshots. Origin/path only; never target page content for identification.',
    calls,
  }, null, 2));

  console.log(`\nwrote ${OUT} — ${calls.length} vision descriptions (full, untruncated)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
