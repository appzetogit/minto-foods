import test from 'node:test';
import assert from 'node:assert/strict';
import { checkIdentityField } from './adminRestaurantWrite.service.js';

test('empty identity fields are allowed', () => {
    for (const key of ['ownerEmail', 'panNumber', 'gstNumber', 'fssaiNumber', 'ifscCode', 'accountNumber']) {
        assert.equal(checkIdentityField(key, ''), '');
        assert.equal(checkIdentityField(key, undefined), '');
    }
});

test('valid values pass and codes are upper-cased', () => {
    assert.equal(checkIdentityField('ownerEmail', ' Owner@Example.com '), 'owner@example.com');
    assert.equal(checkIdentityField('panNumber', 'abcde1234f'), 'ABCDE1234F');
    assert.equal(checkIdentityField('gstNumber', '27abcde1234f1z5'), '27ABCDE1234F1Z5');
    assert.equal(checkIdentityField('fssaiNumber', '12345678901234'), '12345678901234');
    assert.equal(checkIdentityField('ifscCode', 'sbin0001234'), 'SBIN0001234');
    assert.equal(checkIdentityField('accountNumber', '123456789012'), '123456789012');
});

test('malformed values are refused with the field named', () => {
    assert.throws(() => checkIdentityField('ownerEmail', 'owner@'), /Owner email/);
    assert.throws(() => checkIdentityField('panNumber', 'ABCD1234F'), /PAN/);
    assert.throws(() => checkIdentityField('gstNumber', '27ABCDE1234F1Y5'), /GSTIN/);
    assert.throws(() => checkIdentityField('fssaiNumber', '1234567890123'), /FSSAI/);
    assert.throws(() => checkIdentityField('fssaiNumber', '1234567890123a'), /FSSAI/);
    assert.throws(() => checkIdentityField('ifscCode', 'SBIN1001234'), /IFSC/);
    assert.throws(() => checkIdentityField('accountNumber', '12345'), /account number/);
    assert.throws(() => checkIdentityField('accountNumber', '1234 5678 90'), /account number/);
});
