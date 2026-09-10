/**
 * When to warn a restaurant that its FSSAI licence is running out, and what to
 * say.
 *
 * Kept apart from the banner component so the thresholds can be tested without a
 * renderer. Both ends of the range matter: warn too early and the banner becomes
 * furniture nobody reads by the time it counts; warn too late and it repeats the
 * mistake it exists to fix, since the only warning that existed fired *after* the
 * licence had already lapsed.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whole days until the licence lapses, negative once it has.
 *
 * Both dates are floored to midnight first. The column carries no time of day,
 * so comparing raw timestamps would make the same licence read "expired" or
 * "1 day" depending on the hour the page happened to be opened.
 */
export const daysUntilExpiry = (value, now = new Date()) => {
  if (!value) return null
  const expiry = new Date(value)
  if (Number.isNaN(expiry.getTime())) return null

  const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((atMidnight(expiry) - atMidnight(now)) / DAY_MS)
}

/** How loudly to say it, or null to stay quiet. */
export const expiryLevel = (days) => {
  if (days === null) return null
  if (days < 0) return "expired"
  if (days <= 7) return "urgent"
  if (days <= 30) return "warning"
  return null
}

const dateLabel = (value) =>
  new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })

export const expiryMessage = (days, value) => {
  if (days < 0) {
    const ago = Math.abs(days)
    return {
      title: "Your FSSAI licence has expired",
      body: `It expired on ${dateLabel(value)}, ${ago} day${ago === 1 ? "" : "s"} ago. Renew it and upload the new certificate.`,
    }
  }
  if (days === 0) {
    return {
      title: "Your FSSAI licence expires today",
      body: `It is valid until the end of ${dateLabel(value)}. Renew it and upload the new certificate.`,
    }
  }
  return {
    title: `Your FSSAI licence expires in ${days} day${days === 1 ? "" : "s"}`,
    body: `It is valid until ${dateLabel(value)}. Renewal can take a few days, so it is worth starting now.`,
  }
}
