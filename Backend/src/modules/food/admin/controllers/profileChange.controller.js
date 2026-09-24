import { listProfileChanges, approveProfileChange, rejectProfileChange } from '../../restaurant/services/profileChange.service.js';

export async function listProfileChangesController(req, res, next) {
    try {
        return res.status(200).json({ success: true, message: 'Restaurant changes', data: await listProfileChanges(req.query) });
    } catch (error) { return next(error); }
}

export async function approveProfileChangeController(req, res, next) {
    try {
        const request = await approveProfileChange(req.params.id, req.user?.userId);
        return res.status(200).json({ success: true, message: 'Changes approved', data: { request } });
    } catch (error) { return next(error); }
}

export async function rejectProfileChangeController(req, res, next) {
    try {
        const request = await rejectProfileChange(req.params.id, req.user?.userId, req.body?.reason);
        return res.status(200).json({ success: true, message: 'Changes rejected', data: { request } });
    } catch (error) { return next(error); }
}
