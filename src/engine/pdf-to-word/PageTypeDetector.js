// ============================================
// NOVAPDF PAGE TYPE DETECTOR
// ============================================
//
// Detecta:
//
// digital  -> PDF con texto real
// scanned  -> PDF probablemente escaneado
// hybrid   -> PDF con poco texto extraíble
//
// ============================================


// ============================================
// CONFIGURACIÓN
// ============================================

const CONFIG = {

    MIN_MEANINGFUL_CHARACTERS: 5,

    LOW_TEXT_ITEM_COUNT: 8,

    STRONG_TEXT_ITEM_COUNT: 20,

    STRONG_CHARACTER_COUNT: 100,

};


// ============================================
// LIMPIAR TEXTO
// ============================================

function cleanText(text) {

    if (!text) {
        return "";
    }

    return String(text)
        .replace(/\s+/g, " ")
        .trim();
}


// ============================================
// CONTAR CARACTERES
// ============================================

function countMeaningfulCharacters(
    textItems = []
) {

    return textItems.reduce(
        (total, item) => {

            const text =
                cleanText(
                    item?.str ??
                    item?.text ??
                    ""
                );

            return (
                total +
                text
                    .replace(/\s/g, "")
                    .length
            );

        },
        0
    );
}


// ============================================
// CONTAR ELEMENTOS DE TEXTO
// ============================================

function countMeaningfulTextItems(
    textItems = []
) {

    return textItems.filter(
        (item) => {

            const text =
                cleanText(
                    item?.str ??
                    item?.text ??
                    ""
                );

            return text.length > 0;
        }
    ).length;
}


// ============================================
// DENSIDAD DE TEXTO
// ============================================

function calculateTextDensity(
    textItems = [],
    pageWidth = 0,
    pageHeight = 0
) {

    if (
        !pageWidth ||
        !pageHeight
    ) {

        return 0;
    }


    const pageArea =
        pageWidth *
        pageHeight;


    if (pageArea <= 0) {
        return 0;
    }


    let textArea = 0;


    for (
        const item
        of textItems
    ) {

        const width =
            Number(
                item?.width
            ) || 0;


        const height =
            Number(
                item?.height
            ) || 0;


        textArea +=
            width *
            height;
    }


    return (
        textArea /
        pageArea
    );
}


// ============================================
// CONFIANZA DIGITAL
// ============================================

function calculateDigitalConfidence({
    itemCount,
    characterCount,
    textDensity,
}) {

    let confidence = 0.70;


    if (
        itemCount >= 50
    ) {

        confidence += 0.10;
    }


    if (
        characterCount >= 500
    ) {

        confidence += 0.10;
    }


    if (
        characterCount >= 1500
    ) {

        confidence += 0.05;
    }


    if (
        textDensity > 0.03
    ) {

        confidence += 0.05;
    }


    return Math.min(
        confidence,
        0.99
    );
}


// ============================================
// CONFIANZA HÍBRIDA
// ============================================

function calculateHybridConfidence({
    itemCount,
    characterCount,
    textDensity,
}) {

    let confidence = 0.55;


    if (
        itemCount >= 10
    ) {

        confidence += 0.10;
    }


    if (
        characterCount >= 50
    ) {

        confidence += 0.10;
    }


    if (
        textDensity > 0.01
    ) {

        confidence += 0.05;
    }


    return Math.min(
        confidence,
        0.85
    );
}


// ============================================
// DETECTAR TIPO DE PÁGINA
// ============================================

export function detectPageType({

    textItems = [],

    width = 0,

    height = 0,

}) {

    const itemCount =
        countMeaningfulTextItems(
            textItems
        );


    const characterCount =
        countMeaningfulCharacters(
            textItems
        );


    const textDensity =
        calculateTextDensity(
            textItems,
            width,
            height
        );


    // ========================================
    // SIN TEXTO
    // ========================================

    if (
        itemCount === 0 ||
        characterCount === 0
    ) {

        return {

            type: "scanned",

            confidence: 0.98,

            reason:
                "No se encontró texto extraíble mediante PDF.js.",

            itemCount,

            characterCount,

            textDensity,

        };
    }


    // ========================================
    // TEXTO MUY ESCASO
    // ========================================

    if (
        itemCount <=
            CONFIG.LOW_TEXT_ITEM_COUNT &&
        characterCount <
            CONFIG.MIN_MEANINGFUL_CHARACTERS
    ) {

        return {

            type: "scanned",

            confidence: 0.90,

            reason:
                "Se encontró una cantidad mínima de texto extraíble.",

            itemCount,

            characterCount,

            textDensity,

        };
    }


    // ========================================
    // TEXTO CLARAMENTE DIGITAL
    // ========================================

    if (
        itemCount >=
            CONFIG.STRONG_TEXT_ITEM_COUNT ||
        characterCount >=
            CONFIG.STRONG_CHARACTER_COUNT
    ) {

        return {

            type: "digital",

            confidence:
                calculateDigitalConfidence({

                    itemCount,

                    characterCount,

                    textDensity,

                }),

            reason:
                "La página contiene una cantidad significativa de texto extraíble.",

            itemCount,

            characterCount,

            textDensity,

        };
    }


    // ========================================
    // CASO INTERMEDIO
    // ========================================

    return {

        type: "hybrid",

        confidence:
            calculateHybridConfidence({

                itemCount,

                characterCount,

                textDensity,

            }),

        reason:
            "La página contiene texto extraíble, pero en cantidad limitada.",

        itemCount,

        characterCount,

        textDensity,

    };
}


// ============================================
// DETECTAR TODO EL DOCUMENTO
// ============================================

export function detectDocumentPageTypes(
    pages = []
) {

    return pages.map(
        (page) => {

            const pageType =
                detectPageType({

                    textItems:
                        page.textItems || [],

                    width:
                        page.width || 0,

                    height:
                        page.height || 0,

                });


            return {

                ...page,

                pageType,

            };

        }
    );
}