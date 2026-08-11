/**
 * audit-wiring.ts — principle 13 enforcement: no orphans in src/tools/.
 *
 * Two checks, both fail the build (exit 1) if violated:
 *   1. Every export in src/tools/*.ts (except index.ts) is referenced in
 *      src/tools/index.ts — no tool function is written and never registered.
 *   2. The registry (getTool or registry from src/tools/index.ts) is imported
 *      by the agent loop and the content script — every registry entry is
 *      reachable from the loop.
 *
 * Run as part of `npm run build`, before wxt build.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath decodes %20 and keeps the leading slash — raw new URL().pathname
// leaves %20 encoded and breaks on any path containing a space.
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf-8');
}

let failed = false;
function fail(msg: string): void {
  console.error(`  ✖ ${msg}`);
  failed = true;
}

// ── check 1: every export in tools/ appears in index.ts ─────────────

const toolsDir = join(srcDir, 'tools');
const toolFiles = readdirSync(toolsDir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts');

const indexContent = readSrc('tools/index.ts');

for (const file of toolFiles) {
  const content = readFileSync(join(toolsDir, file), 'utf-8');

  // Find all top-level exports: export const X, export function X, export async function X, export type X
  const exportPattern = /export\s+(?:const|function|async function|type|interface)\s+(\w+)/g;
  let match: RegExpExecArray | null;

  while ((match = exportPattern.exec(content)) !== null) {
    const name = match[1];
    // Type exports are fine — they don't need to be in the registry.
    if (/^export\s+(?:type|interface)/.test(match[0])) continue;

    // Check the name appears somewhere in index.ts (import or reference).
    if (!indexContent.includes(name)) {
      fail(`tools/${file} exports "${name}" but it is not referenced in tools/index.ts`);
    }
  }
}

// ── check 2: registry is reachable from the loop and content script ──

const loopContent = readSrc('agent/loop.ts');
const contentContent = readSrc('entrypoints/content.ts');

if (!loopContent.includes('tools/index') && !loopContent.includes('tools/')) {
  fail('agent/loop.ts does not import from tools/ — registry is unreachable from the loop');
}

if (!contentContent.includes('tools/index') && !contentContent.includes('tools/')) {
  fail('entrypoints/content.ts does not import from tools/ — tools are unreachable at execution time');
}

// Also check that getTool or registry is actually used (not just imported).
if (!loopContent.includes('getTool') && !loopContent.includes('registry')) {
  fail('agent/loop.ts imports tools/ but never calls getTool or registry');
}

if (!contentContent.includes('getTool') && !contentContent.includes('registry')) {
  fail('entrypoints/content.ts imports tools/ but never calls getTool or registry');
}

if (failed) {
  console.error('\naudit-wiring: FAIL — orphans found in tools/ (principle 13 violated)');
  process.exit(1);
}

console.log('audit-wiring: OK — every tools/ export is registered, registry is reachable from loop + content');
