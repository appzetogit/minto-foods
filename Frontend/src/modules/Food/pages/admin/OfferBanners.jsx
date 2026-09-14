import { useEffect, useMemo, useRef, useState } from "react"
import { adminAPI } from "@food/api"
import { ArrowDown, ArrowUp, Image as ImageIcon, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react"

/**
 * Offer banners — the artwork the apps show for current offers.
 *
 * Separate from the home promotion strip on purpose: that one is merchandising
 * the landing screen owns, and sharing a table would mean an edit to one moved
 * the other.
 */

const MAX_MB = 5

const emptyForm = { file: null, preview: "", title: "", ctaLink: "", startDate: "", endDate: "" }

/** A date from the API as the value an <input type="date"> wants. */
const toDateInput = (value) => {
  if (!value) return ""
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

const readableDate = (value) =>
  new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" })

/**
 * What an admin needs to know at a glance: not the raw flags, but whether
 * customers can see this banner right now, and if not, why not.
 */
const bannerState = (banner) => {
  if (!banner.isActive) return { label: "Switched off", tone: "bg-slate-100 text-slate-600" }

  const now = Date.now()
  if (banner.startDate && new Date(banner.startDate).getTime() > now) {
    return { label: `Starts ${readableDate(banner.startDate)}`, tone: "bg-amber-100 text-amber-700" }
  }
  if (banner.endDate && new Date(banner.endDate).getTime() < now) {
    return { label: `Ended ${readableDate(banner.endDate)}`, tone: "bg-rose-100 text-rose-700" }
  }
  return { label: "Live now", tone: "bg-emerald-100 text-emerald-700" }
}

export default function OfferBanners() {
  const [banners, setBanners] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const fileRef = useRef(null)

  const load = async () => {
    setError("")
    try {
      setLoading(true)
      const res = await adminAPI.getOfferBanners()
      const data = res?.data?.data ?? res?.data ?? {}
      setBanners(Array.isArray(data.banners) ? data.banners : [])
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not load the offer banners.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // Object URLs are held for the preview; release the last one on unmount.
    return () => setForm((f) => {
      if (f.preview) URL.revokeObjectURL(f.preview)
      return f
    })
  }, [])

  const isEditing = editingId !== null
  const canSubmit = useMemo(() => isEditing || Boolean(form.file), [isEditing, form.file])

  const pickFile = (file) => {
    if (!file) return
    if (!file.type.startsWith("image/")) return setError("That file is not an image.")
    if (file.size > MAX_MB * 1024 * 1024) return setError(`Images must be under ${MAX_MB}MB.`)
    setError("")
    setForm((f) => {
      if (f.preview) URL.revokeObjectURL(f.preview)
      return { ...f, file, preview: URL.createObjectURL(file) }
    })
  }

  const resetForm = () => {
    setForm((f) => {
      if (f.preview) URL.revokeObjectURL(f.preview)
      return emptyForm
    })
    setEditingId(null)
    if (fileRef.current) fileRef.current.value = ""
  }

  const handleSubmit = async () => {
    setError("")
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      return setError("The end date cannot be before the start date.")
    }
    try {
      setBusy("save")
      const payload = {
        file: form.file,
        title: form.title,
        ctaLink: form.ctaLink,
        startDate: form.startDate,
        endDate: form.endDate,
      }
      if (isEditing) await adminAPI.updateOfferBanner(editingId, payload)
      else await adminAPI.createOfferBanner(payload)
      resetForm()
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not save the banner.")
    } finally {
      setBusy("")
    }
  }

  const startEdit = (banner) => {
    setEditingId(banner.id)
    setForm({
      file: null,
      preview: banner.imageUrl,
      title: banner.title || "",
      ctaLink: banner.ctaLink || "",
      startDate: toDateInput(banner.startDate),
      endDate: toDateInput(banner.endDate),
    })
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const handleToggle = async (banner) => {
    setError("")
    try {
      setBusy(banner.id)
      await adminAPI.updateOfferBannerStatus(banner.id, !banner.isActive)
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not change the banner.")
    } finally {
      setBusy("")
    }
  }

  const handleDelete = async (banner) => {
    // Deleting takes the artwork with it, so make it a deliberate act.
    if (!window.confirm(`Delete this banner${banner.title ? ` ("${banner.title}")` : ""}? This cannot be undone.`)) return
    setError("")
    try {
      setBusy(banner.id)
      await adminAPI.deleteOfferBanner(banner.id)
      if (editingId === banner.id) resetForm()
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not delete the banner.")
    } finally {
      setBusy("")
    }
  }

  const move = async (index, direction) => {
    const next = index + direction
    if (next < 0 || next >= banners.length) return
    const ids = banners.map((b) => b.id)
    ;[ids[index], ids[next]] = [ids[next], ids[index]]

    // Show the new order at once; the reload behind it is confirmation.
    setBanners((prev) => {
      const copy = [...prev]
      ;[copy[index], copy[next]] = [copy[next], copy[index]]
      return copy
    })
    try {
      setBusy("order")
      await adminAPI.reorderOfferBanners(ids)
      await load()
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not reorder the banners.")
      await load()
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="p-3 bg-slate-50 min-h-screen">
      <div className="w-full mx-auto max-w-6xl space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h1 className="text-xl font-bold text-slate-900">Offer Banners</h1>
          <p className="text-sm text-slate-500 mt-1">
            Artwork shown in the apps for current offers. The apps only ever receive banners that are
            switched on and inside their dates, in the order below.
          </p>
        </div>

        {error ? (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} className="text-rose-500 hover:text-rose-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : null}

        {/* Add or edit */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">
              {isEditing ? "Edit banner" : "Add a banner"}
            </h2>
            {isEditing ? (
              <button type="button" onClick={resetForm} className="text-sm text-slate-500 hover:text-slate-800">
                Cancel edit
              </button>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-[280px,1fr]">
            <div>
              <label className="block w-full cursor-pointer">
                <div className="aspect-[21/9] rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 flex items-center justify-center overflow-hidden">
                  {form.preview ? (
                    <img src={form.preview} alt="Banner preview" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-slate-400 text-sm inline-flex items-center gap-2">
                      <ImageIcon className="w-4 h-4" /> Choose an image
                    </span>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => pickFile(e.target.files?.[0])}
                />
              </label>
              <p className="mt-1 text-xs text-slate-500">
                Wide artwork, up to {MAX_MB}MB. {isEditing ? "Leave it to keep the current image." : ""}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Flat 50% off this weekend"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <p className="mt-1 text-xs text-slate-500">Used for accessibility and reports, not drawn on the image.</p>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">Opens on tap</label>
                <input
                  value={form.ctaLink}
                  onChange={(e) => setForm((f) => ({ ...f, ctaLink: e.target.value }))}
                  placeholder="/food/user/restaurants/<id>  — blank means not tappable"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Starts</label>
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <p className="mt-1 text-xs text-slate-500">Blank = show it straight away.</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Ends</label>
                <input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                <p className="mt-1 text-xs text-slate-500">Blank = until switched off.</p>
              </div>

              <div className="sm:col-span-2 flex justify-end">
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit || busy === "save"}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 inline-flex items-center gap-2"
                >
                  {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : isEditing ? <Upload className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  <span>{isEditing ? "Save changes" : "Add banner"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Existing banners */}
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900 mb-3">
            Banners {banners.length ? <span className="text-slate-400 font-normal">({banners.length})</span> : null}
          </h2>

          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading banners&hellip;
            </div>
          ) : banners.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">
              No offer banners yet. Add one above and it appears in the apps straight away.
            </p>
          ) : (
            <div className="space-y-3">
              {banners.map((banner, index) => {
                const state = bannerState(banner)
                return (
                  <div key={banner.id} className="flex flex-col sm:flex-row gap-3 border border-slate-200 rounded-lg p-3">
                    <div className="sm:w-56 shrink-0">
                      <div className="aspect-[21/9] rounded-md overflow-hidden bg-slate-100">
                        <img src={banner.imageUrl} alt={banner.title || "Offer banner"} className="w-full h-full object-cover" />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900 truncate">{banner.title || "Untitled"}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${state.tone}`}>{state.label}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1 truncate">
                        {banner.ctaLink ? `Opens ${banner.ctaLink}` : "Not tappable"}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {banner.startDate ? `From ${readableDate(banner.startDate)}` : "No start date"}
                        {" · "}
                        {banner.endDate ? `until ${readableDate(banner.endDate)}` : "no end date"}
                      </p>
                    </div>

                    <div className="flex sm:flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={index === 0 || busy === "order"}
                        className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                        title="Move up"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={index === banners.length - 1 || busy === "order"}
                        className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
                        title="Move down"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex sm:flex-col items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggle(banner)}
                        disabled={busy === banner.id}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium ${
                          banner.isActive ? "bg-emerald-600 text-white hover:bg-emerald-700" : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                        }`}
                      >
                        {busy === banner.id ? "…" : banner.isActive ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(banner)}
                        className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(banner)}
                        disabled={busy === banner.id}
                        className="p-1.5 rounded-md border border-slate-200 text-slate-500 hover:text-red-600 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
