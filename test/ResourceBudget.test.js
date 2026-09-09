import test from "node:test";
import assert from "node:assert/strict";

import {
    createResourceTracker,
    resolveClientResourceBudget,
} from "../src/engine/pdf-to-word/ResourceBudget.js";

test("reduce el render y la caché en equipos con poca memoria", () => {
    const budget = resolveClientResourceBudget({
        requestedCanvasMegapixels: 32,
        requestedCacheMB: 1024,
        deviceMemoryGB: 4,
        heapLimitBytes: 512 * 1024 * 1024,
    });
    assert.equal(budget.maximumCanvasMegapixels, 12);
    assert.ok(budget.cacheMemoryMB < 1024);
    assert.ok(budget.workingSetBudgetBytes <= 512 * 1024 * 1024);
});

test("mide el pico del conjunto de trabajo", () => {
    const tracker = createResourceTracker({ workingSetBudgetBytes: 100 });
    assert.equal(tracker.reserve(60), true);
    assert.equal(tracker.reserve(50), false);
    tracker.release(70);
    assert.deepEqual(tracker.stats(), { currentBytes: 40, peakBytes: 110, budgetBytes: 100 });
});

