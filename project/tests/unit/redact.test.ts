/**
 * Unit baseline — src/core/sanitize/redact.ts credential-shape policy.
 *
 * Boundary stub, documented: the module reads the live DOM for form values.
 * Node has no DOM, so tests inject an empty/minimal document — the credential
 * SHAPE policy under test here is pure string handling. Form-value redaction
 * (the DOM half) is exercised in the browser harness, not stubbed here.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveData } from '../../src/core/sanitize/redact.ts';

function fakeDocument(elements: { value?: string; type?: string; name?: string }[]): void {
  (globalThis as { document?: unknown }).document = {
    querySelectorAll: () => elements,
  };
}

beforeEach(() => {
  fakeDocument([]);
});

test('known credential shapes are redacted', () => {
  assert.equal(redactSensitiveData('key is sk-abcdefghij0123456789 done'), 'key is [REDACTED] done');
  assert.equal(redactSensitiveData('auth: Bearer abc123.def-456_789'), 'auth: [REDACTED]');
  assert.equal(redactSensitiveData('token v1.1234567890-abcdefghijklmnopqrst'), 'token [REDACTED]');
});

test('high-entropy tokens (32+ mixed case + digits) are redacted', () => {
  const token = 'aB1cD2eF3gH4jK5lM6nP7qR8sT9uV0wX';
  assert.ok(/^[a-zA-Z0-9]{32,}$/.test(token));
  assert.equal(redactSensitiveData(`secret=${token};`), 'secret=[REDACTED];');
});

test('structural fields are NOT redacted (single-case, hyphenated, selectors)', () => {
  const structural = 'btn-primary-verylongclassname012345678901234567890123456789';
  assert.equal(redactSensitiveData(`class ${structural} stays`), `class ${structural} stays`);
  const selector = 'div.container > ul#list-0123456789012345678901234567890';
  assert.equal(redactSensitiveData(`target ${selector}`), `target ${selector}`);
});

test('form values collected from the DOM are redacted', () => {
  fakeDocument([{ value: 'hunter2secret', type: 'password', name: 'pw' }]);
  const out = redactSensitiveData('the user typed hunter2secret in the field');
  assert.equal(out, 'the user typed [REDACTED] in the field');
});

test('short / empty form values are not treated as secrets', () => {
  fakeDocument([{ value: 'ab', type: 'text', name: 'q' }]);
  assert.equal(redactSensitiveData('searching for ab today'), 'searching for ab today');
});
