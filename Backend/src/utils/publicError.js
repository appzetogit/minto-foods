/**
 * What an error is allowed to tell the person who caused it.
 *
 * The rider app's trip history once received a failed Prisma query verbatim:
 * the query's shape, a rider's internal id and the database's own complaint.
 * Errors the app raises on purpose -- "Invalid coupon code", "Not your order" --
 * are written for people and should reach them. Everything else is a bug or an
 * outage: the person gets a plain message and a reference, and the details go
 * to the server log where they can be used.
 */

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Text that only ever comes from inside the system. Checked on every error
 * response, because some controllers send `err.message` themselves -- and label
 * a database failure a 400 while doing it -- so a status code alone cannot be
 * trusted to mean "this message was written for a person".
 */
const INTERNAL_PATTERNS = [
    /prisma/i,
    /invocation/i,
    /Invalid `[^`]+`/,
    /\n\s*at .+:\d+:\d+/,                        // stack frames
    /\bat [\w$.<>]+ \(.*:\d+:\d+\)/,
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/,
    /relation "[^"]+" does not exist/i,
    /column "[^"]+" (of relation "[^"]+" )?does not exist/i,
    /violates (foreign key|unique|check|not-null) constraint/i,
    /syntax error at or near/i,
    /Unique constraint failed/i,
    /Cannot read propert(y|ies) of (undefined|null)/i,
    /is not a function\b/i,
    /is not defined\b/i,
    /Unexpected token .* in JSON|JSON at position \d+/i,
    /Converting circular structure/i,
    /Maximum call stack size exceeded/i,
    /\bSequelize|\bMongo(Server)?Error\b|\bE11000\b/,
];

export const looksInternal = (message) => {
    if (typeof message !== 'string' || !message) return false;
    return INTERNAL_PATTERNS.some((re) => re.test(message));
};

/** Prisma's known request errors that do have a plain meaning for a person. */
const PRISMA_MEANINGS = {
    P2002: { statusCode: 409, message: 'This already exists.' },
    P2025: { statusCode: 404, message: 'Not found.' },
    P2003: { statusCode: 409, message: 'This is still linked to other records.' },
};

/**
 * @returns {{ statusCode: number, message: string, internal: boolean }}
 *   `internal` is true when the real message was withheld and must be logged.
 */
export function toPublicError(err) {
    const name = String(err?.name || '');
    const message = typeof err?.message === 'string' ? err.message : '';

    if (name.startsWith('PrismaClient') || /^P\d{4}$/.test(String(err?.code || ''))) {
        const meaning = PRISMA_MEANINGS[err?.code];
        if (meaning) return { ...meaning, internal: true };
        return { statusCode: 500, message: GENERIC_ERROR_MESSAGE, internal: true };
    }

    const status = Number(err?.statusCode || err?.status);
    const intentional = Number.isInteger(status) && status >= 400 && status < 500;
    if (intentional && message && !looksInternal(message)) {
        return { statusCode: status, message, internal: false };
    }

    return {
        statusCode: intentional ? status : 500,
        message: GENERIC_ERROR_MESSAGE,
        internal: true,
    };
}
