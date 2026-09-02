import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import JSZip from "jszip";
import { enhanceTable } from "../src/engine/layout/ProfessionalTableAnalyzer.js";

import {
    __groupParagraphLinesForTests,
    __normalizeTableRowsForTests,
    renderWordDocument,
    splitLineByComplexTableCells,
    splitLineByLargeMeasuredGaps,
} from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

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
    const footers = await Promise.all(Object.keys(archive.files)
        .filter((name) => /^word\/footer\d+\.xml$/.test(name))
        .map((name) => archive.file(name).async("string")));
    assert.equal(footers.filter((footer) => footer.includes(">177<")).length, 1);
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
                editableLayout: "positioned",
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

    assert.match(xml, /<w:trHeight w:val="924" w:hRule="exact"\/?>/);
    assert.match(xml, /<w:br\/>/);
    assert.match(xml, /<w:b\/>/);
    assert.match(xml, /<w:top w:val="single" w:color="000000"/);
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
    assert.match(xml, /<w:sz w:val="14"/);
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
            images: [], review: {}, analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
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
            analysis: { zones: [], tables: [], spatial: {}, statistics: {} },
        }],
    });
    const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const documentXml = await archive.file("word/document.xml").async("string");

    assert.match(documentXml, /w:ascii="Lucida Sans Unicode"/);
    assert.match(documentXml, /w:w w:val="97"/);
});
