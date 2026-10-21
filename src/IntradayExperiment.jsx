import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { supabase } from "./supabaseClient";

// Experimento intradía 0DTE en el SPX: cartera TEÓRICA, tres libros de put credit spreads del mismo día.
//   'senal'   → señal de media 30 en velas de 5 min (primera señal alcista entre las 10:00 y las 12:00 de NY).
//   'control' → put spread a ciegas con la vela que cierra a las 10:30.
//   'ema35'   → toque de la EMA 35 de 5 min con la media subiendo (10:00-12:00), añadido el 21-oct-2026.
// La tarea programada diaria (16:27 NY) rellena idxexp_days, idxexp_trades, idxexp_bars e idxexp_legprices.
// Esta vista solo lee y calcula. credit y settle_value son por acción; pnl ya está en dólares por spread.

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtSigned = (n, digits = 2) => (n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n, digits)}`);
const fmtPct = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const fmtNum = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");

const COLORS = { senal: "#34D399", control: "#E8A33D", ema35: "#60A5FA" };
const BOOKS = [
  ["senal", "Señal media 30"],
  ["control", "Control 10:30"],
  ["ema35", "Toque EMA 35"],
];

const RULES = [
  ["Libro «señal»", "Velas de 5 min del SPX. Señal alcista: dos cierres seguidos por encima de la media de 30, el segundo más alto que el primero y el anterior por debajo. Solo cuenta si la vela cierra entre las 10:00 y las 12:00 de Nueva York. La primera señal del día abre un put credit spread. Sin calls."],
  ["Libro «control»", "El mismo put spread cada día con la vela que cierra a las 10:30, sin señal. Sirve para saber si la señal aporta o si lo que gana es vender prima."],
  ["Libro «EMA 35»", "Añadido el 21-oct-2026 (idea del canal Master Traders). EMA de 35 velas de 5 min. Señal: la vela toca la media (mínimo ≤ EMA) y cierra por encima, la anterior también cerró por encima y la media está más alta que hace 6 velas. Misma ventana de 10:00 a 12:00 y mismo spread. En la prueba sobre histórico dio +28 $ por operación, pero con EMA de 15, 21 o 50 casi desaparece: por eso se comprueba en directo."],
  ["Spread", "Vencimiento del mismo día (SPXW). Pata vendida: el primer strike con delta ≤ 0,12. Pata comprada 10 puntos por debajo."],
  ["Precio", "Cierre de 5 min de cada pata en la vela de entrada, menos 0,10 de deslizamiento. Comisiones 3 $ por spread."],
  ["Salida", "Sin stop ni objetivo: se deja vencer. Liquidación con el cierre del SPX."],
  ["Tamaño", "1 spread por operación sobre 10.000 $. Pérdida máxima unos 940 $."],
  ["Seguimiento", "Se anotan sin aplicarlos: VIX1D, gamma del día anterior, días macro y si antes de entrar se barrió el mínimo del día anterior (candidato a filtro)."],
];

export default function IntradayExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [days, setDays] = useState([]);
  const [trades, setTrades] = useState([]);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const [c, d, t] = await Promise.all([
        supabase.from("idxexp_config").select("*").eq("user_id", uid).maybeSingle(),
        supabase.from("idxexp_days").select("*").eq("user_id", uid).order("date", { ascending: false }),
        supabase.from("idxexp_trades").select("*").eq("user_id", uid).order("trade_date", { ascending: false }),
      ]);
      if (cancelled) return;
      const err = [c, d, t].find((r) => r.error);
      if (err) setError(err.error.message);
      setConfig(c.data);
      setDays(d.data || []);
      setTrades(t.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.user.id]);

  const calc = useMemo(() => {
    if (!config) return null;
    const capital = num(config.start_capital);
    const stats = {};
    for (const [b] of BOOKS) {
      const tr = trades.filter((t) => t.book === b && t.pnl != null);
      const total = tr.reduce((s, t) => s + num(t.pnl), 0);
      const wins = tr.filter((t) => num(t.pnl) > 0);
      const losses = tr.filter((t) => num(t.pnl) <= 0);
      // caída máxima en orden cronológico
      let eq = 0, peak = 0, dd = 0;
      for (const t of [...tr].sort((a, b2) => (a.trade_date < b2.trade_date ? -1 : 1))) {
        eq += num(t.pnl); peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
      }
      stats[b] = {
        n: tr.length,
        total,
        value: capital + total,
        ret: (total / capital) * 100,
        winRate: tr.length ? (wins.length / tr.length) * 100 : null,
        avgCredit: tr.length ? (tr.reduce((s, t) => s + num(t.credit), 0) / tr.length) * 100 : null,
        avgLoss: losses.length ? losses.reduce((s, t) => s + num(t.pnl), 0) / losses.length : null,
        maxDD: dd,
      };
    }
    // curva: valor de cada libro tras cada día registrado
    const dates = [...new Set(days.map((d) => d.date).concat(trades.map((t) => t.trade_date)))].sort();
    let acc = { senal: 0, control: 0, ema35: 0 };
    const chart = [{ date: fmtDate(config.start_date), senal: capital, control: capital, ema35: capital }];
    for (const dt of dates) {
      for (const [b] of BOOKS) {
        acc[b] += trades.filter((t) => t.book === b && t.trade_date === dt).reduce((s, t) => s + (num(t.pnl) || 0), 0);
      }
      chart.push({ date: fmtDate(dt), senal: capital + acc.senal, control: capital + acc.control, ema35: capital + acc.ema35 });
    }
    // filtro candidato: barrido del mínimo de ayer
    const sweptByDate = Object.fromEntries(days.map((d) => [d.date, d.swept_prev_low_at_entry]));
    const sweep = {};
    for (const [b] of BOOKS) {
      const tr = trades.filter((t) => t.book === b && t.pnl != null);
      const yes = tr.filter((t) => sweptByDate[t.trade_date] === true);
      const no = tr.filter((t) => sweptByDate[t.trade_date] === false);
      const avg = (a) => (a.length ? a.reduce((s, t) => s + num(t.pnl), 0) / a.length : null);
      sweep[b] = { yesN: yes.length, yesAvg: avg(yes), noN: no.length, noAvg: avg(no) };
    }
    const signalDays = days.filter((d) => d.signal_dir).length;
    return { capital, stats, chart, sweep, signalDays, nDays: days.length };
  }, [config, days, trades]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento intradía…</div></div>;
  if (!config) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento intradía configurado.</div>
      </div>
    );
  }

  const th = { textAlign: "right" };
  const tradesByDate = {};
  for (const t of trades) (tradesByDate[t.trade_date] ||= {})[t.book] = t;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO · INTRADÍA 0DTE EN EL SPX</div>
        <div className="h1">¿Aporta la señal de la media 30 al vender puts del mismo día?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica de {fmtMoney(calc.capital, 0)} desde el {fmtDate(config.start_date)}. Tres libros de put credit spreads
          0DTE con precios reales de IBKR: uno abre cuando salta la señal de la media de 30 en 5 minutos, otro cuando el
          precio toca la EMA 35 con la media subiendo, y el tercero vende todos los días a las 10:30 como control. Se deja vencer, sin stop. Cada día laborable, a las 16:27 de
          Nueva York, una tarea programada anota la sesión.
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
                {s.n} {s.n === 1 ? "operación" : "operaciones"} · {fmtPct(s.ret, 2)} sobre {fmtMoney(calc.capital, 0)}
              </div>
              <div className="card-sub">
                Acierto {s.winRate == null ? "—" : `${fmtNum(s.winRate, 0)}%`} · crédito medio {s.avgCredit == null ? "—" : fmtMoney(s.avgCredit, 0)}
                {s.avgLoss != null ? ` · pérdida media ${fmtMoney(s.avgLoss, 0)}` : ""}
              </div>
              <div className="card-sub">Peor caída {fmtMoney(s.maxDD, 0)}</div>
            </div>
          );
        })}
        <div className="card">
          <div className="card-label">Sesiones registradas</div>
          <div className="card-value big">{calc.nDays}</div>
          <div className="card-sub">Con señal: {calc.signalDays} ({calc.nDays ? fmtNum((calc.signalDays / calc.nDays) * 100, 0) : "—"}%)</div>
          <div className="card-sub">En la prueba sobre histórico: señal en ~35% de los días, +23 $ por operación frente a −4 $ del control.</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Evolución de cada libro</div></div>
        {calc.chart.length < 3 ? (
          <div className="empty">El gráfico aparecerá cuando haya al menos dos sesiones registradas.</div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={calc.chart} margin={{ top: 8, right: 28, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "#7E8CA6", fontSize: 11 }} axisLine={{ stroke: "#20304C" }} tickLine={false} minTickGap={40} />
              <YAxis domain={["auto", "auto"]} tick={{ fill: "#7E8CA6", fontSize: 12 }} axisLine={{ stroke: "#20304C" }} tickLine={false} width={64} tickFormatter={(v) => v.toLocaleString("de-DE", { maximumFractionDigits: 0 })} />
              <ReferenceLine y={calc.capital} stroke="#20304C" />
              <Tooltip
                contentStyle={{ background: "#0E1626", border: "1px solid #20304C", borderRadius: 8, fontSize: 13, padding: "8px 12px" }}
                labelStyle={{ color: "var(--gold)", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}
                formatter={(v, name) => [`${fmtMoney(v, 0)} (${fmtSigned(v - calc.capital, 0)})`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--muted)" }} />
              <Line type="linear" name="Señal media 30" dataKey="senal" stroke={COLORS.senal} strokeWidth={2.5} dot={calc.chart.length < 25} isAnimationActive={false} />
              <Line type="linear" name="Control 10:30" dataKey="control" stroke={COLORS.control} strokeWidth={2} dot={calc.chart.length < 25} isAnimationActive={false} />
              <Line type="linear" name="Toque EMA 35" dataKey="ema35" stroke={COLORS.ema35} strokeWidth={2} dot={calc.chart.length < 25} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Sesiones</div></div>
        {days.length === 0 ? (
          <div className="empty">Todavía no hay sesiones registradas.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th style={th}>Cierre SPX</th>
                  <th style={th}>VIX1D</th>
                  <th>Señal</th>
                  <th>EMA 35</th>
                  <th>Señal: spread</th>
                  <th style={th}>Crédito</th>
                  <th style={th}>Resultado</th>
                  <th>EMA 35: spread</th>
                  <th style={th}>Crédito</th>
                  <th style={th}>Resultado</th>
                  <th>Control: spread</th>
                  <th style={th}>Crédito</th>
                  <th style={th}>Resultado</th>
                  <th>Mín. de ayer barrido</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const s = tradesByDate[d.date]?.senal;
                  const c = tradesByDate[d.date]?.control;
                  const e = tradesByDate[d.date]?.ema35;
                  const spread = (t) => (t ? `${fmtNum(num(t.short_strike), 0)}/${fmtNum(num(t.long_strike), 0)} · ${t.entry_time}` : "—");
                  return (
                    <tr key={d.date}>
                      <td className="mono">{fmtDate(d.date)}</td>
                      <td style={th}>{fmtNum(num(d.spx_close), 2)}</td>
                      <td style={th}>{fmtNum(num(d.vix1d_prev), 2)}</td>
                      <td>{d.signal_dir ? d.signal_time : "No"}</td>
                      <td>{d.ema35_time || "No"}</td>
                      <td className="mono">{spread(s)}</td>
                      <td style={th}>{s ? fmtNum(num(s.credit), 2) : "—"}</td>
                      <td style={{ ...th, color: signColor(num(s?.pnl)) }}>{s ? fmtSigned(num(s.pnl), 0) : "—"}</td>
                      <td className="mono">{spread(e)}</td>
                      <td style={th}>{e ? fmtNum(num(e.credit), 2) : "—"}</td>
                      <td style={{ ...th, color: signColor(num(e?.pnl)) }}>{e ? fmtSigned(num(e.pnl), 0) : "—"}</td>
                      <td className="mono">{spread(c)}</td>
                      <td style={th}>{c ? fmtNum(num(c.credit), 2) : "—"}</td>
                      <td style={{ ...th, color: signColor(num(c?.pnl)) }}>{c ? fmtSigned(num(c.pnl), 0) : "—"}</td>
                      <td>{d.swept_prev_low_at_entry == null ? "—" : d.swept_prev_low_at_entry ? "Sí" : "No"}</td>
                      <td style={{ color: "var(--muted)", fontSize: 13 }}>{[d.macro, d.notes].filter(Boolean).join(" · ") || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Filtro en observación: barrido del mínimo de ayer</div></div>
        <div className="card-sub" style={{ marginBottom: 8 }}>
          En la prueba sobre histórico (junio de 2024 a octubre de 2026), las señales de días en que el SPX ya había perforado el
          mínimo del día anterior antes de entrar dieron −3 $ por operación, frente a +36 $ del resto. No se aplica: se anota
          para ver si se repite.
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Libro</th><th style={th}>Con barrido</th><th style={th}>Media</th><th style={th}>Sin barrido</th><th style={th}>Media</th></tr>
            </thead>
            <tbody>
              {BOOKS.map(([b, label]) => {
                const s = calc.sweep[b];
                return (
                  <tr key={b}>
                    <td>{label}</td>
                    <td style={th}>{s.yesN}</td>
                    <td style={{ ...th, color: signColor(s.yesAvg) }}>{s.yesAvg == null ? "—" : fmtSigned(s.yesAvg, 0)}</td>
                    <td style={th}>{s.noN}</td>
                    <td style={{ ...th, color: signColor(s.noAvg) }}>{s.noAvg == null ? "—" : fmtSigned(s.noAvg, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
