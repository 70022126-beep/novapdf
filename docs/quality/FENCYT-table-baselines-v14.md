# FENCYT: líneas base y referencias en tablas editables

## Caso corregido

En la primera fila de la página 46, el final de «responder la pregunta.»
quedaba parcialmente recortado en v10. La celda comienza con una referencia
en superíndice y contiene un salto vertical adicional antes de la última
línea. El PDF fuente muestra la frase completa.

Había dos problemas en el generador Word:

- El espacio posterior se calculaba usando la altura de la línea actual,
  aunque la caja de la línea siguiente determina el próximo avance. Además,
  el límite superior del superíndice alteraba la referencia del cuerpo.
- Se aplicaba `w:vertAlign` a una referencia que ya tenía el tamaño reducido
  extraído del PDF. Word la reducía por segunda vez.

El generador usa ahora la posición del texto no elevado, calcula el espacio
respecto de la caja siguiente y exporta referencias nativas mediante
`w:position` conservando su tamaño. También fija la tipografía de la marca de
párrafo. No se redujo globalmente la letra ni se ampliaron las filas.
Las tablas siguen siendo tablas Word, no capturas.

## Evidencia reproducible

- Fuente: `C:/Users/Administrador/Downloads/FENCYT-bases-y-cronograma.pdf`.
- Base: `tmp/deep-audit/FENCYT-form-fidelity-v10.docx`.
- Candidato: `tmp/deep-audit/FENCYT-table-baselines-v14.docx`.
- Informe: mismo nombre con extensión `.quality.json`.
- Caché: `3.20.0-native-cell-baselines`; API local: 1.10.0, sin cambios.
- Generación: `scripts/benchmark-native-docx.mjs`, opciones `--pages=all`
  y `--layout=positioned`, servicio local en el puerto 8765.
- Render final: `render_docx.py`, 120 dpi, con PDF de salida.
- Comparador: LibreOffice 26.2.5.2; 62 páginas de entrada y 62 de salida.

En la página 46, la coordenada superior de la caja de glifos de la última
línea, medida con PyMuPDF, pasa de 141,21 pt (v10) a 139,76 pt (v14).
En el original es 139,24 pt: el desfase baja de 1,97 a 0,52 pt. Un recorte
renderizado a 300 dpi confirma la frase y el punto final completos. El
superíndice nativo de 6 pt mantiene 6 pt en lugar de reducirse otra vez.

La puntuación visual interna global pasa de 87,82 a 87,83. No es un
porcentaje de exactitud ni una medición CER/WER. Cambios por página:

| Página | v10 | v14 | Diferencia |
| --- | ---: | ---: | ---: |
| 5 | 88,95 | 88,63 | -0,32 |
| 11 | 86,14 | 85,51 | -0,63 |
| 12 | 83,81 | 83,70 | -0,11 |
| 40 | 86,81 | 87,04 | +0,23 |
| 45 | 86,94 | 87,23 | +0,29 |
| 46 | 82,90 | 84,22 | +1,32 |
| 47 | 87,84 | 88,10 | +0,26 |
| 48 | 83,98 | 83,68 | -0,30 |
| 58 | 88,84 | 88,85 | +0,01 |

Se inspeccionaron las nueve páginas modificadas y las páginas de control
41, 43 y 44 de una muestra de cinco páginas. Las otras 53 páginas del render
completo son idénticas píxel por píxel a v10. No se considera el resultado
una mejora uniforme: las cuatro bajadas permanecen registradas y no se
ocultan con el promedio. La tabla de p. 11 ya llega muy cerca del borde
derecho en el PDF original y en v10; no se cambió su ancho en esta revisión.

El ZIP es íntegro, contiene 17 tablas Word y cinco archivos de fuentes
incrustadas. Tamaño: 760527 bytes (v10: 759191). Ensamblado DOCX: 2099 ms;
validación visual: 19386 ms. Ninguno de esos tiempos incluye todo el proceso
de extracción y conversión. Se mantienen los 27 fondos gráficos limpios.

## Pruebas y límites

- 101 pruebas JavaScript y 24 Python aprobadas.
- Nuevas regresiones para referencias elevadas, tamaños mixtos, saltos
  adicionales, lista vacía y OOXML de superíndices/subíndices nativos.
- ESLint, compilación de producción y `git diff --check` aprobados.
- Persiste el aviso previo de un chunk de producción mayor de 500 kB.
- El informe automático no detecta incidencias, pero eso no acredita
  perfección visual, ausencia universal de recortes ni calidad OCR.
- Esta prueba usa un PDF digital y LibreOffice. No se probó edición manual
  en Microsoft Word ni reconocimiento de escaneos en esta iteración.

## Siguiente objetivo acotado

Medir desbordamientos y desviaciones por celda, especialmente en tablas
con viñetas y tipografía mixta de p. 5, 11 y 12. Esa prueba debe proteger
contenido, saltos de línea y geometría antes de aceptar cambios; no basta
con subir la puntuación media ni con achicar las letras indiscriminadamente.
