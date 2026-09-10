import { useCallback, useEffect, useState } from "react"
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { adminAPI } from "@food/api"

/**
 * The cuisine vocabulary.
 *
 * Restaurants store cuisine names as free text and always have, so before this
 * the options were whatever anyone had ever typed — "North Indian",
 * "north indian" and "North  Indian" all existing separately, none of them
 * selectable as the same thing. This screen decides what can be chosen.
 *
 * Deactivating and deleting are deliberately different, and the screen says so:
 * a cuisine restaurants are using cannot be removed without leaving them filed
 * under something nobody can select, so it is hidden from the picker instead.
 */

const emptyDraft = { name: "", sortOrder: "0", isActive: true }

export default function Cuisines() {
  const [cuisines, setCuisines] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(emptyDraft)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try {
      // Inactive ones included: this is the screen where you turn them back on,
      // so hiding them here would make that impossible.
      const response = await adminAPI.getCuisines({ includeInactive: true })
      setCuisines(response?.data?.data?.cuisines ?? [])
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not load cuisines")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openAdd = () => {
    setEditingId(null)
    setDraft(emptyDraft)
    setShowForm(true)
  }

  const openEdit = (cuisine) => {
    setEditingId(cuisine.id)
    setDraft({
      name: cuisine.name,
      sortOrder: String(cuisine.sortOrder ?? 0),
      isActive: cuisine.isActive !== false,
    })
    setShowForm(true)
  }

  const save = async () => {
    const name = draft.name.trim()
    if (!name) {
      toast.error("Give the cuisine a name")
      return
    }

    setSaving(true)
    try {
      const body = {
        name,
        sortOrder: Number(draft.sortOrder) || 0,
        isActive: draft.isActive,
      }
      if (editingId) await adminAPI.updateCuisine(editingId, body)
      else await adminAPI.createCuisine(body)

      toast.success(editingId ? "Cuisine updated" : "Cuisine added")
      setShowForm(false)
      await load()
    } catch (error) {
      // The server names the clashing cuisine, which matters: the clash is
      // usually a capitalisation the admin cannot see.
      toast.error(error?.response?.data?.message || "Could not save that cuisine")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (cuisine) => {
    const inUse = Number(cuisine.restaurantCount) > 0
    const question = inUse
      ? `${cuisine.name} is used by ${cuisine.restaurantCount} restaurant${
          cuisine.restaurantCount === 1 ? "" : "s"
        }. It will be hidden from the picker rather than deleted, and those restaurants keep it. Continue?`
      : `Delete ${cuisine.name}? Nothing is using it.`

    if (!window.confirm(question)) return

    try {
      const response = await adminAPI.deleteCuisine(cuisine.id)
      toast.success(response?.data?.message || "Done")
      await load()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not remove that cuisine")
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Cuisines</h1>
            <p className="text-sm text-slate-500">
              What restaurants can be filed under. Restaurants keep the name, so hiding one
              here removes it from the picker without changing anyone&rsquo;s listing.
            </p>
          </div>
          <button
            type="button"
            onClick={openAdd}
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-800"
          >
            <Plus className="h-4 w-4" />
            Add cuisine
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="p-3 text-left text-sm font-semibold text-slate-700">Cuisine</th>
                <th className="p-3 text-left text-sm font-semibold text-slate-700">Restaurants</th>
                <th className="p-3 text-left text-sm font-semibold text-slate-700">Order</th>
                <th className="p-3 text-left text-sm font-semibold text-slate-700">Status</th>
                <th className="p-3 text-right text-sm font-semibold text-slate-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
                  </td>
                </tr>
              ) : cuisines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-sm text-slate-500">
                    No cuisines yet. Add the first one.
                  </td>
                </tr>
              ) : (
                cuisines.map((cuisine) => (
                  <tr key={cuisine.id} className="border-t border-slate-100">
                    <td className="p-3 text-sm font-medium text-slate-900">{cuisine.name}</td>
                    <td className="p-3 text-sm text-slate-600">{cuisine.restaurantCount}</td>
                    <td className="p-3 text-sm text-slate-600">{cuisine.sortOrder}</td>
                    <td className="p-3">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                          cuisine.isActive
                            ? "bg-teal-50 text-teal-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {cuisine.isActive ? "In the picker" : "Hidden"}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(cuisine)}
                          aria-label={`Edit ${cuisine.name}`}
                          className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(cuisine)}
                          aria-label={`Remove ${cuisine.name}`}
                          className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-bold text-slate-900">
                {editingId ? "Edit cuisine" : "Add cuisine"}
              </h2>
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
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Name</label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  maxLength={60}
                  placeholder="North Indian"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Capitalisation and spacing do not create a second cuisine &mdash; the server
                  will say if this one already exists under another spelling.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Sort order
                </label>
                <input
                  type="number"
                  value={draft.sortOrder}
                  onChange={(e) => setDraft((prev) => ({ ...prev, sortOrder: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <p className="mt-1 text-xs text-slate-500">Lower numbers appear first.</p>
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => setDraft((prev) => ({ ...prev, isActive: e.target.checked }))}
                />
                Show in the picker
              </label>
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
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
