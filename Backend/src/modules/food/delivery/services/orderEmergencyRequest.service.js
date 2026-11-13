import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import * as dispatchService from '../../orders/services/order-dispatch.service.js';
import { buildOrderIdentityFilter, notifyOwnersSafely } from '../../orders/services/order.helpers.js';

const ACTIVE_REQUEST_STATUSES = ['open', 'in_progress'];
const PRE_PICKUP_ORDER_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'reached_pickup'];
const POST_PICKUP_PHASES = ['en_route_to_delivery', 'at_drop', 'delivered', 'completed'];
/** Orders a rider can be taken off and the order handed out again: accepted by the restaurant, not yet delivered. */
const REASSIGNABLE_ORDER_STATUSES = [...PRE_PICKUP_ORDER_STATUSES, 'picked_up', 'reached_drop'];

/** Works on a raw Prisma order row (flat columns). */
const isBeforePickup = (row) =>
    PRE_PICKUP_ORDER_STATUSES.includes(String(row?.orderStatus || '')) &&
    !row?.pickedUpAt &&
    !POST_PICKUP_PHASES.includes(String(row?.deliveryPhase || ''));

/** The relations the old populateRequest() pulled in. */
const requestInclude = {
    order: {
        select: {
            id: true, order_id: true, orderId: true, orderStatus: true,
            dispatchStatus: true, dispatchDeliveryPartnerId: true,
            deliveryPhase: true, pickedUpAt: true, total: true,
            createdAt: true, updatedAt: true,
        },
    },
    deliveryPartner: {
        select: { id: true, name: true, phone: true, email: true, vehicleType: true, vehicleNumber: true },
    },
    restaurant: {
        select: {
            id: true, restaurantName: true, ownerPhone: true, addressLine1: true,
            area: true, city: true, latitude: true, longitude: true,
        },
    },
    resolvedBy: { select: { id: true, name: true, email: true } },
};

/**
 * Mongoose populate replaced the id field with the document, and callers read
 * both shapes. Prisma puts relations in their own keys, so expose them under the
 * names the API already returns.
 */
const serializeRequest = (request) => {
    if (!request) return null;
    return {
        ...request,
        order: request.order || undefined,
        deliveryPartner: request.deliveryPartner || undefined,
        restaurant: request.restaurant || undefined,
    };
};

async function deassignOrderForRedispatch({
    orderIdentity,
    deliveryPartnerId,
    adminId,
    requestId = null,
    reason,
    historyNote,
}) {
    const identity = buildOrderIdentityFilter(orderIdentity);
    if (!identity) throw new ValidationError('Order id required');

    const existingOrder = await prisma.foodOrder.findFirst({ where: identity });
    if (!existingOrder) throw new NotFoundError('Order not found');

    // Reassigning works at every stage until the food is delivered: offered and
    // not yet accepted, accepted, an outside rider, and after pickup too. It used
    // to work only between a rider accepting and picking up, so a rider who
    // vanished with the food, or an outside rider, could not be replaced at all.
    if (existingOrder.orderStatus === 'delivered') {
        throw new ValidationError('This order is already delivered');
    }
    if (String(existingOrder.orderStatus).startsWith('cancelled')) {
        throw new ValidationError('This order is cancelled');
    }
    if (!REASSIGNABLE_ORDER_STATUSES.includes(existingOrder.orderStatus)) {
        throw new ValidationError('The restaurant has not accepted this order yet, so there is no rider to replace');
    }

    const assignedPartnerId = existingOrder.dispatchDeliveryPartnerId || null;
    if (deliveryPartnerId && String(assignedPartnerId) !== String(deliveryPartnerId)) {
        // An emergency request from a rider who no longer holds the order.
        throw new ValidationError('This rider is no longer on the order');
    }

    const afterPickup = !isBeforePickup(existingOrder);
    // After pickup the new rider collects from the restaurant again: the old
    // rider brings the food back, or the restaurant remakes it.
    const nextOrderStatus =
        afterPickup || existingOrder.orderStatus === 'reached_pickup' ? 'ready_for_pickup' : existingOrder.orderStatus;
    const now = new Date();

    // Guarded on the state just read, so a delivery or another reassignment
    // landing in this instant wins instead of being overwritten.
    const { count } = await prisma.foodOrder.updateMany({
        where: {
            id: existingOrder.id,
            orderStatus: existingOrder.orderStatus,
            dispatchStatus: existingOrder.dispatchStatus,
            dispatchDeliveryPartnerId: assignedPartnerId,
        },
        data: {
            orderStatus: nextOrderStatus,
            externalRiderProvider: null,
            externalRiderName: null,
            externalRiderPhone: null,
            dispatchStatus: 'unassigned',
            dispatchDeliveryPartnerId: null,
            dispatchAssignedAt: null,
            dispatchAcceptedAt: null,
            dispatchingAt: null,
            deliveryPhase: 'en_route_to_pickup',
            deliveryStatus: '',
            reachedPickupAt: null,
            reachedDropAt: null,
            pickedUpAt: null,
            deliveredAt: null,
        },
    });

    if (count === 0) {
        throw new ValidationError('This order just changed. Refresh and try again.');
    }

    if (assignedPartnerId) {
        // An offer still open to that rider is closed, and the 'deassigned' row
        // permanently excludes them from re-offers.
        await prisma.orderDispatchOffer.updateMany({
            where: { orderId: existingOrder.id, partnerId: assignedPartnerId, action: 'offered' },
            data: { action: 'withdrawn' },
        });
        await prisma.orderDispatchOffer.create({
            data: { orderId: existingOrder.id, partnerId: assignedPartnerId, at: now, action: 'deassigned' },
        });
    }

    const who = assignedPartnerId
        ? ''
        : existingOrder.externalRiderName
            ? ` (outside rider ${existingOrder.externalRiderName})`
            : ' (no rider was on it)';
    await prisma.orderStatusHistory.create({
        data: {
            orderId: existingOrder.id,
            byRole: 'ADMIN',
            byId: adminId ? String(adminId) : null,
            from: existingOrder.dispatchStatus || 'unassigned',
            to: 'unassigned',
            note: `${historyNote}${who}${afterPickup ? ' -- after pickup; the new rider collects from the restaurant' : ''}`,
            at: now,
        },
    });

    await prisma.foodTransaction.updateMany({
        where: { orderId: existingOrder.id },
        data: { deliveryPartnerId: null },
    });

    const order = await prisma.foodOrder.findUnique({ where: { id: existingOrder.id } });

    // Clearing the old rider's map pin is cleanup: a process without Firebase
    // set up must still hand the order back out.
    let db = null;
    try {
        db = getFirebaseDB();
    } catch (error) {
        logger.warn(`Firebase unavailable while reassigning order ${order.id}: ${error.message}`);
    }
    if (db) {
        await db.ref(`active_orders/${order.id}`).remove().catch((error) => {
            logger.warn(`Failed to clear tracking for reassigned order ${order.id}: ${error.message}`);
        });
    }

    const payload = {
        orderId: order.id,
        orderMongoId: order.id,
        ...(requestId ? { requestId: String(requestId) } : {}),
        reason,
    };

    const io = getIO();
    if (io) {
        if (assignedPartnerId) io.to(rooms.delivery(assignedPartnerId)).emit('order_deassigned', payload);
        io.to(rooms.restaurant(order.restaurantId)).emit('order_status_update', {
            ...payload,
            dispatchStatus: 'unassigned',
        });
        io.to(rooms.user(order.userId)).emit('order_status_update', {
            ...payload,
            dispatchStatus: 'unassigned',
        });
    }

    await notifyOwnersSafely(
        [
            ...(assignedPartnerId ? [{ ownerType: 'DELIVERY_PARTNER', ownerId: assignedPartnerId }] : []),
            { ownerType: 'RESTAURANT', ownerId: order.restaurantId },
            // Not the customer: they hear "Rider {name} is assigned" when the
            // new rider accepts.
        ],
        {
            title: 'Delivery partner reassignment',
            body: 'The order is being assigned to another delivery partner.',
            data: {
                type: 'order_deassigned',
                orderId: order.id,
                ...(requestId ? { requestId: String(requestId) } : {}),
            },
        },
    );

    return { order, deliveryPartnerId: assignedPartnerId };
}

export async function deassignAndResendOrderAdmin(orderId, adminId) {
    const result = await deassignOrderForRedispatch({
        orderIdentity: orderId,
        adminId,
        reason: 'Order reassigned by admin',
        historyNote: 'Delivery partner deassigned and dispatch restarted by admin',
    });

    const dispatchResult = await dispatchService.tryAutoAssign(result.order.id);

    await prisma.deliveryOrderEmergencyRequest.updateMany({
        where: {
            orderId: result.order.id,
            status: { in: [...ACTIVE_REQUEST_STATUSES, 'processing'] },
        },
        data: {
            status: 'resolved',
            deassignedAt: new Date(),
            resolvedAt: new Date(),
            resolvedById: adminId ? String(adminId) : null,
            failureReason: '',
            // Clearing activeKey releases the unique slot so a future emergency on
            // this order can be raised.
            activeKey: null,
        },
    });

    return {
        orderId: result.order.id,
        deliveryPartnerId: result.deliveryPartnerId ? String(result.deliveryPartnerId) : null,
        dispatchStarted: Boolean(dispatchResult),
    };
}

export async function createOrderEmergencyRequest(deliveryPartnerId, payload = {}) {
    const reason = String(payload.reason || '').trim();
    if (reason.length < 10) {
        throw new ValidationError('Emergency reason must be at least 10 characters');
    }

    const partnerId = String(deliveryPartnerId);
    // The order the rider asked about. Without it the first open one was taken,
    // which with several orders per rider could flag the wrong trip.
    const identity = payload.orderId ? buildOrderIdentityFilter(payload.orderId) : null;
    const order = await prisma.foodOrder.findFirst({
        where: {
            ...(identity || {}),
            dispatchDeliveryPartnerId: partnerId,
            dispatchStatus: 'accepted',
            // After pickup too: a breakdown or accident with the food on board is
            // exactly when a rider needs someone else to take over.
            orderStatus: { in: REASSIGNABLE_ORDER_STATUSES },
        },
        orderBy: { dispatchAcceptedAt: 'desc' },
    });

    if (!order) {
        throw new ValidationError(
            'Reassignment can be asked for on an order you have accepted and not yet delivered',
        );
    }

    try {
        // activeKey is unique, so it is the lock: a second concurrent request for the
        // same order fails here rather than creating a duplicate.
        const created = await prisma.deliveryOrderEmergencyRequest.create({
            data: {
                orderId: order.id,
                deliveryPartnerId: partnerId,
                restaurantId: order.restaurantId,
                reason,
                activeKey: order.id,
                status: 'open',
            },
            include: requestInclude,
        });
        // An admin has to act before the rider reaches the restaurant, so say so
        // now rather than waiting for someone to open the requests page.
        void notifyOwnersSafely([{ ownerType: 'ADMIN', ownerId: 'GLOBAL' }], {
            title: 'Rider asked to give up an order',
            body: `Order #${order.order_id || order.id}: ${reason.slice(0, 120)}`,
            data: { type: 'order_reassignment_request', orderId: order.id, requestId: created.id },
        }).catch(() => {});
        try {
            getIO()?.to(rooms.admin()).emit('order_reassignment_request', { requestId: created.id, orderId: order.id });
        } catch {
            /* best effort */
        }
        return serializeRequest(created);
    } catch (error) {
        if (error?.code === 'P2002') {
            throw new ValidationError('An active reassignment request already exists for this order');
        }
        throw error;
    }
}

/**
 * A request about an order that has since been delivered or cancelled has
 * nothing left to act on, but it stayed "open" on the admin page for good. Run
 * before listing, so the page only ever shows requests that still matter; the
 * closed ones stay in the history.
 */
async function closeRequestsForFinishedOrders() {
    await prisma.deliveryOrderEmergencyRequest.updateMany({
        where: {
            status: { in: ACTIVE_REQUEST_STATUSES },
            order: { orderStatus: { in: ['delivered', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'] } },
        },
        data: {
            status: 'closed',
            activeKey: null,
            resolvedAt: new Date(),
            adminResponse: 'Closed automatically: the order was delivered or cancelled.',
        },
    });
}

export async function listOrderEmergencyRequestsByPartner(deliveryPartnerId) {
    await closeRequestsForFinishedOrders();
    const list = await prisma.deliveryOrderEmergencyRequest.findMany({
        where: { deliveryPartnerId: String(deliveryPartnerId) },
        include: requestInclude,
        orderBy: { createdAt: 'desc' },
    });
    return list.map(serializeRequest);
}

export async function getOrderEmergencyRequestByPartner(requestId, deliveryPartnerId) {
    if (!isId(requestId)) return null;
    const request = await prisma.deliveryOrderEmergencyRequest.findFirst({
        where: { id: String(requestId), deliveryPartnerId: String(deliveryPartnerId) },
        include: requestInclude,
    });
    return serializeRequest(request);
}

export async function listOrderEmergencyRequestsAdmin(query = {}) {
    await closeRequestsForFinishedOrders();
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
    const where = {};
    if (query.status) where.status = String(query.status);

    if (query.search && String(query.search).trim()) {
        const term = String(query.search).trim();
        // Matched through the relation instead of pre-resolving partner ids.
        where.OR = [
            { reason: { contains: term, mode: 'insensitive' } },
            { deliveryPartner: { name: { contains: term, mode: 'insensitive' } } },
            { deliveryPartner: { phone: { contains: term, mode: 'insensitive' } } },
        ];
    }

    const [list, total] = await Promise.all([
        prisma.deliveryOrderEmergencyRequest.findMany({
            where,
            include: requestInclude,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.deliveryOrderEmergencyRequest.count({ where }),
    ]);

    return {
        requests: list.map(serializeRequest),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    };
}

export async function getOrderEmergencyRequestAdmin(requestId) {
    if (!isId(requestId)) return null;
    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({
        where: { id: String(requestId) },
        include: requestInclude,
    });
    return serializeRequest(request);
}

export async function updateOrderEmergencyRequestAdmin(requestId, body = {}) {
    if (!isId(requestId)) throw new ValidationError('Invalid emergency request id');

    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({
        where: { id: String(requestId) },
    });
    if (!request) throw new NotFoundError('Emergency request not found');
    if (request.status === 'processing') {
        throw new ValidationError('Emergency request is currently being processed');
    }

    const data = {};
    if (body.adminResponse !== undefined) {
        data.adminResponse = String(body.adminResponse || '').trim();
    }
    if (body.status !== undefined) {
        const status = String(body.status);
        if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
            throw new ValidationError('Invalid emergency request status');
        }
        data.status = status;
        if (['resolved', 'closed'].includes(status)) {
            data.activeKey = null;
            data.resolvedAt = request.resolvedAt || new Date();
        }
    }

    const updated = await prisma.deliveryOrderEmergencyRequest.update({
        where: { id: request.id },
        data,
        include: requestInclude,
    });

    // The reply was saved and never sent: the rider only saw it by reopening
    // the request. Pushed now, and on the socket for an open app.
    const replied = data.adminResponse && data.adminResponse !== request.adminResponse;
    const statusChanged = data.status && data.status !== request.status;
    if (replied || statusChanged) {
        const STATUS_WORDS = { open: 'Open', in_progress: 'Being handled', resolved: 'Resolved', closed: 'Closed' };
        const body = replied
            ? data.adminResponse
            : `Your reassignment request is now: ${STATUS_WORDS[data.status] || data.status}`;
        const message = {
            requestId: request.id,
            orderId: request.orderId,
            status: updated.status,
            adminResponse: updated.adminResponse || '',
        };
        try {
            getIO()?.to(rooms.delivery(request.deliveryPartnerId)).emit('order_reassignment_update', message);
        } catch (err) {
            logger.warn(`Reassignment update socket failed: ${err?.message || err}`);
        }
        void notifyOwnersSafely([{ ownerType: 'DELIVERY_PARTNER', ownerId: request.deliveryPartnerId }], {
            title: 'Update on your reassignment request',
            body: String(body).slice(0, 200),
            data: { type: 'order_reassignment_update', requestId: request.id, orderId: request.orderId, status: updated.status },
        });
    }
    return serializeRequest(updated);
}

export async function deassignAndResendEmergencyOrder(requestId, adminId) {
    if (!isId(requestId)) throw new ValidationError('Invalid emergency request id');
    const id = String(requestId);

    const alreadyResolved = await prisma.deliveryOrderEmergencyRequest.findFirst({
        where: { id, status: 'resolved' },
        include: requestInclude,
    });
    if (alreadyResolved) {
        return { request: serializeRequest(alreadyResolved), alreadyResolved: true };
    }

    // Claim the request atomically; only one admin can drive the reassignment.
    const { count } = await prisma.deliveryOrderEmergencyRequest.updateMany({
        where: { id, status: { in: ACTIVE_REQUEST_STATUSES } },
        data: { status: 'processing', failureReason: '' },
    });
    if (count === 0) {
        throw new ValidationError('Emergency request is no longer available for reassignment');
    }

    const request = await prisma.deliveryOrderEmergencyRequest.findUnique({ where: { id } });

    try {
        const existingOrder = await prisma.foodOrder.findUnique({ where: { id: request.orderId } });
        if (!existingOrder) throw new NotFoundError('Order not found');

        if (!(request.deassignedAt && existingOrder.dispatchStatus === 'unassigned')) {
            await deassignOrderForRedispatch({
                orderIdentity: request.orderId,
                deliveryPartnerId: request.deliveryPartnerId,
                adminId,
                requestId: request.id,
                reason: 'Emergency reassignment approved by admin',
                historyNote: `Emergency reassignment request ${request.id}`,
            });
            await prisma.deliveryOrderEmergencyRequest.update({
                where: { id },
                data: { deassignedAt: new Date() },
            });
        }

        const dispatchResult = await dispatchService.tryAutoAssign(request.orderId);
        if (!dispatchResult) {
            throw new ValidationError('Delivery dispatch is already busy; retry the request');
        }

        const resolved = await prisma.deliveryOrderEmergencyRequest.update({
            where: { id },
            data: {
                status: 'resolved',
                resolvedAt: new Date(),
                resolvedById: adminId ? String(adminId) : null,
                activeKey: null,
                failureReason: '',
            },
            include: requestInclude,
        });

        return { request: serializeRequest(resolved), orderId: request.orderId, alreadyResolved: false };
    } catch (error) {
        await prisma.deliveryOrderEmergencyRequest
            .update({
                where: { id },
                data: {
                    status: 'in_progress',
                    failureReason: String(error?.message || 'Reassignment failed'),
                },
            })
            .catch((saveError) => {
                logger.error(`Failed to persist emergency request failure: ${saveError.message}`);
            });
        throw error;
    }
}
