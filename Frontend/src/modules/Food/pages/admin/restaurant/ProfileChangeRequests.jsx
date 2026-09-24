import { useEffect, useState } from "react"
import { Check, X, ClipboardCheck } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

/**
 * Edits restaurants made to their name, contacts, KYC documents and photos.
 *
 * The restaurant stays live with its current details while these wait; they
 * go out to customers only when approved here. Shown as on-file beside
 * requested so a reviewer sees exactly what would change.
 */

const TABS = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
]

const isImageUrl = (v) => typeof v === "string" && /^https?:\/\//.test(v)

function Value({ value }) {
  if (value === null || value === undefined || value === "") return <span className="text-slate-400">—</span>
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) {
    const imgs = value.filter(isImageUrl)
    if (!imgs.length) return <span className="text-slate-400">—</span>
    return (
      <div className="flex flex-wrap gap-1">
        {imgs.slice(0, 6).map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer">
            <img src={u} alt="" className="h-12 w-12 rounded object-cover" />
          </a>
        ))}
        {imgs.length > 6 && <span className="self-center text-xs text-slate-500">+{imgs.length - 6}</span>}
      </div>
    )
  }
  if (isImageUrl(value)) {
    return (
      <a href={value} target="_blank" rel="noreferrer">
        <img src={value} alt="" className="h-14 w-14 rounded object-cover" />
      </a>
    )
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleDateString()
  return String(value)
}

export default function ProfileChangeRequests() {
  const [status, setStatus] = useState("pending")
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [rejecting, setRejecting] = useState(null)
  const [reason, setReason] = useState("")

  const load = async (which = status) => {
    setLoading(true)
    try {
      const res = await adminAPI.getProfileChanges({ status: which })
      setRequests(res?.data?.data?.requests || [])
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not load the requests")
      setRequests([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(status)
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (req) => {
    setBusyId(req.id)
    try {
      await adminAPI.approveProfileChange(req.id)
      toast.success("Approved. The changes are now live.")
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not approve")
    } finally {
      setBusyId(null)
    }
  }

  const reject = async () => {
    if (!reason.trim()) {
      toast.error("Say why, so the restaurant can fix it")
      return
    }
    setBusyId(rejecting.id)
    try {
      await adminAPI.rejectProfileChange(rejecting.id, reason.trim())
      toast.success("Rejected. The restaurant has been told why.")
      setRejecting(null)
      setReason("")
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not reject")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen space-y-4 bg-slate-50 p-4 lg:p-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-slate-700" />
          <h1 className="text-xl font-bold text-slate-900">Restaurant changes to review</h1>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Name, contact, document and photo changes wait here. The restaurant stays open on the app with its
          current details until you approve.
        </p>
        <div className="mt-4 flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setStatus(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm ${status === t.key ? "bg-slate-900 text-white" : "border border-slate-300 bg-white text-slate-700"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-sm text-slate-500">Loading...</p>}
      {!loading && requests.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Nothing {status === "pending" ? "waiting for review" : status} right now.
        </div>
      )}

      {requests.map((req) => (
        <div key={req.id} className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-slate-900">{req.restaurant?.name || "Restaurant"}</p>
              <p className="text-xs text-slate-500">
                Owner {req.restaurant?.ownerPhone || "—"} · requested {new Date(req.requestedAt).toLocaleString()}
              </p>
            </div>
            {req.status === "pending" && (
              <div className="flex gap-2">
                <button
                  onClick={() => setRejecting(req)}
                  disabled={busyId === req.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 disabled:opacity-50"
                >
                  <X className="h-4 w-4" /> Reject
                </button>
                <button
                  onClick={() => approve(req)}
                  disabled={busyId === req.id}
                  className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  <Check className="h-4 w-4" /> Approve
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="py-1 pr-4">Field</th>
                  <th className="py-1 pr-4">On the app now</th>
                  <th className="py-1">Requested</th>
                </tr>
              </thead>
              <tbody>
                {req.items.map((item) => (
                  <tr key={item.field} className="border-t border-slate-100 align-top">
                    <td className="py-2 pr-4 text-slate-600">{item.label}</td>
                    <td className="py-2 pr-4 text-slate-700"><Value value={item.current} /></td>
                    <td className="py-2 font-medium text-amber-800"><Value value={item.requested} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {req.status === "rejected" && req.rejectionReason && (
            <p className="mt-3 text-sm text-red-600">Rejected: {req.rejectionReason}</p>
          )}
        </div>
      ))}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-3 rounded-xl bg-white p-5">
            <p className="font-semibold text-slate-900">Reject the changes for {rejecting.restaurant?.name}?</p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. The FSSAI certificate is blurred"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setRejecting(null); setReason("") }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                onClick={reject}
                disabled={busyId === rejecting.id}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
