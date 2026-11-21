import test from 'node:test';
import assert from 'node:assert/strict';
import { prepInfo } from './prepTiming.js';

const t0 = new Date('2026-11-21T10:00:00Z');
const at = (m) => new Date(t0.getTime() + m * 60000);
const order = (status, extra = []) => ({
  orderStatus: status,
  packingMinutes: 20,
  statusHistory: [{ to: 'created', at: at(-2) }, { to: 'confirmed', at: t0 }, ...extra],
});

test('on time while cooking, delayed once past due', () => {
  assert.equal(prepInfo(order('confirmed'), at(10)).delayed, false);
  const late = prepInfo(order('preparing'), at(27));
  assert.equal(late.delayed, true);
  assert.equal(late.delayedByMinutes, 7);
  assert.equal(late.dueAt, at(20).toISOString());
});

test('marked ready late stays flagged; on time does not', () => {
  assert.equal(prepInfo(order('ready_for_pickup', [{ to: 'ready_for_pickup', at: at(25) }]), at(40)).delayedByMinutes, 5);
  assert.equal(prepInfo(order('ready_for_pickup', [{ to: 'ready_for_pickup', at: at(15) }]), at(40)).delayed, false);
});

test('no prep time or not accepted: nothing', () => {
  assert.equal(prepInfo({ orderStatus: 'created', packingMinutes: 20, statusHistory: [] }), null);
  assert.equal(prepInfo({ ...order('confirmed'), packingMinutes: null }), null);
});
