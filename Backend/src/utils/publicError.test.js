import test from 'node:test';
import assert from 'node:assert/strict';

import { GENERIC_ERROR_MESSAGE, looksInternal, toPublicError } from './publicError.js';
import { guardErrorResponses } from '../middleware/guardErrorResponses.js';
import errorHandler from '../middleware/errorHandler.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../core/auth/errors.js';

/**
 * What reaches a client when something fails. The first case is the error the
 * rider app actually received.
 */

const RIDER_APP_LEAK = '\nInvalid `prisma.foodOrder.findMany()` invocation:\n\n{\n  where: {\n    dispatchDeliveryPartnerId: "df8749bc7116ad1176254a5b",\n    orderStatus: {\n      startsWith: "cancelled",\n      ~~~~~~~~~~\n?     equals?: OrderStatus';

test('the query error the rider app received is recognised as internal', () => {
    assert.equal(looksInternal(RIDER_APP_LEAK), true);
});

test('crash text and infrastructure errors are internal', () => {
    for (const m of [
        "Cannot read properties of undefined (reading 'id')",
        'order.items.map is not a function',
        'connect ECONNREFUSED 127.0.0.1:5432',
        'Unique constraint failed on the fields: (`couponCode`)',
        'Error: boom\n    at Object.handler (/var/www/Backend/src/x.js:12:9)',
        'duplicate key value violates unique constraint "food_offers_couponCode_key"',
        'Unexpected token < in JSON at position 0',
    ]) assert.equal(looksInternal(m), true, m);
});

test('messages written for people are left alone', () => {
    for (const m of [
        'Invalid coupon code',
        'Add ₹149 more to use this coupon',
        'Not your order',
        'That coupon code is already taken. Try another.',
        'tipAmount: Tip cannot be negative',
        'Session expired. Please log in again.',
        'Tipping is switched off',
        'Invalid endDate',
    ]) assert.equal(looksInternal(m), false, m);
});

test('errors raised on purpose keep their status and message', () => {
    assert.deepEqual(toPublicError(new ValidationError('Invalid coupon code')), { statusCode: 400, message: 'Invalid coupon code', internal: false });
    assert.equal(toPublicError(new NotFoundError('Order not found')).statusCode, 404);
    assert.equal(toPublicError(new ForbiddenError('Not your order')).message, 'Not your order');
});

test('an unexpected error becomes a 500 with a plain message', () => {
    const pub = toPublicError(new TypeError("Cannot read properties of undefined (reading 'id')"));
    assert.deepEqual(pub, { statusCode: 500, message: GENERIC_ERROR_MESSAGE, internal: true });
});

test('a Prisma error is withheld, with a plain meaning where it has one', () => {
    const validation = Object.assign(new Error(RIDER_APP_LEAK), { name: 'PrismaClientValidationError' });
    assert.deepEqual(toPublicError(validation), { statusCode: 500, message: GENERIC_ERROR_MESSAGE, internal: true });
    const duplicate = Object.assign(new Error('Unique constraint failed'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
    assert.equal(toPublicError(duplicate).statusCode, 409);
    const missing = Object.assign(new Error('Record to update not found.'), { name: 'PrismaClientKnownRequestError', code: 'P2025' });
    assert.equal(toPublicError(missing).statusCode, 404);
});

test('a 4xx that carries internal text is still withheld', () => {
    // Controllers that do `sendError(res, err.statusCode || 400, err.message)`.
    const labelled = Object.assign(new Error(RIDER_APP_LEAK), { statusCode: 400 });
    const pub = toPublicError(labelled);
    assert.equal(pub.message, GENERIC_ERROR_MESSAGE);
    assert.equal(pub.statusCode, 400);
});

// ---- the HTTP layer ---------------------------------------------------------

const fakeRes = () => {
    const res = { statusCode: 200, headers: {}, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
};
const fakeReq = { method: 'GET', originalUrl: '/api/v1/food/delivery/trip-history', requestId: 'req-123' };

test('the error handler sends the generic message and a reference, never the query', () => {
    const res = fakeRes();
    const err = Object.assign(new Error(RIDER_APP_LEAK), { name: 'PrismaClientValidationError' });
    errorHandler(err, fakeReq, res, () => {});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, GENERIC_ERROR_MESSAGE);
    assert.equal(res.body.requestId, 'req-123');
    assert.ok(!JSON.stringify(res.body).includes('prisma'));
    assert.ok(!JSON.stringify(res.body).includes('df8749bc'));
});

test('the error handler passes a validation message through unchanged', () => {
    const res = fakeRes();
    errorHandler(new ValidationError('Invalid coupon code'), fakeReq, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'Invalid coupon code');
    assert.equal(res.body.requestId, undefined, 'no reference needed for an ordinary refusal');
});

test('the guard catches a controller that sends err.message itself', () => {
    const res = fakeRes();
    guardErrorResponses(fakeReq, res, () => {});
    res.status(400).json({ success: false, message: RIDER_APP_LEAK });
    assert.equal(res.body.message, GENERIC_ERROR_MESSAGE);
    assert.equal(res.body.requestId, 'req-123');
    assert.equal(res.statusCode, 400);
});

test('the guard leaves successful and friendly responses untouched', () => {
    const ok = fakeRes();
    guardErrorResponses(fakeReq, ok, () => {});
    const body = { success: true, data: { note: 'prisma is a word in this payload' } };
    ok.json(body);
    assert.equal(ok.body, body, 'success bodies are not inspected');

    const refused = fakeRes();
    guardErrorResponses(fakeReq, refused, () => {});
    refused.status(400).json({ success: false, message: 'Add ₹149 more to use this coupon' });
    assert.equal(refused.body.message, 'Add ₹149 more to use this coupon');
});
