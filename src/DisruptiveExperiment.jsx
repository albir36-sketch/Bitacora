import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

// Experimento de empresas disruptivas: cartera TEÓRICA de 10 empresas a 1.000 $ cada una,
// pequeñas o medianas con un modelo de negocio disruptivo, que se mantienen hasta que se rompe la tesis.
// Se compara con SPY, QQQ, ARKK y con un banquillo de control (candidatas no elegidas, sin dinero).
// Las operaciones se registran en la base de datos; esta vista solo lee y calcula.
//
// Convenciones de las tablas disexp_*:
//   disexp_positions.book = 'cartera' (cuenta) o 'banquillo' (control, mismo importe por empresa).
//   exit_type = 'automatica' | 'revision' | 'opa'.
//   disexp_checks: una fila por empresa y presentación de resultados (trigger + decisión).
//   disexp_prices: último precio de cada ticker, incluidos SPY, QQQ y ARKK.

const num = (v) => (v == null ? null : Number(v));
const fmtMoney = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? "—" : `${n.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })} $`;
const fmtSigned = (n, digits = 2) => (n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n, digits)}`);
const fmtPct = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : `${n > 0 ? "+" : ""}${n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const daysTo = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);

const STRUCTURE = [
  ["Cartera", "10 empresas a 1.000 $ teóricos cada una (10.000 $). No se recortan las que suben ni se añade a las que caen."],
  ["Banquillo de control", "Candidatas que no entraron, seguidas sin dinero a 1.000 $ cada una, para medir si la elección aporta algo."],
  ["Venta", "El dinero queda en liquidez hasta la siguiente revisión trimestral; entonces se repone con una empresa del banquillo que siga cumpliendo los criterios."],
  ["Grandes cambios", "Máximo 2 empresas por cambio."],
  ["Precios", "Apertura de la sesión siguiente a la decisión, sin comisiones; los dividendos van a la liquidez."],
  ["Horizonte", "Se juzga a 5 años. Caídas del 40-50 % por el camino serán normales."],
];

const CRITERIA = [
  ["Enfoque", "Primero la tesis: las mejores empresas, las más disruptivas en cómo consiguen sus objetivos, de cada gran cambio de los próximos 10-20 años. Los números solo sirven para sobrevivir."],
  ["Grandes cambios", "Infraestructura de IA · robótica y automatización · espacio · computación cuántica · diagnóstico y medicina genética · energía nuclear y almacenamiento · vehículos autónomos y aéreos · dinero digital."],
  ["Capitalización", "Sin límite. Se excluyen las que ya están entre las mayores del mundo (Nvidia, Tesla, SpaceX…)."],
  ["Supervivencia", "Caja para al menos 2 años al ritmo actual de quema, o flujo de caja positivo. Liquidez suficiente. Al menos 1 año cotizando."],
  ["Valoración", "Precio/ventas < 25x solo al comprar y solo para empresas consolidadas. A las que están empezando no se les aplica."],
  ["Sin filtros de", "Crecimiento ni margen: dejaban fuera justo a las disruptivas."],
];

const SELL_AUTO = [
  "Dilución de más del 25 % en 12 meses.",
  "Caja para menos de 12 meses sin flujo de caja positivo.",
  "Opa o adquisición: se vende al precio de la operación.",
  "En empresas con ventas consolidadas, crecimiento por debajo del 15 % durante 4 trimestres seguidos.",
];
const SELL_REVIEW = [
  "Dilución de entre el 10 % y el 25 % en 12 meses.",
  "Crecimiento de ventas por debajo del 15 % dos trimestres seguidos.",
  "Margen bruto que cae más de 5 puntos en un año.",
  "Salida del fundador o del CEO.",
  "Cualquier condición escrita en la tesis de la empresa.",
];

const BENCH = ["SPY", "QQQ", "ARKK"];

function bookStats(rows, priceOf, dividends) {
  let cost = 0, value = 0, proceeds = 0, divs = 0;
  const open = [], closed = [];
  for (const p of rows) {
    const q = num(p.qty), c = q * num(p.entry_price);
    cost += c;
    for (const d of dividends) {
      if (d.ticker !== p.ticker || d.ex_date <= p.entry_date) continue;
      if (p.exit_date && d.ex_date > p.exit_date) continue;
      divs += q * num(d.amount);
    }
    if (p.exit_date) {
      const pr = q * num(p.exit_price);
      proceeds += pr;
      closed.push({ ...p, pnl: pr - c, ret: (num(p.exit_price) / num(p.entry_price) - 1) * 100 });
    } else {
      const px = priceOf(p.ticker) ?? num(p.entry_price);
      value += q * px;
      open.push({ ...p, now: px, value: q * px, pnl: q * px - c, ret: (px / num(p.entry_price) - 1) * 100 });
    }
  }
  return { cost, value, proceeds, divs, open, closed };
}

export default function DisruptiveExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [positions, setPositions] = useState([]);
  const [checks, setChecks] = useState([]);
  const [prices, setPrices] = useState([]);
  const [dividends, setDividends] = useState([]);
  const [log, setLog] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const res = await Promise.all([
        supabase.from("disexp_config").select("*").eq("user_id", uid).maybeSingle(),
        supabase.from("disexp_positions").select("*").eq("user_id", uid).order("entry_date"),
        supabase.from("disexp_checks").select("*").eq("user_id", uid).order("date", { ascending: false }),
        supabase.from("disexp_prices").select("*").eq("user_id", uid),
        supabase.from("disexp_dividends").select("*").eq("user_id", uid),
        supabase.from("disexp_log").select("*").eq("user_id", uid).order("date", { ascending: false }).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const err = res.find((r) => r.error);
      if (err) setError(err.error.message);
      const [c, p, k, pr, dv, l] = res;
      setConfig(c.data);
      setPositions(p.data || []);
      setChecks(k.data || []);
      setPrices(pr.data || []);
      setDividends(dv.data || []);
      setLog(l.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.user.id]);

  const calc = useMemo(() => {
    if (!config) return null;
    const priceOf = (t) => num(prices.find((x) => x.ticker === t)?.price);
    const capital = num(config.start_capital);
    const main = bookStats(positions.filter((p) => p.book === "cartera"), priceOf, dividends);
    const bench = bookStats(positions.filter((p) => p.book === "banquillo"), priceOf, dividends);
    const liquid = capital - main.cost + main.proceeds + main.divs;
    const total = liquid + main.value;
    const benchRet = bench.cost > 0 ? ((bench.value + bench.proceeds + bench.divs) / bench.cost - 1) * 100 : null;
    const idx = Object.fromEntries(BENCH.map((t) => {
      const start = num(config[`${t.toLowerCase()}_start`]), now = priceOf(t);
      return [t, start && now ? (now / start - 1) * 100 : null];
    }));
    return { capital, main, bench, liquid, total, ret: (total / capital - 1) * 100, benchRet, idx };
  }, [config, positions, prices, dividends]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento de empresas disruptivas…</div></div>;
  if (!config) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de empresas disruptivas configurado.</div>
      </div>
    );
  }

  const started = positions.some((p) => p.book === "cartera");
  const reviewDays = config.next_review ? daysTo(config.next_review) : null;
  const th = { textAlign: "right" };
  const lastCheck = (id) => checks.find((c) => c.position_id === id);

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO · EMPRESAS DISRUPTIVAS</div>
        <div className="h1">¿Encontramos la próxima Google, Meta o Nvidia?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica de {fmtMoney(calc.capital, 0)}: {config.n_positions} empresas de los grandes cambios de los próximos 10-20 años, las más
          disruptivas de cada uno, a {fmtMoney(num(config.position_size), 0)} cada una, que se mantienen hasta que se rompe su tesis.
          Nunca se vende por precio. Se compara con SPY, QQQ, ARKK y un banquillo de control.
        </div>
      </div>

      {!started ? (
        <div className="panel">
          <div className="card-label">Estado</div>
          <div className="card-value big" style={{ marginTop: 4 }}>
            {config.pending_selection
              ? `Selección cerrada · entradas con la apertura del ${fmtDate(config.pending_selection.entry_date)}`
              : reviewDays != null && reviewDays >= 0
                ? `Selección el ${fmtDate(config.next_review)}`
                : "Pendiente de la selección"}
          </div>
          {config.pending_selection && [["cartera", "Cartera"], ["banquillo", "Banquillo de control"]].map(([k, t]) => (
            <div key={k} style={{ marginTop: 14 }}>
              <div className="card-label">{t}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {config.pending_selection.positions.filter((p) => p.book === k).map((p) => (
                  <span key={p.ticker} title={`${p.sector}${p.thesis ? `\n\n${p.thesis}` : ""}`} style={{ fontSize: 13, padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 6 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{p.ticker}</span> <span style={{ color: "var(--muted)" }}>{p.name}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="cards">
          <div className="card">
            <div className="card-label">Cartera</div>
            <div className="card-value big" style={{ color: signColor(calc.ret) }}>{fmtPct(calc.ret, 2)}</div>
            <div className="card-sub">{fmtMoney(calc.total)} · desde el {fmtDate(config.start_date)}</div>
          </div>
          <div className="card">
            <div className="card-label">Banquillo de control</div>
            <div className="card-value big" style={{ color: signColor(calc.benchRet) }}>{fmtPct(calc.benchRet, 2)}</div>
            <div className="card-sub">{calc.bench.open.length} empresas a partes iguales, sin dinero</div>
          </div>
          <div className="card">
            <div className="card-label">Índices</div>
            <div className="card-value" style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "2px 12px", justifyContent: "start" }}>
              {BENCH.map((t) => [<span key={t} className="mono">{t}</span>, <span key={t + "v"} style={{ color: signColor(calc.idx[t]) }}>{fmtPct(calc.idx[t], 1)}</span>])}
            </div>
            <div className="card-sub">Liquidez {fmtMoney(calc.liquid, 0)} · cerrado {fmtSigned(calc.main.closed.reduce((s, p) => s + p.pnl, 0))}</div>
          </div>
        </div>
      )}

      {[["cartera", "Cartera", calc.main], ["banquillo", "Banquillo de control", calc.bench]].map(([key, title, st]) =>
        st.open.length > 0 && (
          <div className="panel" key={key}>
            <div className="panel-head"><div className="panel-title">{title} ({st.open.length})</div></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Cambio</th>
                    <th style={th}>Entrada</th>
                    <th style={th}>Ahora</th>
                    <th style={th}>Resultado</th>
                    <th>Última comprobación</th>
                  </tr>
                </thead>
                <tbody>
                  {st.open.map((p) => {
                    const lc = lastCheck(p.id);
                    return (
                      <tr key={p.id} title={[p.thesis, p.sell_conditions && `Venta: ${p.sell_conditions}`].filter(Boolean).join("\n\n")}>
                        <td><span className="mono" style={{ fontWeight: 600 }}>{p.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{p.name}</span></td>
                        <td>{p.sector || "—"}</td>
                        <td style={th}>{fmtMoney(num(p.entry_price))} · {fmtDate(p.entry_date)}</td>
                        <td style={th}>{fmtMoney(p.now)}</td>
                        <td style={{ ...th, color: signColor(p.ret) }}>{fmtPct(p.ret, 1)}</td>
                        <td>{lc ? `${fmtDate(lc.date)} · ${lc.trigger === "ninguna" ? "sin alarmas" : lc.trigger === "revision" ? `revisión → ${lc.decision}` : "venta automática"}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {calc.main.closed.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Vendidas ({calc.main.closed.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Empresa</th><th>Salida</th><th>Tipo</th><th style={th}>Resultado</th><th>Motivo</th></tr></thead>
              <tbody>
                {calc.main.closed.map((p) => (
                  <tr key={p.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{p.ticker}</td>
                    <td>{fmtDate(p.exit_date)}</td>
                    <td>{p.exit_type === "automatica" ? "Automática" : p.exit_type === "opa" ? "Opa" : "Revisión"}</td>
                    <td style={{ ...th, color: signColor(p.ret) }}>{fmtPct(p.ret, 1)}</td>
                    <td>{p.exit_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Motivos de venta</div></div>
        <div className="card-sub">Se comprueban tras cada presentación de resultados, cifra a cifra contra la tesis. Nunca se vende por precio.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 12 }}>
          <div>
            <div className="card-label">Venta automática</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{SELL_AUTO.map((s) => <li key={s} style={{ marginBottom: 4 }}>{s}</li>)}</ul>
          </div>
          <div>
            <div className="card-label">Revisión obligatoria (decide Rafa y lo deja por escrito)</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{SELL_REVIEW.map((s) => <li key={s} style={{ marginBottom: 4 }}>{s}</li>)}</ul>
          </div>
        </div>
        <div className="card-sub" style={{ marginTop: 10 }}>
          Por qué dos niveles: una regla automática de crecimiento habría vendido Nvidia en 2019 y Meta en 2022, en baches temporales.
        </div>
      </div>

      {[["Estructura", STRUCTURE], ["Criterios de selección", CRITERIA]].map(([title, rows]) => (
        <div className="panel" key={title}>
          <div className="panel-head"><div className="panel-title">{title}</div></div>
          <div className="table-wrap">
            <table>
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontWeight: 600, whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Diario</div></div>
        {log.length === 0 ? (
          <div className="empty">Sin anotaciones todavía.</div>
        ) : (
          log.map((e) => (
            <div key={e.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
              <div className="card-label">{fmtDate(e.date)} · {e.kind}{e.ticker ? ` · ${e.ticker}` : ""}</div>
              <div style={{ marginTop: 2 }}>{e.note}</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
