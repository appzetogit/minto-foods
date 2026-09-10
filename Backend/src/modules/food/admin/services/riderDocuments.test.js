import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the admin screens are shown of a rider's documents.
 *
 * Mirrors serializeDocuments in adminDeliveryPartner.service.js, which cannot be
 * imported without a database behind it. This decides what an admin sees when
 * deciding whether to approve someone, so an empty or wrong shape is not
 * cosmetic -- it is approving an application blind, which is what was happening.
 */
const serializeDocuments = (doc) => {
    const entry = (number, file) => {
        const n = String(number || '').trim();
        const d = String(file || '').trim();
        if (!n && !d) return undefined;
        return { ...(n ? { number: n } : {}), ...(d ? { document: d } : {}) };
    };

    const named = {
        aadhar: entry(doc.aadharNumber, doc.aadharPhoto),
        pan: entry(doc.panNumber, doc.panPhoto),
        drivingLicense: entry(doc.drivingLicenseNumber, doc.drivingLicensePhoto),
    };

    const custom =
        doc.customDocuments && typeof doc.customDocuments === 'object'
            ? Object.entries(doc.customDocuments)
                  .filter(([, url]) => String(url || '').trim())
                  .map(([key, url]) => ({ key, document: String(url) }))
            : [];

    const present = Object.fromEntries(
        Object.entries(named).filter(([, value]) => value !== undefined),
    );
    if (!Object.keys(present).length && !custom.length) return null;

    return { ...present, ...(custom.length ? { custom } : {}) };
};

test('a rider who submitted nothing gets null, not an empty object', () => {
    // The popup renders the section on truthiness. An empty object would draw a
    // "Documents" heading with nothing under it.
    assert.equal(serializeDocuments({}), null);
    assert.equal(serializeDocuments({ aadharNumber: '', aadharPhoto: '   ' }), null);
});

test('a document with only a number still shows', () => {
    // Numbers arrive at signup, photos often later. Waiting for both would hide
    // what the rider has already given.
    const out = serializeDocuments({ aadharNumber: '1234 5678 9012' });
    assert.deepEqual(out, { aadhar: { number: '1234 5678 9012' } });
});

test('a document with only a photo still shows', () => {
    const out = serializeDocuments({ panPhoto: 'https://s3/pan.webp' });
    assert.deepEqual(out, { pan: { document: 'https://s3/pan.webp' } });
});

test('documents the rider did not supply are absent, not empty', () => {
    // The UI guards each on truthiness, so an empty object would render a
    // heading for a document that does not exist.
    const out = serializeDocuments({ aadharNumber: 'A1' });
    assert.deepEqual(Object.keys(out), ['aadhar']);
    assert.equal(out.pan, undefined);
    assert.equal(out.drivingLicense, undefined);
});

test('all three come back under the keys the UI reads', () => {
    const out = serializeDocuments({
        aadharNumber: 'A1', aadharPhoto: 'a.webp',
        panNumber: 'P1', panPhoto: 'p.webp',
        drivingLicenseNumber: 'D1', drivingLicensePhoto: 'd.webp',
    });
    assert.deepEqual(out, {
        aadhar: { number: 'A1', document: 'a.webp' },
        pan: { number: 'P1', document: 'p.webp' },
        drivingLicense: { number: 'D1', document: 'd.webp' },
    });
});

test('no expiry is invented for the licence', () => {
    // The UI reads drivingLicense.expiryDate and nothing collects it. Guessing
    // one would be worse than the blank the UI already handles.
    const out = serializeDocuments({ drivingLicenseNumber: 'D1' });
    assert.equal('expiryDate' in out.drivingLicense, false);
});

test('custom uploads stay under their own key', () => {
    // A custom field named "pan" must not shadow the real PAN document.
    const out = serializeDocuments({
        panNumber: 'REAL',
        customDocuments: { pan: 'https://s3/custom.webp', policeVerification: 'https://s3/pv.webp' },
    });
    assert.deepEqual(out.pan, { number: 'REAL' });
    assert.deepEqual(out.custom, [
        { key: 'pan', document: 'https://s3/custom.webp' },
        { key: 'policeVerification', document: 'https://s3/pv.webp' },
    ]);
});

test('blank custom uploads are dropped', () => {
    const out = serializeDocuments({ customDocuments: { a: '', b: '   ' } });
    assert.equal(out, null);
});

test('a rider with only custom uploads still shows a section', () => {
    const out = serializeDocuments({ customDocuments: { policeVerification: 'pv.webp' } });
    assert.deepEqual(out, { custom: [{ key: 'policeVerification', document: 'pv.webp' }] });
});

test('customDocuments that is not an object does not throw', () => {
    // It is a Json column; a legacy row could hold anything.
    for (const bad of [null, 'x', 42, undefined]) {
        assert.doesNotThrow(() => serializeDocuments({ customDocuments: bad }));
    }
});
