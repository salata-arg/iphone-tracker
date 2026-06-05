import { useState, useEffect, useRef, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const APIFY_ACTOR = "crawlerbros/facebook-marketplace-scraper";
const ARS_TO_USD  = 1 / 1500; // $1500 ARS por dólar — actualizá si cambia

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const MODELS = [
  "iPhone 11", "iPhone 12", "iPhone 12 Pro",
  "iPhone 13", "iPhone 13 Pro", "iPhone SE",
  "iPhone 14", "iPhone 14 Pro",
];
const SOURCES = ["MercadoLibre", "Facebook Marketplace"];

const MARKET_PRICES = {
  "iPhone 11":     { "64GB": 185, "128GB": 205, "256GB": 225 },
  "iPhone 12":     { "64GB": 280, "128GB": 310, "256GB": 340 },
  "iPhone 12 Pro": { "128GB": 360, "256GB": 400, "512GB": 440 },
  "iPhone 13":     { "128GB": 420, "256GB": 460, "512GB": 500 },
  "iPhone 13 Pro": { "128GB": 510, "256GB": 560, "512GB": 610 },
  "iPhone SE":     { "64GB": 180, "128GB": 200, "256GB": 220 },
  "iPhone 14":     { "128GB": 560, "256GB": 610, "512GB": 660 },
  "iPhone 14 Pro": { "128GB": 700, "256GB": 760, "512GB": 820 },
};

// ─── PARSERS ──────────────────────────────────────────────────────────────────
function detectModel(title) {
  for (const m of MODELS) {
    if (title.toLowerCase().includes(m.toLowerCase())) return m;
  }
  return "iPhone";
}

function detectStorage(title) {
  const m = title.match(/(\d{2,3})\s*gb/i);
  return m ? m[1] + "GB" : "128GB";
}

function timeAgo(dateStr) {
  if (!dateStr) return "reciente";
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diff < 1)    return "ahora mismo";
  if (diff < 60)   return `hace ${diff} min`;
  if (diff < 1440) return `hace ${Math.floor(diff / 60)} h`;
  return `hace ${Math.floor(diff / 1440)} d`;
}

function parseMLListing(item) {
  const title    = item.title || "";
  const priceARS = item.price || 0;
  const priceUSD = Math.round(priceARS * ARS_TO_USD);
  return {
    id:        "ml_" + item.id,
    model:     detectModel(title),
    storage:   detectStorage(title),
    color:     "—",
    price:     priceUSD,
    priceARS,
    condition: item.condition === "new" ? "Excelente" : "Muy bueno",
    battery:   85,
    source:    "MercadoLibre",
    seller:    item.seller?.nickname || "Vendedor ML",
    time:      timeAgo(item.stop_time || item.last_updated),
    icloud:    true,
    imei_ok:   true,
    location:  item.seller_address?.city?.name || item.seller_address?.state?.name || "Argentina",
    url:       item.permalink,
    thumbnail: item.thumbnail,
    realData:  true,
  };
}

function parseFBListing(item) {
  const title  = item.title || item.name || "";
  const raw    = parseFloat(String(item.price || item.listing_price?.amount || "0").replace(/[^0-9.]/g, "")) || 0;
  const priceUSD = raw > 5000 ? Math.round(raw * ARS_TO_USD) : Math.round(raw);
  return {
    id:       "fb_" + (item.id || item.listing_id || Math.random()),
    model:    detectModel(title),
    storage:  detectStorage(title),
    color:    "—",
    price:    priceUSD,
    condition: "Muy bueno",
    battery:  85,
    source:   "Facebook Marketplace",
    seller:   item.marketplace_listing_seller?.name || item.seller_name || "Vendedor FB",
    time:     "reciente",
    icloud:   true,
    imei_ok:  true,
    location: item.location?.city || item.marketplace_listing_seller?.location?.city || "Argentina",
    url:      item.url || item.listing_url || `https://www.facebook.com/marketplace/item/${item.id}`,
    thumbnail: item.primary_listing_photo?.image?.uri || item.image || "",
    realData: true,
    fbRaw:    true,
  };
}

// ─── FETCH FUNCTIONS ──────────────────────────────────────────────────────────
async function fetchMercadoLibre(query = "iphone usado", limit = 20) {
  // Llama al proxy local /api/meli en vez de ML directo
  const res = await fetch(`/api/meli?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error("ML proxy error " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return (data.results || []).map(parseMLListing);
}

async function fetchFacebook(query = "iphone", token) {
  if (!token) throw new Error("Token Apify no configurado");

  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/runs?token=${token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchQuery: query,
        location: "Buenos Aires, Argentina",
        maxItems: 15,
        proxy: { useApifyProxy: true },
      }),
    }
  );
  if (!runRes.ok) {
    const err = await runRes.json().catch(() => ({}));
    throw new Error(err.error?.message || "Apify error " + runRes.status);
  }
  const runData = await runRes.json();
  const runId   = runData.data?.id;
  if (!runId) throw new Error("No se obtuvo run ID");

  // Polling hasta que termine (max 90 seg)
  let status = "RUNNING";
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    const d = await s.json();
    status = d.data?.status;
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED") throw new Error("Apify falló: " + status);
  }
  if (status !== "SUCCEEDED") throw new Error("Apify timeout — intentá de nuevo");

  const datasetId = runData.data?.defaultDatasetId;
  const items = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=20`).then(r => r.json());
  return (Array.isArray(items) ? items : []).map(parseFBListing).filter(l => l.price > 0);
}

// ─── CALCULADORA ──────────────────────────────────────────────────────────────
function calcMaxPrice(listing, settings) {
  const marketPrice      = MARKET_PRICES[listing.model]?.[listing.storage] ?? 300;
  const commission       = marketPrice * (settings.commissionPct / 100);
  const shipping         = settings.shippingCost;
  const targetProfit     = marketPrice * (settings.marginPct / 100);
  const batteryRepair    = listing.battery < 80 ? 30 : 0;
  const conditionDiscount = listing.condition === "Con detalles" ? 20 : listing.condition === "Bueno" ? 8 : 0;
  const maxPrice         = Math.floor(marketPrice - commission - shipping - targetProfit - batteryRepair - conditionDiscount);
  const actualProfit     = Math.floor(marketPrice - listing.price - commission - shipping - batteryRepair - conditionDiscount);
  const roi              = listing.price > 0 ? Math.round((actualProfit / listing.price) * 100) : 0;
  const isGoodDeal       = listing.price <= maxPrice && listing.icloud && listing.imei_ok;
  return { marketPrice, maxPrice, actualProfit, batteryRepair, commission, shipping, targetProfit, roi, isGoodDeal, conditionDiscount };
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
const mono = { fontFamily: "'DM Mono', monospace" };

function Tag({ color, children }) {
  return (
    <span style={{ background: color + "18", color, border: `1px solid ${color}33`, borderRadius: 4, padding: "2px 7px", fontSize: 10, ...mono }}>
      {children}
    </span>
  );
}

function Spinner({ color = "#00ff87", size = 28 }) {
  return (
    <div style={{ width: size, height: size, border: "2px solid #1e3a5f", borderTop: `2px solid ${color}`, borderRadius: "50%", animation: "spin .8s linear infinite" }} />
  );
}

function SourceStatus({ label, color, status, count, error }) {
  const dot = status === "ok" ? "#00ff87" : status === "loading" ? "#ffd60a" : status === "error" ? "#ff4d4d" : "#333";
  return (
    <div style={{ background: "#0a1520", border: `1px solid ${dot}33`, borderRadius: 7, padding: "8px 14px", display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: dot, boxShadow: `0 0 6px ${dot}`, animation: status === "loading" ? "pulse 1s infinite" : "pulse 3s infinite" }} />
      <div>
        <div style={{ color, fontSize: 11, fontWeight: 600, ...mono }}>{label}</div>
        <div style={{ fontSize: 10, color: "#4a7fa5", ...mono }}>
          {status === "loading" && "Buscando..."}
          {status === "ok"      && `${count} publicaciones`}
          {status === "error"   && <span style={{ color: "#ff4d4d" }}>{error}</span>}
          {status === "idle"    && "En espera"}
        </div>
      </div>
    </div>
  );
}

// ─── CALC MODAL ───────────────────────────────────────────────────────────────
function CalcModal({ listing, settings, onClose }) {
  const c = calcMaxPrice(listing, settings);
  const rows = [
    { label: "Precio de mercado estimado",           value: `$${c.marketPrice}`,              color: "#e8f4fd" },
    { label: `Comisión (${settings.commissionPct}%)`, value: `- $${Math.round(c.commission)}`, color: "#ff8c69" },
    { label: "Envío",                                 value: `- $${c.shipping}`,               color: "#ff8c69" },
    { label: `Margen objetivo (${settings.marginPct}%)`, value: `- $${Math.round(c.targetProfit)}`, color: "#ff8c69" },
    ...(c.batteryRepair    > 0 ? [{ label: `Batería baja (${listing.battery}%)`, value: `- $${c.batteryRepair}`,    color: "#ffd60a" }] : []),
    ...(c.conditionDiscount > 0 ? [{ label: `Estado: ${listing.condition}`,       value: `- $${c.conditionDiscount}`, color: "#ffd60a" }] : []),
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000bb", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div style={{ background: "linear-gradient(135deg,#0a1520,#0f1f30)", border: "1px solid #1e4a7a", borderRadius: 12, padding: 28, maxWidth: 480, width: "100%", maxHeight: "90vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <div style={{ color: "#ffd60a", fontSize: 10, letterSpacing: 2, marginBottom: 4, ...mono }}>CALCULADORA</div>
            <div style={{ color: "#e8f4fd", fontWeight: 700, fontSize: 17 }}>{listing.model} {listing.storage}</div>
            {listing.url && <a href={listing.url} target="_blank" rel="noreferrer" style={{ color: "#4a8ab5", fontSize: 11 }}>Ver publicación ↗</a>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#4a8ab5", fontSize: 22, cursor: "pointer" }}>✕</button>
        </div>
        {listing.realData && (
          <div style={{ background: "#ffd60a0a", border: "1px solid #ffd60a33", borderRadius: 6, padding: "8px 12px", fontSize: 11, color: "#ffd60a", marginBottom: 14 }}>
            ⚠️ Verificá iCloud, batería e IMEI antes de comprar.
          </div>
        )}
        <div style={{ background: "#060d14", border: "1px solid #1e3a5f", borderRadius: 8, padding: 16, marginBottom: 14 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < rows.length - 1 ? "1px solid #0e2236" : "none" }}>
              <span style={{ fontSize: 12, color: "#7ab3d4" }}>{r.label}</span>
              <span style={{ fontSize: 13, color: r.color, fontWeight: 600, ...mono }}>{r.value}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "1px solid #1e3a5f" }}>
            <span style={{ fontWeight: 700, color: "#e8f4fd", fontSize: 14 }}>PRECIO MÁXIMO</span>
            <span style={{ fontWeight: 800, color: "#ffd60a", fontSize: 18, ...mono }}>${c.maxPrice}</span>
          </div>
        </div>
        <div style={{ background: c.isGoodDeal ? "#00ff8709" : "#ff4d4d09", border: `1px solid ${c.isGoodDeal ? "#00ff8733" : "#ff4d4d33"}`, borderRadius: 8, padding: 16 }}>
          {[["Precio publicado", `$${listing.price} USD`], ["Ganancia estimada", `${c.actualProfit > 0 ? "+" : ""}$${c.actualProfit}`], ["ROI", `${c.roi}%`]].map(([l, v], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: i < 2 ? 8 : 12 }}>
              <span style={{ fontSize: 12, color: "#7ab3d4" }}>{l}</span>
              <span style={{ ...mono, fontWeight: 700, color: "#e8f4fd" }}>{v}</span>
            </div>
          ))}
          {listing.price > c.maxPrice
            ? <div style={{ background: "#ffd60a11", border: "1px solid #ffd60a33", borderRadius: 6, padding: "9px 12px", fontSize: 12, color: "#ffd60a" }}>💬 Ofrecé <strong>${c.maxPrice}</strong> — negociá ${listing.price - c.maxPrice}</div>
            : <div style={{ background: "#00ff8711", border: "1px solid #00ff8733", borderRadius: 6, padding: "9px 12px", fontSize: 12, color: "#00ff87" }}>✅ Precio OK — podés cerrar</div>
          }
        </div>
      </div>
    </div>
  );
}

// ─── AI MODAL ─────────────────────────────────────────────────────────────────
function AIModal({ listing, settings, onClose }) {
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading]   = useState(true);
  const c = calcMaxPrice(listing, settings);

  useEffect(() => {
    (async () => {
      try {
        const prompt = `Eres experto en arbitraje de iPhones en Argentina. Analizá:
Modelo: ${listing.model} ${listing.storage}
Precio: $${listing.price} USD | Máximo calculado: $${c.maxPrice} | Mercado: ~$${c.marketPrice}
Ganancia est.: $${c.actualProfit} | ROI: ${c.roi}%
Estado: ${listing.condition} | Batería: ${listing.battery}%
iCloud: ${listing.icloud ? "libre" : "BLOQUEADO"} | IMEI: ${listing.imei_ok ? "OK" : "problema"}
Fuente: ${listing.source}${listing.fbRaw ? " (Facebook — verificar datos)" : ""}

Respondé:
1. 🎯 VEREDICTO: COMPRAR / NEGOCIAR A $${c.maxPrice} / EVITAR
2. 💰 ESTRATEGIA DE NEGOCIACIÓN
3. ⚠️ RIESGOS (máx 2)
4. ✅ A FAVOR (máx 2)
5. 💡 ACCIÓN INMEDIATA

Directo. Máx 180 palabras.`;
        const res  = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
        });
        const data = await res.json();
        setAnalysis(data.content?.[0]?.text || "Sin respuesta.");
      } catch { setAnalysis("Error al conectar."); }
      setLoading(false);
    })();
  }, [listing]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000bb", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div style={{ background: "linear-gradient(135deg,#0a1520,#0f1f30)", border: "1px solid #1e4a7a", borderRadius: 12, padding: 28, maxWidth: 520, width: "100%", maxHeight: "80vh", overflow: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ color: "#00ff87", fontSize: 10, letterSpacing: 2, marginBottom: 4, ...mono }}>ANÁLISIS IA</div>
            <div style={{ color: "#e8f4fd", fontWeight: 700, fontSize: 17 }}>{listing.model} {listing.storage}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#4a8ab5", fontSize: 22, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ background: "#071018", border: "1px solid #1e3a5f", borderRadius: 8, padding: 16, minHeight: 120 }}>
          {loading
            ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 30 }}><Spinner /><span style={{ color: "#4a8ab5", fontSize: 12, ...mono }}>Analizando...</span></div>
            : <div style={{ color: "#c8dff0", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", ...mono }}>{analysis}</div>
          }
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 14 }}>
          {[["Publicado", `$${listing.price}`], ["Máx.", `$${c.maxPrice}`], ["Ganancia", `${c.actualProfit > 0 ? "+" : ""}$${c.actualProfit}`], ["ROI", `${c.roi}%`]].map(([l, v]) => (
            <div key={l} style={{ background: "#071018", border: "1px solid #1e3a5f", borderRadius: 6, padding: 8, textAlign: "center" }}>
              <div style={{ color: "#4a7fa5", fontSize: 10, marginBottom: 2, ...mono }}>{l}</div>
              <div style={{ color: "#e8f4fd", fontWeight: 700, fontSize: 13, ...mono }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── LISTING CARD ─────────────────────────────────────────────────────────────
function ListingCard({ listing, settings, onCalc, onAnalyze }) {
  const c           = calcMaxPrice(listing, settings);
  const border      = c.isGoodDeal ? "#00ff87" : listing.price <= c.maxPrice + 25 ? "#ffd60a" : "#ff4d4d";
  const sourceColor = listing.source === "Facebook Marketplace" ? "#1877f2" : "#00aaff";

  return (
    <div
      style={{ background: "linear-gradient(135deg,#0f1923,#141f2e)", border: "1px solid #1e3a5f", borderLeft: `3px solid ${border}`, borderRadius: 8, padding: "15px 18px", marginBottom: 10, transition: "transform 0.15s" }}
      onMouseEnter={e => e.currentTarget.style.transform = "translateX(3px)"}
      onMouseLeave={e => e.currentTarget.style.transform = "translateX(0)"}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 9 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, flexWrap: "wrap" }}>
            <span style={{ color: "#e8f4fd", fontWeight: 700, fontSize: 15, ...mono }}>{listing.model}</span>
            <span style={{ color: "#4a8ab5", fontSize: 11 }}>{listing.storage}</span>
            <Tag color={sourceColor}>{listing.source === "Facebook Marketplace" ? "● FB" : "● ML"}</Tag>
            {c.isGoodDeal ? <Tag color="#00ff87">✓ PRECIO OK</Tag> : <Tag color="#ff4d4d">CARO +${listing.price - c.maxPrice}</Tag>}
          </div>
          <div style={{ display: "flex", gap: 10, fontSize: 10, color: "#4a7fa5", flexWrap: "wrap" }}>
            <span>📍 {listing.location}</span>
            <span>🕐 {listing.time}</span>
            {listing.seller && <span>👤 {listing.seller}</span>}
          </div>
        </div>
        <div style={{ textAlign: "right", marginLeft: 12 }}>
          <div style={{ color: "#e8f4fd", fontSize: 20, fontWeight: 800, ...mono }}>${listing.price}</div>
          {listing.priceARS && <div style={{ color: "#4a7fa5", fontSize: 10 }}>${listing.priceARS.toLocaleString("es-AR")} ARS</div>}
          <div style={{ fontSize: 10, color: "#4a7fa5", marginTop: 2 }}>máx. a pagar</div>
          <div style={{ fontSize: 15, fontWeight: 700, ...mono, color: c.maxPrice >= listing.price ? "#00ff87" : "#ffd60a" }}>${c.maxPrice}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 9 }}>
        <Tag color={c.actualProfit > 0 ? "#00ff87" : "#ff4d4d"}>ganancia {c.actualProfit > 0 ? "+" : ""}${c.actualProfit}</Tag>
        <Tag color={c.roi >= 15 ? "#00ff87" : "#ffd60a"}>ROI {c.roi}%</Tag>
        <Tag color="#7ab3d4">mercado ~${c.marketPrice}</Tag>
        {listing.fbRaw && <Tag color="#ffd60a">⚠ verificar iCloud e IMEI</Tag>}
      </div>

      {listing.price > c.maxPrice && (
        <div style={{ background: "#ffd60a0a", border: "1px solid #ffd60a22", borderRadius: 5, padding: "6px 10px", fontSize: 11, color: "#ffd60a", marginBottom: 9 }}>
          💬 Ofrecé <strong>${c.maxPrice}</strong> — descuento de ${listing.price - c.maxPrice}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => onCalc(listing)}    style={{ background: "linear-gradient(135deg,#3a2a00,#554000)", color: "#ffd60a", border: "1px solid #ffd60a33", borderRadius: 6, padding: "7px 12px", fontSize: 11, cursor: "pointer", flex: 1, ...mono }}>🧮 Cálculo</button>
        <button onClick={() => onAnalyze(listing)} style={{ background: "linear-gradient(135deg,#0a4a8c,#0066cc)", color: "#e8f4fd", border: "none",                  borderRadius: 6, padding: "7px 12px", fontSize: 11, cursor: "pointer", flex: 1, ...mono }}>⚡ Analizar IA</button>
        {listing.url && (
          <a href={listing.url} target="_blank" rel="noreferrer"
            style={{ background: sourceColor + "11", color: sourceColor, border: `1px solid ${sourceColor}33`, borderRadius: 6, padding: "7px 12px", fontSize: 11, textDecoration: "none", display: "flex", alignItems: "center", ...mono }}>
            ↗ Ver
          </a>
        )}
      </div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [listings,     setListings]     = useState([]);
  const [mlStatus,     setMlStatus]     = useState("idle");
  const [fbStatus,     setFbStatus]     = useState("idle");
  const [mlError,      setMlError]      = useState("");
  const [fbError,      setFbError]      = useState("");
  const [mlCount,      setMlCount]      = useState(0);
  const [fbCount,      setFbCount]      = useState(0);
  const [lastSync,     setLastSync]     = useState(null);
  const [apifyToken,   setApifyToken]   = useState("");
  const [tokenInput,   setTokenInput]   = useState("");
  const [showToken,    setShowToken]    = useState(false);
  const [filters,      setFilters]      = useState({ model: "", maxPrice: 600, source: "", onlyProfitable: false });
  const [settings,     setSettings]     = useState({ marginPct: 20, commissionPct: 15, shippingCost: 8 });
  const [showSettings, setShowSettings] = useState(false);
  const [calcListing,  setCalcListing]  = useState(null);
  const [aiListing,    setAiListing]    = useState(null);
  const [alertCount,   setAlertCount]   = useState(0);
  const seenIds = useRef(new Set());

  const addListings = (newOnes, silent = false) => {
    setListings(prev => {
      const fresh = newOnes.filter(r => !seenIds.current.has(r.id));
      fresh.forEach(r => seenIds.current.add(r.id));
      if (fresh.length > 0 && silent) setAlertCount(c => c + fresh.length);
      return [...fresh, ...prev].slice(0, 100);
    });
  };

  const runML = useCallback(async (silent = false) => {
    setMlStatus("loading"); setMlError("");
    try {
      const results = await fetchMercadoLibre(filters.model || "iphone usado", 20);
      addListings(results, silent);
      setMlCount(results.length);
      setMlStatus("ok");
      setLastSync(new Date());
    } catch (e) { setMlStatus("error"); setMlError(e.message); }
  }, [filters.model]);

  const runFB = useCallback(async (token) => {
    setFbStatus("loading"); setFbError("");
    try {
      const results = await fetchFacebook(filters.model || "iphone", token);
      addListings(results, false);
      setFbCount(results.length);
      setFbStatus("ok");
      setLastSync(new Date());
    } catch (e) { setFbStatus("error"); setFbError(e.message); }
  }, [filters.model]);

  useEffect(() => { runML(false); }, []);
  useEffect(() => {
    const t = setInterval(() => runML(true), 3 * 60 * 1000);
    return () => clearInterval(t);
  }, [runML]);

  const handleConnectFB = () => {
    if (!tokenInput.trim()) return;
    setApifyToken(tokenInput.trim());
    setShowToken(false);
    runFB(tokenInput.trim());
  };

  const filtered = listings.filter(l => {
    if (filters.model   && !l.model.toLowerCase().includes(filters.model.toLowerCase())) return false;
    if (l.price > filters.maxPrice || l.price <= 0) return false;
    if (filters.source  && l.source !== filters.source) return false;
    if (filters.onlyProfitable && !calcMaxPrice(l, settings).isGoodDeal) return false;
    return true;
  });

  const goodDeals = filtered.filter(l => calcMaxPrice(l, settings).isGoodDeal).length;

  return (
    <div style={{ minHeight: "100vh", background: "#060d14", color: "#e8f4fd", ...mono }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes slideIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#060d14}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px}
        select,input{font-family:'DM Mono',monospace}
      `}</style>

      {/* HEADER */}
      <div style={{ borderBottom: "1px solid #0e2236", padding: "14px 22px", background: "linear-gradient(180deg,#0a1520,#060d14)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ color: "#00ff87", fontSize: 10, letterSpacing: 3, marginBottom: 2 }}>ARBITRAJE · MULTI-FUENTE</div>
              <div style={{ fontSize: 19, fontWeight: 500 }}>📱 iPhone Tracker</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {alertCount > 0 && (
                <div style={{ background: "#00ff8722", color: "#00ff87", border: "1px solid #00ff8744", borderRadius: 20, padding: "3px 11px", fontSize: 11, animation: "slideIn .3s ease" }}>
                  🔔 +{alertCount} nuevas
                </div>
              )}
              <button onClick={() => setShowSettings(s => !s)} style={{ background: showSettings ? "#ffd60a22" : "#1e3a5f22", color: showSettings ? "#ffd60a" : "#7ab3d4", border: `1px solid ${showSettings ? "#ffd60a44" : "#1e3a5f"}`, borderRadius: 6, padding: "7px 12px", fontSize: 11, cursor: "pointer" }}>⚙ Parámetros</button>
              <button onClick={() => runML(false)} disabled={mlStatus === "loading"} style={{ background: "linear-gradient(135deg,#0a4a8c,#0066cc)", color: "#e8f4fd", border: "none", borderRadius: 6, padding: "7px 13px", fontSize: 11, cursor: "pointer", opacity: mlStatus === "loading" ? .6 : 1 }}>
                {mlStatus === "loading" ? "⟳ Buscando..." : "⟳ Actualizar ML"}
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <SourceStatus label="MercadoLibre"        color="#00aaff" status={mlStatus} count={mlCount} error={mlError} />
            <SourceStatus label="Facebook Marketplace" color="#1877f2" status={fbStatus} count={fbCount} error={fbError} />
            {lastSync && (
              <div style={{ fontSize: 10, color: "#4a7fa5", display: "flex", gap: 8 }}>
                <span>↻ {lastSync.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span style={{ color: "#00ff87" }}>✓ {goodDeals} oportunidades</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "18px 22px" }}>

        {/* CONECTAR FB */}
        {!apifyToken && (
          <div style={{ background: "linear-gradient(135deg,#0d1e35,#0f2440)", border: "1px solid #1877f244", borderRadius: 10, padding: 20, marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: showToken ? 14 : 0 }}>
              <div>
                <div style={{ color: "#1877f2", fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>FACEBOOK MARKETPLACE</div>
                <div style={{ color: "#e8f4fd", fontWeight: 600, fontSize: 14 }}>Conectar vía Apify</div>
                <div style={{ color: "#4a7fa5", fontSize: 11, marginTop: 4 }}>Actor: <span style={{ color: "#7ab3d4" }}>{APIFY_ACTOR}</span></div>
              </div>
              <button onClick={() => setShowToken(s => !s)} style={{ background: "linear-gradient(135deg,#1877f244,#1877f222)", color: "#1877f2", border: "1px solid #1877f244", borderRadius: 6, padding: "7px 14px", fontSize: 11, cursor: "pointer" }}>
                {showToken ? "Cancelar" : "Conectar →"}
              </button>
            </div>
            {showToken && (
              <div style={{ display: "flex", gap: 8 }}>
                <input type="password" placeholder="Pegá tu token de Apify" value={tokenInput} onChange={e => setTokenInput(e.target.value)} onKeyDown={e => e.key === "Enter" && handleConnectFB()}
                  style={{ flex: 1, background: "#060d14", border: "1px solid #1877f244", color: "#e8f4fd", borderRadius: 6, padding: "9px 12px", fontSize: 12, outline: "none" }} />
                <button onClick={handleConnectFB} style={{ background: "linear-gradient(135deg,#1877f2,#0d5ecf)", color: "#fff", border: "none", borderRadius: 6, padding: "9px 18px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Conectar</button>
              </div>
            )}
          </div>
        )}

        {apifyToken && (
          <div style={{ background: "#1877f20a", border: "1px solid #1877f233", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 11, color: "#1877f2", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>● Facebook Marketplace conectado</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => runFB(apifyToken)} style={{ background: "#1877f222", color: "#1877f2", border: "1px solid #1877f244", borderRadius: 5, padding: "4px 10px", fontSize: 10, cursor: "pointer" }}>⟳ Actualizar FB</button>
              <button onClick={() => { setApifyToken(""); setFbStatus("idle"); setFbCount(0); }} style={{ background: "none", color: "#ff4d4d88", border: "none", fontSize: 10, cursor: "pointer" }}>Desconectar</button>
            </div>
          </div>
        )}

        {/* PARÁMETROS */}
        {showSettings && (
          <div style={{ background: "linear-gradient(135deg,#0a1520,#0f1f30)", border: "1px solid #1e3a5f", borderRadius: 10, padding: 18, marginBottom: 16 }}>
            <div style={{ color: "#ffd60a", fontSize: 10, letterSpacing: 2, marginBottom: 14 }}>⚙ PARÁMETROS DE CÁLCULO</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              {[["marginPct","MARGEN",10,40,"%"], ["commissionPct","COMISIÓN ML",5,20,"%"], ["shippingCost","ENVÍO",0,30,"$"]].map(([k, label, min, max, unit]) => (
                <div key={k}>
                  <label style={{ display: "block", fontSize: 10, color: "#4a7fa5", marginBottom: 4 }}>
                    {label}: <span style={{ color: "#ffd60a" }}>{unit === "$" ? "$" : ""}{settings[k]}{unit === "%" ? "%" : ""}</span>
                  </label>
                  <input type="range" min={min} max={max} value={settings[k]} onChange={e => setSettings(s => ({ ...s, [k]: +e.target.value }))} style={{ width: "100%", accentColor: "#ffd60a" }} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: "#4a7fa5", background: "#071018", borderRadius: 6, padding: "8px 12px" }}>
              💡 Tipo de cambio: 1 USD = $1.500 ARS · Editá <code>ARS_TO_USD</code> en App.jsx si cambia el dólar blue
            </div>
          </div>
        )}

        {/* FILTROS */}
        <div style={{ background: "linear-gradient(135deg,#0a1520,#0f1f30)", border: "1px solid #1e3a5f", borderRadius: 10, padding: 18, marginBottom: 18 }}>
          <div style={{ color: "#4a7fa5", fontSize: 10, letterSpacing: 2, marginBottom: 14 }}>FILTROS</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 10, color: "#4a7fa5", marginBottom: 4 }}>MODELO</label>
              <select value={filters.model} onChange={e => setFilters(f => ({ ...f, model: e.target.value }))} style={{ width: "100%", background: "#060d14", border: "1px solid #1e3a5f", color: "#e8f4fd", borderRadius: 6, padding: "7px 10px", fontSize: 11 }}>
                <option value="">Todos</option>
                {MODELS.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 10, color: "#4a7fa5", marginBottom: 4 }}>FUENTE</label>
              <select value={filters.source} onChange={e => setFilters(f => ({ ...f, source: e.target.value }))} style={{ width: "100%", background: "#060d14", border: "1px solid #1e3a5f", color: "#e8f4fd", borderRadius: 6, padding: "7px 10px", fontSize: 11 }}>
                <option value="">Todas</option>
                {SOURCES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 10, color: "#4a7fa5", marginBottom: 4 }}>PRECIO MÁX.: <span style={{ color: "#ffd60a" }}>${filters.maxPrice}</span></label>
              <input type="range" min={50} max={900} value={filters.maxPrice} onChange={e => setFilters(f => ({ ...f, maxPrice: +e.target.value }))} style={{ width: "100%", accentColor: "#0066cc", marginTop: 10 }} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12, cursor: "pointer", fontSize: 11, color: "#7ab3d4" }}>
            <input type="checkbox" checked={filters.onlyProfitable} onChange={e => setFilters(f => ({ ...f, onlyProfitable: e.target.checked }))} style={{ accentColor: "#00ff87" }} />
            Solo dentro del precio máximo
          </label>
        </div>

        {/* LISTINGS */}
        {mlStatus === "loading" && listings.length === 0
          ? <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: 60 }}><Spinner size={36} /><span style={{ color: "#4a8ab5", fontSize: 12 }}>Buscando en MercadoLibre...</span></div>
          : filtered.length === 0
          ? <div style={{ textAlign: "center", color: "#4a7fa5", padding: 40, fontSize: 13 }}>No hay resultados con esos filtros.</div>
          : filtered.map(l => <ListingCard key={l.id} listing={l} settings={settings} onCalc={setCalcListing} onAnalyze={setAiListing} />)
        }

        <div style={{ textAlign: "center", color: "#1e3a5f", fontSize: 10, letterSpacing: 2, marginTop: 30 }}>
          ML API + APIFY FB · $1.500 ARS/USD · v4.0
        </div>
      </div>

      {calcListing && <CalcModal listing={calcListing} settings={settings} onClose={() => setCalcListing(null)} />}
      {aiListing   && <AIModal  listing={aiListing}  settings={settings} onClose={() => setAiListing(null)}  />}
    </div>
  );
}
