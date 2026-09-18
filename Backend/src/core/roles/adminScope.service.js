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
