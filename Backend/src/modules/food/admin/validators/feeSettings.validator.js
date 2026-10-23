import { z } from 'zod';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * A number the admin typed, bounded on both ends.
 *
 * `.finite()` is the load-bearing part. Every value here arrives as a string
 * and is put through Number(), and a number input accepts exponent notation --
 * so "102020202020e233" reaches this as Infinity. Zod rejects NaN but not
 * Infinity, and Infinity passes `.min(0)` happily, so on the fields that had no
 * ceiling it was being stored.
 *
 * Messages name their own field because the admin panel shows the first error
 * verbatim, and "Number must be less than or equal to 100" does not say which
 * box to go and fix.
 */
const bounded = (label, max, unit = '') =>
    z
        .number({ invalid_type_error: `${label} must be a number` })
        .finite(`${label} must be a real number`)
        .min(0, `${label} cannot be negative`)
        .max(max, `${label} cannot be more than ${max}${unit}`);

/** A rate out of a hundred. Above that it is a typo, not a tax. */
const percentage = (label) => bounded(label, 100, '%');

/**
 * A ceiling for the money fields, which had none at all.
 *
 * Not a business rule -- no real platform fee approaches it -- just far enough
 * out that a genuine setting can never reach it and a mistyped one always does.
 */
const MAX_AMOUNT = 100000;

/** Ranges are distances in kilometres. */
const MAX_DISTANCE_KM = 1000;

const rangeSchema = z.object({
    min: bounded('Range start', MAX_DISTANCE_KM, ' km'),
    max: bounded('Range end', MAX_DISTANCE_KM, ' km'),
    fee: bounded('Range delivery fee', MAX_AMOUNT),
    // The customer's per-km charge past the band start ("User ₹/km"). It was
    // missing here and from the mapping below, so it was dropped on every save.
    feePerKm: bounded('Per km delivery fee', MAX_AMOUNT).optional().default(0),
    deliveryBoyPerKm: bounded('Per km amount', MAX_AMOUNT).optional().default(0),
    deliveryBoyBasePay: bounded('Base pay', MAX_AMOUNT).optional().default(0)
});

const feeSettingsUpsertSchema = z.object({
    deliveryFee: bounded('Delivery fee', MAX_AMOUNT).nullable().optional(),
    deliveryFeeRanges: z.array(rangeSchema).optional(),
    platformFee: bounded('Platform fee', MAX_AMOUNT).nullable().optional(),
    quickDeliveryFee: bounded('Quick delivery extra', MAX_AMOUNT).nullable().optional(),
    gstRate: percentage('GST rate').nullable().optional(),
    deliveryFeeGstRate: percentage('Delivery fee GST rate').nullable().optional(),
    // The floor under a rider's earning for one trip; null removes it.
    riderMinPayPerTrip: bounded('Minimum rider pay', MAX_AMOUNT).nullable().optional(),
    // Which distance the fee is charged on; null inherits (global: road_capped).
    deliveryDistanceMode: z.enum(['road_capped', 'road', 'straight'], {
        errorMap: () => ({ message: 'Distance used for the fee must be road_capped, road or straight' }),
    }).nullable().optional(),
    roadDistanceCapFactor: z.number({ invalid_type_error: 'Road distance cap must be a number' })
        .min(1, 'Road distance cap must be at least 1')
        .max(5, 'Road distance cap must be at most 5')
        .nullable()
        .optional(),
    // Order limits for every zone (saved on the default row only): COD below
    // this total (null = ₹2000, 0 = no limit), and the most of one dish.
    codMaxOrderValue: bounded('Cash on Delivery limit', MAX_AMOUNT).nullable().optional(),
    maxItemQuantity: z.number({ invalid_type_error: 'Max quantity per item must be a number' })
        .int('Max quantity per item must be a whole number')
        .min(1, 'Max quantity per item must be at least 1')
        .max(999, 'Max quantity per item cannot be more than 999')
        .optional(),
    isActive: z.boolean().optional(),
    // Which zone these fees are for. Absent/null is the global default, which
    // is what every pre-zone caller means. Zod strips undeclared keys, so
    // without this the scope would be silently dropped and a zone edit would
    // overwrite the global row.
    zoneId: z.string().min(1).nullable().optional()
});

export const validateFeeSettingsUpsertDto = (body) => {
    const normalized = {
        deliveryFee:
            body?.deliveryFee === null
                ? null
                : body?.deliveryFee !== undefined
                    ? Number(body.deliveryFee)
                    : undefined,
        deliveryFeeRanges: Array.isArray(body?.deliveryFeeRanges)
            ? body.deliveryFeeRanges.map((r) => ({
                min: Number(r?.min),
                max: Number(r?.max),
                fee: Number(r?.fee),
                feePerKm: Number(r?.feePerKm || 0),
                deliveryBoyPerKm: Number(r?.deliveryBoyPerKm || 0),
                deliveryBoyBasePay: Number(r?.deliveryBoyBasePay || 0)
            }))
            : undefined,
        platformFee:
            body?.platformFee === null ? null : body?.platformFee !== undefined ? Number(body.platformFee) : undefined,
        quickDeliveryFee:
            body?.quickDeliveryFee === null
                ? null
                : body?.quickDeliveryFee !== undefined
                    ? Number(body.quickDeliveryFee)
                    : undefined,
        gstRate:
            body?.gstRate === null ? null : body?.gstRate !== undefined ? Number(body.gstRate) : undefined,
        deliveryFeeGstRate:
            body?.deliveryFeeGstRate === null
                ? null
                : body?.deliveryFeeGstRate !== undefined
                    ? Number(body.deliveryFeeGstRate)
                    : undefined,
        riderMinPayPerTrip:
            body?.riderMinPayPerTrip === null
                ? null
                : body?.riderMinPayPerTrip !== undefined
                    ? Number(body.riderMinPayPerTrip)
                    : undefined,
        deliveryDistanceMode:
            body?.deliveryDistanceMode === null || body?.deliveryDistanceMode === ''
                ? null
                : body?.deliveryDistanceMode !== undefined
                    ? String(body.deliveryDistanceMode)
                    : undefined,
        roadDistanceCapFactor:
            body?.roadDistanceCapFactor === null || body?.roadDistanceCapFactor === ''
                ? null
                : body?.roadDistanceCapFactor !== undefined
                    ? Number(body.roadDistanceCapFactor)
                    : undefined,
        codMaxOrderValue:
            body?.codMaxOrderValue === null || body?.codMaxOrderValue === ''
                ? null
                : body?.codMaxOrderValue !== undefined
                    ? Number(body.codMaxOrderValue)
                    : undefined,
        maxItemQuantity:
            body?.maxItemQuantity === null || body?.maxItemQuantity === '' || body?.maxItemQuantity === undefined
                ? undefined
                : Number(body.maxItemQuantity),
        isActive: body?.isActive !== undefined ? Boolean(body.isActive) : undefined,
        zoneId: body?.zoneId ? String(body.zoneId) : body?.zoneId === null ? null : undefined
    };

    const result = feeSettingsUpsertSchema.safeParse(normalized);
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }

    // Validate ranges: min < max, non-overlapping after sorting
    const ranges = Array.isArray(result.data.deliveryFeeRanges) ? result.data.deliveryFeeRanges : undefined;
    if (ranges) {
        const sorted = [...ranges].sort((a, b) => a.min - b.min);
        for (const r of sorted) {
            if (r.min >= r.max) {
                throw new ValidationError('Each range must have min less than max');
            }
        }
        for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1];
            const cur = sorted[i];
            if (cur.min < prev.max) {
                throw new ValidationError('Delivery fee ranges must not overlap');
            }
            // A gap had no price of its own and was quietly charged as the
            // longest band.
            if (Math.abs(cur.min - prev.max) > 0.001) {
                throw new ValidationError(
                    `Delivery fee ranges must not have gaps: nothing covers ${prev.max} km to ${cur.min} km`,
                );
            }
        }
        if (sorted.length && sorted[0].min > 0.001) {
            throw new ValidationError(
                `The first delivery fee range must start at 0 km (it starts at ${sorted[0].min} km)`,
            );
        }
        result.data.deliveryFeeRanges = sorted;
    }

    return result.data;
};

