import test from 'node:test';
import assert from 'node:assert/strict';

import { toIndianTel } from './businessSettings.service.js';

test('support numbers are stored as +91 and a 10 digit mobile', () => {
    assert.equal(toIndianTel('98765 43210'), '+919876543210');
    assert.equal(toIndianTel('+91-98765-43210'), '+919876543210');
    assert.equal(toIndianTel('919876543210'), '+919876543210');
    assert.equal(toIndianTel('09876543210'), '+919876543210');
    assert.equal(toIndianTel('12345'), null);
    assert.equal(toIndianTel('5876543210'), null, 'Indian mobiles start 6-9');
});
