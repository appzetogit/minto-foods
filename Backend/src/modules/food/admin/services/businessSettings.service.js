import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { uploadImageBufferDetailed } from '../../../../services/cloudinary.service.js';

/**
 * The platform's own identity: company details, the three apps' logos, their
 * theme, and how long a restaurant has to accept an order.
 *
 * One row, all flat columns with defaults. The Mongo version stored `phone`,
 * each logo and the whole `powerScanning` block as sub-documents, which is why
 * every read used to repair rows that were missing them; a column with a
 * default cannot be missing, so all of that is gone.
 */

const FONT_OPTIONS = [
    'Poppins', 'Outfit', 'Inter', 'Roboto', 'Montserrat',
    'Nunito', 'Open Sans', 'Lato', 'Manrope', 'Raleway',
    'Merriweather', 'Playfair Display', 'Ubuntu', 'Rubik', 'Work Sans',
];

/** The three apps, and the column prefix each one's theme lives under. */
const APPS = ['user', 'restaurant', 'delivery'];

/** Each upload field, and the columns plus Cloudinary folder it maps to. */
const IMAGE_FIELDS = {
    logo: { url: 'logoUrl', publicId: 'logoPublicId', folder: 'business/logos' },
    favicon: { url: 'faviconUrl', publicId: 'faviconPublicId', folder: 'business/favicons' },
    restaurantLogo: {
        url: 'restaurantLogoUrl', publicId: 'restaurantLogoPublicId',
        folder: 'business/restaurant/logos',
    },
    restaurantFavicon: {
        url: 'restaurantFaviconUrl', publicId: 'restaurantFaviconPublicId',
        folder: 'business/restaurant/favicons',
    },
    deliveryLogo: {
        url: 'deliveryLogoUrl', publicId: 'deliveryLogoPublicId',
        folder: 'business/delivery/logos',
    },
    deliveryFavicon: {
        url: 'deliveryFaviconUrl', publicId: 'deliveryFaviconPublicId',
        folder: 'business/delivery/favicons',
    },
};

const normalizeHexColor = (value, fallback) => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const normalized = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : fallback;
};

const normalizeFontFamily = (value, fallback) => {
    const raw = String(value || '').trim();
    return FONT_OPTIONS.includes(raw) ? raw : fallback;
};

/** The apps read one nested block; the columns are flat. */
const toPowerScanning = (row) => Object.fromEntries(
    APPS.map((app) => [app, {
        themeColor: row[`${app}ThemeColor`],
        fontFamily: row[`${app}FontFamily`],
    }])
);

/** The panel still expects the sub-document shape Mongo used. */
const serialize = (row) => ({
    ...row,
    _id: row.id,
    phone: { countryCode: row.phoneCountryCode, number: row.phoneNumber },
    logo: { url: row.logoUrl, publicId: row.logoPublicId },
    favicon: { url: row.faviconUrl, publicId: row.faviconPublicId },
    restaurantLogo: { url: row.restaurantLogoUrl, publicId: row.restaurantLogoPublicId },
    restaurantFavicon: { url: row.restaurantFaviconUrl, publicId: row.restaurantFaviconPublicId },
    deliveryLogo: { url: row.deliveryLogoUrl, publicId: row.deliveryLogoPublicId },
    deliveryFavicon: { url: row.deliveryFaviconUrl, publicId: row.deliveryFaviconPublicId },
    powerScanning: toPowerScanning(row),
    // Decimal reaches JSON as a string, and the screen puts it straight into a
    // number input that then compares it as text.
    discoveryRadiusKm: row.discoveryRadiusKm == null ? null : Number(row.discoveryRadiusKm),
});

/** The settings row, created on first read. There is only ever one. */
const loadRow = async () =>
    (await prisma.foodBusinessSettings.findFirst()) ?? prisma.foodBusinessSettings.create({ data: {} });

export const getBusinessSettings = async () => serialize(await loadRow());

export const getPowerScanningSettings = async () => toPowerScanning(await loadRow());

export const updatePowerScanningSettings = async (payload = {}) => {
    const row = await loadRow();

    // Anything unrecognised keeps the colour or font already saved, so a partial
    // or malformed post cannot reset an app's branding.
    const data = {};
    for (const app of APPS) {
        data[`${app}ThemeColor`] = normalizeHexColor(payload?.[app]?.themeColor, row[`${app}ThemeColor`]);
        data[`${app}FontFamily`] = normalizeFontFamily(payload?.[app]?.fontFamily, row[`${app}FontFamily`]);
    }

    const updated = await prisma.foodBusinessSettings.update({ where: { id: row.id }, data });
    return toPowerScanning(updated);
};

/** The restaurant's new-order accept time, in seconds; minutes kept for older admin builds. */
// ─── Pausing orders ─────────────────────────────────────────────────────────

const DEFAULT_PAUSE_MESSAGE = 'We are not taking orders right now. Please try again a little later.';

const pausePayload = (row) => {
    const until = row?.ordersPausedUntil ? new Date(row.ordersPausedUntil) : null;
    const active = Boolean(row?.ordersPaused) && (!until || until.getTime() > Date.now());
    return {
        paused: Boolean(row?.ordersPaused),
        active,
        zoneIds: Array.isArray(row?.ordersPausedZoneIds) ? row.ordersPausedZoneIds : [],
        message: row?.ordersPausedMessage || '',
        until,
    };
};

export const getOrderPause = async () => pausePayload(await loadRow());

/**
 * Turn ordering off (all zones, or the zones given) or back on. While paused,
 * pricing and placing an order are refused with the message. Nothing else is
 * touched: restaurants keep their own on/off, and orders already placed go on.
 */
export const updateOrderPause = async ({ paused, zoneIds, message, until } = {}) => {
    const on = paused === true || paused === 'true';
    const ids = Array.isArray(zoneIds) ? [...new Set(zoneIds.map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)))] : [];
    const text = String(message || '').trim().slice(0, 300);
    let resume = null;
    if (on && until) {
        resume = new Date(until);
        if (Number.isNaN(resume.getTime())) throw new ValidationError('Invalid resume time');
        if (resume.getTime() <= Date.now()) throw new ValidationError('The resume time must be in the future');
    }
    const row = await loadRow();
    const updated = await prisma.foodBusinessSettings.update({
        where: { id: row.id },
        data: {
            ordersPaused: on,
            ordersPausedZoneIds: on ? ids : [],
            ordersPausedMessage: on ? text : '',
            ordersPausedUntil: on ? resume : null,
        },
    });
    return pausePayload(updated);
};

/**
 * Refuse an order while ordering is paused for its zone. Called by pricing,
 * so the cart shows the message before the customer reaches Place Order.
 */
export const assertOrderingNotPaused = async (zoneIds = []) => {
    const pause = pausePayload(await prisma.foodBusinessSettings.findFirst({
        select: { ordersPaused: true, ordersPausedZoneIds: true, ordersPausedMessage: true, ordersPausedUntil: true },
    }));
    if (!pause.active) return;
    const zones = (Array.isArray(zoneIds) ? zoneIds : [zoneIds]).filter(Boolean).map(String);
    const hit = !pause.zoneIds.length || zones.some((z) => pause.zoneIds.includes(z));
    if (hit) throw new ValidationError(pause.message || DEFAULT_PAUSE_MESSAGE);
};

export const MIN_ACCEPT_SECONDS = 30;
export const MAX_ACCEPT_SECONDS = 600;

const acceptancePayload = (row) => {
    const seconds = Number.isInteger(row?.orderAcceptanceTimeSeconds)
        ? row.orderAcceptanceTimeSeconds
        : (Number(row?.orderAcceptanceTimeMinutes) || 4) * 60;
    return {
        orderAcceptanceTimeSeconds: seconds,
        acceptanceWindowSeconds: seconds,
        orderAcceptanceTimeMinutes: Math.max(1, Math.round(seconds / 60)),
    };
};

export const getOrderAcceptanceSettings = async () => acceptancePayload(await loadRow());

/**
 * Saves the accept time. Seconds (30-600) from the current admin panel, or
 * whole minutes (1-20) from an older one.
 */
export const updateOrderAcceptanceSettings = async ({ seconds: rawSeconds, minutes: rawMinutes } = {}) => {
    let seconds;
    if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== '') {
        seconds = Math.round(Number(rawSeconds));
        if (!Number.isFinite(seconds) || seconds < MIN_ACCEPT_SECONDS || seconds > MAX_ACCEPT_SECONDS) {
            throw new ValidationError(`Restaurant accept time must be between ${MIN_ACCEPT_SECONDS} and ${MAX_ACCEPT_SECONDS} seconds`);
        }
    } else {
        const minutes = Math.round(Number(rawMinutes));
        if (!Number.isFinite(minutes)) throw new ValidationError('Order acceptance time is required');
        if (minutes < 1 || minutes > 10) {
            throw new ValidationError('Order acceptance time must be between 1 and 10 minutes');
        }
        seconds = minutes * 60;
    }

    const row = await loadRow();
    const updated = await prisma.foodBusinessSettings.update({
        where: { id: row.id },
        data: {
            orderAcceptanceTimeSeconds: seconds,
            orderAcceptanceTimeMinutes: Math.max(1, Math.round(seconds / 60)),
        },
    });
    return acceptancePayload(updated);
};

const validate = ({ companyName, email, phoneNumber, address, state, pincode }) => {
    const name = String(companyName || '').trim();
    if (name.length < 2 || name.length > 50) {
        throw new ValidationError('Company name must be between 2 and 50 characters');
    }
    const mail = String(email || '').trim();
    if (!mail || mail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
        throw new ValidationError('Invalid email address (max 100 characters)');
    }
    if (!/^\d{7,15}$/.test(String(phoneNumber || '').trim())) {
        throw new ValidationError('Invalid phone number (7-15 digits required)');
    }
    if (address && String(address).length > 250) {
        throw new ValidationError('Address is too long (max 250 characters)');
    }
    if (state && String(state).length > 50) {
        throw new ValidationError('State name is too long (max 50 characters)');
    }
    if (pincode && !/^\d{4,10}$/.test(String(pincode).trim())) {
        throw new ValidationError('Invalid pincode (4-10 digits required)');
    }
};

export const updateBusinessSettings = async (body = {}, files = null) => {
    validate(body);

    const data = {
        companyName: String(body.companyName).trim(),
        email: String(body.email).trim(),
        phoneNumber: String(body.phoneNumber).trim(),
    };
    if (body.phoneCountryCode) data.phoneCountryCode = String(body.phoneCountryCode).trim();
    if (body.address !== undefined) data.address = String(body.address || '');
    if (body.state !== undefined) data.state = String(body.state || '');
    if (body.pincode !== undefined) data.pincode = String(body.pincode || '');
    if (body.region) data.region = String(body.region);

    // Blank clears the limit. Zero is refused rather than stored: it would read
    // as "no restaurant is within range" and empty the app for everyone.
    if (body.discoveryRadiusKm !== undefined) {
        const raw = body.discoveryRadiusKm;
        if (raw === null || String(raw).trim() === '') {
            data.discoveryRadiusKm = null;
        } else {
            const km = Number(raw);
            if (!Number.isFinite(km) || km <= 0) {
                throw new ValidationError('Delivery radius must be a number above 0, or blank for no limit');
            }
            data.discoveryRadiusKm = km;
        }
    }

    // Days of warning before a banner or coupon ends, 1-30.
    if (body.expiryAlertDays !== undefined && String(body.expiryAlertDays).trim() !== '') {
        const days = Number(body.expiryAlertDays);
        if (!Number.isInteger(days) || days < 1 || days > 30) {
            throw new ValidationError('Expiry alert must be a whole number of days from 1 to 30');
        }
        data.expiryAlertDays = days;
    }

    // Uploaded one at a time on purpose: six parallel uploads of the same
    // multipart request is a lot of outbound bandwidth for a settings save.
    for (const [field, columns] of Object.entries(IMAGE_FIELDS)) {
        const file = files?.[field]?.[0];
        if (!file?.buffer) continue;

        const result = await uploadImageBufferDetailed(file.buffer, columns.folder);
        data[columns.url] = result.secure_url;
        data[columns.publicId] = result.public_id;
    }

    const row = await loadRow();
    return serialize(await prisma.foodBusinessSettings.update({ where: { id: row.id }, data }));
};
