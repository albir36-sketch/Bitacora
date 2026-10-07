import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "./supabaseClient";

// Experimento de covered calls: cartera TEÓRICA de 100.000 $ en acciones compradas en paquetes de 100,
// sobre las que se venden calls. Tres libros con las mismas acciones (solo acciones, call a delta fija
// 0,30 y call según reglas) y un cuarto libro con los lotes reales de Interactive Brokers.
// Las operaciones se registran en la base de datos; esta vista solo lee y calcula.
//
// Convenciones de las tablas ccexp_*:
//   premium, exit_debit y mark son precios POR ACCIÓN de la call (×100 por contrato).
//   mark = último precio medio conocido de una call abierta (si falta, se usa la prima).
//   ccexp_snapshots guarda una fila por fecha y libro (acciones, fija, reglas).

const COLORS = { acciones: "#E8A33D", fija: "#F472B6", reglas: "#34D399", spy: "#60A5FA", qqq: "#C084FC" };
const BOOKS = [["fija", "Delta fija 0,30"], ["reglas", "Reglas"], ["real", "Lotes reales"]];
const BOOK_LABEL = Object.fromEntries(BOOKS);
const TRIGGER_LABEL = { mensual: "Revisión mensual", rsi_diario: "RSI diario" };
const TECH_LABEL = { alcista: "Alcista", lateral: "Lateral", bajista: "Bajista" };
const DECISION_LABEL = {
  call_vendida: "Call vendida", sin_call_tabla: "Sin call: la tabla no vende", sin_call_rsi: "Sin call: RSI en 30 o menos",
  sin_call_resultados: "Sin call: resultados cerca", sin_call_liquidez: "Sin call: liquidez",
  sin_call_strikes: "Sin call: ningún strike en la banda", sin_call_prima: "Sin call: prima mínima",
};

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtSigned = (n, digits = 2) => (n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n, digits)}`);
const fmtPct = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const fmtPts = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })} pp`;
const fmtPlain = (n, digits = 0) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const fmtNum = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtStrike = (n) => Number(n).toLocaleString("es-ES", { maximumFractionDigits: 2 });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const pct = (now, base) => (now == null || !base ? null : (now / base - 1) * 100);
const daysTo = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);

// Dividendos por acción con fecha ex-dividendo posterior a `from` y hasta `to` incluido (nulo = hoy).
function divsBetween(dividends, ticker, from, to) {
  return dividends.reduce(
    (sum, d) => (d.ticker === ticker && d.ex_date > from && (to == null || d.ex_date <= to) ? sum + Number(d.amount) : sum),
    0
  );
}

export default function CoveredCallExperiment({ session }) {
  const userId = session.user.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      const res = await Promise.all([
        supabase.from("ccexp_config").select("*").maybeSingle(),
        supabase.from("ccexp_positions").select("*").order("entry_date", { ascending: true }),
        supabase.from("ccexp_calls").select("*").order("entry_date", { ascending: true }),
        supabase.from("ccexp_signals").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
        supabase.from("ccexp_prices").select("*"),
        supabase.from("ccexp_dividends").select("*"),
        supabase.from("ccexp_snapshots").select("*").order("date", { ascending: true }),
        supabase.from("ccexp_log").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const firstErr = res.find((r) => r.error);
      if (firstErr) setError(firstErr.error.message);
      const [config, positions, calls, signals, priceRows, dividends, snapshots, log] = res.map((r) => r.data);
      const prices = {};
      let pricesDate = null;
      (priceRows || []).forEach((r) => {
        prices[r.ticker] = num(r.price);
        if (!pricesDate || r.updated_at > pricesDate) pricesDate = r.updated_at;
      });
      setData({
        config: config || null, positions: positions || [], calls: calls || [], signals: signals || [],
        prices, pricesDate, dividends: dividends || [], snapshots: snapshots || [], log: log || [],
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const calc = useMemo(() => {
    if (!data?.config) return null;
    const { config, positions, calls, prices, dividends } = data;
    const startCapital = num(config.start_capital);

    const stockRow = (p) => {
      const qty = num(p.qty);
      const entry = num(p.entry_price);
      const closed = p.exit_date != null;
      const now = closed ? num(p.exit_price) : (prices[p.ticker] ?? entry);
      const divs = qty * divsBetween(dividends, p.ticker, p.entry_date, p.exit_date);
      return {
        ...p, qty, entry, closed, now, divs,
        cost: qty * entry,
        value: qty * now,
        pnl: qty * (now - entry) + divs,
        ret: pct(now + divs / qty, entry),
      };
    };
    const stocks = positions.filter((p) => p.kind === "teorica").map(stockRow);
    const lots = positions.filter((p) => p.kind === "real").map(stockRow);
    const priceOf = {};
    [...stocks, ...lots].forEach((p) => { priceOf[p.ticker] = p.now; });

    const callRows = calls.map((c) => {
      const contracts = num(c.contracts);
      const premium = num(c.premium);
      const closed = c.exit_date != null;
      const feesIn = num(c.commissions_entry) || 0;
      const feesOut = num(c.commissions_exit) || 0;
      const mark = num(c.mark) ?? premium;
      const exitDebit = num(c.exit_debit);
      const strike = num(c.strike);
      const under = closed ? num(c.underlying_exit) : (priceOf[c.ticker] ?? num(c.underlying_entry));
      // En el libro real solo cuenta el resultado de las calls que Rafa operó de verdad.
      const counts = c.book !== "real" || c.operated === true;
      const pnl = closed
        ? (premium - exitDebit) * 100 * contracts - feesIn - feesOut
        : (premium - mark) * 100 * contracts - feesIn;
      return {
        ...c, contracts, premium, closed, mark, exitDebit, strike, under, counts, pnl,
        fees: feesIn + feesOut,
        collected: premium * 100 * contracts,
        premiumPct: num(c.underlying_entry) ? (premium / num(c.underlying_entry)) * 100 : null,
        distance: under ? (strike / under - 1) * 100 : null,
        dte: closed ? null : daysTo(c.expiry),
      };
    });
    const open = callRows.filter((r) => !r.closed);
    const closedRows = callRows.filter((r) => r.closed).sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1));

    // Los tres libros teóricos comparten acciones: la diferencia entre ellos es el resultado de las calls.
    const stockPnl = stocks.reduce((s, p) => s + p.pnl, 0);
    const invested = stocks.filter((p) => !p.closed).reduce((s, p) => s + p.value, 0);
    const callsPnl = (book) => callRows.filter((r) => r.book === book && r.counts).reduce((s, r) => s + r.pnl, 0);
    const valueAcciones = startCapital + stockPnl;
    const valueFija = valueAcciones + callsPnl("fija");
    const valueReglas = valueAcciones + callsPnl("reglas");
    const cash = valueAcciones - invested;

    const bookStats = BOOKS.map(([key, label]) => {
      const list = callRows.filter((r) => r.book === key && r.counts);
      const closedList = list.filter((r) => r.closed);
      const wins = closedList.filter((r) => r.pnl > 0);
      return {
        key, label,
        sold: list.length,
        openCount: list.filter((r) => !r.closed).length,
        closedCount: closedList.length,
        collected: list.reduce((s, r) => s + r.collected, 0),
        winRate: closedList.length ? (wins.length / closedList.length) * 100 : null,
        itm: closedList.filter((r) => r.under != null && r.under > r.strike).length,
        net: closedList.reduce((s, r) => s + r.pnl, 0),
        openPnl: list.filter((r) => !r.closed).reduce((s, r) => s + r.pnl, 0),
        fees: list.reduce((s, r) => s + r.fees, 0),
      };
    });

    const spyRet = pct(prices.SPY == null ? null : prices.SPY + divsBetween(dividends, "SPY", config.start_date, null), num(config.spy_start));
    const qqqRet = pct(prices.QQQ == null ? null : prices.QQQ + divsBetween(dividends, "QQQ", config.start_date, null), num(config.qqq_start));

    return {
      startCapital, stocks, lots, open, closedRows, bookStats, cash, invested,
      valueAcciones, valueFija, valueReglas,
      retAcciones: pct(valueAcciones, startCapital),
      retFija: pct(valueFija, startCapital),
      retReglas: pct(valueReglas, startCapital),
      callsFija: callsPnl("fija"), callsReglas: callsPnl("reglas"),
      spyRet, qqqRet,
    };
  }, [data]);

  // Gráfico: un punto por fecha con foto guardada. Cada foto trae el valor de un libro.
  const chartData = useMemo(() => {
    if (!data?.config || data.snapshots.length === 0) return [];
    const { config, snapshots, dividends } = data;
    const cap = num(config.start_capital), spy0 = num(config.spy_start), qqq0 = num(config.qqq_start);
    const byDate = {};
    snapshots.forEach((s) => {
      const row = byDate[s.date] || (byDate[s.date] = { iso: s.date, date: fmtDate(s.date) });
      if (s.value != null) row[s.book] = (num(s.value) / cap) * 100;
      if (s.spy_price != null) row.spy = ((num(s.spy_price) + divsBetween(dividends, "SPY", config.start_date, s.date)) / spy0) * 100;
      if (s.qqq_price != null) row.qqq = ((num(s.qqq_price) + divsBetween(dividends, "QQQ", config.start_date, s.date)) / qqq0) * 100;
    });
    return Object.values(byDate).sort((a, b) => (a.iso < b.iso ? -1 : 1));
  }, [data]);

  // Última lectura de cada empresa.
  const signals = useMemo(() => {
    if (!data?.signals.length) return null;
    const seen = new Set();
    const items = data.signals.filter((s) => (seen.has(s.ticker) ? false : seen.add(s.ticker)));
    const order = (data.positions || []).map((p) => p.ticker);
    items.sort((a, b) => order.indexOf(a.ticker) - order.indexOf(b.ticker));
    return items;
  }, [data]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento de covered calls…</div></div>;
  if (!data?.config || !calc) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de covered calls configurado.</div>
      </div>
    );
  }

  const { config, log } = data;
  const advFija = calc.retFija != null && calc.retAcciones != null ? calc.retFija - calc.retAcciones : null;
  const advReglas = calc.retReglas != null && calc.retAcciones != null ? calc.retReglas - calc.retAcciones : null;
  const advReglasFija = calc.retReglas != null && calc.retFija != null ? calc.retReglas - calc.retFija : null;
  const th = { textAlign: "right" };
  const td = { textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" };
  const noteBox = { position: "sticky", left: 0, maxWidth: "min(760px, calc(100vw - 80px))", whiteSpace: "normal" };
  const toggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const callName = (r) => `${r.ticker} ${fmtStrike(r.strike)}`;
  const openCall = (book, ticker) => calc.open.find((r) => r.book === book && r.ticker === ticker);
  const callCell = (r) => (r ? `${fmtStrike(r.strike)} · ${fmtMoney(r.premium)}` : "—");

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO · CARTERA TEÓRICA DE COVERED CALLS</div>
        <div className="h1">¿Suman las primas a tener solo las acciones?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Desde el {fmtDate(config.start_date)} con {fmtMoney(calc.startCapital, 0)} teóricos · acciones en paquetes de 100 · tres libros con las mismas acciones · comisión de {fmtMoney(num(config.commission_per_contract))} por contrato
          {data.pricesDate ? ` · precios del ${fmtDate(data.pricesDate)}` : " · precios: los de entrada, hasta la primera actualización"}
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="card-label">Solo acciones</div>
          <div className="card-value big" style={{ color: signColor(calc.retAcciones) }}>{fmtPct(calc.retAcciones, 2)}</div>
          <div className="card-sub">{fmtMoney(calc.valueAcciones)} · invertido {fmtMoney(calc.invested, 0)} · liquidez {fmtMoney(calc.cash, 0)}</div>
        </div>
        <div className="card">
          <div className="card-label">Con call a delta fija 0,30</div>
          <div className="card-value big" style={{ color: signColor(calc.retFija) }}>{fmtPct(calc.retFija, 2)}</div>
          <div className="card-sub">calls {fmtSigned(calc.callsFija)} · frente a solo acciones: <span style={{ color: signColor(advFija) }}>{fmtPts(advFija, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">Con call según reglas</div>
          <div className="card-value big" style={{ color: signColor(calc.retReglas) }}>{fmtPct(calc.retReglas, 2)}</div>
          <div className="card-sub">calls {fmtSigned(calc.callsReglas)} · frente a solo acciones: <span style={{ color: signColor(advReglas) }}>{fmtPts(advReglas, 2)}</span> · frente a delta fija: <span style={{ color: signColor(advReglasFija) }}>{fmtPts(advReglasFija, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">S&P 500 · QQQ</div>
          <div className="card-value big" style={{ color: signColor(calc.spyRet) }}>{fmtPct(calc.spyRet, 2)}</div>
          <div className="card-sub">QQQ {fmtPct(calc.qqqRet, 2)}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Evolución (base 100 el día de inicio)</div></div>
        {chartData.length < 2 ? (
          <div className="empty">El gráfico aparecerá cuando haya al menos dos revisiones guardadas.</div>
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
              <Line type="linear" name="Reglas" dataKey="reglas" stroke={COLORS.reglas} strokeWidth={2.5} dot={chartData.length < 15} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
              <Line type="linear" name="Delta fija" dataKey="fija" stroke={COLORS.fija} strokeWidth={2} dot={chartData.length < 15} connectNulls isAnimationActive={false} />
              <Line type="linear" name="Solo acciones" dataKey="acciones" stroke={COLORS.acciones} strokeWidth={2} dot={chartData.length < 15} connectNulls isAnimationActive={false} />
              <Line type="linear" name="S&P 500" dataKey="spy" stroke={COLORS.spy} strokeWidth={2} dot={chartData.length < 15} connectNulls isAnimationActive={false} />
              <Line type="linear" name="QQQ" dataKey="qqq" stroke={COLORS.qqq} strokeWidth={2} dot={chartData.length < 15} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Acciones ({calc.stocks.filter((p) => !p.closed).length})</div></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th style={th}>Acciones</th>
                <th style={th}>Entrada</th>
                <th style={th}>Ahora</th>
                <th style={th}>Resultado</th>
                <th style={th}>%</th>
                <th style={th}>Call delta fija</th>
                <th style={th}>Call reglas</th>
              </tr>
            </thead>
            <tbody>
              {calc.stocks.map((p) => (
                <tr key={p.id} style={p.closed ? { opacity: 0.6 } : undefined}>
                  <td><span className="mono" style={{ fontWeight: 600 }}>{p.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{p.name}{p.closed ? ` · salió el ${fmtDate(p.exit_date)}` : ""}</span></td>
                  <td style={td}>{fmtNum(p.qty, 0)}</td>
                  <td style={td}>{fmtMoney(p.entry)}</td>
                  <td style={td}>{fmtMoney(p.now)}</td>
                  <td style={{ ...td, color: signColor(p.pnl) }}>{fmtSigned(p.pnl, 0)}</td>
                  <td style={{ ...td, color: signColor(p.ret) }}>{fmtPct(p.ret)}</td>
                  <td style={td}>{callCell(openCall("fija", p.ticker))}</td>
                  <td style={td}>{callCell(openCall("reglas", p.ticker))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-sub" style={{ marginTop: 10 }}>
          Las acciones son las mismas en los tres libros. Las dos últimas columnas muestran el strike y la prima por acción de la call abierta en cada libro; «—» significa que ese libro no tiene call sobre la empresa ahora.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Calls abiertas, por libro</div></div>
        {calc.open.length === 0 ? (
          <div className="empty">No hay calls abiertas. Las ventas se anotan con la cadena real del día de la revisión.</div>
        ) : BOOKS.filter(([book]) => calc.open.some((r) => r.book === book)).map(([book, label]) => (
          <div key={book} style={{ marginBottom: 18 }}>
            <div className="card-label" style={{ marginBottom: 6 }}>
              {book === "real" ? "Lotes reales" : `Libro «${label}»`} · {calc.open.filter((r) => r.book === book).reduce((n, r) => n + r.contracts, 0)} contratos
            </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Estado</th>
                  <th style={th}>Vence</th>
                  <th style={th}>Prima</th>
                  <th style={th}>Ahora</th>
                  <th style={th}>Resultado</th>
                  <th style={th}>Delta</th>
                  <th style={th}>Prima / precio</th>
                  <th style={th}>Hasta el strike</th>
                </tr>
              </thead>
              <tbody>
                {calc.open.filter((r) => r.book === book).map((r) => (
                  <Fragment key={r.id}>
                    <tr onClick={() => toggle(r.id)} style={{ cursor: "pointer" }}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {expanded[r.id] ? <ChevronDown size={14} color="var(--muted)" /> : <ChevronRight size={14} color="var(--muted)" />}
                          <span className="mono" style={{ fontWeight: 600 }}>{callName(r)}</span>
                          {r.contracts > 1 ? <span style={{ color: "var(--muted)", fontSize: 13 }}>×{r.contracts}</span> : null}
                        </span>
                      </td>
                      <td>{r.book === "real" ? (r.operated === true ? "Operada" : r.operated === false ? "No operada" : "Pendiente") : "Teórica"}</td>
                      <td style={td}>{fmtDate(r.expiry)} · {r.dte} d</td>
                      <td style={td}>{fmtMoney(r.premium)}</td>
                      <td style={td}>{fmtMoney(r.mark)}</td>
                      <td style={{ ...td, color: signColor(r.pnl) }}>{fmtSigned(r.pnl)}</td>
                      <td style={td}>{fmtNum(num(r.delta))}</td>
                      <td style={td}>{fmtPlain(r.premiumPct, 1)}</td>
                      <td style={{ ...td, color: r.distance != null && r.distance < 0 ? "var(--loss)" : undefined }}>{fmtPct(r.distance)}</td>
                    </tr>
                    {expanded[r.id] && (
                      <tr>
                        <td colSpan={9} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
                          <div style={{ ...noteBox, padding: "4px 0 6px 20px" }}>
                            <div>
                              Vendida el {fmtDate(r.entry_date)} con {r.ticker} a {fmtMoney(num(r.underlying_entry))}
                              {` · ${TRIGGER_LABEL[r.trigger] || r.trigger || "—"}`}
                              {r.tech_state ? ` · ${TECH_LABEL[r.tech_state] || r.tech_state}` : ""}
                              {r.rsi != null ? ` · RSI ${fmtNum(num(r.rsi), 0)}` : ""}
                              {r.margin_pct != null ? ` · margen ${fmtPlain(num(r.margin_pct), 0)}` : ""}
                              {r.iv_entry != null ? ` · volatilidad implícita ${fmtPlain(num(r.iv_entry) * 100, 0)}` : ""}
                              {r.iv_percentile != null ? ` (percentil ${fmtPlain(num(r.iv_percentile) * 100, 0)})` : ""}
                              {r.spread_pct != null ? ` · horquilla ${fmtPlain(num(r.spread_pct), 0)}` : ""}
                              {` · cobrado ${fmtMoney(r.collected, 0)}`}
                              {r.mark_date ? ` · precio actual del ${fmtDate(r.mark_date)}` : ""}
                            </div>
                            {r.note && <div style={{ marginTop: 4, color: "var(--text)" }}>{r.note}</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        ))}
        <div className="card-sub" style={{ marginTop: 10 }}>
          Cada libro es una copia independiente de la misma cartera: las calls de un libro no se suman a las del otro, y dentro de cada uno hay como mucho un contrato por cada 100 acciones. «Prima» y «Ahora» son precios de la call por acción (×100 por contrato). «Resultado» ya descuenta la comisión de entrada. «Hasta el strike» es lo que puede subir la acción antes de que la call limite la ganancia; en rojo, si ya lo ha superado. Toda call se recompra en la primera revisión mensual en la que le queden 21 días o menos.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Resultado de las calls por libro</div></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Libro</th>
                <th style={th}>Vendidas</th>
                <th style={th}>Abiertas</th>
                <th style={th}>Primas cobradas</th>
                <th style={th}>Cerradas</th>
                <th style={th}>Acierto</th>
                <th style={th}>Acabaron dentro de dinero</th>
                <th style={th}>Neto cerradas</th>
                <th style={th}>Abiertas ahora</th>
              </tr>
            </thead>
            <tbody>
              {calc.bookStats.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td style={td}>{s.sold}</td>
                  <td style={td}>{s.openCount}</td>
                  <td style={td}>{fmtMoney(s.collected, 0)}</td>
                  <td style={td}>{s.closedCount}</td>
                  <td style={td}>{fmtPlain(s.winRate, 0)}</td>
                  <td style={td}>{s.closedCount ? s.itm : "—"}</td>
                  <td style={{ ...td, color: signColor(s.closedCount ? s.net : null) }}>{s.closedCount ? fmtSigned(s.net) : "—"}</td>
                  <td style={{ ...td, color: signColor(s.openCount ? s.openPnl : null) }}>{s.openCount ? fmtSigned(s.openPnl) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-sub" style={{ marginTop: 10 }}>
          Netos de comisiones. En «Lotes reales» solo cuentan las calls que se operaron de verdad en la cuenta. «Acabaron dentro de dinero» son las calls recompradas con la acción por encima del strike: ahí es donde se deja de ganar subida.
        </div>
      </div>

      {calc.closedRows.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Calls cerradas ({calc.closedRows.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Libro</th>
                  <th style={th}>Venta</th>
                  <th style={th}>Recompra</th>
                  <th style={th}>Acción al cerrar</th>
                  <th style={th}>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {calc.closedRows.map((r) => (
                  <tr key={r.id}>
                    <td><span className="mono" style={{ fontWeight: 600 }}>{callName(r)}</span>{r.contracts > 1 ? <span style={{ color: "var(--muted)", fontSize: 13 }}> ×{r.contracts}</span> : null}</td>
                    <td>{BOOK_LABEL[r.book]}{r.book === "real" && r.operated !== true ? " · no operada" : ""}</td>
                    <td style={td}>{fmtDate(r.entry_date)} · {fmtMoney(r.premium)}</td>
                    <td style={td}>{fmtDate(r.exit_date)} · {fmtMoney(r.exitDebit)}</td>
                    <td style={{ ...td, color: r.under != null && r.under > r.strike ? "var(--loss)" : undefined }}>{fmtMoney(r.under)}</td>
                    <td style={{ ...td, color: signColor(r.pnl) }}>{fmtSigned(r.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Lotes reales en Interactive Brokers ({calc.lots.filter((p) => !p.closed).length})</div></div>
        {calc.lots.length === 0 ? <div className="empty">Sin lotes en seguimiento.</div> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lote</th>
                  <th style={th}>Acciones</th>
                  <th style={th}>Al empezar</th>
                  <th style={th}>Ahora</th>
                  <th style={th}>Desde el inicio</th>
                  <th style={th}>Call abierta</th>
                </tr>
              </thead>
              <tbody>
                {calc.lots.map((p) => (
                  <Fragment key={p.id}>
                    <tr onClick={() => toggle(p.id)} style={{ cursor: "pointer" }}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {expanded[p.id] ? <ChevronDown size={14} color="var(--muted)" /> : <ChevronRight size={14} color="var(--muted)" />}
                          <span className="mono" style={{ fontWeight: 600 }}>{p.ticker}</span>
                          <span style={{ color: "var(--muted)", fontSize: 13 }}>{p.name}</span>
                        </span>
                      </td>
                      <td style={td}>{fmtNum(p.qty, 0)}</td>
                      <td style={td}>{fmtMoney(p.entry)}</td>
                      <td style={td}>{fmtMoney(p.now)}</td>
                      <td style={{ ...td, color: signColor(p.ret) }}>{fmtPct(p.ret)}</td>
                      <td style={td}>{callCell(openCall("real", p.ticker))}</td>
                    </tr>
                    {expanded[p.id] && p.note && (
                      <tr>
                        <td colSpan={6} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
                          <div style={{ ...noteBox, padding: "4px 0 6px 20px" }}>{p.note}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-sub" style={{ marginTop: 10 }}>
          Son posiciones reales. Aquí solo se anota qué call tocaría con las mismas reglas y, si se opera, a qué precio entró. «Al empezar» es la apertura del día en que arrancó el seguimiento, no el precio de compra. Las órdenes las pone Rafa.
        </div>
      </div>

      {signals && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Última lectura de cada empresa</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th style={th}>Fecha</th>
                  <th style={th}>Técnico</th>
                  <th style={th}>RSI</th>
                  <th style={th}>Sobre media 50</th>
                  <th style={th}>Margen</th>
                  <th style={th}>Percentil volatilidad</th>
                  <th>Decisión</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => {
                  const rsi = num(s.rsi);
                  return (
                    <Fragment key={s.id}>
                      <tr onClick={() => toggle(s.id)} style={{ cursor: "pointer" }}>
                        <td>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {expanded[s.id] ? <ChevronDown size={14} color="var(--muted)" /> : <ChevronRight size={14} color="var(--muted)" />}
                            <span className="mono" style={{ fontWeight: 600 }}>{s.ticker}</span>
                          </span>
                        </td>
                        <td style={td}>{fmtDate(s.date)}</td>
                        <td style={td}>{TECH_LABEL[s.tech_state] || "—"}</td>
                        <td style={{ ...td, color: rsi != null && (rsi >= 70 || rsi <= 30) ? "var(--gold)" : undefined }}>{fmtNum(rsi, 0)}</td>
                        <td style={td}>{fmtPct(num(s.pct_vs_ma50))}</td>
                        <td style={td}>{fmtPlain(num(s.margin_pct), 0)}</td>
                        <td style={{ ...td, color: s.iv_percentile != null && num(s.iv_percentile) >= 0.66 ? "var(--gold)" : undefined }}>{s.iv_percentile == null ? "—" : fmtPlain(num(s.iv_percentile) * 100, 0)}</td>
                        <td>{DECISION_LABEL[s.decision] || s.decision || "—"}</td>
                      </tr>
                      {expanded[s.id] && (
                        <tr>
                          <td colSpan={8} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
                            <div style={{ ...noteBox, padding: "4px 0 6px 20px" }}>
                              <div>
                                Cierre {fmtMoney(num(s.close))} · media de 50 sesiones {fmtMoney(num(s.ma50))}
                                {s.fair_value != null ? ` · valor razonable ${fmtMoney(num(s.fair_value))}` : " · sin valor razonable del motor"}
                                {s.iv != null ? ` · volatilidad implícita ${fmtPlain(num(s.iv) * 100, 0)}` : ""}
                                {s.next_earnings ? ` · próximos resultados: ${s.next_earnings}` : ""}
                              </div>
                              {s.note && <div style={{ marginTop: 4, color: "var(--text)" }}>{s.note}</div>}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>
            Resaltado: RSI en 70 o más (un escalón más de delta) o en 30 o menos (no se vende call), y percentil de volatilidad implícita en 66% o más (un escalón más). «Margen» es lo que le falta al precio para llegar al valor razonable del motor.
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
