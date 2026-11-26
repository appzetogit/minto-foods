import test from 'node:test';
import assert from 'node:assert/strict';

import { logger } from './logger.js';

// Every level the code calls must exist: socket.js and tracking.worker.js call
// logger.debug, and its absence crashed the API in production.
test('the logger has every level the code calls', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
        assert.equal(typeof logger[level], 'function', `logger.${level}`);
    }
    assert.doesNotThrow(() => logger.debug('dropped fix'));
});
