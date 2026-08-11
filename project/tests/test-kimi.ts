/**
 * test-kimi — prove the vision path works on existing screenshots.
 * Usage: node --experimental-strip-types --env-file=.env tests/test-kimi.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(__dirname, 'screenshots');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const MODEL = '@cf/moonshotai/kimi-k2.7-code';

const PROMPT = 'Describe what you see on this web page screenshot. Note any visible modifications: hidden sections, removed sidebars, reduced clutter, or style overlays. Be brief but specific.';

async function describe(path: string): Promise<string> {
  if (!ACCOUNT_ID || !API_TOKEN) return '[no credentials]';
  const base64 = readFileSync(path).toString('base64');
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ]}],
      }),
    });
    if (!res.ok) return `[vision error ${res.status}: ${(await res.text()).slice(0, 200)}]`;
    const data: any = await res.json();
    return data?.result?.choices?.[0]?.message?.content
      ?? data?.result?.response
      ?? data?.choices?.[0]?.message?.content
      ?? '[no content returned]';
  } catch (err) {
    return `[vision error: ${(err as Error).message}]`;
  }
}

const shots = [
  'run1-summarise.png',
  'run2-failing-case.png',
  'run3-wikipedia-sidebar.png',
  'run4-reduce-clutter.png',
  'run5-toggle-cycle.png',
  'run3-hide-shorts.png',
];

for (const name of shots) {
  const path = join(SHOT_DIR, name);
  console.log(`\n═══ ${name} ═══`);
  try {
    const desc = await describe(path);
    console.log(desc.slice(0, 500));
  } catch (err) {
    console.log(`ERROR: ${(err as Error).message}`);
  }
}
