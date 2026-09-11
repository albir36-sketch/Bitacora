import { useEffect, useMemo, useState } from "react";
import { Plus, X, Trash2, ArrowLeft, RefreshCw } from "lucide-react";
import { supabase } from "./supabaseClient";

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_API_KEY;

async function fetchQuote(ticker) {
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`Error al consultar ${ticker}`);
  const data = await res.json();
  if (data.c == null || data.c === 0) throw new Error(`Sin datos para ${ticker}`);
  return data.c;
}

const fmtNum = (n, digits = 2) => {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const fmtPct = (n, digits = 2) => (n == null || Number.isNaN(n)) ? "—" : `${n.toFixed(digits)}%`;

// ---------- fórmulas (verificadas contra la hoja de referencia del usuario) ----------
function computeYearRatios(y) {
  const ac = y.current_assets || 0, anc = y.non_current_assets || 0;
  const pc = y.current_liabilities || 0, pnc = y.non_current_liabilities || 0;
  const intang = y.intangibles || 0, shares = y.shares || 0;
  const profit = y.profit ?? 0, ebit = y.ebit;
  // La capitalización se calcula, no se guarda directamente: acciones × cotización de cierre de
  // ese año fiscal (normalmente 31 de diciembre) — o, para "AHORA", acciones × precio en vivo.
  const cap = (shares && y.year_end_price != null) ? shares * y.year_end_price
    : (y.market_cap != null ? y.market_cap : null); // market_cap: solo para la columna "AHORA" (precio en vivo)

  const fondoManiobra = pc ? ac / pc : null;
  const pctDeuda = (ac + anc) ? ((pc + pnc) / (ac + anc)) * 100 : null;
  const acMenosPasivos = ac - pc - pnc;
  const valorContableSin = shares ? (ac + anc - pc - pnc - intang) / shares : null;
  const valorContableCon = shares ? (ac + anc - pc - pnc) / shares : null;
  const per = (cap != null && profit) ? cap / profit : null;
  const cotizacionPER10 = shares ? (profit / shares) * 10 : null;
  const nwc = ac - pc;
  const netFixedAssets = anc - intang;
  const roc = (ebit != null && (nwc + netFixedAssets) !== 0) ? (ebit / (nwc + netFixedAssets)) * 100 : null;
  const ev = (cap != null) ? cap + pc + pnc - ac : null;
  const earningsYield = (ebit != null && ev) ? (ebit / ev) * 100 : null;
  const medias = (roc != null && earningsYield != null) ? (roc + earningsYield) / 2 : null;

  return { cap, fondoManiobra, pctDeuda, acMenosPasivos, valorContableSin, valorContableCon, per, cotizacionPER10, roc, earningsYield, medias };
}

// ---------- criterios de cribado por "estilo de inversor" ----------
// Cada función recibe los años ordenados (asc) + los ratios del último año + del precio actual
// ("ahora"), y devuelve una lista de comprobaciones {label, pass, detail}.
const INVESTORS = [
  { id: "graham", label: "Benjamin Graham (inversor defensivo)" },
  { id: "greenblatt", label: "Joel Greenblatt (Fórmula Mágica)" },
  { id: "piotroski", label: "Piotroski (F-Score simplificado)" },
  { id: "buffett", label: "Warren Buffett (calidad + poca deuda)" },
];

function evaluateGraham(years, nowRatios, livePrice) {
  if (years.length === 0) return [];
  const last = years[years.length - 1];
  const lastR = computeYearRatios(last);
  const checks = [];
  checks.push({ label: "Ratio corriente ≥ 2", pass: lastR.fondoManiobra != null && lastR.fondoManiobra >= 2, detail: fmtNum(lastR.fondoManiobra, 2) });
  const allProfitable = years.every((y) => (y.profit ?? 0) > 0);
  checks.push({ label: `Beneficio positivo todos los años (${years.length})`, pass: allProfitable, detail: allProfitable ? "sí" : "no" });
  const capitalCirculante = (last.current_assets || 0) - (last.current_liabilities || 0);
  const deudaOk = (last.non_current_liabilities || 0) < capitalCirculante;
  checks.push({ label: "Deuda largo plazo < capital circulante", pass: deudaOk, detail: `${fmtNum(last.non_current_liabilities || 0, 0)} vs ${fmtNum(capitalCirculante, 0)}` });
  const per = nowRatios?.per ?? lastR.per;
  checks.push({ label: "PER ≤ 15", pass: per != null && per > 0 && per <= 15, detail: fmtNum(per, 2) });
  const pb = (livePrice != null && lastR.valorContableCon) ? livePrice / lastR.valorContableCon : null;
  const grahamNumber = (per != null && pb != null) ? per * pb : null;
  checks.push({ label: "PER × P/VC ≤ 22.5 (Número de Graham)", pass: grahamNumber != null && grahamNumber > 0 && grahamNumber <= 22.5, detail: fmtNum(grahamNumber, 1) });
  checks.push({ label: "Paga dividendo", pass: (last.dividend_per_share || 0) > 0, detail: fmtNum(last.dividend_per_share || 0, 2) });
  return checks;
}

function evaluateGreenblatt(years, nowRatios) {
  if (years.length === 0) return [];
  const r = nowRatios ?? computeYearRatios(years[years.length - 1]);
  return [
    { label: "ROC ≥ 15%", pass: r.roc != null && r.roc >= 15, detail: fmtPct(r.roc, 1) },
    { label: "Earnings Yield ≥ 5%", pass: r.earningsYield != null && r.earningsYield >= 5, detail: fmtPct(r.earningsYield, 1) },
  ];
}

function evaluatePiotroski(years) {
  if (years.length < 2) return [{ label: "Hacen falta al menos 2 años guardados", pass: false, detail: "—" }];
  const y1 = years[years.length - 2], y2 = years[years.length - 1]; // año anterior, último año
  const totalAssets2 = (y2.current_assets || 0) + (y2.non_current_assets || 0);
  const roa = totalAssets2 ? (y2.profit || 0) / totalAssets2 : null;
  const r1 = computeYearRatios(y1), r2 = computeYearRatios(y2);
  const checks = [
    { label: "ROA positivo", pass: roa != null && roa > 0, detail: fmtPct((roa || 0) * 100, 1) },
    { label: "Beneficio mejora vs año anterior", pass: (y2.profit || 0) > (y1.profit || 0), detail: `${fmtNum(y1.profit || 0, 0)} → ${fmtNum(y2.profit || 0, 0)}` },
    { label: "Ratio corriente mejora", pass: (r2.fondoManiobra || 0) > (r1.fondoManiobra || 0), detail: `${fmtNum(r1.fondoManiobra, 2)} → ${fmtNum(r2.fondoManiobra, 2)}` },
    { label: "% deuda sobre activos baja", pass: (r2.pctDeuda ?? 100) < (r1.pctDeuda ?? 100), detail: `${fmtNum(r1.pctDeuda, 1)}% → ${fmtNum(r2.pctDeuda, 1)}%` },
    { label: "No hay dilución (nº acciones no sube)", pass: (y2.shares || 0) <= (y1.shares || 0), detail: `${fmtNum(y1.shares || 0, 0)} → ${fmtNum(y2.shares || 0, 0)}` },
    { label: "Beneficio por acción mejora", pass: (y1.shares && y2.shares) ? (y2.profit / y2.shares) > (y1.profit / y1.shares) : false, detail: "" },
  ];
  return checks;
}

function evaluateBuffett(years, nowRatios) {
  if (years.length === 0) return [];
  const last = years[years.length - 1];
  const r = nowRatios ?? computeYearRatios(last);
  const equity = (last.current_assets || 0) + (last.non_current_assets || 0) - (last.current_liabilities || 0) - (last.non_current_liabilities || 0);
  const roe = equity ? ((last.profit || 0) / equity) * 100 : null;
  const profitGrowing = years.length >= 3 ? (last.profit || 0) > (years[0].profit || 0) : null;
  return [
    { label: "ROE ≥ 15%", pass: roe != null && roe >= 15, detail: fmtPct(roe, 1) },
    { label: "% deuda sobre activos < 40%", pass: r.pctDeuda != null && r.pctDeuda < 40, detail: fmtPct(r.pctDeuda, 1) },
    { label: `Beneficio creciente (vs ${years[0]?.year ?? "—"})`, pass: profitGrowing === true, detail: profitGrowing == null ? "faltan años" : (profitGrowing ? "sí" : "no") },
  ];
}

function evaluateInvestor(investorId, years, nowRatios, livePrice) {
  switch (investorId) {
    case "graham": return evaluateGraham(years, nowRatios, livePrice);
    case "greenblatt": return evaluateGreenblatt(years, nowRatios);
    case "piotroski": return evaluatePiotroski(years);
    case "buffett": return evaluateBuffett(years, nowRatios);
    default: return [];
  }
}

export default function Analysis({ session }) {
  const userId = session.user.id;
  const [companies, setCompanies] = useState([]);
  const [years, setYears] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [investorFilter, setInvestorFilter] = useState("");
  const [allYears, setAllYears] = useState({}); // companyId -> [años]
  const [allPrices, setAllPrices] = useState({}); // companyId -> precio en vivo
  const [screeningLoading, setScreeningLoading] = useState(false);
  const [livePrice, setLivePrice] = useState(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [showAddCompany, setShowAddCompany] = useState(false);
  const [showAddYear, setShowAddYear] = useState(false);
  const [editingCompany, setEditingCompany] = useState(false);

  useEffect(() => { loadCompanies(); }, []);
  useEffect(() => { if (selectedId) { loadYears(selectedId); setLivePrice(null); } }, [selectedId]);

  async function loadCompanies() {
    setLoading(true);
    setError("");
    const { data, error: err } = await supabase.from("company_analysis").select("*").order("ticker");
    if (err) setError(err.message);
    setCompanies(data || []);
    setLoading(false);
  }

  async function loadYears(companyId) {
    const { data, error: err } = await supabase.from("company_analysis_years").select("*").eq("company_id", companyId).order("year");
    if (err) setError(err.message);
    setYears(data || []);
  }

  // Carga TODOS los años de TODAS las empresas de una vez (hace falta para poder cribar).
  async function loadAllYearsForScreening() {
    setScreeningLoading(true);
    const { data, error: err } = await supabase.from("company_analysis_years").select("*").order("year");
    if (err) { setError(err.message); setScreeningLoading(false); return; }
    const grouped = {};
    for (const row of data || []) {
      if (!grouped[row.company_id]) grouped[row.company_id] = [];
      grouped[row.company_id].push(row);
    }
    setAllYears(grouped);
    setScreeningLoading(false);
  }

  async function refreshAllPrices() {
    if (!FINNHUB_KEY) { setError("Falta configurar VITE_FINNHUB_API_KEY en Vercel."); return; }
    setScreeningLoading(true);
    const prices = {};
    for (const c of companies) {
      try { prices[c.id] = await fetchQuote(c.ticker); } catch (e) { /* se salta la que falle */ }
    }
    setAllPrices((prev) => ({ ...prev, ...prices }));
    setScreeningLoading(false);
  }

  const selected = companies.find((c) => c.id === selectedId);

  async function refreshPrice() {
    if (!selected) return;
    if (!FINNHUB_KEY) { setError("Falta configurar VITE_FINNHUB_API_KEY en Vercel para traer el precio en vivo."); return; }
    setPriceLoading(true);
    try {
      const p = await fetchQuote(selected.ticker);
      setLivePrice(p);
    } catch (e) {
      setError(e.message);
    }
    setPriceLoading(false);
  }

  async function addCompany(data) {
    setError("");
    const row = { user_id: userId, ticker: data.ticker.toUpperCase().trim(), company_name: data.company_name || null, currency: data.currency || "USD", target1: null, target2: null, sell1: null };
    const { data: inserted, error: err } = await supabase.from("company_analysis").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setCompanies((prev) => [...prev, inserted].sort((a, b) => a.ticker.localeCompare(b.ticker)));
    setSelectedId(inserted.id);
    setShowAddCompany(false);
  }

  async function deleteCompany(id) {
    if (!confirm("¿Borrar esta empresa y todos sus años guardados?")) return;
    await supabase.from("company_analysis_years").delete().eq("company_id", id);
    await supabase.from("company_analysis").delete().eq("id", id);
    setCompanies((prev) => prev.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function updateCompany(id, patch) {
    setError("");
    const { data: updated, error: err } = await supabase.from("company_analysis").update(patch).eq("id", id).select().single();
    if (err) { setError(err.message); return; }
    setCompanies((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }

  async function addYear(data) {
    setError("");
    const row = { user_id: userId, company_id: selectedId, ...data };
    const { data: inserted, error: err } = await supabase.from("company_analysis_years").insert(row).select().single();
    if (err) { setError(err.message); return; }
    setYears((prev) => [...prev, inserted].sort((a, b) => a.year - b.year));
    setShowAddYear(false);
  }

  async function deleteYear(id) {
    await supabase.from("company_analysis_years").delete().eq("id", id);
    setYears((prev) => prev.filter((y) => y.id !== id));
  }

  // ---------- columna "AHORA" ----------
  const latestYear = years.length > 0 ? years[years.length - 1] : null;
  const nowData = useMemo(() => {
    if (!latestYear) return null;
    const shares = latestYear.shares || 0;
    const price = livePrice;
    const cap = price != null ? shares * price : null;
    const profit = selected?.ttm_profit ?? latestYear.profit;
    const ebit = selected?.ttm_ebit ?? latestYear.ebit;
    return computeYearRatios({ ...latestYear, profit, ebit, year_end_price: null, market_cap: cap });
  }, [latestYear, livePrice, selected]);

  if (loading) return <div className="empty">Cargando análisis…</div>;

  return (
    <div className="panel">
      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}

      {!selected ? (
        <>
          <div className="panel-head">
            <div className="panel-title">Análisis de empresas</div>
            <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddCompany(true)}><Plus size={14} /> Nueva empresa</button>
          </div>

          {companies.length > 0 && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
              <div className="field" style={{ minWidth: 260 }}>
                <div className="field-label">Criba por criterios de inversor</div>
                <select
                  value={investorFilter}
                  onChange={(e) => { setInvestorFilter(e.target.value); if (e.target.value) loadAllYearsForScreening(); }}
                >
                  <option value="">— Ninguno (ver todas) —</option>
                  {INVESTORS.map((inv) => <option key={inv.id} value={inv.id}>{inv.label}</option>)}
                </select>
              </div>
              {investorFilter && (
                <button className="btn btn-ghost" style={{ padding: "8px 12px", fontSize: 13, marginTop: 18 }} onClick={refreshAllPrices} disabled={screeningLoading}>
                  <RefreshCw size={14} /> {screeningLoading ? "Actualizando…" : "Actualizar precios (todas)"}
                </button>
              )}
            </div>
          )}

          {companies.length === 0 ? <div className="empty">Aún no has añadido ninguna empresa</div> : !investorFilter ? (
            <div className="cards">
              {companies.map((c) => (
                <div key={c.id} className="card" style={{ cursor: "pointer" }} onClick={() => setSelectedId(c.id)}>
                  <div className="card-label">{c.ticker}</div>
                  <div className="card-value" style={{ fontSize: 16 }}>{c.company_name || "—"}</div>
                  <div className="card-sub">{c.currency}</div>
                </div>
              ))}
            </div>
          ) : (
            <ScreeningList
              companies={companies}
              allYears={allYears}
              allPrices={allPrices}
              investorFilter={investorFilter}
              onSelect={setSelectedId}
            />
          )}
        </>
      ) : (
        <>
          <div className="panel-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="icon-btn" style={{ color: "var(--muted)" }} onClick={() => setSelectedId(null)}><ArrowLeft size={18} /></button>
              <div>
                <div className="panel-title">{selected.ticker} {selected.company_name ? `— ${selected.company_name}` : ""}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={refreshPrice} disabled={priceLoading}>
                <RefreshCw size={14} /> {priceLoading ? "Buscando…" : "Precio en vivo"}
              </button>
              <button className="btn btn-gold" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setShowAddYear(true)}><Plus size={14} /> Año</button>
              <button className="icon-btn" style={{ color: "var(--loss)" }} onClick={() => deleteCompany(selected.id)}><Trash2 size={16} /></button>
            </div>
          </div>

          {/* objetivos */}
          <div className="cards" style={{ marginBottom: 18 }}>
            <TargetCard label="Precio ahora" value={livePrice} currency={selected.currency} editable={false} />
            <TargetCard label="Objetivo 1" value={selected.target1} currency={selected.currency} onSave={(v) => updateCompany(selected.id, { target1: v })} />
            <TargetCard label="Objetivo 2" value={selected.target2} currency={selected.currency} onSave={(v) => updateCompany(selected.id, { target2: v })} />
            <TargetCard label="Venta 1" value={selected.sell1} currency={selected.currency} onSave={(v) => updateCompany(selected.id, { sell1: v })} />
          </div>

          {years.length === 0 ? <div className="empty">Añade al menos un año para empezar a calcular los ratios</div> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Métrica</th>
                    {years.map((y) => <th key={y.id} className="mono">{y.year}</th>)}
                    <th className="mono" style={{ color: "var(--gold)" }}>AHORA</th>
                  </tr>
                </thead>
                <tbody>
                  <RawRow label="Nº acciones" years={years} field="shares" onDelete={deleteYear} />
                  <RawRow label="Activo corriente" years={years} field="current_assets" onDelete={deleteYear} />
                  <RawRow label="Activo no corriente" years={years} field="non_current_assets" onDelete={deleteYear} />
                  <RawRow label="Pasivo corriente" years={years} field="current_liabilities" onDelete={deleteYear} />
                  <RawRow label="Pasivo no corriente" years={years} field="non_current_liabilities" onDelete={deleteYear} />
                  <RawRow label="Intangibles" years={years} field="intangibles" onDelete={deleteYear} />
                  <RawRow label="Beneficio" years={years} field="profit" onDelete={deleteYear} />
                  <RawRow label="Dividendo/acción" years={years} field="dividend_per_share" decimals={2} onDelete={deleteYear} />
                  <RawRow label="EBIT" years={years} field="ebit" onDelete={deleteYear} />
                  <RawRow label="Cotización cierre de año" years={years} field="year_end_price" decimals={2} onDelete={deleteYear} nowValue={livePrice} />
                  <ComputedRow label="Capitalización" years={years} calcKey="cap" nowData={nowData} decimals={0} />
                  <ComputedRow label="AC−(PC+PNC)" years={years} calcKey="acMenosPasivos" nowData={nowData} />
                  <ComputedRow label="Fondo de maniobra" years={years} calcKey="fondoManiobra" nowData={nowData} decimals={2} />
                  <ComputedRow label="% Deuda sobre activos" years={years} calcKey="pctDeuda" nowData={nowData} isPct />
                  <ComputedRow label="Valor contable (sin intang.)" years={years} calcKey="valorContableSin" nowData={nowData} decimals={2} />
                  <ComputedRow label="Valor contable CON intang." years={years} calcKey="valorContableCon" nowData={nowData} decimals={2} />
                  <ComputedRow label="PER" years={years} calcKey="per" nowData={nowData} decimals={2} />
                  <ComputedRow label="Cotización PER 10" years={years} calcKey="cotizacionPER10" nowData={nowData} decimals={2} />
                  <ComputedRow label="ROC (Fórmula Mágica)" years={years} calcKey="roc" nowData={nowData} isPct highlight />
                  <ComputedRow label="Earnings Yield (Fórmula Mágica)" years={years} calcKey="earningsYield" nowData={nowData} isPct highlight />
                  <ComputedRow label="Media (Fórmula Mágica)" years={years} calcKey="medias" nowData={nowData} isPct highlight bold />
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginTop: 16, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <TTMField label="Beneficio actual (TTM, opcional)" value={selected.ttm_profit} onSave={(v) => updateCompany(selected.id, { ttm_profit: v })} />
            <TTMField label="EBIT actual (TTM, opcional)" value={selected.ttm_ebit} onSave={(v) => updateCompany(selected.id, { ttm_ebit: v })} />
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
            Si rellenas el Beneficio/EBIT "actual (TTM)", la columna AHORA los usa en vez de los del último año guardado — útil si tienes un dato más reciente que el del último ejercicio cerrado.
          </div>
        </>
      )}

      {showAddCompany && <AddCompanyModal onCancel={() => setShowAddCompany(false)} onSave={addCompany} />}
      {showAddYear && <AddYearModal onCancel={() => setShowAddYear(false)} onSave={addYear} existingYears={years.map((y) => y.year)} />}
    </div>
  );
}

function ScreeningList({ companies, allYears, allPrices, investorFilter, onSelect }) {
  const results = useMemo(() => {
    return companies.map((c) => {
      const years = (allYears[c.id] || []).slice().sort((a, b) => a.year - b.year);
      const livePrice = allPrices[c.id];
      const lastYear = years[years.length - 1];
      let nowRatios = null;
      if (lastYear) {
        const shares = lastYear.shares || 0;
        const cap = livePrice != null ? shares * livePrice : null;
        nowRatios = computeYearRatios({ ...lastYear, year_end_price: null, market_cap: cap });
      }
      const checks = evaluateInvestor(investorFilter, years, nowRatios, livePrice);
      const passed = checks.filter((ch) => ch.pass).length;
      return { company: c, checks, passed, total: checks.length, nowRatios };
    }).sort((a, b) => (b.total ? b.passed / b.total : 0) - (a.total ? a.passed / a.total : 0));
  }, [companies, allYears, allPrices, investorFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {results.map((r) => (
        <div key={r.company.id} className="panel" style={{ padding: "12px 16px", cursor: "pointer" }} onClick={() => onSelect(r.company.id)}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: r.checks.length ? 8 : 0 }}>
            <div>
              <span style={{ fontWeight: 600 }}>{r.company.ticker}</span>
              <span style={{ color: "var(--muted)", fontSize: 13, marginLeft: 8 }}>{r.company.company_name}</span>
            </div>
            <span
              className="badge"
              style={{
                background: r.total === 0 ? "var(--panel2)" : r.passed === r.total ? "#132A22" : r.passed === 0 ? "#3A1A1A" : "#2A2410",
                color: r.total === 0 ? "var(--muted)" : r.passed === r.total ? "var(--gain)" : r.passed === 0 ? "var(--loss)" : "var(--gold)",
              }}
            >
              {r.total === 0 ? "Sin años guardados" : `Cumple ${r.passed}/${r.total}`}
            </span>
          </div>
          {r.checks.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {r.checks.map((ch, i) => (
                <span key={i} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: ch.pass ? "#132A22" : "#3A1A1A", color: ch.pass ? "var(--gain)" : "var(--loss)" }}>
                  {ch.pass ? "✓" : "✗"} {ch.label} ({ch.detail})
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RawRow({ label, years, field, onDelete, decimals = 0, nowValue }) {
  return (
    <tr>
      <td style={{ color: "var(--muted)" }}>{label}</td>
      {years.map((y) => (
        <td key={y.id} className="mono">
          {y[field] != null ? fmtNum(y[field], decimals) : "—"}
        </td>
      ))}
      <td className="mono" style={{ color: "var(--gold)" }}>{nowValue != null ? fmtNum(nowValue, decimals) : "—"}</td>
    </tr>
  );
}

function ComputedRow({ label, years, calcKey, nowData, isPct, decimals = 2, highlight, bold }) {
  return (
    <tr>
      <td style={{ color: highlight ? "var(--gold)" : "var(--muted)", fontWeight: bold ? 700 : 400 }}>{label}</td>
      {years.map((y) => {
        const v = computeYearRatios(y)[calcKey];
        return <td key={y.id} className="mono" style={{ fontWeight: bold ? 700 : 400 }}>{isPct ? fmtPct(v, decimals) : fmtNum(v, decimals)}</td>;
      })}
      <td className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>
        {nowData ? (isPct ? fmtPct(nowData[calcKey], decimals) : fmtNum(nowData[calcKey], decimals)) : "—"}
      </td>
    </tr>
  );
}

function TargetCard({ label, value, currency, onSave, editable = true }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");
  useEffect(() => { setVal(value ?? ""); }, [value]);
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      {editable && editing ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input type="number" className="price-input" style={{ width: "100%" }} value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          <button className="icon-btn" style={{ color: "var(--gain)" }} onClick={() => { onSave(val === "" ? null : Number(val)); setEditing(false); }}>✓</button>
        </div>
      ) : (
        <div className="card-value" style={{ cursor: editable ? "pointer" : "default" }} onClick={() => editable && setEditing(true)}>
          {value != null ? fmtNum(value, 2) : "—"}
        </div>
      )}
      <div className="card-sub">{currency}{editable && !editing ? " · clic para editar" : ""}</div>
    </div>
  );
}

function TTMField({ label, value, onSave }) {
  const [val, setVal] = useState(value ?? "");
  useEffect(() => { setVal(value ?? ""); }, [value]);
  return (
    <div className="field" style={{ minWidth: 220 }}>
      <div className="field-label">{label}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input type="number" value={val} onChange={(e) => setVal(e.target.value)} />
        <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => onSave(val === "" ? null : Number(val))}>Guardar</button>
      </div>
    </div>
  );
}

function AddCompanyModal({ onCancel, onSave }) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");

  function submit() {
    if (!ticker) return;
    onSave({ ticker, company_name: name, currency });
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Nueva empresa</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>
        <div className="form-grid">
          <div className="field"><div className="field-label">Ticker</div><input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="HAL" /></div>
          <div className="field"><div className="field-label">Divisa</div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD ($)</option><option value="EUR">EUR (€)</option><option value="GBP">GBP (£)</option>
            </select>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}><div className="field-label">Nombre (opcional)</div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Halliburton" /></div>
        </div>
        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar empresa</button>
      </div>
    </div>
  );
}

function AddYearModal({ onCancel, onSave, existingYears }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [fields, setFields] = useState({
    shares: "", current_assets: "", non_current_assets: "", current_liabilities: "", non_current_liabilities: "",
    intangibles: "", profit: "", dividend_per_share: "", ebit: "", year_end_price: "",
  });

  function upd(k, v) { setFields((prev) => ({ ...prev, [k]: v })); }

  function submit() {
    if (existingYears.includes(Number(year))) return;
    const row = { year: Number(year) };
    for (const k in fields) row[k] = fields[k] === "" ? null : Number(fields[k]);
    onSave(row);
  }

  const labels = {
    shares: "Nº acciones", current_assets: "Activo corriente", non_current_assets: "Activo no corriente",
    current_liabilities: "Pasivo corriente", non_current_liabilities: "Pasivo no corriente", intangibles: "Intangibles",
    profit: "Beneficio", dividend_per_share: "Dividendo/acción", ebit: "EBIT", year_end_price: "Cotización cierre de año",
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head"><div className="modal-title">Añadir año</div><button className="close-btn" onClick={onCancel}><X size={18} /></button></div>
        <div className="form-grid">
          <div className="field"><div className="field-label">Año</div><input type="number" value={year} onChange={(e) => setYear(e.target.value)} /></div>
          {Object.keys(labels).map((k) => (
            <div className="field" key={k}>
              <div className="field-label">{labels[k]}</div>
              <input type="number" value={fields[k]} onChange={(e) => upd(k, e.target.value)} />
            </div>
          ))}
        </div>
        <button className="btn btn-gold" style={{ width: "100%", marginTop: 18, justifyContent: "center" }} onClick={submit}>Guardar año</button>
      </div>
    </div>
  );
}
