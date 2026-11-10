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

const COLORS = { senal: "#34D399", senal_d20: "#F472B6", control: "#E8A33D", ema35: "#60A5FA" };
const BOOKS = [
  ["senal", "Señal media 30"],
  ["senal_d20", "Señal · delta 0,20"],
  ["control", "Control 10:30"],
  ["ema35", "Toque EMA 35"],
];

// Libros MVS de final de sesión (desde el 6-nov-2026): tarea «tomas del MVS» a las 13:01, 14:01 y 15:01 de NY.
// Guarda cada toma en idxexp_mvs y abre en idxexp_trades los libros mvs_<base>_<hora> (puts o calls); los liquida la de las 16:27.
const MVS_SLOTS = ["13", "14", "15"];
const MVS_BASES = [["oi", "Interés abierto"], ["vol", "Volumen de hoy"]];
const MVS_BOOKS = MVS_BASES.flatMap(([base, bl]) => MVS_SLOTS.map((h) => [`mvs_${base}_${h}`, `${bl} · ${h}:00`, base, h]));

// Árbol de decisión de final de sesión (desde el 10-nov-2026): idxexp_struct guarda, en las tomas de las 14 y 15 h,
// 10 estructuras valoradas con la cadena real; chosen = true es la que elige el árbol (una al día), el resto es «sombra».
const STRUCT_KINDS = [
  ["mariposa", "Iron butterfly en el MVS"],
  ["condor", "Iron condor fuera de los muros"],
  ["dir_iman", "Direccional hacia el MVS (imán)"],
  ["dir_muro", "Direccional detrás del MVS (muro)"],
  ["dir_tendencia", "Direccional a favor del día"],
];
const legsText = (legs) =>
  (legs || []).map((l) => `${l.q > 0 ? "+" : "−"}${l.t}${Math.round(Number(l.k))}`).join(" ");

const SUBTABS = [
  ["manana", "Spreads de la mañana (10-12 h)"],
  ["mvs", "Libros MVS (13-15 h)"],
  ["arbol", "Árbol de final de sesión"],
  ["reglas", "Reglas"],
];

const RULES = [
  ["Libro «señal»", "Velas de 5 min del SPX. Señal alcista: dos cierres seguidos por encima de la media de 30, el segundo más alto que el primero y el anterior por debajo. Solo cuenta si la vela cierra entre las 10:00 y las 12:00 de Nueva York. La primera señal del día abre un put credit spread. Sin calls."],
  ["Libro «control»", "El mismo put spread cada día con la vela que cierra a las 10:30, sin señal. Sirve para saber si la señal aporta o si lo que gana es vender prima."],
  ["Libro «EMA 35»", "Añadido el 21-oct-2026 (idea del canal Master Traders). EMA de 35 velas de 5 min. Señal: la vela toca la media (mínimo ≤ EMA) y cierra por encima, la anterior también cerró por encima y la media está más alta que hace 6 velas. Misma ventana de 10:00 a 12:00 y mismo spread. En la prueba sobre histórico dio +28 $ por operación, pero con EMA de 15, 21 o 50 casi desaparece: por eso se comprueba en directo."],
  ["Libro «señal delta 0,20»", "Añadido el 22-oct-2026. Misma señal y misma entrada que el libro «señal», pero con la pata vendida en delta ≤ 0,20 en lugar de 0,12 (más prima, más riesgo de que se toque). En la prueba sobre histórico dio +39 $ por operación frente a +21 $ con 0,12, aunque el modelo de precios puede exagerar esa mejora."],
  ["Spread", "Vencimiento del mismo día (SPXW). Pata vendida: el primer strike con delta ≤ 0,12. Pata comprada 10 puntos por debajo."],
  ["Precio", "Cierre de 5 min de cada pata en la vela de entrada, menos 0,10 de deslizamiento. Comisiones 3 $ por spread."],
  ["Salida", "Sin stop ni objetivo: se deja vencer. Liquidación con el cierre del SPX."],
  ["Tamaño", "1 spread por operación sobre 10.000 $. Pérdida máxima unos 940 $."],
  ["Libros MVS (final de sesión)", "Añadidos el 6-nov-2026 (idea de Rafa con Sigma Trade). A las 13:01, 14:01 y 15:01 de NY se calcula con IBKR el MVS del 0DTE (strike con más gamma neta de los dealers, a ±100 puntos del precio), con interés abierto y con el volumen del día. SPX por debajo del MVS → bear call spread con la vendida en MVS + 5; por encima → bull put spread con la vendida en MVS − 5. Ancho 10, crédito = medio − 0,10, comisiones 3 $, se deja vencer. Seis libros: 2 bases × 3 horas."],
  ["Árbol de final de sesión", "Añadido el 10-nov-2026 (idea de Rafa: no hacer siempre lo mismo). A las 14:00 de NY (y, si no hay entrada, a las 15:00) se mira el régimen de gamma del 0DTE y la posición del precio. Gamma positiva y precio cerca del MVS (menos de medio movimiento esperado hasta el cierre) → iron butterfly de 10 en el MVS. Gamma positiva con Put Wall y Call Wall separados (≥ 20 puntos) y el precio entre ellos → iron condor de 10 con las vendidas 10 puntos por fuera de los muros. Gamma positiva y precio lejos del MVS → spread de 10 hacia el MVS (put spread bajo el precio si está por debajo del MVS, call spread sobre el precio si está por encima). Gamma negativa y el SPX lejos de la apertura → spread de 10 a favor del movimiento del día, detrás del MVS. Si no, no se opera. Una operación al día, se deja vencer. Las demás estructuras (alas de 5 y de 10) se valoran en la sombra para comparar."],
  ["Seguimiento", "Se anotan sin aplicarlos: VIX1D, gamma del día anterior, días macro y si antes de entrar se barrió el mínimo del día anterior (candidato a filtro)."],
];

export default function IntradayExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [days, setDays] = useState([]);
  const [trades, setTrades] = useState([]);
  const [mvs, setMvs] = useState([]);
  const [structs, setStructs] = useState([]);
  const [showRules, setShowRules] = useState(true);
  const [subtab, setSubtab] = useState(() => {
    try { return localStorage.getItem("idxexp_subtab") || "manana"; } catch { return "manana"; }
  });
  useEffect(() => { try { localStorage.setItem("idxexp_subtab", subtab); } catch { /* sin almacenamiento */ } }, [subtab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const [c, d, t, m, x] = await Promise.all([
        supabase.from("idxexp_config").select("*").eq("user_id", uid).maybeSingle(),
        supabase.from("idxexp_days").select("*").eq("user_id", uid).order("date", { ascending: false }),
        supabase.from("idxexp_trades").select("*").eq("user_id", uid).order("trade_date", { ascending: false }),
        supabase.from("idxexp_mvs").select("id,date,slot,ts,spx,atm_iv,mvs_oi,mvs_vol,flip_oi,put_wall_oi,call_wall_oi,net_gex_oi,notes").eq("user_id", uid).order("date", { ascending: false }).order("slot", { ascending: true }),
        supabase.from("idxexp_struct").select("id,date,slot,kind,chosen,regime,rule,spx_entry,mvs_oi,em_points,legs,credit,max_loss,spx_settle,pnl").eq("user_id", uid).order("date", { ascending: false }).order("slot", { ascending: true }),
      ]);
      if (cancelled) return;
      const err = [c, d, t].find((r) => r.error);
      // idxexp_mvs puede no tener filas aún; su error no bloquea el resto
      setMvs(m.error ? [] : m.data || []);
      setStructs(x.error ? [] : x.data || []);
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
    const acc = Object.fromEntries(BOOKS.map(([b]) => [b, 0]));
    const chart = [{ date: fmtDate(config.start_date), ...Object.fromEntries(BOOKS.map(([b]) => [b, capital])) }];
    for (const dt of dates) {
      for (const [b] of BOOKS) {
        acc[b] += trades.filter((t) => t.book === b && t.trade_date === dt).reduce((s, t) => s + (num(t.pnl) || 0), 0);
      }
      chart.push({ date: fmtDate(dt), ...Object.fromEntries(BOOKS.map(([b]) => [b, capital + acc[b]])) });
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
    const mvsStats = {};
    for (const [b] of MVS_BOOKS) {
      const all = trades.filter((t) => t.book === b);
      const tr = all.filter((t) => t.pnl != null);
      const total = tr.reduce((s, t) => s + num(t.pnl), 0);
      let eq = 0, peak = 0, dd = 0;
      for (const t of [...tr].sort((a, b2) => (a.trade_date < b2.trade_date ? -1 : 1))) {
        eq += num(t.pnl); peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
      }
      mvsStats[b] = {
        n: tr.length,
        open: all.length - tr.length,
        total,
        avg: tr.length ? total / tr.length : null,
        winRate: tr.length ? (tr.filter((t) => num(t.pnl) > 0).length / tr.length) * 100 : null,
        avgCredit: tr.length ? (tr.reduce((s, t) => s + num(t.credit), 0) / tr.length) * 100 : null,
        worst: tr.length ? Math.min(...tr.map((t) => num(t.pnl))) : null,
        maxDD: dd,
      };
    }
    // árbol: la elegida de cada día; sombra: cada estructura por tipo y ancho, por régimen
    const settled = structs.filter((r) => r.pnl != null);
    const chosen = settled.filter((r) => r.chosen);
    const sumStats = (arr) => {
      const total = arr.reduce((s, r) => s + num(r.pnl), 0);
      return {
        n: arr.length, total, avg: arr.length ? total / arr.length : null,
        winRate: arr.length ? (arr.filter((r) => num(r.pnl) > 0).length / arr.length) * 100 : null,
      };
    };
    const tree = sumStats(chosen);
    const shadow = [];
    for (const [base, label] of STRUCT_KINDS) {
      for (const w of [10, 5]) {
        const kind = `${base}_${w}`;
        const arr = settled.filter((r) => r.kind === kind);
        shadow.push({
          kind, label: `${label} · alas ${w}`,
          all: sumStats(arr),
          pos: sumStats(arr.filter((r) => r.regime === "positiva")),
          neg: sumStats(arr.filter((r) => r.regime === "negativa")),
        });
      }
    }
    const treeDays = [...new Set(structs.map((r) => r.date))].sort().reverse().map((date) => {
      const rows = structs.filter((r) => r.date === date);
      const pick = rows.find((r) => r.chosen);
      const best = rows.filter((r) => r.pnl != null).sort((a, b2) => num(b2.pnl) - num(a.pnl))[0];
      const first = rows[0];
      return { date, pick, best, regime: (pick || first)?.regime, rule: (pick || rows.find((r) => r.slot === "15") || first)?.rule };
    });
    return { capital, stats, chart, sweep, signalDays, nDays: days.length, mvsStats, tree, shadow, treeDays };
  }, [config, days, trades, structs]);

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
        <div className="tabs" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {SUBTABS.map(([k, label]) => (
            <button key={k} className={`tab ${subtab === k ? "active" : ""}`} onClick={() => setSubtab(k)}>{label}</button>
          ))}
        </div>
      </div>

      {subtab === "manana" && (
        <>
      <div className="panel">
        <div className="h1">¿Aporta la señal de la media 30 al vender puts del mismo día?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica de {fmtMoney(calc.capital, 0)} desde el {fmtDate(config.start_date)}. Cuatro libros de put credit spreads
          0DTE con precios reales de IBKR: uno abre cuando salta la señal de la media de 30 en 5 minutos, otro cuando el
          precio toca la EMA 35 con la media subiendo, otro igual que el de la señal pero con la pata vendida en delta 0,20, y el último vende todos los días a las 10:30 como control. Se deja vencer, sin stop. Cada día laborable, a las 16:27 de
          Nueva York, una tarea programada anota la sesión. Los libros de final de sesión con el MVS y el árbol están en sus pestañas.
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
              <Line type="linear" name="Señal · delta 0,20" dataKey="senal_d20" stroke={COLORS.senal_d20} strokeWidth={2} dot={calc.chart.length < 25} isAnimationActive={false} />
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
                  {BOOKS.map(([b, label]) => (
                    <th key={b} colSpan={3} style={{ color: COLORS[b] }}>{label}: spread · crédito · resultado</th>
                  ))}
                  <th>Mín. de ayer barrido</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const spread = (t) => (t ? `${fmtNum(num(t.short_strike), 0)}/${fmtNum(num(t.long_strike), 0)} · ${t.entry_time}` : "—");
                  return (
                    <tr key={d.date}>
                      <td className="mono">{fmtDate(d.date)}</td>
                      <td style={th}>{fmtNum(num(d.spx_close), 2)}</td>
                      <td style={th}>{fmtNum(num(d.vix1d_prev), 2)}</td>
                      <td>{d.signal_dir ? d.signal_time : "No"}</td>
                      <td>{d.ema35_time || "No"}</td>
                      {BOOKS.map(([b]) => {
                        const t = tradesByDate[d.date]?.[b];
                        return [
                          <td key={`${b}-s`} className="mono">{spread(t)}</td>,
                          <td key={`${b}-c`} style={th}>{t ? fmtNum(num(t.credit), 2) : "—"}</td>,
                          <td key={`${b}-p`} style={{ ...th, color: signColor(num(t?.pnl)) }}>{t ? fmtSigned(num(t.pnl), 0) : "—"}</td>,
                        ];
                      })}
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
        </>
      )}
      {subtab === "mvs" && (
        <>
      <div className="panel">
        <div className="panel-head"><div className="panel-title">Libros MVS de final de sesión (desde el 6-nov-2026)</div></div>
        <div className="card-sub" style={{ marginBottom: 8 }}>
          ¿El SPX respeta el MVS del 0DTE en las últimas horas? A las 13, 14 y 15 h de Nueva York se vende un spread de 10 con la
          pata vendida en el strike siguiente al MVS, del lado contrario al precio (call si el SPX está por debajo, put si está
          por encima), y se deja vencer. Se compara el MVS con interés abierto (como Sigma con base OI) y con el volumen del día.
          Sin histórico posible: solo cuenta lo que se registra en directo.
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Libro</th><th style={th}>Operaciones</th><th style={th}>Resultado</th><th style={th}>Media</th>
                <th style={th}>Acierto</th><th style={th}>Crédito medio</th><th style={th}>Peor</th><th style={th}>Peor caída</th>
              </tr>
            </thead>
            <tbody>
              {MVS_BOOKS.map(([b, label]) => {
                const s = calc.mvsStats[b];
                return (
                  <tr key={b}>
                    <td>{label}</td>
                    <td style={th}>{s.n}{s.open ? ` (+${s.open} abierta${s.open > 1 ? "s" : ""})` : ""}</td>
                    <td style={{ ...th, color: signColor(s.total) }}>{s.n ? fmtSigned(s.total, 0) : "—"}</td>
                    <td style={{ ...th, color: signColor(s.avg) }}>{s.avg == null ? "—" : fmtSigned(s.avg, 0)}</td>
                    <td style={th}>{s.winRate == null ? "—" : `${fmtNum(s.winRate, 0)}%`}</td>
                    <td style={th}>{s.avgCredit == null ? "—" : fmtMoney(s.avgCredit, 0)}</td>
                    <td style={{ ...th, color: signColor(s.worst) }}>{s.worst == null ? "—" : fmtSigned(s.worst, 0)}</td>
                    <td style={th}>{s.n ? fmtMoney(s.maxDD, 0) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="panel-head" style={{ marginTop: 16 }}><div className="panel-title">Tomas</div></div>
        {mvs.length === 0 ? (
          <div className="empty">La primera toma será el 6-nov-2026 a las 13:01 de Nueva York (19:01 en España).</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th><th>Hora</th><th style={th}>SPX</th><th style={th}>MVS OI</th><th style={th}>MVS vol.</th>
                  <th style={th}>γ Flip</th><th style={th}>Put Wall</th><th style={th}>Call Wall</th>
                  {MVS_BASES.map(([base, bl]) => (
                    <th key={base} colSpan={3}>{bl}: spread · crédito · resultado</th>
                  ))}
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {mvs.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{fmtDate(r.date)}</td>
                    <td className="mono">{r.slot}:00</td>
                    <td style={th}>{fmtNum(num(r.spx), 2)}</td>
                    <td style={th}>{fmtNum(num(r.mvs_oi), 0)}</td>
                    <td style={th}>{fmtNum(num(r.mvs_vol), 0)}</td>
                    <td style={th}>{fmtNum(num(r.flip_oi), 0)}</td>
                    <td style={th}>{fmtNum(num(r.put_wall_oi), 0)}</td>
                    <td style={th}>{fmtNum(num(r.call_wall_oi), 0)}</td>
                    {MVS_BASES.map(([base]) => {
                      const t = tradesByDate[r.date]?.[`mvs_${base}_${r.slot}`];
                      return [
                        <td key={`${base}-s`} className="mono">
                          {t ? `${t.side === "call" ? "Call" : "Put"} ${fmtNum(num(t.short_strike), 0)}/${fmtNum(num(t.long_strike), 0)}` : "—"}
                        </td>,
                        <td key={`${base}-c`} style={th}>{t ? fmtNum(num(t.credit), 2) : "—"}</td>,
                        <td key={`${base}-p`} style={{ ...th, color: signColor(num(t?.pnl)) }}>
                          {t ? (t.pnl == null ? "abierta" : fmtSigned(num(t.pnl), 0)) : "—"}
                        </td>,
                      ];
                    })}
                    <td style={{ color: "var(--muted)", fontSize: 13 }}>{r.notes || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}
      {subtab === "arbol" && (
        <>
      <div className="panel">
        <div className="panel-head"><div className="panel-title">Árbol de final de sesión (desde el 10-nov-2026)</div></div>
        <div className="card-sub" style={{ marginBottom: 8 }}>
          Cada día se elige una estructura según la gamma del 0DTE y la posición del precio respecto al MVS (ver «Reglas»). Todas
          las demás se valoran con los mismos precios para comparar: si el árbol gana a hacer siempre lo mismo, la elección aporta.
          El 6 y el 9-nov están reconstruidos con la cadena guardada en las tomas.
        </div>
        <div className="cards">
          <div className="card">
            <div className="card-label">Árbol (la elegida cada día)</div>
            <div className="card-value big" style={{ color: signColor(calc.tree.total) }}>{calc.tree.n ? fmtSigned(calc.tree.total, 0) : "—"}</div>
            <div className="card-sub">
              {calc.tree.n} {calc.tree.n === 1 ? "operación" : "operaciones"} · media {calc.tree.avg == null ? "—" : fmtSigned(calc.tree.avg, 0)} · acierto {calc.tree.winRate == null ? "—" : `${fmtNum(calc.tree.winRate, 0)}%`}
            </div>
          </div>
        </div>
        {calc.treeDays.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr><th>Fecha</th><th>Gamma</th><th>Regla</th><th>Elegida</th><th style={th}>Crédito</th><th style={th}>Resultado</th><th>Mejor de la sombra</th><th style={th}>Resultado</th></tr>
              </thead>
              <tbody>
                {calc.treeDays.map((d) => (
                  <tr key={d.date}>
                    <td className="mono">{fmtDate(d.date)}</td>
                    <td>{d.regime || "—"}</td>
                    <td>{d.rule || "—"}</td>
                    <td className="mono">{d.pick ? `${d.pick.kind} ${d.pick.slot}h · ${legsText(d.pick.legs)}` : "Sin entrada"}</td>
                    <td style={th}>{d.pick ? fmtNum(num(d.pick.credit), 2) : "—"}</td>
                    <td style={{ ...th, color: signColor(num(d.pick?.pnl)) }}>{d.pick ? (d.pick.pnl == null ? "abierta" : fmtSigned(num(d.pick.pnl), 0)) : "—"}</td>
                    <td className="mono">{d.best ? `${d.best.kind} ${d.best.slot}h` : "—"}</td>
                    <td style={{ ...th, color: signColor(num(d.best?.pnl)) }}>{d.best ? fmtSigned(num(d.best.pnl), 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-head" style={{ marginTop: 16 }}><div className="panel-title">Sombra: cada estructura todos los días (tomas de 14 y 15 h)</div></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Estructura</th><th style={th}>Op.</th><th style={th}>Resultado</th><th style={th}>Media</th><th style={th}>Acierto</th>
                <th style={th}>Gamma + (op. · media)</th><th style={th}>Gamma − (op. · media)</th>
              </tr>
            </thead>
            <tbody>
              {calc.shadow.map((r) => (
                <tr key={r.kind}>
                  <td>{r.label}</td>
                  <td style={th}>{r.all.n}</td>
                  <td style={{ ...th, color: signColor(r.all.total) }}>{r.all.n ? fmtSigned(r.all.total, 0) : "—"}</td>
                  <td style={{ ...th, color: signColor(r.all.avg) }}>{r.all.avg == null ? "—" : fmtSigned(r.all.avg, 0)}</td>
                  <td style={th}>{r.all.winRate == null ? "—" : `${fmtNum(r.all.winRate, 0)}%`}</td>
                  <td style={{ ...th, color: signColor(r.pos.avg) }}>{r.pos.n ? `${r.pos.n} · ${fmtSigned(r.pos.avg, 0)}` : "—"}</td>
                  <td style={{ ...th, color: signColor(r.neg.avg) }}>{r.neg.n ? `${r.neg.n} · ${fmtSigned(r.neg.avg, 0)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}
      {subtab === "reglas" && (
        <>
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
      )}
    </>
  );
}
