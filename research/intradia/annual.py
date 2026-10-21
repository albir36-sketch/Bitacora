import exits as E, deltas as Dm, numpy as np, io, contextlib
ndays=sum(1 for k in E.DAYS if k in E.IV); yrs=ndays/252
print(f"días en la muestra: {ndays} = {yrs:.2f} años")
def line(name,r):
    p=np.array([x['pnl'] for x in r]); tot=p.sum(); eq=np.cumsum(p); dd=(eq-np.maximum.accumulate(np.concatenate([[0],eq]))[1:]).min()
    print(f"{name:34s} n={len(p):3d} $/op={p.mean():6.1f} total={tot:7.0f} anual={tot/yrs:6.0f}$ = {tot/yrs/100:5.1f}% caída={dd:6.0f}")
print("\nSALIDAS (delta 0,12)")
for book in ("senal","ema35","control"):
    tr=E.trades(book)
    for mode in ("vencer","toca_vendido","cierre5_bajo_vendido","toca_comprado","toca_vendido_desde_13h"):
        line(f"{book} {mode}",E.run(tr,mode))
print("\nDELTAS (ancho 10, vencer)")
for book in ("senal","ema35","control"):
    for d in (0.08,0.10,0.12,0.15,0.20,0.25,0.30):
        line(f"{book} delta {d}",E.run(Dm.trades(book,d,10),"vencer"))
