import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Plus, X, Trash2, CheckCircle2, RotateCcw, LogOut, LayoutDashboard, Briefcase, Wallet, ListOrdered, Menu, Percent, TrendingUp } from "lucide-react";
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
// Convierte un importe de una divisa a otra usando tasas con base = toCur (rates[fromCur] = cuántas
// unidades de fromCur equivalen a 1 toCur). Si no hay tasa disponible, devuelve el importe sin convertir.
function convert(amount, fromCur, toCur, rates) {
  if (!amount) return 0;
  if (!fromCur || fromCur === toCur) return amount;
  if (!rates || rates[fromCur] == null) return amount;
  return amount / rates[fromCur];
}

const fmt = (n) =>
  (n < 0 ? `-${ACTIVE_SYMBOL}` : ACTIVE_SYMBOL) + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = (n) =>
  (n < 0 ? `-${ACTIVE_SYMBOL}` : ACTIVE_SYMBOL) + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
// Para celdas de tabla que muestran un importe en SU PROPIA divisa (no la divisa de totales activa)
const fmtCur = (n, curCode) => {
  const sym = currencySymbol(curCode);
  return (n < 0 ? `-${sym}` : sym) + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
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
// Clasifica una opción de una sola pata en una estrategia reconocible; los spreads van aparte.
function optionStrategy(t) {
  const legs = t.legs || [];
  if (legs.length !== 1) return "Spreads";
  const l = legs[0];
  if (l.action === "sell" && l.optionType === "put") return "Cash Secured Put";
  if (l.action === "sell" && l.optionType === "call") return "Covered Call";
  if (l.action === "buy" && l.optionType === "call") return "Call comprada";
  return "Put comprada";
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

  const byTicker = {}; // ticker -> { lots: [{qtyRemaining, price, commissionPerShare}] }
  const sorted = [...stockTrades].sort((a, b) => new Date(a.date) - new Date(b.date));
  let stockRealized = 0;
  for (const t of sorted) {
    const tk = t.ticker;
    if (!byTicker[tk]) byTicker[tk] = { lots: [] };
    const p = byTicker[tk];
    if (t.action === "buy") {
      const commissionPerShare = t.qty > 0 ? (t.commission || 0) / t.qty : 0;
      p.lots.push({ qtyRemaining: t.qty, price: t.price, commissionPerShare });
    } else {
      let qtyToSell = t.qty;
      let pnl = -(t.commission || 0);
      while (qtyToSell > 0.0001 && p.lots.length > 0) {
        const lot = p.lots[0]; // FIFO: el lote más antiguo primero
        const take = Math.min(lot.qtyRemaining, qtyToSell);
        pnl += (t.price - lot.price - lot.commissionPerShare) * take;
        lot.qtyRemaining -= take;
        qtyToSell -= take;
        if (lot.qtyRemaining <= 0.0001) p.lots.shift();
      }
      stockRealized += pnl;
    }
  }
  const posArr = Object.entries(byTicker).map(([ticker, p]) => {
    const shares = p.lots.reduce((s, l) => s + l.qtyRemaining, 0);
    const totalCost = p.lots.reduce((s, l) => s + l.qtyRemaining * (l.price + l.commissionPerShare), 0);
    const avgCost = shares > 0 ? totalCost / shares : 0;
    return { ticker, shares, avgCost };
  });
  const openPos = posArr.filter((p) => p.shares > 0);
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
  const [snapshots, setSnapshots] = useState([]);
  const [showAddSnapshot, setShowAddSnapshot] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showAddCash, setShowAddCash] = useState(false);
  const [closingTrade, setClosingTrade] = useState(null);
  const [tab, setTab] = useState("open");
  const [period, setPeriod] = useState("mtd");
  const [dashboardPeriod, setDashboardPeriod] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [markPrices, setMarkPrices] = useState({});
  const [view, setView] = useState("dashboard"); // "dashboard" | "portfolio" | "cash" | "trades"
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currency, setCurrency] = useState("EUR"); // divisa de los TOTALES combinados (no filtra las tablas)
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

  // Supabase/PostgREST limita cada consulta a 1000 filas por defecto. Con este historial
  // tan grande, hace falta pedir los datos en bloques hasta traerlos todos.
  async function fetchAllRows(table, orderBy) {
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
      let query = supabase.from(table).select("*").range(from, from + pageSize - 1);
      if (orderBy) query = query.order(orderBy, { ascending: true });
      const { data, error } = await query;
      if (error) throw error;
      all = all.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [tradeRows, priceRows, cashRows, divRows, snapRows] = await Promise.all([
        fetchAllRows("trades", "date"),
        fetchAllRows("current_prices"),
        fetchAllRows("cash_transactions", "date"),
        fetchAllRows("dividends", "date"),
        fetchAllRows("account_snapshots", "date"),
      ]);
      setTrades((tradeRows || []).map(fromRow));
      const pMap = {};
      (priceRows || []).forEach((r) => { pMap[r.ticker] = Number(r.price); });
      setPrices(pMap);
      setCashTx((cashRows || []).map((r) => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount), notes: r.notes, currency: r.currency || "USD" })));
      setDividends((divRows || []).map((r) => ({ id: r.id, ticker: r.ticker, date: r.date, amount: Number(r.amount), notes: r.notes, currency: r.currency || "USD" })));
      setSnapshots((snapRows || []).map((r) => ({ id: r.id, date: r.date, value: Number(r.value), currency: r.currency || "USD", notes: r.notes })));
    } catch (e) {
      setError(e.message || "No se pudieron cargar los datos.");
    }
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

  async function addSnapshot(data) {
    setError("");
    const row = { user_id: userId, date: data.date, value: data.value, currency: data.currency || "USD", notes: data.notes || null };
    const { data: inserted, error: err } = await supabase.from("account_snapshots").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setSnapshots((prev) => [...prev, { id: inserted.id, date: inserted.date, value: Number(inserted.value), currency: inserted.currency || "USD", notes: inserted.notes }]);
    setShowAddSnapshot(false);
  }

  async function deleteSnapshot(id) {
    setSnapshots((prev) => prev.filter((s) => s.id !== id));
    const { error: err } = await supabase.from("account_snapshots").delete().eq("id", id);
    if (err) { setError(err.message); loadAll(); }
  }

  // ---------- derived ----------
  // Ya NO se filtra por divisa: se muestran TODOS los trades juntos. Las sumas que combinan
  // divisas distintas se convierten a `currency` (la divisa de totales) con el tipo de cambio del día.
  const tradesById = useMemo(() => Object.fromEntries(trades.map((t) => [t.id, t])), [trades]);
  function fx(amount, fromCur) { return convert(amount, fromCur, currency, fxRates); }

  const stockTrades = useMemo(() => trades.filter((t) => t.type === "stock"), [trades]);
  const optionTrades = useMemo(() => trades.filter((t) => t.type === "option"), [trades]);

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

  // Se aplica FIFO (primera acción comprada, primera vendida) tal como exige la normativa
  // fiscal española, en vez de un precio medio ponderado. Esto también nos deja saber EXACTAMENTE
  // qué compra concreta sigue abierta (lotRemainingByTradeId), no solo el total del ticker.
  const { positions, sellPnlById, lotRemainingByTradeId } = useMemo(() => {
    const byTicker = {}; // ticker -> { lots: [{id, qtyRemaining, price, commissionPerShare}], currency }
    const pnlById = {};
    const remainingById = {};
    const sorted = [...stockTrades].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const t of sorted) {
      const tk = t.ticker;
      if (!byTicker[tk]) byTicker[tk] = { ticker: tk, lots: [], currency: t.currency || "USD" };
      const p = byTicker[tk];
      if (t.action === "buy") {
        const commissionPerShare = t.qty > 0 ? (t.commission || 0) / t.qty : 0;
        p.lots.push({ id: t.id, qtyRemaining: t.qty, price: t.price, commissionPerShare });
        remainingById[t.id] = t.qty;
      } else {
        let qtyToSell = t.qty;
        let pnl = -(t.commission || 0); // comisión de la venta, aparte de las comisiones de compra ya prorrateadas
        while (qtyToSell > 0.0001 && p.lots.length > 0) {
          const lot = p.lots[0]; // el lote más antiguo primero: FIFO
          const take = Math.min(lot.qtyRemaining, qtyToSell);
          pnl += (t.price - lot.price - lot.commissionPerShare) * take;
          lot.qtyRemaining -= take;
          remainingById[lot.id] = lot.qtyRemaining;
          qtyToSell -= take;
          if (lot.qtyRemaining <= 0.0001) p.lots.shift();
        }
        pnlById[t.id] = pnl;
      }
    }
    const positionsArr = Object.values(byTicker).map((p) => {
      const shares = p.lots.reduce((s, l) => s + l.qtyRemaining, 0);
      const totalCost = p.lots.reduce((s, l) => s + l.qtyRemaining * (l.price + l.commissionPerShare), 0);
      const avgCost = shares > 0 ? totalCost / shares : 0;
      return { ticker: p.ticker, shares, avgCost, totalCost, currency: p.currency };
    });
    return { positions: positionsArr, sellPnlById: pnlById, lotRemainingByTradeId: remainingById };
  }, [stockTrades]);

  const openPositions = positions.filter((p) => p.shares > 0);
  // Para saber, fila a fila en el historial, si UN ticker sigue teniendo acciones abiertas hoy
  // (no basta con mirar si esa fila concreta fue una "compra": pudo venderse después).
  const openSharesByTicker = useMemo(() => Object.fromEntries(positions.map((p) => [p.ticker, p.shares])), [positions]);
  const totalMarketValue = openPositions.reduce((s, p) => s + fx((prices[p.ticker] ?? p.avgCost) * p.shares, p.currency), 0);
  const stockRealized = stockTrades.filter((t) => t.action === "sell").reduce((s, t) => s + fx(sellPnlById[t.id] ?? 0, t.currency), 0);
  const stockUnrealized = openPositions.reduce((s, p) => s + fx(((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares, p.currency), 0);

  const closedOptions = optionTrades.filter((t) => t.status === "closed");
  const assignedOptions = optionTrades.filter((t) => t.status === "assigned");
  // "cerradas" a efectos de P&L: incluye las asignadas, porque ahora su prima se cuenta como
  // ganancia propia (ver optionPnL), no se oculta dentro del precio del trade de acciones.
  const realizedOptions = [...closedOptions, ...assignedOptions];
  const openOptions = optionTrades.filter((t) => t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled");
  const optionRealized = realizedOptions.reduce((s, t) => s + fx(optionPnL(t, tradesById), t.currency), 0);
  const optionUnrealized = openOptions.reduce((s, t) => s + fx(unrealizedOptionPnL(t, markPrices) || 0, t.currency), 0);

  const dividendsTotal = dividends.reduce((s, d) => s + fx(d.amount, d.currency), 0);
  const realizedTotal = stockRealized + optionRealized + dividendsTotal;
  const unrealizedTotal = stockUnrealized + optionUnrealized;
  const totalPnL = realizedTotal + unrealizedTotal;

  const closedSells = stockTrades.filter((t) => t.action === "sell");
  const closedForWinRate = [...closedSells, ...realizedOptions];
  const wins = closedForWinRate.filter((t) => t.type === "option" ? optionPnL(t, tradesById) > 0 : (sellPnlById[t.id] ?? 0) > 0).length;
  const winRate = closedForWinRate.length ? (wins / closedForWinRate.length) * 100 : null;

  const chartData = useMemo(() => {
    const events = [];
    for (const t of closedSells) events.push({ date: t.date, pnl: convert(sellPnlById[t.id] ?? 0, t.currency, currency, fxRates) });
    for (const t of realizedOptions) events.push({ date: t.closeDate || t.date, pnl: convert(optionPnL(t, tradesById), t.currency, currency, fxRates) });
    for (const d of dividends) events.push({ date: d.date, pnl: convert(d.amount, d.currency, currency, fxRates) });
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return events.map((e, i) => { acc += e.pnl; return { i: i + 1, date: e.date, acumulado: Math.round(acc * 100) / 100 }; });
  }, [closedSells, realizedOptions, sellPnlById, tradesById, dividends, currency, fxRates]);

  const byTickerChart = useMemo(() => {
    const map = {};
    function bump(ticker, pnl, kind, cur) {
      if (!map[ticker]) map[ticker] = { pnl: 0, stockN: 0, optN: 0, divN: 0, currency: cur };
      map[ticker].pnl += pnl;
      if (kind === "stock") map[ticker].stockN += 1;
      else if (kind === "option") map[ticker].optN += 1;
      else map[ticker].divN += 1;
    }
    for (const t of closedSells) bump(t.ticker, sellPnlById[t.id] ?? 0, "stock", t.currency);
    for (const t of realizedOptions) bump(t.ticker, optionPnL(t, tradesById), "option", t.currency);
    for (const d of dividends) bump(d.ticker, d.amount, "dividend", d.currency);
    return Object.entries(map)
      .map(([ticker, v]) => ({ ticker, pnl: Math.round(v.pnl * 100) / 100, stockN: v.stockN, optN: v.optN, divN: v.divN, currency: v.currency }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [closedSells, realizedOptions, sellPnlById, tradesById, dividends]);

  // ---------- precio medio ajustado por ticker (primas de opciones + dividendos, sobre acciones que aún tienes) ----------
  // Se excluye a propósito el P&L de ventas parciales de acciones: eso ya es una realización aparte,
  // no un ingreso extra que deba "rebajar" el costo de las acciones que sigues teniendo. Los importes
  // quedan en la divisa nativa del ticker (no se combinan entre sí).
  const tickerAdjusted = useMemo(() => {
    const optMap = {};
    const divMap = {};
    for (const t of realizedOptions) optMap[t.ticker] = (optMap[t.ticker] || 0) + optionPnL(t, tradesById);
    for (const d of dividends) divMap[d.ticker] = (divMap[d.ticker] || 0) + d.amount;
    return openPositions.map((p) => {
      const optIncome = optMap[p.ticker] || 0;
      const divIncome = divMap[p.ticker] || 0;
      const totalIncome = optIncome + divIncome;
      const adjustedAvg = p.avgCost - totalIncome / p.shares;
      const curPrice = prices[p.ticker] ?? p.avgCost;
      const costBasis = p.avgCost * p.shares;
      const pctRecovered = costBasis > 0 ? (totalIncome / costBasis) * 100 : null;
      const totalReturnPct = costBasis > 0 ? (((curPrice - p.avgCost) * p.shares + totalIncome) / costBasis) * 100 : null;
      return { ticker: p.ticker, shares: p.shares, avgCost: p.avgCost, curPrice, optIncome, divIncome, totalIncome, adjustedAvg, pctRecovered, totalReturnPct, currency: p.currency };
    }).sort((a, b) => (b.totalReturnPct ?? -Infinity) - (a.totalReturnPct ?? -Infinity));
  }, [openPositions, realizedOptions, dividends, tradesById, prices]);

  const tickerTape = [
    ...openPositions.map((p) => ({ label: p.ticker, val: fx(((prices[p.ticker] ?? p.avgCost) - p.avgCost) * p.shares, p.currency) })),
    ...openOptions.map((t) => ({ label: `${t.ticker} · ${tradeLabel(t)}`, val: unrealizedOptionPnL(t, markPrices) != null ? fx(unrealizedOptionPnL(t, markPrices), t.currency) : null })),
  ];

  // ---------- opciones abiertas agrupadas por estrategia (para el Portafolio) ----------
  const openOptionsByStrategy = useMemo(() => {
    const groups = {};
    const order = ["Cash Secured Put", "Covered Call", "Call comprada", "Put comprada", "Spreads"];
    for (const t of openOptions) {
      const key = optionStrategy(t);
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    return order.filter((k) => groups[k]).map((k) => ({ strategy: k, trades: groups[k] }));
  }, [openOptions]);

  // ---------- cuenta de efectivo ----------
  const netDeposits = cashTx.reduce((s, c) => s + fx(c.type === "deposit" ? c.amount : -c.amount, c.currency), 0);
  const accountValue = netDeposits + totalPnL;
  const totalReturnPct = netDeposits > 0 ? (totalPnL / netDeposits) * 100 : null;

  // serie de depósitos netos acumulados en el tiempo (convertidos a la divisa de totales), para
  // saber el capital aportado "a fecha de"
  const capitalPoints = useMemo(() => {
    const sorted = [...cashTx].sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return sorted.map((c) => {
      acc += convert(c.type === "deposit" ? c.amount : -c.amount, c.currency, currency, fxRates);
      return { date: c.date, value: acc };
    });
  }, [cashTx, currency, fxRates]);

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

  // Marco temporal específico para el gráfico del Dashboard: semana/mes/año en curso, año natural, todo.
  const DASHBOARD_PERIODS = [
    { id: "1w", label: "Semana" },
    { id: "mtd", label: "Mes" },
    { id: "ytd", label: "Año en curso" },
    { id: "1y", label: "Año natural" },
    { id: "all", label: "Todo" },
  ].map((p) => ({ ...p, start: PERIODS.find((full) => full.id === p.id).start }));
  const activeDashboardPeriod = DASHBOARD_PERIODS.find((p) => p.id === dashboardPeriod) || DASHBOARD_PERIODS[4];
  const dashboardChartData = useMemo(
    () => chartData.filter((pt) => pt.date >= activeDashboardPeriod.start),
    [chartData, activeDashboardPeriod.start]
  );

  const realizedNow = valueAsOf(realizedPoints, todayStr, "acumulado");
  const realizedAtStart = valueAsOf(realizedPoints, activePeriod.start, "acumulado");
  const periodResult = realizedNow - realizedAtStart;
  const capitalAtStart = valueAsOf(capitalPoints, activePeriod.start, "value");
  const periodReturnPct = capitalAtStart > 0 ? (periodResult / capitalAtStart) * 100 : null;

  const depositsInPeriod = cashTx.filter((c) => c.date >= activePeriod.start && c.date <= todayStr);

  // ---------- plusvalías por categoría (acciones / opciones / dividendos) ----------
  const [gainsPeriod, setGainsPeriod] = useState("ytd");
  const activeGainsPeriod = PERIODS.find((p) => p.id === gainsPeriod) || PERIODS[4];

  function cumulativePoints(events) {
    const sorted = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));
    let acc = 0;
    return sorted.map((e) => { acc += e.pnl; return { date: e.date, acumulado: acc }; });
  }
  const stockPnlPoints = useMemo(
    () => cumulativePoints(closedSells.map((t) => ({ date: t.date, pnl: convert(sellPnlById[t.id] ?? 0, t.currency, currency, fxRates) }))),
    [closedSells, sellPnlById, currency, fxRates]
  );
  const optionPnlPoints = useMemo(
    () => cumulativePoints(realizedOptions.map((t) => ({ date: t.closeDate || t.date, pnl: convert(optionPnL(t, tradesById), t.currency, currency, fxRates) }))),
    [realizedOptions, tradesById, currency, fxRates]
  );
  const dividendPnlPoints = useMemo(
    () => cumulativePoints(dividends.map((d) => ({ date: d.date, pnl: convert(d.amount, d.currency, currency, fxRates) }))),
    [dividends, currency, fxRates]
  );

  function periodDelta(points) {
    return valueAsOf(points, todayStr, "acumulado") - valueAsOf(points, activeGainsPeriod.start, "acumulado");
  }
  const gainsStocks = periodDelta(stockPnlPoints);
  const gainsOptions = periodDelta(optionPnlPoints);
  const gainsDividends = periodDelta(dividendPnlPoints);
  const gainsTotal = gainsStocks + gainsOptions + gainsDividends;

  const inActiveGainsPeriod = (d) => d >= activeGainsPeriod.start && d <= todayStr;
  const gainsStocksCount = closedSells.filter((t) => inActiveGainsPeriod(t.date)).length;
  const gainsOptionsClosedCount = realizedOptions.filter((t) => t.status === "closed" && inActiveGainsPeriod(t.closeDate || t.date)).length;
  const gainsOptionsAssignedCount = realizedOptions.filter((t) => t.status === "assigned" && inActiveGainsPeriod(t.closeDate || t.date)).length;
  const gainsDividendsCount = dividends.filter((d) => inActiveGainsPeriod(d.date)).length;

  // ---------- opciones del periodo, desglosadas por estrategia ----------
  const gainsOptionsByStrategy = useMemo(() => {
    const map = {};
    for (const t of realizedOptions) {
      const d = t.closeDate || t.date;
      if (!inActiveGainsPeriod(d)) continue;
      const strat = optionStrategy(t);
      const pnl = convert(optionPnL(t, tradesById), t.currency, currency, fxRates);
      if (!map[strat]) map[strat] = { pnl: 0, count: 0 };
      map[strat].pnl += pnl;
      map[strat].count += 1;
    }
    return Object.entries(map).map(([strategy, v]) => ({ strategy, pnl: v.pnl, count: v.count })).sort((a, b) => b.pnl - a.pnl);
  }, [realizedOptions, tradesById, currency, fxRates, activeGainsPeriod.start, todayStr]);

  // ---------- serie de "valor de cuenta" anclada a tus valores reales conocidos ----------
  // Entre dos valores reales (o desde el último conocido hacia delante), se sigue el cambio de
  // capital + ganancias realizadas — pero el PUNTO DE PARTIDA en cada tramo es el valor real, no
  // la aproximación. Así, las ganancias que ya tenías sin realizar ANTES de una fecha con valor
  // conocido no se cuelan como si fueran rendimiento de un periodo posterior.
  const balancePoints = useMemo(() => {
    const sortedSnapshots = [...snapshots].sort((a, b) => new Date(a.date) - new Date(b.date));
    function rawValue(d) { return valueAsOf(capitalPoints, d, "value") + valueAsOf(realizedPoints, d, "acumulado"); }
    const dates = Array.from(new Set([
      ...capitalPoints.map((p) => p.date), ...realizedPoints.map((p) => p.date), ...sortedSnapshots.map((s) => s.date),
    ])).sort();
    let anchorDate = null, anchorValue = 0, anchorRaw = 0;
    return dates.map((d) => {
      const snap = [...sortedSnapshots].filter((s) => s.date <= d).slice(-1)[0];
      if (snap && snap.date !== anchorDate) {
        anchorDate = snap.date;
        anchorValue = convert(snap.value, snap.currency, currency, fxRates);
        anchorRaw = rawValue(snap.date);
      }
      const raw = rawValue(d);
      const value = anchorDate ? anchorValue + (raw - anchorRaw) : raw;
      return { date: d, value };
    });
  }, [snapshots, capitalPoints, realizedPoints, currency, fxRates]);

  const gainsPeriodDays = Math.max(1, Math.round((new Date(todayStr) - new Date(activeGainsPeriod.start)) / 86400000));
  // ¿el propio periodo arranca justo en (o muy cerca de) una fecha con valor real conocido?
  const nearbySnapshot = useMemo(() => {
    const startTime = new Date(activeGainsPeriod.start).getTime();
    let best = null, bestDiff = Infinity;
    for (const s of snapshots) {
      const diff = Math.abs(new Date(s.date).getTime() - startTime);
      if (diff < bestDiff) { bestDiff = diff; best = s; }
    }
    return best && bestDiff <= 5 * 86400000 ? best : null;
  }, [snapshots, activeGainsPeriod.start]);
  const dietzStartValue = valueAsOf(balancePoints, activeGainsPeriod.start, "value");
  const dietzContributions = cashTx.filter((c) => c.date >= activeGainsPeriod.start && c.date <= todayStr);
  const dietzWeightedContrib = dietzContributions.reduce((s, c) => {
    const amt = convert(c.type === "deposit" ? c.amount : -c.amount, c.currency, currency, fxRates);
    const daysRemaining = Math.max(0, (new Date(todayStr) - new Date(c.date)) / 86400000);
    const weight = daysRemaining / gainsPeriodDays;
    return s + amt * weight;
  }, 0);
  const gainsSaldoMedio = dietzStartValue + dietzWeightedContrib;
  const gainsSimpleReturnPct = gainsSaldoMedio > 0 ? gainsTotal / gainsSaldoMedio : null;
  const gainsTAE = gainsSimpleReturnPct != null ? (Math.pow(1 + gainsSimpleReturnPct, 365 / gainsPeriodDays) - 1) * 100 : null;

  // ---------- TWR (rentabilidad ponderada por tiempo, como la que muestra tu bróker) ----------
  // A diferencia del TAE/Dietz, el TWR aísla el rendimiento de la ESTRATEGIA del momento en que
  // metiste o sacaste dinero: se trocea el periodo en cada movimiento de efectivo, se calcula el
  // rendimiento "orgánico" de cada trozo (sin el efecto del propio movimiento), y se encadenan.
  const gainsTWRPeriod = useMemo(() => {
    const flows = [...dietzContributions].sort((a, b) => new Date(a.date) - new Date(b.date));
    let twr = 1;
    let segStart = activeGainsPeriod.start;
    for (const cf of flows) {
      const dayBeforeCf = new Date(new Date(cf.date).getTime() - 86400000).toISOString().slice(0, 10);
      const segEnd = dayBeforeCf >= segStart ? dayBeforeCf : segStart;
      const vStart = valueAsOf(balancePoints, segStart, "value");
      const vEnd = valueAsOf(balancePoints, segEnd, "value");
      if (vStart > 0) twr *= (vEnd / vStart);
      segStart = cf.date; // el siguiente tramo arranca ya con este movimiento incluido
    }
    const vStart = valueAsOf(balancePoints, segStart, "value");
    const vEnd = valueAsOf(balancePoints, todayStr, "value");
    if (vStart > 0) twr *= (vEnd / vStart);
    return twr - 1;
  }, [dietzContributions, balancePoints, activeGainsPeriod.start, todayStr]);
  const gainsTWR = (Math.pow(1 + gainsTWRPeriod, 365 / gainsPeriodDays) - 1) * 100;

  // ---------- histórico mes a mes (mes en curso primero, hacia atrás) ----------
  const monthlyGains = useMemo(() => {
    const allDates = [...stockPnlPoints, ...optionPnlPoints, ...dividendPnlPoints].map((p) => p.date);
    if (allDates.length === 0) return [];
    const minDate = allDates.sort()[0];
    const minD = new Date(minDate);
    const months = [];
    let cur = new Date(today.getFullYear(), today.getMonth(), 1);
    const minMonth = new Date(minD.getFullYear(), minD.getMonth(), 1);
    while (cur >= minMonth) {
      const monthStartDate = new Date(cur);
      const nextMonthDate = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const lastDayDate = new Date(nextMonthDate.getTime() - 86400000);
      const monthStart = monthStartDate.toISOString().slice(0, 10);
      const prevDay = new Date(monthStartDate.getTime() - 86400000).toISOString().slice(0, 10);
      const lastDay = (lastDayDate > today ? today : lastDayDate).toISOString().slice(0, 10);
      const stocksM = valueAsOf(stockPnlPoints, lastDay, "acumulado") - valueAsOf(stockPnlPoints, prevDay, "acumulado");
      const optionsM = valueAsOf(optionPnlPoints, lastDay, "acumulado") - valueAsOf(optionPnlPoints, prevDay, "acumulado");
      const dividendsM = valueAsOf(dividendPnlPoints, lastDay, "acumulado") - valueAsOf(dividendPnlPoints, prevDay, "acumulado");
      months.push({
        key: monthStart,
        label: monthStartDate.toLocaleDateString("es-ES", { month: "long", year: "numeric" }),
        stocks: stocksM, options: optionsM, dividends: dividendsM, total: stocksM + optionsM + dividendsM,
      });
      cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
    }
    return months;
  }, [stockPnlPoints, optionPnlPoints, dividendPnlPoints]);

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
          <div className="tabs" title="Divisa de los totales combinados (no oculta nada, todo se sigue viendo junto)">
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
            { id: "gains", label: "Plusvalías", icon: TrendingUp },
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
        <>
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
                  <thead><tr><th>Fecha</th><th>Tipo</th><th>Divisa</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
                  <tbody>
                    {[...cashTx].sort((a, b) => new Date(b.date) - new Date(a.date)).map((c) => (
                      <tr key={c.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{c.date}</td>
                        <td><span className={`badge ${c.type === "deposit" ? "badge-closed" : "badge-open"}`}>{c.type === "deposit" ? "Depósito" : "Retiro"}</span></td>
                        <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{c.currency || "USD"}</td>
                        <td className="mono" style={{ color: c.type === "deposit" ? "var(--gain)" : "var(--loss)" }}>{c.type === "deposit" ? "+" : "-"}{fmtCur(c.amount, c.currency)}</td>
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

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Valores de cuenta conocidos</div>
            <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddSnapshot(true)}><Plus size={14} /> Añadir valor</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            Si tienes el valor real de tu cuenta (inversiones + efectivo) a una fecha concreta — por ejemplo, del "Valor liquidativo" de un extracto de tu bróker — guárdalo aquí. La app lo usará para calcular el <strong style={{ color: "var(--text)" }}>TAE</strong> en Plusvalías con más precisión que la aproximación automática.
          </div>
          {snapshots.length === 0 ? <div className="empty">Sin valores guardados aún</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fecha</th><th>Divisa</th><th>Valor</th><th>Notas</th><th></th></tr></thead>
                <tbody>
                  {[...snapshots].sort((a, b) => new Date(b.date) - new Date(a.date)).map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{s.date}</td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{s.currency || "USD"}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{fmtCur(s.value, s.currency)}</td>
                      <td style={{ fontSize: 13, color: "var(--muted)" }}>{s.notes || "—"}</td>
                      <td><button className="icon-btn" style={{ color: "var(--loss)" }} onClick={() => deleteSnapshot(s.id)}><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>
        )}

        {view === "dashboard" && (
        <>
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Curva de P&L acumulado</div>
            <div className="tabs">
              {DASHBOARD_PERIODS.map((p) => (
                <button key={p.id} className={`tab ${dashboardPeriod === p.id ? "active" : ""}`} onClick={() => setDashboardPeriod(p.id)}>{p.label}</button>
              ))}
            </div>
          </div>
          {dashboardChartData.length === 0 ? <div className="empty">Sin trades cerrados en este periodo</div> : (
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={dashboardChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} minTickGap={40} />
                <YAxis tick={{ fill: "#7E8CA6", fontSize: 12 }} axisLine={{ stroke: "#20304C" }} tickLine={false} tickFormatter={fmtCompact} width={64} />
                <ReferenceLine y={0} stroke="#20304C" />
                <Tooltip
                  contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 8, fontSize: 13, padding: "8px 12px" }}
                  labelStyle={{ color: "var(--gold)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}
                  itemStyle={{ color: "var(--text)" }}
                  formatter={(v) => [fmt(v), "Acumulado"]}
                  labelFormatter={(label) => label}
                />
                <Line type="monotone" dataKey="acumulado" stroke="#E8A33D" strokeWidth={2.5} dot={false} activeDot={{ r: 5, fill: "#E8A33D" }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">P&L por ticker</div></div>
          {byTickerChart.length === 0 ? <div className="empty">Sin trades cerrados aún</div> : (
            <div className="cards">
              {byTickerChart.map((d) => {
                const parts = [];
                if (d.stockN > 0) parts.push(`${d.stockN} acción${d.stockN > 1 ? "es" : ""}`);
                if (d.optN > 0) parts.push(`${d.optN} opción${d.optN > 1 ? "es" : ""}`);
                if (d.divN > 0) parts.push(`${d.divN} dividendo${d.divN > 1 ? "s" : ""}`);
                return (
                  <div className="card" key={d.ticker}>
                      <div className="card-label">{d.ticker}</div>
                      <div className="card-value" style={{ color: d.pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmtCur(d.pnl, d.currency)}</div>
                      <div className="card-sub">{parts.join(" · ")}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Dividendos</div>
            <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddDividend(true)}><Plus size={14} /> Registrar dividendo</button>
          </div>
          <div className="card" style={{ marginBottom: 16, maxWidth: 220 }}>
            <div className="card-label">Total dividendos</div>
            <div className="card-value" style={{ color: dividendsTotal > 0 ? "var(--gain)" : "var(--muted)" }}>{fmt(dividendsTotal)}</div>
            <div className="card-sub">{dividends.length} registrados</div>
          </div>
          {dividends.length === 0 ? <div className="empty">Sin dividendos registrados aún</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fecha</th><th>Ticker</th><th>Divisa</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
                <tbody>
                  {[...dividends].sort((a, b) => new Date(b.date) - new Date(a.date)).map((d) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{d.date}</td>
                      <td style={{ fontWeight: 500 }}>{d.ticker}</td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{d.currency || "USD"}</td>
                      <td className="mono" style={{ color: "var(--gain)" }}>{fmtCur(d.amount, d.currency)}</td>
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

        {view === "gains" && (
        <>
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Plusvalías / minusvalías por periodo</div>
            <div className="tabs" style={{ flexWrap: "wrap" }}>
              {PERIODS.map((p) => (
                <button key={p.id} className={`tab ${gainsPeriod === p.id ? "active" : ""}`} onClick={() => setGainsPeriod(p.id)}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="cards">
            <div className="card">
              <div className="card-label">Acciones/ETF</div>
              <div className="card-value" style={{ color: gainsStocks >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(gainsStocks)}</div>
              <div className="card-sub">{gainsStocksCount} venta{gainsStocksCount === 1 ? "" : "s"} cerrada{gainsStocksCount === 1 ? "" : "s"}</div>
            </div>
            <div className="card">
              <div className="card-label">Opciones</div>
              <div className="card-value" style={{ color: gainsOptions >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(gainsOptions)}</div>
              <div className="card-sub">{gainsOptionsClosedCount} cerrada{gainsOptionsClosedCount === 1 ? "" : "s"} · {gainsOptionsAssignedCount} asignada{gainsOptionsAssignedCount === 1 ? "" : "s"}</div>
            </div>
            <div className="card">
              <div className="card-label">Dividendos</div>
              <div className="card-value" style={{ color: gainsDividends >= 0 ? "var(--gain)" : "var(--muted)" }}>{fmt(gainsDividends)}</div>
              <div className="card-sub">{gainsDividendsCount > 0 ? `${gainsDividendsCount} cobrado${gainsDividendsCount === 1 ? "" : "s"}` : "sin dividendos en este periodo"}</div>
            </div>
            <div className="card">
              <div className="card-label">Total</div>
              <div className="card-value big" style={{ color: gainsTotal >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(gainsTotal)}</div>
              <div className="card-sub">{activeGainsPeriod.label === "TODO" ? "desde el inicio" : `desde ${activeGainsPeriod.start}`}</div>
            </div>
          </div>

          {gainsOptionsByStrategy.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="field-label" style={{ marginBottom: 8 }}>Opciones — por estrategia</div>
              <div className="cards">
                {gainsOptionsByStrategy.map((g) => (
                  <div className="card" key={g.strategy}>
                    <div className="card-label">{g.strategy}</div>
                    <div className="card-value" style={{ color: g.pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(g.pnl)}</div>
                    <div className="card-sub">{g.count} operaci{g.count === 1 ? "ón" : "ones"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 18, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="card" style={{ maxWidth: 320, flex: "1 1 280px" }}>
              <div className="card-label">Rendimiento del periodo (money-weighted)</div>
              <div className="card-value big" style={{ color: gainsSimpleReturnPct == null ? "var(--muted)" : gainsSimpleReturnPct >= 0 ? "var(--gain)" : "var(--loss)" }}>
                {gainsSimpleReturnPct == null ? "—" : `${gainsSimpleReturnPct >= 0 ? "+" : ""}${(gainsSimpleReturnPct * 100).toFixed(1)}%`}
              </div>
              <div className="card-sub">
                {gainsSaldoMedio > 0
                  ? `sobre ${fmt(gainsSaldoMedio)}${nearbySnapshot ? " (valor real)" : ""} · ${gainsPeriodDays}d`
                  : "saldo de referencia no disponible en este periodo"}
                {gainsTAE != null && <> · anualizado (TAE): <span style={{ color: gainsTAE >= 0 ? "var(--gain)" : "var(--loss)" }}>{gainsTAE >= 0 ? "+" : ""}{gainsTAE.toFixed(1)}%</span></>}
              </div>
            </div>
            <div className="card" style={{ maxWidth: 320, flex: "1 1 280px" }}>
              <div className="card-label">Rendimiento del periodo (time-weighted)</div>
              <div className="card-value big" style={{ color: gainsTWRPeriod >= 0 ? "var(--gain)" : "var(--loss)" }}>
                {gainsTWRPeriod >= 0 ? "+" : ""}{(gainsTWRPeriod * 100).toFixed(1)}%
              </div>
              <div className="card-sub">
                {gainsPeriodDays}d · anualizado (TWR): <span style={{ color: gainsTWR >= 0 ? "var(--gain)" : "var(--loss)" }}>{gainsTWR >= 0 ? "+" : ""}{gainsTWR.toFixed(1)}%</span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.5 }}>
            El número grande es el rendimiento real de este periodo (compáralo con lo que veas en tu bróker para el mismo rango de fechas). El "anualizado" de abajo extrapola ese ritmo a 12 meses — solo es representativo cuando el periodo ya casi terminó; si eliges "Año en curso" a mitad de año, un buen tramo puede anualizarse a un número muy alto sin que eso sea realista. El primero (money-weighted) refleja lo que <strong style={{ color: "var(--text)" }}>tú</strong> ganaste según cuándo metiste o sacaste dinero; el segundo (time-weighted, como tu bróker) aísla el rendimiento de tu <strong style={{ color: "var(--text)" }}>forma de operar</strong>.
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Histórico mes a mes</div></div>
          {monthlyGains.length === 0 ? <div className="empty">Sin datos suficientes aún</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 480, overflowY: "auto" }}>
              {monthlyGains.map((m) => (
                <div key={m.key} className="panel" style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div className="mono" style={{ fontSize: 13, color: "var(--gold)", textTransform: "capitalize" }}>{m.label}</div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: m.total >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(m.total)}</div>
                  </div>
                  <div className="cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                    <div>
                      <div className="card-label">Acciones/ETF</div>
                      <div className="mono" style={{ fontSize: 13, color: m.stocks >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(m.stocks)}</div>
                    </div>
                    <div>
                      <div className="card-label">Opciones</div>
                      <div className="mono" style={{ fontSize: 13, color: m.options >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(m.options)}</div>
                    </div>
                    <div>
                      <div className="card-label">Dividendos</div>
                      <div className="mono" style={{ fontSize: 13, color: m.dividends >= 0 ? "var(--gain)" : "var(--muted)" }}>{fmt(m.dividends)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </>
        )}

        {view === "byticker" && (
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Precio medio ajustado por ticker (acciones y ETFs)</div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
            El precio medio ajustado descuenta, de tu costo de compra, las primas de opciones cerradas y los dividendos cobrados sobre las acciones o ETFs que <strong style={{ color: "var(--text)" }}>sigues teniendo</strong>. El % de rendimiento total suma todo: valorización + primas + dividendos, sobre lo que invertiste.
          </div>
          {tickerAdjusted.length === 0 ? <div className="empty">Sin acciones ni ETFs en portafolio</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th><th>Divisa</th><th>Acciones</th><th>$ Compra</th><th>+ Primas</th><th>+ Dividendos</th>
                    <th>$ Ajustado</th><th>% Recuperado</th><th>% Rendimiento total</th>
                  </tr>
                </thead>
                <tbody>
                  {tickerAdjusted.map((r) => (
                    <tr key={r.ticker}>
                      <td style={{ fontWeight: 500 }}>{r.ticker}</td>
                      <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{r.currency || "USD"}</td>
                      <td className="mono">{r.shares}</td>
                      <td className="mono">{fmtCur(r.avgCost, r.currency)}</td>
                      <td className="mono" style={{ color: r.optIncome === 0 ? "var(--muted)" : r.optIncome > 0 ? "var(--gain)" : "var(--loss)" }}>{r.optIncome === 0 ? "—" : fmtCur(r.optIncome, r.currency)}</td>
                      <td className="mono" style={{ color: r.divIncome === 0 ? "var(--muted)" : "var(--gain)" }}>{r.divIncome === 0 ? "—" : fmtCur(r.divIncome, r.currency)}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{fmtCur(r.adjustedAvg, r.currency)}</td>
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
        <>
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Portafolio — acciones y ETFs</div>
            {openPositions.length > 0 && (
              <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} disabled={refreshing} onClick={() => refreshPrices(openPositions.map((p) => p.ticker))}>
                {refreshing ? "Actualizando…" : "Actualizar precios"}
              </button>
            )}
          </div>
          {openPositions.length === 0 ? <div className="empty">Sin acciones ni ETFs en portafolio</div> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ticker</th><th>Divisa</th><th>Acciones</th><th>$ Prom.</th><th>$ Actual</th><th>$ Mercado</th><th>P&L no realiz.</th><th>%</th></tr></thead>
                <tbody>
                  {openPositions.map((p) => {
                    const cur = prices[p.ticker] ?? p.avgCost;
                    const mv = cur * p.shares;
                    const pnl = (cur - p.avgCost) * p.shares;
                    const pct = p.avgCost ? (pnl / (p.avgCost * p.shares)) * 100 : 0;
                    return (
                      <tr key={p.ticker}>
                        <td style={{ fontWeight: 500 }}>{p.ticker}</td>
                        <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{p.currency || "USD"}</td>
                        <td className="mono">{p.shares}</td>
                        <td className="mono">{fmtCur(p.avgCost, p.currency)}</td>
                        <td>
                          <input
                            type="number" className="price-input"
                            value={prices[p.ticker] ?? ""} placeholder={p.avgCost.toFixed(2)}
                            onChange={(e) => setPrice(p.ticker, Number(e.target.value))}
                          />
                        </td>
                        <td className="mono">{fmtCur(mv, p.currency)}</td>
                        <td className="mono" style={{ color: pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmtCur(pnl, p.currency)}</td>
                        <td className="mono" style={{ color: pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {totalMarketValue > 0 && <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>Valor total de mercado (convertido a {currency}): <span style={{ color: "var(--text)" }}>{fmt(totalMarketValue)}</span></div>}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Opciones abiertas — por estrategia</div></div>
          {openOptions.length === 0 ? <div className="empty">Sin opciones abiertas</div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {openOptionsByStrategy.map((group) => {
                const groupTotal = group.trades.reduce((s, t) => {
                  const u = unrealizedOptionPnL(t, markPrices);
                  return s + (u != null ? fx(u, t.currency) : 0);
                }, 0);
                return (
                  <div key={group.strategy}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{group.strategy} <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>({group.trades.length})</span></div>
                      <div className="mono" style={{ fontSize: 13, color: groupTotal >= 0 ? "var(--gain)" : "var(--loss)" }}>{fmt(groupTotal)}</div>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Ticker</th><th>Divisa</th><th>Detalle</th><th>Vencimiento</th><th>Prima</th><th>P&L no realiz.</th></tr></thead>
                        <tbody>
                          {group.trades.map((t) => {
                            const u = unrealizedOptionPnL(t, markPrices);
                            const daysLeft = t.expiration ? Math.ceil((new Date(t.expiration) - new Date()) / 86400000) : null;
                            return (
                              <tr key={t.id}>
                                <td style={{ fontWeight: 500 }}>{t.ticker}</td>
                                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{t.currency || "USD"}</td>
                                <td style={{ fontSize: 13 }}>{tradeLabel(t)} <span className="mono" style={{ color: "var(--muted)" }}>× {t.qty}</span></td>
                                <td className="mono" style={{ fontSize: 12 }}>
                                  {t.expiration || "—"}
                                  {daysLeft != null && <span style={{ color: daysLeft < 0 ? "var(--loss)" : "var(--muted)", marginLeft: 6 }}>({daysLeft < 0 ? "vencida" : `${daysLeft}d`})</span>}
                                </td>
                                <td className="mono">{fmtCur((t.legs || []).reduce((s, l) => s + l.price, 0), t.currency)}</td>
                                <td className="mono" style={{ color: u == null ? "var(--muted)" : u >= 0 ? "var(--gain)" : "var(--loss)" }}>{u == null ? "—" : fmtCur(u, t.currency)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </>
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
            trades={trades.filter((t) => {
              const isOpen = t.type === "option"
                ? (t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled")
                : (t.action === "buy" && (lotRemainingByTradeId[t.id] || 0) > 0.0001);
              if (tab === "open") return isOpen;
              if (tab === "closed") return !isOpen;
              return true;
            })}
            sellPnlById={sellPnlById}
            markPrices={markPrices}
            tradesById={tradesById}
            lotRemainingByTradeId={lotRemainingByTradeId}
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
      {showAddSnapshot && <AddSnapshotModal onCancel={() => setShowAddSnapshot(false)} onSave={addSnapshot} defaultCurrency={currency} />}
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

function TradeTable({ trades, sellPnlById, markPrices, tradesById, lotRemainingByTradeId, onDelete, onClose, onReopen }) {
  if (trades.length === 0) return <div className="empty">No hay trades en esta vista</div>;
  const sorted = [...trades].sort((a, b) => new Date(b.date) - new Date(a.date));
  const todayStr = new Date().toISOString().slice(0, 10);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Ticker</th><th>Divisa</th><th>Tipo</th><th>Cant.</th><th>Comisión</th><th>Estado</th><th>P&L</th><th></th></tr></thead>
        <tbody>
          {sorted.map((t) => {
            const isOption = t.type === "option";
            const isAssigned = isOption && t.status === "assigned";
            const isRolled = isOption && t.status === "rolled";
            // Para acciones: FIFO (norma fiscal española) nos dice exactamente cuánto de ESTA
            // compra concreta sigue sin vender — no basta con mirar el total del ticker.
            const remaining = lotRemainingByTradeId?.[t.id];
            const isOpen = isOption
              ? (t.status !== "closed" && t.status !== "assigned" && t.status !== "rolled")
              : (t.action === "buy" && (remaining || 0) > 0.0001);
            const partial = !isOption && t.action === "buy" && remaining > 0.0001 && remaining < t.qty - 0.0001;
            const expired = isOption && isOpen && t.expiration && t.expiration < todayStr;
            const pnl = isOption
              ? ((t.status === "closed" || t.status === "assigned") ? optionPnL(t, tradesById) : t.status === "rolled" ? 0 : unrealizedOptionPnL(t, markPrices))
              : (t.action === "sell" ? (sellPnlById[t.id] ?? 0) : null);
            const totalCommission = (t.commission || 0) + (t.closeCommission || 0);
            return (
              <tr key={t.id}>
                <td className="mono" style={{ fontSize: 12 }}>{t.date}</td>
                <td style={{ fontWeight: 500 }}>{t.ticker}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{t.currency || "USD"}</td>
                <td style={{ fontSize: 13 }}>
                  {tradeLabel(t)}
                  {isOption && t.expiration && <div style={{ fontSize: 11, color: "var(--muted)" }}>Vence {t.expiration}</div>}
                  {t.notes && (t.notes.startsWith("Asignación") || t.notes.startsWith("Roll")) && <div style={{ fontSize: 11, color: "var(--gold)" }}>{t.notes}</div>}
                </td>
                <td className="mono">{t.qty}{partial && <div style={{ fontSize: 10, color: "var(--gold)" }}>quedan {remaining}</div>}</td>
                <td className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{totalCommission > 0 ? fmtCur(totalCommission, t.currency) : "—"}</td>
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
                <td className="mono" style={{ color: pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--gain)" : "var(--loss)" }}>{pnl == null ? "—" : fmtCur(pnl, t.currency)}</td>
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
              {k === "stock" ? "Acción / ETF" : "Opción / Spread"}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <div className="field"><div className="field-label">Ticker</div><input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL, SPY..." /></div>
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
                <div className="field"><div className="field-label">{leg.action === "sell" ? "Prima cobrada" : "Prima pagada"}</div><input type="number" value={leg.price} onChange={(e) => updateLeg(i, { price: e.target.value })} /></div>
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
          <div className="field"><div className="field-label">Ticker</div><input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL, SPY..." /></div>
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

function AddSnapshotModal({ onCancel, onSave, defaultCurrency }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency || "USD");

  function submit() {
    if (!value || Number(value) <= 0) return;
    onSave({ date, value: Number(value), notes, currency });
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Valor de cuenta conocido</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>

        <div className="form-grid">
          <div className="field"><div className="field-label">Fecha</div><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="field"><div className="field-label">Divisa</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
            </select>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Valor total (inversiones + efectivo)</div><input type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0.00" /></div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Notas (opcional)</div><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej. Valor liquidativo extracto 2025" /></div>
        </div>

        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar valor</button>
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
              <div className="field"><div className="field-label">{originalLeg?.action === "sell" ? "Nueva prima cobrada" : "Nueva prima pagada"} ($/contrato)</div><input type="number" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} /></div>
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
