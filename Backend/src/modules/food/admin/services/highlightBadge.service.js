import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';

/**
 * Restaurant highlight tags (Bestseller, Popular, New, ...).
 *
 * The list used to be hard-coded in the backend, the admin form and the user
 * app, so adding a tag meant a release of all three. A restaurant stores the
 * tag's key; the card carries the label and colour so the apps can show a
 * tag they have never heard of.
 */

const toKey = (value) =>
    String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 20);

const toColor = (value) => {
    const color = String(value ?? '').trim();
    if (!color) return '#E23744';
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ValidationError('Colour must look like #E23744');
    return color.toUpperCase();
};

const serialize = (row) => ({
    id: row.id,
    key: row.key,
    label: row.label,
    color: row.color,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
});

// Read on every restaurant list, changed a few times a year.
let memo = { at: 0, map: new Map() };
const MEMO_MS = 60_000;

export async function loadHighlightBadges({ fresh = false } = {}) {
    if (!fresh && Date.now() - memo.at < MEMO_MS) return memo.map;
    try {
        const rows = await prisma.foodHighlightBadge.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
        memo = { at: Date.now(), map: new Map(rows.map((row) => [row.key, serialize(row)])) };
    } catch {
        // A missing table (migration not yet run) must not break the restaurant list.
        memo = { at: Date.now(), map: memo.map };
    }
    return memo.map;
}

/** The label and colour for a restaurant's tag, from the last load. */
export const badgeInfo = (key) => {
    if (!key) return null;
    const badge = memo.map.get(key);
    if (!badge || !badge.isActive) return null;
    return { key: badge.key, label: badge.label, color: badge.color };
};

/** The tag key to store on a restaurant, or null to clear it. */
export async function resolveHighlightBadge(value) {
    const key = toKey(value);
    if (!key) return null;
    const badges = await loadHighlightBadges({ fresh: true });
    const badge = badges.get(key);
    if (!badge || !badge.isActive) {
        const names = [...badges.values()].filter((b) => b.isActive).map((b) => b.label).join(', ');
        throw new ValidationError(`Unknown tag "${value}". Available tags: ${names || 'none'}`);
    }
    return key;
}

export async function listHighlightBadges({ activeOnly = false } = {}) {
    const rows = await prisma.foodHighlightBadge.findMany({
        where: activeOnly ? { isActive: true } : {},
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    const counts = activeOnly
        ? new Map()
        : new Map((await prisma.foodRestaurant.groupBy({
            by: ['highlightBadge'],
            where: { highlightBadge: { in: rows.map((r) => r.key) } },
            _count: { _all: true },
        })).map((g) => [g.highlightBadge, g._count._all]));
    return rows.map((row) => ({ ...serialize(row), restaurantCount: counts.get(row.key) || 0 }));
}

export async function createHighlightBadge(body = {}) {
    const label = String(body.label || '').trim().slice(0, 40);
    if (!label) throw new ValidationError('Tag name is required');
    const key = toKey(body.key || label);
    if (!key) throw new ValidationError('Tag name must contain letters or numbers');

    const exists = await prisma.foodHighlightBadge.findUnique({ where: { key } });
    if (exists) throw new ValidationError(`A tag called "${exists.label}" already exists`);

    const row = await prisma.foodHighlightBadge.create({
        data: {
            key,
            label,
            color: toColor(body.color),
            isActive: body.isActive !== false,
            sortOrder: Number.isFinite(Number(body.sortOrder)) ? Math.round(Number(body.sortOrder)) : 0,
        },
    });
    await loadHighlightBadges({ fresh: true });
    return serialize(row);
}

export async function updateHighlightBadge(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid tag id');
    const data = {};
    if (body.label !== undefined) {
        const label = String(body.label || '').trim().slice(0, 40);
        if (!label) throw new ValidationError('Tag name is required');
        data.label = label;
    }
    if (body.color !== undefined) data.color = toColor(body.color);
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
        data.sortOrder = Math.round(Number(body.sortOrder));
    }

    const existing = await prisma.foodHighlightBadge.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Tag not found');
    // The key stays: restaurants point at it.
    const row = await prisma.foodHighlightBadge.update({ where: { id: existing.id }, data });
    await loadHighlightBadges({ fresh: true });
    return serialize(row);
}

/** Deleting a tag takes it off every restaurant that had it. */
export async function deleteHighlightBadge(id) {
    if (!isId(id)) throw new ValidationError('Invalid tag id');
    const existing = await prisma.foodHighlightBadge.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Tag not found');
    const [cleared] = await prisma.$transaction([
        prisma.foodRestaurant.updateMany({ where: { highlightBadge: existing.key }, data: { highlightBadge: null } }),
        prisma.foodHighlightBadge.delete({ where: { id: existing.id } }),
    ]);
    await loadHighlightBadges({ fresh: true });
    return { deleted: true, restaurantsCleared: cleared.count };
}
