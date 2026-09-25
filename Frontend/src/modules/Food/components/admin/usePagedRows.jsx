import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

/**
 * Pages a list that is already loaded, for admin tables that rendered every
 * row at once. Resets to page 1 when the list changes (a new search or
 * filter), and never leaves you on a page past the end.
 *
 *   const { pageRows, offset, pager } = usePagedRows(filteredRows)
 *   ...{pageRows.map((row, i) => ... offset + i + 1 ...)}
 *   {pager}
 */
export default function usePagedRows(rows, initialSize = 20) {
  const list = Array.isArray(rows) ? rows : []
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(initialSize)
  const pages = Math.max(1, Math.ceil(list.length / size))

  useEffect(() => {
    setPage(1)
  }, [list.length, size])

  const current = Math.min(page, pages)
  const offset = (current - 1) * size
  const pageRows = useMemo(() => list.slice(offset, offset + size), [list, offset, size])

  const pager =
    list.length > Math.min(...[10, size]) ? (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
        <span>
          Showing {list.length ? offset + 1 : 0}–{Math.min(offset + size, list.length)} of {list.length}
        </span>
        <div className="flex items-center gap-2">
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            aria-label="Rows per page"
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={current <= 1}
            className="rounded-lg border border-slate-300 bg-white p-1.5 disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>
            {current} / {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={current >= pages}
            className="rounded-lg border border-slate-300 bg-white p-1.5 disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    ) : null

  return { pageRows, offset, pager }
}
