import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCorpus } from "../src/engine/evaluation/ScientificBenchmark.js";
import { analyzeDocumentStructure } from "../src/engine/layout/DocumentStructureAnalyzer.js";
import {
    enhancePageTables,
    enhanceTable,
} from "../src/engine/layout/ProfessionalTableAnalyzer.js";
import { analyzePageRegions } from "../src/engine/layout/RegionIntelligence.js";
import { normalizePageRange } from "../src/engine/pdf-to-word/PageRange.js";

function textRegionPage(pageNumber, text, type = "text", y = 50) {
    return {
        pageNumber,
        dimensions: { width: 600, height: 800 },
        regionAnalysis: {
            columnCount: 1,
            counts: { [type]: 1 },
            lowConfidenceRegions: 0,
            regions: [
                {
                    id: `p${pageNumber}`,
                    type,
                    text,
                    bbox: { x: 40, y, width: 500, height: 30 },
                },
            ],
        },
    };
}

test("normaliza rangos extensos sin duplicar páginas", () => {
    assert.deepEqual(normalizePageRange("1-3, 3, 8, 12-10", 10), [1, 2, 3, 8, 10]);
    assert.deepEqual(normalizePageRange("all", 3), [1, 2, 3]);
});

test("clasifica regiones mixtas y conserva su orden de lectura", () => {
    const word = {
        text: "CAPÍTULO",
        x: 40,
        y: 45,
        width: 90,
        height: 20,
        fontSize: 20,
        confidence: 100,
        source: "native",
        rotation: 0,
    };
    const paragraph = {
        text: "CAPÍTULO UNO",
        words: [word],
        lines: [{ text: "CAPÍTULO UNO", words: [word] }],
        bbox: { x: 40, y: 45, width: 180, height: 24 },
    };
    const result = analyzePageRegions({
        pageNumber: 1,
        dimensions: { width: 600, height: 800 },
        pageType: { type: "hybrid" },
        images: [
            {
                x: 40,
                y: 300,
                width: 300,
                height: 180,
                visualMetrics: { colorfulness: 45, tonalVariance: 1_200 },
            },
        ],
        analysis: {
            tables: [],
            paragraphs: [paragraph],
            statistics: { averageWordHeight: 15 },
        },
    });

    assert.equal(result.counts.heading, 1);
    assert.equal(result.counts.photo, 1);
    assert.deepEqual(
        result.regions.map((region) => region.readingOrder),
        [0, 1]
    );
});

test("conserva coordenadas de celda solo con cobertura nativa completa", () => {
    const table = {
        bbox: { x: 100, y: 100, width: 200, height: 80 },
        rows: [["Uno Dos", ""], ["Tres", ""]],
        source: "pdfplumber-lines",
        columnAnchors: [100, 200],
        structure: { raw: [
            { cells: [{ text: "Uno\nDos", columnIndex: 0, bbox: { x: 100, y: 100, width: 100, height: 40 } }] },
            { cells: [{ text: "Tres", columnIndex: 0, bbox: { x: 100, y: 140, width: 100, height: 40 } }] },
        ] },
    };
    const words = [
        { text: "Uno", x: 112, y: 103, width: 20, height: 9, fontSize: 9, source: "native-secondary" },
        { text: "Dos", x: 112, y: 123, width: 20, height: 9, fontSize: 9, source: "native-secondary" },
    ];
    const complete = enhancePageTables({ tables: [table] }, words).tables[0];
    assert.deepEqual(complete.professional.grid[0][0].nativeLines.map((line) => line.bbox.y), [103, 123]);
    const incomplete = enhancePageTables({ tables: [table] }, words.slice(0, 1)).tables[0];
    assert.equal(incomplete.professional.grid[0][0].nativeLines, undefined);
});

test("modela tablas profesionales con tipos numéricos y celdas combinadas", () => {
    const enhanced = enhanceTable({
        rows: [
            ["Concepto", "Importe"],
            ["Total", "S/ 120.50"],
        ],
        headers: [],
        structuralScore: 92,
    });

    assert.equal(enhanced.professional.columnCount, 2);
    assert.equal(enhanced.professional.headerRows, 1);
    assert.equal(enhanced.professional.grid[1][1].valueType, "currency");
    assert.equal(enhanced.professional.grid[1][1].alignment, "right");
});

test("conserva saltos, tipografía y alineación de celdas nativas", () => {
    const result = enhancePageTables(
        {
            tables: [
                {
                    bbox: { x: 100, y: 100, width: 300, height: 96 },
                    rows: [["Etapa", "Línea uno Línea dos"], ["UGEL", "Detalle"]],
                    headers: [],
                    columnAnchors: [100, 160],
                    structure: {
                        raw: [
                            {
                                cells: [
                                    {
                                        text: "Etapa",
                                        columnIndex: 0,
                                        bbox: { x: 100, y: 100, width: 60, height: 48 },
                                    },
                                    {
                                        text: "Línea uno\nLínea dos",
                                        columnIndex: 1,
                                        bbox: { x: 160, y: 100, width: 240, height: 48 },
                                    },
                                ],
                            },
                            {
                                cells: [
                                    {
                                        text: "UGEL",
                                        columnIndex: 0,
                                        bbox: { x: 100, y: 148, width: 60, height: 48 },
                                    },
                                    {
                                        text: "Detalle",
                                        columnIndex: 1,
                                        bbox: { x: 160, y: 148, width: 240, height: 48 },
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        },
        [
            {
                text: "Etapa",
                x: 110,
                y: 110,
                width: 30,
                height: 9,
                fontSize: 9,
                fontFamily: "Arial",
                bold: true,
            },
            {
                text: "Línea",
                x: 170,
                y: 110,
                width: 30,
                height: 9,
                fontSize: 9,
                fontFamily: "Arial",
            },
        ]
    );

    const firstCell = result.tables[0].professional.grid[0][0];
    const multilineCell = result.tables[0].professional.grid[0][1];
    assert.deepEqual(multilineCell.sourceLines, ["Línea uno", "Línea dos"]);
    assert.equal(multilineCell.lineCount, 2);
    assert.equal(firstCell.fontSize, 9);
    assert.equal(firstCell.bold, true);
    assert.equal(firstCell.alignment, "center");
});

test("elimina celdas vacías cubiertas por una combinación vertical", () => {
    const enhanced = enhanceTable({
        rows: [
            ["Área", "Valor"],
            ["Ciencia", "1"],
            ["", "2"],
        ],
        headers: ["Área", "Valor"],
        columnAnchors: [0, 100],
        structure: {
            raw: [
                {
                    cells: [
                        { text: "Área", columnIndex: 0, columnSpan: 1, rowSpan: 1 },
                        { text: "Valor", columnIndex: 1, columnSpan: 1, rowSpan: 1 },
                    ],
                },
                {
                    cells: [
                        { text: "Ciencia", columnIndex: 0, columnSpan: 1, rowSpan: 2 },
                        { text: "1", columnIndex: 1, columnSpan: 1, rowSpan: 1 },
                    ],
                },
                {
                    cells: [
                        { text: "2", columnIndex: 1, columnSpan: 1, rowSpan: 1 },
                    ],
                },
            ],
        },
        structuralScore: 96,
    });

    assert.equal(enhanced.professional.grid[2].length, 1);
    assert.equal(enhanced.professional.grid[2][0].columnIndex, 1);
    assert.equal(enhanced.professional.grid[2][0].text, "2");
});

test("elimina encabezados de tabla consecutivos duplicados", () => {
    const header = {
        cells: [
            { text: "Área", columnIndex: 0, columnSpan: 1, rowSpan: 1 },
            { text: "Valor", columnIndex: 1, columnSpan: 1, rowSpan: 1 },
        ],
    };
    const enhanced = enhanceTable({
        rows: [["Área", "Valor"], ["Área", "Valor"], ["Ciencia", "2"]],
        headers: ["Área", "Valor"],
        columnAnchors: [0, 100],
        structure: {
            raw: [
                header,
                header,
                {
                    cells: [
                        { text: "Ciencia", columnIndex: 0, columnSpan: 1, rowSpan: 1 },
                        { text: "2", columnIndex: 1, columnSpan: 1, rowSpan: 1 },
                    ],
                },
            ],
        },
        structuralScore: 96,
    });

    assert.equal(enhanced.professional.grid.length, 2);
    assert.equal(enhanced.professional.grid[1][0].text, "Ciencia");
});

test("no inventa una cabecera en una tabla nativa que continúa desde otra página", () => {
    const enhanced = enhanceTable({
        source: "pdfplumber-lines",
        headers: [],
        columnAnchors: [100, 150, 220],
        structure: {
            raw: [
                {
                    cells: [
                        { text: "", columnIndex: 0 },
                        { text: "D y E", columnIndex: 1 },
                        { text: "Continuación del contenido", columnIndex: 2 },
                    ],
                },
                {
                    cells: [
                        { text: "DRE", columnIndex: 0 },
                        { text: "D y E", columnIndex: 1 },
                        { text: "Descripción", columnIndex: 2 },
                    ],
                },
            ],
        },
        rows: [
            ["", "D y E", "Continuación del contenido"],
            ["DRE", "D y E", "Descripción"],
        ],
    });

    assert.equal(enhanced.professional.headerRows, 0);
});

test("una tabla continuada en la parte superior nunca convierte su primera fila en cabecera", () => {
    const enhanced = enhanceTable({
        bbox: { x: 100, y: 70, width: 400, height: 180 },
        headers: ["", "D y E", "informes de proyecto"],
        rows: [
            ["", "D y E", "informes de proyecto"],
            ["DRE", "D y E", "descripción"],
        ],
    });

    assert.equal(enhanced.professional.headerRows, 0);
});

test("analiza continuidad y capítulos a escala de documento", () => {
    const first = textRegionPage(1, "CAPÍTULO UNO", "heading", 50);
    first.regionAnalysis.regions.push({
        id: "p1-body",
        type: "text",
        text: "Este párrafo contiene una explicación extensa que continúa",
        bbox: { x: 40, y: 740, width: 500, height: 30 },
    });
    first.regionAnalysis.counts.text = 1;
    const second = textRegionPage(2, "en la página siguiente.", "text", 45);
    const structure = analyzeDocumentStructure([first, second]);

    assert.equal(structure.chapters.length, 1);
    assert.equal(structure.paragraphContinuations.length, 1);
});

test("detecta encabezados y numeración de página repetitivos a escala de documento", () => {
    const headerLine = { text: "INFORME TÉCNICO DE GESTIÓN", bbox: { x: 50, y: 30, width: 250, height: 12 } };
    const page1 = {
        pageNumber: 1,
        dimensions: { width: 595, height: 842 },
        analysis: {
            zones: [
                { type: "header", lines: [headerLine], bbox: headerLine.bbox },
                { type: "footer", lines: [{ text: "Página 1 de 2", bbox: { x: 250, y: 800, width: 80, height: 12 } }], bbox: { x: 250, y: 800, width: 80, height: 12 } },
            ],
        },
    };
    const page2 = {
        pageNumber: 2,
        dimensions: { width: 595, height: 842 },
        analysis: {
            zones: [
                { type: "header", lines: [headerLine], bbox: headerLine.bbox },
                { type: "footer", lines: [{ text: "Página 2 de 2", bbox: { x: 250, y: 800, width: 80, height: 12 } }], bbox: { x: 250, y: 800, width: 80, height: 12 } },
            ],
        },
    };

    const structure = analyzeDocumentStructure([page1, page2]);
    assert.equal(structure.repeatingHeadersAndFooters.hasRunningHeader, true);
    assert.equal(structure.repeatingHeadersAndFooters.runningHeader, "INFORME TÉCNICO DE GESTIÓN");
    assert.equal(structure.repeatingHeadersAndFooters.hasPageNumbers, true);
});

test("agrega CER, WER, tablas, geometría y rendimiento de un corpus", () => {
    const result = evaluateCorpus([
        {
            id: "digital-1",
            reference: {
                text: "NovaPDF convierte documentos",
                tables: [[ ["A", "10"] ]],
                readingOrder: ["a", "b"],
                regions: [{ bbox: { x: 0, y: 0, width: 100, height: 50 } }],
            },
            hypothesis: {
                text: "NovaPDF convierte documento",
                tables: [[ ["A", "10"] ]],
                readingOrder: ["a", "b"],
                regions: [{ bbox: { x: 0, y: 0, width: 100, height: 50 } }],
            },
            performance: {
                durationMs: 1_000,
                peakMemoryMB: 48,
                outputBytes: 12_000,
                pageCount: 2,
            },
        },
    ]);

    assert.equal(result.documentCount, 1);
    assert.equal(result.tableAccuracy, 100);
    assert.equal(result.readingOrder, 100);
    assert.equal(result.geometricFidelity, 100);
    assert.equal(result.pagesPerMinute, 120);
    assert.ok(result.cer > 0);
});

test("conserva filas vacías consecutivas de formularios", () => {
    const makeRow = (rowIndex, values) => ({
        cells: values.map((text, columnIndex) => ({
            text,
            columnIndex,
            bbox: { x: columnIndex * 100, y: rowIndex * 20, width: 100, height: 20 },
        })),
    });
    const enhanced = enhanceTable({
        bbox: { x: 0, y: 0, width: 200, height: 80 },
        columnAnchors: [0, 100],
        rows: [["Campo", "Valor"], ["", ""], ["", ""], ["Firma", ""]],
        structure: { raw: [
            makeRow(0, ["Campo", "Valor"]), makeRow(1, ["", ""]),
            makeRow(2, ["", ""]), makeRow(3, ["Firma", ""]),
        ] },
    });
    assert.equal(enhanced.professional.grid.length, 4);
});
