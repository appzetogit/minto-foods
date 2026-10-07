import { prisma } from '../../../config/prisma.js';
import { runUnscoped } from '../../../core/roles/adminScope.context.js';
import { invalidateCache } from '../../../middleware/cache.js';
import { logger } from '../../../utils/logger.js';

/**
 * App prices: what customers see and pay, worked out from the restaurant's
 * own price by the admin's price rules.
 *
 * Nothing here ever writes a dish's price. `FoodItem.price` and the variant
 * prices stay the restaurant's base price; a rule is a percentage applied on
 * the way out to a customer. So a restaurant changing its price moves the app
 * price with it, and switching every rule off puts every price back exactly.
 *
 * One dish follows one rule: the most specific active one that matches it.
 * Rules never stack.
 */

export const PERCENT_MIN = -50;
export const PERCENT_MAX = 100;

/** Most specific first. A rule's zone (if set) narrows any scope further. */
const SPECIFICITY = { item: 5, category: 4, restaurant: 3, zone: 2, all: 1 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The customer price for one base price under one rule. No rule, or a free
 * item, is the base price unchanged. A marked-down price never drops below ₹1.
 */
export function toAppPrice(base, rule) {
    const price = Number(base) || 0;
    if (!rule || price <= 0) return round2(price);
    const percent = Number(rule.percent) || 0;
    if (percent === 0) return round2(price);

    const raw = price * (1 + percent / 100);
    let out;
    switch (rule.rounding) {
        case 'none':
            out = round2(raw);
            break;
        case 'end_9': {
            // Up to the next price ending in 9: ₹215 -> ₹219, ₹221 -> ₹229.
            const up = Math.ceil(raw - 1e-9);
            out = up % 10 === 9 ? up : up + ((9 - (up % 10)) + 10) % 10;
            break;
        }
        default:
            out = Math.round(raw);
    }
    return Math.max(1, out);
}

/** Is a rule switched on and inside its schedule right now? */
export const isRuleLive = (rule, now = new Date()) =>
    Boolean(rule?.isActive) &&
    (!rule.startsAt || new Date(rule.startsAt) <= now) &&
    (!rule.endsAt || new Date(rule.endsAt) >= now);

/**
 * Does `rule` cover a dish? `dish` is { id, categoryId, restaurantId, zoneId }.
 */
export function ruleMatches(rule, dish) {
    if (rule.zoneId && String(rule.zoneId) !== String(dish.zoneId || '')) return false;
    switch (rule.scope) {
        case 'all':
            return true;
        case 'zone':
            return Boolean(rule.zoneId);
        case 'restaurant':
            return (rule.restaurantIds || []).includes(String(dish.restaurantId));
        case 'category':
            return Boolean(dish.categoryId) && (rule.categoryIds || []).includes(String(dish.categoryId));
        case 'item':
            return (rule.itemIds || []).includes(String(dish.id));
        default:
            return false;
    }
}

/**
 * The one rule a dish follows: most specific scope wins; among equals, a rule
 * limited to a zone beats an unlimited one, then the most recently changed.
 */
export function resolveRule(dish, rules) {
    let best = null;
    for (const rule of rules || []) {
        if (!ruleMatches(rule, dish)) continue;
        if (!best) {
            best = rule;
            continue;
        }
        const a = SPECIFICITY[rule.scope] || 0;
        const b = SPECIFICITY[best.scope] || 0;
        if (a !== b) {
            if (a > b) best = rule;
            continue;
        }
        const az = rule.zoneId ? 1 : 0;
        const bz = best.zoneId ? 1 : 0;
        if (az !== bz) {
            if (az > bz) best = rule;
            continue;
        }
        if (new Date(rule.updatedAt || 0) > new Date(best.updatedAt || 0)) best = rule;
    }
    return best;
}

// ---- loading (cached) ------------------------------------------------------

const CACHE_MS = 60_000;
let cache = { at: 0, rules: null };

const shapeRule = (r) => ({
    ...r,
    percent: Number(r.percent) || 0,
    restaurantIds: (r.restaurantIds || []).map(String),
    categoryIds: (r.categoryIds || []).map(String),
    itemIds: (r.itemIds || []).map(String),
});

/**
 * Every rule that is switched on and inside its schedule. Cached for a minute;
 * any admin change clears it. Always unscoped: a customer's menu must not
 * depend on which admin happens to be looking.
 */
export async function loadLiveRules(now = new Date()) {
    if (!cache.rules || Date.now() - cache.at > CACHE_MS) {
        const rows = await runUnscoped(() =>
            prisma.foodPriceRule.findMany({ where: { isActive: true, deletedAt: null } }),
        );
        cache = { at: Date.now(), rules: rows.map(shapeRule) };
    }
    return cache.rules.filter((r) => isRuleLive(r, now));
}

/** Drop cached rules and every cached customer menu, so a change shows at once. */
export async function clearPriceCaches() {
    cache = { at: 0, rules: null };
    for (const prefix of ['restaurant_menu', 'public_foods', 'restaurant_addons']) {
        try {
            await invalidateCache(`${prefix}*`);
        } catch (err) {
            logger.warn(`Price rule cache clear failed for ${prefix}: ${err?.message || err}`);
        }
    }
}

/** For tests: forget the cached rules. */
export const resetPriceRuleCache = () => {
    cache = { at: 0, rules: null };
};

// ---- applying to dishes ----------------------------------------------------

async function zonesFor(restaurantIds) {
    const ids = [...new Set(restaurantIds.filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const rows = await runUnscoped(() =>
        prisma.foodRestaurant.findMany({ where: { id: { in: ids } }, select: { id: true, zoneId: true } }),
    );
    return new Map(rows.map((r) => [String(r.id), r.zoneId ? String(r.zoneId) : null]));
}

/**
 * The rule each dish follows, keyed by dish id. `foods` need `id`,
 * `restaurantId` and `categoryId`; zones are looked up in one query unless
 * `zoneByRestaurant` is given.
 */
export async function rulesForFoods(foods, { rules, zoneByRestaurant } = {}) {
    const live = rules || (await loadLiveRules());
    const out = new Map();
    if (!live.length || !foods?.length) return out;

    const zones = zoneByRestaurant || (await zonesFor(foods.map((f) => f?.restaurantId)));
    for (const food of foods) {
        if (!food) continue;
        const id = String(food.id ?? food._id ?? '');
        const rule = resolveRule(
            {
                id,
                categoryId: food.categoryId ? String(food.categoryId) : null,
                restaurantId: String(food.restaurantId ?? ''),
                zoneId: zones.get(String(food.restaurantId ?? '')) ?? null,
            },
            live,
        );
        if (rule) out.set(id, rule);
    }
    return out;
}

const scaleOther = (other, rule) => {
    const n = Number(other) || 0;
    return n > 0 ? toAppPrice(n, { ...rule, rounding: rule.rounding }) : n;
};

/**
 * Returns copies of `foods` with customer prices: `price`, every variant's
 * `price`, and the strikethrough `otherPrice` scaled the same way. Inputs are
 * never mutated. A dish with no rule comes back as it went in.
 *
 * Works on raw Prisma rows and on serialized menu objects alike: it only
 * touches `price`, `otherPrice` and `variants`/`variations`.
 */
export async function applyAppPricing(foods, opts = {}) {
    if (!Array.isArray(foods) || !foods.length) return foods;
    const ruleById = await rulesForFoods(foods, opts);
    if (!ruleById.size) return foods;

    return foods.map((food) => {
        const rule = ruleById.get(String(food?.id ?? food?._id ?? ''));
        if (!rule) return food;
        const scaleVariants = (list) =>
            Array.isArray(list)
                ? list.map((v) => ({
                      ...v,
                      price: toAppPrice(v.price, rule),
                      otherPrice: scaleOther(v.otherPrice, rule),
                  }))
                : list;
        const out = {
            ...food,
            price: toAppPrice(food.price, rule),
            otherPrice: scaleOther(food.otherPrice, rule),
        };
        if (food.variants !== undefined) out.variants = scaleVariants(food.variants);
        if (food.variations !== undefined) out.variations = scaleVariants(food.variations);
        return out;
    });
}

/** Single-dish convenience. */
export async function applyAppPricingOne(food, opts = {}) {
    if (!food) return food;
    const [out] = await applyAppPricing([food], opts);
    return out;
}

/**
 * Add-on prices for one restaurant. Only rules with `applyToAddons` touch
 * add-ons, and an add-on follows the restaurant's own rule chain (all, zone,
 * restaurant) since add-ons have no category or dish of their own.
 */
export async function addonRuleForRestaurant(restaurantId, { rules } = {}) {
    const live = (rules || (await loadLiveRules())).filter((r) => r.applyToAddons);
    if (!live.length) return null;
    const zones = await zonesFor([restaurantId]);
    return resolveRule(
        {
            id: '',
            categoryId: null,
            restaurantId: String(restaurantId),
            zoneId: zones.get(String(restaurantId)) ?? null,
        },
        live.filter((r) => ['all', 'zone', 'restaurant'].includes(r.scope)),
    );
}
