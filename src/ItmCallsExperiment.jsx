import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

// Experimento de calls muy en el dinero: cartera TEÓRICA de 100.000 $ con las mismas empresas y pesos
// que la cartera de acciones, pero tomando la exposición con calls ITM (delta 0,85-0,92) cuando la
// cadena pasa los filtros. La caja que no hace falta para las primas va a XFFE.
// Las operaciones se registran en la base de datos; esta vista solo lee y calcula.
//
// Convenciones de las tablas itmexp_*:
//   kind = 'call' (qty = contratos, precios por acción, ×100) o 'acciones' (qty = acciones).
//   mark = último precio conocido de una posición abierta (si falta, se usa el de entrada).

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
const fmtLongDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const signColor = (n) => (n == null || Number.isNaN(n) || n === 0 ? "var(--muted)" : n > 0 ? "var(--gain)" : "var(--loss)");
const daysTo = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);

const RULES = [
  ["Empresas y pesos", "Los mismos que la cartera de acciones, con su revisión mensual. Si la tesis cambia tras resultados, se sale igual que en acciones. Sin apalancamiento: se compran tantos contratos como acciones tendría la cartera."],
  ["Vencimiento", "Mensual a 4-8 meses."],
  ["Strike", "El que dé una delta entre 0,85 y 0,92."],
  ["Liquidez", "Horquilla compra-venta ≤ 1% del precio de la acción e interés abierto ≥ 25."],
  ["Coste neto", "Valor extrínseco − rendimiento de XFFE sobre strike × tiempo + dividendos que se pierden ≤ 2% del precio de la acción."],
  ["Si no pasa", "La empresa se tiene en acciones dentro del mismo libro."],
  ["Ejecución", "Precio medio ± ¼ de la horquilla y 0,65 $ por contrato."],
  ["Renovación", "En la revisión mensual, cuando queden menos de 60 días al vencimiento."],
  ["Liquidez sobrante", "En XFFE, dejando un 2% en efectivo."],
];

export default function ItmCallsExperiment({ session }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [positions, setPositions] = useState([]);
  const [cash, setCash] = useState([]);
  const [prices, setPrices] = useState([]);
  const [log, setLog] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const uid = session.user.id;
      const [c, p, k, pr, l] = await Promise.all([
        supabase.from("itmexp_config").select("*").eq("user_id", uid).maybeSingle(),
        supabase.from("itmexp_positions").select("*").eq("user_id", uid).order("entry_date"),
        supabase.from("itmexp_cash").select("*").eq("user_id", uid).order("trade_date"),
        supabase.from("itmexp_prices").select("*").eq("user_id", uid),
        supabase.from("itmexp_log").select("*").eq("user_id", uid).order("date", { ascending: false }).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const err = [c, p, k, pr, l].find((r) => r.error);
      if (err) setError(err.error.message);
      setConfig(c.data);
      setPositions(p.data || []);
      setCash(k.data || []);
      setPrices(pr.data || []);
      setLog(l.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.user.id]);

  const calc = useMemo(() => {
    if (!config) return null;
    const capital = num(config.start_capital);
    const fee = num(config.commission_per_contract) || 0;
    const mult = (p) => (p.kind === "call" ? 100 : 1);
    let spent = 0, value = 0, realized = 0;
    const open = [], closed = [];
    for (const p of positions) {
      const m = mult(p), q = num(p.qty);
      const cost = num(p.entry_price) * q * m + (num(p.commissions_entry) || 0);
      spent += cost;
      if (p.exit_date) {
        const proceeds = num(p.exit_price) * q * m - (num(p.commissions_exit) || 0);
        spent -= proceeds;
        realized += proceeds - cost;
        closed.push({ ...p, pnl: proceeds - cost });
      } else {
        const mark = num(p.mark) ?? num(p.entry_price);
        const v = mark * q * m;
        value += v;
        open.push({ ...p, markNow: mark, value: v, pnl: v - cost });
      }
    }
    // XFFE
    const etf = config.cash_etf || "XFFE";
    let etfQty = 0;
    for (const t of cash) {
      if (t.qty == null || t.price == null) continue;
      const q = num(t.qty), px = num(t.price);
      if (t.kind === "compra") { etfQty += q; spent += q * px; }
      else { etfQty -= q; spent -= q * px; }
    }
    const etfPrice = num(prices.find((x) => x.ticker === etf)?.price);
    const etfValue = etfPrice != null ? etfQty * etfPrice : 0;
    const liquid = capital - spent;
    const total = liquid + value + etfValue;
    return { capital, fee, open, closed, realized, value, etf, etfQty, etfValue, liquid, total, ret: (total / capital - 1) * 100 };
  }, [config, positions, cash, prices]);

  if (loading) return <div className="panel"><div className="empty">Cargando experimento de calls ITM…</div></div>;
  if (!config) {
    return (
      <div className="panel">
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="empty">Todavía no hay ningún experimento de calls ITM configurado.</div>
      </div>
    );
  }

  const days = daysTo(config.start_date);
  const notStarted = days > 0 || positions.length === 0;
  const th = { textAlign: "right" };

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="eyebrow">EXPERIMENTO · CALLS MUY EN EL DINERO</div>
        <div className="h1">¿Mejoran las calls ITM a tener las acciones?</div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Cartera teórica de {fmtMoney(calc.capital, 0)} con las mismas empresas y pesos que la cartera de acciones.
          Donde la cadena de opciones pasa los filtros, la exposición se toma con calls de delta 0,85-0,92 y el dinero
          que no hace falta va a {calc.etf}. Se compara con la cartera de acciones, el S&P 500 y el QQQ.
        </div>
      </div>

      {notStarted ? (
        <div className="panel">
          <div className="card-label">Estado</div>
          <div className="card-value big" style={{ marginTop: 4 }}>
            {days > 0 ? `Arranca el ${fmtDate(config.start_date)}` : "Pendiente de la primera revisión"}
          </div>
          <div className="card-sub" style={{ marginTop: 6 }}>
            {days > 0
              ? <>Empieza en la revisión del {fmtLongDate(config.start_date)}, dentro de {days} {days === 1 ? "día" : "días"}, con {fmtMoney(calc.capital, 0)}. </>
              : <>La revisión de arranque todavía no ha registrado posiciones. </>}
            Ese día se leen las cadenas de todas las empresas de la cartera, se decide cuáles van en calls y cuáles en
            acciones, y las entradas se anotan con los precios de la sesión siguiente.
          </div>
        </div>
      ) : (
        <div className="cards">
          <div className="card">
            <div className="card-label">Valor de la cartera</div>
            <div className="card-value big" style={{ color: signColor(calc.ret) }}>{fmtPct(calc.ret, 2)}</div>
            <div className="card-sub">{fmtMoney(calc.total)} · desde el {fmtDate(config.start_date)}</div>
          </div>
          <div className="card">
            <div className="card-label">Posiciones</div>
            <div className="card-value big">{fmtMoney(calc.value, 0)}</div>
            <div className="card-sub">{calc.open.filter((p) => p.kind === "call").length} en calls · {calc.open.filter((p) => p.kind === "acciones").length} en acciones · cerrado {fmtSigned(calc.realized)}</div>
          </div>
          <div className="card">
            <div className="card-label">{calc.etf} y efectivo</div>
            <div className="card-value big">{fmtMoney(calc.etfValue + calc.liquid, 0)}</div>
            <div className="card-sub">{calc.etf} {fmtMoney(calc.etfValue, 0)} · efectivo {fmtMoney(calc.liquid, 0)}</div>
          </div>
        </div>
      )}

      {calc.open.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Posiciones abiertas ({calc.open.length})</div></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>Instrumento</th>
                  <th style={th}>Cantidad</th>
                  <th style={th}>Entrada</th>
                  <th style={th}>Ahora</th>
                  <th style={th}>Delta</th>
                  <th style={th}>Coste neto</th>
                  <th style={th}>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {calc.open.map((p) => (
                  <tr key={p.id}>
                    <td><span className="mono" style={{ fontWeight: 600 }}>{p.ticker}</span> <span style={{ color: "var(--muted)", fontSize: 13 }}>{p.name}</span></td>
                    <td>{p.kind === "call" ? `Call ${fmtNum(num(p.strike), 0)} · ${fmtDate(p.expiry)} (${daysTo(p.expiry)} d)` : "Acciones"}</td>
                    <td style={th}>{fmtNum(num(p.qty), 0)}{p.kind === "call" ? " ctr." : ""}</td>
                    <td style={th}>{fmtMoney(num(p.entry_price))}</td>
                    <td style={th}>{fmtMoney(p.markNow)}</td>
                    <td style={th}>{p.delta_entry != null ? fmtNum(num(p.delta_entry), 2) : "—"}</td>
                    <td style={th}>{p.net_cost_pct != null ? `${fmtNum(num(p.net_cost_pct), 2)}%` : "—"}</td>
                    <td style={{ ...th, color: signColor(p.pnl) }}>{fmtSigned(p.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Reglas</div></div>
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
      </div>

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
