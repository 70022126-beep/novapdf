# Proveedor neuronal local de NovaPDF

Este servicio encapsula PP-StructureV3 y solo escucha en `127.0.0.1`. Detecta
diseño, texto, tablas, fórmulas, sellos y orden de lectura. NovaPDF continúa
con su visión integrada si el servicio no está disponible.

## Requisitos del equipo actual

- Windows de 64 bits.
- Python 3.12 recomendado.
- NVIDIA RTX 5070 de 12 GB detectada.
- Controlador NVIDIA 591.74 detectado.

PaddleOCR indica que las GPU NVIDIA de serie 50 en Windows requieren su wheel
adaptado. La instalación estándar de PaddlePaddle no debe usarse sin comprobar
primero la tabla oficial de compatibilidad.

## Instalación aislada

Desde `services/vision`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
# Instalar primero el wheel PaddlePaddle adecuado para Python 3.12 y RTX 50
# siguiendo la documentación oficial vigente.
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Después:

```powershell
.\start.ps1 -Device gpu:0
```

Comprobación:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health?load=true
```

La primera carga descargará los modelos oficiales y puede tardar. Para forzar
CPU se puede utilizar `start.ps1 -Device cpu`.

Desde la versión 1.2 los modelos neuronales se precargan en segundo plano al
iniciar el servicio. Puede desactivarse con `NOVAPDF_VISION_PRELOAD=false`. El
estado `/health` diferencia `loading`, `ready` e `idle`, evitando que el primer
documento pague todo el tiempo de inicialización sin información visible.

## Contrato

- `GET /health`: estado, dispositivo y carga del modelo.
- `POST /v1/layout`: formulario multipart con `image`, `page_width`,
  `page_height` y `coordinate_space`.
- `POST /v1/native-document`: formulario multipart con `pdf`, `pages` e
  `include_tables`. Usa pdfplumber para extraer palabras, fuentes, tamaños,
  colores, rotación, líneas, rectángulos, curvas, imágenes, anotaciones y
  tablas con coordenadas exactas.

La respuesta normalizada incluye dimensiones, proveedor, modelo y regiones con
tipo, confianza, caja, texto, HTML de tablas, celdas y LaTeX de fórmulas.

## Instalación preparada en este proyecto

El entorno aislado está en `services/vision/.venv`, los modelos oficiales en
`services/vision/.models` y Python 3.12 en `.runtime/python312`. Esos directorios
no se incluyen en Git.

Desde la raíz del proyecto:

```powershell
npm run vision:runtime
npm run vision:start
npm run vision:warmup
```

En otra terminal se puede comprobar que NovaPDF ya lo detecta:

```powershell
npm run vision:check
```

Para medir el segundo extractor sobre páginas concretas:

```powershell
npm run benchmark:native -- --pages=3,29,40 "C:\ruta\documento.pdf"
```

El servicio escucha únicamente en `http://127.0.0.1:8765`; no publica los PDFs
ni sus resultados en Internet. En una página con texto neuronal, NovaPDF usa
PP-StructureV3 como fuente editable principal y reserva Tesseract para regiones
sin texto o manuscritas.

Los PDFs digitales se verifican con dos motores: PDF.js en el navegador y
pdfplumber en este servicio local. NovaPDF solo adopta el segundo resultado si
conserva al menos el 88% de los caracteres y suficientes propiedades de estilo.
Si el servicio no está iniciado, PDF.js continúa funcionando sin bloquear la
conversión.

## Validación visual posterior (versión 1.3)

LibreOffice vuelve a renderizar localmente cada DOCX generado. NovaPDF compara
ese PDF con las páginas originales y mide solapamiento de tinta, bordes,
geometría, desplazamiento y cantidad de páginas. Esta puntuación se obtiene del
archivo Word terminado; no es solamente una estimación de la extracción.

`POST /v1/quality/docx` recibe un formulario multipart con `pdf`, `docx`,
`pages` y `dpi`. Los archivos se procesan dentro de un directorio temporal y se
eliminan al terminar. `GET /health` informa si LibreOffice está disponible.
