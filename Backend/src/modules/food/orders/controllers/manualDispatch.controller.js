import { ForbiddenError, ValidationError } from '../../../../core/auth/errors.js';
import { isId } from '../../../../utils/helpers.js';
import { updateDispatchSettings } from '../services/order-dispatch.service.js';
import {
    assignRiderManually,
    listEligibleRiders,
    listManualQueue,
    listZoneDispatchModes,
    setZoneDispatchMode,
    withdrawManualAssignment,
} from '../services/manualDispatch.service.js';

const ok = (res, data, message = 'OK') => res.status(200).json({ success: true, message, data });
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const requireId = (v, label) => {
    if (!isId(v)) throw new ValidationError(`Invalid ${label}`);
    return String(v);
};

/** Global mode + every zone's own mode. */
export const getDispatchSettings = wrap(async (req, res) => ok(res, await listZoneDispatchModes()));

/** The platform-wide default: super admin only. */
export const updateGlobalDispatch = wrap(async (req, res) => {
    if (req.adminScope) throw new ForbiddenError('Only the super admin can change the platform-wide dispatch mode');
    const body = req.body || {};
    if (!['auto', 'manual'].includes(body.dispatchMode)) throw new ValidationError('Choose automatic or manual');
    await updateDispatchSettings(body.dispatchMode, req.user?.userId, body);
    ok(res, await listZoneDispatchModes(), 'Dispatch settings updated');
});

/** One zone: 'auto', 'manual' or null (follow the platform default). City admins: their zones only. */
export const updateZoneDispatch = wrap(async (req, res) => {
    const mode = req.body?.dispatchMode ?? null;
    if (![null, 'auto', 'manual'].includes(mode)) throw new ValidationError('Choose default, automatic or manual');
    ok(res, await setZoneDispatchMode(requireId(req.params.zoneId, 'zone'), mode), 'Zone dispatch mode updated');
});

export const getQueue = wrap(async (req, res) => ok(res, await listManualQueue()));

export const getEligibleRiders = wrap(async (req, res) =>
    ok(
        res,
        await listEligibleRiders(requireId(req.params.id, 'order'), {
            includeOffline: ['1', 'true'].includes(String(req.query.includeOffline || '')),
        }),
    ),
);

export const assignRider = wrap(async (req, res) => {
    const body = req.body || {};
    const result = await assignRiderManually(
        requireId(req.params.id, 'order'),
        requireId(body.deliveryPartnerId, 'rider'),
        req.user?.userId,
        { force: body.force === true, reason: body.reason || '' },
    );
    ok(res, result, `Assigned to ${result.assignedTo.name}. Waiting for them to accept.`);
});

export const unassignRider = wrap(async (req, res) =>
    ok(res, await withdrawManualAssignment(requireId(req.params.id, 'order'), req.user?.userId), 'Assignment cancelled'),
);
