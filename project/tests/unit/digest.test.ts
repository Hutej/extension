/**
 * Unit baseline — src/core/persist/digest.ts SHA-256 (Web Crypto is the
 * identity digest primitive; vectors pin the exact algorithm/encoding).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../../src/core/persist/digest.ts';

test('sha256Hex matches FIPS vectors', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex is deterministic and hex-encoded', async () => {
  const a = await sha256Hex('Revueon');
  const b = await sha256Hex('Revueon');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, await sha256Hex('Revueon '));
});
