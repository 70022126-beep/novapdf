import test from "node:test";
import assert from "node:assert/strict";

import {
    calculateCharacterCoverage,
    compareText,
    compareVisualPages,
    evaluateQualityGate,
} from "../scripts/lib/e2e-quality-gate.mjs";

test("la puerta E2E detecta caracteres perdidos", () => {
    assert.deepEqual(calculateCharacterCoverage("Texto completo", "Texto complto"), {
        referenceCharacters: 13,
        missingCharacters: 1,
        coverage: 92.3077,
    });
});

test("la puerta E2E rechaza una regresión visual superior a 0,25 puntos", () => {
    const regressions = compareVisualPages(
        { status: "completed", pages: [{ sourcePageNumber: 3, visualScore: 84.7 }] },
        { status: "completed", pages: [{ sourcePageNumber: 3, visualScore: 85 }] },
        0.25
    );
    assert.equal(regressions.length, 1);
    assert.equal(regressions[0].delta, -0.3);
});

test("la puerta E2E exige paginación, texto y celdas estables", () => {
    const result = evaluateQualityGate({
        currentVisual: { status: "completed", pageCountMatch: false, sourcePageCount: 2, outputPageCount: 3, pages: [] },
        previousVisual: null,
        currentDocx: { text: "Uno dos", cells: 1 },
        previousDocx: { text: "Uno dos tres", cells: 2 },
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures.map((failure) => failure.code), [
        "page_count_changed",
        "text_loss",
        "table_cell_loss",
    ]);
});

test("la comparación mide formas de tablas y cobertura de fuentes", () => {
    const comparison = compareText(
        {
            text: "contenido",
            cells: 6,
            tables: 2,
            tableShapes: [{ rows: 2, cells: 4 }, { rows: 1, cells: 2 }],
            fontFamilies: ["Arial", "Calibri"],
        },
        {
            text: "contenido",
            cells: 5,
            tables: 2,
            tableShapes: [{ rows: 2, cells: 4 }, { rows: 1, cells: 1 }],
            fontFamilies: ["Arial", "Times New Roman"],
        }
    );

    assert.equal(comparison.tableStructure.exactShapeCoverage, 50);
    assert.equal(comparison.tableStructure.cellCoverage, 83.3333);
    assert.equal(comparison.fontCoverage.coverage, 50);
});

test("la puerta no aprueba si la validación visual no está disponible", () => {
    const result = evaluateQualityGate({
        currentVisual: { status: "failed", error: "LibreOffice no respondió" },
        currentDocx: { text: "texto", cells: 0 },
        previousDocx: { text: "texto", cells: 0 },
    });

    assert.equal(result.passed, false);
    assert.equal(result.failures[0].code, "visual_validation_unavailable");
});

test("la puerta rechaza conversiones que exceden el presupuesto de memoria", () => {
    const result = evaluateQualityGate({
        currentVisual: { status: "completed", pageCountMatch: true, pages: [] },
        currentDocx: { text: "texto", cells: 0 },
        previousDocx: { text: "texto", cells: 0 },
        performance: { peakBrowserHeapMB: 512.01 },
        thresholds: { maximumPeakBrowserHeapMB: 512 },
    });

    assert.equal(result.passed, false);
    assert.deepEqual(result.failures[0], {
        code: "memory_budget_exceeded",
        maximumPeakBrowserHeapMB: 512,
        peakBrowserHeapMB: 512.01,
    });
});
