import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCorpus } from "../src/engine/evaluation/ScientificBenchmark.js";
import { analyzeDocumentStructure } from "../src/engine/layout/DocumentStructureAnalyzer.js";
import { enhanceTable } from "../src/engine/layout/ProfessionalTableAnalyzer.js";
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
