import DesktopSidebar from "./DesktopSidebar"

/**
 * On desktop the page sits in a rounded frame beside the sidebar.
 *
 * The frame used to clip its contents, so only pages that built their own
 * scroll area could scroll -- every page written as a plain `min-h-screen`
 * column (offers, reviews, FSSAI, owner details and about twenty more) was cut
 * off at the bottom of the window with no way to reach the rest.
 *
 * The frame scrolls now. And because the frame is shorter than the viewport, a
 * page root sized to the screen is resized to the frame, so it neither
 * overflows by a sliver nor gains a second scrollbar; pages that manage their
 * own scrolling (menu, inventory, orders) fill it exactly as before.
 */
export default function RestaurantLayout({ children }) {
  return (
    <div className="flex h-screen bg-white md:bg-gray-50 overflow-hidden">
      <DesktopSidebar />
      <main className="flex-1 min-w-0 md:ml-64 relative h-screen overflow-y-auto md:overflow-hidden flex flex-col custom-scrollbar">
        <div className="w-full flex-1 flex flex-col md:rounded-tl-2xl md:shadow-sm md:border-l md:border-t md:border-gray-200 bg-white md:bg-transparent min-h-full md:h-full md:min-h-0 md:overflow-y-auto md:overflow-x-hidden custom-scrollbar md:[&>.min-h-screen]:min-h-full md:[&>.h-screen]:h-full">
          {children}
        </div>
      </main>
    </div>
  )
}
