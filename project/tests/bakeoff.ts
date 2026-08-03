/**
 * Model bake-off — a ROLE × MODEL matrix. The monolithic call is SPLIT into
 * Architect (composition) + Painter (palette) + Critic (repair), each on its own
 * model. This bake-off runs each ROLE across candidate models and prints a per-role
 * quality × latency table so the operator picks the winner for each role BY EYE.
 *
 * Run: node --experimental-strip-types --env-file=.env tests/bakeoff.ts
 *
 * For each role × candidate: set RV_MODEL_<ROLE>, rebuild the extension (wxt build
 * replaces process.env at build time), run the smoke harness, parse the printed
 * metrics, print a per-role table + a per-role winner. Sequential (one-shot mandate).
 * The operator updates AI_CONFIG.<role>Model with each winner BY EYE — no auto-edit
 * (the by-eye gate is absolute).
 */

import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(import.meta.url.replace('file://', '')));

interface RoleSpec {
  role: 'architect' | 'painter' | 'critic';
  envVar: string;
  candidates: string[];
}

// Per-role candidate models. The Architect is the hard part (composition) → strong
// models; the Painter is palette + type → mid; the Critic is small repair → fastest.
const ROLES: RoleSpec[] = [
  { role: 'architect', envVar: 'RV_MODEL_ARCHITECT', candidates: ['gpt-5.1', 'gpt-5.2', 'gpt-4o'] },
  { role: 'painter', envVar: 'RV_MODEL_PAINTER', candidates: ['gpt-5.1', 'gpt-4o', 'gpt-4o-mini'] },
  { role: 'critic', envVar: 'RV_MODEL_CRITIC', candidates: ['gpt-4o-mini', 'gpt-4o'] },
];
const LATENCY_TARGET_MS = 30_000;

interface RunResult {
  role: string;
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

function runCandidate(role: string, envVar: string, model: string): RunResult {
  process.stdout.write(`\n=== ${role} / ${model} ===\n`);
  // Rebuild the extension with the per-role model set (Vite replaces it at build).
  execSync('npx wxt build', { cwd: ROOT, stdio: 'pipe', env: { ...process.env, [envVar]: model } });
  // Run the smoke harness with the rebuilt extension.
  const out = execSync('node --experimental-strip-types --env-file=.env tests/popup.test.ts', {
    cwd: ROOT, timeout: 180_000, encoding: 'utf-8',
    env: { ...process.env, [envVar]: model, RVGRID: 'smoke' },
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
  // Quality: applied + coverage + change + pixel-clean + latency-under-target.
  const pixelClean = pixelVoids === 0 && pixelInvisible === 0 && pixelSqueeze === 0 ? 1 : 0;
  const withinLatency = wallMs > 0 && wallMs <= LATENCY_TARGET_MS ? 1 : 0;
  const quality = (applied ? 2 : 0) + coverage + changeScore + pixelClean + withinLatency;
  return { role, model, wallMs, applied, changeScore, coverage, pixelVoids, pixelInvisible, pixelSqueeze, paidCalls, quality };
}

// Run the role × model matrix. Per-role results grouped for the per-role winner.
const byRole = new Map<string, RunResult[]>();
for (const { role, envVar, candidates } of ROLES) {
  const roleResults: RunResult[] = [];
  for (const model of candidates) {
    try {
      roleResults.push(runCandidate(role, envVar, model));
    } catch (err) {
      console.error(`\n✗ ${role}/${model} FAILED: ${(err as Error).message}`);
      roleResults.push({ role, model, wallMs: 0, applied: false, changeScore: 0, coverage: 0, pixelVoids: 99, pixelInvisible: 99, pixelSqueeze: 99, paidCalls: 99, quality: 0 });
    }
  }
  byRole.set(role, roleResults);
}

// Print a per-role table + a per-role winner.
console.log('\n\n=== BAKE-OFF RESULTS (role × model matrix) ===');
for (const { role } of ROLES) {
  const results = byRole.get(role) ?? [];
  console.log(`\n— ${role.toUpperCase()} —`);
  console.log('model         | wallMs  | applied | coverage | change | pixel(v/i/s)  | quality');
  console.log('--------------|---------|---------|----------|--------|---------------|-------');
  for (const r of results) {
    console.log(`${r.model.padEnd(13)} | ${String(r.wallMs).padStart(7)} | ${String(r.applied).padStart(7)} | ${r.coverage.toFixed(3).padStart(8)} | ${r.changeScore.toFixed(3).padStart(6)} | ${`${r.pixelVoids}/${r.pixelInvisible}/${r.pixelSqueeze}`.padStart(13)} | ${r.quality.toFixed(2).padStart(6)}`);
  }
  // Per-role winner: best quality within the ≤30s latency target (else best quality).
  const withinLatency = results.filter((r) => r.wallMs > 0 && r.wallMs <= LATENCY_TARGET_MS);
  const pool = withinLatency.length ? withinLatency : results;
  const winner = pool.reduce((best, r) => (r.quality > best.quality ? r : best), pool[0]);
  console.log(`WINNER (${role}): ${winner.model} (quality=${winner.quality.toFixed(2)}, wallMs=${winner.wallMs})${winner.wallMs > LATENCY_TARGET_MS ? ' — WARNING: exceeds 30s target' : ''}`);
}

console.log('\nUpdate AI_CONFIG.<role>Model with each role winner BY EYE — the by-eye gate is absolute.');
