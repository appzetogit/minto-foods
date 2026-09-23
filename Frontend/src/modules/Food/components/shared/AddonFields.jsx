import { useMemo } from "react"

/**
 * The parts of an add-on beyond its name and price: which dishes it appears on,
 * its selection group, and what it costs on individual dish variants.
 *
 * Shared by the admin and restaurant panels so the two forms cannot drift, and
 * because both write the same three things the API already understands:
 * `foodIds`, `group` and `variantPrices`.
 *
 * @param {{
 *   foods: Array<{id: string, name: string, variants?: Array<{id: string, name: string, price?: number}>}>,
 *   value: { foodIds: string[], group: { name: string, minSelect: number, maxSelect: number }, variantPrices: Array<{variantId: string, price: number|string}> },
 *   onChange: (next: object) => void,
 *   basePrice?: number|string,
 *   loadingFoods?: boolean,
 * }} props
 */
export default function AddonFields({ foods = [], value, onChange, basePrice = "", loadingFoods = false }) {
  const foodIds = Array.isArray(value?.foodIds) ? value.foodIds : []
  const group = value?.group || { name: "", minSelect: 0, maxSelect: 1 }
  const variantPrices = Array.isArray(value?.variantPrices) ? value.variantPrices : []

  const wholeMenu = foodIds.length === 0
  const priceByVariant = useMemo(
    () => new Map(variantPrices.map((v) => [String(v.variantId), v.price])),
    [variantPrices],
  )

  // Variants may only be priced for dishes this add-on actually appears on.
  const pricableDishes = useMemo(
    () => foods.filter((f) => (wholeMenu || foodIds.includes(f.id)) && (f.variants?.length || 0) > 0),
    [foods, foodIds, wholeMenu],
  )

  const set = (patch) => onChange({ ...value, ...patch })

  const toggleFood = (id) => {
    const next = foodIds.includes(id) ? foodIds.filter((x) => x !== id) : [...foodIds, id]
    // Drop prices for variants of dishes that are no longer attached.
    const allowed = new Set(
      foods.filter((f) => next.length === 0 || next.includes(f.id)).flatMap((f) => (f.variants || []).map((v) => v.id)),
    )
    set({ foodIds: next, variantPrices: variantPrices.filter((v) => allowed.has(String(v.variantId))) })
  }

  const setVariantPrice = (variantId, raw) => {
    const rest = variantPrices.filter((v) => String(v.variantId) !== String(variantId))
    // Empty means "no special price": the add-on's own price applies.
    set({ variantPrices: raw === "" ? rest : [...rest, { variantId, price: raw }] })
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-slate-700">Where it appears</p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => set({ foodIds: [] })}
            className={`rounded-lg border px-3 py-1.5 text-sm ${wholeMenu ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-700"}`}
          >
            Whole menu
          </button>
          <span className="self-center text-xs text-slate-500">
            {wholeMenu ? "Offered on every dish" : `Offered on ${foodIds.length} dish${foodIds.length === 1 ? "" : "es"}`}
          </span>
        </div>

        <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {loadingFoods && <p className="p-2 text-sm text-slate-500">Loading dishes…</p>}
          {!loadingFoods && foods.length === 0 && (
            <p className="p-2 text-sm text-slate-500">This restaurant has no dishes yet.</p>
          )}
          {foods.map((f) => (
            <label key={f.id} className="flex items-center gap-2 px-1 py-1 text-sm text-slate-700">
              <input type="checkbox" checked={foodIds.includes(f.id)} onChange={() => toggleFood(f.id)} />
              <span>{f.name}</span>
              {(f.variants?.length || 0) > 0 && (
                <span className="text-xs text-slate-400">{f.variants.length} variants</span>
              )}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-700">Choice group (optional)</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Add-ons sharing a group name are shown together, e.g. &ldquo;Choose 1 size&rdquo;.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <input
            value={group.name || ""}
            onChange={(e) => set({ group: { ...group, name: e.target.value } })}
            placeholder="Group name"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min="0"
            value={group.minSelect ?? 0}
            onChange={(e) => set({ group: { ...group, minSelect: Number(e.target.value) || 0 } })}
            placeholder="Min"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            min="1"
            value={group.maxSelect ?? 1}
            onChange={(e) => set({ group: { ...group, maxSelect: Number(e.target.value) || 1 } })}
            placeholder="Max"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Min above 0 makes the group compulsory. Max 1 shows single-choice options.
        </p>
      </div>

      {pricableDishes.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-slate-700">Price per variant (optional)</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Leave blank to charge the add-on&rsquo;s own price{basePrice !== "" ? ` of ₹${basePrice}` : ""}.
          </p>
          <div className="mt-2 max-h-52 space-y-3 overflow-y-auto">
            {pricableDishes.map((f) => (
              <div key={f.id}>
                <p className="text-xs font-medium text-slate-600">{f.name}</p>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {(f.variants || []).map((v) => (
                    <label key={v.id} className="flex items-center gap-2 text-sm">
                      <span className="w-24 shrink-0 truncate text-slate-600">{v.name}</span>
                      <input
                        type="number"
                        min="0"
                        value={priceByVariant.get(String(v.id)) ?? ""}
                        onChange={(e) => setVariantPrice(v.id, e.target.value)}
                        placeholder="₹"
                        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Turns the form's values into the shape the add-on API takes. */
export const addonFieldsPayload = (value) => ({
  foodIds: Array.isArray(value?.foodIds) ? value.foodIds : [],
  group: {
    name: String(value?.group?.name || "").trim(),
    minSelect: Number(value?.group?.minSelect) || 0,
    maxSelect: Number(value?.group?.maxSelect) || 1,
    sortOrder: Number(value?.group?.sortOrder) || 0,
  },
  variantPrices: (Array.isArray(value?.variantPrices) ? value.variantPrices : [])
    .filter((v) => v.variantId && v.price !== "" && v.price !== null && Number.isFinite(Number(v.price)))
    .map((v) => ({ variantId: String(v.variantId), price: Number(v.price) })),
})

export const emptyAddonFields = () => ({
  foodIds: [],
  group: { name: "", minSelect: 0, maxSelect: 1, sortOrder: 0 },
  variantPrices: [],
})
