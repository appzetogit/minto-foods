import test from 'node:test';
import assert from 'node:assert/strict';

process.env.UPLOAD_S3_BUCKET ||= 'minto-media';
process.env.UPLOAD_S3_REGION ||= 'ap-south-1';

const { stripIncomingSignatures } = await import('./stripIncomingSignatures.js');

/**
 * A signed url that reaches the database serves a dead image an hour later and
 * nothing repairs it, so what this middleware lets through matters more than
 * what it catches.
 */

const BARE = 'https://minto-media.s3.ap-south-1.amazonaws.com/food/categories/1789460000-a1.webp';
const SIGNED = `${BARE}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=deadbeef`;

const run = (body) => {
    const req = { body };
    let called = false;
    stripIncomingSignatures(req, {}, () => { called = true; });
    assert.equal(called, true, 'must always call next');
    return req.body;
};

test('a signed url of ours is stored bare', () => {
    assert.equal(run({ image: SIGNED }).image, BARE);
});

test('an unsigned url is left exactly as it was', () => {
    assert.equal(run({ image: BARE }).image, BARE);
});

test('it reaches urls nested in arrays and objects', () => {
    const body = { menu: { items: [{ image: SIGNED }, { image: SIGNED }] }, images: [SIGNED] };
    const out = run(body);
    assert.equal(out.menu.items[0].image, BARE);
    assert.equal(out.menu.items[1].image, BARE);
    assert.equal(out.images[0], BARE);
});

test("someone else's signed url is not touched", () => {
    // Stripping the query off a third party's url breaks a contract we did not
    // write. Only our bucket is ours to rewrite.
    const foreign = 'https://other-bucket.s3.ap-south-1.amazonaws.com/x.png?X-Amz-Signature=abc';
    assert.equal(run({ image: foreign }).image, foreign);
});

test('ordinary fields survive untouched', () => {
    const body = { name: 'Dosa', price: 120, isActive: true, note: null, tags: ['veg'] };
    assert.deepEqual(run(body), body);
});

test('a body that is not an object, or absent, is not an error', () => {
    for (const body of [undefined, null, 'raw string', 42]) {
        const req = { body };
        let called = false;
        stripIncomingSignatures(req, {}, () => { called = true; });
        assert.equal(called, true);
        assert.equal(req.body, body);
    }
});

test('a cyclic body does not hang the request', () => {
    const body = { image: SIGNED };
    body.self = body;
    assert.equal(run(body).image, BARE);
});
