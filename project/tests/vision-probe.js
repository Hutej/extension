/**
 * tests/vision-probe.js — standalone vision check for Phase 1 (F7 SIGHT).
 *
 * Purpose: prove we can get a vision model to DESCRIBE A SCREENSHOT IN WORDS.
 * This is the whole point of F7 SIGHT — without it, "green is not done" forever.
 *
 * - Loads Cloudflare creds from .env via node --env-file=.env
 * - Uses ONLY @cf/moonshotai/kimi-k2.7-code for vision (per instruction; no
 *   agent model is touched).
 * - First verifies the token (/user/tokens/verify) so a 401 is explained,
 *   not mysterious.
 * - Then sends a real PNG (a proof screenshot) and asks the model to describe
 *   it in one sentence.
 *
 * Run:  node --env-file=.env tests/vision-probe.js [path/to/image.png]
 *
 * No dependency on playwright or the extension — pure fetch. Exits 0 on a real
 * description, 1 on any failure, printing the reason so the next step is clear.
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const VISION_MODEL = '@cf/moonshotai/kimi-k2.7-code';

const imgPath = process.argv[2] || 'proof/red-v1-unlayered-normal.png';
const fs = await import('node:fs');

function fail(msg) {
  console.error('VISION PROBE FAILED:', msg);
  process.exit(1);
}

if (!ACCOUNT_ID || !API_TOKEN) {
  fail('missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in env (load with --env-file=.env)');
}

console.log('--- vision-probe ---');
console.log('account_id len:', ACCOUNT_ID.length, '| token len:', API_TOKEN.length, '| token prefix:', API_TOKEN.slice(0, 4));
console.log('vision model:', VISION_MODEL);
console.log('image:', imgPath);

// 1. Verify the token — explains a 401 instead of guessing.
console.log('\n[1/2] verifying token…');
const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
  headers: { Authorization: `Bearer ${API_TOKEN}` },
});
const verifyRaw = await verifyRes.text();
let verifyBody;
try { verifyBody = JSON.parse(verifyRaw); } catch { verifyBody = { _raw: verifyRaw }; }
console.log('verify status:', verifyRes.status);
if (verifyRes.status !== 200 || !verifyBody.success) {
  console.log('verify body:', JSON.stringify(verifyBody).slice(0, 500));
  fail(`token rejected (status ${verifyRes.status}). If the token is valid but scoped, it needs Workers AI access on account ${ACCOUNT_ID}.`);
}
console.log('verify ok — token is valid and active.');

// 2. Send an image to kimi-k2.7-code and ask for a one-sentence description.
let imgB64;
try {
  const buf = fs.readFileSync(imgPath);
  imgB64 = buf.toString('base64');
  console.log('image bytes:', buf.length, '| base64 len:', imgB64.length);
} catch (e) {
  fail(`could not read image ${imgPath}: ${e.message}`);
}

console.log('\n[2/2] sending image to vision model…');
const aiUrl = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${VISION_MODEL}`;
const aiRes = await fetch(aiUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_TOKEN}`,
  },
  body: JSON.stringify({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot in one sentence. Be concrete about what is on the page.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imgB64}` } },
        ],
      },
    ],
  }),
});
console.log('ai status:', aiRes.status);
const aiText = await aiRes.text();
if (aiRes.status !== 200) {
  console.log('ai body:', aiText.slice(0, 600));
  fail(`vision call failed (status ${aiRes.status}).`);
}
let aiBody;
try { aiBody = JSON.parse(aiText); } catch { fail('vision response was not JSON: ' + aiText.slice(0, 300)); }

// Workers AI returns { result: { response: "…" } } for text models.
const description =
  aiBody?.result?.response ??
  aiBody?.result?.message?.content ??
  aiBody?.result?.choices?.[0]?.message?.content ??
  null;

if (!description || typeof description !== 'string') {
  console.log('ai body (raw):', aiText.slice(0, 600));
  fail('vision call returned 200 but no description string was found in the response.');
}

console.log('\n================ VISION DESCRIPTION ================');
console.log(description.trim());
console.log('====================================================');
console.log('\nVISION PROBE PASSED — kimi-k2.7-code described the image in words.');
process.exit(0);
