import { z } from 'zod';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    normalizeActiveDays,
    normalizeCustomerScope,
    normalizeDiscountType,
    parseClock,
} from '../../shared/offerRules.js';

const createOfferSchema = z.object({
    couponCode: z.string().min(1, 'Coupon code is required'),
    discountType: z.enum(['percentage', 'flat_price'], {
        errorMap: () => ({ message: 'Discount type must be percentage or flat' }),
    }).default('percentage'),
    discountValue: z.number({ invalid_type_error: 'Enter a discount value' }).positive('Discount value must be greater than 0'),
    customerScope: z.enum(['all', 'first_time', 'specific'], {
        errorMap: () => ({ message: 'Invalid customer scope' }),
    }).default('all'),
    customerIds: z.array(z.string()).optional(),
    restaurantScope: z.enum(['all', 'selected']).default('all'),
    restaurantId: z.string().optional(),
    restaurantIds: z.array(z.string()).optional(),
    endDate: z.string().optional().or(z.literal('')).or(z.undefined()),
    startDate: z.string().optional().or(z.literal('')).or(z.undefined()),
    minOrderValue: z.number().min(0, 'Minimum order cannot be negative').optional(),
    maxDiscount: z.number().min(0, 'Max discount cannot be negative').optional(),
    usageLimit: z.number().int('Total redemptions must be a whole number').min(0).optional(),
    perUserLimit: z.number().int('Redemptions per customer must be a whole number').min(0).optional(),
    isFirstOrderOnly: z.boolean().optional(),
    adminBearPercentage: z.number().min(0).max(100).optional(),
    restaurantBearPercentage: z.number().min(0).max(100).optional(),
    activeDays: z.array(z.number()).optional(),
    activeFromTime: z.string().optional(),
    activeToTime: z.string().optional(),
    newToRestaurantOnly: z.boolean().optional(),
});

const IST = '+05:30';

/**
 * A date from the form. A bare "YYYY-MM-DD" means that whole day in India, not
 * in UTC: the old UTC reading let a coupon "ending the 20th" run until 5:29am
 * on the 21st. A full timestamp is taken as given.
 */
const parseBound = (value, edge) => {
    if (!value) return undefined;
    const raw = String(value).trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(`${raw}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}${IST}`)
        : new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
};

const optionalNumber = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export const validateCreateOfferDto = (body) => {
    const hasTime = (v) => typeof v === 'string' && v.trim() !== '';
    const normalized = {
        ...body,
        couponCode: typeof body?.couponCode === 'string' ? body.couponCode.trim() : body?.couponCode,
        // Accepted in either spelling, handed on in Prisma's. The hyphenated
        // form used to reach Prisma unchanged, which rejected it: no flat or
        // first-order coupon could ever be created, by admin or restaurant.
        discountType: body?.discountType === undefined ? undefined : (normalizeDiscountType(body.discountType) ?? body.discountType),
        discountValue: Number(body?.discountValue),
        customerScope: body?.customerScope === undefined ? undefined : (normalizeCustomerScope(body.customerScope) ?? body.customerScope),
        restaurantScope: body?.restaurantScope,
        restaurantId: body?.restaurantId ? String(body.restaurantId) : undefined,
        restaurantIds: Array.isArray(body?.restaurantIds)
            ? body.restaurantIds.map((id) => String(id)).filter(Boolean)
            : undefined,
        customerIds: Array.isArray(body?.customerIds)
            ? body.customerIds.map((id) => String(id)).filter(Boolean)
            : undefined,
        endDate: body?.endDate ? String(body.endDate) : undefined,
        startDate: body?.startDate ? String(body.startDate) : undefined,
        minOrderValue: optionalNumber(body?.minOrderValue),
        maxDiscount: optionalNumber(body?.maxDiscount),
        usageLimit: optionalNumber(body?.usageLimit),
        perUserLimit: optionalNumber(body?.perUserLimit),
        isFirstOrderOnly: body?.isFirstOrderOnly !== undefined ? Boolean(body.isFirstOrderOnly) : undefined,
        adminBearPercentage: optionalNumber(body?.adminBearPercentage),
        restaurantBearPercentage: optionalNumber(body?.restaurantBearPercentage),
        activeDays: Array.isArray(body?.activeDays) ? body.activeDays.map(Number) : undefined,
        activeFromTime: hasTime(body?.activeFromTime) ? body.activeFromTime.trim() : undefined,
        activeToTime: hasTime(body?.activeToTime) ? body.activeToTime.trim() : undefined,
        newToRestaurantOnly: body?.newToRestaurantOnly !== undefined ? Boolean(body.newToRestaurantOnly) : undefined,
    };

    const result = createOfferSchema.safeParse(normalized);
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    const data = result.data;

    if (!/^[A-Z0-9]{3,20}$/i.test(data.couponCode)) {
        // The code is typed by customers on a phone keyboard: letters and digits
        // only, so there is no "SAVE-20" versus "SAVE20" to get wrong.
        throw new ValidationError('Coupon code must be 3-20 letters or numbers, with no spaces or symbols');
    }

    if (data.restaurantScope === 'selected') {
        const restaurantIds = [
            ...(data.restaurantIds || []),
            ...(data.restaurantId ? [data.restaurantId] : [])
        ];
        if (restaurantIds.length === 0 || restaurantIds.some((id) => !isId(id))) {
            throw new ValidationError('At least one valid restaurant is required for selected restaurant scope');
        }
    }

    const endDate = parseBound(data.endDate, 'end');
    if (endDate === null) throw new ValidationError('Invalid endDate');
    const startDate = parseBound(data.startDate, 'start');
    if (startDate === null) throw new ValidationError('Invalid startDate');
    if (endDate && startDate && endDate.getTime() <= startDate.getTime()) {
        throw new ValidationError('endDate must be after startDate');
    }
    if (endDate && endDate.getTime() <= Date.now()) {
        throw new ValidationError('endDate must be a future date');
    }

    const minOrderValue = data.minOrderValue ?? 0;
    let maxDiscount;
    if (data.discountType === 'percentage') {
        if (data.discountValue > 100) {
            throw new ValidationError('A percentage discount cannot be more than 100%');
        }
        // Zero used to be accepted here, and checkout reads a zero cap as no
        // cap at all -- "50% off, max ₹0" meant half off without limit.
        if (!(data.maxDiscount > 0)) {
            throw new ValidationError('Set a maximum discount for a percentage coupon');
        }
        maxDiscount = data.maxDiscount;
    } else {
        // A flat discount at or above the minimum order gives the food away:
        // ₹100 off with no minimum makes every order under ₹100 free.
        if (minOrderValue <= data.discountValue) {
            throw new ValidationError('For a flat discount, the minimum order must be more than the discount');
        }
    }

    // Zero means unlimited at checkout, so it is stored as no limit at all.
    const usageLimit = data.usageLimit > 0 ? data.usageLimit : null;
    const perUserLimit = data.perUserLimit > 0 ? data.perUserLimit : null;
    if (usageLimit && perUserLimit && perUserLimit > usageLimit) {
        throw new ValidationError('Redemptions per customer cannot exceed total redemptions');
    }

    if ((data.activeDays || []).some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new ValidationError('Choose valid days for the coupon');
    }
    const activeDays = normalizeActiveDays(data.activeDays);

    const from = data.activeFromTime;
    const to = data.activeToTime;
    if (Boolean(from) !== Boolean(to)) {
        throw new ValidationError('Set both a start and an end time, or neither');
    }
    if (from && (parseClock(from) === null || parseClock(to) === null)) {
        throw new ValidationError('Times must be in HH:mm format');
    }
    if (from && parseClock(from) === parseClock(to)) {
        throw new ValidationError('Start and end time cannot be the same');
    }

    const restaurantIds = data.restaurantScope === 'selected'
        ? [...new Set([
            ...(data.restaurantIds || []),
            ...(data.restaurantId ? [data.restaurantId] : [])
        ])]
        : [];
    const adminBearPercentage = data.adminBearPercentage ?? 100;
    const restaurantBearPercentage = data.restaurantBearPercentage ?? 0;
    if (Math.round((adminBearPercentage + restaurantBearPercentage) * 100) / 100 !== 100) {
        throw new ValidationError('Admin bear and restaurant bear must total 100%');
    }

    const customerIds = [...new Set((data.customerIds || []).filter(isId))];
    if (data.customerScope === 'specific' && customerIds.length === 0) {
        // Saving it anyway would create a coupon that nobody can redeem and
        // nothing explains -- the code would simply never work.
        throw new ValidationError('Choose at least one customer for a customer-specific coupon');
    }

    return {
        couponCode: data.couponCode.trim().toUpperCase(),
        // Only kept for the scope that reads it, so switching a coupon back
        // to everyone does not leave a stale allow-list behind it.
        customerIds: data.customerScope === 'specific' ? customerIds : [],
        discountType: data.discountType,
        discountValue: data.discountValue,
        customerScope: data.customerScope,
        restaurantScope: data.restaurantScope,
        restaurantId: restaurantIds[0],
        restaurantIds,
        endDate,
        startDate,
        minOrderValue,
        maxDiscount,
        usageLimit,
        perUserLimit,
        isFirstOrderOnly: data.isFirstOrderOnly,
        adminBearPercentage,
        restaurantBearPercentage,
        activeDays,
        activeFromTime: from || null,
        activeToTime: to || null,
        newToRestaurantOnly: data.newToRestaurantOnly === true,
    };
};

const cartVisibilitySchema = z.object({
    itemId: z.string().min(1, 'itemId is required'),
    showInCart: z.boolean()
});

export const validateUpdateOfferCartVisibilityDto = (body) => {
    const result = cartVisibilitySchema.safeParse(body || {});
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};
