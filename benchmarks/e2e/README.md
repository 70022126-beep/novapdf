# Puerta de calidad PDF a Word

`npm run benchmark:e2e -- --manifest=ruta/al/manifest.json` ejecuta la interfaz
real de NovaPDF en Chrome, descarga el DOCX y lo compara con el PDF original,
la última salida NovaPDF y una conversión profesional opcional.

La ejecución falla cuando cambia la cantidad de páginas, desaparece texto o
una página pierde más de 0,25 puntos de fidelidad visual. También falla si el
renderizador visual no está disponible, para impedir aprobaciones sin evidencia.
Además registra CER,
WER, tablas, celdas, fuentes, imágenes, tiempo, memoria máxima del navegador y
tamaño final. Los DOCX y capturas quedan bajo `tmp/e2e`; el historial JSON se
guarda en `benchmarks/e2e/history` sin copiar los documentos originales.

Cada informe conserva además el motor finalmente seleccionado, si hubo un
reintento de calidad, el motivo de aceptación o rechazo, la estrategia de
maquetación de cada página (`flow` o `positioned`), las formas de las tablas y
la cobertura de familias tipográficas. La salida de consola es un resumen
compacto; el JSON histórico contiene el diagnóstico completo.

El manifiesto real no debe versionarse si contiene rutas privadas. Copia
`manifest.example.json`, agrega los documentos y, cuando exista una
transcripción humana, usa `referenceDocx` o `professionalDocx` como referencia
textual. Un resultado sin referencia sigue midiendo fidelidad visual, pero no
certifica CER/WER OCR.

Para aceptar una nueva línea base de NovaPDF, copia el DOCX aprobado fuera de
`tmp` y decláralo como `previousDocx` en la siguiente ejecución. El benchmark
nunca sustituye una línea base automáticamente.
