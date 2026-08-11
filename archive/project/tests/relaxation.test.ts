/**
 * Constraint-priority relaxation — pure unit check, no browser.
 *
 * ConstraintPriority was assigned in seven places (the Current-IR derivation in
 * ir.ts and every layout language's slot constraints) and read in NONE — the
 * solver's droppedOptionals was always []. resolveNodeConstraints in solve.ts
 * is the call site that now reads .priority: it attempts every constraint on a
 * node, relaxes the LOWEST-priority one on a conflict first, and records the
 * reason; a required-vs-required conflict is reported unsatisfiable, never
 * silently dropped.
 *
 * This test constructs deliberately conflicting pairs and asserts the
 * optional/preferred one is relaxed + reported, and that two required
 * constraints on the same axis are unsatisfiable.
 *
 * Run: node --experimental-strip-types tests/relaxation.test.ts
 */
import assert from 'node:assert';
import { resolveNodeConstraints } from '../src/core/layout/solve.ts';
import type { LayoutConstraint } from '../src/core/layout/ir.ts';

function mk(kind: LayoutConstraint['kind'], priority: LayoutConstraint['priority']): LayoutConstraint {
  return { kind, priority, source: 'law' };
}

// 1. FillParent (required) vs MaxWidth (optional): optional relaxed, required kept.
{
  const { kept, relaxed, unsatisfiable } = resolveNodeConstraints('h1', [
    mk('FillParent', 'required'),
    mk('MaxWidth', 'optional'),
  ]);
  assert.deepEqual(kept.map((c) => c.kind), ['FillParent'], 'kept: FillParent (required)');
  assert.equal(relaxed.length, 1, 'one relaxation');
  assert.equal(relaxed[0].constraint, 'MaxWidth', 'relaxed: MaxWidth');
  assert.equal(relaxed[0].priority, 'optional', 'relaxed priority: optional');
  assert.ok(relaxed[0].reason.includes('relaxed'), 'reason names the relaxation');
  assert.equal(unsatisfiable.length, 0, 'no unsatisfiable');
}

// 2. MaxWidth (preferred) vs FillParent (required): preferred relaxed, regardless of order.
{
  const { kept, relaxed, unsatisfiable } = resolveNodeConstraints('h2', [
    mk('MaxWidth', 'preferred'),
    mk('FillParent', 'required'),
  ]);
  assert.deepEqual(kept.map((c) => c.kind), ['FillParent'], 'kept: FillParent (required) wins over preferred');
  assert.equal(relaxed.length, 1, 'preferred relaxed');
  assert.equal(relaxed[0].constraint, 'MaxWidth', 'relaxed: MaxWidth (preferred)');
  assert.equal(unsatisfiable.length, 0, 'no unsatisfiable');
}

// 3. Two REQUIRED on the same axis -> unsatisfiable, never silently dropped.
{
  const { kept, relaxed, unsatisfiable } = resolveNodeConstraints('h3', [
    mk('FillParent', 'required'),
    mk('MaxWidth', 'required'),
  ]);
  assert.equal(unsatisfiable.length, 1, 'required-vs-required reported unsatisfiable');
  assert.equal(unsatisfiable[0].constraint, 'MaxWidth', 'the conflicting required is named');
  assert.ok(unsatisfiable[0].reason.includes('required'), 'reason names required-vs-required');
  assert.equal(relaxed.length, 0, 'nothing silently relaxed');
  assert.deepEqual(kept.map((c) => c.kind), ['FillParent'], 'first required kept');
}

// 4. Non-conflicting constraints all kept, nothing relaxed.
{
  const { kept, relaxed, unsatisfiable } = resolveNodeConstraints('h4', [
    mk('StackVertically', 'preferred'),
    mk('Centered', 'optional'),
    mk('Gap', 'preferred'),
  ]);
  assert.equal(relaxed.length, 0, 'no conflicts -> no relaxations');
  assert.equal(unsatisfiable.length, 0, 'no unsatisfiable');
  assert.deepEqual(kept.map((c) => c.kind).sort(), ['Centered', 'Gap', 'StackVertically'], 'all kept');
}

console.log('relaxation.test OK — priority read; optional/preferred relaxed + reported; required-vs-required unsatisfiable');