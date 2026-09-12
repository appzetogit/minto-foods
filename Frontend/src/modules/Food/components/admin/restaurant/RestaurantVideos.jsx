import { useEffect, useRef, useState } from "react"
import { adminAPI } from "@food/api"
import { Loader2, Trash2, Upload } from "lucide-react"

/**
 * Storefront videos for one restaurant, uploaded by an admin.
 *
 * The server hands back a path and a freshly signed url each time it is asked.
 * Only the path is kept for deletes: a signed url expires within the hour, so
 * one held in this component would stop matching what is stored.
 */

const MAX_MB = 12

export default function RestaurantVideos({ restaurantId }) {
  const [videos, setVideos] = useState([])
  const [maxVideos, setMaxVideos] = useState(3)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const fileRef = useRef(null)

  const read = (res) => {
    const data = res?.data?.data ?? res?.data ?? {}
    setVideos(Array.isArray(data.videos) ? data.videos : [])
    if (Number.isFinite(Number(data.maxVideos))) setMaxVideos(Number(data.maxVideos))
  }

  useEffect(() => {
    let alive = true
    if (!restaurantId) return undefined
    setLoading(true)
    adminAPI
      .getRestaurantVideos(restaurantId)
      .then((res) => { if (alive) read(res) })
      .catch(() => { if (alive) setError("Could not load the videos.") })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [restaurantId])

  const handleUpload = async (files) => {
    setError("")
    const chosen = [...files]
    if (!chosen.length) return
    const room = maxVideos - videos.length
    if (room <= 0) return setError(`This restaurant already has the maximum of ${maxVideos} videos.`)
    const tooBig = chosen.find((f) => f.size > MAX_MB * 1024 * 1024)
    if (tooBig) return setError(`"${tooBig.name}" is over ${MAX_MB}MB. Compress it and try again.`)

    try {
      setBusy("upload")
      const res = await adminAPI.uploadRestaurantVideos(restaurantId, chosen.slice(0, room))
      read(res)
      if (chosen.length > room) setError(`Only ${room} could be added; the limit is ${maxVideos}.`)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Video upload failed.")
    } finally {
      setBusy("")
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const handleDelete = async (video) => {
    setError("")
    try {
      setBusy(video.path)
      const res = await adminAPI.deleteRestaurantVideo(restaurantId, video.path)
      read(res)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || "Could not remove the video.")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="mt-5 border-t border-slate-200 pt-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-900">
          Videos ({videos.length}/{maxVideos})
        </h3>
        <label className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 cursor-pointer">
          {busy === "upload" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          <span>Add video</span>
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,video/webm"
            multiple
            className="hidden"
            disabled={busy === "upload" || videos.length >= maxVideos}
            onChange={(e) => handleUpload(e.target.files || [])}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500 mb-3">MP4 or WebM, up to {MAX_MB}MB each.</p>

      {error ? <p className="text-sm text-red-600 mb-3">{error}</p> : null}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading videos&hellip;
        </div>
      ) : videos.length === 0 ? (
        <p className="text-sm text-slate-500">No videos yet.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {videos.map((v) => (
            <div key={v.path} className="relative border border-slate-200 rounded-lg overflow-hidden">
              <video src={v.url} controls preload="metadata" className="w-full h-40 bg-black object-contain" />
              <button
                type="button"
                onClick={() => handleDelete(v)}
                disabled={busy === v.path}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-white/90 text-slate-600 hover:text-red-600 shadow"
                title="Remove this video"
              >
                {busy === v.path ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
