// ============================================
// NOVADOC
// Modelo intermedio de documentos de NovaPDF
// ============================================

export function createDocument() {
    return {
        type: "document",
        metadata: {
            creator: "NovaPDF",
            title: "",
        },
        pages: [],
    };
}


// ============================================
// CREAR PÁGINA
// ============================================

export function createPage({
    pageNumber,
    width,
    height,
}) {
    return {
        type: "page",

        pageNumber,

        width,

        height,

        blocks: [],
    };
}


// ============================================
// CREAR BLOQUE
// ============================================

export function createBlock({
    type = "paragraph",
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    lines = [],
}) {
    return {
        type,

        x,

        y,

        width,

        height,

        lines,
    };
}


// ============================================
// CREAR LÍNEA
// ============================================

export function createLine({
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    text = "",
    items = [],
}) {
    return {
        type: "line",

        x,

        y,

        width,

        height,

        text,

        items,
    };
}