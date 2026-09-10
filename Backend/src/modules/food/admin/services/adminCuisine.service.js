import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * The cuisine vocabulary.
 *
 * `FoodRestaurant.cuisines` is a String[] of names and stays that way -- the
 * customer app filters and displays by name on nearly every screen, and a join
 * for a label that changes once a year is not worth paying for. This table is
 * the picker: it decides what can be chosen, not what is stored.
 *
 * That split is also why deletion is a soft one. Removing a row here cannot
 * reach into the restaurants already carrying the name, so a hard delete would
 * leave restaurants filed under something nobody can select any more.
 */

/**
 * What two spellings of the same cuisine have in common.
 *
 * Lowercased with runs of whitespace collapsed, so "North Indian",
 * "north indian" and "North  Indian" are one cuisine rather than three. The
 * display name keeps whatever capitalisation was typed.
 */
export const cuisineSlug = (name) =>
    String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

const serialize = (row, usedBy = 0) => ({
    id: row.id,
    _id: row.id,
    name: row.name,
    slug: row.slug,
    image: row.image || null,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    // How many restaurants are filed under it, so an admin can see what
    // deactivating would affect before doing it.
    restaurantCount: usedBy,
    createdAt: row.createdAt,
});

/** How many restaurants use each cuisine name, counted in one pass. */
const countUsage = async (names) => {
    if (!names.length) return new Map();

    const rows = await prisma.$queryRaw`
        SELECT c AS name, COUNT(*)::int AS uses
        FROM "food_restaurants" r, unnest(r."cuisines") AS c
        WHERE btrim(c) <> ''
        GROUP BY c
    `;

    // Matched on the slug, not the raw string: a restaurant saved before the
    // vocabulary existed may carry "north indian" while the row says
    // "North Indian", and those are the same cuisine.
    const bySlug = new Map();
    for (const row of rows) {
        const slug = cuisineSlug(row.name);
        bySlug.set(slug, (bySlug.get(slug) || 0) + Number(row.uses || 0));
    }
    return bySlug;
};

export async function listCuisines(query = {}) {
    const includeInactive = query.includeInactive === true || query.includeInactive === 'true';

    const rows = await prisma.foodCuisine.findMany({
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const usage = await countUsage(rows.map((r) => r.name));
    return { cuisines: rows.map((row) => serialize(row, usage.get(row.slug) || 0)) };
}

export async function createCuisine(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) throw new ValidationError('Cuisine name is required');
    if (name.length > 60) throw new ValidationError('Cuisine name is too long (max 60 chars)');

    const slug = cuisineSlug(name);
    const clash = await prisma.foodCuisine.findUnique({ where: { slug } });
    if (clash) {
        // Named rather than a bare unique-constraint error, because the clash is
        // usually a capitalisation the admin cannot see.
        throw new ValidationError(`"${clash.name}" is already on the list`);
    }

    const row = await prisma.foodCuisine.create({
        data: {
            name,
            slug,
            image: String(body.image || '').trim() || null,
            isActive: body.isActive !== false,
            sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
        },
    });
    return { cuisine: serialize(row) };
}

export async function updateCuisine(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Cuisine not found');

    const existing = await prisma.foodCuisine.findUnique({ where: { id: String(id) } });
    if (!existing) throw new ValidationError('Cuisine not found');

    const data = {};

    if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new ValidationError('Cuisine name is required');
        const slug = cuisineSlug(name);
        if (slug !== existing.slug) {
            const clash = await prisma.foodCuisine.findUnique({ where: { slug } });
            if (clash) throw new ValidationError(`"${clash.name}" is already on the list`);
        }
        data.name = name;
        data.slug = slug;
    }

    if (body.image !== undefined) data.image = String(body.image || '').trim() || null;
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;
    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
        data.sortOrder = Number(body.sortOrder);
    }

    const row = await prisma.foodCuisine.update({ where: { id: existing.id }, data });
    const usage = await countUsage([row.name]);
    return { cuisine: serialize(row, usage.get(row.slug) || 0) };
}

/**
 * Take a cuisine out of the picker.
 *
 * Deactivates rather than deletes when restaurants still carry the name: the
 * name lives on the restaurant rows and nothing here can reach it, so removing
 * the row would leave those restaurants filed under something unselectable.
 * Deactivating hides it from the picker and leaves them intact.
 *
 * A cuisine nobody uses is deleted outright -- there is nothing to strand.
 */
export async function deleteCuisine(id) {
    if (!isId(id)) throw new ValidationError('Cuisine not found');

    const existing = await prisma.foodCuisine.findUnique({ where: { id: String(id) } });
    if (!existing) throw new ValidationError('Cuisine not found');

    const usage = await countUsage([existing.name]);
    const uses = usage.get(existing.slug) || 0;

    if (uses > 0) {
        const row = await prisma.foodCuisine.update({
            where: { id: existing.id },
            data: { isActive: false },
        });
        return {
            deleted: false,
            deactivated: true,
            restaurantCount: uses,
            cuisine: serialize(row, uses),
            message: `${existing.name} is used by ${uses} restaurant${uses === 1 ? '' : 's'}, so it was hidden from the picker rather than deleted.`,
        };
    }

    await prisma.foodCuisine.delete({ where: { id: existing.id } });
    return { deleted: true, deactivated: false, restaurantCount: 0 };
}
