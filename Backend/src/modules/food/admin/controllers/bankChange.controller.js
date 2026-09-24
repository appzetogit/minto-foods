import { listBankChanges, approveBankChange, rejectBankChange } from '../../restaurant/services/bankChange.service.js';

export async function listBankChangesController(req, res, next) {
    try {
        return res.status(200).json({ success: true, message: 'Bank change requests', data: await listBankChanges(req.query) });
    } catch (error) { return next(error); }
}

export async function approveBankChangeController(req, res, next) {
    try {
        const request = await approveBankChange(req.params.id, req.user?.userId);
        return res.status(200).json({ success: true, message: 'Bank details approved', data: { request } });
    } catch (error) { return next(error); }
}

export async function rejectBankChangeController(req, res, next) {
    try {
        const request = await rejectBankChange(req.params.id, req.user?.userId, req.body?.reason);
        return res.status(200).json({ success: true, message: 'Bank change rejected', data: { request } });
    } catch (error) { return next(error); }
}
