import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenError } from '../auth/errors.js';

/**
 * Which cities a sub-admin's request may touch.
 *
 * Set once per admin request (adminScope.middleware.js) and read by the Prisma
 * extension in config/prisma.js, which adds the matching filter to every query
 * on a city-bound model. Doing it there rather than in each of ~40 admin
 * services means a service written tomorrow is limited too, and a forgotten
 * filter shows a sub-admin less rather than everything.
 *
 * No store -- a super admin, a customer, a rider, a background job -- means no
 * limit. This module imports nothing from Prisma so config/prisma.js can use it.
 *
 * @typedef {{ adminId: string, cityIds: string[], cityNames: string[], zoneIds: string[] }} AdminScope
 */
const storage = new AsyncLocalStorage();

/** @returns {AdminScope | undefined} */
export const currentAdminScope = () => storage.getStore();

export const runWithAdminScope = (scope, fn) => storage.run(scope, fn);

/** Runs fn with no city limit, for the lookups that build the scope itself. */
export const runUnscoped = (fn) => storage.exit(fn);

const inZones = (scope) => ({ in: scope.zoneIds });

/** Models whose rows belong to exactly one zone. Rows with no zone are hidden. */
const ZONED = {
    foodOrder: (s) => ({ zoneId: inZones(s) }),
    foodZone: (s) => ({ id: inZones(s) }),
    foodLandingZoneSettings: (s) => ({ zoneId: inZones(s) }),
    // A restaurant waiting for approval only has a pending zone, and approving
    // it is exactly what a city's sub-admin is for.
    foodRestaurant: (s) => ({ OR: [{ zoneId: inZones(s) }, { pendingZoneId: inZones(s) }] }),
    // Riders carry a typed city rather than a zone.
    foodDeliveryPartner: (s) => ({ city: { in: s.cityNames, mode: 'insensitive' } }),
    foodRestaurantProfileChange: (s) => ({
        restaurant: { OR: [{ zoneId: inZones(s) }, { pendingZoneId: inZones(s) }] },
    }),
    foodRestaurantBankChange: (s) => ({
        restaurant: { OR: [{ zoneId: inZones(s) }, { pendingZoneId: inZones(s) }] },
    }),
};

/**
 * Models where no zone means "everywhere". A sub-admin can see those rows but
 * only change the ones in their own zones -- a platform-wide banner or fee is the
 * super admin's.
 */
const ZONED_OR_GLOBAL = new Set([
    'foodFeeSettings', 'foodUnder250Banner', 'homePromotionBanner',
    'foodSurgeRule', 'foodOfferBanner', 'topBanner',
]);

const READS = new Set([
    'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
    'count', 'aggregate', 'groupBy',
]);
const WHERE_WRITES = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'updateManyAndReturn']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Prisma's delegate name for a model: FoodOrder -> foodOrder. */
const delegateName = (model) => model.charAt(0).toLowerCase() + model.slice(1);

/** The filter a query on `model` must also satisfy, or null for no limit. */
export const scopeFilter = (model, operation, scope) => {
    const name = delegateName(model);
    if (ZONED[name]) return ZONED[name](scope);
    if (ZONED_OR_GLOBAL.has(name)) {
        return READS.has(operation)
            ? { OR: [{ zoneId: inZones(scope) }, { zoneId: null }] }
            : { zoneId: inZones(scope) };
    }
    return null;
};

const connectedId = (data, relation) => data?.[relation]?.connect?.id;

/** Whether a row about to be created falls inside the scope. */
export const createAllowed = (model, data, scope) => {
    const name = delegateName(model);
    const zones = new Set(scope.zoneIds);
    if (name === 'foodZone') return scope.cityIds.includes(data?.cityId ?? connectedId(data, 'cityRef'));
    if (name === 'foodRestaurant') {
        return [data?.zoneId ?? connectedId(data, 'zone'), data?.pendingZoneId ?? connectedId(data, 'pendingZone')]
            .some((id) => zones.has(id));
    }
    if (name === 'foodDeliveryPartner') {
        const city = String(data?.city || '').trim().toLowerCase();
        return scope.cityNames.some((n) => n.toLowerCase() === city);
    }
    if (ZONED[name] || ZONED_OR_GLOBAL.has(name)) {
        return zones.has(data?.zoneId ?? connectedId(data, 'zone'));
    }
    return true;
};

const withFilter = (where, filter) => (where ? { AND: [where, filter] } : filter);

/**
 * Rewrites a query's arguments so it only reaches the current sub-admin's
 * cities. Pure, so it is tested without a database.
 */
export const applyAdminScope = (model, operation, args, scope) => {
    if (!scope || !model) return args;
    const filter = scopeFilter(model, operation, scope);
    if (!filter && !CREATES.has(operation)) return args;

    if (CREATES.has(operation)) {
        const rows = Array.isArray(args?.data) ? args.data : [args?.data];
        if (!rows.every((row) => createAllowed(model, row, scope))) {
            throw new ForbiddenError('That is outside the cities assigned to you');
        }
        return args;
    }
    if (READS.has(operation) || WHERE_WRITES.has(operation)) {
        if (operation === 'upsert' && !createAllowed(model, args?.create, scope)) {
            throw new ForbiddenError('That is outside the cities assigned to you');
        }
        // findUnique/update/delete accept extra non-unique conditions beside the
        // unique key, so an out-of-city row reads as "not found".
        const { where, ...rest } = args || {};
        if (operation.startsWith('findUnique') || ['update', 'delete', 'upsert'].includes(operation)) {
            return { ...rest, where: { ...where, AND: [...[].concat(where?.AND || []), filter] } };
        }
        return { ...rest, where: withFilter(where, filter) };
    }
    return args;
};
