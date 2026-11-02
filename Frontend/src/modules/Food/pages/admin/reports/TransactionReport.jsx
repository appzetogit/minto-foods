import usePagedRows from "@food/components/admin/usePagedRows"
import { useState, useMemo, useEffect } from "react"

import { BarChart3, ChevronDown, Info, Settings, FileText, FileSpreadsheet, Code, Loader2, Calendar } from "lucide-react"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@food/components/ui/dropdown-menu"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"

import { exportTransactionReportToCSV, exportTransactionReportToExcel, exportTransactionReportToPDF, exportTransactionReportToJSON } from "@food/components/admin/reports/reportsExportUtils"

import { adminAPI } from "@food/api"

import { toast } from "sonner"



// Import icons from Transaction-report-icons

import completedIcon from "@food/assets/Transaction-report-icons/trx1.png"

import refundedIcon from "@food/assets/Transaction-report-icons/trx3.png"

import adminEarningIcon from "@food/assets/Transaction-report-icons/admin-earning.png"

import restaurantEarningIcon from "@food/assets/Transaction-report-icons/store-earning.png"

import deliverymanEarningIcon from "@food/assets/Transaction-report-icons/deliveryman-earning.png"



// Import search and export icons from Dashboard-icons

import searchIcon from "@food/assets/Dashboard-icons/image8.png"

import exportIcon from "@food/assets/Dashboard-icons/image9.png"

import { restaurantLabel } from "@food/utils/entityLabels"
const debugLog = (...args) => {}

const debugWarn = (...args) => {}

const debugError = (...args) => {}





export default function TransactionReport() {

  const [searchQuery, setSearchQuery] = useState("")

  const [transactions, setTransactions] = useState([])

  const [loading, setLoading] = useState(true)

  const [isRefreshing, setIsRefreshing] = useState(false)

  const [summary, setSummary] = useState({

    completedTransaction: 0,

    refundedTransaction: 0,

    adminEarning: 0,

    restaurantEarning: 0,

    deliverymanEarning: 0

  })

  const [filters, setFilters] = useState({

    zone: "All Zones",

    restaurant: "All restaurants",

    time: "All Time",

    fromDate: "",

    toDate: "",

    view: "",

  })

  // The card tapped: narrows the list, and an earning card adds that column.
  const [activeCard, setActiveCard] = useState(null)

  // How many match the filters; the list itself stops at the newest 500.
  const [totalCount, setTotalCount] = useState(0)

  // Bumped by the Filter button, to load again now.
  const [refreshTick, setRefreshTick] = useState(0)

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  const [zones, setZones] = useState([])

  const [restaurants, setRestaurants] = useState([])



  // Fetch zones and restaurants for filters

  useEffect(() => {

    const fetchFilterData = async () => {

      try {

        // Fetch zones

        const zonesResponse = await adminAPI.getZones({ limit: 1000 })

        if (zonesResponse?.data?.success && zonesResponse.data.data?.zones) {

          setZones(zonesResponse.data.data.zones)

        }



        // Fetch restaurants

        const restaurantsResponse = await adminAPI.getRestaurants({ limit: 1000 })

        if (restaurantsResponse?.data?.success && restaurantsResponse.data.data?.restaurants) {

          setRestaurants(restaurantsResponse.data.data.restaurants)

        }

      } catch (error) {

        debugError("Error fetching filter data:", error)

      }

    }

    fetchFilterData()

  }, [])



  // Fetch transaction report data

  useEffect(() => {

    // A slower earlier answer must not replace the one for the current filters.
    let stale = false

    const fetchTransactionReport = async () => {

      try {

        setIsRefreshing(true)



        // Build date range based on time filter

        let fromDate = null

        let toDate = null

        const now = new Date()



        if (filters.time === "Custom Range") {

          if (filters.fromDate) fromDate = new Date(`${filters.fromDate}T00:00:00`)

          if (filters.toDate) toDate = new Date(`${filters.toDate}T23:59:59`)

        } else if (filters.time === "Today") {

          fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())

          toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)

        } else if (filters.time === "This Week") {

          const dayOfWeek = now.getDay()

          const diff = now.getDate() - ((dayOfWeek + 6) % 7) // Monday to Sunday, as payouts

          fromDate = new Date(now.getFullYear(), now.getMonth(), diff)

          toDate = new Date(now.getFullYear(), now.getMonth(), diff + 6, 23, 59, 59)

        } else if (filters.time === "This Month") {

          fromDate = new Date(now.getFullYear(), now.getMonth(), 1)

          toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)

        } else if (filters.time === "This Year") {

          fromDate = new Date(now.getFullYear(), 0, 1)

          toDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59)

        }



        const params = {

          search: searchQuery || undefined,

          view: filters.view || undefined,

          zone: filters.zone !== "All Zones" ? filters.zone : undefined,

          restaurant: filters.restaurant !== "All restaurants" ? filters.restaurant : undefined,

          fromDate: fromDate ? fromDate.toISOString() : undefined,

          toDate: toDate ? toDate.toISOString() : undefined,

          limit: 500

        }



        const response = await adminAPI.getTransactionReport(params)

        if (stale) return



        if (response?.data?.success && response.data.data) {

          setTransactions(response.data.data.transactions || [])

          setTotalCount(response.data.data.pagination?.total ?? (response.data.data.transactions || []).length)

          setSummary(response.data.data.summary || {

            completedTransaction: 0,

            refundedTransaction: 0,

            adminEarning: 0,

            restaurantEarning: 0,

            deliverymanEarning: 0

          })

        } else {

          setTransactions([])

          if (response?.data?.message) {

            toast.error(response.data.message)

          }

        }

      } catch (error) {

        debugError("Error fetching transaction report:", error)

        toast.error("Failed to fetch transaction report")

        setTransactions([])

      } finally {

        setIsRefreshing(false)

        setLoading(false)

      }

    }



    fetchTransactionReport()

    return () => {
      stale = true
    }

  }, [searchQuery, filters, refreshTick])






  const filteredTransactions = useMemo(() => {

    return transactions // Backend already filters, so just return transactions

  }, [transactions])
  // Long lists page instead of rendering every row at once.
  const { pageRows: pagedRows, offset: pageOffset, pager: listPager } = usePagedRows(filteredTransactions)



  const handleExport = (format) => {

    if (filteredTransactions.length === 0) {

      alert("No data to export")

      return

    }

    switch (format) {

      case "csv": exportTransactionReportToCSV(filteredTransactions); break

      case "excel": exportTransactionReportToExcel(filteredTransactions); break

      case "pdf": exportTransactionReportToPDF(filteredTransactions); break

      case "json": exportTransactionReportToJSON(filteredTransactions); break

    }

  }



  const handleFilterApply = () => {

    // Filters apply as they change; this loads again now, for the latest orders.
    setRefreshTick((tick) => tick + 1)

  }



  const handleResetFilters = () => {

    setFilters({

      zone: "All Zones",

      restaurant: "All restaurants",

      time: "All Time",

      fromDate: "",

      toDate: "",

      view: "",

    })

    setActiveCard(null)

  }

  // Tap a card to list what it counts; tap it again to clear.
  const CARD_VIEWS = { completed: "completed", refunded: "refunded", admin: "completed", restaurant: "completed", deliveryman: "completed" }
  const selectCard = (key) => {
    const next = activeCard === key ? null : key
    setActiveCard(next)
    setFilters((prev) => ({ ...prev, view: next ? CARD_VIEWS[next] : "" }))
  }
  const cardProps = (key, padding) => ({
    role: "button",
    tabIndex: 0,
    "aria-pressed": activeCard === key,
    title: activeCard === key ? "Tap to show all" : "Tap to list these orders",
    onClick: () => selectCard(key),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        selectCard(key)
      }
    },
    className: `rounded-lg shadow-sm border ${padding} cursor-pointer transition-all hover:shadow-md ${
      activeCard === key ? "border-blue-600 ring-2 ring-blue-300" : "border-slate-200 hover:border-blue-300"
    }`,
  })
  const EARNING_COLUMNS = {
    admin: { label: "Admin Earning", field: "adminEarning" },
    restaurant: { label: "Restaurant Earning", field: "restaurantEarning" },
    deliveryman: { label: "Deliveryman Earning", field: "deliverymanEarning" },
  }
  const earningColumn = EARNING_COLUMNS[activeCard] || null
  const VIEW_TITLES = { completed: "Completed Transactions", refunded: "Refunded Transactions", cancelled: "Cancelled Orders", in_progress: "Orders In Progress" }



  const activeFiltersCount = (filters.zone !== "All Zones" ? 1 : 0) + (filters.restaurant !== "All restaurants" ? 1 : 0) + (filters.time !== "All Time" ? 1 : 0) + (filters.view ? 1 : 0)



  const formatCurrency = (amount) => {

    if (amount >= 1000) {

      return `\u20B9 ${(amount / 1000).toFixed(2)}K`

    }

    return `\u20B9 ${amount.toFixed(2)}`

  }



  const formatFullCurrency = (amount) => {

    return `\u20B9 ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  }



  const getStatusBadgeClasses = (status) => {

    const normalized = String(status || '').toLowerCase()



    if (['captured', 'settled', 'completed', 'paid', 'delivered'].includes(normalized)) {

      return 'bg-green-100 text-green-700'

    }

    if (['pending', 'created', 'authorized', 'cod_pending', 'in progress', 'partly refunded'].includes(normalized)) {

      return 'bg-yellow-100 text-yellow-700'

    }

    if (['failed', 'refunded', 'cancelled', 'cancelled_by_admin', 'cancelled_by_user', 'cancelled_by_restaurant'].includes(normalized)) {

      return 'bg-red-100 text-red-700'

    }



    return 'bg-slate-100 text-slate-700'

  }



  if (loading) {

    return (

      <div className="p-2 lg:p-3 bg-slate-50 min-h-screen flex items-center justify-center">

        <div className="flex flex-col items-center gap-4">

          <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />

          <p className="text-gray-600">Loading transaction report...</p>

        </div>

      </div>

    )

  }



  return (

    <div className="p-2 lg:p-3 bg-slate-50 min-h-screen">

      <div className="w-full mx-auto">

        {/* Page Header */}

        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3 mb-3">

          <div className="flex items-center gap-2">

            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">

              <BarChart3 className="w-3.5 h-3.5 text-white" />

            </div>

            <h1 className="text-lg font-bold text-slate-900">Transaction Report</h1>

          </div>

        </div>



        {/* Search Data Section */}

        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3 mb-3">

          <div className="flex flex-col sm:flex-row sm:items-center gap-2">

            <div className="relative flex-1 min-w-0">

              <select

                value={filters.zone}

                // A restaurant from another zone would leave the list empty.
                onChange={(e) => setFilters(prev => ({ ...prev, zone: e.target.value, restaurant: "All restaurants" }))}

                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"

              >

                <option value="All Zones">All Zones</option>

                {zones.map(zone => (

                  <option key={zone._id || zone.id} value={zone._id || zone.id}>{zone.zoneName || zone.name}</option>

                ))}

              </select>

              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />

            </div>



            <div className="relative flex-1 min-w-0">

              <select

                value={filters.restaurant}

                onChange={(e) => setFilters(prev => ({ ...prev, restaurant: e.target.value }))}

                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"

              >

                <option value="All restaurants">All restaurants</option>

                {restaurants
                  .filter((restaurant) => filters.zone === "All Zones" || !restaurant.zoneId || String(restaurant.zoneId?._id || restaurant.zoneId) === filters.zone)
                  .map(restaurant => (

                  <option key={restaurant._id || restaurant.id} value={restaurant._id || restaurant.id}>{restaurant.restaurantName || restaurant.name}</option>

                ))}

              </select>

              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />

            </div>



            <div className="relative flex-1 min-w-0">

              <select

                value={filters.time}

                onChange={(e) => setFilters(prev => ({

                  ...prev,

                  time: e.target.value,

                  ...(e.target.value !== "Custom Range" ? { fromDate: "", toDate: "" } : {}),

                }))}

                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none cursor-pointer"

              >

                <option value="All Time">All Time</option>

                <option value="Today">Today</option>

                <option value="This Week">This Week</option>

                <option value="This Month">This Month</option>

                <option value="This Year">This Year</option>

                <option value="Custom Range">Custom Range</option>

              </select>

              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />

            </div>



            <div className="relative flex-1 min-w-0">
              <select
                value={filters.view}
                onChange={(e) => {
                  setActiveCard(null)
                  setFilters((prev) => ({ ...prev, view: e.target.value }))
                }}
                aria-label="Status"
                className="w-full px-2.5 py-1.5 pr-5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs appearance-none"
              >
                <option value="">All statuses</option>
                <option value="completed">Completed</option>
                <option value="refunded">Refunded</option>
                <option value="cancelled">Cancelled</option>
                <option value="in_progress">In progress</option>
              </select>
              <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
            </div>

            <button

              onClick={handleFilterApply}

              className={`px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-all whitespace-nowrap relative ${

                activeFiltersCount > 0 ? "ring-2 ring-blue-300" : ""

              }`}

            >

              Filter

              {activeFiltersCount > 0 && (

                <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-500 text-white rounded-full text-[8px] flex items-center justify-center font-bold">

                  {activeFiltersCount}

                </span>

              )}

            </button>

            <button 

              onClick={handleResetFilters}

              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all whitespace-nowrap"

            >

              Reset

            </button>

          </div>



          {filters.time === "Custom Range" && (

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">

              <div className="relative">

                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />

                <input

                  type="date"

                  value={filters.fromDate}

                  onChange={(e) => setFilters(prev => ({ ...prev, fromDate: e.target.value }))}

                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"

                  placeholder="From Date"

                />

              </div>

              <div className="relative">

                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />

                <input

                  type="date"

                  value={filters.toDate}

                  onChange={(e) => setFilters(prev => ({ ...prev, toDate: e.target.value }))}

                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"

                  placeholder="To Date"

                />

              </div>

            </div>

          )}

        </div>



        {/* Summary Cards */}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">

          {/* Left Column - Large Cards */}

          <div className="space-y-3">

            {/* Completed Transaction - Green */}

            <div {...cardProps("completed", "p-4")} style={{ backgroundColor: '#f1f5f9' }}>

              <div className="relative mb-3 flex justify-center">

                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">

                  <img src={completedIcon} alt="Completed" className="w-12 h-12" />

                </div>

                <div className="absolute top-0 right-0 w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">

                  <Info className="w-3 h-3 text-white" />

                </div>

              </div>

              <div className="text-center">

                <p className="text-xl font-bold text-green-600 mb-1">{formatCurrency(summary.completedTransaction)}</p>

                <p className="text-sm text-slate-600 leading-tight">Completed Transaction</p>

                <p className="text-xs text-slate-500 mt-0.5">{summary.completedCount ?? 0} {summary.completedCount === 1 ? "order" : "orders"}</p>

              </div>

            </div>



            {/* Refunded Transaction - Red */}

            <div {...cardProps("refunded", "p-4")} style={{ backgroundColor: '#f1f5f9' }}>

              <div className="relative mb-3 flex justify-center">

                <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">

                  <img src={refundedIcon} alt="Refunded" className="w-12 h-12" />

                </div>

                <div className="absolute top-0 right-0 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center">

                  <Info className="w-3 h-3 text-white" />

                </div>

              </div>

              <div className="text-center">

                <p className="text-xl font-bold text-red-600 mb-1">{formatFullCurrency(summary.refundedTransaction)}</p>

                <p className="text-sm text-slate-600 leading-tight">Refunded Transaction</p>

                <p className="text-xs text-slate-500 mt-0.5">{summary.refundedCount ?? 0} {summary.refundedCount === 1 ? "order" : "orders"}</p>

              </div>

            </div>

          </div>



          {/* Right Column - Small Cards */}

          <div className="space-y-3">

            {/* Admin Earning */}

            <div {...cardProps("admin", "p-3")} style={{ backgroundColor: '#f1f5f9' }}>

              <div className="flex items-center justify-between">

                <div className="flex items-center gap-3">

                  <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">

                    <img src={adminEarningIcon} alt="Admin Earning" className="w-6 h-6" />

                  </div>

                  <div className="flex items-center gap-2">

                    <p className="text-sm font-semibold text-slate-900">Admin Earning</p>

                    <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">

                      <Info className="w-3 h-3 text-white" />

                    </div>

                  </div>

                </div>

                <p className="text-base font-bold text-slate-900">{formatCurrency(summary.adminEarning)}</p>

              </div>

            </div>



            {/* Restaurant Earning */}

            <div {...cardProps("restaurant", "p-3")} style={{ backgroundColor: '#f1f5f9' }}>

              <div className="flex items-center justify-between">

                <div className="flex items-center gap-3">

                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">

                    <img src={restaurantEarningIcon} alt="Restaurant Earning" className="w-6 h-6" />

                  </div>

                  <div className="flex items-center gap-2">

                    <p className="text-sm font-semibold text-slate-900">Restaurant Earning</p>

                    <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">

                      <Info className="w-3 h-3 text-white" />

                    </div>

                  </div>

                </div>

                <p className="text-base font-bold text-green-600">{formatCurrency(summary.restaurantEarning)}</p>

              </div>

            </div>



            {/* Deliveryman Earning */}

            <div {...cardProps("deliveryman", "p-3")} style={{ backgroundColor: '#f1f5f9' }}>

              <div className="flex items-center justify-between">

                <div className="flex items-center gap-3">

                  <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center">

                    <img src={deliverymanEarningIcon} alt="Deliveryman Earning" className="w-6 h-6" />

                  </div>

                  <div className="flex items-center gap-2">

                    <p className="text-sm font-semibold text-slate-900">Deliveryman Earning</p>

                    <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">

                      <Info className="w-3 h-3 text-white" />

                    </div>

                  </div>

                </div>

                <p className="text-base font-bold text-orange-600">{formatCurrency(summary.deliverymanEarning)}</p>

              </div>

            </div>

          </div>

        </div>



        {/* Order Transactions Section */}

        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-3">

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">

            <div>
              <h2 className="text-base font-bold text-slate-900">{VIEW_TITLES[filters.view] || "Order Transactions"} {totalCount}</h2>
              {totalCount > filteredTransactions.length ? (
                <p className="text-[11px] text-slate-500">Showing the newest {filteredTransactions.length}. Narrow the filters to see older ones.</p>
              ) : null}
            </div>



            <div className="flex items-center gap-2">

              <div className="relative flex-1 sm:flex-initial min-w-[180px]">

                <input

                  type="text"

                  placeholder="Search by Order ID"

                  value={searchQuery}

                  onChange={(e) => setSearchQuery(e.target.value)}

                  className="pl-7 pr-2 py-1.5 w-full text-[11px] rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"

                />

                <img src={searchIcon} alt="Search" className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" />

                {isRefreshing && (

                  <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 animate-spin" />

                )}

              </div>



              <DropdownMenu>

                <DropdownMenuTrigger asChild>

                  <button className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1 transition-all">

                    <img src={exportIcon} alt="Export" className="w-3 h-3" />

                    <span>Export</span>

                    <ChevronDown className="w-2.5 h-2.5" />

                  </button>

                </DropdownMenuTrigger>

                <DropdownMenuContent align="end" className="w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50 animate-in fade-in-0 zoom-in-95 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">

                  <DropdownMenuLabel>Export Format</DropdownMenuLabel>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onClick={() => handleExport("csv")} className="cursor-pointer">

                    <FileText className="w-4 h-4 mr-2" />

                    Export as CSV

                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={() => handleExport("excel")} className="cursor-pointer">

                    <FileSpreadsheet className="w-4 h-4 mr-2" />

                    Export as Excel

                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={() => handleExport("pdf")} className="cursor-pointer">

                    <FileText className="w-4 h-4 mr-2" />

                    Export as PDF

                  </DropdownMenuItem>

                  <DropdownMenuItem onClick={() => handleExport("json")} className="cursor-pointer">

                    <Code className="w-4 h-4 mr-2" />

                    Export as JSON

                  </DropdownMenuItem>

                </DropdownMenuContent>

              </DropdownMenu>

              <button 

                onClick={() => setIsSettingsOpen(true)}

                className="p-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition-all"

              >

                <Settings className="w-3 h-3" />

              </button>

            </div>

          </div>



          {/* Table */}

          <div className="overflow-x-auto">

            {/* A minimum width, so on a small screen the table scrolls sideways
                instead of squeezing the columns until the order id runs into the next. */}
            <table className="w-full" style={{ tableLayout: 'fixed', width: '100%', minWidth: '1100px' }}>

              <thead className="bg-slate-50 border-b border-slate-200">

                <tr>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '3%' }}>SI</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '11%' }}>Order Id</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Restaurant</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Customer Name</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '11%' }}>Total Item Amount</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Coupon Discount</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Vat/Tax</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '10%' }}>Delivery Charge</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Platform Fee</th>

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '9%' }}>Order Amount</th>

                  {earningColumn ? (
                    <th className="px-1.5 py-1 text-left text-[8px] font-bold text-blue-700 uppercase tracking-wider" style={{ width: '10%' }}>{earningColumn.label}</th>
                  ) : null}

                  <th className="px-1.5 py-1 text-left text-[8px] font-bold text-slate-700 uppercase tracking-wider" style={{ width: '8%' }}>Status</th>

                </tr>

              </thead>

              <tbody className="bg-white divide-y divide-slate-100">

                {filteredTransactions.length === 0 ? (

                  <tr>

                    <td colSpan={earningColumn ? 12 : 11} className="px-6 py-20 text-center">

                      <div className="flex flex-col items-center justify-center">

                        <p className="text-lg font-semibold text-slate-700 mb-1">No Data Found</p>

                        <p className="text-sm text-slate-500">No transactions match your search</p>

                      </div>

                    </td>

                  </tr>

                ) : (

                  pagedRows.map((transaction, index) => (

                    <tr

                      key={transaction.id}

                      className="hover:bg-slate-50 transition-colors"

                    >

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] font-medium text-slate-700">{pageOffset + index + 1}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700 whitespace-nowrap">{transaction.orderId}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700 truncate block">{restaurantLabel(transaction.restaurant)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className={`text-[10px] truncate block ${

                          transaction.customerName === "Invalid Customer Data" 

                            ? "text-red-600 font-semibold" 

                            : "text-slate-700"

                        }`}>

                          {transaction.customerName}

                        </span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.totalItemAmount)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.couponDiscount)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.vatTax)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.deliveryCharge)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] text-slate-700">{formatFullCurrency(transaction.platformFee || 0)}</span>

                      </td>

                      <td className="px-1.5 py-1">

                        <span className="text-[10px] font-medium text-slate-900">{formatFullCurrency(transaction.orderAmount)}</span>

                      </td>

                      {earningColumn ? (
                        <td className="px-1.5 py-1">
                          <span className="text-[10px] font-semibold text-blue-700">{formatFullCurrency(Number(transaction[earningColumn.field]) || 0)}</span>
                        </td>
                      ) : null}

                      <td className="px-1.5 py-1">

                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${getStatusBadgeClasses(transaction.statusLabel || transaction.status || transaction.orderStatus)}`}>

                          {transaction.statusLabel || transaction.status || transaction.orderStatus || 'N/A'}

                        </span>

                      </td>

                    </tr>

                  ))

                )}

              </tbody>

            </table>
            {listPager}

          </div>




        </div>

      </div>



      {/* Settings Dialog */}

      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>

        <DialogContent className="max-w-md bg-white p-0 opacity-0 data-[state=open]:opacity-100 data-[state=closed]:opacity-0 transition-opacity duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:scale-100 data-[state=closed]:scale-100">

          <DialogHeader className="px-6 pt-6 pb-4">

            <DialogTitle className="flex items-center gap-2">

              <Settings className="w-5 h-5" />

              Report Settings

            </DialogTitle>

          </DialogHeader>

          <div className="px-6 pb-6">

            <p className="text-sm text-slate-700">

              Transaction report settings and preferences will be available here.

            </p>

          </div>

          <div className="px-6 pb-6 flex items-center justify-end">

            <button

              onClick={() => setIsSettingsOpen(false)}

              className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-all shadow-md"

            >

              Close

            </button>

          </div>

        </DialogContent>

      </Dialog>

    </div>

  )

}

