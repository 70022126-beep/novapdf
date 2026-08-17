import test from "node:test";
import assert from "node:assert/strict";

import { normalizeNeuralVisionResponse } from "../src/engine/vision/NeuralVisionProvider.js";
import {
    __neuralRawRowsFromHtmlForTests,
    __normalizeNeuralTableRowsForTests,
    mergeVisionLayoutWithAnalysis,
} from "../src/engine/layout/NeuralLayoutFusion.js";

test("normaliza regiones neuronales, coordenadas y estrategias", () => {
    const result = normalizeNeuralVisionResponse(
        {
            provider: "pp-structure-v3",
            model: "layout-model",
            image_width: 1200,
            image_height: 1600,
            regions: [
                {
                    label: "paragraph_title",
                    score: 0.94,
                    bbox: [100, 80, 900, 100],
                },
                {
                    label: "Text",
                    score: 0.91,
                    bbox: [100, 240, 900, 400],
                },
                {
                    label: "Equation",
                    score: 0.88,
                    bbox: [200, 760, 500, 120],
                    latex: "x^{2}+y^{2}",
                },
                {
                    label: "Signature",
                    score: 0.9,
                    bbox: [650, 1350, 300, 90],
                },
            ],
        },
        { width: 600, height: 800 }
    );

    assert.equal(result.provider, "pp-structure-v3");
    assert.equal(result.regions[0].type, "heading");
    assert.equal(result.regions[0].bbox.x, 50);
    assert.equal(result.regions[2].type, "formula");
    assert.equal(result.regions[2].latex, "x^{2}+y^{2}");
    assert.equal(result.regions[3].protected, true);
    assert.equal(result.routing.protectedRegions.length, 1);
});

test("conserva celdas combinadas de tablas HTML neuronales", () => {
    const rows = __neuralRawRowsFromHtmlForTests(
        '<table><tr><th colspan="2">Resumen</th></tr><tr><td rowspan="2">Total</td><td>10</td></tr><tr><td>20</td></tr></table>'
    );

    assert.equal(rows[0].cells[0].columnSpan, 2);
    assert.equal(rows[1].cells[0].rowSpan, 2);
});

test("fusiona tablas y formulas neuronales con el analisis documental", () => {
    const analysis = {
        tables: [],
        paragraphs: [],
        lines: [],
        statistics: {},
    };
    const vision = {
        provider: "surya",
        model: "layout-vlm",
        regions: [
            {
                id: "table-1",
                source: "neural-layout",
                type: "table",
                bbox: { x: 40, y: 100, width: 500, height: 220 },
                confidence: 93,
                rows: [
                    ["Concepto", "Importe"],
                    ["Total", "S/ 120.50"],
                ],
                cells: [],
            },
            {
                id: "formula-1",
                source: "neural-layout",
                type: "formula",
                bbox: { x: 100, y: 400, width: 240, height: 40 },
                confidence: 89,
                latex: "\\frac{a}{b}",
            },
        ],
    };
    const fused = mergeVisionLayoutWithAnalysis(analysis, vision);

    assert.equal(fused.tables.length, 1);
    assert.deepEqual(fused.tables[0].rows[1], ["Total", "S/ 120.50"]);
    assert.equal(fused.neuralFormulas[0].latex, "\\frac{a}{b}");
    assert.equal(fused.visionLayout.neural, true);
});

test("interpreta filas HTML devueltas por un modelo de tablas", () => {
    assert.deepEqual(
        __normalizeNeuralTableRowsForTests({
            html: "<table><tr><th>Producto</th><th>Cantidad</th></tr><tr><td>A</td><td>10</td></tr></table>",
        }),
        [
            ["Producto", "Cantidad"],
            ["A", "10"],
        ]
    );
});
