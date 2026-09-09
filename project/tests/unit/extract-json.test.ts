/**
 * Unit baseline — src/core/reason/extract.ts (tolerant JSON extraction from a
 * model response). Pins the CURRENT extraction contract including its
 * ambiguities (first parseable object wins on multiple objects — S1.1's
 * decoder will tighten this; the test documents today's behavior).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, balancedObject } from '../../src/core/reason/extract.ts';

test('bare JSON parses directly', () => {
  assert.deepEqual(extractJson('{"a":1}'), { ok: true, json: { a: 1 } });
  assert.deepEqual(extractJson('  {"a": {"b": [1, 2]}}  '), { ok: true, json: { a: { b: [1, 2] } } });
});

test('markdown-fenced JSON parses (json and plain fences)', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { ok: true, json: { a: 1 } });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { ok: true, json: { a: 1 } });
});

test('prose around JSON parses', () => {
  assert.deepEqual(extractJson('Here is the plan:\n{"tool":"applyCss"}\nHope that helps.'), { ok: true, json: { tool: 'applyCss' } });
});

test('adversarial: a brace pair in prose does not defeat extraction', () => {
  // The prose "{selector}" must be skipped; the first PARSEABLE object wins.
  assert.deepEqual(
    extractJson('I will use the {selector} pattern:\n{"a":1}'),
    { ok: true, json: { a: 1 } },
  );
});

test('braces inside string values do not break the balanced scan', () => {
  assert.deepEqual(extractJson('{"s":"has } brace"}'), { ok: true, json: { s: 'has } brace' } });
  assert.deepEqual(extractJson('{"s":"quote \\" and { brace"}'), { ok: true, json: { s: 'quote " and { brace' } });
});

test('multiple objects: first parseable object wins (current contract)', () => {
  assert.deepEqual(extractJson('{"a":1} trailing junk {"b":2}'), { ok: true, json: { a: 1 } });
});

test('truncated / non-JSON input is rejected, never guessed', () => {
  assert.equal(extractJson('{"a":1').ok, false);
  assert.equal(extractJson('no json here').ok, false);
  assert.equal(extractJson('').ok, false);
});

test('balancedObject: returns the object slice or null when unbalanced', () => {
  assert.equal(balancedObject('x {"a":1} y', 2), '{"a":1}');
  assert.equal(balancedObject('{"a":"}"}', 0), '{"a":"}"}');
  assert.equal(balancedObject('{"a":1', 0), null);
});
