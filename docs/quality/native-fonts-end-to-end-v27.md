# Prioridad 1: tipografías de extremo a extremo — v27

Fecha de validación: 2026-09-04

## Alcance implementado

- Inventario tipográfico de todo el documento con `font_scope=document`, aun
  cuando las páginas se extraen y liberan por lotes.
- Resolución por nombre interno OpenType y por alias PDF (`BaseFont` y nombre
  de recurso), incluido Quicksand.
- Transporte independiente de las variantes regular, negrita, cursiva y
  negrita-cursiva.
- Métricas normalizadas por fuente: unidades por em, avances por carácter,
  ascenso, descenso, interlínea, altura de mayúsculas, altura x y kerning.
- Incrustación únicamente cuando la licencia permite edición. Una cara
  restringida conserva sus métricas, pero nunca sus bytes.
- Sustitución métrica determinista para fuentes no incrustables.
- Caché de recursos tipográficos a escala de documento, separada de la caché
  de páginas.
- Auditoría reproducible de las relaciones `fontTable.xml` -> `fontN.odttf`
  y huellas SHA-256.

## Verificación automatizada

- Cliente: 129/129 pruebas aprobadas.
- Servicio local: 41/41 pruebas aprobadas.
- Se verifican explícitamente alias con familia interna distinta, las cuatro
  variantes, kerning sin `w:kern=0` artificial, altura de línea calibrada,
  Quicksand no incrustable y separación de licencias restringidas/editables.

## Pruebas reales

### Cardano, 16 páginas

- Alcance de fuentes: 16/16 páginas analizadas.
- Recursos detectados: 6; incrustables: 6; sustituciones métricas: 0.
- Familias: Amaranth, Canva Sans, Liberation Serif y Shrikhand.
- Variantes detectadas: regular y negrita.
- Paginación del DOCX: 16/16.
- Fidelidad visual: 89,09/100.
- Auditoría interna: 6 caras declaradas y 6 archivos de fuente relacionados.

### FENCYT, páginas 1–2

- El inventario examinó las 62 páginas aunque solo se generaron dos.
- Recursos detectados: 8; incrustables: 8; sustituciones métricas: 0.
- Familias detectadas: Arial, Calibri, Courier New, Quicksand, Symbol,
  Times New Roman y Wingdings.
- Paginación del DOCX de control: 2/2.
- Fidelidad visual: 92,84/100.
- Auditoría interna: Quicksand aparece como familia `Quicksand`, variante
  regular, y apunta a un `font1.odttf` válido de 77 960 bytes.

En una comparación controlada de las mismas páginas, la sustitución de
Quicksand obtuvo 93,17 y la fuente original incrustada 92,84. La diferencia es
de 0,33 puntos y no justifica eliminar una fuente editable real: la salida debe
conservarla y usar la sustitución solo cuando no sea legal o técnicamente
incrustable.

## Hallazgos fuera del alcance tipográfico

- El documento FENCYT completo conserva 62/62 páginas, pero su puntuación
  actual es 85,61. Desactivar todas las fuentes produce la misma puntuación,
  por lo que la pérdida no procede del transporte tipográfico.
- La muestra parcial FENCYT añade un número de secuencia de Word en la esquina
  inferior de la segunda sección.
- Algunas páginas gráficas de Cardano conservan duplicados tenues en etiquetas
  situadas sobre flechas o diagramas.

Estos defectos deben abordarse en la siguiente prioridad de composición:
supresión de texto duplicado entre fondo y capa editable, y control de campos
PAGE/NUMPAGES en conversiones por rango.

## Comandos reproducibles

```powershell
npm run benchmark:docx-native -- --pages=all --layout=positioned --output=tmp/deep-audit/Cardano-font-e2e-v27.docx "C:\ruta\Cardano.pdf"
npm run benchmark:docx-native -- --pages=1,2 --layout=positioned --output=tmp/deep-audit/FENCYT-font-pages-1-2-v27.docx "C:\ruta\FENCYT.pdf"
npm run audit:docx-fonts -- tmp/deep-audit/FENCYT-font-pages-1-2-v27.docx
```
