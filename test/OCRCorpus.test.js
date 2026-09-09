import test from "node:test";
import assert from "node:assert/strict";

import {
    aggregateRegionMetrics,
    chooseRegionalFusion,
    evaluateRegion,
    hypothesisForRegion,
    parseTesseractTSV,
    validateOCRCorpus,
} from "../scripts/lib/ocr-corpus.mjs";

test("asigna líneas OCR únicamente a la región humana correspondiente", () => {
    const result = hypothesisForRegion([
        { text: "Primera línea", confidence: 90, bbox: { x: 10, y: 10, width: 80, height: 10 } },
        { text: "Segunda línea", confidence: 80, bbox: { x: 10, y: 30, width: 90, height: 10 } },
        { text: "Fuera", confidence: 99, bbox: { x: 300, y: 300, width: 40, height: 10 } },
    ], {
        bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
        coordinateSpace: "normalized",
    }, { width: 400, height: 400 });

    assert.equal(result.text, "Primera línea Segunda línea");
    assert.equal(result.lineCount, 2);
    assert.equal(result.confidence, 85);
});

test("convierte TSV de Tesseract a líneas espaciales", () => {
    const tsv = [
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        "5\t1\t1\t1\t1\t1\t10\t20\t30\t10\t91\tHola",
        "5\t1\t1\t1\t1\t2\t45\t20\t35\t10\t89\tmundo",
    ].join("\n");

    const lines = parseTesseractTSV(tsv);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, "Hola mundo");
    assert.deepEqual(lines[0].bbox, { x: 10, y: 20, width: 70, height: 10 });
    assert.equal(lines[0].confidence, 90);
});

test("la fusión regional no consulta la transcripción de referencia", () => {
    const fused = chooseRegionalFusion(
        { type: "table" },
        { text: "Celda correcta", confidence: 88 },
        { text: "Celda corrccta", confidence: 91 }
    );

    assert.equal(fused.engine, "paddle");
    assert.equal(fused.reason, "calibrated_regional_score");
});

test("agrega CER y WER microponderados por volumen real", () => {
    const first = evaluateRegion("hola mundo", { text: "hola mundo", confidence: 90 });
    const second = evaluateRegion("abc", { text: "axc", confidence: 70 });
    const aggregate = aggregateRegionMetrics([first, second]);

    assert.equal(aggregate.characterErrors, 1);
    assert.equal(aggregate.referenceCharacters, 13);
    assert.equal(aggregate.cer, 7.69);
    assert.equal(aggregate.wordErrors, 1);
    assert.equal(aggregate.referenceWords, 3);
    assert.equal(aggregate.wer, 33.33);
});

test("el corpus estricto exige cuotas, rotación, fotografía y verificación humana", () => {
    const manifest = {
        quotas: { clean_scan: 1, noisy_scan: 0, form_table: 0, hybrid: 0 },
        samples: [{
            id: "clean-001",
            category: "clean_scan",
            categoryReview: "human_verified",
            rotation: 90,
            tags: ["photo"],
        }],
    };
    const annotations = new Map([["clean-001", {
        status: "human_verified",
        regions: [{ id: "r1", text: "Texto confirmado" }],
    }]]);

    const result = validateOCRCorpus(manifest, annotations);

    assert.equal(result.valid, true);
    assert.equal(result.verified.clean_scan, 1);
    assert.equal(result.rotated, 1);
    assert.equal(result.photographs, 1);
});
