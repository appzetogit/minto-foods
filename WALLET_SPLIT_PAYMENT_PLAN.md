# Wallet + Online Split Payment, and Split Refunds

**Goal:** a customer can pay part of an order from their Minto wallet and the rest online (Razorpay). If the order is cancelled, the wallet part goes back to the wallet instantly and the online part goes back to the card, UPI or bank account it came from.

**Example:** order ₹450, wallet balance ₹120.
- At checkout: ₹120 from wallet + ₹330 through Razorpay.
- If cancelled: ₹120 back to the wallet at once; ₹330 refunded to the original UPI or card (5–7 working days, Razorpay's normal time).

---

## 1. What exists today (and what we can reuse)

| Piece | Today | Reuse? |
|---|---|---|
| Payment methods on an order | One of `cash`, `razorpay`, `razorpay_qr`, `wallet` (`FoodOrder.paymentMethod`) | Keep; add the split amounts next to it |
| Wallet pay | Whole total debited after the order row is created (`order.service.js` `createOrder`, `deductWalletBalance`) | Replace with hold-then-capture for split orders |
| Wallet hold | `lockWalletAmount` / `unlockWalletAmount` in `core/payments/wallet.service.js` (race-safe, raw SQL guard) | **Yes**, this is exactly the "reserve" step |
| Online pay | Razorpay order created for `total`, verified by amount in paise (`verifyPayment`, webhook) | Yes, just charge `onlineAmount` instead of `total` |
| Refund on cancel | `applyCancellationRefund` refunds **one** method: all to Razorpay, or all to wallet. Claims `refundStatus: 'pending'` first so it never pays twice | Extend to refund **both legs** |
| Refund ledger | `Refund` rows per `Payment`, with `refundTo: gateway \| wallet` (`core/payments/refund.service.js`) | Yes, one `Refund` row per leg |

The groundwork is good: the wallet can already hold money safely, and the refund code already stops double refunds. The work is making an order carry **two amounts** and teaching checkout, payment confirmation and cancellation to handle both.

---

## 2. Design decisions

1. **Wallet is used first, online pays the rest.** The customer ticks "Use wallet balance (₹120)". The app does not pick amounts itself; the server works them out.
2. **Take the wallet part at order time; give it back if the online part is never paid.** *(Changed during build.)* The plan first said "hold" (lock) the wallet amount. The wallet's overdraw check ignores locked money, so a hold could be spent by another order and the capture would fail at the worst moment. Instead, the wallet part is debited when the order is created (one-time ledger key `order_wallet_debit:{orderId}`). If the payment is abandoned, fails or expires, it is credited back (key `order_wallet_return:{orderId}`) in the same database transaction that removes the unpaid order, so it can never be lost or returned twice.
3. **The server decides the split, never the app.** `walletAmount = min(available wallet balance, total)` and `onlineAmount = total − walletAmount`. The app only sends `useWallet: true`.
4. **Razorpay minimum is ₹1.** If the online remainder would be between ₹0.01 and ₹0.99, use ₹1 less from the wallet so the online part is exactly ₹1.
5. **If the wallet covers everything,** the order becomes a plain wallet order (no Razorpay screen), exactly as today.
6. **Refund each leg to where it came from.** Wallet leg → wallet (instant). Online leg → Razorpay refund to the original method.
7. **Partial refunds** (e.g. admin refunds ₹100 for a missing item) come off the **online leg first**, then the wallet. The customer gets real money back first; wallet balance is store credit. The admin can override and send it all to the wallet (instant).
8. **Wallet + cash on delivery**: not in phase 1. It is possible later (the rider collects only the remainder), but it touches rider cash-in-hand and COD limits, so it should be its own change.

---

## 3. Database changes (one Prisma migration)

On `FoodOrder`:

```prisma
walletAmount         Decimal  @default(0) @db.Decimal(14, 2) // paid from wallet
onlineAmount         Decimal  @default(0) @db.Decimal(14, 2) // paid through Razorpay
walletHoldStatus     WalletHoldStatus @default(none)          // none | held | captured | released
walletRefundAmount   Decimal  @default(0) @db.Decimal(14, 2)
onlineRefundAmount   Decimal  @default(0) @db.Decimal(14, 2)
```

```prisma
enum WalletHoldStatus { none  held  captured  released }
```

- `paymentMethod` stays `razorpay` for split orders (the online part decides the flow); `walletAmount > 0` is what marks it as split.
- `walletAmount + onlineAmount = total` is enforced with a CHECK constraint in `constraints.sql`.
- Existing orders: backfill `walletAmount = total` for wallet orders, `onlineAmount = total` for Razorpay orders. No behaviour change for them.
- The existing `refundAmount` / `refundStatus` stay as the order-level totals (admin screens and reports already read them).

---

## 4. Checkout flow (server)

**`calculateOrder`** (cart preview): return `walletBalance`, `walletApplicable`, `walletAmount` and `onlineAmount` so the app can show "₹120 from wallet, pay ₹330".

**`createOrder`** with `paymentMethod: 'razorpay'`, `useWallet: true`:

1. Price the order as today → `total`.
2. Read the available balance (`balance − lockedAmount`) and work out `walletAmount` and `onlineAmount` (rules in §2).
3. Create the order in `pending_payment` with both amounts.
4. `lockWalletAmount('user', userId, walletAmount)` → `walletHoldStatus: 'held'`.
   If the lock fails (balance spent on another tab), delete the order and return "Your wallet balance changed, please review".
5. Create the Razorpay order for **`onlineAmount`** (not `total`).
6. Return the Razorpay payload as today.

**Online payment confirmed** (`verifyPayment` **and** the webhook; both already claim `paymentStatus: 'paid'` atomically):

7. Check the Razorpay amount equals **`onlineAmount`** in paise (today it compares to `total`).
8. In the same step that claims `paid`: unlock the hold **and** debit the wallet with idempotency key `order_wallet:{orderId}` → `walletHoldStatus: 'captured'`.
   Write two `Payment` rows: one `method: wallet` for `walletAmount`, one `method: razorpay` for `onlineAmount`. The refund ledger then works per leg.
9. `finalizeOrderPayment` as today.

**Payment failed, abandoned or expired** (`abandonOnlinePaymentOrder`, `expireStalePendingPaymentOrders`, `payment.failed` webhook):

10. `unlockWalletAmount` → `walletHoldStatus: 'released'`, only if still `held` (conditional update, so it runs once).

**Late payment edge case:** Razorpay confirms after we already expired the order and released the hold. The existing reconcile (`reconcileOrderPayment`) must then take the wallet part again. If the customer has spent it meanwhile, refund the online part in full and cancel, with a notification. This is the one tricky case and needs its own test.

---

## 5. Cancellation and refund flow

Rewrite `applyCancellationRefund` in `order.service.js` to refund **per leg**:

```
refundTotal = requested amount (default: full total)
onlinePart  = min(refundTotal, onlineAmount − onlineRefundAmount)
walletPart  = refundTotal − onlinePart           (≤ walletAmount − walletRefundAmount)
```

For a full cancellation this gives: online leg → all of `onlineAmount`; wallet leg → all of `walletAmount`.

Steps:
1. **Claim** the refund as today (`refundStatus: 'pending'` conditional update); this already prevents double refunds.
2. **Wallet leg:** `initiateRefund({ paymentId: walletPayment.id, amount: walletPart, refundTo: 'wallet' })`, instant; idempotency key `order_refund:{refundId}`.
3. **Online leg:** `initiateRefund({ paymentId: razorpayPayment.id, amount: onlinePart, refundTo: 'gateway' })`, then `processGatewayRefund`. Razorpay's `refund.processed` / `refund.failed` webhooks (already handled) update the row.
4. **Order status after both legs:**
   - both done → `paymentStatus: 'refunded'`, `refundStatus: 'processed'`
   - wallet done, gateway pending → `refundStatus: 'pending'` (webhook finishes it)
   - gateway failed → `refundStatus: 'failed'`; the wallet leg stays done. Admin sees "Online part failed, retry or send to wallet".
5. If the order was cancelled **before** payment was confirmed (hold still `held`), there is nothing to refund: just release the hold.

**Who can cancel, and how much comes back:** no change from today (user before acceptance, restaurant, admin, auto-cancel on timeout). Each of these calls `applyCancellationRefund`, so all of them get split refunds automatically.

**Customer message:**
> "₹120 has been added back to your Minto wallet. ₹330 will be refunded to your original payment method within 5–7 working days."

---

## 6. Admin panel

- **Order details:** a "Payment" block showing "Wallet ₹120 + Online ₹330 (UPI)", and a "Refund" block with each leg's status, amount, Razorpay refund id and date.
- **Refund action on an order:** amount box, plus a choice of "Original method (online first)" or "All to wallet (instant)", following §2.7. It shows how the amount will be split before confirming.
- **Failed online refund:** "Retry" and "Send to wallet instead" buttons.
- **Orders list filter:** payment method gains "Wallet + Online".
- **Transaction report / GMV:** count `total` as today; the split only changes *how* it was paid.

---

## 7. Customer app (Flutter), for the app developer

- Checkout: a "Use Minto wallet (₹120 available)" toggle, shown when balance > 0.
- When on, show "Wallet −₹120" and "To pay ₹330" in the bill; the button reads "Pay ₹330".
- Send `useWallet: true` with `paymentMethod: 'razorpay'`, and open Razorpay with the **amount the server returns**, not a figure the app works out itself.
- If wallet covers the whole order, skip Razorpay (server returns `paymentMethod: 'wallet'`).
- Order details and the cancellation screen show both refund lines (text from §5).
- The wallet history shows "Held for order #123" while payment is pending (optional, nice to have).

The existing `.md` guide for the Flutter developer gets a new section with the exact request and response fields.

---

## 8. Tests (must pass before release)

1. Split order paid → wallet debited once, two `Payment` rows, amounts add up to total.
2. Payment abandoned or failed → hold released, balance unchanged.
3. Two orders at once trying to use the same wallet balance → only one gets the hold.
4. `verifyPayment` and webhook arrive together → wallet debited exactly once.
5. Full cancel → wallet leg back instantly, online leg refunded via Razorpay.
6. Partial refund ₹100 → comes off online first; ₹400 on a ₹330 online leg → ₹330 online + ₹70 wallet.
7. Online refund fails → wallet leg still done, order shows failed, admin retry works.
8. Two cancellations at once (admin + restaurant) → refunded once.
9. Late Razorpay capture after expiry → wallet re-taken or online refunded.
10. Remainder under ₹1 → online part forced to ₹1.
11. Old wallet-only and Razorpay-only orders behave exactly as before.

---

## 9. Build order and estimate

| Step | Work | Estimate |
|---|---|---|
| 1 | Migration, backfill, CHECK constraint | 0.5 day |
| 2 | Checkout: split calculation, hold, Razorpay for remainder | 1 day |
| 3 | Confirm, fail, expire and late-capture handling | 1 day |
| 4 | Split refunds in `applyCancellationRefund` + admin refund choice | 1 day |
| 5 | Admin order-detail and refund UI | 1 day |
| 6 | Tests from §8 | 1 day |
| 7 | Flutter guide section; Flutter app work (their side) | 0.5 day ours |

**About 6 working days of backend and admin work**, plus the Flutter developer's checkout toggle.

**Blocker before any of this can go live:** online payments still need the **live Razorpay keys and the webhook** set on the server (still test keys and placeholders). Split payments depend on Razorpay exactly like normal online orders do.

---

## 10. Questions for the client

1. Can **all** wallet money be used on orders, including referral rewards or cashback, or only topped-up money?
2. Should customers get a choice at cancellation, "Refund everything to wallet (instant)" vs "to original method"? Many apps offer instant wallet refund as the default.
3. Is there a cap on how much wallet can be used per order (some apps allow max 50%)? The design supports a cap easily.
