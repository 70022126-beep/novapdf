# Motor NovaDOC 3.3: doble extracción nativa, visión neuronal y PDF a Word regional

## Doble extracción para PDFs digitales

Los documentos con texto seleccionable ya no dependen de un único parser.
PDF.js realiza la extracción primaria y el servicio local ejecuta pdfplumber
como verificación independiente. El segundo resultado incorpora geometría por
palabra, nombre y tamaño de fuente, color, rotación, objetos vectoriales,
imágenes, anotaciones y tablas. Un selector de cobertura evita reemplazar una
extracción primaria completa por otra parcial.

Las tablas detectadas por ambos motores se comparan por estructura, cantidad de
filas y columnas, densidad de celdas y cobertura. Esto permite conservar una
tabla de 39×6 celdas aunque una rejilla parcial tenga una puntuación base
ligeramente mayor. La conversión sigue disponible con PDF.js cuando el servicio
local no está iniciado.

## Proveedor neuronal local

`NeuralVisionProvider` intenta consultar un servicio que se ejecuta solamente
en `localhost`. Normaliza etiquetas, poligonos, confianza, orden de lectura,
tablas, escritura manual y formulas a un contrato estable de NovaPDF. Incluye:

- tiempo limite por pagina;
- cortacircuitos despues de un fallo;
- rechazo de endpoints externos por privacidad;
- retorno automatico a `VisualRegionSegmenter`;
- diagnostico de proveedor, modelo y motivo del respaldo.

El servicio opcional de `services/vision` usa PP-StructureV3. Su adaptador
convierte `parsing_res_list`, `table_res_list` y `formula_res_list` en regiones
NovaPDF. Las tablas HTML se reconstruyen como tablas Word y el LaTeX reconocido
se transforma en ecuaciones OMML editables con fracciones, radicales,
superindices y subindices.

La instalacion del runtime neuronal se mantiene fuera del frontend para poder
actualizar modelos y controladores GPU sin cambiar el conversor.

## Capa visual previa al OCR

NovaDOC 3.0 analiza el raster antes de reconocer texto. `VisualRegionSegmenter`
calcula densidad de tinta, color, varianza tonal y bordes; agrupa zonas y crea
un plan de enrutamiento para texto impreso y elementos que deben conservarse
visualmente, como firmas, sellos, manchas, rallones, fotografias y graficos.

El enrutamiento regional solo se activa cuando la cobertura y el numero de
regiones son estables. Si la segmentacion no alcanza los umbrales, el motor
regresa automaticamente al OCR global adaptativo.

En **Maxima fidelidad editable**, `EditableBackground` construye un fondo
limpio retirando las palabras OCR de confianza suficiente. Las palabras que
se superponen a firmas, sellos, manchas o rallones pequenos se mantienen en la
capa visual. Word recibe despues un cuadro anclado por cada linea, lo que evita
duplicar las letras originales y conserva mejor sus coordenadas.

La mesa de correccion incluye un mapa geometrico con colores distintos para
texto editable, tablas/formulas y regiones visuales protegidas. El informe
final muestra regiones visuales, elementos protegidos y palabras retiradas del
fondo.

## Canalización

1. PDF.js abre el documento y extrae la capa de texto de cada página.
2. pdfplumber verifica las páginas digitales y aporta tipografía, color, objetos vectoriales y una segunda reconstrucción de tablas.
3. `PageTypeDetector` clasifica la página como digital, escaneada o híbrida.
4. `RegionIntelligence` clasifica texto, tablas, fotografías, gráficos, firmas, sellos, fórmulas, formularios, títulos, notas y leyendas. Cada región conserva estrategia, coordenadas, confianza y orden de lectura.
5. Las páginas digitales usan el mejor texto nativo. Las escaneadas usan OCR adaptativo español/inglés. Las híbridas aplican OCR a regiones de imagen y fusionan el resultado sin duplicar palabras nativas.
6. El OCR corrige inclinación, prueba umbral adaptativo y alto contraste, intenta orientación a 90° cuando la confianza es crítica, admite diccionario especializado y selecciona el mejor intento automáticamente. La escritura manual dispone de un intento adicional opcional y explícitamente experimental.
7. `PageAnalyzer` y `ProfessionalTableAnalyzer` reconstruyen párrafos, columnas, celdas combinadas, tipos numéricos, bordes, encabezados de tabla y campos de formulario.
8. `DocumentStructureAnalyzer` relaciona páginas para detectar capítulos, encabezados repetidos, continuaciones de párrafo y tablas que siguen en la página posterior.
9. `WordDocumentRenderer` genera elementos DOCX editables: texto con estilo, tablas profesionales, imágenes flotantes, cuadros posicionados, encabezados, pies, márgenes y saltos.

## Validación del doble motor con PDFs reales

| Página | Antes | NovaDOC 3.3 |
| --- | --- | --- |
| FENCYT 3 | Tabla parcial de 3×5 | Tabla completa de 7×5 |
| FENCYT 29 | Formulario de 39×4 | Formulario de 39×6 |
| FENCYT 40 | Rúbrica parcial de 4×5 | Rúbrica de 8×5 |

La interfaz procesó las tres páginas, informó tres verificaciones por doble
motor, seleccionó tres tablas de pdfplumber y generó un DOCX editable sin
errores de consola. En el PDF escaneado el extractor nativo devolvió cero
caracteres, por lo que NovaPDF mantuvo correctamente PP-StructureV3 y sus 21
regiones visuales.

## Modos

- **Máxima edición:** prioriza texto y estructura modificables. Conserva la geometría y estilos disponibles, pero una composición PDF muy gráfica puede variar en Word.
- **Máxima fidelidad editable:** usa cuadros de texto y tablas con coordenadas absolutas, imágenes flotantes y una capa visual de fondo solo cuando una página escaneada la necesita. El texto OCR sigue siendo editable.
- **Copia visual exacta:** inserta una captura PNG por página. Es el modo de respaldo cuando la apariencia importa más que la edición.

## Documentos extensos

- PDF.js y Tesseract procesan en workers; el OCR queda limitado a una tarea activa para controlar memoria.
- Se procesa y libera un canvas por página.
- El usuario puede elegir rangos (`1-5,8,12`), pausar en límites seguros y cancelar durante OCR.
- La caché LRU guarda páginas terminadas para reanudar tras cancelación o fallo.
- El límite de megapíxeles y de caché es configurable, y la interfaz calcula tiempo restante.

## Mesa de corrección

Antes del DOCX se puede abrir la vista original/reconstrucción, editar el texto, resaltar OCR con confianza menor a 70, cambiar la estrategia por página y excluir encabezado, pie o imágenes. Una transcripción de referencia calcula CER y WER en tiempo real.

## Métricas

La interfaz informa clasificación, método, idioma OCR, regiones, formularios, palabras, columnas, tablas, páginas recuperadas de caché, calidad estimada, tiempo, páginas por minuto, pico de render y tamaño del DOCX.

La calidad estimada no es una tasa de exactitud absoluta. Para calcular CER/WER real se necesita una transcripción de referencia y se debe comparar el texto extraído con esa referencia.

`EvaluationMetrics` y `ScientificBenchmark` calculan CER, WER, precisión de celdas, orden de lectura, IoU geométrico, memoria máxima, tiempo por página y tamaño del DOCX. El corpus debe separar documentos digitales, escaneados, híbridos, formularios, tablas sin bordes y composiciones multicolumna; no se deben versionar PDFs con datos personales.

## Validación local del 15 de agosto de 2026

Se inspeccionó una colección de 30 PDFs reales y se ejecutaron pruebas completas con muestras digitales y escaneadas. Los nombres se omiten para no incluir datos personales en el repositorio.

| Prueba | Resultado |
| --- | --- |
| Clasificación de 30 primeras páginas | 25 digitales, 5 escaneadas, 0 híbridas; 798 ms en total |
| PDF digital de una página, Máxima edición | Texto nativo, 3 imágenes recuperadas, 99% de calidad estimada, 0.3 s, pico de 2 MP, DOCX de 85.4 KB |
| PDF escaneado de una página, Máxima edición | OCR, 76 palabras, 84% de calidad estimada, 3.5 s, pico de 4.51 MP, DOCX de 11.1 KB |
| PDF escaneado de una página, Copia visual exacta | Fidelidad visual completa, 0.4 s, pico de 2 MP, DOCX de 1.64 MB |

El caso híbrido se cubre mediante pruebas automatizadas de clasificación y fusión espacial. La colección real muestreada no contenía una primera página híbrida según los umbrales actuales.

## Validación de NovaDOC 2.0

La interfaz completa se volvió a probar con una muestra sintética digital y una página escaneada generada desde imagen. Máxima edición y Máxima fidelidad editable produjeron DOCX sin errores de consola. La muestra digital detectó 9 regiones y 3 campos de formulario; la escaneada ejecutó OCR multilingüe en 3.0 s, reconoció 24 regiones, obtuvo 86% de calidad estimada, consumió un canvas máximo de 3.47 MP y generó un DOCX de 11.3 KB. Las cifras son diagnósticas, no reemplazan CER/WER sobre un corpus etiquetado.

## Repetir el benchmark de clasificación

```powershell
npm run benchmark:pdf -- --max-pages=5 "C:\ruta\muestra-1.pdf" "C:\ruta\muestra-2.pdf"
```

Este benchmark mide apertura, extracción nativa, clasificación, memoria y velocidad. Las métricas completas de OCR y DOCX aparecen en la interfaz de conversión.
