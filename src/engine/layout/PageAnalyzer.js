// ============================================
// NOVAPDF PAGE ANALYZER 1.0
// ============================================
//
// Analizador estructural de páginas OCR.
//
// Responsabilidades:
//
// - Analizar dimensiones de página
// - Analizar palabras
// - Analizar líneas
// - Analizar bloques
// - Analizar párrafos
// - Detectar encabezado
// - Detectar pie de página
// - Detectar columnas
// - Detectar posibles tablas
// - Detectar zonas de contenido
// - Calcular densidad de texto
// - Calcular estadísticas espaciales
// - Preparar estructura para NovaDOC
//
// IMPORTANTE:
//
// OCREngine = reconocimiento
// PageAnalyzer = interpretación espacial
// NovaDOC = reconstrucción documental
//
// ============================================


// ============================================
// UTILIDADES
// ============================================

function number(
    value,
    fallback = 0
) {

    const n =
        Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;

}


// ============================================
// ORDENAR PALABRAS
// ============================================

function sortWords(
    words = []
) {

    return [...words]
        .sort(
            (
                a,
                b
            ) => {

                const ay =
                    number(a.y);

                const by =
                    number(b.y);

                const tolerance =
                    Math.max(
                        3,
                        Math.min(
                            number(a.height),
                            number(b.height)
                        ) * 0.45
                    );


                if (
                    Math.abs(
                        ay - by
                    ) > tolerance
                ) {

                    return ay - by;

                }


                return (
                    number(a.x) -
                    number(b.x)
                );

            }
        );

}


// ============================================
// TEXTO
// ============================================

function cleanText(
    text
) {

    return String(
        text ?? ""
    )
        .replace(/\s+/g, " ")
        .trim();

}


// ============================================
// UNIR PALABRAS
// ============================================

function joinWords(
    words = []
) {

    return sortWords(words)
        .map(
            word =>
                cleanText(
                    word.text
                )
        )
        .filter(Boolean)
        .join(" ");

}


// ============================================
// BOUNDING BOX
// ============================================

function getBoundingBox(
    items = []
) {

    if (
        !items.length
    ) {

        return {

            x: 0,
            y: 0,
            width: 0,
            height: 0,

        };

    }


    const minX =
        Math.min(
            ...items.map(
                item =>
                    number(item.x)
            )
        );


    const minY =
        Math.min(
            ...items.map(
                item =>
                    number(item.y)
            )
        );


    const maxX =
        Math.max(
            ...items.map(
                item =>
                    number(item.x) +
                    number(item.width)
            )
        );


    const maxY =
        Math.max(
            ...items.map(
                item =>
                    number(item.y) +
                    number(item.height)
            )
        );


    return {

        x: minX,

        y: minY,

        width:
            Math.max(
                0,
                maxX - minX
            ),

        height:
            Math.max(
                0,
                maxY - minY
            ),

    };

}


// ============================================
// CENTRO
// ============================================

function getCenter(
    box
) {

    return {

        x:
            box.x +
            box.width / 2,

        y:
            box.y +
            box.height / 2,

    };

}


// ============================================
// DETECTAR ENCABEZADO
// ============================================

function detectHeader(
    lines,
    pageHeight
) {

    const limit =
        pageHeight * 0.15;


    return lines.filter(
        line =>
            number(line.bbox?.y ?? line.y) <=
            limit
    );

}


// ============================================
// DETECTAR PIE DE PÁGINA
// ============================================

function detectFooter(
    lines,
    pageHeight
) {

    const limit =
        pageHeight * 0.85;


    return lines.filter(
        line =>
            number(line.bbox?.y ?? line.y) >=
            limit
    );

}


// ============================================
// OBTENER CAJA DE LÍNEA
// ============================================

function lineBox(
    line
) {

    if (
        line.bbox
    ) {

        return {

            x:
                number(
                    line.bbox.x
                ),

            y:
                number(
                    line.bbox.y
                ),

            width:
                number(
                    line.bbox.width
                ),

            height:
                number(
                    line.bbox.height
                ),

        };

    }


    return getBoundingBox(
        line.words || []
    );

}


// ============================================
// NORMALIZAR LÍNEAS
// ============================================

function normalizeLines(
    lines = [],
    words = []
) {

    if (
        lines.length
    ) {

        return lines.map(
            (
                line,
                index
            ) => {

                const lineWords =
                    Array.isArray(
                        line.words
                    )
                        ? line.words
                        : [];


                const box =
                    lineBox(
                        line
                    );


                return {

                    id:
                        `line-${index + 1}`,

                    index,

                    text:
                        cleanText(
                            line.text ||
                            joinWords(
                                lineWords
                            )
                        ),

                    words:
                        lineWords,

                    bbox:
                        box,

                    center:
                        getCenter(
                            box
                        ),

                    wordCount:
                        lineWords.length,

                };

            }
        );

    }


    // ========================================
    // RESPALDO:
    // CONSTRUIR LÍNEAS DESDE PALABRAS
    // ========================================

    const result = [];

    const tolerance = 8;


    sortWords(words)
        .forEach(
            word => {

                const y =
                    number(
                        word.y
                    );


                let current =
                    result.find(
                        line =>
                            Math.abs(
                                line.y -
                                y
                            ) <= tolerance
                    );


                if (!current) {

                    current = {

                        y,

                        words: [],

                    };

                    result.push(
                        current
                    );

                }


                current.words.push(
                    word
                );

            }
        );


    return result
        .sort(
            (
                a,
                b
            ) =>
                a.y - b.y
        )
        .map(
            (
                line,
                index
            ) => {

                const sorted =
                    sortWords(
                        line.words
                    );


                const box =
                    getBoundingBox(
                        sorted
                    );


                return {

                    id:
                        `line-${index + 1}`,

                    index,

                    text:
                        joinWords(
                            sorted
                        ),

                    words:
                        sorted,

                    bbox:
                        box,

                    center:
                        getCenter(
                            box
                        ),

                    wordCount:
                        sorted.length,

                };

            }
        );

}

// ============================================
// DETECTAR PÁRRAFOS
// ============================================

function detectParagraphs(
    lines = []
) {

    if (!lines.length) {
        return [];
    }

    const paragraphs = [];

    let current = [];

    // Distancia máxima entre líneas
    // para considerarlas parte del mismo párrafo.
    const getLineGap = (
        previous,
        currentLine
    ) => {

        const previousBottom =
            previous.bbox.y +
            previous.bbox.height;

        const currentTop =
            currentLine.bbox.y;

        return Math.max(
            0,
            currentTop - previousBottom
        );
    };


    for (
        let i = 0;
        i < lines.length;
        i++
    ) {

        const line =
            lines[i];


        if (
            !line ||
            !line.text
        ) {
            continue;
        }


        if (
            current.length === 0
        ) {

            current.push(
                line
            );

            continue;
        }


        const previous =
            current[
                current.length - 1
            ];


        const gap =
            getLineGap(
                previous,
                line
            );


        const previousHeight =
            number(
                previous.bbox?.height
            );


        const currentHeight =
            number(
                line.bbox?.height
            );


        const averageHeight =
            (
                previousHeight +
                currentHeight
            ) / 2;


        const maxGap =
    Math.max(
        6,
        averageHeight * 1.60
    );


        const previousX =
            number(
                previous.bbox?.x
            );


        const currentX =
            number(
                line.bbox?.x
            );


        const xDifference =
            Math.abs(
                currentX -
                previousX
            );


        const indentationLimit =
            Math.max(
                25,
                averageHeight * 3
            );


        const isContinuation =
            gap <= maxGap &&
            xDifference <= indentationLimit;


        if (
            isContinuation
        ) {

            current.push(
                line
            );

        } else {

            paragraphs.push(
                createParagraph(
                    current
                )
            );

            current = [
                line
            ];

        }

    }


    if (
        current.length
    ) {

        paragraphs.push(
            createParagraph(
                current
            )
        );

    }


    return paragraphs;

}


// ============================================
// CREAR PÁRRAFO
// ============================================

function createParagraph(
    lines = []
) {

    const sortedLines =
        [...lines].sort(
            (
                a,
                b
            ) =>
                a.center.y -
                b.center.y
        );


    const words =
        sortedLines.flatMap(
            line =>
                line.words || []
        );


    const bbox =
        getBoundingBox(
            words
        );


    const text =
        sortedLines
            .map(
                line =>
                    cleanText(
                        line.text
                    )
            )
            .filter(Boolean)
            .join(" ");


    return {

        id:
            `paragraph-${Math.random()
                .toString(36)
                .slice(2, 10)}`,

        text,

        lines:
            sortedLines,

        words,

        bbox,

        center:
            getCenter(
                bbox
            ),

        lineCount:
            sortedLines.length,

        wordCount:
            words.length,

    };

}


// ============================================
// DETECTAR BLOQUES
// ============================================

function detectBlocks(
    paragraphs = [],
    pageWidth = 0,
    pageHeight = 0
) {

    if (
        !paragraphs.length
    ) {

        return [];

    }


    const blocks = [];


    for (
        let i = 0;
        i < paragraphs.length;
        i++
    ) {

        const paragraph =
            paragraphs[i];


        if (
            !paragraph.text
        ) {

            continue;

        }


        const text =
            paragraph.text;


        const words =
            paragraph.words || [];


        const averageHeight =
            words.length
                ? words.reduce(
                    (
                        total,
                        word
                    ) =>
                        total +
                        number(
                            word.height
                        ),
                    0
                ) /
                words.length
                : 0;


        const bbox =
    paragraph.bbox || {};

const paragraphWidth =
    number(bbox.width);

const pageWidthRatio =
    pageWidth > 0
        ? paragraphWidth / pageWidth
        : 0;


// ========================================
// CARACTERÍSTICAS GEOMÉTRICAS
// ========================================

const x =
    number(bbox.x);

const y =
    number(bbox.y);

const width =
    number(bbox.width);

const height =
    number(bbox.height);


// ========================================
// POSICIÓN RELATIVA
// ========================================

const nearTop =
    pageHeight > 0 &&
    y < pageHeight * 0.15;

const nearBottom =
    pageHeight > 0 &&
    (
        y + height
    ) > pageHeight * 0.85;


// ========================================
// PATRONES DE TÍTULOS
// ========================================

const numberedSection =
    /^(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s+/i.test(
        text
    );


const sectionTitle =
    /^\d+(?:\.\d+)*\.?\s+[A-ZÁÉÍÓÚÑ]/.test(
        text
    );


const veryShort =
    text.length <= 100;


const mediumText =
    text.length > 100 &&
    text.length <= 220;


// ========================================
// MAYÚSCULAS
// ========================================

const letters =
    text.match(
        /[A-Za-zÁÉÍÓÚáéíóúÑñ]/g
    ) || [];

const upperLetters =
    text.match(
        /[A-ZÁÉÍÓÚÑ]/g
    ) || [];


const uppercaseRatio =
    letters.length
        ? upperLetters.length /
          letters.length
        : 0;


const mostlyUppercase =
    uppercaseRatio >= 0.75;


// ========================================
// CENTRADO
// ========================================

const pageCenter =
    pageWidth / 2;

const paragraphCenter =
    x +
    width / 2;

const centerDistance =
    Math.abs(
        paragraphCenter -
        pageCenter
    );

const centered =
    pageWidth > 0 &&
    centerDistance <
        pageWidth * 0.12;


// ========================================
// CLASIFICACIÓN
// ========================================

let titleScore = 0;


if (
    numberedSection
) {
    titleScore += 4;
}


if (
    sectionTitle
) {
    titleScore += 3;
}


if (
    mostlyUppercase
) {
    titleScore += 2;
}


if (
    veryShort
) {
    titleScore += 1;
}


if (
    centered
) {
    titleScore += 2;
}


if (
    nearTop
) {
    titleScore += 1;
}


if (
    mediumText === false
) {
    titleScore += 1;
}


const isTitle =
    titleScore >= 4;


        // ------------------------------------
        // LISTAS
        // ------------------------------------

        const isList =
            /^[•●▪◦*-]\s+/.test(
                text
            ) ||
            /^\d+[.)]\s+/.test(
                text
            );


        // ------------------------------------
        // TIPO
        // ------------------------------------

        let type =
    "paragraph";


// ========================================
// TÍTULO
// ========================================

if (
    isTitle
) {

    type =
        "title";

}


// ========================================
// LISTA
// ========================================

else if (
    isList
) {

    type =
        "list-item";

}


// ========================================
// ENCABEZADO
// ========================================

else if (
    nearTop &&
    mostlyUppercase &&
    veryShort
) {

    type =
        "header";

}


// ========================================
// PIE DE PÁGINA
// ========================================

else if (
    nearBottom &&
    veryShort
) {

    type =
        "footer";

}


        blocks.push({

            id:
                `block-${i + 1}`,

            type,
            role:
    type,

titleScore,

position: {

    x,
    y,
    width,
    height,

},

geometry: {

    pageWidth,
    pageHeight,

    widthRatio:
        Number(
            pageWidthRatio.toFixed(4)
        ),

    centered,

    nearTop,

    nearBottom,

},

classification: {

    numberedSection,

    sectionTitle,

    mostlyUppercase,

    uppercaseRatio:
        Number(
            uppercaseRatio.toFixed(3)
        ),

    centered,

},

            text,

            paragraphs: [
                paragraph
            ],

            lines:
                paragraph.lines,

            words:
                paragraph.words,

            bbox:
                paragraph.bbox,

            center:
                paragraph.center,

            lineCount:
                paragraph.lineCount,

            wordCount:
                paragraph.wordCount,

            averageWordHeight:
                Number(
                    averageHeight.toFixed(2)
                ),

        });

    }


    return blocks;

}
// ============================================
// DETECCIÓN INTELIGENTE DE COLUMNAS
// ============================================

function detectColumns(
    lines = [],
    pageWidth = 0
) {

    if (
    !lines.length ||
    !pageWidth
) {
    return {
        count: 0,
        columns: [],
    };
}


    // ========================================
    // 1. OBTENER INTERVALOS HORIZONTALES
    // ========================================

    const intervals =
        lines
            .map(
                line => {

                    const bbox =
                        line.bbox || {};

                    const x =
                        number(
                            bbox.x
                        );

                    const width =
                        number(
                            bbox.width
                        );

                    return {

                        line,

                        x,

                        right:
                            x + width,

                        width,

                    };

                }
            )
            .filter(
                item =>
                    item.width > 0
            );


 if (
    !intervals.length
) {
    return {
        count: 0,
        columns: [],
    };
}


    // ========================================
    // 2. DETECTAR ESPACIOS VACÍOS
    // ========================================

    const boundaries = [];


    for (
        let i = 0;
        i < intervals.length;
        i++
    ) {

        const current =
            intervals[i];


        for (
            let j = i + 1;
            j < intervals.length;
            j++
        ) {

            const next =
                intervals[j];


            const gap =
                next.x -
                current.right;


            if (
                gap >
                pageWidth * 0.06
            ) {

                boundaries.push({

                    x:
                        current.right,

                    gap,

                });

            }

        }

    }


    // ========================================
    // 3. AGRUPAR LÍNEAS POR ZONA X
    // ========================================

    const sorted =
        [...intervals].sort(
            (
                a,
                b
            ) =>
                a.x -
                b.x
        );


    const groups = [];


    for (
        const item of sorted
    ) {

        if (
            !groups.length
        ) {

            groups.push({

                minX:
                    item.x,

                maxX:
                    item.right,

                lines: [
                    item.line
                ],

            });

            continue;

        }


        const current =
            groups[
                groups.length - 1
            ];


        const tolerance =
            Math.max(
                20,
                pageWidth * 0.025
            );


        if (
            item.x <=
            current.maxX +
            tolerance
        ) {

            current.maxX =
                Math.max(
                    current.maxX,
                    item.right
                );

            current.lines.push(
                item.line
            );

        } else {

            groups.push({

                minX:
                    item.x,

                maxX:
                    item.right,

                lines: [
                    item.line
                ],

            });

        }

    }


    // ========================================
    // 4. FILTRAR GRUPOS PEQUEÑOS
    // ========================================

    const validGroups =
    groups.filter(
        group =>
            group.lines.length >= 2 &&
            (group.maxX - group.minX) >=
                pageWidth * 0.15
    );


    // ========================================
    // 5. SI SOLO HAY UNA COLUMNA
    // ========================================
if (
    validGroups.length <= 1
) {

    return {

        count: 1,

        columns: [{

            id:
                "column-1",

            index:
                0,

            x:
                0,

            width:
                pageWidth,

            lines:
                [...lines],

            lineCount:
                lines.length,

            confidence:
                0.95,

        }],

    };

}


    // ========================================
    // 6. CONSTRUIR COLUMNAS
    // ========================================

    const columns =
        validGroups.map(
            (
                group,
                index
            ) => {

                const x =
                    Math.max(
                        0,
                        group.minX
                    );

                const right =
                    Math.min(
                        pageWidth,
                        group.maxX
                    );

                return {

                    id:
                        `column-${index + 1}`,

                    index,

                    x,

                    width:
                        right - x,

                    right,

                    lines:
                        group.lines
                            .sort(
                                (
                                    a,
                                    b
                                ) =>
                                    a.center.y -
                                    b.center.y
                            ),

                    lineCount:
                        group.lines.length,

                    confidence:
                        0.85,

                };

            }
        );


    // ========================================
    // 7. ORDENAR COLUMNAS
    // ========================================

    columns.sort(
        (
            a,
            b
        ) =>
            a.x -
            b.x
    );


    // ========================================
    // 8. REINDEXAR
    // ========================================

    columns.forEach(
        (
            column,
            index
        ) => {

            column.index =
                index;

            column.id =
                `column-${index + 1}`;

        }
    );


    return {

    count:
        columns.length,

    columns,

};

}
// ============================================
// EVALUAR ESTRUCTURA REAL DE TABLA
// ============================================

function evaluateTableStructure(
    lines = []
) {

    if (
        lines.length < 3
    ) {

        return 0;

    }


    // ========================================
    // 1. CANTIDAD DE PALABRAS POR LÍNEA
    // ========================================

    const wordCounts =
        lines.map(
            line =>
                Array.isArray(
                    line?.words
                )
                    ? line.words.length
                    : 0
        );


    const validCounts =
        wordCounts.filter(
            count =>
                count >= 2
        );


    if (
        validCounts.length < 3
    ) {

        return 0;

    }


    const averageWords =
        validCounts.reduce(
            (
                total,
                count
            ) =>
                total + count,
            0
        ) /
        validCounts.length;


    // ========================================
    // 2. VARIACIÓN DE PALABRAS
    // ========================================

    const variance =
        validCounts.reduce(
            (
                total,
                count
            ) =>
                total +
                Math.abs(
                    count -
                    averageWords
                ),
            0
        ) /
        validCounts.length;


    const consistency =
        1 -
        Math.min(
            variance /
            Math.max(
                averageWords,
                1
            ),
            1
        );


    // ========================================
    // 3. POSICIONES X REPETIDAS
    // ========================================

    const xMap =
        new Map();


    lines.forEach(
        line => {

            const words =
                Array.isArray(
                    line?.words
                )
                    ? line.words
                    : [];


            const linePositions =
                new Set();


            words.forEach(
                word => {

                    const x =
                        Math.round(
                            number(
                                word?.x
                            ) /
                            20
                        ) *
                        20;


                    linePositions.add(
                        x
                    );

                }
            );


            linePositions.forEach(
                x => {

                    xMap.set(
                        x,
                        (
                            xMap.get(x) ||
                            0
                        ) + 1
                    );

                }
            );

        }
    );

    // ========================================
    // COLUMNAS REPETIDAS ENTRE VARIAS LÍNEAS
    // ========================================

   const repeatedColumns =
    Array.from(
        xMap.values()
    )
        .filter(
            count =>
                count >= 3
        )
        .length;

const maxXFrequency =
    xMap.size > 0
        ? Math.max(
            ...xMap.values()
        )
        : 0;


const dominantXRatio =
    lines.length > 0
        ? maxXFrequency /
          lines.length
        : 0;

const dominantColumnCount =
    Array.from(
        xMap.values()
    )
        .filter(
            count =>
                lines.length > 0 &&
                count / lines.length > 0.55
        )
        .length;

const dominantXPenalty =
    dominantXRatio > 0.55 &&
    dominantColumnCount < 2
        ? 0.45
        : 1;

const columnScore =
    Math.min(
        repeatedColumns / 3,
        1
    );


    // ========================================
    // 4. DENSIDAD DE LÍNEAS
    // ========================================

  const lineDensity =
    Math.min(
        lines.length / 15,
        1
    );

    // ========================================
    // SCORE FINAL
    // ========================================

    const score =

    (
        (
            consistency *
            0.20
        ) +

        (
            columnScore *
            0.55
        ) +

        (
            lineDensity *
            0.25
        )
    ) *
    dominantXPenalty;

    return Math.max(
        0,
        Math.min(
            1,
            score
        )
    );

}
    // ============================================
// SELECCIONAR MEJOR TRAMO DE TABLA
// ============================================

// ============================================
// SELECCIONAR MEJOR TRAMO DE TABLA
// ============================================

// ============================================
// SELECCIONAR MEJOR TRAMO DE TABLA
// ============================================

// ============================================
// SELECCIONAR MEJOR TRAMO DE TABLA
// ============================================

function selectBestTableLines(
    lines = []
) {

    if (
        lines.length < 4
    ) {

        return lines;

    }


    let bestLines = [];

    let bestQuality =
        -Infinity;


    // ========================================
    // BUSCAR DESDE EL FINAL HACIA EL INICIO
    // ========================================

    for (
        let start =
            lines.length - 4;

        start >= 0;

        start--
    ) {

        const candidateLines =
            lines.slice(
                start
            );


        const score =
            evaluateTableStructure(
                candidateLines
            );

let wideGapLines = 0;

candidateLines.forEach(
    line => {

        const words =
            [...(
                line.words ||
                []
            )]
                .sort(
                    (
                        a,
                        b
                    ) =>
                        number(a.x) -
                        number(b.x)
                );


        let lineLargeGaps = 0;


        for (
            let i = 1;
            i < words.length;
            i++
        ) {

            const previous =
                words[i - 1];

            const current =
                words[i];


            const previousRight =
                number(
                    previous.x
                ) +
                number(
                    previous.width
                );


            const gap =
                number(
                    current.x
                ) -
                previousRight;


            if (
                gap >= 50
            ) {

                lineLargeGaps++;

            }

        }


        if (
            lineLargeGaps >= 2
        ) {

            wideGapLines++;

        }

    }
);


const wideGapRatio =
    candidateLines.length > 0
        ? wideGapLines /
          candidateLines.length
        : 0;


        // ========================================
        // POSICIONES X DEL CANDIDATO
        // ========================================

        const candidateXMap =
            new Map();


        candidateLines.forEach(
            line => {

                const linePositions =
                    new Set();


                (
                    line.words ||
                    []
                ).forEach(
                    word => {

                        const x =
                            Math.round(
                                number(
                                    word?.x
                                ) /
                                20
                            ) *
                            20;


                        linePositions.add(
                            x
                        );

                    }
                );


                linePositions.forEach(
                    x => {

                        candidateXMap.set(
                            x,
                            (
                                candidateXMap.get(x) ||
                                0
                            ) + 1
                        );

                    }
                );

            }
        );


        // ========================================
        // DOMINANCIA X
        // ========================================

        const maxXFrequency =
            candidateXMap.size > 0
                ? Math.max(
                    ...candidateXMap.values()
                )
                : 0;


        const dominantXRatio =
            candidateLines.length > 0
                ? maxXFrequency /
                  candidateLines.length
                : 1;


        const dominantColumnCount =
            Array.from(
                candidateXMap.values()
            )
                .filter(
                    count =>
                        candidateLines.length > 0 &&
                        count /
                        candidateLines.length >
                        0.55
                )
                .length;


        // ========================================
        // COLUMNAS REPETIDAS
        // ========================================

        const repeatedColumns =
            Array.from(
                candidateXMap.values()
            )
                .filter(
                    count =>
                        count >= 3
                )
                .length;


        // ========================================
        // CRITERIOS DE ACEPTACIÓN
        // ========================================

        if (
            score < 0.80
        ) {

            continue;

        }


        if (
            repeatedColumns < 3
        ) {

            continue;

        }


        if (
            dominantXRatio > 0.55 &&
            dominantColumnCount < 2
        ) {

            continue;

        }
if (
    wideGapRatio < 0.50
) {

    continue;

}

        const quality =
            score * 0.80 +
            wideGapRatio * 0.20;


        if (
            quality > bestQuality ||
            (
                quality === bestQuality &&
                candidateLines.length >
                bestLines.length
            )
        ) {

            bestQuality =
                quality;

            bestLines =
                candidateLines;

        }

    }


    // ========================================
    // RESPALDO
    // ========================================

    return bestLines;

}
// ============================================
// DETECTAR POSIBLES TABLAS
// ============================================
//
// Esta primera versión utiliza señales espaciales:
//
// - muchas líneas alineadas
// - varias columnas
// - repetición de posiciones X
// - texto compacto
//
// No afirma todavía que sea una tabla real.
// Devuelve "candidatos".
//
// ============================================

function detectTableCandidates(
    lines = []
) {

    const candidates = [];

   if (
    !Array.isArray(lines) ||
    lines.length < 3
) {

    return candidates;

}



    // ============================================
    // ANALIZAR CADA LÍNEA
    // ============================================

    const analyzedLines =
        lines
            .map(
                line => {

                    const words =
                        Array.isArray(
                            line?.words
                        )
                            ? line.words
                            : [];


                    const validWords =
                        words.filter(
                            word =>
                                number(
                                    word?.x
                                ) >= 0
                        );


                    return {

                        line,

                        words:
                            validWords,

                        wordCount:
                            validWords.length,

                    };

                }
            )
            .filter(
                item =>
                    item.wordCount >= 2
            );


    if (
        analyzedLines.length < 3
    ) {

        return candidates;

    }


    // ============================================
    // BUSCAR GRUPOS DE LÍNEAS
    // ============================================

    let current = [];


    const flushCurrent = () => {

        if (
            current.length < 3
        ) {

            current = [];

            return;

        }


       const candidateLines =
    selectBestTableLines(
        current.map(
            item =>
                item.line
        )
    );

        if (
            candidateLines.length < 4
        ) {

            current = [];

            return;

        }
        const candidate =
    createTableCandidate(
        candidateLines
    );

        const tableStructure =
    analyzeTableGrid(
        candidateLines
    );
    candidate.structure =
    tableStructure;

    candidate.caption =
    tableStructure.caption;

candidate.tableTitle =
    tableStructure.tableTitle;

candidate.headers =
    tableStructure.normalizedHeaders ||
    tableStructure.headers ||
    [];

candidate.rows =
    tableStructure.rows || [];

candidate.total =
    tableStructure.total || null;

candidate.columnAnchors =
    tableStructure.columnAnchors || [];
        // ========================================
        // VALIDACIÓN REAL DE TABLA
        // ========================================

        const tableScore =
    evaluateTableStructure(
        candidateLines
    );


        if (
            tableScore >= 0.80
        ) {

            candidate.structuralScore =
                Number(
                    (
                        tableScore *
                        100
                    ).toFixed(2)
                );


            candidate.confidence =
                Math.min(
                    100,
                    Math.round(
                        50 +
                        tableScore * 50
                    )
                );


            candidates.push(
                candidate
            );

        }


        current = [];

    };


    // ============================================
    // AGRUPAR LÍNEAS ESPACIALMENTE CERCANAS
    // ============================================

    for (
        let i = 0;
        i < analyzedLines.length;
        i++
    ) {

        const item =
            analyzedLines[i];


        if (
            current.length === 0
        ) {

            current.push(
                item
            );

            continue;

        }


        const previous =
            current[
                current.length - 1
            ];


        const previousLine =
            previous.line;


        const currentLine =
            item.line;


        const distance =
            number(
                currentLine?.center?.y
            ) -
            number(
                previousLine?.center?.y
            );


        const previousHeight =
            number(
                previousLine?.bbox?.height
            );


        const currentHeight =
            number(
                currentLine?.bbox?.height
            );


        const averageHeight =
            (
                previousHeight +
                currentHeight
            ) / 2;


        const maxDistance =
            Math.max(
                10,
                averageHeight * 3
            );


        if (
            distance <=
            maxDistance
        ) {

            current.push(
                item
            );

        }
        else {

            flushCurrent();

            current.push(
                item
            );

        }

    }


  flushCurrent();


return candidates;
}
// ============================================
// CREAR CANDIDATO DE TABLA
// ============================================

function createTableCandidate(
    lines
) {

    const xPositions = [];


    lines.forEach(
        line => {

            (
                line.words ||
                []
            ).forEach(
                word => {

                    xPositions.push(
                        number(
                            word.x
                        )
                    );

                }
            );

        }
    );


    const rounded =
        xPositions.map(
            x =>
                Math.round(
                    x / 10
                ) * 10
        );


    const frequency =
        new Map();


    rounded.forEach(
        x => {

            frequency.set(
                x,
                (
                    frequency.get(x) ||
                    0
                ) + 1
            );

        }
    );


    const columns =
        Array.from(
            frequency.entries()
        )
            .filter(
                (
                    [
                        ,
                        count
                    ]
                ) =>
                    count >= 2
            )
            .map(
                (
                    [
                        x
                    ]
                ) =>
                    x
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    a - b
            );


    const box =
        getBoundingBox(
            lines.flatMap(
                line =>
                    line.words || []
            )
        );


    return {

        type:
            "table-candidate",

        confidence:
            Math.min(
                100,
                50 +
                columns.length * 10
            ),

        bbox:
            box,

        lineCount:
            lines.length,

        columnCandidates:
            columns,

        lines,

    };

}
// ============================================
// CONSTRUIR FILAS Y CELDAS DE TABLA
// ============================================

function buildTableGrid(
    lines = []
) {

    if (
        !Array.isArray(lines) ||
        !lines.length
    ) {

        return [];

    }


    const GAP_THRESHOLD = 70;
const xFrequency =
    new Map();


lines.forEach(
    line => {

        const lineXPositions =
            new Set();


        (
            line.words ||
            []
        ).forEach(
            word => {

                const x =
                    Math.round(
                        number(
                            word?.x
                        ) /
                        20
                    ) *
                    20;


                lineXPositions.add(
                    x
                );

            }
        );


        lineXPositions.forEach(
            x => {

                xFrequency.set(
                    x,
                    (
                        xFrequency.get(x) ||
                        0
                    ) + 1
                );

            }
        );

    }
);


const repeatedXPositions =
    Array.from(
        xFrequency.entries()
    )
        .filter(
            (
                [
                    ,
                    count
                ]
            ) =>
                count >= 2
        )
        .map(
            (
                [
                    x
                ]
            ) =>
                x
        )
        .sort(
            (
                a,
                b
            ) =>
                a - b
        );


const tableLeftX =
    repeatedXPositions.length
        ? repeatedXPositions[0]
        : 0;

    return lines.map(
        line => {

            const words =
    Array.isArray(
        line?.words
    )
        ? [
            ...line.words
        ]
            .filter(
                word =>
                    number(
                        word?.x
                    ) >=
                    tableLeftX - 40
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    number(a?.x) -
                    number(b?.x)
            )
        : [];


            if (
                !words.length
            ) {

                return {

                    text: "",

                    cells: [],

                    line,

                };

            }


            const cells = [];

            let currentWords = [
                words[0]
            ];


            for (
                let i = 1;
                i < words.length;
                i++
            ) {

                const previous =
                    words[
                        i - 1
                    ];

                const current =
                    words[i];


                const previousRight =
                    number(
                        previous?.x
                    ) +
                    number(
                        previous?.width
                    );


                const gap =
                    number(
                        current?.x
                    ) -
                    previousRight;


                if (
                    gap >=
                    GAP_THRESHOLD
                ) {

                    cells.push(
                        currentWords
                    );


                    currentWords = [
                        current
                    ];

                } else {

                    currentWords.push(
                        current
                    );

                }

            }


            if (
                currentWords.length
            ) {

                cells.push(
                    currentWords
                );

            }


            return {

                text:
                    cleanText(
                        line.text
                    ),

                cells:
                    cells.map(
                        cellWords => ({

                            text:
                                joinWords(
                                    cellWords
                                ),

                            words:
                                cellWords,

                            bbox:
                                getBoundingBox(
                                    cellWords
                                ),

                            x:
                                cellWords.length
                                    ? number(
                                        cellWords[0]?.x
                                    )
                                    : 0,

                        })
                    ),

                line,

            };

        }
    );

}
// ============================================
// ANALIZAR ESTRUCTURA DE TABLA
// ============================================

function analyzeTableGrid(
    lines = []
) {

    if (
        !Array.isArray(lines) ||
        !lines.length
    ) {

        return {

            caption: null,

            tableTitle: null,

            headers: [],

            rows: [],

            total: null,

        };

    }


    const grid =
        buildTableGrid(
            lines
        );


    if (
        !grid.length
    ) {

        return {

            caption: null,

            tableTitle: null,

            headers: [],

            rows: [],

            total: null,

        };

    }


    // ========================================
    // CAPTION
    // ========================================

    const firstRowIsMetadata =
        (
            grid[0]?.cells || []
        ).length <= 1;


    const secondRowIsMetadata =
        firstRowIsMetadata &&
        (
            grid[1]?.cells || []
        ).length <= 1;


    const metadataRowCount =
        secondRowIsMetadata
            ? 2
            : firstRowIsMetadata
                ? 1
                : 0;


    const caption =
        metadataRowCount >= 1
            ? cleanText(
                grid[0]?.text || ""
            )
            : null;


    // ========================================
    // TÍTULO INTERNO DE TABLA
    // ========================================

    const tableTitle =
        metadataRowCount >= 2
            ? cleanText(
                grid[1]?.text || ""
            )
            : null;


    // El formato histórico usado durante el
    // desarrollo contiene dos filas descriptivas
    // y tres filas de encabezado. Solo aplicamos
    // esa estructura cuando aparecen sus señales;
    // para cualquier otra tabla conservamos todas
    // las filas en lugar de descartarlas.
    const headerProbe =
        grid
            .slice(
                metadataRowCount,
                metadataRowCount + 3
            )
            .map(
                row =>
                    cleanText(
                        row?.text || ""
                    )
            )
            .join(" ")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase();


    const hasKnownMultiRowHeader =
        metadataRowCount === 2 &&
        /\b(TRAMO|TIPO|CAMINO|TRANSPORT|DURACION|DISTANCIA|SRANCIA)\b/.test(
            headerProbe
        );


    const headerRowCount =
        hasKnownMultiRowHeader
            ? Math.min(
                3,
                Math.max(
                    0,
                    grid.length -
                    metadataRowCount
                )
            )
            : 0;


    const lastRow =
        grid[
            grid.length - 1
        ];


    const lastRowText =
        cleanText(
            lastRow?.text || ""
        )
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toUpperCase();


    const hasTotalRow =
        /^TOTAL(?:ES)?\b/.test(
            lastRowText
        );


    // ========================================
    // FILAS DE DATOS
    // ========================================

    const dataGrid =
        grid
            .slice(
                metadataRowCount +
                headerRowCount,
                hasTotalRow
                    ? -1
                    : grid.length
            )
            .filter(
                row =>
                    (
                        row.cells ||
                        []
                    ).length > 0
            );


    const rows =
        dataGrid.map(
            row =>
                (
                    row.cells ||
                    []
                ).map(
                    cell =>
                        cleanText(
                            cell.text
                        )
                )
        );


    // ========================================
    // DETERMINAR POSICIONES DE COLUMNAS
    // ========================================

    const columnPositions = [];


    dataGrid.forEach(
        row => {

            (
                row.cells ||
                []
            ).forEach(
                (
                    cell,
                    index
                ) => {

                    if (
                        !columnPositions[index]
                    ) {

                        columnPositions[index] =
                            [];

                    }


                    columnPositions[index]
                        .push(
                            number(
                                cell.x
                            )
                        );

                }
            );

        }
    );


    const columnAnchors =
        columnPositions.map(
            positions => {

                if (
                    !positions.length
                ) {

                    return 0;

                }


                const sorted =
                    [
                        ...positions
                    ].sort(
                        (
                            a,
                            b
                        ) =>
                            a - b
                    );


                const middle =
                    Math.floor(
                        sorted.length / 2
                    );


                return (
                    sorted.length % 2 === 1
                        ? sorted[middle]
                        : (
                            sorted[
                                middle - 1
                            ] +
                            sorted[
                                middle
                            ]
                        ) / 2
                );

            }
        );


    // ========================================
// LIMPIAR TEXTO DE ENCABEZADOS
// ========================================

function normalizeHeaderText(
    text = ""
) {

    const value =
        cleanText(
            text
        )
            .replace(
                /\|/g,
                " "
            )
            .replace(
                /-{2,}/g,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
            .trim();


    const upper =
        value.toUpperCase();


    if (
        upper.includes("TRAMO")
    ) {

        return "TRAMO";

    }


    if (
        upper.includes("TIPO") &&
        upper.includes("CAMINO")
    ) {

        return "TIPO DE CAMINO";

    }


    if (
        upper.includes("TRANSPORT")
    ) {

        return "MEDIO DE TRANSPORTES";

    }


    if (
        upper.includes("DURACION")
    ) {

        return "DURACION VIAJE (MIN)";

    }


    if (
        upper.includes("DISTANCIA") ||
        upper.includes("SRANCIA")
    ) {

        return "DISTANCIA";

    }


    return value;

}


const headers =
    columnAnchors.map(
        () => ""
    );


const headerRows =
    grid.slice(
        metadataRowCount,
        metadataRowCount +
        headerRowCount
    );


headerRows.forEach(
    row => {

        const words =
            Array.isArray(
                row?.line?.words
            )
                ? [
                    ...row.line.words
                ].sort(
                    (
                        a,
                        b
                    ) =>
                        number(a?.x) -
                        number(b?.x)
                )
                : [];


        words.forEach(
            word => {

                const text =
                    cleanText(
                        word?.text
                    );


                if (
                    !text
                ) {

                    return;

                }


                const wordX =
                    number(
                        word?.x
                    );


                let nearestIndex =
                    0;

                let nearestDistance =
                    Infinity;


                columnAnchors.forEach(
                    (
                        anchor,
                        index
                    ) => {

                        const distance =
                            Math.abs(
                                wordX -
                                anchor
                            );


                        if (
                            distance <
                            nearestDistance
                        ) {

                            nearestDistance =
                                distance;

                            nearestIndex =
                                index;

                        }

                    }
                );


                headers[
                    nearestIndex
                ] =
                    cleanText(
                        (
                            headers[
                                nearestIndex
                            ] +
                            " " +
                            text
                        )
                    );

            }
        );

    }
);


const normalizedHeaders =
    headers.map(
        header =>
            normalizeHeaderText(
                header
            )
    );

    // ========================================
    // TOTAL
    // ========================================

    const total =
        hasTotalRow
            ? (
                lastRow.cells ||
                []
            ).map(
                cell =>
                    cleanText(
                        cell.text
                    )
            )
            : null;


    return {

        caption,

        tableTitle,

        headers,
        normalizedHeaders,

        rows,

        total,

        columnAnchors,

        raw:
            grid,

    };

}

// DETECTAR ZONAS
// ============================================
// DETECTAR ZONAS
// ============================================

function detectZones(
    lines,
    pageWidth,
    pageHeight
) {

    const zones = [];


    // ========================================
    // HEADER
    // ========================================

    const header =
        detectHeader(
            lines,
            pageHeight
        );


    if (
        header.length
    ) {

        zones.push({

            type:
                "header",

            bbox:
                getBoundingBox(
                    header.flatMap(
                        line =>
                            line.words || []
                    )
                ),

            lines:
                header,

        });

    }


    // ========================================
    // FOOTER
    // ========================================

    const footer =
        detectFooter(
            lines,
            pageHeight
        );


    if (
        footer.length
    ) {

        zones.push({

            type:
                "footer",

            bbox:
                getBoundingBox(
                    footer.flatMap(
                        line =>
                            line.words || []
                    )
                ),

            lines:
                footer,

        });

    }


    // ========================================
    // CUERPO
    // ========================================

    const body =
        lines.filter(
            line =>
                !header.includes(line) &&
                !footer.includes(line)
        );


    if (
        body.length
    ) {

        zones.push({

            type:
                "body",

            bbox:
                getBoundingBox(
                    body.flatMap(
                        line =>
                            line.words || []
                    )
                ),

            lines:
                body,

        });

    }


    return zones;

}


// ============================================
// DENSIDAD DE TEXTO
// ============================================

function calculateTextDensity(
    words,
    pageWidth,
    pageHeight
) {

    if (
        pageWidth <= 0 ||
        pageHeight <= 0
    ) {

        return 0;

    }


    const pageArea =
        pageWidth *
        pageHeight;


    const textArea =
        words.reduce(
            (
                total,
                word
            ) =>
                total +
                (
                    number(word.width) *
                    number(word.height)
                ),
            0
        );


    return Math.min(
        100,
        (
            textArea /
            pageArea
        ) *
        100
    );

}


// ============================================
// ESTADÍSTICAS
// ============================================

function calculateStatistics(
    words,
    lines,
    blocks,
    paragraphs,
    pageWidth,
    pageHeight
) {

    const confidenceValues =
        words
            .map(
                word =>
                    number(
                        word.confidence
                    )
            )
            .filter(
                value =>
                    value > 0
            );


    const averageConfidence =
        confidenceValues.length
            ? confidenceValues.reduce(
                (
                    sum,
                    value
                ) =>
                    sum + value,
                0
            ) /
            confidenceValues.length
            : 0;


    const heights =
        words
            .map(
                word =>
                    number(
                        word.height
                    )
            )
            .filter(
                value =>
                    value > 0
            );


    const averageWordHeight =
        heights.length
            ? heights.reduce(
                (
                    sum,
                    value
                ) =>
                    sum + value,
                0
            ) /
            heights.length
            : 0;


    return {

        wordCount:
            words.length,

        lineCount:
            lines.length,

        blockCount:
            blocks.length,

        paragraphCount:
            paragraphs.length,

        averageConfidence:
            Number(
                averageConfidence.toFixed(2)
            ),

        averageWordHeight:
            Number(
                averageWordHeight.toFixed(2)
            ),

        textDensity:
            Number(
                calculateTextDensity(
                    words,
                    pageWidth,
                    pageHeight
                ).toFixed(2)
            ),

    };

}


// ============================================
// ANALIZAR PÁGINA
// ============================================

export function analyzePage(
    pageData = {}
) {

    const width =
        number(
            pageData.width
        );


    const height =
        number(
            pageData.height
        );


    const words =
        Array.isArray(
            pageData.words
        )
            ? pageData.words
            : [];


    const sourceBlocks =
    Array.isArray(
        pageData.blocks
    )
        ? pageData.blocks
        : [];


const sourceParagraphs =
    Array.isArray(
        pageData.paragraphs
    )
        ? pageData.paragraphs
        : [];


    const lines =
        normalizeLines(
            pageData.lines || [],
            words
        );
// ========================================
    // TABLAS
    // ========================================

    const tableCandidates =
        detectTableCandidates(
                        lines
        );
       
// ========================================
// CONSTRUIR PÁRRAFOS
// ========================================

// ========================================
// SEPARAR TEXTO Y TABLAS
// ========================================

const tableContentLineSet =
    new Set(
        tableCandidates.flatMap(
            candidate =>
                (
                    candidate.lines || []
                ).slice(
                    candidate.caption
                        ? 1
                        : 0
                )
        )
    );


const paragraphLines =
    lines.filter(
        line =>
            !tableContentLineSet.has(
                line
            )
    );


// ========================================
// CONSTRUIR PÁRRAFOS
// ========================================

const detectedParagraphs =
    detectParagraphs(
        paragraphLines
    );


// ========================================
// CONSTRUIR BLOQUES
// ========================================

const detectedBlocks =
    detectBlocks(
        detectedParagraphs,
        width,
        height
    );
const paragraphs =
    detectedParagraphs;


const blocks =
    detectedBlocks;


    // ========================================
    // ORDENAR
    // ========================================

    lines.sort(
        (
            a,
            b
        ) =>
            a.center.y -
            b.center.y
    );


    // ========================================
    // COLUMNAS
    // ========================================

    const columnAnalysis =
        detectColumns(
            lines,
            width
        );


    // ========================================
    // ZONAS
    // ========================================

    const zones =
        detectZones(
            lines,
            width,
            height
        );



    // ========================================
    // ESTADÍSTICAS
    // ========================================

    const statistics =
        calculateStatistics(
            words,
            lines,
            blocks,
            paragraphs,
            width,
            height
        );

    // ========================================
    // RESULTADO
    // ========================================

    return {

        pageNumber:
            pageData.pageNumber ??
            null,

        dimensions: {

            width,

            height,

        },

        orientation:
            width > height
                ? "landscape"
                : "portrait",


        words,

        lines,

        blocks,

        paragraphs,

        sourceBlocks,

        sourceParagraphs,


        columns:
            columnAnalysis,


        zones,


        tableCandidates,

        tables:
            tableCandidates,
        statistics,


        spatial: {

            pageBox: {

                x: 0,

                y: 0,

                width,

                height,

            },

            textBox:
                getBoundingBox(
                    words
                ),

        },


        // ====================================
        // INFORMACIÓN PARA NOVADOC
        // ====================================

        layout: {

            type:
                columnAnalysis.count > 1
                    ? "multi-column"
                    : "single-column",

            columns:
                columnAnalysis.count,

            hasHeader:
                zones.some(
                    zone =>
                        zone.type ===
                        "header"
                ),

            hasFooter:
                zones.some(
                    zone =>
                        zone.type ===
                        "footer"
                ),

            possibleTables:
                tableCandidates.length,

        },

    };

}


// ============================================
// EXPORTACIÓN
// ============================================

export default analyzePage;
