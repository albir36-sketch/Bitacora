"""Construye días RTH (09:30-15:59 ET, 390 velas de 1 min) a partir de los CSV de histdata (SPXUSD).
Misma lógica que en la prueba del navegador: la sesión del CFD se corta a las 16:14 ET; si el corte aparece a
las 15:14, ese día los datos vienen desplazados una hora (semanas de desfase horario EE. UU./Europa)."""
import glob, sys, numpy as np, collections

files = sorted(glob.glob(sys.argv[1] + "/DAT_ASCII_SPXUSD_M1_*.csv"))
mins = collections.defaultdict(dict)
for f in files:
    with open(f) as fh:
        for line in fh:
            if len(line) < 20: continue
            key = line[:8]; mm = int(line[9:11]) * 60 + int(line[11:13])
            p = line.split(";")
            mins[key][mm] = (float(p[1]), float(p[2]), float(p[3]), float(p[4]))

days, arrs, shifts = [], [], []
for key in sorted(mins):
    if key < "20230801": continue
    M = mins[key]; g = None
    for m in range(13 * 60, 19 * 60):
        if m in M and (m + 1) not in M and not any((m + 2 + x) in M for x in range(30)):
            g = m; break
    if g is None: continue
    if 16 * 60 + 12 <= g <= 16 * 60 + 14: shift = 0
    elif 15 * 60 + 12 <= g <= 15 * 60 + 14: shift = 60
    else: continue
    a = np.full((390, 4), np.nan); n = 0
    for i in range(390):
        v = M.get(9 * 60 + 30 + i - shift)
        if v: a[i] = v; n += 1
    for i in range(1, 390):
        if np.isnan(a[i, 0]) and not np.isnan(a[i - 1, 3]): a[i] = a[i - 1, 3]
    if n < 380 or np.isnan(a[0, 0]): continue
    days.append(key); arrs.append(a); shifts.append(shift)

np.savez_compressed(sys.argv[2], days=np.array(days), bars=np.stack(arrs).astype(np.float32))
print(len(days), days[0], days[-1])
