import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * How a restaurant's Aadhaar is stored and how it is shown.
 *
 * Mirrors the two rules in restaurant.service.js. They exist for opposite
 * reasons: stored digits-only so the same number is the same string however it
 * was typed, and shown masked because a profile response is fetched on nearly
 * every screen and would otherwise leave the full number in caches and logs.
 */

const storeAadhaar = (value) => String(value || '').replace(/\D/g, '');

const maskAadhaar = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length <= 4) return digits;
    return `XXXX XXXX ${digits.slice(-4)}`;
};

test('the same number stored the same way however it was typed', () => {
    const forms = ['123412341234', '1234 1234 1234', '1234-1234-1234', ' 1234  1234 1234 '];
    const stored = forms.map(storeAadhaar);
    assert.equal(new Set(stored).size, 1, JSON.stringify(stored));
    assert.equal(stored[0], '123412341234');
});

test('only the last four digits are shown', () => {
    assert.equal(maskAadhaar('123412341234'), 'XXXX XXXX 1234');
    assert.equal(maskAadhaar('1234 5678 9012'), 'XXXX XXXX 9012');
});

test('the mask never leaks a leading digit', () => {
    // The whole point. If any of the first eight digits survive, the mask has
    // failed and it is the most sensitive number the platform holds.
    const masked = maskAadhaar('987612345678');
    assert.ok(!masked.includes('9876'), masked);
    assert.ok(!masked.includes('1234'), masked);
    assert.match(masked, /^XXXX XXXX 5678$/);
});

test('no number gives an empty string, not a mask of nothing', () => {
    // "XXXX XXXX " on a restaurant that never supplied one would read as though
    // something is on file.
    for (const missing of [null, undefined, '', '   ', 'abc']) {
        assert.equal(maskAadhaar(missing), '');
    }
});

test('a too-short number is not padded into looking complete', () => {
    assert.equal(maskAadhaar('12'), '12');
    assert.equal(maskAadhaar('1234'), '1234');
});

test('masking is stable whether the stored value is punctuated or not', () => {
    // Old rows may predate the digits-only rule.
    assert.equal(maskAadhaar('1234-5678-9012'), maskAadhaar('123456789012'));
});
