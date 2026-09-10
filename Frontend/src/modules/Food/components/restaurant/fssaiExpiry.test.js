import test from "node:test"
import assert from "node:assert/strict"

import { daysUntilExpiry, expiryLevel, expiryMessage } from "./fssaiExpiry.js"

/**
 * When the licence banner speaks, and what it says.
 *
 * Both ends matter. Too eager and it is permanent furniture nobody reads by the
 * time it counts; too late and it repeats the mistake it exists to fix — the
 * only warning that existed fired *after* the licence had already lapsed.
 */

const on = (iso) => new Date(iso)

test("a licence expiring today reads as zero days, not expired", () => {
  // The column has no time of day. Comparing raw timestamps made the same
  // licence read "expired" or "1 day" depending on the hour the page opened.
  const days = daysUntilExpiry("2026-09-20", on("2026-09-20T23:30:00"))
  assert.equal(days, 0)
  assert.equal(expiryLevel(days), "urgent")
})

test("midnight and late evening on the same day agree", () => {
  const early = daysUntilExpiry("2026-10-01", on("2026-09-20T00:01:00"))
  const late = daysUntilExpiry("2026-10-01", on("2026-09-20T23:59:00"))
  assert.equal(early, late)
})

test("nothing is shown beyond thirty days", () => {
  assert.equal(expiryLevel(daysUntilExpiry("2026-12-25", on("2026-09-20"))), null)
  assert.equal(expiryLevel(31), null)
})

test("thirty days is the first warning", () => {
  assert.equal(expiryLevel(30), "warning")
  assert.equal(expiryLevel(8), "warning")
})

test("the last week is urgent", () => {
  assert.equal(expiryLevel(7), "urgent")
  assert.equal(expiryLevel(1), "urgent")
  assert.equal(expiryLevel(0), "urgent")
})

test("a lapsed licence is its own level", () => {
  assert.equal(expiryLevel(-1), "expired")
  assert.equal(expiryLevel(daysUntilExpiry("2026-09-01", on("2026-09-20"))), "expired")
})

test("a restaurant with no expiry recorded sees nothing", () => {
  // Most restaurants predate the field. A banner saying "expires Invalid Date"
  // would be worse than silence.
  for (const missing of [null, undefined, "", "not-a-date"]) {
    assert.equal(daysUntilExpiry(missing), null)
    assert.equal(expiryLevel(daysUntilExpiry(missing)), null)
  }
})

test("the expired message says how long ago, and reads correctly at one day", () => {
  const { title, body } = expiryMessage(-1, "2026-09-19")
  assert.match(title, /has expired/)
  assert.match(body, /1 day ago/)
  assert.ok(!body.includes("1 days"))
})

test("singular and plural both read correctly counting down", () => {
  assert.match(expiryMessage(1, "2026-09-21").title, /in 1 day$/)
  assert.match(expiryMessage(5, "2026-09-25").title, /in 5 days$/)
})

test("expiring today does not say 'in 0 days'", () => {
  const { title } = expiryMessage(0, "2026-09-20")
  assert.match(title, /expires today/)
})
