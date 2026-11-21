/** Pure prep-time maths shared by the order mapper and the delay check. */
export const KITCHEN = ['confirmed', 'preparing'];

/** When this order's food is due, or null (not accepted, no prep time). */
export function prepDueAt(order) {
  const minutes = Number(order?.packingMinutes ?? order?.pricing?.packingMinutes);
  if (!(minutes > 0)) return null;
  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  const accepted = history.find((h) => h?.to === 'confirmed' || h?.to === 'preparing');
  const at = accepted?.at ? new Date(accepted.at) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  return new Date(at.getTime() + minutes * 60000);
}

/** The prep block every app reads: due time, minutes, and whether it is late. */
export function prepInfo(order, now = new Date()) {
  const due = prepDueAt(order);
  if (!due) return null;
  const status = String(order?.orderStatus || '');
  const inKitchen = KITCHEN.includes(status);
  const readyEntry = (order?.statusHistory || []).find((h) => h?.to === 'ready_for_pickup');
  const readyAt = readyEntry?.at ? new Date(readyEntry.at) : null;
  return {
    minutes: Number(order.packingMinutes ?? order?.pricing?.packingMinutes) || null,
    dueAt: due.toISOString(),
    readyAt: readyAt ? readyAt.toISOString() : null,
    // Late right now (still cooking past due), or was late when marked ready.
    delayed: inKitchen ? now > due : Boolean(readyAt && readyAt > due),
    delayedByMinutes: inKitchen
      ? Math.max(0, Math.round((now - due) / 60000))
      : readyAt && readyAt > due
        ? Math.round((readyAt - due) / 60000)
        : 0,
  };
}

