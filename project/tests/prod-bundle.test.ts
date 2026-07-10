/**
 * Prod-bundle backdoor test.
 * Asserts that DEV-only test injection symbols are dead-code-eliminated
 * from the production build output.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prodDir = path.resolve(__dirname, '..', '.output', 'chrome-mv3');

const FORBIDDEN_STRINGS = [
  '_testInjectedError',
  'setTestInjectedError',
  'INJECT_ERROR',
];

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log('=== Prod Bundle Backdoor Absence Test ===\n');

// Read all JS files from the production build
const files = fs.readdirSync(prodDir, { recursive: true }) as string[];
const jsFiles = files.filter(f => f.endsWith('.js')).map(f => path.join(prodDir, f));

console.log(`Scanning ${jsFiles.length} JS file(s) in ${prodDir}\n`);

for (const file of jsFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  const basename = path.relative(prodDir, file);

  for (const forbidden of FORBIDDEN_STRINGS) {
    check(`${basename} does NOT contain "${forbidden}"`, !content.includes(forbidden));
  }
}

// Also verify logDebug has no output in prod (it's gated by import.meta.env.DEV)
const contentJs = jsFiles.find(f => f.includes('content'));
if (contentJs) {
  const content = fs.readFileSync(contentJs, 'utf-8');
  check('content.js does NOT contain "[WebMorph DEBUG]"', !content.includes('[WebMorph DEBUG]'));
}

const bgJs = jsFiles.find(f => f.includes('background'));
if (bgJs) {
  const content = fs.readFileSync(bgJs, 'utf-8');
  check('background.js does NOT contain "[WebMorph DEBUG]"', !content.includes('[WebMorph DEBUG]'));
}

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('PROD BUNDLE CONTAINS FORBIDDEN SYMBOLS!');
  process.exit(1);
} else {
  console.log('All prod bundle backdoor checks passed!');
}
