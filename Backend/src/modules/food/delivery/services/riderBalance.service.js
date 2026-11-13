import { prisma } from '../../../../config/prisma.js';

/**
 * What each rider has earned, been paid and can still withdraw -- one way,
 * for the rider app, the admin wallet list and withdrawal requests alike.
 *
 * It used to be three formulas, and the rider app's one took the larger of the
 * order totals and the wallet ledger's lifetime counter. That counter adds
 * every credit, bonuses included, so once it won, each bonus and earning
 * add-on was counted twice; the next withdrawal then posted the gap to the
 * ledger as an "earnings sync" credit, which made it bigger still.
 *
 * Every figure comes from its own record, once:
 *   earned      delivered trips (tips included) + pay for cancelled orders
 *   bonus       admin bonuses and earning add-ons (DeliveryBonusTransaction)
 *   adjustments manual admin changes (ledger 'adjustment' rows with no key)
 *   paidOut     approved withdrawals + balance-sheet payouts
 *   pending     withdrawal requests waiting for an admin
 *   available   earned + bonus + adjustments - paidOut - pending
 *
 * @param {string[]} riderIds
 * @param {import('@prisma/client').Prisma.TransactionClient} [client]
 * @returns {Promise<Map<string, ReturnType<typeof emptyBalance>>>}
 */
export async function riderBalances(riderIds, client = prisma) {
    const ids = [...new Set((riderIds || []).map(String).filter(Boolean))];
    const out = new Map(ids.map((id) => [id, emptyBalance()]));
    if (!ids.length) return out;

    const rows = await client.$queryRaw`
        WITH r AS (SELECT unnest(${ids}::text[]) AS id)
        SELECT r.id,
          COALESCE((SELECT SUM(o."riderEarning") FROM food_orders o
                    WHERE o."dispatchDeliveryPartnerId" = r.id AND o."orderStatus"::text = 'delivered'), 0)::float8 AS "deliveryEarned",
          COALESCE((SELECT COUNT(*) FROM food_orders o
                    WHERE o."dispatchDeliveryPartnerId" = r.id AND o."orderStatus"::text = 'delivered'), 0)::int AS "deliveries",
          COALESCE((SELECT SUM(o."riderCancelPay") FROM food_orders o
                    WHERE o."dispatchDeliveryPartnerId" = r.id AND o."orderStatus"::text LIKE 'cancelled%'
                      AND o."riderCancelPay" > 0), 0)::float8 AS "cancelPay",
          COALESCE((SELECT SUM(b.amount) FROM food_delivery_bonus_transactions b
                    WHERE b."deliveryPartnerId" = r.id), 0)::float8 AS "bonus",
          COALESCE((SELECT SUM(CASE WHEN t.type::text = 'credit' THEN t.amount ELSE -t.amount END) FROM transactions t
                    WHERE t."entityType"::text = 'deliveryBoy' AND t."entityId" = r.id
                      AND t.category::text = 'adjustment' AND t."idempotencyKey" IS NULL
                      AND t.status::text = 'completed'), 0)::float8 AS "adjustments",
          COALESCE((SELECT SUM(w.amount) FROM food_delivery_withdrawals w
                    WHERE w."deliveryPartnerId" = r.id AND w.status::text = 'approved'), 0)::float8 AS "withdrawn",
          COALESCE((SELECT SUM(w.amount) FROM food_delivery_withdrawals w
                    WHERE w."deliveryPartnerId" = r.id AND w.status::text = 'pending'), 0)::float8 AS "pending",
          COALESCE((SELECT SUM(s.amount) FROM settlements s
                    WHERE s."entityType"::text = 'deliveryBoy' AND s."entityId" = r.id
                      AND s.status::text = 'processed'), 0)::float8 AS "settled"
        FROM r
    `;

    for (const row of rows) {
        const b = out.get(String(row.id));
        if (!b) continue;
        b.deliveryEarned = money(row.deliveryEarned);
        b.cancelPay = money(row.cancelPay);
        b.earned = money(b.deliveryEarned + b.cancelPay);
        b.deliveries = Number(row.deliveries) || 0;
        b.bonus = money(row.bonus);
        b.adjustments = money(row.adjustments);
        b.withdrawn = money(row.withdrawn);
        b.settled = money(row.settled);
        b.paidOut = money(b.withdrawn + b.settled);
        b.pending = money(row.pending);
        b.totalEarned = money(b.earned + b.bonus + b.adjustments);
        b.available = money(Math.max(0, b.totalEarned - b.paidOut - b.pending));
    }
    return out;
}

/** One rider's balance (see riderBalances). */
export async function riderBalance(riderId, client = prisma) {
    return (await riderBalances([riderId], client)).get(String(riderId)) || emptyBalance();
}

function emptyBalance() {
    return {
        deliveryEarned: 0,
        cancelPay: 0,
        earned: 0,
        deliveries: 0,
        bonus: 0,
        adjustments: 0,
        withdrawn: 0,
        settled: 0,
        paidOut: 0,
        pending: 0,
        totalEarned: 0,
        available: 0,
    };
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
