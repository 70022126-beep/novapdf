# FENCYT: auditoría de bordes y rellenos de tabla

Fecha: 2026-09-02. Motor nativo 1.10.0; caché 3.18.0-semantic-table-borders.

## Corrección comprobada

Los rectángulos grises sin contorno dibujados detrás de cada línea de texto
se interpretaban como bordes de tabla. El detector ahora los excluye de la
geometría de TableFinder, pero conserva el PDF original para extraer texto,
imágenes y rellenos. Las franjas estrechas usadas como bordes siguen contando.
Los rellenos completos de celda atraviesan el modelo intermedio hasta Word;
un `null` explícito impide inventar un fondo gris en cabeceras blancas.

## Ejecución real

- Fuente: `FENCYT-bases-y-cronograma.pdf`, 62 páginas.
- Candidato: `tmp/deep-audit/FENCYT-table-fidelity-v8.docx`.
- Referencia anterior: `tmp/deep-audit/FENCYT-rotated-ready-v6.quality.json`.
- Informe: `tmp/deep-audit/FENCYT-table-fidelity-v8.quality.json`.
- Páginas de salida: 62; ZIP íntegro; cinco archivos de fuentes incrustadas.
- Puntuación visual interna: 87,47 -> 87,73. No representa un porcentaje de
  exactitud ni demuestra equivalencia con servicios comerciales.
- Nueve páginas mejoran, 51 no cambian y dos bajan ligeramente:
  página 5 (-0,11), página 42 (-0,60).
- Página 31: 80,51 -> 87,00; página 37: 86,76 -> 91,83.
- Las tablas de las páginas 31 y 37 pasan de seis filas artificiales a tres
  filas lógicas, conservando la cabecera multilínea y las filas vacías.
- Ensamblado DOCX: 1653 ms; tamaño: 748130 bytes. El tiempo no incluye toda
  la extracción ni la validación visual.

Se renderizó el DOCX completo con LibreOffice a 120 dpi mediante el renderer
de documentos y se inspeccionaron las 62 imágenes. Las páginas 31, 37 y 42
confirman visualmente la corrección de cabeceras y rellenos.

## Defectos abiertos detectados visualmente

1. **Rectificación de la revisión posterior:** la sospecha de números de
   página incompletos fue un falso positivo de inspección visual. Un recorte
   ampliado del PNG original de la página 34 muestra `194` completo, igual
   que el PDF renderizado mediante PyMuPDF y su extracción de texto. No se
   modificó la numeración; no hay evidencia de ese recorte en el archivo.
2. En esa misma página faltan líneas vectoriales de campos (por ejemplo,
   Dirección y Teléfono). Comparación directa con el PDF original confirma
   que no son espacios vacíos del documento fuente.
3. Persisten diferencias de ajuste y alineación en tablas densas; comprobar
   particularmente continuaciones entre páginas antes de dar por terminada
   la fidelidad editable. Texto cercano a bordes no prueba por sí solo una
   regresión: en páginas 11 y 12 esa característica también está en el PDF.

El informe automático no registra incidencias, pero no detecta todos estos
defectos visuales. Esta versión es una mejora del motor, no una conversión
sin pérdidas ni un resultado final 100/100.

## Regresión automatizada

- JavaScript: 97 pruebas aprobadas.
- Python: 23 pruebas aprobadas, incluyendo un PDF sintético generado en memoria.
- ESLint y compilación de producción aprobados.
- `git diff --check` sin errores de espacios; avisos existentes LF/CRLF.

Reproducir el documento con:

```powershell
node scripts/benchmark-native-docx.mjs --pages=all --layout=positioned --output=tmp/deep-audit/FENCYT-table-fidelity-v8.docx "C:\Users\Administrador\Downloads\FENCYT-bases-y-cronograma.pdf"
```

El servicio local debe estar activo en `127.0.0.1:8765`. Para futuras
comparaciones, usar otra ruta de salida y conservar este candidato.
