import test from 'node:test';
import assert from 'node:assert/strict';

// Set before the module loads: the bucket host list is read at call time, but
// keeping this first matches how the server is configured in production.
process.env.UPLOAD_S3_BUCKET = 'minto-media';
process.env.UPLOAD_S3_REGION = 'ap-south-1';

const { normalizeMediaUrlForStorage: normalize } = await import('./storage.service.js');

const KEY = 'https://minto-media.s3.ap-south-1.amazonaws.com/minto/restaurant/profile/1-a.webp';

test('drops the signature from one of our own signed urls', () => {
    const signed = `${KEY}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&X-Amz-Expires=3600`;
    assert.equal(normalize(signed), KEY);
});

test('leaves an already-bare url of ours alone', () => {
    assert.equal(normalize(KEY), KEY);
});

test('leaves a signed url from a bucket that is not ours alone', () => {
    const other = 'https://someone-else.s3.ap-south-1.amazonaws.com/x.webp?X-Amz-Signature=abc';
    assert.equal(normalize(other), other);
});

test('still strips localhost from an /uploads path', () => {
    assert.equal(normalize('http://localhost:5000/uploads/a/b.webp'), '/uploads/a/b.webp');
});

test('still fixes a single-slash protocol', () => {
    assert.equal(
        normalize('https:/minto-media.s3.ap-south-1.amazonaws.com/x.webp'),
        'https://minto-media.s3.ap-south-1.amazonaws.com/x.webp',
    );
});

test('keeps a non-signature query string (not ours to trim)', () => {
    assert.equal(normalize(`${KEY}?v=2`), `${KEY}?v=2`);
});
