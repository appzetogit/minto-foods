import { useEffect, useState } from "react"
import { loadBusinessSettings } from "@food/utils/businessSettings"
import { telHref } from "@/shared/utils/tel"

/** The support numbers an admin set in Business settings, each a +91 tel link. */
export default function SupportPhoneLinks({ className = "text-sm text-primary hover:underline font-medium" }) {
  const [phones, setPhones] = useState([])

  useEffect(() => {
    let alive = true
    loadBusinessSettings().then((s) => {
      if (!alive) return
      const list = Array.isArray(s?.supportPhones) ? s.supportPhones : []
      const fallback = s?.phone?.number ? [`${s.phone.countryCode || "+91"}${s.phone.number}`] : []
      setPhones(list.length ? list : fallback)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!phones.length) return <span className="text-sm text-muted-foreground">Support number coming soon</span>

  return (
    <div className="flex flex-col gap-1">
      {phones.map((p) => (
        <a key={p} href={telHref(p)} className={className}>
          {telHref(p).replace("tel:+91", "+91 ")}
        </a>
      ))}
    </div>
  )
}
