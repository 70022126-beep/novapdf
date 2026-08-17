// ============================================
// NOVAPDF OCR ENGINE 1.2
// ============================================
// OCR avanzado para documentos escaneados.
//
// Características:
//
// - Worker reutilizable
// - Español
// - PSM configurable
// - Salida TSV
// - Palabras
// - Líneas
// - Bloques
// - Párrafos
// - Coordenadas
// - Confianza
// - Normalización
// - Estructura espacial
// - Compatible con PageAnalyzer
//
// IMPORTANTE:
// OCREngine se encarga exclusivamente del OCR.
// PageAnalyzer será responsable de analizar
// y reconstruir la estructura de la página.
// ============================================
import {
    createWorker,
    PSM,
} from "tesseract.js";


// ============================================
// CONFIGURACIÓN
// ============================================

const OCR_CONFIG = {

    language: ["spa", "eng"],

    workerOEM: 1,

    pageSegmentationMode:
        PSM.AUTO,

};


// ============================================
// CONVERTIR A NÚMERO
// ============================================

function toNumber(
    value,
    fallback = 0
) {

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}


// ============================================
// LIMPIAR TEXTO
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
// CREAR TEXTO DESDE PALABRAS
// ============================================

function joinWords(
    words
) {

    return words
        .map(
            word =>
                cleanText(word.text)
        )
        .filter(Boolean)
        .join(" ");
}


// ============================================
// PARSEAR TSV
// ============================================

function parseTSV(
    tsv
) {

    if (!tsv) {

        return {

            words: [],

            lines: [],

            blocks: [],

            paragraphs: [],

        };
    }


    const rows =
        String(tsv)
            .trim()
            .split(/\r?\n/);


    if (
        rows.length <= 1
    ) {

        return {

            words: [],

            lines: [],

            blocks: [],

            paragraphs: [],

        };
    }


    const headers =
        rows[0].split("\t");


    const index = {};


    headers.forEach(
        (
            header,
            position
        ) => {

            index[header] =
                position;

        }
    );


    const words = [];

    const linesMap =
        new Map();

    const blocksMap =
        new Map();

    const paragraphsMap =
        new Map();


    for (
        let i = 1;
        i < rows.length;
        i++
    ) {

        const columns =
            rows[i].split("\t");


        const text =
            cleanText(
                columns[index.text]
            );


        const level =
            toNumber(
                columns[index.level]
            );


        // Solo palabras
        if (
            !text ||
            level !== 5
        ) {

            continue;

        }


        const blockNumber =
            toNumber(
                columns[index.block_num]
            );


        const paragraphNumber =
            toNumber(
                columns[index.par_num]
            );


        const lineNumber =
            toNumber(
                columns[index.line_num]
            );


        const wordNumber =
            toNumber(
                columns[index.word_num]
            );


        const left =
            toNumber(
                columns[index.left]
            );


        const top =
            toNumber(
                columns[index.top]
            );


        const width =
            toNumber(
                columns[index.width]
            );


        const height =
            toNumber(
                columns[index.height]
            );


        const confidence =
            toNumber(
                columns[index.conf]
            );


        const word = {

            text,

            confidence,

            x: left,

            y: top,

            width,

            height,

            blockNumber,

            paragraphNumber,

            lineNumber,

            wordNumber,

        };


        words.push(
            word
        );


        // ====================================
        // LÍNEA
        // ====================================

        const lineKey =
            `${blockNumber}-${paragraphNumber}-${lineNumber}`;


        if (
            !linesMap.has(
                lineKey
            )
        ) {

            linesMap.set(
                lineKey,
                {

                    blockNumber,

                    paragraphNumber,

                    lineNumber,

                    words: [],

                }
            );

        }


        linesMap
            .get(lineKey)
            .words
            .push(word);


        // ====================================
        // BLOQUE
        // ====================================

        const blockKey =
            `${blockNumber}`;


        if (
            !blocksMap.has(
                blockKey
            )
        ) {

            blocksMap.set(
                blockKey,
                {

                    blockNumber,

                    words: [],

                }
            );

        }


        blocksMap
            .get(blockKey)
            .words
            .push(word);


        // ====================================
        // PÁRRAFO
        // ====================================

        const paragraphKey =
            `${blockNumber}-${paragraphNumber}`;


        if (
            !paragraphsMap.has(
                paragraphKey
            )
        ) {

            paragraphsMap.set(
                paragraphKey,
                {

                    blockNumber,

                    paragraphNumber,

                    words: [],

                }
            );

        }


        paragraphsMap
            .get(paragraphKey)
            .words
            .push(word);

    }


    // ========================================
    // CONSTRUIR LÍNEAS
    // ========================================

    const lines =
        Array.from(
            linesMap.values()
        )
            .map(
                line => {

                    const sortedWords =
                        [...line.words]
                            .sort(
                                (
                                    a,
                                    b
                                ) =>
                                    a.x - b.x
                            );


                    return {

                        ...line,

                        text:
                            joinWords(
                                sortedWords
                            ),

                        words:
                            sortedWords,

                    };

                }
            );


    // ========================================
    // CONSTRUIR BLOQUES
    // ========================================

    const blocks =
        Array.from(
            blocksMap.values()
        )
            .map(
                block => {

                    const sortedWords =
                        [...block.words]
                            .sort(
                                (
                                    a,
                                    b
                                ) => {

                                    if (
                                        a.y !==
                                        b.y
                                    ) {

                                        return (
                                            a.y -
                                            b.y
                                        );

                                    }


                                    return (
                                        a.x -
                                        b.x
                                    );

                                }
                            );


                    return {

                        ...block,

                        text:
                            joinWords(
                                sortedWords
                            ),

                        words:
                            sortedWords,

                    };

                }
            );


    // ========================================
    // CONSTRUIR PÁRRAFOS
    // ========================================

    const paragraphs =
        Array.from(
            paragraphsMap.values()
        )
            .map(
                paragraph => {

                    const sortedWords =
                        [...paragraph.words]
                            .sort(
                                (
                                    a,
                                    b
                                ) => {

                                    if (
                                        a.y !==
                                        b.y
                                    ) {

                                        return (
                                            a.y -
                                            b.y
                                        );

                                    }


                                    return (
                                        a.x -
                                        b.x
                                    );

                                }
                            );


                    return {

                        ...paragraph,

                        text:
                            joinWords(
                                sortedWords
                            ),

                        words:
                            sortedWords,

                    };

                }
            );


    return {

        words,

        lines,

        blocks,

        paragraphs,

    };

}


// ============================================
// EXTRAER ESTRUCTURA ESPACIAL
// ============================================
//
// Tesseract puede entregar:
//
// blocks
//   └── paragraphs
//        └── lines
//             └── words
//
// Esta información será utilizada
// posteriormente por PageAnalyzer.
// ============================================

function extractSpatialData(
    data
) {

    const words = [];

    const lines = [];

    const blocks = [];

    const paragraphs = [];


    // ========================================
    // BLOQUES NATIVOS DE TESSERACT
    // ========================================

    if (
        Array.isArray(
            data?.blocks
        )
    ) {

        data.blocks.forEach(
            (
                block,
                blockIndex
            ) => {

                const blockWords = [];


                // ====================================
                // PÁRRAFOS
                // ====================================

                if (
                    Array.isArray(
                        block.paragraphs
                    )
                ) {

                    block.paragraphs.forEach(
                        (
                            paragraph,
                            paragraphIndex
                        ) => {

                            const paragraphWords = [];


                            // ====================================
                            // LÍNEAS
                            // ====================================

                            if (
                                Array.isArray(
                                    paragraph.lines
                                )
                            ) {

                                paragraph.lines.forEach(
                                    (
                                        line,
                                        lineIndex
                                    ) => {

                                        const lineWords =
                                            Array.isArray(
                                                line.words
                                            )
                                                ? line.words
                                                : [];


                                        // ====================================
                                        // PALABRAS
                                        // ====================================

                                        lineWords.forEach(
                                            (
                                                word,
                                                wordIndex
                                            ) => {

                                                const text =
                                                    String(
                                                        word?.text ||
                                                        ""
                                                    ).trim();


                                                if (!text) {

                                                    return;

                                                }


                                                const bbox =
                                                    word?.bbox ||
                                                    {};


                                                const x0 =
                                                    toNumber(
                                                        bbox.x0
                                                    );


                                                const y0 =
                                                    toNumber(
                                                        bbox.y0
                                                    );


                                                const x1 =
                                                    toNumber(
                                                        bbox.x1
                                                    );


                                                const y1 =
                                                    toNumber(
                                                        bbox.y1
                                                    );


                                                const normalizedWord = {

                                                    text,

                                                    confidence:
                                                        toNumber(
                                                            word?.confidence
                                                        ),

                                                    x:
                                                        x0,

                                                    y:
                                                        y0,

                                                    width:
                                                        Math.max(
                                                            0,
                                                            x1 - x0
                                                        ),

                                                    height:
                                                        Math.max(
                                                            0,
                                                            y1 - y0
                                                        ),

                                                    blockNumber:
                                                        blockIndex + 1,

                                                    paragraphNumber:
                                                        paragraphIndex + 1,

                                                    lineNumber:
                                                        lineIndex + 1,

                                                    wordNumber:
                                                        wordIndex + 1,

                                                };


                                                words.push(
                                                    normalizedWord
                                                );


                                                paragraphWords.push(
                                                    normalizedWord
                                                );


                                                blockWords.push(
                                                    normalizedWord
                                                );

                                            }
                                        );


                                        if (
                                            lineWords.length > 0
                                        ) {

                                            const normalizedLineWords =
                                                lineWords
                                                    .map(
                                                        (
                                                            word,
                                                            wordIndex
                                                        ) => {

                                                            const text =
                                                                String(
                                                                    word?.text ||
                                                                    ""
                                                                ).trim();


                                                            if (
                                                                !text
                                                            ) {

                                                                return null;

                                                            }


                                                            const bbox =
                                                                word?.bbox ||
                                                                {};


                                                            const x0 =
                                                                toNumber(
                                                                    bbox.x0
                                                                );


                                                            const y0 =
                                                                toNumber(
                                                                    bbox.y0
                                                                );


                                                            const x1 =
                                                                toNumber(
                                                                    bbox.x1
                                                                );


                                                            const y1 =
                                                                toNumber(
                                                                    bbox.y1
                                                                );


                                                            return {

                                                                text,

                                                                confidence:
                                                                    toNumber(
                                                                        word?.confidence
                                                                    ),

                                                                x:
                                                                    x0,

                                                                y:
                                                                    y0,

                                                                width:
                                                                    Math.max(
                                                                        0,
                                                                        x1 - x0
                                                                    ),

                                                                height:
                                                                    Math.max(
                                                                        0,
                                                                        y1 - y0
                                                                    ),

                                                                blockNumber:
                                                                    blockIndex + 1,

                                                                paragraphNumber:
                                                                    paragraphIndex + 1,

                                                                lineNumber:
                                                                    lineIndex + 1,

                                                                wordNumber:
                                                                    wordIndex + 1,

                                                            };

                                                        }
                                                    )
                                                    .filter(Boolean);


                                            lines.push({

                                                text:
                                                    joinWords(
                                                        normalizedLineWords
                                                    ),

                                                words:
                                                    normalizedLineWords,

                                                blockNumber:
                                                    blockIndex + 1,

                                                paragraphNumber:
                                                    paragraphIndex + 1,

                                                lineNumber:
                                                    lineIndex + 1,

                                            });

                                        }

                                    }
                                );

                            }


                            if (
                                paragraphWords.length > 0
                            ) {

                                paragraphs.push({

                                    text:
                                        joinWords(
                                            paragraphWords
                                        ),

                                    words:
                                        paragraphWords,

                                    blockNumber:
                                        blockIndex + 1,

                                    paragraphNumber:
                                        paragraphIndex + 1,

                                });

                            }

                        }
                    );

                }


                // ====================================
                // BLOQUE
                // ====================================

                if (
                    blockWords.length > 0
                ) {

                    blocks.push({

                        text:
                            joinWords(
                                blockWords
                            ),

                        words:
                            blockWords,

                        blockNumber:
                            blockIndex + 1,

                        bbox:
                            block?.bbox ||
                            null,

                    });

                }

            }
        );

    }


    // ========================================
    // RESPALDO TSV
    // ========================================

    if (
        words.length === 0
    ) {

        return parseTSV(
            data?.tsv
        );

    }


    return {

        words,

        lines,

        blocks,

        paragraphs,

    };

}


// ============================================
// OCR ENGINE
// ============================================

class OCREngine {

    constructor() {

        this.worker =
            null;

        this.initialized =
            false;

        this.initializing =
            null;

        this.progressCallback =
            null;

    }


    // ========================================
    // INICIALIZAR WORKER
    // ========================================

    async initialize(
        onProgress
    ) {

        if (
            typeof onProgress ===
            "function"
        ) {

            this.progressCallback =
                onProgress;

        }

        // Worker ya disponible
        if (
            this.initialized &&
            this.worker
        ) {

            return this.worker;

        }


        // Evitar crear varios workers
        if (
            this.initializing
        ) {

            return this.initializing;

        }


        this.initializing =
            (async () => {

                const worker =
                    await createWorker(

                        OCR_CONFIG.language,

                        OCR_CONFIG.workerOEM,

                        {

                            logger:
                                message => {

                                    if (
                                        this.progressCallback
                                    ) {

                                        this.progressCallback(
                                            message
                                        );

                                    }

                                },

                        }

                    );


                // ====================================
                // CONFIGURACIÓN OCR
                // ====================================

                await worker.setParameters({

                    tessedit_pageseg_mode:
                        OCR_CONFIG.pageSegmentationMode,

                    preserve_interword_spaces:
                        "1",

                    // Tesseract escribe avisos de
                    // segmentación no fatales en
                    // stderr. En el navegador aparecen
                    // como errores rojos aunque el OCR
                    // termine correctamente.
                    debug_file:
                        "/dev/null",

                });


                this.worker =
                    worker;


                this.initialized =
                    true;


                this.initializing =
                    null;


                return worker;

            })()
                .catch(
                    error => {

                        this.initializing =
                            null;

                        this.worker =
                            null;

                        this.initialized =
                            false;

                        throw error;

                    }
                );


        return this.initializing;

    }


    // ========================================
    // RECONOCER IMAGEN
    // ========================================

    async recognize(
        image,
        onProgress,
        options = {}
    ) {

        if (!image) {

            throw new Error(
                "No se proporcionó ninguna imagen para OCR."
            );

        }


        this.progressCallback =
            typeof onProgress ===
            "function"
                ? onProgress
                : null;


        const worker =
            await this.initialize();


        const pageSegmentationMode =
            options?.pageSegmentationMode ??
            OCR_CONFIG.pageSegmentationMode;


        await worker.setParameters({

            tessedit_pageseg_mode:
                pageSegmentationMode,

            preserve_interword_spaces:
                "1",

            debug_file:
                "/dev/null",

        });


        const dpi =
            Math.round(
                toNumber(
                    options?.dpi
                )
            );


        const recognitionOptions =
            dpi >= 70 &&
            dpi <= 2400
                ? {
                    user_defined_dpi:
                        String(dpi),
                }
                : {};


        const result =
            await worker.recognize(

                image,

                recognitionOptions,

                {

                    text: true,

                    blocks: true,

                    tsv: true,

                }

            );


        const data =
            result?.data ||
            {};


        // ========================================
        // EXTRAER ESTRUCTURA ESPACIAL
        // ========================================

        const spatialData =
            extractSpatialData(
                data
            );


        // ========================================
        // RESULTADO NORMALIZADO
        // ========================================

        return {

            text:
                data.text ||
                "",

            confidence:
                toNumber(
                    data.confidence
                ),

            words:
                spatialData.words,

            lines:
                spatialData.lines,

            blocks:
                spatialData.blocks,

            paragraphs:
                spatialData.paragraphs,

            tsv:
                data.tsv ||
                "",

            rawBlocks:
                data.blocks ||
                [],

            options,

        };

    }


    // ========================================
    // TERMINAR WORKER
    // ========================================

    async terminate() {

        if (
            this.worker
        ) {

            try {

                await this.worker.terminate();

            }
            catch (error) {

                console.warn(
                    "No se pudo terminar correctamente el worker OCR:",
                    error
                );

            }

        }


        this.worker =
            null;


        this.initialized =
            false;


        this.initializing =
            null;


        this.progressCallback =
            null;

    }

}


// ============================================
// INSTANCIA ÚNICA
// ============================================

const ocrEngine =
    new OCREngine();


// ============================================
// EXPORTAR
// ============================================

export default ocrEngine;
