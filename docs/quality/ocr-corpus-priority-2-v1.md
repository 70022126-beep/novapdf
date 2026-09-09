# Prioridad 2: corpus OCR real - estado v1

Fecha: 2026-09-07

## Resultado implementado

- Manifiesto privado con cuotas exactas de 30 escaneos limpios, 30 escaneos
  difíciles, 20 formularios/tablas y 20 páginas híbridas.
- Selección inicial de 100 páginas distintas tomada de cinco PDF reales
  aportados al proyecto.
- Renderizado local de 100 PNG a 220 DPI (230,39 MB) y creación de 100
  borradores de anotación.
- Imágenes, rutas, transcripciones e hipótesis excluidas de Git bajo
  `benchmarks/ocr-corpus/private/`.
- Esquemas JSON versionados para manifiesto y anotaciones.
- Interfaz local para dibujar regiones, clasificar, transcribir y registrar una
  segunda revisión humana.
- Ejecutor comparativo de PP-StructureV3/PaddleOCR, Tesseract.js y fusión por
  región.
- CER y WER microponderados globales, por categoría y por motor.
- Historial seguro sin rutas, imágenes, referencias ni hipótesis textuales.

## Regla contra contaminación de la evaluación

La fusión selecciona un motor usando confianza, plausibilidad del texto,
acuerdo entre motores y tipo de región. Nunca consulta la transcripción humana.
El benchmark abre la referencia únicamente después de elegir la salida.

Una extracción nativa o un OCR pueden ayudar al anotador, pero nunca se marcan
automáticamente como verdad. El estado `human_verified` exige anotador y
revisor distintos.

## Estado real del corpus

- Páginas candidatas: 100/100.
- Imágenes renderizadas: 100/100.
- Borradores de anotación: 100/100.
- Categorías confirmadas visualmente por una persona: 0/100.
- Transcripciones humanas con doble revisión: 0/100.
- Benchmark científico definitivo: bloqueado correctamente.

La inspección de varias muestras confirmó que la selección automática sirve
como punto de partida, pero no como clasificación final. Algunos escaneos
incluyen sellos o tinta de color, y una candidata a formulario contenía texto
corrido. Las 100 categorías deben revisarse desde la interfaz antes de medir.

## Comandos

```powershell
npm run corpus:ocr:annotate -- --manifest=benchmarks/ocr-corpus/private/manifest.json
npm run vision:start
npm run benchmark:ocr-corpus -- --manifest=benchmarks/ocr-corpus/private/manifest.json
```

El anotador solo escucha en `http://127.0.0.1:4312`. La ejecución estricta no
inicia PaddleOCR ni Tesseract hasta que las 100 páginas cumplen las cuotas y
tienen referencia humana verificada.

## Verificación de software

- Pruebas JavaScript: 134/134 aprobadas.
- ESLint: aprobado.
- Validación sintáctica de los tres ejecutores Node: aprobada.
- Compilación del preparador Python: aprobada.
- Servidor del anotador: HTML, estado de 100 muestras e imagen privada
  respondieron HTTP 200.

## Condición de cierre de la Prioridad 2

La infraestructura está terminada. La prioridad completa solo quedará cerrada
cuando dos personas hayan validado las 100 muestras y exista un informe real
con CER/WER de PaddleOCR, Tesseract y la fusión. Inventar o autocompletar esas
transcripciones invalidaría el benchmark.
