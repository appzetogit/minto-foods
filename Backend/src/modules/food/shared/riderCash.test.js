import test from 'node:test';
import assert from 'node:assert/strict';

import { cashStatus } from './riderCash.js';

test('at or over the limit the rider is blocked, and told how much clears it', () => {
    assert.deepEqual(cashStatus(1500, 1500), { cashInHand: 1500, limit: 1500, blocked: true, minimumDeposit: 1, remaining: 0 });
    assert.equal(cashStatus(1800, 1500).minimumDeposit, 301);
    assert.equal(cashStatus(1499, 1500).blocked, false);
    assert.equal(cashStatus(1499, 1500).remaining, 1);
});

test('no limit set: never blocked', () => {
    assert.equal(cashStatus(99999, 0).blocked, false);
    assert.equal(cashStatus(99999, 0).remaining, null);
});
