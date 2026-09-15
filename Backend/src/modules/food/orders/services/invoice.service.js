import { prisma } from '../../../../config/prisma.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../../../core/auth/errors.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The bill for an order, as the customer is entitled to see it.
 *
 * Two things about how an order is priced make this less obvious than adding up
 * columns, and getting either wrong prints a document that disagrees with the
 * customer's bank statement:
 *
 * 1. In `quick` mode the express surcharge is added INTO platformFee and also
 *    stored in quickDeliveryFee. Showing both as lines would charge it twice on
 *    paper, so the surcharge is named inside the platform-fee line instead.
 *
 * 2. A tip left after delivery increments order.tipAmount but not order.total --
 *    it is taken from the wallet later, as its own payment. So the tip that
 *    belongs in this order's total is whatever was there at checkout, and the
 *    rest is shown apart, under what was paid separately.
 *
 * Everything is derived from the stored order rather than recomputed from
 * settings: fees and GST rates change, and a bill reissued next year must still
 * say what was actually charged.
 */

const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const text = (v) => (v == null ? '' : String(v));

/** Charges that make up what the customer paid for the order itself. */
const chargeLines = (o) => {
    const lines = [];
    const push = (label, amount, extra = {}) => {
        if (money(amount) !== 0) lines.push({ label, amount: money(amount), ...extra });
    };

    push('Item total', o.subtotal);

    if (money(o.discount) > 0) {
        const code = text(o.couponCode).trim();
        push(code ? `Discount (${code})` : 'Discount', -money(o.discount));
    }

    push('Packaging charge', o.packagingFee);

    const gstRate = Number(o.gstRate);
    push(Number.isFinite(gstRate) && gstRate > 0 ? `GST (${gstRate}%)` : 'GST', o.tax);

    push('Delivery fee', o.deliveryFee);

    const dGst = Number(o.deliveryFeeGstRate);
    push(Number.isFinite(dGst) && dGst > 0 ? `GST on delivery (${dGst}%)` : 'GST on delivery', o.deliveryFeeGst);

    // The express surcharge lives inside platformFee; naming it here is the only
    // honest way to show it without adding it to the bill a second time.
    const quick = money(o.quickDeliveryFee);
    push('Platform fee', o.platformFee, quick > 0 ? { note: `includes ₹${quick} express delivery charge` } : {});

    return lines;
};

export const buildInvoice = ({ order, business = null } = {}) => {
    if (!order) throw new NotFoundError('Order not found');

    const lines = chargeLines(order);
    const orderTotal = money(order.total);

    // What the charge lines come to before any tip.
    const beforeTip = money(lines.reduce((sum, l) => sum + l.amount, 0));

    // The tip inside this order's total is whatever the charges do not explain --
    // but never more than the tip actually recorded on the order. Without that
    // ceiling any unexplained gap would be printed as a tip, so a fee column
    // added later and left off this bill would tell the customer they tipped a
    // few hundred rupees. Clamped, the gap stays visible as a failure to
    // reconcile, which is what it is.
    const tipTotal = money(order.tipAmount);
    const unexplained = Math.max(0, money(orderTotal - beforeTip));
    const tipOnOrder = Math.min(tipTotal, unexplained);
    const tipAfterDelivery = Math.max(0, money(tipTotal - tipOnOrder));

    if (tipOnOrder > 0) {
        lines.push({ label: 'Tip for delivery partner', amount: tipOnOrder, note: 'paid in full to the rider' });
    }

    const items = (order.items || []).map((it) => {
        const unit = money(it.variantPrice ?? it.price);
        const qty = Number(it.quantity) || 0;
        const addons = Array.isArray(it.addons) ? it.addons : [];
        const addonTotal = money(
            addons.reduce((s, a) => s + (Number(a?.price) || 0) * (Number(a?.quantity) || 1), 0),
        );
        return {
            name: text(it.name),
            variant: text(it.variantName),
            isVeg: it.isVeg === true,
            quantity: qty,
            unitPrice: unit,
            addons: addons.map((a) => ({ name: text(a?.name), price: money(a?.price) })),
            amount: money(unit * qty + addonTotal * qty),
        };
    });

    const r = order.restaurant || {};
    const addr = [order.addrStreet, order.addrAdditionalDetails, order.addrCity, order.addrState, order.addrZipCode]
        .map(text).map((s) => s.trim()).filter(Boolean).join(', ');

    return {
        // Not a new sequence: the order id already identifies the sale uniquely,
        // and a second counter would be one more thing to keep in step.
        invoiceNumber: `INV-${text(order.order_id || order.id)}`,
        orderId: text(order.order_id || order.id),
        issuedAt: (order.deliveredAt || order.createdAt || new Date()).toISOString(),
        placedAt: (order.createdAt || new Date()).toISOString(),
        currency: text(order.currency) || 'INR',
        orderStatus: text(order.orderStatus),

        // Who sold the food. The GSTIN and FSSAI number belong on the bill: the
        // licence is required to be displayed and the GSTIN is the supplier's.
        restaurant: {
            name: text(r.restaurantName),
            address: [r.addressLine1, r.addressLine2, r.area, r.city, r.state, r.pincode]
                .map(text).map((s) => s.trim()).filter(Boolean).join(', '),
            gstin: text(r.gstNumber) || null,
            fssaiNumber: text(r.fssaiNumber) || null,
        },

        // Who sold the delivery.
        platform: {
            name: text(business?.companyName) || 'Minto Foods',
            address: [business?.address, business?.state, business?.pincode]
                .map(text).map((s) => s.trim()).filter(Boolean).join(', '),
            email: text(business?.email) || null,
            phone: [business?.phoneCountryCode, business?.phoneNumber].map(text).filter(Boolean).join(' ') || null,
        },

        customer: {
            name: text(order.customerName || order.addrName || order.addrFullName),
            phone: text(order.addrPhone || order.customerPhone),
            address: addr,
        },

        items,
        charges: lines,
        total: orderTotal,

        payment: {
            method: text(order.paymentMethod),
            status: text(order.paymentStatus),
            paid: text(order.paymentStatus).toLowerCase() === 'paid',
            refundStatus: text(order.refundStatus) || null,
            refundAmount: money(order.refundAmount) || 0,
        },

        // Money on this order that was not part of its total.
        paidSeparately: tipAfterDelivery > 0
            ? [{ label: 'Tip added after delivery', amount: tipAfterDelivery, note: 'charged to wallet' }]
            : [],

        notes: {
            tipTotal,
            // A bill that does not add up should say so rather than look tidy.
            reconciled: money(beforeTip + tipOnOrder) === orderTotal,
        },
    };
};

const ORDER_SELECT = {
    id: true, order_id: true, userId: true, currency: true, orderStatus: true,
    createdAt: true, deliveredAt: true,
    subtotal: true, discount: true, couponCode: true, packagingFee: true,
    tax: true, deliveryFee: true, deliveryFeeGst: true, platformFee: true,
    quickDeliveryFee: true, tipAmount: true, total: true,
    paymentMethod: true, paymentStatus: true, refundStatus: true, refundAmount: true,
    customerName: true, customerPhone: true,
    addrName: true, addrFullName: true, addrPhone: true, addrStreet: true,
    addrAdditionalDetails: true, addrCity: true, addrState: true, addrZipCode: true,
    items: {
        select: {
            name: true, variantName: true, variantPrice: true, price: true,
            quantity: true, isVeg: true, addons: true,
        },
    },
    restaurant: {
        select: {
            restaurantName: true, addressLine1: true, addressLine2: true, area: true,
            city: true, state: true, pincode: true, gstNumber: true, fssaiNumber: true,
        },
    },
};

/**
 * The invoice for one order, for the customer who placed it.
 *
 * The GST rates are not stored on the order, so they come from fee settings.
 * They only ever label a line ("GST (5%)"); every rupee figure is the one the
 * customer was charged, so a rate changed since then cannot alter the bill.
 */
export async function getOrderInvoice({ orderId, userId } = {}) {
    if (!isId(orderId)) throw new ValidationError('Order id required');

    const order = await prisma.foodOrder.findFirst({ where: { id: String(orderId) }, select: ORDER_SELECT });
    if (!order) throw new NotFoundError('Order not found');
    if (!userId || order.userId !== String(userId)) throw new ForbiddenError('Not your order');

    const [business, fees] = await Promise.all([
        prisma.foodBusinessSettings.findFirst({
            select: {
                companyName: true, address: true, state: true, pincode: true,
                email: true, phoneCountryCode: true, phoneNumber: true,
            },
        }).catch(() => null),
        prisma.foodFeeSettings.findFirst({
            where: { isActive: true }, select: { gstRate: true, deliveryFeeGstRate: true },
        }).catch(() => null),
    ]);

    return buildInvoice({
        order: { ...order, gstRate: fees?.gstRate, deliveryFeeGstRate: fees?.deliveryFeeGstRate },
        business,
    });
}

const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const rupees = (n) => `₹${Number(n).toFixed(2)}`;

/**
 * A printable bill.
 *
 * Served as HTML rather than a PDF on purpose: a PDF would mean running Chrome
 * on a 2 GB box for every tap of "download bill". The phone already prints and
 * shares a web page as a PDF, and the web view prints from the browser.
 */
export const renderInvoiceHtml = (inv) => {
    const charge = (l) => `<tr${l.amount < 0 ? ' class="credit"' : ''}>
      <td>${esc(l.label)}${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</td>
      <td class="amt">${l.amount < 0 ? '-' : ''}${rupees(Math.abs(l.amount))}</td></tr>`;

    const item = (i) => `<tr>
      <td><span class="dot ${i.isVeg ? 'veg' : 'nonveg'}"></span>${esc(i.name)}${
    i.variant ? `<span class="note">${esc(i.variant)}</span>` : ''}${
    i.addons.length ? `<span class="note">+ ${i.addons.map((a) => esc(a.name)).join(', ')}</span>` : ''}</td>
      <td class="qty">${i.quantity}</td>
      <td class="amt">${rupees(i.amount)}</td></tr>`;

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bill ${esc(inv.invoiceNumber)}</title><style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff}
  .sheet{max-width:640px;margin:0 auto}
  h1{font-size:18px;margin:0 0 2px}
  .muted{color:#666;font-size:12px}
  .head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:16px}
  .parties{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px}
  .parties>div{flex:1 1 200px}
  .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin-bottom:3px}
  table{width:100%;border-collapse:collapse;margin-bottom:18px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;border-bottom:1px solid #ddd;padding:6px 0}
  td{padding:7px 0;border-bottom:1px solid #f0f0f0;vertical-align:top}
  .amt{text-align:right;white-space:nowrap}
  .qty{text-align:center;width:44px}
  th.amt{text-align:right}
  .note{display:block;font-size:12px;color:#777}
  .credit td{color:#0a7a34}
  .total{display:flex;justify-content:space-between;font-size:17px;font-weight:600;border-top:2px solid #1a1a1a;padding-top:12px}
  .dot{display:inline-block;width:9px;height:9px;border:1.5px solid;margin-right:7px;vertical-align:1px}
  .dot.veg{border-color:#0a7a34}.dot.veg::after{content:"";display:block;width:3px;height:3px;border-radius:50%;background:#0a7a34;margin:1.5px auto}
  .dot.nonveg{border-color:#b3261e}.dot.nonveg::after{content:"";display:block;width:3px;height:3px;border-radius:50%;background:#b3261e;margin:1.5px auto}
  .after{margin-top:14px;padding-top:12px;border-top:1px dashed #ccc}
  .foot{margin-top:22px;font-size:11px;color:#888;text-align:center}
  @media print{body{padding:0}.sheet{max-width:none}}
</style></head><body><div class="sheet">
  <div class="head">
    <div><h1>${esc(inv.platform.name)}</h1><div class="muted">${esc(inv.platform.address)}</div></div>
    <div style="text-align:right"><div class="label">Bill</div><strong>${esc(inv.invoiceNumber)}</strong>
      <div class="muted">${esc(new Date(inv.issuedAt).toLocaleString('en-IN'))}</div></div>
  </div>
  <div class="parties">
    <div><div class="label">From</div><strong>${esc(inv.restaurant.name)}</strong>
      <div class="muted">${esc(inv.restaurant.address)}</div>
      ${inv.restaurant.gstin ? `<div class="muted">GSTIN ${esc(inv.restaurant.gstin)}</div>` : ''}
      ${inv.restaurant.fssaiNumber ? `<div class="muted">FSSAI ${esc(inv.restaurant.fssaiNumber)}</div>` : ''}</div>
    <div><div class="label">To</div><strong>${esc(inv.customer.name)}</strong>
      <div class="muted">${esc(inv.customer.phone)}</div>
      <div class="muted">${esc(inv.customer.address)}</div></div>
  </div>
  <table><thead><tr><th>Item</th><th class="qty">Qty</th><th class="amt">Amount</th></tr></thead>
    <tbody>${inv.items.map(item).join('')}</tbody></table>
  <table><tbody>${inv.charges.map(charge).join('')}</tbody></table>
  <div class="total"><span>Total</span><span>${rupees(inv.total)}</span></div>
  <div class="muted" style="margin-top:6px">Paid by ${esc(inv.payment.method)}${inv.payment.paid ? '' : ' — payment pending'}</div>
  ${inv.paidSeparately.length ? `<div class="after">${inv.paidSeparately.map(
      (p) => `<div style="display:flex;justify-content:space-between"><span>${esc(p.label)}<span class="note">${esc(p.note)}</span></span><span>${rupees(p.amount)}</span></div>`,
  ).join('')}</div>` : ''}
  <div class="foot">This is a computer-generated bill and does not require a signature.</div>
</div></body></html>`;
};
