import React, { useEffect, useState } from "react"
import { adminAPI } from "@/services/api"
import { Button } from "@food/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@food/components/ui/card"
import { Input } from "@food/components/ui/input"
import { Label } from "@food/components/ui/label"
import { Clock, Loader2, Save, Tag } from "lucide-react"
import { HighlightBadgeManager } from "@food/components/admin/restaurant/HighlightBadges"
import { toast } from "sonner"

// The restaurant's time to accept a new order, in seconds. Mirrors the
// server's bounds (businessSettings.service.js).
const MIN_SECONDS = 30
const MAX_SECONDS = 600
const DEFAULT_SECONDS = 240

const clampSeconds = (value) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_SECONDS
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(numeric)))
}

const describe = (seconds) => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (!m) return `${s} seconds`
  return s ? `${m} min ${s} s` : `${m} minute${m === 1 ? "" : "s"}`
}

export default function RestaurantSettings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedSeconds, setSavedSeconds] = useState(DEFAULT_SECONDS)
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS)

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setLoading(true)
        const response = await adminAPI.getRestaurantOrderAcceptanceSettings()
        const data = response?.data?.data || {}
        const value = clampSeconds(data.orderAcceptanceTimeSeconds ?? (data.orderAcceptanceTimeMinutes ?? 4) * 60)
        setSavedSeconds(value)
        setSeconds(value)
      } catch (error) {
        toast.error(error?.response?.data?.message || "Failed to load restaurant settings.")
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
  }, [])

  const handleSave = async () => {
    const value = clampSeconds(seconds)
    try {
      setSaving(true)
      const response = await adminAPI.updateRestaurantOrderAcceptanceSettings({
        orderAcceptanceTimeSeconds: value,
      })
      const updatedValue = clampSeconds(response?.data?.data?.orderAcceptanceTimeSeconds ?? value)
      setSavedSeconds(updatedValue)
      setSeconds(updatedValue)
      toast.success("Restaurant accept time updated.")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to update order acceptance time.")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const currentSeconds = clampSeconds(seconds)
  const isDirty = currentSeconds !== savedSeconds

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Restaurant Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Order acceptance timer and restaurant tags.
        </p>
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-slate-600" />
            <CardTitle className="text-lg">Restaurant accept time</CardTitle>
          </div>
          <CardDescription>
            How long a restaurant has to accept a new order before it is rejected automatically. The popup and the
            order card count down from it. Orders already placed keep their timer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="orderAcceptanceTimeSeconds">Restaurant accept time (seconds)</Label>
              <span className="text-sm font-semibold text-gray-900">{describe(currentSeconds)}</span>
            </div>
            <Input
              id="orderAcceptanceTimeSeconds"
              type="range"
              min={MIN_SECONDS}
              max={MAX_SECONDS}
              step={10}
              value={currentSeconds}
              onChange={(event) => setSeconds(clampSeconds(event.target.value))}
              className="h-10"
            />
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={MIN_SECONDS}
                max={MAX_SECONDS}
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
                onBlur={() => setSeconds(clampSeconds(seconds))}
                className="w-28"
              />
              <span className="text-sm text-gray-500">Allowed range: 30 to 600 seconds</span>
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={handleSave} disabled={!isDirty || saving} className="min-w-[120px]">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6 border-slate-200 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-slate-600" />
            <CardTitle className="text-lg">Restaurant Tags</CardTitle>
          </div>
          <CardDescription>
            Tags such as Bestseller or Popular, shown on restaurant cards in the app. Pick one per restaurant on its edit page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HighlightBadgeManager />
        </CardContent>
      </Card>
    </div>
  )
}
