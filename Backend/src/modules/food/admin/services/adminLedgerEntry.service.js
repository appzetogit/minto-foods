import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { isId } from '../../../../utils/helpers.js';
import { buildPublicUrl } from '../../../../services/storage.service.js';

/**
 * Income and expenses recorded by hand.
 *
 * The balance sheet is derived from the order ledger, which is right for
 * anything an order produced and useless for everything else -- rent, a fine, a
 * marketing spend, a recovery. Those had nowhere to go, so the sheet could never
 * be reconciled against the bank.
 *
 * These are reported *beside* the derived figures, never folded into them. A
 * "restaurant owes" number that quietly includes a hand-typed expense is a
 * number nobody can trace back to orders, and a figure nobody can trace is a
 * figure nobody trusts -- which is the same reason the settlement history
 * exists.
 */

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const serialize = (row) => ({
    id: row.id,
    _id: row.id,
    type: row.type,
    category: row.category || '',
    amount: money(row.amount),
    note: row.note || '',
    occurredAt: row.occurredAt,
    createdByAdminId: row.createdByAdminId || null,
    // Rebuilt from the stored path rather than kept: signed urls expire.
    attachmentUrl: row.attachmentPath ? buildPublicUrl(row.attachmentPath) : null,
    attachmentPath: row.attachmentPath || null,
    createdAt: row.createdAt,
});

/**
 * Read the amount, refusing anything that is not a real, positive figure.
 *
 * Direction is carried by `type`, so the amount is always positive: allowing a
 * negative expense would make an expense that is secretly income, and two ways
 * to say the same thing is two ways to get a total wrong.
 */
const readAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new ValidationError('Amount must be a number');
    if (amount <= 0) {
        throw new ValidationError('Amount must be more than zero — use the type to say which way it goes');
    }
    if (amount > 100000000) throw new ValidationError('That amount looks wrong');
    return money(amount);
};

/**
 * Read a date, treating a bare calendar date as a local one.
 *
 * `new Date('2026-09-30')` is midnight **UTC**, which in IST is half past five
 * on the morning of the 30th. Used as the end of a period that silently pulls
 * in the early hours of the next day and drops the last evening of this one --
 * a month total that is wrong by whatever happened in those hours.
 *
 * A date with a time in it is left alone: the caller has already said what they
 * meant.
 */
const readDate = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') {
        if (fallback) return fallback;
        throw new ValidationError('A date is required');
    }

    const raw = String(value).trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const date = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(raw);

    if (Number.isNaN(date.getTime())) throw new ValidationError('That date is not valid');
    return date;
};

/** Midnight at the start of the day after this one, in local time. */
const nextLocalDay = (date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);

const readType = (value) => {
    const type = String(value || '').trim().toLowerCase();
    if (type !== 'income' && type !== 'expense') {
        throw new ValidationError('Type must be income or expense');
    }
    return type;
};

/**
 * Entries in a period, with their totals.
 *
 * The window is inclusive of both ends by taking everything before the day
 * after `to`: the column carries a time of day, so `<= to` would silently drop
 * anything recorded later than midnight on the last day.
 */
export async function listLedgerEntries(query = {}) {
    const where = {};

    const from = query.from ? readDate(query.from) : null;
    const to = query.to ? readDate(query.to) : null;
    if (from || to) {
        where.occurredAt = {
            ...(from ? { gte: from } : {}),
            // The day after `to`, built by moving the calendar date rather than
            // adding 24 hours, so a DST change cannot shift the boundary.
            ...(to ? { lt: nextLocalDay(to) } : {}),
        };
    }
    if (query.type) where.type = readType(query.type);
    if (query.category) where.category = String(query.category).trim();

    const rows = await prisma.foodLedgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(Math.max(Number(query.limit) || 200, 1), 1000),
    });

    const entries = rows.map(serialize);
    const totalFor = (type) =>
        money(entries.filter((e) => e.type === type).reduce((sum, e) => sum + e.amount, 0));

    const income = totalFor('income');
    const expense = totalFor('expense');

    return {
        entries,
        totals: {
            income,
            expense,
            // Positive means the hand-recorded entries added money overall.
            net: money(income - expense),
        },
    };
}

export async function createLedgerEntry(body = {}, adminId = null) {
    const row = await prisma.foodLedgerEntry.create({
        data: {
            type: readType(body.type),
            amount: readAmount(body.amount),
            category: String(body.category || '').trim().slice(0, 80),
            note: String(body.note || '').trim().slice(0, 500),
            // Defaults to now, because most entries are recorded the day they
            // happen and asking twice for that is friction.
            occurredAt: readDate(body.occurredAt, new Date()),
            createdByAdminId: isId(adminId) ? String(adminId) : null,
            attachmentPath: String(body.attachmentPath || '').trim() || null,
        },
    });
    return { entry: serialize(row) };
}

export async function updateLedgerEntry(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Entry not found');

    const existing = await prisma.foodLedgerEntry.findUnique({ where: { id: String(id) } });
    if (!existing) throw new ValidationError('Entry not found');

    const data = {};
    if (body.type !== undefined) data.type = readType(body.type);
    if (body.amount !== undefined) data.amount = readAmount(body.amount);
    if (body.category !== undefined) data.category = String(body.category || '').trim().slice(0, 80);
    if (body.note !== undefined) data.note = String(body.note || '').trim().slice(0, 500);
    if (body.occurredAt !== undefined) data.occurredAt = readDate(body.occurredAt);
    if (body.attachmentPath !== undefined) {
        data.attachmentPath = String(body.attachmentPath || '').trim() || null;
    }

    const row = await prisma.foodLedgerEntry.update({ where: { id: existing.id }, data });
    return { entry: serialize(row) };
}

export async function deleteLedgerEntry(id) {
    if (!isId(id)) throw new ValidationError('Entry not found');

    const existing = await prisma.foodLedgerEntry.findUnique({ where: { id: String(id) } });
    if (!existing) throw new ValidationError('Entry not found');

    await prisma.foodLedgerEntry.delete({ where: { id: existing.id } });
    return { deleted: true };
}
