/**
 * The admin's order limits, checked on the server whatever the app offered:
 * the most of one dish in an order, and the order total above which cash on
 * delivery is refused. Both live in fee settings.
 */

export const DEFAULT_MAX_ITEM_QUANTITY = 50;
export const DEFAULT_COD_MAX_ORDER_VALUE = 2000;

/** Most of one dish; a missing or broken setting falls back to 50. */
export const maxItemQuantityOf = (fee) => {
    const n = Number(fee?.maxItemQuantity);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ITEM_QUANTITY;
};

/** COD cut-off: null when there is no limit (set to 0), ₹2000 when unset. */
export const codMaxOrderValueOf = (fee) => {
    const raw = fee?.codMaxOrderValue;
    if (raw === null || raw === undefined || raw === '') return DEFAULT_COD_MAX_ORDER_VALUE;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_COD_MAX_ORDER_VALUE;
    return n > 0 ? n : null;
};

/** The message for the first line over the quantity cap, or null. */
export function quantityLimitError(items = [], fee) {
    const max = maxItemQuantityOf(fee);
    const over = (items || []).find((item) => Number(item?.quantity) > max);
    return over ? `You can order at most ${max} of one item` : null;
}

/** The message when cash is not allowed for this total, or null. */
export function codLimitError(paymentMethod, total, fee) {
    if (paymentMethod !== 'cash' && paymentMethod !== 'cod') return null;
    const limit = codMaxOrderValueOf(fee);
    if (limit === null || !(Number(total) >= limit)) return null;
    return `Cash on Delivery is available only for orders below ₹${limit}`;
}
