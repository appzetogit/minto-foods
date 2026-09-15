import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Tips: the amounts a customer may choose, and what riders were actually given.
 *
 * The options live here and nowhere else. The app asks for them rather than
 * carrying its own list, so changing what customers are offered never needs an
 * app release.
 */

const MAX_PRESETS = 6;

const loadRow = async () =>
    (await prisma.foodBusinessSettings.findFirst()) ?? prisma.foodBusinessSettings.create({ data: {} });

const serializeSettings = (row) => ({
    tipsEnabled: row.tipsEnabled !== false,
    tipPresets: Array.isArray(row.tipPresets) ? row.tipPresets : [],
    tipMaxAmount: row.tipMaxAmount == null ? null : Number(row.tipMaxAmount),
});

export const getTipSettings = async () => serializeSettings(await loadRow());

/** What the apps are told: the options, and nothing about the platform. */
export const getPublicTipConfig = async () => {
    const settings = serializeSettings(await loadRow());
    return settings.tipsEnabled
        ? { tipsEnabled: true, presets: settings.tipPresets, maxAmount: settings.tipMaxAmount }
        : { tipsEnabled: false, presets: [], maxAmount: null };
};

export const updateTipSettings = async (body = {}) => {
    const data = {};

    if (body.tipsEnabled !== undefined) {
        data.tipsEnabled = body.tipsEnabled !== false && body.tipsEnabled !== 'false';
    }

    if (body.tipPresets !== undefined) {
        const raw = Array.isArray(body.tipPresets) ? body.tipPresets : [];
        const presets = [...new Set(raw.map((n) => Math.round(Number(n))))]
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => a - b);
        if (presets.length !== raw.length) {
            // Silently dropping a bad amount would leave an admin believing they
            // had offered it.
            throw new ValidationError('Tip amounts must be whole numbers above 0, with no repeats');
        }
        if (presets.length > MAX_PRESETS) {
            throw new ValidationError(`At most ${MAX_PRESETS} tip amounts`);
        }
        data.tipPresets = presets;
    }

    if (body.tipMaxAmount !== undefined) {
        const raw = body.tipMaxAmount;
        if (raw === null || String(raw).trim() === '') data.tipMaxAmount = null;
        else {
            const max = Number(raw);
            if (!Number.isFinite(max) || max <= 0) {
                throw new ValidationError('The maximum tip must be above 0, or left blank');
            }
            data.tipMaxAmount = max;
        }
    }

    const row = await loadRow();
    const saved = await prisma.foodBusinessSettings.update({ where: { id: row.id }, data });

    const settings = serializeSettings(saved);
    const ceiling = settings.tipMaxAmount;
    if (ceiling && settings.tipPresets.some((p) => p > ceiling)) {
        // Not refused, because the presets and the ceiling are saved together and
        // an admin may be mid-way through raising both. Reported so it is seen.
        return { ...settings, warning: 'Some tip amounts are above the maximum, so customers cannot choose them.' };
    }
    return settings;
};

/**
 * What riders were tipped.
 *
 * Read from the orders rather than a running total on the rider: an order is
 * the thing that can be refunded or corrected, so the orders are the truth.
 */
export const getTipReport = async ({ days = 30 } = {}) => {
    const since = new Date(Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000);

    const orders = await prisma.foodOrder.findMany({
        where: { tipAmount: { gt: 0 }, createdAt: { gte: since } },
        select: {
            orderId: true,
            tipAmount: true,
            createdAt: true,
            orderStatus: true,
            dispatchDeliveryPartnerId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
    });

    const partnerIds = [...new Set(orders.map((o) => o.dispatchDeliveryPartnerId).filter(Boolean))];
    const partners = partnerIds.length
        ? await prisma.foodDeliveryPartner.findMany({
            where: { id: { in: partnerIds } },
            select: { id: true, name: true, phone: true },
        })
        : [];
    const byId = new Map(partners.map((p) => [p.id, p]));

    const totals = new Map();
    for (const order of orders) {
        const key = order.dispatchDeliveryPartnerId || 'unassigned';
        const current = totals.get(key) || { riderId: key === 'unassigned' ? null : key, orders: 0, total: 0 };
        current.orders += 1;
        current.total += Number(order.tipAmount) || 0;
        totals.set(key, current);
    }

    const riders = [...totals.values()]
        .map((row) => ({
            ...row,
            total: Math.round(row.total * 100) / 100,
            name: row.riderId ? byId.get(row.riderId)?.name || 'Unknown rider' : 'Not yet assigned',
            phone: row.riderId ? byId.get(row.riderId)?.phone || '' : '',
        }))
        .sort((a, b) => b.total - a.total);

    return {
        days: Number(days) || 30,
        totalTipped: Math.round(orders.reduce((sum, o) => sum + (Number(o.tipAmount) || 0), 0) * 100) / 100,
        tippedOrders: orders.length,
        riders,
        recent: orders.slice(0, 25).map((o) => ({
            orderId: o.orderId,
            tipAmount: Number(o.tipAmount),
            orderStatus: o.orderStatus,
            createdAt: o.createdAt,
            riderName: o.dispatchDeliveryPartnerId
                ? byId.get(o.dispatchDeliveryPartnerId)?.name || 'Unknown rider'
                : 'Not yet assigned',
        })),
    };
};
