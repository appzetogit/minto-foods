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
