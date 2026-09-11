import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { enhanceTable } from "../src/engine/layout/ProfessionalTableAnalyzer.js";

import {
    __dehyphenateLineWordsForTests,
    __groupParagraphLinesForTests,
    __normalizeTableRowsForTests,
    __parsePageNumberPartsForTests,
    __planNativeCellLinesForTests,
    __startsNumberedListForTests,
    releaseWordDocumentResources,
    renderWordDocument,
    splitLineByComplexTableCells,
    splitLineByLargeMeasuredGaps,
} from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

test("libera imágenes y fuentes pesadas después del empaquetado definitivo", () => {
    const model = {
        pages: [{
            renderedPage: { data: new Uint8Array(8) },
            images: [{ data: new Uint8Array(5) }],
        }],
        embeddedFonts: [{ data: new Uint8Array(7) }],
    };
    assert.equal(releaseWordDocumentResources(model), 20);
    assert.equal(model.pages[0].renderedPage.data, null);
    assert.equal(model.pages[0].images[0].data, null);
    assert.equal(model.embeddedFonts[0].data, null);
});

test("separa una línea horizontal por celdas de una tabla compleja", () => {
    const words = [
        { text: "Inicio", x: 110, y: 130, width: 34, height: 10 },
        { text: "Fin", x: 210, y: 130, width: 18, height: 10 },
        { text: "Nacional", x: 310, y: 130, width: 46, height: 10 },
    ];
    const line = {
        id: "source-line-1",
        text: "Inicio Fin Nacional",
        words,
        bbox: { x: 110, y: 130, width: 246, height: 10 },
    };
    const cells = words.map((word, index) => ({
        text: word.text,
        bbox: { x: 90 + index * 100, y: 120, width: 100, height: 30 },
    }));
    const fragments = splitLineByComplexTableCells(line, [{
        bbox: { x: 90, y: 120, width: 300, height: 30 },
        structure: { raw: [{ cells }] },
    }]);

    assert.deepEqual(fragments.map((fragment) => fragment.text), ["Inicio", "Fin", "Nacional"]);
    assert.deepEqual(fragments.map((fragment) => fragment.bbox.x), [110, 210, 310]);
});

test("separa campos de formulario alejados para conservar sus coordenadas", () => {
    const line = {
        id: "form-line",
        words: [
            { text: "DRE/GRE:", x: 70, y: 174, width: 52, height: 11, fontSize: 10 },
            { text: "UGEL:", x: 190, y: 174, width: 30, height: 11, fontSize: 10 },
            { text: "Fecha:", x: 320, y: 174, width: 34, height: 11, fontSize: 10 },
        ],
        bbox: { x: 70, y: 174, width: 284, height: 11 },
    };

    const fragments = splitLineByLargeMeasuredGaps(line);

    assert.deepEqual(fragments.map((fragment) => fragment.text), ["DRE/GRE:", "UGEL:", "Fecha:"]);
    assert.deepEqual(fragments.map((fragment) => fragment.bbox.x), [70, 190, 320]);
});

test("convierte una tabla genérica a una cuadrícula Word estable", () => {
    const normalized = __normalizeTableRowsForTests({
        rows: [
            ["Producto", "Cantidad"],
            ["A", "10"],
            ["B", "20"],
        ],
        headers: [],
    });

    assert.deepEqual(normalized.headers, ["Producto", "Cantidad"]);
    assert.deepEqual(normalized.rows, [
        ["A", "10"],
        ["B", "20"],
    ]);
});

test("elimina la cabecera repetida por el extractor nativo", () => {
    const headers = ["Área curricular", "Competencias", "Docente asesor"];
    const normalized = __normalizeTableRowsForTests({
        headers,
        rows: [
            [...headers],
            ["Ciencia y Tecnología", "Indaga mediante métodos científicos", "1"],
        ],
    });

    assert.deepEqual(normalized.headers, headers);
    assert.deepEqual(normalized.rows, [
        ["Ciencia y Tecnología", "Indaga mediante métodos científicos", "1"],
    ]);
});

test("elimina filas técnicas vacías cubiertas por celdas combinadas", () => {
    const normalized = __normalizeTableRowsForTests({
        bbox: { x: 20, y: 20, width: 300, height: 200 },
        professional: {
            columnCount: 2,
            headerRows: 1,
            grid: [
                [{ text: "Etapa", columnIndex: 0 }, { text: "Fecha", columnIndex: 1 }],
                [{ text: "IE", columnIndex: 0, rowSpan: 3 }, { text: "Inicio", columnIndex: 1 }],
                [],
                [{ text: "Fin", columnIndex: 1 }],
            ],
        },
    });
    assert.equal(normalized.headerRows.length, 1);
    assert.equal(normalized.rows.length, 2);
});

test("separa listas, subtítulos y párrafos según la geometría PDF", () => {
    const makeLine = (text, y, x = 100) => ({
        text,
        bbox: { x, y, width: 360, height: 11 },
        words: [{ text, x, y, width: 100, height: 11, fontSize: 10 }],
    });
    const groups = __groupParagraphLinesForTests({
        lines: [
            makeLine("Primer párrafo", 100),
            makeLine("que continúa", 113),
            makeLine("• Categoría A", 140, 112),
            makeLine("• Categoría B", 156, 112),
            makeLine("2.1 Categorías A, B y C", 182),
            makeLine("Texto siguiente", 205),
        ],
    });

    assert.deepEqual(groups.map((group) => group.lines.length), [2, 1, 1, 1, 1]);
    assert.equal(groups[1].isBullet, true);
    assert.equal(groups[2].isBullet, true);
});

test("genera tablas DXA con anchos reales y combinaciones verticales", async () => {
    const table = {
        bbox: { x: 100, y: 200, width: 300, height: 120 },
        columnAnchors: [100, 160, 310],
        professional: {
            columnCount: 3,
            headerRows: 1,
            borderStyle: "grid",
            grid: [
                [
                    { text: "Área", columnIndex: 0 },
                    { text: "Competencias", columnIndex: 1 },
                    { text: "Asesor", columnIndex: 2 },
                ],
                [
                    { text: "Ciencia", columnIndex: 0, rowSpan: 2 },
                    { text: "Indaga", columnIndex: 1 },
                    { text: "1", columnIndex: 2 },
                ],
                [
                    { text: "Diseña", columnIndex: 1 },
                    { text: "1", columnIndex: 2 },
                ],
            ],
        },
    };
    const result = await renderWordDocument({
        title: "Tabla exacta",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                editableLayout: "flow",
                dimensions: { width: 595, height: 842 },
                content: { words: [], lines: [] },
                images: [],
                review: {},
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [],
                    tables: [table],
                    neuralFormulas: [],
                    spatial: { textBox: { x: 100, y: 100, width: 395, height: 650 } },
                    statistics: {},
                },
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");

    assert.match(xml, /<w:tblW w:type="dxa" w:w="6000"\/?>/);
    assert.match(xml, /<w:gridCol w:w="1200"\/?>/);
    assert.match(xml, /<w:gridCol w:w="3000"\/?>/);
    assert.match(xml, /<w:gridCol w:w="1800"\/?>/);
    assert.match(xml, /<w:vMerge w:val="restart"\/?>/);
    // La tabla empieza en x=100; el margen calculado está limitado a 90 pt.
    assert.match(xml, /<w:tblInd w:type="dxa" w:w="200"\/?>/);
});

test("transporta rellenos nativos por celda sin inventar color en cabeceras blancas", async () => {
    const table = enhanceTable({
        source: "pdfplumber-lines", structuralScore: 96,
        bbox: { x: 80, y: 100, width: 300, height: 60 },
        columnAnchors: [80, 230], headers: ["Color", "Sin fondo"],
        structure: { raw: [
            { cells: [
                { text: "Color", columnIndex: 0, shading: "#C7EAFB", bbox: { x: 80, y: 100, width: 150, height: 30 } },
                { text: "Sin fondo", columnIndex: 1, shading: null, bbox: { x: 230, y: 100, width: 150, height: 30 } },
            ] },
            { cells: [
                { text: "Dato", columnIndex: 0, shading: "#E2F0D9", bbox: { x: 80, y: 130, width: 150, height: 30 } },
                { text: "Valor", columnIndex: 1, shading: null, bbox: { x: 230, y: 130, width: 150, height: 30 } },
            ] },
        ] },
    });
    const result = await renderWordDocument({
        title: "Rellenos nativos", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [], lines: [] }, images: [], review: {},
            analysis: { zones: [], paragraphs: [], tables: [table], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    const cells = xml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
    assert.equal(cells.length, 4);
    assert.match(cells[0], /w:fill="C7EAFB"/);
    assert.doesNotMatch(cells[1], /<w:shd/);
    assert.match(cells[2], /w:fill="E2F0D9"/);
    assert.doesNotMatch(cells[3], /<w:shd/);
});

test("cada sección declara encabezado y pie propios, incluso si están vacíos", async () => {
    const line = { text: "177", bbox: { x: 500, y: 780, width: 20, height: 10 },
        words: [{ text: "177", x: 500, y: 780, width: 20, height: 10, fontSize: 9 }] };
    const makePage = (pageNumber, zones, editableLayout = "flow") => ({
        pageNumber, editableLayout, dimensions: { width: 595, height: 842 },
        content: { words: [], lines: [] }, images: [], review: {},
        analysis: { zones, paragraphs: [], lines: [], tables: [],
            spatial: { textBox: { x: 80, y: 80, width: 430, height: 680 } }, statistics: {} },
    });
    const result = await renderWordDocument({ title: "Aislamiento de secciones", mode: "editable", pages: [
        makePage(1, [{ type: "footer", lines: [line], bbox: line.bbox }]),
        makePage(2, []), makePage(3, [], "positioned"),
    ] });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    assert.equal((xml.match(/<w:footerReference /g) || []).length, 3);
    assert.equal((xml.match(/<w:headerReference /g) || []).length, 3);
    assert.match(xml, /<w:pgNumType w:start="177"\/>/);
    const footers = await Promise.all(Object.keys(archive.files)
        .filter((name) => /^word\/footer\d+\.xml$/.test(name))
        .map((name) => archive.file(name).async("string")));
    assert.equal(footers.filter((footer) => footer.includes(">177<")).length, 1);
});

test("no duplica el pie dentro del cuerpo de una página posicionada", async () => {
    const bodyLine = { text: "Contenido editable", bbox: { x: 80, y: 120, width: 120, height: 12 },
        words: [{ text: "Contenido editable", x: 80, y: 120, width: 120, height: 12, fontSize: 10 }] };
    const footerLine = { text: "170", bbox: { x: 500, y: 800, width: 20, height: 10 },
        words: [{ text: "170", x: 500, y: 800, width: 20, height: 10, fontSize: 9 }] };
    const result = await renderWordDocument({ title: "Pie posicionado", mode: "editable", pages: [{
        pageNumber: 3, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
        content: { words: [...bodyLine.words, ...footerLine.words], lines: [bodyLine, footerLine] },
        images: [], review: {}, regionAnalysis: { regions: [] },
        analysis: { zones: [{ type: "footer", lines: [footerLine], bbox: footerLine.bbox }],
            paragraphs: [], lines: [bodyLine, footerLine], tables: [], spatial: {}, statistics: {} },
    }] });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");
    const footerXml = await archive.file("word/footer1.xml").async("string");
    assert.doesNotMatch(documentXml, />170</);
    assert.match(footerXml, />170</);
});

test("serializa título, tabla y cierre según el orden de lectura de la página", async () => {
    const makeLine = (text, y) => ({
        text,
        bbox: { x: 70, y, width: 220, height: 11 },
        words: [{ text, x: 70, y, width: 220, height: 11, fontSize: 10 }],
    });
    const title = makeLine("TÍTULO ANTES DE TABLA", 70);
    const closing = makeLine("CIERRE DESPUÉS DE TABLA", 250);
    const table = {
        bbox: { x: 70, y: 110, width: 300, height: 80 },
        professional: {
            columnCount: 2,
            headerRows: 1,
            borderStyle: "grid",
            grid: [
                [
                    { text: "CABECERA A", columnIndex: 0, bbox: { x: 70, y: 110, width: 150, height: 40 } },
                    { text: "CABECERA B", columnIndex: 1, bbox: { x: 220, y: 110, width: 150, height: 40 } },
                ],
                [
                    { text: "CELDA A", columnIndex: 0, bbox: { x: 70, y: 150, width: 150, height: 40 } },
                    { text: "CELDA B", columnIndex: 1, bbox: { x: 220, y: 150, width: 150, height: 40 } },
                ],
            ],
        },
    };
    const result = await renderWordDocument({
        title: "Orden interno", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [...title.words, ...closing.words], lines: [title, closing] },
            images: [], review: {},
            analysis: { zones: [], paragraphs: [], tables: [table], spatial: {}, statistics: {} },
            regionAnalysis: { regions: [
                { id: "title", type: "heading", readingOrder: 0, ...title, lines: [title] },
                { id: "table", type: "table", readingOrder: 1, bbox: table.bbox, content: table },
                { id: "closing", type: "text", readingOrder: 2, ...closing, lines: [closing] },
            ] },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    assert.ok(xml.indexOf("TÍTULO ANTES DE TABLA") < xml.indexOf("CABECERA A"));
    assert.ok(xml.indexOf("CABECERA A") < xml.indexOf("CIERRE DESPUÉS DE TABLA"));
    assert.equal((xml.match(/<w:tbl>/g) || []).length, 1);
});

test("agrupa líneas regulares de un párrafo posicionado en un solo cuadro", async () => {
    const lines = [0, 13, 26].map((offset, index) => ({
        text: `Línea ${index + 1}`,
        bbox: { x: 70, y: 100 + offset, width: 220, height: 10 },
        words: [{ text: `Línea ${index + 1}`, x: 70, y: 100 + offset,
            width: 50, height: 10, fontSize: 10, source: "native-secondary" }],
    }));
    const result = await renderWordDocument({
        title: "Párrafo compacto", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: lines.flatMap((line) => line.words), lines },
            images: [], review: {},
            analysis: { zones: [], paragraphs: [], tables: [], spatial: {}, statistics: {} },
            regionAnalysis: { regions: [{
                id: "paragraph", type: "text", readingOrder: 0,
                text: lines.map((line) => line.text).join(" "),
                bbox: { x: 70, y: 100, width: 220, height: 36 },
                words: lines.flatMap((line) => line.words), lines,
            }] },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    assert.equal((xml.match(/<w:framePr /g) || []).length, 1);
    assert.equal((xml.match(/<w:br\/>/g) || []).length, 2);
});

test("posiciona un párrafo agrupado por las cajas de línea aunque las palabras usen bbox", async () => {
    const lines = [0, 13].map((offset, index) => ({
        text: `Bloque ${index + 1}`,
        bbox: { x: 90, y: 300 + offset, width: 180, height: 10 },
        words: [{ text: `Bloque ${index + 1}`, bbox: { x: 90, y: 300 + offset, width: 60, height: 10 },
            fontSize: 10, source: "native" }],
    }));
    const result = await renderWordDocument({
        title: "Coordenadas de línea", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: lines.flatMap((line) => line.words), lines }, images: [], review: {},
            analysis: { zones: [], paragraphs: [], tables: [], spatial: {}, statistics: {} },
            regionAnalysis: { regions: [{
                id: "nested-bbox", type: "text", readingOrder: 0,
                bbox: { x: 90, y: 300, width: 180, height: 23 },
                text: "Bloque 1 Bloque 2", lines,
            }] },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    const y = Number(/<w:framePr[^>]*w:y="(\d+)"/.exec(xml)?.[1]);
    assert.ok(y > 5_800 && y < 6_100, `posición vertical inesperada: ${y}`);
});

test("mantiene una tabla Word aunque la página requiera fondo limpio", async () => {
    const png = new Uint8Array(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
    ));
    const table = {
        bbox: { x: 80, y: 120, width: 240, height: 50 },
        professional: { columnCount: 2, headerRows: 0, borderStyle: "grid", grid: [[
            { text: "EDITABLE A", columnIndex: 0, bbox: { x: 80, y: 120, width: 120, height: 50 } },
            { text: "EDITABLE B", columnIndex: 1, bbox: { x: 200, y: 120, width: 120, height: 50 } },
        ]] },
    };
    const result = await renderWordDocument({
        title: "Fondo y tabla", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            renderedPage: { data: png, type: "png", role: "clean-editable-background" },
            content: { words: [], lines: [] }, images: [], review: {},
            analysis: { zones: [], paragraphs: [], tables: [table], spatial: {}, statistics: {} },
            regionAnalysis: { regions: [{
                id: "table", type: "table", readingOrder: 0, bbox: table.bbox, content: table,
            }] },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    assert.match(xml, /<w:tbl>/);
    assert.match(xml, />EDITABLE A</);
    assert.match(xml, /<wp:anchor/);
});

test("respeta alturas nativas y saltos de línea en tablas posicionadas", async () => {
    const table = {
        bbox: { x: 100, y: 120, width: 300, height: 96 },
        columnAnchors: [100, 160],
        professional: {
            columnCount: 2,
            headerRows: 0,
            borderStyle: "grid",
            typography: { fontSize: 9, fontFamily: "Arial" },
            grid: [
                [
                    {
                        text: "UGEL",
                        sourceLines: ["UGEL"],
                        columnIndex: 0,
                        alignment: "center",
                        bold: true,
                        bbox: { x: 100, y: 120, width: 60, height: 48 },
                    },
                    {
                        text: "Línea uno Línea dos",
                        sourceLines: ["Línea uno", "Línea dos"],
                        columnIndex: 1,
                        bbox: { x: 160, y: 120, width: 240, height: 48 },
                    },
                ],
                [
                    {
                        text: "DRE",
                        sourceLines: ["DRE"],
                        columnIndex: 0,
                        alignment: "center",
                        bbox: { x: 100, y: 168, width: 60, height: 48 },
                    },
                    {
                        text: "Detalle",
                        sourceLines: ["Detalle"],
                        columnIndex: 1,
                        bbox: { x: 160, y: 168, width: 240, height: 48 },
                    },
                ],
            ],
        },
    };
    const result = await renderWordDocument({
        title: "Tabla posicionada",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                editableLayout: "flow",
                dimensions: { width: 595, height: 842 },
                content: { words: [], lines: [] },
                images: [],
                review: {},
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [],
                    tables: [table],
                    neuralFormulas: [],
                    spatial: { textBox: table.bbox },
                    statistics: {},
                },
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");

    assert.match(xml, /<w:trHeight w:val="\d+" w:hRule="atLeast"\/?>/);
    assert.match(xml, /<w:br\/>/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /<w:top w:val="single" w:color="000000"/);
});

test("el avance de una celda usa el cuerpo del texto y la caja de la línea siguiente", () => {
    const line = (y, fontSize, extra = []) => ({
        bbox: { y: y - (extra.length ? 0.63 : 0) },
        words: [{ text: "Texto", y, height: fontSize, fontSize }, ...extra],
    });
    const layout = __planNativeCellLinesForTests([
        line(100, 9, [{ text: "13", y: 99.37, height: 6, fontSize: 6, superscript: true }]),
        line(110.32, 9),
        line(125.92, 9),
    ], 9);
    assert.equal(layout[0].top, 100);
    assert.equal(layout[0].fontSize, 9, "la referencia pequeña no reduce la caja del cuerpo de texto");
    assert.equal(layout[0].after, 0, "el superíndice no añade un espacio artificial");
    assert.ok(Math.abs(layout[1].after - 5.25) < 0.001, "se conserva el salto adicional del PDF");
    assert.equal(layout[2].after, 0);
    assert.deepEqual(__planNativeCellLinesForTests([], 9), []);
    const smallThenLarge = __planNativeCellLinesForTests([line(100, 8), line(113, 11)], 9);
    assert.ok(Math.abs(smallThenLarge[0].after - 0.35) < 0.001,
        "el espacio usa la altura de 11 pt siguiente, no los 8 pt anteriores");
});

test("usa líneas base medidas entre tamaños mixtos sin afectar el servicio antiguo", () => {
    const lines = [
        { bbox: { y: 492.48 }, words: [{ text: "Grande", y: 492.48, fontSize: 9.96, baselineY: 500.35 }] },
        { bbox: { y: 505.68 }, words: [{ text: "Grande", y: 505.68, fontSize: 9.96, baselineY: 513.55 }] },
        { bbox: { y: 518.68 }, words: [{ text: "Pequeña", y: 518.68, fontSize: 9, baselineY: 525.79 }] },
    ];
    const measured = __planNativeCellLinesForTests(lines, 9);
    assert.ok(Math.abs(measured[1].advance - 12.24) < 0.001);
    assert.ok(Math.abs(measured[1].after - 1.89) < 0.001);
    for (const baselineY of [null, undefined, NaN]) {
        lines[2].words[0].baselineY = baselineY;
        assert.ok(Math.abs(__planNativeCellLinesForTests(lines, 9)[1].advance - 13) < 0.001);
    }
});

test("conserva tamaño y desplazamiento nativos de superíndices y subíndices en celdas", async () => {
    const makeWord = (text, x, y, size, extra = {}) => ({
        text, x, y, width: text.length * size * 0.5, height: size, fontSize: size,
        fontFamily: "Arial", source: "native-secondary", ...extra,
    });
    const words = [makeWord("Referencia", 105, 123, 9),
        makeWord("13", 150, 122.37, 6, { superscript: true })];
    const lowerWords = [makeWord("H", 105, 138, 9),
        makeWord("2", 111, 146, 4, { subscript: true })];
    const table = {
        bbox: { x: 100, y: 120, width: 200, height: 50 }, columnAnchors: [100, 200],
        professional: { columnCount: 2, headerRows: 0, borderStyle: "grid", grid: [[
            { text: "Referencia13 H2", columnIndex: 0, bbox: { x: 100, y: 120, width: 100, height: 50 },
                nativeLines: [
                    { words, bbox: { x: 105, y: 122.37, width: 51, height: 9.63 } },
                    { words: lowerWords, bbox: { x: 105, y: 138, width: 10, height: 12 } },
                ] },
            { text: "", columnIndex: 1, bbox: { x: 200, y: 120, width: 100, height: 50 } },
        ]] },
    };
    const result = await renderWordDocument({ title: "Referencias de celda", mode: "editable", pages: [{
        pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
        content: { words: [], lines: [] }, images: [], review: {},
        analysis: { zones: [], tables: [table], spatial: {}, statistics: {} },
    }] });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await zip.file("word/document.xml").async("string");
    const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) || [];
    const raised = runs.find((run) => run.includes('>13</w:t>'));
    const lowered = runs.find((run) => run.includes('>2</w:t>'));
    assert.match(raised, /<w:position w:val="7"/);
    assert.match(raised, /<w:sz w:val="12"/);
    assert.match(lowered, /<w:position w:val="-6"/);
    assert.match(lowered, /<w:sz w:val="8"/);
    assert.doesNotMatch(raised + lowered, /w:vertAlign/);
    assert.match(xml, /w:before="36"/, "la primera línea se coloca usando el cuerpo, no el superíndice");
    assert.match(xml, /w:tblPr/);
});

test("una celda vacía medida no agrega margen ni reduce la altura de su fila nativa", async () => {
    const first = { text: "", columnIndex: 0, bbox: { x: 100, y: 100, width: 100, height: 40 } };
    const second = { text: "Texto", columnIndex: 1, bbox: { x: 200, y: 100, width: 100, height: 40 },
        nativeLines: [{ words: [{ text: "Texto", x: 205, y: 110, height: 9, width: 30, fontSize: 9 }],
            bbox: { x: 205, y: 110, width: 30, height: 9 } }] };
    const table = { bbox: { x: 100, y: 100, width: 200, height: 40 }, columnAnchors: [100, 200],
        professional: { columnCount: 2, headerRows: 0, borderStyle: "grid", grid: [[first, second]] } };
    const model = { title: "Fila nativa", mode: "editable", pages: [{
        pageNumber: 1, editableLayout: "flow", dimensions: { width: 595, height: 842 },
        content: { words: [], lines: [] }, images: [], review: {},
        analysis: { zones: [], tables: [table], spatial: {}, statistics: {} },
    }] };
    const xmlFor = async () => {
        const result = await renderWordDocument(model);
        const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
        return zip.file("word/document.xml").async("string");
    };
    const xml = await xmlFor();
    assert.match(xml, /<w:trHeight w:val="\d+" w:hRule="atLeast"/);
    assert.equal((xml.match(/<w:top w:type="dxa" w:w="0"/g) || []).length, 2);
    first.text = "Sin geometría de texto";
    const mixedXml = await xmlFor();
    assert.match(mixedXml, /<w:trHeight w:val="\d+" w:hRule="atLeast"/);
    assert.match(mixedXml, /<w:top w:type="dxa" w:w="30"/);
});

test("ancla el texto tras una viñeta nativa sin depender de la fuente sustituida", async () => {
    const marker = { text: "▪", x: 108, y: 110, width: 4.122, height: 9,
        fontSize: 9, fontFamily: "Wingdings", source: "native-secondary" };
    const word = { ...marker, text: "Texto", x: 126, width: 30, fontFamily: "Arial" };
    const cell = { text: "▪ Texto", columnIndex: 0, bbox: { x: 100, y: 100, width: 100, height: 30 },
        nativeLines: [{ words: [marker, word], bbox: { x: 108, y: 110, width: 48, height: 9 } }] };
    const table = { bbox: { x: 100, y: 100, width: 200, height: 30 }, columnAnchors: [100, 200],
        professional: { columnCount: 2, headerRows: 0, borderStyle: "grid", grid: [[cell,
            { text: "", columnIndex: 1, bbox: { x: 200, y: 100, width: 100, height: 30 } }]] } };
    const xmlFor = async () => {
        const result = await renderWordDocument({ title: "Viñeta medida", mode: "editable", pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [], lines: [] }, images: [], review: {},
            analysis: { zones: [], tables: [table], spatial: {}, statistics: {} },
        }] });
        const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
        return zip.file("word/document.xml").async("string");
    };
    const original = { ...marker };
    const originalWord = { ...word };
    for (const text of ["▪", "•", "◦", "‣", "·"]) {
        marker.text = text;
        const xml = await xmlFor();
        assert.match(xml, /<w:tab w:val="left" w:pos="520"\/>/,
            "la parada se mide desde la celda, no desde la sangría del párrafo");
        assert.match(xml, /<w:tab\/>/);
        assert.match(xml, />Texto<\/w:t>/);
    }
    const rejected = [
        [{ text: "1." }, {}], [{ text: "▪Texto" }, {}], [{ source: "ocr" }, {}],
        [{ rotation: 90 }, {}], [{ x: 98 }, {}], [{ width: NaN }, {}],
        [{}, { source: "ocr" }], [{}, { x: 112 }], [{}, { x: 201 }],
    ];
    for (const [markerPatch, wordPatch] of rejected) {
        Object.assign(marker, original, markerPatch);
        Object.assign(word, originalWord, wordPatch);
        assert.doesNotMatch(await xmlFor(), /<w:tab[ />]/,
            `no forzar tabulación para ${JSON.stringify([markerPatch, wordPatch])}`);
    }
});

test("genera un DOCX editable desde el modelo híbrido", async () => {
    const word = { text: "NovaPDF", x: 36, y: 40, width: 55, height: 12, fontSize: 11 };
    const line = {
        text: "NovaPDF",
        words: [word],
        bbox: { x: 36, y: 40, width: 55, height: 12 },
    };
    const paragraph = {
        text: "NovaPDF",
        lines: [line],
        words: [word],
        bbox: line.bbox,
    };
    const model = {
        title: "Prueba",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                dimensions: { width: 612, height: 792 },
                analysis: {
                    zones: [{ type: "body", lines: [line], bbox: line.bbox }],
                    paragraphs: [paragraph],
                    lines: [line],
                    tables: [],
                    columns: { count: 1, columns: [] },
                    statistics: { averageWordHeight: 12 },
                    spatial: { textBox: line.bbox },
                },
            },
        ],
    };

    const result = await renderWordDocument(model);
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.ok(result.blob.size > 1_000);
    assert.ok(result.generationMs >= 0);
    assert.match(documentXml, /NovaPDF/);
    assert.doesNotMatch(
        documentXml,
        /w:framePr/,
        "el modo editable debe usar párrafos Word estables, no cuadros absolutos"
    );
});

test("conserva ancho y alto reales de una página horizontal", async () => {
    const result = await renderWordDocument({
        title: "Horizontal",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                dimensions: { width: 792, height: 612 },
                content: { words: [], lines: [] },
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [],
                    tables: [],
                    columns: { count: 1, columns: [] },
                    statistics: { averageWordHeight: 12 },
                    spatial: {
                        textBox: { x: 36, y: 36, width: 720, height: 540 },
                    },
                },
                images: [],
                review: {},
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(
        documentXml,
        /<w:pgSz w:w="15840" w:h="12240"/
    );
});

test("conserva una página PDF vacía sin insertar mensajes artificiales", async () => {
    const result = await renderWordDocument({
        title: "Página vacía",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                editableLayout: "positioned",
                dimensions: { width: 595, height: 842 },
                content: { words: [], lines: [] },
                images: [],
                review: {},
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [],
                    tables: [],
                    neuralFormulas: [],
                    spatial: {},
                    statistics: {},
                },
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.doesNotMatch(documentXml, /sin contenido reconstruible/i);
});

test("incrusta la captura de página en el modo de máxima fidelidad", async () => {
    const png = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64"
        )
    );
    const result = await renderWordDocument({
        title: "Fidelidad",
        mode: "fidelity",
        pages: [
            {
                pageNumber: 1,
                dimensions: { width: 612, height: 792 },
                renderedPage: { data: png, type: "png" },
                analysis: {},
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const mediaFiles = Object.keys(archive.files).filter((path) =>
        path.startsWith("word/media/") && !path.endsWith("/")
    );

    assert.equal(mediaFiles.length, 1);
});

test("superpone lineas editables sobre un fondo limpio posicionado", async () => {
    const png = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64"
        )
    );
    const word = {
        text: "NovaDOC",
        x: 48,
        y: 72,
        width: 62,
        height: 13,
        fontSize: 11,
        confidence: 92,
        source: "ocr",
    };
    const line = {
        text: "NovaDOC",
        words: [word],
        bbox: { x: 48, y: 72, width: 62, height: 13 },
    };
    const result = await renderWordDocument({
        title: "Fondo limpio",
        mode: "fidelity",
        pages: [
            {
                pageNumber: 1,
                dimensions: { width: 612, height: 792 },
                renderedPage: {
                    data: png,
                    type: "png",
                    role: "clean-editable-background",
                },
                content: { lines: [line] },
                analysis: { zones: [], spatial: {}, statistics: {} },
                review: {},
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /NovaDOC/);
    assert.match(documentXml, /w:framePr/);
    assert.match(documentXml, /w:hRule="atLeast"/);
    const positionedFrame = /<w:framePr[^>]*w:w="(\d+)"/.exec(documentXml);
    assert.ok(positionedFrame);
    assert.ok(
        Number(positionedFrame[1]) >= 1_500,
        "un renglón PDF debe reservar ancho para diferencias de métricas tipográficas"
    );
    assert.doesNotMatch(documentXml, /w:line="1"/);
});

test("posiciona páginas complejas sin centrar los párrafos largos", async () => {
    const png = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64"
        )
    );
    const makeLine = (text, y, width) => ({
        text,
        words: text.split(" ").map((value, index) => ({
            text: value,
            x: 80 + index * 24,
            y,
            width: 22,
            height: 11,
            fontSize: 9,
        })),
        bbox: { x: 80, y, width, height: 12 },
    });
    const title = makeLine("ANEXO E", 310, 150);
    title.bbox.x = 222;
    const paragraph = makeLine(
        "La Feria Escolar Nacional convoca a la participación de estudiantes de todo el país",
        150,
        430
    );
    const result = await renderWordDocument({
        title: "Posicionamiento adaptable",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                editableLayout: "positioned",
                dimensions: { width: 595, height: 842 },
                renderedPage: {
                    data: png,
                    type: "png",
                    role: "clean-editable-background",
                },
                content: { lines: [title, paragraph] },
                analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
                review: {},
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:framePr/);
    assert.match(documentXml, /<w:jc w:val="center"\/>/);
    assert.match(documentXml, /<w:jc w:val="left"\/>/);
    assert.match(documentXml, /<w:pgMar w:top="20" w:right="20" w:bottom="20" w:left="20"/);
});

test("amplía hacia la izquierda los cuadros alineados a la derecha", async () => {
    const footerWord = {
        text: "177",
        x: 507,
        y: 780,
        width: 18,
        height: 11,
        fontSize: 11,
        fontFamily: "Arial",
        source: "native-secondary",
    };
    const footerLine = {
        text: "177",
        words: [footerWord],
        bbox: { x: 507, y: 780, width: 18, height: 11 },
    };
    const result = await renderWordDocument({
        title: "Pie derecho",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                editableLayout: "positioned",
                dimensions: { width: 595, height: 842 },
                content: { words: [footerWord], lines: [footerLine] },
                images: [],
                review: {},
                // La lógica de expansión de cuadros (framePr) vive en createLayeredFidelityPageChildren,
                // que se activa cuando hay un fondo limpio decorativo.
                renderedPage: {
                    data: new Uint8Array(Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        "base64"
                    )),
                    type: "png",
                    role: "clean-editable-background",
                },
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [footerLine],
                    tables: [],
                    neuralFormulas: [],
                    spatial: { textBox: footerLine.bbox },
                    statistics: {},
                },
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    const frame = /<w:framePr[^>]*w:w="(\d+)"[^>]*w:x="(\d+)"/.exec(xml);

    assert.ok(frame);
    assert.ok(Number(frame[1]) > 360, "el cuadro debe ser más ancho que la caja PDF");
    assert.ok(Number(frame[2]) < 10_140, "la reserva debe crecer hacia la izquierda");
    assert.match(xml, /w:y="15\d{3}"/, "el cuadro debe compensar el ascendente de Word");
    assert.match(xml, />177</);
});

test("conserva espacios nativos estrechos sin espaciado negativo ni compresión global", async () => {
    const words = [
        { text: "Uno", x: 40, y: 60, width: 20, height: 12, fontSize: 12, fontFamily: "Arial", source: "native-secondary" },
        { text: "Dos", x: 62, y: 60, width: 20, height: 12, fontSize: 12, fontFamily: "Arial", source: "native-secondary" },
    ];
    const line = { text: "Uno Dos", words, bbox: { x: 40, y: 60, width: 42, height: 12 } };
    const result = await renderWordDocument({
        title: "Espacios precisos", mode: "editable",
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words, lines: [line] }, images: [], review: {},
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await archive.file("word/document.xml").async("string");
    assert.match(xml, /<w:w w:val="100"/);
    assert.doesNotMatch(xml, /<w:spacing w:val="-/);
    assert.match(xml, /<w:sz w:val="24"/);
});

test("no duplica decoraciones vectoriales del fondo y conserva el formato editable sin fondo", async () => {
    const png = new Uint8Array(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfsAAAAASUVORK5CYII=", "base64"));
    for (const [withBackground, excludeImages] of [[true, false], [false, false], [true, true]]) {
        const words = [
            { text: "Vector", x: 40, y: 60, width: 35, height: 12, fontSize: 12,
                underline: true, strike: true, vectorUnderline: true, vectorStrike: true },
            { text: "Manual", x: 80, y: 60, width: 40, height: 12, fontSize: 12,
                underline: true, strike: true },
        ];
        const result = await renderWordDocument({
            title: "Decoraciones", mode: "editable", pages: [{
                pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
                content: { words, lines: [{ words, text: "Vector Manual", bbox: { x: 40, y: 60, width: 80, height: 12 } }] },
                images: [], review: { excludeImages },
                renderedPage: withBackground ? { data: png, type: "png", role: "clean-editable-background" } : null,
                analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
            }],
        });
        const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
        const xml = await zip.file("word/document.xml").async("string");
        const expected = withBackground && !excludeImages ? 1 : 2;
        assert.equal((xml.match(/<w:u\b/g) || []).length, expected);
        assert.equal((xml.match(/<w:strike\s*\/>/g) || []).length, expected);
        assert.match(xml, />Vector</);
        assert.match(xml, /Manual</);
    }
});

test("genera formulas OMML editables desde LaTeX neuronal", async () => {
    const formulaBox = { x: 80, y: 120, width: 260, height: 42 };
    const result = await renderWordDocument({
        title: "Formula editable",
        mode: "editable",
        pages: [
            {
                pageNumber: 1,
                dimensions: { width: 612, height: 792 },
                analysis: {
                    zones: [],
                    paragraphs: [],
                    lines: [],
                    tables: [],
                    neuralFormulas: [
                        {
                            id: "formula-1",
                            bbox: formulaBox,
                            latex: "\\frac{x^{2}}{y_1}",
                            confidence: 94,
                        },
                    ],
                    columns: { count: 1, columns: [] },
                    statistics: { averageWordHeight: 12 },
                    spatial: { textBox: formulaBox },
                },
                images: [],
                review: {},
            },
        ],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /m:oMath/);
    assert.match(documentXml, /m:f/);
    assert.match(documentXml, /m:sSup/);
    assert.match(documentXml, /m:sSub/);
});

test("incrusta la fuente recuperada y la asigna a los textos compatibles", async () => {
    const word = {
        text: "Eureka", x: 80, y: 120, width: 120, height: 36,
        fontSize: 34, fontFamily: "Quicksand", source: "native-secondary",
    };
    const line = { text: "Eureka", words: [word], bbox: { x: 80, y: 120, width: 120, height: 36 } };
    const result = await renderWordDocument({
        title: "Fuente PDF incrustada",
        mode: "editable",
        embeddedFonts: [{
            name: "Quicksand Light",
            embedding: "editable",
            data: new Uint8Array(Array.from({ length: 64 }, (_, index) => index)),
        }],
        pages: [{
            pageNumber: 1,
            editableLayout: "positioned",
            dimensions: { width: 595, height: 842 },
            content: { words: [word], lines: [line] },
            images: [], review: {},
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const fontTable = await archive.file("word/fontTable.xml").async("string");
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.ok(archive.file("word/fonts/font1.odttf"));
    assert.match(fontTable, /w:name="Quicksand Light"/);
    assert.match(fontTable, /w:altName w:val="Lucida Sans Unicode"/);
    assert.match(fontTable, /w:embedRegular/);
    const key = fontTable.match(/w:fontKey="\{([0-9A-F-]+)\}"/)?.[1];
    assert.ok(key, "el identificador hexadecimal debe ser compatible con LibreOffice");
    const keyBytes = key.replaceAll("-", "").match(/../g).map((pair) => parseInt(pair, 16)).reverse();
    const embeddedBytes = await archive.file("word/fonts/font1.odttf").async("uint8array");
    const decoded = embeddedBytes.map((value, index) => index < 32 ? value ^ keyBytes[index % 16] : value);
    assert.deepEqual([...decoded], Array.from({ length: 64 }, (_, index) => index),
        "normalizar el GUID no altera ni corrompe la fuente transportada");
    assert.match(documentXml, /w:ascii="Quicksand Light"/);
    assert.doesNotMatch(documentXml, /w:ascii="Century Gothic"/);
});

test("transporta fuentes documentales comunes y excluye fuentes de símbolos", async () => {
    const words = [
        { text: "Arial", x: 80, y: 120, width: 80, height: 18, fontSize: 12, fontFamily: "Arial" },
        { text: "Calibri", x: 80, y: 150, width: 80, height: 18, fontSize: 12, fontFamily: "Calibri" },
    ];
    const result = await renderWordDocument({
        title: "Fuentes portátiles", mode: "editable",
        embeddedFonts: [
            { name: "Arial", sourceName: "ArialMT", embedding: "editable", data: new Uint8Array(64) },
            { name: "Calibri", sourceName: "ABCDEF+Calibri", embedding: "editable", data: new Uint8Array(96) },
            { name: "Symbol", sourceName: "SymbolMT", embedding: "editable", data: new Uint8Array(128) },
        ],
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: {
                words,
                lines: words.map((word) => ({ text: word.text, words: [word], bbox: { x: word.x, y: word.y, width: word.width, height: word.height } })),
            },
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const fontTable = await archive.file("word/fontTable.xml").async("string");
    const embedded = Object.keys(archive.files).filter((name) => /^word\/fonts\/font\d+\.odttf$/.test(name));

    assert.equal(embedded.length, 2);
    assert.match(fontTable, /w:font w:name="Arial">[\s\S]*?w:embedRegular/);
    assert.match(fontTable, /w:font w:name="Calibri">[\s\S]*?w:embedRegular/);
    assert.doesNotMatch(fontTable, /w:font w:name="Symbol">[\s\S]*?w:embedRegular/);
});

test("consolida variantes regular y negrita en una sola familia Word", async () => {
    const words = [
        { text: "Texto", x: 80, y: 100, width: 50, height: 16, fontSize: 12,
            fontFamily: "CanvaSans-Regular", source: "native-secondary" },
        { text: "fuerte", x: 140, y: 100, width: 54, height: 16, fontSize: 12,
            fontFamily: "CanvaSans-Bold", source: "native-secondary", bold: true },
    ];
    const result = await renderWordDocument({
        title: "Familia completa", mode: "editable",
        embeddedFonts: [
            { name: "Canva Sans", style: "Regular", sourceName: "AAAAAA+CanvaSans-Regular",
                embedding: "editable", data: new Uint8Array(64) },
            { name: "Canva Sans", style: "Bold", sourceName: "BBBBBB+CanvaSans-Bold",
                embedding: "editable", data: new Uint8Array(96) },
        ],
        pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words, lines: [{ words, text: "Texto fuerte", bbox: { x: 80, y: 100, width: 114, height: 16 } }] },
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const fontTable = await archive.file("word/fontTable.xml").async("string");
    const documentXml = await archive.file("word/document.xml").async("string");
    const familyNode = fontTable.match(/<w:font w:name="Canva Sans">[\s\S]*?<\/w:font>/)?.[0] || "";

    assert.equal(Object.keys(archive.files).filter((name) => /^word\/fonts\/font\d+\.odttf$/.test(name)).length, 2);
    assert.match(familyNode, /w:embedRegular/);
    assert.match(familyNode, /w:embedBold/);
    assert.match(familyNode, /w:altName w:val="Arial"/);
    assert.doesNotMatch(fontTable, /NovaPDF Embedded/);
    assert.match(documentXml, /w:ascii="Canva Sans"/);
    assert.match(documentXml, /<w:b\/>/);
});

test("asocia alias PDF con la familia interna y conserva las cuatro variantes", async () => {
    const variants = [
        { text: "Regular", style: "Regular" },
        { text: "Negrita", style: "Bold", bold: true },
        { text: "Cursiva", style: "Italic", italic: true },
        { text: "Mixta", style: "Bold Italic", bold: true, italic: true },
    ];
    const words = variants.map((variant, index) => ({
        ...variant,
        x: 60 + index * 75,
        y: 100,
        width: 65,
        height: 14,
        fontSize: 12,
        fontFamily: "DocumentoDisplay",
        source: "native-secondary",
    }));
    const embeddedFonts = variants.map((variant, index) => ({
        name: "Familia Interna",
        sourceName: `AAAAAA+DocumentoDisplay-${variant.style.replace(/\s/g, "")}`,
        aliases: ["DocumentoDisplay"],
        style: variant.style,
        embedding: "editable",
        data: new Uint8Array(64 + index * 32),
    }));
    const result = await renderWordDocument({
        title: "Variantes tipográficas", mode: "editable", embeddedFonts,
        pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words, lines: [{ words, text: "Regular Negrita Cursiva Mixta", bbox: { x: 60, y: 100, width: 290, height: 14 } }] },
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const fontTable = await archive.file("word/fontTable.xml").async("string");
    const documentXml = await archive.file("word/document.xml").async("string");
    const familyNode = fontTable.match(/<w:font w:name="Familia Interna">[\s\S]*?<\/w:font>/)?.[0] || "";

    assert.match(familyNode, /w:embedRegular/);
    assert.match(familyNode, /w:embedBold/);
    assert.match(familyNode, /w:embedItalic/);
    assert.match(familyNode, /w:embedBoldItalic/);
    assert.equal(Object.keys(archive.files).filter((name) => /^word\/fonts\/font\d+\.odttf$/.test(name)).length, 4);
    assert.ok((documentXml.match(/w:ascii="Familia Interna"/g) || []).length >= 4);
    assert.match(documentXml, /<w:b\/>/);
    assert.match(documentXml, /<w:i\/>/);
});

test("aplica kerning válido sin alterar la altura de línea calibrada", async () => {
    const word = { text: "AVATAR", x: 80, y: 100, width: 39, height: 12, fontSize: 10,
        fontFamily: "KerningAlias", source: "native-secondary" };
    const renderXml = async (font) => {
        const result = await renderWordDocument({
            title: "Métricas verticales", mode: "editable", embeddedFonts: [font],
            pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
                content: { words: [word], lines: [{ words: [word], text: word.text, bbox: word }] },
                images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
        });
        const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
        return archive.file("word/document.xml").async("string");
    };
    const baseFont = {
        name: "Familia Kerning Interna", aliases: ["KerningAlias"], style: "Regular",
        embedding: "editable", data: new Uint8Array(64),
        characterWidthsEm: { 65: 0.6, 86: 0.6, 84: 0.6, 82: 0.6 },
        ascentEm: 0.8, descentEm: 0.2, lineGapEm: 0.2,
    };
    const measuredXml = await renderXml({ ...baseFont, hasKerning: true });
    assert.match(measuredXml, /<w:kern w:val="20"\/>/);
    assert.match(measuredXml, /<w:spacing[^>]*w:line="230"[^>]*w:lineRule="exact"/);

    const neutralXml = await renderXml({ ...baseFont, hasKerning: false });
    assert.doesNotMatch(neutralXml, /<w:kern/);
    assert.doesNotMatch(neutralXml, /<w:kern w:val="0"\/>/);
});

test("no interpreta como estilo las sílabas internas del nombre de una fuente", async () => {
    const word = { text: "Nombre", x: 80, y: 100, width: 55, height: 16, fontSize: 12,
        fontFamily: "Blackadder ITC", source: "native-secondary" };
    const result = await renderWordDocument({
        title: "Nombre tipográfico", mode: "editable",
        embeddedFonts: [{ name: "Blackadder ITC", embedding: "editable", data: new Uint8Array(64) }],
        pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [word], lines: [{ words: [word], text: word.text, bbox: word }] },
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const fontTable = await archive.file("word/fontTable.xml").async("string");
    const documentXml = await archive.file("word/document.xml").async("string");
    assert.match(fontTable, /w:name="Blackadder ITC"/);
    assert.match(fontTable, /w:embedRegular/);
    assert.match(documentXml, /w:ascii="Blackadder ITC"/);
});

test("ajusta cada palabra nativa con el avance real de su fuente", async () => {
    const metricFont = {
        name: "Metric Sans", style: "Regular", embedding: "editable",
        data: new Uint8Array(64), spaceAdvanceEm: 0.25,
        characterWidthsEm: { 32: 0.25, 65: 0.6 },
    };
    const makeDocumentXml = async (word, embeddedFonts = [metricFont]) => {
        const result = await renderWordDocument({
            title: "Métrica horizontal", mode: "editable", embeddedFonts,
            pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
                content: { words: [word], lines: [{ words: [word], text: word.text, bbox: word }] },
                images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
        });
        const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
        return archive.file("word/document.xml").async("string");
    };
    const word = { text: "AA", x: 80, y: 100, width: 10.8, height: 12, fontSize: 10,
        fontFamily: "MetricSans-Regular", source: "native-secondary" };

    assert.match(await makeDocumentXml(word), /<w:w w:val="90"\/>/);
    word.width = 11.88;
    assert.match(await makeDocumentXml(word), /<w:w w:val="100"\/>/,
        "el redondeo menor de 1,5 % no introduce ruido de escala");
    word.width = 30;
    assert.match(await makeDocumentXml(word), /<w:w w:val="100"\/>/,
        "una escala extrema conserva la ruta segura anterior");
    word.width = 10.8;
    word.correctedText = "AAA";
    assert.match(await makeDocumentXml(word), /<w:w w:val="100"\/>/,
        "una corrección textual no reutiliza el ancho de la palabra original");

    const stableWord = { ...word, correctedText: undefined, fontFamily: "Arial", width: 10.8 };
    assert.match(await makeDocumentXml(stableWord, [{ ...metricFont, name: "Arial" }]),
        /<w:w w:val="100"\/>/,
        "las fuentes comunes conservan la métrica estable entre lectores");

    const tunedWord = { ...word, correctedText: undefined, fontFamily: "Quicksand", width: 10.8 };
    const tunedXml = await makeDocumentXml(tunedWord, [{ ...metricFont, name: "Quicksand" }]);
    // El ajuste per-caracter se aplica con la fuente Quicksand incrustada; el valor
    // exacto depende de characterWidthsEm (no de la tabla de sustitución tipográfica).
    assert.match(tunedXml, /<w:w w:val="\d+"\/>/);
});

test("mantiene títulos digitales grandes y conserva el límite de seguridad OCR", async () => {
    const words = [
        { text: "Título", x: 80, y: 80, width: 240, height: 72, fontSize: 72, source: "native-secondary" },
        { text: "OCR", x: 80, y: 200, width: 180, height: 72, fontSize: 72, source: "ocr" },
    ];
    const result = await renderWordDocument({ title: "Tamaños medidos", mode: "editable", pages: [{
        pageNumber: 1, editableLayout: "positioned", dimensions: { width: 800, height: 600 },
        content: { words, lines: words.map((word) => ({ words: [word], text: word.text, bbox: word })) },
        images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
    }] });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml = await zip.file("word/document.xml").async("string");
    const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g);
    assert.match(runs.find((run) => run.includes(">Título</w:t>")), /w:sz w:val="144"/);
    assert.match(runs.find((run) => run.includes(">OCR</w:t>")), /w:sz w:val="96"/);
});

test("usa la línea base medida para títulos de fuente incrustada con descendentes profundos", async () => {
    const word = { text: "Título", x: 80, y: 100, width: 240, height: 80, fontSize: 80,
        fontFamily: "Display", source: "native-secondary", baselineY: 146.1 };
    const frameY = async () => {
        const result = await renderWordDocument({ title: "Línea base", mode: "editable",
            embeddedFonts: [{ name: "Display", embedding: "editable", data: new Uint8Array(64) }],
            pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 800, height: 600 },
                content: { words: [word], lines: [{ words: [word], bbox: word }] }, images: [], review: {},
                // La lógica de framePr con baselineY vive en createLayeredFidelityPageChildren.
                renderedPage: { data: new Uint8Array(4), type: "png", role: "clean-editable-background" },
                analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
        });
        const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
        return Number((await zip.file("word/document.xml").async("string")).match(/<w:framePr[^>]*\bw:y="(\d+)"/)?.[1]);
    };
    assert.equal(await frameY(), 1450);
    for (const baselineY of [undefined, null, NaN, 100, 180]) {
        word.baselineY = baselineY;
        assert.equal(await frameY(), 1916, "no estimar una corrección grande sin una línea base válida");
    }
    word.baselineY = 146.1;
    word.source = "ocr";
    assert.equal(await frameY(), 1916);
});

test("conserva texto rotado a 90 y 270 grados como elementos Word editables", async () => {
    const makeLine = (text, x, rotation) => {
        const word = {
            text, x, y: 120, width: 14, height: 90,
            fontSize: 11, fontFamily: "Arial", rotation, source: "native-secondary",
        };
        return { text, words: [word], bbox: { x, y: 120, width: 14, height: 90 } };
    };
    const result = await renderWordDocument({
        title: "Texto rotado", mode: "editable", embeddedFonts: [],
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [], lines: [makeLine("ASCENDENTE", 80, 90), makeLine("DESCENDENTE", 140, 270)] },
            images: [], review: {},
            // El texto rotado (w:textDirection) requiere createRotatedTextFrame,
            // que solo se llama desde createLayeredFidelityPageChildren.
            renderedPage: { data: new Uint8Array(4), type: "png", role: "clean-editable-background" },
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:textDirection w:val="btLr"/);
    assert.match(documentXml, /w:textDirection w:val="tbRl"/);
    assert.match(documentXml, /<w:t xml:space="preserve">ASCENDENTE<\/w:t>/);
    assert.match(documentXml, /<w:t xml:space="preserve">DESCENDENTE<\/w:t>/);
    assert.match(documentXml, /w:tblpX="1600"/);
    assert.match(documentXml, /w:tblpX="2800"/);
});

test("no aplica un subconjunto incompleto cuando una familia PDF está fragmentada", async () => {
    const word = {
        text: "Eureka", x: 80, y: 120, width: 120, height: 36,
        fontSize: 34, fontFamily: "Quicksand", source: "native-secondary",
    };
    const line = { text: "Eureka", words: [word], bbox: { x: 80, y: 120, width: 120, height: 36 } };
    const result = await renderWordDocument({
        title: "Subconjuntos protegidos", mode: "editable",
        embeddedFonts: [
            { name: "Quicksand", sourceName: "AAAAAA+Quicksand-Light", embedding: "editable", data: new Uint8Array(64) },
            { name: "Quicksand", sourceName: "BBBBBB+Quicksand-Light", embedding: "editable", data: new Uint8Array(96) },
        ],
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [word], lines: [line] }, images: [], review: {},
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.equal(archive.file("word/fonts/font1.odttf"), null);
    assert.match(documentXml, /w:ascii="Century Gothic"/);
    assert.doesNotMatch(documentXml, /w:ascii="Quicksand"/);
});

test("usa una sustitución métrica probada para Quicksand pequeña sin fuente incrustable", async () => {
    const word = {
        text: "CRONOGRAMA", x: 90, y: 100, width: 170, height: 31,
        fontSize: 23, fontFamily: "Quicksand", source: "native-secondary",
    };
    const line = { text: word.text, words: [word], bbox: { x: 90, y: 100, width: 170, height: 31 } };
    const result = await renderWordDocument({
        title: "Sustitución tipográfica", mode: "editable", embeddedFonts: [],
        pages: [{
            pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [word], lines: [line] }, images: [], review: {},
            // La escala w:w=97 de Quicksand vive en createTextFrame (usesSmallQuicksand).
            renderedPage: { data: new Uint8Array(4), type: "png", role: "clean-editable-background" },
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:ascii="Lucida Sans Unicode"/);
    assert.match(documentXml, /w:w w:val="97"/);
});

test("una fuente restringida usa una sustitución determinista sin incrustar bytes", async () => {
    const word = { text: "Contrato", x: 80, y: 100, width: 54, height: 12, fontSize: 10,
        fontFamily: "FuentePrivada", source: "native-secondary" };
    const result = await renderWordDocument({
        title: "Sustitución restringida", mode: "editable",
        embeddedFonts: [{
            name: "Familia Interna Privada", aliases: ["FuentePrivada"],
            embedding: "restricted", data: null,
            characterWidthsEm: { 67: 0.62, 111: 0.5 },
        }],
        pages: [{ pageNumber: 1, editableLayout: "positioned", dimensions: { width: 595, height: 842 },
            content: { words: [word], lines: [{ words: [word], text: word.text, bbox: word }] },
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} } }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.equal(Object.keys(archive.files).filter((name) => /^word\/fonts\//.test(name)).length, 0);
    assert.match(documentXml, /w:ascii="Arial"/);
    assert.doesNotMatch(documentXml, /w:ascii="FuentePrivada"/);
});

test("une palabras cortadas con guion entre renglones consecutivos (dehyphenation)", () => {
    const lines = [
        {
            text: "La implemen-",
            words: [
                { text: "La", x: 50, y: 100, width: 15, height: 10 },
                { text: "implemen-", x: 70, y: 100, width: 60, height: 10 },
            ],
        },
        {
            text: "tación del sistema",
            words: [
                { text: "tación", x: 50, y: 115, width: 40, height: 10 },
                { text: "del", x: 95, y: 115, width: 20, height: 10 },
                { text: "sistema", x: 120, y: 115, width: 45, height: 10 },
            ],
        },
    ];

    const words = __dehyphenateLineWordsForTests(lines);
    assert.equal(words.length, 4);
    assert.equal(words[0].text, "La");
    assert.equal(words[1].text, "implementación");
    assert.equal(words[2].text, "del");
    assert.equal(words[3].text, "sistema");
});

test("detecta prefijos de listas numeradas estándar", () => {
    assert.equal(__startsNumberedListForTests("1. Introducción al problema"), true);
    assert.equal(__startsNumberedListForTests("2) Justificación metodológica"), true);
    assert.equal(__startsNumberedListForTests("a. Marco teórico"), true);
    assert.equal(__startsNumberedListForTests("iv) Consideraciones finales"), true);
    assert.equal(__startsNumberedListForTests("Párrafo ordinario sin numeración"), false);
    assert.equal(__startsNumberedListForTests("• Viñeta gráfica"), false);
});

test("emite encabezados estructurados con estilo de título y control de líneas huérfanas", async () => {
    const titleWord = { text: "1. Introducción General", x: 70, y: 100, width: 200, height: 20, fontSize: 18 };
    const bodyWord = { text: "Este es el contenido explicativo del capítulo.", x: 70, y: 130, width: 350, height: 12, fontSize: 11 };
    const titleLine = { text: titleWord.text, words: [titleWord], bbox: { x: 70, y: 100, width: 200, height: 20 } };
    const bodyLine = { text: bodyWord.text, words: [bodyWord], bbox: { x: 70, y: 130, width: 350, height: 12 } };

    const result = await renderWordDocument({
        title: "Encabezados semánticos",
        mode: "editable",
        pages: [{
            pageNumber: 1,
            editableLayout: "flow",
            dimensions: { width: 595, height: 842 },
            content: { words: [titleWord, bodyWord], lines: [titleLine, bodyLine] },
            images: [],
            review: {},
            analysis: {
                zones: [],
                paragraphs: [
                    { lines: [titleLine], bbox: titleLine.bbox, text: titleLine.text },
                    { lines: [bodyLine], bbox: bodyLine.bbox, text: bodyLine.text },
                ],
                lines: [titleLine, bodyLine],
                tables: [],
                spatial: { textBox: { x: 70, y: 100, width: 350, height: 42 } },
                statistics: {},
            },
        }],
    });

    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:pStyle w:val="Heading/);
    assert.match(documentXml, /w:keepNext/);
    assert.match(documentXml, /w:widowControl/);
});

test("parsePageNumberParts reconoce diversos formatos de numeración de página", () => {
    const explicit = __parsePageNumberPartsForTests("Página 3 de 15", 3, 15);
    assert.equal(explicit.currentPage, "3");
    assert.equal(explicit.totalPages, "15");
    assert.equal(explicit.hasTotal, true);

    const slash = __parsePageNumberPartsForTests("4 / 20", 4, 20);
    assert.equal(slash.currentPage, "4");
    assert.equal(slash.totalPages, "20");

    const dashes = __parsePageNumberPartsForTests("- 7 -", 7, 20);
    assert.equal(dashes.currentPage, "7");
    assert.equal(dashes.hasTotal, false);

    const solitary = __parsePageNumberPartsForTests("42", 42, 100);
    assert.equal(solitary.currentPage, "42");

    const nonPage = __parsePageNumberPartsForTests("INFORME DE GESTIÓN ANUAL", 1, 10);
    assert.equal(nonPage, null);
});

test("conserva PAGE y el total literal cuando el PDF es un extracto", async () => {
    const line = {
        text: "Página 1 de 5",
        bbox: { x: 250, y: 800, width: 95, height: 12 },
        words: [{ text: "Página 1 de 5", x: 250, y: 800, width: 95, height: 12, fontSize: 9 }],
    };
    const result = await renderWordDocument({
        title: "Paginación dinámica",
        mode: "editable",
        pages: [{
            pageNumber: 1,
            editableLayout: "flow",
            dimensions: { width: 595, height: 842 },
            content: { words: [], lines: [] },
            images: [],
            review: {},
            analysis: {
                zones: [{ type: "footer", lines: [line], bbox: line.bbox }],
                paragraphs: [],
                lines: [],
                tables: [],
                spatial: { textBox: { x: 70, y: 70, width: 455, height: 700 } },
                statistics: {},
            },
        }],
    });

    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const footerXml = await archive.file("word/footer1.xml").async("string");

    assert.match(footerXml, /w:fldSimple w:instr="PAGE"/);
    assert.doesNotMatch(footerXml, /w:fldSimple w:instr="NUMPAGES"/);
    assert.match(footerXml, />1</);
    assert.match(footerXml, />5</);
});

test("emite líneas vectoriales horizontales como bordes de párrafo nativos", async () => {
    const vectorLine = {
        bbox: { x: 70, y: 400, width: 250, height: 1.5 },
        lineWidth: 1,
        strokingColor: "1E293B",
    };
    const bodyLine = {
        text: "Firma del responsable",
        bbox: { x: 70, y: 410, width: 140, height: 12 },
        words: [{ text: "Firma del responsable", x: 70, y: 410, width: 140, height: 12, fontSize: 10 }],
    };
    const result = await renderWordDocument({
        title: "Línea de firma nativa",
        mode: "editable",
        pages: [{
            pageNumber: 1,
            editableLayout: "flow",
            dimensions: { width: 595, height: 842 },
            vectorObjects: [vectorLine],
            content: { words: bodyLine.words, lines: [bodyLine] },
            images: [],
            review: {},
            analysis: {
                zones: [],
                paragraphs: [{ lines: [bodyLine], bbox: bodyLine.bbox, text: bodyLine.text }],
                lines: [bodyLine],
                tables: [],
                spatial: { textBox: { x: 70, y: 70, width: 455, height: 700 } },
                statistics: {},
            },
        }],
    });

    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:pBdr/);
    assert.match(documentXml, /w:bottom w:val="single"/);
    assert.match(documentXml, /1E293B/);
});
