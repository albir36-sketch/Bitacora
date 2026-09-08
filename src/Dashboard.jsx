import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { Plus, X, Trash2, CheckCircle2, RotateCcw, LogOut } from "lucide-react";
import { supabase } from "./supabaseClient";

const fmt = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const uid = () => Math.random().toString(36).slice(2, 10);

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_API_KEY;
const TRADIER_TOKEN = import.meta.env.VITE_TRADIER_TOKEN;
const TRADIER_BASE = "https://sandbox.tradier.com/v1";

async function fetchQuote(ticker) {
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`Error al consultar ${ticker}`);
  const data = await res.json();
  if (data.c == null || data.c === 0) throw new Error(`Sin datos para ${ticker}`);
  return data.c;
}

// Construye el símbolo de opción estilo OCC que espera Tradier, p.ej. AAPL260117C00150000
function buildOccSymbol(ticker, expirationISO, optionType, strike) {
  if (!ticker || !expirationISO || !strike) return null;
  const d = new Date(expirationISO + "T00:00:00");
  if (Number.isNaN(d.getTime())) return null;
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const cp = optionType === "put" ? "P" : "C";
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker.toUpperCase()}${yy}${mm}${dd}${cp}${strikeStr}`;
}

// Pide cotizaciones a Tradier para una lista de símbolos OCC, devuelve { symbol: price }
async function fetchOptionQuotes(occSymbols) {
  const unique = [...new Set(occSymbols.filter(Boolean))];
  if (unique.length === 0 || !TRADIER_TOKEN) return {};
  const res = await fetch(`${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(unique.join(","))}&greeks=false`, {
    headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Error al consultar precios de opciones en Tradier");
  const data = await res.json();
  let quotes = data?.quotes?.quote;
  if (!quotes) return {};
  if (!Array.isArray(quotes)) quotes = [quotes];
  const map = {};
  for (const q of quotes) {
    const last = q.last ?? (q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null);
    if (last != null) map[q.symbol] = last;
  }
  return map;
}

function legPnL(leg) {
  if (leg.closePrice == null) return 0;
  return leg.action === "sell" ? (leg.price - leg.closePrice) : (leg.closePrice - leg.price);
}
function optionPnL(t) {
  if (t.status === "assigned") return 0; // el resultado ya quedó reflejado en el trade de acciones vinculado
  if (t.status !== "closed") return 0;
  const legs = t.legs || [];
  const perContract = legs.reduce((s, l) => s + legPnL(l), 0);
  return perContract * t.qty * 100 - (t.commission || 0) - (t.closeCommission || 0);
}
// Calcula el precio efectivo (y la acción) del trade de acciones que se genera al asignar/ejercer
// una opción de una sola pata, incorporando la prima cobrada/pagada y la comisión de apertura.
function assignmentStockTrade(t) {
  const leg = (t.legs || [])[0];
  if (!leg) return null;
  const shares = t.qty * 100;
  const commissionPerShare = shares > 0 ? (t.commission || 0) / shares : 0;
  let price, action;
  if (leg.action === "sell" && leg.optionType === "put") {
    // CSP asignada: te compran (te obligan a comprar) acciones al strike; la prima cobrada rebaja tu costo
    action = "buy";
    price = leg.strike - leg.price + commissionPerShare;
  } else if (leg.action === "sell" && leg.optionType === "call") {
    // CC asignada: te retiran (vendes) las acciones al strike; la prima cobrada se suma a lo recibido
    action = "sell";
    price = leg.strike + leg.price - commissionPerShare;
  } else if (leg.action === "buy" && leg.optionType === "call") {
    // Call comprada, ejercida: compras acciones al strike; la prima pagada se suma a tu costo
    action = "buy";
    price = leg.strike + leg.price + commissionPerShare;
  } else {
    // Put comprada, ejercida: vendes acciones al strike; la prima pagada rebaja lo recibido
    action = "sell";
    price = leg.strike - leg.price - commissionPerShare;
  }
  return { action, price: Math.max(0, price), shares };
}
function legLabel(l) {
  return `${l.action === "sell" ? "Venta" : "Compra"} ${l.optionType === "put" ? "Put" : "Call"} $${l.strike}`;
}
function tradeLabel(t) {
  if (t.type === "stock") return t.action === "buy" ? "Compra" : "Venta";
  const legs = t.legs || [];
  if (legs.length <= 1) return legs[0] ? legLabel(legs[0]) : "Opción";
  return `Spread (${legs.length} patas)`;
}
// P&L no realizado de una opción abierta, usando precios de mercado (occSymbol -> precio) si están disponibles
function unrealizedOptionPnL(t, markPrices) {
  if (t.status === "closed" || t.status === "assigned") return null;
  const legs = t.legs || [];
  let perContract = 0;
  let anyMark = false;
  for (const l of legs) {
    const occ = buildOccSymbol(t.ticker, t.expiration, l.optionType, l.strike);
    const mark = occ && markPrices ? markPrices[occ] : null;
    if (mark == null) continue;
    anyMark = true;
    perContract += l.action === "sell" ? (l.price - mark) : (mark - l.price);
  }
  if (!anyMark) return null;
  return perContract * t.qty * 100 - (t.commission || 0);
}

export default function Dashboard({ session }) {
  const [trades, setTrades] = useState([]);
  const [prices, setPrices] = useState({});
  const [cashTx, setCashTx] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddCash, setShowAddCash] = useState(false);
  const [closingTrade, setClosingTrade] = useState(null);
  const [tab, setTab] = useState("open");
  const [period, setPeriod] = useState("mtd");
  const [refreshing, setRefreshing] = useState(false);
  const [markPrices, setMarkPrices] = useState({});
  const autoRefreshedRef = useRef(false);
  const autoRefreshedOptionsRef = useRef(false);

  const userId = session.user.id;

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    setError("");
    const [{ data: tradeRows, error: tErr }, { data: priceRows, error: pErr }, { data: cashRows, error: cErr }] = await Promise.all([
      supabase.from("trades").select("*").order("date", { ascending: true }),
      supabase.from("current_prices").select("*"),
      supabase.from("cash_transactions").select("*").order("date", { ascending: true }),
    ]);
    if (tErr) setError(tErr.message);
    if (pErr) setError((e) => e || pErr.message);
    if (cErr) setError((e) => e || cErr.message);
    setTrades((tradeRows || []).map(fromRow));
    const pMap = {};
    (priceRows || []).forEach((r) => { pMap[r.ticker] = Number(r.price); });
    setPrices(pMap);
    setCashTx((cashRows || []).map((r) => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount), notes: r.notes })));
    setLoading(false);
  }

  function fromRow(r) {
    return {
      id: r.id, type: r.type, ticker: r.ticker, date: r.date, qty: Number(r.qty),
      price: r.price != null ? Number(r.price) : null, action: r.action,
      legs: r.legs || null, status: r.status, closeDate: r.close_date,
      notes: r.notes, expiration: r.expiration || null,
      commission: r.commission != null ? Number(r.commission) : 0,
      closeCommission: r.close_commission != null ? Number(r.close_commission) : 0,
    };
  }

  async function addTrade(data) {
    setError("");
    const row = {
      user_id: userId, type: data.type, ticker: data.ticker, date: data.date, qty: data.qty,
      price: data.price ?? null, action: data.action ?? null, legs: data.legs ?? null,
      status: data.type === "option" ? "open" : null, notes: data.notes || null,
      commission: data.commission ?? 0, expiration: data.expiration || null,
    };
    const { data: inserted, error: err } = await supabase.from("trades").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setTrades((prev) => [...prev, fromRow(inserted)]);
    setShowAdd(false);
  }

  async function deleteTrade(id) {
    setTrades((prev) => prev.filter((t) => t.id !== id));
    const { error: err } = await supabase.from("trades").delete().eq("id", id);
    if (err) { setError(err.message); loadAll(); }
  }

  async function closeOptionTrade(id, closeDate, legCloses, closeCommission) {
    const target = trades.find((t) => t.id === id);
    const newLegs = target.legs.map((l, i) => ({ ...l, closePrice: Number(legCloses[i]) }));
    const cc = Number(closeCommission) || 0;
    const { error: err } = await supabase
      .from("trades")
      .update({ status: "closed", close_date: closeDate, legs: newLegs, close_commission: cc })
      .eq("id", id);
    if (err) { setError(err.message); return; }
    setTrades((prev) => prev.map((t) => (t.id === id ? { ...t, status: "closed", closeDate, legs: newLegs, closeCommission: cc } : t)));
    setClosingTrade(null);
  }

  async function assignOptionTrade(id, assignDate) {
    setError("");
    const target = trades.find((t) => t.id === id);
    const calc = assignmentStockTrade(target);
    if (!calc) { setError("No se pudo calcular la asignación de esta opción."); return; }

    const stockRow = {
      user_id: userId, type: "stock", ticker: target.ticker, date: assignDate, qty: calc.shares,
      price: Math.round(calc.price * 100) / 100, action: calc.action, legs: null, status: null,
      commission: 0, expiration: null,
      notes: `Asignación/ejercicio de opción ${legLabel(target.legs[0])} venc. ${target.expiration || ""}`,
    };
    const { data: insertedStock, error: err1 } = await supabase.from("trades").insert(stockRow).select().single();
    if (err1) { setError(err1.message); return; }

    const { error: err2 } = await supabase
      .from("trades")
      .update({ status: "assigned", close_date: assignDate })
      .eq("id", id);
    if (err2) { setError(err2.message); return; }

    setTrades((prev) => [
      ...prev.map((t) => (t.id === id ? { ...t, status: "assigned", closeDate: assignDate } : t)),
      fromRow(insertedStock),
    ]);
    setClosingTrade(null);
  }

  async function reopenTrade(id) {
    const { error: err } = await supabase.from("trades").update({ status: "open", close_date: null }).eq("id", id);
    if (err) { setError(err.message); return; }
    setTrades((prev) => prev.map((t) => (t.id === id ? { ...t, status: "open", closeDate: null } : t)));
  }

  async function setPrice(ticker, value) {
    setPrices((prev) => ({ ...prev, [ticker]: value }));
    const { error: err } = await supabase
      .from("current_prices")
      .upsert({ user_id: userId, ticker, price: value }, { onConflict: "user_id,ticker" });
    if (err) setError(err.message);
  }

  async function refreshPrices(tickers) {
    if (!FINNHUB_KEY) {
      setError("Para actualizar precios automáticamente falta configurar VITE_FINNHUB_API_KEY en Vercel.");
      return;
    }
    if (!tickers || tickers.length === 0) return;
    setRefreshing(true);
    for (const tk of tickers) {
      try {
        const price = await fetchQuote(tk);
        await setPrice(tk, price);
      } catch (e) {
        // si un ticker falla (símbolo raro, límite alcanzado, etc.) seguimos con el resto
      }
    }
    setRefreshing(false);
  }

  async function refreshOptionPrices(optionTradesList) {
    if (!TRADIER_TOKEN) {
      setError("Para actualizar precios de opciones falta configurar VITE_TRADIER_TOKEN en Vercel.");
      return;
    }
    const symbols = [];
    for (const t of optionTradesList) {
      for (const l of t.legs || []) {
        const occ = buildOccSymbol(t.ticker, t.expiration, l.optionType, l.strike);
        if (occ) symbols.push(occ);
      }
    }
    if (symbols.length === 0) return;
    setRefreshing(true);
    try {
      const map = await fetchOptionQuotes(symbols);
      setMarkPrices((prev) => ({ ...prev, ...map }));
    } catch (e) {
      setError(e.message || "No se pudieron actualizar los precios de opciones.");
    }
    setRefreshing(false);
  }

  async function addCashTx(data) {
    setError("");
    const row = { user_id: userId, date: data.date, type: data.type, amount: data.amount, notes: data.notes || null };
    const { data: inserted, error: err } = await supabase.from("cash_transactions").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setCashTx((prev) => [...prev, { id: inserted.id, date: inserted.date, type: inserted.type, amount: Number(inserted.amount), notes: inserted.notes }]);
    setShowAddCash(false);
  }

  async function deleteCashTx(id) {
    setCashTx((prev) => prev.filter((c) => c.id !== id));
    const { error: err } = await supabase.from("cash_transactions").delete().eq("id", id);
    if (err) { setError(err.message); loadAll(); }
  }

  // ---------- derived ----------
  const stockTrades = useMemo(() => trades.filter((t) => t.type === "stock"), [trades]);
  const optionTrades = useMemo(() => trades.filter((t) => t.type === "option"), [trades]);

  const { positions, sellPnlById } = useMemo(() => {
    const byTicker = {};
    const pnlById = {};
    const sorted = [...stockTrades].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const t of sorted) {
      const tk = t.ticker;
      if (!byTicker[tk]) byTicker[tk] = { ticker: tk, shares: 0, avgCost: 0, totalCost: 0, realized: 0 };
      const p = byTicker[tk];
      if (t.action === "buy") {
        p.totalCost += t.qty * t.price + (t.commission || 0);
        p.shares += t.qty;
        p.avgCost = p.shares > 0 ? p.totalCost / p.shares : 0;
      } else {
        const sellQty = Math.min(t.qty, p.shares);
        const pnl = (t.price - p.avgCost) * sellQty - (t.commission || 0);
        pnlById[t.id] = pnl;
        p.realized += pnl;
        p.totalCost -= p.avgCost * sellQty;
        p.shares -= sellQty;
        if (p.shares <= 0.0001) { p.shares = 0; p.totalCost = 0; p.avgCost = 0; }
      }
    }
    return { positions: Object.values(byTicker), sellPnlById: pnlById };
  }, [stockTrades]);

  const openPositions = positions.filter((p) => p.shares > 0);
  const totalMarketValue = openPositions.reduce((s, p) => s + (prices[p.ticker] ?? p.avgCost) * p.shares, 0);
  const stockRealized = positions.reduce((s, p) => s + p.realized, 0);
  const stockUnrealized = openPositions.reduce((s, p) => s + ((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares, 0);

  const closedOptions = optionTrades.filter((t) => t.status === "closed");
  const assignedOptions = optionTrades.filter((t) => t.status === "assigned");
  const openOptions = optionTrades.filter((t) => t.status !== "closed" && t.status !== "assigned");
  const optionRealized = closedOptions.reduce((s, t) => s + optionPnL(t), 0);
  const optionUnrealized = openOptions.reduce((s, t) => s + (unrealizedOptionPnL(t, markPrices) || 0), 0);

  const realizedTotal = stockRealized + optionRealized;
  const unrealizedTotal = stockUnrealized + optionUnrealized;
  const totalPnL = realizedTotal + unrealizedTotal;

  const closedSells = stockTrades.filter((t) => t.action === "sell");
  const closedForWinRate = [...closedSells, ...closedOptions];
  const wins = closedForWinRate.filter((t) => t.type === "option" ? optionPnL(t) > 0 : (sellPnlById[t.id] ?? 0) > 0).length;
  const winRate = closedForWinRate.length ? (wins / closedForWinRate.length) * 100 : null;

  const chartData = useMemo(() => {
    const events = [];
    for (const t of closedSells) events.push({ date: t.date, pnl: sellPnlById[t.id] ?? 0 });
    for (const t of closedOptions) events.push({ date: t.closeDate || t.date, pnl: optionPnL(t) });
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return events.map((e, i) => { acc += e.pnl; return { i: i + 1, date: e.date, acumulado: Math.round(acc * 100) / 100 }; });
  }, [closedSells, closedOptions, sellPnlById]);

  const byTickerChart = useMemo(() => {
    const map = {};
    for (const t of closedSells) map[t.ticker] = (map[t.ticker] || 0) + (sellPnlById[t.id] ?? 0);
    for (const t of closedOptions) map[t.ticker] = (map[t.ticker] || 0) + optionPnL(t);
    return Object.entries(map).map(([ticker, pnl]) => ({ ticker, pnl: Math.round(pnl * 100) / 100 })).sort((a, b) => b.pnl - a.pnl);
  }, [closedSells, closedOptions, sellPnlById]);

  const tickerTape = [
    ...openPositions.map((p) => ({ label: p.ticker, val: ((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares })),
    ...openOptions.map((t) => ({ label: `${t.ticker} · ${tradeLabel(t)}`, val: unrealizedOptionPnL(t, markPrices) })),
  ];

  // ---------- cuenta de efectivo ----------
  const netDeposits = cashTx.reduce((s, c) => s + (c.type === "deposit" ? c.amount : -c.amount), 0);
  const accountValue = netDeposits + totalPnL;
  const totalReturnPct = netDeposits > 0 ? (totalPnL / netDeposits) * 100 : null;

  // serie de depósitos netos acumulados en el tiempo, para saber el capital aportado "a fecha de"
  const capitalPoints = useMemo(() => {
    const sorted = [...cashTx].sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return sorted.map((c) => { acc += c.type === "deposit" ? c.amount : -c.amount; return { date: c.date, value: acc }; });
  }, [cashTx]);

  // serie de P&L realizado acumulado en el tiempo (reutiliza los mismos eventos que chartData)
  const realizedPoints = chartData; // [{date, acumulado}]

  function valueAsOf(points, dateStr, key) {
    // último punto con fecha <= dateStr; si no hay ninguno, 0
    let val = 0;
    for (const p of points) {
      if (new Date(p.date) <= new Date(dateStr)) val = p[key];
      else break;
    }
    return val;
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  function isoDaysAgo(n) { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  function isoMonthsAgo(n) { const d = new Date(today); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10); }
  function firstOfMonth() { return new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10); }
  function firstOfYear() { return new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10); }
  const earliestDate = [...cashTx.map((c) => c.date), ...trades.map((t) => t.date)].sort()[0] || todayStr;

  const PERIODS = [
    { id: "1w", label: "1S", start: isoDaysAgo(7) },
    { id: "mtd", label: "MAF", start: firstOfMonth() },
    { id: "1m", label: "1M", start: isoMonthsAgo(1) },
    { id: "3m", label: "3M", start: isoMonthsAgo(3) },
    { id: "ytd", label: "AAF", start: firstOfYear() },
    { id: "1y", label: "1A", start: isoMonthsAgo(12) },
    { id: "all", label: "TODO", start: earliestDate },
  ];
  const activePeriod = PERIODS.find((p) => p.id === period) || PERIODS[1];

  const realizedNow = valueAsOf(realizedPoints, todayStr, "acumulado");
  const realizedAtStart = valueAsOf(realizedPoints, activePeriod.start, "acumulado");
  const periodResult = realizedNow - realizedAtStart;
  const capitalAtStart = valueAsOf(capitalPoints, activePeriod.start, "value");
  const periodReturnPct = capitalAtStart > 0 ? (periodResult / capitalAtStart) * 100 : null;

  const depositsInPeriod = cashTx.filter((c) => c.date >= activePeriod.start && c.date <= todayStr);

  // serie combinada de valor de cuenta (capital aportado + P&L realizado) para la gráfica
  const accountValueChart = useMemo(() => {
    const dates = Array.from(new Set([...capitalPoints.map((p) => p.date), ...realizedPoints.map((p) => p.date)])).sort();
    return dates.map((d, i) => ({
      i: i + 1, date: d,
      valor: Math.round((valueAsOf(capitalPoints, d, "value") + valueAsOf(realizedPoints, d, "acumulado")) * 100) / 100,
    }));
  }, [capitalPoints, realizedPoints]);

  async function signOut() { await supabase.auth.signOut(); }

  useEffect(() => {
    if (!loading && !autoRefreshedRef.current && openPositions.length > 0) {
      autoRefreshedRef.current = true;
      refreshPrices(openPositions.map((p) => p.ticker));
    }
  }, [loading, openPositions]);

  useEffect(() => {
    if (!loading && !autoRefreshedOptionsRef.current && openOptions.length > 0) {
      autoRefreshedOptionsRef.current = true;
      refreshOptionPrices(openOptions);
    }
  }, [loading, openOptions]);

  if (loading) {
    return <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}><span className="mono" style={{ color: "var(--muted)" }}>Cargando bitácora…</span></div>;
  }

  return (
    <div className="app">
      <div className="header">
        <div>
          <div className="eyebrow">BITÁCORA · {session.user.email}</div>
          <div className="h1">Mi Bitácora de Trading</div>
        </div>
        <div className="top-actions">
          <button className="btn btn-gold" onClick={() => setShowAdd(true)}><Plus size={16} /> Nuevo trade</button>
          <button className="btn btn-ghost" onClick={signOut}><LogOut size={15} /></button>
        </div>
      </div>

      {tickerTape.length > 0 && (
        <div className="tape">
          <div className="tape-track">
            {[...tickerTape, ...tickerTape].map((item, i) => (
              <span key={i} className="tape-item" style={{ color: item.val == null ? "var(--muted)" : item.val >= 0 ? "var(--gain)" : "var(--loss)" }}>
                {item.label} {item.val != null ? (item.val >= 0 ? "▲ " : "▼ ") + fmt(Math.abs(item.val)) : "· abierta"}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        <div className="cards">
          <div className="card">
            <div className="card-label">P&L Realizado</div>
            <div className="card-value" style={{ color: realizedTotal >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(realizedTotal)}</div>
            <div className="card-sub">trades cerrados</div>
          </div>
          <div className="card" style={{ opacity: openPositions.length === 0 ? 0.6 : 1 }}>
            <div className="card-label">P&L No Realizado</div>
            <div className="card-value" style={{ color: unrealizedTotal >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(unrealizedTotal)}</div>
            <div className="card-sub">posiciones abiertas</div>
          </div>
          <div className="card">
            <div className="card-label">P&L Total</div>
            <div className="card-value big" style={{ color: totalPnL >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(totalPnL)}</div>
            <div className="card-sub">realizado + no realizado</div>
          </div>
          <div className="card">
            <div className="card-label">Win Rate</div>
            <div className="card-value" style={{ color: winRate == null ? "var(--muted)" : winRate >= 60 ? "var(--gain)" : winRate >= 40 ? "var(--gold)" : "var(--loss)" }}>
              {winRate == null ? "—" : `${winRate.toFixed(0)}%`}
            </div>
            <div className="card-sub">{wins}/{closedForWinRate.length} ganadores</div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Cuenta de efectivo</div>
            <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddCash(true)}><Plus size={14} /> Movimiento</button>
          </div>

          <div className="cards" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-label">Aportado Neto</div>
              <div className="card-value">{fmt(netDeposits)}</div>
              <div className="card-sub">depósitos − retiros</div>
            </div>
            <div className="card">
              <div className="card-label">Valor de Cuenta</div>
              <div className="card-value big" style={{ color: accountValue >= netDeposits ? "var(--gain)" : "var(--loss)" }}>{fmt(accountValue)}</div>
              <div className="card-sub">aportado + P&L total</div>
            </div>
            <div className="card">
              <div className="card-label">Rendimiento Total</div>
              <div className="card-value" style={{ color: totalReturnPct == null ? "var(--muted)" : totalReturnPct >= 0 ? "var(--gain)" : "var(--loss)" }}>
                {totalReturnPct == null ? "—" : `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(1)}%`}
              </div>
              <div className="card-sub">sobre lo aportado</div>
            </div>
          </div>

          <div className="tabs" style={{ flexWrap: "wrap", marginBottom: 12 }}>
            {PERIODS.map((p) => (
              <button key={p.id} className={`tab ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)}>{p.label}</button>
            ))}
          </div>

          <div className="cards" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
            <div className="card">
              <div className="card-label">Resultado del periodo</div>
              <div className="card-value" style={{ color: periodResult >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(periodResult)}</div>
              <div className="card-sub">P&L realizado en el rango</div>
            </div>
            <div className="card">
              <div className="card-label">Rendimiento del periodo</div>
              <div className="card-value" style={{ color: periodReturnPct == null ? "var(--muted)" : periodReturnPct >= 0 ? "var(--gain)" : "var(--loss)" }}>
                {periodReturnPct == null ? "—" : `${periodReturnPct >= 0 ? "+" : ""}${periodReturnPct.toFixed(1)}%`}
              </div>
              <div className="card-sub">sobre capital al inicio del periodo</div>
            </div>
          </div>

          {accountValueChart.length > 0 && (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={accountValueChart}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="i" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} />
                <YAxis tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} tickFormatter={fmtCompact} width={60} />
                <ReferenceLine y={0} stroke="#20304C" />
                <Tooltip contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 6, fontSize: 12 }} formatter={(v) => [fmt(v), "Valor de cuenta"]} labelFormatter={(_, p) => p?.[0]?.payload?.date || ""} />
                <Line type="monotone" dataKey="valor" stroke="#34D399" strokeWidth={2} dot={{ r: 3, fill: "#34D399" }} />
              </LineChart>
            </ResponsiveContainer>
          )}

          <div style={{ marginTop: 16 }}>
            <div className="field-label" style={{ marginBottom: 8 }}>Movimientos de efectivo</div>
            {cashTx.length === 0 ? <div className="empty">Sin movimientos aún</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Fecha</th><th>Tipo</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
                  <tbody>
                    {[...cashTx].sort((a, b) => new Date(b.date) - new Date(a.date)).map((c) => (
                      <tr key={c.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{c.date}</td>
                        <td><span className={`badge ${c.type === "deposit" ? "badge-closed" : "badge-open"}`}>{c.type === "deposit" ? "Depósito" : "Retiro"}</span></td>
                        <td className="mono" style={{ color: c.type === "deposit" ? "var(--gain)" : "var(--loss)" }}>{c.type === "deposit" ? "+" : "-"}{fmt(c.amount)}</td>
                        <td style={{ fontSize: 13, color: "var(--muted)" }}>{c.notes || "—"}</td>
                        <td><button className="icon-btn" style={{ color: "var(--loss)" }} onClick={() => deleteCashTx(c.id)}><Trash2 size={15} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="grid-2">
          <div className="panel">
            <div className="panel-head"><div className="panel-title">Curva de P&L acumulado</div></div>
            {chartData.length === 0 ? <div className="empty">Sin trades cerrados aún</div> : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="i" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} />
                  <YAxis tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} tickFormatter={fmtCompact} width={60} />
                  <ReferenceLine y={0} stroke="#20304C" />
                  <Tooltip contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 6, fontSize: 12 }} formatter={(v) => [fmt(v), "Acumulado"]} labelFormatter={(_, p) => p?.[0]?.payload?.date || ""} />
                  <Line type="monotone" dataKey="acumulado" stroke="#E8A33D" strokeWidth={2} dot={{ r: 3, fill: "#E8A33D" }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="panel">
            <div className="panel-head"><div className="panel-title">P&L por ticker</div></div>
            {byTickerChart.length === 0 ? <div className="empty">Sin trades cerrados aún</div> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byTickerChart}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="ticker" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} />
                  <YAxis tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} tickFormatter={fmtCompact} width={60} />
                  <ReferenceLine y={0} stroke="#20304C" />
                  <Tooltip contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 6, fontSize: 12 }} formatter={(v) => [fmt(v), "P&L"]} />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {byTickerChart.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? "#34D399" : "#F4665A"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Portafolio — acciones</div>
            {openPositions.length > 0 && (
              <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} disabled={refreshing} onClick={() => refreshPrices(openPositions.map((p) => p.ticker))}>
                {refreshing ? "Actualizando…" : "Actualizar precios"}
              </button>
            )}
          </div>
          {openPositions.length === 0 ? <div className="empty">Sin acciones en portafolio</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ticker</th><th>Acciones</th><th>$ Prom.</th><th>$ Actual</th><th>$ Mercado</th><th>P&L no realiz.</th><th>%</th></tr></thead>
                <tbody>
                  {openPositions.map((p) => {
                    const cur = prices[p.ticker] ?? p.avgCost;
                    const mv = cur * p.shares;
                    const pnl = (cur - p.avgCost) * p.shares;
                    const pct = p.avgCost ? (pnl / (p.avgCost * p.shares)) * 100 : 0;
                    return (
                      <tr key={p.ticker}>
                        <td style={{ fontWeight: 500 }}>{p.ticker}</td>
                        <td className="mono">{p.shares}</td>
                        <td className="mono">{fmt(p.avgCost)}</td>
                        <td>
                          <input
                            type="number" className="price-input"
                            value={prices[p.ticker] ?? ""} placeholder={p.avgCost.toFixed(2)}
                            onChange={(e) => setPrice(p.ticker, Number(e.target.value))}
                          />
                        </td>
                        <td className="mono">{fmt(mv)}</td>
                        <td className="mono" style={{ color: pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(pnl)}</td>
                        <td className="mono" style={{ color: pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalMarketValue > 0 && <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Valor total de mercado: <span style={{ color: "var(--text)" }}>{fmt(totalMarketValue)}</span></div>}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Historial de trades</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {openOptions.length > 0 && (
                <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} disabled={refreshing} onClick={() => refreshOptionPrices(openOptions)}>
                  {refreshing ? "Actualizando…" : "Actualizar opciones"}
                </button>
              )}
              <div className="tabs">
                {["open", "closed", "all"].map((k) => (
                  <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
                    {k === "open" ? "Abiertos" : k === "closed" ? "Cerrados" : "Todos"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <TradeTable
            trades={trades.filter((t) => {
              const isOpen = t.type === "option" ? (t.status !== "closed" && t.status !== "assigned") : t.action === "buy";
              if (tab === "open") return isOpen;
              if (tab === "closed") return !isOpen;
              return true;
            })}
            sellPnlById={sellPnlById}
            markPrices={markPrices}
            onDelete={deleteTrade}
            onClose={(t) => setClosingTrade(t)}
            onReopen={reopenTrade}
          />
        </div>
      </div>

      {showAdd && <AddTradeModal onCancel={() => setShowAdd(false)} onSave={addTrade} />}
      {showAddCash && <AddCashModal onCancel={() => setShowAddCash(false)} onSave={addCashTx} />}
      {closingTrade && (
        <CloseModal
          trade={closingTrade}
          onCancel={() => setClosingTrade(null)}
          onSave={(date, legCloses, closeCommission) => closeOptionTrade(closingTrade.id, date, legCloses, closeCommission)}
          onAssign={(date) => assignOptionTrade(closingTrade.id, date)}
        />
      )}
    </div>
  );
}

function TradeTable({ trades, sellPnlById, markPrices, onDelete, onClose, onReopen }) {
  if (trades.length === 0) return <div className="empty">No hay trades en esta vista</div>;
  const sorted = [...trades].sort((a, b) => new Date(b.date) - new Date(a.date));
  const todayStr = new Date().toISOString().slice(0, 10);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Ticker</th><th>Tipo</th><th>Cant.</th><th>Comisión</th><th>Estado</th><th>P&L</th><th></th></tr></thead>
        <tbody>
          {sorted.map((t) => {
            const isOption = t.type === "option";
            const isAssigned = isOption && t.status === "assigned";
            const isOpen = isOption ? (t.status !== "closed" && t.status !== "assigned") : t.action === "buy";
            const expired = isOption && isOpen && t.expiration && t.expiration < todayStr;
            const pnl = isOption
              ? (t.status === "closed" ? optionPnL(t) : t.status === "assigned" ? 0 : unrealizedOptionPnL(t, markPrices))
              : (t.action === "sell" ? (sellPnlById[t.id] ?? 0) : null);
            const totalCommission = (t.commission || 0) + (t.closeCommission || 0);
            return (
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 12 }}>{t.date}</td>
                <td style={{ fontWeight: 500 }}>{t.ticker}</td>
                <td style={{ fontSize: 13 }}>
                  {tradeLabel(t)}
                  {isOption && t.expiration && <div style={{ fontSize: 11, color: "var(--muted)" }}>Vence {t.expiration}</div>}
                  {t.notes && t.notes.startsWith("Asignación") && <div style={{ fontSize: 11, color: "var(--gold)" }}>{t.notes}</div>}
                </td>
                <td className="mono">{t.qty}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{totalCommission > 0 ? fmt(totalCommission) : "—"}</td>
                <td>
                  <span
                    className={`badge ${expired ? "badge-open" : isAssigned ? "badge-closed" : isOpen ? "badge-open" : "badge-closed"}`}
                    style={expired ? { background: "#3A1A1A", color: "var(--loss)" } : isAssigned ? { background: "#1A2A3A", color: "#7EC8E3" } : undefined}
                  >
                    {expired ? "Vencida" : isAssigned ? "Asignada" : isOpen ? "Abierto" : "Cerrado"}
                  </span>
                </td>
                <td className="mono" style={{ color: pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{pnl == null ? "—" : fmt(pnl)}</td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    {isOption && isOpen && <button className="icon-btn" style={{ color: "var(--gain)" }} title="Cerrar / Asignar" onClick={() => onClose(t)}><CheckCircle2 size={15} /></button>}
                    {isOption && t.status === "closed" && <button className="icon-btn" style={{ color: "var(--muted)" }} title="Reabrir" onClick={() => onReopen(t.id)}><RotateCcw size={15} /></button>}
                    <button className="icon-btn" style={{ color: "var(--loss)" }} title="Eliminar" onClick={() => onDelete(t.id)}><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AddTradeModal({ onCancel, onSave }) {
  const [type, setType] = useState("stock");
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [commission, setCommission] = useState("");
  // stock
  const [action, setAction] = useState("buy");
  const [price, setPrice] = useState("");
  // option
  const [expiration, setExpiration] = useState("");
  const [legs, setLegs] = useState([{ action: "sell", optionType: "call", strike: "", price: "" }]);

  function updateLeg(i, patch) {
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLeg() {
    if (legs.length >= 4) return;
    setLegs((prev) => [...prev, { action: "sell", optionType: "call", strike: "", price: "" }]);
  }
  function removeLeg(i) {
    if (legs.length <= 1) return;
    setLegs((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    if (!ticker || !qty) return;
    const commissionNum = Number(commission) || 0;
    if (type === "stock") {
      if (!price) return;
      onSave({ type, ticker: ticker.toUpperCase().trim(), date, qty: Number(qty), price: Number(price), action, notes, commission: commissionNum });
    } else {
      if (!expiration) return;
      if (legs.some((l) => l.strike === "" || l.price === "")) return;
      const cleanLegs = legs.map((l) => ({ action: l.action, optionType: l.optionType, strike: Number(l.strike), price: Number(l.price), closePrice: null }));
      onSave({ type, ticker: ticker.toUpperCase().trim(), date, qty: Number(qty), legs: cleanLegs, notes, commission: commissionNum, expiration });
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Nuevo trade</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        <div className="type-toggle">
          {["stock", "option"].map((k) => (
            <button key={k} onClick={() => setType(k)} style={{ background: type === k ? "var(--gold)" : "transparent", color: type === k ? "#1A1300" : "var(--muted)", border: `1px solid ${type === k ? "var(--gold)" : "var(--border)"}` }}>
              {k === "stock" ? "Acción" : "Opción / Spread"}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <div className="field"><div className="field-label">Ticker</div><input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" /></div>
          <div className="field"><div className="field-label">Fecha</div><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>

          {type === "stock" ? (
            <>
              <div className="field"><div className="field-label">Acción</div>
                <select value={action} onChange={(e) => setAction(e.target.value)}><option value="buy">Compra</option><option value="sell">Venta</option></select>
              </div>
              <div className="field"><div className="field-label">Acciones</div><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              <div className="field"><div className="field-label">Precio ($)</div><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
            </>
          ) : (
            <>
              <div className="field"><div className="field-label">Contratos (todas las patas)</div><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              <div className="field"><div className="field-label">Vencimiento</div><input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} /></div>
            </>
          )}

          <div className="field"><div className="field-label">Comisión ($, opcional)</div><input type="number" value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="0.00" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Notas (opcional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>

        {type === "option" && (
          <div style={{ marginTop: 14 }}>
            <div className="field-label" style={{ marginBottom: 8 }}>Patas ({legs.length}/4) — 1 pata = opción simple, 2+ = spread</div>
            {legs.map((leg, i) => (
              <div className="leg-row" key={i}>
                <div className="field"><div className="field-label">Acción</div>
                  <select value={leg.action} onChange={(e) => updateLeg(i, { action: e.target.value })}><option value="sell">Venta</option><option value="buy">Compra</option></select>
                </div>
                <div className="field"><div className="field-label">Tipo</div>
                  <select value={leg.optionType} onChange={(e) => updateLeg(i, { optionType: e.target.value })}><option value="call">Call</option><option value="put">Put</option></select>
                </div>
                <div className="field"><div className="field-label">Strike</div><input type="number" value={leg.strike} onChange={(e) => updateLeg(i, { strike: e.target.value })} /></div>
                <div className="field"><div className="field-label">Premium</div><input type="number" value={leg.price} onChange={(e) => updateLeg(i, { price: e.target.value })} /></div>
                <button className="icon-btn" style={{ color: "var(--loss)" }} onClick={() => removeLeg(i)} disabled={legs.length <= 1}><Trash2 size={15} /></button>
              </div>
            ))}
            {legs.length < 4 && <button className="btn btn-ghost" style={{ fontSize: 12, padding: "6px 10px" }} onClick={addLeg}><Plus size={13} /> Agregar pata</button>}
          </div>
        )}

        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar trade</button>
      </div>
    </div>
  );
}

function AddCashModal({ onCancel, onSave }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  function submit() {
    if (!amount || Number(amount) <= 0) return;
    onSave({ date, type, amount: Number(amount), notes });
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Movimiento de efectivo</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        <div className="type-toggle">
          {["deposit", "withdrawal"].map((k) => (
            <button key={k} onClick={() => setType(k)} style={{ background: type === k ? "var(--gold)" : "transparent", color: type === k ? "#1A1300" : "var(--muted)", border: `1px solid ${type === k ? "var(--gold)" : "var(--border)"}` }}>
              {k === "deposit" ? "Depósito" : "Retiro"}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <div className="field"><div className="field-label">Fecha</div><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><div className="field-label">Monto ($)</div><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Notas (opcional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>

        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar movimiento</button>
      </div>
    </div>
  );
}

function CloseModal({ trade, onCancel, onSave, onAssign }) {
  const canAssign = (trade.legs || []).length === 1;
  const [mode, setMode] = useState("close"); // "close" | "assign"
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [legCloses, setLegCloses] = useState((trade.legs || []).map(() => ""));
  const [closeCommission, setCloseCommission] = useState("");

  const preview = mode === "assign" ? assignmentStockTrade(trade) : null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Cerrar posición — {trade.ticker}</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        {canAssign && (
          <div className="type-toggle">
            <button onClick={() => setMode("close")} style={{ background: mode === "close" ? "var(--gold)" : "transparent", color: mode === "close" ? "#1A1300" : "var(--muted)", border: `1px solid ${mode === "close" ? "var(--gold)" : "var(--border)"}` }}>
              Cerrar pagando/cobrando prima
            </button>
            <button onClick={() => setMode("assign")} style={{ background: mode === "assign" ? "var(--gold)" : "transparent", color: mode === "assign" ? "#1A1300" : "var(--muted)", border: `1px solid ${mode === "assign" ? "var(--gold)" : "var(--border)"}` }}>
              Asignación / Ejercicio
            </button>
          </div>
        )}

        <div className="field" style={{ marginBottom: 14 }}>
          <div className="field-label">{mode === "assign" ? "Fecha de asignación" : "Fecha de cierre"}</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        {mode === "close" && (
          <>
            {(trade.legs || []).map((leg, i) => (
              <div className="field" key={i} style={{ marginBottom: 10 }}>
                <div className="field-label">{legLabel(leg)} — precio de cierre</div>
                <input type="number" value={legCloses[i]} onChange={(e) => setLegCloses((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} />
              </div>
            ))}
            <div className="field" style={{ marginBottom: 10 }}>
              <div className="field-label">Comisión de cierre ($, opcional)</div>
              <input type="number" value={closeCommission} onChange={(e) => setCloseCommission(e.target.value)} placeholder="0.00" />
            </div>
            <button
              className="btn btn-gain" style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
              onClick={() => legCloses.every((v) => v !== "") && onSave(date, legCloses, closeCommission)}
            >
              Confirmar cierre
            </button>
          </>
        )}

        {mode === "assign" && preview && (
          <>
            <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 6, padding: 12, fontSize: 13, marginBottom: 14, color: "var(--muted)" }}>
              Esto registrará automáticamente una <strong style={{ color: "var(--text)" }}>{preview.action === "buy" ? "compra" : "venta"}</strong> de{" "}
              <strong style={{ color: "var(--text)" }}>{preview.shares} acciones</strong> de {trade.ticker} a un precio efectivo de{" "}
              <strong style={{ color: "var(--text)" }}>{fmt(preview.price)}</strong> por acción (ya incluye la prima y comisión de esta opción).
            </div>
            <button
              className="btn btn-gain" style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
              onClick={() => onAssign(date)}
            >
              Confirmar asignación / ejercicio
            </button>
          </>
        )}
      </div>
    </div>
  );
}
