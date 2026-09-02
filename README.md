# NovaPDF

Plataforma web de herramientas PDF que se ejecuta **completamente en el navegador**:
los archivos nunca salen del equipo del usuario. Incluye un motor propio de
conversión PDF → Word con análisis de layout, OCR y un proveedor neuronal local
opcional.

## Herramientas

| Herramienta | Ruta | Descripción |
| --- | --- | --- |
| Unir PDF | `/merge-pdf` | Combina varios PDFs en uno solo, con reordenación drag & drop. |
| Dividir PDF | `/split-pdf` | Extrae rangos o páginas sueltas de un documento. |
| Comprimir PDF | `/compress-pdf` | Reduce el tamaño de los PDFs con control de calidad. |
| Convertir PDF | `/convert-pdf` | Convierte PDF a imágenes (PNG) página a página. |
| PDF a Word | `/pdf-to-word` | Conversión editable con motor híbrido propio (ver más abajo). |

Páginas internas de desarrollo y diagnóstico: `/pdf-engine-inspector`
(clasificación y análisis de páginas) y `/ocr-test` (banco de pruebas de OCR).

## Motor PDF → Word

La conversión a Word usa un enfoque híbrido por página:

1. **Clasificación** (`src/engine/pdf-to-word/PageTypeDetector.js`): cada página
   se marca como digital, escaneada o híbrida.
2. **Extracción nativa** con PDF.js (texto, geometría, tablas vectoriales) y,
   si está disponible, con el servicio local `pdfplumber` como segundo
   candidato que solo se adopta cuando mejora la puntuación.
3. **OCR adaptativo** (`src/engine/ocr/`) con Tesseract para páginas
   escaneadas, con preprocesado de imagen y fusión híbrida para no duplicar
   texto nativo.
4. **Análisis de layout** (`src/engine/layout/`): detección de bloques, líneas,
   tablas profesionales (celdas combinadas, tipos numéricos) y continuidad a
   escala de documento.
5. **Renderizado editable** (`src/engine/pdf-to-word/WordDocumentRenderer.js`):
   genera un DOCX real (tablas DXA, fórmulas OMML, fondo editable posicionado)
   con la librería `docx`.
6. **Validación** (`src/engine/evaluation/`): puntúa fidelidad visual, CER/WER
   y calidad por página; un optimizador automático solo adopta cambios que
   mejoran el resultado sin degradar ninguna página.

El proveedor neuronal local opcional (PP-StructureV3) detecta diseño, tablas,
fórmulas y sellos: consulta [`services/vision/README.md`](services/vision/README.md).

La arquitectura completa del motor (doble extracción, canalización, modos de
conversión y validaciones) está documentada en
[`docs/PDF_TO_WORD_ENGINE.md`](docs/PDF_TO_WORD_ENGINE.md).

## Requisitos

- Node.js 20+ (desarrollado sobre Node 22).
- Navegador moderno (Chrome, Edge, Firefox).
- Opcional para la visión neuronal: Windows 64 bits, Python 3.12 y GPU NVIDIA
  compatible con PaddleOCR (ver el README del servicio).

## Instalación y uso

```bash
npm install
npm run dev        # servidor de desarrollo con HMR
npm run build      # build de producción en dist/
npm run preview    # sirve el build de producción localmente
```

## Scripts disponibles

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Servidor de desarrollo Vite. |
| `npm run build` | Build de producción. |
| `npm run lint` | ESLint (src, tests y scripts). |
| `npm test` | Suite de tests con `node --test`. |
| `npm run vision:start` | Arranca el servicio neuronal local (puerto 8765). |
| `npm run vision:check` | Comprueba si el servicio neuronal responde. |
| `npm run vision:warmup` | Precalienta los modelos del servicio neuronal. |
| `npm run vision:runtime` | Verifica el runtime Python aislado. |
| `npm run vision:test` | Tests del servicio neuronal (unittest). |
| `npm run benchmark:pdf` | Benchmark de clasificación de páginas PDF. |
| `npm run benchmark:native` | Benchmark del extractor nativo (pdfplumber). |
| `npm run benchmark:docx-native` | Benchmark del segundo candidato DOCX local. |

## Estructura del proyecto

```
src/
  components/        Header, Hero, Tools, ToolCard, Footer, PDFThumbnail
  pages/             MergePDF, SplitPDF, CompressPDF, ConvertPDF,
                     PDFToWord, PDFEngineInspector, OCRTest
  engine/
    pdf-to-word/     Clasificación, extracción híbrida, renderizado DOCX, cache
    layout/          Análisis de página, tablas, estructura documental
    ocr/             Motor OCR adaptativo y preprocesado de imágenes
    vision/          Proveedor neuronal local y fusión de texto
    evaluation/      Métricas, benchmark científico y optimizador de calidad
services/
  vision/            Servicio Python local (PP-StructureV3 + pdfplumber + LibreOffice)
scripts/             Fixtures, benchmarks y utilidades de diagnóstico
test/                Suite de tests con node --test
```

## Privacidad

Toda la conversión ocurre en el navegador o, de forma opcional, en un servicio
local que solo escucha en `127.0.0.1`. Ningún documento se sube a Internet.

## Tests

```bash
npm test
```

La suite cubre el motor de conversión: normalización de contenido, tablas
vectoriales y profesionales, fusión neuronal, cache, optimizador de calidad y
renderizado DOCX. Los tests se escriben como módulos ES con `node:test`.

## Licencia

Proyecto privado. © 2026 NovaPDF. Todos los derechos reservados.
