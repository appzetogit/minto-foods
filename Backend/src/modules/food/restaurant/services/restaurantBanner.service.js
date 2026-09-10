import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';
import { saveVideoFile, buildPublicUrl, deleteStoredFile, MAX_VIDEO_MB } from '../../../../services/storage.service.js';
import { invalidateCache } from '../../../../middleware/cache.js';

const MAX_BANNERS = 10;
const MAX_GALLERY = 10;
// Fewer than photos on purpose: each one is megabytes, and a storefront that
// needs six clips to explain itself has a different problem.
const MAX_VIDEOS = 3;

/** Columns are text[] now, but older rows and clients still send { url } objects. */
const toUrl = (image) => {
    if (!image) return '';
    if (typeof image === 'string') return image.trim();
    return String(image.url || image.secure_url || '').trim();
};

const clean = (list) => (Array.isArray(list) ? list : []).map(toUrl).filter(Boolean);

const load = async (restaurantId, select) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const doc = await prisma.foodRestaurant.findUnique({ where: { id: restaurantId }, select });
    if (!doc) throw new ValidationError('Restaurant not found');
    return doc;
};

/** Banners are shown publicly, so refresh the cached restaurant reads after any change. */
const bustPublicCaches = () => {
    void invalidateCache('restaurants:*');
    void invalidateCache('restaurant_detail:*');
};

const save = async (restaurantId, data) => {
    await prisma.foodRestaurant.update({ where: { id: restaurantId }, data });
    bustPublicCaches();
};

export const listRestaurantBanners = async (restaurantId) => {
    const doc = await load(restaurantId, { coverImages: true });
    const banners = clean(doc.coverImages);
    return { banners, primaryBanner: banners[0] || null, maxBanners: MAX_BANNERS };
};

/** Main cover image + premises gallery (the photos the rider sees at pickup). */
export const getRestaurantMedia = async (restaurantId) => {
    const doc = await load(restaurantId, {
        coverImage: true, galleryImages: true, coverImages: true,
    });
    return {
        coverImage: toUrl(doc.coverImage) || clean(doc.coverImages)[0] || '',
        galleryImages: clean(doc.galleryImages),
        maxGalleryImages: MAX_GALLERY,
    };
};

/** Replace the single main cover image. */
export const uploadRestaurantCoverImage = async (restaurantId, file) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    if (!file?.buffer) throw new ValidationError('Cover image file is required');

    const url = await uploadImageBuffer(file.buffer, 'food/restaurants/cover');
    if (!url) throw new ValidationError('Image upload failed');

    await save(restaurantId, { coverImage: url });
    return { coverImage: url };
};

/**
 * Append images to one of the picture lists, capped.
 *
 * Uploading happens after the room check so a rejected batch costs no CDN
 * storage, and only the files that fit are sent.
 */
const appendImages = async (restaurantId, files, { column, folder, max, existing }) => {
    const valid = (Array.isArray(files) ? files : []).filter((f) => f?.buffer);
    if (valid.length === 0) throw new ValidationError('At least one image file is required');

    const room = max - existing.length;
    if (room <= 0) {
        throw new ValidationError(
            column === 'galleryImages'
                ? `Gallery limit reached (${max}). Delete one before uploading.`
                : `Banner limit reached (${max}). Delete one before uploading.`
        );
    }

    const uploaded = (
        await Promise.all(valid.slice(0, room).map((f) => uploadImageBuffer(f.buffer, folder)))
    ).filter(Boolean);

    const next = [...existing];
    for (const url of uploaded) if (!next.includes(url)) next.push(url);

    return { next: next.slice(0, max), uploaded, skipped: Math.max(0, valid.length - room) };
};

/** Append premises photos, capped at MAX_GALLERY. */
export const uploadRestaurantGalleryImages = async (restaurantId, files = []) => {
    const doc = await load(restaurantId, { galleryImages: true });

    const { next, uploaded, skipped } = await appendImages(restaurantId, files, {
        column: 'galleryImages',
        folder: 'food/restaurants/gallery',
        max: MAX_GALLERY,
        existing: clean(doc.galleryImages),
    });

    await save(restaurantId, { galleryImages: next });
    return { galleryImages: next, uploaded, skipped };
};

/**
 * Storefront videos.
 *
 * Stored as objects, not urls: a player needs the mime type to choose a
 * decoder and a poster frame to show before anyone presses play, and given
 * neither it renders a black rectangle. The path is what is kept -- urls are
 * signed per response and expire within the hour, so a stored one is a link
 * that works today and breaks tomorrow.
 */
const serializeVideo = (video) => {
    const storedPath = String(video?.path || '').trim();
    if (!storedPath) return null;
    return {
        path: storedPath,
        url: buildPublicUrl(storedPath),
        mimeType: String(video?.mimeType || ''),
        size: Number(video?.size) || 0,
        poster: video?.poster ? buildPublicUrl(String(video.poster)) : null,
    };
};

const readVideos = (list) =>
    (Array.isArray(list) ? list : []).map(serializeVideo).filter(Boolean);

export const listRestaurantVideos = async (restaurantId) => {
    const doc = await load(restaurantId, { videos: true });
    return { videos: readVideos(doc.videos), maxVideos: MAX_VIDEOS };
};

export const uploadRestaurantVideos = async (restaurantId, files = []) => {
    const doc = await load(restaurantId, { videos: true });
    const existing = Array.isArray(doc.videos) ? doc.videos : [];

    const room = MAX_VIDEOS - existing.length;
    if (room <= 0) {
        throw new ValidationError(`A restaurant can have at most ${MAX_VIDEOS} videos`);
    }
    if (!files.length) throw new ValidationError(`No video was uploaded (max ${MAX_VIDEO_MB}MB each)`);

    const saved = [];
    for (const file of files.slice(0, room)) {
        const stored = await saveVideoFile(file, 'food/restaurants/videos');
        saved.push({
            path: stored.path,
            mimeType: stored.mimeType,
            size: stored.size,
            poster: '',
        });
    }

    const videos = [...existing, ...saved];
    await save(restaurantId, { videos });

    return {
        videos: readVideos(videos),
        uploaded: saved.length,
        skipped: Math.max(0, files.length - saved.length),
    };
};

/**
 * Remove one video, by the path it was stored under.
 *
 * By path rather than url because a url carries a signature that differs
 * between responses -- matching on one would fail for a client holding a copy
 * fetched a moment earlier.
 */
export const deleteRestaurantVideo = async (restaurantId, videoPath) => {
    const doc = await load(restaurantId, { videos: true });
    const target = String(videoPath || '').trim();
    if (!target) throw new ValidationError('videoPath is required');

    const existing = Array.isArray(doc.videos) ? doc.videos : [];
    const found = existing.find((v) => String(v?.path) === target);
    if (!found) throw new ValidationError('Video not found for this restaurant');

    const videos = existing.filter((v) => String(v?.path) !== target);
    await save(restaurantId, { videos });

    // The row is the record; a file left behind is wasted storage but a row
    // pointing at a deleted file is a broken player, so the row goes first.
    await deleteStoredFile(target).catch(() => {});

    return { videos: readVideos(videos), deleted: target };
};

/** Remove one gallery photo by exact URL. */
export const deleteRestaurantGalleryImage = async (restaurantId, imageUrl) => {
    const doc = await load(restaurantId, { galleryImages: true });
    const url = String(imageUrl || '').trim();
    if (!url) throw new ValidationError('imageUrl is required');

    const existing = clean(doc.galleryImages);
    if (!existing.includes(url)) throw new ValidationError('Image not found in this gallery');

    const galleryImages = existing.filter((u) => u !== url);
    await save(restaurantId, { galleryImages });
    return { galleryImages, deleted: url };
};

/**
 * Append uploaded banner images.
 *
 * Deliberately does NOT touch `status`. The legacy /profile/cover-images route resets the
 * restaurant to 'pending', taking a live restaurant offline and forcing re-approval just
 * for changing a picture — that is not acceptable for routine banner edits.
 */
export const uploadRestaurantBanners = async (restaurantId, files = []) => {
    const doc = await load(restaurantId, { coverImages: true, profileImage: true });

    const { next, uploaded, skipped } = await appendImages(restaurantId, files, {
        column: 'coverImages',
        folder: 'food/restaurants/cover',
        max: MAX_BANNERS,
        existing: clean(doc.coverImages),
    });

    const data = { coverImages: next };
    // Only seed the logo if the restaurant genuinely has none — never overwrite one.
    if (!toUrl(doc.profileImage) && uploaded[0]) data.profileImage = uploaded[0];

    await save(restaurantId, data);
    return { banners: next, primaryBanner: next[0] || null, uploaded, skipped };
};

/** Remove one banner by its exact URL. */
export const deleteRestaurantBanner = async (restaurantId, bannerUrl) => {
    const doc = await load(restaurantId, { coverImages: true });
    const url = String(bannerUrl || '').trim();
    if (!url) throw new ValidationError('bannerUrl is required');

    const existing = clean(doc.coverImages);
    if (!existing.includes(url)) throw new ValidationError('Banner not found on this restaurant');

    const banners = existing.filter((b) => b !== url);
    await save(restaurantId, { coverImages: banners });
    return { banners, primaryBanner: banners[0] || null, deleted: url };
};

/**
 * Reorder banners. The first entry is the primary banner shown as the page header.
 * The payload must be a permutation of the current set — no additions, no omissions —
 * so a stale client can't silently drop a banner it never knew about.
 */
export const reorderRestaurantBanners = async (restaurantId, orderedUrls) => {
    const doc = await load(restaurantId, { coverImages: true });
    const existing = clean(doc.coverImages);

    const next = (Array.isArray(orderedUrls) ? orderedUrls : [])
        .map((u) => String(u || '').trim())
        .filter(Boolean);
    if (next.length === 0) throw new ValidationError('banners must be a non-empty array of URLs');

    const unknown = next.find((u) => !existing.includes(u));
    if (unknown) throw new ValidationError('Cannot reorder: one or more banners do not belong to this restaurant');
    if (new Set(next).size !== next.length) throw new ValidationError('Duplicate banners in the order');
    if (next.length !== existing.length) {
        throw new ValidationError(`Send all ${existing.length} banners in the desired order`);
    }

    await save(restaurantId, { coverImages: next });
    return { banners: next, primaryBanner: next[0] || null };
};
