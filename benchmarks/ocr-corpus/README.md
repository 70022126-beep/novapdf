# Corpus OCR privado de NovaPDF

Esta infraestructura compara PP-StructureV3/PaddleOCR, Tesseract.js y una
fusión elegida por región sin consultar la transcripción de referencia. El
benchmark calcula CER y WER microponderados para todo el corpus y para cada
categoría.

## Privacidad

`private/` está excluido de Git. Allí se guardan el manifiesto real, las
imágenes renderizadas, las transcripciones humanas y, opcionalmente, las
hipótesis completas de los motores. Los informes de `history/` solo contienen
identificadores neutros, conteos, tiempos y métricas; no incluyen rutas ni
texto del documento.

No se deben copiar PDF, imágenes, nombres de personas ni transcripciones a un
archivo versionado.

## Composición obligatoria

El benchmark estricto exige 100 muestras distintas:

- 30 `clean_scan`.
- 30 `noisy_scan` con ruido, manchas o sellos.
- 20 `form_table`.
- 20 `hybrid`.
- Al menos una muestra con etiqueta `rotated` o rotación distinta de cero.
- Al menos una muestra con etiqueta `photo`.

Cada muestra necesita `categoryReview: "human_verified"`. Su anotación debe
tener `status: "human_verified"`, una persona anotadora, otra revisora y al
menos una región con transcripción literal. Un borrador creado por OCR o por
extracción nativa nunca se considera verdad de referencia.

## Preparación

1. Copiar `manifest.example.json` a `private/manifest.json`.
2. Añadir las rutas locales y las páginas candidatas.
3. Renderizar y crear borradores, sin sobrescribir anotaciones existentes:

```powershell
npm run corpus:ocr:prepare -- --manifest benchmarks/ocr-corpus/private/manifest.json
```

También puede generarse una selección inicial de 100 páginas desde el informe
de clasificación. La selección queda deliberadamente en estado `pending`:

```powershell
npm run corpus:ocr:seed -- --classification=tmp/ocr-corpus-candidates.json "C:\ruta\uno.pdf" "C:\ruta\dos.pdf"
```

4. Ajustar las cajas de las regiones y transcribir exactamente lo visible.
5. Una segunda persona revisa categoría, cajas, orden y texto; solo entonces
   cambia ambos estados a `human_verified`.

La interfaz local de anotación se inicia con:

```powershell
npm run corpus:ocr:annotate -- --manifest=benchmarks/ocr-corpus/private/manifest.json
```

Después se abre `http://127.0.0.1:4312`. Permite dibujar regiones, corregir la
categoría, transcribir, marcar contenido excluido y registrar anotador/revisor.
El servidor solo escucha en la interfaz local.

## Benchmark

Con el servicio neuronal iniciado:

```powershell
npm run vision:start
npm run benchmark:ocr-corpus -- --manifest=benchmarks/ocr-corpus/private/manifest.json
```

`--allow-incomplete --max-pages=3` sirve únicamente como diagnóstico durante
la anotación. Un resultado parcial no certifica la Prioridad 2.

`--keep-hypotheses` conserva referencias e hipótesis completas bajo
`private/runs/` para corrección local. Por defecto no se escriben.

La fusión usa confianza, legibilidad, acuerdo entre motores y una prioridad
por tipo de región. Nunca usa CER/WER ni el texto humano para seleccionar al
ganador; la referencia se abre únicamente después para medir.
