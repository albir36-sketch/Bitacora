import exits as E
import numpy as np
def trades(book, dmax, W):
    E.W = W; out=[]
    for di,k in enumerate(E.DAYS):
        if k not in E.IV: continue
        s=E.IV[k]
        for b in range(78):
            end=5*(b+1)
            if end<30 or end>150: continue
            i=E.idx[di][b]
            if book=="senal" and not E.sig30(i): continue
            if book=="ema35" and not E.sigema(i): continue
            if book=="control" and end!=60: continue
            S=E.c5[i]; T=(390-end)/E.Y; base=round(S/5)*5; Ks=None
            for j in range(120):
                K=base-5*j
                if abs(E.dput(S,K,T,s))<=dmax: Ks=K; break
            cr=E.spread(S,Ks,T,s)-E.SLIP
            out.append(dict(day=k,di=di,end=end,S=S,Ks=Ks,s=s,cr=cr)); break
    return out
if __name__=="__main__":
   for W in (10,20):
    print(f"\n######## ancho {W}")
    for book in ("senal","ema35","control"):
      print(f"== {book}")
      for d in (0.08,0.10,0.12,0.15,0.20,0.25,0.30):
          tr=trades(book,d,W); r=E.run(tr,"vencer")
          cr=np.mean([t["cr"] for t in tr])*100
          print(f"delta {d:.2f} crédito medio {cr:5.0f}$  {E.summ(r)}")
