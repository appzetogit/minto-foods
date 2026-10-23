/**
 * Order for every customer list: restaurants that can take an order now come
 * before closed or switched-off ones, never mixed. Reads isOpenNow as set by
 * withOpenStatus; ties fall through to the list's own order.
 */
export const openFirst = (a, b) => Number(Boolean(b?.isOpenNow)) - Number(Boolean(a?.isOpenNow));
