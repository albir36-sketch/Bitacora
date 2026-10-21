# Datos y scripts del experimento intradía 0DTE (SPX)

- `spx_rth_1m.npz`: velas de 1 minuto del SPX en sesión regular (09:30-15:59 de Nueva York, 390 por día), desde agosto de 2023. Fuente: histdata.com (SPXUSD, cierre diario a ±2 puntos del SPX oficial). Contiene `days` (AAAAMMDD) y `bars` (días × 390 × [apertura, máximo, mínimo, cierre]). Faltan de febrero a septiembre de 2026 hasta que se añadan esos ficheros.
- `impl_vol_1030.csv`: volatilidad implícita diaria (en milésimas) deducida de los créditos reales de iron condors 0DTE a las 10:30 (backtester de Opción Sigma, desde junio de 2024).
- `build.py`: crea el `.npz` a partir de los CSV de histdata (`python3 build.py carpeta_csv salida.npz`).
- `exits.py`: compara salidas (dejar vencer, tocar strike vendido, cierre de 5 min bajo el vendido, tocar el comprado) en los libros señal media 30, EMA 35 y control.

Están aquí para no depender del ordenador de Rafa: cualquier conversación puede clonarlo y repetir las pruebas.
