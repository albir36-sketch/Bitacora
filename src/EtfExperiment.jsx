import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { RefreshCw } from "lucide-react";
import { supabase } from "./supabaseClient";

// Experimento de ETF: cartera TEÓRICA de 10.000 $ en ETF sectoriales de EE. UU., elegidos según la
// fase del ciclo económico con reglas fijas. Se compara con el S&P 500 (SPY), el Nasdaq-100 (QQQ)
// y dos grupos de control de 10.000 $ cada uno: los 11 sectores a partes iguales y momentum puro
// (los 3 sectores que más han subido en 126 sesiones). La fase, las altas y las bajas se registran
// en la base de datos en cada revisión mensual; esta vista solo lee, actualiza precios y guarda
// una foto diaria para el gráfico.
//
// Tablas etfexp_*: en etfexp_positions, `book` dice a qué libro pertenece cada posición
// ('cartera', 'iguales' o 'momentum'). Las fotos de etfexp_snapshots se guardan SIN dividendos.

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_API_KEY;
const BENCHMARKS = ["SPY", "QQQ"];
const BOOKS = ["cartera", "iguales", "momentum"];
const BOOK_LABEL = { cartera: "Cartera por ciclo", iguales: "Sectores a partes iguales", momentum: "Momentum puro" };
const COLORS = { cartera: "#E8A33D", iguales: "#2DD4BF", momentum: "#F472B6", spy: "#60A5FA", qqq: "#C084FC" };

const PHASE_LABEL = { recuperacion: "Recuperación", expansion: "Expansión", desaceleracion: "Desaceleración", contraccion: "Contracción" };
// Lista de cada fase, en orden: con la inflación al alza, la energía (XLE) sustituye al último.
const PHASES = [
  { id: "recuperacion", level: "Baja", dir: "Mejora", etfs: ["XLY", "XLI", "XLB", "XLF"], swap: true },
  { id: "expansion", level: "Alta", dir: "Mejora", etfs: ["XLK", "XLI", "XLC", "XLF"], swap: true },
  { id: "desaceleracion", level: "Alta", dir: "Empeora", etfs: ["XLV", "XLP", "XLU", "XLE"], swap: false },
  { id: "contraccion", level: "Baja", dir: "Empeora", etfs: ["XLV", "XLP", "GLD", "Letras"], swap: false },
];
const phaseEtfs = (p, inflation) => (inflation && p.swap ? [...p.etfs.slice(0, 3), "XLE"] : p.etfs);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Devuelve el último precio y la fecha de mercado (Nueva York) de esa cotización.
async function fetchQuoteFull(ticker) {
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} al consultar ${ticker}`);
  const data = await res.json();
  if (data.c == null || data.c === 0) throw new Error(`Sin cotización para ${ticker}`);
  let marketDate = null;
  if (data.t) {
    marketDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(data.t * 1000));
  }
  return { price: data.c, marketDate };
}

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtPct = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const fmtPts = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })} pp`;
const fmtNum = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const fmtWeight = (n) => (n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const pct = (now, base) => (now == null || !base ? null : (now / base - 1) * 100);

// Dividendos por acción de `ticker` con fecha ex-dividendo posterior a `from` y hasta `to` incluido
// (`to` nulo = hasta hoy). Las fechas son textos "AAAA-MM-DD", que se comparan bien como texto.
function divsBetween(dividends, ticker, from, to) {
  return dividends.reduce(
    (sum, d) => (d.ticker === ticker && d.ex_date > from && (to == null || d.ex_date <= to) ? sum + Number(d.amount) : sum),
    0
  );
}
const totalRet = (price, divs, base) => (price == null ? null : pct(price + divs, base));

// Valor SIN dividendos de un libro con los precios dados (los cerrados cuentan a su precio de salida).
function bookValueNoDivs(positions, book, cap, priceOf) {
  let cash = cap, invested = 0;
  positions.filter((p) => p.book === book).forEach((p) => {
    const qty = num(p.qty);
    cash -= qty * num(p.entry_price);
    if (p.exit_date != null) cash += qty * num(p.exit_price);
    else invested += qty * (priceOf(p.ticker) ?? num(p.entry_price));
  });
  return cash + invested;
}

export default function EtfExperiment({ session }) {
  const userId = session.user.id;
  const [config, setConfig] = useState(null);
  const [signals, setSignals] = useState([]);
  const [positions, setPositions] = useState([]);
  const [prices, setPrices] = useState({}); // { ticker: { price, updated_at } }
  const [snapshots, setSnapshots] = useState([]);
  const [log, setLog] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [watch, setWatch] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    const res = await Promise.all([
      supabase.from("etfexp_config").select("*").maybeSingle(),
      supabase.from("etfexp_signals").select("*").order("review_date", { ascending: false }),
      supabase.from("etfexp_positions").select("*").order("weight_pct", { ascending: false }),
      supabase.from("etfexp_prices").select("*"),
      supabase.from("etfexp_snapshots").select("*").order("date", { ascending: true }),
      supabase.from("etfexp_log").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("etfexp_dividends").select("*").order("ex_date", { ascending: true }),
      supabase.from("etfexp_watch").select("*").order("ticker", { ascending: true }),
    ]);
    const firstErr = res.find((r) => r.error);
    if (firstErr) setError(firstErr.error.message);
    const [c, sg, p, pr, s, l, dv, w] = res.map((r) => r.data);
    setConfig(c || null);
    setSignals(sg || []);
    setPositions(p || []);
    const map = {};
    (pr || []).forEach((r) => { map[r.ticker] = { price: num(r.price), updated_at: r.updated_at }; });
    setPrices(map);
    setSnapshots(s || []);
    setLog(l || []);
    setDividends(dv || []);
    setWatch(w || []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  const signal = signals[0] || null;

  // ---------- cálculos ----------
  const calc = useMemo(() => {
    if (!config) return null;
    const cap = num(config.start_capital);
    const spyNow = prices.SPY?.price ?? null;
    const qqqNow = prices.QQQ?.price ?? null;

    const rows = positions.map((p) => {
      const qty = num(p.qty);
      const entry = num(p.entry_price);
      const closed = p.exit_date != null;
      const last = prices[p.ticker]?.price ?? null;
      const ref = closed ? num(p.exit_price) : (last ?? entry);
      const divs = divsBetween(dividends, p.ticker, p.entry_date, p.exit_date);
      const ret = totalRet(ref, divs, entry);
      const spyRet = totalRet(closed ? num(p.spy_exit) : spyNow, divsBetween(dividends, "SPY", p.entry_date, p.exit_date), num(p.spy_entry));
      const qqqRet = totalRet(closed ? num(p.qqq_exit) : qqqNow, divsBetween(dividends, "QQQ", p.entry_date, p.exit_date), num(p.qqq_entry));
      return {
        ...p, qty, entry, closed, last, ref, ret, divs,
        vsSpy: ret != null && spyRet != null ? ret - spyRet : null,
        vsQqq: ret != null && qqqRet != null ? ret - qqqRet : null,
        cost: qty * entry, value: qty * ref, divCash: qty * divs,
        pnl: qty * (ref - entry + divs),
      };
    });

    const books = {};
    BOOKS.forEach((b) => {
      const mine = rows.filter((r) => r.book === b);
      const open = mine.filter((r) => !r.closed);
      const closedRows = mine.filter((r) => r.closed);
      const divTotal = mine.reduce((s, r) => s + r.divCash, 0);
      const cash = cap - mine.reduce((s, r) => s + r.cost, 0) + closedRows.reduce((s, r) => s + r.value, 0) + divTotal;
      const total = cash + open.reduce((s, r) => s + r.value, 0);
      open.forEach((r) => { r.weightNow = total ? (r.value / total) * 100 : null; });
      mine.forEach((r) => { r.contrib = cap ? (r.pnl / cap) * 100 : null; });
      open.sort((a, b2) => (b2.weightNow ?? 0) - (a.weightNow ?? 0));
      books[b] = { open, closedRows, cash, total, divTotal, ret: mine.length ? pct(total, cap) : null, cashWeight: total ? (cash / total) * 100 : null };
    });

    const spyRet = totalRet(spyNow, divsBetween(dividends, "SPY", config.start_date, null), num(config.spy_start));
    const qqqRet = totalRet(qqqNow, divsBetween(dividends, "QQQ", config.start_date, null), num(config.qqq_start));
    const stamps = Object.values(prices).map((x) => x.updated_at).filter(Boolean).sort();
    return { cap, books, spyRet, qqqRet, lastUpdate: stamps.length ? stamps[stamps.length - 1] : null };
  }, [config, positions, prices, dividends]);

  const chartData = useMemo(() => {
    if (!config || snapshots.length === 0) return [];
    const cap = num(config.start_capital), spy0 = num(config.spy_start), qqq0 = num(config.qqq_start);
    // La foto guardada es el valor SIN dividendos; aquí se suman los cobrados hasta cada fecha.
    const divCashUpTo = (book, date) => positions.filter((p) => p.book === book).reduce((sum, p) => {
      const to = p.exit_date != null && p.exit_date < date ? p.exit_date : date;
      return sum + num(p.qty) * divsBetween(dividends, p.ticker, p.entry_date, to);
    }, 0);
    const line = (value, book, date) => (value == null ? null : ((num(value) + divCashUpTo(book, date)) / cap) * 100);
    return snapshots.map((s) => ({
      date: fmtDate(s.date),
      cartera: line(s.portfolio_value, "cartera", s.date),
      iguales: line(s.equal_value, "iguales", s.date),
      momentum: line(s.momentum_value, "momentum", s.date),
      spy: ((num(s.spy_price) + divsBetween(dividends, "SPY", config.start_date, s.date)) / spy0) * 100,
      qqq: ((num(s.qqq_price) + divsBetween(dividends, "QQQ", config.start_date, s.date)) / qqq0) * 100,
    }));
  }, [config, snapshots, positions, dividends]);

  // Descartes a vigilar: rentabilidad (con dividendos) desde su fecha de inicio, frente al ETF que ocupa su sitio.
  const watchRows = useMemo(() => watch.map((w) => {
    const ret = w.start_price == null ? null : totalRet(prices[w.ticker]?.price ?? null, divsBetween(dividends, w.ticker, w.start_date, null), num(w.start_price));
    const vsRet = w.versus_start_price == null ? null : totalRet(prices[w.versus]?.price ?? null, divsBetween(dividends, w.versus, w.start_date, null), num(w.versus_start_price));
    return { ...w, ret, vsRet, diff: ret != null && vsRet != null ? ret - vsRet : null };
  }), [watch, prices, dividends]);

  // ---------- actualizar precios + guardar la foto del día ----------
  async function refresh() {
    if (!FINNHUB_KEY) { setError("Para actualizar precios falta configurar VITE_FINNHUB_API_KEY en Vercel."); return; }
    setRefreshing(true);
    setError("");
    const openTickers = positions.filter((p) => p.exit_date == null).map((p) => p.ticker);
    const tickers = [...new Set([...positions.map((p) => p.ticker), ...watch.flatMap((w) => [w.ticker, w.versus]), ...BENCHMARKS])];
    const next = { ...prices };
    const failed = [];
    let marketDate = null;
    for (let i = 0; i < tickers.length; i++) {
      const tk = tickers[i];
      setProgress(`${i + 1}/${tickers.length} · ${tk}`);
      try {
        const q = await fetchQuoteFull(tk);
        next[tk] = { price: q.price, updated_at: new Date().toISOString() };
        if (tk === "SPY" && q.marketDate) marketDate = q.marketDate;
      } catch (e) {
        failed.push(tk);
      }
      await sleep(120); // margen para el límite de peticiones de Finnhub
    }
    const upserts = tickers.filter((tk) => !failed.includes(tk)).map((tk) => ({ user_id: userId, ticker: tk, price: next[tk].price, updated_at: next[tk].updated_at }));
    if (upserts.length) {
      const { error: err } = await supabase.from("etfexp_prices").upsert(upserts, { onConflict: "user_id,ticker" });
      if (err) setError(err.message);
    }
    setPrices(next);

    // Foto del día (una por fecha de mercado). Solo si están los dos índices y TODAS las posiciones
    // abiertas de los tres libros con precio fresco, para no guardar un valor a medias.
    const complete = !failed.includes("SPY") && !failed.includes("QQQ") && openTickers.every((tk) => !failed.includes(tk));
    if (config && positions.length && complete && marketDate && marketDate >= config.start_date) {
      const cap = num(config.start_capital);
      const priceOf = (tk) => next[tk]?.price ?? null;
      const row = {
        user_id: userId, date: marketDate,
        portfolio_value: bookValueNoDivs(positions, "cartera", cap, priceOf),
        equal_value: bookValueNoDivs(positions, "iguales", cap, priceOf),
        momentum_value: bookValueNoDivs(positions, "momentum", cap, priceOf),
        spy_price: next.SPY.price, qqq_price: next.QQQ.price,
      };
      const { data: saved, error: err } = await supabase.from("etfexp_snapshots").upsert(row, { onConflict: "user_id,date" }).select().single();
      if (err) setError(err.message);
      else setSnapshots((prev) => [...prev.filter((s) => s.date !== saved.date), saved].sort((a, b) => (a.date < b.date ? -1 : 1)));
    }
    if (failed.length) setError(`No se pudo actualizar: ${failed.join(", ")}. El resto sí; la foto del día no se guarda hasta que estén todos.`);
    setProgress("");
    setRefreshing(false);
  }

  if (loading) return <div className="panel"><div className="empty">Cargando experimento…</div></div>;

  const started = config != null && calc != null && positions.length > 0;
  const th = { textAlign: "right" };
  const td = { textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" };
  const noteBox = { position: "sticky", left: 0, maxWidth: "min(760px, calc(100vw - 80px))", whiteSpace: "normal" };
  const yesNo = (ok) => <span style={{ color: ok ? "var(--gain)" : "var(--loss)" }}>{ok ? "Sí" : "No"}</span>;
  const main = started ? calc.books.cartera : null;
  const adv = (other) => (main?.ret != null && other != null ? main.ret - other : null);

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="eyebrow">EXPERIMENTO · CARTERA TEÓRICA DE ETF</div>
          <div className="h1">¿Aporta algo rotar sectores según el ciclo?</div>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {started
              ? `Desde el ${fmtDate(config.start_date)} con ${fmtMoney(calc.cap, 0)} teóricos · con dividendos (sin reinvertir) y sin comisiones, igual que los controles y los índices`
              : "Reglas aprobadas. La cartera entra a la apertura de la primera sesión posterior a la decisión."}
          </div>
        </div>
        {started && (
          <div style={{ textAlign: "right" }}>
            <button className="btn btn-gold" onClick={refresh} disabled={refreshing}>
              <RefreshCw size={15} /> {refreshing ? `Actualizando ${progress}` : "Actualizar precios"}
            </button>
            <div className="card-sub" style={{ marginTop: 6 }}>
              {calc.lastUpdate ? `Precios del ${new Date(calc.lastUpdate).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}` : "Sin precios todavía"}
            </div>
          </div>
        )}
      </div>

      {started && (
        <div className="cards">
          <div className="card">
            <div className="card-label">Cartera por ciclo</div>
            <div className="card-value big" style={{ color: signColor(main.ret) }}>{fmtPct(main.ret, 2)}</div>
            <div className="card-sub">{fmtMoney(main.total)} · dividendos cobrados {fmtMoney(main.divTotal)}</div>
          </div>
          {[["iguales", "Sectores iguales"], ["momentum", "Momentum puro"]].map(([b, label]) => (
            <div className="card" key={b}>
              <div className="card-label">{label}</div>
              <div className="card-value big" style={{ color: signColor(calc.books[b].ret) }}>{fmtPct(calc.books[b].ret, 2)}</div>
              <div className="card-sub">ventaja de la cartera: <span style={{ color: signColor(adv(calc.books[b].ret)) }}>{fmtPts(adv(calc.books[b].ret), 2)}</span></div>
            </div>
          ))}
          <div className="card">
            <div className="card-label">S&P 500 · QQQ</div>
            <div className="card-value big">
              <span style={{ color: signColor(calc.spyRet) }}>{fmtPct(calc.spyRet, 1)}</span>
              <span style={{ color: "var(--muted)" }}> · </span>
              <span style={{ color: signColor(calc.qqqRet) }}>{fmtPct(calc.qqqRet, 1)}</span>
            </div>
            <div className="card-sub">
              ventaja: <span style={{ color: signColor(adv(calc.spyRet)) }}>{fmtPts(adv(calc.spyRet), 2)}</span> · <span style={{ color: signColor(adv(calc.qqqRet)) }}>{fmtPts(adv(calc.qqqRet), 2)}</span>
            </div>
          </div>
        </div>
      )}

      {signal && (
        <div className="panel">
          <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
            <div className="panel-title">Fase del ciclo · lectura del {fmtDate(signal.review_date)}</div>
            <div className="mono" style={{ fontSize: 13 }}>
              <span style={{ color: "var(--gold)", fontWeight: 600 }}>{PHASE_LABEL[signal.phase_confirmed]}</span>
              <span style={{ color: "var(--muted)" }}>{signal.inflation_switch ? " · inflación al alza" : ""}</span>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Indicador</th><th>Dato</th><th style={th}>¿Actividad alta?</th><th style={th}>¿Mejora?</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>ISM manufacturero</td>
                  <td style={{ color: "var(--muted)", fontSize: 13 }}>{fmtNum(num(signal.ism), 1)} · media de 3 meses {fmtNum(num(signal.ism_avg3), 1)} frente a {fmtNum(num(signal.ism_prev3), 1)}</td>
                  <td style={td}>{yesNo(num(signal.ism) >= 50)}</td>
                  <td style={td}>{yesNo(num(signal.ism_avg3) > num(signal.ism_prev3))}</td>
                </tr>
                <tr>
                  <td>Indicador de Sahm (paro)</td>
                  <td style={{ color: "var(--muted)", fontSize: 13 }}>{fmtNum(num(signal.sahm))} · hace 3 meses {fmtNum(num(signal.sahm_3m_ago))}</td>
                  <td style={td}>{yesNo(num(signal.sahm) < 0.3)}</td>
                  <td style={td}>{yesNo(num(signal.sahm) <= num(signal.sahm_3m_ago))}</td>
                </tr>
                <tr>
                  <td>Diferencial high yield</td>
                  <td style={{ color: "var(--muted)", fontSize: 13 }}>{fmtNum(num(signal.hy))} · media de 20 sesiones {fmtNum(num(signal.hy_avg20))} frente a {fmtNum(num(signal.hy_avg20_3m_ago))}</td>
                  <td style={td}>{yesNo(num(signal.hy) < 5)}</td>
                  <td style={td}>{yesNo(num(signal.hy_avg20) < num(signal.hy_avg20_3m_ago))}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Resultado</td>
                  <td style={{ color: "var(--muted)", fontSize: 13 }}>dos o tres síes deciden</td>
                  <td style={td}>{signal.level_votes >= 2 ? "Alta" : "Baja"} ({signal.level_votes} de 3)</td>
                  <td style={td}>{signal.direction_votes >= 2 ? "Mejora" : "Empeora"} ({signal.direction_votes} de 3)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 10, lineHeight: 1.6 }}>
            Inflación (IPC interanual): {fmtNum(num(signal.cpi_yoy), 1)}% frente a {fmtNum(num(signal.cpi_yoy_6m_ago), 1)}% seis meses antes
            {signal.inflation_switch ? " · por encima del 3% y subiendo: la energía sustituye al último ETF de la lista" : " · interruptor apagado"}
            {" · "}Curva 10 años − 3 meses: {fmtPts(num(signal.curve_10y3m), 2)} (se anota, no vota)
            {signal.phase_read !== signal.phase_confirmed ? ` · Lectura de este mes: ${PHASE_LABEL[signal.phase_read]}, pendiente de confirmar en la próxima revisión` : ""}
          </div>
          {signal.note && <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 8 }}>{signal.note}</div>}

          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table>
              <thead>
                <tr><th>Fase</th><th>Actividad</th><th>Tendencia</th><th>ETF (25% cada uno)</th></tr>
              </thead>
              <tbody>
                {PHASES.map((p) => {
                  const current = p.id === signal.phase_confirmed;
                  return (
                    <tr key={p.id} style={current ? { background: "#2A2410" } : undefined}>
                      <td style={{ fontWeight: current ? 600 : 400, color: current ? "var(--gold)" : "var(--text)", paddingLeft: 8 }}>{PHASE_LABEL[p.id]}</td>
                      <td style={{ color: "var(--muted)" }}>{p.level}</td>
                      <td style={{ color: "var(--muted)" }}>{p.dir}</td>
                      <td className="mono" style={{ fontSize: 13 }}>{phaseEtfs(p, signal.inflation_switch).join(" · ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {started && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Evolución (base 100 el día de inicio)</div></div>
          {chartData.length < 2 ? (
            <div className="empty">El gráfico aparecerá cuando haya al menos dos días con precios. Pulsa «Actualizar precios» cada vez que entres y se irá dibujando.</div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <LineChart data={chartData} margin={{ top: 8, right: 28, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} minTickGap={40} />
                <YAxis domain={["auto", "auto"]} tick={{ fill: "#7E8CA6", fontSize: 12 }} axisLine={{ stroke: "#20304C" }} tickLine={false} width={48} tickFormatter={(v) => v.toFixed(0)} />
                <ReferenceLine y={100} stroke="#20304C" />
                <Tooltip
                  contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 8, fontSize: 13, padding: "8px 12px" }}
                  labelStyle={{ color: "var(--gold)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}
                  formatter={(v, name) => [`${v.toFixed(2)} (${fmtPct(v - 100, 2)})`, name]}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
                <Line type="linear" name="Cartera por ciclo" dataKey="cartera" stroke={COLORS.cartera} strokeWidth={2.5} dot={chartData.length < 15} activeDot={{ r: 5 }} isAnimationActive={false} />
                <Line type="linear" name="Sectores iguales" dataKey="iguales" stroke={COLORS.iguales} strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls isAnimationActive={false} />
                <Line type="linear" name="Momentum" dataKey="momentum" stroke={COLORS.momentum} strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls isAnimationActive={false} />
                <Line type="linear" name="S&P 500" dataKey="spy" stroke={COLORS.spy} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
                <Line type="linear" name="QQQ" dataKey="qqq" stroke={COLORS.qqq} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {started && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Cartera por ciclo ({main.open.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ETF</th><th style={th}>Peso</th><th style={th}>Rent.</th><th style={th}>Vs S&P 500</th><th style={th}>Vs QQQ</th>
                  <th style={th}>Entrada</th><th style={th}>Actual</th><th style={th}>Aporta</th>
                </tr>
              </thead>
              <tbody>
                {main.open.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span>{" "}
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>{r.name}</span>
                    </td>
                    <td style={td}>{fmtWeight(r.weightNow)}</td>
                    <td style={{ ...td, color: signColor(r.ret) }}>{fmtPct(r.ret)}</td>
                    <td style={{ ...td, color: signColor(r.vsSpy) }}>{fmtPts(r.vsSpy)}</td>
                    <td style={{ ...td, color: signColor(r.vsQqq) }}>{fmtPts(r.vsQqq)}</td>
                    <td style={td}>{fmtDate(r.entry_date)} · {fmtMoney(r.entry)}</td>
                    <td style={td}>{fmtMoney(r.last)}</td>
                    <td style={{ ...td, color: signColor(r.contrib) }}>{fmtPts(r.contrib, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ color: "var(--muted)" }}>Liquidez · <span className="mono">{fmtMoney(main.cash)}</span></td>
                  <td style={td}>{fmtWeight(main.cashWeight)}</td>
                  <td colSpan={6} />
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>
            La rentabilidad incluye los dividendos cobrados, que se quedan en liquidez. Solo se compra y se vende cuando cambia la fase confirmada o el interruptor de inflación.
          </div>
        </div>
      )}

      {started && main.closedRows.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Posiciones cerradas de la cartera ({main.closedRows.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>ETF</th><th>Fase</th><th style={th}>Entrada</th><th style={th}>Salida</th><th style={th}>Rent.</th><th style={th}>Vs S&P 500</th><th style={th}>Vs QQQ</th></tr>
              </thead>
              <tbody>
                {main.closedRows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td><span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{r.name}</span></td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{PHASE_LABEL[r.phase] || "—"}</td>
                      <td style={td}>{fmtDate(r.entry_date)} · {fmtMoney(r.entry)}</td>
                      <td style={td}>{fmtDate(r.exit_date)} · {fmtMoney(r.ref)}</td>
                      <td style={{ ...td, color: signColor(r.ret) }}>{fmtPct(r.ret)}</td>
                      <td style={{ ...td, color: signColor(r.vsSpy) }}>{fmtPts(r.vsSpy)}</td>
                      <td style={{ ...td, color: signColor(r.vsQqq) }}>{fmtPts(r.vsQqq)}</td>
                    </tr>
                    {r.exit_reason && (
                      <tr><td colSpan={7} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13 }}><div style={noteBox}>Motivo de salida: {r.exit_reason}</div></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {started && (
        <div className="grid-2">
          {["iguales", "momentum"].map((b) => (
            <div className="panel" key={b}>
              <div className="panel-head">
                <div className="panel-title">Control · {BOOK_LABEL[b]}</div>
                <div className="mono" style={{ fontSize: 13, color: signColor(calc.books[b].ret) }}>{fmtPct(calc.books[b].ret, 2)}</div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>ETF</th><th style={th}>Peso</th><th style={th}>Rent.</th><th style={th}>Entrada</th></tr></thead>
                  <tbody>
                    {calc.books[b].open.map((r) => (
                      <tr key={r.id}>
                        <td><span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{r.name}</span></td>
                        <td style={td}>{fmtWeight(r.weightNow)}</td>
                        <td style={{ ...td, color: signColor(r.ret) }}>{fmtPct(r.ret)}</td>
                        <td style={td}>{fmtDate(r.entry_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-sub" style={{ marginTop: 10 }}>
                {b === "iguales"
                  ? "Los 11 sectores al 9,09%, reequilibrados en cada revisión. Dice si elegir sectores aporta algo frente a tenerlos todos."
                  : "Los 3 sectores que más han subido en 126 sesiones, renovados en cada revisión. Si gana a la cartera, la lectura del ciclo no aportaba nada."}
              </div>
            </div>
          ))}
        </div>
      )}

      {watchRows.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Descartes a vigilar (sin dinero dentro)</div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>ETF</th><th style={th}>Desde</th><th style={th}>Rent.</th><th style={th}>Frente a</th><th style={th}>Rent.</th><th style={th}>Diferencia</th></tr></thead>
              <tbody>
                {watchRows.map((w) => (
                  <Fragment key={w.id}>
                    <tr>
                      <td><span className="mono" style={{ fontWeight: 600 }}>{w.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{w.name}</span></td>
                      <td style={td}>{w.start_date ? `${fmtDate(w.start_date)} · ${fmtMoney(num(w.start_price))}` : "pendiente"}</td>
                      <td style={{ ...td, color: signColor(w.ret) }}>{fmtPct(w.ret)}</td>
                      <td style={td}>{w.versus}</td>
                      <td style={{ ...td, color: signColor(w.vsRet) }}>{fmtPct(w.vsRet)}</td>
                      <td style={{ ...td, color: signColor(w.diff) }}>{fmtPts(w.diff)}</td>
                    </tr>
                    {w.note && (
                      <tr><td colSpan={6} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13 }}><div style={noteBox}>{w.note}</div></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Diario de decisiones</div></div>
        {log.length === 0 ? <div className="empty">Sin anotaciones todavía</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {log.map((e) => (
              <div key={e.id} style={{ borderLeft: "2px solid var(--border)", paddingLeft: 12 }}>
                <div className="mono" style={{ fontSize: 12, color: "var(--gold)" }}>
                  {fmtDate(e.date)} · {String(e.kind).toUpperCase()}{e.ticker ? ` · ${e.ticker}` : ""}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.5, marginTop: 2 }}>{e.note}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
