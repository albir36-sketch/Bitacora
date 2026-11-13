import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { supabase } from "./supabaseClient";

// Experimento EN VIVO de estrategias de riesgo definido en SPX (cartera TEÓRICA, desde el 16-nov-2026).
// Cinco estrategias, cada una con dos libros de salida. Tareas programadas: toma y entradas a las 15:21 NY,
// revisiones a las 10:31 y 13:31 NY → rdexp_trades, rdexp_marks y rdexp_exits.
// debit y value_* son por acción (×100 = $); pnl, max_loss y max_profit ya están en dólares (con comisiones).

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 0) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtSigned = (n, digits = 0) => (n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n, digits)}`);
const fmtNum = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const fmtNY = (ts) =>
  !ts ? "—" : new Date(ts).toLocaleString("es-ES", { timeZone: "America/New_York", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " NY";
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const legsText = (legs) =>
  (legs || []).map((l) => `${l.qty > 0 ? "+" : "−"}${Math.abs(l.qty) > 1 ? Math.abs(l.qty) : ""}${l.right}${Math.round(Number(l.strike))}${l.expiry ? " " + String(l.expiry).slice(8, 10) + "/" + String(l.expiry).slice(5, 7) : ""}`).join("  ");

// ---------- Black-Scholes para los diagramas de ejemplo ----------
const Nc = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
const bs = (S, K, T, v, right) => {
  if (T <= 0) return right === "C" ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return right === "C" ? S * Nc(d1) - K * Nc(d2) : K * Nc(-d2) - S * Nc(-d1);
};
const DAY = 1 / 365;
// Pata de ejemplo: { right, strike, qty, tEntry (años hasta vencimiento al abrir), tEval (al evaluar) }
const examplePayoff = (legs, iv = 0.13, S0 = 7500, range = 175) => {
  const entry = legs.reduce((s, l) => s + l.qty * bs(S0, l.strike, l.tEntry, iv, l.right), 0);
  const out = [];
  for (let S = S0 - range; S <= S0 + range; S += 5) {
    const v = legs.reduce((s, l) => s + l.qty * bs(S, l.strike, l.tEval, iv, l.right), 0);
    out.push({ S, pnl: Math.round((v - entry) * 100) });
  }
  return { entry, data: out };
};

const STRATS = [
  {
    key: "mariposa_mvs",
    label: "Mariposa en el MVS",
    color: "#34D399",
    books: [["objetivo_50", "Objetivo 50 %"], ["vencimiento", "Al vencimiento"]],
    lead: "Apuesta a que mañana el SPX acabe cerca del imán de gamma (MVS). Barata, pérdida máxima = lo que pagas, y si clava el strike puede pagar varias veces la inversión.",
    how: [
      "Se compra una opción por debajo del centro, se venden dos en el centro y se compra otra por encima, todas del mismo tipo y vencimiento (alas de 25 puntos).",
      "El centro es el MVS (strike con más gamma total de los dealers) del vencimiento de mañana. Se abre a las 15:21 de Nueva York y vence al día siguiente.",
      "Pérdida máxima: el débito pagado. Ganancia máxima: ancho del ala (25) menos el débito, si el SPX cierra justo en el centro. Fuera de las alas no se gana nada.",
      "Riesgo de verdad acotado y sin sorpresas: las cuatro patas vencen a la vez y se liquidan en efectivo.",
    ],
    example: [
      { right: "C", strike: 7475, qty: 1, tEntry: DAY, tEval: 0 },
      { right: "C", strike: 7500, qty: -2, tEntry: DAY, tEval: 0 },
      { right: "C", strike: 7525, qty: 1, tEntry: DAY, tEval: 0 },
    ],
    exampleNote: "Ejemplo con el SPX y el MVS en 7.500, volatilidad del 13 %, al vencimiento.",
  },
  {
    key: "bwb_tendencia",
    label: "Mariposa de alas desiguales",
    color: "#60A5FA",
    books: [["objetivo_50", "Objetivo 50 %"], ["vencimiento", "Al vencimiento"]],
    lead: "Una mariposa torcida a favor de la tendencia: hacia un lado no se pierde nada (o casi) y hacia el otro el riesgo está limitado.",
    how: [
      "Como la mariposa, pero con un ala de 25 puntos y la otra de 50. Al hacer un ala más ancha, la estructura sale casi gratis o incluso con crédito.",
      "Con tendencia alcista (SPX por encima de su media de 30 días) se hace con puts: si el SPX sube, todo vence sin valor y no se pierde nada; el riesgo está si cae por debajo del ala ancha.",
      "Con tendencia bajista se hace con calls, al revés.",
      "Ganancia máxima en el centro (MVS de mañana); pérdida máxima unos 25 puntos (2.500 $) si el precio se va al lado del ala ancha. Es la más «técnica» de las cinco.",
    ],
    example: [
      { right: "P", strike: 7525, qty: 1, tEntry: DAY, tEval: 0 },
      { right: "P", strike: 7500, qty: -2, tEntry: DAY, tEval: 0 },
      { right: "P", strike: 7450, qty: 1, tEntry: DAY, tEval: 0 },
    ],
    exampleNote: "Ejemplo alcista con el MVS en 7.500 y el SPX en 7.500, al vencimiento.",
  },
  {
    key: "calendario_mvs",
    label: "Calendario simple en el MVS",
    color: "#A78BFA",
    books: [["pct_25", "Objetivo +25 %"], ["viernes", "Hasta el viernes"]],
    lead: "Medio doble calendario: un solo strike, en el imán de la semana, abierto después del evento para comprar la volatilidad barata.",
    how: [
      "Se vende una opción que vence el viernes y se compra la misma con vencimiento el lunes siguiente.",
      "El strike es el MVS del vencimiento del viernes. Se abre el día siguiente al evento importante de la semana (o el martes si no hay), con la volatilidad ya desinflada: la lección de la semana del 9-nov.",
      "Gana si el SPX se acerca al strike y pierde si se aleja mucho. Pérdida máxima ≈ el débito pagado.",
      "Al ser un solo strike, cuesta la mitad que el doble calendario y no tiene «hueco» en el medio. A cambio, el rango que gana es más estrecho.",
    ],
    example: [
      { right: "C", strike: 7500, qty: -1, tEntry: 3 * DAY, tEval: 0 },
      { right: "C", strike: 7500, qty: 1, tEntry: 6 * DAY, tEval: 3 * DAY },
    ],
    exampleNote: "Ejemplo con el SPX y el MVS en 7.500, el viernes al cierre, misma volatilidad (13 %).",
  },
  {
    key: "dc_muros",
    label: "Doble calendario en los muros",
    color: "#E8A33D",
    books: [["pct_25", "Objetivo +25 %"], ["viernes", "Hasta el viernes"]],
    lead: "El doble calendario de siempre, pero con los strikes en el put wall y el call wall y abierto después del evento, como tus pruebas del 11 y 12-nov.",
    how: [
      "Calendario de puts en el put wall y calendario de calls en el call wall del vencimiento del viernes.",
      "Se abre el día siguiente al evento importante de la semana (o el martes), con las largas más baratas.",
      "La idea es que los muros frenan el precio: si el SPX va hacia uno de ellos, se acerca al strike donde la operación gana más.",
      "Es la versión «mejorada» que salió de comparar tu operación real del 9-nov (−385 $) con tus pruebas de los muros (+887 $ y +622 $).",
    ],
    example: [
      { right: "P", strike: 7425, qty: -1, tEntry: 3 * DAY, tEval: 0 },
      { right: "P", strike: 7425, qty: 1, tEntry: 6 * DAY, tEval: 3 * DAY },
      { right: "C", strike: 7575, qty: -1, tEntry: 3 * DAY, tEval: 0 },
      { right: "C", strike: 7575, qty: 1, tEntry: 6 * DAY, tEval: 3 * DAY },
    ],
    exampleNote: "Ejemplo con el SPX en 7.500, put wall en 7.425 y call wall en 7.575, el viernes al cierre.",
  },
  {
    key: "vertical_ma30",
    label: "Vertical de débito con la media 30",
    color: "#F472B6",
    books: [["objetivo_stop", "Objetivo 50 % / stop 50 %"], ["vencimiento", "Al vencimiento"]],
    lead: "La más sencilla: una apuesta direccional con la tendencia, pagando poco y con la pérdida máxima conocida desde el principio.",
    how: [
      "Si el SPX está por encima de su media de 30 días se compra una call ATM y se vende otra un movimiento esperado más arriba (bull call spread). Si está por debajo, lo mismo con puts hacia abajo.",
      "Se abre el lunes con vencimiento el viernes de la semana siguiente (unas dos semanas).",
      "Pérdida máxima: el débito. Ganancia máxima: ancho del spread menos el débito (normalmente entre 1 y 2 veces lo que se arriesga).",
      "Es la versión de riesgo definido del experimento de la media de 30: si la tendencia sigue, gana; si se gira, la pérdida ya está acotada.",
    ],
    example: [
      { right: "C", strike: 7500, qty: 1, tEntry: 11 * DAY, tEval: 0 },
      { right: "C", strike: 7575, qty: -1, tEntry: 11 * DAY, tEval: 0 },
    ],
    exampleNote: "Ejemplo alcista con el SPX en 7.500 y un movimiento esperado de 75 puntos, al vencimiento.",
  },
];
const STRAT = Object.fromEntries(STRATS.map((s) => [s.key, s]));

const REASONS = {
  objetivo_50: "objetivo 50 %",
  objetivo: "objetivo",
  stop: "stop",
  pct_25: "objetivo +25 %",
  viernes: "viernes",
  vencimiento: "vencimiento",
};

const SUBTABS = [["resumen", "Resumen"], ...STRATS.map((s) => [s.key, s.label]), ["reglas", "Reglas comunes"]];

const COMMON_RULES = [
  ["Qué se prueba", "Petición de Rafa (13-nov-2026): estrategias con la pérdida acotada desde el principio y ganancia potencial alta, para aprender cuál encaja mejor con su forma de operar. Todas en SPX: opciones europeas que se liquidan en efectivo, sin riesgo de asignación."],
  ["Cartera", "Teórica, con precios reales de IBKR y sin órdenes. Una operación por estrategia y día de entrada. Empieza el 16-nov-2026."],
  ["Precio", "Débito realista: compras a medio + ¼ de la horquilla y ventas a medio − ¼. Comisiones de 1,5 $ por contrato y lado. Las patas que vencen se liquidan con el cierre oficial del SPX, sin comisión de salida."],
  ["Gamma (MVS y muros)", "Se calcula con el interés abierto y la gamma de IBKR del vencimiento de cada estrategia, en strikes múltiplos de 25 a ±2 % del precio, como Sigma Trade: MVS = strike con más gamma total (absoluta), put wall y call wall = strikes con más gamma de puts y de calls."],
  ["Tendencia", "SPX por encima de la media de sus 30 últimos cierres diarios = alcista; por debajo = bajista."],
  ["Horario", "Toma y entradas a las 15:21 de Nueva York (21:21 en España). Revisiones a las 10:31 y 13:31 (16:31 y 19:31 en España). El día de entrada solo se registra."],
  ["Dos libros por estrategia", "La misma operación se cierra de dos maneras para comparar: con un objetivo de beneficio (y en el vertical también con stop) o aguantando hasta el vencimiento o el viernes."],
];

function Payoff({ strat }) {
  const { entry, data } = useMemo(() => examplePayoff(strat.example), [strat]);
  const maxP = Math.max(...data.map((d) => d.pnl));
  const minP = Math.min(...data.map((d) => d.pnl));
  return (
    <div className="panel">
      <div className="panel-head"><div className="panel-title">Cómo gana y cómo pierde</div></div>
      <div className="card-sub" style={{ marginBottom: 8 }}>
        {strat.exampleNote} {entry >= 0 ? `Coste aproximado: ${fmtMoney(entry * 100)}.` : `Crédito aproximado: ${fmtMoney(-entry * 100)}.`}{" "}
        Ganancia máxima ≈ {fmtSigned(maxP)}; pérdida máxima en el rango dibujado ≈ {fmtSigned(minP)}.
      </div>
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="S" tick={{ fontSize: 11, fill: "var(--muted)" }} interval={9} />
            <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} width={56} />
            <Tooltip formatter={(v) => fmtSigned(v)} labelFormatter={(l) => `SPX ${l}`} />
            <ReferenceLine y={0} stroke="var(--muted)" />
            <ReferenceLine x={7500} stroke="var(--muted)" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="pnl" stroke={strat.color} dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function RiskDefinedExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [trades, setTrades] = useState([]);
  const [marks, setMarks] = useState([]);
  const [exits, setExits] = useState([]);
  const [subtab, setSubtab] = useState(() => {
    try { return localStorage.getItem("rdexp_subtab") || "resumen"; } catch { return "resumen"; }
  });
  useEffect(() => { try { localStorage.setItem("rdexp_subtab", subtab); } catch { /* sin almacenamiento */ } }, [subtab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const [c, t, m, e] = await Promise.all([
        supabase.from("rdexp_config").select("user_id,start_date").eq("user_id", uid).maybeSingle(),
        supabase.from("rdexp_trades").select("*").eq("user_id", uid).order("entry_ts", { ascending: false }),
        supabase.from("rdexp_marks").select("trade_id,ts,spx,value_mid,value_exit,pnl").eq("user_id", uid).order("ts", { ascending: true }),
        supabase.from("rdexp_exits").select("*").eq("user_id", uid).order("exit_ts", { ascending: true }),
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
    const lastMark = {};
    for (const m of marks) lastMark[m.trade_id] = m;
    const stats = {};
    for (const s of STRATS) {
      const tr = trades.filter((t) => t.strategy === s.key);
      const ids = new Set(tr.map((t) => t.id));
      const ml = tr.map((t) => num(t.max_loss)).filter((v) => v != null && v > 0);
      const mp = tr.map((t) => num(t.max_profit)).filter((v) => v != null);
      stats[s.key] = {
        n: tr.length,
        avgLoss: ml.length ? ml.reduce((a, b) => a + b, 0) / ml.length : null,
        avgProfit: mp.length ? mp.reduce((a, b) => a + b, 0) / mp.length : null,
        books: Object.fromEntries(s.books.map(([b]) => {
          const ex = exits.filter((x) => x.book === b && ids.has(x.trade_id) && x.pnl != null);
          const total = ex.reduce((a, x) => a + num(x.pnl), 0);
          const wins = ex.filter((x) => num(x.pnl) > 0).length;
          return [b, { n: ex.length, total, avg: ex.length ? total / ex.length : null, win: ex.length ? (wins / ex.length) * 100 : null }];
        })),
      };
    }
    return { exitsByTrade, lastMark, stats };
  }, [trades, marks, exits]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento de riesgo definido…</div></div>;
  if (!config) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de riesgo definido configurado.</div>
      </div>
    );
  }

  const th = { textAlign: "right" };
  const strat = STRAT[subtab];

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO EN VIVO · ESTRATEGIAS DE RIESGO DEFINIDO EN SPX</div>
        <div className="h1">Pérdida acotada, ganancia potencial alta: ¿cuál funciona mejor?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica desde el {fmtDate(config.start_date)}, con precios reales de IBKR y sin órdenes. Cinco estrategias en las que la
          pérdida máxima se conoce antes de entrar, cada una con dos formas de salir. Resultados en $ por operación, con comisiones.
        </div>
        <div className="tabs" style={{ flexWrap: "wrap", marginTop: 10 }}>
          {SUBTABS.map(([k, label]) => (
            <button key={k} className={`tab ${subtab === k ? "active" : ""}`} onClick={() => setSubtab(k)}>{label}</button>
          ))}
        </div>
      </div>

      {subtab === "resumen" && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Resultados por estrategia y libro</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Estrategia</th>
                  <th>Libro</th>
                  <th style={th}>Operaciones cerradas</th>
                  <th style={th}>Resultado</th>
                  <th style={th}>Media</th>
                  <th style={th}>% ganadoras</th>
                  <th style={th}>Pérdida máx. media</th>
                  <th style={th}>Ganancia máx. media</th>
                </tr>
              </thead>
              <tbody>
                {STRATS.flatMap((s) => s.books.map(([b, bl], i) => {
                  const st = calc.stats[s.key];
                  const x = st.books[b];
                  return (
                    <tr key={s.key + b}>
                      <td style={{ color: s.color }}>{i === 0 ? s.label : ""}</td>
                      <td>{bl}</td>
                      <td style={th}>{x.n}</td>
                      <td style={{ ...th, color: signColor(x.total) }}>{x.n ? fmtSigned(x.total) : "—"}</td>
                      <td style={{ ...th, color: signColor(x.avg) }}>{fmtSigned(x.avg)}</td>
                      <td style={th}>{x.win == null ? "—" : `${fmtNum(x.win, 0)} %`}</td>
                      <td style={th}>{i === 0 ? fmtMoney(st.avgLoss) : ""}</td>
                      <td style={th}>{i === 0 ? fmtMoney(st.avgProfit) : ""}</td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
          {trades.length === 0 && (
            <div className="card-sub" style={{ marginTop: 10 }}>
              Todavía no hay operaciones: las primeras entradas son el {fmtDate(config.start_date)} a las 15:21 de Nueva York (21:21 en España).
              Mientras tanto, cada pestaña explica una estrategia con su diagrama de ganancias y pérdidas.
            </div>
          )}
        </div>
      )}

      {strat && (
        <>
          <div className="panel">
            <div className="panel-title" style={{ color: strat.color }}>{strat.label}</div>
            <div className="card-sub" style={{ marginTop: 4 }}>{strat.lead}</div>
            <ul style={{ marginTop: 10, paddingLeft: 18, lineHeight: 1.55 }}>
              {strat.how.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}
            </ul>
            <div className="card-sub" style={{ marginTop: 6 }}>
              Libros: {strat.books.map(([, bl]) => bl).join(" · ")}.
            </div>
          </div>

          <Payoff strat={strat} />

          <div className="panel">
            <div className="panel-head"><div className="panel-title">Operaciones</div></div>
            {trades.filter((t) => t.strategy === strat.key).length === 0 ? (
              <div className="empty">Todavía no hay operaciones de esta estrategia.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Entrada</th>
                      <th>Patas</th>
                      <th style={th}>SPX</th>
                      <th style={th}>Débito</th>
                      <th style={th}>Pérdida máx.</th>
                      <th style={th}>Ganancia máx.</th>
                      <th style={th}>MVS / muros</th>
                      <th>Tendencia</th>
                      <th style={th}>P&L actual</th>
                      {strat.books.map(([b, bl]) => <th key={b} style={th}>{bl}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.filter((t) => t.strategy === strat.key).map((t) => {
                      const lm = calc.lastMark[t.id];
                      const ex = calc.exitsByTrade[t.id] || {};
                      const open = strat.books.some(([b]) => !ex[b]);
                      const walls = strat.key === "dc_muros"
                        ? `${fmtNum(num(t.put_wall), 0)} / ${fmtNum(num(t.call_wall), 0)}`
                        : t.mvs_abs != null ? fmtNum(num(t.mvs_abs), 0) : "—";
                      return (
                        <tr key={t.id}>
                          <td>{fmtNY(t.entry_ts)}</td>
                          <td style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{legsText(t.legs)}</td>
                          <td style={th}>{fmtNum(num(t.spx_entry), 0)}</td>
                          <td style={th}>{t.debit == null ? "—" : fmtMoney(num(t.debit) * 100)}</td>
                          <td style={th}>{fmtMoney(num(t.max_loss))}</td>
                          <td style={th}>{fmtMoney(num(t.max_profit))}</td>
                          <td style={th}>{walls}</td>
                          <td>{t.trend || "—"}</td>
                          <td style={{ ...th, color: signColor(open && lm ? num(lm.pnl) : null) }}>{open && lm ? fmtSigned(num(lm.pnl)) : "—"}</td>
                          {strat.books.map(([b]) => {
                            const x = ex[b];
                            return (
                              <td key={b} style={{ ...th, color: signColor(x ? num(x.pnl) : null) }}>
                                {x ? `${fmtSigned(num(x.pnl))} · ${REASONS[x.reason] || x.reason || ""}` : "abierto"}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {subtab === "reglas" && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Reglas comunes</div></div>
          <div className="table-wrap">
            <table>
              <tbody>
                {COMMON_RULES.map(([k, v]) => (
                  <tr key={k}><td style={{ whiteSpace: "nowrap", verticalAlign: "top", fontWeight: 600 }}>{k}</td><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
