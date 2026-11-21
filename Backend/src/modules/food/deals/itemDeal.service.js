import { prisma } from '../../../config/prisma.js';
import { NotFoundError, ValidationError } from '../../../core/auth/errors.js';
import { isId } from '../../../utils/helpers.js';
import { applyAppPricing } from '../pricing/priceRules.service.js';

/**
 * A restaurant's offers on chosen dishes, applied without a code.
 *
 * - flash: the dish costs less until the deal ends (e.g. biryani at 50% off
 *   for the next 2 hours, to sell out what was cooked in bulk).
 * - bogo: every second unit of the same dish is free.
 *
 * Both lower the restaurant's own price, so the restaurant funds them, and a
 * dish under a live deal is not eligible for coupons.
 */

export const DEAL_KINDS = ['flash', 'bogo'];
const MAX_FLASH_HOURS = 72;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v == null ? 0 : Number(v) || 0);

export const isDealLive = (deal, at = new Date()) =>
    deal?.status === 'active' &&
    (!deal.startAt || new Date(deal.startAt) <= at) &&
    (!deal.endAt || new Date(deal.endAt) > at);

export const dealLabel = (deal) => {
    if (deal?.kind === 'bogo') return 'Buy 1 Get 1 Free';
    const v = num(deal?.discountValue);
    return deal?.discountType === 'flat_price' ? `₹${v} OFF` : `${v}% OFF`;
};

/** The flash price of a unit that costs `price`. */
export const flashPrice = (price, deal) => {
    const p = num(price);
    const v = num(deal?.discountValue);
    const cut = deal?.discountType === 'flat_price' ? v : (p * v) / 100;
    return round2(Math.max(0, p - cut));
};

/** Live deals for these restaurants, by dish: { flash, bogo }. */
export async function liveDealsByItem(restaurantIds, at = new Date()) {
    const ids = [...new Set((restaurantIds || []).map(String).filter(isId))];
    const byItem = new Map();
    if (!ids.length) return byItem;
    const deals = await prisma.foodItemDeal.findMany({
        where: {
            restaurantId: { in: ids },
            status: 'active',
            OR: [{ startAt: null }, { startAt: { lte: at } }],
            AND: [{ OR: [{ endAt: null }, { endAt: { gt: at } }] }],
        },
        orderBy: { createdAt: 'desc' },
    });
    for (const deal of deals) {
        for (const itemId of deal.itemIds || []) {
            const entry = byItem.get(itemId) || {};
            if (deal.kind === 'bogo') entry.bogo ??= deal;
            // Two flash deals on one dish: the customer gets the better one.
            else if (!entry.flash || flashPrice(100, deal) < flashPrice(100, entry.flash)) entry.flash = deal;
            byItem.set(itemId, entry);
        }
    }
    return byItem;
}

/**
 * Dishes with their live deals applied, at the restaurant's own prices:
 * a flash deal lowers `price` (and every variant's) and keeps the old price
 * as `otherPrice` for the strikethrough; each dish gets `deal` (for the badge
 * and countdown) and `couponEligible`.
 */
export async function applyItemDeals(foods, { at = new Date(), byItem } = {}) {
    if (!Array.isArray(foods) || !foods.length) return foods;
    const map = byItem || (await liveDealsByItem(foods.map((f) => f?.restaurantId), at));
    return foods.map((food) => {
        const own = food?.couponEligible !== false;
        const deals = map.get(String(food?.id ?? food?._id ?? ''));
        if (!deals) return { ...food, deal: null, couponEligible: own };
        let out = { ...food, couponEligible: false };
        const flash = deals.flash;
        if (flash) {
            const cut = (p, other) => ({
                price: flashPrice(p, flash),
                otherPrice: Math.max(num(other), num(p)),
            });
            out = { ...out, ...cut(food.price, food.otherPrice) };
            if (Array.isArray(food.variants)) {
                out.variants = food.variants.map((v) => ({ ...v, ...cut(v.price, v.otherPrice) }));
            }
        }
        const primary = flash || deals.bogo;
        out.deal = {
            id: primary.id,
            kind: primary.kind,
            label: [flash && dealLabel(flash), deals.bogo && dealLabel(deals.bogo)].filter(Boolean).join(' · '),
            bogo: Boolean(deals.bogo),
            endsAt: primary.endAt || null,
        };
        return out;
    });
}

const serialize = (deal, at = new Date()) => ({
    ...deal,
    discountValue: deal.discountValue == null ? null : num(deal.discountValue),
    label: dealLabel(deal),
    live: isDealLive(deal, at),
    ended: Boolean(deal.endAt && new Date(deal.endAt) <= at),
});

export async function listDeals(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const rows = await prisma.foodItemDeal.findMany({
        where: { restaurantId: String(restaurantId) },
        orderBy: { createdAt: 'desc' },
        take: 200,
    });
    const now = new Date();
    return rows.map((d) => serialize(d, now));
}

/**
 * body: { kind, itemIds[], title?, discountType?, discountValue?,
 *         durationMinutes? | endAt?, startAt? }
 */
export async function createDeal(restaurantId, body = {}, createdByRole = 'RESTAURANT') {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    const kind = String(body.kind || '').toLowerCase();
    if (!DEAL_KINDS.includes(kind)) throw new ValidationError('Choose Flash deal or Buy 1 Get 1');

    const itemIds = [...new Set((body.itemIds || []).map(String).filter(isId))];
    if (!itemIds.length) throw new ValidationError('Select at least one dish');
    const owned = await prisma.foodItem.count({
        where: { id: { in: itemIds }, restaurantId: String(restaurantId) },
    });
    if (owned !== itemIds.length) throw new ValidationError('Some dishes do not belong to this restaurant');

    const now = new Date();
    const startAt = body.startAt ? new Date(body.startAt) : now;
    if (!Number.isFinite(startAt.getTime())) throw new ValidationError('Invalid start time');
    let endAt = null;
    if (body.durationMinutes != null && body.durationMinutes !== '') {
        const mins = Math.round(Number(body.durationMinutes));
        if (!Number.isFinite(mins) || mins < 15) throw new ValidationError('A deal runs for at least 15 minutes');
        endAt = new Date(startAt.getTime() + mins * 60000);
    } else if (body.endAt) {
        endAt = new Date(body.endAt);
    }
    if (endAt && (!Number.isFinite(endAt.getTime()) || endAt <= startAt)) {
        throw new ValidationError('The deal must end after it starts');
    }

    const data = {
        restaurantId: String(restaurantId),
        kind,
        title: String(body.title || '').trim().slice(0, 80),
        itemIds,
        startAt,
        endAt,
        createdByRole: createdByRole === 'ADMIN' ? 'ADMIN' : 'RESTAURANT',
    };
    if (kind === 'flash') {
        if (!endAt) throw new ValidationError('Choose how long the flash deal runs');
        if (endAt.getTime() - startAt.getTime() > MAX_FLASH_HOURS * 3600000) {
            throw new ValidationError(`A flash deal can run for at most ${MAX_FLASH_HOURS} hours`);
        }
        const type = body.discountType === 'flat_price' || body.discountType === 'flat-price' ? 'flat_price' : 'percentage';
        const value = Number(body.discountValue);
        if (!Number.isFinite(value) || value <= 0) throw new ValidationError('Enter the discount');
        if (type === 'percentage' && value > 90) throw new ValidationError('A flash discount can be at most 90%');
        data.discountType = type;
        data.discountValue = round2(value);
    }
    const row = await prisma.foodItemDeal.create({ data });
    return serialize(row);
}

/** Pause, resume or end ('inactive') a deal. */
export async function setDealStatus(dealId, status, { restaurantId } = {}) {
    if (!['active', 'paused', 'inactive'].includes(String(status))) throw new ValidationError('Invalid status');
    const where = { id: String(dealId), ...(restaurantId ? { restaurantId: String(restaurantId) } : {}) };
    const found = await prisma.foodItemDeal.findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundError('Deal not found');
    return serialize(await prisma.foodItemDeal.update({ where: { id: found.id }, data: { status } }));
}

export async function deleteDeal(dealId, { restaurantId } = {}) {
    const where = { id: String(dealId), ...(restaurantId ? { restaurantId: String(restaurantId) } : {}) };
    const { count } = await prisma.foodItemDeal.deleteMany({ where });
    if (!count) throw new NotFoundError('Deal not found');
    return { deleted: true };
}

/**
 * Every live flash deal, for the customer's "Flash Deals" page: grouped by
 * restaurant, each with its dishes at the deal price. `zoneId` limits it to
 * restaurants in the customer's zone.
 */
export async function listLiveFlashDeals({ zoneId } = {}) {
    const now = new Date();
    const deals = await prisma.foodItemDeal.findMany({
        where: {
            kind: 'flash',
            status: 'active',
            OR: [{ startAt: null }, { startAt: { lte: now } }],
            endAt: { gt: now },
            restaurant: {
                status: 'approved',
                ...(isId(zoneId) ? { zoneId: String(zoneId) } : {}),
            },
        },
        orderBy: { endAt: 'asc' },
        include: {
            restaurant: {
                select: { id: true, restaurantName: true, profileImage: true, coverImages: true, zoneId: true },
            },
        },
        take: 100,
    });
    if (!deals.length) return [];

    const itemIds = [...new Set(deals.flatMap((d) => d.itemIds))];
    const foods = await prisma.foodItem.findMany({
        where: { id: { in: itemIds }, approvalStatus: 'approved', isAvailable: true },
        include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
    });
    const priced = await applyAppPricing(await applyItemDeals(foods, { at: now }));
    const byId = new Map(priced.map((f) => [f.id, f]));

    return deals
        .map((deal) => {
            const items = deal.itemIds
                .map((id) => byId.get(id))
                .filter(Boolean)
                .map((f) => {
                    const variants = Array.isArray(f.variants) ? f.variants : [];
                    const price = variants.length ? Math.min(...variants.map((v) => num(v.price))) : num(f.price);
                    const original = variants.length ? Math.min(...variants.map((v) => num(v.otherPrice))) : num(f.otherPrice);
                    return {
                        id: f.id,
                        name: f.name,
                        image: f.image || '',
                        foodType: f.foodType || '',
                        price,
                        originalPrice: original > price ? original : null,
                        hasVariants: variants.length > 0,
                    };
                });
            const r = deal.restaurant || {};
            return {
                id: deal.id,
                title: deal.title,
                label: dealLabel(deal),
                endsAt: deal.endAt,
                restaurant: {
                    id: r.id,
                    name: r.restaurantName,
                    image: r.profileImage || r.coverImages?.[0] || '',
                },
                items,
            };
        })
        .filter((d) => d.items.length);
}
