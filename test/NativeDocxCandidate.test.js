import test from "node:test";
import assert from "node:assert/strict";

import {
    deriveNativeDocxEndpoint,
    isNativeDocxCandidateEligible,
    shouldApplyNativeDocxCandidate,
} from "../src/engine/pdf-to-word/NativeDocxCandidate.js";

function digitalPage(overrides = {}) {
    return {
        pageNumber: 1,
        pageType: { type: "digital", confidence: 99 },
        content: {
            words: [
                { text: "Documento", source: "native-secondary" },
                { text: "editable", source: "native-secondary" },
            ],
        },
        analysis: { tables: [], neuralFormulas: [] },
        regionAnalysis: { regions: [] },
        ...overrides,
    };
}

test("habilita el segundo conversor solo para documentos digitales sin tablas", () => {
    assert.equal(
        isNativeDocxCandidateEligible({ mode: "editable", pages: [digitalPage()] }),
        true
    );
    assert.equal(
        isNativeDocxCandidateEligible({
            mode: "editable",
            pages: [digitalPage({ analysis: { tables: [{ id: "table-1" }], neuralFormulas: [] } })],
        }),
        false
    );
    assert.equal(
        isNativeDocxCandidateEligible({
            mode: "editable",
            pages: [digitalPage({ pageType: { type: "scanned", confidence: 98 } })],
        }),
        false
    );
});

test("limita el candidato DOCX al servicio local", () => {
    assert.equal(
        deriveNativeDocxEndpoint("http://127.0.0.1:8765/v1/layout"),
        "http://127.0.0.1:8765/v1/convert/native-docx"
    );
    assert.equal(deriveNativeDocxEndpoint("https://example.com/v1/layout"), null);
});

test("rechaza una mejora global que empeora materialmente una página", () => {
    const report = (score, pageScores) => ({
        status: "completed",
        visualScore: score,
        pageCountMatch: true,
        pages: pageScores.map((visualScore, index) => ({
            sourcePageNumber: index + 1,
            visualScore,
            issues: [],
        })),
    });

    assert.equal(
        shouldApplyNativeDocxCandidate(report(60, [60, 60]), report(65, [66, 64])),
        true
    );
    assert.equal(
        shouldApplyNativeDocxCandidate(report(60, [70, 50]), report(65, [60, 70])),
        false
    );
});
