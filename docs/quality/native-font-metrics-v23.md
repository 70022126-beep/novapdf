# Auditoría v23: métricas horizontales de fuentes

Fecha: 2026-09-03.

## Cambio

- El servicio 1.13 exporta `units_per_em`, el avance del espacio y un mapa
  acotado de avances para los caracteres realmente utilizados.
- El cliente conserva esas métricas y ajusta palabras editables de tipografías
  de diseño cuando el ancho PDF medido es seguro y completo.
- Hay una zona neutra de 1,5 %, límites de 75–125 % y salida Word de 80–120 %.
- No se ajustan OCR, texto rotado, texto corregido, fuentes comunes ni escalas
  documentales ya calibradas.
- Los espacios medidos se limitan a tipografías de diseño. Las fuentes comunes
  conservan la heurística estable porque pequeños redondeos se acumulan entre
  muchas palabras y cambian la composición.

## Resultados completos

| Documento | Páginas | v22 | v23 | Cambio | Incidencias |
|---|---:|---:|---:|---:|---:|
| FENCYT bases y cronograma | 62/62 | 88,11 | 88,12 | +0,01 | 0 |
| Gerolamo Cardano | 16/16 | 86,04 | 89,09 | +3,05 | 0 |

En Cardano mejoraron especialmente las páginas 15 (71,93 → 81,90) y 16
(71,01 → 78,08). La página 11 bajó 1,01 puntos; la revisión visual confirmó
que texto, imágenes, márgenes y orden permanecen completos. FENCYT conserva el
nivel global y mejora las páginas 11 y 12 sin alterar el contenido de tablas.

## Integridad de tablas FENCYT

`table_text_audit` evaluó 936 cajas: 933 comparadas, 3 omitidas por geometría
no evaluable, 0 celdas con diferencias, 0 caracteres faltantes y 0 caracteres
adicionales.

## Verificación visual

Los DOCX completos se renderizaron con LibreOffice 26.2.5.2. Se revisaron las
nueve páginas modificadas de FENCYT frente a v22 y las páginas críticas 11, 15
y 16 de Cardano. No se observaron recortes, pérdida de gráficos, desorden de
tablas ni cambio de paginación.

## Límites

El puntaje es una similitud rasterizada, no equivale a exactitud semántica ni a
una certificación de Microsoft Word. La mejora cubre PDF digitales con fuentes
incrustables; el OCR de páginas escaneadas requiere su corpus CER/WER separado.
