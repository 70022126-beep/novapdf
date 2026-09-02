import test from "node:test";
import assert from "node:assert/strict";

import {
    evaluateQualityRetryPages,
    mergeQualityRetryPages,
    selectPagesForQualityRetry,
    shouldApplyQualityRetry,
} from "../src/engine/evaluation/QualityAutoOptimizer.js";

test("prioriza páginas escaneadas y con bajo solapamiento", () => {
    const model = {
        mode: "editable",
        pages: [
            { pageNumber: 1, pageType: { type: "digital" }, review: {} },
            { pageNumber: 2, pageType: { type: "scanned" }, review: {} },
            { pageNumber: 3, pageType: { type: "hybrid" }, review: {} },
        ],
    };
    const quality = {
        status: "completed",
        passed: false,
        pages: [
            { sourcePageNumber: 1, visualScore: 54, issues: ["layout_mismatch"] },
            { sourcePageNumber: 2, visualScore: 58, issues: ["low_content_overlap"] },
            { sourcePageNumber: 3, visualScore: 42, issues: ["layout_mismatch"] },
        ],
    };

    assert.deepEqual(
        selectPagesForQualityRetry(model, quality, { threshold: 62, maximumPages: 2 }),
        [3, 2]
    );
    assert.deepEqual(
        selectPagesForQualityRetry(model, quality, { threshold: 62, maximumPages: 3 }),
        [3, 2, 1],
        "las páginas digitales débiles también deben recibir una alternativa posicionada"
    );
});

test("acepta o rechaza la segunda pasada de forma independiente por página", () => {
    const initial = {
        status: "completed",
        pages: [
            { sourcePageNumber: 1, visualScore: 51, issues: ["layout_mismatch"] },
            { sourcePageNumber: 2, visualScore: 60, issues: ["content_shift"] },
            { sourcePageNumber: 3, visualScore: 48, issues: ["low_content_overlap"] },
        ],
    };
    const candidate = {
        status: "completed",
        pages: [
            { sourcePageNumber: 1, visualScore: 73, issues: [] },
            { sourcePageNumber: 2, visualScore: 57, issues: ["layout_mismatch"] },
            { sourcePageNumber: 3, visualScore: 47.9, issues: [] },
        ],
    };

    const decisions = evaluateQualityRetryPages(initial, candidate, [1, 2, 3]);

    assert.deepEqual(
        decisions.map(({ pageNumber, accepted, reason }) => ({
            pageNumber,
            accepted,
            reason,
        })),
        [
            { pageNumber: 1, accepted: true, reason: "score-improved" },
            { pageNumber: 2, accepted: false, reason: "page-regressed" },
            { pageNumber: 3, accepted: true, reason: "issues-resolved" },
        ]
    );
});

test("rechaza páginas sin medición candidata para no degradar silenciosamente", () => {
    const decisions = evaluateQualityRetryPages(
        {
            status: "completed",
            pages: [{ sourcePageNumber: 7, visualScore: 45, issues: ["layout_mismatch"] }],
        },
        { status: "unavailable", pages: [] },
        [7]
    );

    assert.equal(decisions[0].accepted, false);
    assert.equal(decisions[0].reason, "quality-page-unavailable");
});

test("fusiona la segunda pasada como fidelidad editable por página", () => {
    const original = {
        mode: "editable",
        pages: [
            { pageNumber: 1, review: { correctedText: "" }, content: { text: "A" } },
            { pageNumber: 2, review: { excludeHeader: true }, content: { text: "B" } },
        ],
    };
    const retry = {
        pages: [
            { pageNumber: 2, review: {}, renderedPage: { role: "clean-editable-background" } },
        ],
    };

    const merged = mergeQualityRetryPages(original, retry, [2]);

    assert.equal(merged.pages[0], original.pages[0]);
    assert.equal(merged.pages[1].review.strategy, "fidelity");
    assert.equal(merged.pages[1].review.excludeHeader, true);
    assert.equal(merged.pages[1].review.qualityRetry, true);
});

test("solo adopta la segunda pasada cuando mejora o corrige paginación", () => {
    assert.equal(
        shouldApplyQualityRetry(
            { status: "completed", visualScore: 40, pageCountMatch: true },
            { status: "completed", visualScore: 44, pageCountMatch: true }
        ),
        true
    );
    assert.equal(
        shouldApplyQualityRetry(
            { status: "completed", visualScore: 40, pageCountMatch: true },
            { status: "completed", visualScore: 39, pageCountMatch: true }
        ),
        false
    );
    assert.equal(
        shouldApplyQualityRetry(
            { status: "completed", visualScore: 60, pageCountMatch: false },
            { status: "completed", visualScore: 59, pageCountMatch: true }
        ),
        true
    );
});
