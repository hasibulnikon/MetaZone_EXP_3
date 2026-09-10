// MetaZone frontend regression test: Test All event/request correlation
// (v0.9.4.1). Plain Node, no dependencies (no jsdom/mocha/jest) -- this
// loads the real events.js and exercises the actual BackendEvents
// implementation the app ships with, not a reimplementation of it.
//
// Run:
//   node frontend/tests/test_event_correlation.js
//
// This deliberately does NOT try to drive settings.js's full DOM-based
// UI (that needs a real browser -- see the Playwright checks used
// during development for that). What it does cover is the actual bug
// from the v0.9.4.1 brief: Test All's progress counter must only
// react to key_validated events belonging to its own batch, using the
// same BackendEvents.matchesRequest() helper settings.js's Test All
// handler now calls.

const assert = require('assert');

// events.js is a plain browser script (not a CommonJS module) that
// touches `window` at load time for unrelated bootstrapping (the
// pywebview-ready helper, etc.) -- none of that is needed to test
// BackendEvents itself, so this stubs just enough of `window` for the
// file to load under Node, without modifying events.js's real browser
// behavior at all (the only change made to events.js for this test is
// the `module.exports` guard at its very end, which is a no-op in an
// actual browser).
global.window = global.window || {};
global.window.addEventListener = global.window.addEventListener || (() => {});

const { BackendEvents } = require('../js/events.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// -- matchesRequest itself -------------------------------------------------

test('matchesRequest: true when request_id matches', () => {
  assert.strictEqual(BackendEvents.matchesRequest({ request_id: 'abc' }, 'abc'), true);
});

test('matchesRequest: false when request_id differs', () => {
  assert.strictEqual(BackendEvents.matchesRequest({ request_id: 'abc' }, 'xyz'), false);
});

test('matchesRequest: false when payload has no request_id at all', () => {
  assert.strictEqual(BackendEvents.matchesRequest({}, 'abc'), false);
});

test('matchesRequest: false (not a crash) when payload is null/undefined', () => {
  assert.strictEqual(BackendEvents.matchesRequest(null, 'abc'), false);
  assert.strictEqual(BackendEvents.matchesRequest(undefined, 'abc'), false);
});

// -- on/off lifecycle --------------------------------------------------------

test('off() actually removes the listener -- it does not just no-op', () => {
  let calls = 0;
  const fn = () => calls++;
  BackendEvents.on('__test_evt__', fn);
  BackendEvents.dispatch([['__test_evt__', {}]]);
  BackendEvents.off('__test_evt__', fn);
  BackendEvents.dispatch([['__test_evt__', {}]]);
  assert.strictEqual(calls, 1, 'listener should only have fired once, before off()');
});

test('off() only removes the specific function passed, not all listeners for that event', () => {
  let a = 0, b = 0;
  const fnA = () => a++;
  const fnB = () => b++;
  BackendEvents.on('__test_evt2__', fnA);
  BackendEvents.on('__test_evt2__', fnB);
  BackendEvents.off('__test_evt2__', fnA);
  BackendEvents.dispatch([['__test_evt2__', {}]]);
  assert.strictEqual(a, 0);
  assert.strictEqual(b, 1);
});

// -- The actual Test All scenario from the v0.9.4.1 brief -------------------
// Mirrors settings.js's real onResult handler shape: a closure over
// requestId/total/done, registered via BackendEvents.on('key_validated', ...),
// counting only events whose request_id matches this batch's own.

function simulateTestAllBatch(requestId, total) {
  let done = 0;
  const onResult = (payload) => {
    if (!BackendEvents.matchesRequest(payload, requestId)) return;
    done = Math.min(done + 1, total);
  };
  BackendEvents.on('key_validated', onResult);
  return {
    done: () => done,
    stop: () => BackendEvents.off('key_validated', onResult),
  };
}

test('unrelated key_validated event (different/no request_id) does not move the counter', () => {
  const batch = simulateTestAllBatch('batch-A', 2);
  BackendEvents.dispatch([
    ['key_validated', { request_id: 'unrelated-manual-click', ok: true }],
  ]);
  assert.strictEqual(batch.done(), 0);
  batch.stop();
});

test('events belonging to the batch count correctly regardless of arrival order', () => {
  const batch = simulateTestAllBatch('batch-B', 3);
  // Deliberately out of any particular "key order" -- correlation
  // only cares about request_id, not which key or what order.
  BackendEvents.dispatch([
    ['key_validated', { request_id: 'batch-B', key: 'k3' }],
    ['key_validated', { request_id: 'unrelated', key: 'kX' }],
    ['key_validated', { request_id: 'batch-B', key: 'k1' }],
    ['key_validated', { request_id: 'batch-B', key: 'k2' }],
  ]);
  assert.strictEqual(batch.done(), 3);
  batch.stop();
});

test('progress never exceeds total even with a stray duplicate event', () => {
  const batch = simulateTestAllBatch('batch-C', 2);
  BackendEvents.dispatch([
    ['key_validated', { request_id: 'batch-C' }],
    ['key_validated', { request_id: 'batch-C' }],
    ['key_validated', { request_id: 'batch-C' }], // one too many
  ]);
  assert.strictEqual(batch.done(), 2);
  batch.stop();
});

test('a stale batch (old request_id) cannot affect a newer batch tracked at the same time', () => {
  const oldBatch = simulateTestAllBatch('batch-OLD', 2);
  // Old batch never got its stop() called -- simulates "abandoned"
  // rather than cleanly finished, which is exactly the scenario the
  // v0.9.4.1 fix needed to survive.
  const newBatch = simulateTestAllBatch('batch-NEW', 2);

  BackendEvents.dispatch([['key_validated', { request_id: 'batch-NEW' }]]);
  assert.strictEqual(newBatch.done(), 1);
  assert.strictEqual(oldBatch.done(), 0, 'the new batch\'s event must not leak into the old one');

  BackendEvents.dispatch([['key_validated', { request_id: 'batch-OLD' }]]);
  assert.strictEqual(oldBatch.done(), 1);
  assert.strictEqual(newBatch.done(), 1, 'the old batch\'s event must not leak into the new one');

  oldBatch.stop();
  newBatch.stop();
});

test('two independently-tracked batches both finish correctly when interleaved', () => {
  const batchX = simulateTestAllBatch('X', 2);
  const batchY = simulateTestAllBatch('Y', 2);
  BackendEvents.dispatch([
    ['key_validated', { request_id: 'X' }],
    ['key_validated', { request_id: 'Y' }],
    ['key_validated', { request_id: 'X' }],
    ['key_validated', { request_id: 'Y' }],
  ]);
  assert.strictEqual(batchX.done(), 2);
  assert.strictEqual(batchY.done(), 2);
  batchX.stop();
  batchY.stop();
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
