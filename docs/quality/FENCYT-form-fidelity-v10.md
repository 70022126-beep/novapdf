# FENCYT: conservación de formularios con pocos trazos

## Alcance y causa

La política de fondo posicionado exigía al menos 12 objetos vectoriales en
páginas sin tablas. FENCYT p. 34 solo tiene seis: se perdían las reglas de
identificación, Dirección y Teléfono. P. 32 y p. 36 tienen once; p. 38 tiene
dos, entre ellos el recuadro para huella. El motor ahora conserva también
páginas con un solo objeto. El texto permanece en elementos Word editables.
Los gráficos se conservan en el fondo PNG; no son controles interactivos.

Los subrayados y tachados inferidos de trazos PDF ahora llevan procedencia.
Cuando el fondo limpio visible ya contiene el trazo, no se duplica como
formato Word. Se mantienen al omitir el fondo, excluir imágenes o usar texto
sin fondo. El formato manual no se suprime.

## Evidencia y límites

- Caché: `3.19.0-sparse-vector-artwork`; servicio nativo sin cambio de API.
- Fuente: `FENCYT-bases-y-cronograma.pdf`.
- Candidato de QA: `tmp/deep-audit/FENCYT-form-fidelity-v10.docx`.
- Informe: mismo nombre con extensión `.quality.json`.
- Comparador: LibreOffice 26.2.5.2, 120 dpi; 62/62 páginas.
- Puntuación visual interna: 87,73 (v8) -> 87,82 (v10).
- P. 32: 84,43 -> 87,53 (+3,10).
- P. 34: 86,27 -> 86,97 (+0,70).
- P. 36: 89,80 -> 90,68 (+0,88).
- P. 38: 91,25 -> 92,23 (+0,98).
- P. 14 y p. 62 también mejoran. Pequeñas bajadas en p. 25 (-0,09),
  p. 27 (-0,19), p. 28 (-0,23) y p. 61 (-0,14).
- Tamaño final: 759191 bytes, frente a 748130 bytes (+1,48 %).
- 27 páginas usan fondo limpio; antes 19. Las páginas de texto puro no
  requieren uno. Se conserva la política anterior de tablas nativas.
- 2010 ms de ensamblado DOCX: no es el tiempo total de conversión.

Se renderizó el candidato completo con `render_docx.py`. Se inspeccionaron
a tamaño original las diez páginas modificadas (14, 25, 27, 28, 32, 34, 36,
38, 61, 62); las otras 52 son idénticas píxel por píxel al render v8 ya
revisado. ZIP íntegro y cinco archivos de fuentes incrustadas.

La sospecha previa de números de página recortados fue un falso positivo:
el recorte ampliado del PNG v8 de p. 34 y un segundo render PyMuPDF muestran
`194` completo. No se cambió la numeración. La rectificación también está
en la auditoría v8.

No se afirma fidelidad perfecta ni equivalencia con servicios comerciales.
El puntaje no es CER/WER ni un porcentaje de exactitud. Quedan ajustes
tipográficos y tablas densas, y esta prueba no mide calidad OCR en escaneos.

## Regresión

- 99 pruebas JavaScript y 24 Python aprobadas.
- ESLint, build de producción y `git diff --check` aprobados.
- Build mantiene el aviso previo de un chunk mayor de 500 kB.
- Nueva prueba sintética PDF: elimina texto del fondo sin borrar reglas
  que cruzan la máscara ni rellenos; mantiene el PDF original intacto.
- Prueba Word: una sola decoración con fondo, formato conservado sin fondo
  o con imágenes excluidas; el formato manual se mantiene en los tres casos.

## Próximo caso acotado

Revisar la continuación y el ajuste de texto en celdas densas, comparando
geometría y contenido por celda. No resolverlo reduciendo indiscriminadamente
el tamaño de letra ni declarando equivalencia visual a partir del promedio.
