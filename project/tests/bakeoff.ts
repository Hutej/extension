/**
 * Model bake-off — sequentially run the harness with each candidate model and
 * pick the winner by quality within the ≤30s latency target. One-time, non-
 * shipping. The operator updates config styleModel with the winner BY EYE — no
 * auto-edit (the by-eye gate is absolute).
 *
 * Run: node --experimental-strip-types --env-file=.env tests/bakeoff.ts
 *
 * For each candidate: set WM_MODEL, rebuild the extension (wxt build — Vite
 * replaces process.env.WM_MODEL at build time), run the smoke harness, parse the
 * printed metrics, and print a table. Sequential — no parallel (one-shot mandate).
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(import.meta.url.replace('file://', '')));
const CANDIDATES = ['gpt-5.1', 'gpt-5.2', 'gpt-4o'];
const LATENCY_TARGET_MS = 30_000;

interface RunResult {
  model: string;
  wallMs: number;
  applied: boolean;
  changeScore: number;
  coverage: number;
  pixelVoids: number;
  pixelInvisible: number;
  pixelSqueeze: number;
  paidCalls: number;
  quality: number;
}

function runCandidate(model: string): RunResult {
  process.stdout.write(`\n=== ${model} ===\n`);
  // Rebuild the extension with WM_MODEL set (Vite replaces it at build time).
  execSync('npx wxt build', { cwd: ROOT, stdio: 'pipe', env: { ...process.env, WM_MODEL: model } });
  // Run the smoke harness with the rebuilt extension.
  const out = execSync('node --experimental-strip-types --env-file=.env tests/popup.test.ts', {
    cwd: ROOT, timeout: 180_000, encoding: 'utf-8',
    env: { ...process.env, WM_MODEL: model, WMGRID: 'smoke' },
  });
  // Parse metrics from stdout.
  const wallMatch = out.match(/wall-clock:\s*([\d.]+)s/);
  const applied = /HARNESS PASS/.test(out);
  const changeMatch = out.match(/change:\s*([\d.]+)/);
  const covMatch = out.match(/coverage:\s*([\d.]+)/);
  const pixelMatch = out.match(/pixel:\s*voids=(\d+)\s+invisible=(\d+)\s+squeeze=(\d+)/);
  const paidMatch = out.match(/paidCalls=(\d+)/);
  const wallMs = wallMatch ? Math.round(parseFloat(wallMatch[1]) * 1000) : 0;
  const changeScore = changeMatch ? parseFloat(changeMatch[1]) : 0;
  const coverage = covMatch ? parseFloat(covMatch[1]) : 0;
  const pixelVoids = pixelMatch ? parseInt(pixelMatch[1]) : 99;
  const pixelInvisible = pixelMatch ? parseInt(pixelMatch[2]) : 99;
  const pixelSqueeze = pixelMatch ? parseInt(pixelMatch[3]) : 99;
  const paidCalls = paidMatch ? parseInt(paidMatch[1]) : 99;
  // Quality: applied + coverage + change + pixel-clean + no-reason.
  const pixelClean = pixelVoids === 0 && pixelInvisible === 0 && pixelSqueeze === 0 ? 1 : 0;
  const quality = (applied ? 2 : 0) + coverage + changeScore + pixelClean + (paidCalls <= 1 ? 1 : 0);
  return { model, wallMs, applied, changeScore, coverage, pixelVoids, pixelInvisible, pixelSqueeze, paidCalls, quality };
}

const results: RunResult[] = [];
for (const model of CANDIDATES) {
  try {
    results.push(runCandidate(model));
  } catch (err) {
    console.error(`\n✗ ${model} FAILED: ${(err as Error).message}`);
    results.push({ model, wallMs: 0, applied: false, changeScore: 0, coverage: 0, pixelVoids: 99, pixelInvisible: 99, pixelSqueeze: 99, paidCalls: 99, quality: 0 });
  }
}

// Print the table.
console.log('\n\n=== BAKE-OFF RESULTS ===');
console.log('model       | wallMs  | applied | coverage | change | pixel(v/i/s)  | paidCalls | quality');
console.log('------------|---------|---------|----------|--------|---------------|-----------|-------');
for (const r of results) {
  console.log(`${r.model.padEnd(11)} | ${String(r.wallMs).padStart(7)} | ${String(r.applied).padStart(7)} | ${r.coverage.toFixed(3).padStart(8)} | ${r.changeScore.toFixed(3).padStart(6)} | ${`${r.pixelVoids}/${r.pixelInvisible}/${r.pixelSqueeze}`.padStart(13)} | ${String(r.paidCalls).padStart(9)} | ${r.quality.toFixed(2).padStart(6)}`);
}

// Pick the winner: best quality within the ≤30s latency target.
const withinLatency = results.filter((r) => r.wallMs > 0 && r.wallMs <= LATENCY_TARGET_MS);
const pool = withinLatency.length ? withinLatency : results;
const winner = pool.reduce((best, r) => (r.quality > best.quality ? r : best), pool[0]);
console.log(`\nWINNER: ${winner.model} (quality=${winner.quality.toFixed(2)}, wallMs=${winner.wallMs})${winner.wallMs > LATENCY_TARGET_MS ? ' — WARNING: exceeds 30s target' : ''}`);
console.log('Update config styleModel with the winner BY EYE — the by-eye gate is absolute.');
