import test from "node:test";
import assert from "node:assert/strict";

import { createPageCacheKey } from "../src/engine/pdf-to-word/ConversionCache.js";

test("la caché cambia cuando cambia la arquitectura de visión o fondo", () => {
    const file = { name: "documento.pdf", size: 1200, lastModified: 10 };
    const first = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: true,
        visionVersion: "3.5.0",
    });
    const second = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: true,
        visionVersion: "3.6.0",
    });
    const withoutBackground = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: false,
        visionVersion: "3.5.0",
    });

    assert.notEqual(first, second);
    assert.notEqual(first, withoutBackground);
});
