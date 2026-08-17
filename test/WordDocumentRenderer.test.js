import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import JSZip from "jszip";

import {
    __normalizeTableRowsForTests,
    renderWordDocument,
} from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

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
