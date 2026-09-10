import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Setting a dish's commission from the dish form.
 *
 * Mirrors the decisions in applyItemCommission and the form's payload builder.
 * The distinction that matters is between three states a form can be in, which
 * a single "value" field flattens if nobody is careful:
 *
 *   absent  -> the caller said nothing; leave whatever rate exists alone
 *   null    -> the field was emptied; clear back to the restaurant's rate
 *   0       -> a real rate meaning the platform takes nothing on this dish
 *
 * Treating an emptied field as 0 would silently drop the platform's cut to
 * nothing; treating it as absent would make it impossible to clear a rate.
 */

/** The form's payload builder: what an input value becomes on the wire. */
const commissionPayload = (rawValue, type = 'percentage') => {
    const raw = String(rawValue || '').trim();
    if (raw === '') return null;
    return {
        commissionType: type === 'amount' ? 'amount' : 'percentage',
        commissionValue: Number(raw),
    };
};

/** The service's dispatch: what the payload does. */
const intentOf = (commission) => {
    if (commission === undefined) return 'leave-alone';
    if (commission === null) return 'clear';
    return 'set';
};

test('an emptied field clears the rate rather than setting zero', () => {
    assert.equal(commissionPayload(''), null);
    assert.equal(commissionPayload('   '), null);
    assert.equal(intentOf(commissionPayload('')), 'clear');
});

test('zero is a real rate, not an empty field', () => {
    // "We take nothing on this dish" is a decision someone made, and it must
    // survive a save rather than reverting to the restaurant rate.
    const payload = commissionPayload('0');
    assert.deepEqual(payload, { commissionType: 'percentage', commissionValue: 0 });
    assert.equal(intentOf(payload), 'set');
});

test('a caller that never mentions commission leaves it alone', () => {
    // A price-only edit must not wipe a rate someone set deliberately.
    assert.equal(intentOf(undefined), 'leave-alone');
});

test('the type travels with the value', () => {
    assert.deepEqual(commissionPayload('15', 'amount'), {
        commissionType: 'amount',
        commissionValue: 15,
    });
});

test('an unknown type falls back to percentage rather than through', () => {
    assert.equal(commissionPayload('5', 'nonsense').commissionType, 'percentage');
    assert.equal(commissionPayload('5', '').commissionType, 'percentage');
});

test('decimals survive', () => {
    assert.equal(commissionPayload('12.5').commissionValue, 12.5);
});

/**
 * What the returned row says after a save.
 *
 * The dish is read before the rate is written, because the rate is keyed on the
 * dish id. Returning that row unchanged would claim no rate on the very save
 * that set one, and the form would reopen blank.
 */
const withAppliedRate = (row, applied) =>
    applied === undefined
        ? row
        : { ...row, commissionRule: applied === null ? null : { ...applied } };

test('a freshly set rate comes back on the saved dish', () => {
    const row = { id: 'f1', commissionRule: null };
    const out = withAppliedRate(row, { commissionType: 'percentage', commissionValue: 12, status: true });
    assert.equal(out.commissionRule.commissionValue, 12);
});

test('a cleared rate comes back as null, not as the stale one', () => {
    const row = { id: 'f1', commissionRule: { commissionType: 'percentage', commissionValue: 12 } };
    assert.equal(withAppliedRate(row, null).commissionRule, null);
});

test('an untouched rate is left exactly as the row had it', () => {
    const rule = { commissionType: 'amount', commissionValue: 5 };
    const row = { id: 'f1', commissionRule: rule };
    assert.equal(withAppliedRate(row, undefined).commissionRule, rule);
});
