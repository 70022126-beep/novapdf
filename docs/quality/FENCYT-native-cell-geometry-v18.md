# FENCYT: geometría nativa por celda

## Cambios y causa

Se partió de v14 para revisar p. 5, 11 y 12. La medición por celda identificó
dos causas independientes:

1. En p. 5, el cambio de 9,96 a 9 puntos se espaciaba usando la parte
   superior de las letras. Esa coordenada cambia con el ascendente de la
   fuente. El servicio 1.11 exporta la línea base real de la matriz PDF y
   el cliente la utiliza para calcular el avance entre párrafos de celda.
2. Una celda vacía de continuación recibía márgenes de 1,5 puntos. Word
   desplazaba el texto de las celdas vecinas y se descontaban además
   1,8 puntos de la altura de la fila al tratarla como no nativa. Ahora
   la fila conserva su geometría cuando todas las celdas tienen texto
   nativo o son vacías con una caja medida.

También se separan las métricas del cuerpo y de las referencias pequeñas
para calcular la altura e inicio de la primera línea. Esto evita que un
superíndice se acerque al borde superior al retirar el margen artificial.
No se achicó la letra del documento, no se añadieron imágenes de página y
no se modificó el PDF fuente. Se mantienen las 17 tablas Word nativas.

La caché pasa a `3.21.0-measured-native-baselines`. El servicio antiguo,
las geometrías incompletas y el OCR conservan la ruta de compatibilidad.

## Conversión y revisión visual

- Fuente: `C:/Users/Administrador/Downloads/FENCYT-bases-y-cronograma.pdf`.
- Base: `tmp/deep-audit/FENCYT-table-baselines-v14.docx`.
- Resultado: `tmp/deep-audit/FENCYT-native-cell-geometry-v18.docx`.
- Informe: mismo nombre con extensión `.quality.json`.
- Ejecución: `scripts/benchmark-native-docx.mjs --pages=all --layout=positioned`.
- Render final: `render_docx.py`, LibreOffice 26.2.5.2, 120 dpi.
- 62 páginas de entrada y salida; ZIP íntegro y cinco fuentes incrustadas.
- Tamaño: 760360 bytes. Ensamblado DOCX: 1754 ms; comparación visual:
  19230 ms. No son tiempos de conversión de extremo a extremo.
- Puntuación visual global interna: 87,83 -> 88,03.

| Página | v14 | v18 | Cambio |
| --- | ---: | ---: | ---: |
| 5 | 88,63 | 88,51 | -0,12 |
| 12 | 83,70 | 84,55 | +0,85 |
| 40 | 87,04 | 87,02 | -0,02 |
| 41 | 81,17 | 85,42 | +4,25 |
| 43 | 88,71 | 90,44 | +1,73 |
| 46 | 84,22 | 87,95 | +3,73 |
| 47 | 88,10 | 88,09 | -0,01 |
| 48 | 83,68 | 84,19 | +0,51 |
| 58 | 88,85 | 90,16 | +1,31 |

Se inspeccionaron las nueve páginas con cambios de píxeles del render final:
5, 12, 41, 43, 45, 46, 47, 48 y 58. Las otras 53 son idénticas al render
canónico de v14. P. 45 cambia sin variar su puntuación redondeada; p. 40
presenta una variación de -0,02 en el comparador del servicio, pero el render
canónico es idéntico. P. 11 sigue en 85,51: no se declara corregida.

## Auditoría de texto por celda

Nuevo módulo: `services/vision/table_text_audit.py`. Usa el mapa de páginas
y cajas del benchmark, compara caracteres extraídos de ambos PDFs y mide
la posición de los caracteres coincidentes. Agrupa texto antes de insertar
referencias pequeñas, para no confundir un superíndice adelantado en el
flujo PDF con texto perdido. Hay pruebas específicas para ese falso positivo.

La auditoría completa produjo `tmp/deep-audit/FENCYT-all-cells-v18.json` y
su control `FENCYT-all-cells-v14.json`:

- 936 cajas encontradas; 933 comparadas, incluidas 202 vacías.
- 731 celdas contienen texto; 40153 caracteres normalizados coincidentes.
- Cero diferencias de texto normalizado en las celdas evaluadas, tanto
  en v14 como en v18: la corrección no añade pérdida ni duplicación detectable.
- Tres cajas de altura cero de p. 57 se informan como no evaluables.
  No se cuentan como éxitos ni detienen el resto de la auditoría.

Ejemplos de error vertical absoluto medio, en puntos, por carácter coincidente:

| Página / fila / celda | v14 | v18 |
| --- | ---: | ---: |
| 5 / 2 / 3 | 1,165 | 0,657 |
| 12 / 1 / 2 | 1,915 | 0,415 |
| 41 / 1 / 2 | 2,019 | 0,519 |
| 43 / 2 / 1 | 1,970 | 0,470 |
| 46 / 1 / 2 | 0,543 | 0,372 |
| 46 / 1 / 3 | 1,911 | 0,411 |
| 48 / 1 / 1 | 0,861 | 0,458 |

La página 5 reduce el error de esa celda aunque baja ligeramente su puntuación
visual global. Ambas observaciones se conservan: ninguna métrica aislada
acredita la calidad de todo el documento.

## Regresión y límites

- 104 pruebas JavaScript y 34 Python aprobadas (138 total).
- ESLint, build y `git diff --check` aprobados. Persiste el aviso previo
  del chunk de producción mayor de 500 kB.
- Regresiones para matrices de texto, páginas recortadas, texto rotado,
  datos no numéricos, escalado, fuentes mixtas, primeras líneas con
  referencias, filas nativas vacías y compatibilidad de filas inferidas.
- El módulo de auditoría es una herramienta local de desarrollo; todavía
  no está conectado al panel de calidad del navegador.
- Normaliza espacios y ligaduras. No es CER/WER ni prueba que todo glifo
  sea visible: por eso se mantiene la revisión de los PNG finales.
- No se midió OCR de escaneos, memoria máxima ni edición manual en Word.
- No se afirma equivalencia con iLovePDF/Smallpdf ni fidelidad perfecta.

Próximo objetivo: comprobar el espaciado horizontal de las viñetas en p. 11
y extender el diagnóstico a recortes de tinta por región. Mantener separadas
las medidas de contenido, geometría y apariencia.
