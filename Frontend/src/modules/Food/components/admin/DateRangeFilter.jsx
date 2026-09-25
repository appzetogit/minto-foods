/**
 * From / To day pickers for an admin list. The server reads them as whole days
 * in India time, so "to 25 Sep" includes all of the 25th.
 *
 * @param {{ from: string, to: string, onChange: (next: {from: string, to: string}) => void }} props
 */
export default function DateRangeFilter({ from = "", to = "", onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange({ from: e.target.value, to })}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        aria-label="From date"
        title="From"
      />
      <span className="text-xs text-slate-500">to</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange({ from, to: e.target.value })}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        aria-label="To date"
        title="To"
      />
      {(from || to) && (
        <button
          type="button"
          onClick={() => onChange({ from: "", to: "" })}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          Clear
        </button>
      )}
    </div>
  )
}
