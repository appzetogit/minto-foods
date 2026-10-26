import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';

/**
 * Builds the city scope for an admin, or null when they are not limited.
 *
 * A super admin is never limited. A sub-admin is limited to the cities assigned
 * to them and the zones inside those cities -- and one with no cities gets an
 * empty scope, which shows them nothing rather than everything.
 */
export async function loadAdminScope(admin) {
    if (!admin || admin.adminType !== 'sub_admin' || !isId(admin.id)) return null;

    const links = await prisma.foodAdminCity.findMany({
        where: { adminId: String(admin.id) },
        select: { city: { select: { id: true, name: true, zones: { select: { id: true } } } } },
    });

    const cities = links.map((l) => l.city).filter(Boolean);
    return {
        adminId: String(admin.id),
        cityIds: cities.map((c) => c.id),
        cityNames: cities.map((c) => c.name),
        zoneIds: cities.flatMap((c) => c.zones.map((z) => z.id)),
    };
}

/**
 * The zones an admin request is looking at: the city or zone picked in the
 * panel's header (X-Admin-Zone), within a sub-admin's own cities. Null when
 * nothing narrows it.
 *
 * The admin router applies this to city-bound tables through the Prisma
 * extension. Banners are neither city-bound nor all behind the admin router
 * (most live under /food/hero-banners), so their admin lists call this.
 */
export async function viewedZoneIds(req) {
    const admin = isId(req?.user?.userId)
        ? await prisma.foodAdmin.findUnique({
            where: { id: String(req.user.userId) },
            select: { id: true, adminType: true },
        })
        : null;
    const scope = await applyZoneView(await loadAdminScope(admin), admin, req?.headers?.['x-admin-zone']);
    return scope ? scope.zoneIds : null;
}

/**
 * Prisma filter for an admin banner list under [viewedZoneIds]: the
 * all-zones banners plus those of the zones being viewed.
 */
export const adminBannerZoneWhere = (zoneIds) =>
    zoneIds ? { OR: [{ zoneId: null }, { zoneId: { in: zoneIds } }] } : {};

/** What the admin panel is told about the scope, for hiding filters and labels. */
export const describeScope = (scope) =>
    scope
        ? { limited: true, cityIds: scope.cityIds, cityNames: scope.cityNames, zoneIds: scope.zoneIds }
        : { limited: false, cityIds: [], cityNames: [], zoneIds: [] };

/**
 * Narrows a request to the one zone picked in the admin header.
 *
 * A viewing filter, not a permission: it only limits what is read, so an
 * admin looking at one zone can still save a platform-wide setting. A
 * sub-admin can only pick a zone inside their own cities; anything else is
 * ignored and they keep their normal scope.
 */
export async function applyZoneView(scope, admin, zoneId) {
    // "city:<id>" views every zone of one city -- what an admin wants once
    // there is more than one city, rather than picking zones one at a time.
    const cityMatch = /^city:([0-9a-f]{24})$/i.exec(String(zoneId || ''));
    if (cityMatch) {
        const city = await prisma.foodCity.findUnique({
            where: { id: cityMatch[1] },
            select: { id: true, name: true, zones: { select: { id: true } } },
        });
        if (!city) return scope;
        if (scope && !scope.cityIds.includes(city.id)) return scope;
        return {
            adminId: String(admin?.id || ''),
            cityIds: [city.id],
            cityNames: [city.name],
            // A city with no zones yet matches nothing, rather than everything.
            zoneIds: city.zones.length ? city.zones.map((z) => z.id) : ['000000000000000000000000'],
            viewOnly: !scope,
            base: scope || null,
        };
    }
    if (!isId(zoneId)) return scope;
    const zone = await prisma.foodZone.findUnique({
        where: { id: String(zoneId) },
        select: { id: true, cityId: true, cityRef: { select: { name: true } } },
    });
    if (!zone) return scope;
    if (scope && !scope.zoneIds.includes(zone.id)) return scope;
    return {
        adminId: String(admin?.id || ''),
        cityIds: zone.cityId ? [zone.cityId] : [],
        cityNames: zone.cityRef?.name ? [zone.cityRef.name] : [],
        zoneIds: [zone.id],
        // Reads only; writes keep the sub-admin's own scope (or none).
        viewOnly: !scope,
        base: scope || null,
    };
}
