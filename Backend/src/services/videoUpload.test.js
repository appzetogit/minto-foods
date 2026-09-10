import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * What may be uploaded as a restaurant video.
 *
 * Mirrors the checks in saveVideoFile. There is no transcoder on this server, so
 * the format has to be right on the way in -- a file stored in a container the
 * browser cannot open is a black rectangle nobody can diagnose, and it is not
 * recoverable after the fact without re-uploading.
 */

const ALLOWED = new Map([
    ['video/mp4', '.mp4'],
    ['video/webm', '.webm'],
]);
const MAX_VIDEO_BYTES = 12 * 1024 * 1024;

const check = (mimetype, size) => {
    const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
    const extension = ALLOWED.get(mime);
    if (!extension) throw new Error('Only MP4 and WebM videos are supported');
    if (size > MAX_VIDEO_BYTES) throw new Error('That video is larger than 12MB');
    return extension;
};

const rejects = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

test('mp4 and webm are accepted', () => {
    assert.equal(check('video/mp4', 1000), '.mp4');
    assert.equal(check('video/webm', 1000), '.webm');
});

test('a codec parameter does not defeat the check', () => {
    // Browsers send 'video/mp4; codecs="avc1.42E01E"'. Comparing the raw header
    // would reject a perfectly good file.
    assert.equal(check('video/mp4; codecs="avc1.42E01E"', 1000), '.mp4');
    assert.equal(check('VIDEO/MP4', 1000), '.mp4');
});

test('formats needing a transcode are refused, not stored', () => {
    // .mov straight off an iPhone is the common one. Storing it produces a file
    // that plays for whoever uploaded it and for nobody else.
    for (const mime of ['video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/3gpp']) {
        assert.ok(rejects(() => check(mime, 1000)), mime);
    }
});

test('a non-video is refused however it is labelled', () => {
    for (const mime of ['image/png', 'application/pdf', 'text/html', '', null, 'video/*']) {
        assert.ok(rejects(() => check(mime, 1000)), String(mime));
    }
});

test('the size cap is well under the general upload limit', () => {
    // Every upload is buffered in process memory, and the box has 2GB. The
    // general 25MB ceiling is too generous for something megabytes at a time.
    assert.ok(MAX_VIDEO_BYTES < 25 * 1024 * 1024);
    assert.ok(rejects(() => check('video/mp4', 25 * 1024 * 1024)));
    assert.equal(check('video/mp4', MAX_VIDEO_BYTES), '.mp4');
});

test('the extension comes from the type, not from the filename', () => {
    // A file called clip.mp4 is a claim. The browser will believe whatever
    // Content-Type it is served under, so that is what has to be checked.
    assert.equal(check('video/webm', 1000), '.webm');
});
