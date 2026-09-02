import test from "node:test";
import assert from "node:assert/strict";

import {
    checkLocalDocumentService,
    deriveServiceHealthEndpoint,
    deriveVisualQualityEndpoint,
    normalizeVisualQualityReport,
} from "../src/engine/evaluation/VisualQualityProvider.js";

test("deriva el validador DOCX solo desde un servicio local", () => {
    assert.equal(
        deriveVisualQualityEndpoint("http://127.0.0.1:8765/v1/layout"),
        "http://127.0.0.1:8765/v1/quality/docx"
    );
    assert.equal(deriveVisualQualityEndpoint("https://example.com/v1/layout"), null);
});

test("deriva la salud del servicio solo desde un endpoint local", () => {
    assert.equal(
        deriveServiceHealthEndpoint("http://localhost:8765/v1/layout"),
        "http://localhost:8765/health"
    );
    assert.equal(deriveServiceHealthEndpoint("https://example.com/v1/layout"), null);
});

test("expone las capacidades reales del servicio documental", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            status: "ready",
            version: "1.3.0",
            model_loaded: true,
            native_pdf_extractor: "pdfplumber",
            docx_visual_validator: "ready",
            document_renderer: {
                available: true,
                renderer: "libreoffice",
                version: "LibreOffice 26.2",
            },
        }),
    });

    try {
        const health = await checkLocalDocumentService();
        assert.equal(health.status, "ready");
        assert.equal(health.modelLoaded, true);
        assert.equal(health.nativeExtractor, "pdfplumber");
        assert.equal(health.rendererAvailable, true);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("normaliza metricas de fidelidad visual y desplazamiento", () => {
    const report = normalizeVisualQualityReport({
        status: "completed",
        renderer: "libreoffice",
        visual_score: 88.46,
        target_score: 85,
        passed: true,
        page_count_match: true,
        source_page_count: 1,
        output_page_count: 1,
        compared_page_count: 1,
        pages: [
            {
                source_page_number: 29,
                output_page_number: 1,
                visual_score: 88.46,
                ink_overlap: 81.3,
                edge_similarity: 91.2,
                horizontal_shift_points: 2.5,
                vertical_shift_points: -1.25,
                issues: [],
            },
        ],
    });

    assert.equal(report.status, "completed");
    assert.equal(report.visualScore, 88.46);
    assert.equal(report.pageCountMatch, true);
    assert.equal(report.pages[0].sourcePageNumber, 29);
    assert.equal(report.pages[0].verticalShiftPoints, -1.25);
});
