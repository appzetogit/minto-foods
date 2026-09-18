import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Shield, Trash2, ToggleLeft, ToggleRight, MapPin } from "lucide-react";
import { adminAPI } from "@food/api";

const SUBADMIN_EMAIL_REGEX = /^(?!.*\.\.)([A-Za-z0-9]+[._%+-]?)*[A-Za-z0-9]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}$/;
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const NAME_REGEX = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

const hasSuspiciousEmailTld = (emailValue) => {
  const email = String(emailValue || "").trim().toLowerCase();
  const domain = email.split("@")[1] || "";
  const tld = domain.split(".").pop() || "";
  if (!tld) return true;
  if (/^com+$/i.test(tld) && tld !== "com") return true;
  if (/(.)\1{2,}/.test(tld)) return true;
  return false;
};

/**
 * Cities as toggle chips. A sub-admin sees only the zones, restaurants, orders
 * and riders of the cities picked here -- and nothing if none are picked.
 */
function CityChips({ cities, selected, onChange }) {
  if (!cities.length) {
    return <p className="text-xs text-slate-500">No cities yet. Cities are added from the zone form.</p>;
  }
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="flex flex-wrap gap-2">
      {cities.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            type="button"
            key={c.id}
            onClick={() => toggle(c.id)}
            className={`rounded-full border px-3 py-1 text-sm ${on ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
          >
            {c.name}
            <span className={`ml-1 text-xs ${on ? "text-blue-100" : "text-slate-400"}`}>
              {c.zoneCount} zone{c.zoneCount === 1 ? "" : "s"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function EmployeeList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [cities, setCities] = useState([]);
  const [newCityIds, setNewCityIds] = useState([]);
  // The row whose cities are being edited, and the draft selection.
  const [editing, setEditing] = useState(null);
  const [draftCityIds, setDraftCityIds] = useState([]);

  const validateForm = (payload) => {
    const nextErrors = {};
    const name = String(payload?.name || "").trim();
    const email = String(payload?.email || "").trim().toLowerCase();
    const phone = String(payload?.phone || "").trim();
    const password = String(payload?.password || "");

    if (!name) {
      nextErrors.name = "Name is required.";
    } else if (name.length < 2) {
      nextErrors.name = "Name must be at least 2 characters.";
    } else if (!NAME_REGEX.test(name)) {
      nextErrors.name = "Name can contain only letters and spaces.";
    }

    if (!email) {
      nextErrors.email = "Email is required.";
    } else if (!SUBADMIN_EMAIL_REGEX.test(email) || hasSuspiciousEmailTld(email)) {
      nextErrors.email = "Enter a valid email address.";
    }

    if (!phone) {
      nextErrors.phone = "Phone is required.";
    } else if (!INDIAN_MOBILE_REGEX.test(phone)) {
      nextErrors.phone = "Enter a valid 10-digit Indian mobile number.";
    }

    if (!password) {
      nextErrors.password = "Password is required.";
    } else if (password.length < 8) {
      nextErrors.password = "Password must be at least 8 characters.";
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^\w\s]/.test(password)) {
      nextErrors.password = "Use uppercase, lowercase, number, and special character.";
    }

    return nextErrors;
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getSubAdmins({ search });
      setItems(Array.isArray(res?.data?.data?.items) ? res.data.data.items : []);
    } catch (_e) {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    adminAPI
      .getCities({ limit: 500 })
      .then((res) => setCities(res?.data?.data?.cities || []))
      .catch(() => setCities([]));
  }, []);

  const cityName = (id) => cities.find((c) => c.id === id)?.name;

  const saveCities = async (item) => {
    try {
      await adminAPI.updateSubAdmin(item._id, { cityIds: draftCityIds });
      setEditing(null);
      await load();
    } catch (e) {
      alert(e?.response?.data?.message || "Could not save the cities");
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((it) => [it.name, it.email, it.phone].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [items, search]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const normalizedForm = {
      name: String(form.name || "").trim(),
      email: String(form.email || "").trim().toLowerCase(),
      phone: String(form.phone || "").trim(),
      password: String(form.password || ""),
    };
    const validationErrors = validateForm(normalizedForm);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setSaving(true);
    try {
      await adminAPI.createSubAdmin({ ...normalizedForm, cityIds: newCityIds });
      setForm({ name: "", email: "", phone: "", password: "" });
      setNewCityIds([]);
      setErrors({});
      await load();
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (item) => {
    await adminAPI.updateSubAdminStatus(item._id, !item.isActive);
    await load();
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.name || item.email}?`)) return;
    await adminAPI.deleteSubAdmin(item._id);
    await load();
  };

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h1 className="text-2xl font-bold text-slate-900">Sub Admin Management</h1>
        <p className="text-sm text-slate-600 mt-1">Create, disable, and delete sub admins. Permissions are managed per admin.</p>
      </div>

      <form onSubmit={handleCreate} className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <input
            className={`border rounded-lg px-3 py-2 w-full ${errors.name ? "border-red-400" : ""}`}
            placeholder="Name"
            value={form.name}
            onChange={(e) => {
              const cleaned = e.target.value.replace(/[^A-Za-z\s]/g, "").replace(/\s{2,}/g, " ");
              setForm((p) => ({ ...p, name: cleaned }));
              if (errors.name) setErrors((prev) => ({ ...prev, name: "" }));
            }}
          />
          {errors.name ? <p className="mt-1 text-xs text-red-600">{errors.name}</p> : null}
        </div>
        <div>
          <input
            className={`border rounded-lg px-3 py-2 w-full ${errors.email ? "border-red-400" : ""}`}
            placeholder="Email"
            value={form.email}
            onChange={(e) => {
              setForm((p) => ({ ...p, email: e.target.value }));
              if (errors.email) setErrors((prev) => ({ ...prev, email: "" }));
            }}
          />
          {errors.email ? <p className="mt-1 text-xs text-red-600">{errors.email}</p> : null}
        </div>
        <div>
          <input
            className={`border rounded-lg px-3 py-2 w-full ${errors.phone ? "border-red-400" : ""}`}
            placeholder="Phone"
            value={form.phone}
            onChange={(e) => {
              const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 10);
              setForm((p) => ({ ...p, phone: onlyDigits }));
              if (errors.phone) setErrors((prev) => ({ ...prev, phone: "" }));
            }}
          />
          {errors.phone ? <p className="mt-1 text-xs text-red-600">{errors.phone}</p> : null}
        </div>
        <div>
          <input
            className={`border rounded-lg px-3 py-2 w-full ${errors.password ? "border-red-400" : ""}`}
            placeholder="Password"
            type="password"
            value={form.password}
            onChange={(e) => {
              setForm((p) => ({ ...p, password: e.target.value }));
              if (errors.password) setErrors((prev) => ({ ...prev, password: "" }));
            }}
          />
          {errors.password ? <p className="mt-1 text-xs text-red-600">{errors.password}</p> : null}
        </div>
        <div className="md:col-span-2">
          <p className="mb-2 text-sm font-medium text-slate-700">Cities</p>
          <CityChips cities={cities} selected={newCityIds} onChange={setNewCityIds} />
          <p className="mt-1 text-xs text-slate-500">
            They will only see the zones, restaurants, orders and riders of these cities. No city means they see nothing.
          </p>
        </div>
        <div className="md:col-span-2">
          <button disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg">
            <Plus className="w-4 h-4" /> Create Sub Admin
          </button>
        </div>
      </form>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="border rounded-lg pl-9 pr-3 py-2 w-full" placeholder="Search sub admins" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="px-3 py-2 border rounded-lg text-sm" onClick={load}>Refresh</button>
        </div>

        {loading ? <div className="text-sm text-slate-500">Loading...</div> : (
          <div className="space-y-3">
            {filtered.map((item) => (
              <div key={item._id} className="border border-slate-200 rounded-lg p-3 flex flex-col md:flex-row md:items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{item.name || "Unnamed"}</p>
                  <p className="text-sm text-slate-600">{item.email} {item.phone ? `• ${item.phone}` : ""}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                    <MapPin className="w-3 h-3" />
                    {item.cities?.length
                      ? item.cities.map((c) => c.name || cityName(c.id)).join(", ")
                      : <span className="text-amber-600">No cities: sees nothing</span>}
                  </p>
                  {editing === item._id && (
                    <div className="mt-3 space-y-2">
                      <CityChips cities={cities} selected={draftCityIds} onChange={setDraftCityIds} />
                      <div className="flex gap-2">
                        <button onClick={() => saveCities(item)} className="px-3 py-1.5 bg-black text-white rounded-lg text-sm">Save cities</button>
                        <button onClick={() => setEditing(null)} className="px-3 py-1.5 border rounded-lg text-sm">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => { setEditing(item._id); setDraftCityIds(item.cityIds || []); }}
                    className="inline-flex items-center gap-1 px-3 py-2 border rounded-lg text-sm"
                  >
                    <MapPin className="w-4 h-4" /> Cities
                  </button>
                  <Link to={`/admin/food/employee-role?id=${item._id}`} className="inline-flex items-center gap-1 px-3 py-2 border rounded-lg text-sm">
                    <Shield className="w-4 h-4" /> Permissions
                  </Link>
                  <button onClick={() => toggleStatus(item)} className="px-3 py-2 border rounded-lg text-sm inline-flex items-center gap-1">
                    {item.isActive ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-slate-500" />}
                    {item.isActive ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => remove(item)} className="px-3 py-2 border border-red-200 text-red-600 rounded-lg text-sm inline-flex items-center gap-1">
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              </div>
            ))}
            {!filtered.length && <div className="text-sm text-slate-500">No sub admins found.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
