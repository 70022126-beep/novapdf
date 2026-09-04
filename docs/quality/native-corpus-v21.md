# Auditoría local del motor: tablas, fuentes y composición gráfica

Fecha: 2026-09-02. Servicio 1.12.0; caché del cliente
`3.23.0-native-font-compositing-baselines`. No se contrataron servicios, no se
subieron PDFs a terceros y no se modificaron los documentos originales.

## Cambios comprobados

1. **Viñetas de celdas nativas.** Una fuente sustituta ensanchaba el símbolo
   y desplazaba el texto. Se usa un tabulador real con parada medida desde la
   celda, no desde la sangría. Solo símbolos aislados, texto nativo horizontal
   y geometría válida; OCR, numeración y separaciones estrechas mantienen su ruta.
2. **Máscaras de imágenes.** Se detectan `SMask`, `Mask` e `ImageMask`. La ruta
   posicionada utiliza composición PDF y un fondo sin texto nativo. Esto evita
   los bloques negros y los XObjects fuera de sus recortes observados en
   Cardano. No equivale a reconstruir cada gráfico como una forma editable.
3. **Sobreimpresión de caracteres.** Cardano dibuja letras en negro y luego
   las repite en su color final. Antes salían `CCoonntteexxttoo` y `0011`.
   Se conserva el último carácter coincidente, incluyendo su color. Se
   eliminaron 823 copias sobreimpresas en ese PDF; no se alteran repeticiones
   adyacentes ni sombras desplazadas. FENCYT y JERI: cero copias eliminadas.
4. **Fuentes realmente utilizadas.** El GUID hexadecimal en mayúsculas
   permite a LibreOffice cargar fuentes que antes sustituía silenciosamente.
   Una prueba con solo GUID cambió Viner Hand/Liberation Serif por
   Shrikhand/Amaranth/Canva Sans; una prueba con solo opciones de guardado no
   lo hizo. El test desofusca los bytes y comprueba identidad con la fuente
   original. Se siguen respetando permisos de incrustación.
5. **Tamaño y línea base de títulos.** Se elimina el límite OCR de 48 pt para
   texto digital medido (límite defensivo: 400 pt). Para una línea grande, de
   fuente incrustada, con línea base coherente y ascendente PDF menor del 68%
   del cuerpo, se estima el punto de apoyo al 80% de la caja Word exacta.
   Es una aproximación acotada, no una calibración universal de fuentes.
6. **Origen no nulo.** Todas las cajas exportadas, anclas y líneas base se
   normalizan al origen local. Cardano tenía un origen vertical de -7,92 pt;
   mezclarlo con el fondo renderizado desplazaba el texto. Hay regresiones
   para MediaBox no nulo, página recortada y geometría anidada.

Referencia externa del problema de compatibilidad: incidencia del propio
proyecto [docx #3120](https://github.com/dolanmiu/docx/issues/3120). La causa y
la solución concreta anteriores se comprobaron localmente; no se atribuyen
a esa incidencia. La ofuscación se conserva conforme al tipo de fuente
descrito por [Microsoft](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/1663dabc-5d98-463f-889e-bcd9b77c3d34).

## Comparación de documentos completos

Todos los resultados de esta tabla usan extracción nativa y diseño
posicionado mediante `scripts/benchmark-native-docx.mjs --pages=all`.
No es una ejecución OCR ni una prueba integral de la interfaz del navegador.
La métrica es la comparación visual interna a 120 dpi con LibreOffice 26.2.5.2,
no un porcentaje de exactitud, CER/WER ni comparación directa con iLovePDF.

| Documento | Páginas | Base | Resultado | Cambio |
| --- | ---: | ---: | ---: | ---: |
| FENCYT | 62/62 | 88,03 | 88,12 | +0,09 |
| Cardano | 16/16 | 65,37 | 86,10 | +20,73 |
| JERI | 8/8 | 91,61 | 91,52 | -0,09 |

Bases: `FENCYT-native-cell-geometry-v18`, `Cardano-native-v18-baseline`,
`JERI-native-v18-baseline`. Resultados: `FENCYT-quality-v21`,
`Cardano-quality-v21`, `JERI-quality-v20`. Todos bajo `tmp/deep-audit/`, con
DOCX y `.quality.json`. JERI no contiene títulos afectados por el último
ajuste de v21. La pequeña bajada de JERI se conserva en el informe; no se
presenta como una mejora.

| Dato | FENCYT v21 | Cardano v21 | JERI v20 |
| --- | ---: | ---: | ---: |
| Bytes DOCX | 764018 | 11780155 | 253360 |
| Ensamblado DOCX, ms | 1935 | 1050 | 246 |
| Validación visual, ms | 18890 | 10109 | 3240 |
| Placas gráficas limpias | 30 | 16 | 1 |

Los tiempos son etapas separadas; no representan conversión de extremo a
extremo. No se midió memoria máxima ni carga simultánea de usuarios.

### FENCYT: regresión por página y por celda

P. 11 pasa de 85,51 a 89,19 y p. 12 de 84,55 a 85,99. Hay cambios menores
negativos: p. 43, 90,44 -> 90,27; p. 44, 89,12 -> 88,96. No se ocultaron
esas variaciones detrás del promedio.

Auditoría de 936 cajas: 933 evaluables, 3 de altura cero omitidas y señaladas.
Cero diferencias de texto normalizado en las cajas evaluadas: no se detectó
pérdida ni duplicación de caracteres. Se mantienen 17 tablas Word y 5 fuentes
incrustadas. Normalizar espacios/ligaduras no comprueba la visibilidad de cada
glifo ni que las tablas sean cómodas para editar manualmente.

La muestra de viñetas v19 redujo el error horizontal de p. 11/fila 2/celda 2
de 0,622 a 0,315 pt. Después de activar las fuentes reales, el resultado
combinado v20/v21 es 0,610 pt. P. 12/fila 2/celda 2 empeora de 0,402 a
0,710 pt aunque mejora la puntuación visual de la página. Queda pendiente
ajustar métricas horizontales y espaciado de esas fuentes; no se declara
resuelto todo el problema de geometría.

### Cardano: el promedio no debe ocultar regresiones

La versión intermedia v20 mejoró el promedio a 73,80 pero empeoró p. 2, 8 y
15. No se aceptó ese resultado como final: el ajuste de títulos v21 recuperó
esas páginas. Frente a la base, ninguna de las 16 páginas termina con una
puntuación menor. Ejemplos:

| Página | Base v18 | Intermedia v20 | Final v21 |
| --- | ---: | ---: | ---: |
| 2 | 73,74 | 52,17 | 90,51 |
| 4 | 24,39 | 71,85 | 86,81 |
| 8 | 90,31 | 67,15 | 97,15 |
| 15 | 60,30 | 44,19 | 74,02 |
| 16 | 52,48 | 66,25 | 71,16 |

Las páginas 15 y 16 siguen siendo las más débiles. Persisten diferencias
en espaciado, negritas/fuentes de respaldo y sombras de títulos. Fórmulas y
texto contenido exclusivamente en imágenes permanecen gráficos en esta
prueba sin OCR: no se presentan como ecuaciones o texto Word editable.

## Corpus y controles

Se clasificaron las 170 páginas de los cinco PDFs aportados. Informe:
`tmp/deep-audit/corpus-classification-v20.json`.

| PDF | Digital | Escaneado | Híbrido |
| --- | ---: | ---: | ---: |
| FENCYT | 59 | 0 | 3 |
| Especificaciones técnicas | 0 | 32 | 0 |
| Memoria de arquitectura | 0 | 52 | 0 |
| JERI | 7 | 1 | 0 |
| Cardano | 13 | 1 | 2 |

Son etiquetas del clasificador, no anotaciones humanas de referencia.
Una página vacía o con apenas un número puede clasificarse como escaneada;
la clasificación no demuestra que OCR sea necesario. Los dos documentos
escaneados no recibieron una nueva evaluación CER/WER en esta iteración.

- 109 pruebas JavaScript y 38 Python aprobadas: 147 en total.
- ESLint, compilación de producción e integridad ZIP comprobados.
- Persiste el aviso de chunk mayor de 500 kB; no se ocultó aumentando el límite.
- Render canónico con `render_docx.py`. En FENCYT v20 se inspeccionaron las
  13 páginas distintas a v18: 4, 5, 11, 12, 15, 21, 24, 40, 41, 43, 44, 45, 48.
  Las otras 49 coincidían píxel a píxel con el render anterior.
- El render final FENCYT v21 coincide píxel a píxel con v20 en sus 62 páginas.
  La auditoría final `FENCYT-all-cells-v21.json` confirma 40153 caracteres
  normalizados coincidentes, cero diferencias y las mismas tres cajas no
  evaluables. Los ZIP finales de FENCYT y Cardano son íntegros.
- En Cardano se revisaron los fallos y sus correcciones, especialmente
  p. 2, 4, 8, 10, 14, 15 y 16; no se certifica revisión editorial completa.
- No se probó edición manual en Microsoft Word ni conversión concurrente
  de cientos de páginas. La calidad comercial equivalente sigue sin demostrarse.

## Próximos frentes delimitados

1. Métricas horizontales y estilos de fuentes incrustadas (regular/negrita),
   con énfasis en Cardano p. 15–16 y FENCYT p. 12.
2. Referencias de texto y tablas para los 84 folios escaneados, después
   medir OCR por región sin confundir confianza del motor con precisión.
3. Prueba integral desde la interfaz, edición real en Word y rendimiento
   de extremo a extremo con memoria máxima y cancelación.
