import { useCallback, useEffect, useState } from "react"
import Cropper from "react-easy-crop"
import { Loader2 } from "lucide-react"

/**
 * Preview and crop an image before it is uploaded, to the exact shape the app
 * shows it in -- dish photos square, promotional banners 5:3. Without this an
 * image of any shape was uploaded and the app cut it however it fell.
 *
 * Props: file (the picked File, or null to close), aspect, title, onDone(File),
 * onCancel(), outputWidth (px of the saved image's long side).
 */

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })

/** Draw the chosen area onto a canvas of the target size and return it as a File. */
async function cropToFile(src, area, { aspect, outputWidth, name, type }) {
  const img = await loadImage(src)
  const width = Math.round(aspect >= 1 ? outputWidth : outputWidth * aspect)
  const height = Math.round(width / aspect)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, width, height)
  // PNG keeps transparency; everything else becomes a compact JPEG.
  const outType = type === "image/png" ? "image/png" : "image/jpeg"
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, 0.9))
  if (!blob) throw new Error("Could not crop this image")
  const base = String(name || "image").replace(/\.[^.]+$/, "")
  return new File([blob], `${base}.${outType === "image/png" ? "png" : "jpg"}`, { type: outType })
}

export default function ImageCropDialog({ file, aspect = 1, title = "Crop image", onDone, onCancel, outputWidth = 1200 }) {
  const [src, setSrc] = useState("")
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [area, setArea] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let alive = true
    setSrc("")
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setError("")
    if (file) {
      readAsDataUrl(file)
        .then((url) => alive && setSrc(url))
        .catch(() => alive && setError("Could not read this file"))
    }
    return () => {
      alive = false
    }
  }, [file])

  const onCropComplete = useCallback((_, pixels) => setArea(pixels), [])

  const save = async () => {
    if (!area || !src) return
    try {
      setBusy(true)
      onDone(await cropToFile(src, area, { aspect, outputWidth, name: file?.name, type: file?.type }))
    } catch (e) {
      setError(e?.message || "Could not crop this image")
    } finally {
      setBusy(false)
    }
  }

  if (!file) return null

  const ratioLabel = aspect === 1 ? "square" : `${Math.round(aspect * 3)}:3`

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-4 space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">
            Drag to position and zoom to fit. The app shows this exact area ({ratioLabel}).
          </p>
        </div>
        <div className="relative h-80 w-full overflow-hidden rounded-lg bg-slate-900">
          {src ? (
            <Cropper
              image={src}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-300 text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          )}
        </div>
        <label className="flex items-center gap-3 text-sm text-slate-600">
          Zoom
          <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1" />
        </label>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-slate-300 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !area}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-60"
          >
            {busy ? "Cropping…" : "Use this crop"}
          </button>
        </div>
      </div>
    </div>
  )
}
