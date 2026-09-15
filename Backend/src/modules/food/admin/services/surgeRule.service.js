import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { resolveSurgeFee } from '../../orders/services/order-pricing.service.js';

/**
 * Surge rules: a flat amount added to the delivery fee while one is running.
 *
 * Pricing resolves these itself on every quote, so nothing here is a source of
 * truth for what a customer pays -- this is only how an admin edits them.
 */

const ORDER = [{ isActive: 'desc' }, { createdAt: 'desc' }];

const serialize = (r) => ({
    id: r.id,
    label: r.label || '',
    surgeFee: Number(r.surgeFee),
    zoneId: r.zoneId || null,
    zoneName: r.zone?.name || null,
    startAt: r.startAt,
    endAt: r.endAt,
    isActive: r.isActive,
    // What an admin actually needs to know: is this charging money right now?
    isRunningNow: resolveSurgeFee([r]) > 0,
    createdAt: r.createdAt,
});

const assertId = (id) => {
    if (!isId(id)) throw new ValidationError('Invalid surge rule id');
};

const toZoneId = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw || raw === 'all' || raw === 'null') return null;
    if (!isId(raw)) throw new ValidationError('Invalid zone');
    return raw;
};

const toWhen = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw || raw === 'null') return null;
    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) throw new ValidationError('Dates must be valid, or left blank');
    return when;
};

const toFee = (value) => {
    const fee = Number(value);
    // Zero is not "no surge", it is a rule that does nothing while looking set.
    if (!Number.isFinite(fee) || fee <= 0) {
        throw new ValidationError('The surge amount must be more than 0');
    }
    return fee;
};

export const listSurgeRules = async () => {
    const rules = await prisma.foodSurgeRule.findMany({
        orderBy: ORDER,
        include: { zone: { select: { name: true } } },
    });
    return { rules: rules.map(serialize) };
};

export const createSurgeRule = async (body = {}) => {
    const startAt = toWhen(body.startAt);
    const endAt = toWhen(body.endAt);
    if (startAt && endAt && endAt <= startAt) {
        throw new ValidationError('The end time must be after the start time');
    }

    const rule = await prisma.foodSurgeRule.create({
        data: {
            label: String(body.label || '').trim(),
            surgeFee: toFee(body.surgeFee),
            zoneId: toZoneId(body.zoneId),
            startAt,
            endAt,
            isActive: body.isActive === undefined ? true : body.isActive !== false && body.isActive !== 'false',
        },
        include: { zone: { select: { name: true } } },
    });
    return serialize(rule);
};

export const updateSurgeRule = async (id, body = {}) => {
    assertId(id);
    const existing = await prisma.foodSurgeRule.findUnique({ where: { id } });
    if (!existing) throw new ValidationError('Surge rule not found');

    const data = {};
    if (body.label !== undefined) data.label = String(body.label || '').trim();
    if (body.surgeFee !== undefined) data.surgeFee = toFee(body.surgeFee);
    if (body.zoneId !== undefined) data.zoneId = toZoneId(body.zoneId);
    if (body.startAt !== undefined) data.startAt = toWhen(body.startAt);
    if (body.endAt !== undefined) data.endAt = toWhen(body.endAt);
    if (body.isActive !== undefined) data.isActive = body.isActive !== false && body.isActive !== 'false';

    // Checked against the row as it will be, so moving one end cannot step over
    // an edge that was already stored.
    const startAt = data.startAt !== undefined ? data.startAt : existing.startAt;
    const endAt = data.endAt !== undefined ? data.endAt : existing.endAt;
    if (startAt && endAt && new Date(endAt) <= new Date(startAt)) {
        throw new ValidationError('The end time must be after the start time');
    }

    return serialize(await prisma.foodSurgeRule.update({
        where: { id },
        data,
        include: { zone: { select: { name: true } } },
    }));
};

export const deleteSurgeRule = async (id) => {
    assertId(id);
    const { count } = await prisma.foodSurgeRule.deleteMany({ where: { id } });
    if (!count) throw new ValidationError('Surge rule not found');
    return { deleted: true, id };
};
