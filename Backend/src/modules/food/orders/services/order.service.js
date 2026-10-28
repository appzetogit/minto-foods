import { notifyCustomer, notifyCustomerForStatus } from './customerNotify.service.js';
import { normalizeRecipientFields } from '../validators/order.validator.js';
import { prisma } from '../../../../config/prisma.js';
import { BRAND_IMAGE_URL } from '../../../../config/brand.js';
import { toOrder, toOrders, fromOrder, orderInclude } from '../order.mapper.js';
import { reconcileOrderPayment } from './payment-reconcile.service.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from '../../../../core/auth/errors.js';
import { buildPaginationOptions, buildPaginatedResult, isId } from '../../../../utils/helpers.js';
import {
    createRazorpayOrder,
    verifyPaymentSignature,
    getRazorpayKeyId,
    isRazorpayConfigured,
    fetchRazorpayPayment
} from '../helpers/razorpay.helper.js';
import { getBalance, recordTransaction } from '../../../../core/payments/transaction.service.js';
import { assertCodAllowedForTotal, loadOrderLimits } from '../../shared/orderLimits.js';
import { refreshOrderEta } from './eta.service.js';
import { recomputePartnerRating, recomputeRestaurantRating } from './rating.service.js';
import {
  refundOrder,
  describeRefundLegs,
  onlineAmountDuePaise,
} from './order-refund.service.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import { getFirebaseDB } from '../../../../config/firebase.js';
import * as foodTransactionService from './foodTransaction.service.js';
import * as userWalletService from '../../user/services/userWallet.service.js';
import {
  calculateOrderPricing,
  calculateRiderEarning,
  getDeliveryDistanceKm,
  loadActiveFeeSettings,
  loadRestaurantForOrdering,
  assertRestaurantOpenForOrdering,
} from './order-pricing.service.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';
import * as dispatchService from './order-dispatch.service.js';
import * as deliveryService from './order-delivery.service.js';
import * as paymentService from './order-payment.service.js';
import {
  enqueueOrderEvent,
  sanitizeOrderForExternal,
  sanitizeOrderForRestaurant,
  toRestaurantView,
  sanitizeOrderForDeliveryPartner,
  notifyOwnersSafely,
  notifyOwnersActionableAlert,
  buildOrderIdentityFilter,
  pushStatusHistory,
  normalizeOrderForClient,
  applyAggregateRating,
  buildDeliverySocketPayload,
  notifyRestaurantNewOrder,
  canExposeOrderToRestaurant,
  isStatusAdvance,
  STATUS_PRIORITY,
} from './order.helpers.js';

const ORDER_ACCEPTANCE_WINDOW_SECONDS = 240;
/** How long after placing an order the customer may still cancel it. */
export const CUSTOMER_CANCEL_WINDOW_MS = 60 * 1000;
export const CUSTOMER_CANCEL_GRACE_MS = 5 * 1000;
export const CUSTOMER_CANCEL_WINDOW_MESSAGE = "Orders can only be cancelled within 1 minute of placing them";
const PENDING_PAYMENT_TTL_MS = 30 * 60 * 1000;

/** Projections that replace the old `.populate(path, fields)` calls. */
const RESTAURANT_CARD = {
  id: true, restaurantName: true, profileImage: true, area: true, city: true,
  latitude: true, longitude: true, rating: true, totalRatings: true,
};
const RESTAURANT_DETAIL = { ...RESTAURANT_CARD, ownerPhone: true, primaryContactNumber: true };
const RESTAURANT_ADMIN = {
  id: true, restaurantName: true, area: true, city: true, ownerPhone: true, zoneId: true,
};
const PARTNER_CARD = {
  id: true, name: true, phone: true, rating: true, totalRatings: true, profilePhoto: true,
  vehicleType: true, vehicleName: true, vehicleNumber: true, totalDeliveries: true,
};
const PARTNER_WITH_LOCATION = {
  ...PARTNER_CARD, lastLat: true, lastLng: true, lastLocationAt: true,
};
const USER_CARD = { id: true, name: true, phone: true, email: true };

const withRelations = (restaurant = RESTAURANT_CARD, partner = PARTNER_CARD, user = USER_CARD) => ({
  ...orderInclude,
  restaurant: { select: restaurant },
  deliveryPartner: { select: partner },
  user: { select: user },
});

/** Validates an id's shape, replacing the old toObjectId() cast. */
function requireId(id, fieldName = 'ID') {
  if (!id) return null;
  if (!isId(id)) throw new ValidationError(`Invalid ${fieldName} format`);
  return String(id);
}

/**
 * The restaurant's accept time for a new order, in seconds: the admin's
 * seconds setting (30-600), else the older minutes one, else the default.
 */
export function normalizeAcceptanceWindowSeconds({ seconds, minutes } = {}) {
  const s = Math.round(Number(seconds));
  if (seconds != null && Number.isFinite(s) && s >= 30 && s <= 600) return s;
  const m = Math.round(Number(minutes));
  if (Number.isFinite(m) && m >= 1 && m <= 20) return m * 60;
  return ORDER_ACCEPTANCE_WINDOW_SECONDS;
}

async function getOrderAcceptanceWindowSeconds() {
  try {
    const settings = await prisma.foodBusinessSettings.findFirst({
      select: { orderAcceptanceTimeMinutes: true, orderAcceptanceTimeSeconds: true },
    });
    return normalizeAcceptanceWindowSeconds({
      seconds: settings?.orderAcceptanceTimeSeconds,
      minutes: settings?.orderAcceptanceTimeMinutes,
    });
  } catch (err) {
    logger.warn(`Failed to load order acceptance setting: ${err?.message || err}`);
    return ORDER_ACCEPTANCE_WINDOW_SECONDS;
  }
}

function isAwaitingOnlinePaymentMethod(paymentMethod) {
  const method = String(paymentMethod || "").toLowerCase();
  return method === "razorpay" || method === "card";
}

function buildAcceptanceDeadline(date = new Date(), windowSeconds = ORDER_ACCEPTANCE_WINDOW_SECONDS) {
  const seconds = Number(windowSeconds);
  return new Date(date.getTime() + (Number.isFinite(seconds) && seconds > 0 ? seconds : ORDER_ACCEPTANCE_WINDOW_SECONDS) * 1000);
}

// ----- Order deletion -----

/**
 * Remove an order and everything that cannot outlive it.
 *
 * Mongo simply deleted the document; Postgres has real foreign keys, so the
 * dependants have to be dealt with explicitly. Ledger rows are DETACHED rather
 * than deleted — money records must survive the order they refer to, or a
 * deleted order silently erases its own wallet history.
 */
async function purgeOrderWith(tx, id) {
  await tx.foodSupportTicket.updateMany({ where: { orderId: id }, data: { orderId: null } });
  await tx.transaction.updateMany({ where: { orderId: id }, data: { orderId: null } });
  await tx.foodChatMessage.updateMany({ where: { orderId: id }, data: { orderId: null } });
  await tx.foodChatConversation.updateMany({ where: { orderId: id }, data: { orderId: null } });
  await tx.deliveryOrderEmergencyRequest.deleteMany({ where: { orderId: id } });
  await tx.refund.deleteMany({ where: { orderId: id } });
  await tx.payment.deleteMany({ where: { orderId: id } });
  await tx.foodTransaction.deleteMany({ where: { orderId: id } });
  // items, itemRatings, statusHistory and dispatchOffers cascade.
  await tx.foodOrder.delete({ where: { id } });
}

async function purgeOrder(orderId) {
  const id = String(orderId);
  await prisma.$transaction((tx) => purgeOrderWith(tx, id));
}

// The wallet part of a split order is taken when the order is created and
// handed back if the online part is never paid. Both are keyed on the order
// id, so each happens at most once however many times cleanup runs.
const walletDebitKey = (orderId) => `order_wallet_debit:${orderId}`;
const walletReturnKey = (orderId) => `order_wallet_return:${orderId}`;

/**
 * Give an unpaid order up: return any wallet money it took and delete it.
 *
 * The row is locked and re-read first. The webhook and verify claim `paid`
 * with a conditional update on the same row, so either they got there first
 * (and this backs off) or they wait for this to finish and find no order --
 * which the webhook then refunds. The wallet return and the delete commit
 * together, so the customer can never lose the wallet part or get it twice.
 */
async function deletePendingPaymentOrder(orderLike) {
  const id = orderLike?.id || orderLike?._id;
  if (!id) return false;
  if (String(orderLike.orderStatus || "").toLowerCase() !== "pending_payment") return false;

  const payStatus = String(orderLike.paymentStatus || "").toLowerCase();
  if (payStatus === "paid" || payStatus === "refunded") return false;

  return prisma.$transaction(async (tx) => {
    const orderId = String(id);
    await tx.$queryRaw`SELECT "id" FROM "food_orders" WHERE "id" = ${orderId} FOR UPDATE`;
    const row = await tx.foodOrder.findUnique({
      where: { id: orderId },
      select: { orderStatus: true, paymentStatus: true, userId: true, order_id: true },
    });
    if (!row || row.orderStatus !== "pending_payment") return false;
    if (row.paymentStatus === "paid" || row.paymentStatus === "refunded") return false;

    const debit = await tx.transaction.findUnique({ where: { idempotencyKey: walletDebitKey(orderId) } });
    if (debit) {
      await recordTransaction(
        {
          entityType: "user",
          entityId: String(row.userId),
          type: "credit",
          amount: Number(debit.amount),
          description: `Payment not completed for order #${row.order_id || orderId}: wallet amount returned`,
          category: "order_refund",
          orderId,
          idempotencyKey: walletReturnKey(orderId),
          metadata: { source: "split_payment_return", debitTransactionId: debit.id },
        },
        { client: tx },
      );
    }

    await purgeOrderWith(tx, orderId);
    return true;
  });
}

/**
 * How much of `total` the customer's wallet can pay, leaving the rest online.
 * Razorpay will not take less than ₹1, so the online part is never below that.
 *
 * @returns {Promise<{coversAll: boolean, walletPaise: number}>}
 */
export async function planWalletSplit(userId, total) {
  const totalPaise = Math.round(Number(total) * 100);
  const { availableBalance } = await getBalance("user", String(userId));
  const availablePaise = Math.max(0, Math.floor(Number(availableBalance) * 100 + 1e-6));
  if (availablePaise >= totalPaise) return { coversAll: true, walletPaise: totalPaise };
  let walletPaise = availablePaise;
  if (totalPaise - walletPaise < 100) walletPaise = totalPaise - 100;
  return { coversAll: false, walletPaise: Math.max(0, walletPaise) };
}

let lastExpiredCleanupAt = 0;
const EXPIRE_CLEANUP_INTERVAL_MS = 60_000;

export async function expireStalePendingPaymentOrders({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastExpiredCleanupAt < EXPIRE_CLEANUP_INTERVAL_MS) return;
  lastExpiredCleanupAt = now;

  const cutoff = new Date(Date.now() - PENDING_PAYMENT_TTL_MS);
  const stale = await prisma.foodOrder.findMany({
    where: {
      orderStatus: "pending_payment",
      // The states an unpaid order can sit in: a gateway order was created, a
      // QR was issued, or verification rejected it. 'pending' was in this list
      // and is not an OrderPaymentStatus — Mongo matched nothing, Postgres
      // rejects the query, and this runs on every customer's order list.
      paymentStatus: { in: ["created", "pending_qr", "failed"] },
      createdAt: { lte: cutoff },
    },
    select: { id: true, orderStatus: true, paymentStatus: true, razorpayOrderId: true, total: true, onlineAmount: true },
    // One Razorpay call each, so a pass is capped. Newest first: an order the
    // gateway keeps answering 'unknown' for stays, and must not starve the rest.
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  for (const doc of stale) {
    try {
      // Ask Razorpay before giving up on it. Deleting on age alone removed
      // orders customers had actually paid for whenever the app's verify call
      // and the webhook both missed -- charged, with no order to show for it.
      const gateway = await reconcileOrderPayment(doc);
      if (gateway !== 'unpaid') continue;
      await deletePendingPaymentOrder(doc);
    } catch (err) {
      logger.warn(
        `expireStalePendingPaymentOrders cleanup failed for ${doc.id}: ${err?.message || err}`,
      );
    }
  }
}

// ----- Refunds -----

function buildCancellationRefundDescription(order, cancelledBy = 'system') {
  const orderReadableId = order?.order_id || order?.id || order?._id;
  switch (String(cancelledBy || '').toLowerCase()) {
    case 'user':
      return `Refund for cancelled order #${orderReadableId}`;
    case 'restaurant':
      return `Refund for order #${orderReadableId} cancelled by restaurant`;
    case 'admin':
      return `Refund for order #${orderReadableId} cancelled by admin`;
    case 'auto_cancel':
    case 'timeout':
    case 'system':
      return `Refund for order #${orderReadableId} auto-cancelled by system`;
    default:
      return `Refund for cancelled order #${orderReadableId}`;
  }
}

/**
 * Decide and perform the refund for a cancelled order.
 *
 * Returns a `paymentPatch` of flat columns instead of mutating the order, which
 * is what the Mongoose version did before the caller ran `order.save()`. Callers
 * merge the patch into their own update so the status change and the refund land
 * in one write.
 */
const REFUND_INITIATOR = { user: 'user', restaurant: 'restaurant', admin: 'admin' };

/**
 * Refund a cancelled (or admin-refunded) order: the online part back through
 * Razorpay, the wallet part back to the wallet, each as its own record in
 * food_order_refunds. See order-refund.service.js.
 *
 * The order's refund summary is written by the refund itself, so the
 * `paymentPatch` handed back is always empty; it stays in the return shape
 * because the callers merge it into their own update.
 *
 * @returns {Promise<{attempted: boolean, processed: boolean, paymentPatch: object,
 *   legs: object[], reason?: string, method: string, message: string}>}
 */
async function applyCancellationRefund(order, { cancelledBy = 'system', refundAmount, destination = 'original', strict = false, initiatedById = null } = {}) {
  const method = String(order?.paymentMethod || 'cash').toLowerCase();
  const none = (extra) => ({ attempted: false, processed: false, paymentPatch: {}, legs: [], method, message: '', ...extra });

  if (method === 'cash' || method === 'cod' || method === 'razorpay_qr') {
    return none({ reason: 'cash_payment' });
  }

  const result = await refundOrder({
    orderId: String(order.id ?? order._id),
    amount: refundAmount ?? null,
    destination,
    initiatedBy: REFUND_INITIATOR[String(cancelledBy).toLowerCase()] || 'system',
    initiatedById,
    reason: buildCancellationRefundDescription(order, cancelledBy),
    strict,
  });

  if (!result.legs.length) {
    if (result.reason === 'nothing_left_to_refund') {
      return none({ processed: true, reason: 'already_refunded' });
    }
    return none({ reason: result.reason });
  }

  const moving = result.legs.filter((l) => l.status === 'pending' || l.status === 'processed');
  return {
    attempted: true,
    processed: moving.length > 0,
    paymentPatch: {},
    legs: result.legs,
    method,
    reason: moving.length ? undefined : (result.legs[0]?.failureReason || 'refund_failed'),
    message: describeRefundLegs(result.legs),
  };
}

// ----- Acceptance window expiry -----

/** Most orders one pass cancels; the scheduler's next pass takes the rest. */
const EXPIRE_UNACCEPTED_BATCH = 100;

async function expireUnacceptedOrders(where = {}) {
  const now = new Date();
  const baseWhere = {
    orderStatus: { in: ["created", "confirmed"] },
    acceptanceDeadlineAt: { not: null, lte: now },
    ...where,
  };

  const docs = await prisma.foodOrder.findMany({
    where: baseWhere,
    select: { id: true, orderStatus: true },
    orderBy: { acceptanceDeadlineAt: 'asc' },
    take: EXPIRE_UNACCEPTED_BATCH,
  });
  if (!docs.length) return 0;

  for (const doc of docs) {
    const from = String(doc.orderStatus || "created");

    // The status guard lives in the WHERE clause so a restaurant accepting in
    // this same moment wins rather than being overwritten by the sweep.
    const { count } = await prisma.foodOrder.updateMany({
      where: {
        id: doc.id,
        orderStatus: { in: ["created", "confirmed"] },
        acceptanceDeadlineAt: { not: null, lte: now },
      },
      data: { orderStatus: "cancelled_by_restaurant", note: "Not accepted by restaurant" },
    });
    if (count === 0) continue;

    await pushStatusHistory(doc.id, {
      byRole: "SYSTEM",
      from,
      to: "cancelled_by_restaurant",
      note: "Not accepted by restaurant",
    });

    const updated = toOrder(
      await prisma.foodOrder.findUnique({ where: { id: doc.id }, include: orderInclude }),
    );

    try {
      const refund = await applyCancellationRefund(updated, { cancelledBy: 'auto_cancel' });
      if (Object.keys(refund.paymentPatch).length > 0) {
        await prisma.foodOrder.update({ where: { id: doc.id }, data: refund.paymentPatch });
      }
    } catch (err) {
      logger.warn(`expireUnacceptedOrders refund failed for ${doc.id}: ${err?.message || err}`);
    }

    try {
      const io = getIO();
      if (io) {
        const payload = {
          orderMongoId: doc.id,
          orderId: doc.id,
          orderStatus: "cancelled_by_restaurant",
          note: "Not accepted by restaurant",
          message: "Order was not accepted by restaurant in time.",
        };
        io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
        io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      }
    } catch (err) {
      logger.warn(`expireUnacceptedOrders socket emit failed: ${err?.message || err}`);
    }
  }

  return docs.length;
}

export async function expireUnacceptedOrderById(orderMongoId) {
  if (!isId(orderMongoId)) return 0;
  return expireUnacceptedOrders({ id: String(orderMongoId) });
}

/**
 * Safety net for the per-order expiry job (a lost BullMQ job, Redis down):
 * run by the scheduler. Order reads used to run this for the whole platform
 * on every request; they now only expire the orders they are about to show.
 */
export async function expireUnacceptedOrdersSweep() {
  return expireUnacceptedOrders();
}

// ----- Settings -----
export async function getDispatchSettings() {
  return dispatchService.getDispatchSettings();
}

export async function updateDispatchSettings(dispatchMode, adminId, extra = {}) {
  return dispatchService.updateDispatchSettings(dispatchMode, adminId, extra);
}

// ----- Calculate (validation + return pricing from payload) -----
export async function calculateOrder(userId, dto) {
  const at = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
  const result = await calculateOrderPricing(userId, dto, {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  });

  // What "use my wallet" would do to this total, so checkout can show it
  // before the customer commits. createOrder works it out again at placement.
  const total = Number(result?.pricing?.total) || 0;
  if (userId && total > 0) {
    try {
      const { availableBalance } = await getBalance("user", String(userId));
      const split = await planWalletSplit(userId, total);
      result.wallet = {
        balance: Math.max(0, Number(availableBalance) || 0),
        canUse: split.walletPaise > 0,
        coversAll: split.coversAll,
        walletAmount: split.walletPaise / 100,
        onlineAmount: split.coversAll ? 0 : Math.round(total * 100 - split.walletPaise) / 100,
      };
    } catch (err) {
      logger.warn(`Wallet preview failed for user ${userId}: ${err?.message || err}`);
    }
  }
  return result;
}

// ----- Coupons -----

async function incrementCouponUsageForOrder(order, userId) {
  const couponCode = order?.couponCode
    ? String(order.couponCode).trim().toUpperCase()
    : "";
  if (!couponCode) return;
  // A stored code with no applied discount means the coupon was rejected at
  // pricing time — don't consume the user's/offer's usage allowance for it.
  if (!(Number(order?.discount) > 0)) return;

  try {
    const offer = await prisma.foodOffer.findUnique({ where: { couponCode } });
    if (!offer) return;

    // Conditional increment so concurrent orders cannot push usedCount past usageLimit.
    const { count } = await prisma.foodOffer.updateMany({
      where: {
        id: offer.id,
        OR: [{ usageLimit: null }, { usageLimit: 0 }, { usedCount: { lt: offer.usageLimit ?? 0 } }],
      },
      data: { usedCount: { increment: 1 } },
    });
    if (count === 0 && Number(offer.usageLimit) > 0) {
      // Payment is already processed at this point, so honour the discount but flag the overflow.
      logger.warn(
        `Coupon ${couponCode} reached usage limit before increment for order ${order?.id}; discount honored.`,
      );
    }

    await prisma.foodOfferUsage.upsert({
      where: { offerId_userId: { offerId: offer.id, userId: String(userId) } },
      create: { offerId: offer.id, userId: String(userId), count: 1, lastUsedAt: new Date() },
      update: { count: { increment: 1 }, lastUsedAt: new Date() },
    });
  } catch (err) {
    logger.error(`Coupon usage update failed: ${err.message}`);
  }
}

// ----- Create order -----

/**
 * The order number people see: "MFB" + the order date as DDMMYY (India time)
 * + a running number that never resets, e.g. MFB03102610004 for the 10,004th
 * order, placed on 3 Oct 2026.
 *
 * The number comes from a Postgres sequence (food_order_number_seq, from
 * 10001), so it is unique without a retry. Orders placed before this keep
 * their FOD-... numbers; lookups accept either.
 */
export function formatOrderDisplayId(sequenceNumber, at = new Date()) {
  const ist = new Date(at.getTime() + 330 * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(ist.getUTCFullYear()).slice(-2);
  return `MFB${dd}${mm}${yy}${sequenceNumber}`;
}

async function nextOrderDisplayId(at = new Date()) {
  const [row] = await prisma.$queryRaw`SELECT nextval('food_order_number_seq')::bigint AS n`;
  return formatOrderDisplayId(String(row.n), at);
}

async function createOrderRow(data) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A sequence number never repeats; the retry only covers an old FOD- style
    // number that happens to collide, which a fresh number then avoids.
    const displayId = await nextOrderDisplayId();
    try {
      return await prisma.foodOrder.create({
        data: { ...data, order_id: displayId, orderId: displayId },
        include: orderInclude,
      });
    } catch (err) {
      // P2002 here can only be the display id — nothing else in `data` is unique.
      if (err?.code === 'P2002') continue;
      throw err;
    }
  }
  throw new ValidationError('Could not allocate an order id. Please try again.');
}

export async function createOrder(userId, rawDto) {
  try {
    const dto = normalizeRecipientFields(rawDto);
    const forSomeoneElse = dto.orderForSomeoneElse === true;
    const restaurantId = requireId(dto.restaurantId, 'Restaurant ID');
    const restaurant = await loadRestaurantForOrdering(restaurantId);

    const orderAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (dto.scheduledAt && Number.isNaN(orderAt.getTime())) {
      throw new ValidationError('Invalid scheduled time');
    }
    assertRestaurantOpenForOrdering(restaurant, orderAt);

    const settings = await getDispatchSettings();
    const dispatchMode = settings.dispatchMode;

    const deliveryAddress = normalizeDeliveryAddress({
      label: dto.address?.label || "Home",
      name: dto.address?.name || dto.address?.fullName || dto.customerName || "",
      fullName: dto.address?.fullName || dto.address?.name || dto.customerName || "",
      street: dto.address?.street || "",
      additionalDetails: dto.address?.additionalDetails || "",
      city: dto.address?.city || "",
      state: dto.address?.state || "",
      zipCode: dto.address?.zipCode || "",
      phone: dto.address?.phone || "",
      ...(dto.address || {}),
      // For someone else, the address contact is always the receiver: it is
      // who the rider meets at the door.
      ...(forSomeoneElse
        ? { name: dto.recipient.name, fullName: dto.recipient.name, phone: dto.recipient.phone }
        : {}),
    });

    // The order stays the account holder's: their own name and phone from the
    // account, never the body (the app puts the receiver there for older
    // servers).
    let customer = { name: String(dto.customerName || deliveryAddress.fullName || ""), phone: String(dto.customerPhone || deliveryAddress.phone || "") };
    if (forSomeoneElse) {
      const owner = await prisma.foodUser.findUnique({
        where: { id: requireId(userId, 'User ID') },
        select: { name: true, phone: true },
      });
      customer = { name: String(owner?.name || ""), phone: String(owner?.phone || "") };
    }

    let paymentMethod = dto.paymentMethod === "card" ? "razorpay" : dto.paymentMethod;
    // COD is no longer one switch for the whole platform. A zone can turn it
    // off on its own, and can require a customer to have taken delivery of a
    // few orders first. Checked here, on the server, whatever the app offered:
    // the checkout screen hides the option, but hiding is not enforcing.
    if (paymentMethod === "cash") {
      const { isCodAvailable } = await import("./codAvailability.service.js");
      const cod = await isCodAvailable({
        userId,
        zoneId: dto.zoneId || restaurant.zoneId || null,
      });
      if (!cod.allowed) throw new ValidationError(cod.message);
    }
    const isCash = paymentMethod === "cash";
    let isWallet = paymentMethod === "wallet";

    const pricingResult = await calculateOrderPricing(
      userId,
      {
        restaurantId,
        items: dto.items || [],
        deliveryAddress,
        couponCode: dto.pricing?.couponCode || undefined,
        tipAmount: dto.tipAmount,
        deliveryMode: dto.deliveryMode || "basic",
      },
      { at: orderAt, restaurant, skipAvailabilityCheck: true },
    );

    // A coupon the customer saw applied must still apply now. Between the cart
    // preview and this call its hours can end or its last redemption be taken,
    // and the order used to go through at full price without a word -- charging
    // more than the screen they confirmed. Refuse and say why instead.
    const requestedCoupon = dto.pricing?.couponCode ? String(dto.pricing.couponCode).trim() : "";
    if (requestedCoupon && !pricingResult.pricing?.appliedCoupon) {
      const reason = pricingResult.pricing?.couponError?.message || "This coupon can no longer be applied";
      throw new ValidationError(`${reason}. Remove the coupon or review your cart to continue.`);
    }

    const resolvedItems = pricingResult.items || [];
    const normalizedPricing = {
      subtotal: Number(pricingResult.pricing?.subtotal) || 0,
      tax: Number(pricingResult.pricing?.tax) || 0,
      packagingFee: Number(pricingResult.pricing?.packagingFee) || 0,
      deliveryFee: Number(pricingResult.pricing?.deliveryFee) || 0,
      deliveryFeeGst: Number(pricingResult.pricing?.deliveryFeeGst) || 0,
      platformFee: Number(pricingResult.pricing?.platformFee) || 0,
      quickDeliveryFee: Number(pricingResult.pricing?.quickDeliveryFee) || 0,
      tipAmount: Number(pricingResult.pricing?.tipAmount) || 0,
      deliveryMode:
        pricingResult.pricing?.deliveryMode === "quick" || dto.deliveryMode === "quick"
          ? "quick"
          : "basic",
      discount: Number(pricingResult.pricing?.discount) || 0,
      couponCode: pricingResult.pricing?.couponCode
        ? String(pricingResult.pricing.couponCode).trim().toUpperCase()
        : null,
      total: Number(pricingResult.pricing?.total) || 0,
      currency: String(pricingResult.pricing?.currency || "INR"),
      distanceKm: Number.isFinite(Number(pricingResult.pricing?.distanceKm))
        ? Number(pricingResult.pricing.distanceKm)
        : null,
      roadDistanceKm: Number.isFinite(Number(pricingResult.pricing?.roadDistanceKm))
        ? Number(pricingResult.pricing.roadDistanceKm)
        : null,
    };

    // Cash on delivery only below the admin's limit, whatever the app offered.
    if (isCash) assertCodAllowedForTotal(normalizedPricing.total, await loadOrderLimits());

    if (!Number.isFinite(normalizedPricing.total) || normalizedPricing.total <= 0) {
      throw new ValidationError("Order total must be greater than zero");
    }
    normalizedPricing.total = Math.round(normalizedPricing.total * 100) / 100;

    // Part wallet, part online. The server decides the split from the balance
    // it can see; the app only asks to use the wallet. A wallet that covers the
    // whole order makes it a plain wallet order.
    let walletPaise = isWallet ? Math.round(normalizedPricing.total * 100) : 0;
    if (paymentMethod === "razorpay" && dto.useWallet === true) {
      const split = await planWalletSplit(userId, normalizedPricing.total);
      if (split.coversAll) {
        paymentMethod = "wallet";
        isWallet = true;
      }
      walletPaise = split.walletPaise;
    }
    const totalPaise = Math.round(normalizedPricing.total * 100);
    const onlinePaise = paymentMethod === "razorpay" ? totalPaise - walletPaise : 0;
    const isSplit = paymentMethod === "razorpay" && walletPaise > 0;

    const payment = {
      method: paymentMethod,
      status: isCash ? "cod_pending" : isWallet ? "paid" : "created",
      amountDue: normalizedPricing.total || 0,
      razorpay: {},
      qr: {},
    };

    // Reuse the pricing distance (already road-preferred) — do not call Directions again.
    let distanceKm = Number.isFinite(Number(normalizedPricing.distanceKm))
      ? Number(normalizedPricing.distanceKm)
      : await getDeliveryDistanceKm(restaurant, deliveryAddress);
    distanceKm = Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(2)) : null;
    if (Number.isFinite(distanceKm)) {
      normalizedPricing.distanceKm = distanceKm;
      normalizedPricing.roadDistanceKm = distanceKm;
    }

    // Same zone the order is about to be stamped with, a few lines below.
    const orderZoneId = dto.zoneId || restaurant.zoneId || null;
    const feeSettings = await loadActiveFeeSettings(orderZoneId);
    // The tip belongs to the rider, so it is added to what they are owed. It is
    // also kept on the order in its own column, so a payout can always show how
    // much of an earning was tip rather than delivery pay.
    const tipAmount = Number(normalizedPricing.tipAmount) || 0;
    const riderEarning = (calculateRiderEarning(feeSettings, distanceKm) || 0) + tipAmount;

    let restaurantCommission = 0;
    try {
      const snapshot = await foodTransactionService.getRestaurantCommissionSnapshot({
        pricing: normalizedPricing,
        // The lines carry the restaurant's own prices, which commission is on.
        items: resolvedItems,
        restaurantId,
      });
      restaurantCommission = Number(snapshot?.commissionAmount) || 0;
    } catch (err) {
      logger.error(`Commission calculation failed for order: ${err.message}`);
    }
    normalizedPricing.restaurantCommission = restaurantCommission;

    // Provisional; synced to the transaction's platformNetProfit (which also accounts
    // for the admin discount share) once the initial transaction is created.
    // Admin price-rule markup on the lines: Minto's, not the restaurant's.
    const priceMarkupAmount = foodTransactionService.priceMarkupOf({ items: resolvedItems });
    const platformProfit =
      priceMarkupAmount +
      (Number.isFinite(normalizedPricing.deliveryFee) ? normalizedPricing.deliveryFee : 0) +
      (Number.isFinite(normalizedPricing.deliveryFeeGst) ? normalizedPricing.deliveryFeeGst : 0) +
      (Number.isFinite(normalizedPricing.platformFee) ? normalizedPricing.platformFee : 0) +
      restaurantCommission -
      // Net of the tip: it was never platform income, so subtracting it with the
      // rest of the earning would read as the platform losing money per tip.
      (riderEarning - tipAmount);

    // Refused before anything is saved: an online order the gateway cannot take
    // would sit waiting for a payment the customer has no way to make.
    if (paymentMethod === "razorpay" && !isRazorpayConfigured()) {
      throw new ValidationError("Online payment is not available right now. Please choose cash on delivery.");
    }
    const isAwaitingOnlinePayment = isAwaitingOnlinePaymentMethod(paymentMethod);
    const initialStatus = isAwaitingOnlinePayment ? "pending_payment" : "created";
    const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();

    const created = await createOrderRow({
      ...fromOrder({ pricing: normalizedPricing, payment, deliveryAddress }),
      userId: requireId(userId, 'User ID'),
      restaurantId,
      zoneId: dto.zoneId ? requireId(dto.zoneId, 'Zone ID') : restaurant.zoneId || null,
      customerName: customer.name,
      customerPhone: customer.phone,
      isForSomeoneElse: forSomeoneElse,
      recipientName: forSomeoneElse ? dto.recipient.name : "",
      recipientPhone: forSomeoneElse ? dto.recipient.phone : "",
      orderStatus: initialStatus,
      walletAmount: walletPaise / 100,
      onlineAmount: onlinePaise / 100,
      acceptanceWindowSeconds,
      acceptanceDeadlineAt:
        initialStatus === "created" ? buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds) : null,
      dispatchStatus: "unassigned",
      note: String(dto.note || ""),
      deliveryInstructions: String(dto.deliveryInstructions || ""),
      sendCutlery: dto.sendCutlery !== false,
      deliveryFleet: String(dto.deliveryFleet || "standard"),
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      riderEarning: Number(riderEarning) || 0,
      tipAmount,
      platformProfit: Number(platformProfit) || 0,
      priceMarkupAmount,
      items: {
        create: resolvedItems.map((item) => ({
          itemId: String(item.itemId),
          name: item.name,
          variantId: item.variantId || '',
          variantName: item.variantName || '',
          variantPrice: Number(item.variantPrice) || 0,
          price: Number(item.price) || 0,
          otherPrice: Number(item.otherPrice) || 0,
          basePrice: item.basePrice === undefined ? null : Number(item.basePrice) || 0,
          baseVariantPrice: item.baseVariantPrice === undefined ? null : Number(item.baseVariantPrice) || 0,
          markupPercent: Number(item.markupPercent) || 0,
          priceRuleId: item.priceRuleId || null,
          quantity: Number(item.quantity) || 1,
          isVeg: Boolean(item.isVeg),
          image: item.image || '',
          notes: item.notes || '',
          addons: item.addons || [],
        })),
      },
      statusHistory: {
        create: [{
          at: new Date(),
          byRole: "SYSTEM",
          from: "",
          to: initialStatus,
          note: initialStatus === "pending_payment" ? "Order created, awaiting payment" : "Order placed",
        }],
      },
    });

    let order = toOrder(created);
    let razorpayPayload = null;

    if (isSplit) {
      // Take the wallet part now. The ledger refuses to overdraw, so a balance
      // spent in another tab since the split was worked out fails here.
      try {
        await recordTransaction({
          entityType: "user",
          entityId: String(userId),
          type: "debit",
          amount: walletPaise / 100,
          description: `Payment for order #${order.order_id || order.id} (wallet part)`,
          category: "order_payment",
          orderId: order.id,
          idempotencyKey: walletDebitKey(order.id),
          metadata: { source: "order_payment", split: true, onlineAmount: onlinePaise / 100 },
        });
      } catch (err) {
        await deletePendingPaymentOrder(order).catch(() => {});
        if (/Insufficient balance/i.test(err?.message || "")) {
          throw new ValidationError("Your wallet balance has changed. Please review your payment and try again.");
        }
        throw err;
      }
    }

    if (paymentMethod === "razorpay" && isRazorpayConfigured()) {
      const amountPaise = onlinePaise;
      if (amountPaise < 100) {
        await deletePendingPaymentOrder(order);
        throw new ValidationError("Amount too low for online payment");
      }
      try {
        // The gateway receipt is the order id, so this can only run post-insert.
        // The notes let the webhook recognise a payment for an order that has
        // since been given up, and refund it.
        const rzOrder = await createRazorpayOrder(amountPaise, "INR", order.id, {
          purpose: "food_order",
          orderId: order.id,
        });
        razorpayPayload = {
          key: getRazorpayKeyId(),
          orderId: rzOrder.id,
          amount: rzOrder.amount,
          currency: rzOrder.currency || "INR",
        };
        order = toOrder(await prisma.foodOrder.update({
          where: { id: order.id },
          data: { razorpayOrderId: rzOrder.id, razorpayPaymentId: '', razorpaySignature: '', paymentStatus: 'created' },
          include: orderInclude,
        }));
      } catch (err) {
        // Mongo threw before saving, so no order existed on gateway failure.
        // Hands back the wallet part too, for a split order.
        await deletePendingPaymentOrder(order).catch((cleanupErr) => {
          logger.error(`[CRITICAL] Cleanup after Razorpay failure for order ${order.id}: ${cleanupErr?.message || cleanupErr}`);
        });
        // Razorpay's SDK rejects with { statusCode, error: { description } },
        // not an Error, so err.message was always undefined in the log.
        const reason = err?.error?.description || err?.message || JSON.stringify(err);
        logger.error(`Razorpay order creation failed (${err?.statusCode || '?'}): ${reason}`);
        throw new ValidationError("Online payment is not available right now. Please try again or choose cash on delivery.");
      }
    }

    if (!isAwaitingOnlinePayment) {
      void addOrderJob(
        { action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK", orderMongoId: order.id, orderId: order.id },
        {
          delay: acceptanceWindowSeconds * 1000,
          removeOnComplete: true,
          removeOnFail: true,
          jobId: `order-accept-timeout-${order.id}`,
        },
      ).catch((err) => {
        logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
      });
    }

    if (isWallet) {
      try {
        await userWalletService.deductWalletBalance(
          userId,
          order.total,
          `Payment for order #${order.order_id || order.id}`,
          { orderId: order.id },
        );
      } catch (err) {
        await purgeOrder(order.id).catch(() => {});
        throw err;
      }
    }

    // Create the initial transaction after payment is confirmed (online) or immediately (cash/wallet).
    if (!isAwaitingOnlinePayment) {
      try {
        const transaction = await foodTransactionService.createInitialTransaction(order);
        if (transaction && Number.isFinite(Number(transaction.platformNetProfit))) {
          await prisma.foodOrder.update({
            where: { id: order.id },
            data: { platformProfit: Number(transaction.platformNetProfit) },
          });
          order.platformProfit = Number(transaction.platformNetProfit);
        }
      } catch (err) {
        logger.error(`[CRITICAL] Initial transaction failed for order ${order.id}: ${err.message}`);
      }
    }

    try {
      // Nothing is pushed for an order still awaiting online payment — that push
      // fired while the customer was sitting on the Razorpay sheet actually paying.
      if (!isAwaitingOnlinePayment) {
        await notifyCustomer(order.id, "placed");
        // An ETA from the moment it is placed, not only once someone moves it.
        void refreshOrderEta(order.id, { force: true });

        await notifyRestaurantNewOrder(order);
      }
    } catch (err) {
      logger.warn(`Notifications failed for order ${order.id}: ${err.message}`);
    }

    if (!isAwaitingOnlinePayment) {
      await incrementCouponUsageForOrder(order, userId);
    }

    return { order: normalizeOrderForClient(order), razorpay: razorpayPayload };
  } catch (err) {
    logger.error(`Order placement error: ${err.message}`, { stack: err.stack, userId, dto: rawDto });
    if (err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError) {
      throw err;
    }
    throw new ValidationError(err.message || "Something went wrong while placing your order. Please try again.");
  }
}

// ----- Verify payment -----
export async function verifyPayment(userId, dto) {
  const identity = buildOrderIdentityFilter(dto.orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (order.paymentStatus === "paid") {
    return { order: normalizeOrderForClient(order), payment: order.payment };
  }

  if (String(dto.razorpayOrderId) !== String(order.razorpayOrderId || "")) {
    throw new ValidationError("Payment verification failed");
  }

  const valid = verifyPaymentSignature(
    dto.razorpayOrderId,
    dto.razorpayPaymentId,
    dto.razorpaySignature,
  );
  if (!valid) throw new ValidationError("Payment verification failed");

  // Cross-check the captured payment against the order: correct Razorpay order
  // linkage, an acceptable status, and the exact amount in paise. Fail closed —
  // the webhook remains the recovery path for transient errors.
  let rzPayment;
  try {
    rzPayment = await fetchRazorpayPayment(dto.razorpayPaymentId);
  } catch (err) {
    logger.error(`Razorpay payment fetch failed for order ${order.id}: ${err?.message || err}`);
    throw new ValidationError("Payment verification failed. Please retry in a moment.");
  }

  // The online part only: on a split order the wallet paid the rest.
  const expectedPaise = onlineAmountDuePaise(order);
  const paidPaise = Number(rzPayment?.amount);
  const rzStatus = String(rzPayment?.status || "").toLowerCase();
  if (
    String(rzPayment?.order_id || "") !== String(order.razorpayOrderId) ||
    !["captured", "authorized"].includes(rzStatus) ||
    !Number.isFinite(paidPaise) ||
    paidPaise !== expectedPaise
  ) {
    await prisma.foodOrder.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
    await pushStatusHistory(order.id, {
      byRole: "SYSTEM",
      from: order.orderStatus,
      to: order.orderStatus,
      note: `Payment rejected: amount/order mismatch (paid ${paidPaise} paise, expected ${expectedPaise} paise, status ${rzStatus})`,
    });
    logger.error(
      `Payment amount mismatch for order ${order.id}: paid ${paidPaise} paise, expected ${expectedPaise} paise, rz order ${rzPayment?.order_id}, status ${rzStatus}`,
    );
    throw new ValidationError("Payment verification failed");
  }

  // Claim the paid transition here too, not just in the webhook: verify and
  // the webhook can both reach this point for the same order, and without a
  // conditional update both would run the finalize work below and double
  // everything it does (coupon usage, restaurant notification, the ledger).
  const { count: claimed } = await prisma.foodOrder.updateMany({
    where: { id: order.id, paymentStatus: { not: 'paid' } },
    data: {
      paymentStatus: 'paid',
      razorpayPaymentId: dto.razorpayPaymentId,
      razorpaySignature: dto.razorpaySignature,
    },
  });

  if (!claimed) {
    // The webhook (or a concurrent verify call) already claimed it.
    const fresh = toOrder(await prisma.foodOrder.findFirst({ where: { id: order.id }, include: orderInclude }));
    return { order: normalizeOrderForClient(fresh), payment: fresh.payment };
  }

  const finalized = await finalizeOrderPayment(order.id, { source: "USER", userId });
  const updated = finalized ?? toOrder(await prisma.foodOrder.findFirst({ where: { id: order.id }, include: orderInclude }));

  return { order: normalizeOrderForClient(updated), payment: updated.payment };
}

/**
 * Everything that has to happen once, the first time an order's payment is
 * confirmed — whichever caller gets there first, `verifyPayment` (the user's
 * browser polling Razorpay) or the webhook (Razorpay's own callback). Both
 * claim `paymentStatus: 'paid'` with a conditional update before calling this,
 * so only one of them ever passes the `orderStatus: 'pending_payment'` guard
 * below and runs this body — a retried webhook or a duplicate verify call
 * finds the order already moved past `pending_payment` and gets `null` back.
 *
 * @returns {Promise<object|null>} the finalized order, or null if some other
 *          caller already finalized it.
 */
export async function finalizeOrderPayment(orderId, { source = "SYSTEM", userId = null } = {}) {
  const acceptanceWindowSeconds = await getOrderAcceptanceWindowSeconds();
  const acceptanceDeadlineAt = buildAcceptanceDeadline(new Date(), acceptanceWindowSeconds);

  const { count } = await prisma.foodOrder.updateMany({
    where: { id: orderId, orderStatus: 'pending_payment' },
    data: { orderStatus: 'created', acceptanceWindowSeconds, acceptanceDeadlineAt },
  });
  if (!count) return null;

  const updated = toOrder(await prisma.foodOrder.findFirst({ where: { id: orderId }, include: orderInclude }));

  await pushStatusHistory(orderId, {
    byRole: source,
    byId: userId,
    from: "pending_payment",
    to: "created",
    note: source === "USER" ? "Payment verified, order confirmed" : "Payment confirmed via webhook",
  });

  void addOrderJob(
    { action: "ORDER_ACCEPTANCE_TIMEOUT_CHECK", orderMongoId: orderId, orderId },
    {
      delay: acceptanceWindowSeconds * 1000,
      removeOnComplete: true,
      removeOnFail: true,
      jobId: `order-accept-timeout-${orderId}`,
    },
  ).catch((err) => {
    logger.warn(`Failed to enqueue acceptance timeout check: ${err?.message || err}`);
  });

  try {
    const transaction = await foodTransactionService.createInitialTransaction(updated);
    if (transaction && Number.isFinite(Number(transaction.platformNetProfit))) {
      await prisma.foodOrder.update({
        where: { id: orderId },
        data: { platformProfit: Number(transaction.platformNetProfit) },
      });
      updated.platformProfit = Number(transaction.platformNetProfit);
    }
  } catch (err) {
    logger.error(`[CRITICAL] Initial transaction failed for order ${orderId}: ${err.message}`);
  }

  await incrementCouponUsageForOrder(updated, updated.userId);

  await foodTransactionService.updateTransactionStatus(orderId, 'captured', {
    status: 'captured',
    razorpayPaymentId: updated.razorpayPaymentId,
    razorpaySignature: updated.razorpaySignature,
    recordedByRole: source,
    recordedById: userId ? String(userId) : undefined,
  });

  // Now that payment is confirmed, tell the restaurant -- and the customer:
  // an online order is only "placed" for them once the money has gone through.
  await notifyRestaurantNewOrder(updated);
  await notifyCustomer(updated.id, "placed");
  void refreshOrderEta(updated.id, { force: true });

  return updated;
}

export async function abandonOnlinePaymentOrder(userId, orderId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(order.orderStatus || "").toLowerCase() !== "pending_payment") {
    throw new ValidationError("Order is not awaiting payment");
  }

  // Ask Razorpay before giving up. The app calls this when the payment sheet
  // closes, and a success callback that never reached the app looks exactly
  // the same -- deleting then would leave the customer charged with no order.
  const gateway = await reconcileOrderPayment(order);
  if (gateway === "paid") {
    return { deleted: false, paid: true, orderId: order.id };
  }
  if (gateway === "pending") {
    // Razorpay is still working on it; the 30-minute cleanup settles it.
    return { deleted: false, paid: false, orderId: order.id };
  }

  const deleted = await deletePendingPaymentOrder(order);
  if (!deleted) throw new ValidationError("Could not abandon payment");

  return { deleted: true, orderId: order.id };
}

// ----- Auto-assign -----
export async function tryAutoAssign(orderId, options = {}) {
  return dispatchService.tryAutoAssign(orderId, options);
}

export async function processDispatchTimeout(orderId, partnerId, options = {}) {
  return dispatchService.processDispatchTimeout(orderId, partnerId, options);
}

// ----- User: list, get, cancel -----
export async function listOrdersUser(userId, query) {
  // Only this customer's orders. Unpaid online orders are not listed here, and
  // the scheduler clears them every few minutes.
  await expireUnacceptedOrders({ userId: String(userId) });

  const { page, limit, skip } = buildPaginationOptions(query);
  const where = { userId: String(userId), orderStatus: { not: 'pending_payment' } };

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      include: withRelations(),
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  return buildPaginatedResult({
    docs: toOrders(rows).map((order) => normalizeOrderForClient(order)),
    total,
    page,
    limit,
  });
}

/**
 * Full money split + audit history for the admin order detail view.
 */
async function buildAdminTransactionView(orderId) {
  try {
    const tx = await foodTransactionService.getTransactionByOrder(orderId);
    if (!tx) return null;
    return {
      status: tx.status || null,
      paymentMethod: tx.paymentMethod || null,
      amounts: tx.amounts || null,
      settlement: tx.settlement || null,
      history: (tx.history || []).map((entry) => ({
        kind: entry.kind,
        amount: entry.amount ?? null,
        at: entry.at || null,
        note: entry.note || "",
        byRole: entry.recordedByRole || null,
      })),
    };
  } catch (err) {
    logger.warn(`buildAdminTransactionView failed for order ${orderId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * Restaurant-safe earnings breakdown. Never includes platform economics
 * (platformNetProfit, riderShare, adminDiscountShare).
 */
export function buildRestaurantFinanceViewSync(order, tx = null) {
  // At the restaurant's own prices: admin price-rule markup is not theirs.
  const subtotal =
    (Number(order?.subtotal ?? order?.pricing?.subtotal) || 0) - (Number(order?.priceMarkupAmount) || 0);
  const packagingFee = Number(order?.packagingFee) || 0;

  if (tx) {
    // Callers pass either the mapped transaction or a hand-built
    // { amounts, settlement } object, so read the nested values first. The
    // commission is `commissionAmount`: the flat `restaurantCommission` is the
    // checkout-time pricing snapshot and is usually 0, which showed the
    // restaurant no commission even when one was deducted.
    const a = tx.amounts || {};
    const st = tx.settlement || {};
    return {
      itemTotal: subtotal,
      packagingFee,
      commission: Number(a.restaurantCommission ?? tx.commissionAmount) || 0,
      restaurantDiscountShare: Number(a.restaurantDiscountShare ?? tx.restaurantDiscountShare) || 0,
      discount: Number(order?.discount) || 0,
      taxAmount: Number(a.taxAmount ?? tx.taxAmount ?? order?.tax) || 0,
      totalCustomerPaid: Number(a.totalCustomerPaid ?? tx.totalCustomerPaid ?? order?.total) || 0,
      netPayout: Number(a.restaurantShare ?? tx.restaurantShare) || 0,
      isSettled: Boolean(st.isRestaurantSettled ?? tx.isRestaurantSettled),
      settledAt: st.restaurantSettledAt || tx.restaurantSettledAt || null,
    };
  }

  const commission = Number(order?.restaurantCommission) || 0;
  const netPayout = Math.max(0, Math.round((subtotal + packagingFee - commission) * 100) / 100);
  return {
    itemTotal: subtotal,
    packagingFee,
    commission,
    restaurantDiscountShare: 0,
    discount: Number(order?.discount) || 0,
    taxAmount: Number(order?.tax) || 0,
    totalCustomerPaid: Number(order?.total) || 0,
    netPayout,
    isSettled: false,
    settledAt: null,
  };
}

async function buildRestaurantFinanceView(order) {
  try {
    const tx = await foodTransactionService.getTransactionByOrder(order.id);
    return buildRestaurantFinanceViewSync(order, tx);
  } catch (err) {
    logger.warn(`buildRestaurantFinanceView failed for order ${order?.id}: ${err?.message || err}`);
    return buildRestaurantFinanceViewSync(order, null);
  }
}

export async function getOrderById(
  orderId,
  { userId, restaurantId, deliveryPartnerId, admin } = {},
) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");
  await expireUnacceptedOrders(identity);

  const row = await prisma.foodOrder.findFirst({
    where: identity,
    include: withRelations(RESTAURANT_DETAIL, PARTNER_WITH_LOCATION),
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (admin) {
    const out = normalizeOrderForClient(order);
    out.transaction = await buildAdminTransactionView(order.id);
    return out;
  }

  const orderUserId = row.userId;
  const orderRestaurantId = row.restaurantId;
  const orderPartnerId = row.dispatchDeliveryPartnerId;

  if (userId && orderUserId !== String(userId)) throw new ForbiddenError("Not your order");
  if (restaurantId && orderRestaurantId !== String(restaurantId)) {
    throw new ForbiddenError("Not your restaurant order");
  }
  if (deliveryPartnerId && orderPartnerId !== String(deliveryPartnerId)) {
    throw new ForbiddenError("Not assigned to you");
  }

  if (restaurantId) {
    const out = sanitizeOrderForRestaurant(order);
    out.finance = await buildRestaurantFinanceView(order);
    return out;
  }

  if (deliveryPartnerId) {
    return sanitizeOrderForDeliveryPartner(order);
  }

  if (userId) {
    const drop = order.deliveryVerification?.dropOtp || {};
    const secret = String(order.deliveryOtp || "").trim();
    const out = normalizeOrderForClient(order);
    delete out.deliveryOtp;
    out.deliveryVerification = {
      dropOtp: { required: Boolean(drop.required), verified: Boolean(drop.verified) },
    };
    if (!drop.verified && secret) out.handoverOtp = secret;

    // deliveryState.currentLocation comes from the order's own rider position,
    // which is only written once the rider emits an update FOR THIS ORDER — so
    // before pickup it is null and customer screens fell back to the restaurant's
    // coordinates. The assigned partner's last ping is a real position.
    const partner = row.deliveryPartner;
    if (!out.deliveryState?.currentLocation && partner?.id) {
      const pLat = Number(partner.lastLat);
      const pLng = Number(partner.lastLng);
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
        out.deliveryState = {
          ...(out.deliveryState || {}),
          currentLocation: { lat: pLat, lng: pLng },
          currentLocationAt: partner.lastLocationAt || null,
        };
      }
    }

    return out;
  }

  return sanitizeOrderForExternal(order);
}

export async function getDropOtpUser(orderId, userId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    select: { deliveryOtp: true, deliveryPhase: true, orderStatus: true },
  });
  if (!row) throw new NotFoundError("Order not found");

  const eligiblePhases = ["at_drop", "en_route_to_delivery"];
  const isEligible = eligiblePhases.includes(row.deliveryPhase) || row.orderStatus === "picked_up";

  if (!isEligible) {
    throw new ValidationError(
      "Rider is still at the restaurant. Wait for them to pick up your order to see the OTP.",
    );
  }

  return { otp: row.deliveryOtp };
}

/**
 * Closes trips that were picked up but never completed.
 *
 * DELIBERATELY LIMITED TO POST-PICKUP STATES. Marking any four-hour-old order
 * delivered would sweep up ones never accepted, cooked or paid for and record
 * them as fulfilled — which feeds restaurant payouts and rider earnings for food
 * that does not exist.
 *
 * Marks the order only. Settlement is left alone: an auto-closed trip is
 * unverified, so paying it out automatically would make a guess irreversible.
 */
export async function autoDeliverStaleOrders() {
  const cutoffHours = Number(process.env.AUTO_DELIVER_AFTER_HOURS) || 4;
  const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000);

  const stale = await prisma.foodOrder.findMany({
    where: {
      orderStatus: { in: ['picked_up', 'reached_drop'] },
      // Age from the pickup, not order creation: a trip picked up 10 minutes ago
      // on a five-hour-old scheduled order is perfectly healthy.
      OR: [
        { pickedUpAt: { lte: cutoff } },
        { pickedUpAt: null, updatedAt: { lte: cutoff } },
      ],
    },
    select: { id: true, order_id: true, orderStatus: true, deliveredAt: true },
    take: 200,
  });

  if (!stale.length) return 0;

  let closed = 0;
  for (const order of stale) {
    try {
      const now = new Date();
      // Guard on the status inside the update so a rider completing the trip in
      // this same moment wins rather than being overwritten by the sweep.
      const { count } = await prisma.foodOrder.updateMany({
        where: { id: order.id, orderStatus: { in: ['picked_up', 'reached_drop'] } },
        data: { orderStatus: 'delivered', deliveredAt: order.deliveredAt || now },
      });
      if (count === 0) continue;

      await pushStatusHistory(order.id, {
        byRole: 'ADMIN',
        from: order.orderStatus,
        to: 'delivered',
        note: `Auto-closed after ${cutoffHours}h without completion`,
      });

      closed += 1;
      logger.warn(
        `[AutoDeliver] Order ${order.order_id || order.id} closed automatically ` +
          `after ${cutoffHours}h in '${order.orderStatus}'. Settlement NOT run — review manually.`,
      );

      enqueueOrderEvent('order_auto_delivered', {
        orderMongoId: order.id,
        orderId: order.id,
        previousStatus: order.orderStatus,
      });
    } catch (err) {
      logger.error(`[AutoDeliver] Failed to close order ${order.id}: ${err?.message || err}`);
    }
  }

  if (closed > 0) logger.warn(`[AutoDeliver] Closed ${closed} stale trip(s).`);
  return closed;
}

/**
 * How long an unassigned order must have been silent before the hunt for it is
 * taken to be dead.
 *
 * A running hunt re-queues itself every 45 seconds and writes to the row each
 * round, so anything quiet for several rounds has stopped on its own -- the API
 * restarted, the delayed job was lost, the queue was drained. Well clear of one
 * round, so a hunt that is merely slow is never restarted underneath itself.
 */
const HUNT_DEAD_AFTER_MS = 3 * 60 * 1000;

/** A ceiling per pass, so a backlog cannot fire a push storm at every rider. */
const MAX_HUNTS_RESUMED_PER_PASS = 25;

export async function recoverStuckOrders() {
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const TWO_MIN = 2 * 60 * 1000;

  try {
    // 1. Stuck in 'assigned' (partner never accepted) for > 2m
    const stuckAssigned = await prisma.foodOrder.findMany({
      where: {
        dispatchStatus: 'assigned',
        dispatchAcceptedAt: null,
        dispatchAssignedAt: { lt: new Date(now - TWO_MIN) },
        orderStatus: { notIn: ['delivered', 'cancelled_by_user', 'cancelled_by_restaurant'] },
      },
      select: { id: true },
      orderBy: { dispatchAssignedAt: 'asc' },
      take: 50,
    });

    if (stuckAssigned.length > 0) {
      logger.info(`Watchdog: Healing ${stuckAssigned.length} stuck assigned orders.`);
      for (const order of stuckAssigned) {
        await prisma.foodOrder.update({
          where: { id: order.id },
          data: { dispatchStatus: 'unassigned', dispatchDeliveryPartnerId: null },
        });
        await tryAutoAssign(order.id);
      }
    }

    // 2. Clear old dispatching locks (cleanup in case of crash)
    await prisma.foodOrder.updateMany({
      where: { dispatchingAt: { lt: new Date(now - FIVE_MIN) } },
      data: { dispatchingAt: null },
    });

    // 3. Restart hunts that died.
    //
    // Nothing above covers an order no rider was ever assigned to. Its hunt
    // lives only in the delayed job it queued for itself, so when that job is
    // lost the order stops dead in `preparing` and stays there -- three sat
    // open for four days that way. Cancelling them is the last resort; trying
    // again is what should happen first.
    //
    // The lock clear above runs first on purpose: an order abandoned mid-round
    // still holds `dispatchingAt`, and tryAutoAssign would refuse it.
    const { buildDeadHuntFilter, expiryWindows } = await import("./order-expiry.service.js");

    const deadHunts = await prisma.foodOrder.findMany({
      where: buildDeadHuntFilter(new Date(now), expiryWindows(), HUNT_DEAD_AFTER_MS),
      select: { id: true, order_id: true, orderStatus: true },
      // Oldest first: the order closest to being given up on gets the next try.
      orderBy: { createdAt: "asc" },
      take: MAX_HUNTS_RESUMED_PER_PASS,
    });

    if (deadHunts.length > 0) {
      logger.warn(`Watchdog: Restarting the hunt for ${deadHunts.length} unassigned order(s).`);
      for (const order of deadHunts) {
        try {
          await tryAutoAssign(order.id);
        } catch (err) {
          // One order that cannot be dispatched must not strand the rest.
          logger.error(
            `Watchdog: Could not restart the hunt for ${order.order_id || order.id}: ` +
              `${err?.message || err}`,
          );
        }
      }
    }
  } catch (err) {
    logger.error(`Watchdog recovery error: ${err.message}`);
  }
}

export async function resyncState(userId, role) {
  if (role === "USER") {
    const row = await prisma.foodOrder.findFirst({
      where: {
        userId: String(userId),
        orderStatus: {
          notIn: ["delivered", "cancelled_by_user", "cancelled_by_restaurant", "cancelled_by_admin"],
        },
      },
      include: withRelations(),
      orderBy: { createdAt: 'desc' },
    });

    if (!row) return { activeOrder: null };

    const order = toOrder(row);
    const out = normalizeOrderForClient(order);
    if (
      (order.deliveryPhase === "at_drop" || order.orderStatus === "picked_up") &&
      !order.deliveryVerification?.dropOtp?.verified &&
      order.deliveryOtp
    ) {
      out.handoverOtp = order.deliveryOtp;
    }
    return { activeOrder: out };
  }

  if (role === "DELIVERY_PARTNER") {
    const row = await prisma.foodOrder.findFirst({
      where: {
        dispatchDeliveryPartnerId: String(userId),
        dispatchStatus: { in: ["assigned", "accepted"] },
        orderStatus: { notIn: ["delivered", "cancelled_by_user", "cancelled_by_restaurant"] },
      },
      include: { ...orderInclude, restaurant: true },
    });
    return { activeOrder: row ? sanitizeOrderForDeliveryPartner(toOrder(row)) : null };
  }

  return {};
}

export async function cancelOrder(orderId, userId, reason) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  // A customer may cancel only while the order is still new, and only for the
  // first minute: after that the kitchen may already be cooking it. The few
  // seconds of grace cover a tap made in time that reaches us late.
  const allowed = ["created"];
  const placedAt = new Date(row.createdAt).getTime();
  const cancelDeadline = new Date(placedAt + CUSTOMER_CANCEL_WINDOW_MS + CUSTOMER_CANCEL_GRACE_MS);
  if (!allowed.includes(order.orderStatus) || !(Date.now() <= cancelDeadline.getTime())) {
    throw new ValidationError(CUSTOMER_CANCEL_WINDOW_MESSAGE);
  }

  const from = order.orderStatus;
  const paymentMethod = String(order.paymentMethod || "cash").toLowerCase();
  const paymentStatus = String(order.paymentStatus || "cod_pending").toLowerCase();

  // Claim the cancellation before any money moves. The restaurant can accept
  // at the same moment; only one of the two changes can win, and a refund for
  // an order that then went ahead would be money given away.
  const { count: cancelled } = await prisma.foodOrder.updateMany({
    where: { id: order.id, orderStatus: { in: allowed } },
    data: { orderStatus: "cancelled_by_user" },
  });
  if (!cancelled) throw new ValidationError(CUSTOMER_CANCEL_WINDOW_MESSAGE);

  let refund;
  try {
    refund = await applyCancellationRefund(order, { cancelledBy: 'user', initiatedById: userId });
  } catch (err) {
    logger.error(`Refund processing error for Order ${orderId}: ${err?.message || err}`);
    await prisma.foodOrder.update({ where: { id: order.id }, data: { refundStatus: "failed" } }).catch(() => {});
    refund = { paymentPatch: {}, legs: [], message: "" };
  }

  const updated = toOrder(await prisma.foodOrder.findUnique({
    where: { id: order.id },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "USER",
    byId: userId,
    from,
    to: "cancelled_by_user",
    note: reason || "",
  });

  enqueueOrderEvent("order_cancelled_by_user", {
    orderMongoId: order.id,
    orderId: order.id,
    userId,
    reason: reason || "",
  });

  const finalPaymentMethod = String(updated.paymentMethod || paymentMethod || "cash").toLowerCase();
  const finalPaymentStatus = String(updated.paymentStatus || paymentStatus || "cod_pending").toLowerCase();
  const isOnlinePaid =
    (finalPaymentMethod === "razorpay" || finalPaymentMethod === "wallet") &&
    (finalPaymentStatus === "paid" || finalPaymentStatus === "refunded");

  try {
    await foodTransactionService.updateTransactionStatus(order.id, 'cancelled_by_user', {
      status: isOnlinePaid ? 'refunded' : 'failed',
      note: `Order cancelled by user: ${reason || "No reason"}`,
      recordedByRole: 'USER',
      recordedById: userId,
    });
  } catch (err) {
    logger.warn(`cancelOrder transaction sync failed: ${err?.message || err}`);
  }

  // Says where each part went: "₹120 has been added back to your Minto
  // wallet. ₹330 will be refunded to your original payment method...".
  const refundDetail = refund.message
    ? ` ${refund.message}`
    : isOnlinePaid && updated.refundStatus === "failed"
      ? " Your refund could not be completed automatically; our team will process it."
      : "";

  await notifyOwnersSafely(
    [
      { ownerType: "USER", ownerId: userId },
      { ownerType: "RESTAURANT", ownerId: updated.restaurantId },
    ],
    {
      title: "Order Cancelled ❌",
      body: `Order #${updated.order_id || updated.id} has been cancelled successfully.${refundDetail}`,
      image: BRAND_IMAGE_URL,
      data: { type: "order_cancelled", orderId: updated.id, orderMongoId: updated.id },
    },
  );

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: updated.orderStatus,
        message: `Order #${updated.order_id || updated.id} has been cancelled successfully.${refundDetail}`,
      };
      io.to(rooms.user(userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      // A rider already on the order must stop heading for it.
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_status_update", {
          ...payload,
          message: `Order #${updated.order_id || updated.id} was cancelled by the customer.`,
        });
      }
    }
  } catch (err) {
    logger.warn(`cancelOrder socket emit failed: ${err?.message || err}`);
  }

  if (row.dispatchDeliveryPartnerId) {
    void notifyOwnersSafely([{ ownerType: "DELIVERY_PARTNER", ownerId: row.dispatchDeliveryPartnerId }], {
      title: "Order cancelled",
      body: `Order #${updated.order_id || updated.id} was cancelled by the customer. You don't need to pick it up.`,
      image: BRAND_IMAGE_URL,
      data: {
        type: "order_cancelled",
        orderId: updated.id,
        orderMongoId: updated.id,
        orderStatus: "cancelled_by_user",
      },
    });
  }

  return normalizeOrderForClient(updated);
}

export async function submitOrderRatings(orderId, userId, dto) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(order.orderStatus) !== "delivered") {
    throw new ValidationError("You can rate only delivered orders");
  }

  const partnerId = row.dispatchDeliveryPartnerId;
  const ratesRestaurant = dto.restaurantRating != null;
  const ratesPartner = dto.deliveryPartnerRating != null;

  // The food and the rider can be rated separately and in either order -- the
  // delivered screen asks only about the rider. Each can be rated once.
  if (ratesPartner && !partnerId) {
    throw new ValidationError("This order had no delivery partner to rate");
  }
  if (ratesRestaurant && row.restaurantRating != null) {
    throw new ValidationError("You have already rated the food for this order");
  }
  if (ratesPartner && row.partnerRating != null) {
    throw new ValidationError("You have already rated the delivery partner for this order");
  }

  const now = new Date();

  // Per-dish ratings go with the food rating. Only items actually on this
  // order count -- otherwise a customer could rate any dish on the menu, from
  // one cheap order.
  const orderedItems = new Map((order.items || []).map((it) => [String(it.itemId), it]));
  const itemRatings = Array.isArray(dto.itemRatings) ? dto.itemRatings : [];
  if (itemRatings.length && !ratesRestaurant) {
    throw new ValidationError("Rate the food to rate individual dishes");
  }
  const seenItemIds = new Set();
  const itemRatingRows = [];
  for (const entry of itemRatings) {
    const itemId = String(entry.itemId || "").trim();
    const ordered = orderedItems.get(itemId);
    if (!ordered) throw new ValidationError("You can only rate dishes from this order");
    if (seenItemIds.has(itemId)) throw new ValidationError("Each dish can be rated only once");
    seenItemIds.add(itemId);
    itemRatingRows.push({
      itemId,
      name: ordered.name || "",
      rating: entry.rating,
      comment: entry.comment || "",
      ratedAt: now,
    });
  }

  // Claim the rating slots atomically: the write only lands if they are still
  // empty, so a double tap cannot count the same rating into the averages twice.
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.foodOrder.updateMany({
      where: {
        id: order.id,
        ...(ratesRestaurant ? { restaurantRating: null } : {}),
        ...(ratesPartner ? { partnerRating: null } : {}),
      },
      data: {
        ...(ratesRestaurant
          ? {
              restaurantRating: dto.restaurantRating,
              restaurantRatingComment: dto.restaurantComment || "",
              restaurantRatedAt: now,
            }
          : {}),
        ...(ratesPartner
          ? {
              partnerRating: dto.deliveryPartnerRating,
              partnerRatingComment: dto.deliveryPartnerComment || "",
              partnerRatedAt: now,
            }
          : {}),
      },
    });
    if (!count) throw new ValidationError("Ratings already submitted for this order");
    if (itemRatingRows.length) {
      await tx.foodOrder.update({
        where: { id: order.id },
        data: { itemRatings: { create: itemRatingRows } },
      });
    }
    return tx.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude });
  });

  // The restaurant and rider averages are recomputed from their orders in
  // this request, so Outlet info shows the new rating straight away and never
  // drifts. Dishes keep the running average.
  await Promise.all([
    ratesRestaurant ? recomputeRestaurantRating(row.restaurantId) : null,
    ratesPartner ? recomputePartnerRating(partnerId) : null,
    ...itemRatings.map((entry) => applyAggregateRating('foodItem', entry.itemId, entry.rating)),
  ]);

  enqueueOrderEvent('order_ratings_submitted', {
    orderMongoId: order.id,
    orderId: order.id,
    userId,
    restaurantRating: ratesRestaurant ? dto.restaurantRating : null,
    deliveryPartnerRating: ratesPartner ? dto.deliveryPartnerRating : null,
  });

  return normalizeOrderForClient(toOrder(updated));
}

/**
 * Delivery partner rates the customer after handover.
 *
 * Kept separate from submitOrderRatings: the two are written by different roles
 * at different times, and sharing the one-shot guard would mean whichever side
 * rated first locked the other out.
 */
export async function submitCustomerRating(orderId, deliveryPartnerId, dto) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (String(row.dispatchDeliveryPartnerId || "") !== String(deliveryPartnerId)) {
    throw new ForbiddenError("Not your order");
  }
  if (String(order.orderStatus) !== "delivered") {
    throw new ValidationError("You can rate only delivered orders");
  }
  if (Number.isFinite(Number(order?.ratings?.customer?.rating))) {
    throw new ValidationError("You have already rated this customer");
  }

  const ratedAt = new Date();
  await applyAggregateRating('user', row.userId, dto.rating);

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      customerRating: dto.rating,
      customerRatingComment: dto.comment || "",
      customerRatedAt: ratedAt,
    },
    include: orderInclude,
  }));

  return {
    orderId: updated.order_id || updated.id,
    orderMongoId: updated.id,
    customerRating: updated.ratings.customer,
  };
}

export async function updateOrderInstructions(orderId, userId, instructions) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, userId: String(userId) },
    select: { id: true, orderStatus: true },
  });
  if (!row) throw new NotFoundError("Order not found");

  const allowedStatuses = ['created', 'confirmed', 'preparing'];
  if (!allowedStatuses.includes(row.orderStatus)) {
    throw new ValidationError("Instructions can no longer be updated for this order");
  }

  const updated = await prisma.foodOrder.update({
    where: { id: row.id },
    data: { deliveryInstructions: String(instructions || "").trim() },
    include: orderInclude,
  });
  return toOrder(updated);
}

// ----- Restaurant -----
export async function listOrdersRestaurant(restaurantId, query) {
  await expireUnacceptedOrders({ restaurantId: String(restaurantId) });

  const { page, limit, skip } = buildPaginationOptions(query);
  const AND = [];

  const where = {
    restaurantId: String(restaurantId),
    // razorpay_qr = collected at the door, same as cash — see canExposeOrderToRestaurant.
    // ('captured' and 'settled' were in the old $in but are not valid payment
    // statuses on an order, so they never matched anything.)
    OR: [
      { paymentMethod: { in: ["cash", "wallet", "razorpay_qr"] } },
      { paymentStatus: { in: ["paid", "authorized", "refunded"] } },
    ],
  };

  const startDateRaw = query?.startDate || query?.from;
  const endDateRaw = query?.endDate || query?.to;
  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      createdAt.gte = start;
    }
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  const statusRaw = query?.orderStatus || query?.status;
  if (statusRaw) {
    const statuses = String(statusRaw)
      .split(",")
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (statuses.length > 0) where.orderStatus = { in: statuses };
  }

  const searchRaw = String(query?.search || query?.orderId || "").trim();
  if (searchRaw) {
    AND.push({
      OR: [
        { orderId: { contains: searchRaw, mode: 'insensitive' } },
        { order_id: { contains: searchRaw, mode: 'insensitive' } },
      ],
    });
  }
  if (AND.length) where.AND = AND;

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      // The rider has to be loaded here too. Without it the mapper can only
      // emit the partner's id, so the restaurant's live card read "Looking for
      // partner…" even for an order a rider had already picked up.
      include: {
        ...orderInclude,
        user: { select: { ...USER_CARD, profileImage: true } },
        deliveryPartner: { select: PARTNER_CARD },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  const transactions = rows.length
    ? await prisma.foodTransaction.findMany({
        where: { orderId: { in: rows.map((r) => r.id) } },
      })
    : [];
  const txByOrderId = new Map(transactions.map((tx) => [tx.orderId, tx]));

  const normalizedOrders = toOrders(rows).map((order) => {
    const out = toRestaurantView(normalizeOrderForClient(order));
    const tx = txByOrderId.get(order.id);
    out.finance = buildRestaurantFinanceViewSync(
      order,
      tx
        ? {
            amounts: {
              restaurantCommission: Number(tx.commissionAmount),
              restaurantDiscountShare: Number(tx.restaurantDiscountShare),
              taxAmount: Number(tx.taxAmount),
              totalCustomerPaid: Number(tx.totalCustomerPaid),
              restaurantShare: Number(tx.restaurantShare),
            },
            settlement: {
              isRestaurantSettled: tx.isRestaurantSettled,
              restaurantSettledAt: tx.restaurantSettledAt,
            },
          }
        : null,
    );
    return out;
  });

  const paginated = buildPaginatedResult({ docs: normalizedOrders, total, page, limit });
  return {
    ...paginated,
    orders: paginated.data,
    pagination: {
      page: paginated.meta.page,
      limit: paginated.meta.limit,
      total: paginated.meta.total,
      totalPages: paginated.meta.totalPages,
      pages: paginated.meta.totalPages,
    },
  };
}

const STATUS_WORDS = {
  created: "new",
  confirmed: "accepted",
  preparing: "being prepared",
  ready_for_pickup: "ready for pickup",
  reached_pickup: "waiting for pickup",
  picked_up: "picked up by the rider",
  reached_drop: "with the rider at the customer",
  delivered: "delivered",
  cancelled_by_user: "cancelled by the customer",
  cancelled_by_restaurant: "cancelled",
  cancelled_by_admin: "cancelled by support",
};

/** Why a restaurant cannot move an order to a status, in words the app can show. */
export function restaurantStatusRefusal(from, to) {
  const now = STATUS_WORDS[from] || String(from || "").replace(/_/g, " ");
  const wanted = STATUS_WORDS[to] || String(to || "").replace(/_/g, " ");
  if (String(from).startsWith("cancelled")) return `This order was ${now}, so it can't be marked ${wanted}.`;
  return `This order is already ${now}, so it can't be marked ${wanted}.`;
}

/** What the second phone is told when the order was answered on another one. */
export function answeredElsewhereMessage(status) {
  const now = String(status || "");
  if (now.startsWith("cancelled")) return "This order was already rejected on another device";
  return "This order was already accepted on another device";
}

/**
 * Accepting (confirmed) needs a new order, and rejecting one that is already
 * cancelled is a second phone too. Anything else is an ordinary step.
 */
function assertNotAnsweredElsewhere(from, to) {
  const target = String(to || "");
  const current = String(from || "");
  if (target === "confirmed" && current !== "created") {
    throw new ConflictError(answeredElsewhereMessage(current));
  }
  if (target === "cancelled_by_restaurant" && current.startsWith("cancelled")) {
    throw new ConflictError(answeredElsewhereMessage(current));
  }
}

export async function updateOrderStatusRestaurant(orderId, restaurantId, orderStatus, note = "") {
  await expireUnacceptedOrders({ restaurantId: String(restaurantId) });

  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({
    where: { ...identity, restaurantId: String(restaurantId) },
    include: orderInclude,
  });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  // An unpaid order must never be actionable by the restaurant. pending_payment is
  // absent from STATUS_PRIORITY, so isStatusAdvance() treats it as 0 and lets ANY
  // target status through — a restaurant could walk an abandoned, never-paid order
  // all the way to 'delivered', which then counts toward its payout.
  if (!canExposeOrderToRestaurant(order)) {
    throw new ValidationError("This order is not payable yet and cannot be updated");
  }

  const targetStatus = String(orderStatus || "").toLowerCase();
  if (targetStatus === "preparing" || targetStatus === "confirmed") {
    const now = new Date();
    const deadline = order.acceptanceDeadlineAt ? new Date(order.acceptanceDeadlineAt) : null;
    if (deadline && deadline.getTime() <= now.getTime()) {
      await expireUnacceptedOrders({ id: order.id });
      throw new ValidationError("Order acceptance window has expired");
    }
  }

  const from = order.orderStatus;
  // Accept / reject from a second phone after the first one already answered:
  // the restaurant is signed in on several, and both ring. Refused with a 409
  // so the app can close its popup and say why.
  assertNotAnsweredElsewhere(from, orderStatus);
  // The same status again is a repeated tap or a retried request whose first
  // try already worked -- most "Mark ready" failures in the logs were exactly
  // this. Answer with the order as it is instead of an error, and do nothing
  // else: no second push, no second dispatch.
  if (String(from) === String(orderStatus)) {
    return toRestaurantView(normalizeOrderForClient(order));
  }
  if (!isStatusAdvance(from, orderStatus)) {
    throw new ValidationError(restaurantStatusRefusal(from, orderStatus));
  }

  const normalizedPaymentMethod = String(order.paymentMethod || "cash").toLowerCase();
  const prevPaymentStatus = String(order.paymentStatus || "cod_pending").toLowerCase();
  const codBecomesPaid =
    String(orderStatus) === "delivered" &&
    normalizedPaymentMethod === "cash" &&
    prevPaymentStatus === "cod_pending";

  // One atomic update that only lands if the order is still in the status this
  // request read. Two phones answering together both read "created"; the
  // database lets exactly one of them through, and the other gets a 409.
  const { count: moved } = await prisma.foodOrder.updateMany({
    where: { id: order.id, orderStatus: from },
    data: {
      orderStatus,
      // The acceptance window exists only to auto-cancel orders the restaurant
      // never acted on. It was never cleared once they did, so expireUnacceptedOrders
      // later cancelled confirmed, actively-dispatching orders as "Not accepted".
      acceptanceDeadlineAt: null,
      ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}),
    },
  });
  if (!moved) {
    const now = await prisma.foodOrder.findUnique({ where: { id: order.id }, select: { orderStatus: true } });
    throw new ConflictError(answeredElsewhereMessage(now?.orderStatus));
  }
  let updated = toOrder(await prisma.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude }));

  // Every phone the restaurant is signed in on hears the answer, so the ones
  // that are still ringing stop. Silent: the phone that answered knows.
  if (String(from) === "created") {
    void notifyOwnersSafely([{ ownerType: "RESTAURANT", ownerId: restaurantId }], {
      dataOnly: true,
      data: {
        type: "order_status_update",
        orderId: updated.id,
        orderMongoId: updated.id,
        orderStatus: String(orderStatus),
      },
    });
  }

  await pushStatusHistory(order.id, {
    byRole: "RESTAURANT",
    byId: restaurantId,
    from,
    to: orderStatus,
    note: note || "",
  });

  if (String(orderStatus) === "delivered") {
    try {
      const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
      await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
        status: "captured",
        recordedByRole: "RESTAURANT",
        recordedById: restaurantId,
        note: `Delivery completed from restaurant flow. Prev payment status: ${prevPaymentStatus}`,
      });
    } catch (err) {
      logger.warn(`updateOrderStatusRestaurant delivered transaction sync failed: ${err?.message || err}`);
    }
  }

  let title = `Order ${updated.id} updated`;
  let body = `Status changed to ${String(orderStatus).replace(/_/g, " ")}`;

  if (orderStatus === "confirmed") {
    title = "Order Accepted! 🧑‍🍳";
    body = "The restaurant has accepted your order and is starting to prepare it.";
  } else if (orderStatus === "preparing") {
    title = "Food is being prepared! 🍳";
    body = "Your food is currently being prepared by the restaurant.";
  } else if (orderStatus === "ready_for_pickup") {
    title = "Food is ready! 🛍️";
    body = "Your order is ready and waiting to be picked up.";
  } else if (String(orderStatus).includes("cancel")) {
    const isOnlinePaid =
      updated.paymentMethod === "razorpay" &&
      (updated.paymentStatus === "paid" || updated.paymentStatus === "refunded");
    const refundDetail = isOnlinePaid
      ? ` Your refund of ₹${updated.total} is being processed and will be credited to your original payment method within 5-7 working days.`
      : "";
    title = "Order Cancelled ❌";
    body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by the restaurant.${refundDetail}`;
  }

  try {
    const io = getIO();
    const payload = {
      orderMongoId: updated.id,
      orderId: updated.id,
      orderStatus: updated.orderStatus,
      note: updated.note || "",
      statusNote: note || "",
      title,
      message: body,
    };

    if (io) {
      io.to(rooms.restaurant(restaurantId)).emit("order_status_update", payload);
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      const assignedRiderId = row.dispatchDeliveryPartnerId;
      if (assignedRiderId) {
        io.to(rooms.delivery(assignedRiderId)).emit("order_status_update", payload);
      }
    }

    // Who actually needs telling about THIS status. Everyone used to be pushed for
    // every transition, which trains people to swipe alerts away — which is how a
    // genuinely important one gets missed.
    const status = String(orderStatus || "");
    const isCancellation = status.includes("cancel");
    // ready_for_pickup and preparing are kitchen states the customer cannot act on.
    // The customer's own pushes (accepted, ready, ...) come from notifyCustomer
    // with their fixed wording; only a cancellation is sent from here.
    const notifyList = [];

    if (isCancellation) {
      notifyList.push({ ownerType: "USER", ownerId: updated.userId });
    } else {
      void notifyCustomerForStatus(updated.id, status);
    }
    // The restaurant is making these changes; echoing its own tap back is noise.
    // A cancellation may come from support or the customer, so that one it needs.
    if (isCancellation) {
      notifyList.push({ ownerType: "RESTAURANT", ownerId: restaurantId });
    }
    const assignedRiderId = row.dispatchDeliveryPartnerId;
    if (assignedRiderId) {
      notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: assignedRiderId });
    }

    if (isCancellation) {
      try {
        const isOnlinePaid =
          updated.paymentMethod === "razorpay" &&
          (updated.paymentStatus === "paid" || updated.paymentStatus === "refunded");
        await foodTransactionService.updateTransactionStatus(order.id, 'cancelled_by_restaurant', {
          status: isOnlinePaid ? 'refunded' : 'failed',
          note: `Order cancelled by restaurant/admin`,
          recordedByRole: 'RESTAURANT',
          recordedById: restaurantId,
        });
      } catch (err) {
        logger.warn(`updateOrderStatusRestaurant transaction sync failed: ${err?.message || err}`);
      }
    }

    // Fire-and-forget: awaiting a push fan-out put Google's latency inside the
    // restaurant's tap for no benefit. Guarded rather than returned early, so the
    // dispatch below still runs for a status nobody is pushed about.
    if (notifyList.length > 0) {
      void notifyOwnersSafely(notifyList, {
        title,
        body,
        image: BRAND_IMAGE_URL,
        data: {
          type: "order_status_update",
          orderId: updated.id,
          orderMongoId: updated.id,
          orderStatus: String(orderStatus || ""),
          link: `/food/user/orders/${updated.id}`,
        },
      });
    }
  } catch (err) {
    logger.warn(`updateOrderStatusRestaurant notify failed: ${err?.message || err}`);
  }

  try {
    const io = getIO();
    if (io) {
      // On accept (confirmed or preparing) -> request delivery partners.
      if (
        (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") &&
        String(from) !== "preparing" && String(from) !== "confirmed"
      ) {
        // Dispatch runs in the background, not inside the request: tryAutoAssign does
        // a geo query, a Directions call and an FCM batch. Awaiting all of that made
        // accepting an order take up to 2.7s, which reads as an unresponsive button.
        void tryAutoAssign(order.id).catch((err) => {
          logger.warn(`Auto-assign in updateOrderStatusRestaurant failed: ${err?.message || err}`);
        });
      }

      // When ready for pickup -> ping the assigned delivery partner.
      if (String(orderStatus) === 'ready_for_pickup' && String(from) !== 'ready_for_pickup') {
        const assignedId = row.dispatchDeliveryPartnerId;
        if (assignedId) {
          const restaurant = await prisma.foodRestaurant.findUnique({
            where: { id: row.restaurantId },
            select: {
              id: true, restaurantName: true, latitude: true, longitude: true,
              addressLine1: true, area: true, city: true, state: true,
              ownerPhone: true, coverImage: true, coverImages: true,
              galleryImages: true, landmark: true,
            },
          });
          const payload = buildDeliverySocketPayload(updated, restaurant);
          logger.info(
            `[DeliveryDispatch] Emitting order_ready to ${rooms.delivery(assignedId)} for order ${order.id}`,
          );
          io.to(rooms.delivery(assignedId)).emit('order_ready', payload);
        }
      }
    }
  } catch (err) {
    logger.warn(`updateOrderStatusRestaurant delivery notification failed: ${err?.message || err}`);
  }

  enqueueOrderEvent('restaurant_order_status_updated', {
    orderMongoId: order.id,
    orderId: order.id,
    restaurantId,
    from,
    to: orderStatus,
  });

  if (String(orderStatus).includes("cancel")) {
    try {
      const refund = await applyCancellationRefund(updated, { cancelledBy: 'restaurant' });
      if (Object.keys(refund.paymentPatch).length > 0) {
        updated = toOrder(await prisma.foodOrder.update({
          where: { id: order.id },
          data: refund.paymentPatch,
          include: orderInclude,
        }));
      }
    } catch (err) {
      logger.error(`Automated refund failed for Order ${order.id} (Restaurant Cancel): ${err?.message || err}`);
      updated = toOrder(await prisma.foodOrder.update({
        where: { id: order.id },
        data: { refundStatus: "failed" },
        include: orderInclude,
      }));
    }
  }

  // What the restaurant may see: its own prices, and no customer phone.
  return toRestaurantView(normalizeOrderForClient(updated));
}

export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
  return dispatchService.resendDeliveryNotificationRestaurant(orderId, restaurantId);
}

export async function resendDeliveryNotificationAdmin(orderId) {
  return dispatchService.resendDeliveryNotificationAdmin(orderId);
}

export async function getCurrentTripDelivery(deliveryPartnerId) {
  return deliveryService.getCurrentTripDelivery(deliveryPartnerId);
}

// ----- Delivery: available, accept, reject, status -----
export async function listOrdersAvailableDelivery(deliveryPartnerId, query) {
  return deliveryService.listOrdersAvailableDelivery(deliveryPartnerId, query);
}

export async function getOrderRouteForDelivery(orderId, deliveryPartnerId, query) {
  return deliveryService.getOrderRouteForDelivery(orderId, deliveryPartnerId, query);
}

export async function getOrderRouteForUser(orderId, userId, query) {
  return deliveryService.getOrderRouteForUser(orderId, userId, query);
}

export async function acceptOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.acceptOrderDelivery(orderId, deliveryPartnerId);
}

export async function rejectOrderDelivery(orderId, deliveryPartnerId) {
  return deliveryService.rejectOrderDelivery(orderId, deliveryPartnerId);
}

export async function confirmReachedPickupDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedPickupDelivery(orderId, deliveryPartnerId);
}

export async function confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl) {
  return deliveryService.confirmPickupDelivery(orderId, deliveryPartnerId, billImageUrl);
}

export async function confirmReachedDropDelivery(orderId, deliveryPartnerId) {
  return deliveryService.confirmReachedDropDelivery(orderId, deliveryPartnerId);
}

export async function verifyDropOtpDelivery(orderId, deliveryPartnerId, otp) {
  return deliveryService.verifyDropOtpDelivery(orderId, deliveryPartnerId, otp);
}

export async function completeDelivery(orderId, deliveryPartnerId, body = {}) {
  return deliveryService.completeDelivery(orderId, deliveryPartnerId, body);
}

export async function updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus) {
  return deliveryService.updateOrderStatusDelivery(orderId, deliveryPartnerId, orderStatus);
}

// ----- COD QR collection -----
export async function createCollectQr(orderId, deliveryPartnerId, customerInfo = {}) {
  return paymentService.createCollectQr(orderId, deliveryPartnerId, customerInfo);
}

export async function getPaymentStatus(orderId, deliveryPartnerId) {
  return paymentService.getPaymentStatus(orderId, deliveryPartnerId);
}

export async function switchToCash(orderId, deliveryPartnerId) {
  return paymentService.switchToCash(orderId, deliveryPartnerId);
}

// ----- Admin -----

function applyAdminOrderSearchFilter(AND, searchRaw) {
  const search = String(searchRaw || '').trim().slice(0, 80);
  if (!search) return;

  const phoneDigits = search.replace(/\D/g, '');
  const orConditions = [
    { orderId: { contains: search, mode: 'insensitive' } },
    { order_id: { contains: search, mode: 'insensitive' } },
    { customerName: { contains: search, mode: 'insensitive' } },
    { customerPhone: { contains: search, mode: 'insensitive' } },
    // An order for someone else is found by either person.
    { recipientName: { contains: search, mode: 'insensitive' } },
    { recipientPhone: { contains: search, mode: 'insensitive' } },
    // Matched through the relation rather than a separate id lookup.
    { restaurant: { restaurantName: { contains: search, mode: 'insensitive' } } },
  ];

  if (phoneDigits.length >= 4) {
    orConditions.push({ customerPhone: { contains: phoneDigits } });
    orConditions.push({ recipientPhone: { contains: phoneDigits } });
  }

  AND.push({ OR: orConditions });
}

function applyAdminPaymentStatusFilter(AND, paymentStatusRaw) {
  const paymentStatus = String(paymentStatusRaw || '').trim().toLowerCase();
  if (!paymentStatus) return;

  if (paymentStatus === 'paid') {
    AND.push({
      OR: [
        { paymentStatus: { in: ['paid', 'authorized'] } },
        { AND: [{ paymentMethod: 'cash' }, { orderStatus: 'delivered' }] },
        {
          AND: [
            { paymentMethod: 'wallet' },
            { paymentStatus: { notIn: ['failed', 'refunded', 'created', 'cod_pending', 'pending_qr'] } },
          ],
        },
      ],
    });
    return;
  }

  if (paymentStatus === 'pending') {
    AND.push({
      OR: [
        { paymentStatus: { in: ['created', 'cod_pending', 'pending_qr'] } },
        { AND: [{ paymentMethod: 'cash' }, { orderStatus: { not: 'delivered' } }] },
      ],
    });
    return;
  }

  if (paymentStatus === 'failed') AND.push({ paymentStatus: 'failed' });
  if (paymentStatus === 'refunded') AND.push({ paymentStatus: 'refunded' });
}

function applyAdminAmountFilter(AND, minAmountRaw, maxAmountRaw) {
  const minAmount = Number(minAmountRaw);
  const maxAmount = Number(maxAmountRaw);
  const total = {};

  if (Number.isFinite(minAmount) && minAmount >= 0) total.gte = minAmount;
  if (Number.isFinite(maxAmount) && maxAmount >= 0) total.lte = maxAmount;
  if (Object.keys(total).length > 0) AND.push({ total });
}

export async function listOrdersAdmin(query) {
  // Unpaid online orders are cleared by the scheduler every few minutes, not
  // here: each one is a Razorpay call, which this page used to wait for.

  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 2000);
  const skip = (page - 1) * limit;

  const where = {};
  const AND = [];

  const rawStatus = typeof query.status === "string" ? query.status.trim().toLowerCase() : "";
  const cancelledBy =
    typeof query.cancelledBy === "string" ? query.cancelledBy.trim().toLowerCase() : "";
  const restaurantIdRaw = typeof query.restaurantId === "string" ? query.restaurantId.trim() : "";
  const zoneIdRaw = typeof query.zoneId === "string" ? query.zoneId.trim() : "";
  const startDateRaw = typeof query.startDate === "string" ? query.startDate.trim() : "";
  const endDateRaw = typeof query.endDate === "string" ? query.endDate.trim() : "";
  const searchRaw = typeof query.search === "string" ? query.search.trim() : "";
  const paymentStatusRaw =
    typeof query.paymentStatus === "string" ? query.paymentStatus.trim() : "";

  if (!rawStatus || rawStatus === "all") {
    where.orderStatus = { not: "pending_payment" };
  }

  if (rawStatus && rawStatus !== "all") {
    const terminalCancelledStatuses = [
      "cancelled_by_user", "cancelled_by_restaurant", "cancelled_by_admin",
    ];

    switch (rawStatus) {
      case "pending":
        // Not yet being prepared: placed and waiting for the restaurant, or
        // accepted and not started. The list labels both "Pending", and the
        // tab asked for "created" alone, so it sat empty while the All tab
        // showed pending orders.
        where.orderStatus = { in: ["created", "confirmed"] };
        break;
      case "processing":
        // Being prepared or ready, delivery partner not accepted yet.
        where.orderStatus = {
          notIn: ["created", "confirmed", "delivered", "pending_payment", ...terminalCancelledStatuses],
        };
        AND.push({ dispatchStatus: { not: "accepted" } });
        break;
      case "food-on-the-way":
        where.dispatchStatus = "accepted";
        where.orderStatus = { notIn: ["delivered", ...terminalCancelledStatuses] };
        break;
      case "delivered":
        where.orderStatus = "delivered";
        break;
      case "canceled":
      case "cancelled":
        where.orderStatus = { in: terminalCancelledStatuses };
        break;
      case "restaurant-cancelled":
        where.orderStatus = "cancelled_by_restaurant";
        break;
      case "payment-failed":
        where.paymentStatus = "failed";
        break;
      case "refunded":
        where.paymentStatus = "refunded";
        break;
      case "offline-payments":
        where.paymentMethod = "cash";
        where.orderStatus = { in: ["created", "confirmed", "delivered"] };
        break;
      default:
        break;
    }
  }

  if (cancelledBy) {
    if (cancelledBy === "restaurant") where.orderStatus = "cancelled_by_restaurant";
    else if (cancelledBy === "user" || cancelledBy === "customer") {
      where.orderStatus = "cancelled_by_user";
    }
  }

  if (isId(restaurantIdRaw)) where.restaurantId = restaurantIdRaw;

  // Zone is a property of the restaurant, so filter through the relation rather
  // than pre-resolving every restaurant id in the zone.
  if (isId(zoneIdRaw)) AND.push({ restaurant: { zoneId: zoneIdRaw } });

  if (startDateRaw || endDateRaw) {
    const createdAt = {};
    const start = startDateRaw ? new Date(startDateRaw) : null;
    const end = endDateRaw ? new Date(endDateRaw) : null;
    if (start && !Number.isNaN(start.getTime())) createdAt.gte = start;
    if (end && !Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  applyAdminOrderSearchFilter(AND, searchRaw);
  applyAdminPaymentStatusFilter(AND, paymentStatusRaw);
  applyAdminAmountFilter(AND, query.minAmount, query.maxAmount);
  if (AND.length) where.AND = AND;

  const [rows, total] = await Promise.all([
    prisma.foodOrder.findMany({
      where,
      include: withRelations(RESTAURANT_ADMIN, PARTNER_CARD),
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.foodOrder.count({ where }),
  ]);

  const paginated = buildPaginatedResult({
    docs: toOrders(rows).map((order) => normalizeOrderForClient(order)),
    total,
    page,
    limit,
  });
  return { ...paginated, orders: paginated.data };
}

export async function assignDeliveryPartnerAdmin(orderId, deliveryPartnerId, adminId) {
  // Kept for old callers. It set the order to 'assigned' without telling the
  // rider or timing out; the manual-dispatch assign does both.
  const { assignRiderManually } = await import('./manualDispatch.service.js');
  return assignRiderManually(orderId, deliveryPartnerId, adminId);
}

export async function deleteOrderAdmin(orderId, adminId) {
  const identity = buildOrderIdentityFilter(orderId);
  if (!identity) throw new ValidationError("Order id required");

  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  await purgeOrder(order.id);

  // Remove the realtime tracking node if present.
  try {
    const db = getFirebaseDB();
    if (db) await db.ref(`active_orders/${order.id}`).remove();
  } catch (err) {
    logger.warn(`Delete order firebase cleanup failed: ${err?.message || err}`);
  }

  // Notify connected apps so stale UI entries disappear without a refresh.
  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: order.id,
        orderId: order.id,
        deletedBy: "ADMIN",
        adminId: adminId ? String(adminId) : null,
      };
      if (row.userId) io.to(rooms.user(row.userId)).emit("order_deleted", payload);
      if (row.restaurantId) io.to(rooms.restaurant(row.restaurantId)).emit("order_deleted", payload);
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_deleted", payload);
      }
    }
  } catch (err) {
    logger.warn(`Delete order socket emit failed: ${err?.message || err}`);
  }

  enqueueOrderEvent("order_deleted_by_admin", {
    orderMongoId: order.id,
    orderId: order.id,
    adminId: adminId ? String(adminId) : null,
  });

  return { deleted: true, orderId: order.id, orderMongoId: order.id };
}

// `byRole` exists for the expiry watchdog: the same cancellation, but recorded
// against SYSTEM so the history does not claim a person did it.
/** What the restaurant's cancellation alert carries, all as strings. */
export function adminCancelFields(order, reason) {
  return {
    orderStatus: "cancelled_by_admin",
    orderId: String(order?.id || ""),
    orderDisplayId: String(order?.order_id || order?.orderId || order?.id || ""),
    cancellationReason: String(reason || "").trim() || "Cancelled by support",
  };
}

export async function updateOrderStatusAdmin(orderId, orderStatus, note = "", adminId, { byRole = "ADMIN" } = {}) {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  if (!Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, String(orderStatus))) {
    throw new ValidationError(`Invalid order status: ${orderStatus}`);
  }
  if (!isStatusAdvance(order.orderStatus, orderStatus)) {
    throw new ValidationError(
      `Cannot change order status from '${order.orderStatus}' to '${orderStatus}'`,
    );
  }

  const from = order.orderStatus;
  const normalizedPaymentMethod = String(order.paymentMethod || "cash").toLowerCase();
  const prevPaymentStatus = String(order.paymentStatus || "cod_pending").toLowerCase();
  const codBecomesPaid =
    String(orderStatus) === "delivered" &&
    normalizedPaymentMethod === "cash" &&
    prevPaymentStatus === "cod_pending";

  let refundPatch = {};
  if (String(orderStatus).includes("cancel")) {
    try {
      const refund = await applyCancellationRefund(order, { cancelledBy: 'admin' });
      refundPatch = refund.paymentPatch;
    } catch (err) {
      logger.warn(`Admin cancellation refund failed for order ${order.id}: ${err?.message || err}`);
      refundPatch = { refundStatus: "failed" };
    }
  }

  let updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: { orderStatus, ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}), ...refundPatch },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole,
    byId: adminId,
    from,
    to: orderStatus,
    note: note || "Status updated by admin",
  });

  if (String(orderStatus) === "delivered") {
    try {
      const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
      await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
        status: "captured",
        recordedByRole: "ADMIN",
        recordedById: adminId,
        note: `Delivery completed from admin flow. Prev payment status: ${prevPaymentStatus}`,
      });
    } catch (err) {
      logger.warn(`updateOrderStatusAdmin delivered transaction sync failed: ${err?.message || err}`);
    }
  }

  // The customer hears about a support change the same way as any other: the
  // fixed customer events, or the cancellation push below.
  const isAdminCancel = String(orderStatus).includes("cancel");
  // On a cancellation the restaurant gets its own alarm (below) instead of
  // the ordinary notice.
  const notifyList = [
    ...(isAdminCancel ? [{ ownerType: "USER", ownerId: updated.userId }] : []),
    ...(isAdminCancel ? [] : [{ ownerType: "RESTAURANT", ownerId: updated.restaurantId }]),
  ];
  if (row.dispatchDeliveryPartnerId) {
    notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: row.dispatchDeliveryPartnerId });
  }
  if (!isAdminCancel) void notifyCustomerForStatus(updated.id, orderStatus);

  let title = `Order Status Updated 📋`;
  let body = `Order #${updated.order_id || updated.id} status changed to ${String(orderStatus).replace(/_/g, " ")} by support.`;

  if (orderStatus === "confirmed") {
    title = "Order Accepted! 🧑‍🍳";
    body = "The order has been accepted and is starting to be prepared.";
  } else if (orderStatus === "preparing") {
    title = "Food is being prepared! 🍳";
    body = "Your food is currently being prepared by the restaurant.";
  } else if (orderStatus === "ready_for_pickup") {
    title = "Food is ready! 🛍️";
    body = "Your order is ready and waiting to be picked up.";
  } else if (String(orderStatus).includes("cancel")) {
    title = "Order Cancelled ❌";
    body = (note && String(note).trim()) ? note : `Unfortunately, your order has been cancelled by support.`;
  }

  await notifyOwnersSafely(notifyList, {
    title,
    body,
    data: { type: "order_status_update", orderId: updated.id, orderStatus: String(orderStatus || "") },
  });

  // The restaurant must not miss a cancellation: it may be cooking the order.
  // Every signed-in phone gets a high-priority push carrying the reason, which
  // the app turns into a ringing "Order cancelled by admin" screen. Sent as
  // the visible + data-only pair (see notifyOwnersActionableAlert): the data
  // leg is what lets the app ring in a loop, the visible leg still shows on
  // phones that will not start the app in the background.
  if (isAdminCancel) {
    const fields = adminCancelFields(updated, note);
    void notifyOwnersActionableAlert(
      [{ ownerType: "RESTAURANT", ownerId: updated.restaurantId }],
      {
        title: "Order cancelled by admin",
        body: `Order #${fields.orderDisplayId} was cancelled. Reason: ${fields.cancellationReason}`,
        androidTag: `order_cancel_${updated.id}`,
        androidChannelId: "new_order_channel",
        data: { type: "order_status_update", orderMongoId: updated.id, ...fields },
      },
    ).catch((err) => logger.warn(`Admin-cancel alert to restaurant failed for ${updated.id}: ${err?.message || err}`));
  }

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: updated.orderStatus,
        message: body,
        title,
        note: updated.note || "",
        statusNote: note || "",
      };
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", {
        ...payload,
        ...(isAdminCancel ? adminCancelFields(updated, note) : {}),
      });
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_status_update", payload);
      }

      if (
        (String(orderStatus) === "preparing" || String(orderStatus) === "confirmed") &&
        String(from) !== "preparing" && String(from) !== "confirmed"
      ) {
        try {
          await tryAutoAssign(order.id);
          updated = toOrder(
            await prisma.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude }),
          );
        } catch (err) {
          logger.warn(`Auto-assign in updateOrderStatusAdmin failed: ${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`Admin status update socket emit failed: ${err?.message || err}`);
  }

  return normalizeOrderForClient(updated);
}

export async function markOrderDeliveredAdmin(orderId, adminId, note = "") {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  const from = String(order.orderStatus || "");
  if (from === "delivered") throw new ValidationError("Order is already delivered");
  if (from.includes("cancel") || from === "pending_payment") {
    throw new ValidationError(`Cannot mark order as delivered from status '${from}'`);
  }

  const normalizedPaymentMethod = String(order.paymentMethod || "cash").toLowerCase();
  const prevPaymentStatus = String(order.paymentStatus || "cod_pending").toLowerCase();
  const codBecomesPaid = normalizedPaymentMethod === "cash" && prevPaymentStatus === "cod_pending";

  const updated = toOrder(await prisma.foodOrder.update({
    where: { id: order.id },
    data: {
      orderStatus: "delivered",
      deliveryPhase: "delivered",
      deliveryStatus: "delivered",
      deliveredAt: row.deliveredAt || new Date(),
      ...(codBecomesPaid ? { paymentStatus: 'paid' } : {}),
    },
    include: orderInclude,
  }));

  await pushStatusHistory(order.id, {
    byRole: "ADMIN",
    byId: adminId,
    from,
    to: "delivered",
    note: note || "Order marked as delivered by admin",
  });

  try {
    const ledgerKind = codBecomesPaid ? "cod_marked_paid_on_delivery" : "payment_snapshot_sync";
    await foodTransactionService.updateTransactionStatus(order.id, ledgerKind, {
      status: "captured",
      recordedByRole: "ADMIN",
      recordedById: adminId,
      note: `Delivery completed by admin override. Prev payment status: ${prevPaymentStatus}`,
    });
  } catch (err) {
    logger.warn(`markOrderDeliveredAdmin transaction sync failed: ${err?.message || err}`);
  }

  const orderLabel = updated.order_id || updated.id;
  // The customer gets the one "delivered" push, however delivery was marked.
  void notifyCustomer(updated.id, "delivered");
  const notifyList = [
    { ownerType: "RESTAURANT", ownerId: updated.restaurantId },
  ];
  if (row.dispatchDeliveryPartnerId) {
    notifyList.push({ ownerType: "DELIVERY_PARTNER", ownerId: row.dispatchDeliveryPartnerId });
  }

  await notifyOwnersSafely(notifyList, {
    title: "Order Delivered! 🎉",
    body: `Order #${orderLabel} has been marked as delivered by support.`,
    data: { type: "order_status_update", orderId: updated.id, orderStatus: "delivered" },
  });

  try {
    const io = getIO();
    if (io) {
      const payload = {
        orderMongoId: updated.id,
        orderId: updated.id,
        orderStatus: "delivered",
        deliveryState: updated.deliveryState,
        message: `Order #${orderLabel} marked as delivered by admin.`,
        title: "Order Delivered! 🎉",
      };
      io.to(rooms.user(updated.userId)).emit("order_status_update", payload);
      io.to(rooms.restaurant(updated.restaurantId)).emit("order_status_update", payload);
      if (row.dispatchDeliveryPartnerId) {
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_status_update", payload);
        io.to(rooms.delivery(row.dispatchDeliveryPartnerId)).emit("order_completed", payload);
      }
    }
  } catch (err) {
    logger.warn(`markOrderDeliveredAdmin socket emit failed: ${err?.message || err}`);
  }

  enqueueOrderEvent("delivery_completed", {
    orderMongoId: updated.id,
    orderId: updated.id,
    adminId: adminId ? String(adminId) : null,
    payMethod: normalizedPaymentMethod,
    prevPayStatus: prevPaymentStatus,
    paymentStatus: updated.paymentStatus,
    source: "admin_override",
  });

  return normalizeOrderForClient(updated);
}

export async function processRefundAdmin(orderId, amount, adminId, destination = 'original') {
  const identity = buildOrderIdentityFilter(orderId);
  const row = await prisma.foodOrder.findFirst({ where: identity, include: orderInclude });
  if (!row) throw new NotFoundError("Order not found");
  const order = toOrder(row);

  const requested = amount == null || amount === "" ? null : Number(amount);
  if (requested != null && !(requested > 0)) throw new ValidationError("Invalid refund amount");

  // strict: asking for more than is left is an error here, not quietly less.
  const refundResult = await applyCancellationRefund(order, {
    cancelledBy: 'admin',
    refundAmount: requested,
    destination,
    strict: true,
    initiatedById: adminId,
  });

  if (!refundResult.attempted) {
    if (refundResult.reason === 'cash_payment') {
      throw new ValidationError('Cash on Delivery orders do not require a refund');
    }
    if (refundResult.reason === 'already_refunded') {
      throw new ValidationError('Nothing is left to refund on this order');
    }
    throw new ValidationError('This order has not been paid, so there is nothing to refund');
  }
  if (!refundResult.processed) {
    throw new ValidationError(`Refund failed: ${refundResult.reason || 'the payment gateway refused it'}`);
  }
  const refundAmount = refundResult.legs
    .filter((l) => l.status !== 'failed')
    .reduce((sum, l) => sum + Number(l.amount), 0);

  try {
    await foodTransactionService.updateTransactionStatus(order.id, order.orderStatus, {
      status: 'refunded',
      note: `Refund of ₹${refundAmount} processed by admin`,
      recordedByRole: 'ADMIN',
      recordedById: adminId,
    });
  } catch (err) {
    logger.warn(`Admin refund transaction sync failed: ${err?.message || err}`);
  }

  const updated = toOrder(
    await prisma.foodOrder.findUnique({ where: { id: order.id }, include: orderInclude }),
  );

  if (updated.userId) {
    await notifyOwnersSafely([{ ownerType: "USER", ownerId: updated.userId }], {
      title: "Refund Processed! 💸",
      body: `Refund for Order #${updated.order_id || updated.id}: ${refundResult.message || `₹${refundAmount} has been processed.`}`,
      image: BRAND_IMAGE_URL,
      data: {
        type: "refund_processed",
        orderId: String(updated.order_id || updated.id),
        orderRowId: updated.id,
      },
    }).catch((err) => {
      logger.warn(`Refund notification failed for order ${updated.id}: ${err?.message || err}`);
    });
  }

  return { success: true, order: normalizeOrderForClient(updated) };
}
