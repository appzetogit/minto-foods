import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { hashAdminPassword } from '../../../../core/auth/adminPassword.util.js';
import {
    ADMIN_FULL_PERMISSIONS,
    isValidPermissionPayload,
    sanitizeAdminPermissions,
} from '../../../../constants/permissions.js';

/**
 * Sub-admin accounts, extracted from the 6,258-line admin.service.js.
 *
 * Two things about this file are load-bearing:
 *
 * The password is hashed here. Mongoose did it in a pre('save') hook that went
 * with the model, so a straight port would have written the plaintext the admin
 * typed into the password column. hashAdminPassword is the one implementation.
 *
 * Every read names its columns instead of asking for all of them, because the
 * default would include `password`. Mongoose had `.select('-password')` for the
 * same reason; Prisma has no negative select, so the safe list is explicit.
 */
const SUB_ADMIN_SELECT = {
    id: true, email: true, name: true, phone: true, profileImage: true,
    role: true, adminType: true, permissions: true,
    isActive: true, isDeleted: true, servicesAccess: true,
    createdById: true, updatedById: true, createdAt: true, updatedAt: true,
    cities: { select: { city: { select: { id: true, name: true } } } },
};

/** The assigned cities, flattened for the panel: cities [{id,name}] and cityIds. */
const withCities = (admin) => {
    if (!admin) return admin;
    const cities = (admin.cities || []).map((link) => link.city).filter(Boolean);
    return { ...admin, cities, cityIds: cities.map((c) => c.id) };
};

/**
 * Replaces the cities a sub-admin looks after. Unknown ids are refused rather
 * than skipped, so a stale form cannot silently leave someone with fewer cities.
 */
const setCities = async (tx, adminId, rawCityIds) => {
    if (rawCityIds === undefined) return;
    if (!Array.isArray(rawCityIds)) throw new ValidationError('cityIds must be a list');
    const cityIds = [...new Set(rawCityIds.map(String))];
    if (!cityIds.every(isId)) throw new ValidationError('Invalid city id');
    if (cityIds.length) {
        const found = await tx.foodCity.count({ where: { id: { in: cityIds } } });
        if (found !== cityIds.length) throw new ValidationError('One of those cities does not exist');
    }
    await tx.foodAdminCity.deleteMany({ where: { adminId } });
    if (cityIds.length) {
        await tx.foodAdminCity.createMany({ data: cityIds.map((cityId) => ({ adminId, cityId })) });
    }
};

const toEmail = (value) => String(value || '').trim().toLowerCase();

/** Sub-admins only, and only live ones unless the caller says otherwise. */
const subAdminWhere = (extra = {}) => ({ adminType: 'sub_admin', isDeleted: false, ...extra });

export async function createSubAdmin(payload = {}, actorId) {
    const email = toEmail(payload.email);
    const password = String(payload.password || '').trim();
    const name = String(payload.name || '').trim();

    if (!email || !password) throw new ValidationError('Email and password are required');

    try {
        return await prisma.$transaction(async (tx) => {
        const created = await tx.foodAdmin.create({
            data: {
                email,
                // Never the raw value: the hook that used to do this is gone.
                password: await hashAdminPassword(password),
                name,
                phone: String(payload.phone || '').trim(),
                role: 'ADMIN',
                adminType: 'sub_admin',
                // No permissions until an admin grants them.
                permissions: {},
                isActive: true,
                isDeleted: false,
                createdById: isId(actorId) ? String(actorId) : null,
                updatedById: isId(actorId) ? String(actorId) : null,
            },
            select: { id: true },
        });
        // No cities means the sub-admin sees nothing until one is assigned.
        await setCities(tx, created.id, payload.cityIds ?? []);
        return withCities(await tx.foodAdmin.findUnique({ where: { id: created.id }, select: SUB_ADMIN_SELECT }));
        });
    } catch (error) {
        // email is unique in the database, so the insert decides the race
        // rather than a lookup before it.
        if (error?.code === 'P2002') {
            throw new ValidationError('Admin with this email already exists');
        }
        throw error;
    }
}

export async function getSubAdmins(query = {}) {
    const where = { adminType: 'sub_admin' };
    if (query.includeDeleted !== 'true') where.isDeleted = false;
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;

    const search = String(query.search || '').trim();
    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        where.OR = [{ name: contains }, { email: contains }, { phone: contains }];
    }

    const items = await prisma.foodAdmin.findMany({
        where,
        select: SUB_ADMIN_SELECT,
        orderBy: { createdAt: 'desc' },
    });
    return { items: items.map(withCities) };
}

export async function getSubAdminById(id) {
    if (!isId(id)) throw new ValidationError('Invalid sub-admin id');

    const item = await prisma.foodAdmin.findFirst({
        where: { id: String(id), adminType: 'sub_admin' },
        select: SUB_ADMIN_SELECT,
    });
    if (!item) throw new ValidationError('Sub-admin not found');
    return withCities(item);
}

/**
 * Apply an update, but only to a live sub-admin.
 *
 * updateMany carries the adminType/isDeleted guard into the write itself, so a
 * super-admin's row can never be reached through these endpoints — a plain
 * update by id could.
 */
const updateSubAdmin = async (id, data, cityIds) => {
    if (!isId(id)) throw new ValidationError('Invalid sub-admin id');

    return prisma.$transaction(async (tx) => {
        const { count } = await tx.foodAdmin.updateMany({
            where: subAdminWhere({ id: String(id) }),
            data,
        });
        if (!count) throw new ValidationError('Sub-admin not found');
        await setCities(tx, String(id), cityIds);

        return withCities(await tx.foodAdmin.findUnique({ where: { id: String(id) }, select: SUB_ADMIN_SELECT }));
    });
};

export async function updateSubAdminProfile(id, payload = {}, actorId) {
    const data = { updatedById: isId(actorId) ? String(actorId) : null };
    if (payload.name !== undefined) data.name = String(payload.name || '').trim();
    if (payload.phone !== undefined) data.phone = String(payload.phone || '').trim();
    if (payload.email !== undefined) data.email = toEmail(payload.email);

    try {
        return await updateSubAdmin(id, data, payload.cityIds);
    } catch (error) {
        if (error?.code === 'P2002') {
            throw new ValidationError('Admin with this email already exists');
        }
        throw error;
    }
}

export async function updateSubAdminPermissions(id, rawPermissions = {}, actorId) {
    if (!isValidPermissionPayload(rawPermissions)) {
        throw new ValidationError('Invalid permissions payload');
    }

    return updateSubAdmin(id, {
        // Sanitised, not stored as sent: this decides what the account can reach.
        permissions: sanitizeAdminPermissions(rawPermissions),
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

export async function updateSubAdminStatus(id, isActive, actorId) {
    return updateSubAdmin(id, {
        isActive: Boolean(isActive),
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

/** Soft delete: the row stays for the audit trail, deactivated. */
export async function deleteSubAdmin(id, actorId) {
    return updateSubAdmin(id, {
        isDeleted: true,
        isActive: false,
        updatedById: isId(actorId) ? String(actorId) : null,
    });
}

export function getAdminPermissionCatalog() {
    return {
        actions: ['view', 'create', 'edit', 'delete', 'export'],
        sections: Object.keys(ADMIN_FULL_PERMISSIONS).map((section) => ({
            key: section,
            actions: ADMIN_FULL_PERMISSIONS[section],
        })),
    };
}
