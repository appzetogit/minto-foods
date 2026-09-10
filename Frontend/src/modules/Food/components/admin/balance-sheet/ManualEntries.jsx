import { useCallback, useEffect, useState } from "react"
import { Loader2, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"

/**
 * Income and expenses that did not come from an order.
 *
 * The rest of the balance sheet is derived from the order ledger, which is right
 * for whatever an order produced and useless for everything else — rent, a fine,
 * a marketing spend, a recovery. Those had nowhere to go, so the sheet could
 * never be reconciled against the bank.
 *
 * Shown as its own panel rather than folded into the payout figures. A
 * "restaurant owes" number quietly containing a hand-typed expense is a number
 * nobody can trace back to orders, and one nobody can trace is one nobody
 * trusts.
 */

const rupees = (value) =>
  `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const today = () => {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const emptyDraft = () => ({
  type: "expense",
  amount: "",
  category: "",
  note: "",
  occurredAt: today(),
})

export default function ManualEntries({ from, to, className = "" }) {
  const [entries, setEntries] = useState([])
  const [totals, setTotals] = useState({ income: 0, expense: 0, net: 0 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await adminAPI.getLedgerEntries({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      })
      const data = response?.data?.data ?? {}
      setEntries(data.entries ?? [])
      setTotals(data.totals ?? { income: 0, expense: 0, net: 0 })
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not load the entries")
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    const amount = String(draft.amount).trim()
    if (!amount) {
      toast.error("Enter an amount")
      return
    }

    setSaving(true)
    try {
      await adminAPI.createLedgerEntry({
        type: draft.type,
        amount: Number(amount),
        category: draft.category.trim(),
        note: draft.note.trim(),
        occurredAt: draft.occurredAt,
      })
      toast.success("Entry recorded")
      setShowForm(false)
      setDraft(emptyDraft())
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not record that")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (entry) => {
    if (!window.confirm(`Delete this ${entry.type} of ${rupees(entry.amount)}?`)) return
    try {
      await adminAPI.deleteLedgerEntry(entry.id)
      toast.success("Entry deleted")
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not delete that")
    }
  }

  return (
    <div className={`rounded-xl border border-slate-200 bg-white ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Other income and expenses</h2>
          <p className="text-sm text-slate-500">
            Recorded by hand. Kept separate from the order figures above, so both stay
            traceable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft(emptyDraft())
            setShowForm(true)
          }}
          className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
        >
          <Plus className="h-4 w-4" />
          Add entry
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Income</p>
          <p className="text-lg font-bold text-teal-700">{rupees(totals.income)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Expense</p>
          <p className="text-lg font-bold text-red-600">{rupees(totals.expense)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Net</p>
          <p
            className={`text-lg font-bold ${
              Number(totals.net) < 0 ? "text-red-600" : "text-slate-900"
            }`}
          >
            {rupees(totals.net)}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto p-5">
        <table className="w-full">
          <thead>
            <tr>
              <th className="p-3 text-left text-sm font-semibold text-slate-700">Date</th>
              <th className="p-3 text-left text-sm font-semibold text-slate-700">Type</th>
              <th className="p-3 text-left text-sm font-semibold text-slate-700">Category</th>
              <th className="p-3 text-left text-sm font-semibold text-slate-700">Note</th>
              <th className="p-3 text-right text-sm font-semibold text-slate-700">Amount</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-sm text-slate-500">
                  Nothing recorded for this period.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} className="border-t border-slate-100">
                  <td className="p-3 text-sm text-slate-600">
                    {new Date(entry.occurredAt).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="p-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                        entry.type === "income"
                          ? "bg-teal-50 text-teal-700"
                          : "bg-red-50 text-red-700"
                      }`}
                    >
                      {entry.type}
                    </span>
                  </td>
                  <td className="p-3 text-sm text-slate-600">{entry.category || "—"}</td>
                  <td className="p-3 text-sm text-slate-600">{entry.note || "—"}</td>
                  <td
                    className={`p-3 text-right text-sm font-semibold ${
                      entry.type === "income" ? "text-teal-700" : "text-red-600"
                    }`}
                  >
                    {entry.type === "income" ? "+" : "−"}
                    {rupees(entry.amount)}
                  </td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => remove(entry)}
                      aria-label="Delete entry"
                      className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-bold text-slate-900">Record an entry</h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Close"
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Type</label>
                  <select
                    value={draft.type}
                    onChange={(e) => setDraft((prev) => ({ ...prev, type: e.target.value }))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                  >
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Amount</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.amount}
                    onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                  />
                  {/* Direction comes from the type, so this is always positive. */}
                  <p className="mt-1 text-xs text-slate-500">Always a positive number.</p>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Date</label>
                <input
                  type="date"
                  value={draft.occurredAt}
                  onChange={(e) => setDraft((prev) => ({ ...prev, occurredAt: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                />
                <p className="mt-1 text-xs text-slate-500">
                  When the money moved, not when you are typing it in.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Category</label>
                <input
                  type="text"
                  value={draft.category}
                  onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                  placeholder="Rent, marketing, penalty…"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Note</label>
                <textarea
                  rows={3}
                  value={draft.note}
                  onChange={(e) => setDraft((prev) => ({ ...prev, note: e.target.value }))}
                  placeholder="What this was for — the person reconciling will not remember."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
                />
              </div>
            </div>

            <div className="flex gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex-1 rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Record"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
