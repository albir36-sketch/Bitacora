import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { supabase } from "./supabaseClient";

// Experimento EN VIVO del doble calendario semanal en SPX (cartera TEÓRICA, desde el 27-oct-2026).
// Entrada el lunes a las 15:44 NY: put y call SPXW a delta 0,20 que vencen el viernes, largas del siguiente día hábil.
// Revisiones de martes a viernes a las 10:31, 13:31 y 15:44 NY (tareas programadas) → dcexp_marks y dcexp_exits.
// Cuatro libros con la misma operación: regla de Rafa a 0,3 % y a 0,2 % del breakeven, +25 % del débito y viernes.
// debit, value_* son por acción (×100 = $); pnl ya está en dólares por doble calendario (con 12 $ de comisiones).

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtSigned = (n, digits = 2) => (n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n, digits)}`);
const fmtNum = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPctOf = (v, base, digits = 2) =>
  v == null || base == null ? "" : ` (${v / base - 1 > 0 ? "+" : ""}${fmtNum((v / base - 1) * 100, digits)}%)`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
// Fecha y hora en Nueva York (las reglas están en hora de NY)
const fmtNY = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-ES", {
    timeZone: "America/New_York", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }) + " NY";
};
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");

const COLORS = { rafa_03: "#34D399", rafa_02: "#F472B6", pct_25: "#60A5FA", viernes: "#E8A33D" };
const BOOKS = [
  ["rafa_03", "Regla de Rafa · 0,3 %"],
  ["rafa_02", "Regla de Rafa · 0,2 %"],
  ["pct_25", "Objetivo +25 %"],
  ["viernes", "Hasta el viernes"],
];
const REASONS = {
  nivel_inferior: "nivel inferior",
  nivel_superior: "nivel superior",
  objetivo_25: "objetivo +25 %",
  viernes: "viernes",
};

const RULES = [
  ["Entrada", "Cada lunes a las 15:44 de Nueva York (martes si el lunes es festivo). Se venden put y call SPXW con delta ≈ 0,20 que vencen el viernes y se compran las mismas con vencimiento el siguiente día hábil (normalmente el lunes)."],
  ["Precio", "Débito realista: compra de las largas a medio + ¼ de la horquilla y venta de las cortas a medio − ¼. Comisiones de 12 $ por doble calendario (1,5 $ por contrato y lado)."],
  ["Revisiones", "De martes a viernes a las 10:31, 13:31 y 15:44 de Nueva York (16:31, 19:31 y 21:44 en España, salvo cambio de hora). En cada revisión se guarda el valor, el P&L si se cerrara en ese momento, los breakevens y los niveles de salida."],
  ["Regla de Rafa (0,3 %)", "Se calcula dónde la operación dejaría de ganar ahora mismo (breakevens, como la tabla de OptionStrat) y la salida se pone 0,3 % del SPX antes, hacia el centro: la «tercera fila positiva» de la tabla con rango ±1 %. Si el SPX llega a ese nivel, por abajo o por arriba, y la operación da beneficio, se cierra. Si llega pero va en pérdida, se aguanta hasta el viernes."],
  ["Regla de Rafa (0,2 %)", "Igual, con la salida 0,2 % antes del breakeven. Se lleva para comparar."],
  ["Objetivo +25 %", "Se cierra cuando el P&L llega al 25 % del débito pagado."],
  ["Hasta el viernes", "Se cierra en la revisión de las 15:44 del viernes. Todos los libros que sigan abiertos ese día se cierran también a esa hora."],
  ["Modelo", "Black-Scholes con la volatilidad de cada pata fija y anclado al valor de mercado del momento. Los niveles pueden diferir ~0,1 % de los de OptionStrat porque aquí se usan los precios reales de IBKR."],
];

export default function DoubleCalendarExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [trades, setTrades] = useState([]);
  const [marks, setMarks] = useState([]);
  const [exits, setExits] = useState([]);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const [c, t, m, e] = await Promise.all([
        supabase.from("dcexp_config").select("user_id,start_date").eq("user_id", uid).maybeSingle(),
        supabase.from("dcexp_trades").select("*").eq("user_id", uid).order("entry_ts", { ascending: false }),
        supabase.from("dcexp_marks").select("*").eq("user_id", uid).order("ts", { ascending: true }),
        supabase.from("dcexp_exits").select("*").eq("user_id", uid).order("exit_ts", { ascending: true }),
      ]);
      if (cancelled) return;
      const err = [c, t, m, e].find((r) => r.error);
      if (err) setError(err.error.message);
      setConfig(c.data);
      setTrades(t.data || []);
      setMarks(m.data || []);
      setExits(e.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.user.id]);

  const calc = useMemo(() => {
    const exitsByTrade = {};
    for (const x of exits) (exitsByTrade[x.trade_id] ||= {})[x.book] = x;
    const marksByTrade = {};
    for (const m of marks) (marksByTrade[m.trade_id] ||= []).push(m);

    const stats = {};
    for (const [b] of BOOKS) {
      const ex = exits.filter((x) => x.book === b && x.pnl != null);
      const total = ex.reduce((s, x) => s + num(x.pnl), 0);
      const wins = ex.filter((x) => num(x.pnl) > 0).length;
      let eq = 0, peak = 0, dd = 0;
      for (const x of ex) { eq += num(x.pnl); peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
      stats[b] = {
        n: ex.length,
        total,
        avg: ex.length ? total / ex.length : null,
        winRate: ex.length ? (wins / ex.length) * 100 : null,
        maxDD: dd,
      };
    }

    // curva acumulada por libro, en el orden de cierre
    const allExitDates = [...new Set(exits.map((x) => String(x.exit_ts).slice(0, 10)))].sort();
    const acc = Object.fromEntries(BOOKS.map(([b]) => [b, 0]));
    const chart = [{ date: config ? fmtDate(config.start_date) : "", ...Object.fromEntries(BOOKS.map(([b]) => [b, 0])) }];
    for (const d of allExitDates) {
      for (const [b] of BOOKS) {
        acc[b] += exits.filter((x) => x.book === b && String(x.exit_ts).slice(0, 10) === d).reduce((s, x) => s + num(x.pnl), 0);
      }
      chart.push({ date: fmtDate(d), ...Object.fromEntries(BOOKS.map(([b]) => [b, acc[b]])) });
    }

    const isOpen = (t) => BOOKS.some(([b]) => !exitsByTrade[t.id]?.[b]);
    const open = trades.filter(isOpen);
    return { exitsByTrade, marksByTrade, stats, chart, open };
  }, [config, trades, marks, exits]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento del doble calendario…</div></div>;
  if (!config) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de doble calendario configurado.</div>
      </div>
    );
  }

  const th = { textAlign: "right" };
  const strikesTxt = (t) => `${fmtNum(num(t.put_strike), 0)}P / ${fmtNum(num(t.call_strike), 0)}C`;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO EN VIVO · DOBLE CALENDARIO SEMANAL EN SPX</div>
        <div className="h1">¿Cuándo conviene salir del doble calendario?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica desde el {fmtDate(config.start_date)}, con precios reales de IBKR y sin órdenes. Cada lunes se abre un
          doble calendario en SPX (strikes a delta 0,20, cortas del viernes y largas del lunes siguiente) y se revisa tres veces
          al día hasta el viernes. Cuatro libros con la misma operación comparan cuándo cerrar: la regla de Rafa a 0,3 % y a 0,2 %
          del breakeven, un objetivo del +25 % del débito y aguantar hasta el viernes. Resultados en $ por doble calendario,
          con comisiones.
        </div>
      </div>

      <div className="cards">
        {BOOKS.map(([b, label]) => {
          const s = calc.stats[b];
          return (
            <div className="card" key={b}>
              <div className="card-label" style={{ color: COLORS[b] }}>{label}</div>
              <div className="card-value big" style={{ color: signColor(s.total) }}>{fmtSigned(s.total, 0)}</div>
              <div className="card-sub">
                {s.n} {s.n === 1 ? "operación cerrada" : "operaciones cerradas"}
                {s.avg != null ? ` · media ${fmtSigned(s.avg, 0)}` : ""}
              </div>
              <div className="card-sub">
                Acierto {s.winRate == null ? "—" : `${fmtNum(s.winRate, 0)}%`} · peor caída {fmtMoney(s.maxDD, 0)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Operaciones abiertas</div></div>
        {calc.open.length === 0 ? (
          <div className="empty">No hay ninguna operación abierta. La próxima se abre el lunes a las 15:44 de Nueva York.</div>
        ) : (
          calc.open.map((t) => {
            const ms = calc.marksByTrade[t.id] || [];
            const last = ms[ms.length - 1];
            const ex = calc.exitsByTrade[t.id] || {};
            const spx = num(last?.spx);
            const pnlChart = ms.map((m) => ({ ts: fmtNY(m.ts), pnl: num(m.pnl), spx: num(m.spx) }));
            return (
              <div key={t.id} style={{ marginBottom: 20 }}>
                <div className="card-sub" style={{ marginBottom: 8 }}>
                  <strong>{strikesTxt(t)}</strong> · cortas {fmtDate(t.short_exp)}, largas {fmtDate(t.long_exp)} · débito{" "}
                  {fmtMoney(num(t.debit) * 100, 0)} · abierta {fmtNY(t.entry_ts)}
                  {t.origin === "optionstrat" ? " · operación de prueba de OptionStrat" : ""}
                </div>
                {last ? (
                  <div className="cards">
                    <div className="card">
                      <div className="card-label">Última revisión</div>
                      <div className="card-value">{fmtNY(last.ts)}</div>
                      <div className="card-sub">SPX {fmtNum(spx, 2)}</div>
                    </div>
                    <div className="card">
                      <div className="card-label">P&L si se cierra ahora</div>
                      <div className="card-value big" style={{ color: signColor(num(last.pnl)) }}>{fmtSigned(num(last.pnl), 0)}</div>
                      <div className="card-sub">Valor a medio {fmtMoney(num(last.value_mid) * 100, 0)}</div>
                    </div>
                    <div className="card">
                      <div className="card-label">Breakevens ahora</div>
                      <div className="card-value">{fmtNum(num(last.be_low), 0)} · {fmtNum(num(last.be_high), 0)}</div>
                      <div className="card-sub">{fmtPctOf(num(last.be_low), spx)} · {fmtPctOf(num(last.be_high), spx)}</div>
                    </div>
                    <div className="card">
                      <div className="card-label" style={{ color: COLORS.rafa_03 }}>Salida 0,3 %</div>
                      <div className="card-value">{fmtNum(num(last.exit_low_03), 0)} · {fmtNum(num(last.exit_high_03), 0)}</div>
                      <div className="card-sub">{fmtPctOf(num(last.exit_low_03), spx)} · {fmtPctOf(num(last.exit_high_03), spx)}</div>
                    </div>
                    <div className="card">
                      <div className="card-label" style={{ color: COLORS.rafa_02 }}>Salida 0,2 %</div>
                      <div className="card-value">{fmtNum(num(last.exit_low_02), 0)} · {fmtNum(num(last.exit_high_02), 0)}</div>
                      <div className="card-sub">{fmtPctOf(num(last.exit_low_02), spx)} · {fmtPctOf(num(last.exit_high_02), spx)}</div>
                    </div>
                    <div className="card">
                      <div className="card-label">Libros</div>
                      {BOOKS.map(([b, label]) => (
                        <div className="card-sub" key={b} style={{ color: COLORS[b] }}>
                          {label}: {ex[b] ? `cerrado ${fmtSigned(num(ex[b].pnl), 0)}` : "abierto"}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="empty">Todavía no hay revisiones de esta operación.</div>
                )}
                {pnlChart.length >= 2 && (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={pnlChart} margin={{ top: 8, right: 28, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="ts" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} minTickGap={30} />
                      <YAxis tick={{ fill: "#7E8CA6", fontSize: 12 }} axisLine={{ stroke: "#20304C" }} tickLine={false} width={56} />
                      <ReferenceLine y={0} stroke="#20304C" />
                      <Tooltip
                        contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 8, fontSize: 13, padding: "8px 12px" }}
                        labelStyle={{ color: "var(--gold)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}
                        formatter={(v, name, p) => [`${fmtSigned(v, 0)} · SPX ${fmtNum(p.payload.spx, 2)}`, "P&L"]}
                      />
                      <Line type="linear" dataKey="pnl" name="P&L" stroke="#34D399" strokeWidth={2.5} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Resultado acumulado de cada libro</div></div>
        {calc.chart.length < 3 ? (
          <div className="empty">El gráfico aparecerá cuando haya cierres en al menos dos días distintos.</div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={calc.chart} margin={{ top: 8, right: 28, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} minTickGap={40} />
              <YAxis tick={{ fill: "#7E8CA6", fontSize: 12 }} axisLine={{ stroke: "#20304C" }} tickLine={false} width={56} />
              <ReferenceLine y={0} stroke="#20304C" />
              <Tooltip
                contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 8, fontSize: 13, padding: "8px 12px" }}
                labelStyle={{ color: "var(--gold)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}
                formatter={(v, name) => [fmtSigned(v, 0), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
              {BOOKS.map(([b, label]) => (
                <Line key={b} type="linear" name={label} dataKey={b} stroke={COLORS[b]} strokeWidth={b === "rafa_03" ? 2.5 : 2} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Operaciones</div></div>
        {trades.length === 0 ? (
          <div className="empty">Todavía no hay operaciones.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Semana</th>
                  <th>Strikes</th>
                  <th>Vencimientos</th>
                  <th style={th}>Débito</th>
                  {BOOKS.map(([b, label]) => (
                    <th key={b} style={{ color: COLORS[b] }}>{label}</th>
                  ))}
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const ex = calc.exitsByTrade[t.id] || {};
                  return (
                    <tr key={t.id}>
                      <td className="mono">{fmtDate(t.week_start)}</td>
                      <td className="mono">{strikesTxt(t)}</td>
                      <td className="mono">{fmtDate(t.short_exp)} / {fmtDate(t.long_exp)}</td>
                      <td style={th}>{fmtMoney(num(t.debit) * 100, 0)}</td>
                      {BOOKS.map(([b]) => {
                        const x = ex[b];
                        return (
                          <td key={b} style={{ color: signColor(num(x?.pnl)) }}>
                            {x ? `${fmtSigned(num(x.pnl), 0)} · ${REASONS[x.reason] || x.reason || ""} · ${fmtNY(x.exit_ts)}` : "abierto"}
                          </td>
                        );
                      })}
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>
                        {t.origin === "optionstrat" ? "Prueba de OptionStrat. " : ""}{t.notes || ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="panel-title">Reglas</div>
          <button className="btn btn-ghost" onClick={() => setShowRules((v) => !v)}>{showRules ? "Ocultar" : "Mostrar"}</button>
        </div>
        {showRules && (
          <div className="table-wrap">
            <table>
              <tbody>
                {RULES.map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
