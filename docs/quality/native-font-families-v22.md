# Auditoría de familias tipográficas PDF -> Word v22

Fecha: 2026-09-03. Servicio local 1.12.0; caché del cliente
`3.24.0-native-font-families`. Los PDF originales permanecen sin cambios y no
se enviaron documentos a servicios externos.

## Cambio implementado

El backend ya extraía la propiedad `style` de cada fuente autorizada, pero el
cliente la descartaba y el renderizador excluía las caras negrita y cursiva.
Word recibía solamente la cara regular y debía sintetizar las demás, lo que
alteraba el grosor y el ancho de las líneas.

Ahora el cliente conserva el estilo y el empaquetador consolida cada familia en
una única entrada OOXML con `w:embedRegular`, `w:embedBold`, `w:embedItalic` y
`w:embedBoldItalic`, según las caras realmente disponibles. Cada relación sigue
apuntando a su archivo ofuscado original y mantiene el permiso de incrustación
editable validado por el backend. Los nombres con y sin espacios, por ejemplo
`CanvaSans` y `Canva Sans`, se asocian sin confundir palabras internas como
`Blackadder` con el estilo Black.

En Cardano se transportaron seis caras: Shrikhand Regular; Amaranth Regular y
Bold; Liberation Serif Bold; Canva Sans Regular y Bold. La inspección del DOCX
confirma una sola entrada por familia y relaciones distintas para Regular y
Bold. Las páginas 2 y 10 mejoraron +0,27 y +1,03 puntos visuales frente a v21.
La página 15 usa ahora la negrita Canva Sans real y se parece más al PDF al
inspeccionarla, aunque la métrica automática baja 2,09 puntos. El promedio
Cardano pasa de 86,10 a 86,04; la disminución se informa y no se presenta como
una mejora global.

En FENCYT, 60 de 62 páginas resultaron idénticas píxel a píxel a v21. Las dos
páginas modificadas (61 y 62) se revisaron contra el PDF: no presentan recorte,
superposición ni pérdida de texto, y la cabecera larga de la página 62 conserva
su contenido completo. La puntuación es 88,11 frente a 88,12 de v21. Los cinco
folios críticos 5, 11, 12, 41 y 46 conservaron exactamente su puntuación.

## Alcance y límites

- Esta prueba usa extracción nativa y salida posicionada; no mide CER/WER OCR.
- La puntuación es una comparación raster interna a 120 dpi, no un porcentaje
  de exactitud ni una comparación directa con servicios comerciales.
- La fidelidad tipográfica mejora de forma observable aunque el promedio raster
  sea prácticamente neutro; aún faltan métricas de espacio y kerning por fuente.
- Se mantiene como siguiente frente el espaciado horizontal de celdas y la
  evaluación de los 84 folios escaneados con transcripciones de referencia.

Artefactos de regresión: `tmp/deep-audit/FENCYT-quality-v22.docx`,
`tmp/deep-audit/FENCYT-quality-v22.quality.json`,
`tmp/deep-audit/Cardano-quality-v22.docx` y
`tmp/deep-audit/Cardano-quality-v22.quality.json`.
