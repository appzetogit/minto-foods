import test from 'node:test';
import assert from 'node:assert/strict';

import { publicReviewerName } from './rating.service.js';

test('reviews show a first name and an initial, never the full name', () => {
    assert.equal(publicReviewerName('Tanu Chouhan'), 'Tanu C.');
    assert.equal(publicReviewerName('  om  prakash parteki '), 'om P.');
    assert.equal(publicReviewerName('Tanu'), 'Tanu');
    assert.equal(publicReviewerName(''), 'Customer');
    assert.equal(publicReviewerName('Customer'), 'Customer');
});
