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
# Segundo candidato para PDFs digitales. --no-deps evita reemplazar el OpenCV
# de PaddleOCR por otra distribución que expone el mismo módulo cv2.
.\.venv\Scripts\python.exe -m pip install --no-deps -r requirements-native-docx.txt
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
- `POST /v1/documents`: registra un PDF una sola vez y devuelve su identificador
  SHA-256. Los endpoints registrados de extracción y fondo reutilizan ese archivo.
- `POST /v1/documents/{document_id}/native-document`: extracción nativa sin
  retransmitir el PDF por lote.
- `POST /v1/documents/{document_id}/native-background`: fondo limpio por página
  sin retransmitir el PDF.
- `DELETE /v1/documents/{document_id}`: elimina anticipadamente un registro.
- `POST /v1/layout`: formulario multipart con `image`, `page_width`,
  `page_height` y `coordinate_space`.
- `POST /v1/native-document`: formulario multipart con `pdf`, `pages` e
  `include_tables`. Usa pdfplumber para extraer palabras, fuentes, tamaños,
  colores, rotación, líneas, rectángulos, curvas, imágenes, anotaciones y
  tablas con coordenadas exactas.
- `POST /v1/convert/native-docx`: segundo candidato local para documentos
  digitales editables. NovaPDF lo compara con su reconstrucción y solo lo
  adopta cuando mejora la puntuación sin degradar ninguna página. Se excluye
  automáticamente en páginas con tablas, fórmulas, firmas o sellos.

La respuesta normalizada incluye dimensiones, proveedor, modelo y regiones con
tipo, confianza, caja, texto, HTML de tablas, celdas y LaTeX de fórmulas.

Desde la versión 1.16, `/health` también publica las colas OCR/fondos, el uso del
registro de documentos y los presupuestos de RAM/VRAM. Una cola saturada devuelve
HTTP 429 y un trabajo que excede su plazo devuelve HTTP 504. Los valores se
configuran con `NOVAPDF_OCR_WORKERS`, `NOVAPDF_OCR_QUEUE_SIZE`,
`NOVAPDF_BACKGROUND_WORKERS`, `NOVAPDF_BACKGROUND_QUEUE_SIZE`,
`NOVAPDF_DOCUMENT_STORE_BYTES`, `NOVAPDF_RAM_BUDGET_MB` y
`NOVAPDF_VRAM_BUDGET_MB`.

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

## Validación visual posterior (versión 1.4)

LibreOffice vuelve a renderizar localmente cada DOCX generado. NovaPDF compara
ese PDF con las páginas originales y mide solapamiento de tinta, bordes,
geometría, desplazamiento y cantidad de páginas. Esta puntuación se obtiene del
archivo Word terminado; no es solamente una estimación de la extracción.

`POST /v1/quality/docx` recibe un formulario multipart con `pdf`, `docx`,
`pages` y `dpi`. Los archivos se procesan dentro de un directorio temporal y se
eliminan al terminar. `GET /health` informa si LibreOffice está disponible.

## Bordes y rellenos de tabla (versión 1.10)

El detector separa los bordes reales de los rectángulos rellenos sin trazo que
Office coloca detrás del texto. Esos fondos ya no crean filas artificiales en
cabeceras de varias líneas. Se conservan los rectángulos con contorno y las
franjas rellenas de hasta 5 puntos usadas como bordes. También se reconocen
rectángulos codificados como rutas de cuatro segmentos; no se descartan rutas
compuestas ni curvas arbitrarias.

El filtro solo se aplica a la geometría de detección. El PDF original permanece
intacto y sus rellenos se recuperan por celda como `structure.raw[].cells[].shading`.
Un color hexadecimal conserva el fondo detectado; `null` indica una celda sin
relleno, para que el generador Word no invente una cabecera gris. Los resaltados
que cubren menos del 90 % de una celda no se propagan a toda la celda.

La prueba de regresión genera en memoria un PDF con fondos de texto, bordes
rellenos, una cabecera multilínea y dos filas vacías. Comprueba la estructura,
la conservación de las filas de formulario y el transporte de los colores.

## Gráficos escasos y formularios

En el diseño posicionado, el cliente conserva el fondo gráfico de páginas sin
tablas incluso si solo contienen un trazo vectorial. El antiguo umbral de 12
objetos omitía líneas de firma, campos y recuadros de huella. Las páginas de
texto puro siguen sin necesitar un fondo; se mantiene la política de tablas
para no duplicar sus bordes.

Los trazos se conservan como parte del fondo PNG, con texto Word editable por
encima. Esto no convierte las líneas en controles de formulario interactivos.
La procedencia de subrayados y tachados vectoriales se transporta hasta Word:
no se vuelven a dibujar cuando ya están en el fondo limpio visible. Sin ese
fondo, se conservan como formato Word. La caché del cliente cambia a
`3.19.0-sparse-vector-artwork` para invalidar conversiones anteriores.

## Tipografías de extremo a extremo (versión 1.15)

`POST /v1/native-document` acepta `font_scope=document`. Con ese alcance el
servicio inventaría las fuentes de todas las páginas del PDF una sola vez,
aunque el contenido se extraiga por lotes. La respuesta incluye el nombre
interno real, los alias BaseFont y de recurso usados por el PDF, las variantes
regular/negrita/cursiva/negrita-cursiva y métricas OpenType normalizadas
(`units_per_em`, ascenso, descenso, interlínea, altura de mayúsculas, altura x,
avances por carácter y presencia de kerning).

Las fuentes con permiso de edición se consolidan por familia y variante antes
de incrustarlas en Word. Las fuentes restringidas nunca transportan sus bytes
ni se mezclan con una cara editable: solo entregan alias y métricas para elegir
una sustitución reproducible. El cliente conserva el inventario tipográfico en
una caché documental independiente de la caché de páginas, evitando que una
segunda conversión pierda las fuentes cuando todas las páginas ya estaban
procesadas.

La auditoría de un DOCX generado puede ejecutarse con:

```powershell
npm run audit:docx-fonts -- "C:\ruta\resultado.docx"
```

El informe relaciona cada familia y variante declarada en `fontTable.xml` con
su archivo `word/fonts/fontN.odttf`, desofusca la cabecera y calcula huellas
SHA-256 para detectar sustituciones o pérdidas entre versiones.

La prueba PDF de regresión recorre `render_clean_background` con dos reglas,
un rectángulo coloreado y texto. Comprueba píxeles de los trazos, eliminación
del texto del fondo y conservación del PDF fuente en memoria.

## Líneas y referencias dentro de celdas nativas

El generador Word calcula el avance vertical con la posición del cuerpo de
texto, sin desplazarlo por una referencia elevada. El espacio entre párrafos
tiene en cuenta la altura de la línea siguiente, evitando acumular desfases
cuando cambia el tamaño de letra. Se conservan las alturas originales de las
filas y los saltos adicionales medidos en el PDF.

Los superíndices y subíndices nativos con geometría válida conservan su tamaño
y usan un desplazamiento explícito de línea base en Word; no se aplica una
segunda reducción automática. Esta política se limita a las celdas nativas;
el OCR y los textos sin geometría suficiente mantienen el comportamiento
anterior. La caché actual del cliente es `3.20.0-native-cell-baselines`.

La auditoría reproducible y sus límites están en
`docs/quality/FENCYT-table-baselines-v14.md`. La validación utiliza LibreOffice;
no sustituye una prueba de edición manual en Microsoft Word.

## Geometría nativa de celdas (versión 1.11)

Cada palabra horizontal puede incluir `baseline_y`, en puntos con origen
superior izquierdo. Se calcula a partir de la matriz del carácter PDF, sin
suponer un ascendente fijo para todas las fuentes. El cliente escala este
valor como `baselineY`. Cuando falta, es inválido o el texto está rotado, se
conserva el cálculo geométrico anterior. Las referencias pequeñas no reducen
la altura del cuerpo ni desplazan el inicio de la primera línea.

Las celdas vacías con caja medida conservan los márgenes y la altura de su
fila nativa. Antes recibían el relleno de las celdas inferidas, que desplazaba
también el texto vecino. Las filas sin texto nativo o con contenido sin
geometría mantienen su política anterior. Caché: `3.21.0-measured-native-baselines`.

La auditoría local por celda complementa la comparación de imágenes. Recibe
el JSON de `benchmark-native-docx.mjs` y el PDF renderizado del DOCX:

```powershell
services/vision/.venv/Scripts/python.exe -m services.vision.table_text_audit --report tmp/deep-audit/FENCYT-native-cell-geometry-v18.quality.json --rendered tmp/deep-audit/FENCYT-native-cell-geometry-v18-rendered/FENCYT-native-cell-geometry-v18.pdf --output tmp/deep-audit/FENCYT-all-cells-v18.json
npm run vision:test
```

El JSON distingue diferencias de caracteres, desplazamiento horizontal,
desviación de línea base y geometrías no evaluables. Normaliza espacios y
ligaduras; no es CER/WER, no prueba visibilidad de tinta y no sustituye QA
visual. No se aplica al OCR de escaneos. Las pruebas incluyen orden de
superíndices, ordinales, celdas vacías y cajas degeneradas.

## Composición gráfica, fuentes y origen de página (versión 1.12)

Las imágenes exportan `requires_compositing` cuando contienen máscaras PDF
`SMask`, `Mask` o `ImageMask`. El cliente conserva esta señal aunque no haya
bytes decodificables y, en diseño posicionado, solicita la placa gráfica limpia.
Así se resuelven transparencias y recortes en el compositor PDF, en vez de
insertar bytes incompletos como imágenes negras. El texto nativo sigue siendo
Word editable; los gráficos de la placa no son formas Word independientes.

La extracción conserva una sola copia del último glifo pintado cuando texto,
fuente, tamaño y coordenadas coinciden. No elimina letras repetidas adyacentes
ni sombras desplazadas. El contador `removed_overprinted_characters` hace
auditable esta decisión. Cajas, celdas, anclas de columna y líneas base se
trasladan al origen local de la página, incluso con MediaBox no nulo.

El DOCX normaliza a mayúsculas el GUID de las fuentes incrustadas, sin cambiar
su contenido ni permisos. Las pruebas aisladas confirmaron que LibreOffice
26.2 cargaba Shrikhand/Amaranth/Canva Sans con este cambio, mientras que añadir
opciones de guardado de fuentes por sí solo no resolvía la sustitución.

Las viñetas nativas de celdas usan una tabulación medida para independizar el
inicio del texto del ancho de la fuente sustituta del símbolo. Los títulos
digitales conservan tamaños superiores a 48 puntos; el límite OCR se mantiene.
Una corrección acotada de línea base cubre títulos de fuente incrustada con
descendentes profundos, sin modificar párrafos ordinarios ni OCR.

Caché actual: `3.23.0-native-font-compositing-baselines`. Resultados, regresiones
y límites: `docs/quality/native-corpus-v21.md`. La clasificación del corpus
puede guardarse con `benchmark:pdf -- --output=tmp/corpus.json ...`; ese informe
no mide reconocimiento OCR ni memoria máxima.

## Métricas horizontales de fuentes (versión 1.13)

Las fuentes autorizadas exportan ahora `units_per_em`, `space_advance_em` y un
mapa acotado de avances por carácter utilizado. El cliente conserva estas
métricas y calcula una escala horizontal por palabra únicamente cuando dispone
de todos sus glifos, la palabra no fue corregida y la relación medida permanece
entre 75 % y 125 %. OCR, texto rotado, fuentes incompletas y valores anómalos
mantienen la política anterior. Las fuentes comunes y las escalas documentales
ya calibradas conservan la ruta estable entre lectores. Los espacios de fuentes
de diseño pueden usar su avance real; Arial, Calibri, Times y otras familias de
sistema mantienen la heurística interoperable para evitar deriva acumulada.

Caché actual: `3.25.0-native-font-metrics`.

## Nombre interno tras fusionar fuentes (versión 1.14)

Después de fusionar subconjuntos de una misma fuente, el servicio vuelve a leer
la tabla OpenType `name` del archivo final. El nombre que se entrega a Word ya
no es el alias del primer subconjunto PDF, sino la familia interna que el lector
usa para asociar `w:rFonts` con `w:embedRegular`, `w:embedBold` y sus variantes.
Esto evita sustituciones silenciosas como `Quicksand` frente a `Quicksand Light`.

Caché actual: `3.26.0-internal-font-family`.
