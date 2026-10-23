import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';

const normalizeLabel = (label) => {
    const v = String(label || '').trim().toLowerCase();
    if (v === 'home' || v === 'house' || v === 'flat') return 'Home';
    if (v === 'office' || v === 'work') return 'Office';
    return 'Other';
};

/**
 * The customer's own name for an address ("Mom's house"), or null.
 *
 * The app sends label "Other" with customLabel. An older build that put the
 * name in label itself ("Mom's house" folds to Other) keeps the name too.
 */
const toCustomLabel = (dto) => {
    if (dto.customLabel !== undefined && dto.customLabel !== null) {
        return String(dto.customLabel).trim().slice(0, 40) || null;
    }
    const raw = String(dto.label || '').trim();
    if (raw && normalizeLabel(raw) === 'Other' && raw.toLowerCase() !== 'other') return raw.slice(0, 40);
    return null;
};

const coords = ({ latitude, longitude }) => {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return {};
    // Only the plain coordinates are written; the PostGIS point is derived by
    // the user_address_location_sync trigger.
    return { latitude: lat, longitude: lng };
};

/** Newest last, so "promote the last one" keeps meaning what it did. */
const BY_AGE = [{ createdAt: 'asc' }];

const requireOwnedAddress = async (userId, addressId) => {
    if (!isId(addressId)) throw new ValidationError('Invalid address id');

    const address = await prisma.userAddress.findFirst({
        where: { id: String(addressId), userId: String(userId) },
    });
    // Ownership is part of the lookup, so another user's id reads as "not found"
    // rather than leaking that it exists.
    if (!address) throw new ValidationError('Address not found');
    return address;
};

export const listAddresses = async (userId) => {
    const rows = await prisma.userAddress.findMany({
        where: { userId: String(userId) },
        orderBy: BY_AGE,
    });
    return { addresses: rows.map((address) => normalizeDeliveryAddress(address)) };
};

/** Trimmed, case- and whitespace-insensitive, for comparing two addresses. */
const addressKeyPart = (value) =>
    String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const addressKey = (address) =>
    [
        normalizeLabel(address.label),
        addressKeyPart(address.street),
        // Included so two flats in one building stay two addresses.
        addressKeyPart(address.additionalDetails),
        addressKeyPart(address.city),
        addressKeyPart(address.state),
        addressKeyPart(address.zipCode),
    ].join('|');

/**
 * An address this customer has already saved for the same place, or null.
 *
 * Compared in JS rather than as a query: a customer has a handful of addresses,
 * and the normalisation (case, stray whitespace) is the whole point -- a SQL
 * equality check would miss "17/C , Indore" against "17/C, Indore".
 */
const findDuplicateAddress = async (userId, dto) => {
    const existing = await prisma.userAddress.findMany({ where: { userId }, orderBy: BY_AGE });
    const key = addressKey(dto);
    return existing.find((address) => addressKey(address) === key) || null;
};

export const addAddress = async (userId, dto) => {
    const user = await prisma.foodUser.findUnique({
        where: { id: String(userId) },
        select: { id: true },
    });
    if (!user) throw new ValidationError('User not found');

    const existingDefault = await prisma.userAddress.count({
        where: { userId: user.id, isDefault: true },
    });

    // Adding used to overwrite any existing address carrying the same label, on
    // the theory that a customer wants one Home and one Office. With only three
    // labels that capped everyone at three addresses and silently destroyed the
    // old one — saving a second "Other" wiped the first with no warning. Adding
    // now always adds; editing an address is what PATCH is for.
    //
    // The exception is an address that is the same *place*, not merely the same
    // label: saving one twice left two identical rows in the list with no way
    // to tell them apart. Keyed on the whole address, so "Other" in Indore and
    // "Other" in Bhiwandi still both save.
    const duplicate = await findDuplicateAddress(user.id, dto);
    if (duplicate) {
        // The same place saved again under a new name keeps the new name.
        const name = toCustomLabel(dto);
        if (name && name !== duplicate.customLabel) {
            const renamed = await prisma.userAddress.update({ where: { id: duplicate.id }, data: { customLabel: name } });
            return { address: normalizeDeliveryAddress(renamed) };
        }
        return { address: normalizeDeliveryAddress(duplicate) };
    }

    const address = await prisma.userAddress.create({
        data: {
            userId: user.id,
            label: normalizeLabel(dto.label),
            customLabel: toCustomLabel(dto),
            street: dto.street,
            additionalDetails: dto.additionalDetails || '',
            city: dto.city,
            state: dto.state,
            zipCode: dto.zipCode || '',
            phone: dto.phone || '',
            ...coords(dto),
            // The first address a customer saves becomes their default.
            isDefault: existingDefault === 0,
        },
    });

    return { address: normalizeDeliveryAddress(address) };
};

export const updateAddress = async (userId, addressId, dto) => {
    const existing = await requireOwnedAddress(userId, addressId);

    const data = {};
    if (dto.label !== undefined) data.label = normalizeLabel(dto.label);
    // Home and Office carry no name of their own; an Other keeps or gets one.
    if (dto.customLabel !== undefined || dto.label !== undefined) {
        const label = data.label ?? existing.label;
        if (label !== 'Other') {
            data.customLabel = null;
        } else if (dto.customLabel !== undefined) {
            data.customLabel = toCustomLabel(dto);
        } else {
            // Only a label was sent: a free-text one renames, plain "Other" keeps the name.
            const fromLabel = toCustomLabel(dto);
            if (fromLabel) data.customLabel = fromLabel;
        }
    }
    if (dto.street !== undefined) data.street = dto.street;
    if (dto.additionalDetails !== undefined) data.additionalDetails = dto.additionalDetails || '';
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.state !== undefined) data.state = dto.state;
    if (dto.zipCode !== undefined) data.zipCode = dto.zipCode || '';
    if (dto.phone !== undefined) data.phone = dto.phone || '';
    Object.assign(data, coords(dto));

    const address = await prisma.userAddress.update({ where: { id: existing.id }, data });
    return { address: normalizeDeliveryAddress(address) };
};

export const deleteAddress = async (userId, addressId) => {
    const existing = await requireOwnedAddress(userId, addressId);

    await prisma.$transaction(async (tx) => {
        await tx.userAddress.delete({ where: { id: existing.id } });

        // Deleting the default would leave the customer with none, so promote the
        // newest survivor. Inside the transaction, since the partial unique index
        // permits exactly one default per user.
        if (existing.isDefault) {
            const newest = await tx.userAddress.findFirst({
                where: { userId: String(userId) },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
            });
            if (newest) {
                await tx.userAddress.update({ where: { id: newest.id }, data: { isDefault: true } });
            }
        }
    });

    return { success: true };
};

export const setDefaultAddress = async (userId, addressId) => {
    const existing = await requireOwnedAddress(userId, addressId);

    const address = await prisma.$transaction(async (tx) => {
        // Clear first. The partial unique index allows only one default per user,
        // so setting before clearing would collide with the incumbent.
        await tx.userAddress.updateMany({
            where: { userId: String(userId), isDefault: true },
            data: { isDefault: false },
        });
        return tx.userAddress.update({ where: { id: existing.id }, data: { isDefault: true } });
    });

    return { address: normalizeDeliveryAddress(address) };
};
