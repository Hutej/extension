/**
 * runtime-session.test — S2.1 serial mutation queue + session fence
 * (plan/06 §2 boundary 1, plan/05 §3; T14 Stop ordering, T11 epoch fencing).
 *
 * Pure cores under test: createTaskQueue (priority lanes, cancellation
 * overtaking at safe points, bounded pending, coalesced reconcile) and
 * createSessionCore (document fence, monotonic route epochs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskQueue,
  createSessionCore,
  QUEUE_PRIORITY,
  MAX_PENDING_TASKS,
  QueueCancelledError,
  QueueBusyError,
} from '../../src/runtime/session.ts';
import type { Envelope } from '../../src/contracts.ts';

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  protocolVersion: 1,
  requestId: 'req-1',
  kind: 'control',
  deadlineAt: Date.now() + 5000,
  payload: { command: 'GetOperation', operationId: 'op-1' },
  documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' },
  expectedRouteEpoch: 0,
  ...over,
});

// ── T14: serialization + priority ordering ──────────────────────────────

test('tasks run one at a time in submission order within a lane', async () => {
  const q = createTaskQueue();
  const order: string[] = [];
  const make = (n: string) => async () => {
    order.push(`start-${n}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end-${n}`);
    return n;
  };
  const [a, b, c] = await Promise.all([
    q.submit(QUEUE_PRIORITY.observation, make('a')),
    q.submit(QUEUE_PRIORITY.observation, make('b')),
    q.submit(QUEUE_PRIORITY.observation, make('c')),
  ]);
  assert.deepEqual([a, b, c], ['a', 'b', 'c']);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
});

test('higher-priority lanes run before queued lower-priority work', async () => {
  const q = createTaskQueue();
  const order: string[] = [];
  const gate = q.submit(QUEUE_PRIORITY.observation, async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('observation');
  });
  // Submitted while the observation is still running: all queue behind it,
  // but the pump must pick revoke (0) first, then apply (2), then reconcile (3).
  const reconcile = q.submit(QUEUE_PRIORITY.reconcile, async () => { order.push('reconcile'); });
  const apply = q.submit(QUEUE_PRIORITY.apply, async () => { order.push('apply'); });
  const revoke = q.submit(QUEUE_PRIORITY.revoke, async () => { order.push('revoke'); });
  await gate;
  await Promise.all([reconcile, apply, revoke]);
  assert.deepEqual(order, ['observation', 'revoke', 'apply', 'reconcile']);
});

// ── T14: Stop ordering — cancellation overtakes at the task boundary ────

test('T14: cancelPending rejects queued low-priority work before it starts; revoke lane still runs', async () => {
  const q = createTaskQueue();
  const ran: string[] = [];
  const started = new Promise<void>((resolve) => {
    void q.submit(QUEUE_PRIORITY.observation, async () => {
      ran.push('observation-running');
      resolve();
      await new Promise((r) => setTimeout(r, 10)); // hold the slot
    });
  });
  const queuedObservation = q.submit(QUEUE_PRIORITY.observation, async () => { ran.push('never-observation'); });
  const queuedReconcile = q.submit(QUEUE_PRIORITY.reconcile, async () => { ran.push('never-reconcile'); });
  await started;

  q.cancelPending('user Stop');
  await assert.rejects(queuedObservation, QueueCancelledError);
  await assert.rejects(queuedReconcile, QueueCancelledError);
  assert.equal(q.pendingCount(), 0);

  // Cleanup still proceeds after cancellation: the revoke lane is reserved
  // for exactly that (revoke/cancel/dispose > everything, plan/06 §2).
  await q.submit(QUEUE_PRIORITY.revoke, async () => { ran.push('revoke'); });
  assert.deepEqual(ran, ['observation-running', 'revoke']);
  assert.equal(q.cancelled(), true);
});

test('T14: a new run generation disarms cancellation', async () => {
  const q = createTaskQueue();
  q.cancelPending('stop');
  assert.equal(q.cancelled(), true);
  await assert.rejects(q.submit(QUEUE_PRIORITY.observation, () => 1), QueueCancelledError);
  q.newGeneration();
  assert.equal(q.cancelled(), false);
  assert.equal(await q.submit(QUEUE_PRIORITY.observation, () => 'fresh'), 'fresh');
});

test('T14: tasks already in flight observe the cancellation signal at yield points', async () => {
  const q = createTaskQueue();
  let observed = false;
  const running = q.submit(QUEUE_PRIORITY.reconcile, async (signal) => {
    await new Promise((r) => setTimeout(r, 5));
    if (signal.cancelled) {
      observed = true;
      return 'yielded-cleanly';
    }
    return 'ran-to-completion';
  });
  q.cancelPending('stop');
  assert.equal(await running, 'yielded-cleanly');
  assert.equal(observed, true);
});

test('the pending bound refuses new work deterministically', async () => {
  const q = createTaskQueue();
  const held: Array<Promise<unknown>> = [];
  // One task holds the single execution slot; MAX_PENDING fill the queue.
  held.push(q.submit(QUEUE_PRIORITY.observation, () => new Promise((r) => setTimeout(r, 20))));
  for (let i = 0; i < MAX_PENDING_TASKS; i++) {
    held.push(q.submit(QUEUE_PRIORITY.observation, () => i));
  }
  await assert.rejects(q.submit(QUEUE_PRIORITY.observation, () => 'one too many'), QueueBusyError);
  await Promise.all(held);
});

test('coalesced reconcile work deduplicates to the running task', async () => {
  const q = createTaskQueue();
  let runs = 0;
  const task = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 5));
    return 'reconciled';
  };
  const first = q.submit(QUEUE_PRIORITY.reconcile, task, { coalesceKey: 'root-1' });
  const second = q.submit(QUEUE_PRIORITY.reconcile, task, { coalesceKey: 'root-1' });
  assert.equal(first, second);
  assert.equal(await first, 'reconciled');
  assert.equal(runs, 1);
  // After completion the coalesce key is free again (cleanup is eventual —
  // give the microtask chain a macrotask to settle).
  await new Promise((r) => setTimeout(r, 0));
  const third = q.submit(QUEUE_PRIORITY.reconcile, task, { coalesceKey: 'root-1' });
  assert.notEqual(third, first);
  assert.equal(await third, 'reconciled');
  assert.equal(runs, 2);
});

// ── session core: I04 document fence + T11 epochs ───────────────────────

test('an unregistered runtime fences every command as stale-document', () => {
  const core = createSessionCore();
  const fence = core.fence(envelope());
  assert.equal(fence?.code, 'stale-document');
});

test('registration adopts the verified DocumentKey and epoch', () => {
  const core = createSessionCore();
  assert.equal(core.lifecycle(), 'booting');
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 2);
  assert.equal(core.lifecycle(), 'ready');
  assert.equal(core.routeEpoch(), 2);
  assert.equal(core.fence(envelope({ expectedRouteEpoch: 2 })), null);
});

test('T08/I04: a command addressed to another instance is fenced stale-document', () => {
  const core = createSessionCore();
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  const fence = core.fence(envelope({
    documentKey: { tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-OLD' },
  }));
  assert.equal(fence?.code, 'stale-document');
  assert.match(fence?.message ?? '', /different runtime instance/);
});

test('T11: local navigation bumps the epoch before awaited work; stale commands are fenced', () => {
  const core = createSessionCore();
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  assert.equal(core.noteLocalNavigation(), 1);
  assert.equal(core.fence(envelope({ expectedRouteEpoch: 0 }))?.code, 'stale-route');
  assert.equal(core.fence(envelope({ expectedRouteEpoch: 1 })), null);
});

test('T11: the broker-authoritative RouteChanged is adopted monotonically', () => {
  const core = createSessionCore();
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  core.adoptRouteEpoch(5);
  assert.equal(core.routeEpoch(), 5);
  core.adoptRouteEpoch(3); // never regress
  assert.equal(core.routeEpoch(), 5);
});

test('a disposed runtime denies everything and cannot be revived', () => {
  const core = createSessionCore();
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  core.dispose();
  assert.equal(core.lifecycle(), 'disposed');
  assert.equal(core.documentKey(), null);
  assert.equal(core.fence(envelope())?.code, 'denied');
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  assert.equal(core.lifecycle(), 'disposed');
});

test('suspend/resume cycle through the BFCache lifecycle states', () => {
  const core = createSessionCore();
  core.registered({ tabId: 4, frameId: 0, browserDocumentId: 'doc-1', runtimeInstanceId: 'ri-1' }, 0);
  core.suspend();
  assert.equal(core.lifecycle(), 'suspended');
  core.resume();
  assert.equal(core.lifecycle(), 'ready');
});
