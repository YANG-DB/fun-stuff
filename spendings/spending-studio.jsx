import React, { useState, useMemo, useEffect } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, LineChart, Line,
} from "recharts";
import {
  LayoutDashboard, ReceiptText, ChartPie, TrendingUp, Sparkles, Search,
  ArrowUpRight, ArrowDownRight, Repeat, Plane, ShoppingBag, Utensils,
  Car, Baby, Music, Cpu, HeartPulse, Landmark, Wallet, CircleDot, Plus, Minus, Home, Key,
  Smartphone, Shield, Layers, EyeOff, Eye, ChevronRight, ChevronDown, X, Zap, MessageSquare, ZoomIn,
} from "lucide-react";
import CSV_RAW from "./source/data/all-expenses-source.csv?raw";

const TXNS = (() => {
  const rows = CSV_RAW.replace(/\r/g, "").trim().split("\n");
  const out = [];
  for (let i = 1; i < rows.length; i++) {            // skip header
    const line = rows[i];
    if (!line) continue;
    const f = []; let cur = "", q = false;           // CSV split honoring quoted fields
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') { if (q && line[j + 1] === '"') { cur += '"'; j++; } else q = !q; }
      else if (ch === "," && !q) { f.push(cur); cur = ""; }
      else cur += ch;
    }
    f.push(cur);
    const [date, card, desc, cat, flow, debit, credit, bal] = f;
    out.push({
      date,
      desc,
      amount: debit ? parseFloat(debit) : 0,
      credit: credit ? parseFloat(credit) : 0,
      balance: bal ? parseFloat(bal) : null,
      cat,
      card: card || "Card 1",
    });
  }
  return out;
})();

// ---------- config ----------
const C = {
  bg: "#0d0f14", panel: "#14171f", panel2: "#1b1f2a", line: "#262b38",
  ink: "#ece6d8", sub: "#9aa0ad", faint: "#646b7a",
  gold: "#e0a458", goldDim: "#9d7740",
};
const CAT_META = {
  "Housing & Rent":         { c: "#c9826b", icon: Home },
  "Car Purchase":           { c: "#5e81ac", icon: Key },
  "Kids & Recreation":      { c: "#6cc4a1", icon: Baby },
  "Shopping & Retail":      { c: "#e0a458", icon: ShoppingBag },
  "Travel":                 { c: "#7aa2f7", icon: Plane },
  "Groceries":              { c: "#9ece6a", icon: Wallet },
  "Transport & Fuel":       { c: "#f7768e", icon: Car },
  "Subscriptions & Digital":{ c: "#bb9af7", icon: Cpu },
  "Telecommunication":      { c: "#d291bc", icon: Smartphone },
  "Insurance":              { c: "#a3be8c", icon: Shield },
  "Utilities":              { c: "#7dcfff", icon: Zap },
  "Entertainment":          { c: "#ff9e64", icon: Music },
  "Dining & Coffee":        { c: "#e0af68", icon: Utensils },
  "Health & Pharmacy":      { c: "#2ac3de", icon: HeartPulse },
  "Fees & Interest":        { c: "#db4b4b", icon: Landmark },
  "Other":                  { c: "#8a8f98", icon: CircleDot },
  "Payments & Credits":     { c: "#565f89", icon: Repeat },
};
const catColor = (k) => (CAT_META[k]?.c) || "#8a8f98";
const SPEND_CATS = Object.keys(CAT_META).filter((k) => k !== "Payments & Credits");
const MONTHS = Array.from(new Set(TXNS.map((t) => t.date.slice(0, 7)))).sort(); // every month present in the data

const fmt = (n, dp = 0) =>
  "$" + (n || 0).toLocaleString("en-CA", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtK = (n) => (Math.abs(n) >= 1000 ? "$" + (n / 1000).toFixed(1) + "k" : "$" + Math.round(n));
const monthName = (ym) => {
  const [y, m] = ym.split("-");
  return new Date(y, m - 1, 1).toLocaleString("en", { month: "short" }) + " " + y.slice(2);
};
const daysBetween = (a, b) =>
  Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000) + 1);
// strip trailing reference codes / store numbers so variants of one provider collapse to a single name
const merchClean = (desc) => {
  let s = desc.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+_[A-Z]$/, "");              // trailing _F _V flags (checking)
  s = s.replace(/\s+\*+[A-Za-z0-9]+$/, "");     // trailing ***masked / *code
  s = s.replace(/\s+#?\d[\w.-]*$/, "");         // trailing store/ref number  #8932 91445 003065
  s = s.replace(/\s+[A-Z]*\d[A-Z\d]{2,}$/, ""); // trailing alnum ref containing a digit  R9Q3J8 Z5W5K9
  s = s.replace(/\s+#\s*$/, "");                // dangling #
  return s.trim() || desc.trim();
};
const merchKey = (desc) => merchClean(desc).toUpperCase(); // case-insensitive match key
const txnSig = (t) => `${t.date}|${t.desc}|${t.amount}`;   // stable signature for a single-line override
const weekStart = (dateStr) => {                           // Monday of the week, as YYYY-MM-DD
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

// ---------- shared atoms ----------
const Stat = ({ label, value, sub, accent }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "18px 20px" }}>
    <div style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: C.faint, fontFamily: "var(--ui)" }}>{label}</div>
    <div style={{ fontFamily: "var(--mono)", fontSize: 30, color: accent || C.ink, marginTop: 8, fontWeight: 500, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 8, fontFamily: "var(--ui)" }}>{sub}</div>}
  </div>
);

const SectionTitle = ({ children, kicker }) => (
  <div style={{ marginBottom: 16 }}>
    {kicker && <div style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.gold, fontFamily: "var(--ui)", marginBottom: 6 }}>{kicker}</div>}
    <h2 style={{ fontFamily: "var(--display)", fontWeight: 400, fontSize: 26, color: C.ink, margin: 0, letterSpacing: "-.01em" }}>{children}</h2>
  </div>
);

function ChartTip({ active, payload, label, prefix }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0a0c11", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", fontFamily: "var(--ui)" }}>
      {label && <div style={{ color: C.sub, fontSize: 11, marginBottom: 6, letterSpacing: ".04em" }}>{label}</div>}
      {payload.filter(p => p.value).map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink, padding: "1px 0" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.fill }} />
          <span style={{ color: C.sub }}>{p.name}</span>
          <span style={{ fontFamily: "var(--mono)", marginLeft: "auto", paddingLeft: 14 }}>{(prefix || "$") + Math.round(p.value).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// interactive tooltip with a Zoom button (drills the chart into the hovered bucket)
function ZoomTip({ active, payload, label, onZoom, canZoom }) {
  if (!active || !payload?.length) return null;
  const key = payload[0]?.payload?.key;
  const rows = payload.filter((p) => p.value > 0);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div style={{ background: "#0a0c11", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", fontFamily: "var(--ui)", minWidth: 160 }}>
      <div style={{ color: C.sub, fontSize: 11, marginBottom: 6, letterSpacing: ".04em" }}>{label}</div>
      {rows.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink, padding: "1px 0" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color || p.fill }} />
          <span style={{ color: C.sub }}>{p.name}</span>
          <span style={{ fontFamily: "var(--mono)", marginLeft: "auto", paddingLeft: 14 }}>{"$" + Math.round(p.value).toLocaleString()}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: C.ink }}>{"$" + Math.round(total).toLocaleString()}</span>
        {canZoom && (
          <button onMouseDown={(e) => { e.stopPropagation(); onZoom(key); }}
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "4px 9px", borderRadius: 7, cursor: "pointer", border: `1px solid ${C.gold}`, background: "rgba(224,164,88,.14)", color: C.gold }}>
            <ZoomIn size={12} /> Zoom in
          </button>
        )}
      </div>
    </div>
  );
}

// ========================================================================
export default function App() {
  const [tab, setTab] = useState("overview");
  const [rules, setRules] = useState({ provider: {}, txn: {}, providerNotes: {}, txnNotes: {} }); // persisted overrides + comments
  const [cardFilter, setCardFilter] = useState("All");
  const [excluded, setExcluded] = useState(() => new Set()); // categories muted from totals
  const [fromYM, setFromYM] = useState(MONTHS[0]);            // period window (inclusive months)
  const [toYM, setToYM] = useState(MONTHS[MONTHS.length - 1]);
  const CARDS = useMemo(() => Array.from(new Set(TXNS.map((t) => t.card || "Card 1"))), []);

  useEffect(() => {
    const id = "fin-fonts";
    if (!document.getElementById(id)) {
      const l = document.createElement("link");
      l.id = id; l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Hanken+Grotesk:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";
      document.head.appendChild(l);
    }
  }, []);

  // load persisted categorization rules from the dedicated file, once
  useEffect(() => {
    fetch("/__rules").then((r) => r.json())
      .then((d) => { if (d) setRules({ provider: d.provider || {}, txn: d.txn || {}, providerNotes: d.providerNotes || {}, txnNotes: d.txnNotes || {} }); })
      .catch(() => {});
  }, []);

  // resolve each transaction's category: single-line override > provider rule > CSV default
  const cats = useMemo(() => TXNS.map((t) => rules.txn[txnSig(t)] ?? rules.provider[merchKey(t.desc)] ?? t.cat), [rules]);
  const ruleCount = Object.keys(rules.provider).length + Object.keys(rules.txn).length;
  const persistRules = (next) => {
    setRules(next);
    fetch("/__rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => {});
  };

  // attach resolved category + global index, then filter by card
  const allTxns = useMemo(() => TXNS.map((t, i) => ({ ...t, cat: cats[i], gi: i, card: t.card || "Card 1" })), [cats]);
  const txns = useMemo(() => allTxns.filter((t) => {
    const ym = t.date.slice(0, 7);
    return (cardFilter === "All" || t.card === cardFilter) && ym >= fromYM && ym <= toYM;
  }), [allTxns, cardFilter, fromYM, toYM]);
  // single line override (saved by content signature)
  const setCat = (gi, c) => { const t = TXNS[gi]; persistRules({ ...rules, txn: { ...rules.txn, [txnSig(t)]: c } }); };
  // reassign one exact provider name — saved as line overrides for each matching transaction
  const setCatForMerch = (desc, c) => {
    const txn = { ...rules.txn };
    TXNS.forEach((t) => { if (t.desc === desc) txn[txnSig(t)] = c; });
    persistRules({ ...rules, txn });
  };
  // reassign a normalized provider (BC HYDRO R9Q3J8 == BC HYDRO L3K5W2) — saved as a reusable provider rule
  const setCatForKey = (key, c) => {
    const txn = { ...rules.txn };
    TXNS.forEach((t) => { if (merchKey(t.desc) === key) delete txn[txnSig(t)]; }); // provider rule supersedes line overrides in the group
    persistRules({ ...rules, provider: { ...rules.provider, [key]: c }, txn });
  };
  // comments — keyed by normalized provider / by transaction signature; empty clears
  const setNoteForKey = (mkey, note) => {
    const providerNotes = { ...rules.providerNotes };
    if (note && note.trim()) providerNotes[mkey] = note.trim(); else delete providerNotes[mkey];
    persistRules({ ...rules, providerNotes });
  };
  const setNoteForTxn = (gi, note) => {
    const sig = txnSig(TXNS[gi]);
    const txnNotes = { ...rules.txnNotes };
    if (note && note.trim()) txnNotes[sig] = note.trim(); else delete txnNotes[sig];
    persistRules({ ...rules, txnNotes });
  };
  // mute/unmute a category from all totals
  const toggleExcluded = (cat) => setExcluded((p) => {
    const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n;
  });

  // spend-by-card for the overview split — respects the period window + muted cats, but always shows every card
  const cardSpend = useMemo(() => {
    const o = {};
    allTxns.forEach((t) => {
      const ym = t.date.slice(0, 7);
      if (t.amount > 0 && t.cat !== "Payments & Credits" && !excluded.has(t.cat) && ym >= fromYM && ym <= toYM)
        o[t.card] = (o[t.card] || 0) + t.amount;
    });
    return o;
  }, [allTxns, excluded, fromYM, toYM]);

  // derived analytics --------------------------------------------------
  const A = useMemo(() => {
    const spend = txns.filter((t) => t.amount > 0 && t.cat !== "Payments & Credits" && !excluded.has(t.cat));
    const totalSpend = spend.reduce((s, t) => s + t.amount, 0);
    const dates = txns.map((t) => t.date).sort();
    const start = dates[0], end = dates[dates.length - 1];
    const days = daysBetween(start, end);
    const daily = totalSpend / days;

    // by category
    const byCat = {};
    spend.forEach((t) => (byCat[t.cat] = (byCat[t.cat] || 0) + t.amount));
    const catRows = Object.entries(byCat).map(([k, v]) => ({ cat: k, v })).sort((a, b) => b.v - a.v);

    // by month
    const byMonth = {};
    spend.forEach((t) => {
      const ym = t.date.slice(0, 7);
      byMonth[ym] = byMonth[ym] || { ym, total: 0 };
      byMonth[ym].total += t.amount;
      byMonth[ym][t.cat] = (byMonth[ym][t.cat] || 0) + t.amount;
    });
    const months = Object.values(byMonth).sort((a, b) => a.ym.localeCompare(b.ym));
    // full months = exclude first & last (partial)
    const fullMonths = months.slice(1, -1);
    const avgFull = fullMonths.length ? fullMonths.reduce((s, m) => s + m.total, 0) / fullMonths.length : daily * 30.44;
    const recent3 = fullMonths.slice(-3);
    const avg3 = recent3.length ? recent3.reduce((s, m) => s + m.total, 0) / recent3.length : avgFull;

    // merchants
    const byMerch = {};
    spend.forEach((t) => {
      byMerch[t.desc] = byMerch[t.desc] || { desc: t.desc, v: 0, n: 0, cat: t.cat };
      byMerch[t.desc].v += t.amount; byMerch[t.desc].n++;
    });
    const merchants = Object.values(byMerch).sort((a, b) => b.v - a.v);

    // recurring: same merchant in >=3 distinct months
    const merchMonths = {};
    spend.forEach((t) => {
      (merchMonths[t.desc] = merchMonths[t.desc] || new Set()).add(t.date.slice(0, 7));
    });
    const recurring = merchants
      .filter((m) => merchMonths[m.desc].size >= 3)
      .map((m) => ({ ...m, mo: merchMonths[m.desc].size, perMo: m.v / merchMonths[m.desc].size }))
      .sort((a, b) => b.perMo - a.perMo);

    return { spend, totalSpend, start, end, days, daily, catRows, byCat, months, fullMonths, avgFull, avg3, merchants, recurring };
  }, [txns, excluded]);

  const TABS = [
    ["overview", "Overview", LayoutDashboard],
    ["txns", "Transactions", ReceiptText],
    ["categories", "Categories", Layers],
    ["analyze", "Analyze", ChartPie],
    ["forecast", "Forecast", TrendingUp],
    ["lifestyle", "Lifestyle", Sparkles],
  ];

  return (
    <div style={{ background: C.bg, color: C.ink, minHeight: "100vh", fontFamily: "var(--ui)" }}>
      <style>{`
        :root{--display:'Fraunces',Georgia,serif;--ui:'Hanken Grotesk',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;}
        *{box-sizing:border-box;}
        ::selection{background:${C.gold};color:#000;}
        .tabbtn{transition:all .18s ease;}
        .row{transition:background .12s ease;}
        .row:hover{background:${C.panel2};}
        select{appearance:none;-webkit-appearance:none;}
        input,select,button{font-family:var(--ui);}
        .scrollwrap::-webkit-scrollbar{width:9px;height:9px;}
        .scrollwrap::-webkit-scrollbar-thumb{background:${C.line};border-radius:6px;}
        @keyframes rise{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}
        .rise{animation:rise .5s cubic-bezier(.2,.7,.3,1) both;}
      `}</style>

      {/* header */}
      <div style={{ borderBottom: `1px solid ${C.line}`, background: "linear-gradient(180deg,#10131a,#0d0f14)" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 28px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: ".22em", textTransform: "uppercase", color: C.gold }}>Personal Spending Studio</div>
              <h1 style={{ fontFamily: "var(--display)", fontWeight: 400, fontSize: 40, margin: "6px 0 0", letterSpacing: "-.02em" }}>
                The Ledger
              </h1>
            </div>
            <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 12.5, color: C.sub, paddingBottom: 4 }}>
              <div>{A.start} → {A.end}</div>
              <div style={{ color: C.faint }}>{A.spend.length} purchases · {A.days} days</div>
              {excluded.size > 0 && <div style={{ color: C.gold }}>{excluded.size} categor{excluded.size > 1 ? "ies" : "y"} muted · Categories tab</div>}
              {ruleCount > 0 && <div style={{ color: C.faint }}>{ruleCount} saved categorization rule{ruleCount > 1 ? "s" : ""}</div>}
              <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
                {["All", ...CARDS].map((c) => (
                  <button key={c} onClick={() => setCardFilter(c)}
                    style={{
                      fontFamily: "var(--ui)", fontSize: 11.5, padding: "5px 10px", cursor: "pointer", borderRadius: 999,
                      border: `1px solid ${cardFilter === c ? C.gold : C.line}`,
                      background: cardFilter === c ? "rgba(224,164,88,.12)" : "transparent",
                      color: cardFilter === c ? C.gold : C.sub,
                    }}>
                    {c === "All" ? "Both cards" : c}
                  </button>
                ))}
              </div>
              {/* period window */}
              <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: C.faint }}>Period</span>
                {[["3M", 3], ["6M", 6], ["12M", 12], ["All", MONTHS.length]].map(([label, n]) => {
                  const startIdx = Math.max(0, MONTHS.length - n);
                  const active = fromYM === MONTHS[startIdx] && toYM === MONTHS[MONTHS.length - 1];
                  return (
                    <button key={label} onClick={() => { setFromYM(MONTHS[startIdx]); setToYM(MONTHS[MONTHS.length - 1]); }}
                      style={{
                        fontFamily: "var(--ui)", fontSize: 11.5, padding: "5px 9px", cursor: "pointer", borderRadius: 999,
                        border: `1px solid ${active ? C.gold : C.line}`,
                        background: active ? "rgba(224,164,88,.12)" : "transparent",
                        color: active ? C.gold : C.sub,
                      }}>{label}</button>
                  );
                })}
                <select value={fromYM} onChange={(e) => { const v = e.target.value; setFromYM(v); if (v > toYM) setToYM(v); }}
                  style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 7, padding: "4px 8px", fontSize: 11.5, fontFamily: "var(--mono)", cursor: "pointer" }}>
                  {MONTHS.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                </select>
                <span style={{ color: C.faint }}>→</span>
                <select value={toYM} onChange={(e) => { const v = e.target.value; setToYM(v); if (v < fromYM) setFromYM(v); }}
                  style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 7, padding: "4px 8px", fontSize: 11.5, fontFamily: "var(--mono)", cursor: "pointer" }}>
                  {MONTHS.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                </select>
              </div>
            </div>
          </div>
          {/* tabs */}
          <div style={{ display: "flex", gap: 4, marginTop: 22, flexWrap: "wrap" }}>
            {TABS.map(([k, label, Icon]) => (
              <button key={k} className="tabbtn" onClick={() => setTab(k)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", cursor: "pointer",
                  background: "none", border: "none", borderBottom: `2px solid ${tab === k ? C.gold : "transparent"}`,
                  color: tab === k ? C.ink : C.sub, fontSize: 14, fontWeight: tab === k ? 600 : 400,
                }}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px" }}>
        {tab === "overview" && <Overview A={A} go={setTab} cardSpend={cardSpend} cardFilter={cardFilter} />}
        {tab === "txns" && <Transactions txns={txns} setCat={setCat} />}
        {tab === "categories" && <Categories txns={txns} excluded={excluded} toggleExcluded={toggleExcluded} setCat={setCat} setCatForMerch={setCatForMerch} setCatForKey={setCatForKey} providerNotes={rules.providerNotes} txnNotes={rules.txnNotes} setNoteForKey={setNoteForKey} setNoteForTxn={setNoteForTxn} />}
        {tab === "analyze" && <Analyze A={A} />}
        {tab === "forecast" && <Forecast A={A} />}
        {tab === "lifestyle" && <Lifestyle A={A} />}
      </div>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "12px 28px 48px", color: C.faint, fontSize: 12, fontFamily: "var(--ui)" }}>
        Built from two cards' account activity. Figures are estimates from {A.days} days of history — projections assume past patterns continue and are not financial advice. Use the card toggle in the header to view either card alone.
      </div>
    </div>
  );
}

// ====================== OVERVIEW ======================
function Overview({ A, go, cardSpend, cardFilter }) {
  const annual = A.daily * 365;
  const monthlyDaily = A.daily * 30.44;
  const trend = A.months.map((m) => ({ ...m, label: monthName(m.ym) }));
  const topCats = A.catRows.slice(0, 5);
  const cardEntries = Object.entries(cardSpend || {}).sort((a, b) => b[1] - a[1]);
  const cardTotal = cardEntries.reduce((s, [, v]) => s + v, 0) || 1;
  const cardCols = ["#e0a458", "#7aa2f7", "#6cc4a1", "#bb9af7"];

  return (
    <div className="rise">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 26 }}>
        <Stat label="Total spend" value={fmt(A.totalSpend)} sub={`across ${A.spend.length} purchases`} accent={C.gold} />
        <Stat label="Avg / full month" value={fmt(A.avgFull)} sub={`${A.fullMonths.length} complete months`} />
        <Stat label="Daily burn rate" value={fmt(A.daily)} sub="every single day" />
        <Stat label="Annualized run-rate" value={fmtK(annual)} sub="if this pace holds 12 mo" />
      </div>

      {cardFilter === "All" && cardEntries.length > 1 && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 20px", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: C.faint }}>Spend by card</span>
            <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12.5, color: C.sub }}>{fmt(cardTotal)} total</span>
          </div>
          <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", marginBottom: 10 }}>
            {cardEntries.map(([c, v], i) => (
              <div key={c} title={`${c}: ${fmt(v)}`} style={{ width: (v / cardTotal) * 100 + "%", background: cardCols[i % cardCols.length] }} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
            {cardEntries.map(([c, v], i) => (
              <div key={c} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: cardCols[i % cardCols.length] }} />
                <span style={{ color: C.sub }}>{c}</span>
                <span style={{ fontFamily: "var(--mono)" }}>{fmt(v)}</span>
                <span style={{ color: C.faint }}>{((v / cardTotal) * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 18 }}>
        <Panel>
          <SectionTitle kicker="Spend over time">Monthly rhythm</SectionTitle>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <AreaChart data={trend} margin={{ left: -12, right: 6, top: 6 }}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.gold} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={C.gold} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtK} tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
                <Tooltip content={<ChartTip />} />
                <ReferenceLine y={A.avgFull} stroke={C.goldDim} strokeDasharray="4 4" />
                <Area dataKey="total" name="Spend" stroke={C.gold} strokeWidth={2} fill="url(#g1)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6 }}>
            Dashed line = average full month ({fmt(A.avgFull)}). First & last months are partial.
          </div>
        </Panel>

        <Panel>
          <SectionTitle kicker="Where it goes">Top categories</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
            {topCats.map((r) => {
              const pct = (r.v / A.totalSpend) * 100;
              const Icon = CAT_META[r.cat]?.icon || CircleDot;
              return (
                <div key={r.cat}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 5 }}>
                    <Icon size={14} style={{ color: catColor(r.cat) }} />
                    <span>{r.cat}</span>
                    <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: C.sub }}>{fmt(r.v)}</span>
                  </div>
                  <div style={{ height: 7, background: C.panel2, borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ width: pct + "%", height: "100%", background: catColor(r.cat), borderRadius: 6 }} />
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => go("analyze")} style={{ marginTop: 18, background: "none", border: `1px solid ${C.line}`, color: C.gold, borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 13, width: "100%" }}>
            Full breakdown →
          </button>
        </Panel>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel>
          <SectionTitle kicker="Most recent">Latest activity</SectionTitle>
          {A.spend.slice().reverse().slice(0, 6).map((t) => (
            <div key={t.gi} className="row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 8px", borderBottom: `1px solid ${C.line}` }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: catColor(t.cat) }} />
              <span style={{ fontSize: 13.5 }}>{t.desc}</span>
              <span style={{ fontSize: 12, color: C.faint, fontFamily: "var(--mono)" }}>{t.date}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", color: C.ink }}>{fmt(t.amount, 2)}</span>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

// ====================== TRANSACTIONS ======================
function Transactions({ txns, setCat }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState("date");
  const [gran, setGran] = useState("month"); // day | week | month (chart + table bucket size)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showChart, setShowChart] = useState(true);
  const [zoom, setZoom] = useState(null); // chart-only drill window: { from, to, gran }

  const bounds = useMemo(() => {
    const ds = txns.map((t) => t.date).sort();
    return { min: ds[0], max: ds[ds.length - 1] };
  }, [txns]);

  const bucketRange = (key, g) => {
    if (g === "month") return [key + "-01", key + "-31"];
    if (g === "week") { const d = new Date(key + "T00:00:00"); d.setDate(d.getDate() + 6); return [key, d.toISOString().slice(0, 10)]; }
    return [key, key]; // day
  };
  const finer = { month: "week", week: "day", day: "day" };

  // TABLE set — filtered by the selected timeframe (from/to), search, then category
  const filtered = useMemo(() => {
    let r = txns.filter((t) => t.amount > 0);
    if (from) r = r.filter((t) => t.date >= from);
    if (to) r = r.filter((t) => t.date <= to);
    if (q.trim()) r = r.filter((t) => t.desc.toLowerCase().includes(q.toLowerCase()));
    return r;
  }, [txns, from, to, q]);
  const list = useMemo(() => {
    const r = filter === "All" ? filtered : filtered.filter((t) => t.cat === filter);
    return [...r].sort((a, b) => (sort === "amount" ? b.amount - a.amount : b.date.localeCompare(a.date)));
  }, [filtered, filter, sort]);
  const total = list.reduce((s, t) => s + t.amount, 0);

  // CHART — independent of the table's timeframe. Only the zoom control narrows/scales it.
  const viewGran = zoom ? zoom.gran : gran;
  const { chart, stackCats } = useMemo(() => {
    let src = txns.filter((t) => t.amount > 0);
    if (q.trim()) src = src.filter((t) => t.desc.toLowerCase().includes(q.toLowerCase()));
    if (zoom) src = src.filter((t) => t.date >= zoom.from && t.date <= zoom.to);
    const catTot = {};
    src.forEach((t) => (catTot[t.cat] = (catTot[t.cat] || 0) + t.amount));
    const top = Object.entries(catTot).sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
    const hasMisc = Object.keys(catTot).length > top.length;
    const bkey = (d) => (viewGran === "day" ? d : viewGran === "week" ? weekStart(d) : d.slice(0, 7));
    const blabel = (k) => (viewGran === "month" ? monthName(k) : k.slice(5));
    const b = {};
    src.forEach((t) => {
      const k = bkey(t.date);
      const row = b[k] || (b[k] = { key: k, label: blabel(k) });
      const cat = top.includes(t.cat) ? t.cat : "Misc";
      row[cat] = (row[cat] || 0) + t.amount;
    });
    return { chart: Object.values(b).sort((a, c) => a.key.localeCompare(c.key)), stackCats: hasMisc ? [...top, "Misc"] : top };
  }, [txns, q, viewGran, zoom]);
  const stackColor = (c) => (c === "Misc" ? "#8a8f98" : catColor(c));
  const dateInput = { background: "none", border: "none", outline: "none", color: C.ink, fontSize: 12.5, fontFamily: "var(--mono)", colorScheme: "dark", cursor: "pointer" };

  // zoom the CHART one level finer into a bucket — leaves the table untouched
  const onZoom = (key) => { if (viewGran === "day" || !key) return; const [f, t] = bucketRange(key, viewGran); setZoom({ from: f, to: t, gran: finer[viewGran] }); };
  // highlight which chart bars fall inside the table's selected timeframe (dim the rest), without rescaling
  const inSel = (key) => {
    if (!from && !to) return true;
    const [bf, bt] = bucketRange(key, viewGran);
    return bf <= (to || "9999-99-99") && bt >= (from || "0000-00-00");
  };

  // click a stacked segment → filter the TABLE by that category + that bucket (does NOT scale the chart)
  const onBarClick = (cat) => (data, index) => {
    const k = (data && (data.key || (data.payload && data.payload.key))) || (chart[index] && chart[index].key);
    if (!k) return;
    const [f, t] = bucketRange(k, viewGran);
    setFrom(f); setTo(t); setFilter(cat === "Misc" ? "All" : cat);
  };
  // click a legend chip → toggle the category filter, keeping any selected timeframe
  const onLegendClick = (cat) => {
    if (cat === "Misc") return;
    setFilter((cur) => (cur === cat ? "All" : cat));
  };

  // explicit timeframe picker for the TABLE at the current granularity
  const tfOptions = useMemo(() => {
    const set = new Set();
    txns.forEach((t) => { if (t.amount > 0) set.add(gran === "day" ? t.date : gran === "week" ? weekStart(t.date) : t.date.slice(0, 7)); });
    return [...set].sort().reverse();
  }, [txns, gran]);
  const tfLabel = (k) => (gran === "month" ? monthName(k) : gran === "week" ? "Wk of " + k.slice(5) : k);
  const selectedTf = tfOptions.find((k) => { const [f, t] = bucketRange(k, gran); return f === from && t === to; }) || "";
  const onTfChange = (val) => { if (!val) { setFrom(""); setTo(""); } else { const [f, t] = bucketRange(val, gran); setFrom(f); setTo(t); } };

  return (
    <div className="rise">
      <SectionTitle kicker="Every line item">Transactions</SectionTitle>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 12px", flex: "1 1 200px" }}>
          <Search size={15} style={{ color: C.faint }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merchant…"
            style={{ background: "none", border: "none", outline: "none", color: C.ink, fontSize: 14, width: "100%" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 9, padding: "7px 11px" }}>
          <input type="date" value={from} min={bounds.min} max={bounds.max} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
          <span style={{ color: C.faint }}>→</span>
          <input type="date" value={to} min={bounds.min} max={bounds.max} onChange={(e) => setTo(e.target.value)} style={dateInput} />
          {(from || to) && (
            <button onClick={() => { setFrom(""); setTo(""); }} title="Clear dates"
              style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, display: "flex" }}><X size={13} /></button>
          )}
        </div>
        <Select value={filter} onChange={setFilter} options={["All", ...Object.keys(CAT_META)]} />
        <Select value={sort} onChange={setSort} options={[["date", "Newest first"], ["amount", "Largest first"]]} />
      </div>

      {/* stacked category mix over time */}
      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: showChart ? 12 : 0, flexWrap: "wrap" }}>
          <div onClick={() => setShowChart((s) => !s)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
            <button title={showChart ? "Hide chart" : "Show chart"}
              style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, display: "flex" }}>
              {showChart ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
            </button>
            <div>
              <div style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: C.gold, marginBottom: 4 }}>Category mix over time</div>
              <div style={{ fontFamily: "var(--display)", fontSize: 20, color: C.ink }}>{showChart ? (zoom ? `Zoomed · by ${viewGran}` : `By ${viewGran}`) : "Hidden — click to show"}</div>
            </div>
          </div>
          {showChart && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {zoom && (
                <button onClick={() => setZoom(null)} title="Reset zoom"
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "5px 10px", borderRadius: 999, cursor: "pointer", border: `1px solid ${C.gold}`, background: "rgba(224,164,88,.12)", color: C.gold }}>
                  <X size={12} /> {zoom.from} → {zoom.to}
                </button>
              )}
              <div style={{ display: "flex", gap: 4 }}>
                {["day", "week", "month"].map((g) => (
                  <button key={g} onClick={() => { setGran(g); setZoom(null); }}
                    style={{ fontSize: 11.5, padding: "5px 12px", borderRadius: 999, cursor: "pointer", textTransform: "capitalize",
                      border: `1px solid ${!zoom && gran === g ? C.gold : C.line}`, background: !zoom && gran === g ? "rgba(224,164,88,.12)" : "transparent", color: !zoom && gran === g ? C.gold : C.sub }}>
                    {g}
                  </button>
                ))}
              </div>
              <Select value={selectedTf} onChange={onTfChange}
                options={[["", `All ${gran}s`], ...tfOptions.map((k) => [k, tfLabel(k)])]} />
            </div>
          )}
        </div>
        {showChart && (
          <>
            <div style={{ height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ left: -12, right: 6 }}>
                  <CartesianGrid stroke={C.line} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={14} />
                  <YAxis tickFormatter={fmtK} tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip content={<ZoomTip onZoom={onZoom} canZoom={viewGran !== "day"} />} cursor={{ fill: "#ffffff08" }} wrapperStyle={{ pointerEvents: "auto" }} />
                  {stackCats.map((c) => (
                    <Bar key={c} dataKey={c} stackId="a" cursor="pointer" onClick={onBarClick(c)}>
                      {chart.map((row) => <Cell key={row.key} fill={stackColor(c)} fillOpacity={inSel(row.key) ? 1 : 0.28} />)}
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", marginTop: 10 }}>
              {stackCats.map((c) => {
                const active = filter === c;
                return (
                  <button key={c} onClick={() => onLegendClick(c)} title={c === "Misc" ? "Other categories" : `Filter table to ${c}`}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: c === "Misc" ? "default" : "pointer",
                      background: active ? "rgba(224,164,88,.12)" : "none", border: `1px solid ${active ? C.gold : "transparent"}`,
                      borderRadius: 999, padding: "3px 9px", color: active ? C.gold : C.sub }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: stackColor(c) }} />{c}
                  </button>
                );
              })}
              <span style={{ fontSize: 11, color: C.faint, marginLeft: 4 }}>· click a bar to filter the table by that {viewGran} + category · hover a bar &amp; hit Zoom to drill the chart · chips filter by category</span>
            </div>
          </>
        )}
      </Panel>

      <div style={{ fontSize: 12.5, color: C.sub, margin: "16px 0 10px", fontFamily: "var(--mono)" }}>
        {list.length} items · {fmt(total, 2)}{filter !== "All" ? ` in ${filter}` : ""}{(from || to) ? ` · ${from || bounds.min} → ${to || bounds.max}` : ""}
      </div>
      <div className="scrollwrap" style={{ maxHeight: 560, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 12 }}>
        {list.map((t) => {
          const Icon = CAT_META[t.cat]?.icon || CircleDot;
          return (
            <div key={t.gi} className="row" style={{ display: "grid", gridTemplateColumns: "84px 1fr 190px 92px", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.line}` }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: C.faint }}>{t.date.slice(5)}</span>
              <span style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8 }}>
                {t.desc}
                <span style={{ fontSize: 9.5, color: C.faint, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0, fontFamily: "var(--mono)" }}>
                  {t.card === "Card 1" ? "C1" : "2877"}
                </span>
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Icon size={13} style={{ color: catColor(t.cat), flexShrink: 0 }} />
                <select value={t.cat} onChange={(e) => setCat(t.gi, e.target.value)}
                  style={{ background: C.panel2, border: `1px solid ${C.line}`, color: C.sub, borderRadius: 7, padding: "4px 6px", fontSize: 11.5, width: "100%", cursor: "pointer" }}>
                  {Object.keys(CAT_META).map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: C.ink }}>{fmt(t.amount, 2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ====================== CATEGORIES ======================
function CatSelect({ value, onChange }) {
  return (
    <select value={value} onChange={onChange} onClick={(e) => e.stopPropagation()}
      style={{ background: C.panel2, border: `1px solid ${C.line}`, color: C.sub, borderRadius: 7, padding: "4px 6px", fontSize: 11.5, cursor: "pointer", maxWidth: 170 }}>
      {Object.keys(CAT_META).map((c) => <option key={c}>{c}</option>)}
    </select>
  );
}

// inline comment: shows the saved note, click to edit; Enter saves, Esc cancels, blur saves
function NoteLine({ note, editing, onStartEdit, onSave }) {
  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 8, alignItems: "center", padding: "0 14px 9px 30px" }}>
      <MessageSquare size={12} style={{ color: C.faint, flexShrink: 0 }} />
      {editing ? (
        <input autoFocus defaultValue={note || ""} placeholder="Add a comment…"
          onBlur={(e) => onSave(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = note || ""; e.target.blur(); } }}
          style={{ flex: 1, maxWidth: 520, background: C.panel2, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 7, padding: "6px 9px", fontSize: 12.5, outline: "none" }} />
      ) : (
        <span onClick={onStartEdit} style={{ fontSize: 12.5, color: C.sub, cursor: "text", fontStyle: "italic" }}>{note}</span>
      )}
    </div>
  );
}

// monthly spend timeline with a dashed average line
function SpendTimeline({ data, color, label }) {
  const total = data.reduce((s, m) => s + m.v, 0);
  const active = data.filter((m) => m.v > 0).length;
  const avg = data.length ? total / data.length : 0;
  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 18, color: C.ink }}>{label}</div>
        <div style={{ fontSize: 12.5, color: C.sub, fontFamily: "var(--mono)", marginLeft: "auto" }}>
          avg <b style={{ color: C.gold }}>{fmt(avg)}</b>/mo · total {fmt(total)} · {active}/{data.length} mo active
        </div>
      </div>
      <div style={{ height: 180 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ left: -12, right: 6 }}>
            <CartesianGrid stroke={C.line} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtK} tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
            <Tooltip content={<ChartTip />} cursor={{ fill: "#ffffff08" }} />
            <ReferenceLine y={avg} stroke={C.gold} strokeDasharray="4 4" label={{ value: "avg", fill: C.gold, fontSize: 10, position: "right" }} />
            <Bar dataKey="v" name={label} fill={color} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function Categories({ txns, excluded, toggleExcluded, setCat, setCatForMerch, setCatForKey, providerNotes, txnNotes, setNoteForKey, setNoteForTxn }) {
  const [selCat, setSelCat] = useState(null);
  const [selMerch, setSelMerch] = useState(null);
  const [grouped, setGrouped] = useState(true); // merge similar provider names
  const [noteEdit, setNoteEdit] = useState(null); // which row's comment is being edited

  const spend = useMemo(() => txns.filter((t) => t.amount > 0 && t.cat !== "Payments & Credits"), [txns]);

  // level 1 — categories
  const cats = useMemo(() => {
    const m = {};
    spend.forEach((t) => {
      const r = (m[t.cat] = m[t.cat] || { cat: t.cat, v: 0, n: 0, merch: new Set() });
      r.v += t.amount; r.n++; r.merch.add(grouped ? merchKey(t.desc) : t.desc);
    });
    return Object.values(m)
      .map((r) => ({ cat: r.cat, v: r.v, n: r.n, providers: r.merch.size, excluded: excluded.has(r.cat) }))
      .sort((a, b) => b.v - a.v);
  }, [spend, excluded, grouped]);
  const activeTotal = cats.filter((c) => !c.excluded).reduce((s, c) => s + c.v, 0);
  const maxV = Math.max(1, ...cats.map((c) => c.v));

  // level 2 — providers within selected category
  const providers = useMemo(() => {
    if (!selCat) return [];
    const m = {};
    spend.filter((t) => t.cat === selCat).forEach((t) => {
      const key = grouped ? merchKey(t.desc) : t.desc;
      const r = (m[key] = m[key] || { key, mkey: merchKey(t.desc), label: grouped ? merchClean(t.desc) : t.desc, v: 0, n: 0, variants: new Set() });
      r.v += t.amount; r.n++; r.variants.add(t.desc);
    });
    return Object.values(m).sort((a, b) => b.v - a.v);
  }, [spend, selCat, grouped]);
  const provTotal = providers.reduce((s, p) => s + p.v, 0);

  // level 3 — transactions for the selected provider (exact desc, or all variants when grouped)
  const rows = useMemo(() => {
    if (!selCat || !selMerch) return [];
    return spend.filter((t) => t.cat === selCat && (grouped ? merchKey(t.desc) === selMerch : t.desc === selMerch))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [spend, selCat, selMerch, grouped]);

  // monthly timeline series (zero-filled across the active window) for the selected category / provider
  const allMonths = useMemo(() => Array.from(new Set(spend.map((t) => t.date.slice(0, 7)))).sort(), [spend]);
  const series = (txList) => {
    const by = {};
    txList.forEach((t) => (by[t.date.slice(0, 7)] = (by[t.date.slice(0, 7)] || 0) + t.amount));
    return allMonths.map((ym) => ({ label: monthName(ym), v: by[ym] || 0 }));
  };
  const catSeries = useMemo(() => (selCat ? series(spend.filter((t) => t.cat === selCat)) : []), [spend, selCat, allMonths]);
  const provSeries = useMemo(() => (selMerch ? series(rows) : []), [rows, allMonths, selMerch]);

  const crumb = (label, onClick, active) => (
    <button onClick={onClick} disabled={active}
      style={{ background: "none", border: "none", cursor: active ? "default" : "pointer", padding: 0,
        color: active ? C.ink : C.gold, fontSize: 14, fontWeight: active ? 600 : 400, fontFamily: "var(--ui)" }}>
      {label}
    </button>
  );

  return (
    <div className="rise">
      <SectionTitle kicker="Drill down · category → provider → transaction">Categories</SectionTitle>

      {/* breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {crumb("All categories", () => { setSelCat(null); setSelMerch(null); }, !selCat)}
        {selCat && <><ChevronRight size={14} style={{ color: C.faint }} />{crumb(selCat, () => setSelMerch(null), !selMerch)}</>}
        {selMerch && <><ChevronRight size={14} style={{ color: C.faint }} />{crumb(selMerch, null, true)}</>}
      </div>

      {/* muted-categories banner */}
      {excluded.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "rgba(224,164,88,.08)", border: `1px solid ${C.goldDim}`, borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
          <EyeOff size={14} style={{ color: C.gold }} />
          <span style={{ fontSize: 12.5, color: C.sub }}>
            {excluded.size} categor{excluded.size > 1 ? "ies" : "y"} muted · re-evaluated spend <b style={{ color: C.ink, fontFamily: "var(--mono)" }}>{fmt(activeTotal)}</b>
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
            {[...excluded].map((c) => (
              <button key={c} onClick={() => toggleExcluded(c)}
                style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "3px 8px", borderRadius: 999, cursor: "pointer", border: `1px solid ${C.line}`, background: C.panel2, color: C.sub }}>
                {c} <X size={11} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LEVEL 1 — categories table */}
      {!selCat && (
        <>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 8, fontFamily: "var(--mono)" }}>
            Avg/mo = cumulative ÷ {allMonths.length} month{allMonths.length > 1 ? "s" : ""} in the selected period
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "26px 1fr 104px 100px 48px 52px 34px 20px", gap: 10, padding: "0 14px 8px", fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase", color: C.faint }}>
            <span /><span>Category</span>
            <span style={{ textAlign: "right" }}>Cumulative</span>
            <span style={{ textAlign: "right" }}>Avg/mo</span>
            <span style={{ textAlign: "right" }}>Share</span>
            <span style={{ textAlign: "right" }}>Prov</span>
            <span /><span />
          </div>
          <div className="scrollwrap" style={{ maxHeight: 580, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 12 }}>
            {cats.map((c) => {
              const Icon = CAT_META[c.cat]?.icon || CircleDot;
              const avg = allMonths.length ? c.v / allMonths.length : 0;
              return (
                <div key={c.cat} className="row" onClick={() => setSelCat(c.cat)}
                  style={{ display: "grid", gridTemplateColumns: "26px 1fr 104px 100px 48px 52px 34px 20px", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: `1px solid ${C.line}`, cursor: "pointer", opacity: c.excluded ? 0.4 : 1 }}>
                  <Icon size={16} style={{ color: catColor(c.cat) }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: C.ink, textDecoration: c.excluded ? "line-through" : "none" }}>{c.cat}</div>
                    <div style={{ height: 4, borderRadius: 3, marginTop: 5, background: C.panel2 }}>
                      <div style={{ height: "100%", width: (c.v / maxV) * 100 + "%", background: catColor(c.cat), borderRadius: 3 }} />
                    </div>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: C.ink, fontSize: 13.5 }}>{fmt(c.v)}</span>
                  <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: C.gold, fontSize: 12.5 }}>{fmt(avg)}</span>
                  <span style={{ fontFamily: "var(--mono)", textAlign: "right", fontSize: 12, color: C.faint }}>{activeTotal ? ((c.v / activeTotal) * 100).toFixed(0) : 0}%</span>
                  <span style={{ fontSize: 11, color: C.faint, textAlign: "right" }}>{c.providers}</span>
                  <button title={c.excluded ? "Include in totals" : "Mute from totals"} onClick={(e) => { e.stopPropagation(); toggleExcluded(c.cat); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: c.excluded ? C.faint : C.gold, display: "flex", justifyContent: "center" }}>
                    {c.excluded ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <ChevronRight size={15} style={{ color: C.faint }} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* LEVEL 2 — providers within the category */}
      {selCat && !selMerch && (
        <>
          <div style={{ marginBottom: 18 }}>
            <SpendTimeline data={catSeries} color={catColor(selCat)} label={selCat} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12.5, color: C.sub, fontFamily: "var(--mono)" }}>
              {providers.length} {grouped ? "providers · similar names merged" : "exact providers"} · {fmt(provTotal, 2)} in {selCat}
            </div>
            <button onClick={() => { setGrouped((g) => !g); setSelMerch(null); }}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "5px 10px", borderRadius: 999, cursor: "pointer",
                border: `1px solid ${grouped ? C.gold : C.line}`, background: grouped ? "rgba(224,164,88,.12)" : "transparent", color: grouped ? C.gold : C.sub }}>
              <Layers size={13} /> Group similar names · {grouped ? "On" : "Off"}
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 10 }}>
            Change a provider's category to re-file all its transactions{grouped ? " — including every name variant in the group." : "."}
          </div>
          <div className="scrollwrap" style={{ maxHeight: 540, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 12 }}>
            {providers.map((p) => {
              const note = providerNotes[p.mkey];
              const editing = noteEdit === "P:" + p.mkey;
              return (
                <div key={p.key} style={{ borderBottom: `1px solid ${C.line}` }}>
                  <div className="row" onClick={() => setSelMerch(p.key)}
                    style={{ display: "grid", gridTemplateColumns: "1fr 168px 92px 40px 26px 22px", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                      {grouped && p.variants.size > 1 && (
                        <span title={[...p.variants].join("\n")}
                          style={{ fontSize: 9.5, color: C.faint, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0, fontFamily: "var(--mono)" }}>
                          ≈{p.variants.size}
                        </span>
                      )}
                    </span>
                    <CatSelect value={selCat} onChange={(e) => (grouped ? setCatForKey(p.key, e.target.value) : setCatForMerch(p.key, e.target.value))} />
                    <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: C.ink }}>{fmt(p.v, 2)}</span>
                    <span style={{ fontSize: 11, color: C.faint, textAlign: "right" }}>{p.n}×</span>
                    <button title={note ? "Edit comment" : "Add comment"} onClick={(e) => { e.stopPropagation(); setNoteEdit(editing ? null : "P:" + p.mkey); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: note ? C.gold : C.faint, display: "flex", justifyContent: "center" }}>
                      <MessageSquare size={14} />
                    </button>
                    <ChevronRight size={15} style={{ color: C.faint }} />
                  </div>
                  {(editing || note) && (
                    <NoteLine note={note} editing={editing}
                      onStartEdit={() => setNoteEdit("P:" + p.mkey)}
                      onSave={(val) => { setNoteForKey(p.mkey, val); setNoteEdit(null); }} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* LEVEL 3 — transactions for the provider */}
      {selCat && selMerch && (
        <>
          <div style={{ marginBottom: 18 }}>
            <SpendTimeline data={provSeries} color={catColor(selCat)} label={selMerch} />
          </div>
          <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 10, fontFamily: "var(--mono)" }}>
            {rows.length} transactions · {fmt(rows.reduce((s, t) => s + t.amount, 0), 2)} — recategorize or comment any single line below
          </div>
          <div className="scrollwrap" style={{ maxHeight: 480, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 12 }}>
            {rows.map((t) => {
              const note = txnNotes[txnSig(t)];
              const editing = noteEdit === "T:" + t.gi;
              return (
                <div key={t.gi} style={{ borderBottom: `1px solid ${C.line}` }}>
                  <div className="row" style={{ display: "grid", gridTemplateColumns: "92px 1fr 168px 92px 26px", alignItems: "center", gap: 10, padding: "10px 14px" }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: C.faint }}>{t.date}</span>
                    <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.desc}</span>
                      <span style={{ fontSize: 9.5, color: C.faint, border: `1px solid ${C.line}`, borderRadius: 4, padding: "1px 5px", flexShrink: 0, fontFamily: "var(--mono)" }}>
                        {t.card === "Card 1" ? "C1" : t.card === "TD Checking" ? "CHQ" : "2877"}
                      </span>
                    </span>
                    <CatSelect value={t.cat} onChange={(e) => setCat(t.gi, e.target.value)} />
                    <span style={{ fontFamily: "var(--mono)", textAlign: "right", color: C.ink }}>{fmt(t.amount, 2)}</span>
                    <button title={note ? "Edit comment" : "Add comment"} onClick={() => setNoteEdit(editing ? null : "T:" + t.gi)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: note ? C.gold : C.faint, display: "flex", justifyContent: "center" }}>
                      <MessageSquare size={14} />
                    </button>
                  </div>
                  {(editing || note) && (
                    <NoteLine note={note} editing={editing}
                      onStartEdit={() => setNoteEdit("T:" + t.gi)}
                      onSave={(val) => { setNoteForTxn(t.gi, val); setNoteEdit(null); }} />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ====================== ANALYZE ======================
function Analyze({ A }) {
  const pie = A.catRows.map((r) => ({ name: r.cat, value: r.v }));
  // stacked monthly
  const stackCats = A.catRows.slice(0, 6).map((r) => r.cat);
  const stack = A.months.map((m) => {
    const o = { label: monthName(m.ym) };
    stackCats.forEach((c) => (o[c] = m[c] || 0));
    return o;
  });

  return (
    <div className="rise">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
        <Panel>
          <SectionTitle kicker="Composition">Category split</SectionTitle>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ width: 200, height: 220 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pie} dataKey="value" innerRadius={56} outerRadius={92} paddingAngle={2} stroke="none">
                    {pie.map((p, i) => <Cell key={i} fill={catColor(p.name)} />)}
                  </Pie>
                  <Tooltip content={<ChartTip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
              {A.catRows.map((r) => (
                <div key={r.cat} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: catColor(r.cat) }} />
                  <span style={{ color: C.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.cat}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11.5 }}>{((r.v / A.totalSpend) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel>
          <SectionTitle kicker="Recurring drains">Subscriptions & habits</SectionTitle>
          <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 10 }}>Merchants you hit in 3+ months — the quiet monthly leaks.</div>
          <div className="scrollwrap" style={{ maxHeight: 200, overflow: "auto" }}>
            {A.recurring.slice(0, 12).map((m) => (
              <div key={m.desc} className="row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 6px", borderBottom: `1px solid ${C.line}` }}>
                <Repeat size={13} style={{ color: catColor(m.cat) }} />
                <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.desc}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: C.faint, fontFamily: "var(--mono)" }}>{m.mo}mo</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, width: 78, textAlign: "right" }}>{fmt(m.perMo)}<span style={{ color: C.faint }}>/mo</span></span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel>
        <SectionTitle kicker="Trends">Category flow by month</SectionTitle>
        <div style={{ height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={stack} margin={{ left: -12, right: 6 }}>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<ChartTip />} cursor={{ fill: "#ffffff08" }} />
              {stackCats.map((c) => <Bar key={c} dataKey={c} stackId="a" fill={catColor(c)} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div style={{ marginTop: 18 }}>
        <Panel>
          <SectionTitle kicker="The big tickets">Top 12 merchants</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 28px" }}>
            {A.merchants.slice(0, 12).map((m, i) => (
              <div key={m.desc} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.line}` }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: C.faint, width: 20 }}>{i + 1}</span>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: catColor(m.cat) }} />
                <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.desc}</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12.5 }}>{fmt(m.v)}</span>
                <span style={{ fontSize: 10.5, color: C.faint, width: 32, textAlign: "right" }}>{m.n}×</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ====================== FORECAST ======================
function Forecast({ A }) {
  const [horizon, setHorizon] = useState(6);
  const [model, setModel] = useState("avg3"); // avg3 | full | trend

  const base = model === "avg3" ? A.avg3 : model === "full" ? A.avgFull : null;

  // simple linear trend on full months
  const trendFn = useMemo(() => {
    const pts = A.fullMonths.map((m, i) => [i, m.total]);
    const n = pts.length;
    const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept, n };
  }, [A.fullMonths]);

  const data = useMemo(() => {
    const hist = A.fullMonths.map((m) => ({ label: monthName(m.ym), actual: Math.round(m.total) }));
    const last = A.fullMonths[A.fullMonths.length - 1];
    const startD = new Date(last.ym + "-01");
    const out = [...hist];
    for (let k = 1; k <= horizon; k++) {
      const d = new Date(startD); d.setMonth(d.getMonth() + k);
      const ym = d.toISOString().slice(0, 7);
      let v = base;
      if (model === "trend") v = trendFn.intercept + trendFn.slope * (trendFn.n - 1 + k);
      out.push({ label: monthName(ym), forecast: Math.max(0, Math.round(v)) });
    }
    // bridge: give last actual a forecast value too so the line connects
    out[hist.length - 1].forecast = out[hist.length - 1].actual;
    return out;
  }, [A.fullMonths, horizon, base, model, trendFn]);

  const projTotal = data.filter((d) => d.forecast && !d.actual).reduce((s, d) => s + d.forecast, 0)
    + (data[A.fullMonths.length - 1]?.forecast === data[A.fullMonths.length - 1]?.actual ? 0 : 0);
  const monthlyProj = projTotal / horizon;
  const annual = monthlyProj * 12;

  return (
    <div className="rise">
      <SectionTitle kicker="Looking ahead">Forecast the next {horizon} months</SectionTitle>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <Select value={model} onChange={setModel} options={[["avg3", "Recent 3-month average"], ["full", "All-months average"], ["trend", "Linear trend"]]} />
        <Select value={String(horizon)} onChange={(v) => setHorizon(+v)} options={[["3", "3 months"], ["6", "6 months"], ["12", "12 months"]]} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 14, marginBottom: 22 }}>
        <Stat label="Projected next month" value={fmt(model === "trend" ? data.find(d => d.forecast && !d.actual)?.forecast : base)} accent={C.gold} />
        <Stat label={`Projected ${horizon}-mo total`} value={fmtK(monthlyProj * horizon)} sub="cumulative spend ahead" />
        <Stat label="Implied annual spend" value={fmtK(annual)} />
      </div>

      <Panel>
        <div style={{ height: 320 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ left: -12, right: 10, top: 6 }}>
              <CartesianGrid stroke={C.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fill: C.faint, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
              <Tooltip content={<ChartTip />} />
              <ReferenceLine y={A.avgFull} stroke={C.goldDim} strokeDasharray="4 4" />
              <Line dataKey="actual" name="Actual" stroke={C.ink} strokeWidth={2.4} dot={{ r: 3, fill: C.ink }} connectNulls />
              <Line dataKey="forecast" name="Forecast" stroke={C.gold} strokeWidth={2.4} strokeDasharray="6 5" dot={{ r: 3, fill: C.gold }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginTop: 10, lineHeight: 1.55 }}>
          {model === "trend"
            ? `Linear-trend model: spending is ${trendFn.slope >= 0 ? "rising" : "easing"} about ${fmt(Math.abs(trendFn.slope))}/month based on your full-month history.`
            : model === "avg3"
            ? `Flat projection at your recent 3-month average of ${fmt(A.avg3)}/month.`
            : `Flat projection at your all-months average of ${fmt(A.avgFull)}/month.`}
          {" "}Big one-offs (flights, a car payment) make single months spike — treat these as a baseline, not a promise.
        </div>
      </Panel>
    </div>
  );
}

// ====================== LIFESTYLE ======================
function Lifestyle({ A }) {
  const monthlyByCat = useMemo(() => {
    const o = {};
    SPEND_CATS.forEach((c) => {
      const total = A.byCat[c] || 0;
      o[c] = total / (A.days / 30.44); // monthly equivalent
    });
    return o;
  }, [A]);

  const [cut, setCut] = useState(() => {
    const o = {}; SPEND_CATS.forEach((c) => (o[c] = 0)); return o;
  });

  const SCENARIOS = [
    { name: "Cook at home", desc: "−40% dining, −15% groceries", apply: { "Dining & Coffee": 40, "Groceries": 15 } },
    { name: "Drive less", desc: "−35% transport & fuel", apply: { "Transport & Fuel": 35 } },
    { name: "Trim the digital", desc: "−60% subscriptions", apply: { "Subscriptions & Digital": 60 } },
    { name: "Slow travel year", desc: "−50% travel", apply: { "Travel": 50 } },
    { name: "Mindful spending", desc: "−25% shopping & entertainment", apply: { "Shopping & Retail": 25, "Entertainment": 25 } },
    { name: "Reset all", desc: "clear every slider", apply: null },
  ];
  const applyScenario = (s) => {
    if (!s.apply) { const o = {}; SPEND_CATS.forEach((c) => (o[c] = 0)); setCut(o); return; }
    setCut((p) => { const o = { ...p }; Object.entries(s.apply).forEach(([k, v]) => (o[k] = v)); return o; });
  };

  const baseMonthly = SPEND_CATS.reduce((s, c) => s + (monthlyByCat[c] || 0), 0);
  const savedMonthly = SPEND_CATS.reduce((s, c) => s + (monthlyByCat[c] || 0) * (cut[c] / 100), 0);
  const newMonthly = baseMonthly - savedMonthly;
  const savedAnnual = savedMonthly * 12;

  const FUNDS = [
    savedAnnual >= 12000 ? "a serious chunk of a year's mortgage or rent" :
    savedAnnual >= 6000 ? "a family vacation, fully paid in cash" :
    savedAnnual >= 3000 ? "an emergency fund built in a single year" :
    savedAnnual >= 1000 ? "a healthy start to next year's savings" :
    "a few nice dinners — nudge the sliders for more",
  ][0];

  return (
    <div className="rise">
      <SectionTitle kicker="What if">Lifestyle & savings projector</SectionTitle>
      <div style={{ fontSize: 13.5, color: C.sub, marginBottom: 18, maxWidth: 640, lineHeight: 1.6 }}>
        Pull each lever to dial back a category. Everything recalculates against your real monthly averages, then projects the change out over a year.
      </div>

      {/* scenarios */}
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 22 }}>
        {SCENARIOS.map((s) => (
          <button key={s.name} onClick={() => applyScenario(s)} title={s.desc}
            style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 10, padding: "9px 14px", cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
            <div style={{ fontSize: 11, color: C.faint }}>{s.desc}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 18 }}>
        {/* sliders */}
        <Panel>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {A.catRows.filter((r) => SPEND_CATS.includes(r.cat)).map((r) => {
              const c = r.cat, mo = monthlyByCat[c] || 0, pct = cut[c];
              const Icon = CAT_META[c]?.icon || CircleDot;
              return (
                <div key={c}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                    <Icon size={14} style={{ color: catColor(c) }} />
                    <span style={{ fontSize: 13 }}>{c}</span>
                    <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12, color: C.sub }}>{fmt(mo)}/mo</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: pct ? C.gold : C.faint, width: 44, textAlign: "right" }}>−{pct}%</span>
                  </div>
                  <input type="range" min={0} max={100} value={pct}
                    onChange={(e) => setCut((p) => ({ ...p, [c]: +e.target.value }))}
                    style={{ width: "100%", accentColor: catColor(c), cursor: "pointer" }} />
                </div>
              );
            })}
          </div>
        </Panel>

        {/* result */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "linear-gradient(160deg,#1c2030,#14171f)", border: `1px solid ${C.goldDim}`, borderRadius: 16, padding: 22 }}>
            <div style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: C.gold }}>Projected annual savings</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 42, color: C.gold, margin: "8px 0 4px", lineHeight: 1 }}>{fmt(savedAnnual)}</div>
            <div style={{ fontSize: 13, color: C.sub }}>{fmt(savedMonthly)} every month back in your pocket</div>
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 16, paddingTop: 14, fontSize: 13.5, color: C.ink, lineHeight: 1.5 }}>
              That's <span style={{ color: C.gold }}>{FUNDS}</span>.
            </div>
          </div>

          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20 }}>
            <Compare label="Monthly spend" before={baseMonthly} after={newMonthly} />
            <div style={{ height: 14 }} />
            <Compare label="Annual spend" before={baseMonthly * 12} after={newMonthly * 12} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Compare({ label, before, after }) {
  const dropPct = before ? ((before - after) / before) * 100 : 0;
  return (
    <div>
      <div style={{ fontSize: 11.5, letterSpacing: ".1em", textTransform: "uppercase", color: C.faint, marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 16, color: C.sub, textDecoration: dropPct > 0.5 ? "line-through" : "none", textDecorationColor: C.faint }}>{fmt(before)}</span>
        {dropPct > 0.5 && <>
          <ArrowDownRight size={16} style={{ color: "#6cc4a1" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 22, color: C.ink }}>{fmt(after)}</span>
          <span style={{ fontSize: 12.5, color: "#6cc4a1", fontFamily: "var(--mono)" }}>−{dropPct.toFixed(0)}%</span>
        </>}
      </div>
    </div>
  );
}

// ---------- small ui ----------
function Panel({ children }) {
  return <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 22 }}>{children}</div>;
}
function Select({ value, onChange, options }) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: C.panel, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 9, padding: "10px 14px", fontSize: 13.5, cursor: "pointer" }}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
