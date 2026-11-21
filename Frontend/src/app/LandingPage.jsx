import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight, Apple, Play, MapPin, Clock, Bike, Store, ShieldCheck, Smartphone,
  Search, ShoppingBag, Navigation, Menu, X, Check, Loader2, BadgePercent, Star,
  LocateFixed, ChevronDown, ChevronLeft, ChevronRight, Copy, Leaf, Tag, UtensilsCrossed,
  Facebook, Youtube, Instagram, Linkedin, Mail, Phone, HeartHandshake,
} from "lucide-react";
import apiClient, { adminAPI, restaurantAPI, zoneAPI } from "../services/api";

// Minto's own store listings and social pages. Empty until they are published:
// a missing link renders as "Coming soon" instead of sending people somewhere else.
const STORE_LINKS = {
  customer: { ios: "", android: "" },
  restaurant: { ios: "", android: "" },
  delivery: { ios: "", android: "" },
};
const SOCIAL_LINKS = [
  // { network: "instagram", url: "https://www.instagram.com/..." },
];

const ORDER_URL = "/food/user";
const CITY_STORAGE_KEY = "minto_landing_city";
const PAGE_SIZE = 8;

// Brand palette from the logo: deep teal -> bright teal gradient on soft mint.
const C = { deep: "#0B6E63", teal: "#12A594", bright: "#19C9B4", mint: "#E7F7F3", ink: "#0E2724" };
const GRADIENT = `linear-gradient(135deg, ${C.deep} 0%, ${C.teal} 55%, ${C.bright} 100%)`;

const FALLBACK_FOOD = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=800&auto=format&fit=crop";

// ───────────────────────── helpers ─────────────────────────

const imgUrl = (v) => (typeof v === "string" ? v : v?.url || v?.imageUrl || "");

const prettyCity = (name = "") =>
  String(name)
    .replace(/\s*zone\s*$/i, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

// Centre of a zone polygon, used as the point we list restaurants around.
const zoneCentre = (zone) => {
  const pts = (zone?.coordinates || []).filter((p) => Number.isFinite(p?.latitude) && Number.isFinite(p?.longitude));
  if (!pts.length) return null;
  return {
    lat: pts.reduce((s, p) => s + p.latitude, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.longitude, 0) / pts.length,
  };
};

const restaurantSlug = (r) => r.slug || r.nameSlug || r.restaurantId || r.id || r._id;
const restaurantImage = (r) => imgUrl(r.coverImages?.[0]) || imgUrl(r.profileImage) || "";
const deliveryMins = (r) => {
  const m = Number(r.estimatedDeliveryTimeMinutes) || parseInt(r.estimatedDeliveryTime, 10);
  return Number.isFinite(m) && m > 0 ? m : null;
};
const offerText = (r) => r.activeOffers?.[0]?.summary || r.offer || "";
const isOpen = (r) => r.isOpenNow ?? r.isOpen ?? true;

const readStoredCity = () => {
  try {
    return JSON.parse(localStorage.getItem(CITY_STORAGE_KEY) || "null");
  } catch {
    return null;
  }
};
const storeCity = (city) => {
  try {
    localStorage.setItem(CITY_STORAGE_KEY, JSON.stringify(city));
  } catch {
    /* private mode etc. */
  }
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 } }),
};

// ───────────────────────── small pieces ─────────────────────────

function SpeedLines({ className = "", light = false }) {
  return (
    <span className={`inline-flex flex-col gap-[5px] ${className}`} aria-hidden="true">
      <span className="h-[5px] w-7 rounded-full" style={{ background: light ? "#fff" : C.bright, opacity: 0.45 }} />
      <span className="h-[5px] w-5 rounded-full ml-2" style={{ background: light ? "#fff" : C.teal, opacity: 0.7 }} />
      <span className="h-[5px] w-8 rounded-full" style={{ background: light ? "#fff" : C.teal }} />
    </span>
  );
}

function Wordmark({ light = false, compact = false }) {
  return (
    <a href="/" className="flex items-center gap-2 shrink-0" aria-label="MintoFood home">
      <img src="/minto-logo.png" alt="" className="h-9 w-9 rounded-xl shadow-sm" />
      <span className={`${compact ? "hidden sm:inline" : ""} text-xl sm:text-2xl font-extrabold tracking-tight leading-none`}>
        <span style={{ color: light ? "#fff" : C.deep }}>Minto</span>
        <span style={{ color: light ? "#9BF0E3" : C.bright }}>Food</span>
      </span>
    </a>
  );
}

function StoreButton({ href, icon: Icon, top, label, dark = true }) {
  const base = `flex items-center gap-3 rounded-2xl px-5 py-3 transition-all duration-300 ${
    dark ? "bg-[#0E2724] text-white hover:bg-black" : "bg-white text-[#0E2724] hover:bg-[#F3FBF9]"
  }`;
  const inner = (
    <>
      <Icon className="w-6 h-6 shrink-0" />
      <span className="flex flex-col leading-tight text-left">
        <span className="text-[10px] uppercase tracking-wider opacity-70">{href ? top : "Coming soon on"}</span>
        <span className="text-base font-bold">{label}</span>
      </span>
    </>
  );
  if (!href) return <span className={`${base} opacity-80 cursor-default`} aria-disabled="true">{inner}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={base}>{inner}</a>;
}

function SectionHead({ tag, title, right }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-6">
      <div>
        <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.teal }}>
          <SpeedLines className="scale-[0.5] -my-2 -mx-2" />
          {tag}
        </span>
        <h2 className="mt-1 text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight">{title}</h2>
      </div>
      {right}
    </div>
  );
}

function ScrollButtons({ targetRef }) {
  const scroll = (dir) => targetRef.current?.scrollBy({ left: dir * targetRef.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <div className="hidden sm:flex gap-2 shrink-0">
      {[[-1, ChevronLeft, "Scroll left"], [1, ChevronRight, "Scroll right"]].map(([d, Icon, label]) => (
        <button
          key={label}
          onClick={() => scroll(d)}
          aria-label={label}
          className="w-10 h-10 rounded-full border border-slate-200 bg-white flex items-center justify-center text-slate-600 hover:border-[#12A594] hover:text-[#0B6E63] transition"
        >
          <Icon className="w-5 h-5" />
        </button>
      ))}
    </div>
  );
}

function Img({ src, alt, className, fallback = FALLBACK_FOOD }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <img
      src={!src || failed ? fallback : src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

const Skeleton = ({ className }) => <div className={`animate-pulse rounded-2xl bg-slate-100 ${className}`} />;

function RestaurantCard({ r }) {
  const open = isOpen(r);
  const mins = deliveryMins(r);
  const offer = offerText(r);
  const dist = Number(r.distanceKm ?? r.distanceInKm);
  const rating = Number(r.rating) || 0;
  return (
    <a
      href={`/food/user/restaurants/${restaurantSlug(r)}`}
      className="group block rounded-3xl bg-white border border-slate-100 overflow-hidden hover:shadow-xl hover:shadow-[#12A594]/10 hover:-translate-y-1 transition-all duration-300"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-[#E7F7F3]">
        <Img src={restaurantImage(r)} alt={r.restaurantName || r.name} className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ${open ? "" : "grayscale"}`} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
          {r.highlightBadgeInfo?.label && (
            <span className="rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-bold text-[#0E2724]">★ {r.highlightBadgeInfo.label}</span>
          )}
          {r.pureVegRestaurant && (
            <span className="rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-bold text-green-700 inline-flex items-center gap-1">
              <Leaf className="w-3 h-3" /> Pure Veg
            </span>
          )}
        </div>
        {offer && (
          <span className="absolute bottom-3 left-3 right-3 text-white text-sm font-extrabold drop-shadow inline-flex items-center gap-1.5 truncate">
            <Tag className="w-4 h-4 shrink-0" /> <span className="truncate">{offer}</span>
          </span>
        )}
        {!open && (
          <span className="absolute top-3 right-3 rounded-full bg-black/75 px-2.5 py-1 text-[11px] font-bold text-white">Closed now</span>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-bold text-lg leading-snug truncate">{r.restaurantName || r.name}</h3>
          {rating > 0 ? (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-sm font-bold text-white" style={{ background: C.teal }}>
              {rating.toFixed(1)} <Star className="w-3 h-3 fill-white" />
            </span>
          ) : (
            <span className="shrink-0 rounded-lg bg-[#E7F7F3] px-2 py-0.5 text-xs font-bold text-[#0B6E63]">NEW</span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-500 truncate">{(r.cuisines || []).slice(0, 3).join(" • ") || "Multi-cuisine"}</p>
        <div className="mt-3 flex items-center gap-3 text-sm text-slate-600">
          {mins && <span className="inline-flex items-center gap-1"><Clock className="w-4 h-4 text-[#12A594]" /> {mins}–{mins + 5} min</span>}
          {Number.isFinite(dist) && <span className="inline-flex items-center gap-1"><MapPin className="w-4 h-4 text-[#12A594]" /> {dist.toFixed(1)} km</span>}
          {r.area && <span className="truncate text-slate-400">{r.area}</span>}
        </div>
      </div>
    </a>
  );
}

const inputCls =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-[#12A594] focus:ring-4 focus:ring-[#12A594]/15 transition";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open now", test: (r) => isOpen(r) },
  { key: "veg", label: "Pure Veg", icon: Leaf, test: (r) => r.pureVegRestaurant },
  { key: "rating", label: "Rating 4.0+", test: (r) => Number(r.rating) >= 4 },
  { key: "offers", label: "Offers", test: (r) => Boolean(offerText(r)) },
  { key: "fast", label: "Under 30 min", test: (r) => (deliveryMins(r) ?? 99) <= 30 },
];

// ───────────────────────── page ─────────────────────────

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Location: a zone picked from the list, or the browser's own location.
  const [zones, setZones] = useState([]);
  const [city, setCity] = useState(readStoredCity); // { id, name, lat, lng }
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState("");

  // Live data for that location.
  const [restaurants, setRestaurants] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("all");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [copied, setCopied] = useState("");

  const [supportContact, setSupportContact] = useState({ email: "support@mintofood.com", mobile: "" });
  const [leadForm, setLeadForm] = useState({ ownerName: "", restaurantName: "", mobileNumber: "", emailId: "", location: "" });
  const [submittingLead, setSubmittingLead] = useState(false);
  const [leadSuccess, setLeadSuccess] = useState(false);
  const [leadError, setLeadError] = useState("");

  const offersRef = useRef(null);
  const catsRef = useRef(null);
  const dishesRef = useRef(null);

  useEffect(() => {
    document.title = "MintoFood – Order food online";
    (async () => {
      try {
        const response = await apiClient.get("/food/pages/support", { params: { module: "USER" } });
        const data = response?.data?.data || response?.data;
        if (data && (data.email || data.mobile)) {
          setSupportContact((p) => ({ email: data.email || p.email, mobile: data.mobile || p.mobile }));
        }
      } catch (err) {
        console.error("Error fetching support contact:", err);
      }
    })();
  }, []);

  // Zones -> city list. Default to the first city that has a centre.
  useEffect(() => {
    (async () => {
      try {
        const res = await zoneAPI.getPublicZones();
        const list = (res?.data?.data?.zones || [])
          .filter((z) => z.isActive !== false)
          .map((z) => ({ id: z._id || z.id, name: prettyCity(z.name || z.zoneName), ...zoneCentre(z) }))
          .filter((z) => Number.isFinite(z.lat));
        setZones(list);
        setCity((current) => {
          if (current && Number.isFinite(current.lat)) return current;
          const preferred = list.find((z) => /bhiwandi/i.test(z.name)) || list[0];
          return preferred || null;
        });
      } catch (err) {
        console.error("Error fetching zones:", err);
        setLoading(false);
        setLoadError("Couldn't load cities right now.");
      }
    })();
  }, []);

  // Restaurants + categories for the chosen location.
  useEffect(() => {
    if (!city || !Number.isFinite(city.lat)) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setVisible(PAGE_SIZE);
    const params = { lat: city.lat, lng: city.lng };
    Promise.allSettled([
      restaurantAPI.getRestaurants(params),
      adminAPI.getPublicCategories(params),
    ]).then(([rRes, cRes]) => {
      if (cancelled) return;
      if (rRes.status === "fulfilled") {
        setRestaurants(rRes.value?.data?.data?.restaurants || []);
      } else {
        setRestaurants([]);
        setLoadError("Couldn't load restaurants right now. Please try again.");
      }
      setCategories(cRes.status === "fulfilled" ? cRes.value?.data?.data?.categories || cRes.value?.data?.categories || [] : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [city]);

  const chooseCity = (c) => {
    setCity(c);
    storeCity(c);
    setCityOpen(false);
    setLocError("");
    setFilter("all");
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocError("Location isn't available in this browser.");
      return;
    }
    setLocating(true);
    setLocError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        chooseCity({ id: "gps", name: "Your location", lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setLocError("Couldn't get your location. Pick a city instead.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  const onSearch = (e) => {
    e.preventDefault();
    const q = query.trim();
    window.location.href = q ? `/food/user/search?q=${encodeURIComponent(q)}` : ORDER_URL;
  };

  // Derived live sections.
  const openCount = useMemo(() => restaurants.filter(isOpen).length, [restaurants]);
  const cuisineCount = useMemo(() => new Set(restaurants.flatMap((r) => r.cuisines || [])).size, [restaurants]);

  const offers = useMemo(() => {
    const list = [];
    for (const r of restaurants) {
      const coupons = r.activeOffers || [];
      if (coupons.length) {
        coupons.forEach((o) => list.push({ key: `${r.id}-${o.id}`, r, text: o.summary, code: o.couponCode }));
      } else if (r.offer) {
        list.push({ key: `${r.id}-offer`, r, text: r.offer, code: "" });
      }
    }
    return list;
  }, [restaurants]);

  const dishes = useMemo(() => {
    const list = [];
    for (const r of restaurants) {
      for (const d of r.recommendedItems || []) {
        list.push({ ...d, r });
      }
    }
    return list.slice(0, 16);
  }, [restaurants]);
  const heroDish = useMemo(() => dishes.find((d) => d.image) || dishes[0] || null, [dishes]);

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter);
    return f?.test ? restaurants.filter(f.test) : restaurants;
  }, [restaurants, filter]);

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(""), 1800);
    } catch {
      /* clipboard blocked: the code is still visible to copy by hand */
    }
  };

  const handleLeadSubmit = async (e) => {
    e.preventDefault();
    setLeadError("");
    if (Object.values(leadForm).some((v) => !String(v).trim())) {
      setLeadError("Please fill in all the details.");
      return;
    }
    try {
      setSubmittingLead(true);
      await restaurantAPI.createUnregisteredRestaurant(leadForm);
      setLeadSuccess(true);
      setLeadForm({ ownerName: "", restaurantName: "", mobileNumber: "", emailId: "", location: "" });
    } catch (err) {
      console.error("Error submitting lead:", err);
      setLeadError(err.response?.data?.message || "Could not submit right now. Please try again.");
    } finally {
      setSubmittingLead(false);
    }
  };
  const setField = (k) => (e) => setLeadForm((f) => ({ ...f, [k]: e.target.value }));

  const navLinks = [
    { href: "#restaurants", label: "Restaurants" },
    { href: "#offers", label: "Offers" },
    { href: "#download", label: "Get the app" },
    { href: "#partner", label: "Partner with us" },
  ];

  const cityLabel = city?.name || "Select city";

  return (
    <div
      className="min-h-screen w-full overflow-x-hidden bg-white text-[#0E2724] selection:bg-[#12A594] selection:text-white"
      style={{ fontFamily: "Outfit, Inter, system-ui, sans-serif" }}
    >
      {/* ───────────── HEADER ───────────── */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-[#12A594]/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3 sm:gap-5">
          <Wordmark compact />

          {/* City picker */}
          <div className="relative">
            <button
              onClick={() => setCityOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold hover:bg-[#E7F7F3] transition max-w-[160px]"
              aria-expanded={cityOpen}
            >
              <MapPin className="w-4 h-4 text-[#12A594] shrink-0" />
              <span className="truncate">{cityLabel}</span>
              <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${cityOpen ? "rotate-180" : ""}`} />
            </button>
            {cityOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setCityOpen(false)} />
                <div className="absolute left-0 mt-2 z-50 w-64 rounded-2xl bg-white shadow-2xl border border-slate-100 p-2">
                  <button
                    onClick={useMyLocation}
                    className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold text-[#0B6E63] hover:bg-[#E7F7F3]"
                  >
                    {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LocateFixed className="w-4 h-4" />}
                    Use my current location
                  </button>
                  {locError && <p className="px-3 pb-2 text-xs text-red-600">{locError}</p>}
                  <p className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">We deliver in</p>
                  {zones.map((z) => (
                    <button
                      key={z.id}
                      onClick={() => chooseCity(z)}
                      className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-sm hover:bg-slate-50 ${city?.id === z.id ? "font-bold text-[#0B6E63]" : ""}`}
                    >
                      {z.name}
                      {city?.id === z.id && <Check className="w-4 h-4" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Search (desktop) */}
          <form onSubmit={onSearch} className="hidden md:flex flex-1 max-w-md items-center gap-2 rounded-full bg-slate-50 border border-slate-200 px-4 py-2 focus-within:border-[#12A594] focus-within:bg-white transition">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for restaurants or dishes"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            />
          </form>

          <nav className="hidden lg:flex items-center gap-5 text-sm font-medium text-slate-600 ml-auto">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="hover:text-[#0B6E63] transition-colors">{l.label}</a>
            ))}
          </nav>

          <div className="flex items-center gap-1 ml-auto lg:ml-0">
            <a
              href={ORDER_URL}
              className="rounded-full px-4 sm:px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[#12A594]/25 hover:-translate-y-px transition-all whitespace-nowrap"
              style={{ background: GRADIENT }}
            >
              Order Now
            </a>
            <button className="lg:hidden p-2 rounded-full hover:bg-[#E7F7F3] text-[#0B6E63]" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="lg:hidden border-t border-[#12A594]/10 bg-white px-4 py-2 flex flex-col">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="py-3 text-base font-medium text-slate-700 border-b border-slate-100 last:border-0">
                {l.label}
              </a>
            ))}
          </div>
        )}
      </header>

      {/* ───────────── HERO ───────────── */}
      <section className="relative overflow-hidden">
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 1440 800" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0,0 L1440,0 L1440,200 C1150,280 1000,100 720,170 C440,240 260,90 0,180 Z" fill="#E7F7F3" />
          <path d="M1440,0 L1440,460 C1300,360 1250,170 1060,0 Z" fill="#CFF0E9" opacity="0.6" />
          <path d="M0,800 L1440,800 L1440,690 C1180,620 980,760 700,710 C420,660 220,770 0,730 Z" fill="#F4FBF9" />
        </svg>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-14 md:pt-16 md:pb-20 grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div className="min-w-0">
            <motion.span initial="hidden" animate="visible" variants={fadeUp} custom={0}
              className="inline-flex items-center gap-2 rounded-full bg-white border border-[#12A594]/20 px-3 py-1.5 text-xs font-semibold text-[#0B6E63] shadow-sm"
            >
              <span className="h-2 w-2 rounded-full bg-[#19C9B4] animate-pulse" />
              {loading ? "Checking restaurants near you…" : `${openCount} restaurants open now in ${cityLabel}`}
            </motion.span>

            <motion.h1 initial="hidden" animate="visible" variants={fadeUp} custom={1}
              className="mt-5 text-[2.5rem] leading-[1.05] sm:text-5xl md:text-6xl font-extrabold tracking-tight"
            >
              Hungry? Order from
              <br />
              <span className="inline-flex items-center gap-3">
                <SpeedLines className="hidden sm:inline-flex" />
                <span className="bg-clip-text text-transparent" style={{ backgroundImage: GRADIENT }}>the best near you.</span>
              </span>
            </motion.h1>

            <motion.p initial="hidden" animate="visible" variants={fadeUp} custom={2} className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed max-w-lg">
              Local favourites, fresh off the stove, tracked live from the kitchen to your door.
            </motion.p>

            {/* Big search */}
            <motion.form initial="hidden" animate="visible" variants={fadeUp} custom={3} onSubmit={onSearch}
              className="mt-7 flex items-center gap-2 rounded-full bg-white border-2 border-[#12A594]/20 focus-within:border-[#12A594] p-1.5 pl-5 shadow-lg shadow-[#12A594]/10 max-w-xl transition"
            >
              <Search className="w-5 h-5 text-slate-400 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Try “biryani”, “burger” or a restaurant"
                className="flex-1 min-w-0 bg-transparent py-2.5 text-base outline-none placeholder:text-slate-400"
              />
              <button type="submit" className="rounded-full px-5 sm:px-7 py-3 text-sm sm:text-base font-semibold text-white shrink-0" style={{ background: GRADIENT }}>
                Find food
              </button>
            </motion.form>

            <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={4} className="mt-4 flex flex-wrap gap-3">
              <a href={ORDER_URL} className="group inline-flex items-center gap-2 text-sm font-semibold text-[#0B6E63] hover:underline underline-offset-4">
                <ShoppingBag className="w-4 h-4" /> Order Now <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </a>
              <span className="text-slate-300">|</span>
              <a href="#download" className="inline-flex items-center gap-2 text-sm font-semibold text-[#0B6E63] hover:underline underline-offset-4">
                <Smartphone className="w-4 h-4" /> Download App
              </a>
            </motion.div>

            {/* Live stats */}
            <motion.div initial="hidden" animate="visible" variants={fadeUp} custom={5} className="mt-8 grid grid-cols-3 gap-3 max-w-md">
              {[
                [restaurants.length, "Restaurants nearby"],
                [openCount, "Open right now"],
                [cuisineCount, "Cuisines"],
              ].map(([n, l]) => (
                <div key={l} className="rounded-2xl bg-white/80 border border-[#12A594]/10 px-3 py-3">
                  <div className="text-2xl sm:text-3xl font-extrabold" style={{ color: C.deep }}>
                    {loading ? <span className="inline-block w-8 h-7 rounded bg-slate-100 animate-pulse align-middle" /> : n}
                  </div>
                  <div className="text-[11px] sm:text-xs text-slate-500 leading-tight mt-0.5">{l}</div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Hero visual */}
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
            className="relative mx-auto w-full max-w-[420px] hidden sm:block"
          >
            <div className="absolute inset-6 rounded-full" style={{ background: GRADIENT, opacity: 0.9 }} />
            <div className="relative rounded-full overflow-hidden border-[10px] border-white shadow-2xl shadow-[#0B6E63]/25 aspect-square">
              <Img
                src={heroDish?.image || FALLBACK_FOOD}
                alt={heroDish?.name || "Food"}
                className="w-full h-full object-cover"
              />
            </div>
            {heroDish && (
              <motion.a href={`/food/user/restaurants/${restaurantSlug(heroDish.r)}?dish=${heroDish.id}`}
                animate={{ y: [0, -8, 0] }} transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                className="absolute -left-4 bottom-12 bg-white rounded-2xl shadow-xl p-3 pr-5 flex items-center gap-3 max-w-[240px]"
              >
                <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: GRADIENT }}>
                  <UtensilsCrossed className="w-5 h-5" />
                </span>
                <span className="leading-tight min-w-0">
                  <span className="block text-sm font-bold truncate">{heroDish.name}</span>
                  <span className="block text-xs text-slate-500 truncate">₹{heroDish.price} · {heroDish.r.restaurantName}</span>
                </span>
              </motion.a>
            )}
            <motion.div animate={{ y: [0, 8, 0] }} transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -right-2 top-10 bg-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-2"
            >
              <Bike className="w-5 h-5 text-[#12A594]" />
              <span className="leading-tight">
                <span className="block text-sm font-bold">Live tracking</span>
                <span className="block text-[11px] text-slate-500">Kitchen to door</span>
              </span>
            </motion.div>
          </motion.div>
        </div>
      </section>

      <main className="max-w-7xl mx-auto px-4 sm:px-6">
        {loadError && (
          <div className="mb-8 rounded-2xl bg-red-50 border border-red-100 px-5 py-4 text-sm text-red-700">{loadError}</div>
        )}

        {/* ───────────── OFFERS ───────────── */}
        {(loading || offers.length > 0) && (
          <section id="offers" className="scroll-mt-20 py-8">
            <SectionHead tag="Today's deals" title={`Offers in ${cityLabel}`} right={<ScrollButtons targetRef={offersRef} />} />
            <div ref={offersRef} className="flex gap-4 overflow-x-auto snap-x pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
              {loading
                ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="shrink-0 w-[280px] h-[150px]" />)
                : offers.map((o, i) => (
                    <div key={o.key} className="snap-start shrink-0 w-[280px] sm:w-[320px] rounded-3xl p-5 text-white relative overflow-hidden flex flex-col"
                      style={{ background: i % 2 ? `linear-gradient(135deg, ${C.ink}, ${C.deep})` : GRADIENT }}
                    >
                      <BadgePercent className="absolute -right-4 -top-4 w-28 h-28 opacity-15" />
                      <span className="text-xs font-semibold uppercase tracking-wider opacity-80 truncate">{o.r.restaurantName}</span>
                      <span className="mt-1 text-xl font-extrabold leading-tight">{o.text}</span>
                      <div className="mt-auto pt-4 flex items-center gap-2">
                        {o.code ? (
                          <button onClick={() => copyCode(o.code)} className="inline-flex items-center gap-2 rounded-full bg-white/15 border border-dashed border-white/60 px-3 py-1.5 text-sm font-bold hover:bg-white/25">
                            {copied === o.code ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            {copied === o.code ? "Copied" : o.code}
                          </button>
                        ) : null}
                        <a href={`/food/user/restaurants/${restaurantSlug(o.r)}`} className="ml-auto inline-flex items-center gap-1 text-sm font-semibold hover:underline">
                          Order <ArrowRight className="w-4 h-4" />
                        </a>
                      </div>
                    </div>
                  ))}
            </div>
          </section>
        )}

        {/* ───────────── CATEGORIES ───────────── */}
        {(loading || categories.length > 0) && (
          <section className="py-8">
            <SectionHead tag="Recommended for you" title="What's on your mind?" right={<ScrollButtons targetRef={catsRef} />} />
            <div ref={catsRef} className="flex gap-4 sm:gap-6 overflow-x-auto snap-x pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="shrink-0 w-24 h-28 !rounded-full" />)
                : categories.map((c) => {
                    const slug = c.slug || String(c.name || "").toLowerCase().replace(/\s+/g, "-");
                    return (
                      <a key={c.id || c._id || slug} href={`/food/user/category/${slug}`} className="snap-start shrink-0 w-24 sm:w-28 flex flex-col items-center gap-2 group">
                        <span className="w-24 h-24 sm:w-28 sm:h-28 rounded-full overflow-hidden bg-[#E7F7F3] ring-2 ring-transparent group-hover:ring-[#12A594] transition">
                          <Img src={imgUrl(c.image)} alt={c.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                        </span>
                        <span className="text-sm font-semibold text-center text-slate-700 group-hover:text-[#0B6E63] line-clamp-1">{c.name}</span>
                      </a>
                    );
                  })}
            </div>
          </section>
        )}

        {/* ───────────── POPULAR DISHES ───────────── */}
        {(loading || dishes.length > 0) && (
          <section className="py-8">
            <SectionHead tag="Popular near you" title="Dishes people love" right={<ScrollButtons targetRef={dishesRef} />} />
            <div ref={dishesRef} className="flex gap-4 overflow-x-auto snap-x pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
              {loading
                ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="shrink-0 w-[220px] h-[260px]" />)
                : dishes.map((d) => (
                    <a key={`${d.r.id}-${d.id}`} href={`/food/user/restaurants/${restaurantSlug(d.r)}?dish=${d.id}`}
                      className="snap-start shrink-0 w-[200px] sm:w-[230px] rounded-3xl bg-white border border-slate-100 overflow-hidden hover:shadow-xl hover:shadow-[#12A594]/10 hover:-translate-y-1 transition-all group"
                    >
                      <div className="aspect-[4/3] overflow-hidden bg-[#E7F7F3]">
                        <Img src={d.image} alt={d.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      </div>
                      <div className="p-4">
                        <h3 className="font-bold leading-snug line-clamp-1">{d.name}</h3>
                        <p className="text-xs text-slate-500 truncate mt-0.5">{d.r.restaurantName}</p>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-lg font-extrabold">₹{d.price}</span>
                          <span className="rounded-xl border-2 border-[#12A594] px-4 py-1 text-xs font-extrabold text-[#0B6E63] group-hover:bg-[#12A594] group-hover:text-white transition">
                            ADD
                          </span>
                        </div>
                      </div>
                    </a>
                  ))}
            </div>
          </section>
        )}

        {/* ───────────── RESTAURANTS ───────────── */}
        <section id="restaurants" className="scroll-mt-20 py-8 md:py-12">
          <SectionHead
            tag="Near you"
            title={loading ? "Restaurants delivering to you" : `${filtered.length} restaurants delivering in ${cityLabel}`}
          />
          <div className="flex gap-2 overflow-x-auto pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => { setFilter(f.key); setVisible(PAGE_SIZE); }}
                className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold border transition ${
                  filter === f.key ? "text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:border-[#12A594]"
                }`}
                style={filter === f.key ? { background: GRADIENT } : undefined}
              >
                {f.icon && <f.icon className="w-4 h-4" />}
                {f.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[290px] !rounded-3xl" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-3xl bg-[#F4FBF9] border border-[#12A594]/10 p-10 text-center">
              <UtensilsCrossed className="w-10 h-10 mx-auto text-[#12A594]" />
              <h3 className="mt-3 text-lg font-bold">
                {restaurants.length ? "No restaurants match this filter" : `We're not delivering here yet`}
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {restaurants.length ? "Try another filter." : "Pick another city from the location menu at the top."}
              </p>
              {restaurants.length > 0 && (
                <button onClick={() => setFilter("all")} className="mt-4 text-sm font-semibold text-[#0B6E63] hover:underline">Show all restaurants</button>
              )}
            </div>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
                {filtered.slice(0, visible).map((r, i) => (
                  <motion.div key={r.id || r._id} initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-40px" }} variants={fadeUp} custom={i % 4}>
                    <RestaurantCard r={r} />
                  </motion.div>
                ))}
              </div>
              {visible < filtered.length && (
                <div className="mt-8 text-center">
                  <button onClick={() => setVisible((v) => v + PAGE_SIZE)} className="rounded-full border-2 border-[#12A594]/30 px-7 py-3 font-semibold text-[#0B6E63] hover:border-[#12A594] hover:bg-[#F3FBF9] transition">
                    Load more restaurants
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {/* ───────────── HOW IT WORKS ───────────── */}
      <section className="py-16 md:py-20 bg-[#F4FBF9]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center">
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.teal }}>Simple as 1-2-3</span>
            <h2 className="mt-1 text-3xl sm:text-4xl font-extrabold tracking-tight">How MintoFood works</h2>
          </div>
          <div className="mt-10 grid sm:grid-cols-3 gap-5">
            {[
              { icon: Search, title: "Find", desc: "Browse restaurants near you, with menus and prices up front." },
              { icon: ShoppingBag, title: "Order", desc: "Add what you're craving and pay online in a couple of taps." },
              { icon: Navigation, title: "Track", desc: "Watch your rider on the map until the food is at your door." },
            ].map((s, i) => (
              <div key={s.title} className="relative rounded-3xl bg-white border border-slate-100 p-7">
                <span className="absolute top-5 right-6 text-5xl font-extrabold text-[#E7F7F3]">{i + 1}</span>
                <span className="relative w-12 h-12 rounded-2xl flex items-center justify-center text-white" style={{ background: GRADIENT }}>
                  <s.icon className="w-6 h-6" />
                </span>
                <h3 className="relative mt-5 text-xl font-bold">{s.title}</h3>
                <p className="relative mt-2 text-slate-600 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 grid sm:grid-cols-3 gap-4">
            {[
              { icon: Clock, t: "Quick, tracked delivery" },
              { icon: BadgePercent, t: "Fair billing for restaurants" },
              { icon: ShieldCheck, t: "Safe & secure payments" },
            ].map((f) => (
              <div key={f.t} className="flex items-center justify-center gap-2 text-sm font-semibold text-slate-700">
                <f.icon className="w-5 h-5 text-[#12A594]" /> {f.t}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────── DOWNLOAD APP ───────────── */}
      <section id="download" className="scroll-mt-20 py-16 md:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="relative overflow-hidden rounded-[2.5rem] px-6 py-12 sm:px-12 md:py-14 text-white" style={{ background: GRADIENT }}>
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20" viewBox="0 0 800 400" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0,300 C200,220 300,380 520,300 C680,240 720,320 800,280 L800,400 L0,400 Z" fill="#fff" />
              <path d="M520,0 C600,120 700,60 800,140 L800,0 Z" fill="#fff" />
            </svg>
            <div className="relative grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-10 items-center">
              <div>
                <SpeedLines light className="mb-5" />
                <h2 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight">Hungry? MintoFood is a tap away.</h2>
                <p className="mt-4 text-white/85 text-lg max-w-md">Save your addresses, reorder favourites and get live updates on every order.</p>
                <div className="mt-8 flex flex-col sm:flex-row gap-3">
                  <StoreButton href={STORE_LINKS.customer.android} icon={Play} top="Get it on" label="Google Play" />
                  <StoreButton href={STORE_LINKS.customer.ios} icon={Apple} top="Download on the" label="App Store" />
                </div>
                <a href={ORDER_URL} className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-white/90 hover:text-white hover:underline underline-offset-4">
                  Or order on the web right now <ArrowRight className="w-4 h-4" />
                </a>
              </div>
              <div className="hidden md:flex justify-center">
                <div className="w-56 rounded-[2.5rem] bg-[#0E2724] p-2 shadow-2xl rotate-3">
                  <div className="rounded-[2rem] bg-white overflow-hidden text-[#0E2724]">
                    <div className="px-4 pt-5 pb-3 flex items-center gap-2">
                      <img src="/minto-logo.png" alt="" className="w-7 h-7 rounded-lg" />
                      <span className="text-sm font-extrabold"><span style={{ color: C.deep }}>Minto</span><span style={{ color: C.bright }}>Food</span></span>
                    </div>
                    <Img src={restaurantImage(restaurants.find((r) => restaurantImage(r)) || {})} alt="" className="h-36 w-full object-cover" />
                    <div className="p-4">
                      <p className="text-sm font-bold truncate">{restaurants[0]?.restaurantName || "Your favourite place"}</p>
                      <p className="text-xs text-slate-500 truncate">{(restaurants[0]?.cuisines || []).slice(0, 2).join(" • ") || "Near you"}</p>
                      <div className="mt-3 rounded-xl py-2.5 text-center text-xs font-bold text-white" style={{ background: GRADIENT }}>Track order</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────── PARTNERS ───────────── */}
      <section id="partner" className="scroll-mt-20 py-16 md:py-20 bg-[#F4FBF9]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.teal }}>Grow with us</span>
            <h2 className="mt-1 text-3xl sm:text-4xl font-extrabold tracking-tight">Partner with MintoFood</h2>
            <p className="mt-3 text-slate-600 text-lg">Bring your restaurant online or earn on your own schedule as a delivery partner.</p>
          </div>

          <div className="mt-10 grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3 rounded-[2rem] bg-white p-6 sm:p-8 border border-[#12A594]/10">
              <div className="flex items-center gap-3">
                <span className="w-12 h-12 rounded-2xl flex items-center justify-center text-white" style={{ background: GRADIENT }}>
                  <Store className="w-6 h-6" />
                </span>
                <div>
                  <h3 className="text-xl sm:text-2xl font-bold">List your restaurant</h3>
                  <p className="text-sm text-slate-500">Per-order commission or a fixed monthly plan, your choice.</p>
                </div>
              </div>

              {leadSuccess ? (
                <div className="mt-8 rounded-2xl bg-[#E7F7F3] p-8 text-center">
                  <span className="mx-auto w-14 h-14 rounded-full flex items-center justify-center text-white" style={{ background: GRADIENT }}>
                    <Check className="w-7 h-7" />
                  </span>
                  <h4 className="mt-4 text-lg font-bold">Thanks, we got your details!</h4>
                  <p className="mt-1 text-sm text-slate-600">Our onboarding team will call you shortly to set up your restaurant.</p>
                  <button onClick={() => setLeadSuccess(false)} className="mt-5 text-sm font-semibold text-[#0B6E63] hover:underline">Submit another restaurant</button>
                </div>
              ) : (
                <form onSubmit={handleLeadSubmit} className="mt-7 grid sm:grid-cols-2 gap-3.5">
                  <input className={inputCls} placeholder="Owner name" value={leadForm.ownerName} onChange={setField("ownerName")} autoComplete="name" />
                  <input className={inputCls} placeholder="Restaurant name" value={leadForm.restaurantName} onChange={setField("restaurantName")} />
                  <input className={inputCls} placeholder="Mobile number" inputMode="tel" value={leadForm.mobileNumber} onChange={setField("mobileNumber")} autoComplete="tel" />
                  <input className={inputCls} placeholder="Email" type="email" value={leadForm.emailId} onChange={setField("emailId")} autoComplete="email" />
                  <input className={`${inputCls} sm:col-span-2`} placeholder="City / area" value={leadForm.location} onChange={setField("location")} />
                  {leadError && <p className="sm:col-span-2 text-sm text-red-600">{leadError}</p>}
                  <button type="submit" disabled={submittingLead}
                    className="sm:col-span-2 mt-1 inline-flex items-center justify-center gap-2 rounded-full py-3.5 font-semibold text-white shadow-md shadow-[#12A594]/25 disabled:opacity-70"
                    style={{ background: GRADIENT }}
                  >
                    {submittingLead ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    {submittingLead ? "Submitting…" : "Register my restaurant"}
                  </button>
                </form>
              )}
            </div>

            <div className="lg:col-span-2 rounded-[2rem] p-6 sm:p-8 text-white flex flex-col bg-[#0E2724] relative overflow-hidden">
              <div className="absolute -right-16 -top-16 w-56 h-56 rounded-full opacity-30" style={{ background: GRADIENT }} />
              <span className="relative w-12 h-12 rounded-2xl flex items-center justify-center text-white" style={{ background: GRADIENT }}>
                <Bike className="w-6 h-6" />
              </span>
              <h3 className="relative mt-5 text-xl sm:text-2xl font-bold">Become a delivery partner</h3>
              <p className="relative mt-2 text-white/70 leading-relaxed">Ride with MintoFood in your city. Flexible hours, weekly payouts and incentives on top.</p>
              <ul className="relative mt-6 space-y-3 text-sm">
                {["Choose your own hours", "Weekly payouts to your bank", "Bonuses and incentives"].map((t) => (
                  <li key={t} className="flex items-center gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#19C9B4]/20 flex items-center justify-center"><Check className="w-3.5 h-3.5 text-[#19C9B4]" /></span>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="relative mt-auto pt-8">
                <StoreButton href={STORE_LINKS.delivery.android} icon={Play} top="Get the rider app on" label="Google Play" dark={false} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────── FOOTER ───────────── */}
      <footer className="bg-[#0E2724] text-white/70">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Wordmark light />
            <p className="mt-4 text-sm leading-relaxed max-w-xs">Food delivery from your favourite local restaurants, tracked live to your door.</p>
            {SOCIAL_LINKS.length > 0 && (
              <div className="mt-5 flex gap-3">
                {SOCIAL_LINKS.map(({ network, url }) => {
                  const Icon = { facebook: Facebook, youtube: Youtube, instagram: Instagram, linkedin: Linkedin }[network];
                  return Icon ? (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-white/10 hover:bg-[#12A594] flex items-center justify-center transition-colors">
                      <Icon className="w-4 h-4 text-white" />
                    </a>
                  ) : null;
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <h4 className="text-white font-semibold mb-1">We deliver in</h4>
            {zones.map((z) => (
              <button key={z.id} onClick={() => { chooseCity(z); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="text-left hover:text-white">
                {z.name}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <h4 className="text-white font-semibold mb-1">Company</h4>
            <a href="https://admin.mintofood.com/food/user/profile/about" target="_blank" rel="noopener noreferrer" className="hover:text-white">About us</a>
            <a href="#partner" className="hover:text-white">Partner with us</a>
            <a href="https://admin.mintofood.com/food/user/profile/help-content" target="_blank" rel="noopener noreferrer" className="hover:text-white">Support</a>
            <a href="https://admin.mintofood.com/food/user/profile/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-white">Privacy policy</a>
            <a href="https://admin.mintofood.com/food/user/profile/terms" target="_blank" rel="noopener noreferrer" className="hover:text-white">Terms of service</a>
          </div>

          <div className="flex flex-col gap-3 text-sm">
            <h4 className="text-white font-semibold mb-1">Contact</h4>
            <a href={`mailto:${supportContact.email}`} className="hover:text-white inline-flex items-center gap-2 break-all">
              <Mail className="w-4 h-4 shrink-0" /> {supportContact.email}
            </a>
            {supportContact.mobile && (
              <a href={`tel:${supportContact.mobile}`} className="hover:text-white inline-flex items-center gap-2">
                <Phone className="w-4 h-4 shrink-0" /> {supportContact.mobile}
              </a>
            )}
            <span className="inline-flex items-center gap-2"><HeartHandshake className="w-4 h-4 shrink-0" /> Made in India</span>
          </div>
        </div>
        <div className="border-t border-white/10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 text-xs text-white/50">© {new Date().getFullYear()} MintoFood. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
}
