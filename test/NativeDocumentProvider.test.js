import test from "node:test";
import assert from "node:assert/strict";

import {
    normalizeStructuredNativePage,
    selectBestNativeContent,
} from "../src/engine/pdf-to-word/NativeDocumentProvider.js";

test("normaliza la segunda extraccion nativa con tipografia, color y tablas", () => {
    const page = normalizeStructuredNativePage(
        {
            page_number: 3,
            width: 600,
            height: 800,
            words: [
                {
                    text: "NovaPDF",
                    bbox: [20, 30, 90, 44],
                    font_name: "ABCDEF+Arial-Bold",
                    font_size: 14,
                    bold: true,
                    color: "#2457D6",
                    confidence: 1,
                    embedded_font: true,
                },
            ],
            tables: [
                {
                    bbox: [10, 100, 590, 300],
                    rows: [["A", "B"], ["1", "2"]],
                    structural_score: 96,
                    confidence: 0.96,
                    column_anchors: [10, 300],
                    structure: { raw: [] },
                },
            ],
        },
        { width: 300, height: 400 }
    );

    assert.equal(page.content.words[0].x, 10);
    assert.equal(page.content.words[0].fontFamily, "Arial");
    assert.equal(page.content.words[0].color, "#2457D6");
    assert.equal(page.tables[0].bbox.width, 290);
    assert.equal(page.tables[0].structuralScore, 96);
});

test("elige el segundo extractor solo cuando conserva cobertura y estilos", () => {
    const primary = {
        words: [
            { text: "Documento", x: 0, y: 0, width: 60, height: 12 },
            { text: "editable", x: 65, y: 0, width: 50, height: 12 },
        ],
    };
    const secondary = {
        source: "native-secondary",
        words: [
            {
                text: "Documento",
                x: 0,
                y: 0,
                width: 60,
                height: 12,
                fontName: "Arial",
                color: "#000000",
            },
            {
                text: "editable",
                x: 65,
                y: 0,
                width: 50,
                height: 12,
                fontName: "Arial",
                color: "#000000",
            },
        ],
    };
    const incomplete = {
        source: "native-secondary",
        words: [{ text: "Doc", x: 0, y: 0, width: 20, height: 12, fontName: "Arial" }],
    };

    assert.equal(selectBestNativeContent(primary, secondary).source, "native-secondary");
    assert.equal(selectBestNativeContent(primary, incomplete), primary);
});
