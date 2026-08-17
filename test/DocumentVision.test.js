import test from "node:test";
import assert from "node:assert/strict";

import {
    buildOCRRoutingPlan,
    classifyVisualRegion,
} from "../src/engine/vision/VisualRegionSegmenter.js";
import { buildTextRemovalPlan } from "../src/engine/vision/EditableBackground.js";

const dimensions = { width: 600, height: 800 };

test("protege una firma inferior y no la envia al OCR", () => {
    const result = classifyVisualRegion({
        bbox: { x: 230, y: 610, width: 190, height: 48 },
        dimensions,
        metrics: {
            inkDensity: 0.13,
            colorInkDensity: 0,
            colorfulness: 3,
            tonalVariance: 360,
            edgeDensity: 0.18,
        },
    });

    assert.equal(result.type, "signature");
    assert.equal(result.protected, true);
    assert.equal(result.strategy, "preserve-image");
});

test("enruta bloques de texto separados al OCR regional", () => {
    const regions = [
        {
            id: "r1",
            type: "text-candidate",
            confidence: 82,
            strategy: "printed-ocr",
            protected: false,
            bbox: { x: 45, y: 80, width: 510, height: 145 },
        },
        {
            id: "r2",
            type: "text-candidate",
            confidence: 79,
            strategy: "printed-ocr",
            protected: false,
            bbox: { x: 45, y: 270, width: 510, height: 165 },
        },
        {
            id: "signature",
            type: "signature",
            confidence: 84,
            strategy: "preserve-image",
            protected: true,
            bbox: { x: 210, y: 650, width: 180, height: 50 },
        },
    ];
    const routing = buildOCRRoutingPlan(regions, dimensions);

    assert.equal(routing.strategy, "regional");
    assert.equal(routing.ocrRegions.length, 2);
    assert.equal(routing.protectedRegions.length, 1);
});

test("el fondo limpio no borra palabras superpuestas a un sello", () => {
    const words = [
        { text: "CONTRATO", x: 50, y: 80, width: 82, height: 15, confidence: 91 },
        { text: "FIRMADO", x: 250, y: 630, width: 70, height: 15, confidence: 88 },
        { text: "dudosa", x: 50, y: 120, width: 45, height: 14, confidence: 30 },
    ];
    const protectedRegions = [
        {
            type: "stamp",
            bbox: { x: 220, y: 600, width: 120, height: 90 },
        },
    ];
    const plan = buildTextRemovalPlan(words, protectedRegions, dimensions);

    assert.deepEqual(plan.accepted.map((entry) => entry.word.text), ["CONTRATO"]);
    assert.deepEqual(
        plan.rejected.map((entry) => entry.reason).sort(),
        ["low-confidence", "protected-visual"]
    );
});
