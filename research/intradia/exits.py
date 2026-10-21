"""Put credit spread 0DTE (delta 0,12, ancho 10) con distintas salidas, usando la volatilidad implícita real
de cada día (iron condors de las 10:30 de Opción Sigma, en milésimas). Libros: señal media 30, EMA 35, control 10:30."""
import numpy as np, math, csv
from collections import defaultdict

z = np.load("spx_rth_1m.npz"); DAYS = list(z["days"]); BARS = z["bars"].astype(float)
IV = {"20" + r["date"]: int(r["iv"]) / 1000 for r in csv.DictReader(open("impl_vol_1030.csv"))}
Y = 390 * 252; SLIP = 0.10; COMM = 0.03; W = 10

def N(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def volp(S, K, s, T): return s * (1 + 0.10 * max(math.log(S / K) / (s * math.sqrt(T)), 0))
def put(S, K, T, s):
    if T <= 0: return max(K - S, 0.0)
    v = volp(S, K, s, T); sd = v * math.sqrt(T); d1 = (math.log(S / K) + 0.5 * v * v * T) / sd
    return K * N(-(d1 - sd)) - S * N(-d1)
def dput(S, K, T, s):
    v = volp(S, K, s, T); d1 = (math.log(S / K) + 0.5 * v * v * T) / (v * math.sqrt(T)); return N(d1) - 1
def spread(S, Ks, T, s): return put(S, Ks, T, s) - put(S, Ks - W, T, s)

# velas de 5 min continuas
c5, l5, day5, b5 = [], [], [], []
for di, k in enumerate(DAYS):
    a = BARS[di]
    for b in range(78):
        s = a[b * 5:b * 5 + 5]; c5.append(s[4, 3]); l5.append(s[:, 2].min()); day5.append(di); b5.append(b)
c5 = np.array(c5); l5 = np.array(l5)
sma = np.full(len(c5), np.nan); cs = np.cumsum(c5); sma[29:] = (cs[29:] - np.concatenate([[0], cs[:-30]])) / 30
ema = np.zeros(len(c5)); ema[0] = c5[0]
for i in range(1, len(c5)): ema[i] = c5[i] * 2 / 36 + ema[i - 1] * 34 / 36
idx = defaultdict(dict)
for i, (d, b) in enumerate(zip(day5, b5)): idx[d][b] = i

def sig30(i): return i > 32 and c5[i] > sma[i] and c5[i-1] > sma[i-1] and c5[i] > c5[i-1] and c5[i-2] <= sma[i-2]
def sigema(i): return i > 7 and c5[i] > ema[i] and l5[i] <= ema[i] and c5[i-1] > ema[i-1] and ema[i] > ema[i-6]

def trades(book):
    out = []
    for di, k in enumerate(DAYS):
        if k not in IV: continue
        s = IV[k]
        for b in range(78):
            end = 5 * (b + 1)
            if end < 30 or end > 150: continue
            i = idx[di][b]
            if book == "senal" and not sig30(i): continue
            if book == "ema35" and not sigema(i): continue
            if book == "control" and end != 60: continue
            S = c5[i]; T = (390 - end) / Y; base = round(S / 5) * 5; Ks = None
            for j in range(80):
                K = base - 5 * j
                if abs(dput(S, K, T, s)) <= 0.12: Ks = K; break
            cr = spread(S, Ks, T, s) - SLIP
            if cr + SLIP < 0.30: break
            out.append(dict(day=k, di=di, end=end, S=S, Ks=Ks, s=s, cr=cr)); break
    return out

def run(tr, mode):
    res = []
    for t in tr:
        a = BARS[t["di"]]; Ks = t["Ks"]; s = t["s"]; ex = None
        for m in range(t["end"], 390):
            o, h, l, c = a[m]; Tm = (390 - m - 1) / Y; To = (390 - m) / Y
            if mode == "toca_vendido" and l <= Ks:
                Sx = min(o, Ks); ex = spread(Sx, Ks, To if o <= Ks else Tm, s) + SLIP; break
            if mode == "toca_comprado" and l <= Ks - W:
                Sx = min(o, Ks - W); ex = spread(Sx, Ks, To if o <= Ks - W else Tm, s) + SLIP; break
            if mode == "cierre5_bajo_vendido" and (m + 1) % 5 == 0 and c < Ks:
                ex = spread(c, Ks, Tm, s) + SLIP; break
            if mode == "toca_vendido_desde_13h" and m >= 210 and l <= Ks:
                Sx = min(o, Ks); ex = spread(Sx, Ks, To if o <= Ks else Tm, s) + SLIP; break
        fees = COMM * (2 if ex is not None else 1)
        if ex is None: ex = min(max(Ks - a[389, 3], 0), W)
        ex = min(ex, W)
        res.append(dict(t, pnl=(t["cr"] - ex - fees) * 100, stopped=ex is not None and ex > 0))
    return res

def summ(r):
    p = np.array([x["pnl"] for x in r]); n = len(p)
    eq = np.cumsum(p); dd = (eq - np.maximum.accumulate(np.concatenate([[0], eq]))[1:]).min()
    yr = defaultdict(float)
    for x in r: yr[x["day"][:4]] += x["pnl"]
    return f"n={n:3d} acierto={100*(p>0).mean():4.1f}% $/op={p.mean():6.1f} total={p.sum():7.0f} peor={p.min():5.0f} caídaMáx={dd:6.0f} " + " ".join(f"{y}:{v:+.0f}" for y, v in sorted(yr.items()))

if __name__ == "__main__":
    for book in ["senal", "ema35", "control"]:
        tr = trades(book); print(f"\n== {book} ==")
        for mode in ["vencer", "toca_vendido", "cierre5_bajo_vendido", "toca_comprado", "toca_vendido_desde_13h"]:
            print(f"{mode:24s} {summ(run(tr, mode))}")
