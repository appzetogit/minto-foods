import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../core/auth/errors.js';
import {
    PERCENT_MIN,
    PERCENT_MAX,
    clearPriceCaches,
    isRuleLive,
    resolveRule,
    ruleMatches,
    toAppPrice,
} from './priceRules.service.js';

/**
 * Admin side of price rules: create, edit, switch on/off, delete, and a
 * preview of exactly which dishes a rule would change before it is saved.
 * Every write is logged and clears the price caches so customers see the new
 * prices straight away.
 */

const SCOPES = ['all', 'zone', 'restaurant', 'category', 'item'];
const ROUNDINGS = ['none', 'nearest_1', 'end_9'];
const MAX_TARGETS = 5000;

const num = (v) => Number(v) || 0;
const ids = (list) =>
    [...new Set((Array.isArray(list) ? list : []).map((v) => String(v || '').trim()).filter(isId))];

const shape = (r) =>
    r && {
        id: r.id,
        name: r.name,
        scope: r.scope,
        zoneId: r.zoneId || null,
        restaurantIds: r.restaurantIds || [],
        categoryIds: r.categoryIds || [],
        itemIds: r.itemIds || [],
        percent: num(r.percent),
        rounding: r.rounding,
        applyToAddons: Boolean(r.applyToAddons),
        isActive: Boolean(r.isActive),
        isLive: isRuleLive({ ...r, deletedAt: null }),
        startsAt: r.startsAt || null,
        endsAt: r.endsAt || null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };

const parseDate = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date`);
    return d;
};

/** Checks a create/edit body and returns the row data to save. */
async function validateRule(body = {}, { partial = false, existing = null } = {}) {
    const merged = { ...(existing || {}), ...body };

    const name = String(merged.name ?? '').trim();
    if (!name) throw new ValidationError('Give the rule a name');
    if (name.length > 120) throw new ValidationError('Name is too long (120 characters max)');

    const scope = String(merged.scope || '');
    if (!SCOPES.includes(scope)) throw new ValidationError('Choose what the rule applies to');

    const percent = Number(merged.percent);
    if (!Number.isFinite(percent)) throw new ValidationError('Enter a percentage');
    if (percent < PERCENT_MIN || percent > PERCENT_MAX) {
        throw new ValidationError(`Percentage must be between ${PERCENT_MIN}% and +${PERCENT_MAX}%`);
    }
    const percentRounded = Math.round(percent * 100) / 100;

    const rounding = String(merged.rounding || 'nearest_1');
    if (!ROUNDINGS.includes(rounding)) throw new ValidationError('Unknown rounding option');

    const zoneId = merged.zoneId ? String(merged.zoneId).trim() : null;
    if (zoneId && !isId(zoneId)) throw new ValidationError('Invalid zone');
    if (scope === 'zone' && !zoneId) throw new ValidationError('Choose the zone');

    const restaurantIds = scope === 'restaurant' ? ids(merged.restaurantIds) : [];
    const categoryIds = scope === 'category' ? ids(merged.categoryIds) : [];
    const itemIds = scope === 'item' ? ids(merged.itemIds) : [];
    if (scope === 'restaurant' && !restaurantIds.length) throw new ValidationError('Choose at least one restaurant');
    if (scope === 'category' && !categoryIds.length) throw new ValidationError('Choose at least one category');
    if (scope === 'item' && !itemIds.length) throw new ValidationError('Choose at least one dish');
    if (restaurantIds.length + categoryIds.length + itemIds.length > MAX_TARGETS) {
        throw new ValidationError(`A rule can list at most ${MAX_TARGETS} targets`);
    }

    // Everything listed must exist, so a typo can't silently cover nothing.
    const [zone, rCount, cCount, iCount] = await Promise.all([
        zoneId ? prisma.foodZone.findUnique({ where: { id: zoneId }, select: { id: true } }) : true,
        restaurantIds.length ? prisma.foodRestaurant.count({ where: { id: { in: restaurantIds } } }) : 0,
        categoryIds.length ? prisma.foodCategory.count({ where: { id: { in: categoryIds } } }) : 0,
        itemIds.length ? prisma.foodItem.count({ where: { id: { in: itemIds } } }) : 0,
    ]);
    if (!zone) throw new ValidationError('That zone was not found');
    if (rCount !== restaurantIds.length) throw new ValidationError('One or more restaurants were not found');
    if (cCount !== categoryIds.length) throw new ValidationError('One or more categories were not found');
    if (iCount !== itemIds.length) throw new ValidationError('One or more dishes were not found');

    const startsAt = parseDate(merged.startsAt, 'Start date');
    const endsAt = parseDate(merged.endsAt, 'End date');
    if (startsAt && endsAt && endsAt <= startsAt) throw new ValidationError('End must be after start');

    void partial;
    return {
        name,
        scope,
        zoneId,
        restaurantIds,
        categoryIds,
        itemIds,
        percent: percentRounded,
        rounding,
        applyToAddons: Boolean(merged.applyToAddons),
        isActive: merged.isActive === undefined ? true : Boolean(merged.isActive),
        startsAt,
        endsAt,
    };
}

const log = (ruleId, action, adminId, before, after) =>
    prisma.foodPriceRuleLog.create({
        data: {
            ruleId,
            action,
            adminId: adminId ? String(adminId) : null,
            before: before ? JSON.parse(JSON.stringify(shape(before))) : undefined,
            after: after ? JSON.parse(JSON.stringify(shape(after))) : undefined,
        },
    });

async function findRule(id) {
    if (!isId(id)) throw new NotFoundError('Price rule not found');
    const row = await prisma.foodPriceRule.findFirst({ where: { id: String(id), deletedAt: null } });
    if (!row) throw new NotFoundError('Price rule not found');
    return row;
}

/** Names for the zone and counts, so the list reads "Bhiwandi · 3 restaurants". */
async function withLabels(rows) {
    const zoneIds = [...new Set(rows.map((r) => r.zoneId).filter(Boolean))];
    const zones = zoneIds.length
        ? await prisma.foodZone.findMany({ where: { id: { in: zoneIds } }, select: { id: true, name: true } })
        : [];
    const zoneName = new Map(zones.map((z) => [z.id, z.name]));
    return rows.map((r) => ({ ...shape(r), zoneName: r.zoneId ? zoneName.get(r.zoneId) || '' : '' }));
}

export async function listPriceRules(query = {}) {
    const where = { deletedAt: null };
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    if (SCOPES.includes(query.scope)) where.scope = query.scope;
    if (isId(query.zoneId)) where.zoneId = String(query.zoneId);
    const rows = await prisma.foodPriceRule.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 500 });
    return { rules: await withLabels(rows) };
}

export async function getPriceRule(id) {
    const row = await findRule(id);
    const [labelled] = await withLabels([row]);
    const [restaurants, categories, items] = await Promise.all([
        row.restaurantIds.length
            ? prisma.foodRestaurant.findMany({ where: { id: { in: row.restaurantIds } }, select: { id: true, restaurantName: true } })
            : [],
        row.categoryIds.length
            ? prisma.foodCategory.findMany({ where: { id: { in: row.categoryIds } }, select: { id: true, name: true } })
            : [],
        row.itemIds.length
            ? prisma.foodItem.findMany({
                  where: { id: { in: row.itemIds } },
                  select: { id: true, name: true, restaurant: { select: { restaurantName: true } } },
              })
            : [],
    ]);
    const logs = await prisma.foodPriceRuleLog.findMany({
        where: { ruleId: row.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
    return {
        ...labelled,
        restaurants: restaurants.map((r) => ({ id: r.id, name: r.restaurantName })),
        categories: categories.map((c) => ({ id: c.id, name: c.name })),
        items: items.map((i) => ({ id: i.id, name: i.name, restaurantName: i.restaurant?.restaurantName || '' })),
        logs: logs.map((l) => ({ id: l.id, action: l.action, adminId: l.adminId, at: l.createdAt, before: l.before, after: l.after })),
    };
}

export async function createPriceRule(body, adminId) {
    const data = await validateRule(body);
    const row = await prisma.foodPriceRule.create({
        data: { ...data, createdById: adminId ? String(adminId) : null, updatedById: adminId ? String(adminId) : null },
    });
    await log(row.id, 'create', adminId, null, row);
    await clearPriceCaches();
    return shape(row);
}

export async function updatePriceRule(id, body, adminId) {
    const before = await findRule(id);
    const data = await validateRule(body, { existing: shape(before) });
    const row = await prisma.foodPriceRule.update({
        where: { id: before.id },
        data: { ...data, updatedById: adminId ? String(adminId) : null },
    });
    await log(row.id, 'update', adminId, before, row);
    await clearPriceCaches();
    return shape(row);
}

export async function togglePriceRule(id, isActive, adminId) {
    const before = await findRule(id);
    const next = isActive === undefined ? !before.isActive : Boolean(isActive);
    const row = await prisma.foodPriceRule.update({
        where: { id: before.id },
        data: { isActive: next, updatedById: adminId ? String(adminId) : null },
    });
    await log(row.id, next ? 'activate' : 'deactivate', adminId, before, row);
    await clearPriceCaches();
    return shape(row);
}

/** Soft delete: the rule stops applying, its history stays. */
export async function deletePriceRule(id, adminId) {
    const before = await findRule(id);
    const row = await prisma.foodPriceRule.update({
        where: { id: before.id },
        data: { deletedAt: new Date(), isActive: false, updatedById: adminId ? String(adminId) : null },
    });
    await log(row.id, 'delete', adminId, before, null);
    await clearPriceCaches();
    return { id: row.id, deleted: true };
}

// ---- preview ---------------------------------------------------------------

const DISH_SELECT = {
    id: true,
    name: true,
    price: true,
    categoryId: true,
    restaurantId: true,
    restaurant: { select: { restaurantName: true, zoneId: true } },
    variants: { select: { id: true, name: true, price: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
};

/** Dishes a rule could cover, as a Prisma filter. */
function dishFilter(rule) {
    const where = { approvalStatus: 'approved' };
    if (rule.zoneId) where.restaurant = { zoneId: rule.zoneId };
    if (rule.scope === 'restaurant') where.restaurantId = { in: rule.restaurantIds };
    if (rule.scope === 'category') where.categoryId = { in: rule.categoryIds };
    if (rule.scope === 'item') where.id = { in: rule.itemIds };
    return where;
}

const allRules = async () =>
    (await prisma.foodPriceRule.findMany({ where: { deletedAt: null, isActive: true } }))
        .filter((r) => isRuleLive(r))
        .map((r) => ({ ...r, percent: num(r.percent) }));

const dishView = (food, rule, current) => {
    const zoneId = food.restaurant?.zoneId || null;
    const sizes = (food.variants || []).length
        ? food.variants.map((v) => ({ name: v.name, base: num(v.price) }))
        : [{ name: '', base: num(food.price) }];
    return {
        id: food.id,
        name: food.name,
        restaurantId: food.restaurantId,
        restaurantName: food.restaurant?.restaurantName || '',
        zoneId,
        sizes: sizes.map((s) => ({
            ...s,
            current: toAppPrice(s.base, current),
            app: toAppPrice(s.base, rule),
        })),
    };
};

/**
 * What saving `body` would do: the dishes it covers, base and new app price,
 * and which of them keep another, more specific rule instead. Saves nothing.
 */
export async function previewPriceRule(body = {}, { page = 1, limit = 50 } = {}) {
    const draft = await validateRule(body);
    const draftRule = { ...draft, id: body.id || '__draft__', updatedAt: new Date(8.64e15) };

    const live = await allRules();
    const others = live.filter((r) => r.id !== body.id);
    const withDraft = draft.isActive ? [...others, draftRule] : others;

    const where = dishFilter(draftRule);
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;

    const [total, foods] = await Promise.all([
        prisma.foodItem.count({ where }),
        prisma.foodItem.findMany({ where, select: DISH_SELECT, orderBy: [{ restaurantId: 'asc' }, { name: 'asc' }], skip, take }),
    ]);

    const dishes = foods.map((food) => {
        const key = {
            id: food.id,
            categoryId: food.categoryId,
            restaurantId: food.restaurantId,
            zoneId: food.restaurant?.zoneId || null,
        };
        const winner = resolveRule(key, withDraft);
        const current = resolveRule(key, others);
        const view = dishView(food, winner, current);
        const keeps = winner && winner.id !== draftRule.id ? { id: winner.id, name: winner.name, percent: winner.percent } : null;
        return { ...view, followsThisRule: Boolean(winner && winner.id === draftRule.id), keepsRule: keeps };
    });

    return {
        total,
        page: Math.max(1, Number(page) || 1),
        limit: take,
        dishes,
    };
}

/** Every dish of one restaurant: base price, app price, and the rule behind it. */
export async function effectivePrices(restaurantId) {
    if (!isId(restaurantId)) throw new ValidationError('Choose a restaurant');
    const live = await allRules();
    const foods = await prisma.foodItem.findMany({
        where: { restaurantId: String(restaurantId) },
        select: DISH_SELECT,
        orderBy: { name: 'asc' },
        take: 2000,
    });
    return {
        dishes: foods.map((food) => {
            const rule = resolveRule(
                { id: food.id, categoryId: food.categoryId, restaurantId: food.restaurantId, zoneId: food.restaurant?.zoneId || null },
                live,
            );
            const view = dishView(food, rule, rule);
            return { ...view, rule: rule ? { id: rule.id, name: rule.name, percent: rule.percent } : null };
        }),
    };
}

export { ruleMatches };
