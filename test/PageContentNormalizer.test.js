import test from "node:test";
import assert from "node:assert/strict";

import {
    mergeNativeAndOCR,
    normalizeNativeContent,
    normalizeOCRContent,
} from "../src/engine/pdf-to-word/PageContentNormalizer.js";
import {
    fuseNeuralTextWithOCR,
    getNeuralFallbackRegions,
    neuralVisionToContent,
} from "../src/engine/vision/NeuralTextFusion.js";

test("normaliza texto PDF nativo conservando geometría y estilo", () => {
    const content = normalizeNativeContent(
        {
            items: [
                {
                    str: "Nova PDF",
                    width: 80,
                    height: 12,
                    fontName: "ABCDEF+Arial-Bold",
                    transform: [12, 0, 0, 12, 40, 700],
                },
            ],
            styles: {
                "ABCDEF+Arial-Bold": { fontFamily: "Arial" },
            },
        },
        { width: 612, height: 792 }
    );

    assert.equal(content.words.length, 2);
    assert.equal(content.words[0].text, "Nova");
    assert.equal(content.words[0].y, 80);
    assert.equal(content.words[0].bold, true);
    assert.equal(content.words[0].fontFamily, "Arial");
    assert.equal(content.lines[0].text, "Nova PDF");
});

test("fusiona contenido híbrido sin duplicar palabras nativas", () => {
    const native = {
        words: [
            { text: "NovaPDF", x: 10, y: 10, width: 60, height: 12, source: "native" },
        ],
    };
    const ocr = normalizeOCRContent(
        {
            words: [
                { text: "NovaPDF", x: 20, y: 20, width: 120, height: 24, confidence: 95 },
                { text: "avanzado", x: 180, y: 20, width: 100, height: 24, confidence: 91 },
            ],
        },
        2
    );
    const merged = mergeNativeAndOCR(native, ocr);

    assert.deepEqual(
        merged.words.map((word) => word.text),
        ["NovaPDF", "avanzado"]
    );
    assert.equal(merged.supplementalOCRWordCount, 1);
});

test("convierte texto neuronal en palabras editables y conserva su geometria", () => {
    const vision = {
        provider: "pp-structure-v3",
        model: "PP-StructureV3",
        regions: [
            {
                id: "heading-1",
                source: "neural-layout",
                type: "heading",
                bbox: { x: 100, y: 60, width: 300, height: 24 },
                confidence: 91,
                text: "## SITUACION ACTUAL",
                readingOrder: 0,
            },
            {
                id: "text-1",
                source: "neural-layout",
                type: "text-candidate",
                bbox: { x: 80, y: 120, width: 430, height: 72 },
                confidence: 88,
                text: "Texto neuronal editable que conserva la posicion del parrafo.",
                readingOrder: 1,
            },
        ],
    };
    const content = neuralVisionToContent(vision);

    assert.equal(content.blocks.length, 2);
    assert.equal(content.words[0].text, "SITUACION");
    assert.equal(content.words[0].source, "neural-ocr");
    assert.equal(content.words[0].bold, true);
    assert.ok(content.words.every((word) => word.x >= 80 && word.y >= 60));
});

test("el texto neuronal sustituye OCR solapado y conserva OCR suplementario", () => {
    const vision = {
        provider: "pp-structure-v3",
        regions: [
            {
                id: "text-1",
                source: "neural-layout",
                type: "text-candidate",
                bbox: { x: 10, y: 10, width: 180, height: 30 },
                confidence: 90,
                text: "Texto correcto",
                readingOrder: 0,
                strategy: "printed-ocr",
            },
            {
                id: "hand-1",
                source: "neural-layout",
                type: "handwriting",
                bbox: { x: 200, y: 60, width: 100, height: 30 },
                confidence: 82,
                text: "",
                strategy: "handwriting-ocr",
            },
        ],
        routing: { ocrRegions: [] },
    };
    vision.routing.ocrRegions = vision.regions;
    const fused = fuseNeuralTextWithOCR(
        {
            words: [
                { text: "Texlo", x: 12, y: 12, width: 60, height: 12, confidence: 51 },
                { text: "firma", x: 220, y: 65, width: 38, height: 12, confidence: 78 },
            ],
        },
        vision
    );

    assert.ok(fused.words.some((word) => word.text === "correcto"));
    assert.ok(!fused.words.some((word) => word.text === "Texlo"));
    assert.ok(fused.words.some((word) => word.text === "firma"));
    assert.deepEqual(getNeuralFallbackRegions(vision).map((region) => region.id), ["hand-1"]);
});

test("usa lineas neuronales exactas y excluye texto detectado dentro de sellos", () => {
    const vision = {
        provider: "pp-structure-v3",
        model: "PP-StructureV3",
        textLines: [
            {
                id: "line-1",
                text: "Texto con geometria real",
                bbox: { x: 80, y: 120, width: 260, height: 14 },
                confidence: 94,
            },
            {
                id: "seal-line",
                text: "COLEGIO INGENIEROS",
                bbox: { x: 390, y: 620, width: 120, height: 18 },
                confidence: 83,
            },
        ],
        regions: [
            {
                id: "paragraph-1",
                source: "neural-layout",
                type: "text-candidate",
                bbox: { x: 70, y: 110, width: 300, height: 40 },
                confidence: 93,
                readingOrder: 0,
            },
            {
                id: "seal-1",
                source: "neural-layout",
                type: "stamp",
                bbox: { x: 380, y: 610, width: 140, height: 40 },
                confidence: 88,
                protected: true,
            },
        ],
        routing: {
            protectedRegions: [
                {
                    id: "seal-1",
                    type: "stamp",
                    bbox: { x: 380, y: 610, width: 140, height: 40 },
                },
            ],
            ocrRegions: [],
        },
    };
    const content = neuralVisionToContent(vision);

    assert.equal(content.exactGeometry, true);
    assert.equal(content.lines.length, 1);
    assert.deepEqual(content.lines[0].bbox, vision.textLines[0].bbox);
    assert.ok(content.text.includes("geometria real"));
    assert.ok(!content.text.includes("INGENIEROS"));
});
