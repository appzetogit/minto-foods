import { useState, useEffect, useMemo } from "react"
import { Wallet } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@food/components/ui/dialog"
import { Button } from "@food/components/ui/button"

const rupees = (n) => `₹${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)}`
const paise = (n) => Math.round(Number(n || 0) * 100)

/**
 * What the order was paid with and what is still refundable, from the order's
 * payment block. The server works this out again and refuses anything over it;
 * this is only so the admin sees the numbers before confirming.
 */
export function refundPicture(order) {
  const payment = order?.payment || {}
  const method = String(payment.method || order?.paymentMethod || "").toLowerCase()
  const paid = ["paid", "refunded"].includes(String(payment.status || "").toLowerCase())
  const total = Number(order?.totalAmount ?? order?.pricing?.total ?? 0)
  let wallet = paise(payment.walletAmount)
  let online = paise(payment.onlineAmount)
  let cash = 0
  if (wallet === 0 && online === 0) {
    if (method === "wallet") wallet = paise(total)
    else if (method === "razorpay") online = paise(total)
    // Cash once it was collected on delivery; it can only go back as wallet credit.
    else if ((method === "cash" || method === "cod") && paid) cash = paise(total)
  }
  const legs = Array.isArray(payment.refund?.legs) ? payment.refund.legs : []
  const used = { wallet: 0, online: 0, cash: 0 }
  for (const leg of legs) {
    if (leg.status === "pending" || leg.status === "processed") used[leg.source] = (used[leg.source] || 0) + paise(leg.amount)
  }
  const leftOnline = Math.max(0, online - used.online)
  const leftWallet = Math.max(0, wallet - used.wallet)
  const leftCash = Math.max(0, cash - used.cash)
  return { wallet, online, cash, legs, leftOnline, leftWallet, leftCash, left: leftOnline + leftWallet + leftCash, paid }
}

/** How a refund of `amountPaise` would be split: online part first, then wallet, then cash (to wallet). */
function splitPreview(picture, amountPaise, destination) {
  const fromOnline = Math.min(amountPaise, picture.leftOnline)
  const rest = amountPaise - fromOnline
  if (destination === "wallet") return { toGateway: 0, toWallet: fromOnline + rest }
  return { toGateway: fromOnline, toWallet: rest }
}

const LEG_STATUS = {
  processed: "text-emerald-700 bg-emerald-50",
  pending: "text-amber-700 bg-amber-50",
  failed: "text-red-700 bg-red-50",
}

export default function RefundModal({ isOpen, onOpenChange, order, onConfirm, isProcessing }) {
  const [refundAmount, setRefundAmount] = useState("")
  const [destination, setDestination] = useState("original")
  // Who bears it: the restaurant (comes off its payout) or the company.
  const [chargedTo, setChargedTo] = useState("platform")
  const [reason, setReason] = useState("")
  const [error, setError] = useState("")

  const picture = useMemo(() => refundPicture(order), [order])

  useEffect(() => {
    if (order && isOpen) {
      setRefundAmount((picture.left / 100).toFixed(2))
      setDestination("original")
      setChargedTo("platform")
      setReason("")
      setError("")
    }
  }, [order, isOpen, picture.left])

  const handleAmountChange = (e) => {
    const value = e.target.value
    if (value === "" || /^\d*\.?\d{0,2}$/.test(value)) {
      setRefundAmount(value)
      setError("")
    }
  }

  const amountPaise = paise(refundAmount)
  const preview = splitPreview(picture, amountPaise, destination)

  const handleConfirm = () => {
    if (!refundAmount || !(amountPaise > 0)) {
      setError("Enter the amount to refund")
      return
    }
    if (amountPaise > picture.left) {
      setError(`Only ${rupees(picture.left / 100)} is left to refund on this order`)
      return
    }
    onConfirm(amountPaise / 100, destination, { chargedTo, reason: reason.trim() })
  }

  const handleClose = () => {
    if (!isProcessing) {
      setRefundAmount("")
      setError("")
      onOpenChange(false)
    }
  }

  if (!order) return null

  const paidOnline = picture.online > 0
  const paidWallet = picture.wallet > 0
  const paidCash = picture.cash > 0

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-bold text-slate-900">
            <Wallet className="w-5 h-5 text-purple-600" />
            Refund
          </DialogTitle>
          <DialogDescription className="text-slate-600">
            Order ID: <span className="font-semibold">{order.orderId}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="mb-1 font-medium text-slate-700">Paid with</p>
            {paidWallet && (
              <div className="flex justify-between text-slate-600">
                <span>Wallet</span>
                <span>{rupees(picture.wallet / 100)}</span>
              </div>
            )}
            {paidOnline && (
              <div className="flex justify-between text-slate-600">
                <span>Online (UPI / card)</span>
                <span>{rupees(picture.online / 100)}</span>
              </div>
            )}
            {paidCash && (
              <div className="flex justify-between text-slate-600">
                <span>Cash on delivery (refunded as wallet credit)</span>
                <span>{rupees(picture.cash / 100)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-medium text-slate-800">
              <span>Left to refund</span>
              <span>{rupees(picture.left / 100)}</span>
            </div>
          </div>

          {picture.legs.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 font-medium text-slate-700">Refunds so far</p>
              <ul className="space-y-1">
                {picture.legs.map((leg) => (
                  <li key={leg.id} className="flex items-center justify-between gap-2 text-slate-600">
                    <span>
                      {rupees(leg.amount)} to {leg.refundTo === "wallet" ? "wallet" : "original method"}
                      {leg.status === "failed" && leg.failureReason ? (
                        <span className="block text-xs text-red-600">{leg.failureReason}</span>
                      ) : null}
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${LEG_STATUS[leg.status] || ""}`}>
                      {leg.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {picture.left > 0 ? (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Refund amount (₹)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={refundAmount}
                  onChange={handleAmountChange}
                  placeholder="0.00"
                  disabled={isProcessing}
                  className={`w-full px-3 py-2.5 border-2 rounded-lg focus:outline-none focus:ring-2 transition-colors ${
                    error
                      ? "border-red-300 focus:border-red-500 focus:ring-red-200"
                      : "border-slate-300 focus:border-purple-500 focus:ring-purple-200"
                  } ${isProcessing ? "bg-slate-100 cursor-not-allowed" : "bg-white"}`}
                />
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>

              {picture.leftOnline > 0 && (
                <div className="space-y-2 text-sm">
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="refund-destination"
                      checked={destination === "original"}
                      onChange={() => setDestination("original")}
                      disabled={isProcessing}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium text-slate-800">Original payment method</span>
                      <span className="block text-xs text-slate-500">
                        Online part back to UPI / card (5-7 working days), wallet part to the wallet
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="refund-destination"
                      checked={destination === "wallet"}
                      onChange={() => setDestination("wallet")}
                      disabled={isProcessing}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium text-slate-800">All to Minto wallet</span>
                      <span className="block text-xs text-slate-500">Instant</span>
                    </span>
                  </label>
                </div>
              )}

              <div className="space-y-2 text-sm">
                <p className="font-medium text-slate-700">Who bears this refund?</p>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="refund-charged-to"
                    checked={chargedTo === "platform"}
                    onChange={() => setChargedTo("platform")}
                    disabled={isProcessing}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium text-slate-800">Company (Minto)</span>
                    <span className="block text-xs text-slate-500">Rider or company mistake. The restaurant is paid as normal.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="refund-charged-to"
                    checked={chargedTo === "restaurant"}
                    onChange={() => setChargedTo("restaurant")}
                    disabled={isProcessing}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium text-slate-800">Restaurant</span>
                    <span className="block text-xs text-slate-500">Restaurant's mistake (e.g. item missing). Deducted from its payout for this order.</span>
                  </span>
                </label>
              </div>

              <div className="space-y-1 text-sm">
                <label className="font-medium text-slate-700">Reason (optional)</label>
                <input
                  type="text"
                  value={reason}
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. 1 Paneer Tikka missing"
                  disabled={isProcessing}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-200"
                />
              </div>

              {amountPaise > 0 && amountPaise <= picture.left && (
                <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800">
                  {preview.toGateway > 0 && <p>{rupees(preview.toGateway / 100)} to the original payment method</p>}
                  {preview.toWallet > 0 && <p>{rupees(preview.toWallet / 100)} to the customer's wallet (instant)</p>}
                </div>
              )}
            </>
          ) : (
            <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              {picture.paid || picture.legs.length
                ? "Everything paid on this order has already been refunded."
                : "Nothing has been paid on this order yet (a cash order is paid on delivery), so there is nothing to refund."}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
          <Button variant="outline" onClick={handleClose} disabled={isProcessing} className="px-4 py-2">
            Cancel
          </Button>
          {picture.left > 0 && (
            <Button
              onClick={handleConfirm}
              disabled={isProcessing || !(amountPaise > 0)}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white"
            >
              {isProcessing ? "Processing..." : "Refund"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
