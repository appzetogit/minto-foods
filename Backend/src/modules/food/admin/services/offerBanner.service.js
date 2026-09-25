import { parseDayBound } from '../../../../utils/timezone.js';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';

/**
 * Offer banners: the artwork the apps show for current offers.
 *
 * Mirrors the restaurant app banners, with one addition -- an offer runs for a
 * while, so a banner carries a start and an end. The apps are never asked to
 * apply those: the public list returns what is live at the moment it is called,
 * because a phone with a wrong clock would otherwise show an expired offer.
 */

const FOLDER = 'food/offer-banners';
const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'desc' }];

const serialize = (b) => ({
    id: b.id,
    imageUrl: b.imageUrl,
    title: b.title || '',
    ctaLink: b.ctaLink || '',
    startDate: b.startDate,
    endDate: b.endDate,
    zoneId: b.zoneId || null,
    zoneName: b.zone?.name || null,
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
});

const assertId = (id) => {
    if (!isId(id)) throw new ValidationError('Invalid banner id');
};

// Multipart carries no booleans, so the form sends the strings. Anything that
// is not an explicit false means visible.
const toActive = (value) => !(value === false || value === 'false');

/** Blank, or the word all, means every zone. */
const toZoneId = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw || raw === 'all' || raw === 'null') return null;
    if (!isId(raw)) throw new ValidationError('Invalid zone');
    return raw;
};

/** Blank clears the date; a value has to be a real one. */
const toDate = (value, edge = 'start') => {
    // A bare day is the whole day in India time; see parseDayBound.
    const date = parseDayBound(value, edge);
    if (date === null) throw new ValidationError('Dates must be valid, or left blank');
    return date ?? null;
};

/**
 * Is this banner showing right now?
 *
 * A missing bound is not a bound: a banner with neither date runs for as long
 * as it is switched on, which is what an admin who ignored the date fields
 * means by it. Exported for the tests, and the same rule the query below uses.
 */
export const isBannerLive = (banner = {}, now = new Date()) => {
    if (!banner.isActive) return false;
    const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (banner.startDate && new Date(banner.startDate).getTime() > at) return false;
    if (banner.endDate && new Date(banner.endDate).getTime() < at) return false;
    return true;
};

/** Admin: every banner, whatever its state, in display order. */
export const listBannersAdmin = async () => {
    const banners = await prisma.foodOfferBanner.findMany({
        orderBy: ORDER,
        include: { zone: { select: { name: true } } },
    });
    return { banners: banners.map(serialize) };
};

/**
 * The apps: only what is live now.
 *
 * Filtered in the query rather than in JS so a long list never travels just to
 * be discarded, and ordered here so the app can render what it receives.
 */
export const listLiveBanners = async (zoneId = null) => {
    const now = new Date();
    // An unknown or missing zone still gets the everywhere banners rather than
    // an empty strip: a customer who has not set an address yet is the common
    // case, not an error.
    const zone = isId(zoneId) ? String(zoneId) : null;
    const banners = await prisma.foodOfferBanner.findMany({
        where: {
            isActive: true,
            AND: [
                { OR: [{ startDate: null }, { startDate: { lte: now } }] },
                { OR: [{ endDate: null }, { endDate: { gte: now } }] },
                { OR: [{ zoneId: null }, ...(zone ? [{ zoneId: zone }] : [])] },
            ],
        },
        orderBy: ORDER,
    });
    // Deliberately fewer fields than the admin list: the scheduling dates are
    // already applied, so sending them would invite an app to apply them again
    // against its own clock.
    return {
        banners: banners.map((b) => ({
            id: b.id,
            imageUrl: b.imageUrl,
            title: b.title || '',
            ctaLink: b.ctaLink || '',
            sortOrder: b.sortOrder,
        })),
    };
};

export const createBanner = async (file, body = {}) => {
    if (!file?.buffer) throw new ValidationError('Banner image file is required');

    const startDate = toDate(body.startDate);
    const endDate = toDate(body.endDate, 'end');
    if (startDate && endDate && endDate < startDate) {
        throw new ValidationError('The end date cannot be before the start date');
    }

    const imageUrl = await uploadImageBuffer(file.buffer, FOLDER);
    if (!imageUrl) throw new ValidationError('Image upload failed');

    // Append to the end, so a new banner never silently jumps the queue.
    const last = await prisma.foodOfferBanner.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
    });

    const banner = await prisma.foodOfferBanner.create({
        data: {
            imageUrl,
            title: String(body.title || '').trim(),
            ctaLink: String(body.ctaLink || '').trim(),
            startDate,
            endDate,
            zoneId: toZoneId(body.zoneId),
            sortOrder: (last?.sortOrder ?? -1) + 1,
            isActive: body.isActive === undefined ? true : toActive(body.isActive),
        },
    });
    return serialize(banner);
};

export const updateBanner = async (id, body = {}, file = null) => {
    assertId(id);

    const existing = await prisma.foodOfferBanner.findUnique({ where: { id } });
    if (!existing) throw new ValidationError('Banner not found');

    const data = {};
    if (file?.buffer) {
        const imageUrl = await uploadImageBuffer(file.buffer, FOLDER);
        // A failed upload leaves the existing image alone rather than blanking it.
        if (imageUrl) data.imageUrl = imageUrl;
    }
    if (body.title !== undefined) data.title = String(body.title || '').trim();
    if (body.ctaLink !== undefined) data.ctaLink = String(body.ctaLink || '').trim();
    if (body.startDate !== undefined) data.startDate = toDate(body.startDate);
    if (body.endDate !== undefined) data.endDate = toDate(body.endDate, 'end');
    if (body.zoneId !== undefined) data.zoneId = toZoneId(body.zoneId);
    if (body.isActive !== undefined) data.isActive = toActive(body.isActive);

    // Checked against what the row will be, not only against what was sent:
    // moving just the start date must not step over an end date already stored.
    const start = data.startDate !== undefined ? data.startDate : existing.startDate;
    const end = data.endDate !== undefined ? data.endDate : existing.endDate;
    if (start && end && new Date(end) < new Date(start)) {
        throw new ValidationError('The end date cannot be before the start date');
    }

    return serialize(await prisma.foodOfferBanner.update({
        where: { id },
        data,
        include: { zone: { select: { name: true } } },
    }));
};

export const deleteBanner = async (id) => {
    assertId(id);
    const { count } = await prisma.foodOfferBanner.deleteMany({ where: { id } });
    if (!count) throw new ValidationError('Banner not found');
    return { deleted: true, id };
};

/** Switch one off without losing the artwork or its place in the order. */
export const toggleBannerStatus = async (id, isActive) => {
    assertId(id);
    const banner = await prisma.foodOfferBanner
        .update({ where: { id }, data: { isActive: toActive(isActive) } })
        .catch(() => null);
    if (!banner) throw new ValidationError('Banner not found');
    return serialize(banner);
};

/** Reorder by id list; position in the array becomes sortOrder. */
export const reorderBanners = async (ids) => {
    const list = Array.isArray(ids) ? ids.map(String) : [];
    if (list.length === 0) throw new ValidationError('banners must be a non-empty array of ids');
    list.forEach(assertId);

    // One transaction: a half-applied reorder leaves two banners claiming the
    // same position, and the order then depends on which row is read first.
    await prisma.$transaction(
        list.map((id, index) =>
            prisma.foodOfferBanner.updateMany({ where: { id }, data: { sortOrder: index } })
        )
    );
    return listBannersAdmin();
};
