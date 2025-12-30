import React, { useEffect, useMemo, useRef, useState } from "react";
console.log("WC PID:", import.meta.env.VITE_WALLETCONNECT_PROJECT_ID);
import { registerSW } from "virtual:pwa-register";

/**
 * Nexus Analyt — Grid + Watchlist + Health
 * (Single file App.jsx)
 *
 * Keep existing layout/design.
 * Fixes added:
 * - If user enters SYMBOLS (ETH/BTC/etc) in Resolver, do NOT call /api/watchlist/live (backend expects DEX item ids).
 *   Instead, derive Live panel from Watchlist snapshot/cache (market mode).
 * - Prevent TBP "sticking": when primary/compare input changes, reset last-good refs for that slot.
 * - Health Score for market symbols is computed locally (heuristic) so ETH vs BTC works without backend health.
 * - AI context now follows what user selected (primary/compare), not stale TBP.
 * - AI Render payload keeps {question:"..."} top-level; context is appended into the question text.
 */


// ---- Backend API base (Render in prod; fallback for localhost dev) ----
const API_BASE =
  import.meta?.env?.VITE_API_BASE ||
  (typeof window !== "undefined" && window.location.hostname === "localhost"
    ? "https://nexus-analyt.onrender.com"
    : typeof window !== "undefined"
      ? window.location.origin
      : "");

function apiUrl(path) {
  if (!path) return API_BASE;
  if (path.startsWith("http")) return path;
  if (!path.startsWith("/")) path = "/" + path;
  return `${API_BASE}${path}`;
}
// ---------------------------------------------------------------

const API = apiUrl("/api");
// --- PWA Disclaimer Gate ---
const DISCLAIMER_KEY = "nexus_disclaimer_accepted_v1";

function getDisclaimerAccepted() {
  try {
    return localStorage.getItem(DISCLAIMER_KEY) === "yes";
  } catch {
    return false;
  }
}

// ✅ AI runs via your backend (/api/ai) which proxies TBP-Advisor

// LocalStorage keys for Resolver + Watchlist
const LS_RESOLVER_PRIMARY = "na_resolver_primary";
const LS_RESOLVER_PAIR = "na_resolver_pair";
const LS_RESOLVER_COMPARE = "na_resolver_compare";
const LS_RESOLVER_COMPARE_SET = "na_resolver_compare_set_v1";
const LS_WATCHLIST = "na_watchlist";
const LS_SYMBOL_MAP = "na_symbol_map";
const LS_CG_MAP = "na_cg_map";
const LS_CG_CACHE = "na_cg_cache_v1";
const LS_GRID_HIDDEN_ORDERS = "na_grid_hidden_orders_v1";

const LS_TERMS_ACCEPTED = "na_terms_v1_accepted";
const LS_AI_VERBOSITY = "na_ai_verbosity_v1";
const LS_AUTH_TOKEN = "na_auth_token";
const LS_WALLET_LAST = "na_wallet_last"; // {address, chainId, connector}


/* -------------------------
   small utilities
--------------------------*/
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveJson(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
function normalizeSymbol(x) {
  return String(x || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, "");
}

// validate / canonicalize a symbol id (kept simple & deterministic)
function validateSymbol(x) {
  return normalizeSymbol(x);
}

function formatUSD(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}


function formatPrice(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const a = Math.abs(n);
  // Adaptive decimals so small-price coins don't show as 0.00
  let max = 2;
  let min = 2;
  if (a >= 1) {
    max = 2;
    min = 2;
  } else if (a >= 0.1) {
    max = 4;
    min = 0;
  } else if (a >= 0.01) {
    max = 5;
    min = 0;
  } else if (a >= 0.001) {
    max = 6;
    min = 0;
  } else {
    max = 8;
    min = 0;
  }
  return n.toLocaleString(undefined, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
}


function ttlToSeconds(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = (unit || 's').toLowerCase();
  const mult = u === 'd' ? 86400 : u === 'h' ? 3600 : u === 'm' ? 60 : 1;
  return Math.round(v * mult);
}

function formatPct(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
async function jget(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : (res.status + " " + res.statusText);
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Timeout (" + Math.round(timeoutMs/1000) + "s) – API antwortet nicht.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function jpost(url, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) ? (data.error || data.message) : (res.status + " " + res.statusText);
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Timeout (" + Math.round(timeoutMs/1000) + "s) – API antwortet nicht.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...(options || {}), signal: ctrl.signal });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`${r.status} ${r.statusText}${t ? ` — ${t}` : ""}`);
    }
    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

/* -------------------------
   tiny UI primitives
--------------------------*/
function Card({ title, right, children }) {
  return (
    <div className="card">
      <div className="cardTop">
        <div className="cardTitle">{title}</div>
        <div className="cardRight">{right}</div>
      </div>
      <div className="cardBody">{children}</div>
    </div>
  );
}
function Badge({ ok, children }) {
  const cls =
    ok === true ? "badge ok" : ok === false ? "badge bad" : "badge neutral";
  return <span className={cls}>{children}</span>;
}
function Pill({ children }) {
  return <span className="pill">{children}</span>;
}
function Collapsible({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="collapsible">
      <button className="collapsibleBtn" onClick={() => setOpen((s) => !s)}>
        <span className="caret">{open ? "▼" : "▶"}</span> {title}
      </button>
      {open ? <div className="collapsibleBody">{children}</div> : null}
    </div>
  );
}

/* -------------------------
   Inline Logo
--------------------------*/
function NexusLogo() {
  return (
    <div className="brand">
      <svg
        className="logo"
        viewBox="0 0 64 64"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(0,255,160,0.95)" />
            <stop offset="1" stopColor="rgba(0,140,255,0.85)" />
          </linearGradient>
        </defs>
        <path
          d="M32 4l9 16 18 3-12 13 3 18-18-8-18 8 3-18-12-13 18-3 9-16z"
          fill="rgba(0,0,0,0.25)"
          stroke="rgba(97,255,194,0.35)"
          strokeWidth="2"
        />
        <circle cx="32" cy="32" r="12" fill="url(#g)" opacity="0.9" />
        <path
          d="M22 32h20M32 22v20"
          stroke="rgba(10,18,16,0.85)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>

      <div className="brandText">
        <div className="title">Nexus Analyt</div>
        <div className="subtitle">Grid + Watchlist + Health</div>
      </div>
    </div>
  );
}

/* -------------------------
   Market Health (server-side)
   - Health Score for market symbols is computed by backend: GET /api/health/market?fast=1&symbol=BTC
   - Frontend only fetches and displays results (keeps UI light + consistent)
--------------------------*/
/* -------------------------
   App
--------------------------*/
export default 
/* =========================
   Help texts (DE/EN) + modal
   ========================= */
const HELP_TEXTS = {
  resolver_primary: {
    de: {
      title: "Primary item id",
      body:
        "Der Haupt‑Coin/Market, auf den sich Resolver, Live‑Preis und Grid beziehen.\n\nTipp: Nutze ein Symbol wie BTC/ETH oder (falls du es nutzt) eine Pool/Pair‑ID."
    },
    en: {
      title: "Primary item id",
      body:
        "The main coin/market Resolver, Live Price and Grid are based on.\n\nTip: Use a symbol like BTC/ETH or (if you use it) a pool/pair id."
    }
  },
  resolver_compare: {
    de: { title: "Compare item (A vs B)", body: "Optionaler Vergleichs‑Coin. Wird für A-vs-B Kennzahlen/Anzeige genutzt." },
    en: { title: "Compare item (A vs B)", body: "Optional compare coin used for A-vs-B metrics/preview." }
  },
  resolver_compare_set: {
    de: {
      title: "Compare set",
      body:
        "Wähle bis zu 20 Coins aus der Watchlist aus. Diese werden im Resolver automatisch miteinander verglichen.\n\nDu kannst Zeitraum (7/30/90 Tage) wählen – ideal um zu entscheiden, welcher Coin für den Grid am besten passt."
    },
    en: {
      title: "Compare set",
      body:
        "Select up to 20 coins from the watchlist. Resolver will compare them automatically.\n\nPick a range (7/30/90 days) to decide which coin fits the grid best."
    }
  },
  grid_coin: {
    de: { title: "Coin", body: "Coin, auf dem der Grid läuft (Simulation/Monitoring). Wird aus Resolver/Watchlist gewählt." },
    en: { title: "Coin", body: "The coin the grid runs on (simulation/monitoring). Usually selected from Resolver/Watchlist." }
  },
  grid_mode: {
    de: { title: "Mode", body: "AUTO = Grid‑Orders werden automatisch erstellt. MANUAL = du legst Orders manuell an." },
    en: { title: "Mode", body: "AUTO builds grid orders automatically. MANUAL lets you create orders yourself." }
  },
  grid_demo_usd: {
    de: { title: "Demo investment (USD)", body: "Simuliertes Start‑Kapital für PnL/ROI Berechnung. Kein echtes Geld." },
    en: { title: "Demo investment (USD)", body: "Simulated starting capital for PnL/ROI. Not real money." }
  },
  watchlist_add: {
    de: { title: "Watchlist – Add symbol", body: "Füge Symbole hinzu (z.B. BTC, ETH, SOL, TBP). Diese erscheinen in Watchlist & Resolver." },
    en: { title: "Watchlist – Add symbol", body: "Add symbols (e.g., BTC, ETH, SOL, TBP). They appear in Watchlist & Resolver." }
  }
};

function detectLang() {
  try {
    const l = (navigator.language || "en").toLowerCase();
    return l.startsWith("de") ? "de" : "en";
  } catch {
    return "en";
  }
}

function HelpModal({ open, onClose, content }) {
  if (!open || !content) return null;
  return (
    <div
      className="modalBackdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={content.title}
    >
      <div className="modalCard" onClick={(e) => e.stopPropagation()}>
        <div className="modalTitleRow">
          <div className="modalTitle">{content.title}</div>
          <button className="modeBtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modalBody mono" style={{ whiteSpace: "pre-wrap" }}>
          {content.body}
        </div>
      </div>
    </div>
  );
}

function InfoIcon({ onClick, title = "Info" }) {
  return (
    <button
      type="button"
      className="infoIcon"
      onClick={onClick}
      aria-label={title}
      title={title}
    >
      i
    </button>
  );
}

function LabelWithHelp({ text, helpKey, onHelp }) {
  return (
    <div className="labelRow">
      <div className="label">{text}</div>
      {helpKey ? <InfoIcon onClick={() => onHelp(helpKey)} /> : null}
    </div>
  );
}

/* =========================
   Simple SVG chart (no deps)
   ========================= */
function ResolverChart({ seriesById, ids, height = 220 }) {
  const pad = 14;
  const w = 1000;
  const h = height;
  const all = [];
  ids.forEach((id) => {
    const s = seriesById?.[id];
    if (Array.isArray(s)) s.forEach((p) => all.push(p));
  });
  if (!all.length) return null;

  // normalize to % from start (100 at start) for comparability
  const norm = {};
  ids.forEach((id) => {
    const s = seriesById?.[id];
    if (!Array.isArray(s) || s.length < 2) return;
    const base = Number(s[0][1]) || 0;
    if (!base) return;
    norm[id] = s.map(([t, v]) => [t, (Number(v) / base) * 100]);
  });

  const ys = [];
  Object.values(norm).forEach((s) => s.forEach((p) => ys.push(p[1])));
  if (!ys.length) return null;

  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xMin = Math.min(...all.map((p) => p[0]));
  const xMax = Math.max(...all.map((p) => p[0]));

  const sx = (x) => pad + ((x - xMin) / (xMax - xMin || 1)) * (w - pad * 2);
  const sy = (y) => pad + ((yMax - y) / (yMax - yMin || 1)) * (h - pad * 2);

  const mkPath = (s) =>
    s
      .map(([t, v], i) => `${i === 0 ? "M" : "L"} ${sx(t).toFixed(2)} ${sy(v).toFixed(2)}`)
      .join(" ");

  return (
    <div className="resolverChart">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} aria-label="Resolver chart">
        {/* grid */}
        <g opacity="0.35">
          {[0.2, 0.4, 0.6, 0.8].map((p) => (
            <line key={p} x1={pad} x2={w - pad} y1={pad + (h - pad * 2) * p} y2={pad + (h - pad * 2) * p} stroke="currentColor" />
          ))}
        </g>
        {Object.entries(norm).map(([id, s]) => (
          <path key={id} d={mkPath(s)} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.9" />
        ))}
      </svg>
      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        Normalized to 100 at start (so you can compare performance).
      </div>
    </div>
  );
}

function App() {
  const DEV_MODE = import.meta?.env?.DEV === true;
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [canInstall, setCanInstall] = useState(false);
const [helpKey, setHelpKey] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const uiLang = useMemo(() => detectLang(), []);

  const openHelp = (key) => { setHelpKey(key); setHelpOpen(true); };
  const helpContent = useMemo(() => {
    if (!helpKey) return null;
    const item = HELP_TEXTS[helpKey];
    if (!item) return null;
    return item[uiLang] || item.en;
  }, [helpKey, uiLang]);


  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setCanInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function installApp() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
  }

  
  // Health label (UX): translates score into a simple status (educational, not a trade signal)
  const healthLabelForScore = (score) => {
    const s = Number(score);
    if (!Number.isFinite(s)) return { label: "—", tone: "neutral" };
    if (s >= 71) return { label: "Healthy", tone: "healthy" };
    if (s >= 51) return { label: "Stable", tone: "stable" };
    return { label: "Weak", tone: "weak" };
  };

  // -------------------------
  // Terms / Disclaimer Gate (first-run)
  // -------------------------
  const [termsOpen, setTermsOpen] = useState(() => {
    try {
      return localStorage.getItem(LS_TERMS_ACCEPTED) !== "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    registerSW({ immediate: true }); // ✅ immer registrieren, sonst kein App-Icon auf Android
  }, []);



  const [termsChecked, setTermsChecked] = useState(false);
  const [termsErr, setTermsErr] = useState("");
  function acceptTerms() {
    setTermsErr("");
    if (!termsChecked) {
      setTermsErr("Please confirm the checkbox to continue.");
      return;
    }
    try {
      localStorage.setItem(LS_TERMS_ACCEPTED, "1");
    } catch {}
    setTermsOpen(false);
  }

// Resolver inputs
  const [primaryItemId, setPrimaryItemId] = useState(
    () => localStorage.getItem(LS_RESOLVER_PRIMARY) || "polygon_weth_usdc_quicksw"
  );
  const [pairOrContract, setPairOrContract] = useState(
    () => localStorage.getItem(LS_RESOLVER_PAIR) || ""
  );
  const [compareItemId, setCompareItemId] = useState(
    () => localStorage.getItem(LS_RESOLVER_COMPARE) || ""
  );

const [resolverCompareSet, setResolverCompareSet] = useState(() => {
  const stored = loadJson(LS_RESOLVER_COMPARE_SET, []);
  const arr = Array.isArray(stored) ? stored : [];
  return arr.map((x) => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 20);
});
const [resolverDays, setResolverDays] = useState(30);
const [resolverHist, setResolverHist] = useState(null);
const [resolverHistErr, setResolverHistErr] = useState("");
const [resolverHistLoading, setResolverHistLoading] = useState(false);

useEffect(() => {
  try { localStorage.setItem(LS_RESOLVER_COMPARE_SET, JSON.stringify(resolverCompareSet)); } catch {}
}, [resolverCompareSet]);

// Fetch history for chart (uses backend cache endpoint)
useEffect(() => {
  const ids = (resolverCompareSet || []).slice(0, 20);
  if (!ids.length) { setResolverHist(null); setResolverHistErr(""); return; }

  let alive = true;
  (async () => {
    setResolverHistLoading(true);
    setResolverHistErr("");
    try {
      const data = await fetchJsonWithTimeout(API_BASE + "/api/resolver/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.map((s) => (symbolMap?.[s]?.cg_id ? symbolMap[s].cg_id : s.toLowerCase())), days: resolverDays })
      }, 25000);
      if (!alive) return;

      // Map back to symbols where possible (best-effort)
      const series = data && data.series ? data.series : {};
      setResolverHist({ days: data.days || resolverDays, series });
    } catch (e) {
      if (!alive) return;
      setResolverHist(null);
      setResolverHistErr(e?.message || "History fetch failed");
    } finally {
      if (alive) setResolverHistLoading(false);
    }
  })();

  return () => { alive = false; };
}, [resolverCompareSet, resolverDays, symbolMap]);

  // -------------------------
  // WalletConnect + Auth (Backend nonce/sign)
  // -------------------------
  const [walletAddress, setWalletAddress] = useState(() => {
    try {
      const last = loadJson(LS_WALLET_LAST, null);
      return last?.address || "";
    } catch {
      return "";
    }
  });
  const [walletChainId, setWalletChainId] = useState(() => {
    try {
      const last = loadJson(LS_WALLET_LAST, null);
      return last?.chainId || null;
    } catch {
      return null;
    }
  });
  const [walletConnector, setWalletConnector] = useState(() => {
    try {
      const last = loadJson(LS_WALLET_LAST, null);
      return last?.connector || "";
    } catch {
      return "";
    }
  });
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(LS_AUTH_TOKEN) || "");
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletErr, setWalletErr] = useState("");

  const wcProviderRef = useRef(null);

  const isAuthed = Boolean(authToken);

  function shortAddr(a) {
    const s = String(a || "");
    return s && s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
  }

  function persistWallet(next) {
    saveJson(LS_WALLET_LAST, next);
  }

  async function connectInjected() {
    if (!window.ethereum) throw new Error("No injected wallet found (install MetaMask/Rabby)");    
    const eth = window.ethereum;
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0] || "";
    const chainHex = await eth.request({ method: "eth_chainId" }).catch(() => null);
    const chainId = chainHex ? parseInt(chainHex, 16) : null;

    setWalletAddress(address);
    setWalletChainId(chainId);
    setWalletConnector("injected");
    persistWallet({ address, chainId, connector: "injected" });

    // Listen for changes
    try {
      eth.on?.("accountsChanged", (accs) => {
        const a = accs?.[0] || "";
        setWalletAddress(a);
        persistWallet({ address: a, chainId: walletChainId, connector: "injected" });
        // Token should be cleared if wallet changes
        if (a && walletAddress && a.toLowerCase() !== walletAddress.toLowerCase()) {
          logout();
        }
      });
      eth.on?.("chainChanged", (ch) => {
        const cid = ch ? parseInt(ch, 16) : null;
        setWalletChainId(cid);
        persistWallet({ address: address, chainId: cid, connector: "injected" });
      });
    } catch {}
  }

  async function connectWalletConnect() {
    // WalletConnect v2 (lazy import). Non-blocking + clear error handling.
    setWalletErr("");
    setWalletBusy(true);

    try {
      // If already connected via WC, just return.
      if (walletConnector === "walletconnect" && walletAddress) return;

      let EthereumProvider;
      try {
        ({ EthereumProvider } = await import("@walletconnect/ethereum-provider"));
      } catch (e) {
        throw new Error(
          'WalletConnect dependency missing. Run: npm i @walletconnect/ethereum-provider'
        );
      }

      const projectId = import.meta?.env?.VITE_WALLETCONNECT_PROJECT_ID;
      if (!projectId) {
        throw new Error(
          "Missing VITE_WALLETCONNECT_PROJECT_ID in .env (WalletConnect needs a project id)."
        );
      }

      // Reuse provider if we already created one
      let provider = wcProviderRef.current;
      if (!provider) {
        provider = await EthereumProvider.init({
          projectId,
          // common chains: ETH, Polygon, BSC, Arbitrum
          chains: [1, 137, 56, 42161],
          optionalChains: [10, 43114, 8453],
          showQrModal: true,
          methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData"],
          events: ["accountsChanged", "chainChanged", "disconnect"],
        });
        wcProviderRef.current = provider;
      }

      // Some setups can hang on connect; keep UI responsive with a timeout.
      const connectWithTimeout = Promise.race([
        provider.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("WalletConnect timeout (try again).")), 25000)
        ),
      ]);

      await connectWithTimeout;

      const accounts = provider.accounts || [];
      const address = accounts?.[0] || "";
      const chainId = provider.chainId || null;

      setWalletAddress(address);
      setWalletChainId(chainId);
      setWalletConnector("walletconnect");
      persistWallet({ address, chainId, connector: "walletconnect" });

      // Listeners
      provider.on?.("accountsChanged", (accs) => {
        const a = accs?.[0] || "";
        setWalletAddress(a);
        persistWallet({ address: a, chainId: provider.chainId, connector: "walletconnect" });
        // if address changes, clear auth token
        if (a && walletAddress && a.toLowerCase() !== walletAddress.toLowerCase()) logout();
      });

      provider.on?.("chainChanged", (ch) => {
        const cid = typeof ch === "string" ? parseInt(ch, 16) : ch;
        setWalletChainId(cid);
        persistWallet({ address: provider.accounts?.[0] || "", chainId: cid, connector: "walletconnect" });
      });

      provider.on?.("disconnect", () => {
        disconnectWallet();
      });
    } catch (e) {
      const msg = e?.message || String(e);
      setWalletErr(msg);
      console.error(e);
    } finally {
      setWalletBusy(false);
    }
  }

  async function connectWallet(kind) {
    setWalletErr("");
    setWalletBusy(true);
    try {
      if (kind === "walletconnect") await connectWalletConnect();
      else await connectInjected();
    } catch (e) {
      setWalletErr(String(e?.message || e));
    } finally {
      setWalletBusy(false);
    }
  }

  async function disconnectWallet() {
    setWalletErr("");
    try {
      if (walletConnector === "walletconnect" && wcProviderRef.current) {
        await wcProviderRef.current.disconnect().catch(() => {});
        wcProviderRef.current = null;
      }
    } catch {}
    setWalletAddress("");
    setWalletChainId(null);
    setWalletConnector("");
    persistWallet({ address: "", chainId: null, connector: "" });
    logout();
  }

  function logout() {
    localStorage.removeItem(LS_AUTH_TOKEN);
    setAuthToken("");
  }

  // --- Session idle timeout (keeps wallet connected, but signs out of backend/AI/grid) ---
  const LS_LAST_ACTIVITY = "na_last_activity";
  const IDLE_MS = 30 * 60 * 1000; // 30 minutes

  function touchActivity() {
    try {
      localStorage.setItem(LS_LAST_ACTIVITY, String(Date.now()));
    } catch {}
  }

  useEffect(() => {
    // initialize on mount
    touchActivity();

    const onAny = () => touchActivity();
    window.addEventListener("mousemove", onAny);
    window.addEventListener("keydown", onAny);
    window.addEventListener("click", onAny);
    window.addEventListener("touchstart", onAny);

    const t = setInterval(() => {
      try {
        const last = parseInt(localStorage.getItem(LS_LAST_ACTIVITY) || "0", 10);
        if (!last) return;
        if (Date.now() - last > IDLE_MS) {
          // only remove backend auth token; wallet session can remain
          logout();
        }
      } catch {}
    }, 5000);

    return () => {
      clearInterval(t);
      window.removeEventListener("mousemove", onAny);
      window.removeEventListener("keydown", onAny);
      window.removeEventListener("click", onAny);
      window.removeEventListener("touchstart", onAny);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

async function signMessage(message) {
    if (!walletAddress) throw new Error("Connect wallet first.");

    // WalletConnect provider supports request() too
    const provider =
      walletConnector === "walletconnect" ? wcProviderRef.current : window.ethereum;

    if (!provider?.request) throw new Error("Wallet provider not available.");

    // personal_sign expects [message, address]
    const sig = await provider.request({
      method: "personal_sign",
      params: [message, walletAddress],
    });
    return sig;
  }

  async function signInBackend() {
    setWalletErr("");
    setWalletBusy(true);
    try {
      if (!walletAddress) throw new Error("Connect wallet first.");
      const nonceRes = await jpost(`${API}/auth/nonce`, { address: walletAddress });
      const message = nonceRes?.message;
      const nonce = nonceRes?.nonce;
      if (!message || !nonce) throw new Error("Backend nonce failed.");

      const signature = await signMessage(message);

      const verifyRes = await jpost(`${API}/auth/verify`, {
        address: walletAddress,
        signature,
        message,
        nonce,
      });

      const token = verifyRes?.token;
      if (!token) throw new Error("Backend verify failed (no token).");
      localStorage.setItem(LS_AUTH_TOKEN, token);
      setAuthToken(token);
    } catch (e) {
      setWalletErr(String(e?.message || e));
    } finally {
      setWalletBusy(false);
    }
  }

  // Main data (for DEX mode / backend health)
  const [live, setLive] = useState(null);
  const [healthScore, setHealthScore] = useState(null);
  const [compareHealthScore, setCompareHealthScore] = useState(null);
  const [healthRefreshBusy, setHealthRefreshBusy] = useState(false);

  // Keep last good values (prevents "-" during temporary refresh failures)
  const lastLiveByKeyRef = useRef({});
  const lastHealthByKeyRef = useRef({});
  const lastCompareHealthByKeyRef = useRef({});
// Track "key" of the last successful context to avoid TBP sticking when user changes primary/compare.
  const lastPrimaryKeyRef = useRef("");
  const lastCompareKeyRef = useRef("");

  

  // Deterministic cache keys for "last known good" values (prevents cross-asset sticking)
  const primaryDexKey = `${(primaryItemId || "").trim()}||${(pairOrContract || "").trim()}`;
  const compareDexKey = `${(compareItemId || "").trim()}||${(pairOrContract || "").trim()}`;
// Busy / errors
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Grid controls
  const [mode, setMode] = useState("SAFE"); // SAFE / AGGRESSIVE
  const [session, setSession] = useState("IDLE");
  const [gridOrders, setGridOrders] = useState([]);
  const ordersPollInFlight = useRef(false);
  const [gridHiddenIds, setGridHiddenIds] = useState(() => {
    const raw = loadJson(LS_GRID_HIDDEN_ORDERS, []);
    return Array.isArray(raw) ? raw : [];
  });
  const [gridOrdersFilter, setGridOrdersFilter] = useState("ALL");

  const [autoRun, setAutoRun] = useState(false);
  const [autoInterval, setAutoInterval] = useState(10);
  const [demoInvestUsd, setDemoInvestUsd] = useState(5000); // demo investment per asset (USD)

  // Auto mode: how much of demo capital is used (percent), per SAFE/AGGRESSIVE
  const [autoInvestPctSafe, setAutoInvestPctSafe] = useState(() => {
    try { return Number(localStorage.getItem("NA_AUTO_INV_PCT_SAFE") || 35); } catch { return 35; }
  });
  const [autoInvestPctAgg, setAutoInvestPctAgg] = useState(() => {
    try { return Number(localStorage.getItem("NA_AUTO_INV_PCT_AGG") || 70); } catch { return 70; }
  });

  const autoInvestPct = useMemo(() => {
    const raw = (mode === "AGGRESSIVE" ? autoInvestPctAgg : autoInvestPctSafe);
    const n = Number(raw);
    if (!Number.isFinite(n)) return (mode === "AGGRESSIVE" ? 70 : 35);
    return Math.max(0, Math.min(100, n));
  }, [mode, autoInvestPctAgg, autoInvestPctSafe]);

  const autoInvestUsd = useMemo(() => {
    const usd = Number(demoInvestUsd) * (autoInvestPct / 100);
    if (!Number.isFinite(usd)) return 0;
    return Math.max(0, usd);
  }, [demoInvestUsd, autoInvestPct]);

  useEffect(() => {
    try { localStorage.setItem("NA_AUTO_INV_PCT_SAFE", String(autoInvestPctSafe)); } catch {}
  }, [autoInvestPctSafe]);
  useEffect(() => {
    try { localStorage.setItem("NA_AUTO_INV_PCT_AGG", String(autoInvestPctAgg)); } catch {}
  }, [autoInvestPctAgg]);
  const [manualSide, setManualSide] = useState("BUY");
  const [manualPrice, setManualPrice] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [gridMeta, setGridMeta] = useState(null);

  const [gridSelectedItem, setGridSelectedItem] = useState("");
  const [gridOrderMode, setGridOrderMode] = useState("AUTO"); // AUTO | MANUAL
  const [manualTTL, setManualTTL] = useState(60); // seconds
  const [manualTTLUnit, setManualTTLUnit] = useState("s"); // s | m | h | d
  const [gridFills, setGridFills] = useState([]);

  // AI analyst
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("Why stable? What to observe? What risks?");
  const [aiAnswer, setAiAnswer] = useState("");

  
  const [aiVerbosity, setAiVerbosity] = useState(() => {
    try {
      const v = localStorage.getItem(LS_AI_VERBOSITY);
      return v === "concise" || v === "detailed" ? v : "detailed";
    } catch {
      return "detailed";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_AI_VERBOSITY, aiVerbosity);
    } catch {}
  }, [aiVerbosity]);

// Default mapping for majors (market) and TBP as dex mapping (optional)
  const DEFAULT_SYMBOL_MAP = useMemo(
    () => ({
      BTC: { mode: "market", id: "bitcoin" },
      ETH: { mode: "market", id: "ethereum" },
      BNB: { mode: "market", id: "binancecoin" },
      XRP: { mode: "market", id: "ripple" },
      SOL: { mode: "market", id: "solana" },
      TBP: {
        mode: "dex",
        chain: "polygon",
        contract: "0x5D636a3b495ac15e3C8180cb462e1302fa4D01f1",
      },
    }),
    []
  );

  const DEFAULT_WATCHLIST = useMemo(() => ["BTC", "ETH", "BNB", "XRP", "SOL"], []);

  // Merge stored mappings with defaults so majors don't vanish on reload.
  const [symbolMap, setSymbolMap] = useState(() => {
    const stored = loadJson(LS_SYMBOL_MAP, {});
    return { ...DEFAULT_SYMBOL_MAP, ...(stored || {}) };
  });

  // Default majors, TBP is optional and only appears when added.
  const [watchlist, setWatchlist] = useState(() => {
    const stored = loadJson(LS_WATCHLIST, DEFAULT_WATCHLIST);
    const arr = Array.isArray(stored) ? stored : DEFAULT_WATCHLIST;
    const uniq = [];
    for (const s of arr.map((x) => String(x).trim().toUpperCase())) {
      if (s && !uniq.includes(s)) uniq.push(s);
    }
    // Ensure majors are always present
    for (const s of DEFAULT_WATCHLIST) {
      if (!uniq.includes(s)) uniq.push(s);
    }
    // TBP NICHT auto-add!
    return uniq.filter((s) => s !== "TBP" || arr.includes("TBP"));
  });

  const [wlSnapshots, setWlSnapshots] = useState([]);
  const [wlCache, setWlCache] = useState(() => ({}));
  const [wlBusy, setWlBusy] = useState(false);
  const [wlErr, setWlErr] = useState("");
  const [wlAddInput, setWlAddInput] = useState("");
  const [wlMoreSymbol, setWlMoreSymbol] = useState("");

const [addPickerOpen, setAddPickerOpen] = useState(false);
const [addPickerQuery, setAddPickerQuery] = useState("");
const [addPickerResults, setAddPickerResults] = useState([]);
const [addPickerBusy, setAddPickerBusy] = useState(false);
const [addPickerErr, setAddPickerErr] = useState("");
const [addPickerTab, setAddPickerTab] = useState("market"); // "market" | "dex"
const [addDexSymbol, setAddDexSymbol] = useState("");
const [addDexContract, setAddDexContract] = useState("");
const [addDexChain, setAddDexChain] = useState("");
const [addDexErr, setAddDexErr] = useState("");

  // Persist inputs
  useEffect(() => {
    localStorage.setItem(LS_RESOLVER_PRIMARY, primaryItemId || "");
  }, [primaryItemId]);
  useEffect(() => {
    localStorage.setItem(LS_RESOLVER_PAIR, pairOrContract || "");
  }, [pairOrContract]);
  useEffect(() => {
    localStorage.setItem(LS_RESOLVER_COMPARE, compareItemId || "");
  }, [compareItemId]);
  useEffect(() => {
    saveJson(LS_SYMBOL_MAP, symbolMap);
  }, [symbolMap]);
  useEffect(() => {
    saveJson(LS_WATCHLIST, watchlist);
  }, [watchlist]);

  useEffect(() => {
    saveJson(LS_GRID_HIDDEN_ORDERS, gridHiddenIds);
  }, [gridHiddenIds]);

  // Unhide newly created OPEN orders even if their IDs were hidden before (backend may reuse IDs).
  useEffect(() => {
    const all = Array.isArray(gridOrders) ? gridOrders : [];
    if (!all.length) return;

    const openIds = new Set(
      all
        .filter((o) => String(o?.status || "").toUpperCase() === "OPEN" && o?.id)
        .map((o) => String(o.id))
    );
    if (!openIds.size) return;

    setGridHiddenIds((prev) => {
      const arr = Array.isArray(prev) ? prev.map(String) : [];
      const next = arr.filter((id) => !openIds.has(String(id)));
      // Avoid state updates when nothing changes
      if (next.length === arr.length) return prev;
      return next;
    });
  }, [gridOrders]);

  // ===== Watchlist helpers =====


  // Move symbol up/down in the watchlist (used for prioritization / Top 10 order)
  function moveWatchlistSymbol(sym, dir) {
    const s = normalizeSymbol(sym);
    if (!s) return;
    setWatchlist((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      const i = arr.indexOf(s);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= arr.length) return prev;
      const next = [...arr];
      const tmp = next[i];
      next[i] = next[j];
      next[j] = tmp;
      return next;
    });
  }
  function buildWatchItems() {
    const items = [];
    for (const sym of watchlist || []) {
      const meta = symbolMap?.[sym];
      if (!meta) {
        items.push({ symbol: sym, mode: "market" }); // no id -> backend resolves (cached/common)
        continue;
      }
      if (meta.mode === "market") {
        items.push({ symbol: sym, mode: "market", id: meta.id });
      } else if (meta.mode === "dex") {
        items.push({
          symbol: sym,
          mode: "dex",
          chain: meta.chain,
          contract: meta.contract,
        });
      }
    }
    return items;
  }

  async function refreshWatchlist(onlySyms = null) {
    setWlErr("");
    let items = buildWatchItems();
    if (Array.isArray(onlySyms) && onlySyms.length) {
      const set = new Set(onlySyms.map((s) => String(s || '').toUpperCase()));
      items = items.filter((it) => set.has(String(it.symbol || '').toUpperCase()));
    }
    if (!items.length) {
      setWlSnapshots([]);
      return;
    }

    setWlBusy(true);
    try {
      const r = await jpost(`${API}/watchlist/snapshot`, { items });
      const results = r?.results || [];
      setWlSnapshots(results);

      // Cache: values do not vanish during updating/error
      setWlCache((prev) => {
        const next = { ...(prev || {}) };
        for (const row of results) {
          const sym = normalizeSymbol(row?.symbol);
          if (!sym) continue;
          const prevRow = next[sym] || {};
          const merged = { ...prevRow, ...row, symbol: sym };
          for (const k of ["price", "change24h", "volume24h", "liquidity"]) {
            if (row?.[k] == null && prevRow?.[k] != null) merged[k] = prevRow[k];
          }
          if (!row?.source && prevRow?.source) merged.source = prevRow.source;
          if (!row?.mode && prevRow?.mode) merged.mode = prevRow.mode;
          next[sym] = merged;
        }
        return next;
      });
    } catch (e) {
      setWlErr(String(e?.message || e));
    } finally {
      setWlBusy(false);
    }
  }

  const gridOrdersVisibleAll = useMemo(() => {
    const all = Array.isArray(gridOrders) ? gridOrders : [];
    const hidden = new Set(Array.isArray(gridHiddenIds) ? gridHiddenIds.map(String) : []);
    return all.filter((o) => {
      const oid = o?.id;
      return oid ? !hidden.has(String(oid)) : true;
    });
  }, [gridOrders, gridHiddenIds]);

  const gridCoins = useMemo(() => {
    const arr = (gridOrdersVisibleAll || [])
      .map((o) => String(o?.item || o?.symbol || "").toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(arr));
  }, [gridOrdersVisibleAll]);

  const gridOrdersFiltered = useMemo(() => {
    const visible = gridOrdersVisibleAll || [];
    if (!gridOrdersFilter || gridOrdersFilter === "ALL") return visible;
    const want = String(gridOrdersFilter || "").toUpperCase();
    return visible.filter((o) => String(o?.item || o?.symbol || "").toUpperCase() === want);
  }, [gridOrdersVisibleAll, gridOrdersFilter]);

  const gridOrdersShown = useMemo(() => {
    return (gridOrdersFiltered || []).slice(0, 10);
  }, [gridOrdersFiltered]);


const wlRows = useMemo(() => {
    const bySym = new Map();
    for (const r of wlSnapshots || []) {
      const sym = normalizeSymbol(r?.symbol);
      if (sym) bySym.set(sym, r);
    }

    return (watchlist || []).map((s) => {
      const snap = bySym.get(s);
      const cached = wlCache?.[s];
      if (!snap && cached) return cached;
      if (!snap)
        return {
          symbol: s,
          mode: symbolMap?.[s]?.mode || "market",
          source: "error",
        };

      const merged = { ...(cached || {}), ...snap, symbol: s };
      for (const k of ["price", "change24h", "volume24h", "liquidity"]) {
        if (snap?.[k] == null && cached?.[k] != null) merged[k] = cached[k];
      }
      if (!snap?.source && cached?.source) merged.source = cached.source;
      if (!snap?.mode && cached?.mode) merged.mode = cached.mode;
      return merged;
    });
  }, [watchlist, wlSnapshots, wlCache, symbolMap]);

  const wlMap = useMemo(() => {
    const m = new Map();
    for (const r of wlRows || []) {
      const s = normalizeSymbol(r?.symbol);
      if (s) m.set(s, r);
    }
    return m;
  }, [wlRows]);

  // Auto-sync Resolver inputs so AI never "sticks" to an old DEX item-id (e.g., polygon_tbp_...) by accident.
  // If the current primary/compare input is NOT a known watchlist symbol, we default to the first two symbols in the Watchlist.
  useEffect(() => {
    const items = (watchlist || []).map((x) => normalizeSymbol(x)).filter(Boolean);
    if (!items.length) return;

    const isSym = (x) => {
      const s = normalizeSymbol(x);
      if (!s) return false;
      return Boolean(wlMap.get(s));
    };

    if (!isSym(primaryItemId)) {
      setPrimaryItemId(items[0]);
    }
    if (!isSym(compareItemId)) {
      setCompareItemId(items[Math.min(1, items.length - 1)] || items[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist, wlMap, symbolMap]);



  

  const wlRowsTop10 = useMemo(() => (wlRows || []).slice(0, 10), [wlRows]);
  const wlRowsRest = useMemo(() => (wlRows || []).slice(10), [wlRows]);

  useEffect(() => {
    if (wlMoreSymbol && !(watchlist || []).includes(wlMoreSymbol)) {
      setWlMoreSymbol("");
    }
  }, [watchlist, wlMoreSymbol]);
async function addToWatchlist(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return;

  // Open searchable picker so user can pick the exact token
  setAddPickerErr("");
  setAddPickerTab("market");
  setAddPickerQuery(s);
  setAddPickerOpen(true);
  setAddPickerBusy(true);
  try {
    const r = await jget(`${API}/market/search?query=${encodeURIComponent(s)}`);
    const results = Array.isArray(r?.results) ? r.results : [];
    setAddPickerResults(results);
    if (!results.length) {
      setAddPickerErr("Kein Treffer gefunden. Bitte anderen Namen/Symbol versuchen.");
    }
  } catch (e) {
    setAddPickerErr(String(e?.message || e));
  } finally {
    setAddPickerBusy(false);
  }
}

function addResolvedToWatchlist(coin) {
  if (!coin || !coin.id) return;
  const sym = normalizeSymbol(coin.symbol || addPickerQuery);
  if (!sym) return;

  // Save mapping: symbol -> coingecko id
  setSymbolMap((prev) => ({
    ...prev,
    [sym]: { mode: "market", id: coin.id, name: coin.name || sym },
  }));

  // Add symbol to watchlist
  setWatchlist((prev) => (prev.includes(sym) ? prev : [sym, ...prev]));

  setAddPickerOpen(false);
  setAddPickerResults([]);
  setAddPickerQuery("");
  setWlAddInput("");
}

function addDexToWatchlist() {
  setAddDexErr("");
  const sym = normalizeSymbol(addDexSymbol || addPickerQuery);
  const contract = String(addDexContract || "").trim();
  const chain = String(addDexChain || "").trim();
  if (!sym) return setAddDexErr("Bitte Symbol eingeben (z.B. PEPE).");
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    return setAddDexErr("Contract muss eine gültige EVM-Adresse sein (0x + 40 hex).");
  }

  setSymbolMap((prev) => ({
    ...(prev || {}),
    [sym]: { mode: "dex", contract, chain },
  }));

  setWatchlist((prev) => {
    const arr = Array.isArray(prev) ? prev.slice() : [];
    if (!arr.includes(sym)) arr.unshift(sym);
    return arr;
  });

  setAddPickerOpen(false);
  setAddDexSymbol("");
  setAddDexContract("");
  setAddDexChain("");
  setAddPickerResults([]);
}

  function removeFromWatchlist(sym) {
    const s = normalizeSymbol(sym);
    setWatchlist((prev) => prev.filter((x) => normalizeSymbol(x) !== s));
  }

  // ---------- Resolver interpretation ----------
  function isLikelySymbol(x) {
    const s = normalizeSymbol(x);
    if (!s) return false;
    // Treat any short ticker-like string as symbol (do NOT require watchlist to be loaded)
    if (s.length > 12) return false;
    return /^[A-Z0-9._-]+$/.test(s);
  }

  const primarySymRaw = useMemo(() => normalizeSymbol(primaryItemId), [primaryItemId]);
  const compareSymRaw = useMemo(() => normalizeSymbol(compareItemId), [compareItemId]);

  // These are used for market/live widgets (watchlist snapshot). They remain gated to watchlist to prevent carry-over.
  const primarySym = useMemo(() => {
    const s = primarySymRaw;
    return wlMap.get(s) ? s : "";
  }, [primarySymRaw, wlMap]);

  const compareSym = useMemo(() => {
    const s = compareSymRaw;
    return wlMap.get(s) ? s : "";
  }, [compareSymRaw, wlMap]);

const [marketHealthMap, setMarketHealthMap] = useState(() => ({})); // { SYMBOL: {score,status,reasons,confidence,metrics} }

// Cache only FULL (non-fast) health per symbol so user-mode feels instant on reload.
const HEALTH_FULL_CACHE_PREFIX = "na_health_full_v1_";
const HEALTH_FULL_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h

function readFullHealthCache(symbol) {
  try {
    const S = normalizeSymbol(symbol);
    if (!S) return null;
    const raw = localStorage.getItem(`${HEALTH_FULL_CACHE_PREFIX}${S}`);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (obj.ts && Date.now() - obj.ts > HEALTH_FULL_CACHE_MAX_AGE_MS) return null;
    return obj.data && typeof obj.data === "object" ? obj.data : null;
  } catch {
    return null;
  }
}

function writeFullHealthCache(symbol, data) {
  try {
    const S = normalizeSymbol(symbol);
    if (!S || !data || typeof data !== "object") return;
    localStorage.setItem(`${HEALTH_FULL_CACHE_PREFIX}${S}`, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore
  }
}

function mergeMarketHealth(prev, incoming, fast) {
  if (!incoming || typeof incoming !== "object") return prev;
  if (!prev || typeof prev !== "object") return incoming;

  if (!fast) return incoming; // full fetch wins

  // FAST fetch should NOT wipe multi-day context (trend/drawdown) from a previous FULL fetch.
  const prevMetrics = prev.metrics || {};
  const inMetrics = incoming.metrics || {};
  const hasPrevMultiDay =
    prevMetrics.trend30d != null ||
    prevMetrics.trend180d != null ||
    prevMetrics.maxDrawdown180d != null ||
    prevMetrics.drawdown180d != null;

  const hasIncomingMultiDay =
    inMetrics.trend30d != null ||
    inMetrics.trend180d != null ||
    inMetrics.maxDrawdown180d != null ||
    inMetrics.drawdown180d != null;

  const merged = { ...prev, ...incoming };

  // Preserve multi-day metrics if FAST doesn't provide them.
  if (hasPrevMultiDay && !hasIncomingMultiDay) {
    merged.metrics = { ...inMetrics, ...prevMetrics };
    // Keep the FULL score to avoid "reset to 65" behaviour
    if (Number.isFinite(Number(prev.score))) merged.score = prev.score;

    // Merge reasons: keep previous non-24h reasons, then take incoming 24h-ish reasons.
    const prevReasons = Array.isArray(prev.reasons) ? prev.reasons : [];
    const inReasonsArr = Array.isArray(incoming.reasons) ? incoming.reasons : [];
    const keep = prevReasons.filter((s) => typeof s === "string" && !/\b24h\b/i.test(s));
    const add = inReasonsArr.filter((s) => typeof s === "string" && /\b24h\b/i.test(s));
    merged.reasons = [...keep, ...add].slice(0, 12);
  }

  return merged;
}

async function fetchMarketHealth(symbol, opts = {}) {
  const S = normalizeSymbol(symbol);
  if (!S) return null;
  const fast = opts.fast !== undefined ? !!opts.fast : true;

  try {
    const url = fast
      ? `${API}/health/market?fast=1&symbol=${encodeURIComponent(S)}`
      : `${API}/health/market?symbol=${encodeURIComponent(S)}`;

    const r = await jget(url);
    const data = r?.data || r; // backend may wrap as {status:'ok',data:{...}}

    if (data && typeof data === "object") {
      setMarketHealthMap((prev) => {
        const prevFor = (prev || {})[S];
        const nextFor = mergeMarketHealth(prevFor, data, fast);
        return { ...(prev || {}), [S]: nextFor };
      });

      if (!fast) writeFullHealthCache(S, data);
      return data;
    }
  } catch {
    // ignore: fallback will show existing/empty
  }

  return null;
}

  const AUTO_HEALTH_POLL = false; // health auto-fetch disabled; use manual refresh button


async function refreshSelectedHealthNow() {
  // Manual refresh: fetch LIVE health only for Primary + Compare symbols (max 2 requests)
  const syms = [primarySymRaw, compareSymRaw].filter((s) => validateSymbol(s));
  if (!syms.length) return;
  if (healthRefreshBusy) return;
  setHealthRefreshBusy(true);
  try {
    // FAST refresh first, then FULL refresh in background
    for (const s of syms) await fetchMarketHealth(s, { fast: true });
    setTimeout(() => {
      for (const s of syms) fetchMarketHealth(s, { fast: false });
    }, 50);
  } finally {
    // Let UI breathe a bit (avoid double-click storms)
    setTimeout(() => setHealthRefreshBusy(false), 600);
  }
}

// Derived "live" for SYMBOL mode (from watchlist cache)
  const derivedPrimaryLive = useMemo(() => {
    if (!primarySym) return null;
    const r = wlMap.get(primarySym);
    if (!r) return null;
    return {
      price: r.price,
      change24h: r.change24h,
      volume24h: r.volume24h,
      liquidity: r.liquidity,
      source: r.source || r.mode || "watchlist",
      symbol: primarySym,
      mode: r.mode || "market",
    };
  }, [primarySym, wlMap]);

  const derivedCompareLive = useMemo(() => {
    if (!compareSym) return null;
    const r = wlMap.get(compareSym);
    if (!r) return null;
    return {
      price: r.price,
      change24h: r.change24h,
      volume24h: r.volume24h,
      liquidity: r.liquidity,
      source: r.source || r.mode || "watchlist",
      symbol: compareSym,
      mode: r.mode || "market",
    };
  }, [compareSym, wlMap]);

  
    // ===== Market Health (server-side) =====
  // On symbol change:
  // 1) hydrate UI instantly from FULL-cache (if available)
  // 2) fetch FAST immediately (quick 24h metrics)
  // 3) fetch FULL in background (multi-day trend/drawdown), then cache it
  useEffect(() => {
    const syms = [primarySymRaw, compareSymRaw].filter((s) => validateSymbol(s));
    if (!syms.length) return;

    // 1) Instant hydrate from cache
    setMarketHealthMap((prev) => {
      const next = { ...(prev || {}) };
      for (const s of syms) {
        const cached = readFullHealthCache(s);
        if (cached && typeof cached === "object") next[normalizeSymbol(s)] = cached;
      }
      return next;
    });

    if (!AUTO_HEALTH_POLL) {
      // Only hydrate from cache unless user manually refreshes.
      return;
    }

    // 2) FAST right away (does not wipe multi-day context due to mergeMarketHealth)
    for (const s of syms) fetchMarketHealth(s, { fast: true });

    // 3) FULL in background (don’t block UI)
    const t = setTimeout(() => {
      for (const s of syms) fetchMarketHealth(s, { fast: false });
    }, 50);

    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primarySymRaw, compareSymRaw]);

  // Refresh market health occasionally (not as often as prices)
  useEffect(() => {
    if (!AUTO_HEALTH_POLL) return;
    const t = setInterval(() => {
      if (validateSymbol(primarySymRaw)) fetchMarketHealth(primarySymRaw, { fast: true });
      if (validateSymbol(compareSymRaw)) fetchMarketHealth(compareSymRaw, { fast: true });
    }, 180_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primarySymRaw, compareSymRaw]);

  const derivedPrimaryHealth = useMemo(() => {
    if (!validateSymbol(primarySymRaw)) return null;
    const S = normalizeSymbol(primarySymRaw);
    return marketHealthMap?.[S] || null;
  }, [primarySymRaw, marketHealthMap]);

  const derivedCompareHealth = useMemo(() => {
    if (!validateSymbol(compareSymRaw)) return null;
    const S = normalizeSymbol(compareSymRaw);
    return marketHealthMap?.[S] || null;
  }, [compareSymRaw, marketHealthMap]);

// Effective live/health used by UI + AI
  const effectiveLive = primarySym ? derivedPrimaryLive : live;
  const effectiveCompareLive = compareSym ? derivedCompareLive : null;
  const effectiveHealth = primarySym ? derivedPrimaryHealth : healthScore;
  const effectiveCompareHealth = compareSym ? derivedCompareHealth : compareHealthScore;

  const scoreDiff =
    effectiveCompareHealth?.score != null && effectiveHealth?.score != null
      ? Number(effectiveCompareHealth.score) - Number(effectiveHealth.score)
      : null;

  // Reset last-good refs when user changes primary/compare "identity"
  useEffect(() => {
    const key = `${primaryItemId || ""}||${pairOrContract || ""}`;
    if (key !== lastPrimaryKeyRef.current) {
      lastPrimaryKeyRef.current = key;

      // Market-mode is derived from watchlist; no last-good reset needed here.
      if (!isLikelySymbol(primaryItemId)) {
        setLive(null);
        setHealthScore(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryItemId, pairOrContract]);

  useEffect(() => {
    const key = compareDexKey;
    if (key !== lastCompareKeyRef.current) {
      lastCompareKeyRef.current = key;
      if (compareItemId && !isLikelySymbol(compareItemId)) {
        setCompareHealthScore(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareDexKey, compareItemId]);
// ===== Main refresh =====
  async function refreshAll() {
    setErr("");
    setBusy(true);
    try {
      if (primarySym) {
        await refreshWatchlist();
        setBusy(false);
        return;
      }

      const primaryHealthUrl = primaryItemId
        ? `${API}/health?item=${encodeURIComponent(primaryItemId)}${
            pairOrContract ? `&pairOrContract=${encodeURIComponent(pairOrContract)}` : ""
          }`
        : `${API}/health`;

      const [hRes, lRes] = await Promise.allSettled([
        jget(primaryHealthUrl),
        jget(
          `${API}/watchlist/live?item=${encodeURIComponent(primaryItemId || "")}${
            pairOrContract ? `&pairOrContract=${encodeURIComponent(pairOrContract)}` : ""
          }`
        ),
      ]);

      const h = hRes.status === "fulfilled" ? hRes.value : null;
      const l = lRes.status === "fulfilled" ? lRes.value : null;

      if (h) {
        setHealthScore(h);
        lastHealthByKeyRef.current[primaryDexKey] = h;
      } else {
        const cached = lastHealthByKeyRef.current[primaryDexKey];
        if (cached) setHealthScore(cached);
      }

      if (l) {
        setLive(l);
        lastLiveByKeyRef.current[primaryDexKey] = l;
      } else {
        const cached = lastLiveByKeyRef.current[primaryDexKey];
        if (cached) setLive(cached);
      }

      if (compareItemId && !compareSym) {
        const chRes = await Promise.allSettled([
          jget(
            `${API}/health?item=${encodeURIComponent(compareItemId)}${
              pairOrContract ? `&pairOrContract=${encodeURIComponent(pairOrContract)}` : ""
            }`
          ),
        ]);
        const ch = chRes[0]?.status === "fulfilled" ? chRes[0].value : null;

        if (ch) {
          setCompareHealthScore(ch);
          lastCompareHealthByKeyRef.current[compareDexKey] = ch;
        } else {
          const cached = lastCompareHealthByKeyRef.current[compareDexKey];
          if (cached) setCompareHealthScore(cached);
        }
      } else if (!compareItemId) {
        setCompareHealthScore(null);
              } else {
        setCompareHealthScore(null);
              }
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  
  useEffect(() => {
    if (!gridSelectedItem && primaryItemId) setGridSelectedItem(primaryItemId);
  }, [primaryItemId]);

// ===== Grid controls =====

  async function loadAllGridOrders() {
    try {
      const r = await jget(`${API}/grid/orders`);
      // Backend returns { orders: [...] } (and may include extra metadata).
      setGridOrders(Array.isArray(r?.orders) ? r.orders : []);
    } catch (e) {
      // do not hard-fail UI; surface in toast
      setErr(String(e?.message || e));
    }

  // Load existing grid orders on page load and keep UI in sync even after a browser refresh.
  }
  // Load existing grid orders on page load.
  useEffect(() => {
    loadAllGridOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  
  // Poll grid orders only when there are *active* (running/open) orders.
  // This prevents /grid/orders flooding when there are no real orders (or only hidden/stopped ones).
  useEffect(() => {
    const orders = Array.isArray(gridOrders) ? gridOrders : [];
    const hiddenSet = new Set(Array.isArray(gridHiddenIds) ? gridHiddenIds.map(String) : []);
  
    const isActiveOrder = (o) => {
      const id = o?.id != null ? String(o.id) : "";
      if (id && hiddenSet.has(id)) return false;
      const status = String(o?.status || o?.state || o?.phase || "").toUpperCase();
      const running = (o?.running ?? o?.is_running ?? o?.active ?? o?.isActive ?? null);
      if (running === true) return true;
      if (running === false) return false;
      if (!status) return true; // unknown => treat as active to stay synced
      if (status.includes("STOP") || status.includes("DONE") || status.includes("FILLED") || status.includes("CANCEL")) return false;
      return true;
    };
  
    const shouldPoll = orders.some(isActiveOrder);
    if (!shouldPoll) return;
  
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      if (ordersPollInFlight.current) return;
      ordersPollInFlight.current = true;
      try {
        await loadAllGridOrders();
      } finally {
        ordersPollInFlight.current = false;
      }
    };
  
    // Run once immediately, then poll slowly (user build friendly).
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridOrders, gridHiddenIds]);

  async function stopSingleOrder(order) {
    if (!order?.id) return;
    const item = String(order?.item || "").trim();
    if (!item) return;
    try {
      await jpost(`${API}/grid/order/stop`, {
        item,
        id: order?.id || null,
        side: order?.side || null,
        price: order?.price ?? null,
        level: order?.level ?? null,
      });
      await loadAllGridOrders();
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }
  function removeOrderFromUI(order) {
    const oid = order?.id;
    if (!oid) return;
    setGridHiddenIds((prev) => {
      const s = new Set(Array.isArray(prev) ? prev.map(String) : []);
      s.add(String(oid));
      return Array.from(s);
    });
  }

  function removeCoinFromUI(coin) {
    const want = String(coin || "").toUpperCase();
    if (!want) return;
    setGridHiddenIds((prev) => {
      const s = new Set(Array.isArray(prev) ? prev.map(String) : []);
      (Array.isArray(gridOrders) ? gridOrders : []).forEach((o) => {
        if (String(o?.item || o?.symbol || "").toUpperCase() === want && o?.id && String(o?.status || "").toUpperCase() !== "OPEN") s.add(String(o.id));
      });
      return Array.from(s);
    });
  }


  async function startGrid() {
    setErr("");
    setBusy(true);
    try {
      const gridItem = (gridSelectedItem || primaryItemId || "").trim();
      if (!gridItem) throw new Error("Missing primary item id for grid");

      const p = Number(effectiveLive?.price);
      const livePrice = Number.isFinite(p) ? p : null;

      const r = await jpost(`${API}/grid/start`, {
        mode,
        item: gridItem,
        order_mode: gridOrderMode,
        initial_capital_usd: (gridOrderMode === "AUTO" ? autoInvestUsd : demoInvestUsd),
        pairOrContract: pairOrContract || "",
        price: livePrice,
      });

      setSession("RUNNING");
      await loadAllGridOrders();
      setGridFills(r?.fills || []);
      setGridMeta({
        tick: r?.tick || 0,
        pnl: r?.pnl || null,
        pnl: r?.pnl || null,
        price: r?.price || livePrice,
        price_source: livePrice != null ? "frontend" : "snapshot",
        filled_now: 0,
        note: null,
      });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function tickGrid() {
    setErr("");
    setBusy(true);
    try {
      const gridItem = (gridSelectedItem || primaryItemId || "").trim();
      if (!gridItem) throw new Error("Missing primary item id for grid");

      const p = Number(effectiveLive?.price);
      const livePrice = Number.isFinite(p) ? p : null;

      const r = await jpost(`${API}/grid/tick`, {
        item: gridItem,
        price: livePrice,
      });

      setSession("RUNNING");
      await loadAllGridOrders();
      setGridFills(r?.fills || []);
      setGridMeta({
      tick: r?.tick,
      price: (r?.price ?? livePrice ?? gridMeta?.price ?? null),
      price_source: (r?.price_source ?? (livePrice ? "frontend" : "cache")),
      filled_now: r?.filled_now,
      note: r?.note,
    });

    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
  async function stopGrid() {
    setErr("");
    setBusy(true);
    try {
      const gridItem = (gridSelectedItem || primaryItemId || "").trim();
      if (!gridItem) throw new Error("Missing primary item id for grid");

      // stop autorun if active
      try {
        await jpost(`${API}/grid/autorun`, { item: gridItem, enable: false });
      } catch (_) {}

      await jpost(`${API}/grid/stop`, { item: gridItem });

      setAutoRun(false);
      setSession("STOPPED");
      await loadAllGridOrders();
      setGridMeta(null);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutorun(next) {
    setErr("");
    setBusy(true);
    try {
      const gridItem = (gridSelectedItem || primaryItemId || "").trim();
      if (!gridItem) throw new Error("Missing primary item id for grid");

      const enable = typeof next === "boolean" ? next : !autoRun;
      const interval = Number(autoInterval);
      await jpost(`${API}/grid/autorun`, {
        item: gridItem,
        enable,
        interval: Number.isFinite(interval) ? interval : 10,
      });
      setAutoRun(enable);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  
async function addManualOrder() {
  setErr("");
  setBusy(true);
  try {
    const gridItem = (gridSelectedItem || primaryItemId || "").trim();
    if (!gridItem) throw new Error("Missing primary item id for grid");

    const price = Number(manualPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Manual price must be a number > 0");

    const qtyNum = manualQty !== "" ? Number(manualQty) : null;
    if (qtyNum !== null && (!Number.isFinite(qtyNum) || qtyNum <= 0)) throw new Error("Qty must be > 0");

    const payload = {
      item: gridItem,
      ttl_s: ttlToSeconds(manualTTL, manualTTLUnit),
      side: manualSide,
      price,
      qty: qtyNum,
      amount: qtyNum,              // some backends use "amount" instead of "qty"
      order_mode: "MANUAL",
      confirm: mode === "AGGRESSIVE" ? "YES" : undefined,
    };

    // Try the common backend routes (we stop on the first 2xx).
    // IMPORTANT: We only skip on 404 (route missing). For 400/500 we surface the real error.
    const tryUrls = [
      `${API}/grid/manual/add`,
      `${API}/grid/add`,
      `${API}/grid/order/add`,
      `${API}/add`,
      `${API}/grid/manual`,
    ];

    let lastErr = null;
    let ok = null;
    for (const url of tryUrls) {
      try {
        ok = await jpost(url, payload);
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        // jpost throws with "404 ..." text (see jpost implementation)
        if (/^404\b/.test(msg) || /\b404\b/.test(msg)) {
          lastErr = e;
          continue; // try next candidate
        }
        throw e; // real validation / server error
      }
    }
    if (!ok) {
      throw new Error(`Manual Add failed: route not found (tried: ${tryUrls.map(u=>u.replace(API,"<API>")).join(", ")})`);
    }

    await loadAllGridOrders();
    setManualPrice("");
    setManualQty("");
  } catch (e) {
    setErr(String(e?.message || e));
  } finally {
    setBusy(false);
  }
}

// initial load
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic watchlist refresh (keeps prices alive)
  useEffect(() => {
    refreshWatchlist();
    const t = setInterval(() => refreshWatchlist(), 120_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolMap]);

  // ===== AI (Render) — FIXED / NO TBP LEAK =====
  // IMPORTANT:
  // Your Render AI endpoint currently tends to answer with TBP numbers even when you send ETH/BTC.
  // To guarantee correctness, for MARKET symbols (ETH/BTC/BNB/XRP/SOL etc.) we generate the "Quick Overview"
  // locally from the Watchlist snapshot + Health heuristic. For DEX item-ids, we still call Render AI.

  // ===== AI (via Backend → TBP-Advisor) =====
  // Rules we enforce in the frontend:
  // - Quick Buttons: medium length, NO prices, NO % values, NO trade levels, NO invented metrics/scores.
  // - Ask AI: can be longer, but MUST stay strictly within provided context data (no hallucinations).
  // - Language: Quick Buttons follow the last Ask AI input language (default EN). Ask AI follows the current input language.
  function detectLang(s) {
    const t = String(s || "").trim();
    if (!t) return "en";
    // lightweight heuristic: if it contains common German words/umlauts → de
    const deHints = /\b(und|oder|aber|weil|dass|nicht|was|wie|warum|bitte|kann|soll|würde|für|mit|ohne)\b|[äöüß]/i;
    return deHints.test(t) ? "de" : "en";
  }
  function level3(x, { low, high }) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "unknown";
    if (n < low) return "low";
    if (n > high) return "high";
    return "medium";
  }
  function sign3(x, eps = 0.15) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "unknown";
    if (n > eps) return "up";
    if (n < -eps) return "down";
    return "flat";
  }

  const [lastAskLang, setLastAskLang] = useState(() => "en");

  async function askAi(kind) {
    const userQ = String(aiPrompt || "").trim();

    // Defaults so Quick Buttons work even when the Ask field is empty
    const defaultQ =
      kind === "Quick Overview"
        ? "Give a quick overview for the selected assets."
        : kind === "Risk Check"
        ? "Run a risk check for the selected assets."
        : kind === "Volume Breakdown"
        ? "Explain what the current volume implies for grid fills."
        : kind === "LP Stress Test"
        ? "Simulate a liquidity stress scenario impact on a grid."
        : "Explain what the data suggests and how a grid behaves in this situation.";

    // Language rules:
    // - Ask AI uses the language of the current input
    // - Quick Buttons use the last Ask AI input language (default EN)
    const askLangNow = detectLang(userQ);
    const outLang = kind === "General" ? askLangNow : (lastAskLang || "en");

    // Update lastAskLang ONLY when user clicks Ask AI (General)
    if (kind === "General") setLastAskLang(askLangNow);

    // Best-effort refresh for selected symbols (do not block AI)
    refreshWatchlist([primarySym, compareSym].filter(Boolean)).catch(() => {});

    const pIsMarket = Boolean(primarySym);
    const cIsMarket = Boolean(compareSym);

    const pRow = pIsMarket ? wlMap.get(primarySym) : null;
    const cRow = cIsMarket ? wlMap.get(compareSym) : null;

    // Market health is fetched from backend (/api/health/market)
    const pHealth = pIsMarket ? (marketHealthMap?.[primarySym] || null) : (effectiveHealth || null);
    const cHealth = cIsMarket ? (marketHealthMap?.[compareSym] || null) : (effectiveCompareHealth || null);

    // Signals for Quick Buttons (qualitative; avoids showing raw numbers)
    const primarySignals = {
      trend24h: sign3(pIsMarket ? pRow?.change24h : effectiveLive?.change24h),
      volumeLevel: level3(pIsMarket ? pRow?.volume24h : effectiveLive?.volume24h, { low: 50_000_000, high: 1_000_000_000 }),
      liquidityLevel: level3(pIsMarket ? pRow?.liquidity : effectiveLive?.liquidity, { low: 500_000, high: 10_000_000 }),
      healthStatus: pHealth?.status || null,
      healthReasons: Array.isArray(pHealth?.reasons) ? pHealth.reasons.slice(0, 5) : [],
      mode: pIsMarket ? "market" : "dex",
    };
    const compareSignals = compareItemId
      ? {
          trend24h: sign3(cIsMarket ? cRow?.change24h : null),
          volumeLevel: level3(cIsMarket ? cRow?.volume24h : null, { low: 50_000_000, high: 1_000_000_000 }),
          liquidityLevel: level3(cIsMarket ? cRow?.liquidity : null, { low: 500_000, high: 10_000_000 }),
          healthStatus: cHealth?.status || null,
          healthReasons: Array.isArray(cHealth?.reasons) ? cHealth.reasons.slice(0, 5) : [],
          mode: cIsMarket ? "market" : "dex",
        }
      : null;

    const context = {
      kind,
      language: outLang,
      // raw numeric snapshot (Ask AI may use, Quick Buttons must not print numbers)
      primary: pIsMarket
        ? {
            id: primarySym,
            mode: "market",
            price: Number(pRow?.price) || null,
            change24h: isFinite(Number(pRow?.change24h)) ? Number(pRow?.change24h) : null,
            volume24h: isFinite(Number(pRow?.volume24h)) ? Number(pRow?.volume24h) : null,
            liquidity: isFinite(Number(pRow?.liquidity)) ? Number(pRow?.liquidity) : null,
            health: pHealth || null,
          }
        : {
            id: primaryItemId || "-",
            mode: "dex",
            price: effectiveLive?.price ?? null,
            change24h: effectiveLive?.change24h ?? null,
            volume24h: effectiveLive?.volume24h ?? null,
            liquidity: effectiveLive?.liquidity ?? null,
            fdv: effectiveLive?.fdv ?? null,
            marketCap: effectiveLive?.marketCap ?? null,
            health: pHealth || null,
          },
      compare: compareItemId
        ? cIsMarket
          ? {
              id: compareSym,
              mode: "market",
              price: Number(cRow?.price) || null,
              change24h: isFinite(Number(cRow?.change24h)) ? Number(cRow?.change24h) : null,
              volume24h: isFinite(Number(cRow?.volume24h)) ? Number(cRow?.volume24h) : null,
              liquidity: isFinite(Number(cRow?.liquidity)) ? Number(cRow?.liquidity) : null,
              health: cHealth || null,
            }
          : {
              id: compareItemId,
              mode: "dex",
              health: cHealth || null,
            }
        : null,
      // qualitative signals (preferred for Quick Buttons)
      signals: {
        primary: { id: pIsMarket ? primarySym : (primaryItemId || "-"), ...primarySignals },
        compare: compareItemId ? { id: cIsMarket ? compareSym : compareItemId, ...compareSignals } : null,
      },
    };

    // Build strict instructions per button
    const baseRulesEN = [
      "Use ONLY the provided CONTEXT_JSON. Do NOT use outside knowledge.",
      "Do NOT invent metrics (no 'liquidity score', no 'confidence score' unless explicitly present in context.health).",
      "If a value is null/missing, say 'data not available'.",
      "No financial advice. No buy/sell instructions.",
    ];
    const baseRulesDE = [
      "Nutze AUSSCHLIESSLICH das CONTEXT_JSON. Kein Außenwissen.",
      "Erfinde keine Metriken (kein 'liquidity score', kein 'confidence score', außer es steht explizit in context.health).",
      "Wenn ein Wert fehlt/null ist, schreibe 'Data not available'.",
      "Keine Finanzberatung. Keine Buy/Sell-Anweisungen.",
    ];

    const rules = outLang === "de" ? baseRulesDE : baseRulesEN;

    const quickCommon = outLang === "de"
      ? [
          "Für Quick-Buttons: KEINE Zahlen ausgeben (keine Preise, keine %, keine Volumen-Zahlen).",
          "Nutze stattdessen die qualitativen Signale: trend24h (up/down/flat), volumeLevel (low/medium/high), liquidityLevel (low/medium/high), healthStatus + healthReasons.",
          (aiVerbosity === "concise" ? "Länge: kurz (max ~120 Wörter)." : "Länge: mittel (ca. 8–12 Zeilen)."),
          "Format: Bulletpoints, klar getrennt für A und B (falls Compare vorhanden).",
          "Am Ende IMMER 1 Disclaimer-Satz: 'Educational overview only. Not financial advice.'",
        ]
      : [
          "For Quick Buttons: DO NOT output numbers (no prices, no % values, no raw volume numbers).",
          "Use the qualitative signals only: trend24h (up/down/flat), volumeLevel (low/medium/high), liquidityLevel (low/medium/high), healthStatus + healthReasons.",
          (aiVerbosity === "concise" ? "Length: short (max ~120 words)." : "Length: medium (about 8–12 lines)."),
          "Format: bullet points; clearly separate Asset A and Asset B (if compare).",
          "Always end with exactly one disclaimer sentence: 'Educational overview only. Not financial advice.'",
        ];

    const askAiRules = outLang === "de"
      ? [
          (aiVerbosity === "concise" ? "Antwortlänge: kurz & prägnant (max ~180 Wörter)." : "Antwortlänge: ausführlicher (bis ~350 Wörter)."),
          "Ask AI darf ausführlich sein, aber NUR auf Basis des CONTEXT_JSON.",
          "Du darfst Zahlen aus context.primary/compare verwenden (z.B. price, change24h, volume24h), aber nur wenn sie nicht null sind.",
          "Keine erfundenen Scores. Keine Empfehlungen, keine Trade-Anweisungen.",
          "Am Ende IMMER 1 Disclaimer-Satz: 'Educational overview only. Not financial advice.'",
        ]
      : [
          (aiVerbosity === "concise" ? "Answer length: concise (max ~180 words)." : "Answer length: detailed (up to ~350 words)."),
          "Ask AI can be detailed, but ONLY based on CONTEXT_JSON.",
          "You may reference numeric fields from context.primary/compare (price/change24h/volume24h) ONLY if they are not null.",
          "No invented scores. No recommendations or trade instructions.",
          "Always end with exactly one disclaimer sentence: 'Educational overview only. Not financial advice.'",
        ];

    const promptByKind = (() => {
      const a = context.signals.primary?.id || "A";
      const b = context.signals.compare?.id || "B";

      if (kind === "Quick Overview") {
        return (outLang === "de"
          ? `Erstelle einen kurzen Überblick (Quick Overview) für A und ggf. B.
` +
            `A: ${a}
` +
            (context.signals.compare ? `B: ${b}
` : "") +
            `Inhalte: Marktcharakter + Grid-Eignung (qualitativ), keine Zahlen.
` +
            `
Regeln:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`
          : `Create a Quick Overview for A and (if present) B.
` +
            `A: ${a}
` +
            (context.signals.compare ? `B: ${b}
` : "") +
            `Content: market character + grid suitability (qualitative), no numbers.
` +
            `
Rules:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`);
      }

      if (kind === "Risk Check") {
        return (outLang === "de"
          ? `Führe einen Risk Check für A und ggf. B durch.
` +
            `Nur Risiken und worauf man achten sollte (Grid-spezifisch). Keine Zahlen.
` +
            `
Regeln:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`
          : `Run a Risk Check for A and (if present) B.
` +
            `Only risks and what to watch (grid-specific). No numbers.
` +
            `
Rules:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`);
      }

      if (kind === "Volume Breakdown") {
        return (outLang === "de"
          ? `Erkläre Volume Breakdown für A und ggf. B.
` +
            `Fokus: Aktivität + Fill-Verhalten (qualitativ). Keine Zahlen.
` +
            `
Regeln:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`
          : `Explain a Volume Breakdown for A and (if present) B.
` +
            `Focus: activity + fill behavior (qualitative). No numbers.
` +
            `
Rules:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`);
      }

      if (kind === "LP Stress Test") {
        return (outLang === "de"
          ? `Führe einen LP Stress Test für A und ggf. B durch.
` +
            `Fokus: Liquiditätsstress-Szenarien + Auswirkungen auf Grid (qualitativ). Keine Zahlen.
` +
            `
Regeln:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`
          : `Run an LP Stress Test for A and (if present) B.
` +
            `Focus: liquidity stress scenarios + grid impact (qualitative). No numbers.
` +
            `
Rules:
- ${rules.join("\n- ")}
- ${quickCommon.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`);
      }

      // Ask AI (General)
      return (outLang === "de"
        ? `Beantworte die Nutzerfrage ausführlich, aber strikt nur mit den Daten aus CONTEXT_JSON.
` +
          `User question: ${userQ || defaultQ}
` +
          `
Regeln:
- ${rules.join("\n- ")}
- ${askAiRules.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`
        : `Answer the user's question in detail, but strictly only using CONTEXT_JSON data.
` +
          `User question: ${userQ || defaultQ}
` +
          `
Rules:
- ${rules.join("\n- ")}
- ${askAiRules.join("\n- ")}

CONTEXT_JSON:
${JSON.stringify(context)}`);
    })();

    setAiBusy(true);
    try {
      const r = await fetchJsonWithTimeout(
        `${API}/ai`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            mode: kind === "General" ? "chat" : "analysis",
            question: promptByKind,
            context,
            wallet_address: walletAddress || "",
          }),
        },
        20000
      );

      const answer = String(r?.answer || "").trim();
      setAiAnswer(answer || (outLang === "de" ? "No answer." : "No answer."));
    } catch (e) {
      setAiAnswer(`AI error: ${String(e?.message || e)}`);
    } finally {
      setAiBusy(false);
    }
  }

  const healthOk = ["Strong", "Healthy"].includes(effectiveHealth?.status);


  const compareOk = ["Strong", "Healthy"].includes(effectiveCompareHealth?.status);

  return (
    <div className="app">
      <div className="topbar">
        <NexusLogo />
        <div className="statusRow">
          {DEV_MODE && (
            <>
          <Badge ok={busy ? null : true}>{busy ? "busy" : "ready"}</Badge>
          <Badge ok={session === "IDLE" ? null : healthOk}>
            {session.toLowerCase()}
          </Badge>

          {/* Wallet */}
          <Badge ok={walletAddress ? true : null}>
            {walletAddress ? `wallet: ${shortAddr(walletAddress)}` : "wallet: not connected"}
          </Badge>
          <Badge ok={isAuthed ? true : null}>{isAuthed ? "auth: ok" : "auth: off"}</Badge>

                      </>
          )}

        {DEV_MODE && (
<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {!walletAddress ? (
              <>
                <button className="modeBtn" onClick={() => connectWallet("injected")} disabled={walletBusy}>
                  Connect (MetaMask)
                </button>
                <button className="modeBtn" onClick={() => connectWallet("walletconnect")} disabled={walletBusy}>
                  WalletConnect
                </button>
              </>
            ) : (
              <>
                {!isAuthed ? (
                  <button className="modeBtn" onClick={signInBackend} disabled={walletBusy}>
                    Sign-in
                  </button>
                ) : (
                  <button className="modeBtn" onClick={logout} disabled={walletBusy}>
                    Logout
                  </button>
                )}
                <button className="modeBtn" onClick={disconnectWallet} disabled={walletBusy}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {err ? <div className="toast">{err}</div> : null}

      {walletErr ? <div className="toast">{walletErr}</div> : null}

      {/* Terms / Disclaimer Gate (first-run) */}
      {termsOpen ? (
        <div className="modalBackdrop" onClick={(e) => e.preventDefault()}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Terms & Disclaimer</div>
              <Badge ok={null}>Educational</Badge>
            </div>

            <div className="muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
              This app is <b>educational</b> and (in Free) <b>simulation only</b>. It does not provide financial advice. You are responsible
              for your decisions and any outcomes. No guarantees.
            </div>

            <div style={{ marginTop: 12 }}>
              <Collapsible title="Read more">
                <div className="muted" style={{ lineHeight: 1.55 }}>
                  • No buy/sell instructions are provided.<br />
                  • Any “grid behaviour” references are conceptual and educational.<br />
                  • Market/DEX data can be incomplete, delayed, or inaccurate.<br />
                  • By continuing, you confirm you understand these limitations.
                </div>
              </Collapsible>
            </div>

            <div className="row" style={{ gap: 10, marginTop: 12, alignItems: "flex-start" }}>
              <input type="checkbox" checked={termsChecked} onChange={(e) => setTermsChecked(e.target.checked)} style={{ marginTop: 3 }} />
              <div>
                <div style={{ fontWeight: 700 }}>I understand this is educational & simulation only (Free) and not financial advice.</div>
                {termsErr ? <div className="muted" style={{ marginTop: 6, color: "rgba(255,140,140,.95)" }}>{termsErr}</div> : null}
              </div>
            </div>

            <div className="row" style={{ gap: 10, marginTop: 14, justifyContent: "flex-end", flexWrap: "wrap" }}>
             <button className="modeBtn" onClick={acceptTerms} disabled={!termsChecked}>
               Accept & Continue
             </button>

             {canInstall && (
              <button className="modeBtn" onClick={installApp}>
                 Install App
              </button>
            )}
          </div>

          </div>
        </div>
      ) : null}

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} content={helpContent} />



      <div className="grid">
        <Card title="Resolver">
          <div className="field">
            {/* label */}<LabelWithHelp text="Primary item id" helpKey="resolver_primary" onHelp={openHelp} />
            <input
              className="input mono"
              value={primaryItemId}
              onChange={(e) => setPrimaryItemId(e.target.value)}
              placeholder="polygon_weth_usdc_quicksw or ETH"
            />
            {/* User-facing: keep Resolver clean (no internal/backend hints). */}
          </div>

          {DEV_MODE ? (
            <div className="field">
              <div className="label">Optional: pair / contract</div>
              <input
                className="input mono"
                value={pairOrContract}
                onChange={(e) => setPairOrContract(e.target.value)}
                placeholder="optional (if your backend use)"
              />
            </div>
          ) : null}


          <div className="field">
            {/* label */}<LabelWithHelp text="Optional: Compare item (A vs B)" helpKey="resolver_compare" onHelp={openHelp} />
            <input
              className="input mono"
              value={compareItemId}
              onChange={(e) => setCompareItemId(e.target.value)}
              placeholder="e.g. BTC or polygon_tbp_weth_sush"
            />
          </div>
        
<div className="field">
  <LabelWithHelp text="Compare set (select up to 20 from watchlist)" helpKey="resolver_compare_set" onHelp={openHelp} />
  <div className="chipsRow" style={{ marginTop: 10, flexWrap: "wrap" }}>
    {(watchlist || []).map((sym) => {
      const s = String(sym).toUpperCase();
      const checked = resolverCompareSet.includes(s);
      return (
        <label key={s} className="chipCheck" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => {
              setResolverCompareSet((prev) => {
                const has = prev.includes(s);
                if (has) return prev.filter((x) => x !== s);
                if (prev.length >= 20) return prev; // hard limit
                return [...prev, s];
              });
            }}
          />
          <span className="mono">{s}</span>
        </label>
      );
    })}
  </div>

  <div className="muted" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5 }}>
    Tip: Select coins here to compare them. Choose 7/30/90 days for a clearer decision for the grid.
  </div>

  <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
    {[7, 30, 90].map((d) => (
      <button
        key={d}
        className={"modeBtn " + (resolverDays === d ? "active" : "")}
        onClick={() => setResolverDays(d)}
      >
        {d}D
      </button>
    ))}
    {resolverHistLoading ? <span className="muted">Loading…</span> : null}
    {resolverHistErr ? <span className="muted" style={{ color: "#fca5a5" }}>{resolverHistErr}</span> : null}
  </div>

  {resolverHist?.series ? (
    <ResolverChart
      seriesById={resolverHist.series}
      ids={Object.keys(resolverHist.series).slice(0, 5)}
    />
  ) : null}

  {resolverCompareSet?.length ? (
    <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
      Selected: <span className="mono">{resolverCompareSet.join(", ")}</span>
    </div>
  ) : null}
</div>
</Card>

        <Card
          title="Live Price (USD)"
          right={DEV_MODE ? (
            <span className="muted">
              Source: {primarySym ? "Watchlist snapshot" : "/api/watchlist/live"}
            </span>
          ) : null}
        >
          <div className="big">
            {effectiveLive?.price != null ? (
              <div>
                <div>
                  <span className="muted">Primary:</span>{" "}
                  <span className="mono">{primarySym || primaryItemId || "-"}</span>{" "}
                  <span style={{ marginLeft: 8 }}>{`$${formatPrice(effectiveLive.price)}`}</span>
                </div>
                {effectiveCompareLive?.price != null ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                    <span style={{ marginLeft: 8 }}>{`$${formatPrice(effectiveCompareLive.price)}`}</span>
                  </div>
                ) : compareSym ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym}</span>{" "}
                    <span className="muted">—</span>
                  </div>
                ) : null}
              </div>
            ) : (
              "—"
            )}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 6 }}>
            <Pill>24h {effectiveLive?.change24h != null ? formatPct(effectiveLive.change24h) : "—"}</Pill>
            <Pill>Vol {effectiveLive?.volume24h != null ? `$${formatUSD(effectiveLive.volume24h)}` : "—"}</Pill>
          </div>
          {primarySym ? (
            <div className="muted" style={{ marginTop: 10 }}>
              Showing market live for <b>{primarySym}</b> from the watchlist cache.
            </div>
          ) : null}
        </Card>

        {(DEV_MODE || !primarySym) ? (
                <Card
          title="LP (now)"
          right={
            <span className="muted">
              Source: {primarySym ? "Watchlist snapshot" : "/api/watchlist/live"}
            </span>
          }
        >
          <div className="big">
            {effectiveLive?.liquidity != null ? (
              <div>
                <div>
                  <span className="muted">Primary:</span>{" "}
                  <span className="mono">{primarySym || primaryItemId || "-"}</span>{" "}
                  <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveLive.liquidity)}`}</span>
                </div>
                {effectiveCompareLive?.liquidity != null ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                    <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveCompareLive.liquidity)}`}</span>
                  </div>
                ) : compareSym || compareItemId ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                    <span className="muted">—</span>
                  </div>
                ) : null}
              </div>
            ) : effectiveCompareLive?.liquidity != null ? (
              <div>
                <div>
                  <span className="muted">Primary:</span>{" "}
                  <span className="mono">{primarySym || primaryItemId || "-"}</span>{" "}
                  <span className="muted">—</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 18 }}>
                  <span className="muted">Compare:</span>{" "}
                  <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                  <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveCompareLive.liquidity)}`}</span>
                </div>
              </div>
            ) : (
              "—"
            )}
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {primarySym
              ? "Market items usually have no LP. Use DEX item ids for LP."
              : "This is liquidity reported by your backend for the selected item."}
          </div>
        </Card>
        ) : null}


        <Card
          title="Volume 24h (now)"
          right={
            <span className="muted">
              Source: {primarySym ? "Watchlist snapshot" : "/api/watchlist/live"}
            </span>
          }
        >
          <div className="big">
            {effectiveLive?.volume24h != null ? (
              <div>
                <div>
                  <span className="muted">Primary:</span>{" "}
                  <span className="mono">{primarySym || primaryItemId || "-"}</span>{" "}
                  <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveLive.volume24h)}`}</span>
                </div>
                {effectiveCompareLive?.volume24h != null ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                    <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveCompareLive.volume24h)}`}</span>
                  </div>
                ) : compareSym || compareItemId ? (
                  <div style={{ marginTop: 8, fontSize: 18 }}>
                    <span className="muted">Compare:</span>{" "}
                    <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                    <span className="muted">—</span>
                  </div>
                ) : null}
              </div>
            ) : effectiveCompareLive?.volume24h != null ? (
              <div>
                <div>
                  <span className="muted">Primary:</span>{" "}
                  <span className="mono">{primarySym || primaryItemId || "-"}</span>{" "}
                  <span className="muted">—</span>
                </div>
                <div style={{ marginTop: 8, fontSize: 18 }}>
                  <span className="muted">Compare:</span>{" "}
                  <span className="mono">{compareSym || compareItemId || "-"}</span>{" "}
                  <span style={{ marginLeft: 8 }}>{`$${formatUSD(effectiveCompareLive.volume24h)}`}</span>
                </div>
              </div>
            ) : (
              "—"
            )}
          </div>
          {/* User-facing: hide implementation details about data-source routing. */}
        </Card>

        <Card
          title="Health Score"
          right={
            <>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {(() => {
                const s = effectiveHealth?.score;
                const h = s != null ? healthLabelForScore(s) : { label: "—", tone: "neutral" };
                return (
                  <>
                    <span className={`healthTag ${h.tone}`}>
                      Primary: {s != null ? `${Number(s)}/100` : "—"}
                    </span>
                    <span className={`healthTag ${h.tone}`}>{h.label}</span>
                  </>
                );
              })()}

              {compareItemId ? (
                (() => {
                  const s = effectiveCompareHealth?.score;
                  const h = s != null ? healthLabelForScore(s) : { label: "—", tone: "neutral" };
                  return (
                    <>
                      <span className={`healthTag ${h.tone}`}>
                        Compare: {s != null ? `${Number(s)}/100` : "—"}
                      </span>
                      <span className={`healthTag ${h.tone}`}>{h.label}</span>
                    </>
                  );
                })()
              ) : null}

              {scoreDiff != null ? (
                <span className="healthTag neutral">Δ {scoreDiff >= 0 ? `+${scoreDiff}` : `${scoreDiff}`}</span>
              ) : null}

              {/* Manual refresh: fetch live health only for selected Primary/Compare (max 2 calls) */}
              <button
                className="btn small"
                onClick={refreshSelectedHealthNow}
                disabled={healthRefreshBusy}
                title="Live Health neu laden (Primary + Compare)"
              >
                {healthRefreshBusy ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            </>
          }
        >
          <div className="muted" style={{ marginBottom: 8 }}>
            Reasons (Primary):
          </div>
          <div className="chips">
            {(effectiveHealth?.reasons || ["stable"]).slice(0, 6).map((r, idx) => (
              <span key={idx} className="chip">
                {r}
              </span>
            ))}
          </div>

          {compareItemId ? (
            <>
              <div className="muted" style={{ marginTop: 12, marginBottom: 8 }}>
                Reasons (Compare):
              </div>
              <div className="chips">
                {(effectiveCompareHealth?.reasons || ["-"]).slice(0, 6).map((r, idx) => (
                  <span key={`c-${idx}`} className="chip">
                    {r}
                  </span>
                ))}
              </div>
            </>
          ) : null}

          {DEV_MODE ? (
          <Collapsible title="Raw JSON (Debug)">
            <pre className="pre">
              {JSON.stringify({ primary: effectiveHealth ?? {}, compare: effectiveCompareHealth ?? {} }, null, 2)}
            </pre>
          </Collapsible>
          ) : null}
        </Card>

        <Card title="Grid Controls">
          
          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
            <div className="muted">Coin</div>
            <select className="select" value={gridSelectedItem} onChange={(e) => setGridSelectedItem(e.target.value)}>
              {(watchlist || []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
              {(!(watchlist || []).includes(primaryItemId) && primaryItemId) ? (
                <option value={primaryItemId}>{primaryItemId}</option>
              ) : null}
            </select>

            <div className="muted" style={{ marginLeft: 8 }}>Mode</div>
            <select
              className="select"
              value={gridOrderMode}
              onChange={(e) => setGridOrderMode(e.target.value)}
              style={{ minWidth: 160 }}
            >
              <option value="AUTO">AUTO (10 Orders)</option>
              <option value="MANUAL">MANUAL</option>
            </select>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <label style={{ fontSize: 12, opacity: 0.9 }}>Demo investment (USD)</label>
            <input
              type="number"
              min={0}
              step={100}
              value={demoInvestUsd}
              onChange={(e) => setDemoInvestUsd(Number(e.target.value || 0))}
              style={{ width: 140 }}
            />
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              This is the simulated starting capital used for PnL/ROI (default 5000).
            </span>
          </div>


            
          {gridOrderMode === "AUTO" ? (
            <div className="row" style={{ alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <label style={{ fontSize: 12, opacity: 0.9 }}>AUTO uses % of demo capital</label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={autoInvestPct}
                onChange={(e) => {
                  const v = Number(e.target.value || 0);
                  if (mode === "AGGRESSIVE") setAutoInvestPctAgg(v);
                  else setAutoInvestPctSafe(v);
                }}
                style={{ width: 100 }}
              />
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                =&nbsp;<b>${autoInvestUsd.toFixed(2)}</b> used for AUTO in <b>{mode}</b> mode (SAFE/AGGRESSIVE keep their own %).
              </span>
            </div>
          ) : null}
{gridOrderMode === "MANUAL" ? (
              <>
                <div className="muted" style={{ marginLeft: 8 }}>Laufzeit</div>
                <input
                  className="input mono"
                  style={{ width: 120 }}
                  value={manualTTL}
                  onChange={(e) => setManualTTL(e.target.value)}
                  placeholder="TTL"
                />
                <select
                  className="select"
                  value={manualTTLUnit}
                  onChange={(e) => setManualTTLUnit(e.target.value)}
                  style={{ width: 120 }}
                >
                  <option value="s">Seconds</option>
                  <option value="m">Minutes</option>
                  <option value="h">Hours</option>
                  <option value="d">Days</option>
                </select>
              </>
            ) : null}
          </div>
<div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn start" onClick={startGrid} disabled={busy}>
              ▶ Start
            </button>
            <button className="btn tick" onClick={tickGrid} disabled={busy}>
              ⟳ Tick
            </button>
            <button className="btn stop" onClick={stopGrid} disabled={busy}>
              ■ Stop
            </button>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>
            Tick: <b>{gridMeta?.tick ?? "-"}</b> · Price:{" "}
            <b>
                                     {gridMeta?.price != null
                                     ? `$${formatPrice(gridMeta.price)}`
                                     : effectiveLive?.price != null
                                     ? `$${formatPrice(effectiveLive.price)}`
                                     : "—"}
                         </b>

            <span style={{ opacity: 0.75 }}>({gridMeta?.price_source || "—"})</span>{" "}
            · Filled now: <b>{gridMeta?.filled_now ?? 0}</b> · PnL: <b>{gridMeta?.pnl?.total != null ? `$${formatUSD(gridMeta.pnl.total)}` : "—"}</b>
            {gridMeta?.note ? <span> · {gridMeta.note}</span> : null}
          </div>
          {gridFills?.length ? (
            <div className="list" style={{ marginTop: 10 }}>
              <div className="muted" style={{ marginBottom: 6 }}>Treffer (letzte 10)</div>
              {gridFills.slice(-10).reverse().map((f, i) => (
                <div key={i} className="listItem">
                  <div className="mono">{(gridSelectedItem || f?.item) || "-"}</div>
                  <div className="mono">{f?.side || "-"}</div>
                  <div className="mono">{f?.fill_price != null ? `$${formatPrice(f.fill_price)}` : "-"}</div>
                  <div className="mono">{f?.pnl_delta != null ? `$${formatUSD(f.pnl_delta)}` : "—"}</div>
                  <div className="mono" style={{ opacity: 0.7 }}>{f?.filled_ts ? new Date(f.filled_ts * 1000).toLocaleTimeString() : ""}</div>
                </div>
              ))}
            </div>
          ) : null}


          <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label className="muted">Auto Tick (s)</label>
            <input
              className="input"
              style={{ width: 90 }}
              value={autoInterval}
              onChange={(e) => setAutoInterval(e.target.value)}
              placeholder="10"
            />
            <button className="btn" onClick={() => toggleAutorun(true)} disabled={busy || autoRun}>
              ▶ Auto
            </button>
            <button className="btn" onClick={() => toggleAutorun(false)} disabled={busy || !autoRun}>
              ■ Auto Stop
            </button>
            <span className="muted" style={{ marginLeft: 6 }}>
              {autoRun ? "running" : "off"}
            </span>
          </div>

          <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label className="muted">Manual</label>
            <select className="input" style={{ width: 110 }} value={manualSide} onChange={(e) => setManualSide(e.target.value)}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
            <input
              className="input"
              style={{ width: 140 }}
              value={manualPrice}
              onChange={(e) => setManualPrice(e.target.value)}
              placeholder="Price"
            />
            <input
              className="input"
              style={{ width: 120 }}
              value={manualQty}
              onChange={(e) => setManualQty(e.target.value)}
              placeholder="Qty (opt.)"
            />
            <button className="btn" onClick={addManualOrder} disabled={busy}>
              + Add
            </button>
            <button
              className="btn"
              onClick={() => {
                const s = normalizeSymbol(wlAddInput);
                setAddPickerErr("");
                setAddPickerQuery(s || "");
                setAddPickerTab("dex");
                setAddDexSymbol(s || "");
                setAddDexContract("");
                setAddDexChain("");
                setAddDexErr("");
                setAddPickerResults([]);
                setAddPickerOpen(true);
              }}
              disabled={wlBusy}
            >
              + DEX
            </button>

          </div>

          <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button
              className={`modeBtn ${mode === "SAFE" ? "active" : ""}`}
              onClick={() => setMode("SAFE")}
              disabled={busy}
            >
              Mode: SAFE
            </button>
            <button
              className={`modeBtn ${mode === "AGGRESSIVE" ? "active" : ""}`}
              onClick={() => setMode("AGGRESSIVE")}
              disabled={busy}
            >
              Mode: AGGRESSIVE
            </button>
            <button className="modeBtn" onClick={refreshAll} disabled={busy}>
              ↻ Refresh All
            </button>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>
            Note: AGGRESSIVE requires confirmation → it will be sent automatically with <code>confirm=YES</code>.
          </div>
        </Card>

        <Card
          title="Grid Orders"
          right={
            <Badge ok={gridOrdersVisibleAll.length ? true : null}>
              {gridOrdersVisibleAll.length || 0} orders
            </Badge>
          }
        >
          {!gridOrdersVisibleAll?.length ? (
            <div className="empty">No orders yet. Press Start or Tick.</div>
          ) : (
            <>
              <div className="gridOrdersTop">
  <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
    <span className="muted">Coin:</span>
    <span className="muted" style={{ marginLeft: "auto" }}>
      Showing {gridOrdersShown.length} / {gridOrdersFiltered.length}
    </span>
  </div>

  <div className="coinTabs" role="tablist" aria-label="Grid Orders coins">
    <button
      className={"btn " + (gridOrdersFilter === "ALL" ? "primary" : "")}
      onClick={() => setGridOrdersFilter("ALL")}
    >
      ALL
      <span className="miniCount">{gridOrdersVisibleAll.length}</span>
    </button>

    {gridCoins.map((c) => {
      const n = (gridOrdersVisibleAll || []).filter((o) => String(o?.item || o?.symbol || "").toUpperCase() === c).length;
      return (
        <button
          key={c}
          className={"btn " + (gridOrdersFilter === c ? "primary" : "")}
          onClick={() => setGridOrdersFilter(c)}
          title={`${n} orders`}
        >
          {c}
          <span className="miniCount">{n}</span>
        </button>
      );
    })}
  </div>
</div>

<div className="gridOrdersScroll">
  <div className="listHeader">
    <div>Coin</div>
    <div>Side</div>
    <div>Price</div>
    <div>Qty</div>
    <div>Status</div>
    <div style={{ textAlign: "right" }}>Action</div>
  </div>

  <div className="list">
              {gridOrdersShown.map((o) => (
                <div key={String(o?.id || `${o?.item || ""}-${o?.side || ""}-${o?.price ?? ""}-${o?.level ?? ""}-${o?.ts ?? ""}`)} className="listItem">
                  <div className="mono">{o?.item || "-"}</div>
                  <div className="mono"><span className={"pill " + String(o?.side || "").toUpperCase()}>{o?.side || "-"}</span></div>
                  <div className="mono">{o?.price != null ? `$${formatPrice(o.price)}` : "-"}</div>
                  <div className="mono">{o?.qty != null ? o.qty : (o?.amount != null ? o.amount : "-")}</div>
                  <div className="mono"><span className={"pill " + String(o?.status || "").toUpperCase()}>{o?.status || "-"}</span></div>
                  <div style={{ textAlign: "right" }}>
                    <button
                      className="btn small"
                      disabled={busy || String(o?.status || "").toUpperCase() !== "OPEN"}
                      onClick={() => stopSingleOrder(o)}
                      title="Stop this order"
                    >
                      Stop
                    </button>
                    <button
                      className="btn small"
                      disabled={busy || String(o?.status || "").toUpperCase() === "OPEN"}
                      onClick={() => removeOrderFromUI(o)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
            </>
          )}
        </Card>

        {DEV_MODE && (
        <Card title="Raw JSON (Live Debug)">
          <Collapsible title="Show / hide">
            <pre className="pre">{JSON.stringify(effectiveLive ?? {}, null, 2)}</pre>
          </Collapsible>
        </Card>
        )}


        <Card
          title="Watchlist"
          right={
            <div className="row" style={{ gap: 10 }}>
              <Badge ok={wlBusy ? null : true}>{wlBusy ? "updating" : "live"}</Badge>
            </div>
          }
        >
          <div className="field">
            <input
              className="input"
              value={wlAddInput}
              onChange={(e) => setWlAddInput(e.target.value)}
              placeholder="Add symbol (e.g. TBP, BTC, XRP, SOL)"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  addToWatchlist(wlAddInput);
                  setWlAddInput("");
                }
              }}
            />
          </div>

          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => {
                addToWatchlist(wlAddInput);
                setWlAddInput("");
              }}
              disabled={wlBusy}
            >
              + Add
            </button>
            <button className="btn" onClick={refreshWatchlist} disabled={wlBusy}>
              ⟳ Refresh Watchlist
            </button>
            {wlErr ? <span className="muted">{wlErr}</span> : null}
          </div>

          <div className="muted" style={{ marginTop: 10 }}>
            Items: {wlRows?.length || 0}
          </div>

          <div className="chips" style={{ marginTop: 10 }}>
            {(watchlist || []).map((s, idx) => (
              <span key={s} className={"chip" + (idx < 10 ? " chipTop" : "")}>
                {s}{" "}
                <button
                  className="chipArrow"
                  onClick={() => moveWatchlistSymbol(s, -1)}
                  disabled={wlBusy || idx === 0}
                  title="move up"
                >
                  ▲
                </button>
                <button
                  className="chipArrow"
                  onClick={() => moveWatchlistSymbol(s, +1)}
                  disabled={wlBusy || idx === (watchlist || []).length - 1}
                  title="move down"
                >
                  ▼
                </button>
                <button className="chipX" onClick={() => removeFromWatchlist(s)} disabled={wlBusy} title="remove">
                  ×
                </button>
              </span>
            ))}
          </div>

          <div className="table" style={{ marginTop: 12 }}>
            <div className="tHead">
              <div>Symbol</div>
              <div>Mode</div>
              <div>Price</div>
              <div>24h</div>
              <div>Volume 24h</div>
              <div>LP</div>
              <div>Source</div>
              <div></div>
            </div>

            
            <div className="wlTableScroll">
              {(wlRows || []).map((r) => (
                <div key={r.symbol} className="tRow">
                  <div className="mono">{r.symbol}</div>
                  <div className="mono">{r.mode || "-"}</div>
                  <div className="mono">{r.price != null ? formatPrice(r.price) : "—"}</div>
                  <div className={Number(r.change24h) >= 0 ? "pos" : "neg"}>
                    {r.change24h != null ? formatPct(r.change24h) : "—"}
                  </div>
                  <div className="mono">{r.volume24h != null ? formatUSD(r.volume24h) : "—"}</div>
                  <div className="mono">{r.liquidity != null ? formatUSD(r.liquidity) : "—"}</div>
                  <div className="mono">{r.source || "-"}</div>
                  <div style={{ textAlign: "right" }}>
                    <button className="btn small" onClick={() => removeFromWatchlist(r.symbol)} disabled={wlBusy}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

          </div>
        </Card>

{addPickerOpen ? (
  <div className="modalBackdrop" onClick={() => setAddPickerOpen(false)}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>Select token (CoinGecko)</div>
        <button className="btn" onClick={() => setAddPickerOpen(false)}>✕</button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className={"btn " + (addPickerTab === "market" ? "primary" : "")} onClick={() => setAddPickerTab("market")}>
          Market (CEX)
        </button>
        <button className={"btn " + (addPickerTab === "dex" ? "primary" : "")} onClick={() => setAddPickerTab("dex")}>
          DEX (Contract)
        </button>
      </div>


      {addPickerTab === "market" ? (
  <>
<div className="muted" style={{ marginTop: 6 }}>
        Suche: <b>{addPickerQuery}</b> — wähle den genauen Coin, damit Preis & Updates korrekt sind.
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        <input
          className="input"
          value={addPickerQuery}
          onChange={(e) => setAddPickerQuery(e.target.value)}
          placeholder="Type name or symbol…"
        />
        <button
          className="btn"
          disabled={addPickerBusy}
          onClick={async () => {
            setAddPickerErr("");
            setAddPickerBusy(true);
            try {
              const r = await jget(`${API}/market/search?query=${encodeURIComponent(addPickerQuery)}`);
              const results = Array.isArray(r?.results) ? r.results : [];
              setAddPickerResults(results);
              if (!results.length) setAddPickerErr("Kein Treffer gefunden.");
            } catch (e) {
              setAddPickerErr(String(e?.message || e));
            } finally {
              setAddPickerBusy(false);
            }
          }}
        >
          {addPickerBusy ? "searching…" : "Search"}
        </button>
      </div>

      {addPickerErr ? <div className="muted" style={{ marginTop: 10 }}>{addPickerErr}</div> : null}

      <div style={{ marginTop: 12, maxHeight: 360, overflow: "auto" }}>
        {(addPickerResults || []).map((c) => (
          <div
            key={c.id}
            className="row"
            style={{
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{c.name} <span className="muted">({(c.symbol || "").toUpperCase()})</span></div>
              <div className="muted" style={{ fontSize: 12 }}>ID: {c.id}{c.market_cap_rank ? ` • Rank #${c.market_cap_rank}` : ""}</div>
            </div>
            <button className="btn" onClick={() => addResolvedToWatchlist(c)}>
              Add
            </button>
          </div>
        ))}
      </div>

      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        Tip: Bei gleichen Symbolen (z.B. POL) immer den richtigen Namen/Rank auswählen.
      </div>
  </>
) : null}


{addPickerTab === "dex" ? (
  <div style={{ marginTop: 12 }}>
    <div className="muted" style={{ marginTop: 6 }}>
      DEX Token manuell hinzufügen (Contract-Adresse).
    </div>

    <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap" }}>
      <input
        className="input mono"
        value={addDexSymbol}
        onChange={(e) => setAddDexSymbol(e.target.value)}
        placeholder="Symbol (z.B. PEPE)"
        style={{ minWidth: 160 }}
      />
      <input
        className="input mono"
        value={addDexContract}
        onChange={(e) => setAddDexContract(e.target.value)}
        placeholder="Contract (0x...)"
        style={{ minWidth: 320, flex: 1 }}
      />
      <input
        className="input mono"
        value={addDexChain}
        onChange={(e) => setAddDexChain(e.target.value)}
        placeholder="Chain (optional, z.B. ethereum/base)"
        style={{ minWidth: 220 }}
      />
      <button className="btn" onClick={addDexToWatchlist}>
        Add
      </button>
    </div>

    {addDexErr ? <div className="muted" style={{ marginTop: 10 }}>{addDexErr}</div> : null}

    <div className="muted" style={{ marginTop: 8 }}>
      Preise/Vol/Liq kommen über Dexscreener für den Contract.
    </div>
  </div>
) : null}


    </div>
  </div>
) : null}


        <Card
          title="AI Analyst (Render)"
          right={<Badge ok={aiBusy ? null : true}>{aiBusy ? "thinking…" : "ready"}</Badge>}
        >
          <textarea
            className="textarea mono"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            rows={3}
          />

          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <span className="muted">AI output:</span>
            <button
              className={"modeBtn" + (aiVerbosity === "concise" ? " active" : "")}
              onClick={() => setAiVerbosity("concise")}
              disabled={aiBusy}
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              Concise
            </button>
            <button
              className={"modeBtn" + (aiVerbosity === "detailed" ? " active" : "")}
              onClick={() => setAiVerbosity("detailed")}
              disabled={aiBusy}
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              Detailed
            </button>
          </div>

          <div className="muted" style={{ marginTop: 6 }}>
            Not Financial Advice · Not Buy/Sell · Only Analyse & explanation.
          </div>

          <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => askAi("Quick Overview")} disabled={aiBusy}>
              📌 Quick Overview
            </button>
            <button className="btn" onClick={() => askAi("Risk Check")} disabled={aiBusy}>
              ⚠ Risk Check
            </button>
            <button className="btn" onClick={() => askAi("Volume Breakdown")} disabled={aiBusy}>
              📉 Volume Breakdown
            </button>
            <button className="btn" onClick={() => askAi("LP Stress Test")} disabled={aiBusy}>
              🧪 LP Stress Test
            </button>
          </div>

          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <button className="modeBtn" onClick={() => askAi("General")} disabled={aiBusy}>
              Ask AI
            </button>
            <button className="modeBtn" onClick={() => setAiAnswer("")} disabled={aiBusy}>
              Clear
            </button>
          </div>

          <div className="answerBox" style={{ marginTop: 10 }}>
            {aiAnswer ? <pre className="pre">{aiAnswer}</pre> : <div className="muted">No answer yet.</div>}
          </div>
        </Card>
      </div>

      {/* Styles (unchanged) */}
      <style>{`
        :root{
          --bg:#07120d;
          --panel:rgba(14,25,22,.72);
          --panel2:rgba(10,18,16,.85);
          --stroke:rgba(97,255,194,.18);
          --text:rgba(235,255,245,.92);
          --muted:rgba(200,255,230,.58);
          --ok:rgba(80,255,160,.95);
          --bad:rgba(255,80,80,.95);
          --accent:rgba(0,255,160,.95);
          --shadow:0 18px 60px rgba(0,0,0,.55);
          --radius:18px;
        }
        html,body{height:100%;}
        body{
          margin:0;
          background:radial-gradient(1200px 800px at 10% 10%, rgba(0,255,160,.15), transparent 50%),
                     radial-gradient(900px 600px at 80% 30%, rgba(0,140,255,.10), transparent 55%),
                     radial-gradient(900px 600px at 50% 90%, rgba(255,0,120,.08), transparent 60%),
                     var(--bg);
          color:var(--text);
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        }
        .app{max-width:1200px;margin:0 auto;padding:18px 16px 40px;}
        .topbar{
          display:flex;align-items:flex-end;justify-content:space-between;
          padding:10px 6px 18px;
          gap:14px;
        }
        .brand{display:flex;align-items:center;gap:12px;}
        .logo{width:44px;height:44px;filter: drop-shadow(0 10px 24px rgba(0,0,0,.55));}
        .brandText .title{font-size:20px;font-weight:800;letter-spacing:.3px;}
        .brandText .subtitle{font-size:12px;color:var(--muted);margin-top:2px;}
        .statusRow{display:flex;gap:10px;align-items:center;}
        .toast{
          background:rgba(255,60,60,.1);
          border:1px solid rgba(255,80,80,.35);
          padding:10px 12px;border-radius:12px;
          color:rgba(255,230,230,.95);
          margin:10px 6px 14px;
          box-shadow: var(--shadow);
        }
        .grid{
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:14px;
        }
        @media (max-width:980px){
          .grid{grid-template-columns:1fr;}
        }
        .card{
          border:1px solid var(--stroke);
          background:linear-gradient(180deg, rgba(25,45,38,.62), rgba(12,22,19,.72));
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          overflow:hidden;
          position:relative;
        }
        .card::before{
          content:"";
          position:absolute;inset:-2px;
          background:radial-gradient(800px 250px at 30% 0%, rgba(0,255,160,.16), transparent 60%);
          pointer-events:none;
          opacity:.8;
        }
        .cardTop{
          display:flex;align-items:center;justify-content:space-between;
          padding:14px 16px 8px;
          position:relative;
        }
        .cardTitle{font-weight:800;letter-spacing:.2px;}
        .cardRight{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;}
        .cardBody{padding:12px 16px 16px;position:relative;}
        .field{margin-bottom:10px;}
        .label{font-size:12px;color:var(--muted);margin-bottom:6px;}
        .input, .textarea{
          width:100%;
          box-sizing:border-box;
          border-radius:14px;
          border:1px solid rgba(97,255,194,.22);
          background:rgba(5,12,10,.6);
          color:var(--text);
          padding:10px 12px;
          outline:none;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.15);

        .select{
          width:100%;
          box-sizing:border-box;
          border-radius:14px;
          border:1px solid rgba(97,255,194,.22);
          background:rgba(5,12,10,.6);
          color:var(--text);
          padding:10px 36px 10px 12px;
          outline:none;
          box-shadow: inset 0 0 0 1px rgba(0,0,0,.15);
          -webkit-appearance:none;
          appearance:none;
          background-image:
            linear-gradient(45deg, transparent 50%, rgba(97,255,194,.55) 50%),
            linear-gradient(135deg, rgba(97,255,194,.55) 50%, transparent 50%);
          background-position:
            calc(100% - 18px) calc(1em + 2px),
            calc(100% - 13px) calc(1em + 2px);
          background-size:5px 5px, 5px 5px;
          background-repeat:no-repeat;
        }
        .select:focus{
          border-color:rgba(97,255,194,.45);
          box-shadow:0 0 0 3px rgba(97,255,194,.08), inset 0 0 0 1px rgba(0,0,0,.15);
        }
        }
        .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
        .row{display:flex;align-items:center;}
        .muted{color:var(--muted);font-size:12px;}
        .big{font-size:28px;font-weight:900;letter-spacing:.2px;}
        .chips{display:flex;gap:8px;flex-wrap:wrap;}
        .chip{
          padding:6px 10px;border-radius:999px;
          border:1px solid rgba(97,255,194,.22);
          background:rgba(8,16,14,.55);
          color:rgba(225,255,240,.92);
          font-size:12px;
          display:inline-flex;
          align-items:center;
          gap:8px;
        }
        .chipX{
          border:none;
          background:transparent;
          color:rgba(200,255,230,.7);
          cursor:pointer;
          font-weight:900;
          font-size:14px;
          line-height:1;
          padding:0 2px;
        }
        .chipArrow{
          border:none;
          background:transparent;
          color:rgba(200,255,230,.7);
          cursor:pointer;
          font-weight:900;
          font-size:12px;
          line-height:1;
          padding:0 2px;
        }
        .chipArrow:disabled{
          opacity:.25;
          cursor:default;
        }
        .chipTop{
          box-shadow:0 0 0 1px rgba(80,255,200,.18) inset;
        }
        /* Watchlist: scroll within the card (instead of page scroll) for items beyond Top 10 */
        
        .wlTableScroll{
          max-height: 240px; /* ~5 rows sichtbar */
          overflow-y: auto;
          padding-right: 4px;
        }
.wlRestScroll{
          max-height:140px;
          overflow-y:scroll;
          overflow-x:hidden;
          padding-right:6px;
          margin-top:6px;
        }

        .badge{
          padding:6px 10px;border-radius:999px;font-size:12px;
          border:1px solid rgba(97,255,194,.18);
          background:rgba(8,16,14,.55);
          color:rgba(225,255,240,.85);
        }
        .badge.ok{border-color:rgba(80,255,160,.35);color:rgba(170,255,215,.95);}
        .badge.bad{border-color:rgba(255,80,80,.35);color:rgba(255,200,200,.95);}
        .badge.neutral{opacity:.85;}
        .healthTag{
          display:inline-flex;align-items:center;
          padding:6px 10px;border-radius:999px;
          border:1px solid rgba(97,255,194,.18);
          background:rgba(0,0,0,.14);
          font-size:12px;
          font-weight:800;
        }
        .healthTag.healthy{border-color:rgba(80,255,160,.35); color: rgba(170,255,215,.95); background:rgba(0,255,160,.08);}
        .healthTag.stable{border-color:rgba(255,180,0,.35); color: rgba(255,215,140,.95); background:rgba(255,180,0,.07);}
        .healthTag.weak{border-color:rgba(255,80,80,.35); color: rgba(255,200,200,.95); background:rgba(255,80,80,.06);}
        .healthTag.neutral{opacity:.85;}

        .btn, .modeBtn, .segBtn{
          border-radius:999px;
          border:1px solid rgba(97,255,194,.22);
          background:rgba(8,16,14,.55);
          color:rgba(230,255,244,.92);
          padding:10px 14px;
          cursor:pointer;
          transition: transform .08s ease, border-color .12s ease, background .12s ease;
        }
        .segBtn{padding:8px 12px;font-size:12px;}
        .btn:hover, .modeBtn:hover, .segBtn:hover{transform: translateY(-1px);border-color:rgba(97,255,194,.35);}
        .btn:disabled, .modeBtn:disabled, .segBtn:disabled{opacity:.55;cursor:not-allowed;transform:none;}
        
        .btn.small{padding:6px 10px;font-size:12px;}
        .btn.start{border-color:rgba(80,255,160,.32);}
        .btn.tick{border-color:rgba(0,160,255,.28);}
        .btn.stop{border-color:rgba(255,80,80,.28);}
        .modeBtn.active, .segBtn.active{
          border-color:rgba(80,255,160,.55);
          box-shadow:0 0 0 2px rgba(80,255,160,.08) inset;
        }
        .empty{
          color:rgba(200,255,230,.6);
          padding:10px 0;
        }
        .list{display:flex;flex-direction:column;gap:10px;}
        .listItem{
          display:grid;
          grid-template-columns: .9fr .7fr .9fr .8fr .8fr .6fr;
          gap:10px;
          padding:10px 12px;
          border:1px solid rgba(97,255,194,.14);
          background:rgba(5,12,10,.45);
          border-radius:14px;
        }

        .gridOrdersTop{margin-bottom:8px;}
.coinTabs{
  display:flex;
  gap:8px;
  overflow-x:auto;
  padding:2px 0 6px;
  -webkit-overflow-scrolling:touch;
}
.coinTabs::-webkit-scrollbar{height:8px;}
.coinTabs::-webkit-scrollbar-thumb{background:rgba(97,255,194,.18);border-radius:999px;}
.miniCount{
  margin-left:8px;
  padding:2px 8px;
  border-radius:999px;
  border:1px solid rgba(97,255,194,.18);
  background:rgba(0,0,0,.18);
  font-size:11px;
  color:rgba(220,255,240,.78);
}
.gridOrdersScroll{
  border:1px solid rgba(97,255,194,.14);
  background:rgba(5,12,10,.35);
  border-radius:14px;
  padding:8px;
  max-height:320px; /* ~5-6 rows */
  overflow:auto;
}
.listHeader{
  position:sticky;
  top:0;
  z-index:2;
  display:grid;
  grid-template-columns: .9fr .7fr .9fr .8fr .8fr .6fr;
  gap:10px;
  padding:8px 12px;
  margin:-8px -8px 10px;
  background:rgba(4,10,8,.92);
  border-bottom:1px solid rgba(97,255,194,.14);
  font-size:11px;
  letter-spacing:.08em;
  text-transform:uppercase;
  color:rgba(200,255,230,.65);
  backdrop-filter: blur(6px);
}
.pill{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:2px 10px;
  border-radius:999px;
  border:1px solid rgba(97,255,194,.18);
  background:rgba(0,0,0,.18);
  font-size:11px;
  color:rgba(230,255,244,.92);
}
.pill.BUY{border-color:rgba(80,255,160,.35); box-shadow:0 0 0 2px rgba(80,255,160,.06) inset;}
.pill.SELL{border-color:rgba(255,120,120,.35); box-shadow:0 0 0 2px rgba(255,120,120,.06) inset;}
.pill.OPEN{border-color:rgba(0,160,255,.30); box-shadow:0 0 0 2px rgba(0,160,255,.06) inset;}
.pill.FILLED{border-color:rgba(80,255,160,.30); box-shadow:0 0 0 2px rgba(80,255,160,.06) inset;}
.pill.CANCELLED, .pill.CANCELED{border-color:rgba(255,120,120,.30); box-shadow:0 0 0 2px rgba(255,120,120,.06) inset;}

        .collapsibleBtn{
          width:100%;
          display:flex;align-items:center;gap:8px;
          text-align:left;
          border:none;
          background:transparent;
          color:rgba(230,255,244,.92);
          cursor:pointer;
          padding:8px 0;
          font-weight:800;
        }
        .caret{color:rgba(200,255,230,.6);}
        .collapsibleBody{padding:6px 0 0;}
        .pre{
          margin:0;
          font-size:12px;
          color:rgba(220,255,240,.86);
          white-space:pre-wrap;
          word-break:break-word;
        }
        .answerBox{
          border:1px solid rgba(97,255,194,.14);
          background:rgba(5,12,10,.45);
          padding:12px;
          border-radius:14px;
          min-height:80px;
        }
        .table{
          width:100%;
          border:1px solid rgba(97,255,194,.14);
          background:rgba(5,12,10,.35);
          border-radius:14px;
          overflow:hidden;
        }
        .tHead, .tRow{
          display:grid;
          grid-template-columns: .7fr .7fr .9fr .7fr 1.1fr .9fr .8fr .7fr;
          gap:10px;
          padding:10px 12px;
          align-items:center;
        }
        .tHead{
          font-size:12px;color:rgba(200,255,230,.7);
          background:rgba(8,16,14,.55);
          border-bottom:1px solid rgba(97,255,194,.12);
          font-weight:800;
        }
        .tRow{
          font-size:13px;
          border-bottom:1px solid rgba(97,255,194,.08);
        }
        .tRow:last-child{border-bottom:none;}
        .pos{color:rgba(120,255,190,.95);}
        .neg{color:rgba(255,140,140,.95);}
        .pill{
          display:inline-flex;
          align-items:center;
          gap:8px;
          padding:8px 10px;
          border-radius:999px;
          border:1px solid rgba(97,255,194,.18);
          background:rgba(8,16,14,.45);
          color:rgba(230,255,244,.9);
          font-size:12px;
        }
        code{
          background:rgba(0,0,0,.25);
          border:1px solid rgba(255,255,255,.08);
          padding:2px 6px;border-radius:10px;
        }
      

.modalBackdrop{
  position:fixed; inset:0;
  background:rgba(0,0,0,.55);
  display:flex; align-items:center; justify-content:center;
  padding:16px;
  z-index:9999;
}
.modal{
  width:min(720px, 96vw);
  background:var(--panel2);
  border:1px solid var(--stroke);
  border-radius:16px;
  padding:14px 14px 12px;
  box-shadow:var(--shadow);
}
`}</style>
    </div>
  );
}
