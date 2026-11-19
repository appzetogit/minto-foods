import test from 'node:test';
import assert from 'node:assert/strict';
import { relabelWebsocketUpgrade } from './socket.js';

test('an app websocket labelled polling is relabelled; everything else is left alone', () => {
    const app = { url: '/socket.io/?EIO=4&transport=polling' };
    relabelWebsocketUpgrade(app);
    assert.equal(app.url, '/socket.io/?EIO=4&transport=websocket');

    const middle = { url: '/socket.io/?transport=polling&EIO=4' };
    relabelWebsocketUpgrade(middle);
    assert.equal(middle.url, '/socket.io/?transport=websocket&EIO=4');

    const browser = { url: '/socket.io/?EIO=4&transport=websocket&sid=abc' };
    relabelWebsocketUpgrade(browser);
    assert.equal(browser.url, '/socket.io/?EIO=4&transport=websocket&sid=abc');

    const other = { url: '/api/v1/x?transport=polling' };
    relabelWebsocketUpgrade(other);
    assert.equal(other.url, '/api/v1/x?transport=polling');
});
