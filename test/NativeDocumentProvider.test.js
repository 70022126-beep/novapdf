import test from "node:test";
import assert from "node:assert/strict";

import {
    extractNativeDocumentStructure,
    isPlausibleNativeTable,
    normalizeStructuredNativePage,
    repairNativeTableText,
    selectBestNativeContent,
} from "../src/engine/pdf-to-word/NativeDocumentProvider.js";

test("transporta tipografías PDF autorizadas para incrustarlas en Word", async () => {
    const previousFetch = globalThis.fetch;
    let requestOptions;
    globalThis.fetch = async (_url, options) => {
        requestOptions = options;
        return ({
            ok: true,
            json: async () => ({
                provider: "pdfplumber",
                page_count: 1,
                pages: [{ page_number: 1 }],
                fonts: [{
                    name: "Quicksand Light",
                    source_name: "ABCDEF+Quicksand-Light",
                    extension: "ttf",
                    sha256: "font-sha",
                    embedding: "editable",
                    data_base64: "AQIDBA==",
                }],
            }),
        });
    };
    try {
        const file = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
        Object.defineProperty(file, "name", { value: "prueba.pdf" });
        const result = await extractNativeDocumentStructure(file, { pages: [1] });
        assert.equal(result.embeddedFonts.length, 1);
        assert.equal(result.embeddedFonts[0].name, "Quicksand Light");
        assert.equal(result.embeddedFonts[0].id, "font-sha");
        assert.deepEqual([...result.embeddedFonts[0].data], [1, 2, 3, 4]);
        assert.equal(requestOptions.body.get("include_fonts"), "true");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("permite omitir fuentes en lotes posteriores", async () => {
    const previousFetch = globalThis.fetch;
    let requestOptions;
    globalThis.fetch = async (_url, options) => {
        requestOptions = options;
        return {
            ok: true,
            json: async () => ({ provider: "pdfplumber", page_count: 2, pages: [] }),
        };
    };
    try {
        const file = new Blob([new Uint8Array([1])], { type: "application/pdf" });
        Object.defineProperty(file, "name", { value: "prueba.pdf" });
        await extractNativeDocumentStructure(file, { pages: [2], includeFonts: false });
        assert.equal(requestOptions.body.get("include_fonts"), "false");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("rechaza texto jurídico fragmentado como una falsa tabla sin bordes", () => {
    const rows = [
        ["E", "XPEDIENTE : N° 00294", "0-0305-JP", "C-01"],
        ["D", "ocumento Nacional de Identi", "dad N°", "70022126"],
        ["d", "omicilio real en Jr. Tumbes", "con Av.", "Martinelly"],
        ["P", "rovincia de Chincheros", "Departamento", "Apurímac"],
        ["p", "roceso de Alimentos", "seguido", "en mi contra"],
        ["m", "enores alimentistas", "de iniciales", "L.M.D.J.S"],
        ["Q", "ue habiendo sido notificado", "del presente", "proceso"],
        ["a", "ctuados la Resolución", "de fecha", "octubre"],
    ];

    assert.equal(
        isPlausibleNativeTable(
            {
                source: "pdfplumber-text",
                bbox: { x: 113, y: 72, width: 397, height: 680 },
                rows,
            },
            842
        ),
        false
    );
});

test("normaliza la segunda extraccion nativa con tipografia, color y tablas", () => {
    const page = normalizeStructuredNativePage(
        {
            page_number: 3,
            width: 600,
            height: 800,
            words: [
                {
                    text: "NovaPDF",
                    bbox: [20, 30, 90, 44],
                    font_name: "ABCDEF+Arial-Bold",
                    font_size: 14,
                    bold: true,
                    color: "#2457D6",
                    confidence: 1,
                    embedded_font: true,
                },
            ],
            lines: [
                {
                    type: "line",
                    bbox: [20, 43.5, 90, 44],
                    line_width: 0.5,
                },
            ],
            tables: [
                {
                    bbox: [10, 100, 590, 300],
                    rows: [["A", "B"], ["1", "2"]],
                    structural_score: 96,
                    confidence: 0.96,
                    column_anchors: [10, 300],
                    structure: { raw: [] },
                },
            ],
            images: [
                {
                    name: "Signature",
                    bbox: [100, 120, 140, 160],
                    width: 40,
                    height: 40,
                    mime_type: "image/png",
                    data_base64: "AQID",
                    native_embedded: true,
                },
            ],
        },
        { width: 300, height: 400 }
    );

    assert.equal(page.content.words[0].x, 10);
    assert.equal(page.content.words[0].fontFamily, "Arial");
    assert.equal(page.content.words[0].color, "#2457D6");
    assert.equal(page.content.words[0].underline, true);
    assert.equal(page.tables[0].bbox.width, 290);
    assert.equal(page.tables[0].structuralScore, 96);
    assert.equal(page.images[0].x, 50);
    assert.equal(page.images[0].width, 20);
    assert.equal(page.images[0].data.length, 3);
    assert.equal(page.images[0].nativeEmbedded, true);
});

test("conserva una tabla con bordes que continúa mediante una sola fila", () => {
    const page = normalizeStructuredNativePage({
        width: 792,
        height: 612,
        words: [],
        tables: [{
            bbox: [70, 70, 770, 215],
            rows: [["Criterio", "Nivel esperado", "Nivel destacado"]],
            source: "pdfplumber-lines",
            confidence: 0.96,
            structural_score: 96,
            column_anchors: [70, 250, 510],
            structure: {
                raw: [{
                    cells: [
                        { text: "Criterio", bbox: { x: 70, y: 70, width: 180, height: 145 }, columnIndex: 0 },
                        { text: "Nivel esperado", bbox: { x: 250, y: 70, width: 260, height: 145 }, columnIndex: 1 },
                        { text: "Nivel destacado", bbox: { x: 510, y: 70, width: 260, height: 145 }, columnIndex: 2 },
                    ],
                }],
            },
        }],
    });

    assert.equal(page.tables.length, 1);
    assert.equal(page.tables[0].rows.length, 1);
    assert.equal(page.tables[0].columnAnchors.length, 3);
});

test("no interpreta un borde de tabla como subrayado", () => {
    const page = normalizeStructuredNativePage({
        width: 600,
        height: 800,
        words: [{ text: "Detalle", bbox: [120, 127, 155, 137], font_size: 10 }],
        lines: [{ type: "line", bbox: [100, 139, 300, 139.5], line_width: 0.5 }],
        tables: [{
            bbox: [100, 100, 300, 178],
            rows: [["Detalle", "A"], ["Otro", "B"]],
            source: "pdfplumber-lines",
            structure: { raw: [{ cells: [{ bbox: { x: 100, y: 100, width: 100, height: 39 } }] }] },
        }],
    });
    assert.equal(Boolean(page.content.words[0].underline), false);
});

test("elige el segundo extractor solo cuando conserva cobertura y estilos", () => {
    const primary = {
        words: [
            { text: "Documento", x: 0, y: 0, width: 60, height: 12 },
            { text: "editable", x: 65, y: 0, width: 50, height: 12 },
        ],
    };
    const secondary = {
        source: "native-secondary",
        words: [
            {
                text: "Documento",
                x: 0,
                y: 0,
                width: 60,
                height: 12,
                fontName: "Arial",
                color: "#000000",
            },
            {
                text: "editable",
                x: 65,
                y: 0,
                width: 50,
                height: 12,
                fontName: "Arial",
                color: "#000000",
            },
        ],
    };
    const incomplete = {
        source: "native-secondary",
        words: [{ text: "Doc", x: 0, y: 0, width: 20, height: 12, fontName: "Arial" }],
    };

    assert.equal(selectBestNativeContent(primary, secondary).source, "native-secondary");
    assert.equal(selectBestNativeContent(primary, incomplete), primary);
});

test("prefiere la capa nativa limpia cuando PDF.js repite texto invisible", () => {
    const primary = {
        words: [
            { text: "BASES", x: 20, y: 60, width: 70, height: 20 },
            { text: "BASES", x: 20, y: 130, width: 70, height: 20 },
            { text: "ESPECÍFICAS", x: 20, y: 155, width: 90, height: 14 },
            { text: "1.60", x: 500, y: 835, width: 20, height: 8 },
        ],
    };
    const secondary = {
        source: "native-secondary",
        words: [
            {
                text: "BASES",
                x: 20,
                y: 130,
                width: 70,
                height: 20,
                fontName: "Arial",
                color: "#648700",
            },
            {
                text: "ESPECÍFICAS",
                x: 20,
                y: 155,
                width: 90,
                height: 14,
                fontName: "Arial",
                color: "#648700",
            },
        ],
    };

    const selected = selectBestNativeContent(primary, secondary);

    assert.equal(selected.source, "native-secondary");
    assert.equal(selected.verification.tokenAgreement, 1);
});

test("repara caracteres sin mapa Unicode usando la capa PDF.js", () => {
    const primary = {
        words: [
            { text: "TECNOLOGÍA", x: 180, y: 377, width: 145, height: 22 },
            { text: "EUREKA", x: 328, y: 377, width: 90, height: 22 },
        ],
    };
    const secondary = {
        source: "native-secondary",
        words: [
            {
                text: "TECNOLOG�A",
                x: 177,
                y: 377,
                width: 144,
                height: 22,
                fontName: "Arial",
            },
            {
                text: "EUREKA",
                x: 328,
                y: 377,
                width: 90,
                height: 22,
                fontName: "Arial",
            },
        ],
    };

    const selected = selectBestNativeContent(primary, secondary);

    assert.equal(selected.words[0].text, "TECNOLOGÍA");
    assert.match(selected.text, /TECNOLOGÍA EUREKA/);
});

test("repara caracteres Unicode dentro de tablas nativas", () => {
    const [table] = repairNativeTableText(
        [
            {
                rows: [["�rea", "Tecnolog�a"]],
                headers: ["�rea", "Tecnolog�a"],
                structure: {
                    raw: [
                        {
                            cells: [
                                { text: "�rea" },
                                { text: "Tecnolog�a" },
                            ],
                        },
                    ],
                },
            },
        ],
        {
            words: [{ text: "Área" }, { text: "Tecnología" }],
        }
    );

    assert.deepEqual(table.rows[0], ["Área", "Tecnología"]);
    assert.deepEqual(table.headers, ["Área", "Tecnología"]);
    assert.equal(table.structure.raw[0].cells[1].text, "Tecnología");
});
