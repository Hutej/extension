/**
 * Unit baseline — src/shared/color.ts (pure color math; plan S0.1 "relevant
 * existing pure-helper baseline"). These pin current behavior: a change here
 * is a contract change and must be reviewed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, isTransparent, contrastRatio, contrastFloor, colorfulness, extractGradientStops } from '../../src/shared/color.ts';

const eqRGBA = (a: readonly number[] | null, b: number[], msg = ''): void =>
  assert.deepEqual(a, b, msg);

test('parseColor: rgb/rgba forms', () => {
  eqRGBA(parseColor('rgb(255, 0, 0)'), [255, 0, 0, 1]);
  eqRGBA(parseColor('rgba(16, 32, 48, 0.25)'), [16, 32, 48, 0.25]);
  eqRGBA(parseColor('rgba(1, 2, 3, 50%)'), [1, 2, 3, 0.5]);
  eqRGBA(parseColor('rgb(300, 500, 4.4)'), [255, 255, 4, 1]); // clamped
  // Current parse limitation: a sign-prefixed component does not match the
  // grammar at all (documented, not silently coerced). S1.1's decoder owns
  // the typed replacement.
  assert.equal(parseColor('rgb(300, -5, 4.4)'), null);
});

test('parseColor: hex forms', () => {
  eqRGBA(parseColor('#FF0000'), [255, 0, 0, 1]);
  eqRGBA(parseColor('#f00'), [255, 0, 0, 1]);
  eqRGBA(parseColor('#12345678'), [0x12, 0x34, 0x56, 0x78 / 255]);
  eqRGBA(parseColor('#00000000'), [0, 0, 0, 0]);
});

test('parseColor: hsl forms', () => {
  eqRGBA(parseColor('hsl(0, 100%, 50%)'), [255, 0, 0, 1]);
  eqRGBA(parseColor('hsl(120, 100%, 25%)'), [0, 128, 0, 1]);
  eqRGBA(parseColor('hsla(240, 100%, 50%, 0.5)'), [0, 0, 255, 0.5]);
});

test('parseColor: non-colors are null, not guesses', () => {
  assert.equal(parseColor(''), null);
  assert.equal(parseColor('not-a-color'), null);
  assert.equal(parseColor('var(--accent)'), null);
  eqRGBA(parseColor('transparent'), [0, 0, 0, 0]);
});

test('isTransparent: alpha below 0.1 or unparseable counts as no surface', () => {
  assert.equal(isTransparent('rgba(0, 0, 0, 0.05)'), true);
  assert.equal(isTransparent('#00000000'), true);
  assert.equal(isTransparent('rgb(0, 0, 0)'), false);
  // Unknown color spaces (oklch etc.) are not parseable → treated as no solid surface.
  assert.equal(isTransparent('oklch(0.5 0.2 30)'), true);
});

test('contrastRatio: WCAG extremes and a known mid value', () => {
  assert.equal(contrastRatio([255, 255, 255, 1], [0, 0, 0, 1]), 21);
  assert.equal(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1]), 21);
  const redWhite = contrastRatio([255, 0, 0, 1], [255, 255, 255, 1]);
  assert.ok(Math.abs(redWhite - 3.998) < 0.01, `red/white ratio ${redWhite}`);
});

test('contrastFloor: WCAG large-text allowance', () => {
  assert.equal(contrastFloor(16, 400), 4.5);
  assert.equal(contrastFloor(16, '700'), 4.5); // <18.66px bold is still normal text
  assert.equal(contrastFloor(24, 400), 3.0);
  assert.equal(contrastFloor(18.66, 700), 3.0);
  assert.equal(contrastFloor(24, 'bold'), 3.0); // unparseable weight falls back to 400; size decides
});

test('colorfulness: accents score, neutrals and translucent do not', () => {
  assert.equal(colorfulness([255, 0, 0, 1]), 1);
  assert.equal(colorfulness([128, 128, 128, 1]), 0);
  assert.equal(colorfulness([255, 0, 0, 0.2]), 0);
});

test('extractGradientStops: every parseable stop, positions skipped', () => {
  assert.deepEqual(
    extractGradientStops('linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))'),
    [[255, 0, 0, 1], [0, 0, 255, 1]],
  );
  assert.deepEqual(extractGradientStops('linear-gradient(45deg, #f00, #00f)'), [[255, 0, 0, 1], [0, 0, 255, 1]]);
  // rgb() containing commas must not split the stop list.
  assert.deepEqual(
    extractGradientStops('linear-gradient(90deg, rgba(10, 20, 30, 0.9) 0%, rgba(40, 50, 60, 0.9) 100%)'),
    [[10, 20, 30, 0.9], [40, 50, 60, 0.9]],
  );
  assert.deepEqual(extractGradientStops('rgb(255, 0, 0)'), []);
  assert.deepEqual(extractGradientStops('none'), []);
  assert.deepEqual(extractGradientStops(''), []);
});
