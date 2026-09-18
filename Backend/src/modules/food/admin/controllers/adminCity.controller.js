import * as cityService from '../services/adminCity.service.js';

const send = (res, status, message, data) => res.status(status).json({ success: true, message, data });

export async function listCities(req, res, next) {
    try { return send(res, 200, 'Cities fetched', await cityService.listCities(req.query)); } catch (e) { next(e); }
}
export async function getCity(req, res, next) {
    try { return send(res, 200, 'City fetched', await cityService.getCity(req.params.id)); } catch (e) { next(e); }
}
export async function createCity(req, res, next) {
    try { return send(res, 201, 'City created', await cityService.createCity(req.body || {})); } catch (e) { next(e); }
}
export async function updateCity(req, res, next) {
    try { return send(res, 200, 'City updated', await cityService.updateCity(req.params.id, req.body || {})); } catch (e) { next(e); }
}
export async function deleteCity(req, res, next) {
    try { return send(res, 200, 'City deleted', await cityService.deleteCity(req.params.id)); } catch (e) { next(e); }
}
