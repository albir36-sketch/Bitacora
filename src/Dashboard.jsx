import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { Plus, X, Trash2, CheckCircle2, RotateCcw, LogOut, LayoutDashboard, Briefcase, Wallet, ListOrdered, Menu, Percent } from "lucide-react";
import { supabase } from "./supabaseClient";

export const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
];
// símbolo activo — la vista de Dashboard lo actualiza según la divisa seleccionada,
// así fmt()/fmtCompact() usan siempre el símbolo correcto en cualquier parte del archivo.
let ACTIVE_SYMBOL = "$";
function currencySymbol(code) { return CURRENCIES.find((c) => c.code === code)?.symbol || "$"; }

const fmt = (n) =>
  (n < 0 ? `-${ACTIVE_SYMBOL}` : ACTIVE_SYMBOL) + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = (n) =>
  (n < 0 ? `-${ACTIVE_SYMBOL}` : ACTIVE_SYMBOL) + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
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
function legSign(leg) { return leg.action === "sell" ? 1 : -1; }

// Reconstruye la cadena de rolls desde el primer eslabón hasta `trade` (inclusive)
function getRollChain(trade, tradesById) {
  const chain = [];
  let cur = trade;
  let guard = 0;
  while (cur && guard < 50) {
    chain.unshift(cur);
    cur = cur.rolledFromId && tradesById ? tradesById[cur.rolledFromId] : null;
    guard++;
  }
  return chain;
}

// Suma la prima neta por acción y las comisiones acumuladas a lo largo de toda la cadena de rolls
// que termina en `trade` (incluye la apertura de `trade`, pero NO su propio cierre/asignación final,
// eso lo resuelve quien llame a esta función).
function chainAccumulated(trade, tradesById) {
  const chain = getRollChain(trade, tradesById);
  let netPremium = 0;
  let totalCommission = 0;
  chain.forEach((t, i) => {
    const leg = (t.legs || [])[0];
    if (!leg) return;
    const sign = legSign(leg);
    netPremium += sign * leg.price;
    totalCommission += t.commission || 0;
    const isLast = i === chain.length - 1;
    if (!isLast) {
      // este eslabón se cerró para dar paso al siguiente roll: descuenta su costo de cierre
      netPremium -= sign * (leg.closePrice || 0);
      totalCommission += t.closeCommission || 0;
    }
  });
  return { netPremium, totalCommission };
}

function optionPnL(t, tradesById) {
  if (t.status === "rolled") return 0; // resultado diferido al siguiente eslabón de la cadena
  const legs = t.legs || [];
  if (t.status === "assigned") {
    // la prima queda íntegramente realizada como ganancia: no hay costo de recompra, el precio del
    // strike se cobra/paga aparte, en el trade de acciones que se genera con el precio real pagado.
    if (legs.length !== 1) return 0; // los spreads no soportan asignación en esta versión
    const { netPremium, totalCommission } = chainAccumulated(t, tradesById || {});
    return netPremium * t.qty * 100 - totalCommission;
  }
  if (t.status !== "closed") return 0;
  if (legs.length === 1) {
    const { netPremium, totalCommission } = chainAccumulated(t, tradesById || {});
    const leg = legs[0];
    const sign = legSign(leg);
    const finalNet = netPremium - sign * (leg.closePrice || 0);
    return finalNet * t.qty * 100 - totalCommission - (t.closeCommission || 0);
  }
  // spreads de varias patas: no soportan roll, se calcula como antes
  const perContract = legs.reduce((s, l) => s + legPnL(l), 0);
  return perContract * t.qty * 100 - (t.commission || 0) - (t.closeCommission || 0);
}
// Calcula el precio REAL (el strike, sin ajustar) y la acción del trade de acciones que se genera
// al asignar/ejercer una opción de una sola pata. La prima cobrada/pagada en toda la cadena de rolls
// se contabiliza aparte, como P&L propio de la opción (ver optionPnL), no oculta dentro del precio.
function assignmentStockTrade(t) {
  const leg = (t.legs || [])[0];
  if (!leg) return null;
  const shares = t.qty * 100;
  let action;
  if (leg.action === "sell" && leg.optionType === "put") action = "buy";        // CSP asignada
  else if (leg.action === "sell" && leg.optionType === "call") action = "sell"; // CC asignada
  else if (leg.action === "buy" && leg.optionType === "call") action = "buy";   // call comprada, ejercida
  else action = "sell";                                                        // put comprada, ejercida
  return { action, price: leg.strike, shares };
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
  if (t.status === "closed" || t.status === "assigned" || t.status === "rolled") return null;
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

// Calcula el valor de cuenta (aportado + P&L total) de una divisa concreta, a partir de TODOS
// los trades/movimientos (sin filtrar por la vista activa). Se usa para sumar el patrimonio
// total convertido a una única divisa.
function computeCurrencySummary(allTrades, allCashTx, allDividends, prices, markPrices, curCode) {
  const tradesById = Object.fromEntries(allTrades.map((t) => [t.id, t]));
  const curTrades = allTrades.filter((t) => (t.currency || "USD") === curCode);
  const curCash = allCashTx.filter((c) => (c.currency || "USD") === curCode);
  const curDividends = (allDividends || []).filter((d) => (d.currency || "USD") === curCode);
  const stockTrades = curTrades.filter((t) => t.type === "stock");
  const optionTrades = curTrades.filter((t) => t.type === "option");

  const byTicker = {};
  const sorted = [...stockTrades].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const t of sorted) {
    const tk = t.ticker;
    if (!byTicker[tk]) byTicker[tk] = { shares: 0, avgCost: 0, totalCost: 0, realized: 0 };
    const p = byTicker[tk];
    if (t.action === "buy") {
      p.totalCost += t.qty * t.price + (t.commission || 0);
      p.shares += t.qty;
      p.avgCost = p.shares > 0 ? p.totalCost / p.shares : 0;
    } else {
      const sellQty = Math.min(t.qty, p.shares);
      const pnl = (t.price - p.avgCost) * sellQty - (t.commission || 0);
      p.realized += pnl;
      p.totalCost -= p.avgCost * sellQty;
      p.shares -= sellQty;
      if (p.shares <= 0.0001) { p.shares = 0; p.totalCost = 0; p.avgCost = 0; }
    }
  }
  const posArr = Object.entries(byTicker).map(([ticker, p]) => ({ ticker, ...p }));
  const openPos = posArr.filter((p) => p.shares > 0);
  const stockRealized = posArr.reduce((s, p) => s + p.realized, 0);
  const stockUnrealized = openPos.reduce((s, p) => s + ((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares, 0);

  const closedOpts = optionTrades.filter((t) => t.status === "closed" || t.status === "assigned");
  const openOpts = optionTrades.filter((t) => t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled");
  const optionRealized = closedOpts.reduce((s, t) => s + optionPnL(t, tradesById), 0);
  const optionUnrealized = openOpts.reduce((s, t) => s + (unrealizedOptionPnL(t, markPrices) || 0), 0);
  const dividendsTotal = curDividends.reduce((s, d) => s + d.amount, 0);

  const totalPnL = stockRealized + stockUnrealized + optionRealized + optionUnrealized + dividendsTotal;
  const netDeposits = curCash.reduce((s, c) => s + (c.type === "deposit" ? c.amount : -c.amount), 0);
  return { currency: curCode, accountValue: netDeposits + totalPnL };
}

export default function Dashboard({ session }) {
  const [trades, setTrades] = useState([]);
  const [prices, setPrices] = useState({});
  const [cashTx, setCashTx] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [showAddDividend, setShowAddDividend] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddCash, setShowAddCash] = useState(false);
  const [closingTrade, setClosingTrade] = useState(null);
  const [tab, setTab] = useState("open");
  const [period, setPeriod] = useState("mtd");
  const [refreshing, setRefreshing] = useState(false);
  const [markPrices, setMarkPrices] = useState({});
  const [view, setView] = useState("dashboard"); // "dashboard" | "portfolio" | "cash" | "trades"
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [fxRates, setFxRates] = useState(null); // { USD: 1, EUR: 0.92, GBP: 0.78 } relativas a `currency`
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState("");
  const autoRefreshedRef = useRef(false);
  const autoRefreshedOptionsRef = useRef(false);
  ACTIVE_SYMBOL = currencySymbol(currency);

  const userId = session.user.id;

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadRates() {
      setFxLoading(true);
      setFxError("");
      try {
        const others = CURRENCIES.map((c) => c.code).filter((c) => c !== currency);
        const res = await fetch(`https://api.frankfurter.app/latest?base=${currency}&symbols=${others.join(",")}`);
        if (!res.ok) throw new Error("No se pudieron obtener las tasas de cambio.");
        const data = await res.json();
        if (!cancelled) setFxRates({ [currency]: 1, ...data.rates });
      } catch (e) {
        if (!cancelled) setFxError("No se pudo actualizar el tipo de cambio (revisa tu conexión).");
      } finally {
        if (!cancelled) setFxLoading(false);
      }
    }
    loadRates();
    return () => { cancelled = true; };
  }, [currency]);

  async function loadAll() {
    setLoading(true);
    setError("");
    const [{ data: tradeRows, error: tErr }, { data: priceRows, error: pErr }, { data: cashRows, error: cErr }, { data: divRows, error: dErr }] = await Promise.all([
      supabase.from("trades").select("*").order("date", { ascending: true }),
      supabase.from("current_prices").select("*"),
      supabase.from("cash_transactions").select("*").order("date", { ascending: true }),
      supabase.from("dividends").select("*").order("date", { ascending: true }),
    ]);
    if (tErr) setError(tErr.message);
    if (pErr) setError((e) => e || pErr.message);
    if (cErr) setError((e) => e || cErr.message);
    if (dErr) setError((e) => e || dErr.message);
    setTrades((tradeRows || []).map(fromRow));
    const pMap = {};
    (priceRows || []).forEach((r) => { pMap[r.ticker] = Number(r.price); });
    setPrices(pMap);
    setCashTx((cashRows || []).map((r) => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount), notes: r.notes, currency: r.currency || "USD" })));
    setDividends((divRows || []).map((r) => ({ id: r.id, ticker: r.ticker, date: r.date, amount: Number(r.amount), notes: r.notes, currency: r.currency || "USD" })));
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
      rolledFromId: r.rolled_from_id || null,
      currency: r.currency || "USD",
    };
  }

  async function addTrade(data) {
    setError("");
    const row = {
      user_id: userId, type: data.type, ticker: data.ticker, date: data.date, qty: data.qty,
      price: data.price ?? null, action: data.action ?? null, legs: data.legs ?? null,
      status: data.type === "option" ? "open" : null, notes: data.notes || null,
      commission: data.commission ?? 0, expiration: data.expiration || null,
      currency: data.currency || "USD",
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
      commission: 0, expiration: null, currency: target.currency || "USD",
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

  async function rollOptionTrade(id, rollDate, closePrice, closeCommission, newLeg, newExpiration, newCommission) {
    setError("");
    const target = trades.find((t) => t.id === id);
    const leg = target.legs[0];
    const closedLegs = [{ ...leg, closePrice: Number(closePrice) }];
    const cc = Number(closeCommission) || 0;

    // 1) cierra el tramo actual (da paso al nuevo)
    const { error: err1 } = await supabase
      .from("trades")
      .update({ status: "rolled", close_date: rollDate, legs: closedLegs, close_commission: cc })
      .eq("id", id);
    if (err1) { setError(err1.message); return; }

    // 2) abre el nuevo tramo, encadenado al anterior
    const newRow = {
      user_id: userId, type: "option", ticker: target.ticker, date: rollDate, qty: target.qty,
      legs: [{ action: leg.action, optionType: newLeg.optionType, strike: Number(newLeg.strike), price: Number(newLeg.price), closePrice: null }],
      status: "open", expiration: newExpiration, commission: Number(newCommission) || 0,
      notes: `Roll desde venc. ${target.expiration || ""}`, rolled_from_id: id, currency: target.currency || "USD",
    };
    const { data: insertedNew, error: err2 } = await supabase.from("trades").insert(newRow).select().single();
    if (err2) { setError(err2.message); return; }

    setTrades((prev) => [
      ...prev.map((t) => (t.id === id ? { ...t, status: "rolled", closeDate: rollDate, legs: closedLegs, closeCommission: cc } : t)),
      fromRow(insertedNew),
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

  async function refreshOptionPrices(optionTradesList, silent = false) {
    if (!TRADIER_TOKEN) {
      if (!silent) setError("Para actualizar precios de opciones falta configurar VITE_TRADIER_TOKEN en Vercel.");
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
      if (!silent) setError(e.message || "No se pudieron actualizar los precios de opciones.");
    }
    setRefreshing(false);
  }

  async function addCashTx(data) {
    setError("");
    const row = { user_id: userId, date: data.date, type: data.type, amount: data.amount, notes: data.notes || null, currency: data.currency || "USD" };
    const { data: inserted, error: err } = await supabase.from("cash_transactions").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setCashTx((prev) => [...prev, { id: inserted.id, date: inserted.date, type: inserted.type, amount: Number(inserted.amount), notes: inserted.notes, currency: inserted.currency || "USD" }]);
    setShowAddCash(false);
  }

  async function deleteCashTx(id) {
    setCashTx((prev) => prev.filter((c) => c.id !== id));
    const { error: err } = await supabase.from("cash_transactions").delete().eq("id", id);
    if (err) { setError(err.message); loadAll(); }
  }

  async function addDividend(data) {
    setError("");
    const row = {
      user_id: userId, ticker: data.ticker.toUpperCase().trim(), date: data.date,
      amount: data.amount, currency: data.currency || "USD", notes: data.notes || null,
    };
    const { data: inserted, error: err } = await supabase.from("dividends").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setDividends((prev) => [...prev, { id: inserted.id, ticker: inserted.ticker, date: inserted.date, amount: Number(inserted.amount), notes: inserted.notes, currency: inserted.currency || "USD" }]);
    setShowAddDividend(false);
  }

  async function deleteDividend(id) {
    setDividends((prev) => prev.filter((d) => d.id !== id));
    const { error: err } = await supabase.from("dividends").delete().eq("id", id);
    if (err) { setError(err.message); loadAll(); }
  }

  // ---------- derived ----------
  // tradesById usa TODOS los trades (sin filtrar) para poder resolver cadenas de roll aunque
  // el eslabón anterior perteneciera a otra vista; el resto de cálculos sí se filtra por divisa.
  const tradesById = useMemo(() => Object.fromEntries(trades.map((t) => [t.id, t])), [trades]);
  const currencyTrades = useMemo(() => trades.filter((t) => (t.currency || "USD") === currency), [trades, currency]);
  const currencyCashTx = useMemo(() => cashTx.filter((c) => (c.currency || "USD") === currency), [cashTx, currency]);
  const currencyDividends = useMemo(() => dividends.filter((d) => (d.currency || "USD") === currency), [dividends, currency]);

  const stockTrades = useMemo(() => currencyTrades.filter((t) => t.type === "stock"), [currencyTrades]);
  const optionTrades = useMemo(() => currencyTrades.filter((t) => t.type === "option"), [currencyTrades]);

  // ---------- patrimonio total (todas las divisas convertidas a la activa) ----------
  const combinedTotal = useMemo(() => {
    if (!fxRates) return null;
    let total = 0;
    const breakdown = [];
    for (const c of CURRENCIES) {
      const summary = computeCurrencySummary(trades, cashTx, dividends, prices, markPrices, c.code);
      const rate = c.code === currency ? 1 : fxRates[c.code];
      if (rate == null) continue;
      const converted = summary.accountValue / rate;
      total += converted;
      if (summary.accountValue !== 0) breakdown.push({ code: c.code, value: summary.accountValue });
    }
    return { total, breakdown };
  }, [trades, cashTx, dividends, prices, markPrices, fxRates, currency]);

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
  // "cerradas" a efectos de P&L: incluye las asignadas, porque ahora su prima se cuenta como
  // ganancia propia (ver optionPnL), no se oculta dentro del precio del trade de acciones.
  const realizedOptions = [...closedOptions, ...assignedOptions];
  const openOptions = optionTrades.filter((t) => t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled");
  const optionRealized = realizedOptions.reduce((s, t) => s + optionPnL(t, tradesById), 0);
  const optionUnrealized = openOptions.reduce((s, t) => s + (unrealizedOptionPnL(t, markPrices) || 0), 0);

  const dividendsTotal = currencyDividends.reduce((s, d) => s + d.amount, 0);
  const realizedTotal = stockRealized + optionRealized + dividendsTotal;
  const unrealizedTotal = stockUnrealized + optionUnrealized;
  const totalPnL = realizedTotal + unrealizedTotal;

  const closedSells = stockTrades.filter((t) => t.action === "sell");
  const closedForWinRate = [...closedSells, ...realizedOptions];
  const wins = closedForWinRate.filter((t) => t.type === "option" ? optionPnL(t, tradesById) > 0 : (sellPnlById[t.id] ?? 0) > 0).length;
  const winRate = closedForWinRate.length ? (wins / closedForWinRate.length) * 100 : null;

  const chartData = useMemo(() => {
    const events = [];
    for (const t of closedSells) events.push({ date: t.date, pnl: sellPnlById[t.id] ?? 0 });
    for (const t of realizedOptions) events.push({ date: t.closeDate || t.date, pnl: optionPnL(t, tradesById) });
    for (const d of currencyDividends) events.push({ date: d.date, pnl: d.amount });
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return events.map((e, i) => { acc += e.pnl; return { i: i + 1, date: e.date, acumulado: Math.round(acc * 100) / 100 }; });
  }, [closedSells, realizedOptions, sellPnlById, tradesById, currencyDividends]);

  const byTickerChart = useMemo(() => {
    const map = {};
    for (const t of closedSells) map[t.ticker] = (map[t.ticker] || 0) + (sellPnlById[t.id] ?? 0);
    for (const t of realizedOptions) map[t.ticker] = (map[t.ticker] || 0) + optionPnL(t, tradesById);
    for (const d of currencyDividends) map[d.ticker] = (map[d.ticker] || 0) + d.amount;
    return Object.entries(map).map(([ticker, pnl]) => ({ ticker, pnl: Math.round(pnl * 100) / 100 })).sort((a, b) => b.pnl - a.pnl);
  }, [closedSells, realizedOptions, sellPnlById, tradesById, currencyDividends]);

  // ---------- precio medio ajustado por ticker (primas de opciones + dividendos, sobre acciones que a\u00fan tienes) ----------
  // Se excluye a prop\u00f3sito el P&L de ventas parciales de acciones: eso ya es una realizaci\u00f3n aparte,
  // no un ingreso extra que deba \"rebajar\" el costo de las acciones que sigues teniendo.
  const tickerAdjusted = useMemo(() => {
    const optMap = {};
    const divMap = {};
    for (const t of realizedOptions) optMap[t.ticker] = (optMap[t.ticker] || 0) + optionPnL(t, tradesById);
    for (const d of currencyDividends) divMap[d.ticker] = (divMap[d.ticker] || 0) + d.amount;
    return openPositions.map((p) => {
      const optIncome = optMap[p.ticker] || 0;
      const divIncome = divMap[p.ticker] || 0;
      const totalIncome = optIncome + divIncome;
      const adjustedAvg = p.avgCost - totalIncome / p.shares;
      const curPrice = prices[p.ticker] ?? p.avgCost;
      const costBasis = p.avgCost * p.shares;
      const pctRecovered = costBasis > 0 ? (totalIncome / costBasis) * 100 : null;
      const totalReturnPct = costBasis > 0 ? (((curPrice - p.avgCost) * p.shares + totalIncome) / costBasis) * 100 : null;
      return { ticker: p.ticker, shares: p.shares, avgCost: p.avgCost, curPrice, optIncome, divIncome, totalIncome, adjustedAvg, pctRecovered, totalReturnPct };
    }).sort((a, b) => (b.totalReturnPct ?? -Infinity) - (a.totalReturnPct ?? -Infinity));
  }, [openPositions, realizedOptions, currencyDividends, tradesById, prices]);

  const tickerTape = [
    ...openPositions.map((p) => ({ label: p.ticker, val: ((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares })),
    ...openOptions.map((t) => ({ label: `${t.ticker} · ${tradeLabel(t)}`, val: unrealizedOptionPnL(t, markPrices) })),
  ];

  // ---------- cuenta de efectivo ----------
  const netDeposits = currencyCashTx.reduce((s, c) => s + (c.type === "deposit" ? c.amount : -c.amount), 0);
  const accountValue = netDeposits + totalPnL;
  const totalReturnPct = netDeposits > 0 ? (totalPnL / netDeposits) * 100 : null;

  // serie de depósitos netos acumulados en el tiempo, para saber el capital aportado "a fecha de"
  const capitalPoints = useMemo(() => {
    const sorted = [...currencyCashTx].sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return sorted.map((c) => { acc += c.type === "deposit" ? c.amount : -c.amount; return { date: c.date, value: acc }; });
  }, [currencyCashTx]);

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
  const earliestDate = [...currencyCashTx.map((c) => c.date), ...currencyTrades.map((t) => t.date)].sort()[0] || todayStr;

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

  const depositsInPeriod = currencyCashTx.filter((c) => c.date >= activePeriod.start && c.date <= todayStr);

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
      refreshOptionPrices(openOptions, true);
    }
  }, [loading, openOptions]);

  if (loading) {
    return <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}><span className="mono" style={{ color: "var(--muted)" }}>Cargando bitácora…</span></div>;
  }

  return (
    <div className="app">
      <div className="header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}><Menu size={18} /></button>
          <div>
            <div className="eyebrow">BITÁCORA · {session.user.email}</div>
            <div className="h1">Mi Bitácora de Trading</div>
          </div>
        </div>
        <div className="top-actions">
          <div className="tabs">
            {CURRENCIES.map((c) => (
              <button key={c.code} className={`tab ${currency === c.code ? "active" : ""}`} onClick={() => setCurrency(c.code)}>{c.code}</button>
            ))}
          </div>
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

      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />

      <div className="app-body">
        <div className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div className="sidebar-label">Principal</div>
          {[
            { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
            { id: "portfolio", label: "Portafolio", icon: Briefcase },
            { id: "byticker", label: "Por Ticker", icon: Percent },
            { id: "cash", label: "Cuenta de efectivo", icon: Wallet },
            { id: "trades", label: "Trades", icon: ListOrdered },
          ].map((item) => (
            <button
              key={item.id}
              className={`sidebar-item ${view === item.id ? "active" : ""}`}
              onClick={() => { setView(item.id); setSidebarOpen(false); }}
            >
              <item.icon size={16} /> {item.label}
            </button>
          ))}
        </div>

        <div className="content" style={{ flex: 1, minWidth: 0 }}>
          {error && <div className="error-banner">{error}</div>}

        {view === "dashboard" && (
        <>
        {combinedTotal && combinedTotal.breakdown.length > 0 && (
          <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div className="card-label">Patrimonio total (convertido a {currency})</div>
              <div className="card-value big" style={{ color: "var(--gold)" }}>{fmt(combinedTotal.total)}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                {combinedTotal.breakdown.map((b, i) => (
                  <span key={b.code}>
                    {i > 0 && " + "}
                    {currencySymbol(b.code)}{b.value.toLocaleString("en-US", { maximumFractionDigits: 0 })} {b.code}
                  </span>
                ))}
                {fxLoading && " · actualizando tasas…"}
              </div>
            </div>
            {fxError && <div className="error-banner" style={{ margin: 0 }}>{fxError}</div>}
          </div>
        )}
        <div className="cards">
          <div className="card">
            <div className="card-label">P&L Realizado</div>
            <div className="card-value" style={{ color: realizedTotal >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(realizedTotal)}</div>
            <div className="card-sub">trades cerrados + dividendos</div>
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
        </>
        )}

        {view === "cash" && (
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
            {currencyCashTx.length === 0 ? <div className="empty">Sin movimientos aún</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Fecha</th><th>Tipo</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
                  <tbody>
                    {[...currencyCashTx].sort((a, b) => new Date(b.date) - new Date(a.date)).map((c) => (
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
        )}

        {view === "dashboard" && (
        <>
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
            <div className="panel-title">Dividendos</div>
            <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddDividend(true)}><Plus size={14} /> Registrar dividendo</button>
          </div>
          <div className="card" style={{ marginBottom: 16, maxWidth: 220 }}>
            <div className="card-label">Total dividendos</div>
            <div className="card-value" style={{ color: dividendsTotal > 0 ? "var(--gain)" : "var(--muted)" }}>{fmt(dividendsTotal)}</div>
            <div className="card-sub">{currencyDividends.length} registrados</div>
          </div>
          {currencyDividends.length === 0 ? <div className="empty">Sin dividendos registrados aún</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fecha</th><th>Ticker</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
                <tbody>
                  {[...currencyDividends].sort((a, b) => new Date(b.date) - new Date(a.date)).map((d) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{d.date}</td>
                      <td style={{ fontWeight: 500 }}>{d.ticker}</td>
                      <td className="mono" style={{ color: "var(--gain)" }}>{fmt(d.amount)}</td>
                      <td style={{ fontSize: 13, color: "var(--muted)" }}>{d.notes || "—"}</td>
                      <td><button className="icon-btn" style={{ color: "var(--loss)" }} onClick={() => deleteDividend(d.id)}><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>
        )}

        {view === "byticker" && (
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Precio medio ajustado por ticker</div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            El precio medio ajustado descuenta, de tu costo de compra, las primas de opciones cerradas y los dividendos cobrados sobre las acciones que <strong style={{ color: "var(--text)" }}>sigues teniendo</strong>. El % de rendimiento total suma todo: valorización + primas + dividendos, sobre lo que invertiste.
          </div>
          {tickerAdjusted.length === 0 ? <div className="empty">Sin acciones en portafolio</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th><th>Acciones</th><th>$ Compra</th><th>+ Primas</th><th>+ Dividendos</th>
                    <th>$ Ajustado</th><th>% Recuperado</th><th>% Rendimiento total</th>
                  </tr>
                </thead>
                <tbody>
                  {tickerAdjusted.map((r) => (
                    <tr key={r.ticker}>
                      <td style={{ fontWeight: 500 }}>{r.ticker}</td>
                      <td className="mono">{r.shares}</td>
                      <td className="mono">{fmt(r.avgCost)}</td>
                      <td className="mono" style={{ color: r.optIncome > 0 ? "var(--gain)" : "var(--muted)" }}>{r.optIncome > 0 ? fmt(r.optIncome) : "—"}</td>
                      <td className="mono" style={{ color: r.divIncome > 0 ? "var(--gain)" : "var(--muted)" }}>{r.divIncome > 0 ? fmt(r.divIncome) : "—"}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{fmt(r.adjustedAvg)}</td>
                      <td className="mono" style={{ color: "var(--gold)" }}>{r.pctRecovered == null ? "—" : `${r.pctRecovered.toFixed(1)}%`}</td>
                      <td className="mono" style={{ color: r.totalReturnPct == null ? "var(--muted)" : r.totalReturnPct >= 0 ? "var(--gain)" : "var(--loss)" }}>
                        {r.totalReturnPct == null ? "—" : `${r.totalReturnPct >= 0 ? "+" : ""}${r.totalReturnPct.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

        {view === "portfolio" && (
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
        )}

        {view === "trades" && (
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
            trades={currencyTrades.filter((t) => {
              const isOpen = t.type === "option" ? (t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled") : t.action === "buy";
              if (tab === "open") return isOpen;
              if (tab === "closed") return !isOpen;
              return true;
            })}
            sellPnlById={sellPnlById}
            markPrices={markPrices}
            tradesById={tradesById}
            onDelete={deleteTrade}
            onClose={(t) => setClosingTrade(t)}
            onReopen={reopenTrade}
          />
        </div>
        )}
        </div>
      </div>

      {showAdd && <AddTradeModal onCancel={() => setShowAdd(false)} onSave={addTrade} defaultCurrency={currency} />}
      {showAddCash && <AddCashModal onCancel={() => setShowAddCash(false)} onSave={addCashTx} defaultCurrency={currency} />}
      {showAddDividend && <AddDividendModal onCancel={() => setShowAddDividend(false)} onSave={addDividend} defaultCurrency={currency} />}
      {closingTrade && (
        <CloseModal
          trade={closingTrade}
          onCancel={() => setClosingTrade(null)}
          onSave={(date, legCloses, closeCommission) => closeOptionTrade(closingTrade.id, date, legCloses, closeCommission)}
          onAssign={(date) => assignOptionTrade(closingTrade.id, date)}
          onRoll={(date, closePrice, closeCommission, newLeg, newExpiration, newCommission) =>
            rollOptionTrade(closingTrade.id, date, closePrice, closeCommission, newLeg, newExpiration, newCommission)}
          tradesById={tradesById}
        />
      )}
    </div>
  );
}

function TradeTable({ trades, sellPnlById, markPrices, tradesById, onDelete, onClose, onReopen }) {
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
            const isRolled = isOption && t.status === "rolled";
            const isOpen = isOption ? (t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled") : t.action === "buy";
            const expired = isOption && isOpen && t.expiration && t.expiration < todayStr;
            const pnl = isOption
              ? ((t.status === "closed" || t.status === "assigned") ? optionPnL(t, tradesById) : t.status === "rolled" ? 0 : unrealizedOptionPnL(t, markPrices))
              : (t.action === "sell" ? (sellPnlById[t.id] ?? 0) : null);
            const totalCommission = (t.commission || 0) + (t.closeCommission || 0);
            return (
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 12 }}>{t.date}</td>
                <td style={{ fontWeight: 500 }}>{t.ticker}</td>
                <td style={{ fontSize: 13 }}>
                  {tradeLabel(t)}
                  {isOption && t.expiration && <div style={{ fontSize: 11, color: "var(--muted)" }}>Vence {t.expiration}</div>}
                  {t.notes && (t.notes.startsWith("Asignación") || t.notes.startsWith("Roll")) && <div style={{ fontSize: 11, color: "var(--gold)" }}>{t.notes}</div>}
                </td>
                <td className="mono">{t.qty}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{totalCommission > 0 ? fmt(totalCommission) : "—"}</td>
                <td>
                  <span
                    className={`badge ${expired ? "badge-open" : (isAssigned || isRolled) ? "badge-closed" : isOpen ? "badge-open" : "badge-closed"}`}
                    style={
                      expired ? { background: "#3A1A1A", color: "var(--loss)" }
                      : isAssigned ? { background: "#1A2A3A", color: "#7EC8E3" }
                      : isRolled ? { background: "#241A3A", color: "#C7A6F5" }
                      : undefined
                    }
                  >
                    {expired ? "Vencida" : isAssigned ? "Asignada" : isRolled ? "Rolada" : isOpen ? "Abierto" : "Cerrado"}
                  </span>
                </td>
                <td className="mono" style={{ color: pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{pnl == null ? "—" : fmt(pnl)}</td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    {isOption && isOpen && <button className="icon-btn" style={{ color: "var(--gain)" }} title="Cerrar / Asignar / Roll" onClick={() => onClose(t)}><CheckCircle2 size={15} /></button>}
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

function AddTradeModal({ onCancel, onSave, defaultCurrency }) {
  const [type, setType] = useState("stock");
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [commission, setCommission] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency || "USD");
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
      onSave({ type, ticker: ticker.toUpperCase().trim(), date, qty: Number(qty), price: Number(price), action, notes, commission: commissionNum, currency });
    } else {
      if (!expiration) return;
      if (legs.some((l) => l.strike === "" || l.price === "")) return;
      const cleanLegs = legs.map((l) => ({ action: l.action, optionType: l.optionType, strike: Number(l.strike), price: Number(l.price), closePrice: null }));
      onSave({ type, ticker: ticker.toUpperCase().trim(), date, qty: Number(qty), legs: cleanLegs, notes, commission: commissionNum, expiration, currency });
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
          <div className="field"><div className="field-label">Divisa</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
            </select>
          </div>

          {type === "stock" ? (
            <>
              <div className="field"><div className="field-label">Acción</div>
                <select value={action} onChange={(e) => setAction(e.target.value)}><option value="buy">Compra</option><option value="sell">Venta</option></select>
              </div>
              <div className="field"><div className="field-label">Acciones</div><input type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              <div className="field"><div className="field-label">Precio</div><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
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

function AddCashModal({ onCancel, onSave, defaultCurrency }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency || "USD");

  function submit() {
    if (!amount || Number(amount) <= 0) return;
    onSave({ date, type, amount: Number(amount), notes, currency });
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
          <div className="field"><div className="field-label">Divisa</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Monto</div><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Notas (opcional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>

        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar movimiento</button>
      </div>
    </div>
  );
}

function AddDividendModal({ onCancel, onSave, defaultCurrency }) {
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency || "USD");

  function submit() {
    if (!ticker || !amount || Number(amount) <= 0) return;
    onSave({ ticker, date, amount: Number(amount), notes, currency });
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Registrar dividendo</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        <div className="form-grid">
          <div className="field"><div className="field-label">Ticker</div><input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" /></div>
          <div className="field"><div className="field-label">Fecha</div><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><div className="field-label">Divisa</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
            </select>
          </div>
          <div className="field"><div className="field-label">Monto recibido</div><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Notas (opcional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. dividendo trimestral" /></div>
        </div>

        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar dividendo</button>
      </div>
    </div>
  );
}

function CloseModal({ trade, onCancel, onSave, onAssign, onRoll, tradesById }) {
  const canAssign = (trade.legs || []).length === 1;
  const [mode, setMode] = useState("close"); // "close" | "assign" | "roll"
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [legCloses, setLegCloses] = useState((trade.legs || []).map(() => ""));
  const [closeCommission, setCloseCommission] = useState("");

  // campos para el modo "roll"
  const [rollClosePrice, setRollClosePrice] = useState("");
  const [rollCloseCommission, setRollCloseCommission] = useState("");
  const [newExpiration, setNewExpiration] = useState("");
  const [newStrike, setNewStrike] = useState(trade.legs?.[0]?.strike ?? "");
  const [newPrice, setNewPrice] = useState("");
  const [newCommission, setNewCommission] = useState("");

  const preview = mode === "assign" ? assignmentStockTrade(trade) : null;
  const originalLeg = trade.legs?.[0];

  function submitRoll() {
    if (!rollClosePrice || !newExpiration || !newStrike || !newPrice) return;
    onRoll(
      date, rollClosePrice, rollCloseCommission,
      { optionType: originalLeg.optionType, strike: newStrike, price: newPrice },
      newExpiration, newCommission
    );
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Cerrar posición — {trade.ticker}</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        {canAssign && (
          <div className="type-toggle" style={{ flexWrap: "wrap" }}>
            <button onClick={() => setMode("close")} style={{ background: mode === "close" ? "var(--gold)" : "transparent", color: mode === "close" ? "#1A1300" : "var(--muted)", border: `1px solid ${mode === "close" ? "var(--gold)" : "var(--border)"}` }}>
              Cerrar con prima
            </button>
            <button onClick={() => setMode("assign")} style={{ background: mode === "assign" ? "var(--gold)" : "transparent", color: mode === "assign" ? "#1A1300" : "var(--muted)", border: `1px solid ${mode === "assign" ? "var(--gold)" : "var(--border)"}` }}>
              Asignación / Ejercicio
            </button>
            <button onClick={() => setMode("roll")} style={{ background: mode === "roll" ? "var(--gold)" : "transparent", color: mode === "roll" ? "#1A1300" : "var(--muted)", border: `1px solid ${mode === "roll" ? "var(--gold)" : "var(--border)"}` }}>
              Roll
            </button>
          </div>
        )}

        <div className="field" style={{ marginBottom: 14 }}>
          <div className="field-label">{mode === "assign" ? "Fecha de asignación" : mode === "roll" ? "Fecha del roll" : "Fecha de cierre"}</div>
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
              <strong style={{ color: "var(--text)" }}>{preview.shares} acciones</strong> de {trade.ticker} al precio real del strike:{" "}
              <strong style={{ color: "var(--text)" }}>{fmt(preview.price)}</strong> por acción. La prima neta cobrada/pagada en esta cadena (más comisiones) queda registrada como ganancia propia de la opción, sin ocultarse en el precio de la acción.
            </div>
            <button className="btn btn-gain" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={() => onAssign(date)}>
              Confirmar asignación / ejercicio
            </button>
          </>
        )}

        {mode === "roll" && originalLeg && (
          <>
            <div className="field-label" style={{ marginBottom: 8 }}>Cerrar el tramo actual</div>
            <div className="form-grid" style={{ marginBottom: 14 }}>
              <div className="field"><div className="field-label">{legLabel(originalLeg)} — precio de recompra/cierre</div><input type="number" value={rollClosePrice} onChange={(e) => setRollClosePrice(e.target.value)} /></div>
              <div className="field"><div className="field-label">Comisión de cierre ($, opcional)</div><input type="number" value={rollCloseCommission} onChange={(e) => setRollCloseCommission(e.target.value)} placeholder="0.00" /></div>
            </div>

            <div className="field-label" style={{ marginBottom: 8 }}>Abrir el nuevo tramo</div>
            <div className="form-grid">
              <div className="field"><div className="field-label">Nuevo vencimiento</div><input type="date" value={newExpiration} onChange={(e) => setNewExpiration(e.target.value)} /></div>
              <div className="field"><div className="field-label">Nuevo strike</div><input type="number" value={newStrike} onChange={(e) => setNewStrike(e.target.value)} /></div>
              <div className="field"><div className="field-label">Nueva prima ($/contrato)</div><input type="number" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} /></div>
              <div className="field"><div className="field-label">Comisión de apertura ($, opcional)</div><input type="number" value={newCommission} onChange={(e) => setNewCommission(e.target.value)} placeholder="0.00" /></div>
            </div>

            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 12, marginBottom: 4 }}>
              El nuevo tramo mantiene la misma dirección ({originalLeg.action === "sell" ? "venta" : "compra"} de {originalLeg.optionType === "put" ? "put" : "call"}) y sigue acumulando la prima de toda la cadena para cuando finalmente cierres o te asignen.
            </div>

            <button className="btn btn-gain" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={submitRoll}>
              Confirmar roll
            </button>
          </>
        )}
      </div>
    </div>
  );
}
