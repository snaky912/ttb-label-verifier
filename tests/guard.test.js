import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { codesMatch, createDailyLimiter } from '../src/server/guard.js';

describe('access code', () => {
  test('matches only the exact code', () => {
    assert.equal(codesMatch('label-demo-7', 'label-demo-7'), true);
    assert.equal(codesMatch('label-demo-8', 'label-demo-7'), false);
    assert.equal(codesMatch('', 'label-demo-7'), false);
    assert.equal(codesMatch(undefined, 'label-demo-7'), false);
  });
});

describe('daily limit', () => {
  test('allows up to the limit, then refuses', () => {
    const lim = createDailyLimiter(3, () => new Date('2026-09-22T10:00:00Z'));
    assert.deepEqual([lim.take(), lim.take(), lim.take(), lim.take()], [true, true, true, false]);
  });

  test('resets on a new UTC day', () => {
    let now = new Date('2026-09-22T23:59:00Z');
    const lim = createDailyLimiter(1, () => now);
    assert.equal(lim.take(), true);
    assert.equal(lim.take(), false);
    now = new Date('2026-09-23T00:01:00Z');
    assert.equal(lim.take(), true);
  });

  test('no limit configured means unlimited', () => {
    const lim = createDailyLimiter(0);
    for (let i = 0; i < 1000; i++) assert.equal(lim.take(), true);
  });
});
