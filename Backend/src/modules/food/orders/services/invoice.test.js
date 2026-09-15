import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInvoice, renderInvoiceHtml } from './invoice.service.js';

/**
 * The bill a customer keeps.
 *
 * The only thing that really matters here is that the lines add up to what was
 * charged. A bill that disagrees with the bank statement is worse than no bill,
 * so every case below checks the arithmetic as well as the wording.
 */

const order = (extra = {}) => ({
    id: '1a2b3c4d5e6f7a8b9c0d1e2f',
    order_id: 'FOD-1787303115',
    userId: 'user-1',
    currency: 'INR',
    orderStatus: 'delivered',
    createdAt: new Date('2026-09-14T10:00:00.000Z'),
    deliveredAt: new Date('2026-09-14T10:40:00.000Z'),
    subtotal: 400, discount: 0, couponCode: null, packagingFee: 0,
    tax: 20, deliveryFee: 45, deliveryFeeGst: 8.1, platformFee: 3,
    quickDeliveryFee: 0, tipAmount: 0, total: 476.1,
    paymentMethod: 'razorpay', paymentStatus: 'paid',
    refundStatus: null, refundAmount: 0,
    customerName: 'Tanu', customerPhone: '9301988718',
    addrStreet: '12 MG Road', addrCity: 'Indore', addrState: 'MP', addrZipCode: '452001',
    items: [{ name: 'Paneer Tikka', variantName: '', variantPrice: null, price: 200, quantity: 2, isVeg: true, addons: [] }],
    restaurant: { restaurantName: 'Rolex Hotel', city: 'Indore', gstNumber: '23ABCDE1234F1Z5', fssaiNumber: '12345678901234' },
    gstRate: 5,
    deliveryFeeGstRate: 18,
    ...extra,
});

const sumCharges = (inv) => Math.round(inv.charges.reduce((s, l) => s + l.amount, 0) * 100) / 100;
const labels = (inv) => inv.charges.map((l) => l.label);

test('the charge lines add up to exactly what was charged', () => {
    const inv = buildInvoice({ order: order() });
    assert.equal(sumCharges(inv), inv.total);
    assert.equal(inv.total, 476.1);
    assert.equal(inv.notes.reconciled, true);
});

test('rates label the tax lines, so a bill says GST (5%) not just a figure', () => {
    const inv = buildInvoice({ order: order() });
    assert.ok(labels(inv).includes('GST (5%)'));
    assert.ok(labels(inv).includes('GST on delivery (18%)'));
});

test('a zero charge is left off entirely', () => {
    // A bill listing "Packaging charge ₹0" invites a question that has no answer.
    const inv = buildInvoice({ order: order() });
    assert.ok(!labels(inv).some((l) => l.startsWith('Packaging')));
});

test('a discount is a credit, and names the coupon', () => {
    const inv = buildInvoice({ order: order({ discount: 50, couponCode: 'WELCOME50', total: 426.1 }) });
    const line = inv.charges.find((l) => l.label.startsWith('Discount'));
    assert.equal(line.label, 'Discount (WELCOME50)');
    assert.equal(line.amount, -50);
    assert.equal(sumCharges(inv), inv.total);
});

test('the express surcharge is named inside the platform fee, never added twice', () => {
    // platformFee already contains quickDeliveryFee; a separate line would bill
    // the customer for it a second time on paper.
    const inv = buildInvoice({ order: order({ platformFee: 18, quickDeliveryFee: 15, total: 491.1 }) });
    const platform = inv.charges.find((l) => l.label === 'Platform fee');
    assert.equal(platform.amount, 18);
    assert.match(platform.note, /15 express/);
    assert.ok(!labels(inv).some((l) => /express|quick/i.test(l)), 'no separate express line');
    assert.equal(sumCharges(inv), inv.total);
});

test('a tip given at checkout is a line on the bill', () => {
    const inv = buildInvoice({ order: order({ tipAmount: 20, total: 496.1 }) });
    const tip = inv.charges.find((l) => l.label.startsWith('Tip'));
    assert.equal(tip.amount, 20);
    assert.equal(sumCharges(inv), inv.total);
    assert.deepEqual(inv.paidSeparately, []);
});

test('a tip added after delivery is shown apart from the order total', () => {
    // It was charged to the wallet later and never went into order.total, so
    // putting it in the bill's total would overstate what the order cost.
    const inv = buildInvoice({ order: order({ tipAmount: 30, total: 476.1 }) });
    assert.equal(inv.total, 476.1);
    assert.equal(sumCharges(inv), 476.1);
    assert.equal(inv.paidSeparately.length, 1);
    assert.equal(inv.paidSeparately[0].amount, 30);
    assert.equal(inv.notes.tipTotal, 30);
});

test('a tip at checkout plus one after delivery are split correctly', () => {
    // 20 at checkout (inside total), then 30 more later: 50 on the order.
    const inv = buildInvoice({ order: order({ tipAmount: 50, total: 496.1 }) });
    assert.equal(inv.charges.find((l) => l.label.startsWith('Tip')).amount, 20);
    assert.equal(inv.paidSeparately[0].amount, 30);
    assert.equal(sumCharges(inv), inv.total);
});

test('item amounts include addons, and multiply by quantity', () => {
    const inv = buildInvoice({
        order: order({
            items: [{
                name: 'Burger', variantName: 'Large', variantPrice: 150, price: 120, quantity: 2, isVeg: false,
                addons: [{ name: 'Extra cheese', price: 30, quantity: 1 }],
            }],
        }),
    });
    const i = inv.items[0];
    // The variant price wins over the base price, and the addon rides per unit.
    assert.equal(i.unitPrice, 150);
    assert.equal(i.amount, 360);
    assert.equal(i.variant, 'Large');
    assert.equal(i.isVeg, false);
});

test('the supplier of the food is named, with its GSTIN and licence', () => {
    const inv = buildInvoice({ order: order() });
    assert.equal(inv.restaurant.name, 'Rolex Hotel');
    assert.equal(inv.restaurant.gstin, '23ABCDE1234F1Z5');
    assert.equal(inv.restaurant.fssaiNumber, '12345678901234');
});

test('a restaurant with no GSTIN prints none rather than an empty label', () => {
    const inv = buildInvoice({ order: order({ restaurant: { restaurantName: 'Small Kitchen' } }) });
    assert.equal(inv.restaurant.gstin, null);
    assert.ok(!renderInvoiceHtml(inv).includes('GSTIN'));
});

test('an unpaid order says so instead of implying it was paid', () => {
    const inv = buildInvoice({ order: order({ paymentMethod: 'cash', paymentStatus: 'pending', orderStatus: 'pending' }) });
    assert.equal(inv.payment.paid, false);
    assert.match(renderInvoiceHtml(inv), /payment pending/);
});

test('a bill that does not reconcile admits it', () => {
    // Guards against a future fee column being added to the order and silently
    // left off the bill: the flag is how that gets noticed.
    const inv = buildInvoice({ order: order({ total: 999 }) });
    assert.equal(inv.notes.reconciled, false);
});

test('the business name falls back rather than rendering an empty header', () => {
    assert.equal(buildInvoice({ order: order() }).platform.name, 'Minto Foods');
    assert.equal(buildInvoice({ order: order(), business: { companyName: 'Minto Pvt Ltd' } }).platform.name, 'Minto Pvt Ltd');
});

test('a name with html in it cannot break out into markup', () => {
    const inv = buildInvoice({
        order: order({ items: [{ name: '<script>alert(1)</script>', price: 10, quantity: 1, isVeg: true, addons: [] }] }),
    });
    const html = renderInvoiceHtml(inv);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('the rendered bill carries the numbers it was built from', () => {
    const html = renderInvoiceHtml(buildInvoice({ order: order({ discount: 50, couponCode: 'SAVE50', total: 426.1 }) }));
    assert.match(html, /INV-FOD-1787303115/);
    assert.match(html, /Rolex Hotel/);
    assert.match(html, /SAVE50/);
    assert.match(html, /-₹50\.00/);
    assert.match(html, /₹426\.10/);
});

test('an order with no items renders rather than throwing', () => {
    const inv = buildInvoice({ order: order({ items: [] }) });
    assert.deepEqual(inv.items, []);
    assert.ok(renderInvoiceHtml(inv).includes('Total'));
});
