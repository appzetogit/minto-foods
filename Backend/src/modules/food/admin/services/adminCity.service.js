import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { currentAdminScope } from '../../../../core/roles/adminScope.context.js';

/**
 * Cities, which zones are grouped under and sub-admins are assigned to.
 *
 * FoodCity is not scoped by the Prisma extension (it has no zone), so the
 * sub-admin limit is applied here by hand: they see only their own cities.
 */

/** "  indore " and "Indore" are one city. */
export const cityKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

const scopedWhere = () => {
    const scope = currentAdminScope();
    return scope ? { id: { in: scope.cityIds } } : {};
};

const present = (city) => ({
    id: city.id,
    _id: city.id,
    name: city.name,
    state: city.state,
    isActive: city.isActive,
    zoneCount: city._count?.zones ?? 0,
    createdAt: city.createdAt,
});

/** The city list, and the suggestions the zone form shows as you type (`q`). */
export async function listCities(query = {}) {
    const q = cleanName(query.q ?? query.search);
    const where = { ...scopedWhere() };
    if (q) where.name = { contains: q, mode: 'insensitive' };
    if (query.isActive === 'true') where.isActive = true;

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500);
    const cities = await prisma.foodCity.findMany({
        where,
        orderBy: { name: 'asc' },
        take: limit,
        include: { _count: { select: { zones: true } } },
    });
    return { cities: cities.map(present) };
}

export async function getCity(id) {
    if (!isId(id)) throw new NotFoundError('City not found');
    const city = await prisma.foodCity.findFirst({
        where: { id: String(id), ...scopedWhere() },
        include: {
            _count: { select: { zones: true } },
            zones: { select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } },
        },
    });
    if (!city) throw new NotFoundError('City not found');
    return { city: { ...present(city), zones: city.zones } };
}

export async function createCity(body = {}) {
    const name = cleanName(body.name);
    if (!name) throw new ValidationError('City name is required');
    if (name.length > 80) throw new ValidationError('City name is too long');

    const existing = await prisma.foodCity.findUnique({ where: { nameKey: cityKey(name) } });
    if (existing) throw new ValidationError(`${existing.name} already exists`);

    const city = await prisma.foodCity.create({
        data: { name, nameKey: cityKey(name), state: cleanName(body.state) || null },
        include: { _count: { select: { zones: true } } },
    });
    return { city: present(city) };
}

export async function updateCity(id, body = {}) {
    if (!isId(id)) throw new NotFoundError('City not found');
    const city = await prisma.foodCity.findUnique({ where: { id: String(id) } });
    if (!city) throw new NotFoundError('City not found');

    const data = {};
    if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) throw new ValidationError('City name is required');
        const clash = await prisma.foodCity.findUnique({ where: { nameKey: cityKey(name) } });
        if (clash && clash.id !== city.id) throw new ValidationError(`${clash.name} already exists`);
        data.name = name;
        data.nameKey = cityKey(name);
    }
    if (body.state !== undefined) data.state = cleanName(body.state) || null;
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;

    const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.foodCity.update({
            where: { id: city.id },
            data,
            include: { _count: { select: { zones: true } } },
        });
        // Zones still carry the city's name as text for older screens and apps.
        if (data.name) await tx.foodZone.updateMany({ where: { cityId: city.id }, data: { city: data.name } });
        return row;
    });
    return { city: present(updated) };
}

export async function deleteCity(id) {
    if (!isId(id)) throw new NotFoundError('City not found');
    const city = await prisma.foodCity.findUnique({
        where: { id: String(id) },
        include: { _count: { select: { zones: true } } },
    });
    if (!city) throw new NotFoundError('City not found');
    if (city._count.zones > 0) {
        throw new ValidationError(`${city.name} still has ${city._count.zones} zone(s). Move or delete them first.`);
    }
    await prisma.foodCity.delete({ where: { id: city.id } });
    return { id: city.id };
}

/** A city-limited admin can only put zones in their own cities. */
const assertCityInScope = (city) => {
    const scope = currentAdminScope();
    if (scope && !scope.cityIds.includes(city.id)) {
        throw new ValidationError(`${city.name} is not one of your cities`);
    }
};

/**
 * The city a zone should belong to, from what the zone form sent.
 *
 * `cityId` picks an existing city. A typed `city` name matches an existing
 * city however it is capitalised; a new city is only made when the form says
 * so with `createCity`, so a typo cannot quietly start a new city.
 * Returns undefined when the request says nothing about the city.
 */
export async function resolveZoneCity(body = {}, db = prisma) {
    if (isId(body.cityId)) {
        const city = await db.foodCity.findUnique({ where: { id: String(body.cityId) } });
        if (!city) throw new ValidationError('That city does not exist');
        assertCityInScope(city);
        return city;
    }
    if (body.city === undefined && body.cityName === undefined) return undefined;

    const name = cleanName(body.cityName ?? body.city);
    if (!name) return null;
    const existing = await db.foodCity.findUnique({ where: { nameKey: cityKey(name) } });
    if (existing) { assertCityInScope(existing); return existing; }
    if (currentAdminScope()) {
        throw new ValidationError(`No city called "${name}". Only the super admin can add cities.`);
    }
    if (!(body.createCity === true || body.createCity === 'true')) {
        throw new ValidationError(`No city called "${name}". Pick one from the list or add it as a new city.`);
    }
    return db.foodCity.create({ data: { name, nameKey: cityKey(name) } });
}
