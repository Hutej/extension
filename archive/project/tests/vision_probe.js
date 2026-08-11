// One-shot Kimi K2.7 vision probe + advisory self-check. Reads the after-screenshot,
// sends ONE request to @cf/moonshotai/kimi-k2.7-code on Workers AI with an image_url
// part. Confirms the endpoint accepts vision AND returns an advisory layout read.
// Per the amendment: development self-checking ONLY, advisory, ≤1 call per run.
import fs from 'node:fs';
import path from 'node:path';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const imgPath = process.argv[2];
if (!accountId || !apiToken || !imgPath || !fs.existsSync(imgPath)) {
  console.error('usage: node vision_probe.js <png path>  (needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)');
  process.exit(1);
}
const b64 = fs.readFileSync(imgPath).toString('base64');
const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
const body = {
  model: '@cf/moonshotai/kimi-k2.7-code',
  max_completion_tokens: 2000,
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      { type: 'text', text: 'This is a redesigned Wikipedia main page (carnival aesthetic). Briefly: (1) Is the layout broken anywhere (white strips, unstyled original-looking regions, overlapping/cut-off content)? (2) Is the color use tasteful or noisy/confetti? (3) Any obviously unreadable text? Be concrete and terse.' },
    ],
  }],
};
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
  body: JSON.stringify(body),
});
console.log('HTTP', res.status);
const txt = await res.text();
try {
  const j = JSON.parse(txt);
  console.log('SHAPE:', JSON.stringify(j, null, 1).slice(0, 1400));
  const content = j?.result?.response ?? j?.choices?.[0]?.message?.content ?? j?.result?.choices?.[0]?.message?.content ?? '(not found)';
  console.log('VERDICT:', content);
} catch {
  console.log('RAW:', txt.slice(0, 600));
}