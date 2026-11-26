import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describeError, installProcessGuards } from './processGuards.js';

const setup = (opts = {}) => {
  const proc = new EventEmitter();
  const lines = [];
  const exits = [];
  installProcessGuards({
    logger: { error: (m) => lines.push(m) },
    name: 'API',
    exit: (code) => exits.push(code),
    proc,
    ...opts,
  });
  return { proc, lines, exits };
};

test('an unhandled rejection is logged with its stack and does not exit', () => {
  const { proc, lines, exits } = setup();
  proc.emit('unhandledRejection', new Error('push failed'));
  assert.deepEqual(exits, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /push failed/);
  assert.match(lines[0], /processGuards\.test\.js/); // the stack, not just the message
});

test('an uncaught exception is logged and exits when asked to', () => {
  const { proc, lines, exits } = setup();
  proc.emit('uncaughtException', new TypeError('boom'));
  assert.deepEqual(exits, [1]);
  assert.match(lines[0], /TypeError: boom/);
});

test('an uncaught exception does not exit when exitOnUncaught is off (non-production API)', () => {
  const { proc, exits } = setup({ exitOnUncaught: false });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(exits, []);
});

test('non-Error reasons are still described', () => {
  assert.equal(describeError('plain'), 'plain');
  assert.equal(describeError({ code: 'P2002' }), '{"code":"P2002"}');
  assert.equal(describeError(undefined), 'undefined');
});
