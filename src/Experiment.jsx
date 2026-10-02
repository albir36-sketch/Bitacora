import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "./supabaseClient";

// Experimento "¿podemos batir a los índices?": una cartera TEÓRICA (no son operaciones reales)
// que se compara, acción por acción y en conjunto, contra el S&P 500 (SPY) y el Nasdaq-100 (QQQ).
// Las altas y bajas se registran en la base de datos en cada revisión mensual; esta vista solo
// lee, actualiza precios y guarda una foto diaria para el gráfico.

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_API_KEY;
const BENCHMARKS = ["SPY", "QQQ"];
const COLORS = { cartera: "#E8A33D", spy: "#60A5FA", qqq: "#C084FC" };

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
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const fmtWeight = (n) => (n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const pct = (now, base) => (now == null || !base ? null : (now / base - 1) * 100);

export default function Experiment({ session }) {
  const userId = session.user.id;
  const [config, setConfig] = useState(null);
  const [positions, setPositions] = useState([]);
  const [prices, setPrices] = useState({}); // { ticker: { price, updated_at } }
  const [snapshots, setSnapshots] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState("");
  const [sortBy, setSortBy] = useState("peso");
  const [expanded, setExpanded] = useState({});

  async function loadAll() {
    setLoading(true);
    setError("");
    const [c, p, pr, s, l] = await Promise.all([
      supabase.from("experiment_config").select("*").maybeSingle(),
      supabase.from("experiment_positions").select("*").order("weight_pct", { ascending: false }),
      supabase.from("experiment_prices").select("*"),
      supabase.from("experiment_snapshots").select("*").order("date", { ascending: true }),
      supabase.from("experiment_log").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    ]);
    const firstErr = [c, p, pr, s, l].find((r) => r.error);
    if (firstErr) setError(firstErr.error.message);
    setConfig(c.data || null);
    setPositions(p.data || []);
    const map = {};
    (pr.data || []).forEach((r) => { map[r.ticker] = { price: num(r.price), updated_at: r.updated_at }; });
    setPrices(map);
    setSnapshots(s.data || []);
    setLog(l.data || []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  // ---------- cálculos ----------
  const calc = useMemo(() => {
    if (!config) return null;
    const startCapital = num(config.start_capital);
    const spyNow = prices.SPY?.price ?? null;
    const qqqNow = prices.QQQ?.price ?? null;

    const rows = positions.map((p) => {
      const qty = num(p.qty);
      const entry = num(p.entry_price);
      const closed = p.exit_date != null;
      const last = prices[p.ticker]?.price ?? null;
      // Precio con el que se mide la posición: el de salida si ya se vendió, el actual si sigue abierta.
      const ref = closed ? num(p.exit_price) : (last ?? entry);
      const ret = pct(ref, entry);
      const spyRef = closed ? num(p.spy_exit) : spyNow;
      const qqqRef = closed ? num(p.qqq_exit) : qqqNow;
      const spyRet = pct(spyRef, num(p.spy_entry));
      const qqqRet = pct(qqqRef, num(p.qqq_entry));
      return {
        ...p, qty, entry, closed, last, ref, ret, spyRet, qqqRet,
        vsSpy: ret != null && spyRet != null ? ret - spyRet : null,
        vsQqq: ret != null && qqqRet != null ? ret - qqqRet : null,
        cost: qty * entry,
        value: qty * ref,
        pnl: qty * (ref - entry),
        // Qué ha hecho la acción DESPUÉS de sacarla (para aprender si acertamos al vender).
        afterExit: closed ? pct(last, num(p.exit_price)) : null,
      };
    });

    const open = rows.filter((r) => !r.closed);
    const closedRows = rows.filter((r) => r.closed);
    const cash = startCapital - rows.reduce((s, r) => s + r.cost, 0) + closedRows.reduce((s, r) => s + r.value, 0);
    const invested = open.reduce((s, r) => s + r.value, 0);
    const total = cash + invested;
    open.forEach((r) => { r.weightNow = total ? (r.value / total) * 100 : null; });
    rows.forEach((r) => { r.contrib = startCapital ? (r.pnl / startCapital) * 100 : null; });

    const portRet = pct(total, startCapital);
    const spyRet = pct(spyNow, num(config.spy_start));
    const qqqRet = pct(qqqNow, num(config.qqq_start));
    const comparable = open.filter((r) => r.vsSpy != null);

    const stamps = Object.values(prices).map((x) => x.updated_at).filter(Boolean).sort();
    return {
      startCapital, cash, invested, total, portRet, spyRet, qqqRet, open, closedRows,
      cashWeight: total ? (cash / total) * 100 : null,
      beatSpy: comparable.filter((r) => r.vsSpy > 0).length,
      beatQqq: comparable.filter((r) => r.vsQqq > 0).length,
      nComparable: comparable.length,
      lastUpdate: stamps.length ? stamps[stamps.length - 1] : null,
    };
  }, [config, positions, prices]);

  const chartData = useMemo(() => {
    if (!config || snapshots.length === 0) return [];
    const cap = num(config.start_capital), spy0 = num(config.spy_start), qqq0 = num(config.qqq_start);
    return snapshots.map((s) => ({
      date: fmtDate(s.date),
      cartera: (num(s.portfolio_value) / cap) * 100,
      spy: (num(s.spy_price) / spy0) * 100,
      qqq: (num(s.qqq_price) / qqq0) * 100,
    }));
  }, [config, snapshots]);

  const sortedOpen = useMemo(() => {
    if (!calc) return [];
    const arr = [...calc.open];
    if (sortBy === "rent") arr.sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9));
    else if (sortBy === "vs") arr.sort((a, b) => (b.vsSpy ?? -1e9) - (a.vsSpy ?? -1e9));
    else arr.sort((a, b) => (b.weightNow ?? 0) - (a.weightNow ?? 0));
    return arr;
  }, [calc, sortBy]);

  // ---------- actualizar precios + guardar la foto del día ----------
  async function refresh() {
    if (!FINNHUB_KEY) { setError("Para actualizar precios falta configurar VITE_FINNHUB_API_KEY en Vercel."); return; }
    if (!config) return;
    setRefreshing(true);
    setError("");
    const tickers = [...new Set([...positions.map((p) => p.ticker), ...BENCHMARKS])];
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
      const { error: err } = await supabase.from("experiment_prices").upsert(upserts, { onConflict: "user_id,ticker" });
      if (err) setError(err.message);
    }
    setPrices(next);

    // Foto del día (una por fecha de mercado) para el gráfico de evolución. Solo si tenemos los dos
    // índices y TODAS las posiciones abiertas con precio fresco, para no guardar un valor a medias.
    const openTickers = positions.filter((p) => p.exit_date == null).map((p) => p.ticker);
    const complete = !failed.includes("SPY") && !failed.includes("QQQ") && openTickers.every((tk) => !failed.includes(tk));
    if (complete && marketDate) {
      const cap = num(config.start_capital);
      let cash = cap, invested = 0;
      positions.forEach((p) => {
        const qty = num(p.qty);
        cash -= qty * num(p.entry_price);
        if (p.exit_date != null) cash += qty * num(p.exit_price);
        else invested += qty * next[p.ticker].price;
      });
      const row = { user_id: userId, date: marketDate, portfolio_value: cash + invested, spy_price: next.SPY.price, qqq_price: next.QQQ.price };
      const { data: saved, error: err } = await supabase.from("experiment_snapshots").upsert(row, { onConflict: "user_id,date" }).select().single();
      if (err) setError(err.message);
      else setSnapshots((prev) => [...prev.filter((s) => s.date !== saved.date), saved].sort((a, b) => (a.date < b.date ? -1 : 1)));
    }
    if (failed.length) setError(`No se pudo actualizar: ${failed.join(", ")}. El resto sí; la foto del día no se guarda hasta que estén todos.`);
    setProgress("");
    setRefreshing(false);
  }

  if (loading) return <div className="panel"><div className="empty">Cargando experimento…</div></div>;
  if (!config || !calc) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento configurado.</div>
      </div>
    );
  }

  const advSpy = calc.portRet != null && calc.spyRet != null ? calc.portRet - calc.spyRet : null;
  const advQqq = calc.portRet != null && calc.qqqRet != null ? calc.portRet - calc.qqqRet : null;
  const th = { textAlign: "right" };
  const td = { textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" };
  // Los textos largos dentro de la tabla se quedan pegados a la izquierda y se ajustan al ancho de
  // la pantalla, aunque la tabla sea más ancha y tenga desplazamiento horizontal (móvil).
  const noteBox = { position: "sticky", left: 0, maxWidth: "min(760px, calc(100vw - 80px))", whiteSpace: "normal" };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div className="eyebrow">EXPERIMENTO · CARTERA TEÓRICA</div>
          <div className="h1">¿Podemos batir a los índices?</div>
          <div className="card-sub" style={{ marginTop: 4 }}>
            Desde el {fmtDate(config.start_date)} con {fmtMoney(calc.startCapital, 0)} teóricos · sin dividendos ni comisiones, igual que los índices
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <button className="btn btn-gold" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={15} /> {refreshing ? `Actualizando ${progress}` : "Actualizar precios"}
          </button>
          <div className="card-sub" style={{ marginTop: 6 }}>
            {calc.lastUpdate ? `Precios del ${new Date(calc.lastUpdate).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}` : "Sin precios todavía"}
          </div>
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="card-label">Cartera</div>
          <div className="card-value big" style={{ color: signColor(calc.portRet) }}>{fmtPct(calc.portRet, 2)}</div>
          <div className="card-sub">{fmtMoney(calc.total)} · liquidez {fmtWeight(calc.cashWeight)}</div>
        </div>
        <div className="card">
          <div className="card-label">S&P 500 (SPY)</div>
          <div className="card-value big" style={{ color: signColor(calc.spyRet) }}>{fmtPct(calc.spyRet, 2)}</div>
          <div className="card-sub">ventaja de la cartera: <span style={{ color: signColor(advSpy) }}>{fmtPts(advSpy, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">Nasdaq-100 (QQQ)</div>
          <div className="card-value big" style={{ color: signColor(calc.qqqRet) }}>{fmtPct(calc.qqqRet, 2)}</div>
          <div className="card-sub">ventaja de la cartera: <span style={{ color: signColor(advQqq) }}>{fmtPts(advQqq, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">Aciertos</div>
          <div className="card-value big">{calc.beatSpy}/{calc.nComparable}</div>
          <div className="card-sub">baten al S&P 500 · {calc.beatQqq}/{calc.nComparable} al QQQ</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Evolución (base 100 el día de inicio)</div>
        </div>
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
              <Line type="linear" name="Cartera" dataKey="cartera" stroke={COLORS.cartera} strokeWidth={2.5} dot={chartData.length < 15} activeDot={{ r: 5 }} isAnimationActive={false} />
              <Line type="linear" name="S&P 500" dataKey="spy" stroke={COLORS.spy} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
              <Line type="linear" name="QQQ" dataKey="qqq" stroke={COLORS.qqq} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="panel">
        <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="panel-title">Posiciones abiertas ({calc.open.length})</div>
          <div className="tabs">
            {[["peso", "Peso"], ["rent", "Rentabilidad"], ["vs", "Vs S&P 500"]].map(([k, label]) => (
              <button key={k} className={`tab ${sortBy === k ? "active" : ""}`} onClick={() => setSortBy(k)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th style={th}>Peso</th>
                <th style={th}>Rent.</th>
                <th style={th}>Vs S&P 500</th>
                <th style={th}>Vs QQQ</th>
                <th style={th}>Entrada</th>
                <th style={th}>Actual</th>
                <th style={th}>Aporta</th>
              </tr>
            </thead>
            <tbody>
              {sortedOpen.map((r) => (
                <Fragment key={r.id}>
                  <tr onClick={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))} style={{ cursor: "pointer" }}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {expanded[r.id] ? <ChevronDown size={14} color="var(--muted)" /> : <ChevronRight size={14} color="var(--muted)" />}
                        <span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span>
                        <span style={{ color: "var(--muted)", fontSize: 13 }}>{r.name}</span>
                      </span>
                    </td>
                    <td style={td}>{fmtWeight(r.weightNow)}</td>
                    <td style={{ ...td, color: signColor(r.ret) }}>{fmtPct(r.ret)}</td>
                    <td style={{ ...td, color: signColor(r.vsSpy) }}>{fmtPts(r.vsSpy)}</td>
                    <td style={{ ...td, color: signColor(r.vsQqq) }}>{fmtPts(r.vsQqq)}</td>
                    <td style={td}>{fmtMoney(r.entry)}</td>
                    <td style={td}>{fmtMoney(r.last)}</td>
                    <td style={{ ...td, color: signColor(r.contrib) }}>{fmtPts(r.contrib, 2)}</td>
                  </tr>
                  {expanded[r.id] && (
                    <tr>
                      <td colSpan={8} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
                        <div style={{ ...noteBox, padding: "4px 0 6px 20px" }}>
                          <div style={{ color: "var(--text)" }}>{r.thesis}</div>
                          <div style={{ marginTop: 4 }}>
                            Entró el {fmtDate(r.entry_date)} con un {num(r.weight_pct)}% · {r.grupo}
                            {r.motor_bucket ? ` · Motor Aprende a Invertir: ${r.motor_bucket}` : ""}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr>
                <td style={{ color: "var(--muted)", paddingLeft: 20 }}>Liquidez · <span className="mono">{fmtMoney(calc.cash)}</span></td>
                <td style={td}>{fmtWeight(calc.cashWeight)}</td>
                <td colSpan={6} />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card-sub" style={{ marginTop: 10 }}>
          «Vs S&P 500» y «Vs QQQ» comparan cada acción con el índice desde su propia fecha de entrada, en puntos porcentuales (pp). «Aporta» es lo que esa posición suma o resta a la rentabilidad de la cartera. Pulsa una fila para ver por qué se eligió.
        </div>
      </div>

      {calc.closedRows.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Posiciones cerradas ({calc.closedRows.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th style={th}>Entrada</th>
                  <th style={th}>Salida</th>
                  <th style={th}>Rent.</th>
                  <th style={th}>Vs S&P 500</th>
                  <th style={th}>Vs QQQ</th>
                  <th style={th}>Desde que salió</th>
                </tr>
              </thead>
              <tbody>
                {calc.closedRows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td><span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{r.name}</span></td>
                      <td style={td}>{fmtDate(r.entry_date)} · {fmtMoney(r.entry)}</td>
                      <td style={td}>{fmtDate(r.exit_date)} · {fmtMoney(r.ref)}</td>
                      <td style={{ ...td, color: signColor(r.ret) }}>{fmtPct(r.ret)}</td>
                      <td style={{ ...td, color: signColor(r.vsSpy) }}>{fmtPts(r.vsSpy)}</td>
                      <td style={{ ...td, color: signColor(r.vsQqq) }}>{fmtPts(r.vsQqq)}</td>
                      <td style={{ ...td, color: signColor(r.afterExit) }}>{fmtPct(r.afterExit)}</td>
                    </tr>
                    {r.exit_reason && (
                      <tr><td colSpan={7} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13 }}><div style={noteBox}>Motivo de salida: {r.exit_reason}</div></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>«Desde que salió» muestra lo que ha hecho la acción después de quitarla: si sube mucho, nos equivocamos al vender.</div>
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
