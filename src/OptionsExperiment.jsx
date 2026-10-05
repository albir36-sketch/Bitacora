import { Fragment, useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase } from "./supabaseClient";

// Experimento de opciones: cartera TEÓRICA de 10.000 $ que vende prima con riesgo definido
// (put spreads sobre empresas y sobre índices, call spreads e iron condor) y se compara con la cartera de acciones del otro
// experimento, con el S&P 500 (SPY) y con el Nasdaq-100 (QQQ). Las operaciones se registran en
// la base de datos en cada revisión mensual; esta vista solo lee y calcula.
//
// Convenciones de las tablas optexp_*:
//   credit, exit_debit y mark son precios POR ACCIÓN del spread completo (×100 por contrato).
//   mark = último precio medio conocido de un spread abierto (si falta, se usa el crédito).

const COLORS = { opciones: "#34D399", acciones: "#E8A33D", spy: "#60A5FA", qqq: "#C084FC" };
const STRATEGIES = [
  ["put_spread", "Put spread"],
  ["index_put_spread", "Put spread índice"],
  ["call_spread", "Call spread"],
  ["iron_condor", "Iron condor"],
];
const STRATEGY_LABEL = Object.fromEntries(STRATEGIES);
const SIDE_LABEL = { put: "Put spreads", index_put: "Put spreads sobre índice (control)", call: "Call spreads", condor: "Iron condor" };
const EXIT_LABEL = { objetivo: "Beneficio", stop: "Stop", tiempo: "Tiempo", vencimiento: "Vencimiento", otro: "Otro" };
const TARGET_FRACTION = 0.5; // recompra al 50 % del crédito
const STOP_MULTIPLE = 3; // el spread vale 3 veces lo cobrado = pérdida de 2 veces el crédito

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

// "P 225/220" (vendida/comprada). En un iron condor: "P 730/725 · C 800/805".
function describeLegs(legs) {
  return ["P", "C"]
    .map((type) => {
      const sold = legs.find((l) => l.opt_type === type && l.action === "sell");
      const bought = legs.find((l) => l.opt_type === type && l.action === "buy");
      if (!sold && !bought) return null;
      return `${type} ${sold ? fmtStrike(sold.strike) : "—"}/${bought ? fmtStrike(bought.strike) : "—"}`;
    })
    .filter(Boolean)
    .join(" · ");
}

// Mayor caída desde un máximo en una serie de valores.
function maxDrawdown(values) {
  let peak = -Infinity, dd = 0;
  values.forEach((v) => {
    if (v > peak) peak = v;
    if (peak - v > dd) dd = peak - v;
  });
  return dd;
}

export default function OptionsExperiment({ session }) {
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
        supabase.from("optexp_config").select("*").maybeSingle(),
        supabase.from("optexp_trades").select("*").order("entry_date", { ascending: true }),
        supabase.from("optexp_legs").select("*"),
        supabase.from("optexp_snapshots").select("*").order("date", { ascending: true }),
        supabase.from("optexp_universe").select("*").order("motor_score", { ascending: false, nullsFirst: false }),
        supabase.from("optexp_log").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
        // Datos del experimento de acciones, para comparar las dos carteras.
        supabase.from("experiment_config").select("*").maybeSingle(),
        supabase.from("experiment_positions").select("*"),
        supabase.from("experiment_prices").select("*"),
        supabase.from("experiment_snapshots").select("*").order("date", { ascending: true }),
        supabase.from("experiment_dividends").select("*"),
      ]);
      if (cancelled) return;
      const firstErr = res.find((r) => r.error);
      if (firstErr) setError(firstErr.error.message);
      const [config, trades, legs, snapshots, universe, log, stockConfig, stockPositions, stockPrices, stockSnapshots, dividends] = res.map((r) => r.data);
      const prices = {};
      (stockPrices || []).forEach((r) => { prices[r.ticker] = num(r.price); });
      setData({
        config: config || null, trades: trades || [], legs: legs || [], snapshots: snapshots || [],
        universe: universe || [], log: log || [], stockConfig: stockConfig || null,
        stockPositions: stockPositions || [], prices, stockSnapshots: stockSnapshots || [], dividends: dividends || [],
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const calc = useMemo(() => {
    if (!data?.config) return null;
    const { config, trades, legs, dividends, prices, stockConfig, stockPositions } = data;
    const startCapital = num(config.start_capital);

    const rows = trades.map((t) => {
      const contracts = num(t.contracts);
      const credit = num(t.credit);
      const width = num(t.width);
      const closed = t.exit_date != null;
      const feesIn = num(t.commissions_entry) || 0;
      const feesOut = num(t.commissions_exit) || 0;
      const mark = num(t.mark) ?? credit;
      const exitDebit = num(t.exit_debit);
      const maxRisk = (width - credit) * 100 * contracts;
      const maxProfit = credit * 100 * contracts - feesIn;
      const pnl = closed
        ? (credit - exitDebit) * 100 * contracts - feesIn - feesOut
        : (credit - mark) * 100 * contracts - feesIn;
      return {
        ...t, contracts, credit, width, closed, mark, exitDebit, maxRisk, maxProfit, pnl,
        fees: feesIn + feesOut,
        legsText: describeLegs(legs.filter((l) => l.trade_id === t.id)),
        legs: legs.filter((l) => l.trade_id === t.id),
        target: credit * TARGET_FRACTION,
        stop: credit * STOP_MULTIPLE,
        dte: closed ? null : daysTo(t.expiry),
        retOnRisk: maxRisk ? (pnl / maxRisk) * 100 : null,
      };
    });

    const open = rows.filter((r) => !r.closed);
    const closedRows = rows.filter((r) => r.closed).sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1));
    const realized = closedRows.reduce((s, r) => s + r.pnl, 0);
    const unrealized = open.reduce((s, r) => s + r.pnl, 0);
    const total = startCapital + realized + unrealized;
    const openRisk = open.reduce((s, r) => s + r.maxRisk, 0);

    // Estadística por estrategia y del conjunto, solo con operaciones cerradas.
    const statsFor = (label, list, openCount) => {
      const wins = list.filter((r) => r.pnl > 0);
      const losses = list.filter((r) => r.pnl <= 0);
      const chrono = [...list].sort((a, b) => (a.exit_date < b.exit_date ? -1 : 1));
      let acc = 0;
      const curve = [0, ...chrono.map((r) => (acc += r.pnl))];
      return {
        label, n: list.length, openCount,
        winRate: list.length ? (wins.length / list.length) * 100 : null,
        avgWin: wins.length ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : null,
        avgLoss: losses.length ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : null,
        net: list.reduce((s, r) => s + r.pnl, 0),
        fees: list.reduce((s, r) => s + r.fees, 0),
        drawdown: list.length ? maxDrawdown(curve) : null,
      };
    };
    const stats = STRATEGIES.map(([key, label]) =>
      statsFor(label, closedRows.filter((r) => r.strategy === key), open.filter((r) => r.strategy === key).length)
    );
    const statsTotal = statsFor("Total", closedRows, open.length);

    // Índices y cartera de acciones, con dividendos, desde el inicio de este experimento.
    const spyRet = pct((prices.SPY ?? null) == null ? null : prices.SPY + divsBetween(dividends, "SPY", config.start_date, null), num(config.spy_start));
    const qqqRet = pct((prices.QQQ ?? null) == null ? null : prices.QQQ + divsBetween(dividends, "QQQ", config.start_date, null), num(config.qqq_start));
    let stockRet = null;
    if (stockConfig) {
      const cap = num(stockConfig.start_capital);
      let value = cap;
      stockPositions.forEach((p) => {
        const qty = num(p.qty);
        const ref = p.exit_date != null ? num(p.exit_price) : (prices[p.ticker] ?? num(p.entry_price));
        value += qty * (ref - num(p.entry_price) + divsBetween(dividends, p.ticker, p.entry_date, p.exit_date));
      });
      stockRet = pct(value, cap);
    }

    return {
      startCapital, total, realized, unrealized, open, closedRows, openRisk, stats, statsTotal,
      openRiskPct: startCapital ? (openRisk / total) * 100 : null,
      portRet: pct(total, startCapital), spyRet, qqqRet, stockRet,
      feesTotal: rows.reduce((s, r) => s + r.fees, 0),
    };
  }, [data]);

  // Gráfico: un punto por cada foto guardada del experimento de opciones. El valor de la cartera de
  // acciones se toma de su foto más reciente en esa fecha o antes, sumándole los dividendos cobrados.
  const chartData = useMemo(() => {
    if (!data?.config || data.snapshots.length === 0) return [];
    const { config, snapshots, stockConfig, stockSnapshots, stockPositions, dividends } = data;
    const cap = num(config.start_capital), spy0 = num(config.spy_start), qqq0 = num(config.qqq_start);
    const stockCap = stockConfig ? num(stockConfig.start_capital) : null;
    const stockDivsUpTo = (date) => stockPositions.reduce((sum, p) => {
      const to = p.exit_date != null && p.exit_date < date ? p.exit_date : date;
      return sum + num(p.qty) * divsBetween(dividends, p.ticker, p.entry_date, to);
    }, 0);
    return snapshots.map((s) => {
      const stockSnap = [...stockSnapshots].reverse().find((x) => x.date <= s.date);
      return {
        date: fmtDate(s.date),
        opciones: (num(s.portfolio_value) / cap) * 100,
        acciones: stockSnap && stockCap ? ((num(stockSnap.portfolio_value) + stockDivsUpTo(s.date)) / stockCap) * 100 : null,
        spy: ((num(s.spy_price) + divsBetween(dividends, "SPY", config.start_date, s.date)) / spy0) * 100,
        qqq: ((num(s.qqq_price) + divsBetween(dividends, "QQQ", config.start_date, s.date)) / qqq0) * 100,
      };
    });
  }, [data]);

  const universe = useMemo(() => {
    if (!data?.universe.length) return null;
    const latest = data.universe.reduce((max, u) => (u.review_date > max ? u.review_date : max), "");
    const items = data.universe.filter((u) => u.review_date === latest);
    return { date: latest, groups: ["put", "index_put", "call", "condor"].map((side) => [side, items.filter((u) => u.side === side)]) };
  }, [data]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento de opciones…</div></div>;
  if (!data?.config || !calc) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de opciones configurado.</div>
      </div>
    );
  }

  const { config, log } = data;
  const advStock = calc.portRet != null && calc.stockRet != null ? calc.portRet - calc.stockRet : null;
  const advSpy = calc.portRet != null && calc.spyRet != null ? calc.portRet - calc.spyRet : null;
  const th = { textAlign: "right" };
  const td = { textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", whiteSpace: "nowrap" };
  const noteBox = { position: "sticky", left: 0, maxWidth: "min(760px, calc(100vw - 80px))", whiteSpace: "normal" };
  const chip = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "3px 8px", borderRadius: 6, border: "1px solid var(--border)", color: "var(--text)" };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO · CARTERA TEÓRICA DE OPCIONES</div>
        <div className="h1">¿Rinde más vender prima que tener las acciones?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Desde el {fmtDate(config.start_date)} con {fmtMoney(calc.startCapital, 0)} teóricos · spreads de riesgo definido · comisión de {fmtMoney(num(config.commission_per_contract))} por contrato · la liquidez no cobra intereses
        </div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="card-label">Cartera de opciones</div>
          <div className="card-value big" style={{ color: signColor(calc.portRet) }}>{fmtPct(calc.portRet, 2)}</div>
          <div className="card-sub">{fmtMoney(calc.total)} · cerrado {fmtSigned(calc.realized)} · abierto {fmtSigned(calc.unrealized)}</div>
        </div>
        <div className="card">
          <div className="card-label">Cartera de acciones</div>
          <div className="card-value big" style={{ color: signColor(calc.stockRet) }}>{fmtPct(calc.stockRet, 2)}</div>
          <div className="card-sub">ventaja de las opciones: <span style={{ color: signColor(advStock) }}>{fmtPts(advStock, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">S&P 500 · QQQ</div>
          <div className="card-value big" style={{ color: signColor(calc.spyRet) }}>{fmtPct(calc.spyRet, 2)}</div>
          <div className="card-sub">QQQ {fmtPct(calc.qqqRet, 2)} · ventaja sobre el S&P 500: <span style={{ color: signColor(advSpy) }}>{fmtPts(advSpy, 2)}</span></div>
        </div>
        <div className="card">
          <div className="card-label">Riesgo abierto</div>
          <div className="card-value big">{fmtPlain(calc.openRiskPct, 1)}</div>
          <div className="card-sub">{fmtMoney(calc.openRisk, 0)} en {calc.open.length} operaciones · tope 40%</div>
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
              <Line type="linear" name="Opciones" dataKey="opciones" stroke={COLORS.opciones} strokeWidth={2.5} dot={chartData.length < 15} activeDot={{ r: 5 }} isAnimationActive={false} />
              <Line type="linear" name="Acciones" dataKey="acciones" stroke={COLORS.acciones} strokeWidth={2} dot={chartData.length < 15} connectNulls isAnimationActive={false} />
              <Line type="linear" name="S&P 500" dataKey="spy" stroke={COLORS.spy} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
              <Line type="linear" name="QQQ" dataKey="qqq" stroke={COLORS.qqq} strokeWidth={2} dot={chartData.length < 15} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Operaciones abiertas ({calc.open.length})</div></div>
        {calc.open.length === 0 ? (
          <div className="empty">No hay operaciones abiertas. Las entradas se anotan en la revisión mensual con la cadena real de ese día.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operación</th>
                  <th style={th}>Strikes</th>
                  <th style={th}>Vence</th>
                  <th style={th}>Crédito</th>
                  <th style={th}>Ahora</th>
                  <th style={th}>Resultado</th>
                  <th style={th}>Objetivo</th>
                  <th style={th}>Stop</th>
                  <th style={th}>Riesgo máx.</th>
                </tr>
              </thead>
              <tbody>
                {calc.open.map((r) => (
                  <Fragment key={r.id}>
                    <tr onClick={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))} style={{ cursor: "pointer" }}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {expanded[r.id] ? <ChevronDown size={14} color="var(--muted)" /> : <ChevronRight size={14} color="var(--muted)" />}
                          <span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span>
                          <span style={{ color: "var(--muted)", fontSize: 13 }}>{STRATEGY_LABEL[r.strategy]}{r.contracts > 1 ? ` ×${r.contracts}` : ""}</span>
                        </span>
                      </td>
                      <td style={td}>{r.legsText || "—"}</td>
                      <td style={td}>{fmtDate(r.expiry)} · {r.dte} d</td>
                      <td style={td}>{fmtMoney(r.credit)}</td>
                      <td style={td}>{fmtMoney(r.mark)}</td>
                      <td style={{ ...td, color: signColor(r.pnl) }}>{fmtSigned(r.pnl)}</td>
                      <td style={td}>{fmtMoney(r.target)}</td>
                      <td style={td}>{fmtMoney(r.stop)}</td>
                      <td style={td}>{fmtMoney(r.maxRisk, 0)}</td>
                    </tr>
                    {expanded[r.id] && (
                      <tr>
                        <td colSpan={9} style={{ borderTop: "none", paddingTop: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
                          <div style={{ ...noteBox, padding: "4px 0 6px 20px" }}>
                            {r.thesis && <div style={{ color: "var(--text)" }}>{r.thesis}</div>}
                            <div style={{ marginTop: 4 }}>
                              Entró el {fmtDate(r.entry_date)} con {r.ticker} a {fmtMoney(num(r.underlying_entry))}
                              {r.short_delta != null ? ` · delta vendida ${Number(r.short_delta).toLocaleString("es-ES", { maximumFractionDigits: 2 })}` : ""}
                              {r.iv_entry != null ? ` · volatilidad implícita ${fmtPlain(num(r.iv_entry) * 100, 0)}` : ""}
                              {` · crédito ${fmtPlain((r.credit / r.width) * 100, 0)} del ancho`}
                              {` · beneficio máximo ${fmtMoney(r.maxProfit)}`}
                              {r.mark_date ? ` · precio actual del ${fmtDate(r.mark_date)}` : ""}
                              {r.price_source ? ` · fuente: ${r.price_source}` : ""}
                            </div>
                          </div>
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
          «Crédito», «Ahora», «Objetivo» y «Stop» son precios del spread por acción (×100 por contrato). El objetivo es recomprar al 50% del crédito; el stop salta cuando el spread vale 3 veces lo cobrado. «Resultado» ya descuenta la comisión de entrada. Lo que siga abierto se cierra en la revisión mensual siguiente.
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Resultado por estrategia</div></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Estrategia</th>
                <th style={th}>Cerradas</th>
                <th style={th}>Abiertas</th>
                <th style={th}>Acierto</th>
                <th style={th}>Ganancia media</th>
                <th style={th}>Pérdida media</th>
                <th style={th}>Resultado neto</th>
                <th style={th}>Caída máx.</th>
              </tr>
            </thead>
            <tbody>
              {[...calc.stats, calc.statsTotal].map((s) => (
                <tr key={s.label} style={s.label === "Total" ? { fontWeight: 600 } : undefined}>
                  <td>{s.label}</td>
                  <td style={td}>{s.n}</td>
                  <td style={td}>{s.openCount}</td>
                  <td style={td}>{fmtPlain(s.winRate, 0)}</td>
                  <td style={{ ...td, color: signColor(s.avgWin) }}>{fmtSigned(s.avgWin)}</td>
                  <td style={{ ...td, color: signColor(s.avgLoss) }}>{fmtSigned(s.avgLoss)}</td>
                  <td style={{ ...td, color: signColor(s.n ? s.net : null) }}>{s.n ? fmtSigned(s.net) : "—"}</td>
                  <td style={td}>{s.drawdown == null ? "—" : fmtMoney(s.drawdown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-sub" style={{ marginTop: 10 }}>
          Solo cuentan las operaciones cerradas, netas de comisiones (pagadas hasta ahora: {fmtMoney(calc.feesTotal)}). «Caída máx.» es la mayor racha de pérdidas acumuladas de esa estrategia, en dólares.
        </div>
      </div>

      {calc.closedRows.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Operaciones cerradas ({calc.closedRows.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operación</th>
                  <th style={th}>Strikes</th>
                  <th style={th}>Entrada</th>
                  <th style={th}>Salida</th>
                  <th style={th}>Motivo</th>
                  <th style={th}>Resultado</th>
                  <th style={th}>Sobre riesgo</th>
                </tr>
              </thead>
              <tbody>
                {calc.closedRows.map((r) => (
                  <tr key={r.id}>
                    <td><span className="mono" style={{ fontWeight: 600 }}>{r.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{STRATEGY_LABEL[r.strategy]}</span></td>
                    <td style={td}>{r.legsText || "—"}</td>
                    <td style={td}>{fmtDate(r.entry_date)} · {fmtMoney(r.credit)}</td>
                    <td style={td}>{fmtDate(r.exit_date)} · {fmtMoney(r.exitDebit)}</td>
                    <td style={td}>{EXIT_LABEL[r.exit_reason] || "—"}{r.exit_estimated ? " (est.)" : ""}</td>
                    <td style={{ ...td, color: signColor(r.pnl) }}>{fmtSigned(r.pnl)}</td>
                    <td style={{ ...td, color: signColor(r.retOnRisk) }}>{fmtPct(r.retOnRisk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>
            «(est.)» indica una salida por beneficio o stop entre dos revisiones, valorada con los cierres diarios del subyacente y no con precio real de la cadena. «Sobre riesgo» es el resultado dividido entre el riesgo máximo de la operación.
          </div>
        </div>
      )}

      {universe && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Universo del mes (revisión del {fmtDate(universe.date)})</div></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {universe.groups.map(([side, items]) => (
              <div key={side}>
                <div className="card-label" style={{ marginBottom: 6 }}>{SIDE_LABEL[side]} ({items.length})</div>
                {items.length === 0 ? (
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>Ninguna candidata este mes.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {items.map((u) => (
                      <span key={u.id} style={chip} title={[u.name, u.source, u.motor_bucket, u.note].filter(Boolean).join(" · ")}>
                        {u.ticker}{u.motor_score != null ? <span style={{ color: "var(--muted)" }}> {num(u.motor_score)}</span> : null}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="card-sub" style={{ marginTop: 10 }}>El número junto a cada empresa es su puntaje en el motor de Aprende a Invertir. Solo se opera sobre esta lista hasta la revisión siguiente.</div>
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
