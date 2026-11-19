import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getDeliveryCashLimitSettings } from '../../admin/services/admin.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    createRazorpayOrder,
    getRazorpayKeyId,
    isRazorpayConfigured,
    verifyPaymentSignature,
    fetchRazorpayPayment,
} from '../../orders/helpers/razorpay.helper.js';
import { logger } from '../../../../utils/logger.js';
import { recordTransaction } from '../../../../core/payments/transaction.service.js';
import { riderBalance } from './riderBalance.service.js';

const num = (v) => Number(v) || 0;
const money2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** The rider's wallet row in the unified wallets table. */
const walletKey = (deliveryPartnerId) => ({
    entityType_entityId: { entityType: 'deliveryBoy', entityId: String(deliveryPartnerId) },
});

/**
 * Enhanced wallet fetch for delivery partners. Integrates:
 * 1. Historical orders (earnings)
 * 2. Admin bonuses
 * 3. Withdrawals (pending/payout)
 * 4. Cash collected vs limit
 */
export const getDeliveryPartnerWalletEnhanced = async (deliveryPartnerId) => {
    if (!isId(deliveryPartnerId)) throw new ValidationError('Invalid delivery partner ID');
    const partnerId = String(deliveryPartnerId);

    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new ValidationError('Delivery partner not found');

    const [
        cashLimitSettings,
        earningsAgg,
        cashCollectedAgg,
        cashDepositsAgg,
        bonusAgg,
        withdrawalsByStatus,
        withdrawalsList,
        depositList,
        walletDoc,
        ordersTx,
    ] = await Promise.all([
        getDeliveryCashLimitSettings(),
        // 1. Total earnings from delivered orders
        Promise.all([
            prisma.foodOrder.aggregate({
                where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
                _sum: { riderEarning: true },
            }),
            // Pay for orders cancelled while the rider was on them.
            prisma.foodOrder.aggregate({
                where: { dispatchDeliveryPartnerId: partnerId, riderCancelPay: { gt: 0 } },
                _sum: { riderCancelPay: true },
            }),
        ]).then(([delivered, cancelled]) => ({
            _sum: { riderEarning: num(delivered._sum.riderEarning) + num(cancelled._sum.riderCancelPay) },
        })),
        // 2. Gross cash collected (COD orders)
        prisma.foodOrder.aggregate({
            where: {
                dispatchDeliveryPartnerId: partnerId,
                orderStatus: 'delivered',
                paymentMethod: 'cash',
            },
            _sum: { total: true },
        }),
        // 3. Cash deposits (deduct from cash-in-hand)
        prisma.foodDeliveryCashDeposit.aggregate({
            where: { deliveryPartnerId: partnerId, status: 'Completed' },
            _sum: { amount: true },
        }),
        // 4. Admin bonuses
        prisma.deliveryBonusTransaction.aggregate({
            where: { deliveryPartnerId: partnerId },
            _sum: { amount: true },
        }),
        // 5. Withdrawal totals. groupBy replaces the $cond sums — one pass, one row per status.
        prisma.foodDeliveryWithdrawal.groupBy({
            by: ['status'],
            where: { deliveryPartnerId: partnerId },
            _sum: { amount: true },
        }),
        // 6. Recent history
        prisma.foodDeliveryWithdrawal.findMany({
            where: { deliveryPartnerId: partnerId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
        prisma.foodDeliveryCashDeposit.findMany({
            where: { deliveryPartnerId: partnerId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
        prisma.wallet.findUnique({ where: walletKey(partnerId) }),
        prisma.foodOrder.findMany({
            where: {
                dispatchDeliveryPartnerId: partnerId,
                OR: [{ orderStatus: 'delivered' }, { riderCancelPay: { gt: 0 } }],
            },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, orderId: true, riderEarning: true, paymentMethod: true,
                orderStatus: true, createdAt: true, riderCancelPay: true, riderCancelPayReason: true,
            },
            take: 20,
        }),
    ]);

    const byStatus = (status) =>
        num(withdrawalsByStatus.find((r) => r.status === status)?._sum?.amount);

    const grossCashCollected = num(cashCollectedAgg?._sum?.total);
    const totalDepositedCash = num(cashDepositsAgg?._sum?.amount);
    const computedCashInHand = Math.max(0, grossCashCollected - totalDepositedCash);
    const cashInHand = Math.max(computedCashInHand, num(walletDoc?.cashInHand));

    const totalCashLimit = num(cashLimitSettings.deliveryCashLimit);
    const deliveryWithdrawalLimit = num(cashLimitSettings.deliveryWithdrawalLimit) || 100;

    // One calculation for every screen (see riderBalance.service.js). This
    // took the larger of the order totals and the ledger's lifetime counter,
    // which already held every bonus, so bonuses and add-ons counted twice.
    const balance = await riderBalance(partnerId);
    const totalEarned = balance.earned;
    const totalBonus = money2(balance.bonus + balance.adjustments);
    const totalWithdrawn = balance.paidOut;
    const pendingWithdrawals = balance.pending;
    const effectiveLockedAmount = pendingWithdrawals;
    const pocketBalance = balance.available;

    const transactions = [
        ...(ordersTx || []).map((o) => {
            const cancelled = o.orderStatus !== 'delivered';
            return {
                id: o.id,
                type: 'payment',
                amount: cancelled ? num(o.riderCancelPay) : num(o.riderEarning),
                status: 'Completed',
                date: o.createdAt,
                description: cancelled
                    ? `Cancelled order pay: ${o.riderCancelPayReason || 'cancelled'}`
                    : o.paymentMethod === 'cash' ? 'COD delivery earning' : 'Online delivery earning',
                orderId: o.orderId,
            };
        }),
        ...(withdrawalsList || []).map((w) => ({
            id: w.id,
            type: 'withdrawal',
            amount: num(w.amount),
            status: w.status === 'pending' ? 'Pending' : w.status === 'approved' ? 'Completed' : 'Rejected',
            date: w.createdAt,
            description: `Withdrawal Request - ${w.paymentMethod}`,
            payoutMethod: w.paymentMethod,
        })),
        ...(depositList || []).map((d) => ({
            id: d.id,
            type: 'deposit',
            amount: num(d.amount),
            status: d.status || 'Pending',
            date: d.createdAt,
            description: 'Cash limit settlement',
            paymentMethod: d.paymentMethod || 'cash',
            razorpayPaymentId: d.razorpayPaymentId || '',
            razorpayOrderId: d.razorpayOrderId || '',
        })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    return {
        totalBalance: totalEarned + totalBonus, // gross lifetime earnings
        pocketBalance,                          // available to withdraw
        cashInHand,                             // COD still to be deposited
        totalWithdrawn,                         // actually paid out
        pendingWithdrawals,                     // in process
        lockedAmount: effectiveLockedAmount,
        totalEarned,
        totalBonus,
        totalCashLimit,
        availableCashLimit: Math.max(0, totalCashLimit - cashInHand),
        deliveryWithdrawalLimit,
        transactions: transactions.slice(0, 50),
    };
};

/**
 * Submit a new withdrawal request for a delivery partner.
 */
export const requestDeliveryWithdrawal = async (deliveryPartnerId, payload) => {
    const amount = Number(payload?.amount);
    const { bankDetails, paymentMethod = 'bank_transfer' } = payload;

    if (!Number.isFinite(amount) || amount < 1) throw new ValidationError('Invalid amount');

    const wallet = await getDeliveryPartnerWalletEnhanced(deliveryPartnerId);
    if (amount < wallet.deliveryWithdrawalLimit) {
        throw new ValidationError(`Minimum withdrawal amount is ₹${wallet.deliveryWithdrawalLimit}`);
    }
    // The balance is checked inside the lock below, where it cannot change.
    const partnerId = String(deliveryPartnerId);
    const partner = await prisma.foodDeliveryPartner.findUnique({ where: { id: partnerId } });
    if (!partner) throw new ValidationError('Delivery partner not found');

    // One rider at a time, checked inside the lock: two taps on Withdraw (or a
    // retried request) each passed the balance check on their own and each
    // created a request -- five ₹300 requests in a minute on one account.
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider_withdrawal:${partnerId}`}))`;

        const waiting = await tx.foodDeliveryWithdrawal.findFirst({
            where: { deliveryPartnerId: partnerId, status: 'pending' },
            select: { amount: true },
        });
        if (waiting) {
            throw new ValidationError(
                `You already have a withdrawal of ₹${num(waiting.amount)} waiting. You can ask again once it is paid.`,
            );
        }

        const balance = await riderBalance(partnerId, tx);
        if (amount > balance.available) {
            throw new ValidationError(`You can withdraw up to ₹${balance.available}`);
        }

        return tx.foodDeliveryWithdrawal.create({
            data: {
                deliveryPartnerId: partnerId,
                amount,
                paymentMethod,
                bankDetails: bankDetails || {
                    accountNumber: partner.bankAccountNumber,
                    ifscCode: partner.bankIfscCode,
                    bankName: partner.bankName,
                    accountHolderName: partner.bankAccountHolderName,
                },
                upiId: partner.upiId,
                upiQrCode: partner.upiQrCode,
                status: 'pending',
            },
        });
    });
};

export const createDeliveryCashDepositOrder = async (deliveryPartnerId, amountInr) => {
    const amount = Number(amountInr);
    if (!Number.isFinite(amount) || amount < 1) {
        throw new ValidationError('Amount must be at least ₹1');
    }
    if (amount > 500000) {
        throw new ValidationError('Maximum deposit is ₹5,00,000');
    }

    const wallet = await getDeliveryPartnerWalletEnhanced(deliveryPartnerId);
    if (amount > wallet.cashInHand) {
        throw new ValidationError('Deposit amount cannot exceed cash in hand');
    }

    const amountPaise = Math.round(amount * 100);
    const receipt = `cash_deposit_${String(deliveryPartnerId).slice(-8)}_${Date.now()}`;

    // No gateway, no online deposit. This used to hand back a made-up order,
    // which the verify step below then accepted without any payment.
    if (!isRazorpayConfigured()) {
        throw new ValidationError('Online cash deposit is not available right now. Please deposit at the office.');
    }

    const order = await createRazorpayOrder(amountPaise, 'INR', receipt);
    return {
        razorpay: {
            key: getRazorpayKeyId(),
            orderId: String(order.id),
            amount: Number(order.amount) || amountPaise,
            currency: order.currency || 'INR',
        },
    };
};

export const verifyDeliveryCashDepositPayment = async (deliveryPartnerId, payload = {}) => {
    const partnerId = String(deliveryPartnerId);
    const orderId = String(payload?.razorpayOrderId || '').trim();
    const paymentId = String(payload?.razorpayPaymentId || '').trim();
    const signature = String(payload?.razorpaySignature || '').trim();
    const amount = Number(payload?.amount);

    if (!orderId) throw new ValidationError('razorpayOrderId is required');
    if (!paymentId) throw new ValidationError('razorpayPaymentId is required');
    if (!signature) throw new ValidationError('razorpaySignature is required');
    if (!Number.isFinite(amount) || amount < 1) throw new ValidationError('amount is required');

    const existing = await prisma.foodDeliveryCashDeposit.findFirst({
        where: {
            deliveryPartnerId: partnerId,
            OR: [{ razorpayPaymentId: paymentId }, { razorpayOrderId: orderId }],
        },
    });

    if (existing?.status === 'Completed') {
        return { deposit: existing, wallet: await getDeliveryPartnerWalletEnhanced(partnerId) };
    }

    // Without a gateway there is nothing to verify against, so nothing is
    // accepted. This used to treat "not configured" as valid: a rider could
    // post any ids and clear their cash in hand without paying a rupee.
    if (!isRazorpayConfigured()) {
        throw new ValidationError('Online cash deposit is not available right now. Please deposit at the office.');
    }
    if (!verifyPaymentSignature(orderId, paymentId, signature)) {
        throw new ValidationError('Payment verification failed');
    }

    // The signature proves the payment belongs to this order — it says NOTHING about
    // how much was paid. Trusting the client's `amount` let a rider pay Rs 1 and post
    // amount: 5000, clearing Rs 5000 of cash-in-hand while pocketing the difference.
    // Always settle on the amount Razorpay actually captured.
    let settledAmount = amount;
    if (isRazorpayConfigured()) {
        const payment = await fetchRazorpayPayment(paymentId);

        const capturedPaise = Number(payment?.amount);
        if (!Number.isFinite(capturedPaise) || capturedPaise <= 0) {
            throw new ValidationError('Could not confirm the paid amount with Razorpay');
        }
        if (!['captured', 'authorized'].includes(String(payment?.status || ''))) {
            throw new ValidationError(`Payment is not captured (status: ${payment?.status || 'unknown'})`);
        }
        // Reject a payment belonging to a different Razorpay order.
        if (payment?.order_id && String(payment.order_id) !== orderId) {
            throw new ValidationError('Payment does not belong to this order');
        }

        settledAmount = Math.round((capturedPaise / 100) * 100) / 100;
        if (Math.abs(settledAmount - amount) > 0.01) {
            logger.warn(
                `Cash deposit amount mismatch for partner ${partnerId}: client claimed ${amount}, Razorpay captured ${settledAmount}. Using the captured amount.`,
            );
        }
    }

    const wallet = await getDeliveryPartnerWalletEnhanced(partnerId);
    if (settledAmount > wallet.cashInHand) {
        throw new ValidationError('Deposit amount cannot exceed cash in hand');
    }

    // settledAmount on BOTH paths. The update branch used to write the client-supplied
    // `amount`, which is exactly the value the check above exists to distrust — so a
    // deposit that reached this branch could still clear more cash than was paid.
    const depositData = {
        amount: settledAmount,
        paymentMethod: isRazorpayConfigured() ? 'razorpay' : 'cash',
        status: 'Completed',
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
    };

    const deposit = existing
        ? await prisma.foodDeliveryCashDeposit.update({ where: { id: existing.id }, data: depositData })
        : await prisma.foodDeliveryCashDeposit.create({
            data: { deliveryPartnerId: partnerId, ...depositData },
        });

    return { deposit, wallet: await getDeliveryPartnerWalletEnhanced(partnerId) };
};
